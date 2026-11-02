/**
 * plugin/sub-human/lib/room/task-files.ts: the room's native task list, written by the plugin. The room session
 * (lib/room-claude.ts) runs with CLAUDE_CODE_TASK_LIST_ID=sh-CODE and shows that list (ctrl+t); its files are a
 * projection of the log's `task` entries (lib/tasks.ts foldAll), so they can be rebuilt from the log at any time and a
 * broken projection loses a view, never data (lib/tasks.ts repair projects the log again). Host only.
 *
 *   dirOf(code, members?) -> path    the list's directory: the one recorded at spawn (members.claude.tasks_dir, the
 *                                    room session's config dir), else cc tasksDir('sh-CODE') from this process's env
 *   project(code, tasks, {dir?, now?}) -> {wrote, removed}   every task as a file (lib/cc/tasks.ts NativeTask), written
 *                                    only when its text differs, atomically (a temp name that never ends in .json, then
 *                                    rename), under Claude Code's own list lock and each task's lock (lib/cc/tasklock.ts);
 *                                    a deleted task's file goes; .highwatermark is raised to the highest id, so a
 *                                    TaskCreate never reuses one. A file the log does not know is left alone
 *                                    {skipped: reason} too, writing nothing, while members.claude.tasks_off is set.
 *                                    Then the folder is touched once it is TASK_LIST_TOUCH_MS old (cc touchList), so
 *                                    Claude Code's retention sweep (contract task-list-retention) never takes the list
 *                                    of a room that is open (repair projects every health tick). The list lock's mkdir
 *                                    already freshens the folder; the touch keeps that from resting on the lock's layout
 *   ownedDir(code, members?) -> path | null   the list's directory when it is the plugin's to delete: named sh-CODE
 *                                    under a tasks/ folder, a real directory, holding only plain .lock, .highwatermark
 *                                    and N.json files, each N.json stamped for this room (metadata.room), and no lock
 *                                    dir (.lock.lock, N.json.lock) fresher than Claude Code's stale age. Else null
 *   remove(code, {members?}) -> {removed, why?}   ownedDir, then rm -r: the reaper's (lib/room-claude.ts reap), once
 *                                    the room session is gone, and gc's when it sets a hosted room aside (lib/gc.ts).
 *                                    Never inside withListLock (it makes the folder)
 *   nextId(code, tasks, {dir?}) -> string   one more than the highest of the log's ids, the files' and the mark
 *   preflight(code, {dir?}) -> reason | null   lib/cc/tasks.ts check on the list's directory, recorded as
 *                                    members.claude.tasks_off (set, or cleared once it passes again; written only
 *                                    when it changes). The room session's start (lib/room-claude.ts openTaskList)
 *                                    and every repair (lib/tasks.ts) run it; a change Claude Code made to its task
 *                                    store then costs the room session's view, never a task: the log keeps them
 *
 * Claude Code's list reset (contract task-list-auto-reset: once every task is completed, a session showing the list
 * deletes every file) never fires while the room is open: the room task ("room CODE open", owner room) stays
 * in_progress until the reaper completes it (lib/tasks.ts closeRoomTask).
 */

import fs from 'node:fs';
import path from 'node:path';
import * as ccEnv from '../cc/env.ts';
import * as ccTasks from '../cc/tasks.ts';
import { withListLock, withTaskLock, STALE_MS } from '../cc/tasklock.ts';
import { writeFileAtomic } from '../io.ts';
import { TASK_LIST_TOUCH_MS } from '../config.ts';
import { errCode } from '../errors.ts';
import * as identity from '../identity.ts';
import type { NativeTask, NativeStatus } from '../cc/tasks.ts';
import type { FoldedTask } from '../types-app.ts';
import type { Member, Members } from './types.ts';
import type { RoomCode } from '../brand.ts';

/** The room's list id: the room session's CLAUDE_CODE_TASK_LIST_ID. */
const listId = (code: RoomCode): string => `sh-${code}`;

/** A recorded tasks_dir, checked: absolute and ending in tasks/sh-CODE (the plugin writes nowhere else). */
function recorded(code: RoomCode, dir: unknown): string | null {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return null;
  const tail = path.join('tasks', ccEnv.sanitizeId(listId(code)));
  return path.normalize(dir).endsWith(path.sep + tail) ? path.normalize(dir) : null;
}

function dirOf(code: RoomCode, members?: Members | null): string {
  let ms: Members | null | undefined = members;
  if (ms === undefined) { try { ms = identity.readMembers(code); } catch { ms = null; } }
  const rec = ms && ms.claude ? recorded(code, ms.claude.tasks_dir) : null;
  return rec ?? ccEnv.tasksDir(listId(code));
}

const STATUS: Readonly<Record<string, NativeStatus>> = { pending: 'pending', in_progress: 'in_progress', completed: 'completed' };

/** One folded task as its file. blocks: the ids whose blockedBy names it. */
function native(code: RoomCode, t: FoldedTask, all: readonly FoldedTask[]): NativeTask {
  const blocks = all.filter(o => o.id !== t.id && o.blockedBy.includes(t.id)).map(o => o.id);
  const metadata: Record<string, unknown> = { room: code };
  if (t.req) metadata.req = t.req;
  if (t.by) metadata.by = t.by;
  if (t.suggest) metadata.suggest = t.suggest;
  if (t.plan) { metadata.plan = t.plan; if (t.version) metadata.version = t.version; }
  return {
    id: t.id, subject: t.subject, description: t.detail ?? '', ...(t.owner ? { owner: t.owner } : {}),
    status: STATUS[t.status] ?? 'pending', blocks, blockedBy: [...t.blockedBy], metadata,
  };
}

/** What project did: the ids written and removed; skipped, the recorded reason it wrote nothing. */
interface Projected { wrote: string[]; removed: string[]; skipped?: string }

function project(code: RoomCode, tasks: readonly FoldedTask[], { dir, now = Date.now() }: { dir?: string; now?: number } = {}): Projected {
  const wrote: string[] = [], removed: string[] = [];
  let ms: Members | null = null;
  try { ms = identity.readMembers(code); } catch { /* no record: the default dir */ }
  const off = ms?.claude?.tasks_off;
  if (off) return { wrote, removed, skipped: off };
  dir ??= dirOf(code, ms);
  const live = tasks.filter(t => /^\d+$/.test(t.id));
  withListLock(dir, () => {
    for (const t of live) {
      withTaskLock(dir, t.id, () => {
        const file = path.join(dir, `${t.id}.json`);
        if (t.status === 'deleted') {
          try { fs.rmSync(file); removed.push(t.id); } catch { /* none */ }
          return;
        }
        const text = ccTasks.taskJson(native(code, t, live));
        let cur: string | null = null;
        try { cur = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
        if (cur === text) return;
        writeFileAtomic(file, text, { mode: 0o644 });
        wrote.push(t.id);
      });
    }
    const top = Math.max(0, ...live.map(t => Number(t.id)));
    if (top) ccTasks.raiseMark(dir, top);
  });
  ccTasks.touchList(dir, { now, olderMs: TASK_LIST_TOUCH_MS });
  return { wrote, removed };
}

/** What may be in a list the plugin deletes: Claude Code's list lock target, the mark, and task files. */
const PLAIN = /^(?:\.lock|\.highwatermark|\d+\.json)$/;
/** Claude Code's lock dirs (lib/cc/tasklock.ts): the list's and a task's. */
const LOCK_DIR = /^(?:\.lock|\d+\.json)\.lock$/;

/** The list's directory and whether the plugin may delete it (see the header), with why not. */
function owned(code: RoomCode, members: Members | null | undefined, now: number): { dir: string } | { why: string } {
  const dir = dirOf(code, members);
  if (path.basename(dir) !== ccEnv.sanitizeId(listId(code)) || path.basename(path.dirname(dir)) !== 'tasks') return { why: 'not a room list' };
  let st: fs.Stats;
  try { st = fs.lstatSync(dir); } catch { return { why: 'none' }; } // never made, or Claude Code removed it
  if (!st.isDirectory()) return { why: 'not a directory' };
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return { why: 'unreadable' }; }
  for (const n of names) {
    let e: fs.Stats;
    try { e = fs.lstatSync(path.join(dir, n)); } catch { continue; } // gone meanwhile
    if (LOCK_DIR.test(n) && e.isDirectory()) {
      if (now - e.mtimeMs < STALE_MS) return { why: `a lock is held (${n})` };
      continue;
    }
    if (!PLAIN.test(n) || !e.isFile()) return { why: `not the plugin's (${n})` };
    if (n.endsWith('.json') && ccTasks.readTask(dir, n.slice(0, -'.json'.length))?.metadata?.room !== code) return { why: `not this room's (${n})` };
  }
  return { dir };
}

function ownedDir(code: RoomCode, members?: Members | null, { now = Date.now() }: { now?: number } = {}): string | null {
  const o = owned(code, members, now);
  return 'dir' in o ? o.dir : null;
}

function remove(code: RoomCode, { members, now = Date.now() }: { members?: Members | null; now?: number } = {}): { removed: boolean; why?: string } {
  const o = owned(code, members, now);
  if (!('dir' in o)) return { removed: false, why: o.why };
  try { fs.rmSync(o.dir, { recursive: true, force: true }); } catch (e) { return { removed: false, why: errCode(e) ?? 'rm failed' }; }
  return { removed: true };
}

function nextId(code: RoomCode, tasks: readonly FoldedTask[], { dir = dirOf(code) }: { dir?: string } = {}): string {
  const ids = tasks.map(t => Number(t.id)).filter(n => Number.isInteger(n) && n > 0);
  return String(Math.max(0, ...ids, ccTasks.markOf(dir), ...ccTasks.fileIds(dir)) + 1);
}

function preflight(code: RoomCode, { dir, env = process.env }: { dir?: string; env?: NodeJS.ProcessEnv } = {}): string | null {
  const ms = identity.readMembers(code);
  const r = ccTasks.check(dir ?? dirOf(code, ms), { env });
  const reason = r.ok ? null : r.reason;
  const cur = ms.claude?.tasks_off ?? null;
  // a plain read first: the tick that changes nothing takes no lock (and no room session record: nothing to record on)
  if (ms.claude && cur !== reason) {
    identity.updateRoomClaude(code, (o: Member | null) => ((o?.tasks_off ?? null) === reason ? null : { tasks_off: reason ?? undefined }));
  }
  return reason;
}

export { listId, dirOf, project, ownedDir, remove, nextId, preflight };
export type { Projected };
