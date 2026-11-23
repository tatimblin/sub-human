// Two homes over the pipe pathway (TESTING §6): join and Let in, sync, writes and messages across, admission refusals,
// a leaked line, a name mismatch, kick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as v from '../../vendor/valibot.mjs';
import { MirrorStore } from '../../store/mirror-store.js';
import { openFsStore } from '../../store/fs-store.js';
import { fileKey, roomDir } from '../../home.js';
import { connect, generateKeyPair } from '../../net/channel.js';
import { parse } from '../../net/invite.js';
import { pipe } from '../../net/pathways/pipe.js';
import { CODE, hostRoom, joinBob, linkIs, nextAsk, twoHomes } from '../support/two-homes.js';
import type { Homes } from '../support/two-homes.js';
import { post, until } from '../support/daemon.js';
import { must } from '../support/must.js';

const none = { append: () => Promise.resolve({ ok: true as const, value: null }), putDoc: () => Promise.resolve(), putBlob: () => Promise.resolve() };
async function copy(h: Homes): Promise<MirrorStore> { return new MirrorStore(roomDir(h.joiner.home, await fileKey(CODE)), none); }
async function hostLog(h: Homes): Promise<string[]> {
  const s = await openFsStore({ home: h.host.home, code: CODE });
  assert.ok(s.ok);
  const r = await s.value.read(0);
  assert.ok(r.ok);
  return r.value.map(l => l.entry.kind);
}

test('join: the line, the same check string on both sides, Let in, the link key bound, the room synced', async t => {
  const h = await twoHomes(t);
  await hostRoom(h);
  await h.host.ok({ op: 'append', code: CODE, draft: post('alice', 'before bob') });
  const { line } = await h.host.ok({ op: 'invite', code: CODE, from: 'alice', name: 'bob', via: 'ssh' });
  assert.match(line, new RegExp(`^ssh://devbox/${CODE}\\?port=\\d+#[0-9a-z]{77}$`));
  const { check, code } = await h.joiner.ok({ op: 'dial', line, name: 'bob' });
  assert.equal(code, CODE);
  assert.deepEqual(await h.joiner.ok({ op: 'link', code: CODE }), { phase: 'waiting', why: null });
  const ask = await nextAsk(h);
  assert.deepEqual({ ...ask, id: '' }, { id: '', code: CODE, kind: 'admit', name: 'bob', expected: 'bob', machine: 'mB', check, member: false });
  assert.deepEqual((await h.host.ok({ op: 'asks', session: 'sa' })).asks, [], 'each ask is shown to a session once');
  await h.host.ok({ op: 'admit', session: 'sa', code: CODE, id: ask.id, answer: 'let_in' });
  await linkIs(h, 'online');
  const host = v.parse(v.object({ links: v.array(v.object({ name: v.string(), machine: v.string() })), invites: v.array(v.object({ state: v.string() })) }),
    JSON.parse(await fs.readFile(`${h.host.home}/host.json`, 'utf8')));
  assert.deepEqual(host.links.map(l => [l.name, l.machine]), [['bob', 'mB']]);
  assert.deepEqual(host.invites.map(i => i.state), ['used']);
  const mine = await (await copy(h)).catchup();
  assert.ok(mine.ok);
  assert.deepEqual(mine.value.lines.map(l => l.entry.kind), ['joined', 'post', 'invite', 'admit']);
  assert.ok(h.awake.held, 'the host holds off sleep while a link is live');
  assert.deepEqual(await hostLog(h), ['joined', 'post', 'invite', 'admit']);
});

test('the secret never reaches the log or the host\'s records', async t => {
  const h = await twoHomes(t);
  const { line } = await joinBob(h);
  const inv = parse(line);
  assert.ok(inv.ok);
  const secret = inv.value.secret.toString('hex');
  const word = line.split('#')[1] ?? '';
  for (const f of [`${h.host.home}/host.json`, `${roomDir(h.host.home, await fileKey(CODE))}/log.jsonl`]) {
    const text = await fs.readFile(f, 'utf8');
    assert.ok(!text.includes(secret) && !text.includes(word), f);
  }
});

test('writes go to the host and come back: posts, documents, plans, tasks; a message reaches only its member', async t => {
  const h = await twoHomes(t);
  await joinBob(h);
  await h.joiner.ok({ op: 'append', code: CODE, draft: { kind: 'joined', id: crypto.randomUUID(), from: 'bob', by: 'system' } });
  const placed = await h.joiner.ok({ op: 'append', code: CODE, draft: post('bob', 'hello from B') });
  assert.ok(placed.seq > 0);
  const forged = await h.joiner.call({ op: 'append', code: CODE, draft: post('alice', 'not me') });
  assert.ok(!forged.ok && /writes as bob only/.test(forged.error), 'a link writes as its own member only');
  const host = await hostLog(h);
  assert.equal(host.at(-1), 'post');
  const edit = await h.joiner.ok({ op: 'plan', code: CODE, from: 'bob', act: 'edit', name: 'paging', base: 0, text: '# paging\n\n1. cursor' });
  assert.ok('seq' in edit && edit.latest?.version === 1);
  const c = await copy(h);
  const blob = await until('the plan text here', () => c.getBlob(must(edit.latest, 'latest').hash));
  assert.equal(blob, '# paging\n\n1. cursor');
  const task = await h.joiner.ok({ op: 'task', code: CODE, from: 'bob', act: 'add', title: 'store' });
  assert.equal(task.n, 1);
  await h.host.ok({ op: 'put_doc', code: CODE, kind: 'focus', name: 'alice', doc: { name: 'alice', text: 'the store', at: 1 } });
  await until('alice\'s focus here', () => c.getDoc('focus', 'alice'));
  await h.joiner.ok({ op: 'put_doc', code: CODE, kind: 'focus', name: 'bob', doc: { name: 'bob', text: 'the handler', at: 2 } });
  const hs = await openFsStore({ home: h.host.home, code: CODE });
  assert.ok(hs.ok);
  await until('bob\'s focus on the host', () => hs.value.getDoc('focus', 'bob'));
  await h.joiner.ok({ op: 'message', code: CODE, to: 'alice', from: 'bob', text: 'which port?' });
  const got = await until('alice\'s message', async () => (await h.host.ok({ op: 'inbox', session: 'sa' })).messages[0] ?? null);
  assert.deepEqual({ ...got, at: 0 }, { code: CODE, from: 'bob', text: 'which port?', at: 0 });
  await h.host.ok({ op: 'message', code: CODE, to: 'bob', from: 'alice', text: '3000' });
  const back = await until('bob\'s message', async () => (await h.joiner.ok({ op: 'inbox', session: 'sb' })).messages[0] ?? null);
  assert.equal(back.text, '3000');
  const sys = await h.joiner.call({ op: 'append', code: CODE, draft: { kind: 'kick', id: crypto.randomUUID(), from: 'bob', by: 'person', name: 'alice' } });
  assert.ok(!sys.ok && /host's to write/.test(sys.error), 'a host kind is refused');
});

test('a late joiner syncs from the snapshot and the lines after it, not the whole log', async t => {
  const h = await twoHomes(t);
  // a long room, written before the daemon opens it, with a snapshot every 50 lines
  const fsStore = await openFsStore({ home: h.host.home, code: CODE, every: 50 });
  assert.ok(fsStore.ok);
  for (let i = 0; i < 120; i++) assert.ok((await fsStore.value.append({ ...post('alice', `n${i}`), at: i, machine: 'mA' })).ok);
  await hostRoom(h);
  const { line } = await h.host.ok({ op: 'invite', code: CODE, from: 'alice', name: 'bob', via: 'ssh' });
  await h.joiner.ok({ op: 'dial', line, name: 'bob' });
  await h.host.ok({ op: 'admit', session: 'sa', code: CODE, id: (await nextAsk(h)).id, answer: 'let_in' });
  await linkIs(h, 'online');
  const c = await copy(h);
  const up = await c.catchup();
  assert.ok(up.ok);
  const snap = must(up.value.snapshot, 'a snapshot');
  assert.equal(snap.state.seq, 100);
  assert.deepEqual(up.value.lines.map(l => l.entry.seq), [101, ...Array.from({ length: 22 }, (_, i) => 102 + i)].slice(0, up.value.lines.length));
  assert.ok(up.value.lines.length < 30, 'only the lines after the snapshot');
  const below = await c.read(0);
  assert.ok(!below.ok && /starts after seq/.test(below.error));
});

test('a wrong host key fails at the handshake, before anything is sent', async t => {
  const h = await twoHomes(t);
  await hostRoom(h);
  const { line } = await h.host.ok({ op: 'invite', code: CODE, from: 'alice', name: 'bob', via: 'ssh' });
  const inv = parse(line);
  assert.ok(inv.ok);
  const fake = line.replace(/#.*/, `#${line.split('#')[1]?.replace(/^./, c => (c === '0' ? '1' : '0')) ?? ''}`);
  const r = await h.joiner.call({ op: 'dial', line: fake, name: 'bob' });
  assert.ok(!r.ok && /not the host the line names/.test(r.error), r.ok ? '' : r.error);
  assert.deepEqual((await h.host.ok({ op: 'asks', session: 'sa' })).asks, []);
});

test('a dial with neither a known key nor the MAC touches nothing: no ask, no record', async t => {
  const h = await twoHomes(t);
  await hostRoom(h);
  const { line } = await h.host.ok({ op: 'invite', code: CODE, from: 'alice', name: 'bob', via: 'ssh' });
  const inv = parse(line);
  assert.ok(inv.ok);
  const before = await fs.readFile(`${h.host.home}/host.json`, 'utf8');
  const scan = pipe((s, src) => { h.hostNet.accept(s, src); }, 'scanner');
  const pay = Buffer.from(JSON.stringify({ code: CODE, name: 'bob', machine: 'x' }));
  const ch = await connect(await scan(inv.value.via, CODE), { s: generateKeyPair(), rs: inv.value.hostKey, payload: pay });
  const closed = await new Promise<boolean>(res => { ch.onClose(() => { res(true); }); });
  assert.ok(closed);
  assert.deepEqual((await h.host.ok({ op: 'asks', session: 'sa' })).asks, []);
  assert.equal(await fs.readFile(`${h.host.home}/host.json`, 'utf8'), before);
});

test('a name mismatch is on the card; Refuse kills the line', async t => {
  const h = await twoHomes(t);
  await hostRoom(h);
  const { line } = await h.host.ok({ op: 'invite', code: CODE, from: 'alice', name: 'bob', via: 'ssh' });
  await h.joiner.ok({ op: 'dial', line, name: 'mallory' });
  const ask = await nextAsk(h);
  assert.deepEqual([ask.name, ask.expected], ['mallory', 'bob']);
  await h.host.ok({ op: 'admit', session: 'sa', code: CODE, id: ask.id, answer: 'refuse' });
  const s = await linkIs(h, 'stopped');
  assert.match(s?.why ?? '', /did not let this machine in/);
  const again = await h.joiner.ok({ op: 'dial', line, name: 'bob' });
  assert.ok(again.check);
  await linkIs(h, 'stopped');
  assert.deepEqual((await h.host.ok({ op: 'asks', session: 'sa' })).asks, [], 'a dead line asks nothing');
});

test('a leaked line dialled twice refuses both dials and alerts the host', async t => {
  const h = await twoHomes(t);
  await hostRoom(h);
  const { line } = await h.host.ok({ op: 'invite', code: CODE, from: 'alice', name: 'bob', via: 'ssh' });
  await h.joiner.ok({ op: 'dial', line, name: 'bob' });
  const first = await nextAsk(h);
  // the same line from another machine (another home's key), while the first waits
  const inv = parse(line);
  assert.ok(inv.ok);
  const other = generateKeyPair();
  const { mac } = await import('../../net/invite.js');
  const dial = pipe((s, src) => { h.hostNet.accept(s, src); });
  const pay = Buffer.from(JSON.stringify({ code: CODE, name: 'eve', machine: 'mE', mac: mac(inv.value, other.pub).toString('base64url') }));
  const ch = await connect(await dial(inv.value.via, CODE), { s: other, rs: inv.value.hostKey, payload: pay });
  await new Promise<void>(res => { ch.onClose(() => { res(); }); });
  await linkIs(h, 'stopped');
  const alert = await nextAsk(h);
  assert.deepEqual([alert.kind, alert.expected], ['again', 'bob']);
  const late = await h.host.call({ op: 'admit', session: 'sa', code: CODE, id: first.id, answer: 'let_in' });
  assert.ok(!late.ok, 'the first dial was refused too');
});

test('a used line dialled again alerts with the member to kick', async t => {
  const h = await twoHomes(t);
  const { line } = await joinBob(h);
  const inv = parse(line);
  assert.ok(inv.ok);
  const { mac } = await import('../../net/invite.js');
  const other = generateKeyPair();
  const dial = pipe((s, src) => { h.hostNet.accept(s, src); });
  const pay = Buffer.from(JSON.stringify({ code: CODE, name: 'eve', machine: 'mE', mac: mac(inv.value, other.pub).toString('base64url') }));
  const ch = await connect(await dial(inv.value.via, CODE), { s: other, rs: inv.value.hostKey, payload: pay });
  await new Promise<void>(res => { ch.onClose(() => { res(); }); });
  const alert = await nextAsk(h);
  assert.deepEqual([alert.kind, alert.name], ['leaked', 'bob']);
  const wrong = await h.host.call({ op: 'admit', session: 'nobody', code: CODE, id: alert.id, answer: 'kick' });
  assert.ok(!wrong.ok, 'only a session in the room answers its asks');
  await h.host.ok({ op: 'admit', session: 'sa', code: CODE, id: alert.id, answer: 'kick' });
  await linkIs(h, 'stopped');
});

test('kick: the link is refused at once and the mirror stops, for good', async t => {
  const h = await twoHomes(t);
  await joinBob(h);
  await h.joiner.ok({ op: 'append', code: CODE, draft: { kind: 'joined', id: crypto.randomUUID(), from: 'bob', by: 'system' } });
  await h.host.ok({ op: 'kick', code: CODE, from: 'alice', name: 'bob' });
  const s = await linkIs(h, 'stopped');
  assert.match(s?.why ?? '', /removed you/);
  const w = await h.joiner.call({ op: 'append', code: CODE, draft: post('bob', 'still here?') });
  assert.ok(!w.ok && /removed you/.test(w.error));
  await until('sleep allowed again: no live link', () => Promise.resolve(h.awake.held ? null : true));
  const stopped = await until('the link file stopped', async () => {
    const r = v.safeParse(v.object({ stopped: v.string() }), JSON.parse(await fs.readFile(`${h.joiner.home}/links/${CODE}.json`, 'utf8')));
    return r.success ? r.output.stopped : null;
  });
  assert.match(stopped, /removed you/, 'a restart does not dial again');
  assert.equal((await h.joiner.call({ op: 'kick', code: CODE, from: 'bob', name: 'alice' })).ok, false, 'only the host kicks');
});

test('a link\'s appends are rate-limited per minute (R40)', async t => {
  const h = await twoHomes(t, { hostOpts: { rates: { append: 5, put_blob: 5 } } });
  await joinBob(h);
  await h.joiner.ok({ op: 'append', code: CODE, draft: { kind: 'joined', id: crypto.randomUUID(), from: 'bob', by: 'system' } });
  const errors: string[] = [];
  for (let i = 0; i < 10 && !errors.length; i++) {
    const r = await h.joiner.call({ op: 'append', code: CODE, draft: post('bob', `n${i}`) });
    if (!r.ok) errors.push(r.error);
  }
  assert.match(errors[0] ?? '', /too many writes from this machine/);
  assert.ok((await h.host.call({ op: 'append', code: CODE, draft: post('alice', 'the host is not limited') })).ok);
});

test('let in, the joiner\'s session takes its place: a bare join of the room hosted elsewhere, its joined on the host', async t => {
  const h = await twoHomes(t);
  await joinBob(h);
  const r = await h.joiner.ok({ op: 'join', id: 'sb', cwd: '/w', name: 'bob', leave: crypto.randomUUID(), code: CODE });
  assert.ok('code' in r && r.code === CODE && r.title === `bob.${CODE}`, JSON.stringify(r));
  assert.deepEqual((await hostLog(h)).at(-1), 'joined');
});
