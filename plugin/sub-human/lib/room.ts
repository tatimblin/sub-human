/**
 * plugin/sub-human/lib/room.ts: the room log (envelope v3). A facade over lib/room/*, so callers keep one import.
 *
 *   open(code, {store, dir}?) -> Room     one room, bound by value: no process-wide state. Cached per code (not with
 *       {store} / {dir}). A long-lived process (the tail, the MCP servers) holds one per code.
 *   Room = {code, store, trust,
 *     append, readAll, readById, readAfter, lastId, readView, tailer, validateChain, verifyChain, getCursor,
 *     setCursor                                the store's (room/store.ts documents them)
 *     members() -> {name: record}              store.members.read()
 *     line(e, {full}?), chatLines(e, {viewer, entries}?), fmt(e)   render.ts, judged by this room's trust
 *     stateLine(me, entries?), digest(entries?)                    render.ts over this room's log and members
 *     fold(entries?), proposal(hash, entries?), proposals(entries?), answers(hash, approvers?, entries?),
 *     answered(name, hash, entries?), decided(hash, entries?)      consent.ts over this room's log
 *     deliver(me, e, {entries, note}?)         deliver.ts: none | context | notice | wake for seat me
 *     and the stateless helpers below}
 *   Stateless: line, chatLines, fmt, fold, deliver (each judging a person's line by trustOf: the store of the room
 *     the entry names; a caller holding the store it read from passes that store's trust instead), who, FOR_CLAUDE,
 *     normalize, hash12, approversOf, RoomError and the size caps (DIGEST_CAP, TAIL_MAX, CHAT_MAX, CHAT_WRAP,
 *     CHAT_LINES_MAX, CHAT_NEST).
 *   roomLine(store, text, log?)   a status line from the room itself (via system), best effort: what the host's
 *     people should know about invites, links and admissions (lib/remote/*)
 *   hostStore(code, {what}?) -> RoomStore   the store of a room this machine hosts; RoomError NO_ROOM / HOST_ONLY
 *
 *   room/store.ts     the RoomStore seam (trust, rules, log-io, fs-store, registry behind it)
 *   room/validate.ts  the envelope rules append() enforces; RoomError (INVALID | RATE | LOCK | NO_ROOM)
 *   room/consent.ts   fold(entries, trust): the one proposal / consent state every view reads, and its queries
 *   room/deliver.ts   deliver(me, e, state): what one entry is for one seat
 *   room/render.ts    line, fmt, who, chatLines, FOR_CLAUDE, stateLine, digest, join and leave notices
 */

import * as store from './room/store.ts';
import { RoomError } from './room/validate.ts';
import * as consent from './room/consent.ts';
import * as render from './room/render.ts';
import * as delivery from './room/deliver.ts';
import { DIGEST_CAP, TAIL_MAX, CHAT_MAX, CHAT_WRAP, CHAT_LINES_MAX, CHAT_NEST } from './config.ts';
import type { AppendOpts, Delivery, Entry, EntryInput, LaneViewer, ReadViewOpts, RoomStore, TailerFs, Trust } from './room/types.ts';
import type { DeliverState } from './room/deliver.ts';
import { msgOf } from './errors.ts';
import type { RoomCode } from './brand.ts';

type Entries = readonly Entry[];
const { trustOf } = store;

// ---------- stateless (a person's line judged by the store of the room it names) ----------
const line = (e: Entry, opts: { full?: boolean; trust?: Trust } = {}): string => render.line(e, { trust: trustOf, ...opts });
const chatLines = (e: Entry, opts: { viewer?: string; entries?: Entries; trust?: Trust } = {}): string[] => render.chatLines(e, { trust: trustOf, ...opts });
const fmt = (e: Entry, trust: Trust = trustOf): string => render.fmt(e, { trust });
const fold = (entries: Entries | null | undefined, trust: Trust = trustOf) => consent.fold(entries, trust);
const deliver = (me: LaneViewer | null | undefined, e: Entry, st: DeliverState = {}): Delivery => delivery.deliver(me, e, { trust: trustOf, ...st });
const { who, FOR_CLAUDE } = render;
const { normalize, hash12 } = store;
const { approversOf } = consent;

/** A status line from the room itself (via system), best effort: the action it reports stands either way. */
function roomLine(s: Pick<RoomStore, 'append'>, text: string, log?: (msg: string) => void): void {
  try { s.append({ kind: 'status', text }, { via: 'system', from: 'room', system: true }); } catch (e) { if (log) log(`room line: ${msgOf(e)}`); }
}

/** The store of a room this machine hosts: NO_ROOM when there is none here, HOST_ONLY when it is hosted elsewhere. */
function hostStore(code: RoomCode, { what = 'its host does this' }: { what?: string } = {}): RoomStore {
  if (!store.roomExists(code)) throw new RoomError('NO_ROOM', `no room "${code}"`);
  const s = open(code).store;
  if (!s.isHost) throw new RoomError('HOST_ONLY', `room ${code} is hosted on another machine; ${what}`);
  return s;
}

const pure = {
  RoomError, DIGEST_CAP, TAIL_MAX, CHAT_MAX, CHAT_WRAP, CHAT_LINES_MAX, CHAT_NEST, hash12, normalize, FOR_CLAUDE, who, approversOf,
};

/** A Room over a RoomStore: the store's calls plus the queries and renderings that need this room's log. */
function roomOver(s: RoomStore) {
  const trust = s.trust;
  const all = (entries?: Entries | null): Entries => entries || s.readAll();
  return {
    ...pure,
    code: s.code, store: s, trust,
    // the store's overloads (opts.queue: a mirror may answer with the queued post)
    append: ((entry: EntryInput, opts?: AppendOpts) => s.append(entry, opts)) as RoomStore['append'],
    readAll: () => s.readAll(),
    readById: (ids: Parameters<RoomStore['readById']>[0]) => s.readById(ids),
    readAfter: (id: number, f?: (e: Entry) => boolean) => s.readAfter(id, f),
    lastId: () => s.lastId(),
    readView: (opts?: ReadViewOpts) => s.readView(opts),
    /** every non-chat entry, and every line since the log's last rotation (all of it before any): a cold reader's
     * cheap view of what is recent (the status line) */
    readRecent: (): Entries => { const k = s.recentFrom(); return k > 0 ? s.readView({ after: k }) : s.readAll(); },
    tailer: (opts?: { fs?: TailerFs; after?: number }) => s.tailer(opts),
    validateChain: () => s.validateChain(),
    verifyChain: (opts?: Parameters<RoomStore['verifyChain']>[0]) => s.verifyChain(opts),
    getCursor: (name: string) => s.getCursor(name),
    setCursor: (name: string, id: number) => s.setCursor(name, id),
    members: () => s.members.read(),
    line: (e: Entry, opts: { full?: boolean } = {}) => render.line(e, { ...opts, trust }),
    chatLines: (e: Entry, opts: { viewer?: string; entries?: Entries } = {}) => render.chatLines(e, { ...opts, trust }),
    fmt: (e: Entry) => render.fmt(e, { trust }),
    stateLine: (me: LaneViewer | null | undefined, entries?: Entries | null, opts: { ids?: boolean } = {}) =>
      render.stateLine(me, all(entries), { ...opts, members: s.members.read(), trust }),
    digest: (entries?: Entries | null) => render.digest(all(entries), { members: s.members.read(), code: s.code, trust }),
    fold: (entries?: Entries | null) => consent.fold(all(entries), trust),
    proposal: (hash: string, entries?: Entries | null) => consent.proposal(hash, all(entries), trust),
    proposals: (entries?: Entries | null) => consent.proposals(all(entries), trust),
    answers: (hash: string, approvers?: string[] | null, entries?: Entries | null) => consent.answers(hash, approvers, all(entries), trust),
    answered: (name: string, hash: string, entries?: Entries | null) => consent.answered(name, hash, all(entries), trust),
    decided: (hash: string, entries?: Entries | null) => consent.decided(hash, all(entries), trust),
    deliver: (me: LaneViewer | null | undefined, e: Entry, st: Omit<DeliverState, 'trust'> = {}) => delivery.deliver(me, e, { ...st, trust }),
  };
}

/** One room: its store's calls plus the queries and renderings over its log (see the header). */
type Room = ReturnType<typeof roomOver>;

const rooms = new Map<string, { s: RoomStore; room: Room }>(); // code -> {s, room}
function open(code: RoomCode, { store: s, dir }: { store?: RoomStore; dir?: string } = {}): Room {
  if (s || dir) return roomOver(s || store.open(code, { dir }));
  const st = store.open(code);
  const hit = rooms.get(code);
  if (hit && hit.s === st) return hit.room;
  const r = roomOver(st);
  rooms.set(code, { s: st, room: r });
  return r;
}

export {
  RoomError, DIGEST_CAP, TAIL_MAX, CHAT_MAX, CHAT_WRAP, CHAT_LINES_MAX, CHAT_NEST, open, line, chatLines, fmt, fold, deliver,
  who, FOR_CLAUDE, normalize, hash12, approversOf, roomLine, hostStore, trustOf,
};
export { roomExists } from './room/store.ts';
export type { Room };
