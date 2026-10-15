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
import path from 'node:path';
import { isMainThread } from 'node:worker_threads';
import { isDeepStrictEqual } from 'node:util';
import * as store from '../../lib/room/store.ts';
import * as config from '../../lib/config.ts';
import { createBridge } from '../../lib/remote/bridge.ts';
import * as envelope from '../../lib/room/envelope.ts';
import { home } from '../../lib/home.ts';


const { FsRoomStore, tag, blobRef } = store;

// ---------- the calling thread ----------
let bridge = null;
const send = (method, params) => (bridge || (bridge = createBridge({ handler: import.meta.filename }))).call(method, params);
const toBuffer = b => (b ? Buffer.from(b.buffer, b.byteOffset, b.byteLength) : null);

class ThreadRoomStore {
  constructor(code, { dir } = {}) {
    this.code = code;
    this.isHost = true;
    this._local = new FsRoomStore(code, { dir }); // this thread's view: the room's directory and its lock files
    const fwd = method => (...args) => this._call(method, args);
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
    for (const m of ['exists', 'lastId', 'lineHash', 'validateChain', 'verifyChain', 'getCursor', 'setCursor']) this[m] = fwd(m);
  }
  get dir() { return this._local.dir; }
  _call(method, args) { return send(method, { code: this.code, dir: this._local.dir, home: home(), args }); }
  _tag(entries) { for (const e of entries) tag(e, this); return entries; }

  readAll() { return this._tag(this._call('readAll', [])); }
  readById(ids) { return this._tag(this._call('readById', [ids])); }
  readAfter(seq, filterFn = () => true) { return this.readAll().filter(e => e.id > seq && filterFn(e)); }
  since(id) { return this.readAfter(id); }
  readView(opts) { return this._tag(this._call('readView', [opts])); }
  append(entry, opts = {}) { return this.place(store.toPayload(this.code, entry, opts), opts); }
  place(payload, opts = {}) { return tag(this._call('place', [payload, { system: opts.system }]), this); }
  pins() { return envelope.pinnedKeys(this.readView({ after: Infinity, save: false })); }
  lock(name, fn, opts) { return this._local.lock(name, fn, opts); }

  watch(onEntry, { after = 0, intervalMs = config.FOLLOW_POLL_MS } = {}) {
    let seen = after;
    const tick = () => { for (const e of this.readAfter(seen)) { seen = e.id; onEntry(e); } };
    tick();
    const t = setInterval(tick, intervalMs);
    return () => clearInterval(t);
  }
  tailer({ after } = {}) {
    const id = this._call('tailer', [{ after }]);
    return { poll: () => { const r = this._call('tailer.poll', [id]); this._tag(r.entries); return r; } };
  }

  _updateMembers(fn) {
    for (;;) {
      const cur = this.members.read();
      const expect = structuredClone(cur);
      const next = fn(cur);
      if (!next) return null;
      if (this._call('members.cas', [expect, next])) return next;
    }
  }
  _kvUpdate(key, fn, opts) {
    for (;;) {
      const cur = this.kv.get(key, null);
      const expect = structuredClone(cur);
      const next = fn(cur);
      if (next === undefined) return undefined;
      if (this._call('kv.cas', [key, expect, next, opts])) return next;
    }
  }
}

function install() {
  const stores = new Map();
  store.setBackend(code => {
    let s = stores.get(code);
    if (!s) { s = new ThreadRoomStore(code); stores.set(code, s); }
    return s;
  });
}

// ---------- the worker ----------
const stores = new Map(); // dir -> FsRoomStore
const tailers = new Map(); // id -> FsRoomStore tailer

const OPS = {
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
  'tailer.poll'(s, [id]) { return tailers.get(id).poll(); },
};

function handle(method, { code, dir, home: h, args }) {
  process.env.SUB_HUMAN_HOME = h;
  let s = stores.get(dir);
  if (!s) { s = new FsRoomStore(code, { dir }); stores.set(dir, s); }
  if (OPS[method]) return OPS[method](s, args);
  const [a, b] = method.split('.');
  return b ? s[a][b](...args) : s[a](...args);
}

if (isMainThread && process.env.SUB_HUMAN_TEST_THREAD_STORE === '1') install();

export { ThreadRoomStore, handle };