// `/room join LINE [NAME]` (R30): proves the invite line to its host and answers at once with the check string
// the joiner reads to the host. Once the host lets this machine in and the room has synced, the daemon takes this
// session into the room itself, and the module draws the line saying so (module/follow.ts).
import { MODULES_OFF, defaultName } from './bare.js';
import { nameFrom } from '../core/join.js';
import type { Verb } from './types.js';
import { refused, say } from './types.js';

export const join: Verb = async (args, ctx) => {
  const mine = await ctx.sessions.get(ctx.session);
  if (mine) return refused(`This session is in ${mine.code} as ${mine.name}, so it joined no other. Type /room leave first.`);
  const [line, asked, ...rest] = args;
  if (line === undefined || rest.length) return refused('Nobody joined. Type /room join LINE, the line the host sent you.');
  const name = asked === undefined ? await defaultName(ctx) : nameFrom(asked);
  if (name === null) return refused('Nobody joined: there is no name to join as. Type /room join LINE NAME.');
  const on = await ctx.daemon.pinged(ctx.session);
  if (!on.ok || !on.value) return refused(on.ok ? MODULES_OFF : `Nobody joined: ${on.error}`);
  const d = await ctx.daemon.dial(line, name, { id: ctx.session, cwd: ctx.cwd, leave: ctx.uuid() });
  if (!d.ok) return refused(`Nobody joined: ${d.error}`);
  return say(`Tell the host: ${d.value.check}. Waiting to be let into ${d.value.code}…`);
};
