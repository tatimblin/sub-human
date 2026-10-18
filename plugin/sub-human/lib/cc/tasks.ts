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
 *   check(dir, {env?}) -> {ok: true} | {ok: false, reason}   whether the room's list can still be the file store Claude
 *                                        Code reads (below); the plugin projects nothing while it says no
 *   storeV5On(env?) -> boolean           the key-value task backend's gate is on
 *   tasksOffByVerdict() -> reason | null   the per-version verdict turned the tasks feature off
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic, sleepSync, lazy } from '../io.ts';
import { decode, isObj, obj, str, opt, arr, unknown_ } from '../decode.ts';
import { errCode } from '../errors.ts';
import { cachedSwitch } from './env.ts';
import type * as VerdictMod from './verdict.ts';

const verdictLib = lazy<typeof VerdictMod>(import.meta.url, './verdict.ts');

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

// ---------- the preflight ----------

/** What check answers. */
export type TaskStoreCheck = { ok: true } | { ok: false, reason: string };

/** The env switch beside the gate (Claude Code reads it first, then the cached feature). */
const V5_ENV = 'CLAUDE_CODE_HOVER_REST';

/**
 * The storage backend gate (tengu_hover_rest: the env switch, else the cached feature). On, Claude Code keeps tasks
 * (with settings, the global config and more) in a key-value store, not in <list>/<id>.json, so the room session
 * would not read the files the plugin writes. Off by default.
 * @cc "tengu_hover_rest",!1)
 * @stability env
 */
function storeV5On(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[V5_ENV];
  if (v !== undefined && v !== '') return /^(1|true|yes|on)$/i.test(v.trim());
  return cachedSwitch('tengu_hover_rest', env) === true;
}

/** The per-version verdict's word on the tasks feature (lib/cc/verdict.ts off, SUB_HUMAN_CC_OFF first): a reason when
 * it turned tasks off, else null. The version is the one last seen on this machine: the host's tail has no session. */
function tasksOffByVerdict(): string | null {
  try {
    const v = verdictLib();
    if (v.forced().includes('tasks')) return 'SUB_HUMAN_CC_OFF turns the room task list off';
    const seen = v.seen();
    return seen && v.off('tasks', { version: seen }) ? `Claude Code ${seen} changed how it keeps task lists (sub-human doctor)` : null;
  } catch { return null; }
}

/** The lock entries Claude Code's proper-lockfile layout makes (lib/cc/tasklock.ts): the list lock's target file, its
 * lock dir, and a task's lock dir. Any other name with "lock" in it is a layout this plugin does not know. */
function knownLock(name: string, st: fs.Stats): boolean {
  if (name === '.lock') return st.isFile();
  return (name === '.lock.lock' || /^\d+\.json\.lock$/.test(name)) && st.isDirectory();
}

/** dir, or the nearest directory above it that exists, is a directory this process may write in. */
function writableDir(dir: string): string | null {
  for (let d = dir; ; d = path.dirname(d)) {
    let st: fs.Stats;
    try { st = fs.statSync(d); } catch (e) {
      if ((errCode(e) === 'ENOENT' || errCode(e) === 'ENOTDIR') && path.dirname(d) !== d) continue;
      return `${d} cannot be read`;
    }
    if (!st.isDirectory()) return `${d} is not a directory`;
    try { fs.accessSync(d, fs.constants.W_OK | fs.constants.X_OK); } catch { return `${d} is not writable`; }
    return null;
  }
}

/**
 * Whether the room's list can still be the file store: the gate of the key-value backend is off (storeV5On), the
 * directory is one this process can write (or can make), every <n>.json in it still reads as a task (NATIVE; a file
 * Claude Code is writing in place is read again once), and no lock entry has a layout the plugin does not know. The
 * verdict's word comes first (tasksOffByVerdict).
 */
function check(dir: string, { env = process.env }: { env?: NodeJS.ProcessEnv } = {}): TaskStoreCheck {
  const verdict = tasksOffByVerdict();
  if (verdict) return { ok: false, reason: verdict };
  if (storeV5On(env)) return { ok: false, reason: "Claude Code's key-value task store is on (tengu_hover_rest), so it does not read task files" };
  const where = writableDir(dir);
  if (where) return { ok: false, reason: `the task list directory: ${where}` };
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch (e) { if (errCode(e) !== 'ENOENT') return { ok: false, reason: `the task list directory cannot be read (${errCode(e) ?? 'error'})` }; }
  for (const name of names) {
    if (!/lock/i.test(name)) continue;
    let st: fs.Stats;
    try { st = fs.lstatSync(path.join(dir, name)); } catch { continue; } // released meanwhile
    if (!knownLock(name, st)) return { ok: false, reason: `an unknown task lock layout (${name})` };
  }
  for (const id of fileIds(dir)) {
    if (readTask(dir, id)) continue;
    sleepSync(50);
    if (!readTask(dir, id) && fs.existsSync(path.join(dir, `${id}.json`))) return { ok: false, reason: `task file ${id}.json no longer reads as a task` };
  }
  return { ok: true };
}

export { taskJson, readTask, fileIds, markOf, raiseMark, check, storeV5On, tasksOffByVerdict };
