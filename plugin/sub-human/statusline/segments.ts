/**
 * plugin/sub-human/statusline/segments.ts: the participant and room rows in the agent panel
 * (`sub-human agent-statusline`, Claude Code's subagentStatusLine). There is no main status line.
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
 *   Colour is off when NO_COLOR is set or SUB_HUMAN_COLOR=0.
 */
import path from 'node:path';
const LIB = path.join(import.meta.dirname, '..', 'lib');
import * as identity from '../lib/identity.ts';
import * as rows from '../lib/rows.ts';
import type { MemberRec, Seat } from '../hooks/types.ts';

/** One task of the subagentStatusLine input (Claude Code's agent panel), as read here (untrusted). */
interface PanelTask { id?: unknown; status?: unknown; description?: unknown }
/** The subagentStatusLine stdin, parsed. */
interface StatuslineIn { session_id?: unknown; tasks?: unknown }
/** A row's record in the row map (lib/rows.ts readRowMap), or one found by description. */
interface RowRec { kind: string; name: string; parent?: string | null }

const useColor = (env: NodeJS.ProcessEnv = process.env) => !('NO_COLOR' in env) && env.SUB_HUMAN_COLOR !== '0';
const dead = (t: PanelTask) => t.status === 'killed' || t.status === 'failed';

function seatOf(input: StatuslineIn | null | undefined): Seat | null {
  let me: Seat | null = null;
  try { if (input && typeof input.session_id === 'string') me = identity.resolveBySession(input.session_id); } catch { me = null; }
  if (!me) { try { me = identity.resolveSelf(); } catch { me = null; } }
  return me && me.code ? me : null;
}

function agentStatusline(input: StatuslineIn | null = {}, { env = process.env } = {}): string {
  try {
    const list = input && input.tasks;
    const tasks: (PanelTask | null)[] = Array.isArray(list) ? list : [];
    if (!tasks.length) return '';
    const me = seatOf(input);
    if (!me) return '';
    const members: Record<string, MemberRec | undefined> = identity.readMembers(me.code) || {};
    const map: Record<string, RowRec | undefined> = rows.readRowMap(me.code);
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
        content = rows.rowLine(rec.name, dead(t) ? '⚠ room row stopped' : rows.rowText(me.code, me.code, me.name, opts));
      } else if (dead(t) && members[rec.name] && !members[rec.name]!.left_at) {
        content = rows.rowLine(rec.name, rec.parent ? '(reconnecting)' : '⚠ row stopped');
      } else {
        content = rows.rowLine(rec.name, rows.rowText(me.code, rec.name, me.name, opts));
      }
      out.push(JSON.stringify({ id: t.id, content }));
    }
    return out.join('\n');
  } catch { return ''; }
}

export { agentStatusline, seatOf };
