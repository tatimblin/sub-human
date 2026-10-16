// plugin/sub-human/hooks/handlers/presence.ts: Notification(idle_prompt|permission_prompt), StopFailure and a typed
// prompt ("Working"), each through the hooks module: write this
// member's presence to presence/<name> = {state, at, detail?} (identity.writePresence, a room document). Row text
// (lib/rows.ts) reads it; nothing goes to the room log, so presence never wakes anyone.
//   idle_prompt        -> idle         the human is idle at their prompt
//   permission_prompt  -> permission   their Claude is waiting on them
//   StopFailure        -> error        their Claude stalled; detail = the error code (rate_limit, …)
//   Working            -> working      not a hook event: mod/prompt.ts runs this with {hook_event_name:
//                                     "Working"} on the person's typed prompt, since the shim does not start
//                                     node for every prompt
//   TurnEnd            -> idle         not a hook event: mod/deliver.ts runs this at turn.complete after a
//                                     "working" turn (idle_prompt may never come)
// The one writer of presence: only the hooks module runs it (mod/prompt.ts: a typed prompt, a notification, a failed
// turn), and no other hook writes it. A seat just taken or put back has none until its person types. Output: none.
import * as identity from '../../lib/identity.ts';
import { whoami } from '../seat.ts';
import type { HookIn } from '../types.ts';
import type { Identity } from '../../lib/identity.ts';

/** The events this script runs for (and "Working" from mod/prompt.ts); error as sent, a code or an object. */
type PresenceIn = Omit<HookIn<'Notification'> & HookIn<'StopFailure'>, 'hook_event_name' | 'error'> & { hook_event_name?: string; error?: unknown };

const BY_TYPE: Record<string, string | undefined> = { idle_prompt: 'idle', permission_prompt: 'permission' };

/** Best-effort presence write for the resolved member. */
function write(me: Identity | null, state: string, detail?: string) {
  try { if (me) identity.writePresence(me.code, me.name, { state, detail }); } catch { /* best-effort */ }
}

export function handle(input: PresenceIn): void {
  const me = whoami(input);
  if (!me) return;
  if (input.hook_event_name === 'Working') return write(me, 'working');
  if (input.hook_event_name === 'TurnEnd') return write(me, 'idle');
  if (input.hook_event_name === 'StopFailure') {
    const e = input.error;
    const err = e && typeof e === 'object' ? (e as { type?: unknown }).type || (e as { code?: unknown }).code : e;
    return write(me, 'error', err ? String(err) : 'stop failure');
  }
  const state = BY_TYPE[String(input.notification_type)];
  if (state) write(me, state);
}
