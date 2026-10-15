// hooks/session-restore.ts: after /clear the rows survive, so a seat with live holds gets no row calls
// (a re-spawn duplicated the room row in the S11 demo run); without live holds, and on resume, it gets them.
import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { PLUGIN, LIB, newRoom, register, childEnv, spawnSleeper } from './helpers.ts';
import * as rows from '../lib/rows.ts';
import * as roomLib from '../lib/room.ts';

const HOOK = path.join(PLUGIN, 'hooks', 'session-restore.ts');

function restore(pid, source, sid) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', source, session_id: sid, cwd: process.cwd() }),
    env: childEnv({ CLAUDE_PID: String(pid) }), encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

const calls = ctx => (ctx.match(/Agent\(\{subagent_type: "sub-human:(?:participant|room)", description: "(?!NAME")[^\n]*/g) || []);

test('restore: /clear with a live room hold lists no row calls; without one it does', () => {
  const code = newRoom();
  register('claude', 'claude', spawnSleeper().pid, code);
  const alice = spawnSleeper().pid;
  register('alice', 'member', alice, code);

  let ctx = restore(alice, 'clear', 'sess-alice-new');
  assert.equal(calls(ctx).length, 1);
  assert.match(ctx, /Agent\(\{subagent_type: "sub-human:room"/);

  rows.writeHolds(code, 'alice', { members: [], room: true }); // pid = this live test process
  ctx = restore(alice, 'clear', 'sess-alice-new2');
  assert.deepEqual(calls(ctx), []);
  assert.match(ctx, /already running|rows are running/);

  // --resume: a new claude process, so a new hold server; the old server pid is dead -> nothing is held.
  roomLib.open(code).store.kv.set('rows/holds-alice', { pid: 999999, at: new Date().toISOString(), members: [], room: true });
  ctx = restore(alice, 'resume', 'sess-alice-new2');
  assert.match(ctx, /Agent\(\{subagent_type: "sub-human:room"/);
});

test('restore: lists only the missing rows (claude after compact / clear)', () => {
  const code = newRoom();
  const roomClaude = spawnSleeper().pid;
  register('claude', 'claude', roomClaude, code);
  register('alice', 'member', spawnSleeper().pid, code);
  register('bob', 'member', spawnSleeper().pid, code);
  rows.writeHolds(code, 'claude', { members: ['alice'] });
  let ctx = restore(roomClaude, 'compact', `sess-claude-${roomClaude}`);
  assert.deepEqual(calls(ctx), ['Agent({subagent_type: "sub-human:participant", description: "bob", prompt: "member: bob", run_in_background: true})'],
    'bob only: alice is still held, re-listing her would duplicate her row');
  rows.writeHolds(code, 'claude', { members: ['alice', 'bob'] });
  ctx = restore(roomClaude, 'clear', `sess-claude-${roomClaude}-2`);
  assert.deepEqual(calls(ctx), []);
  assert.match(ctx, /already running|rows are running/);
  assert.match(ctx, /member_joined/, 'future joins still get rows');
});
