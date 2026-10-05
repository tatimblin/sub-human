'use strict';
// Tests for mcp/room-server.js: spawn it as a child of this (registered) test process and drive it with JSON-RPC.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const h = require('./helpers.js');
const room = require(path.join(h.LIB, 'room.js'));
const plan = require(path.join(h.LIB, 'plan.js'));

const servers = new Set();
test.afterEach(() => { for (const c of servers) c.kill(); servers.clear(); });

function startMcp(env = {}, server = h.MCP) {
  const child = spawn(process.execPath, [server], { env: h.childEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
  servers.add(child);
  const waiters = new Map();
  let buf = '', nextId = 1;
  const replies = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', d => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (msg.method && msg.id != null) requests.push(msg);
      else if (msg.method) notes.push(msg);
      else if (msg.id != null && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
      else replies.push(msg);
    }
  });
  const notes = [];
  const requests = [];
  const call = (method, params) => {
    const id = nextId++;
    const p = new Promise(r => waiters.set(id, r));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return p;
  };
  const exited = new Promise(r => child.on('exit', code => r(code)));
  const close = () => { child.stdin.end(); return exited; };
  const write = m => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  return { call, close, child, notes, requests, replies, write };
}

async function ready(env, server, capabilities = {}) {
  const s = startMcp(env, server);
  const init = await s.call('initialize', { protocolVersion: '2025-06-18', capabilities, clientInfo: { name: 't', version: '0' } });
  s.init = init;
  assert.equal(init.result.serverInfo.name, 'room');
  s.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  s.tool = (name, args = {}) => s.call('tools/call', { name, arguments: args });
  return s;
}
const payload = r => JSON.parse(r.result.content[0].text);
const errText = r => { assert.equal(r.result.isError, true, JSON.stringify(r)); return r.result.content[0].text; };

test('mcp: tools/list has post, read, plan plus plug-in tools and no watch; unknown methods and tools fail', async () => {
  h.freshHome();
  const s = await ready();
  const r = await s.call('tools/list', {});
  const names = r.result.tools.map(t => t.name);
  for (const n of ['post', 'read', 'plan']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('watch'), 'watch is gone');
  if (fs.existsSync(path.join(h.PLUGIN, 'mcp', 'signoff.js'))) assert.ok(names.includes('review'), 'signoff plug-in loaded');
  assert.equal(new Set(names).size, names.length, 'no duplicate tool names');
  assert.deepEqual(r.result.tools.find(t => t.name === 'post').inputSchema.properties.kind.enum, room.AGENT_KINDS);
  assert.equal((await s.call('nope/method', {})).error.code, -32601);
  assert.equal((await s.tool('await_human', { after_seq: 0 })).error.code, -32602);
  assert.equal((await s.tool('watch', {})).error.code, -32602);
  assert.deepEqual((await s.call('ping')).result, {});
  assert.equal(await s.close(), 0);
});

test('mcp: every tool errors until the parent session joins, then works without a restart', async () => {
  h.freshHome();
  const code = h.newRoom();
  const s = await ready();
  for (const [name, args] of [['post', { kind: 'say', text: 'x' }], ['read', {}], ['plan', {}]]) {
    assert.equal(errText(await s.tool(name, args)), 'not in a room; run /sub-human');
  }
  h.register('alice', 'member', process.pid, code);
  const e = payload(await s.tool('post', { kind: 'status', text: 'hello' }));
  assert.deepEqual([e.from, e.via, e.kind], ['alice', 'agent', 'status']);
  await s.close();
});

test('mcp: post is stamped from the parent pid (process.ppid), not env; system and human kinds are refused', async () => {
  h.freshHome();
  const { code } = h.register('alice');
  const bob = h.spawnSleeper();
  require(path.join(h.LIB, 'identity.js')).join({ code, name: 'bob', role: 'member', pid: bob.pid, session_id: 'sb' });
  // A forged CLAUDE_PID pointing at bob changes nothing: the server uses its parent.
  const s = await ready({ CLAUDE_PID: String(bob.pid) });
  const e = payload(await s.tool('post', { kind: 'proposal', text: 'split auth into its own module', refs: [1], to: 'bob' }));
  assert.deepEqual([e.from, e.via, e.kind, e.to, e.refs], ['alice', 'agent', 'proposal', 'bob', [1]]);
  for (const kind of ['signoff', 'plan_rev', 'decision', 'member_joined', 'member_left', 'nope']) {
    assert.match(errText(await s.tool('post', { kind, text: 'x', plan_hash: 'abcdef012345' })), /refused: kind must be one of/, kind);
  }
  const forged = payload(await s.tool('post', { kind: 'say', text: 'x', from: 'bob', via: 'human' }));
  assert.deepEqual([forged.from, forged.via], ['alice', 'agent'], 'extra arguments are ignored');
  assert.match(errText(await s.tool('post', { kind: 'say', text: '   ' })), /empty/);
  room.bind(code);
  assert.ok(room.readAll().every(x => x.from === 'alice' && x.via === 'agent'));
  // Rate limit surfaces as a tool error.
  for (let i = 0; i < 4; i++) await s.tool('post', { kind: 'status', text: `s${i}` });
  assert.match(errText(await s.tool('post', { kind: 'status', text: 'one too many' })), /rate limit/);
  await s.close();
  bob.kill();
});

test('mcp: objection gets the current plan hash; read returns unseen entries then by id; plan() shape', async () => {
  h.freshHome();
  const { code } = h.register('alice');
  room.bind(code);
  const bytes = `---\nsub-human: ${JSON.stringify({ room: code, approval: 'all', approvers: ['alice', 'bob'] })}\n---\n# Plan\nstep 1\n`;
  const hash = plan.storeCanonical(code, bytes);
  const s = await ready();
  assert.deepEqual(payload(await s.tool('plan')), { hash: null, rev: null, approvers: [], matrix: null, decided: null, path: null, plan: null });
  room.append({ kind: 'plan_rev', text: `plan ${hash}`, plan_hash: hash, approvers: ['alice', 'bob'] }, { via: 'system', from: 'orch', system: true });
  room.append({ kind: 'signoff', text: 'ok', plan_hash: hash }, { via: 'human', from: 'bob' });
  const obj = payload(await s.tool('post', { kind: 'objection', text: 'step 1 is unsafe' }));
  assert.equal(obj.plan_hash, hash);
  // read: unseen, skipping alice's own Claude posts, advancing the cursor.
  const unseen = payload(await s.tool('read'));
  assert.deepEqual(unseen.map(e => e.kind), ['plan_rev', 'signoff']);
  assert.deepEqual(payload(await s.tool('read')), []);
  room.append({ kind: 'say', text: 'bob here' }, { via: 'human', from: 'bob' });
  assert.deepEqual(payload(await s.tool('read')).map(e => e.text), ['bob here']);
  assert.deepEqual(payload(await s.tool('read', { ids: [3, 1] })).map(e => e.id), [3, 1]);
  assert.match(errText(await s.tool('read', { ids: [0] })), /positive/);
  const p = payload(await s.tool('plan'));
  assert.equal(p.hash, hash);
  assert.deepEqual(p.approvers, ['alice', 'bob']);
  assert.deepEqual(p.matrix.missing, ['alice']);
  assert.equal(p.decided, null);
  assert.equal(p.rev, 1);
  assert.equal(p.path, path.join(require(path.join(h.LIB, 'identity.js')).roomDir(code), 'plans', `${hash}.md`));
  assert.equal(fs.readFileSync(p.path, 'utf8'), bytes);
  assert.equal(p.plan, bytes);
  assert.deepEqual(Object.keys(p).sort(), ['approvers', 'decided', 'hash', 'matrix', 'path', 'plan', 'rev']);
  const bytes2 = bytes.replace('step 1', 'step 1b');
  const hash2 = plan.storeCanonical(code, bytes2);
  room.append({ kind: 'plan_rev', text: `plan ${hash2}`, plan_hash: hash2, approvers: ['alice'] }, { via: 'system', from: 'orch', system: true });
  assert.equal(payload(await s.tool('plan')).rev, 2);
  await s.close();
});

// ---------- plug-in contract: a copy of the server beside a fake hold.js and a broken signoff.js ----------
const FAKE_HOLD = `
let log = [];
exports.create = ctx => ({
  anonymous: ['anon'],
  tools: [
    { name: 'ask', description: 'x', inputSchema: { type: 'object', properties: {} } },
    { name: 'slow', description: 'x', inputSchema: { type: 'object', properties: {} } },
    { name: 'anon', description: 'x', inputSchema: { type: 'object', properties: {} } },
    { name: 'post', description: 'shadowed by core', inputSchema: { type: 'object', properties: {} } },
    { name: 'info', description: 'x', inputSchema: { type: 'object', properties: {} } },
  ],
  call(name, me, args, meta) {
    if (name === 'ask') {
      const p = ctx.request('elicitation/create', { message: 'hi' });
      return p.then(r => ctx.text('answer ' + JSON.stringify(r) + ' id=' + p.id), e => ctx.text('rejected ' + JSON.stringify(e), true));
    }
    if (name === 'slow') {
      ctx.progress(meta.progressToken, 1, 'holding ' + me.name);
      return new Promise(resolve => ctx.onCancel(meta.id, reason => {
        ctx.notify('test/cancelled', { id: meta.id, reason });
        setTimeout(() => resolve(ctx.text('late')), 20);
      }));
    }
    if (name === 'anon') return ctx.text(me ? 'me ' + me.name : 'anonymous');
    if (name === 'info') {
      const w = ctx.whoami();
      return ctx.text(JSON.stringify({ who: w && w.name, caps: ctx.clientCaps(), libs: [typeof ctx.room.append, typeof ctx.identity.resolveByPid, typeof ctx.planLib.canonical], meta }));
    }
  },
});
`;

function fakeServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-mcp-'));
  fs.mkdirSync(path.join(dir, 'mcp'));
  fs.copyFileSync(h.MCP, path.join(dir, 'mcp', 'room-server.js'));
  fs.symlinkSync(h.LIB, path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'mcp', 'hold.js'), FAKE_HOLD);
  fs.writeFileSync(path.join(dir, 'mcp', 'signoff.js'), 'throw new Error("half-written");');
  return path.join(dir, 'mcp', 'room-server.js');
}

test('mcp: plug-ins get the ctx contract (request/response routing, progress, onCancel, whoami, caps, anonymous)', async () => {
  h.freshHome();
  const server = fakeServer();
  const s = await ready({ SUB_HUMAN_DEBUG: '1' }, server, { elicitation: {} });
  const names = (await s.call('tools/list', {})).result.tools.map(t => t.name);
  assert.deepEqual(names, ['post', 'read', 'plan', 'ask', 'slow', 'anon', 'info'], 'broken signoff.js skipped, core wins a clash');
  assert.match(fs.readFileSync(path.join(process.env.SUB_HUMAN_HOME, 'mcp-debug.log'), 'utf8'), /plugin failed signoff\.js/);
  // Not joined: plug-in tools error like core ones, except the anonymous ones.
  assert.equal(errText(await s.tool('ask')), 'not in a room; run /sub-human');
  assert.equal((await s.tool('anon')).result.content[0].text, 'anonymous');
  const { code } = h.register('alice');
  assert.equal((await s.tool('anon')).result.content[0].text, 'me alice');
  const info = JSON.parse((await s.call('tools/call', { name: 'info', arguments: {}, _meta: { progressToken: 'pt' } })).result.content[0].text);
  assert.equal(info.who, 'alice');
  assert.deepEqual(info.caps, { elicitation: {} });
  assert.deepEqual(info.libs, ['function', 'function', 'function']);
  assert.equal(info.meta.progressToken, 'pt');
  assert.equal(typeof info.meta.id, 'number');
  // request(): the client's answer is routed back by id; an error rejects.
  const ask = s.tool('ask');
  await h.until(() => s.requests.length === 1);
  const req = s.requests[0];
  assert.equal(req.method, 'elicitation/create');
  s.write({ id: req.id, result: { action: 'accept', content: { decision: 'approve' } } });
  assert.equal((await ask).result.content[0].text, `answer {"action":"accept","content":{"decision":"approve"}} id=${req.id}`);
  const ask2 = s.tool('ask');
  await h.until(() => s.requests.length === 2);
  s.write({ id: s.requests[1].id, error: { code: -1, message: 'nope' } });
  assert.match(errText(await ask2), /rejected .*nope/);
  // progress + onCancel; a cancelled call never gets a reply.
  const id = 9001;
  s.write({ id, method: 'tools/call', params: { name: 'slow', arguments: {}, _meta: { progressToken: 7 } } });
  await h.until(() => s.notes.some(n => n.method === 'notifications/progress'));
  assert.deepEqual(s.notes.find(n => n.method === 'notifications/progress').params, { progressToken: 7, progress: 1, message: 'holding alice' });
  s.write({ method: 'notifications/cancelled', params: { requestId: id, reason: 'esc' } });
  await h.until(() => s.notes.some(n => n.method === 'test/cancelled'));
  assert.deepEqual(s.notes.find(n => n.method === 'test/cancelled').params, { id, reason: 'esc' });
  await h.sleep(100);
  assert.equal(s.replies.filter(r => r.id === id).length, 0, 'no reply after cancel');
  assert.ok(code);
  assert.equal(await s.close(), 0);
});
