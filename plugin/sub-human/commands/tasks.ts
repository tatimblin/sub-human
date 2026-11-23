// `/sub-human tasks`: the room's task list (R24), with no model call. Claude adds, claims and finishes tasks with its
// `task` tool, whose list op answers these same lines (module/tasks.ts).
import { taskLines } from '../core/tasks.js';
import type { Verb } from './types.js';
import { refused, say } from './types.js';

export const tasks: Verb = async (_args, ctx) => {
  const mine = await ctx.sessions.get(ctx.session);
  if (!mine) return say('This session is in no room. Type /sub-human to join one.');
  const s = await ctx.rooms.state(mine.code);
  if (!s.ok) return refused(`No tasks could be listed: ${s.error}`);
  return say(taskLines(mine.code, s.value.tasks).join('\n'));
};
