#!/usr/bin/env node
'use strict';
// PreToolUse(Agent), main thread: at most one live seat per subagent_type.
// A seat is live when roster.json has it with live:true and the same session_id (a roster left by
// a crashed earlier session does not block a respawn). A spawn allowed here is marked pending for
// 60 s so two Agent calls in the same turn cannot both pass before SubagentStart records the first.
const { run, deny, seatHuman, readRoster, updateRoster } = require('./common.js');

const PENDING_MS = 60_000;

run(input => {
  if (input.agent_id) return; // only the main thread spawns seats
  const type = (input.tool_input || {}).subagent_type;
  const human = seatHuman(type);
  if (!human) return;
  const r = readRoster()[human];
  const sameSession = r && (!r.session_id || !input.session_id || r.session_id === input.session_id);
  if (r && r.live && sameSession) {
    return deny(`ROOM-GUARD: ${type} is already running (agent_id ${r.agent_id}). One seat per human: reach it with \`demo/bin/room post --kind directive --to ${human}\`, not a new spawn.`);
  }
  if (r && r.pending_at && sameSession && Date.now() - Date.parse(r.pending_at) < PENDING_MS && !r.live && !r.stopped_at) {
    return deny(`ROOM-GUARD: ${type} was spawned moments ago and is starting. Do not spawn it twice.`);
  }
  updateRoster(ro => {
    const prev = ro[human] || {};
    ro[human] = { ...prev, human, agent_type: type, session_id: input.session_id, pending_at: new Date().toISOString() };
    delete ro[human].stopped_at;
    if (prev.session_id !== input.session_id) ro[human].live = false;
  });
});
