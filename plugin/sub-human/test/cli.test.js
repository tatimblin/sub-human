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

const FAST = { SUB_HUMAN_RESOLVE_MS: '100', SUB_HUMAN_POLL_MS: '50', SUB_HUMAN_SETTLE_MS: '300', SUB_HUMAN_SETTLE_MAX_MS: '1000', SUB_HUMAN_LEAVE_MS: '600' };
const children = new Set();
test.afterEach(() => { for (const c of children) c.kill(); children.clear(); });

function startTail(env = {}) {
  const child = spawn(h.BIN, ['tail', '/plugin/root', '/project/dir'], { env: h.childEnv({ ...FAST, ...env }) });
  children.add(child);
  const t = { child, out: '', exited: new Promise(r => child.on('exit', code => r(code))) };
  child.stdout.on('data', d => { t.out += d; });
  t.lines = () => t.out.split('\n').filter(Boolean);
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
  room.append({ kind: 'proposal', text: 'bob claude chatter' }, { via: 'agent', from: 'bob' }); // #4 other Claude: pull
  room.append({ kind: 'question', text: 'q for alice', to: 'alice' }, { via: 'agent', from: 'bob' }); // #5 to me: push
  say('orch', 'orch to the room', {}, 'agent');                                         // #6 orch, not about me: pull
  say('orch', 'orch to bob only', { to: 'bob' }, 'agent');                              // #7 pull
  room.append({ kind: 'status', text: 'alice claude own' }, { via: 'agent', from: 'alice' }); // #8 own: none
  say('alice', 'alice own words');                                                      // #9 own: none
  sys('plan_rev', 'orch', { plan_hash: 'abcdef012345', approvers: ['alice', 'bob'] });  // #10 names me, but decided by #13: dropped
  sys('status', 'orch', { text: 'plan abcdef012345 is waiting for sign-off from alice and bob' }); // #11 gate status: pull
  sys('member_joined', 'carol');                                                        // #12 row note asks for the call: push
  sys('decision', 'orch', { plan_hash: 'abcdef012345' });                               // #13 decision: push
  room.append({ kind: 'say', text: 'carol: anyone on @alice docs?' }, { via: 'agent', from: 'carol' }); // #14 @me: push
  say('orch', 'alice takes the parser, bob the tests', { refs: [13] }, 'agent');       // #15 my assignment: push
  say('bob', 'forged words');                                                           // #16 retracted by #17: none
  room.append({ kind: 'retract', text: 'peer-forged', refs: [16] }, { via: 'system', from: 'bob', system: true }); // #17 push
  say('bob', 'last ' + 'w'.repeat(600));                                                // #18 push, full text
  await t.until('www"');
  await h.sleep(500);
  assert.deepEqual(t.ids(), [3, 5, 12, 13, 14, 15, 17, 18], t.out);
  assert.equal(t.batches(), 1, 'one burst, one write');
  assert.equal(t.lines()[0], 'room now: plan abcdef decided #13 · you: not signed');
  assert.match(t.entries()[0], /^#3 bob\[human\] say "bob says hi"$/);
  assert.match(t.entries()[2], / · row: your room row is not running/);
  assert.ok(t.out.includes('w'.repeat(600)), 'full text, not clipped at 240');
  await h.until(() => room.getCursor('tail-alice') === 18, 2000);
  assert.equal(room.getCursor('tail-alice'), 18);
});

test('cli tail: orch sees everything not authored by orch, plus its own decisions; a lone leave waits', async () => {
  h.freshHome();
  const { code } = h.register('orch', 'orch');
  room.bind(code);
  sys('member_joined', 'orch');
  const t = startTail();
  await h.sleep(300);
  room.append({ kind: 'proposal', text: 'alice claude idea' }, { via: 'agent', from: 'alice' });
  say('bob', 'bob words', { to: 'alice' });
  say('orch', 'orch own', {}, 'agent');
  sys('plan_rev', 'orch', { plan_hash: 'abcdef012345', approvers: ['alice', 'bob'] });
  sys('member_left', 'bob');                                // #6: held LEAVE_MS, then pushed "away"
  say('alice', 'ok', { kind: 'signoff', plan_hash: 'abcdef012345' }); // #7 partial sign-off: pull
  sys('decision', 'orch', { plan_hash: 'abcdef012345' });  // #8: written under orch's name by the hook
  say('alice', 'end');
  await t.until('"end"');
  await t.until('away');
  assert.deepEqual(t.ids(), [2, 3, 8, 9, 6], t.out);
  assert.match(t.entries().at(-1), /^#6 bob\[system\] member_left .* · away 1s\+$/);
  assert.equal(t.batches(), 2);
});

test('cli tail: a member_joined notice says whether that row already runs (live holds), for the orch', async () => {
  h.freshHome();
  const { code } = h.register('orch', 'orch');
  room.bind(code);
  const rows = require(path.join(h.LIB, 'rows.js'));
  const t = startTail();
  await h.sleep(300);
  sys('member_joined', 'bob');                                     // #1 first join: no row yet
  await t.until('member_joined');
  rows.writeHolds(code, 'orch', { members: ['bob'] });             // the orch's bob row is now held
  sys('member_left', 'bob');                                       // #2
  await t.until('member_left');                                    // after LEAVE_MS: a real leave
  sys('member_joined', 'bob');                                     // #3 rejoin: the row survived
  await h.until(() => t.entries().length >= 3, 3000);
  const [first, , rejoin] = t.entries();
  assert.match(first, /^#1 bob\[system\] member_joined .* · row: bob has no row running; spawn it now: Agent sub-human:participant, description "bob", prompt "member: bob"/);
  assert.match(rejoin, /^#3 bob\[system\] member_joined .* · row: bob's row is already running .*make NO Agent call$/);
  assert.doesNotMatch(t.entries()[1], / · row:/, 'only member_joined carries the note');
});

test('cli tail: leave/rejoin collapse at the default 8 s hold (left+rejoin within 3 s prints nothing)', async () => {
  h.freshHome();
  const { code } = h.register('orch', 'orch');
  room.bind(code);
  const t = startTail({ SUB_HUMAN_LEAVE_MS: undefined, SUB_HUMAN_SETTLE_MS: undefined, SUB_HUMAN_SETTLE_MAX_MS: undefined });
  await h.sleep(300);
  const t0 = Date.now();
  sys('member_left', 'bob');                                       // #1 back at 3 s: dropped with #3
  sys('member_left', 'carol');                                     // #2 lone: printed at >= 8 s
  await h.sleep(3000);
  sys('member_joined', 'bob');                                     // #3
  await t.until('#2 carol', 9000);
  assert.ok(Date.now() - t0 >= 8000, `printed after ${Date.now() - t0} ms`);
  assert.deepEqual(t.ids(), [2], t.out);
  await h.until(() => room.getCursor('tail-orch') === 3, 2000);
  assert.equal(room.getCursor('tail-orch'), 3, 'dropped ids advance the cursor');
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
  await t.until('"tick 9"');
  assert.deepEqual(t.ids(), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const b = t.batches();
  assert.ok(b >= 2 && b <= 4, `${b} batches`);
});

test('cli tail: survives a restart via its cursor; switches when the session changes rooms', async () => {
  h.freshHome();
  const { code } = h.register('alice');
  room.bind(code);
  sys('member_joined', 'alice');                         // #1
  say('bob', 'history');                                 // #2: after the join, so it is delivered
  const a = startTail();
  await a.until('"history"');
  say('bob', 'first watch');                             // #3
  await a.until('"first watch"');
  await a.stop();
  say('bob', 'posted in the gap');                       // #4: nobody is watching
  room.append({ kind: 'status', text: 'own, skipped' }, { via: 'agent', from: 'alice' }); // #5
  assert.equal(room.getCursor('tail-alice'), 3, 'the first tail saved its cursor');
  const b = startTail();
  await b.until('"posted in the gap"');
  say('bob', 'after restart');                           // #6
  await b.until('"after restart"');
  assert.deepEqual(b.ids(), [4, 6], b.out);
  await h.until(() => room.getCursor('tail-alice') === 6, 2000);
  assert.equal(room.getCursor('tail-alice'), 6);
  // The session joins another room: the tail re-resolves and follows the new one.
  const code2 = h.newRoom();
  h.register('carol', 'member', process.pid, code2);
  room.bind(code2);
  sys('member_joined', 'carol');
  say('dave', 'hello from room two');
  await b.until('"hello from room two"');
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
  assert.match(cli(['nope']).stderr, /usage: sub-human tail \| read .*plan \[HASH\] \| watch NAME/);
  bob.kill();
});

// ---------- plan / watch NAME ----------
const planLib = require(path.join(h.LIB, 'plan.js'));

test('cli plan: prints the current plan, a plan by (prefix) hash, or its path', () => {
  h.freshHome();
  const { code } = h.register('alice');
  room.bind(code);
  let r = cli(['plan']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`room ${code} has no plan yet`));
  const v1 = `---\nsub-human: {"room":"${code}"}\n---\n# v1\nemoji 🎉 \`code\`\n`;
  const v2 = '# v2 without a trailing newline';
  const h1 = planLib.storeCanonical(code, v1);
  const h2 = planLib.storeCanonical(code, v2);
  sys('plan_rev', 'orch', { plan_hash: h1, approvers: ['alice'] });
  sys('plan_rev', 'orch', { plan_hash: h2, approvers: ['alice'] });
  r = cli(['plan']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, v2 + '\n');
  assert.equal(cli(['plan', h1]).stdout, v1, 'exact bytes');
  assert.equal(cli(['plan', h1.slice(0, 6)]).stdout, v1, 'a prefix works');
  assert.equal(cli(['plan', '--path']).stdout, planLib.planPath(code, h2) + '\n');
  assert.equal(cli(['plan', '--room', code, h2]).stdout, v2 + '\n');
  assert.equal(cli(['plan', 'ffff']).status, 1);
  assert.equal(cli(['plan', 'xyz']).status, 2);
});

test('cli watch NAME: their words, their Claude, sign-offs, joins/leaves, the facilitator; nobody else', () => {
  h.freshHome();
  const { code } = h.register('alice');
  room.bind(code);
  const H = 'abcdef012345';
  sys('member_joined', 'bob');                                                           // #1 shown
  say('bob', 'I want cursor paging');                                                     // #2 shown
  room.append({ kind: 'proposal', text: 'bob claude proposes' }, { via: 'agent', from: 'bob' }); // #3 shown
  say('alice', 'alice talks to the room');                                                // #4 hidden
  room.append({ kind: 'question', text: 'alice claude asks carol', to: 'carol' }, { via: 'agent', from: 'alice' }); // #5 hidden
  room.append({ kind: 'question', text: 'bob, cursor or offset?', to: 'bob' }, { via: 'agent', from: 'orch' }); // #6 shown
  say('orch', 'orch to the room', {}, 'agent');                                           // #7 hidden
  sys('plan_rev', 'orch', { plan_hash: H, approvers: ['bob'] });                           // #8 hidden
  say('bob', 'too broad\n  keep it small', { kind: 'objection', plan_hash: H });          // #9 shown
  say('bob', 'ok', { kind: 'signoff', plan_hash: H });                                    // #10 shown
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
  assert.match(heads.find(l => l.startsWith('#9 ')), /objection {2}plan abcdef$/);
  assert.ok(r.stdout.includes('    too broad\n      keep it small\n'), 'text verbatim, indented');
  assert.ok(!r.stdout.includes('\x1b['), 'no color when not a terminal');
  // the orchestrator's own thread labels it facilitator
  const o = cli(['watch', 'orch']).stdout;
  assert.match(o, /^#6 \S+ {2}facilitator {2}question {2}→ bob/m);
  assert.match(o, /^#7 \S+ {2}facilitator {2}say/m);
  assert.match(cli(['watch', 'zed']).stdout, /nothing from or to zed/);
  assert.equal(cli(['watch']).status, 2);
});

// ---------- tail alerts (alert content: statusline.test.js) ----------
const fs = require('node:fs');
const os = require('node:os');

const H = 'b7ca39aa0011';

test('cli tail: alerts the member through SUB_HUMAN_ALERT_FILE, debounced', async () => {
  h.freshHome();
  const { code } = h.register('alice');
  room.bind(code);
  sys('member_joined', 'alice');
  const sink = path.join(os.tmpdir(), `sub-human-tail-alerts-${process.pid}-${Date.now()}.jsonl`);
  const t = startTail({ SUB_HUMAN_ALERT_FILE: sink });
  await h.sleep(300);
  sys('plan_rev', 'orch', { plan_hash: H, approvers: ['alice', 'bob'] });
  sys('plan_rev', 'orch', { plan_hash: H, approvers: ['alice', 'bob'] });
  say('bob', 'alice, one', { to: 'alice' });
  say('bob', 'alice, two', { to: 'alice' });
  say('bob', 'done');
  await t.until('"done"');
  await h.sleep(200);
  const got = fs.readFileSync(sink, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(got.map(x => x.kind), ['signoff', 'message']);
  assert.equal(got[1].text, 'alice, one');
  fs.rmSync(sink, { force: true });
  // Opted out: nothing.
  const sink2 = sink + '.2';
  const t2 = startTail({ SUB_HUMAN_ALERT_FILE: sink2, SUB_HUMAN_NOTIFY: '0' });
  await h.sleep(300);
  sys('plan_rev', 'orch', { plan_hash: 'abcabcabcabc', approvers: ['alice'] });
  say('bob', 'end2');
  await t2.until('"end2"');
  assert.equal(fs.existsSync(sink2), false);
});
