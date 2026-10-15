/**
 * plugin/sub-human/lib/room/snapshot.ts: a log's snapshot, pure (no I/O; lib/room/log-io.ts reads and writes
 * <room>/snapshot.json, lib/room/store-mirror.ts checks the one a host sends). A snapshot stands for the sealed lines
 * of a log: the chain head after them (id, hash, the line itself, count), every non-chat entry among them (what the
 * consent fold, the tasks, the join and leave notices and the pinned keys are read from), the window of their last
 * entries a placement still needs (rate buckets, and nonces: a payload replayed after the rotation is refused as it
 * was before it), and the pins and host those entries give.
 *
 *   WINDOW_MS                              max(RATE_WINDOW_MS, 2 * SIG_SKEW_MS): how far back rules.ts scanTail looks
 *   windowItem(e) -> WindowItem            the fields scanTail reads: id, at, from, via, to, nonce
 *   extend(prev, {nonChat, recent, line, lines}) -> SnapshotWire   prev (null: none) followed by one more stretch of
 *       the log: its non-chat entries, its entries from the newest back to at least WINDOW_MS before its last
 *       (recent, in log order), its last line verbatim, and how many lines it holds
 *   derive(entries) -> {pins, host}        what a snapshot's entries give (first member_joined key per name; the last
 *                                          host_changed)
 *   problem(wire) -> {code, reason} | null  why a snapshot from another machine cannot be taken: PROTOCOL for a
 *       malformed one, FORK for one whose line does not hash to its hash, or whose pins or host are not what its
 *       entries give. Never repaired: the mirror stops (lib/remote/link.ts)
 *   toWire(snap) -> SnapshotWire           the fields the wire carries (no segment bookkeeping)
 */

import { RATE_WINDOW_MS, SNAPSHOT_WINDOW_MAX } from '../config.ts';
import { hash12 } from '../text.ts';
import { SIG_SKEW_MS, parseKey } from './envelope.ts';
import { CHAT_KINDS, hostStep } from './rules.ts';
import type { Entry, HostState, LogSnapshot, SnapshotWire, WindowItem } from './types.ts';

const WINDOW_MS = Math.max(RATE_WINDOW_MS, 2 * SIG_SKEW_MS);

function windowItem(e: Entry | WindowItem): WindowItem {
  const w: WindowItem = { id: e.id, at: e.at, from: e.from };
  if (typeof e.via === 'string') w.via = e.via;
  if (typeof e.to === 'string') w.to = e.to;
  if (typeof e.nonce === 'string') w.nonce = e.nonce;
  return w;
}

/** pins and host carried over more entries: the first member_joined key per name pins it; host_changed moves the host. */
function carry(pins: Record<string, string>, host: HostState, es: readonly Entry[]): { pins: Record<string, string>; host: HostState } {
  let p = pins;
  for (const e of es) {
    host = hostStep(host, e);
    if (e.kind !== 'member_joined' || e.via !== 'system' || typeof e.from !== 'string' || Object.hasOwn(p, e.from)) continue;
    if (!parseKey(e.pubkey)) continue;
    if (p === pins) p = { ...pins };
    p[e.from] = e.pubkey as string; // parseKey took it: a string
  }
  return { pins: p, host };
}
const derive = (entries: readonly Entry[]): { pins: Record<string, string>; host: HostState } => carry({}, { epoch: 0 }, entries);

function extend(prev: SnapshotWire | null, { nonChat, recent, line, lines }: { nonChat: readonly Entry[]; recent: readonly (Entry | WindowItem)[]; line: string; lines: number }): SnapshotWire {
  const last = JSON.parse(line) as Entry;
  const { pins, host } = carry(prev ? prev.pins : {}, prev ? prev.host : { epoch: 0 }, nonChat);
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
    host,
  };
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const isId = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const sortedHost = (h: HostState): HostState => Object.fromEntries(Object.entries(h).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1))) as HostState;

function problem(w: unknown): { code: 'PROTOCOL' | 'FORK'; reason: string } | null {
  const bad = (reason: string) => ({ code: 'PROTOCOL' as const, reason: `the host sent a snapshot that ${reason}` });
  if (!isObj(w)) return bad('is not an object');
  if (!isId(w.id) || typeof w.hash !== 'string' || typeof w.line !== 'string' || !Number.isInteger(w.count) || (w.count as number) < 1) return bad('has no chain head');
  if (!Array.isArray(w.entries) || !Array.isArray(w.window) || !isObj(w.pins) || !isObj(w.host)) return bad('is missing its entries, window, pins or host');
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
  if (!same(sortedHost(d.host), sortedHost(w.host as unknown as HostState))) return { code: 'FORK', reason: 'the host\'s snapshot names a host its entries do not' };
  return null;
}

const toWire = ({ id, hash, line, count, entries, window, pins, host }: LogSnapshot | SnapshotWire): SnapshotWire => ({ id, hash, line, count, entries, window, pins, host });

export { WINDOW_MS, windowItem, extend, derive, problem, toWire };
