#!/usr/bin/env node
'use strict';
/**
 * plugin/sub-human/mcp/room-server.js: the room's stdio MCP server (JSON-RPC 2.0, one message per line).
 * Zero dependencies. Each Claude Code session runs its own copy, as a direct child of claude.
 *
 * Identity: the caller is the claude process that spawned us (cc CONTRACT mcp-stdio-ppid), so
 * me = identity.resolveByPid(process.ppid), a direct lookup, re-resolved on every call (the session joins after the
 * server starts). The model never names itself. Not joined -> every core tool returns "not in a room; run /sub-human".
 *
 * Core tools:
 *   post({kind, text, to?, refs?})   kinds: say question status; via "agent", from = the resolved member.
 *   read({ids?})   with ids: those entries in full. Without: this member's unseen entries (cursor mcp-<name>),
 *       skipping its own Claude's posts; at most 100, oldest first.
 *   propose({text|path, approvers?})   lib/proposal.create: stores plans/<hash>.md, appends `proposal`
 *       {hash, approvers, path}; approvers default to the humans present. Each approver answers a consent
 *       card (hooks/consent.js); a proposer who is also an approver is told to open the card now.
 *
 * Plug-ins: ./hold.js (rows) and ./task.js (the room task list) are loaded when present; a missing or broken
 * one is logged and skipped. Each exports create(ctx) -> {tools, call(name, me, args, meta), stop?,
 * anonymous?}. call returns a result or a Promise of one; meta = {id, progressToken}. A plug-in's tool is
 * called with me = null (instead of the "not in a room" error) only when its name is in `anonymous`.
 * Calls are routed to the plug-in that lists the tool (core names and earlier plug-ins win a clash).
 *
 * ctx (shared by every plug-in):
 *   send(msg)                         raw JSON-RPC to the client
 *   notify(method, params)            a notification
 *   request(method, params)           server->client request: a Promise of the result (rejects on error),
 *                                     with .id = the JSON-RPC request id
 *   cancelRequest(id, reason)         sends notifications/cancelled {requestId, reason}; the pending request
 *                                     rejects with {code:'CANCELLED'}
 *   progress(progressToken, progress, message)   notifications/progress (no-op without a token)
 *   onCancel(requestId, fn)           fn(reason) when the client cancels that tools/call (once)
 *   whoami()                          resolveByPid(process.ppid); me or null (each call opens me.code's Room)
 *   clientCaps()                      the client capabilities from initialize (e.g. .elicitation)
 *   room, identity, proposal          the libs
 *   text(s, isError)                  an MCP text result
 *   log(...a)                         $SUB_HUMAN_HOME/mcp-debug.log, only when SUB_HUMAN_DEBUG=1
 * A tools/call cancelled by the client gets no reply, even if its Promise settles later.
 */

const fs = require('node:fs');
const path = require('node:path');
const identity = require(path.join(__dirname, '..', 'lib', 'identity.js'));
const room = require(path.join(__dirname, '..', 'lib', 'room.js'));
const proposal = require(path.join(__dirname, '..', 'lib', 'proposal.js'));

const READ_MAX = 100;
const PLUGINS = ['hold.js', 'task.js'];
const POST_KINDS = ['say', 'question', 'status'];
// MCP revisions this server speaks (newest first): answer with the client's when listed, else our newest.
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const negotiateProtocol = v => (PROTOCOL_VERSIONS.includes(v) ? v : PROTOCOL_VERSIONS[0]);
// serverInfo.version follows the plugin manifest, so one bump versions both.
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version || '0.0.0';
  } catch { return '0.0.0'; }
})();

// ---------- transport ----------
let closed = false;
function send(msg) {
  if (closed) return;
  try { process.stdout.write(JSON.stringify(msg) + '\n'); } catch { shutdown(); }
}
process.stdout.on('error', () => shutdown());
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const text = (s, isError) => ({ content: [{ type: 'text', text: String(s) }], ...(isError ? { isError: true } : {}) });
const json = v => text(JSON.stringify(v));

function log(...a) {
  if (process.env.SUB_HUMAN_DEBUG !== '1') return;
  try {
    const line = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    fs.mkdirSync(identity.home(), { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(identity.home(), 'mcp-debug.log'), `${new Date().toISOString()} ${process.pid} ${line}\n`);
  } catch { /* debug only */ }
}

let plugins = [];
function shutdown() {
  if (closed) return;
  closed = true;
  for (const p of plugins) { try { if (typeof p.api.stop === 'function') p.api.stop(); } catch { /* exiting */ } }
  process.exit(0);
}

// ---------- server -> client requests ----------
const outgoing = new Map(); // our request id -> {resolve, reject}
let nextReq = 1;
function request(method, params) {
  const id = `sh-${process.pid}-${nextReq++}`;
  const p = new Promise((resolve, reject) => {
    outgoing.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
  p.id = id;
  return p;
}
function cancelRequest(id, reason) {
  send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, ...(reason ? { reason } : {}) } });
  const w = outgoing.get(id);
  if (w) { outgoing.delete(id); w.reject({ code: 'CANCELLED', message: reason || 'cancelled' }); }
}
const notify = (method, params) => send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
const progress = (progressToken, n, message) => {
  if (progressToken == null) return;
  notify('notifications/progress', { progressToken, progress: n, ...(message ? { message } : {}) });
};

// ---------- client -> server cancellation ----------
const cancelHandlers = new Map(); // tools/call id -> [fn]
const cancelled = new Set();      // tools/call ids the client cancelled: never reply to them
function onCancel(requestId, fn) {
  if (!cancelHandlers.has(requestId)) cancelHandlers.set(requestId, []);
  cancelHandlers.get(requestId).push(fn);
}

// ---------- identity ----------
/** A stdio server is spawned without a shell, so our parent is the claude process (cc CONTRACT mcp-stdio-ppid). */
function whoami() {
  const pid = process.ppid > 1 ? process.ppid : null;
  return pid ? identity.resolveByPid(pid) : null;
}

let clientCapabilities = {};
const ctx = {
  send, notify, request, cancelRequest, progress, onCancel, whoami,
  clientCaps: () => clientCapabilities,
  room, identity, proposal, text, log,
};

// ---------- core tools ----------
const CORE = [
  {
    name: 'post',
    title: 'Post to the room',
    description: 'Post a note to the shared sub-human room as your human\'s Claude (labelled as yours, never as their words). '
      + 'Members\' Claudes see it next turn; to reach one now, SendMessage it. For agreement use propose.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: POST_KINDS, description: 'say: a note; question: wants an answer; status: progress or done.' },
        text: { type: 'string', description: 'The note. Quote people exactly, no #ids.' },
        to: { type: 'string', description: 'One member it is for (the room still sees it).' },
        refs: { type: 'array', items: { type: 'integer' }, description: 'Room entry ids it cites.' },
      },
      required: ['kind', 'text'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'read',
    title: 'Read the room',
    description: `Read the shared sub-human room log: with ids, those entries in full (e.g. a cut-off line); without, your unseen entries, oldest first, at most ${READ_MAX}.`,
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'Entry ids; omit for unseen entries.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'propose',
    title: 'Propose for agreement',
    description: 'Ask people in the sub-human room to agree to a plan or decision (exactly one of text or path). '
      + 'Each approver answers a card in their own terminal; never report agreement until the room records it. Same content reopens the open proposal.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The proposal text.' },
        path: { type: 'string', description: 'A file (e.g. a plan) to propose instead of text.' },
        approvers: { type: 'array', items: { type: 'string' }, description: 'Who must answer; default every human.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

function post(me, args) {
  const { kind, text: body, to, refs } = args;
  if (!POST_KINDS.includes(kind)) {
    return text(`refused: kind must be one of ${POST_KINDS.join(', ')}. To ask for agreement, use propose; only people answer it, on their own card.`, true);
  }
  const entry = { kind, text: body };
  if (to !== undefined) entry.to = to;
  if (refs !== undefined) entry.refs = refs;
  return json(room.open(me.code).append(entry, { via: 'agent', from: me.name }));
}

function read(me, args) {
  if (args.ids !== undefined) {
    const ids = Array.isArray(args.ids) ? args.ids : [args.ids];
    if (!ids.length || !ids.every(i => Number.isInteger(Number(i)) && Number(i) > 0)) return text('ids must be positive integers', true);
    return json(room.open(me.code).readById(ids.map(Number)));
  }
  const r = room.open(me.code);
  const cursor = `mcp-${me.name}`;
  const all = r.readAfter(r.getCursor(cursor));
  if (all.length) r.setCursor(cursor, all.at(-1).id);
  const unseen = all.filter(e => !(e.from === me.name && e.via === 'agent'));
  return json(unseen.length > READ_MAX ? unseen.slice(-READ_MAX) : unseen);
}

function propose(me, args) {
  let r;
  try { r = proposal.create(me, args); } catch (e) {
    if (e instanceof proposal.ProposalError) return text(`refused: ${e.message}`, true);
    throw e;
  }
  const lines = [`proposal ${r.hash} ${r.again ? 'is already open' : 'proposed'} to ${r.approvers.join(', ')}. Text: ${r.path}`];
  lines.push('Each approver reads and answers it in their own terminal. Never say anyone agreed until the room records it.');
  if (r.approvers.includes(me.name)) lines.push(`${me.name} is an approver: ${proposal.openCall(r.hash)} now so ${me.name} can read and answer it.`);
  return text(lines.join('\n'));
}

// ---------- plug-ins ----------
function loadPlugins() {
  const out = [];
  for (const file of PLUGINS) {
    const full = path.join(__dirname, file);
    if (!fs.existsSync(full)) { log('plugin missing', file); continue; }
    try {
      const mod = require(full);
      const api = mod && typeof mod.create === 'function' ? mod.create(ctx) : null;
      if (!api || !Array.isArray(api.tools) || typeof api.call !== 'function') { log('plugin has no {tools, call}', file); continue; }
      out.push({ file, api, anonymous: new Set(Array.isArray(api.anonymous) ? api.anonymous : []) });
      log('plugin loaded', file, api.tools.map(t => t.name));
    } catch (e) {
      log('plugin failed', file, e && e.stack || String(e));
    }
  }
  return out;
}

function toolList() {
  const seen = new Set(CORE.map(t => t.name));
  const tools = [...CORE];
  for (const p of plugins) for (const t of p.api.tools) {
    if (!t || !t.name || seen.has(t.name)) continue;
    seen.add(t.name);
    tools.push(t);
  }
  return tools;
}

const ownerOf = name => plugins.find(p => p.api.tools.some(t => t && t.name === name));

/** Settle a tools/call: reply once, unless the client cancelled it. */
function settle(id, r) {
  cancelHandlers.delete(id);
  if (cancelled.delete(id)) return;
  if (r === undefined || r === null) return reply(id, text('error: the tool returned nothing', true));
  reply(id, r);
}

function callTool(id, params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  const meta = { id, progressToken: params && params._meta ? params._meta.progressToken : undefined };
  const isCore = CORE.some(t => t.name === name);
  const owner = isCore ? null : ownerOf(name);
  if (!isCore && !owner) { cancelHandlers.delete(id); return fail(id, -32602, `unknown tool ${name}`); }
  let me = null;
  try { me = whoami(); } catch (e) { log('whoami failed', e && e.message); }
  if (!me && !(owner && owner.anonymous.has(name))) return settle(id, text('not in a room; run /sub-human', true));
  if (isCore) {
    let r;
    try {
      r = name === 'post' ? post(me, args) : name === 'read' ? read(me, args) : propose(me, args);
    } catch (e) { r = text(`refused: ${e.message}`, true); }
    return settle(id, r);
  }
  let r;
  try { r = owner.api.call(name, me, args, meta); } catch (e) { return settle(id, text(`error: ${e.message}`, true)); }
  if (r && typeof r.then === 'function') {
    r.then(v => settle(id, v), e => settle(id, text(`error: ${e && e.message || e}`, true)));
  } else settle(id, r);
}

// ---------- dispatch ----------
function handle(msg) {
  if (msg && msg.jsonrpc === '2.0' && msg.method === undefined && msg.id != null && ('result' in msg || 'error' in msg)) {
    const w = outgoing.get(msg.id);
    if (w) { outgoing.delete(msg.id); 'error' in msg ? w.reject(msg.error) : w.resolve(msg.result); }
    return;
  }
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    if (msg && msg.id != null) fail(msg.id, -32600, 'invalid request');
    return;
  }
  const { id, method, params } = msg;
  const isNote = id === undefined || id === null;
  switch (method) {
    case 'initialize':
      clientCapabilities = (params && params.capabilities) || {};
      return reply(id, {
        protocolVersion: negotiateProtocol(params && params.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'room', title: 'sub-human room', version: VERSION },
        instructions: 'sub-human room tools. post: a note as your human\'s Claude. read: entries by id. propose: ask people to agree; each answers their own card, never through you.',
      });
    case 'notifications/initialized':
      return;
    case 'notifications/cancelled': {
      const rid = params && params.requestId;
      if (rid == null) return;
      const fns = cancelHandlers.get(rid);
      if (fns) {
        cancelled.add(rid);
        cancelHandlers.delete(rid);
        for (const fn of fns) { try { fn(params.reason); } catch (e) { log('onCancel handler failed', e && e.message); } }
      }
      return;
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: toolList() });
    case 'tools/call':
      // Register a cancel slot before the call so a plug-in's onCancel and a late settle agree.
      if (!cancelHandlers.has(id)) cancelHandlers.set(id, []);
      try { return callTool(id, params); } catch (e) { return settle(id, text(`error: ${e.message}`, true)); }
    default:
      if (!isNote) fail(id, -32601, `method not found: ${method}`);
  }
}

plugins = loadPlugins();

// ---------- stdin ----------
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); continue; }
    try { handle(msg); } catch (e) {
      log('handle failed', e && e.stack);
      if (msg && msg.id != null && msg.method) fail(msg.id, -32603, String(e && e.message));
    }
  }
});
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, shutdown);
