/**
 * plugin/sub-human/lib/room/registry.ts: which RoomStore a room code opens, and the rooms on this machine.
 *
 *   open(code, {dir}?) -> RoomStore   cached per home and code: a room this machine links to (lib/room/links.ts) is a
 *       MirrorRoomStore (lib/room/store-mirror.ts), any other an FsRoomStore (lib/room/fs-store.ts); a link written or
 *       removed since (a handoff) gives the other kind at the next open. {dir} (and only then) gives an uncached
 *       FsRoomStore over that directory.
 *   forget(code)                 drop the cached store of room code (this home): the next open() decides its kind again
 *   setBackend(factory|null)     tests: every open() then returns factory(code)
 *   roomExists(code)             a room directory or a link; a leftover (isLeftover) is no room
 *   isLeftover(code) -> bool     a room directory with no link, no members document and no log, untouched for
 *                                LEFTOVER_MS: what a process still holding a forgotten room's seat wrote (item 9 R1),
 *                                never a room hosted here; `sub-human link CODE --forget` sets it aside
 *   setAsideLeftover(code, now?) -> path   that folder moved to rooms/CODE.forgotten-TIME
 *   createRoom(code) -> bool     private and exclusive: false when it exists already
 *   listRooms() -> [code]        every room directory (mirrors are directories too)
 *   indexedRooms() -> [code]     the rooms that may be open: <home>/open-rooms.json, kept at open (createRoom), at
 *       every seat's join (indexRoom, lib/identity.ts join) and at close (unindexRooms: lib/identity.ts drops a room once
 *       it is closed for good, every seat left and its room Claude stopped; lib/gc.ts a room it deletes). A home from
 *       before the index builds it once from every room directory. lib/identity.ts openRooms judges only these, not
 *       every room ever made.
 *   indexRoom(code), unindexRooms([code])
 *   lastChange(code) -> ms       the newest mtime among the room directory and its entries (0: no directory)
 *   setAsideRoom(code, now?) -> name   the room's directory moves to rooms/CODE.gc-TIME and its seat keys to
 *                                keys/CODE.gc-TIME, unindexed (lib/gc.ts only, for a room closed for good that nobody
 *                                touched in ROOM_GC_MS); nothing is deleted yet
 *   asideRooms() -> [{name, at}] the folders set aside: `sub-human link --forget`'s (rooms/CODE.forgotten-TIME) and
 *                                GC's (rooms/CODE.gc-TIME), by mtime
 *   removeAside(name)            delete one, with the seat keys GC set aside under the same name
 *   trustOf(e) -> HumanTrust|null   an entry judged by the store of the room it names (e.room, which every signed
 *       entry carries); an entry of no named room is judged with trust.ts NO_TRUST (never verified). A caller that
 *       read e from a store passes that store's trust instead (RoomStore.trust): this is the fallback.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { home, roomsDir, roomDir, repairModes } from '../home.ts';
import { withLock } from '../lock.ts';
import { readJson, writeJsonAtomic } from '../io.ts';
import { CODE_RE } from '../text.ts';
import { keyDir } from './keys.ts';
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
/** A just-made room has no members document or log for a moment: a folder younger than this is never a leftover. */
const LEFTOVER_MS = 60_000;
function isLeftover(c: string): boolean {
  const d = roomDir(c);
  let st: fs.Stats;
  try { st = fs.statSync(d); } catch { return false; }
  if (!st.isDirectory() || Date.now() - st.mtimeMs < LEFTOVER_MS || linked(c)) return false;
  return !['members.json', 'log.jsonl', 'snapshot.json', 'snapshot-base.json', 'log-0001.jsonl'].some(f => fs.existsSync(path.join(d, f)));
}
const roomExists = (c: unknown): boolean => typeof c === 'string' && CODE_RE.test(c) && ((fs.existsSync(roomDir(c)) && !isLeftover(c)) || linked(c));
function createRoom(c: string): boolean {
  fs.mkdirSync(roomsDir(), { recursive: true, mode: 0o700 }); // the home and rooms/ too when new: private
  repairModes();
  try { fs.mkdirSync(roomDir(c), { mode: 0o700 }); } catch (e) { if (errCode(e) === 'EEXIST') return false; throw e; }
  indexRoom(c);
  return true;
}
const listRooms = (): string[] => { try { return fs.readdirSync(roomsDir()).filter(c => CODE_RE.test(c)); } catch { return []; } };

// ---------- the open-rooms index ----------
/** <home>/open-rooms.json: {v: 1, rooms: {code: when it was indexed}}. */
interface RoomIndex { v: 1; rooms: Record<string, string> }
const indexFile = (): string => path.join(home(), 'open-rooms.json');
const readIndex = (): RoomIndex | null => {
  const x = readJson(indexFile()) as RoomIndex | null;
  return x && x.v === 1 && x.rooms && typeof x.rooms === 'object' && !Array.isArray(x.rooms) ? x : null;
};
/** Change the index under its lock (built from every room directory when there is none yet). fn: false writes nothing. */
function updateIndex(fn: (rooms: Record<string, string>) => boolean): Record<string, string> {
  fs.mkdirSync(home(), { recursive: true, mode: 0o700 });
  return withLock(indexFile() + '.lock', () => {
    const cur = readIndex();
    const rooms = cur ? { ...cur.rooms } : Object.fromEntries(listRooms().map(c => [c, new Date().toISOString()]));
    if (fn(rooms) || !cur) writeJsonAtomic(indexFile(), { v: 1, rooms }, { compact: true });
    return rooms;
  });
}
function indexedRooms(): string[] {
  const cur = readIndex();
  return Object.keys(cur ? cur.rooms : updateIndex(() => false)).filter(c => CODE_RE.test(c)).sort();
}
function indexRoom(c: string): void {
  if (!CODE_RE.test(c) || (readIndex()?.rooms || {})[c]) return;
  updateIndex(rooms => { if (rooms[c]) return false; rooms[c] = new Date().toISOString(); return true; });
}
function unindexRooms(codes: readonly string[]): void {
  if (!codes.length) return;
  updateIndex(rooms => { let n = 0; for (const c of codes) if (rooms[c]) { delete rooms[c]; n++; } return n > 0; });
}

// ---------- deleting a closed room (lib/gc.ts) ----------
function lastChange(c: string): number {
  const d = roomDir(c);
  let t: number;
  try { t = fs.statSync(d).mtimeMs; } catch { return 0; }
  let names: string[] = [];
  try { names = fs.readdirSync(d); } catch { /* unreadable: the directory's own */ }
  for (const n of names) { try { t = Math.max(t, fs.statSync(path.join(d, n)).mtimeMs); } catch { /* gone meanwhile */ } }
  return t;
}
/**
 * Set a room aside (lib/gc.ts): its directory becomes rooms/CODE.gc-TIME and its seat keys keys/CODE.gc-TIME (still
 * under keys/, which the Read guard covers), both touched now so that the aside TTL counts from today. A person can
 * rename both back to bring the room back; removeAside deletes them after the aside TTL.
 */
function setAsideRoom(c: string, now = Date.now()): string {
  const name = `${c}.gc-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
  const to = path.join(roomsDir(), name);
  fs.renameSync(roomDir(c), to);
  const kd = keyDir(c);
  if (fs.existsSync(kd)) fs.renameSync(kd, path.join(path.dirname(kd), name));
  const t = new Date(now);
  try { fs.utimesSync(to, t, t); } catch { /* the aside TTL then counts from the room's last change */ }
  unindexRooms([c]);
  forget(c);
  return name;
}
/** A leftover folder (isLeftover) set aside as a forgotten copy is: rooms/CODE.forgotten-TIME; its absolute path. */
function setAsideLeftover(c: string, now = Date.now()): string {
  const to = path.join(roomsDir(), `${c}.forgotten-${new Date(now).toISOString().replace(/[:.]/g, '-')}`);
  fs.renameSync(roomDir(c), to);
  forget(c);
  return to;
}
const ASIDE_RE = /^[a-z]+-\d{4}\.(?:forgotten|gc)-[0-9TZ-]+$/;
function asideRooms(): { name: string; at: number }[] {
  let names: string[] = [];
  try { names = fs.readdirSync(roomsDir()); } catch { return []; }
  const out: { name: string; at: number }[] = [];
  for (const name of names.filter(n => ASIDE_RE.test(n))) { try { out.push({ name, at: fs.statSync(path.join(roomsDir(), name)).mtimeMs }); } catch { /* gone */ } }
  return out;
}
/** Delete one set-aside folder, and the seat keys a GC set aside with it. */
function removeAside(name: string): void {
  if (!ASIDE_RE.test(name)) return;
  fs.rmSync(path.join(roomsDir(), name), { recursive: true, force: true });
  fs.rmSync(path.join(home(), 'keys', name), { recursive: true, force: true });
}

function trustOf(e: Entry | null | undefined): HumanTrust | null {
  if (!e || e.via !== 'human') return null;
  if (typeof e.room !== 'string' || !CODE_RE.test(e.room)) return NO_TRUST(e);
  try { return open(e.room).trust(e); } catch { return NO_TRUST(e); }
}

export {
  open, forget, setBackend, roomExists, isLeftover, setAsideLeftover, createRoom, listRooms, trustOf, indexedRooms, indexRoom, unindexRooms, lastChange,
  setAsideRoom, asideRooms, removeAside,
};
