'use strict';
// statusline/index.js (statusline, agentStatusline), statusline/segments.js and statusline/alert.js.
// Moved here from cli.test.js: the content of the bars and alerts is B's; the CLI dispatch is C's.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const PLUGIN = path.join(__dirname, '..');
for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE')) delete process.env[k];
delete process.env.ROOM_DIR;
const identity = require(path.join(PLUGIN, 'lib', 'identity.js'));
const rows = require(path.join(PLUGIN, 'lib', 'rows.js'));
const segments = require(path.join(PLUGIN, 'statusline', 'segments.js'));
const { statusline, agentStatusline } = require(path.join(PLUGIN, 'statusline', 'index.js'));
const { createAlerter } = require(path.join(PLUGIN, 'statusline', 'alert.js'));

const H = 'b7ca39aa0011';
const sleepers = [];
process.on('exit', () => { for (const p of sleepers) { try { p.kill('SIGKILL'); } catch { /* gone */ } } });
const sleeper = () => { const p = spawn('sleep', ['600'], { stdio: 'ignore' }); p.unref(); sleepers.push(p); return p.pid; };

/** A fresh home and room; seats join through identity (session ids sid-<name>); the log is written by hand. */
function world(names, { selfName } = {}) {
  process.env.SUB_HUMAN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-sl-'));
  const code = identity.newCode();
  for (const name of names) {
    const r = identity.join({ code, name, role: name === 'orch' ? 'orch' : 'member', pid: name === selfName ? process.pid : sleeper(), session_id: `sid-${name}`, cwd: os.tmpdir() });
    assert.ok(r.ok, r.error);
  }
  const file = path.join(identity.roomDir(code), 'log.jsonl');
  let id = 0;
  const add = (from, kind, extra = {}) => {
    id++;
    fs.appendFileSync(file, JSON.stringify({ id, at: new Date().toISOString(), from, via: 'human', kind, text: 'x', to: 'room', ...extra }) + '\n');
    return id;
  };
  return { code, add, sys: (kind, extra) => add('orch', kind, { via: 'system', ...extra }) };
}
const env = { NO_COLOR: '1' };

test('statusline: empty when not joined; member, approver, needed, objection, orch, decided; mail for me', () => {
  process.env.SUB_HUMAN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-sl-'));
  assert.equal(statusline({ session_id: 'nobody', cwd: '/tmp' }, { env }), '');
  const { code, add, sys } = world(['orch', 'alice', 'bob', 'carol']);
  assert.equal(statusline({ session_id: 'sid-nobody' }, { env }), '');
  const line = name => statusline({ session_id: `sid-${name}` }, { env }).replace(/ · ⚠ rows: \d+ missing$/, '');
  assert.equal(line('alice'), `⬡ ${code} · alice`, 'no plan yet');
  sys('plan_rev', { plan_hash: H, approvers: ['alice', 'bob'] });
  add('alice', 'signoff', { plan_hash: H });
  assert.equal(line('alice'), `⬡ ${code} · alice · plan b7ca39 1/2 · approver`);
  assert.equal(line('bob'), `⬡ ${code} · bob · ⚠ your sign-off needed (plan b7ca39 1/2)`);
  assert.equal(line('carol'), `⬡ ${code} · carol · plan b7ca39 1/2`, 'not an approver: nothing extra');
  assert.equal(line('orch'), `⬡ ${code} · orch · plan b7ca39 1/2 waiting on bob`);
  add('carol', 'objection', { plan_hash: H });
  assert.equal(line('alice'), `⬡ ${code} · alice · plan b7ca39 1/2 ✖ 1 objection · approver`);
  add('carol', 'signoff', { plan_hash: H });
  assert.equal(line('carol'), `⬡ ${code} · carol · plan b7ca39 1/2`);
  assert.match(statusline({ session_id: 'sid-bob' }, { env: {} }), /\x1b\[1;33m⚠ your sign-off needed\x1b\[0m/);
  add('orch', 'question', { via: 'agent', to: 'bob' });
  add('alice', 'say', { to: 'bob' });
  assert.match(line('bob'), / · ✉ 2 for you$/);
  add('bob', 'objection', { plan_hash: H });
  assert.equal(line('bob'), `⬡ ${code} · bob · ⚠ your sign-off needed (plan b7ca39 1/2)`, 'my own post clears the mail count');
  add('bob', 'signoff', { plan_hash: H });
  sys('decision', { plan_hash: H });
  assert.equal(line('bob'), `⬡ ${code} · bob · plan b7ca39 2/2 ✔ · approver`);
  assert.equal(line('orch'), `⬡ ${code} · orch · plan b7ca39 2/2 ✔`);
});

test('statusline: "rows missing" when the orch has no live hold for a member', () => {
  const { code } = world(['orch', 'alice', 'bob']);
  const ms = JSON.parse(fs.readFileSync(path.join(identity.roomDir(code), 'members.json'), 'utf8'));
  for (const m of Object.values(ms)) m.joined_at = new Date(Date.now() - 120_000).toISOString();
  fs.writeFileSync(path.join(identity.roomDir(code), 'members.json'), JSON.stringify(ms));
  assert.equal(statusline({ session_id: 'sid-orch' }, { env }), `⬡ ${code} · orch · ⚠ rows: 2 missing`);
  rows.writeHolds(code, 'orch', { members: ['alice', 'bob'] });
  assert.equal(statusline({ session_id: 'sid-orch' }, { env }), `⬡ ${code} · orch`);
});

test('statusline: falls back to process ancestry in a child process', () => {
  const { code, sys } = world(['orch', 'alice'], { selfName: 'alice' });
  sys('plan_rev', { plan_hash: H, approvers: ['alice'] });
  const r = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(path.join(PLUGIN, 'statusline', 'index.js'))}).statusline({}, {env: {NO_COLOR: '1'}}))`],
    { env: { ...process.env }, encoding: 'utf8' });
  assert.equal(r.stdout.replace(/ · ⚠ rows: \d+ missing$/, ''), `⬡ ${code} · alice · ⚠ your sign-off needed (plan b7ca39 0/1)`);
});

test('agentStatusline: orch rows by the row map, else by description; other tasks untouched; killed rows', () => {
  const { code, add, sys } = world(['orch', 'alice', 'bob']);
  sys('plan_rev', { plan_hash: H, approvers: ['alice', 'bob'] });
  add('alice', 'signoff', { plan_hash: H });
  rows.recordRow(code, 'sid-orch', 'a1', { kind: 'participant', name: 'alice', parent: null });
  const tasks = [
    { id: 'a1', type: 'local_agent', status: 'running', description: 'alice watcher' },
    { id: 'a2', type: 'local_agent', status: 'running', description: 'bob' },
    { id: 'a3', type: 'local_agent', status: 'running', description: 'run tests' },
    { id: 'a4', type: 'local_agent', status: 'killed', description: 'bob' },
  ];
  const out = agentStatusline({ session_id: 'sid-orch', tasks }, { env }).split('\n').map(l => JSON.parse(l));
  assert.deepEqual(out, [
    { id: 'a1', content: 'alice  ✓ signed b7ca39' },
    { id: 'a2', content: 'bob  ⚠ reviewing b7ca39' },
    { id: 'a4', content: 'bob  ⚠ row stopped' },
  ]);
  assert.equal(agentStatusline({ session_id: 'sid-orch', tasks: [tasks[2]] }, { env }), '', 'no row tasks: nothing');
  assert.equal(agentStatusline({ session_id: 'sid-nobody', tasks }, { env }), '');
  assert.equal(agentStatusline({}, { env }), '');
});

test('agentStatusline: a member\'s room row and the nested rows inside it (after /clear changed the session id)', () => {
  const { code, add, sys } = world(['orch', 'alice', 'bob', 'carol']);
  sys('plan_rev', { plan_hash: H, approvers: ['alice', 'bob'] });
  add('bob', 'objection', { plan_hash: H });
  rows.recordRow(code, 'old-session', 'r1', { kind: 'room', name: code, parent: null });
  rows.recordRow(code, 'old-session', 'c1', { kind: 'participant', name: 'bob', parent: 'r1' });
  rows.recordRow(code, 'old-session', 'c2', { kind: 'participant', name: 'carol', parent: 'r1' });
  const tasks = [
    { id: 'r1', status: 'running', description: code },
    { id: 'c1', status: 'running', description: 'bob' },
    { id: 'c2', status: 'killed', description: 'carol' },
  ];
  const out = agentStatusline({ session_id: 'sid-alice', tasks }, { env }).split('\n').map(l => JSON.parse(l));
  assert.deepEqual(out, [
    { id: 'r1', content: `${code}  plan b7ca39 0/2 · ✖ 1 objection · ⚠ your sign-off needed` },
    { id: 'c1', content: 'bob  ✖ objected b7ca39 (#2)' },
    { id: 'c2', content: 'carol  (reconnecting)' },
  ]);
  identity.leave(code, 'carol');
  assert.equal(JSON.parse(agentStatusline({ session_id: 'sid-alice', tasks: [tasks[2]] }, { env })).content, 'carol  left');
});

test('segments: state() is fast enough for a status bar', () => {
  const entries = [{ id: 1, kind: 'plan_rev', plan_hash: H, approvers: ['alice', 'bob'], from: 'orch', via: 'system' }];
  for (let i = 2; i <= 2000; i++) entries.push({ id: i, kind: 'say', from: 'bob', via: 'human', to: i % 3 ? 'room' : 'alice', text: `message ${i} `.repeat(10) });
  const t = process.hrtime.bigint();
  segments.render(segments.state({ code: 'x-0000', name: 'alice', role: 'member' }, entries));
  assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < 50, 'state() under 50 ms');
});

test('alerts: sign-off once per plan hash, messages at most once per gap, history and orch never; opt-out', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-alert-'));
  const code = 'otter-1234';
  const sink = path.join(dir, 'alerts.jsonl');
  const read = () => { try { return fs.readFileSync(sink, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  let clock = Date.parse('2026-10-04T12:00:00Z');
  const at = () => new Date(clock).toISOString();
  const me = { code, name: 'alice', role: 'member' };
  let signed = false;
  const mk = (e = {}) => createAlerter({ me, dir, env: { SUB_HUMAN_ALERT_FILE: sink, ...e }, now: () => clock,
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
  assert.equal(got[0].title, `${code}: your sign-off is needed`);
  assert.match(got[0].text, /sign-off form is in your Claude Code session/);
  assert.equal(got[1].text, 'hey alice look');
  assert.equal(got[1].title, `${code}: bob → you`);
  clock += 60_000;
  assert.equal(mk({ SUB_HUMAN_NOTIFY: '0' }).onEntry(rev('ffffffffffff')), false);
  assert.equal(createAlerter({ me: { ...me, role: 'orch' }, dir, env: { SUB_HUMAN_ALERT_FILE: sink } }).onEntry(msg('alice')), false);
  assert.equal(read().length, 4);
});
