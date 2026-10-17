/**
 * plugin/sub-human/lib/tasks.ts: the room's shared task list. The log is the truth: a member's Claude asks with the
 * `task` tool (mcp/task.ts), and the host applies the request at once (apply), under the room's `tasks` lock: a
 * refusal comes back at once, an accepted request is two log entries (the task_req, via agent, and the task's whole
 * new state, a `task` entry via system from `room`). Then the host projects the fold into the room session's native
 * task files (lib/room/task-files.ts project), which the room session shows, and rewrites the room document `tasks`
 * (tasks.json), which the rows, the status line and the CLI read. A member on another machine asks the same way: the
 * link's `task` op (lib/remote/server.ts) runs apply on the host. A member's own TaskCreate stays in their own list.
 *
 *   foldAll(entries) -> [FoldedTask]   the `task` entries (each a full snapshot), the room task and deleted ones kept
 *   fold(entries) -> [Task]            the list as people see it: no room task, nothing deleted (tasks.json)
 *   list(code) -> [Task]               tasks.json, in id order ([] when absent)
 *   refold(code, entries)              writes fold(entries) as tasks.json
 *   summary(code, viewer) -> "tasks 3 open · #2 you · #4 bob" ('' with no tasks; "tasks: all N done")
 *   mine(code, name) -> open tasks owned by name (a participant row: `◼ #2 parser tests`)
 *   validate(input) -> {ok:true, req} | {ok:false, error}   the `task` tool's arguments
 *   check(task, req, by) -> null | reason   the ownership rules, pure (below)
 *   apply(store, input, {by}) -> {ok:true, task, text} | {ok:false, error}   host only (HOST_ONLY otherwise)
 *   openRoomTask(store) / closeRoomTask(store)   the room task: written with the room's first task request (or
 *       openRoomTask), completed by the reaper at close (lib/room-claude.ts), never by a member
 *   repair(store) -> {wrote, removed}  project the log again (the room session's tail, every health tick)
 *   reqOf(e), requestText(req), isRoomTask(t, code?)
 *
 * The rules (check): add, by anyone (suggest names a suggested owner, recorded, never the owner); claim, only for
 * yourself, refused while someone else owns it; release and done, the owner only; done needs evidence. The room task
 * ("room CODE open", owner room) takes no request: it stays in_progress while the room is open, which keeps Claude
 * Code's list reset (every task completed: every file deleted) from firing.
 *
 * Log entries (room.ts stores the caller's task `id` as `task_id`, since `id` is the entry's own id):
 *   task_req (via agent): {kind:'task_req', from = by = requester, text, op, task_id, subject, detail, evidence, owner, suggest}
 *   task (via system, from room): {kind:'task', text, op, task_id, subject, detail, owner, status, blockedBy, req, suggest}
 */

import { clip, NAME_RE } from './text.ts';
import * as config from './config.ts';
import * as room from './room.ts';
import * as taskFiles from './room/task-files.ts';
import { RoomError } from './room/validate.ts';
import type { FoldedTask, Task, TaskReq } from './types-app.ts';
import type { Entry, EntryInput, KvApi, RoomStore } from './room/types.ts';
import type { Room } from './room.ts';
import type { RoomCode, SeatName } from './brand.ts';

/** reqOf: a task_req or task entry's task fields. */
interface ReqFields {
  op: string | undefined;
  id: string | null;
  subject: string | null;
  detail: string | null;
  evidence: string | null;
  owner: string | null;
  status: string | null;
  req: number | null;
  by: string | null;
}
/** What apply answers: the task after the request, and a line for the requester's Claude; or why not. */
type Applied = { ok: true, task: FoldedTask, text: string } | { ok: false, error: string };

const OPS: readonly string[] = ['add', 'claim', 'release', 'done'];
const SUBJECT_MAX = config.TASK_SUBJECT_MAX;
const DETAIL_MAX = config.TASK_DETAIL_MAX;
const EVIDENCE_MAX = config.TASK_EVIDENCE_MAX;
const SUMMARY_ITEMS = 3;
const OPEN = new Set(['pending', 'in_progress']);
/** Who writes the `task` entries: the room itself (via system). */
const ROOM = 'room';
/** Names that never own a task. */
const NOT_OWNERS = ['room', 'claude', 'all', 'system'];

const kvOf = (code: RoomCode) => room.open(code).store.kv;

const idNum = (id: unknown) => Number(id);
const byId = (a: { id: unknown }, b: { id: unknown }) => idNum(a.id) - idNum(b.id) || String(a.id).localeCompare(String(b.id));

function isRoomTask(t: { owner?: string | null; subject?: string | null } | null | undefined, code?: string): boolean {
  if (!t) return false;
  if (t.owner === ROOM) return true;
  const s = String(t.subject || '');
  return code ? s === `room ${code} open` : /^room \S+ open$/.test(s);
}
const roomTaskSubject = (code: RoomCode): string => `room ${code} open`;

function list(code: RoomCode): Task[] {
  let v: Task[] | null = [];
  try { v = kvOf(code).get<Task[]>('tasks', []); } catch { v = []; }
  return Array.isArray(v) ? v.filter(t => t && t.id != null).sort(byId) : [];
}

/** Every task the log's `task` entries (via system) describe, each entry the task's whole state. */
function foldAll(entries: readonly (Entry | null | undefined)[] | null | undefined): FoldedTask[] {
  const m = new Map<string, FoldedTask>();
  for (const e of entries ?? []) {
    if (!e || e.kind !== 'task' || e.via !== 'system' || e.task_id == null) continue;
    const id = String(e.task_id);
    const t: FoldedTask = {
      id, subject: e.subject || '', status: e.op === 'delete' ? 'deleted' : e.status || 'pending', owner: e.owner || null,
      blockedBy: (e.blockedBy ?? []).map(String),
    };
    if (e.detail) t.detail = e.detail;
    if (typeof e.req === 'number') t.req = e.req;
    if (e.by) t.by = e.by;
    if (e.suggest) t.suggest = e.suggest;
    m.set(id, t);
  }
  return [...m.values()].sort(byId);
}

/** The list as people see it: the room task and deleted tasks left out. */
const fold = (entries: readonly (Entry | null | undefined)[] | null | undefined): Task[] => foldAll(entries)
  .filter(t => t.status !== 'deleted' && !isRoomTask(t))
  .map(t => ({ id: t.id, subject: t.subject, status: t.status, owner: t.owner, blockedBy: t.blockedBy }));

function refold(code: RoomCode, entries: readonly Readonly<Entry>[], kv: KvApi = kvOf(code)): Task[] {
  const t = fold(entries);
  kv.set('tasks', t);
  return t;
}

const isOpen = (t: Task) => OPEN.has(t.status || 'pending');
const mine = (code: RoomCode, name: SeatName): Task[] => list(code).filter(t => isOpen(t) && t.owner === name);

function summary(code: RoomCode, viewer: string | null | undefined): string {
  const all = list(code).filter(t => !isRoomTask(t, code));
  if (!all.length) return '';
  const open = all.filter(isOpen);
  if (!open.length) return `tasks: all ${all.length} done`;
  const owned = open.filter(t => t.owner);
  const items = owned.slice(0, SUMMARY_ITEMS).map(t => `#${t.id} ${t.owner === viewer ? 'you' : t.owner}`);
  if (owned.length > SUMMARY_ITEMS) items.push(`+${owned.length - SUMMARY_ITEMS}`);
  return [`tasks ${open.length} open`, ...items].join(' · ');
}

// ---------- requests ----------
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());

/** The `task` tool's arguments: {op, id?, subject?, detail?, evidence?, suggest?}. Returns the normalized req. */
function validate(input: unknown): { ok: true, req: TaskReq } | { ok: false, error: string } {
  const no = (error: string) => ({ ok: false as const, error });
  if (!input || typeof input !== 'object') return no('task needs {op}');
  const req = input as Record<string, unknown>; // the tool's arguments: each field is checked below
  const op = req.op;
  if (typeof op !== 'string' || !OPS.includes(op)) return no(`op must be one of ${OPS.join(', ')}`);
  const out: TaskReq = { op };
  if (op === 'add') {
    const subject = str(req.subject);
    if (!subject) return no('add needs a subject');
    if (subject.length > SUBJECT_MAX) return no(`subject is over ${SUBJECT_MAX} chars; put the rest in detail`);
    out.subject = subject.replace(/\s+/g, ' ');
  } else {
    const id = str(req.id);
    if (!/^[1-9]\d{0,8}$/.test(id)) return no(`${op} needs the task id (a number, as in #3)`);
    out.id = id;
  }
  const detail = str(req.detail);
  if (detail) {
    if (detail.length > DETAIL_MAX) return no(`detail is over ${DETAIL_MAX} chars`);
    out.detail = detail;
  }
  const evidence = str(req.evidence);
  if (op === 'done' && !evidence) return no('done needs evidence: what shows it is done (a test run, a commit, a file)');
  if (evidence) {
    if (evidence.length > EVIDENCE_MAX) return no(`evidence is over ${EVIDENCE_MAX} chars`);
    out.evidence = evidence;
  }
  if (req.suggest != null && req.suggest !== '') {
    if (op !== 'add') return no('suggest goes with add only: claim a task for yourself instead');
    if (typeof req.suggest !== 'string' || !NAME_RE.test(req.suggest)) return no(`invalid name in suggest: "${String(req.suggest)}"`);
    if (NOT_OWNERS.includes(req.suggest.toLowerCase())) return no(`"${req.suggest}" cannot own a task`);
    out.suggest = req.suggest;
  }
  return { ok: true, req: out };
}

/** r: a validate()d req (done always carries evidence) plus its owner. */
function requestText(r: TaskReq & { owner?: string | null }): string {
  const who = r.owner ? ` for ${r.owner}` : r.suggest ? ` (suggested: ${r.suggest})` : '';
  if (r.op === 'add') return `task add${who}: ${r.subject}${r.detail ? ` (${clip(r.detail.replace(/\s+/g, ' '), config.TASK_REQ_DETAIL_SHOWN)})` : ''}`;
  // validate: done always carries evidence
  if (r.op === 'done') return `task done #${r.id}: ${clip((r.evidence ?? '').replace(/\s+/g, ' '), config.TASK_REQ_EVIDENCE_SHOWN)}`;
  return `task ${r.op} #${r.id}${who}`;
}

/** A task_req or task entry's task fields (the task id is the entry's task_id). */
function reqOf(e: Partial<Entry> | null | undefined): ReqFields {
  const t: Partial<Entry> = e ?? {};
  return {
    op: t.op, id: t.task_id == null ? null : String(t.task_id), subject: t.subject || null, detail: t.detail || null,
    evidence: t.evidence || null, owner: t.owner || null, status: t.status || null, req: t.req || null,
    by: t.by || t.from || null,
  };
}

// ---------- the rules ----------
/** Why by may not make request req of task (null: it may). task: the task as the log has it now (null: none). */
function check(task: FoldedTask | null, req: TaskReq, by: string): string | null {
  if (req.op === 'add') return null;
  const id = `#${req.id}`;
  if (!task || task.status === 'deleted') return `no task ${id} in this room`;
  if (isRoomTask(task)) return `${id} is the room's open task; it stays open until the room closes`;
  if (task.status === 'completed') return `${id} is done already`;
  if (req.op === 'claim') return task.owner && task.owner !== by ? `${id} is ${task.owner}'s; ask them to release it` : null;
  if (!task.owner) return req.op === 'done' ? `${id} has no owner; claim it first, then ask for done with evidence` : `${id} has no owner to release it`;
  if (task.owner !== by) return `only ${task.owner} may ${req.op === 'done' ? 'complete' : 'release'} ${id}; ask them`;
  return null;
}

/** The task after an accepted request. */
function after(task: FoldedTask | null, req: TaskReq, by: string, id: string): FoldedTask {
  if (req.op === 'add' || !task) {
    return { id, subject: req.subject ?? '', status: 'pending', owner: null, blockedBy: [], ...(req.detail ? { detail: req.detail } : {}), by, ...(req.suggest ? { suggest: req.suggest } : {}) };
  }
  if (req.op === 'claim') return { ...task, owner: by, status: 'in_progress' };
  if (req.op === 'release') return { ...task, owner: null, status: 'pending' };
  return { ...task, status: 'completed' };
}

/** The `task` entry for t (its whole state; t.req: the request that made it, none for the room's own). */
function taskEntry(t: FoldedTask, op: string): EntryInput {
  const text = `#${t.id} "${t.subject}" ${op}${t.owner ? ` · ${t.owner}` : ''} · ${t.status}${t.req ? ` (req #${t.req})` : ''}`;
  return {
    kind: 'task', text, op, id: t.id, subject: t.subject, status: t.status, owner: t.owner, blockedBy: t.blockedBy,
    ...(t.detail ? { detail: t.detail } : {}), ...(t.req ? { req: t.req } : {}), ...(t.suggest ? { suggest: t.suggest } : {}),
  };
}

/** The log read under the lock, the task appended, then the projection and tasks.json (a failed projection is
 * repaired by the next one: the log has it). */
function finish(store: RoomStore, entries: Entry[]): void {
  const all = foldAll(entries);
  try { taskFiles.project(store.code, all); } catch { /* repair() writes it again */ }
  refold(store.code, entries, store.kv);
}

function apply(store: RoomStore, input: unknown, { by }: { by: string }): Applied {
  if (!store.isHost) throw new RoomError('HOST_ONLY', 'only the host applies a room task request');
  const v = validate(input);
  if (!v.ok) return { ok: false, error: v.error };
  const req = v.req;
  const r = room.open(store.code, { store });
  return store.lock('tasks', (): Applied => {
    const entries = [...r.readRecent()]; // task entries are non-chat: every one is in the recent view
    const all = foldAll(entries);
    const task = req.id ? all.find(t => t.id === req.id) ?? null : null;
    const why = check(task, req, by);
    if (why) return { ok: false, error: why };
    roomTaskIn(r, store, entries); // the room's first task request opens the room task first
    const id = req.op === 'add' ? taskFiles.nextId(store.code, foldAll(entries)) : String(req.id);
    const owner = req.op === 'claim' ? by : task ? task.owner : null;
    const ask = r.append({ kind: 'task_req', text: requestText({ ...req, ...(req.op === 'add' ? {} : { id }) }), op: req.op, id,
      ...(req.subject ? { subject: req.subject } : {}), ...(req.detail ? { detail: req.detail } : {}), ...(req.evidence ? { evidence: req.evidence } : {}),
      ...(owner && req.op === 'claim' ? { owner } : {}), ...(req.suggest ? { suggest: req.suggest } : {}) }, { via: 'agent', from: by });
    const next = { ...after(task, req, by, id), req: ask.id };
    entries.push(ask, r.append(taskEntry(next, req.op), { via: 'system', from: ROOM, system: true }));
    finish(store, entries);
    const what = req.op === 'add' ? `added #${id} "${next.subject}"${next.suggest ? ` (suggested owner: ${next.suggest}; they claim it)` : ''}`
      : req.op === 'claim' ? `#${id} is yours now (in progress)` : req.op === 'release' ? `released #${id}; nobody owns it now` : `#${id} done`;
    return { ok: true, task: next, text: what };
  });
}

/** The room task in entries, appended (and pushed onto entries) when none is open: "room CODE open", owner room,
 * in_progress. The caller holds the room's tasks lock. */
function roomTaskIn(r: Room, store: RoomStore, entries: Entry[]): FoldedTask {
  const all = foldAll(entries);
  const had = all.find(t => isRoomTask(t, store.code) && t.status !== 'deleted');
  if (had && had.status !== 'completed') return had;
  const t: FoldedTask = { id: had ? had.id : taskFiles.nextId(store.code, all), subject: roomTaskSubject(store.code), status: 'in_progress', owner: ROOM, blockedBy: [] };
  entries.push(r.append(taskEntry(t, had ? 'update' : 'add'), { via: 'system', from: ROOM, system: true }));
  return t;
}

/** The room task, open (once per room: the first task request writes it, before its own task; a closed room's comes
 * back when it opens again). Its file keeps Claude Code's list reset from firing while the room is open. */
function openRoomTask(store: RoomStore): FoldedTask {
  const r = room.open(store.code, { store });
  return store.lock('tasks', () => {
    const entries = [...r.readRecent()];
    const t = roomTaskIn(r, store, entries);
    finish(store, entries);
    return t;
  });
}

/** The reaper's: the room task completed (the room closes; Claude Code may then reset the list). null: none open. */
function closeRoomTask(store: RoomStore): FoldedTask | null {
  const r = room.open(store.code, { store });
  return store.lock('tasks', () => {
    const entries = [...r.readRecent()];
    const open = foldAll(entries).find(t => isRoomTask(t, store.code) && t.status !== 'completed' && t.status !== 'deleted');
    if (!open) return null;
    const t: FoldedTask = { ...open, status: 'completed' };
    entries.push(r.append(taskEntry(t, 'done'), { via: 'system', from: ROOM, system: true }));
    finish(store, entries);
    return t;
  });
}

/** The projection again, from the log as it is: files lost, edited or deleted come back. */
function repair(store: RoomStore): { wrote: string[]; removed: string[] } {
  return taskFiles.project(store.code, foldAll(room.open(store.code, { store }).readRecent()));
}

export {
  OPS, list, foldAll, fold, refold, summary, mine, validate, check, apply, openRoomTask, closeRoomTask, repair, reqOf,
  requestText, isRoomTask,
};
export type { Applied };
