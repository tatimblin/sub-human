/**
 * plugin/sub-human/lib/consent/review.ts: the consent hook's session-side state machine, as one pure reducer.
 *
 *   reduce(state, event, ctx) -> {state, effects, say}
 * state: {review, note}, the seat's two documents (members/NAME/review: the plan-view review; members/NAME/confirm: a
 * review's note waiting for the person's Send). The room's record of a proposal (who agreed, the decision) is not
 * here: lib/room/consent.ts fold is its one interpretation, and an answer reaches it only through the `answer` effect.
 * hooks/handlers/consent.ts gathers each event's facts (the transcript, the plan file, the room), runs the effects
 * (the lock, plan-file I/O, proposal.answer, the pick), stores the state and writes the say. Nothing here reads a
 * file, the clock or the room.
 *
 * The review (Review.phase), opened only by the hooks and only for a proposal the person's words pick:
 *   (none) ─enter─► entering ─exit─► shown ─exited "Yes"──────────────► (none) | restore (the Yes changed the mode)
 *                      │               │ exit (a closing call) / stop / roomTool / prompt
 *                      │               ▼                                 restore ─enter─► allow; ─stop (mode back)─► (none)
 *                      └─(no plan file, nothing to show)─► exiting ─permission─► (restored, no dialog) ─exited─► (none)
 * A review closed with a note (the dialog's own tool_result, read only once it is on disk: `unread` until then) opens
 * the note; nothing is recorded until the person's Send on its card.
 * The note (Confirm.stage):
 *   waiting ─stop─► nudged ─prompt─► told        asked ─prompt (no Post: Esc)─► reoffered ─stop─► told
 *   waiting|nudged ─ask─► asked ─answered (no answer)─► told; reoffered ─ask─► told; Send / Discard ─► (none)
 *   told ─prompt─► told, the person told once what Send and Discard do (explained); the note keeps waiting
 * A note whose proposal is no longer the seat's to answer is dropped wherever it is met.
 *
 * Events (each carries its facts; ctx {name, now}):
 *   enter      Pre(EnterPlanMode)       mode, reviewable, pending (viewable), said, named, replaced, kept, propose, proposedSince, plan
 *   entered    Post(EnterPlanMode)      plan
 *   exit       Pre(ExitPlanMode)        toolUseId, answer?, target?, shown, text, plan, callPlan, ownPlan, mode?, stub?
 *              stub: the proposal a "proposal HASH" plan names when no review was opened (plan mode entered by hand,
 *              or EnterPlanMode skipped): live, it opens the review here with the person's own plan mode as the mode
 *              to put back (a Yes leaves plan mode: item 7 H); not this seat's to answer, the call is denied, never a
 *              bare plan view of the stub
 *   rejected   the dialog's rejection   toolUseId, answer, target: the person rejected the plan view (with a note, or
 *              none): Claude Code runs no PostToolUse for it, so the module's tool.call hook reports it the moment
 *              ExitPlanMode's call comes back refused (mod/consent.ts). The review resolves there and then: a note
 *              opens, and the model and the person both hear that nothing is recorded until its Send
 *   permission PermissionRequest(ExitPlanMode)
 *   exited     Post(ExitPlanMode)       toolUseId, mode, response, answer?, target?, pending, plan, callNames, reviewable, proposed
 *   stop       Stop                     mode, active, answer?, target?, live
 *   roomTool   Pre(a room MCP tool)     mode, answer?, target?, post, noteLive: while a review is shown or closing, any
 *              room tool is denied; while a note waits for its card, the post tool is (the card decides what the
 *              room gets, so a paraphrase cannot go out first)
 *   prompt     UserPromptSubmit         mode, answer?, target?, live
 *   ask        Pre(AskUserQuestion)     admit, handoff, noteNamed, live, hit, reviewable
 *   answered   Post(AskUserQuestion)    note (lib/consent/card.ts answerCard of its card), target?, afk, asked, answers
 *   planFailed a writePlan effect failed (early: at EnterPlanMode)
 * answerNeeded(review, event) says whether, and how, the handler reads the dialog's answer for an event.
 *
 * Effects, in order: save {review} (a snapshot stored before a plan-file write: the backup is on disk first),
 * writePlan {file, hash, early} (the proposal's text into the session plan file; a failure is the planFailed event),
 * restorePlan {file, backup} (the file back as it was; null backup: removed), pick {hash} (members/NAME/pick),
 * answer {hash, choice, notes?, clearNote?} (lib/proposal.ts answer then decide; clearNote: the note goes on success).
 *
 * say: what the hook answers. context (additionalContext for the event), deny, allow (a PreToolUse allow's reason),
 * ask (a PreToolUse ask with the dialog's input: the proposal as the plan, or a card), permit (PermissionRequest:
 * allow with the mode set back). Its text is parts: a line, {answer: hash} (the answer effect's outcome line), or
 * {ifRecorded} (a line only when an answer was recorded). Every model-facing line is in NEXT and SAY below: the one
 * mechanic to do next per phase, and short outcome lines (mechanics only; CLAUDE.md "Unprescriptive").
 *
 * Later (docs/next/PLAN-COLLAB-IMPL.md, PR4) versions, threads, withdraw and changes_requested are events and fields
 * on this state, not a second model: a revision retargets review.hash as `replaced` does, withdraw closes a review
 * like a proposal that is no longer pending, the note's Send is the changes-requested answer, and every comparison of
 * the dialog's plan with the proposal goes through shownHash (the composed text's hash then).
 */

import { hash12 } from '../text.ts';
import { YES_GUARD_MS } from '../config.ts';
import type { Confirm, NoteStage, Recheck, Review } from '../types-app.ts';
import type { CardAnswer } from './card.ts';

/** recheck: a plan-view Yes that came as the view opened (within YES_GUARD_MS, or while the person had typed text in
 * the prompt), not recorded: the card asks once, and only its answer records (item 8). */
export interface State { review: Review | null; note: Confirm | null; recheck?: Recheck | null }
/** guardMs: YES_GUARD_MS unless the handler says otherwise (the tests shorten it: config.testMs). */
export interface Ctx { name: string; now: number; guardMs?: number }

/** How the review's dialog closed (cc.planAnswer): note null for no note (Esc, a bare deny). */
export interface Answer { note: string | null }
/** The review's proposal while this seat may still answer it (lib/proposal.ts answerableFor). */
export interface Target { hash: string; from: string | null; title: string | null }
/** The session's plan file and what it holds now (null: no file). */
export interface PlanFile { file: string | null; text: string | null }
/** A proposal pending for this seat (lib/proposal.ts pendingFor), oldest first. */
export interface Pending { hash: string; from: string | null; viewable: boolean }
/** The person's latest prompt (cc.lastHumanPrompt). */
export interface Said { text: string; at: number }

export type Event =
  | { type: 'enter'; mode: string | undefined; reviewable: boolean; pending: Pending[]; said: Said | null; named: string | null;
      replaced: { old: string; hash: string } | null; kept: { hash: string | null; at: number } | null; propose: boolean; plan: PlanFile;
      /** a pending proposal of this seat's own made since the person's latest prompt (the propose tool ran): the ask
       * to propose is spent, and that proposal is the one to review */
      proposedSince?: string | null }
  | { type: 'entered'; plan: PlanFile }
  | { type: 'exit'; toolUseId: string | null; answer?: Answer | null; target?: Target | null; shown: { hash: string; from: string | null } | null;
      text: string | null; plan: PlanFile; callPlan: unknown; ownPlan: unknown; mode?: string | undefined;
      stub?: { hash: string; live: boolean } | null;
      /** the person had typed text in the prompt as the view opened (the module's PromptHint isDraft) */
      typing?: boolean }
  | { type: 'permission' }
  | { type: 'exited'; toolUseId: string | null; mode: string | undefined; answer?: Answer | null; target?: Target | null;
      response: { plan: unknown; edited: boolean; isAgent: boolean; filePath: unknown }; callPlan: unknown;
      pending: Pending[]; callNames: string[]; reviewable: boolean; proposed: boolean }
  | { type: 'stop'; mode: string | undefined; active: boolean; answer?: Answer | null; target?: Target | null; live: boolean }
  | { type: 'roomTool'; mode: string | undefined; answer?: Answer | null; target?: Target | null; post?: boolean; noteLive?: boolean }
  | { type: 'rejected'; toolUseId: string | null; answer: Answer | null; target?: Target | null }
  | { type: 'prompt'; mode: string | undefined; answer?: Answer | null; target?: Target | null; live: boolean }
  | { type: 'ask'; admit: string | null; handoff: boolean; noteNamed: boolean; live: boolean; hit: Pending[]; reviewable: boolean }
  | { type: 'answered'; note: CardAnswer; target?: Target | null; afk: boolean; asked: boolean;
      answers: { hash: string; answer: CardAnswer; live: boolean }[] }
  | { type: 'planFailed'; early: boolean };

export type Effect =
  | { do: 'save'; review: Review }
  | { do: 'writePlan'; file: string; hash: string; early: boolean }
  | { do: 'restorePlan'; file: string; backup: string | null }
  | { do: 'pick'; hash: string | null }
  | { do: 'answer'; hash: string; choice: 'Agree' | 'Object'; notes?: string; clearNote?: boolean };

export type Part = string | { answer: string } | { ifRecorded: string };
export type Say =
  | { to: 'context'; parts: Part[] }
  | { to: 'deny'; parts: Part[] }
  | { to: 'allow'; text: string }
  | { to: 'ask'; text: string; show: { plan: string } | { card: string[] } | { note: true } | { admit: string } | { handoff: true } }
  | { to: 'permit'; mode: string | undefined };

/** notice: a line for the person (the hook's systemMessage, a sub-human notice), beside what the model is told. */
export interface Step { state: State; effects: Effect[]; say: Say | null; notice?: string }

/** The hash the dialog's plan must have for an answer to count: the proposal's own (PLAN-COLLAB: the composed text's). */
export const shownHash = (r: Review): string | undefined => r.hash;

// ---------- the words: one mechanic per phase, short outcome lines ----------
/** What the model does next. */
export const NEXT = {
  /** open a proposal in the plan view (the hooks fall back to the card) */
  open: (h: string) => `call EnterPlanMode, then ExitPlanMode with plan "proposal ${h}"`,
  /** entering: show the proposal the hooks picked */
  show: (h: string) => `call ExitPlanMode now with plan "proposal ${h}"`,
  /** shown / exiting: close the review */
  exit: 'call ExitPlanMode now (no plan needed; the hooks close the review)',
  /** restore: put the person's mode back (plan mode: EnterPlanMode alone) */
  restore: (n: string, mode: string | undefined) => (mode === 'plan' ? `call EnterPlanMode to put ${n}'s plan mode back (no dialog)`
    : `call EnterPlanMode, then ExitPlanMode, to restore ${n}'s ${mode} mode (no dialogs)`),
  /** the fallback card */
  card: (h: string) => `call AskUserQuestion with "proposal ${h}"`,
  /** a note's confirm card */
  note: (h: string) => `call AskUserQuestion with "objection ${h}"`,
  handoff: 'call AskUserQuestion with "handoff"',
  admit: (ref: string) => `call AskUserQuestion with "admit ${ref}"`,
};

/** The dialog's "Yes" that leaves the mode as it was (any other "Yes" works too; the mode is then set back). */
const KEEP: Record<string, string | undefined> = { default: 'Yes, manually approve edits', auto: 'Yes, and use auto mode', acceptEdits: 'Yes, and auto-accept edits' };
const DONE = 'Return to what you were doing.';
/** The note is the person's: the model neither posts it nor answers its card for them. */
const keepNote = (_n: string) => 'Don\'t post or answer it yourself.';
/** The longest text one consent hook adds to the model's context: a step says one or two short lines, so more is a
 *  bug (a part repeated, a title run long), and the cap keeps it from flooding the turn. */
export const SAY_MAX = 600;

/** Every line the consent hook says; n a person's name, h a proposal hash. */
export const SAY = {
  recorded: 'Recorded. The room shows it (and any note) already: post nothing about it. Agreeing is not a go-ahead to build; wait for the decision and your people.',
  agreed: (n: string, h: string, decided?: string | null) => `${n} agreed to proposal ${h}${decided ? `; the room decided: ${decided}` : ''}.`,
  objected: (n: string, h: string, decided?: string | null) => `${n} objected to proposal ${h}${decided ? `; the room decided: ${decided}` : ''}.`,
  failed: (n: string, h: string, why: string, unknown: boolean) => `proposal ${h}: NOT ${unknown ? 'confirmed, it may still be recorded' : 'recorded'} (${why}); ${n} has been told. Post nothing for them; open it again when ${n} asks.`,
  stale: (h: string) => `proposal ${h}: nothing recorded (already answered, decided or unknown).`,
  done: DONE,
  // the review
  opening: (n: string, h: string) => `sub-human: opening room proposal ${h} for ${n}`,
  replaced: (n: string, old: string, h: string) => `sub-human: proposal ${old} was replaced by ${h}; opening ${h} for ${n}`,
  restoring: 'sub-human: restoring the mode after a room review',
  planBack: (n: string) => `${n}'s plan mode is back. ${DONE}`,
  /** a Yes as the view opened (item 8) */
  tooSoon: (n: string, h: string) => `Nothing recorded yet: ${n}'s Yes came as the view opened, maybe keys meant for the prompt. Ask once on the card: ${NEXT.card(h)}; only that answer counts.`,
  tooSoonNotice: (title: string | null, h: string, typing: boolean) => `your Yes on ${title ? `"${title}"` : `proposal ${h}`} came ${typing ? 'while you were typing' : 'right as the review opened'}, so it is not recorded yet: confirm it on the card that follows`,
  recheckAsk: (n: string, h: string) => `room proposal ${h}: ${n}'s Yes came as the view opened; confirm it here`,
  proposeFirst: (n: string) => `sub-human: no room review now: ${n} asked you to propose something, so do that. The proposal awaiting ${n} stays pending.`,
  showOnly: (n: string, h: string) => `sub-human: this plan mode is only to show ${n} room proposal ${h}. Call ExitPlanMode now with plan "proposal ${h}"; plan nothing (the hooks show its text).`,
  exitNow: `sub-human: ${NEXT.exit}.`,
  noReviewOpen: (n: string, h: string) => `sub-human: proposal ${h} is not ${n}'s to answer now (already answered, decided or unknown); nothing was shown and nothing is recorded. Plan nothing for it.`,
  stubPlan: (n: string, h: string) => `Nothing recorded for proposal ${h}: that plan was only its name, not a review ${n} answered. ${NEXT.open(h)} to show it.`,
  /** the plan dialog's reason line: for the person, not the model */
  dialog: (n: string, h: string, from: string | null | undefined, mode: string | undefined) => `room proposal ${h}${from ? ` from ${from}` : ''}, for ${n} (PgUp/PgDn scroll). `
    + `Agree: ${mode === 'plan' ? 'any "Yes" (your plan mode comes back)' : `"${KEEP[String(mode)] || 'Yes'}" keeps your mode`}. Object: "Tell Claude what to change" + why. Esc: decide later.`,
  planView: (n: string, h: string) => `Open it in the plan view instead: ${NEXT.open(h)}. The hooks show ${n} the full proposal.`,
  unread: (n: string, h: string) => `${n}'s answer in the review of proposal ${h} is not on record yet; nothing was recorded.`,
  closed: (n: string, h: string) => `${n} closed the review of proposal ${h} without answering; nothing was recorded.`,
  /** said once the dialog closed with a note (live, a model told the person it was recorded before the card) */
  noted: (n: string, h: string) => `Nothing is recorded yet: ${n}'s note on ${h} waits for Send or Discard on its card. Next, ${NEXT.note(h)}.`,
  /** the dialog's rejection with a note, said in its own result (live, the model posted a paraphrase before the card) */
  rejectedNote: (n: string, h: string) => `sub-human: nothing is recorded yet: ${n}'s note on ${h} waits for its card (Send or Discard), which decides what the room gets; post nothing about it. First call ExitPlanMode now (no plan needed); then ${NEXT.note(h)}.`,
  rejectedClosed: (n: string, h: string) => `sub-human: ${n} closed the review of proposal ${h} without answering; nothing was recorded. First ${NEXT.exit}; then ${DONE.toLowerCase()}`,
  /** the person's notice at the rejection */
  noteNotice: (title: string | null, h: string) => `your note on ${title ? `"${title}"` : `proposal ${h}`} is not sent yet: Send or Discard on the card that follows decides`,
  /** a post while a note waits for its card */
  noteWaits: (n: string, h: string) => `sub-human: refused: ${n}'s note on proposal ${h} waits for Send or Discard on its card, which decides what the room gets. Post nothing about it; ${NEXT.note(h)}.`,
  nothingToShow: (h: string | undefined) => `${h ? `proposal ${h}` : 'the room proposal'}: nothing to show (already answered, decided or unknown); nothing was recorded.`,
  reviewClosed: 'The room review is closed and the mode is restored; this was not a plan to carry out.',
  cardInstead: (n: string, h: string) => ` The plan view could not show proposal ${h}: ${NEXT.card(h)} so ${n} answers on the card.`,
  edited: (n: string, h: string) => `${n} edited proposal ${h} in the review; nothing was recorded (an edited text is a new proposal).`,
  modeChanged: (n: string, mode: string | undefined) => `The dialog's "Yes" changed the mode; ${NEXT.restore(n, mode)}. Do not carry out the proposal.`,
  notAPlan: 'This was a room review, not a plan to carry out.',
  foreign: (n: string, h: string | undefined) => ` The plan you passed was not shown (this plan mode showed ${n} room proposal ${h}; the plan file is back as it was).`,
  unshown: (n: string, hs: string, again: string) => `Nothing recorded for ${hs}: no review opened, so ${n} did not answer (don't say they did). Ask again (${again}); don't carry it out.`,
  offerPropose: (n: string, where: string) => `sub-human: if ${n} wants the room to agree to this plan, call the room propose tool with ${where}. Only on ${n}'s word.`,
  stillOpen: (n: string, next: string) => `sub-human: ${n}'s room review is still open: ${next}.`,
  roomToolDenied: (said: string) => `sub-human: ${said ? `${said} ` : ''}Post nothing about the review. First ${NEXT.exit}; then return to what you were doing.`,
  promptExit: (said: string) => `sub-human: ${said ? `${said} ` : ''}Before anything else, ${NEXT.exit}; then continue.`,
  // the note and its confirm card
  noteAsk: (n: string, h: string) => `room proposal ${h}: ${n}'s note, to send or discard`,
  nudge: (n: string, h: string) => `${n}'s note on ${h} waits: ${NEXT.note(h)} (Send or Discard). ${keepNote(n)}`,
  reoffer: (n: string, h: string, interrupted: boolean) => `${n}'s note on ${h}:${interrupted ? '' : ' its card was never shown.'} ${showNote(n, h, interrupted)} ${keepNote(n)}`,
  renudge: (n: string, h: string) => `${n}'s note on ${h} still waits; Esc was no answer. First, ${NEXT.note(h)}. ${keepNote(n)}`,
  noteNoAnswer: (n: string, h: string) => `Nothing was recorded: the card closed without ${n}'s answer; the note waits. If ${n} asks, ${NEXT.note(h)}. ${DONE}`,
  noteOther: (h: string) => `proposal ${h}: no Send/Discard answer; nothing was recorded and the note waits. ${DONE}`,
  /** the person's notice once the card went by unanswered again: what each button does; the note keeps waiting */
  noteStillWaits: (title: string | null, h: string) => `your note on ${title ? `"${title}"` : `proposal ${h}`} still waits, not sent. On its card, Send posts it as your objection; Discard drops it and records nothing (the proposal stays unanswered). Esc keeps it waiting: ask your Claude for the card when you decide`,
  discarded: (n: string, h: string) => `${n} discarded the note; nothing was recorded and proposal ${h} still awaits ${n}'s answer. ${DONE}`,
  // the fallback card
  cardNoAnswer: (n: string) => `Nothing was recorded: the card closed without ${n}'s answer. Reopening it later is fine. ${DONE}`,
  notYet: (n: string, h: string) => `proposal ${h}: ${n} has not decided; nothing was recorded. Do not ask again unless ${n} asks.`,
  noChoice: (h: string) => `proposal ${h}: no Agree/Object answer; nothing was recorded.`,
  // the handoff card (lib/handoff.ts) and a join request's card (lib/remote/admission.ts)
  handoffNoAnswer: (n: string) => `Nothing was decided: the handoff card closed without ${n}'s answer. If ${n} asks, ${NEXT.handoff}. ${DONE}`,
  handoffDeclined: (n: string, code: string, host: string) => `${n} declined to host room ${code}; ${host} stays the host. ${DONE}`,
  handoffUntold: (n: string, why: string) => `${n} declined, but the host was not told (${why}); nothing moved. ${DONE}`,
  handoffFailed: (n: string, why: string) => `The room did NOT move: ${why}. ${n} has been told. ${DONE}`,
  handoffMoved: (n: string, code: string) => `Room ${code} is hosted on this machine now (${n} agreed on the card); its Claude runs on ${n}'s Claude account. Post nothing about it. ${DONE}`,
  admitUnknown: (ref: string, code: string) => `Nothing was done: no join request ${ref} in room ${code}. ${DONE}`,
  admitNoAnswer: (n: string, who: string, ref: string) => `Nothing was decided: the join card closed without ${n}'s answer; ${who} still waits. If ${n} asks, ${NEXT.admit(ref)}. ${DONE}`,
  admitRefused: (n: string, who: string) => `${n} refused ${who}; nothing got in. Post nothing about it. ${DONE}`,
  admitLetIn: (n: string, who: string, code: string) => `${n} let ${who}'s machine into room ${code}. Post nothing about it. ${DONE}`,
  admitFailed: (n: string, why: string) => `Nothing was done: ${why}. ${n} has been told. ${DONE}`,
};

/**
 * The model is to show the note's card now (consent's reoffer and renudge, and lib/tail.ts's reminder say it alike).
 * interrupted: the card was shown and closed with no answer (an Esc), which the model reads as declined; it is neither.
 */
export function showNote(n: string, h: string, interrupted = false): string {
  return interrupted
    ? `Esc was no answer, not a decline. First, ${NEXT.note(h)}.`
    : `First, ${NEXT.note(h)}.`;
}

// ---------- the note ----------
/** A note's stage; a note an earlier sub-human wrote carries flags instead (types-app.ts Confirm). */
export function stageOf(cf: Confirm): NoteStage {
  if (cf.stage) return cf.stage;
  if (cf.renudged) return 'told';
  if (cf.reoffered) return (cf.asked || 0) >= cf.reoffered ? 'told' : 'reoffered';
  if (cf.again) return 'told';
  if (cf.asked) return 'asked';
  if (cf.nudged) return 'nudged';
  return 'waiting';
}
/** The note at a stage, in this version's shape (no flags). */
const staged = (cf: Confirm, stage: NoteStage): Confirm => {
  const { asked: _a, nudged: _n, again: _g, reoffered: _r, renudged: _d, ...rest } = cf;
  return { ...rest, stage };
};
/** The card shown (Pre AskUserQuestion): an offer still due becomes asked; one offered again is the last. */
const onShown = (s: NoteStage): NoteStage => (s === 'waiting' || s === 'nudged' || s === 'asked' ? 'asked' : 'told');

/** The seat still has something consent must act on at a turn's end or the next prompt (the mod's reviewMaybeOpen). */
export function openOf(state: State): boolean {
  return !!state.review || (!!state.note && stageOf(state.note) !== 'told');
}

// ---------- the review ----------
/** The plan file back as it was: the effect, and the review marked restored. */
function restore(r: Review): [Review, Effect[]] {
  if (!r.file || r.restored) return [r, []];
  return [{ ...r, restored: true }, [{ do: 'restorePlan', file: r.file, backup: typeof r.backup === 'string' ? r.backup : null }]];
}

/** Back up the plan file and write the proposal there as early as its path is known (EnterPlanMode Pre, else Post). */
function showEarly(r: Review, plan: PlanFile): [Review, Effect[]] {
  if (!plan.file || !r.hash || r.file) return [r, []];
  const next: Review = { ...r, file: plan.file, backup: plan.text, restored: false };
  return [next, [{ do: 'save', review: next }, { do: 'writePlan', file: plan.file, hash: r.hash, early: true }]];
}

/** Whether (and how) the handler reads the dialog's answer for this event: 'wait' polls for the line, 'now' does not. */
export function answerNeeded(r: Review | null, ev: { type: Event['type']; toolUseId?: string | null; mode?: string }): 'wait' | 'now' | null {
  if (!r || r.resolved || !(r.phase === 'shown' || r.unread)) return null;
  const same = !!r.tool_use_id && r.tool_use_id === ev.toolUseId;
  switch (ev.type) {
    case 'exit': return r.phase === 'shown' && same ? null : 'wait';
    case 'exited': return r.unread && same ? null : r.phase === 'exiting' ? 'wait' : null;
    case 'stop': return ev.mode === 'plan' && r.phase !== 'restore' && r.phase !== 'entering' ? 'now' : null;
    case 'roomTool': return r.phase === 'shown' || r.phase === 'exiting' ? 'now' : null;
    case 'prompt': return (ev.mode === 'plan' && r.phase !== 'restore') || r.unread ? 'now' : null;
    default: return null;
  }
}

/**
 * The dialog closed: what it said, once its tool_result is on disk (answer). A note never counts on its own: it opens
 * the note (Send on its card records it). No answer yet (answer null) with the call's id known is unread, unless the
 * review is closing (close): then it closed without an answer.
 */
function resolve(r: Review, note: Confirm | null, ev: { answer?: Answer | null; target?: Target | null }, ctx: Ctx, close = false): { review: Review; note: Confirm | null } {
  if (r.resolved || !(r.phase === 'shown' || r.unread)) return { review: r, note };
  const h = r.hash || '';
  const seen = ev.answer || null;
  if (!seen && r.tool_use_id && !close) return { review: { ...r, unread: true, said: SAY.unread(ctx.name, h) }, note };
  const { unread: _u, ...rest } = r;
  const text = seen ? seen.note : null;
  if (text == null || !text.trim()) return { review: { ...rest, resolved: true, said: SAY.closed(ctx.name, h) }, note };
  const t = ev.target && ev.target.hash === r.hash ? ev.target : null;
  if (!t) return { review: { ...rest, resolved: true, said: SAY.stale(h) }, note };
  return { review: { ...rest, resolved: true, said: SAY.noted(ctx.name, h) },
    note: { hash: t.hash, note: text, from: t.from, title: t.title, at: ctx.now, stage: 'waiting' } };
}

/** A blank plan, or the "proposal <hash>" stub the model is told to pass: not a plan of its own. */
const stub = (t: string) => !t.trim() || /^\s*(?:the room )?proposal\s+[0-9a-f]{6,12}\s*\.?\s*$/i.test(t);

/** Post(ExitPlanMode) with no review shown although its dialog was a pending proposal's: tell the model, pick it. */
function unshown(ev: Extract<Event, { type: 'exited' }>, ctx: Ctx, hashes: string[]): { effects: Effect[]; say: Say } | null {
  if (!ev.pending.length || ev.response.isAgent) return null;
  const plan = typeof ev.response.plan === 'string' ? ev.response.plan : typeof ev.callPlan === 'string' ? ev.callPlan : '';
  let hit = ev.pending.filter(p => hashes.includes(p.hash));
  // its text, but not a plan of my own that I proposed (that is my plan, already in the room)
  if (!hit.length && plan.trim()) { const h = hash12(Buffer.from(plan, 'utf8')); hit = ev.pending.filter(p => p.from !== ctx.name && p.hash === h); }
  if (!hit.length && plan.length < 300) hit = ev.pending.filter(p => ev.callNames.includes(p.hash));
  if (!hit.length && !plan.trim()) hit = ev.pending;
  if (!hit.length) return null;
  const again = ev.reviewable && hit.every(p => p.viewable) ? NEXT.open(hit[0].hash) : NEXT.card(hit[0].hash);
  return { effects: [{ do: 'pick', hash: hit[0].hash }], say: { to: 'context', parts: [SAY.unshown(ctx.name, hit.map(p => p.hash).join(', '), again)] } };
}

/** Post(ExitPlanMode) for the person's own plan: their own pending proposal unedited is their signoff; else offer to propose it. */
function ownPlan(ev: Extract<Event, { type: 'exited' }>, ctx: Ctx): { effects: Effect[]; say: Say | null } {
  const plan = ev.response.plan;
  if (ev.response.isAgent || typeof plan !== 'string' || !plan.trim()) return { effects: [], say: null };
  // "proposal HASH" with no review: not the person's plan, and not an answer (the dialog showed only the name)
  const named = /^\s*(?:the room )?proposal\s+([0-9a-f]{6,12})\s*\.?\s*$/i.exec(plan);
  if (named) return { effects: [], say: { to: 'context', parts: [SAY.stubPlan(ctx.name, named[1])] } };
  const h = hash12(Buffer.from(plan, 'utf8'));
  if (!ev.response.edited && ev.pending.some(p => p.hash === h && p.from === ctx.name)) {
    return { effects: [{ do: 'answer', hash: h, choice: 'Agree' }], say: { to: 'context', parts: [{ answer: h }] } };
  }
  if (ev.proposed) return { effects: [], say: null };
  const where = ev.response.filePath ? `{path: ${JSON.stringify(ev.response.filePath)}}` : '{text: <the plan>}';
  return { effects: [], say: { to: 'context', parts: [SAY.offerPropose(ctx.name, where)] } };
}

const none = (state: State): Step => ({ state, effects: [], say: null });
/** A Yes that may not be the person's choice: it came within YES_GUARD_MS of the view being shown, or they had typed
 * text in the prompt as it opened (their next keys went to the dialog). */
const quickYes = (r: Review, ctx: Ctx): boolean => !!r.typing || (typeof r.shownAt === 'number' && ctx.now - r.shownAt < (ctx.guardMs ?? YES_GUARD_MS));
const ctxSay = (...parts: Part[]): Say => ({ to: 'context', parts });

export function reduce(state: State, ev: Event, ctx: Ctx): Step {
  const n = ctx.name;
  const r = state.review;
  switch (ev.type) {
    case 'enter': {
      if (r && r.phase === 'restore') return { state, effects: [], say: { to: 'allow', text: SAY.restoring } };
      if (!ev.pending.length || !ev.reviewable) return none(state);
      // a review left behind: its backup goes back before a new one is taken
      const [old, effects] = r ? restore(r) : [r, [] as Effect[]];
      const said = ev.said;
      // The person asked their Claude to propose something: no review (a hash they named still opens one). Once the
      // propose tool made that proposal (proposedSince), the ask is spent: the proposal opens like any other
      const since = ev.proposedSince ? ev.pending.find(q => q.hash === ev.proposedSince) : undefined;
      if (said && ev.propose && !since && !ev.pending.some(p => said.text.includes(p.hash.slice(0, 6)))) {
        return { state: { ...state, review: old }, effects, say: ctxSay(SAY.proposeFirst(n)) };
      }
      // The person's pick, else the newest: never the model's choice. A pick made after their latest prompt stands.
      const fresh = !!said && !(ev.kept && ev.kept.at > said.at);
      const newest = ev.pending[ev.pending.length - 1];
      const byHash = (h: string | null | undefined) => (h ? ev.pending.find(p => p.hash === h) : undefined);
      const p = (fresh ? byHash(ev.named) || since : byHash(ev.kept && ev.kept.hash)) || newest;
      if (fresh) effects.push({ do: 'pick', hash: byHash(ev.named) ? ev.named : since ? since.hash : null });
      const was = fresh && ev.replaced && ev.replaced.hash === p.hash ? ev.replaced : null;
      let review: Review = { phase: 'entering', mode: ev.mode, at: ctx.now, hash: p.hash, from: p.from || null };
      const note = state.note && state.note.hash === p.hash ? null : state.note; // reviewed again: its note is superseded
      // the file as it will be once the left-behind review's restore has run (the facts were read before it)
      const now = r && r.file && r.file === ev.plan.file && !r.restored ? { file: r.file, text: typeof r.backup === 'string' ? r.backup : null } : ev.plan;
      const [shown, early] = showEarly(review, now);
      review = shown;
      return { state: { review, note }, effects: [...effects, ...early],
        say: { to: 'allow', text: was ? SAY.replaced(n, was.old, p.hash) : SAY.opening(n, p.hash) } };
    }

    case 'entered': {
      if (!r) return none(state);
      if (r.phase === 'restore' && r.mode === 'plan') return { state: { ...state, review: null }, effects: [], say: ctxSay(SAY.planBack(n)) };
      if (r.phase === 'restore') return { state, effects: [], say: ctxSay(SAY.exitNow) };
      if (r.phase !== 'entering') return none(state);
      const [review, effects] = showEarly(r, ev.plan);
      return { state: { ...state, review }, effects, say: ctxSay(SAY.showOnly(n, r.hash || '')) };
    }

    case 'planFailed': {
      if (!r) return none(state);
      if (ev.early) {
        const { file: _f, backup: _b, restored: _r, ...rest } = r;
        return { state: { ...state, review: rest }, effects: [], say: null };
      }
      const [back, effects] = restore(r);
      return { state: { ...state, review: { ...back, phase: 'exiting', card: r.hash } }, effects, say: null };
    }

    case 'exit': {
      if (!r) {
        // No review opened (plan mode by hand, or EnterPlanMode skipped), yet the plan is a proposal's name: open its
        // review here, or deny the call; a bare plan view of "proposal HASH" never records anything
        if (!ev.stub) return none(state);
        if (!ev.stub.live) return { state, effects: [], say: { to: 'deny', parts: [SAY.noReviewOpen(n, ev.stub.hash)] } };
        if (!ev.shown || !ev.plan.file || ev.text == null) return { state, effects: [], say: { to: 'deny', parts: [SAY.cardInstead(n, ev.stub.hash).trim()] } };
        // plan mode is the person's own (the call is ExitPlanMode's, so the session is in it): a Yes leaves it, and the
        // review puts it back
        const opened: Review = { phase: 'entering', mode: 'plan', at: ctx.now, hash: ev.shown.hash, from: ev.shown.from || null };
        return reduce({ ...state, review: opened }, ev, ctx);
      }
      if (r.phase === 'shown' && r.tool_use_id && r.tool_use_id === ev.toolUseId) { // the same call again
        return { state, effects: [], say: { to: 'ask', text: SAY.dialog(n, r.hash || '', r.from, r.mode), show: { plan: r.hash || '' } } };
      }
      if (r.phase === 'shown' || r.unread) { // the closing call: the dialog has closed, its answer was waited for
        const res = resolve(r, state.note, ev, ctx);
        return { state: { review: { ...res.review, phase: 'exiting' }, note: res.note }, effects: [], say: null };
      }
      if (r.phase !== 'entering') return { state: { ...state, review: { ...r, phase: 'exiting' } }, effects: [], say: null };
      // The hook's review: the proposal Pre(EnterPlanMode) picked, whatever this call carries.
      let review: Review = { ...r };
      const effects: Effect[] = [];
      if (review.file && review.file !== ev.plan.file) {
        const [back, e] = restore(review);
        effects.push(...e);
        const { file: _f, backup: _b, ...rest } = back;
        review = rest;
      }
      const backup = review.file === ev.plan.file && !review.restored ? review.backup ?? null : ev.plan.text;
      // A plan of the model's own (not the proposal, not a stub) is never shown here: the model's input as sent, or the
      // plan Claude Code read from the file unless that is just what the file held before the review.
      const mine = (t: unknown) => typeof t === 'string' && !stub(t) && t !== ev.text && hash12(Buffer.from(t, 'utf8')) !== shownHash(review);
      if (mine(ev.ownPlan) || (mine(ev.callPlan) && ev.callPlan !== backup)) review.foreign = true;
      if (!ev.shown) {
        const [back, e] = restore(review);
        return { state: { ...state, review: { ...back, phase: 'exiting', said: SAY.nothingToShow(review.hash) } }, effects: [...effects, ...e], say: null };
      }
      if (!ev.plan.file || ev.text == null) {
        const [back, e] = restore(review);
        return { state: { ...state, review: { ...back, phase: 'exiting', card: ev.shown.hash } }, effects: [...effects, ...e], say: null };
      }
      // The backup is on disk (save) BEFORE the plan file is overwritten: a crash in between loses nothing.
      const before: Review = { ...review, hash: ev.shown.hash, from: ev.shown.from || null, file: ev.plan.file, backup, restored: false, tool_use_id: ev.toolUseId || null,
        shownAt: ctx.now, ...(ev.typing ? { typing: true } : {}) };
      effects.push({ do: 'save', review: before }, { do: 'writePlan', file: ev.plan.file, hash: ev.shown.hash, early: false });
      return { state: { ...state, review: { ...before, phase: 'shown' } }, effects,
        say: { to: 'ask', text: SAY.dialog(n, ev.shown.hash, before.from, before.mode), show: { plan: ev.shown.hash } } };
    }

    case 'permission': {
      if (!r || r.phase !== 'exiting') return none(state);
      const [review, effects] = restore(r);
      return { state: { ...state, review }, effects, say: { to: 'permit', mode: r.mode } };
    }

    case 'exited': {
      const fallback = (base: State, effects: Effect[], hashes: string[]): Step => {
        const u = unshown(ev, ctx, hashes);
        if (u) return { state: base, effects: [...effects, ...u.effects], say: u.say };
        const o = ownPlan(ev, ctx);
        return { state: base, effects: [...effects, ...o.effects], say: o.say };
      };
      if (!r) return fallback(state, [], []);
      if (r.phase === 'entering') { // Pre(ExitPlanMode) never opened the review
        const [, effects] = restore(r);
        return fallback({ ...state, review: null }, effects, r.hash ? [r.hash] : []);
      }
      let cur: Review = r;
      // A handler that ran while the dialog was open (unread) set 'exiting': this Post is the dialog's own, a "Yes".
      if (cur.unread && cur.tool_use_id && cur.tool_use_id === ev.toolUseId) {
        const { unread: _u, said: _s, ...rest } = cur;
        cur = { ...rest, phase: 'shown' };
      }
      const foreign: Part[] = cur.foreign ? [SAY.foreign(n, cur.hash)] : [];
      if (cur.phase === 'exiting') {
        const res = resolve(cur, state.note, ev, ctx, true); // unread until now: the note, if any, waits for Send
        const [, effects] = restore(res.review);
        const card = cur.card ? SAY.cardInstead(n, cur.card) : '';
        const said = res.review.said ? `${res.review.said} ` : '';
        return { state: { review: null, note: res.note }, effects, say: ctxSay(`${said}${SAY.reviewClosed}${card} ${DONE}`, ...foreign) };
      }
      if (cur.phase !== 'shown') return none(state);
      // A "Yes" in the dialog: only a person can choose it (the exiting phase above is the hook's own allow).
      const h = cur.hash || '';
      const plan = ev.response.plan;
      const effects: Effect[] = [];
      let line: Part[];
      let recheck: Recheck | null | undefined = state.recheck;
      let notice: string | undefined;
      if (ev.response.edited || typeof plan !== 'string' || hash12(Buffer.from(plan, 'utf8')) !== shownHash(cur)) line = [SAY.edited(n, h)];
      else if (!ev.target || ev.target.hash !== cur.hash) line = [SAY.stale(h)];
      else if (quickYes(cur, ctx)) { // keys meant for the prompt may have answered it: the card asks once
        recheck = { hash: h, at: ctx.now };
        line = [SAY.tooSoon(n, h)];
        notice = SAY.tooSoonNotice(ev.target.title, h, !!cur.typing);
      } else { effects.push({ do: 'answer', hash: h, choice: 'Agree' }); line = [{ ifRecorded: SAY.recorded }, { answer: h }]; }
      const [back, e] = restore(cur);
      effects.push(...e);
      const withNotice = notice ? { notice } : {};
      if (ev.mode && ev.mode !== cur.mode && !cur.keepMode) {
        const { said: _s, ...rest } = back;
        return { state: { ...state, recheck, review: { ...rest, phase: 'restore' } }, effects, say: ctxSay(...line, SAY.modeChanged(n, cur.mode), ...foreign), ...withNotice };
      }
      return { state: { ...state, recheck, review: null }, effects, say: ctxSay(...line, SAY.notAPlan, ...foreign), ...withNotice };
    }

    case 'stop': {
      if (ev.active) return none(state);
      if (!r) return noteAtStop(state, ev, ctx);
      let next: string;
      let review: Review | null = r;
      let note = state.note;
      if (r.phase === 'restore') {
        if (ev.mode === r.mode) return { state: { ...state, review: null }, effects: [], say: null };
        next = ev.mode === 'plan' ? NEXT.exit : NEXT.restore(n, r.mode);
      } else if (ev.mode !== 'plan') return none(state);
      else if (r.phase === 'entering') next = `${NEXT.show(r.hash || '')} to show ${n} the room proposal`;
      else {
        const res = resolve(r, state.note, ev, ctx);
        review = { ...res.review, phase: 'exiting' };
        note = res.note;
        next = NEXT.exit;
      }
      return { state: { review, note }, effects: [], say: ctxSay(SAY.stillOpen(n, next)) };
    }

    case 'roomTool': {
      // a shown or closing review means plan mode (the module's mode can be stale: it is the last event's)
      if (r && (r.phase === 'shown' || r.phase === 'exiting')) {
        const res = resolve(r, state.note, ev, ctx);
        return { state: { review: { ...res.review, phase: 'exiting' }, note: res.note }, effects: [],
          say: { to: 'deny', parts: [SAY.roomToolDenied(res.review.said || '')] } };
      }
      if (!state.note || !ev.post) return none(state);
      if (ev.noteLive === false) return { state: { ...state, note: null }, effects: [], say: null }; // no longer this seat's to answer
      return { state, effects: [], say: { to: 'deny', parts: [SAY.noteWaits(n, state.note.hash)] } };
    }

    case 'rejected': {
      if (!r || !r.tool_use_id || r.tool_use_id !== ev.toolUseId || r.resolved || !(r.phase === 'shown' || r.unread)) return none(state);
      const res = resolve(r, state.note, ev, ctx, true);
      const h = r.hash || '';
      const noted = !!res.note && res.note !== state.note;
      return { state: { review: { ...res.review, phase: 'exiting' }, note: res.note }, effects: [],
        say: ctxSay(noted ? SAY.rejectedNote(n, h) : SAY.rejectedClosed(n, h)),
        ...(noted ? { notice: SAY.noteNotice(res.note!.title, h) } : {}) };
    }

    case 'prompt': {
      if (!r) return noteAtPrompt(state, ev, ctx);
      if (ev.mode === 'plan' && r.phase !== 'restore') {
        const res = resolve(r, state.note, ev, ctx);
        return { state: { review: { ...res.review, phase: 'exiting' }, note: res.note }, effects: [], say: ctxSay(SAY.promptExit(res.review.said || '')) };
      }
      // left plan mode another way: a note read only now still waits for Send
      const res = r.unread ? resolve(r, state.note, ev, ctx, true) : { review: r, note: state.note };
      const [, effects] = restore(res.review);
      return { state: { review: null, note: res.note }, effects, say: null };
    }

    case 'ask': {
      if (ev.admit) return { state, effects: [], say: { to: 'ask', text: '', show: { admit: ev.admit } } };
      if (ev.handoff) return { state, effects: [], say: { to: 'ask', text: '', show: { handoff: true } } };
      let note = state.note;
      if (note && !ev.live) note = null; // its proposal is no longer this seat's to answer
      if (note && ev.noteNamed) {
        return { state: { ...state, note: staged(note, onShown(stageOf(note))) }, effects: [],
          say: { to: 'ask', text: SAY.noteAsk(n, note.hash), show: { note: true } } };
      }
      const base = { ...state, note };
      if (!ev.hit.length) return none(base);
      // a Yes that came as the plan view opened is confirmed on the card, not in the view again (item 8)
      const again = state.recheck ? ev.hit.find(p => p.hash === state.recheck!.hash) : undefined;
      if (again) return { state: base, effects: [], say: { to: 'ask', text: SAY.recheckAsk(n, again.hash), show: { card: [again.hash] } } };
      if (ev.reviewable && ev.hit.every(p => p.viewable)) {
        return { state: base, effects: [{ do: 'pick', hash: ev.hit[0].hash }], say: { to: 'deny', parts: [SAY.planView(n, ev.hit[0].hash)] } };
      }
      return { state: base, effects: [], say: { to: 'ask', text: `room proposal ${ev.hit.map(p => p.hash).join(', ')}`, show: { card: ev.hit.map(p => p.hash) } } };
    }

    case 'answered': {
      const cf = state.note;
      if (cf && ev.note.kind !== 'absent') {
        const told = { ...state, note: staged(cf, 'told') }; // the model is told: no offer again
        if (ev.note.kind === 'none') return { state: told, effects: [], say: ctxSay(SAY.noteNoAnswer(n, cf.hash)) };
        if (ev.note.kind === 'other') return { state: told, effects: [], say: ctxSay(SAY.noteOther(cf.hash)) };
        if (ev.note.label === 'Discard') return { state: { ...state, note: null }, effects: [], say: ctxSay(SAY.discarded(n, cf.hash)) };
        if (!ev.target || ev.target.hash !== cf.hash) return { state: { ...state, note: null }, effects: [], say: ctxSay(SAY.stale(cf.hash)) };
        // not sent (the room unreachable): the note waits for another Send (clearNote only on success)
        return { state, effects: [{ do: 'answer', hash: cf.hash, choice: 'Object', notes: cf.note, clearNote: true }],
          say: ctxSay({ ifRecorded: SAY.recorded }, { answer: cf.hash }, { ifRecorded: DONE }) };
      }
      if (!ev.answers.length && !ev.asked) return none(state); // not a consent card
      // the recheck is asked once: any card for its proposal settles it, answered or not
      const rc = state.recheck && (ev.answers.some(a => a.hash === state.recheck!.hash) || !ev.answers.length) ? null : state.recheck;
      state = rc === state.recheck ? state : { ...state, recheck: rc };
      if (ev.afk || !ev.answers.length) return { state, effects: [], say: ctxSay(SAY.cardNoAnswer(n)) };
      const effects: Effect[] = [];
      const parts: Part[] = [{ ifRecorded: SAY.recorded }];
      for (const a of ev.answers) {
        if (!a.live) { parts.push(SAY.stale(a.hash)); continue; }
        if (a.answer.kind === 'answer' && a.answer.label === 'Not yet') { parts.push(SAY.notYet(n, a.hash)); continue; }
        if (a.answer.kind !== 'answer' || (a.answer.label !== 'Agree' && a.answer.label !== 'Object')) { parts.push(SAY.noChoice(a.hash)); continue; }
        effects.push({ do: 'answer', hash: a.hash, choice: a.answer.label, ...(a.answer.notes !== undefined ? { notes: a.answer.notes } : {}) });
        parts.push({ answer: a.hash });
      }
      parts.push(DONE);
      return { state, effects, say: ctxSay(...parts) };
    }
  }
}

/** Stop with no review: a note whose card was never shown is asked for once (nudged); an interrupted card offered
 * again and not shown since, once more (renudge). */
function noteAtStop(state: State, ev: Extract<Event, { type: 'stop' }>, ctx: Ctx): Step {
  const cf = state.note;
  if (!cf) return none(state);
  const stage = stageOf(cf);
  if (stage !== 'waiting' && stage !== 'reoffered') return none(state);
  if (!ev.live) return { state: { ...state, note: null }, effects: [], say: null };
  if (stage === 'reoffered') return { state: { ...state, note: staged(cf, 'told') }, effects: [], say: ctxSay(SAY.renudge(ctx.name, cf.hash)) };
  return { state: { ...state, note: staged(cf, 'nudged') }, effects: [], say: ctxSay(SAY.nudge(ctx.name, cf.hash)) };
}

/** The next prompt with no review: a note whose card was interrupted (asked, no Post) or never shown though Stop
 * nudged is offered again, once; one told already gets the person a notice of what Send and Discard do, once. */
function noteAtPrompt(state: State, ev: Extract<Event, { type: 'prompt' }>, ctx: Ctx): Step {
  const cf = state.note;
  if (!cf) return none(state);
  const stage = stageOf(cf);
  // offered and told already, and its card went by again: the person hears once what Send and Discard do (never a
  // silent drop: the note keeps waiting)
  if (stage === 'told' && !cf.explained && ev.live) {
    return { state: { ...state, note: { ...cf, explained: true } }, effects: [], say: null, notice: SAY.noteStillWaits(cf.title, cf.hash) };
  }
  if (stage !== 'asked' && stage !== 'nudged') return none(state);
  if (!ev.live) return { state: { ...state, note: null }, effects: [], say: null };
  const interrupted = stage === 'asked';
  return { state: { ...state, note: staged(cf, interrupted ? 'reoffered' : 'told') }, effects: [], say: ctxSay(SAY.reoffer(ctx.name, cf.hash, interrupted)) };
}

/** A say's parts as text; outcome(hash) is the answer effect's line, recorded whether any answer was recorded. */
export function textOf(parts: Part[], outcome: (hash: string) => string, recorded: boolean): string {
  const text = parts.map(p => (typeof p === 'string' ? p : 'answer' in p ? outcome(p.answer) : recorded ? p.ifRecorded : '').trim())
    .filter(Boolean).join(' ');
  return text.length > SAY_MAX ? `${text.slice(0, SAY_MAX - 1)}…` : text;
}
