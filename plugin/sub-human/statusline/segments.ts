/**
 * plugin/sub-human/statusline/segments.ts: the participant and room rows in the agent panel
 * (`sub-human agent-statusline`, through <home>/bin/row-status: the subagentStatusLine a person may add to their own
 * settings, README "Rows"; the plugin sets none). There is no main status line.
 *
 *   agentStatusline(input, {env}?) -> string   one {"id","content"} JSON line per row task in input.tasks, found
 *       through the row map (lib/rows.ts readRowMap), else by description (a member name or the room code).
 *       participant rows -> "alice  ✓ agreed 3fa2c1 · ◼ #2 parser tests"; the room row -> "vole-8126  ⚠ your
 *       answer needed 3fa2c1 · tasks 3 open · #2 you"; nested participant rows likewise (lib/rows.ts rowText).
 *       In a room hosted elsewhere the room row also shows the link (lib/room/link-state.ts): "vole-8126  ✕ offline
 *       2m · 2 queued · 2 here", "… connecting (3) · …", or "… · ⇄ online" at the end while it is online.
 *       A killed row reads "bob  (reconnecting)" inside a room, "bob  ⚠ row stopped" at top level ("bob  left"
 *       once bob has left). Other tasks keep their default. '' when not in a room; never throws.
 *   The seat comes from input.session_id (identity.resolveBySession), else identity.resolveSelf().
 *   Colour is off when NO_COLOR is set.
 */
import * as identity from '../lib/identity.ts';
import * as rows from '../lib/rows.ts';
import type { Members } from '../lib/room/types.ts';
import type { Identity } from '../lib/identity.ts';

/** One task of the subagentStatusLine input (Claude Code's agent panel), as read here (untrusted). */
interface PanelTask { id?: unknown; status?: unknown; description?: unknown }
/** The subagentStatusLine stdin, parsed. */
interface StatuslineIn { session_id?: unknown; tasks?: unknown }
/** A row's record in the row map (lib/rows.ts readRowMap), or one found by description. */

const useColor = (env: NodeJS.ProcessEnv = process.env) => !('NO_COLOR' in env);
const dead = (t: PanelTask) => t.status === 'killed' || t.status === 'failed';

function seatOf(input: StatuslineIn | null | undefined): Identity | null {
  let me: Identity | null = null;
  try { if (input && typeof input.session_id === 'string') me = identity.resolveBySession(input.session_id); } catch { me = null; }
  if (!me) { try { me = identity.resolveSelf(); } catch { me = null; } }
  return me && me.code ? me : null;
}

// Claude Code's panel tasks (its own input; each read checks what it uses)
const isTasks = (v: unknown): v is (PanelTask | null)[] => Array.isArray(v);

function agentStatusline(input: StatuslineIn | null = {}, { env = process.env }: { env?: NodeJS.ProcessEnv } = {}): string {
  try {
    const list = input && input.tasks;
    const tasks = isTasks(list) ? list : [];
    if (!tasks.length) return '';
    // a session that left keeps labelling its rows (they end a moment later): with nothing from here Claude Code shows
    // the row agent's own activity ("Spawning participant row for bob": stage 8e I.7)
    let me = seatOf(input);
    let left = false;
    if (!me) {
      const sid = input && typeof input.session_id === 'string' ? input.session_id : null;
      const last = sid !== null ? identity.lastSeat(sid) : null;
      if (!last) return '';
      me = { ...last, pid: null, session_id: sid };
      left = true;
    }
    const members: Members = identity.readMembers(me.code) || {};
    const map = rows.readRowMap(me.code);
    const opts = { entries: rows.readLog(me.code), members, color: useColor(env) };
    const out: string[] = [];
    for (const t of tasks) {
      if (!t || typeof t.id !== 'string') continue;
      let rec = map[t.id];
      if (!rec) {
        const d = String(t.description || '').trim();
        if (d === me.code) rec = { kind: 'room', name: d };
        else if (members[d] && d !== me.name && d !== 'claude') rec = { kind: 'participant', name: d, parent: null };
        else continue;
      }
      let content: string;
      if (rec.kind === 'room') {
        content = rows.rowLine(rec.name, left ? 'you left · /sub-human joins again' : dead(t) ? '⚠ room row stopped' : rows.rowText(me.code, { viewer: me.name, ...opts }));
      } else if (dead(t) && members[rec.name] && !members[rec.name]?.left_at) {
        content = rows.rowLine(rec.name, rec.parent ? '(reconnecting)' : '⚠ row stopped');
      } else {
        content = rows.rowLine(rec.name, identity.isSeatName(rec.name) ? rows.rowText(me.code, { member: rec.name, viewer: me.name, ...opts }) : 'not in the room');
      }
      out.push(JSON.stringify({ id: t.id, content }));
    }
    return out.join('\n');
  } catch { return ''; }
}

export { agentStatusline, seatOf };
