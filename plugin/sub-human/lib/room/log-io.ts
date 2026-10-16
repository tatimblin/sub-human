/**
 * plugin/sub-human/lib/room/log-io.ts: the bytes of a room log, in segments (log.jsonl, log-NNNN.jsonl) and its snapshot.
 * Only lib/room/fs-store.ts imports this file (test/store-bypass.node-test.ts checks it): every other module reads a
 * log through a RoomStore. One JSON entry per line, appended under <room>/log.jsonl.lock; nothing here knows what an
 * entry means beyond its id, its prev (the chain), its at and whether its kind is a chat kind (rules.ts CHAT_KINDS).
 * Every call takes the room's directory.
 *
 * The files (<room>/):
 *   log.jsonl         the active segment: every append goes here. A room from before segments has only this file,
 *                     and reads as it always did; it rotates like any other once it passes the size.
 *   log-NNNN.jsonl    a sealed segment (0001, 0002, ...), never written again. Rotation: once an append leaves
 *                     log.jsonl at env.segmentMaxBytes() or more (1 MiB), and only when every line of it chains,
 *                     log.jsonl is linked as the next log-NNNN.jsonl, snapshot.json is written, and log.jsonl is
 *                     replaced by a file holding only the sealed segment's last line: a segment's first line repeats
 *                     the previous segment's last (the carry line), so the chain runs on across files, an older
 *                     plugin's appender still finds the right id and prev, and every reader skips that repeat.
 *   snapshot.json     the sealed lines in short (lib/room/snapshot.ts: chain head, non-chat entries, the window of
 *                     recent lines a placement needs, pins, host) plus where they are kept (seg, segs, held, base).
 *                     A mirror that began from its host's snapshot (install) holds no line before it: held > 1.
 *   snapshot-base.json the snapshot a mirror began from (install), as installed and never written again: a lost
 *                     snapshot.json is rebuilt from it and the sealed segments, so the host's entries before the mirror's
 *                     first line (its proposals, keys, host) survive. The first segment such a mirror seals starts at
 *                     that snapshot's line (its carry), so the anchor's hash is still found after a rotation.
 * Sealed segments are kept: an older peer's first sync replays the whole log, and readAll() still gives every line.
 * A crash between the steps of a rotation is finished by the next append (settle).
 *
 * Reading:
 *   readAll(dir) -> readonly Readonly<Entry>[]   every entry this machine holds, in order: the snapshot's non-chat entries
 *       before `held` (a mirror that began from a snapshot), the sealed segments, the active segment (carry lines
 *       skipped). Cached: sealed segments are parsed once; the active one as before (a repeat call re-reads nothing
 *       when unchanged and parses only the appended bytes when it grew; a shrink, a new inode, a same-size rewrite or
 *       a changed tail drops that cache). Frozen; a grown log gives a new array. A last line with no newline yet is
 *       parsed, never cached.
 *   readView(dir, {after})   every non-chat entry and every entry with id > after, in log order: the snapshot's
 *       entries, then the active segment through this process's in-memory checkpoint (only its new lines are
 *       parsed). An `after` before the snapshot reads the sealed segments too.
 *   nonChat(dir) -> {marked, rest}   the non-chat entries: the snapshot's and the active segment's verified prefix
 *       (`marked`: the same objects, in a prefix-stable array while the snapshot stands) and after it (past a chain
 *       break, or a line without its newline). What the store derives its pinned keys and host from.
 *   recentFrom(dir) -> id    the snapshot's id (0: none): readView({after: it}) parses only the active segment
 *   snapshotOf(dir) -> SnapshotWire & {held} | null
 *   lastId(dir), lineHash(dir, id) -> hash12 of the stored line (id 0: hash12(''); null: no such line here)
 *   tailer(dir, {fs, after}?)   entries appended after the moment it was made (after: an id, from the first line after
 *       it instead), parsed and verbatim, across segments; a rotation is followed (the rest of the old file, then the
 *       new one, carry skipped); reset: the log was replaced or shrank and reading began again
 *   validateChain(dir)       the whole prev chain over every segment this machine holds (a carry line must repeat
 *       the line before it)
 *   verifyChain(dir, {fromOffset, prev}?)   incremental over the active segment from this process's own checkpoint
 *       (in memory; the snapshot vouches for the sealed lines: a segment is sealed only once it chains)
 * Writing:
 *   appendLocked(dir, place) -> Entry   under the log lock: read only the log's tail (newest first, then
 *       the snapshot's window), place({newest, prevLine}) -> {e, line}, write the line, then rotate when due
 *   appendVerbatim(dir, line)   a line as another machine stored it (the mirror's one writer); rotates too
 *   rotate(dir) -> bool                 seal the active segment now (false: nothing to seal, or it does not chain)
 *   install(dir, wire)                  a mirror's start from its host's snapshot: snapshot.json and a log.jsonl
 *                                       holding only the snapshot's line (RoomError PROTOCOL when a log is there)
 *   setAside(dir, to) -> bool           every line held moved to file `to`, one log again (a demoted host's)
 *   remove(dir)                         every log file gone (a mirror's reset)
 *   forget(dir)                         drop this process's caches of the room's log
 */

import nodeFs from 'node:fs';
import path from 'node:path';
import { withLock } from '../lock.ts';
import { writeFileAtomic, writeJsonAtomic, readJsonRaw } from '../io.ts';
import { hash12 } from '../text.ts';
import { SNAPSHOT_WINDOW_MAX } from '../config.ts';
import { segmentMaxBytes } from '../env.ts';
import { RoomError } from './validate.ts';
import { CHAT_KINDS } from './rules.ts';
import * as snapshot from './snapshot.ts';
import { isObj } from '../decode.ts';
import { errCode } from '../errors.ts';
import type { ChainCheck, ChainVerify, Entry, LogSnapshot, SnapshotWire, Tailer, TailerFs, WindowItem } from './types.ts';

const fs = nodeFs;
const ACTIVE = 'log.jsonl';
const SNAP = 'snapshot.json';
const SEG_RE = /^log-(\d{4,})\.jsonl$/;
const activeFile = (dir: string): string => path.join(dir, ACTIVE);
const snapFile = (dir: string): string => path.join(dir, SNAP);
const BASE = 'snapshot-base.json';
const baseFile = (dir: string): string => path.join(dir, BASE);
/** The snapshot an installed mirror began from (install), or null. */
function loadBase(dir: string): LogSnapshot | null {
  const x = readJsonRaw(baseFile(dir));
  return validSnap(x) && x.seg === 0 ? x : null;
}
/** A snapshot to rebuild: sealed segments, or the base an installed mirror began from. */
const rebuildable = (dir: string): boolean => fs.existsSync(segFile(dir, 1)) || fs.existsSync(baseFile(dir));
const segFile = (dir: string, n: number): string => path.join(dir, `log-${String(n).padStart(4, '0')}.jsonl`);

/** The active segment's checked prefix: its first `offset` bytes chain; marks: its non-chat lines [id, offset, length]. */
interface Checkpoint {
  offset: number;
  /** the last id checked (the snapshot's at offset 0: the carry line to come repeats it) */
  id: number;
  /** hash12 of the line that ends at offset (the next line's prev) */
  hash: string;
  /** lines of the whole log up to offset (the snapshot's count first) */
  count: number;
  /** the first id after the snapshot (0: none yet) */
  first: number;
  marks: [number, number, number][];
}
/** One line of a file, found by lineAt: its byte range and id (null for a line without one). */
interface LineSpan { start: number; end: number; id: number | null }
/** Where a chain check broke: an id whose prev does not chain, or a corrupt line (badAt null, line 1-based). */
interface ChainBreak { badAt: number | null; line?: number }
/** readActive's cache of the active segment. */
interface ReadCache { dev: number; ino: number; size: number; mtimeMs: number; offset: number; tail: Buffer; entries: readonly Readonly<Entry>[]; all: readonly Readonly<Entry>[] }
/** This process's view of a room's active segment: its checkpoint and the parsed entries of its marks (same order). */
interface ViewState { dev: number; ino: number; snap: LogSnapshot | null; cp: Checkpoint; marked: readonly Readonly<Entry>[] | null; checked: string; joined: readonly Readonly<Entry>[] | null }
/** verifyChain's own checkpoint (no marks). */
interface Verified { dev: number; ino: number; snap: LogSnapshot | null; cp: Checkpoint }

const TAIL_CHUNK = 64 * 1024;
const TAIL_CHECK = 64;              // bytes before the cached end compared on growth
const EMPTY: readonly Readonly<Entry>[] = Object.freeze([]);

const readCache = new Map<string, ReadCache>();   // active file -> its readAll cache
const views = new Map<string, ViewState>();       // dir -> readView's view
const verified = new Map<string, Verified>();     // dir -> verifyChain's checkpoint
const snaps = new Map<string, { key: string; snap: LogSnapshot | null }>(); // dir -> snapshot.json as last read
const segCache = new Map<string, { key: string; entries: readonly Readonly<Entry>[] }>(); // sealed file -> its entries
const prefixes = new Map<string, { snap: LogSnapshot; entries: readonly Readonly<Entry>[] }>(); // dir -> what readAll holds before the active segment
const alls = new Map<string, { prefix: readonly Readonly<Entry>[]; act: readonly Readonly<Entry>[]; all: readonly Readonly<Entry>[] }>();

function parseLines(text: string): Entry[] {
  const out: Entry[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { const e = snapshot.asEntry(JSON.parse(line)); if (e) out.push(e); } catch { /* torn or corrupt line: skip */ }
  }
  return out;
}
const parse = (buf: Buffer | string): Entry | null => { try { return snapshot.asEntry(JSON.parse(buf.toString())); } catch { return null; } };
const statKey = (f: string): string => { try { const st = fs.statSync(f); return `${st.ino}:${st.size}:${st.mtimeMs}`; } catch { return ''; } };

/** Open file for reading, or null when it does not exist. */
function openRead(file: string): number | null {
  try { return fs.openSync(file, 'r'); } catch (e) { if (errCode(e) === 'ENOENT') return null; throw e; }
}

// ---------- the snapshot ----------
const isInt = (n: unknown, min = 0): n is number => Number.isInteger(n) && (n as number) >= min;
function validSnap(x: unknown): x is LogSnapshot {
  const s = x as LogSnapshot | null;
  return !!s && s.v === 1 && isInt(s.seg) && Array.isArray(s.segs) && isInt(s.held, 1) && isInt(s.base) && isInt(s.id, 1)
    && typeof s.hash === 'string' && typeof s.line === 'string' && isInt(s.count, 1) && Array.isArray(s.entries)
    && Array.isArray(s.window) && !!s.pins && typeof s.pins === 'object' && !!s.host && typeof s.host === 'object';
}
/** snapshot.json as last written (parsed once per change on disk); null when absent or not a snapshot. */
function loadSnap(dir: string): LogSnapshot | null {
  const key = statKey(snapFile(dir));
  const hit = snaps.get(dir);
  if (hit && hit.key === key) return hit.snap;
  const x = key ? readJsonRaw(snapFile(dir)) : null;
  const snap = validSnap(x) ? x : null;
  snaps.set(dir, { key, snap });
  return snap;
}
/** The sealed segments on disk, by number (a snapshot that went missing is rebuilt from them). */
function sealedOnDisk(dir: string): number[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const segs: number[] = [];
  for (const n of names) { const [, seg] = SEG_RE.exec(n) ?? []; if (seg !== undefined) segs.push(Number(seg)); }
  return segs.sort((a, b) => a - b);
}
/** The snapshot; one that is missing or unreadable while sealed segments exist is rebuilt from them (under the lock). */
function snapOf(dir: string): LogSnapshot | null {
  const snap = loadSnap(dir);
  if (snap || !rebuildable(dir)) return snap;
  return withLock(activeFile(dir) + '.lock', () => loadSnap(dir) ?? rebuild(dir), { ErrorClass: LockError });
}

// ---------- line helpers ----------
/** The file's non-empty lines read backwards from byte `end` (newest first), as strings. Reads TAIL_CHUNK at a time. */
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

function atBoundary(fd: number, off: number): boolean {
  if (off === 0) return true;
  const b = Buffer.alloc(1);
  fs.readSync(fd, b, 0, 1, off - 1);
  return b[0] === 10;
}
/** The last non-empty line before byte off (as linesBackward's first), read backwards 4 KiB at a time. */
function lineBefore(fd: number, off: number): string {
  let pos = off, carry = Buffer.alloc(0), started = false;
  while (pos > 0) {
    const n = Math.min(4096, pos);
    pos -= n;
    let b = Buffer.allocUnsafe(n);
    fs.readSync(fd, b, 0, n, pos);
    if (!started) { // skip the newlines that end the region
      let e = b.length;
      while (e > 0 && b[e - 1] === 10) e--;
      if (!e) continue;
      b = b.subarray(0, e);
      started = true;
    }
    const nl = b.lastIndexOf(10);
    if (nl >= 0) return Buffer.concat([b.subarray(nl + 1), carry]).toString('utf8');
    carry = Buffer.concat([b, carry]);
  }
  return carry.toString('utf8');
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

const hasId = (L: LineSpan | null): L is LineSpan & { id: number } => L !== null && L.id !== null;
/** Byte offset of the first line in [0, end) whose id is > after (ids rise through a file), or end. */
function offsetAfter(fd: number, end: number, after: number): number {
  let lo = 0, hi = end;
  const idAt = (pos: number): (LineSpan & { id: number }) | null => { let L = lineAt(fd, pos, end); while (L && L.id === null) L = lineAt(fd, L.end, end); return hasId(L) ? L : null; };
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const L = idAt(mid);
    if (!L || L.id > after) hi = mid; else lo = mid + 1;
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
/** The byte offset of the first complete line of file whose id is > after (the end of its complete lines when none is). */
function offsetAfterId(file: string, after: number): number {
  const end = endOffset(fs, file);
  if (!end) return 0;
  const fd = fs.openSync(file, 'r');
  try { return offsetAfter(fd, end, after); } finally { fs.closeSync(fd); }
}

// ---------- readAll ----------
/** Every parseable entry of the active segment (carry line included), cached as described above. */
function readActive(file: string): readonly Readonly<Entry>[] {
  const fd = openRead(file);
  if (fd === null) { readCache.delete(file); return EMPTY; }
  try {
    const st = fs.fstatSync(fd);
    let c: ReadCache | null | undefined = readCache.get(file);
    if (c && (c.dev !== st.dev || c.ino !== st.ino || st.size < c.size || (st.size === c.size && st.mtimeMs !== c.mtimeMs))) c = null;
    if (c && st.size === c.size) return c.all;
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
    const fresh = cut >= skip ? parseLines(buf.toString('utf8', skip, cut + 1)) : [];
    const entries = c && !fresh.length ? c.entries : Object.freeze(c ? c.entries.concat(fresh) : fresh);
    const offset = cut >= skip ? start + cut + 1 : (c ? c.offset : 0);
    // A last line with no newline yet (torn, or written by a non-appender): parsed, never cached as complete.
    const partial = parseLines(buf.toString('utf8', Math.max(skip, cut + 1)));
    const all = partial.length ? Object.freeze(entries.concat(partial)) : entries;
    const tailStart = Math.max(0, offset - start - TAIL_CHECK);
    const tail = Buffer.from(buf.subarray(tailStart, offset - start));
    readCache.set(file, { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, offset, tail, entries, all });
    return all;
  } finally { fs.closeSync(fd); }
}

/** A sealed segment's entries, parsed once per file (it never changes). */
function segEntries(file: string): readonly Readonly<Entry>[] {
  const key = statKey(file);
  const hit = segCache.get(file);
  if (hit && hit.key === key) return hit.entries;
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* missing: nothing held */ }
  const entries = Object.freeze(parseLines(text));
  segCache.set(file, { key, entries });
  return entries;
}

/** What readAll holds before the active segment: the snapshot's entries before `held`, then each sealed segment
 * (its first entry skipped when it repeats the one before: the carry line). */
function prefixOf(dir: string, snap: LogSnapshot): readonly Readonly<Entry>[] {
  const hit = prefixes.get(dir);
  if (hit && hit.snap === snap) return hit.entries;
  const out: Entry[] = snap.entries.filter(e => e.id < snap.held);
  let last = snap.held - 1;
  for (let n = 1; n <= snap.seg; n++) {
    const es = segEntries(segFile(dir, n));
    let i = 0;
    for (const e of es) {
      if (i++ === 0 && !(e.id > last)) continue;
      out.push(e);
      if (e.id > last) last = e.id;
    }
  }
  const entries = Object.freeze(out);
  prefixes.set(dir, { snap, entries });
  return entries;
}

/** The active segment's entries after the snapshot (its carry line, and lines a rotation in flight sealed, left out). */
function afterSnap(act: readonly Readonly<Entry>[], S: number): readonly Readonly<Entry>[] {
  const at = act.findIndex(e => e.id > S);
  const i = at < 0 ? act.length : at;
  return i ? Object.freeze(act.slice(i)) : act;
}

/** fn(snap), read again while a rotation changed snapshot.json under it (the snapshot and the active file agree). */
function settled<R>(dir: string, fn: (snap: LogSnapshot | null) => R): R {
  for (let i = 0; ; i++) {
    const snap = snapOf(dir);
    const r = fn(snap);
    if (i >= 3 || loadSnap(dir) === snap) return r;
  }
}

function readAll(dir: string): readonly Readonly<Entry>[] {
  return settled(dir, snap => {
    const act = readActive(activeFile(dir));
    const prefix = snap ? prefixOf(dir, snap) : EMPTY;
    const c = alls.get(dir);
    if (c && c.prefix === prefix && c.act === act) return c.all;
    const tail = snap ? afterSnap(act, snap.id) : act;
    const all = prefix.length ? Object.freeze(prefix.concat(tail)) : tail;
    alls.set(dir, { prefix, act, all });
    return all;
  });
}

/** The id of the last parseable line, from a read of the active segment's tail only. */
function lastId(dir: string): number {
  const snap = snapOf(dir);
  const fd = openRead(activeFile(dir));
  let id = 0;
  if (fd !== null) {
    try {
      for (const l of linesBackward(fd, fs.fstatSync(fd).size)) {
        try { const v: unknown = JSON.parse(l); if (v === null) continue; const x = isObj(v) ? v.id : undefined; id = typeof x === 'number' && x ? x : 0; break; } catch { /* corrupt: keep looking */ }
      }
    } finally { fs.closeSync(fd); }
  }
  return Math.max(id, snap ? snap.id : 0);
}

function lineHashIn(file: string, id: number): string | null {
  const fd = openRead(file);
  if (fd === null) return null;
  try {
    const end = fs.fstatSync(fd).size;
    const L = lineAt(fd, offsetAfter(fd, end, id - 1), end);
    if (!L || L.id !== id) return null;
    const b = readRange(fd, L.start, L.end - L.start);
    return hash12(b[b.length - 1] === 10 ? b.subarray(0, -1) : b);
  } finally { fs.closeSync(fd); }
}
function lineHash(dir: string, id: number): string | null {
  if (id === 0) return hash12('');
  if (!Number.isInteger(id) || id < 0) return null;
  const snap = snapOf(dir);
  if (!snap || id > snap.id) return lineHashIn(activeFile(dir), id);
  if (id === snap.id) return snap.hash;
  const seg = snap.segs.find(([, first, last]) => id >= first && id <= last);
  return seg ? lineHashIn(segFile(dir, seg[0]), id) : null;
}

// ---------- the tailer ----------
function tailer(dir: string, { fs: xfs = nodeFs, after }: { fs?: TailerFs; after?: number } = {}): Tailer {
  const act = activeFile(dir);
  const inoOf = (f: string): number | null => { try { return xfs.statSync(f).ino; } catch { return null; } };
  let cur = 0;                 // 0: the active segment; n: sealed segment n
  let offset = 0;
  let ino: number | null = null; // the active file's, while cur is 0
  let last = 0;                // the newest id passed on: a file's first line that repeats it (a carry) is skipped
  if (after === undefined) {
    offset = endOffset(xfs, act);
    ino = inoOf(act);
    last = lastId(dir);
  } else {
    const snap = snapOf(dir);
    const seg = snap && after < snap.id ? snap.segs.find(([, , l]) => l > after) : undefined;
    if (seg) cur = seg[0];
    offset = offsetAfterId(cur ? segFile(dir, cur) : act, after);
    if (!cur) ino = inoOf(act);
    last = after;
  }
  /** Read the complete lines of file in [offset, size) into the poll's output. */
  function read(file: string, size: number, out: { entries: Entry[]; lines: string[] }): void {
    const fd = xfs.openSync(file, 'r');
    let buf: Buffer;
    try {
      buf = Buffer.allocUnsafe(size - offset);
      xfs.readSync(fd, buf, 0, buf.length, offset);
    } finally { xfs.closeSync(fd); }
    let pos = 0;
    for (let nl: number; (nl = buf.indexOf(10, pos)) >= 0; pos = nl + 1) {
      const at = offset + pos;
      if (nl > pos) {
        const line = buf.toString('utf8', pos, nl);
        let e: Entry | null = null;
        try { e = snapshot.asEntry(JSON.parse(line)); } catch { /* corrupt: passed on as a line */ }
        if (!(at === 0 && e && !(e.id > last))) { // a carry line: the previous file's last, passed on already
          out.lines.push(line);
          if (e) { out.entries.push(e); if (e.id > last) last = e.id; }
        }
      }
    }
    offset += pos;
  }
  /** The sealed segment the active file of inode `old` became (a rotation), else 0: any of them, newest first, so a
   *  tailer many rotations behind reads on from where it was instead of starting over (a reset reads as a FORK) */
  function sealedAs(old: number): number {
    const snap = snapOf(dir);
    for (let n = snap ? snap.seg : 0; n >= 1; n--) if (inoOf(segFile(dir, n)) === old) return n;
    return 0;
  }
  return {
    get offset() { return offset; },
    poll() {
      const out = { entries: [] as Entry[], lines: [] as string[] };
      let reset = false;
      const restart = () => { offset = 0; last = 0; reset = true; };
      for (let guard = 0; guard < 100_000; guard++) {
        if (cur > 0) {
          const f = segFile(dir, cur);
          let size = -1;
          try { size = xfs.statSync(f).size; } catch (e) { if (errCode(e) !== 'ENOENT') throw e; }
          if (size < 0) { cur = 0; ino = null; restart(); continue; } // set aside or reset under the tailer
          if (size > offset) read(f, size, out);
          const snap = snapOf(dir);
          if (snap && cur < snap.seg) cur++; else { cur = 0; ino = inoOf(act); }
          offset = 0;
          continue;
        }
        let st: nodeFs.Stats;
        try { st = xfs.statSync(act); } catch (e) { if (errCode(e) === 'ENOENT') return { ...out, reset }; throw e; }
        if (ino !== null && st.ino !== ino) {
          const n = sealedAs(ino);
          ino = null;
          if (n) { cur = n; continue; } // rotated: the rest of the old file, then on
          restart();
        }
        ino = st.ino;
        if (st.size < offset) restart();
        if (st.size > offset) read(act, st.size, out);
        return { ...out, reset };
      }
      return { ...out, reset };
    },
  };
}

// ---------- the chain ----------
/** Every line this machine holds, in order, each file's carry line flagged. */
function* heldLines(dir: string, snap: LogSnapshot | null): Generator<{ line: string; carry: boolean; first: boolean }> {
  const files = [...Array.from({ length: snap ? snap.seg : 0 }, (_, i) => segFile(dir, i + 1)), activeFile(dir)];
  let last = snap ? snap.held - 1 : 0;
  let first = true;
  for (const f of files) {
    let raw = '';
    try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
    let i = 0;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const e = parse(line);
      const carry = i++ === 0 && !!e && !(e.id > last) && !!snap;
      if (e && e.id > last) last = e.id;
      yield { line, carry, first };
      first = false;
    }
  }
}

function validateChain(dir: string): ChainCheck {
  const snap = snapOf(dir);
  let prev: string | null = snap && snap.held > 1 ? null : ''; // a mirror from a snapshot: its first line is the anchor
  let count = snap ? snap.base : 0;
  let before = '';
  for (const { line, carry, first } of heldLines(dir, snap)) {
    const e = parse(line);
    if (prev === null && first) { prev = line; before = line; continue; }
    if (carry) {
      if (line !== before) return { ok: false, badAt: e ? e.id : null, count };
      continue;
    }
    count++;
    if (!e) return { ok: false, badAt: null, line: count, count };
    if (e.prev !== undefined && e.prev !== hash12(prev as string)) return { ok: false, badAt: e.id, count };
    prev = line;
    before = line;
  }
  return { ok: true, count };
}

/** Where the active segment's checking starts: after the snapshot (its carry line first), else byte 0. */
const startCp = (snap: LogSnapshot | null): Checkpoint => ({
  offset: 0, id: snap ? snap.id : 0, hash: snap ? snap.hash : hash12(''), count: snap ? snap.count : 0, first: 0, marks: [],
});

/** cp still describes the file open at fd (size bytes): its offset a line boundary whose line before hashes to cp.hash. */
const holds = (fd: number, size: number, cp: Checkpoint): boolean => cp.offset === 0 || (cp.offset <= size && atBoundary(fd, cp.offset)
  && hash12(lineBefore(fd, cp.offset)) === cp.hash);

/**
 * Parse the complete lines of the active segment in [cp.offset, size), checking the chain from cp. Returns the parsed
 * lines ([{off, e}], corrupt ones and the carry left out), the checkpoint advanced over every line that chains (it
 * stops at the first break), the non-chat entries it added to the marks (mark: false keeps none), and the break
 * ({badAt} or {line}) if any. At byte 0 after a snapshot, the first line must be the snapshot's own (the carry). A
 * last line without its newline is not scanned.
 */
function scan(fd: number, size: number, cp: Checkpoint, mark = true): { out: { off: number; e: Entry }[]; next: Checkpoint; added: Entry[]; bad: ChainBreak | null; complete: number } {
  const start = cp.offset;
  const buf = Buffer.allocUnsafe(size - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  const cut = buf.lastIndexOf(10);
  const out: { off: number; e: Entry }[] = [];
  const added: Entry[] = [];
  const next: Checkpoint = { ...cp, marks: cp.marks };
  let bad: ChainBreak | null = null, pos = 0, grown = false;
  while (cut >= 0 && pos <= cut) {
    const nl = buf.indexOf(10, pos);
    if (nl > pos) {
      const l = buf.toString('utf8', pos, nl);
      let e: Entry | null = null;
      try { e = snapshot.asEntry(JSON.parse(l)); } catch { bad ??= { badAt: null, line: next.count + 1 }; }
      if (!bad && start + pos === 0 && cp.id > 0 && e && !(e.id > cp.id)) { // the carry line: the snapshot's own, verbatim
        if (hash12(l) !== cp.hash) bad = { badAt: e.id };
        pos = nl + 1;
        if (!bad) next.offset = start + pos;
        continue;
      }
      if (e) {
        out.push({ off: start + pos, e });
        if (!bad && e.prev !== undefined && e.prev !== next.hash) bad = { badAt: e.id };
      }
      if (!bad) {
        if (e && mark && !CHAT_KINDS.has(e.kind)) {
          if (!grown) { next.marks = cp.marks.slice(); grown = true; }
          next.marks.push([e.id, start + pos, nl - pos]);
          added.push(e);
        }
        next.hash = hash12(l); next.id = (e && e.id) || next.id; next.count++;
        if (!next.first && e && e.id) next.first = e.id;
      }
    }
    pos = nl + 1;
    if (!bad) next.offset = start + pos;
  }
  return { out, next, added, bad, complete: start + cut + 1 };
}

function verifyChain(dir: string, { fromOffset, prev }: { fromOffset?: number; prev?: string } = {}): ChainVerify {
  const snap = snapOf(dir);
  const fd = openRead(activeFile(dir));
  const head = startCp(snap);
  if (fd === null) return { ok: true, count: head.count, checked: 0, offset: 0, id: head.id, hash: head.hash, from: 0 };
  try {
    const st = fs.fstatSync(fd);
    const size = st.size;
    let cp: Checkpoint;
    if (fromOffset !== undefined) {
      if (!Number.isInteger(fromOffset) || fromOffset < 0 || fromOffset > size || !atBoundary(fd, fromOffset)) {
        const error = 'fromOffset is not a line boundary of the log';
        return { ok: false, badAt: null, count: 0, checked: 0, offset: fromOffset, from: fromOffset, error };
      }
      cp = fromOffset === 0 ? head : { ...head, offset: fromOffset, id: 0, hash: typeof prev === 'string' ? prev : hash12(lineBefore(fd, fromOffset)) };
    } else {
      const v = verified.get(dir);
      cp = v && v.snap === snap && v.dev === st.dev && v.ino === st.ino && holds(fd, size, v.cp) ? v.cp : head;
    }
    const { next, bad } = scan(fd, size, cp, false);
    if (fromOffset === undefined) verified.set(dir, { dev: st.dev, ino: st.ino, snap, cp: next });
    const r: ChainVerify = { ok: !bad, count: next.count, checked: next.count - cp.count, offset: next.offset, id: next.id, hash: next.hash, from: cp.offset };
    return bad ? { ...r, ...bad } : r;
  } finally { fs.closeSync(fd); }
}

// ---------- the view ----------
/** The entries of cp's marks, read in runs of nearby lines (null for a mark that no longer parses). */
function readMarks(fd: number, marks: readonly [number, number, number][]): (Entry | null)[] {
  const out: (Entry | null)[] = [];
  let i = 0;
  for (let first = marks[i]; first; first = marks[i]) {
    // a run: first..last, each mark within 4 KiB of the one before
    let j = i, last = first;
    for (let next = marks[j + 1]; next && next[1] - (last[1] + last[2]) < 4096; next = marks[j + 1]) { last = next; j++; }
    const off = first[1], buf = readRange(fd, off, last[1] + last[2] - off);
    for (let k = i; k <= j; k++) {
      const m = marks[k];
      if (m) out.push(parse(buf.subarray(m[1] - off, m[1] - off + m[2]))); // k <= j: there
    }
    i = j + 1;
  }
  return out;
}

/**
 * This process's checkpoint of the active segment open at fd, advanced over the complete lines after it: the view
 * state, plus what the advance read ([{off, e}] past the old checkpoint, its first break, and where the complete lines
 * end). A new snapshot (a rotation) or another file starts it again after the snapshot.
 */
function advance(dir: string, snap: LogSnapshot | null, fd: number, size: number): { v: ViewState; marked: readonly Readonly<Entry>[]; out: { off: number; e: Entry }[]; bad: ChainBreak | null; complete: number } {
  const st = fs.fstatSync(fd);
  const key = `${size}:${st.mtimeMs}`;
  let v = views.get(dir);
  if (v && (v.snap !== snap || (v.checked !== key && (v.dev !== st.dev || v.ino !== st.ino || !holds(fd, size, v.cp))))) v = undefined;
  if (!v) {
    v = { dev: st.dev, ino: st.ino, snap, cp: startCp(snap), marked: [], checked: key, joined: null };
    views.set(dir, v);
  }
  v.checked = key;
  let marked = v.marked;
  if (!marked) {
    const got = readMarks(fd, v.cp.marks);
    const parsed = got.filter((e): e is Entry => !!e);
    if (parsed.length < got.length) { v.cp = startCp(snap); marked = []; } // a marked line no longer parses: from the start
    else marked = Object.freeze(parsed);
    v.marked = marked;
  }
  const { out, next, added, bad, complete } = scan(fd, size, v.cp);
  if (next.offset > v.cp.offset) {
    v.cp = next;
    if (added.length) { v.marked = marked = Object.freeze(marked.concat(added)); v.joined = null; }
  }
  return { v, marked, out, bad, complete };
}

/** The active segment's view: its non-chat entries and every entry with id > after (after >= the snapshot's id). */
function activeView(dir: string, snap: LogSnapshot | null, after: number): Entry[] {
  const fd = openRead(activeFile(dir));
  if (fd === null) return [];
  try {
    const size = fs.fstatSync(fd).size;
    const { v, marked, out, complete } = advance(dir, snap, fd, size);
    const cp = v.cp, marks = cp.marks;
    const res: Entry[] = [];
    // marks and marked are one list: a mark's offset, and its entry
    const markAt = (i: number): number => marks[i]?.[1] ?? Infinity;
    const take = (i: number): void => { const e = marked[i]; if (e) res.push(e); };
    // the prefix: marked lines, and (after < cp.id) every line from the first with id > after
    const from = after < cp.id ? offsetAfter(fd, cp.offset, after) : cp.offset;
    let k = 0;
    for (; k < marks.length && markAt(k) < from; k++) take(k);
    if (from < cp.offset) {
      const buf = readRange(fd, from, cp.offset - from);
      let pos = 0;
      while (pos < buf.length) {
        let nl = buf.indexOf(10, pos);
        if (nl < 0) nl = buf.length;
        if (nl > pos) {
          if (k < marks.length && markAt(k) === from + pos) take(k++);
          else { const e = parse(buf.subarray(pos, nl)); if (e && e.id > after) res.push(e); }
        }
        pos = nl + 1;
      }
    }
    for (; k < marks.length; k++) take(k);
    // after the checkpoint: what this call scanned past it (a break stops the checkpoint, not the reading)
    for (const { off, e } of out) if (off >= cp.offset && (!CHAT_KINDS.has(e.kind) || e.id > after)) res.push(e);
    if (size > complete) { // no newline yet; readAll() parses it too
      const e = parse(readRange(fd, complete, size - complete));
      if (e && (!CHAT_KINDS.has(e.kind) || e.id > after)) res.push(e);
    }
    return res;
  } finally { fs.closeSync(fd); }
}

function readView(dir: string, { after }: { after: number }): readonly Readonly<Entry>[] {
  return settled(dir, snap => {
    const S = snap ? snap.id : 0;
    const tail = activeView(dir, snap, Math.max(after, S));
    if (!snap) return tail;
    if (after >= S) return snap.entries.length ? snap.entries.concat(tail) : tail;
    // a reader behind the snapshot: the sealed segments' chat after `after` too
    const head = prefixOf(dir, snap).filter(e => !CHAT_KINDS.has(e.kind) || e.id > after);
    return head.concat(tail);
  });
}

function nonChat(dir: string): { marked: readonly Readonly<Entry>[]; rest: Entry[] } {
  return settled(dir, snap => {
    const fd = openRead(activeFile(dir));
    if (fd === null) return { marked: snap ? snap.entries : EMPTY, rest: [] };
    try {
      const size = fs.fstatSync(fd).size;
      const { v, marked, out, complete } = advance(dir, snap, fd, size);
      const rest = out.filter(x => x.off >= v.cp.offset && !CHAT_KINDS.has(x.e.kind)).map(x => x.e);
      if (size > complete) { const e = parse(readRange(fd, complete, size - complete)); if (e && !CHAT_KINDS.has(e.kind)) rest.push(e); }
      v.joined ??= snap && snap.entries.length ? Object.freeze(snap.entries.concat(marked)) : marked;
      return { marked: v.joined, rest };
    } finally { fs.closeSync(fd); }
  });
}

const recentFrom = (dir: string): number => { const s = snapOf(dir); return s ? s.id : 0; };
function snapshotOf(dir: string): (SnapshotWire & { held: number }) | null {
  const s = snapOf(dir);
  return s ? { ...snapshot.toWire(s), held: s.held } : null;
}

// ---------- writing ----------
/** The log lock's timeout: RoomError LOCK with withLock's message (RoomError itself takes the code first). */
class LockError extends RoomError { constructor(message: string) { super('LOCK', message); } }

/**
 * One backward read of the active segment from byte `end`: the last line (the next entry's prev) and the parseable
 * entries, newest first, then the snapshot's window (what a placement looks back over across a rotation).
 */
function tailFrom(fd: number, end: number, snap: LogSnapshot | null): { prevLine: string; newest: Generator<Entry> } {
  const lines = linesBackward(fd, end);
  const first = lines.next();
  function* newest(): Generator<Entry> {
    let low = Infinity;
    for (let n = first; !n.done; n = lines.next()) {
      let e: Entry | null = null;
      try { e = snapshot.asEntry(JSON.parse(n.value)); } catch { /* corrupt line: skip */ }
      if (e) { if (e.id < low) low = e.id; yield e; }
    }
    if (!snap) return;
    for (let i = snap.window.length - 1; i >= 0; i--) {
      const w: WindowItem | undefined = snap.window[i];
      if (w && w.id < low) yield w as Entry; // the fields scanTail reads
    }
  }
  return { prevLine: first.done ? (snap ? snap.line : '') : first.value, newest: newest() };
}

/** Under the lock: the snapshot, with a rotation a crash interrupted finished (the active file still the sealed one, or
 * gone): log.jsonl becomes the snapshot's line alone again. */
function settle(dir: string): LogSnapshot | null {
  const snap = loadSnap(dir) ?? (rebuildable(dir) ? rebuild(dir) : null);
  if (!snap) return null;
  const act = activeFile(dir);
  let ino: number | null = null;
  try { ino = fs.statSync(act).ino; } catch { /* gone */ }
  let sealedIno: number | null = null;
  try { if (snap.seg) sealedIno = fs.statSync(segFile(dir, snap.seg)).ino; } catch { /* gone */ }
  if (ino === null || (sealedIno !== null && ino === sealedIno)) {
    writeFileAtomic(act, snap.line + '\n', { mode: 0o600 });
    forget(dir);
  }
  return snap;
}

function appendLocked(dir: string, place: (tail: { newest: Iterable<Entry>; prevLine: string }) => { e: Entry; line: string }): Entry {
  const act = activeFile(dir);
  return withLock(act + '.lock', () => {
    const snap = settle(dir);
    const fd = fs.openSync(act, 'a+', 0o600);
    let e: Entry, end: number;
    try {
      const size = fs.fstatSync(fd).size;
      let endsNl = true;
      if (size) { const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, size - 1); endsNl = b[0] === 10; }
      const r = place(tailFrom(fd, size, snap));
      const text = (endsNl ? '' : '\n') + r.line + '\n';
      fs.writeSync(fd, text);
      e = r.e;
      end = size + Buffer.byteLength(text);
    } finally { fs.closeSync(fd); }
    if (end >= segmentMaxBytes()) { try { rotate(dir, true); } catch { /* sealed at the next append instead */ } }
    return e;
  }, { ErrorClass: LockError });
}

function appendVerbatim(dir: string, line: string): void {
  const act = activeFile(dir);
  withLock(act + '.lock', () => {
    settle(dir);
    fs.appendFileSync(act, line + '\n', { mode: 0o600 });
    let size = 0;
    try { size = fs.statSync(act).size; } catch { /* gone */ }
    if (size >= segmentMaxBytes()) { try { rotate(dir, true); } catch { /* the next line tries again */ } }
  }, { ErrorClass: LockError });
}

/** The snapshot of the sealed segments on disk, written (a snapshot.json lost or unreadable: under the lock). */
function rebuild(dir: string): LogSnapshot | null {
  let snap: LogSnapshot | null = loadBase(dir); // an installed mirror's start: the host's entries before its first line
  for (const n of sealedOnDisk(dir)) {
    if (n !== (snap ? snap.seg : 0) + 1) break;
    let lines: string[] = [];
    try { lines = fs.readFileSync(segFile(dir, n), 'utf8').split('\n').filter(Boolean); } catch { break; }
    const prev: LogSnapshot | null = snap;
    const S: number = prev ? prev.id : 0;
    const real: string[] = lines.filter((l, i) => !(i === 0 && prev && !((parse(l) ?? { id: 0 }).id > S)));
    const es: Entry[] = real.map(l => parse(l)).filter((e): e is Entry => !!e);
    const [head] = es, line = real.at(-1);
    if (!head || line === undefined) break; // es comes from real: one is empty only when both are
    const wire = snapshot.extend(prev, { nonChat: es.filter(e => !CHAT_KINDS.has(e.kind)), recent: es.slice(-SNAPSHOT_WINDOW_MAX), line, lines: real.length });
    const first = prev && prev.seg === 0 ? prev.id : head.id; // an installed mirror's first segment holds its anchor
    snap = { v: 1, ...wire, seg: n, segs: [...(snap ? snap.segs : []), [n, first, wire.id]], held: snap ? snap.held : head.id, base: snap ? snap.base : 0, at: new Date().toISOString() };
  }
  if (snap) { writeJsonAtomic(snapFile(dir), snap, { compact: true }); forget(dir); }
  return snap;
}

/**
 * Seal the active segment: link it as the next log-NNNN.jsonl, write snapshot.json, replace log.jsonl with the sealed
 * last line. Nothing is sealed when the segment does not chain to the end (a break, a line without its newline) or
 * holds no line after the snapshot. locked: the caller holds the log lock.
 */
function rotate(dir: string, locked = false): boolean {
  const act = activeFile(dir);
  if (!locked) return withLock(act + '.lock', () => rotate(dir, true), { ErrorClass: LockError });
  const snap = settle(dir);
  const fd = openRead(act);
  if (fd === null) return false;
  let next: LogSnapshot;
  try {
    const size = fs.fstatSync(fd).size;
    const { v, marked, bad } = advance(dir, snap, fd, size);
    const S = snap ? snap.id : 0;
    if (bad || v.cp.offset !== size || !(v.cp.id > S) || !v.cp.first) return false;
    const line = lineBefore(fd, size);
    const lastAt = Date.parse((parse(line) as Entry).at);
    const recent: Entry[] = [];
    for (const l of linesBackward(fd, size)) {
      const e = parse(l);
      if (!e || !(e.id > S) || Date.parse(e.at) < lastAt - snapshot.WINDOW_MS || recent.length >= SNAPSHOT_WINDOW_MAX) break;
      recent.push(e);
    }
    recent.reverse();
    const wire = snapshot.extend(snap, { nonChat: marked, recent, line, lines: v.cp.count - (snap ? snap.count : 0) });
    const n = (snap ? snap.seg : 0) + 1;
    next = {
      // an installed mirror's first seal starts at its anchor (the snapshot's line, this segment's carry): no earlier
      // segment here holds it, and a subscribe at the anchor (after a handoff) asks its hash
      v: 1, ...wire, seg: n, segs: [...(snap ? snap.segs : []), [n, snap && snap.seg === 0 ? snap.id : v.cp.first, wire.id]],
      held: snap ? snap.held : v.cp.first, base: snap ? snap.base : 0, at: new Date().toISOString(),
    };
  } finally { fs.closeSync(fd); }
  const sealed = segFile(dir, next.seg);
  fs.rmSync(sealed, { force: true }); // a name left by a rotation a crash cut short: no snapshot names it
  try { fs.linkSync(act, sealed); } catch { fs.copyFileSync(act, sealed); } // a file system without hard links
  writeJsonAtomic(snapFile(dir), next, { compact: true });
  writeFileAtomic(act, next.line + '\n', { mode: 0o600 });
  forget(dir);
  return true;
}

function install(dir: string, wire: SnapshotWire): void {
  const act = activeFile(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  withLock(act + '.lock', () => {
    let size = 0;
    try { size = fs.statSync(act).size; } catch { /* none */ }
    if (size || loadSnap(dir) || fs.existsSync(segFile(dir, 1))) throw new RoomError('PROTOCOL', 'a snapshot arrived for a mirror that holds lines already');
    const snap: LogSnapshot = { v: 1, ...snapshot.toWire(wire), seg: 0, segs: [], held: wire.id + 1, base: wire.count, at: new Date().toISOString() };
    writeJsonAtomic(baseFile(dir), snap, { compact: true });
    writeJsonAtomic(snapFile(dir), snap, { compact: true });
    writeFileAtomic(act, wire.line + '\n', { mode: 0o600 });
    forget(dir);
  }, { ErrorClass: LockError });
}

/** Every log file of the room (active, sealed, snapshot). */
function logFiles(dir: string): string[] {
  return [activeFile(dir), snapFile(dir), baseFile(dir), ...sealedOnDisk(dir).map(n => segFile(dir, n))];
}

/** Every line held moved to `to` as one log (the carry lines left out); false with no log. */
function setAside(dir: string, to: string): boolean {
  const snap = loadSnap(dir);
  if (!snap && !sealedOnDisk(dir).length) {
    if (!fs.existsSync(activeFile(dir))) return false;
    fs.renameSync(activeFile(dir), to);
  } else {
    const fd = fs.openSync(to, 'wx', 0o600);
    try { for (const { line, carry } of heldLines(dir, snap)) if (!carry) fs.writeSync(fd, line + '\n'); } finally { fs.closeSync(fd); }
  }
  remove(dir);
  return true;
}

function remove(dir: string): void {
  for (const f of logFiles(dir)) fs.rmSync(f, { force: true });
  forget(dir);
}

function forget(dir: string): void {
  const act = activeFile(dir);
  readCache.delete(act); views.delete(dir); verified.delete(dir); snaps.delete(dir); prefixes.delete(dir); alls.delete(dir);
  for (const k of [...segCache.keys()]) if (path.dirname(k) === dir) segCache.delete(k);
}

export {
  activeFile, readAll, lastId, lineHash, tailer, validateChain, verifyChain, readView, nonChat, recentFrom, snapshotOf,
  appendLocked, appendVerbatim, rotate, install, setAside, remove, forget,
};
