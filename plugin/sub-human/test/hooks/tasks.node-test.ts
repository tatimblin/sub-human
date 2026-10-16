// hooks/handlers/tasks.ts: the PostToolUse TaskCreate|TaskUpdate mirror and the TaskCompleted gate (room Claude only).
// Payload shapes are the ones S1 logged from a --bg room Claude (docs/archive/next/S1-headless-claude.md §4).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { World, PLUGIN, baseEnv } from './helpers.ts';
import type { HookInput } from './helpers.ts';
import * as tasks from '../../lib/tasks.ts';
import { must } from '../support/must.ts';

const create = (id: number, subject: string, extra = {}) => ({
  hook_event_name: 'PostToolUse', agent_type: 'sub-human:room-claude', tool_name: 'TaskCreate',
  tool_input: { subject, description: subject, ...extra }, tool_response: { task: { id: String(id), subject } },
});
const update = (id: number, input: Record<string, unknown>, resp = {}): HookInput => ({
  hook_event_name: 'PostToolUse', agent_type: 'sub-human:room-claude', tool_name: 'TaskUpdate',
  tool_input: { taskId: String(id), ...input }, tool_response: { success: true, taskId: String(id), updatedFields: Object.keys(input), ...resp },
});
const completed = (id: number, subject: string) => ({ hook_event_name: 'TaskCompleted', agent_type: 'sub-human:room-claude', task_id: String(id), task_subject: subject, task_description: subject });

/** A native task file as Claude Code writes it (only id is needed to place it). */
type NativeTask = { id: string } & Record<string, unknown>;

function world() {
  const w = new World({ claude: 'sleep', alice: 'sleep', bob: 'sleep' });
  const native = path.join(w.userHome, '.claude', 'tasks', `sh-${w.code}`);
  fs.mkdirSync(native, { recursive: true });
  return Object.assign(w, {
    native,
    writeNative: (t: NativeTask) => fs.writeFileSync(path.join(native, `${t.id}.json`), JSON.stringify(t)),
    run: (input: HookInput, as = 'claude') => w.hook('tasks', input, { as, env: { CLAUDE_CODE_TASK_LIST_ID: `sh-${w.code}` } }),
    list: () => w.lib(() => tasks.list(w.code)),
    taskEntries: () => w.entries().filter(e => e.kind === 'task'),
  });
}

test('gate: stdin it cannot read for a TaskCompleted fails closed (exit 2); for a mirror event it is exit 1', () => {
  const w = world();
  const run = (raw: string) => spawnSync(process.execPath, [path.join(PLUGIN, 'hooks', 'run.ts'), 'tasks'], {
    input: raw, encoding: 'utf8', cwd: w.cwd, env: baseEnv({ SUB_HUMAN_HOME: w.home, HOME: w.userHome, CLAUDE_PLUGIN_ROOT: PLUGIN, CLAUDE_PID: String(w.pid.claude) }),
  });
  const gate = run('{"hook_event_name":"TaskCompleted","agent_type":"sub-human:room-claude","task_id":"2" oops');
  assert.equal(gate.status, 2, gate.stderr);
  assert.match(gate.stderr, /failed closed/);
  const mirror = run('{"hook_event_name":"PostToolUse","tool_name":"TaskUpdate" oops');
  assert.equal(mirror.status, 1, mirror.stderr);
  assert.equal(run('').status, 0, 'empty stdin: nothing to do');
});

test('mirror: creates and updates land in tasks.json with a task entry; the room task is left out', () => {
  const w = world();
  let r = w.run(create(1, `room ${w.code} open`));
  assert.equal(r.code, 0, r.stderr);
  r = w.run(update(1, { status: 'in_progress', owner: 'room' }, { statusChange: { from: 'pending', to: 'in_progress' } }));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(w.list(), []);
  assert.equal(w.taskEntries().length, 0);

  r = w.run(create(2, 'parser tests', { description: 'cover edges', metadata: { req: 7, by: 'bob' } }));
  assert.equal(r.code, 0, r.stderr);
  w.run(update(2, { owner: 'bob' }));
  w.run(update(2, { status: 'in_progress' }, { statusChange: { from: 'pending', to: 'in_progress' } }));
  w.run(update(2, { addBlockedBy: ['3'] }));
  assert.deepEqual(w.list(), [{ id: '2', subject: 'parser tests', status: 'in_progress', owner: 'bob', blockedBy: ['3'] }]);
  const ents = w.taskEntries();
  assert.deepEqual(ents.map(e => [e.via, e.from, e.op]), [['system', 'claude', 'add'], ['system', 'claude', 'claim'], ['system', 'claude', 'update'], ['system', 'claude', 'update']]);
  assert.equal(must(ents[0]).req, 7);
  assert.equal(must(ents[1]).owner, 'bob');

  // description-only change: mirror unchanged, no entry
  w.run(update(2, { description: 'cover edges, green', metadata: { req: 9 } }));
  assert.equal(w.taskEntries().length, 4);
  w.run(update(2, { status: 'completed' }, { statusChange: { from: 'in_progress', to: 'completed' } }));
  const last = must(w.taskEntries().at(-1));
  assert.deepEqual([last.op, last.status, last.req], ['done', 'completed', undefined]);
  assert.equal(must(w.list()[0]).status, 'completed');
  // delete removes it
  w.run(update(2, { status: 'deleted' }));
  assert.deepEqual(w.list(), []);
  assert.equal(must(w.taskEntries().at(-1)).op, 'delete');
});

test('mirror: skips a refused update (success:false), _internal tasks and non-claude sessions', () => {
  const w = world();
  w.run(create(2, 'docs'));
  const refused = update(2, { status: 'completed' });
  refused.tool_response = { success: false, taskId: '2', updatedFields: [], error: 'TaskCompleted hook feedback: only bob may complete #2; ask them' };
  let r = w.run(refused);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(must(w.list()[0]).status, 'pending');
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
  assert.equal(must(w.taskEntries().at(-1)).req, 3);
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
  assert.match(r.stderr, /Nothing in that TaskUpdate was saved.*status only in a TaskUpdate of its own/s);

  w.append({ kind: 'task_req', text: 'task done #2', op: 'done', id: '2', evidence: 'looks done', owner: 'alice' }, { via: 'agent', from: 'alice' });
  assert.equal(w.run(completed(2, 'parser tests')).code, 2);
  w.append({ kind: 'task_req', text: 'task done #2', op: 'done', id: '2', evidence: 'npm test green', owner: 'bob' }, { via: 'agent', from: 'bob' });
  r = w.run(completed(2, 'parser tests'));
  assert.equal(r.code, 0, r.stderr);

  // a member's private TaskCompleted is never gated
  assert.equal(w.run(completed(1, 'my own thing'), 'alice').code, 0);

  // closing: task 1 may complete
  const f = path.join(w.home, 'rooms', w.code, 'members.json');
  const m = JSON.parse(fs.readFileSync(f, 'utf8')) as object; // members.json, spread back as it was
  fs.writeFileSync(f, JSON.stringify({ ...m, closing: true }));
  r = w.run(completed(1, `room ${w.code} open`));
  assert.equal(r.code, 0, r.stderr);
});

test('claude detection before binding: SUB_HUMAN_ROOM + agent_type', () => {
  const w = world();
  const r = w.hook('tasks', create(2, 'early'), { env: { SUB_HUMAN_ROOM: w.code, CLAUDE_CODE_TASK_LIST_ID: `sh-${w.code}` } });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(w.list().map(t => t.id), ['2']);
  const r2 = w.hook('tasks', { ...create(3, 'not claude'), agent_type: 'general-purpose' }, { env: { SUB_HUMAN_ROOM: w.code } });
  assert.equal(r2.code, 0, r2.stderr);
  assert.deepEqual(w.list().map(t => t.id), ['2']);
});

test('mirror: the req link comes from metadata (no description tag), then the task file, then the legacy tag', () => {
  const w = world();
  w.run(create(2, 'parser tests', { description: 'cover edges', metadata: { req: 7, by: 'bob' } }));
  assert.equal(must(w.taskEntries().at(-1)).req, 7);
  // a status-only call: the task file's metadata (merged by an earlier call) supplies the req
  w.writeNative({ id: '2', subject: 'parser tests', description: 'cover edges', status: 'in_progress', owner: 'bob', metadata: { req: 12, by: 'bob' } });
  w.run(update(2, { owner: 'bob', status: 'in_progress' }));
  assert.equal(must(w.taskEntries().at(-1)).req, 12);
  w.run(update(2, { status: 'completed', metadata: { req: '15' } }, { statusChange: { from: 'in_progress', to: 'completed' } }));
  assert.deepEqual([must(w.taskEntries().at(-1)).op, must(w.taskEntries().at(-1)).req], ['done', 15]);
  // a task written before metadata: the description tag still links it
  w.run(create(3, 'old', { description: 'x (req #4 by alice)' }));
  assert.equal(must(w.taskEntries().at(-1)).req, 4);
});

test('mirror: tasks.json is a pure fold of the task entries; deleting it and refolding gives the same file', () => {
  const w = world();
  w.run(create(1, `room ${w.code} open`));
  w.run(create(2, 'parser tests', { metadata: { req: 7 } }));
  w.run(create(3, 'docs', { metadata: { req: 8 } }));
  w.run(update(2, { owner: 'bob', status: 'in_progress' }, { statusChange: { from: 'pending', to: 'in_progress' } }));
  w.run(update(3, { addBlockedBy: ['2'] }));
  w.run(update(2, { owner: null, status: 'pending' }));
  w.run(update(3, { status: 'deleted' }));
  const file = path.join(w.home, 'rooms', w.code, 'tasks.json');
  const before = fs.readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(before), [{ id: '2', subject: 'parser tests', status: 'pending', owner: null, blockedBy: [] }]);
  assert.deepEqual(w.lib(() => tasks.fold(w.entries())), JSON.parse(before));
  fs.unlinkSync(file);
  w.lib(() => tasks.refold(w.code, w.entries()));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(w.home, 'rooms', w.code, 'tasks.room.json')), false);
});

test('gate: reads owner and metadata from the native task file', () => {
  const w = world();
  // _internal metadata: treated as the room's own task, refused until closing
  w.writeNative({ id: '5', subject: 'internal', status: 'in_progress', owner: 'bob', metadata: { _internal: true } });
  w.append({ kind: 'task_req', text: 'task done #5', op: 'done', id: '5', evidence: 'x', owner: 'bob' }, { via: 'agent', from: 'bob' });
  let r = w.run(completed(5, 'internal'));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /stays open until the room closes/);
  // the owner is the file's, not the mirror's
  w.writeNative({ id: '6', subject: 'parser tests', status: 'in_progress', owner: 'alice', metadata: { req: 99 } });
  w.append({ kind: 'task_req', text: 'task done #6', op: 'done', id: '6', evidence: 'green', owner: 'bob' }, { via: 'agent', from: 'bob' });
  r = w.run(completed(6, 'parser tests'));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /only alice may complete #6/);
  const d = w.append({ kind: 'task_req', text: 'task done #6', op: 'done', id: '6', evidence: 'green', owner: 'alice' }, { via: 'agent', from: 'alice' });
  w.writeNative({ id: '6', subject: 'parser tests', status: 'in_progress', owner: 'alice', metadata: { req: d.id } });
  assert.equal(w.run(completed(6, 'parser tests')).code, 0);
});

test('stage 8e I.8 (live verify, localb/09): a task its requester asked for themselves is theirs in its add entry; the owner TaskUpdate after it logs nothing more; one asked for another stays unowned until claimed', () => {
  const w = world();
  const mine = w.append({ kind: 'task_req', op: 'add', subject: 'write the parser tests', owner: 'bob', by: 'bob', text: 'task add for bob: write the parser tests' }, { via: 'agent', from: 'bob' });
  w.run(create(2, 'write the parser tests', { metadata: { req: mine.id, by: 'bob' } }));
  const add = must(w.taskEntries().at(-1));
  assert.deepEqual([add.op, add.owner], ['add', 'bob']);
  w.run(update(2, { owner: 'bob' }));
  assert.equal(w.taskEntries().length, 1, 'the claim changes nothing the room did not see');
  const other = w.append({ kind: 'task_req', op: 'add', subject: 'docs', owner: 'alice', by: 'bob', text: 'task add for alice: docs' }, { via: 'agent', from: 'bob' });
  w.run(create(3, 'docs', { metadata: { req: other.id, by: 'bob' } }));
  assert.equal(must(w.taskEntries().at(-1)).owner ?? null, null);
});
