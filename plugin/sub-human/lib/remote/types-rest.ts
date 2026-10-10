/**
 * plugin/sub-human/lib/remote/types-rest.ts: the shared types of the transports, the invites (enroll, admission,
 * hosting, webhost), the listener and the bridge. Types only: nothing here exists at run time. The protocol frames
 * proper are lib/remote/types-core.ts's; the few fields these files read are declared here as WireFrame.
 */

import type { MessagePort } from 'node:worker_threads';

// ---------- frames and transports ----------
/** A protocol frame as these files read it (lib/remote/protocol.ts builds and decodes them). */
export interface WireFrame {
  id?: number | string | null;
  op?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: string; message: string };
  ev?: string;
  data?: unknown;
}

/** One connection's frames (./transports/index.ts documents it). */
export interface Transport {
  send(frame: object): void;
  onFrame(fn: (frame: WireFrame) => void): void;
  onClose(fn: () => void): void;
  close(): void;
  /** the pipe kind: the child's last 2 KiB of stderr */
  stderr?: () => string;
}

/** lineTransport's parts: the transport, and what its kind feeds it. */
export interface LineTransport {
  transport: Transport;
  receive(chunk: string | Buffer): void;
  end(): void;
}

/** What a kind is opened with: the room the link daemon connects to, if any. */
export interface OpenCtx {
  code?: string;
}

/** A transport spec: its kind, and what that kind needs. */
export interface SpecBase {
  kind: string;
}

export interface MemorySpec extends SpecBase {
  kind: 'memory';
  port: MessagePort;
}

export interface PipeSpec extends SpecBase {
  kind: 'pipe';
  home?: string;
  cmd?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/** user@host[:port] */
export interface SshDest {
  user: string;
  host: string;
  port?: number;
}

export interface SshSpec extends SpecBase, SshDest {
  kind: 'ssh';
  via?: string;
  /** link options this machine wrote into its own link file */
  key?: string;
  knownHosts?: string;
  alias?: string;
  mux?: boolean;
  /** a login link */
  login?: boolean;
  link?: string;
  remoteHome?: string;
}

/** The locator's parts of a ws/wss spec. */
export interface WsAddr {
  host: string;
  port?: number;
  path: string;
}

export interface WsSpec extends SpecBase, WsAddr {
  kind: 'ws' | 'wss';
  /** the pinned X25519 public key, base64url */
  hostKey?: string;
}

/** The built-in kinds' specs. */
export type LinkSpec = MemorySpec | PipeSpec | SshSpec | WsSpec;

/** A registered kind (./transports/index.ts register). Methods, so a kind may take its own spec type. */
export interface KindEntry<S extends SpecBase = SpecBase> {
  open(spec: S, ctx: OpenCtx): Transport | Promise<Transport>;
  parse?(rest: string): object | null;
  describe?(spec: S): string;
}

// ---------- lib/remote/ws.ts (another slice's file: the shape these files use) ----------
/** One open WebSocket. */
export interface WsConn {
  readonly state: 'open' | 'closing' | 'closed';
  send(data: Buffer | string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(ev: 'message', fn: (data: Buffer, binary: boolean) => void): unknown;
  on(ev: 'close', fn: (code: number, reason: string) => void): unknown;
  on(ev: 'error', fn: (err: Error) => void): unknown;
  off(ev: 'message', fn: (data: Buffer, binary: boolean) => void): unknown;
  off(ev: 'close', fn: (code: number, reason: string) => void): unknown;
}

// ---------- lib/remote/noise.ts (another slice's file) ----------
export interface CipherState {
  encrypt(plaintext: Buffer): Buffer;
  decrypt(ciphertext: Buffer): Buffer;
}

export interface NoiseHandshake {
  writeMessage(payload: Buffer): Buffer;
  readMessage(message: Buffer): Buffer;
  split(): { send: CipherState; recv: CipherState };
}

export interface NoiseStatic {
  pub: Buffer;
  priv: Buffer;
}

/** A refusal in the Noise handshake's message 2. */
export interface Refusal {
  code: string;
  message: string;
}

/** Message 1's payload. */
export interface WsHello {
  v: number;
  room: string;
}

// ---------- errors ----------
/** A thrown RoomError (or any error), as the catch sites read it. */
export interface CodedError extends Error {
  code?: string;
  /** enroll.ts joinEnroll: the host charged a try for the attempt */
  spent?: boolean;
  /** bridge.ts: the call went out and its outcome is unknown */
  unknown?: boolean;
}

// ---------- the room's store (another slice's: what these files use) ----------
export interface KvLike {
  get(key: string, fallback?: unknown): unknown;
  update(key: string, fn: (cur: any) => unknown): unknown; // any: the document's shape is the caller's
}

export interface StoreLike {
  code: string;
  isHost: boolean;
  kv: KvLike;
  append(payload: object, opts: object): unknown;
}

// ---------- invites (lib/remote/auth.ts records, as these files read them) ----------
/** A short invite's record in the room's remote/invites document. */
export interface ShortInvite {
  short?: boolean;
  kind?: string;
  created_at: string;
  expires_at: string;
  door_file?: string | null;
  link?: string;
  used_at?: string;
  admission?: boolean;
  told?: string[];
}

/** mintShort's result. */
export interface MintedShort {
  pin: string;
  ref: string;
  expires_at: string;
}

/** An open invite an enrollment attempt may try (auth.startShort). */
export interface ShortOffer {
  key: string;
  ref: string;
  prs: string;
  hostKey: string | null;
  kind: string;
  by: string | null;
}

/** A join request waiting for the host person (auth.admissions). */
export interface AdmissionRequest {
  ref: string;
  name: string;
  label?: string;
  machine: string;
  key?: string | null;
  kind?: string;
  by?: string | null;
  link: string;
  admit?: string;
  door_file?: string;
  expires_at?: string;
  used_at?: string;
  burnt_at?: string;
  told?: string[];
}

/** A link record of the room (auth.links). */
export interface LinkRecord {
  id: string;
  seats?: string[];
  login?: boolean;
}

/** A parsed sh1/sh2 invite (auth.parseInvite). */
export interface ParsedInvite {
  v: number;
  code: string;
  locator: string;
  secret: string;
  hostKey: string | null;
}

/** The joiner's details, authenticated by the PAKE. */
export interface Joiner {
  name: string;
  machine: string;
  label: string;
  key: string | null;
}

// ---------- the link file (lib/room/links.ts, another slice's) ----------
export interface LinkFile {
  code: string;
  transport: LinkSpec;
  token?: string;
  invite?: string;
  pin?: string;
  request?: string;
  join_as?: string;
  enroll?: { pin: string; name: string; kind?: string; attempts?: number };
  awaiting?: { at: string; ref: string; check: string; expires_at: string };
  refused?: { at: string; reason: string };
  created_at?: string;
}

// ---------- the listener ----------
/** A served room's Tailscale path (tailscale.on). */
export interface TailscaleRec {
  bin: string;
  path: string;
  port: number;
  https: number;
  funnel: boolean;
}

/** A room this home serves over the web. */
export interface ServedRoom {
  path: string;
  url: string;
  mode: string;
  port?: number;
  tailscale?: TailscaleRec;
  at?: string;
}

/** <home>/listen/state.json */
export interface ListenState {
  pid?: number | null;
  port?: number;
  started_at?: string;
  rooms?: Record<string, ServedRoom>;
  conns?: number;
}

// ---------- lib/io.ts (another slice's file) ----------
export type WriteFileAtomic = (file: string, data: string, opts?: { fsync?: boolean; mode?: number }) => void;

// ---------- lib/remote/auth.ts (another slice's file: the steps these files call, as they read them) ----------
/** auth.ts as enroll, admission, hosting and webhost use it. Its own types land with its slice; until then these
 * files view it through this interface (`auth as unknown as AuthApi`), and after that the view can go. */
export interface AuthApi {
  INVITES_KEY: string;
  LINK_ID_RE: RegExp;
  SHORT_PIN_RE: RegExp;
  mintShort(store: StoreLike, o: {
    kind: string; locator: string; hostKey?: string | null; by?: string | null; doorFile?: string | null; now?: number;
  }): MintedShort;
  startShort(store: StoreLike, o: { kind: string; now?: number }): ShortOffer[];
  failShort(store: StoreLike, keys: string[], o?: { now?: number }): { left: number; burnt: number };
  enrollShort(store: StoreLike, key: string, o: { tried?: string[]; joiner: Joiner; now?: number; admitMs?: number }):
    { secret: string; id: string; ref: string; expires_at: string };
  shortLive(invite: unknown, now?: number): boolean;
  admissions(store: StoreLike, o?: { now?: number; all?: boolean }): AdmissionRequest[];
  decideAdmission(store: StoreLike, ref: string, o: {
    decision: 'let-in' | 'refused'; by?: string | null; sig?: unknown; now?: number;
  }): AdmissionRequest;
  lapseAdmissions(store: StoreLike, o?: { now?: number }): AdmissionRequest[];
  findInvite(store: StoreLike, ref: string): { key: string; invite: ShortInvite } | null;
  burnInvite(store: StoreLike, ref: string, o?: { now?: number }): { state: string; invite: ShortInvite };
  revokeLink(store: StoreLike, id: string, o?: { now?: number }): { link: LinkRecord | null; invites: number } | null;
  links(store: StoreLike): Record<string, LinkRecord>;
  linkKnown(store: StoreLike, id: string): boolean;
  inviteRef(secret: string): string;
  formatInvite(o: { v?: number; code: string; locator: string; secret: string; hostKey?: string | null }): string;
}
