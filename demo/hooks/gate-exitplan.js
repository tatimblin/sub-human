#!/usr/bin/env node
'use strict';
// PreToolUse(ExitPlanMode): the sign-off gate (plan §3.5 step 5).
// The CLI injects tool_input = {plan, planFilePath} from disk. We hash tool_input.plan and, when
// present, the bytes at planFilePath, and look for the current plan_rev with either hash.
// Deny (reason reaches the model) unless the current plan_rev matches and every human in
// $ROOM_HUMANS signed that hash via a human client.
//
// On a full matrix the consent was already given in the room, so the gate approves the call itself:
// permissionDecision:"allow" WITH updatedInput. The updatedInput matters. ExitPlanMode has
// requiresUserInteraction(), and the CLI (2.1.281) re-asks for such a tool after a hook "allow"
// unless the hook supplied updatedInput ("Hook satisfied user interaction for ExitPlanMode via
// updatedInput"). Verified live: allow alone still shows "Ready to code?"; allow + updatedInput
// exits plan mode with no dialog. ROOM_GATE_CONFIRM=1 keeps the host click (prints nothing).
//
// This hook logs nothing. kind:decision is written by decision-log.js (PostToolUse ExitPlanMode),
// which runs only if the tool actually ran, so a declined dialog never reads as a decision.
// Fails closed: any internal error denies.
const fs = require('node:fs');
const { room, run, out, deny } = require('./common.js');

const names = list => list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
const gate = (hash, missing, extra = '') =>
  deny(`ROOM-GATE: plan ${hash} lacks sign-off from ${names(missing)}. Stay in plan mode; ask ${names(missing)} by name.${extra}`);

run(input => {
  const ti = input.tool_input || {};
  const hs = room.humans();
  if (!hs.length) return deny('ROOM-GATE: ROOM_HUMANS is empty, so nobody can sign off. Stay in plan mode; ask the host to set ROOM_HUMANS.');

  const forms = [];
  if (typeof ti.plan === 'string') forms.push({ form: 'tool_input.plan', hash: room.hash12(ti.plan) });
  if (typeof ti.planFilePath === 'string' && ti.planFilePath) {
    try { forms.push({ form: 'planFilePath', hash: room.hash12(fs.readFileSync(ti.planFilePath)) }); } catch { /* unreadable */ }
  }
  let note = '';
  if (forms.length === 2 && forms[0].hash !== forms[1].hash) {
    note = ` (Note: tool_input.plan hashes to ${forms[0].hash} but the file at planFilePath hashes to ${forms[1].hash}.)`;
  }
  if (!forms.length) return deny('ROOM-GATE: no plan text or plan file reached the gate. Stay in plan mode; write the plan file under demo/.room/plans first.');

  const entries = room.readAll();
  const cur = room.currentPlan(entries);
  const matched = cur && forms.find(f => f.hash === cur.hash);
  if (!matched) {
    const shown = forms[0].hash;
    const stale = entries.some(e => e.kind === 'plan_rev' && forms.some(f => f.hash === e.plan_hash));
    const why = stale
      ? ` That hash is an older plan_rev; the current one is ${cur.hash}, and sign-offs bind to it.`
      : ` No plan_rev with that hash exists${cur ? ` (current is ${cur.hash})` : ''}; save the plan file under demo/.room/plans so the hook publishes it, then ask for sign-off.`;
    return gate(shown, hs, why + note);
  }

  const m = room.signoffMatrix(cur.hash, hs, entries);
  if (!m.complete) return gate(cur.hash, m.missing, ` (matched by ${matched.form}.)${note}`);

  if (process.env.ROOM_GATE_CONFIRM === '1') return; // fallback: the host approves the usual dialog
  out({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: `ROOM-GATE: plan ${cur.hash} signed by ${names(hs)} in the room (matched by ${matched.form}).${note}`,
      updatedInput: ti,
    },
  });
}, err => deny(`ROOM-GATE: the gate hook failed (${err.message}). Stay in plan mode and tell the host.`));
