// The lock: one holder at a time, a dead holder's lock broken by one waiter, a live holder's never.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { breakStale, withLock } from './lock.js';
import type { Seen } from './lock.js';

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
async function holding(file: string, staleMs?: number) {
  let release = (): void => undefined;
  let entered = (): void => undefined;
  const inside = new Promise<void>(r => { entered = r; });
  const done = withLock(file, () => { entered(); return new Promise<void>(r => { release = r; }); }, staleMs === undefined ? {} : { staleMs });
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
  assert.deepEqual(await withLock(file, () => Promise.resolve(3), { waitMs: 200, staleMs: 1000 }), { ok: true, value: 3 });
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
  await breakStale(file, 1000, await seen(file)); // the holder's own lock, as it is now: fresh
  const r = await withLock(file, () => Promise.resolve('two holders'), { waitMs: 30, staleMs: 1000 });
  assert.equal(r.ok, false);
  await a.release();
});

test('a holder keeps its lock fresh, so a long hold is never taken as stale', async () => {
  const file = await lockPath();
  const a = await holding(file, 60);
  await sleep(200);
  assert.ok(Date.now() - (await fs.stat(file)).mtimeMs < 60, 'the mtime moved');
  const r = await withLock(file, () => Promise.resolve(1), { waitMs: 100, staleMs: 60 });
  assert.equal(r.ok, false);
  await a.release();
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
  const run = () => withLock(file, async () => { most = Math.max(most, ++inside); await sleep(3); inside--; }, { staleMs: 1000 });
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
  // the unlink right after a breaker's re-check is held, so both would be past it at once without `.break`
  t.mock.method(fs, 'unlink', async (p: Parameters<typeof fs.unlink>[0]) => {
    if (p === file) { passed++; await gate; }
    return unlink(p);
  });
  const both = Promise.all([breakStale(file, 1000, before), breakStale(file, 1000, before)]);
  await sleep(50);
  assert.equal(passed, 1);
  open();
  await both;
  await assert.rejects(fs.access(`${file}.break`));
});
