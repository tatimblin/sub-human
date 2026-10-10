/**
 * plugin/sub-human/lib/room.ts: the room log (envelope v3). A facade over lib/room/*, so callers keep one
 * require. CommonJS, zero dependencies.
 *
 *   open(code, {store, dir}?) -> Room     (also openRoom) one room, bound by value: no process-wide state. Cached per
 *       code (not with {store} / {dir}). A long-lived process (the tail, the MCP servers) holds one per code.
 *   Room = {code, store,
 *     append, readAll, readById, readAfter, since, lastId, readView, watch, tailer, validateChain, verifyChain,
 *     getCursor, setCursor                     the store's (room/store.ts documents them)
 *     members() -> {name: record}              store.members.read()
 *     stateLine(me, entries?), digest(entries?)                    render.ts over this room's log and members
 *     proposal(hash, entries?), proposals(entries?), answers(hash, approvers?, entries?), answered(name, hash,
 *     entries?), decided(hash, entries?)       lanes.ts over this room's log
 *     lane(me, e, entries?)                    lanes.ts (entries: judged; without, the entry-only answer)
 *     and the stateless helpers below}
 *   Stateless: fold (room/consent.ts), line, tailLine, chatLines, fmt, who, FOR_CLAUDE, normalize, hash12, verifyHuman, unverifiedHuman,
 *     humanTrust, RoomError and the size caps (DIGEST_CAP, TAIL_MAX, CHAT_MAX,
 *     CHAT_WRAP, CHAT_LINES_MAX, CHAT_NEST).
 *
 *   room/store.ts     the RoomStore seam and FsRoomStore (the only module that knows the room's files)
 *   room/validate.ts  the envelope rules append() enforces; RoomError (INVALID | RATE | LOCK | NO_ROOM)
 *   room/lanes.ts     proposal queries and lane(me, e, entries?) -> push | pull | none
 *   room/render.ts    line, tailLine, fmt, who, chatLines, FOR_CLAUDE, stateLine, digest
 *   room/consent.ts   fold(entries): the one proposal / consent state every view reads
 */

import * as store from './room/store.ts';
import { RoomError } from './room/validate.ts';
import * as lanes from './room/lanes.ts';
import * as render from './room/render.ts';
import { fold } from './room/consent.ts';
import { DIGEST_CAP, TAIL_MAX, CHAT_MAX, CHAT_WRAP, CHAT_LINES_MAX, CHAT_NEST } from './config.ts';
import type { AppendOpts, Entry, EntryInput, LaneViewer, ReadViewOpts, RoomStore, TailerFs } from './room/types.ts';

const pure = {
  RoomError, fold, DIGEST_CAP, TAIL_MAX, CHAT_MAX, CHAT_WRAP, CHAT_LINES_MAX, CHAT_NEST,
  hash12: store.hash12, normalize: store.normalize,
  verifyHuman: store.verifyHuman, unverifiedHuman: store.unverifiedHuman, humanTrust: store.humanTrust,
  line: render.line, tailLine: render.tailLine, chatLines: render.chatLines, FOR_CLAUDE: render.FOR_CLAUDE,
  fmt: render.fmt, who: render.who, approversOf: lanes.approversOf, lane: lanes.lane,
};

/** A Room over a RoomStore: the store's calls plus the queries and renderings that need this room's log. */
function roomOver(s: RoomStore) {
  const all = (entries?: readonly Entry[] | null): readonly Entry[] => entries || s.readAll();
  return {
    ...pure,
    code: s.code, store: s,
    // the store's overloads (opts.queue: a mirror may answer with the queued post)
    append: ((entry: EntryInput, opts?: AppendOpts) => s.append(entry, opts)) as RoomStore['append'],
    readAll: () => s.readAll(),
    readById: (ids: Parameters<RoomStore['readById']>[0]) => s.readById(ids),
    readAfter: (id: number, f?: (e: Entry) => boolean) => s.readAfter(id, f),
    since: (id: number) => s.since(id),
    lastId: () => s.lastId(),
    readView: (opts?: ReadViewOpts) => s.readView(opts),
    watch: (onEntry: (e: Entry) => void, opts?: { after?: number; intervalMs?: number }) => s.watch(onEntry, opts),
    tailer: (opts?: { fs?: TailerFs; after?: number }) => s.tailer(opts),
    validateChain: () => s.validateChain(),
    verifyChain: (opts?: Parameters<RoomStore['verifyChain']>[0]) => s.verifyChain(opts),
    getCursor: (name: string) => s.getCursor(name),
    setCursor: (name: string, id: number) => s.setCursor(name, id),
    members: () => s.members.read(),
    stateLine: (me: LaneViewer | null | undefined, entries?: readonly Entry[] | null, opts: { ids?: boolean } = {}) =>
      render.stateLine(me, all(entries), { ...opts, members: s.members.read() }),
    digest: (entries?: readonly Entry[] | null) => render.digest(all(entries), { members: s.members.read(), code: s.code }),
    proposal: (hash: string, entries?: readonly Entry[] | null) => lanes.proposal(hash, all(entries)),
    proposals: (entries?: readonly Entry[] | null) => lanes.proposals(all(entries)),
    answers: (hash: string, approvers?: string[] | null, entries?: readonly Entry[] | null) => lanes.answers(hash, approvers, all(entries)),
    answered: (name: string, hash: string, entries?: readonly Entry[] | null) => lanes.answered(name, hash, all(entries)),
    decided: (hash: string, entries?: readonly Entry[] | null) => lanes.decided(hash, all(entries)),
  };
}

/** One room: its store's calls plus the queries and renderings over its log (see the header). */
type Room = ReturnType<typeof roomOver>;

const rooms = new Map<string, { s: RoomStore; room: Room }>(); // code -> {s, room}
function open(code: string, { store: s, dir }: { store?: RoomStore; dir?: string } = {}): Room {
  if (s || dir) return roomOver(s || store.open(code, { dir }));
  const st = store.open(code);
  const hit = rooms.get(code);
  if (hit && hit.s === st) return hit.room;
  const r = roomOver(st);
  rooms.set(code, { s: st, room: r });
  return r;
}

// The pure helpers (`pure`, spread into every Room) are also the module's own exports.
export { RoomError, fold, DIGEST_CAP, TAIL_MAX, CHAT_MAX, CHAT_WRAP, CHAT_LINES_MAX, CHAT_NEST, open };
export { hash12, normalize, verifyHuman, unverifiedHuman, humanTrust, roomExists } from './room/store.ts';
export { line, tailLine, chatLines, FOR_CLAUDE, fmt, who } from './room/render.ts';
export { approversOf, lane } from './room/lanes.ts';
export type { Room };
