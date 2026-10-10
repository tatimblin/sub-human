'use strict';
// Tests for lib/seats.ts and the host gates: enter and exit as one sequence, the
// room Claude started in the room's working directory, and a mirror-shaped store (MemoryRoomStore with isHost false) where
// the seat op is all that runs (the host logs the join and leave), the room's Claude is never spawned, reaped or watched and
// no decision is written. lib/room/members.ts publicView: what other machines see of the members document.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const h = require('./helpers.js');
const store = require(path.join(h.LIB, 'room', 'store.ts'));
const identity = require(path.join(h.LIB, 'identity.ts'));
const seats = require(path.join(h.LIB, 'seats.ts'));
const roomClaude = require(path.join(h.LIB, 'room-claude.ts'));
const proposal = require(path.join(h.LIB, 'proposal.ts'));
const members = require(path.join(h.LIB, 'room', 'members.ts'));
const config = require(path.join(h.LIB, 'config.ts'));
const seatKey = require(path.join(h.PLUGIN, 'hooks', 'seat-key.ts'));
const { MemoryRoomStore } = require('./support/memory-store.js');

const H = 'abcdef012345';

/**
 * A room whose store is mem (a fresh MemoryRoomStore, host or mirror-shaped), for the length of the test. The room's Claude
 * starter is stubbed: started holds the cwd of each start.
 */
function memoryRoom(t, { isHost }) {
  h.freshHome(t);
  const code = h.newRoom();
  const mem = new MemoryRoomStore(code, { isHost });
  store.setBackend(() => mem);
  t.after(() => store.setBackend(null));
  const started = [];
  t.mock.method(seats.seam, 'startDetached', o => { started.push(o.cwd); return 1; });
  return { code, mem, started };
}

test('seats: enter logs member_joined with the pubkey and machine; exit leaves, logs member_left once', t => {
  const { code, mem } = memoryRoom(t, { isHost: true });
  const pubkey = seatKey.publicPem(code, 'alice');
  const r = seats.enter({ code, name: 'alice', pid: process.pid, session_id: 'sa', cwd: '/x', pubkey });
  assert.deepEqual(r, { ok: true, note: ' · starting the room\'s Claude…' });
  const joined = mem.readAll().at(-1);
  assert.deepEqual([joined.kind, joined.from, joined.pubkey, joined.machine], ['member_joined', 'alice', pubkey, identity.machineId()]);
  assert.equal(identity.resolveBySession('sa').name, 'alice');
  assert.equal(seats.enter({ code, name: 'host', pid: process.pid, pubkey }).error, '"host" is reserved');
  assert.equal(seats.exit(code, 'alice', 'session ended'), true);
  assert.equal(mem.readAll().at(-1).text, 'alice left (session ended)');
  assert.equal(seats.exit(code, 'alice', 'again'), false, 'already left: nothing written');
  assert.equal(mem.readAll().length, 2);
});

test('seats: a seat whose machine id could not be read (machine null) still joins; member_joined carries no machine', t => {
  const { code, mem } = memoryRoom(t, { isHost: true });
  const r = seats.enter({ code, name: 'alice', machine: null, pid: process.pid, session_id: 'sa', cwd: '/x', pubkey: seatKey.publicPem(code, 'alice') });
  assert.equal(r.ok, true);
  const joined = mem.readAll().at(-1);
  assert.deepEqual([joined.kind, joined.from, 'machine' in joined], ['member_joined', 'alice', false]);
  assert.equal(identity.readMembers(code).alice.machine, null);
});

test('seats: the room\'s Claude runs in the room\'s working directory (the first local seat\'s cwd), also when a seat on another machine starts it', t => {
  const { code, started } = memoryRoom(t, { isHost: true });
  seats.enter({ code, name: 'alice', pid: process.pid, session_id: 'sa', cwd: '/work/project', pubkey: seatKey.publicPem(code, 'alice') });
  seats.enter({ code, name: 'carol', pid: process.pid, session_id: 'sc', cwd: '/elsewhere', pubkey: seatKey.publicPem(code, 'carol') });
  identity.setRoomClaude(code, { stopped_at: new Date().toISOString() }); // the room's Claude is gone: the next join starts one
  // the remote server's enter: a seat of another machine, no cwd, in a process whose cwd is not the project
  assert.equal(seats.enter({ code, name: 'bob', machine: 'far-away', pubkey: seatKey.publicPem(code, 'bob') }).ok, true);
  assert.notEqual(process.cwd(), '/work/project');
  assert.deepEqual(started, ['/work/project', '/work/project']);
});

test('seats: a key other than the pinned one gives the seat back (AUTH)', t => {
  const { code, mem } = memoryRoom(t, { isHost: true });
  assert.equal(seats.enter({ code, name: 'alice', pid: process.pid, pubkey: seatKey.publicPem(code, 'alice') }).ok, true);
  seats.exit(code, 'alice', 'gone');
  const other = require('node:crypto').generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  const r = seats.enter({ code, name: 'alice', pid: process.pid, pubkey: other });
  assert.equal(r.ok, false);
  assert.match(r.error, /a lost key means a new name/);
  assert.ok(mem.members.read().alice.left_at, 'the seat was given back');
});

test('host gates: on a mirror-shaped store enter is the seat op only (no member_joined, no claude), exit starts no reaper and logs nothing, the watchdog and decide do nothing', t => {
  const { code, mem, started } = memoryRoom(t, { isHost: false });
  assert.equal(identity.isHost(code), false);
  assert.deepEqual(seats.enter({ code, name: 'alice', pid: process.pid, session_id: 'sa', pubkey: seatKey.publicPem(code, 'alice') }), { ok: true, note: '' });
  assert.equal(identity.resolveBySession('sa').name, 'alice', 'this machine\'s indexes are written');
  assert.deepEqual(mem.readAll(), [], 'the host logs the join');
  assert.deepEqual([mem.members.read().claude, started], [undefined, []], 'no spawn claim');
  assert.equal(roomClaude.claimSpawn(code), null);
  assert.equal(roomClaude.reapDetached(code), null, 'no reaper process');
  assert.equal(roomClaude.watchdog(code, { reaper: () => assert.fail('reaped off-host') }), 'not-host');
  // every approver answered, but only the host decides
  mem.append({ kind: 'proposal', text: `proposal ${H}: x`, hash: H, approvers: ['alice'] }, { via: 'agent', from: 'alice' });
  assert.ok(proposal.answer({ code, name: 'alice' }, { hash: H }, { choice: 'Agree' }).entry);
  assert.equal(proposal.decide(code, H), null);
  assert.equal(mem.readAll().filter(e => e.kind === 'decision').length, 0);
  assert.equal(seats.exit(code, 'alice', 'session ended'), true);
  assert.ok(mem.members.read().alice.left_at);
  assert.deepEqual([mem.members.read().claude, mem.readAll().filter(e => e.kind === 'member_left')], [undefined, []], 'the host logs the leave');
});

test('seats: exit from a room hosted elsewhere while its link is offline is best effort: false, no throw (the seat lapses on the host)', t => {
  const { code, mem } = memoryRoom(t, { isHost: false });
  seats.enter({ code, name: 'alice', pid: process.pid, session_id: 'sa', pubkey: seatKey.publicPem(code, 'alice') });
  const { RoomError } = require(path.join(h.LIB, 'room', 'validate.ts'));
  t.mock.method(mem.members, 'leave', () => { throw new RoomError('OFFLINE', 'room is offline (the link is offline)'); });
  assert.equal(seats.exit(code, 'alice', 'session ended'), false);
});

test('seats: exit on the host still throws a store error (nothing to lapse it)', t => {
  const { code, mem } = memoryRoom(t, { isHost: true });
  seats.enter({ code, name: 'alice', pid: process.pid, session_id: 'sa', pubkey: seatKey.publicPem(code, 'alice') });
  const { RoomError } = require(path.join(h.LIB, 'room', 'validate.ts'));
  t.mock.method(mem.members, 'leave', () => { throw new RoomError('LOCK', 'busy'); });
  assert.throws(() => seats.exit(code, 'alice', 'session ended'), /busy/);
});

test('identity on a mirror: a seat of this machine is resolved, rebound after /clear and renewed by its index records (the streamed document has no pid or session)', t => {
  const { code, mem } = memoryRoom(t, { isHost: false });
  seats.enter({ code, name: 'alice', pid: process.pid, session_id: 'sa', pubkey: seatKey.publicPem(code, 'alice') });
  const stale = new Date(Date.now() - config.SEAT_BEAT_MS - 1000).toISOString();
  mem.members.update(ms => { const v = members.publicView(ms); v.alice.seen_at = stale; return v; }); // as the host streams it
  assert.equal(identity.resolveBySession('sa').name, 'alice');
  assert.equal(identity.resolveByPid(process.pid).name, 'alice');
  assert.equal(identity.rebindSession(process.pid, 'sb'), true);
  assert.deepEqual([identity.resolveBySession('sb').name, identity.resolveBySession('sa')], ['alice', null]);
  assert.equal('session_id' in mem.members.read().alice, false, 'the host never holds the session');
  assert.equal(identity.heartbeat(identity.resolveBySession('sb')), true);
  assert.notEqual(mem.members.read().alice.seen_at, stale);
});

test('decide on the host: once every approver answered, exactly once; an incomplete proposal is not decided', t => {
  const { code, mem } = memoryRoom(t, { isHost: true });
  for (const name of ['alice', 'bob']) mem.append({ kind: 'member_joined', text: `${name} joined`, pubkey: seatKey.publicPem(code, name) }, { via: 'system', from: name, system: true });
  mem.append({ kind: 'proposal', text: `proposal ${H}: x`, hash: H, approvers: ['alice', 'bob'] }, { via: 'agent', from: 'alice' });
  proposal.answer({ code, name: 'alice' }, { hash: H }, { choice: 'Agree' });
  assert.equal(proposal.decide(code, H), null, 'bob has not answered');
  assert.equal(proposal.answer({ code, name: 'alice' }, { hash: H }, { choice: 'Object' }).stale, true, 'one answer per person');
  proposal.answer({ code, name: 'bob' }, { hash: H }, { choice: 'Object', notes: 'not yet' });
  const d = proposal.decide(code, H);
  assert.equal(d.text, `objected: bob · agreed: alice (proposal ${H})`);
  assert.equal(proposal.decide(code, H), null, 'decided already');
  assert.equal(mem.readAll().filter(e => e.kind === 'decision').length, 1);
});

test('members.publicView: other machines never see a seat\'s pid, pid_start, session_id or cwd', () => {
  const ms = { alice: { name: 'alice', role: 'member', machine: 'm1', pid: 42, pid_start: 7, session_id: 's', cwd: '/x', joined_at: 'j', seen_at: 's' } };
  assert.deepEqual(members.publicView(ms), { alice: { name: 'alice', role: 'member', machine: 'm1', joined_at: 'j', seen_at: 's' } });
  assert.equal(ms.alice.pid, 42, 'the document itself is unchanged');
  assert.deepEqual(members.LOCAL_FIELDS, ['pid', 'pid_start', 'session_id', 'cwd']);
});
