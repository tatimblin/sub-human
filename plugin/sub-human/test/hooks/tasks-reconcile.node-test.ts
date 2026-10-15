// hooks/tasks.ts reconcile: a lost mirror run leaves a native task with no `task` entry; the next room Claude run of
// tasks.ts (mirror or gate) appends its snapshot, and never resurrects a task the log deleted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { World, PLUGIN } from './helpers.ts';
import * as tasks from '../../lib/tasks.ts';

const create = (id, subject, extra = {}) => ({
  hook_event_name: 'PostToolUse', agent_type: 'sub-human:room-claude', tool_name: 'TaskCreate',
  tool_input: { subject, description: subject, ...extra }, tool_response: { task: { id: String(id), subject } },
});
const update = (id, input) => ({
  hook_event_name: 'PostToolUse', agent_type: 'sub-human:room-claude', tool_name: 'TaskUpdate',
  tool_input: { taskId: String(id), ...input }, tool_response: { success: true, taskId: String(id), updatedFields: Object.keys(input) },
});
const completed = (id, subject) => ({ hook_event_name: 'TaskCompleted', agent_type: 'sub-human:room-claude', task_id: String(id), task_subject: subject });

function world() {
  const w = new World({ claude: 'sleep', bob: 'sleep' });
  w.native = path.join(w.userHome, '.claude', 'tasks', `sh-${w.code}`);
  fs.mkdirSync(w.native, { recursive: true });
  w.writeNative = t => fs.writeFileSync(path.join(w.native, `${t.id}.json`), JSON.stringify(t));
  w.run = (input, as = 'claude') => w.hook('tasks', input, { as, env: { CLAUDE_CODE_TASK_LIST_ID: `sh-${w.code}` } });
  w.list = () => w.lib(() => tasks.list(w.code));
  w.taskEntries = () => w.entries().filter(e => e.kind === 'task');
  return w;
}

test('reconcile: a TaskCreate whose mirror run was dropped is restored by the next run', () => {
  const w = world();
  w.writeNative({ id: '2', subject: 'parser tests', description: 'cover edges', status: 'pending', owner: null, blockedBy: [], metadata: { req: 7, by: 'bob' } });
  // TaskCreate #2 happened natively, but its PostToolUse never reached tasks.ts
  w.writeNative({ id: '3', subject: 'docs', status: 'pending', blockedBy: [] });
  const r = w.run(create(3, 'docs'));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(w.list().map(t => [t.id, t.subject]), [['2', 'parser tests'], ['3', 'docs']]);
  const ents = w.taskEntries();
  assert.deepEqual(ents.map(e => [e.task_id, e.op]), [['3', 'add'], ['2', 'add']]);
  assert.equal(ents[1].req, 7);
  // restored once: the next run finds it recorded
  w.run(update(3, { owner: 'bob' }));
  assert.equal(w.taskEntries().filter(e => e.task_id === '2').length, 1);
});

test('reconcile: a gate run restores too, and its verdict is unchanged', () => {
  const w = world();
  w.writeNative({ id: '4', subject: 'lint', status: 'in_progress', owner: 'bob', blockedBy: ['2'] });
  const r = w.run(completed(4, 'lint'));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /only bob may complete #4/);
  assert.deepEqual(w.list(), [{ id: '4', subject: 'lint', status: 'in_progress', owner: 'bob', blockedBy: ['2'] }]);
});

test('reconcile: skips the room task, _internal tasks, a task the log deleted, and members\' sessions', () => {
  const w = world();
  w.writeNative({ id: '1', subject: `room ${w.code} open`, status: 'in_progress', owner: 'room' });
  w.writeNative({ id: '5', subject: 'hidden', status: 'pending', metadata: { _internal: true } });
  w.run(create(6, 'gone'));
  w.run(update(6, { status: 'deleted' }));
  w.writeNative({ id: '6', subject: 'gone', status: 'pending' }); // a lingering file
  w.run(create(7, 'kept'));
  assert.deepEqual(w.list().map(t => t.id), ['7']);
  assert.equal(w.taskEntries().length, 3);

  const v = world();
  v.writeNative({ id: '2', subject: 'x', status: 'pending' });
  assert.equal(v.run(create(9, 'private'), 'bob').code, 0);
  assert.deepEqual(v.taskEntries(), []);
});
