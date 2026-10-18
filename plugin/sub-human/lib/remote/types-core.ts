/**
 * plugin/sub-human/lib/remote/types-core.ts: types only (erased at run time) for the remote core: the wire protocol,
 * the host's invite and link records, and the link daemon's records.
 *
 * Request params are what a conforming peer sends. They arrive as parsed JSON, so the server still checks each
 * field it relies on (lib/remote/server.ts); the types document the protocol, not a validation.
 */

import type { Reason } from '../reasons.ts';
import type { Op, EventName } from './protocol.ts';
import type { Entry, LinkStateWord, Payload, PresenceInput, RoomStore, SnapshotWire } from '../room/types.ts';
import type { MachineId, LinkToken, InviteSecret, Pin } from '../brand.ts';
import type { FoldedTask } from '../types-app.ts';
import type { Put } from '../plans.ts';

// ---------- the wire protocol ----------

/** A frame's id: a request's own, echoed by its reply and by a subscribe stream's events; null on a frame-level error. */
export type FrameId = number | string | null;

/** The versions one end speaks (protocol.PROTO). */
export interface ProtoRange { min: number; max: number }

export type { Op, EventName };

/** The ops the link daemon relays for its hooks (lib/remote/link.ts RELAY). */
export type RelayOp = 'join' | 'leave' | 'beat' | 'append' | 'blob.get' | 'blob.put' | 'task' | 'plan.put';

export type { WireCode } from './protocol.ts';

/** What an end serves (protocol.CAPS), in a hello reply. */
export interface Caps {
  ops: readonly string[];
  /** the host sends a new mirror its log's snapshot when asked (subscribe {after: 0, snapshot: true}) */
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
  /** The version the client needs at least; the server honours it. */
  v?: number;
  /** The client's range; a hello without it is refused (PROTOCOL SKEW). */
  proto?: ProtoRange;
  client?: string;
  caps?: { ping?: boolean };
  /** This machine's id in the room as it knows it (home.machineIn): what an invite's binding is checked against. */
  machine: string;
  /** Its machine key's proof (lib/remote/machine-key.ts): the host records the id the key gives, not the reported one. */
  machine_key?: { key: string; ts: number; sig: string };
  token?: LinkToken;
  /** an invite line's SECRET word */
  invite?: InviteSecret;
  pin?: Pin;
  /** with an invite and no pin: ask the host person's card instead of being asked for the PIN (additive; a host before
   *  it ignores it and answers PIN_NEEDED) */
  knock?: boolean;
  /** the seat an invite line's PIN asks for, and this machine's short name (both as the joiner says) */
  as?: { name: string; label: string };
  /** a fresh random word; the reply's host proves the host home's machine key over it */
  nonce?: string;
  login?: boolean;
}
export interface JoinParams { name: string; role?: string; pubkey: string; proof: SignedPayload }
export interface LeaveParams { name: string; reason?: string }
export interface BeatParams { name: string; presence?: PresenceInput | undefined }
export interface AppendParams { payload: Payload }
/** What a hook hands the link daemon for an append: {queue: true} marks an @room post the outbox may keep. */
export interface RelayAppendParams extends AppendParams { queue?: boolean }
/** snapshot: an empty mirror asks for the host's snapshot first (only of a host whose caps say snapshot: true). */
export interface SubscribeParams { after: number; hash: string | null; snapshot?: boolean }
export interface BlobGetParams { ref: string }
export interface BlobPutParams { name: string; bytes: string }
export type PingParams = Record<string, never>;
/** A seat's `task` tool request, for the host to apply (lib/tasks.ts apply): name, the link's own seat. */
export interface TaskParams { name: string; req: unknown }
/** A seat's plan edit, for the host to store (lib/plans.ts put): name, the link's own seat; req {plan, base, text, summary}. */
export interface PlanPutParams { name: string; req: unknown }

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
  task: TaskParams;
  'plan.put': PlanPutParams;
}

export interface HelloResult {
  v: number;
  proto: ProtoRange;
  server: string;
  caps: Caps;
  room: string;
  link: string | null;
  /** The host's clock (ms), for the skew sub-human doctor reports. */
  time: number;
  /** Once, for a redeemed invite or a login link. */
  token?: LinkToken;
  /** The room was closed (its Claude stopped). */
  closed?: boolean;
  /** This machine's id in the room as the host records it for the link (lib/remote/host-links.ts). */
  machine?: string;
  /** With the token of an invite line's link: the one name the host's card let in (another than the one asked for
   * when that name sits in the room from another machine: lib/remote/admission.ts taken). */
  as?: string;
  /** for a hello with a nonce: the host home's machine key and its signature over the nonce (machine-key.ts
   * hostProof), which an invite line's tag names over ssh and a pipe */
  host?: { key: string; sig: string };
  /** a fresh word this session's next hello signs its machine key over (machine-key.ts proofFor), so a proof is good
   * for one hello of one session, not for any hello within the clock skew */
  challenge?: string;
}
export interface OkResult { ok: boolean }
export interface JoinResult { ok: true; rejoin?: true }
export interface AppendResult { entry: Entry }
export interface BlobGetResult { bytes: string | null }
export interface BlobPutResult { ref: string }
export interface PingResult { pong: number }
/** lib/tasks.ts apply's answer: the task after the request and a line for the requester's Claude, or why not. */
export type TaskResult = { ok: true; task: FoldedTask; text: string } | { ok: false; error: string };

/** What a hook hands the link daemon for each op it relays (lib/remote/link-socket.ts handle). */
export type RelayParams = { [M in RelayOp]: M extends 'append' ? RelayAppendParams : OpParams[M] };
/** An @room post the daemon's outbox holds instead of an answer: the link is down, or the host slow (lib/remote/link.ts). */
export interface QueuedReply { queued: number; slow?: true }
/** The daemon's answer to each relayed op: the host's result, or, for a queueable append, QueuedReply. */
export type RelayResults = { [M in RelayOp]: M extends 'append' ? AppendResult | QueuedReply : OpResults[M] };

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
  task: TaskResult;
  /** lib/plans.ts put's answer: stored, a conflict with the current version, or why not */
  'plan.put': Put;
}

/** A request frame for one op: {id, op, params}, discriminated on op. */
export type RequestFrame<O extends Op = Op> = { [K in O]: { id: FrameId; op: K; params: OpParams[K] } }[O];
/** Any request, by its shape alone (an op this end may not serve, or another protocol's, which lib/remote/listener.ts
 * and `serve --enroll` answer with the skew message). */
export interface AnyRequest { id: FrameId; op: string; params: object }
/** A decoded frame shaped as a request (protocol.isRequest): op a string; id and params as the peer sent them. */
export interface IncomingRequest {
  id?: FrameId;
  op: string;
  /** unchecked JSON from the peer: the server reads it as WireParams of the op (lib/remote/server.ts run). */
  params?: unknown;
}
/** An op's params as they arrive: an object whose fields are the op's (OpParams), each unknown until the op checks
 * it (lib/remote/server.ts OPS). A peer may send other fields, or the wrong types. */
export type WireParams<O extends Op> = { [K in keyof OpParams[O]]?: unknown };
/** A decoded frame shaped as an event this end knows (protocol.isEvent): data as the peer sent it. */
export interface IncomingEvent { id?: FrameId; ev: EventName; data?: unknown }

/** A reply: result or error (the other key absent, so `f.error ? … : f.result` reads either). id: the request's,
 * absent when the request had none (JSON drops an undefined id). */
export interface ResultFrame<R = unknown> { id?: FrameId | undefined; result: R; error?: undefined }
/** reason: lib/reasons.ts, beside the code. */
export interface WireError { code: string; message: string; reason?: string }
export interface ErrorFrame { id?: FrameId | undefined; error: WireError; result?: undefined }
export type ReplyFrame<R = unknown> = ResultFrame<R> | ErrorFrame;

/** A line of the host's log: one JSON entry, verbatim. */
export type EntryLine = string;

export interface DocEventData { key: string; value: unknown }
/** OFFLINE: the client's own, when the transport closed under a stream. */
export type EndReason = 'closed' | 'FORK' | 'AUTH' | 'OFFLINE';
export interface EndEventData { reason: EndReason; message?: string }

/** Each event's data, keyed by EventName (protocol.EVENTS): a name with no data here does not compile. */
export interface EventData {
  entry: EntryLine;
  doc: DocEventData;
  end: EndEventData;
  snapshot: SnapshotWire;
}
/** A subscribe stream's event: {id, ev, data}, discriminated on ev. */
export type EventFrame<E extends EventName = EventName> = { [K in E]: { id: FrameId; ev: K; data: EventData[K] } }[E];
/** An event as a client hands it on: {ev, data}. */
export type StreamEvent<E extends EventName = EventName> = { [K in E]: { ev: K; data: EventData[K] } }[E];

export type Frame = RequestFrame | ReplyFrame | EventFrame;
/**
 * A frame as the decoder yields it: a parsed JSON object, not yet checked (isRequest, isReply, isEvent narrow it).
 * The fields are the ones a frame of this protocol may carry; a peer's frame may carry others, or the wrong types.
 */
export interface DecodedFrame {
  id?: FrameId | undefined;
  op?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: WireError;
  ev?: string;
  data?: unknown;
}

/** One side as skewMessage names it: its plugin version (null or '?' unknown) and range. */
export interface PeerVersion { version?: string | null | undefined; proto: ProtoRange }

// ---------- the host's records (lib/remote/invites.ts, host-links.ts, admission.ts) ----------

/** Lifecycle fields any invite record may carry. */
interface InviteLife {
  created_at: string;
  /** The link id it redeemed to (an admission's: the one its PIN reserved; over ssh, the login's --link). */
  link?: string;
  used_at?: string;
  burnt_at?: string;
}
export type ShortKind = 'ssh' | 'ws' | 'pipe';
/** The joiner an invite line's PIN let through to the card (lib/remote/invites.ts): key, a web link's Noise key. */
export interface Joiner { machine: MachineId; name: string; label: string; key: string | null }
/**
 * An invite line's record: the line carries its 128-bit secret (the record's key is that secret's
 * sha256), and the PIN is checked here online (pin_sha256 = sha256(secret:PIN)), INVITE_PIN_TRIES tries, throttled
 * after each wrong one per invite (wrong, next_at) and per source machine (sources: the id its machine key proves).
 */
export interface ShortInvite extends InviteLife {
  v: 4; short: true; admission?: undefined; machine?: undefined; seats?: undefined;
  kind: ShortKind; locator: string; by: string | null; expires_at: string; tries: number;
  pin_sha256?: string;
  wrong?: number; next_at?: string;
  sources?: Record<string, { wrong: number; next_at: string }>;
}
export type AdmitState = 'asked' | 'let-in' | 'refused' | 'lapsed';
/**
 * An admission: an invite line's joiner whose PIN held, waiting for the host person's answer. key: the Noise key its
 * web connection proved (the link made from it is bound to that key), null over ssh or a pipe.
 */
export interface AdmissionRecord extends InviteLife {
  v: 2; admission: true; short?: undefined; seats?: undefined;
  from: string; kind: ShortKind; by: string | null;
  machine: MachineId; name: string; label?: string; key: string | null; link: string; admit: AdmitState;
  expires_at: string;
  admitted_at?: string; admitted_by?: string | null; admit_sig?: unknown; admitted_until?: string;
  refused_at?: string; refused_by?: string | null;
  /** the name the joiner asked for when the card let it in under another (its own sat here from another machine) */
  asked_as?: string;
  /** the seats whose card showed it (lib/remote/admission.ts markTold) */
  told?: string[];
  /** the other machines (proven ids) that presented this used invite: the room heard of each once (invites.ts) */
  others?: string[];
  /** the knock this machine's right PIN replaced (invites.ts): that machine's link is refused from then on */
  replaced?: { machine: MachineId; key: string | null; name: string };
}
/** One record of the host document remote/invites, keyed by sha256(secret). */
export type InviteRecord = ShortInvite | AdmissionRecord;
/** The host document remote/invites. */
export type Invites = Record<string, InviteRecord>;

/** A link the host knows (the host document remote/links, keyed by id). */
export interface LinkRecord {
  id: string;
  token_sha256: string;
  machine: MachineId;
  seats: string[];
  created_at: string;
  login?: true;
  /** the seats are fixed: the one name the host's card let in; join refuses another */
  bound?: true;
  /** the machine id the joiner reported, when the host recorded another (lib/remote/host-links.ts machineFor): a label */
  label?: string;
  /** the Noise key (X25519, base64url) a web link proves on every connection (XK); a link without one (ssh, a pipe) has
   * its token alone */
  key?: string;
}
/** The host document remote/links. */
export type Links = Record<string, LinkRecord>;


// ---------- the store, as the remote code uses it ----------

/** The store invites.ts, host-links.ts and admission.ts read and write. */
export type AuthStore = Pick<RoomStore, 'code' | 'isHost' | 'kv'>;

/** An error thrown with a code of ours: RoomError | NoiseError (lib/errors.ts isCoded). */
export type { CodedError } from '../errors.ts';

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

