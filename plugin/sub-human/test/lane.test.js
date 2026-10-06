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
  assert.match(room.fmt(f, { entries: all }), /\[retracted by #3: peer-forged: #2\]\n  │ forged$/);
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

const prop = (from, hash, approvers, via = 'agent') => room.append({ kind: 'proposal', text: `${from} proposes`, hash, approvers }, { via, from });
const answer = (from, kind, hash, extra = {}) => room.append({ kind, proposal_hash: hash, ...extra }, { via: 'human', from });
const taskReq = (from, op, extra = {}) => room.append({ kind: 'task_req', op, ...extra }, { via: 'agent', from });
const task = (extra = {}) => room.append({ kind: 'task', op: 'update', ...extra }, { via: 'system', from: 'orch', system: true });

test('lane: member push/pull/none table (vole-8126 shapes + proposals + tasks)', () => {
  fresh();
  const L = (e, es) => room.lane(ALICE, e, es);
  const own = human('alice', 'say');                                       // #1
  const words = human('bob', 'say');                                       // #2 others' human words
  const chatter = agent('bob', 'status');                                  // #3
  const toMe = agent('bob', 'question', { to: 'alice' });                  // #4
  const at = agent('carol', 'say', { text: 'ping @Alice, and @alicex' }); // #5
  const atOther = agent('carol', 'say', { text: 'ping @alicex' });         // #6
  const orchRoom = agent('orch', 'say', { text: 'alice owns the parser' }); // #7 names me, no @: pull
  const p1 = prop('orch', H1, ['alice', 'bob']);                           // #8 names me, pending
  const pBob = prop('orch', H2, ['bob']);                                  // #9 not mine
  const join = sys('member_joined', {}, 'carol');                          // #10
  const sign = answer('bob', 'signoff', H1);                               // #11 others' card answer: pull
  const dec2 = sys('decision', { proposal_hash: H2 }, 'room');             // #12 a proposal I am not in
  const dec1 = sys('decision', { proposal_hash: H1 }, 'room');             // #13 mine
  const ownJoin = sys('member_joined', {}, 'alice');                       // #14
  const retract = sys('retract', { text: 'forged', refs: [2] }, 'alice');  // #15 written under the victim's name
  const req = taskReq('bob', 'add', { subject: 'parser tests', owner: 'alice' }); // #16 bob asks for alice
  const assigned = task({ task_id: 2, subject: 'parser tests', owner: 'alice', status: 'pending', req: 16 }); // #17 push
  const myReq = taskReq('alice', 'claim', { id: 3 });                      // #18 own: none
  const claimed = task({ task_id: 3, owner: 'alice', status: 'in_progress', req: 18 }); // #19 I asked: pull
  const bobsTask = task({ task_id: 4, owner: 'bob', status: 'in_progress', req: 16 }); // #20 pull
  const ownAnswer = answer('alice', 'objection', H1, { text: 'clamp, do not 400' }); // #21 own: none
  const want = [
    [own, 'none'], [words, 'push'], [chatter, 'pull'], [toMe, 'push'], [at, 'push'], [atOther, 'pull'], [orchRoom, 'pull'],
    [p1, 'push'], [pBob, 'pull'], [join, 'pull'], [sign, 'pull'], [dec2, 'push'], [dec1, 'push'], [ownJoin, 'none'],
    [retract, 'push'], [req, 'pull'], [assigned, 'push'], [myReq, 'none'], [claimed, 'push'], [bobsTask, 'pull'], [ownAnswer, 'none'],
  ];
  for (const [e, l] of want) assert.equal(L(e), l, `#${e.id} without entries`);
  // Judged against the log: #2 retracted; #8 answered by me (#21) and decided; #12's proposal is not mine; #19 I asked for.
  const all = room.readAll();
  assert.equal(L(words, all), 'none');
  assert.equal(L(p1, all), 'pull');
  assert.equal(L(dec2, all), 'pull');
  assert.equal(L(dec1, all), 'push');
  assert.equal(L(assigned, all), 'push');
  assert.equal(L(claimed, all), 'pull');
  assert.equal(L(retract, all), 'push', 'its victim hears it');
  assert.equal(room.lane({ name: 'carol', role: 'member' }, retract, all), 'push', 'carol was pushed #2');
  assert.equal(room.lane({ name: 'bob', role: 'member' }, retract, all), 'none', 'bob wrote #2 (it was never his push)');
  // A pending proposal stays push until I answer it, then pull.
  fresh();
  const r = prop('bob', H1, ['alice', 'bob'], 'human');
  assert.equal(L(r, room.readAll()), 'push');
  answer('alice', 'signoff', H1);
  assert.equal(L(r, room.readAll()), 'pull');
  // The proposer hears the decision on its own proposal.
  fresh();
  prop('alice', H1, ['bob']);
  const d = sys('decision', { proposal_hash: H1 }, 'room');
  assert.equal(L(d, room.readAll()), 'push');
});

test('lane: orch push is to/@orch, objections on its proposals, task_req; the rest (decisions too) is pull', () => {
  fresh();
  const L = (e, es) => room.lane(ORCH, e, es);
  const mine = prop('orch', H1, ['alice', 'bob']);                        // #1 own: none
  const theirs = prop('bob', H2, ['alice'], 'human');                      // #2 pull
  const words = human('alice', 'say');                                     // #3 human chatter: pull
  const atOrch = human('bob', 'say', { text: '@orch let us plan cursor paging' }); // #4 push
  const toOrch = agent('alice', 'question', { to: 'orch' });              // #5 push
  const chatter = agent('alice', 'status');                                // #6 pull
  const left = sys('member_left', {}, 'bob');                              // #7 pull
  const joined = sys('member_joined', {}, 'carol');                        // #8 pull (tail adds the row note)
  const s1 = answer('alice', 'signoff', H1);                               // #9 signoff on its proposal: pull (the decision carries it)
  const o2 = answer('alice', 'objection', H2, { text: 'no' });             // #10 answer on bob's: pull
  const dec = sys('decision', { proposal_hash: H1 }, 'orch');              // #11 pull: nothing for the orch to act on
  const req = taskReq('bob', 'add', { subject: 'parser tests' });          // #12 push
  const t = task({ task_id: 2, owner: 'bob', status: 'pending', req: 12 }); // #13 its own mirror: pull
  const ownPost = agent('orch', 'say');                                    // #14 none
  const want = [[mine, 'none'], [theirs, 'pull'], [words, 'pull'], [atOrch, 'push'], [toOrch, 'push'], [chatter, 'pull'],
    [left, 'pull'], [joined, 'pull'], [s1, 'pull'], [o2, 'push'], [dec, 'pull'], [req, 'push'], [t, 'pull'], [ownPost, 'none']];
  for (const [e, l] of want) assert.equal(L(e), l, `#${e.id} without entries`);
  const all = room.readAll();
  assert.equal(L(s1, all), 'pull');
  assert.equal(L(o2, all), 'pull', 'not its proposal');
  const o1 = answer('bob', 'objection', H1, { text: 'clamp' });
  assert.equal(L(o1, room.readAll()), 'push', 'an objection on its own proposal wakes it (to revise)');
  assert.equal(L(req, all), 'push');
  assert.equal(req.by, 'bob');
});

test('lane (P3 wakes): every person\'s words reach every member (a group chat), card answers and quiet decisions', () => {
  const code = fresh();
  h.register('alice', 'member', process.pid, code);
  const BOB = { name: 'bob', role: 'member' };
  const atOrch = human('bob', 'say', { text: '@orch let us plan cursor paging' });
  const atBob = human('carol', 'say', { text: '@orch @bob take a look' });
  const plain = human('bob', 'say', { text: 'alice, can you take the parser tests?' });
  const email = human('bob', 'say', { text: 'mail ops@orch.example' });
  for (const [e, l] of [[atOrch, 'push'], [atBob, 'push'], [plain, 'push'], [email, 'push']]) assert.equal(room.lane(ALICE, e), l, `#${e.id}`);
  assert.equal(room.lane(BOB, atBob), 'push', 'bob is named');
  assert.equal(room.lane(ORCH, atOrch), 'push');
  // Round 1: alice agrees, bob objects last; round 2: alice agrees, bob agrees last. The orch proposed.
  prop('orch', H1, ['alice', 'bob']);
  const a1 = answer('alice', 'signoff', H1);
  const o1 = answer('bob', 'objection', H1, { text: 'clamp' });
  const d1 = sys('decision', { proposal_hash: H1, text: 'objected: bob · agreed: alice', refs: [a1.id, o1.id] }, 'room');
  prop('orch', H2, ['alice', 'bob']);
  const a2 = answer('alice', 'signoff', H2);
  const s2 = answer('bob', 'signoff', H2);
  const d2 = sys('decision', { proposal_hash: H2, text: 'agreed: alice, bob', refs: [a2.id, s2.id] }, 'room');
  const all = room.readAll();
  const L = (me, e) => room.lane(me, e, all);
  assert.deepEqual([a1, o1, a2, s2].map(e => L(ALICE, e)), ['none', 'pull', 'none', 'pull'], 'answers never wake another approver');
  assert.deepEqual([a1, o1, a2, s2].map(e => L(ORCH, e)), ['pull', 'push', 'pull', 'pull'], 'only an objection wakes the proposer');
  assert.equal(L(ALICE, d1), 'pull', 'an objected decision: nothing for a non-proposer');
  assert.equal(L(BOB, d1), 'pull', 'bob completed it (told by his card reply)');
  assert.equal(L(ORCH, d1), 'pull', 'the objection already woke the proposer to revise');
  assert.equal(L(ALICE, d2), 'push', 'an agreed decision reaches the approver who did not complete it');
  assert.equal(L(BOB, d2), 'pull', 'bob completed it');
  assert.equal(L(ORCH, d2), 'pull', 'an agreed decision needs nothing from the orch');
  // A member's own proposal: an objected decision still reaches its author.
  prop('alice', 'cccccccccccc', ['bob']);
  const o3 = answer('bob', 'objection', 'cccccccccccc', { text: 'no' });
  const d3 = sys('decision', { proposal_hash: 'cccccccccccc', text: 'objected: bob', refs: [o3.id] }, 'room');
  const all3 = room.readAll();
  assert.equal(room.lane(ALICE, o3, all3), 'push');
  assert.equal(room.lane(ALICE, d3, all3), 'push');
});

test('stateLine: open proposals, my answer, who is away', () => {
  const code = fresh();
  assert.equal(room.stateLine(ALICE), 'room now: no proposals');
  h.register('alice', 'member', process.pid, code);
  const bob = h.spawnSleeper();
  identity.join({ code, name: 'bob', role: 'member', pid: bob.pid, session_id: 's-b', cwd: '/tmp' });
  identity.leave(code, 'bob');
  prop('orch', H1, ['alice', 'bob']);
  assert.match(room.stateLine(ALICE), /^room now: proposal aaaaaa waiting on alice, bob · you: answer needed/);
  answer('alice', 'signoff', H1);
  assert.match(room.stateLine(ALICE), /^room now: proposal aaaaaa waiting on bob · you: agreed/);
  answer('bob', 'objection', H1, { text: 'no' });
  const d = sys('decision', { proposal_hash: H1 }, 'room');
  assert.equal(room.stateLine(ALICE), `room now: proposal aaaaaa decided #${d.id} · you: agreed · away: bob`);
  assert.doesNotMatch(room.stateLine({ name: 'carol', role: 'member' }), /you:/);
  bob.kill();
});
