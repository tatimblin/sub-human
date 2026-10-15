/**
 * plugin/sub-human/lib/remote/server.ts: one connection to a hosted room. `scripts/sub-human serve --stdio CODE`
 * runs one per connection on the host (spawned by the client's pipe transport, or by an SSH forced command); the store contract test runs one on a worker thread over the memory transport. It serves the host's
 * FsRoomStore (isHost) and shares the room's file locks with the host's own hooks, which never go through it.
 * It never loads the signer (test/hooks/security.test.js): a via=human payload arrives signed by the remote
 * hook and is verified against the key pinned in the log (lib/room/envelope.ts), then placed (store.place).
 *
 *   serve(transport, {store, log?, linkId?, login?, silentMs?, proto?, version?}) -> {close(), revoked()}   proto / version: this end's
 *       protocol range and plugin version (default protocol.PROTO, PLUGIN_VERSION; tests fake older and newer peers)
 *       A Session over one transport (lib/remote/transports/*): unauthenticated until hello {token | invite}
 *       (lib/remote/auth.ts); every other op before that is AUTH. linkId (`serve --stdio CODE --link ID`, the
 *       SSH forced command the host's admit writes): only that link's token, or the invite reserved for it,
 *       is accepted; any other is AUTH (and such an invite stays unused). login (`serve --stdio CODE --link ID --login`,
 *       run over the host account's own ssh login, never by a forced command: their lines fix the arguments, and the
 *       CLI refuses --login under SSH_ORIGINAL_COMMAND): the connection is trusted as a process of the account owner,
 *       so a hello {login: true} with no token records link ID (auth.loginLink) and returns its token, with a room
 *       line; without login such a hello is AUTH. store is the room's store as store.open(code)
 *       gives it in this process: seats and decide reach the room through that too. Ops:
 *         hello      version: the highest common one of the two ranges (protocol.negotiate), else PROTOCOL with
 *                    protocol.skewMessage (which side must update); verifyToken, or redeemInvite with the hello's
 *                    pin for an sh2 invite (the token is returned once; a wrong PIN, the last try and the link are
 *                    each a room line from the room, so the host sees them); neither: answered, but the session
 *                    stays unauthenticated. The reply says closed: true once the room's Claude was stopped (the
 *                    room closed), for sub-human doctor on a link that stopped before it
 *         join       {name, role: 'member', pubkey, proof}: auth.checkSeatProof, then lib/seats.ts enter() with
 *                    machine = the link's (no pid: the seat lives by its lease), and over a login link account =
 *                    this machine's id (the host account's own seat: one person with the host's seats, lib/proposal.ts
 *                    create); a key other than the pinned one is AUTH; bindSeat
 *         leave      seats.exit(), own seat only
 *         beat       store.members.beat(name, {presence?}), own seat only; then seats.back (a lapsed seat rejoined)
 *         append     own `from` only; store.place() (validate, rate, replay, verify against the pinned key); a
 *                    signoff or objection is followed by lib/proposal.ts decide() (host only, idempotent). A system
 *                    kind from a link is AUTH (the host writes those)
 *         subscribe  {after, hash}: hash12 of the host's line `after` must equal hash (store.lineHash), else
 *                    FORK; then event 'entry' per line in id order (store.tailer({after}), verbatim), event
 *                    'doc' for members (lib/room/members.ts publicView), presence/NAME and tasks when they
 *                    change (all three at the start), 'end' {reason: 'closed'} when the room's Claude is stopped
 *                    or {reason: 'FORK'} when the host log is reset, or {reason: 'AUTH', message} when the
 *                    host revoked the link (revoked(), on the serve's SIGTERM). Polls every FOLLOW_POLL_MS until the
 *                    transport closes
 *         blob.get   store.blobs.get(ref), base64;  blob.put  {name, bytes}: name must be plans/<hash12>.md of
 *                    the bytes (content-addressed, at most PROPOSAL_FILE_MAX), written once
 *         handoff.accept  {id, accept, locator, invites}: lib/handoff.ts serverAccept (the ask's target seat of this
 *                    link, its signed acceptance; host_changed appended); after the reply, afterMoved (the room's Claude job
 *                    stopped, this machine a mirror of the new host)
 *         handoff.refuse  {id}: lib/handoff.ts serverRefuse
 *       Host epochs (lib/handoff.ts): hello {epoch} from a mirror at a later epoch than this log's is STALE (this
 *       machine is a host the room moved away from), and the reply carries this log's epoch; append {epoch} from
 *       another epoch is STALE. Once the log says the room moved to another machine, every op but hello, subscribe,
 *       blob.get and ping is STALE; a subscribe stream then ends after the lines with the private 'moved' event (this
 *       link's machine's invite to the new host) and end {reason: 'moved'}. A pending ask for one of the link's
 *       seats is sent as the private 'handoff' event.
 *         ping       {pong: the host's ms}: the link daemon's heartbeat (lib/remote/link.ts). A session whose hello
 *                    carried caps {ping: true} and that then sends no frame for silentMs (LINK_SILENT_MS,
 *                    SUB_HUMAN_LINK_SILENT_MS) is closed: the peer is gone (a half-open link after a sleep)
 *       After a write (join, leave, beat, append) every stream of the session is polled before the reply goes out,
 *       so a link that subscribed holds the write's lines and documents when its reply arrives (read-your-writes).
 *       An op that throws a RoomError (a protocol CODES code) answers {error: {code, message}} with the same
 *       code; any other error is INVALID with the message and is logged. A frame that is not a request is
 *       answered PROTOCOL. close() ends the streams and the transport.
 */

import * as protocol from './protocol.ts';
import * as auth from './auth.ts';
import * as seats from '../seats.ts';
import * as proposal from '../proposal.ts';
import * as handoff from '../handoff.ts';
import * as members from '../room/members.ts';
import * as envelope from '../room/envelope.ts';
import { RoomError, hash12 } from '../room/store.ts';
import { machineId } from '../home.ts';
import { FOLLOW_POLL_MS, PROPOSAL_FILE_MAX, LINK_SILENT_MS, envMs } from '../config.ts';
import type {
  CodedError, DecodedFrame, ErrorFrame, EventData, EventName, FrameId, IncomingRequest, LinkRecord, Op, OpParams, OpResults, ProtoRange,
} from './types-core.ts';
import type { Transport } from './types-rest.ts';
import type { Members, RoomStore } from '../room/types.ts';

type Log = (msg: string) => void;
/** What hello's credential gives: the link (null: answered, but still unauthenticated) and a new token, once. */
interface Credential { link: LinkRecord | null; token?: string }
/** A subscribe stream of a session. */
interface Stream { tick(): void; stop(): void; end(reason: EventData['end']['reason'], message?: string): void }
/** Each op's handler: the session, the request's params (as the peer sent them) and its id. */
type OpHandlers = { [K in Op]: (s: Session, params: OpParams[K], id: FrameId | undefined) => OpResults[K] };

const MACHINE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ANSWERS = new Set(['signoff', 'objection']);
const WRITES = new Set(['join', 'leave', 'beat', 'append', 'handoff.accept', 'handoff.refuse']);
const WHILE_MOVED = new Set(['hello', 'subscribe', 'blob.get', 'ping']); // what a host the room moved away from still serves
const epochOf = (store: RoomStore): number => store.hostState().epoch;
const stale = (msg: string): CodedError => new RoomError('STALE', msg);
const WIRE_CODES: Set<string> = new Set(Object.values(protocol.CODES));
const authError = (msg: string): CodedError => new RoomError('AUTH', msg);
const invalid = (msg: string): CodedError => new RoomError('INVALID', msg);

function own(s: Session, name: string | undefined): void {
  if (!auth.mayWriteAs(s.link, name as string)) throw authError(`${name} has not joined over this link`);
}

function redeem(s: Session, invite: unknown, machine: string, pin: unknown): Credential {
  const { store, linkId } = s;
  const inv = auth.parseInvite(invite);
  if (!inv || inv.code !== store.code) throw authError(`not an invite to room ${store.code}`);
  let r: ReturnType<typeof auth.redeemInvite>;
  try {
    r = auth.redeemInvite(store, inv.secret, { machine, pin, ...(linkId ? { linkId } : {}) });
  } catch (e) {
    if ((e as CodedError).note) roomLine(s, (e as CodedError).note!);
    throw e;
  }
  if (r.admission) roomLine(s, `${r.admission.name}'s machine (${r.admission.label || machine}) joined the room, let in by ${r.admission.admitted_by || 'the host'}; undo with: /sub-human kick ${r.admission.name}`);
  else if (r.handoff) roomLine(s, `a machine (${machine}) followed the room here with the invite its handoff gave it (link ${r.link.id})`);
  else if (inv.v === 2) roomLine(s, `a machine (${machine}) linked to the room with an invite and its PIN (link ${r.link.id})`);
  return r;
}

/** A line in the room from the room itself (via system), best effort: what the host should know about its links. */
function roomLine(s: Session, text: string): void {
  try { s.store.append({ kind: 'status', text }, { via: 'system', from: 'room', system: true }); } catch (e) { s.log(`sub-human serve: room line: ${e && (e as Error).message}`); }
}

/** hello {login: true}: a new link for a connection over the host account's own ssh login (Session.login), else AUTH. */
function viaLogin(s: Session, machine: string): Credential {
  if (!s.login || !s.linkId) {
    throw authError(`this connection did not arrive over the host account's own ssh login${s.linkId ? ` (it came through a key that was let in for one other connection, and reaches only that one)` : ''}; join with an invite instead (/sub-human invite on the host)`);
  }
  const r = auth.loginLink(s.store, { id: s.linkId, machine }); // linkId: checked above
  roomLine(s, 'a machine linked over your SSH login');
  return r;
}

function known(store: RoomStore, token: unknown, linkId: string | null): Credential {
  const link = auth.verifyToken(store, token);
  if (!link) throw authError('unknown link token; ask the host for a new invite');
  if (linkId && link.id !== linkId) throw authError(`this token is not link ${linkId}'s`);
  return { link };
}

// ---------- the subscribe stream ----------
/** The host documents a mirror holds, as other machines may see them: key -> value. */
function docsOf(store: RoomStore): Map<string, unknown> {
  const docs = new Map<string, unknown>([['members', members.publicView(store.members.read())], ['tasks', store.kv.get('tasks')]]);
  for (const k of store.kv.list('presence/')) docs.set(k, store.kv.get(k));
  return docs;
}
const stopped = (ms: Members): boolean => !!(ms.claude && ms.claude.stopped_at);

/** Stream subscribe request `id`'s events from the line after `after`. Returns {tick() (poll now), stop()}. */
function stream(s: Session, id: FrameId | undefined, after: number): Stream {
  const tailer = s.store.tailer({ after });
  const sent = new Map<string, string>(); // doc key -> the JSON last sent
  const priv = { lastId: after }; // the private events sent (lib/handoff.ts streamEvent)
  let wasStopped = stopped(s.store.members.read());
  const send = <E extends EventName>(ev: E, data: EventData[E]) => s.transport.send(protocol.event(id as FrameId, ev, data)); // (as: a request with no id gets events with none)
  const end = (reason: EventData['end']['reason'], message?: string) => { send('end', { reason, ...(message ? { message } : {}) }); stop(); };

  function sendDocs(docs: Map<string, unknown>) {
    for (const key of new Set([...sent.keys(), ...docs.keys()])) {
      const value = docs.has(key) ? docs.get(key) : null;
      const json = JSON.stringify(value);
      if (sent.get(key) !== json) { sent.set(key, json); send('doc', { key, value }); }
    }
  }
  function tick(): void {
    const { lines, entries, reset } = tailer.poll();
    if (reset) return end('FORK');
    for (const line of lines) send('entry', line);
    for (const e of entries) if (e.id > priv.lastId) priv.lastId = e.id;
    const docs = docsOf(s.store);
    sendDocs(docs);
    const p = handoff.streamEvent(s.store, s.link, priv);
    if (p) { send(p.ev, p.data); if (p.end) return end('moved'); }
    const now = stopped(docs.get('members') as Members); // docsOf's publicView
    if (now && !wasStopped) return end('closed');
    wasStopped = now;
  }
  const safeTick = () => { try { tick(); } catch (e) { s.log(`sub-human serve: subscribe: ${e && (e as Error).stack || e}`); } };
  const first = setImmediate(safeTick); // after the subscribe reply
  const timer = setInterval(safeTick, FOLLOW_POLL_MS);
  const self: Stream = { tick: safeTick, stop, end };
  function stop() { clearImmediate(first); clearInterval(timer); s.streams.delete(self); }
  return self;
}

// ---------- ops ----------
const OPS: OpHandlers = {
  hello(s, params) {
    const { machine, token, invite, pin, caps, epoch } = params;
    const theirs = protocol.rangeOf(params);
    if (!theirs) throw new RoomError('PROTOCOL', 'hello names no protocol version');
    const v = protocol.negotiate(s.proto, theirs);
    const client = typeof params.client === 'string' ? params.client.slice(0, 32) : null;
    if (v === null || v < (Number.isInteger(params.v) ? params.v! : 1)) {
      throw new RoomError('PROTOCOL', protocol.skewMessage({ host: { version: s.version, proto: s.proto }, joiner: { version: client, proto: theirs } }));
    }
    if (typeof machine !== 'string' || !MACHINE_RE.test(machine)) throw invalid('hello needs this machine\'s id');
    const mine = epochOf(s.store);
    if (Number.isInteger(epoch) && epoch! > mine) {
      throw stale(`room ${s.store.code} has moved away from this machine to a newer host. Run /sub-human doctor to see where it is`);
    }
    s.link = null;
    s.v = v;
    const r: Credential = invite !== undefined ? redeem(s, invite, machine, pin) : token !== undefined ? known(s.store, token, s.linkId)
      : params.login === true ? viaLogin(s, machine) : { link: null };
    s.link = r.link;
    if (caps && caps.ping === true) s.expireSilent();
    // time: the host's clock (ms), so a joiner (sub-human doctor) can measure the skew that SIG_SKEW_MS bounds; additive
    const out: OpResults['hello'] = { v, proto: s.proto, server: s.version, caps: protocol.CAPS, room: s.store.code, link: r.link ? r.link.id : null, epoch: mine, time: Date.now() };
    if (r.token) out.token = r.token;
    if (stopped(s.store.members.read())) out.closed = true; // additive: an older host says nothing
    return out;
  },

  join(s, { name, role = 'member', pubkey, proof }) {
    if (role !== 'member') throw invalid('a link joins members only');
    if (!envelope.parseKey(pubkey)) throw invalid('join needs the seat\'s public key (Ed25519 SPKI PEM)');
    auth.checkSeatProof(proof, { room: s.store.code, name, pubkey });
    // s.link: run() lets no op but hello in without it. A bound link (the card let one name in; a handoff's seats) joins
    // its own seats only, before any seat is taken. A login link is the host account's own: its seat is that person's
    if (!auth.mayJoinAs(s.link, name)) throw authError(auth.notBound(s.link!, name));
    const account = s.link!.login ? machineId() : undefined;
    const r = seats.enter({ code: s.store.code, name, machine: s.link!.machine, pubkey, ...(account ? { account } : {}) });
    if (!r.ok) throw new RoomError(r.code || 'INVALID', r.error);
    s.link = auth.bindSeat(s.store, s.link!.id, name);
    return r.rejoin ? { ok: true, rejoin: true } : { ok: true };
  },

  leave(s, { name, reason = 'left' }) {
    own(s, name);
    if (typeof reason !== 'string') throw invalid('reason must be a string');
    return { ok: seats.exit(s.store.code, name, reason) };
  },

  beat(s, { name, presence }) {
    own(s, name);
    const ok = s.store.members.beat(name, { presence });
    if (ok) seats.back(s.store.code, name); // a seat that lapsed (seats.sweep) is back: "NAME rejoined"
    return { ok };
  },

  append(s, { payload, epoch }) {
    if (!payload || typeof payload !== 'object') throw invalid('append needs {payload}');
    const mine = epochOf(s.store);
    if (Number.isInteger(epoch) && epoch !== mine) {
      throw stale(epoch! < mine ? `room ${s.store.code} changed hosts and this machine hasn't caught up yet; try again in a moment`
        : `room ${s.store.code} has moved away from this machine to a newer host. Run /sub-human doctor to see where it is`);
    }
    own(s, payload.from);
    if (payload.via === 'system') throw authError('a link never writes via "system"; the host writes the room\'s own entries');
    const entry = s.store.place(payload);
    if (ANSWERS.has(entry.kind) && entry.proposal_hash) {
      try { proposal.decide(s.store.code, entry.proposal_hash); } catch (e) { s.log(`sub-human serve: decide: ${e && (e as Error).stack || e}`); }
    }
    return { entry };
  },

  subscribe(s, { after, hash }, id) {
    if (!Number.isInteger(after) || after < 0) throw invalid('subscribe needs {after: id, hash}');
    if (s.store.lineHash(after) !== hash) {
      throw new RoomError('FORK', `the host's line ${after} is not the mirror's; re-mirror with sub-human link --reset ${s.store.code}`);
    }
    s.streams.add(stream(s, id, after));
    return { ok: true };
  },

  'blob.get'(s, { ref }) {
    const b = s.store.blobs.get(ref);
    return { bytes: b ? b.toString('base64') : null };
  },

  'handoff.accept'(s, params) {
    const r = handoff.serverAccept(s.store, s.link!, params); // s.link: run() lets no op but hello in without it
    s.later = () => handoff.afterMoved(s.store, { job: r.job });
    return { ok: true, epoch: r.epoch, entry: r.entry };
  },

  'handoff.refuse'(s, params) { return handoff.serverRefuse(s.store, s.link!, params); }, // s.link: as above

  'blob.put'(s, { name, bytes }) {
    if (typeof bytes !== 'string') throw invalid('blob.put needs {name, bytes: base64}');
    const buf = Buffer.from(bytes, 'base64');
    if (buf.length > PROPOSAL_FILE_MAX) throw invalid(`a blob is at most ${PROPOSAL_FILE_MAX} bytes`);
    if (name !== `plans/${hash12(buf)}.md`) throw invalid('a blob is named by its content: plans/<hash12 of the bytes>.md');
    if (!s.store.blobs.has(name)) s.store.blobs.put(name, buf);
    return { ref: name };
  },

  ping() { return { pong: Date.now() }; },
};

// ---------- the session ----------
class Session {
  transport: Transport;
  login: boolean;
  store: RoomStore;
  log: Log;
  linkId: string | null;
  proto: ProtoRange;
  version: string;
  v: number | null;
  link: LinkRecord | null;
  later: (() => void) | null;
  streams: Set<Stream>;
  silentMs: number;
  heard: number;
  silence: NodeJS.Timeout | null;
  constructor(transport: Transport, store: RoomStore, log: Log, linkId: string | null | undefined, silentMs: number, {
    proto = protocol.PROTO, version = protocol.PLUGIN_VERSION, login = false,
  }: { proto?: ProtoRange; version?: string; login?: boolean } = {}) {
    this.transport = transport;
    this.login = login === true;
    this.store = store;
    this.log = log;
    this.linkId = linkId || null;
    this.proto = proto;
    this.version = version;
    this.v = null; // the version hello chose
    this.link = null;
    this.later = null; // work an op leaves for after its reply (handoff.accept)
    this.streams = new Set(); // {tick, stop}
    this.silentMs = silentMs;
    this.heard = Date.now();
    this.silence = null;
    transport.onFrame(f => this.receive(f));
    transport.onClose(() => this.stop());
  }

  /** The peer pings: a session silent for silentMs is closed (its streams end with the transport). */
  expireSilent(): void {
    if (this.silence || !(this.silentMs > 0)) return;
    this.silence = setInterval(() => {
      if (Date.now() - this.heard <= this.silentMs) return;
      this.log(`sub-human serve: no frame for ${this.silentMs} ms; closing the link`);
      this.stop();
      this.transport.close();
    }, Math.max(10, Math.floor(this.silentMs / 3)));
    this.silence.unref();
  }

  receive(f: DecodedFrame | ErrorFrame): void {
    this.heard = Date.now();
    if (!protocol.isRequest(f)) {
      const g = f as { id?: FrameId; error?: { message?: unknown } }; // not a request: read as it came
      return this.transport.send(protocol.error(g.id ?? null, 'PROTOCOL', g.error ? g.error.message : 'expected a request {id, op, params}'));
    }
    let out;
    try { out = protocol.reply(f.id, this.run(f)); } catch (e) { out = this.failure(f, e); }
    if (WRITES.has(f.op)) for (const st of [...this.streams]) st.tick(); // the write's lines before its reply
    this.transport.send(out);
    const later = this.later;
    this.later = null;
    if (later) setImmediate(() => { try { later(); } catch (e) { this.log(`sub-human serve: after ${f.op}: ${e && (e as Error).stack || e}`); } });
  }

  run({ id, op, params }: IncomingRequest): unknown {
    if (!Object.hasOwn(OPS, op)) throw new RoomError('PROTOCOL', `unknown op "${op}"`);
    if (op !== 'hello' && !this.link) throw authError('say hello with this link\'s token first');
    if (!WHILE_MOVED.has(op) && handoff.movedAway(this.store)) {
      const h = this.store.hostState!(); // movedAway: only a store with hostState moves
      throw stale(`room ${this.store.code} moved to ${h.host}'s machine; this machine takes no more messages for it`);
    }
    const ops = OPS as unknown as Record<string, (s: Session, params: object, id: FrameId | undefined) => unknown>; // op: one of OPS (checked above)
    return ops[op](this, params && typeof params === 'object' ? params : {}, id);
  }

  failure(f: IncomingRequest, err: unknown): ErrorFrame {
    const e = err as CodedError | null | undefined; // anything an op threw
    if (e && WIRE_CODES.has(e.code!)) return protocol.error(f.id, e.code!, e.message);
    this.log(`sub-human serve: ${f.op}: ${e && e.stack || e}`);
    return protocol.error(f.id, 'INVALID', (e && e.message) || String(e));
  }

  /** True when the host revoked this session's link (its record is gone): every stream then ends {reason: 'AUTH'},
   * so the daemon stops with the reason instead of redialing a key that no longer gets in (`/sub-human kick`
   * stops this serve with SIGTERM: scripts/sub-human serve calls this first). */
  revoked(): boolean {
    if (!this.link || (this.store.kv.get(auth.LINKS_KEY, null) || {})[this.link.id]) return false;
    for (const st of [...this.streams]) st.end('AUTH', `the host revoked this link (${this.link.id}); ask them for a new invite`);
    return true;
  }

  stop(): void {
    clearInterval(this.silence ?? undefined);
    this.silence = null;
    for (const st of [...this.streams]) st.stop();
  }
}

/**
 * @param {{send(frame: object): void, onFrame(fn: (frame: object) => void): void, onClose(fn: () => void): void, close(): void}} transport
 * @param {{store: import('../room/store.ts').FsRoomStore, log?: (...a: any[]) => void, linkId?: string, login?: boolean, silentMs?: number, proto?: {min: number, max: number}, version?: string}} ctx
 * @returns {{close(): void}}
 */
function serve(transport: Transport, { store, log = () => {}, linkId, login = false, silentMs = envMs('SUB_HUMAN_LINK_SILENT_MS', LINK_SILENT_MS), proto, version }: {
  store: RoomStore; log?: Log; linkId?: string; login?: boolean; silentMs?: number; proto?: ProtoRange; version?: string;
}): { close(): void; revoked(): boolean } {
  const session = new Session(transport, store, log, linkId, silentMs, { proto, version, login });
  return { close() { session.stop(); transport.close(); }, revoked: () => session.revoked() };
}

export { serve };
