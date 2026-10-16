/**
 * plugin/sub-human/lib/remote/host-links.ts: the links a hosted room knows, on the host: the host-only kv document
 * remote/links, keyed by link id, never streamed. A link is made once (an invite redeemed, lib/remote/invites.ts; or a
 * connection over the host account's own ssh login) and is then the credential its machine says hello with: the host
 * keeps sha256(token) only; the joiner keeps the token in clear in its link file (lib/room/links.ts), the same trust
 * as its seat key. "Write as yourself": a link writes only as the seats that joined over it, and joins a seat only
 * with a proof signed by that seat's key. (The joiner's own registry of links is lib/room/links.ts.)
 *
 *   create(store, {id, machine, seats, bound?, login?, label?, key?, check?, now?}) -> {token, link}   records {id,
 *       token_sha256, machine, seats, created_at, bound?, login?, label?, key?}; the token is returned once. key: the
 *       Noise key a web link proved when it was made (XK): every later hello over it must prove the same one
 *       (keyHolds). machine: the id
 *       the host derived from the joiner's machine key (lib/remote/machine-key.ts; the reported id is then only the
 *       label), or a bound invite's (the machine it was minted for, across a handoff); with check (an id only reported:
 *       a joiner that presents no key, a 0.5 beta's) it may be neither this host's (home.isMine) nor another link's
 *       (AUTH MACHINE_TAKEN)
 *   loginLink(store, {id, machine, proven?, now?}) -> {token, link}   proven: the id the joiner's machine key gives   a link for a connection that arrived over the host account's
 *       own ssh login (`serve --login`, lib/remote/server.ts): no invite, since whoever can run commands as this
 *       account may mint one anyway. Seats [], login: true, under the id the joiner chose (its serve's --link, so kick
 *       finds the process). AUTH for an id the room knows already
 *   verifyToken(store, token) -> link | null
 *   keyHolds(link, peer) -> bool              a link with a key is reached only over a connection that proved it;
 *                                             one without (ssh, a pipe, a web link made under protocol 2) by its token
 *   bindSeat(store, linkId, name) -> link     name joined over this link (AUTH for an unknown link, NOT_BOUND for a
 *       bound link and another name)
 *   mayWriteAs(link, name) -> bool            name is one of link.seats
 *   mayJoinAs(link, name) -> bool             a bound link (the card let one name in; a handoff's seats) joins only those;
 *                                             notBound(link, name) says why not
 *   unbindSeat(store, linkId, name)           undo a bindSeat whose seat was then refused (lib/remote/server.ts join)
 *   revokeLink(store, id, {now?}) -> {link, invites} | null   forget link id (its token stops working) and burn every
 *       invite reserved for it; null when nothing had that id. The token's digest is kept in the host-only document
 *       remote/revoked (the newest REVOKED_KEEP), so a hello with it is AUTH LINK_REVOKED, not an unknown token
 *   wasRevoked(store, token) -> bool          the token is one of a link the host revoked (kick)
 *   links(store) -> {id: link};  linkKnown(store, id) -> bool (a link, or an invite's reserved link, with that id)
 *   newLinkId() -> 12 hex;  LINK_ID_RE /^[0-9a-f]{12}$/;  LINKS_KEY 'remote/links'
 *   proveSeat(key, {room, name, pubkey}) -> proof   the joining hook's half (it holds the seat's private key):
 *       {kind: 'join', pubkey} signed (sig v2) for room and name
 *   checkSeatProof(proof, {room, name, pubkey})    the server's half: AUTH unless proof is a fresh join proof for this
 *       room, name and pubkey that verifies against pubkey, so a link cannot take a seat with a public key alone
 */

import crypto from 'node:crypto';
import { RoomError } from '../room/validate.ts';
import * as envelope from '../room/envelope.ts';
import * as invites from './invites.ts';
import { isMine } from '../home.ts';
import { isObj } from '../decode.ts';
import type { KeyObject } from 'node:crypto';
import type { AuthStore, LinkRecord, Links, SignedPayload } from './types-core.ts';
import type { MachineId } from '../brand.ts';

/** A seat a proof is for. */
interface SeatRef { room: string; name: string; pubkey: string }

const LINKS_KEY = 'remote/links';
const REVOKED_KEY = 'remote/revoked';
const REVOKED_KEEP = 200;
const LINK_ID_RE = /^[0-9a-f]{12}$/;
const newLinkId = (): string => crypto.randomBytes(6).toString('hex');
const sha256 = (s: unknown): string => crypto.createHash('sha256').update(String(s)).digest('hex');
const iso = (now: number): string => new Date(now).toISOString();

function create(store: AuthStore, { id, machine, seats, bound = false, login = false, label, key = null, check = false, now = Date.now() }: {
  id: string; machine: MachineId; seats: string[]; bound?: boolean; login?: boolean; label?: string; key?: string | null; check?: boolean; now?: number;
}): { token: string; link: LinkRecord } {
  const token = crypto.randomBytes(24).toString('base64url');
  if (check) taken(store, machine, id);
  const link: LinkRecord = {
    id, token_sha256: sha256(token), machine, seats: [...seats], created_at: iso(now),
    ...(bound ? { bound: true as const } : {}), ...(login ? { login: true as const } : {}), ...(label && label !== machine ? { label } : {}),
    ...(key ? { key } : {}),
  };
  store.kv.update(LINKS_KEY, (cur: Links | null) => {
    if (cur && cur[id]) throw new RoomError('AUTH', `link ${id} exists already in room ${store.code}; it says hello with its token (join again for a new link)`);
    return { ...cur, [id]: link };
  });
  return { token, link };
}

function loginLink(store: AuthStore, { id, machine, proven = null, now = Date.now() }: { id: string; machine: MachineId; proven?: MachineId | null; now?: number }): { token: string; link: LinkRecord } {
  if (!store.isHost) throw new RoomError('HOST_ONLY', 'only the host of a room links machines to it');
  if (!LINK_ID_RE.test(String(id))) throw new RoomError('INVALID', 'a login link needs its id (12 hex)');
  if (linkKnown(store, id)) throw new RoomError('AUTH', `link ${id} exists already in room ${store.code}; it says hello with its token (join again for a new link)`);
  return create(store, { id, machine: proven || machine, seats: [], login: true, label: machine, check: !proven, now });
}

function linkKnown(store: AuthStore, id: unknown): boolean {
  if (typeof id !== 'string' || !LINK_ID_RE.test(id)) return false;
  return !!links(store)[id] || invites.reserves(store, id);
}

function verifyToken(store: AuthStore, token: unknown): LinkRecord | null {
  if (typeof token !== 'string' || !token) return null;
  const digest = sha256(token);
  return Object.values(links(store)).find(l => l.token_sha256 === digest) || null;
}

/** A link bound to a key (made over the web under protocol 3) is reached only with that key; any other by its token. */
const keyHolds = (link: Pick<LinkRecord, 'key'>, peer: string | null | undefined): boolean => !link.key || link.key === peer;

function bindSeat(store: AuthStore, linkId: string, name: string): LinkRecord {
  const next = store.kv.update(LINKS_KEY, (cur: Links | null) => {
    const link = cur && cur[linkId];
    if (!link) throw new RoomError('AUTH', `no link ${linkId} in room ${store.code}`, 'LINK_REVOKED');
    if (link.seats.includes(name)) return undefined;
    if (link.bound) throw new RoomError('AUTH', notBound(link, name), 'NOT_BOUND');
    return { ...cur, [linkId]: { ...link, seats: [...link.seats, name] } };
  });
  return (next || (store.kv.get(LINKS_KEY) as Links))[linkId];
}

function unbindSeat(store: AuthStore, linkId: string, name: string): void {
  store.kv.update(LINKS_KEY, (cur: Links | null) => {
    const link = cur && cur[linkId];
    if (!link || !link.seats.includes(name)) return undefined;
    return { ...cur, [linkId]: { ...link, seats: link.seats.filter(n => n !== name) } };
  });
}

const mayWriteAs = (link: { seats?: unknown } | null | undefined, name: string): boolean => !!link && Array.isArray(link.seats) && link.seats.includes(name);

/** Why a bound link may not take `name`: the host let it in for its seats alone. */
const notBound = (link: Pick<LinkRecord, 'seats'>, name: string): string =>
  `this connection was let in as ${link.seats.join(', ')}, not ${name}; join as that name (/sub-human ${link.seats[0] || 'NAME'}), or ask the host for a new invite`;
/** A link may join `name`: its own seats when bound, any name otherwise (a login link is the account's own). */
const mayJoinAs = (link: Pick<LinkRecord, 'seats' | 'bound'> | null | undefined, name: string): boolean => !!link && (!link.bound || link.seats.includes(name));

function revokeLink(store: AuthStore, id: string, { now = Date.now() }: { now?: number } = {}): { link: LinkRecord | null; invites: number } | null {
  if (!store.isHost) throw new RoomError('HOST_ONLY', 'only the host of a room revokes its links');
  let link = null as LinkRecord | null; // (as: set in the update)
  store.kv.update(LINKS_KEY, (cur: Links | null) => {
    if (!cur || !cur[id]) return undefined;
    link = cur[id];
    const next = { ...cur };
    delete next[id];
    return next;
  });
  const n = invites.burnFor(store, id, { now });
  const gone = link as LinkRecord | null;
  if (gone) {
    store.kv.update(REVOKED_KEY, (cur: Record<string, { token_sha256: string; at: string }> | null) => {
      const all = Object.entries({ ...cur, [id]: { token_sha256: gone.token_sha256, at: iso(now) } });
      return Object.fromEntries(all.slice(-REVOKED_KEEP));
    });
  }
  return link || n ? { link, invites: n } : null;
}

function wasRevoked(store: AuthStore, token: unknown): boolean {
  if (typeof token !== 'string' || !token) return false;
  const digest = sha256(token);
  const all = (store.kv.get(REVOKED_KEY, null) || {}) as Record<string, { token_sha256?: string }>;
  return Object.values(all).some(r => r && r.token_sha256 === digest);
}

const links = (store: AuthStore): Links => store.kv.get(LINKS_KEY, null) || {};

/** A reported machine id (a joiner that derives none: a 0.5 beta's) may not be this host's own or another link's. */
function taken(store: AuthStore, machine: string, id: string): void {
  const other = Object.values(links(store)).some(l => l && l.id !== id && l.machine === machine);
  if (other || isMine(machine)) throw new RoomError('AUTH', `this machine reports the id of another one in room ${store.code} (${other ? 'a linked machine' : 'the host'}); join from your own sub-human home`, 'MACHINE_TAKEN');
}

const proveSeat = (key: KeyObject, { room, name, pubkey }: SeatRef): SignedPayload => envelope.sign({ kind: 'join', pubkey }, key, { room, from: name });

function checkSeatProof(proof: unknown, { room, name, pubkey }: { room: string; name: unknown; pubkey: string }): void {
  const ok = isObj(proof) && proof.kind === 'join' && proof.room === room && proof.from === name && proof.pubkey === pubkey
    && envelope.isV2(proof) && envelope.freshTs(proof) && envelope.verify(proof, envelope.parseKey(pubkey));
  if (!ok) throw new RoomError('AUTH', `a join needs a fresh proof signed by ${name}'s own key`);
}

export {
  LINKS_KEY, REVOKED_KEY, LINK_ID_RE, newLinkId, create, loginLink, linkKnown, verifyToken, keyHolds, bindSeat, unbindSeat, mayWriteAs,
  notBound, mayJoinAs, revokeLink, wasRevoked, links, proveSeat, checkSeatProof,
};
