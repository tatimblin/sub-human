// Tests for lib/room.ts lane(), line({full}), stateLine() and the digest's text rule (fixes 0.3 / 0.4).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as h from './helpers.ts';
import * as room from '../lib/room.ts';
import * as identity from '../lib/identity.ts';
import type { Room } from '../lib/room.ts';
import { lane, deliver } from '../lib/room/deliver.ts';
import type { Entry, EntryInput, Lane, LaneViewer } from '../lib/room/types.ts';
import { sn, eid } from './support/brands.ts';
import { fsStore } from './support/fs-store.ts';

let R: Room; // the current test's room (set by fresh())
/** deliver()'s first step (push: notice or wake; pull: context), judged as the room's own facade judges. */
const roomLane = (me: LaneViewer | null, e: Entry, es?: readonly Entry[]) => lane(me, e, es, room.trustOf);
function fresh() {
  h.freshHome();
  R = room.open(h.newRoom());
  return R.code;
}
/** A line as an older version wrote it (a kind or field append() no longer takes), straight into the log. */
function legacy(fields: Record<string, unknown>): Entry {
  const e = { id: R.lastId() + 1, at: new Date().toISOString(), ...fields };
  fs.appendFileSync(fsStore(R.store).logFile, JSON.stringify(e) + '\n');
  return e as Entry; // deliberate: an older version's line, not one append() takes
}
const H1 = 'aaaaaaaaaaaa', H2 = 'bbbbbbbbbbbb';
const sys = (kind: string, extra: Partial<EntryInput> = {}, from = 'claude') => R.append({ kind, text: `${kind}`, ...extra }, { via: 'system', from, system: true });
const human = (from: string, kind: string, extra: Partial<EntryInput> = {}) => R.append({ kind, text: `${from} ${kind}`, ...extra }, { via: 'human', from });
const agent = (from: string, kind: string, extra: Partial<EntryInput> = {}) => R.append({ kind, text: `${from} ${kind}`, ...extra }, { via: 'agent', from });
const ALICE: LaneViewer = { name: 'alice', role: 'member' }, ROOM_CLAUDE: LaneViewer = { name: 'claude', role: 'claude' };

// The logged #22 from vole-8126 (B #2): the 240-char line cut exactly the clause that mattered.
const E22 = {
  id: eid(22), at: '2026-10-04T19:00:01.000Z', from: 'claude', via: 'agent', kind: 'say', to: 'alice', refs: [18, 21],
  text: 'I reviewed this against the plan. It departs from it in two places. Bad or stale after: a malformed or stale ' +
    'cursor silently sends the client back to page 1 (src/store.ts:50-58). That can repeat tasks, and the plan suggested ' +
    'a 400 instead. And limit in the next-page link: the rel=next URL repeats the raw limit from the request, not the ' +
    'capped value (src/server.ts:38). Will you fix these, or should the room accept them as a plan revision?',
};

test('line: full is the exact text with an explicit cut marker; compact never ends in a bare …', () => {
  const full = room.line(E22, { full: true });
  assert.ok(full.includes('400 instead'), full);
  assert.ok(!full.includes('\n'));
  assert.equal(JSON.parse(full.slice(full.indexOf(' "') + 1)), E22.text, 'exact text, JSON-quoted');
  const old = room.line(E22);
  assert.ok(old.length <= room.TAIL_MAX);
  assert.match(old, /" \[cut at \d+\/\d+: read\(\{ids:\[22\]\}\)\]$/);
  assert.ok(!/…"$/.test(old));
  const long = { ...E22, text: 'a\nb ' + 'x'.repeat(2400) };
  const cut = room.line(long, { full: true });
  assert.match(cut, /" \[cut at 2000\/2404: read\(\{ids:\[22\]\}\)\]$/);
  assert.ok(cut.includes('"a\\nb x'), 'whitespace kept, escaped');
});

test('line / fmt: drafted entries say whose wording', () => {
  fresh();
  const d = R.append({ kind: 'say', text: 'cap it at 50', drafted: 'agent' }, { via: 'human', from: 'alice' }); // #1
  assert.match(room.line(d), /^#1 alice\[human\] \(alice, Claude's wording\) say "cap it at 50"$/);
  assert.match(room.fmt(d), /\(alice, Claude's wording\)/);
});

test('old logs: a `retract` line is an ordinary system line that hides nothing; a `provisional` post is an ordinary post', () => {
  fresh();
  const f = human('bob', 'say', { text: 'forged' });                                                 // #1
  const r = legacy({ from: 'bob', via: 'system', kind: 'retract', text: 'peer-forged: #1', refs: [1] }); // #2
  const p = legacy({ from: 'carol', via: 'human', kind: 'say', to: 'room', text: 'early words', provisional: true }); // #3
  const all = R.readAll();
  assert.deepEqual(all.map(e => e.id), [1, 2, 3], 'the old lines load');
  assert.equal(room.line(f), '#1 bob[human] say "forged"');
  assert.doesNotMatch(room.fmt(f), /retracted/);
  assert.match(room.line(r), /^#2 bob\[system\] retract refs=#1 "peer-forged: #1"$/);
  assert.deepEqual(room.chatLines(r, { viewer: 'alice' }), ['room: peer-forged: #1']);
  assert.equal(roomLane(ALICE, f, all), 'push', 'the line it named still reaches people');
  assert.equal(roomLane(ALICE, r, all), 'pull');
  assert.equal(roomLane({ name: 'bob', role: 'member' }, r, all), 'none', 'written under bob\'s name: his own');
  assert.equal(roomLane(ALICE, p, all), 'push');
  assert.match(room.fmt(p), /early words/);
  assert.throws(() => sys('retract', { text: 'x', refs: [1] }), /kind/, 'nothing writes a retract now');
});

const prop = (from: string, hash: string, approvers: string[], via: 'agent' | 'human' = 'agent') => R.append({ kind: 'proposal', text: `${from} proposes`, hash, approvers }, { via, from });
const answer = (from: string, kind: string, hash: string, extra: Partial<EntryInput> = {}) => R.append({ kind, proposal_hash: hash, ...extra }, { via: 'human', from });
const taskReq = (from: string, op: string, extra: Partial<EntryInput> = {}) => R.append({ kind: 'task_req', op, ...extra }, { via: 'agent', from });
const task = (extra: Partial<EntryInput> = {}) => R.append({ kind: 'task', op: 'update', ...extra }, { via: 'system', from: 'claude', system: true });

test('lane: member push/pull/none table (vole-8126 shapes + proposals + tasks)', () => {
  fresh();
  const L = (e: Entry, es?: readonly Entry[]) => roomLane(ALICE, e, es);
  const own = human('alice', 'say');                                       // #1
  const words = human('bob', 'say');                                       // #2 others' human words
  const chatter = agent('bob', 'status');                                  // #3
  const toMe = agent('bob', 'question', { to: 'alice' });                  // #4
  const at = agent('carol', 'say', { text: 'ping @Alice, and @alicex' }); // #5
  const atOther = agent('carol', 'say', { text: 'ping @alicex' });         // #6
  const roomClaudeRoom = agent('claude', 'say', { text: 'alice owns the parser' }); // #7 names me, no @: pull
  const p1 = prop('claude', H1, ['alice', 'bob']);                           // #8 names me, pending
  const pBob = prop('claude', H2, ['bob']);                                  // #9 not mine
  const join = sys('member_joined', {}, 'carol');                          // #10
  const sign = answer('bob', 'signoff', H1);                               // #11 others' card answer: pull
  const dec2 = sys('decision', { proposal_hash: H2 }, 'room');             // #12 a proposal I am not in
  const dec1 = sys('decision', { proposal_hash: H1 }, 'room');             // #13 mine
  const ownJoin = sys('member_joined', {}, 'alice');                       // #14
  const retract = legacy({ from: 'alice', via: 'system', kind: 'retract', text: 'forged', refs: [2] }); // #15 an old log's line
  const req = taskReq('bob', 'add', { subject: 'parser tests', owner: 'alice' }); // #16 bob asks for alice
  const assigned = task({ task_id: 2, subject: 'parser tests', owner: 'alice', status: 'pending', req: 16 }); // #17 push
  const myReq = taskReq('alice', 'claim', { id: 3 });                      // #18 own: none
  const claimed = task({ task_id: 3, owner: 'alice', status: 'in_progress', req: 18 }); // #19 I asked: pull
  const bobsTask = task({ task_id: 4, owner: 'bob', status: 'in_progress', req: 16 }); // #20 pull
  const ownAnswer = answer('alice', 'objection', H1, { text: 'clamp, do not 400' }); // #21 own: none
  const want: [Entry, Lane][] = [
    [own, 'none'], [words, 'push'], [chatter, 'pull'], [toMe, 'push'], [at, 'push'], [atOther, 'pull'], [roomClaudeRoom, 'pull'],
    [p1, 'push'], [pBob, 'pull'], [join, 'pull'], [sign, 'pull'], [dec2, 'pull'], [dec1, 'pull'], [ownJoin, 'none'],
    [retract, 'none'], [req, 'pull'], [assigned, 'push'], [myReq, 'none'], [claimed, 'push'], [bobsTask, 'pull'], [ownAnswer, 'none'],
  ];
  for (const [e, l] of want) assert.equal(L(e), l, `#${e.id} without entries`);
  // Judged against the log: #8 answered by me (#21) and decided; #12's proposal is not mine; #19 I asked for.
  const all = R.readAll();
  assert.equal(L(words, all), 'push', 'an old retract naming it changes nothing');
  assert.equal(L(p1, all), 'pull');
  assert.equal(L(dec2, all), 'pull');
  assert.equal(L(dec1, all), 'pull', 'a decision reports: never a wake');
  assert.equal(L(assigned, all), 'push');
  assert.equal(L(claimed, all), 'pull');
  assert.equal(roomLane({ name: 'carol', role: 'member' }, retract, all), 'pull', 'an ordinary system line');
  // A pending proposal stays push until I answer it, then pull.
  fresh();
  const r = prop('bob', H1, ['alice', 'bob'], 'human');
  assert.equal(L(r, R.readAll()), 'push');
  answer('alice', 'signoff', H1);
  assert.equal(L(r, R.readAll()), 'pull');
  // The proposer sees the decision on its own proposal (a notice), with no wake.
  fresh();
  prop('alice', H1, ['bob']);
  const d = sys('decision', { proposal_hash: H1 }, 'room');
  assert.equal(L(d, R.readAll()), 'pull');
  assert.equal(deliver(ALICE, d, { entries: R.readAll(), trust: room.trustOf }), 'notice');
});

test('lane: the room session reads nothing but another member\'s join (its rows turn): posts to claude, answers, decisions and tasks are none', () => {
  fresh();
  const L = (e: Entry, es?: readonly Entry[]) => roomLane(ROOM_CLAUDE, e, es);
  const mine = prop('claude', H1, ['alice', 'bob']);
  const theirs = prop('bob', H2, ['alice'], 'human');
  const words = human('alice', 'say');
  const toRoomClaude = human('bob', 'say', { text: 'let us plan cursor paging', to: 'claude' });
  const agentTo = agent('alice', 'question', { to: 'claude' });
  const mention = human('bob', 'say', { text: '@claude let us plan cursor paging' });
  const left = sys('member_left', {}, 'bob');
  const joined = sys('member_joined', {}, 'carol');                        // push (the tail adds the row note)
  const o1 = answer('bob', 'objection', H1, { text: 'clamp' });
  const dec = sys('decision', { proposal_hash: H1 }, 'room');
  const req = taskReq('bob', 'add', { subject: 'parser tests' });
  const t = task({ task_id: 2, owner: 'bob', status: 'pending', req: req.id });
  const ownJoin = sys('member_joined', {}, 'claude');
  const want: [Entry, Lane][] = [[mine, 'none'], [theirs, 'none'], [words, 'none'], [toRoomClaude, 'none'], [agentTo, 'none'], [mention, 'none'],
    [left, 'none'], [joined, 'push'], [o1, 'none'], [dec, 'none'], [req, 'none'], [t, 'none'], [ownJoin, 'none']];
  for (const [e, l] of want) assert.equal(L(e), l, `#${e.id} without entries`);
  for (const [e, l] of want) assert.equal(L(e, R.readAll()), l, `#${e.id} with entries`);
  // a member named in the text is still woken by it
  assert.equal(roomLane({ name: 'carol', role: 'member' }, human('bob', 'say', { text: 'ask @carol later' })), 'push');
});

test('lane (P3 wakes): every person\'s words reach every member (a group chat), card answers and quiet decisions', () => {
  const code = fresh();
  h.register('alice', 'member', process.pid, code);
  const BOB = { name: 'bob', role: 'member' };
  const atRoomClaude = human('bob', 'say', { text: 'let us plan cursor paging', to: 'claude' });
  const atBob = human('carol', 'say', { text: '@claude @bob take a look' });
  const plain = human('bob', 'say', { text: 'alice, can you take the parser tests?' });
  const email = human('bob', 'say', { text: 'mail ops@claude.example' });
  for (const [e, l] of [[atRoomClaude, 'push'], [atBob, 'push'], [plain, 'push'], [email, 'push']] as [Entry, Lane][]) assert.equal(roomLane(ALICE, e), l, `#${e.id}`);
  assert.equal(roomLane(BOB, atBob), 'push', 'bob is named');
  assert.equal(roomLane(ROOM_CLAUDE, atRoomClaude), 'none', 'the room session reads none of it');
  // Round 1: alice agrees, bob objects last; round 2: alice agrees, bob agrees last. The room's Claude proposed.
  prop('claude', H1, ['alice', 'bob']);
  const a1 = answer('alice', 'signoff', H1);
  const o1 = answer('bob', 'objection', H1, { text: 'clamp' });
  const d1 = sys('decision', { proposal_hash: H1, text: 'objected: bob · agreed: alice', refs: [a1.id, o1.id] }, 'room');
  prop('claude', H2, ['alice', 'bob']);
  const a2 = answer('alice', 'signoff', H2);
  const s2 = answer('bob', 'signoff', H2);
  const d2 = sys('decision', { proposal_hash: H2, text: 'agreed: alice, bob', refs: [a2.id, s2.id] }, 'room');
  const all = R.readAll();
  const L = (me: LaneViewer, e: Entry) => roomLane(me, e, all);
  assert.deepEqual([a1, o1, a2, s2].map(e => L(ALICE, e)), ['none', 'pull', 'none', 'pull'], 'answers never wake another approver');
  assert.deepEqual([a1, o1, a2, s2].map(e => L(ROOM_CLAUDE, e)), ['none', 'none', 'none', 'none'], 'the room session reads no answer');
  assert.equal(L(ALICE, d1), 'pull', 'an objected decision: nothing for a non-proposer');
  assert.equal(L(BOB, d1), 'pull', 'bob completed it (told by his card reply)');
  assert.equal(L(ROOM_CLAUDE, d1), 'none');
  assert.equal(L(ALICE, d2), 'pull', 'an agreed decision wakes no approver (README: only lines to you and sign-off requests wake)');
  assert.equal(L(BOB, d2), 'pull', 'bob completed it');
  assert.equal(L(ROOM_CLAUDE, d2), 'none', 'an agreed decision needs nothing from the room session');
  // A member's own proposal: an objected decision still reaches its author.
  prop('alice', 'cccccccccccc', ['bob']);
  const o3 = answer('bob', 'objection', 'cccccccccccc', { text: 'no' });
  const d3 = sys('decision', { proposal_hash: 'cccccccccccc', text: 'objected: bob', refs: [o3.id] }, 'room');
  const all3 = R.readAll();
  assert.equal(roomLane(ALICE, o3, all3), 'push', 'the objection wakes its author, to revise');
  assert.equal(roomLane(ALICE, d3, all3), 'pull', 'the decision after it does not');
});

test('deliver (live verify, P): what asks the person is a notice, not context only: a decision or another approver\'s objection on a proposal they are in', () => {
  const code = fresh();
  h.register('alice', 'member', process.pid, code);
  const BOB = { name: 'bob', role: 'member' };
  const CAROL = { name: 'carol', role: 'member' };
  const D = (me: LaneViewer, e: Entry, es?: readonly Entry[]) => deliver(me, e, { entries: es, trust: room.trustOf });
  const chatter = sys('status', { text: 'a machine (x) linked to the room with an invite and its PIN (link abcdef012345)' }, 'room');
  assert.equal(D(ALICE, chatter), 'context', 'chatter stays context');
  prop('claude', H1, ['alice', 'bob']);
  const a1 = answer('alice', 'signoff', H1);
  const o1 = answer('bob', 'objection', H1, { text: 'clamp' });
  const d1 = sys('decision', { proposal_hash: H1, text: 'objected: bob · agreed: alice', refs: [a1.id, o1.id] }, 'room');
  const all = R.readAll();
  assert.equal(D(ALICE, o1, all), 'notice', 'another approver\'s objection: alice sees it');
  assert.equal(D(ALICE, d1, all), 'notice', 'the decision on a proposal alice is in');
  assert.equal(D(BOB, d1, all), 'notice', 'bob completed it: shown, no wake');
  assert.equal(D(CAROL, d1, all), 'context', 'not in it: context');
  assert.equal(D(CAROL, o1, all), 'context');
});

test('deliver (room-plan live): a decision is a notice for every approver and context for the rest; it never wakes', () => {
  fresh();
  const BOB = { name: 'bob', role: 'member' };
  const CAROL = { name: 'carol', role: 'member' };
  const D = (me: LaneViewer, e: Entry, es?: readonly Entry[]) => deliver(me, e, { entries: es, trust: room.trustOf });
  prop('alice', H1, ['alice', 'bob']);
  const a = answer('alice', 'signoff', H1);
  const b = answer('bob', 'signoff', H1);
  const d = sys('decision', { proposal_hash: H1, text: 'room: plan paging v3 agreed', approvers: ['alice', 'bob'], refs: [a.id, b.id] }, 'room');
  const all = R.readAll();
  for (const me of [ALICE, BOB]) {
    assert.equal(D(me, d, all), 'notice', `${me.name}: shown, no wake`);
    assert.equal(D(me, d), 'notice', `${me.name}: without the log, still no wake`);
  }
  assert.equal(D(CAROL, d, all), 'context');
  assert.equal(D(ROOM_CLAUDE, d, all), 'none');
});

test('stateLine: open proposals, my answer, who is away', () => {
  const code = fresh();
  assert.equal(R.stateLine(ALICE), 'room now: no proposals');
  h.register('alice', 'member', process.pid, code);
  const bob = h.spawnSleeper();
  identity.join({ code, name: sn('bob'), role: 'member', pid: bob.pid, session_id: 's-b', cwd: '/tmp' });
  identity.leave(code, sn('bob'));
  prop('claude', H1, ['alice', 'bob']);
  assert.match(R.stateLine(ALICE), /^room now: proposal aaaaaa waiting on alice, bob · you: answer needed/);
  answer('alice', 'signoff', H1);
  assert.match(R.stateLine(ALICE), /^room now: proposal aaaaaa waiting on bob · you: agreed/);
  answer('bob', 'objection', H1, { text: 'no' });
  const d = sys('decision', { proposal_hash: H1 }, 'room');
  assert.equal(R.stateLine(ALICE), `room now: proposal aaaaaa decided #${d.id} · you: agreed · away: bob`);
  assert.doesNotMatch(R.stateLine({ name: 'carol', role: 'member' }), /you:/);
  bob.kill();
});
