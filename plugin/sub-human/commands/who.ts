// `/room who`: who is in this session's room, on which machines, and what each is doing (R4, R14).
import type { Member } from '../core/entries.js';
import { oneLine } from '../core/text.js';
import type { Verb } from './types.js';
import { refused, say } from './types.js';
import { hostAway } from '../core/api.js';
import { isHere } from '../core/entries.js';

export const who: Verb = async (_args, ctx) => {
  const mine = await ctx.sessions.get(ctx.session);
  if (!mine) return say('This session is in no room. Type /room to join one.');
  const s = await ctx.rooms.state(mine.code);
  if (!s.ok) return refused(`Nobody could be listed: ${s.error}`);
  // R34: a room hosted elsewhere whose host can't be reached shows who was here when it went
  const link = await ctx.daemon.link(mine.code);
  const away = link.ok && hostAway(link.value?.phase) ? ' · host away' : '';
  const here = s.value.members.filter(isHere);
  return say([`${mine.code} · ${here.length} here${away}`, ...here.map(m => line(m, m.name === mine.name))].join('\n'));
};

function line(m: Member, me: boolean): string {
  const state = m.presence?.waiting ? 'waiting on a permission prompt' : m.presence?.state;
  const repo = m.focus?.repo ?? m.repo;
  const branch = m.focus?.branch ?? m.branch;
  const where = repo && branch ? `${repo} on ${branch}` : repo ?? branch;
  const focus = m.focus?.text;
  const machines = [...new Set(m.machines)].join(', ');
  // every field is a member's own text, drawn to the terminal: one line each, no escape sequence
  return [`${m.name}${me ? ' (you)' : ''}`, machines, state, focus, where].map(x => oneLine(x ?? '', 200)).filter(x => x !== '').join(' · ');
}
