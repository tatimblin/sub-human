#!/usr/bin/env node
/**
 * plugin/sub-human/mcp/room-server.ts: the room's stdio MCP server (JSON-RPC 2.0, one message per line).
 * Zero dependencies. Each Claude Code session runs its own copy, as a direct child of claude.
 *
 * Identity: the session that spawned us. Claude Code gives a stdio server its session id (cc CONTRACT
 * env-mcp-session), so me = identity.resolveBySession(CLAUDE_CODE_SESSION_ID); the id is fixed at spawn and /clear
 * moves the session to a new one (env-clear-session-id), so a seat that rebound since is found by its claude process
 * instead, our parent (mcp-stdio-ppid): identity.resolveByPid(process.ppid). Re-resolved on every call (the session
 * joins after the server starts). The model never names itself. Not joined -> every core tool returns "not in a
 * room; run /sub-human".
 *
 * Core tools:
 *   post({kind, text, to?, refs?})   kinds: say question status; via "agent", from = the resolved member. Refused
 *       when it repeats the member's objection note, waiting for their Send or sent in the last 10 minutes (relayed).
 *   read({ids?})   with ids: those entries in full. Without: this member's unseen entries (cursor mcp-<name>),
 *       skipping its own Claude's posts; at most 100, oldest first. Each entry is one rendered line (lib/room/render.ts
 *       line {full}): "#ID FROM[VIA] (unverified)? KIND … "TEXT"", no signature material, and a person's line whose
 *       signature does not verify marked "(unverified)" (not their words for certain).
 *   propose({text|path, approvers?})   lib/proposal.create: stores plans/<hash>.md, appends `proposal`
 *       {hash, approvers, path}; approvers default to the humans present. Each approver answers a consent
 *       card (hooks/handlers/consent.ts); a proposer who is also an approver is told to open the card now. The reply
 *       names the read-only `show` by the shim's full path (lib/text.ts cliCmd): no `sub-human` is on a session's
 *       PATH. A proposal retires the proposer's earlier undecided one with the same title (lib/room/consent.ts), and says so; another
 *       sender's pending one with the same title is warned about (both stay open). A path's root is the seat's cwd
 *       (its members record; else this process's): never ~, / or above ~, nor the plugin home, ~/.ssh or ~/.claude.
 *
 * Plug-ins: ./hold.ts (rows) and ./task.ts (the room task list) are loaded when present; a missing or broken
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
 *   whoami()                          the session's seat (Identity above); me or null (each call opens me.code's Room)
 *   clientCaps()                      the client capabilities from initialize (e.g. .elicitation)
 *   room, identity, proposal          the libs
 *   text(s, isError)                  an MCP text result
 *   log(...a)                         $SUB_HUMAN_HOME/mcp-debug.log, only when SUB_HUMAN_DEBUG=1
 * A tools/call cancelled by the client gets no reply, even if its Promise settles later.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as identity from '../lib/identity.ts';
import * as room from '../lib/room.ts';
import * as proposal from '../lib/proposal.ts';
import * as cc from '../lib/cc/env.ts';
import { cliCmd } from '../lib/text.ts';
import { createRequire } from 'node:module';
import type { Entry, EntryInput } from '../lib/room/types.ts';
import type { CallMeta, CallToolParams, JsonRpcId, JsonRpcIncoming, JsonRpcOutgoing, Me, OutgoingRequest, PluginApi, PluginContext, ProgressToken, ToolArgs, ToolDefinition, ToolResult } from './types.ts';

// loadPlugins() requires each plug-in by path (createRequire: require(esm) is synchronous).
const require = createRequire(import.meta.url);

const READ_MAX = 100;
const PLUGINS = ['hold.ts', 'task.ts'];
const POST_KINDS = ['say', 'question', 'status'];
const RELAY_WINDOW_MS = 10 * 60_000; // a post repeating the person's objection sent this recently is refused (relayed)
// MCP revisions this server speaks (newest first): answer with the client's when listed, else our newest.
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const negotiateProtocol = (v: unknown): string => (typeof v === 'string' && PROTOCOL_VERSIONS.includes(v) ? v : PROTOCOL_VERSIONS[0]);
// serverInfo.version follows the plugin manifest, so one bump versions both.
const VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version || '0.0.0';
  } catch { return '0.0.0'; }
})();

// ---------- transport ----------
let closed = false;
function send(msg: JsonRpcOutgoing) {
  if (closed) return;
  try { process.stdout.write(JSON.stringify(msg) + '\n'); } catch { shutdown(); }
}
process.stdout.on('error', () => shutdown());
const reply = (id: JsonRpcId | null, result: unknown) => send({ jsonrpc: '2.0', id, result });
const fail = (id: JsonRpcId | null, code: number, message: string) => send({ jsonrpc: '2.0', id, error: { code, message } });
const text = (s: unknown, isError?: boolean): ToolResult => ({ content: [{ type: 'text', text: String(s) }], ...(isError ? { isError: true } : {}) });
const json = (v: unknown) => text(JSON.stringify(v));

function log(...a: unknown[]) {
  if (process.env.SUB_HUMAN_DEBUG !== '1') return;
  try {
    const line = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    fs.mkdirSync(identity.home(), { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(identity.home(), 'mcp-debug.log'), `${new Date().toISOString()} ${process.pid} ${line}\n`);
  } catch { /* debug only */ }
}

/** A loaded plug-in: its file, its api, and the tools it takes with me = null. */
interface Plugin { file: string; api: PluginApi; anonymous: Set<string> }
let plugins: Plugin[] = [];
function shutdown() {
  if (closed) return;
  closed = true;
  for (const p of plugins) { try { if (typeof p.api.stop === 'function') p.api.stop(); } catch { /* exiting */ } }
  process.exit(0);
}

// ---------- server -> client requests ----------
const outgoing = new Map<JsonRpcId, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>(); // our request id -> {resolve, reject}
let nextReq = 1;
function request(method: string, params?: unknown): OutgoingRequest {
  const id = `sh-${process.pid}-${nextReq++}`;
  const p: OutgoingRequest = new Promise((resolve, reject) => {
    outgoing.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
  p.id = id;
  return p;
}
function cancelRequest(id: string, reason?: string) {
  send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, ...(reason ? { reason } : {}) } });
  const w = outgoing.get(id);
  if (w) { outgoing.delete(id); w.reject({ code: 'CANCELLED', message: reason || 'cancelled' }); }
}
const notify = (method: string, params?: unknown) => send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
const progress = (progressToken: ProgressToken | null | undefined, n: number, message?: string) => {
  if (progressToken == null) return;
  notify('notifications/progress', { progressToken, progress: n, ...(message ? { message } : {}) });
};

// ---------- client -> server cancellation ----------
const cancelHandlers = new Map<JsonRpcId, ((reason?: unknown) => void)[]>(); // tools/call id -> [fn]
const cancelled = new Set<JsonRpcId>();      // tools/call ids the client cancelled: never reply to them
function onCancel(requestId: JsonRpcId, fn: (reason?: unknown) => void) {
  let fns = cancelHandlers.get(requestId);
  if (!fns) cancelHandlers.set(requestId, fns = []);
  fns.push(fn);
}

// ---------- identity ----------
/** The seat of the session that spawned us: by its id (cc CONTRACT env-mcp-session), else (after a /clear) by our
 * parent, the claude process: a stdio server is spawned without a shell (cc CONTRACT mcp-stdio-ppid). */
function whoami(): Me | null {
  const sid = cc.sessionId();
  const bySid = sid ? identity.resolveBySession(sid) : null;
  if (bySid) return bySid;
  const pid = process.ppid > 1 ? process.ppid : null;
  return pid ? identity.resolveByPid(pid) : null;
}

let clientCapabilities: Record<string, unknown> = {};
const ctx: PluginContext = {
  send, notify, request, cancelRequest, progress, onCancel, whoami,
  clientCaps: () => clientCapabilities,
  room, identity, proposal, text, log,
};

// ---------- core tools ----------
const CORE: ToolDefinition[] = [
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
      + 'Each approver answers it in the plan view in their own session; never report agreement until the room records it. Same content reopens the open proposal; a revision with the same title replaces your earlier one.',
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

/**
 * A post that relays the person's objection note (proposal.repeatsNote): the note waiting for their Send on the
 * confirm card, or one they sent in the last RELAY_WINDOW_MS. Either way the room would show it twice; the refusal
 * says why, else null. The receiving side does not dedupe.
 */
function relayed(me: Me, body: unknown): string | null {
  if (typeof body !== 'string') return null;
  const cf = proposal.readConfirm(me);
  if (cf && proposal.repeatsNote(cf, body)) {
    return `refused: that is ${me.name}'s note on proposal ${cf.hash}, which waits for ${me.name}'s Send; posting it would relay it twice. ${proposal.confirmCall(cf.hash)} so ${me.name} can send or discard it.`;
  }
  const since = Date.now() - RELAY_WINDOW_MS;
  const sent = room.open(me.code).readRecent().findLast(e => e.kind === 'objection' && e.via === 'human' && e.from === me.name
    && typeof e.text === 'string' && Date.parse(e.at) >= since && proposal.repeatsNote({ note: e.text }, body));
  return sent ? `refused: ${me.name} already sent that note as their objection to proposal ${sent.proposal_hash}; the room shows it, so posting it would relay it twice.` : null;
}

function post(me: Me, args: ToolArgs) {
  const { kind, text: body, to, refs } = args;
  if (typeof kind !== 'string' || !POST_KINDS.includes(kind)) {
    return text(`refused: kind must be one of ${POST_KINDS.join(', ')}. To ask for agreement, use propose; only people answer it, on their own card.`, true);
  }
  const twice = relayed(me, body);
  if (twice) return text(twice, true);
  // the model's arguments, unchecked: validate() (append) checks each field's type
  const entry = { kind, text: body, ...(to !== undefined ? { to } : {}), ...(refs !== undefined ? { refs } : {}) } as EntryInput;
  return json(room.open(me.code).append(entry, { via: 'agent', from: me.name }));
}

/** Entries as the model reads them: one rendered line each (render.line full), the trust marker in it. */
const lines = (r: ReturnType<typeof room.open>, es: readonly Entry[], none: string) => text(es.length ? es.map(e => r.line(e, { full: true })).join('\n') : none);

function read(me: Me, args: ToolArgs) {
  const r = room.open(me.code);
  if (args.ids !== undefined) {
    const ids = Array.isArray(args.ids) ? args.ids : [args.ids];
    if (!ids.length || !ids.every(i => Number.isInteger(Number(i)) && Number(i) > 0)) return text('ids must be positive integers', true);
    return lines(r, r.readById(ids.map(Number)), '(no such entries)');
  }
  const cursor = `mcp-${me.name}`;
  const all = r.readAfter(r.getCursor(cursor));
  if (all.length) r.setCursor(cursor, all.at(-1)!.id);
  const unseen = all.filter((e: { from?: string; via?: string }) => !(e.from === me.name && e.via === 'agent'));
  return lines(r, unseen.length > READ_MAX ? unseen.slice(-READ_MAX) : unseen, '(nothing new)');
}

function propose(me: Me, args: ToolArgs) {
  let r;
  // the root of a path: the seat's working directory as its join recorded it (a mirror keeps none: this process's,
  // which Claude Code spawned in the session's)
  let cwd: string | undefined;
  try { cwd = identity.readMembers(me.code)[me.name]?.cwd || undefined; } catch { /* process.cwd() then */ }
  try { r = proposal.create(me, args, { cwd }); } catch (e) {
    if (e instanceof proposal.ProposalError) return text(`refused: ${e.message}`, true);
    throw e;
  }
  const lines = [`proposal ${r.hash} ${r.again ? 'is already open' : 'proposed'} to ${r.approvers.join(', ')}. Read it with \`${cliCmd(`show ${r.hash}`)}\`.`];
  const t = proposal.title(me.code, r.hash, r.entry);
  if (r.retired.length) lines.push(`It replaces your earlier ${r.retired.map(h => `proposal ${h}`).join(', ')} (same title): no longer pending, and answers on it do not carry over.`);
  // the same title from someone else is not a revision: both stay open, so say so (people can't tell them apart)
  const f = room.open(me.code).fold();
  const twins = t ? [...f.proposals.values()].filter(p => p.hash !== r.hash && p.from !== me.name && !f.decisions.has(p.hash)
    && !f.superseded.has(p.hash) && proposal.title(me.code, p.hash, p.entry) === t) : [];
  for (const p of twins) lines.push(`Warning: ${p.from}'s proposal ${p.hash} is also pending with the title "${t}"; both stay open. Give this one a distinct title if it is not the same question.`);
  lines.push('Each approver reads and answers it in the plan view in their own session. Never say anyone agreed until the room records it.');
  if (r.approvers.includes(me.name)) lines.push(`${me.name} is an approver: ${proposal.openCall(r.hash)} now so ${me.name} can read and answer it.`);
  return text(lines.join('\n'));
}

// ---------- plug-ins ----------
function loadPlugins(): Plugin[] {
  const out: Plugin[] = [];
  for (const file of PLUGINS) {
    const full = path.join(import.meta.dirname, file);
    if (!fs.existsSync(full)) { log('plugin missing', file); continue; }
    try {
      const mod: { create?: unknown } | null = require(full); // a plug-in: checked below, not trusted
      const api: PluginApi | null = mod && typeof mod.create === 'function' ? mod.create(ctx) : null;
      if (!api || !Array.isArray(api.tools) || typeof api.call !== 'function') { log('plugin has no {tools, call}', file); continue; }
      out.push({ file, api, anonymous: new Set(Array.isArray(api.anonymous) ? api.anonymous : []) });
      log('plugin loaded', file, api.tools.map(t => t.name));
    } catch (e) {
      log('plugin failed', file, (e as Error | null) && (e as Error).stack || String(e));
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

const ownerOf = (name: unknown) => plugins.find(p => p.api.tools.some(t => t && t.name === name));

/** Settle a tools/call: reply once, unless the client cancelled it. */
function settle(id: JsonRpcId, r: ToolResult | null | undefined) {
  cancelHandlers.delete(id);
  if (cancelled.delete(id)) return;
  if (r === undefined || r === null) return reply(id, text('error: the tool returned nothing', true));
  reply(id, r);
}

function callTool(id: JsonRpcId, params: CallToolParams | undefined) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  const meta: CallMeta = { id, progressToken: params && params._meta ? params._meta.progressToken : undefined };
  const isCore = CORE.some(t => t.name === name);
  const owner = isCore ? null : ownerOf(name);
  if (!isCore && !owner) { cancelHandlers.delete(id); return fail(id, -32602, `unknown tool ${name}`); }
  let me: Me | null = null;
  try { me = whoami(); } catch (e) { log('whoami failed', (e as Error | null) && (e as Error).message); }
  // owner: a plug-in lists the tool by this name, so name is a string
  if (!me && !(owner && owner.anonymous.has(name!))) return settle(id, text('not in a room; run /sub-human', true));
  if (isCore) {
    const self = me!; // a core tool never runs without one (returned above)
    let r;
    try {
      r = name === 'post' ? post(self, args) : name === 'read' ? read(self, args) : propose(self, args);
    } catch (e) { r = text(`refused: ${(e as Error).message}`, true); }
    return settle(id, r);
  }
  let r;
  // not core: owner is the plug-in that lists the tool
  try { r = owner!.api.call(name!, me, args, meta); } catch (e) { return settle(id, text(`error: ${(e as Error).message}`, true)); }
  if (r && typeof (r as Promise<ToolResult>).then === 'function') {
    (r as Promise<ToolResult>).then(v => settle(id, v), (e: unknown) => settle(id, text(`error: ${(e as Error | null) && (e as Error).message || e}`, true)));
  } else settle(id, r as ToolResult | null);
}

// ---------- dispatch ----------
function handle(msg: JsonRpcIncoming | null) {
  if (msg && msg.jsonrpc === '2.0' && msg.method === undefined && msg.id != null && ('result' in msg || 'error' in msg)) {
    const w = outgoing.get(msg.id);
    if (w) { outgoing.delete(msg.id); if ('error' in msg) w.reject(msg.error); else w.resolve(msg.result); }
    return;
  }
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    if (msg && msg.id != null) fail(msg.id, -32600, 'invalid request');
    return;
  }
  const { method } = msg;
  const id = msg.id as JsonRpcId; // null or absent only for a notification, which gets no reply
  const params = msg.params as Record<string, any> | undefined; // the client's, per method: each case reads what it needs
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
        for (const fn of fns) { try { fn(params!.reason); } catch (e) { log('onCancel handler failed', (e as Error | null) && (e as Error).message); } } // params: it held rid
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
      try { return callTool(id, params); } catch (e) { return settle(id, text(`error: ${(e as Error).message}`, true)); }
    default:
      if (!isNote) fail(id, -32601, `method not found: ${method}`);
  }
}

plugins = loadPlugins();

// ---------- stdin ----------
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg: JsonRpcIncoming | null;
    try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); continue; }
    try { handle(msg); } catch (e) {
      const err = e as Error | null;
      log('handle failed', err && err.stack);
      if (msg && msg.id != null && msg.method) fail(msg.id, -32603, String(err && err.message));
    }
  }
});
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, shutdown);
