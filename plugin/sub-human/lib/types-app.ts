/**
 * plugin/sub-human/lib/types-app.ts: shared types of the app slice (tail, rows, proposal, handoff, room-claude, tasks,
 * seats, notices). Types only: nothing here exists at run time.
 *
 * The shapes other modules own (a log entry, a member record, a seat, the clock) are theirs: lib/room/types.ts,
 * lib/identity.ts, lib/clock.ts.
 */

import type { Entry, HostProof, ProposalState } from './room/types.ts';
import type { HandoffAsk } from './remote/types-core.ts';

// ---------- lib/rows.ts ----------
/** rows/holds-NAME as readHolds returns it (mcp/hold.ts writes it). */
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
/** The `task` tool's request, normalized (validate). */
export interface TaskReq {
  op: string;
  id?: string;
  subject?: string;
  detail?: string;
  evidence?: string;
  for?: string;
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
  mode?: string;
  at?: number;
  hash?: string;
  from?: string | null;
  file?: string;
  backup?: string | null;
  restored?: boolean;
  tool_use_id?: string | null;
  said?: string;
  resolved?: boolean;
  foreign?: boolean;
  card?: string;
}
/** members/NAME/confirm: a review's note waiting for the person's Send (asked: when its card was shown). */
export interface Confirm {
  hash: string;
  note: string;
  from: string | null;
  title: string | null;
  at: number;
  asked?: number;
  /** when Stop nudged the model to show a card it never showed (hooks/consent.ts unasked): once */
  nudged?: number;
  /** when the card's no-answer close was told, or an interrupted card offered again (hooks/consent.ts reoffer): once */
  again?: number;
  /** when reoffer offered an interrupted card again: a Stop with no card asked since nudges once more (renudged) */
  reoffered?: number;
  renudged?: number;
}

// ---------- lib/handoff.ts ----------
/** The host document remote/handoff. */
export interface HandoffDoc {
  id: string;
  state: 'asked' | 'refused' | 'moved';
  from: string;
  to: string;
  epoch: number;
  at: string;
  expires_at: string;
  locator?: string;
  ask?: HostProof;
  machine?: string;
  host_id?: number;
  moved_at?: string;
  refused_at?: string;
  invites?: Record<string, string>;
  invites_expire_at?: string;
}
/** The ask as the target's machine keeps it (the session-local document `handoff`): the 'handoff' event's data,
 * when it came, and when this seat's Claude was told. */
export type HandoffAskDoc = HandoffAsk & { at?: string; told_at?: string };

// ---------- lib/tail.ts ----------
/** The seat a tail follows, as its `seat` event names it. */
export interface TailSeat {
  name: string;
  code: string;
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
  | { type: 'health', text: string };
