#!/usr/bin/env node
'use strict';
// SessionStart(compact|clear|resume): put this session back in its seat and re-inject the room context.
//   compact  same session id, same process: re-inject only.
//   clear    new session id, same claude process (CLAUDE_PID): rebind the new id to the seat found by pid.
//   resume   a new claude process with the old session id. If the seat is still live, rebind the new pid;
//            if session-end marked it left, rejoin the same name (when the room still exists) and log
//            member_joined "rejoined (resumed)".
// Context = role text + ROWS (lib/rows.js rowCalls(), led by a "re-create your rows" line: rows are lost
// on --resume and after a killed row) + roster + digest. sessionTitle shows the seat.
const { identity, room, run, out, whoami, presence, contextBlock, seatTitle } = require('./common.js');

const RECREATE = 'Your participant rows are gone (they do not survive --resume). Re-create them now, exactly as written:\n';
const CHECK = 'Your participant rows normally survive this. Re-create a row below only if it is missing from your agent panel, exactly as written:\n';

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
  if (last.role !== 'orch' && !identity.openRooms().includes(last.code)) return null;
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
  const text = contextBlock(me, `restored after ${input.source || 'start'}`, { rowsLead: input.source === 'resume' ? RECREATE : CHECK });
  out({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text, sessionTitle: seatTitle(me) } });
});
