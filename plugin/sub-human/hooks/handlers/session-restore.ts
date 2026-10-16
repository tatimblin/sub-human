// plugin/sub-human/hooks/handlers/session-restore.ts: SessionStart(compact|clear|resume|fork): put this session back in its seat and re-inject the room context.
//   compact  same session id, same process: re-inject only.
//   clear    new session id, same claude process (CLAUDE_PID): rebind the new id to the seat found by pid.
//   resume   a new claude process with the old session id. If the seat is still live, rebind the new pid;
//            if session-end marked it left, rejoin the same name (when the room still exists) and log
//            member_joined "rejoined (resumed)" with the seat's pubkey and machine (lib/seats.ts). In a room hosted
//            elsewhere the link daemon is started first and the host logs the rejoin (lib/remote/server.ts).
//            A room that is closing (the reaper is stopping its room Claude) is not rejoined.
//   fork     a new claude process and a new session id: ← (the agent view) moved the conversation into a bg job
//            (cc CONTRACT session-fork-continued-in). The old session's transcript, beside this one's, says which
//            session it went on in, written just after the job starts: waited for up to FORK_RECORD_WAIT_MS. The
//            seat the old session holds moves here (identity.adoptFork: no leave, no log line); its rows ended with
//            the old session, so every row is listed. A fork with no such record (claude --resume X --fork-session
//            typed by hand) takes no seat: the session it came from may still hold it. A fork whose old session held
//            a seat this sub-human folder has no record of (its title an address NAME.CODE: SUB_HUMAN_HOME was set
//            only in the shell, and the bg job drops it) is recorded (identity.markForked) and the person told why;
//            a bare /sub-human there then opens no room (lib/seats.ts take).
// Context = the same mechanics block as join (hooks/context.ts contextBlock: the role template filled + ROWS, i.e.
// lib/rows.ts rowCalls(), which lists only the rows with no live hold: rows survive /clear and compaction, and
// a re-spawn would duplicate the room row). On --resume the hold server is new, so every row is
// listed. sessionTitle = the native address NAME.CODE (SendMessage / ListAgents reach the session by it:
// cc CONTRACT session-title-address).
// A plan-view review left behind (hooks/handlers/consent.ts; members/NAME/review.json) is closed here: after clear or
// resume always, after compact only when it is older than REVIEW_STALE_MS. The session plan file gets the
// person's own text back (lib/proposal.ts restoreStale) and the review state is cleared.
import path from 'node:path';
import * as identity from '../../lib/identity.ts';
import * as config from '../../lib/config.ts';
import { sleepSync } from '../../lib/io.ts';
import { projectDir } from '../../lib/cc/env.ts';
import * as room from '../../lib/room.ts';
import * as rows from '../../lib/rows.ts';
import * as proposal from '../../lib/proposal.ts';
import * as linkSocket from '../../lib/remote/link-socket.ts';
import * as seatKey from '../seat-key.ts';
import { whoami } from '../seat.ts';
import { contextBlock, seatTitle } from '../context.ts';
import { forkedText } from '../../lib/seats.ts';
import { out, logError } from '../reply.ts';
import * as launcher from '../launcher.ts';
import type { HookIn } from '../types.ts';
import type { Identity } from '../../lib/identity.ts';

const RECREATE = 'Your rows are not running (they do not survive a resume or the agent view). Create them now, exactly as written:\n';
const PARTIAL = 'Your other rows are still running; only the rows below are missing. Make only these calls, exactly as written:\n';

/** The lead for the ROWS section: empty when nothing is missing (rowCalls then says the rows are intact). */
function rowsLead(me: Identity): string {
  const held = rows.readHolds(me.code, me.name);
  if (!held) return RECREATE;
  return rows.rowsNeeded(me.code, me, { held }).length ? PARTIAL : '';
}

/** The seat the conversation left behind when ← moved it here (see the header), or one it held in another sub-human
 * folder (away: its SUB_HUMAN_HOME was only in the shell, which Claude Code's bg job drops), or null. */
function forkOrigin(input: HookIn<'SessionStart'>): { parent: identity.ForkParent } | { away: identity.ForkedAway } | null {
  const dir = typeof input.transcript_path === 'string' && input.transcript_path ? path.dirname(input.transcript_path) : projectDir(input.cwd);
  if (!dir || !input.session_id) return null;
  for (const until = Date.now() + config.envMs('SUB_HUMAN_FORK_WAIT_MS', config.FORK_RECORD_WAIT_MS); ; sleepSync(100)) {
    const p = identity.forkParent(input.session_id, dir);
    if (p) return { parent: p };
    const away = identity.forkedAway(input.session_id, dir);
    if (away) return { away };
    if (Date.now() >= until) return null;
  }
}

/** A fork whose seat is in another sub-human folder (stage 8e E): recorded, so a bare /sub-human here opens no room. */
let forkedAway: identity.ForkedAway | null = null;

function adopt(input: HookIn<'SessionStart'>, pid: number): Identity | null {
  const origin = forkOrigin(input);
  if (origin && 'away' in origin && input.session_id) {
    forkedAway = origin.away;
    try { identity.markForked(input.session_id, origin.away); } catch (err) { logError(err, 'session-restore: fork'); }
    return null;
  }
  const from = origin && 'parent' in origin ? origin.parent : null;
  if (!from || !input.session_id) return null;
  if (!identity.isHost(from.code) && !linkSocket.start(from.code)) return null;
  const r = identity.adoptFork(from, { pid, session_id: input.session_id, cwd: input.cwd });
  if (!r || !r.ok) return null;
  return { code: from.code, name: from.name, role: from.role, pid, session_id: input.session_id, address: identity.address(from.name, from.code) };
}

function reseat(input: HookIn<'SessionStart'>): Identity | null {
  const me = whoami(input);
  const pid = identity.claudePid();
  if (!me && input.source === 'fork') return pid ? adopt(input, pid) : null;
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
  const last: Pick<Identity, 'code' | 'name' | 'role' | 'address'> | null = identity.lastSeat(input.session_id);
  if (!last) return null;
  if (identity.roomClosing(last.code) || (last.role !== 'claude' && !identity.roomOpen(last.code))) return null;
  const hosted = identity.isHost(last.code);
  if (!hosted && !linkSocket.start(last.code)) return null;
  const r = identity.join({ code: last.code, name: last.name, role: last.role, pid, session_id: input.session_id, cwd: input.cwd });
  if (!r || !r.ok) return null;
  const pubkey = last.role === 'claude' ? undefined : seatKey.publicPem(last.code, last.name);
  const machine = identity.machineIn(last.code); // null: unreadable; the entry then names none (validate refuses null)
  if (hosted) room.open(last.code).append({ kind: 'member_joined', text: `${last.name} rejoined (resumed)`, pubkey, ...(machine ? { machine } : {}) }, { via: 'system', from: last.name, system: true });
  return { ...last, pid, session_id: input.session_id ?? null };
}

export function handle(input: HookIn<'SessionStart'>) {
  forkedAway = null;
  const me = reseat(input);
  if (!me) {
    // the person learns now why the room is gone here, and how to get it back
    if (forkedAway) out({ systemMessage: `sub-human: ${forkedText(forkedAway, input.session_id)}` });
    return;
  }
  try {
    proposal.restoreStale(me, { force: input.source === 'clear' || input.source === 'resume' || input.source === 'fork' });
  } catch (err) { logError(err, 'session-restore: review'); }
  launcher.refresh(); // the row status line's launcher and the serve shim, for this seat's rows
  const after = input.source === 'fork' ? 'the agent view' : input.source || 'start';
  const fork = input.source === 'fork';
  const text = contextBlock(me, `restored after ${after}`, { rowsLead: fork ? RECREATE : rowsLead(me), allRows: fork });
  out({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text, sessionTitle: seatTitle(me) } });
}
