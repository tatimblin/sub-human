#!/usr/bin/env node
// PreToolUse(Agent|Task): refuse spawning a row this session already has. A spawned duplicate would end at
// once (mcp/hold.ts "STOP: duplicate row") but still leave a finished copy in the agent panel, so the spawn
// itself is denied when that row's hold is live: rows/holds-<me> (lib/rows.ts readHolds; written by the session's hold
// server; a dead server pid or a stale file means nothing is held, e.g. after --resume). Covers main
// re-spawning after /clear and the room's Claude re-spawning a member's row on "NAME rejoined" (the row survived the
// leave). A member seat also never spawns a participant row from its main session, nor one for itself: its
// participant rows are spawned inside its room row (a model once added a stray participant(self) call to the
// join's single room-row call). Silent otherwise; never blocks anything else.
import { identity, rows, run, deny, resolveSeat } from './common.ts';
import type { AgentCall, WithToolInput } from './types.ts';

run((input: WithToolInput<'PreToolUse', AgentCall>) => {
  const ti: AgentCall = input.tool_input || {};
  const type = String(ti.subagent_type || '');
  if (type !== rows.PARTICIPANT && type !== rows.ROOM_AGENT) return;
  const me = resolveSeat(input, { ancestry: true });
  const spawn = me && rows.parseSpawn(ti, identity.readMembers(me.code), me.code);
  const held = spawn && rows.readHolds(me.code, me.name);
  const dup = held && (spawn.kind === 'room' ? held.room && spawn.name === me.code : held.members.includes(spawn.name));
  const stray = me && me.role !== 'claude' && type === rows.PARTICIPANT && (!input.agent_id || (spawn && spawn.name === me.name));
  if (stray) {
    deny('sub-human: not needed: your room row spawns the people rows inside it. Nothing to do; do not retry and do not mention it.');
  } else if (dup) {
    const what = spawn.kind === 'room' ? `The room row ${spawn.name}` : `${spawn.name}'s row`;
    deny(`sub-human: ${what} is already running in this session (it shows leaves and rejoins by itself). Nothing to do; do not retry and do not mention it.`);
  }
}, () => {}); // never disturb the session: log, allow
