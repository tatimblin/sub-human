'use strict';
// hooks/tasks.js: the PostToolUse TaskCreate|TaskUpdate mirror and the TaskCompleted gate (orch only).
// Payload shapes are the ones S1 logged from a --bg orch (docs/next/S1-headless-orch.md §4).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { World, PLUGIN, room } = require('./helpers.js');
const tasks = require(path.join(PLUGIN, 'lib', 'tasks.js'));

const create = (id, subject, extra = {}) => ({
  hook_event_name: 'PostToolUse', agent_type: 'sub-human:orchestrator', tool_name: 'TaskCreate',
  tool_input: { subject, description: subject, ...extra }, tool_response: { task: { id: String(id), subject } },
});
const update = (id, input, resp = {}) => ({
  hook_event_name: 'PostToolUse', agent_type: 'sub-human:orchestrator', tool_name: 'TaskUpdate',
  tool_input: { taskId: String(id), ...input }, tool_response: { success: true, taskId: String(id), updatedFields: Object.keys(input), ...resp },
});
const completed = (id, subject) => ({ hook_event_name: 'TaskCompleted', agent_type: 'sub-human:orchestrator', task_id: String(id), task_subject: subject, task_description: subject });

function world() {
  const w = new World({ orch: 'sleep', alice: 'sleep', bob: 'sleep' });
  w.native = path.join(w.userHome, '.claude', 'tasks', `sh-${w.code}`);
  fs.mkdirSync(w.native, { recursive: true });
  w.writeNative = t => fs.writeFileSync(path.join(w.native, `${t.id}.json`), JSON.stringify(t));
  w.run = (input, as = 'orch') => w.hook('tasks', input, { as, env: { CLAUDE_CODE_TASK_LIST_ID: `sh-${w.code}` } });
  w.list = () => w.lib(() => tasks.list(w.code));
  w.taskEntries = () => w.entries().filter(e => e.kind === 'task');
  return w;
}

test('mirror: creates and updates land in tasks.json with a task entry; the room task is left out', () => {
  const w = world();
  let r = w.run(create(1, `room ${w.code} open`));
  assert.equal(r.code, 0, r.stderr);
  r = w.run(update(1, { status: 'in_progress', owner: 'room' }, { statusChange: { from: 'pending', to: 'in_progress' } }));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(w.list(), []);
  assert.equal(w.taskEntries().length, 0);

  r = w.run(create(2, 'parser tests', { description: 'cover edges (req #7 by bob)' }));
  assert.equal(r.code, 0, r.stderr);
  w.run(update(2, { owner: 'bob' }));
  w.run(update(2, { status: 'in_progress' }, { statusChange: { from: 'pending', to: 'in_progress' } }));
  w.run(update(2, { addBlockedBy: ['3'] }));
  assert.deepEqual(w.list(), [{ id: '2', subject: 'parser tests', status: 'in_progress', owner: 'bob', blockedBy: ['3'] }]);
  const ents = w.taskEntries();
  assert.deepEqual(ents.map(e => [e.via, e.from, e.op]), [['system', 'orch', 'add'], ['system', 'orch', 'claim'], ['system', 'orch', 'update'], ['system', 'orch', 'update']]);
  assert.equal(ents[0].req, 7);
  assert.equal(ents[1].owner, 'bob');

  // description-only change: mirror unchanged, no entry
  w.run(update(2, { description: 'cover edges (req #7 by bob)\nevidence (#9): green' }));
  assert.equal(w.taskEntries().length, 4);
  w.run(update(2, { status: 'completed' }, { statusChange: { from: 'in_progress', to: 'completed' } }));
  const last = w.taskEntries().at(-1);
  assert.deepEqual([last.op, last.status], ['done', 'completed']);
  assert.equal(w.list()[0].status, 'completed');
  // delete removes it
  w.run(update(2, { status: 'deleted' }));
  assert.deepEqual(w.list(), []);
  assert.equal(w.taskEntries().at(-1).op, 'delete');
});

test('mirror: skips a refused update (success:false), _internal tasks and non-orch sessions', () => {
  const w = world();
  w.run(create(2, 'docs'));
  const refused = update(2, { status: 'completed' });
  refused.tool_response = { success: false, taskId: '2', updatedFields: [], error: 'TaskCompleted hook feedback: only bob may complete #2; ask them' };
  let r = w.run(refused);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(w.list()[0].status, 'pending');
  assert.equal(w.taskEntries().length, 1);

  w.run(create(3, 'hidden', { metadata: { _internal: true } }));
  w.writeNative({ id: '4', subject: 'hidden too', status: 'in_progress', metadata: { _internal: true } });
  w.run(update(4, { owner: 'x' }));
  assert.deepEqual(w.list().map(t => t.id), ['2']);

  // a member's own (private) task list: nothing is mirrored
  r = w.run(create(5, 'alice private'), 'alice');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(w.list().map(t => t.id), ['2']);
});

test('mirror: an update with no earlier mirror entry reads the native task file', () => {
  const w = world();
  w.writeNative({ id: '6', subject: 'from disk', description: 'x (req #3 by alice)', status: 'pending', owner: 'alice', blockedBy: ['2'] });
  const r = w.run(update(6, { status: 'in_progress' }));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(w.list(), [{ id: '6', subject: 'from disk', status: 'in_progress', owner: 'alice', blockedBy: ['2'] }]);
  assert.equal(w.taskEntries().at(-1).req, 3);
  // the native store is only read
  assert.deepEqual(fs.readdirSync(w.native), ['6.json']);
});

test('gate: TaskCompleted exits 2 unless the owner asked for done; room task 1 until closing', () => {
  const w = world();
  w.run(create(1, `room ${w.code} open`));
  w.writeNative({ id: '1', subject: `room ${w.code} open`, status: 'in_progress', owner: 'room' });
  w.writeNative({ id: '2', subject: 'parser tests', status: 'in_progress', owner: 'bob' });

  let r = w.run(completed(1, `room ${w.code} open`));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /stays open until the room closes/);

  r = w.run(completed(2, 'parser tests'));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /only bob may complete #2; ask them/);

  w.append({ kind: 'task_req', text: 'task done #2', op: 'done', id: '2', evidence: 'looks done', owner: 'alice' }, { via: 'agent', from: 'alice' });
  assert.equal(w.run(completed(2, 'parser tests')).code, 2);
  w.append({ kind: 'task_req', text: 'task done #2', op: 'done', id: '2', evidence: 'npm test green', owner: 'bob' }, { via: 'agent', from: 'bob' });
  r = w.run(completed(2, 'parser tests'));
  assert.equal(r.code, 0, r.stderr);

  // a member's private TaskCompleted is never gated
  assert.equal(w.run(completed(1, 'my own thing'), 'alice').code, 0);

  // closing: task 1 may complete
  const f = path.join(w.home, 'rooms', w.code, 'members.json');
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({ ...m, closing: true }));
  r = w.run(completed(1, `room ${w.code} open`));
  assert.equal(r.code, 0, r.stderr);
});

test('orch detection before binding: SUB_HUMAN_ROOM + agent_type', () => {
  const w = world();
  const r = w.hook('tasks', create(2, 'early'), { env: { SUB_HUMAN_ROOM: w.code, CLAUDE_CODE_TASK_LIST_ID: `sh-${w.code}` } });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(w.list().map(t => t.id), ['2']);
  const r2 = w.hook('tasks', { ...create(3, 'not orch'), agent_type: 'general-purpose' }, { env: { SUB_HUMAN_ROOM: w.code } });
  assert.equal(r2.code, 0, r2.stderr);
  assert.deepEqual(w.list().map(t => t.id), ['2']);
});
