/**
 * plugin/sub-human/lib/remote/types-core.ts: types only (erased at run time) for the remote core: the wire protocol,
 * the host's invite and link records, and what the server and the link daemon need from modules typed elsewhere.
 *
 *   wire protocol (lib/remote/protocol.ts)   frames (RequestFrame, ReplyFrame, EventFrame: discriminated on op / ev),
 *                                            each op's params (OpParams) and result (OpResults), each event's data
 *   host records (lib/remote/auth.ts)        InviteRecord (sh1, sh2 PIN, handoff, short, admission), LinkRecord
 *   local shapes                             the store (AuthStore, ServedStore), the mirror (MirrorStore), the client
 *                                            (LinkClient), the clock, a transport: only what these files use; the
 *                                            real types may replace them
 *
 * Request params are what a conforming peer sends. They arrive as parsed JSON, so the server still checks each
 * field it relies on (lib/remote/server.ts); the types document the protocol, not a validation.
 */

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
export interface Caps { ops: readonly string[] }

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
  /** The version the client needs at least (1, or 2 for an sh2 invite). */
  v?: number;
  /** The client's range; a hello without it is the range [v, v]. */
  proto?: ProtoRange;
  /** The client's plugin version. */
  client?: string;
  caps?: { ping?: boolean };
  /** This machine's id (home.machineId). */
  machine: string;
  token?: string;
  invite?: string;
  pin?: string;
  login?: boolean;
  /** The mirror's host epoch (lib/handoff.ts). */
  epoch?: number;
}
export interface JoinParams { name: string; role?: string; pubkey: string; proof: SignedPayload }
export interface LeaveParams { name: string; reason?: string }
export interface BeatParams { name: string; presence?: unknown }
export interface AppendParams { payload: SignedPayload; epoch?: number }
/** What a hook hands the link daemon for an append: {queue: true} marks an @room post the outbox may keep. */
export interface RelayAppendParams extends AppendParams { queue?: boolean }
export interface SubscribeParams { after: number; hash: string | null }
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
}
export interface OkResult { ok: boolean }
export interface JoinResult { ok: true; rejoin?: true }
export interface AppendResult { entry: RoomEntry }
export interface BlobGetResult { bytes: string | null }
export interface BlobPutResult { ref: string }
export interface PingResult { pong: number }
export interface HandoffAcceptResult { ok: true; epoch: number; entry: RoomEntry }

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
export interface WireError { code: string; message: string }
export interface ErrorFrame { id?: FrameId; error: WireError; result?: undefined }
export type ReplyFrame<R = unknown> = ResultFrame<R> | ErrorFrame;

/** A line of the host's log: one JSON entry, verbatim. */
export type EntryLine = string;
/** A room entry as the store places it (lib/room/store.ts). */
export interface RoomEntry { id: number; kind: string; [field: string]: unknown }

export interface DocEventData { key: string; value: unknown }
export type EndReason = 'closed' | 'FORK' | 'moved' | 'AUTH';
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
}
export type EventName = keyof EventData;
/** A subscribe stream's event: {id, ev, data}, discriminated on ev. */
export type EventFrame<E extends EventName = EventName> = { [K in E]: { id: FrameId; ev: K; data: EventData[K] } }[E];
/** An event as a client hands it on: {ev, data}. */
export type StreamEvent<E extends EventName = EventName> = { [K in E]: { ev: K; data: EventData[K] } }[E];

/** Any frame this protocol defines. */
export type Frame = RequestFrame | ReplyFrame | EventFrame;
/** A frame as the decoder yields it: a parsed JSON object, not yet checked (isRequest, isReply, isEvent narrow it). */
export type DecodedFrame = { [field: string]: unknown };

/** One side as skewMessage names it: its plugin version (null or '?' unknown) and range. */
export interface PeerVersion { version?: string | null; proto: ProtoRange }

// ---------- the host's records (lib/remote/auth.ts) ----------

/** Lifecycle fields any invite record may carry. */
interface InviteLife {
  created_at: string;
  /** The link id reserved for it (reserveLink) or that it redeemed to. */
  link?: string;
  used_at?: string;
  burnt_at?: string;
}
/** An sh1 invite (internal: a 0.2.0 joiner's way in, and the tests'). */
export interface Sh1Invite extends InviteLife { v?: undefined; prs?: undefined; short?: undefined; admission?: undefined; handoff?: undefined; machine?: undefined; seats?: undefined }
/** An sh2 invite with a PIN (a promote's, handed out by hand). */
export interface PinInvite extends InviteLife {
  v: 2; handoff?: undefined; admission?: undefined; short?: undefined; prs?: undefined;
  machine: string; seats: string[]; expires_at: string; tries: number; pin_sha256: string;
}
/** A handoff's sh2 invite for one machine (lib/handoff.ts): no PIN. */
export interface HandoffInvite extends InviteLife {
  v: 2; handoff: true; admission?: undefined; short?: undefined; prs?: undefined;
  machine: string; seats: string[]; expires_at: string;
}
export type ShortKind = 'ssh' | 'ws' | 'pipe';
/** The joiner a short invite enrolled (lib/remote/enroll.ts). */
export interface Joiner { machine: string; name: string; label?: string; key?: string | null; [field: string]: unknown }
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
}
/** One record of the host document remote/invites, keyed by sha256(secret). */
export type InviteRecord = Sh1Invite | PinInvite | HandoffInvite | ShortInvite | AdmissionRecord;
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
}
/** The host document remote/links. */
export type Links = Record<string, LinkRecord>;

/** A parsed sh1 or sh2 invite. */
export interface ParsedInvite { v: 1 | 2; code: string; locator: string; secret: string; hostKey: string | null }

// ---------- what these files need from modules typed elsewhere ----------

/** A room's kv documents (lib/room/store.ts kv). Values are stored JSON. */
export interface KvLike {
  /** any: a stored JSON document, read back unchecked (the caller narrows it). */
  get(key: string, fallback?: unknown): any;
  set(key: string, value: unknown, opts?: object): unknown;
  /** fn gets the stored document (any: unchecked JSON) and returns the next one, or undefined to keep it. */
  update(key: string, fn: (cur: any) => unknown, opts?: object): any;
  list(prefix: string): string[];
}

/** The store auth.ts uses (lib/room/store.ts FsRoomStore, or a mirror's). */
export interface AuthStore {
  code: string;
  isHost: boolean;
  kv: KvLike;
}

/** The host epoch and where the room is (lib/room/store.ts hostState). */
export interface HostState { epoch: number; host?: string | null; [field: string]: unknown }

/** The host's store as server.ts serves it (lib/room/store.ts FsRoomStore). */
export interface ServedStore extends AuthStore {
  members: {
    read(): Record<string, MemberLike>;
    beat(name: string, opts: { presence?: unknown }): boolean;
  };
  blobs: {
    get(ref: string): Buffer | null;
    has(ref: string): boolean;
    put(name: string, bytes: Buffer): unknown;
  };
  hostState?(): HostState;
  tailer(opts: { after: number }): { poll(): { lines: string[]; entries: RoomEntry[]; reset?: boolean } };
  lineHash(id: number): string | null;
  place(payload: SignedPayload): RoomEntry;
  append(entry: object, opts: object): unknown;
}

/** A member record as the members document holds it (lib/room/members.ts). */
export interface MemberLike { machine?: string; left_at?: string; claude?: { stopped_at?: string | null } | null; [field: string]: unknown }

/** A mirror's store as the link daemon keeps it (lib/room/store-mirror.ts). */
export interface MirrorStore {
  code: string;
  dir: string;
  isHost: boolean;
  kv: KvLike;
  members: { read(): Record<string, MemberLike> };
  blobs: { ref(pathOrRef: unknown): string | null; has(ref: string): boolean };
  hostState?(): HostState;
  lastId(): number;
  lineHash(id: number): string | null;
  applyLine(line: string): RoomEntry;
  applyDoc(key: string, value: unknown): unknown;
  applyBlob(ref: string, bytes: Buffer): unknown;
}

/** A connection to a room's server, hello done (lib/remote/client.ts Client), as the link daemon uses it. */
export interface LinkClient {
  token: string | null;
  closed: boolean;
  request(op: string, params: object, opts?: { ms?: number }): Promise<unknown>;
  subscribe(after: number, hash: string | null, onEvent: (ev: StreamEvent) => void): { ready: Promise<unknown>; stop(): void };
  beat(name: string): Promise<OkResult | null | undefined>;
  append(payload: SignedPayload): Promise<unknown>;
  blobGet(ref: string): Promise<Buffer | null>;
  supports?(op: string): boolean;
  ping(ms?: number): Promise<{ pong: number; rttMs: number }>;
  drain?(ms?: number): Promise<unknown>;
  close(): void;
}

/** A timer handle from a Clock: Node's Timeout, or a fake clock's. */
export type TimerHandle = { unref?(): unknown } | undefined | null;
/** The injectable clock (lib/clock.ts): the methods the link daemon calls. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(h: TimerHandle): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(h: TimerHandle): void;
}

/** One frame transport (lib/remote/transports/*), as server.ts serves over it. */
export interface FrameTransport {
  send(frame: object): void;
  onFrame(fn: (frame: DecodedFrame) => void): void;
  onClose(fn: () => void): void;
  close(): void;
}

/** A RoomError as it is thrown and caught: the code, and what callers attach. */
export interface CodedError extends Error { code?: string; note?: string | null; notListening?: boolean; unknown?: boolean }

// ---------- the link daemon (lib/remote/link.ts) ----------

/** A link's state, in the one vocabulary of its document `link` and links/<code>.state.json. */
export type LinkState = 'connecting' | 'online' | 'offline' | 'fork' | 'stopped';

/** The queued posts a flush sent and the ones it dropped, with why. */
export interface Flush { at: string; sent: number; unsent: { text: string; why: string }[] }

/** The mirror's document `link`, the daemon's own record. */
export interface LinkDoc {
  pid?: number;
  state?: LinkState;
  since?: string;
  socket?: string;
  reason?: string;
  code?: string;
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
export interface Link {
  state(): LinkState;
  stop(reason: string): void;
  wake(why?: string): Promise<void>;
  done: Promise<string>;
}

/** The link file of a room (lib/room/links.ts), as the daemon reads it. */
export interface LinkFileLike {
  token?: string;
  invite?: unknown;
  pin?: unknown;
  enroll?: unknown;
  rebind?: unknown;
  awaiting?: unknown;
  created_at: string;
  refused?: { at?: string; reason?: string };
  moved?: Record<string, unknown>;
  transport?: { kind?: string; login?: boolean; key?: unknown; [field: string]: unknown };
  [field: string]: unknown;
}
