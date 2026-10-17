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
 * RoomStore (types.ts; one room, get one with open(code)). What the shapes there do not say:
 *   append = place(toPayload(...)): validate() (validate.ts), then sign a via=human entry with the seat's key. The
 *       process must have installed a signer (trust.ts SIGNER, set by hooks/seat-key.ts arm(), which only the hook
 *       handlers that sign run; never the MCP server or the CLI). No signer, or no key for (room, from): INVALID.
 *   place, the server half: rules.ts admit() (validate() again), then atomically rules.ts placeAfter, in order:
 *       rate (per `from` per RATE_WINDOW_MS:
 *       RATE_MAX agent posts, RATE_ADDRESSED_MAX per (from, to), RATE_HUMAN_MAX of a person's own: RATE), replay (a
 *       nonce already placed: AUTH), trust (a via=human payload must be v2, for this room, ts within SIG_SKEW_MS and
 *       verify against the key pinned for from; a member_joined pubkey that differs from the pinned one: AUTH), then
 *       id (monotonic), at, prev (hash12 of the previous line). A line over LOG_LINE_MAX_BYTES: INVALID.
 *   trust: pass it on wherever entries are judged or shown: the consent fold counts only verified and legacy
 *       answers, render marks the rest "(unverified)".
 *   setAside moves the log to orphaned-<time>.jsonl (dropping checkpoint and members document): a forgotten copy's
 *       lines, kept and never merged.
 *   readView({after}) is what a hook judges delivery against: the same answer as readAll() for entries after `after`.
 *   pins: the first member_joined pubkey per name. lineHash(0) is hash12(''), the empty log.
 *   tailer lines are the stored lines verbatim (what the remote server streams).
 *   verifyChain is incremental from this process's in-memory checkpoint over the newest segment (the snapshot
 *       vouches for the sealed ones: a segment is sealed only once it chains).
 *   isHost: only there do the room Claude's spawn, reap and watchdog and proposal decisions run.
 *   members.update / kv.update are atomic: a lock here, a compare-and-set retry loop for a remote store, so fn may
 *       run more than once (side effects in it must be idempotent). A seat changes through join, leave and beat
 *       (lib/room/members.ts, the same rules for every store); on a mirror they are the host's ops, and the host logs
 *       the join (with the seat's key and a proof the hook's signer makes) and the leave (with its reason).
 *   blobs get/has/ref/localPath take a ref `plans/NAME` only (rules.ts blobRef); anything else, an absolute path
 *       included, is null. localPath is null off-machine.
 *   lock(name, fn) is a room-wide mutex (the proposal answer lock).
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
  RoomError, toPayload, admit, placeAfter, normalize, blobRef, checkKey, checkCursor, CHAT_KINDS, hash12,
} from './rules.ts';
export { SIGNER, humanKey, trustOver, NO_TRUST } from './trust.ts';
export { keyDir, pubPath, localKey, hasLocalKey } from './keys.ts';
export { publicKey };
