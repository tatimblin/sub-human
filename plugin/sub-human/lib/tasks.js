'use strict';
/**
 * plugin/sub-human/lib/tasks.js: the room's shared task list. The headless orch's own native task list
 * (CLAUDE_CODE_TASK_LIST_ID=sh-CODE) is the room's list. Members ask for changes with the `task` tool
 * (mcp/task.js: a `task_req` log entry); the orch applies them with native TaskCreate/TaskUpdate;
 * hooks/tasks.js logs each applied change as a `task` entry and rewrites <room>/tasks.json as fold() of those
 * entries, and gates TaskCompleted. Rows and the CLI read only <room>/tasks.json, never ~/.claude. Zero dependencies.
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
 *   isRoomTask(t, code?), isClosing(code), writeList(code, tasks), listPath(code), nativeDir(listId)
 *
 * Log entries (room.js stores the caller's task `id` as `task_id`, since `id` is the entry's own id):
 *   task_req (via agent): {kind:'task_req', from = by = requester, text, op, task_id, subject, detail, evidence, owner}
 *   task (via system, from orch): {kind:'task', text, op, task_id, subject, owner, status, blockedBy, req}
 *
 * The orch links a native task to the request it applies with metadata {req: <log id>, by: <name>} (TaskCreate and
 * TaskUpdate both take metadata; TaskUpdate merges it).
 *
 * The room-open task: the orch's first act is TaskCreate "room CODE open" (in_progress, owner room). It keeps the
 * native list from being wiped while other tasks are done. The gate refuses to complete it unless the room is
 * closing (members.json `closing`, set by the reaper); the mirror and summary leave it out.
 */

const path = require('node:path');
const identity = require('./identity.js');
const cc = require('./cc.js');
const { readJson, writeJsonAtomic } = require('./io.js');
const { clip, NAME_RE } = require('./text.js');
const config = require('./config.js');
const { humanTrust } = require('./room/store.js');

const OPS = ['add', 'claim', 'release', 'done'];
const SUBJECT_MAX = config.TASK_SUBJECT_MAX;
const DETAIL_MAX = config.TASK_DETAIL_MAX;
const EVIDENCE_MAX = config.TASK_EVIDENCE_MAX;
const SUMMARY_ITEMS = 3;
const OPEN = new Set(['pending', 'in_progress']);

const listPath = code => path.join(identity.roomDir(code), 'tasks.json');
/** Claude Code's task store for a list id (read only; the plugin never writes there). */
const nativeDir = listId => cc.tasksDir(listId);

const idNum = id => Number(id);
const byId = (a, b) => idNum(a.id) - idNum(b.id) || String(a.id).localeCompare(String(b.id));

function isRoomTask(t, code) {
  if (!t) return false;
  if (t.owner === 'room') return true;
  const s = String(t.subject || '');
  return code ? s === `room ${code} open` : /^room \S+ open$/.test(s);
}

function list(code) {
  const v = readJson(listPath(code), []);
  return Array.isArray(v) ? v.filter(t => t && t.id != null).sort(byId) : [];
}

const clean = (tasks, code) => tasks.filter(t => t && t.id != null && !isRoomTask(t, code)).map(t => ({
  id: String(t.id), subject: String(t.subject || ''), status: t.status || 'pending',
  owner: t.owner || null, blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy.map(String) : [],
})).sort(byId);

function writeList(code, tasks) {
  const c = clean(tasks, code);
  writeJsonAtomic(listPath(code), c);
  return c;
}

/** The mirror as a pure fold of the log's `task` entries (via system). Each entry is the task's whole state. */
function fold(entries) {
  const m = new Map();
  for (const e of entries || []) {
    if (!e || e.kind !== 'task' || e.via !== 'system' || e.task_id == null) continue;
    const id = String(e.task_id);
    if (e.op === 'delete' || e.status === 'deleted') { m.delete(id); continue; }
    m.set(id, { id, subject: e.subject || '', status: e.status || 'pending', owner: e.owner || null, blockedBy: e.blockedBy || [] });
  }
  return clean([...m.values()]);
}

const refold = (code, entries) => writeList(code, fold(entries));

/** metadata.req as a log id (a positive integer, or its digits), else null. */
function metaReq(md) {
  const n = md && typeof md === 'object' ? Number(md.req) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

const isOpen = t => OPEN.has(t.status || 'pending');
const mine = (code, name) => list(code).filter(t => isOpen(t) && t.owner === name);

function summary(code, viewer) {
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
const str = v => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());

/** The `task` tool's arguments: {op, id?, subject?, detail?, evidence?, for?}. Returns the normalized req. */
function validate(req) {
  const no = error => ({ ok: false, error });
  if (!req || typeof req !== 'object') return no('task needs {op}');
  const op = req.op;
  if (!OPS.includes(op)) return no(`op must be one of ${OPS.join(', ')}`);
  const out = { op };
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
    if (['room', 'orch', 'all', 'system'].includes(req.for.toLowerCase())) return no(`"${req.for}" cannot own a task`);
    out.for = req.for;
  }
  return { ok: true, req: out };
}

function requestText(r) {
  const who = r.owner ? ` for ${r.owner}` : '';
  if (r.op === 'add') return `task add${who}: ${r.subject}${r.detail ? ` (${clip(r.detail.replace(/\s+/g, ' '), config.TASK_REQ_DETAIL_SHOWN)})` : ''}`;
  if (r.op === 'done') return `task done #${r.id}${who}: ${clip(r.evidence.replace(/\s+/g, ' '), config.TASK_REQ_EVIDENCE_SHOWN)}`;
  return `task ${r.op} #${r.id}${who}`;
}

/** A task_req or task entry's task fields (the task id is the entry's task_id). */
function reqOf(e) {
  const t = e || {};
  return {
    op: t.op, id: t.task_id == null ? null : String(t.task_id), subject: t.subject || null, detail: t.detail || null,
    evidence: t.evidence || null, owner: t.owner || null, status: t.status || null, req: t.req || null,
    by: t.by || t.from || null,
  };
}

// ---------- the TaskCompleted gate ----------
function isClosing(code) {
  let m = {};
  try { m = identity.readMembers(code) || {}; } catch { return false; }
  return !!(m.closing || (m.orch && m.orch.closing) || (m._room && m._room.closing));
}

const retracted = log => new Set(log.filter(e => e.kind === 'retract' && e.via === 'system').flatMap(e => e.refs || []));
const cites = (e, reqId) => (e.refs || []).includes(reqId) || new RegExp(`(^|[^\\d])#${reqId}(?!\\d)`).test(String(e.text || ''));

/**
 * May the orch complete `task` ({id, subject, owner, req?})? Only on an unretracted task_req{op:'done', id} with
 * evidence, newer than the last claim of that task, made by the owner's Claude or confirmed by the owner's own
 * [human] words citing that request. task.req (the native task's metadata.req) is tried first when it names
 * such a request. The room-open task completes only while the room is closing.
 */
function gate(code, task, log = [], { closing } = {}) {
  const id = String(task && task.id);
  if (isRoomTask(task, code)) {
    const c = closing === undefined ? isClosing(code) : closing;
    return c ? { ok: true } : { ok: false, reason: `#${id} is the room's open task; it stays open until the room closes` };
  }
  const owner = task && task.owner;
  if (!owner) return { ok: false, reason: `#${id} has no owner; someone must claim it, then ask for done with evidence` };
  const gone = retracted(log);
  const live = log.filter(e => !gone.has(e.id));
  const reqs = live.filter(e => e.kind === 'task_req' && reqOf(e).id === id);
  const lastClaim = reqs.filter(e => reqOf(e).op === 'claim').reduce((n, e) => Math.max(n, e.id), 0);
  const dones = reqs.filter(e => reqOf(e).op === 'done' && e.id > lastClaim && String(reqOf(e).evidence || '').trim()).reverse();
  const hint = dones.findIndex(e => e.id === Number(task.req));
  if (hint > 0) dones.unshift(...dones.splice(hint, 1));
  for (const d of dones) {
    if (d.from === owner) return { ok: true, req: d };
    const confirmed = live.some(e => e.via === 'human' && humanTrust(e) !== 'unverified' && e.from === owner && e.id > lastClaim && cites(e, d.id));
    if (confirmed) return { ok: true, req: d };
  }
  return { ok: false, reason: `only ${owner} may complete #${id}; ask them` };
}

module.exports = {
  OPS,
  list, fold, refold, metaReq, summary, mine, validate, gate, reqOf, requestText,
  isRoomTask, isClosing, writeList, listPath, nativeDir,
};
