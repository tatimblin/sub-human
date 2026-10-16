// plugin/sub-human/hooks/handlers/session-end.ts: SessionEnd: mark the member left and log member_left (via system): lib/seats.ts exit. Reasons "clear" and
// "resume" (/clear, and /resume from inside a running session) keep the claude process, so the seat stays and
// session-restore.ts rebinds the new session id. `claude --resume` later rejoins the seat (session-restore).
// When no live member is left, exit starts `node lib/room-claude.ts reap CODE` detached (on the host): after a grace
// period (a quick rejoin cancels it) it marks the room closing, tells the room's Claude to complete task 1, waits up to
// 20 s and runs `claude stop <job>`. The room Claude's own SessionEnd (it is stopped, or exits) only marks its seat left.
// Budget: SessionEnd gets a few seconds (hooks.json timeout; 1.5 s by default), so nothing here waits on a
// child: the seat is marked left and the reaper started (detached) before the log append, which is the
// only step that can wait on a lock. In a room hosted elsewhere the leave is one op over the link, within
// LINK_CALL_END_MS; the host logs member_left and runs the reaper.
import * as identity from '../../lib/identity.ts';
import * as seats from '../../lib/seats.ts';
import { whoami } from '../seat.ts';
import { LINK_CALL_END_MS } from '../../lib/config.ts';
import type { HookIn } from '../types.ts';

const KEEP = new Set<string | undefined>(['clear', 'resume']);

export function handle(input: HookIn<'SessionEnd'>) {
  // This session id is over in this process (a /clear or /resume continues under another id, and mod-hello writes
  // that id's lease): a later --resume of it must say hello again before it can join.
  try { identity.deleteModLease(input.session_id); } catch { /* the join sweep prunes it */ }
  if (KEEP.has(input.reason)) return;
  const me = whoami(input);
  if (!me) return;
  if (me.role === 'claude') { try { identity.leave(me.code, me.name); } catch { /* gone */ } return; }
  seats.exit(me.code, me.name, input.reason || 'session ended', { deadlineMs: LINK_CALL_END_MS });
}
