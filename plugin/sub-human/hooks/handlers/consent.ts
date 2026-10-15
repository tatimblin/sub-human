/**
 * plugin/sub-human/hooks/handlers/consent.ts: consent. A proposal opens in Claude Code's own plan-approval dialog (the
 * native, scrollable plan view: PgUp/PgDn read all of it); the AskUserQuestion card is the fallback. Only the person's
 * answer there records anything (via=human, signed with the seat key).
 *
 * What happens is decided by one pure reducer, lib/consent/review.ts (its header has the phases, the note's stages,
 * every event and effect, and every line the model is told). This file only gathers each event's facts, under the
 * review lock (proposal.withReview): the transcript (cc: the person's latest prompt, the dialog's answer, the model's
 * own input, the plan file), the room (pending and answerable proposals, the join requests and handoff asks waiting);
 * then runs the effects (plan-file backup, write and restore, the pick, lib/proposal.ts answer then decide), stores the
 * state (members/NAME/review, members/NAME/confirm) and writes the answer.
 *
 * The cards: a join request's (lib/remote/admission.ts, on the host: "Let in" admits the machine, signed with the seat
 * key; "Refuse" ends it) and the handoff's (lib/handoff.ts: "Host it here" moves the room here, "Not now" refuses) are
 * read like the note's and the fallback consent card, through lib/consent/card.ts answerCard: only the person's answer
 * on the card as the hooks built it counts; AFK, a followUp, another answer or an edited card records nothing.
 *
 * The plan file: cc.planFile, Claude Code's own record of it (the transcript's plan_mode attachment), or the path
 * Claude Code injects into ExitPlanMode's input when it is that path or under the plans dir; never a key the model put
 * in another call (the hooks write the proposal there).
 *
 * An answer the room refuses (OFFLINE, AUTH) is never lost silently: a systemMessage tells the person, the context the
 * model. Run with SUB_HUMAN_SHIM=1 (mod/consent.ts) the output also carries subHuman {reviewOpen}. Outside plan mode
 * the room-tool entry exits before loading anything else.
 */

import { createRequire } from 'node:module';
import * as reply from '../reply.ts';
import type { AnyHookIn, CardQuestion, HookOutput, Recorded } from '../types.ts';
import type { Proposal, Review } from '../../lib/types-app.ts';
import type { Identity } from '../../lib/identity.ts';
import type { Effect, Event, Pending, Say, State, Target } from '../../lib/consent/review.ts';
import type { CardResponse } from '../../lib/consent/card.ts';

/** The tool call's input, as far as consent reads it (untrusted: each field checked). */
interface ConsentToolInput { plan?: unknown; questions?: CardQuestion[]; planFilePath?: unknown }
/** AskUserQuestion's or ExitPlanMode's response, as far as consent reads it. */
interface ToolResponse extends CardResponse { plan?: unknown; planWasEdited?: unknown; isAgent?: unknown; filePath?: unknown }
/** Every event consent handles (PreToolUse, PostToolUse, PermissionRequest, Stop, UserPromptSubmit), with the
 * transcript's lines once read (lines()). */
type ConsentIn = Omit<AnyHookIn, 'tool_input'> & { tool_input?: ConsentToolInput; _lines?: string[] | null };
/** An invite's join request waiting on the host (lib/remote/admission.ts pending). */
type JoinRequest = ReturnType<typeof import('../../lib/remote/admission.ts')['pending']>[number];

// The rest of this file's modules load only past the quiet exit in handle(), so they are required (createRequire:
// require(esm) is synchronous and caches like an import) by load(), not imported: a static import would load them first.
const require = createRequire(import.meta.url);

/** A room tool call outside plan mode: the reducer acts on one only in plan mode, so nothing else needs loading. */
const quiet = (input: AnyHookIn | undefined) => !!input && input.hook_event_name === 'PreToolUse' && input.permission_mode !== 'plan'
  && /^mcp__plugin_sub-human_room__/.test(String(input.tool_name || ''));

/** The output helpers (hooks/reply.ts), the seat, the room and identity: what this file calls `c.`. */
type C = typeof reply & { whoami: typeof import('../seat.ts')['whoami']; room: typeof import('../../lib/room.ts'); identity: typeof import('../../lib/identity.ts') };
let fs!: typeof import('node:fs');
let c!: C;
let proposal!: typeof import('../../lib/proposal.ts');
let review!: typeof import('../../lib/consent/review.ts');
let card!: typeof import('../../lib/consent/card.ts');
let cc!: typeof import('../../lib/cc/transcript.ts');
let ccEnv!: typeof import('../../lib/cc/env.ts');
let writeFileAtomic!: typeof import('../../lib/io.ts')['writeFileAtomic'];
let config!: typeof import('../../lib/config.ts');
let handoff!: typeof import('../../lib/handoff.ts');
let envelope!: typeof import('../../lib/room/envelope.ts');
let roomStore!: typeof import('../../lib/room/store.ts');

/** Everything past the quiet exit, once. It signs the person's answers (via=human), so it arms the seat-key signer. */
function load() {
  if (c) return;
  fs = require('node:fs');
  c = { ...reply, whoami: (require('../seat.ts') as typeof import('../seat.ts')).whoami, room: require('../../lib/room.ts'), identity: require('../../lib/identity.ts') };
  proposal = require('../../lib/proposal.ts');
  review = require('../../lib/consent/review.ts');
  card = require('../../lib/consent/card.ts');
  cc = require('../../lib/cc/transcript.ts');
  ccEnv = require('../../lib/cc/env.ts');
  ({ writeFileAtomic } = require('../../lib/io.ts') as typeof import('../../lib/io.ts'));
  config = require('../../lib/config.ts');
  handoff = require('../../lib/handoff.ts');
  envelope = require('../../lib/room/envelope.ts');
  roomStore = require('../../lib/room/store.ts');
  (require('../seat-key.ts') as typeof import('../seat-key.ts')).arm();
}
const admission = (): typeof import('../../lib/remote/admission.ts') => require('../../lib/remote/admission.ts');

/** Answers this run could not record, for the person (dispatch puts them in the output's systemMessage). */
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
  if (!input._lines) input._lines = cc.readLines(input.transcript_path, { tailBytes: config.TRANSCRIPT_TAIL_BYTES });
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
  const until = Date.now() + config.envMs('SUB_HUMAN_EXIT_INPUT_WAIT_MS', config.EXIT_INPUT_WAIT_MS);
  for (;;) {
    const v = read();
    if (v || Date.now() >= until) return v;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, config.EXIT_INPUT_POLL_MS);
    input._lines = null; // read the tail again
  }
}
const blank = (v: unknown) => v == null || (typeof v === 'string' && !v.trim());
const responseOf = (input: ConsentIn): ToolResponse => (input.tool_response && typeof input.tool_response === 'object' ? input.tool_response as ToolResponse : {});

/**
 * How the review's dialog closed (cc.planAnswer), when the reducer needs it for this event (review.answerNeeded):
 * {note} with the person's "Tell Claude what to change" note, or note null (Esc); null while its tool_result is not on
 * disk ('wait': polled for, the dialog has closed and the line may not be written yet). Plus the review's proposal
 * while this seat may still answer it.
 */
function answerFacts(input: ConsentIn, me: Identity, r: Review | null, type: Event['type']) {
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
function callOf(input: unknown) {
  const text = JSON.stringify(input || {});
  return { text, tokens: text.match(/[0-9a-f]{6,12}/g) || [], words: text.match(/\b[0-9a-f]{6,12}\b/g) || [] };
}
type Call = ReturnType<typeof callOf>;
/** Pending proposals the call names (a hash, or a 6–12 hex prefix of exactly one), oldest first. */
const named = (pending: Proposal[], call: Call): Proposal[] => pending.filter(p => call.text.includes(p.hash)
  || call.tokens.some(t => p.hash.startsWith(t) && pending.filter(q => q.hash.startsWith(t)).length === 1));
/**
 * No hash named, but the question is plainly about a proposal ("Do you agree with the paging proposal?") and exactly
 * one is pending, and the call names no other hex id: that one (the model may drop the hash). A question about
 * something else (no "propos…") or an ambiguous one (two pending) must not become a consent card.
 */
function onlyPending(pending: Proposal[], call: Call): Proposal[] {
  if (pending.length !== 1 || !/propos/i.test(call.text)) return [];
  return call.words.some(t => /[a-f]/.test(t) && /\d/.test(t) && !pending[0].hash.startsWith(t)) ? [] : pending;
}
/** The handoff waiting for me, when this card call is about it (it says "handoff", or carries the card's question). */
function handoffAsked(me: Identity, call: Call) {
  const a = handoff.pendingAsk(me.code, me.name);
  return a && (/handoff/i.test(call.text) || call.text.includes(handoff.question(a, me.code))) ? a : null;
}
/** A join request waiting for me on the host, when this card call is about it (it names its ref, or carries the card's
 * question, or says "admit" while exactly one waits). */
function admitAsked(me: Identity, call: Call): JoinRequest | null {
  if (!c.identity.isHost(me.code) || !/admit|join/i.test(call.text)) return null;
  const adm = admission();
  const reqs = adm.pending(me.code).filter(q => adm.targets(me.code, q).includes(me.name));
  const hit = reqs.find(q => call.text.includes(q.ref) || call.text.includes(adm.question(q, me.code)) || call.words.some(t => q.ref.startsWith(t)));
  return hit || (/\badmit\b/i.test(call.text) && reqs.length === 1 ? reqs[0] : null);
}

// ---------- running a step ----------
type Out = { say: Say | null; show?: { admit?: JoinRequest; handoff?: ReturnType<typeof handoff.pendingAsk>; card?: Proposal[] } };

/** The seat's state, reduce one event (made from it), run the effects, store the state, write the answer. */
function step(input: ConsentIn, me: Identity, make: (st: State) => Event, show: Out['show'] = {}) {
  const start: State = { review: proposal.readReview(me), note: proposal.readConfirm(me) };
  const ctx = { name: me.name, now: Date.now() };
  const first = review.reduce(start, make(start), ctx);
  let state = first.state;
  let say = first.say;
  const disk = { review: JSON.stringify(start.review), note: JSON.stringify(start.note) };
  const answers = new Map<string, { choice: 'Agree' | 'Object'; res: Recorded }>();
  const queue: Effect[] = [...first.effects];
  for (let e = queue.shift(); e; e = queue.shift()) {
    if (e.do === 'save') { proposal.writeReview(me, e.review); disk.review = JSON.stringify(e.review); }
    else if (e.do === 'restorePlan') proposal.restorePlan({ phase: 'exiting', file: e.file, backup: e.backup, restored: false });
    else if (e.do === 'pick') proposal.writePick(me, e.hash);
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
    case 'permit': return c.out({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: {},
      updatedPermissions: [{ type: 'setMode', mode: say.mode, destination: 'session' }] } } });
    case 'ask': {
      const s = say.show;
      if ('plan' in s) return c.pre('ask', say.text, { updatedInput: { plan: proposal.read(me.code, s.plan) } });
      if ('note' in s) return state.note && c.pre('ask', say.text, { updatedInput: proposal.confirmCard(state.note) });
      if ('admit' in s && show.admit) return c.pre('ask', `room ${me.code}: ${show.admit.name} asks to join`, { updatedInput: admission().card(show.admit, me.code) });
      if ('handoff' in s && show.handoff) return c.pre('ask', `room ${me.code}: ${show.handoff.from} asks ${me.name} to host it`, { updatedInput: handoff.card(show.handoff, me.code) });
      if ('card' in s && show.card) return c.pre('ask', say.text, { updatedInput: proposal.cardFor(show.card, me.code) });
    }
  }
}

// ---------- the events ----------
function preAsk(input: ConsentIn, me: Identity) {
  const call = callOf(input.tool_input);
  const ad = admitAsked(me, call);
  const ho = ad ? null : handoffAsked(me, call);
  const pending = proposal.pendingFor(me);
  let hit = named(pending, call);
  if (!hit.length) hit = onlyPending(pending, call);
  step(input, me, st => {
    const cf = st.note;
    const q = cf ? proposal.confirmQuestion(cf) : null;
    const qs = input.tool_input && input.tool_input.questions;
    const noteNamed = !!cf && ((Array.isArray(qs) && qs.some(x => x && x.question === q)) || call.tokens.some(t => cf.hash.startsWith(t)));
    return { type: 'ask', admit: ad ? ad.ref : null, handoff: !!ho, noteNamed,
      live: !!cf && proposal.answerableFor(me).some(p => p.hash === cf.hash), hit: pendingOf(me, hit), reviewable: reviewable(input) };
  }, { admit: ad || undefined, handoff: ho || undefined, card: hit });
}

function postAsk(input: ConsentIn, me: Identity) {
  const r = responseOf(input);
  if (postAdmit(input, me, r) || postHandoff(input, me, r)) return;
  const asked = [...(Array.isArray(r.questions) ? r.questions as CardQuestion[] : []), ...((input.tool_input && input.tool_input.questions) || [])]
    .some(q => q && proposal.QUESTION_RE.test(String(q.question)));
  const keys = r.answers && typeof r.answers === 'object' ? Object.keys(r.answers).filter(k => proposal.QUESTION_RE.test(k)) : [];
  const answerable = proposal.answerableFor(me);
  const options = ['Not yet', 'Agree', 'Object'].map(label => ({ label, description: '' }));
  step(input, me, st => ({
    type: 'answered',
    note: st.note ? card.answerCard(proposal.confirmCard(st.note).questions[0], r, input.tool_input) : { kind: 'absent' },
    target: st.note ? targetOf(me, st.note.hash) : null,
    afk: !!(r.afkTimeoutMs || r.followUp), asked,
    answers: keys.map(k => {
      const hash = k.match(proposal.QUESTION_RE)![1]; // keys passed QUESTION_RE
      return { hash, answer: card.answerCard({ question: k, options }, r, input.tool_input, { exact: false }), live: answerable.some(p => p.hash === hash) };
    }),
  }));
}

/** Post(AskUserQuestion) for the handoff card: "Host it here" moves the room here (lib/handoff.ts accept), "Not now"
 * refuses; AFK or another answer records nothing. False when the call was not the handoff card. */
function postHandoff(input: ConsentIn, me: Identity, r: ToolResponse): boolean {
  const a = handoff.pendingAsk(me.code, me.name);
  if (!a) return false;
  const got = card.answerCard(handoff.card(a, me.code).questions[0], r, input.tool_input);
  if (got.kind === 'absent') return false;
  const say = (t: string, top?: HookOutput) => c.context('PostToolUse', t, top);
  const S = review.SAY;
  if (got.kind !== 'answer') return say(S.handoffNoAnswer(me.name)), true;
  if (got.label === handoff.NO) {
    const res = handoff.refuse(me);
    return say(res.ok ? S.handoffDeclined(me.name, me.code, a.from) : S.handoffUntold(me.name, String(res.error))), true;
  }
  const res = handoff.accept(me, { cwd: input.cwd, sign: (p: Record<string, unknown>) => envelope.sign(p, roomStore.humanKey(me.code, me.name), { room: me.code, from: me.name }) });
  if (!res.ok) return say(S.handoffFailed(me.name, String(res.error)), { systemMessage: `sub-human: room ${me.code} did not move here: ${res.error}` }), true;
  say(S.handoffMoved(me.name, me.code),
    { systemMessage: `sub-human: room ${me.code} is hosted on this machine now, and its Claude runs on your Claude account. Keep this machine reachable for the others${res.note}` });
  return true;
}

/** Post(AskUserQuestion) for a join request's card (lib/remote/admission.ts): "Let in" admits the machine (signed with
 * the seat key), "Refuse" ends the request; AFK, another answer or an edited card records nothing. False when the call
 * was not that card. */
function postAdmit(input: ConsentIn, me: Identity, r: ToolResponse): boolean {
  if (!c.identity.isHost(me.code)) return false;
  const asked = [...(Array.isArray(r.questions) ? r.questions as CardQuestion[] : []), ...((input.tool_input && input.tool_input.questions) || [])];
  const m = asked.map(q => /\(admit ([0-9a-f]{12})\)$/.exec(String(q && q.question))).find(Boolean);
  if (!m) return false;
  const adm = admission();
  const req = adm.find(me.code, m[1]);
  const say = (t: string, top?: HookOutput) => c.context('PostToolUse', t, top);
  const S = review.SAY;
  if (!req) return say(S.admitUnknown(m[1], me.code)), true;
  const got = card.answerCard(adm.card(req, me.code).questions[0], r, input.tool_input);
  if (got.kind !== 'answer') return say(S.admitNoAnswer(me.name, req.name, req.ref)), true;
  try {
    if (got.label === adm.REFUSE) {
      adm.refuse(me.code, req.ref, { by: me.name });
      return say(S.admitRefused(me.name, req.name)), true;
    }
    const res = adm.letIn(me.code, req.ref, { by: me.name, sign: p => envelope.sign(p, roomStore.humanKey(me.code, me.name), { room: me.code, from: me.name }) });
    say(S.admitLetIn(me.name, req.name, me.code), { systemMessage: `sub-human: ${res.text}` });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    say(S.admitFailed(me.name, why), { systemMessage: `sub-human: ${req.name} was not let in: ${why}` });
  }
  return true;
}

function preEnter(input: ConsentIn, me: Identity) {
  step(input, me, st => {
    const base = { mode: input.permission_mode, reviewable: reviewable(input), plan: { file: null, text: null } };
    if (st.review && st.review.phase === 'restore') return { type: 'enter', ...base, pending: [], said: null, named: null, replaced: null, kept: null, propose: false };
    const ps = proposal.pendingFor(me).filter(p => proposal.viewable(p, me.code));
    if (!ps.length || !base.reviewable) return { type: 'enter', ...base, pending: [], said: null, named: null, replaced: null, kept: null, propose: false };
    // The person's pick is what their latest prompt names (cc.lastHumanPrompt: only their own words; a peer's or a
    // plugin's prompt keeps the earlier pick); a superseded hash names its latest revision (replaced).
    const said = cc.lastHumanPrompt(lines(input));
    const replaced = said ? proposal.replacedIn(ps, said.text, me.code) : null;
    const hit = said ? proposal.namedIn(ps, said.text, me.code) || (replaced && replaced.p) : null;
    return { type: 'enter', ...base, pending: pendingOf(me, ps), said, named: hit ? hit.hash : null,
      replaced: replaced ? { old: replaced.old, hash: replaced.p.hash } : null, kept: proposal.readPick(me),
      propose: !!said && proposal.proposeIntent(said.text), plan: planOf(input) };
  });
}

function preExit(input: ConsentIn, me: Identity) {
  step(input, me, st => {
    const r = st.review;
    const ev = { type: 'exit' as const, toolUseId: input.tool_use_id || null, ...answerFacts(input, me, r, 'exit'),
      shown: null, text: null, plan: { file: null, text: null }, callPlan: undefined, ownPlan: undefined };
    if (!r || r.phase !== 'entering') return ev;
    const p = proposal.pendingFor(me).filter(x => proposal.viewable(x, me.code)).find(x => x.hash === r.hash);
    const ti: ConsentToolInput = input.tool_input || {};
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
    const ti: ConsentToolInput = input.tool_input || {};
    const ev = { type: 'exited' as const, toolUseId: input.tool_use_id || null, mode: input.permission_mode, ...answerFacts(input, me, r, 'exited'),
      response: { plan: res.plan, edited: !!res.planWasEdited, isAgent: !!res.isAgent, filePath: res.filePath }, callPlan: ti.plan,
      pending: [] as Pending[], callNames: [] as string[], reviewable: reviewable(input), proposed: false };
    if (r && r.phase !== 'entering') return { ...ev, target: ev.target ?? targetOf(me, r.hash) };
    // no review shown: the dialog may still have been a pending proposal's (unshown), or the person's own plan
    const ps = proposal.pendingFor(me);
    const plan = typeof res.plan === 'string' ? res.plan : typeof ti.plan === 'string' ? ti.plan : '';
    const own = typeof res.plan === 'string' && res.plan.trim() ? c.room.hash12(Buffer.from(res.plan, 'utf8')) : null;
    return { ...ev, pending: pendingOf(me, ps), callNames: plan.length < 300 ? named(ps, callOf([ti, modelInput(input)])).map(p => p.hash) : [],
      proposed: !!own && (rm => proposal.proposals(rm.readAll(), rm.trust))(c.room.open(me.code)).some(p => p.hash === own) };
  });
}

function permExit(input: ConsentIn, me: Identity) { step(input, me, () => ({ type: 'permission' })); }
function postEnter(input: ConsentIn, me: Identity) { step(input, me, st => ({ type: 'entered', plan: st.review && st.review.phase === 'entering' ? planOf(input) : { file: null, text: null } })); }
function preRoomTool(input: ConsentIn, me: Identity) { step(input, me, st => ({ type: 'roomTool', mode: input.permission_mode, ...answerFacts(input, me, st.review, 'roomTool') })); }
function stop(input: ConsentIn, me: Identity) {
  step(input, me, st => ({ type: 'stop', mode: input.permission_mode, active: !!input.stop_hook_active, ...answerFacts(input, me, st.review, 'stop'),
    live: !st.review && !!st.note && isPending(me, st.note.hash) }));
}
function prompt(input: ConsentIn, me: Identity) {
  step(input, me, st => ({ type: 'prompt', mode: input.permission_mode, ...answerFacts(input, me, st.review, 'prompt'),
    live: !st.review && !!st.note && isPending(me, st.note.hash) }));
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
  const locked = (fn: (input: ConsentIn, me: Identity) => unknown) => proposal.withReview(me, () => fn(input, me));
  if (tool === 'AskUserQuestion' && ev === 'PreToolUse') return locked(preAsk);
  if (tool === 'AskUserQuestion' && ev === 'PostToolUse') return locked(postAsk);
  if (tool === 'EnterPlanMode' && ev === 'PreToolUse') return locked(preEnter);
  if (tool === 'EnterPlanMode' && ev === 'PostToolUse') return locked(postEnter);
  if (tool === 'ExitPlanMode' && ev === 'PreToolUse') return locked(preExit);
  if (tool === 'ExitPlanMode' && ev === 'PermissionRequest') return locked(permExit);
  if (tool === 'ExitPlanMode' && ev === 'PostToolUse') return locked(postExit);
  if (/^mcp__plugin_sub-human_room__/.test(tool || '') && ev === 'PreToolUse') return locked(preRoomTool);
  if (ev === 'Stop') return locked(stop);
  if (ev === 'UserPromptSubmit') return locked(prompt);
}

/** The UserPromptSubmit handler (hooks/handlers/prompt.ts runs it after at-room.ts's, in one process). */
const onPrompt = (input: ConsentIn) => { load(); dispatch({ ...input, hook_event_name: 'UserPromptSubmit' }); };

/** True when this session's seat has a review on record or a note consent must still offer (review.openOf), so the
 * module still runs node at the next turn end or prompt; false with no seat. */
function reviewOpen(input: ConsentIn): boolean {
  load();
  const me = c.whoami(input);
  if (!me) return false;
  return review.openOf({ review: proposal.readReview(me), note: proposal.readConfirm(me) });
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

/** Every event consent handles, as a hook (hooks/run.ts consent). */
function handle(input: ConsentIn) {
  if (quiet(input)) return;
  load();
  (SHIM() ? shimDispatch : dispatch)(input);
}

/** The error is logged; never block a question or a plan. */
const fail = () => null;

export { handle, fail, dispatch, onPrompt, reviewOpen, SHIM, quiet };
