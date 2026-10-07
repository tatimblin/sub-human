'use strict';
// Tests for lib/identity.js: codes, membership, resolution (session id, registered pid, resolveSelf), open rooms, presence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./helpers.js');
const identity = require(path.join(h.LIB, 'identity.js'));
const store = require(path.join(h.LIB, 'room', 'store.js'));

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
  assert.equal(m.pid_start, require(path.join(h.LIB, 'lock.js')).pidStart(process.pid), 'the process start time is stored with the pid');
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
  // 1. the session id Claude Code sets for Bash (and the mod for its tail child).
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

test('identity: openRooms lists rooms with >= 1 live member seat (no orch needed) that are not closing', async () => {
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
  // an orch seat alone does not keep a room open: it is an orphan room (join sweeps it), still roomOpen for a resume
  const o = h.spawnSleeper();
  identity.join({ code: b, name: 'orch', role: 'orch', pid: o.pid });
  assert.deepEqual(identity.openRooms(), [a], 'orch-only room ignored');
  assert.deepEqual(identity.orphanRooms(), [b]);
  assert.equal(identity.roomOpen(b), true);
  assert.deepEqual(identity.liveMembers(b), [], 'the orch is not a member');
  identity.setOrch(b, { closing: new Date().toISOString() });
  assert.equal(identity.roomClosing(b), true);
  assert.deepEqual(identity.openRooms(), [a], 'closing');
  assert.deepEqual(identity.orphanRooms(), [], 'closing rooms are not swept again');
  assert.equal(identity.roomOpen(b), false);
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

test('identity: presence is a per-member file; writePresence stores valid states and names only', () => {
  h.freshHome();
  const code = h.newRoom();
  const kv = store.open(code).kv;
  assert.equal(identity.writePresence(code, 'alice', 'idle'), true);
  assert.equal(identity.writePresence(code, 'bob', 'error', 'rate_limit'), true);
  assert.equal(identity.writePresence(code, 'bob', 'bogus'), false);
  assert.equal(identity.writePresence(code, '../x', 'idle'), false);
  assert.deepEqual(kv.list('presence/').sort(), ['presence/alice', 'presence/bob']);
  assert.equal(kv.get('presence/alice').state, 'idle');
  assert.deepEqual([kv.get('presence/bob').state, kv.get('presence/bob').detail], ['error', 'rate_limit']);
  assert.ok(Date.parse(kv.get('presence/alice').at));
  assert.ok(fs.existsSync(path.join(identity.roomDir(code), 'presence', 'alice.json')));
  for (const st of identity.PRESENCE_STATES) assert.equal(identity.writePresence(code, 'carol', st), true, st);
});

test('identity: pid reuse: a live pid with a different start time is not the seat (not live, not taken, not resolved)', () => {
  h.freshHome();
  const code = h.newRoom();
  const s = h.spawnSleeper();
  assert.deepEqual(identity.join({ code, name: 'alice', role: 'member', pid: s.pid, session_id: 'sa' }), { ok: true });
  const start = identity.readMembers(code).alice.pid_start;
  assert.ok(Number.isInteger(start), 'pid_start stored');
  const idx = JSON.parse(fs.readFileSync(path.join(identity.home(), 'sessions', 'by-pid', `${s.pid}.json`), 'utf8'));
  assert.equal(idx.pid_start, start, 'the by-pid index carries it too');
  assert.deepEqual(identity.liveMembers(code), ['alice']);
  assert.equal(identity.resolveByPid(s.pid).name, 'alice');
  // Pretend the seat was registered by an older process that had this pid.
  const file = path.join(identity.roomDir(code), 'members.json');
  const ms = JSON.parse(fs.readFileSync(file, 'utf8'));
  ms.alice.pid_start = start - 3600;
  fs.writeFileSync(file, JSON.stringify(ms));
  assert.equal(identity.isAlive(s.pid), true, 'the pid itself is alive');
  assert.equal(identity.seatAlive(identity.readMembers(code).alice), false);
  assert.deepEqual(identity.liveMembers(code), []);
  assert.deepEqual(identity.openRooms(), []);
  assert.equal(identity.resolveByPid(s.pid), null, 'a reused pid does not adopt the seat');
  const other = h.spawnSleeper();
  assert.deepEqual(identity.join({ code, name: 'alice', role: 'member', pid: other.pid, session_id: 'sb' }), { ok: true, rejoin: true }, 'not "name taken"');
  // Legacy seats without pid_start are still judged by the pid alone.
  delete ms.alice.pid_start; ms.alice.pid = s.pid;
  fs.writeFileSync(file, JSON.stringify(ms));
  assert.equal(identity.seatAlive(identity.readMembers(code).alice), true);
  s.kill(); other.kill();
});

test('identity: leave drops the by-pid index (under the members lock) but keeps the by-sid one', () => {
  h.freshHome();
  const code = h.newRoom();
  identity.join({ code, name: 'alice', role: 'member', pid: process.pid, session_id: 'sl' });
  const byPid = path.join(identity.home(), 'sessions', 'by-pid', `${process.pid}.json`);
  assert.ok(fs.existsSync(byPid));
  assert.equal(identity.leave(code, 'alice'), true);
  assert.equal(fs.existsSync(byPid), false);
  assert.equal(identity.lastSeat('sl').name, 'alice');
  assert.equal(identity.leave(code, 'alice'), false, 'already left');
  assert.equal(fs.existsSync(path.join(identity.roomDir(code), 'members.json.lock')), false, 'lock released');
});

test('identity: updateOrch merges a patch under the lock, writes nothing for null, drops undefined keys', () => {
  h.freshHome();
  const code = h.newRoom();
  assert.equal(identity.updateOrch(code, () => null), null);
  assert.deepEqual(identity.readMembers(code), {});
  identity.updateOrch(code, o => { assert.equal(o, null); return { job: 'pending', claim: 'c1' }; });
  const r = identity.updateOrch(code, o => ({ claim: undefined, job: o.job === 'pending' ? 'abcd1234' : 'x' }));
  assert.deepEqual(r, { name: 'orch', role: 'orch', pid: null, job: 'abcd1234' });
  assert.throws(() => identity.updateOrch('nope-0000', () => ({})), /no room/);
});

test('identity: the seat lease: join stamps seen_at, heartbeat renews it (throttled, own seat only), seatAlive uses it only without a pid', async () => {
  h.freshHome();
  const { code } = h.register('alice');
  const config = require(path.join(h.LIB, 'config.js'));
  const me = identity.resolveByPid(process.pid);
  const seen = () => identity.readMembers(code).alice.seen_at;
  const t0 = Date.parse(seen());
  assert.ok(Number.isFinite(t0), 'join stamps seen_at');
  assert.equal(identity.heartbeat(me, t0 + 1000), false, 'renewed at most every SEAT_BEAT_MS');
  assert.equal(identity.heartbeat(me, t0 + config.SEAT_BEAT_MS + 1), true);
  assert.equal(Date.parse(seen()), t0 + config.SEAT_BEAT_MS + 1);
  assert.equal(identity.heartbeat({ ...me, pid: 1 }, t0 + 10 * config.SEAT_BEAT_MS), false, 'another pid does not renew this seat');
  // pid first: a live pid with a stale lease is alive; a dead pid with a fresh lease is not
  const m = identity.readMembers(code).alice;
  assert.equal(identity.seatAlive({ ...m, seen_at: new Date(0).toISOString() }), true);
  assert.equal(identity.seatAlive({ ...m, pid: await h.deadPid(), seen_at: new Date().toISOString() }), false);
  // no pid info (a seat kept by a store off this machine): the lease decides
  const remote = { name: 'zed', role: 'member', pid: null };
  assert.equal(identity.seatAlive({ ...remote, seen_at: new Date().toISOString() }), true);
  assert.equal(identity.seatAlive({ ...remote, seen_at: new Date(Date.now() - config.SEAT_LEASE_MS - 1).toISOString() }), false);
  assert.equal(identity.seatAlive(remote), false, 'no pid and no lease: not alive (an orch record before it binds)');
  assert.equal(identity.seatAlive({ ...remote, seen_at: new Date().toISOString(), left_at: new Date().toISOString() }), false);
  identity.leave(code, 'alice');
  assert.equal(identity.heartbeat(me, Date.now() + 10 * config.SEAT_BEAT_MS), false, 'a left seat is not renewed');
});

test('identity: the hooks-module lease records the claude pid and its start time; join accepts it from that process or while recent', async () => {
  h.freshHome();
  const { pidStart } = require(path.join(h.LIB, 'lock.js'));
  const FRESH = identity.MOD_LEASE_FRESH_MS;
  assert.ok(FRESH > 0 && FRESH < 86_400_000, 'the hook tests treat a day-old lease as stale');
  const sid = n => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const file = s => path.join(identity.home(), 'sessions', 'mods', `${s}.json`);
  const now = Date.now();

  const nonce = 'ab'.repeat(16);
  assert.equal(identity.writeModLease(sid(1), { pid: process.pid, nonce }), true);
  const rec = identity.readModLease(sid(1));
  assert.deepEqual(Object.keys(rec).sort(), ['at', 'nonce', 'pid', 'pid_start', 'session_id']);
  assert.equal(rec.pid, process.pid);
  assert.equal(rec.pid_start, pidStart(process.pid));
  assert.equal(rec.nonce, nonce);
  assert.ok(Math.abs(Date.parse(rec.at) - now) < 5000);

  assert.equal(identity.modLeaseOk(sid(1), process.pid, now + 10 * FRESH), true, 'this process: however old');
  const other = h.spawnSleeper().pid;
  assert.equal(identity.modLeaseOk(sid(1), other, now), true, 'another process: only while recent');
  assert.equal(identity.modLeaseOk(sid(1), other, now + FRESH + 1000), false);
  assert.equal(identity.modLeaseOk(sid(9), process.pid, now), false, 'no lease');

  // a resumed session id: the old process is gone and the lease is old
  const dead = await h.deadPid();
  identity.writeModLease(sid(2), { pid: dead });
  assert.equal(identity.modLeaseOk(sid(2), dead, now + FRESH + 1000), false);
  assert.equal(identity.modLeaseOk(sid(2), other, now + FRESH + 1000), false);
  // a reused pid: same number, another start time
  fs.writeFileSync(file(sid(3)), JSON.stringify({ ...rec, session_id: sid(3), pid_start: rec.pid_start - 3600 }));
  assert.equal(identity.modLeaseOk(sid(3), process.pid, now + FRESH + 1000), false);
  // another session's lease copied into this session's file does not count
  fs.writeFileSync(file(sid(4)), JSON.stringify({ ...rec, session_id: sid(1) }));
  assert.equal(identity.modLeaseOk(sid(4), process.pid, now), false);

  identity.writeModLease(sid(5), {});
  assert.equal(identity.readModLease(sid(5)).pid, null);
  assert.equal(identity.modLeaseOk(sid(5), process.pid, now), true, 'no pid: while recent');
  assert.equal(identity.modLeaseOk(sid(5), process.pid, now + FRESH + 1000), false);

  assert.equal(identity.deleteModLease(sid(4)), true);
  assert.equal(identity.readModLease(sid(4)), null);
  assert.equal(identity.deleteModLease('../x'), false);
});

test('identity: pruneModLeases deletes leases whose process is gone (or reused), and pid-less ones past the fresh window', async () => {
  h.freshHome();
  const FRESH = identity.MOD_LEASE_FRESH_MS;
  const sid = n => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const dir = path.join(identity.home(), 'sessions', 'mods');
  identity.writeModLease(sid(1), { pid: process.pid });
  identity.writeModLease(sid(2), { pid: await h.deadPid() });
  fs.writeFileSync(path.join(dir, `${sid(3)}.json`), JSON.stringify({ ...identity.readModLease(sid(1)), session_id: sid(3), pid_start: 1 }));
  identity.writeModLease(sid(4), {});
  assert.equal(identity.pruneModLeases(Date.now()), 2);
  assert.deepEqual(fs.readdirSync(dir).sort(), [`${sid(1)}.json`, `${sid(4)}.json`]);
  assert.equal(identity.pruneModLeases(Date.now() + FRESH + 1000), 1, 'the pid-less lease once old');
  assert.deepEqual(fs.readdirSync(dir), [`${sid(1)}.json`], 'a live process keeps its lease however old');
  fs.rmSync(dir, { recursive: true });
  assert.equal(identity.pruneModLeases(), 0, 'no leases dir');
});
