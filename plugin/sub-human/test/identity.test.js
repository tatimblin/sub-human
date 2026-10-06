'use strict';
// Tests for lib/identity.js: codes, membership, resolution (session id, registered pid, resolveSelf), open rooms, presence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./helpers.js');
const identity = require(path.join(h.LIB, 'identity.js'));

test('identity: home, room codes are word-NNNN from the animal list and unique', () => {
  const home = h.freshHome();
  assert.equal(identity.home(), home);
  assert.equal(identity.ANIMALS.length, 64);
  const codes = new Set();
  for (let i = 0; i < 30; i++) {
    const c = identity.newCode();
    assert.match(c, /^[a-z]+-\d{4}$/);
    assert.ok(identity.ANIMALS.includes(c.split('-')[0]));
    assert.ok(identity.roomExists(c));
    codes.add(c);
  }
  assert.equal(codes.size, 30);
  assert.equal(identity.roomDir('otter-0001'), path.join(home, 'rooms', 'otter-0001'));
  assert.throws(() => identity.roomDir('../etc'), /invalid room code/);
  assert.equal(identity.roomExists('otter-0001'), false);
  assert.equal(identity.roomExists('../x'), false);
});

test('identity: join validates names, reserved names and roles', () => {
  h.freshHome();
  const code = h.newRoom();
  const j = (name, role = 'member', extra = {}) => identity.join({ code, name, role, pid: process.pid, session_id: 's1', cwd: '/x', ...extra });
  for (const bad of ['', 'a b', 'x'.repeat(33), 'semi;colon', null]) assert.equal(j(bad).ok, false, String(bad));
  for (const r of ['orch', 'room', 'all', 'system', 'ROOM']) assert.match(j(r).error, /reserved/, r);
  assert.match(j('alice', 'orch').error, /joins as "orch"/);
  assert.match(j('alice', 'admin').error, /invalid role/);
  assert.match(j('alice', 'observer').error, /invalid role/, 'roles are orch and member only');
  assert.match(identity.join({ code: 'nope-0000', name: 'alice', role: 'member', pid: process.pid }).error, /no room/);
  assert.match(j('alice', 'member', { session_id: '../../x' }).error, /session_id/);
  assert.match(j('alice', 'member', { pid: 'x' }).error, /invalid pid/);
  assert.deepEqual(j('orch', 'orch'), { ok: true });
  const m = identity.readMembers(code).orch;
  assert.equal(m.role, 'orch');
  assert.equal(m.pid, process.pid);
  assert.equal(m.pid_start, undefined, 'no process-start records');
  assert.equal(m.session_id, 's1');
  assert.equal(m.cwd, '/x');
  assert.ok(m.joined_at);
});

test('identity: a live holder makes the name taken; the same pid rejoins; a dead holder is rebound', async () => {
  h.freshHome();
  const code = h.newRoom();
  const other = h.spawnSleeper();
  assert.deepEqual(identity.join({ code, name: 'alice', role: 'member', pid: other.pid, session_id: 'sa' }), { ok: true });
  const taken = identity.join({ code, name: 'alice', role: 'member', pid: process.pid, session_id: 'sb' });
  assert.equal(taken.ok, false);
  assert.match(taken.error, /name taken/);
  assert.deepEqual(identity.join({ code, name: 'alice', role: 'member', pid: other.pid, session_id: 'sa2' }), { ok: true, rejoin: true });
  assert.equal(identity.resolveBySession('sa'), null, 'the old session id no longer resolves');
  assert.equal(identity.resolveBySession('sa2').name, 'alice');
  other.kill();
  await h.until(() => !identity.isAlive(other.pid));
  assert.deepEqual(identity.join({ code, name: 'alice', role: 'member', pid: process.pid, session_id: 'sb' }), { ok: true, rejoin: true });
  assert.equal(identity.readMembers(code).alice.pid, process.pid);
  assert.equal(identity.resolveByPid(other.pid), null);
});

test('identity: leave frees the name, drops the pid index, keeps lastSeat for --resume', () => {
  h.freshHome();
  const { code } = h.register('alice');
  const sid = `sess-alice-${process.pid}`;
  assert.equal(identity.resolveByPid(process.pid).name, 'alice');
  assert.equal(identity.leave(code, 'alice'), true);
  assert.ok(identity.readMembers(code).alice.left_at);
  assert.equal(identity.resolveByPid(process.pid), null);
  assert.equal(identity.resolveBySession(sid), null);
  assert.deepEqual(identity.lastSeat(sid), { code, name: 'alice', role: 'member', address: `alice.${code}` });
  assert.equal(identity.lastSeat('nope'), null);
  assert.equal(identity.leave(code, 'alice'), false);
  const s = h.spawnSleeper();
  assert.deepEqual(identity.join({ code, name: 'alice', role: 'member', pid: s.pid }), { ok: true, rejoin: true });
  s.kill();
});

test('identity: resolution returns {code, name, role, session_id, pid, address} by a direct lookup', () => {
  h.freshHome();
  const { code } = h.register('alice');
  const want = { code, name: 'alice', role: 'member', session_id: `sess-alice-${process.pid}`, pid: process.pid, address: `alice.${code}` };
  assert.deepEqual(identity.resolveByPid(process.pid), want);
  const idx = JSON.parse(fs.readFileSync(path.join(identity.home(), 'sessions', 'by-pid', `${process.pid}.json`), 'utf8'));
  assert.equal(idx.address, `alice.${code}`, 'the index record carries the address');
  assert.deepEqual(identity.resolveBySession(want.session_id), want);
  assert.equal(identity.resolveBySession('../../etc/passwd'), null);
  assert.equal(identity.resolveByPid(-1), null);
  assert.equal(identity.resolveByPid(1), null, 'an unregistered pid');
  // A stale index (the member record moved on) never resolves.
  const members = identity.readMembers(code);
  members.alice.pid = 1;
  fs.writeFileSync(path.join(identity.roomDir(code), 'members.json'), JSON.stringify(members));
  assert.equal(identity.resolveByPid(process.pid), null);
});

/** Run `src` (a function source) in a child and return its JSON output. */
function inChild(src, env = {}) {
  const r = spawnSync(process.execPath, ['-e', `const i=require(${JSON.stringify(path.join(h.LIB, 'identity.js'))});` +
    `console.log(JSON.stringify((${src})()))`], { env: h.childEnv(env), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('identity: rebindSession after /clear; resolveSelf by CLAUDE_CODE_SESSION_ID, then CLAUDE_PID, then ancestors', () => {
  h.freshHome();
  const { code } = h.register('alice');
  const bob = h.spawnSleeper();
  identity.join({ code, name: 'bob', role: 'member', pid: bob.pid, session_id: 'sbob' });
  assert.equal(identity.rebindSession(process.pid, 'new-sid'), true);
  assert.equal(identity.resolveBySession('new-sid').name, 'alice');
  assert.equal(identity.resolveBySession(`sess-alice-${process.pid}`), null);
  assert.equal(identity.readMembers(code).alice.session_id, 'new-sid');
  assert.equal(identity.rebindSession(process.pid, '../x'), false);
  // 1. the session id Claude Code sets for Bash and monitors.
  assert.equal(inChild('() => i.resolveSelf().name', { CLAUDE_CODE_SESSION_ID: 'sbob' }), 'bob');
  // 2. CLAUDE_PID (a stale session id after /clear falls through to it).
  assert.equal(inChild('() => i.resolveSelf().name', { CLAUDE_CODE_SESSION_ID: 'stale', CLAUDE_PID: String(bob.pid) }), 'bob');
  // 3. the nearest registered ancestor (this test process is the child's parent).
  assert.deepEqual(inChild('() => i.resolveSelf()'), { code, name: 'alice', role: 'member', session_id: 'new-sid', pid: process.pid, address: `alice.${code}` });
  assert.equal(inChild('() => i.claudePid()', { CLAUDE_PID: '4242' }), 4242);
  assert.equal(inChild('() => i.claudePid()'), null);
  // One registration per process: joining another room retires the first.
  const code2 = h.newRoom();
  h.register('carol', 'member', process.pid, code2);
  assert.ok(identity.readMembers(code).alice.left_at);
  assert.equal(identity.resolveByPid(process.pid).code, code2);
  bob.kill();
});

test('identity: openRooms lists rooms with >= 1 live seat (no orch needed) that are not closing', async () => {
  h.freshHome();
  assert.deepEqual(identity.openRooms(), []);
  const a = h.newRoom();
  h.register('alice', 'member', process.pid, a);
  identity.newCode(); // a room with nobody in it is not open
  await h.sleep(5);
  const b = h.newRoom();
  const s = h.spawnSleeper();
  identity.join({ code: b, name: 'bob', role: 'member', pid: s.pid });
  assert.deepEqual(identity.openRooms().sort(), [a, b].sort());
  assert.equal(identity.openRooms()[0], b, 'newest first');
  assert.deepEqual(identity.liveMembers(b), ['bob']);
  s.kill();
  await h.until(() => !identity.isAlive(s.pid));
  assert.deepEqual(identity.openRooms(), [a], 'dead member');
  assert.deepEqual(identity.liveMembers(b), []);
  // an orch seat alone keeps a room open (a quick rejoin finds it) until the reaper marks it closing
  const o = h.spawnSleeper();
  identity.join({ code: b, name: 'orch', role: 'orch', pid: o.pid });
  assert.deepEqual(identity.openRooms().sort(), [a, b].sort());
  assert.deepEqual(identity.liveMembers(b), [], 'the orch is not a member');
  identity.setOrch(b, { closing: new Date().toISOString() });
  assert.equal(identity.roomClosing(b), true);
  assert.deepEqual(identity.openRooms(), [a], 'closing');
  o.kill();
  identity.leave(a, 'alice');
  assert.deepEqual(identity.openRooms(), [], 'member left');
});

test('identity: members.json orch {job, pid}: setOrch before the bind, kept across the bind', () => {
  h.freshHome();
  const code = h.newRoom();
  const pre = identity.setOrch(code, { job: 'ab12cd34', spawned_at: '2026-10-05T00:00:00.000Z' });
  assert.deepEqual(pre, { name: 'orch', role: 'orch', pid: null, job: 'ab12cd34', spawned_at: '2026-10-05T00:00:00.000Z' });
  assert.deepEqual(identity.join({ code, name: 'orch', role: 'orch', pid: process.pid, session_id: 'so' }), { ok: true, rejoin: true });
  const m = identity.readMembers(code).orch;
  assert.equal(m.job, 'ab12cd34');
  assert.equal(m.pid, process.pid);
  assert.equal(identity.resolveByPid(process.pid).address, `orch.${code}`);
  assert.throws(() => identity.setOrch('nope-0000', {}), /no room/);
});

test('identity: presence is a per-member file; readPresence returns valid states only', () => {
  h.freshHome();
  const code = h.newRoom();
  assert.deepEqual(identity.readPresence(code), {});
  assert.equal(identity.writePresence(code, 'alice', 'idle'), true);
  assert.equal(identity.writePresence(code, 'bob', 'error', 'rate_limit'), true);
  assert.equal(identity.writePresence(code, 'bob', 'bogus'), false);
  assert.equal(identity.writePresence(code, '../x', 'idle'), false);
  const p = identity.readPresence(code);
  assert.deepEqual(Object.keys(p).sort(), ['alice', 'bob']);
  assert.equal(p.alice.state, 'idle');
  assert.deepEqual([p.bob.state, p.bob.detail], ['error', 'rate_limit']);
  assert.ok(Date.parse(p.alice.at));
  assert.ok(fs.existsSync(path.join(identity.roomDir(code), 'presence', 'alice.json')));
  for (const st of identity.PRESENCE_STATES) assert.equal(identity.writePresence(code, 'carol', st), true, st);
});
