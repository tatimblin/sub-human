'use strict';
/**
 * plugin/sub-human/statusline/segments.js: what the room looks like from one seat, as a short status line.
 * Shared by `sub-human statusline` (the main status line), `sub-human agent-statusline` (the participant and
 * room rows in the agent panel) and the tail's alerts.
 *
 * Entry points for bin/sub-human (each takes the parsed stdin JSON and returns the text to print, '' for none;
 * neither throws):
 *   statusline(input) -> string        `statusLine`: e.g. "⬡ marmot-2509 · orch · plan 593da0 1/2 waiting on bob"
 *       plus "⚠ rows: N missing" when the seat's rows have no live hold (lib/rows.js missingRows).
 *   agentStatusline(input) -> string   `subagentStatusLine`: one {"id","content"} JSON line per row task in
 *       input.tasks, found through the row map (lib/rows.js readRowMap), else by description (a member name or
 *       the room code). participant rows -> "alice  ✓ signed 593da0 · idle"; the room row -> "marmot-2509  plan
 *       593da0 1/2 · ⚠ your sign-off needed"; nested participant rows likewise. A killed row reads
 *       "bob  (reconnecting)" inside a room, "bob  ⚠ row stopped" at top level ("bob  left" once bob has left).
 *       Other tasks keep their default.
 *   The seat comes from input.session_id (identity.resolveBySession), else identity.resolveSelf().
 *
 *   state(me, entries) -> {code, name, role, plan, forMe, needed}
 *       me = {code, name, role} (identity.resolve*). entries = the room log (room.readAll()).
 *       plan   = null | {hash, approvers, signed, total, decided, waitingOn[], objections, approver, needMe}
 *       objections = people (anyone, approver or not) whose latest via=human signoff/objection on the hash is
 *                an objection: any of them blocks the gate.
 *       approver = the current plan's frontmatter approvers name me (the orch picks them per plan).
 *       needMe = I am an approver, not the orch, with no live signoff for that hash, and it is not decided.
 *       forMe  = entries addressed to me (to === name, from !== name) after my own last via=human entry:
 *                the ones I have not answered in the room.
 *       needed = needMe || forMe > 0
 *   render(st, {color, segments, sep}) -> string     the segments joined with " · "; empty segments dropped
 *   SEGMENTS   [{name, render(st, c) -> string|null}]  room, seat, plan, approver, mail. Add a field by adding
 *              a segment.
 *   colors(on) -> {bold, warn, ok, dim, reset}        ANSI codes, or '' each when off
 *   useColor(env) -> bool                             false when NO_COLOR is set or SUB_HUMAN_COLOR=0
 */

const ESC = '\x1b[';
function colors(on) {
  if (!on) return { bold: '', warn: '', ok: '', dim: '', reset: '' };
  return { bold: `${ESC}1m`, warn: `${ESC}1;33m`, ok: `${ESC}32m`, dim: `${ESC}2m`, reset: `${ESC}0m` };
}
const useColor = (env = process.env) => !('NO_COLOR' in env) && env.SUB_HUMAN_COLOR !== '0';

function normKind(e) {
  if (e.kind === 'concern') return 'objection';
  if (e.kind === 'agree' && e.plan_hash) return 'signoff';
  return e.kind;
}

/** One pass over the log; no extra file reads. */
function state(me, entries) {
  let plan = null, lastOwnHuman = 0;
  for (const e of entries) {
    if (e.kind === 'plan_rev' && e.plan_hash) plan = { id: e.id, hash: e.plan_hash, approvers: Array.isArray(e.approvers) ? e.approvers : [] };
    if (e.from === me.name && e.via === 'human') lastOwnHuman = e.id;
  }
  let forMe = 0;
  for (const e of entries) if (e.id > lastOwnHuman && e.to === me.name && e.from !== me.name) forMe++;
  let p = null;
  if (plan) {
    const latest = {}; // name -> 'signoff' | 'objection', anyone's latest human verdict on this hash
    let decided = false;
    for (const e of entries) {
      if (e.kind === 'decision' && e.plan_hash === plan.hash) decided = true;
      if (e.via !== 'human' || e.plan_hash !== plan.hash) continue;
      const k = normKind(e);
      if (k === 'signoff') latest[e.from] = 'signoff';
      else if (k === 'objection' || k === 'revoke') latest[e.from] = 'objection';
    }
    const waitingOn = plan.approvers.filter(n => latest[n] !== 'signoff');
    const approver = plan.approvers.includes(me.name);
    p = {
      hash: plan.hash, approvers: plan.approvers, total: plan.approvers.length,
      signed: plan.approvers.length - waitingOn.length, decided, waitingOn,
      objections: Object.keys(latest).filter(n => latest[n] === 'objection').length,
      approver, needMe: me.role !== 'orch' && !decided && approver && latest[me.name] !== 'signoff',
    };
  }
  return { code: me.code, name: me.name, role: me.role, plan: p, forMe, needed: !!(p && p.needMe) || forMe > 0 };
}

const SEGMENTS = [
  { name: 'room', render: st => `⬡ ${st.code}` },
  {
    name: 'seat',
    render: st => st.role === 'orch' ? 'orch' : st.name,
  },
  {
    name: 'plan',
    render: (st, c) => {
      const p = st.plan;
      if (!p) return null;
      if (p.needMe) return `${c.warn}⚠ your sign-off needed${c.reset} ${c.dim}(plan ${p.hash.slice(0, 6)} ${p.signed}/${p.total})${c.reset}`;
      const base = `plan ${p.hash.slice(0, 6)} ${p.signed}/${p.total}`;
      if (p.decided) return `${base} ${c.ok}✔${c.reset}`;
      const obj = p.objections ? ` ${c.warn}✖ ${p.objections} objection${p.objections > 1 ? 's' : ''}${c.reset}` : '';
      if (st.role === 'orch' && p.waitingOn.length) return `${base}${obj} waiting on ${p.waitingOn.join(',')}`;
      return base + obj;
    },
  },
  {
    // Approvers change per plan, so say whether this one counts on me. Non-approvers see nothing extra.
    name: 'approver',
    render: st => st.plan && st.plan.approver && !st.plan.needMe && st.role !== 'orch' ? 'approver' : null,
  },
  {
    name: 'mail',
    render: (st, c) => st.forMe > 0 ? `${c.warn}✉ ${st.forMe} for you${c.reset}` : null,
  },
  {
    // Filled in by statusline() (lib/rows.js missingRows); absent in plain state().
    name: 'rows',
    render: (st, c) => st.rowsMissing && st.rowsMissing.length ? `${c.warn}⚠ rows: ${st.rowsMissing.length} missing${c.reset}` : null,
  },
];

function render(st, { color = false, segments = SEGMENTS, sep = ' · ' } = {}) {
  const c = colors(color);
  return segments.map(s => s.render(st, c)).filter(Boolean).join(sep);
}

// ---------- entry points (bin/sub-human statusline | agent-statusline) ----------
const path = require('node:path');
const LIB = path.join(__dirname, '..', 'lib');
const lazy = name => require(path.join(LIB, name));

function seatOf(input) {
  const identity = lazy('identity.js');
  let me = null;
  try { if (input && typeof input.session_id === 'string') me = identity.resolveBySession(input.session_id); } catch { me = null; }
  if (!me) { try { me = identity.resolveSelf(); } catch { me = null; } }
  return me && me.code ? me : null;
}

function statusline(input = {}, { env = process.env } = {}) {
  try {
    const me = seatOf(input);
    if (!me) return '';
    const rows = lazy('rows.js');
    const st = state(me, rows.readLog(me.code));
    try { st.rowsMissing = rows.missingRows(me.code, me); } catch { st.rowsMissing = []; }
    return render(st, { color: useColor(env) });
  } catch { return ''; }
}

function agentStatusline(input = {}, { env = process.env } = {}) {
  try {
    const tasks = Array.isArray(input && input.tasks) ? input.tasks : [];
    if (!tasks.length) return '';
    const me = seatOf(input);
    if (!me) return '';
    const rows = lazy('rows.js');
    const identity = lazy('identity.js');
    const map = rows.readRowMap(me.code);
    const members = identity.readMembers(me.code) || {};
    const entries = rows.readLog(me.code);
    const color = useColor(env);
    const out = [];
    for (const t of tasks) {
      if (!t || typeof t.id !== 'string') continue;
      let rec = map[t.id];
      if (!rec) {
        const d = String(t.description || '').trim();
        if (d === me.code) rec = { kind: 'room', name: d };
        else if (members[d] && d !== me.name) rec = { kind: 'participant', name: d, parent: null };
        else continue;
      }
      let content;
      if (rec.kind === 'room') {
        content = t.status === 'killed' || t.status === 'failed'
          ? rows.rowLine(rec.name, '⚠ room row stopped')
          : rows.rowLine(rec.name, rows.rowText(me.code, me.code, me.name, { entries, members, color }));
      } else if ((t.status === 'killed' || t.status === 'failed') && members[rec.name] && !members[rec.name].left_at) {
        content = rows.rowLine(rec.name, rec.parent ? '(reconnecting)' : '⚠ row stopped');
      } else {
        content = rows.rowLine(rec.name, rows.rowText(me.code, rec.name, me.name, { entries, members, color }));
      }
      out.push(JSON.stringify({ id: t.id, content }));
    }
    return out.join('\n');
  } catch { return ''; }
}

module.exports = { state, render, SEGMENTS, colors, useColor, statusline, agentStatusline, seatOf };
