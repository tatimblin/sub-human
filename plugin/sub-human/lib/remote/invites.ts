/**
 * plugin/sub-human/lib/remote/invites.ts: a room's invites, on the host. An invite is single-use: its first hello
 * redeems it for a link (lib/remote/host-links.ts create), whose token is the link's credential from then on. The host
 * stores only sha256 digests, in the host-only kv document remote/invites (never streamed), keyed by sha256(secret).
 * Three records live there (lib/remote/types-core.ts): a bound invite (below), a short invite (a 4-digit PIN, the
 * whole secret: lib/remote/enroll.ts runs CPace with it) and an admission (a short invite's joiner waiting for the host
 * person's card: lib/remote/admission.ts). Zero dependencies beyond node:crypto.
 *
 * A bound invite is for one machine, with its seats pre-bound, until expires_at:
 *   mintFor(store, {locator, machine, seats, pin?, hostKey?, now?}) -> {invite, secret, pin?, expires_at?}
 *       pin false (a handoff's, lib/handoff.ts): {v: 2, handoff: true, machine, seats, expires_at (HANDOFF_INVITE_MS)},
 *       minted by the room's next host before it is the host (so no HOST_ONLY check) and carried to that machine over
 *       its existing authenticated link, so it needs no PIN. pin true (a promote's, handed out by hand): the same record
 *       with pin_sha256 = sha256(secret:pin) (6 digits, never in the invite), INVITE_TTL_MS and INVITE_PIN_TRIES.
 *       hostKey: a ws/wss next host's listener key, pinned in the invite
 *   redeemInvite(store, secret, {machine, pin?, linkId?, now?}) -> {token, link, handoff, admission?}
 *       marks the invite used and makes its link (host-links.ts create). An unknown, used or burnt invite is AUTH with
 *       its reason (INVITE_UNKNOWN, INVITE_USED, INVITE_BURNT, ...). A bound invite redeems only on its machine
 *       (INVITE_OTHER_MACHINE), before expires_at, and with its PIN when it has one (checked here, online, by the host
 *       only: a wrong PIN costs a try, the last one burns it; error.note is the room line). An admission redeems only
 *       once the host person let it in (admission.ts check). linkId (an ssh forced command's --link): the invite must
 *       be the one reserved for that link (INVITE_OTHER_LINK), and stays unused otherwise
 *   formatInvite({code, locator, secret, hostKey?}) -> "sh2.<code>.<locator-base64url>.<secret>.<hostKey | 0>"
 *   parseInvite(text) -> {v: 2, code, locator, secret, hostKey} | null
 *   inviteRef(secret) -> string        the invite's short public name: 12 hex of sha256(secret), its record key's start
 *   findInvite(store, ref) -> {key, invite} | null   the one invite whose ref is ref
 *   burnInvite(store, ref, {now?}) -> {state, invite}   burn one unused invite (a leaked one): 'burnt', 'burnt already'
 *                                      or 'used' (then nothing changes). AUTH for no invite with that ref
 *   burnFor(store, linkId, {now?}) -> n   burn every invite reserved for that link (host-links.ts revokeLink)
 * Short invites (lib/remote/enroll.ts runs CPace over the PIN):
 *   mintShort(store, {kind, locator, hostKey?, by?, doorFile?, now?}) -> {pin, ref, expires_at}   record {v: 3, short,
 *       kind, locator, host_key, by, door_file, tries, expires_at, prs: the PIN (CPace needs it in clear; dropped when
 *       used, burnt or revoked)}; at most SHORT_LIVE_MAX open per room. Host only
 *   startShort(store, {kind, now?}) -> [{key, ref, prs, hostKey, kind, by}]   the open invites of that kind with a try
 *       left, each charged a try now (before the host answers the attempt)
 *   failShort(store, keys, {now?}) -> {left, burnt}   a wrong PIN: invites at 0 tries burn
 *   enrollShort(store, key, {tried, joiner, now?, admitMs?}) -> {secret, id, ref, expires_at}   the PIN held: the invite
 *       is used, the others tried get their try back, and an admission record {v: 2, admission, machine, name, label,
 *       key, link, admit: 'asked', by, door_file} keyed by a new secret the joiner gets (admission.ts decides it)
 *   shortLive(invite, now?) -> bool    open, and a try left or an attempt in flight
 *   PIN_RE /^[0-9]{6}$/ (a promote's), SHORT_PIN_RE /^[0-9]{4}$/, INVITE_PREFIX 'sh2', INVITES_KEY 'remote/invites'
 */

import crypto from 'node:crypto';
import { RoomError } from '../room/validate.ts';
import { CODE_RE } from '../text.ts';
import { INVITE_TTL_MS, INVITE_PIN_TRIES, HANDOFF_INVITE_MS, SHORT_LIVE_MAX, ENROLL_MS, ADMIT_TTL_MS } from '../config.ts';
import * as hostLinks from './host-links.ts';
import * as admission from './admission.ts';
import type { Reason } from '../reasons.ts';
import type {
  AuthStore, BoundInvite, CodedError, Invites, InviteRecord, ShortInvite, AdmissionRecord, Joiner, LinkRecord, ParsedInvite, ShortKind,
} from './types-core.ts';

/** A redeemed invite: the link's token (once, in clear), its record, and what kind of invite it was. */
interface Redeemed { token: string; link: LinkRecord; handoff: boolean; admission?: AdmissionRecord }
/** A short invite an attempt may try, charged a try (startShort). */
interface ShortAttempt { key: string; ref: string; prs: string; hostKey: string | null; kind: ShortKind; by: string | null }

const INVITE_PREFIX = 'sh2';
const PIN_RE = /^[0-9]{6}$/;
const SHORT_PIN_RE = /^[0-9]{4}$/;
const HOST_KEY_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url
const REF_RE = /^[0-9a-f]{12}$/;
const INVITES_KEY = 'remote/invites';
const SECRET_RE = /^[A-Za-z0-9_-]{16,128}$/;

const sha256 = (s: unknown): string => crypto.createHash('sha256').update(String(s)).digest('hex');
const iso = (now: number): string => new Date(now).toISOString();
const authError = (msg: string, reason: Reason, note: string | null = null): CodedError => Object.assign(new RoomError('AUTH', msg, reason), note ? { note } : {});

function mintFor(store: AuthStore, { locator, machine, seats, pin: withPin = false, hostKey = null, now = Date.now() }: {
  locator: string; machine: string; seats: string[]; pin?: boolean; hostKey?: string | null; now?: number;
}): { invite: string; secret: string; pin?: string; expires_at?: string } {
  if (hostKey !== null && !HOST_KEY_RE.test(String(hostKey))) throw new RoomError('INVALID', 'hostKey must be a 32-byte public key, base64url');
  const secret = crypto.randomBytes(16).toString('base64url'); // 128 bits
  const bound = { v: 2 as const, created_at: iso(now), machine, seats: [...seats] };
  const pin = withPin ? String(crypto.randomInt(0, 1_000_000)).padStart(6, '0') : null;
  const rec: BoundInvite = pin === null
    ? { ...bound, handoff: true, expires_at: iso(now + HANDOFF_INVITE_MS) }
    : { ...bound, expires_at: iso(now + INVITE_TTL_MS), tries: INVITE_PIN_TRIES, pin_sha256: pinDigest(secret, pin) };
  store.kv.update(INVITES_KEY, (cur: Invites | null) => ({ ...cur, [sha256(secret)]: rec }));
  const invite = formatInvite({ code: store.code, locator, secret, hostKey });
  return pin === null ? { invite, secret } : { invite, secret, pin, expires_at: rec.expires_at };
}

const pinDigest = (secret: string, pin: string): string => sha256(`${secret}:${pin}`);
const sameDigest = (a: unknown, b: unknown): boolean => typeof a === 'string' && typeof b === 'string' && a.length === b.length
  && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const left = (n: number): string => `${n} ${n === 1 ? 'try' : 'tries'} left`;

/** A bound invite's checks, inside the invites update: {next record?, err to throw after} (err null: it holds). */
function checkBound(inv: BoundInvite, secret: string, pin: unknown, now: number): { next?: BoundInvite; err: CodedError | null } {
  if (now > Date.parse(inv.expires_at)) {
    return inv.pin_sha256
      ? { next: { ...inv, burnt_at: iso(now) }, err: authError('this invite expired (an invite with a PIN lasts 15 minutes); ask the host for a new one', 'INVITE_EXPIRED') }
      : { err: authError('this handoff invite expired; ask the new host for a new one', 'INVITE_EXPIRED') };
  }
  if (!inv.pin_sha256) return { err: null };
  if (typeof pin === 'string' && PIN_RE.test(pin) && sameDigest(pinDigest(secret, pin), inv.pin_sha256)) return { err: null };
  const tries = Math.max(0, (Number(inv.tries) || 0) - 1);
  if (!tries) {
    return { next: { ...inv, burnt_at: iso(now) }, err: authError('wrong PIN, and that was the last try: this invite no longer works. Ask the host for a new one (/sub-human invite on their side)', 'PIN_LAST', 'an invite was burnt after its last wrong PIN') };
  }
  const msg = typeof pin === 'string' ? `wrong PIN (${left(tries)}). Check the digits with the host, then type the join line again` : 'this invite needs its PIN';
  return { next: { ...inv, tries }, err: authError(msg, typeof pin === 'string' ? 'PIN_WRONG' : 'PIN_NEEDED', `a wrong PIN for an invite (${left(tries)})`) };
}

function redeemInvite(store: AuthStore, secret: string, { machine, linkId, pin, now = Date.now() }: {
  machine: string; linkId?: string; pin?: unknown; now?: number;
}): Redeemed {
  const key = sha256(secret);
  let link = null as { id: string; seats: string[]; bound: boolean; machine: string } | null; // (as: set in the update)
  let err = null as CodedError | null, handoff = false, adm = null as AdmissionRecord | null;
  store.kv.update(INVITES_KEY, (cur: Invites | null) => {
    err = null;
    const inv = cur && cur[key];
    if (inv && inv.admission) {
      adm = inv;
      const r = admission.check(inv, { machine, linkId, now });
      if (r.err) { err = r.err; return r.next ? { ...cur, [key]: r.next } : undefined; }
      link = { id: inv.link, seats: [inv.name], bound: true, machine }; // the card let one name in: that seat and no other
      return { ...cur, [key]: { ...inv, used_at: iso(now) } };
    }
    if (inv && inv.burnt_at) throw authError('this invite no longer works (too many wrong PINs, expired, or cancelled); ask the host for a new one', 'INVITE_BURNT');
    if (inv && inv.used_at) throw authError('this invite was used already (each invite works once); ask the host for a new one', 'INVITE_USED');
    if (!inv || inv.short) throw authError('this invite is unknown or was used already; ask the host for a new one', 'INVITE_UNKNOWN');
    if (linkId !== undefined && inv.link !== linkId) throw authError('this invite is for another connection', 'INVITE_OTHER_LINK');
    if (inv.machine !== machine) throw authError('this invite is for another machine', 'INVITE_OTHER_MACHINE');
    const r = checkBound(inv, secret, pin, now);
    if (r.err) { err = r.err; return r.next ? { ...cur, [key]: r.next } : undefined; }
    handoff = inv.handoff === true;
    const id = inv.link || hostLinks.newLinkId();
    // its seats are pre-bound (a handoff's, a promote's), and it is that machine's: the binding is the host's own
    link = { id, seats: [...inv.seats], bound: inv.seats.length > 0, machine: inv.machine };
    return { ...cur, [key]: { ...inv, used_at: iso(now), link: id } };
  });
  if (err) throw err;
  const l = link!; // the update ran without err
  const made = hostLinks.create(store, { id: l.id, machine: l.machine, seats: l.seats, bound: l.bound, label: machine, admission: !!adm, now });
  return { ...made, handoff, ...(adm ? { admission: adm } : {}) };
}

// ---------- short invites: a 4-digit PIN (lib/remote/enroll.ts) ----------
const shortOpen = (inv: InviteRecord | null | undefined, now: number): inv is ShortInvite => !!inv && inv.short === true && !inv.used_at && !inv.burnt_at && now <= Date.parse(inv.expires_at);
/** A short invite that can still be used: open, with a try left or an attempt still in flight (ENROLL_MS). */
const shortLive = (inv: unknown, now = Date.now()): inv is ShortInvite => {
  const i = inv as InviteRecord | null | undefined; // a stored record, read unchecked
  return shortOpen(i, now) && (i.tries > 0 || (!!i.last_try_at && now - Date.parse(i.last_try_at) < ENROLL_MS));
};

/**
 * A short invite to this room: a 4-digit PIN, the whole secret (CPace's password, lib/remote/cpace.ts). The host keeps
 * it in its own store (the record's prs, host-only, never streamed) because CPace needs it in clear; it goes when the
 * invite is used, burnt or revoked. kind: the transport it is for ('ssh', 'ws', 'pipe'); hostKey: what the host attests
 * inside the PAKE (sshd's Ed25519 key for ssh, the listener's X25519 key for ws); by: the seat whose card admits the
 * joiner (null: any seat of the host's machine); doorFile: the authorized_keys file the enrollment door was written to.
 */
function mintShort(store: AuthStore, { kind, locator, hostKey = null, by = null, doorFile = null, now = Date.now() }: {
  kind: string; locator: string; hostKey?: string | null; by?: string | null; doorFile?: string | null; now?: number;
}): { pin: string; ref: string; expires_at: string } {
  if (!store.isHost) throw new RoomError('HOST_ONLY', 'only the host of a room mints its invites');
  if (!['ssh', 'ws', 'pipe'].includes(kind)) throw new RoomError('INVALID', `no short invite over "${kind}"`);
  if (hostKey !== null && !HOST_KEY_RE.test(String(hostKey))) throw new RoomError('INVALID', 'hostKey must be a 32-byte public key, base64url');
  let out = null as { pin: string; ref: string; expires_at: string } | null; // (as: set in the update)
  store.kv.update(INVITES_KEY, (cur: Invites | null) => {
    const live = Object.values(cur || {}).filter(i => shortLive(i, now));
    if (live.length >= SHORT_LIVE_MAX) {
      throw new RoomError('INVALID', `${live.length} short invites to room ${store.code} are open already; wait until one is used or expires, or cancel one (/sub-human invite --cancel REF)`);
    }
    let pin: string;
    do pin = String(crypto.randomInt(0, 10_000)).padStart(4, '0'); while (live.some(i => i.prs === pin));
    const secret = crypto.randomBytes(16).toString('base64url'); // only its digest names the record; never shown
    const rec: ShortInvite = { v: 3, short: true, kind: kind as ShortKind, locator, host_key: hostKey, by, door_file: doorFile, created_at: iso(now), expires_at: iso(now + INVITE_TTL_MS), tries: INVITE_PIN_TRIES, prs: pin };
    out = { pin, ref: inviteRef(secret), expires_at: rec.expires_at };
    return { ...cur, [sha256(secret)]: rec };
  });
  return out!; // the update ran (or threw)
}

/** The short invites of this room an attempt may try (open, a try left), each charged one try now. */
function startShort(store: AuthStore, { kind, now = Date.now() }: { kind: string; now?: number }): ShortAttempt[] {
  let out: ShortAttempt[] = [];
  store.kv.update(INVITES_KEY, (cur: Invites | null) => {
    out = [];
    const next: Invites = { ...cur };
    const open = Object.entries(cur || {}).filter((e): e is [string, ShortInvite] => shortOpen(e[1], now) && e[1].kind === kind && e[1].tries > 0)
      .sort(([, a], [, b]) => a.created_at.localeCompare(b.created_at)).slice(0, SHORT_LIVE_MAX);
    for (const [k, i] of open) {
      next[k] = { ...i, tries: i.tries - 1, last_try_at: iso(now) };
      out.push({ key: k, ref: k.slice(0, 12), prs: i.prs!, hostKey: i.host_key || null, kind: i.kind, by: i.by || null }); // prs: an open invite keeps its PIN
    }
    return out.length ? next : undefined;
  });
  return out;
}

/** An attempt that did not hold (a wrong PIN): an invite it spent the last try of burns. {left, burnt} */
function failShort(store: AuthStore, keys: string[], { now = Date.now() }: { now?: number } = {}): { left: number; burnt: number } {
  let left = 0, burnt = 0;
  store.kv.update(INVITES_KEY, (cur: Invites | null) => {
    left = 0; burnt = 0;
    const next: Invites = { ...cur };
    for (const k of keys) {
      const i = cur && cur[k];
      if (!shortOpen(i, now)) continue;
      if (i.tries > 0) { left = Math.max(left, i.tries); continue; }
      const { prs, ...rest } = i;
      next[k] = { ...rest, burnt_at: iso(now) };
      burnt++;
    }
    return burnt ? next : undefined;
  });
  return { left, burnt };
}

/**
 * The attempt held for invite key: it is used (its PIN forgotten), the other invites the attempt charged get their
 * try back, and an admission record is made: keyed by a new 128-bit secret only the joiner gets (inside the PAKE
 * channel), bound to the joiner's machine and its link key, waiting for the host person's answer (admit 'asked') for
 * ADMIT_TTL_MS. A redemption then needs admit 'let-in' (admission.ts check).
 */
function enrollShort(store: AuthStore, key: string, { tried = [], joiner, now = Date.now(), admitMs = ADMIT_TTL_MS }: {
  tried?: string[]; joiner: Joiner; now?: number; admitMs?: number;
}): { secret: string; id: string; ref: string; expires_at: string } {
  let out = null as { secret: string; id: string; ref: string; expires_at: string } | null; // (as: set in the update)
  store.kv.update(INVITES_KEY, (stored: Invites | null) => {
    const cur = stored || {};
    const inv = cur[key];
    if (!shortOpen(inv, now)) throw authError('this invite was used, burnt or expired meanwhile; ask the host for a new invite', 'INVITE_USED');
    const id = hostLinks.newLinkId();
    const secret = crypto.randomBytes(16).toString('base64url');
    const next: Invites = { ...cur };
    const { prs, ...rest } = inv;
    next[key] = { ...rest, used_at: iso(now), link: id, enrolled: { at: iso(now), ...joiner } };
    for (const k of tried) {
      const i = cur[k];
      if (k !== key && shortOpen(i, now)) next[k] = { ...i, tries: Math.min(INVITE_PIN_TRIES, i.tries + 1) };
    }
    const rec: AdmissionRecord = {
      v: 2, admission: true, from: key.slice(0, 12), kind: inv.kind, by: inv.by || null, door_file: inv.door_file || null,
      machine: joiner.machine, name: joiner.name, label: joiner.label, key: joiner.key || null, link: id, admit: 'asked',
      created_at: iso(now), expires_at: iso(now + admitMs),
    };
    next[sha256(secret)] = rec;
    out = { secret, id, ref: inviteRef(secret), expires_at: rec.expires_at };
    return next;
  });
  return out!; // the update ran (or threw)
}

// ---------- the invite line ----------
const formatInvite = ({ code, locator, secret, hostKey = null }: { code: string; locator: string; secret: string; hostKey?: string | null }): string =>
  [INVITE_PREFIX, code, Buffer.from(locator).toString('base64url'), secret, hostKey || '0'].join('.');

function parseInvite(text: unknown): ParsedInvite | null {
  const parts = typeof text === 'string' ? text.trim().split('.') : [];
  if (parts[0] !== INVITE_PREFIX || parts.length !== 5) return null;
  const [, code, loc, secret, hk] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(loc)) return null;
  const locator = Buffer.from(loc, 'base64url').toString('utf8');
  if (!CODE_RE.test(code) || !locator || !SECRET_RE.test(secret)) return null;
  if (hk !== '0' && !HOST_KEY_RE.test(hk)) return null;
  return { v: 2, code, locator, secret, hostKey: hk === '0' ? null : hk };
}

const inviteRef = (secret: string): string => sha256(secret).slice(0, 12);

/** The invite of this room whose ref (inviteRef, 12 hex) is ref, or null: none, or more than one. */
function findInvite(store: AuthStore, ref: unknown): { key: string; invite: InviteRecord } | null {
  if (!REF_RE.test(String(ref))) return null;
  const hit = Object.entries((store.kv.get(INVITES_KEY, null) || {}) as Invites).filter(([k]) => k.startsWith(ref as string)); // ref: 12 hex (REF_RE)
  return hit.length === 1 ? { key: hit[0][0], invite: hit[0][1] } : null;
}

/**
 * Burn one invite by its ref, so it never redeems (a leaked one). {state}: 'burnt' (now), 'burnt already', or 'used'
 * (it became a link: host-links.ts revokeLink ends that). AUTH for no invite with that ref.
 */
function burnInvite(store: AuthStore, ref: string, { now = Date.now() }: { now?: number } = {}): { state: 'used' | 'burnt already' | 'burnt'; invite: InviteRecord } {
  if (!store.isHost) throw new RoomError('HOST_ONLY', 'only the host of a room revokes its invites');
  let out = null as { state: 'used' | 'burnt already' | 'burnt'; invite: InviteRecord } | null; // (as: set in the update)
  store.kv.update(INVITES_KEY, (cur: Invites | null) => {
    const hit = Object.keys(cur || {}).filter(k => REF_RE.test(String(ref)) && k.startsWith(ref));
    if (hit.length !== 1) throw new RoomError('AUTH', `no invite of room ${store.code} has the ref ${ref}`, 'INVITE_UNKNOWN');
    const inv = cur![hit[0]]; // cur: hit holds a key of it
    if (inv.used_at) { out = { state: 'used', invite: inv }; return undefined; }
    if (inv.burnt_at) { out = { state: 'burnt already', invite: inv }; return undefined; }
    const { prs, ...kept } = inv; // a short invite's PIN goes with it
    out = { state: 'burnt', invite: { ...kept, burnt_at: iso(now) } };
    return { ...cur, [hit[0]]: out.invite };
  });
  return out!; // the update ran (or threw)
}

/** Burn every invite reserved for link id (an admission waiting on its door): how many. */
function burnFor(store: AuthStore, id: string, { now = Date.now() }: { now?: number } = {}): number {
  let n = 0;
  store.kv.update(INVITES_KEY, (cur: Invites | null) => {
    n = 0;
    const next: Invites = { ...cur };
    for (const [k, inv] of Object.entries(cur || {})) {
      if (inv && inv.link === id && !inv.burnt_at) { const { prs, ...kept } = inv; next[k] = { ...kept, burnt_at: iso(now) }; n++; }
    }
    return n ? next : undefined;
  });
  return n;
}

/** Whether an invite reserves link id (an admission, before its redemption). */
const reserves = (store: AuthStore, id: string): boolean => Object.values((store.kv.get(INVITES_KEY, null) || {}) as Invites).some(inv => inv.link === id);

export {
  INVITE_PREFIX, PIN_RE, SHORT_PIN_RE, INVITES_KEY, mintFor, redeemInvite, formatInvite, parseInvite, inviteRef, findInvite,
  burnInvite, burnFor, reserves, mintShort, startShort, failShort, enrollShort, shortLive,
};
export type { Redeemed, ShortAttempt };
