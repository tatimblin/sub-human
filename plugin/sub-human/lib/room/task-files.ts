/**
 * plugin/sub-human/lib/room/task-files.ts: the room's native task list, written by the plugin. The room session
 * (lib/room-claude.ts) runs with CLAUDE_CODE_TASK_LIST_ID=sh-CODE and shows that list (ctrl+t); its files are a
 * projection of the log's `task` entries (lib/tasks.ts foldAll), so they can be rebuilt from the log at any time and a
 * broken projection loses a view, never data (lib/tasks.ts repair projects the log again). Host only.
 *
 *   dirOf(code, members?) -> path    the list's directory: the one recorded at spawn (members.claude.tasks_dir, the
 *                                    room session's config dir), else cc tasksDir('sh-CODE') from this process's env
 *   project(code, tasks, {dir?}) -> {wrote, removed}   every task as a file (lib/cc/tasks.ts NativeTask), written only
 *                                    when its text differs, atomically (a temp name that never ends in .json, then
 *                                    rename), under Claude Code's own list lock and each task's lock (lib/cc/tasklock.ts);
 *                                    a deleted task's file goes; .highwatermark is raised to the highest id, so a
 *                                    TaskCreate never reuses one. A file the log does not know is left alone
 *   nextId(code, tasks, {dir?}) -> string   one more than the highest of the log's ids, the files' and the mark
 *
 * Claude Code's list reset (contract task-list-auto-reset: once every task is completed, a session showing the list
 * deletes every file) never fires while the room is open: the room task ("room CODE open", owner room) stays
 * in_progress until the reaper completes it (lib/tasks.ts closeRoomTask).
 */

import fs from 'node:fs';
import path from 'node:path';
import * as ccEnv from '../cc/env.ts';
import * as ccTasks from '../cc/tasks.ts';
import { withListLock, withTaskLock } from '../cc/tasklock.ts';
import { writeFileAtomic } from '../io.ts';
import * as identity from '../identity.ts';
import type { NativeTask, NativeStatus } from '../cc/tasks.ts';
import type { FoldedTask } from '../types-app.ts';
import type { Members } from './types.ts';
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

function project(code: RoomCode, tasks: readonly FoldedTask[], { dir = dirOf(code) }: { dir?: string } = {}): { wrote: string[]; removed: string[] } {
  const wrote: string[] = [], removed: string[] = [];
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
  return { wrote, removed };
}

function nextId(code: RoomCode, tasks: readonly FoldedTask[], { dir = dirOf(code) }: { dir?: string } = {}): string {
  const ids = tasks.map(t => Number(t.id)).filter(n => Number.isInteger(n) && n > 0);
  return String(Math.max(0, ...ids, ccTasks.markOf(dir), ...ccTasks.fileIds(dir)) + 1);
}

export { listId, dirOf, project, nextId };
