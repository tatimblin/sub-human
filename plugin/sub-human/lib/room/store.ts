/**
 * plugin/sub-human/lib/room/store.ts: the RoomStore seam, and FsRoomStore, its implementation over the room
 * directory on this machine. Nothing outside lib/room/store*.js knows where a room's files are or what they are
 * called (test/store-bypass.test.js checks it); a store that keeps rooms off-machine implements the same
 * interface (test/support/memory-store.js is a second one; test/store-contract.test.js runs both).
 * `from` is passed in by trusted callers that resolved identity first (lib/identity.ts); it is never taken from
 * env or from the model.
 *
 * RoomStore (one room; get one with open(code)):
 *   code                                    the room code
 *   append(entry, {via, from, system}) -> Entry
 *       = place(toPayload(code, entry, opts), opts): validate() (validate.ts), then sign a via=human entry here,
 *       then place it. via "human" needs the
 *       seat's key: the process must have installed a signer (globalThis[SIGNER], set by hooks/seat-key.ts
 *       arm(), which every hook process runs; never the MCP server or the CLI). The payload then carries room,
 *       nonce, ts, sigv and sig (sig v2, lib/room/envelope.ts). No signer, or no key for (room, from) -> RoomError
 *       INVALID. Throws RoomError INVALID | RATE | AUTH | LOCK | NO_ROOM.
 *   place(payload, {system}) -> Entry
 *       the server half: admit() (validate() again, the stored form rebuilt), then, atomically: rate (RATE_MAX
 *       agent posts to the room per `from` per RATE_WINDOW_MS, RATE_ADDRESSED_MAX per (from, to) for posts
 *       addressed to one member: RATE), replay (a nonce already placed: AUTH), trust (a
 *       via=human payload must be v2, for this room, ts within SIG_SKEW_MS, and verify against publicKey(from):
 *       AUTH; a member_joined pubkey that differs from the key pinned for that name: AUTH), then id (monotonic),
 *       at, prev (hash12 of the previous line). A line over LOG_LINE_MAX_BYTES is refused (INVALID). The sig
 *       covers the payload, not its place, so a payload signed on one machine may be placed on another.
 *   pins() -> Map name -> KeyObject         the keys pinned in this room's log (envelope.pinnedKeys), cached
 *                                           until the log changes
 *   hostState() -> {epoch, host?, machine?, locator?, id?}   who holds the room by its log: the last host_changed
 *                                           entry (lib/handoff.ts), epoch 0 and nothing else before any. Cached
 *                                           like pins. FsRoomStore.place refuses (STALE) once the log says the room
 *                                           moved to another machine: the old host's log takes no more lines, only
 *                                           a host_changed that names this machine (a promote). It reads that only
 *                                           where a move is on record (a handoff document, or a host_changed placed
 *                                           by this store), so an append still reads only the log's tail
 *   setAside() -> string | null             move this room's log aside to orphaned-<time>.jsonl in its directory
 *                                           (and drop its checkpoint and members document): a demoted old host's
 *                                           lines, kept and never merged. The file's path, null with no log
 *   readAll() -> Entry[]                    every parseable entry, in order (legacy lines included). Fresh array;
 *                                           the entries are shared (do not mutate them)
 *   readById(ids), readAfter(id, filter?), since(id) (= readAfter(id)), lastId()
 *   readView({after, save}) -> Entry[]      non-chat entries + entries with id > after: what a
 *                                           hook judges lanes against, the same answer as readAll() for the
 *                                           entries after `after` (after <= 0: readAll(); Infinity: non-chat only).
 *                                           save: false leaves the checkpoint alone (pins() reads that way)
 *   watch(onEntry, {after, intervalMs}) -> stop()   every entry with id > after, then new ones (polling)
 *   tailer({fs, after}?) -> {poll() -> {entries, lines, reset}}   entries appended after the moment it was made
 *                                           (after: an id, from the first line after it instead); lines: the same
 *                                           lines as stored, verbatim (what the remote server streams). fs: test hook
 *   lineHash(id) -> string | null           hash12 of the stored line with that id (the next line's prev; id 0:
 *                                           hash12(''), the empty log), null when the log has no such line
 *   validateChain() -> {ok, count, badAt?, line?}   the whole prev chain
 *   verifyChain({fromOffset, prev, save}?) -> {ok, count, checked, offset, id, hash, from, badAt?, line?}
 *       incremental, from the checkpoint (FsRoomStore: <room>/log.idx), which it advances
 *   getCursor(reader) -> id, setCursor(reader, id)           per-reader positions
 *   isHost -> bool                          this machine holds the room (FsRoomStore: true). Only there do the
 *                                           room Claude's spawn, reap and watchdog and proposal decisions run.
 *   members.read() -> {name: record}; members.update(fn) -> written | null
 *       fn(current) returns the next object to store, or null/undefined to store nothing. Atomic: under a lock
 *       here, a compare-and-set retry loop for a remote store, so fn may run more than once (side effects in it
 *       must be idempotent). The room Claude's bookkeeping (lib/room-claude.ts); a seat changes through the named ops:
 *   members.join(rec) -> {ok, rejoin?, error?}, members.leave(name, {reason, deadlineMs}?) -> bool,
 *   members.beat(name, {presence?}) -> bool
 *       lib/room/members.ts ops (the same rules for every store; beat also writes presence/<name>). On a mirror
 *       (lib/room/store-mirror.ts) they are the host's join, leave and beat ops: the host logs the join (with the
 *       seat's key and a proof the hook's signer makes) and the leave (with its reason).
 *   blobs.put(name, bytes) -> ref, get(ref) -> Buffer|null, has(ref), ref(pathOrRef) -> ref|null,
 *   blobs.localPath(ref) -> string|null    name/ref: "plans/<hash>.md" (room-relative). get/has/ref also take the
 *       absolute path older proposal entries stored. localPath: a file a person can open (null off-machine).
 *   kv.get(key, fallback?), kv.set(key, value, {compact}?), kv.update(key, fn, {compact, timeoutMs, staleMs}?),
 *   kv.delete(key), kv.list(prefix) -> [key], kv.lock(key, fn, opts?)
 *       small derived documents: tasks, presence/NAME, rows/*, members/NAME/review, members/NAME/<state>.
 *       update: fn(current|null) -> next (undefined: no write, null: delete), atomic like members.update.
 *   lock(name, fn, opts?)                   a room-wide mutex (the proposal answer lock)
 *   exists() -> bool
 *
 * Rooms (module level): open(code, {dir, fs}?) -> RoomStore (cached per home and code; a room this machine links
 *   to, lib/room/links.ts, is a MirrorRoomStore, lib/room/store-mirror.ts; a link written or removed since, a
 *   handoff, gives the other kind at the next open), forget(code) (drop the cached one), hostState(entries),
 *   roomExists(code) (a room directory
 *   or a link), createRoom(code) -> bool (false: taken), listRooms() -> [code] (mirrors are directories too),
 *   setBackend(factory|null) (tests: every open() then returns factory(code)).
 *
 * The human capability (keys under <home>/keys/<code>/, dir 0700; hooks/seat-key.ts creates them; the private
 * keys never leave this machine, whatever the store):
 *   publicKey(name, store) -> KeyObject|null   the key pinned in the log (member_joined pubkey, first sight);
 *                                the local <code>/<name>.pub only in a room whose log pins no key (a legacy room)
 *   verifyHuman(e) -> bool       e is via=human and its sig (v2, or v1 from before sig v2) verifies against publicKey
 *   unverifiedHuman(e) -> bool   via=human without a valid sig (a legacy line, or one written around append)
 *   humanTrust(e) -> 'verified' | 'legacy' | 'unverified' | null   (legacy: unsigned, in a room that pins no key,
 *                                from a seat with no local key; a keyed room never returns it)
 *   The room an entry belongs to is its `room` field (signed entries), else the store that read it (a WeakMap,
 *   so entries are not changed).
 *   keyDir(code), pubPath(name, code), SIGNER, humanKey(code, name) -> KeyObject (the installed signer's key for
 *                                that seat; RoomError INVALID without a signer: only hook processes have one)
 *   toPayload(code, entry, opts), admit(code, payload, opts), placeAfter(store, p, {newest, prevLine, now})
 *                                the halves of append and place every RoomStore shares (see place)
 *   normalize(e)                 legacy display mapping (concern -> objection, agree -> signoff, plan_rev ->
 *                                proposal {hash}, plan_hash -> proposal_hash; 0.4.x's "orch" in from, to, by,
 *                                owner -> "claude"). The log itself is never rewritten.
 *   hash12(data)
 *
 */

import nodeFs from 'node:fs';
const fs = nodeFs;
import path from 'node:path';
import crypto from 'node:crypto';
import { home, roomsDir, roomDir, repairModes, machineId } from '../home.ts';
import { withLock } from '../lock.ts';
import { writeFileAtomic, writeJsonAtomic, readJson } from '../io.ts';
import { CODE_RE } from '../text.ts';
import * as config from '../config.ts';
import { RoomError, validate } from './validate.ts';
import * as envelope from './envelope.ts';
import * as members from './members.ts';
import { createRequire } from 'node:module';
import type { KeyObject } from 'node:crypto';
import type { LockOpts } from '../lock.ts';
import type {
  AppendOpts, BlobsApi, ChainCheck, ChainVerify, Entry, EntryInput, HostState, HumanTrust, KvApi, KvUpdateOpts, Members,
  MembersApi, Payload, Placed, PlaceOpts, ReadViewOpts, RoomStore, Tailer, TailerFs, Validated, ValidateOpts,
} from './types.ts';

const require = createRequire(import.meta.url);

/** The installed human signer (hooks/seat-key.ts arm): the seat's private key for (room, from), or null. */
type HumanSigner = (room: string, from: string) => KeyObject | null | undefined;

/** <room>/log.idx (see ZERO below): the verified prefix of the log and the byte ranges of its non-chat lines. */
interface Checkpoint {
  v: 1;
  offset: number;
  id: number;
  hash: string;
  count: number;
  /** [id, offset, length] per non-chat line in the prefix */
  marks: [number, number, number][];
}

/** One line of the log, found by lineAt: its byte range and id (null for a line without one). */
interface LineSpan { start: number; end: number; id: number | null }

/** Where a chain check broke: an id whose prev does not chain, or a corrupt line (badAt null, line 1-based). */
interface ChainBreak { badAt: number | null; line?: number }

/** readAll's cache of one log file (readCache). */
interface ReadCache {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  offset: number;
  tail: Buffer;
  entries: Entry[];
  partial: Entry[];
}

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;

const LOG = 'log.jsonl';
const IDX_FILE = 'log.idx';
const MEMBERS = 'members.json';
const CHAT_KINDS = new Set(['say', 'status']);

const hash12 = (data: string | Uint8Array): string => crypto.createHash('sha256').update(data).digest('hex').slice(0, 12);

// ---------- which store an entry was read from ----------
const STORE_OF = new WeakMap<object, RoomStore>(); // entry -> the RoomStore that read it
const tag = <E,>(e: E, s: RoomStore | null | undefined): E => { if (e && typeof e === 'object' && s) STORE_OF.set(e, s); return e; };

function parseLines(text: string, s: RoomStore): Entry[] {
  const out: Entry[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(tag(JSON.parse(line), s)); } catch { /* torn or corrupt line: skip */ }
  }
  return out;
}

/** The log's non-empty lines read backwards from byte `end` (newest first), as strings. Reads TAIL_CHUNK at a time. */
const TAIL_CHUNK = 64 * 1024;
function* linesBackward(fd: number, end: number): Generator<string, void, undefined> {
  let pos = end;
  let carry = Buffer.alloc(0);
  while (pos > 0) {
    const n = Math.min(TAIL_CHUNK, pos);
    pos -= n;
    const b = Buffer.allocUnsafe(n);
    fs.readSync(fd, b, 0, n, pos);
    const buf = carry.length ? Buffer.concat([b, carry]) : b;
    let stop = buf.length;
    let nl: number;
    while (stop > 0 && (nl = buf.lastIndexOf(10, stop - 1)) >= 0) {
      if (stop > nl + 1) yield buf.toString('utf8', nl + 1, stop);
      stop = nl;
    }
    carry = Buffer.from(buf.subarray(0, stop));
  }
  if (carry.length) yield carry.toString('utf8');
}

/** Legacy entries (logs from before envelope v3) mapped for display and for the answer matrix. */
function normalize(e: Entry): Entry {
  const n: Entry = { ...e };
  if (n.kind === 'concern') n.kind = 'objection';
  if (n.kind === 'agree' && n.plan_hash) n.kind = 'signoff';
  if (n.kind === 'plan_rev') { n.kind = 'proposal'; if (n.plan_hash && !n.hash) n.hash = n.plan_hash; }
  else if (n.plan_hash && !n.proposal_hash) n.proposal_hash = n.plan_hash;
  delete n.plan_hash;
  if (n.to == null) n.to = 'room';
  for (const k of ['from', 'to', 'by', 'owner'] as const) { const v = n[k]; if (typeof v === 'string') n[k] = members.roomClaudeName(v); } // 0.4.x "orch"
  return tag(n, STORE_OF.get(e));
}

// ---------- the human capability ----------
/**
 * via=human means "a person typed or answered this in their own terminal". Only hook processes (run by Claude
 * Code itself, never by a model) can write it: append() signs with the seat's private key, which it gets from
 * the signer a hook process installs (hooks/seat-key.ts arm()). The MCP server and the CLI never install one, so
 * they cannot write via=human at all. Readers verify with the key the room's log pins for that name (the join
 * hook puts it in member_joined). A threat model of one OS user per machine: this stops a model (its tools, the
 * room MCP server) from forging a person, not a hostile local user.
 */
const SIGNER = Symbol.for('sub-human.human-signer');
const KEY_PART_RE = /^[A-Za-z0-9_.-]{1,64}$/;
function keyDir(c: unknown): string {
  if (typeof c !== 'string' || !KEY_PART_RE.test(c) || c.startsWith('.')) throw new RoomError('INVALID', `invalid room code "${c}"`);
  return path.join(home(), 'keys', c);
}
function pubPath(name: unknown, c: unknown): string {
  if (typeof name !== 'string' || !KEY_PART_RE.test(name) || name.startsWith('.')) throw new RoomError('INVALID', `invalid name "${name}"`);
  return path.join(keyDir(c), `${name}.pub`);
}

function humanKey(c: string, from: string): KeyObject {
  const signer = (globalThis as unknown as Record<symbol, HumanSigner | undefined>)[SIGNER];
  let key: KeyObject | null | undefined = null;
  if (typeof signer === 'function') { try { key = signer(c, from); } catch { key = null; } }
  if (!key) throw new RoomError('INVALID', 'via "human" is written only by sub-human\'s hooks for a person\'s own typed words or answers; post as via "agent"');
  return key;
}

const pubCache = new Map<string, { mtimeMs: number; size: number; key: KeyObject | null }>(); // file -> {mtimeMs, size, key}
/** The seat's key from <home>/keys/<code>/<name>.pub: what a legacy room (no key pinned) verifies against. */
function localKey(name: string, c: string): KeyObject | null {
  let file: string;
  try { file = pubPath(name, c); } catch { return null; }
  let st: nodeFs.Stats;
  try { st = fs.statSync(file); } catch { pubCache.delete(file); return null; }
  const hit = pubCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.key;
  let key = null;
  try { key = envelope.parseKey(fs.readFileSync(file, 'utf8')); } catch { key = null; }
  pubCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, key });
  return key;
}

/** The key name's entries in store s verify against: the one pinned in the log; the local .pub only when it pins none. */
function publicKey(name: string, s: RoomStore): KeyObject | null {
  const pins = s.pins();
  return pins.size ? pins.get(name) || null : localKey(name, s.code);
}

const verdicts = new Map<string, boolean>(); // code \0 signed bytes \0 sig -> bool (bounded)
const VERDICTS_MAX = 4096;
/** The room a via=human entry was signed in: its `room` field (append stamps it), else the store that read it. */
const roomOf = (e: Entry): string | null => (typeof e.room === 'string' ? e.room : STORE_OF.get(e)?.code || null);
/** The store that read e when it holds e's room, else that room's store. */
function storeOf(e: Entry, c: string): RoomStore { const s = STORE_OF.get(e); return s && s.code === c ? s : open(c); }

function verifyHuman(e: Entry | null | undefined): boolean {
  if (!e || e.via !== 'human' || typeof e.sig !== 'string' || typeof e.from !== 'string') return false;
  const c = roomOf(e);
  if (!c) return false;
  const k = `${c}\0${envelope.signedBytes(e)}\0${e.sig}`;
  const hit = verdicts.get(k);
  if (hit !== undefined) return hit;
  let pub: KeyObject | null = null;
  try { pub = publicKey(e.from, storeOf(e, c)); } catch { pub = null; }
  if (!pub) return false; // no verdict cached: the key may be pinned later
  const ok = envelope.verify(e, pub);
  if (verdicts.size >= VERDICTS_MAX) verdicts.clear();
  verdicts.set(k, ok);
  return ok;
}
const unverifiedHuman = (e: Entry | null | undefined): boolean => !!e && e.via === 'human' && !verifyHuman(e);
/**
 * How far a via=human entry is the person's: 'verified' (its sig verifies), 'legacy' (no sig, in a room whose
 * log pins no key, from a seat with no local key: a room from before seat keys, or a reader that cannot tell
 * which room; shown "(unverified)" but still counted as an answer), 'unverified' (anything else: a bad sig, or
 * no sig in a keyed room or from a seat that has a key; never counted). null when not via=human.
 */
function humanTrust(e: Entry | null | undefined): HumanTrust | null {
  if (!e || e.via !== 'human') return null;
  if (verifyHuman(e)) return 'verified';
  if (e.sig !== undefined || typeof e.from !== 'string') return 'unverified';
  const c = roomOf(e);
  if (!c) return 'legacy';
  let keyed: boolean, file: string;
  try { keyed = storeOf(e, c).pins().size > 0; file = pubPath(e.from, c); } catch { return 'unverified'; }
  return keyed || fs.existsSync(file) ? 'unverified' : 'legacy';
}

// ---------- append = sign + place ----------
/** The log lock's timeout: RoomError LOCK with withLock's message (RoomError itself takes the code first). */
class LockError extends RoomError { constructor(message: string) { super('LOCK', message); } }

const auth = (msg: string): RoomError => new RoomError('AUTH', msg);
/** The envelope fields sign() adds (lib/room/envelope.ts); only a via=human payload carries them. */
const SIGNED_FIELDS = ['room', 'nonce', 'ts', 'sigv', 'sig'] as const;

/** The fields an entry is stored with before it is placed: validated fields v with from, via and by. */
function fieldsOf(v: Validated, from: string): Payload {
  const p: Payload = { from, via: v.via, kind: v.kind, to: v.to };
  if (v.refs && v.refs.length) p.refs = v.refs;
  if (v.hash) p.hash = v.hash;
  if (v.approvers) p.approvers = v.approvers;
  if (v.path) p.path = v.path;
  if (v.proposal_hash) p.proposal_hash = v.proposal_hash;
  if (v.task) {
    if (v.kind === 'task_req') p.by = from;
    Object.assign(p, v.task);
  }
  if (v.normalized !== undefined) p.normalized = v.normalized;
  if (v.edit_path) p.edit_path = v.edit_path;
  if (v.drafted) p.drafted = v.drafted;
  if (v.pubkey) p.pubkey = v.pubkey;
  if (v.machine) p.machine = v.machine;
  if (v.host) Object.assign(p, v.host);
  if (v.text !== undefined) p.text = v.text;
  return p;
}

/** The client half of append: validate, and sign a via=human payload with the seat's key (the hook's signer). */
function toPayload(c: string | null | undefined, entry: EntryInput, opts: ValidateOpts): Payload {
  const v = validate(entry, opts);
  if (!c) throw new RoomError('NO_ROOM', 'no room bound; run /sub-human');
  const p = fieldsOf(v, opts.from);
  return v.via === 'human' ? envelope.sign(p, humanKey(c, opts.from), { room: c, from: opts.from }) : p;
}

/**
 * The server half's first step: validate() a payload again (signed here or on another machine) and rebuild its
 * stored form, so a field validate() would drop or reshape breaks the signature instead of landing unsigned.
 * system: the caller may write via=system (trusted callers only, as for append).
 */
function admit(c: string | null | undefined, payload: Payload, { system }: PlaceOpts = {}): Payload {
  if (!c) throw new RoomError('NO_ROOM', 'no room bound; run /sub-human');
  if (!payload || typeof payload !== 'object') throw new RoomError('INVALID', 'payload must be an object');
  const { from, via, room, nonce, ts, sigv, sig, ...fields } = payload;
  const v = validate(fields as EntryInput, { via, from, system }); // validate() checks each field's type
  const p = fieldsOf(v, from);
  const signed = SIGNED_FIELDS.filter(k => payload[k] !== undefined);
  if (v.via !== 'human' && signed.length) throw new RoomError('INVALID', `${signed.join(', ')}: only a person's entry is signed`);
  for (const k of signed) Object.assign(p, { [k]: payload[k] });
  return p;
}

/** An agent post's rate bucket: the room, or the one member it is addressed to (legacy lines have no `to`). */
const bucket = (e: { to?: string }): string => (e.to && e.to !== 'room' ? e.to : 'room');
const rateMax = (p: Payload): number => (bucket(p) === 'room' ? config.RATE_MAX : config.RATE_ADDRESSED_MAX);

/**
 * The newest entries (newest first) as a placement needs them: the last id, the agent posts p.from made to p's
 * bucket inside RATE_WINDOW_MS, and whether p's nonce was placed already. A nonce is looked for back to 2 * SIG_SKEW_MS by
 * `at` (the host's clock): a payload with a fresh ts may have been placed up to SIG_SKEW_MS after it was signed.
 * The log is in time order, so the scan stops at the window.
 */
function scanTail(newest: Iterable<Entry>, p: Payload, now: number): { last: number | null; recent: number; replayed: boolean } {
  const span = p.via === 'agent' ? config.RATE_WINDOW_MS : p.nonce ? 2 * envelope.SIG_SKEW_MS : 0;
  let last: number | null = null, recent = 0, replayed = false;
  for (const e of newest) {
    if (last === null) last = e.id || 0;
    if (!span || now - Date.parse(e.at) >= span) break;
    if (p.via === 'agent' && e.from === p.from && e.via === 'agent' && bucket(e) === bucket(p) && ++recent >= rateMax(p)) break;
    if (p.nonce && e.nonce === p.nonce) { replayed = true; break; }
  }
  return { last, recent, replayed };
}

/** A via=human payload is the person's: v2, signed for this room, fresh, and verified against their pinned key. */
function checkSigned(s: RoomStore, p: Payload, now: number): void {
  if (!envelope.isV2(p) || typeof p.sig !== 'string') throw auth('a person\'s entry must be signed with their seat key (sig v2)');
  if (p.room !== s.code) throw auth(`signed for room ${p.room}, not ${s.code}`);
  if (!envelope.freshTs(p, now)) throw auth(`the signature's ts is more than ${envelope.SIG_SKEW_MS / 60_000} minutes from the host's clock`);
  const pub = publicKey(p.from, s);
  if (!pub) throw auth(`no key is pinned for ${p.from} in room ${s.code}; join again with /sub-human ${p.from} ${s.code}`);
  if (!envelope.verify(p, pub)) throw auth(`the signature does not verify against ${p.from}'s key`);
}

/** A member_joined pubkey pins its name at first sight; another key for a pinned name is refused. */
function checkPin(s: RoomStore, p: Payload): void {
  if (p.kind !== 'member_joined' || p.pubkey === undefined) return;
  const key = envelope.parseKey(p.pubkey);
  if (!key) throw new RoomError('INVALID', 'pubkey is not an Ed25519 public key');
  const pinned = s.pins().get(p.from);
  if (pinned && !pinned.equals(key)) throw auth(`${p.from} is pinned to another key in room ${s.code}; a lost key means a new name`);
}

/**
 * Place an admitted payload p in store s after its newest entries (newest first; prevLine: the last line as
 * stored): rate, replay, trust, then id, at and prev. Shared by every RoomStore, so the chain and the checks are
 * the same whatever the backend. Returns {e, line}; throws RATE, AUTH, or INVALID for a line over
 * LOG_LINE_MAX_BYTES.
 */
function placeAfter(s: RoomStore, p: Payload, { newest, prevLine, now }: { newest: Iterable<Entry>; prevLine: string; now: number }): { e: Entry; line: string } {
  const t = scanTail(newest, p, now);
  if (t.recent >= rateMax(p)) {
    const to = bucket(p) === 'room' ? '' : ` to ${p.to}`;
    throw new RoomError('RATE', `rate limit: ${p.from}'s Claude posted ${rateMax(p)} times${to} in the last minute; wait before posting again`);
  }
  if (t.replayed) throw auth('this signed entry was placed already (its nonce is in the log)');
  if (p.via === 'human') checkSigned(s, p, now);
  checkPin(s, p);
  const { sig, ...rest } = p;
  const e: Entry = { id: (t.last || 0) + 1, at: new Date(now).toISOString(), ...rest, prev: hash12(prevLine || '') };
  if (sig !== undefined) e.sig = sig;
  const line = JSON.stringify(e);
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > config.LOG_LINE_MAX_BYTES) {
    throw new RoomError('INVALID', `entry is too large (${bytes} bytes as stored; the limit is ${config.LOG_LINE_MAX_BYTES}). Shorten the text`);
  }
  return { e: tag(e, s), line };
}

/**
 * Who holds the room by its log: the last host_changed entry's {epoch, host, machine, locator, id}, else epoch 0.
 * @param {object[]} entries
 * @returns {{epoch: number, host?: string, machine?: string, locator?: string, id?: number}}
 */
function hostState(entries: readonly (Entry | null | undefined)[] | null | undefined): HostState {
  let h: HostState = { epoch: 0 };
  for (const e of entries || []) {
    if (e && e.kind === 'host_changed' && e.via === 'system' && typeof e.epoch === 'number' && Number.isInteger(e.epoch) && e.epoch > h.epoch) {
      h = { epoch: e.epoch, host: e.host, machine: e.machine, locator: e.locator, id: e.id };
    }
  }
  return h;
}

/** The log says the room moved to another machine; p may still be the host_changed that brings it here. */
function checkHere(s: RoomStore, p: Payload): void {
  const h = s.hostState();
  if (!h.machine || h.machine === machineId()) return;
  if (p.kind === 'host_changed' && p.machine === machineId() && p.epoch !== undefined && p.epoch > h.epoch) return;
  throw new RoomError('STALE', `room ${s.code} moved to ${h.host}'s machine (epoch ${h.epoch}); this machine's copy takes no more lines`);
}

// ---------- keys of the small documents ----------
const KEY_SEG = /^(?!\.)[A-Za-z0-9_.-]{1,128}$/;
function checkKey(key: unknown): string {
  const segs = typeof key === 'string' ? key.split('/') : [];
  if (!segs.length || segs.length > 3 || !segs.every(s => KEY_SEG.test(s))) throw new RoomError('INVALID', `invalid store key "${key}"`);
  return key as string; // its segments matched KEY_SEG
}
const BLOB_RE = /^(plans)\/([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$/;
/** A blob's room-relative ref ("plans/<x>"), from a ref or from the absolute path older entries stored. */
function blobRef(p: unknown): string | null {
  if (typeof p !== 'string' || !p) return null;
  if (BLOB_RE.test(p)) return p;
  if (path.isAbsolute(p)) { const m = /[\\/](plans)[\\/]([^\\/]+)$/.exec(p); if (m && BLOB_RE.test(`${m[1]}/${m[2]}`)) return `${m[1]}/${m[2]}`; }
  return null;
}
const CURSOR_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const checkCursor = (name: string): string => { if (!CURSOR_RE.test(name)) throw new RoomError('INVALID', `invalid cursor name "${name}"`); return name; };

// ---------- FsRoomStore ----------
/**
 * The parsed log, cached per file for the life of this process: a repeat call re-reads nothing when the file
 * is unchanged and parses only the appended bytes when it grew (same inode, the bytes before the old end
 * unchanged). A shrink, a new inode, a same-size rewrite or a changed tail drops the cache and re-reads.
 */
const readCache = new Map<string, ReadCache>(); // file -> {dev, ino, size, mtimeMs, offset, tail, entries, partial}
const TAIL_CHECK = 64;       // bytes before the cached end compared on growth

/**
 * <room>/log.idx = {v:1, offset, id, hash, count, marks}: the log's first `offset` bytes (`count` lines,
 * last id `id`) were checked to chain, and hash = hash12 of the line that ends at offset (the next line's prev).
 * marks = [[id, offset, length], ...] for every line in that prefix whose kind is not a chat kind (say,
 * status): the lines that decide lanes, proposals, answers, notices. It is a cache: written atomically by
 * verifyChain() and readView() whenever they get further, trusted only while the line before `offset` still
 * hashes to `hash`, and rebuilt from byte 0 otherwise.
 */
const ZERO = (): Checkpoint => ({ v: 1, offset: 0, id: 0, hash: hash12(''), count: 0, marks: [] });

function atBoundary(fd: number, off: number): boolean {
  if (off === 0) return true;
  const b = Buffer.alloc(1);
  fs.readSync(fd, b, 0, 1, off - 1);
  return b[0] === 10;
}
const lineBefore = (fd: number, off: number): string => { for (const l of linesBackward(fd, off)) return l; return ''; };
/** One backward read from byte `end`: the last line (the next entry's prev) and the parseable entries, newest first. */
function tailFrom(fd: number, end: number): { prevLine: string; newest: Generator<Entry> } {
  const lines = linesBackward(fd, end);
  const first = lines.next();
  function* newest(): Generator<Entry> {
    for (let n = first; !n.done; n = lines.next()) {
      let e: Entry | null = null;
      try { e = JSON.parse(n.value as string); } catch { /* corrupt line: skip */ }
      if (e && typeof e === 'object') yield e;
    }
  }
  return { prevLine: first.done ? '' : first.value, newest: newest() };
}
const readRange = (fd: number, off: number, len: number): Buffer => { const b = Buffer.allocUnsafe(len); fs.readSync(fd, b, 0, len, off); return b; };

/** The first line starting at or after byte pos (< end): {start, end, id} (id null for a line without one), or null. */
function lineAt(fd: number, pos: number, end: number): LineSpan | null {
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
function offsetAfter(fd: number, end: number, after: number): number {
  let lo = 0, hi = end;
  const idAt = (pos: number): LineSpan | null => { let L = lineAt(fd, pos, end); while (L && L.id === null) L = lineAt(fd, L.end, end); return L; };
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const L = idAt(mid);
    if (!L || L.id! > after) hi = mid; else lo = mid + 1; // idAt skips lines without an id
  }
  const L = idAt(lo);
  return L ? L.start : end;
}

/** The last line boundary at or before the end of the file (0 when there is no file). */
function endOffset(xfs: TailerFs, file: string): number {
  let fd: number;
  try { fd = xfs.openSync(file, 'r'); } catch (e) { if (errCode(e) === 'ENOENT') return 0; throw e; }
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

class FsRoomStore implements RoomStore {
  declare code: string;
  declare _dir: string | null;
  declare isHost: boolean;
  declare members: MembersApi;
  declare blobs: BlobsApi;
  declare kv: KvApi;
  /** pins() and hostState() caches, keyed by the log file's dev:ino:size:mtime */
  declare _pins?: { k: string; map: Map<string, KeyObject> };
  declare _host?: { k: string; h: HostState };
  /** a host_changed was placed through this store */
  declare _moves?: boolean;

  /** code: the room code; dir: its directory (default <home>/rooms/<code>, read at each call). */
  constructor(code: string, { dir }: { dir?: string } = {}) {
    if (!dir) roomDir(code); // validates the code
    this.code = code;
    this._dir = dir || null;
    this.isHost = true;
    const self = this;
    this.members = {
      read: () => self._readMembers(),
      update: fn => self._updateMembers(fn),
      ...members.ops(this),
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
  get dir(): string { return this._dir || roomDir(this.code); }
  get logFile(): string { return path.join(this.dir, LOG); }
  exists(): boolean { return fs.existsSync(this.dir); }

  // ----- reading -----
  readAll(): Entry[] {
    const file = this.logFile;
    let fd: number;
    try { fd = fs.openSync(file, 'r'); } catch (e) {
      if (errCode(e) === 'ENOENT') { readCache.delete(file); return []; }
      throw e;
    }
    try {
      const st = fs.fstatSync(fd);
      let c: ReadCache | null | undefined = readCache.get(file);
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
      if (cut >= skip) for (const e of parseLines(buf.toString('utf8', skip, cut + 1), this)) entries.push(e);
      const offset = cut >= skip ? start + cut + 1 : (c ? c.offset : 0);
      // A last line with no newline yet (torn, or written by a non-appender): parsed, never cached.
      const partial = parseLines(buf.toString('utf8', Math.max(skip, cut + 1)), this);
      const tailStart = Math.max(0, offset - start - TAIL_CHECK);
      const tail = Buffer.from(buf.subarray(tailStart, offset - start));
      readCache.set(file, { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, offset, tail, entries, partial });
      return entries.concat(partial);
    } finally { fs.closeSync(fd); }
  }

  readById(ids: number | string | readonly (number | string)[]): Entry[] {
    const want = (Array.isArray(ids) ? ids : [ids]).map(Number);
    const byId = new Map(this.readAll().map(e => [e.id, e]));
    return want.filter(i => byId.has(i)).map(i => byId.get(i)!);
  }
  readAfter(seq: number, filterFn: (e: Entry) => boolean = () => true): Entry[] { return this.readAll().filter(e => e.id > seq && filterFn(e)); }
  since(id: number): Entry[] { return this.readAfter(id); }

  /** The id of the last parseable line, from a read of the log's tail only. */
  lastId(): number {
    let fd: number;
    try { fd = fs.openSync(this.logFile, 'r'); } catch (e) { if (errCode(e) === 'ENOENT') return 0; throw e; }
    try {
      for (const l of linesBackward(fd, fs.fstatSync(fd).size)) {
        try { return JSON.parse(l).id || 0; } catch { /* corrupt: keep looking */ }
      }
      return 0;
    } finally { fs.closeSync(fd); }
  }

  /** Poll the log for entries with id > after. Handles torn reads and a reset (truncated) log. */
  watch(onEntry: (e: Entry) => void, { after = 0, intervalMs = config.FOLLOW_POLL_MS }: { after?: number; intervalMs?: number } = {}): () => void {
    const file = this.logFile, self = this;
    let offset = 0, seen = after, buf = '';
    const tick = () => {
      let fd: number;
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
        for (const e of parseLines(complete, self)) {
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
   * (the first poll: since tailer() was called, or after the line with id `after`), parsed and verbatim.
   * reset: the log shrank (it was reset), and reading began again from its start. The caller drops ids it has
   * seen. xfs: the fs module to read with (tests inject faults).
   */
  tailer({ fs: xfs = nodeFs, after }: { fs?: TailerFs; after?: number } = {}): Tailer {
    const file = this.logFile, self = this;
    let offset = after === undefined ? endOffset(xfs, file) : this._offsetAfter(after);
    return {
      get offset() { return offset; },
      poll() {
        let st: nodeFs.Stats;
        try { st = xfs.statSync(file); } catch (e) { if (errCode(e) === 'ENOENT') return { entries: [], lines: [], reset: false }; throw e; }
        let reset = false;
        if (st.size < offset) { offset = 0; reset = true; }
        if (st.size === offset) return { entries: [], lines: [], reset };
        const fd = xfs.openSync(file, 'r');
        let buf: Buffer;
        try {
          buf = Buffer.allocUnsafe(st.size - offset);
          xfs.readSync(fd, buf, 0, buf.length, offset);
        } finally { xfs.closeSync(fd); }
        const entries: Entry[] = [], lines: string[] = [];
        let pos = 0;
        for (let nl: number; (nl = buf.indexOf(10, pos)) >= 0; pos = nl + 1) {
          if (nl > pos) {
            const line = buf.toString('utf8', pos, nl);
            lines.push(line);
            try { entries.push(tag(JSON.parse(line), self)); } catch { /* corrupt */ }
          }
          offset += nl + 1 - pos;
        }
        return { entries, lines, reset };
      },
    };
  }

  /** The byte offset of the first complete line whose id is > after (the end of the complete lines when none is). */
  _offsetAfter(after: number): number {
    const end = endOffset(fs, this.logFile);
    if (!end) return 0;
    const fd = fs.openSync(this.logFile, 'r');
    try { return offsetAfter(fd, end, after); } finally { fs.closeSync(fd); }
  }

  lineHash(id: number): string | null {
    if (id === 0) return hash12('');
    if (!Number.isInteger(id) || id < 0) return null;
    let fd: number;
    try { fd = fs.openSync(this.logFile, 'r'); } catch (e) { if (errCode(e) === 'ENOENT') return null; throw e; }
    try {
      const end = fs.fstatSync(fd).size;
      const L = lineAt(fd, offsetAfter(fd, end, id - 1), end);
      if (!L || L.id !== id) return null;
      const b = readRange(fd, L.start, L.end - L.start);
      return hash12(b[b.length - 1] === 10 ? b.subarray(0, -1) : b);
    } finally { fs.closeSync(fd); }
  }

  // ----- writing -----
  append(entry: EntryInput, opts: AppendOpts & { queue: true }): Placed;
  append(entry: EntryInput, opts?: AppendOpts): Entry;
  // no opts: validate() refuses the missing from
  append(entry: EntryInput, opts: AppendOpts = {} as AppendOpts): Placed { return this.place(toPayload(this.code, entry, opts), opts); }

  /** Under the log lock, read only the log's tail (placeAfter stops at its window), then write one line. */
  place(payload: Payload, opts: PlaceOpts & { queue: true }): Placed;
  place(payload: Payload, opts?: PlaceOpts): Entry;
  place(payload: Payload, opts: PlaceOpts = {}): Placed {
    const d = this.dir; // NO_ROOM / invalid code before anything else
    const p = admit(this.code, payload, opts);
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    const file = this.logFile;
    return withLock(file + '.lock', () => {
      const fd = fs.openSync(file, 'a+', 0o600);
      try {
        if (this._mayHaveMoved()) checkHere(this, p);
        const size = fs.fstatSync(fd).size;
        let endsNl = true;
        if (size) { const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, size - 1); endsNl = b[0] === 10; }
        const { e, line } = placeAfter(this, p, { ...tailFrom(fd, size), now: Date.now() });
        fs.writeSync(fd, (endsNl ? '' : '\n') + line + '\n');
        if (e.kind === 'host_changed') this._moves = true;
        return e;
      } finally { fs.closeSync(fd); }
    }, { ErrorClass: LockError });
  }

  /** The keys pinned in the log: envelope.pinnedKeys over the non-chat entries, cached until the file changes. */
  pins(): Map<string, KeyObject> {
    let st: nodeFs.Stats;
    try { st = fs.statSync(this.logFile); } catch { return new Map(); }
    const k = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
    if (!this._pins || this._pins.k !== k) this._pins = { k, map: envelope.pinnedKeys(this.readView({ after: Infinity, save: false })) };
    return this._pins.map;
  }

  /**
   * Whether the log may say the room moved, so place() must read hostState: a host_changed placed through this
   * store, or a handoff on record here (lib/handoff.ts keeps its host document from the ask on). Otherwise an append
   * reads only the log's tail.
   */
  _mayHaveMoved(): boolean { return !!this._moves || fs.existsSync(this._kvFile('remote/handoff')); }

  /** The last host_changed entry's {epoch, host, machine, locator, id}, else {epoch: 0}; cached until the log changes. */
  hostState(): HostState {
    let st: nodeFs.Stats;
    try { st = fs.statSync(this.logFile); } catch { return { epoch: 0 }; }
    const k = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
    if (!this._host || this._host.k !== k) this._host = { k, h: hostState(this.readView({ after: Infinity, save: false })) };
    return this._host.h;
  }

  setAside(): string | null {
    if (!fs.existsSync(this.logFile)) return null;
    const file = path.join(this.dir, `orphaned-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
    fs.renameSync(this.logFile, file);
    for (const f of [this._idxPath, this._membersFile]) fs.rmSync(f, { force: true });
    readCache.delete(this.logFile);
    return file;
  }

  /** Check the whole prev chain. Returns {ok:true, count} or {ok:false, badAt: id, count} ({line} for a corrupt line). */
  validateChain(): ChainCheck {
    let raw = '';
    try { raw = fs.readFileSync(this.logFile, 'utf8'); } catch { return { ok: true, count: 0 }; }
    const lines = raw.split('\n').filter(Boolean);
    let prev = '';
    for (let i = 0; i < lines.length; i++) {
      let e: Entry;
      try { e = JSON.parse(lines[i]); } catch { return { ok: false, badAt: null, line: i + 1, count: lines.length }; }
      if (e.prev !== undefined && e.prev !== hash12(prev)) return { ok: false, badAt: e.id, count: lines.length };
      prev = lines[i];
    }
    return { ok: true, count: lines.length };
  }

  // ----- the verified checkpoint (log.idx), incremental verification, the hook view -----
  get _idxPath(): string { return path.join(this.dir, IDX_FILE); }
  /** The saved checkpoint if it still matches the file, else the zero checkpoint. */
  _checkpoint(fd: number, size: number): Checkpoint {
    const x = readJson(this._idxPath);
    if (x && x.v === 1 && Number.isInteger(x.offset) && x.offset >= 0 && x.offset <= size && typeof x.hash === 'string'
      && Array.isArray(x.marks) && atBoundary(fd, x.offset) && hash12(x.offset ? lineBefore(fd, x.offset) : '') === x.hash) return x;
    return ZERO();
  }
  _saveCheckpoint(cp: Checkpoint): void { try { writeJsonAtomic(this._idxPath, cp, { compact: true }); } catch { /* read-only: next call rescans */ } }

  /**
   * Parse the complete lines in [cp.offset, size), checking the chain from cp. Returns the parsed lines
   * ([{off, e}], corrupt ones left out), the checkpoint advanced over every line that chains (it stops at the
   * first break), and the break ({badAt} or {line}) if any. A last line without its newline is not scanned.
   */
  _scan(fd: number, size: number, cp: Checkpoint): { out: { off: number; e: Entry }[]; next: Checkpoint; bad: ChainBreak | null; complete: number } {
    const start = cp.offset;
    const buf = Buffer.allocUnsafe(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const cut = buf.lastIndexOf(10);
    const out: { off: number; e: Entry }[] = [];
    const next: Checkpoint = { ...cp, marks: cp.marks.slice() };
    let bad: ChainBreak | null = null, pos = 0;
    while (cut >= 0 && pos <= cut) {
      const nl = buf.indexOf(10, pos);
      if (nl > pos) {
        const l = buf.toString('utf8', pos, nl);
        let e: Entry | null = null;
        try { e = tag(JSON.parse(l), this); } catch { if (!bad) bad = { badAt: null, line: next.count + 1 }; }
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
  verifyChain({ fromOffset, prev, save = true }: { fromOffset?: number; prev?: string; save?: boolean } = {}): ChainVerify {
    let fd: number;
    try { fd = fs.openSync(this.logFile, 'r'); } catch (e) {
      if (errCode(e) === 'ENOENT') return { ok: true, count: 0, checked: 0, offset: 0, id: 0, hash: hash12(''), from: 0 };
      throw e;
    }
    try {
      const size = fs.fstatSync(fd).size;
      let cp: Checkpoint;
      if (fromOffset !== undefined) {
        if (!Number.isInteger(fromOffset) || fromOffset < 0 || fromOffset > size || !atBoundary(fd, fromOffset)) {
          const error = 'fromOffset is not a line boundary of the log';
          return { ok: false, badAt: null, count: 0, checked: 0, offset: fromOffset, from: fromOffset, error };
        }
        cp = { ...ZERO(), offset: fromOffset, hash: typeof prev === 'string' ? prev : hash12(fromOffset ? lineBefore(fd, fromOffset) : '') };
      } else cp = this._checkpoint(fd, size);
      const { next, bad } = this._scan(fd, size, cp);
      if (save && fromOffset === undefined && next.offset > cp.offset) this._saveCheckpoint(next);
      const r: ChainVerify = {
        ok: !bad, count: next.count, checked: next.count - cp.count, offset: next.offset, id: next.id, hash: next.hash, from: cp.offset,
      };
      return bad ? { ...r, ...bad } : r;
    } finally { fs.closeSync(fd); }
  }

  /**
   * What a hook needs without parsing the whole log: every non-chat entry (proposals, answers, decisions,
   * tasks, joins and leaves) and every entry with id > after, in log order. Advances
   * log.idx as verifyChain() does, unless save is false.
   */
  readView({ after = 0, save = true }: ReadViewOpts = {}): Entry[] {
    if (!(after > 0)) return this.readAll();
    let fd: number;
    try { fd = fs.openSync(this.logFile, 'r'); } catch (e) { if (errCode(e) === 'ENOENT') return []; throw e; }
    try {
      const size = fs.fstatSync(fd).size;
      const cp = this._checkpoint(fd, size);
      const got = new Map<number, Entry>(); // offset -> entry
      const parse = (buf: Buffer): Entry | null => { try { return tag(JSON.parse(buf.toString('utf8')), this); } catch { return null; } };
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
      if (save && next.offset > cp.offset) this._saveCheckpoint(next);
      const complete = scanned.complete;
      if (size > complete) { // no newline yet; readAll() parses it too
        const e = parse(readRange(fd, complete, size - complete));
        if (e && (!CHAT_KINDS.has(e.kind) || e.id > after)) got.set(complete, e);
      }
      return [...got.entries()].sort((x, y) => x[0] - y[0]).map(x => x[1]);
    } finally { fs.closeSync(fd); }
  }

  // ----- cursors -----
  _cursorFile(name: string): string { return path.join(this.dir, `${checkCursor(name)}.cursor`); }
  getCursor(name: string): number { try { return Number(fs.readFileSync(this._cursorFile(name), 'utf8')) || 0; } catch { return 0; } }
  /** Atomic (write + rename), so a concurrent reader never sees an empty file. */
  setCursor(name: string, n: number): void { writeFileAtomic(this._cursorFile(name), String(n)); }

  // ----- members -----
  get _membersFile(): string { return path.join(this.dir, MEMBERS); }
  _readMembers(): Members { try { return members.fromLegacy(readJson(this._membersFile, {}) || {}); } catch { return {}; } }
  _updateMembers(fn: (current: Members) => Members | null | undefined): Members | null {
    const file = this._membersFile;
    return withLock(file + '.lock', () => {
      const next = fn(this._readMembers());
      if (!next) return null;
      writeJsonAtomic(file, next);
      return next;
    });
  }

  // ----- blobs -----
  _blobPut(name: string, bytes: string | Uint8Array): string {
    if (!BLOB_RE.test(String(name))) throw new RoomError('INVALID', `invalid blob name "${name}"`);
    writeFileAtomic(path.join(this.dir, name), bytes);
    return name;
  }
  _blobGet(ref: string): Buffer | null {
    const r = blobRef(ref);
    if (!r) return null;
    try { return fs.readFileSync(path.join(this.dir, r)); } catch { return null; }
  }

  // ----- kv -----
  _kvFile(key: string): string { return path.join(this.dir, `${checkKey(key)}.json`); }
  _kvSet(key: string, value: unknown, { compact = false }: { compact?: boolean } = {}): void { writeJsonAtomic(this._kvFile(key), value, { compact }); }
  // any: a kv document is JSON from disk (KvApi)
  _kvUpdate<T = any>(key: string, fn: (current: T | null) => T | null | undefined, { compact = false, timeoutMs, staleMs }: KvUpdateOpts = {}): T | null | undefined {
    const file = this._kvFile(key);
    const lockOpts: LockOpts = {};
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
  _kvList(prefix: unknown): string[] {
    const p = String(prefix || '');
    if (p && !p.endsWith('/')) throw new RoomError('INVALID', `kv.list needs a "dir/" prefix, not "${prefix}"`);
    if (p) checkKey(p.slice(0, -1));
    let files: nodeFs.Dirent[];
    try { files = fs.readdirSync(path.join(this.dir, p), { withFileTypes: true }); } catch { return []; }
    return files.filter(d => d.isFile() && d.name.endsWith('.json') && KEY_SEG.test(d.name.slice(0, -5))).map(d => p + d.name.slice(0, -5)).sort();
  }

  // ----- locks -----
  lock<R>(name: string, fn: () => R, opts?: LockOpts): R { return withLock(path.join(this.dir, `${checkKey(name)}.lock`), fn, opts); }
}

// ---------- rooms ----------
let backend: ((code: string) => RoomStore) | null = null; // tests: code -> RoomStore
const stores = new Map<string, FsRoomStore>(); // home \0 code -> FsRoomStore | MirrorRoomStore
/** A room hosted elsewhere: the link registry knows it (required here, not at load: store-mirror.ts extends this file). */
const linked = (c: string): boolean => require('./links.ts').has(c);
/**
 * The store of room `code`: a MirrorRoomStore when this machine links to the room (lib/room/links.ts), else an
 * FsRoomStore; decided once per home and code. {dir} (and only then) gives an uncached FsRoomStore over that directory.
 */
function open(c: string, { dir }: { dir?: string } = {}): RoomStore {
  if (backend) return backend(c);
  if (dir) return new FsRoomStore(c, { dir });
  const k = `${home()}\0${c}`;
  let s = stores.get(k);
  if (!s || s.isHost === linked(c)) { // none yet, or a handoff wrote or removed the link since
    repairModes(); // a home an older version made 0755 (once per home and process)
    const mirror: typeof import('./store-mirror.ts') | null = linked(c) ? require('./store-mirror.ts') : null;
    s = mirror ? new mirror.MirrorRoomStore(c) : new FsRoomStore(c);
    stores.set(k, s);
  }
  return s;
}
/** Drop the cached store of room c (this home): the next open() decides its kind again. */
const forget = (c: string): void => { stores.delete(`${home()}\0${c}`); };
const setBackend = (fn: ((code: string) => RoomStore) | null | undefined): void => { backend = typeof fn === 'function' ? fn : null; };
const roomExists = (c: unknown): boolean => typeof c === 'string' && CODE_RE.test(c) && (fs.existsSync(roomDir(c)) || linked(c));
/** Create room `code` (private, exclusive): false when it already exists. */
function createRoom(c: string): boolean {
  fs.mkdirSync(roomsDir(), { recursive: true, mode: 0o700 }); // the home and rooms/ too when new: private
  repairModes();
  try { fs.mkdirSync(roomDir(c), { mode: 0o700 }); return true; } catch (e) { if (errCode(e) === 'EEXIST') return false; throw e; }
}
const listRooms = (): string[] => { try { return fs.readdirSync(roomsDir()).filter(c => CODE_RE.test(c)); } catch { return []; } };

export {
  RoomError, FsRoomStore, open, forget, setBackend, roomExists, createRoom, listRooms, hostState, hash12, normalize,
  tag, roomOf, toPayload, admit, placeAfter, blobRef, checkKey, checkCursor, CHAT_KINDS, SIGNER, humanKey, keyDir,
  pubPath, publicKey, verifyHuman, unverifiedHuman, humanTrust,
};
