// hooks/handlers/session-restore.ts: after /clear, compact or resume the seat's context is the mechanics block alone:
// no row calls for the model ever (the room row is the hooks module's to start again: mod/deliver.ts roomRow).
import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN, newRoom, register, childEnv, spawnSleeper } from './helpers.ts';

const RUN = path.join(PLUGIN, 'hooks', 'run.ts');

function restore(pid: number | undefined, source: string, sid: string): string {
  const r = spawnSync(process.execPath, [RUN, 'session-restore'], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', source, session_id: sid, cwd: process.cwd() }),
    env: childEnv({ CLAUDE_PID: String(pid) }), encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return (JSON.parse(r.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
}

test('restore: /clear, compact and resume hand the model the mechanics block and no row call, for a member and the room session alike', () => {
  const code = newRoom();
  const roomClaude = spawnSleeper().pid;
  register('claude', 'claude', roomClaude, code);
  const alice = spawnSleeper().pid;
  register('alice', 'member', alice, code);
  register('bob', 'member', spawnSleeper().pid, code);
  const runs: [number | undefined, string, string][] = [
    [alice, 'clear', 'sess-alice-new'], [alice, 'compact', 'sess-alice-new'], [alice, 'resume', 'sess-alice-new2'],
    [roomClaude, 'compact', `sess-claude-${roomClaude}`], [roomClaude, 'clear', `sess-claude-${roomClaude}-2`],
  ];
  for (const [pid, source, sid] of runs) {
    const ctx = restore(pid, source, sid);
    assert.match(ctx, /^SUB-HUMAN/, `${source}: the mechanics block`);
    assert.match(ctx, new RegExp(`restored after ${source}`));
    assert.doesNotMatch(ctx, /Agent\(|ROWS|sub-human:(room|participant)/, `${source}: no row for the model to spawn`);
  }
});
