/**
 * plugin/sub-human/lib/cc/tasks.ts: Claude Code's native task list on disk (the file backend), as the plugin writes the
 * room's (lib/room/task-files.ts project). The room session (lib/room-claude.ts, CLAUDE_CODE_TASK_LIST_ID=sh-CODE)
 * shows that list; its files are a projection of the room log's `task` entries (lib/tasks.ts fold), never the truth.
 *
 *   <configDir>/tasks/<list>/<id>.json   one task (NativeTask), JSON
 *   <configDir>/tasks/<list>/.highwatermark   the highest id TaskCreate has handed out: its next id is
 *                                        max(highest <id>.json, the mark) + 1 (markOf, raiseMark)
 *   <configDir>/tasks/<list>/.lock       the list lock's target (lib/cc/tasklock.ts)
 *
 *   taskJson(t) -> string                the file's text
 *   readTask(dir, id) -> NativeTask | null   a file as read (null: none, or not a task)
 *   fileIds(dir) -> number[]             the ids of the <n>.json files, ascending
 *   markOf(dir) -> number; raiseMark(dir, id)   the high-water mark (0: none); raised, never lowered
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../io.ts';
import { decode, isObj, obj, str, opt, arr, unknown_ } from '../decode.ts';

/** The status words a task file takes (the schema's enum). */
export type NativeStatus = 'pending' | 'in_progress' | 'completed';

/**
 * One task file as Claude Code reads it (a zod object, safeParse: a file that fails is skipped, never fatal; extra
 * metadata keys pass). blocks is the reverse of the other tasks' blockedBy.
 * @cc ".highwatermark"
 * @stability incidental
 */
export interface NativeTask {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  owner?: string;
  status: NativeStatus;
  blocks: string[];
  blockedBy: string[];
  metadata?: Record<string, unknown>;
}

const NATIVE = obj({
  id: str, subject: str, description: opt(str), activeForm: opt(str), owner: opt(str), status: str,
  blocks: opt(arr(str)), blockedBy: opt(arr(str)), metadata: opt(unknown_),
});
const STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed']);
const MARK = '.highwatermark';
const ID_FILE = /^(\d+)\.json$/;

/** The file's text: what TaskCreate writes (pretty JSON). */
const taskJson = (t: NativeTask): string => JSON.stringify(t, null, 2);

function readTask(dir: string, id: string | number): NativeTask | null {
  let v: unknown;
  try { v = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')); } catch { return null; }
  const t = decode(NATIVE, v);
  if (!t || !STATUSES.has(t.status)) return null;
  const metadata = isObj(t.metadata) ? t.metadata : undefined;
  return {
    id: t.id, subject: t.subject, description: t.description ?? '', ...(t.activeForm !== undefined ? { activeForm: t.activeForm } : {}),
    ...(t.owner !== undefined ? { owner: t.owner } : {}), status: t.status as NativeStatus, blocks: t.blocks ?? [], blockedBy: t.blockedBy ?? [],
    ...(metadata ? { metadata } : {}),
  };
}

function fileIds(dir: string): number[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.map(n => ID_FILE.exec(n)).filter((m): m is RegExpExecArray => !!m).map(m => Number(m[1])).sort((a, b) => a - b);
}

/**
 * TaskCreate's next id is max(the highest <id>.json, .highwatermark) + 1; the reset raises the mark before it deletes
 * the files, so ids are never reused. A file written at any id is shown: the mark only steers TaskCreate.
 * @cc [Tasks] raiseTaskIdMark
 * @stability incidental
 */
function markOf(dir: string): number {
  try { const n = parseInt(fs.readFileSync(path.join(dir, MARK), 'utf8').trim(), 10); return Number.isInteger(n) && n > 0 ? n : 0; } catch { return 0; }
}
/** Raise the mark to id (never lower it). The caller holds the list lock. */
function raiseMark(dir: string, id: number): void {
  if (id > markOf(dir)) writeFileAtomic(path.join(dir, MARK), String(id));
}

export { taskJson, readTask, fileIds, markOf, raiseMark };
