'use strict';
/**
 * demo/lib/room.js: the single source of truth for the room log (envelope v2).
 * CommonJS, zero dependencies. Every writer (room, chat, room-mcp, hooks) goes through append().
 *
 * Paths (read from env on every call, so tests can point ROOM_DIR at a temp dir):
 *   dir()        ROOM_DIR, default demo/.room
 *   logPath()    <dir>/log.jsonl
 *   plansDir()   <dir>/plans
 *   appDir()     ROOM_APP_DIR, default demo/app (what runTests() runs `npm test` in)
 *
 * Reading:
 *   readAll() -> Entry[]                         every parseable line, in order (legacy lines included)
 *   readById(ids: int|int[]) -> Entry[]          entries with those ids, in the order asked
 *   readAfter(seq: int, filterFn?) -> Entry[]    entries with id > seq that pass filterFn(entry)
 *   lastId() -> int                              id of the last entry (0 when empty)
 *   follow(afterSeq, onEntry, {intervalMs}) -> stop()   poll the log; call onEntry for each new entry
 *   normalize(entry) -> Entry                    legacy mapping for display: concern -> objection
 *
 * Writing:
 *   append(entry, {via, agent_id?, allowPlanRev?}) -> Entry   the ONLY writer. entry = {kind, text, to?, refs?, plan_hash?}
 *       Assigns id (monotonic, under a lockfile), at, from (= $ROOM_USER, never an argument), via, prev
 *       (12-hex sha256 of the previous line). Throws RoomError: code NO_USER | INVALID | LOCK.
 *       signoff/revoke need via:"human" + plan_hash. plan_rev needs allowPlanRev:true (plan hook only).
 *       kind:"done" is refused here; use postDone().
 *   postDone(note, {via, agent_id?}) -> {ok, entry?, result}   runs runTests(); appends done + evidence only if green
 *   runTests() -> {ok, pass, total, failed: string[]}           `npm test` in appDir()
 *
 * Plan / consent:
 *   hash12(bufOrString) -> string                 first 12 hex of sha256
 *   humans() -> string[]                          from ROOM_HUMANS (space or comma separated)
 *   currentPlan() -> {id, hash, path} | null      latest plan_rev
 *   readPlan() -> {id, hash, path, file, content, fileHash} | null   currentPlan + the file's bytes
 *   signoffMatrix(hash, humans?) -> {hash, signed: {name: id|null}, missing: string[], complete: bool}
 *       counts kind:signoff, via:human, from in humans, plan_hash === hash, not followed by a revoke of that hash
 *
 * Rendering:
 *   tailLine(entry) -> string (<= 240 chars)     `#14 bob[human] objection refs=#9 plan=3fa2c1 "first 200 chars…"`
 *   fmt(entry) -> string                          header line + full text, for `room read`
 *   who(entry) -> string                          "alice" or "alice's Claude"
 *   digestSections() -> [{title, lines}]          the pieces of the digest (also used by chat /status)
 *   digest() -> string (<= DIGEST_CAP chars)     compaction digest per plan §3.7; trims the oldest first
 *   readRoster() -> {human: {agent_id, live, stop_reason?, stopped_at?}}   seats from <dir>/roster.json
 *
 * Cursors: getCursor(name), setCursor(name, n) -> <dir>/<name>.cursor, written atomically. Used by
 *   read/wait (per user) and by `room tail --for X` (name tail-X), which resumes from it after a restart.
 * Constants: KINDS, VIAS, DIGEST_CAP, TAIL_MAX, NAME_RE. Error class: RoomError.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const KINDS = ['say', 'ask', 'proposal', 'objection', 'question', 'signoff', 'revoke', 'plan_rev',
  'directive', 'status', 'done', 'decision', 'seat_up', 'shutdown'];
const VIAS = ['human', 'agent'];
const DIGEST_CAP = 9500;
const TAIL_MAX = 240;
const NAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;
const HASH_RE = /^[0-9a-f]{12}$/;
const ENTRY_FIELDS = new Set(['kind', 'text', 'to', 'refs', 'plan_hash']);
const DONE = Symbol('room.done');

class RoomError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ---------- paths ----------
const dir = () => process.env.ROOM_DIR || path.join(__dirname, '..', '.room');
const logPath = () => path.join(dir(), 'log.jsonl');
const plansDir = () => path.join(dir(), 'plans');
const appDir = () => process.env.ROOM_APP_DIR || path.join(__dirname, '..', 'app');
const repoRoot = () => path.join(__dirname, '..', '..');

const hash12 = data => crypto.createHash('sha256').update(data).digest('hex').slice(0, 12);

// ---------- reading ----------
function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn or corrupt line: skip */ }
  }
  return out;
}

function readAll() {
  try { return parseLines(fs.readFileSync(logPath(), 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

function readById(ids) {
  const want = (Array.isArray(ids) ? ids : [ids]).map(Number);
  const byId = new Map(readAll().map(e => [e.id, e]));
  return want.filter(i => byId.has(i)).map(i => byId.get(i));
}

const readAfter = (seq, filterFn = () => true) => readAll().filter(e => e.id > seq && filterFn(e));
const lastId = () => { const a = readAll(); return a.length ? a[a.length - 1].id : 0; };

/** Poll the log for entries with id > afterSeq. Handles torn reads and a reset (truncated) log. */
function follow(afterSeq, onEntry, { intervalMs = 250 } = {}) {
  let offset = 0, seen = afterSeq, buf = '';
  const tick = () => {
    let fd;
    try { fd = fs.openSync(logPath(), 'r'); } catch { return; }
    try {
      const size = fs.fstatSync(fd).size;
      if (size < offset) { offset = 0; buf = ''; seen = 0; }
      if (size === offset) return;
      const chunk = Buffer.alloc(size - offset);
      fs.readSync(fd, chunk, 0, chunk.length, offset);
      offset = size;
      buf += chunk.toString('utf8');
      const cut = buf.lastIndexOf('\n');
      if (cut < 0) return;
      const complete = buf.slice(0, cut);
      buf = buf.slice(cut + 1);
      for (const e of parseLines(complete)) {
        if (e.id > seen) { seen = e.id; onEntry(e); }
      }
    } finally { fs.closeSync(fd); }
  };
  tick();
  const t = setInterval(tick, intervalMs);
  return () => clearInterval(t);
}

function normalize(e) {
  const n = { ...e };
  if (n.kind === 'concern') n.kind = 'objection';
  if (n.kind === 'agree' && n.plan_hash) n.kind = 'signoff';
  if (n.to == null) n.to = 'room';
  return n;
}

// ---------- locking ----------
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function lockStale(lock) {
  let st, body;
  try { st = fs.statSync(lock); body = fs.readFileSync(lock, 'utf8'); } catch { return false; }
  const [pid, host] = body.split(' ');
  if (host === os.hostname() && Number(pid) > 0 && !pidAlive(Number(pid))) return true;
  return Date.now() - st.mtimeMs > 10_000; // the lock is held for milliseconds; 10 s means a crash
}

function withLock(fn) {
  const lock = logPath() + '.lock';
  const deadline = Date.now() + 15_000;
  let fd;
  for (;;) {
    try { fd = fs.openSync(lock, 'wx'); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (lockStale(lock)) { try { fs.unlinkSync(lock); } catch { /* someone else cleaned it */ } continue; }
      if (Date.now() > deadline) throw new RoomError('LOCK', `could not acquire ${lock}`);
      sleepSync(2 + Math.floor(Math.random() * 8));
    }
  }
  try {
    fs.writeSync(fd, `${process.pid} ${os.hostname()} ${Date.now()}`);
    return fn();
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(lock); } catch { /* already gone */ }
  }
}

// ---------- writing ----------
const bad = msg => { throw new RoomError('INVALID', msg); };

function validate(entry, opts) {
  if (!entry || typeof entry !== 'object') bad('entry must be an object');
  for (const k of Object.keys(entry)) {
    if (!ENTRY_FIELDS.has(k)) bad(`field "${k}" is not settable by callers`);
  }
  const { kind, text, to = 'room', refs, plan_hash } = entry;
  if (!VIAS.includes(opts.via)) bad(`via must be one of ${VIAS.join(', ')}`);
  if (!KINDS.includes(kind)) bad(`unknown kind "${kind}". Use one of: ${KINDS.join(', ')}`);
  if (typeof text !== 'string') bad('text must be a string');
  if (!text.trim()) bad('text is empty');
  if (typeof to !== 'string' || !NAME_RE.test(to)) bad(`invalid to "${to}"`);
  if (refs !== undefined && (!Array.isArray(refs) || !refs.every(r => Number.isInteger(r) && r > 0))) {
    bad('refs must be an array of positive integers');
  }
  if (plan_hash !== undefined && (typeof plan_hash !== 'string' || !HASH_RE.test(plan_hash))) {
    bad('plan_hash must be 12 lowercase hex chars');
  }
  if ((kind === 'signoff' || kind === 'revoke')) {
    if (opts.via !== 'human') bad(`${kind} is valid only via a human client`);
    if (!plan_hash) bad(`${kind} requires plan_hash`);
  }
  if (kind === 'plan_rev') {
    if (opts.allowPlanRev !== true) bad('plan_rev is written only by the plan hook');
    if (!plan_hash) bad('plan_rev requires plan_hash');
  }
  if (kind === 'done' && !opts[DONE]) bad('a bare done is not accepted; use postDone (`room done`)');
  if (opts.agent_id !== undefined) {
    if (opts.via !== 'agent' || typeof opts.agent_id !== 'string' || opts.agent_id.length > 64) bad('invalid agent_id');
  }
  return { kind, text, to, refs, plan_hash };
}

function currentUser() {
  const u = process.env.ROOM_USER;
  if (!u) throw new RoomError('NO_USER', 'ROOM_USER is not set. The launcher sets it; identity is not self-declared.');
  if (!NAME_RE.test(u)) throw new RoomError('NO_USER', `ROOM_USER "${u}" is not a valid name`);
  return u;
}

function append(entry, opts = {}) {
  const from = currentUser();
  const v = validate(entry, opts);
  fs.mkdirSync(dir(), { recursive: true });
  return withLock(() => {
    let raw = '';
    try { raw = fs.readFileSync(logPath(), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const lines = raw.split('\n').filter(Boolean);
    let last = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      try { last = JSON.parse(lines[i]).id || 0; break; } catch { /* skip corrupt */ }
    }
    const prevLine = lines.length ? lines[lines.length - 1] : '';
    const e = { id: last + 1, at: new Date().toISOString(), from, via: opts.via };
    if (opts.agent_id) e.agent_id = opts.agent_id;
    e.kind = v.kind;
    e.to = v.to;
    if (v.refs && v.refs.length) e.refs = v.refs;
    if (v.plan_hash) e.plan_hash = v.plan_hash;
    e.text = v.text;
    if (opts[DONE]) e.evidence = opts[DONE];
    e.prev = hash12(prevLine);
    const prefix = raw && !raw.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(logPath(), prefix + JSON.stringify(e) + '\n');
    return e;
  });
}

// ---------- tests / done ----------
function runTests() {
  const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };
  delete env.NODE_TEST_CONTEXT; // else a nested `node --test` speaks the parent's IPC protocol
  const r = spawnSync('npm', ['test'], { cwd: appDir(), env, encoding: 'utf8', timeout: 300_000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const n = k => Number((out.match(new RegExp(`^\\s*(?:ℹ|#) ${k} (\\d+)`, 'm')) || [])[1] || 0);
  const failed = out.split('\n').filter(l => /^\s*(✖|not ok)/.test(l)).map(l => l.trim()).slice(0, 8);
  const total = n('tests');
  return { ok: r.status === 0 && n('fail') === 0 && total > 0, pass: n('pass'), total, failed };
}

function postDone(note = '', opts = {}) {
  currentUser();
  const result = runTests();
  if (!result.ok) return { ok: false, result };
  const evidence = { pass: result.pass, total: result.total, failed: result.failed };
  const text = note && note.trim() ? note : `npm test ${result.pass}/${result.total} pass`;
  const entry = append({ kind: 'done', text }, { ...opts, [DONE]: evidence });
  return { ok: true, entry, result };
}

// ---------- plan / consent ----------
const humans = () => (process.env.ROOM_HUMANS || '').split(/[\s,]+/).filter(Boolean);

function currentPlan(entries = readAll()) {
  const p = entries.filter(e => e.kind === 'plan_rev' && e.plan_hash).at(-1);
  return p ? { id: p.id, hash: p.plan_hash, path: p.text } : null;
}

function resolvePlanFile(p) {
  if (path.isAbsolute(p)) return p;
  for (const base of [process.cwd(), repoRoot(), plansDir()]) {
    const f = path.join(base, p);
    if (fs.existsSync(f)) return f;
  }
  return path.join(repoRoot(), p);
}

function readPlan() {
  const p = currentPlan();
  if (!p) return null;
  const file = resolvePlanFile(p.path);
  let content = null, fileHash = null;
  try { const b = fs.readFileSync(file); content = b.toString('utf8'); fileHash = hash12(b); } catch { /* missing */ }
  return { ...p, file, content, fileHash };
}

function signoffMatrix(hash, names = humans(), entries = readAll()) {
  const signed = Object.fromEntries(names.map(n => [n, null]));
  for (const e of entries) {
    if (e.via !== 'human' || e.plan_hash !== hash || !(e.from in signed)) continue;
    if (e.kind === 'signoff') signed[e.from] = e.id;
    else if (e.kind === 'revoke') signed[e.from] = null;
  }
  const missing = names.filter(n => signed[n] == null);
  return { hash, signed, missing, complete: !!hash && names.length > 0 && missing.length === 0 };
}

// ---------- rendering ----------
const who = e => (e.via === 'agent' && e.from !== 'orch' ? `${e.from}'s Claude` : e.from);
const oneLine = s => String(s).replace(/\s+/g, ' ').trim();
const clip = (s, n) => { const cps = Array.from(s); return cps.length > n ? cps.slice(0, n).join('') + '…' : s; };

function header(e) {
  const n = normalize(e);
  const parts = [`#${n.id}`, `${n.from}${n.via ? `[${n.via}]` : ''}`, n.kind];
  if (n.to && n.to !== 'room') parts.push(`to=${n.to}`);
  if (n.refs && n.refs.length) {
    const r = n.refs.slice(0, 5).map(x => '#' + x).join(',');
    parts.push(`refs=${r}${n.refs.length > 5 ? ',…' : ''}`);
  }
  if (n.plan_hash) parts.push(`plan=${n.plan_hash.slice(0, 6)}`);
  if (n.evidence) parts.push(`tests=${n.evidence.pass}/${n.evidence.total}`);
  return parts.join(' ');
}

function tailLine(e) {
  const head = header(e);
  let n = 200;
  for (;;) {
    const line = `${head} ${JSON.stringify(clip(oneLine(e.text || ''), n))}`;
    if (line.length <= TAIL_MAX) return line;
    if (n === 0) return line.slice(0, TAIL_MAX);
    n = Math.max(0, n - Math.max(1, line.length - TAIL_MAX));
  }
}

const fmt = e => `[${header(e)} ${String(e.at || '').slice(11, 19)}]\n${e.text}`;

/**
 * Seats by human, from <dir>/roster.json (written by the seat hooks). Accepts {human: {agent_id, live, ...}}
 * and the legacy {agent_id: human}. Returns {human: {agent_id, live, stop_reason?, stopped_at?}};
 * live is false only when the roster says so (a stopped seat is not woken by a directive).
 */
function readRoster() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir(), 'roster.json'), 'utf8'));
    const map = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string') map[v] = { agent_id: k, live: true };
      else if (v && typeof v === 'object') {
        map[v.human || k] = { agent_id: v.agent_id || k, live: v.live !== false,
          ...(v.stop_reason ? { stop_reason: v.stop_reason } : {}), ...(v.stopped_at ? { stopped_at: v.stopped_at } : {}) };
      }
    }
    return map;
  } catch { return {}; }
}

/** The ordered digest sections; items carry an id so the cap can trim the oldest first. */
function digestSections(entries = readAll()) {
  const hs = humans();
  const roster = readRoster();
  const lastSeen = name => entries.filter(e => e.from === name && e.via === 'agent').at(-1);
  const names = [...new Set([...hs, ...Object.keys(roster)])];
  const state = r => !r ? '' : r.live ? ' live (parked or working; reach it with a directive)'
    : ` STOPPED${r.stop_reason ? ` (${r.stop_reason})` : ''}: SendMessage to ${r.agent_id} to resume, else respawn`;
  const rosterLines = [{ text: `  humans: ${hs.join(' ') || '(ROOM_HUMANS unset)'}` }, ...names.map(n => {
    const ls = lastSeen(n), r = roster[n];
    return { text: `  ${n} -> seat ${r ? r.agent_id : '(none)'}${state(r)} -> last seat post ${ls ? `#${ls.id} ${String(ls.at).slice(11, 19)}` : '-'}` };
  })];

  const plan = currentPlan(entries);
  const planLines = [];
  if (plan) {
    const m = signoffMatrix(plan.hash, hs, entries);
    planLines.push({ text: `  ${plan.path} plan=${plan.hash} (#${plan.id})` });
    for (const n of hs) planLines.push({ text: `  ${m.signed[n] ? '✔' : '–'} ${n}${m.signed[n] ? ` #${m.signed[n]}` : ''}` });
  } else planLines.push({ text: '  (no plan yet)' });

  const orch = process.env.ROOM_ORCH || 'orch';
  const closedBy = new Set();
  for (const e of entries) {
    if ((e.from === orch || e.kind === 'decision') && e.refs) e.refs.forEach(r => closedBy.add(r));
  }
  const open = entries.map(normalize)
    .filter(e => (e.kind === 'objection' || e.kind === 'question') && !closedBy.has(e.id))
    .map(e => ({ id: e.id, text: `  #${e.id} ${who(e)} ${e.kind}${e.plan_hash ? ` plan=${e.plan_hash.slice(0, 6)}` : ''}: ${JSON.stringify(clip(oneLine(e.text), 120))}` }));
  const decisions = entries.filter(e => e.kind === 'decision')
    .map(e => ({ id: e.id, text: `  #${e.id} plan=${e.plan_hash || '-'}: ${JSON.stringify(clip(oneLine(e.text), 120))}` }));
  const human = entries.filter(e => e.via === 'human').slice(-10)
    .map(e => ({ id: e.id, text: `  #${e.id} ${e.from} ${e.kind}: ${JSON.stringify(clip(oneLine(e.text), 160))}` }));

  return [
    { title: 'roster (human -> seat agent_id, state -> last seat post)', lines: rosterLines },
    { title: 'current plan and sign-offs', lines: planLines },
    { title: 'open objections and questions', lines: open },
    { title: 'decisions', lines: decisions },
    { title: 'last 10 human entries', lines: human },
    { title: null, lines: [{ text: 'full text: `demo/bin/room read --id N`' }] },
  ];
}

function renderSections(sections, trimmed) {
  const out = [`ROOM DIGEST (generated from the log; ${new Date().toISOString().slice(0, 19)}Z)`];
  for (const s of sections) {
    if (s.title) out.push(`## ${s.title}`);
    if (s.title && !s.lines.length) out.push('  (none)');
    for (const l of s.lines) out.push(l.text);
  }
  if (trimmed) out.push(`(${trimmed} older items trimmed to fit ${DIGEST_CAP} chars)`);
  return out.join('\n');
}

function digest(entries = readAll()) {
  const sections = digestSections(entries);
  let trimmed = 0;
  let text = renderSections(sections, trimmed);
  while (text.length > DIGEST_CAP) {
    let oldest = null;
    for (const s of sections) {
      const i = s.lines.findIndex(l => l.id != null);
      if (i >= 0 && (!oldest || s.lines[i].id < oldest.s.lines[oldest.i].id)) oldest = { s, i };
    }
    if (!oldest) return text.slice(0, DIGEST_CAP - 1) + '…';
    oldest.s.lines.splice(oldest.i, 1);
    trimmed++;
    text = renderSections(sections, trimmed);
  }
  return text;
}

// ---------- cursors ----------
const cursorFile = user => path.join(dir(), `${user}.cursor`);
const getCursor = user => { try { return Number(fs.readFileSync(cursorFile(user), 'utf8')) || 0; } catch { return 0; } };
/** Atomic (write + rename), so a concurrent reader never sees an empty file and falls back to the end. */
const setCursor = (user, n) => {
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = `${cursorFile(user)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, String(n));
  fs.renameSync(tmp, cursorFile(user));
};

module.exports = {
  KINDS, VIAS, DIGEST_CAP, TAIL_MAX, NAME_RE, RoomError,
  dir, logPath, plansDir, appDir,
  readAll, readById, readAfter, lastId, follow, normalize,
  append, runTests, postDone,
  hash12, humans, currentPlan, readPlan, signoffMatrix,
  tailLine, fmt, who, readRoster, digestSections, digest,
  getCursor, setCursor, currentUser,
};
