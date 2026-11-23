// What the daemon does with each request: one chain per room, the host's checks, dedupe, the plan and task rules applied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Request } from '../../core/api.js';
import { decodePointer, sessionFile } from '../../core/api.js';
import type { Kind } from '../../core/entries.js';
import { openFsStore } from '../../store/fs-store.js';
import { fileKey, roomDir } from '../../home.js';
import { NO_LINKS, Rooms } from './rooms.js';
import { home, joined, post } from '../../test/support/daemon.js';

const rooms = (h: string): Rooms => new Rooms({ home: h, now: () => 5, machine: 'm', idleMs: 60_000, links: NO_LINKS });
async function kinds(h: string, code: string): Promise<Kind[]> {
  const s = await openFsStore({ home: h, code });
  assert.ok(s.ok);
  const lines = await s.value.read(0);
  assert.ok(lines.ok);
  return lines.value.map(l => l.entry.kind);
}
/** Joins each name to the room. */
async function room(r: Rooms, code: string, ...names: string[]): Promise<void> {
  for (const n of names) assert.ok((await r.handle({ op: 'append', code, draft: joined(n) })).ok);
}
async function okv(r: Rooms, req: Request): Promise<unknown> {
  const a = await r.handle(req);
  assert.ok(a.ok, a.ok ? '' : a.error);
  return a.value;
}

test('a cold room\'s concurrent first appends share one room: no join lost, the lock never contended', async t => {
  const h = await home();
  const r = rooms(h);
  const open = fs.open.bind(fs);
  let takes = 0;
  t.mock.method(fs, 'open', (...a: Parameters<typeof fs.open>) => {
    if (String(a[0]).endsWith('log.lock') && a[1] === 'wx') takes++;
    return open(...a);
  });
  const names = Array.from({ length: 8 }, (_, i) => `m${i}`);
  const js = await Promise.all(names.map(n => r.handle({ op: 'append', code: 'C', draft: joined(n) })));
  assert.ok(js.every(x => x.ok));
  const ps = await Promise.all(names.map(n => r.handle({ op: 'append', code: 'C', draft: post(n, 'hi') })));
  assert.deepEqual(ps.filter(x => !x.ok), [], 'every join is in the room\'s state');
  assert.equal(takes, 16, 'each append took the lock at its first try');
});

test('a retried append (same id) answers the first seq and hash and writes nothing, after a restart too', async () => {
  const h = await home();
  const r = rooms(h);
  await room(r, 'D', 'alice');
  const draft = post('alice', 'hi', randomUUID());
  const first = await r.handle({ op: 'append', code: 'D', draft });
  assert.ok(first.ok);
  assert.deepEqual(await r.handle({ op: 'append', code: 'D', draft }), first);
  assert.deepEqual(await rooms(h).handle({ op: 'append', code: 'D', draft }), first, 'rebuilt from the log when the room opens');
  assert.deepEqual(await kinds(h, 'D'), ['joined', 'post']);
  const store = await openFsStore({ home: h, code: 'D' });
  assert.ok(store.ok);
  const lines = await store.value.read(0);
  assert.equal(lines.ok && lines.value[1]?.entry.id, draft.id, 'the entry keeps the caller\'s id');
});

test('the host refuses its own kinds, a stranger\'s line and a stranger\'s document', async () => {
  const h = await home();
  const r = rooms(h);
  await room(r, 'R', 'alice');
  const decision = { kind: 'decision', id: randomUUID(), from: 'alice', by: 'system', name: 'p', version: 1, agreed: ['alice'], changes: [] } as const;
  const r1 = await r.handle({ op: 'append', code: 'R', draft: decision });
  assert.ok(!r1.ok && /host's to write/.test(r1.error));
  const r2 = await r.handle({ op: 'append', code: 'R', draft: post('mallory', 'hi') });
  assert.ok(!r2.ok && /mallory is not in R/.test(r2.error));
  const r3 = await r.handle({ op: 'put_doc', code: 'R', kind: 'presence', name: 'bob', doc: { name: 'bob', state: 'idle', at: 1 } });
  assert.ok(!r3.ok && /bob is not in R/.test(r3.error));
  assert.equal(await okv(r, { op: 'put_doc', code: 'R', kind: 'presence', name: 'alice', doc: { name: 'alice', state: 'idle', at: 1 } }), null);
  assert.deepEqual(await kinds(h, 'R'), ['joined']);
});

test('plan asks, answers, sends and accepts come only through the plan op, never append', async () => {
  const h = await home();
  const r = rooms(h);
  await room(r, 'H', 'alice', 'bob');
  const base = { from: 'alice', name: 'p', version: 1 };
  const drafts = [
    { ...base, kind: 'plan_ask', by: 'claude', people: ['bob'] },
    { ...base, kind: 'plan_answer', by: 'person', answer: 'agree' },
    { ...base, kind: 'plan_sent', by: 'person', files: [] },
    { ...base, kind: 'plan_accept', by: 'person', answer: 'accept' },
  ] as const;
  for (const draft of drafts) {
    const a = await r.handle({ op: 'append', code: 'H', draft: { ...draft, id: randomUUID() } });
    assert.ok(!a.ok && a.error === `a ${draft.kind} entry is the host's to write; nothing was written`, draft.kind);
  }
  assert.deepEqual(await kinds(h, 'H'), ['joined', 'joined']);
});

test('plans: CAS on base, a stale edit names the latest, and the last answer decides and makes owned tasks', async () => {
  const h = await home();
  const r = rooms(h);
  await room(r, 'P', 'alice', 'bob');
  const text = '# paging\n- @bob the HTTP handler\n';
  assert.partialDeepStrictEqual(await okv(r, { op: 'plan', code: 'P', from: 'alice', act: 'edit', name: 'paging', base: 0, text }), { latest: { version: 1 } });
  const stale = await okv(r, { op: 'plan', code: 'P', from: 'bob', act: 'edit', name: 'paging', base: 0, text: 'mine' });
  assert.partialDeepStrictEqual(stale, { latest: { version: 1 } });
  assert.match(JSON.stringify(stale), /"refused":"Plan paging was not stored: it is at v1, not v0/);
  assert.equal((await fs.readdir(`${roomDir(h, await fileKey('P'))}/plans`)).length, 1, 'the refused edit stored no text');
  await okv(r, { op: 'plan', code: 'P', from: 'alice', act: 'ask', name: 'paging', version: 1, people: ['bob'] });
  await okv(r, { op: 'plan', code: 'P', from: 'bob', act: 'answer', name: 'paging', version: 1, answer: 'agree' });
  assert.deepEqual(await kinds(h, 'P'), ['joined', 'joined', 'plan', 'plan_ask', 'plan_answer', 'decision', 'task']);
  const s = await openFsStore({ home: h, code: 'P' });
  assert.ok(s.ok);
  const lines = await s.value.read(0);
  const task = lines.ok ? lines.value.at(-1)?.entry : undefined;
  assert.partialDeepStrictEqual(task, { kind: 'task', task: { n: 1, title: 'the HTTP handler', status: 'claimed', owner: 'bob' } });
  const strange = await r.handle({ op: 'plan', code: 'P', from: 'mallory', act: 'ask', name: 'paging', version: 1, people: ['bob'] });
  assert.ok(!strange.ok && /mallory is not in P/.test(strange.error));
});

test('a kick decides a plan whose only missing answer was the kicked member\'s', async () => {
  const h = await home();
  const r = rooms(h);
  await room(r, 'K', 'alice', 'bob', 'carol');
  await okv(r, { op: 'plan', code: 'K', from: 'alice', act: 'edit', name: 'p', base: 0, text: '# p' });
  await okv(r, { op: 'plan', code: 'K', from: 'alice', act: 'ask', name: 'p', version: 1, people: ['bob', 'carol'] });
  await okv(r, { op: 'plan', code: 'K', from: 'bob', act: 'answer', name: 'p', version: 1, answer: 'agree' });
  assert.ok(!(await kinds(h, 'K')).includes('decision'));
  assert.ok((await r.write('K', [{ kind: 'kick', from: 'alice', by: 'system', name: 'carol' }])).ok);
  assert.deepEqual((await kinds(h, 'K')).slice(-2), ['kick', 'decision']);
});

test('tasks: add answers its number; claim, a refused claim, done; a stranger refused', async () => {
  const h = await home();
  const r = rooms(h);
  await room(r, 'T', 'alice', 'bob');
  assert.partialDeepStrictEqual(await okv(r, { op: 'task', code: 'T', from: 'alice', act: 'add', title: 'the store' }), { n: 1 });
  assert.partialDeepStrictEqual(await okv(r, { op: 'task', code: 'T', from: 'bob', act: 'claim', n: 1 }), { n: 1 });
  const taken = await r.handle({ op: 'task', code: 'T', from: 'alice', act: 'claim', n: 1 });
  assert.ok(!taken.ok && /bob has it/.test(taken.error));
  await okv(r, { op: 'task', code: 'T', from: 'bob', act: 'done', n: 1, note: 'shipped' });
  const stranger = await r.handle({ op: 'task', code: 'T', from: 'mallory', act: 'add', title: 'x' });
  assert.ok(!stranger.ok && /mallory is not in T/.test(stranger.error));
  assert.deepEqual(await kinds(h, 'T'), ['joined', 'joined', 'task', 'task', 'task']);
});

test('session writes the pointer the module reads (0600), session_end removes it, a write sweeps day-old ones', async () => {
  const h = await home();
  const r = rooms(h);
  const old = sessionFile(h, 'gone');
  await fs.mkdir(`${h}/sessions`, { recursive: true });
  for (const id of ['gone', 'quiet']) await fs.writeFile(sessionFile(h, id), '{"code":"R","name":"x"}');
  const day = new Date(Date.now() - 25 * 3600_000);
  for (const id of ['gone', 'quiet']) await fs.utimes(sessionFile(h, id), day, day);
  const live = new Rooms({ home: h, now: Date.now, machine: 'm', idleMs: 60_000, links: NO_LINKS });
  await okv(live, { op: 'ping', session: 'quiet' }); // still pinging: its pointer is kept fresh
  await sleep(50);
  await okv(live, { op: 'session', id: 's1', code: 'R1', name: 'bob' });
  const file = sessionFile(h, 's1');
  assert.deepEqual(decodePointer(await fs.readFile(file, 'utf8')), { code: 'R1', name: 'bob' });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await assert.rejects(fs.access(old), 'a pointer nobody pinged for a day is swept');
  await fs.access(sessionFile(h, 'quiet'));
  await okv(r, { op: 'session_end', id: 's1' });
  await assert.rejects(fs.access(file));
  assert.equal(await okv(r, { op: 'session_end', id: 's1' }), null, 'ending twice is fine');
});

test('messages go to inboxes by session and room, never the log, and are taken once', async () => {
  const h = await home();
  const r = rooms(h);
  await okv(r, { op: 'ping', session: 's-bob', code: 'R1', name: 'bob' });
  await okv(r, { op: 'ping', session: 's-bob', code: 'R2', name: 'bob' });
  await okv(r, { op: 'message', code: 'R1', to: 'bob', from: 'alice', text: 'which port?' });
  await okv(r, { op: 'message', code: 'R2', to: 'bob', from: 'carol', text: 'paging?' });
  const nobody = await r.handle({ op: 'message', code: 'R1', to: 'carol', from: 'alice', text: 'hi' });
  assert.ok(!nobody.ok && /carol isn't in R1/.test(nobody.error));
  assert.partialDeepStrictEqual(await okv(r, { op: 'inbox', session: 's-bob' }), {
    messages: [{ code: 'R1', from: 'alice', text: 'which port?' }, { code: 'R2', from: 'carol', text: 'paging?' }],
  });
  assert.deepEqual(await okv(r, { op: 'inbox', session: 's-bob' }), { messages: [] });
  await assert.rejects(fs.access(`${h}/rooms`), 'nothing was written');
});
