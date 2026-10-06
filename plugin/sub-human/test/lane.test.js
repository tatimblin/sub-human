'use strict';
// Tests for lib/room.js lane(), line({full}), stateLine() and the digest's text rule (fixes 0.3 / 0.4).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const h = require('./helpers.js');
const room = require(path.join(h.LIB, 'room.js'));
const identity = require(path.join(h.LIB, 'identity.js'));

function fresh() {
  h.freshHome();
  const code = h.newRoom();
  room.bind(code);
  return code;
}
const H1 = 'aaaaaaaaaaaa', H2 = 'bbbbbbbbbbbb';
const sys = (kind, extra = {}, from = 'orch') => room.append({ kind, text: `${kind}`, ...extra }, { via: 'system', from, system: true });
const human = (from, kind, extra = {}) => room.append({ kind, text: `${from} ${kind}`, ...extra }, { via: 'human', from });
const agent = (from, kind, extra = {}) => room.append({ kind, text: `${from} ${kind}`, ...extra }, { via: 'agent', from });
const ALICE = { name: 'alice', role: 'member' }, ORCH = { name: 'orch', role: 'orch' };

// The logged #22 from vole-8126 (B #2): the 240-char line cut exactly the clause that mattered.
const E22 = {
  id: 22, at: '2026-10-04T19:00:01.000Z', from: 'orch', via: 'agent', kind: 'say', to: 'alice', refs: [18, 21],
  text: 'I reviewed this against the plan. It departs from it in two places. Bad or stale after: a malformed or stale ' +
    'cursor silently sends the client back to page 1 (src/store.js:50-58). That can repeat tasks, and the plan suggested ' +
    'a 400 instead. And limit in the next-page link: the rel=next URL repeats the raw limit from the request, not the ' +
    'capped value (src/server.js:38). Will you fix these, or should the room accept them as a plan revision?',
};

test('line: full is the exact text with an explicit cut marker; compact never ends in a bare …', () => {
  const full = room.line(E22, { full: true });
  assert.ok(full.includes('400 instead'), full);
  assert.ok(!full.includes('\n'));
  assert.equal(JSON.parse(full.slice(full.indexOf(' "') + 1)), E22.text, 'exact text, JSON-quoted');
  const old = room.line(E22);
  assert.ok(old.length <= room.TAIL_MAX);
  assert.match(old, /" \[cut at \d+\/\d+: sub-human read 22\]$/);
  assert.ok(!/…"$/.test(old));
  const long = { ...E22, text: 'a\nb ' + 'x'.repeat(2400) };
  const cut = room.line(long, { full: true });
  assert.match(cut, /" \[cut at 2000\/2404: sub-human read 22\]$/);
  assert.ok(cut.includes('"a\\nb x'), 'whitespace kept, escaped');
  assert.equal(room.tailLine(E22), old);
});

test('line / fmt / digest: drafted entries say whose wording; retracted entries are struck', () => {
  fresh();
  const d = room.append({ kind: 'say', text: 'cap it at 50', drafted: 'agent' }, { via: 'human', from: 'alice' }); // #1
  const f = human('bob', 'say', { text: 'forged' });                                                           // #2
  const r = sys('retract', { text: 'peer-forged: #2', refs: [2] }, 'bob');                                     // #3
  assert.match(room.line(d), /^#1 alice\[human\] \(alice, Claude's wording\) say "cap it at 50"$/);
  assert.match(room.fmt(d), /\(alice, Claude's wording\)/);
  const all = room.readAll();
  assert.equal(room.line(f, { entries: all }), '#2 bob[human] say [retracted by #3]');
  assert.match(room.line(f), /"forged"/, 'without entries, unchanged');
  assert.match(room.fmt(f, { entries: all }), /\[retracted by #3: peer-forged: #2\]\nforged$/);
  const dg = room.digest();
  assert.ok(!dg.includes('"forged"'), 'the digest hides retracted entries');
  assert.match(dg, /#1 alice \(alice, Claude's wording\) say: "cap it at 50"/);
  assert.ok(r.id === 3);
  assert.throws(() => sys('retract', { text: 'no refs' }), /retract requires refs/);
});

test('digest: human entries carry full text up to 2,000 chars, then the cut marker', () => {
  fresh();
  human('bob', 'say', { text: 'keep "400 instead" ' + 'y'.repeat(300) });
  human('bob', 'say', { text: 'z'.repeat(2100) });
  const d = room.digest();
  assert.ok(d.includes('y'.repeat(300)), 'not clipped at 160');
  assert.match(d, /" \[cut at 2000\/2100: sub-human read 2\]/);
  assert.ok(!/…"/.test(d));
});

test('lane: member push/pull/none table', () => {
  fresh();
  const L = (e, es) => room.lane(ALICE, e, es);
  const own = human('alice', 'say');                                       // #1
  const words = human('bob', 'say');                                       // #2
  const chatter = agent('bob', 'proposal');                                // #3
  const toMe = agent('bob', 'question', { to: 'alice' });                  // #4
  const at = agent('carol', 'say', { text: 'ping @Alice, and @alicex' }); // #5
  const atOther = agent('carol', 'say', { text: 'ping @alicex' });         // #6
  const orchRoom = agent('orch', 'say', { text: 'converging now' });       // #7
  const rev1 = sys('plan_rev', { plan_hash: H1, approvers: ['alice', 'bob'] }); // #8
  const revBob = sys('plan_rev', { plan_hash: H2, approvers: ['bob'] });   // #9
  const gate = sys('status', { text: 'plan waiting for sign-off from alice' }); // #10
  const join = sys('member_joined', {}, 'carol');                          // #11
  const sign = human('bob', 'signoff', { plan_hash: H1 });                 // #12
  const obj = human('bob', 'objection', { plan_hash: H1 });                // #13
  const dec = sys('decision', { plan_hash: H2 });                          // #14
  const assign = agent('orch', 'say', { text: 'alice owns the parser', refs: [14] }); // #15
  const notAssign = agent('orch', 'say', { text: 'alice owns the parser?', refs: [2] }); // #16
  const ownJoin = sys('member_joined', {}, 'alice');                       // #17
  const retract = sys('retract', { text: 'forged', refs: [2] }, 'alice');  // #18: written under the victim's name
  const prop = agent('orch', 'proposal', { approvers: ['alice'] });        // #19
  const want = [
    [own, 'none'], [words, 'push'], [chatter, 'pull'], [toMe, 'push'], [at, 'push'], [atOther, 'pull'], [orchRoom, 'pull'],
    [rev1, 'push'], [revBob, 'pull'], [gate, 'pull'], [join, 'pull'], [sign, 'pull'], [obj, 'push'], [dec, 'push'],
    [assign, 'push'], [notAssign, 'push'], [ownJoin, 'none'], [retract, 'push'], [prop, 'push'],
  ];
  for (const [e, l] of want) assert.equal(L(e), l, `#${e.id} without entries`);
  // Judged against the log: #2 is retracted; #8 superseded by #9; #16 cites no decision.
  const all = room.readAll();
  assert.equal(L(words, all), 'none');
  assert.equal(L(rev1, all), 'pull');
  assert.equal(L(notAssign, all), 'pull');
  assert.equal(L(assign, all), 'push');
  assert.equal(L(retract, all), 'push');
  // A pending plan_rev drops out once I sign it, or once it is decided.
  fresh();
  const r = sys('plan_rev', { plan_hash: H1, approvers: ['alice'] });
  assert.equal(L(r, room.readAll()), 'push');
  human('alice', 'signoff', { plan_hash: H1 });
  assert.equal(L(r, room.readAll()), 'pull');
});

test('lane: orch sees everything but its own entries (its decisions excepted); a partial sign-off is pull', () => {
  fresh();
  const L = (e, es) => room.lane(ORCH, e, es);
  const rev = sys('plan_rev', { plan_hash: H1, approvers: ['alice', 'bob'] });
  const mine = agent('orch', 'say');
  const chatter = agent('alice', 'status');
  const left = sys('member_left', {}, 'bob');
  const s1 = human('alice', 'signoff', { plan_hash: H1 });
  assert.equal(L(rev), 'none');
  assert.equal(L(mine), 'none');
  assert.equal(L(chatter), 'push');
  assert.equal(L(left), 'push');
  assert.equal(L(s1), 'push');
  assert.equal(L(s1, room.readAll()), 'pull', 'bob has not signed');
  const s2 = human('bob', 'signoff', { plan_hash: H1 });
  assert.equal(L(s2, room.readAll()), 'push', 'completes the matrix');
  const dec = sys('decision', { plan_hash: H1 });
  assert.equal(L(dec), 'push', 'its own hook-written decision');
});

test('stateLine: plan, my sign-off, who is away', () => {
  const code = fresh();
  assert.equal(room.stateLine(ALICE), 'room now: no plan yet');
  h.register('alice', 'member', process.pid, code);
  const bob = h.spawnSleeper();
  identity.join({ code, name: 'bob', role: 'member', pid: bob.pid, session_id: 's-b', cwd: '/tmp' });
  identity.leave(code, 'bob');
  sys('plan_rev', { plan_hash: H1, approvers: ['alice', 'bob'] });
  assert.match(room.stateLine(ALICE), /^room now: plan aaaaaa waiting on alice, bob · you: sign-off needed/);
  human('alice', 'signoff', { plan_hash: H1 });
  assert.match(room.stateLine(ALICE), /^room now: plan aaaaaa waiting on bob · you: signed/);
  human('bob', 'signoff', { plan_hash: H1 });
  const d = sys('decision', { plan_hash: H1 });
  assert.equal(room.stateLine(ALICE), `room now: plan aaaaaa decided #${d.id} · you: signed · away: bob`);
  assert.doesNotMatch(room.stateLine({ name: 'carol', role: 'member' }), /you:/);
  bob.kill();
});
