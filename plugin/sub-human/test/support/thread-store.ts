/**
 * test/support/thread-store.ts: ThreadRoomStore, a RoomStore (lib/room/store.ts documents the interface) that
 * forwards its calls through lib/remote/bridge.ts to an FsRoomStore on a worker thread. Test only: the bridge's
 * proof gate (a hook can block on another thread's store and still pass).
 *
 *   new ThreadRoomStore(code, {dir}?)   every process shares one bridge, started on the first call. Each call
 *       carries the room's directory and the home as this thread resolves them (SUB_HUMAN_HOME may change
 *       between calls; the worker reads the seat keys of a legacy room under that home).
 *   handle(method, params)         the bridge handler (this file, loaded on the worker)
 *   Preload: with SUB_HUMAN_TEST_THREAD_STORE=1 and NODE_OPTIONS="--import <this file>", every node process
 *       (the test process and the hooks it spawns) gets store.setBackend(ThreadRoomStore), so every
 *       store.open() goes through the bridge. `npm run test:thread-store` runs test/hooks that way.
 *
 * Not one call each: members.update and kv.update are compare-and-set loops (fn runs here on a copy; the worker
 * writes only if the document is still that copy, else fn runs again), as the store contract allows a store
 * off this machine. lock and kv.lock take the same lock files on this thread: a mutex held across a callback
 * cannot cross. readAfter filters here, watch() polls readAfter() (a reset log is not noticed), and tailer()
 * keeps its reader on the worker (its {after} is forwarded, its {fs} test hook is not).
 * append signs here (store.toPayload, with this thread's signer) and the worker only places the payload
 * (store.place), as a remote member's hook and the host do. pins() reads the pinned keys here, from readView.
 */
import { isMainThread } from 'node:worker_threads';
import { isDeepStrictEqual } from 'node:util';
import type { KeyObject } from 'node:crypto';
import * as store from '../../lib/room/store.ts';
import * as config from '../../lib/config.ts';
import { createBridge, type Bridge } from '../../lib/remote/bridge.ts';
import * as envelope from '../../lib/room/envelope.ts';
import { home } from '../../lib/home.ts';
import type { LockOpts } from '../../lib/lock.ts';
import type {
  AppendOpts, BlobsApi, ChainCheck, ChainVerify, Entry, EntryInput, HostState, KvApi, KvUpdateOpts, Members, MembersApi,
  Payload, PlaceOpts, Placed, ReadViewOpts, RoomStore, Tailer,
} from '../../lib/room/types.ts';

const { FsRoomStore, tag, blobRef } = store;
type FsStore = InstanceType<typeof FsRoomStore>;

/** What crosses the bridge per call: the method's args, and where this thread finds the room. */
interface CallParams { code: string; dir: string; home: string; args: unknown[] }

// ---------- the calling thread ----------
let bridge: Bridge | null = null;
// any: the bridge's result, per method (lib/remote/bridge.ts Bridge.call); each caller below names its type
const send = (method: string, params: CallParams) => (bridge || (bridge = createBridge({ handler: import.meta.filename }))).call(method, params);
const toBuffer = (b: Uint8Array | null) => (b ? Buffer.from(b.buffer, b.byteOffset, b.byteLength) : null);

class ThreadRoomStore implements RoomStore {
  readonly code: string;
  isHost = true;
  _local: FsStore;
  members: MembersApi;
  blobs: BlobsApi;
  kv: KvApi;
  exists: () => boolean;
  lastId: () => number;
  lineHash: (id: number) => string | null;
  validateChain: () => ChainCheck;
  verifyChain: (opts?: { fromOffset?: number; prev?: string; save?: boolean }) => ChainVerify;
  getCursor: (reader: string) => number;
  setCursor: (reader: string, id: number) => void;
  hostState: () => HostState;
  setAside: () => string | null;

  constructor(code: string, { dir }: { dir?: string } = {}) {
    this.code = code;
    this._local = new FsRoomStore(code, { dir }); // this thread's view: the room's directory and its lock files
    const fwd = (method: string) => (...args: unknown[]) => this._call(method, args);
    this.members = {
      read: fwd('members.read'),
      update: fn => this._updateMembers(fn),
      join: fwd('members.join'),
      leave: fwd('members.leave'),
      beat: fwd('members.beat'),
    };
    this.blobs = {
      put: fwd('blobs.put'),
      get: ref => toBuffer(this._call('blobs.get', [ref])),
      has: fwd('blobs.has'),
      ref: blobRef,
      localPath: fwd('blobs.localPath'),
    };
    this.kv = {
      get: fwd('kv.get'),
      set: fwd('kv.set'),
      update: (key, fn, opts) => this._kvUpdate(key, fn, opts),
      delete: fwd('kv.delete'),
      list: fwd('kv.list'),
      lock: (key, fn, opts) => this._local.kv.lock(key, fn, opts),
    };
    this.exists = fwd('exists');
    this.lastId = fwd('lastId');
    this.lineHash = fwd('lineHash');
    this.validateChain = fwd('validateChain');
    this.verifyChain = fwd('verifyChain');
    this.getCursor = fwd('getCursor');
    this.setCursor = fwd('setCursor');
    this.hostState = fwd('hostState');
    this.setAside = fwd('setAside');
  }
  get dir() { return this._local.dir; }
  _call(method: string, args: unknown[]) { return send(method, { code: this.code, dir: this._local.dir, home: home(), args }); }
  _tag(entries: Entry[]): Entry[] { for (const e of entries) tag(e, this); return entries; }

  readAll(): Entry[] { return this._tag(this._call('readAll', [])); }
  readById(ids: number | string | readonly (number | string)[]): Entry[] { return this._tag(this._call('readById', [ids])); }
  readAfter(seq: number, filterFn: (e: Entry) => boolean = () => true) { return this.readAll().filter(e => e.id > seq && filterFn(e)); }
  since(id: number) { return this.readAfter(id); }
  readView(opts?: ReadViewOpts): Entry[] { return this._tag(this._call('readView', [opts])); }
  append(entry: EntryInput, opts: AppendOpts & { queue: true }): Placed;
  append(entry: EntryInput, opts?: AppendOpts): Entry;
  append(entry: EntryInput, opts?: AppendOpts): Entry {
    // with no seat named, toPayload refuses (as FsRoomStore's append does)
    return this.place(store.toPayload(this.code, entry, opts as AppendOpts), opts);
  }
  place(payload: Payload, opts: PlaceOpts & { queue: true }): Placed;
  place(payload: Payload, opts?: PlaceOpts): Entry;
  place(payload: Payload, opts: PlaceOpts = {}): Entry { return tag(this._call('place', [payload, { system: opts.system }]), this); }
  pins(): Map<string, KeyObject> { return envelope.pinnedKeys(this.readView({ after: Infinity, save: false })); }
  lock<R>(name: string, fn: () => R, opts?: LockOpts): R { return this._local.lock(name, fn, opts); }

  watch(onEntry: (e: Entry) => void, { after = 0, intervalMs = config.FOLLOW_POLL_MS }: { after?: number; intervalMs?: number } = {}) {
    let seen = after;
    const tick = () => { for (const e of this.readAfter(seen)) { seen = e.id; onEntry(e); } };
    tick();
    const t = setInterval(tick, intervalMs);
    return () => clearInterval(t);
  }
  tailer({ after }: { after?: number } = {}): Tailer {
    const id: number = this._call('tailer', [{ after }]);
    return {
      offset: 0, // the reader's offset lives on the worker
      poll: () => { const r = this._call('tailer.poll', [id]); this._tag(r.entries); return r; },
    };
  }

  _updateMembers(fn: (current: Members) => Members | null | undefined): Members | null {
    for (;;) {
      const cur = this.members.read();
      const expect = structuredClone(cur);
      const next = fn(cur);
      if (!next) return null;
      if (this._call('members.cas', [expect, next])) return next;
    }
  }
  _kvUpdate<T>(key: string, fn: (current: T | null) => T | null | undefined, opts?: KvUpdateOpts): T | null | undefined {
    for (;;) {
      const cur = this.kv.get<T>(key, null);
      const expect = structuredClone(cur);
      const next = fn(cur);
      if (next === undefined) return undefined;
      if (this._call('kv.cas', [key, expect, next, opts])) return next;
    }
  }
}

function install() {
  const stores = new Map<string, ThreadRoomStore>();
  store.setBackend(code => {
    let s = stores.get(code);
    if (!s) { s = new ThreadRoomStore(code); stores.set(code, s); }
    return s;
  });
}

// ---------- the worker ----------
const stores = new Map<string, FsStore>(); // dir -> FsRoomStore
const tailers = new Map<number, Tailer>(); // id -> FsRoomStore tailer

// The worker's own ops; every other method is an FsRoomStore method by name. Args arrive as structured clones.
const OPS: Record<string, (s: FsStore, args: any[]) => unknown> = { // any: each op's own argument list
  'members.cas'(s, [expect, next]) {
    let ok = false;
    s.members.update(cur => ((ok = isDeepStrictEqual(cur, expect)) ? next : null));
    return ok;
  },
  'kv.cas'(s, [key, expect, next, opts]) {
    let ok = false;
    s.kv.update(key, cur => ((ok = isDeepStrictEqual(cur, expect)) ? next : undefined), opts);
    return ok;
  },
  tailer(s, [opts]) { const id = tailers.size + 1; tailers.set(id, s.tailer(opts)); return id; },
  'tailer.poll'(_s, [id]) { return tailers.get(id)?.poll(); },
};

function handle(method: string, { code, dir, home: h, args }: CallParams): unknown {
  process.env.SUB_HUMAN_HOME = h;
  let s = stores.get(dir);
  if (!s) { s = new FsRoomStore(code, { dir }); stores.set(dir, s); }
  if (OPS[method]) return OPS[method](s, args);
  // a method of the store, or of one of its parts (members.join, kv.get, ...), called by name
  type Callable = Record<string, (...a: unknown[]) => unknown>;
  const [a, b] = method.split('.');
  const target = s as unknown as Record<string, Callable & ((...a: unknown[]) => unknown)>;
  return b ? target[a][b](...args) : target[a](...args);
}

if (isMainThread && process.env.SUB_HUMAN_TEST_THREAD_STORE === '1') install();

export { ThreadRoomStore, handle };
