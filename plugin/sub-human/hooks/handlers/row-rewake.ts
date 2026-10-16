// plugin/sub-human/hooks/handlers/row-rewake.ts: SessionStart(resume), registered with "asyncRewake": true. Rows are in-memory tasks, so
// --continue / --resume restores none of them, and session-restore.ts's additionalContext is read only on
// the next prompt. This hook runs in the background and, when this seat is missing rows, exits 2 with the
// exact Agent calls on stderr: Claude Code then wakes the model with that text and no user prompt (verified
// by probe). Nothing missing, or not in a room: silent exit 0. row-guard.ts still denies any
// duplicate spawn a later prompt might attempt.
//
// It runs concurrently with session-restore.ts, which may re-join the seat (resume after session-end), so
// it polls up to SUB_HUMAN_REWAKE_WAIT_MS (REWAKE_WAIT_MS, 3000; 0 = no wait) for the seat, preferring the
// moment it is bound to this claude process (CLAUDE_PID).
import * as identity from '../../lib/identity.ts';
import * as rows from '../../lib/rows.ts';
import { resolveSeat } from '../seat.ts';
import { sleepSync } from '../../lib/io.ts';
import * as config from '../../lib/config.ts';
import { envMs } from '../../lib/env.ts';
import type { HookIn, Reply } from '../types.ts';
import type { Identity } from '../../lib/identity.ts';

/** The model is told plainly that the rows are not running: after a resume the conversation still lists the old
 * process's background tasks as running, and a model that trusts that list restores nothing (seen live). The hold
 * check (rows.readHolds: a live, fresh hold of this process) is what says they are gone. */
const LEAD = 'sub-human: this session was resumed, and its rows are NOT running: they ended with the old process. '
  + 'The conversation may still list them as running; that list is from before the resume (the hooks checked: no row holds). '
  + 'Re-create them now, exactly as written:\n';
const TAIL = '\nWrite no text: make only these calls and end your turn.';
const WAIT_MS = envMs('SUB_HUMAN_REWAKE_WAIT_MS');

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

/** Exit 2 with the text on stderr wakes the model. */
export function handle(input: HookIn<'SessionStart'>): Reply | null {
  if (input.source && input.source !== 'resume') return null;
  const me = findSeat(input);
  const text = me ? rewakeText(me) : '';
  return text ? { kind: 'classic', exit: 2, stderr: text } : null;
}

/** Any error: logged, exit 0 (no wake). */
export const fail = () => null;
