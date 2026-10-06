'use strict';
// Tests for lib/tasks.js (validate, gate, summary, the mirror file) and the mcp/task.js plug-in.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers.js');
const identity = require(path.join(h.LIB, 'identity.js'));
const room = require(path.join(h.LIB, 'room.js'));
const tasks = require(path.join(h.LIB, 'tasks.js'));
const io = require(path.join(h.LIB, 'io.js'));
const taskPlugin = require(path.join(h.PLUGIN, 'mcp', 'task.js'));

// ---------- validate ----------
test('validate: op shapes; done needs evidence', () => {
  assert.equal(tasks.validate({ op: 'add', subject: '  parser   tests ' }).req.subject, 'parser tests');
  assert.match(tasks.validate({ op: 'add' }).error, /subject/);
  assert.match(tasks.validate({ op: 'claim' }).error, /id/);
  assert.match(tasks.validate({ op: 'release', id: 'x' }).error, /id/);
  assert.equal(tasks.validate({ op: 'claim', id: 3 }).req.id, '3');
  assert.match(tasks.validate({ op: 'done', id: '3' }).error, /evidence/);
  assert.match(tasks.validate({ op: 'done', id: '3', evidence: '   ' }).error, /evidence/);
  assert.deepEqual(tasks.validate({ op: 'done', id: '3', evidence: 'npm test: 12 pass' }).req, { op: 'done', id: '3', evidence: 'npm test: 12 pass' });
  assert.match(tasks.validate({ op: 'delete', id: '3' }).error, /op must be/);
  assert.match(tasks.validate({ op: 'add', subject: 'x', for: 'room' }).error, /cannot own/);
  assert.match(tasks.validate({ op: 'add', subject: 'x', for: 'bad name' }).error, /invalid name/);
  assert.match(tasks.validate({ op: 'add', subject: 'x'.repeat(201) }).error, /200/);
  assert.equal(tasks.validate({ op: 'add', subject: 'x', for: 'bob' }).req.for, 'bob');
  assert.equal(tasks.validate(null).ok, false);
});

// ---------- gate ----------
let nextId = 1;
const req = (from, op, id, extra = {}) => ({ id: nextId++, from, via: 'agent', kind: 'task_req', text: `task ${op} #${id}`, op, task_id: String(id), owner: from, ...extra });
const human = (from, text, refs) => ({ id: nextId++, from, via: 'human', kind: 'say', text, ...(refs ? { refs } : {}) });
const retract = ids => ({ id: nextId++, from: 'orch', via: 'system', kind: 'retract', text: 'retracted', refs: ids });

test('gate: the owner\'s done with evidence passes; another member\'s done fails', () => {
  const code = h.newRoom();
  const t = { id: '2', subject: 'parser tests', owner: 'bob' };
  const claim = req('bob', 'claim', 2);
  const done = req('bob', 'done', 2, { evidence: 'tests pass' });
  const r = tasks.gate(code, t, [claim, done]);
  assert.equal(r.ok, true);
  assert.equal(r.req.id, done.id);

  const alice = req('alice', 'done', 2, { evidence: 'looks done' });
  const r2 = tasks.gate(code, t, [claim, alice]);
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'only bob may complete #2; ask them');
  // no request at all
  assert.equal(tasks.gate(code, t, []).ok, false);
  // another task's done does not count
  assert.equal(tasks.gate(code, t, [req('bob', 'done', 3, { evidence: 'x' })]).ok, false);
  // a done request with no evidence (e.g. a hand-written entry) does not count
  assert.equal(tasks.gate(code, t, [req('bob', 'done', 2)]).ok, false);
});

test('gate: the owner\'s [human] words citing another\'s done request pass', () => {
  const code = h.newRoom();
  const t = { id: '4', subject: 'docs', owner: 'bob' };
  const alice = req('alice', 'done', 4, { evidence: 'README updated' });
  assert.equal(tasks.gate(code, t, [alice, human('bob', `yes, #${alice.id} is right`)]).ok, true);
  assert.equal(tasks.gate(code, t, [alice, human('bob', 'unrelated', [alice.id])]).ok, true);
  assert.equal(tasks.gate(code, t, [alice, human('alice', `#${alice.id} done`)]).ok, false);
  assert.equal(tasks.gate(code, t, [alice, human('bob', `#${alice.id}0 is wrong`)]).ok, false);
});

test('gate: a retracted request and a stale claim fail', () => {
  const code = h.newRoom();
  const t = { id: '2', subject: 'parser tests', owner: 'bob' };
  const done = req('bob', 'done', 2, { evidence: 'tests pass' });
  assert.equal(tasks.gate(code, t, [done, retract([done.id])]).ok, false);
  // done, then a newer claim of the task: the done is stale
  const done2 = req('bob', 'done', 2, { evidence: 'tests pass' });
  const reclaim = req('bob', 'claim', 2);
  assert.equal(tasks.gate(code, t, [done2, reclaim]).ok, false);
  // a fresh done after the claim passes again
  assert.equal(tasks.gate(code, t, [done2, reclaim, req('bob', 'done', 2, { evidence: 'again' })]).ok, true);
  // unowned task
  assert.match(tasks.gate(code, { id: '9', subject: 'x', owner: null }, []).reason, /no owner/);
});

test('gate: the room-open task completes only while the room is closing', () => {
  const code = h.newRoom();
  const t1 = { id: '1', subject: `room ${code} open`, owner: 'room' };
  const r = tasks.gate(code, t1, [req('bob', 'done', 1, { evidence: 'x' })]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /stays open until the room closes/);
  assert.equal(tasks.gate(code, { id: '1', subject: `room ${code} open` }, []).ok, false); // before its owner is set
  assert.equal(tasks.gate(code, { id: '5', subject: 'probe', owner: 'room' }, []).ok, false); // owner room
  assert.equal(tasks.gate(code, t1, [], { closing: true }).ok, true);
  // closing read from members.json
  assert.equal(tasks.isClosing(code), false);
  const f = path.join(identity.roomDir(code), 'members.json');
  io.writeJsonAtomic(f, { ...identity.readMembers(code), closing: new Date().toISOString() });
  assert.equal(tasks.gate(code, t1, []).ok, true);
  io.writeJsonAtomic(f, { orch: { name: 'orch', role: 'orch', pid: 1, closing: true } });
  assert.equal(tasks.isClosing(code), true);
});

// ---------- the mirror file and summary ----------
test('writeList omits the room task; list and summary per viewer', () => {
  const code = h.newRoom();
  assert.deepEqual(tasks.list(code), []);
  assert.equal(tasks.summary(code, 'alice'), '');
  tasks.writeList(code, [
    { id: '1', subject: `room ${code} open`, status: 'in_progress', owner: 'room' },
    { id: '4', subject: 'docs', status: 'in_progress', owner: 'bob', metadata: { x: 1 } },
    { id: '2', subject: 'parser tests', status: 'pending', owner: 'alice' },
    { id: '3', subject: 'unowned', status: 'pending' },
    { id: '5', subject: 'old', status: 'completed', owner: 'alice' },
  ]);
  const l = tasks.list(code);
  assert.deepEqual(l.map(t => t.id), ['2', '3', '4', '5']);
  assert.deepEqual(Object.keys(l[0]).sort(), ['blockedBy', 'id', 'owner', 'status', 'subject']);
  assert.equal(tasks.summary(code, 'alice'), 'tasks 3 open · #2 you · #4 bob');
  assert.equal(tasks.summary(code, 'bob'), 'tasks 3 open · #2 alice · #4 you');
  assert.deepEqual(tasks.mine(code, 'alice').map(t => t.id), ['2']);
  tasks.writeList(code, [{ id: '2', subject: 'a', status: 'completed', owner: 'alice' }]);
  assert.equal(tasks.summary(code, 'alice'), 'tasks: all 1 done');
  tasks.writeList(code, ['1', '2', '3', '4', '5'].map(id => ({ id, subject: 's' + id, status: 'pending', owner: 'o' + id })));
  assert.equal(tasks.summary(code, 'x'), 'tasks 5 open · #1 o1 · #2 o2 · #3 o3 · +2');
});

// ---------- mcp/task.js ----------
function ctxFor() {
  return {
    room, identity,
    text: (s, isError) => ({ content: [{ type: 'text', text: String(s) }], ...(isError ? { isError: true } : {}) }),
  };
}
const out = r => r.content[0].text;

test('task tool: no orch, refusals, queued request', () => {
  h.freshHome();
  const code = h.newRoom();
  const sleeper = h.spawnSleeper();
  const me = { code, name: 'alice', role: 'member', pid: process.pid };
  identity.join({ code, name: 'alice', role: 'member', pid: process.pid, session_id: 's-a' });
  identity.join({ code, name: 'bob', role: 'member', pid: sleeper.pid + 0, session_id: 's-b' });
  room.bind(code);
  const api = taskPlugin.create(ctxFor());
  assert.deepEqual(api.tools.map(t => t.name), ['task']);
  assert.ok(JSON.stringify(api.tools[0]).length <= 400);

  assert.equal(out(api.call('task', me, { op: 'add', subject: 'parser tests' })), 'no orch: the room task list is unavailable');
  assert.equal(room.readAll().length, 0);

  const orchProc = h.spawnSleeper();
  identity.join({ code, name: 'orch', role: 'orch', pid: orchProc.pid, session_id: 's-o' });
  let r = api.call('task', me, { op: 'done', id: '2' });
  assert.equal(r.isError, true);
  assert.match(out(r), /evidence/);
  assert.match(out(api.call('task', me, { op: 'add', subject: 'x', for: 'carol' })), /no member named carol/);

  r = api.call('task', me, { op: 'add', subject: 'parser tests', detail: 'cover the edge cases', for: 'bob' });
  const e = room.readAll().at(-1);
  assert.equal(out(r), 'queued; the orch applies it');
  assert.deepEqual([e.kind, e.from, e.via], ['task_req', 'alice', 'agent']);
  assert.deepEqual(tasks.reqOf(e), { op: 'add', id: null, subject: 'parser tests', detail: 'cover the edge cases', evidence: null, owner: 'bob', status: null, req: null, by: 'alice' });

  api.call('task', me, { op: 'done', id: '2', evidence: 'npm test green' });
  const d = room.readAll().at(-1);
  assert.deepEqual([tasks.reqOf(d).op, tasks.reqOf(d).id, tasks.reqOf(d).owner, tasks.reqOf(d).evidence], ['done', '2', 'alice', 'npm test green']);
  assert.match(d.text, /done #2/);

  // the orch itself is told to use its native tools
  assert.match(out(api.call('task', { code, name: 'orch', role: 'orch' }, { op: 'add', subject: 'x' })), /TaskCreate/);
});
