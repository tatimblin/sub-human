#!/usr/bin/env node
'use strict';
// UserPromptExpansion(sub-human:sub-human): bind this session's identity. The model never chooses it.
//   /sub-human              -> create a room and join it as "orch" (role orch). Works in a
//                              `--agent sub-human:orchestrator` session and in a plain one.
//                              Already the orch -> re-print the code.
//   /sub-human NAME [CODE]  -> join CODE as NAME and log member_joined (via system). CODE may be left
//                              out when exactly one room is open; 0 or >1 open rooms is an error that
//                              lists the codes. Already in another room -> member_left "switched rooms".
// The claude pid comes from CLAUDE_PID, which Claude Code sets for every hook it runs.
// Failure blocks the prompt with a reason (no model turn). Success injects the SUB-HUMAN context (role
// text, ROWS = lib/rows.js rowCalls(), roster, digest) and shows the invite code in systemMessage.
// UserPromptExpansion output has no sessionTitle; at-room.js (UserPromptSubmit) sets it on the next prompt.
const { identity, room, out, run, whoami, presence, contextBlock } = require('./common.js');

const COMMANDS = new Set(['sub-human:sub-human', 'sub-human']);
const ORCH_AGENT = 'sub-human:orchestrator';
const block = reason => out({ decision: 'block', reason: `sub-human: ${reason}` });
const inviteMsg = code => `room ${code} open · others join with: /sub-human NAME (or /sub-human NAME ${code})`;

function success(me, lead) {
  presence(me, 'working');
  out({
    systemMessage: me.role === 'orch' ? inviteMsg(me.code) : `sub-human: joined room ${me.code} as ${me.name}.`,
    hookSpecificOutput: { hookEventName: 'UserPromptExpansion', additionalContext: contextBlock(me, lead) },
  });
}

/** The single open room, or a block() explaining why there isn't one. */
function pickRoom() {
  const open = identity.openRooms();
  if (open.length === 1) return open[0];
  if (!open.length) { block('no room is open. Ask the orchestrator for the code: /sub-human NAME CODE.'); return null; }
  block(`${open.length} rooms are open (${open.join(', ')}); say which: /sub-human NAME CODE.`);
  return null;
}

run(input => {
  if (!COMMANDS.has(input.command_name)) return;
  const args = String(input.command_args || '').trim().split(/\s+/).filter(Boolean);
  const pid = identity.claudePid();
  if (!pid) return block('could not identify this Claude Code process (CLAUDE_PID is not set).');
  const isOrchAgent = input.agent_type === ORCH_AGENT;
  const base = { pid, session_id: input.session_id, cwd: input.cwd || process.cwd() };
  const cur = whoami(input);

  if (args.length === 0) {
    if (cur && cur.role === 'orch' && identity.roomExists(cur.code)) return success(cur, 'room already open');
    if (cur) return block(`this session is already ${cur.name} in room ${cur.code}; start a new session to run a room.`);
    const code = identity.newCode();
    const r = identity.join({ code, name: 'orch', role: 'orch', ...base });
    if (!r || !r.ok) return block(`could not create a room: ${(r && r.error) || 'unknown error'}`);
    room.bind(code);
    return success({ code, name: 'orch', role: 'orch', pid, session_id: input.session_id || null }, 'room created');
  }

  if (args.length > 2) return block('usage: /sub-human (open a room) or /sub-human NAME [CODE] (join one).');
  if (isOrchAgent) return block('this session runs the orchestrator agent; open a room with /sub-human (no name). Members join from their own sessions.');
  const name = args[0];
  if (cur && cur.role === 'orch') return block(`this session is the orchestrator of room ${cur.code}; start a new session to join a room.`);
  const code = args[1] || (cur && cur.name === name ? cur.code : pickRoom());
  if (!code) return;
  if (!identity.roomExists(code)) return block(`no room ${code}. Check the code with the orchestrator.`);
  if (cur && cur.code === code && cur.name === name) return success(cur, 'already joined');
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
  success({ code, name, role: 'member', pid, session_id: input.session_id || null }, r.rejoin ? 'rejoined' : 'joined');
});
