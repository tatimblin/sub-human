/**
 * test/support/memory-store.ts: MemoryRoomStore, a second RoomStore (lib/room/store.ts documents the interface)
 * that keeps a room in this process's memory. Test only. It shares the envelope with FsRoomStore (store.toPayload
 * validates and signs, store.admit and store.placeAfter check and stamp id, at and prev), so ids, the prev chain,
 * signatures and the trust checks are byte-for-byte what the file store does. test/store-contract.node-test.ts runs the same
 * suite against both: that is the seam a store off this machine would implement.
 *
 *   new MemoryRoomStore(code, {isHost}?)   _lines (the serialized log, one string per entry) is open for tamper
 *       tests. isHost: false makes it mirror-shaped (the host gates: lib/room-claude.ts, lib/proposal.ts decide).
 *   members.join/leave/beat are lib/room/members.ts ops over this store's compare-and-set update, as FsRoomStore's.
 */
import * as store from '../../lib/room/store.ts';
import * as config from '../../lib/config.ts';
import * as envelope from '../../lib/room/envelope.ts';
import * as members from '../../lib/room/members.ts';
import type {
  AppendOpts, BlobsApi, ChainCheck, ChainVerify, Entry, EntryInput, HostState, KvApi, Members, MembersApi, Payload, PlaceOpts,
  Placed, ReadViewOpts, RoomStore, Tailer,
} from '../../lib/room/types.ts';
import type { KeyObject } from 'node:crypto';

const { RoomError, hash12, tag, blobRef, checkKey, checkCursor, CHAT_KINDS } = store;
const clone = <T,>(v: T): T => (v === undefined ? v : structuredClone(v));
const parse = (l: string, s: RoomStore | null): Entry | null => { try { return tag(JSON.parse(l) as Entry, s); } catch { return null; } };

class MemoryRoomStore implements RoomStore {
  readonly code: string;
  isHost: boolean;
  /** the serialized log, one line per entry: open for tamper tests */
  _lines: string[] = [];
  _parsed: ({ line: string; e: Entry | null } | undefined)[] = []; // cache, re-parsed when a line changed (tamper tests)
  _cursors = new Map<string, number>();
  _members: { v: number; doc: Members } = { v: 0, doc: {} };
  _blobs = new Map<string, Buffer>();
  _kv = new Map<string, unknown>();
  _checked = { count: 0, hash: hash12('') }; // the verifyChain checkpoint
  members: MembersApi;
  blobs: BlobsApi;
  kv: KvApi;

  constructor(code: string, { isHost = true }: { isHost?: boolean } = {}) {
    this.code = code;
    this.isHost = isHost;
    const self = this;
    const base: Pick<MembersApi, 'read' | 'update'> = {
      read: () => members.fromLegacy(clone(self._members.doc)),
      // compare-and-set: fn sees a copy at version v; the write lands only if nobody wrote since (retry otherwise)
      update(fn) {
        for (;;) {
          const { v, doc } = self._members;
          const next = fn(members.fromLegacy(clone(doc)));
          if (!next) return null;
          if (self._members.v !== v) continue;
          self._members = { v: v + 1, doc: clone(next) };
          return next;
        }
      },
    };
    this.members = { ...base, ...members.ops(this) };
    this.blobs = {
      put(name, bytes) {
        if (blobRef(name) !== name) throw new RoomError('INVALID', `invalid blob name "${name}"`);
        self._blobs.set(name, Buffer.from(bytes));
        return name;
      },
      get: ref => { const r = blobRef(ref); const b = r ? self._blobs.get(r) : undefined; return b ? Buffer.from(b) : null; },
      has: ref => { const r = blobRef(ref); return !!r && self._blobs.has(r); },
      ref: blobRef,
      localPath: () => null,
    };
    this.kv = {
      // kv documents are untyped JSON (KvApi: the caller names T)
      get: <T,>(key: string, fallback: T | null = null): T | null => { checkKey(key); return self._kv.has(key) ? clone(self._kv.get(key) as T) : fallback; },
      set: (key, value) => { checkKey(key); self._kv.set(key, clone(value)); },
      update<T>(key: string, fn: (current: T | null) => T | null | undefined) {
        checkKey(key);
        const next = fn(self._kv.has(key) ? clone(self._kv.get(key) as T) : null);
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
  lock<R>(name: string, fn: () => R): R { checkKey(name); return fn(); }

  readAll(): Entry[] {
    const out: Entry[] = [];
    this._lines.forEach((l, i) => {
      let p = this._parsed[i];
      if (!p || p.line !== l) p = this._parsed[i] = { line: l, e: parse(l, this) };
      if (p.e) out.push(p.e);
    });
    this._parsed.length = this._lines.length;
    return out;
  }
  readById(ids: number | string | readonly (number | string)[]): Entry[] {
    const byId = new Map(this.readAll().map(e => [e.id, e]));
    return (Array.isArray(ids) ? ids : [ids]).map(Number).flatMap(i => byId.get(i) || []);
  }
  readAfter(id: number, f: (e: Entry) => boolean = () => true) { return this.readAll().filter(e => e.id > id && f(e)); }
  since(id: number) { return this.readAfter(id); }
  lastId() { const es = this.readAll(); return es.at(-1)?.id || 0; }

  readView({ after = 0 }: ReadViewOpts = {}): Entry[] {
    const all = this.readAll();
    if (!(after > 0)) return all;
    return all.filter(e => !CHAT_KINDS.has(e.kind) || e.id > after);
  }

  append(entry: EntryInput, opts: AppendOpts & { queue: true }): Placed;
  append(entry: EntryInput, opts?: AppendOpts): Entry;
  append(entry: EntryInput, opts?: AppendOpts): Entry {
    // with no seat named, toPayload refuses (as FsRoomStore's append does): the tests pass from
    return this.place(store.toPayload(this.code, entry, opts as AppendOpts), opts);
  }

  place(payload: Payload, opts: PlaceOpts & { queue: true }): Placed;
  place(payload: Payload, opts?: PlaceOpts): Entry;
  place(payload: Payload, opts: PlaceOpts = {}): Entry {
    const p = store.admit(this.code, payload, opts);
    const { e, line } = store.placeAfter(this, p, { newest: this.readAll().toReversed(), prevLine: this._lines.at(-1) ?? '', now: Date.now() });
    this._lines.push(line);
    return e;
  }

  pins(): Map<string, KeyObject> { return envelope.pinnedKeys(this.readAll()); }
  hostState(): HostState { return store.hostState(this.readAll()); }
  setAside(): string | null { return null; }

  watch(onEntry: (e: Entry) => void, { after = 0, intervalMs = config.FOLLOW_POLL_MS }: { after?: number; intervalMs?: number } = {}) {
    let seen = after, len = 0;
    const tick = () => {
      if (this._lines.length < len) { len = 0; seen = 0; }
      const fresh = this._lines.slice(len);
      len = this._lines.length;
      for (const l of fresh) { const e = parse(l, this); if (e && e.id > seen) { seen = e.id; onEntry(e); } }
    };
    tick();
    const t = setInterval(tick, intervalMs);
    return () => clearInterval(t);
  }

  tailer({ after }: { after?: number } = {}): Tailer {
    const idOf = (l: string) => parse(l, null)?.id ?? 0;
    let at = after === undefined ? this._lines.length : this._lines.findIndex(l => idOf(l) > after);
    if (at < 0) at = this._lines.length;
    const self = this;
    return {
      get offset() { return at; },
      poll() {
        let reset = false;
        if (self._lines.length < at) { at = 0; reset = true; }
        const lines = self._lines.slice(at);
        at = self._lines.length;
        return { entries: lines.flatMap(l => parse(l, self) || []), lines, reset };
      },
    };
  }

  lineHash(id: number): string | null {
    if (id === 0) return hash12('');
    const line = this._lines.find(l => parse(l, null)?.id === id);
    return line === undefined ? null : hash12(line);
  }

  validateChain(): ChainCheck {
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
  verifyChain({ save = true }: { save?: boolean } = {}): ChainVerify {
    const cp = this._checked;
    const ok = cp.count <= this._lines.length && (cp.count === 0 || hash12(this._lines[cp.count - 1]) === cp.hash);
    const from = ok ? cp : { count: 0, hash: hash12('') };
    let { count, hash } = from, id = 0;
    let bad: { badAt: number | null; line?: number } | null = null;
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

  getCursor(name: string) { checkCursor(name); return this._cursors.get(name) || 0; }
  setCursor(name: string, n: number) { checkCursor(name); this._cursors.set(name, Number(n) || 0); }
}

export { MemoryRoomStore };