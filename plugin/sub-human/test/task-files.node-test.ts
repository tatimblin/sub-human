// lib/room/task-files.ts: the room's native task files, as Claude Code's schema has them (contract task-file-schema),
// written only when they change, atomically, under its locks; the directory recorded at spawn, checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as h from './helpers.ts';
import * as identity from '../lib/identity.ts';
import * as taskFiles from '../lib/room/task-files.ts';
import * as ccTasks from '../lib/cc/tasks.ts';
import * as ccEnv from '../lib/cc/env.ts';
import * as room from '../lib/room.ts';
import * as tasks from '../lib/tasks.ts';
import * as roomClaude from '../lib/room-claude.ts';
import { sn } from './support/brands.ts';
import type { FoldedTask } from '../lib/types-app.ts';
import { must } from './support/must.ts';

const T = (id: string, over: Partial<FoldedTask> = {}): FoldedTask => ({ id, subject: `task ${id}`, status: 'pending', owner: null, blockedBy: [], ...over });

test('task files: the schema\'s fields and nothing else; blocks is the reverse of blockedBy; owner only when set; metadata names the room', () => {
  h.freshHome();
  const code = h.newRoom();
  const dir = path.join(h.tmpDir('sh-tf-'), 'tasks', `sh-${code}`);
  const tasks = [T('1', { subject: `room ${code} open`, owner: 'room', status: 'in_progress' }), T('2', { detail: 'the edge cases', req: 4, suggest: 'bob' }), T('3', { blockedBy: ['2'], owner: 'bob', status: 'in_progress' })];
  assert.deepEqual(taskFiles.project(code, tasks, { dir }).wrote, ['1', '2', '3']);
  const two = JSON.parse(fs.readFileSync(path.join(dir, '2.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(two), ['id', 'subject', 'description', 'status', 'blocks', 'blockedBy', 'metadata']);
  assert.deepEqual(two, { id: '2', subject: 'task 2', description: 'the edge cases', status: 'pending', blocks: ['3'], blockedBy: [], metadata: { room: code, req: 4, suggest: 'bob' } });
  assert.equal(must(ccTasks.readTask(dir, '3')).owner, 'bob');
  assert.deepEqual(fs.readdirSync(dir).filter(f => !/^\d+\.json$|^\.lock$|^\.highwatermark$/.test(f)), [], 'no temp file left, no lock dir');
  assert.equal(ccTasks.markOf(dir), 3);
  // unchanged: no write; a deleted task's file goes
  assert.deepEqual(taskFiles.project(code, tasks, { dir }), { wrote: [], removed: [] });
  assert.deepEqual(taskFiles.project(code, [...tasks.slice(0, 2), T('3', { status: 'deleted' })], { dir }).removed, ['3']);
  assert.equal(fs.existsSync(path.join(dir, '3.json')), false);
  assert.equal(taskFiles.nextId(code, tasks.slice(0, 2), { dir }), '4', 'the mark keeps 3 from coming back');
});

test('task files: the directory is the recorded one only when it is <config>/tasks/sh-CODE; else this process\'s config dir', () => {
  h.freshHome();
  const code = h.newRoom();
  const own = ccEnv.tasksDir(`sh-${code}`);
  identity.updateRoomClaude(code, () => ({ tasks_dir: '/etc' }));
  assert.equal(taskFiles.dirOf(code), own, 'anywhere else is ignored');
  const rec = path.join(h.tmpDir('sh-tf-'), 'tasks', `sh-${code}`);
  identity.updateRoomClaude(code, () => ({ tasks_dir: rec }));
  assert.equal(taskFiles.dirOf(code), rec);
  assert.ok(own.startsWith(must(process.env.CLAUDE_CONFIG_DIR)), 'tests never reach ~/.claude');
});

// ---------- the preflight (lib/cc/tasks.ts check, task-files preflight) ----------

/** A global config whose cached feature switches are feats, in a config dir of its own. */
function configWith(feats: Record<string, unknown>): NodeJS.ProcessEnv {
  const cfg = h.tmpDir('sh-cfg-');
  fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ cachedGrowthBookFeatures: feats }));
  return { CLAUDE_CONFIG_DIR: cfg, HOME: cfg };
}
const reasonOf = (r: ccTasks.TaskStoreCheck): string => (r.ok ? '' : r.reason);

test('check: the key-value task store\'s gate (env switch first, else the cached tengu_hover_rest) turns the files off', () => {
  const dir = path.join(h.tmpDir('sh-tf-'), 'tasks', 'sh-x');
  assert.deepEqual(ccTasks.check(dir, { env: configWith({}) }), { ok: true }, 'no entry: off (the default)');
  assert.deepEqual(ccTasks.check(dir, { env: configWith({ tengu_hover_rest: false }) }), { ok: true });
  assert.match(reasonOf(ccTasks.check(dir, { env: configWith({ tengu_hover_rest: true }) })), /key-value task store is on/);
  assert.equal(ccTasks.check(dir, { env: { ...configWith({}), CLAUDE_CODE_HOVER_REST: '1' } }).ok, false, 'the env switch');
  assert.equal(ccTasks.check(dir, { env: { ...configWith({ tengu_hover_rest: true }), CLAUDE_CODE_HOVER_REST: '0' } }).ok, true, 'the env switch wins');
  assert.equal(ccTasks.tasksOffByVerdict(), null, 'the verdict seam says nothing yet');
});

test('check: a task file that no longer reads as a task, an unknown lock layout, a directory it cannot write', () => {
  const env = configWith({});
  const dir = path.join(h.tmpDir('sh-tf-'), 'tasks', 'sh-x');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '1.json'), ccTasks.taskJson({ id: '1', subject: 's', description: '', status: 'pending', blocks: [], blockedBy: [] }));
  fs.writeFileSync(path.join(dir, '.lock'), '');
  fs.mkdirSync(path.join(dir, '.lock.lock'));
  fs.mkdirSync(path.join(dir, '1.json.lock'));
  assert.deepEqual(ccTasks.check(dir, { env }), { ok: true }, 'the known layout: list lock file and dir, a task lock dir');
  fs.rmdirSync(path.join(dir, '1.json.lock'));
  fs.writeFileSync(path.join(dir, '2.json'), JSON.stringify({ key: 'v5', value: 'x' }));
  assert.match(reasonOf(ccTasks.check(dir, { env })), /task file 2\.json no longer reads as a task/);
  fs.rmSync(path.join(dir, '2.json'));
  fs.mkdirSync(path.join(dir, 'tasks.lock'));
  assert.match(reasonOf(ccTasks.check(dir, { env })), /unknown task lock layout \(tasks\.lock\)/);
  fs.rmdirSync(path.join(dir, 'tasks.lock'));
  assert.equal(ccTasks.check(path.join(dir, 'not-yet', 'deeper'), { env }).ok, true, 'a directory not made yet, under one it can write');
  const file = path.join(dir, 'plain');
  fs.writeFileSync(file, '');
  assert.match(reasonOf(ccTasks.check(path.join(file, 'sub'), { env })), /is not a directory/);
  if (process.getuid?.() !== 0) {
    fs.chmodSync(dir, 0o500);
    try { assert.match(reasonOf(ccTasks.check(dir, { env })), /is not writable/); } finally { fs.chmodSync(dir, 0o700); }
  }
});

test('preflight: a failed check records members.claude.tasks_off and projection stops; once it passes, cleared and repair writes the list again', () => {
  h.freshHome();
  const code = h.newRoom();
  const dir = path.join(h.tmpDir('sh-tf-'), 'tasks', `sh-${code}`);
  identity.updateRoomClaude(code, () => ({ job: 'cafe0001', tasks_dir: dir }));
  const store = room.open(code).store;
  assert.ok(tasks.apply(store, { op: 'add', subject: 'one' }, { by: 'alice' }).ok);
  assert.deepEqual(ccTasks.fileIds(dir), [1, 2], 'the room task and #2');
  // a Claude Code that keeps its tasks elsewhere now
  process.env.CLAUDE_CODE_HOVER_REST = '1';
  try {
    assert.match(must(tasks.repair(store).skipped), /key-value task store is on/);
    const off = must(must(identity.readMembers(code).claude).tasks_off);
    assert.match(off, /key-value task store is on/);
    assert.ok(tasks.apply(store, { op: 'add', subject: 'two' }, { by: 'alice' }).ok, 'a request still lands: the log keeps it');
    assert.deepEqual(ccTasks.fileIds(dir), [1, 2], 'nothing projected');
    assert.deepEqual(tasks.list(code).map(t => t.subject), ['one', 'two'], 'tasks.json (rows, status line, CLI) stays right');
    assert.deepEqual(taskFiles.project(code, []), { wrote: [], removed: [], skipped: off });
    // the room session binds again: the reason stays (it is the room session's record)
    const o = h.spawnSleeper();
    identity.join({ code, name: sn('claude'), role: 'claude', pid: must(o.pid), session_id: 'so' });
    assert.equal(must(identity.readMembers(code).claude).tasks_off, off, 'kept across the bind');
    o.kill();
  } finally { delete process.env.CLAUDE_CODE_HOVER_REST; }
  assert.equal(tasks.repair(store).skipped, undefined);
  assert.equal(must(identity.readMembers(code).claude).tasks_off, undefined, 'cleared');
  assert.deepEqual(ccTasks.fileIds(dir), [1, 2, 3], 'the projection resumes with what the log kept');
  assert.equal(must(ccTasks.readTask(dir, 3)).subject, 'two');
});

test('openTaskList runs the preflight at the room session\'s start', () => {
  h.freshHome();
  const code = h.newRoom();
  const env = configWith({ tengu_hover_rest: true });
  roomClaude.openTaskList(code, env);
  const o = must(identity.readMembers(code).claude);
  assert.equal(o.tasks_dir, path.join(must(env.CLAUDE_CONFIG_DIR), 'tasks', `sh-${code}`));
  assert.match(must(o.tasks_off), /key-value task store is on/);
  fs.writeFileSync(path.join(must(env.CLAUDE_CONFIG_DIR), '.claude.json'), JSON.stringify({ cachedGrowthBookFeatures: {} }));
  roomClaude.openTaskList(code, env);
  assert.equal(must(identity.readMembers(code).claude).tasks_off, undefined, 'a later start that passes clears it');
});
