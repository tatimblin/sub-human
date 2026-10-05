#!/usr/bin/env node
'use strict';
// PreToolUse(ExitPlanMode): the room's plan gate. ORCHESTRATOR ONLY; for anyone else (a member planning
// their own work, or a session not in a room) the hook says nothing and ExitPlanMode behaves as usual.
//
// The canonical plan is the file at tool_input.planFilePath (else tool_input.plan). It must carry
// `sub-human: {"room":CODE,"approval":"all","approvers":[…]}` frontmatter with approvers = the
// orchestrator's choice (non-empty, every name a joined, not-left member, never orch; the gate does not
// add anyone), and its body must start with plan.PLAN_NOTICE. The gate never rewrites the orch's bytes.
// A new hash (or approver list) is stored and published as plan_rev (via system); each approver's room
// server then pushes the sign-off form (mcp/signoff.js). Deny while ANY human in the room (approver or
// not) has an objection standing on that hash (their latest via=human signoff or objection on it wins),
// and, naming the missing approvers, until every approver signed it; then allow WITH updatedInput, which
// is what skips the dialog. Fails closed.
const fs = require('node:fs');
const { room, plan, pre, deny, run, names, whoami, activeMembers, members, readState, writeState } = require('./common.js');

const FM_HELP = code => `The plan file must start with:\n---\nsub-human: {"room":"${code}","approval":"all","approvers":[…the members you chose…]}\n---\n${plan.PLAN_NOTICE}`;

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
  if (!plan.hasNotice(text)) return deny(`ROOM-GATE: the plan must start, right after the frontmatter, with this exact line (it tells anyone reading the plan how sign-off works):\n${plan.PLAN_NOTICE}\nAdd it as the first body line and call ExitPlanMode again. Stay in plan mode.`);
  const approvers = Array.isArray(fm.approvers) ? fm.approvers.map(String) : [];
  if (!approvers.length) return deny('ROOM-GATE: "approvers" is empty. Choose who must sign off: anyone who asked to approve, contributed substantively, or owns part of the work. If nobody has joined yet, wait; stay in plan mode.');
  if (approvers.includes('orch')) return deny('ROOM-GATE: remove "orch" from "approvers": the orchestrator never signs off. Stay in plan mode.');
  const all = members(me.code);
  const left = new Set(all.filter(m => m.role !== 'orch' && m.left_at).map(m => m.name));
  const active = new Set(activeMembers(me.code));
  const gone = approvers.filter(n => left.has(n) && !active.has(n));
  if (gone.length) return deny(`ROOM-GATE: ${names(gone)} left the room; remove them from "approvers". Stay in plan mode.`);
  const unknown = approvers.filter(n => !active.has(n));
  if (unknown.length) return deny(`ROOM-GATE: ${names(unknown)} never joined this room; remove them from "approvers". Stay in plan mode.`);

  const hash = plan.hash12(text);
  const cur = room.currentPlan();
  let published = '';
  if (!cur || cur.hash !== hash || JSON.stringify(cur.approvers || []) !== JSON.stringify(approvers)) {
    plan.storeCanonical(me.code, Buffer.from(text, 'utf8'));
    const e = room.append({ kind: 'plan_rev', text: `plan ${hash}. ${whoApproves(me.code, approvers)}`, plan_hash: hash, approvers }, { via: 'system', from: me.name, system: true });
    published = ` Published as plan_rev #${e.id}${cur && cur.hash !== hash ? ` (replaces ${cur.hash}; earlier sign-offs no longer count)` : ''}.`;
  }
  const blocking = objections(hash);
  if (blocking.length) {
    const list = blocking.map(e => `${e.from} (#${e.id})`).join(', ');
    return deny(`ROOM-GATE: plan ${hash} is blocked by an objection from ${list}. Any human in the room can block a plan. Read it, revise the plan to address it (a new hash clears it) or ask them in the room; stay in plan mode.${published}`);
  }
  const m = room.signoffMatrix(hash, approvers);
  if (!m.complete) {
    noticeOnce(me, hash, m.missing, approvers);
    return deny(`ROOM-GATE: plan ${hash} lacks sign-off from ${names(m.missing)}. The sign-off form is already in their terminals; don't ask or post, end your turn and wait to be woken. Stay in plan mode.${published}`);
  }
  pre('allow', `ROOM-GATE: plan ${hash} signed by ${names(approvers)} in room ${me.code}.`, { updatedInput: ti });
}

/** "Approvers: …" plus, when some joined members are not approvers, the line telling them how to join in or block. */
function whoApproves(code, approvers) {
  const others = activeMembers(code).filter(n => !approvers.includes(n));
  const line = `Approvers: ${names(approvers)}.`;
  return others.length ? `${line}\nNot approvers: ${names(others)}. Anyone can say they want to approve, or object to block.` : line;
}

/** Human objections standing on this hash, from anyone in the room: per person, their latest via=human
 *  signoff or objection on the hash wins (an approve after an objection withdraws it). */
function objections(hash) {
  const latest = new Map();
  for (const raw of room.readAll()) {
    const e = room.normalize(raw);
    if (e.via !== 'human' || e.plan_hash !== hash) continue;
    if (e.kind === 'objection' || e.kind === 'signoff') latest.set(e.from, e);
  }
  return [...latest.values()].filter(e => e.kind === 'objection');
}

/** Tell the room (via system, so no model has to post from plan mode) once per (hash, missing set). */
function noticeOnce(me, hash, missing, approvers) {
  const key = { hash, missing: [...missing].sort() };
  const last = readState(me, 'gate_notice');
  if (last && JSON.stringify(last) === JSON.stringify(key)) return;
  room.append({ kind: 'status', to: 'room', text: `plan ${hash} is waiting for sign-off from ${names(missing)}. ${whoApproves(me.code, approvers)}` }, { via: 'system', from: me.name, system: true });
  writeState(me, 'gate_notice', key);
}

run(input => {
  const me = whoami(input);
  if (!me) return;
  const ti = input.tool_input || {};
  if (me.role === 'orch') return orch(me, ti);
}, err => deny(`ROOM-GATE: the gate hook failed (${err.message}). Stay in plan mode and tell the host.`));
