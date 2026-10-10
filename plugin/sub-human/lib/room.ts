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

const pure = {
  RoomError, fold, DIGEST_CAP, TAIL_MAX, CHAT_MAX, CHAT_WRAP, CHAT_LINES_MAX, CHAT_NEST,
  hash12: store.hash12, normalize: store.normalize,
  verifyHuman: store.verifyHuman, unverifiedHuman: store.unverifiedHuman, humanTrust: store.humanTrust,
  line: render.line, tailLine: render.tailLine, chatLines: render.chatLines, FOR_CLAUDE: render.FOR_CLAUDE,
  fmt: render.fmt, who: render.who, approversOf: lanes.approversOf, lane: lanes.lane,
};

/** A Room over a RoomStore: the store's calls plus the queries and renderings that need this room's log. */
function roomOver(s) {
  const all = entries => entries || s.readAll();
  return {
    ...pure,
    code: s.code, store: s,
    append: (entry, opts) => s.append(entry, opts),
    readAll: () => s.readAll(),
    readById: ids => s.readById(ids),
    readAfter: (id, f) => s.readAfter(id, f),
    since: id => s.since(id),
    lastId: () => s.lastId(),
    readView: opts => s.readView(opts),
    watch: (onEntry, opts) => s.watch(onEntry, opts),
    tailer: opts => s.tailer(opts),
    validateChain: () => s.validateChain(),
    verifyChain: opts => s.verifyChain(opts),
    getCursor: name => s.getCursor(name),
    setCursor: (name, id) => s.setCursor(name, id),
    members: () => s.members.read(),
    stateLine: (me, entries, opts = {}) => render.stateLine(me, all(entries), { ...opts, members: s.members.read() }),
    digest: entries => render.digest(all(entries), { members: s.members.read(), code: s.code }),
    proposal: (hash, entries) => lanes.proposal(hash, all(entries)),
    proposals: entries => lanes.proposals(all(entries)),
    answers: (hash, approvers, entries) => lanes.answers(hash, approvers, all(entries)),
    answered: (name, hash, entries) => lanes.answered(name, hash, all(entries)),
    decided: (hash, entries) => lanes.decided(hash, all(entries)),
  };
}

const rooms = new Map(); // code -> {s, room}
function open(code, { store: s, dir } = {}) {
  if (s || dir) return roomOver(s || store.open(code, { dir }));
  const st = store.open(code);
  const hit = rooms.get(code);
  if (hit && hit.s === st) return hit.room;
  const r = roomOver(st);
  rooms.set(code, { s: st, room: r });
  return r;
}

module.exports = {
  ...pure,
  open,
  roomExists: store.roomExists,
};
