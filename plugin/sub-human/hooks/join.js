#!/usr/bin/env node
'use strict';
// UserPromptExpansion(sub-human:sub-human): bind this session's identity. The model never chooses it.
//   /sub-human            -> create a room and join it as "orch" (role orch); already orch -> re-print code
//   /sub-human NAME CODE  -> join CODE as NAME, and log member_joined (via system)
// Failure blocks the prompt with a reason (no model turn). Success injects the SUB-HUMAN context
// (role text, roster, digest) and shows the invite code to the user in systemMessage.
const { identity, room, out, run, whoami, contextBlock } = require('./common.js');

const COMMANDS = new Set(['sub-human:sub-human', 'sub-human']);
const block = reason => out({ decision: 'block', reason: `sub-human: ${reason}` });
const inviteMsg = code => `sub-human room ${code}. Others join with: /sub-human NAME ${code}`;

function success(me, lead) {
  out({
    systemMessage: me.role === 'orch' ? inviteMsg(me.code) : `sub-human: joined room ${me.code} as ${me.name}.`,
    hookSpecificOutput: { hookEventName: 'UserPromptExpansion', additionalContext: contextBlock(me, lead) },
  });
}

run(input => {
  if (!COMMANDS.has(input.command_name)) return;
  const args = String(input.command_args || '').trim().split(/\s+/).filter(Boolean);
  const pid = identity.claudePid();
  if (!pid) return block('could not identify this Claude Code process (CLAUDE_PID missing or not an ancestor).');
  const base = { pid, session_id: input.session_id, cwd: input.cwd || process.cwd() };
  const cur = whoami(input);

  if (args.length === 0) {
    if (cur && cur.role === 'orch' && identity.roomExists(cur.code)) return success(cur, 'room already open');
    if (cur) return block(`this session is already ${cur.name} in room ${cur.code}; start a new session to run a room.`);
    const code = identity.newCode();
    const r = identity.join({ code, name: 'orch', role: 'orch', ...base });
    if (!r || !r.ok) return block(`could not create a room: ${(r && r.error) || 'unknown error'}`);
    room.bind(code);
    return success({ code, name: 'orch', role: 'orch', pid }, 'room created');
  }

  if (args.length !== 2) return block('usage: /sub-human (create a room) or /sub-human NAME CODE (join one).');
  const [name, code] = args;
  if (cur && cur.code === code && cur.name === name && cur.role !== 'orch') {
    return success(cur, 'already joined');
  }
  if (cur && cur.role === 'orch') return block(`this session is the orchestrator of room ${cur.code}; start a new session to join a room.`);
  if (!identity.roomExists(code)) return block(`no room ${code}. Check the code with the orchestrator.`);
  if (cur) {
    // Switching rooms: leave the old one exactly as exiting the session would.
    identity.leave(cur.code, cur.name);
    room.bind(cur.code);
    room.append({ kind: 'member_left', text: `${cur.name} left (switched rooms)` }, { via: 'system', from: cur.name, system: true });
  }
  const r = identity.join({ code, name, role: 'member', ...base });
  if (!r || !r.ok) return block(`could not join ${code} as ${name}: ${(r && r.error) || 'unknown error'}`);
  room.bind(code);
  room.append({ kind: 'member_joined', text: `${name} ${r.rejoin ? 'rejoined' : 'joined'}` }, { via: 'system', from: name, system: true });
  success({ code, name, role: 'member', pid }, r.rejoin ? 'rejoined' : 'joined');
});
