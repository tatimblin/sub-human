'use strict';
/**
 * plugin/sub-human/lib/identity.js: where rooms live, who is in them, and which Claude session is asking.
 * CommonJS, zero dependencies, Node 24. Identity is bound at join by a hook and resolved later from process
 * ancestry; it is never chosen by the model.
 *
 * Location:
 *   home() -> string                     SUB_HUMAN_HOME, else ~/.sub-human (read on every call)
 *   roomDir(code) -> string              <home>/rooms/<code>
 *   newCode() -> string                  "otter-4821": a fresh room, created with an exclusive mkdir
 *   roomExists(code) -> bool
 *
 * Members (<roomDir>/members.json, written under a lock, atomically):
 *   readMembers(code) -> {name: {name, role, pid, pid_start, session_id, cwd, joined_at, left_at?}}
 *   join({code, name, role, pid, session_id, cwd}) -> {ok, error?, rejoin?}
 *       role is "orch" or "member". NAME_RE; reserved names orch, room, all, system (only role orch may use
 *       "orch", and role orch must use it). A name held by a different live process (same pid_start) is
 *       "name taken"; a name whose holder is dead or has left is rebound (rejoin:true). Writes the indexes
 *       <home>/sessions/by-pid/<pid>.json and <home>/sessions/by-sid/<sid>.json.
 *   leave(code, name) -> bool            sets left_at and drops the indexes that point at it
 *
 * Processes (macOS / Linux, via `ps`):
 *   pidStart(pid) -> string|null         the lstart string; null when the process is gone
 *   isAlive(pid) -> bool
 *   ancestors(pid) -> [{pid, comm}]      parent first, from one `ps -A -o pid=,ppid=,comm=` walk
 *   claudePid({ppid}?) -> int|null       the claude process serving this one:
 *       {ppid:true} (the MCP server, a direct child of claude with no CLAUDE_PID) -> process.ppid;
 *       else CLAUDE_PID, accepted only if it is a real ancestor of process.pid;
 *       else the nearest ancestor whose comm basename is "claude".
 *
 * Resolution (each checks the recorded pid_start against the live process, so a reused pid never matches):
 *   resolveByPid(pid) -> {code, name, role}|null
 *   resolveBySession(sid) -> {code, name, role}|null
 *   resolveSelf() -> {code, name, role, pid}|null   first registered pid among process.pid and its ancestors
 *   rebindSession(pid, sid) -> bool      after /clear: point a new session id at an existing registration
 *
 * Also: withLock(lockPath, fn) (the lockfile helper room.js shares), readJson, writeJsonAtomic,
 *   readMembersFile(file), NAME_RE, CODE_RE, RESERVED, ANIMALS.
 * A CLAUDE_PID that is not an ancestor never resolves: nothing here trusts env for identity except as a hint
 * that is checked against the process tree.
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

// ---------- processes ----------
const psEnv = () => ({ ...process.env, LC_ALL: 'C', LANG: 'C' });

function pidStart(pid) {
  pid = Number(pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: psEnv() });
  const s = (r.stdout || '').trim().replace(/\s+/g, ' ');
  return r.status === 0 && s ? s : null;
}

function processTable() {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8', env: psEnv(), maxBuffer: 16 << 20 });
  const table = new Map();
  for (const line of (r.stdout || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s?(.*)$/);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3].trim() });
  }
  return table;
}

function ancestors(pid = process.pid) {
  const table = processTable();
  const out = [];
  const seen = new Set([Number(pid)]);
  let cur = table.get(Number(pid));
  while (cur && cur.ppid > 0 && !seen.has(cur.ppid)) {
    seen.add(cur.ppid);
    const parent = table.get(cur.ppid);
    out.push({ pid: cur.ppid, comm: parent ? parent.comm : '' });
    cur = parent;
  }
  return out;
}

const isClaudeComm = comm => {
  const c = String(comm || '');
  return path.basename(c) === 'claude' || path.basename(c.split(/\s+/)[0]) === 'claude';
};

function claudePid({ ppid = false } = {}) {
  if (ppid) return process.ppid > 1 ? process.ppid : null;
  const chain = ancestors(process.pid);
  const env = Number(process.env.CLAUDE_PID);
  if (Number.isInteger(env) && env > 0 && chain.some(a => a.pid === env)) return env;
  const c = chain.find(a => isClaudeComm(a.comm));
  return c ? c.pid : null;
}

// ---------- members ----------
const readMembersFile = file => readJson(file, {}) || {};
function readMembers(code) {
  try { return readMembersFile(membersFile(code)); } catch { return {}; }
}

const fail = error => ({ ok: false, error });

function join({ code, name, role, pid, session_id, cwd } = {}) {
  if (!roomExists(code)) return fail(`no room "${code}"`);
  if (typeof name !== 'string' || !NAME_RE.test(name)) return fail(`invalid name "${name}" (letters, digits, . _ -, up to 32)`);
  if (!ROLES.includes(role)) return fail(`invalid role "${role}"`);
  if (RESERVED.includes(name.toLowerCase()) && !(name === 'orch' && role === 'orch')) return fail(`"${name}" is reserved`);
  if (role === 'orch' && name !== 'orch') return fail('the orchestrator joins as "orch"');
  pid = Number(pid);
  const start = pidStart(pid);
  if (!start) return fail(`process ${pid} is not running`);
  if (session_id != null && (typeof session_id !== 'string' || !SID_RE.test(session_id))) return fail('invalid session_id');

  let result;
  withLock(membersFile(code) + '.lock', () => {
    const members = readMembers(code);
    const cur = members[name];
    let rejoin = false;
    if (cur) {
      const holderLive = !cur.left_at && isAlive(cur.pid) && pidStart(cur.pid) === cur.pid_start;
      if (holderLive && cur.pid !== pid) { result = fail(`name taken: "${name}" is already in ${code}`); return; }
      rejoin = true;
    }
    // A process belongs to one room seat at a time: retire its previous registration.
    const prev = readJson(byPidFile(pid));
    if (prev && (prev.code !== code || prev.name !== name) && prev.pid_start === start) {
      try {
        if (prev.code === code) { if (members[prev.name] && members[prev.name].pid === pid) members[prev.name].left_at = new Date().toISOString(); }
        else markLeft(prev.code, prev.name, pid);
      } catch { /* old room gone */ }
    }
    if (prev && prev.session_id && prev.session_id !== session_id) rm(bySidFile(prev.session_id));
    if (cur && cur.session_id && cur.session_id !== session_id && cur.pid !== pid) rm(bySidFile(cur.session_id));
    members[name] = { name, role, pid, pid_start: start, session_id: session_id || null, cwd: cwd || null,
      joined_at: new Date().toISOString() };
    writeJsonAtomic(membersFile(code), members);
    const rec = { code, name, role, pid, pid_start: start, session_id: session_id || null };
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
  if (m.session_id) {
    const s = readJson(bySidFile(m.session_id));
    if (s && s.code === code && s.name === name) rm(bySidFile(m.session_id));
  }
  return true;
}

// ---------- resolution ----------
function resolveByPid(pid) {
  pid = Number(pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const rec = readJson(byPidFile(pid));
  if (!rec || !rec.pid_start || !roomExists(rec.code)) return null;
  if (pidStart(pid) !== rec.pid_start) return null;
  const m = readMembers(rec.code)[rec.name];
  if (!m || m.left_at || m.pid !== pid || m.pid_start !== rec.pid_start) return null;
  return { code: rec.code, name: rec.name, role: m.role };
}

function resolveBySession(sid) {
  if (typeof sid !== 'string' || !SID_RE.test(sid)) return null;
  const rec = readJson(bySidFile(sid));
  return rec ? resolveByPid(rec.pid) : null;
}

function resolveSelf() {
  const table = processTable();
  let pid = process.pid;
  const seen = new Set();
  // Walk the table directly so one `ps -A` covers the whole chain; resolveByPid checks the start time.
  while (pid > 1 && !seen.has(pid)) {
    seen.add(pid);
    if (fs.existsSync(byPidFile(pid))) {
      const r = resolveByPid(pid);
      if (r) return { ...r, pid };
    }
    const row = table.get(pid);
    if (!row) break;
    pid = row.ppid;
  }
  return null;
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
    const rec = { ...readJson(byPidFile(pid)), session_id: sid };
    writeJsonAtomic(byPidFile(pid), rec);
    writeJsonAtomic(bySidFile(sid), rec);
    ok = true;
  });
  return ok;
}

module.exports = {
  NAME_RE, CODE_RE, RESERVED, ANIMALS,
  home, roomDir, newCode, roomExists,
  readMembers, readMembersFile, join, leave,
  pidStart, isAlive, ancestors, claudePid,
  resolveByPid, resolveBySession, resolveSelf, rebindSession,
  withLock, readJson, writeJsonAtomic,
};
