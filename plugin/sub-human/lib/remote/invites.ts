/**
 * plugin/sub-human/lib/remote/invites.ts: a room's invites, on the host. An invite is single-use: its first hello
 * redeems it for a link (lib/remote/host-links.ts create), whose token (and, over the web, whose Noise key) is the
 * link's credential from then on. The host stores only sha256 digests, in the host-only kv document remote/invites
 * (never streamed), keyed by sha256(secret). Three records live there (lib/remote/types-core.ts): a bound invite
 * (below), an invite line's (protocol 3: a 128-bit secret in the line and a 4-digit PIN told apart, both checked here,
 * online) and an admission (that invite's joiner, waiting for the host person's card: lib/remote/admission.ts). Zero
 * dependencies beyond node:crypto.
 *
 * A bound invite is for one machine, with its seats pre-bound, until expires_at:
 *   mintFor(store, {locator, machine, seats, pin?, hostKey?, now?}) -> {invite, secret, pin?, expires_at?}
 *       pin false (a handoff's, lib/handoff.ts): {v: 2, handoff: true, machine, seats, expires_at (HANDOFF_INVITE_MS)},
 *       minted by the room's next host before it is the host (so no HOST_ONLY check) and carried to that machine over
 *       its existing authenticated link, so it needs no PIN. pin true (a promote's, handed out by hand): the same record
 *       with pin_sha256 = sha256(secret:pin) (6 digits, never in the invite), INVITE_TTL_MS and INVITE_PIN_TRIES.
 *       hostKey: a ws/wss next host's listener key, pinned in the invite
 *   formatInvite({code, locator, secret, hostKey?}) -> "sh2.<code>.<locator-base64url>.<secret>.<hostKey | 0>"
 *   parseInvite(text) -> {v: 2, code, locator, secret, hostKey} | null
 *
 * An invite line's (lib/remote/hosting.ts hostInvite, webhost.ts hostWeb show it; lib/remote/invite-secret.ts its
 * SECRET word):
 *   mintInvite(store, {kind, locator, by?, now?}) -> {secret, pin, ref, expires_at}   secret: 16 random bytes (the line
 *       carries them, with the host key's tag); the record {v: 4, short, kind, locator, by, tries: INVITE_PIN_TRIES,
 *       pin_sha256 = sha256(secretId:pin), created_at, expires_at (INVITE_TTL_MS)}: no PIN in clear, so the host's own
 *       store gives nobody the PIN without the line. At most SHORT_LIVE_MAX open per room. Host only
 *   inviteOpen(record, now?) -> bool    an invite line's, not used, burnt or expired, a try left
 *
 * Redeeming (lib/remote/server.ts hello, the invite and its PIN in one hello):
 *   redeemInvite(store, secret, {machine, pin?, proven?, peerKey?, as?, reserved?, newId?, now?}) -> {token, link,
 *       handoff, admission?}   secret: the secret as idOf gives it (base64url). machine: the id the hello reports;
 *       proven: the id the joiner's machine key gives (lib/remote/machine-key.ts); peerKey: the Noise key the
 *       connection proved (a web link's, XK), recorded on the link it makes; as: {name, label} the joiner asks to sit
 *       as; reserved: a forced command's --link (a link made before protocol 3: the invite must be that link's);
 *       newId: the id a new link takes (a login session's --link, so kick finds its serve).
 *     A bound invite redeems on its machine only (INVITE_OTHER_MACHINE), before expires_at, and with its PIN when it
 *       has one (a wrong one costs a try, the last burns it).
 *     An invite line's, open:  no pin: AUTH PIN_NEEDED (nothing charged: the joiner is asked for the PIN);
 *       throttled (PIN_BACKOFF_MS doubling after each wrong PIN, per invite and per source machine): AUTH
 *       PIN_THROTTLED, nothing charged; a wrong PIN: a try gone (PIN_WRONG), the last burns it (PIN_LAST); the right
 *       one: the invite is used and an admission record {v: 2, admission, from, kind, by, machine: proven, name,
 *       label, key: peerKey, link, admit: 'asked'} waits for the host person under admissionSlot(secret), and the
 *       hello is OFFLINE ADMIT_WAITING. Every outcome but the first carries note, the room line.
 *     An invite line's, used: its admission decides (admission.ts check): waiting, refused, lapsed, or let in (then
 *       on the machine its key proved and, over the web, with the key it proved: the link is made, bound to that one
 *       name and that key). Another machine gets INVITE_USED, and the room a line naming both checks (invite-secret.ts
 *       joinCheck), once per machine (the admission's `others`, at most OTHERS_MAX)
 *     An unknown, used or burnt invite is AUTH with its reason (INVITE_UNKNOWN, INVITE_USED, INVITE_BURNT,
 *       INVITE_EXPIRED, ...); error.note is the room line
 *   admissionSlot(secret) -> string     the kv key of an invite line's admission: sha256(secret + "/admission")
 *   inviteRef(secret) -> string        the invite's short public name: 12 hex of sha256(secret), its record key's start
 *   findInvite(store, ref) -> {key, invite} | null   the one invite whose ref is ref
 *   burnInvite(store, ref, {now?}) -> {state, invite}   burn one unused invite (a leaked one): 'burnt', 'burnt already'
 *                                      or 'used' (then nothing changes). AUTH for no invite with that ref
 *   burnFor(store, linkId, {now?}) -> n   burn every invite reserved for that link (host-links.ts revokeLink)
 *   PIN_RE /^[0-9]{6}$/ (a promote's), SHORT_PIN_RE /^[0-9]{4}$/, INVITE_PREFIX 'sh2', INVITES_KEY 'remote/invites'
 */

import crypto from 'node:crypto';
import { RoomError } from '../room/validate.ts';
import { isRoomCode, NAME_RE } from '../text.ts';
import { INVITE_TTL_MS, INVITE_PIN_TRIES, HANDOFF_INVITE_MS, SHORT_LIVE_MAX } from '../config.ts';
import { testMs } from '../env.ts';
import * as hostLinks from './host-links.ts';
import * as admission from './admission.ts';
import * as secretMod from './invite-secret.ts';
import type { ReasonFor } from '../reasons.ts';
import type {
  AuthStore, BoundInvite, Invites, InviteRecord, ShortInvite, AdmissionRecord, LinkRecord, ParsedInvite, ShortKind,
} from './types-core.ts';
import type { RoomCode, MachineId } from '../brand.ts';

/** A redeemed invite: the link's token (once, in clear), its record, and what kind of invite it was. */
interface Redeemed { token: string; link: LinkRecord; handoff: boolean; admission?: AdmissionRecord }
/** What a joiner asks to sit as (the hello's as): its seat's name and its machine's short name, as it says. */
interface Asked { name: string; label: string }

const INVITE_PREFIX = 'sh2';
const PIN_RE = /^[0-9]{6}$/;
const SHORT_PIN_RE = /^[0-9]{4}$/;
const HOST_KEY_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url
const REF_RE = /^[0-9a-f]{12}$/;
const LABEL_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** How much of a joiner's label a room line or the card shows. */
const LABEL_SHOWN = 24;
const INVITES_KEY = 'remote/invites';
const SECRET_RE = /^[A-Za-z0-9_-]{16,128}$/;
/** The other machines an admission remembers presenting its used invite (one room line each). */
const OTHERS_MAX = 8;
const KINDS: readonly ShortKind[] = ['ssh', 'ws', 'pipe'];

const sha256 = (s: unknown): string => crypto.createHash('sha256').update(String(s)).digest('hex');
const iso = (now: number): string => new Date(now).toISOString();
const authError = (msg: string, reason: ReasonFor<'AUTH'>, note: string | null = null): RoomError => {
  const e = new RoomError('AUTH', msg, reason);
  if (note) e.note = note;
  return e;
};

function mintFor(store: AuthStore, { locator, machine, seats, pin: withPin = false, hostKey = null, now = Date.now() }: {
  locator: string; machine: MachineId; seats: string[]; pin?: boolean; hostKey?: string | null; now?: number;
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
function checkBound(inv: BoundInvite, secret: string, pin: unknown, now: number): { next?: BoundInvite; err: RoomError | null } {
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

/** The kv key of an invite line's admission (the record the host person's card decides). */
const admissionSlot = (secret: string): string => sha256(`${secret}/admission`);

/** An invite line's record that may still be used: protocol 3's, not used, burnt or expired, a try left. */
const inviteOpen = (inv: unknown, now = Date.now()): inv is ShortInvite => {
  const i = inv as InviteRecord | null | undefined; // a stored record, read unchecked
  return !!i && i.short === true && i.v === 4 && !i.used_at && !i.burnt_at && now <= Date.parse(i.expires_at) && i.tries > 0;
};

/** The wait after the n-th wrong PIN (n >= 1): PIN_BACKOFF_MS, doubling. */
const backoff = (n: number): number => testMs('SUB_HUMAN_PIN_BACKOFF_MS') * 2 ** Math.min(Math.max(0, n - 1), 10);

/**
 * An invite line's PIN step and its redemption, inside the invites update (see the header). Returns the records to
 * write (next), the link to make once the update is done (made), and the error to throw after (err).
 */
function redeemShort(cur: Invites, key: string, secret: string, inv: ShortInvite, { pin, proven, peerKey, as, linkId, now }: {
  pin: unknown; proven: MachineId | null; peerKey: string | null; as: Asked | null; linkId: string | undefined; now: number;
}): { next?: Invites; err: RoomError | null; made?: { id: string; machine: MachineId; seats: string[]; key: string | null }; adm?: AdmissionRecord } {
  const ref = key.slice(0, 12);
  if (inv.v !== 4) return { err: authError('this invite was made by an older sub-human on the host; ask them for a new one (/sub-human invite)', 'INVITE_UNKNOWN') };
  // burnt, or no try left (a record whose last wrong PIN did not mark it burnt): it takes no PIN, right or wrong
  if (inv.burnt_at || !(Number(inv.tries) > 0)) return { err: authError('this invite no longer works (too many wrong PINs, expired, or cancelled); ask the host for a new one', 'INVITE_BURNT') };
  if (inv.used_at) {
    const slot = admissionSlot(secret);
    const adm = cur[slot];
    // another machine than the one whose PIN held: the invite is spent for it (each invite works once). The room hears
    // of it once per machine: if the real joiner is the second one, the one waiting on the card is not them
    if (!adm || !adm.admission || adm.machine !== proven) {
      const used = authError('this invite was used already (each invite works once); ask the host for a new one', 'INVITE_USED');
      if (!adm || !adm.admission || !proven || (adm.others || []).includes(proven) || (adm.others || []).length >= OTHERS_MAX) return { err: used };
      const second = secretMod.joinCheck(proven, peerKey);
      const note = `a second machine (${second}) presented invite ${ref}, which ${adm.name} (${secretMod.joinCheck(adm.machine, adm.key)}) used already: `
        + `if ${adm.name}'s screen does not show ${secretMod.joinCheck(adm.machine, adm.key)}, refuse the card${adm.admit === 'let-in' ? ` (let in already: /sub-human kick ${adm.name})` : ''} and invite again`;
      return { err: Object.assign(used, { note }), next: { ...cur, [admissionSlot(secret)]: { ...adm, others: [...(adm.others || []), proven] } } };
    }
    const r = admission.check(adm, { machine: proven || '', linkId, peerKey, now });
    if (r.err) return { err: r.err, ...(r.next ? { next: { ...cur, [slot]: r.next } } : {}) };
    return {
      err: null, adm, next: { ...cur, [slot]: { ...adm, used_at: iso(now) } },
      made: { id: adm.link, machine: adm.machine, seats: [adm.name], key: adm.kind === 'ws' ? adm.key : null },
    };
  }
  if (now > Date.parse(inv.expires_at)) {
    return { next: { ...cur, [key]: { ...inv, burnt_at: iso(now) } }, err: authError('this invite expired (it lasts 15 minutes); ask the host for a new one', 'INVITE_EXPIRED') };
  }
  if (pin === undefined) return { err: authError(`the host's machine has this invite (${left(inv.tries)}): type the 4-digit PIN they told you`, 'PIN_NEEDED') };
  if (!proven) return { err: new RoomError('PROTOCOL', 'a PIN goes only with this machine\'s key, proved in this connection: a newer sub-human does that; update it (/plugin update sub-human)', 'SKEW') };
  if (!as || !NAME_RE.test(as.name)) return { err: new RoomError('INVALID', 'a PIN goes with the name to join as') };
  // what the joiner says it is called: its charset only, and short, since a room line every Claude reads carries it
  const label = LABEL_RE.test(String(as.label)) ? as.label.slice(0, LABEL_SHOWN) : 'a-machine';
  const src = (inv.sources || {})[proven];
  const wait = Math.max(inv.next_at ? Date.parse(inv.next_at) - now : 0, src ? Date.parse(src.next_at) - now : 0);
  if (wait > 0) return { err: authError(`too many PINs tried just now: wait ${Math.ceil(wait / 1000)} s, then type the PIN again`, 'PIN_THROTTLED') };
  if (typeof pin !== 'string' || !SHORT_PIN_RE.test(pin) || !sameDigest(pinDigest(secret, pin), inv.pin_sha256)) {
    const tries = Math.max(0, inv.tries - 1), wrong = (inv.wrong || 0) + 1, srcWrong = (src ? src.wrong : 0) + 1;
    const sources = { ...(inv.sources || {}), [proven]: { wrong: srcWrong, next_at: iso(now + backoff(srcWrong + 1)) } };
    const rec: ShortInvite = { ...inv, tries, wrong, next_at: iso(now + backoff(wrong)), sources, ...(tries ? {} : { burnt_at: iso(now) }) };
    const next = { ...cur, [key]: rec };
    return tries
      ? { next, err: authError(`wrong PIN (${left(tries)}). Check the digits with the host, then type it again`, 'PIN_WRONG', `a wrong PIN for invite ${ref} (${left(tries)}; it asked to join as ${as.name})`) }
      : { next, err: authError('wrong PIN, and that was the last try: this invite no longer works. Ask the host for a new one (/sub-human invite on their side)', 'PIN_LAST', `invite ${ref} burnt after its last wrong PIN`) };
  }
  const id = linkId || hostLinks.newLinkId();
  const joiner = { machine: proven, name: as.name, label, key: peerKey };
  const adm: AdmissionRecord = {
    v: 2, admission: true, from: ref, kind: inv.kind, by: inv.by || null, machine: proven, name: as.name, label,
    key: peerKey, link: id, admit: 'asked', created_at: iso(now), expires_at: iso(now + testMs('SUB_HUMAN_ADMIT_TTL_MS')),
  };
  const next = { ...cur, [key]: { ...inv, used_at: iso(now), link: id, enrolled: { at: iso(now), ...joiner } }, [admissionSlot(secret)]: adm };
  const waiting = Object.assign(new RoomError('OFFLINE', `${admission.WAITING}; the link keeps trying`, 'ADMIT_WAITING'), {
    note: `${as.name} on ${label} typed invite ${ref}'s PIN; waiting for ${inv.by || 'the host'} to let them in (the card, or /sub-human admit ${admissionSlot(secret).slice(0, 12)})`,
  });
  return { next, err: waiting };
}

function redeemInvite(store: AuthStore, secret: string, { machine, pin, proven = null, peerKey = null, as = null, reserved, newId, now = Date.now() }: {
  machine: MachineId; pin?: unknown; proven?: MachineId | null; peerKey?: string | null; as?: Asked | null; reserved?: string; newId?: string; now?: number;
}): Redeemed {
  const key = sha256(secret);
  let link = null as { id: string; seats: string[]; bound: boolean; machine: MachineId; key: string | null } | null; // (as: set in the update)
  let err = null as RoomError | null, handoff = false, adm = null as AdmissionRecord | null; // (as: set in the update)
  store.kv.update(INVITES_KEY, (stored: Invites | null) => {
    err = null;
    const cur = stored || {};
    const inv = cur[key];
    if (inv && inv.admission) { // an admission of a short invite a 0.5.0-beta.15 host enrolled (its own secret)
      adm = inv;
      const r = admission.check(inv, { machine, linkId: reserved ?? newId, peerKey, now });
      if (r.err) { err = r.err; return r.next ? { ...cur, [key]: r.next } : undefined; }
      link = { id: inv.link, seats: [inv.name], bound: true, machine: proven || machine, key: null }; // the card let one name in: that seat and no other
      return { ...cur, [key]: { ...inv, used_at: iso(now) } };
    }
    if (inv && inv.short) {
      const r = redeemShort(cur, key, secret, inv, { pin, proven, peerKey, as, linkId: reserved ?? newId, now });
      err = r.err;
      if (r.made) { adm = r.adm!; link = { ...r.made, bound: true }; } // made: with the admission it came from
      return r.next;
    }
    if (inv && inv.burnt_at) throw authError('this invite no longer works (too many wrong PINs, expired, or cancelled); ask the host for a new one', 'INVITE_BURNT');
    if (inv && inv.used_at) throw authError('this invite was used already (each invite works once); ask the host for a new one', 'INVITE_USED');
    if (!inv) throw authError('this invite is unknown or was used already; ask the host for a new one', 'INVITE_UNKNOWN');
    if (reserved !== undefined && inv.link !== reserved) throw authError('this invite is for another connection', 'INVITE_OTHER_LINK');
    if (inv.machine !== machine) throw authError('this invite is for another machine', 'INVITE_OTHER_MACHINE');
    const r = checkBound(inv, secret, pin, now);
    if (r.err) { err = r.err; return r.next ? { ...cur, [key]: r.next } : undefined; }
    handoff = inv.handoff === true;
    const id = inv.link || newId || hostLinks.newLinkId();
    // its seats are pre-bound (a handoff's, a promote's), and it is that machine's: the binding is the host's own
    link = { id, seats: [...inv.seats], bound: inv.seats.length > 0, machine: inv.machine, key: peerKey };
    return { ...cur, [key]: { ...inv, used_at: iso(now), link: id } };
  });
  if (err) throw err;
  const l = link!; // the update ran without err
  // an admission's machine: the one its joiner's machine key proves, else the reported one, checked
  const made = hostLinks.create(store, { id: l.id, machine: l.machine, seats: l.seats, bound: l.bound, label: machine, key: l.key, check: !!adm && !proven, now });
  return { ...made, handoff, ...(adm ? { admission: adm } : {}) };
}

/**
 * An invite line to this room (protocol 3): 16 random bytes the line carries, and a 4-digit PIN the host person tells
 * apart; the host keeps sha256(secret) as the record's key and sha256(secret:PIN), so its own store gives the PIN to
 * nobody who lacks the line. kind: the transport it is for ('ssh', 'ws', 'pipe'); by: the seat whose card admits the
 * joiner (null: any seat of the host's machine).
 */
function mintInvite(store: AuthStore, { kind, locator, by = null, now = Date.now() }: {
  kind: string; locator: string; by?: string | null; now?: number;
}): { secret: Buffer; pin: string; ref: string; expires_at: string } {
  if (!store.isHost) throw new RoomError('HOST_ONLY', 'only the host of a room mints its invites');
  if (!(KINDS as readonly string[]).includes(kind)) throw new RoomError('INVALID', `no invite over "${kind}"`);
  const raw = crypto.randomBytes(16);
  const secret = raw.toString('base64url');
  const pin = String(crypto.randomInt(0, 10_000)).padStart(4, '0');
  let out = null as { ref: string; expires_at: string } | null; // (as: set in the update)
  store.kv.update(INVITES_KEY, (cur: Invites | null) => {
    const live = Object.values(cur || {}).filter(i => inviteOpen(i, now));
    if (live.length >= SHORT_LIVE_MAX) {
      throw new RoomError('INVALID', `${live.length} invites to room ${store.code} are open already; wait until one is used or expires, or cancel one (/sub-human invite --cancel REF)`);
    }
    const rec: ShortInvite = { v: 4, short: true, kind: kind as ShortKind, locator, by, created_at: iso(now), expires_at: iso(now + INVITE_TTL_MS), tries: INVITE_PIN_TRIES, pin_sha256: pinDigest(secret, pin) };
    out = { ref: inviteRef(secret), expires_at: rec.expires_at };
    return { ...cur, [sha256(secret)]: rec };
  });
  return { secret: raw, pin, ...out! }; // the update ran (or threw)
}

// ---------- the sh2 invite string (bound invites: a handoff's, a promote's) ----------
const formatInvite = ({ code, locator, secret, hostKey = null }: { code: RoomCode; locator: string; secret: string; hostKey?: string | null }): string =>
  [INVITE_PREFIX, code, Buffer.from(locator).toString('base64url'), secret, hostKey || '0'].join('.');

function parseInvite(text: unknown): ParsedInvite | null {
  const parts = typeof text === 'string' ? text.trim().split('.') : [];
  if (parts[0] !== INVITE_PREFIX || parts.length !== 5) return null;
  const [, code, loc, secret, hk] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(loc)) return null;
  const locator = Buffer.from(loc, 'base64url').toString('utf8');
  if (!isRoomCode(code) || !locator || !SECRET_RE.test(secret)) return null;
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
    const { prs, ...kept } = inv; // a 0.5.0-beta.15 short invite's PIN goes with it
    out = { state: 'burnt', invite: { ...kept, burnt_at: iso(now) } };
    return { ...cur, [hit[0]]: out.invite };
  });
  return out!; // the update ran (or threw)
}

/** Burn every invite reserved for link id (an admission waiting for the card): how many. */
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
  burnInvite, burnFor, reserves, mintInvite, inviteOpen, admissionSlot,
};
export type { Redeemed, Asked };
