#!/usr/bin/env node
/**
 * plugin/sub-human/hooks/tasks.ts: the room task list's mirror and gate. Room Claude only: in any other session it
 * exits 0 at once, so members' private task lists are never touched.
 *
 * PostToolUse TaskCreate|TaskUpdate (mirror): appends a `task` entry via system
 *   {op: add|claim|release|done|update|delete, id, subject, owner, status, blockedBy, req} (the task's whole
 *   state after the call), then rewrites tasks.json as lib/tasks.ts fold() of every `task` entry, so the file is
 *   derivable from the log alone. A refused call is skipped. What the tool input and response leave unknown is
 *   read from the room Claude's native task file (cc.taskFile; never written). The room-open task and _internal tasks
 *   are left out.
 * TaskCompleted (gate): exit 2 with the reason (shown to the room's Claude) unless lib/tasks.ts gate() passes. The
 *   input has no metadata, so owner and metadata come from the task file (which still has the old status).
 *   A refusal drops every field of that TaskUpdate, so the reason tells the room's Claude to send status alone.
 * Every room Claude run then reconciles: a native task the log has no `task` entry for gets an `add` snapshot, so a
 *   lost mirror run is repaired by the next one.
 *
 * The room's Claude: the session resolves (common.ts resolveSeat) to the room's Claude seat, or (before binding)
 * SUB_HUMAN_ROOM is set and agent_type is sub-human:room-claude.
 */

import fs from 'node:fs';
import path from 'node:path';
const LIB = path.join(import.meta.dirname, '..', 'lib');
import { readInput, resolveSeat } from './common.ts';
import * as identity from '../lib/identity.ts';
import * as room from '../lib/room.ts';
import * as tasks from '../lib/tasks.ts';
import * as cc from '../lib/cc.ts';
import { readJson } from '../lib/io.ts';
import type { AnyHookIn, HookIn } from './types.ts';
import type { RawTask } from '../lib/tasks.ts';

/** Anything that may carry task metadata (a call's input, a native task file). */
type WithMeta = { metadata?: { _internal?: unknown; req?: unknown } | null } | null | undefined;

/** A native task file (cc.taskFile JSON, read only): the fields read here. */
interface NativeTask extends RawTask {
  blockedBy?: unknown[];
  description?: string;
  metadata?: { _internal?: unknown; req?: unknown } | null;
}

/** A task's state in the mirror (lib/tasks.ts fold), and a `task` entry's fields. */
interface TaskState { id: string; subject: string; status: string; owner: string | null; blockedBy: string[] }
interface TaskRecord extends TaskState { op: string; req?: number }

/** TaskCreate / TaskUpdate input, as sent (untrusted). */
interface TaskCall {
  taskId?: unknown;
  subject?: string; // Claude Code checks a call against the tool's schema
  status?: unknown;
  owner?: unknown;
  addBlockedBy?: unknown;
  description?: string;
  metadata?: { _internal?: unknown; req?: unknown } | null;
}
/** Their response, as far as the mirror reads it. */
interface TaskResponse {
  success?: boolean;
  error?: unknown;
  task?: { id?: unknown; subject?: string };
  taskId?: unknown;
  statusChange?: { to?: string };
}

/** What this script reads on stdin: PostToolUse TaskCreate|TaskUpdate, or TaskCompleted. */
type TasksIn = Omit<AnyHookIn, 'tool_input' | 'tool_response'> & Omit<HookIn<'TaskCompleted'>, 'hook_event_name'>
  & { tool_input?: TaskCall; tool_response?: TaskResponse };

function roomClaudeRoom(input: TasksIn): string | null {
  const me = resolveSeat(input);
  if (me) return me.role === 'claude' ? me.code : null;
  const code = process.env.SUB_HUMAN_ROOM;
  if (code && identity.CODE_RE.test(code) && input.agent_type === 'sub-human:room-claude' && identity.roomExists(code)) return code;
  return null;
}

const listId = (code: string): string => cc.taskListId() || `sh-${code}`;
const readNative = (code: string, id: string): NativeTask | null => (/^\d+$/.test(String(id)) ? readJson(cc.taskFile(listId(code), id)) : null);
const internal = (t: WithMeta) => !!(t && t.metadata && t.metadata._internal);
const RETRY = 'Nothing in that TaskUpdate was saved. Resend its other fields without status; change status only in a TaskUpdate of its own.';

/** Legacy: the req number cited in a description, "(req #14 by bob)" or "evidence (#15): …"; the last wins. */
function reqNumber(desc: string | null | undefined): number | null {
  const all = [...String(desc || '').matchAll(/(?:req #|evidence \(#)(\d+)/g)];
  return all.length ? Number(all[all.length - 1][1]) : null;
}

function opFor(prev: TaskState | null, next: TaskState, created: boolean): string {
  if (created) return 'add';
  if (next.status === 'deleted') return 'delete';
  if (next.status === 'completed' && (!prev || prev.status !== 'completed')) return 'done';
  if ((prev && prev.owner || null) !== next.owner) return next.owner ? 'claim' : 'release';
  return 'update';
}

const same = (a: TaskState | null, b: TaskState) => !!a && !!b && a.subject === b.subject && a.status === b.status && (a.owner || null) === (b.owner || null)
  && JSON.stringify(a.blockedBy || []) === JSON.stringify(b.blockedBy || []);

function mirror(code: string, input: TasksIn) {
  const resp: TaskResponse = input.tool_response || {};
  if (resp.success === false || resp.error) return; // refused: the native list did not change
  const inp: TaskCall = input.tool_input || {};
  const created = input.tool_name === 'TaskCreate';
  const id = String(created ? (resp.task && resp.task.id) || '' : resp.taskId || inp.taskId || '');
  if (!/^\d+$/.test(id)) return;
  if (created && internal(inp)) return;

  const r = room.open(code);
  tasks.withList(code, () => {
    const log = r.readAll();
    const prev: TaskState | null = tasks.fold(log).find((t: TaskState) => t.id === id) || null;
    const native = readNative(code, id);
    if (internal(native)) return;
    const base: TaskState = prev ? { ...prev } : native ? {
      id, subject: native.subject || '', status: native.status || 'pending', owner: native.owner || null,
      blockedBy: Array.isArray(native.blockedBy) ? native.blockedBy.map(String) : [],
    } : { id, subject: '', status: 'pending', owner: null, blockedBy: [] };
    const next = { ...base };
    if (created) next.subject = (resp.task && resp.task.subject) || inp.subject || next.subject;
    else if (typeof inp.subject === 'string' && inp.subject) next.subject = inp.subject;
    if (typeof inp.status === 'string' && inp.status) next.status = inp.status;
    else if (resp.statusChange && resp.statusChange.to) next.status = resp.statusChange.to;
    if ('owner' in inp) next.owner = inp.owner ? String(inp.owner) : null;
    if (Array.isArray(inp.addBlockedBy)) next.blockedBy = [...new Set([...(next.blockedBy || []), ...inp.addBlockedBy.map(String)])];
    if (!next.subject && native && native.subject) next.subject = native.subject;

    // the room-open task never enters the log or the mirror (its subject is in the native file)
    if (tasks.isRoomTask(next, code) || tasks.isRoomTask(native, code)) return;
    const op = opFor(prev, next, created);
    if (!created && same(prev, next)) return; // description- or metadata-only change: no log entry
    const req = tasks.metaReq(inp.metadata) || tasks.metaReq(native && native.metadata)
      || reqNumber(inp.description || (native && native.description));
    record(r, { op, id, subject: next.subject, owner: next.owner, status: op === 'delete' ? 'deleted' : next.status,
      blockedBy: next.blockedBy || [], ...(req ? { req } : {}) });
    tasks.refold(code, r.readAll());
  });
}

function record(r: ReturnType<typeof room.open>, t: TaskRecord) {
  const text = `#${t.id} "${t.subject}" ${t.op}${t.owner ? ` · ${t.owner}` : ''} · ${t.status}${t.req ? ` (req #${t.req})` : ''}`;
  r.append({ kind: 'task', text, ...t }, { via: 'system', from: 'claude', system: true });
}

/** The room Claude's native task files, by id (read only). */
function nativeTasks(code: string): NativeTask[] {
  let names: string[] = [];
  try { names = fs.readdirSync(cc.tasksDir(listId(code))); } catch { return []; }
  return names.map(n => /^(\d+)\.json$/.exec(n)).filter(m => m !== null).map(m => readNative(code, m[1])).filter(t => t !== null)
    .sort((a, b) => Number(a.id) - Number(b.id));
}

/**
 * Appends an `add` snapshot for each native task the log has never recorded. A mirror run can be lost (the
 * shim's timeout, a failed node start, a hook skipped), and nothing else would ever write that task's entry.
 * Only ids with no `task` entry at all are restored: the native list can be wiped once every task is done and a
 * deleted task's file can linger, so a gap in the other direction or a differing status proves nothing.
 * The snapshot is the file's whole state and its metadata.req, the same fields a TaskCreate entry carries.
 */
function reconcile(code: string) {
  const natives = nativeTasks(code);
  if (!natives.length) return;
  const r = room.open(code);
  tasks.withList(code, () => {
    const seen = new Set(r.readAll().filter((e: { kind?: string; via?: string; task_id?: unknown }) => e.kind === 'task' && e.via === 'system' && e.task_id != null)
      .map((e: { task_id?: unknown }) => String(e.task_id)));
    let added = 0;
    for (const n of natives) {
      const id = String(n.id);
      if (seen.has(id) || internal(n) || tasks.isRoomTask(n, code) || n.status === 'deleted') continue;
      const req = tasks.metaReq(n.metadata) || reqNumber(n.description);
      record(r, { op: 'add', id, subject: String(n.subject || ''), owner: n.owner ? String(n.owner) : null,
        status: n.status || 'pending', blockedBy: Array.isArray(n.blockedBy) ? n.blockedBy.map(String) : [],
        ...(req ? { req } : {}) });
      added++;
    }
    if (added) tasks.refold(code, r.readAll());
  });
}

function gateHook(code: string, input: TasksIn) {
  const id = String(input.task_id || '');
  const native: NativeTask = readNative(code, id) || {};
  const log = room.open(code).readAll();
  const m: Partial<TaskState> = tasks.fold(log).find((t: TaskState) => t.id === id) || {};
  const task = {
    id,
    subject: input.task_subject || native.subject || m.subject || '',
    owner: native.owner !== undefined ? native.owner : m.owner,
    req: tasks.metaReq(native.metadata),
  };
  if (internal(native)) task.owner = 'room';
  const r = tasks.gate(code, task, log);
  if (r.ok) return;
  process.stderr.write(`${r.reason}\n${RETRY}\n`);
  process.exitCode = 2;
}

let input: TasksIn = {};
let code: string | null = null;
try {
  input = readInput();
  code = roomClaudeRoom(input);
} catch { code = null; }
if (code) {
  try {
    if (input.hook_event_name === 'TaskCompleted') gateHook(code, input);
    else if (input.tool_name === 'TaskCreate' || input.tool_name === 'TaskUpdate') mirror(code, input);
  } catch (err) {
    if (input.hook_event_name === 'TaskCompleted') {
      process.stderr.write(`sub-human task gate failed closed: ${err instanceof Error ? err.message : err}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`sub-human tasks mirror: ${err instanceof Error && err.stack || err}\n`);
      process.exitCode = 1;
    }
  }
  // after the call's own entry, so that entry keeps its precise op; a failure here never changes the gate's verdict
  try { reconcile(code); } catch (err) { process.stderr.write(`sub-human tasks reconcile: ${err instanceof Error && err.stack || err}\n`); }
}
