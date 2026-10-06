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
const identity = require(path.join(h.LIB, 'identity.js'));

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

test('mcp: tools/list has post, read, propose plus plug-in tools, no plan/watch/review; unknown methods and tools fail', async () => {
  h.freshHome();
  const s = await ready();
  const r = await s.call('tools/list', {});
  const names = r.result.tools.map(t => t.name);
  assert.deepEqual(names.slice(0, 3), ['post', 'read', 'propose']);
  for (const n of ['watch', 'plan', 'review']) assert.ok(!names.includes(n), `${n} is gone`);
  if (fs.existsSync(path.join(h.PLUGIN, 'mcp', 'hold.js'))) assert.ok(names.includes('hold'), 'hold plug-in loaded');
  assert.equal(new Set(names).size, names.length, 'no duplicate tool names');
  assert.deepEqual(r.result.tools.find(t => t.name === 'post').inputSchema.properties.kind.enum, ['say', 'question', 'status']);
  // Schema budget (plan §2: post, read, propose, task, hold <= 1,100 together): the core three stay <= 800.
  const core = JSON.stringify(r.result.tools.slice(0, 3)).length;
  assert.ok(core <= 800, `core tool schemas ${core} chars`);
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
  for (const [name, args] of [['post', { kind: 'say', text: 'x' }], ['read', {}], ['propose', { text: 'x' }]]) {
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
  const e = payload(await s.tool('post', { kind: 'question', text: 'split auth into its own module?', refs: [1], to: 'bob' }));
  assert.deepEqual([e.from, e.via, e.kind, e.to, e.refs], ['alice', 'agent', 'question', 'bob', [1]]);
  for (const kind of ['proposal', 'objection', 'signoff', 'plan_rev', 'decision', 'member_joined', 'member_left', 'task_req', 'nope']) {
    assert.match(errText(await s.tool('post', { kind, text: 'x', proposal_hash: 'abcdef012345' })), /refused: kind must be one of/, kind);
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

test('mcp: read returns unseen entries (skipping own posts) then by id', async () => {
  h.freshHome();
  const { code } = h.register('alice');
  room.bind(code);
  const s = await ready();
  room.append({ kind: 'say', text: 'hi' }, { via: 'human', from: 'bob' });
  await s.tool('post', { kind: 'status', text: 'mine' });
  assert.deepEqual(payload(await s.tool('read')).map(e => e.text), ['hi']);
  assert.deepEqual(payload(await s.tool('read')), []);
  room.append({ kind: 'say', text: 'bob here' }, { via: 'human', from: 'bob' });
  assert.deepEqual(payload(await s.tool('read')).map(e => e.text), ['bob here']);
  assert.deepEqual(payload(await s.tool('read', { ids: [3, 1] })).map(e => e.id), [3, 1]);
  assert.match(errText(await s.tool('read', { ids: [0] })), /positive/);
  await s.close();
});

test('mcp: propose stores plans/<hash>.md, appends proposal {hash, approvers, path}; approvers default to humans present', async () => {
  h.freshHome();
  const { code } = h.register('alice');
  const bob = h.spawnSleeper(), carol = h.spawnSleeper(), orch = h.spawnSleeper();
  identity.join({ code, name: 'bob', role: 'member', pid: bob.pid, session_id: 'sb' });
  identity.join({ code, name: 'carol', role: 'member', pid: carol.pid, session_id: 'sc' });
  identity.join({ code, name: 'orch', role: 'orch', pid: orch.pid, session_id: 'so' });
  identity.leave(code, 'carol');
  room.bind(code);
  const s = await ready();
  const text = '# Cursor paging\n\n1. add cursor param\n2. tests\n';
  const r = await s.tool('propose', { text });
  const msg = r.result.content[0].text;
  const e = room.readAll().at(-1);
  assert.equal(e.kind, 'proposal');
  assert.equal(e.via, 'agent');
  assert.equal(e.from, 'alice');
  assert.match(e.hash, /^[0-9a-f]{12}$/);
  assert.deepEqual(e.approvers, ['alice', 'bob'], 'orch and the departed carol are not approvers');
  assert.equal(e.path, path.join(identity.roomDir(code), 'plans', `${e.hash}.md`));
  assert.equal(fs.readFileSync(e.path, 'utf8'), text);
  assert.match(msg, new RegExp(`alice is an approver: call AskUserQuestion now with the question "proposal ${e.hash}"`));
  // The same proposal again is not re-appended.
  assert.match((await s.tool('propose', { text })).result.content[0].text, /already open/);
  assert.equal(room.readAll().filter(x => x.kind === 'proposal').length, 1);
  // path: bytes are hashed as-is; a proposer who is not an approver gets no card line.
  const f = path.join(os.tmpdir(), `sh-plan-${process.pid}.md`);
  fs.writeFileSync(f, '# other\nbody\n');
  const r2 = (await s.tool('propose', { path: f, approvers: ['@bob'] })).result.content[0].text;
  const e2 = room.readAll().at(-1);
  assert.deepEqual(e2.approvers, ['bob']);
  assert.equal(e2.hash, require('node:crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 12));
  assert.doesNotMatch(r2, /AskUserQuestion/);
  fs.unlinkSync(f);
  // Refusals.
  assert.match(errText(await s.tool('propose', { text: 'x', approvers: ['zed'] })), /not in the room: zed/);
  assert.match(errText(await s.tool('propose', { text: 'x', approvers: ['orch'] })), /people/);
  assert.match(errText(await s.tool('propose', { text: 'x', path: f })), /exactly one/);
  assert.match(errText(await s.tool('propose', { path: '/nonexistent/plan.md' })), /no such file/);
  assert.match(errText(await s.tool('propose', { text: '  \n' })), /empty/);
  await s.close();
  for (const p of [bob, carol, orch]) p.kill();
});

// ---------- plug-in contract: a copy of the server beside a fake hold.js and a broken task.js ----------
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
      return ctx.text(JSON.stringify({ who: w && w.name, caps: ctx.clientCaps(), libs: [typeof ctx.room.append, typeof ctx.identity.resolveByPid, typeof ctx.proposal.create], meta }));
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
  fs.writeFileSync(path.join(dir, 'mcp', 'task.js'), 'throw new Error("half-written");');
  return path.join(dir, 'mcp', 'room-server.js');
}

test('mcp: plug-ins get the ctx contract (request/response routing, progress, onCancel, whoami, caps, anonymous)', async () => {
  h.freshHome();
  const server = fakeServer();
  const s = await ready({ SUB_HUMAN_DEBUG: '1' }, server, { elicitation: {} });
  const names = (await s.call('tools/list', {})).result.tools.map(t => t.name);
  assert.deepEqual(names, ['post', 'read', 'propose', 'ask', 'slow', 'anon', 'info'], 'broken task.js skipped, core wins a clash');
  assert.match(fs.readFileSync(path.join(process.env.SUB_HUMAN_HOME, 'mcp-debug.log'), 'utf8'), /plugin failed task\.js/);
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
