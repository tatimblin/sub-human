// The bridge's map and mapping (module/tasks.ts), pure: what the kit tests (tasks.test.ts) don't reach.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RoomState, Task } from '../core/entries.js';
import { EMPTY, asRoom } from '../core/fold.js';
import { bridgeCall, fill, native, needsList, remember } from './tasks.js';

const ROOM = { home: '/h', code: 'otter-4821', name: 'alice', title: 'alice.otter-4821', dir: '/h/r', root: '/w' };
const update = (taskId: string, to: string) => ({ result: { success: true, taskId, updatedFields: ['status'], statusChange: { from: 'in_progress', to } } });
const TASK: Task = { n: 3, title: 'paging', status: 'claimed', owner: 'alice', addedBy: 'bob', blockedBy: [] };
const withTask = (task: Task): RoomState => ({ ...asRoom(EMPTY), tasks: [task] });

test('a rename re-tags a task, and a tag of another room is no op here', () => {
  const m = native();
  remember(m, { tool: 'TaskCreate', subject: 'paging' }, { result: { task: { id: '1', subject: 'paging' } } });
  assert.equal(bridgeCall(update('1', 'completed'), m, ROOM, null), null); // untagged: capture's activity
  remember(m, { tool: 'TaskUpdate', taskId: '1', subject: 'paging [room otter-4821#3]' }, update('1', 'in_progress'));
  assert.deepEqual(bridgeCall(update('1', 'completed'), m, ROOM, null), { op: 'task', code: 'otter-4821', from: 'alice', act: 'done', n: 3 });
  remember(m, { tool: 'TaskUpdate', taskId: '1', subject: 'paging [room vole-8126#3]' }, update('1', 'in_progress'));
  assert.equal(bridgeCall(update('1', 'completed'), m, ROOM, null), null);
  remember(m, { tool: 'TaskUpdate', taskId: '1', subject: '[room vole-8126#3] paging [room otter-4821#2]' }, update('1', 'in_progress'));
  assert.deepEqual(bridgeCall(update('1', 'completed'), m, ROOM, null), { op: 'task', code: 'otter-4821', from: 'alice', act: 'done', n: 2 });
});

test('a change the room task already shows sends nothing; one it doesn\'t is sent for the host to judge', () => {
  const m = native();
  remember(m, { tool: 'TaskCreate' }, { result: { task: { id: '1', subject: '[room otter-4821#3]' } } });
  const { owner: _o, ...open } = TASK;
  assert.equal(bridgeCall(update('1', 'completed'), m, ROOM, withTask({ ...TASK, status: 'done' })), 'already');
  assert.equal(bridgeCall(update('1', 'deleted'), m, ROOM, withTask({ ...open, status: 'open' })), 'already');
  assert.deepEqual(bridgeCall(update('1', 'deleted'), m, ROOM, withTask({ ...TASK, owner: 'bob' })), { op: 'task', code: 'otter-4821', from: 'alice', act: 'release', n: 3 });
});

test('TaskList is asked once per session id, only for a task the map lacks, and again after a list that failed', () => {
  const m = native();
  assert.equal(needsList(m, 's1', { tool: 'TaskCreate', subject: 'x' }), false);
  assert.equal(needsList(m, 's1', { tool: 'TaskUpdate', taskId: '4' }), true);
  assert.equal(fill(m, { deny: 'not now' }), false);
  assert.equal(needsList(m, 's1', { tool: 'TaskUpdate', taskId: '4' }), true); // a refusal doesn't turn the bridge off
  assert.equal(fill(m, { result: { tasks: [] } }), true);
  assert.equal(needsList(m, 's1', { tool: 'TaskUpdate', taskId: '4' }), false);
  remember(m, { tool: 'TaskCreate' }, { result: { task: { id: '5', subject: '[room otter-4821#1]' } } });
  assert.equal(needsList(m, 's2', { tool: 'TaskUpdate', taskId: '5' }), true); // a new session id starts the map again
  fill(m, { result: { tasks: [{ id: '5', subject: '[room otter-4821#1]', status: 'pending', blockedBy: [] }] } });
  assert.deepEqual(bridgeCall(update('5', 'deleted'), m, ROOM, null), { op: 'task', code: 'otter-4821', from: 'alice', act: 'release', n: 1 });
});
