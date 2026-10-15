/**
 * plugin/sub-human/lib/room/fs-store.ts: FsRoomStore, the RoomStore of a room whose directory is on this machine
 * (<home>/rooms/<code>, or {dir}). lib/room/store.ts documents the interface; this is the only module that knows a
 * room's file names (test/store-bypass.node-test.ts) and the only one that imports log-io.ts (the log's bytes).
 *
 *   <room>/log.jsonl        the log's active segment (log-io.ts): log-NNNN.jsonl its sealed segments, snapshot.json
 *                           what they hold in short; log.jsonl.lock the append lock (log-io.ts names these files)
 *   <room>/log.moved        a host_changed was placed here: place() reads the log's host before each line
 *                           (rules.ts checkHere: the old host's log takes no more lines). Without it, an append
 *                           reads only the log's tail.
 *   <room>/members.json     the members document (members.update under members.json.lock)
 *   <room>/<key>.json       the small documents (kv: tasks, presence/NAME, rows/*, members/NAME/*, link, remote/*),
 *                           each updated under <key>.json.lock
 *   <room>/plans/<x>        blobs
 *   <room>/<name>.cursor    per-reader positions
 *   <room>/<name>.lock      lock(name): a room-wide mutex
 *
 * pins() and hostState() come from the log's non-chat entries (log-io.ts nonChat), carried forward one new line at a
 * time: an append does not recompute them, inside the log lock or out. trust is trustOver(this room's keys).
 *
 * For the mirror (lib/room/store-mirror.ts composes one of these over its directory; the link daemon is its one
 * writer): appendVerbatim(line) (a host line as the host stored it), installSnapshot(wire) (a first sync that began
 * from the host's snapshot), reset(keys) (forget the log, its segments and snapshot, the members document and the
 * documents named). rotate() seals the active segment now (tests; an append rotates on its own when due).
 */

import * as roomWatch from './watch.ts';
import type { Change } from './watch.ts';
import nodeFs from 'node:fs';
import path from 'node:path';
import { roomDir, machineIn } from '../home.ts';
import { withLock } from '../lock.ts';
import { writeFileAtomic, writeJsonAtomic, readJson } from '../io.ts';
import { RoomError } from './validate.ts';
import * as envelope from './envelope.ts';
import * as members from './members.ts';
import * as logIo from './log-io.ts';
import * as keys from './keys.ts';
import { trustOver } from './trust.ts';
import { admit, blobRef, checkCursor, checkKey, hostStep, KEY_SEG, BLOB_RE, placeAfter, toPayload } from './rules.ts';
import type { KeyObject } from 'node:crypto';
import type { LockOpts } from '../lock.ts';
import type {
  AppendOpts, BlobsApi, ChainCheck, ChainVerify, Entry, EntryInput, HostState, KvApi, KvUpdateOpts, Members, MembersApi,
  Payload, Placed, PlaceOpts, ReadViewOpts, RoomStore, SnapshotWire, Tailer, TailerFs, Trust, TrustCtx,
} from './types.ts';

const fs = nodeFs;
const MOVED = 'log.moved';
const MEMBERS = 'members.json';

/** pins and host as of `n` marked entries (the last of them `last`): carried forward as the marked list grows. */
interface Derived { n: number; last: Entry | null; pins: Map<string, KeyObject>; host: HostState }
const NONE: Derived = { n: 0, last: null, pins: new Map(), host: { epoch: 0 } };

/** Fold more non-chat entries into pins (first sight pins a name) and host. A new Derived; d is never changed. */
function carry(d: Derived, es: readonly Entry[], from: number): Derived {
  let pins = d.pins, host = d.host;
  for (let i = from; i < es.length; i++) {
    const e = es[i];
    host = hostStep(host, e);
    if (e.kind !== 'member_joined' || e.via !== 'system' || typeof e.from !== 'string' || pins.has(e.from)) continue;
    const key = envelope.parseKey(e.pubkey);
    if (!key) continue;
    if (pins === d.pins) pins = new Map(pins);
    pins.set(e.from, key);
  }
  return { n: es.length, last: es.length ? es[es.length - 1] : null, pins, host };
}

class FsRoomStore implements RoomStore {
  declare code: string;
  declare _dir: string | null;
  declare isHost: boolean;
  declare members: MembersApi;
  declare blobs: BlobsApi;
  declare kv: KvApi;
  declare trust: Trust;
  declare _keys: TrustCtx;
  declare _derived: Derived;

  /** code: the room code; dir: its directory (default <home>/rooms/<code>, read at each call). */
  constructor(code: string, { dir }: { dir?: string } = {}) {
    if (!dir) roomDir(code); // validates the code
    this.code = code;
    this._dir = dir || null;
    this.isHost = true;
    this._derived = NONE;
    this._keys = {
      code,
      pins: () => this.pins(),
      localKey: name => keys.localKey(name, code),
      hasLocalKey: name => keys.hasLocalKey(name, code),
    };
    this.trust = trustOver(this._keys);
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
  /** the active segment (tests write around the store through it) */
  get logFile(): string { return logIo.activeFile(this.dir); }
  get _membersFile(): string { return path.join(this.dir, MEMBERS); }
  exists(): boolean { return fs.existsSync(this.dir); }

  // ----- reading -----
  readAll(): readonly Entry[] { return logIo.readAll(this.dir); }
  readById(ids: number | string | readonly (number | string)[]): Entry[] {
    const want = (Array.isArray(ids) ? ids : [ids]).map(Number);
    const byId = new Map(this.readAll().map(e => [e.id, e]));
    return want.filter(i => byId.has(i)).map(i => byId.get(i)!);
  }
  readAfter(seq: number, filterFn: (e: Entry) => boolean = () => true): Entry[] { return this.readAll().filter(e => e.id > seq && filterFn(e)); }
  lastId(): number { return logIo.lastId(this.dir); }
  readView({ after = 0 }: ReadViewOpts = {}): readonly Entry[] {
    return after > 0 ? logIo.readView(this.dir, { after }) : this.readAll();
  }
  recentFrom(): number { return logIo.recentFrom(this.dir); }
  snapshot(): (SnapshotWire & { held: number }) | null { return logIo.snapshotOf(this.dir); }
  tailer(opts: { fs?: TailerFs; after?: number } = {}): Tailer { return logIo.tailer(this.dir, opts); }
  /** What changes in the room's directory (lib/room/watch.ts): the log, and which documents; null: anything may have. */
  watch(onChange: (change: Change | null) => void): () => void { return roomWatch.watch(this.dir, onChange); }
  lineHash(id: number): string | null { return logIo.lineHash(this.dir, id); }
  validateChain(): ChainCheck { return logIo.validateChain(this.dir); }
  verifyChain(opts: { fromOffset?: number; prev?: string } = {}): ChainVerify { return logIo.verifyChain(this.dir, opts); }
  /** Seal the active segment now (an append does it once the segment is due): false when there is nothing to seal. */
  rotate(): boolean { return fs.existsSync(this.dir) && logIo.rotate(this.dir); }

  /** pins and host, carried forward over the non-chat entries the log gained since the last call. */
  _state(): Derived {
    const { marked, rest } = logIo.nonChat(this.dir);
    let d = this._derived;
    if (d.n > marked.length || (d.n > 0 && marked[d.n - 1] !== d.last)) d = NONE; // rebuilt or rewritten: from the start
    if (d.n < marked.length) d = carry(d, marked, d.n);
    this._derived = d;
    return rest.length ? carry(d, [...marked, ...rest], marked.length) : d;
  }
  /** The keys pinned in the log: envelope.pinnedKeys over the non-chat entries. */
  pins(): Map<string, KeyObject> { return this._state().pins; }
  /** The last host_changed entry's {epoch, host, machine, locator, id}, else {epoch: 0}. */
  hostState(): HostState { return this._state().host; }

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
    const moved = path.join(d, MOVED);
    return logIo.appendLocked(d, tail => {
      const host = p.kind === 'host_changed' || fs.existsSync(moved) ? this.hostState() : undefined;
      const r = placeAfter(p, { keys: this._keys, host, machine: machineIn(this.code), ...tail, now: Date.now() });
      if (r.e.kind === 'host_changed') fs.writeFileSync(moved, '', { mode: 0o600 });
      return r;
    });
  }

  setAside(): string | null {
    const file = path.join(this.dir, `orphaned-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
    if (!logIo.setAside(this.dir, file)) return null;
    for (const f of [this._membersFile, path.join(this.dir, MOVED)]) fs.rmSync(f, { force: true });
    this._derived = NONE;
    return file;
  }

  // ----- the mirror's writes (lib/room/store-mirror.ts) -----
  /** One line as the host stored it, at the end of the log (the mirror checked that it chains). */
  appendVerbatim(line: string): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    logIo.appendVerbatim(this.dir, line);
  }
  /** The host's snapshot as this log's start (the mirror checked it: lib/room/snapshot.ts problem); PROTOCOL when the
   * log holds lines already. */
  installSnapshot(wire: SnapshotWire): void { logIo.install(this.dir, wire); this._derived = NONE; }
  /** Forget everything synced: the log, its segments and snapshot, the members document, and the documents named. */
  reset(docs: readonly string[] = []): void {
    logIo.remove(this.dir);
    fs.rmSync(this._membersFile, { force: true });
    for (const key of docs) fs.rmSync(this._kvFile(key), { force: true });
    this._derived = NONE;
  }

  // ----- cursors -----
  _cursorFile(name: string): string { return path.join(this.dir, `${checkCursor(name)}.cursor`); }
  getCursor(name: string): number { try { return Number(fs.readFileSync(this._cursorFile(name), 'utf8')) || 0; } catch { return 0; } }
  /** Atomic (write + rename), so a concurrent reader never sees an empty file. */
  setCursor(name: string, n: number): void { writeFileAtomic(this._cursorFile(name), String(n)); }

  // ----- members -----
  _readMembers(): Members { try { return readJson(this._membersFile, {}) || {}; } catch { return {}; } }
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

export { FsRoomStore };
