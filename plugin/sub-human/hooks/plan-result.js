#!/usr/bin/env node
'use strict';
// PostToolUse(ExitPlanMode): record what actually happened after the plan dialog. Ported from
// demo/hooks/decision-log.js. PostToolUse runs only when the tool ran (approved), never on a decline.
//
// ORCHESTRATOR: if the exited plan is the current plan_rev and every approver signed it, log
//   `decision` (via system, refs = the sign-off ids), at most once per hash. Otherwise log a status.
// MEMBER (only with pending_review): tool_input is {} here, so hash tool_response.plan.
//   Unedited and matching -> signoff (via human). Edited (planWasEdited===true) or a mismatch ->
//   store the edit and log an objection (via human). In bypassPermissions/dontAsk no human saw the
//   dialog, so refuse the sign-off. Always tell the Claude not to implement the room plan.
const fs = require('node:fs');
const path = require('node:path');
const { identity, room, plan, run, context, names, whoami, readPending, clearPending, stamp } = require('./common.js');

function exitedText(input) {
  const ti = input.tool_input || {};
  const tr = input.tool_response && typeof input.tool_response === 'object' ? input.tool_response : {};
  if (typeof tr.plan === 'string') return tr.plan;
  if (typeof ti.plan === 'string') return ti.plan;
  for (const p of [tr.filePath, ti.planFilePath]) {
    if (typeof p === 'string' && p) { try { return fs.readFileSync(p, 'utf8'); } catch { /* unreadable */ } }
  }
  return null;
}

function orch(me, input) {
  const text = exitedText(input);
  const hash = text == null ? null : plan.hash12(text);
  const cur = room.currentPlan();
  const approvers = cur ? (cur.approvers || []) : [];
  const m = cur && hash === cur.hash ? room.signoffMatrix(cur.hash, approvers) : null;
  if (m && m.complete && approvers.length) {
    if (room.decided(cur.hash)) return;
    room.append({
      kind: 'decision',
      text: `Plan mode exited on plan ${cur.hash}, signed by ${names(approvers)}.`,
      plan_hash: cur.hash,
      refs: approvers.map(n => m.signed[n]),
    }, { via: 'system', from: me.name, system: true });
    return;
  }
  const why = !cur ? 'no plan_rev exists'
    : hash !== cur.hash ? `it does not match the current plan_rev ${cur.hash}`
    : `it lacks sign-off from ${names(m.missing)}`;
  room.append({ kind: 'status', text: `Plan mode exited on plan ${hash || 'unknown'}, but ${why}. Not a room decision.` }, { via: 'system', from: me.name, system: true });
}

function member(me, input) {
  const pending = readPending(me);
  if (!pending || !pending.hash) return;
  clearPending(me);
  const h = pending.hash;
  const tr = input.tool_response && typeof input.tool_response === 'object' ? input.tool_response : {};
  const dont = 'Do NOT implement this plan; wait for an assignment from the room.';

  if (input.permission_mode === 'bypassPermissions' || input.permission_mode === 'dontAsk') {
    const e = room.append({
      kind: 'status',
      text: `${me.name}'s review of plan ${h} was not recorded: the session runs in ${input.permission_mode} mode, so no human saw the plan. ${me.name} should review again in default mode.`,
    }, { via: 'system', from: me.name, system: true });
    return context('PostToolUse', `REFUSED ${me.name}'s sign-off on room plan ${h} (#${e.id}): ${input.permission_mode} mode approves without a human. Ask ${me.name} to switch to default mode (Shift+Tab) and review again. ${dont}`);
  }

  const text = exitedText(input);
  const got = text == null ? null : plan.hash12(text);
  if (got === h && tr.planWasEdited !== true) {
    const e = room.append({ kind: 'signoff', text: `${me.name} approved plan ${h}`, plan_hash: h }, { via: 'human', from: me.name });
    return context('PostToolUse', `Recorded ${me.name}'s sign-off on room plan ${h} (#${e.id}). ${dont}`);
  }

  const dir = path.join(identity.roomDir(me.code), 'plans', 'edits');
  fs.mkdirSync(dir, { recursive: true });
  const editPath = path.join(dir, `${me.name}-${stamp()}.md`);
  fs.writeFileSync(editPath, text == null ? '' : text);
  let summary = '';
  try { summary = String(plan.editSummary(plan.canonical(me.code, h) || '', text || '') || ''); } catch { summary = ''; }
  const e = room.append({
    kind: 'objection',
    text: `${me.name} edited plan ${h} in the approval dialog${summary ? `: ${summary}` : ''}`,
    plan_hash: h,
    edit_path: editPath,
  }, { via: 'human', from: me.name });
  context('PostToolUse', `Recorded ${me.name}'s objection on room plan ${h} (#${e.id}); the edited plan is at ${editPath}. ${dont}`);
}

run(input => {
  const me = whoami(input);
  if (!me) return;
  if (me.role === 'orch') return orch(me, input);
  return member(me, input);
});
