#!/usr/bin/env node
'use strict';
// SessionStart(compact|clear|resume): put this session back in its seat and re-inject the room context.
//   compact  same session id, same process: re-inject only.
//   clear    new session id, same claude process (CLAUDE_PID): rebind the new id to the seat found by pid.
//   resume   a new claude process with the old session id. If the seat is still live, rebind the new pid;
//            if session-end marked it left, rejoin the same name (when the room still exists) and log
//            member_joined "rejoined (resumed)".
//            A room that is closing (the reaper is stopping its orch) is not rejoined.
// Context = the same mechanics block as join (common.js contextBlock: D's template filled + ROWS, i.e.
// lib/rows.js rowCalls(), which lists only the rows with no live hold: rows survive /clear and compaction, and
// a re-spawn duplicated the room row in the S11 demo run). On --resume the hold server is new, so every row is
// listed. sessionTitle = the native address NAME.CODE (SendMessage / ListAgents reach the session by it).
const path = require('node:path');
const { identity, room, run, out, whoami, presence, contextBlock, seatTitle } = require('./common.js');
const rows = require(path.join(__dirname, '..', 'lib', 'rows.js'));

const RECREATE = 'Your rows are not running (they do not survive --resume). Create them now, exactly as written:\n';
const PARTIAL = 'Your other rows are still running; only the rows below are missing. Make only these calls, exactly as written:\n';

/** The lead for the ROWS section: empty when nothing is missing (rowCalls then says the rows are intact). */
function rowsLead(me) {
  const held = rows.readHolds(me.code, me.name);
  if (!held) return RECREATE;
  return rows.rowsNeeded(me.code, me, { held }).length ? PARTIAL : '';
}

function reseat(input) {
  const me = whoami(input);
  const pid = identity.claudePid();
  if (me) {
    if (input.session_id && me.session_id !== input.session_id && pid === me.pid) identity.rebindSession(me.pid, input.session_id);
    if (pid && pid !== me.pid) {
      // Same session id, new process (resume while the old seat still looks live): move the seat here.
      const r = identity.join({ code: me.code, name: me.name, role: me.role, pid, session_id: input.session_id || me.session_id, cwd: input.cwd });
      if (r && r.ok) return { ...me, pid, session_id: input.session_id || me.session_id };
    }
    return { ...me, session_id: input.session_id || me.session_id };
  }
  if (input.source !== 'resume' || !pid) return null;
  const last = identity.lastSeat(input.session_id);
  if (!last) return null;
  if (identity.roomClosing(last.code) || (last.role !== 'orch' && !identity.openRooms().includes(last.code))) return null;
  const r = identity.join({ code: last.code, name: last.name, role: last.role, pid, session_id: input.session_id, cwd: input.cwd });
  if (!r || !r.ok) return null;
  room.bind(last.code);
  room.append({ kind: 'member_joined', text: `${last.name} rejoined (resumed)` }, { via: 'system', from: last.name, system: true });
  return { ...last, pid, session_id: input.session_id };
}

run(input => {
  const me = reseat(input);
  if (!me) return;
  room.bind(me.code);
  presence(me, 'working');
  const text = contextBlock(me, `restored after ${input.source || 'start'}`, { rowsLead: rowsLead(me) });
  out({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text, sessionTitle: seatTitle(me) } });
});
