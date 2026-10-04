#!/usr/bin/env node
'use strict';
// SubagentStart(seat-.*): record agent_id -> human in <ROOM_DIR>/roster.json, append seat_up
// (from=<human>, via=agent, agent_id), and give the seat its resume point as additionalContext:
// the last seq it handled (its previous incarnation's last_seq, or its last own post) and the
// current plan hash.
// SubagentStart also fires when SendMessage resumes a stopped seat (same agent_id; verified live on
// 2.1.281), so this hook is also what marks a resumed seat live again; its seat_up says "resumed".
const { room, run, out, seatHuman, withUser, updateRoster, readRoster } = require('./common.js');

run(input => {
  const human = seatHuman(input.agent_type);
  if (!human || !input.agent_id) return;
  const entries = room.readAll();
  const prev = readRoster()[human] || {};
  const ownLast = entries.filter(e => e.from === human && e.via === 'agent' && e.kind !== 'seat_up').at(-1);
  const lastSeq = Math.max(Number(prev.last_seq) || 0, ownLast ? ownLast.id : 0);
  const plan = room.currentPlan(entries);

  const up = withUser(human, () => room.append({
    kind: 'seat_up',
    text: prev.agent_id === input.agent_id
      ? `${input.agent_type} resumed (agent_id ${input.agent_id})`
      : `${input.agent_type} up (agent_id ${input.agent_id})${prev.agent_id ? `, replacing ${prev.agent_id}` : ''}`,
  }, { via: 'agent', agent_id: String(input.agent_id).slice(0, 64) }));

  updateRoster(r => {
    r[human] = {
      human, agent_id: input.agent_id, agent_type: input.agent_type, session_id: input.session_id,
      live: true, up_id: up.id, started_at: up.at, last_seq: lastSeq,
    };
  });

  const ctx = [
    `ROOM: you are ${input.agent_type}, agent_id ${input.agent_id}, registered as #${up.id}.`,
    `Last handled seq: ${lastSeq}. Call mcp__room__await_human with after_seq=${lastSeq}.`,
    plan ? `Current plan: ${plan.path} plan_hash=${plan.hash} (plan_rev #${plan.id}).` : 'Current plan: none yet.',
    `Log head: #${up.id}.`,
  ].join('\n');
  out({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: ctx } });
});
