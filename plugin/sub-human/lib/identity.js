'use strict';
/**
 * plugin/sub-human/lib/identity.js: where rooms live, who is in them, and which Claude session is asking.
 * CommonJS, zero dependencies, Node 24. Identity is bound at join by a hook and never chosen by the model.
 * Participants are collaborators: there is no process-ancestry proof. A seat is found by a direct lookup of
 * the session id (hooks) or of a registered claude pid (MCP server, CLI). Every seat stores its process start
 * time (pid_start, epoch s, lib/lock.js pidStart), so a reused pid never keeps a dead seat alive or adopts it.
 *
 * Location:
 *   home() -> string                     SUB_HUMAN_HOME, else ~/.sub-human (read on every call; lib/home.js)
 *   roomDir(code) -> string              <home>/rooms/<code> (lib/home.js; validates the code)
 *   newCode() -> string                  "otter-4821": a fresh room, created with an exclusive mkdir
 *   roomExists(code) -> bool
 *   openRooms() -> [code]                rooms with >= 1 live member seat (role member) that are not closing,
 *                                        newest first. No orch seat is needed: the first member opens it. A room
 *                                        where only the orch is left is not open (see orphanRooms).
 *   orphanRooms() -> [code]              rooms not closing whose orch is not stopped but which have no live member
 *                                        (join sweeps these through orch.watchdog)
 *   roomOpen(code) -> bool               not closing and has any live seat, the orch included (a resume may
 *                                        rejoin a room whose orch is waiting out the reap grace)
 *   roomClosing(code) -> bool            members orch.closing is set (the reaper is shutting the room down)
 *
 * Members (the room's members document, lib/room/store.js members: changed only through update(), atomic):
 *   readMembers(code) -> {name: {name, role, pid, pid_start?, session_id, cwd, joined_at, seen_at?, left_at?}}
 *       The "orch" record also carries {job, spawned_at, closing?, stopped_at?, claim?, by?, ...} (lib/orch.js);
 *       before the spawned orch binds, it is {name:"orch", role:"orch", pid:null, job, spawned_at}, and while a
 *       spawn is in flight job is "pending".
 *   setOrch(code, patch) -> record       merge patch into members.orch under the lock (creates the record)
 *   updateOrch(code, fn) -> record|null  under the lock: fn(orch record or null, members) returns a patch to
 *                                        merge (the new record is returned) or null to write nothing (null)
 *   seatAlive(m) -> bool                 not left, and pid alive with its start time matching pid_start (a seat
 *                                        with no pid_start, or a pid whose start ps cannot read, counts as
 *                                        matching); a seat with no pid: its lease (seen_at) is fresh
 *   heartbeat(me, now?) -> bool          renew me's lease, seen_at (at most every SEAT_BEAT_MS; the tail's health
 *                                        tick and the hold server); leaseFresh(m, now?)
 *   liveMembers(code) -> [name]          non-orch seats that are seatAlive
 *   join({code, name, role, pid, session_id, cwd}) -> {ok, error?, rejoin?}
 *       role is "orch" or "member". NAME_RE; reserved names orch, room, all, system (only role orch may use
 *       "orch", and role orch must use it). A name held by a different live, not-left pid is "name taken";
 *       otherwise the name is (re)bound. One seat per claude pid: joining elsewhere retires its previous seat.
 *       The orch record keeps its job / spawned_at across a (re)bind.
 *       Writes the indexes <home>/sessions/by-pid/<pid>.json and <home>/sessions/by-sid/<sid>.json.
 *   leave(code, name) -> bool            sets left_at and drops the by-pid index (both under the members lock).
 *                                        The by-sid index stays so lastSeat() can find the seat on --resume.
 *   rebindSession(pid, sid) -> bool      after /clear: point a new session id at the seat registered for pid
 *
 * Resolution (each returns the identity record {code, name, role, session_id, pid, address} or null;
 * address = "NAME.CODE", the session title other Claudes reach it by with SendMessage):
 *   resolveBySession(sid)                hooks: the payload's session_id
 *   resolveByPid(pid)                    the MCP server: process.ppid, a direct lookup of a registered pid
 *                                        (null when that pid now belongs to a process with another start time)
 *   resolveSelf()                        the CLI and the tail: CLAUDE_CODE_SESSION_ID (set by Claude Code for
 *                                        Bash, hooks and the status line; the mod sets it for its tail child), then CLAUDE_PID (same
 *                                        children), then the nearest ancestor pid with a registration
 *   lastSeat(sid) -> {code, name, role}|null   the seat a session id last held, left or not (for --resume)
 *   claudePid() -> int|null              CLAUDE_PID from the environment (hooks run with it set; lib/cc.js)
 *
 * The hooks module's lease (hooks/mod-hello.js; docs/next/MODS-PLAN.md W1):
 *   writeModLease(sid, rec) -> bool      <home>/sessions/mods/<sid>.json = {session_id, at, ...rec} (atomic, 0600):
 *                                        this session's function hooks are loaded and have said hello
 *   readModLease(sid) -> rec|null
 *
 * Presence (the room documents presence/<name> = {state, at, detail?}, lib/room/store.js kv):
 *   writePresence(code, name, state, detail?)   state: working (prompt submitted / joined) | idle (idle_prompt)
 *                                               | permission (permission_prompt) | error (StopFailure; detail = code)
 *   readPresence(code) -> {name: {state, at, detail?}}
 *
 * Also: isAlive (lib/io.js), NAME_RE, CODE_RE, RESERVED, ANIMALS, PRESENCE_STATES.
 * Room state (members, presence, the room list) goes through lib/room/store.js; members are changed only with
 * members.update (atomic). The session indexes (<home>/sessions/, which seat a local pid or session id holds) are
 * this machine's, not the room's, and stay here.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { readJson, writeJsonAtomic, isAlive } = require('./io.js');
const { home, roomDir } = require('./home.js');
const { pidStart } = require('./lock.js');
const { NAME_RE, CODE_RE, SID_SAFE: SID_RE } = require('./text.js');
const { PRESENCE_DETAIL_MAX, PID_START_SLACK_S, SEAT_BEAT_MS, SEAT_LEASE_MS } = require('./config.js');
const cc = require('./cc.js');
const RESERVED = ['orch', 'room', 'all', 'system'];
const ROLES = ['orch', 'member'];
const PRESENCE_STATES = ['working', 'idle', 'permission', 'error'];
const ANIMALS = [
  'otter', 'badger', 'beaver', 'bison', 'camel', 'cheetah', 'condor', 'coyote',
  'crane', 'dingo', 'dolphin', 'eagle', 'egret', 'falcon', 'ferret', 'finch',
  'gecko', 'gibbon', 'gopher', 'heron', 'hippo', 'husky', 'ibex', 'iguana',
  'jackal', 'jaguar', 'koala', 'lemur', 'leopard', 'llama', 'lynx', 'macaw',
  'marmot', 'marten', 'mink', 'moose', 'narwhal', 'newt', 'ocelot', 'orca',
  'osprey', 'panda', 'parrot', 'pelican', 'penguin', 'puffin', 'quail', 'rabbit',
  'raven', 'salmon', 'seal', 'shrew', 'sloth', 'stoat', 'swan', 'tapir',
  'tiger', 'toucan', 'turtle', 'vole', 'walrus', 'weasel', 'wombat', 'zebra',
];

// ---------- location ----------
const store = require('./room/store.js');
const roomExists = code => store.roomExists(code);
const byPidFile = pid => path.join(home(), 'sessions', 'by-pid', `${Number(pid)}.json`);
const bySidFile = sid => path.join(home(), 'sessions', 'by-sid', `${sid}.json`);
const modLeaseFile = sid => path.join(home(), 'sessions', 'mods', `${sid}.json`);
const address = (name, code) => `${name}.${code}`;
/** The room's members document (lib/room/store.js members: read(), update(fn) atomic). */
const membersOf = code => store.open(code).members;

function newCode() {
  for (let i = 0; i < 200; i++) {
    const word = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
    const code = `${word}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
    if (store.createRoom(code)) return code;
  }
  throw new Error('could not allocate a room code');
}

const rm = file => { try { fs.unlinkSync(file); } catch { /* already gone */ } };

// ---------- members ----------
function readMembers(code) {
  try { return membersOf(code).read(); } catch { return {}; }
}

const fail = error => ({ ok: false, error });
const ORCH_FIELDS = ['job', 'spawned_at', 'closing', 'by', 'job_session', 'claim']; // kept across the orch's (re)bind
const validPid = pid => Number.isInteger(pid) && pid > 0;

/** The stored start time still describes the process now holding m.pid (tolerates legacy / unreadable). */
function startMatches(m) {
  if (!m || m.pid_start == null) return true;
  const s = pidStart(m.pid);
  return s == null || Math.abs(s - Number(m.pid_start)) <= PID_START_SLACK_S;
}
/** The seat's lease: seen_at (join, then identity.heartbeat) younger than SEAT_LEASE_MS. */
const leaseFresh = (m, now = Date.now()) => { const t = Date.parse(m && m.seen_at); return Number.isFinite(t) && now - t < SEAT_LEASE_MS; };
/**
 * Not left, and: its pid is alive with a matching start time (this machine: the primary check), or, for a seat
 * with no pid to check (a store off this machine), its lease is fresh.
 */
function seatAlive(m) { // unary: callers pass it to filter/some
  if (!m || !m.name || m.left_at) return false;
  if (validPid(m.pid)) return isAlive(m.pid) && startMatches(m);
  return leaseFresh(m);
}

/**
 * Renew me's lease (members seen_at), at most every SEAT_BEAT_MS: the tail's health tick and the hold server
 * call it. Only for the seat as me holds it (same pid when me has one; not left). Returns true when written.
 */
function heartbeat(me, now = Date.now()) {
  if (!me || !me.code || !me.name || !roomExists(me.code)) return false;
  const stale = m => !!m && !m.left_at && (!validPid(me.pid) || m.pid === me.pid) && !(Date.parse(m.seen_at) > now - SEAT_BEAT_MS);
  if (!stale(readMembers(me.code)[me.name])) return false; // the cheap check, before the lock
  let wrote = false;
  membersOf(me.code).update(ms => {
    const m = ms[me.name];
    if (!stale(m)) return null;
    m.seen_at = new Date(now).toISOString();
    wrote = true;
    return ms;
  });
  return wrote;
}

function join({ code, name, role, pid, session_id, cwd } = {}) {
  if (!roomExists(code)) return fail(`no room "${code}"`);
  if (typeof name !== 'string' || !NAME_RE.test(name)) return fail(`invalid name "${name}" (letters, digits, . _ -, up to 32)`);
  if (!ROLES.includes(role)) return fail(`invalid role "${role}"`);
  if (RESERVED.includes(name.toLowerCase()) && !(name === 'orch' && role === 'orch')) return fail(`"${name}" is reserved`);
  if (role === 'orch' && name !== 'orch') return fail('the orchestrator joins as "orch"');
  pid = Number(pid);
  if (!validPid(pid)) return fail(`invalid pid "${pid}"`);
  if (session_id != null && (typeof session_id !== 'string' || !SID_RE.test(session_id))) return fail('invalid session_id');

  let result;
  // Under the members CAS: the session indexes are written inside it (idempotent), so a concurrent leave
  // cannot drop the pid index of a seat this join just took.
  membersOf(code).update(members => {
    const cur = members[name];
    let rejoin = false;
    if (cur) {
      if (cur.pid !== pid && seatAlive(cur)) { result = fail(`name taken: "${name}" is already in ${code}`); return null; }
      rejoin = true;
    }
    // One seat per claude process: retire its previous registration.
    const prev = readJson(byPidFile(pid));
    if (prev && (prev.code !== code || prev.name !== name)) {
      try {
        if (prev.code === code) { if (members[prev.name] && members[prev.name].pid === pid && !members[prev.name].left_at) members[prev.name].left_at = new Date().toISOString(); }
        else markLeft(prev.code, prev.name, pid);
      } catch { /* old room gone */ }
    }
    const keep = {};
    if (role === 'orch' && cur) for (const k of ORCH_FIELDS) if (cur[k] != null) keep[k] = cur[k];
    const start = pidStart(pid);
    const now = new Date().toISOString();
    members[name] = { name, role, pid, ...(start != null ? { pid_start: start } : {}), session_id: session_id || null, cwd: cwd || null, joined_at: now, seen_at: now, ...keep };
    const rec = { code, name, role, pid, ...(start != null ? { pid_start: start } : {}), session_id: session_id || null, address: address(name, code) };
    writeJsonAtomic(byPidFile(pid), rec);
    if (session_id) writeJsonAtomic(bySidFile(session_id), rec);
    result = rejoin ? { ok: true, rejoin: true } : { ok: true };
    return members;
  });
  return result;
}

function markLeft(code, name, pid) {
  membersOf(code).update(members => {
    if (!(members[name] && members[name].pid === pid && !members[name].left_at)) return null;
    members[name].left_at = new Date().toISOString();
    return members;
  });
}

function leave(code, name) {
  if (!roomExists(code)) return false;
  let left = false;
  membersOf(code).update(members => {
    const m = members[name];
    if (!m || m.left_at) return null;
    m.left_at = new Date().toISOString();
    // Drop the pid index inside the CAS, so a concurrent join cannot be undone by it.
    if (validPid(m.pid)) {
      const p = readJson(byPidFile(m.pid));
      if (p && p.code === code && p.name === name) rm(byPidFile(m.pid));
    }
    left = true;
    return members;
  });
  return left;
}

function rebindSession(pid, sid) {
  if (typeof sid !== 'string' || !SID_RE.test(sid)) return false;
  const who = resolveByPid(pid);
  if (!who) return false;
  let ok = false;
  membersOf(who.code).update(members => {
    const m = members[who.name];
    if (!m) return null;
    if (m.session_id && m.session_id !== sid) rm(bySidFile(m.session_id));
    m.session_id = sid;
    const rec = { code: who.code, name: who.name, role: m.role, pid: m.pid, ...(m.pid_start != null ? { pid_start: m.pid_start } : {}), session_id: sid, address: address(who.name, who.code) };
    writeJsonAtomic(byPidFile(m.pid), rec);
    writeJsonAtomic(bySidFile(sid), rec);
    ok = true;
    return members;
  });
  return ok;
}

// ---------- resolution ----------
const seat = (code, m) => ({ code, name: m.name, role: m.role, session_id: m.session_id || null, pid: m.pid, address: address(m.name, code) });

function resolveByPid(pid) {
  pid = Number(pid);
  if (!validPid(pid)) return null;
  const rec = readJson(byPidFile(pid));
  if (!rec || !roomExists(rec.code)) return null;
  const m = readMembers(rec.code)[rec.name];
  if (!m || m.left_at || m.pid !== pid || !startMatches(m)) return null;
  return seat(rec.code, m);
}

function resolveBySession(sid) {
  if (typeof sid !== 'string' || !SID_RE.test(sid)) return null;
  const rec = readJson(bySidFile(sid));
  if (!rec || !roomExists(rec.code)) return null;
  const m = readMembers(rec.code)[rec.name];
  if (!m || m.left_at || m.session_id !== sid) return null;
  return seat(rec.code, m);
}

function writeModLease(sid, rec = {}) {
  if (typeof sid !== 'string' || !SID_RE.test(sid)) return false;
  writeJsonAtomic(modLeaseFile(sid), { ...rec, session_id: sid, at: new Date().toISOString() });
  return true;
}

function readModLease(sid) {
  if (typeof sid !== 'string' || !SID_RE.test(sid)) return null;
  return readJson(modLeaseFile(sid));
}

function lastSeat(sid) {
  if (typeof sid !== 'string' || !SID_RE.test(sid)) return null;
  const rec = readJson(bySidFile(sid));
  if (!rec || !roomExists(rec.code) || !NAME_RE.test(String(rec.name))) return null;
  return { code: rec.code, name: rec.name, role: rec.role === 'orch' ? 'orch' : 'member', address: address(rec.name, rec.code) };
}

const claudePid = () => cc.claudePid();

function parentTable() {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 16 << 20 });
  const t = new Map();
  for (const line of (r.stdout || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)/);
    if (m) t.set(Number(m[1]), Number(m[2]));
  }
  return t;
}

function resolveSelf() {
  const bySid = resolveBySession(cc.sessionId());
  if (bySid) return bySid;
  const env = claudePid();
  if (env) { const r = resolveByPid(env); if (r) return r; }
  // Fallback: the nearest ancestor that has a registration (only registered pids are looked up).
  let table = null;
  let pid = process.pid;
  const seen = new Set();
  while (pid > 1 && !seen.has(pid)) {
    seen.add(pid);
    if (fs.existsSync(byPidFile(pid))) { const r = resolveByPid(pid); if (r) return r; }
    if (!table) table = parentTable();
    const pp = pid === process.pid ? process.ppid : table.get(pid);
    if (!pp) break;
    pid = pp;
  }
  return null;
}

// ---------- rooms ----------
const isMember = m => !!m && m.role !== 'orch';
const liveMembers = code => Object.values(readMembers(code)).filter(m => isMember(m) && seatAlive(m)).map(m => m.name);
const roomClosing = code => { const o = readMembers(code).orch; return !!(o && o.closing); };

const roomCodes = () => store.listRooms();

function openRooms() {
  const open = [];
  for (const code of roomCodes()) {
    const ms = readMembers(code);
    if (ms.orch && ms.orch.closing) continue;
    const live = Object.values(ms).filter(m => isMember(m) && seatAlive(m));
    if (live.length) open.push({ code, at: live.map(m => m.joined_at || '').sort().at(-1) });
  }
  return open.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).map(r => r.code);
}

/** The orch record still owns a job or a live seat (not stopped, not left). */
const orchActive = o => !!o && !o.stopped_at && (seatAlive(o) || (!o.left_at && !!o.job));

function orphanRooms() {
  const out = [];
  for (const code of roomCodes()) {
    const ms = readMembers(code);
    const o = ms.orch;
    if (!o || o.closing || !orchActive(o)) continue;
    if (!Object.values(ms).some(m => isMember(m) && seatAlive(m))) out.push(code);
  }
  return out;
}

function roomOpen(code) {
  if (!roomExists(code)) return false;
  const ms = readMembers(code);
  if (ms.orch && ms.orch.closing) return false;
  return Object.values(ms).some(seatAlive);
}

function updateOrch(code, fn) {
  if (!roomExists(code)) throw new Error(`no room "${code}"`);
  let rec = null;
  membersOf(code).update(members => {
    rec = null;
    const patch = fn(members.orch || null, members);
    if (!patch) return null;
    rec = { name: 'orch', role: 'orch', pid: null, ...(members.orch || {}), ...patch };
    for (const k of Object.keys(rec)) if (rec[k] === undefined) delete rec[k];
    members.orch = rec;
    return members;
  });
  return rec;
}

const setOrch = (code, patch = {}) => updateOrch(code, () => patch);

// ---------- presence ----------
function writePresence(code, name, state, detail) {
  if (!NAME_RE.test(String(name)) || !PRESENCE_STATES.includes(state)) return false;
  const v = { state, at: new Date().toISOString() };
  if (detail) v.detail = String(detail).slice(0, PRESENCE_DETAIL_MAX);
  try { store.open(code).kv.set(`presence/${name}`, v); return true; } catch { return false; }
}

function readPresence(code) {
  const out = {};
  let kv;
  try { kv = store.open(code).kv; } catch { return out; }
  for (const key of kv.list('presence/')) {
    const name = key.slice('presence/'.length);
    const v = kv.get(key);
    if (NAME_RE.test(name) && v && PRESENCE_STATES.includes(v.state)) out[name] = v;
  }
  return out;
}

module.exports = {
  NAME_RE, CODE_RE, RESERVED, ANIMALS, PRESENCE_STATES,
  home, roomDir, newCode, roomExists, openRooms, orphanRooms, roomOpen, roomClosing, address,
  readMembers, join, leave, rebindSession, setOrch, updateOrch, liveMembers, seatAlive, heartbeat, leaseFresh,
  isAlive, claudePid,
  resolveByPid, resolveBySession, resolveSelf, lastSeat, writeModLease, readModLease,
  writePresence, readPresence,
};
