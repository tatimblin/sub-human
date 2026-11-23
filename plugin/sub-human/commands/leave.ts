// `/sub-human leave`: this session leaves its room and keeps going (R3). Ending the session only marks it away.
import type { Membership } from './membership.js';
import type { Ctx, Verb } from './types.js';
import { refused, say } from './types.js';
import type { Result } from '../core/result.js';
import { ok } from '../core/result.js';

export const leave: Verb = async (_args, ctx) => {
  const mine = await ctx.sessions.get(ctx.session);
  if (!mine) return say('This session is in no room.');
  const r = await leaveRoom(ctx, mine);
  return r.ok ? say(`You left ${mine.code}.`) : refused(`You're still in ${mine.code}: ${r.error}`);
};

/**
 * The one way a member leaves the room: `left` under the leave id the pointer was given at the join, so a retry is
 * stored once, and only when no other session pointer or pending handoff holds the name. No pointer: already left.
 */
export async function leaveRoom(ctx: Ctx, m: Membership): Promise<Result<null>> {
  const r = await ctx.daemon.leave(m.id);
  return r.ok ? ok(null) : r;
}
