/**
 * plugin/sub-human/lib/room/registry.ts: which RoomStore a room code opens, and the rooms on this machine.
 *
 *   open(code) is cached per home and code: a room this machine links to (lib/room/links.ts) is a MirrorRoomStore,
 *       any other an FsRoomStore; a link written or removed since (a join, a forget) gives the other kind at the next open.
 *       The first open per home and process, and createRoom, close a home left open to group or others to 0700
 *       (lib/home.ts repairModes): opening a room and joining one both come through here.
 *       {dir} (and only then) gives an uncached FsRoomStore over that directory. forget(code) drops the cached one.
 *   isLeftover: a room directory with no link, no members document and no log, made more than LEFTOVER_MS ago: what
 *       a process still holding a forgotten room's seat wrote, never a room hosted here (roomExists says no; `sub-human
 *       link CODE --forget` sets it aside as rooms/CODE.forgotten-TIME).
 *   indexedRooms: the rooms that may be open, <home>/open-rooms.json, kept at createRoom, at every seat's join
 *       (lib/identity.ts) and at close (unindexRooms: lib/identity.ts once a room is closed for good, lib/gc.ts a room
 *       it deletes). A home without the index builds it once from every room directory. lib/identity.ts openRooms
 *       judges only these, not every room ever made.
 *   trustOf(e): an entry judged by the store of the room it names (e.room, which every signed entry carries; none:
 *       NO_TRUST, never verified). A caller that read e from a store passes that store's trust instead: this is the
 *       fallback.
 */

import fs from 'node:fs';
import path from 'node:path';
import { home, roomsDir, roomDir, repairModes } from '../home.ts';
import { withLock } from '../lock.ts';
import { readJsonRaw, writeJsonAtomic, lazy } from '../io.ts';
import { isObj } from '../decode.ts';
import { errCode } from '../errors.ts';
import { isRoomCode } from '../text.ts';
import { keyDir } from './keys.ts';
import { FsRoomStore } from './fs-store.ts';
import { NO_TRUST } from './trust.ts';
import type { Entry, HumanTrust, RoomStore } from './types.ts';
import type { RoomCode } from '../brand.ts';
import type * as LinksMod from './links.ts';
import type * as StoreMirrorMod from './store-mirror.ts';

// Lazy for start cost: links.ts loads at the first open (a hook with no seat opens no room), the mirror (the bridge,
// the link socket) only for a room hosted elsewhere.
const linksLib = lazy<typeof LinksMod>(import.meta.url, './links.ts');
const mirrorLib = lazy<typeof StoreMirrorMod>(import.meta.url, './store-mirror.ts');

let backend: ((code: RoomCode) => RoomStore) | null = null; // tests: code -> RoomStore
const stores = new Map<string, RoomStore>(); // home \0 code -> FsRoomStore | MirrorRoomStore
/** A room hosted elsewhere: the link registry knows it. */
const linked = (c: string): boolean => linksLib().has(c);

function open(c: RoomCode, { dir }: { dir?: string | undefined } = {}): RoomStore {
  if (backend) return backend(c);
  if (dir) return new FsRoomStore(c, { dir });
  const k = `${home()}\0${c}`;
  let s = stores.get(k);
  if (!s || s.isHost === linked(c)) { // none yet, or a join or forget wrote or removed the link since
    repairModes(); // a home made 0755 (an older version, a plain mkdir): 0700, once per home and process
    s = linked(c) ? new (mirrorLib().MirrorRoomStore)(c) : new FsRoomStore(c);
    stores.set(k, s);
  }
  return s;
}
const forget = (c: RoomCode): void => { stores.delete(`${home()}\0${c}`); };
const setBackend = (fn: ((code: RoomCode) => RoomStore) | null | undefined): void => { backend = typeof fn === 'function' ? fn : null; };
/** A just-made room has no members document or log for a moment: a folder made less than this ago is never a
 * leftover. Made, not written: a stray process's writes into a leftover keep its mtime young. */
const LEFTOVER_MS = 60_000;
function isLeftover(c: RoomCode): boolean {
  const d = roomDir(c);
  let st: fs.Stats;
  try { st = fs.statSync(d); } catch { return false; }
  const made = st.birthtimeMs > 0 ? Math.min(st.birthtimeMs, st.mtimeMs) : st.mtimeMs; // no birth time: the last write
  if (!st.isDirectory() || Date.now() - made < LEFTOVER_MS || linked(c)) return false;
  return !['members.json', 'log.jsonl', 'snapshot.json', 'snapshot-base.json', 'log-0001.jsonl'].some(f => fs.existsSync(path.join(d, f)));
}
const roomExists = (c: unknown): c is RoomCode => isRoomCode(c) && ((fs.existsSync(roomDir(c)) && !isLeftover(c)) || linked(c));
function createRoom(c: RoomCode): boolean {
  fs.mkdirSync(roomsDir(), { recursive: true, mode: 0o700 }); // the home and rooms/ too when new: private
  repairModes(); // an existing home made 0755 too
  try { fs.mkdirSync(roomDir(c), { mode: 0o700 }); } catch (e) { if (errCode(e) === 'EEXIST') return false; throw e; }
  indexRoom(c);
  return true;
}
const listRooms = (): RoomCode[] => { try { return fs.readdirSync(roomsDir()).filter(isRoomCode); } catch { return []; } };

// ---------- the open-rooms index ----------
/** <home>/open-rooms.json: {v: 1, rooms: {code: when it was indexed}}. */
interface RoomIndex { v: 1; rooms: Record<string, string> }
const indexFile = (): string => path.join(home(), 'open-rooms.json');
const readIndex = (): RoomIndex | null => {
  const x = readJsonRaw(indexFile());
  return isObj(x) && x.v === 1 && isObj(x.rooms) ? { v: 1, rooms: x.rooms as Record<string, string> } : null; // rooms: code -> when, as written
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
function indexedRooms(): RoomCode[] {
  const cur = readIndex();
  return Object.keys(cur ? cur.rooms : updateIndex(() => false)).filter(isRoomCode).sort();
}
function indexRoom(c: RoomCode): void {
  if (!isRoomCode(c) || (readIndex()?.rooms ?? {})[c]) return;
  updateIndex(rooms => { if (rooms[c]) return false; rooms[c] = new Date().toISOString(); return true; });
}
function unindexRooms(codes: readonly RoomCode[]): void {
  if (!codes.length) return;
  updateIndex(rooms => { let n = 0; for (const c of codes) if (rooms[c]) { delete rooms[c]; n++; } return n > 0; });
}

// ---------- deleting a closed room (lib/gc.ts) ----------
function lastChange(c: RoomCode): number {
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
function setAsideRoom(c: RoomCode, now: number = Date.now()): string {
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
function setAsideLeftover(c: RoomCode, now: number = Date.now()): string {
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
  if (!isRoomCode(e.room)) return NO_TRUST(e);
  try { return open(e.room).trust(e); } catch { return NO_TRUST(e); }
}

export {
  open, forget, setBackend, roomExists, isLeftover, setAsideLeftover, createRoom, listRooms, trustOf, indexedRooms, indexRoom, unindexRooms, lastChange,
  setAsideRoom, asideRooms, removeAside,
};
