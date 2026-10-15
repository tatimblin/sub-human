#!/usr/bin/env node
/**
 * plugin/sub-human/hooks/consent.ts: consent. A proposal opens in Claude Code's own plan-approval dialog (the
 * native, scrollable plan view: PgUp/PgDn read all of it); the AskUserQuestion card is the fallback.
 *
 * The review phases (review.json, every read-modify-write under proposal.withReview). The hooks pick the proposal
 * and own the dialog's text; the model only calls EnterPlanMode, then ExitPlanMode (whatever plan it passes):
 *   Pre(EnterPlanMode): a proposal is pending for me and my mode allows a review: allow silently; 'entering' with
 *     hash = the person's pick (lib/proposal.ts choose: what their latest prompt in the transcript names, a hash or
 *     words only its title / text has, "Open v3"; cc.lastHumanPrompt, the person's own words only), else the
 *     newest. When the plan file is known already, back it up and write the proposal text there (showEarly; again
 *     at Post(EnterPlanMode)). A latest prompt that asks to propose something (proposal.proposeIntent, "propose to
 *     alice: …") and names no pending proposal's hash opens no review: plan mode is left alone and the model told so.
 *   Pre(ExitPlanMode), entering: always `ask` with updatedInput.plan = that proposal's text, whatever the call
 *     carries, the text in the plan file (backup into review.json BEFORE the overwrite); 'shown'. A plan of the
 *     model's own is never shown in a room review: it comes back on close and the model is told. A blank plan:
 *     the call's transcript line is waited for (EXIT_INPUT_WAIT_MS) to tell the two apart.
 *     A later ExitPlanMode with feedback ("Tell Claude what to change", or a Remote Control deny with a note, or a
 *     phone message typed after a bare deny: Claude Code attaches it to the deny) records nothing by itself: the note
 *     waits (members/NAME/confirm) for the confirm card, "Send to <proposer> as changes requested on <title>: <note>?"
 *     (Send / Discard), which the model opens with AskUserQuestion; 'exiting'. A deny with no note records nothing.
 *   PermissionRequest(ExitPlanMode), exiting: restore the plan file, allow with setMode (no dialog); records nothing.
 *   Post(ExitPlanMode), shown: signoff via=human only for the proposal unedited; restore the file and the mode. A
 *     dialog no hook opened (the model wrote the text itself) records nothing, and the model is told.
 *   Stop / UserPromptSubmit / Pre(room tools): a review left open is resolved and the model told to exit it.
 * Pre/Post(AskUserQuestion), the handoff card (lib/handoff.ts): while the room's host asks this seat to host the room,
 * a card call that names the handoff shows the hooks' card ("Host room CODE on this machine?": the room's Claude then runs on
 * this person's model account, this machine must stay reachable); only the person's "Host it here" on the card as
 * built moves the room (handoff.accept, signed with the seat key), "Not now" refuses it, anything else records
 * nothing.
 * Pre/Post(AskUserQuestion), a join request's card (lib/remote/admission.ts), on the host: while a machine that typed this
 * person's short code waits, a card call that names it ("admit REF") shows the hooks' card ("Let carol (SHA256:…) on
 * carols-mbp join room CODE?"); only the person's "Let in" on the card as built admits it (signed with the seat key),
 * "Refuse" ends it, anything else records nothing.
 * Pre/Post(AskUserQuestion): the confirm card for a waiting note (only the person's Send on the card as built records
 * the objection with the note, byte-exact; Discard drops it; AFK or no answer keeps it), else the card fallback;
 * "Not yet", AFK, stale hashes record nothing. Stop nudges once when a waiting note's card was never shown; a card shown
 * and interrupted (no Post), or still not shown after the nudge, is offered again once, at the next prompt (reoffer),
 * with the tail's reminder for it saying the same (lib/proposal.ts showConfirm: an Esc is no answer); an interrupted
 * one the model still does not show that turn, once more at its Stop (renudge). An answer is
 * lib/proposal.ts answer, then decide (a no-op on a machine that does not hold the room; its host decides). A review
 * or card opens only for a proposal pendingFor lists (another seat of the same person answering closes it); an answer
 * given on one already open records against answerableFor (that seat's own answer only), and counts for the person. An
 * answer the room refuses (OFFLINE, AUTH) is never lost silently: a systemMessage tells the person, the context
 * the model. Post(ExitPlanMode) for the person's own plan offers to propose it; when it is, unedited, a pending
 * proposal of their own, their approval is their signoff (via=human). Run with SUB_HUMAN_SHIM=1
 * (mod/consent.ts) the output also carries subHuman {reviewOpen}. Outside plan mode the room-tool entry exits
 * before loading anything else.
 */

import { createRequire } from 'node:module';
import { readInput } from '../lib/io.ts';
import type { AnyHookIn, CardQuestion, HookOutput, Recorded } from './types.ts';
import type { Card, Confirm, HandoffAskDoc, Proposal, Review } from '../lib/types-app.ts';
import type { Identity } from '../lib/identity.ts';

/** The tool call's input, as far as consent reads it (untrusted: each field checked). */
interface ConsentToolInput { plan?: unknown; questions?: CardQuestion[]; planFilePath?: unknown }
/** AskUserQuestion's or ExitPlanMode's response, as far as consent reads it. */
interface ToolResponse {
  questions?: CardQuestion[];
  answers?: Record<string, unknown>;
  annotations?: Record<string, { notes?: string } | undefined>;
  afkTimeoutMs?: unknown;
  followUp?: unknown;
  plan?: unknown;
  planWasEdited?: unknown;
  isAgent?: unknown;
  filePath?: unknown;
}
/** Every event consent handles (PreToolUse, PostToolUse, PermissionRequest, Stop, UserPromptSubmit), with the
 * transcript's lines once read (lines()). */
type ConsentIn = Omit<AnyHookIn, 'tool_input'> & { tool_input?: ConsentToolInput; _lines?: string[] | null };
/** One question of a card the hooks built. */
type CardSpec = Card['questions'][number];
/** A short code's join request waiting on the host (lib/remote/admission.ts pending). */
type JoinRequest = ReturnType<typeof import('../lib/remote/admission.ts')['pending']>[number];

// The rest of this file's modules load only past the quiet exit below, so they are required (createRequire:
// require(esm) is synchronous and caches like an import), not imported: a static import would load them first.
const require = createRequire(import.meta.url);

/** A room tool call outside plan mode: preRoomTool acts only in plan mode, so nothing else needs loading. */
const quiet = (input: AnyHookIn | undefined) => !!input && input.hook_event_name === 'PreToolUse' && input.permission_mode !== 'plan'
  && /^mcp__plugin_sub-human_room__/.test(String(input.tool_name || ''));

/** Run as a hook: the stdin payload (or the error reading it), read before the rest of the file loads. */
let entry: { input?: ConsentIn; error?: unknown } | null = null;
if (import.meta.main) {
  try { entry = { input: readInput() }; } catch (err) { entry = { error: err }; }
  if (quiet(entry.input)) process.exit(0);
}

const fs: typeof import('node:fs') = require('node:fs');
const c: typeof import('./common.ts') = require('./common.ts');
const proposal: typeof import('../lib/proposal.ts') = require('../lib/proposal.ts');
const cc: typeof import('../lib/cc.ts') = require('../lib/cc.ts');
const { writeFileAtomic }: typeof import('../lib/io.ts') = require('../lib/io.ts');
const config: typeof import('../lib/config.ts') = require('../lib/config.ts');
const { TRANSCRIPT_TAIL_BYTES } = config;
const handoff: typeof import('../lib/handoff.ts') = require('../lib/handoff.ts');
const envelope: typeof import('../lib/room/envelope.ts') = require('../lib/room/envelope.ts');
const roomStore: typeof import('../lib/room/store.ts') = require('../lib/room/store.ts');

const RECORDED = 'Recorded. The room shows it (and any note) already: post nothing about it. Agreeing is not a go-ahead to build; wait for the decision and your people.';
/** Answers this run could not record, for the person (dispatch puts them in the output's systemMessage). */
let unsent: string[] = [];

/**
 * The person's answer, then the decision when it completes the proposal (host only: lib/proposal.ts decide).
 * A RoomError (the link to the host is down: OFFLINE) is {failed}, and the person is told: nothing is queued. One
 * whose outcome is unknown (sent over a slow link, no answer in time) is {failed, unknown}: it may still land.
 */
function record(me: Identity, p: Proposal, a: { choice: string; notes?: string }): Recorded {
  let res: ReturnType<typeof proposal.answer>;
  try { res = proposal.answer(me, p, a); } catch (err) {
    if (!(err instanceof c.room.RoomError)) throw err;
    const what = `your ${a.choice === 'Agree' ? 'agreement to' : 'objection to'} proposal ${p.hash}`;
    unsent.push(err.unknown // it went out and may still land: answering again is safe (one answer per person per proposal)
      ? `⧗ ${what} is not confirmed: ${err.message}. If the proposal still shows you unanswered, answer again: that is safe.`
      : `✗ ${what} was not recorded: ${err.message}. Answer again once the room is reachable.`);
    return { failed: err.message, ...(err.unknown ? { unknown: true } : {}) };
  }
  return res.stale ? res : { ...res, decision: proposal.decide(me.code, p.hash) };
}

/** For the model: the answer did not reach the room, and the person was told. */
const failed = (me: Identity, hash: string, res: Recorded) => `proposal ${hash}: NOT ${res.unknown ? 'confirmed, it may still be recorded' : 'recorded'} (${res.failed}); ${me.name} has been told. Post nothing for them; open it again when ${me.name} asks.`;

/** What was recorded, for the model; no entry ids (people never see them; a Claude repeated "#8"). */
const done = (me: Identity, label: string, hash: string, res: Recorded) => `${me.name} ${label === 'Agree' ? 'agreed to' : 'objected to'} proposal ${hash}${res.decision ? `; the room decided: ${res.decision.text}` : ''}.`;

/** Pending proposals for me that the call's input names, oldest first. */
function named(pending: Proposal[], input: unknown): Proposal[] {
  const s = JSON.stringify(input || {});
  const tokens = new Set(s.match(/[0-9a-f]{6,12}/g) || []);
  return pending.filter(p => s.includes(p.hash)
    || [...tokens].some(t => p.hash.startsWith(t) && pending.filter(q => q.hash.startsWith(t)).length === 1));
}

/**
 * No hash named, but the question is plainly about a proposal ("Do you agree with the paging proposal?") and
 * exactly one is pending for me, and the input names no other hex id: that one (the model may drop the hash, as in
 * run raven-3365). An unrelated question (no "propos…") or an ambiguous one (two pending) stays untouched: a
 * question about something else must not become a consent card.
 */
function onlyPending(pending: Proposal[], input: unknown): Proposal[] {
  if (pending.length !== 1) return [];
  const s = JSON.stringify(input || {});
  if (!/propos/i.test(s)) return [];
  const other = (s.match(/\b[0-9a-f]{6,12}\b/g) || []).some(t => /[a-f]/.test(t) && /\d/.test(t) && !pending[0].hash.startsWith(t));
  return other ? [] : pending;
}

/**
 * A note waiting for the person's Send, when this card call is about it: it names the note's proposal (a hash or a
 * unique prefix), or carries the confirm question. Null otherwise; a note whose proposal is no longer pending is
 * dropped.
 */
function waitingNote(me: Identity, input: ConsentToolInput | undefined): { cf: Confirm; p: Proposal } | null {
  const cf: Confirm | null = proposal.readConfirm(me);
  if (!cf) return null;
  const p = answerableFor(me).find(x => x.hash === cf.hash);
  if (!p) { proposal.clearConfirm(me); return null; }
  const s = JSON.stringify(input || {});
  const tokens = s.match(/[0-9a-f]{6,12}/g) || [];
  const q = proposal.confirmQuestion(cf);
  const qs = input && input.questions;
  const asks = Array.isArray(qs) && qs.some(x => x && x.question === q);
  return asks || tokens.some(t => cf.hash.startsWith(t)) ? { cf, p } : null;
}

/** The handoff waiting for me, when this card call is about it (it says "handoff", or carries the card's question). */
function handoffAsked(me: Identity, input: unknown): HandoffAskDoc | null {
  const a: HandoffAskDoc | null = handoff.pendingAsk(me.code, me.name);
  if (!a) return null;
  const s = JSON.stringify(input || {});
  return /handoff/i.test(s) || s.includes(handoff.question(a, me.code)) ? a : null;
}

/** A short code's join request waiting for me on the host, when this card call is about it (it names its ref, or
 * carries the card's question, or says "admit" while exactly one waits). */
function admitAsked(me: Identity, input: unknown): JoinRequest | null {
  if (!c.identity.isHost(me.code)) return null;
  const s = JSON.stringify(input || {});
  if (!/admit|join/i.test(s)) return null;
  const reqs: JoinRequest[] = admission().pending(me.code).filter((q: JoinRequest) => admission().targets(me.code, q).includes(me.name));
  const named = reqs.filter(q => s.includes(q.ref) || s.includes(admission().question(q, me.code)) || (s.match(/\b[0-9a-f]{6,12}\b/g) || []).some(t => q.ref.startsWith(t)));
  if (named.length) return named[0];
  return /\badmit\b/i.test(s) && reqs.length === 1 ? reqs[0] : null;
}
const admission = (): typeof import('../lib/remote/admission.ts') => require('../lib/remote/admission.ts');

function pre(input: ConsentIn, me: Identity) {
  const ad = admitAsked(me, input.tool_input);
  if (ad) return c.pre('ask', `room ${me.code}: ${ad.name} asks to join`, { updatedInput: admission().card(ad, me.code) });
  const ho = handoffAsked(me, input.tool_input);
  if (ho) return c.pre('ask', `room ${me.code}: ${ho.from} asks ${me.name} to host it`, { updatedInput: handoff.card(ho, me.code) });
  const waiting = waitingNote(me, input.tool_input);
  if (waiting) {
    proposal.writeConfirm(me, { ...waiting.cf, asked: Date.now() });
    return c.pre('ask', `room proposal ${waiting.cf.hash}: ${me.name}'s note, to send or discard`, { updatedInput: proposal.confirmCard(waiting.cf) });
  }
  const pending = pendingFor(me);
  let hit = named(pending, input.tool_input);
  if (!hit.length) hit = onlyPending(pending, input.tool_input);
  if (!hit.length) return;
  if (reviewable(input) && hit.every(p => proposal.viewable(p, me.code))) {
    proposal.choose(me, hit, hit[0].hash); // the review opens the one this call named
    return c.deny(`Open it in the plan view instead: call EnterPlanMode, then ExitPlanMode with plan "proposal ${hit[0].hash}". The hooks show ${me.name} the full proposal and restore the mode after.`);
  }
  c.pre('ask', `room proposal ${hit.map(p => p.hash).join(', ')}`, { updatedInput: proposal.cardFor(hit, me.code) });
}

// ---------- the review in the native plan dialog ----------
const REVIEW_MODES = ['default', 'acceptEdits', 'auto'];

/** The clear-context approve option fires no PostToolUse and starts implementing: no review then. */
const reviewable = (input: ConsentIn) => REVIEW_MODES.includes(String(input.permission_mode)) && !cc.clearContextOnPlanAccept(input.cwd);

// review.json (lib/proposal.ts); every handler that reads and writes it runs under proposal.withReview.
const readReview = (me: Identity): Review | null => proposal.readReview(me);
const writeReview = (me: Identity, st: Review) => proposal.writeReview(me, st);
const clearReview = (me: Identity) => proposal.clearReview(me);
const restorePlan = (st: Review | null) => proposal.restorePlan(st);
/** The proposals pending for me (lib/proposal.ts pendingFor): what opens a review or a card. */
const pendingFor = (me: Identity): Proposal[] => proposal.pendingFor(me);
/** The proposals my own seat may still answer (lib/proposal.ts answerableFor): what an answer already given on an
 * open review or card records against, even when another seat of my person answered meanwhile. */
const answerableFor = (me: Identity): Proposal[] => proposal.answerableFor(me);

/** The transcript's lines, read once per hook run (the tail: the review is always recent). */
function lines(input: ConsentIn): string[] {
  if (!input._lines) input._lines = cc.readLines(input.transcript_path, { tailBytes: TRANSCRIPT_TAIL_BYTES });
  return input._lines;
}
/** The session's plan file: from the input (when it exists), else the transcript's latest plan_mode attachment. */
const planFile = (input: ConsentIn): string | null => cc.planFile(lines(input), input.tool_input);
/** The input the model itself gave this call (Claude Code swaps ExitPlanMode's plan for the plan file's text). */
const modelInput = (input: ConsentIn): { plan?: unknown } | null => {
  const v = cc.toolUseInput(lines(input), input.tool_use_id);
  return v && typeof v === 'object' ? v : null; // a tool_use's input is an object
};
/** modelInput, polling the transcript until the call's line is there (or EXIT_INPUT_WAIT_MS passed); null then. */
function modelInputWait(input: ConsentIn) {
  const until = Date.now() + config.envMs('SUB_HUMAN_EXIT_INPUT_WAIT_MS', config.EXIT_INPUT_WAIT_MS);
  for (;;) {
    const own = modelInput(input);
    if (own || !input.tool_use_id || Date.now() >= until) return own;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, config.EXIT_INPUT_POLL_MS);
    input._lines = null; // read the tail again
  }
}
const blank = (v: unknown) => v == null || (typeof v === 'string' && !v.trim());
/** The person's "Tell Claude what to change" note for that dialog (structured userFeedback first); null when none (Esc). */
const feedback = (input: ConsentIn, toolUseId: string | null | undefined): string | null => cc.planFeedback(lines(input), toolUseId);

/** How the model shows the person the confirm card for a waiting note (lib/proposal.ts). */
const { confirmCall } = proposal;

/**
 * The dialog closed: a note never counts on its own. "Tell Claude what to change", a phone deny with a note and a
 * phone message typed after a bare deny all reach the transcript alike, so the note waits (proposal confirm) for the
 * person's Send on the confirm card; returns the line for the model.
 */
function resolveShown(input: ConsentIn, me: Identity, st: Review): string {
  if (st.phase !== 'shown' || st.resolved) return st.said || '';
  st.resolved = true;
  const note = feedback(input, st.tool_use_id);
  const p = answerableFor(me).find(x => x.hash === st.hash);
  if (note == null || !note.trim()) st.said = `${me.name} closed the review of proposal ${st.hash} without answering; nothing was recorded.`;
  else if (!p) st.said = `proposal ${st.hash}: nothing recorded (already answered, decided or unknown).`;
  else {
    proposal.writeConfirm(me, { hash: p.hash, note, from: p.from || null, title: proposal.title(me.code, p.hash) || null, at: Date.now() });
    st.said = `${me.name} closed the review of proposal ${st.hash} with a note; nothing is recorded yet. Once the review is closed, ${confirmCall(p.hash)}: the hooks show ${me.name} a card to send the note as their objection or discard it. Don't post the note or answer for ${me.name}.`;
  }
  return st.said;
}

const EXIT_HOW = 'call ExitPlanMode now (no plan needed, nothing else first): a hook closes the room review without a dialog and restores the mode';

function preEnter(input: ConsentIn, me: Identity) {
  const old = readReview(me);
  if (old && old.phase === 'restore') return c.pre('allow', 'sub-human: restoring the mode after a room review');
  const pending = pendingFor(me).filter(p => proposal.viewable(p, me.code));
  if (!pending.length || !reviewable(input)) return;
  restorePlan(old); // a review left behind: its backup goes back before a new one is taken
  // The person's pick, else the newest: never the model's choice. The pick is what the person's latest prompt names
  // (cc.lastHumanPrompt: only their own words; a peer's or a plugin's prompt keeps the earlier pick), unless a pick
  // made after that prompt (a card call naming one) stands.
  const said: { text: string; at: number } | null = cc.lastHumanPrompt(lines(input));
  // The person asked their Claude to propose something: that is not a review. Plan mode is left alone (a plan of
  // the model's own may become the proposal); the pending one waits for a prompt that asks for it, or a plain one.
  // Its words may share a pending title's ("propose to alice: ship v3 Tuesday"): only a hash named still opens one.
  if (said && proposal.proposeIntent(said.text) && !pending.some(p => said.text.includes(p.hash.slice(0, 6)))) {
    return c.context('PreToolUse', `sub-human: no room review now: ${me.name} asked you to propose something, so do that (the room's propose tool). The proposal awaiting ${me.name} stays pending; open it when ${me.name} asks.`);
  }
  const kept: { at: number } | null = proposal.readPick(me);
  const p: Proposal = (said && !(kept && kept.at > said.at) ? proposal.choose(me, pending, said.text) : proposal.picked(me, pending))!; // pending is not empty
  const st: Review = { phase: 'entering', mode: input.permission_mode, at: Date.now(), hash: p.hash, from: p.from || null };
  writeReview(me, st);
  const cf: Confirm | null = proposal.readConfirm(me);
  if (cf && cf.hash === p.hash) proposal.clearConfirm(me); // reviewed again: a note waiting for it is superseded
  showEarly(input, me, st);
  c.pre('allow', `sub-human: opening room proposal ${p.hash} for ${me.name}`);
}

/**
 * Back up the session plan file and write the proposal text there (backup in review.json first, as in preExit),
 * as early as the path is known: Pre(EnterPlanMode), else Post(EnterPlanMode). Whatever the file held (the
 * person's plan, a stale plan of the model's) is the backup, restored when the review closes.
 * Best-effort: no known path, no text, or a failed write leaves preExit to do it.
 */
function showEarly(input: ConsentIn, me: Identity, st: Review) {
  const file = planFile(input);
  const text: string | null = st.hash ? proposal.read(me.code, st.hash) : null;
  if (!file || text == null || st.file) return;
  let backup: string | null = null;
  try { backup = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
  Object.assign(st, { file, backup, restored: false });
  writeReview(me, st);
  try { writeFileAtomic(file, text); } catch (err) {
    c.logError(err, 'consent: plan file (enter)');
    delete st.file; delete st.backup; delete st.restored;
    writeReview(me, st);
  }
}

function postEnter(input: ConsentIn, me: Identity) {
  const st = readReview(me);
  if (!st || st.phase === 'restore') return st && c.context('PostToolUse', `sub-human: ${EXIT_HOW}.`);
  if (st.phase !== 'entering') return;
  showEarly(input, me, st);
  c.context('PostToolUse', `sub-human: this plan mode is only to show ${me.name} room proposal ${st.hash}. Call ExitPlanMode now with plan "proposal ${st.hash}"; the hooks put the proposal's text in the dialog whatever plan you pass, so don't explore, plan or write any file. If ${me.name} answers "Tell Claude what to change", ${EXIT_HOW}.`);
}

/** A "proposal <hash>" stub (or nothing): what the model is told to pass, not a plan of its own. */
const stub = (t: string) => !t.trim() || /^\s*(?:the room )?proposal\s+[0-9a-f]{6,12}\s*\.?\s*$/i.test(t);

function preExit(input: ConsentIn, me: Identity) {
  const st = readReview(me);
  if (!st) return;
  if (st.phase === 'shown' && st.tool_use_id && st.tool_use_id === input.tool_use_id) return ask(st, me); // the same call again
  if (st.phase === 'shown') { resolveShown(input, me, st); st.phase = 'exiting'; return writeReview(me, st); }
  if (st.phase !== 'entering') { st.phase = 'exiting'; return writeReview(me, st); }
  // The hook's review: the proposal Pre(EnterPlanMode) picked, whatever this call carries. The model's input
  // (a stale plan in the plan file, a hand-written copy, another hash, nothing) never decides what is shown.
  const p = pendingFor(me).filter(x => proposal.viewable(x, me.code)).find(x => x.hash === st.hash);
  const file = planFile(input);
  const text: string | null = p ? proposal.read(me.code, p.hash) : null;
  if (st.file && st.file !== file) { restorePlan(st); delete st.file; delete st.backup; }
  let backup: string | null | undefined = null;
  if (st.file === file && !st.restored) backup = st.backup; // showEarly already backed it up and wrote the text
  else if (file) {
    try { backup = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
  }
  // A plan of the model's own (not the proposal, not a stub) is never shown here: the model's input as sent, or
  // the plan Claude Code read from the file unless that is just what the file held before the review.
  const ti: ConsentToolInput = input.tool_input || {};
  // A blank plan: the call's transcript line may not be written yet (2.1.292 runs this hook first), so wait for it.
  const own = blank(ti.plan) ? modelInputWait(input) : modelInput(input);
  const mine = (t: unknown) => typeof t === 'string' && !stub(t) && t !== text && proposal.hash12(Buffer.from(t, 'utf8')) !== st.hash;
  const foreign = mine(own && own.plan) || (mine(ti.plan) && ti.plan !== backup);
  if (foreign) st.foreign = true;
  if (!p) {
    restorePlan(st);
    Object.assign(st, { phase: 'exiting', said: `${st.hash ? `proposal ${st.hash}` : 'the room proposal'}: nothing to show (already answered, decided or unknown); nothing was recorded.` });
    return writeReview(me, st);
  }
  if (!file || text == null) {
    restorePlan(st);
    Object.assign(st, { phase: 'exiting', card: p.hash });
    return writeReview(me, st);
  }
  // The backup is on disk (atomically) BEFORE the plan file is overwritten: a crash in between loses nothing,
  // and session-restore puts a stale one back.
  Object.assign(st, { hash: p.hash, from: p.from || null, file, backup, restored: false, tool_use_id: input.tool_use_id || null } satisfies Partial<Review>);
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
const KEEP: Record<string, string | undefined> = { default: 'Yes, manually approve edits', auto: 'Yes, and use auto mode', acceptEdits: 'Yes, and auto-accept edits' };

function ask(st: Review, me: Identity, text: string | null = proposal.read(me.code, st.hash)) {
  c.pre('ask', `room proposal ${st.hash}${st.from ? ` from ${st.from}` : ''}, for ${me.name} (PgUp/PgDn scroll). `
    + `Agree: "${KEEP[String(st.mode)] || 'Yes'}" keeps your mode. Object: "Tell Claude what to change" + why. Esc: decide later.`,
  { updatedInput: { plan: text } });
}

function permExit(input: ConsentIn, me: Identity) {
  const st = readReview(me);
  if (!st || st.phase !== 'exiting') return;
  restorePlan(st);
  writeReview(me, st);
  c.out({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: {},
    updatedPermissions: [{ type: 'setMode', mode: st.mode, destination: 'session' }] } } });
}

/**
 * ExitPlanMode closed with no review shown although its dialog was a pending proposal's (Pre lost it): nothing
 * was recorded, and the model must not say otherwise. Returns false when the call was not about a proposal.
 */
function unshown(input: ConsentIn, me: Identity, hashes?: string[]): boolean {
  const pending = pendingFor(me);
  if (!pending.length) return false;
  const r: ToolResponse = input.tool_response && typeof input.tool_response === 'object' ? input.tool_response : {};
  const ti: ConsentToolInput = input.tool_input || {};
  if (r.isAgent) return false;
  const plan = typeof r.plan === 'string' ? r.plan : typeof ti.plan === 'string' ? ti.plan : '';
  let hit = pending.filter(p => (hashes || []).includes(p.hash));
  // Its text: but not a plan of my own that I proposed (that is my plan, already in the room).
  if (!hit.length && plan.trim()) hit = pending.filter(p => p.from !== me.name && p.hash === proposal.hash12(Buffer.from(plan, 'utf8')));
  if (!hit.length && plan.length < 300) hit = named(pending, [ti, modelInput(input)]);
  if (!hit.length && !plan.trim()) hit = pending;
  if (!hit.length) return false;
  const h = hit.map(p => p.hash).join(', ');
  proposal.choose(me, hit, hit[0].hash); // the next review opens this one
  const again = reviewable(input) && hit.every(p => proposal.viewable(p, me.code))
    ? `call EnterPlanMode, then ExitPlanMode with plan "proposal ${hit[0].hash}"` : `call AskUserQuestion with "proposal ${hit[0].hash}"`;
  c.context('PostToolUse', `sub-human: nothing was recorded for proposal ${h}: the room review did not open, so that dialog was not ${me.name}'s answer. Don't tell ${me.name} they answered. Ask ${me.name} to answer it again (${again}); do not carry out the proposal.`);
  return true;
}

/** For the model, when it passed a plan of its own into a room review: that plan was not shown. */
const foreignLine = (st: Review, me: Identity) => st.foreign ? ` The plan you passed was not shown: this plan mode showed ${me.name} room proposal ${st.hash}, and the plan file is back as it was. If ${me.name} asked you for a plan, present it again afterwards.` : '';

function postExit(input: ConsentIn, me: Identity) {
  const st = readReview(me);
  if (!st) return unshown(input, me) || postPlan(input, me);
  const say = (t: string) => c.context('PostToolUse', t + foreignLine(st, me));
  if (st.phase === 'entering') { // Pre(ExitPlanMode) never opened the review
    restorePlan(st);
    clearReview(me);
    return unshown(input, me, st.hash ? [st.hash] : []) || postPlan(input, me);
  }
  if (st.phase === 'exiting') {
    restorePlan(st);
    clearReview(me);
    const card = st.card ? ` The plan view could not show proposal ${st.card}: call AskUserQuestion with "proposal ${st.card}" so ${me.name} answers on the card.` : '';
    return say(`${st.said ? st.said + ' ' : ''}The room review is closed and the mode is restored; this was not a plan to carry out.${card} Return to what you were doing.`);
  }
  if (st.phase !== 'shown') return;
  // A "Yes" in the dialog: only a person can choose it (the exiting phase above is the hook's own allow).
  const r: ToolResponse = input.tool_response && typeof input.tool_response === 'object' ? input.tool_response : {};
  const p = answerableFor(me).find(x => x.hash === st.hash);
  let line: string;
  if (r.planWasEdited || typeof r.plan !== 'string' || proposal.hash12(Buffer.from(r.plan, 'utf8')) !== st.hash) {
    line = `${me.name} edited proposal ${st.hash} in the review; nothing was recorded. If they want the edited text agreed, propose it.`;
  } else if (!p) line = `proposal ${st.hash}: nothing recorded (already answered, decided or unknown).`;
  else {
    const res = record(me, p, { choice: 'Agree' });
    line = res.failed ? failed(me, st.hash, res) : res.stale ? `proposal ${st.hash}: nothing recorded (already answered or decided).`
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
function stop(input: ConsentIn, me: Identity) {
  const st = readReview(me);
  if (input.stop_hook_active) return;
  if (!st) return unasked(me);
  const mode = input.permission_mode;
  let what: string;
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

/** Stop with no review open: a note waiting for the person's Send whose card was never shown (the model ignored
 * the line after the review closed), or one whose interrupted card reoffer offered again this turn and the model did
 * not show (renudge). Once each: a card shown and left unanswered after that is the person's to reopen. */
function unasked(me: Identity) {
  const cf: Confirm | null = proposal.readConfirm(me);
  if (cf && renudgeDue(cf)) return renudge(me, cf);
  if (!cf || cf.asked || cf.nudged) return;
  if (!pendingFor(me).some(p => p.hash === cf.hash)) return proposal.clearConfirm(me);
  proposal.writeConfirm(me, { ...cf, nudged: Date.now() }); // not asked: no card was shown
  c.context('Stop', `sub-human: ${me.name}'s note on proposal ${cf.hash} is not recorded yet: ${confirmCall(cf.hash)} so ${me.name} can send or discard it. Don't post the note or answer for ${me.name}.`);
}

/**
 * Pre(room tool) while a review is still open in plan mode: after "Tell Claude what to change" no hook fires (a
 * rejected call has no PostToolUse), and a Claude may post the person's note itself (run heron-0084). Record the
 * objection now, deny the call, and tell it to exit first.
 */
function preRoomTool(input: ConsentIn, me: Identity) {
  const st = readReview(me);
  if (!st || input.permission_mode !== 'plan' || !['shown', 'exiting'].includes(st.phase)) return;
  const said = resolveShown(input, me, st);
  st.phase = 'exiting';
  writeReview(me, st);
  c.deny(`sub-human: ${said ? said + ' ' : ''}Post nothing about the review. First ${EXIT_HOW}; then return to what you were doing.`);
}

/**
 * UserPromptSubmit with no review open: a waiting note whose confirm card was shown (asked) and closed with no Post
 * (the person interrupted it, so no hook said a word), or never shown though Stop nudged (nudged): the note would
 * wait unseen. Offer it again, once (again). The tail's reminder on this prompt says the same (proposal.showConfirm).
 */
const reofferDue = (cf: Confirm | null): cf is Confirm => !!(cf && (cf.asked || cf.nudged) && !cf.again);
function reoffer(me: Identity) {
  const cf: Confirm | null = proposal.readConfirm(me);
  if (!reofferDue(cf)) return;
  if (!pendingFor(me).some(p => p.hash === cf.hash)) return proposal.clearConfirm(me);
  const now = Date.now();
  // an interrupted card: the Stop of this turn nudges once more if the model does not show it (renudge)
  proposal.writeConfirm(me, { ...cf, again: now, ...(cf.asked ? { reoffered: now } : {}) });
  const show = cf.asked ? proposal.showConfirm(me.name, cf.hash, true) : `Its card was never shown. ${proposal.showConfirm(me.name, cf.hash)}`;
  c.context('UserPromptSubmit', `sub-human: ${me.name}'s note on proposal ${cf.hash} is still not recorded. ${show} Don't post the note or answer for ${me.name}.`);
}

/**
 * Stop after reoffer offered an interrupted card again and no card was asked since: the model took the Esc for the
 * person's decline (Claude Code reports it so). Once (renudged); then the card is the person's to ask for.
 */
const renudgeDue = (cf: Confirm | null): boolean => !!(cf && cf.reoffered && !cf.renudged && !((cf.asked || 0) >= cf.reoffered));
function renudge(me: Identity, cf: Confirm) {
  if (!pendingFor(me).some(p => p.hash === cf.hash)) return proposal.clearConfirm(me);
  proposal.writeConfirm(me, { ...cf, renudged: Date.now() });
  c.context('Stop', `sub-human: ${me.name}'s note on proposal ${cf.hash} is still not recorded and its card was not shown again. ${proposal.showConfirm(me.name, cf.hash, true)} Don't post the note or answer for ${me.name}.`);
}

/** UserPromptSubmit: a review left open by Esc (no hook fires then). Still in plan mode: exit it first. */
function prompt(input: ConsentIn, me: Identity) {
  const st = readReview(me);
  if (!st) return reoffer(me);
  if (input.permission_mode === 'plan' && st.phase !== 'restore') {
    const said = resolveShown(input, me, st);
    st.phase = 'exiting';
    writeReview(me, st);
    return c.context('UserPromptSubmit', `sub-human: ${said ? said + ' ' : ''}Before anything else, ${EXIT_HOW}; then continue.`);
  }
  restorePlan(st);
  clearReview(me);
}

/**
 * Post(AskUserQuestion) for the confirm card: only the person's Send on the card as the hooks built it (question,
 * labels and descriptions as shown) records the objection with the waiting note; Discard drops the note; anything
 * else (AFK, followUp, no answer, another label) records nothing and keeps the note. Returns false when the call was
 * not the confirm card.
 */
function postConfirm(input: ConsentIn, me: Identity, r: ToolResponse, answers: Record<string, unknown> | null): boolean {
  const cf: Confirm | null = proposal.readConfirm(me);
  if (!cf) return false;
  const card: CardSpec = proposal.confirmCard(cf).questions[0];
  const shown = Array.isArray(r.questions) ? r.questions : [];
  const asked = [...shown, ...((input.tool_input && input.tool_input.questions) || [])].some(q => q && q.question === card.question);
  if (!asked) return false;
  const say = (t: string) => c.context('PostToolUse', t);
  const same = (q: CardQuestion | null | undefined) => q && q.question === card.question && Array.isArray(q.options) && q.options.length === card.options.length
    && q.options.every((o, i) => o && o.label === card.options[i].label && o.description === card.options[i].description);
  const label = answers && Object.hasOwn(answers, card.question) ? String(answers[card.question]) : null;
  const told = () => proposal.writeConfirm(me, { ...cf, again: Date.now() }); // the model was told: no re-offer
  if (r.afkTimeoutMs || r.followUp || label == null || !shown.some(same)) {
    told();
    return say(`Nothing was recorded: the card closed without ${me.name}'s answer, and the note waits. If ${me.name} asks, ${confirmCall(cf.hash)} again; return to what you were doing.`), true;
  }
  if (label === 'Discard') {
    proposal.clearConfirm(me);
    return say(`${me.name} discarded the note; nothing was recorded and proposal ${cf.hash} still awaits ${me.name}'s answer (reopening it later is fine). Return to what you were doing.`), true;
  }
  if (label !== 'Send') return told(), say(`proposal ${cf.hash}: no Send/Discard answer; nothing was recorded and the note waits. Return to what you were doing.`), true;
  const p = answerableFor(me).find(x => x.hash === cf.hash);
  if (!p) { proposal.clearConfirm(me); return say(`proposal ${cf.hash}: nothing recorded (already answered, decided or unknown).`), true; }
  const res = record(me, p, { choice: 'Object', notes: cf.note });
  if (!res.failed) proposal.clearConfirm(me); // not sent (the room unreachable): the note waits for another Send
  say(res.failed ? failed(me, cf.hash, res) : res.stale ? `proposal ${cf.hash}: nothing recorded (already answered or decided).`
    : `${RECORDED} ${done(me, 'Object', cf.hash, res)} Return to what you were doing.`);
  return true;
}

/**
 * Post(AskUserQuestion) for the handoff card: only the person's own answer on the card as the hooks built it counts.
 * "Host it here" moves the room here (lib/handoff.ts accept), "Not now" refuses; AFK or another answer records nothing.
 * Returns false when the call was not the handoff card.
 */
function postHandoff(input: ConsentIn, me: Identity, r: ToolResponse, answers: Record<string, unknown> | null): boolean {
  const a: HandoffAskDoc | null = handoff.pendingAsk(me.code, me.name);
  if (!a) return false;
  const card: CardSpec = handoff.card(a, me.code).questions[0];
  const shown = Array.isArray(r.questions) ? r.questions : [];
  if (![...shown, ...((input.tool_input && input.tool_input.questions) || [])].some(q => q && q.question === card.question)) return false;
  const say = (t: string, top?: HookOutput) => c.context('PostToolUse', t, top);
  const same = (q: CardQuestion | null | undefined) => q && q.question === card.question && Array.isArray(q.options) && q.options.length === card.options.length
    && q.options.every((o, i) => o && o.label === card.options[i].label && o.description === card.options[i].description);
  const label = answers && Object.hasOwn(answers, card.question) ? String(answers[card.question]) : null;
  if (r.afkTimeoutMs || r.followUp || label == null || !shown.some(same) || ![handoff.YES, handoff.NO].includes(label)) {
    return say(`Nothing was decided: the handoff card closed without ${me.name}'s answer. If ${me.name} asks, call AskUserQuestion with "handoff" again; return to what you were doing.`), true;
  }
  if (label === handoff.NO) {
    const res = handoff.refuse(me);
    return say(res.ok ? `${me.name} declined to host room ${me.code}; ${a.from} stays the host. Return to what you were doing.`
      : `${me.name} declined, but the host was not told (${res.error}); nothing moved. Return to what you were doing.`), true;
  }
  const res = handoff.accept(me, { cwd: input.cwd, sign: (p: Record<string, unknown>) => envelope.sign(p, roomStore.humanKey(me.code, me.name), { room: me.code, from: me.name }) });
  if (!res.ok) {
    return say(`The room did NOT move: ${res.error}. ${me.name} has been told; return to what you were doing.`, { systemMessage: `sub-human: room ${me.code} did not move here: ${res.error}` }), true;
  }
  say(`Room ${me.code} is hosted on this machine now: ${me.name} agreed on the card. The room's Claude starts here, on ${me.name}'s Claude account. Post nothing about it (the room shows it); return to what you were doing.`,
    { systemMessage: `sub-human: room ${me.code} is hosted on this machine now, and its Claude runs on your Claude account. Keep this machine reachable for the others${res.note}` });
  return true;
}

/**
 * Post(AskUserQuestion) for a join request's card (lib/remote/admission.ts): only the person's own answer on the card
 * as the hooks built it counts. "Let in" admits the machine (signed with the seat key), "Refuse" ends the request;
 * AFK, another answer or an edited card records nothing. Returns false when the call was not that card.
 */
function postAdmit(input: ConsentIn, me: Identity, r: ToolResponse, answers: Record<string, unknown> | null): boolean {
  if (!c.identity.isHost(me.code)) return false;
  const shown = Array.isArray(r.questions) ? r.questions : [];
  const asked = [...shown, ...((input.tool_input && input.tool_input.questions) || [])].map(q => q && q.question).filter(Boolean);
  const m = asked.map(q => /\(admit ([0-9a-f]{12})\)$/.exec(String(q))).find(Boolean);
  if (!m) return false;
  const adm = admission();
  const req: JoinRequest | null = adm.find(me.code, m[1]);
  const say = (t: string, top?: HookOutput) => c.context('PostToolUse', t, top);
  if (!req) return say(`Nothing was done: no join request ${m[1]} in room ${me.code}. Return to what you were doing.`), true;
  const card: CardSpec = adm.card(req, me.code).questions[0];
  const same = (q: CardQuestion | null | undefined) => q && q.question === card.question && Array.isArray(q.options) && q.options.length === card.options.length
    && q.options.every((o, i) => o && o.label === card.options[i].label && o.description === card.options[i].description);
  const label = answers && Object.hasOwn(answers, card.question) ? String(answers[card.question]) : null;
  if (r.afkTimeoutMs || r.followUp || label == null || !shown.some(same) || ![adm.LET_IN, adm.REFUSE].includes(label)) {
    return say(`Nothing was decided: the join card closed without ${me.name}'s answer, and ${req.name} still waits. If ${me.name} asks, call AskUserQuestion with "admit ${req.ref}" again; return to what you were doing.`), true;
  }
  try {
    if (label === adm.REFUSE) {
      adm.refuse(me.code, req.ref, { by: me.name });
      return say(`${me.name} refused ${req.name}; nothing got in. Post nothing about it (the room shows it); return to what you were doing.`), true;
    }
    const sign = (p: Parameters<NonNullable<Parameters<typeof adm.letIn>[2]>['sign'] & {}>[0]) => envelope.sign(p, roomStore.humanKey(me.code, me.name), { room: me.code, from: me.name });
    const res = adm.letIn(me.code, req.ref, { by: me.name, sign });
    say(`${me.name} let ${req.name}'s machine into room ${me.code}. Post nothing about it (the room shows it); return to what you were doing.`,
      { systemMessage: `sub-human: ${res.text}` });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    say(`Nothing was done: ${why}. ${me.name} has been told; return to what you were doing.`, { systemMessage: `sub-human: ${req.name} was not let in: ${why}` });
  }
  return true;
}

function postAsk(input: ConsentIn, me: Identity) {
  const r: ToolResponse = input.tool_response && typeof input.tool_response === 'object' ? input.tool_response : {};
  const answers = r.answers && typeof r.answers === 'object' ? r.answers : null;
  if (postAdmit(input, me, r, answers)) return;
  if (postHandoff(input, me, r, answers)) return;
  if (postConfirm(input, me, r, answers)) return;
  const asked = [...(Array.isArray(r.questions) ? r.questions : []), ...((input.tool_input && input.tool_input.questions) || [])]
    .map(q => q && q.question).filter(q => proposal.QUESTION_RE.test(String(q)));
  const keys = answers ? Object.keys(answers).filter(k => proposal.QUESTION_RE.test(k)) : [];
  if (!keys.length && !asked.length) return; // not a consent card
  const say = (t: string) => c.context('PostToolUse', t);
  if (r.afkTimeoutMs || r.followUp || !keys.length) {
    return say(`Nothing was recorded: the card closed without ${me.name}'s answer. Reopening it later is fine; return to what you were doing.`);
  }
  const pending = answerableFor(me);
  const out: string[] = [];
  let recorded = false;
  for (const k of keys) {
    const hash = k.match(proposal.QUESTION_RE)![1]; // keys passed QUESTION_RE
    const label = String(answers![k]); // keys are answers' own
    const p = pending.find(x => x.hash === hash);
    if (!p) { out.push(`proposal ${hash}: nothing recorded (already answered, decided or unknown).`); continue; }
    if (label === 'Not yet') { out.push(`proposal ${hash}: ${me.name} has not decided; nothing was recorded. Do not ask again unless ${me.name} asks.`); continue; }
    if (label !== 'Agree' && label !== 'Object') { out.push(`proposal ${hash}: no Agree/Object answer; nothing was recorded.`); continue; }
    const notes = r.annotations && r.annotations[k] ? r.annotations[k].notes : undefined;
    const res = record(me, p, { choice: label, notes });
    if (res.failed) { out.push(failed(me, hash, res)); continue; }
    if (res.stale) { out.push(`proposal ${hash}: nothing recorded (already answered or decided).`); continue; }
    recorded = true;
    out.push(done(me, label, hash, res));
  }
  say([recorded ? RECORDED : null, ...out, 'Return to what you were doing.'].filter(Boolean).join(' '));
}

function postPlan(input: ConsentIn, me: Identity) {
  const r: ToolResponse = input.tool_response && typeof input.tool_response === 'object' ? input.tool_response : {};
  if (r.isAgent || typeof r.plan !== 'string' || !r.plan.trim()) return;
  const hash = proposal.hash12(Buffer.from(r.plan, 'utf8'));
  // My own pending proposal, approved unedited in my own plan mode: that is my answer to it.
  const mine = r.planWasEdited ? undefined : pendingFor(me).find(p => p.hash === hash && p.from === me.name);
  if (mine) {
    const res = record(me, mine, { choice: 'Agree' });
    return c.context('PostToolUse', res.failed ? failed(me, hash, res) : res.stale ? `proposal ${hash}: nothing recorded (already answered or decided).` : done(me, 'Agree', hash, res));
  }
  if (proposal.proposals(c.room.open(me.code).readAll()).some((p: Proposal) => p.hash === hash)) return; // already proposed
  const where = r.filePath ? `{path: ${JSON.stringify(r.filePath)}}` : '{text: <the plan>}';
  c.context('PostToolUse', `sub-human: if ${me.name} wants the room to agree to this plan, call the room propose tool with ${where}. Only on ${me.name}'s word; planning is optional.`);
}

/** Every event consent handles, for one hook input; an answer not recorded is told to the person (systemMessage). */
function dispatch(input: ConsentIn) {
  unsent = [];
  const r = c.capture(() => route(input));
  const note = unsent.length ? { systemMessage: `sub-human: ${unsent.join(' ')}` } : null;
  r.outputs.forEach((o, i) => c.out(note && i === 0 ? { ...o, ...note } : o));
  if (note && !r.outputs.length) c.out(note);
  if (r.error) throw r.error;
}

function route(input: ConsentIn) {
  const me = c.whoami(input);
  if (!me) return;
  const ev = input.hook_event_name, tool = input.tool_name;
  if (tool === 'AskUserQuestion' && ev === 'PreToolUse') return pre(input, me);
  if (tool === 'AskUserQuestion' && ev === 'PostToolUse') return postAsk(input, me);
  const locked = (fn: (input: ConsentIn, me: Identity) => unknown) => proposal.withReview(me, () => fn(input, me));
  if (tool === 'EnterPlanMode' && ev === 'PreToolUse') return locked(preEnter);
  if (tool === 'EnterPlanMode' && ev === 'PostToolUse') return locked(postEnter);
  if (tool === 'ExitPlanMode' && ev === 'PreToolUse') return locked(preExit);
  if (tool === 'ExitPlanMode' && ev === 'PermissionRequest') return locked(permExit);
  if (tool === 'ExitPlanMode' && ev === 'PostToolUse') return locked(postExit);
  if (/^mcp__plugin_sub-human_room__/.test(tool || '') && ev === 'PreToolUse') return locked(preRoomTool);
  if (ev === 'Stop') return locked(stop);
  if (ev === 'UserPromptSubmit') return locked(prompt);
}

/** The UserPromptSubmit handler (hooks/prompt.ts runs it after at-room.ts's, in one process). */
const onPrompt = (input: ConsentIn) => dispatch({ ...input, hook_event_name: 'UserPromptSubmit' });

/** True when this session's seat has a room review on record (review.json), or a note whose confirm card was never
 * shown (Stop nudges once), or one the next prompt offers again (reoffer), so the module still runs node; false with
 * no seat. */
function reviewOpen(input: ConsentIn): boolean {
  const me = c.whoami(input);
  if (!me) return false;
  if (readReview(me)) return true;
  const cf: Confirm | null = proposal.readConfirm(me);
  return !!(cf && !cf.asked && !cf.nudged) || reofferDue(cf) || renudgeDue(cf);
}

/**
 * Shim mode (SUB_HUMAN_SHIM=1: the hooks module ran this hook, mod/consent.ts): the one output also carries
 * subHuman {reviewOpen}, so the mod knows whether the next turn end needs consent at all. Printed even when the
 * handler had nothing to say; an error leaves it out (the mod then stays unsure).
 */
function shimDispatch(input: ConsentIn) {
  const r = c.capture(() => dispatch(input));
  if (r.error) throw r.error;
  const outputs = r.outputs.filter(Boolean);
  const last = outputs.pop() || {};
  for (const o of outputs) process.stdout.write(JSON.stringify(o) + '\n');
  c.out({ ...last, subHuman: { reviewOpen: reviewOpen(input) } });
}

const SHIM = () => process.env.SUB_HUMAN_SHIM === '1';

export { dispatch, onPrompt, reviewOpen, SHIM, quiet };

// the error is logged; never block a question or a plan
if (entry) {
  try {
    if (entry.error) throw entry.error;
    (SHIM() ? shimDispatch : dispatch)(entry.input || {});
  } catch (err) { c.logError(err); }
}
