#!/usr/bin/env node
'use strict';
// PostToolUse(Agent|Task): record which panel row a spawned row agent is, for the subagentStatusLine.
//   <room>/rows/<session_id>.json  {byAgent: {<child agentId>: {kind: participant|room, name, parent, at}}}
// The child id is tool_response.agentId. When a room agent spawns a participant, the hook input's
// agent_id / agent_type are the spawning room, so parent = that id (nested row). The model may drop `name`:
// the participant comes from the prompt ("member: NAME"), else the description. Silent; never blocks.
const { identity, rows, run, resolveSeat } = require('./common.js');

run(input => {
  const ti = input.tool_input || {};
  const type = String(ti.subagent_type || '');
  if (type !== rows.PARTICIPANT && type !== rows.ROOM_AGENT) return;
  const r = typeof input.tool_response === 'object' && input.tool_response ? input.tool_response : {};
  const agentId = r.agentId || r.agent_id || (r.data && r.data.agentId);
  const me = resolveSeat(input, { ancestry: true });
  if (!agentId || !me) return;
  const spawn = rows.parseSpawn(ti, identity.readMembers(me.code), me.code);
  if (!spawn) return;
  rows.recordRow(me.code, input.session_id, String(agentId), {
    kind: spawn.kind, name: spawn.name,
    parent: input.agent_id ? String(input.agent_id) : null,
  });
}, () => {}); // never disturb the session
