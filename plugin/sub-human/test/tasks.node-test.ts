// lib/tasks.ts: validate, the ownership rules (check), apply on the host (the log, the native files, tasks.json),
// the room task, summary; and the mcp/task.ts plug-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as h from './helpers.ts';
import * as identity from '../lib/identity.ts';
import * as room from '../lib/room.ts';
import * as tasks from '../lib/tasks.ts';
import * as taskFiles from '../lib/room/task-files.ts';
import * as ccTasks from '../lib/cc/tasks.ts';
import * as taskPlugin from '../mcp/task.ts';
import type { Entry } from '../lib/room/types.ts';
import type { FoldedTask } from '../lib/types-app.ts';
import type { Me, ToolResult } from '../mcp/types.ts';
import { sn } from './support/brands.ts';
import { must } from './support/must.ts';

type Validated = ReturnType<typeof tasks.validate>;
const vReq = (r: Validated) => (r.ok ? r.req : undefined);
const vErr = (r: Validated) => (r.ok ? undefined : r.error);
const applied = (r: tasks.Applied) => (r.ok ? r.task : undefined);
const refused = (r: tasks.Applied) => (r.ok ? undefined : r.error);

// ---------- validate ----------
test('validate: op shapes; done needs evidence; suggest goes with add only', () => {
  assert.equal(must(vReq(tasks.validate({ op: 'add', subject: '  parser   tests ' }))).subject, 'parser tests');
  assert.match(must(vErr(tasks.validate({ op: 'add' }))), /subject/);
  assert.match(must(vErr(tasks.validate({ op: 'claim' }))), /id/);
  assert.match(must(vErr(tasks.validate({ op: 'release', id: 'x' }))), /id/);
  assert.equal(must(vReq(tasks.validate({ op: 'claim', id: 3 }))).id, '3');
  assert.match(must(vErr(tasks.validate({ op: 'done', id: '3' }))), /evidence/);
  assert.match(must(vErr(tasks.validate({ op: 'done', id: '3', evidence: '   ' }))), /evidence/);
  assert.deepEqual(vReq(tasks.validate({ op: 'done', id: '3', evidence: 'npm test: 12 pass' })), { op: 'done', id: '3', evidence: 'npm test: 12 pass' });
  assert.match(must(vErr(tasks.validate({ op: 'delete', id: '3' }))), /op must be/);
  assert.match(must(vErr(tasks.validate({ op: 'add', subject: 'x', suggest: 'room' }))), /cannot own/);
  assert.match(must(vErr(tasks.validate({ op: 'add', subject: 'x', suggest: 'bad name' }))), /invalid name/);
  assert.match(must(vErr(tasks.validate({ op: 'claim', id: '2', suggest: 'bob' }))), /suggest goes with add only/);
  assert.match(must(vErr(tasks.validate({ op: 'add', subject: 'x'.repeat(201) }))), /200/);
  assert.equal(must(vReq(tasks.validate({ op: 'add', subject: 'x', suggest: 'bob' }))).suggest, 'bob');
  assert.equal(tasks.validate(null).ok, false);
});

// ---------- the rules (pure) ----------
const T = (over: Partial<FoldedTask> = {}): FoldedTask => ({ id: '2', subject: 'parser tests', status: 'pending', owner: null, blockedBy: [], ...over });
test('check: add (anyone); claim for yourself unless another owns it; release and done by the owner only; the room task takes nothing', () => {
  const ops = ['claim', 'release', 'done'] as const;
  const rows: [string, FoldedTask | null, string, string | null][] = [
    // [op, task, by, the refusal (null: allowed)]
    ['claim', T(), 'bob', null],
    ['claim', T({ owner: 'bob', status: 'in_progress' }), 'bob', null],
    ['claim', T({ owner: 'alice', status: 'in_progress' }), 'bob', '#2 is alice\'s; ask them to release it'],
    ['release', T({ owner: 'bob', status: 'in_progress' }), 'bob', null],
    ['release', T({ owner: 'alice', status: 'in_progress' }), 'bob', 'only alice may release #2; ask them'],
    ['release', T(), 'bob', '#2 has no owner to release it'],
    ['done', T({ owner: 'bob', status: 'in_progress' }), 'bob', null],
    ['done', T({ owner: 'alice', status: 'in_progress' }), 'bob', 'only alice may complete #2; ask them'],
    ['done', T(), 'bob', '#2 has no owner; claim it first, then ask for done with evidence'],
    ['done', T({ owner: 'bob', status: 'completed' }), 'bob', '#2 is done already'],
    ['claim', null, 'bob', 'no task #2 in this room'],
    ['claim', T({ status: 'deleted' }), 'bob', 'no task #2 in this room'],
  ];
  for (const [op, task, by, why] of rows) {
    const req = { op, id: '2', ...(op === 'done' ? { evidence: 'tests pass' } : {}) };
    assert.equal(tasks.check(task, req, by), why, `${op} ${JSON.stringify(task)} by ${by}`);
  }
  const roomTask = T({ id: '1', subject: 'room vole-1234 open', owner: 'room', status: 'in_progress' });
  for (const op of ops) assert.match(must(tasks.check(roomTask, { op, id: '1', evidence: 'x' }, 'room')), /the room's open task; it stays open until the room closes/, op);
  assert.equal(tasks.check(null, { op: 'add', subject: 'x' }, 'anyone'), null);
});

// ---------- apply, on the host ----------
function hosted() {
  h.freshHome();
  const code = h.newRoom();
  h.register('alice');
  const store = room.open(code).store;
  return { code, store, R: room.open(code), dir: taskFiles.dirOf(code) };
}
const fileOf = (dir: string, id: string) => must(ccTasks.readTask(dir, id), `task file ${id}`);

test('apply: add, claim, done: two log entries per request (the ask via agent, the task via system from room), the native file and tasks.json follow; a refusal writes nothing', () => {
  const { code, store, R, dir } = hosted();
  const room1 = tasks.openRoomTask(store);
  assert.deepEqual([room1.id, room1.owner, room1.status], ['1', 'room', 'in_progress']);
  assert.equal(fileOf(dir, '1').status, 'in_progress', 'the room task is a file before anything else');
  const n0 = R.readAll().length;

  const add = tasks.apply(store, { op: 'add', subject: 'parser tests', detail: 'the edge cases', suggest: 'bob' }, { by: 'alice' });
  assert.ok(add.ok);
  assert.match(add.text, /^added #2 "parser tests" \(suggested owner: bob; they claim it\)$/);
  const [ask, task] = R.readAll().slice(n0);
  assert.deepEqual([must(ask).kind, must(ask).via, must(ask).from, must(ask).by], ['task_req', 'agent', 'alice', 'alice']);
  assert.deepEqual([must(task).kind, must(task).via, must(task).from, must(task).task_id, must(task).owner, must(task).req, must(task).suggest], ['task', 'system', 'room', '2', undefined, must(ask).id, 'bob']);
  const f = fileOf(dir, '2');
  assert.deepEqual([f.subject, f.description, f.status, f.owner, f.metadata], ['parser tests', 'the edge cases', 'pending', undefined, { room: code, req: must(ask).id, suggest: 'bob' }]);
  assert.deepEqual(tasks.list(code).map(t => [t.id, t.owner, t.status]), [['2', null, 'pending']], 'tasks.json: no room task');

  const n1 = R.readAll().length;
  assert.equal(refused(tasks.apply(store, { op: 'done', id: '2', evidence: 'x' }, { by: 'alice' })), '#2 has no owner; claim it first, then ask for done with evidence');
  assert.equal(refused(tasks.apply(store, { op: 'claim', id: '1' }, { by: 'alice' })), '#1 is the room\'s open task; it stays open until the room closes');
  assert.equal(refused(tasks.apply(store, { op: 'done', id: '2' }, { by: 'alice' })), 'done needs evidence: what shows it is done (a test run, a commit, a file)');
  assert.equal(R.readAll().length, n1, 'a refusal is immediate and logs nothing');

  assert.deepEqual([must(applied(tasks.apply(store, { op: 'claim', id: '2' }, { by: 'bob' }))).owner, fileOf(dir, '2').owner, fileOf(dir, '2').status], ['bob', 'bob', 'in_progress']);
  assert.equal(refused(tasks.apply(store, { op: 'claim', id: '2' }, { by: 'alice' })), '#2 is bob\'s; ask them to release it');
  assert.equal(refused(tasks.apply(store, { op: 'done', id: '2', evidence: 'mine' }, { by: 'alice' })), 'only bob may complete #2; ask them');
  const done = tasks.apply(store, { op: 'done', id: '2', evidence: 'npm test: 12 pass' }, { by: 'bob' });
  assert.ok(done.ok);
  assert.equal(fileOf(dir, '2').status, 'completed');
  assert.equal(fileOf(dir, '1').status, 'in_progress', 'every other task done: the room task keeps the list from being reset');
  assert.equal(tasks.summary(code, 'alice'), 'tasks: all 1 done');
  assert.equal(ccTasks.markOf(dir), 2, 'the mark follows the highest id');
});

test('apply: ids come after the log\'s, the files\' and the mark; a lost or edited file comes back with repair', () => {
  const { store, dir } = hosted();
  tasks.openRoomTask(store);
  fs.writeFileSync(path.join(dir, '.highwatermark'), '7'); // Claude Code reset the list once: ids up to 7 were handed out
  const a = must(applied(tasks.apply(store, { op: 'add', subject: 'after the mark' }, { by: 'alice' })));
  assert.equal(a.id, '8');
  fs.rmSync(path.join(dir, '8.json'));
  fs.writeFileSync(path.join(dir, '1.json'), '{"id":"1","subject":"edited","description":"","status":"completed","blocks":[],"blockedBy":[]}');
  const r = tasks.repair(store);
  assert.deepEqual(r.wrote.sort(), ['1', '8']);
  assert.equal(fileOf(dir, '1').status, 'in_progress');
  assert.equal(fileOf(dir, '8').subject, 'after the mark');
  assert.deepEqual(tasks.repair(store), { wrote: [], removed: [] }, 'nothing to do: no write');
  fs.writeFileSync(path.join(dir, '99.json'), '{}');
  tasks.repair(store);
  assert.ok(fs.existsSync(path.join(dir, '99.json')), 'a file the log does not know is left alone');
});

test('the room task: opened once (a respawn finds it), completed only by closeRoomTask; members never complete it', () => {
  const { store, R, dir } = hosted();
  const a = tasks.openRoomTask(store);
  const n = R.readAll().length;
  assert.deepEqual(tasks.openRoomTask(store), a, 'a respawn: the same task, no new entry');
  assert.equal(R.readAll().length, n);
  for (const op of ['claim', 'release'] as const) assert.match(must(refused(tasks.apply(store, { op, id: a.id }, { by: 'alice' }))), /room's open task/);
  const closed = must(tasks.closeRoomTask(store));
  assert.equal(closed.status, 'completed');
  assert.equal(fileOf(dir, a.id).status, 'completed');
  assert.equal(must(R.readAll().at(-1)).from, 'room');
  assert.equal(tasks.closeRoomTask(store), null, 'nothing left open');
});

test('apply: two processes at once: the room\'s tasks lock serialises them; every request gets its own id and both land', async () => {
  const { code, R } = hosted();
  const script = `
    import * as room from ${JSON.stringify(path.join(h.LIB, 'room.ts'))};
    import * as tasks from ${JSON.stringify(path.join(h.LIB, 'tasks.ts'))};
    const store = room.open(process.argv[1]).store;
    const out = [];
    for (let i = 0; i < 5; i++) out.push(tasks.apply(store, { op: 'add', subject: process.argv[2] + ' ' + i }, { by: process.argv[2] }).task.id);
    process.stdout.write(JSON.stringify(out));`;
  const run = (who: string) => new Promise<string[]>((resolve, reject) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', script, code, who],
      { env: { ...h.childEnv(), SUB_HUMAN_HOME: must(process.env.SUB_HUMAN_HOME), CLAUDE_CONFIG_DIR: must(process.env.CLAUDE_CONFIG_DIR) } });
    let o = '', e = '';
    c.stdout.on('data', d => { o += String(d); });
    c.stderr.on('data', d => { e += String(d); });
    c.on('close', code_ => (code_ === 0 ? resolve(JSON.parse(o) as string[]) : reject(new Error(e))));
  });
  const [a, b] = await Promise.all([run('alice'), run('bob')]); // each within the room's rate for one Claude
  const ids = [...a, ...b];
  assert.equal(new Set(ids).size, 10, `10 distinct ids: ${ids.join(',')}`);
  const entries = R.readAll().filter((e: Entry) => e.kind === 'task');
  assert.equal(entries.length, 11, 'and the room task, once');
  assert.deepEqual(tasks.list(code).length, 10);
});

// ---------- the mirror file and summary ----------
test('list and summary per viewer (tasks.json)', () => {
  const code = h.newRoom();
  assert.deepEqual(tasks.list(code), []);
  assert.equal(tasks.summary(code, 'alice'), '');
  const ent = (task_id: string, extra: Partial<Entry>): Entry => ({ id: Number(task_id), via: 'system', kind: 'task', task_id, subject: 's' + task_id, status: 'pending', ...extra }) as Entry; // a task snapshot: fold reads no from or at
  tasks.refold(code, [
    ent('1', { subject: `room ${code} open`, status: 'in_progress', owner: 'room' }), ent('4', { status: 'in_progress', owner: 'bob' }),
    ent('2', { owner: 'alice' }), ent('3', {}), ent('5', { status: 'completed', owner: 'alice' }),
  ]);
  assert.deepEqual(tasks.list(code).map(t => t.id), ['2', '3', '4', '5']);
  assert.equal(tasks.summary(code, 'alice'), 'tasks 3 open · #2 you · #4 bob');
  assert.equal(tasks.summary(code, 'bob'), 'tasks 3 open · #2 alice · #4 you');
  assert.deepEqual(tasks.mine(code, sn('alice')).map(t => t.id), ['2']);
  // fold: the last snapshot per task; a delete removes it; an agent's line is no task
  assert.deepEqual(tasks.fold([
    ent('3', { owner: 'bob' }), ent('2', { status: 'in_progress', owner: 'alice', blockedBy: ['3'] }), ent('3', {}),
    ent('4', {}), ent('4', { op: 'delete', status: 'deleted' }), { ...ent('5', {}), via: 'agent' }, ent('1', { subject: `room ${code} open` }),
  ]), [
    { id: '2', subject: 's2', status: 'in_progress', owner: 'alice', blockedBy: ['3'] },
    { id: '3', subject: 's3', status: 'pending', owner: null, blockedBy: [] },
  ]);
});

// ---------- mcp/task.ts ----------
/** task.ts's call: it reads only the seat's code, name and role. */
type Seat = Pick<Me, 'code' | 'name' | 'role'>;
const out = (r: ToolResult) => must(r.content[0]).text;

test('task tool: applied at once on the host (no room Claude needed); a refusal is an error result', () => {
  const { code, R } = hosted();
  identity.join({ code, name: sn('bob'), role: 'member', pid: must(h.spawnSleeper().pid), session_id: 's-b' });
  const me: Seat = { code, name: sn('alice'), role: 'member' };
  const api = taskPlugin.create();
  assert.deepEqual(api.tools.map(t => t.name), ['task']);
  const { name, description, inputSchema } = must(api.tools[0]); // model-facing fields
  assert.ok(JSON.stringify({ name, description, inputSchema }).length <= 1000);
  let r = api.call('task', me, { op: 'done', id: '2' });
  assert.equal(r.isError, true);
  assert.match(out(r), /^refused: done needs evidence/);
  r = api.call('task', me, { op: 'add', subject: 'parser tests', suggest: 'bob' });
  assert.equal(r.isError, undefined);
  assert.match(out(r), /^added #\d+ "parser tests"/);
  assert.deepEqual(R.readAll().slice(-2).map(e => [e.kind, e.from]), [['task_req', 'alice'], ['task', 'room']]);
  assert.match(out(api.call('task', { code, name: sn('claude'), role: 'claude' }, { op: 'add', subject: 'x' })), /takes no task requests/);
});
