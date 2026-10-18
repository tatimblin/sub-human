/**
 * plugin/sub-human/lib/room/types.ts: the room's shared shapes, types only (import type). The log entry at each stage
 * (what a caller asks append() for, what validate() makes of it, the signed payload, the placed line), the members
 * document, the RoomStore seam and its parts, the consent fold, and the link records. The rules live in the modules
 * named beside each type; this file only names their shapes.
 *
 *   EntryInput -> validate() -> Validated -> fieldsOf -> Payload (+ Envelope for via=human) -> place -> Entry
 */

import type { KeyObject } from 'node:crypto';
import type { Reason } from '../reasons.ts';
import type nodeFs from 'node:fs';
import type { LockOpts } from '../lock.ts';
import type { LinkSpec } from '../remote/types-rest.ts';
import type { AGENT_KINDS, HUMAN_KINDS, SYSTEM_KINDS, TASK_OPS, VIAS } from './validate.ts';
import type { PRESENCE_STATES } from './members.ts';
import type { STATE_WORDS } from './link-state.ts';
import type { WireCode } from '../remote/types-core.ts';
import type { RoomCode, SeatName, SessionId, MachineId, ProposalHash, EntryId, TaskId, LinkToken, InviteSecret, Pin } from '../brand.ts';

// ---------- the log entry ----------

/** Who wrote an entry (validate.ts VIAS, its source). A line from a newer host may carry another (render.ts shows it as such). */
export type Via = (typeof VIAS)[number];
/** Kinds a model's Claude writes (via agent; validate.ts AGENT_KINDS). */
export type AgentKind = (typeof AGENT_KINDS)[number];
/** Kinds a person writes (via human, signed; validate.ts HUMAN_KINDS). */
export type HumanKind = (typeof HUMAN_KINDS)[number];
/** Kinds only the plugin's hooks write (via system; validate.ts SYSTEM_KINDS). */
export type SystemKind = (typeof SYSTEM_KINDS)[number];
/** Every kind validate() accepts (envelope v3). */
export type Kind = AgentKind | HumanKind | SystemKind;
/** Every kind this version reads: a log line's kind is one of these, or a newer host's (validate.ts parseEntry). */
export type KnownKind = Kind;
/** A task_req's op (validate.ts TASK_OPS). A `task` entry's op is any short word. */
export type TaskOp = (typeof TASK_OPS)[number];

/**
 * A room plan's fields (validate.ts planFields): on a `plan` entry (lib/plans.ts put) plan, version, base, for and
 * summary; on a `proposal` (a sign-off request, lib/proposal.ts ask) plan and version, the version it asks about.
 */
export interface PlanFields {
  plan?: string;
  version?: number;
  /** the version the edit started from (0: the plan's first) */
  base?: number;
  /** the person the editing seat's Claude acted for (always the seat's own person) */
  for?: string;
  summary?: string;
}

/** The task fields of a task_req / task entry, as validate.ts taskFields() stores them (task_id always a string). */
export interface TaskFields {
  op?: string;
  task_id?: TaskId;
  subject?: string;
  detail?: string;
  evidence?: string;
  owner?: string;
  status?: string;
  req?: number;
  blockedBy?: string[];
  /** add: a suggested owner (lib/tasks.ts apply), never the owner */
  suggest?: string;
}

/**
 * What a caller may set (validate.ts ENTRY_FIELDS); everything else is refused. id is a task's id here (task_req /
 * task only; it becomes task_id), by only a task_req's own author. Callers pass what the model sent, so validate()
 * checks every field's type itself.
 */
export type EntryInput = {
  kind: string;
  text?: string;
  to?: string;
  refs?: number[];
  hash?: string;
  approvers?: string[];
  /** a proposal's seats that are one person (lib/proposal.ts create): groups of 2+ approvers */
  same?: string[][];
  path?: string;
  proposal_hash?: string;
  normalized?: boolean;
  edit_path?: string;
  drafted?: 'agent';
  id?: string | number;
  by?: string;
  pubkey?: string | undefined;
  machine?: string | undefined;
  // task_req / task
  op?: string;
  task_id?: string | number;
  subject?: string;
  detail?: string;
  evidence?: string;
  owner?: string | null;
  status?: string;
  req?: number;
  blockedBy?: (string | number)[];
  suggest?: string;
  // plan / proposal (PlanFields)
  plan?: string;
  version?: number;
  base?: number;
  for?: string;
  summary?: string;
};

/** validate()'s opts: from is the resolved seat name (never the model's); system: a trusted hook writes via=system. */
export interface ValidateOpts {
  via?: string;
  from: string;
  system?: boolean | undefined;
}

/** append()'s opts. queue: an @room post a mirror's daemon may queue while its link is down (store-mirror.ts). */
export interface AppendOpts extends ValidateOpts {
  queue?: boolean;
}

/** place()'s opts (the payload carries from and via). */
export interface PlaceOpts {
  system?: boolean | undefined;
  queue?: boolean;
}

/** validate()'s answer: the checked fields, task fields gathered (null for other kinds). */
export interface Validated {
  via: Via;
  kind: Kind;
  text: string | undefined;
  to: string;
  refs: number[] | undefined;
  hash: string | undefined;
  approvers: string[] | undefined;
  same: string[][] | undefined;
  path: string | undefined;
  proposal_hash: string | undefined;
  normalized: boolean | undefined;
  edit_path: string | undefined;
  drafted: 'agent' | undefined;
  task: TaskFields | null;
  plan: PlanFields | null;
  pubkey: string | undefined;
  machine: string | undefined;
}

/**
 * The data fields any stored entry may carry. Read from a log (possibly an older or newer version's), so readers
 * check what they use.
 */
export interface EntryFields extends TaskFields, PlanFields {
  text?: string;
  to?: string;
  refs?: number[];
  hash?: string;
  approvers?: string[];
  same?: string[][];
  path?: string;
  proposal_hash?: string;
  normalized?: boolean;
  edit_path?: string;
  drafted?: string;
  by?: string;
  pubkey?: string;
  machine?: string;
}

/**
 * The signed envelope (sig v2, envelope.ts sign): what a via=human payload carries beside its fields. sig covers the
 * payload without id, at, prev and sig (envelope.ts signable), so it stays valid wherever the line is placed.
 */
export type Envelope = {
  room: string;
  from: string;
  nonce: string;
  ts: number;
  sigv: number;
  sig: string;
};

/**
 * An entry before it is placed (store.ts fieldsOf, toPayload, admit): checked fields plus from and via. A via=human
 * payload also carries the Envelope; any other carries none of it.
 */
export interface Payload extends EntryFields, Partial<Envelope> {
  from: string;
  via: Via;
  kind: Kind;
  to: string;
}

/**
 * A log line as stored and read back (store.ts readAll and friends): placed by the store (id monotonic, at the
 * host's ISO time, prev = hash12 of the line before). Lines from older versions may lack to and via, or carry a
 * legacy kind (LegacyKind) and plan_hash; a newer host's may carry a kind or via this version does not know.
 */
export interface Entry extends EntryFields, Partial<Envelope> {
  id: EntryId;
  at: string;
  prev?: string;
  from: string;
  via?: Via | (string & {});
  kind: Kind | (string & {});
}

/** A post a mirror's daemon queued while the link was down, or holds while the host is slow (store-mirror.ts place). */
export interface QueuedPost extends Payload {
  queued: number;
  slow?: true;
  /** the link daemon was not running: the hook queued the post itself and started the daemon (store-mirror.ts) */
  restarting?: true;
  id?: undefined;
}

/** What place() / append() return with opts.queue: the placed entry, or the post a mirror queued. */
export type Placed = (Entry & { queued?: undefined; slow?: undefined; restarting?: undefined }) | QueuedPost;

// Per-kind entries. Only the kind is known (validate.ts parseEntry and isKindOf check nothing else): the other fields
// are as optional as Entry's, since an older or hand-edited log may lack what this version writes (validate.ts says what).
/** An entry of kind K. */
export type EntryOf<K extends KnownKind> = Entry & { kind: K };
/** An entry of a kind this version knows, by kind: a reader switches on its kind and ends in assertNever. */
export type KnownEntry = { [K in KnownKind]: EntryOf<K> }[KnownKind];
/** A proposal whose hash the fold checked (consent.ts). */
export type ProposalEntry = EntryOf<'proposal'> & { hash: ProposalHash };

/** How far a via=human entry is the person's (trust.ts verdict). */
export type HumanTrust = 'verified' | 'legacy' | 'unverified';

/** A store's judgement of the entries it read (RoomStore.trust; trust.ts trustOver): null when not via=human. */
export type Trust = (e: Entry | null | undefined) => HumanTrust | null;

/** What a trust verdict reads (trust.ts): the room, the keys its log pins, and the seats' local public keys. */
export interface TrustCtx {
  code: RoomCode;
  pins(): ReadonlyMap<string, KeyObject>;
  /** <home>/keys/<code>/<name>.pub: what a legacy room (no key pinned) verifies against */
  localKey(name: string): KeyObject | null;
  /** that file exists, readable or not (a seat with a key: its unsigned words are never legacy) */
  hasLocalKey(name: string): boolean;
}

// ---------- members ----------

/** A seat's role: the room's Claude, or a person's session. */
export type Role = 'member' | 'claude';

/**
 * A seat record in the members document (members.ts). pid, pid_start, session_id and cwd are LOCAL_FIELDS: only the
 * seat's own machine can use them, and publicView() strips them. A record with no machine is this machine's (from
 * before machine ids). The room's Claude's record (name and role "claude") also keeps its bookkeeping
 * (lib/room-claude.ts) across a (re)bind.
 */
export interface Member {
  name: SeatName;
  role: Role;
  /** null: this machine's id could not be read when the seat joined */
  machine?: MachineId | null;
  /**
   * the person behind the seat, as the host knows it: the host's machine id for a seat of the host account (one on
   * the host, or one over a login link, lib/seats.ts enter); none for an invite's seat. Seats with one account are
   * one approver (lib/proposal.ts sameOf: the room owner's seat and the login links' seats; never two seats on the host)
   */
  account?: string;
  /** the seat of the person who opened the room, on the host (lib/room/members.ts join; none in older rooms) */
  owner?: boolean;
  joined_at?: string;
  seen_at?: string;
  left_at?: string;
  /** its lease ran out with no leave (lib/seats.ts sweep): still seated, not present; its next beat brings it back */
  lapsed_at?: string;
  pid?: number | null | undefined;
  pid_start?: number | undefined;
  session_id?: SessionId | null | undefined;
  cwd?: string | null;
  // the room's Claude's bookkeeping (lib/room-claude.ts)
  /** its `claude --bg` job id; "pending" while a spawn is claimed; null after a failed spawn */
  job?: string | null;
  job_session?: string;
  spawned_at?: string;
  claim?: string;
  by?: string;
  closing?: string;
  stopped_at?: string;
  spawn_error?: string;
  orphan_since?: string;
  /** the room session's native task list directory (its config dir's tasks/sh-CODE), where the host projects the
   * room's tasks (lib/room/task-files.ts); host only, never streamed */
  tasks_dir?: string;
  /** why that list is not written now (lib/cc/tasks.ts check said no: the task store changed, the directory is not
   * writable, ...): the tasks stay in the log, nothing is projected; cleared when the check passes again. Host only,
   * never streamed */
  tasks_off?: string;
}

/** The members document: name -> seat record. */
export type Members = Record<string, Member>;

/** What members.join(rec) takes: a seat of this machine carries its pid, start time, session and cwd too. */
export interface SeatRecord {
  name: SeatName;
  role: Role;
  machine?: MachineId | null;
  account?: string;
  pid?: number;
  pid_start?: number;
  session_id?: SessionId | null;
  cwd?: string | null;
}

/** members.join's answer: joined (rejoin: the seat was in the room before), or refused with why. code: a mirror's
 * RoomError code when the host refused. */
export type JoinOutcome =
  | { ok: true; rejoin?: boolean; error?: undefined; code?: undefined }
  | { ok: false; error: string; code?: WireCode; rejoin?: undefined };

/** A seat's presence state (members.ts PRESENCE_STATES, its source). */
export type PresenceState = (typeof PRESENCE_STATES)[number];
/** The document presence/<name> (members.beat). */
export interface Presence {
  state: PresenceState;
  at: string;
  detail?: string;
}
/** What beat({presence}) takes; another state is RoomError INVALID. */
export interface PresenceInput {
  state: string;
  detail?: string | null | undefined;

}

/** store.members: the document plus the named seat ops (members.ts ops; a mirror's are the host's ops). */
export interface MembersApi {
  read(): Members;
  /** fn returns the next document, or null / undefined to write nothing; may run more than once (keep it idempotent). */
  update(fn: (current: Members) => Members | null | undefined): Members | null;
  join(rec: SeatRecord): JoinOutcome;
  leave(name: string, opts?: { reason?: string; deadlineMs?: number | undefined }): boolean;
  beat(name: string, opts?: { presence?: PresenceInput | undefined; now?: number }): boolean;
}

// ---------- the store's other parts ----------

/** store.blobs: plans, by room-relative ref ("plans/<hash>.md"). */
export interface BlobsApi {
  put(name: string, bytes: string | Uint8Array): string;
  get(ref: string): Buffer | null;
  has(ref: string): boolean;
  ref(name: unknown): string | null;
  localPath(ref: string): string | null;
}

/** kv.update's options: compact JSON, and the document lock's timing. */
export interface KvUpdateOpts {
  compact?: boolean;
  timeoutMs?: number;
  staleMs?: number;
}

/**
 * store.kv: small JSON documents (tasks, presence/NAME, rows/*, members/NAME/*, link, remote/*). A document is JSON
 * read from disk or the wire: T defaults to any, an untyped boundary each caller narrows (or names T).
 */
export interface KvApi {
  get<T = unknown>(key: string, fallback?: NoInfer<T> | null): T | null;
  set(key: string, value: unknown, opts?: { compact?: boolean }): void;
  /** fn(current | null) -> next; undefined: no write, null: delete. Atomic, like members.update. */
  update<T = unknown>(key: string, fn: (current: T | null) => T | null | undefined, opts?: KvUpdateOpts): T | null | undefined;
  delete(key: string): void;
  list(prefix: string): string[];
  lock<R>(key: string, fn: () => R, opts?: LockOpts): R;
}

/** validateChain()'s answer: badAt the id whose prev breaks the chain (null with line: a corrupt line, 1-based). */
export interface ChainCheck {
  ok: boolean;
  count: number;
  badAt?: number | null;
  line?: number;
}

/** verifyChain()'s answer: how far the chain checks from the checkpoint (or fromOffset), and where it broke. */
export interface ChainVerify {
  ok: boolean;
  count: number;
  checked: number;
  offset: number;
  id?: number;
  hash?: string;
  from: number;
  badAt?: number | null;
  line?: number;
  error?: string;
}

/**
 * What a placement reads of an entry it did not keep whole (lib/room/snapshot.ts window): enough for rules.ts
 * scanTail's rate buckets and nonce replay check.
 */
export interface WindowItem {
  id: number;
  at: string;
  from: string;
  via?: string;
  to?: string;
  nonce?: string;
}

/**
 * A log's snapshot as the wire carries it (lib/room/snapshot.ts; the subscribe stream's 'snapshot' event): the chain
 * head after the sealed lines and what a reader needs of them. entries: every non-chat entry with id <= id, in order
 * (the fold's input: proposals, answers, decisions, tasks, joins and leaves); window: the entries of the last
 * WINDOW_MS before line (rate buckets and nonces); pins: name -> PEM, the first member_joined key per name. pins are
 * what entries give (a reader checks them, never trusts them).
 */
export interface SnapshotWire {
  id: number;
  hash: string;
  /** the line with id `id`, verbatim (hash12(line) === hash) */
  line: string;
  /** how many lines the snapshot covers */
  count: number;
  entries: Entry[];
  window: WindowItem[];
  pins: Record<string, string>;
}

/** <room>/snapshot.json: the wire form plus where this machine keeps the lines it covers (lib/room/log-io.ts). */
export interface LogSnapshot extends SnapshotWire {
  v: 1;
  /** the sealed segments log-0001.jsonl .. log-<seg>.jsonl on this machine (0: none) */
  seg: number;
  /** [segment number, its first id, its last id] per sealed segment */
  segs: [number, number, number][];
  /** the first id whose line this machine holds (1; a mirror that began from the host's snapshot: that id + 1) */
  held: number;
  /** how many lines came before `held` (0; a mirror that began from the host's snapshot: that snapshot's count) */
  base: number;
  at: string;
}

/** The fs calls a tailer reads with (tests inject faults). */
export type TailerFs = Pick<typeof nodeFs, 'statSync' | 'openSync' | 'readSync' | 'closeSync' | 'fstatSync'>;

/** store.tailer(): what was appended since the last poll, parsed and verbatim. */
export interface Tailer {
  readonly offset: number;
  poll(): { entries: Entry[]; lines: string[]; reset: boolean };
}

/** readView's options: after <= 0 is readAll(); Infinity is the non-chat entries only. */
export interface ReadViewOpts {
  after?: number;
}

/**
 * One room's store (store.ts notes what the shapes do not say): FsRoomStore over this machine's directory,
 * MirrorRoomStore for a room hosted elsewhere, test/support/memory-store.ts in the tests.
 */
export interface RoomStore {
  readonly code: RoomCode;
  /** the room's directory on this machine (FsRoomStore and its mirror; a store kept elsewhere has none) */
  readonly dir?: string;
  readonly isHost: boolean;
  append(entry: EntryInput, opts: AppendOpts & { queue: true }): Placed;
  append(entry: EntryInput, opts?: AppendOpts): Entry;
  place(payload: Payload, opts: PlaceOpts & { queue: true }): Placed;
  place(payload: Payload, opts?: PlaceOpts): Entry;
  /** this store's verdict on a via=human entry it read (trust.ts): a stable function, pass it on */
  readonly trust: Trust;
  pins(): Map<string, KeyObject>;
  setAside(): string | null;
  /** the store's cached array and its entries: read-only all the way out (an entry is flat, one level is enough) */
  readAll(): readonly Readonly<Entry>[];
  readById(ids: EntryId | readonly EntryId[]): readonly Readonly<Entry>[];
  readAfter(id: number, filter?: (e: Readonly<Entry>) => boolean): readonly Readonly<Entry>[];
  lastId(): number;
  readView(opts?: ReadViewOpts): readonly Readonly<Entry>[];
  /** the id after which readView reads only the newest segment (the snapshot's id; 0: no snapshot, the whole log) */
  recentFrom(): number;
  /** the log's snapshot (the subscribe stream's, plus the first id this store holds), null before any rotation */
  snapshot(): (SnapshotWire & { held: number }) | null;
  tailer(opts?: { fs?: TailerFs; after?: number }): Tailer;
  /** FsRoomStore: what changes in the room (lib/room/watch.ts), for the host's streams; a store without it is polled. */
  watch?(onChange: (change: { log: boolean; docs: ReadonlySet<string> } | null) => void): () => void;
  lineHash(id: number): string | null;
  validateChain(): ChainCheck;
  verifyChain(opts?: { fromOffset?: number; prev?: string }): ChainVerify;
  getCursor(reader: string): number;
  setCursor(reader: string, id: number): void;
  readonly members: MembersApi;
  readonly blobs: BlobsApi;
  readonly kv: KvApi;
  lock<R>(name: string, fn: () => R, opts?: LockOpts): R;
  exists(): boolean;
}

// ---------- the consent fold (consent.ts) ----------

/** The latest proposal entry per hash. */
export interface ProposalState {
  id: EntryId;
  hash: ProposalHash;
  from: string;
  approvers: string[];
  /** the approvers that are one person: groups of 2+, disjoint (consent.ts groupsOf) */
  same: string[][];
  path: string | null;
  entry: ProposalEntry;
}

/** A person's current answer on a hash (their stance: a signoff or an objection). */
export interface Stance {
  kind: 'signoff' | 'objection';
  id: EntryId;
  entry: Entry;
}

/** The consent matrix of one proposal (fold().matrix). */
export interface Matrix {
  hash: string;
  approvers: string[];
  answers: Record<string, { id: number; kind: Stance['kind'] } | null>;
  signed: Record<string, number | null>;
  agreed: string[];
  objected: string[];
  missing: string[];
  unsigned: string[];
  complete: boolean;
  /** a name listed in agreed / objected / missing -> the other seats of its person (only for a `same` group) */
  also: Record<string, string[]>;
  /** how many people the approvers are (a `same` group counts once) */
  people: number;
}

/** fold().status(hash). */
export interface ProposalStatus {
  proposal: ProposalState;
  decision: Entry | null;
  matrix: Matrix;
  state: 'open' | 'agreed' | 'blocked' | 'superseded';
}

/** One version of a room plan (a `plan` entry: lib/plans.ts put). */
export interface PlanVersion {
  plan: string;
  version: number;
  base: number;
  hash: ProposalHash;
  /** the editing seat; for: the person its Claude acted for */
  from: string;
  for: string;
  summary: string;
  id: EntryId;
  at: string;
  path: string | null;
}
/** A room plan: its versions in order, the newest last (current). */
export interface PlanState {
  name: string;
  versions: PlanVersion[];
  current: PlanVersion;
}

/** consent.ts fold(entries): the one proposal / consent state. */
export interface Fold {
  proposals: Map<string, ProposalState>;
  answers: Map<string, Map<string, Stance>>;
  decisions: Map<string, Entry>;
  /** hash -> the current version's hash of the plan whose older version it is (a sign-off request a newer version of
   *  the same plan retired, while undecided) */
  superseded: Map<string, string>;
  /** the room's plans by name, in the order each first appeared */
  plans: Map<string, PlanState>;
  /** a version's hash -> that version (the newest version with those bytes) */
  versionOf(hash: string): PlanVersion | null;
  /** the answer that counts for name: the latest of its person's seats (a `same` group) */
  answerOf(hash: string, name: string): Stance | null;
  /** name's own latest answer (one per seat: lib/proposal.ts answer) */
  ownAnswer(hash: string, name: string): Stance | null;
  matrix(hash: string, approvers?: string[]): Matrix;
  pending(name: string | null | undefined): ProposalState[];
  /** pending, except that another seat of name's person answering does not take a proposal out */
  answerable(name: string | null | undefined): ProposalState[];
  status(hash: string): ProposalStatus | null;
}

// ---------- lanes and rendering ----------

/** Who reads an entry (deliver.ts): the session's seat as far as delivery looks. */
export interface LaneViewer {
  name?: string;
  role?: string;
}
export type Lane = 'push' | 'pull' | 'none';
/** What one entry is for one seat (deliver.ts): never shown, context for Claude, a notice for the person, or a wake. */
export type Delivery = 'none' | 'context' | 'notice' | 'wake';

// ---------- links (links.ts, link-state.ts) ----------

/** A link record, <home>/links/<code>.json (links.ts documents each field). */
export interface Link {
  code: RoomCode;
  /** how the daemon reaches the host's server (lib/remote/link.ts transportOf); a login link (`/sub-human join
   * USER@HOST ROOM`) is an ssh spec with login: the person's own ssh login admits it */
  transport: LinkSpec;
  token?: LinkToken;
  /** an invite line's SECRET word (protocol 3), until the token */
  invite?: InviteSecret;
  /** the PIN, from the moment it is typed until the host answered it (held, wrong, or throttled) */
  pin?: Pin | undefined;
  /** an invite line's host asked for its PIN (left: tries; why/message: the last wrong or throttled one) */
  pin_wanted?: { at: string; left?: number; why?: string; message?: string };
  /** the host's card decides (pin: the PIN went with the line and held, and an older host's card still asks) */
  awaiting?: { at: string; ref: string; check: string; expires_at: string; pin?: true };
  refused?: { at: string; reason: string; why?: string };
  rebind?: unknown;
  join_as?: string;
  /** the name this machine asked for, when the host's card let it in as join_as instead (its own sat in the room from another machine) */
  join_renamed?: string;
  /** the session that typed the PIN join (lib/remote/joining.ts pendingNews: its tail says when the host let it in) */
  join_sid?: string;
  /** what the join command last told the person (lib/remote/joining.ts): the tail does not repeat it */
  join_told?: string;
  created_at?: string;
}

/** The one link vocabulary (link-state.ts STATE_WORDS, its source). */
export type LinkStateWord = (typeof STATE_WORDS)[number];

/** The link daemon's state record, <home>/links/<code>.state.json (links.ts LinkState); read defensively. */
export interface LinkStateRecord {
  state?: string;
  since?: string;
  attempt?: number;
  lastError?: string | null;
  /** the typed reason of lastError (lib/reasons.ts) */
  lastReason?: string;
  /** the code it stopped with (AUTH, PROTOCOL, FORK) */
  lastCode?: string;
  prevError?: string;
  rttMs?: number | null;
  queued?: number;
  pid?: number;
  detail?: string;
  at?: string;
}

/** link-state.ts read(): how this machine's link to a room is doing. */
export interface LinkState {
  state: LinkStateWord;
  since?: string;
  attempt?: number;
  lastError?: string;
  /** lastError's typed reason (lib/reasons.ts): what doctor and the CLI key on */
  lastReason?: Reason;
  lastCode?: string;
  prevError?: string;
  rttMs?: number;
  queued?: number;
  pid?: number;
  detail?: string;
  dead?: boolean;
  source: 'state-file' | 'link-doc';
}
