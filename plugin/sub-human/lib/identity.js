'use strict';
/**
 * plugin/sub-human/lib/identity.js: where rooms live, who is in them, and which Claude session is asking.
 * CommonJS, zero dependencies, Node 24. Identity is bound at join by a hook and never chosen by the model.
 * Participants are collaborators: there is no process-ancestry proof and no pid-start check. A seat is
 * found by a direct lookup of the session id (hooks) or of a registered claude pid (MCP server, CLI).
 *
 * Location:
 *   home() -> string                     SUB_HUMAN_HOME, else ~/.sub-human (read on every call)
 *   roomDir(code) -> string              <home>/rooms/<code>
 *   newCode() -> string                  "otter-4821": a fresh room, created with an exclusive mkdir
 *   roomExists(code) -> bool
 *   openRooms() -> [code]                rooms with a live orchestrator (not left, pid alive), newest first
 *
 * Members (<roomDir>/members.json, written under a lock, atomically):
 *   readMembers(code) -> {name: {name, role, pid, session_id, cwd, joined_at, left_at?}}
 *   join({code, name, role, pid, session_id, cwd}) -> {ok, error?, rejoin?}
 *       role is "orch" or "member". NAME_RE; reserved names orch, room, all, system (only role orch may use
 *       "orch", and role orch must use it). A name held by a different live, not-left pid is "name taken";
 *       otherwise the name is (re)bound. One seat per claude pid: joining elsewhere retires its previous seat.
 *       Writes the indexes <home>/sessions/by-pid/<pid>.json and <home>/sessions/by-sid/<sid>.json.
 *   leave(code, name) -> bool            sets left_at and drops the by-pid index. The by-sid index stays so
 *                                        lastSeat() can find the seat when that session is resumed.
 *   rebindSession(pid, sid) -> bool      after /clear: point a new session id at the seat registered for pid
 *
 * Resolution (each returns {code, name, role, session_id, pid} or null):
 *   resolveBySession(sid)                hooks: the payload's session_id
 *   resolveByPid(pid)                    the MCP server: process.ppid, a direct lookup of a registered pid
 *   resolveSelf()                        the CLI and monitor: CLAUDE_CODE_SESSION_ID (set by Claude Code for
 *                                        Bash, monitors, hooks and the status line), then CLAUDE_PID (same
 *                                        children), then the nearest ancestor pid with a registration
 *   lastSeat(sid) -> {code, name, role}|null   the seat a session id last held, left or not (for --resume)
 *   claudePid() -> int|null              CLAUDE_PID from the environment (hooks run with it set)
 *
 * Presence (<roomDir>/presence/<name>.json = {state, at, detail?}):
 *   writePresence(code, name, state, detail?)   state: working (prompt submitted / joined) | idle (idle_prompt)
 *                                               | permission (permission_prompt) | error (StopFailure; detail = code)
 *   readPresence(code) -> {name: {state, at, detail?}}
 *
 * Also: withLock(lockPath, fn) (the lockfile helper room.js shares), isAlive, readJson, writeJsonAtomic,
 *   readMembersFile(file), NAME_RE, CODE_RE, RESERVED, ANIMALS, PRESENCE_STATES.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const NAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;
const CODE_RE = /^[a-z]+-\d{4}$/;
const SID_RE = /^[A-Za-z0-9_-]{1,128}$/;
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
const presenceDir = code => path.join(roomDir(code), 'presence');

function newCode() {
  fs.mkdirSync(roomsDir(), { recursive: true });
  for (let i = 0; i < 200; i++) {
    const word = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
    const code = `${word}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
    try { fs.mkdirSync(roomDir(code)); return code; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('could not allocate a room code');
}

// ---------- files ----------
function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

const rm = file => { try { fs.unlinkSync(file); } catch { /* already gone */ } };

// ---------- locking (shared with room.js) ----------
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function isAlive(pid) {
  pid = Number(pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function lockStale(lock) {
  let st, body;
  try { st = fs.statSync(lock); body = fs.readFileSync(lock, 'utf8'); } catch { return false; }
  const [pid, host] = body.split(' ');
  if (host === os.hostname() && Number(pid) > 0 && !isAlive(Number(pid))) return true;
  return Date.now() - st.mtimeMs > 10_000; // locks are held for milliseconds; 10 s means a crash
}

/** Run fn while holding an exclusive lockfile. A lock left by a dead process (or older than 10 s) is removed. */
function withLock(lock, fn, LockError = Error) {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + 15_000;
  let fd;
  for (;;) {
    try { fd = fs.openSync(lock, 'wx'); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (lockStale(lock)) { rm(lock); continue; }
      if (Date.now() > deadline) { const err = new LockError(`could not acquire ${lock}`); err.code = 'LOCK'; throw err; }
      sleepSync(2 + Math.floor(Math.random() * 8));
    }
  }
  try {
    fs.writeSync(fd, `${process.pid} ${os.hostname()} ${Date.now()}`);
    return fn();
  } finally {
    fs.closeSync(fd);
    rm(lock);
  }
}

// ---------- members ----------
const readMembersFile = file => readJson(file, {}) || {};
function readMembers(code) {
  try { return readMembersFile(membersFile(code)); } catch { return {}; }
}

const fail = error => ({ ok: false, error });
const validPid = pid => Number.isInteger(pid) && pid > 0;

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
      if (!cur.left_at && cur.pid !== pid && isAlive(cur.pid)) { result = fail(`name taken: "${name}" is already in ${code}`); return; }
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
    members[name] = { name, role, pid, session_id: session_id || null, cwd: cwd || null, joined_at: new Date().toISOString() };
    writeJsonAtomic(membersFile(code), members);
    const rec = { code, name, role, pid, session_id: session_id || null };
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
  let m;
  withLock(membersFile(code) + '.lock', () => {
    const members = readMembers(code);
    m = members[name];
    if (!m || m.left_at) { m = null; return; }
    m.left_at = new Date().toISOString();
    writeJsonAtomic(membersFile(code), members);
  });
  if (!m) return false;
  const p = readJson(byPidFile(m.pid));
  if (p && p.code === code && p.name === name) rm(byPidFile(m.pid));
  return true;
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
    const rec = { code: who.code, name: who.name, role: m.role, pid: m.pid, session_id: sid };
    writeJsonAtomic(byPidFile(m.pid), rec);
    writeJsonAtomic(bySidFile(sid), rec);
    ok = true;
  });
  return ok;
}

// ---------- resolution ----------
const seat = (code, m) => ({ code, name: m.name, role: m.role, session_id: m.session_id || null, pid: m.pid });

function resolveByPid(pid) {
  pid = Number(pid);
  if (!validPid(pid)) return null;
  const rec = readJson(byPidFile(pid));
  if (!rec || !roomExists(rec.code)) return null;
  const m = readMembers(rec.code)[rec.name];
  if (!m || m.left_at || m.pid !== pid) return null;
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
  return { code: rec.code, name: rec.name, role: rec.role === 'orch' ? 'orch' : 'member' };
}

const claudePid = () => { const p = Number(process.env.CLAUDE_PID); return validPid(p) ? p : null; };

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
  const bySid = resolveBySession(process.env.CLAUDE_CODE_SESSION_ID);
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
function openRooms() {
  let codes;
  try { codes = fs.readdirSync(roomsDir()).filter(c => CODE_RE.test(c)); } catch { return []; }
  const open = [];
  for (const code of codes) {
    const o = readMembers(code).orch;
    if (o && o.role === 'orch' && !o.left_at && isAlive(o.pid)) open.push({ code, at: o.joined_at || '' });
  }
  return open.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).map(r => r.code);
}

// ---------- presence ----------
function writePresence(code, name, state, detail) {
  if (!NAME_RE.test(String(name)) || !PRESENCE_STATES.includes(state)) return false;
  const v = { state, at: new Date().toISOString() };
  if (detail) v.detail = String(detail).slice(0, 200);
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
  home, roomDir, newCode, roomExists, openRooms,
  readMembers, readMembersFile, join, leave, rebindSession,
  isAlive, claudePid,
  resolveByPid, resolveBySession, resolveSelf, lastSeat,
  writePresence, readPresence,
  withLock, readJson, writeJsonAtomic,
};
