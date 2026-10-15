'use strict';
// One person in two seats (lib/room/consent.ts `same` groups, lib/proposal.ts create): seats with one account are one
// approver. The fold counts the newest answer of any seat for the group (a revoke clears it); create groups the
// approvers by account, never an invite's seat, nor the host's own seats when several people share the host; validate
// caps `same`; a mirror writes it only when its host's caps list it; the decision names one seat per person.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const h = require('./helpers.js');
const room = require(path.join(h.LIB, 'room.ts'));
const store = require(path.join(h.LIB, 'room', 'store.ts'));
const consent = require(path.join(h.LIB, 'room', 'consent.ts'));
const proposal = require(path.join(h.LIB, 'proposal.ts'));
const config = require(path.join(h.LIB, 'config.ts'));
const { machineId } = require(path.join(h.LIB, 'home.ts'));
const { MemoryRoomStore } = require('./support/memory-store.js');

const H = 'abcdef012345';
let id = 0;
const at = '2026-01-01T00:00:00.000Z';
const prop = (approvers, same, from = 'carol') => ({ id: ++id, at, kind: 'proposal', via: 'agent', from, text: `proposal ${H}: Ship`, hash: H, approvers, ...(same ? { same } : {}) });
const ans = (from, kind) => ({ id: ++id, at, kind, via: 'human', from, proposal_hash: H });

test('fold: one answer satisfies a same group; the newest seat\'s answer wins; a revoke clears the group', () => {
  id = 0;
  const log = [prop(['tristan', 'laptop', 'bob'], [['tristan', 'laptop']])];
  const f0 = consent.fold(log);
  assert.deepEqual(f0.proposals.get(H).same, [['tristan', 'laptop']]);
  assert.deepEqual([f0.matrix(H).missing, f0.matrix(H).people, f0.matrix(H).also], [['tristan', 'bob'], 2, { tristan: ['laptop'] }]);

  log.push(ans('tristan', 'signoff'));
  let f = consent.fold([...log]);
  let m = f.matrix(H);
  assert.deepEqual([m.agreed, m.missing, m.also, m.complete], [['tristan'], ['bob'], { tristan: ['laptop'] }, false]);
  assert.deepEqual([m.answers.laptop, m.signed.laptop], [{ id: 2, kind: 'signoff' }, 2], 'the group shares the answer');
  assert.equal(f.answerOf(H, 'laptop').id, 2);
  assert.equal(f.ownAnswer(H, 'laptop'), null, 'laptop itself has not answered');
  assert.deepEqual(f.pending('laptop'), [], 'laptop\'s review closes');
  assert.deepEqual(f.answerable('laptop').map(p => p.hash), [H], 'but laptop may still answer');
  assert.deepEqual(f.pending('bob').map(p => p.hash), [H]);

  log.push(ans('laptop', 'objection')); // the newer seat's answer overrides
  m = consent.fold([...log]).matrix(H);
  assert.deepEqual([m.agreed, m.objected, m.also], [[], ['laptop'], { laptop: ['tristan'] }]);
  assert.equal(m.answers.tristan.kind, 'objection');

  log.push(ans('bob', 'signoff'));
  assert.equal(consent.fold([...log]).matrix(H).complete, true, 'every person answered');
  log.push(ans('tristan', 'revoke')); // a legacy revoke from either seat clears the group's answer
  f = consent.fold([...log]);
  m = f.matrix(H);
  assert.deepEqual([m.missing, m.complete, m.answers.laptop], [['tristan'], false, null]);
  assert.deepEqual(f.pending('laptop').map(p => p.hash), [H]);
});

test('fold: without same (an older proposer) every seat is its own approver; a stray same is read safely', () => {
  id = 0;
  const f = consent.fold([prop(['tristan', 'laptop']), ans('tristan', 'signoff')]);
  assert.deepEqual([f.matrix(H).missing, f.matrix(H).people, f.pending('laptop').length], [['laptop'], 2, 1]);
  assert.deepEqual(consent.groupsOf([['a', 'x'], ['b', 'c', 'b'], ['c', 'd'], 'e'], ['a', 'b', 'c', 'd']), [['b', 'c']],
    'only approvers, 2+ each, disjoint');
});

test('validate: same is for proposals, groups of 2+ approvers, disjoint, capped at ENTRY_LIST_MAX names', t => {
  h.freshHome(t);
  const R = room.open(h.newRoom());
  const err = (fn, re) => assert.throws(fn, e => e.code === 'INVALID' && re.test(e.message), re.source);
  const put = (extra, hash = H) => R.append({ kind: 'proposal', text: `proposal ${hash}: x`, hash, ...extra }, { via: 'agent', from: 'carol' });
  assert.deepEqual(put({ approvers: ['a', 'b', 'c'], same: [['a', 'b']] }).same, [['a', 'b']]);
  err(() => R.append({ kind: 'say', text: 'x', same: [['a', 'b']] }, { via: 'human', from: 'a' }), /same is only for proposals/);
  err(() => put({ approvers: ['a', 'b'], same: [['a']] }), /groups of 2 or more names/);
  err(() => put({ approvers: ['a', 'b'], same: ['a', 'b'] }), /groups of 2 or more names/);
  err(() => put({ approvers: ['a', 'b', 'c'], same: [['a', 'b'], ['b', 'c']] }), /names a seat twice/);
  err(() => put({ approvers: ['a', 'b'], same: [['a', 'z']] }), /names only approvers/);
  const many = Array.from({ length: config.ENTRY_LIST_MAX }, (_, i) => `n${i}`);
  put({ approvers: many, same: [many] }, 'abcdef000001');
  err(() => put({ approvers: many, same: [many, many.slice(0, 2)] }), /too many names in same \(\d+; the limit is \d+\)/);
});

/** A room with seats: name -> {machine, account?}. */
function seated(t, seats) {
  h.freshHome(t);
  const code = h.newRoom();
  const now = new Date().toISOString();
  store.open(code).members.update(() => Object.fromEntries(Object.entries(seats).map(([name, s]) => [name, { name, role: 'member', joined_at: now, seen_at: now, ...s }])));
  return code;
}

test('create: the approvers are grouped by account; an invite\'s seat never merges, even from the same machine', t => {
  const HOST = machineId();
  const code = seated(t, {
    tristan: { machine: HOST, account: HOST },     // on the host
    laptop: { machine: 'laptop0machine1', account: HOST }, // over a login link
    bob: { machine: 'shared0machine1' },          // two invites from one machine: two people
    carol: { machine: 'shared0machine1' },
  });
  const r = proposal.create({ code, name: 'carol' }, { text: '# Ship v3\n' });
  assert.deepEqual([r.approvers, r.entry.same], [['tristan', 'laptop', 'bob', 'carol'], [['tristan', 'laptop']]]);
  assert.equal(proposal.personOf({ account: HOST }), HOST);
  assert.equal(proposal.personOf({ machine: HOST }), undefined, 'only an account merges');
  // the decision names one seat per person
  const me = name => ({ code, name });
  for (const n of ['laptop', 'bob', 'carol']) assert.ok(proposal.answer(me(n), r, { choice: 'Agree' }).entry);
  assert.equal(proposal.answer(me('laptop'), r, { choice: 'Agree' }).stale, true, 'one answer per seat');
  const d = proposal.decide(code, r.hash);
  assert.equal(d.text, `agreed: laptop (also tristan), bob, carol (proposal ${r.hash})`);
  assert.equal(new Set(d.refs).size, d.refs.length, 'each answer referenced once');
  assert.deepEqual(proposal.pendingFor(me('tristan')), []);
});

test('create: several seats on the host may be several people: they never merge, nor does a login seat with them', t => {
  const HOST = machineId();
  const code = seated(t, {
    alice: { machine: HOST, account: HOST },
    bob: { machine: HOST, account: HOST },
    phone: { machine: 'phone0machine01', account: HOST },
    tablet: { machine: 'tablet0machine1', account: HOST },
  });
  const r = proposal.create({ code, name: 'alice' }, { text: '# Ship v3\n' });
  assert.deepEqual(r.entry.same, [['phone', 'tablet']], 'the login seats are one person; the host\'s two are their own');
  const one = proposal.create({ code, name: 'alice' }, { text: '# Ship v4\n', approvers: ['alice', 'bob'] });
  assert.equal(one.entry.same, undefined, 'no group, no field');
});

test('create: a mirror writes same only while its host\'s caps list it (the link document\'s fields)', t => {
  assert.equal(proposal.sameOk(seated(t, {})), true, 'the host itself');
  const code = 'gate0room';
  const mem = new MemoryRoomStore(code, { isHost: false });
  store.setBackend(() => mem);
  t.after(() => store.setBackend(null));
  assert.equal(proposal.sameOk(code), false, 'no link document: an older host, or offline');
  mem.kv.set('link', { state: 'online' });
  assert.equal(proposal.sameOk(code), false, 'an older host lists no fields');
  mem.kv.set('link', { state: 'online', fields: ['same'] });
  assert.equal(proposal.sameOk(code), true);
});
