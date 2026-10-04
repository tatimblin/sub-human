#!/usr/bin/env node
'use strict';
/**
 * plugin/sub-human/mcp/room-server.js: the room's stdio MCP server (JSON-RPC 2.0, one message per line).
 * Zero dependencies. Ported from demo/bin/room-mcp, without await_human: sessions are woken by the
 * plugin monitor (`sub-human tail`), not by a blocking tool.
 *
 * Identity: this server is a direct child of claude and has no CLAUDE_PID, so the caller is
 * identity.claudePid({ppid:true}) = process.ppid, resolved with identity.resolveByPid() on every call
 * (the session joins after the server starts). The model never names itself. Not joined -> every tool
 * returns an error: "not in a room; run /sub-human".
 *
 * Tools:
 *   post({kind, text, to?, refs?, plan_hash?})   kinds: say proposal question objection status; via "agent",
 *       from = the resolved member. An objection without plan_hash gets the current plan's hash.
 *   read({ids?})   with ids: those entries in full. Without: this member's unseen entries (cursor mcp-<name>),
 *       skipping its own Claude's posts; at most 100, oldest first.
 *   plan()   {hash, approvers, matrix, decided, stub, plan}: `stub` is the exact text a member writes to its
 *       plan file to review; `plan` is the canonical plan text. The model never has to copy plan bytes.
 */

const path = require('node:path');
const identity = require(path.join(__dirname, '..', 'lib', 'identity.js'));
const room = require(path.join(__dirname, '..', 'lib', 'room.js'));
const planLib = require(path.join(__dirname, '..', 'lib', 'plan.js'));

const READ_MAX = 100;

// ---------- transport ----------
let closed = false;
function send(msg) {
  if (closed) return;
  try { process.stdout.write(JSON.stringify(msg) + '\n'); } catch { shutdown(); }
}
process.stdout.on('error', () => shutdown());
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const text = (s, isError) => ({ content: [{ type: 'text', text: s }], ...(isError ? { isError: true } : {}) });
const json = v => text(JSON.stringify(v));

function shutdown() {
  if (closed) return;
  closed = true;
  process.exit(0);
}

// ---------- identity ----------
function whoami() {
  const pid = identity.claudePid({ ppid: true });
  const me = pid ? identity.resolveByPid(pid) : null;
  if (me) room.bind(me.code);
  return me;
}

// ---------- tools ----------
const TOOLS = [
  {
    name: 'post',
    description: 'Post to the room as your human\'s Claude (from and via are stamped by the room; you cannot change them). kind: say | proposal | question | objection | status. Cite human words by id in refs; never re-type them. An objection gets the current plan hash if you omit plan_hash. At most 6 posts a minute.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: room.AGENT_KINDS },
        text: { type: 'string', description: '1-4 sentences, plus file paths.' },
        to: { type: 'string', description: 'A member name; default "room".' },
        refs: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'Entry ids this post acts on.' },
        plan_hash: { type: 'string', pattern: '^[0-9a-f]{12}$' },
      },
      required: ['kind', 'text'],
    },
  },
  {
    name: 'read',
    description: 'Read the room. With ids: those entries in full. Without: entries you have not seen yet. Returns a JSON array.',
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'integer', minimum: 1 } } },
    },
  },
  {
    name: 'plan',
    description: 'The room\'s current plan: {hash, approvers, matrix, decided, stub, plan}. To review it, write `stub` verbatim as your plan file and call ExitPlanMode; the plugin shows your human the canonical plan. `plan` is the plan text.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function post(me, args) {
  const { kind, text: body, to, refs, plan_hash } = args;
  if (!room.AGENT_KINDS.includes(kind)) {
    return text(`refused: kind must be one of ${room.AGENT_KINDS.join(', ')}. Sign-offs and human objections come only from your human, through Claude Code.`, true);
  }
  const entry = { kind, text: body };
  if (to !== undefined) entry.to = to;
  if (refs !== undefined) entry.refs = refs;
  if (plan_hash !== undefined) entry.plan_hash = plan_hash;
  if (kind === 'objection' && !entry.plan_hash) {
    const p = room.currentPlan();
    if (p) entry.plan_hash = p.hash;
  }
  return json(room.append(entry, { via: 'agent', from: me.name }));
}

function read(me, args) {
  if (args.ids !== undefined) {
    const ids = Array.isArray(args.ids) ? args.ids : [args.ids];
    if (!ids.length || !ids.every(i => Number.isInteger(Number(i)) && Number(i) > 0)) return text('ids must be positive integers', true);
    return json(room.readById(ids.map(Number)));
  }
  const cursor = `mcp-${me.name}`;
  const all = room.readAfter(room.getCursor(cursor));
  if (all.length) room.setCursor(cursor, all.at(-1).id);
  const unseen = all.filter(e => !(e.from === me.name && e.via === 'agent'));
  return json(unseen.length > READ_MAX ? unseen.slice(-READ_MAX) : unseen);
}

function plan(me) {
  const p = room.currentPlan();
  if (!p) return json({ hash: null, approvers: [], matrix: null, decided: null, stub: null, plan: null });
  const bytes = planLib.canonical(me.code, p.hash);
  const dec = room.decided(p.hash);
  return json({
    hash: p.hash,
    approvers: p.approvers,
    matrix: room.signoffMatrix(p.hash, p.approvers),
    decided: dec ? dec.id : null,
    stub: planLib.stubFor(me.code, p.hash),
    plan: bytes ? bytes.toString('utf8') : null,
  });
}

function callTool(params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  if (!TOOLS.some(t => t.name === name)) return null;
  const me = whoami();
  if (!me) return text('not in a room; run /sub-human', true);
  try {
    if (name === 'post') return post(me, args);
    if (name === 'read') return read(me, args);
    return plan(me);
  } catch (e) {
    return text(`refused: ${e.message}`, true);
  }
}

function handle(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    if (msg && msg.id != null && !('result' in msg) && !('error' in msg)) fail(msg.id, -32600, 'invalid request');
    return;
  }
  const { id, method, params } = msg;
  const isNote = id === undefined || id === null;
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'room', version: '0.3.0' },
        instructions: 'sub-human room tools. post as your human\'s Claude; read entries by id; plan() for the shared plan and its review stub.',
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS });
    case 'tools/call': {
      let r;
      try { r = callTool(params); } catch (e) { r = text(`error: ${e.message}`, true); }
      if (r === null) return fail(id, -32602, `unknown tool ${params && params.name}`);
      return reply(id, r);
    }
    default:
      if (!isNote) fail(id, -32601, `method not found: ${method}`);
  }
}

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
    handle(msg);
  }
});
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, shutdown);
