'use strict';
/**
 * plugin/sub-human/lib/room/store.js: the room log on disk: binding, paths, reading, following, appending,
 * the prev-hash chain and the per-reader cursors. Every writer (hooks, the MCP server) goes through append().
 * `from` is passed in by trusted callers that resolved identity first (lib/identity.js); it is never taken
 * from env or from the model.
 *
 * Binding (which room the calls below act on):
 *   bind(code)            set the active room (<home>/rooms/<code>); returns code
 *   ROOM_DIR              env override of the directory, for tests; wins over bind()
 *   code() -> string|null the bound code (or the basename of ROOM_DIR)
 *   dir(), logPath()      <roomDir>, <roomDir>/log.jsonl
 *
 * Reading:
 *   readAll() -> Entry[]                     every parseable line, in order (legacy lines included)
 *   readById(ids) -> Entry[]                 in the order asked
 *   readAfter(seq, filterFn?) -> Entry[]
 *   lastId() -> int
 *   follow(afterSeq, onEntry, {intervalMs}) -> stop()   polls the log file bound at call time
 *   normalize(entry)                         legacy display mapping (concern -> objection, agree -> signoff,
 *                                            plan_rev -> proposal {hash}, plan_hash -> proposal_hash)
 *   readMembersHere() -> {name: record}      members.json of the bound room ({} when unreadable)
 *   getCursor(name), setCursor(name, n)      <roomDir>/<name>.cursor, written atomically
 *
 * Writing:
 *   append(entry, {via, from, system}) -> Entry
 *     validate() (validate.js) first; then, under the log lock: id (monotonic), at, from, via, prev (hash12
 *     of the previous line); task_req gets `by` = from. Agent posts are rate limited: RATE_MAX per `from`
 *     per RATE_WINDOW_MS (RoomError RATE). Throws RoomError INVALID | RATE | LOCK | NO_ROOM.
 *   validateChain() -> {ok, count, badAt?, line?}
 *   hash12(data)
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const identity = require('../identity.js');
const { withLock } = require('../lock.js');
const { writeFileAtomic } = require('../io.js');
const config = require('../config.js');
const { RoomError, validate } = require('./validate.js');

// ---------- binding / paths ----------
let active = null;
function bind(c) {
  identity.roomDir(c); // validates the code
  active = c;
  return c;
}
const code = () => (process.env.ROOM_DIR ? path.basename(process.env.ROOM_DIR) : active);
function dir() {
  if (process.env.ROOM_DIR) return process.env.ROOM_DIR;
  if (!active) throw new RoomError('NO_ROOM', 'no room bound; run /sub-human');
  return identity.roomDir(active);
}
const logPath = () => path.join(dir(), 'log.jsonl');

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
function follow(afterSeq, onEntry, { intervalMs = config.FOLLOW_POLL_MS } = {}) {
  const file = logPath();
  let offset = 0, seen = afterSeq, buf = '';
  const tick = () => {
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch { return; }
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

/** Legacy entries (logs from before envelope v3) mapped for display and for the answer matrix. */
function normalize(e) {
  const n = { ...e };
  if (n.kind === 'concern') n.kind = 'objection';
  if (n.kind === 'agree' && n.plan_hash) n.kind = 'signoff';
  if (n.kind === 'plan_rev') { n.kind = 'proposal'; if (n.plan_hash && !n.hash) n.hash = n.plan_hash; }
  else if (n.plan_hash && !n.proposal_hash) n.proposal_hash = n.plan_hash;
  delete n.plan_hash;
  if (n.to == null) n.to = 'room';
  return n;
}

function readMembersHere() {
  try { return identity.readMembersFile(path.join(dir(), 'members.json')); } catch { return {}; }
}

// ---------- writing ----------
function append(entry, opts = {}) {
  const v = validate(entry, opts);
  fs.mkdirSync(dir(), { recursive: true });
  return withLock(logPath() + '.lock', () => {
    let raw = '';
    try { raw = fs.readFileSync(logPath(), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const lines = raw.split('\n').filter(Boolean);
    let last = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      try { last = JSON.parse(lines[i]).id || 0; break; } catch { /* skip corrupt */ }
    }
    const now = Date.now();
    if (v.via === 'agent') {
      let recent = 0;
      for (let i = lines.length - 1; i >= 0 && recent < config.RATE_MAX; i--) {
        let e;
        try { e = JSON.parse(lines[i]); } catch { continue; }
        const t = Date.parse(e.at);
        if (now - t >= config.RATE_WINDOW_MS) break; // the log is in time order
        if (e.from === opts.from && e.via === 'agent') recent++;
      }
      if (recent >= config.RATE_MAX) {
        throw new RoomError('RATE', `rate limit: ${opts.from}'s Claude posted ${config.RATE_MAX} times in the last minute; wait before posting again`);
      }
    }
    const prevLine = lines.length ? lines[lines.length - 1] : '';
    const e = { id: last + 1, at: new Date(now).toISOString(), from: opts.from, via: v.via, kind: v.kind, to: v.to };
    if (v.refs && v.refs.length) e.refs = v.refs;
    if (v.hash) e.hash = v.hash;
    if (v.approvers) e.approvers = v.approvers;
    if (v.path) e.path = v.path;
    if (v.proposal_hash) e.proposal_hash = v.proposal_hash;
    if (v.task) {
      if (v.kind === 'task_req') e.by = opts.from;
      Object.assign(e, v.task);
    }
    if (v.normalized !== undefined) e.normalized = v.normalized;
    if (v.edit_path) e.edit_path = v.edit_path;
    if (v.drafted) e.drafted = v.drafted;
    if (v.text !== undefined) e.text = v.text;
    e.prev = hash12(prevLine);
    const prefix = raw && !raw.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(logPath(), prefix + JSON.stringify(e) + '\n');
    return e;
  }, { ErrorClass: RoomError });
}

/** Check the prev chain. Returns {ok:true, count} or {ok:false, badAt: id, count}. */
function validateChain() {
  let raw = '';
  try { raw = fs.readFileSync(logPath(), 'utf8'); } catch { return { ok: true, count: 0 }; }
  const lines = raw.split('\n').filter(Boolean);
  let prev = '';
  for (let i = 0; i < lines.length; i++) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { return { ok: false, badAt: null, line: i + 1, count: lines.length }; }
    if (e.prev !== undefined && e.prev !== hash12(prev)) return { ok: false, badAt: e.id, count: lines.length };
    prev = lines[i];
  }
  return { ok: true, count: lines.length };
}

// ---------- cursors ----------
const CURSOR_RE = /^[A-Za-z0-9_.-]{1,64}$/;
function cursorFile(name) {
  if (!CURSOR_RE.test(name)) throw new RoomError('INVALID', `invalid cursor name "${name}"`);
  return path.join(dir(), `${name}.cursor`);
}
const getCursor = name => { try { return Number(fs.readFileSync(cursorFile(name), 'utf8')) || 0; } catch { return 0; } };
/** Atomic (write + rename), so a concurrent reader never sees an empty file. */
const setCursor = (name, n) => writeFileAtomic(cursorFile(name), String(n));

module.exports = {
  RoomError,
  bind, code, dir, logPath, hash12,
  readAll, readById, readAfter, lastId, follow, normalize, readMembersHere,
  append, validateChain,
  getCursor, setCursor,
};
