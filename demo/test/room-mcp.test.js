'use strict';
// Tests for demo/bin/room-mcp: spawn it as a child against a temp ROOM_DIR and drive it with JSON-RPC.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const DEMO = path.join(__dirname, '..');
const MCP = path.join(DEMO, 'bin', 'room-mcp');
const ROOM = path.join(DEMO, 'bin', 'room');

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));

function env(extra) {
  const e = { ...process.env, ...extra };
  delete e.NODE_TEST_CONTEXT;
  return e;
}

/** Start room-mcp; returns {call, notes, close, child}. */
function startMcp(roomDir, extra = {}) {
  const child = spawn(process.execPath, [MCP], {
    env: env({ ROOM_DIR: roomDir, ROOM_USER: 'alice', ROOM_MCP_POLL_MS: '50', ...extra }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiters = new Map();
  const notes = [];
  let buf = '', nextId = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', d => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (msg.id != null && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); } else notes.push(msg);
    }
  });
  const call = (method, params) => {
    const id = nextId++;
    const p = new Promise(r => waiters.set(id, r));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return p;
  };
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const exited = new Promise(r => child.on('exit', code => r(code)));
  const close = () => { child.stdin.end(); return exited; };
  return { call, notify, notes, close, exited, child };
}

async function ready(roomDir, extra) {
  const s = startMcp(roomDir, extra);
  const init = await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'room');
  s.notify('notifications/initialized');
  return s;
}

const tool = (s, name, args, meta) => s.call('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
const payload = r => JSON.parse(r.result.content[0].text);
const roomPost = (roomDir, user, args, input) =>
  spawnSync(ROOM, ['post', ...args], { env: env({ ROOM_DIR: roomDir, ROOM_USER: user }), input, encoding: 'utf8' });
const logEntries = d => fs.readFileSync(path.join(d, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('room-mcp: tools/list returns await_human, post, read', async () => {
  const s = await ready(tmp('mcp-'));
  const r = await s.call('tools/list', {});
  assert.deepEqual(r.result.tools.map(t => t.name).sort(), ['await_human', 'post', 'read']);
  assert.equal(await s.close(), 0);
});

test('room-mcp: await_human blocks, ignores own posts and bob, wakes on to:alice and on a directive', async () => {
  const d = tmp('mcp-');
  const s = await ready(d);
  roomPost(d, 'bob', ['--kind', 'say', 'hello room']); // #1, to room: not for alice's seat
  let settled = false;
  const p = tool(s, 'await_human', { after_seq: 0 }).then(r => { settled = true; return r; });
  await sleep(200);
  assert.equal(settled, false, 'should still be blocked');
  // the seat's own post must not wake it
  const own = await tool(s, 'post', { kind: 'status', text: 'reading the code' });
  assert.equal(own.result.isError, undefined);
  roomPost(d, 'bob', ['--kind', 'ask', '--to', 'bob', 'for bob only']);
  roomPost(d, 'orch', ['--kind', 'directive', '--to', 'bob', 'bob, do X']);
  await sleep(250);
  assert.equal(settled, false, 'own posts and bob-addressed entries must not wake alice');
  // an ask from alice (chat writes via=human, to=alice); write it the way chat does
  const chat = spawnSync(path.join(DEMO, 'bin', 'chat'), [], { env: env({ ROOM_DIR: d, ROOM_USER: 'alice' }), input: '/ask please check "auth" & `tests`\n', encoding: 'utf8' });
  assert.equal(chat.status, 0, chat.stderr);
  const got = payload(await p);
  assert.equal(got.length, 1);
  assert.equal(got[0].from, 'alice');
  assert.equal(got[0].via, 'human');
  assert.equal(got[0].to, 'alice');
  assert.equal(got[0].text, 'please check "auth" & `tests`');
  const after = got[0].id;

  // directive to alice wakes the next wait
  const p2 = tool(s, 'await_human', { after_seq: after });
  await sleep(150);
  roomPost(d, 'orch', ['--kind', 'directive', '--to', 'alice', 'alice: review the plan']);
  const got2 = payload(await p2);
  assert.deepEqual(got2.map(e => [e.kind, e.from, e.to]), [['directive', 'orch', 'alice']]);
  assert.equal(await s.close(), 0);
});

test('room-mcp: concurrent waits both resolve; disconnect kills pending pollers', async () => {
  const d = tmp('mcp-');
  const s = await ready(d);
  const a = tool(s, 'await_human', { after_seq: 0 });
  const b = tool(s, 'await_human', { after_seq: 0 });
  await sleep(100);
  roomPost(d, 'orch', ['--kind', 'directive', '--to', 'alice', 'go']);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(payload(ra)[0].text, 'go');
  assert.equal(payload(rb)[0].text, 'go');
  tool(s, 'await_human', { after_seq: 99 }); // left pending
  await sleep(100);
  const t0 = Date.now();
  assert.equal(await s.close(), 0);
  assert.ok(Date.now() - t0 < 2000, 'exits promptly on stdin close with a wait pending');
});

test('room-mcp: progress notifications while waiting when a progressToken is given', async () => {
  const d = tmp('mcp-');
  const s = await ready(d, { ROOM_MCP_PROGRESS_MS: '60' });
  const p = tool(s, 'await_human', { after_seq: 0 }, { progressToken: 'tok-7' });
  await sleep(400);
  roomPost(d, 'orch', ['--kind', 'shutdown', 'room closed']);
  const r = payload(await p);
  assert.equal(r[0].kind, 'shutdown');
  const prog = s.notes.filter(n => n.method === 'notifications/progress');
  assert.ok(prog.length >= 3, `expected >=3 progress notes, got ${prog.length}`);
  assert.ok(prog.every(n => n.params.progressToken === 'tok-7'));
  assert.ok(prog.every((n, i) => i === 0 || n.params.progress > prog[i - 1].params.progress), 'progress increases');
  // no token -> no progress
  const before = s.notes.length;
  const p2 = tool(s, 'await_human', { after_seq: r[0].id });
  await sleep(250);
  roomPost(d, 'orch', ['--kind', 'directive', '--to', 'alice', 'next']);
  await p2;
  assert.equal(s.notes.slice(before).filter(n => n.method === 'notifications/progress').length, 0);
  await s.close();
});

test('room-mcp: await_human times out with {timeout:true, last_seq}', async () => {
  const d = tmp('mcp-');
  roomPost(d, 'bob', ['not for alice']);
  roomPost(d, 'bob', ['--kind', 'ask', '--to', 'bob', 'also not']);
  const s = await ready(d, { ROOM_MCP_AWAIT_MS: '300' });
  const t0 = Date.now();
  const r = payload(await tool(s, 'await_human', { after_seq: 0 }));
  assert.deepEqual(r, { timeout: true, last_seq: 2 });
  assert.ok(Date.now() - t0 >= 280);
  await s.close();
});

test('room-mcp: post stamps from=alice via=agent, fills objection plan_hash, rejects signoff/say/plan_rev', async () => {
  const d = tmp('mcp-');
  // a plan_rev the way the plan hook writes it
  const room = require(path.join(DEMO, 'lib', 'room.js'));
  const old = { ROOM_DIR: process.env.ROOM_DIR, ROOM_USER: process.env.ROOM_USER };
  process.env.ROOM_DIR = d; process.env.ROOM_USER = 'orch';
  try { room.append({ kind: 'plan_rev', text: 'plans/p.md', plan_hash: 'abcdef012345' }, { via: 'agent', allowPlanRev: true }); }
  finally { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
  fs.writeFileSync(path.join(d, 'roster.json'), JSON.stringify({ 'agent-123': 'alice', 'agent-456': 'bob' }));

  const s = await ready(d, { ROOM_USER: 'alice' });
  const ok = payload(await tool(s, 'post', { kind: 'proposal', text: 'split by file', refs: [1] }));
  assert.equal(ok.from, 'alice');
  assert.equal(ok.via, 'agent');
  assert.equal(ok.agent_id, 'agent-123');
  assert.deepEqual(ok.refs, [1]);
  const obj = payload(await tool(s, 'post', { kind: 'objection', text: 'retry is missing' }));
  assert.equal(obj.plan_hash, 'abcdef012345');
  for (const kind of ['signoff', 'revoke', 'say', 'plan_rev']) {
    const r = await tool(s, 'post', { kind, text: 'x', plan_hash: 'abcdef012345' });
    assert.equal(r.result.isError, true, kind);
    assert.match(r.result.content[0].text, /refused/);
  }
  const forged = await tool(s, 'post', { kind: 'status', text: 'x', from: 'bob' });
  assert.equal(payload(forged).from, 'alice', 'unknown args cannot change identity');
  const es = logEntries(d);
  assert.equal(es.length, 4);
  assert.ok(es.slice(1).every(e => e.from === 'alice' && e.via === 'agent'));
  const rd = payload(await tool(s, 'read', { ids: [2, 1] }));
  assert.deepEqual(rd.map(e => e.id), [2, 1]);
  await s.close();
});

test('room-mcp: done refuses when the tests are red, posts with evidence when green', async () => {
  const d = tmp('mcp-');
  const app = tmp('mcp-app-');
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'tiny', private: true, scripts: { test: 'node --test' } }));
  fs.mkdirSync(path.join(app, 'test'));
  const t = path.join(app, 'test', 'a.test.js');
  fs.writeFileSync(t, "require('node:test')('ok', () => {});\nrequire('node:test')('red', () => { throw new Error('boom'); });\n");
  const s = await ready(d, { ROOM_APP_DIR: app });
  const red = await tool(s, 'post', { kind: 'done', text: 'my part' });
  assert.equal(red.result.isError, true);
  assert.match(red.result.content[0].text, /1\/2 pass/);
  assert.equal(fs.existsSync(path.join(d, 'log.jsonl')), false, 'nothing written on red');
  fs.writeFileSync(t, "require('node:test')('ok', () => {});\n");
  const green = payload(await tool(s, 'post', { kind: 'done', text: 'my part' }));
  assert.equal(green.kind, 'done');
  assert.equal(green.via, 'agent');
  assert.deepEqual(green.evidence, { pass: 1, total: 1, failed: [] });
  await s.close();
});
