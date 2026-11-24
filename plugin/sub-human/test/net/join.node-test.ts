// Two homes over the pipe pathway (TESTING §6): join and Let in, sync, writes and messages across, admission refusals,
// a leaked line, a name mismatch, kick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as v from '../../vendor/valibot.mjs';
import { decodePointer, sessionFile } from '../../core/api.js';
import { MirrorStore } from '../../store/mirror-store.js';
import { openFsStore } from '../../store/fs-store.js';
import { fileKey, roomDir } from '../../home.js';
import { connect, generateKeyPair } from '../../net/channel.js';
import { parse } from '../../net/invite.js';
import { pipe } from '../../net/pathways/pipe.js';
import { CODE, dialHost, hostRoom, joinBob, linkIs, nextAsk, twoHomes } from '../support/two-homes.js';
import type { Homes } from '../support/two-homes.js';
import { home, post, started, until } from '../support/daemon.js';
import { call } from '../../net/daemon/client.js';
import { makeNet } from '../../net/daemon/net.js';
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

test('join: the line, the same check string on both sides, Let in, the link key bound, the room synced, the dialling session in it (R30)', async t => {
  const h = await twoHomes(t);
  await hostRoom(h);
  await h.host.ok({ op: 'append', code: CODE, draft: post('alice', 'before bob') });
  const { line } = await h.host.ok({ op: 'invite', code: CODE, from: 'alice', name: 'bob', via: 'ssh' });
  assert.match(line, new RegExp(`^ssh://devbox/${CODE}\\?port=\\d+#[0-9a-z]{77}$`));
  const leave = crypto.randomUUID();
  const { check, code } = await h.joiner.ok({ op: 'dial', line, name: 'bob', session: { id: 'sb', cwd: '/work/b', leave } });
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
  // online, the daemon takes the session that dialled into the room, as /room ROOM would
  const pointer = await until('the session\'s pointer', () => fs.readFile(sessionFile(h.joiner.home, 'sb'), 'utf8').then(decodePointer, () => null));
  assert.deepEqual(pointer, { code: CODE, name: 'bob', title: `bob.${CODE}`, leave });
  assert.deepEqual(await hostLog(h), ['joined', 'post', 'invite', 'admit', 'joined']);
  const mine = await (await copy(h)).catchup();
  assert.ok(mine.ok);
  assert.deepEqual(mine.value.lines.slice(0, 4).map(l => l.entry.kind), ['joined', 'post', 'invite', 'admit']);
  assert.ok(h.awake.held, 'the host holds off sleep while a link is live');
});

test('the secret never reaches the log or the host\'s records (R30)', async t => {
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

test('writes go to the host and come back: posts, documents, plans, tasks; a message reaches only its member (R6, R28)', async t => {
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

test('a late joiner syncs from the snapshot and the lines after it, not the whole log (R28)', async t => {
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
  assert.ok(!below.ok && /starts after entry/.test(below.error));
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

test('a line for a room this machine hosts is refused before anything is sent: the room stays its own', async t => {
  const h = await twoHomes(t);
  await hostRoom(h);
  const { line } = await h.host.ok({ op: 'invite', code: CODE, from: 'alice', name: 'bob', via: 'ssh' });
  await h.joiner.ok({ op: 'append', code: CODE, draft: { kind: 'joined', id: crypto.randomUUID(), from: 'bob', by: 'system' } });
  const r = await h.joiner.call({ op: 'dial', line, name: 'bob' });
  assert.deepEqual(r, { ok: false, error: `this machine already hosts room ${CODE}; nothing was sent` });
  assert.equal(await h.joiner.ok({ op: 'link', code: CODE }), null);
  assert.deepEqual((await h.host.ok({ op: 'asks', session: 'sa' })).asks, [], 'the host saw no dial');
});

test('a dial with neither a known key nor the MAC touches nothing: no ask, no record (R37)', async t => {
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

test('a name mismatch is on the card; Refuse kills the line (R30)', async t => {
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

for (const dialled of [true, false]) {
  test(`uninvite ${dialled ? 'with a dial waiting refuses it' : 'of an unused line'}, and the line lets nobody in after (R30)`, async t => {
    const h = await twoHomes(t);
    await hostRoom(h);
    const { line, id } = await h.host.ok({ op: 'invite', code: CODE, from: 'alice', name: 'bob', via: 'ssh' });
    if (dialled) { await h.joiner.ok({ op: 'dial', line, name: 'bob' }); await nextAsk(h); }
    assert.ok(!(await h.host.call({ op: 'uninvite', code: CODE, from: 'mallory', id })).ok, 'only a member takes a line back');
    await h.host.ok({ op: 'uninvite', code: CODE, from: 'alice', id });
    if (dialled) await linkIs(h, 'stopped');
    await h.joiner.ok({ op: 'dial', line, name: 'bob' });
    await linkIs(h, 'stopped');
    assert.deepEqual((await h.host.ok({ op: 'asks', session: 'sa' })).asks, [], 'a line taken back asks nothing');
    assert.ok(!(await h.host.call({ op: 'uninvite', code: CODE, from: 'alice', id: 'nope' })).ok, 'an unknown line is one refusal');
  });
}

test('an uninvite while Let in is being written is refused: the joiner gets in', async t => {
  let hit = (): void => {};
  const writing = new Promise<void>(res => { hit = res; });
  let release = (): void => {};
  const gate = new Promise<void>(res => { release = res; });
  const h = await twoHomes(t, {
    hostRooms: rooms => {
      const write = rooms.write.bind(rooms);
      rooms.write = async (code, drafts) => {
        if (drafts[0]?.kind === 'admit') { hit(); await gate; }
        return write(code, drafts);
      };
    },
  });
  await hostRoom(h);
  const { line, id } = await h.host.ok({ op: 'invite', code: CODE, from: 'alice', name: 'bob', via: 'ssh' });
  await h.joiner.ok({ op: 'dial', line, name: 'bob' });
  const ask = await nextAsk(h);
  await h.host.ok({ op: 'admit', session: 'sa', code: CODE, id: ask.id, answer: 'let_in' });
  await writing;
  const r = await h.host.call({ op: 'uninvite', code: CODE, from: 'alice', id });
  release();
  assert.ok(!r.ok, 'too late to take the line back');
  await linkIs(h, 'online');
});

test('a used line dialled again alerts with the member to kick', async t => {
  const h = await twoHomes(t);
  const { line } = await joinBob(h);
  await (await dialHost(h, line, { name: 'eve', machine: 'mE' })).closed;
  const alert = await nextAsk(h);
  assert.deepEqual([alert.kind, alert.name], ['leaked', 'bob']);
  const wrong = await h.host.call({ op: 'admit', session: 'nobody', code: CODE, id: alert.id, answer: 'kick' });
  assert.ok(!wrong.ok, 'only a session in the room answers its asks');
  await h.host.ok({ op: 'admit', session: 'sa', code: CODE, id: alert.id, answer: 'kick' });
  await linkIs(h, 'stopped');
});

test('kick: the link is refused at once and the mirror stops, for good (R31)', async t => {
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

test('a join that fails after Let in is the link\'s one stopped answer; the bare join it names then takes the place (R30)', async t => {
  const h = await twoHomes(t);
  await hostRoom(h);
  const { line } = await h.host.ok({ op: 'invite', code: CODE, from: 'alice', name: 'bob', via: 'ssh' });
  await fs.writeFile(`${h.joiner.home}/sessions`, ''); // no pointer can be written
  await h.joiner.ok({ op: 'dial', line, name: 'bob', session: { id: 'sb', cwd: '/w', leave: crypto.randomUUID() } });
  await h.host.ok({ op: 'admit', session: 'sa', code: CODE, id: (await nextAsk(h)).id, answer: 'let_in' });
  const failed = await until('the failed join', async () => {
    const s = await h.joiner.ok({ op: 'link', code: CODE });
    return s?.phase === 'stopped' ? s : null;
  });
  assert.match(failed.why ?? '', new RegExp(`^you were let in, but this session did not take its place \\(.+\\); type /room ${CODE}$`));
  assert.equal((await h.joiner.ok({ op: 'link', code: CODE }))?.phase, 'online', 'said once');
  await fs.rm(`${h.joiner.home}/sessions`);
  const r = await h.joiner.ok({ op: 'join', id: 'sb', cwd: '/w', name: 'bob', leave: crypto.randomUUID(), code: CODE });
  assert.ok('code' in r && r.code === CODE && r.title === `bob.${CODE}`, JSON.stringify(r));
  assert.deepEqual((await hostLog(h)).at(-1), 'joined');
});

test('a copy the sweep deletes loses its link for good: closed, and its file gone (R3)', async t => {
  const h = await twoHomes(t);
  await joinBob(h);
  await h.joinNet.links.forget(CODE);
  assert.equal(await h.joiner.ok({ op: 'link', code: CODE }), null);
  await assert.rejects(fs.access(`${h.joiner.home}/links/${CODE}.json`));
});

test('an unreadable link file is skipped with one debug line each; the daemon starts and serves', async t => {
  const dir = await home();
  await fs.mkdir(`${dir}/links`);
  await fs.writeFile(`${dir}/links/torn.json`, '{');
  await fs.writeFile(`${dir}/links/wrong.json`, '{"code":1}');
  await started(t, { home: dir, machine: 'mB', net: rooms => makeNet(rooms, { home: dir, machine: 'mB', now: Date.now, dial: () => Promise.reject(new Error('no dial')) }) });
  const r = await call(dir, { op: 'ping', session: 's' });
  assert.ok(r.ok);
  assert.deepEqual(r.value?.notes.map(n => n.split('.json:')[0]).sort(), ['sub-human: could not read its record of a room joined elsewhere (torn', 'sub-human: could not read its record of a room joined elsewhere (wrong']);
});
