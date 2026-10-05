#!/usr/bin/env node
'use strict';
// SubagentStop: keep a row agent holding while its row is still wanted (E1/E3 "cheap insurance").
// A row agent only stops on its own when `hold` returned something other than its instruction (an error,
// an MCP timeout, a server restart) and Haiku gave up. Then, if the row's participant (or, for the room row,
// this seat) is still in the room, block the stop and tell it to hold again; at most MAX_BLOCKS per agent.
// A participant row is wanted while this seat is in the room, even after its member left (it reads "left").
// An Esc-kill does NOT fire SubagentStop (P0); hold.js's RESPAWN covers that. A row that stops for good
// (STOP: this seat left, or a duplicate) is dropped from the row map.
const path = require('node:path');
const fs = require('node:fs');
const identity = require(path.join(__dirname, '..', 'lib', 'identity.js'));
const rows = require(path.join(__dirname, '..', 'lib', 'rows.js'));
const { readInput, resolveMe } = require(path.join(__dirname, 'row-common.js'));

const MAX_BLOCKS = 5;

try {
  const input = readInput();
  const type = String(input.agent_type || '');
  const id = input.agent_id ? String(input.agent_id) : '';
  if ((type === rows.PARTICIPANT || type === rows.ROOM_AGENT) && id) {
    const me = resolveMe(input);
    const rec = me && rows.readRowMap(me.code)[id];
    const last = String(input.last_assistant_message || '').trim();
    const stopped = /^(left|STOP)\b/i.test(last);
    if (me && rec && !stopped) {
      const ms = identity.readMembers(me.code) || {};
      const wanted = rec.kind === 'room'
        ? !!(ms[me.name] && !ms[me.name].left_at)
        : !!(ms[rec.name] && ms[me.name] && !ms[me.name].left_at); // a member who left keeps the row ("left")
      const countFile = path.join(rows.rowsDir(me.code), `blocks-${id.replace(/[^A-Za-z0-9_-]/g, '')}`);
      let n = 0;
      try { n = Number(fs.readFileSync(countFile, 'utf8')) || 0; } catch { /* first */ }
      if (wanted && n < MAX_BLOCKS) {
        try { fs.mkdirSync(path.dirname(countFile), { recursive: true }); fs.writeFileSync(countFile, String(n + 1)); } catch { /* best effort */ }
        const args = rec.kind === 'room' ? `{"room": "${rec.name}"}` : `{"member": "${rec.name}"}`;
        process.stdout.write(JSON.stringify({
          decision: 'block',
          reason: `${rec.kind === 'room' ? `Room ${rec.name}` : `${rec.name}'s row`} is still wanted, so this row stays open. Call hold with ${args} again now. Write no text.`,
        }) + '\n');
      } else if (!wanted) {
        rows.forgetRow(me.code, id);
      }
    } else if (me && rec && stopped) {
      rows.forgetRow(me.code, id);
    }
  }
} catch { /* never disturb the session */ }
