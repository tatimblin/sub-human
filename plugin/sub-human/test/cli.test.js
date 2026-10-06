'use strict';
// Tests for bin/sub-human. The CLI runs as a child of this test process, so it resolves to whatever is
// registered for process.pid (process ancestry), exactly as it resolves to claude in a real session.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const h = require('./helpers.js');
const room = require(path.join(h.LIB, 'room.js'));
const identity = require(path.join(h.LIB, 'identity.js'));

// CLAUDE_PID is set for monitors; tail looks its seat up by it (no ps walk).
const FAST = { CLAUDE_PID: String(process.pid), SUB_HUMAN_RESOLVE_MS: '100', SUB_HUMAN_UNSEATED_MS: '100', SUB_HUMAN_POLL_MS: '50', SUB_HUMAN_SETTLE_MS: '300', SUB_HUMAN_SETTLE_MAX_MS: '1000', SUB_HUMAN_LEAVE_MS: '600' };
const children = new Set();
test.afterEach(() => { for (const c of children) c.kill(); children.clear(); });

function startTail(env = {}) {
  const child = spawn(h.BIN, ['tail', '/plugin/root', '/project/dir'], { env: h.childEnv({ ...FAST, ...env }) });
  children.add(child);
  const t = { child, out: '', exited: new Promise(r => child.on('exit', code => r(code))) };
  t.writes = 0;
  child.stdout.on('data', d => { t.out += d; t.writes++; });
  t.lines = () => t.out.split('\n').filter(Boolean);
  t.chat = () => t.lines().filter(l => !l.startsWith('(for Claude)'));
  t.forClaude = () => t.lines().filter(l => l.startsWith('(for Claude)'));
  t.entries = () => t.lines().filter(l => /^#\d+ /.test(l));
  t.ids = () => t.entries().map(l => Number(l.split(' ')[0].slice(1)));
  t.batches = () => t.lines().filter(l => l.startsWith('room now: ')).length;
  t.until = async (needle, ms = 5000) => {
    await h.until(() => t.out.includes(needle), ms);
    assert.ok(t.out.includes(needle), `tail never printed ${needle}; got:\n${t.out}`);
  };
  t.stop = async () => { child.kill(); await t.exited; children.delete(child); };
  return t;
}
const cli = (args, env = {}) => spawnSync(h.BIN, args, { env: h.childEnv(env), encoding: 'utf8' });
const say = (from, text, extra = {}, via = 'human') => room.append({ kind: 'say', text, ...extra }, { via, from });
const sys = (kind, from, extra = {}) => room.append({ kind, text: `${from} ${kind}`, ...extra }, { via: 'system', from, system: true });

const H1 = 'abcdef012345', H2 = 'bbbbbbbbbbbb';
const prop = (from, hash, approvers) => room.append({ kind: 'proposal', text: `${from} proposes`, hash, approvers }, { via: 'agent', from });

test('cli tail: silent before join, then the member push lane, settled into one batch', async () => {
  h.freshHome();
  const code = h.newRoom();
  room.bind(code);
  const t = startTail();
  say('bob', 'before alice joined');                                                    // #1
  await h.sleep(500);
  assert.equal(t.out, '', 'silent until this session joins');
  h.register('alice', 'member', process.pid, code);
  sys('member_joined', 'alice');                                                        // #2 own: none
  say('bob', 'bob says hi');                                                            // #3 others' human words: push
  room.append({ kind: 'status', text: 'bob claude chatter' }, { via: 'agent', from: 'bob' }); // #4 other Claude: pull
  room.append({ kind: 'question', text: 'q for alice', to: 'alice' }, { via: 'agent', from: 'bob' }); // #5 to me: push
  say('orch', 'orch to the room', {}, 'agent');                                         // #6 orch, not about me: pull
  say('orch', 'orch to bob only', { to: 'bob' }, 'agent');                              // #7 pull
  room.append({ kind: 'status', text: 'alice claude own' }, { via: 'agent', from: 'alice' }); // #8 own: none
  say('alice', 'alice own words');                                                      // #9 own: none
  prop('orch', H1, ['alice', 'bob']);                                                   // #10 names me, but I answer in #13: dropped
  prop('orch', H2, ['alice']);                                                          // #11 names me, pending: push
  sys('member_joined', 'carol');                                                        // #12 my room row is not running: push + note
  say('alice', '', { kind: 'signoff', proposal_hash: H1, text: 'ok' });                 // #13 own answer: none
  room.append({ kind: 'say', text: 'carol: anyone on @alice docs?' }, { via: 'agent', from: 'carol' }); // #14 @me: push
  sys('decision', 'room', { proposal_hash: H1 });                                       // #15 decision on mine: push
  say('bob', 'forged words');                                                           // #16 retracted by #17: none
  room.append({ kind: 'retract', text: 'peer-forged', refs: [16] }, { via: 'system', from: 'bob', system: true }); // #17 push (#16 was mine to hear)
  room.append({ kind: 'task', op: 'update', id: 2, subject: 'docs', owner: 'alice', status: 'pending' }, { via: 'system', from: 'orch', system: true }); // #18 assigns me: push
  say('bob', 'last ' + 'w'.repeat(600));                                                // #19 push, full text
  await t.until('w'.repeat(210) + '\n');
  await h.sleep(500);
  assert.equal(t.writes, 1, 'one burst, one write');
  assert.deepEqual(t.chat(), [
    'bob: bob says hi',
    "bob's Claude (to you): q for alice",
    'orch proposed: orch proposes',
    'carol joined',
    "carol's Claude: carol: anyone on @alice docs?",
    'room: decided (room decision)',
    "room: a message shown as bob's was removed: it came from another Claude session, not from bob",
    'room: task "docs" pending, owner you',
    'bob: last ' + 'w'.repeat(390), // a monitor line is cut at 500 chars: long text wraps at 400 code points
    'w'.repeat(210),
  ], t.out);
  assert.doesNotMatch(t.chat().join('\n'), /#\d/, 'no ids in what the human sees');
  assert.deepEqual(t.forClaude().map(l => l.slice(0, 40)), ['(for Claude) room now: proposal bbbbbb w', '(for Claude) row: your room row is not r']);
  assert.ok(t.forClaude()[0].startsWith(`(for Claude) room now: proposal ${H2.slice(0, 6)} waiting on alice · you: answer needed (`), t.forClaude()[0]);
  assert.ok(t.forClaude()[0].includes(`"proposal ${H2}"`), 'the card call carries the full hash');
  await h.until(() => room.getCursor('tail-alice') === 19, 2000);
  assert.equal(room.getCursor('tail-alice'), 19);
  const notices = require(path.join(h.LIB, 'notices.js'));
  assert.ok(notices.shown(code, 'alice').has(12), 'the join is recorded as shown (at-room.js does not repeat it)');
});

test('cli tail: a member sees every join as a chat line; with its room row running, no row-call invite', async () => {
  h.freshHome();
  const { code } = h.register('alice');
  room.bind(code);
  const rows = require(path.join(h.LIB, 'rows.js'));
  rows.writeHolds(code, 'alice', { room: true });
  sys('member_joined', 'alice');                         // #1
  const t = startTail();
  await h.sleep(300);
  sys('member_joined', 'bob');                           // #2 the room row nests bob by itself: a chat line only
  say('bob', 'hi');                                      // #3
  await t.until('bob: hi\n');
  assert.deepEqual(t.lines(), ['bob joined', 'bob: hi'], t.out);
  assert.doesNotMatch(t.out, /Agent|row:/);
});

test('cli tail: orch push is to/@orch, objections on its proposals, task_req (not decisions)', async () => {
  h.freshHome();
  const { code } = h.register('orch', 'orch');
  room.bind(code);
  sys('member_joined', 'orch');
  const t = startTail();
  await h.sleep(300);
  room.append({ kind: 'status', text: 'alice claude idea' }, { via: 'agent', from: 'alice' }); // #2 pull
  say('bob', 'bob words', { to: 'alice' });                                                    // #3 pull
  say('orch', 'orch own', {}, 'agent');                                                        // #4 none
  prop('orch', H1, ['alice', 'bob']);                                                          // #5 own: none
  sys('member_left', 'bob');                                                                   // #6 pull
  say('alice', '', { kind: 'objection', proposal_hash: H1, text: 'no' });                      // #7 objection on its proposal: push
  room.append({ kind: 'task_req', op: 'add', subject: 'parser tests' }, { via: 'agent', from: 'bob' }); // #8 push
  sys('decision', 'room', { proposal_hash: H1 });                                              // #9 pull
  say('alice', '@orch end');                                                                   // #10 push
  await t.until('"@orch end"');
  await h.sleep(400);
  assert.deepEqual(t.ids(), [7, 8, 10], t.out);
  assert.equal(t.batches(), 1);
});

test('cli tail: a member_joined notice says whether that row already runs (live holds), for the orch', async () => {
  h.freshHome();
  const { code } = h.register('orch', 'orch');
  room.bind(code);
  const rows = require(path.join(h.LIB, 'rows.js'));
  const t = startTail();
  await h.sleep(300);
  sys('member_joined', 'bob');                                     // #1 first join: no row yet, pushed with the call
  await t.until('member_joined');
  rows.writeHolds(code, 'orch', { members: ['bob'] });             // the orch's bob row is now held
  sys('member_left', 'bob');                                       // #2 pull
  sys('member_joined', 'bob');                                     // #3 rejoin: the row survived, not pushed
  say('bob', '@orch back');                                        // #4
  await t.until('"@orch back"');
  assert.deepEqual(t.ids(), [1, 4], t.out);
  assert.match(t.entries()[0], /^#1 bob\[system\] member_joined .* · row: bob has no row running; spawn it now: Agent sub-human:participant, description "bob", prompt "member: bob"/);
  assert.doesNotMatch(t.entries()[1], / · row:/, 'only member_joined carries the note');
});

test('cli tail: while unseated it never runs ps and looks the seat up only every SUB_HUMAN_UNSEATED_MS', async () => {
  h.freshHome();
  const code = h.newRoom();
  room.bind(code);
  const fs = require('node:fs');
  const os = require('node:os');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-human-ps-'));
  const marker = path.join(bin, 'ps-ran');
  fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\necho x >> "${marker}"\nexec /bin/ps "$@"\n`, { mode: 0o755 });
  const t0 = Date.now();
  const t = startTail({ PATH: `${bin}:${process.env.PATH}`, SUB_HUMAN_UNSEATED_MS: '1500' });
  await h.sleep(200);
  h.register('alice', 'member', process.pid, code);
  sys('member_joined', 'alice');
  say('bob', 'hello');
  await t.until('bob: hello', 5000);
  assert.ok(Date.now() - t0 >= 1500, `seated after ${Date.now() - t0} ms, before the unseated interval`);
  assert.ok(!fs.existsSync(marker), 'no ps walk with CLAUDE_PID set');
});

test('cli tail: leave/rejoin collapse at the default 8 s hold (left+rejoin within 3 s prints nothing)', async () => {
  h.freshHome();
  const { code } = h.register('orch', 'orch');
  room.bind(code);
  const t = startTail({ SUB_HUMAN_LEAVE_MS: undefined, SUB_HUMAN_SETTLE_MS: undefined, SUB_HUMAN_SETTLE_MAX_MS: undefined, SUB_HUMAN_ORCH_SETTLE_MS: '1500' });
  await h.sleep(300);
  const t0 = Date.now();
  // member_left is pull in the Phase 2 lanes; addressing it to the orch makes it push, to exercise the hold.
  sys('member_left', 'bob', { to: 'orch' });                       // #1 back at 3 s: dropped with #3
  sys('member_left', 'carol', { to: 'orch' });                     // #2 lone: printed at >= 8 s
  await h.sleep(3000);
  sys('member_joined', 'bob');                                     // #3
  await t.until('#2 carol', 9000);
  assert.ok(Date.now() - t0 >= 8000, `printed after ${Date.now() - t0} ms`);
  assert.deepEqual(t.ids(), [2], t.out);
  await h.until(() => room.getCursor('tail-orch') === 3, 2000);
  assert.equal(room.getCursor('tail-orch'), 3, 'dropped ids advance the cursor');
});

test('cli tail: the orch settles longer by default (two pushes 2 s apart are one batch)', async () => {
  h.freshHome();
  const { code } = h.register('orch', 'orch');
  room.bind(code);
  sys('member_joined', 'orch');
  const t = startTail({ SUB_HUMAN_SETTLE_MS: undefined, SUB_HUMAN_SETTLE_MAX_MS: undefined });
  await h.sleep(300);
  say('alice', '@orch default 20, max 50');                       // #2
  await h.sleep(2000);
  say('bob', '@orch fine, please propose it');                    // #3
  await t.until('#3 bob', 8000);
  await h.sleep(300);
  assert.deepEqual(t.ids(), [2, 3], t.out);
  assert.equal(t.batches(), 1, t.out);
});

test('cli tail: a steady trickle is cut into batches at the settle max; held ids keep the cursor back', async () => {
  h.freshHome();
  const { code } = h.register('alice');
  room.bind(code);
  sys('member_joined', 'alice');                                  // #1
  const t = startTail({ SUB_HUMAN_SETTLE_MS: '400', SUB_HUMAN_SETTLE_MAX_MS: '900' });
  await h.sleep(300);
  for (let i = 0; i < 10; i++) { say('bob', `tick ${i}`); await h.sleep(200); }
  assert.ok(room.getCursor('tail-alice') < 11, 'buffered ids are not past the cursor yet');
  await t.until('bob: tick 9\n');
  assert.deepEqual(t.lines(), Array.from({ length: 10 }, (_, i) => `bob: tick ${i}`));
  const b = t.writes;
  assert.ok(b >= 2 && b <= 4, `${b} batches`);
});

test('cli tail: survives a restart via its cursor; switches when the session changes rooms', async () => {
  h.freshHome();
  const { code } = h.register('alice');
  room.bind(code);
  sys('member_joined', 'alice');                         // #1
  say('bob', 'history');                                 // #2: after the join, so it is delivered
  const a = startTail();
  await a.until('bob: history');
  say('bob', 'first watch');                             // #3
  await a.until('bob: first watch');
  // The cursor is saved after stdout drains; stopping before then replays #3 (at-least-once), so wait.
  await h.until(() => room.getCursor('tail-alice') === 3, 2000);
  await a.stop();
  say('bob', 'posted in the gap');                       // #4: nobody is watching
  room.append({ kind: 'status', text: 'own, skipped' }, { via: 'agent', from: 'alice' }); // #5
  assert.equal(room.getCursor('tail-alice'), 3, 'the first tail saved its cursor');
  const b = startTail();
  await b.until('bob: posted in the gap');
  say('bob', 'after restart');                           // #6
  await b.until('bob: after restart');
  assert.deepEqual(b.lines(), ['bob: posted in the gap', 'bob: after restart'], b.out);
  await h.until(() => room.getCursor('tail-alice') === 6, 2000);
  assert.equal(room.getCursor('tail-alice'), 6);
  // The session joins another room: the tail re-resolves and follows the new one.
  const code2 = h.newRoom();
  h.register('carol', 'member', process.pid, code2);
  room.bind(code2);
  sys('member_joined', 'carol');
  say('dave', 'hello from room two');
  await b.until('dave: hello from room two');
  room.bind(code);
  say('bob', 'old room, no longer watched');
  await h.sleep(400);
  assert.ok(!b.out.includes('no longer watched'), b.out);
  // --max-seconds exits cleanly.
  const c = spawn(h.BIN, ['tail', '--max-seconds', '1'], { env: h.childEnv(FAST) });
  children.add(c);
  assert.equal(await new Promise(r => c.on('exit', r)), 0);
});

test('cli: who / read / digest resolve by session id, then ancestry', () => {
  h.freshHome();
  const code = h.newRoom();
  let r = cli(['who']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not in a room; run \/sub-human/);
  assert.equal(cli(['read']).status, 1);
  const bob = h.spawnSleeper();
  identity.join({ code, name: 'bob', role: 'member', pid: bob.pid, session_id: 'sbob' });
  h.register('alice', 'member', process.pid, code);
  r = cli(['who']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `alice (member) in ${code}\n`, 'nearest registered ancestor');
  r = cli(['who'], { CLAUDE_CODE_SESSION_ID: 'sbob' });
  assert.equal(r.stdout, `bob (member) in ${code}\n`, 'the session id wins');
  room.bind(code);
  say('bob', 'line one\n  line `two` $(x)');
  say('bob', 'second');
  r = cli(['read', '--id', '2,1']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.indexOf('#2') < r.stdout.indexOf('#1'));
  assert.ok(r.stdout.includes('line one\n  line `two` $(x)'));
  assert.ok(cli(['read', '2']).stdout.startsWith('[#2 '), 'a bare id works, as the cut marker says');
  r = cli(['read', '--json']);
  assert.deepEqual(r.stdout.trim().split('\n').map(l => JSON.parse(l).id), [1, 2]);
  assert.match(cli(['read']).stdout, /no new messages/);
  assert.equal(cli(['read', '--id', '99']).status, 1);
  r = cli(['digest']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ROOM DIGEST/);
  assert.match(r.stdout, /alice \(member\)/);
  assert.ok(r.stdout.length <= room.DIGEST_CAP + 1);
  assert.equal(cli(['digest', '--room', 'nope-0000']).status, 1);
  assert.equal(cli(['post', 'hello']).status, 2, 'there is no post command');
  assert.match(cli(['nope']).stderr, /usage: sub-human tail \| read .*tasks \[--json\] \| watch NAME \| agent-statusline$/m);
  for (const gone of ['plan', 'statusline']) assert.equal(cli([gone]).status, 2, `${gone} is dropped`);
  bob.kill();
});

// ---------- tasks / watch NAME ----------
test('cli tasks: the room list from lib/tasks.js list(code), plain and --json', () => {
  h.freshHome();
  const { code } = h.register('alice');
  room.bind(code);
  let r = cli(['tasks']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `(no tasks in room ${code})\n`);
  const list = [
    { id: '2', subject: 'parser   tests', status: 'in_progress', owner: 'bob', blockedBy: [] },
    { id: '3', subject: 'docs', status: 'pending', owner: null, blockedBy: ['2'] },
    { id: '1', subject: `room ${code} open`, status: 'in_progress', owner: 'room', metadata: { _internal: true } },
  ];
  require('node:fs').writeFileSync(path.join(room.dir(), 'tasks.json'), JSON.stringify(list));
  r = cli(['tasks']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '#2  in_progress  bob  parser tests\n#3  pending      -    docs  (blocked by #2)\n');
  r = cli(['tasks', '--json', '--room', code]);
  assert.deepEqual(JSON.parse(r.stdout).map(t => t.id), ['2', '3']);
  assert.equal(cli(['tasks', '--room', 'nope-0000']).status, 1);
});

test('cli watch NAME: their words, their Claude, sign-offs, joins/leaves, the facilitator; nobody else', () => {
  h.freshHome();
  const { code } = h.register('alice');
  room.bind(code);
  const H = 'abcdef012345';
  sys('member_joined', 'bob');                                                           // #1 shown
  say('bob', 'I want cursor paging');                                                     // #2 shown
  room.append({ kind: 'status', text: 'bob claude proposes' }, { via: 'agent', from: 'bob' }); // #3 shown
  say('alice', 'alice talks to the room');                                                // #4 hidden
  room.append({ kind: 'question', text: 'alice claude asks carol', to: 'carol' }, { via: 'agent', from: 'alice' }); // #5 hidden
  room.append({ kind: 'question', text: 'bob, cursor or offset?', to: 'bob' }, { via: 'agent', from: 'orch' }); // #6 shown
  say('orch', 'orch to the room', {}, 'agent');                                           // #7 hidden
  prop('alice', H, ['bob']);                                                              // #8 hidden
  say('bob', 'too broad\n  keep it small', { kind: 'objection', proposal_hash: H });      // #9 shown
  say('bob', 'ok', { kind: 'signoff', proposal_hash: H });                                // #10 shown
  sys('member_left', 'bob');                                                              // #11 shown
  const r = cli(['watch', 'bob']);
  assert.equal(r.status, 0, r.stderr);
  const heads = r.stdout.split('\n').filter(l => /^#\d+ /.test(l));
  assert.deepEqual(heads.map(l => Number(l.split(' ')[0].slice(1))), [1, 2, 3, 6, 9, 10, 11], r.stdout);
  const whoOf = id => heads.find(l => l.startsWith(`#${id} `)).split(/\s{2,}/)[1];
  assert.equal(whoOf(1), 'room');
  assert.equal(whoOf(2), 'bob');
  assert.equal(whoOf(3), "bob's Claude");
  assert.equal(whoOf(6), 'facilitator');
  assert.equal(whoOf(9), 'bob');
  assert.match(heads.find(l => l.startsWith('#9 ')), /objection {2}proposal abcdef$/);
  assert.ok(r.stdout.includes('    too broad\n      keep it small\n'), 'text verbatim, indented');
  assert.ok(!r.stdout.includes('\x1b['), 'no color when not a terminal');
  // the orchestrator's own thread labels it facilitator
  const o = cli(['watch', 'orch']).stdout;
  assert.match(o, /^#6 \S+ {2}facilitator {2}question {2}→ bob/m);
  assert.match(o, /^#7 \S+ {2}facilitator {2}say/m);
  assert.match(cli(['watch', 'zed']).stdout, /nothing from or to zed/);
  assert.equal(cli(['watch']).status, 2);
});

