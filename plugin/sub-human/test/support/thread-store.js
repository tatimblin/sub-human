'use strict';
/**
 * test/support/thread-store.js: ThreadRoomStore, a RoomStore (lib/room/store.js documents the interface) that
 * forwards its calls through lib/remote/bridge.js to an FsRoomStore on a worker thread. Test only: the proof
 * gate of PR3 in docs/next/REMOTE-PLAN.md (a hook can block on another thread's store and still pass).
 *
 *   new ThreadRoomStore(code)      every process shares one bridge, started on the first call. Each call
 *       carries the room's directory as this thread resolves it (SUB_HUMAN_HOME may change between calls).
 *   handle(method, params)         the bridge handler (this file, loaded on the worker)
 *   Preload: with SUB_HUMAN_TEST_THREAD_STORE=1 and NODE_OPTIONS="--require <this file>", every node process
 *       (the test process and the hooks it spawns) gets store.setBackend(ThreadRoomStore), so every
 *       store.open() goes through the bridge. `npm run test:thread-store` runs test/hooks that way.
 *
 * Not one call each: members.update and kv.update are compare-and-set loops (fn runs here on a copy; the worker
 * writes only if the document is still that copy, else fn runs again), as the store contract allows a store
 * off this machine. lock and kv.lock take the same lock files on this thread: a mutex held across a callback
 * cannot cross. readAfter filters here, watch() polls readAfter() (a reset log is not noticed), and tailer()
 * keeps its reader on the worker (its {fs} test hook is not forwarded).
 * via=human append: store.prepare() takes the seat's key here and the worker signs that one entry with it,
 * because a v1 signature covers id and prev, which only the placing side knows. PR1's envelope.sign + place
 * end this: the calling thread signs and the worker only places.
 */
const path = require('node:path');
const { isMainThread } = require('node:worker_threads');
const { isDeepStrictEqual } = require('node:util');
const store = require(path.join(__dirname, '..', '..', 'lib', 'room', 'store.js'));
const config = require(path.join(__dirname, '..', '..', 'lib', 'config.js'));
const { createBridge } = require(path.join(__dirname, '..', '..', 'lib', 'remote', 'bridge.js'));

const { FsRoomStore, tag, blobRef } = store;

// ---------- the calling thread ----------
let bridge = null;
const send = (method, params) => (bridge || (bridge = createBridge({ handler: __filename }))).call(method, params);
const toBuffer = b => (b ? Buffer.from(b.buffer, b.byteOffset, b.byteLength) : null);

class ThreadRoomStore {
  constructor(code) {
    this.code = code;
    this._local = new FsRoomStore(code); // this thread's view: the room's directory and its lock files
    const fwd = method => (...args) => this._call(method, args);
    this.members = { read: fwd('members.read'), update: fn => this._updateMembers(fn) };
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
    for (const m of ['exists', 'lastId', 'validateChain', 'verifyChain', 'getCursor', 'setCursor']) this[m] = fwd(m);
  }
  get dir() { return this._local.dir; }
  _call(method, args, key = null) { return send(method, { code: this.code, dir: this._local.dir, args, key }); }
  _tag(entries) { for (const e of entries) tag(e, this.code); return entries; }

  readAll() { return this._tag(this._call('readAll', [])); }
  readById(ids) { return this._tag(this._call('readById', [ids])); }
  readAfter(seq, filterFn = () => true) { return this.readAll().filter(e => e.id > seq && filterFn(e)); }
  since(id) { return this.readAfter(id); }
  readView(opts) { return this._tag(this._call('readView', [opts])); }
  append(entry, opts = {}) {
    const { key } = store.prepare(this.code, entry, opts); // this thread's errors, and its signer's key
    return tag(this._call('append', [entry, opts], key), this.code);
  }
  lock(name, fn, opts) { return this._local.lock(name, fn, opts); }

  watch(onEntry, { after = 0, intervalMs = config.FOLLOW_POLL_MS } = {}) {
    let seen = after;
    const tick = () => { for (const e of this.readAfter(seen)) { seen = e.id; onEntry(e); } };
    tick();
    const t = setInterval(tick, intervalMs);
    return () => clearInterval(t);
  }
  tailer() {
    const id = this._call('tailer', []);
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
let callKey = null;

const OPS = {
  append(s, [entry, opts], key) {
    callKey = key;
    try { return s.append(entry, opts); } finally { callKey = null; }
  },
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
  tailer(s) { const id = tailers.size + 1; tailers.set(id, s.tailer()); return id; },
  'tailer.poll'(s, [id]) { return tailers.get(id).poll(); },
};

function handle(method, { code, dir, args, key }) {
  let s = stores.get(dir);
  if (!s) { s = new FsRoomStore(code, { dir }); stores.set(dir, s); }
  if (OPS[method]) return OPS[method](s, args, key);
  const [a, b] = method.split('.');
  return b ? s[a][b](...args) : s[a](...args);
}

if (!isMainThread) globalThis[store.SIGNER] = () => callKey;
else if (process.env.SUB_HUMAN_TEST_THREAD_STORE === '1') install();

module.exports = { ThreadRoomStore, handle };
