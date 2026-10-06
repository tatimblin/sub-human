#!/usr/bin/env node
'use strict';
/**
 * plugin/sub-human/hooks/tasks.js: the room task list's mirror and gate. Orch only: in any other session it
 * exits 0 at once, so members' private task lists are never touched.
 *
 * PostToolUse TaskCreate|TaskUpdate (mirror): applies the call to <room>/tasks.json
 *   ([{id, subject, status, owner, blockedBy}]) and appends a `task` entry via system
 *   {op: add|claim|release|done|update|delete, id, subject, owner, status, req}. A refused call
 *   (tool_response.success false, or an error) is skipped. Fields come from tool_input and tool_response;
 *   what they leave unknown is read from the orch's native task file (read only; never written).
 *   The room-open task ("room CODE open", owner room) is left out of both.
 * TaskCompleted (gate): exit 2 with the reason (shown to the orch) unless lib/tasks.js gate() passes.
 *
 * The orch: the session resolves to the room's orch seat, or (before binding) SUB_HUMAN_ROOM is set and
 * agent_type is sub-human:orchestrator.
 */

const fs = require('node:fs');
const path = require('node:path');
const LIB = path.join(__dirname, '..', 'lib');
const identity = require(path.join(LIB, 'identity.js'));
const room = require(path.join(LIB, 'room.js'));
const tasks = require(path.join(LIB, 'tasks.js'));
const { readJson, writeJsonAtomic } = require(path.join(LIB, 'io.js'));
const { withLock } = require(path.join(LIB, 'lock.js'));

function readInput() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  return raw.trim() ? JSON.parse(raw) : {};
}

function orchRoom(input) {
  let me = null;
  try { me = identity.resolveBySession(input.session_id); } catch { /* none */ }
  if (!me) { const pid = identity.claudePid(); if (pid) { try { me = identity.resolveByPid(pid); } catch { /* none */ } } }
  if (me) return me.role === 'orch' ? me.code : null;
  const code = process.env.SUB_HUMAN_ROOM;
  if (code && identity.CODE_RE.test(code) && input.agent_type === 'sub-human:orchestrator' && identity.roomExists(code)) return code;
  return null;
}

const listId = code => process.env.CLAUDE_CODE_TASK_LIST_ID || `sh-${code}`;
const readNative = (code, id) => (/^\d+$/.test(String(id)) ? readJson(path.join(tasks.nativeDir(listId(code)), `${id}.json`)) : null);
const roomIdsFile = code => path.join(identity.roomDir(code), 'tasks.room.json');
const roomIds = code => new Set((readJson(roomIdsFile(code), []) || []).map(String));
const internal = t => !!(t && t.metadata && t.metadata._internal);

/** The req number the orch cites in a description: "(req #14 by bob)" or "evidence (#15): …"; the last wins. */
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
  let logged = null;
  withLock(tasks.listPath(code) + '.lock', () => {
    const current = tasks.list(code);
    const prev = current.find(t => t.id === id) || null;
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

    const known = roomIds(code);
    if (known.has(id) || tasks.isRoomTask(next, code)) {
      if (!known.has(id)) writeJsonAtomic(roomIdsFile(code), [...known, id]);
      if (prev) tasks.writeList(code, current.filter(t => t.id !== id));
      return;
    }
    const op = opFor(prev, next, created);
    const rest = current.filter(t => t.id !== id);
    tasks.writeList(code, op === 'delete' ? rest : [...rest, next]);
    if (!created && same(prev, next)) return; // description-only change: no log entry
    const req = reqNumber(inp.description || (native && native.description));
    logged = { op, id, subject: next.subject, owner: next.owner, status: op === 'delete' ? 'deleted' : next.status, ...(req ? { req } : {}) };
  });
  if (!logged) return;
  const t = logged;
  const text = `#${t.id} "${t.subject}" ${t.op}${t.owner ? ` · ${t.owner}` : ''} · ${t.status}${t.req ? ` (req #${t.req})` : ''}`;
  room.append({ kind: 'task', text, ...t }, { via: 'system', from: 'orch', system: true });
}

function gateHook(code, input) {
  const id = String(input.task_id || '');
  const native = readNative(code, id) || {};
  const m = tasks.list(code).find(t => t.id === id) || {};
  const task = {
    id,
    subject: input.task_subject || native.subject || m.subject || '',
    owner: native.owner !== undefined ? native.owner : m.owner,
  };
  if (internal(native) || roomIds(code).has(id)) task.owner = 'room';
  room.bind(code);
  const r = tasks.gate(code, task, room.readAll());
  if (r.ok) return;
  process.stderr.write(r.reason + '\n');
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
