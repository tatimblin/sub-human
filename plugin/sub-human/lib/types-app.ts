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
  recheck?: Recheck;
  steer?: Steer;
  blocks?: Record<string, number>;
  /** ids the consent hook already told this seat's model (a decision its answer made): the room context skips them */
  reported?: number[];
}

// ---------- lib/tasks.ts ----------
/** One task on the room's list (the mirror tasks.json). */
export interface Task {
  id: string;
  subject: string;
  status: string;
  owner: string | null;
  blockedBy: string[];
  /** the suggested owner an add named (kept after a claim, as the log keeps it; shown only while nobody owns it) */
  suggest?: string;
  /** the room plan it was added from, and that plan's version then (lib/tasks.ts fold) */
  plan?: string;
  version?: number;
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
export type Proposal = Pick<ProposalState, 'id' | 'hash' | 'approvers' | 'path' | 'from'> & { entry?: Entry; draft?: boolean };
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
  /** the author's own check of a version they wrote (lib/proposal.ts ask draft): a Yes sends it out, a note asks for
   * another version, and nothing is recorded but the Yes */
  draft?: boolean;
  /** a draft's review closed with a note: the person wants another version (nothing sent or recorded) */
  revise?: boolean;
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
  /** the person's note was recorded (hooks/consent.ts, the answer effect's sentTo): the closing plan line of a person
   * in auto mode says where it went */
  closing?: 'sent';
  /** hash12 of what the review last wrote to the plan file (the framed version, the closing line): a stale review's
   * restore (lib/proposal.ts restoreStale) puts the person's plan back over it, never over a file they wrote since */
  wrote?: string;
}
/** members/NAME/session recheck: a Yes that came as the plan view opened, recorded only once the person confirms it on
 * the card (lib/consent/review.ts); asked once. */
export interface Recheck { hash: string; at: number }
/** members/NAME/session steer: an ExitPlanMode made in plan mode with no review open while a sign-off request waited,
 * denied once because it would show the person's own plan file (lib/consent/review.ts steer): the request (hash) and
 * the plan text's hash12 (plan). The same call again passes: the person's own plan was meant. */
export interface Steer { hash: string; plan: string; at: number }
/** A review's note, within one consent step (lib/consent/review.ts reduce sends it at once). */
export interface Confirm {
  hash: string;
  note: string;
  from: string | null;
  title: string | null;
  at: number;
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
  | { type: 'reminders', text: string | null }
  | { type: 'here', text: string }
  | { type: 'health', text: string; quiet?: true }
  | { type: 'invites', open: string[], expired?: string[] }
  | { type: 'take', code: string, name: string, text: string, check?: string };
