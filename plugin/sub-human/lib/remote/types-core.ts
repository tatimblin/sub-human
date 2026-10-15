/**
 * plugin/sub-human/lib/remote/types-core.ts: types only (erased at run time) for the remote core: the wire protocol,
 * the host's invite and link records, and the link daemon's records.
 *
 *   wire protocol (lib/remote/protocol.ts)   frames (RequestFrame, ReplyFrame, EventFrame: discriminated on op / ev),
 *                                            each op's params (OpParams) and result (OpResults), each event's data
 *   host records (lib/remote/invites.ts, host-links.ts, admission.ts)   InviteRecord (bound, short, admission), LinkRecord
 *   the link daemon (lib/remote/link.ts)     its document `link`, its timings, a running link
 *
 * Request params are what a conforming peer sends. They arrive as parsed JSON, so the server still checks each
 * field it relies on (lib/remote/server.ts); the types document the protocol, not a validation.
 */

import type { Reason } from '../reasons.ts';
import type { Entry, LinkStateWord, Payload, PresenceInput, RoomStore, SnapshotWire } from '../room/types.ts';

// ---------- the wire protocol ----------

/** A frame's id: a request's own, echoed by its reply and by a subscribe stream's events; null on a frame-level error. */
export type FrameId = number | string | null;

/** The versions one end speaks (protocol.PROTO). */
export interface ProtoRange { min: number; max: number }

/** The ops a room's server serves (protocol.OPS). */
export type Op =
  | 'hello' | 'join' | 'leave' | 'beat' | 'append' | 'subscribe' | 'blob.get' | 'blob.put' | 'ping'
  | 'handoff.accept' | 'handoff.refuse';

/** The ops the link daemon relays for its hooks (lib/remote/link.ts RELAY). */
export type RelayOp = 'join' | 'leave' | 'beat' | 'append' | 'blob.get' | 'blob.put' | 'handoff.accept' | 'handoff.refuse';

/** The RoomError codes on both ends and on the wire (protocol.CODES). */
export type WireCode =
  | 'INVALID' | 'RATE' | 'LOCK' | 'NO_ROOM' | 'OFFLINE' | 'HOST_ONLY' | 'AUTH' | 'FORK' | 'PROTOCOL' | 'STALE';

/** What an end serves (protocol.CAPS), in a hello reply. */
export interface Caps {
  ops: readonly string[];
  fields?: readonly string[];
  /** the host sends a new mirror its log's snapshot when asked (subscribe {after: 0, snapshot: true}); additive */
  snapshot?: boolean;
}

/** A signed room payload as lib/room/envelope.ts makes it: kind, from, room and the sig v2 fields, plus the kind's own. */
export interface SignedPayload {
  kind: string;
  from?: string;
  room?: string;
  via?: string;
  to?: string;
  text?: string;
  nonce?: string;
  ts?: number;
  [field: string]: unknown;
}

export interface HelloParams {
  /** The version the client needs at least (a beta's joiner sends it; this one does not). The server honours it. */
  v?: number;
  /** The client's range; a hello without it is refused (PROTOCOL SKEW). */
  proto?: ProtoRange;
  /** The client's plugin version. */
  client?: string;
  caps?: { ping?: boolean };
  /** This machine's id in the room as it knows it (home.machineIn): what an invite's binding is checked against. */
  machine: string;
  /** Its machine key's proof (lib/remote/machine-key.ts): the host records the id the key gives, not the reported one. */
  machine_key?: { key: string; ts: number; sig: string };
  token?: string;
  invite?: string;
  pin?: string;
  login?: boolean;
  /** The mirror's host epoch (lib/handoff.ts). */
  epoch?: number;
}
export interface JoinParams { name: string; role?: string; pubkey: string; proof: SignedPayload }
export interface LeaveParams { name: string; reason?: string }
export interface BeatParams { name: string; presence?: PresenceInput }
export interface AppendParams { payload: Payload; epoch?: number }
/** What a hook hands the link daemon for an append: {queue: true} marks an @room post the outbox may keep. */
export interface RelayAppendParams extends AppendParams { queue?: boolean }
/** snapshot: an empty mirror asks for the host's snapshot first (only of a host whose caps say snapshot: true). */
export interface SubscribeParams { after: number; hash: string | null; snapshot?: boolean }
export interface BlobGetParams { ref: string }
export interface BlobPutParams { name: string; bytes: string }
export type PingParams = Record<string, never>;
/** lib/handoff.ts serverAccept's: the ask's id, the target's signed acceptance, its locator and invites. */
export interface HandoffAcceptParams { id: string; [field: string]: unknown }
export interface HandoffRefuseParams { id: string; [field: string]: unknown }

/** Each op's params. */
export interface OpParams {
  hello: HelloParams;
  join: JoinParams;
  leave: LeaveParams;
  beat: BeatParams;
  append: AppendParams;
  subscribe: SubscribeParams;
  'blob.get': BlobGetParams;
  'blob.put': BlobPutParams;
  ping: PingParams;
  'handoff.accept': HandoffAcceptParams;
  'handoff.refuse': HandoffRefuseParams;
}

export interface HelloResult {
  v: number;
  proto: ProtoRange;
  /** The host's plugin version. */
  server: string;
  caps: Caps;
  room: string;
  link: string | null;
  epoch: number;
  /** The host's clock (ms), for the skew sub-human doctor reports. */
  time: number;
  /** Once, for a redeemed invite or a login link. */
  token?: string;
  /** The room was closed (its Claude stopped); absent while it is open, and from an older host. */
  closed?: boolean;
  /** This machine's id in the room as the host records it for the link (lib/remote/host-links.ts); additive. */
  machine?: string;
}
export interface OkResult { ok: boolean }
export interface JoinResult { ok: true; rejoin?: true }
export interface AppendResult { entry: Entry }
export interface BlobGetResult { bytes: string | null }
export interface BlobPutResult { ref: string }
export interface PingResult { pong: number }
export interface HandoffAcceptResult { ok: true; epoch: number; entry: Entry }

/** Each op's result. */
export interface OpResults {
  hello: HelloResult;
  join: JoinResult;
  leave: OkResult;
  beat: OkResult;
  append: AppendResult;
  subscribe: { ok: true };
  'blob.get': BlobGetResult;
  'blob.put': BlobPutResult;
  ping: PingResult;
  'handoff.accept': HandoffAcceptResult;
  'handoff.refuse': unknown;
}

/** A request frame for one op: {id, op, params}, discriminated on op. */
export type RequestFrame<O extends Op = Op> = { [K in O]: { id: FrameId; op: K; params: OpParams[K] } }[O];
/** Any request, by its shape alone (an op this end may not serve, or another protocol's: lib/remote/enroll.ts). */
export interface AnyRequest { id: FrameId; op: string; params: object }
/** A decoded frame shaped as a request (protocol.isRequest): op a string; id and params as the peer sent them. */
export interface IncomingRequest {
  id?: FrameId;
  op: string;
  /** any: unchecked JSON from the peer; each op checks the fields it uses. */
  params?: any;
}

/** A reply: result or error (the other key absent, so `f.error ? … : f.result` reads either). id: the request's,
 * absent when the request had none (JSON drops an undefined id). */
export interface ResultFrame<R = unknown> { id?: FrameId; result: R; error?: undefined }
/** reason: lib/reasons.ts, beside the code (absent from a peer before reasons). */
export interface WireError { code: string; message: string; reason?: string }
export interface ErrorFrame { id?: FrameId; error: WireError; result?: undefined }
export type ReplyFrame<R = unknown> = ResultFrame<R> | ErrorFrame;

/** A line of the host's log: one JSON entry, verbatim. */
export type EntryLine = string;

export interface DocEventData { key: string; value: unknown }
/** OFFLINE: the client's own, when the transport closed under a stream. */
export type EndReason = 'closed' | 'FORK' | 'moved' | 'AUTH' | 'OFFLINE';
export interface EndEventData { reason: EndReason; message?: string }
/** The host's ask that one of this link's seats host the room (private to that link). */
export interface HandoffAsk { id: string; from: string; to: string; epoch: number; locator?: string; expires_at: string }
/** The room moved (after its host_changed line); invite: this link's machine's single-use sh2 invite to the new host. */
export interface MovedEventData { epoch: number; host: string; machine: string; locator: string; invite: string | null }

/** Each event's data. */
export interface EventData {
  entry: EntryLine;
  doc: DocEventData;
  end: EndEventData;
  handoff: HandoffAsk;
  moved: MovedEventData;
  snapshot: SnapshotWire;
}
export type EventName = keyof EventData;
/** A subscribe stream's event: {id, ev, data}, discriminated on ev. */
export type EventFrame<E extends EventName = EventName> = { [K in E]: { id: FrameId; ev: K; data: EventData[K] } }[E];
/** A link's private event on its subscribe stream (lib/handoff.ts streamEvent); end: the stream ends after it. */
export type PrivateEvent =
  | { ev: 'handoff'; data: HandoffAsk; end?: undefined }
  | { ev: 'moved'; data: MovedEventData; end: true };
/** An event as a client hands it on: {ev, data}. */
export type StreamEvent<E extends EventName = EventName> = { [K in E]: { ev: K; data: EventData[K] } }[E];

/** Any frame this protocol defines. */
export type Frame = RequestFrame | ReplyFrame | EventFrame;
/**
 * A frame as the decoder yields it: a parsed JSON object, not yet checked (isRequest, isReply, isEvent narrow it).
 * The fields are the ones a frame of this protocol may carry; a peer's frame may carry others, or the wrong types.
 */
export interface DecodedFrame {
  id?: FrameId;
  op?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: WireError;
  ev?: string;
  data?: unknown;
}

/** One side as skewMessage names it: its plugin version (null or '?' unknown) and range. */
export interface PeerVersion { version?: string | null; proto: ProtoRange }

// ---------- the host's records (lib/remote/invites.ts, host-links.ts, admission.ts) ----------

/** Lifecycle fields any invite record may carry. */
interface InviteLife {
  created_at: string;
  /** The link id it redeemed to (an admission's: the one its enrollment reserved, the door's forced command names). */
  link?: string;
  used_at?: string;
  burnt_at?: string;
}
/**
 * A bound invite (lib/remote/invites.ts mintFor): for one machine, its seats pre-bound, until expires_at. A handoff's
 * (handoff: true) needs no PIN: the room's next host carries it to that machine over its authenticated link. A
 * promote's, handed out by hand, needs its 6-digit PIN (pin_sha256 = sha256(secret:pin), tries left). One shape.
 */
export interface BoundInvite extends InviteLife {
  v: 2; admission?: undefined; short?: undefined; prs?: undefined;
  machine: string; seats: string[]; expires_at: string;
  handoff?: true;
  pin_sha256?: string;
  tries?: number;
}
export type ShortKind = 'ssh' | 'ws' | 'pipe';
/** The joiner a short invite enrolled (lib/remote/enroll.ts). */
export interface Joiner { machine: string; name: string; label: string; key: string | null }
/** A short invite: a 4-digit PIN, the whole secret (prs, in clear until it is used, burnt or revoked). */
export interface ShortInvite extends InviteLife {
  v: 3; short: true; admission?: undefined; handoff?: undefined; machine?: undefined; seats?: undefined;
  kind: ShortKind; locator: string; host_key: string | null; by: string | null; door_file: string | null;
  expires_at: string; tries: number; prs?: string; last_try_at?: string;
  enrolled?: { at: string } & Joiner;
}
export type AdmitState = 'asked' | 'let-in' | 'refused' | 'lapsed';
/** An admission: a short invite's joiner, waiting for the host person's answer. */
export interface AdmissionRecord extends InviteLife {
  v: 2; admission: true; short?: undefined; handoff?: undefined; seats?: undefined; prs?: undefined;
  from: string; kind: ShortKind; by: string | null; door_file: string | null;
  machine: string; name: string; label?: string; key: string | null; link: string; admit: AdmitState;
  expires_at: string;
  admitted_at?: string; admitted_by?: string | null; admit_sig?: unknown; admitted_until?: string;
  refused_at?: string; refused_by?: string | null;
  /** the seats whose card showed it (lib/remote/admission.ts markTold) */
  told?: string[];
}
/** One record of the host document remote/invites, keyed by sha256(secret). */
export type InviteRecord = BoundInvite | ShortInvite | AdmissionRecord;
/** The host document remote/invites. */
export type Invites = Record<string, InviteRecord>;

/** A link the host knows (the host document remote/links, keyed by id). */
export interface LinkRecord {
  id: string;
  token_sha256: string;
  machine: string;
  seats: string[];
  created_at: string;
  login?: true;
  /** the seats are fixed: the one name the host's card let in, or a handoff's pre-bound seats; join refuses another */
  bound?: true;
  /** the machine id the joiner reported, when the host recorded another (lib/remote/host-links.ts machineFor): a label */
  label?: string;
}
/** The host document remote/links. */
export type Links = Record<string, LinkRecord>;

/** A parsed sh2 invite. */
export interface ParsedInvite { v: 2; code: string; locator: string; secret: string; hostKey: string | null }

// ---------- the store, as the remote code uses it ----------

/** The store invites.ts, host-links.ts and admission.ts read and write (lib/room/store.ts FsRoomStore, or a mirror's): its code, role and documents. */
export type AuthStore = Pick<RoomStore, 'code' | 'isHost' | 'kv'>;

/** A RoomError as it is thrown and caught: the code, and what callers attach. */
export interface CodedError extends Error {
  code?: string;
  /** lib/reasons.ts: which failure exactly */
  reason?: Reason;
  note?: string | null;
  /** lib/remote/link.ts: no daemon answers on the socket */
  notListening?: boolean;
  /** lib/remote/bridge.ts: the call went out and its outcome is unknown */
  unknown?: boolean;
  /** lib/remote/enroll.ts joinEnroll: the host charged a try for the attempt */
  spent?: boolean;
}

// ---------- the link daemon (lib/remote/link.ts) ----------

/** The queued posts a flush sent and the ones it dropped, with why. */
export interface Flush { at: string; sent: number; unsent: { text: string; why: string }[] }

/** The mirror's document `link`, the daemon's own record. */
export interface LinkDoc {
  pid?: number;
  state?: LinkStateWord;
  since?: string;
  socket?: string;
  reason?: string;
  code?: string;
  /** the typed reason it stopped or went offline (lib/reasons.ts) */
  why?: string;
  queued?: number;
  flush?: Flush;
  /** online: the entry fields the host's hello listed (protocol.ts FIELDS), which this machine may write */
  fields?: string[];
}

/** Every timing the link daemon uses (linkTimings). */
export interface LinkTimings {
  retryMs: number;
  retryMaxMs: number;
  pingMs: number;
  pongMs: number;
  deadMs: number;
  wakeTickMs: number;
  wakeGapMs: number;
  netPollMs: number;
  relayMs: number;
}

/** A running link daemon (serveMirror). */
export interface RunningLink {
  state(): LinkStateWord;
  /** stop for good with why (people's words) and its typed reason */
  stop(why: string, reason?: Reason): void;
  wake(why?: string): Promise<void>;
  done: Promise<string>;
}

