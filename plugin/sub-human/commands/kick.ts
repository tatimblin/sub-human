// `/room kick NAME`: the host ends that member's access to this room, at once and for good (R31). Whether this
// machine hosts the room is the daemon's to check: it refuses a kick from anywhere else.
import { nameFrom } from '../core/join.js';
import type { Verb } from './types.js';
import { refused, say } from './types.js';

export const kick: Verb = async (args, ctx) => {
  const mine = await ctx.sessions.get(ctx.session);
  if (!mine) return refused('Nobody was removed: this session is in no room.');
  const asked = args[0];
  const name = asked === undefined ? null : nameFrom(asked);
  if (name === null || args.length > 1) return refused('Nobody was removed. Type /room kick NAME.');
  if (name === mine.name) return refused('You were not removed: to go, type /room leave.');
  const s = await ctx.rooms.state(mine.code);
  if (!s.ok) return refused(`${name} was not removed: ${s.error}`);
  const m = s.value.members.find(x => x.name === name);
  if (!m) return refused(`${name} was not removed: there is no ${name} in ${mine.code}.`);
  if (m.kicked) return say(`${name} is already removed from ${mine.code}.`);
  const r = await ctx.daemon.kick(mine.code, name, mine.name);
  return r.ok ? say(`${name} is removed from ${mine.code} for good.`) : refused(`${name} was not removed: ${r.error}`);
};
