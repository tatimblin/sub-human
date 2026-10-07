'use strict';
/**
 * plugin/sub-human/lib/room/store.js: the RoomStore seam, and FsRoomStore, its implementation over the room
 * directory on this machine. Nothing outside lib/room/store*.js knows where a room's files are or what they are
 * called (test/store-bypass.test.js checks it); a store that keeps rooms off-machine implements the same
 * interface (test/support/memory-store.js is a second one; test/store-contract.test.js runs both).
 * `from` is passed in by trusted callers that resolved identity first (lib/identity.js); it is never taken from
 * env or from the model.
 *
 * RoomStore (one room; get one with open(code)):
 *   code                                    the room code
 *   append(entry, {via, from, system, provisional}) -> Entry
 *       validate() (validate.js) first; then, atomically: id (monotonic), at, from, via, prev (hash12 of the
 *       previous line); task_req gets `by` = from. provisional: true marks a post whose origin check is still
 *       running (hooks/at-room.js); see isYoungProvisional. via "human" needs the seat's key: the process must
 *       have installed a signer (globalThis[SIGNER], set by hooks/seat-key.js arm(), which every hook process
 *       runs; never the MCP server or the CLI). The entry then carries room (the code) and ends with sig =
 *       Ed25519 over the line without sig. No signer, or no key for (room, from) -> RoomError INVALID. A line
 *       over LOG_LINE_MAX_BYTES is refused (INVALID). Agent posts are rate limited: RATE_MAX per `from` per
 *       RATE_WINDOW_MS (RATE). Throws RoomError INVALID | RATE | LOCK | NO_ROOM.
 *   readAll() -> Entry[]                    every parseable entry, in order (legacy lines included). Fresh array;
 *                                           the entries are shared (do not mutate them)
 *   readById(ids), readAfter(id, filter?), since(id) (= readAfter(id)), lastId()
 *   readView({after}) -> Entry[]            non-chat entries + entries with id > after + retract targets: what a
 *                                           hook judges lanes against, the same answer as readAll() for the
 *                                           entries after `after` (after <= 0: readAll(); Infinity: non-chat only)
 *   watch(onEntry, {after, intervalMs}) -> stop()   every entry with id > after, then new ones (polling)
 *   tailer({fs}?) -> {poll() -> {entries, reset}}   entries appended after the moment it was made (fs: test hook)
 *   validateChain() -> {ok, count, badAt?, line?}   the whole prev chain
 *   verifyChain({fromOffset, prev, save}?) -> {ok, count, checked, offset, id, hash, from, badAt?, line?}
 *       incremental, from the checkpoint (FsRoomStore: <room>/log.idx), which it advances
 *   getCursor(reader) -> id, setCursor(reader, id)           per-reader positions
 *   members.read() -> {name: record}; members.update(fn) -> written | null
 *       fn(current) returns the next object to store, or null/undefined to store nothing. Atomic: under a lock
 *       here, a compare-and-set retry loop for a remote store, so fn may run more than once (side effects in it
 *       must be idempotent).
 *   blobs.put(name, bytes) -> ref, get(ref) -> Buffer|null, has(ref), ref(pathOrRef) -> ref|null,
 *   blobs.localPath(ref) -> string|null    name/ref: "plans/<hash>.md" (room-relative). get/has/ref also take the
 *       absolute path older proposal entries stored. localPath: a file a person can open (null off-machine).
 *   kv.get(key, fallback?), kv.set(key, value, {compact}?), kv.update(key, fn, {compact, timeoutMs, staleMs}?),
 *   kv.delete(key), kv.list(prefix) -> [key], kv.lock(key, fn, opts?)
 *       small derived documents: tasks, presence/NAME, rows/*, members/NAME/review, members/NAME/<state>,
 *       delivery-NAME (the hooks module's delivery lease {via, sid, pid, at, until}: lib/tail.js leaseLive).
 *       update: fn(current|null) -> next (undefined: no write, null: delete), atomic like members.update.
 *   lock(name, fn, opts?)                   a room-wide mutex (the proposal answer lock)
 *   exists() -> bool
 *
 * Rooms (module level): open(code, {dir, fs}?) -> RoomStore (cached per code), roomExists(code),
 *   createRoom(code) -> bool (false: taken), listRooms() -> [code], setBackend(factory|null) (tests: every open()
 *   then returns factory(code)).
 *
 * The human capability (keys under <home>/keys/<code>/, dir 0700; hooks/seat-key.js creates them; the private
 * keys never leave this machine, whatever the store):
 *   verifyHuman(e) -> bool       e is via=human and its sig verifies against <code>/<from>.pub (public key only)
 *   unverifiedHuman(e) -> bool   via=human without a valid sig (a legacy line, or one written around append)
 *   humanTrust(e) -> 'verified' | 'legacy' | 'unverified' | null   (legacy: unsigned from a seat with no key)
 *   The room an entry belongs to is its `room` field (signed entries), else the store that read it (a WeakMap,
 *   so entries are not changed), else the legacy bound room.
 *   keyDir(code?), pubPath(name, code?), canonical(e), SIGNER
 *   isYoungProvisional(e, now?)  a provisional post younger than PROVISIONAL_MS (the at-room check window)
 *   normalize(e)                 legacy display mapping (concern -> objection, agree -> signoff, plan_rev ->
 *                                proposal {hash}, plan_hash -> proposal_hash)
 *   hash12(data)
 *
 * Deprecated (tests only; test/store-bypass.test.js checks no plugin module calls them): bind(code) sets a
 * process-wide room that code(), dir(), logPath() and the bound functions (readAll, append, ...) act on.
 * SUB_HUMAN_TEST_ROOM_DIR overrides that room's directory.
 */

const nodeFs = require('node:fs');
const fs = nodeFs;
const path = require('node:path');
const crypto = require('node:crypto');
const { home, roomsDir, roomDir } = require('../home.js');
const { withLock } = require('../lock.js');
const { writeFileAtomic, writeJsonAtomic, readJson } = require('../io.js');
const { CODE_RE } = require('../text.js');
const config = require('../config.js');
const { RoomError, validate } = require('./validate.js');

const LOG = 'log.jsonl';
const IDX_FILE = 'log.idx';
const MEMBERS = 'members.json';
const CHAT_KINDS = new Set(['say', 'status']);

const hash12 = data => crypto.createHash('sha256').update(data).digest('hex').slice(0, 12);

// ---------- which room an entry was read from ----------
const ROOM_OF = new WeakMap();
const tag = (e, c) => { if (e && typeof e === 'object' && c) ROOM_OF.set(e, c); return e; };

function parseLines(text, c) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(tag(JSON.parse(line), c)); } catch { /* torn or corrupt line: skip */ }
  }
  return out;
}

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

/** Legacy entries (logs from before envelope v3) mapped for display and for the answer matrix. */
function normalize(e) {
  const n = { ...e };
  if (n.kind === 'concern') n.kind = 'objection';
  if (n.kind === 'agree' && n.plan_hash) n.kind = 'signoff';
  if (n.kind === 'plan_rev') { n.kind = 'proposal'; if (n.plan_hash && !n.hash) n.hash = n.plan_hash; }
  else if (n.plan_hash && !n.proposal_hash) n.proposal_hash = n.plan_hash;
  delete n.plan_hash;
  if (n.to == null) n.to = 'room';
  return tag(n, ROOM_OF.get(e));
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
  return path.join(home(), 'keys', c);
}
function pubPath(name, c = code()) {
  if (typeof name !== 'string' || !KEY_PART_RE.test(name) || name.startsWith('.')) throw new RoomError('INVALID', `invalid name "${name}"`);
  return path.join(keyDir(c), `${name}.pub`);
}
/** The bytes a sig covers: the stored entry without sig, in its stored key order. */
const canonical = e => { const { sig, ...rest } = e; return JSON.stringify(rest); };

function humanKey(c, from) {
  const signer = globalThis[SIGNER];
  let key = null;
  if (typeof signer === 'function') { try { key = signer(c, from); } catch { key = null; } }
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
/** The room a via=human entry was signed in: its `room` field (append stamps it), else the store that read it. */
const roomOf = e => (typeof e.room === 'string' ? e.room : ROOM_OF.get(e) || code());

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

/**
 * The envelope append() stores: validated fields `v`, with id (last + 1), at, from, via, prev, and for a via=human
 * entry room + sig. Shared by every RoomStore, so the chain and the signature are the same whatever the backend.
 * Throws RATE when `recent` (agent posts by from inside RATE_WINDOW_MS) is at RATE_MAX, INVALID when too large.
 */
function buildEntry(v, opts, { c, key, last, prevLine, recent, now }) {
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
  if (key) e.room = c; // the key's room, so a reader that is not bound to it can still verify
  e.prev = hash12(prevLine || '');
  if (key) e.sig = crypto.sign(null, Buffer.from(JSON.stringify(e), 'utf8'), key).toString('base64');
  const line = JSON.stringify(e);
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > config.LOG_LINE_MAX_BYTES) {
    throw new RoomError('INVALID', `entry is too large (${bytes} bytes as stored; the limit is ${config.LOG_LINE_MAX_BYTES}). Shorten the text`);
  }
  return { e: tag(e, c), line };
}

/** Validate an entry for append (the rules every backend shares); also returns the via=human signing key. */
function prepare(c, entry, opts) {
  const v = validate(entry, opts);
  if (!c) throw new RoomError('NO_ROOM', 'no room bound; run /sub-human');
  const key = v.via === 'human' ? humanKey(c, opts.from) : null;
  return { v, key };
}

// ---------- keys of the small documents ----------
const KEY_SEG = /^(?!\.)[A-Za-z0-9_.-]{1,128}$/;
function checkKey(key) {
  const segs = typeof key === 'string' ? key.split('/') : [];
  if (!segs.length || segs.length > 3 || !segs.every(s => KEY_SEG.test(s))) throw new RoomError('INVALID', `invalid store key "${key}"`);
  return key;
}
const BLOB_RE = /^(plans)\/([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$/;
/** A blob's room-relative ref ("plans/<x>"), from a ref or from the absolute path older entries stored. */
function blobRef(p) {
  if (typeof p !== 'string' || !p) return null;
  if (BLOB_RE.test(p)) return p;
  if (path.isAbsolute(p)) { const m = /[\\/](plans)[\\/]([^\\/]+)$/.exec(p); if (m && BLOB_RE.test(`${m[1]}/${m[2]}`)) return `${m[1]}/${m[2]}`; }
  return null;
}
const CURSOR_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const checkCursor = name => { if (!CURSOR_RE.test(name)) throw new RoomError('INVALID', `invalid cursor name "${name}"`); return name; };

// ---------- FsRoomStore ----------
/**
 * The parsed log, cached per file for the life of this process: a repeat call re-reads nothing when the file
 * is unchanged and parses only the appended bytes when it grew (same inode, the bytes before the old end
 * unchanged). A shrink, a new inode, a same-size rewrite or a changed tail drops the cache and re-reads.
 */
const readCache = new Map(); // file -> {dev, ino, size, mtimeMs, offset, tail, entries, partial}
const TAIL_CHECK = 64;       // bytes before the cached end compared on growth

/**
 * <room>/log.idx = {v:1, offset, id, hash, count, marks}: the log's first `offset` bytes (`count` lines,
 * last id `id`) were checked to chain, and hash = hash12 of the line that ends at offset (the next line's prev).
 * marks = [[id, offset, length], ...] for every line in that prefix whose kind is not a chat kind (say,
 * status): the lines that decide lanes, proposals, answers, notices. It is a cache: written atomically by
 * verifyChain() and readView() whenever they get further, trusted only while the line before `offset` still
 * hashes to `hash`, and rebuilt from byte 0 otherwise.
 */
const ZERO = () => ({ v: 1, offset: 0, id: 0, hash: hash12(''), count: 0, marks: [] });

function atBoundary(fd, off) {
  if (off === 0) return true;
  const b = Buffer.alloc(1);
  fs.readSync(fd, b, 0, 1, off - 1);
  return b[0] === 10;
}
const lineBefore = (fd, off) => { for (const l of linesBackward(fd, off)) return l; return ''; };
const readRange = (fd, off, len) => { const b = Buffer.allocUnsafe(len); fs.readSync(fd, b, 0, len, off); return b; };

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

/** The last line boundary at or before the end of the file (0 when there is no file). */
function endOffset(xfs, file) {
  let fd;
  try { fd = xfs.openSync(file, 'r'); } catch (e) { if (e.code === 'ENOENT') return 0; throw e; }
  try {
    const size = xfs.fstatSync(fd).size;
    let end = size;
    while (end > 0) {
      const n = Math.min(4096, end);
      const b = Buffer.allocUnsafe(n);
      xfs.readSync(fd, b, 0, n, end - n);
      const i = b.lastIndexOf(10);
      if (i >= 0) return end - n + i + 1;
      end -= n;
    }
    return 0;
  } finally { xfs.closeSync(fd); }
}

class FsRoomStore {
  /** code: the room code; dir: its directory (default <home>/rooms/<code>, read at each call). */
  constructor(code, { dir } = {}) {
    if (!dir) roomDir(code); // validates the code
    this.code = code;
    this._dir = dir || null;
    const self = this;
    this.members = {
      read: () => self._readMembers(),
      update: fn => self._updateMembers(fn),
    };
    this.blobs = {
      put: (name, bytes) => self._blobPut(name, bytes),
      get: ref => self._blobGet(ref),
      has: ref => { const r = blobRef(ref); return !!r && fs.existsSync(path.join(self.dir, r)); },
      ref: blobRef,
      localPath: ref => { const r = blobRef(ref); return r ? path.join(self.dir, r) : null; },
    };
    this.kv = {
      get: (key, fallback = null) => readJson(self._kvFile(key), fallback),
      set: (key, value, opts) => self._kvSet(key, value, opts),
      update: (key, fn, opts) => self._kvUpdate(key, fn, opts),
      delete: key => { try { fs.unlinkSync(self._kvFile(key)); } catch { /* absent */ } },
      list: prefix => self._kvList(prefix),
      lock: (key, fn, opts) => withLock(self._kvFile(key) + '.lock', fn, opts),
    };
  }
  get dir() { return this._dir || roomDir(this.code); }
  get logFile() { return path.join(this.dir, LOG); }
  exists() { return fs.existsSync(this.dir); }

  // ----- reading -----
  readAll() {
    const file = this.logFile;
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
      if (cut >= skip) for (const e of parseLines(buf.toString('utf8', skip, cut + 1), this.code)) entries.push(e);
      const offset = cut >= skip ? start + cut + 1 : (c ? c.offset : 0);
      // A last line with no newline yet (torn, or written by a non-appender): parsed, never cached.
      const partial = parseLines(buf.toString('utf8', Math.max(skip, cut + 1)), this.code);
      const tailStart = Math.max(0, offset - start - TAIL_CHECK);
      const tail = Buffer.from(buf.subarray(tailStart, offset - start));
      readCache.set(file, { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, offset, tail, entries, partial });
      return entries.concat(partial);
    } finally { fs.closeSync(fd); }
  }

  readById(ids) {
    const want = (Array.isArray(ids) ? ids : [ids]).map(Number);
    const byId = new Map(this.readAll().map(e => [e.id, e]));
    return want.filter(i => byId.has(i)).map(i => byId.get(i));
  }
  readAfter(seq, filterFn = () => true) { return this.readAll().filter(e => e.id > seq && filterFn(e)); }
  since(id) { return this.readAfter(id); }

  /** The id of the last parseable line, from a read of the log's tail only. */
  lastId() {
    let fd;
    try { fd = fs.openSync(this.logFile, 'r'); } catch (e) { if (e.code === 'ENOENT') return 0; throw e; }
    try {
      for (const l of linesBackward(fd, fs.fstatSync(fd).size)) {
        try { return JSON.parse(l).id || 0; } catch { /* corrupt: keep looking */ }
      }
      return 0;
    } finally { fs.closeSync(fd); }
  }

  /** Poll the log for entries with id > after. Handles torn reads and a reset (truncated) log. */
  watch(onEntry, { after = 0, intervalMs = config.FOLLOW_POLL_MS } = {}) {
    const file = this.logFile, c = this.code;
    let offset = 0, seen = after, buf = '';
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
        for (const e of parseLines(complete, c)) {
          if (e.id > seen) { seen = e.id; onEntry(e); }
        }
      } finally { fs.closeSync(fd); }
    };
    tick();
    const t = setInterval(tick, intervalMs);
    return () => clearInterval(t);
  }

  /**
   * A reader of what is appended from now on: poll() returns the complete lines written since the last poll
   * (the first poll: since tailer() was called). reset: the log shrank (it was reset), and reading began again
   * from its start. The caller drops ids it has seen. xfs: the fs module to read with (tests inject faults).
   */
  tailer({ fs: xfs = nodeFs } = {}) {
    const file = this.logFile, c = this.code;
    let offset = endOffset(xfs, file);
    return {
      get offset() { return offset; },
      poll() {
        let st;
        try { st = xfs.statSync(file); } catch (e) { if (e.code === 'ENOENT') return { entries: [], reset: false }; throw e; }
        let reset = false;
        if (st.size < offset) { offset = 0; reset = true; }
        if (st.size === offset) return { entries: [], reset };
        const fd = xfs.openSync(file, 'r');
        let buf;
        try {
          buf = Buffer.allocUnsafe(st.size - offset);
          xfs.readSync(fd, buf, 0, buf.length, offset);
        } finally { xfs.closeSync(fd); }
        const entries = [];
        let pos = 0;
        for (let nl; (nl = buf.indexOf(10, pos)) >= 0; pos = nl + 1) {
          if (nl > pos) { try { entries.push(tag(JSON.parse(buf.toString('utf8', pos, nl)), c)); } catch { /* corrupt */ } }
          offset += nl + 1 - pos;
        }
        return { entries, reset };
      },
    };
  }

  // ----- writing -----
  /**
   * Under the log lock, read only the log's tail: the last line (its hash12 is the new prev), the last parseable
   * id, and for via=agent the posts inside RATE_WINDOW_MS (the log is in time order, so the scan stops there).
   */
  append(entry, opts = {}) {
    const d = this.dir; // NO_ROOM / invalid code before anything else
    const { v, key } = prepare(this.code, entry, opts);
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    const file = this.logFile;
    return withLock(file + '.lock', () => {
      const fd = fs.openSync(file, 'a+', 0o600);
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
        const { e, line } = buildEntry(v, opts, { c: this.code, key, last, prevLine, recent, now });
        fs.writeSync(fd, (endsNl ? '' : '\n') + line + '\n');
        return e;
      } finally { fs.closeSync(fd); }
    }, { ErrorClass: RoomError });
  }

  /** Check the whole prev chain. Returns {ok:true, count} or {ok:false, badAt: id, count} ({line} for a corrupt line). */
  validateChain() {
    let raw = '';
    try { raw = fs.readFileSync(this.logFile, 'utf8'); } catch { return { ok: true, count: 0 }; }
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

  // ----- the verified checkpoint (log.idx), incremental verification, the hook view -----
  get _idxPath() { return path.join(this.dir, IDX_FILE); }
  /** The saved checkpoint if it still matches the file, else the zero checkpoint. */
  _checkpoint(fd, size) {
    const x = readJson(this._idxPath);
    if (x && x.v === 1 && Number.isInteger(x.offset) && x.offset >= 0 && x.offset <= size && typeof x.hash === 'string'
      && Array.isArray(x.marks) && atBoundary(fd, x.offset) && hash12(x.offset ? lineBefore(fd, x.offset) : '') === x.hash) return x;
    return ZERO();
  }
  _saveCheckpoint(cp) { try { writeJsonAtomic(this._idxPath, cp, { compact: true }); } catch { /* read-only: next call rescans */ } }

  /**
   * Parse the complete lines in [cp.offset, size), checking the chain from cp. Returns the parsed lines
   * ([{off, e}], corrupt ones left out), the checkpoint advanced over every line that chains (it stops at the
   * first break), and the break ({badAt} or {line}) if any. A last line without its newline is not scanned.
   */
  _scan(fd, size, cp) {
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
        try { e = tag(JSON.parse(l), this.code); } catch { if (!bad) bad = { badAt: null, line: next.count + 1 }; }
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
   */
  verifyChain({ fromOffset, prev, save = true } = {}) {
    let fd;
    try { fd = fs.openSync(this.logFile, 'r'); } catch (e) {
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
      } else cp = this._checkpoint(fd, size);
      const { next, bad } = this._scan(fd, size, cp);
      if (save && fromOffset === undefined && next.offset > cp.offset) this._saveCheckpoint(next);
      const r = { ok: !bad, count: next.count, checked: next.count - cp.count, offset: next.offset, id: next.id, hash: next.hash, from: cp.offset };
      return bad ? { ...r, ...bad } : r;
    } finally { fs.closeSync(fd); }
  }

  /**
   * What a hook needs without parsing the whole log: every non-chat entry (proposals, answers, decisions,
   * retracts, tasks, joins and leaves), every entry with id > after, and the entries a retract names, in log
   * order. Advances log.idx as verifyChain() does.
   */
  readView({ after = 0 } = {}) {
    if (!(after > 0)) return this.readAll();
    let fd;
    try { fd = fs.openSync(this.logFile, 'r'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const c = this.code;
    try {
      const size = fs.fstatSync(fd).size;
      const cp = this._checkpoint(fd, size);
      const got = new Map(); // offset -> entry
      const parse = buf => { try { return tag(JSON.parse(buf.toString('utf8')), c); } catch { return null; } };
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
      const scanned = this._scan(fd, size, cp);
      const { out, next } = scanned;
      for (const { off, e } of out) if (!CHAT_KINDS.has(e.kind) || e.id > after) got.set(off, e);
      if (next.offset > cp.offset) this._saveCheckpoint(next);
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

  // ----- cursors -----
  _cursorFile(name) { return path.join(this.dir, `${checkCursor(name)}.cursor`); }
  getCursor(name) { try { return Number(fs.readFileSync(this._cursorFile(name), 'utf8')) || 0; } catch { return 0; } }
  /** Atomic (write + rename), so a concurrent reader never sees an empty file. */
  setCursor(name, n) { writeFileAtomic(this._cursorFile(name), String(n)); }

  // ----- members -----
  get _membersFile() { return path.join(this.dir, MEMBERS); }
  _readMembers() { try { return readJson(this._membersFile, {}) || {}; } catch { return {}; } }
  _updateMembers(fn) {
    const file = this._membersFile;
    return withLock(file + '.lock', () => {
      const next = fn(this._readMembers());
      if (!next) return null;
      writeJsonAtomic(file, next);
      return next;
    });
  }

  // ----- blobs -----
  _blobPut(name, bytes) {
    if (!BLOB_RE.test(String(name))) throw new RoomError('INVALID', `invalid blob name "${name}"`);
    writeFileAtomic(path.join(this.dir, name), bytes);
    return name;
  }
  _blobGet(ref) {
    const r = blobRef(ref);
    if (!r) return null;
    try { return fs.readFileSync(path.join(this.dir, r)); } catch { return null; }
  }

  // ----- kv -----
  _kvFile(key) { return path.join(this.dir, `${checkKey(key)}.json`); }
  _kvSet(key, value, { compact = false } = {}) { writeJsonAtomic(this._kvFile(key), value, { compact }); }
  _kvUpdate(key, fn, { compact = false, timeoutMs, staleMs } = {}) {
    const file = this._kvFile(key);
    const lockOpts = {};
    if (timeoutMs !== undefined) lockOpts.timeoutMs = timeoutMs;
    if (staleMs !== undefined) lockOpts.staleMs = staleMs;
    return withLock(file + '.lock', () => {
      const next = fn(readJson(file, null));
      if (next === undefined) return undefined;
      if (next === null) { try { fs.unlinkSync(file); } catch { /* absent */ } return null; }
      writeJsonAtomic(file, next, { compact });
      return next;
    }, lockOpts);
  }
  _kvList(prefix) {
    const p = String(prefix || '');
    if (p && !p.endsWith('/')) throw new RoomError('INVALID', `kv.list needs a "dir/" prefix, not "${prefix}"`);
    if (p) checkKey(p.slice(0, -1));
    let files;
    try { files = fs.readdirSync(path.join(this.dir, p), { withFileTypes: true }); } catch { return []; }
    return files.filter(d => d.isFile() && d.name.endsWith('.json') && KEY_SEG.test(d.name.slice(0, -5))).map(d => p + d.name.slice(0, -5)).sort();
  }

  // ----- locks -----
  lock(name, fn, opts) { return withLock(path.join(this.dir, `${checkKey(name)}.lock`), fn, opts); }
}

// ---------- rooms ----------
let backend = null; // tests: code -> RoomStore
const stores = new Map(); // code -> FsRoomStore
/** The store of room `code`. {dir} (and only then) gives an uncached store over that directory. */
function open(c, { dir } = {}) {
  if (backend) return backend(c);
  if (dir) return new FsRoomStore(c, { dir });
  let s = stores.get(c);
  if (!s) { s = new FsRoomStore(c); stores.set(c, s); }
  return s;
}
const setBackend = fn => { backend = typeof fn === 'function' ? fn : null; };
const roomExists = c => typeof c === 'string' && CODE_RE.test(c) && fs.existsSync(roomDir(c));
/** Create room `code` (private, exclusive): false when it already exists. */
function createRoom(c) {
  fs.mkdirSync(roomsDir(), { recursive: true, mode: 0o700 }); // the home and rooms/ too when new: private
  try { fs.mkdirSync(roomDir(c), { mode: 0o700 }); return true; } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
}
const listRooms = () => { try { return fs.readdirSync(roomsDir()).filter(c => CODE_RE.test(c)); } catch { return []; } };

// ---------- deprecated: the process-wide bound room (tests only) ----------
let active = null;
function bind(c) {
  roomDir(c); // validates the code
  active = c;
  return c;
}
const TEST_DIR = 'SUB_HUMAN_TEST_ROOM_DIR';
function code() { return process.env[TEST_DIR] ? path.basename(process.env[TEST_DIR]) : active; }
function bound() {
  if (process.env[TEST_DIR]) return open(path.basename(process.env[TEST_DIR]), { dir: process.env[TEST_DIR] });
  if (!active) throw new RoomError('NO_ROOM', 'no room bound; run /sub-human');
  return open(active);
}
const dir = () => (process.env[TEST_DIR] ? process.env[TEST_DIR] : bound().dir);
const logPath = () => path.join(dir(), LOG);
const readMembersHere = () => { try { return bound().members.read(); } catch { return {}; } };

module.exports = {
  RoomError,
  FsRoomStore, open, setBackend, roomExists, createRoom, listRooms,
  hash12, normalize, tag, roomOf, buildEntry, prepare, blobRef, checkKey, checkCursor, CHAT_KINDS,
  SIGNER, keyDir, pubPath, canonical, verifyHuman, unverifiedHuman, humanTrust, PROVISIONAL_MS, isYoungProvisional,
  // deprecated, tests only
  bind, code, dir, logPath, readMembersHere,
  readAll: () => bound().readAll(),
  readById: ids => bound().readById(ids),
  readAfter: (seq, f) => bound().readAfter(seq, f),
  lastId: () => bound().lastId(),
  follow: (after, onEntry, opts = {}) => bound().watch(onEntry, { ...opts, after }),
  append: (entry, opts) => bound().append(entry, opts),
  validateChain: () => bound().validateChain(),
  verifyChain: opts => bound().verifyChain(opts),
  readView: opts => bound().readView(opts),
  getCursor: name => bound().getCursor(name),
  setCursor: (name, n) => bound().setCursor(name, n),
};
