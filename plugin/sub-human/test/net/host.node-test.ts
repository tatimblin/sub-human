// What the host refuses from a link it let in, driven by hand (RawLink): each write bound to the link's member and
// room, every write and subscribe rate-limited, nothing taken after bye, a kicked key and a key dialling another room
// refused at the handshake; and what it refuses at admission: a name or machine that can't be shown, a failed admit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import * as v from '../../vendor/valibot.mjs';
import { openFsStore } from '../../store/fs-store.js';
import { fold } from '../../core/fold.js';
import { nameFrom } from '../../core/join.js';
import { fileKey, roomDir } from '../../home.js';
import { connect, generateKeyPair } from '../../net/channel.js';
import { mac, parse } from '../../net/invite.js';
import { pipe } from '../../net/pathways/pipe.js';
import type { ToLink } from '../../core/protocol.js';
import { decodeToLink } from '../../core/protocol.js';
import { CODE, dialHost, hostRoom, joinBob, linkIs, nextAsk, rawLink, twoHomes } from '../support/two-homes.js';
import type { Homes } from '../support/two-homes.js';
import type { Ask } from '../../core/api.js';
import { joined, post, until } from '../support/daemon.js';

async function posts(h: Homes): Promise<string[]> {
  const s = await openFsStore({ home: h.host.home, code: CODE });
  assert.ok(s.ok);
  const r = await s.value.read(0);
  assert.ok(r.ok);
  return r.value.flatMap(l => (l.entry.kind === 'post' ? [l.entry.text] : []));
}
async function hostLog(h: Homes): Promise<{ kinds: string[]; members: string[] }> {
  const s = await openFsStore({ home: h.host.home, code: CODE });
  assert.ok(s.ok);
  const r = await s.value.read(0);
  assert.ok(r.ok);
  const st = fold(null, r.value, await s.value.docs());
  return { kinds: r.value.map(l => l.entry.kind), members: st.members.map(m => `${m.name}@${m.machine ?? ''}`) };
}
const linksOf = v.object({ links: v.array(v.object({ name: v.string(), kicked: v.boolean() })) });
const hostLinks = async (h: Homes): Promise<string[]> =>
  v.parse(linksOf, JSON.parse(await fs.readFile(`${h.host.home}/host.json`, 'utf8'))).links.map(l => `${l.name}:${l.kicked}`);
/** A dial of `line` by hand from a new machine key, as `name` on `machine`, saying it takes a name it is given or not. */
async function dialAs(h: Homes, line: string, name: string, machine: string, named = true): Promise<{ got: ToLink[]; closed: Promise<void> }> {
  const inv = parse(line);
  assert.ok(inv.ok);
  const me = generateKeyPair();
  const payload = Buffer.from(JSON.stringify({ code: CODE, name, machine, mac: mac(inv.value, me.pub).toString('base64url'), ...(named && { caps: ['named'] }) }));
  const ch = await connect(await pipe((st, src) => { h.hostNet.accept(st, src); })(inv.value.via, CODE), { s: me, rs: inv.value.hostKey, payload });
  const got: ToLink[] = [];
  ch.onMessage(b => { const m = decodeToLink(b.toString('utf8')); if (m.ok && m.value) got.push(m.value); });
  return { got, closed: new Promise(res => { ch.onClose(() => { res(); }); }) };
}
const invite = async (h: Homes, name: string, from = 'alice'): Promise<string> => (await h.host.ok({ op: 'invite', code: CODE, from, name, via: 'ssh' })).line;
const allAsks = (h: Homes, n: number): Promise<Ask[]> => {
  const seen: Ask[] = [];
  return until(`${n} asks`, async () => { seen.push(...(await h.host.ok({ op: 'asks', session: 'sa' })).asks); return seen.length >= n ? seen : null; });
};
const sess = (id: string): { id: string; cwd: string; leave: string } => ({ id, cwd: `/work/${id}`, leave: randomUUID() });
async function bobIn(t: Parameters<typeof twoHomes>[0], rates?: Record<string, number>): Promise<Homes> {
  const h = await twoHomes(t, rates ? { hostOpts: { rates } } : {});
  await joinBob(h);
  await h.joiner.ok({ op: 'append', code: CODE, draft: joined('bob') });
  return h;
}
const refusedFor = (r: { got: { t: string; id?: string }[] }, id: string): boolean => r.got.some(m => m.t === 'refused' && m.id === id);

test('a call writes as the link\'s member in its own room only, and counts as an append (R37)', async t => {
  const h = await bobIn(t, { append: 2 });
  const r = await rawLink(h);
  r.send({ t: 'call', id: 'c1', req: { op: 'task', code: CODE, from: 'alice', act: 'add', title: 'as alice' } });
  r.send({ t: 'call', id: 'c2', req: { op: 'task', code: 'other-1234', from: 'bob', act: 'add', title: 'elsewhere' } });
  r.send({ t: 'call', id: 'c3', req: { op: 'task', code: CODE, from: 'bob', act: 'add', title: 'one' } });
  r.send({ t: 'call', id: 'c4', req: { op: 'task', code: CODE, from: 'bob', act: 'add', title: 'two' } });
  r.send({ t: 'call', id: 'c5', req: { op: 'task', code: CODE, from: 'bob', act: 'add', title: 'three' } });
  await until('five answers', () => Promise.resolve(r.got.filter(m => m.t === 'refused' || m.t === 'answer').length >= 5 || null));
  assert.deepEqual(['c1', 'c2', 'c3', 'c4', 'c5'].map(id => refusedFor(r, id)), [true, true, false, false, true]);
});

test('a document is the link\'s member\'s own; documents, messages and plan text are rate-limited, a message bounded (R37, R40)', async t => {
  const h = await bobIn(t, { put_doc: 1, put_blob: 1, message: 1 });
  const r = await rawLink(h);
  r.send({ t: 'put_doc', id: 'd1', key: 'focus/alice', doc: { name: 'alice', text: 'not hers', at: 1 } });
  r.send({ t: 'put_doc', id: 'd2', key: 'focus/bob', doc: { name: 'bob', text: 'mine', at: 1 } });
  r.send({ t: 'put_doc', id: 'd3', key: 'focus/bob', doc: { name: 'bob', text: 'again', at: 2 } });
  r.send({ t: 'put_blob', id: 'b1', hash: 'x', text: 'one' });
  r.send({ t: 'put_blob', id: 'b2', hash: 'x', text: 'two' });
  r.send({ t: 'message', to: 'alice', from: 'bob', text: 'x'.repeat(8001) }); // over the socket's limit: dropped, not counted
  r.send({ t: 'message', to: 'alice', from: 'bob', text: 'first' });
  r.send({ t: 'message', to: 'alice', from: 'bob', text: 'second' });
  await until('five answers', () => Promise.resolve(r.got.filter(m => m.t === 'refused' || m.t === 'ack').length >= 5 || null));
  assert.deepEqual(['d1', 'd2', 'd3', 'b1', 'b2'].map(id => refusedFor(r, id)), [true, false, true, false, true]);
  const s = await openFsStore({ home: h.host.home, code: CODE });
  assert.ok(s.ok);
  assert.equal((await s.value.getDoc('focus', 'alice')), null);
  await sleep(100);
  const inbox = (await h.host.ok({ op: 'inbox', session: 'sa' })).messages.map(m => m.text);
  assert.deepEqual(inbox, ['first']);
});

test('a link writes no system entry but its member\'s joined and left (R37)', async t => {
  const r = await rawLink(await bobIn(t));
  r.send({ t: 'append', entry: { kind: 'finding', id: 'f1', from: 'bob', by: 'system', text: 'the system says so' } });
  await r.next('refused');
  assert.ok(refusedFor(r, 'f1'));
});

test('a subscribe asked over and over is cut off: the host never re-sends the room on demand', async t => {
  const h = await bobIn(t, { subscribe: 2 });
  const r = await rawLink(h);
  for (let i = 0; i < 5; i++) r.send({ t: 'subscribe', after_seq: 0, hash: '' });
  await r.next('bye');
  await sleep(100);
  assert.equal(r.got.filter(m => m.t === 'snapshot').length, 2);
});

test('after bye nothing more is taken, even from a link that ignores it', async t => {
  const h = await bobIn(t, { subscribe: 1 });
  const r = await rawLink(h);
  // a bye for a link still a member (too many subscribes), so only the bye can stop what follows
  r.send({ t: 'subscribe', after_seq: 0, hash: '' });
  r.send({ t: 'subscribe', after_seq: 0, hash: '' });
  await r.next('bye');
  r.send({ t: 'append', entry: post('bob', 'after the bye') });
  await sleep(300);
  assert.deepEqual(await posts(h), []);
  assert.ok(!r.got.some(m => m.t === 'ack'));
});

test('a kicked key dialling again, and a known key dialling another room, are refused at the handshake; a kicked machine with a new invite is refused with the removed line, which the joiner\'s status now shows (R31)', async t => {
  const h = await bobIn(t);
  const other = await rawLink(h, { code: 'other-1234' });
  await other.closed;
  assert.deepEqual(other.got, [], 'a key is bound to its room');
  await h.host.ok({ op: 'kick', code: CODE, from: 'alice', name: 'bob' });
  const again = await rawLink(h);
  await again.closed;
  assert.deepEqual(again.got, [], 'no hello for a kicked key');
  await linkIs(h, 'stopped');
  const { line } = await h.host.ok({ op: 'invite', code: CODE, from: 'alice', name: 'robert', via: 'ssh' });
  await h.joiner.ok({ op: 'dial', line, name: 'robert', session: sess('sc') });
  const why = await until('the removed line', async () => {
    const s = await h.joiner.ok({ op: 'link', code: CODE });
    return s?.why === `the host removed this machine from ${CODE}` ? s : null;
  });
  assert.equal(why.phase, 'stopped');
  assert.deepEqual((await h.host.ok({ op: 'asks', session: 'sa' })).asks, [], 'no card for a removed machine');
});

test('a name in the room from another machine is let in as NAME2 and told so; the same machine under its own name keeps it (R5, R30)', async t => {
  assert.equal(nameFrom('tristan2'), 'tristan2', 'the suffixed name is a member name');
  const h = await twoHomes(t);
  await h.host.ok({ op: 'ping', session: 'sa', code: CODE, name: 'tristan' });
  await h.host.ok({ op: 'append', code: CODE, draft: joined('tristan') });
  const { line } = await h.host.ok({ op: 'invite', code: CODE, from: 'tristan', name: 'tristan', via: 'ssh' });
  await h.joiner.ok({ op: 'dial', line, name: 'tristan', session: sess('sb') });
  const ask = await nextAsk(h);
  assert.deepEqual([ask.name, ask.as, ask.holder], ['tristan', 'tristan2', 'mA']);
  await h.host.ok({ op: 'admit', session: 'sa', code: CODE, id: ask.id, answer: 'let_in' });
  const s = await linkIs(h, 'online');
  assert.equal(s?.why, `tristan is already in ${CODE}, so you joined as tristan2`);
  await until('the joiner in as tristan2', async () => ((await hostLog(h)).members.includes('tristan2@mB') || null));
  assert.deepEqual((await hostLog(h)).members, ['tristan@mA', 'tristan2@mB'], 'two members, each seeing the other');
  assert.deepEqual(await hostLinks(h), ['tristan2:false']);
  // a later session here, under its own git name, takes the name this machine was let in as, and its writes are taken
  const later = await h.joiner.ok({ op: 'join', ...sess('sd'), name: 'tristan', code: CODE });
  assert.ok('title' in later);
  assert.equal(later.title, `tristan2-2.${CODE}`, 'the second session here as tristan2');
  assert.ok((await h.joiner.call({ op: 'append', code: CODE, draft: post('tristan2', 'from the later session') })).ok);
  // the same machine dialling again under the name it was given is let in as it
  const r = await rawLink(h, { name: 'tristan2' });
  const hi = await r.next('hello');
  assert.ok(hi.t === 'hello');
  assert.equal(hi.name, 'tristan2');
});

test('two machines dialling one taken name at once, both let in, get distinct names; so does a name held only by a machine let in (R5, R30)', async t => {
  const h = await twoHomes(t);
  await hostRoom(h);
  const [l1, l2] = [await invite(h, 'alice'), await invite(h, 'alice')];
  const dials = await Promise.all([dialAs(h, l1, 'alice', 'mB'), dialAs(h, l2, 'alice', 'mC')]);
  const asks = await allAsks(h, 2);
  assert.deepEqual(asks.map(a => a.as ?? '').sort((a, b) => a.localeCompare(b)), ['alice2', 'alice3']);
  await Promise.all(asks.map(a => h.host.ok({ op: 'admit', session: 'sa', code: CODE, id: a.id, answer: 'let_in' })));
  const hellos = await until('both let in', () => Promise.resolve(dials.every(d => d.got.some(m => m.t === 'hello')) ? dials.flatMap(d => d.got.flatMap(m => (m.t === 'hello' ? [m.name] : []))) : null));
  assert.deepEqual(hellos.sort((a, b) => a.localeCompare(b)), ['alice2', 'alice3']);
  // carol let in from mD and not yet joined: carol from mE is another person
  const carol = await dialAs(h, await invite(h, 'carol'), 'carol', 'mD');
  await h.host.ok({ op: 'admit', session: 'sa', code: CODE, id: (await allAsks(h, 1))[0]?.id ?? '', answer: 'let_in' });
  await until('carol let in', () => Promise.resolve(carol.got.some(m => m.t === 'hello') || null));
  await dialAs(h, await invite(h, 'carol'), 'carol', 'mE');
  assert.equal((await allAsks(h, 1))[0]?.as, 'carol2');
});

test('a joiner too old to take another name is refused with the reason, and no card is shown', async t => {
  const h = await twoHomes(t);
  await hostRoom(h);
  const old = await dialAs(h, await invite(h, 'alice'), 'alice', 'mB', false);
  const no = await until('the refusal', () => Promise.resolve(old.got.find(m => m.t === 'refused') ?? null));
  assert.ok(no.t === 'refused');
  assert.equal(no.reason, `alice is already in ${CODE} from another machine; update sub-human or join under another name`);
  assert.deepEqual((await h.host.ok({ op: 'asks', session: 'sa' })).asks, []);
});

test('a known machine with a new invite under a new name gets the card; Let in replaces its record and it writes as the new name only (R30, R37)', async t => {
  const h = await twoHomes(t);
  await joinBob(h);
  // this machine's own record of the room dropped by hand: leave dropping it is another fix's, and its own test's
  await h.joinNet.links.forget(CODE);
  await fs.rm(roomDir(h.joiner.home, await fileKey(CODE)), { recursive: true, force: true });
  const { line } = await h.host.ok({ op: 'invite', code: CODE, from: 'alice', name: 'bobby', via: 'ssh' });
  await h.joiner.ok({ op: 'dial', line, name: 'bobby', session: sess('sc') });
  const ask = await nextAsk(h);
  assert.deepEqual([ask.kind, ask.name, ask.expected], ['admit', 'bobby', 'bobby']);
  await h.host.ok({ op: 'admit', session: 'sa', code: CODE, id: ask.id, answer: 'let_in' });
  await linkIs(h, 'online');
  assert.deepEqual(await hostLinks(h), ['bobby:false'], 'the record replaced, by key');
  await until('bobby in', async () => ((await hostLog(h)).members.includes('bobby@mB') || null));
  assert.ok((await h.joiner.call({ op: 'append', code: CODE, draft: post('bobby', 'hi') })).ok);
  assert.ok(!(await h.joiner.call({ op: 'append', code: CODE, draft: post('bob', 'hi') })).ok);
});

test('a name or machine that can\'t be shown on the card is refused before anything is asked', async t => {
  const h = await twoHomes(t);
  await hostRoom(h);
  const { line } = await h.host.ok({ op: 'invite', code: CODE, from: 'alice', name: 'bob', via: 'ssh' });
  const bad = ['\u0007\u202e', 'lap\u0000top', 'my laptop', 'b\u0430ptop', 'x'.repeat(65)].map(machine => ({ name: 'bob', machine }));
  for (const o of [{ name: 'Bob Smith', machine: 'm' }, { name: 'x'.repeat(65), machine: 'm' }, ...bad]) await (await dialHost(h, line, o)).closed;
  assert.deepEqual((await h.host.ok({ op: 'asks', session: 'sa' })).asks, []);
  // a machine is shown as hostname characters only
  await dialHost(h, line, { name: 'bob', machine: 'Bobs-MacBook.local' });
  assert.equal((await nextAsk(h)).machine, 'Bobs-MacBook.local');
});

test('the same machine dialling its pending line again takes its dial\'s place: no alert, and Let in lets it in', async t => {
  const h = await twoHomes(t);
  await hostRoom(h);
  const { line } = await h.host.ok({ op: 'invite', code: CODE, from: 'alice', name: 'bob', via: 'ssh' });
  const me = generateKeyPair();
  const first = await dialHost(h, line, { name: 'bob', machine: 'mB', key: me });
  const ask = await nextAsk(h);
  const second = await dialHost(h, line, { name: 'bob', machine: 'mB', key: me });
  const again = await nextAsk(h);
  assert.deepEqual([again.id, again.kind, again.check], [ask.id, 'admit', second.check], 'the same card again, with the live check');
  assert.notEqual(again.check, ask.check);
  await sleep(100);
  assert.deepEqual((await h.host.ok({ op: 'asks', session: 'sa' })).asks, [], 'no leak alert');
  await h.host.ok({ op: 'admit', session: 'sa', code: CODE, id: ask.id, answer: 'let_in' });
  await first.closed; // the dial it replaced is not let in
  const host = await until('the link saved', async () => {
    const text = await fs.readFile(`${h.host.home}/host.json`, 'utf8');
    return text.includes(me.pub.toString('base64url')) ? text : null;
  });
  assert.ok(host, 'the second dial is bound');
});

for (const race of [false, true]) {
  test(race ? 'two machines dialling one open line at once both reach no card: the second finds it pending, and both are refused'
    : 'a leaked line dialled from another machine while the first waits refuses both dials and alerts the host (R30)', async t => {
    // the race, held open: both dials judge the line open and wait on reading the room; the first goes on alone and
    // makes the line pending, and only then does the second, whose judgement after the wait must find it pending
    let armed = false;
    const held: (() => void)[] = [];
    const h = await twoHomes(t, race ? {
      hostRooms: rooms => {
        const state = rooms.state.bind(rooms);
        rooms.state = async code => {
          if (armed && held.length < 2) await new Promise<void>(res => { held.push(res); });
          return state(code);
        };
      },
    } : {});
    await hostRoom(h);
    const { line } = await h.host.ok({ op: 'invite', code: CODE, from: 'alice', name: 'bob', via: 'ssh' });
    if (race) {
      armed = true;
      const dials = ['mB', 'mC'].map(machine => dialHost(h, line, { name: 'bob', machine }));
      await until('both dials waiting on the room', () => Promise.resolve(held.length === 2 || null));
      held[0]?.();
      await until('the line pending', async () => ((await fs.readFile(`${h.host.home}/host.json`, 'utf8')).includes('"state":"pending"') || null));
      held[1]?.();
      await Promise.all((await Promise.all(dials)).map(d => d.closed));
      const asks = (await h.host.ok({ op: 'asks', session: 'sa' })).asks;
      assert.deepEqual(asks.map(a => [a.kind, a.expected]), [['again', 'bob']]);
      return;
    }
    await h.joiner.ok({ op: 'dial', line, name: 'bob' });
    const first = await nextAsk(h);
    await (await dialHost(h, line, { name: 'eve', machine: 'mE' })).closed;
    await linkIs(h, 'stopped');
    const alert = await nextAsk(h);
    assert.deepEqual([alert.kind, alert.expected], ['again', 'bob']);
    const late = await h.host.call({ op: 'admit', session: 'sa', code: CODE, id: first.id, answer: 'let_in' });
    assert.ok(!late.ok, 'the first dial was refused too');
  });
}

test('an admit that can\'t be written leaves no link saved', async t => {
  const h = await twoHomes(t);
  await hostRoom(h);
  const { line } = await h.host.ok({ op: 'invite', code: CODE, from: 'alice', name: 'bob', via: 'ssh' });
  await dialHost(h, line, { name: 'bob', machine: 'mB' });
  const ask = await nextAsk(h);
  // the host's own room log made unwritable: its directory is read-only
  const { fileKey, roomDir } = await import('../../home.js');
  const dir = roomDir(h.host.home, await fileKey(CODE));
  await fs.chmod(dir, 0o500);
  t.after(() => fs.chmod(dir, 0o700));
  await h.host.ok({ op: 'admit', session: 'sa', code: CODE, id: ask.id, answer: 'let_in' });
  await sleep(300);
  const saved = await fs.readFile(`${h.host.home}/host.json`, 'utf8');
  assert.ok(!saved.includes('"links":[{'), saved);
});
