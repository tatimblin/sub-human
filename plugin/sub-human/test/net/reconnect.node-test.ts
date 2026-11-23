// A link that drops and comes back, on a fake clock (R32, R36): a person's post queued offline is sent again under its
// id and the host keeps one line; every other write fails at once; a fork is found and the copy resynced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { MirrorStore } from '../../store/mirror-store.js';
import { openFsStore } from '../../store/fs-store.js';
import { fileKey, logFile, roomDir } from '../../home.js';
import type { Clock } from '../../net/link.js';
import { pipe } from '../../net/pathways/pipe.js';
import { CODE, joinBob, linkIs, twoHomes } from '../support/two-homes.js';
import type { Homes } from '../support/two-homes.js';
import { joined, post, until } from '../support/daemon.js';

/** Timers that fire only when the test moves the clock. */
function fakeClock(): Clock & { advance(ms: number): void } {
  let now = 1_000_000;
  const timers = new Set<{ at: number; fn: () => void }>();
  return {
    now: () => now,
    after: (ms, fn) => { const t = { at: now + ms, fn }; timers.add(t); return () => { timers.delete(t); }; },
    advance(ms) {
      now += ms;
      for (const t of [...timers].sort((a, b) => a.at - b.at)) if (t.at <= now && timers.delete(t)) t.fn();
    },
  };
}
const timings = { retryMs: 1000, retryMaxMs: 4000, dialMs: 5000, pingMs: 0, pongMs: 5000, tickMs: 60_000, postTtlMs: 600_000 };

async function setup(t: Parameters<typeof twoHomes>[0]): Promise<{ h: Homes; clock: ReturnType<typeof fakeClock>; cut: () => void }> {
  const clock = fakeClock();
  const streams: Duplex[] = [];
  const h = await twoHomes(t, {
    joinOpts: { clock, timings },
    dial: net => { const d = pipe((s, src) => { net.accept(s, src); }); return async (via, code) => { const s = await d(via, code); streams.push(s); return s; }; },
  });
  await joinBob(h);
  await h.joiner.ok({ op: 'append', code: CODE, draft: joined('bob') });
  return { h, clock, cut: () => { for (const s of streams.splice(0)) s.destroy(); } };
}

async function hostPosts(h: Homes): Promise<string[]> {
  const s = await openFsStore({ home: h.host.home, code: CODE });
  assert.ok(s.ok);
  const r = await s.value.read(0);
  assert.ok(r.ok);
  return r.value.flatMap(l => (l.entry.kind === 'post' ? [l.entry.text] : []));
}

test('offline: a person\'s post queues and is sent again under its id on reconnect; the host keeps one line (R32, R36)', async t => {
  const { h, clock, cut } = await setup(t);
  cut();
  await linkIs(h, 'offline');
  const id = randomUUID();
  assert.deepEqual(await h.joiner.ok({ op: 'append', code: CODE, draft: post('bob', 'while away', id, 'person') }), { seq: 0, hash: '' });
  assert.deepEqual(await h.joiner.ok({ op: 'append', code: CODE, draft: post('bob', 'while away', id, 'person') }), { seq: 0, hash: '' });
  const finding = await h.joiner.call({ op: 'append', code: CODE, draft: { kind: 'finding', id: randomUUID(), from: 'bob', by: 'claude', text: 'x' } });
  assert.ok(!finding.ok && /host is away/.test(finding.error), 'every other write fails fast');
  const plan = await h.joiner.call({ op: 'task', code: CODE, from: 'bob', act: 'add', title: 'x' });
  assert.ok(!plan.ok);
  // the first send reached the host before the cut: the host has the line already
  await h.host.ok({ op: 'ping', session: 'sb-host', code: CODE, name: 'bob' });
  await h.host.ok({ op: 'append', code: CODE, draft: post('bob', 'while away', id, 'person') });
  clock.advance(4000);
  await linkIs(h, 'online');
  await until('the post acked', async () => {
    const mine = await new MirrorStore(roomDir(h.joiner.home, await fileKey(CODE)), { append: () => Promise.resolve({ ok: true, value: null }), putDoc: () => Promise.resolve(), putBlob: () => Promise.resolve() }).read(0);
    return mine.ok && mine.value.some(l => l.entry.id === id) ? true : null;
  });
  assert.deepEqual(await hostPosts(h), ['while away']);
});

test('a post the host never saw is placed once the link is back', async t => {
  const { h, clock, cut } = await setup(t);
  cut();
  await linkIs(h, 'offline');
  await h.joiner.ok({ op: 'append', code: CODE, draft: post('bob', 'queued', undefined, 'person') });
  assert.deepEqual(await hostPosts(h), []);
  clock.advance(4000);
  await linkIs(h, 'online');
  await until('the queued post on the host', async () => ((await hostPosts(h)).length ? true : null));
  assert.deepEqual(await hostPosts(h), ['queued']);
});

test('a fork: a copy whose chain breaks is discarded for the host\'s snapshot and lines (R36)', async t => {
  const { h, clock, cut } = await setup(t);
  const dir = roomDir(h.joiner.home, await fileKey(CODE));
  // the copy's last line rewritten: its cursor is no longer on the host's chain
  const text = await fs.readFile(logFile(dir), 'utf8');
  const forged = text.replace(/"by":"system"(?=[^\n]*\n$)/, '"by":"person"');
  assert.notEqual(forged, text);
  await fs.writeFile(logFile(dir), forged);
  cut();
  await linkIs(h, 'offline');
  await h.host.ok({ op: 'append', code: CODE, draft: post('alice', 'after the fork') });
  clock.advance(4000);
  await linkIs(h, 'online');
  const host = await openFsStore({ home: h.host.home, code: CODE });
  assert.ok(host.ok);
  const want = await host.value.read(0);
  assert.ok(want.ok);
  const copy = new MirrorStore(dir, { append: () => Promise.resolve({ ok: true, value: null }), putDoc: () => Promise.resolve(), putBlob: () => Promise.resolve() });
  const got = await until('the copy resynced', async () => {
    const r = await copy.catchup();
    return r.ok && r.value.lines.at(-1)?.hash === want.value.at(-1)?.hash ? r.value : null;
  });
  assert.deepEqual(got.lines.map(l => l.hash), want.value.map(l => l.hash));
  assert.ok(!(await fs.readFile(logFile(dir), 'utf8')).includes('"by":"person","machine":"mB"'), 'the forged line is gone');
});

test('the host restarts: links are told the host is away, and come back to the same listener (R34)', async t => {
  const h = await twoHomes(t, { joinOpts: { timings: { ...timings, retryMs: 50, retryMaxMs: 100 } } });
  const { line } = await joinBob(h);
  await h.joiner.ok({ op: 'append', code: CODE, draft: joined('bob') });
  const port = /\?port=(\d+)#/.exec(line)?.[1];
  await h.restartHost();
  await linkIs(h, 'online');
  assert.ok((await h.joiner.ok({ op: 'append', code: CODE, draft: post('bob', 'back') })).seq > 0);
  const kept: unknown = JSON.parse(await fs.readFile(`${h.host.home}/host.json`, 'utf8'));
  assert.ok(typeof kept === 'object' && kept !== null && 'port' in kept && String(kept.port) === port, 'the listener kept its port');
});

test('a fork found while online: a host line that doesn\'t follow the copy resyncs it from the snapshot', async t => {
  const { h } = await setup(t);
  const dir = roomDir(h.joiner.home, await fileKey(CODE));
  const text = await fs.readFile(logFile(dir), 'utf8');
  const forged = text.replace(/"by":"system"(?=[^\n]*\n$)/, '"by":"person"');
  assert.notEqual(forged, text);
  await fs.writeFile(logFile(dir), forged); // the copy's head no longer the host's
  await h.host.ok({ op: 'append', code: CODE, draft: post('alice', 'live, after the fork') });
  const host = await openFsStore({ home: h.host.home, code: CODE });
  assert.ok(host.ok);
  const want = await host.value.read(0);
  assert.ok(want.ok);
  const copy = new MirrorStore(dir, { append: () => Promise.resolve({ ok: true, value: null }), putDoc: () => Promise.resolve(), putBlob: () => Promise.resolve() });
  const got = await until('the copy resynced', async () => {
    const r = await copy.catchup();
    return r.ok && r.value.lines.at(-1)?.hash === want.value.at(-1)?.hash ? r.value : null;
  });
  assert.deepEqual(got.lines.map(l => l.hash), want.value.map(l => l.hash));
});
