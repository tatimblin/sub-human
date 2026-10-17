/**
 * plugin/sub-human/lib/room/store-mirror.ts: MirrorRoomStore, the RoomStore of a room hosted on another machine:
 * it composes an FsRoomStore over a directory the link daemon (lib/remote/link.ts) keeps line for line the host's
 * log, so every reader (readView, the snapshot, tailer, verifyChain, rows, digests) is that store's, unchanged. Only writes cross the
 * wire, as named ops through lib/remote/bridge.ts (a sync call from the hook's thread, with a deadline) to the
 * daemon's socket. The bridge (a worker thread) starts at the process's first op, so a hook that only reads
 * starts none. store.open(code) returns one for a code that lib/room/links.ts knows.
 *
 * Reads: the local FsRoomStore's, over the mirror directory (trust too: the keys the mirrored log pins).
 * Writes (RoomError codes in lib/remote/protocol.ts CODES): OFFLINE when the daemon or the host is unreachable and
 * nothing was sent or queued; a daemon that stopped for good gives its own reason and code from its document `link`
 * (e.g. AUTH for a refused invite); a deadline that passed after the op went out is OFFLINE with unknown: true: it
 * may still land, and retrying is safe.
 *   append/place: op `append`, signed here by the hook's signer. The placed entry is returned once the mirror holds
 *       it (the host streams a write's lines before its reply: read-your-writes). The host refuses a via=system
 *       payload (AUTH): it writes the room's own entries. opts.queue (hooks/handlers/at-room.ts only): with the link
 *       down the daemon queues the post; online, a post the host has not answered in time comes back queued: n,
 *       slow: true (in flight, kept under its nonce: the late copy is the post). With no daemon answering
 *       (DAEMON_DOWN) the post goes into the outbox here and comes back queued: n, restarting: true.
 * A daemon that is gone (DAEMON_DOWN: killed, crashed, idle) is started again, detached and without waiting, by any
 * op but leave, unless the link is over for good; its stale records are marked offline first (_markGone). An op other
 * than a queued post is then refused OFFLINE DAEMON_DOWN, "try again in a moment".
 *   members.join sends the seat's public key and a proof (lib/remote/host-links.ts proveSeat), both from the hook's
 *       signer; any RoomError comes back as {ok: false, error, code}. beat is skipped (true) while the lease is
 *       younger than SEAT_BEAT_MS and presence is unchanged. update is HOST_ONLY (room Claude bookkeeping never runs here).
 *   blobs: has and localPath read the mirror's file (the daemon prefetches every proposal's plan); get falls back to
 *       op `blob.get`.
 *   kv is local (rows/*, members/NAME/*, cursors, notices, link); set/update/delete of a streamed document
 *       (members, presence/*, tasks) is HOST_ONLY.
 * The daemon (lib/remote/link.ts) is the mirror's one writer, through applyLine, applySnapshot, applyDoc and
 * applyBlob. A line whose prev does not hash-chain to the mirror's last line, or
 * whose id does not follow it, is FORK and nothing is written. A snapshot is checked first (lib/room/snapshot.ts
 * problem: PROTOCOL when malformed, FORK for a head that does not hash or pins its entries do not give);
 * the lines after it must chain to its head: a snapshot is never repaired or merged.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { FsRoomStore } from './fs-store.ts';
import { RoomError } from './validate.ts';
import { reasonOf, REVOKED } from '../reasons.ts';
import { blobRef, toPayload } from './rules.ts';
import { decodeEntry, problem } from './snapshot.ts';
import { humanKey } from './trust.ts';
import { createBridge } from '../remote/bridge.ts';
import { proveSeat } from '../remote/host-links.ts';
import { launch, socketPaths, stopReason } from '../remote/link-socket.ts';
import { unknownOutcome, UNKNOWN_OUTCOME } from '../remote/protocol.ts';
import { SEAT_BEAT_MS } from '../config.ts';
import { isAlive, lazy } from '../io.ts';
import * as links from './links.ts';
import type { LockOpts } from '../lock.ts';
import type {
  AppendOpts, BlobsApi, QueuedPost, ChainCheck, ChainVerify, Entry, EntryInput, JoinOutcome, KvApi, Members, MembersApi,
  Payload, Placed, PlaceOpts, Presence, PresenceInput, ReadViewOpts, RoomStore, SeatRecord, SnapshotWire, Tailer, TailerFs, Trust,
} from './types.ts';
import type { KeyObject } from 'node:crypto';
import type { Bridge } from '../remote/bridge.ts';
import type { LinkDoc, RelayOp, RelayParams, RelayResults } from '../remote/types-core.ts';
import { errCode, msgOf } from '../errors.ts';
import type { RoomCode, EntryId } from '../brand.ts';
import type * as OutboxMod from '../remote/outbox.ts';

// the outbox only when an @room post finds the link daemon gone (a mirror's reads never need it)
const outboxMod = lazy<typeof OutboxMod>(import.meta.url, '../remote/outbox.ts');
const DAEMON_GONE = 'the link daemon was not running';
/** A link whose daemon may be started again: not stopped (stopReason null), or stopped with nothing wrong but its
 * last seat gone (NO_SEAT) or a signal; never a fork, a refusal (AUTH, PROTOCOL), a closed room or an ended link. */
const restartable = (why: ReturnType<typeof stopReason>): boolean => !why
  || (why.code === 'OFFLINE' && why.why !== 'ROOM_CLOSED' && !(why.why !== null && REVOKED.has(why.why)));

/** The link daemon's socket as the bridge reaches it (lib/remote/link-socket.ts handle): each relayed op, sent with the
 * socket paths to try, answered as the daemon answers it (RelayResults). */
type RelayApi = { [M in RelayOp]: { params: { socket: string[]; params: RelayParams[M] }; result: RelayResults[M] } };

const HANDLER = path.join(import.meta.dirname, '..', 'remote', 'link-socket.ts');
const streamed = (key: string): boolean => key === 'members' || key === 'tasks' || /^presence\/[^/]+$/.test(key);
const hostOnly = (what: string): RoomError => new RoomError('HOST_ONLY', `${what} runs only on the room's host`);

let bridge: Bridge<RelayApi> | null = null; // one per process, started by its first op

class MirrorRoomStore implements RoomStore {
  readonly code: RoomCode;
  readonly isHost = false;
  /** the mirror's directory as a store of this machine: every read, and the daemon's writes */
  readonly local: FsRoomStore;
  readonly trust: Trust;
  readonly members: MembersApi;
  readonly blobs: BlobsApi;
  readonly kv: KvApi;

  /** code: the room code; dir: the mirror's directory (default <home>/rooms/<code>). */
  constructor(code: RoomCode, { dir }: { dir?: string | undefined } = {}) {
    this.code = code;
    const local = this.local = new FsRoomStore(code, { dir });
    this.trust = local.trust;
    this.members = {
      read: () => local.members.read(),
      update: () => { throw hostOnly('members.update'); },
      join: rec => this._join(rec),
      leave: (name, { reason = 'left', deadlineMs } = {}) => this._call('leave', { name, reason }, { deadlineMs }).ok,
      beat: (name, { presence } = {}) => this._beat(name, presence),
    };
    this.blobs = {
      ...local.blobs,
      put: (name, bytes) => local.blobs.put(this._call('blob.put', { name, bytes: Buffer.from(bytes).toString('base64') }).ref, bytes),
      get: ref => local.blobs.get(ref) ?? this._fetch(ref),
    };
    const only = (what: string, key: string): void => { if (streamed(key)) throw hostOnly(`${what}("${key}")`); };
    this.kv = {
      ...local.kv,
      set: (key, value, opts) => { only('kv.set', key); local.kv.set(key, value, opts); },
      update: (key, fn, opts) => { only('kv.update', key); return local.kv.update(key, fn, opts); },
      delete: key => { only('kv.delete', key); local.kv.delete(key); },
    };
  }

  get dir(): string { return this.local.dir; }
  get logFile(): string { return this.local.logFile; }
  exists(): boolean { return this.local.exists(); }

  // ----- reads: the local store's -----
  readAll(): readonly Readonly<Entry>[] { return this.local.readAll(); }
  readById(ids: EntryId | readonly EntryId[]): readonly Readonly<Entry>[] { return this.local.readById(ids); }
  readAfter(id: number, filter?: (e: Readonly<Entry>) => boolean): readonly Readonly<Entry>[] { return this.local.readAfter(id, filter); }
  lastId(): number { return this.local.lastId(); }
  readView(opts?: ReadViewOpts): readonly Readonly<Entry>[] { return this.local.readView(opts); }
  recentFrom(): number { return this.local.recentFrom(); }
  snapshot(): (SnapshotWire & { held: number }) | null { return this.local.snapshot(); }
  tailer(opts?: { fs?: TailerFs; after?: number }): Tailer { return this.local.tailer(opts); }
  lineHash(id: number): string | null { return this.local.lineHash(id); }
  validateChain(): ChainCheck { return this.local.validateChain(); }
  verifyChain(opts?: { fromOffset?: number; prev?: string }): ChainVerify { return this.local.verifyChain(opts); }
  getCursor(reader: string): number { return this.local.getCursor(reader); }
  setCursor(reader: string, id: number): void { this.local.setCursor(reader, id); }
  pins(): Map<string, KeyObject> { return this.local.pins(); }
  setAside(): string | null { return this.local.setAside(); }
  lock<R>(name: string, fn: () => R, opts?: LockOpts): R { return this.local.lock(name, fn, opts); }

  // ----- writes: the host's -----
  append(entry: EntryInput, opts: AppendOpts & { queue: true }): Placed;
  append(entry: EntryInput, opts?: AppendOpts): Entry;
  // no opts: validate() refuses the missing from
  append(entry: EntryInput, opts: AppendOpts = {} as AppendOpts): Placed { return this.place(toPayload(this.code, entry, opts), opts); }

  /** The host places it: op `append`. opts.queue: the payload may come back with `queued: n` (lib/remote/outbox.ts) and no id. */
  place(payload: Payload, opts: PlaceOpts & { queue: true }): Placed;
  place(payload: Payload, opts?: PlaceOpts): Entry;
  place(payload: Payload, { queue }: PlaceOpts = {}): Placed {
    let r;
    try { r = this._call('append', queue ? { payload, queue: true } : { payload }); } catch (e) {
      const q = queue ? this._queueWhileDown(payload, e) : null;
      if (!q) throw e;
      return q;
    }
    return 'entry' in r ? r.entry : { ...payload, queued: r.queued, ...(r.slow ? { slow: true } : {}) };
  }

  /**
   * An @room post that found no link daemon on this machine (it crashed, was killed, or stopped when its last seat
   * left): _call started the daemon again, detached (no wait: inside the hook's timeout), and the post goes into the
   * outbox here; the daemon sends it once it is online. null (the error stands) for any other error, or a post the
   * outbox does not keep.
   */
  _queueWhileDown(payload: Payload, e: unknown): QueuedPost | null {
    // DAEMON_DOWN from _call: no daemon answered, nothing was sent, and _call started one (the link is not over for good)
    if (errCode(e) !== 'OFFLINE' || reasonOf(e) !== 'DAEMON_DOWN' || unknownOutcome(e) || !outboxMod().queueable(payload)) return null;
    const n = outboxMod().open(this.dir).add(payload); // OFFLINE when the outbox is full
    return { ...payload, queued: n, restarting: true };
  }

  /** The daemon is gone (a kill -9 leaves its records as it last wrote them, "online"): both say offline, not running,
   * with since the last time it was known online, until the daemon started next writes its own. */
  _markGone(doc: LinkDoc | null): void {
    const reason = `${DAEMON_GONE}; restarting it`;
    const rec = links.readState(this.code);
    const lastUp = rec && rec.state === 'online' ? rec.at ?? rec.since : undefined;
    try {
      if (doc && doc.state !== 'fork' && doc.state !== 'stopped') {
        this.local.kv.set('link', { ...doc, state: 'offline', reason, why: 'DAEMON_DOWN', ...(lastUp ? { since: lastUp } : {}) });
      }
      if (rec && rec.state !== 'fork' && rec.state !== 'stopped') {
        links.writeState(this.code, { ...rec, state: 'offline', detail: 'offline', lastError: reason, lastReason: 'DAEMON_DOWN', ...(lastUp ? { since: lastUp } : {}), at: new Date().toISOString() });
      }
    } catch { /* readers judge the dead pid themselves (lib/room/link-state.ts) */ }
  }

  /** An op the daemon relays to the host as it is (link-socket.ts RELAY). */
  request<M extends RelayOp>(op: M, params: RelayParams[M], opts?: { deadlineMs?: number }): RelayApi[M]['result'] { return this._call(op, params, opts); }

  /** The daemon's document `link` (its socket path first: lib/remote/link.ts socketPaths), null when unreadable. */
  _linkDoc(): LinkDoc | null { try { return this.local.kv.get<LinkDoc>('link'); } catch { return null; } }

  /** One op over the bridge to this room's link daemon (the socket it recorded, then the computed paths). */
  _call<M extends RelayOp>(op: M, params: RelayParams[M], { deadlineMs }: { deadlineMs?: number | undefined } = {}): RelayApi[M]['result'] {
    bridge = bridge ?? createBridge<RelayApi>({ handler: HANDLER });
    try {
      return bridge.call(op, { socket: socketPaths(this.dir, this._linkDoc()), params }, { deadlineMs });
    } catch (e) {
      if (errCode(e) !== 'OFFLINE') throw e;
      if (unknownOutcome(e)) { // it went out: never "nothing was sent" (a slow link lands it later)
        throw new RoomError('OFFLINE', `room ${this.code}: no answer from the host in time (a slow link); ${UNKNOWN_OUTCOME}`, 'UNKNOWN_OUTCOME');
      }
      const doc = this._linkDoc();
      const why = stopReason(doc); // the daemon stopped (an invite refused, a fork, the room closed, no seat left)
      // no daemon answers on this machine (killed, crashed, or idle once its last seat left): start it again, unless
      // the link is over for good; never for a leave (a session that ends needs no connection)
      if (reasonOf(e) === 'DAEMON_DOWN' && op !== 'leave' && restartable(why)) {
        if (!isAlive(doc?.pid)) { // one already starting (its pid lives) needs no second
          this._markGone(doc);
          try { launch(this.code); } catch { /* doctor says why it does not start */ }
        }
        throw new RoomError('OFFLINE', `room ${this.code}'s connection was not running; it is starting again; nothing was sent: try again in a moment (/sub-human doctor if it stays down)`, 'DAEMON_DOWN');
      }
      if (why) throw new RoomError(why.code, `the link to room ${this.code} stopped: ${why.reason}; nothing was sent`, why.why);
      throw new RoomError('OFFLINE', `room ${this.code} is offline (${msgOf(e)}); nothing was sent. The connection retries on its own: try again once it is back (/sub-human doctor says why it is down)`, reasonOf(e) || 'NOT_SENT');
    }
  }

  _join({ name, role }: SeatRecord): JoinOutcome {
    const key = humanKey(this.code, name);
    const pubkey = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' }) as string; // pem: a string
    try {
      return this._call('join', { name, role, pubkey, proof: proveSeat(key, { room: this.code, name, pubkey }) });
    } catch (e) {
      if (!(e instanceof RoomError)) throw e;
      return { ok: false, error: e.message, code: e.code };
    }
  }

  _beat(name: string, presence?: PresenceInput): boolean {
    const m = this.members.read()[name];
    if (!m || m.left_at) return false;
    const fresh = Date.parse(String(m.seen_at)) > Date.now() - SEAT_BEAT_MS;
    const cur = presence && this.local.kv.get<Presence>(`presence/${name}`);
    if (fresh && (!presence || (cur && cur.state === presence.state && (cur.detail || null) === (presence.detail || null)))) return true;
    return this._call('beat', { name, presence }).ok;
  }

  _fetch(ref: string): Buffer | null {
    const r = blobRef(ref);
    if (!r) return null;
    const { bytes } = this._call('blob.get', { ref: r });
    return bytes == null ? null : Buffer.from(bytes, 'base64');
  }

  // ----- the daemon's writes -----
  /** One verbatim host line into the mirror log (the daemon's subscribe stream). */
  applyLine(line: string): Entry {
    let v: unknown;
    try { v = JSON.parse(line); } catch { throw new RoomError('PROTOCOL', 'the host sent a log line that is not JSON'); }
    const e = decodeEntry(v);
    const last = this.local.lastId();
    if (!e || !(e.id > last) || (e.prev !== undefined && e.prev !== this.local.lineHash(last))) {
      throw new RoomError('FORK', `the host's line ${e?.id} does not follow this mirror's line ${last}; forget this copy (sub-human link --forget ${this.code}), then join with a new invite`);
    }
    this.local.appendVerbatim(line);
    return e;
  }

  /** The host's snapshot as the start of an empty mirror (the first sync of a link to a host that sent one). */
  applySnapshot(wire: SnapshotWire): void {
    const p = problem(wire);
    if (p) throw new RoomError(p.code, p.code === 'FORK' ? `${p.reason}; forget this copy (sub-human link --forget ${this.code}), then join with a new invite` : p.reason);
    if (this.local.lastId() !== 0) throw new RoomError('PROTOCOL', `the host sent a snapshot to a mirror that holds lines already (room ${this.code})`);
    this.local.installSnapshot(wire);
  }

  /** One streamed document into the mirror (members, presence/NAME, tasks). */
  applyDoc(key: string, value: unknown): Members | null | void {
    if (!streamed(key)) throw new RoomError('PROTOCOL', `the host streamed "${key}", which is not a room document`);
    if (key === 'members') return this.local.members.update(() => (value || {}) as Members); // the host's document, as sent
    if (value === null) return this.local.kv.delete(key);
    return this.local.kv.set(key, value);
  }

  /** The mirror's copy of a plan (the daemon's prefetch). */
  applyBlob(ref: string, bytes: Uint8Array): string { return this.local.blobs.put(ref, bytes); }
}

export { MirrorRoomStore };
