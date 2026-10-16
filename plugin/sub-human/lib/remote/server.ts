/**
 * plugin/sub-human/lib/remote/server.ts: one connection to a hosted room. `scripts/sub-human serve --stdio CODE`
 * runs one per connection on the host (spawned by the client's pipe transport, or by an SSH forced command); the store contract test runs one on a worker thread over the memory transport. It serves the host's
 * FsRoomStore (isHost) and shares the room's file locks with the host's own hooks, which never go through it.
 * It never loads the signer (test/hooks/security.node-test.ts): a via=human payload arrives signed by the remote
 * hook and is verified against the key pinned in the log (lib/room/envelope.ts), then placed (store.place).
 *
 *   serve(transport, {store, log?, linkId?, login?, via?, peer?, silentMs?, proto?, version?}) -> {close(), revoked()}
 *       proto / version: this end's protocol range and plugin version (default protocol.PROTO, PLUGIN_VERSION; tests
 *       fake older and newer peers). via 'ws' and peer (`serve --stdio CODE --via ws [--peer KEY]`, the web listener's
 *       child): the connection came over the web, and peer is the Noise key its XK handshake proved (none: an NK one,
 *       a link made under protocol 2)
 *       A Session over one transport (lib/remote/transports/*): unauthenticated until hello {token | invite}
 *       (lib/remote/invites.ts); every other op before that is AUTH. linkId without login (`serve --stdio CODE --link
 *       ID`, the ssh forced command an admit wrote before protocol 3): only that link's token, or the admission reserved
 *       for it, is accepted; any other is AUTH (and such an invite stays unused). login (`serve --stdio CODE --link ID --login`,
 *       run over the host account's own ssh login, never by a forced command: their lines fix the arguments, and the
 *       CLI refuses --login under SSH_ORIGINAL_COMMAND): the connection is trusted as a process of the account owner,
 *       so a hello {login: true} with no token records link ID (hostLinks.loginLink) and returns its token, with a room
 *       line; without login such a hello is AUTH. store is the room's store as store.open(code)
 *       gives it in this process: seats and decide reach the room through that too. Ops:
 *         hello      version: the highest common one of the two proto ranges (protocol.negotiate; a hello with none, or
 *                    no overlap, is PROTOCOL SKEW with protocol.skewMessage: which side must update); verifyToken (a
 *                    link bound to a Noise key only over a connection that proved it: KEY_MISMATCH), or redeemInvite
 *                    with the hello's pin (an invite line's SECRET word: protocol 3 only, and over the web only with
 *                    XK's peer key; a promote's sh2 invite: its 6-digit PIN), as {name, label} (the seat an invite
 *                    line's PIN asks for), the token returned once; a wrong PIN, the last try, a PIN that held and
 *                    the link are each a room line from the room, so the host sees them; or loginLink; neither:
 *                    answered, but the session stays unauthenticated. nonce (protocol 3): the reply's host is the host
 *                    home's machine key and its signature over it (machine-key.ts hostProof), which an invite line's
 *                    tag names over ssh and a pipe: a joiner sends its secret only in a second hello, once it checked
 *                    that. A new link's machine id is the one the hello's machine_key proves
 *                    (lib/remote/machine-key.ts), else the reported one (lib/remote/host-links.ts). The reply says the
 *                    link's machine id, and closed: true once the room's Claude was stopped (the room closed), for
 *                    sub-human doctor on a link that stopped before it
 *       Every op but hello reads the link's record again: gone (a kick, in any process) is AUTH LINK_REVOKED, the
 *       streams end and the connection closes. A hello with a revoked link's token is AUTH LINK_REVOKED (host-links.ts
 *       wasRevoked), not TOKEN_UNKNOWN.
 *         join       {name, role: 'member', pubkey, proof}: hostLinks.checkSeatProof, bindSeat, then lib/seats.ts enter() with
 *                    machine = the link's (no pid: the seat lives by its lease), and over a login link, when the room's
 *                    option login-same-person is on (lib/room/options.ts), account = this machine's id in the room (the
 *                    host account's own seat: one person with the host's seats, lib/proposal.ts create); a key other
 *                    than the pinned one is AUTH; a refused seat gives the binding back (no seat without a link)
 *         leave      seats.exit(), own seat only
 *         beat       store.members.beat(name, {presence?}), own seat only; then seats.back (a lapsed seat rejoined)
 *         append     own `from` only; the seat's quota (append.human / append.agent, counted in the log);
 *                    store.place() (validate, rate, replay, verify against the pinned key); a
 *                    signoff or objection is followed by lib/proposal.ts decide() (host only, idempotent). A system
 *                    kind from a link is AUTH (the host writes those)
 *         subscribe  {after, hash, snapshot?}: hash12 of the host's line `after` must equal hash (store.lineHash),
 *                    else FORK (also for a line before the first this host holds: a host that began from a
 *                    snapshot cannot replay what came before it). snapshot: true with after 0, and a snapshot that
 *                    fits a frame (store.snapshot(); protocol.ts snapshot): event 'snapshot' first, and the lines
 *                    from after its id. Then event 'entry' per line in id order (store.tailer({after}), verbatim), event
 *                    'doc' for members (lib/room/members.ts publicView), presence/NAME and tasks when they
 *                    change (all three at the start), 'end' {reason: 'closed'} when the room's Claude is stopped
 *                    or {reason: 'FORK'} when the host log is reset, or {reason: 'AUTH', message} when the
 *                    host revoked the link (the link's record gone, seen on the watch or at the next op: held(); and
 *                    revoked(), on the serve's SIGTERM). It follows the room's watch
 *                    (store.watch, lib/room/watch.ts: fs.watch and a FOLLOW_SLOW_MS poll; a store without one is polled
 *                    every FOLLOW_POLL_MS), reads a changed document alone, and sends a replay REPLAY_BATCH lines per
 *                    turn, waiting for the transport to drain (transport.writable), until the transport closes
 *         blob.get   store.blobs.get(ref), base64;  blob.put  {name, bytes}: name must be plans/<hash12>.md of
 *                    the bytes (content-addressed, at most PROPOSAL_FILE_MAX), written once; a new one counts against
 *                    the link's blob.put quota
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
 *                    carried caps {ping: true} and that then sends no frame for silentMs (LINK_SILENT_MS) is closed:
 *                    the peer is gone (a half-open link after a sleep). A web session (via ws) that has made no
 *                    link within authMs (LINK_AUTH_WAIT_MS, 10 s) of its start is closed: a Noise handshake anyone
 *                    can make holds a serve process no longer
 *       Quotas (lib/config.ts LINK_QUOTAS, lib/remote/quota.ts): before each op, its count: hello per connection (and
 *       per link once it has one), join and leave (seat), subscribe and a new blob.put per link in the host document
 *       remote/quota, beat, blob.get, ping and handoff.* per connection; over one is RATE QUOTA.
 *       After a write (join, leave, beat, append) every stream of the session is ticked before the reply goes out,
 *       so a link that subscribed holds the write's lines and documents when its reply arrives (read-your-writes).
 *       An op that throws a RoomError (a protocol CODES code) answers {error: {code, message, reason?}} with the same
 *       code and typed reason (lib/reasons.ts); any other error is INVALID with the message and is logged. A frame that is not a request is
 *       answered PROTOCOL. close() ends the streams and the transport.
 */

import crypto from 'node:crypto';
import * as protocol from './protocol.ts';
import * as invites from './invites.ts';
import * as hostLinks from './host-links.ts';
import * as quota from './quota.ts';
import * as machineKey from './machine-key.ts';
import * as inviteSecret from './invite-secret.ts';
import * as seats from '../seats.ts';
import * as proposal from '../proposal.ts';
import * as handoff from '../handoff.ts';
import * as members from '../room/members.ts';
import * as envelope from '../room/envelope.ts';
import * as room from '../room.ts';
import { RoomError, hash12 } from '../room/store.ts';
import type { ReasonFor } from '../reasons.ts';
import { reasonOf } from '../reasons.ts';
import { errCode, msgOf, stackOf } from '../errors.ts';
import { machineIn } from '../home.ts';
import * as options from '../room/options.ts';
import { isObj } from '../decode.ts';
import {
  FOLLOW_POLL_MS, REPLAY_BATCH, PROPOSAL_FILE_MAX, LINK_SILENT_MS, LINK_FRAME_MAX_BYTES, LINK_AUTH_WAIT_MS,
} from '../config.ts';
import type {
  DecodedFrame, ErrorFrame, EventData, EventName, FrameId, IncomingRequest, LinkRecord, Op, OpResults, ProtoRange, WireParams,
} from './types-core.ts';
import type { Transport } from './types-rest.ts';
import type { Members, Payload, PresenceInput, RoomStore, SnapshotWire } from '../room/types.ts';
import type { Change } from '../room/watch.ts';
import type { RoomCode, SeatName, MachineId, LinkToken } from '../brand.ts';
import { isSeatName, isMachineId } from '../text.ts';

type Log = (msg: string) => void;
/** What hello's credential gives: the link (null: answered, but still unauthenticated) and a new token, once. */
interface Credential { link: LinkRecord | null; token?: LinkToken }
/** A subscribe stream of a session. */
interface Stream { tick(): void; stop(): void; end(reason: EventData['end']['reason'], message?: string): void }
/** Each op's handler: the session, the request's params (as the peer sent them: each field checked before use) and
 * its id. */
type OpHandlers = { [K in Op]: (s: Session, params: WireParams<K>, id: FrameId | undefined) => OpResults[K] };

const ANSWERS = new Set(['signoff', 'objection']);
const WRITES = new Set(['join', 'leave', 'beat', 'append', 'handoff.accept', 'handoff.refuse']);
const WHILE_MOVED = new Set(['hello', 'subscribe', 'blob.get', 'ping']); // what a host the room moved away from still serves
const epochOf = (store: RoomStore): number => store.hostState().epoch;
const stale = (msg: string, reason: ReasonFor<'STALE'> = 'MOVED_AWAY'): RoomError => new RoomError('STALE', msg, reason);
const authError = (msg: string, reason: ReasonFor<'AUTH'> | null = null): RoomError => new RoomError('AUTH', msg, reason);
const invalid = (msg: string): RoomError => new RoomError('INVALID', msg);

/** name is a seat of this link (one it joined): AUTH NOT_JOINED otherwise. */
function own(s: Session, name: unknown): asserts name is SeatName {
  // a link's seats are seat names: join binds only one
  if (!isSeatName(name) || !hostLinks.mayWriteAs(s.link, name)) throw authError(`${String(name)} has not joined over this link`, 'NOT_JOINED');
}

function redeem(s: Session, invite: unknown, machine: MachineId, pin: unknown, proven: MachineId | null, as: unknown): Credential {
  const { store, linkId } = s;
  const word = inviteSecret.decode(invite);
  const asked = as && typeof as === 'object' && typeof (as as { name?: unknown }).name === 'string'
    ? { name: (as as { name: string }).name, label: String((as as { label?: unknown }).label ?? '') } : null;
  let secret: string;
  const opts = { machine, pin, proven, peerKey: s.peer, as: asked, ...(s.login ? (linkId ? { newId: linkId } : {}) : linkId ? { reserved: linkId } : {}) }; // login: a linkId (serve checks)
  if (word) { // an invite line's SECRET (protocol 3)
    const skew = () => new RoomError('PROTOCOL', protocol.skewMessage({ host: { version: s.version, proto: s.proto }, joiner: s.peerVersion || { version: null, proto: { min: 1, max: s.v ?? 1 } }, need: 3 }), 'SKEW');
    if ((s.v ?? 0) < 3) throw skew();
    if (s.via === 'ws' && !s.peer) throw skew(); // over the web protocol 3 is XK, a key of the link's own: NK is an older joiner's
    secret = inviteSecret.idOf(word.secret);
  } else {
    const inv = invites.parseInvite(invite);
    if (!inv || inv.code !== store.code) throw authError(`not an invite to room ${store.code}`, 'INVITE_UNKNOWN');
    secret = inv.secret;
  }
  let r: ReturnType<typeof invites.redeemInvite>;
  try {
    r = invites.redeemInvite(store, secret, opts);
  } catch (e) {
    if (e instanceof RoomError && e.note) roomLine(s, e.note); // an invite's PIN tries
    throw e;
  }
  if (r.admission) roomLine(s, `${r.admission.name}'s machine (${r.admission.label || machine}) joined the room, let in by ${r.admission.admitted_by || 'the host'}; undo with: /sub-human kick ${r.admission.name}`);
  else if (r.handoff) roomLine(s, `a machine (${machine}) followed the room here with the invite its handoff gave it (link ${r.link.id})`);
  else roomLine(s, `a machine (${machine}) linked to the room with an invite and its PIN (link ${r.link.id})`);
  return r;
}

/** A line in the room from the room itself (via system), best effort: what the host should know about its links. */
const roomLine = (s: Session, text: string): void => room.roomLine(s.store, text, msg => s.log(`sub-human serve: ${msg}`));

/** hello {login: true}: a new link for a connection over the host account's own ssh login (Session.login), else AUTH. */
function viaLogin(s: Session, machine: MachineId, proven: MachineId | null): Credential {
  if (!s.login || !s.linkId) {
    throw authError(`this connection did not arrive over the host account's own ssh login${s.linkId ? ` (it came through a key that was let in for one other connection, and reaches only that one)` : ''}; join with an invite instead (/sub-human invite on the host)`, 'LOGIN_ONLY');
  }
  const r = hostLinks.loginLink(s.store, { id: s.linkId, machine, proven }); // linkId: checked above
  roomLine(s, 'a machine linked over your SSH login');
  return r;
}

/** What a revoked link's machine is told, at hello and when its connection ends. */
const revokedText = (code: RoomCode): string => `the host removed this machine from room ${code} (/sub-human kick); ask them for a new invite`;

function known(s: Session, token: unknown): Credential {
  const link = hostLinks.verifyToken(s.store, token);
  if (!link && hostLinks.wasRevoked(s.store, token)) throw authError(revokedText(s.store.code), 'LINK_REVOKED');
  if (!link) throw authError('unknown link token; ask the host for a new invite', 'TOKEN_UNKNOWN');
  if (s.linkId && link.id !== s.linkId) throw authError(`this token is not link ${s.linkId}'s`, 'TOKEN_UNKNOWN');
  // a web link made under protocol 3 is its Noise key: its token alone, or another key, gets nowhere
  if (!hostLinks.keyHolds(link, s.peer)) throw authError('this link is bound to its own key, and this connection did not prove it; join again with a new invite', 'KEY_MISMATCH');
  return { link };
}

// ---------- the subscribe stream ----------
/** The host documents a mirror holds, as other machines may see them: key -> value. keys: only those (null: every one). */
function docsOf(store: RoomStore, keys: ReadonlySet<string> | null = null): Map<string, unknown> {
  const docs = new Map<string, unknown>();
  const want = (k: string) => !keys || keys.has(k);
  if (want('members')) docs.set('members', members.publicView(store.members.read()));
  if (want('tasks')) docs.set('tasks', store.kv.get('tasks'));
  if (!keys) for (const k of store.kv.list('presence/')) docs.set(k, store.kv.get(k));
  else for (const k of keys) if (k.startsWith('presence/')) docs.set(k, store.kv.get(k)); // gone: null
  return docs;
}
const stopped = (ms: Members): boolean => !!(ms.claude && ms.claude.stopped_at);
/** The documents whose change can move the room (closed, a handoff) besides a log line. */
const MOVES: ReadonlySet<string> = new Set(['members', 'remote/handoff']);

/**
 * Stream subscribe request `id`'s events from the line after `after` (with snap: the snapshot first, then the lines
 * after its id). The room's own watch (store.watch, lib/room/watch.ts: fs.watch, and a slow poll for a missed event)
 * says what changed: a log line is sent, a changed document is read again and sent when it differs; a store with no
 * watch is polled every FOLLOW_POLL_MS. A replay (the first sync, or a long gap) goes out REPLAY_BATCH lines per turn,
 * waiting for the transport to drain between batches; tick(true) (after a write: read-your-writes) sends everything now.
 */
function stream(s: Session, id: FrameId | undefined, after: number, snap: SnapshotWire | null = null): Stream {
  if (snap) after = snap.id;
  const tailer = s.store.tailer({ after });
  const sent = new Map<string, string>(); // doc key -> the JSON last sent
  const priv = { lastId: after }; // the private events sent (lib/handoff.ts streamEvent)
  const queue: string[] = []; // lines read, not sent yet
  let wasStopped = stopped(s.store.members.read());
  let draining: NodeJS.Timeout | NodeJS.Immediate | null = null, stopped_ = false;
  const send = <E extends EventName>(ev: E, data: EventData[E]) => s.transport.send(protocol.event(id as FrameId, ev, data)); // (as: a request with no id gets events with none)
  const end = (reason: EventData['end']['reason'], message?: string) => { flushAll(); send('end', { reason, ...(message ? { message } : {}) }); stop(); };

  function sendDocs(docs: Map<string, unknown>, all: boolean) {
    for (const key of all ? new Set([...sent.keys(), ...docs.keys()]) : docs.keys()) {
      const value = docs.has(key) ? docs.get(key) : null;
      const json = JSON.stringify(value);
      if (sent.get(key) !== json) { sent.set(key, json); send('doc', { key, value }); }
    }
  }
  const flushAll = () => { for (const line of queue.splice(0)) send('entry', line); };
  /** One batch of the queued lines; the next once the transport drained (backpressure on a replay). */
  function drain() {
    draining = null;
    if (stopped_) return;
    if (typeof s.transport.writable === 'function' && !s.transport.writable()) { draining = setTimeout(drain, 10); return; }
    for (const line of queue.splice(0, REPLAY_BATCH)) send('entry', line);
    if (queue.length) draining = setImmediate(drain);
  }
  function tick(change: Change | null, now = false): void {
    // the link's record gone (a kick, in any process): the stream ends AUTH and the connection closes (s.held). Read on
    // every tick, before anything else: a watch event for the links document may be missed, and the room closing
    // (the kick took its last seat) must not end the stream as 'closed' first
    if (!s.held()) return;
    let moved = !change || change.log;
    if (!change || change.log) {
      const { lines, entries, reset } = tailer.poll();
      if (reset) return end('FORK');
      queue.push(...lines);
      for (const e of entries) if (e.id > priv.lastId) priv.lastId = e.id;
    }
    if (now) flushAll();
    else if (queue.length && !draining) drain();
    const keys = change ? new Set([...change.docs].filter(k => k === 'members' || k === 'tasks' || k.startsWith('presence/'))) : null;
    if (!keys || keys.size) sendDocs(docsOf(s.store, keys), !keys);
    if (change && [...change.docs].some(k => MOVES.has(k))) moved = true;
    if (!moved) return;
    const p = handoff.streamEvent(s.store, s.link, priv);
    if (p) { send(p.ev, p.data); if (p.end) return end('moved'); }
    const isStopped = stopped(s.store.members.read());
    if (isStopped && !wasStopped) return end('closed');
    wasStopped = isStopped;
  }
  const safeTick = (change: Change | null, now = false) => { try { tick(change, now); } catch (e) { s.log(`sub-human serve: subscribe: ${stackOf(e)}`); } };
  const first = setImmediate(() => { if (snap) send('snapshot', snap); safeTick(null); }); // after the subscribe reply
  const unwatch = typeof s.store.watch === 'function' ? s.store.watch(c => safeTick(c)) : null;
  const timer = unwatch ? null : setInterval(() => safeTick(null), FOLLOW_POLL_MS);
  const self: Stream = { tick: () => safeTick(null, true), stop, end };
  function stop() {
    stopped_ = true;
    clearImmediate(first);
    if (timer) clearInterval(timer);
    if (unwatch) unwatch();
    if (draining) { clearTimeout(draining as NodeJS.Timeout); clearImmediate(draining as NodeJS.Immediate); }
    s.streams.delete(self);
  }
  return self;
}

/** The snapshot as the wire carries it, when its event fits one frame (else the whole log is replayed, as to anyone). */
function fits(id: FrameId | undefined, held: (SnapshotWire & { held: number }) | null): SnapshotWire | null {
  if (!held) return null;
  const { held: _, ...wire } = held;
  return Buffer.byteLength(protocol.encode(protocol.event(id as FrameId, 'snapshot', wire))) < LINK_FRAME_MAX_BYTES ? wire : null;
}

// ---------- ops ----------
const OPS: OpHandlers = {
  hello(s, params) {
    const { machine, token, invite, pin, caps, epoch, nonce, as } = params;
    const theirs = protocol.rangeOf(params);
    const client = typeof params.client === 'string' ? params.client.slice(0, 32) : null;
    if (!theirs) throw new RoomError('PROTOCOL', `this hello names no protocol range (a sub-human before 0.5${client ? `: ${client}` : ''}): update it (/plugin update sub-human)`, 'SKEW');
    const v = protocol.negotiate(s.proto, theirs);
    if (v === null || v < (typeof params.v === 'number' && Number.isInteger(params.v) ? params.v : 1)) {
      throw new RoomError('PROTOCOL', protocol.skewMessage({ host: { version: s.version, proto: s.proto }, joiner: { version: client, proto: theirs } }), 'SKEW');
    }
    if (!isMachineId(machine)) throw invalid('hello needs this machine\'s id');
    const mine = epochOf(s.store);
    if (typeof epoch === 'number' && Number.isInteger(epoch) && epoch > mine) {
      throw stale(`room ${s.store.code} has moved away from this machine to a newer host. Run /sub-human doctor to see where it is`);
    }
    s.link = null;
    s.v = v;
    s.peerVersion = { version: client, proto: theirs };
    // the id its machine key gives (else only reported): over the challenge this session's hello before handed out
    // (an invite line's hello must be so bound: a proof a former host saw is no good in another session), else, for a
    // token's or a login's hello, a fresh ts
    const bound = machineKey.verifyFor(params.machine_key, s.store.code, s.challenge);
    const proven = bound || (inviteSecret.decode(invite) ? null : machineKey.verify(params.machine_key, s.store.code));
    // nonce: the host home's machine key proves itself first, so a joiner sends an invite line's secret only after
    const host = v >= 3 && typeof nonce === 'string' && machineKey.NONCE_RE.test(nonce) ? machineKey.hostProof(s.store.code, nonce) : null;
    const r: Credential = invite !== undefined ? redeem(s, invite, machine, pin, proven, as) : token !== undefined ? known(s, token)
      : params.login === true ? viaLogin(s, machine, proven) : { link: null };
    s.link = r.link;
    if (isObj(caps) && caps.ping === true) s.expireSilent();
    // time: the host's clock (ms), so a joiner (sub-human doctor) can measure the skew that SIG_SKEW_MS bounds; additive
    const out: OpResults['hello'] = { v, proto: s.proto, server: s.version, caps: protocol.CAPS, room: s.store.code, link: r.link ? r.link.id : null, epoch: mine, time: Date.now() };
    if (r.link) out.machine = r.link.machine; // additive: this machine's id in the room, as the host records it
    if (host) out.host = host;
    // a fresh challenge for this session's next hello (a refused hello keeps the one the joiner holds)
    s.challenge = v >= 3 ? crypto.randomBytes(18).toString('base64url') : null;
    if (s.challenge) out.challenge = s.challenge;
    if (r.token) out.token = r.token;
    // the one name the card let in (maybe not the one asked for: lib/remote/admission.ts taken), so the joiner's seat takes it
    const [only] = r.link ? r.link.seats : [];
    if (r.token && r.link && r.link.bound && r.link.seats.length === 1 && only !== undefined) out.as = only;
    if (stopped(s.store.members.read())) out.closed = true; // additive: an older host says nothing
    return out;
  },

  join(s, { name, role = 'member', pubkey, proof, log_v }) {
    if (role !== 'member') throw invalid('a link joins members only');
    if (typeof pubkey !== 'string' || !envelope.parseKey(pubkey)) throw invalid('join needs the seat\'s public key (Ed25519 SPKI PEM)');
    hostLinks.checkSeatProof(proof, { room: s.store.code, name, pubkey });
    // a proof signed for a name that is no seat name: refused as identity.join would refuse it, before any binding
    if (typeof name !== 'string') throw invalid(`invalid name "${String(name)}" (letters, digits, . _ -, up to 32)`);
    // s.link: run() lets no op but hello in without it. A bound link (the card let one name in; a handoff's seats) joins
    // its own seats only, before any seat is taken. A login link is the host account's own: its seat is that person's
    const link = s.linked();
    if (!hostLinks.mayJoinAs(link, name)) throw authError(hostLinks.notBound(link, name), 'NOT_BOUND');
    if (!isSeatName(name)) throw invalid(`invalid name "${name}" (letters, digits, . _ -, up to 32)`); // as identity.join says
    // a login link's seat is the host person's own (one person with the host's seats) only where the room says so
    const account = link.login && options.loginSamePerson(s.store) ? machineIn(s.store.code) ?? undefined : undefined;
    // bound first: a link revoked meanwhile is AUTH LINK_REVOKED before any seat exists (no seat with no link); a seat
    // then refused gives the binding back
    const had = link.seats.includes(name);
    s.link = hostLinks.bindSeat(s.store, link.id, name);
    let r: ReturnType<typeof seats.enter>;
    try {
      r = seats.enter({ code: s.store.code, name, machine: s.link.machine, pubkey, ...(account ? { account } : {}), ...(typeof log_v === 'number' ? { log_v } : {}) });
    } catch (e) { if (!had) hostLinks.unbindSeat(s.store, s.link.id, name); throw e; }
    if (!r.ok) {
      if (!had) { hostLinks.unbindSeat(s.store, s.link.id, name); s.held(); }
      throw new RoomError(r.code || 'INVALID', r.error);
    }
    return r.rejoin ? { ok: true, rejoin: true } : { ok: true };
  },

  leave(s, { name, reason = 'left' }) {
    own(s, name);
    if (typeof reason !== 'string') throw invalid('reason must be a string');
    return { ok: seats.exit(s.store.code, name, reason) };
  },

  beat(s, { name, presence }) {
    own(s, name);
    const ok = s.store.members.beat(name, { presence: presence as PresenceInput | undefined }); // beat checks it (presenceDoc)
    if (ok) seats.back(s.store.code, name); // a seat that lapsed (seats.sweep) is back: "NAME rejoined"
    return { ok };
  },

  append(s, { payload, epoch }) {
    if (!isObj(payload)) throw invalid('append needs {payload}');
    const mine = epochOf(s.store);
    if (typeof epoch === 'number' && Number.isInteger(epoch) && epoch !== mine) {
      throw epoch < mine ? stale(`room ${s.store.code} changed hosts and this machine hasn't caught up yet; try again in a moment`, 'BEHIND')
        : stale(`room ${s.store.code} has moved away from this machine to a newer host. Run /sub-human doctor to see where it is`);
    }
    own(s, payload.from);
    if (payload.via === 'system') throw authError('a link never writes via "system"; the host writes the room\'s own entries');
    if (payload.via === 'human' || payload.via === 'agent') quota.checkLog(s.store.readAll(), { from: payload.from, via: payload.via, op: payload.via === 'human' ? 'append.human' : 'append.agent' });
    const entry = s.store.place(payload as Partial<Payload> as Payload); // place() checks every field (rules.ts admit, validate.ts)
    if (ANSWERS.has(entry.kind) && entry.proposal_hash) {
      try { proposal.decide(s.store.code, entry.proposal_hash); } catch (e) { s.log(`sub-human serve: decide: ${stackOf(e)}`); }
    }
    return { entry };
  },

  subscribe(s, { after, hash, snapshot }, id) {
    if (typeof after !== 'number' || !Number.isInteger(after) || after < 0) throw invalid('subscribe needs {after: id, hash}');
    if (s.store.lineHash(after) !== hash) {
      throw new RoomError('FORK', `the host's line ${after} is not the mirror's; re-mirror with sub-human link --reset ${s.store.code}`, 'NOT_CHAINED');
    }
    const held = s.store.snapshot();
    const snap = snapshot === true && after === 0 ? fits(id, held) : null;
    if (!snap && held && after < held.held - 1) {
      throw new RoomError('FORK', `this host holds room ${s.store.code}'s log only from line ${held.held - 1} (it began from its host's snapshot) and cannot replay the lines before; update sub-human on this machine, then sub-human link --reset ${s.store.code}`, 'NOT_CHAINED');
    }
    for (const st of [...s.streams]) st.stop(); // one stream per connection: a new subscribe replaces the old (each is a poller)
    s.streams.add(stream(s, id, after, snap));
    return { ok: true };
  },

  'blob.get'(s, { ref }) {
    const b = typeof ref === 'string' ? s.store.blobs.get(ref) : null; // blobs.get refuses any other ref (blobRef)
    return { bytes: b ? b.toString('base64') : null };
  },

  'handoff.accept'(s, params) {
    const r = handoff.serverAccept(s.store, s.linked(), params);
    s.later = () => handoff.afterMoved(s.store, { job: r.job });
    return { ok: true, epoch: r.epoch, entry: r.entry };
  },

  'handoff.refuse'(s, params) { return handoff.serverRefuse(s.store, s.linked(), params); },

  'blob.put'(s, { name, bytes }) {
    if (typeof bytes !== 'string') throw invalid('blob.put needs {name, bytes: base64}');
    const buf = Buffer.from(bytes, 'base64');
    if (buf.length > PROPOSAL_FILE_MAX) throw invalid(`a blob is at most ${PROPOSAL_FILE_MAX} bytes`);
    if (name !== `plans/${hash12(buf)}.md`) throw invalid('a blob is named by its content: plans/<hash12 of the bytes>.md');
    if (s.store.blobs.has(name)) return { ref: name };
    quota.charge(s.store, s.linked().id, 'blob.put');
    s.store.blobs.put(name, buf);
    return { ref: name };
  },

  ping() { return { pong: Date.now() }; },
};

/** One op's handler on the params as they came (an object; WireParams: every field unknown until the op checks it). */
const call = <O extends Op>(op: O, s: Session, params: WireParams<O>, id: FrameId | undefined): OpResults[O] => OPS[op](s, params, id);

// ---------- the session ----------
class Session {
  transport: Transport;
  login: boolean;
  /** 'ws': the connection came through the web listener; null: ssh or a pipe */
  via: 'ws' | null;
  /** the Noise key the web connection proved (XK); null for NK, ssh and a pipe */
  peer: string | null;
  /** the peer's plugin version and range, as its hello said (for a skew message) */
  peerVersion: { version: string | null; proto: ProtoRange } | null = null;
  store: RoomStore;
  log: Log;
  linkId: string | null;
  proto: ProtoRange;
  version: string;
  v: number | null;
  link: LinkRecord | null;
  later: (() => void) | null;
  streams: Set<Stream>;
  quota: ReturnType<typeof quota.session>;
  silentMs: number;
  heard: number;
  silence: NodeJS.Timeout | null;
  unlinked: NodeJS.Timeout | null = null;
  /** the challenge the last hello's reply handed out: the next hello's machine proof signs it (machine-key.ts proofFor) */
  challenge: string | null = null;
  constructor(transport: Transport, store: RoomStore, log: Log, linkId: string | null | undefined, silentMs: number, {
    proto = protocol.PROTO, version = protocol.PLUGIN_VERSION, login = false, via = null, peer = null,
  }: { proto?: ProtoRange | undefined; version?: string | undefined; login?: boolean; via?: 'ws' | null; peer?: string | null } = {}) {
    this.transport = transport;
    this.login = login === true;
    this.via = via;
    this.peer = peer;
    this.store = store;
    this.log = log;
    this.linkId = linkId || null;
    this.proto = proto;
    this.version = version;
    this.v = null; // the version hello chose
    this.link = null;
    this.later = null; // work an op leaves for after its reply (handoff.accept)
    this.streams = new Set(); // {tick, stop}
    this.quota = quota.session();
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
    if (later) setImmediate(() => { try { later(); } catch (e) { this.log(`sub-human serve: after ${f.op}: ${stackOf(e)}`); } });
  }

  run({ id, op, params }: IncomingRequest): unknown {
    if (!protocol.isOp(op)) throw new RoomError('PROTOCOL', `unknown op "${op}"`);
    if (op !== 'hello' && !this.link) throw authError('say hello with this link\'s token first');
    // every op reads the link's record again: one the host revoked (a kick, in another process) gets nothing more
    if (op !== 'hello' && !this.held()) throw authError(revokedText(this.store.code), 'LINK_REVOKED');
    if (!WHILE_MOVED.has(op) && handoff.movedAway(this.store)) {
      const host = this.store.hostState?.().host; // movedAway: only a store with hostState moves
      throw stale(`room ${this.store.code} moved to ${host}'s machine; this machine takes no more messages for it`);
    }
    this.charge(op);
    const out = call(op, this, isObj(params) ? params : {}, id);
    if (op === 'hello' && this.link) quota.charge(this.store, this.link.id, 'hello'); // a link's hellos, across reconnects
    return out;
  }

  /** The op's quota (lib/config.ts LINK_QUOTAS) before it runs: RATE QUOTA when this connection or link is over. append
   * counts the seat's own lines in the op; blob.put only a new blob, in the op. */
  charge(op: string): void {
    const take = (q: quota.QuotaOp) => this.quota.take(q);
    const link = (q: quota.QuotaOp) => quota.charge(this.store, this.linked().id, q); // every op but hello runs with a link
    if (op === 'hello') take('hello.session');
    else if (op === 'join' || op === 'leave') link('seat');
    else if (op === 'subscribe') link('subscribe');
    else if (op === 'beat' || op === 'blob.get' || op === 'ping') take(op);
    else if (op === 'handoff.accept' || op === 'handoff.refuse') take('handoff');
  }

  failure(f: IncomingRequest, err: unknown): ErrorFrame {
    const code = errCode(err); // anything an op threw
    if (protocol.isWireCode(code)) return protocol.error(f.id, code, msgOf(err), reasonOf(err));
    this.log(`sub-human serve: ${f.op}: ${stackOf(err)}`);
    return protocol.error(f.id, 'INVALID', msgOf(err) || String(err));
  }

  /** True when the host revoked this session's link (its record is gone): every stream then ends {reason: 'AUTH'},
   * so the daemon stops with the reason instead of redialing a key that no longer gets in (`/sub-human kick`
   * stops this serve with SIGTERM: scripts/sub-human serve calls this first). */
  revoked(): boolean {
    if (!this.link || (this.store.kv.get(hostLinks.LINKS_KEY, null) || {})[this.link.id]) return false;
    this.endRevoked();
    return true;
  }

  /** The session's link as the host's record has it now (a seat bound since, in another connection), true; false when
   * the record is gone: the streams end AUTH with the reason and the connection closes a moment later (whatever
   * process the kick ran in: pipe and web serves name no link in their argv). No link yet: true. */
  /** This session's link: run() lets no op but hello in without one. */
  linked(): LinkRecord {
    if (!this.link) throw authError('say hello with this link\'s token first');
    return this.link;
  }

  held(): boolean {
    if (!this.link) return true;
    const cur = hostLinks.links(this.store)[this.link.id];
    if (cur) { this.link = cur; return true; }
    if (handoff.movedAway(this.store)) return true; // a demote clears the links with the room: the stream says 'moved'
    this.endRevoked();
    return false;
  }

  revokedEnded = false;
  endRevoked(): void {
    if (this.revokedEnded) return;
    this.revokedEnded = true;
    for (const st of [...this.streams]) st.end('AUTH', revokedText(this.store.code));
    // the reply that says so goes out first; then nothing is left for this connection
    setTimeout(() => { this.stop(); this.transport.close(); }, 200).unref();
  }

  /** A web session closes unless a hello made it a link within ms (anyone can complete a Noise handshake). */
  expireUnlinked(ms: number): void {
    if (!(ms > 0)) return;
    this.unlinked = setTimeout(() => {
      if (this.link) return;
      this.log(`sub-human serve: no link ${ms} ms after the connection began; closing it`);
      this.stop();
      this.transport.close();
    }, ms);
    this.unlinked.unref();
  }

  stop(): void {
    clearInterval(this.silence ?? undefined);
    this.silence = null;
    clearTimeout(this.unlinked ?? undefined);
    this.unlinked = null;
    for (const st of [...this.streams]) st.stop();
  }
}

/**
 * @param {{send(frame: object): void, onFrame(fn: (frame: object) => void): void, onClose(fn: () => void): void, close(): void}} transport
 * @param {{store: import('../room/store.ts').FsRoomStore, log?: (...a: any[]) => void, linkId?: string, login?: boolean, via?: 'ws' | null, peer?: string | null, silentMs?: number, proto?: {min: number, max: number}, version?: string}} ctx
 * @returns {{close(): void}}
 */
function serve(transport: Transport, { store, log = () => {}, linkId, login = false, via = null, peer = null, silentMs = LINK_SILENT_MS, authMs = LINK_AUTH_WAIT_MS, proto, version }: {
  store: RoomStore; log?: Log; linkId?: string | undefined; login?: boolean; via?: 'ws' | null; peer?: string | null; silentMs?: number; authMs?: number; proto?: ProtoRange | undefined; version?: string | undefined;
}): { close(): void; revoked(): boolean } {
  const session = new Session(transport, store, log, linkId, silentMs, { proto, version, login, via, peer });
  if (via === 'ws') session.expireUnlinked(authMs);
  return { close() { session.stop(); transport.close(); }, revoked: () => session.revoked() };
}

export { serve };
