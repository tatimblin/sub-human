/**
 * plugin/sub-human/test/support/fs-store.ts: a store, asserted to be the one on this machine's disk.
 *
 *   fsStore(s) -> FsRoomStore    s narrowed (its logFile and dir), in place of `as FsRoomStore`; the test fails
 *                                when s is another store (a mirror, the thread bridge's)
 */
import assert from 'node:assert/strict';
import { FsRoomStore } from '../../lib/room/store.ts';
import type { RoomStore } from '../../lib/room/types.ts';

export function fsStore(s: RoomStore | null | undefined): FsRoomStore {
  assert.ok(s instanceof FsRoomStore, 'expected the fs store');
  return s;
}
