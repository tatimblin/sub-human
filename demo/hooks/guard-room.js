#!/usr/bin/env node
'use strict';
// PreToolUse(Write|Edit|NotebookEdit|Bash): subagents never write the room (plan §3.5 step 1).
// Applies only when agent_id is present (a subagent; the main thread has no agent_id).
// Denies:
//   - Write/Edit/NotebookEdit whose path is under demo/.room/ or $ROOM_DIR (log, roster, plan files);
//   - Bash that references .room/, $ROOM_DIR, log.jsonl or roster.json; that runs `room post` or
//     `room done`; that runs the human client `chat`; or that sets ROOM_USER.
// Allows `room read`, `room digest`, `room tail`, `room wait` and everything else.
// Seats post through mcp__room__post, which stamps identity from the seat definition's env.
// Fails closed for subagents on an internal error.
const { room, run, deny, isUnder, roomDirs } = require('./common.js');

const B = String.raw`(?:^|[\s;&|()\x60'"=<>{}/:])`; // a boundary before a word
const BASH_RULES = [
  [new RegExp(String.raw`(?:^|[^A-Za-z0-9_.-])\.room(?:/|$|[^A-Za-z0-9_-])`), 'touches demo/.room'],
  [/\b(?:log\.jsonl|roster\.json)\b/, 'touches the room log or roster'],
  [new RegExp(`${B}room(?:\\.js)?['"]?\\s+(?:post|done)\\b`), 'runs `room post`/`room done`'],
  [/(?:^|[;&|(`{]|\b(?:node|exec|env|nohup|bash|sh|zsh)\s)\s*(?:\S*\/)?chat(?=\s|$|[;&|)`])/, 'runs the human client `chat`'],
  [/\bbin\/chat\b/, 'runs the human client `chat`'],
  [/\bROOM_USER\s*=/, 'sets ROOM_USER'],
];

function bashViolation(cmd) {
  for (const [re, why] of BASH_RULES) if (re.test(cmd)) return why;
  const rd = room.dir();
  if (process.env.ROOM_DIR && cmd.includes(rd)) return 'touches $ROOM_DIR';
  return null;
}

const MSG = 'ROOM-GUARD: subagents may not write the room. Post with mcp__room__post (identity is stamped for you); read with `demo/bin/room read --id N` or `demo/bin/room digest`. The orchestrator alone writes the plan.';

run(input => {
  if (!input.agent_id) return;
  const ti = input.tool_input || {};
  const base = input.cwd || process.cwd();
  if (input.tool_name === 'Bash') {
    const why = bashViolation(String(ti.command || ''));
    if (why) deny(`${MSG} (Denied: the command ${why}.)`);
    return;
  }
  const p = ti.file_path || ti.notebook_path;
  if (typeof p === 'string' && p && isUnder(p, roomDirs(), base)) deny(`${MSG} (Denied: ${input.tool_name} on ${p}.)`);
}, (err, input) => { if (input && input.agent_id) deny(`ROOM-GUARD: guard failed (${err.message}); denied to be safe.`); });
