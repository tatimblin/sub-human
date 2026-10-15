/**
 * plugin/sub-human/lib/room/log-io.ts: the bytes of a room log, <room>/log.jsonl, and its checkpoint <room>/log.idx.
 * Only lib/room/fs-store.ts imports this file (test/store-bypass.node-test.ts checks it): every other module reads a
 * log through a RoomStore. One JSON entry per line, appended under <log>.lock; nothing here knows what an entry means
 * beyond its id, its prev (the chain) and whether its kind is a chat kind (rules.ts CHAT_KINDS).
 *
 * Reading (every call takes the log file; the caches are per file, for this process):
 *   readAll(file) -> readonly Entry[]   every parseable entry, in order. Cached: a repeat call re-reads nothing when
 *       the file is unchanged and parses only the appended bytes when it grew (same inode, the bytes before the old
 *       end unchanged); a shrink, a new inode, a same-size rewrite or a changed tail drops the cache and re-reads. The
 *       array is the cache itself, frozen: callers never change it (a grown log gives a new array). A last line with
 *       no newline yet is parsed, never cached.
 *   lastId(file), lineHash(file, id) -> hash12 of the stored line (id 0: hash12(''); null: no such line)
 *   tailer(file, {fs, after}?)          entries appended after the moment it was made (after: an id, from the first
 *       line after it instead), parsed and verbatim; reset: the log shrank and reading began again
 *   validateChain(file)                 the whole prev chain
 *   verifyChain(file, idx, {fromOffset, prev, save}?)   incremental from the checkpoint in log.idx (byte 0 when there
 *       is none or it no longer matches); save: true writes the advanced checkpoint, 'lazy' only once it is
 *       IDX_SAVE_BYTES past the saved one (or IDX_SAVE_MS older), false never. log.idx is parsed once per change on
 *       disk, not per call.
 *   readView(file, idx, {after})        every non-chat entry and every entry with id > after, in log order: the same
 *       answer as readAll() for the entries after `after`, without parsing the whole log. It keeps this process's own
 *       checkpoint (in memory, started from log.idx), advances it over each new line it checks, and never writes
 *       log.idx (verifyChain does).
 *   nonChat(file, idx) -> {marked, rest}   the non-chat entries: those in the verified prefix (`marked`: the same
 *       objects, in a prefix-stable array, from call to call) and after it (past a chain break, or a line without its
 *       newline). What the store derives its pinned keys and host from, one new line at a time.
 * Writing:
 *   appendLocked(file, place) -> Entry  under the log lock: read only the log's tail, place({newest, prevLine}) ->
 *       {e, line}, then write the line (after a newline when the last line has none). RoomError LOCK on timeout.
 *   appendVerbatim(file, line)          a line as another machine stored it (the mirror's one writer)
 *   forget(file)                        drop this process's caches of file (it was moved aside or reset)
 *
 * log.idx = {v:1, offset, id, hash, count, marks}: the log's first `offset` bytes (`count` lines, last id `id`) were
 * checked to chain, and hash = hash12 of the line that ends at offset (the next line's prev). marks = [[id, offset,
 * length], ...] for every line in that prefix whose kind is not a chat kind: the lines that decide lanes, proposals,
 * answers, notices. A cache, trusted only while the line before `offset` still hashes to `hash`; rebuilt otherwise.
 */

import nodeFs from 'node:fs';
import { withLock } from '../lock.ts';
import { writeJsonAtomic, readJson } from '../io.ts';
import { hash12 } from '../text.ts';
import { RoomError } from './validate.ts';
import { CHAT_KINDS } from './rules.ts';
import type { ChainCheck, ChainVerify, Entry, Tailer, TailerFs } from './types.ts';

const fs = nodeFs;

/** <room>/log.idx: the verified prefix of the log and the byte ranges of its non-chat lines. */
interface Checkpoint {
  v: 1;
  offset: number;
  id: number;
  hash: string;
  count: number;
  /** [id, offset, length] per non-chat line in the prefix */
  marks: [number, number, number][];
}
/** One line of the log, found by lineAt: its byte range and id (null for a line without one). */
interface LineSpan { start: number; end: number; id: number | null }
/** Where a chain check broke: an id whose prev does not chain, or a corrupt line (badAt null, line 1-based). */
interface ChainBreak { badAt: number | null; line?: number }
/** readAll's cache of one log file. */
interface ReadCache { dev: number; ino: number; size: number; mtimeMs: number; offset: number; tail: Buffer; entries: readonly Entry[]; all: readonly Entry[] }
/** This process's view of one log: its checkpoint and the parsed entries of its marks (same order). */
interface ViewState { dev: number; ino: number; cp: Checkpoint; marked: readonly Entry[] | null; checked: string }
/** verifyChain's cache of log.idx as last read or written: its stat key and checkpoint. */
interface DiskCp { key: string; cp: Checkpoint | null; savedAt: number }
type SaveMode = boolean | 'lazy';

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;
const TAIL_CHUNK = 64 * 1024;
const TAIL_CHECK = 64;              // bytes before the cached end compared on growth
const IDX_SAVE_BYTES = 64 * 1024;   // verifyChain({save: 'lazy'}): write log.idx once the checkpoint is this far ahead
const IDX_SAVE_MS = 60_000;         // … or this old

const readCache = new Map<string, ReadCache>();
const views = new Map<string, ViewState>();
const disk = new Map<string, DiskCp>();

const ZERO = (): Checkpoint => ({ v: 1, offset: 0, id: 0, hash: hash12(''), count: 0, marks: [] });

function parseLines(text: string): Entry[] {
  const out: Entry[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { const e = JSON.parse(line); if (e && typeof e === 'object') out.push(e); } catch { /* torn or corrupt line: skip */ }
  }
  return out;
}
const parse = (buf: Buffer): Entry | null => { try { const e = JSON.parse(buf.toString('utf8')); return e && typeof e === 'object' ? e : null; } catch { return null; } };

/** Open file for reading, or null when it does not exist. */
function openRead(file: string): number | null {
  try { return fs.openSync(file, 'r'); } catch (e) { if (errCode(e) === 'ENOENT') return null; throw e; }
}

/** The log's non-empty lines read backwards from byte `end` (newest first), as strings. Reads TAIL_CHUNK at a time. */
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

/** One backward read from byte `end`: the last line (the next entry's prev) and the parseable entries, newest first. */
function tailFrom(fd: number, end: number): { prevLine: string; newest: Generator<Entry> } {
  const lines = linesBackward(fd, end);
  const first = lines.next();
  function* newest(): Generator<Entry> {
    for (let n = first; !n.done; n = lines.next()) {
      let e: Entry | null = null;
      try { e = JSON.parse(n.value as string); } catch { /* corrupt line: skip */ }
      if (e && typeof e === 'object') yield e;
    }
  }
  return { prevLine: first.done ? '' : first.value, newest: newest() };
}

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

/** Byte offset of the first line in [0, end) whose id is > after (ids rise through the log), or end. */
function offsetAfter(fd: number, end: number, after: number): number {
  let lo = 0, hi = end;
  const idAt = (pos: number): LineSpan | null => { let L = lineAt(fd, pos, end); while (L && L.id === null) L = lineAt(fd, L.end, end); return L; };
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const L = idAt(mid);
    if (!L || L.id! > after) hi = mid; else lo = mid + 1; // idAt skips lines without an id
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

// ---------- readAll ----------
function readAll(file: string): readonly Entry[] {
  const fd = openRead(file);
  if (fd === null) { readCache.delete(file); return []; }
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

/** The id of the last parseable line, from a read of the log's tail only. */
function lastId(file: string): number {
  const fd = openRead(file);
  if (fd === null) return 0;
  try {
    for (const l of linesBackward(fd, fs.fstatSync(fd).size)) {
      try { return JSON.parse(l).id || 0; } catch { /* corrupt: keep looking */ }
    }
    return 0;
  } finally { fs.closeSync(fd); }
}

function lineHash(file: string, id: number): string | null {
  if (id === 0) return hash12('');
  if (!Number.isInteger(id) || id < 0) return null;
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

/** The byte offset of the first complete line whose id is > after (the end of the complete lines when none is). */
function offsetAfterId(file: string, after: number): number {
  const end = endOffset(fs, file);
  if (!end) return 0;
  const fd = fs.openSync(file, 'r');
  try { return offsetAfter(fd, end, after); } finally { fs.closeSync(fd); }
}

function tailer(file: string, { fs: xfs = nodeFs, after }: { fs?: TailerFs; after?: number } = {}): Tailer {
  let offset = after === undefined ? endOffset(xfs, file) : offsetAfterId(file, after);
  return {
    get offset() { return offset; },
    poll() {
      let st: nodeFs.Stats;
      try { st = xfs.statSync(file); } catch (e) { if (errCode(e) === 'ENOENT') return { entries: [], lines: [], reset: false }; throw e; }
      let reset = false;
      if (st.size < offset) { offset = 0; reset = true; }
      if (st.size === offset) return { entries: [], lines: [], reset };
      const fd = xfs.openSync(file, 'r');
      let buf: Buffer;
      try {
        buf = Buffer.allocUnsafe(st.size - offset);
        xfs.readSync(fd, buf, 0, buf.length, offset);
      } finally { xfs.closeSync(fd); }
      const entries: Entry[] = [], lines: string[] = [];
      let pos = 0;
      for (let nl: number; (nl = buf.indexOf(10, pos)) >= 0; pos = nl + 1) {
        if (nl > pos) {
          const line = buf.toString('utf8', pos, nl);
          lines.push(line);
          try { entries.push(JSON.parse(line)); } catch { /* corrupt */ }
        }
        offset += nl + 1 - pos;
      }
      return { entries, lines, reset };
    },
  };
}

// ---------- the chain ----------
function validateChain(file: string): ChainCheck {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { ok: true, count: 0 }; }
  const lines = raw.split('\n').filter(Boolean);
  let prev = '';
  for (let i = 0; i < lines.length; i++) {
    let e: Entry;
    try { e = JSON.parse(lines[i]); } catch { return { ok: false, badAt: null, line: i + 1, count: lines.length }; }
    if (e.prev !== undefined && e.prev !== hash12(prev)) return { ok: false, badAt: e.id, count: lines.length };
    prev = lines[i];
  }
  return { ok: true, count: lines.length };
}

/** cp still describes the log open at fd (size bytes): its offset a line boundary whose line before hashes to cp.hash. */
const holds = (fd: number, size: number, cp: Checkpoint): boolean => cp.offset <= size && atBoundary(fd, cp.offset)
  && hash12(cp.offset ? lineBefore(fd, cp.offset) : '') === cp.hash;

/** log.idx as saved, parsed once per change on disk; null when absent or not a checkpoint. */
function savedCp(idx: string): Checkpoint | null {
  let key = '';
  try { const st = fs.statSync(idx); key = `${st.ino}:${st.size}:${st.mtimeMs}`; } catch { /* none */ }
  const hit = disk.get(idx);
  if (hit && hit.key === key) return hit.cp;
  const x = key ? readJson(idx) : null;
  const cp = x && x.v === 1 && Number.isInteger(x.offset) && x.offset >= 0 && typeof x.hash === 'string' && Array.isArray(x.marks)
    && Number.isInteger(x.count) && Number.isInteger(x.id) ? x as Checkpoint : null;
  disk.set(idx, { key, cp, savedAt: hit ? hit.savedAt : 0 });
  return cp;
}
function saveCp(idx: string, cp: Checkpoint): void {
  try { writeJsonAtomic(idx, cp, { compact: true }); } catch { return; } // read-only: the next call rescans
  let key = '';
  try { const st = fs.statSync(idx); key = `${st.ino}:${st.size}:${st.mtimeMs}`; } catch { /* gone */ }
  disk.set(idx, { key, cp, savedAt: Date.now() });
}

/**
 * Parse the complete lines in [cp.offset, size), checking the chain from cp. Returns the parsed lines ([{off, e}],
 * corrupt ones left out), the checkpoint advanced over every line that chains (it stops at the first break), the
 * non-chat entries it added to the marks, and the break ({badAt} or {line}) if any. A last line without its newline
 * is not scanned.
 */
function scan(fd: number, size: number, cp: Checkpoint): { out: { off: number; e: Entry }[]; next: Checkpoint; added: Entry[]; bad: ChainBreak | null; complete: number } {
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
      try { const v = JSON.parse(l); e = v && typeof v === 'object' ? v : null; } catch { if (!bad) bad = { badAt: null, line: next.count + 1 }; }
      if (e) {
        out.push({ off: start + pos, e });
        if (!bad && e.prev !== undefined && e.prev !== next.hash) bad = { badAt: e.id };
      }
      if (!bad) {
        if (e && !CHAT_KINDS.has(e.kind)) {
          if (!grown) { next.marks = cp.marks.slice(); grown = true; }
          next.marks.push([e.id, start + pos, nl - pos]);
          added.push(e);
        }
        next.hash = hash12(l); next.id = (e && e.id) || next.id; next.count++;
      }
    }
    pos = nl + 1;
    if (!bad) next.offset = start + pos;
  }
  return { out, next, added, bad, complete: start + cut + 1 };
}

function verifyChain(file: string, idx: string, { fromOffset, prev, save = true }: { fromOffset?: number; prev?: string; save?: SaveMode } = {}): ChainVerify {
  const fd = openRead(file);
  if (fd === null) return { ok: true, count: 0, checked: 0, offset: 0, id: 0, hash: hash12(''), from: 0 };
  try {
    const size = fs.fstatSync(fd).size;
    let cp: Checkpoint;
    if (fromOffset !== undefined) {
      if (!Number.isInteger(fromOffset) || fromOffset < 0 || fromOffset > size || !atBoundary(fd, fromOffset)) {
        const error = 'fromOffset is not a line boundary of the log';
        return { ok: false, badAt: null, count: 0, checked: 0, offset: fromOffset, from: fromOffset, error };
      }
      cp = { ...ZERO(), offset: fromOffset, hash: typeof prev === 'string' ? prev : hash12(fromOffset ? lineBefore(fd, fromOffset) : '') };
    } else {
      const saved = savedCp(idx);
      cp = saved && holds(fd, size, saved) ? saved : ZERO();
    }
    const { next, bad } = scan(fd, size, cp);
    if (fromOffset === undefined && save && next.offset > cp.offset) {
      const d = disk.get(idx);
      const due = save === true || next.offset - cp.offset >= IDX_SAVE_BYTES || Date.now() - (d ? d.savedAt : 0) >= IDX_SAVE_MS;
      if (due) saveCp(idx, next);
    }
    const r: ChainVerify = { ok: !bad, count: next.count, checked: next.count - cp.count, offset: next.offset, id: next.id, hash: next.hash, from: cp.offset };
    return bad ? { ...r, ...bad } : r;
  } finally { fs.closeSync(fd); }
}

// ---------- the view ----------
/** The entries of cp's marks, read in runs of nearby lines (null for a mark that no longer parses). */
function readMarks(fd: number, marks: readonly [number, number, number][]): (Entry | null)[] {
  const out: (Entry | null)[] = [];
  let i = 0;
  while (i < marks.length) {
    let j = i;
    while (j + 1 < marks.length && marks[j + 1][1] - (marks[j][1] + marks[j][2]) < 4096) j++;
    const off = marks[i][1], buf = readRange(fd, off, marks[j][1] + marks[j][2] - off);
    for (let k = i; k <= j; k++) out.push(parse(buf.subarray(marks[k][1] - off, marks[k][1] - off + marks[k][2])));
    i = j + 1;
  }
  return out;
}

/**
 * This process's checkpoint of the log open at fd, advanced over the complete lines after it: the view state, plus
 * what the advance read ([{off, e}] past the old checkpoint, its first break, and where the complete lines end).
 */
function advance(file: string, idx: string, fd: number, size: number): { v: ViewState; out: { off: number; e: Entry }[]; complete: number } {
  const st = fs.fstatSync(fd);
  const key = `${size}:${st.mtimeMs}`;
  let v = views.get(file);
  if (v && v.checked !== key && (v.dev !== st.dev || v.ino !== st.ino || !holds(fd, size, v.cp))) v = undefined;
  if (!v) {
    const saved = savedCp(idx);
    v = { dev: st.dev, ino: st.ino, cp: saved && holds(fd, size, saved) ? saved : ZERO(), marked: null, checked: key };
    views.set(file, v);
  }
  v.checked = key;
  if (!v.marked) {
    const got = readMarks(fd, v.cp.marks);
    if (got.some(e => !e)) { v.cp = ZERO(); v.marked = []; } // a marked line no longer parses: rebuild from byte 0
    else v.marked = Object.freeze(got as Entry[]);
  }
  const { out, next, added, complete } = scan(fd, size, v.cp);
  if (next.offset > v.cp.offset) {
    v.cp = next;
    if (added.length) v.marked = Object.freeze(v.marked.concat(added));
  }
  return { v, out, complete };
}

function readView(file: string, idx: string, { after }: { after: number }): Entry[] {
  const fd = openRead(file);
  if (fd === null) return [];
  try {
    const size = fs.fstatSync(fd).size;
    const { v, out, complete } = advance(file, idx, fd, size);
    const cp = v.cp, marks = cp.marks, marked = v.marked!;
    const res: Entry[] = [];
    // the prefix: marked lines, and (after < cp.id) every line from the first with id > after
    const from = after < cp.id ? offsetAfter(fd, cp.offset, after) : cp.offset;
    let k = 0;
    for (; k < marks.length && marks[k][1] < from; k++) res.push(marked[k]);
    if (from < cp.offset) {
      const buf = readRange(fd, from, cp.offset - from);
      let pos = 0;
      while (pos < buf.length) {
        let nl = buf.indexOf(10, pos);
        if (nl < 0) nl = buf.length;
        if (nl > pos) {
          if (k < marks.length && marks[k][1] === from + pos) res.push(marked[k++]);
          else { const e = parse(buf.subarray(pos, nl)); if (e) res.push(e); }
        }
        pos = nl + 1;
      }
    }
    for (; k < marks.length; k++) res.push(marked[k]);
    // after the checkpoint: what this call scanned past it (a break stops the checkpoint, not the reading)
    for (const { off, e } of out) if (off >= cp.offset && (!CHAT_KINDS.has(e.kind) || e.id > after)) res.push(e);
    if (size > complete) { // no newline yet; readAll() parses it too
      const e = parse(readRange(fd, complete, size - complete));
      if (e && (!CHAT_KINDS.has(e.kind) || e.id > after)) res.push(e);
    }
    return res;
  } finally { fs.closeSync(fd); }
}

function nonChat(file: string, idx: string): { marked: readonly Entry[]; rest: Entry[] } {
  const fd = openRead(file);
  if (fd === null) return { marked: [], rest: [] };
  try {
    const size = fs.fstatSync(fd).size;
    const { v, out, complete } = advance(file, idx, fd, size);
    const rest = out.filter(x => x.off >= v.cp.offset && !CHAT_KINDS.has(x.e.kind)).map(x => x.e);
    if (size > complete) { const e = parse(readRange(fd, complete, size - complete)); if (e && !CHAT_KINDS.has(e.kind)) rest.push(e); }
    return { marked: v.marked!, rest };
  } finally { fs.closeSync(fd); }
}

// ---------- writing ----------
/** The log lock's timeout: RoomError LOCK with withLock's message (RoomError itself takes the code first). */
class LockError extends RoomError { constructor(message: string) { super('LOCK', message); } }

function appendLocked(file: string, place: (tail: { newest: Iterable<Entry>; prevLine: string }) => { e: Entry; line: string }): Entry {
  return withLock(file + '.lock', () => {
    const fd = fs.openSync(file, 'a+', 0o600);
    try {
      const size = fs.fstatSync(fd).size;
      let endsNl = true;
      if (size) { const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, size - 1); endsNl = b[0] === 10; }
      const { e, line } = place(tailFrom(fd, size));
      fs.writeSync(fd, (endsNl ? '' : '\n') + line + '\n');
      return e;
    } finally { fs.closeSync(fd); }
  }, { ErrorClass: LockError });
}

const appendVerbatim = (file: string, line: string): void => fs.appendFileSync(file, line + '\n', { mode: 0o600 });

function forget(file: string): void { readCache.delete(file); views.delete(file); }

export {
  readAll, lastId, lineHash, offsetAfterId, tailer, validateChain, verifyChain, readView, nonChat, appendLocked,
  appendVerbatim, forget,
};
