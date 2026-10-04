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

const FAST = { SUB_HUMAN_RESOLVE_MS: '100', SUB_HUMAN_POLL_MS: '50' };
const children = new Set();
test.afterEach(() => { for (const c of children) c.kill(); children.clear(); });

function startTail(env = {}) {
  const child = spawn(h.BIN, ['tail', '/plugin/root', '/project/dir'], { env: h.childEnv({ ...FAST, ...env }) });
  children.add(child);
  const t = { child, out: '', exited: new Promise(r => child.on('exit', code => r(code))) };
  child.stdout.on('data', d => { t.out += d; });
  t.lines = () => t.out.split('\n').filter(Boolean);
  t.ids = () => t.lines().map(l => Number(l.split(' ')[0].slice(1)));
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

test('cli tail: silent before join, then the member filter', async () => {
  h.freshHome();
  const code = h.newRoom();
  room.bind(code);
  const t = startTail();
  say('bob', 'before alice joined');                                                    // #1
  await h.sleep(500);
  assert.equal(t.out, '', 'silent until this session joins');
  h.register('alice', 'member', process.pid, code);
  sys('member_joined', 'alice');                                                        // #2 own: hidden
  say('bob', 'bob says hi');                                                            // #3 human: shown
  room.append({ kind: 'proposal', text: 'bob claude chatter' }, { via: 'agent', from: 'bob' }); // #4 other Claude: hidden
  room.append({ kind: 'question', text: 'q for alice', to: 'alice' }, { via: 'agent', from: 'bob' }); // #5 to me: shown
  say('orch', 'orch to the room', {}, 'agent');                                         // #6 orch to room: shown
  say('orch', 'orch to bob only', { to: 'bob' }, 'agent');                              // #7 orch to bob: hidden
  room.append({ kind: 'status', text: 'alice claude own' }, { via: 'agent', from: 'alice' }); // #8 own: hidden
  say('alice', 'alice own words');                                                      // #9 own: hidden
  sys('plan_rev', 'orch', { plan_hash: 'abcdef012345', approvers: ['alice', 'bob'] });  // #10 system: shown
  sys('status', 'orch', { text: 'plan abcdef012345 is waiting for sign-off from alice and bob' }); // #11 shown
  sys('member_joined', 'carol');                                                        // #12 shown
  sys('decision', 'orch', { plan_hash: 'abcdef012345' });                               // #13 shown
  say('bob', 'last');                                                                   // #14 shown
  await t.until('"last"');
  await h.sleep(200);
  assert.deepEqual(t.ids(), [3, 5, 6, 10, 11, 12, 13, 14], t.out);
  for (const l of t.lines()) assert.ok(l.length <= 240);
  assert.match(t.lines()[0], /^#3 bob\[human\] say "bob says hi"$/);
  assert.equal(room.getCursor('tail-alice'), 14);
});

test('cli tail: orch sees everything not authored by orch, plus its own hook-written decisions', async () => {
  h.freshHome();
  const { code } = h.register('orch', 'orch');
  room.bind(code);
  sys('member_joined', 'orch');
  const t = startTail();
  await h.sleep(300);
  room.append({ kind: 'proposal', text: 'alice claude idea' }, { via: 'agent', from: 'alice' });
  say('bob', 'bob words', { to: 'alice' });
  say('orch', 'orch own', {}, 'agent');
  sys('plan_rev', 'orch', { plan_hash: 'abcdef012345', approvers: ['alice'] });
  sys('member_left', 'bob');
  sys('decision', 'orch', { plan_hash: 'abcdef012345' });  // #7: written under orch's name by the hook
  say('alice', 'end');
  await t.until('"end"');
  assert.deepEqual(t.ids(), [2, 3, 6, 7, 8], t.out);
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

test('cli: who / read / digest resolve by ancestry; a forged CLAUDE_PID never prints bob', () => {
  h.freshHome();
  const code = h.newRoom();
  let r = cli(['who']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not in a room; run \/sub-human/);
  assert.equal(cli(['read']).status, 1);
  const bob = h.spawnSleeper();
  identity.join({ code, name: 'bob', role: 'member', pid: bob.pid, session_id: 'sbob' });
  h.register('alice', 'member', process.pid, code);
  r = cli(['who'], { CLAUDE_PID: String(bob.pid) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `alice (member) in ${code}\n`);
  assert.ok(!r.stdout.includes('bob'));
  room.bind(code);
  say('bob', 'line one\n  line `two` $(x)');
  say('bob', 'second');
  r = cli(['read', '--id', '2,1']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.indexOf('#2') < r.stdout.indexOf('#1'));
  assert.ok(r.stdout.includes('line one\n  line `two` $(x)'));
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
  bob.kill();
});

// ---------- statusline / agent-statusline / alerts ----------
const fs = require('node:fs');
const os = require('node:os');
const segments = require(path.join(h.PLUGIN, 'statusline', 'segments.js'));
const { createAlerter } = require(path.join(h.PLUGIN, 'statusline', 'alert.js'));

const status = (input, env = {}, cmd = 'statusline') => spawnSync(h.BIN, [cmd],
  { env: h.childEnv({ NO_COLOR: '1', ...env }), encoding: 'utf8', input: typeof input === 'string' ? input : JSON.stringify(input) });
const H = 'b7ca39aa0011';

test('cli statusline: empty when not joined; member, approver, needed, objection, orch, decided; mail for me', () => {
  h.freshHome();
  // Not joined anywhere (and nobody registered): nothing at all, exit 0.
  let r = status({ session_id: 'nobody', cwd: '/tmp', model: { id: 'x', display_name: 'X' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  const code = h.newRoom();
  const seat = name => { const p = h.spawnSleeper(); identity.join({ code, name, role: name === 'orch' ? 'orch' : 'member', pid: p.pid, session_id: `sid-${name}` }); return p; };
  const sleepers = ['orch', 'alice', 'bob', 'carol'].map(seat);
  // Someone else's room: the test process is not registered, so a wrong session id prints nothing.
  assert.equal(status({ session_id: 'sid-nobody' }).stdout, '');
  const line = name => status({ session_id: `sid-${name}` }).stdout.replace(/\n$/, '');
  room.bind(code);
  assert.equal(line('alice'), `⬡ ${code} · alice`, 'no plan yet');
  sys('plan_rev', 'orch', { plan_hash: H, approvers: ['alice', 'bob'] });
  say('alice', 'ok', { plan_hash: H, kind: 'signoff' });
  assert.equal(line('alice'), `⬡ ${code} · alice · plan b7ca39 1/2 · approver`);
  assert.equal(line('bob'), `⬡ ${code} · bob · ⚠ your sign-off needed (plan b7ca39 1/2)`);
  assert.equal(line('carol'), `⬡ ${code} · carol · plan b7ca39 1/2`, 'not an approver: nothing extra');
  assert.equal(line('orch'), `⬡ ${code} · orch · plan b7ca39 1/2 waiting on bob`);
  // Anyone's objection blocks the gate, so everyone sees it; a later signoff from the same person clears it.
  say('carol', 'no', { kind: 'objection', plan_hash: H });
  assert.equal(line('alice'), `⬡ ${code} · alice · plan b7ca39 1/2 ✖ 1 objection · approver`);
  say('carol', 'fine now', { kind: 'signoff', plan_hash: H });
  assert.equal(line('carol'), `⬡ ${code} · carol · plan b7ca39 1/2`);
  // Color: the needed segment stands out.
  const colored = status({ session_id: 'sid-bob' }, { NO_COLOR: undefined }).stdout;
  assert.match(colored, /\x1b\[1;33m⚠ your sign-off needed\x1b\[0m/);
  // Entries addressed to me count until I next speak in the room.
  room.append({ kind: 'question', text: 'bob, cursor or offset?', to: 'bob' }, { via: 'agent', from: 'orch' });
  say('alice', 'bob?', { to: 'bob' });
  assert.match(line('bob'), / · ✉ 2 for you$/);
  say('bob', 'objecting', { kind: 'objection', plan_hash: H });
  assert.equal(line('bob'), `⬡ ${code} · bob · ⚠ your sign-off needed (plan b7ca39 1/2)`, 'my own post clears the mail count');
  say('bob', 'fine', { kind: 'signoff', plan_hash: H });
  sys('decision', 'orch', { plan_hash: H });
  assert.equal(line('bob'), `⬡ ${code} · bob · plan b7ca39 2/2 ✔ · approver`);
  assert.equal(line('orch'), `⬡ ${code} · orch · plan b7ca39 2/2 ✔`);
  // Garbage stdin never breaks the bar.
  assert.equal(status('not json').status, 0);
  for (const s of sleepers) s.kill();
});

test('cli statusline: falls back to process ancestry; agent-statusline decorates only room rows', () => {
  h.freshHome();
  const { code } = h.register('alice');
  room.bind(code);
  sys('plan_rev', 'orch', { plan_hash: H, approvers: ['alice'] });
  assert.equal(status({}).stdout, `⬡ ${code} · alice · ⚠ your sign-off needed (plan b7ca39 0/1)\n`);
  const tasks = [
    { id: 'a1', name: 'room', type: 'local_agent', description: 'whatever' },
    { id: 'a2', name: 'tests', type: 'local_agent', description: 'run tests' },
    { id: 'a3', type: 'local_agent', description: 'sub-human room feed' },
  ];
  const r = status({ session_id: 'unknown', columns: 120, tasks }, {}, 'agent-statusline');
  assert.equal(r.status, 0, r.stderr);
  const rows = r.stdout.trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(rows.map(x => x.id), ['a1', 'a3']);
  assert.equal(rows[0].content, `⬡ ${code} · ⚠ your sign-off needed (plan b7ca39 0/1)`);
  assert.equal(status({ tasks: [tasks[1]] }, {}, 'agent-statusline').stdout, '', 'no room rows: no output');
});

test('cli statusline: fast enough for a status bar', () => {
  h.freshHome();
  const { code } = h.register('alice');
  room.bind(code);
  sys('plan_rev', 'orch', { plan_hash: H, approvers: ['alice', 'bob'] });
  for (let i = 0; i < 300; i++) say('bob', `message ${i} `.repeat(10));
  // The derivation itself, on a 2,000-entry log.
  const entries = room.readAll();
  const big = Array.from({ length: 2000 }, (_, i) => ({ ...entries[i % entries.length], id: i + 1 }));
  let t = process.hrtime.bigint();
  segments.render(segments.state({ code, name: 'alice', role: 'member' }, big));
  assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < 50, 'state() under 50 ms');
  // The whole command, node startup included: best of 3, generous for loaded CI machines.
  const times = [];
  for (let i = 0; i < 3; i++) {
    t = process.hrtime.bigint();
    const r = status({ session_id: `sess-alice-${process.pid}` });
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
    assert.match(r.stdout, /alice/);
  }
  assert.ok(Math.min(...times) < 400, `statusline took ${times.map(Math.round).join(', ')} ms`);
});

test('alerts: sign-off once per plan hash, messages at most once per gap, history and orch never; opt-out', () => {
  h.freshHome();
  const code = h.newRoom();
  room.bind(code);
  const dir = room.dir();
  fs.mkdirSync(dir, { recursive: true });
  const sink = path.join(os.tmpdir(), `sub-human-alerts-${process.pid}-${Date.now()}.jsonl`);
  const read = () => { try { return fs.readFileSync(sink, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  let clock = Date.parse('2026-10-04T12:00:00Z');
  const at = () => new Date(clock).toISOString();
  const me = { code, name: 'alice', role: 'member' };
  let signed = false;
  const mk = (env = {}) => createAlerter({ me, dir, env: { SUB_HUMAN_ALERT_FILE: sink, ...env }, now: () => clock,
    lookup: () => ({ signedByMe: signed, decided: false }) });
  const a = mk();
  const rev = (hash, approvers = ['alice', 'bob']) => ({ id: 1, at: at(), from: 'orch', via: 'system', kind: 'plan_rev', plan_hash: hash, approvers, text: 'x' });
  const msg = (to, from = 'bob') => ({ id: 2, at: at(), from, via: 'human', kind: 'say', to, text: 'hey  alice\nlook' });
  assert.equal(a.onEntry(rev(H)), true);
  assert.equal(a.onEntry(rev(H)), false, 'same hash: no second alert');
  assert.equal(mk().onEntry(rev(H)), false, 'a restarted tail remembers the hash');
  assert.equal(a.onEntry(rev('cccccccccccc', ['bob'])), false, 'not an approver');
  signed = true;
  assert.equal(a.onEntry(rev('dddddddddddd')), false, 'already signed');
  signed = false;
  assert.equal(a.onEntry(msg('alice')), true);
  clock += 10_000;
  assert.equal(a.onEntry(msg('alice')), false, 'within 30 s');
  assert.equal(a.onEntry(msg('room')), false, 'not addressed to me');
  assert.equal(a.onEntry(msg('alice', 'alice')), false, 'my own');
  clock += 21_000;
  assert.equal(a.onEntry(msg('alice')), true, 'after 30 s');
  const old = { ...msg('alice'), at: new Date(clock - 11 * 60_000).toISOString() };
  clock += 31_000;
  assert.equal(a.onEntry(old), false, 'history never alerts');
  assert.equal(a.onEntry(rev('eeeeeeeeeeee')), true, 'a new plan hash alerts again');
  const got = read();
  assert.deepEqual(got.map(x => x.kind), ['signoff', 'message', 'message', 'signoff']);
  assert.match(got[0].title, new RegExp(`^${code}: your sign-off is needed$`));
  assert.equal(got[1].text, 'hey alice look');
  assert.equal(got[1].title, `${code}: bob → you`);
  // Opt-out and the orch.
  clock += 60_000;
  assert.equal(mk({ SUB_HUMAN_NOTIFY: '0' }).onEntry(rev('ffffffffffff')), false);
  assert.equal(createAlerter({ me: { ...me, role: 'orch' }, dir, env: { SUB_HUMAN_ALERT_FILE: sink } }).onEntry(msg('alice')), false);
  assert.equal(read().length, 4);
  fs.rmSync(sink, { force: true });
});

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
