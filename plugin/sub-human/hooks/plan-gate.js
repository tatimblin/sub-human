#!/usr/bin/env node
'use strict';
// PreToolUse(ExitPlanMode): the room's plan gate. Ported from demo/hooks/gate-exitplan.js and
// plan-publish.js.
//
// ORCHESTRATOR: the canonical plan is the file at tool_input.planFilePath (else tool_input.plan).
//   It must carry `sub-human: {"room":CODE,"approval":"all","approvers":[…]}` frontmatter with
//   approvers ⊇ every joined, not-left member. A new hash is stored and published as plan_rev
//   (via system). Deny naming the missing approvers until every approver signed that hash; then
//   allow WITH updatedInput, which is what skips the dialog (spike 2). Fails closed.
//
// MEMBER: a plan without sub-human frontmatter is the member's own and passes through. A room
//   stub/review: overwrite the plan file with the canonical bytes of the current plan (the dialog
//   renders the file from disk), return ask + updatedInput, and remember pending_review so
//   plan-result / stop-feedback can log the human's verdict. Denied while
//   showClearContextOnPlanAccept is on: that path fires no PostToolUse and implements at once.
const fs = require('node:fs');
const { room, plan, pre, deny, run, names, whoami, activeMembers, members, writePending, readState, writeState, clearContextOnAccept } = require('./common.js');

const FM_HELP = code => `The plan file must start with:\n---\nsub-human: {"room":"${code}","approval":"all","approvers":[…every member…]}\n---`;

function planText(ti) {
  if (typeof ti.planFilePath === 'string' && ti.planFilePath) {
    try { return fs.readFileSync(ti.planFilePath, 'utf8'); } catch { /* fall back */ }
  }
  return typeof ti.plan === 'string' ? ti.plan : null;
}

function orch(me, ti) {
  const text = planText(ti);
  if (text == null) return deny(`ROOM-GATE: no plan text or plan file reached the gate. Write the plan file first. ${FM_HELP(me.code)}`);
  const fm = plan.parseFrontmatter(text);
  if (!fm) return deny(`ROOM-GATE: the plan has no sub-human frontmatter. ${FM_HELP(me.code)}`);
  if (fm.room !== me.code) return deny(`ROOM-GATE: the plan's frontmatter names room ${JSON.stringify(fm.room)}, but this room is ${me.code}. ${FM_HELP(me.code)}`);
  if (fm.approval !== 'all') return deny(`ROOM-GATE: the frontmatter must say "approval":"all". ${FM_HELP(me.code)}`);
  const approvers = Array.isArray(fm.approvers) ? fm.approvers.map(String) : [];
  const known = new Set(members(me.code).filter(m => m.role !== 'orch').map(m => m.name));
  const required = activeMembers(me.code);
  const lacking = required.filter(n => !approvers.includes(n));
  if (lacking.length) return deny(`ROOM-GATE: approvers must include every joined member; add ${names(lacking)} to "approvers". Stay in plan mode.`);
  const unknown = approvers.filter(n => !known.has(n));
  if (unknown.length) return deny(`ROOM-GATE: ${names(unknown)} never joined this room; remove them from "approvers". Stay in plan mode.`);
  if (!approvers.length) return deny('ROOM-GATE: nobody has joined the room yet, so nobody can approve. Wait for members to join; stay in plan mode.');

  const hash = plan.hash12(text);
  const cur = room.currentPlan();
  let published = '';
  if (!cur || cur.hash !== hash || JSON.stringify(cur.approvers || []) !== JSON.stringify(approvers)) {
    plan.storeCanonical(me.code, Buffer.from(text, 'utf8'));
    const e = room.append({ kind: 'plan_rev', text: `plan ${hash}`, plan_hash: hash, approvers }, { via: 'system', from: me.name, system: true });
    published = ` Published as plan_rev #${e.id}${cur && cur.hash !== hash ? ` (replaces ${cur.hash}; earlier sign-offs no longer count)` : ''}.`;
  }
  const m = room.signoffMatrix(hash, approvers);
  if (!m.complete) {
    noticeOnce(me, hash, m.missing);
    return deny(`ROOM-GATE: plan ${hash} lacks sign-off from ${names(m.missing)}. Ask them by name; stay in plan mode.${published}`);
  }
  pre('allow', `ROOM-GATE: plan ${hash} signed by ${names(approvers)} in room ${me.code}.`, { updatedInput: ti });
}

/** Tell the room (via system, so no model has to post from plan mode) once per (hash, missing set). */
function noticeOnce(me, hash, missing) {
  const key = { hash, missing: [...missing].sort() };
  const last = readState(me, 'gate_notice');
  if (last && JSON.stringify(last) === JSON.stringify(key)) return;
  room.append({ kind: 'status', to: 'room', text: `plan ${hash} is waiting for sign-off from ${names(missing)}` }, { via: 'system', from: me.name, system: true });
  writeState(me, 'gate_notice', key);
}

function member(me, ti, input) {
  const text = planText(ti);
  const fm = text == null ? null : plan.parseFrontmatter(text);
  if (!fm) return; // the member's own local plan: not ours
  if (fm.room && fm.room !== me.code) return deny(`ROOM-REVIEW: this plan names room ${fm.room}, but you are ${me.name} in room ${me.code}.`);
  if (clearContextOnAccept(input.cwd)) {
    return deny('ROOM-REVIEW: turn off clear-context-on-accept to review room plans: set "showClearContextOnPlanAccept": false in your Claude Code settings (that approval path records nothing and starts implementing immediately). Then call ExitPlanMode again.');
  }
  const cur = room.currentPlan();
  if (!cur) return deny(`ROOM-REVIEW: nothing to review; room ${me.code} has no plan yet. Wait for the orchestrator to publish one.`);
  const bytes = plan.canonical(me.code, cur.hash);
  if (!bytes) return deny(`ROOM-REVIEW: the stored text of plan ${cur.hash} is missing from room ${me.code}; ask the orchestrator to re-publish.`);
  const canonical = bytes.toString('utf8');
  if (typeof ti.planFilePath === 'string' && ti.planFilePath) fs.writeFileSync(ti.planFilePath, canonical);
  writePending(me, { hash: cur.hash, pid: me.pid, tool_use_id: input.tool_use_id || null, ts: new Date().toISOString() });
  const stale = fm.review && fm.review !== cur.hash ? ` (you asked for ${fm.review}; the current plan is ${cur.hash})` : '';
  pre('ask', `ROOM-REVIEW: ${me.name}, this is room ${me.code}'s plan ${cur.hash}${stale}. Approve to sign off; edit it or tell Claude what to change to object.`,
    { updatedInput: { ...ti, plan: canonical } });
}

run(input => {
  const me = whoami(input);
  if (!me) return;
  const ti = input.tool_input || {};
  if (me.role === 'orch') return orch(me, ti);
  return member(me, ti, input);
}, err => deny(`ROOM-GATE: the gate hook failed (${err.message}). Stay in plan mode and tell the host.`));
