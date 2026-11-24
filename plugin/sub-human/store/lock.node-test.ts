// The lock: one holder at a time, a dead holder's lock broken by one waiter, a live holder's never.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { REAL_CLOCK } from '../core/clock.js';
import { breakStale, withLock } from './lock.js';
import type { LockClock, LockOptions, Seen } from './lock.js';

async function lockPath(): Promise<string> {
  return path.join(await fs.mkdtemp(path.join(process.env.SUB_HUMAN_HOME ?? '', 'l-')), 'x.lock');
}
async function seen(file: string): Promise<Seen> {
  return { token: await fs.readFile(file, 'utf8'), mtimeMs: (await fs.stat(file)).mtimeMs };
}
async function dead(file: string, token = 'dead'): Promise<void> {
  await fs.writeFile(file, token);
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(file, old, old);
}
/** Starts `withLock` on file and resolves once its fn is running; `release()` lets it return. */
async function holding(file: string, o: LockOptions = {}) {
  let release = (): void => undefined;
  let entered = (): void => undefined;
  const inside = new Promise<void>(r => { entered = r; });
  const done = withLock(file, () => { entered(); return new Promise<void>(r => { release = r; }); }, o);
  await inside;
  return { release: () => { release(); return done; } };
}

test('a held lock makes a waiter give up in time', async () => {
  const file = await lockPath();
  const a = await holding(file);
  const r = await withLock(file, () => Promise.resolve(2), { waitMs: 30 });
  assert.ok(!r.ok && /busy/.test(r.error));
  assert.deepEqual(await a.release(), { ok: true, value: undefined });
  await assert.rejects(fs.access(file));
});

test('a dead holder\'s lock is broken, and so is a dead breaker\'s', async () => {
  const file = await lockPath();
  await dead(file);
  await dead(`${file}.break`);
  assert.deepEqual(await withLock(file, () => Promise.resolve(3), { waitMs: 60_000, staleMs: 1000 }), { ok: true, value: 3 });
  await assert.rejects(fs.access(file));
});

test('a waiter that judged a lock stale before it was replaced never breaks the new holder\'s', async () => {
  const file = await lockPath();
  await dead(file);
  const before = await seen(file); // two waiters see the dead lock
  await breakStale(file, 1000, before); // the first breaks it
  const a = await holding(file); // a third takes the free path
  await breakStale(file, 1000, before); // the second acts on what it saw
  await breakStale(file, 1000, { ...before, token: (await seen(file)).token }); // same token, another mtime
  const now = await seen(file);
  await breakStale(file, 1000, now, { ...REAL_CLOCK, now: () => now.mtimeMs }); // the holder's own lock, as it is: fresh
  const r = await withLock(file, () => Promise.resolve('two holders'), { waitMs: 30, staleMs: 600_000 });
  assert.equal(r.ok, false);
  await a.release();
});

/** The lock's clock on whatever setInterval and Date are now (node:test's mock timers here); `live` counts its intervals. */
function globalClock(): LockClock & { live: number } {
  const c = {
    live: 0,
    now: () => Date.now(),
    sleep: (ms: number) => new Promise<void>(r => { setTimeout(r, ms); }),
    every: (ms: number, fn: () => void) => {
      const t = setInterval(fn, ms);
      c.live++;
      return () => { clearInterval(t); c.live--; };
    },
  };
  return c;
}
const mtime = async (file: string): Promise<number> => (await fs.stat(file)).mtimeMs;
/**
 * Lets real file I/O started by a mock-timer callback finish, however slow the machine: the bound is counted in
 * checks, each its own trip through the I/O queue the callback's work is already in, not in wall time.
 */
async function until(done: () => Promise<boolean>, checks = 10_000): Promise<void> {
  for (let i = 0; i < checks; i++) {
    if (await done()) return;
    await new Promise(r => { setImmediate(r); });
  }
  assert.fail(`not done after ${checks} checks`);
}
const at = (file: string, ms: number): Promise<void> => fs.utimes(file, ms / 1000, ms / 1000);
/** utimes takes seconds as a float, so a time comes back within a millisecond. */
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1;

test('a holder touches its lock every staleMs/3 of its clock, and stops once it lets go', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
  const clock = globalClock();
  const file = await lockPath();
  const a = await holding(file, { staleMs: 60, clock });
  assert.equal(clock.live, 1);
  for (let step = 0; step < 5; step++) {
    await at(file, Date.now() - 1000); // as if the last touch were long ago
    t.mock.timers.tick(19);
    assert.ok(near(await mtime(file), Date.now() - 1019), 'no touch before the interval');
    t.mock.timers.tick(1);
    const now = Date.now();
    await until(async () => near(await mtime(file), now));
  }
  await a.release();
  assert.equal(clock.live, 0, 'the touches stop with the hold');
});

test('a lock is stale only once its mtime is more than staleMs behind the clock', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const clock = globalClock();
  const file = await lockPath();
  await fs.writeFile(file, 'holder');
  await at(file, Date.now() - 59.5);
  await breakStale(file, 60, await seen(file), clock);
  assert.equal(await fs.readFile(file, 'utf8'), 'holder', 'not yet staleMs behind: kept');
  t.mock.timers.tick(1);
  await breakStale(file, 60, await seen(file), clock);
  await assert.rejects(fs.access(file), 'past staleMs: broken');
});

test('release leaves a lock that is no longer the holder\'s', async () => {
  const file = await lockPath();
  const r = await withLock(file, async () => { await fs.writeFile(file, 'another holder'); });
  assert.ok(r.ok);
  assert.equal(await fs.readFile(file, 'utf8'), 'another holder');
});

test('many waiters on a dead lock: one inside at a time', async () => {
  const file = await lockPath();
  await dead(file);
  let inside = 0;
  let most = 0;
  const run = () => withLock(file, async () => { most = Math.max(most, ++inside); await sleep(3); inside--; }, { waitMs: 60_000, staleMs: 1000 });
  const rs = await Promise.all(Array.from({ length: 12 }, run));
  assert.ok(rs.every(r => r.ok));
  assert.equal(most, 1);
});

test('two breakers of one dead lock: the second waits on .break, so only one acts on its re-check', async t => {
  const file = await lockPath();
  await dead(file);
  const before = await seen(file);
  const unlink = fs.unlink.bind(fs);
  let open = (): void => undefined;
  const gate = new Promise<void>(r => { open = r; });
  let passed = 0;
  let reached = (): void => undefined;
  const past = new Promise<void>(r => { reached = r; });
  // the unlink right after a breaker's re-check is held, so both would be past it at once without `.break`
  t.mock.method(fs, 'unlink', async (p: Parameters<typeof fs.unlink>[0]) => {
    if (p === file) { passed++; reached(); await gate; }
    return unlink(p);
  });
  const first = breakStale(file, 1000, before);
  await past; // the first is past its re-check, holding .break
  await breakStale(file, 1000, before); // the second finds .break taken and leaves
  assert.equal(passed, 1);
  open();
  await first;
  await assert.rejects(fs.access(`${file}.break`));
});
