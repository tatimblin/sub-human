'use strict';
// hooks/session-restore.js: after /clear the rows survive, so a seat with live holds gets no row calls
// (a re-spawn duplicated the room row in the S11 demo run); without live holds, and on resume, it gets them.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PLUGIN, LIB, newRoom, register, childEnv, spawnSleeper } = require('./helpers.js');
const rows = require(path.join(LIB, 'rows.js'));

const HOOK = path.join(PLUGIN, 'hooks', 'session-restore.js');

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
  register('orch', 'orch', spawnSleeper().pid, code);
  const alice = spawnSleeper().pid;
  register('alice', 'member', alice, code);

  let ctx = restore(alice, 'clear', 'sess-alice-new');
  assert.match(ctx, /Your rows are not running/);
  assert.equal(calls(ctx).length, 1);
  assert.match(ctx, /Agent\(\{subagent_type: "sub-human:room"/);

  rows.writeHolds(code, 'alice', { members: [], room: true }); // pid = this live test process
  ctx = restore(alice, 'clear', 'sess-alice-new2');
  assert.deepEqual(calls(ctx), []);
  assert.match(ctx, /ROOM ROW: already running/);

  // --resume: a new claude process, so a new hold server; the old server pid is dead -> nothing is held.
  const fs = require('node:fs');
  fs.writeFileSync(rows.holdsFile(code, 'alice'), JSON.stringify({ pid: 999999, at: new Date().toISOString(), members: [], room: true }));
  ctx = restore(alice, 'resume', 'sess-alice-new2');
  assert.match(ctx, /Create them now/);
  assert.match(ctx, /Agent\(\{subagent_type: "sub-human:room"/);
});

test('restore: lists only the missing rows (orch after compact / clear)', () => {
  const code = newRoom();
  const orch = spawnSleeper().pid;
  register('orch', 'orch', orch, code);
  register('alice', 'member', spawnSleeper().pid, code);
  register('bob', 'member', spawnSleeper().pid, code);
  rows.writeHolds(code, 'orch', { members: ['alice'] });
  let ctx = restore(orch, 'compact', `sess-orch-${orch}`);
  assert.match(ctx, /only the rows below are missing/);
  assert.deepEqual(calls(ctx), ['Agent({subagent_type: "sub-human:participant", description: "bob", prompt: "member: bob", run_in_background: true})'],
    'bob only: alice is still held, re-listing her would duplicate her row');
  rows.writeHolds(code, 'orch', { members: ['alice', 'bob'] });
  ctx = restore(orch, 'clear', `sess-orch-${orch}-2`);
  assert.deepEqual(calls(ctx), []);
  assert.match(ctx, /already running/);
  assert.match(ctx, /When a member_joined NAME entry arrives/, 'future joins still get rows');
});
