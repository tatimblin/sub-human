#!/usr/bin/env node
'use strict';
/**
 * plugin/sub-human/hooks/consent.js: consent. A proposal opens in Claude Code's own plan-approval dialog (the
 * native, scrollable plan view: PgUp/PgDn read all of it); the AskUserQuestion card (S2) is the fallback.
 *
 * Review. The member's Claude calls EnterPlanMode, then ExitPlanMode "proposal <hash>":
 *   Pre(EnterPlanMode): a proposal is pending for me and my mode allows a review (default, acceptEdits, auto; not
 *     already plan, not bypass/dontAsk, showClearContextOnPlanAccept off): allow (no "Enter plan mode?" dialog);
 *     state review = {phase:'entering', mode}. Otherwise untouched.
 *   Pre(ExitPlanMode), phase entering: back up the session's plan file (its path from the transcript's plan_mode
 *     attachment), write the canonical text there (the dialog renders the file) and `ask`. phase 'shown'.
 *     A later ExitPlanMode (after "Tell Claude what to change"): read the rejection from the transcript, record
 *     an objection with the note byte-exact, phase 'exiting'. No path / unsafe text: phase 'exiting' + card.
 *   PermissionRequest(ExitPlanMode), phase exiting: restore the plan file and allow with setMode <mode>: no dialog,
 *     the member is back in their own mode. Only this hook ever allows without the dialog; it records nothing.
 *   Post(ExitPlanMode), phase shown: a person approved in the dialog -> signoff via=human when the text is the
 *     proposal unedited (Ctrl+G edits record nothing). Restore the plan file; if the chosen "Yes" changed the
 *     mode, phase 'restore' (EnterPlanMode + ExitPlanMode again, both silent, set it back).
 *   Stop / UserPromptSubmit: a review left open (feedback, Esc) is resolved and the model is told to exit it.
 *   Esc and "No" without text record nothing.
 * Pre(AskUserQuestion): the card, as in S2, only when the call names a proposal pending for me (or plainly asks
 *   about the only one); when the member could review it in the plan view instead, the call is redirected there.
 * Post(AskUserQuestion): drop afkTimeoutMs, followUp, no answers, stale hashes and "Not yet". Otherwise append
 *   signoff|objection via=human (notes byte-exact), then the decision when complete (lib/proposal.record).
 * Post(ExitPlanMode) for the person's own plan: offer, once per plan, to propose it to the room. Never denies.
 */

const fs = require('node:fs');
const path = require('node:path');
const c = require('./common.js');
const proposal = require(path.join(__dirname, '..', 'lib', 'proposal.js'));

const RECORDED = 'Recorded. The room shows it (and any note) already: post nothing about it. Agreeing is not a go-ahead to build; wait for the decision and your people.';
/** What was recorded, for the model; no entry ids (people never see them; a Claude repeated "#8"). */
const done = (me, label, hash, res) => `${me.name} ${label === 'Agree' ? 'agreed to' : 'objected to'} proposal ${hash}${res.decision ? `; the room decided: ${res.decision.text}` : ''}.`;

/** Pending proposals for me that the call's input names, oldest first. */
function named(pending, input) {
  const s = JSON.stringify(input || {});
  const tokens = new Set(s.match(/[0-9a-f]{6,12}/g) || []);
  return pending.filter(p => s.includes(p.hash)
    || [...tokens].some(t => p.hash.startsWith(t) && pending.filter(q => q.hash.startsWith(t)).length === 1));
}

/**
 * No hash named, but the question is plainly about a proposal ("Do you agree with the paging proposal?") and
 * exactly one is pending for me, and the input names no other hex id: that one (the model may drop the hash, as in run
 * raven-3365). An unrelated question (no "propos…") or an ambiguous one (two pending) stays untouched (S2 F9).
 */
function onlyPending(pending, input) {
  if (pending.length !== 1) return [];
  const s = JSON.stringify(input || {});
  if (!/propos/i.test(s)) return [];
  const other = (s.match(/\b[0-9a-f]{6,12}\b/g) || []).some(t => /[a-f]/.test(t) && /\d/.test(t) && !pending[0].hash.startsWith(t));
  return other ? [] : pending;
}

function pre(input, me) {
  const pending = proposal.pendingFor(me);
  let hit = named(pending, input.tool_input);
  if (!hit.length) hit = onlyPending(pending, input.tool_input);
  if (!hit.length) return;
  if (reviewable(input) && hit.every(p => proposal.viewable(p))) {
    return c.deny(`Open it in the plan view instead: call EnterPlanMode, then ExitPlanMode with plan "proposal ${hit[0].hash}". The hooks show ${me.name} the full proposal and restore the mode after.`);
  }
  c.pre('ask', `room proposal ${hit.map(p => p.hash).join(', ')}`, { updatedInput: proposal.cardFor(hit) });
}

// ---------- the review in the native plan dialog ----------
const REVIEW_MODES = ['default', 'acceptEdits', 'auto'];
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** The clear-context approve option fires no PostToolUse and starts implementing (spike 3, P3): no review then. */
function clearContextOn(cwd) {
  const home = process.env.HOME || require('node:os').homedir();
  const files = [path.join(home, '.claude', 'settings.json')];
  if (cwd) files.push(path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json'));
  return files.some(f => (readJson(f) || {}).showClearContextOnPlanAccept === true);
}
const reviewable = input => REVIEW_MODES.includes(input.permission_mode) && !clearContextOn(input.cwd);

const readReview = me => c.readState(me, 'review');
const writeReview = (me, st) => c.writeState(me, 'review', st);
const clearReview = me => c.clearState(me, 'review');

function transcriptLines(input) {
  try { return fs.readFileSync(input.transcript_path, 'utf8').split('\n'); } catch { return []; }
}

/** The session's plan file: from the input (when it exists), else the transcript's latest plan_mode attachment. */
function planFile(input) {
  const ti = input.tool_input || {};
  if (typeof ti.planFilePath === 'string' && ti.planFilePath) return ti.planFilePath;
  const lines = transcriptLines(input);
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!lines[k].includes('"plan_mode"') || !lines[k].includes('planFilePath')) continue;
    try { const a = JSON.parse(lines[k]).attachment; if (a && a.type === 'plan_mode' && a.planFilePath) return a.planFilePath; } catch { /* torn line */ }
  }
  return null;
}

/** The input the model itself gave this call (Claude Code swaps ExitPlanMode's plan for the plan file's text). */
function modelInput(input) {
  const id = input.tool_use_id;
  if (!id) return null;
  const lines = transcriptLines(input);
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!lines[k].includes(id) || !lines[k].includes('"tool_use"')) continue;
    try {
      const b = (JSON.parse(lines[k]).message.content || []).find(x => x && x.type === 'tool_use' && x.id === id);
      if (b) return b.input;
    } catch { /* torn line */ }
  }
  return null;
}

/** The person's "Tell Claude what to change" text for that dialog, from the transcript; null when none (Esc). */
function feedback(input, toolUseId) {
  if (!toolUseId) return null;
  const lines = transcriptLines(input);
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!lines[k].includes(toolUseId) || !lines[k].includes('tool_result')) continue;
    let msg;
    try { msg = JSON.parse(lines[k]).message; } catch { continue; }
    const block = (msg && Array.isArray(msg.content) ? msg.content : []).find(b => b && b.type === 'tool_result' && b.tool_use_id === toolUseId);
    if (!block) continue;
    const t = typeof block.content === 'string' ? block.content
      : (Array.isArray(block.content) ? block.content : []).filter(b => b && b.type === 'text').map(b => b.text).join('\n');
    const at = t.indexOf(SAID);
    if (!block.is_error || at < 0) return null;
    const rest = t.slice(at + SAID.length);
    const end = rest.lastIndexOf(NOTE);
    return end >= 0 ? rest.slice(0, end) : rest;
  }
  return null;
}
const SAID = 'the user said:\n';
const NOTE = '\n\nNote: The user\'s next message';

function restorePlan(st) {
  if (!st || !st.file || st.restored) return;
  try {
    if (typeof st.backup === 'string') fs.writeFileSync(st.file, st.backup);
    else fs.rmSync(st.file, { force: true });
  } catch { /* best-effort */ }
  st.restored = true;
}

/** Record an objection from the dialog's feedback, if any; returns the line for the model. */
function resolveShown(input, me, st) {
  if (st.phase !== 'shown' || st.resolved) return st.said || '';
  st.resolved = true;
  const note = feedback(input, st.tool_use_id);
  const p = proposal.pendingFor(me).find(x => x.hash === st.hash);
  if (note == null || !note.trim()) st.said = `${me.name} closed the review of proposal ${st.hash} without answering; nothing was recorded.`;
  else if (!p) st.said = `proposal ${st.hash}: nothing recorded (already answered, decided or unknown).`;
  else {
    const res = proposal.record(me, p, { choice: 'Object', notes: note });
    st.said = res.stale ? `proposal ${st.hash}: nothing recorded (already answered or decided).`
      : `${RECORDED} ${done(me, 'Object', st.hash, res)}`;
  }
  return st.said;
}

const EXIT_HOW = 'call ExitPlanMode now (no plan needed, nothing else first): a hook closes the room review without a dialog and restores the mode';

function preEnter(input, me) {
  const st = readReview(me);
  if (st && st.phase === 'restore') return c.pre('allow', 'sub-human: restoring the mode after a room review');
  const pending = proposal.pendingFor(me).filter(p => proposal.viewable(p));
  if (!pending.length || !reviewable(input)) return;
  writeReview(me, { phase: 'entering', mode: input.permission_mode, at: Date.now() });
  c.pre('allow', `sub-human: opening room proposal ${pending[0].hash} for ${me.name}`);
}

function postEnter(input, me) {
  const st = readReview(me);
  if (!st || st.phase === 'restore') return st && c.context('PostToolUse', `sub-human: ${EXIT_HOW}.`);
  if (st.phase !== 'entering') return;
  c.context('PostToolUse', `sub-human: this plan mode is only to show ${me.name} a room proposal. Call ExitPlanMode now with plan "proposal <hash>"; don't explore, plan or write. If ${me.name} answers "Tell Claude what to change", ${EXIT_HOW}.`);
}

function preExit(input, me) {
  const st = readReview(me);
  if (!st) return;
  if (st.phase === 'shown' && st.tool_use_id && st.tool_use_id === input.tool_use_id) return ask(st, me); // the same call again
  if (st.phase === 'shown') { resolveShown(input, me, st); st.phase = 'exiting'; return writeReview(me, st); }
  if (st.phase !== 'entering') { st.phase = 'exiting'; return writeReview(me, st); }
  // Only a call that names the proposal (S2 F9): the model's own input, from the transcript when the plan file
  // replaced it. A plan the model wrote for its person (plan mode entered for real work) passes through untouched.
  const pending = proposal.pendingFor(me).filter(p => proposal.viewable(p));
  const own = modelInput(input);
  const p = named(pending, [input.tool_input, own])[0] || (JSON.stringify(own || '').length < 300 ? onlyPending(pending, own)[0] : null);
  if (!p) return clearReview(me);
  const file = planFile(input);
  const text = proposal.read(me.code, p.hash);
  if (!file || text == null) {
    Object.assign(st, { phase: 'exiting', card: p.hash });
    return writeReview(me, st);
  }
  let backup = null;
  try { backup = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
  if (backup === text) backup = null; // left over from an earlier review: nothing of the person's to keep
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  Object.assign(st, { phase: 'shown', hash: p.hash, from: p.from || null, file, backup, tool_use_id: input.tool_use_id || null });
  writeReview(me, st);
  ask(st, me, text);
}

/** The dialog's "Yes" that leaves the mode as it was (any other "Yes" works too; the mode is then set back). */
const KEEP = { default: 'Yes, manually approve edits', auto: 'Yes, and use auto mode', acceptEdits: 'Yes, and auto-accept edits' };

function ask(st, me, text = proposal.read(me.code, st.hash)) {
  c.pre('ask', `room proposal ${st.hash}${st.from ? ` from ${st.from}` : ''}, for ${me.name} (PgUp/PgDn scroll). `
    + `Agree: "${KEEP[st.mode] || 'Yes'}" keeps your mode. Object: "Tell Claude what to change" + why. Esc: decide later.`,
  { updatedInput: { plan: text } });
}

function permExit(input, me) {
  const st = readReview(me);
  if (!st || st.phase !== 'exiting') return;
  restorePlan(st);
  writeReview(me, st);
  c.out({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: {},
    updatedPermissions: [{ type: 'setMode', mode: st.mode, destination: 'session' }] } } });
}

function postExit(input, me) {
  const st = readReview(me);
  if (!st) return postPlan(input, me);
  const say = t => c.context('PostToolUse', t);
  if (st.phase === 'exiting') {
    clearReview(me);
    const card = st.card ? ` The plan view could not show proposal ${st.card}: call AskUserQuestion with "proposal ${st.card}" so ${me.name} answers on the card.` : '';
    return say(`${st.said ? st.said + ' ' : ''}The room review is closed and the mode is restored; this was not a plan to carry out.${card} Return to what you were doing.`);
  }
  if (st.phase !== 'shown') return;
  // A "Yes" in the dialog: only a person can choose it (the exiting phase above is the hook's own allow).
  const r = input.tool_response && typeof input.tool_response === 'object' ? input.tool_response : {};
  const p = proposal.pendingFor(me).find(x => x.hash === st.hash);
  let line;
  if (r.planWasEdited || typeof r.plan !== 'string' || proposal.hash12(Buffer.from(r.plan, 'utf8')) !== st.hash) {
    line = `${me.name} edited proposal ${st.hash} in the review; nothing was recorded. If they want the edited text agreed, propose it.`;
  } else if (!p) line = `proposal ${st.hash}: nothing recorded (already answered, decided or unknown).`;
  else {
    const res = proposal.record(me, p, { choice: 'Agree' });
    line = res.stale ? `proposal ${st.hash}: nothing recorded (already answered or decided).`
      : `${RECORDED} ${done(me, 'Agree', st.hash, res)}`;
  }
  restorePlan(st);
  if (input.permission_mode && input.permission_mode !== st.mode) {
    Object.assign(st, { phase: 'restore', said: undefined });
    writeReview(me, st);
    return say(`${line} The dialog's "Yes" changed the mode; to restore ${me.name}'s ${st.mode} mode, call EnterPlanMode, then ExitPlanMode (both close at once, no dialog). Do not carry out the proposal.`);
  }
  clearReview(me);
  say(`${line} This was a room review, not a plan to carry out; return to what you were doing.`);
}

/** Stop: never end a turn with a review still open in plan mode (feedback given, or the restore not done). */
function stop(input, me) {
  const st = readReview(me);
  if (!st || input.stop_hook_active) return;
  const mode = input.permission_mode;
  let what;
  if (st.phase === 'restore') {
    if (mode === st.mode) return clearReview(me);
    what = mode === 'plan' ? EXIT_HOW : `call EnterPlanMode, then ExitPlanMode, to restore ${me.name}'s ${st.mode} mode (no dialogs)`;
  } else if (mode !== 'plan') return;
  else if (st.phase === 'entering') what = `call ExitPlanMode now with plan "proposal <hash>" to show ${me.name} the room proposal`;
  else {
    resolveShown(input, me, st);
    st.phase = 'exiting';
    writeReview(me, st);
    what = EXIT_HOW;
  }
  c.out({ decision: 'block', reason: `sub-human: ${me.name}'s room review is still open: ${what}.` });
}

/** UserPromptSubmit: a review left open by Esc (no hook fires then). Still in plan mode: exit it first. */
function prompt(input, me) {
  const st = readReview(me);
  if (!st) return;
  if (input.permission_mode === 'plan' && st.phase !== 'restore') {
    const said = resolveShown(input, me, st);
    st.phase = 'exiting';
    writeReview(me, st);
    return c.context('UserPromptSubmit', `sub-human: ${said ? said + ' ' : ''}Before anything else, ${EXIT_HOW}; then continue.`);
  }
  restorePlan(st);
  clearReview(me);
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
    out.push(done(me, label, hash, res));
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
  if (tool === 'EnterPlanMode' && ev === 'PreToolUse') return preEnter(input, me);
  if (tool === 'EnterPlanMode' && ev === 'PostToolUse') return postEnter(input, me);
  if (tool === 'ExitPlanMode' && ev === 'PreToolUse') return preExit(input, me);
  if (tool === 'ExitPlanMode' && ev === 'PermissionRequest') return permExit(input, me);
  if (tool === 'ExitPlanMode' && ev === 'PostToolUse') return postExit(input, me);
  if (ev === 'Stop') return stop(input, me);
  if (ev === 'UserPromptSubmit') return prompt(input, me);
}, err => { process.stderr.write(`sub-human consent: ${err && err.message || err}\n`); }); // never block a question or a plan
