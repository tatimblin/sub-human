/**
 * plugin/sub-human/lib/remote/types-rest.ts: the shared types of the transports, the invites (admission, hosting,
 * webhost) and the listener. Types only: nothing here exists at run time. The protocol frames and the host's
 * invite records are lib/remote/types-core.ts's.
 */

import type { MessagePort } from 'node:worker_threads';
import type { DecodedFrame, WireCode } from './types-core.ts';
import type * as BrandMod from '../brand.ts';
import type * as NoiseMod from './noise.ts';

// ---------- frames and transports ----------
/** One connection's frames (./transports/index.ts documents it). */
export interface Transport {
  send(frame: object): void;
  onFrame(fn: (frame: DecodedFrame) => void): void;
  onClose(fn: () => void): void;
  close(): void;
  /** the pipe kind: the child's last 2 KiB of stderr */
  stderr?: () => string;
  /** false while the stream under it has more buffered than it wants (a replay waits: lib/remote/server.ts) */
  writable?: () => boolean;
}

/** lineTransport's parts: the transport, and what its kind feeds it. */
export interface LineTransport {
  transport: Transport;
  receive(chunk: string | Buffer): void;
  end(): void;
}

/** What a kind is opened with: the room the link daemon connects to, if any, and the link's own Noise key (XK proves
 * it). */
export interface OpenCtx {
  code?: BrandMod.RoomCode;
  clientKey?: NoiseMod.KeyPair;
}

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
  /** the link's own X25519 public key, base64url (its pair in the link's folder): XK proves it on every connection */
  clientKey?: string;
}

/** What a locator parses to and a link file keeps (lib/room/types.ts Link.transport): the built-in kinds but memory,
 * whose MessagePort only a test hands to open(). */
export type LinkSpec = PipeSpec | SshSpec | WsSpec;

/** A registered kind (./transports/index.ts register). Methods, so a kind may take its own spec type. */
export interface KindEntry<S extends SpecBase = SpecBase> {
  open(spec: S, ctx: OpenCtx): Transport | Promise<Transport>;
  parse?(rest: string): object | null;
  describe?(spec: S): string;
}

// ---------- the ws transport's handshake ----------
/** A refusal in the Noise handshake's message 2. */
export interface Refusal {
  code: WireCode;
  message: string;
}

/** Message 1's payload (v 3: XK). */
export interface WsHello {
  v: number;
  room: string;
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
