/**
 * plugin/sub-human/lib/remote/client.ts: the asynchronous side of the protocol, one connection to a room's
 * server over a transport. The link daemon (lib/remote/link.ts) holds one per room; the protocol tests drive
 * one directly. Hooks never use it: they call the daemon through lib/remote/bridge.ts. It never loads the
 * signer: a via=human payload, and a join's seat proof (lib/remote/host-links.ts proveSeat), reach it already
 * signed.
 *
 *   connect(transport, {machine, token?, invite?, pin?, as?, checkHost?, login?, epoch?, caps?, deadlineMs?, helloMs?, proto?, version?}) -> Promise<Client>
 *       hello carries {proto, client} (lib/remote/protocol.ts): the server picks the version; a version outside
 *       this end's range, or a refusal from a host too old or too new, is PROTOCOL SKEW with skewMessage (who must update).
 *       pin: an invite's PIN (checked by the host, never here); as: {name, label} the seat an invite line's PIN asks
 *       for. checkHost(host) (an invite line over ssh or a pipe, protocol 3): a first hello carries only a fresh nonce,
 *       checkHost reads the reply's host proof (the host's machine key over that nonce: it throws to stop, so the secret
 *       never goes to a host the line does not name), and a second hello carries the credential; a host that gives no
 *       proof is older (PROTOCOL SKEW). signMachine(challenge): with an invite, the first hello is made over the web
 *       too, and the second's machine proof signs the challenge its reply handed out (lib/remote/machine-key.ts
 *       proofFor), so a proof is good in that one session only. login: true (no token, no invite): a link over the
 *       host account's own ssh login (lib/remote/server.ts); a host that returns no token for it is PROTOCOL. proto / version: fakes for the skew tests.
 *       epoch: the mirror's host epoch (lib/handoff.ts), sent in the hello; the server's is client.epoch (0 from a
 *       server that sends none).
 *       transport may also be a Promise of one (lib/remote/transports/index.ts open()). Says hello; resolves once the server answered (the token from a redeemed invite is on client.token).
 *       helloMs (default deadlineMs) bounds the hello alone: a transport such as ssh connects before it answers.
 *       A refused hello closes the transport and rejects.
 *   Client
 *     token, link, room, serverCaps, v (the version in use), serverVersion (the host's plugin version), machine (this
 *     machine's id in the room as the host records it, null from a host that sends none)
 *     request(op, params, {ms}?) -> Promise<result>   one op as the wire has it (the link daemon relays its hooks' ops
 *         so); ms: its own deadline instead of deadlineMs (the daemon waits longer for an @room post sent already)
 *     join({name, role?, pubkey, proof, log_v?}) -> Promise<{ok, rejoin?}>   log_v: what log the seat's code reads (additive)
 *     leave(name, reason) -> Promise<{ok}>
 *     beat(name, {presence?}) -> Promise<{ok}>
 *     append(payload) -> Promise<entry>
 *     subscribe(after, hash, onEvent, {snapshot}?) -> {ready: Promise, stop()}   onEvent({ev, data}) for every entry,
 *         doc, snapshot and end event (protocol.ts); snapshot: true asks for the host's snapshot first (after 0, and
 *         only of a server that snapshots()); ready rejects on a refused subscribe (FORK, AUTH, …) and the stream is
 *         dropped. A transport that closes ends it with {ev: 'end', data: {reason: 'OFFLINE'}}. stop() stops
 *         delivering (the server's stream ends with the transport)
 *     blobGet(ref) -> Promise<Buffer | null>, blobPut(name, bytes) -> Promise<ref>
 *     supports(op) -> bool         the server's hello caps list op (an old server's do not list 'ping')
 *     snapshots() -> bool         the server's hello caps say snapshot: true (an old server's do not)
 *     fields() -> [field]          the entry fields the server's hello caps list (protocol.ts FIELDS; an old server's: none)
 *     ping(ms?) -> Promise<{pong, rttMs}>   one heartbeat (protocol.ts ping); OFFLINE when no pong within ms
 *         (default deadlineMs). The link daemon pings only when supports('ping') and says hello with caps {ping: true}
 *     closed                        true once the transport closed
 *     drain(ms?) -> Promise          resolves once no call waits for a reply (or after ms, default deadlineMs): the
 *         link daemon closes a replaced connection only then, so a hook's op in flight on it is answered
 *     close()
 *   A reply with error rejects with RoomError(code, message, reason?), the code and reason as the server sent them. A call
 *   with no reply within deadlineMs (default LINK_CALL_MS) rejects OFFLINE with reason UNKNOWN_OUTCOME (the frame went out
 *   and may still land) and its late reply is dropped; a transport
 *   that closed rejects every pending call with OFFLINE. Nothing is retried.
 */

import crypto from 'node:crypto';
import * as protocol from './protocol.ts';
import { RoomError } from '../room/validate.ts';
import { LINK_CALL_MS } from '../config.ts';
import type { DecodedFrame, HelloResult, Op, OpResults, ProtoRange, StreamEvent } from './types-core.ts';
import type { Entry } from '../room/types.ts';
import type { Transport } from './types-rest.ts';
import type { MachineId, LinkToken, InviteSecret, Pin } from '../brand.ts';

/** The server's caps, from its hello. */
interface ServerCaps {
  ops?: unknown;
  fields?: unknown;
  snapshot?: unknown;
}

interface Pending {
  resolve(result: unknown): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
}

/** The server's answer to hello (types-core HelloResult), read defensively: what a host may leave out is optional. */
type HelloReply = Pick<HelloResult, 'v' | 'link' | 'room'> & Partial<Pick<HelloResult, 'proto' | 'server' | 'token' | 'epoch' | 'machine' | 'as'>> & {
  caps: ServerCaps | null;
};

export interface ConnectOpts {
  /** this machine's id (home.machineId; null when it could not be read: the host refuses the hello) */
  machine: MachineId | null;
  /** this home's machine key's proof (lib/remote/machine-key.ts): the host derives the machine's id from it */
  machineKey?: { key: string; ts: number; sig: string };
  token?: LinkToken;
  invite?: InviteSecret | undefined;
  pin?: Pin | undefined;
  /** protocol 3: the seat an invite line's PIN asks for, and this machine's short name */
  as?: { name: string; label: string };
  /** protocol 3: signs this machine's key over the host's challenge (machine-key.ts proofFor); with an invite the
   *  credential then goes in a second hello whose proof is so bound (see the header) */
  signMachine?: (challenge: string) => { key: string; ts: number; sig: string };
  /** protocol 3: the host proves its machine key over a nonce before the credential goes (see the header) */
  checkHost?: (host: { key: string; sig: string } | null, nonce: string) => void;
  login?: boolean;
  epoch?: number;
  caps?: object;
  deadlineMs?: number;
  helloMs?: number;
  proto?: ProtoRange;
  version?: string;
}

const offline = (msg: string): Error => new RoomError('OFFLINE', msg);

class Client {
  transport: Transport;
  deadlineMs: number;
  seq: number;
  closed: boolean;
  pending: Map<number, Pending>;
  streams: Map<number, (e: StreamEvent) => void>;
  token: LinkToken | null;
  link: string | null;
  room: string | null;
  serverCaps: ServerCaps | null;
  epoch: number | null;
  /** this machine's id in the room as the host records it (its hello's reply; null from a host that sends none) */
  machine: string | null = null;
  /** the name the host bound the link to, with a fresh token (its hello's reply; null otherwise) */
  as: string | null = null;
  declare v: number;
  declare serverVersion: string | null;

  constructor(transport: Transport, { deadlineMs }: { deadlineMs: number }) {
    this.transport = transport;
    this.deadlineMs = deadlineMs;
    this.seq = 0;
    this.closed = false;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.streams = new Map(); // subscribe id -> onEvent
    this.token = this.link = this.room = this.serverCaps = this.epoch = null;
    transport.onFrame(f => this._receive(f));
    transport.onClose(() => this._closed());
  }

  _receive(f: DecodedFrame): void {
    if (protocol.isEvent(f)) return this._event(f);
    const p = protocol.isReply(f) && this.pending.get(f.id as number);
    if (!p) return; // abandoned at its deadline, or not ours
    this.pending.delete(f.id as number);
    clearTimeout(p.timer);
    if (f.error) p.reject(protocol.toError(f.error));
    else p.resolve(f.result);
  }

  _event({ id, ev, data }: DecodedFrame): void {
    const fn = this.streams.get(id as number);
    if (!fn) return;
    if (ev === 'end') this.streams.delete(id as number);
    fn({ ev, data } as StreamEvent); // the host's event, as it sent it: the subscriber checks what it reads
  }

  _closed(): void {
    this.closed = true;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(offline('the link closed')); }
    this.pending.clear();
    const fns = [...this.streams.values()];
    this.streams.clear();
    for (const fn of fns) fn({ ev: 'end', data: { reason: 'OFFLINE' } });
  }

  /** An op's result as the host sent it (types-core OpResults: what a conforming host answers). */
  _request<O extends Op>(op: O, params: object, id?: number, ms?: number): Promise<OpResults[O]>;
  _request(op: string, params: object, id?: number, ms?: number): Promise<unknown>;
  _request(op: string, params: object, id: number = ++this.seq, ms: number = this.deadlineMs): Promise<unknown> {
    if (this.closed) return Promise.reject(offline('the link is closed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RoomError('OFFLINE', `${op}: no answer within ${ms} ms; ${protocol.UNKNOWN_OUTCOME}`, 'UNKNOWN_OUTCOME')); }, ms);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send(protocol.request(id, op, params));
    });
  }

  request(op: string, params: object, { ms }: { ms?: number } = {}): Promise<unknown> { return this._request(op, params, undefined, ms); }
  join({ name, role = 'member', pubkey, proof, log_v }: { name: string; role?: string; pubkey: string; proof: object; log_v?: number }): Promise<{ ok: boolean; rejoin?: boolean }> { return this._request('join', { name, role, pubkey, proof, ...(log_v ? { log_v } : {}) }); }
  leave(name: string, reason?: string): Promise<{ ok: boolean }> { return this._request('leave', { name, reason }); }
  beat(name: string, { presence }: { presence?: unknown } = {}): Promise<{ ok: boolean }> { return this._request('beat', { name, presence }); }
  /** The entry as the server stored it. */
  async append(payload: object): Promise<Entry> { return (await this._request('append', { payload })).entry; }

  subscribe(after: number, hash: string | null, onEvent: (e: StreamEvent) => void, { snapshot = false }: { snapshot?: boolean } = {}): { ready: Promise<unknown>; stop(): void } {
    const id = ++this.seq;
    this.streams.set(id, onEvent);
    const ready = this._request('subscribe', snapshot ? { after, hash, snapshot: true } : { after, hash }, id).catch(e => { this.streams.delete(id); throw e; });
    return { ready, stop: () => { this.streams.delete(id); } };
  }

  async blobGet(ref: string): Promise<Buffer | null> {
    const { bytes } = await this._request('blob.get', { ref });
    return bytes == null ? null : Buffer.from(bytes, 'base64');
  }
  async blobPut(name: string, bytes: Buffer | string): Promise<string> { return (await this._request('blob.put', { name, bytes: Buffer.from(bytes).toString('base64') })).ref; }

  drain(ms: number = this.deadlineMs): Promise<void> {
    const until = Date.now() + ms;
    return new Promise(resolve => {
      const check = (): unknown => (this.closed || !this.pending.size || Date.now() >= until ? resolve() : setTimeout(check, 10));
      check();
    });
  }

  supports(op: string): boolean { return !!this.serverCaps && Array.isArray(this.serverCaps.ops) && this.serverCaps.ops.includes(op); }
  snapshots(): boolean { return !!this.serverCaps && this.serverCaps.snapshot === true; }
  fields(): string[] { const f = this.serverCaps && this.serverCaps.fields; return Array.isArray(f) ? f.filter((x): x is string => typeof x === 'string') : []; }
  async ping(ms: number = this.deadlineMs): Promise<{ pong: unknown; rttMs: number }> {
    const t0 = Date.now();
    const r = await this._request('ping', {}, undefined, ms);
    return { pong: r && r.pong, rttMs: Date.now() - t0 };
  }

  close(): void { this.transport.close(); }
}

/** transport: {send(frame), onFrame(fn), onClose(fn), close()}, or a Promise of one */
async function connect(transport: Transport | Promise<Transport>, opts: ConnectOpts): Promise<Client> {
  const { machine, machineKey, signMachine, token, invite, pin, as, checkHost, login, epoch, caps = {}, deadlineMs = LINK_CALL_MS, helloMs = deadlineMs } = opts;
  const proto: ProtoRange = opts.proto || protocol.PROTO, version: string = opts.version || protocol.PLUGIN_VERSION;
  const c = new Client(await transport, { deadlineMs });
  const cred: { invite?: InviteSecret; pin?: Pin; as?: { name: string; label: string }; token?: LinkToken; login?: boolean } = invite !== undefined
    ? { invite, ...(pin !== undefined ? { pin } : {}), ...(as ? { as } : {}) } : token !== undefined ? { token } : login === true ? { login: true } : {};
  // the version this hello needs at least: an invite line (checkHost) needs 3, an sh2 invite's PIN 2
  const need = Math.max(proto.min, checkHost ? 3 : pin !== undefined ? 2 : 1);
  const me = { version, proto };
  const base = { proto, client: version, caps, machine, ...(machineKey ? { machine_key: machineKey } : {}), ...(Number.isInteger(epoch) ? { epoch } : {}) };
  const skew = (r: HelloReply): RoomError => {
    const theirs = protocol.rangeOf({ proto: r.proto });
    return new RoomError('PROTOCOL', protocol.skewMessage({ host: { version: r.server, proto: theirs || { min: r.v, max: r.v } }, joiner: me }), 'SKEW');
  };
  const inRange = (r: HelloReply): boolean => !!protocol.rangeOf({ proto: r.proto }) && r.v >= proto.min && r.v <= proto.max && r.v >= need;
  try {
    let bound: { machine_key: { key: string; ts: number; sig: string } } | Record<string, never> = {};
    if (checkHost || (signMachine && cred.invite !== undefined)) {
      // a first hello with no credential: the host proves its key (checkHost) and hands out a challenge; the secret
      // goes only in the second hello, its machine proof over that challenge
      const nonce = checkHost ? crypto.randomBytes(18).toString('base64url') : undefined;
      const first: HelloReply & { host?: { key: string; sig: string }; challenge?: string } = await c._request('hello', { ...base, ...(nonce ? { nonce } : {}) }, ++c.seq, helloMs);
      if (!inRange(first)) throw skew(first);
      if (checkHost) checkHost(first.host && typeof first.host === 'object' ? first.host : null, nonce!);
      if (signMachine && typeof first.challenge === 'string') bound = { machine_key: signMachine(first.challenge) };
    }
    const r: HelloReply = await c._request('hello', { ...base, ...bound, ...cred }, ++c.seq, helloMs);
    if (!inRange(r)) throw skew(r);
    if (cred.login && !r.token) throw new RoomError('PROTOCOL', `the host's sub-human (${r.server || 'an unknown version'}) makes no link over an ssh login; update it there, or join with an invite`, 'SKEW');
    Object.assign(c, { token: r.token || token || null, link: r.link, room: r.room, serverCaps: r.caps, v: r.v, serverVersion: r.server || null, epoch: Number.isInteger(r.epoch) ? r.epoch : 0, machine: typeof r.machine === 'string' && r.machine ? r.machine : null, as: typeof r.as === 'string' && r.as ? r.as : null });
  } catch (e) {
    c.close();
    throw e;
  }
  return c;
}


export { connect };
export type { Client };
