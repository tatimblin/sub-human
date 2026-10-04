'use strict';
// Tests for mcp/room-server.js: spawn it as a child of this (registered) test process and drive it with JSON-RPC.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const h = require('./helpers.js');
const room = require(path.join(h.LIB, 'room.js'));
const plan = require(path.join(h.LIB, 'plan.js'));

const servers = new Set();
test.afterEach(() => { for (const c of servers) c.kill(); servers.clear(); });

function startMcp(env = {}) {
  const child = spawn(process.execPath, [h.MCP], { env: h.childEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
  servers.add(child);
  const waiters = new Map();
  let buf = '', nextId = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', d => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (msg.id != null && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
    }
  });
  const call = (method, params) => {
    const id = nextId++;
    const p = new Promise(r => waiters.set(id, r));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return p;
  };
  const exited = new Promise(r => child.on('exit', code => r(code)));
  const close = () => { child.stdin.end(); return exited; };
  return { call, close, child };
}

async function ready(env) {
  const s = startMcp(env);
  const init = await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'room');
  s.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  s.tool = (name, args = {}) => s.call('tools/call', { name, arguments: args });
  return s;
}
const payload = r => JSON.parse(r.result.content[0].text);
const errText = r => { assert.equal(r.result.isError, true, JSON.stringify(r)); return r.result.content[0].text; };

test('mcp: tools/list returns post, read, plan, watch; unknown methods and tools fail', async () => {
  h.freshHome();
  const s = await ready();
  const r = await s.call('tools/list', {});
  assert.deepEqual(r.result.tools.map(t => t.name).sort(), ['plan', 'post', 'read', 'watch']);
  assert.deepEqual(r.result.tools.find(t => t.name === 'post').inputSchema.properties.kind.enum, room.AGENT_KINDS);
  assert.equal((await s.call('nope/method', {})).error.code, -32601);
  assert.equal((await s.tool('await_human', { after_seq: 0 })).error.code, -32602);
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

test('mcp: watch survives a backlog larger than one batch (no crash), and pages through it', async () => {
  h.freshHome();
  const { code } = h.register('alice');
  room.bind(code);
  room.append({ kind: 'say', text: 'first' }, { via: 'human', from: 'bob' });
  const s = await ready({ SUB_HUMAN_WATCH_COALESCE_MS: '50', SUB_HUMAN_WATCH_POLL_MS: '50' });
  const text = r => r.result.content[0].text;
  assert.match(text(await s.tool('watch', {})), /1 new/);  // sets the cursor
  for (let i = 0; i < 40; i++) room.append({ kind: 'say', text: `m${i}` }, { via: 'human', from: 'bob' });
  const a = await s.tool('watch', {});
  assert.ok(!a.error && !a.result.isError, JSON.stringify(a));
  assert.match(text(a), /30 new/);
  assert.match(text(await s.tool('watch', {})), /10 new/);
  assert.equal(await s.close(), 0);
});

test('mcp: post is stamped from the ancestry identity, not env; system and human kinds are refused', async () => {
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

test('mcp: objection gets the current plan hash; read returns unseen entries then by id; plan() returns the stub', async () => {
  h.freshHome();
  const { code } = h.register('alice');
  room.bind(code);
  const bytes = `---\nsub-human: ${JSON.stringify({ room: code, approval: 'all', approvers: ['alice', 'bob'] })}\n---\n# Plan\nstep 1\n`;
  const hash = plan.storeCanonical(code, bytes);
  const s = await ready();
  assert.deepEqual(payload(await s.tool('plan')), { hash: null, approvers: [], matrix: null, decided: null, stub: null, plan: null });
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
  assert.equal(p.stub, plan.stubFor(code, hash));
  assert.equal(plan.isStub(p.stub), true);
  assert.equal(plan.parseFrontmatter(p.stub).review, hash);
  assert.equal(p.plan, bytes);
  await s.close();
});
