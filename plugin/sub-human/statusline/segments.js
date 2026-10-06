'use strict';
/**
 * plugin/sub-human/statusline/segments.js: the participant and room rows in the agent panel
 * (`sub-human agent-statusline`, Claude Code's subagentStatusLine). The main status line is gone (Phase 2).
 *
 *   agentStatusline(input, {env}?) -> string   one {"id","content"} JSON line per row task in input.tasks, found
 *       through the row map (lib/rows.js readRowMap), else by description (a member name or the room code).
 *       participant rows -> "alice  ✓ agreed 3fa2c1 · ◼ #2 parser tests"; the room row -> "vole-8126  ⚠ your
 *       answer needed 3fa2c1 · tasks 3 open · #2 you"; nested participant rows likewise (lib/rows.js rowText).
 *       A killed row reads "bob  (reconnecting)" inside a room, "bob  ⚠ row stopped" at top level ("bob  left"
 *       once bob has left). Other tasks keep their default. '' when not in a room; never throws.
 *   The seat comes from input.session_id (identity.resolveBySession), else identity.resolveSelf().
 *   useColor(env) -> bool   false when NO_COLOR is set or SUB_HUMAN_COLOR=0
 */
const path = require('node:path');
const LIB = path.join(__dirname, '..', 'lib');
const lazy = name => require(path.join(LIB, name));

const useColor = (env = process.env) => !('NO_COLOR' in env) && env.SUB_HUMAN_COLOR !== '0';
const dead = t => t.status === 'killed' || t.status === 'failed';

function seatOf(input) {
  const identity = lazy('identity.js');
  let me = null;
  try { if (input && typeof input.session_id === 'string') me = identity.resolveBySession(input.session_id); } catch { me = null; }
  if (!me) { try { me = identity.resolveSelf(); } catch { me = null; } }
  return me && me.code ? me : null;
}

function agentStatusline(input = {}, { env = process.env } = {}) {
  try {
    const tasks = Array.isArray(input && input.tasks) ? input.tasks : [];
    if (!tasks.length) return '';
    const me = seatOf(input);
    if (!me) return '';
    const rows = lazy('rows.js');
    const members = lazy('identity.js').readMembers(me.code) || {};
    const map = rows.readRowMap(me.code);
    const opts = { entries: rows.readLog(me.code), members, color: useColor(env) };
    const out = [];
    for (const t of tasks) {
      if (!t || typeof t.id !== 'string') continue;
      let rec = map[t.id];
      if (!rec) {
        const d = String(t.description || '').trim();
        if (d === me.code) rec = { kind: 'room', name: d };
        else if (members[d] && d !== me.name && d !== 'orch') rec = { kind: 'participant', name: d, parent: null };
        else continue;
      }
      let content;
      if (rec.kind === 'room') {
        content = rows.rowLine(rec.name, dead(t) ? '⚠ room row stopped' : rows.rowText(me.code, me.code, me.name, opts));
      } else if (dead(t) && members[rec.name] && !members[rec.name].left_at) {
        content = rows.rowLine(rec.name, rec.parent ? '(reconnecting)' : '⚠ row stopped');
      } else {
        content = rows.rowLine(rec.name, rows.rowText(me.code, rec.name, me.name, opts));
      }
      out.push(JSON.stringify({ id: t.id, content }));
    }
    return out.join('\n');
  } catch { return ''; }
}

module.exports = { agentStatusline, useColor, seatOf };
