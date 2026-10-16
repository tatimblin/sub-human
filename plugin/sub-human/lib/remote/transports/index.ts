/**
 * plugin/sub-human/lib/remote/transports/index.ts: the transport contract and the table of kinds. A transport
 * carries protocol frames (lib/remote/protocol.ts) between a client and a server and knows nothing about
 * them. Built in: memory (./memory.ts, a pair in one process or across worker threads), pipe (./pipe.ts, a
 * child's stdio or this process's), ssh (./ssh.ts, the pipe kind with an `ssh` command in front), and wss / ws
 * (./ws.ts, a Noise XK channel to the host's listener inside a WebSocket, through a TLS front such as Tailscale Serve).
 *
 *   Transport = {send(frame), onFrame(fn), onClose(fn), close()}
 *       send after close is a no-op; onClose fires once, also when the peer ends
 *   Spec = {kind, ...}   what a kind needs to connect. An invite's locator `KIND:REST` parses to one, and a link
 *       file (lib/room/links.ts `transport`) keeps it: {kind: 'pipe', home} | {kind: 'ssh', user, host, port?, via?}.
 *       memory ({kind: 'memory', port}) and a plain pipe ({kind: 'pipe', cmd: [bin, ...args], env?, cwd?}) are
 *       for tests and have no locator.
 *
 *   A kind is {open, parse?, describe?}:
 *       open(spec, ctx) -> Transport | Promise<Transport>   connect; ctx = {code} when the link daemon connects
 *           to room CODE (lib/remote/link.ts connectLink), else {}. May be async: a transport that connects
 *           (a socket, a WebSocket, a handshake) resolves once it can carry frames; client.connect then says hello
 *       parse(rest) -> Spec | null    the Spec for locator `kind:rest`, null when rest is not acceptable. Without
 *           parse the kind has no locator (an invite cannot name it). Invites are untrusted: accept only plain values
 *       describe(spec) -> string      a short human line ("ssh me@far:2222") for logs and diagnostics
 *   kinds() -> string[]               the kinds, in table order
 *   get(kind) -> entry | null
 *   parse(locator) -> Spec | null     by the kind before the first ":"; null for an unknown kind or a refused rest
 *   open(spec, ctx = {}) -> Promise<Transport>   rejects RoomError INVALID for an unknown kind, else as the kind's open
 *   describe(spec) -> string          the kind's describe, else its kind
 *   lineTransport({write, shut, ready?}) -> {transport, receive(chunk), end()}   the shared half of every kind: write(line)
 *       sends one encoded frame, shut() releases the kind's resources at close(), ready() (transport.writable) says the
 *       stream under it has room (a replay waits for it); the kind feeds what arrives
 *       to receive() (decoded, protocol.decoder) and calls end() when the other side is gone
 *   fromDuplex(stream, {readable?}?) -> Transport   frames over any node stream pair: written to stream, read from
 *       readable (default stream itself: a net.Socket, a tls socket, a stream from a WebSocket). Its end, close or
 *       error closes the transport; close() ends and destroys both
 */

import * as protocol from '../protocol.ts';
import type { Duplex, Readable } from 'node:stream';
import type { KindEntry, LineTransport, LinkSpec, MemorySpec, OpenCtx, SpecBase, Transport } from '../types-rest.ts';
import type { DecodedFrame } from '../types-core.ts';
import { RoomError } from '../../room/validate.ts';
import { lazy } from '../../io.ts';
import type * as MemoryMod from './memory.ts';
import type * as PipeMod from './pipe.ts';
import type * as SshMod from './ssh.ts';
import type * as WsMod from './ws.ts';

// The built-in kinds. Their modules import this one (lineTransport): a cycle, and no kind's code need load until a
// link or invite uses it, so each loads at its first use, through its `kind` export.
const memory = lazy<typeof MemoryMod>(import.meta.url, './memory.ts');
const pipe = lazy<typeof PipeMod>(import.meta.url, './pipe.ts');
const ssh = lazy<typeof SshMod>(import.meta.url, './ssh.ts');
const ws = lazy<typeof WsMod>(import.meta.url, './ws.ts');
const kindOf = (load: () => { kind: Required<KindEntry> }): KindEntry => ({
  open: (spec, ctx) => load().kind.open(spec, ctx),
  parse: rest => load().kind.parse(rest),
  describe: spec => load().kind.describe(spec),
});
const memoryKind: KindEntry<MemorySpec> = { open: spec => memory().over(spec.port), describe: () => 'memory' };
const KIND_TABLE: ReadonlyMap<string, KindEntry> = new Map<string, KindEntry>([
  ['memory', memoryKind], // the table hands each kind only the specs that name it
  ['pipe', kindOf(pipe)],
  ['ssh', kindOf(ssh)],
  ['wss', kindOf(ws)], // ./ws.ts: a Noise channel in a WebSocket, through a TLS front
  ['ws', kindOf(ws)],
]);

const kinds = (): string[] => [...KIND_TABLE.keys()];
const get = (kind: string): KindEntry | null => KIND_TABLE.get(kind) ?? null;

function parse(locator: string): LinkSpec | null {
  const s = String(locator);
  const i = s.indexOf(':');
  const e = i > 0 && get(s.slice(0, i));
  if (!e || !e.parse) return null;
  const spec = e.parse(s.slice(i + 1));
  return spec ? { ...spec, kind: s.slice(0, i) } as LinkSpec : null; // as: the kind's own parse made its spec
}

async function open(spec: SpecBase, ctx: OpenCtx = {}): Promise<Transport> {
  const e = get(spec && spec.kind);
  if (!e) throw new RoomError('INVALID', `unknown transport "${spec && spec.kind}" (${kinds().join(', ')})`);
  return e.open(spec, ctx);
}

function describe(spec: SpecBase): string {
  const e = get(spec && spec.kind);
  return e && e.describe ? e.describe(spec) : String(spec && spec.kind);
}

function lineTransport({ write, shut, ready }: { write(line: string): void; shut(): void; ready?: () => boolean }): LineTransport {
  const frameFns: ((frame: DecodedFrame) => void)[] = [], closeFns: (() => void)[] = [];
  const dec = protocol.decoder();
  let closed = false;
  const end = () => {
    if (closed) return;
    closed = true;
    for (const fn of closeFns) fn();
  };
  const transport: Transport = {
    send(frame) { if (!closed) write(protocol.encode(frame)); },
    onFrame(fn) { frameFns.push(fn); },
    onClose(fn) { closeFns.push(fn); },
    close() { if (!closed) { shut(); end(); } },
    ...(ready ? { writable: () => !closed && ready() } : {}),
  };
  const receive = (chunk: string | Buffer): void => { for (const f of dec.push(chunk)) for (const fn of frameFns) fn(f); };
  return { transport, receive, end };
}

function fromDuplex(stream: Duplex, { readable = stream }: { readable?: Readable } = {}): Transport {
  const { transport, receive, end } = lineTransport({
    write: line => stream.write(line),
    shut: () => { stream.end(); stream.destroy(); if (readable !== stream) readable.destroy(); },
    ready: () => !stream.writableNeedDrain,
  });
  readable.on('data', receive);
  for (const s of new Set([stream, readable])) { s.on('end', end); s.on('close', end); s.on('error', end); }
  return transport;
}

export { kinds, get, parse, open, describe, lineTransport, fromDuplex };
