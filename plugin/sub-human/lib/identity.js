'use strict';
/**
 * plugin/sub-human/lib/identity.js: where rooms live, who is in them, and which Claude session is asking.
 * CommonJS, zero dependencies, Node 24. Identity is bound at join by a hook and never chosen by the model.
 * Participants are collaborators: there is no process-ancestry proof. A seat is found by a direct lookup of
 * the session id (hooks) or of a registered claude pid (MCP server, CLI). Every seat stores its process start
 * time (pid_start, epoch s, lib/lock.js pidStart), so a reused pid never keeps a dead seat alive or adopts it.
 *
 * Location:
 *   home() -> string                     SUB_HUMAN_HOME, else ~/.sub-human (read on every call)
 *   roomDir(code) -> string              <home>/rooms/<code>
 *   newCode() -> string                  "otter-4821": a fresh room, created with an exclusive mkdir
 *   roomExists(code) -> bool
 *   openRooms() -> [code]                rooms with >= 1 live member seat (role member) that are not closing,
 *                                        newest first. No orch seat is needed: the first member opens it. A room
 *                                        where only the orch is left is not open (see orphanRooms).
 *   orphanRooms() -> [code]              rooms not closing whose orch is not stopped but which have no live member
 *                                        (join sweeps these through orch.watchdog)
 *   roomOpen(code) -> bool               not closing and has any live seat, the orch included (a resume may
 *                                        rejoin a room whose orch is waiting out the reap grace)
 *   roomClosing(code) -> bool            members.json orch.closing is set (the reaper is shutting the room down)
 *
 * Members (<roomDir>/members.json, written under a lock, atomically):
 *   readMembers(code) -> {name: {name, role, pid, pid_start?, session_id, cwd, joined_at, left_at?}}
 *       The "orch" record also carries {job, spawned_at, closing?, stopped_at?, claim?, by?, ...} (lib/orch.js);
 *       before the spawned orch binds, it is {name:"orch", role:"orch", pid:null, job, spawned_at}, and while a
 *       spawn is in flight job is "pending".
 *   setOrch(code, patch) -> record       merge patch into members.orch under the lock (creates the record)
 *   updateOrch(code, fn) -> record|null  under the lock: fn(orch record or null, members) returns a patch to
 *                                        merge (the new record is returned) or null to write nothing (null)
 *   seatAlive(m) -> bool                 not left, pid alive, and its start time matches pid_start (a seat with
 *                                        no pid_start, or a pid whose start ps cannot read, counts as matching)
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
 *   resolveSelf()                        the CLI and monitor: CLAUDE_CODE_SESSION_ID (set by Claude Code for
 *                                        Bash, monitors, hooks and the status line), then CLAUDE_PID (same
 *                                        children), then the nearest ancestor pid with a registration
 *   lastSeat(sid) -> {code, name, role}|null   the seat a session id last held, left or not (for --resume)
 *   claudePid() -> int|null              CLAUDE_PID from the environment (hooks run with it set; lib/cc.js)
 *
 * Presence (<roomDir>/presence/<name>.json = {state, at, detail?}):
 *   writePresence(code, name, state, detail?)   state: working (prompt submitted / joined) | idle (idle_prompt)
 *                                               | permission (permission_prompt) | error (StopFailure; detail = code)
 *   readPresence(code) -> {name: {state, at, detail?}}
 *
 * Also: isAlive (lib/io.js), readMembersFile(file), NAME_RE, CODE_RE, RESERVED, ANIMALS, PRESENCE_STATES.
 * members.json and the session indexes are written under lib/lock.js withLock, atomically (lib/io.js).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { readJson, writeJsonAtomic, isAlive } = require('./io.js');
const { withLock, pidStart } = require('./lock.js');
const { NAME_RE, CODE_RE, SID_SAFE: SID_RE } = require('./text.js');
const { PRESENCE_DETAIL_MAX, PID_START_SLACK_S } = require('./config.js');
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
const home = () => process.env.SUB_HUMAN_HOME || path.join(os.homedir(), '.sub-human');
const roomsDir = () => path.join(home(), 'rooms');
function roomDir(code) {
  if (typeof code !== 'string' || !CODE_RE.test(code)) throw new Error(`invalid room code "${code}"`);
  return path.join(roomsDir(), code);
}
const roomExists = code => typeof code === 'string' && CODE_RE.test(code) && fs.existsSync(roomDir(code));
const byPidFile = pid => path.join(home(), 'sessions', 'by-pid', `${Number(pid)}.json`);
const bySidFile = sid => path.join(home(), 'sessions', 'by-sid', `${sid}.json`);
const membersFile = code => path.join(roomDir(code), 'members.json');
const address = (name, code) => `${name}.${code}`;
const presenceDir = code => path.join(roomDir(code), 'presence');

function newCode() {
  fs.mkdirSync(roomsDir(), { recursive: true, mode: 0o700 }); // the home and rooms/ too when new: private
  for (let i = 0; i < 200; i++) {
    const word = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
    const code = `${word}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
    try { fs.mkdirSync(roomDir(code), { mode: 0o700 }); return code; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('could not allocate a room code');
}

const rm = file => { try { fs.unlinkSync(file); } catch { /* already gone */ } };

// ---------- members ----------
const readMembersFile = file => readJson(file, {}) || {};
function readMembers(code) {
  try { return readMembersFile(membersFile(code)); } catch { return {}; }
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
const seatAlive = m => !!m && !!m.name && !m.left_at && validPid(m.pid) && isAlive(m.pid) && startMatches(m);

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
  withLock(membersFile(code) + '.lock', () => {
    const members = readMembers(code);
    const cur = members[name];
    let rejoin = false;
    if (cur) {
      if (cur.pid !== pid && seatAlive(cur)) { result = fail(`name taken: "${name}" is already in ${code}`); return; }
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
    members[name] = { name, role, pid, ...(start != null ? { pid_start: start } : {}), session_id: session_id || null, cwd: cwd || null, joined_at: new Date().toISOString(), ...keep };
    writeJsonAtomic(membersFile(code), members);
    const rec = { code, name, role, pid, ...(start != null ? { pid_start: start } : {}), session_id: session_id || null, address: address(name, code) };
    writeJsonAtomic(byPidFile(pid), rec);
    if (session_id) writeJsonAtomic(bySidFile(session_id), rec);
    result = rejoin ? { ok: true, rejoin: true } : { ok: true };
  });
  return result;
}

function markLeft(code, name, pid) {
  withLock(membersFile(code) + '.lock', () => {
    const members = readMembers(code);
    if (members[name] && members[name].pid === pid && !members[name].left_at) {
      members[name].left_at = new Date().toISOString();
      writeJsonAtomic(membersFile(code), members);
    }
  });
}

function leave(code, name) {
  if (!roomExists(code)) return false;
  let left = false;
  withLock(membersFile(code) + '.lock', () => {
    const members = readMembers(code);
    const m = members[name];
    if (!m || m.left_at) return;
    m.left_at = new Date().toISOString();
    writeJsonAtomic(membersFile(code), members);
    // Drop the pid index while still holding the lock, so a concurrent join cannot be undone by it.
    if (validPid(m.pid)) {
      const p = readJson(byPidFile(m.pid));
      if (p && p.code === code && p.name === name) rm(byPidFile(m.pid));
    }
    left = true;
  });
  return left;
}

function rebindSession(pid, sid) {
  if (typeof sid !== 'string' || !SID_RE.test(sid)) return false;
  const who = resolveByPid(pid);
  if (!who) return false;
  let ok = false;
  withLock(membersFile(who.code) + '.lock', () => {
    const members = readMembers(who.code);
    const m = members[who.name];
    if (!m) return;
    if (m.session_id && m.session_id !== sid) rm(bySidFile(m.session_id));
    m.session_id = sid;
    writeJsonAtomic(membersFile(who.code), members);
    const rec = { code: who.code, name: who.name, role: m.role, pid: m.pid, ...(m.pid_start != null ? { pid_start: m.pid_start } : {}), session_id: sid, address: address(who.name, who.code) };
    writeJsonAtomic(byPidFile(m.pid), rec);
    writeJsonAtomic(bySidFile(sid), rec);
    ok = true;
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

const roomCodes = () => { try { return fs.readdirSync(roomsDir()).filter(c => CODE_RE.test(c)); } catch { return []; } };

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
  withLock(membersFile(code) + '.lock', () => {
    const members = readMembers(code);
    const patch = fn(members.orch || null, members);
    if (!patch) return;
    rec = { name: 'orch', role: 'orch', pid: null, ...(members.orch || {}), ...patch };
    for (const k of Object.keys(rec)) if (rec[k] === undefined) delete rec[k];
    members.orch = rec;
    writeJsonAtomic(membersFile(code), members);
  });
  return rec;
}

const setOrch = (code, patch = {}) => updateOrch(code, () => patch);

// ---------- presence ----------
function writePresence(code, name, state, detail) {
  if (!NAME_RE.test(String(name)) || !PRESENCE_STATES.includes(state)) return false;
  const v = { state, at: new Date().toISOString() };
  if (detail) v.detail = String(detail).slice(0, PRESENCE_DETAIL_MAX);
  try { writeJsonAtomic(path.join(presenceDir(code), `${name}.json`), v); return true; } catch { return false; }
}

function readPresence(code) {
  const out = {};
  let files;
  try { files = fs.readdirSync(presenceDir(code)); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const name = f.slice(0, -5);
    const v = readJson(path.join(presenceDir(code), f));
    if (NAME_RE.test(name) && v && PRESENCE_STATES.includes(v.state)) out[name] = v;
  }
  return out;
}

module.exports = {
  NAME_RE, CODE_RE, RESERVED, ANIMALS, PRESENCE_STATES,
  home, roomDir, newCode, roomExists, openRooms, orphanRooms, roomOpen, roomClosing, address,
  readMembers, readMembersFile, join, leave, rebindSession, setOrch, updateOrch, liveMembers, seatAlive,
  isAlive, claudePid,
  resolveByPid, resolveBySession, resolveSelf, lastSeat,
  writePresence, readPresence,
};
