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
