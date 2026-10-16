/**
 * plugin/sub-human/lib/gc.ts: what a home stops keeping, so it does not grow with every room and session ever made.
 * It never touches the log of a room that may be open: an open room's segments and snapshot are the store's
 * (lib/room/log-io.ts). A room goes only whole, once closed for good and untouched for ROOM_GC_MS, and first only
 * aside (renamed, not deleted): the folder set aside is deleted after a further ROOM_GC_MS.
 *
 *   sweep({now?, budgetMs?, force?, keep?}) -> {rooms, aside, sessions} | null   at most once per GC_EVERY_MS per
 *       home (<home>/gc.json; null: not due; force: now), stopping once it has run budgetMs (GC_BUDGET_MS); the next
 *       sweep goes on from the room it stopped at. keep: a room code never deleted (the one a join is about to take).
 *       rooms     a room directory on this machine, host's or mirror's, is set aside with its seat keys
 *                 (lib/room/store.ts setAsideRoom: rooms/CODE.gc-TIME, keys/CODE.gc-TIME) when it is closed for good
 *                 (lib/identity.ts closedForGood: every person's seat has left, a seat whose session crashed has not;
 *                 the room's Claude stopped or never started), no link record names it (this machine's, lib/room/
 *                 links.ts: a mirror's link goes with `sub-human link --forget`; nor the host's records of the
 *                 machines linked to it, the room's remote/links document), and nothing in its directory changed
 *                 for ROOM_GC_MS (SUB_HUMAN_ROOM_GC_MS; 30 days)
 *       aside     the folders set aside (`link --forget`'s rooms/CODE.forgotten-TIME, GC's rooms/CODE.gc-TIME with
 *                 keys/CODE.gc-TIME), deleted ROOM_GC_MS after they were set aside
 *       sessions  lib/identity.ts pruneSessionIndexes (by-sid and by-pid records of ended sessions, SESSION_INDEX_TTL_MS)
 *   sweepRows(code, {now?}) -> n   the room's agent -> row maps of sessions that ended without clearing them
 *       (lib/rows.ts pruneRowMaps, ROWS_TTL_MS)
 * lib/seats.ts take runs both at a join: sweep() (a stat when not due), and sweepRows for the room joined.
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import * as store from './room/store.ts';
import * as links from './room/links.ts';
import * as identity from './identity.ts';
import { home } from './home.ts';
import { readJson, writeJsonAtomic } from './io.ts';
import { obj, str, opt } from './decode.ts';
import { GC_BUDGET_MS, GC_EVERY_MS } from './config.ts';
import { envMs } from './env.ts';

const require = createRequire(import.meta.url);
// lib/rows.ts loads the consent fold and the tasks: only a join that sweeps a room's rows needs it
const rows = (): typeof import('./rows.ts') => require('./rows.ts');

/** <home>/gc.json: when the last sweep started, and the room after which the next one goes on. */
/** <home>/gc.json: when the last sweep began, and the room it stopped after. */
const GC_STATE = obj({ at: str, after: opt(str) });
const stateFile = (): string => path.join(home(), 'gc.json');

/** The host's records of the machines linked to this room (lib/remote/host-links.ts LINKS_KEY; not imported: GC
 *  runs at every join and should not load the remote code). */
const HOST_LINKS_KEY = 'remote/links';
function hostLinked(code: string): boolean {
  const recs = store.open(code).kv.get<Record<string, unknown>>(HOST_LINKS_KEY);
  return !!recs && typeof recs === 'object' && Object.keys(recs).length > 0;
}

function sweep({ now = Date.now(), budgetMs = GC_BUDGET_MS, force = false, keep = null }: { now?: number; budgetMs?: number; force?: boolean; keep?: string | null } = {}): { rooms: string[]; aside: string[]; sessions: number } | null {
  const prev = readJson(stateFile(), GC_STATE, null);
  if (!force && prev && now - Date.parse(prev.at) < GC_EVERY_MS) return null;
  const until = Date.now() + budgetMs;
  const ttl = envMs('SUB_HUMAN_ROOM_GC_MS');
  const out = { rooms: [] as string[], aside: [] as string[], sessions: 0 };
  // claim the sweep first: a second join meanwhile does not run one too
  writeJsonAtomic(stateFile(), { at: new Date(now).toISOString(), ...(prev && prev.after ? { after: prev.after } : {}) }, { compact: true });
  const codes = store.listRooms().sort();
  const start = prev && prev.after ? codes.findIndex(c => c > prev.after!) : 0;
  const order = start > 0 ? [...codes.slice(start), ...codes.slice(0, start)] : codes;
  let last: string | undefined;
  let done = true;
  for (const code of order) {
    if (Date.now() >= until) { done = false; break; }
    last = code;
    try {
      if (code === keep || links.has(code)) continue;
      if (now - store.lastChange(code) < ttl) continue;
      if (!identity.closedForGood(identity.readMembers(code))) continue;
      if (hostLinked(code)) continue;
      store.setAsideRoom(code, now);
      out.rooms.push(code);
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

function sweepRows(code: string, { now = Date.now() }: { now?: number } = {}): number { return rows().pruneRowMaps(code, now); }

export { sweep, sweepRows };
