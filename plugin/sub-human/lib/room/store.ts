/**
 * plugin/sub-human/lib/room/store.ts: the RoomStore seam: the interface every store implements, and the one import the
 * rest of the plugin takes the store from. The store is these files behind it:
 *   trust.ts     whether a via=human entry is the person's (verify against keys passed in; no I/O)
 *   rules.ts     what a placement checks and stamps (toPayload, admit, placeAfter, scanTail, checkSigned, checkHere;
 *                pure), and the legacy display mapping (normalize)
 *   log-io.ts    the log's bytes, in segments with a snapshot (only fs-store.ts imports it)
 *   snapshot.ts  a log's snapshot: what the sealed lines give (pure; the mirror checks the host's with it)
 *   fs-store.ts  FsRoomStore: a room directory on this machine (the only module that knows its file names)
 *   registry.ts  which store a code opens (open, setBackend) and the rooms on this machine; keys.ts the seats' keys
 * plus store-mirror.ts (MirrorRoomStore, a room hosted elsewhere: it composes an FsRoomStore over its mirror
 * directory). Nothing outside lib/room/ knows where a room's files are or what they are called
 * (test/store-bypass.node-test.ts checks it); test/support/memory-store.ts is a second store, and
 * test/store-contract.node-test.ts runs the same suite over four backends.
 * `from` is passed in by trusted callers that resolved identity first (lib/identity.ts); it is never taken from
 * env or from the model.
 *
 * RoomStore (one room; get one with open(code)):
 *   code                                    the room code
 *   append(entry, {via, from, system}) -> Entry
 *       = place(toPayload(code, entry, opts), opts): validate() (validate.ts), then sign a via=human entry with the
 *       seat's key: the process must have installed a signer (trust.ts SIGNER, set by hooks/seat-key.ts arm(), which
 *       only the hook handlers that sign run; never the MCP server or the CLI). The payload then carries room, nonce,
 *       ts, sigv and sig (sig v2, lib/room/envelope.ts). No signer, or no key for (room, from) -> RoomError INVALID.
 *       Throws RoomError INVALID | RATE | AUTH | LOCK | NO_ROOM | STALE.
 *   place(payload, {system}) -> Entry
 *       the server half: rules.ts admit() (validate() again, the stored form rebuilt), then, atomically, rules.ts
 *       placeAfter: host (a log that says the room moved to another machine takes no more lines, STALE), rate (per
 *       `from` per RATE_WINDOW_MS: RATE_MAX agent posts to the room, RATE_ADDRESSED_MAX per (from, to), RATE_HUMAN_MAX
 *       of a person's own entries: RATE), replay (a nonce already placed: AUTH), trust (a via=human payload must be
 *       v2, for this room, ts within SIG_SKEW_MS, and verify against the key pinned for from: AUTH; a member_joined
 *       pubkey that differs from the key pinned for that name: AUTH), then id (monotonic), at, prev (hash12 of the
 *       previous line). A line over LOG_LINE_MAX_BYTES is refused (INVALID).
 *   trust(e) -> 'verified' | 'legacy' | 'unverified' | null   whether e (read from this store) is the person's
 *                                           (trust.ts verdict over this room's keys; null when not via=human). Pass
 *                                           it on wherever entries are judged or shown: the consent fold counts only
 *                                           verified and legacy answers, render marks the rest "(unverified)"
 *   pins() -> Map name -> KeyObject         the keys pinned in this room's log (the first member_joined pubkey per
 *                                           name), carried forward one new line at a time
 *   hostState() -> {epoch, host?, machine?, locator?, id?}   who holds the room by its log: the last host_changed
 *                                           entry (lib/handoff.ts), epoch 0 and nothing else before any
 *   setAside() -> string | null             move this room's log aside to orphaned-<time>.jsonl in its directory
 *                                           (and drop its checkpoint and members document): a demoted old host's
 *                                           lines, kept and never merged. The file's path, null with no log
 *   readAll() -> readonly Readonly<Entry>[]           every parseable entry, in order (legacy lines included). The store's
 *                                           cached array: never change it, nor the entries in it
 *   readById(ids), readAfter(id, filter?), lastId()
 *   readView({after}) -> readonly Readonly<Entry>[]   non-chat entries + entries with id > after: what a hook judges delivery
 *                                           against, the same answer as readAll() for the entries after `after`
 *                                           (after <= 0: readAll(); Infinity: non-chat only)
 *   recentFrom() -> id                      the snapshot's id (0 before any rotation): readView({after: it}) reads
 *                                           only the newest segment past the snapshot (room.ts readRecent)
 *   snapshot() -> SnapshotWire & {held} | null   the log's snapshot (FsRoomStore: <room>/snapshot.json, written at
 *                                           each rotation; lib/room/log-io.ts): what the subscribe stream sends a
 *                                           new mirror instead of every line (lib/remote/server.ts); held: the first
 *                                           id this store holds the line of
 *   tailer({fs, after}?) -> {poll() -> {entries, lines, reset}}   entries appended after the moment it was made
 *                                           (after: an id, from the first line after it instead); lines: the same
 *                                           lines as stored, verbatim (what the remote server streams). fs: test hook
 *   lineHash(id) -> string | null           hash12 of the stored line with that id (the next line's prev; id 0:
 *                                           hash12(''), the empty log), null when the log has no such line
 *   validateChain() -> {ok, count, badAt?, line?}   the whole prev chain
 *   verifyChain({fromOffset, prev}?) -> {ok, count, checked, offset, id, hash, from, badAt?, line?}
 *       incremental, from this process's checkpoint (in memory), which it advances over the newest segment (the
 *       snapshot vouches for the sealed ones: a segment is sealed only once it chains)
 *   getCursor(reader) -> id, setCursor(reader, id)           per-reader positions
 *   isHost -> bool                          this machine holds the room (FsRoomStore: true). Only there do the
 *                                           room Claude's spawn, reap and watchdog and proposal decisions run.
 *   members.read() -> {name: record}; members.update(fn) -> written | null
 *       fn(current) returns the next object to store, or null/undefined to store nothing. Atomic: under a lock
 *       here, a compare-and-set retry loop for a remote store, so fn may run more than once (side effects in it
 *       must be idempotent). The room Claude's bookkeeping (lib/room-claude.ts); a seat changes through the named ops:
 *   members.join(rec) -> {ok, rejoin?, error?}, members.leave(name, {reason, deadlineMs}?) -> bool,
 *   members.beat(name, {presence?}) -> bool
 *       lib/room/members.ts ops (the same rules for every store; beat also writes presence/<name>). On a mirror
 *       (lib/room/store-mirror.ts) they are the host's join, leave and beat ops: the host logs the join (with the
 *       seat's key and a proof the hook's signer makes) and the leave (with its reason).
 *   blobs.put(name, bytes) -> ref, get(ref) -> Buffer|null, has(ref), ref(pathOrRef) -> ref|null,
 *   blobs.localPath(ref) -> string|null    name/ref: "plans/<hash>.md" (room-relative). get/has/ref also take the
 *       absolute path older proposal entries stored. localPath: a file a person can open (null off-machine).
 *   kv.get(key, fallback?), kv.set(key, value, {compact}?), kv.update(key, fn, {compact, timeoutMs, staleMs}?),
 *   kv.delete(key), kv.list(prefix) -> [key], kv.lock(key, fn, opts?)
 *       small derived documents: tasks, presence/NAME, rows/*, members/NAME/session (lib/room/session.ts).
 *       update: fn(current|null) -> next (undefined: no write, null: delete), atomic like members.update.
 *   lock(name, fn, opts?)                   a room-wide mutex (the proposal answer lock)
 *   exists() -> bool
 *
 * Rooms (registry.ts): open(code, {dir}?), forget(code), setBackend(factory|null), roomExists(code), isLeftover(code), createRoom(code),
 *   listRooms(), the open-rooms index (indexedRooms, indexRoom, unindexRooms), lastChange(code), setAsideRoom(code),
 *   asideRooms(), removeAside(name) (lib/gc.ts), trustOf(e) (an entry judged by the store of the room it names: the fallback for a caller that does
 *   not have the store it read e from).
 * Keys (keys.ts, trust.ts): keyDir(code), pubPath(name, code), SIGNER, humanKey(code, name), publicKey(name, store).
 * Rules (rules.ts): toPayload, admit, placeAfter, hostState, normalize, blobRef, checkKey, checkCursor, CHAT_KINDS, hash12.
 */

import * as keys from './keys.ts';
import * as trust from './trust.ts';
import type { KeyObject } from 'node:crypto';
import type { RoomStore } from './types.ts';

/** The key name's entries in store s verify against (trust.ts publicKey over s's keys). */
const publicKey = (name: string, s: Pick<RoomStore, 'code' | 'pins'>): KeyObject | null => trust.publicKey(name, {
  code: s.code, pins: () => s.pins(), localKey: n => keys.localKey(n, s.code), hasLocalKey: n => keys.hasLocalKey(n, s.code),
});

export {
  open, forget, setBackend, roomExists, isLeftover, setAsideLeftover, createRoom, listRooms, trustOf, indexedRooms, indexRoom, unindexRooms, lastChange,
  setAsideRoom, asideRooms, removeAside,
} from './registry.ts';
export { FsRoomStore } from './fs-store.ts';
export {
  RoomError, toPayload, admit, placeAfter, hostState, normalize, blobRef, checkKey, checkCursor, CHAT_KINDS, hash12,
} from './rules.ts';
export { SIGNER, humanKey, trustOver, NO_TRUST } from './trust.ts';
export { keyDir, pubPath, localKey, hasLocalKey } from './keys.ts';
export { publicKey };
