// One person in two seats (lib/room/consent.ts `same` groups, lib/proposal.ts create): seats with one account are one
// approver. The fold counts the newest answer of any seat for the group (a revoke clears it); create groups the
// approvers by account, never an invite's seat, and of the host's own seats only the room owner's (who opened it,
// else in an older room the earliest-joined), which a login link's seats join; members.join marks the owner; validate
// caps `same`; a mirror writes it only when its host's caps list it; the decision names one seat per person.
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as h from './helpers.ts';
import * as room from '../lib/room.ts';
import * as store from '../lib/room/store.ts';
import * as consent from '../lib/room/consent.ts';
import * as proposal from '../lib/proposal.ts';
import * as config from '../lib/config.ts';
import { machineId } from '../lib/home.ts';
import { MemoryRoomStore } from './support/memory-store.ts';
import type { Entry, EntryInput, Member, Trust } from '../lib/room/types.ts';
import type { RoomCode } from '../lib/brand.ts';
import { rc, sn } from './support/brands.ts';

const H = 'abcdef012345';
let id = 0;
const at = '2026-01-01T00:00:00.000Z';
const prop = (approvers: string[], same?: string[][], from = 'carol'): Entry => ({ id: ++id, at, kind: 'proposal', via: 'agent', from, text: `proposal ${H}: Ship`, hash: H, approvers, ...(same ? { same } : {}) });
const ans = (from: string, kind: string): Entry => ({ id: ++id, at, kind, via: 'human', from, proposal_hash: H });
/** These hand-made answers carry no signature: judged as a room from before seat keys would (legacy: they count). */
const LEGACY: Trust = e => (e && e.via === 'human' ? 'legacy' : null);

test('fold: one answer satisfies a same group; the newest seat\'s answer wins; a revoke clears the group', () => {
  id = 0;
  const log = [prop(['tristan', 'laptop', 'bob'], [['tristan', 'laptop']])];
  const f0 = consent.fold(log, LEGACY);
  assert.deepEqual(f0.proposals.get(H)!.same, [['tristan', 'laptop']]);
  assert.deepEqual([f0.matrix(H).missing, f0.matrix(H).people, f0.matrix(H).also], [['tristan', 'bob'], 2, { tristan: ['laptop'] }]);

  log.push(ans('tristan', 'signoff'));
  let f = consent.fold([...log], LEGACY);
  let m = f.matrix(H);
  assert.deepEqual([m.agreed, m.missing, m.also, m.complete], [['tristan'], ['bob'], { tristan: ['laptop'] }, false]);
  assert.deepEqual([m.answers.laptop, m.signed.laptop], [{ id: 2, kind: 'signoff' }, 2], 'the group shares the answer');
  assert.equal(f.answerOf(H, 'laptop')!.id, 2);
  assert.equal(f.ownAnswer(H, 'laptop'), null, 'laptop itself has not answered');
  assert.deepEqual(f.pending('laptop'), [], 'laptop\'s review closes');
  assert.deepEqual(f.answerable('laptop').map(p => p.hash), [H], 'but laptop may still answer');
  assert.deepEqual(f.pending('bob').map(p => p.hash), [H]);

  log.push(ans('laptop', 'objection')); // the newer seat's answer overrides
  m = consent.fold([...log], LEGACY).matrix(H);
  assert.deepEqual([m.agreed, m.objected, m.also], [[], ['laptop'], { laptop: ['tristan'] }]);
  assert.equal(m.answers.tristan!.kind, 'objection');

  log.push(ans('bob', 'signoff'));
  assert.equal(consent.fold([...log], LEGACY).matrix(H).complete, true, 'every person answered');
  log.push(ans('tristan', 'revoke')); // a legacy revoke from either seat clears the group's answer
  f = consent.fold([...log], LEGACY);
  m = f.matrix(H);
  assert.deepEqual([m.missing, m.complete, m.answers.laptop], [['tristan'], false, null]);
  assert.deepEqual(f.pending('laptop').map(p => p.hash), [H]);
});

test('fold: without same (an older proposer) every seat is its own approver; a stray same is read safely', () => {
  id = 0;
  const f = consent.fold([prop(['tristan', 'laptop']), ans('tristan', 'signoff')], LEGACY);
  assert.deepEqual([f.matrix(H).missing, f.matrix(H).people, f.pending('laptop').length], [['laptop'], 2, 1]);
  assert.deepEqual(consent.groupsOf([['a', 'x'], ['b', 'c', 'b'], ['c', 'd'], 'e'], ['a', 'b', 'c', 'd']), [['b', 'c']],
    'only approvers, 2+ each, disjoint');
});

test('validate: same is for proposals, groups of 2+ approvers, disjoint, capped at ENTRY_LIST_MAX names', t => {
  h.freshHome(t);
  const R = room.open(h.newRoom());
  const err = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: Error & { code?: string }) => e.code === 'INVALID' && re.test(e.message), re.source);
  const put = (extra: Partial<EntryInput>, hash = H) => R.append({ kind: 'proposal', text: `proposal ${hash}: x`, hash, ...extra }, { via: 'agent', from: 'carol' });
  assert.deepEqual(put({ approvers: ['a', 'b', 'c'], same: [['a', 'b']] }).same, [['a', 'b']]);
  err(() => R.append({ kind: 'say', text: 'x', same: [['a', 'b']] }, { via: 'human', from: 'a' }), /same is only for proposals/);
  err(() => put({ approvers: ['a', 'b'], same: [['a']] }), /groups of 2 or more names/);
  err(() => put({ approvers: ['a', 'b'], same: ['a', 'b'] as unknown as string[][] }), /groups of 2 or more names/); // deliberate: a flat list
  err(() => put({ approvers: ['a', 'b', 'c'], same: [['a', 'b'], ['b', 'c']] }), /names a seat twice/);
  err(() => put({ approvers: ['a', 'b'], same: [['a', 'z']] }), /names only approvers/);
  const many = Array.from({ length: config.ENTRY_LIST_MAX }, (_, i) => `n${i}`);
  put({ approvers: many, same: [many] }, 'abcdef000001');
  err(() => put({ approvers: many, same: [many, many.slice(0, 2)] }), /too many names in same \(\d+; the limit is \d+\)/);
});

/** A room with seats: name -> {machine, account?}. */
function seated(t: TestContext, seats: Record<string, Partial<Member>>): RoomCode {
  h.freshHome(t);
  const code = h.newRoom();
  const now = new Date().toISOString();
  store.open(code).members.update(() => Object.fromEntries(Object.entries(seats).map(([name, s]) => [name, { name: sn(name), role: 'member', joined_at: now, seen_at: now, ...s }])));
  return code;
}

test('create: the approvers are grouped by account; an invite\'s seat never merges, even from the same machine', t => {
  const HOST = machineId()!;
  const code = seated(t, {
    tristan: { machine: HOST, account: HOST },     // on the host
    laptop: { machine: 'laptop0machine1', account: HOST }, // over a login link
    bob: { machine: 'shared0machine1' },          // two invites from one machine: two people
    carol: { machine: 'shared0machine1' },
  });
  const r = proposal.create({ code, name: sn('carol') }, { text: '# Ship v3\n' });
  assert.deepEqual([r.approvers, r.entry!.same], [['tristan', 'laptop', 'bob', 'carol'], [['tristan', 'laptop']]]);
  assert.equal(proposal.personOf({ account: HOST }), HOST);
  const noAccount: Pick<Member, 'account' | 'machine'> = { machine: HOST };
  assert.equal(proposal.personOf(noAccount), undefined, 'only an account merges');
  // the decision names one seat per person
  const me = (name: string) => ({ code, name: sn(name) });
  for (const n of ['laptop', 'bob', 'carol']) assert.ok(proposal.answer(me(n), r, { choice: 'Agree' }).entry);
  assert.equal(proposal.answer(me('laptop'), r, { choice: 'Agree' }).stale, true, 'one answer per seat');
  const d = proposal.decide(code, r.hash)!;
  assert.equal(d.text, `agreed: laptop (also tristan), bob, carol (proposal ${r.hash})`);
  assert.equal(new Set(d.refs).size, d.refs!.length, 'each answer referenced once');
  assert.deepEqual(proposal.pendingFor(me('tristan')), []);
});

test('create: several seats on the host are several people: login seats are the owner\'s (who opened the room) only', t => {
  const HOST = machineId()!;
  const code = seated(t, {
    alice: { machine: HOST, account: HOST },
    tristan: { machine: HOST, account: HOST, owner: true },
    laptop: { machine: 'laptop0machine1', account: HOST },
  });
  const r = proposal.create({ code, name: sn('alice') }, { text: '# Ship v3\n' });
  assert.deepEqual([r.approvers, r.entry!.same], [['alice', 'tristan', 'laptop'], [['tristan', 'laptop']]], 'alice stays her own');
  const m = room.open(code).fold().matrix(r.hash);
  assert.deepEqual([m.people, m.missing], [2, ['alice', 'tristan']]);
  const one = proposal.create({ code, name: sn('alice') }, { text: '# Ship v4\n', approvers: ['alice', 'tristan'] });
  assert.equal(one.entry!.same, undefined, 'two plain seats on the host never merge: no group, no field');
  const two = proposal.create({ code, name: sn('alice') }, { text: '# Ship v5\n', approvers: ['alice', 'laptop'] });
  assert.equal(two.entry!.same, undefined, 'a host seat that is not the owner is not grouped with a login seat');
});

test('create: a room from before the owner field: the earliest-joined host seat present is the owner', t => {
  const HOST = machineId()!;
  const code = seated(t, {
    alice: { machine: HOST, account: HOST, joined_at: '2026-01-02T00:00:00.000Z' },
    tristan: { machine: HOST, account: HOST, joined_at: '2026-01-01T00:00:00.000Z' },
    gone: { machine: HOST, account: HOST, joined_at: '2025-12-31T00:00:00.000Z', left_at: '2026-01-01T00:00:00.000Z' },
    phone: { machine: 'phone0machine01', account: HOST },
    tablet: { machine: 'tablet0machine1', account: HOST },
    guest: { machine: 'phone0machine01' },
  });
  const r = proposal.create({ code, name: sn('alice') }, { text: '# Ship v3\n' });
  assert.deepEqual(r.entry!.same, [['tristan', 'phone', 'tablet']], 'an invite seat from the same machine stays its own');
});

test('members.join: the first person\'s seat on the host is the owner, kept across a rejoin; later seats are not', t => {
  h.freshHome(t);
  const code = h.newRoom();
  const s = store.open(code);
  const HOST = machineId()!;
  assert.equal(s.members.join({ name: sn('claude'), role: 'claude', machine: HOST }).ok, true, 'the room\'s Claude is no one\'s');
  s.members.join({ name: sn('tristan'), role: 'member', machine: HOST, account: HOST });
  s.members.join({ name: sn('alice'), role: 'member', machine: HOST, account: HOST });
  s.members.join({ name: sn('laptop'), role: 'member', machine: 'laptop0machine1', account: HOST });
  s.members.join({ name: sn('tristan'), role: 'member', machine: HOST, account: HOST });
  const ms = s.members.read();
  assert.deepEqual(['claude', 'tristan', 'alice', 'laptop'].map(n => !!ms[n].owner), [false, true, false, false]);
  h.freshHome(t);
  const c2 = h.newRoom();
  store.open(c2).members.join({ name: sn('guest'), role: 'member', machine: 'far0machine0001' });
  store.open(c2).members.join({ name: sn('bob'), role: 'member', machine: HOST, account: HOST });
  assert.equal(store.open(c2).members.read().bob.owner, undefined, 'a person was there first');
});

test('create: a mirror writes same only while its host\'s caps list it (the link document\'s fields)', t => {
  assert.equal(proposal.sameOk(seated(t, {})), true, 'the host itself');
  const code = rc('gate-0000');
  const mem = new MemoryRoomStore(code, { isHost: false });
  store.setBackend(() => mem);
  t.after(() => store.setBackend(null));
  assert.equal(proposal.sameOk(code), false, 'no link document: an older host, or offline');
  mem.kv.set('link', { state: 'online' });
  assert.equal(proposal.sameOk(code), false, 'an older host lists no fields');
  mem.kv.set('link', { state: 'online', fields: ['same'] });
  assert.equal(proposal.sameOk(code), true);
});

test('17: a proposal\'s title drops a numbered-list marker ("1. Add an MIT LICENSE file" is "Add an MIT LICENSE file"), as it drops a heading\'s', t => {
  const code = seated(t, { alice: { machine: machineId()!, account: machineId()! }, bob: { machine: 'other0machine1' } });
  // stage 8e F (live verify, locala/17): markers after a heading's ("# 1. Add X") go too (bob's: the rate limit is per seat)
  for (const [text, want, name] of [['1. Add an MIT LICENSE file\n2. Link it\n', 'Add an MIT LICENSE file', 'alice'], ['12) Ship v3\n', 'Ship v3', 'alice'], ['## Ship v4\n', 'Ship v4', 'alice'], ['2026 plans\n', '2026 plans', 'alice'],
    ['# 1. Add X\n', 'Add X', 'bob'], ['## 2) - Add Y\n', 'Add Y', 'bob'], ['> # Z\n', 'Z', 'bob']] as const) {
    const r = proposal.create({ code, name: sn(name) }, { text });
    assert.equal(r.entry!.text, `proposal ${r.hash}: ${want}`, text);
    assert.equal(proposal.title(code, r.hash), want);
  }
});
