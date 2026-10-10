#!/usr/bin/env node
// SessionStart(resume), registered with "asyncRewake": true. Rows are in-memory tasks, so
// --continue / --resume restores none of them, and session-restore.ts's additionalContext is read only on
// the next prompt. This hook runs in the background and, when this seat is missing rows, exits 2 with the
// exact Agent calls on stderr: Claude Code then wakes the model with that text and no user prompt (verified
// by probe). Nothing missing, or not in a room: silent exit 0. row-guard.ts still denies any
// duplicate spawn a later prompt might attempt.
//
// It runs concurrently with session-restore.ts, which may re-join the seat (resume after session-end), so
// it polls up to SUB_HUMAN_REWAKE_WAIT_MS (REWAKE_WAIT_MS, 3000; 0 = no wait) for the seat, preferring the
// moment it is bound to this claude process (CLAUDE_PID).
import { identity, rows, run, resolveSeat } from './common.ts';
import { sleepSync } from '../lib/io.ts';
import * as config from '../lib/config.ts';
import type { HookIn } from './types.ts';
import type { Identity } from '../lib/identity.ts';

const LEAD = 'sub-human: this session was resumed and its rows did not survive it. Re-create them now, exactly as written:\n';
const TAIL = '\nWrite no text: make only these calls and end your turn.';
const WAIT_MS = config.envMs('SUB_HUMAN_REWAKE_WAIT_MS', config.REWAKE_WAIT_MS, { allowZero: true });

function findSeat(input: HookIn<'SessionStart'>): Identity | null {
  const pid = identity.claudePid();
  const deadline = Date.now() + WAIT_MS;
  let me: Identity | null = null;
  for (;;) {
    me = resolveSeat(input, { ancestry: true });
    if (me && (!pid || !me.pid || Number(me.pid) === Number(pid))) return me;
    if (Date.now() >= deadline) return me;
    sleepSync(config.REWAKE_POLL_MS);
  }
}

/** The rewake text for this seat, or '' when every row it should have is held. */
function rewakeText(me: Identity): string {
  const members = identity.readMembers(me.code) || {};
  const held = rows.readHolds(me.code, me.name);
  const only = rows.rowsNeeded(me.code, me, { members, held });
  if (!only.length) return '';
  const calls = rows.rowCalls(me, members, { only });
  if (!/Agent\(/.test(calls)) return ''; // e.g. a room Claude with no members yet: nothing to spawn
  return LEAD + calls + TAIL;
}

// Exit 2 with the text on stderr wakes the model; on any error run() logs it and the hook exits 0.
run((input: HookIn<'SessionStart'>) => {
  if (input.source && input.source !== 'resume') return;
  const me = findSeat(input);
  const text = me ? rewakeText(me) : '';
  if (text) { process.stderr.write(text + '\n'); process.exitCode = 2; }
}, () => { process.exitCode = 0; });
