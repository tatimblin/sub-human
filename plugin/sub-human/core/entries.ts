// The room's data model (ARCHITECTURE §4): log entries, the documents beside them, and the snapshot. Types only; the
// schemas that read them from outside are in schema.ts. Ids stay plain strings: names, codes and hashes never mix in
// one call, so a brand would catch nothing.

/** Who wrote an entry: a label (R35), read by the wake rule, not a security boundary. */
export type By = 'person' | 'claude' | 'system';

/** Every entry's envelope. `seq` and `at` are the host's; `prev` is the previous line's hash ('' for the first). */
export interface Envelope {
  readonly seq: number;
  readonly id: string;
  readonly at: number;
  readonly prev: string;
  readonly from: string;
  readonly by: By;
  readonly machine: string;
}

export interface Joined extends Envelope { readonly kind: 'joined'; readonly repo?: string; readonly branch?: string }
export interface Left extends Envelope { readonly kind: 'left' }
/** A discrete event from the work (R12): file edits go in the activity document instead. */
export interface Activity extends Envelope {
  readonly kind: 'activity';
  readonly event: 'commit' | 'push' | 'test' | 'build' | 'task';
  readonly text: string;
  readonly ok?: boolean;
  readonly repo?: string;
  readonly branch?: string;
}
export interface Finding extends Envelope { readonly kind: 'finding'; readonly text: string }
export interface Post extends Envelope { readonly kind: 'post'; readonly text: string; readonly to?: string }

export type PlanScope = 'group' | 'personal';
/** A stored plan version; its text is the blob `plans/<hash>.md`. `base` is the version it edited (0 for the first). */
export interface PlanEntry extends Envelope {
  readonly kind: 'plan';
  readonly name: string;
  readonly version: number;
  readonly hash: string;
  readonly base: number;
  readonly scope: PlanScope;
}
export interface PlanAsk extends Envelope {
  readonly kind: 'plan_ask';
  readonly name: string;
  readonly version: number;
  readonly people: readonly string[];
  /** A tag of the session whose person asked (`askerTag`): that session alone waits on the answer (R21a). */
  readonly asker?: string;
}
export type Answer = 'agree' | 'changes';
export interface PlanAnswer extends Envelope {
  readonly kind: 'plan_answer';
  readonly name: string;
  readonly version: number;
  readonly answer: Answer;
  readonly note?: string;
}
export interface Decision extends Envelope {
  readonly kind: 'decision';
  readonly name: string;
  readonly version: number;
  readonly agreed: readonly string[];
  readonly changes: readonly string[];
}
/** A personal plan version sent to one member (`to`) or, with no `to`, to the room. */
export interface PlanSent extends Envelope {
  readonly kind: 'plan_sent';
  readonly name: string;
  readonly version: number;
  readonly to?: string;
  readonly branch?: string;
  readonly files: readonly string[];
  readonly note?: string;
}
export type Acceptance = 'accept' | 'dismiss' | 'changes';
export interface PlanAccept extends Envelope {
  readonly kind: 'plan_accept';
  readonly name: string;
  readonly version: number;
  readonly answer: Acceptance;
  readonly note?: string;
}

export type TaskStatus = 'open' | 'claimed' | 'done';
/** A room task as it stands; `n` is its number in `[room CODE#n]`. */
export interface Task {
  readonly n: number;
  readonly title: string;
  readonly status: TaskStatus;
  readonly addedBy: string;
  readonly owner?: string;
  readonly blockedBy: readonly number[];
  readonly note?: string;
  readonly plan?: { readonly name: string; readonly version: number };
}
export interface TaskEntry extends Envelope { readonly kind: 'task'; readonly task: Task }

/** Admission records; none ever holds the invite's secret. */
export interface Invite extends Envelope { readonly kind: 'invite'; readonly invite: string; readonly name: string; readonly expires: number }
export interface Admit extends Envelope { readonly kind: 'admit'; readonly invite: string; readonly name: string; readonly link: string }
export interface Kick extends Envelope { readonly kind: 'kick'; readonly name: string }

export type Entry =
  | Joined | Left | Activity | Finding | Post
  | PlanEntry | PlanAsk | PlanAnswer | Decision | PlanSent | PlanAccept
  | TaskEntry | Invite | Admit | Kick;
export type Kind = Entry['kind'];
/**
 * The caps on what the log holds, the one source for schema.ts and the rules: a rule refuses what decodeEntry would
 * reject, so the host never appends a line it can't read. `names` also caps a task's blockers.
 */
export const LIMITS = { name: 64, short: 1024, text: 8000, names: 256, files: 1000 } as const;
/** `T` without fields `K`, member by member of a union. */
export type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
// An entry on its way to the log, one stage each: a rule writes a Draft; its writer gives it an id (AppendDraft, what a
// caller sends); the host stamps `at` and `machine` (StoreDraft); the store assigns `seq` and `prev` under the lock.
export type Draft<E extends Entry = Entry> = Without<E, 'seq' | 'id' | 'at' | 'prev' | 'machine'>;
export type AppendDraft = Without<Entry, 'seq' | 'at' | 'prev' | 'machine'>;
export type StoreDraft = Without<Entry, 'seq' | 'prev'>;

/** An entry with the hash of its own line, which the next entry's `prev` names. The store computes it. */
export interface LogLine { readonly entry: Entry; readonly hash: string }

// Documents: latest-wins, one per member, never in the log.
/**
 * A member's presence on one machine (`presence/NAME@MACHINE`): here (working or idle) or away, a session's end and not
 * a leave. Who is a member is the log's; where they are here is these documents'. The daemon stamps `machine`.
 */
export interface PresenceDoc {
  readonly name: string;
  readonly state: 'working' | 'idle' | 'away';
  readonly waiting?: boolean;
  readonly machine?: string;
  readonly at: number;
}
export interface ActivityDoc { readonly name: string; readonly files: readonly string[]; readonly at: number }
export interface FocusDoc { readonly name: string; readonly text: string; readonly repo?: string; readonly branch?: string; readonly at: number }
/** The host's members document: which link each member's machine came in on. */
export interface DocKinds { presence: PresenceDoc; activity: ActivityDoc; focus: FocusDoc }
/** The documents a member writes about itself. */
export const DOC_KINDS: readonly ['presence', 'activity', 'focus'] = ['presence', 'activity', 'focus'];
export type DocKind = (typeof DOC_KINDS)[number];
export interface Docs {
  readonly presence: readonly PresenceDoc[];
  readonly activity: readonly ActivityDoc[];
  readonly focus: readonly FocusDoc[];
}
export const NO_DOCS: Docs = { presence: [], activity: [], focus: [] };

// What the log folds to (fold.ts). A snapshot holds exactly this; documents are merged on top.
export interface MemberRecord {
  readonly name: string;
  /** The machine the member joined from; none once they have left (the log's membership). */
  readonly machine?: string;
  readonly since: number;
  readonly repo?: string;
  readonly branch?: string;
  readonly kicked: boolean;
}
export interface PlanAnswerRecord { readonly name: string; readonly answer: Answer; readonly note?: string }
export interface PlanVersion {
  readonly version: number;
  readonly hash: string;
  readonly base: number;
  readonly from: string;
  readonly at: number;
  readonly asked: readonly string[];
  readonly answers: readonly PlanAnswerRecord[];
  readonly decision?: { readonly agreed: readonly string[]; readonly changes: readonly string[]; readonly at: number };
}
export interface Plan { readonly name: string; readonly scope: PlanScope; readonly versions: readonly PlanVersion[] }
export interface SentPlan {
  readonly name: string;
  readonly version: number;
  readonly from: string;
  readonly at: number;
  readonly to?: string;
  readonly branch?: string;
  readonly files: readonly string[];
  readonly note?: string;
  readonly answers: readonly { readonly name: string; readonly answer: Acceptance; readonly note?: string }[];
}
/** The entries the catch-up lists as recent updates. */
export type Update = Activity | Finding | Post;
export interface LogState {
  readonly seq: number;
  readonly hash: string;
  readonly members: readonly MemberRecord[];
  readonly plans: readonly Plan[];
  readonly sent: readonly SentPlan[];
  readonly tasks: readonly Task[];
  readonly recent: readonly Update[];
}
export interface Snapshot { readonly v: 1; readonly state: LogState }

export interface Member extends MemberRecord {
  /** Where the member is here: the machines of their presence documents that aren't away. */
  readonly machines: readonly string[];
  /** Their latest presence that isn't away, else their latest. */
  readonly presence?: PresenceDoc;
  readonly activity?: ActivityDoc;
  readonly focus?: FocusDoc;
}
export interface RoomState extends Omit<LogState, 'members'> { readonly members: readonly Member[] }

/** Whether `name` is in the room's membership and was never removed. */
export function isMember(s: { readonly members: readonly MemberRecord[] }, name: string): boolean {
  return s.members.some(m => m.name === name && !m.kicked);
}
/** Whether the member is in the room now, on some machine (a removed member never is: fold gives them none). */
export function isHere(m: Member): boolean { return m.machines.length > 0; }
