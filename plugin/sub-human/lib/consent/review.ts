/**
 * plugin/sub-human/lib/consent/review.ts: the consent hook's session-side state machine, as one pure reducer.
 *
 *   reduce(state, event, ctx) -> {state, effects, say}
 * state: {review, note}, the seat's two documents (members/NAME/review: the plan-view review; members/NAME/confirm: a
 * review's note waiting for the person's Send). The room's record of a proposal (who agreed, the decision) is not
 * here: lib/room/consent.ts fold is its one interpretation, and an answer reaches it only through the `answer` effect.
 * hooks/consent.ts gathers each event's facts (the transcript, the plan file, the room), runs the effects
 * (the lock, plan-file I/O, proposal.answer), stores the state and writes the say. Nothing here reads a
 * file, the clock or the room.
 *
 * The review (Review.phase), opened only by the hooks and only for a proposal the person's words pick:
 *   (none) ─enter─► entering ─exit─► shown ─exited "Yes"──────────────► (none) | restore (the Yes changed the mode)
 *                      │               │ exit (a closing call) / stop / roomTool / prompt
 *                      │               ▼                                 restore ─enter─► allow; ─stop (mode back)─► (none)
 *                      └─(no plan file, nothing to show)─► exiting ─permission─► (emptied, no dialog) ─exited─► (none), restored
 * A review closed with a note (the dialog's own tool_result, read only once it is on disk: `unread` until then) opens
 * the note; nothing is recorded until the person's Send on its card.
 * The note (Confirm.stage):
 *   waiting ─stop─► nudged ─prompt─► told        asked ─prompt (no Post: Esc)─► reoffered ─stop─► told
 *   waiting|nudged ─ask─► asked ─answered (no answer)─► told; reoffered ─ask─► told; Send / Discard ─► (none)
 *   told ─prompt─► told, the person told once what Send and Discard do (explained); the note keeps waiting
 * A note whose proposal is no longer the seat's to answer is dropped wherever it is met.
 *
 * Events (ConsentEvent, each carrying its facts; ctx {name, now}) are the hooks around EnterPlanMode, ExitPlanMode,
 * AskUserQuestion and the room's MCP tools, plus Stop, UserPromptSubmit and a failed writePlan (planFailed). Notes:
 *   exit's stub: a "proposal HASH" plan with no review opened (plan mode entered by hand, or EnterPlanMode skipped):
 *     live, it opens the review here with the person's own plan mode as the mode to put back; otherwise the call is
 *     denied, never a bare plan view of the stub.
 *   mode plan (the person was in plan mode before the review: an EnterPlanMode made there, or the stub): the view
 *     shows the proposal as anywhere (the plan file holds it before ExitPlanMode reads it), a Yes is put back with
 *     EnterPlanMode alone, and a review that closes without a Yes has its closing ExitPlanMode denied (closeInPlan:
 *     plan mode stays on, the person's own plan back in the file), never let through to leave plan mode.
 *   rejected: Claude Code runs no PostToolUse for a rejected plan view, so the module's tool.call hook reports it the
 *     moment ExitPlanMode's call comes back refused (mod/consent.ts); the review resolves there and then.
 *   roomTool: while a review is shown or closing any room tool is denied; while a note waits for its card the post
 *     tool is (the card decides what the room gets, so a paraphrase cannot go out first).
 * answerNeeded(review, event) says whether, and how, the handler reads the dialog's answer for an event.
 *
 * Effects run in order. save comes before a writePlan, so the backup is on disk first; restorePlan with a null backup
 * removes the file; blankPlan empties it for the closing ExitPlanMode (which reads it as it runs: the person's own plan
 * there would show as approved), and the restore follows at exited or the next prompt; answer is lib/proposal.ts answer then decide, its clearNote dropping the note only on success.
 * say is what the hook answers (context, deny, allow, ask, permit: a PermissionRequest allow with the mode set back);
 * its parts are lines, {answer: hash} (the answer effect's outcome line) or {ifRecorded}. Every model-facing line is
 * in NEXT and SAY below: one mechanic per phase and short outcome lines (CLAUDE.md "Unprescriptive").
 *
 * A draft (Review.draft: lib/proposal.ts check) is the person's own new version, before anyone else is asked: its
 * dialog says so (dialogDraft), its Yes is recorded as any (the answer effect, which then sends it out: hooks/consent.ts
 * record), and a note on it opens no note card: nothing is recorded or sent, and the model is told to write the next
 * version (revise); the card's Object on it says the same.
 *
 * A proposal is a sign-off request on one version of a room plan (lib/plans.ts). Editing a plan is lib/consent/edit.ts,
 * a reducer of its own: while an edit is open the hooks route plan mode to it, never here, so an edit's ExitPlanMode
 * never reaches a review and the person's own plan approved in the dialog is never an answer (only a review the hooks
 * opened records one). Every comparison of the dialog's plan with the proposal goes through shownHash.
 */

import { hash12 } from '../text.ts';
import { YES_GUARD_MS } from '../config.ts';
import { assertNever } from '../../mod/core/never.ts';
import type { Confirm, NoteStage, Recheck, Review, Steer } from '../types-app.ts';
import type { CardAnswer } from './card.ts';
import type { RoomCode } from '../brand.ts';

/** recheck: a plan-view Yes that came as the view opened (within YES_GUARD_MS, or while the person had typed text in
 * the prompt), not recorded: the card asks once, and only its answer records. */
export interface State { review: Review | null; note: Confirm | null; recheck?: Recheck | null | undefined; steer?: Steer | null | undefined }
/** guardMs: YES_GUARD_MS unless the handler says otherwise (the tests shorten it: env.testMs). */
export interface ReviewCtx { name: string; now: number; guardMs?: number }

/** How the review's dialog closed (cc.planAnswer): note null for no note (Esc, a bare deny). */
export interface ReviewAnswer { note: string | null }
/** The review's proposal while this seat may still answer it (lib/proposal.ts answerableFor). draft: the person's own
 * new version, not sent out yet (lib/proposal.ts check). */
export interface Target { hash: string; from: string | null; title: string | null; draft?: boolean }
/** The session's plan file and what it holds now (null: no file). */
export interface PlanFile { file: string | null; text: string | null }
/** A proposal pending for this seat (lib/proposal.ts pendingFor), oldest first. */
export interface Pending { hash: string; from: string | null; viewable: boolean; title?: string | null; draft?: boolean }
/** The person's latest prompt (cc.lastHumanPrompt). */
export interface Said { text: string; at: number }

export type ConsentEvent =
  | { type: 'enter'; mode: string | undefined; reviewable: boolean; pending: Pending[]; said: Said | null; named: string | null; plan: PlanFile }
  | { type: 'entered'; plan: PlanFile }
  | { type: 'exit'; toolUseId: string | null; answer?: ReviewAnswer | null; target?: Target | null; shown: { hash: string; from: string | null; title?: string | null; draft?: boolean } | null;
      text: string | null; plan: PlanFile; callPlan: unknown; ownPlan: unknown; mode?: string | undefined;
      stub?: { hash: string; live: boolean } | null;
      /** no review open and no stub: the request this seat would answer (the person's words name it, else the oldest
       * viewable) while the call would show the plan file's text (plan: its hash12), the person's own plan */
      waiting?: { hash: string; title?: string | null; plan: string } | null;
      /** the person had typed text in the prompt as the view opened (the module's PromptHint isDraft) */
      typing?: boolean }
  | { type: 'permission' }
  | { type: 'exited'; toolUseId: string | null; mode: string | undefined; answer?: ReviewAnswer | null; target?: Target | null;
      response: { plan: unknown; edited: boolean; isAgent: boolean; filePath: unknown }; callPlan: unknown;
      pending: Pending[]; callNames: string[]; reviewable: boolean }
  | { type: 'stop'; mode: string | undefined; active: boolean; answer?: ReviewAnswer | null; target?: Target | null; live: boolean }
  | { type: 'roomTool'; mode: string | undefined; answer?: ReviewAnswer | null; target?: Target | null; post?: boolean; noteLive?: boolean }
  | { type: 'rejected'; toolUseId: string | null; answer: ReviewAnswer | null; target?: Target | null }
  | { type: 'prompt'; mode: string | undefined; answer?: ReviewAnswer | null; target?: Target | null; live: boolean }
  | { type: 'ask'; admit: string | null; noteNamed: boolean; live: boolean; hit: Pending[]; reviewable: boolean }
  | { type: 'answered'; note: CardAnswer; target?: Target | null; afk: boolean; asked: boolean;
      answers: { hash: string; answer: CardAnswer; live: boolean; draft?: boolean }[] }
  | { type: 'planFailed'; early: boolean };

export type ConsentEffect =
  | { do: 'save'; review: Review }
  | { do: 'writePlan'; file: string; hash: string; early: boolean }
  | { do: 'restorePlan'; file: string; backup: string | null }
  /** the plan file emptied for the closing ExitPlanMode (lib/cc/env.ts LEAVE_PLAN_TEXT); restorePlan follows at exited */
  | { do: 'blankPlan'; file: string }
  | { do: 'answer'; hash: string; choice: 'Agree' | 'Object'; notes?: string; clearNote?: boolean };

export type Part = string | { answer: string } | { ifRecorded: string };
export type Say =
  | { to: 'context'; parts: Part[] }
  | { to: 'deny'; parts: Part[] }
  | { to: 'allow'; text: string }
  | { to: 'ask'; text: string; show: { plan: string } | { card: string[] } | { note: true } | { admit: string } }
  | { to: 'permit'; mode: string | undefined };

/** notice: a line for the person (the hook's systemMessage, a sub-human notice), beside what the model is told. */
export interface ReviewStep { state: State; effects: ConsentEffect[]; say: Say | null; notice?: string }

/** The hash the dialog's plan must have for an answer to count: the proposal's own (the version's). */
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
  restore: (n: string, mode: string | undefined): string => (mode === 'plan' ? `call EnterPlanMode to put ${n}'s plan mode back (no dialog)`
    : `call EnterPlanMode, then ExitPlanMode, to restore ${n}'s ${mode} mode (no dialogs)`),
  /** the fallback card */
  card: (h: string) => `call AskUserQuestion with "proposal ${h}"`,
  /** a note's confirm card */
  note: (h: string) => `call AskUserQuestion with "objection ${h}"`,
  admit: (ref: string) => `call AskUserQuestion with "admit ${ref}"`,
};

/** The plan view's "Yes" that leaves the person's mode as it is, by mode, from the options Claude Code 2.1.296 offers
 * ("Yes, and use auto mode", "Yes, manually approve edits"; without auto mode "Yes, auto-accept edits" in the first
 * place). A mode with no such option in every set (accept edits: the auto-mode set has none) is told "any Yes", since
 * the review puts the mode back after a Yes that changed it. */
const KEEP: Record<string, string | undefined> = { default: 'Yes, manually approve edits', auto: 'Yes, and use auto mode' };
/** A mode as the person reads it in the hint. */
const MODE_WORDS: Record<string, string | undefined> = { plan: 'plan', acceptEdits: 'accept-edits', bypassPermissions: 'bypass-permissions', dontAsk: "don't-ask" };
/** The dialog's Agree: the option that keeps the mode, else any Yes (the mode comes back). */
const agreeHint = (mode: string | undefined) => (KEEP[String(mode)] ? `"${KEEP[String(mode)]}" keeps your mode` : `any "Yes" (your ${MODE_WORDS[String(mode)] || 'own'} mode comes back)`);
const DONE = 'Return to what you were doing.';
/** A review's closing words end with DONE, unless the person asked for another version (revise: that is next). */
const doneUnless = (r: Review | null | undefined): Part[] => (r && r.revise ? [] : [DONE]);
/** A sign-off request as the person knows it: a room plan's version ("plan paging v3"), else a request from before
 * plans by its title, else by its hash. */
const requestName = (h: string, title: string | null | undefined): string => (!title ? `room proposal ${h}`
  : /^plan [a-z0-9-]+ v\d+$/.test(title) ? title : `"${title}" (${h.slice(0, 6)})`);
/** A request's plan name from its title ("plan paging v3" -> "paging"), or null. */
const planIn = (title: string | null | undefined): string | null => /^plan ([a-z0-9-]+) v\d+$/.exec(String(title ?? ''))?.[1] ?? null;
/** The edit call for the plan a request is about. */
const editCall = (title: string | null | undefined): string => { const p = planIn(title); return `the plan tool, op edit${p ? `, name ${p}` : ''}`; };
/** The note is the person's: the model neither posts it nor answers its card for them. */
const keepNote = (_n: string) => 'Don\'t post or answer it yourself.';
/** The longest text one consent hook adds to the model's context: a step says one or two short lines, so more is a
 *  bug (a part repeated, a title run long), and the cap keeps it from flooding the turn. */
export const SAY_MAX = 600;

/** Every line the consent hook says; n a person's name, h a proposal hash. */
export const SAY = {
  recorded: 'Recorded. The room shows it (and any note) already: post nothing about it. Agreeing is not a go-ahead to build; wait for the decision and your people.',
  /** after an objection with a note: the note is the person's words to the room and, often, to their own Claude ("ask
   * cameron if…"); live 2026-10-17 the model took "post nothing" as "do nothing" and the question was never asked, and
   * live on beta.23 a note of changes was logged and never written (the author's Claude is told this side writes it) */
  noteFollow: (n: string): string => `If ${n}'s note asks for changes, write them now as the plan's next version (plan, op edit); if it asks anything else (e.g. SendMessage NAME.CODE), do it now. Don't repeat the note.`,
  /** the author's Yes on their own new version: sent out (lib/proposal.ts sendOut) */
  /** others: who else was asked ("bob, carol"; '' in a room of one) */
  sent: (n: string, what: string, others: string, decided?: string | null): string => `${n} sent ${what} out${others ? `: ${others} asked to sign off` : ''}; `
    + `${n}'s Yes is their own sign-off${decided ? `; the room decided: ${decided}` : ''}. The room shows it: post nothing about it.`,
  sendFailed: (n: string, h: string, why: string): string => `${n}'s Yes on ${h} is recorded, but it did not go out (${why}). If ${n} asks, ask for sign-off (the plan tool, op ask).`,
  /** the author's note on their own new version: another version, nothing sent or recorded */
  revise: (n: string, h: string, title?: string | null): string => `Nothing was sent or recorded: ${n} wants changes to their own new version (${requestName(h, title)}). Write them as the plan's next version (${editCall(title)}); it comes back to ${n} before anyone else is asked.`,
  agreed: (n: string, h: string, decided?: string | null): string => `${n} agreed to proposal ${h}${decided ? `; the room decided: ${decided} (${n} sees it: don't restate it)` : ''}.`,
  objected: (n: string, h: string, decided?: string | null): string => `${n} objected to proposal ${h}${decided ? `; the room decided: ${decided} (${n} sees it: don't restate it)` : ''}.`,
  failed: (n: string, h: string, why: string, unknown: boolean): string => `proposal ${h}: NOT ${unknown ? 'confirmed, it may still be recorded' : 'recorded'} (${why}); ${n} has been told. Post nothing for them; open it again when ${n} asks.`,
  stale: (h: string): string => `proposal ${h}: nothing recorded (already answered, decided or unknown).`,
  done: `${DONE}`, // a template: an isolated declaration types it (a bare name it cannot)
  // the review
  /** the plan view's allow: no line (the view itself is what the person sees; "opening … for NAME" was their own name
   * in the third person) */
  opening: '',
  restoring: 'sub-human: restoring the mode after a room review',
  planBack: (n: string): string => `${n}'s plan mode is back. ${DONE}`,
  /** a Yes as the view opened */
  tooSoon: (n: string, h: string): string => `Nothing recorded yet: ${n}'s Yes came as the view opened, maybe keys meant for the prompt. Ask once on the card: ${NEXT.card(h)}; only that answer counts.`,
  tooSoonNotice: (title: string | null, h: string, typing: boolean): string => `your Yes on ${title ? `"${title}"` : `proposal ${h}`} came ${typing ? 'while you were typing' : 'right as the review opened'}, so it is not recorded yet: confirm it on the card that follows`,
  recheckAsk: (n: string, h: string): string => `room proposal ${h}: ${n}'s Yes came as the view opened; confirm it here`,
  showOnly: (n: string, h: string): string => `sub-human: this plan mode is only to show ${n} room proposal ${h}. Call ExitPlanMode now with plan "proposal ${h}"; plan nothing (the hooks show its text).`,
  exitNow: `sub-human: ${NEXT.exit}.`,
  /** an ExitPlanMode with no review open would show the person's own plan while a sign-off waits: denied once */
  steer: (n: string, h: string, title?: string | null): string => `sub-human: ${n} has a sign-off waiting (${requestName(h, title)}); this ExitPlanMode would show ${n}'s own plan file instead, so nothing was shown. `
    + `To show the sign-off: ${NEXT.open(h)}. For ${n}'s own plan, call ExitPlanMode again.`,
  noReviewOpen: (n: string, h: string): string => `sub-human: proposal ${h} is not ${n}'s to answer now (already answered, decided or unknown); nothing was shown and nothing is recorded. Plan nothing for it.`,
  /** the plan dialog's reason line: for the person, not the model. The dialog's own words ("approve", "Yes, … edits")
   * are about coding; this line says the answer is a sign-off on the text only */
  dialog: (n: string, h: string, from: string | null | undefined, mode: string | undefined, title?: string | null): string => `sign-off on ${requestName(h, title)}${from ? `, asked by ${from}` : ''}, for ${n}: `
    + 'agreeing signs off on this text, it is not a go-ahead to build (PgUp/PgDn scroll). '
    + `Agree: ${agreeHint(mode)}. Object: "Tell Claude what to change" + why. Esc: decide later.`,
  /** the dialog's line for the person's own new version (a draft): nobody else has been asked yet */
  dialogDraft: (n: string, h: string, mode: string | undefined, title?: string | null): string => `your new version, ${requestName(h, title)}, for ${n}: nobody else is asked until you send it out (PgUp/PgDn scroll). `
    + `Send it out (your own sign-off): ${agreeHint(mode)}. Keep editing: "Tell Claude what to change" + what. Esc: decide later.`,
  planView: (n: string, h: string): string => `Open it in the plan view instead: ${NEXT.open(h)}. The hooks show ${n} the full proposal.`,
  unread: (n: string, h: string): string => `${n}'s answer in the review of proposal ${h} is not on record yet; nothing was recorded.`,
  closed: (n: string, h: string): string => `${n} closed the review of proposal ${h} without answering; nothing was recorded.`,
  /** said once the dialog closed with a note (live, a model told the person it was recorded before the card) */
  noted: (n: string, h: string): string => `Nothing is recorded yet: ${n}'s note on ${h} waits for Send or Discard on its card. Next, ${NEXT.note(h)}.`,
  /** the dialog's rejection with a note, said in its own result (live, the model posted a paraphrase before the card) */
  rejectedNote: (n: string, h: string): string => `sub-human: nothing is recorded yet: ${n}'s note on ${h} waits for its card (Send or Discard), which decides what the room gets; post nothing about it. First call ExitPlanMode now (no plan needed); then ${NEXT.note(h)}.`,
  rejectedClosed: (n: string, h: string): string => `sub-human: ${n} closed the review of proposal ${h} without answering; nothing was recorded. First ${NEXT.exit}; then ${DONE.toLowerCase()}`,
  /** a post while a note waits for its card */
  noteWaits: (n: string, h: string): string => `sub-human: refused: ${n}'s note on proposal ${h} waits for Send or Discard on its card, which decides what the room gets. Post nothing about it; ${NEXT.note(h)}.`,
  nothingToShow: (h: string | undefined): string => `${h ? `proposal ${h}` : 'the room proposal'}: nothing to show (already answered, decided or unknown); nothing was recorded.`,
  reviewClosed: 'The room review is closed and the mode is restored; this was not a plan to carry out.',
  /** a review opened in the person's own plan mode, closed without a Yes: its closing ExitPlanMode is denied (plan
   * mode stays on, as it was), never let through to leave it */
  closedInPlan: (n: string): string => `The room review is closed; ${n}'s plan mode stays on, as it was before it (no need to call ExitPlanMode).`,
  /** the person's own plan file put back after a review wrote the proposal there (the model may have seen it change) */
  fileBack: 'The session plan file is back as it was before the review (the person\'s own plan, unchanged).',
  cardInstead: (n: string, h: string): string => ` The plan view could not show proposal ${h}: ${NEXT.card(h)} so ${n} answers on the card.`,
  edited: (n: string, h: string): string => `${n} edited proposal ${h} in the review; nothing was recorded (an edited text is a new proposal).`,
  modeChanged: (n: string, mode: string | undefined): string => `The dialog's "Yes" changed the mode; ${NEXT.restore(n, mode)}. Do not carry out the proposal.`,
  notAPlan: 'This was a room review, not a plan to carry out.',
  foreign: (n: string, h: string | undefined): string => ` The plan you passed was not shown (this plan mode showed ${n} room proposal ${h}; the plan file is back as it was).`,
  unshown: (n: string, hs: string, again: string): string => `Nothing recorded for ${hs}: no review opened, so ${n} did not answer (don't say they did). Ask again (${again}); don't carry it out.`,
  stillOpen: (n: string, next: string): string => `sub-human: ${n}'s room review is still open: ${next}.`,
  roomToolDenied: (said: string): string => `sub-human: ${said ? `${said} ` : ''}Post nothing about the review. First ${NEXT.exit}; then return to what you were doing.`,
  promptExit: (said: string): string => `sub-human: ${said ? `${said} ` : ''}Before anything else, ${NEXT.exit}; then continue.`,
  // the note and its confirm card
  noteAsk: (n: string, h: string): string => `room proposal ${h}: ${n}'s note, to send or discard`,
  nudge: (n: string, h: string): string => `${n}'s note on ${h} waits: ${NEXT.note(h)} (Send or Discard). ${keepNote(n)}`,
  reoffer: (n: string, h: string, interrupted: boolean): string => `${n}'s note on ${h}:${interrupted ? '' : ' its card was never shown.'} ${showNote(n, h, interrupted)} ${keepNote(n)}`,
  renudge: (n: string, h: string): string => `${n}'s note on ${h} still waits; Esc was no answer. First, ${NEXT.note(h)}. ${keepNote(n)}`,
  noteNoAnswer: (n: string, h: string): string => `Nothing was recorded: the card closed without ${n}'s answer; the note waits. If ${n} asks, ${NEXT.note(h)}. ${DONE}`,
  noteOther: (h: string): string => `proposal ${h}: no Send/Discard answer; nothing was recorded and the note waits. ${DONE}`,
  /** the person's notice once the card went by unanswered again: what each button does; the note keeps waiting */
  noteStillWaits: (title: string | null, h: string): string => `your note on ${title ? `"${title}"` : `proposal ${h}`} still waits, not sent. On its card, Send posts it as your objection; Discard drops it and records nothing (the proposal stays unanswered). Esc keeps it waiting: ask your Claude for the card when you decide`,
  discarded: (n: string, h: string): string => `${n} discarded the note; nothing was recorded and proposal ${h} still awaits ${n}'s answer. ${DONE}`,
  // the fallback card
  cardNoAnswer: (n: string): string => `Nothing was recorded: the card closed without ${n}'s answer. Reopening it later is fine. ${DONE}`,
  notYet: (n: string, h: string): string => `proposal ${h}: ${n} has not decided; nothing was recorded. Do not ask again unless ${n} asks.`,
  noChoice: (h: string): string => `proposal ${h}: no Agree/Object answer; nothing was recorded.`,
  // a join request's card (lib/remote/admission.ts)
  admitUnknown: (ref: string, code: RoomCode): string => `Nothing was done: no join request ${ref} in room ${code}. ${DONE}`,
  admitNoAnswer: (n: string, who: string, ref: string): string => `Nothing was decided: the join card closed without ${n}'s answer; ${who} still waits. If ${n} asks, ${NEXT.admit(ref)}. ${DONE}`,
  admitRefused: (n: string, who: string): string => `${n} refused ${who}; nothing got in. Post nothing about it. ${DONE}`,
  admitLetIn: (n: string, who: string, code: RoomCode): string => `${n} let ${who}'s machine into room ${code}. Post nothing about it. ${DONE}`,
  admitFailed: (n: string, why: string): string => `Nothing was done: ${why}. ${n} has been told. ${DONE}`,
};

/**
 * The model is to show the note's card now (consent's reoffer and renudge, and lib/tail.ts's reminder say it alike).
 * interrupted: the card was shown and closed with no answer (an Esc), which the model reads as declined; it is neither.
 */
export function showNote(_n: string, h: string, interrupted = false): string {
  return interrupted
    ? `Esc was no answer, not a decline. First, ${NEXT.note(h)}.`
    : `First, ${NEXT.note(h)}.`;
}

// ---------- the note ----------
/** A note's stage. */
export const stageOf = (cf: Confirm): NoteStage => cf.stage ?? 'waiting';
const staged = (cf: Confirm, stage: NoteStage): Confirm => ({ ...cf, stage });
/** The card shown (Pre AskUserQuestion): an offer still due becomes asked; one offered again is the last. */
const onShown = (s: NoteStage): NoteStage => (s === 'waiting' || s === 'nudged' || s === 'asked' ? 'asked' : 'told');

/** The seat still has something consent must act on at a turn's end or the next prompt (the mod's reviewMaybeOpen): a
 * note told already counts until the person heard once what Send and Discard do (noteAtPrompt: explained). */
export function openOf(state: State): boolean {
  return !!state.review || (!!state.note && (stageOf(state.note) !== 'told' || !state.note.explained));
}

// ---------- the review ----------
/** The plan file back as it was: the effect, and the review marked restored. */
function restore(r: Review): [Review, ConsentEffect[]] {
  if (!r.file || r.restored) return [r, []];
  return [{ ...r, restored: true }, [{ do: 'restorePlan', file: r.file, backup: typeof r.backup === 'string' ? r.backup : null }]];
}

/** Back up the plan file and write the proposal there as early as its path is known (EnterPlanMode Pre, else Post). */
function showEarly(r: Review, plan: PlanFile): [Review, ConsentEffect[]] {
  if (!plan.file || !r.hash || r.file) return [r, []];
  const next: Review = { ...r, file: plan.file, backup: personsPlan(plan.text), restored: false };
  return [next, [{ do: 'save', review: next }, { do: 'writePlan', file: plan.file, hash: r.hash, early: true }]];
}

/** Whether (and how) the handler reads the dialog's answer for this event: 'wait' polls for the line, 'now' does not. */
export function answerNeeded(r: Review | null, ev: { type: ConsentEvent['type']; toolUseId?: string | null; mode?: string | undefined }
): 'wait' | 'now' | null {
  if (!r || r.resolved || !(r.phase === 'shown' || r.unread)) return null;
  const same = !!r.tool_use_id && r.tool_use_id === ev.toolUseId;
  switch (ev.type) {
    case 'exit': return r.phase === 'shown' && same ? null : 'wait';
    case 'exited': return r.unread && same ? null : r.phase === 'exiting' ? 'wait' : null;
    case 'stop': return ev.mode === 'plan' && r.phase !== 'restore' && r.phase !== 'entering' ? 'now' : null;
    case 'roomTool': return r.phase === 'shown' || r.phase === 'exiting' ? 'now' : null;
    case 'prompt': return (ev.mode === 'plan' && r.phase !== 'restore') || r.unread ? 'now' : null;
    case 'enter': case 'entered': case 'planFailed': case 'permission': case 'rejected': case 'ask': case 'answered': return null;
    default: return assertNever(ev.type, 'consent event');
  }
}

/**
 * The dialog closed: what it said, once its tool_result is on disk (answer). A note never counts on its own: it opens
 * the note (Send on its card records it). No answer yet (answer null) with the call's id known is unread, unless the
 * review is closing (close): then it closed without an answer.
 */
function resolve(r: Review, note: Confirm | null, ev: { answer?: ReviewAnswer | null; target?: Target | null }, ctx: ReviewCtx, close = false): { review: Review; note: Confirm | null } {
  if (r.resolved || !(r.phase === 'shown' || r.unread)) return { review: r, note };
  const h = r.hash || '';
  const seen = ev.answer ?? null;
  if (!seen && r.tool_use_id && !close) return { review: { ...r, unread: true, said: SAY.unread(ctx.name, h) }, note };
  const { unread: _u, ...rest } = r;
  const text = seen ? seen.note : null;
  if (text == null || !text.trim()) return { review: { ...rest, resolved: true, said: SAY.closed(ctx.name, h) }, note };
  const t = ev.target && ev.target.hash === r.hash ? ev.target : null;
  if (!t) return { review: { ...rest, resolved: true, said: SAY.stale(h) }, note };
  if (r.draft || t.draft) return { review: { ...rest, resolved: true, revise: true, said: SAY.revise(ctx.name, h, r.title ?? t.title) }, note };
  return { review: { ...rest, resolved: true, said: SAY.noted(ctx.name, h) },
    note: { hash: t.hash, note: text, from: t.from, title: t.title, at: ctx.now, stage: 'waiting' } };
}

/** A blank plan, or the "proposal <hash>" stub the model is told to pass: not a plan of its own. */
const stub = (t: string) => !t.trim() || /^\s*(?:the room )?proposal\s+[0-9a-f]{6,12}\s*\.?\s*$/i.test(t);
/** What a review backs up of the plan file: the person's own plan, never a stub a model wrote ("proposal HASH"), which a
 * restore would put back for the closing ExitPlanMode to show as an older proposal's hash: null, so the restore
 * removes the file. */
const personsPlan = (t: string | null | undefined): string | null => (typeof t === 'string' && !stub(t) ? t : null);

/** Post(ExitPlanMode) with no review shown although its dialog was a pending proposal's: tell the model. */
function unshown(ev: Extract<ConsentEvent, { type: 'exited' }>, ctx: ReviewCtx, hashes: string[]): { effects: ConsentEffect[]; say: Say } | null {
  if (!ev.pending.length || ev.response.isAgent) return null;
  const plan = typeof ev.response.plan === 'string' ? ev.response.plan : typeof ev.callPlan === 'string' ? ev.callPlan : '';
  let hit = ev.pending.filter(p => hashes.includes(p.hash));
  // its text, but not a plan of my own that I proposed (that is my plan, already in the room)
  if (!hit.length && plan.trim()) { const h = hash12(Buffer.from(plan, 'utf8')); hit = ev.pending.filter(p => p.from !== ctx.name && p.hash === h); }
  if (!hit.length && plan.length < 300) hit = ev.pending.filter(p => ev.callNames.includes(p.hash));
  if (!hit.length && !plan.trim()) hit = ev.pending;
  const [first] = hit;
  if (!first) return null;
  const again = ev.reviewable && hit.every(p => p.viewable) ? NEXT.open(first.hash) : NEXT.card(first.hash);
  return { effects: [], say: { to: 'context', parts: [SAY.unshown(ctx.name, hit.map(p => p.hash).join(', '), again)] } };
}

const none = (state: State): ReviewStep => ({ state, effects: [], say: null });
/** A Yes that may not be the person's choice: it came within YES_GUARD_MS of the view being shown, or they had typed
 * text in the prompt as it opened (their next keys went to the dialog). */
const quickYes = (r: Review, ctx: ReviewCtx): boolean => !!r.typing || (typeof r.shownAt === 'number' && ctx.now - r.shownAt < (ctx.guardMs ?? YES_GUARD_MS));
const ctxSay = (...parts: Part[]): Say => ({ to: 'context', parts });

/** Pre(ExitPlanMode) (the reduce case 'exit', before closeInPlan). */
function exitStep(state: State, ev: Extract<ConsentEvent, { type: 'exit' }>, ctx: ReviewCtx): ReviewStep {
  const n = ctx.name;
  const r = state.review;
  if (!r) {
    // No review opened (plan mode by hand, or EnterPlanMode skipped), yet the plan is a proposal's name: open its
    // review here, or deny the call; a bare plan view of "proposal HASH" never records anything
    if (!ev.stub) return steer(state, ev, ctx);
    if (!ev.stub.live) return { state, effects: [], say: { to: 'deny', parts: [SAY.noReviewOpen(n, ev.stub.hash)] } };
    if (!ev.shown || !ev.plan.file || ev.text == null) return { state, effects: [], say: { to: 'deny', parts: [SAY.cardInstead(n, ev.stub.hash).trim()] } };
    // plan mode is the person's own (the call is ExitPlanMode's, so the session is in it): a Yes leaves it, and the
    // review puts it back
    const opened: Review = { phase: 'entering', mode: 'plan', at: ctx.now, hash: ev.shown.hash, from: ev.shown.from || null, ...(ev.shown.title ? { title: ev.shown.title } : {}), ...(ev.shown.draft ? { draft: true } : {}) };
    return exitStep({ ...state, review: opened }, ev, ctx);
  }
  if (r.phase === 'shown' && r.tool_use_id && r.tool_use_id === ev.toolUseId) { // the same call again
    return { state, effects: [], say: { to: 'ask', text: dialogOf(n, r), show: { plan: r.hash || '' } } };
  }
  if (r.phase === 'shown' || r.unread) { // the closing call: the dialog has closed, its answer was waited for
    // the person's own plan mode: this call closes the review there (closeInPlan), so the dialog's answer is read now
    const res = resolve(r, state.note, ev, ctx, r.mode === 'plan');
    return { state: { review: { ...res.review, phase: 'exiting' }, note: res.note }, effects: [], say: null };
  }
  if (r.phase !== 'entering') return { state: { ...state, review: { ...r, phase: 'exiting' } }, effects: [], say: null };
  // The hook's review: the proposal Pre(EnterPlanMode) picked, whatever this call carries.
  let review: Review = { ...r };
  const effects: ConsentEffect[] = [];
  if (review.file && review.file !== ev.plan.file) {
    const [back, e] = restore(review);
    effects.push(...e);
    const { file: _f, backup: _b, ...rest } = back;
    review = rest;
  }
  const backup = review.file === ev.plan.file && !review.restored ? review.backup ?? null : personsPlan(ev.plan.text);
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
  const title = ev.shown.hash === review.hash ? ev.shown.title ?? review.title : ev.shown.title;
  const { draft: _d, ...unmarked } = review;
  const before: Review = { ...unmarked, hash: ev.shown.hash, from: ev.shown.from || null, ...(title ? { title } : {}), ...(ev.shown.draft ? { draft: true } : {}), file: ev.plan.file, backup,
    restored: false, tool_use_id: ev.toolUseId || null, shownAt: ctx.now, ...(ev.typing ? { typing: true } : {}) };
  effects.push({ do: 'save', review: before }, { do: 'writePlan', file: ev.plan.file, hash: ev.shown.hash, early: false });
  return { state: { ...state, review: { ...before, phase: 'shown' } }, effects,
    say: { to: 'ask', text: dialogOf(n, before), show: { plan: ev.shown.hash } } };
}

/** The plan dialog's line for review r: the person's own new version, else a sign-off. */
const dialogOf = (n: string, r: Review): string => (r.draft ? SAY.dialogDraft(n, r.hash || '', r.mode, r.title) : SAY.dialog(n, r.hash || '', r.from, r.mode, r.title));

/** How long a steered ExitPlanMode's repeat counts as the same call (the person's own plan meant after all). */
const STEER_MS = 10 * 60_000;
/**
 * Pre(ExitPlanMode) with no review open and no stub (live validation A): Claude Code put the plan file's text in the
 * call, so in plan mode with a plan of the person's own and a sign-off waiting, the view would show their plan where
 * the model may have meant the sign-off (its "proposal HASH" reaches no hook). Denied once with both ways on; the same
 * call again (same request, same plan text) passes: their own plan was meant.
 */
function steer(state: State, ev: Extract<ConsentEvent, { type: 'exit' }>, ctx: ReviewCtx): ReviewStep {
  const w = ev.waiting;
  const s = state.steer;
  if (!w) return s ? { state: { ...state, steer: null }, effects: [], say: null } : none(state);
  if (s && s.hash === w.hash && s.plan === w.plan && ctx.now - s.at < STEER_MS) return { state: { ...state, steer: null }, effects: [], say: null };
  return { state: { ...state, steer: { hash: w.hash, plan: w.plan, at: ctx.now } }, effects: [], say: { to: 'deny', parts: [SAY.steer(ctx.name, w.hash, w.title)] } };
}

/**
 * A review opened in the person's own plan mode (they were in it before EnterPlanMode, or opened it by hand) and now
 * closing without a Yes (Esc, a note, nothing to show, the card instead): its closing ExitPlanMode is denied, the plan
 * file put back and the review cleared here. Let through, the call would leave the plan mode the person chose, and
 * with their own plan back in the file Claude Code would hand it to the model as approved. A review in its restore
 * phase (a Yes left plan mode already) is not this.
 */
function closeInPlan(prev: State, step: ReviewStep, ctx: ReviewCtx): ReviewStep {
  const rv = step.state.review;
  if (!rv || rv.phase !== 'exiting' || rv.mode !== 'plan' || step.say || (prev.review && prev.review.phase === 'restore')) return step;
  const [, effects] = restore(rv);
  const all = [...step.effects, ...effects];
  const noted = !!step.state.note && step.state.note !== prev.note; // the person's note opened: its card is next
  const said = rv.said ? `${rv.said} ` : '';
  const card = rv.card ? SAY.cardInstead(ctx.name, rv.card) : '';
  const back = rv.foreign ? [SAY.foreign(ctx.name, rv.hash)] : backLine(all);
  return { ...step, state: { ...step.state, review: null }, effects: all,
    say: { to: 'deny', parts: [`sub-human: ${said}${SAY.closedInPlan(ctx.name)}${card}`, ...back, ...(noted || card ? [] : doneUnless(rv))] } };
}

/**
 * A review in the person's own plan mode closed where it stands (live validation: after an Esc the model would not
 * call the ExitPlanMode the person had just refused): the dialog's answer read now, the plan file put back, the review
 * cleared; plan mode stays on, so no ExitPlanMode is needed. A note opened here waits for its card.
 */
function closedHere(state: State, r: Review, ev: { answer?: ReviewAnswer | null; target?: Target | null }, ctx: ReviewCtx): ReviewStep {
  const res = resolve(r, state.note, ev, ctx, true);
  const [, effects] = restore(res.review);
  const noted = !!res.note && res.note !== state.note;
  const said = res.review.said ? `${res.review.said} ` : '';
  const back = r.foreign ? [SAY.foreign(ctx.name, r.hash)] : backLine(effects);
  return { state: { ...state, review: null, note: res.note }, effects, say: ctxSay(`sub-human: ${said}${SAY.closedInPlan(ctx.name)}`, ...back, ...(noted ? [] : doneUnless(res.review))) };
}

/** F (live validation): the model is told when the person's own plan file came back (it may have seen the proposal
 * there, and took the file for overwritten). */
const backLine = (effects: ConsentEffect[]): Part[] => (effects.some(e => e.do === 'restorePlan' && e.backup != null) ? [SAY.fileBack] : []);

export function reduce(state: State, ev: ConsentEvent, ctx: ReviewCtx): ReviewStep {
  const n = ctx.name;
  const r = state.review;
  switch (ev.type) {
    case 'enter': {
      if (r && r.phase === 'restore') return { state, effects: [], say: { to: 'allow', text: SAY.restoring } };
      const [oldest] = ev.pending;
      if (!oldest || !ev.reviewable) return none(state);
      // a review left behind: its backup goes back before a new one is taken
      const [, effects] = r ? restore(r) : [r, [] as ConsentEffect[]];
      // the request the person's latest words name (a hash, a plan's name), else the oldest: never the model's choice
      const p = (ev.named ? ev.pending.find(q => q.hash === ev.named) : undefined) ?? oldest;
      let review: Review = { phase: 'entering', mode: ev.mode, at: ctx.now, hash: p.hash, from: p.from || null, ...(p.title ? { title: p.title } : {}), ...(p.draft ? { draft: true } : {}) };
      const note = state.note && state.note.hash === p.hash ? null : state.note; // reviewed again: its note is superseded
      // the file as it will be once the left-behind review's restore has run (the facts were read before it)
      const now = r && r.file && r.file === ev.plan.file && !r.restored ? { file: r.file, text: typeof r.backup === 'string' ? r.backup : null } : ev.plan;
      const [shown, early] = showEarly(review, now);
      review = shown;
      return { state: { review, note }, effects: [...effects, ...early],
        say: { to: 'allow', text: SAY.opening } };
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
      return closeInPlan(state, { state: { ...state, review: { ...back, phase: 'exiting', card: r.hash } }, effects, say: null }, ctx);
    }

    case 'exit': return closeInPlan(state, exitStep(state, ev, ctx), ctx);

    case 'permission': {
      if (!r || r.phase !== 'exiting') return none(state);
      // the plan file emptied, not restored: the closing call reads it as it runs, and the person's own plan there
      // would show as approved (lib/cc/env.ts LEAVE_PLAN_TEXT); exited (or the next prompt) restores it
      const review: Review = r.file ? { ...r, restored: false } : r;
      const effects: ConsentEffect[] = r.file ? [{ do: 'blankPlan', file: r.file }] : [];
      return { state: { ...state, review }, effects, say: { to: 'permit', mode: r.mode } };
    }

    case 'exited': {
      const fallback = (base: State, effects: ConsentEffect[], hashes: string[]): ReviewStep => {
        // the person's own plan approved in the dialog is never an answer: only a review the hooks opened records one
        const u = unshown(ev, ctx, hashes);
        return u ? { state: base, effects: [...effects, ...u.effects], say: u.say } : { state: base, effects, say: null };
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
      /** the plan file's line (foreign says it already) */
      const fileLine = (effects: ConsentEffect[]): Part[] => (foreign.length ? foreign : backLine(effects));
      if (cur.phase === 'exiting') {
        const res = resolve(cur, state.note, ev, ctx, true); // unread until now: the note, if any, waits for Send
        const [, effects] = restore(res.review);
        const card = cur.card ? SAY.cardInstead(n, cur.card) : '';
        const said = res.review.said ? `${res.review.said} ` : '';
        return { state: { review: null, note: res.note }, effects, say: ctxSay(`${said}${SAY.reviewClosed}${card}`, ...doneUnless(res.review), ...(foreign.length ? foreign : backLine(effects))) };
      }
      if (cur.phase !== 'shown') return none(state);
      // A "Yes" in the dialog: only a person can choose it (the exiting phase above is the hook's own allow).
      const h = cur.hash || '';
      const plan = ev.response.plan;
      const effects: ConsentEffect[] = [];
      let line: Part[];
      let recheck: Recheck | null | undefined = state.recheck;
      let notice: string | undefined;
      if (ev.response.edited || typeof plan !== 'string' || hash12(Buffer.from(plan, 'utf8')) !== shownHash(cur)) line = [SAY.edited(n, h)];
      else if (!ev.target || ev.target.hash !== cur.hash) line = [SAY.stale(h)];
      else if (quickYes(cur, ctx)) { // keys meant for the prompt may have answered it: the card asks once
        recheck = { hash: h, at: ctx.now };
        line = [SAY.tooSoon(n, h)];
        notice = SAY.tooSoonNotice(ev.target.title, h, !!cur.typing);
      } else {
        effects.push({ do: 'answer', hash: h, choice: 'Agree' });
        line = cur.draft ? [{ answer: h }] : [{ ifRecorded: SAY.recorded }, { answer: h }]; // a draft's outcome is where it went (SAY.sent)
      }
      const [back, e] = restore(cur);
      effects.push(...e);
      const withNotice = notice ? { notice } : {};
      if (ev.mode && ev.mode !== cur.mode && !cur.keepMode) {
        const { said: _s, ...rest } = back;
        return { state: { ...state, recheck, review: { ...rest, phase: 'restore' } }, effects, say: ctxSay(...line, SAY.modeChanged(n, cur.mode), ...fileLine(effects)), ...withNotice };
      }
      return { state: { ...state, recheck, review: null }, effects, say: ctxSay(...line, SAY.notAPlan, ...fileLine(effects)), ...withNotice };
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
      else if (r.mode === 'plan' && r.phase !== 'entering') return closedHere(state, r, ev, ctx); // plan mode is the person's
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
      const h = r.hash || '';
      if (r.mode === 'plan') { // the person's own plan mode: closed here, no ExitPlanMode to leave it
        return closedHere(state, r, ev, ctx); // a note's card follows at once: no notice before it
      }
      const res = resolve(r, state.note, ev, ctx, true);
      const added = res.note !== state.note ? res.note : null;
      if (res.review.revise) { // the person's own new version, and a note: their next version, after the closing call
        const { said: _s, ...rest } = res.review;
        return { state: { review: { ...rest, phase: 'exiting' }, note: res.note }, effects: [],
          say: ctxSay(`sub-human: First ${NEXT.exit}. Then: ${res.review.said ?? ''}`) };
      }
      return { state: { review: { ...res.review, phase: 'exiting' }, note: res.note }, effects: [],
        say: ctxSay(added ? SAY.rejectedNote(n, h) : SAY.rejectedClosed(n, h)) };
    }

    case 'prompt': {
      if (!r) return noteAtPrompt(state, ev, ctx);
      if (ev.mode === 'plan' && r.phase !== 'restore' && r.mode === 'plan') return closedHere(state, r, ev, ctx); // the person's plan mode
      if (ev.mode === 'plan' && r.phase !== 'restore') {
        const res = resolve(r, state.note, ev, ctx);
        return { state: { review: { ...res.review, phase: 'exiting' }, note: res.note }, effects: [], say: ctxSay(SAY.promptExit(res.review.said || '')) };
      }
      // left plan mode another way: a note read only now still waits for Send
      const res = r.unread ? resolve(r, state.note, ev, ctx, true) : { review: r, note: state.note };
      const [, effects] = restore(res.review);
      const back = backLine(effects);
      return { state: { review: null, note: res.note }, effects, say: back.length ? ctxSay(...back) : null };
    }

    case 'ask': {
      if (ev.admit) return { state, effects: [], say: { to: 'ask', text: '', show: { admit: ev.admit } } };
      let note = state.note;
      if (note && !ev.live) note = null; // its proposal is no longer this seat's to answer
      if (note && ev.noteNamed) {
        return { state: { ...state, note: staged(note, onShown(stageOf(note))) }, effects: [],
          say: { to: 'ask', text: SAY.noteAsk(n, note.hash), show: { note: true } } };
      }
      const base = { ...state, note };
      const [first] = ev.hit;
      if (!first) return none(base);
      // a Yes that came as the plan view opened is confirmed on the card, not in the view again
      const recheck = state.recheck;
      const again = recheck ? ev.hit.find(p => p.hash === recheck.hash) : undefined;
      if (again) return { state: base, effects: [], say: { to: 'ask', text: SAY.recheckAsk(n, again.hash), show: { card: [again.hash] } } };
      if (ev.reviewable && ev.hit.every(p => p.viewable)) {
        return { state: base, effects: [], say: { to: 'deny', parts: [SAY.planView(n, first.hash)] } };
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
          say: ctxSay({ ifRecorded: SAY.recorded }, ...(cf.note.trim() ? [{ ifRecorded: SAY.noteFollow(n) }, { answer: cf.hash }] : [{ answer: cf.hash }, { ifRecorded: DONE }])) };
      }
      if (!ev.answers.length && !ev.asked) return none(state); // not a consent card
      // the recheck is asked once: any card for its proposal settles it, answered or not
      const held = state.recheck;
      const rc = held && (ev.answers.some(a => a.hash === held.hash) || !ev.answers.length) ? null : held;
      state = rc === state.recheck ? state : { ...state, recheck: rc };
      if (ev.afk || !ev.answers.length) return { state, effects: [], say: ctxSay(SAY.cardNoAnswer(n)) };
      const effects: ConsentEffect[] = [];
      const parts: Part[] = [];
      let signed = false; // a sign-off answered (a draft's Yes is told where it went instead: SAY.sent)
      for (const a of ev.answers) {
        if (!a.live) { parts.push(SAY.stale(a.hash)); continue; }
        if (a.answer.kind === 'answer' && a.answer.label === 'Not yet') { parts.push(SAY.notYet(n, a.hash)); continue; }
        if (a.answer.kind !== 'answer' || (a.answer.label !== 'Agree' && a.answer.label !== 'Object')) { parts.push(SAY.noChoice(a.hash)); continue; }
        if (a.draft && a.answer.label === 'Object') { parts.push(SAY.revise(n, a.hash)); continue; } // their own version: another one, nothing recorded
        effects.push({ do: 'answer', hash: a.hash, choice: a.answer.label, ...(a.answer.notes !== undefined ? { notes: a.answer.notes } : {}) });
        if (!a.draft) signed = true;
        parts.push({ answer: a.hash });
      }
      if (signed || !effects.length) parts.unshift({ ifRecorded: SAY.recorded });
      const noted = effects.some(x => x.do === 'answer' && x.choice === 'Object' && typeof x.notes === 'string' && x.notes.trim());
      if (noted) parts.splice(1, 0, { ifRecorded: SAY.noteFollow(n) }); // second: a long text is cut at its end
      else if (!ev.answers.some(a => a.draft && a.answer.kind === 'answer' && a.answer.label === 'Object')) parts.push(DONE);
      return { state, effects, say: ctxSay(...parts) };
    }
    default: return assertNever(ev, 'consent event');
  }
}

/** Stop with no review: a note whose card was never shown is asked for once (nudged); an interrupted card offered
 * again and not shown since, once more (renudge). */
function noteAtStop(state: State, ev: Extract<ConsentEvent, { type: 'stop' }>, ctx: ReviewCtx): ReviewStep {
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
function noteAtPrompt(state: State, ev: Extract<ConsentEvent, { type: 'prompt' }>, ctx: ReviewCtx): ReviewStep {
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
