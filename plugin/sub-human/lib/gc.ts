/**
 * plugin/sub-human/lib/gc.ts: what a home stops keeping, so it does not grow with every room and session ever made.
 * It never touches the log of a room that may be open: an open room's segments and snapshot are the store's
 * (lib/room/log-io.ts). A room goes only whole, once closed for good and untouched for ROOM_GC_MS, and first only
 * aside (renamed, not deleted): the folder set aside is deleted after a further ROOM_GC_MS.
 *
 *   sweep({now?, budgetMs?, force?, keep?, jobs?}) ->{rooms, aside, tasks, sessions} | null   at most once per GC_EVERY_MS per
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
 *       tasks     also, at most once per TASKS_GC_EVERY_MS (<home>/gc-task-lists.json, a cursor as gc.json's), the stamped
 *                 lists staleTaskLists finds, which no room here names any more (a room set aside before the sweep
 *                 took its list, a demo or test home gone)
 *   staleTaskLists({now?, legacy?, keep?, until?, after?, jobs?}) -> {lists, jobsUnknown, last?, done}   the folders
 *       under <config dir>/tasks/ (lib/cc/env.ts configDir: this process's) no room of this home uses. Each is a plain
 *       directory named sh-CODE (CODE_RE), its code no room here (rooms/, set aside or linked) and no live
 *       `claude --bg` job named claude.CODE (lib/room-claude.ts spawnPlan: the job that runs with
 *       CLAUDE_CODE_TASK_LIST_ID=sh-CODE; `claude agents --json` names it, the env it gives none), the folder and
 *       every entry in it untouched for ROOM_GC_MS, and every entry a plain file: .lock, .highwatermark or N.json.
 *       kind stamped: every N.json is the plugin's for CODE (metadata.room, lib/room/task-files.ts native) or there
 *       is none; legacy (only with legacy: `sub-human gc --tasks`): from before the stamp, the lowest-numbered task
 *       is the room task ("room CODE open", owner room: lib/tasks.ts) and no file names another room. A symlink, a
 *       lock directory or any other file keeps the folder. The job list is read once, only when there is a folder to
 *       delete (jobs: lib/cc/bg.ts jobs, or a stand-in); when it cannot be read (jobsUnknown) no folder is returned. until: stop looking then (done false,
 *       last the name looked at last); after: start past that name, wrapping round
 *   removeTaskLists(lists) -> [dir]   each deleted (rm -r; one that fails stays)
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
import { GC_BUDGET_MS, GC_EVERY_MS, TASKS_GC_EVERY_MS } from './config.ts';
import { envMs } from './env.ts';
import { configDir } from './cc/env.ts';
import type { RoomCode } from './brand.ts';
import type { Members } from './room/types.ts';
import type { AgentJob } from './cc/bg.ts';
import type * as RowsMod from './rows.ts';
import type * as TaskFilesMod from './room/task-files.ts';
import type * as BgMod from './cc/bg.ts';

// lib/rows.ts loads the consent fold and the tasks: only a join that sweeps a room's rows needs it
const rows = lazy<typeof RowsMod>(import.meta.url, './rows.ts');
// the native task list's place: only a sweep that sets a hosted room aside needs it
const taskFiles = lazy<typeof TaskFilesMod>(import.meta.url, './room/task-files.ts');
// `claude agents --json`: only a look at tasks/ that found a folder to delete needs it
const bg = lazy<typeof BgMod>(import.meta.url, './cc/bg.ts');

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

/** What a stale list's own files may be: Claude Code's list lock and id mark, and task files. */
const LIST_MARKS: ReadonlySet<string> = new Set(['.lock', '.highwatermark']);
const TASK_FILE = /^(\d+)\.json$/;
/** A task file as the legacy rule reads it: whose task it is, and what (lib/tasks.ts isRoomTask). */
const TASK_WHO = obj({ owner: opt(str), subject: opt(str) });
/** A bg job's states once it ended (lib/room-claude.ts ENDED): any other, or none, is a job that may still run. */
const JOB_ENDED: ReadonlySet<string> = new Set(['done', 'failed', 'stopped']);

type StaleKind = 'stamped' | 'legacy';
/** A room's native task list that no room of this home uses. */
interface StaleList { dir: string; code: RoomCode; kind: StaleKind }
interface StaleScan { lists: StaleList[]; jobsUnknown: boolean; last?: string; done: boolean }
interface StaleOpts { now?: number; legacy?: boolean; keep?: string | null; until?: number; after?: string | undefined; jobs?: () => readonly AgentJob[] | null }

/** The rule the folder sh-CODE meets (see the header), or null: it stays. Throws on what it cannot read. */
function staleKind(dir: string, code: RoomCode, before: number, legacy: boolean): StaleKind | null {
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.mtimeMs > before) return null;
  let stamped = true, foreign = false;
  let low: { n: number; file: string } | null = null;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const e = fs.lstatSync(file);
    if (!e.isFile() || e.mtimeMs > before) return null;
    if (LIST_MARKS.has(name)) continue;
    const m = TASK_FILE.exec(name);
    if (!m) return null;
    const n = Number(m[1]);
    if (!low || n < low.n) low = { n, file };
    const room = readJson(file, TASK_ROOM, null)?.metadata?.room;
    if (room !== code) stamped = false;
    if (room !== undefined && room !== code) foreign = true;
  }
  if (stamped) return 'stamped';
  if (!legacy || foreign || !low) return null;
  const t = readJson(low.file, TASK_WHO, null);
  return t && t.owner === 'room' && t.subject === `room ${code} open` ? 'legacy' : null;
}

/** The codes this home knows: its rooms (open or closed, hosted or mirrored), the ones set aside, and its links. */
function knownCodes(): Set<string> {
  const known = new Set<string>([...store.listRooms(), ...links.list()]);
  for (const a of store.asideRooms()) known.add(a.name.slice(0, a.name.indexOf('.')));
  return known;
}

function staleTaskLists({ now = Date.now(), legacy = false, keep = null, until = Infinity, after, jobs = () => bg().jobs() }: StaleOpts = {}): StaleScan {
  const out: StaleScan = { lists: [], jobsUnknown: false, done: true };
  const tasks = path.join(configDir(), 'tasks');
  try { if (!fs.lstatSync(tasks).isDirectory()) return out; } catch { return out; }
  const known = knownCodes();
  if (keep) known.add(keep);
  const names = fs.readdirSync(tasks).filter(n => n.startsWith('sh-')).sort();
  const start = after ? names.findIndex(n => n > after) : 0;
  const order = start > 0 ? [...names.slice(start), ...names.slice(0, start)] : names;
  const before = now - envMs('SUB_HUMAN_ROOM_GC_MS');
  const found: StaleList[] = [];
  for (const name of order) {
    if (Date.now() >= until) { out.done = false; break; }
    out.last = name;
    const code = name.slice(3);
    if (!identity.isRoomCode(code) || known.has(code)) continue;
    const dir = path.join(tasks, name);
    try { const kind = staleKind(dir, code, before, legacy); if (kind) found.push({ dir, code, kind }); } catch { /* unreadable: it stays */ }
  }
  if (!found.length) return out;
  let js: readonly AgentJob[] | null = null;
  try { js = jobs(); } catch { /* unknown */ }
  if (!js) return { ...out, jobsUnknown: true };
  const live = new Set(js.filter(j => !(j.state && JOB_ENDED.has(j.state))).map(j => j.name));
  out.lists = found.filter(l => !live.has(`claude.${l.code}`));
  return out;
}

function removeTaskLists(lists: readonly StaleList[]): string[] {
  const gone: string[] = [];
  for (const l of lists) { try { fs.rmSync(l.dir, { recursive: true }); gone.push(l.dir); } catch { /* it stays */ } }
  return gone;
}

/** <home>/gc.json: when the last sweep began, and the room it stopped after; <home>/gc-task-lists.json the same for
 *  tasks/ (the sh-* folder name it stopped after). */
const GC_STATE = obj({ at: str, after: opt(str) });
const stateFile = (): string => path.join(home(), 'gc.json');
const tasksStateFile = (): string => path.join(home(), 'gc-task-lists.json');

/** The stamped lists no room here uses, deleted: at most once per TASKS_GC_EVERY_MS, within the sweep's time. */
function sweepTaskLists(now: number, until: number, force: boolean, keep: string | null, jobs: StaleOpts['jobs']): string[] {
  const prev = readJson(tasksStateFile(), GC_STATE, null);
  if (!force && prev && now - Date.parse(prev.at) < TASKS_GC_EVERY_MS) return [];
  writeJsonAtomic(tasksStateFile(), { at: new Date(now).toISOString(), ...(prev && prev.after ? { after: prev.after } : {}) }, { compact: true });
  // a join waits on this: the job list gets 3 s, not jobs()'s 15 (it is read only when there is a folder to delete)
  const r = staleTaskLists({ now, keep, until, after: prev?.after, jobs: jobs ?? (() => bg().jobs({ timeout: 3000 })) });
  const gone = removeTaskLists(r.lists);
  writeJsonAtomic(tasksStateFile(), { at: new Date(now).toISOString(), ...(!r.done && r.last ? { after: r.last } : {}) }, { compact: true });
  return gone;
}

/** The host's records of the machines linked to this room (lib/remote/host-links.ts LINKS_KEY; not imported: GC
 *  runs at every join and should not load the remote code). */
const HOST_LINKS_KEY = 'remote/links';
function hostLinked(code: RoomCode): boolean {
  const recs = store.open(code).kv.get<Record<string, unknown>>(HOST_LINKS_KEY);
  return !!recs && typeof recs === 'object' && Object.keys(recs).length > 0;
}

function sweep({ now = Date.now(), budgetMs = GC_BUDGET_MS, force = false, keep = null, jobs }: { now?: number; budgetMs?: number; force?: boolean; keep?: string | null; jobs?: StaleOpts['jobs'] } = {}): { rooms: string[]; aside: string[]; tasks: string[]; sessions: number } | null {
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
  if (Date.now() < until) { try { out.tasks.push(...sweepTaskLists(now, until, force, keep, jobs)); } catch { /* next time */ } }
  writeJsonAtomic(stateFile(), { at: new Date(now).toISOString(), ...(!done && last ? { after: last } : {}) }, { compact: true });
  return out;
}

function sweepRows(code: RoomCode, { now = Date.now() }: { now?: number } = {}): number { return rows().pruneRowMaps(code, now); }

export { sweep, sweepRows, staleTaskLists, removeTaskLists };
export type { StaleList, StaleKind, StaleScan, StaleOpts };
