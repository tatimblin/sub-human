/**
 * plugin/sub-human/lib/types-app.ts: shared types of the app slice (tail, rows, proposal, handoff, room-claude, tasks,
 * seats, notices). Types only: nothing here exists at run time.
 *
 * The shapes other slices own (a log entry, a member record, the store) are declared here only as far as these files
 * read them; the room slice's own types replace them where they agree.
 */

// ---------- the room log and its members, as these files read them ----------
/** A room log entry (lib/room/store.ts), the fields these files read. */
export interface LogEntry {
  id: number;
  kind: string;
  from: string;
  via: string;
  at: string;
  to?: string;
  text?: string;
  // proposals (lib/proposal.ts)
  hash?: string;
  approvers?: string[];
  path?: string;
  proposal_hash?: string;
  refs?: number[];
  // tasks (lib/tasks.ts)
  op?: string;
  task_id?: string | number;
  subject?: string;
  detail?: string;
  evidence?: string;
  owner?: string | null;
  status?: string;
  blockedBy?: string[];
  req?: number | null;
  by?: string;
}

/** What an append takes: an entry before the store numbers, stamps and signs it. */
export type NewEntry = { kind: string, text?: string } & Record<string, unknown>;

/** A seat record in members.json (lib/room/members.ts), the room's Claude's included. */
export interface MemberRec {
  name: string;
  role?: string;
  machine?: string;
  pid?: number | null;
  pid_start?: number;
  session_id?: string | null;
  cwd?: string | null;
  joined_at?: string;
  left_at?: string;
  seen_at?: string;
  // the room's Claude (lib/room-claude.ts)
  job?: string | null;
  job_session?: string;
  claim?: string;
  by?: string;
  spawned_at?: string;
  spawn_error?: string;
  closing?: string;
  stopped_at?: string;
  orphan_since?: string;
  moved_at?: string;
}
/** members.json: name -> record. */
export type Members = Record<string, MemberRec | undefined>;
/** A patch updateRoomClaude merges into the room's Claude's record (undefined deletes a field). */
export type RoomClaudePatch = { [K in keyof MemberRec]?: MemberRec[K] | undefined };

/** The seat a session holds (lib/identity.ts resolveSelf): who "me" is. */
export interface Seat {
  code: string;
  name: string;
  role: string;
  pid?: number;
  session_id?: string | null;
}

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
/** A proposal as proposals() / pendingFor() list it (lib/room/consent.ts fold's latest entry per hash). */
export interface Proposal {
  id: number;
  hash: string;
  approvers: string[];
  path?: string;
  from?: string;
  entry?: LogEntry;
}
/** An AskUserQuestion input (the card the hooks show). */
export interface Card {
  questions: {
    question: string;
    header: string;
    multiSelect: boolean;
    options: { label: string, description: string, preview?: string }[];
  }[];
}
/** members/NAME/review: the plan-view review state (hooks/consent.ts). */
export interface Review {
  phase?: string;
  mode?: string;
  at?: number;
  hash?: string;
  from?: string;
  file?: string;
  backup?: string | null;
  restored?: boolean;
  tool_use_id?: string;
  [k: string]: unknown;
}
/** members/NAME/confirm: a review's note waiting for the person's Send. */
export interface Confirm {
  hash: string;
  note: string;
  from?: string;
  title?: string;
  at?: number;
  asked?: unknown;
}

// ---------- lib/handoff.ts ----------
/** Who holds the room by its log (lib/room/store.ts hostState): the last host_changed (epoch 0 before any). */
export interface HostState {
  epoch: number;
  host?: string;
  machine?: string;
  locator?: string;
  id?: number;
}
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
  ask?: unknown;
  machine?: string;
  host_id?: number;
  moved_at?: string;
  refused_at?: string;
  invites?: Record<string, string>;
  invites_expire_at?: string;
}
/** The ask as the target's machine keeps it (the session-local document `handoff`). */
export interface HandoffAsk {
  id: string;
  from: string;
  to: string;
  epoch: number;
  expires_at: string;
  locator?: string;
  at?: string;
  told_at?: string;
}

// ---------- lib/tail.ts ----------
/** The injected clock (lib/clock.ts): the real one or clock.createFake(). Methods, so either fits. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

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

/** The link document of a room hosted elsewhere (lib/remote/link.ts status). */
export interface LinkStatus {
  state?: string;
  running?: boolean;
  reason?: string;
  queued?: number;
  pid?: number;
  since?: string;
  flush?: LinkFlush | null;
}
/** What became of the @room posts queued while the link was down. */
export interface LinkFlush {
  at?: string;
  sent?: number;
  unsent?: { text: string, why: string }[];
}
