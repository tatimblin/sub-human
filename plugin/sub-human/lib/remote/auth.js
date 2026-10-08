'use strict';
/**
 * plugin/sub-human/lib/remote/auth.js: invites and link tokens, on the host. An invite is single-use and turns
 * into a link token at the first hello; the token is the link's credential from then on. The host stores
 * only sha256 digests (kv documents remote/invites and remote/links of the room's store; host-only, never
 * streamed). The client keeps the token in clear in its link file (lib/room/links.js), the same trust as its
 * seat key. "Write as yourself": a link may write only as the seats that joined over it, and joins a seat only
 * with a proof signed by that seat's key. Zero dependencies beyond node:crypto and the envelope.
 *
 *   mintInvite(store, {locator, now?}) -> {invite, secret}   an sh1 invite: formatInvite({code, locator, secret});
 *                                                  records sha256(secret) with created_at. Host only (HOST_ONLY)
 *   mintInvite(store, {locator, pin: true, hostKey?, now?}) -> {invite, secret, pin, expires_at}   an sh2 invite and
 *                                                  its PIN (6 digits, never in the invite): the record adds v: 2,
 *                                                  pin_sha256 = sha256(secret:pin) (the host keeps neither in clear),
 *                                                  tries: INVITE_PIN_TRIES and expires_at (INVITE_TTL_MS). hostKey: the
 *                                                  host's Ed25519 public key (32 bytes, base64url) the joiner pins
 *   redeemInvite(store, secret, {machine, pin?, linkId?, now?}) -> {token, link}   marks the invite used (an unknown,
 *                                                  used or burnt one is AUTH), records {id, token_sha256, machine,
 *                                                  seats: [], created_at}; id is the one reserveLink gave the invite, if
 *                                                  any. linkId (an SSH forced command's --link): AUTH, and the invite
 *                                                  stays unused, unless the invite was reserved for that link. An sh2
 *                                                  invite also needs its PIN, checked here (online, by the host only):
 *                                                  past expires_at it burns; a wrong PIN costs a try, the last one burns
 *                                                  it. Each is AUTH saying what is left; error.note is the room line
 *   reserveLink(store, secret) -> id               the link id an invite will redeem to, fixed now (kept on the
 *                                                  invite record): `sub-human authorize` names it in the forced
 *                                                  command before the invite is used. AUTH for an unknown invite
 *   inviteRef(secret) -> string                    the invite's short public name: 12 hex of sha256(secret), the
 *                                                  start of its record's key (an admit request carries it, not the secret)
 *   reserveRef(store, ref, {now?}) -> {id, invite}   reserveLink by ref, for `admit`: AUTH for an unknown, used,
 *                                                  burnt or expired invite
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
 *   PIN_RE                                         /^[0-9]{6}$/
 */

const crypto = require('node:crypto');
const { RoomError } = require('../room/validate.js');
const envelope = require('../room/envelope.js');
const { CODE_RE } = require('../text.js');
const { INVITE_TTL_MS, INVITE_PIN_TRIES } = require('../config.js');

const INVITE_PREFIX = 'sh1';
const INVITE2_PREFIX = 'sh2';
const PIN_RE = /^[0-9]{6}$/;
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
 * @param {import('../room/store.js').FsRoomStore} store   the host's store (isHost)
 * @param {{locator: string, now?: number}} opts   locator: the transport spec the invite points at
 * @returns {{invite: string, secret: string}}
 */
function mintInvite(store, { locator, pin: withPin = false, hostKey = null, now = Date.now() }) {
  if (!store.isHost) throw new RoomError('HOST_ONLY', 'only the host of a room mints its invites');
  if (!withPin) {
    const secret = random();
    store.kv.update(INVITES_KEY, cur => ({ ...cur, [sha256(secret)]: { created_at: iso(now) } }));
    return { invite: formatInvite({ code: store.code, locator, secret }), secret };
  }
  if (hostKey !== null && !HOST_KEY_RE.test(String(hostKey))) throw new RoomError('INVALID', 'hostKey must be an Ed25519 public key, 32 bytes base64url');
  const secret = crypto.randomBytes(16).toString('base64url'); // 128 bits
  const pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const rec = { v: 2, created_at: iso(now), expires_at: iso(now + INVITE_TTL_MS), tries: INVITE_PIN_TRIES, pin_sha256: pinDigest(secret, pin) };
  store.kv.update(INVITES_KEY, cur => ({ ...cur, [sha256(secret)]: rec }));
  return { invite: formatInvite({ v: 2, code: store.code, locator, secret, hostKey }), secret, pin, expires_at: rec.expires_at };
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
    return { next: burnt, err: refused('wrong PIN, and that was the last try: the invite is burnt; ask the host for a new one', 'an invite was burnt after its last wrong PIN') };
  }
  const msg = typeof pin === 'string'
    ? `wrong PIN (${left(tries)}); type /sub-human join NAME INVITE PIN again with the PIN the host gave you`
    : 'this invite needs its PIN: /sub-human join NAME INVITE PIN';
  return { next: { ...inv, tries }, err: refused(msg, `a wrong PIN for an invite (${left(tries)})`) };
}

/**
 * @param {import('../room/store.js').FsRoomStore} store
 * @param {string} secret
 * @param {{machine: string, now?: number}} opts
 * @returns {{token: string, link: object}}
 */
function redeemInvite(store, secret, { machine, linkId, pin, now = Date.now() }) {
  const key = sha256(secret);
  const link = { id: null, token_sha256: null, machine, seats: [], created_at: iso(now) };
  let err = null;
  store.kv.update(INVITES_KEY, cur => {
    err = null;
    const inv = cur && cur[key];
    if (!inv || inv.used_at || inv.burnt_at) throw new RoomError('AUTH', 'this invite is unknown or was used already; ask the host for a new one');
    if (linkId !== undefined && inv.link !== linkId) throw new RoomError('AUTH', `this invite is not for link ${linkId}`);
    if (inv.v === 2) {
      const r = checkPin(inv, secret, pin, now);
      if (r.err) { err = r.err; return { ...cur, [key]: r.next }; }
    }
    link.id = inv.link || newLinkId();
    return { ...cur, [key]: { ...inv, used_at: iso(now), link: link.id } };
  });
  if (err) throw err;
  const token = random();
  link.token_sha256 = sha256(token);
  store.kv.update(LINKS_KEY, cur => ({ ...cur, [link.id]: link }));
  return { token, link };
}

/**
 * @param {import('../room/store.js').FsRoomStore} store   the host's store (isHost)
 * @param {string} secret
 * @returns {string}
 */
function reserveLink(store, secret) {
  if (!store.isHost) throw new RoomError('HOST_ONLY', 'only the host of a room authorizes its links');
  const key = sha256(secret);
  let id = null;
  store.kv.update(INVITES_KEY, cur => {
    const inv = cur && cur[key];
    if (!inv) throw new RoomError('AUTH', 'this invite is unknown; mint one with sub-human invite');
    id = inv.link || newLinkId();
    return inv.link ? undefined : { ...cur, [key]: { ...inv, link: id } };
  });
  return id;
}

/**
 * @param {import('../room/store.js').FsRoomStore} store
 * @param {string} id
 * @returns {boolean}
 */
function linkKnown(store, id) {
  if (typeof id !== 'string' || !LINK_ID_RE.test(id)) return false;
  if ((store.kv.get(LINKS_KEY, null) || {})[id]) return true;
  return Object.values(store.kv.get(INVITES_KEY, null) || {}).some(inv => inv.link === id);
}

/**
 * @param {import('../room/store.js').FsRoomStore} store
 * @param {string} token
 * @returns {object | null}
 */
function verifyToken(store, token) {
  if (typeof token !== 'string' || !token) return null;
  const digest = sha256(token);
  return Object.values(store.kv.get(LINKS_KEY, null) || {}).find(l => l.token_sha256 === digest) || null;
}

/**
 * @param {import('../room/store.js').FsRoomStore} store
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
  if (!ok) throw new RoomError('AUTH', `a join needs a fresh proof signed by ${name}'s seat key`);
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
 * @param {import('../room/store.js').FsRoomStore} store   the host's store (isHost)
 * @param {string} ref
 * @param {{now?: number}} [opts]
 * @returns {{id: string, invite: object}}
 */
function reserveRef(store, ref, { now = Date.now() } = {}) {
  if (!store.isHost) throw new RoomError('HOST_ONLY', 'only the host of a room admits its links');
  let out = null;
  store.kv.update(INVITES_KEY, cur => {
    const hit = Object.keys(cur || {}).filter(k => REF_RE.test(String(ref)) && k.startsWith(ref));
    const inv = hit.length === 1 ? cur[hit[0]] : null;
    if (!inv) throw new RoomError('AUTH', 'no invite of this room matches that request; mint a new one with /sub-human host');
    if (inv.used_at || inv.burnt_at) throw new RoomError('AUTH', 'that invite was used or burnt already; mint a new one with /sub-human host');
    if (inv.expires_at && now > Date.parse(inv.expires_at)) throw new RoomError('AUTH', 'that invite expired; mint a new one with /sub-human host');
    const id = inv.link || newLinkId();
    out = { id, invite: { ...inv, link: id } };
    return inv.link ? undefined : { ...cur, [hit[0]]: out.invite };
  });
  return out;
}

/**
 * @param {import('../room/store.js').FsRoomStore} store   the host's store (isHost)
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
      if (inv && inv.link === id && !inv.burnt_at) { next[k] = { ...inv, burnt_at: iso(now) }; invites++; }
    }
    return invites ? next : undefined;
  });
  return link || invites ? { link, invites } : null;
}

/** @returns {Object<string, object>} */
const links = store => store.kv.get(LINKS_KEY, null) || {};

module.exports = {
  INVITE_PREFIX, INVITE2_PREFIX, PIN_RE, inviteRef, reserveRef, revokeLink, links, INVITES_KEY, LINKS_KEY, LINK_ID_RE, mintInvite, redeemInvite, reserveLink, linkKnown, verifyToken, bindSeat, mayWriteAs, proveSeat, checkSeatProof,
  formatInvite, parseInvite,
};
