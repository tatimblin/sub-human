#!/usr/bin/env node
'use strict';
/**
 * plugin/sub-human/hooks/consent.js: consent. A proposal opens in Claude Code's own plan-approval dialog (the
 * native, scrollable plan view: PgUp/PgDn read all of it); the AskUserQuestion card is the fallback.
 *
 * The review phases (review.json, every read-modify-write under proposal.withReview):
 *   Pre(EnterPlanMode): a proposal is pending for me and my mode allows a review: allow silently; 'entering'.
 *   Pre(ExitPlanMode), entering: the proposal the call names (polled from the transcript up to EXIT_INPUT_WAIT_MS:
 *     the hook can run before the call's line is written), else the only pending one. Back up the plan file into
 *     review.json BEFORE writing the canonical text there (a crash loses nothing), then `ask`; 'shown'.
 *     A later ExitPlanMode with feedback records an objection, note byte-exact; 'exiting'.
 *   PermissionRequest(ExitPlanMode), exiting: restore the plan file, allow with setMode (no dialog); records nothing.
 *   Post(ExitPlanMode), shown: signoff via=human only for the proposal unedited; restore the file and the mode.
 *   Stop / UserPromptSubmit / Pre(room tools): a review left open is resolved and the model told to exit it.
 * Pre/Post(AskUserQuestion): the card fallback; "Not yet", AFK, stale hashes record nothing. Post(ExitPlanMode)
 * for the person's own plan offers to propose it. Run with SUB_HUMAN_SHIM=1 (mod/consent.mjs) the output also
 * carries subHuman {reviewOpen}. Outside plan mode the room-tool entry exits before loading anything else.
 */

const { readInput } = require('../lib/io.js');

/** A room tool call outside plan mode: preRoomTool acts only in plan mode, so nothing else needs loading. */
const quiet = input => !!input && input.hook_event_name === 'PreToolUse' && input.permission_mode !== 'plan'
  && /^mcp__plugin_sub-human_room__/.test(String(input.tool_name || ''));

/** Run as a hook: the stdin payload (or the error reading it), read before the rest of the file loads. */
let entry = null;
if (require.main === module) {
  try { entry = { input: readInput() }; } catch (err) { entry = { error: err }; }
  if (quiet(entry.input)) process.exit(0);
}

const fs = require('node:fs');
const path = require('node:path');
const c = require('./common.js');
const proposal = require(path.join(__dirname, '..', 'lib', 'proposal.js'));
const cc = require(path.join(__dirname, '..', 'lib', 'cc.js'));
const { writeFileAtomic } = require(path.join(__dirname, '..', 'lib', 'io.js'));
const config = require(path.join(__dirname, '..', 'lib', 'config.js'));
const { TRANSCRIPT_TAIL_BYTES } = config;

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
 * raven-3365). An unrelated question (no "propos…") or an ambiguous one (two pending) stays untouched: a question about something else must not become a consent card.
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
  if (reviewable(input) && hit.every(p => proposal.viewable(p, me.code))) {
    return c.deny(`Open it in the plan view instead: call EnterPlanMode, then ExitPlanMode with plan "proposal ${hit[0].hash}". The hooks show ${me.name} the full proposal and restore the mode after.`);
  }
  c.pre('ask', `room proposal ${hit.map(p => p.hash).join(', ')}`, { updatedInput: proposal.cardFor(hit, me.code) });
}

// ---------- the review in the native plan dialog ----------
const REVIEW_MODES = ['default', 'acceptEdits', 'auto'];

/** The clear-context approve option fires no PostToolUse and starts implementing: no review then. */
const reviewable = input => REVIEW_MODES.includes(input.permission_mode) && !cc.clearContextOnPlanAccept(input.cwd);

// review.json (lib/proposal.js); every handler that reads and writes it runs under proposal.withReview.
const readReview = me => proposal.readReview(me);
const writeReview = (me, st) => proposal.writeReview(me, st);
const clearReview = me => proposal.clearReview(me);
const restorePlan = st => proposal.restorePlan(st);

/** The transcript's lines, read once per hook run (the tail: the review is always recent). */
function lines(input) {
  if (!input._lines) input._lines = cc.readLines(input.transcript_path, { tailBytes: TRANSCRIPT_TAIL_BYTES });
  return input._lines;
}
/** The session's plan file: from the input (when it exists), else the transcript's latest plan_mode attachment. */
const planFile = input => cc.planFile(lines(input), input.tool_input);
/** The input the model itself gave this call (Claude Code swaps ExitPlanMode's plan for the plan file's text). */
const modelInput = input => cc.toolUseInput(lines(input), input.tool_use_id);
/** modelInput, polling the transcript until the call's line is there (or EXIT_INPUT_WAIT_MS passed); null then. */
function modelInputWait(input) {
  const until = Date.now() + config.envMs('SUB_HUMAN_EXIT_INPUT_WAIT_MS', config.EXIT_INPUT_WAIT_MS);
  for (;;) {
    const own = modelInput(input);
    if (own || !input.tool_use_id || Date.now() >= until) return own;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, config.EXIT_INPUT_POLL_MS);
    input._lines = null; // read the tail again
  }
}
const blank = v => v == null || (typeof v === 'string' && !v.trim());
/** The person's "Tell Claude what to change" note for that dialog (structured userFeedback first); null when none (Esc). */
const feedback = (input, toolUseId) => cc.planFeedback(lines(input), toolUseId);

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
  const pending = proposal.pendingFor(me).filter(p => proposal.viewable(p, me.code));
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
  // Only a call that names the proposal (a plan the person asked for must never be swapped for one): the model's own input, from the transcript when the plan file
  // replaced it. A plan the model wrote for its person (plan mode entered for real work) passes through untouched.
  const pending = proposal.pendingFor(me).filter(p => proposal.viewable(p, me.code));
  const own = modelInputWait(input);
  const plan = input.tool_input && input.tool_input.plan;
  // The call names nothing we can see (no transcript line in time and a blank plan): plan mode was entered for
  // this review (phase entering), so it is the only pending proposal. A plan of the person's own has text.
  const unseen = !own && blank(plan) && pending.length === 1 ? pending : [];
  const p = named(pending, [input.tool_input, own])[0] || (JSON.stringify(own || '').length < 300 ? onlyPending(pending, own)[0] : null) || unseen[0];
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
  // The backup is on disk (atomically) BEFORE the plan file is overwritten: a crash in between loses nothing,
  // and session-restore puts a stale one back.
  Object.assign(st, { hash: p.hash, from: p.from || null, file, backup, restored: false, tool_use_id: input.tool_use_id || null });
  writeReview(me, st);
  try { writeFileAtomic(file, text); } catch (err) {
    c.logError(err, 'consent: plan file');
    restorePlan(st);
    Object.assign(st, { phase: 'exiting', card: p.hash });
    return writeReview(me, st);
  }
  st.phase = 'shown';
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

/**
 * Stop: never end a turn with a review still open in plan mode (feedback given, or the restore not done). The
 * turn goes on through Stop additionalContext, not a block: a block renders as a red "Stop hook error" line
 * (cc CONTRACT stop-additional-context). stop_hook_active bounds it to once.
 */
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
  c.context('Stop', `sub-human: ${me.name}'s room review is still open: ${what}.`);
}

/**
 * Pre(room tool) while a review is still open in plan mode: after "Tell Claude what to change" no hook fires (a
 * rejected call has no PostToolUse), and a Claude may post the person's note itself (run heron-0084). Record the
 * objection now, deny the call, and tell it to exit first.
 */
function preRoomTool(input, me) {
  const st = readReview(me);
  if (!st || input.permission_mode !== 'plan' || !['shown', 'exiting'].includes(st.phase)) return;
  const said = resolveShown(input, me, st);
  st.phase = 'exiting';
  writeReview(me, st);
  c.deny(`sub-human: ${said ? said + ' ' : ''}Post nothing about the review. First ${EXIT_HOW}; then return to what you were doing.`);
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
  if (proposal.proposals(c.room.open(me.code).readAll()).some(p => p.hash === hash)) return; // already proposed
  const where = r.filePath ? `{path: ${JSON.stringify(r.filePath)}}` : '{text: <the plan>}';
  c.context('PostToolUse', `sub-human: if ${me.name} wants the room to agree to this plan, call the room propose tool with ${where}. Only on ${me.name}'s word; planning is optional.`);
}

/** Every event consent handles, for one hook input. */
function dispatch(input) {
  const me = c.whoami(input);
  if (!me) return;
  const ev = input.hook_event_name, tool = input.tool_name;
  if (tool === 'AskUserQuestion' && ev === 'PreToolUse') return pre(input, me);
  if (tool === 'AskUserQuestion' && ev === 'PostToolUse') return postAsk(input, me);
  const locked = fn => proposal.withReview(me, () => fn(input, me));
  if (tool === 'EnterPlanMode' && ev === 'PreToolUse') return locked(preEnter);
  if (tool === 'EnterPlanMode' && ev === 'PostToolUse') return postEnter(input, me); // reads only
  if (tool === 'ExitPlanMode' && ev === 'PreToolUse') return locked(preExit);
  if (tool === 'ExitPlanMode' && ev === 'PermissionRequest') return locked(permExit);
  if (tool === 'ExitPlanMode' && ev === 'PostToolUse') return locked(postExit);
  if (/^mcp__plugin_sub-human_room__/.test(tool || '') && ev === 'PreToolUse') return locked(preRoomTool);
  if (ev === 'Stop') return locked(stop);
  if (ev === 'UserPromptSubmit') return locked(prompt);
}

/** The UserPromptSubmit handler (hooks/prompt.js runs it after at-room.js's, in one process). */
const onPrompt = input => dispatch({ ...input, hook_event_name: 'UserPromptSubmit' });

/** True when this session's seat has a room review on record (review.json); false with no seat. */
function reviewOpen(input) {
  const me = c.whoami(input);
  return !!(me && readReview(me));
}

/**
 * Shim mode (SUB_HUMAN_SHIM=1: the hooks module ran this hook, mod/consent.mjs): the one output also carries
 * subHuman {reviewOpen}, so the mod knows whether the next turn end needs consent at all. Printed even when the
 * handler had nothing to say; an error leaves it out (the mod then stays unsure).
 */
function shimDispatch(input) {
  const r = c.capture(() => dispatch(input));
  if (r.error) throw r.error;
  const outputs = r.outputs.filter(Boolean);
  const last = outputs.pop() || {};
  for (const o of outputs) process.stdout.write(JSON.stringify(o) + '\n');
  c.out({ ...last, subHuman: { reviewOpen: reviewOpen(input) } });
}

const SHIM = () => process.env.SUB_HUMAN_SHIM === '1';

module.exports = { dispatch, onPrompt, reviewOpen, SHIM, quiet };

// the error is logged; never block a question or a plan
if (entry) {
  try {
    if (entry.error) throw entry.error;
    (SHIM() ? shimDispatch : dispatch)(entry.input);
  } catch (err) { c.logError(err); }
}
