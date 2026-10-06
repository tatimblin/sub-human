#!/usr/bin/env node
'use strict';
// UserPromptExpansion(sub-human:sub-human): bind this session's identity. The model never chooses it.
//   /sub-human NAME [CODE]  -> join CODE as NAME and log member_joined (via system). Without CODE: the one open
//                              room; with no open room, create one and start its headless orch (lib/orch.js);
//                              several open rooms is an error that lists the codes. A room is open while it
//                              has a live seat and is not closing. Already in another room -> member_left
//                              "switched rooms". Joining a room with no live orch (re)starts it.
//   /sub-human              -> the orch's launch prompt: in a session whose agent_type is sub-human:orchestrator
//                              and whose env has SUB_HUMAN_ROOM (both set by the spawn), bind it as "orch" of
//                              that room. In a plain session it explains usage: the orch is started for you.
//   Manual orch (debugging only): `node lib/orch.js cmd CODE` prints the exact spawn command; or run
//   `claude --agent sub-human:orchestrator --permission-mode plan` and type `/sub-human CODE` (an existing room)
//   or `/sub-human` (a new room, no SUB_HUMAN_ROOM).
// The claude pid comes from CLAUDE_PID, which Claude Code sets for every hook it runs.
// Failure blocks the prompt with a reason (no model turn). Success injects the mechanics block (common.js
// contextBlock: D's template filled + ROWS) and a one-line systemMessage; bypass-permissions mode gets a warning.
// UserPromptExpansion output has no sessionTitle; at-room.js (UserPromptSubmit) sets it (NAME.CODE) on the next prompt.
const { identity, room, out, run, whoami, presence, contextBlock } = require('./common.js');
const orch = require('../lib/orch.js');

const COMMANDS = new Set(['sub-human:sub-human', 'sub-human']);
const ORCH_AGENT = 'sub-human:orchestrator';
const USAGE = 'usage: /sub-human NAME [CODE]. It joins the open room as NAME, or opens one and starts its orch for you (the orch is never launched by hand).';
const BYPASS = ' · ⚠ bypass-permissions mode: messages from other sessions can wait behind a dialog; restart in another mode to get them live';
const block = reason => out({ decision: 'block', reason: `sub-human: ${reason}` });

function success(me, lead, msg, input) {
  presence(me, 'working');
  const warn = input.permission_mode === 'bypassPermissions' && me.role !== 'orch' ? BYPASS : '';
  out({
    systemMessage: `sub-human: ${msg}${warn}`,
    hookSpecificOutput: { hookEventName: 'UserPromptExpansion', additionalContext: contextBlock(me, lead) },
  });
}

/** Start the room's orch when it has none running; '' or a short note for the systemMessage. */
function ensureOrch(code, cwd) {
  if (!orch.needsSpawn(code)) return '';
  const r = orch.spawn({ code, cwd });
  return r.ok ? '' : ` · no orch (${r.error}); /sub-human still works, but there is no room task list`;
}

function others(code, name) {
  const ms = Object.values(identity.readMembers(code)).filter(m => m && m.name && m.name !== name && !m.left_at && (m.role !== 'orch' || m.pid || m.job));
  return ms.map(m => m.name).join(', ');
}

/** The orch's own launch `/sub-human` (or a debugging `/sub-human [CODE]` in an orch-agent session). */
function bindOrch(input, base, cur, args) {
  if (args.length > 1 || (args[0] && !identity.CODE_RE.test(args[0]))) {
    return block('this session runs the orchestrator agent; members join from their own sessions with /sub-human NAME.');
  }
  const code = process.env.SUB_HUMAN_ROOM || args[0] || null;
  if (cur && cur.role === 'orch' && (!code || cur.code === code)) return success(cur, 'room already open', `orch of room ${cur.code}`, input);
  if (cur) return block(`this session is already ${cur.name} in room ${cur.code}.`);
  const fresh = !code;
  const c = code || identity.newCode();
  if (!identity.roomExists(c)) return block(`no room ${c}.`);
  if (identity.roomClosing(c)) return block(`room ${c} is closing.`);
  const r = identity.join({ code: c, name: 'orch', role: 'orch', ...base });
  if (!r || !r.ok) return block(`could not bind the orch of ${c}: ${(r && r.error) || 'unknown error'}`);
  room.bind(c);
  const me = { code: c, name: 'orch', role: 'orch', pid: base.pid, session_id: base.session_id || null, address: identity.address('orch', c) };
  return success(me, fresh ? 'room created' : 'orch started', fresh ? `room ${c} open · others join with: /sub-human NAME ${c}` : `orch of room ${c}`, input);
}

/** The single open room, null for none (the caller creates one), or a block() for several. */
function pickRoom() {
  const open = identity.openRooms();
  if (open.length <= 1) return { code: open[0] || null };
  block(`${open.length} rooms are open (${open.join(', ')}); say which: /sub-human NAME CODE.`);
  return null;
}

run(input => {
  if (!COMMANDS.has(input.command_name)) return;
  const args = String(input.command_args || '').trim().split(/\s+/).filter(Boolean);
  const pid = identity.claudePid();
  if (!pid) return block('could not identify this Claude Code process (CLAUDE_PID is not set).');
  const cwd = input.cwd || process.cwd();
  const base = { pid, session_id: input.session_id, cwd };
  const cur = whoami(input);

  if (input.agent_type === ORCH_AGENT) return bindOrch(input, base, cur, args);
  if (args.length === 0) {
    if (cur && cur.role !== 'orch') return block(`you are ${cur.name} in room ${cur.code} (address ${cur.name}.${cur.code}). ${USAGE}`);
    return block(USAGE);
  }
  if (args.length > 2) return block(USAGE);
  const name = args[0];
  if (cur && cur.role === 'orch') return block(`this session is the orch of room ${cur.code}; join from another session.`);

  let code = args[1] || (cur && cur.name === name ? cur.code : null);
  let created = false;
  if (!code) {
    const pick = pickRoom();
    if (!pick) return;
    code = pick.code;
  }
  if (!code) {
    // Check the name before making a room for it.
    if (!identity.NAME_RE.test(name)) return block(`invalid name "${name}" (letters, digits, . _ -, up to 32)`);
    if (identity.RESERVED.includes(name.toLowerCase())) return block(`"${name}" is reserved`);
    code = identity.newCode();
    created = true;
  } else {
    if (!identity.roomExists(code)) return block(`no room ${code}. Check the code, or run /sub-human ${name} to open a new room.`);
    if (identity.roomClosing(code)) return block(`room ${code} is closing; run /sub-human ${name} to open a new room.`);
  }
  if (cur && cur.code === code && cur.name === name) {
    return success(cur, 'already joined', `in room ${cur.code} as ${name}${ensureOrch(code, cwd)}`, input);
  }
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
  const note = ensureOrch(code, cwd);
  const me = { code, name, role: 'member', pid, session_id: input.session_id || null, address: identity.address(name, code) };
  const here = others(code, name);
  const msg = created
    ? `opened room ${code} as ${name} · others: /sub-human NAME`
    : `${r.rejoin ? 'rejoined' : 'joined'} ${code} as ${name}${here ? ` (${here} here)` : ''}`;
  success(me, created ? 'room opened' : r.rejoin ? 'rejoined' : 'joined', `${msg}${note}`, input);
});
