#!/usr/bin/env node
'use strict';
// PreToolUse(Agent|Task): refuse spawning a row this session already has. A spawned duplicate would end at
// once (mcp/hold.js "STOP: duplicate row") but still leave a finished copy in the agent panel, so the spawn
// itself is denied when that row's hold is live: <room>/rows/holds-<me>.json (written by the session's hold
// server; a dead server pid or a stale file means nothing is held, e.g. after --resume). Covers main
// re-spawning after /clear and the orch re-spawning a member's row on "NAME rejoined" (the row survived the
// leave). A member seat also never spawns a participant row from its main session, nor one for itself: its
// participant rows are spawned inside its room row (a model once added a stray participant(self) call to the
// join's single room-row call). Silent otherwise; never blocks anything else.
const path = require('node:path');
const identity = require(path.join(__dirname, '..', 'lib', 'identity.js'));
const rows = require(path.join(__dirname, '..', 'lib', 'rows.js'));
const { readInput, resolveMe } = require(path.join(__dirname, 'row-common.js'));

try {
  const input = readInput();
  const ti = input.tool_input || {};
  const type = String(ti.subagent_type || '');
  if (type === rows.PARTICIPANT || type === rows.ROOM_AGENT) {
    const me = resolveMe(input);
    const spawn = me && rows.parseSpawn(ti, identity.readMembers(me.code), me.code);
    const held = spawn && rows.readHolds(me.code, me.name);
    const dup = held && (spawn.kind === 'room' ? held.room && spawn.name === me.code : held.members.includes(spawn.name));
    const stray = me && me.role !== 'orch' && type === rows.PARTICIPANT && (!input.agent_id || (spawn && spawn.name === me.name));
    const deny = reason => process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    }) + '\n');
    if (stray) {
      deny('sub-human: not needed: your room row spawns the people rows inside it. Nothing to do; do not retry and do not mention it.');
    } else if (dup) {
      const what = spawn.kind === 'room' ? `The room row ${spawn.name}` : `${spawn.name}'s row`;
      deny(`sub-human: ${what} is already running in this session (it shows leaves and rejoins by itself). Nothing to do; do not retry and do not mention it.`);
    }
  }
} catch { /* never disturb the session */ }
