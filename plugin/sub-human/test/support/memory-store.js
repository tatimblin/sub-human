'use strict';
/**
 * test/support/memory-store.js: MemoryRoomStore, a second RoomStore (lib/room/store.js documents the interface)
 * that keeps a room in this process's memory. Test only. It shares the envelope with FsRoomStore (store.prepare
 * validates and finds the signing key, store.buildEntry stamps id, at, prev, room and sig), so ids, the prev
 * chain and signatures are byte-for-byte what the file store writes. test/store-contract.test.js runs the same
 * suite against both: that is the seam a store off this machine would implement.
 *
 *   new MemoryRoomStore(code)   _lines (the serialized log, one string per entry) is open for tamper tests
 */
const path = require('node:path');
const store = require(path.join(__dirname, '..', '..', 'lib', 'room', 'store.js'));
const config = require(path.join(__dirname, '..', '..', 'lib', 'config.js'));

const { RoomError, hash12, tag, blobRef, checkKey, checkCursor, CHAT_KINDS } = store;
const clone = v => (v === undefined ? undefined : structuredClone(v));
const parse = (l, c) => { try { return tag(JSON.parse(l), c); } catch { return null; } };

class MemoryRoomStore {
  constructor(code) {
    this.code = code;
    this._lines = [];
    this._parsed = []; // [{line, e}] cache, re-parsed when a line changed (tamper tests)
    this._cursors = new Map();
    this._members = { v: 0, doc: {} };
    this._blobs = new Map();
    this._kv = new Map();
    this._checked = { count: 0, hash: hash12('') }; // the verifyChain checkpoint
    const self = this;
    this.members = {
      read: () => clone(self._members.doc),
      // compare-and-set: fn sees a copy at version v; the write lands only if nobody wrote since (retry otherwise)
      update(fn) {
        for (;;) {
          const { v, doc } = self._members;
          const next = fn(clone(doc));
          if (!next) return null;
          if (self._members.v !== v) continue;
          self._members = { v: v + 1, doc: clone(next) };
          return next;
        }
      },
    };
    this.blobs = {
      put(name, bytes) {
        if (blobRef(name) !== name) throw new RoomError('INVALID', `invalid blob name "${name}"`);
        self._blobs.set(name, Buffer.from(bytes));
        return name;
      },
      get: ref => { const r = blobRef(ref); return r && self._blobs.has(r) ? Buffer.from(self._blobs.get(r)) : null; },
      has: ref => { const r = blobRef(ref); return !!r && self._blobs.has(r); },
      ref: blobRef,
      localPath: () => null,
    };
    this.kv = {
      get: (key, fallback = null) => { checkKey(key); return self._kv.has(key) ? clone(self._kv.get(key)) : fallback; },
      set: (key, value) => { checkKey(key); self._kv.set(key, clone(value)); },
      update(key, fn) {
        checkKey(key);
        const next = fn(self._kv.has(key) ? clone(self._kv.get(key)) : null);
        if (next === undefined) return undefined;
        if (next === null) { self._kv.delete(key); return null; }
        self._kv.set(key, clone(next));
        return next;
      },
      delete: key => { checkKey(key); self._kv.delete(key); },
      list(prefix) {
        const p = String(prefix || '');
        if (p && !p.endsWith('/')) throw new RoomError('INVALID', `kv.list needs a "dir/" prefix, not "${prefix}"`);
        return [...self._kv.keys()].filter(k => k.startsWith(p) && !k.slice(p.length).includes('/')).sort();
      },
      lock: (key, fn) => { checkKey(key); return fn(); },
    };
  }

  exists() { return true; }
  lock(name, fn) { checkKey(name); return fn(); }

  readAll() {
    const out = [];
    this._lines.forEach((l, i) => {
      let p = this._parsed[i];
      if (!p || p.line !== l) p = this._parsed[i] = { line: l, e: parse(l, this.code) };
      if (p.e) out.push(p.e);
    });
    this._parsed.length = this._lines.length;
    return out;
  }
  readById(ids) {
    const byId = new Map(this.readAll().map(e => [e.id, e]));
    return (Array.isArray(ids) ? ids : [ids]).map(Number).filter(i => byId.has(i)).map(i => byId.get(i));
  }
  readAfter(id, f = () => true) { return this.readAll().filter(e => e.id > id && f(e)); }
  since(id) { return this.readAfter(id); }
  lastId() { const es = this.readAll(); return es.length ? es.at(-1).id || 0 : 0; }

  readView({ after = 0 } = {}) {
    const all = this.readAll();
    if (!(after > 0)) return all;
    return all.filter(e => !CHAT_KINDS.has(e.kind) || e.id > after);
  }

  append(entry, opts = {}) {
    const { v, key } = store.prepare(this.code, entry, opts);
    const now = Date.now();
    const all = this.readAll();
    let recent = 0;
    if (v.via === 'agent') {
      for (let i = all.length - 1; i >= 0; i--) {
        const e = all[i];
        if (now - Date.parse(e.at) >= config.RATE_WINDOW_MS) break;
        if (e.from === opts.from && e.via === 'agent' && ++recent >= config.RATE_MAX) break;
      }
    }
    const last = all.length ? all.at(-1).id || 0 : 0;
    const { e, line } = store.buildEntry(v, opts, { c: this.code, key, last, prevLine: this._lines.at(-1) || null, recent, now });
    this._lines.push(line);
    return e;
  }

  watch(onEntry, { after = 0, intervalMs = config.FOLLOW_POLL_MS } = {}) {
    let seen = after, len = 0;
    const tick = () => {
      if (this._lines.length < len) { len = 0; seen = 0; }
      const fresh = this._lines.slice(len);
      len = this._lines.length;
      for (const l of fresh) { const e = parse(l, this.code); if (e && e.id > seen) { seen = e.id; onEntry(e); } }
    };
    tick();
    const t = setInterval(tick, intervalMs);
    return () => clearInterval(t);
  }

  tailer() {
    let at = this._lines.length;
    const self = this;
    return {
      poll() {
        let reset = false;
        if (self._lines.length < at) { at = 0; reset = true; }
        const entries = self._lines.slice(at).map(l => parse(l, self.code)).filter(Boolean);
        at = self._lines.length;
        return { entries, reset };
      },
    };
  }

  validateChain() {
    let prev = '';
    for (let i = 0; i < this._lines.length; i++) {
      const e = parse(this._lines[i], null);
      if (!e) return { ok: false, badAt: null, line: i + 1, count: this._lines.length };
      if (e.prev !== undefined && e.prev !== hash12(prev)) return { ok: false, badAt: e.id, count: this._lines.length };
      prev = this._lines[i];
    }
    return { ok: true, count: this._lines.length };
  }

  /** Incremental from the checkpoint (lines already checked); offsets here count lines. */
  verifyChain({ save = true } = {}) {
    const cp = this._checked;
    const ok = cp.count <= this._lines.length && (cp.count === 0 || hash12(this._lines[cp.count - 1]) === cp.hash);
    const from = ok ? cp : { count: 0, hash: hash12('') };
    let { count, hash } = from, bad = null, id = 0;
    for (let i = from.count; i < this._lines.length; i++) {
      const e = parse(this._lines[i], null);
      if (!e) { bad = { badAt: null, line: i + 1 }; break; }
      if (e.prev !== undefined && e.prev !== hash) { bad = { badAt: e.id }; break; }
      hash = hash12(this._lines[i]); count++; id = e.id || id;
    }
    if (save) this._checked = { count, hash };
    const r = { ok: !bad, count, checked: count - from.count, offset: count, id, hash, from: from.count };
    return bad ? { ...r, ...bad } : r;
  }

  getCursor(name) { checkCursor(name); return this._cursors.get(name) || 0; }
  setCursor(name, n) { checkCursor(name); this._cursors.set(name, Number(n) || 0); }
}

module.exports = { MemoryRoomStore };
