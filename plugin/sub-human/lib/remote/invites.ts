/**
 * plugin/sub-human/lib/remote/invites.ts: a room's invites, on the host. An invite is single-use: its first hello
 * redeems it for a link (lib/remote/host-links.ts create), whose token (and, over the web, whose Noise key) is the
 * link's credential from then on. The host stores only sha256 digests, in the host-only kv document remote/invites
 * (never streamed), keyed by sha256(secret). Two records live there (lib/remote/types-core.ts): an invite line's
 * (protocol 3: a 128-bit secret in the line and a 4-digit PIN told apart, both checked here, online) and an admission (that invite's joiner: lib/remote/admission.ts). Zero
 * dependencies beyond node:crypto.
 *
 * An invite line's (mintInvite; at most SHORT_LIVE_MAX open per room), redeemed in one hello (server.ts):
 *   open: no pin is AUTH PIN_NEEDED and throttled (PIN_BACKOFF_MS doubling after each wrong PIN, per invite and per
 *     source machine, the id its machine key proves) is PIN_THROTTLED, neither charged; a wrong PIN costs a try
 *     (PIN_WRONG), the last burns it (PIN_LAST), and never makes a card. The right one uses the invite and lets the
 *     joiner in: an admission record (under admissionSlot) let in by 'pin' and used, and the link made in that same
 *     hello, on the machine its key proved and, over the web, bound to the Noise key it proved and to that one name (the
 *     free NAME2 when its own sits here from another machine: admission.ts taken). A PIN goes only with a proven machine.
 *   knock: a hello with knock: true and no pin (a newer joiner that typed the line alone; an older one never knocks and
 *     is asked for the PIN) uses the invite and asks the host person's card: an admission 'asked' for the machine its
 *     key proved (and its Noise key), lapsing after ADMIT_TTL_MS, answered OFFLINE ADMIT_WAITING. It spends no try; a
 *     machine that typed a wrong PIN for the invite waits out its backoff (PIN_THROTTLED), then gets PIN_NEEDED, and
 *     once any machine typed a wrong one every knock gets PIN_NEEDED (a miss on one machine is no card from another).
 *   used: its admission decides (admission.ts check; a card's 'let-in' redeems once). A PIN while the card waits is
 *     checked as above: the right one lets it in at once (admitted_by 'pin'), a wrong one costs a try and the last
 *     burns the knock too. From another machine than the knock's, the right PIN replaces the knock (the line may have
 *     leaked; the PIN is the host's word): the card goes, the knocking machine gets ADMIT_REFUSED from then on
 *     (`replaced`), and the room a line with both checks. A knock never replaces anything: another machine with no
 *     PIN gets INVITE_USED (one knock per invite), and the room a line naming both checks (invite-secret.ts joinCheck),
 *     once per machine (`others`, at most OTHERS_MAX).
 * A wrong PIN, the last try and a second machine carry error.note, the room line; server.ts says the joined one.
 *
 * isPin and its kin make the Pin brand (lib/brand.ts), which lib/cli/doctor/redact.ts treats as a secret.
 */

import crypto from 'node:crypto';
import { RoomError } from '../room/validate.ts';
import { NAME_RE } from '../text.ts';
import { INVITE_TTL_MS, INVITE_PIN_TRIES, SHORT_LIVE_MAX } from '../config.ts';
import { testMs } from '../env.ts';
import * as hostLinks from './host-links.ts';
import * as admission from './admission.ts';
import * as secretMod from './invite-secret.ts';
import type { ReasonFor } from '../reasons.ts';
import type {
  AuthStore, Invites, InviteRecord, ShortInvite, AdmissionRecord, LinkRecord, ShortKind,
} from './types-core.ts';
import type { MachineId, Pin, LinkToken } from '../brand.ts';

/** A redeemed invite: the link's token (once, in clear), its record, and the admission it came from. */
interface Redeemed { token: LinkToken; link: LinkRecord; admission?: AdmissionRecord }
/** What a joiner asks to sit as (the hello's as): its seat's name and its machine's short name, as it says. */
interface Asked { name: string; label: string }

const SHORT_PIN_RE: RegExp = /^[0-9]{4}$/;
const isShortPin = (v: unknown): v is Pin => typeof v === 'string' && SHORT_PIN_RE.test(v);
const isPin: (v: unknown) => v is Pin = isShortPin;
/** A fresh 4-digit PIN. */
function newPin(): Pin {
  const pin = String(crypto.randomInt(0, 10_000)).padStart(4, '0');
  if (!isPin(pin)) throw new Error('a PIN is 4 digits'); // it always is
  return pin;
}
const REF_RE = /^[0-9a-f]{12}$/;
const LABEL_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** How much of a joiner's label a room line or the card shows. */
const LABEL_SHOWN = 24;
const INVITES_KEY = 'remote/invites';
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

const pinDigest = (secret: string, pin: string): string => sha256(`${secret}:${pin}`);
const sameDigest = (a: unknown, b: unknown): boolean => typeof a === 'string' && typeof b === 'string' && a.length === b.length
  && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const left = (n: number): string => `${n} ${n === 1 ? 'try' : 'tries'} left`;

/** The kv key of an invite line's admission (the record the host person's card decides). */
const admissionSlot = (secret: string): string => sha256(`${secret}/admission`);

/** An invite line's record that may still be used: not used, burnt or expired, a try left. */
const inviteOpen = (inv: unknown, now: number = Date.now()): inv is ShortInvite => {
  const i = inv as InviteRecord | null | undefined; // a stored record, read unchecked
  return !!i && i.short === true && i.v === 4 && !i.used_at && !i.burnt_at && now <= Date.parse(i.expires_at) && i.tries > 0;
};

/** What the joiner says it is called: its charset only, and short, since a room line every Claude reads carries it. */
const labelOf = (as: Asked): string => LABEL_RE.test(String(as.label)) ? as.label.slice(0, LABEL_SHOWN) : 'a-machine';

/** The wait after the n-th wrong PIN (n >= 1): PIN_BACKOFF_MS, doubling. */
const backoff = (n: number): number => testMs('SUB_HUMAN_PIN_BACKOFF_MS') * 2 ** Math.min(Math.max(0, n - 1), 10);

/** A PIN against an invite line's record (proven: the machine its key proved): null when it holds, else the error,
 * with the records a wrong one writes (a try spent, the waits per invite and per source; the last burns the invite and
 * whatever burn names besides: the knock that waits on it). */
function checkPin(cur: Invites, key: string, secret: string, inv: ShortInvite, { pin, proven, name, burn = {}, now }: {
  pin: unknown; proven: MachineId; name: string; burn?: Invites; now: number;
}): { next?: Invites; err: RoomError } | null {
  const ref = key.slice(0, 12);
  const src = (inv.sources ?? {})[proven];
  const wait = Math.max(inv.next_at ? Date.parse(inv.next_at) - now : 0, src ? Date.parse(src.next_at) - now : 0);
  if (wait > 0) return { err: throttled(wait) };
  if (typeof pin === 'string' && SHORT_PIN_RE.test(pin) && sameDigest(pinDigest(secret, pin), inv.pin_sha256)) return null;
  const tries = Math.max(0, inv.tries - 1), wrong = (inv.wrong || 0) + 1, srcWrong = (src ? src.wrong : 0) + 1;
  const sources = { ...(inv.sources ?? {}), [proven]: { wrong: srcWrong, next_at: iso(now + backoff(srcWrong + 1)) } };
  const rec: ShortInvite = { ...inv, tries, wrong, next_at: iso(now + backoff(wrong)), sources, ...(tries ? {} : { burnt_at: iso(now) }) };
  return tries
    ? { next: { ...cur, [key]: rec }, err: authError(`wrong PIN (${left(tries)}). Check the digits with the host, then type it again`, 'PIN_WRONG', `a wrong PIN for invite ${ref} (${left(tries)}; it asked to join as ${name})`) }
    : { next: { ...cur, ...burn, [key]: rec }, err: authError('wrong PIN, and that was the last try: this invite no longer works. Ask the host for a new one (/sub-human invite on their side)', 'PIN_LAST', `invite ${ref} burnt after its last wrong PIN`) };
}
const throttled = (wait: number): RoomError => authError(`too many PINs tried just now: wait ${Math.ceil(wait / 1000)} s, then type the PIN again`, 'PIN_THROTTLED');

/**
 * An invite line's PIN step, its knock and its redemption, inside the invites update (see the header). Returns the
 * records to write (next), the link to make once the update is done (made), and the error to throw after (err).
 */
function redeemShort(cur: Invites, key: string, secret: string, inv: ShortInvite, { pin, knock, proven, peerKey, as, alt, linkId, now }: {
  pin: unknown; knock: boolean; proven: MachineId | null; peerKey: string | null; as: Asked | null; alt: string | null; linkId: string | undefined; now: number;
}):{ next?: Invites; err: RoomError; made?: undefined; adm?: undefined } | { next: Invites; err: null; made: { id: string; machine: MachineId; seats: string[]; key: string | null }; adm: AdmissionRecord } {
  const ref = key.slice(0, 12);
  // burnt, or no try left (a record whose last wrong PIN did not mark it burnt): it takes no PIN, right or wrong
  if (inv.burnt_at || !(Number(inv.tries) > 0)) return { err: authError('this invite no longer works (too many wrong PINs, expired, or cancelled); ask the host for a new one', 'INVITE_BURNT') };
  if (inv.used_at) {
    const slot = admissionSlot(secret);
    const adm = cur[slot];
    // the machine whose knock a PIN replaced (below): its link ends refused, and it never takes anything back
    if (adm && adm.admission && proven && adm.replaced && adm.replaced.machine === proven && adm.machine !== proven) {
      return { err: authError('a machine with this invite\'s PIN joined in this one\'s place (this one knocked without it); ask the host for a new invite', 'ADMIT_REFUSED') };
    }
    // a PIN from another machine while a knock waits for the card: the knock had the line alone, the PIN is the host's
    // consent said ahead. Checked as on the line (a wrong one costs a try, waits, never makes a card, and the last burns
    // the knock with the invite); the right one withdraws the knock (its card goes, its link is refused) and lets this
    // machine in. A knock never displaces anything (it is INVITE_USED below)
    if (adm && adm.admission && proven && adm.machine !== proven && pin !== undefined && adm.admit === 'asked' && !adm.burnt_at && now <= Date.parse(adm.expires_at)) {
      if (!as || !NAME_RE.test(as.name)) return { err: new RoomError('INVALID', 'a PIN goes with the name to join as') };
      const bad = checkPin(cur, key, secret, inv, { pin, proven, name: as.name, burn: { [slot]: { ...adm, burnt_at: iso(now) } }, now });
      if (bad) return bad;
      const at = iso(now);
      const id = linkId || hostLinks.newLinkId();
      const ok: AdmissionRecord = {
        v: 2, admission: true, from: ref, kind: inv.kind, by: inv.by || null, machine: proven, name: alt ?? as.name, ...(alt ? { asked_as: as.name } : {}), label: labelOf(as),
        key: peerKey, link: id, admit: 'let-in', created_at: at, expires_at: at, admitted_at: at, admitted_by: 'pin', admitted_until: at, used_at: at,
        replaced: { machine: adm.machine, key: adm.key, name: adm.name },
      };
      return { err: null, adm: ok, next: { ...cur, [key]: { ...inv, link: id }, [slot]: ok }, made: { id, machine: proven, seats: [ok.name], key: inv.kind === 'ws' ? peerKey : null } };
    }
    // another machine than the one whose PIN or knock holds it: the invite is spent for it (each invite works once,
    // and takes one knock). The room hears of it once per machine: if the real joiner is the second one, the one
    // waiting on the card is not them
    if (!adm || !adm.admission || adm.machine !== proven) {
      const used = authError('this invite was used already (each invite works once); ask the host for a new one', 'INVITE_USED');
      if (!adm || !adm.admission || !proven || (adm.others ?? []).includes(proven) || (adm.others ?? []).length >= OTHERS_MAX) return { err: used };
      const second = secretMod.joinCheck(proven, peerKey);
      const note = `a second machine (${second}) presented invite ${ref}, which ${adm.name} (${secretMod.joinCheck(adm.machine, adm.key)}) used already: `
        + `if ${adm.name}'s screen does not show ${secretMod.joinCheck(adm.machine, adm.key)}, ${adm.admit === 'let-in' ? `kick them (/sub-human kick ${adm.name})` : 'refuse the card'} and invite again`;
      return { err: Object.assign(used, { note }), next: { ...cur, [admissionSlot(secret)]: { ...adm, others: [...(adm.others ?? []), proven] } } };
    }
    const r = admission.check(adm, { machine: proven || '', linkId, peerKey, now });
    // a PIN typed while its knock waits for the card: the right one lets it in now, as on the line (a wrong one costs
    // a try, and the last burns the knock with the invite)
    if (r.err && r.err.reason === 'ADMIT_WAITING' && pin !== undefined) {
      const bad = checkPin(cur, key, secret, inv, { pin, proven: adm.machine, name: adm.name, burn: { [slot]: { ...adm, burnt_at: iso(now) } }, now });
      if (bad) return bad;
      const at = iso(now);
      const name = alt ?? adm.name;
      const ok: AdmissionRecord = { ...adm, name, ...(alt ? { asked_as: adm.name } : {}), admit: 'let-in', admitted_at: at, admitted_by: 'pin', admitted_until: at, used_at: at };
      return { err: null, adm: ok, next: { ...cur, [slot]: ok }, made: { id: adm.link, machine: adm.machine, seats: [name], key: adm.kind === 'ws' ? adm.key : null } };
    }
    if (r.err) return { err: r.err, ...(r.next ? { next: { ...cur, [slot]: r.next } } : {}) };
    return {
      err: null, adm, next: { ...cur, [slot]: { ...adm, used_at: iso(now) } },
      made: { id: adm.link, machine: adm.machine, seats: [adm.name], key: adm.kind === 'ws' ? adm.key : null },
    };
  }
  if (now > Date.parse(inv.expires_at)) {
    return { next: { ...cur, [key]: { ...inv, burnt_at: iso(now) } }, err: authError('this invite expired (it lasts 15 minutes); ask the host for a new one', 'INVITE_EXPIRED') };
  }
  const needed = (more = ''): RoomError => authError(`the host's machine has this invite (${left(inv.tries)})${more}: type the 4-digit PIN they told you`, 'PIN_NEEDED');
  // no PIN and no knock (an older joiner's first hello): it is asked for the PIN, charged nothing
  if (pin === undefined && (!knock || !proven)) return { err: needed() };
  if (!proven) return { err: new RoomError('PROTOCOL', 'a PIN goes only with this machine\'s key, proved in this connection: a newer sub-human does that; update it (/plugin update sub-human)', 'SKEW') };
  if (!as || !NAME_RE.test(as.name)) return { err: new RoomError('INVALID', `${pin === undefined ? 'a knock' : 'a PIN'} goes with the name to join as`) };
  const label = labelOf(as);
  const id = linkId || hostLinks.newLinkId();
  const at = iso(now);
  if (pin === undefined) {
    // a knock: no try spent. A machine that typed a wrong PIN for this invite waits out its backoff, and then only
    // the right PIN gets it in (a miss never turns into a card). Once any machine typed a wrong one, no machine knocks:
    // a guesser that missed on one machine gets no clean card from another
    const src = (inv.sources ?? {})[proven];
    const wait = src ? Date.parse(src.next_at) - now : 0;
    if (wait > 0) return { err: throttled(wait) };
    if (src) return { err: needed(', and this machine typed a wrong PIN for it') };
    if ((inv.wrong ?? 0) > 0 || (inv.next_at && Date.parse(inv.next_at) > now)) return { err: needed(', and a wrong PIN was typed for it: this invite needs its PIN now') };
    // the knock uses the invite (one per invite), and its admission asks the host person's card
    const asked: AdmissionRecord = {
      v: 2, admission: true, from: ref, kind: inv.kind, by: inv.by || null, machine: proven, name: as.name, label,
      key: peerKey, link: id, admit: 'asked', created_at: at, expires_at: iso(now + testMs('SUB_HUMAN_ADMIT_TTL_MS')),
    };
    return {
      next: { ...cur, [key]: { ...inv, used_at: at, link: id }, [admissionSlot(secret)]: asked },
      err: new RoomError('OFFLINE', `${admission.WAITING}; the link keeps trying`, 'ADMIT_WAITING'),
    };
  }
  const bad = checkPin(cur, key, secret, inv, { pin, proven, name: as.name, now });
  if (bad) return bad;
  // the right PIN: let in by it, and linked in this hello (no card). A name that sits here from another machine is let
  // in as the free one (admission.ts taken), as the card would; admit_sig stays unset (no person signed)
  const adm: AdmissionRecord = {
    v: 2, admission: true, from: ref, kind: inv.kind, by: inv.by || null, machine: proven, name: alt ?? as.name, ...(alt ? { asked_as: as.name } : {}), label,
    key: peerKey, link: id, admit: 'let-in', created_at: at, expires_at: at, admitted_at: at, admitted_by: 'pin', admitted_until: at, used_at: at,
  };
  const next = { ...cur, [key]: { ...inv, used_at: at, link: id }, [admissionSlot(secret)]: adm };
  return { next, err: null, adm, made: { id, machine: proven, seats: [adm.name], key: inv.kind === 'ws' ? peerKey : null } };
}

function redeemInvite(store: AuthStore, secret: string, { machine, pin, knock = false, proven = null, peerKey = null, as = null, newId, now = Date.now() }: {
  machine: MachineId; pin?: unknown; knock?: boolean; proven?: MachineId | null; peerKey?: string | null; as?: Asked | null; newId?: string; now?: number;
}): Redeemed {
  const key = sha256(secret);
  // the name a right PIN lets in when the one asked for sits here from another machine (read before the update's lock)
  const alt = pin !== undefined && proven && as ? admission.taken(store.code, { name: as.name, machine: proven }) : null;
  // set in the update (a property, so the closure's writes are seen after it)
  const got: { link: { id: string; seats: string[]; bound: boolean; machine: MachineId; key: string | null } | null; err: RoomError | null; adm: AdmissionRecord | null } = { link: null, err: null, adm: null };
  store.kv.update(INVITES_KEY, (stored: Invites | null) => {
    got.err = null;
    const cur = stored ?? {};
    const inv = cur[key];
    if (inv && inv.short) {
      const r = redeemShort(cur, key, secret, inv, { pin, knock, proven, peerKey, as, alt, linkId: newId, now });
      got.err = r.err;
      if (r.made) { got.adm = r.adm; got.link = { ...r.made, bound: true }; } // made: with the admission it came from
      return r.next;
    }
    if (inv && inv.burnt_at) throw authError('this invite no longer works (too many wrong PINs, expired, or cancelled); ask the host for a new one', 'INVITE_BURNT');
    if (inv && inv.used_at) throw authError('this invite was used already (each invite works once); ask the host for a new one', 'INVITE_USED');
    throw authError('this invite is unknown or was used already; ask the host for a new one', 'INVITE_UNKNOWN'); // an admission's key is never a secret's
  });
  const { link: l, err, adm } = got;
  if (err) throw err;
  if (!l) throw new Error('the invites update ended with no link and no error'); // every path without err sets link
  // an admission's machine: the one its joiner's machine key proves, else the reported one, checked
  const made = hostLinks.create(store, { id: l.id, machine: l.machine, seats: l.seats, bound: l.bound, label: machine, key: l.key, check: !!adm && !proven, now });
  return { ...made, ...(adm ? { admission: adm } : {}) };
}

/**
 * An invite line to this room: 16 random bytes the line carries, and a 4-digit PIN the host person tells apart; the
 * host keeps sha256(secret) as the record's key and sha256(secret:PIN), so its own store gives the PIN to nobody who
 * lacks the line. by: the seat whose card admits the joiner (null: any seat of the host's machine).
 */
function mintInvite(store: AuthStore, { kind, locator, by = null, now = Date.now() }: {
  kind: string; locator: string; by?: string | null; now?: number;
}): { secret: Buffer; pin: Pin; ref: string; expires_at: string } {
  if (!store.isHost) throw new RoomError('HOST_ONLY', 'only the host of a room mints its invites');
  if (!(KINDS as readonly string[]).includes(kind)) throw new RoomError('INVALID', `no invite over "${kind}"`);
  const raw = crypto.randomBytes(16);
  const secret = raw.toString('base64url');
  const pin = newPin();
  const made: { out: { ref: string; expires_at: string } | null } = { out: null }; // set in the update
  store.kv.update(INVITES_KEY, (cur: Invites | null) => {
    const live = Object.values(cur ?? {}).filter(i => inviteOpen(i, now));
    if (live.length >= SHORT_LIVE_MAX) {
      throw new RoomError('INVALID', `${live.length} invites to room ${store.code} are open already; wait until one is used or expires, or cancel one (/sub-human invite --cancel REF)`);
    }
    const rec: ShortInvite = { v: 4, short: true, kind: kind as ShortKind, locator, by, created_at: iso(now), expires_at: iso(now + INVITE_TTL_MS), tries: INVITE_PIN_TRIES, pin_sha256: pinDigest(secret, pin) };
    made.out = { ref: inviteRef(secret), expires_at: rec.expires_at };
    return { ...cur, [sha256(secret)]: rec };
  });
  if (!made.out) throw new Error('the invites update did not run'); // it ran (or threw)
  return { secret: raw, pin, ...made.out };
}

const inviteRef = (secret: string): string => sha256(secret).slice(0, 12);

/** The invite of this room whose ref (inviteRef, 12 hex) is ref, or null: none, or more than one. */
function findInvite(store: AuthStore, ref: unknown): { key: string; invite: InviteRecord } | null {
  if (!REF_RE.test(String(ref))) return null;
  const hit = Object.entries(store.kv.get<Invites>(INVITES_KEY, null) ?? {}).filter(([k]) => k.startsWith(ref as string)); // ref: 12 hex (REF_RE)
  const [only] = hit;
  return hit.length === 1 && only ? { key: only[0], invite: only[1] } : null;
}

/**
 * Burn one invite by its ref, so it never redeems (a leaked one). {state}: 'burnt' (now), 'burnt already', or 'used'
 * (it became a link: host-links.ts revokeLink ends that). AUTH for no invite with that ref.
 */
function burnInvite(store: AuthStore, ref: string, { now = Date.now() }: { now?: number } = {}): { state: 'used' | 'burnt already' | 'burnt'; invite: InviteRecord } {
  if (!store.isHost) throw new RoomError('HOST_ONLY', 'only the host of a room revokes its invites');
  const burnt: { out: { state: 'used' | 'burnt already' | 'burnt'; invite: InviteRecord } | null } = { out: null }; // set in the update
  store.kv.update(INVITES_KEY, (cur: Invites | null) => {
    const hit = Object.entries(cur ?? {}).filter(([k]) => REF_RE.test(String(ref)) && k.startsWith(ref));
    const [only] = hit;
    if (hit.length !== 1 || !only) throw new RoomError('AUTH', `no invite of room ${store.code} has the ref ${ref}`, 'INVITE_UNKNOWN');
    const [slot, inv] = only;
    if (inv.used_at) { burnt.out = { state: 'used', invite: inv }; return undefined; }
    if (inv.burnt_at) { burnt.out = { state: 'burnt already', invite: inv }; return undefined; }
    const invite: InviteRecord = { ...inv, burnt_at: iso(now) };
    burnt.out = { state: 'burnt', invite };
    return { ...cur, [slot]: invite };
  });
  if (!burnt.out) throw new Error('the invites update did not run'); // it ran (or threw)
  return burnt.out;
}

/** Burn every invite reserved for link id (an admission waiting for the card): how many. */
function burnFor(store: AuthStore, id: string, { now = Date.now() }: { now?: number } = {}): number {
  let n = 0;
  store.kv.update(INVITES_KEY, (cur: Invites | null) => {
    n = 0;
    const next: Invites = { ...cur };
    for (const [k, inv] of Object.entries(cur ?? {})) {
      if (inv && inv.link === id && !inv.burnt_at) { next[k] = { ...inv, burnt_at: iso(now) }; n++; }
    }
    return n ? next : undefined;
  });
  return n;
}

/** Whether an invite reserves link id (an admission, before its redemption). */
const reserves = (store: AuthStore, id: string): boolean => Object.values(store.kv.get<Invites>(INVITES_KEY, null) ?? {}).some(inv => inv.link === id);

export {
  SHORT_PIN_RE, INVITES_KEY, redeemInvite, inviteRef, findInvite,
  burnInvite, burnFor, reserves, mintInvite, inviteOpen, admissionSlot, isPin, isShortPin,
};
export type { Redeemed, Asked };
