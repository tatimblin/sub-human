/**
 * plugin/sub-human/lib/room/store-mirror.ts: MirrorRoomStore, the RoomStore of a room hosted on another machine:
 * it composes an FsRoomStore over a directory the link daemon (lib/remote/link.ts) keeps line for line the host's
 * log, so every reader (readView, the snapshot, tailer, verifyChain, rows, digests) is that store's, unchanged. Only writes cross the
 * wire, as named ops through lib/remote/bridge.ts (a sync call from the hook's thread, with a deadline) to the
 * daemon's socket. The bridge (a worker thread) starts at the process's first op, so a hook that only reads
 * starts none. store.open(code) returns one for a code that lib/room/links.ts knows.
 *
 * Reads: the local FsRoomStore's, over the mirror directory (trust too: the keys the mirrored log pins).
 * Writes (RoomError codes in lib/remote/protocol.ts CODES; OFFLINE: the daemon or the host is unreachable, and
 * nothing was sent or queued but an @room post (append, opts.queue); a daemon that stopped for good gives its own
 * reason and code, from its document `link`, e.g. AUTH for a refused invite; a deadline that passed after the op
 * went out is OFFLINE with unknown: true (protocol.unknownOutcome): it may still land, and retrying is safe):
 *   append(entry, opts) = place(toPayload(...))   signed here (the hook's signer, via=human), placed by the host:
 *                            op `append`. The placed entry is returned once the mirror holds it (the host streams
 *                            a write's lines before its reply: read-your-writes). A via=system payload is refused
 *                            by the host (AUTH): the host writes the room's own entries. opts.queue (hooks/handlers/at-room.ts
 *                            only): with the link down the daemon queues an @room post instead of refusing it
 *                            (lib/remote/outbox.ts); the signed payload is returned with queued: n and no id. Online, a post the host
 *                            has not answered in time comes back queued: n, slow: true (in flight, kept under
 *                            its nonce: the late copy is the post).
 *   members.join(rec)        op `join` with the seat's public key and a proof (lib/remote/host-links.ts proveSeat), both
 *                            from the hook's signer; the host logs member_joined. Any RoomError comes back as
 *                            {ok: false, error, code}
 *   members.leave(name, {reason, deadlineMs}?)   op `leave`; the host logs "NAME left (reason)"
 *   members.beat(name, {presence?})   op `beat`, skipped (true) while the lease is younger than SEAT_BEAT_MS and
 *                            presence is unchanged
 *   members.update(fn)       HOST_ONLY (room Claude bookkeeping never runs here)
 *   blobs.put(name, bytes)   op `blob.put`, then the mirror's copy; blobs.get(ref): the mirror's file, else op
 *                            `blob.get`; has, localPath: the mirror's file (the daemon prefetches every proposal's plan)
 *   kv.*                     local (rows/*, members/NAME/*, cursors, notices, link: session-local documents);
 *                            set/update/delete of a streamed document (members, presence/*, tasks) is HOST_ONLY
 *   request(op, params, {deadlineMs}?)   any other op the daemon relays (lib/remote/link.ts RELAY): the planned
 *                            handoff's handoff.accept and handoff.refuse (lib/handoff.ts)
 *   isHost = false
 * The daemon's writes (lib/remote/link.ts only; it is the mirror's one writer):
 *   applyLine(line)          append one host line verbatim; its prev must hash-chain to the mirror's last line
 *                            and its id follow it, else RoomError FORK and nothing is written
 *   applySnapshot(wire)      a first sync that begins from the host's snapshot (the subscribe stream's 'snapshot'
 *                            event, lib/remote/server.ts): checked first (lib/room/snapshot.ts problem: PROTOCOL for a
 *                            malformed one, FORK for a head that does not hash or pins and host its entries do not
 *                            give), then the mirror's log starts from it. The lines that follow must chain to its
 *                            head (applyLine), else FORK: a snapshot is never repaired or merged
 *   applyDoc(key, value)     write a streamed document (members, presence/NAME, tasks) as the host sent it
 *                            (value null: the document is gone)
 *   applyBlob(ref, bytes)    the mirror's copy of a plan
 *   reset()                  forget everything synced (the log, its checkpoint, the streamed documents), for
 *                            `sub-human link --reset CODE`; session-local documents and plans stay
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { FsRoomStore } from './fs-store.ts';
import { RoomError } from './validate.ts';
import { reasonOf } from '../reasons.ts';
import { blobRef, toPayload } from './rules.ts';
import { decodeEntry, problem } from './snapshot.ts';
import { humanKey } from './trust.ts';
import { createBridge } from '../remote/bridge.ts';
import { proveSeat } from '../remote/host-links.ts';
import { socketPaths, stopReason } from '../remote/link-socket.ts';
import { unknownOutcome, UNKNOWN_OUTCOME } from '../remote/protocol.ts';
import { SEAT_BEAT_MS } from '../config.ts';
import type { LockOpts } from '../lock.ts';
import type {
  AppendOpts, BlobsApi, ChainCheck, ChainVerify, Entry, EntryInput, HostState, JoinResult, KvApi, Members, MembersApi,
  Payload, Placed, PlaceOpts, PresenceInput, ReadViewOpts, RoomStore, SeatRecord, SnapshotWire, Tailer, TailerFs, Trust,
} from './types.ts';
import type { KeyObject } from 'node:crypto';
import type { Bridge } from '../remote/bridge.ts';
import type { LinkDoc, RelayOp, RelayParams, RelayResults } from '../remote/types-core.ts';
import { errCode, msgOf } from '../errors.ts';

/** The link daemon's socket as the bridge reaches it (lib/remote/link-socket.ts handle): each relayed op, sent with the
 * socket paths to try, answered as the daemon answers it (RelayResults). */
type RelayApi = { [M in RelayOp]: { params: { socket: string[]; params: RelayParams[M] }; result: RelayResults[M] } };

const HANDLER = path.join(import.meta.dirname, '..', 'remote', 'link-socket.ts');
const streamed = (key: string): boolean => key === 'members' || key === 'tasks' || /^presence\/[^/]+$/.test(key);
const hostOnly = (what: string): RoomError => new RoomError('HOST_ONLY', `${what} runs only on the room's host`);

let bridge: Bridge<RelayApi> | null = null; // one per process, started by its first op

class MirrorRoomStore implements RoomStore {
  readonly code: string;
  isHost = false;
  /** the mirror's directory as a store of this machine: every read, and the daemon's writes */
  readonly local: FsRoomStore;
  readonly trust: Trust;
  members: MembersApi;
  blobs: BlobsApi;
  kv: KvApi;

  /** code: the room code; dir: the mirror's directory (default <home>/rooms/<code>). */
  constructor(code: string, { dir }: { dir?: string } = {}) {
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
      get: ref => local.blobs.get(ref) || this._fetch(ref),
    };
    // F keeps each kv call's own signature (kv.update is generic)
    const only = <F extends (key: string, ...a: any[]) => unknown>(what: string, fn: F): F =>
      ((key: string, ...a: unknown[]) => { if (streamed(key)) throw hostOnly(`${what}("${key}")`); return fn(key, ...a); }) as F;
    this.kv = { ...local.kv, set: only('kv.set', local.kv.set), update: only('kv.update', local.kv.update), delete: only('kv.delete', local.kv.delete) };
  }

  get dir(): string { return this.local.dir; }
  get logFile(): string { return this.local.logFile; }
  exists(): boolean { return this.local.exists(); }

  // ----- reads: the local store's -----
  readAll(): readonly Entry[] { return this.local.readAll(); }
  readById(ids: number | string | readonly (number | string)[]): Entry[] { return this.local.readById(ids); }
  readAfter(id: number, filter?: (e: Entry) => boolean): Entry[] { return this.local.readAfter(id, filter); }
  lastId(): number { return this.local.lastId(); }
  readView(opts?: ReadViewOpts): readonly Entry[] { return this.local.readView(opts); }
  recentFrom(): number { return this.local.recentFrom(); }
  snapshot(): (SnapshotWire & { held: number }) | null { return this.local.snapshot(); }
  tailer(opts?: { fs?: TailerFs; after?: number }): Tailer { return this.local.tailer(opts); }
  lineHash(id: number): string | null { return this.local.lineHash(id); }
  validateChain(): ChainCheck { return this.local.validateChain(); }
  verifyChain(opts?: { fromOffset?: number; prev?: string }): ChainVerify { return this.local.verifyChain(opts); }
  getCursor(reader: string): number { return this.local.getCursor(reader); }
  setCursor(reader: string, id: number): void { this.local.setCursor(reader, id); }
  pins(): Map<string, KeyObject> { return this.local.pins(); }
  hostState(): HostState { return this.local.hostState(); }
  setAside(): string | null { return this.local.setAside(); }
  lock<R>(name: string, fn: () => R, opts?: LockOpts): R { return this.local.lock(name, fn, opts); }

  // ----- writes: the host's -----
  append(entry: EntryInput, opts: AppendOpts & { queue: true }): Placed;
  append(entry: EntryInput, opts?: AppendOpts): Entry;
  // no opts: validate() refuses the missing from
  append(entry: EntryInput, opts: AppendOpts = {} as AppendOpts): Placed { return this.place(toPayload(this.code, entry, opts), opts); }

  /** The host places it: op `append`. opts.queue (an @room post): while the link is down the daemon may queue it
   * (lib/remote/outbox.ts); the payload comes back with `queued: n` (the posts waiting) and no id. */
  place(payload: Payload, opts: PlaceOpts & { queue: true }): Placed;
  place(payload: Payload, opts?: PlaceOpts): Entry;
  place(payload: Payload, { queue }: PlaceOpts = {}): Placed {
    const r = this._call('append', queue ? { payload, queue: true } : { payload });
    return 'entry' in r ? r.entry : { ...payload, queued: r.queued, ...(r.slow ? { slow: true } : {}) };
  }

  /** An op the daemon relays to the host as it is (lib/handoff.ts: handoff.accept, handoff.refuse). */
  request<M extends RelayOp>(op: M, params: RelayParams[M], opts?: { deadlineMs?: number }): RelayApi[M]['result'] { return this._call(op, params, opts); }

  /** The daemon's document `link` (its socket path first: lib/remote/link.ts socketPaths), null when unreadable. */
  _linkDoc(): LinkDoc | null { try { return this.local.kv.get<LinkDoc>('link'); } catch { return null; } }

  /** One op over the bridge to this room's link daemon (the socket it recorded, then the computed paths). */
  _call<M extends RelayOp>(op: M, params: RelayParams[M], { deadlineMs }: { deadlineMs?: number } = {}): RelayApi[M]['result'] {
    bridge = bridge || createBridge<RelayApi>({ handler: HANDLER });
    try {
      return bridge.call(op, { socket: socketPaths(this.dir, this._linkDoc()), params }, { deadlineMs });
    } catch (e) {
      if (errCode(e) !== 'OFFLINE') throw e;
      if (unknownOutcome(e)) { // it went out: never "nothing was sent" (a slow link lands it later)
        throw new RoomError('OFFLINE', `room ${this.code}: no answer from the host in time (a slow link); ${UNKNOWN_OUTCOME}`, 'UNKNOWN_OUTCOME');
      }
      const why = stopReason(this.local.kv.get('link')); // the daemon stopped for good (an invite refused, a fork): say why
      if (why) throw new RoomError(why.code, `the link to room ${this.code} stopped: ${why.reason}; nothing was sent`, why.why);
      throw new RoomError('OFFLINE', `room ${this.code} is offline (${msgOf(e)}); nothing was sent`, reasonOf(e) || 'NOT_SENT');
    }
  }

  _join({ name, role, log_v }: SeatRecord): JoinResult {
    const key = humanKey(this.code, name);
    const pubkey = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' }) as string; // pem: a string
    try {
      return this._call('join', { name, role, pubkey, proof: proveSeat(key, { room: this.code, name, pubkey }), ...(log_v ? { log_v } : {}) });
    } catch (e) {
      if (!(e instanceof RoomError)) throw e;
      return { ok: false, error: e.message, code: e.code };
    }
  }

  _beat(name: string, presence?: PresenceInput): boolean {
    const m = this.members.read()[name];
    if (!m || m.left_at) return false;
    const fresh = Date.parse(String(m.seen_at)) > Date.now() - SEAT_BEAT_MS;
    const cur = presence && this.local.kv.get(`presence/${name}`);
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
      throw new RoomError('FORK', `the host's line ${e?.id} does not follow this mirror's line ${last}; re-mirror with sub-human link --reset ${this.code}`);
    }
    this.local.appendVerbatim(line);
    return e;
  }

  /** The host's snapshot as the start of an empty mirror (the first sync of a link to a host that sent one). */
  applySnapshot(wire: SnapshotWire): void {
    const p = problem(wire);
    if (p) throw new RoomError(p.code, p.code === 'FORK' ? `${p.reason}; re-mirror with sub-human link --reset ${this.code}` : p.reason);
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

  /** Forget everything synced (the log, its checkpoint, the streamed documents); session-local documents and plans stay. */
  reset(): void { this.local.reset(['tasks', ...this.local.kv.list('presence/')]); }
}

export { MirrorRoomStore };
