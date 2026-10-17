/**
 * plugin/sub-human/lib/types-app.ts: shared types of the app slice (tail, rows, proposal, room-claude, tasks,
 * seats, notices). Types only: nothing here exists at run time.
 *
 * The shapes other modules own (a log entry, a member record, a seat, the clock) are theirs: lib/room/types.ts,
 * lib/identity.ts, lib/clock.ts.
 */

import type { Entry, ProposalState } from './room/types.ts';
import type { RoomCode } from './brand.ts';

// ---------- lib/room/session.ts ----------
/** A seat's session document, members/NAME/session (lib/room/session.ts documents each field). */
export interface SessionDoc {
  v: 1;
  cursor?: number;
  shown?: { ids: number[]; log: { id: number; via: string; at: string }[] };
  review?: Review;
  confirm?: Confirm;
  edit?: PlanEdit;
  recheck?: Recheck;
  holds?: Holds;
  blocks?: Record<string, number>;
}

// ---------- lib/rows.ts ----------
/** A seat's holds as readHolds returns them (mcp/hold.ts writes them to its session document). */
export interface Holds {
  pid: number;
  at: string;
  members: string[];
  room: boolean;
  roomUntil?: string;
}
/** One agent -> row record (rows/<session_id>.byAgent). */
export interface RowRec {
  kind?: 'participant' | 'room';
  name: string;
  parent?: string | null;
  at?: string; // recordRow stamps it; the status line's own guesses have none
}
export interface Spawn {
  kind: 'participant' | 'room';
  name: string;
}

// ---------- lib/tasks.ts ----------
/** One task on the room's list (the mirror tasks.json). */
export interface Task {
  id: string;
  subject: string;
  status: string;
  owner: string | null;
  blockedBy: string[];
  metadata?: { _internal?: unknown };
}
/** The `task` tool's request, normalized (validate). suggest: add only, a suggested owner (never an owner). */
export interface TaskReq {
  op: string;
  id?: string;
  subject?: string;
  detail?: string;
  evidence?: string;
  suggest?: string;
  /** add: the room plan it comes from; the host tags it with that plan's current version */
  plan?: string;
}
/** One task as the log's `task` entries leave it (lib/tasks.ts foldAll): the room task and deleted ones included, with
 * what its native file carries (lib/room/task-files.ts project). */
export interface FoldedTask {
  id: string;
  subject: string;
  detail?: string;
  status: string;
  owner: string | null;
  blockedBy: string[];
  req?: number;
  by?: string;
  suggest?: string;
  plan?: string;
  version?: number;
}

// ---------- lib/proposal.ts ----------
/** A proposal as proposals() / pendingFor() list it: the fold's latest entry per hash (lib/room/consent.ts), shaped
 * (lib/proposal.ts shape keeps no entry; a caller that has one may pass it along). */
export type Proposal = Pick<ProposalState, 'id' | 'hash' | 'approvers' | 'path' | 'from'> & { entry?: Entry };
/** An AskUserQuestion input (the card the hooks show). */
export interface Card {
  questions: {
    question: string;
    header: string;
    multiSelect: boolean;
    options: { label: string, description: string, preview?: string }[];
  }[];
}
/** members/NAME/review: the plan-view review state (hooks/consent.ts writes it). */
export interface Review {
  phase: 'entering' | 'shown' | 'exiting' | 'restore';
  mode?: string | undefined;
  at?: number;
  hash?: string;
  from?: string | null;
  /** how the person knows the request ("plan paging v3": lib/proposal.ts title), for the dialog's line */
  title?: string | null;
  file?: string;
  backup?: string | null;
  restored?: boolean;
  tool_use_id?: string | null;
  said?: string;
  resolved?: boolean;
  /** closed while its dialog's tool_result was not on disk yet: the answer is read again later (hooks/consent.ts resolveShown) */
  unread?: boolean;
  foreign?: boolean;
  card?: string | undefined;

  /** opened at ExitPlanMode in a plan mode the person chose (no EnterPlanMode of the review's): no mode to restore */
  keepMode?: boolean;
  /** when the plan view was shown (its Pre(ExitPlanMode)): a Yes this soon after is asked again on the card (item 8) */
  shownAt?: number;
  /** the person had typed text in the prompt when the plan view opened: their keys may answer it, so a Yes is asked again */
  typing?: boolean;
}
/**
 * members/NAME/session edit: a room plan edit in this seat's session (the plan tool's edit op opens it; the hooks run
 * it: lib/consent/edit.ts). open: the plan file is (to be) seeded with the base version; stored: the version is in the
 * room, and one more ExitPlanMode only leaves plan mode.
 */
export interface PlanEdit {
  phase: 'open' | 'stored';
  plan: string;
  /** the version the edit started from (0: a new plan); a conflict moves it to the current one */
  base: number;
  at: number;
  /** the person's mode at EnterPlanMode, put back when plan mode is left */
  mode?: string | undefined;
  /** the session plan file the edit was seeded into, and what it held before (null: no file) */
  file?: string;
  backup?: string | null;
  restored?: boolean;
  /** stored: the version it made (unchanged: the same text as the base) */
  version?: number;
  unchanged?: boolean;
}
/** members/NAME/session recheck: a Yes that came as the plan view opened, recorded only once the person confirms it on
 * the card (lib/consent/review.ts); asked once. */
export interface Recheck { hash: string; at: number }
/** Where a review's note stands (lib/consent/review.ts): waiting (its card never shown), nudged (Stop asked for the card
 * once), asked (the card was shown; no Post yet), reoffered (an interrupted card offered again at the next prompt),
 * told (the model was told the card closed without an answer, or every offer is spent: the card is the person's to ask for). */
export type NoteStage = 'waiting' | 'nudged' | 'asked' | 'reoffered' | 'told';
/** members/NAME/confirm: a review's note waiting for the person's Send. */
export interface Confirm {
  hash: string;
  note: string;
  from: string | null;
  title: string | null;
  at: number;
  /** absent: waiting (lib/consent/review.ts stageOf) */
  stage?: NoteStage;
  /** the person was told, once, what Send and Discard do after the card closed with no answer more than once (stage 8e D) */
  explained?: true;
}

// ---------- lib/tail.ts ----------
/** The seat a tail follows, as its `seat` event names it. */
export interface TailSeat {
  name: string;
  code: RoomCode;
  role: 'claude' | 'member';
  addr: string;
}

/**
 * One JSON line of `sub-human tail --ndjson` (lib/tail.ts header has what each means), which the hooks module routes
 * (mod/core/deliver.ts parseEvent).
 */
export type TailEvent =
  | { type: 'seat', seat: TailSeat | null }
  | { type: 'chat', lines: string[] }
  | { type: 'pull', text: string }
  | { type: 'wake', text: string }
  | { type: 'rows', text: string | null }
  | { type: 'health', text: string }
  | { type: 'invites', open: string[] };
