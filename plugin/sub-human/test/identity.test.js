'use strict';
// Tests for lib/identity.js: codes, membership, process ancestry, resolution.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./helpers.js');
const identity = require(path.join(h.LIB, 'identity.js'));

const byPid = pid => path.join(identity.home(), 'sessions', 'by-pid', `${pid}.json`);

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
  assert.match(identity.join({ code: 'nope-0000', name: 'alice', role: 'member', pid: process.pid }).error, /no room/);
  assert.match(j('alice', 'member', { session_id: '../../x' }).error, /session_id/);
  assert.deepEqual(j('orch', 'orch'), { ok: true });
  const m = identity.readMembers(code).orch;
  assert.equal(m.role, 'orch');
  assert.equal(m.pid, process.pid);
  assert.equal(m.pid_start, identity.pidStart(process.pid));
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
  // Joining a dead pid is refused outright.
  const dead = await h.deadPid();
  assert.match(identity.join({ code, name: 'bob', role: 'member', pid: dead }).error, /not running/);
});

test('identity: leave frees the name and drops the indexes', () => {
  h.freshHome();
  const { code } = h.register('alice');
  assert.equal(identity.resolveByPid(process.pid).name, 'alice');
  assert.equal(identity.leave(code, 'alice'), true);
  assert.ok(identity.readMembers(code).alice.left_at);
  assert.equal(identity.resolveByPid(process.pid), null);
  assert.equal(identity.resolveBySession(`sess-alice-${process.pid}`), null);
  assert.equal(identity.leave(code, 'alice'), false);
  const s = h.spawnSleeper();
  assert.deepEqual(identity.join({ code, name: 'alice', role: 'member', pid: s.pid }), { ok: true, rejoin: true });
  s.kill();
});

test('identity: process helpers (pidStart, isAlive, ancestors)', async () => {
  assert.match(identity.pidStart(process.pid), /\d{4}$/);
  assert.equal(identity.isAlive(process.pid), true);
  const dead = await h.deadPid();
  assert.equal(identity.isAlive(dead), false);
  assert.equal(identity.pidStart(dead), null);
  assert.equal(identity.pidStart(-1), null);
  const chain = identity.ancestors(process.pid);
  assert.equal(chain[0].pid, process.ppid);
  assert.ok(chain.some(a => a.pid === 1) || chain.length > 0);
  const r = spawnSync(process.execPath, ['-e',
    `const i=require(${JSON.stringify(path.join(h.LIB, 'identity.js'))});console.log(JSON.stringify(i.ancestors(process.pid).map(a=>a.pid)))`],
  { env: h.childEnv(), encoding: 'utf8' });
  assert.ok(JSON.parse(r.stdout).includes(process.pid), 'the test process is an ancestor of its child');
});

/** Run `fn` source in a child and return its JSON output. */
function inChild(src, env = {}) {
  const r = spawnSync(process.execPath, ['-e', `const i=require(${JSON.stringify(path.join(h.LIB, 'identity.js'))});` +
    `console.log(JSON.stringify((${src})()))`], { env: h.childEnv(env), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('identity: claudePid accepts CLAUDE_PID only when it is a real ancestor', () => {
  h.freshHome();
  const bob = h.spawnSleeper();
  // Ancestor: the test process is the child's parent.
  assert.equal(inChild('() => i.claudePid()', { CLAUDE_PID: String(process.pid) }), process.pid);
  // Not an ancestor: a live sibling process. Never accepted.
  const got = inChild('() => i.claudePid()', { CLAUDE_PID: String(bob.pid) });
  assert.notEqual(got, bob.pid);
  // ppid mode (the MCP server) ignores env entirely.
  assert.equal(inChild('() => i.claudePid({ppid:true})', { CLAUDE_PID: String(bob.pid) }), process.pid);
  // And resolution never follows a non-ancestor CLAUDE_PID: bob is registered, alice (this pid) is the self.
  const code = h.newRoom();
  identity.join({ code, name: 'bob', role: 'member', pid: bob.pid, session_id: 'sbob' });
  h.register('alice', 'member', process.pid, code);
  const self = inChild('() => i.resolveSelf()', { CLAUDE_PID: String(bob.pid) });
  assert.equal(self.name, 'alice');
  assert.equal(inChild(`() => i.resolveByPid(i.claudePid())`, { CLAUDE_PID: String(bob.pid) }), null);
  bob.kill();
});

test('identity: resolveByPid rejects a pid_start mismatch (reused pid)', () => {
  h.freshHome();
  const { code } = h.register('alice');
  assert.deepEqual(identity.resolveByPid(process.pid), { code, name: 'alice', role: 'member' });
  const rec = JSON.parse(fs.readFileSync(byPid(process.pid), 'utf8'));
  fs.writeFileSync(byPid(process.pid), JSON.stringify({ ...rec, pid_start: 'Thu Jan  1 00:00:00 1970' }));
  assert.equal(identity.resolveByPid(process.pid), null);
  assert.equal(identity.resolveBySession(`sess-alice-${process.pid}`), null);
  assert.equal(inChild('() => i.resolveSelf()', { SUB_HUMAN_HOME: identity.home() }), null);
  // The member record's start time is checked too.
  fs.writeFileSync(byPid(process.pid), JSON.stringify(rec));
  assert.equal(identity.resolveByPid(process.pid).name, 'alice');
  const members = identity.readMembers(code);
  members.alice.pid_start = 'x';
  fs.writeFileSync(path.join(identity.roomDir(code), 'members.json'), JSON.stringify(members));
  assert.equal(identity.resolveByPid(process.pid), null);
});

test('identity: resolveBySession, rebindSession after /clear, resolveSelf from a child', () => {
  h.freshHome();
  const { code } = h.register('alice');
  assert.deepEqual(identity.resolveBySession(`sess-alice-${process.pid}`), { code, name: 'alice', role: 'member' });
  assert.equal(identity.resolveBySession('../../etc/passwd'), null);
  assert.equal(identity.rebindSession(process.pid, 'new-sid'), true);
  assert.equal(identity.resolveBySession('new-sid').name, 'alice');
  assert.equal(identity.resolveBySession(`sess-alice-${process.pid}`), null);
  assert.equal(identity.readMembers(code).alice.session_id, 'new-sid');
  const self = inChild('() => i.resolveSelf()');
  assert.deepEqual(self, { code, name: 'alice', role: 'member', pid: process.pid });
  // One registration per process: joining another room retires the first.
  const code2 = h.newRoom();
  h.register('carol', 'member', process.pid, code2);
  assert.ok(identity.readMembers(code).alice.left_at);
  assert.equal(identity.resolveByPid(process.pid).code, code2);
});
