// plugin/sub-human/hooks/handlers/row-hold.ts: SubagentStop: keep the room row holding while this seat is in the room (cheap insurance).
// The room row agent (agents/room.md) only stops on its own when `hold` returned something other than its
// instruction (an error, an MCP timeout, a server restart) and the row's model gave up. Then, if this seat is still in
// the room, block the stop and tell it to hold again; at most MAX_BLOCKS per agent. A row that stops for good (STOP:
// this seat left, or a duplicate) goes. An Esc-kill fires no SubagentStop: the hooks module starts the row again at
// the next prompt (mod/rows.ts).
import * as identity from '../../lib/identity.ts';
import * as rows from '../../lib/rows.ts';
import { resolveSeat } from '../seat.ts';
import { out } from '../reply.ts';
import type { HookIn } from '../types.ts';
import type { Member } from '../../lib/room/types.ts';

const MAX_BLOCKS = 5;

export function handle(input: HookIn<'SubagentStop'>): void {
  const id = input.agent_id ? String(input.agent_id) : '';
  if (String(input.agent_type || '') !== rows.ROOM_AGENT || !id) return;
  const last = String(input.last_assistant_message || '').trim();
  if (/^(left|STOP)\b/i.test(last)) return;
  const me = resolveSeat(input, { ancestry: true });
  if (!me || me.role === 'claude') return;
  const ms: Record<string, Member | undefined> = identity.readMembers(me.code) || {};
  const mine = ms[me.name];
  if (!mine || mine.left_at) return;
  let n = 0;
  try { n = rows.blockCount(me.code, { seat: me.name, agent: id }); } catch { /* first */ }
  if (n >= MAX_BLOCKS) return;
  try { rows.setBlockCount(me.code, { seat: me.name, agent: id }, n + 1); } catch { /* best effort */ }
  out({
    decision: 'block',
    reason: `Room ${me.code} is still wanted, so this row stays open. Call hold with {"room": "${me.code}"} again now. Write no text.`,
  });
}

/** Never disturb the session: logged, the stop goes on. */
export const fail = () => null;
