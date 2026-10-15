/**
 * plugin/sub-human/lib/handoff.ts: moving a room's host to another member's machine. The host's machine holds the
 * room's log, serves its links and runs its room Claude (billed to the host person's model account); a planned handoff
 * moves all three before the host closes their laptop. There is no automatic failover (it would split the room);
 * `promote` is the manual way out when the host is gone for good, and it can fork.
 *
 * Authority is the log's: a host_changed entry (via system, lib/room/validate.ts) {epoch, host, machine, locator,
 * accept?, ask?, promoted?} moves it; store.hostState() reads the last one (epoch 0 before any). The old host's
 * FsRoomStore takes no more lines once its log says the room moved (STALE), a server refuses a hello from a mirror
 * at a later epoch than its own and an append from another epoch (STALE, lib/remote/server.ts), so a stale host and
 * a stale copy are refused, never merged.
 *
 * A planned handoff, A (the host, person `from`) to B (person `to`, on another machine, linked), C following:
 *   1. ask (A: `/sub-human handoff B` or `sub-human handoff B`): the host document remote/handoff (host-only, never
 *      streamed) {id, state: 'asked', from, to, epoch: next, locator?, ask?, at, expires_at}. A's server sends it to
 *      B's link only, as a private 'handoff' event (lib/remote/protocol.ts); B's daemon keeps it in B's mirror
 *      (onAsk: the session-local document `handoff`); B's tail wakes B's Claude, which opens the card.
 *   2. the card (hooks/handlers/consent.ts, AskUserQuestion; only B's own answer on the card as the hooks built it counts):
 *      it says the room's Claude then runs on B's model account (billing, rate limits) and that B's machine must stay
 *      reachable. "Not now": refuse (op handoff.refuse; A's tail tells the asker). "Host it here": accept.
 *   3. accept (B's hook): mints one single-use invite to B per other machine with a seat in the room (A's included;
 *      invites.mintFor: bound to that machine, its seats pre-bound), signs {kind: 'host_accept', id, epoch, locator}
 *      with B's seat key, and sends op handoff.accept. A's server (serverAccept) checks the ask, the signature
 *      against B's pinned key and the invites, appends host_changed (from A's seat, with B's signed acceptance and
 *      A's signed ask when the hook made it), marks the room's Claude left and the document 'moved' with the invites; after
 *      the reply (afterMoved) it stops A's room Claude job and turns A into a mirror of B (a link file holding A's invite,
 *      its daemon started).
 *   4. B, once the reply is back (its mirror holds host_changed: read-your-writes): takeOver: the chain checked, its
 *      daemon stopped, the link file removed (B's store is an FsRoomStore now), its seats' local fields back from the
 *      session indexes, the old room Claude record retired, the room's Claude started here (lib/seats.ts ensureRoomClaude).
 *   5. every other link of A gets a private 'moved' event after the host_changed line, with its machine's invite
 *      (A's server, streamEvent); its daemon (onMoved) re-points its link file at B and reconnects. A member offline
 *      during the handoff gets it when it reconnects to A, as long as A is up (HANDOFF_INVITE_MS). A member that
 *      cannot reach B stays offline with a reason that says what to do (whyOffline); nothing hangs.
 *
 *   ask(code, {from, to, locator?, sign?, now?}) -> doc        host only. sign(payload) -> signed (the hook's seat
 *       key): doc.ask = sign({kind: 'host_ask', id, epoch, to, locator}). RoomError INVALID / OFFLINE / HOST_ONLY /
 *       STALE with a reason for the person
 *   hostDoc(store) -> doc | null                               the host document remote/handoff
 *   streamEvent(store, link, sent) -> {ev, data, end?} | null  the next private event for a link's subscribe stream
 *       (lib/remote/server.ts): the ask to the link holding its target, or 'moved' once the host_changed line
 *       (sent.lastId: the last id this stream sent) went out; end: the stream ends after it ({reason: 'moved'})
 *   serverAccept(store, link, {id, accept, locator, invites}) -> {entry, epoch, job}   A's server: see 3
 *   serverRefuse(store, link, {id}) -> {ok}
 *   afterMoved(store, {job}) -> bool                           A's server, after the accept's reply: see 3
 *   movedAway(store) -> bool                                   the log says the room moved to another machine
 *   onAsk(mirror, data), onMoved(mirror, data) -> {self?, stop?, reason}   the link daemon's (lib/remote/link.ts)
 *   whyOffline(code, message) -> string                        the offline reason of a re-pointed link
 *   pendingAsk(code, name, now?) -> ask | null                 B's mirror: the ask waiting for name
 *   markTold(code, id)                                         the tail woke the target's Claude for it
 *   card(ask, code) -> AskUserQuestion input; question(ask, code) -> string; YES, NO
 *   accept(me, {cwd, sign}) -> {ok, epoch?, note?, error?}     B's hook: see 3 and 4
 *   refuse(me) -> {ok, error?}
 *   takeOver(code, {by, cwd, entry?}) -> string                this machine becomes the room's host (see 4);
 *       entry: append it once the store is this machine's (promote)
 *   promote(code, {name, locator?, force?, cwd?, now?}) -> {epoch, entry, invites: [{machine, seats, invite, pin}], note, last}
 *       a member's machine with a full mirror declares itself host at epoch + 1 (the person's own shell,
 *       lib/cli/handoff.ts, after a confirmation): refused while the link is online, or down for less than
 *       PROMOTE_OFFLINE_MS without force. The other machines get sh2 invites with a PIN each, to hand out by hand
 *       (each runs `sub-human demote CODE INVITE PIN` with its own).
 *   demote(code, invite, pin?) -> {orphan, request?, follower?}   a machine follows a promoted room: a member's
 *       machine re-points its link (rebind: its seats join again with /sub-human; follower: true); an old host that
 *       was promoted away sets its log aside (orphaned-<time>.jsonl, kept, never merged), stops its room Claude, and
 *       mirrors the new host
 *   status(code) -> {host: hostState, doc, machines?}          for `sub-human handoff --status`
 *   HOST_DOC, ASK_DOC
 * A next host's locator may be a web one (wss://FRONT/…/sub-human/CODE, `--url`): it serves the room on its listener
 * (lib/remote/webhost.ts serveAt) before it accepts, and every invite it mints pins its listener's X25519 key.
 */

import crypto from 'node:crypto';
import * as store from './room/store.ts';
import * as links from './room/links.ts';
import * as envelope from './room/envelope.ts';
import * as members from './room/members.ts';
import * as invites from './remote/invites.ts';
import * as hostLinks from './remote/host-links.ts';
import { RoomError } from './room/validate.ts';
import { machineId, machineIn, isMine } from './home.ts';
import { isAlive, sleepSync } from './io.ts';
import * as config from './config.ts';
import * as identityMod from './identity.ts';
import * as ioMod from './io.ts';
import { createRequire } from 'node:module';
import type { Card, HandoffAskDoc, HandoffDoc } from './types-app.ts';
import type { Entry, EntryInput, HostProof, HostState, Link, Member, Members } from './room/types.ts';
import type { HandoffAsk, BoundInvite, Invites, LinkRecord, MovedEventData, PrivateEvent } from './remote/types-core.ts';
import type { LinkSpec } from './remote/types-rest.ts';
import type { MirrorRoomStore } from './room/store-mirror.ts';
import type { Identity } from './identity.ts';

const require = createRequire(import.meta.url);

/** A room's store (lib/room/store.ts open): the host's FsRoomStore or a mirror's. */
type Store = ReturnType<typeof store.open>;
/** A link the host's server knows (lib/remote/invites.ts, the host document remote/links): its machine and seats. */
type LinkRec = Pick<LinkRecord, 'machine' | 'seats'>;
/** One signed payload (lib/room/envelope.ts): the hook's seat key signs it. */
type Sign = (payload: Record<string, unknown>) => HostProof;
/** followLink: the link file's transport (null: a locator this machine cannot use) and the ssh admit request. */
interface Follow { transport: LinkSpec | null, request: string | null }
interface Minted { machine: string, seats: string[], invite: string, pin?: string }

const HOST_DOC = 'remote/handoff';
const ASK_DOC = 'handoff';
const WORKDIR = 'workdir';
const YES = 'Host it here';
const NO = 'Not now';
const ID_RE = /^[0-9a-f]{12}$/;
const MACHINE_RE = /^[A-Za-z0-9_-]{1,64}$/;

const iso = (ms: number) => new Date(ms).toISOString();
const err = (code: string, msg: string) => new RoomError(code, msg);
const linkSocket = (): typeof import('./remote/link-socket.ts') => require('./remote/link-socket.ts');
const linkConnect = (): typeof import('./remote/link-connect.ts') => require('./remote/link-connect.ts');
const identity = () => identityMod;
const transportOf = (locator: unknown) => (typeof locator === 'string' ? linkConnect().transportOf(locator) : null);
// A next host reached over the web (wss/ws, lib/remote/transports/ws.ts): its invites pin its listener's X25519 key,
// and the link file that follows one carries that key.
// Over ssh its invites pin its sshd Ed25519 host key (lib/remote/sshkeys.ts hostKey; none when unreadable).
const isWeb = (locator: unknown) => /^wss?:/.test(String(locator));
const hostKeyFor = (locator: string): string | null => (isWeb(locator) ? (require('./remote/listener.ts') as typeof import('./remote/listener.ts')).hostKey()
  : /^ssh:/.test(String(locator)) ? (require('./remote/sshkeys.ts') as typeof import('./remote/sshkeys.ts')).hostKey() : null);
/** This machine's seat name in CODE, for its link key's comment and its admit request. */
const seatName = (code: string): string => { try { return (identity().localSeats(code) as string[]).find(n => n !== 'claude') || 'member'; } catch { return 'member'; } };
/**
 * The link file that follows the room to locator with invite (lib/remote/hosting.ts linkTransport): over ssh this
 * machine's own link key (made if it had none) and its mux kept, the new host's key pinned, and the admit request
 * the new host needs; over the web the listener key the invite pins. {transport: null} for a locator this machine
 * cannot use.
 */
function followLink(code: string, locator: string | undefined, invite: unknown): Follow {
  const inv = typeof invite === 'string' ? invites.parseInvite(invite) : null;
  if (!inv || inv.code !== code || inv.locator !== locator || !transportOf(locator)) return { transport: transportOf(locator), request: null };
  const hosting: typeof import('./remote/hosting.ts') = require('./remote/hosting.ts');
  return hosting.linkTransport({ inv, name: seatName(code), cur: links.get(code) })!; // null only for a locator transportOf refuses
}
/** This machine, about to host CODE at a web locator: its listener up, the room in its served set. */
function serveWeb(code: string, locator: string): void {
  if (isWeb(locator)) (require('./remote/webhost.ts') as typeof import('./remote/webhost.ts')).serveAt(code, locator);
}
const askMs = () => config.envMs('SUB_HUMAN_HANDOFF_ASK_MS', config.HANDOFF_ASK_MS);
const expired = (doc: { expires_at?: string } | null | undefined, now: number = Date.now()) => !(Date.parse((doc && doc.expires_at) as string) > now);

// ---------- the old host ----------
function ask(code: string, { from, to, locator, sign, now = Date.now() }: { from: string, to: string, locator?: string, sign?: Sign, now?: number }): HandoffDoc {
  const s = store.open(code);
  if (!s.isHost) throw err('HOST_ONLY', `room ${code} is hosted on another machine; only its host hands it off`);
  if (movedAway(s)) throw err('STALE', `room ${code} moved to another machine already`);
  const m: Member | undefined = (s.members.read() as Members)[to];
  if (!m || m.left_at || m.role === 'claude') throw err('INVALID', `${to} is not in room ${code}`);
  if (isMine(m.machine || machineId())) throw err('INVALID', `${to} is on this machine; a handoff moves the room to another machine`);
  if (!members.seatAlive(m)) throw err('OFFLINE', `${to} is not online; a handoff needs their answer`);
  const linksNow: Record<string, LinkRec | null> = s.kv.get(hostLinks.LINKS_KEY) || {};
  const linked = Object.values(linksNow).some(l => l && l.machine === m.machine && (l.seats || []).includes(to));
  if (!linked) throw err('INVALID', `${to} is not connected to room ${code} over a link`);
  if (locator !== undefined && !transportOf(locator)) throw err('INVALID', `"${locator}" is not a locator this machine knows (pipe:/HOME, ssh:user@host[:port] or wss://host/…/sub-human/CODE)`);
  const doc: HandoffDoc = { id: crypto.randomBytes(6).toString('hex'), state: 'asked', from, to, epoch: s.hostState().epoch + 1, at: iso(now), expires_at: iso(now + askMs()) };
  if (locator) doc.locator = locator;
  if (sign) doc.ask = sign({ kind: 'host_ask', id: doc.id, epoch: doc.epoch, to, ...(locator ? { locator } : {}) });
  s.kv.set(HOST_DOC, doc);
  return doc;
}

const hostDoc = (s: Store): HandoffDoc | null => { try { return s.kv.get(HOST_DOC); } catch { return null; } };

function movedAway(s: Store): boolean {
  const h: HostState = typeof s.hostState === 'function' ? s.hostState() : { epoch: 0 };
  return !!h.machine && !isMine(h.machine);
}

/** The ask as the target's machine sees it: no signatures, no invites. */
const askView = (d: HandoffAsk): HandoffAsk => ({ id: d.id, from: d.from, to: d.to, epoch: d.epoch, expires_at: d.expires_at, ...(d.locator ? { locator: d.locator } : {}) });

/** sent: what this subscribe stream already sent (the ask's id, the 'moved' event) and the last log id it sent. */
function streamEvent(s: Store, link: LinkRec | null | undefined, sent: { ask?: string, moved?: boolean, lastId: number }): PrivateEvent | null {
  const d = link && hostDoc(s);
  if (!d) return null;
  if (d.state === 'asked' && sent.ask !== d.id && (link.seats || []).includes(d.to) && !expired(d)) {
    sent.ask = d.id;
    return { ev: 'handoff', data: askView(d) };
  }
  // a moved document carries the new host's machine and locator (serverAccept)
  if (d.state === 'moved' && !sent.moved && d.host_id !== undefined && Number.isInteger(d.host_id) && sent.lastId >= d.host_id && d.machine && d.locator) {
    sent.moved = true;
    const invite = (!expired({ expires_at: d.invites_expire_at }) && d.invites && d.invites[link.machine]) || null;
    const data: MovedEventData = { epoch: d.epoch, host: d.to, machine: d.machine, locator: d.locator, invite };
    return { ev: 'moved', data, end: true };
  }
  return null;
}

function checkInvites(code: string, locator: string, given: unknown): asserts given is Record<string, string> {
  if (!given || typeof given !== 'object' || Array.isArray(given)) throw err('INVALID', 'handoff.accept needs {invites: {machine: invite}}');
  for (const [m, inv] of Object.entries(given)) {
    const p = invites.parseInvite(inv);
    if (!MACHINE_RE.test(m) || !p || p.code !== code || p.locator !== locator) throw err('INVALID', `the invite for machine ${m} is not one to room ${code} at ${locator}`);
  }
}

function checkAccept(s: Store, d: HandoffDoc, proof: Record<string, unknown> | null | undefined, locator: string): void {
  const pub = store.publicKey(d.to, s);
  const ok = !!proof && proof.kind === 'host_accept' && proof.room === s.code && proof.from === d.to && proof.id === d.id
    && proof.epoch === d.epoch && proof.locator === locator && envelope.isV2(proof) && envelope.freshTs(proof) && envelope.verify(proof, pub);
  if (!ok) throw err('AUTH', `a handoff needs ${d.to}'s yes, signed with their own key`);
}

/** handoff.accept's params (the next host's hook, over its link). */
interface AcceptParams { id?: string, accept?: Record<string, unknown>, locator?: string, invites?: unknown }
function serverAccept(s: Store, link: LinkRec, { id, accept: proof, locator, invites }: AcceptParams = {}, now: number = Date.now()): { entry: Entry, epoch: number, job: string | null } {
  const d = hostDoc(s);
  if (!d || d.id !== id) throw err('INVALID', 'no such handoff is waiting (it was replaced or withdrawn)');
  if (!hostLinks.mayWriteAs(link, d.to)) throw err('AUTH', `${d.to} has not joined over this link`);
  if (d.state !== 'asked') throw err('INVALID', `this handoff was ${d.state} already`);
  if (expired(d, now)) throw err('INVALID', `the handoff ask expired; ask ${d.from} to hand off again`);
  if (s.hostState().epoch + 1 !== d.epoch) throw err('STALE', 'the room changed hosts since this was asked');
  const loc = d.locator || locator;
  if (!loc || !transportOf(loc)) throw err('INVALID', `"${loc}" is not a locator the host knows`);
  checkAccept(s, d, proof, loc);
  checkInvites(s.code, loc, invites);
  const entry: Entry = s.append({
    kind: 'host_changed', text: `room ${s.code} moved to ${d.to}'s machine; the room's Claude restarts there`,
    epoch: d.epoch, host: d.to, machine: link.machine, locator: loc, accept: proof, ...(d.ask ? { ask: d.ask } : {}),
  }, { via: 'system', from: d.from, system: true });
  let job: string | null = null;
  identity().updateRoomClaude(s.code, (o: Member | null) => {
    if (!o) return null;
    job = o.job && o.job !== 'pending' ? o.job : null;
    return { job: null, claim: undefined, left_at: iso(now), moved_at: iso(now) };
  });
  const rest = { ...invites };
  delete rest[link.machine];
  s.kv.set(HOST_DOC, {
    ...d, state: 'moved', machine: link.machine, locator: loc, host_id: entry.id, moved_at: iso(now),
    invites: rest, invites_expire_at: iso(now + config.HANDOFF_INVITE_MS),
  });
  return { entry, epoch: d.epoch, job };
}

function serverRefuse(s: Store, link: LinkRec, { id }: { id?: string } = {}, now: number = Date.now()): { ok: true } {
  const d = hostDoc(s);
  if (!d || d.id !== id || d.state !== 'asked') throw err('INVALID', 'no such handoff is waiting');
  if (!hostLinks.mayWriteAs(link, d.to)) throw err('AUTH', `${d.to} has not joined over this link`);
  s.kv.set(HOST_DOC, { ...d, state: 'refused', refused_at: iso(now) });
  return { ok: true };
}

/** The old host after its reply: stop its room Claude job, then mirror the new host (a link holding its own invite). */
function afterMoved(s: Store, { job }: { job?: string | null } = {}): boolean {
  if (job) { try { (require('./room-claude.ts') as typeof import('./room-claude.ts')).releaseDetached(s.code, job); } catch { /* the job ends with its session */ } }
  const d = hostDoc(s);
  const me = machineIn(s.code);
  const invite = d && d.invites && me ? d.invites[me] : null;
  if (!d || !invite || !d.locator) return false;
  const f = followLink(s.code, d.locator, invite);
  if (!f.transport) return false;
  links.set(s.code, { code: s.code, transport: f.transport, invite, ...(f.request ? { request: f.request } : {}), created_at: iso(Date.now()), moved: { epoch: d.epoch, host: d.to, locator: d.locator } });
  store.forget(s.code);
  try { return linkSocket().start(s.code); } catch { return false; }
}

// ---------- the link daemon of a mirror ----------
function onAsk(mirror: Store, data: HandoffAsk | null | undefined): void {
  if (!data || !ID_RE.test(String(data.id)) || !Number.isInteger(data.epoch)) return;
  mirror.kv.set(ASK_DOC, { ...askView(data), at: iso(Date.now()) });
}

function onMoved(mirror: Store, data: MovedEventData | null | undefined): { self?: boolean, stop?: boolean, reason: string } {
  const code: string = mirror.code;
  const h: HostState = mirror.hostState();
  if (!data || h.epoch !== data.epoch || h.machine !== data.machine) {
    return { reason: `the host said room ${code} moved, but this machine hasn't received that yet` };
  }
  if (isMine(data.machine)) return { self: true, stop: true, reason: `this machine hosts room ${code} now` };
  const how = `ask ${data.host} for an invite (/sub-human invite, there) and type the line it shows here`;
  if (!data.invite) return { stop: true, reason: `room ${code} moved to ${data.host}'s machine, and no invite came for this machine; ${how}` };
  const cur: Partial<Link> = links.get(code) || {};
  let f: Follow;
  try { f = followLink(code, data.locator, data.invite); } catch (e) { return { stop: true, reason: `room ${code} moved to ${data.host}'s machine, and this machine could not follow it: ${(e as Error).message}; ${how}` }; }
  if (!f.transport) return { stop: true, reason: `room ${code} moved to ${data.host}'s machine at "${data.locator}", which this machine cannot use; ${how}` };
  links.set(code, {
    code, transport: f.transport, invite: data.invite, ...(f.request ? { request: f.request } : {}), created_at: cur.created_at || iso(Date.now()),
    moved: { epoch: data.epoch, host: data.host, locator: data.locator, at: iso(Date.now()) },
  });
  if (cur.token === undefined && cur.invite === undefined) return { reason: 'repointed' };
  return { reason: `room ${code} moved to ${data.host}'s machine; reconnecting there` };
}

function whyOffline(code: string, message: string): string {
  const l = links.get(code);
  if (!l || !l.moved || l.token) return message;
  const admit = l.request ? `Over ssh ${l.moved.host} has not let this machine in yet. ` : '';
  return `room ${code} moved to ${l.moved.host}'s machine, which this machine can't reach yet (${message}). ${admit}`
    + `Ask ${l.moved.host} for an invite (/sub-human invite there) and type the line it shows here`;
}

// ---------- the target ----------
function pendingAsk(code: string, name: string, now: number = Date.now()): HandoffAskDoc | null {
  let a: HandoffAskDoc | null;
  try { a = store.open(code).kv.get(ASK_DOC); } catch { return null; }
  if (!a || a.to !== name || expired(a, now)) return null;
  return a;
}

function markTold(code: string, id: string): void {
  try { store.open(code).kv.update(ASK_DOC, (a: HandoffAskDoc | null) => (a && a.id === id && !a.told_at ? { ...a, told_at: iso(Date.now()) } : undefined)); } catch { /* told again */ }
}

const question = (a: Pick<HandoffAsk, 'id'>, code: string) => `Host room ${code} on this machine? (handoff ${a.id})`;

function card(a: Pick<HandoffAsk, 'id' | 'from'>, code: string): Card {
  return {
    questions: [{
      question: question(a, code),
      header: 'Handoff',
      multiSelect: false,
      options: [
        { label: YES, description: `${a.from} asks to move the room here. The room's Claude then runs on YOUR model account: your Claude or Bedrock billing and rate limits. This machine must stay on and reachable for the others.` },
        { label: NO, description: `${a.from} stays the host; nothing changes.` },
      ],
    }],
  };
}

/** Every other machine with a seat in the room: machine -> [seat names] (the old host's included). */
function machinesOf(s: Store): Map<string, string[]> {
  const by = new Map<string, string[]>();
  for (const m of Object.values(s.members.read() as Members)) {
    if (!m || !m.name || m.left_at || m.role === 'claude' || !m.machine || isMine(m.machine)) continue;
    const seats = by.get(m.machine) || [];
    if (!by.has(m.machine)) by.set(m.machine, seats);
    seats.push(m.name);
  }
  return by;
}

/** One sh2 invite per other machine (invites.mintFor): PIN-less over a link (a handoff), with a PIN by hand (promote). */
function mintAll(s: Store, locator: string, { pin = false, machines = machinesOf(s) }: { pin?: boolean, machines?: Map<string, string[]> } = {}): Minted[] {
  const out: Minted[] = [];
  for (const [machine, seats] of machines) {
    const m = invites.mintFor(s, { locator, machine, seats, pin, hostKey: hostKeyFor(locator) });
    out.push({ machine, seats, invite: m.invite, ...(m.pin ? { pin: m.pin } : {}) });
  }
  return out;
}

type Answer = { ok: true, epoch?: number, note?: string } | { ok: false, error: string };
function accept(me: Pick<Identity, 'code' | 'name'>, { cwd, sign }: { cwd?: string, sign: Sign }): Answer {
  const code = me.code;
  const opened = store.open(code);
  if (opened.isHost) return { ok: false, error: `this machine hosts room ${code} already` };
  const s = opened as MirrorRoomStore; // not the host: open() gave the room's mirror
  const a = pendingAsk(code, me.name);
  if (!a) return { ok: false, error: 'no handoff is waiting for you (it expired or was withdrawn)' };
  if (s.hostState().epoch + 1 !== a.epoch) return { ok: false, error: 'the room changed hosts since this ask' };
  const locator: string = a.locator || linkConnect().pipeLocator();
  if (!transportOf(locator)) return { ok: false, error: `"${locator}" is not a locator this machine knows` };
  try { serveWeb(code, locator); } catch (e) { return { ok: false, error: `could not serve room ${code} over the web here: ${(e as Error).message}` }; }
  const invites = Object.fromEntries(mintAll(s, locator).map(x => [x.machine, x.invite]));
  const proof = sign({ kind: 'host_accept', id: a.id, epoch: a.epoch, locator });
  try {
    s.request('handoff.accept', { id: a.id, accept: proof, locator, invites }, { deadlineMs: config.HANDOFF_CALL_MS });
  } catch (e) {
    if (!(e instanceof RoomError)) throw e;
    return { ok: false, error: e.message };
  }
  try { s.kv.delete(ASK_DOC); } catch { /* gone with the link */ }
  return { ok: true, epoch: a.epoch, note: takeOver(code, { by: me.name, cwd, epoch: a.epoch }) };
}

function refuse(me: Pick<Identity, 'code' | 'name'>): Answer {
  const s = store.open(me.code) as MirrorRoomStore; // an ask comes only to a mirror (its daemon writes it: onAsk)
  const a = pendingAsk(me.code, me.name);
  if (!a) return { ok: false, error: 'no handoff is waiting for you' };
  try { s.request('handoff.refuse', { id: a.id }); } catch (e) {
    if (!(e instanceof RoomError)) throw e;
    return { ok: false, error: e.message };
  }
  s.kv.delete(ASK_DOC);
  return { ok: true };
}

/** Stop this room's link daemon (it may have stopped itself on the 'moved' event) and wait for it to exit. */
function stopDaemon(code: string): void {
  const st = linkSocket().status(code);
  if (!st.running) return;
  try { process.kill(st.pid, 'SIGTERM'); } catch { return; }
  for (const until = Date.now() + 3000; Date.now() < until && isAlive(st.pid); sleepSync(20));
}

function takeOver(code: string, { by, cwd, epoch, entry }: { by: string, cwd?: string, epoch?: number, entry?: EntryInput }): string {
  const mirror = store.open(code);
  if (!entry) {
    const h: HostState = mirror.hostState();
    if (!isMine(h.machine) || (epoch && h.epoch !== epoch)) throw err('FORK', `this copy of room ${code} does not hold the line that moves it here`);
  }
  const v = mirror.verifyChain();
  if (!v.ok) throw err('FORK', `this copy of room ${code} does not chain at ${v.badAt != null ? `#${v.badAt}` : `line ${v.line}`}`);
  stopDaemon(code);
  links.remove(code);
  store.forget(code);
  const s = store.open(code);
  if (!s.isHost) throw err('INVALID', `room ${code} is still linked from this machine`);
  try { s.kv.delete('link'); } catch { /* none */ }
  if (entry) s.append(entry, { via: 'system', from: by, system: true });
  identity().adoptLocalSeats(code);
  s.kv.delete(hostLinks.LINKS_KEY); // links from an earlier time this machine hosted: their tokens are not this epoch's
  s.kv.delete(HOST_DOC);
  if (cwd && !s.kv.get(WORKDIR)) s.kv.set(WORKDIR, { cwd });
  const now = iso(Date.now());
  // the old host's room Claude goes with its holder: its machine and lease too. Else claimSpawn clears left_at and the new
  // job's bind meets a record on another machine with a fresh lease, still holding the name ("name taken")
  identity().updateRoomClaude(code, () => ({ job: null, pid: null, pid_start: undefined, machine: undefined, seen_at: undefined, claim: undefined, closing: undefined, left_at: now, stopped_at: now }));
  const seats: typeof import('./seats.ts') = require('./seats.ts');
  return seats.ensureRoomClaude(code, cwd, by);
}

// ---------- promote / demote ----------
interface Promoted { epoch: number, entry: Entry | undefined, invites: Minted[], note: string, last: number }
function promote(code: string, { name, locator, force = false, cwd, now = Date.now() }: { name: string, locator?: string, force?: boolean, cwd?: string, now?: number }): Promoted {
  const s = store.open(code);
  if (s.isHost) throw err('INVALID', `this machine hosts room ${code} already`);
  const st = linkSocket().status(code);
  if (st.running && st.state === 'online') throw err('INVALID', `the host of room ${code} is reachable (the link is online): use a planned handoff, the host runs /sub-human handoff ${name}`);
  const gate = config.envMs('SUB_HUMAN_PROMOTE_OFFLINE_MS', config.PROMOTE_OFFLINE_MS, { allowZero: true });
  const down = now - (Date.parse(st.since || '') || now);
  if (!force && down < gate) throw err('INVALID', `the link to room ${code}'s host has been down ${Math.round(down / 1000)} s; promote only after ${Math.round(gate / 60_000)} min (or --force)`);
  const m: Member | undefined = (s.members.read() as Members)[name];
  if (!m || m.left_at || !isMine(m.machine)) throw err('INVALID', `${name} isn't in room ${code} on this machine`);
  const full = s.validateChain();
  if (!full.ok || !s.lastId()) throw err('FORK', `this machine's copy of room ${code} is empty or does not chain; it cannot become the room`);
  const loc: string = locator || linkConnect().pipeLocator();
  if (!transportOf(loc)) throw err('INVALID', `"${loc}" is not a locator this machine knows`);
  const h: HostState = s.hostState();
  const epoch = h.epoch + 1;
  const last: number = s.lastId();
  const machines = machinesOf(s);
  const entry: EntryInput = {
    kind: 'host_changed', epoch, host: name, machine: machineIn(code) ?? undefined, locator: loc, promoted: true,
    text: `${name} made this machine the host of room ${code}: the old host was unreachable, and anything it wrote after #${last} isn't in the room`,
  };
  serveWeb(code, loc);
  const note = takeOver(code, { by: name, cwd, entry });
  const invites = mintAll(store.open(code), loc, { pin: true, machines }); // handed out by hand: each with its PIN
  const placed: Entry | undefined = store.open(code).readAll().at(-1);
  return { epoch, entry: placed, invites, note, last };
}

function demote(code: string, invite: string, pin?: string): { orphan: string | null, request: unknown, follower?: boolean } {
  const s = store.open(code);
  const inv = invites.parseInvite(invite);
  if (!inv || inv.code !== code) throw err('INVALID', `that is not an invite to room ${code}`);
  const transport = transportOf(inv.locator);
  if (!transport) throw err('INVALID', `this machine cannot use "${inv.locator}"`);
  // without it the link's hello would spend one of the invite's tries on a missing PIN
  if (!invites.PIN_RE.test(String(pin || ''))) throw err('INVALID', 'this invite needs the 6-digit PIN that came with it: sub-human demote CODE INVITE PIN');
  const name: string = (identity().localSeats(code) as string[]).find(n => n !== 'claude') || 'host';
  const hosting = (): typeof import('./remote/hosting.ts') => require('./remote/hosting.ts');
  if (!s.isHost) { // a member's machine follows the promoted room: its link re-pointed, its seats join again over it
    const cur = links.get(code);
    if (!cur) throw err('INVALID', `this machine has no copy of room ${code}`);
    const st = linkSocket().status(code);
    if (st.running) { try { process.kill(st.pid, 'SIGTERM'); } catch { /* gone */ } }
    const request: unknown = hosting().joinInvite({ inv, invite, pin, name }).request || null;
    links.set(code, { ...links.get(code)!, rebind: true, moved: { locator: inv.locator, host: 'the new host', at: iso(Date.now()) } }); // written just above
    for (const until = Date.now() + 2000; st.running && Date.now() < until && ioMod.isAlive(st.pid);) ioMod.sleepSync(20);
    linkSocket().start(code);
    return { orphan: null, request, follower: true };
  }
  const o: Member | undefined = (s.members.read() as Members).claude;
  if (o && o.job && o.job !== 'pending') { try { (require('./room-claude.ts') as typeof import('./room-claude.ts')).releaseDetached(code, o.job); } catch { /* ends with its session */ } }
  const orphan: string | null = s.setAside();
  for (const k of [hostLinks.LINKS_KEY, invites.INVITES_KEY, HOST_DOC, WORKDIR, 'tasks']) s.kv.delete(k);
  for (const k of s.kv.list('presence/')) s.kv.delete(k);
  const moved = { demoted: true, locator: inv.locator, host: 'the new host' };
  // the joiner's side of an sh2 invite (its PIN; over ssh the link's own key and the pinned host key)
  const request: unknown = hosting().joinInvite({ inv, invite, pin, name }).request || null;
  links.set(code, { ...links.get(code)!, moved }); // joinInvite wrote it
  store.forget(code);
  linkSocket().start(code);
  return { orphan, request };
}

interface Status {
  host: HostState;
  isHost: boolean;
  doc: HandoffDoc | null;
  machines?: { machine?: string, seats: string[], connected: boolean }[];
}
function status(code: string): Status {
  const s = store.open(code);
  const out: Status = { host: s.hostState(), isHost: s.isHost, doc: hostDoc(s) };
  if (s.isHost) {
    const linksNow = Object.values((s.kv.get(hostLinks.LINKS_KEY) || {}) as Record<string, LinkRec>);
    const inv = Object.values((s.kv.get(invites.INVITES_KEY) || {}) as Invites).filter((i): i is BoundInvite => !!i && i.handoff === true);
    out.machines = inv.map(i => ({ machine: i.machine, seats: i.seats, connected: !!i.used_at || linksNow.some(l => l.machine === i.machine) }));
  }
  return out;
}

export {
  HOST_DOC, ASK_DOC, YES, NO, ask, hostDoc, streamEvent, serverAccept, serverRefuse, afterMoved, movedAway, onAsk,
  onMoved, whyOffline, pendingAsk, markTold, question, card, accept, refuse, takeOver, promote, demote, status,
};
