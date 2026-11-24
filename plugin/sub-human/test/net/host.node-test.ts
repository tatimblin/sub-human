// What the host refuses from a link it let in, driven by hand (RawLink): each write bound to the link's member and
// room, every write and subscribe rate-limited, nothing taken after bye, a kicked key and a key dialling another room
// refused at the handshake; and what it refuses at admission: a name or machine that can't be shown, a failed admit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { openFsStore } from '../../store/fs-store.js';
import { generateKeyPair } from '../../net/channel.js';
import { CODE, dialHost, hostRoom, joinBob, linkIs, nextAsk, rawLink, twoHomes } from '../support/two-homes.js';
import type { Homes } from '../support/two-homes.js';
import { joined, post, until } from '../support/daemon.js';

async function posts(h: Homes): Promise<string[]> {
  const s = await openFsStore({ home: h.host.home, code: CODE });
  assert.ok(s.ok);
  const r = await s.value.read(0);
  assert.ok(r.ok);
  return r.value.flatMap(l => (l.entry.kind === 'post' ? [l.entry.text] : []));
}
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

test('a kicked key dialling again, and a known key dialling another room, are refused at the handshake', async t => {
  const h = await bobIn(t);
  const other = await rawLink(h, { code: 'other-1234' });
  await other.closed;
  assert.deepEqual(other.got, [], 'a key is bound to its room');
  await h.host.ok({ op: 'kick', code: CODE, from: 'alice', name: 'bob' });
  const again = await rawLink(h);
  await again.closed;
  assert.deepEqual(again.got, [], 'no hello for a kicked key');
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
