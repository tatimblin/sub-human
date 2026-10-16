// lib/handoff.ts and the host epoch in one process: the host_changed entry's rules, the old host's log refusing
// lines once it says the room moved (STALE) while a promote's own entry passes, the server's epoch checks at hello
// and append, the ask as a private event to the target's link only, the signed acceptance, the 'moved' event and
// what a host the room moved away from still serves. The two-machine runs are test/handoff-e2e.node-test.ts.
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as h from './helpers.ts';
import * as store from '../lib/room/store.ts';
import * as identity from '../lib/identity.ts';
import * as envelope from '../lib/room/envelope.ts';
import { validate } from '../lib/room/validate.ts';
import * as server from '../lib/remote/server.ts';
import * as client from '../lib/remote/client.ts';
import * as invites from '../lib/remote/invites.ts';
import * as hostLinks from '../lib/remote/host-links.ts';
import * as memory from '../lib/remote/transports/memory.ts';
import * as handoff from '../lib/handoff.ts';
import * as seatKey from '../hooks/seat-key.ts';
import type { RoomStore } from '../lib/room/types.ts';
import type { Client, ConnectOpts } from '../lib/remote/client.ts';
import type { AppendResult, HandoffAcceptResult, HandoffAsk, MovedEventData, StreamEvent } from '../lib/remote/types-core.ts';
import type { RoomCode } from '../lib/brand.ts';

Object.assign(process.env, { SUB_HUMAN_CLAUDE: '/usr/bin/false', SUB_HUMAN_REAP_GRACE_MS: '0', SUB_HUMAN_REAP_WAIT_MS: '0' });

const REMOTE = 'remote0machine01';
const OTHER = 'other00machine02';
const sys = (from: string) => ({ via: 'system', from, system: true });
const rejects = (p: Promise<unknown>, code: string, re?: RegExp) => assert.rejects(p, (e: Error & { code?: string }) => e.code === code && (!re || re.test(e.message)), `expected ${code}`);
const moveTo = (machine: string, epoch = 1, host = 'bob') => ({ kind: 'host_changed', text: 'moved', epoch, host, machine, locator: 'pipe:/elsewhere' });

function hostRoom(t: TestContext) {
  h.freshHome(t);
  const code = h.newRoom();
  h.register('alice', 'member', process.pid, code);
  return { code, host: store.open(code) };
}
function served(t: TestContext, host: RoomStore) {
  const [a, b] = memory.pair();
  const srv = server.serve(b, { store: host });
  t.after(() => srv.close());
  return a;
}
async function linked(t: TestContext, host: RoomStore, opts: Partial<ConnectOpts> = {}) {
  const { token } = hostLinks.create(host, { id: hostLinks.newLinkId(), machine: opts.machine ?? REMOTE, seats: [] });
  const c = await client.connect(served(t, host), { machine: REMOTE, token, ...opts });
  t.after(() => c.close());
  return c;
}
async function joinBob(c: Client, code: RoomCode) {
  const key = seatKey.ensure(code, 'bob');
  const pubkey = seatKey.publicPem(code, 'bob');
  await c.join({ name: 'bob', pubkey, proof: hostLinks.proveSeat(key, { room: code, name: 'bob', pubkey }) });
  return key;
}
const events = (c: Client) => {
  const got: StreamEvent[] = [];
  const sub = c.subscribe(0, store.hash12(''), ev => got.push(ev));
  return { got, ready: sub.ready };
};

test('host_changed: via system only, with epoch, host, machine and locator; its fields on no other kind', () => {
  const ok = validate(moveTo(OTHER), { via: 'system', from: 'alice', system: true });
  assert.deepEqual(ok.host, { epoch: 1, host: 'bob', locator: 'pipe:/elsewhere' });
  assert.equal(ok.machine, OTHER);
  assert.throws(() => validate(moveTo(OTHER), { via: 'agent', from: 'alice' }), /written only by the plugin's hooks/);
  assert.throws(() => validate({ ...moveTo(OTHER), epoch: 0 }, { via: 'system', from: 'alice', system: true }), /epoch/);
  assert.throws(() => validate({ ...moveTo(OTHER), machine: undefined }, { via: 'system', from: 'alice', system: true }), /machine id/);
  // promoted is deliberately not `true`
  assert.throws(() => validate({ ...moveTo(OTHER), promoted: 'yes' as never }, { via: 'system', from: 'alice', system: true }), /promoted/);
  assert.throws(() => validate({ kind: 'say', text: 'x', epoch: 2 }, { via: 'agent', from: 'alice' }), /only for host_changed/);
});

test('host epoch: the old host takes no more lines once its log says the room moved; a promote back passes', t => {
  const { code, host } = hostRoom(t);
  assert.deepEqual(host.hostState(), { epoch: 0 });
  host.append({ kind: 'say', text: 'before' }, { via: 'agent', from: 'alice' });
  const moved = host.append(moveTo(OTHER), sys('alice'));
  assert.deepEqual(host.hostState(), { epoch: 1, host: 'bob', machine: OTHER, locator: 'pipe:/elsewhere', id: moved.id });
  assert.throws(() => host.append({ kind: 'say', text: 'after' }, { via: 'agent', from: 'alice' }), (e: Error & { code?: string }) => e.code === 'STALE' && /moved to bob's machine/.test(e.message));
  assert.throws(() => host.append(moveTo(OTHER, 2), sys('alice')), (e: Error & { code?: string }) => e.code === 'STALE', 'naming another machine still');
  assert.throws(() => host.append(moveTo(identity.machineId()!, 1, 'alice'), sys('alice')), (e: Error & { code?: string }) => e.code === 'STALE', 'not a later epoch');
  const back = host.append(moveTo(identity.machineId()!, 2, 'alice'), sys('alice'));
  assert.equal(host.hostState().epoch, 2);
  assert.equal(host.append({ kind: 'say', text: 'here again' }, { via: 'agent', from: 'alice' }).id, back.id + 1);
  assert.equal(handoff.movedAway(store.open(code)), false);
});

test('server: a hello from a later epoch is STALE (a host the room moved from); an append from another epoch too', async t => {
  const { code, host } = hostRoom(t);
  await rejects(linked(t, host, { epoch: 1 }), 'STALE', /moved away from this machine to a newer host\. Run \/sub-human doctor/);
  const c = await linked(t, host, { epoch: 0 });
  assert.equal(c.epoch, 0);
  await joinBob(c, code);
  const p = { from: 'bob', via: 'agent', kind: 'say', text: 'hi', to: 'room' };
  await rejects(c.request('append', { payload: p, epoch: 1 }), 'STALE', /moved away from this machine to a newer host/);
  assert.equal(((await c.request('append', { payload: p, epoch: 0 })) as AppendResult).entry.text, 'hi');
  assert.equal(((await c.request('append', { payload: { ...p, text: 'no epoch: an older daemon' } })) as AppendResult).entry.via, 'agent');
  host.append({ ...moveTo(OTHER) }, sys('alice'));
  await rejects(c.request('append', { payload: { ...p, text: 'late' }, epoch: 1 }), 'STALE', /moved to \S+'s machine; this machine takes no more messages for it/);
  await rejects(c.beat('bob'), 'STALE');
  assert.equal(host.readAll().at(-1)!.kind, 'host_changed');
});

test('handoff: the ask reaches the target\'s link only; a signed acceptance moves the room; the stream ends "moved"', async t => {
  const { code, host } = hostRoom(t);
  const c = await linked(t, host);
  const key = await joinBob(c, code);
  const other = await linked(t, host, { machine: OTHER }); // carol's machine: never told about the ask
  const bob = events(c), carol = events(other);
  await Promise.all([bob.ready, carol.ready]);

  assert.throws(() => handoff.ask(code, { from: 'alice', to: 'alice' }), /on this machine/);
  assert.throws(() => handoff.ask(code, { from: 'alice', to: 'zed' }), /not in room/);
  const d = handoff.ask(code, { from: 'alice', to: 'bob', locator: 'pipe:/bobs/home', sign: p => envelope.sign(p, seatKey.ensure(code, 'alice'), { room: code, from: 'alice' }) });
  assert.deepEqual([d.state, d.epoch, d.ask!.kind], ['asked', 1, 'host_ask']);
  await h.until(() => bob.got.some(e => e.ev === 'handoff'), 3000, 20);
  const ev = (bob.got.find(e => e.ev === 'handoff') as StreamEvent<'handoff'>).data;
  assert.deepEqual([ev.id, ev.from, ev.to, ev.epoch, ev.locator], [d.id, 'alice', 'bob', 1, 'pipe:/bobs/home']);
  assert.equal((ev as HandoffAsk & { ask?: unknown }).ask, undefined, 'the ask as the target sees it: no signatures');
  assert.ok(!carol.got.some(e => e.ev === 'handoff'), 'private to the link holding its target');

  const sign = (p: object) => envelope.sign(p, key, { room: code, from: 'bob' });
  const proof = sign({ kind: 'host_accept', id: d.id, epoch: 1, locator: 'pipe:/bobs/home' });
  const given = { [OTHER]: invites.formatInvite({ code, locator: 'pipe:/bobs/home', secret: 'S'.repeat(32) }) };
  await rejects(c.request('handoff.accept', { id: d.id, accept: { ...proof, epoch: 2 }, invites: given }), 'AUTH', /bob's yes, signed with their own key/);
  await rejects(other.request('handoff.accept', { id: d.id, accept: proof, invites: given }), 'AUTH', /not joined over this link/);
  await rejects(c.request('handoff.accept', { id: d.id, accept: proof, invites: { [OTHER]: 'sh2.nope' } }), 'INVALID');
  const r = await c.request('handoff.accept', { id: d.id, accept: proof, invites: given }) as HandoffAcceptResult;
  assert.equal(r.epoch, 1);
  const e = host.readAll().at(-1)!;
  assert.deepEqual([e.kind, e.from, e.host, e.machine, e.epoch, e.locator], ['host_changed', 'alice', 'bob', REMOTE, 1, 'pipe:/bobs/home']);
  assert.ok(envelope.verify(e.accept, store.publicKey('bob', host)), 'bob\'s acceptance, signed with his pinned key');
  assert.ok(envelope.verify(e.ask, envelope.parseKey(seatKey.publicPem(code, 'alice'))), 'alice\'s ask, signed with hers');
  assert.equal(handoff.hostDoc(host)!.state, 'moved');

  // the target's own stream: the line, then 'moved' naming its machine, no invite; the other link gets its invite
  await h.until(() => carol.got.some(x => x.ev === 'end'), 3000, 20);
  const seq = (x: { got: StreamEvent[] }) => x.got.filter(y => y.ev !== 'doc').map(y => y.ev === 'entry' ? JSON.parse(y.data).kind : y.ev);
  assert.deepEqual(seq(carol).slice(-3), ['host_changed', 'moved', 'end']);
  assert.equal((carol.got.find(x => x.ev === 'moved') as StreamEvent<'moved'>).data.invite, given[OTHER], 'carol\'s machine gets its own invite, privately');
  assert.deepEqual(bob.got.find(x => x.ev === 'end')!.data, { reason: 'moved' });
  assert.deepEqual([(bob.got.find(x => x.ev === 'moved')!.data as MovedEventData).machine, (bob.got.find(x => x.ev === 'moved')!.data as MovedEventData).invite], [REMOTE, null]);
  // a host the room moved away from still says hello and streams, and refuses every write
  await rejects(c.request('handoff.accept', { id: d.id, accept: proof, invites: given }), 'STALE');
  await rejects(c.beat('bob'), 'STALE');
  const late = events(c);
  await late.ready;
  await h.until(() => late.got.some(x => x.ev === 'moved'), 3000, 20);
});

test('handoff: refused on the card, expired, or replaced: nothing moves', async t => {
  const { code, host } = hostRoom(t);
  const c = await linked(t, host);
  await joinBob(c, code);
  const d1 = handoff.ask(code, { from: 'alice', to: 'bob' });
  const d2 = handoff.ask(code, { from: 'alice', to: 'bob' });
  await rejects(c.request('handoff.refuse', { id: d1.id }), 'INVALID', /no such handoff/);
  assert.deepEqual(await c.request('handoff.refuse', { id: d2.id }), { ok: true });
  assert.equal(handoff.hostDoc(host)!.state, 'refused');
  const d3 = handoff.ask(code, { from: 'alice', to: 'bob', now: Date.now() - 11 * 60_000 });
  const key = seatKey.ensure(code, 'bob');
  const proof = envelope.sign({ kind: 'host_accept', id: d3.id, epoch: 1, locator: 'pipe:/x' }, key, { room: code, from: 'bob' });
  await rejects(c.request('handoff.accept', { id: d3.id, accept: proof, locator: 'pipe:/x', invites: {} }), 'INVALID', /expired/);
  assert.equal(host.hostState().epoch, 0);
  assert.ok(!host.readAll().some(e => e.kind === 'host_changed'));
});

test('demote: an sh2 invite without its PIN is refused before anything changes (the hello would spend one of its tries)', t => {
  h.freshHome(t);
  const code = h.newRoom();
  h.register('alice');
  const before = store.open(code).readAll().length;
  const invite = invites.formatInvite({ code, locator: 'pipe:/elsewhere', secret: 'B'.repeat(22) });
  assert.throws(() => handoff.demote(code, invite), (e: Error & { code?: string }) => e.code === 'INVALID' && /6-digit PIN/.test(e.message));
  assert.throws(() => handoff.demote(code, invite, '12'), (e: Error & { code?: string }) => e.code === 'INVALID');
  assert.equal(store.open(code).isHost, true, 'still the host: nothing set aside');
  assert.equal(store.open(code).readAll().length, before);
});
