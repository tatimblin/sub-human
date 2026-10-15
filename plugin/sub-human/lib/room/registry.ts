/**
 * plugin/sub-human/lib/room/registry.ts: which RoomStore a room code opens, and the rooms on this machine.
 *
 *   open(code, {dir}?) -> RoomStore   cached per home and code: a room this machine links to (lib/room/links.ts) is a
 *       MirrorRoomStore (lib/room/store-mirror.ts), any other an FsRoomStore (lib/room/fs-store.ts); a link written or
 *       removed since (a handoff) gives the other kind at the next open. {dir} (and only then) gives an uncached
 *       FsRoomStore over that directory.
 *   forget(code)                 drop the cached store of room code (this home): the next open() decides its kind again
 *   setBackend(factory|null)     tests: every open() then returns factory(code)
 *   roomExists(code)             a room directory or a link
 *   createRoom(code) -> bool     private and exclusive: false when it exists already
 *   listRooms() -> [code]        every room directory (mirrors are directories too)
 *   trustOf(e) -> HumanTrust|null   an entry judged by the store of the room it names (e.room, which every signed
 *       entry carries); an entry of no named room is judged with trust.ts NO_TRUST (never verified). A caller that
 *       read e from a store passes that store's trust instead (RoomStore.trust): this is the fallback.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { home, roomsDir, roomDir, repairModes } from '../home.ts';
import { CODE_RE } from '../text.ts';
import { FsRoomStore } from './fs-store.ts';
import { NO_TRUST } from './trust.ts';
import type { Entry, HumanTrust, RoomStore } from './types.ts';

const require = createRequire(import.meta.url);
const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;

let backend: ((code: string) => RoomStore) | null = null; // tests: code -> RoomStore
const stores = new Map<string, RoomStore>(); // home \0 code -> FsRoomStore | MirrorRoomStore
/** A room hosted elsewhere: the link registry knows it (required here, not at load: links.ts reads this module's rooms). */
const linked = (c: string): boolean => (require('./links.ts') as typeof import('./links.ts')).has(c);

function open(c: string, { dir }: { dir?: string } = {}): RoomStore {
  if (backend) return backend(c);
  if (dir) return new FsRoomStore(c, { dir });
  const k = `${home()}\0${c}`;
  let s = stores.get(k);
  if (!s || s.isHost === linked(c)) { // none yet, or a handoff wrote or removed the link since
    repairModes(); // a home an older version made 0755 (once per home and process)
    const mirror: typeof import('./store-mirror.ts') | null = linked(c) ? require('./store-mirror.ts') : null;
    s = mirror ? new mirror.MirrorRoomStore(c) : new FsRoomStore(c);
    stores.set(k, s);
  }
  return s;
}
const forget = (c: string): void => { stores.delete(`${home()}\0${c}`); };
const setBackend = (fn: ((code: string) => RoomStore) | null | undefined): void => { backend = typeof fn === 'function' ? fn : null; };
const roomExists = (c: unknown): boolean => typeof c === 'string' && CODE_RE.test(c) && (fs.existsSync(roomDir(c)) || linked(c));
function createRoom(c: string): boolean {
  fs.mkdirSync(roomsDir(), { recursive: true, mode: 0o700 }); // the home and rooms/ too when new: private
  repairModes();
  try { fs.mkdirSync(roomDir(c), { mode: 0o700 }); return true; } catch (e) { if (errCode(e) === 'EEXIST') return false; throw e; }
}
const listRooms = (): string[] => { try { return fs.readdirSync(roomsDir()).filter(c => CODE_RE.test(c)); } catch { return []; } };

function trustOf(e: Entry | null | undefined): HumanTrust | null {
  if (!e || e.via !== 'human') return null;
  if (typeof e.room !== 'string' || !CODE_RE.test(e.room)) return NO_TRUST(e);
  try { return open(e.room).trust(e); } catch { return NO_TRUST(e); }
}

export { open, forget, setBackend, roomExists, createRoom, listRooms, trustOf };
