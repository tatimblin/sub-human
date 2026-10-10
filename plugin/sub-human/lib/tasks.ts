/**
 * plugin/sub-human/lib/tasks.ts: the room's shared task list. The headless room Claude's own native task list
 * (CLAUDE_CODE_TASK_LIST_ID=sh-CODE) is the room's list. Members ask for changes with the `task` tool
 * (mcp/task.ts: a `task_req` log entry); the room's Claude applies them with native TaskCreate/TaskUpdate;
 * hooks/tasks.ts logs each applied change as a `task` entry and rewrites the room document `tasks` as fold() of
 * those entries, and gates TaskCompleted. Rows and the CLI read only that document (tasks.json in the room
 * directory), never ~/.claude. Zero dependencies.
 *
 *   list(code) -> [{id, subject, status, owner, blockedBy}]   the mirror, in id order ([] when absent)
 *   fold(entries) -> the same shape, from the `task` entries alone (each is a full snapshot; delete removes)
 *   refold(code, entries) -> writes fold(entries) as tasks.json (deleting the file and refolding gives it back)
 *   metaReq(metadata) -> the req log id in a native task's metadata ({req, by}) or null
 *   summary(code, viewer) -> "tasks 3 open · #2 you · #4 bob" ('' with no tasks; "tasks: all N done")
 *   mine(code, name) -> open tasks owned by name (for a participant row: `◼ #2 parser tests`)
 *   validate(req) -> {ok:true, req} | {ok:false, error}      the `task` tool's arguments
 *   gate(code, task, log, {closing}?) -> {ok:true, req?} | {ok:false, reason}   TaskCompleted rule (task.req: a hint)
 *   reqOf(e) -> {op, id, subject, detail, evidence, owner, by}   a task_req entry's fields
 *   requestText(req) -> one-line text for a task_req entry
 *   isRoomTask(t, code?), isClosing(code), writeList(code, tasks), withList(code, fn) (the mirror's lock)
 *
 * Log entries (room.ts stores the caller's task `id` as `task_id`, since `id` is the entry's own id):
 *   task_req (via agent): {kind:'task_req', from = by = requester, text, op, task_id, subject, detail, evidence, owner}
 *   task (via system, from claude): {kind:'task', text, op, task_id, subject, owner, status, blockedBy, req}
 *
 * The room's Claude links a native task to the request it applies with metadata {req: <log id>, by: <name>} (TaskCreate and
 * TaskUpdate both take metadata; TaskUpdate merges it).
 *
 * The room-open task: the room Claude's first act is TaskCreate "room CODE open" (in_progress, owner room). It keeps the
 * native list from being wiped while other tasks are done. The gate refuses to complete it unless the room is
 * closing (members.json `closing`, set by the reaper); the mirror and summary leave it out.
 */

import * as identity from './identity.ts';
import { clip, NAME_RE } from './text.ts';
import * as config from './config.ts';
import { humanTrust } from './room/store.ts';
import * as room from './room.ts';
import type { Task, TaskReq } from './types-app.ts';
import type { Entry, Members } from './room/types.ts';

/** A task as it arrives to be cleaned (the mirror, a fold, hooks/tasks.ts's native task): loosely shaped. */
interface RawTask {
  id?: unknown;
  subject?: string;
  status?: string;
  owner?: string | null;
  blockedBy?: unknown;
}
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
type GateResult = { ok: true, req?: Entry } | { ok: false, reason: string };

const OPS = ['add', 'claim', 'release', 'done'];
const SUBJECT_MAX = config.TASK_SUBJECT_MAX;
const DETAIL_MAX = config.TASK_DETAIL_MAX;
const EVIDENCE_MAX = config.TASK_EVIDENCE_MAX;
const SUMMARY_ITEMS = 3;
const OPEN = new Set(['pending', 'in_progress']);

/** The mirror is the room document `tasks` (lib/room/store.ts kv; tasks.json on disk). */
const kvOf = (code: string) => room.open(code).store.kv;
/** Run fn under the mirror's lock (hooks/tasks.ts: read the log, append, refold, as one step). */
const withList = <T>(code: string, fn: () => T): T => kvOf(code).lock('tasks', fn);
/** Claude Code's task store for a list id (read only; the plugin never writes there). */

const idNum = (id: unknown) => Number(id);
const byId = (a: RawTask, b: RawTask) => idNum(a.id) - idNum(b.id) || String(a.id).localeCompare(String(b.id));

function isRoomTask(t: RawTask | null | undefined, code?: string): boolean {
  if (!t) return false;
  if (t.owner === 'room') return true;
  const s = String(t.subject || '');
  return code ? s === `room ${code} open` : /^room \S+ open$/.test(s);
}

function list(code: string): Task[] {
  let v: unknown = [];
  try { v = kvOf(code).get('tasks', []); } catch { v = []; }
  return Array.isArray(v) ? v.filter(t => t && t.id != null).sort(byId) : [];
}

const clean = (tasks: (RawTask | null | undefined)[], code?: string): Task[] => tasks.filter((t): t is RawTask => !!t && t.id != null && !isRoomTask(t, code)).map(t => ({
  id: String(t.id), subject: String(t.subject || ''), status: t.status || 'pending',
  owner: t.owner || null, blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy.map(String) : [],
})).sort(byId);

function writeList(code: string, tasks: (RawTask | null | undefined)[]): Task[] {
  const c = clean(tasks, code);
  kvOf(code).set('tasks', c);
  return c;
}

/** The mirror as a pure fold of the log's `task` entries (via system). Each entry is the task's whole state. */
function fold(entries: (Entry | null | undefined)[] | null | undefined): Task[] {
  const m = new Map<string, RawTask>();
  for (const e of entries || []) {
    if (!e || e.kind !== 'task' || e.via !== 'system' || e.task_id == null) continue;
    const id = String(e.task_id);
    if (e.op === 'delete' || e.status === 'deleted') { m.delete(id); continue; }
    m.set(id, { id, subject: e.subject || '', status: e.status || 'pending', owner: e.owner || null, blockedBy: e.blockedBy || [] });
  }
  return clean([...m.values()]);
}

const refold = (code: string, entries: Entry[]): Task[] => writeList(code, fold(entries));

/** metadata.req as a log id (a positive integer, or its digits), else null. */
function metaReq(md: unknown): number | null {
  const n = md && typeof md === 'object' ? Number((md as { req?: unknown }).req) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

const isOpen = (t: Task) => OPEN.has(t.status || 'pending');
const mine = (code: string, name: string): Task[] => list(code).filter(t => isOpen(t) && t.owner === name);

function summary(code: string, viewer: string | null | undefined): string {
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

/** The `task` tool's arguments: {op, id?, subject?, detail?, evidence?, for?}. Returns the normalized req. */
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
  if (req.for != null && req.for !== '') {
    if (typeof req.for !== 'string' || !NAME_RE.test(req.for)) return no(`invalid name in for: "${req.for}"`);
    if (['room', 'claude', 'all', 'system'].includes(req.for.toLowerCase())) return no(`"${req.for}" cannot own a task`);
    out.for = req.for;
  }
  return { ok: true, req: out };
}

/** r: a validate()d req (done always carries evidence) plus its owner. */
function requestText(r: TaskReq & { owner?: string | null }): string {
  const who = r.owner ? ` for ${r.owner}` : '';
  if (r.op === 'add') return `task add${who}: ${r.subject}${r.detail ? ` (${clip(r.detail.replace(/\s+/g, ' '), config.TASK_REQ_DETAIL_SHOWN)})` : ''}`;
  if (r.op === 'done') return `task done #${r.id}${who}: ${clip(r.evidence!.replace(/\s+/g, ' '), config.TASK_REQ_EVIDENCE_SHOWN)}`;
  return `task ${r.op} #${r.id}${who}`;
}

/** A task_req or task entry's task fields (the task id is the entry's task_id). */
function reqOf(e: Partial<Entry> | null | undefined): ReqFields {
  const t: Partial<Entry> = e || {};
  return {
    op: t.op, id: t.task_id == null ? null : String(t.task_id), subject: t.subject || null, detail: t.detail || null,
    evidence: t.evidence || null, owner: t.owner || null, status: t.status || null, req: t.req || null,
    by: t.by || t.from || null,
  };
}

// ---------- the TaskCompleted gate ----------
function isClosing(code: string): boolean {
  // members.json, plus the older room-wide closing marks (a top-level `closing`, `_room`)
  let m: Members & { closing?: unknown } = {};
  try { m = identity.readMembers(code) || {}; } catch { return false; }
  return !!(m.closing || (m.claude && m.claude.closing) || (m._room && m._room.closing));
}

const cites = (e: Entry, reqId: number) => (e.refs || []).includes(reqId) || new RegExp(`(^|[^\\d])#${reqId}(?!\\d)`).test(String(e.text || ''));

/**
 * May the room's Claude complete `task` ({id, subject, owner, req?})? Only on a task_req{op:'done', id} with
 * evidence, newer than the last claim of that task, made by the owner's Claude or confirmed by the owner's own
 * [human] words citing that request. task.req (the native task's metadata.req) is tried first when it names
 * such a request. The room-open task completes only while the room is closing.
 */
function gate(code: string, task: (RawTask & { req?: unknown }) | null | undefined, log: Entry[] = [], { closing }: { closing?: boolean } = {}): GateResult {
  const id = String(task && task.id);
  if (isRoomTask(task, code)) {
    const c = closing === undefined ? isClosing(code) : closing;
    return c ? { ok: true } : { ok: false, reason: `#${id} is the room's open task; it stays open until the room closes` };
  }
  const owner = task && task.owner;
  if (!owner) return { ok: false, reason: `#${id} has no owner; someone must claim it, then ask for done with evidence` };
  const reqs = log.filter(e => e.kind === 'task_req' && reqOf(e).id === id);
  const lastClaim = reqs.filter(e => reqOf(e).op === 'claim').reduce((n, e) => Math.max(n, e.id), 0);
  const dones = reqs.filter(e => reqOf(e).op === 'done' && e.id > lastClaim && String(reqOf(e).evidence || '').trim()).reverse();
  const hint = dones.findIndex(e => e.id === Number(task.req));
  if (hint > 0) dones.unshift(...dones.splice(hint, 1));
  for (const d of dones) {
    if (d.from === owner) return { ok: true, req: d };
    const confirmed = log.some(e => e.via === 'human' && humanTrust(e) !== 'unverified' && e.from === owner && e.id > lastClaim && cites(e, d.id));
    if (confirmed) return { ok: true, req: d };
  }
  return { ok: false, reason: `only ${owner} may complete #${id}; ask them` };
}

export {
  OPS, list, fold, refold, metaReq, summary, mine, validate, gate, reqOf, requestText, isRoomTask, isClosing,
  writeList, withList,
};
export type { RawTask };
