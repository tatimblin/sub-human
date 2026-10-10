/**
 * plugin/sub-human/lib/remote/auth.ts: invites and link tokens, on the host. An invite is single-use and turns
 * into a link token at the first hello; the token is the link's credential from then on. The host stores
 * only sha256 digests (kv documents remote/invites and remote/links of the room's store; host-only, never
 * streamed). The client keeps the token in clear in its link file (lib/room/links.ts), the same trust as its
 * seat key. "Write as yourself": a link may write only as the seats that joined over it, and joins a seat only
 * with a proof signed by that seat's key. Zero dependencies beyond node:crypto and the envelope.
 *
 *   mintInvite(store, {locator, now?}) -> {invite, secret}   an sh1 invite: formatInvite({code, locator, secret});
 *                                                  records sha256(secret) with created_at. Host only (HOST_ONLY).
 *                                                  Internal: no command mints one any more; a 0.2.0 joiner still
 *                                                  links with one (the sub-human lab), and the tests use it
 *   mintFor(store, {locator, machine, seats, pin?, hostKey?, now?}) -> {invite, secret, pin?}   a handoff's sh2 invite (lib/handoff.ts) for
 *                                                  one machine (hostKey: a ws/wss next host's listener key, pinned),
 *                                                  minted by the room's next host before it is the host
 *                                                  (so no HOST_ONLY check) and carried to that machine over its
 *                                                  existing authenticated link, so it needs no PIN: the record is
 *                                                  {v: 2, handoff: true, machine, seats, expires_at (HANDOFF_INVITE_MS)};
 *                                                  only that machine may redeem it, and its link starts with those
 *                                                  seats bound (they joined the room already; their keys are pinned).
 *                                                  pin: true (a promote's invites, handed out by hand): an sh2 PIN record
 *                                                  (6 digits, never in the invite; pin_sha256 = sha256(secret:pin),
 *                                                  INVITE_TTL_MS, INVITE_PIN_TRIES) with the same binding
 *   redeemInvite(store, secret, {machine, pin?, linkId?, now?}) -> {token, link, handoff}   marks the invite used (an unknown,
 *                                                  used or burnt one is AUTH, saying which), records {id, token_sha256, machine,
 *                                                  seats, created_at}; id is the one reserveLink gave the invite, if
 *                                                  any. linkId (an SSH forced command's --link): AUTH, and the invite
 *                                                  stays unused, unless the invite was reserved for that link. An sh2
 *                                                  invite also needs its PIN, checked here (online, by the host only):
 *                                                  past expires_at it burns; a wrong PIN costs a try, the last one burns
 *                                                  it. Each is AUTH saying what is left; error.note is the room line.
 *                                                  A handoff invite needs no PIN: only its machine, before expires_at
 *   loginLink(store, {id, machine, now?}) -> {token, link}   a link for a connection that arrived over the host
 *                                                  account's own ssh login (`serve --login`, lib/remote/server.ts): no
 *                                                  invite, since whoever can run commands as this account may mint one
 *                                                  anyway. Records {id, token_sha256, machine, seats: [], created_at,
 *                                                  login: true} under the id the joiner chose (its serve's --link, so
 *                                                  revoke finds the process). AUTH for an id the room knows already
 *   reserveLink(store, secret) -> id               the link id an invite will redeem to, fixed now (kept on the
 *                                                  invite record), so a forced command can name it before the
 *                                                  invite is used (an sh1 invite, internal: a 0.2.0 joiner's way in,
 *                                                  set up by the sub-human lab). AUTH for an unknown invite
 *   inviteRef(secret) -> string                    the invite's short public name: 12 hex of sha256(secret), the
 *                                                  start of its record's key
 *   findInvite(store, ref) -> {key, invite} | null   the one invite whose ref is ref
 *   burnInvite(store, ref, {now?}) -> {state, invite}   burn one unused invite by its ref (a leaked one); state
 *                                                  'burnt', 'burnt already' or 'used' (then nothing changes). AUTH
 *                                                  for no invite with that ref
 *   revokeLink(store, id, {now?}) -> {link, invites} | null   forget link id (its token stops working) and burn
 *                                                  every invite reserved for it; null when nothing had that id
 *   links(store) -> {id: link}                     the links of the room
 *   linkKnown(store, id) -> bool                   a link, or an invite's reserved link, with that id
 *   verifyToken(store, token) -> link | null       the link record for a presented token
 *   bindSeat(store, linkId, name) -> link          name joined over this link (AUTH for an unknown link)
 *   mayWriteAs(link, name) -> bool                 name is one of link.seats
 *   proveSeat(key, {room, name, pubkey}) -> proof  the remote hook's half (it holds the seat's private key):
 *                                                  {kind: 'join', pubkey} signed (sig v2) for room and name
 *   checkSeatProof(proof, {room, name, pubkey})    the server's half: AUTH unless proof is a fresh join proof for
 *                                                  this room, name and pubkey that verifies against pubkey, so
 *                                                  a link cannot take a seat with a public key alone
 *   formatInvite({code, locator, secret, v?, hostKey?}) -> "sh1.<code>.<locator-base64url>.<secret>", or with v 2
 *                                                  "sh2.<code>.<locator-base64url>.<secret>.<hostKey | 0>"
 *   parseInvite(text) -> {v, code, locator, secret, hostKey} | null   either; hostKey null for none (sh1, or "0")
 *   Short invites (a 4-digit PIN, the whole secret; lib/remote/enroll.ts runs CPace with it):
 *   mintShort(store, {kind, locator, hostKey?, by?, doorFile?, now?}) -> {pin, ref, expires_at}   record {v: 3, short,
 *                                                  kind, locator, host_key, by, door_file, tries, expires_at, prs: the
 *                                                  PIN (CPace needs it in clear; dropped when used, burnt or revoked)};
 *                                                  at most SHORT_LIVE_MAX open per room. Host only
 *   startShort(store, {kind, now?}) -> [{key, ref, prs, hostKey, kind, by}]   the open invites of that kind with a try
 *                                                  left, each charged a try now (before the host answers the attempt)
 *   failShort(store, keys, {now?}) -> {left, burnt}   a wrong PIN: invites at 0 tries burn
 *   enrollShort(store, key, {tried, joiner, now?, admitMs?}) -> {secret, id, ref, expires_at}   the PIN held: the
 *                                                  invite is used, the others tried get their try back, and an
 *                                                  admission record {v: 2, admission, machine, name, label, key, link,
 *                                                  admit: 'asked', by, door_file} keyed by a new secret the joiner gets
 *   shortLive(invite, now?) -> bool                open, and a try left or an attempt in flight
 *   admissions(store, {now?, all?}) -> [{slot, ref, ...}]   the join requests waiting for the host person (slot: the
 *                                                  record's kv key; key is the joiner's ssh link key)
 *   decideAdmission(store, ref, {decision: 'let-in' | 'refused', by?, sig?, now?}) -> record   the person's answer
 *   lapseAdmissions(store, {now?}) -> [record]     burn the requests nobody answered in ADMIT_TTL_MS
 *   An admission record redeems (redeemInvite, no PIN) only on its machine, once let in (OFFLINE "waiting" before,
 *   AUTH once refused, lapsed or revoked); the result carries admission: the record
 *   PIN_RE                                         /^[0-9]{6}$/, an sh2 invite's PIN (a promote's invites, handed out by hand)
 *   SHORT_PIN_RE                                   /^[0-9]{4}$/, a short invite's PIN
 *   INVITE_PREFIX, INVITE2_PREFIX                  'sh1', 'sh2'
 *   INVITES_KEY, LINKS_KEY                         the host documents remote/invites, remote/links (by sha256)
 *   LINK_ID_RE                                     /^[0-9a-f]{12}$/, a link id
 */

import crypto from 'node:crypto';
import { RoomError } from '../room/validate.ts';
import * as envelope from '../room/envelope.ts';
import { CODE_RE } from '../text.ts';
import {
  INVITE_TTL_MS, INVITE_PIN_TRIES, HANDOFF_INVITE_MS, SHORT_LIVE_MAX, ENROLL_MS, ADMIT_TTL_MS,
} from '../config.ts';

const INVITE_PREFIX = 'sh1';
const INVITE2_PREFIX = 'sh2';
const PIN_RE = /^[0-9]{6}$/;
const SHORT_PIN_RE = /^[0-9]{4}$/;
const HOST_KEY_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url
const REF_RE = /^[0-9a-f]{12}$/;
const INVITES_KEY = 'remote/invites';
const LINKS_KEY = 'remote/links';
const SECRET_RE = /^[A-Za-z0-9_-]{16,128}$/;
const LINK_ID_RE = /^[0-9a-f]{12}$/;
const newLinkId = () => crypto.randomBytes(6).toString('hex');

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const random = () => crypto.randomBytes(24).toString('base64url');
const iso = now => new Date(now).toISOString();

/**
 * @param {import('../room/store.ts').FsRoomStore} store   the host's store (isHost)
 * @param {{locator: string, now?: number}} opts   locator: the transport spec the invite points at
 * @returns {{invite: string, secret: string}}
 */
function mintInvite(store, { locator, now = Date.now() }) {
  if (!store.isHost) throw new RoomError('HOST_ONLY', 'only the host of a room mints its invites');
  const secret = random();
  store.kv.update(INVITES_KEY, cur => ({ ...cur, [sha256(secret)]: { created_at: iso(now) } }));
  return { invite: formatInvite({ code: store.code, locator, secret }), secret };
}

const pinDigest = (secret, pin) => sha256(`${secret}:${pin}`);
const sameDigest = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length
  && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const left = n => `${n} ${n === 1 ? 'try' : 'tries'} left`;
const refused = (msg, note) => Object.assign(new RoomError('AUTH', msg), { note });

/** The PIN check of an sh2 record, inside the invites update: {next record, err to throw after} (err null: it holds). */
function checkPin(inv, secret, pin, now) {
  const burnt = { ...inv, burnt_at: iso(now) };
  if (now > Date.parse(inv.expires_at)) {
    return { next: burnt, err: refused('this invite expired (an invite with a PIN lasts 15 minutes); ask the host for a new one', null) };
  }
  if (typeof pin === 'string' && PIN_RE.test(pin) && sameDigest(pinDigest(secret, pin), inv.pin_sha256)) return { next: null, err: null };
  const tries = Math.max(0, (Number(inv.tries) || 0) - 1);
  if (!tries) {
    return { next: burnt, err: refused('wrong PIN, and that was the last try: this invite no longer works. Ask the host for a new one (/sub-human invite on their side)', 'an invite was burnt after its last wrong PIN') };
  }
  const msg = typeof pin === 'string'
    ? `wrong PIN (${left(tries)}). Check the digits with the host, then type the join line again`
    : 'this invite needs its PIN';
  return { next: { ...inv, tries }, err: refused(msg, `a wrong PIN for an invite (${left(tries)})`) };
}

/**
 * @param {import('../room/store.ts').FsRoomStore} store   the room's next host's store (a mirror until it is the host)
 * @param {{locator: string, machine: string, seats: string[], now?: number}} opts
 * @returns {{invite: string, secret: string}}
 */
function mintFor(store, { locator, machine, seats, pin: withPin = false, hostKey = null, now = Date.now() }) {
  if (hostKey !== null && !HOST_KEY_RE.test(String(hostKey))) throw new RoomError('INVALID', 'hostKey must be a 32-byte public key, base64url');
  const secret = crypto.randomBytes(16).toString('base64url'); // 128 bits, as any sh2 secret
  const bound = { created_at: iso(now), machine, seats: [...seats] };
  if (!withPin) {
    const rec = { v: 2, handoff: true, ...bound, expires_at: iso(now + HANDOFF_INVITE_MS) };
    store.kv.update(INVITES_KEY, cur => ({ ...cur, [sha256(secret)]: rec }));
    return { invite: formatInvite({ v: 2, code: store.code, locator, secret, hostKey }), secret };
  }
  const pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const rec = { v: 2, ...bound, expires_at: iso(now + INVITE_TTL_MS), tries: INVITE_PIN_TRIES, pin_sha256: pinDigest(secret, pin) };
  store.kv.update(INVITES_KEY, cur => ({ ...cur, [sha256(secret)]: rec }));
  return { invite: formatInvite({ v: 2, code: store.code, locator, secret, hostKey }), secret, pin, expires_at: rec.expires_at };
}

/**
 * @param {import('../room/store.ts').FsRoomStore} store
 * @param {string} secret
 * @param {{machine: string, now?: number}} opts
 * @returns {{token: string, link: object, handoff: boolean}}
 */
function redeemInvite(store, secret, { machine, linkId, pin, now = Date.now() }) {
  const key = sha256(secret);
  const link = { id: null, token_sha256: null, machine, seats: [], created_at: iso(now) };
  let err = null, handoff = false, admission = null;
  store.kv.update(INVITES_KEY, cur => {
    err = null;
    const inv = cur && cur[key];
    handoff = !!(inv && inv.handoff);
    admission = inv && inv.admission ? inv : null;
    if (admission) {
      const r = admissionCheck(inv, { machine, linkId, now });
      if (r.err) { err = r.err; return r.next ? { ...cur, [key]: r.next } : undefined; }
      link.id = inv.link;
      return { ...cur, [key]: { ...inv, used_at: iso(now) } };
    }
    if (inv && inv.burnt_at) throw new RoomError('AUTH', 'this invite no longer works (too many wrong PINs, expired, or cancelled); ask the host for a new one');
    if (inv && inv.used_at) throw new RoomError('AUTH', 'this invite was used already (each invite works once); ask the host for a new one');
    if (!inv) throw new RoomError('AUTH', 'this invite is unknown or was used already; ask the host for a new one');
    if (linkId !== undefined && inv.link !== linkId) throw new RoomError('AUTH', 'this invite is for another connection');
    if (inv.machine && inv.machine !== machine) throw new RoomError('AUTH', 'this invite is for another machine');
    if (inv.v === 2 && inv.handoff) {
      if (now > Date.parse(inv.expires_at)) throw new RoomError('AUTH', 'this handoff invite expired; ask the new host for a new one');
    } else if (inv.v === 2) {
      const r = checkPin(inv, secret, pin, now);
      if (r.err) { err = r.err; return { ...cur, [key]: r.next }; }
    }
    link.id = inv.link || newLinkId();
    if (Array.isArray(inv.seats)) link.seats = [...inv.seats];
    return { ...cur, [key]: { ...inv, used_at: iso(now), link: link.id } };
  });
  if (err) throw err;
  const token = random();
  link.token_sha256 = sha256(token);
  store.kv.update(LINKS_KEY, cur => ({ ...cur, [link.id]: link }));
  return { token, link, handoff, ...(admission ? { admission } : {}) };
}

/** An admission record's redemption (a short invite's joiner, after the host person let it in): {err, next?}. */
function admissionCheck(inv, { machine, linkId, now }) {
  if (inv.used_at) return { err: new RoomError('AUTH', 'this machine\'s join was used already; ask the host for a new invite') };
  if (inv.admit === 'refused') return { err: new RoomError('AUTH', 'the host refused to let this machine in') };
  if (inv.burnt_at) return { err: new RoomError('AUTH', inv.admit === 'lapsed' ? 'the host did not let this machine in in time; ask them for a new invite' : 'the host revoked this join; ask them for a new invite') };
  if (inv.machine !== machine) return { err: new RoomError('AUTH', 'this join is for another machine') };
  if (linkId !== undefined && inv.link !== linkId) return { err: new RoomError('AUTH', 'this join is for another connection') };
  if (inv.admit !== 'let-in') {
    if (now > Date.parse(inv.expires_at)) return { err: new RoomError('AUTH', 'the host did not let this machine in in time; ask them for a new invite') }; // lapseAdmissions burns it, with a line
    return { err: new RoomError('OFFLINE', `${WAITING}; the link keeps trying`) };
  }
  if (now > Date.parse(inv.admitted_until)) return { err: new RoomError('AUTH', 'this machine was let in, but did not connect in time; ask the host for a new invite'), next: { ...inv, burnt_at: iso(now) } };
  return { err: null };
}

// ---------- short invites: a 4-digit PIN (lib/remote/enroll.ts) ----------
const WAITING = 'waiting for the host to let this machine in';
const shortOpen = (inv, now) => !!inv && inv.short === true && !inv.used_at && !inv.burnt_at && now <= Date.parse(inv.expires_at);
/** A short invite that can still be used: open, with a try left or an attempt still in flight (ENROLL_MS). */
const shortLive = (inv, now = Date.now()) => shortOpen(inv, now)
  && (inv.tries > 0 || (!!inv.last_try_at && now - Date.parse(inv.last_try_at) < ENROLL_MS));

/**
 * A short invite to this room: a 4-digit PIN, the whole secret (CPace's password, lib/remote/cpace.ts). The host keeps
 * it in its own store (the record's prs, host-only, never streamed) because CPace needs it in clear; it goes when the
 * invite is used, burnt or revoked. kind: the transport it is for ('ssh', 'ws', 'pipe'); hostKey: what the host attests
 * inside the PAKE (sshd's Ed25519 key for ssh, the listener's X25519 key for ws); by: the seat whose card admits the
 * joiner (null: any seat of the host's machine); doorFile: the authorized_keys file the enrollment door was written to.
 * @returns {{pin: string, ref: string, expires_at: string}}
 */
function mintShort(store, { kind, locator, hostKey = null, by = null, doorFile = null, now = Date.now() }) {
  if (!store.isHost) throw new RoomError('HOST_ONLY', 'only the host of a room mints its invites');
  if (!['ssh', 'ws', 'pipe'].includes(kind)) throw new RoomError('INVALID', `no short invite over "${kind}"`);
  if (hostKey !== null && !HOST_KEY_RE.test(String(hostKey))) throw new RoomError('INVALID', 'hostKey must be a 32-byte public key, base64url');
  let out = null;
  store.kv.update(INVITES_KEY, cur => {
    const live = Object.values(cur || {}).filter(i => shortLive(i, now));
    if (live.length >= SHORT_LIVE_MAX) {
      throw new RoomError('INVALID', `${live.length} short invites to room ${store.code} are open already; wait until one is used or expires, or cancel one (/sub-human invite --cancel REF)`);
    }
    let pin;
    do pin = String(crypto.randomInt(0, 10_000)).padStart(4, '0'); while (live.some(i => i.prs === pin));
    const secret = crypto.randomBytes(16).toString('base64url'); // only its digest names the record; never shown
    const rec = { v: 3, short: true, kind, locator, host_key: hostKey, by, door_file: doorFile, created_at: iso(now), expires_at: iso(now + INVITE_TTL_MS), tries: INVITE_PIN_TRIES, prs: pin };
    out = { pin, ref: inviteRef(secret), expires_at: rec.expires_at };
    return { ...cur, [sha256(secret)]: rec };
  });
  return out;
}

/** The short invites of this room an attempt may try (open, a try left), each charged one try now: [{key, ref, prs, hostKey, kind, by}]. */
function startShort(store, { kind, now = Date.now() }) {
  let out = [];
  store.kv.update(INVITES_KEY, cur => {
    out = [];
    const next = { ...cur };
    const open = Object.entries(cur || {}).filter(([, i]) => shortOpen(i, now) && i.kind === kind && i.tries > 0)
      .sort(([, a], [, b]) => a.created_at.localeCompare(b.created_at)).slice(0, SHORT_LIVE_MAX);
    for (const [k, i] of open) {
      next[k] = { ...i, tries: i.tries - 1, last_try_at: iso(now) };
      out.push({ key: k, ref: k.slice(0, 12), prs: i.prs, hostKey: i.host_key || null, kind: i.kind, by: i.by || null });
    }
    return out.length ? next : undefined;
  });
  return out;
}

/** An attempt that did not hold (a wrong PIN): an invite it spent the last try of burns. {left, burnt} */
function failShort(store, keys, { now = Date.now() } = {}) {
  let left = 0, burnt = 0;
  store.kv.update(INVITES_KEY, cur => {
    left = 0; burnt = 0;
    const next = { ...cur };
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
 * ADMIT_TTL_MS. A redemption then needs admit 'let-in' (admissionCheck).
 * @returns {{secret: string, id: string, ref: string, expires_at: string}}
 */
function enrollShort(store, key, { tried = [], joiner, now = Date.now(), admitMs = ADMIT_TTL_MS }) {
  let out = null;
  store.kv.update(INVITES_KEY, cur => {
    const inv = cur && cur[key];
    if (!shortOpen(inv, now)) throw new RoomError('AUTH', 'this invite was used, burnt or expired meanwhile; ask the host for a new invite');
    const id = newLinkId();
    const secret = crypto.randomBytes(16).toString('base64url');
    const next = { ...cur };
    const { prs, ...rest } = inv;
    next[key] = { ...rest, used_at: iso(now), link: id, enrolled: { at: iso(now), ...joiner } };
    for (const k of tried) {
      const i = cur[k];
      if (k !== key && shortOpen(i, now)) next[k] = { ...i, tries: Math.min(INVITE_PIN_TRIES, i.tries + 1) };
    }
    const rec = {
      v: 2, admission: true, from: key.slice(0, 12), kind: inv.kind, by: inv.by || null, door_file: inv.door_file || null,
      machine: joiner.machine, name: joiner.name, label: joiner.label, key: joiner.key || null, link: id, admit: 'asked',
      created_at: iso(now), expires_at: iso(now + admitMs),
    };
    next[sha256(secret)] = rec;
    out = { secret, id, ref: inviteRef(secret), expires_at: rec.expires_at };
    return next;
  });
  return out;
}

/** The admission records of this room still waiting for the host person: [{key, ref, ...record}], oldest first. */
function admissions(store, { now = Date.now(), all = false } = {}) {
  return Object.entries(store.kv.get(INVITES_KEY, null) || {})
    .filter(([, i]) => i && i.admission && (all || (i.admit === 'asked' && !i.burnt_at && now <= Date.parse(i.expires_at))))
    .map(([k, i]) => ({ ...i, slot: k, ref: k.slice(0, 12) }))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/**
 * The host person's answer to an admission (lib/remote/admission.ts): 'let-in' (the joiner may redeem it for
 * HANDOFF_INVITE_MS) or 'refused' (burnt). AUTH when it is not waiting any more (answered, lapsed, revoked).
 * @returns {object} the record as it is now
 */
function decideAdmission(store, ref, { decision, by = null, sig = null, now = Date.now() }) {
  if (!store.isHost) throw new RoomError('HOST_ONLY', 'only the host of a room lets machines in');
  let out = null;
  store.kv.update(INVITES_KEY, cur => {
    const hit = Object.keys(cur || {}).filter(k => REF_RE.test(String(ref)) && k.startsWith(ref) && cur[k].admission);
    if (hit.length !== 1) throw new RoomError('AUTH', `room ${store.code} has no join request ${ref} (/sub-human admit lists them)`);
    const inv = cur[hit[0]];
    if (inv.admit !== 'asked' || inv.burnt_at) throw new RoomError('AUTH', `that join request was ${inv.admit === 'let-in' ? 'let in already' : inv.admit === 'refused' ? 'refused already' : 'withdrawn (revoked or lapsed)'}`);
    if (now > Date.parse(inv.expires_at)) throw new RoomError('AUTH', 'that join request lapsed; send them a new invite (/sub-human invite)');
    const at = iso(now);
    const next = decision === 'let-in'
      ? { ...inv, admit: 'let-in', admitted_at: at, admitted_by: by, ...(sig ? { admit_sig: sig } : {}), admitted_until: iso(now + HANDOFF_INVITE_MS) }
      : { ...inv, admit: 'refused', refused_at: at, refused_by: by, burnt_at: at };
    out = { ...next, slot: hit[0], ref: hit[0].slice(0, 12) };
    return { ...cur, [hit[0]]: next };
  });
  return out;
}

/** Mark lapsed (burn) every admission past its time that nobody answered; the records that lapsed now. */
function lapseAdmissions(store, { now = Date.now() } = {}) {
  let lapsed = [];
  const due = i => i && i.admission && i.admit === 'asked' && !i.burnt_at && now > Date.parse(i.expires_at);
  if (!Object.values(store.kv.get(INVITES_KEY, null) || {}).some(due)) return lapsed; // a read, no lock, on every tail tick
  store.kv.update(INVITES_KEY, cur => {
    lapsed = [];
    const next = { ...cur };
    for (const [k, i] of Object.entries(cur || {})) {
      if (i && i.admission && i.admit === 'asked' && !i.burnt_at && now > Date.parse(i.expires_at)) {
        next[k] = { ...i, admit: 'lapsed', burnt_at: iso(now) };
        lapsed.push({ ...next[k], slot: k, ref: k.slice(0, 12) });
      }
    }
    return lapsed.length ? next : undefined;
  });
  return lapsed;
}

/**
 * @param {import('../room/store.ts').FsRoomStore} store   the host's store (isHost)
 * @param {{id: string, machine: string, now?: number}} opts
 * @returns {{token: string, link: object}}
 */
function loginLink(store, { id, machine, now = Date.now() }) {
  if (!store.isHost) throw new RoomError('HOST_ONLY', 'only the host of a room links machines to it');
  if (!LINK_ID_RE.test(String(id))) throw new RoomError('INVALID', 'a login link needs its id (12 hex)');
  if (linkKnown(store, id)) throw new RoomError('AUTH', `link ${id} exists already in room ${store.code}; it says hello with its token (join again for a new link)`);
  const token = random();
  const link = { id, token_sha256: sha256(token), machine, seats: [], created_at: iso(now), login: true };
  store.kv.update(LINKS_KEY, cur => {
    if (cur && cur[id]) throw new RoomError('AUTH', `link ${id} exists already in room ${store.code}`);
    return { ...cur, [id]: link };
  });
  return { token, link };
}

/**
 * @param {import('../room/store.ts').FsRoomStore} store   the host's store (isHost)
 * @param {string} secret
 * @returns {string}
 */
function reserveLink(store, secret) {
  if (!store.isHost) throw new RoomError('HOST_ONLY', 'only the host of a room reserves its links');
  const key = sha256(secret);
  let id = null;
  store.kv.update(INVITES_KEY, cur => {
    const inv = cur && cur[key];
    if (!inv) throw new RoomError('AUTH', 'this invite is unknown; make a new one with /sub-human invite');
    id = inv.link || newLinkId();
    return inv.link ? undefined : { ...cur, [key]: { ...inv, link: id } };
  });
  return id;
}

/**
 * @param {import('../room/store.ts').FsRoomStore} store
 * @param {string} id
 * @returns {boolean}
 */
function linkKnown(store, id) {
  if (typeof id !== 'string' || !LINK_ID_RE.test(id)) return false;
  if ((store.kv.get(LINKS_KEY, null) || {})[id]) return true;
  return Object.values(store.kv.get(INVITES_KEY, null) || {}).some(inv => inv.link === id);
}

/**
 * @param {import('../room/store.ts').FsRoomStore} store
 * @param {string} token
 * @returns {object | null}
 */
function verifyToken(store, token) {
  if (typeof token !== 'string' || !token) return null;
  const digest = sha256(token);
  return Object.values(store.kv.get(LINKS_KEY, null) || {}).find(l => l.token_sha256 === digest) || null;
}

/**
 * @param {import('../room/store.ts').FsRoomStore} store
 * @param {string} linkId
 * @param {string} name
 * @returns {object}
 */
function bindSeat(store, linkId, name) {
  const next = store.kv.update(LINKS_KEY, cur => {
    const link = cur && cur[linkId];
    if (!link) throw new RoomError('AUTH', `no link ${linkId} in room ${store.code}`);
    return link.seats.includes(name) ? undefined : { ...cur, [linkId]: { ...link, seats: [...link.seats, name] } };
  });
  return (next || store.kv.get(LINKS_KEY))[linkId];
}

/**
 * @param {{seats?: string[]}} link
 * @param {string} name
 * @returns {boolean}
 */
const mayWriteAs = (link, name) => !!link && Array.isArray(link.seats) && link.seats.includes(name);

/**
 * @param {import('node:crypto').KeyObject} key   the seat's private key
 * @param {{room: string, name: string, pubkey: string}} seat
 * @returns {object}
 */
const proveSeat = (key, { room, name, pubkey }) => envelope.sign({ kind: 'join', pubkey }, key, { room, from: name });

/**
 * @param {object} proof
 * @param {{room: string, name: string, pubkey: string}} seat
 */
function checkSeatProof(proof, { room, name, pubkey }) {
  const ok = !!proof && proof.kind === 'join' && proof.room === room && proof.from === name && proof.pubkey === pubkey
    && envelope.isV2(proof) && envelope.freshTs(proof) && envelope.verify(proof, envelope.parseKey(pubkey));
  if (!ok) throw new RoomError('AUTH', `a join needs a fresh proof signed by ${name}'s own key`);
}

/**
 * @param {{code: string, locator: string, secret: string}} parts
 * @returns {string}
 */
const formatInvite = ({ code, locator, secret, v = 1, hostKey = null }) => (v === 2
  ? [INVITE2_PREFIX, code, Buffer.from(locator).toString('base64url'), secret, hostKey || '0']
  : [INVITE_PREFIX, code, Buffer.from(locator).toString('base64url'), secret]).join('.');

/**
 * @param {string} text
 * @returns {{v: number, code: string, locator: string, secret: string, hostKey: string | null} | null}
 */
function parseInvite(text) {
  const parts = typeof text === 'string' ? text.trim().split('.') : [];
  const v = parts[0] === INVITE2_PREFIX ? 2 : parts[0] === INVITE_PREFIX ? 1 : 0;
  if (!v || parts.length !== (v === 2 ? 5 : 4)) return null;
  const [, code, loc, secret, hk = '0'] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(loc)) return null;
  const locator = Buffer.from(loc, 'base64url').toString('utf8');
  if (!CODE_RE.test(code) || !locator || !SECRET_RE.test(secret)) return null;
  if (v === 2 && hk !== '0' && !HOST_KEY_RE.test(hk)) return null;
  return { v, code, locator, secret, hostKey: hk === '0' ? null : hk };
}

/** @returns {string} */
const inviteRef = secret => sha256(secret).slice(0, 12);

/**
 * @param {import('../room/store.ts').FsRoomStore} store   the host's store (isHost)
 * @param {string} id
 * @param {{now?: number}} [opts]
 * @returns {{link: object | null, invites: number} | null}
 */
function revokeLink(store, id, { now = Date.now() } = {}) {
  if (!store.isHost) throw new RoomError('HOST_ONLY', 'only the host of a room revokes its links');
  let link = null, invites = 0;
  store.kv.update(LINKS_KEY, cur => {
    if (!cur || !cur[id]) return undefined;
    link = cur[id];
    const next = { ...cur };
    delete next[id];
    return next;
  });
  store.kv.update(INVITES_KEY, cur => {
    invites = 0;
    const next = { ...cur };
    for (const [k, inv] of Object.entries(cur || {})) {
      if (inv && inv.link === id && !inv.burnt_at) { const { prs, ...kept } = inv; next[k] = { ...kept, burnt_at: iso(now) }; invites++; }
    }
    return invites ? next : undefined;
  });
  return link || invites ? { link, invites } : null;
}

/**
 * The invite of this room whose ref (inviteRef, 12 hex) is ref, or null: none, or more than one.
 * @param {import('../room/store.ts').FsRoomStore} store
 * @param {string} ref
 * @returns {{key: string, invite: object} | null}
 */
function findInvite(store, ref) {
  if (!REF_RE.test(String(ref))) return null;
  const hit = Object.entries(store.kv.get(INVITES_KEY, null) || {}).filter(([k]) => k.startsWith(ref));
  return hit.length === 1 ? { key: hit[0][0], invite: hit[0][1] } : null;
}

/**
 * Burn one invite by its ref, so it never redeems (a leaked one). {state}: 'burnt' (now), 'burnt already', or
 * 'used' (it became a link: revokeLink ends that). AUTH for no invite with that ref.
 * @param {import('../room/store.ts').FsRoomStore} store   the host's store (isHost)
 * @param {string} ref
 * @param {{now?: number}} [opts]
 * @returns {{state: string, invite: object}}
 */
function burnInvite(store, ref, { now = Date.now() } = {}) {
  if (!store.isHost) throw new RoomError('HOST_ONLY', 'only the host of a room revokes its invites');
  let out = null;
  store.kv.update(INVITES_KEY, cur => {
    const hit = Object.keys(cur || {}).filter(k => REF_RE.test(String(ref)) && k.startsWith(ref));
    if (hit.length !== 1) throw new RoomError('AUTH', `no invite of room ${store.code} has the ref ${ref}`);
    const inv = cur[hit[0]];
    if (inv.used_at) { out = { state: 'used', invite: inv }; return undefined; }
    if (inv.burnt_at) { out = { state: 'burnt already', invite: inv }; return undefined; }
    const { prs, ...kept } = inv; // a short invite's PIN goes with it
    out = { state: 'burnt', invite: { ...kept, burnt_at: iso(now) } };
    return { ...cur, [hit[0]]: out.invite };
  });
  return out;
}

/** @returns {Object<string, object>} */
const links = store => store.kv.get(LINKS_KEY, null) || {};

export {
  INVITE_PREFIX, INVITE2_PREFIX, PIN_RE, SHORT_PIN_RE, inviteRef, findInvite, burnInvite, revokeLink, links,
  INVITES_KEY, LINKS_KEY, LINK_ID_RE, mintInvite, mintFor, redeemInvite, loginLink, reserveLink, linkKnown,
  verifyToken, bindSeat, mayWriteAs, proveSeat, checkSeatProof, formatInvite, parseInvite, mintShort, startShort,
  failShort, enrollShort, shortLive, admissions, decideAdmission, lapseAdmissions, WAITING,
};
