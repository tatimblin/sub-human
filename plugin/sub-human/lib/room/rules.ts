/**
 * plugin/sub-human/lib/room/rules.ts: the placement rules every RoomStore shares, so the chain and the checks are the
 * same whatever the backend (the file store, a test's memory store, the host placing a mirror's payload). Pure: the
 * log's newest entries and its keys come in; nothing here reads a file.
 *
 *   toPayload(code, entry, opts) -> Payload    the client half of append: validate() (validate.ts), then sign a
 *       via=human payload with the seat's key (trust.ts humanKey: the hook's signer). The payload then carries room,
 *       nonce, ts, sigv and sig (sig v2, envelope.ts). No signer, or no key for (room, from) -> RoomError INVALID.
 *   admit(code, payload, {system}) -> Payload  the server half's first step: validate() again (signed here or on
 *       another machine) and rebuild the stored form, so a field validate() would drop or reshape breaks the
 *       signature instead of landing unsigned. system: the caller may write via=system (trusted callers only)
 *   placeAfter(p, {keys, newest, prevLine, now}) -> {e, line}   place an admitted payload after the log's newest
 *       entries (newest first; prevLine: the last line as stored): rate, replay, trust (checkSigned, checkPin), then
 *       id (monotonic), at, prev (hash12 of the previous line). Throws RATE, AUTH, or INVALID for a line over LOG_LINE_MAX_BYTES. The sig covers the payload, not its place, so a
 *       payload signed on one machine may be placed on another.
 *   scanTail(newest, p, now) -> {last, recent, replayed}   the tail as a placement needs it (below)
 *   rates: per `from` per RATE_WINDOW_MS, agent posts to the room RATE_MAX, to one member RATE_ADDRESSED_MAX (a
 *       bucket per (from, to)), and a person's own entries RATE_HUMAN_MAX (high: a person never reaches it; a script
 *       flooding through the hooks does. A link's posts have the host's per-link quotas, LINK_QUOTAS,
 *       lib/remote/server.ts). RoomError RATE
 *   checkSigned(p, keys, now)    a via=human payload is the person's: v2, signed for this room, ts within
 *                                SIG_SKEW_MS of now, verified against their pinned key. RoomError AUTH
 *   checkPin(p, keys)            a member_joined pubkey pins its name at first sight; another key for it: AUTH
 *   normalize(e)                 a copy of e addressed to the room when it names no one
 *   CHAT_KINDS                   say, status: the kinds a view may leave out (everything else decides state)
 *   blobRef(pathOrRef), checkKey(key), checkCursor(name)   the names a store's documents, blobs and cursors take
 */

import * as config from '../config.ts';
import { hash12 } from '../text.ts';
import { RoomError, validate, nextEntryId } from './validate.ts';
import * as envelope from './envelope.ts';
import { humanKey, publicKey } from './trust.ts';
import type { Entry, EntryInput, Payload, PlaceOpts, TrustCtx, Validated, ValidateOpts } from './types.ts';
import type { RoomCode } from '../brand.ts';

const CHAT_KINDS: ReadonlySet<string> = new Set(['say', 'status']);
const auth = (msg: string): RoomError => new RoomError('AUTH', msg);
/** The envelope fields sign() adds (lib/room/envelope.ts); only a via=human payload carries them. */
const SIGNED_FIELDS = ['room', 'nonce', 'ts', 'sigv', 'sig'] as const;

/** e addressed to the room when it names no one. A new object. */
function normalize(e: Entry): Entry {
  const n: Entry = { ...e };
  n.to ??= 'room';
  return n;
}

// ---------- append = sign + place ----------
/** The fields an entry is stored with before it is placed: validated fields v with from, via and by. */
function fieldsOf(v: Validated, from: string): Payload {
  const p: Payload = { from, via: v.via, kind: v.kind, to: v.to };
  if (v.refs && v.refs.length) p.refs = v.refs;
  if (v.hash) p.hash = v.hash;
  if (v.approvers) p.approvers = v.approvers;
  if (v.same) p.same = v.same;
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
  if (v.text !== undefined) p.text = v.text;
  return p;
}

function toPayload(c: RoomCode | null | undefined, entry: EntryInput, opts: ValidateOpts): Payload {
  const v = validate(entry, opts);
  if (!c) throw new RoomError('NO_ROOM', 'no room bound; run /sub-human');
  const p = fieldsOf(v, opts.from);
  return v.via === 'human' ? envelope.sign(p, humanKey(c, opts.from), { room: c, from: opts.from }) : p;
}

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

// ---------- the rates ----------
/** A post's rate bucket: a person's own entries; an agent post's room, or the one member it is addressed to. */
const bucket = (e: { via?: string; to?: string }): string => (e.via === 'human' ? 'human' : e.to && e.to !== 'room' ? e.to : 'room');
const rateMax = (p: Payload): number => (p.via === 'human' ? config.RATE_HUMAN_MAX : bucket(p) === 'room' ? config.RATE_MAX : config.RATE_ADDRESSED_MAX);
const rated = (p: Payload): boolean => p.via === 'agent' || p.via === 'human';

/**
 * The newest entries (newest first) as a placement needs them: the last id, the posts p.from made to p's bucket
 * inside RATE_WINDOW_MS, and whether p's nonce was placed already. A nonce is looked for back to 2 * SIG_SKEW_MS by
 * `at` (the host's clock): a payload with a fresh ts may have been placed up to SIG_SKEW_MS after it was signed.
 * The log is in time order, so the scan stops at the window.
 */
function scanTail(newest: Iterable<Entry>, p: Payload, now: number): { last: number | null; recent: number; replayed: boolean } {
  const rate = rated(p) ? config.RATE_WINDOW_MS : 0;
  const span = Math.max(rate, p.nonce ? 2 * envelope.SIG_SKEW_MS : 0);
  const max = rateMax(p), b = bucket(p);
  let last: number | null = null, recent = 0, replayed = false;
  for (const e of newest) {
    last ??= e.id || 0;
    const age = now - Date.parse(e.at);
    if (!span || age >= span) break;
    if (age < rate && e.from === p.from && e.via === p.via && bucket(e) === b && ++recent >= max && !p.nonce) break;
    if (p.nonce && e.nonce === p.nonce) { replayed = true; break; }
  }
  return { last, recent, replayed };
}

// ---------- trust ----------
function checkSigned(p: Payload, keys: TrustCtx, now: number): void {
  if (!envelope.isV2(p) || typeof p.sig !== 'string') throw auth('a person\'s entry must be signed with their seat key (sig v2)');
  if (p.room !== keys.code) throw auth(`signed for room ${p.room}, not ${keys.code}`);
  if (!envelope.freshTs(p, now)) throw auth(`the signature's ts is more than ${envelope.SIG_SKEW_MS / 60_000} minutes from the host's clock`);
  const pub = publicKey(p.from, keys);
  if (!pub) throw auth(`no key is pinned for ${p.from} in room ${keys.code}; join again with /sub-human ${p.from} ${keys.code}`);
  if (!envelope.verify(p, pub)) throw auth(`the signature does not verify against ${p.from}'s key`);
}

function checkPin(p: Payload, keys: Pick<TrustCtx, 'code' | 'pins'>): void {
  if (p.kind !== 'member_joined' || p.pubkey === undefined) return;
  const key = envelope.parseKey(p.pubkey);
  if (!key) throw new RoomError('INVALID', 'pubkey is not an Ed25519 public key');
  const pinned = keys.pins().get(p.from);
  if (pinned && !pinned.equals(key)) throw auth(`${p.from} is pinned to another key in room ${keys.code}; a lost key means a new name`);
}

// ---------- placing ----------
interface PlaceCtx {
  /** the room's keys (TrustCtx: its code and pinned keys) */
  keys: TrustCtx;
  newest: Iterable<Entry>;
  prevLine: string;
  now: number;
}

function placeAfter(p: Payload, { keys, newest, prevLine, now }: PlaceCtx): { e: Entry; line: string } {
  const t = scanTail(newest, p, now);
  if (rated(p) && t.recent >= rateMax(p)) {
    const to = bucket(p) === 'room' || bucket(p) === 'human' ? '' : ` to ${p.to}`;
    const who = p.via === 'human' ? p.from : `${p.from}'s Claude`;
    throw new RoomError('RATE', `rate limit: ${who} posted ${rateMax(p)} times${to} in the last minute; wait before posting again`);
  }
  if (t.replayed) throw new RoomError('AUTH', 'this signed entry was placed already (its nonce is in the log)', 'PLACED_ALREADY');
  if (p.via === 'human') checkSigned(p, keys, now);
  checkPin(p, keys);
  const { sig, ...rest } = p;
  const e: Entry = { id: nextEntryId(t.last || 0), at: new Date(now).toISOString(), ...rest, prev: hash12(prevLine || '') };
  if (sig !== undefined) e.sig = sig;
  const line = JSON.stringify(e);
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > config.LOG_LINE_MAX_BYTES) {
    throw new RoomError('INVALID', `entry is too large (${bytes} bytes as stored; the limit is ${config.LOG_LINE_MAX_BYTES}). Shorten the text`);
  }
  return { e, line };
}

// ---------- names ----------
const KEY_SEG: RegExp = /^(?!\.)[A-Za-z0-9_.-]{1,128}$/;
function checkKey(key: unknown): string {
  const segs = typeof key === 'string' ? key.split('/') : [];
  if (!segs.length || segs.length > 3 || !segs.every(s => KEY_SEG.test(s))) throw new RoomError('INVALID', `invalid store key "${key}"`);
  return key as string; // its segments matched KEY_SEG
}
const BLOB_RE: RegExp = /^(plans)\/([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$/;
/** A blob's room-relative ref ("plans/<x>"), or null. */
const blobRef = (p: unknown): string | null => (typeof p === 'string' && BLOB_RE.test(p) ? p : null);
const CURSOR_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const checkCursor = (name: string): string => { if (!CURSOR_RE.test(name)) throw new RoomError('INVALID', `invalid cursor name "${name}"`); return name; };

export {
  RoomError, CHAT_KINDS, KEY_SEG, BLOB_RE, normalize, fieldsOf, toPayload, admit, scanTail, checkSigned, checkPin,
  placeAfter, checkKey, blobRef, checkCursor, hash12,
};
export type { PlaceCtx };
