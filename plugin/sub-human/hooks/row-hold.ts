#!/usr/bin/env node
// SubagentStop: keep a row agent holding while its row is still wanted (cheap insurance).
// A row agent only stops on its own when `hold` returned something other than its instruction (an error,
// an MCP timeout, a server restart) and the row's model gave up. Then, if the row's participant (or, for the room row,
// this seat) is still in the room, block the stop and tell it to hold again; at most MAX_BLOCKS per agent.
// A participant row is wanted while this seat is in the room, even after its member left (it reads "left").
// An Esc-kill does NOT fire SubagentStop; hold.ts's RESPAWN covers that. A row that stops for good
// (STOP: this seat left, or a duplicate) is dropped from the row map.
import { identity, rows, run, out, resolveSeat } from './common.ts';
import type { HookIn, MemberRec } from './types.ts';

const MAX_BLOCKS = 5;

run((input: HookIn<'SubagentStop'>) => {
  const type = String(input.agent_type || '');
  const id = input.agent_id ? String(input.agent_id) : '';
  if ((type !== rows.PARTICIPANT && type !== rows.ROOM_AGENT) || !id) return;
  const me = resolveSeat(input, { ancestry: true });
  const rec = me && rows.readRowMap(me.code)[id];
  if (!rec) return;
  const last = String(input.last_assistant_message || '').trim();
  if (/^(left|STOP)\b/i.test(last)) return rows.forgetRow(me.code, id);
  const ms: Record<string, MemberRec | undefined> = identity.readMembers(me.code) || {};
  const mine = ms[me.name];
  const wanted = rec.kind === 'room'
    ? !!(mine && !mine.left_at)
    : !!(ms[rec.name] && mine && !mine.left_at); // a member who left keeps the row ("left")
  let n = 0;
  try { n = rows.blockCount(me.code, id); } catch { /* first */ }
  if (wanted && n < MAX_BLOCKS) {
    try { rows.setBlockCount(me.code, id, n + 1); } catch { /* best effort */ }
    const args = rec.kind === 'room' ? `{"room": "${rec.name}"}` : `{"member": "${rec.name}"}`;
    out({
      decision: 'block',
      reason: `${rec.kind === 'room' ? `Room ${rec.name}` : `${rec.name}'s row`} is still wanted, so this row stays open. Call hold with ${args} again now. Write no text.`,
    });
  } else if (!wanted) {
    rows.forgetRow(me.code, id);
  }
}, () => {}); // never disturb the session
