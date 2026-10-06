#!/usr/bin/env node
'use strict';
/**
 * plugin/sub-human/hooks/tasks.js: the room task list's mirror and gate. Orch only: in any other session it
 * exits 0 at once, so members' private task lists are never touched.
 *
 * PostToolUse TaskCreate|TaskUpdate (mirror): appends a `task` entry via system
 *   {op: add|claim|release|done|update|delete, id, subject, owner, status, blockedBy, req} (the task's whole
 *   state after the call), then rewrites <room>/tasks.json as lib/tasks.js fold() of every `task` entry, so the
 *   file is derivable from the log alone. A refused call (tool_response.success false, or an error) is skipped.
 *   Fields come from tool_input and tool_response; what they leave unknown is read from the orch's native task
 *   file (cc.taskFile; read only, never written). req: tool_input.metadata.req, then the task file's
 *   metadata.req, then (tasks written before metadata) the description's "(req #14 by bob)" tag.
 *   The room-open task ("room CODE open", owner room) and _internal tasks are left out of both.
 * TaskCompleted (gate): exit 2 with the reason (shown to the orch) unless lib/tasks.js gate() passes. The
 *   input has no metadata, so owner and metadata come from the task file (which still has the old status).
 *   A refusal drops every field of that TaskUpdate, so the reason tells the orch to send status alone.
 *
 * The orch: the session resolves (common.js resolveSeat) to the room's orch seat, or (before binding)
 * SUB_HUMAN_ROOM is set and agent_type is sub-human:orchestrator.
 */

const path = require('node:path');
const LIB = path.join(__dirname, '..', 'lib');
const { readInput, resolveSeat } = require('./common.js');
const identity = require(path.join(LIB, 'identity.js'));
const room = require(path.join(LIB, 'room.js'));
const tasks = require(path.join(LIB, 'tasks.js'));
const cc = require(path.join(LIB, 'cc.js'));
const { readJson } = require(path.join(LIB, 'io.js'));
const { withLock } = require(path.join(LIB, 'lock.js'));

function orchRoom(input) {
  const me = resolveSeat(input);
  if (me) return me.role === 'orch' ? me.code : null;
  const code = process.env.SUB_HUMAN_ROOM;
  if (code && identity.CODE_RE.test(code) && input.agent_type === 'sub-human:orchestrator' && identity.roomExists(code)) return code;
  return null;
}

const listId = code => cc.taskListId() || `sh-${code}`;
const readNative = (code, id) => (/^\d+$/.test(String(id)) ? readJson(cc.taskFile(listId(code), id)) : null);
const internal = t => !!(t && t.metadata && t.metadata._internal);
const RETRY = 'Nothing in that TaskUpdate was saved. Resend its other fields without status; change status only in a TaskUpdate of its own.';

/** Legacy: the req number cited in a description, "(req #14 by bob)" or "evidence (#15): …"; the last wins. */
function reqNumber(desc) {
  const all = [...String(desc || '').matchAll(/(?:req #|evidence \(#)(\d+)/g)];
  return all.length ? Number(all.at(-1)[1]) : null;
}

function opFor(prev, next, created) {
  if (created) return 'add';
  if (next.status === 'deleted') return 'delete';
  if (next.status === 'completed' && (!prev || prev.status !== 'completed')) return 'done';
  if ((prev && prev.owner || null) !== next.owner) return next.owner ? 'claim' : 'release';
  return 'update';
}

const same = (a, b) => !!a && !!b && a.subject === b.subject && a.status === b.status && (a.owner || null) === (b.owner || null)
  && JSON.stringify(a.blockedBy || []) === JSON.stringify(b.blockedBy || []);

function mirror(code, input) {
  const resp = input.tool_response || {};
  if (resp.success === false || resp.error) return; // refused: the native list did not change
  const inp = input.tool_input || {};
  const created = input.tool_name === 'TaskCreate';
  const id = String(created ? (resp.task && resp.task.id) || '' : resp.taskId || inp.taskId || '');
  if (!/^\d+$/.test(id)) return;
  if (created && internal(inp)) return;

  room.bind(code);
  withLock(tasks.listPath(code) + '.lock', () => {
    const log = room.readAll();
    const prev = tasks.fold(log).find(t => t.id === id) || null;
    const native = readNative(code, id);
    if (internal(native)) return;
    const base = prev ? { ...prev } : native ? {
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
    const t = { op, id, subject: next.subject, owner: next.owner, status: op === 'delete' ? 'deleted' : next.status,
      blockedBy: next.blockedBy || [], ...(req ? { req } : {}) };
    const text = `#${t.id} "${t.subject}" ${t.op}${t.owner ? ` · ${t.owner}` : ''} · ${t.status}${t.req ? ` (req #${t.req})` : ''}`;
    room.append({ kind: 'task', text, ...t }, { via: 'system', from: 'orch', system: true });
    tasks.refold(code, room.readAll());
  });
}

function gateHook(code, input) {
  const id = String(input.task_id || '');
  const native = readNative(code, id) || {};
  room.bind(code);
  const log = room.readAll();
  const m = tasks.fold(log).find(t => t.id === id) || {};
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

let input = {};
let code = null;
try {
  input = readInput();
  code = orchRoom(input);
} catch { code = null; }
if (code) {
  try {
    if (input.hook_event_name === 'TaskCompleted') gateHook(code, input);
    else if (input.tool_name === 'TaskCreate' || input.tool_name === 'TaskUpdate') mirror(code, input);
  } catch (err) {
    if (input.hook_event_name === 'TaskCompleted') {
      process.stderr.write(`sub-human task gate failed closed: ${err && err.message}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`sub-human tasks mirror: ${err && err.stack || err}\n`);
      process.exitCode = 1;
    }
  }
}
