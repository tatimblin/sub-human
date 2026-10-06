'use strict';
/**
 * plugin/sub-human/lib/room/store.js: the room log on disk: binding, paths, reading, following, appending,
 * the prev-hash chain and the per-reader cursors. Every writer (hooks, the MCP server) goes through append().
 * `from` is passed in by trusted callers that resolved identity first (lib/identity.js); it is never taken
 * from env or from the model.
 *
 * Binding (which room the calls below act on):
 *   bind(code)            set the active room (<home>/rooms/<code>); returns code
 *   SUB_HUMAN_TEST_ROOM_DIR  env override of the directory, for tests; wins over bind()
 *   code() -> string|null the bound code (or the basename of SUB_HUMAN_TEST_ROOM_DIR)
 *   dir(), logPath()      <roomDir>, <roomDir>/log.jsonl
 *
 * Reading:
 *   readAll() -> Entry[]                     every parseable line, in order (legacy lines included); cached
 *                                            per process, re-parsing only appended bytes (do not mutate entries)
 *   readById(ids) -> Entry[]                 in the order asked
 *   readAfter(seq, filterFn?) -> Entry[]
 *   lastId() -> int                          from the tail only
 *   follow(afterSeq, onEntry, {intervalMs}) -> stop()   polls the log file bound at call time
 *   normalize(entry)                         legacy display mapping (concern -> objection, agree -> signoff,
 *                                            plan_rev -> proposal {hash}, plan_hash -> proposal_hash)
 *   readMembersHere() -> {name: record}      members.json of the bound room ({} when unreadable)
 *   getCursor(name), setCursor(name, n)      <roomDir>/<name>.cursor, written atomically
 *
 * Writing:
 *   append(entry, {via, from, system, provisional}) -> Entry
 *     validate() (validate.js) first; then, under the log lock: id (monotonic), at, from, via, prev (hash12
 *     of the previous line); task_req gets `by` = from. provisional: true marks a post whose origin check is
 *     still running (hooks/at-room.js); see isYoungProvisional.
 *     via "human" needs the seat's key: the process must have installed a signer (globalThis[SIGNER], set by
 *     hooks/seat-key.js arm(), which hooks/common.js runs in every hook process; never in the MCP server or
 *     the CLI). The entry then carries room (the code) and ends with sig = Ed25519 over the line without sig. No signer, or no key for
 *     (room, from) -> RoomError INVALID; nothing is written. It reads only the log's tail, never the whole file, and
 *     refuses a serialized line over LOG_LINE_MAX_BYTES (INVALID). Agent posts are rate limited: RATE_MAX per `from`
 *     per RATE_WINDOW_MS (RoomError RATE). Throws RoomError INVALID | RATE | LOCK | NO_ROOM.
 *   validateChain() -> {ok, count, badAt?, line?}       the whole chain
 *   verifyChain({fromOffset, prev, save}?) -> {ok, count, checked, offset, id, hash, from, badAt?, line?}
 *     only the bytes after the checkpoint in <roomDir>/log.idx, which it advances
 *
 * The human capability (keys under <home>/keys/<code>/, dir 0700; hooks/seat-key.js creates them):
 *   verifyHuman(e) -> bool       e is via=human and its sig verifies against <code>/<from>.pub (public key
 *                                only: readers, the MCP server included, never load a private key)
 *   unverifiedHuman(e) -> bool   via=human without a valid sig (a legacy line, or one written around append)
 *   humanTrust(e) -> 'verified' | 'legacy' | 'unverified' | null   (legacy: unsigned from a seat with no key)
 *   keyDir(code?), pubPath(name, code?), canonical(e), SIGNER
 *   isYoungProvisional(e, now?)  a provisional post younger than PROVISIONAL_MS (the at-room check window)
 *   readView({after}) -> Entry[]   non-chat entries + entries with id > after + retract targets, without
 *     parsing the whole log (log.idx marks the non-chat lines); what a hook judges lanes against
 *   hash12(data)
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const identity = require('../identity.js');
const { withLock } = require('../lock.js');
const { writeFileAtomic, writeJsonAtomic, readJson } = require('../io.js');
const config = require('../config.js');
const { RoomError, validate } = require('./validate.js');

// ---------- binding / paths ----------
let active = null;
function bind(c) {
  identity.roomDir(c); // validates the code
  active = c;
  return c;
}
const TEST_DIR = 'SUB_HUMAN_TEST_ROOM_DIR';
const code = () => (process.env[TEST_DIR] ? path.basename(process.env[TEST_DIR]) : active);
function dir() {
  if (process.env[TEST_DIR]) return process.env[TEST_DIR];
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

/**
 * The parsed log, cached per file for the life of this process: a repeat call re-reads nothing when the file
 * is unchanged and parses only the appended bytes when it grew (same inode, the bytes before the old end
 * unchanged). A shrink, a new inode, a same-size rewrite or a changed tail drops the cache and re-reads.
 * Returns a fresh array each call; the entry objects are shared, so callers must not mutate them.
 */
const readCache = new Map(); // file -> {dev, ino, size, mtimeMs, offset, tail, entries}
const TAIL_CHECK = 64;       // bytes before the cached end compared on growth

function readAll() {
  const file = logPath();
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) {
    if (e.code === 'ENOENT') { readCache.delete(file); return []; }
    throw e;
  }
  try {
    const st = fs.fstatSync(fd);
    let c = readCache.get(file);
    if (c && (c.dev !== st.dev || c.ino !== st.ino || st.size < c.size || (st.size === c.size && st.mtimeMs !== c.mtimeMs))) c = null;
    if (c && st.size === c.size) return c.entries.concat(c.partial);
    let start = c ? c.offset - c.tail.length : 0;
    let buf = Buffer.allocUnsafe(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    if (c && !buf.subarray(0, c.tail.length).equals(c.tail)) {
      c = null; start = 0;
      buf = Buffer.allocUnsafe(st.size);
      fs.readSync(fd, buf, 0, buf.length, 0);
    }
    const skip = c ? c.tail.length : 0;
    const cut = buf.lastIndexOf(10);
    const entries = c ? c.entries : [];
    if (cut >= skip) for (const e of parseLines(buf.toString('utf8', skip, cut + 1))) entries.push(e);
    const offset = cut >= skip ? start + cut + 1 : (c ? c.offset : 0);
    // A last line with no newline yet (torn, or written by a non-appender): parsed, never cached.
    const partial = parseLines(buf.toString('utf8', Math.max(skip, cut + 1)));
    const tailStart = Math.max(0, offset - start - TAIL_CHECK);
    const tail = Buffer.from(buf.subarray(tailStart, offset - start));
    readCache.set(file, { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, offset, tail, entries, partial });
    return entries.concat(partial);
  } finally { fs.closeSync(fd); }
}

function readById(ids) {
  const want = (Array.isArray(ids) ? ids : [ids]).map(Number);
  const byId = new Map(readAll().map(e => [e.id, e]));
  return want.filter(i => byId.has(i)).map(i => byId.get(i));
}

const readAfter = (seq, filterFn = () => true) => readAll().filter(e => e.id > seq && filterFn(e));

/** The log's non-empty lines read backwards from byte `end` (newest first), as strings. Reads TAIL_CHUNK at a time. */
const TAIL_CHUNK = 64 * 1024;
function* linesBackward(fd, end) {
  let pos = end;
  let carry = Buffer.alloc(0);
  while (pos > 0) {
    const n = Math.min(TAIL_CHUNK, pos);
    pos -= n;
    const b = Buffer.allocUnsafe(n);
    fs.readSync(fd, b, 0, n, pos);
    const buf = carry.length ? Buffer.concat([b, carry]) : b;
    let stop = buf.length;
    let nl;
    while (stop > 0 && (nl = buf.lastIndexOf(10, stop - 1)) >= 0) {
      if (stop > nl + 1) yield buf.toString('utf8', nl + 1, stop);
      stop = nl;
    }
    carry = Buffer.from(buf.subarray(0, stop));
  }
  if (carry.length) yield carry.toString('utf8');
}

/** The id of the last parseable line, from a read of the log's tail only. */
function lastId() {
  let fd;
  try { fd = fs.openSync(logPath(), 'r'); } catch (e) { if (e.code === 'ENOENT') return 0; throw e; }
  try {
    for (const l of linesBackward(fd, fs.fstatSync(fd).size)) {
      try { return JSON.parse(l).id || 0; } catch { /* corrupt: keep looking */ }
    }
    return 0;
  } finally { fs.closeSync(fd); }
}

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

// ---------- the human capability ----------
/**
 * via=human means "a person typed or answered this in their own terminal". Only hook processes (run by Claude
 * Code itself, never by a model) can write it: append() signs with the seat's private key, which it gets from
 * the signer a hook process installs (hooks/seat-key.js arm()). The MCP server and the CLI never install one, so
 * they cannot write via=human at all. Readers verify with the public key. Single machine, single OS user: this
 * stops a model (its tools, the room MCP server) from forging a person, not a hostile local user.
 */
const SIGNER = Symbol.for('sub-human.human-signer');
const KEY_PART_RE = /^[A-Za-z0-9_.-]{1,64}$/;
function keyDir(c = code()) {
  if (typeof c !== 'string' || !KEY_PART_RE.test(c) || c.startsWith('.')) throw new RoomError('INVALID', `invalid room code "${c}"`);
  return path.join(identity.home(), 'keys', c);
}
function pubPath(name, c = code()) {
  if (typeof name !== 'string' || !KEY_PART_RE.test(name) || name.startsWith('.')) throw new RoomError('INVALID', `invalid name "${name}"`);
  return path.join(keyDir(c), `${name}.pub`);
}
/** The bytes a sig covers: the stored entry without sig, in its stored key order. */
const canonical = e => { const { sig, ...rest } = e; return JSON.stringify(rest); };

function humanKey(from) {
  const signer = globalThis[SIGNER];
  let key = null;
  if (typeof signer === 'function') { try { key = signer(code(), from); } catch { key = null; } }
  if (!key) throw new RoomError('INVALID', 'via "human" is written only by sub-human\'s hooks for a person\'s own typed words or answers; post as via "agent"');
  return key;
}

const pubCache = new Map(); // file -> {mtimeMs, size, key}
function publicKey(name, c) {
  let file;
  try { file = pubPath(name, c); } catch { return null; }
  let st;
  try { st = fs.statSync(file); } catch { pubCache.delete(file); return null; }
  const hit = pubCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.key;
  let key = null;
  try { key = crypto.createPublicKey(fs.readFileSync(file, 'utf8')); } catch { key = null; }
  if (key && key.asymmetricKeyType !== 'ed25519') key = null;
  pubCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, key });
  return key;
}

const verdicts = new Map(); // code \0 canonical \0 sig -> bool (bounded)
const VERDICTS_MAX = 4096;
/** The room a via=human entry was signed in: its `room` field (append stamps it), else the bound room. */
const roomOf = e => (typeof e.room === 'string' ? e.room : code());

function verifyHuman(e) {
  if (!e || e.via !== 'human' || typeof e.sig !== 'string' || typeof e.from !== 'string') return false;
  const c = roomOf(e);
  if (!c) return false;
  const data = canonical(e);
  const k = `${c}\0${data}\0${e.sig}`;
  const hit = verdicts.get(k);
  if (hit !== undefined) return hit;
  const pub = publicKey(e.from, c);
  if (!pub) return false; // no verdict cached: the key may appear later
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(data, 'utf8'), pub, Buffer.from(e.sig, 'base64')); } catch { ok = false; }
  if (verdicts.size >= VERDICTS_MAX) verdicts.clear();
  verdicts.set(k, ok);
  return ok;
}
const unverifiedHuman = e => !!e && e.via === 'human' && !verifyHuman(e);
/**
 * How far a via=human entry is the person's: 'verified' (its sig verifies), 'legacy' (no sig, and the seat has
 * no key: a room from before seat keys, or a reader that cannot tell which room; shown "(unverified)" but still
 * counted as an answer), 'unverified' (anything else: a bad sig, or no sig from a seat that has a key; never
 * counted). null when not via=human.
 */
function humanTrust(e) {
  if (!e || e.via !== 'human') return null;
  if (verifyHuman(e)) return 'verified';
  if (e.sig !== undefined || typeof e.from !== 'string') return 'unverified';
  const c = roomOf(e);
  if (!c) return 'legacy';
  let file;
  try { file = pubPath(e.from, c); } catch { return 'unverified'; }
  return fs.existsSync(file) ? 'unverified' : 'legacy';
}

/** How long a provisional post stays out of digests: the at-room check window plus its last poll and append. */
const PROVISIONAL_MS = () => config.envMs('SUB_HUMAN_FORGERY_MS', config.FORGERY_WINDOW_MS) + 2 * config.FORGERY_POLL_MS + 250;
const isYoungProvisional = (e, now = Date.now()) => !!e && e.provisional === true && now - Date.parse(e.at) < PROVISIONAL_MS();

// ---------- writing ----------
/**
 * Under the log lock, read only the log's tail: the last line (its hash12 is the new prev), the last parseable
 * id, and for via=agent the posts inside RATE_WINDOW_MS (the log is in time order, so the scan stops there).
 */
function append(entry, opts = {}) {
  const v = validate(entry, opts);
  const d = dir(); // NO_ROOM before the key check
  const key = v.via === 'human' ? humanKey(opts.from) : null;
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return withLock(logPath() + '.lock', () => {
    const fd = fs.openSync(logPath(), 'a+', 0o600);
    try {
      const size = fs.fstatSync(fd).size;
      let endsNl = true;
      if (size) { const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, size - 1); endsNl = b[0] === 10; }
      const now = Date.now();
      let prevLine = null, last = null, recent = 0;
      for (const l of linesBackward(fd, size)) {
        if (prevLine === null) prevLine = l;
        let e;
        try { e = JSON.parse(l); } catch { continue; /* corrupt line: skip */ }
        if (last === null) last = (e && e.id) || 0;
        if (v.via !== 'agent') break;
        if (now - Date.parse(e.at) >= config.RATE_WINDOW_MS) break;
        if (e.from === opts.from && e.via === 'agent' && ++recent >= config.RATE_MAX) break;
      }
      if (v.via === 'agent' && recent >= config.RATE_MAX) {
        throw new RoomError('RATE', `rate limit: ${opts.from}'s Claude posted ${config.RATE_MAX} times in the last minute; wait before posting again`);
      }
      const e = { id: (last || 0) + 1, at: new Date(now).toISOString(), from: opts.from, via: v.via, kind: v.kind, to: v.to };
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
      if (opts.provisional === true) e.provisional = true;
      if (v.text !== undefined) e.text = v.text;
      if (key) e.room = code(); // the key's room, so a reader that is not bound to it can still verify
      e.prev = hash12(prevLine || '');
      if (key) e.sig = crypto.sign(null, Buffer.from(JSON.stringify(e), 'utf8'), key).toString('base64');
      const line = JSON.stringify(e);
      const bytes = Buffer.byteLength(line, 'utf8');
      if (bytes > config.LOG_LINE_MAX_BYTES) {
        throw new RoomError('INVALID', `entry is too large (${bytes} bytes as stored; the limit is ${config.LOG_LINE_MAX_BYTES}). Shorten the text`);
      }
      fs.writeSync(fd, (endsNl ? '' : '\n') + line + '\n');
      return e;
    } finally { fs.closeSync(fd); }
  }, { ErrorClass: RoomError });
}

/** Check the whole prev chain. Returns {ok:true, count} or {ok:false, badAt: id, count} ({line} for a corrupt line). */
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

// ---------- the verified checkpoint (log.idx), incremental verification, the hook view ----------
/**
 * <roomDir>/log.idx = {v:1, offset, id, hash, count, marks}: the log's first `offset` bytes (`count` lines,
 * last id `id`) were checked to chain, and hash = hash12 of the line that ends at offset (the next line's prev).
 * marks = [[id, offset, length], ...] for every line in that prefix whose kind is not a chat kind (say,
 * status): the lines that decide lanes, proposals, answers, notices. It is a cache: written atomically by
 * verifyChain() and readView() whenever they get further, trusted only while the line before `offset` still
 * hashes to `hash`, and rebuilt from byte 0 otherwise.
 */
const IDX_FILE = 'log.idx';
const CHAT_KINDS = new Set(['say', 'status']);
const idxPath = () => path.join(dir(), IDX_FILE);
const ZERO = () => ({ v: 1, offset: 0, id: 0, hash: hash12(''), count: 0, marks: [] });

function atBoundary(fd, off) {
  if (off === 0) return true;
  const b = Buffer.alloc(1);
  fs.readSync(fd, b, 0, 1, off - 1);
  return b[0] === 10;
}
const lineBefore = (fd, off) => { for (const l of linesBackward(fd, off)) return l; return ''; };

/** The saved checkpoint if it still matches the file, else the zero checkpoint. */
function checkpoint(fd, size) {
  const x = readJson(idxPath());
  if (x && x.v === 1 && Number.isInteger(x.offset) && x.offset >= 0 && x.offset <= size && typeof x.hash === 'string'
    && Array.isArray(x.marks) && atBoundary(fd, x.offset) && hash12(x.offset ? lineBefore(fd, x.offset) : '') === x.hash) return x;
  return ZERO();
}
const saveCheckpoint = cp => { try { writeJsonAtomic(idxPath(), cp, { compact: true }); } catch { /* read-only: next call rescans */ } };

/**
 * Parse the complete lines in [cp.offset, size), checking the chain from cp. Returns the parsed lines
 * ([{off, e}], corrupt ones left out), the checkpoint advanced over every line that chains (it stops at the
 * first break), and the break ({badAt} or {line}) if any. A last line without its newline is not scanned.
 */
function scan(fd, size, cp) {
  const start = cp.offset;
  const buf = Buffer.allocUnsafe(size - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  const cut = buf.lastIndexOf(10);
  const out = [];
  const next = { ...cp, marks: cp.marks.slice() };
  let bad = null, pos = 0;
  while (cut >= 0 && pos <= cut) {
    const nl = buf.indexOf(10, pos);
    if (nl > pos) {
      const l = buf.toString('utf8', pos, nl);
      let e = null;
      try { e = JSON.parse(l); } catch { if (!bad) bad = { badAt: null, line: next.count + 1 }; }
      if (e) {
        out.push({ off: start + pos, e });
        if (!bad && e.prev !== undefined && e.prev !== next.hash) bad = { badAt: e.id };
      }
      if (!bad) {
        if (e && !CHAT_KINDS.has(e.kind)) next.marks.push([e.id, start + pos, nl - pos]);
        next.hash = hash12(l); next.id = (e && e.id) || next.id; next.count++;
      }
    }
    pos = nl + 1;
    if (!bad) next.offset = start + pos;
  }
  return { out, next, bad, complete: start + cut + 1 };
}

/**
 * Verify only the bytes after the checkpoint in log.idx (byte 0 when there is none or it no longer matches),
 * and advance it. {fromOffset, prev?}: start at that line boundary instead (prev = hash12 of the line before
 * it, read from the file when omitted); log.idx is then left alone. Only complete lines are checked. Lines
 * before the checkpoint are trusted; validateChain() re-checks the whole log.
 *   -> {ok, count, checked, offset, id, hash, from}; ok:false adds badAt (the id whose prev is wrong, null for a
 *      corrupt line) and line (the corrupt line's number). The checkpoint never passes a break.
 */
function verifyChain({ fromOffset, prev, save = true } = {}) {
  let fd;
  try { fd = fs.openSync(logPath(), 'r'); } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, count: 0, checked: 0, offset: 0, id: 0, hash: hash12(''), from: 0 };
    throw e;
  }
  try {
    const size = fs.fstatSync(fd).size;
    let cp;
    if (fromOffset !== undefined) {
      if (!Number.isInteger(fromOffset) || fromOffset < 0 || fromOffset > size || !atBoundary(fd, fromOffset)) {
        return { ok: false, badAt: null, count: 0, checked: 0, offset: fromOffset, from: fromOffset, error: 'fromOffset is not a line boundary of the log' };
      }
      cp = { ...ZERO(), offset: fromOffset, hash: typeof prev === 'string' ? prev : hash12(fromOffset ? lineBefore(fd, fromOffset) : '') };
    } else cp = checkpoint(fd, size);
    const { next, bad } = scan(fd, size, cp);
    if (save && fromOffset === undefined && next.offset > cp.offset) saveCheckpoint(next);
    const r = { ok: !bad, count: next.count, checked: next.count - cp.count, offset: next.offset, id: next.id, hash: next.hash, from: cp.offset };
    return bad ? { ...r, ...bad } : r;
  } finally { fs.closeSync(fd); }
}

/** The first line starting at or after byte pos (< end): {start, end, id} (id null for a line without one), or null. */
function lineAt(fd, pos, end) {
  const W = 4096;
  let start = pos;
  if (pos > 0) {
    let p = pos - 1;
    for (;;) {
      if (p >= end) return null;
      const n = Math.min(W, end - p);
      const b = Buffer.allocUnsafe(n);
      fs.readSync(fd, b, 0, n, p);
      const i = b.indexOf(10);
      if (i >= 0) { start = p + i + 1; break; }
      p += n;
    }
  }
  if (start >= end) return null;
  let head = Buffer.alloc(0), p = start, nl = -1;
  while (nl < 0 && p < end) {
    const n = Math.min(W, end - p);
    const b = Buffer.allocUnsafe(n);
    fs.readSync(fd, b, 0, n, p);
    const i = b.indexOf(10);
    if (head.length < 64) head = Buffer.concat([head, b.subarray(0, i >= 0 ? i : n)]);
    if (i >= 0) nl = p + i;
    p += n;
  }
  const m = /^\{"id":(\d+)[,}]/.exec(head.toString('latin1', 0, 64));
  return { start, end: nl < 0 ? end : nl + 1, id: m ? Number(m[1]) : null };
}

/** Byte offset of the first line in [0, end) whose id is > after (ids rise through the log), or end. */
function offsetAfter(fd, end, after) {
  let lo = 0, hi = end;
  const idAt = pos => { let L = lineAt(fd, pos, end); while (L && L.id === null) L = lineAt(fd, L.end, end); return L; };
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const L = idAt(mid);
    if (!L || L.id > after) hi = mid; else lo = mid + 1;
  }
  const L = idAt(lo);
  return L ? L.start : end;
}

const readRange = (fd, off, len) => { const b = Buffer.allocUnsafe(len); fs.readSync(fd, b, 0, len, off); return b; };

/**
 * What a hook needs without parsing the whole log: every non-chat entry (proposals, answers, decisions,
 * retracts, tasks, joins and leaves), every entry with id > after, and the entries a retract names, in log
 * order. Judged against it, lane(), proposal queries, notices.joinLeave and the pull digest give the same
 * answer as against readAll() for the entries after `after`. after <= 0 (or not a number) gives readAll().
 * after = Infinity gives the non-chat entries only. Advances log.idx as verifyChain() does.
 */
function readView({ after = 0 } = {}) {
  if (!(after > 0)) return readAll();
  let fd;
  try { fd = fs.openSync(logPath(), 'r'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  try {
    const size = fs.fstatSync(fd).size;
    const cp = checkpoint(fd, size);
    const got = new Map(); // offset -> entry
    const parse = buf => { try { return JSON.parse(buf.toString('utf8')); } catch { return null; } };
    if (cp.marks.length) {
      // the marked lines, read in runs of nearby lines
      let i = 0;
      while (i < cp.marks.length) {
        let j = i;
        while (j + 1 < cp.marks.length && cp.marks[j + 1][1] - (cp.marks[j][1] + cp.marks[j][2]) < 4096) j++;
        const off = cp.marks[i][1], buf = readRange(fd, off, cp.marks[j][1] + cp.marks[j][2] - off);
        for (let k = i; k <= j; k++) {
          const e = parse(buf.subarray(cp.marks[k][1] - off, cp.marks[k][1] - off + cp.marks[k][2]));
          if (e) got.set(cp.marks[k][1], e);
        }
        i = j + 1;
      }
    }
    if (after < cp.id) {
      const from = offsetAfter(fd, cp.offset, after);
      const buf = readRange(fd, from, cp.offset - from);
      let pos = 0;
      while (pos < buf.length) {
        let nl = buf.indexOf(10, pos);
        if (nl < 0) nl = buf.length;
        if (nl > pos && !got.has(from + pos)) { const e = parse(buf.subarray(pos, nl)); if (e) got.set(from + pos, e); }
        pos = nl + 1;
      }
    }
    const scanned = scan(fd, size, cp);
    const { out, next } = scanned;
    for (const { off, e } of out) if (!CHAT_KINDS.has(e.kind) || e.id > after) got.set(off, e);
    if (next.offset > cp.offset) saveCheckpoint(next);
    const complete = scanned.complete;
    if (size > complete) { const e = parse(readRange(fd, complete, size - complete)); if (e && (!CHAT_KINDS.has(e.kind) || e.id > after)) got.set(complete, e); } // no newline yet; readAll() parses it too
    // the targets of retracts that are not loaded yet
    const have = new Set([...got.values()].map(e => e.id));
    for (const e of [...got.values()]) {
      if (e.kind !== 'retract') continue;
      for (const r of e.refs || []) {
        if (have.has(r) || !Number.isInteger(r)) continue;
        const L = lineAt(fd, offsetAfter(fd, size, r - 1), size);
        if (L && L.id === r) { const t = parse(readRange(fd, L.start, L.end - L.start)); if (t) { got.set(L.start, t); have.add(r); } }
      }
    }
    return [...got.entries()].sort((x, y) => x[0] - y[0]).map(x => x[1]);
  } finally { fs.closeSync(fd); }
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
  append, validateChain, verifyChain, readView,
  SIGNER, keyDir, pubPath, canonical, verifyHuman, unverifiedHuman, humanTrust, PROVISIONAL_MS, isYoungProvisional,
  getCursor, setCursor,
};
