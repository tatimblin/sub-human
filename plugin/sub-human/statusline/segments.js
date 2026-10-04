'use strict';
/**
 * plugin/sub-human/statusline/segments.js: what the room looks like from one seat, as a short status line.
 * Shared by `sub-human statusline` (the main status line), `sub-human agent-statusline` (the room agent's
 * row in the agent panel) and the tail's alerts (lib/room.js does the reading; this file only derives).
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
];

function render(st, { color = false, segments = SEGMENTS, sep = ' · ' } = {}) {
  const c = colors(color);
  return segments.map(s => s.render(st, c)).filter(Boolean).join(sep);
}

module.exports = { state, render, SEGMENTS, colors, useColor };
