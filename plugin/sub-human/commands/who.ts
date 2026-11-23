// `/sub-human who`: who is in this session's room, on which machines, and what each is doing (R4, R14).
import type { Member } from '../core/entries.js';
import type { Verb } from './types.js';
import { refused, say } from './types.js';

export const who: Verb = async (_args, ctx) => {
  const mine = await ctx.sessions.get(ctx.session);
  if (!mine) return say('This session is in no room. Type /sub-human to join one.');
  const s = await ctx.rooms.state(mine.code);
  if (!s.ok) return refused(`Nobody could be listed: ${s.error}`);
  const here = s.value.members.filter(m => m.machines.length > 0 && !m.kicked);
  return say([`${mine.code} · ${here.length} here`, ...here.map(m => line(m, m.name === mine.name))].join('\n'));
};

function line(m: Member, me: boolean): string {
  const state = m.presence?.waiting ? 'waiting on a permission prompt' : m.presence?.state;
  const repo = m.focus?.repo ?? m.repo;
  const branch = m.focus?.branch ?? m.branch;
  const where = repo && branch ? `${repo} on ${branch}` : repo ?? branch;
  const focus = m.focus?.text.trim();
  const machines = [...new Set(m.machines)].join(', ');
  return [`${m.name}${me ? ' (you)' : ''}`, machines, state, focus, where].filter(x => x !== undefined && x !== '').join(' · ');
}
