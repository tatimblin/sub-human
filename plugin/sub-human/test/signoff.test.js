'use strict';
// Tests for mcp/signoff.js against a fake room-server ctx (a mock client answers elicitation/create).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const h = require('./helpers.js');
const room = require(path.join(h.LIB, 'room.js'));
const planLib = require(path.join(h.LIB, 'plan.js'));
const identity = require(path.join(h.LIB, 'identity.js'));
const signoff = require(path.join(h.PLUGIN, 'mcp', 'signoff.js'));

process.env.SUB_HUMAN_FORM_POLL_MS = '60000'; // tests drive tick() by hand

const flush = () => new Promise(r => setImmediate(r));

/** A fake ctx: whoami() is `who` (mutable), request() records and returns a Promise with .id. */
function world({ name = 'alice', role = 'member', caps = { elicitation: {} } } = {}) {
  h.freshHome();
  const code = h.newRoom();
  room.bind(code);
  const w = { code, me: { code, name, role, session_id: 's', pid: 1 }, caps, requests: [], notes: [] };
  let n = 0;
  w.ctx = {
    room, planLib, identity,
    whoami: () => { if (w.me) room.bind(w.me.code); return w.me; },
    clientCaps: () => w.caps,
    request(method, params) {
      let resolve, reject;
      const p = new Promise((a, b) => { resolve = a; reject = b; });
      p.id = `req-${++n}`;
      w.requests.push({ id: p.id, method, params, resolve, reject });
      return p;
    },
    notify: (method, params) => w.notes.push({ method, params }),
    send: () => {},
    text: (s, isError) => ({ content: [{ type: 'text', text: s }], ...(isError ? { isError: true } : {}) }),
    log: () => {},
  };
  w.publish = (body, approvers = ['alice', 'bob']) => {
    const text = `---\nsub-human: ${JSON.stringify({ room: code, approval: 'all', approvers })}\n---\n${planLib.PLAN_NOTICE}\n\n${body}`;
    const hash = planLib.storeCanonical(code, text);
    room.bind(code);
    room.append({ kind: 'plan_rev', text: `plan ${hash}`, plan_hash: hash, approvers }, { via: 'system', from: 'orch', system: true });
    return hash;
  };
  w.entries = () => { room.bind(code); return room.readAll(); };
  w.last = () => w.requests.at(-1);
  w.s = signoff.create(w.ctx);
  return w;
}

test('signoff: a plan_rev naming me pushes one 3-line form; approve logs a hash-bound via=human signoff', async t => {
  const w = world();
  t.after(() => w.s.stop());
  w.s.tick();
  assert.equal(w.requests.length, 0, 'no plan yet');
  const hash = w.publish('# GET /tasks paging\n\n- cursor paging, bare array, max 50\n- tests\n');
  w.s.tick();
  w.s.tick();
  assert.equal(w.requests.length, 1, 'one form at a time');
  const r = w.last();
  assert.equal(r.method, 'elicitation/create');
  assert.equal(r.params.message, [
    `sub-human · room ${w.code} · plan ${hash.slice(0, 6)} (rev 1)`,
    'GET /tasks paging',
    `Full plan: ${planLib.planPath(w.code, hash)}   (or: sub-human plan)`,
  ].join('\n'));
  const sch = r.params.requestedSchema;
  assert.deepEqual(sch.required, ['decision']);
  assert.deepEqual(sch.properties.decision.enum, ['approve', 'object']);
  assert.deepEqual(sch.properties.decision.enumNames, ['Approve (sign off)', 'Object (blocks the plan)']);
  assert.equal(sch.properties.decision.description, 'GET /tasks paging · cursor paging, bare array, max 50 · tests');
  assert.equal(sch.properties.reason.type, 'string');

  r.resolve({ action: 'accept', content: { decision: 'approve' } });
  await flush();
  const e = w.entries().at(-1);
  assert.deepEqual([e.kind, e.via, e.from, e.plan_hash], ['signoff', 'human', 'alice', hash]);
  assert.equal(room.signoffMatrix(hash).signed.alice, e.id);
  w.s.tick();
  assert.equal(w.requests.length, 1, 'answered: not offered again');
});

test('signoff: Object records the reason byte for byte', async t => {
  const w = world();
  t.after(() => w.s.stop());
  const hash = w.publish('# P\n');
  w.s.tick();
  const reason = 'cap at 10s total, not per-try; keep <retry> & "backoff" — 3 attempts $HOME `x`\n  second line\t🎉 ';
  w.last().resolve({ action: 'accept', content: { decision: 'object', reason } });
  await flush();
  const e = w.entries().at(-1);
  assert.deepEqual([e.kind, e.via, e.from, e.plan_hash], ['objection', 'human', 'alice', hash]);
  assert.equal(e.text, reason);
  w.s.tick();
  assert.equal(w.requests.length, 1);
});

test('signoff: Object without a reason records nothing and re-asks at once with a warning', async t => {
  const w = world();
  t.after(() => w.s.stop());
  w.publish('# P\n');
  w.s.tick();
  w.last().resolve({ action: 'accept', content: { decision: 'object', reason: '  \n' } });
  await flush(); await flush();
  assert.equal(w.entries().length, 1, 'only the plan_rev');
  assert.equal(w.requests.length, 2, 're-asked');
  assert.match(w.last().params.message.split('\n')[0], /· ⚠ an objection needs a reason$/);
  assert.equal(w.last().params.message.split('\n').length, 3);
  w.last().resolve({ action: 'accept', content: { decision: 'object', reason: 'too broad' } });
  await flush();
  assert.equal(w.entries().at(-1).text, 'too broad');
  w.s.tick();
  assert.equal(w.requests.length, 2);
});

test('signoff: decline and Esc log nothing; re-offered only after SUB_HUMAN_REOFFER_MS', async t => {
  process.env.SUB_HUMAN_REOFFER_MS = '150';
  const w = world();
  t.after(() => { w.s.stop(); delete process.env.SUB_HUMAN_REOFFER_MS; });
  w.publish('# P\n');
  w.s.tick();
  w.last().resolve({ action: 'cancel' });
  await flush();
  w.s.tick();
  assert.equal(w.requests.length, 1, 'not re-offered yet');
  await h.sleep(200);
  w.s.tick();
  assert.equal(w.requests.length, 2, 're-offered after the timer');
  w.last().resolve({ action: 'decline' });
  await flush();
  w.s.tick();
  assert.equal(w.requests.length, 2);
  // a client error is treated like a dismissal, not a tight loop
  await h.sleep(200);
  w.s.tick();
  w.last().reject({ code: -32603, message: 'boom' });
  await flush();
  w.s.tick();
  assert.equal(w.requests.length, 3);
  assert.equal(w.entries().length, 1, 'nothing but the plan_rev was ever logged');
});

test('signoff: default re-offer delay is 10 minutes', async t => {
  const w = world();
  t.after(() => w.s.stop());
  w.publish('# P\n');
  w.s.tick();
  w.last().resolve({ action: 'cancel' });
  await flush();
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  Date.now = () => realNow() + 9 * 60 * 1000;
  w.s.tick();
  assert.equal(w.requests.length, 1);
  Date.now = () => realNow() + 10 * 60 * 1000 + 1;
  w.s.tick();
  assert.equal(w.requests.length, 2);
});

test('signoff: a newer plan_rev cancels the open form with notifications/cancelled and offers the new one', async t => {
  const w = world();
  t.after(() => w.s.stop());
  const h1 = w.publish('# v1\n');
  w.s.tick();
  const old = w.last();
  const h2 = w.publish('# v2\n');
  w.s.tick();
  assert.deepEqual(w.notes, [{ method: 'notifications/cancelled', params: { requestId: old.id, reason: `plan ${h1} was replaced by ${h2}` } }]);
  assert.equal(w.requests.length, 2);
  assert.deepEqual(w.last().params.message.split('\n').slice(0, 2), [`sub-human · room ${w.code} · plan ${h2.slice(0, 6)} (rev 2)`, 'v2']);
  // a late answer to the stale form is ignored
  old.resolve({ action: 'accept', content: { decision: 'approve' } });
  await flush();
  assert.equal(w.entries().filter(e => e.kind === 'signoff').length, 0);
  w.last().resolve({ action: 'accept', content: { decision: 'approve' } });
  await flush();
  const e = w.entries().at(-1);
  assert.deepEqual([e.kind, e.plan_hash], ['signoff', h2]);
});

test('signoff: a decision or leaving the room cancels the open form', async t => {
  const w = world();
  t.after(() => w.s.stop());
  const hash = w.publish('# P\n');
  w.s.tick();
  room.append({ kind: 'decision', text: 'd', plan_hash: hash }, { via: 'system', from: 'orch', system: true });
  w.s.tick();
  assert.equal(w.notes.length, 1);
  assert.equal(w.notes[0].params.requestId, w.requests[0].id);
  w.s.tick();
  assert.equal(w.requests.length, 1, 'never offered for a decided plan');

  const w2 = world();
  t.after(() => w2.s.stop());
  w2.publish('# P\n');
  w2.s.tick();
  w2.me = null;
  w2.s.tick();
  assert.equal(w2.notes[0].params.requestId, w2.requests[0].id);
});

test('signoff: never offered to the orch, a non-approver, or a client without elicitation', t => {
  for (const opts of [{ name: 'orch', role: 'orch' }, { name: 'carol' }, { caps: {} }, { caps: null }]) {
    const w = world(opts);
    t.after(() => w.s.stop());
    w.publish('# P\n');
    w.s.tick();
    assert.equal(w.requests.length, 0, JSON.stringify(opts));
  }
});

test('signoff: review() re-offers at once after Esc and never reveals the answer', async t => {
  const w = world();
  t.after(() => w.s.stop());
  assert.deepEqual(w.s.tools.map(x => x.name), ['review']);
  assert.match(w.s.call('review', w.me, {}, {}).content[0].text, /no plan to review/);
  const hash = w.publish('# P\n');
  w.s.tick();
  assert.match(w.s.call('review', w.me, {}, {}).content[0].text, /already open in alice's terminal/);
  w.last().resolve({ action: 'cancel' });
  await flush();
  const r = w.s.call('review', w.me, {}, {});
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, new RegExp(`Opened the sign-off form for plan ${hash} in alice's terminal`));
  assert.equal(w.requests.length, 2);
  w.last().resolve({ action: 'accept', content: { decision: 'approve' } });
  await flush();
  assert.equal(w.entries().at(-1).kind, 'signoff');
  // after answering, review still re-offers (the human may change their mind)
  w.s.call('review', w.me, {}, {});
  assert.equal(w.requests.length, 3);
  // not an approver
  const carol = { ...w.me, name: 'carol' };
  assert.match(w.s.call('review', carol, {}, {}).content[0].text, /carol is not an approver/);
});

test('signoff: review() without the elicitation capability tells the human to update Claude Code', t => {
  const w = world({ caps: {} });
  t.after(() => w.s.stop());
  w.publish('# P\n');
  const r = w.s.call('review', w.me, {}, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /does not support elicitation/);
  assert.match(r.content[0].text, /update Claude Code/);
  assert.equal(w.requests.length, 0);
});

test('signoff: unknown tool names return null', t => {
  const w = world();
  t.after(() => w.s.stop());
  assert.equal(w.s.call('post', w.me, {}, {}), null);
});

// ---------- end to end: the real room server with a mock client (skipped until room-server.js loads signoff.js) ----------
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const wired = () => { try { return /signoff(\.js)?['"]/.test(fs.readFileSync(h.MCP, 'utf8')); } catch { return false; } };

test('signoff e2e: room-server pushes the form, a mock client objects, the stale form is cancelled', { skip: !wired() && 'room-server.js does not load signoff.js yet (owner A)' }, async t => {
  h.freshHome();
  const { code } = h.register('alice', 'member', process.pid);
  room.bind(code);
  const child = spawn(process.execPath, [h.MCP], { env: h.childEnv({ SUB_HUMAN_FORM_POLL_MS: '100' }), stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  const got = [];
  let buf = '';
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) got.push(JSON.parse(l)); }
  });
  const send = m => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, clientInfo: { name: 'mock', version: '0' } } });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list' });
  await h.until(() => got.some(m => m.id === 2), 5000);
  assert.ok(got.find(m => m.id === 2).result.tools.some(x => x.name === 'review'), 'review tool listed');

  const pub = body => {
    const text = `---\nsub-human: ${JSON.stringify({ room: code, approval: 'all', approvers: ['alice'] })}\n---\n${planLib.PLAN_NOTICE}\n${body}`;
    const hash = planLib.storeCanonical(code, text);
    room.bind(code);
    room.append({ kind: 'plan_rev', text: `plan ${hash}`, plan_hash: hash, approvers: ['alice'] }, { via: 'system', from: 'orch', system: true });
    return hash;
  };
  const forms = () => got.filter(m => m.method === 'elicitation/create');
  const h1 = pub('# v1\n');
  assert.ok(await h.until(() => forms().length === 1, 5000), 'form pushed');
  assert.match(forms()[0].params.message, new RegExp(`^sub-human · room ${code} · plan ${h1.slice(0, 6)} \\(rev 1\\)\nv1\nFull plan: `));
  const h2 = pub('# v2\n');
  assert.ok(await h.until(() => forms().length === 2, 5000), 'new form pushed');
  const cancelled = got.find(m => m.method === 'notifications/cancelled');
  assert.ok(cancelled, 'stale form cancelled');
  assert.equal(cancelled.params.requestId, forms()[0].id);
  const reason = 'not per-try; keep <retry> & "backoff" — `x`';
  send({ id: forms()[1].id, result: { action: 'accept', content: { decision: 'object', reason } } });
  const obj = await h.until(() => { room.bind(code); return room.readAll().find(e => e.kind === 'objection'); }, 5000);
  assert.ok(obj, 'objection logged');
  assert.deepEqual([obj.via, obj.from, obj.plan_hash, obj.text], ['human', 'alice', h2, reason]);
});
