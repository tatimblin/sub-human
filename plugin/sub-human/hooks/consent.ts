/**
 * plugin/sub-human/hooks/consent.ts: consent. A proposal opens in Claude Code's own plan-approval dialog (the
 * native, scrollable plan view: PgUp/PgDn read all of it); the AskUserQuestion card is the fallback. Only the person's
 * answer there records anything (via=human, signed with the seat key).
 *
 * What happens is decided by one pure reducer, lib/consent/review.ts (its header has the phases, the note's stages,
 * every event and effect, and every line the model is told). This file only gathers each event's facts under the
 * review lock (proposal.withReview), runs the effects, stores the state (members/NAME/review, members/NAME/confirm)
 * and writes the answer.
 *
 * A room plan edit (the plan tool's edit op opened it in this session) is the other machine, lib/consent/edit.ts:
 * while one is open, plan mode is the edit's (routeEdit): its seed at the plan_mode attachment (the module's
 * PlanAttachment event) or at ExitPlanMode, its capture at Pre(ExitPlanMode) into lib/plans.ts put (on the host, or
 * over the link's plan.put), the receipt or the conflict as the deny, and the closing call let through with the mode
 * back. It records no answer.
 *
 * The cards (a join request's, the note's and the fallback consent card) are read through
 * lib/consent/card.ts answerCard: only the person's answer on the card as the hooks built it counts.
 *
 * The plan file: cc.planFile, Claude Code's own record of it (the transcript's plan_mode attachment), or the path
 * Claude Code injects into ExitPlanMode's input when it is that path or under the plans dir; never a key the model put
 * in another call (the hooks write the proposal there).
 *
 * Loading this file arms the seat-key signer (it signs the person's answers, via=human); hooks/handlers/consent.ts
 * exits before it loads for a room tool call outside plan mode.
 */

import fs from 'node:fs';
import * as reply from './reply.ts';
import { whoami } from './seat.ts';
import * as seatKey from './seat-key.ts';
import * as room from '../lib/room.ts';
import * as identity from '../lib/identity.ts';
import * as proposal from '../lib/proposal.ts';
import * as review from '../lib/consent/review.ts';
import * as card from '../lib/consent/card.ts';
import * as edit from '../lib/consent/edit.ts';
import * as plans from '../lib/plans.ts';
import * as cc from '../lib/cc/transcript.ts';
import * as ccEnv from '../lib/cc/env.ts';
import { writeFileAtomic } from '../lib/io.ts';
import * as config from '../lib/config.ts';
import * as env from '../lib/env.ts';
import * as envelope from '../lib/room/envelope.ts';
import * as roomStore from '../lib/room/store.ts';
import * as admission from '../lib/remote/admission.ts';
import type { AnyHookIn, CardQuestion, HookOutput, Recorded } from './types.ts';
import type { Card, PlanEdit, Proposal, Review } from '../lib/types-app.ts';
import type { AdmissionRequest } from '../lib/remote/admission.ts';
import type { Identity } from '../lib/identity.ts';
import type { ConsentEffect, ConsentEvent, Pending, Say, State, Target } from '../lib/consent/review.ts';
import type { CardResponse } from '../lib/consent/card.ts';

/** The tool call's input, as far as consent reads it (untrusted: each field checked). */
interface ConsentToolInput { plan?: unknown; questions?: CardQuestion[]; planFilePath?: unknown }
/** AskUserQuestion's or ExitPlanMode's response, as far as consent reads it. */
interface ToolResponse extends CardResponse { plan?: unknown; planWasEdited?: unknown; isAgent?: unknown; filePath?: unknown }
/** Every event consent handles (PreToolUse, PostToolUse, PermissionRequest, Stop, UserPromptSubmit), with the
 * transcript's lines once read (lines()). */
type ConsentIn = Omit<AnyHookIn, 'tool_input' | 'permission_mode'> & { tool_input?: ConsentToolInput; _lines?: string[] | null; permission_mode?: string | undefined };
/** An invite's join request waiting on the host (lib/remote/admission.ts pending). */
type JoinRequest = AdmissionRequest;

seatKey.arm();

/** The room's post tool (hooks/handlers/consent.ts has the same: neither file loads the other's values). */
const POST_TOOL = /^mcp__plugin_sub-human_room__post$/;

/** The output helpers (hooks/reply.ts), the seat, the room and identity: what this file calls `c.`. */
const c = { ...reply, whoami, room, identity };

/** A one-question card's question (confirmCard and the admission's card each build exactly one). */
function firstQuestion(cd: Card): Card['questions'][number] {
  const [q] = cd.questions;
  if (!q) throw new Error('a card with no question'); // never: each builder writes one
  return q;
}

/** Answers this run could not record, and the reducer's notices, for the person (dispatch puts them in the output's
 * systemMessage). */
let unsent: string[] = [];

/**
 * The person's answer, then the decision when it completes the proposal (host only: lib/proposal.ts decide).
 * A RoomError (the link to the host is down: OFFLINE) is {failed}, and the person is told: nothing is queued. One
 * whose outcome is unknown (sent over a slow link, no answer in time) is {failed, unknown}: it may still land.
 */
function record(me: Identity, hash: string, a: { choice: 'Agree' | 'Object'; notes?: string }): Recorded {
  let res: ReturnType<typeof proposal.answer>;
  try { res = proposal.answer(me, { hash }, a); } catch (err) {
    if (!(err instanceof c.room.RoomError)) throw err;
    const what = `your ${a.choice === 'Agree' ? 'agreement to' : 'objection to'} proposal ${hash}`;
    unsent.push(err.unknown // it went out and may still land: answering again is safe (one answer per person per proposal)
      ? `⧗ ${what} is not confirmed: ${err.message}. If the proposal still shows you unanswered, answer again: that is safe.`
      : `✗ ${what} was not recorded: ${err.message}. Answer again once the room is reachable.`);
    return { failed: err.message, ...(err.unknown ? { unknown: true } : {}) };
  }
  return res.stale ? res : { ...res, decision: proposal.decide(me.code, hash) };
}

// ---------- facts ----------
const REVIEW_MODES = ['default', 'acceptEdits', 'auto'];
/** The clear-context approve option fires no PostToolUse and starts implementing: no review then. */
const reviewable = (input: ConsentIn) => REVIEW_MODES.includes(String(input.permission_mode)) && !ccEnv.clearContextOnPlanAccept(input.cwd);

/** The transcript's lines, read once per hook run (the tail: the review is always recent). */
function lines(input: ConsentIn): string[] {
  input._lines ??= cc.readLines(input.transcript_path, { tailBytes: config.TRANSCRIPT_TAIL_BYTES });
  return input._lines;
}
/** The session's plan file (cc.planFile: tool_input only on ExitPlanMode, where Claude Code injects it) and what it holds. */
function planOf(input: ConsentIn): { file: string | null; text: string | null } {
  const file = cc.planFile(lines(input), input.tool_name === 'ExitPlanMode' ? input.tool_input : null);
  let text: string | null = null;
  if (file) { try { text = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ } }
  return { file, text };
}
/** The input the model itself gave this call (Claude Code swaps ExitPlanMode's plan for the plan file's text). */
const modelInput = (input: ConsentIn): { plan?: unknown } | null => {
  const v = cc.toolUseInput(lines(input), input.tool_use_id);
  return v && typeof v === 'object' ? v : null; // a tool_use's input is an object
};
/** read() over the transcript, polling until it gives a value (or EXIT_INPUT_WAIT_MS passed); null then. */
function polled<T>(input: ConsentIn, read: () => T | null): T | null {
  const until = Date.now() + env.envMs('SUB_HUMAN_EXIT_INPUT_WAIT_MS');
  for (;;) {
    const v = read();
    if (v || Date.now() >= until) return v;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, config.EXIT_INPUT_POLL_MS);
    input._lines = null; // read the tail again
  }
}
const blank = (v: unknown) => v == null || (typeof v === 'string' && !v.trim());
const responseOf = (input: ConsentIn): ToolResponse => (input.tool_response && typeof input.tool_response === 'object' ? input.tool_response : {});

/**
 * How the review's dialog closed (cc.planAnswer), when the reducer needs it for this event (review.answerNeeded):
 * {note} with the person's "Tell Claude what to change" note, or note null (Esc); null while its tool_result is not on
 * disk ('wait': polled for, the dialog has closed and the line may not be written yet). Plus the review's proposal
 * while this seat may still answer it.
 */
function answerFacts(input: ConsentIn, me: Identity, r: Review | null, type: ConsentEvent['type']) {
  const need = review.answerNeeded(r, { type, toolUseId: input.tool_use_id || null, mode: input.permission_mode });
  if (!need || !r) return {};
  const id = r.tool_use_id;
  const read = () => cc.planAnswer(lines(input), id);
  return { answer: need === 'wait' && id ? polled(input, read) : read(), target: targetOf(me, r.hash) };
}
/** The proposal hash while this seat may still answer it (lib/proposal.ts answerableFor), with its title. */
function targetOf(me: Identity, hash: string | null | undefined): Target | null {
  const p = hash ? proposal.answerableFor(me).find(x => x.hash === hash) : undefined;
  return p ? { hash: p.hash, from: p.from || null, title: proposal.title(me.code, p.hash) || null } : null;
}
const pendingOf = (me: Identity, ps: Proposal[] = proposal.pendingFor(me)): Pending[] => ps.map(p => ({ hash: p.hash, from: p.from || null, viewable: proposal.viewable(p, me.code) }));
const isPending = (me: Identity, hash: string | undefined) => !!hash && proposal.pendingFor(me).some(p => p.hash === hash);

/** The model's call as text, scanned once: the hex tokens it names and its words (what a card call is about). */
/** text: the call's JSON; tokens: every 6-12 hex run in it; words: those that stand alone. */
interface Call { text: string; tokens: string[]; words: string[] }
function callOf(input: unknown): Call {
  const text = JSON.stringify(input || {});
  return { text, tokens: text.match(/[0-9a-f]{6,12}/g) ?? [], words: text.match(/\b[0-9a-f]{6,12}\b/g) ?? [] };
}
/** Pending proposals the call names (a hash, or a 6–12 hex prefix of exactly one), oldest first. */
const named = (pending: Proposal[], call: Call): Proposal[] => pending.filter(p => call.text.includes(p.hash)
  || call.tokens.some(t => p.hash.startsWith(t) && pending.filter(q => q.hash.startsWith(t)).length === 1));
/**
 * No hash named, but the question is plainly about a proposal ("Do you agree with the paging proposal?") and exactly
 * one is pending, and the call names no other hex id: that one (the model may drop the hash). A question about
 * something else (no "propos…") or an ambiguous one (two pending) must not become a consent card.
 */
function onlyPending(pending: Proposal[], call: Call): Proposal[] {
  const [only] = pending;
  if (!only || pending.length !== 1 || !/propos/i.test(call.text)) return [];
  return call.words.some(t => /[a-f]/.test(t) && /\d/.test(t) && !only.hash.startsWith(t)) ? [] : pending;
}
/** A join request waiting for me on the host, when this card call is about it (it names its ref, or carries the card's
 * question, or says "admit" while exactly one waits). */
function admitAsked(me: Identity, call: Call): JoinRequest | null {
  if (!c.identity.isHost(me.code) || !/admit|join/i.test(call.text)) return null;
  const adm = admission;
  const reqs = adm.pending(me.code).filter(q => adm.targets(me.code, q).includes(me.name));
  const hit = reqs.find(q => call.text.includes(q.ref) || call.text.includes(adm.question(q, me.code)) || call.words.some(t => q.ref.startsWith(t)));
  return hit ?? (/\badmit\b/i.test(call.text) && reqs.length === 1 ? reqs[0] ?? null : null);
}

// ---------- running a step ----------
/** The plan file emptied for a closing ExitPlanMode let through with no dialog (lib/cc/env.ts LEAVE_PLAN_TEXT); best
 * effort: the person's plan comes back at exited either way. */
function blankPlan(file: string): void {
  try { writeFileAtomic(file, ccEnv.LEAVE_PLAN_TEXT); } catch (err) { c.logError(err, 'consent: plan file (leave)'); }
}

type Out = { say: Say | null; show?: { admit?: JoinRequest | undefined; card?: Proposal[] } };


/** The seat's state, reduce one event (made from it), run the effects, store the state, write the answer. */
function step(input: ConsentIn, me: Identity, make: (st: State) => ConsentEvent, show: Out['show'] = {}) {
  const start: State = { review: proposal.readReview(me), note: proposal.readConfirm(me), recheck: proposal.readRecheck(me) };
  const ctx = { name: me.name, now: Date.now(), guardMs: env.testMs('SUB_HUMAN_YES_GUARD_MS') };
  const first = review.reduce(start, make(start), ctx);
  if (first.notice) unsent.push(first.notice);
  let state = first.state;
  let say = first.say;
  const disk = { review: JSON.stringify(start.review), note: JSON.stringify(start.note), recheck: JSON.stringify(start.recheck ?? null) };
  const answers = new Map<string, { choice: 'Agree' | 'Object'; res: Recorded }>();
  const queue: ConsentEffect[] = [...first.effects];
  for (let e = queue.shift(); e; e = queue.shift()) {
    if (e.do === 'save') { proposal.writeReview(me, e.review); disk.review = JSON.stringify(e.review); }
    else if (e.do === 'restorePlan') proposal.restorePlan({ phase: 'exiting', file: e.file, backup: e.backup, restored: false });
    else if (e.do === 'blankPlan') blankPlan(e.file);
    else if (e.do === 'answer') {
      const res = record(me, e.hash, { choice: e.choice, ...(e.notes !== undefined ? { notes: e.notes } : {}) });
      answers.set(e.hash, { choice: e.choice, res });
      if (e.clearNote && !res.failed) state = { ...state, note: null };
    } else if (e.do === 'writePlan') {
      try {
        const text = proposal.read(me.code, e.hash);
        if (text == null) throw new Error(`proposal ${e.hash}: no stored text`);
        writeFileAtomic(e.file, text);
      } catch (err) {
        c.logError(err, `consent: plan file${e.early ? ' (enter)' : ''}`);
        const f = review.reduce(state, { type: 'planFailed', early: e.early }, ctx);
        state = f.state;
        queue.unshift(...f.effects);
        if (!e.early) say = f.say; // the dialog is not shown: the review closes, the card instead
      }
    }
  }
  if (JSON.stringify(state.review) !== disk.review) { if (state.review) proposal.writeReview(me, state.review); else proposal.clearReview(me); }
  if (JSON.stringify(state.note) !== disk.note) { if (state.note) proposal.writeConfirm(me, state.note); else proposal.clearConfirm(me); }
  if (JSON.stringify(state.recheck ?? null) !== disk.recheck) { if (state.recheck) proposal.writeRecheck(me, state.recheck); else proposal.clearRecheck(me); }
  if (say) write(input, me, say, state, answers, show);
}

/** The answer effect's outcome line for hash. */
function outcome(me: Identity, hash: string, a: { choice: 'Agree' | 'Object'; res: Recorded } | undefined): string {
  if (!a) return '';
  const { res } = a;
  if (res.failed) return review.SAY.failed(me.name, hash, res.failed, !!res.unknown);
  if (res.stale) return review.SAY.stale(hash);
  return (a.choice === 'Agree' ? review.SAY.agreed : review.SAY.objected)(me.name, hash, res.decision && res.decision.text);
}

function write(input: ConsentIn, me: Identity, say: Say, state: State, answers: Map<string, { choice: 'Agree' | 'Object'; res: Recorded }>, show: Out['show'] = {}) {
  const recorded = [...answers.values()].some(a => !!a.res.entry);
  const text = (parts: Parameters<typeof review.textOf>[0]) => review.textOf(parts, h => outcome(me, h, answers.get(h)), recorded);
  switch (say.to) {
    case 'context': return c.context(String(input.hook_event_name), text(say.parts));
    case 'deny': return c.deny(text(say.parts));
    case 'allow': return c.pre('allow', say.text);
    case 'permit': return c.out(ccEnv.leavePlanMode(say.mode));
    case 'ask': {
      const s = say.show;
      if ('plan' in s) return c.pre('ask', say.text, { updatedInput: { plan: proposal.read(me.code, s.plan) } });
      if ('note' in s) return state.note && c.pre('ask', say.text, { updatedInput: proposal.confirmCard(state.note) });
      if ('admit' in s && show.admit) return c.pre('ask', `room ${me.code}: ${show.admit.name} asks to join`, { updatedInput: admission.card(show.admit, me.code) });
      if ('card' in s && show.card) return c.pre('ask', say.text, { updatedInput: proposal.cardFor(show.card, me.code) });
    }
  }
}

// ---------- the events ----------
function preAsk(input: ConsentIn, me: Identity) {
  const call = callOf(input.tool_input);
  const ad = admitAsked(me, call);
  const pending = proposal.pendingFor(me);
  let hit = named(pending, call);
  if (!hit.length) hit = onlyPending(pending, call);
  step(input, me, st => {
    const cf = st.note;
    const q = cf ? proposal.confirmQuestion(cf) : null;
    const qs = input.tool_input && input.tool_input.questions;
    const noteNamed = !!cf && ((Array.isArray(qs) && qs.some(x => x && x.question === q)) || call.tokens.some(t => cf.hash.startsWith(t)));
    return { type: 'ask', admit: ad ? ad.ref : null, noteNamed,
      live: !!cf && proposal.answerableFor(me).some(p => p.hash === cf.hash), hit: pendingOf(me, hit), reviewable: reviewable(input) };
  }, { admit: ad ?? undefined, card: hit });
}

function postAsk(input: ConsentIn, me: Identity) {
  const r = responseOf(input);
  if (postAdmit(input, me, r)) return;
  const asked = [...(Array.isArray(r.questions) ? r.questions as CardQuestion[] : []), ...((input.tool_input && input.tool_input.questions) ?? [])]
    .some(q => q && proposal.QUESTION_RE.test(String(q.question)));
  const keys = r.answers && typeof r.answers === 'object' ? Object.keys(r.answers).filter(k => proposal.QUESTION_RE.test(k)) : [];
  const answerable = proposal.answerableFor(me);
  const options = ['Not yet', 'Agree', 'Object'].map(label => ({ label, description: '' }));
  step(input, me, st => ({
    type: 'answered',
    note: st.note ? card.answerCard(firstQuestion(proposal.confirmCard(st.note)), r, input.tool_input) : { kind: 'absent' },
    target: st.note ? targetOf(me, st.note.hash) : null,
    afk: !!(r.afkTimeoutMs || r.followUp), asked,
    answers: keys.map(k => {
      const [, hash = ''] = proposal.QUESTION_RE.exec(k) ?? []; // keys passed QUESTION_RE (its group always matches)
      return { hash, answer: card.answerCard({ question: k, options }, r, input.tool_input, { exact: false }), live: answerable.some(p => p.hash === hash) };
    }),
  }));
}

/** Post(AskUserQuestion) for a join request's card (lib/remote/admission.ts): "Let in" admits the machine (signed with
 * the seat key), "Refuse" ends the request; AFK, another answer or an edited card records nothing. False when the call
 * was not that card. */
function postAdmit(input: ConsentIn, me: Identity, r: ToolResponse): boolean {
  if (!c.identity.isHost(me.code)) return false;
  const asked = [...(Array.isArray(r.questions) ? r.questions as CardQuestion[] : []), ...((input.tool_input && input.tool_input.questions) ?? [])];
  const m = asked.map(q => /\(admit ([0-9a-f]{12})\)$/.exec(String(q && q.question))).find(Boolean);
  const ref = m && m[1];
  if (!ref) return false; // the group always matches when m does
  const adm = admission;
  const req = adm.find(me.code, ref);
  const say = (t: string, top?: HookOutput) => c.context('PostToolUse', t, top);
  const S = review.SAY;
  if (!req) return say(S.admitUnknown(ref, me.code)), true;
  const got = card.answerCard(firstQuestion(adm.card(req, me.code)), r, input.tool_input);
  if (got.kind !== 'answer') return say(S.admitNoAnswer(me.name, req.name, req.ref)), true;
  try {
    if (got.label === adm.REFUSE) {
      adm.refuse(me.code, req.ref, { by: me.name });
      return say(S.admitRefused(me.name, req.name)), true;
    }
    const [, as] = /^Let in as (\S+)$/.exec(String(got.label)) ?? [];
    const res = adm.letIn(me.code, req.ref, { by: me.name, ...(as ? { as } : {}), sign: p => envelope.sign(p, roomStore.humanKey(me.code, me.name), { room: me.code, from: me.name }) });
    say(S.admitLetIn(me.name, as ? as : req.name, me.code), { systemMessage: `sub-human: ${res.text}` });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    say(S.admitFailed(me.name, why), { systemMessage: `sub-human: ${req.name} was not let in: ${why}` });
  }
  return true;
}

/**
 * The mode EnterPlanMode was called in, as the plugin's own PreToolUse command hook noted it (hooks.json: it reads the
 * call's permission_mode, which the module's event lacks) at <home>/sessions/mode/<sid>, taken once and only while
 * fresh; else the payload's (the module's last-seen mode, stale after the person's shift+tab mid-turn).
 */
function modeAtEnter(input: ConsentIn): string | undefined {
  const sid = input.session_id;
  if (typeof sid !== 'string' || !/^[\w-]+$/.test(sid)) return input.permission_mode;
  const file = `${c.identity.home()}/sessions/mode/${sid}`;
  try {
    const st = fs.statSync(file);
    const mode = fs.readFileSync(file, 'utf8').trim();
    fs.rmSync(file, { force: true });
    if (Date.now() - st.mtimeMs < MODE_FRESH_MS && /^[A-Za-z]+$/.test(mode)) return mode;
  } catch { /* none noted */ }
  return input.permission_mode;
}
const MODE_FRESH_MS = 10_000;

function preEnter(input: ConsentIn, me: Identity) {
  input = { ...input, permission_mode: modeAtEnter(input) };
  step(input, me, st => {
    const base = { mode: input.permission_mode, reviewable: reviewable(input), plan: { file: null, text: null } };
    if (st.review && st.review.phase === 'restore') return { type: 'enter', ...base, pending: [], said: null, named: null };
    const ps = proposal.pendingFor(me).filter(p => proposal.viewable(p, me.code));
    if (!ps.length || !base.reviewable) return { type: 'enter', ...base, pending: [], said: null, named: null };
    // the request the person's latest prompt names (cc.lastHumanPrompt: only their own words), else the oldest
    const said = cc.lastHumanPrompt(lines(input));
    const hit = said ? proposal.namedIn(ps, said.text, me.code) : null;
    return { type: 'enter', ...base, pending: pendingOf(me, ps), said, named: hit ? hit.hash : null, plan: planOf(input) };
  });
}

/** "proposal HASH" (the stub the model is told to pass), as a plan's whole text: the hash, or null. */
const stubHash = (t: unknown): string | null => {
  const m = typeof t === 'string' ? /^\s*(?:the room )?proposal\s+([0-9a-f]{6,12})\s*\.?\s*$/i.exec(t) : null;
  return m?.[1] ?? null; // the group always matches when m does
};

function preExit(input: ConsentIn, me: Identity) {
  step(input, me, st => {
    const r = st.review;
    const ev = { type: 'exit' as const, toolUseId: input.tool_use_id || null, ...answerFacts(input, me, r, 'exit'),
      shown: null, text: null, plan: { file: null, text: null }, callPlan: undefined, ownPlan: undefined, mode: input.permission_mode, stub: null,
      typing: input.sub_human_typing === true };
    if (!r) {
      // no review opened (plan mode by hand, EnterPlanMode skipped), and the plan is a proposal's name: its review
      // opens here (lib/consent/review.ts exit with stub), else the call is denied: never a bare view of the name
      const ti: ConsentToolInput = input.tool_input ?? {};
      const plan = planOf(input);
      const own = modelInput(input);
      const word = stubHash(ti.plan) || stubHash(plan.text) || stubHash(own && own.plan);
      if (!word) return ev;
      // the mode is plan already (the person's); a dialog whose Yes clears the context is still no place for a review
      const p = !ccEnv.clearContextOnPlanAccept(input.cwd) ? proposal.pendingFor(me).filter(x => proposal.viewable(x, me.code)).find(x => x.hash.startsWith(word)) : undefined;
      if (!p) return { ...ev, stub: { hash: word, live: false } };
      return { ...ev, stub: { hash: p.hash, live: true }, shown: { hash: p.hash, from: p.from || null }, text: proposal.read(me.code, p.hash),
        plan, callPlan: ti.plan, ownPlan: own && own.plan };
    }
    if (r.phase !== 'entering') return ev;
    const p = proposal.pendingFor(me).filter(x => proposal.viewable(x, me.code)).find(x => x.hash === r.hash);
    const ti: ConsentToolInput = input.tool_input ?? {};
    // A blank plan: the call's transcript line may not be written yet (2.1.292 runs this hook first), so wait for it.
    const own = blank(ti.plan) && input.tool_use_id ? polled(input, () => modelInput(input)) : modelInput(input);
    return { ...ev, shown: p ? { hash: p.hash, from: p.from || null } : null, text: p ? proposal.read(me.code, p.hash) : null,
      plan: planOf(input), callPlan: ti.plan, ownPlan: own && own.plan };
  });
}

function postExit(input: ConsentIn, me: Identity) {
  step(input, me, st => {
    const r = st.review;
    const res = responseOf(input);
    const ti: ConsentToolInput = input.tool_input ?? {};
    const ev = { type: 'exited' as const, toolUseId: input.tool_use_id || null, mode: input.permission_mode, ...answerFacts(input, me, r, 'exited'),
      response: { plan: res.plan, edited: !!res.planWasEdited, isAgent: !!res.isAgent, filePath: res.filePath }, callPlan: ti.plan,
      pending: [] as Pending[], callNames: [] as string[], reviewable: reviewable(input) };
    if (r && r.phase !== 'entering') return { ...ev, target: ev.target ?? targetOf(me, r.hash) };
    // no review shown: the dialog may still have been a pending proposal's (unshown), or the person's own plan
    const ps = proposal.pendingFor(me);
    const plan = typeof res.plan === 'string' ? res.plan : typeof ti.plan === 'string' ? ti.plan : '';
    return { ...ev, pending: pendingOf(me, ps), callNames: plan.length < 300 ? named(ps, callOf([ti, modelInput(input)])).map(p => p.hash) : [] };
  });
}

function permExit(input: ConsentIn, me: Identity) { step(input, me, () => ({ type: 'permission' })); }
function postEnter(input: ConsentIn, me: Identity) { step(input, me, st => ({ type: 'entered', plan: st.review && st.review.phase === 'entering' ? planOf(input) : { file: null, text: null } })); }
function preRoomTool(input: ConsentIn, me: Identity) {
  step(input, me, st => ({ type: 'roomTool', mode: input.permission_mode, ...answerFacts(input, me, st.review, 'roomTool'),
    post: POST_TOOL.test(String(input.tool_name || '')), noteLive: !!st.note && isPending(me, st.note.hash) }));
}
/** The dialog's rejection, reported by the module (mod/consent.ts) as a PostToolUseFailure of the ExitPlanMode call:
 * the note from the transcript's tool_result, else from the refusal's own text (the line may not be on disk yet). */
function rejectedExit(input: ConsentIn, me: Identity) {
  step(input, me, st => {
    const id = input.tool_use_id || null;
    const fromDisk = id ? cc.planAnswer(lines(input), id) : null;
    const answer = fromDisk ?? cc.rejectionAnswer(typeof input.error === 'string' ? input.error : '');
    return { type: 'rejected', toolUseId: id, answer, target: st.review ? targetOf(me, st.review.hash) : null };
  });
}
function stop(input: ConsentIn, me: Identity) {
  step(input, me, st => ({ type: 'stop', mode: input.permission_mode, active: !!input.stop_hook_active, ...answerFacts(input, me, st.review, 'stop'),
    live: !st.review && !!st.note && isPending(me, st.note.hash) }));
}
function prompt(input: ConsentIn, me: Identity) {
  step(input, me, st => ({ type: 'prompt', mode: input.permission_mode, ...answerFacts(input, me, st.review, 'prompt'),
    live: !st.review && !!st.note && isPending(me, st.note.hash) }));
}

// ---------- a room plan edit (lib/consent/edit.ts) ----------
/** A line the module appends to this run's plan_mode attachment (shim mode: subHuman.attach). */
let attachOut = '';

/** lib/plans.ts put's answer as the edit reducer reads it; a link that did not answer is offline. */
function putOutcome(me: Identity, e: Extract<edit.EditEffect, { do: 'put' }>): edit.PutOutcome {
  let r: plans.Put;
  try { r = plans.request(me.code, { plan: e.plan, base: e.base, text: e.text, summary: e.summary }, me.name); } catch (err) {
    if (err instanceof c.room.RoomError) return { kind: err.code === 'OFFLINE' ? 'offline' : 'refused', why: err.message };
    throw err;
  }
  if (r.ok) return { kind: 'stored', version: r.version.version, ...(r.unchanged ? { unchanged: true } : {}) };
  if (r.conflict) return { kind: 'conflict', version: r.conflict.version.version, who: plans.who(r.conflict.version), summary: r.conflict.version.summary, text: r.conflict.text };
  return { kind: 'refused', why: r.error };
}

/** The seat's edit, reduce one event, run the effects (a put's answer reduced in turn), store the edit, write the say.
 * Returns whether it said anything (Stop and a prompt then skip the review's step). */
function editStep(input: ConsentIn, me: Identity, ev: edit.EditEvent): boolean {
  const start = proposal.readEdit(me);
  let cur = edit.reduce(start, ev);
  let state = cur.edit;
  let say = cur.say;
  const queue: edit.EditEffect[] = [...cur.effects];
  for (let e = queue.shift(); e; e = queue.shift()) {
    if (e.do === 'save') proposal.writeEdit(me, e.edit);
    else if (e.do === 'restorePlan') proposal.restorePlan({ phase: 'exiting', file: e.file, backup: e.backup, restored: false });
    else if (e.do === 'blankPlan') blankPlan(e.file);
    else if (e.do === 'seed') {
      const base = e.base ? (r => r.fold(r.readRecent()))(c.room.open(me.code)).plans.get(e.plan)?.versions.find(v => v.version === e.base) : undefined;
      writeFileAtomic(e.file, edit.seed(me.code, e.plan, e.base, base ? plans.textOf(me.code, base) : null));
    } else if (e.do === 'put') {
      cur = edit.reduce(state, { type: 'put', outcome: putOutcome(me, e) });
      state = cur.edit;
      say = cur.say;
      queue.push(...cur.effects);
    }
  }
  if (JSON.stringify(state) !== JSON.stringify(start)) { if (state) proposal.writeEdit(me, state); else proposal.clearEdit(me); }
  if (!say) return false;
  const event = String(input.hook_event_name);
  switch (say.to) {
    case 'context': c.context(event, say.text); break;
    case 'deny': c.deny(say.text); break;
    case 'allow': c.pre('allow', say.text); break;
    case 'permit': c.out(ccEnv.leavePlanMode(say.mode)); break;
    case 'attach': if (event === ccEnv.PLAN_ATTACHMENT_EVENT) attachOut = say.text; else c.context(event, say.text); break;
  }
  return true;
}

/** The plan file of a plan_mode attachment (the module's PlanAttachment payload) and what it holds. */
function attachedPlan(input: ConsentIn): { file: string | null; text: string | null } {
  const file = typeof input.plan_file_path === 'string' && input.plan_file_path ? input.plan_file_path : null;
  let text: string | null = null;
  if (file) { try { text = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ } }
  return { file, text };
}

/** An edit open in this session (none while a review is: the plan tool refuses an edit then). One left longer than
 * REVIEW_STALE_MS is dropped here, its plan file restored. */
function openEdit(me: Identity): PlanEdit | null {
  const e = proposal.readEdit(me);
  if (!e || proposal.readReview(me)) return null;
  if (Date.now() - (Number(e.at) || 0) > config.REVIEW_STALE_MS) {
    if (e.file && !e.restored) proposal.restorePlan({ phase: 'exiting', file: e.file, backup: typeof e.backup === 'string' ? e.backup : null, restored: false });
    proposal.clearEdit(me);
    return null;
  }
  return e;
}

/** The edit's events, while one is open: true when the edit took this event (plan mode is the edit's). */
function routeEdit(input: ConsentIn, me: Identity): boolean {
  const ev = input.hook_event_name, tool = input.tool_name;
  if (!openEdit(me)) return false;
  if (ev === ccEnv.PLAN_ATTACHMENT_EVENT) return editStep(input, me, { type: 'attach', plan: attachedPlan(input) }), true;
  if (tool === 'EnterPlanMode' && ev === 'PreToolUse') return editStep(input, me, { type: 'enter', mode: modeAtEnter(input) }), true;
  if (tool === 'EnterPlanMode' && ev === 'PostToolUse') return editStep(input, me, { type: 'attach', plan: planOf(input) }), true;
  if (tool === 'ExitPlanMode' && ev === 'PreToolUse') {
    const ti: ConsentToolInput = input.tool_input ?? {};
    return editStep(input, me, { type: 'exit', plan: planOf(input), text: typeof ti.plan === 'string' ? ti.plan : null }), true;
  }
  if (tool === 'ExitPlanMode' && ev === 'PermissionRequest') return editStep(input, me, { type: 'permission' }), true;
  if (tool === 'ExitPlanMode' && ev === 'PostToolUse') return editStep(input, me, { type: 'exited' }), true;
  if (tool === 'ExitPlanMode' && ev === 'PostToolUseFailure') return true; // a dialog refused: an edit shows none
  if (ev === 'Stop') return editStep(input, me, { type: 'stop', mode: input.permission_mode, active: !!input.stop_hook_active });
  if (ev === 'UserPromptSubmit') return editStep(input, me, { type: 'prompt', mode: input.permission_mode });
  return false;
}

/** Every event consent handles, for one hook input; an answer not recorded is told to the person (systemMessage). */
function dispatch(input: ConsentIn): void {
  unsent = [];
  attachOut = '';
  const r = c.capture(() => route(input));
  const note = unsent.length ? { systemMessage: `sub-human: ${unsent.join(' ')}` } : null;
  r.outputs.forEach((o, i) => c.out(note && i === 0 ? { ...o, ...note } : o));
  if (note && !r.outputs.length) c.out(note);
  if (r.threw) throw r.error;
}

function route(input: ConsentIn) {
  const me = c.whoami(input);
  if (!me) return;
  const ev = input.hook_event_name, tool = input.tool_name;
  const locked = (fn: (input: ConsentIn, me: Identity) => unknown) => proposal.withReview(me, () => fn(input, me));
  if (proposal.withReview(me, () => routeEdit(input, me))) return undefined;
  if (ev === ccEnv.PLAN_ATTACHMENT_EVENT) return undefined;
  if (tool === 'AskUserQuestion' && ev === 'PreToolUse') return locked(preAsk);
  if (tool === 'AskUserQuestion' && ev === 'PostToolUse') return locked(postAsk);
  if (tool === 'EnterPlanMode' && ev === 'PreToolUse') return locked(preEnter);
  if (tool === 'EnterPlanMode' && ev === 'PostToolUse') return locked(postEnter);
  if (tool === 'ExitPlanMode' && ev === 'PreToolUse') return locked(preExit);
  if (tool === 'ExitPlanMode' && ev === 'PermissionRequest') return locked(permExit);
  if (tool === 'ExitPlanMode' && ev === 'PostToolUse') return locked(postExit);
  if (tool === 'ExitPlanMode' && ev === 'PostToolUseFailure') return locked(rejectedExit);
  if (/^mcp__plugin_sub-human_room__/.test(tool || '') && ev === 'PreToolUse') return locked(preRoomTool);
  if (ev === 'Stop') return locked(stop);
  if (ev === 'UserPromptSubmit') return locked(prompt);
  return undefined;
}

/** The UserPromptSubmit handler (hooks/handlers/prompt.ts runs it after at-room.ts's, in one process). */
const onPrompt = (input: ConsentIn): void => { dispatch({ ...input, hook_event_name: 'UserPromptSubmit' }); };

/** True when this session's seat has a room plan edit open, a review on record or a note consent must still offer
 * (review.openOf), so the module still runs node at the next turn end, prompt or plan_mode attachment; false with no seat. noteWaits: any note of the seat waits for
 * its card (a room post is refused meanwhile). */
function reviewOpen(input: ConsentIn): boolean {
  const me = c.whoami(input);
  if (!me) return false;
  return !!proposal.readEdit(me) || review.openOf({ review: proposal.readReview(me), note: proposal.readConfirm(me) });
}
function noteWaits(input: ConsentIn): boolean {
  const me = c.whoami(input);
  return !!me && !!proposal.readConfirm(me);
}

/**
 * Shim mode (SUB_HUMAN_SHIM=1: the hooks module ran this hook, mod/consent.ts): the one output also carries
 * subHuman {reviewOpen}, so the mod knows whether the next turn end needs consent at all. Printed even when the
 * handler had nothing to say; an error leaves it out (the mod then stays unsure).
 */
function shimDispatch(input: ConsentIn) {
  const r = c.capture(() => dispatch(input));
  if (r.threw) throw r.error;
  const outputs = r.outputs.filter(Boolean);
  const last = outputs.pop() ?? {};
  for (const o of outputs) process.stdout.write(JSON.stringify(o) + '\n');
  c.out({ ...last, subHuman: { reviewOpen: reviewOpen(input), noteWaits: noteWaits(input), ...(attachOut ? { attach: attachOut } : {}) } });
}

/** Run by the hooks module (mod/core/shim.ts SHIM_MODE). */
const SHIM = (): boolean => env.envFlag('SUB_HUMAN_SHIM');

/** Every event consent handles past the entry's quiet exit (hooks/handlers/consent.ts). */
function run(input: ConsentIn): void {
  (SHIM() ? shimDispatch : dispatch)(input);
}

export { run, dispatch, onPrompt, reviewOpen, SHIM };
export type { ConsentIn };
