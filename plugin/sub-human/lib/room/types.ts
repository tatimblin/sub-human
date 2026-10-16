/**
 * plugin/sub-human/lib/room/types.ts: the room's shared shapes, types only (import type). The log entry at each stage
 * (what a caller asks append() for, what validate() makes of it, the signed payload, the placed line), the members
 * document, the RoomStore seam and its parts, the consent fold, and the link records. The rules live in the modules
 * named beside each type; this file only names their shapes.
 *
 *   EntryInput -> validate() -> Validated -> fieldsOf -> Payload (+ Envelope for via=human) -> place -> Entry
 */

import type { KeyObject } from 'node:crypto';
import type nodeFs from 'node:fs';
import type { LockOpts } from '../lock.ts';
import type { LinkSpec } from '../remote/types-rest.ts';

// ---------- the log entry ----------

/** Who wrote an entry (validate.ts VIAS). A line from a newer host may carry another (render.ts shows it as such). */
export type Via = 'human' | 'agent' | 'system';
/** Kinds a model's Claude writes (via agent). */
export type AgentKind = 'say' | 'question' | 'status' | 'proposal' | 'task_req';
/** Kinds a person writes (via human, signed). */
export type HumanKind = 'say' | 'signoff' | 'objection' | 'proposal';
/** Kinds only the plugin's hooks write (via system). */
export type SystemKind = 'decision' | 'member_joined' | 'member_left' | 'task' | 'host_changed' | 'status';
/** Every kind validate() accepts (envelope v3). */
export type Kind = AgentKind | HumanKind | SystemKind;
/** Kinds only logs from before envelope v3 hold; store.ts normalize() maps all but revoke for display. */
export type LegacyKind = 'concern' | 'agree' | 'plan_rev' | 'revoke';
/** A task_req's op (validate.ts TASK_OPS). A `task` entry's op is any short word. */
export type TaskOp = 'add' | 'claim' | 'release' | 'done';
/** A signed acceptance or request carried by host_changed (lib/handoff.ts makes them; validate.ts caps their size). */
export type HostProof = Record<string, unknown>;

/** The task fields of a task_req / task entry, as validate.ts taskFields() stores them (task_id always a string). */
export interface TaskFields {
  op?: string;
  task_id?: string;
  subject?: string;
  detail?: string;
  evidence?: string;
  owner?: string;
  status?: string;
  req?: number;
  blockedBy?: string[];
}

/** host_changed's fields (validate.ts hostFields): the room's authority moves to `host` on `machine`. */
export interface HostFields {
  epoch: number;
  host: string;
  locator: string;
  accept?: HostProof;
  ask?: HostProof;
  promoted?: true;
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
  pubkey?: string;
  machine?: string;
  // host_changed
  epoch?: number;
  host?: string;
  locator?: string;
  accept?: HostProof;
  ask?: HostProof;
  promoted?: true;
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
};

/** validate()'s opts: from is the resolved seat name (never the model's); system: a trusted hook writes via=system. */
export interface ValidateOpts {
  via?: string;
  from: string;
  system?: boolean;
}

/** append()'s opts. queue: an @room post a mirror's daemon may queue while its link is down (store-mirror.ts). */
export interface AppendOpts extends ValidateOpts {
  queue?: boolean;
}

/** place()'s opts (the payload carries from and via). */
export interface PlaceOpts {
  system?: boolean;
  queue?: boolean;
}

/** validate()'s answer: the checked fields, task and host fields gathered (null for other kinds). */
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
  pubkey: string | undefined;
  machine: string | undefined;
  host: HostFields | null;
}

/**
 * The data fields any stored entry may carry. Read from a log (possibly an older or newer version's), so readers
 * check what they use.
 */
export interface EntryFields extends TaskFields {
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
  // host_changed
  epoch?: number;
  host?: string;
  locator?: string;
  accept?: HostProof;
  ask?: HostProof;
  promoted?: true;
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
  id: number;
  at: string;
  prev?: string;
  from: string;
  via?: Via | (string & {});
  kind: Kind | LegacyKind | (string & {});
  /** legacy (before envelope v3): the proposal's hash on plan_rev / agree; normalize() maps it */
  plan_hash?: string;
}

/** A post a mirror's daemon queued while the link was down, or holds while the host is slow (store-mirror.ts place). */
export interface QueuedPost extends Payload {
  queued: number;
  slow?: true;
  id?: undefined;
}

/** What place() / append() return with opts.queue: the placed entry, or the post a mirror queued. */
export type Placed = (Entry & { queued?: undefined; slow?: undefined }) | QueuedPost;

// Per-kind entries: the fields each kind is written with (validate.ts). A reader of the log still checks: these
// describe what this version writes, not what an older or hand-edited log may hold.
export interface ChatEntry extends Entry { kind: 'say' | 'question' | 'status' }
export interface ProposalEntry extends Entry { kind: 'proposal'; hash: string }
export interface SignoffEntry extends Entry { kind: 'signoff'; via: 'human'; proposal_hash: string }
export interface ObjectionEntry extends Entry { kind: 'objection' }
export interface DecisionEntry extends Entry { kind: 'decision'; via: 'system'; proposal_hash: string }
export interface MemberJoinedEntry extends Entry { kind: 'member_joined'; via: 'system' }
export interface MemberLeftEntry extends Entry { kind: 'member_left'; via: 'system' }
export interface TaskReqEntry extends Entry { kind: 'task_req'; op: TaskOp; by: string }
export interface TaskEntry extends Entry { kind: 'task'; via: 'system' }
export interface HostChangedEntry extends Entry {
  kind: 'host_changed'; via: 'system'; epoch: number; host: string; machine: string; locator: string;
}
/** Every entry this version writes, by kind. */
export type KnownEntry =
  | ChatEntry | ProposalEntry | SignoffEntry | ObjectionEntry | DecisionEntry | MemberJoinedEntry | MemberLeftEntry
  | TaskReqEntry | TaskEntry | HostChangedEntry;

/** Who holds the room by its log (store.ts hostState): the last host_changed entry, else epoch 0. */
export interface HostState {
  epoch: number;
  host?: string;
  machine?: string;
  locator?: string;
  id?: number;
}

/** How far a via=human entry is the person's (store.ts humanTrust). */
export type HumanTrust = 'verified' | 'legacy' | 'unverified';

// ---------- members ----------

/** A seat's role: the room's Claude, or a person's session. 0.4.x's "orch" is read as claude (members.ts fromLegacy). */
export type Role = 'member' | 'claude';

/**
 * A seat record in the members document (members.ts). pid, pid_start, session_id and cwd are LOCAL_FIELDS: only the
 * seat's own machine can use them, and publicView() strips them. A record with no machine is this machine's (from
 * before machine ids). The room's Claude's record (name and role "claude") also keeps its bookkeeping
 * (lib/room-claude.ts) across a (re)bind.
 */
export interface Member {
  name: string;
  role: Role;
  /** null: this machine's id could not be read when the seat joined */
  machine?: string | null;
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
  pid?: number | null;
  pid_start?: number;
  session_id?: string | null;
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
}

/** The members document: name -> seat record. */
export type Members = Record<string, Member>;

/** What members.join(rec) takes: a seat of this machine carries its pid, start time, session and cwd too. */
export interface SeatRecord {
  name: string;
  role: Role;
  machine?: string | null;
  account?: string;
  pid?: number;
  pid_start?: number;
  session_id?: string | null;
  cwd?: string | null;
}

/** members.join's answer: joined (rejoin: the seat was in the room before), or refused with why. code: a mirror's
 * RoomError code when the host refused. */
export type JoinResult =
  | { ok: true; rejoin?: boolean; error?: undefined; code?: undefined }
  | { ok: false; error: string; code?: string; rejoin?: undefined };

/** A seat's presence state (members.ts PRESENCE_STATES). */
export type PresenceState = 'working' | 'idle' | 'permission' | 'error';
/** The document presence/<name> (members.beat). */
export interface Presence {
  state: PresenceState;
  at: string;
  detail?: string;
}
/** What beat({presence}) takes; another state is RoomError INVALID. */
export interface PresenceInput {
  state: string;
  detail?: string | null;
}

/** store.members: the document plus the named seat ops (members.ts ops; a mirror's are the host's ops). */
export interface MembersApi {
  read(): Members;
  /** fn returns the next document, or null / undefined to write nothing; may run more than once (keep it idempotent). */
  update(fn: (current: Members) => Members | null | undefined): Members | null;
  join(rec: SeatRecord): JoinResult;
  leave(name: string, opts?: { reason?: string; deadlineMs?: number }): boolean;
  beat(name: string, opts?: { presence?: PresenceInput; now?: number }): boolean;
}

// ---------- the store's other parts ----------

/** store.blobs: plans, by room-relative ref ("plans/<hash>.md"); get/has/ref also take the absolute path older entries stored. */
export interface BlobsApi {
  put(name: string, bytes: string | Uint8Array): string;
  get(ref: string): Buffer | null;
  has(ref: string): boolean;
  ref(pathOrRef: unknown): string | null;
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
  get<T = any>(key: string, fallback?: NoInfer<T> | null): T | null;
  set(key: string, value: unknown, opts?: { compact?: boolean }): void;
  /** fn(current | null) -> next; undefined: no write, null: delete. Atomic, like members.update. */
  update<T = any>(key: string, fn: (current: T | null) => T | null | undefined, opts?: KvUpdateOpts): T | null | undefined;
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

/** The fs calls a tailer reads with (tests inject faults). */
export type TailerFs = Pick<typeof nodeFs, 'statSync' | 'openSync' | 'readSync' | 'closeSync' | 'fstatSync'>;

/** store.tailer(): what was appended since the last poll, parsed and verbatim. */
export interface Tailer {
  readonly offset: number;
  poll(): { entries: Entry[]; lines: string[]; reset: boolean };
}

/** readView's options: after <= 0 is readAll(); Infinity is the non-chat entries only. save: false leaves log.idx. */
export interface ReadViewOpts {
  after?: number;
  save?: boolean;
}

/**
 * One room's store (store.ts documents each call): FsRoomStore over this machine's directory, MirrorRoomStore for a
 * room hosted elsewhere, test/support/memory-store.ts in the tests.
 */
export interface RoomStore {
  readonly code: string;
  /** the room's directory on this machine (FsRoomStore and its mirror; a store kept elsewhere has none) */
  readonly dir?: string;
  isHost: boolean;
  append(entry: EntryInput, opts: AppendOpts & { queue: true }): Placed;
  append(entry: EntryInput, opts?: AppendOpts): Entry;
  place(payload: Payload, opts: PlaceOpts & { queue: true }): Placed;
  place(payload: Payload, opts?: PlaceOpts): Entry;
  pins(): Map<string, KeyObject>;
  hostState(): HostState;
  setAside(): string | null;
  readAll(): Entry[];
  readById(ids: number | string | readonly (number | string)[]): Entry[];
  readAfter(id: number, filter?: (e: Entry) => boolean): Entry[];
  since(id: number): Entry[];
  lastId(): number;
  readView(opts?: ReadViewOpts): Entry[];
  watch(onEntry: (e: Entry) => void, opts?: { after?: number; intervalMs?: number }): () => void;
  tailer(opts?: { fs?: TailerFs; after?: number }): Tailer;
  lineHash(id: number): string | null;
  validateChain(): ChainCheck;
  verifyChain(opts?: { fromOffset?: number; prev?: string; save?: boolean }): ChainVerify;
  getCursor(reader: string): number;
  setCursor(reader: string, id: number): void;
  members: MembersApi;
  blobs: BlobsApi;
  kv: KvApi;
  lock<R>(name: string, fn: () => R, opts?: LockOpts): R;
  exists(): boolean;
}

// ---------- the consent fold (consent.ts) ----------

/** The latest proposal entry per hash. */
export interface ProposalState {
  id: number;
  hash: string;
  from: string;
  approvers: string[];
  /** the approvers that are one person: groups of 2+, disjoint (consent.ts groupsOf) */
  same: string[][];
  path: string | null;
  entry: ProposalEntry;
}

/** A person's current answer on a hash. */
export interface Answer {
  kind: 'signoff' | 'objection';
  id: number;
  entry: Entry;
}

/** The consent matrix of one proposal (fold().matrix). */
export interface Matrix {
  hash: string;
  approvers: string[];
  answers: Record<string, { id: number; kind: Answer['kind'] } | null>;
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

/** consent.ts fold(entries): the one proposal / consent state. */
export interface Fold {
  proposals: Map<string, ProposalState>;
  answers: Map<string, Map<string, Answer>>;
  decisions: Map<string, Entry>;
  /** hash -> the newer hash that retired it (same sender, same title, while undecided) */
  superseded: Map<string, string>;
  /** the answer that counts for name: the latest of its person's seats (a `same` group) */
  answerOf(hash: string, name: string): Answer | null;
  /** name's own latest answer (one per seat: lib/proposal.ts answer) */
  ownAnswer(hash: string, name: string): Answer | null;
  matrix(hash: string, approvers?: string[]): Matrix;
  pending(name: string | null | undefined): ProposalState[];
  /** pending, except that another seat of name's person answering does not take a proposal out */
  answerable(name: string | null | undefined): ProposalState[];
  status(hash: string): ProposalStatus | null;
}

// ---------- lanes and rendering ----------

/** Who reads an entry (lanes.ts lane): the session's seat as far as lanes look. */
export interface LaneViewer {
  name?: string;
  role?: string;
}
export type Lane = 'push' | 'pull' | 'none';

// ---------- links (links.ts, link-state.ts) ----------

/** A link record, <home>/links/<code>.json (links.ts documents each field). */
export interface Link {
  code: string;
  /** how the daemon reaches the host's server (lib/remote/link.ts transportOf); a login link (`/sub-human join
   * USER@HOST ROOM`) is an ssh spec with login: the person's own ssh login admits it */
  transport: LinkSpec;
  token?: string;
  invite?: string;
  pin?: string;
  enroll?: { pin: string; name: string; kind?: string; attempts?: number };
  awaiting?: { at: string; ref: string; check: string; expires_at: string };
  refused?: { at: string; reason: string };
  request?: unknown;
  rebind?: unknown;
  join_as?: string;
  /** the session that typed the PIN join (lib/remote/joining.ts pendingNews: its tail says when the host let it in) */
  join_sid?: string;
  moved?: { epoch?: number; host: string; locator: string; at?: string; reached_at?: string; demoted?: boolean };
  created_at?: string;
}

/** The one link vocabulary (link-state.ts STATES). */
export type LinkStateWord = 'online' | 'connecting' | 'offline' | 'fork' | 'stopped';

/** The link daemon's state record, <home>/links/<code>.state.json (links.ts LinkState); read defensively. */
export interface LinkStateRecord {
  state?: string;
  since?: string;
  attempt?: number;
  lastError?: string | null;
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
  prevError?: string;
  rttMs?: number;
  queued?: number;
  pid?: number;
  detail?: string;
  dead?: boolean;
  source: 'state-file' | 'link-doc';
}
