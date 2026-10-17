/**
 * plugin/sub-human/lib/room/snapshot.ts: a log's snapshot, pure (no I/O; lib/room/log-io.ts reads and writes
 * <room>/snapshot.json, lib/room/store-mirror.ts checks the one a host sends). A snapshot stands for the sealed lines
 * of a log: the chain head after them (id, hash, the line itself, count), every non-chat entry among them (what the
 * consent fold, the tasks, the join and leave notices and the pinned keys are read from), the window of their last
 * entries a placement still needs (rate buckets, and nonces: a payload replayed after the rotation is refused as it
 * was before it), and the pins those entries give.
 *
 *   WINDOW_MS                              max(RATE_WINDOW_MS, 2 * SIG_SKEW_MS): how far back rules.ts scanTail looks
 *   windowItem(e) -> WindowItem            the fields scanTail reads: id, at, from, via, to, nonce
 *   extend(prev, {nonChat, recent, line, lines}) -> SnapshotWire   prev (null: none) followed by one more stretch of
 *       the log: its non-chat entries, its entries from the newest back to at least WINDOW_MS before its last
 *       (recent, in log order), its last line verbatim, and how many lines it holds
 *   derive(entries) -> {pins}              what a snapshot's entries give (first member_joined key per name)
 *   problem(wire) -> {code, reason} | null  why a snapshot from another machine cannot be taken: PROTOCOL for a
 *       malformed one, FORK for one whose line does not hash to its hash, or whose pins are not what its
 *       entries give. Never repaired: the mirror stops (lib/remote/link.ts)
 *   toWire(snap) -> SnapshotWire           the fields the wire carries (no segment bookkeeping)
 *   asEntry(v) -> Entry | null             a parsed log line as an entry: any object (what every log reader has always
 *                                          taken; lines are checked when placed and hash-chained, and each reader
 *                                          checks the fields it uses)
 *   decodeEntry(v) -> Entry | null         the same, with an id (a positive integer): the line a snapshot ends at, a
 *                                          host's line for a mirror
 */

import { RATE_WINDOW_MS, SNAPSHOT_WINDOW_MAX } from '../config.ts';
import { hash12 } from '../text.ts';
import { SIG_SKEW_MS, parseKey } from './envelope.ts';
import { CHAT_KINDS } from './rules.ts';
import { decode, isObj, objAs } from '../decode.ts';
import type { Entry, LogSnapshot, SnapshotWire, WindowItem } from './types.ts';

const WINDOW_MS: number = Math.max(RATE_WINDOW_MS, 2 * SIG_SKEW_MS);

function windowItem(e: Entry | WindowItem): WindowItem {
  const w: WindowItem = { id: e.id, at: e.at, from: e.from };
  if (typeof e.via === 'string') w.via = e.via;
  if (typeof e.to === 'string') w.to = e.to;
  if (typeof e.nonce === 'string') w.nonce = e.nonce;
  return w;
}

/** pins carried over more entries: the first member_joined key per name pins it. */
function carry(pins: Record<string, string>, es: readonly Readonly<Entry>[]): { pins: Record<string, string> } {
  let p = pins;
  for (const e of es) {
    if (e.kind !== 'member_joined' || e.via !== 'system' || typeof e.from !== 'string' || Object.hasOwn(p, e.from)) continue;
    if (!parseKey(e.pubkey)) continue;
    if (p === pins) p = { ...pins };
    p[e.from] = e.pubkey as string; // parseKey took it: a string
  }
  return { pins: p };
}
const derive = (entries: readonly Readonly<Entry>[]): { pins: Record<string, string> } => carry({}, entries);

function extend(prev: SnapshotWire | null, { nonChat, recent, line, lines }: { nonChat: readonly Readonly<Entry>[]; recent: readonly (Entry | WindowItem)[]; line: string; lines: number }): SnapshotWire {
  const last = decodeEntry(JSON.parse(line));
  if (!last) throw new TypeError('extend: the last line is not an entry'); // the store's own line: never
  const { pins } = carry(prev ? prev.pins : {}, nonChat);
  const since = Date.parse(last.at) - WINDOW_MS;
  const fresh = (w: WindowItem) => !(Date.parse(w.at) < since); // an unreadable at stays: the scan stops at it anyway
  const window = [...(prev ? prev.window : []), ...recent.map(windowItem)].filter(fresh);
  return {
    id: last.id,
    hash: hash12(line),
    line,
    count: (prev ? prev.count : 0) + lines,
    entries: [...(prev ? prev.entries : []), ...nonChat],
    window: window.length > SNAPSHOT_WINDOW_MAX ? window.slice(-SNAPSHOT_WINDOW_MAX) : window,
    pins,
  };
}

const isId = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function problem(w: unknown): { code: 'PROTOCOL' | 'FORK'; reason: string } | null {
  const bad = (reason: string) => ({ code: 'PROTOCOL' as const, reason: `the host sent a snapshot that ${reason}` });
  if (!isObj(w)) return bad('is not an object');
  if (!isId(w.id) || typeof w.hash !== 'string' || typeof w.line !== 'string' || !Number.isInteger(w.count) || (w.count as number) < 1) return bad('has no chain head');
  if (!Array.isArray(w.entries) || !Array.isArray(w.window) || !isObj(w.pins)) return bad('is missing its entries, window or pins');
  let head: unknown;
  try { head = JSON.parse(w.line); } catch { return bad('carries a line that is not JSON'); }
  if (!isObj(head) || head.id !== w.id) return { code: 'FORK', reason: `the host's snapshot line is not its line ${w.id}` };
  if (hash12(w.line) !== w.hash) return { code: 'FORK', reason: `the host's snapshot line ${w.id} does not hash to its chain head` };
  let prev = 0;
  for (const e of w.entries as unknown[]) {
    if (!isObj(e) || !isId(e.id) || e.id <= prev || e.id > w.id || typeof e.kind !== 'string' || CHAT_KINDS.has(e.kind)) return bad('holds an entry out of order, after its head, or a chat entry');
    prev = e.id;
  }
  for (const x of w.window as unknown[]) if (!isObj(x) || !isId(x.id) || x.id > w.id || typeof x.at !== 'string' || typeof x.from !== 'string') return bad('has a window entry that is not one');
  const d = derive(w.entries as Entry[]);
  if (!same(Object.entries(d.pins).sort(), Object.entries(w.pins).sort())) return { code: 'FORK', reason: 'the host\'s snapshot pins keys its entries do not' };
  return null;
}

const toWire = ({ id, hash, line, count, entries, window, pins }: LogSnapshot | SnapshotWire): SnapshotWire => ({ id, hash, line, count, entries, window, pins });

// a log line: placed checked (validate.ts) and hash-chained; each reader checks the fields it uses
const ENTRY = objAs<Entry>();
const asEntry = (v: unknown): Entry | null => decode(ENTRY, v);
const decodeEntry = (v: unknown): Entry | null => (isObj(v) && isId(v.id) ? decode(ENTRY, v) : null);

export { WINDOW_MS, windowItem, extend, derive, problem, toWire, asEntry, decodeEntry };
