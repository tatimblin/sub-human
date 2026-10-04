#!/usr/bin/env node
'use strict';
// PreToolUse(SendMessage): seats (agent_type seat-*) may only SendMessage to "main".
// A sibling message would re-parent the target's reports (research 01). Seats reach the room
// through mcp__room__post; SendMessage to main is only their fallback when the room tools fail.
const { run, deny, seatHuman } = require('./common.js');

run(input => {
  if (!seatHuman(input.agent_type)) return;
  const to = (input.tool_input || {}).to;
  if (to !== 'main') {
    deny(`ROOM-GUARD: seats may SendMessage only to "main", not ${JSON.stringify(to)}. Post to the room with mcp__room__post instead; never message other seats.`);
  }
}, (err, input) => { if (input && seatHuman(input.agent_type)) deny(`ROOM-GUARD: guard failed (${err.message}); denied to be safe.`); });
