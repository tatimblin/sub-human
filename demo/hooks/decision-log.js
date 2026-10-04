#!/usr/bin/env node
'use strict';
// PostToolUse(ExitPlanMode): log kind:decision once plan mode has actually been exited (fix B1).
// PostToolUse runs only after the tool ran, i.e. after the gate's auto-approval or the host's click;
// a declined dialog never reaches it (verified live on 2.1.281), so the log can't claim a decision
// that didn't happen.
//
// Payload (observed live): tool_input may be {} here; the plan is in tool_response
// {plan, isAgent, filePath}. We hash tool_response.plan, the bytes at tool_response.filePath and any
// tool_input.plan, and look for the current plan_rev.
//   - matched and every human signed  -> kind:decision with plan_hash and refs = the sign-off ids
//   - anything else (unsigned, edited in the dialog, stale) -> kind:status saying plan mode was
//     exited on a plan the room did not sign, so the digest never lists it as a decision.
// Main thread only; one decision per plan_rev. Never blocks (PostToolUse cannot undo the call).
const fs = require('node:fs');
const { room, run, asOrch } = require('./common.js');

const names = list => list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;

run(input => {
  if (input.agent_id) return;
  asOrch();
  const ti = input.tool_input || {};
  const tr = input.tool_response && typeof input.tool_response === 'object' ? input.tool_response : {};
  const forms = [];
  const add = (form, data) => { if (data != null) forms.push({ form, hash: room.hash12(data) }); };
  if (typeof tr.plan === 'string') add('tool_response.plan', tr.plan);
  if (typeof ti.plan === 'string') add('tool_input.plan', ti.plan);
  for (const p of [tr.filePath, ti.planFilePath]) {
    if (typeof p === 'string' && p) { try { add('plan file', fs.readFileSync(p)); } catch { /* unreadable */ } }
  }

  const entries = room.readAll();
  const cur = room.currentPlan(entries);
  const matched = cur && forms.find(f => f.hash === cur.hash);
  const hs = room.humans();
  const m = matched ? room.signoffMatrix(cur.hash, hs, entries) : null;

  if (matched && hs.length && m.complete) {
    if (entries.some(e => e.kind === 'decision' && e.plan_hash === cur.hash && e.id > cur.id)) return;
    room.append({
      kind: 'decision',
      text: `Plan mode exited on plan ${cur.hash}, signed by ${names(hs)} (matched by ${matched.form}).`,
      refs: hs.map(h => m.signed[h]),
      plan_hash: cur.hash,
    }, { via: 'agent' });
    return;
  }
  const shown = forms.length ? forms[0].hash : 'unknown';
  const why = !cur ? 'no plan_rev exists'
    : !matched ? `it does not match the current plan_rev ${cur.hash}`
    : `it lacks sign-off from ${names(m.missing.length ? m.missing : ['(ROOM_HUMANS is empty)'])}`;
  room.append({ kind: 'status', text: `Plan mode exited on plan ${shown}, but ${why}. Not a room decision.` }, { via: 'agent' });
});
