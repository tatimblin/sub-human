'use strict';
/**
 * plugin/sub-human/lib/tasks.js: the room's shared task list. The headless orch's own native task list
 * (CLAUDE_CODE_TASK_LIST_ID=sh-CODE) is the room's list. Members ask for changes with the `task` tool
 * (mcp/task.js: a `task_req` log entry); the orch applies them with native TaskCreate/TaskUpdate;
 * hooks/tasks.js mirrors the result to <room>/tasks.json and gates TaskCompleted. Rows and the CLI read only
 * <room>/tasks.json, never ~/.claude. Zero dependencies.
 *
 *   list(code) -> [{id, subject, status, owner, blockedBy}]   the mirror, in id order ([] when absent)
 *   summary(code, viewer) -> "tasks 3 open · #2 you · #4 bob" ('' with no tasks; "tasks: all N done")
 *   mine(code, name) -> open tasks owned by name (for a participant row: `◼ #2 parser tests`)
 *   validate(req) -> {ok:true, req} | {ok:false, error}      the `task` tool's arguments
 *   gate(code, task, log, {closing}?) -> {ok:true, req?} | {ok:false, reason}   TaskCompleted rule
 *   reqOf(e) -> {op, id, subject, detail, evidence, owner, by}   a task_req entry's fields
 *   requestText(req) -> one-line text for a task_req entry
 *   isRoomTask(t, code?), isClosing(code), writeList(code, tasks), listPath(code), nativeDir(listId)
 *
 * Log entries (room.js stores the caller's task `id` as `task_id`, since `id` is the entry's own id):
 *   task_req (via agent): {kind:'task_req', from = by = requester, text, op, task_id, subject, detail, evidence, owner}
 *   task (via system, from orch): {kind:'task', text, op, task_id, subject, owner, status, req}
 *
 * The room-open task: the orch's first act is TaskCreate "room CODE open" (in_progress, owner room). It keeps the
 * native list from being wiped while other tasks are done. The gate refuses to complete it unless the room is
 * closing (members.json `closing`, set by the reaper); the mirror and summary leave it out.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const identity = require('./identity.js');

const OPS = ['add', 'claim', 'release', 'done'];
const SUBJECT_MAX = 200;
const DETAIL_MAX = 2000;
const EVIDENCE_MAX = 2000;
const SUMMARY_ITEMS = 3;
const OPEN = new Set(['pending', 'in_progress']);

const listPath = code => path.join(identity.roomDir(code), 'tasks.json');
/** Claude Code's task store for a list id (read only; the plugin never writes there). */
const nativeDir = listId => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'tasks', String(listId));

const idNum = id => Number(id);
const byId = (a, b) => idNum(a.id) - idNum(b.id) || String(a.id).localeCompare(String(b.id));

function isRoomTask(t, code) {
  if (!t) return false;
  if (t.owner === 'room') return true;
  const s = String(t.subject || '');
  return code ? s === `room ${code} open` : /^room \S+ open$/.test(s);
}

function list(code) {
  const v = identity.readJson(listPath(code), []);
  return Array.isArray(v) ? v.filter(t => t && t.id != null).sort(byId) : [];
}

function writeList(code, tasks) {
  const clean = tasks.filter(t => t && t.id != null && !isRoomTask(t, code)).map(t => ({
    id: String(t.id), subject: String(t.subject || ''), status: t.status || 'pending',
    owner: t.owner || null, blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy.map(String) : [],
  })).sort(byId);
  identity.writeJsonAtomic(listPath(code), clean);
  return clean;
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
    if (typeof req.for !== 'string' || !identity.NAME_RE.test(req.for)) return no(`invalid name in for: "${req.for}"`);
    if (['room', 'orch', 'all', 'system'].includes(req.for.toLowerCase())) return no(`"${req.for}" cannot own a task`);
    out.for = req.for;
  }
  return { ok: true, req: out };
}

function requestText(r) {
  const who = r.owner ? ` for ${r.owner}` : '';
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  if (r.op === 'add') return `task add${who}: ${r.subject}${r.detail ? ` (${cut(r.detail.replace(/\s+/g, ' '), 200)})` : ''}`;
  if (r.op === 'done') return `task done #${r.id}${who}: ${cut(r.evidence.replace(/\s+/g, ' '), 400)}`;
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
 * May the orch complete `task` ({id, subject, owner})? Only on an unretracted task_req{op:'done', id} with
 * evidence, newer than the last claim of that task, made by the owner's Claude or confirmed by the owner's own
 * [human] words citing that request. The room-open task completes only while the room is closing.
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
  const dones = reqs.filter(e => reqOf(e).op === 'done' && e.id > lastClaim && String(reqOf(e).evidence || '').trim());
  for (const d of dones.reverse()) {
    if (d.from === owner) return { ok: true, req: d };
    const confirmed = live.some(e => e.via === 'human' && e.from === owner && e.id > lastClaim && cites(e, d.id));
    if (confirmed) return { ok: true, req: d };
  }
  return { ok: false, reason: `only ${owner} may complete #${id}; ask them` };
}

module.exports = {
  OPS, SUBJECT_MAX, DETAIL_MAX, EVIDENCE_MAX,
  list, summary, mine, validate, gate, reqOf, requestText,
  isRoomTask, isClosing, writeList, listPath, nativeDir,
};
