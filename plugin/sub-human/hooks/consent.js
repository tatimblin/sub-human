#!/usr/bin/env node
'use strict';
/**
 * plugin/sub-human/hooks/consent.js: the consent card (S2). Routed for PreToolUse(AskUserQuestion) and
 * PostToolUse(AskUserQuestion|ExitPlanMode).
 *
 * Pre(AskUserQuestion): only when the call's input names a proposal pending for me (its hash, or a unique
 *   prefix of at least 6 hex), rewrite the call into the card: `ask` + updatedInput (Not yet / Agree / Object).
 *   Any other AskUserQuestion passes through untouched (S2 F9: an unrelated question was hijacked).
 * Post(AskUserQuestion): drop afkTimeoutMs, followUp, no answers, stale hashes and "Not yet". Otherwise append
 *   signoff|objection via=human (notes byte-exact), then the decision when complete (lib/proposal.record).
 *   The model's own answers never count: the card's answers come from the UI.
 * Post(ExitPlanMode): offer, once per plan, to propose it to the room. Never denies.
 */

const path = require('node:path');
const c = require('./common.js');
const proposal = require(path.join(__dirname, '..', 'lib', 'proposal.js'));

const RECORDED = 'Recorded. Agreeing is not a go-ahead to build; wait for the decision and your people.';

/** Pending proposals for me that the call's input names, oldest first. */
function named(pending, input) {
  const s = JSON.stringify(input || {});
  const tokens = new Set(s.match(/[0-9a-f]{6,12}/g) || []);
  return pending.filter(p => s.includes(p.hash)
    || [...tokens].some(t => p.hash.startsWith(t) && pending.filter(q => q.hash.startsWith(t)).length === 1));
}

function pre(input, me) {
  const hit = named(proposal.pendingFor(me), input.tool_input);
  if (!hit.length) return;
  c.pre('ask', `room proposal ${hit.map(p => p.hash).join(', ')}`, { updatedInput: proposal.cardFor(hit) });
}

function postAsk(input, me) {
  const r = input.tool_response && typeof input.tool_response === 'object' ? input.tool_response : {};
  const answers = r.answers && typeof r.answers === 'object' ? r.answers : null;
  const asked = [...(Array.isArray(r.questions) ? r.questions : []), ...((input.tool_input && input.tool_input.questions) || [])]
    .map(q => q && q.question).filter(q => proposal.QUESTION_RE.test(String(q)));
  const keys = answers ? Object.keys(answers).filter(k => proposal.QUESTION_RE.test(k)) : [];
  if (!keys.length && !asked.length) return; // not a consent card
  const say = t => c.context('PostToolUse', t);
  if (r.afkTimeoutMs || r.followUp || !keys.length) {
    return say(`Nothing was recorded: the card closed without ${me.name}'s answer. Reopening it later is fine; return to what you were doing.`);
  }
  const pending = proposal.pendingFor(me);
  const out = [];
  let recorded = false;
  for (const k of keys) {
    const hash = k.match(proposal.QUESTION_RE)[1];
    const label = String(answers[k]);
    const p = pending.find(x => x.hash === hash);
    if (!p) { out.push(`proposal ${hash}: nothing recorded (already answered, decided or unknown).`); continue; }
    if (label === 'Not yet') { out.push(`proposal ${hash}: ${me.name} has not decided; nothing was recorded. Do not ask again unless ${me.name} asks.`); continue; }
    if (label !== 'Agree' && label !== 'Object') { out.push(`proposal ${hash}: no Agree/Object answer; nothing was recorded.`); continue; }
    const notes = r.annotations && r.annotations[k] ? r.annotations[k].notes : undefined;
    const res = proposal.record(me, p, { choice: label, notes });
    if (res.stale) { out.push(`proposal ${hash}: nothing recorded (already answered or decided).`); continue; }
    recorded = true;
    out.push(`#${res.entry.id} ${me.name} ${label === 'Agree' ? 'agreed to' : 'objected to'} proposal ${hash}${res.decision ? `; decision #${res.decision.id}: ${res.decision.text}` : ''}.`);
  }
  say([recorded ? RECORDED : null, ...out, 'Return to what you were doing.'].filter(Boolean).join(' '));
}

function postPlan(input, me) {
  const r = input.tool_response && typeof input.tool_response === 'object' ? input.tool_response : {};
  if (r.isAgent || typeof r.plan !== 'string' || !r.plan.trim()) return;
  const hash = proposal.hash12(Buffer.from(r.plan, 'utf8'));
  if (proposal.proposals(c.room.readAll()).some(p => p.hash === hash)) return; // already proposed
  const where = r.filePath ? `{path: ${JSON.stringify(r.filePath)}}` : '{text: <the plan>}';
  c.context('PostToolUse', `sub-human: if ${me.name} wants the room to agree to this plan, call the room propose tool with ${where}. Only on ${me.name}'s word; planning is optional.`);
}

c.run(input => {
  const me = c.whoami(input);
  if (!me) return;
  const ev = input.hook_event_name, tool = input.tool_name;
  if (tool === 'AskUserQuestion' && ev === 'PreToolUse') return pre(input, me);
  if (tool === 'AskUserQuestion' && ev === 'PostToolUse') return postAsk(input, me);
  if (tool === 'ExitPlanMode' && ev === 'PostToolUse') return postPlan(input, me);
}, err => { process.stderr.write(`sub-human consent: ${err && err.message || err}\n`); }); // never block a question or a plan
