#!/usr/bin/env node
// Notification(idle_prompt|permission_prompt) and StopFailure: write this member's presence to
// presence/<name> = {state, at, detail?} (identity.writePresence, a room document). Row text (lib/rows.ts)
// reads it; nothing goes to the room log, so presence never wakes anyone.
//   idle_prompt        -> idle         the human is idle at their prompt
//   permission_prompt  -> permission   their Claude is waiting on them
//   StopFailure        -> error        their Claude stalled; detail = the error code (rate_limit, …)
//   Working            -> working      not a hook event: mod/prompt.ts runs this with {hook_event_name:
//                                     "Working"} on the person's typed prompt, since the shim does not start
//                                     node for every prompt
// join.ts and session-restore.ts write "working" too, and at-room.ts when no origin came.
// Output: none (StopFailure ignores it).
import { run, whoami, presence } from './common.ts';
import type { HookIn } from './types.ts';

/** The events this script runs for (and "Working" from mod/prompt.ts); error as sent, a code or an object. */
type PresenceIn = Omit<HookIn<'Notification'> & HookIn<'StopFailure'>, 'hook_event_name' | 'error'> & { hook_event_name?: string; error?: unknown };

const BY_TYPE: Record<string, string | undefined> = { idle_prompt: 'idle', permission_prompt: 'permission' };

run((input: PresenceIn) => {
  const me = whoami(input);
  if (!me) return;
  if (input.hook_event_name === 'Working') return presence(me, 'working');
  if (input.hook_event_name === 'StopFailure') {
    const e = input.error;
    const err = e && typeof e === 'object' ? (e as { type?: unknown }).type || (e as { code?: unknown }).code : e;
    return presence(me, 'error', err ? String(err) : 'stop failure');
  }
  const state = BY_TYPE[String(input.notification_type)];
  if (state) presence(me, state);
});
