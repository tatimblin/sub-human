// `/sub-human tasks`: the room's task list (R24). Claude adds, claims and finishes tasks with its `task` tool.
import type { Task } from '../core/entries.js';
import type { Verb } from './types.js';
import { refused, say } from './types.js';

export const tasks: Verb = async (_args, ctx) => {
  const mine = await ctx.sessions.get(ctx.session);
  if (!mine) return say('This session is in no room. Type /sub-human to join one.');
  const s = await ctx.rooms.state(mine.code);
  if (!s.ok) return refused(`No tasks could be listed: ${s.error}`);
  const open = s.value.tasks.filter(t => t.status !== 'done');
  const done = s.value.tasks.length - open.length;
  if (s.value.tasks.length === 0) return say(`${mine.code} has no tasks yet.`);
  const tail = done ? [`${done} done`] : [];
  return say([`${mine.code} · ${open.length} open`, ...open.map(line), ...tail].join('\n'));
};

function line(t: Task): string {
  const who = t.owner ? `${t.owner}'s` : 'open';
  const blocked = t.blockedBy.length ? ` · after #${t.blockedBy.join(', #')}` : '';
  return `#${t.n} ${who} · ${t.title}${blocked}`;
}
