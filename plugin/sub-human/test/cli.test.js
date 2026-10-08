'use strict';
// Tests for bin/sub-human. The CLI runs as a child of this test process, so it resolves to whatever is
// registered for process.pid (process ancestry), exactly as it resolves to claude in a real session.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const h = require('./helpers.js');
const room = require(path.join(h.LIB, 'room.js'));
let R = null; // the room under test
const identity = require(path.join(h.LIB, 'identity.js'));

// tail looks its seat up by CLAUDE_PID when it has no session id (no ps walk).
const FAST = { CLAUDE_PID: String(process.pid), SUB_HUMAN_RESOLVE_MS: '100', SUB_HUMAN_UNSEATED_MS: '100', SUB_HUMAN_POLL_MS: '50', SUB_HUMAN_SETTLE_MS: '300', SUB_HUMAN_SETTLE_MAX_MS: '1000', SUB_HUMAN_LEAVE_MS: '600' };
const children = new Set();
test.afterEach(() => { for (const c of children) c.kill(); children.clear(); });

function startTail(env = {}) {
  const child = spawn(h.BIN, ['tail', '/plugin/root', '/project/dir'], { env: h.childEnv({ ...FAST, ...env }) });
  children.add(child);
  const t = { child, out: '', exited: new Promise(r => child.on('exit', code => r(code))) };
  child.stdout.on('data', d => { t.out += d; });
  // one JSON event per line; lines(): what the batches show (each chat event's lines, then its wake's)
  t.events = () => t.out.split('\n').filter(Boolean).map(l => JSON.parse(l));
  t.of = type => t.events().filter(x => x.type === type);
  t.lines = () => t.events().flatMap(x => (x.type === 'chat' ? x.lines : x.type === 'wake' ? x.text.split('\n') : []));
  t.text = () => t.lines().map(l => l + '\n').join('');
  t.chat = () => t.lines().filter(l => !l.startsWith('(for Claude)'));
  t.forClaude = () => t.lines().filter(l => l.startsWith('(for Claude)'));
  t.entries = () => t.lines().filter(l => /^#\d+ /.test(l));
  t.ids = () => t.entries().map(l => Number(l.split(' ')[0].slice(1)));
  t.batches = () => t.lines().filter(l => l.startsWith('room now: ')).length;
  t.until = async (needle, ms = 5000) => {
    await h.until(() => t.text().includes(needle), ms);
    assert.ok(t.text().includes(needle), `tail never printed ${needle}; got:\n${t.out}`);
  };
  t.stop = async () => { child.kill(); await t.exited; children.delete(child); };
  return t;
}
const cli = (args, env = {}) => spawnSync(h.BIN, args, { env: h.childEnv(env), encoding: 'utf8' });
const say = (from, text, extra = {}, via = 'human') => R.append({ kind: 'say', text, ...extra }, { via, from });
const sys = (kind, from, extra = {}) => R.append({ kind, text: `${from} ${kind}`, ...extra }, { via: 'system', from, system: true });

const H1 = 'abcdef012345', H2 = 'bbbbbbbbbbbb';
const prop = (from, hash, approvers) => R.append({ kind: 'proposal', text: `${from} proposes`, hash, approvers }, { via: 'agent', from });

// The tail's batching, settle, leave hold, cursor restart, room switch and error recovery are tested
// in-process on a fake clock (test/tail.test.js). These are the real-time smoke tests of the binary.
test('cli tail (smoke): silent before join, then one settled block; resumes from its cursor after a restart', async () => {
  h.freshHome();
  const code = h.newRoom();
  R = room.open(code);
  const a = startTail();
  say('bob', 'before alice joined');                     // #1
  await h.sleep(200);
  assert.equal(a.text(), '', 'silent until this session joins');
  h.register('alice', 'member', process.pid, code);
  sys('member_joined', 'alice');                         // #2 own: none
  say('bob', 'bob says hi');                             // #3
  R.append({ kind: 'question', text: 'q for alice', to: 'alice' }, { via: 'agent', from: 'bob' }); // #4
  await a.until("bob's Claude (to you): q for alice\n");
  assert.deepEqual(a.lines(), ['bob: bob says hi', "bob's Claude (to you): q for alice"], a.out);
  assert.deepEqual([a.of('chat').length, a.of('wake').length], [1, 1], 'one burst: one chat, one wake');
  // The cursor is saved once stdout drained; stopping before then replays #4 (at-least-once), so wait for it.
  assert.equal(await h.until(() => R.getCursor('deliver-alice') === 4, 3000), true, 'the cursor reached #4');
  await a.stop();
  say('bob', 'posted in the gap');                       // #5: nobody is watching
  const b = startTail();
  await b.until('bob: posted in the gap\n');
  assert.deepEqual(b.lines(), ['bob: posted in the gap'], b.out);
  await b.stop();
  // --max-seconds exits cleanly.
  const c = spawn(h.BIN, ['tail', '--max-seconds', '1'], { env: h.childEnv(FAST) });
  children.add(c);
  assert.equal(await new Promise(r => c.on('exit', r)), 0);
});

test('cli tail --ndjson (smoke): by session id, one JSON event per line; SIGTERM exits cleanly', async () => {
  h.freshHome();
  const code = h.newRoom();
  R = room.open(code);
  h.register('alice', 'member', process.pid, code); // session id sess-alice-<pid>
  sys('member_joined', 'alice');                         // #1
  const child = spawn(h.BIN, ['tail', '--ndjson'], { env: h.childEnv({ ...FAST, CLAUDE_PID: '', CLAUDE_CODE_SESSION_ID: `sess-alice-${process.pid}` }) });
  children.add(child);
  let out = '';
  child.stdout.on('data', d => { out += d; });
  const exited = new Promise(r => child.on('exit', (code_, sig) => r(code_ ?? sig)));
  await h.until(() => out.includes('"type":"seat"'), 5000);
  say('bob', 'hi alice');                                // #2
  await h.until(() => out.includes('"type":"chat"'), 5000);
  const events = out.split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.deepEqual(events.find(x => x.type === 'chat').lines, ['bob: hi alice'], out);
  assert.equal(events.find(x => x.type === 'seat').seat.addr, `alice.${code}`);
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
});

test('cli tail: while unseated it never runs ps and looks the seat up only every SUB_HUMAN_UNSEATED_MS', async () => {
  h.freshHome();
  const code = h.newRoom();
  R = room.open(code);
  const fs = require('node:fs');
  const os = require('node:os');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-human-ps-'));
  const marker = path.join(bin, 'ps-ran');
  // Only the ancestry walk (`ps -A`) counts: once seated, the seat's start-time check may run `ps -p PID` once.
  fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\ncase " $* " in *" -A "*) echo x >> "${marker}";; esac\nexec /bin/ps "$@"\n`, { mode: 0o755 });
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
  R = room.open(code);
  say('bob', 'line one\n  line `two` $(x)');
  say('bob', 'second');
  r = cli(['read', '--id', '2,1']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.indexOf('#2') < r.stdout.indexOf('#1'));
  assert.ok(r.stdout.includes('  │ line one\n  │   line `two` $(x)'), 'every text line nested under the header');
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
  assert.match(cli(['nope']).stderr, /usage: sub-human tail \| read .*tasks \[--json\] \| watch NAME \| serve --stdio CODE \| agent-statusline$/m);
  for (const gone of ['plan', 'statusline']) assert.equal(cli([gone]).status, 2, `${gone} is dropped`);
  bob.kill();
});

// ---------- tasks / watch NAME ----------
test('cli tasks: the room list from lib/tasks.js list(code), plain and --json', () => {
  h.freshHome();
  const { code } = h.register('alice');
  R = room.open(code);
  let r = cli(['tasks']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `(no tasks in room ${code})\n`);
  const list = [
    { id: '2', subject: 'parser   tests', status: 'in_progress', owner: 'bob', blockedBy: [] },
    { id: '3', subject: 'docs', status: 'pending', owner: null, blockedBy: ['2'] },
    { id: '1', subject: `room ${code} open`, status: 'in_progress', owner: 'room', metadata: { _internal: true } },
  ];
  require('node:fs').writeFileSync(path.join(R.store.dir, 'tasks.json'), JSON.stringify(list));
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
  R = room.open(code);
  const H = 'abcdef012345';
  sys('member_joined', 'bob');                                                           // #1 shown
  say('bob', 'I want cursor paging');                                                     // #2 shown
  R.append({ kind: 'status', text: 'bob claude proposes' }, { via: 'agent', from: 'bob' }); // #3 shown
  say('alice', 'alice talks to the room');                                                // #4 hidden
  R.append({ kind: 'question', text: 'alice claude asks carol', to: 'carol' }, { via: 'agent', from: 'alice' }); // #5 hidden
  R.append({ kind: 'question', text: 'bob, cursor or offset?', to: 'bob' }, { via: 'agent', from: 'orch' }); // #6 shown
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

