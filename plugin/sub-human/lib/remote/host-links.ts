/**
 * plugin/sub-human/lib/remote/host-links.ts: the links a hosted room knows, on the host: the host-only kv document
 * remote/links, keyed by link id, never streamed. A link is made once (an invite redeemed, lib/remote/invites.ts; or a
 * connection over the host account's own ssh login) and is then the credential its machine says hello with: the host
 * keeps sha256(token) only; the joiner keeps the token in clear in its link file (lib/room/links.ts), the same trust
 * as its seat key. "Write as yourself": a link writes only as the seats that joined over it, and joins a seat only
 * with a proof signed by that seat's key. (The joiner's own registry of links is lib/room/links.ts.)
 *
 * create: machine is the id the host derived from the joiner's machine key (machine-key.ts; the reported id is then
 * only the label). key: the Noise key a web
 * link proved when it was made: every later hello over it must prove the same one (keyHolds). loginLink makes a link
 * for a connection over the host account's own ssh login (`serve --login`) with no invite, since whoever can run
 * commands as this account may mint one anyway; it takes the id the joiner chose (its serve's --link, so kick finds
 * the process). A bound link (the card let one name in) joins only those (mayJoinAs).
 *
 * revokeLink keeps the token's digest in the host-only document remote/revoked (the newest REVOKED_KEEP), so a hello
 * with it is AUTH LINK_REVOKED, not an unknown token. checkSeatProof: a join needs a fresh proof signed by the seat's
 * own key, so a link cannot take a seat with a public key alone; proveSeat is the joining hook's half. isLinkToken
 * makes the LinkToken brand (lib/brand.ts), which lib/cli/doctor/redact.ts treats as a secret.
 */

import crypto from 'node:crypto';
import { RoomError } from '../room/validate.ts';
import * as envelope from '../room/envelope.ts';
import * as invites from './invites.ts';
import { isMine } from '../home.ts';
import { isObj } from '../decode.ts';
import type { KeyObject } from 'node:crypto';
import type { AuthStore, LinkRecord, Links, SignedPayload } from './types-core.ts';
import type { MachineId, LinkToken } from '../brand.ts';

/** A seat a proof is for. */
interface SeatRef { room: string; name: string; pubkey: string }

const LINKS_KEY = 'remote/links';
const REVOKED_KEY = 'remote/revoked';
const REVOKED_KEEP = 200;
const LINK_ID_RE: RegExp = /^[0-9a-f]{12}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const isLinkToken = (v: unknown): v is LinkToken => typeof v === 'string' && TOKEN_RE.test(v);
const newLinkId = (): string => crypto.randomBytes(6).toString('hex');
const sha256 = (s: unknown): string => crypto.createHash('sha256').update(String(s)).digest('hex');
const iso = (now: number): string => new Date(now).toISOString();

function create(store: AuthStore, { id, machine, seats, bound = false, login = false, label, key = null, check = false, now = Date.now() }: {
  id: string; machine: MachineId; seats: string[]; bound?: boolean; login?: boolean; label?: string; key?: string | null; check?: boolean; now?: number;
}): { token: LinkToken; link: LinkRecord } {
  const token = crypto.randomBytes(24).toString('base64url');
  if (!isLinkToken(token)) throw new Error('a link token is 32 base64url characters'); // it always is
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

function loginLink(store: AuthStore, { id, machine, proven = null, now = Date.now() }: { id: string; machine: MachineId; proven?: MachineId | null; now?: number }): { token: LinkToken; link: LinkRecord } {
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
  return Object.values(links(store)).find(l => l.token_sha256 === digest) ?? null;
}

/** A link bound to a key (a web link) is reached only over a connection that proved that key; any other by its token. */
const keyHolds = (link: Pick<LinkRecord, 'key'>, peer: string | null | undefined): boolean => !link.key || link.key === peer;

function bindSeat(store: AuthStore, linkId: string, name: string): LinkRecord {
  const next = store.kv.update(LINKS_KEY, (cur: Links | null) => {
    const link = cur && cur[linkId];
    if (!link) throw new RoomError('AUTH', `no link ${linkId} in room ${store.code}`, 'LINK_REVOKED');
    if (link.seats.includes(name)) return undefined;
    if (link.bound) throw new RoomError('AUTH', notBound(link, name), 'NOT_BOUND');
    return { ...cur, [linkId]: { ...link, seats: [...link.seats, name] } };
  });
  // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- it strips null, which tsc needs (a gone document throws, as before)
  const link = (next ?? (store.kv.get<Links>(LINKS_KEY) as Links))[linkId];
  if (!link) throw new RoomError('AUTH', `no link ${linkId} in room ${store.code}`, 'LINK_REVOKED'); // gone since the update
  return link;
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
  const was: { link: LinkRecord | null } = { link: null }; // set in the update
  store.kv.update(LINKS_KEY, (cur: Links | null) => {
    const rec = cur ? cur[id] : undefined;
    if (!cur || !rec) return undefined;
    was.link = rec;
    const next = { ...cur };
    delete next[id];
    return next;
  });
  const n = invites.burnFor(store, id, { now });
  const { link } = was;
  if (link) {
    const gone = link;
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
  const all = store.kv.get<Record<string, { token_sha256?: string }>>(REVOKED_KEY, null) ?? {};
  return Object.values(all).some(r => r && r.token_sha256 === digest);
}

const links = (store: AuthStore): Links => store.kv.get(LINKS_KEY, null) ?? {};

/** A machine id only reported (a joiner that presents no machine key) may not be this host's own or another link's. */
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
  notBound, mayJoinAs, revokeLink, wasRevoked, links, proveSeat, checkSeatProof, isLinkToken,
};
