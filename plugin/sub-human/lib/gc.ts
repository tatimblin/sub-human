/**
 * plugin/sub-human/lib/gc.ts: what a home stops keeping, so it does not grow with every room and session ever made.
 * It never touches the log of a room that may be open: an open room's segments and snapshot are the store's
 * (lib/room/log-io.ts). A room goes only whole, once closed for good and untouched for ROOM_GC_MS, and first only
 * aside (renamed, not deleted): the folder set aside is deleted after a further ROOM_GC_MS.
 *
 *   sweep({now?, budgetMs?, force?, keep?}) -> {rooms, aside, tasks, sessions} | null   at most once per GC_EVERY_MS per
 *       home (<home>/gc.json; null: not due; force: now), stopping once it has run budgetMs (GC_BUDGET_MS); the next
 *       sweep goes on from the room it stopped at. keep: a room code never deleted (the one a join is about to take).
 *       rooms     a room directory on this machine, host's or mirror's, is set aside with its seat keys
 *                 (lib/room/store.ts setAsideRoom: rooms/CODE.gc-TIME, keys/CODE.gc-TIME) when it is closed for good
 *                 (lib/identity.ts closedForGood: every person's seat has left, a seat whose session crashed has not;
 *                 the room's Claude stopped or never started), no link record names it (this machine's, lib/room/
 *                 links.ts: a mirror's link goes with `sub-human link --forget`; nor the host's records of the
 *                 machines linked to it, the room's remote/links document), and nothing in its directory changed
 *                 for ROOM_GC_MS (SUB_HUMAN_ROOM_GC_MS; 30 days)
 *       tasks     with a room hosted here set aside, its native task list goes (roomTaskList: the room session's
 *                 sh-CODE folder under Claude Code's tasks/, only when every task file in it is the plugin's for that
 *                 room). The files are a projection of the log (lib/room/task-files.ts): a room brought back from
 *                 aside projects them again. Tasks still open at close stay open in the log, the truth
 *       aside    the folders set aside (`link --forget`'s rooms/CODE.forgotten-TIME, GC's rooms/CODE.gc-TIME with
 *                 keys/CODE.gc-TIME), deleted ROOM_GC_MS after they were set aside
 *       sessions  lib/identity.ts pruneSessionIndexes (by-sid and by-pid records of ended sessions, SESSION_INDEX_TTL_MS)
 *   sweepRows(code, {now?}) -> n   the room's agent -> row maps of sessions that ended without clearing them
 *       (lib/rows.ts pruneRowMaps, ROWS_TTL_MS)
 * lib/seats.ts take runs both at a join: sweep() (a stat when not due), and sweepRows for the room joined.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as store from './room/store.ts';
import * as links from './room/links.ts';
import * as identity from './identity.ts';
import { home } from './home.ts';
import { readJson, writeJsonAtomic, lazy } from './io.ts';
import { obj, str, opt } from './decode.ts';
import { GC_BUDGET_MS, GC_EVERY_MS } from './config.ts';
import { envMs } from './env.ts';
import type { RoomCode } from './brand.ts';
import type { Members } from './room/types.ts';
import type * as RowsMod from './rows.ts';
import type * as TaskFilesMod from './room/task-files.ts';

// lib/rows.ts loads the consent fold and the tasks: only a join that sweeps a room's rows needs it
const rows = lazy<typeof RowsMod>(import.meta.url, './rows.ts');
// the native task list's place: only a sweep that sets a hosted room aside needs it
const taskFiles = lazy<typeof TaskFilesMod>(import.meta.url, './room/task-files.ts');

/** A native task file, as far as the sweep reads it: the room the plugin wrote it for (task-files.ts native). */
const TASK_ROOM = obj({ metadata: opt(obj({ room: opt(str) })) });

/**
 * The native task list of a room hosted here (lib/room/task-files.ts dirOf: the folder recorded at the room session's
 * spawn, else <config dir>/tasks/sh-CODE), the directory to delete once the room is closed for good, or null. Only a
 * folder named exactly sh-CODE under a tasks/ folder, and only when every task file in it is one the plugin wrote for
 * this room (metadata.room CODE): a list that holds anything else is left alone.
 */
function roomTaskList(code: RoomCode, ms: Members): string | null {
  const dir = taskFiles().dirOf(code, ms);
  if (path.basename(dir) !== `sh-${code}` || path.basename(path.dirname(dir)) !== 'tasks') return null;
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return null; } // none (never started, or Claude Code removed it)
  for (const n of names.filter(f => f.endsWith('.json'))) {
    const t = readJson(path.join(dir, n), TASK_ROOM, null);
    if (!t || t.metadata?.room !== code) return null;
  }
  return dir;
}

/** <home>/gc.json: when the last sweep started, and the room after which the next one goes on. */
/** <home>/gc.json: when the last sweep began, and the room it stopped after. */
const GC_STATE = obj({ at: str, after: opt(str) });
const stateFile = (): string => path.join(home(), 'gc.json');

/** The host's records of the machines linked to this room (lib/remote/host-links.ts LINKS_KEY; not imported: GC
 *  runs at every join and should not load the remote code). */
const HOST_LINKS_KEY = 'remote/links';
function hostLinked(code: RoomCode): boolean {
  const recs = store.open(code).kv.get<Record<string, unknown>>(HOST_LINKS_KEY);
  return !!recs && typeof recs === 'object' && Object.keys(recs).length > 0;
}

function sweep({ now = Date.now(), budgetMs = GC_BUDGET_MS, force = false, keep = null }: { now?: number; budgetMs?: number; force?: boolean; keep?: string | null } = {}): { rooms: string[]; aside: string[]; tasks: string[]; sessions: number } | null {
  const prev = readJson(stateFile(), GC_STATE, null);
  if (!force && prev && now - Date.parse(prev.at) < GC_EVERY_MS) return null;
  const until = Date.now() + budgetMs;
  const ttl = envMs('SUB_HUMAN_ROOM_GC_MS');
  const out: { rooms: string[]; aside: string[]; tasks: string[]; sessions: number } = { rooms: [], aside: [], tasks: [], sessions: 0 };
  // claim the sweep first: a second join meanwhile does not run one too
  writeJsonAtomic(stateFile(), { at: new Date(now).toISOString(), ...(prev && prev.after ? { after: prev.after } : {}) }, { compact: true });
  const codes = store.listRooms().sort();
  const after = prev && prev.after;
  const start = after ? codes.findIndex(c => c > after) : 0;
  const order = start > 0 ? [...codes.slice(start), ...codes.slice(0, start)] : codes;
  let last: string | undefined;
  let done = true;
  for (const code of order) {
    if (Date.now() >= until) { done = false; break; }
    last = code;
    try {
      if (code === keep || links.has(code)) continue;
      if (now - store.lastChange(code) < ttl) continue;
      const ms = identity.readMembers(code);
      if (!identity.closedForGood(ms)) continue;
      if (hostLinked(code)) continue;
      // a mirror never had a list here (the room session runs on the host): a sh-CODE beside it is another home's
      let list: string | null = null;
      try { list = identity.isHost(code) ? roomTaskList(code, ms) : null; } catch { /* the list stays */ }
      store.setAsideRoom(code, now);
      out.rooms.push(code);
      if (list) { try { fs.rmSync(list, { recursive: true, force: true }); out.tasks.push(list); } catch { /* it stays */ } }
    } catch { /* unreadable now: the next sweep looks again */ }
  }
  for (const a of store.asideRooms()) {
    if (Date.now() >= until) { done = false; break; }
    if (now - a.at >= ttl) { try { store.removeAside(a.name); out.aside.push(a.name); } catch { /* next time */ } }
  }
  if (Date.now() < until) { try { out.sessions = identity.pruneSessionIndexes(now); } catch { /* next time */ } }
  writeJsonAtomic(stateFile(), { at: new Date(now).toISOString(), ...(!done && last ? { after: last } : {}) }, { compact: true });
  return out;
}

function sweepRows(code: RoomCode, { now = Date.now() }: { now?: number } = {}): number { return rows().pruneRowMaps(code, now); }

export { sweep, sweepRows };
