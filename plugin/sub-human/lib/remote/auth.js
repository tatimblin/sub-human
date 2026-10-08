'use strict';
/**
 * plugin/sub-human/lib/remote/auth.js: invites and link tokens, on the host. An invite is single-use and turns
 * into a link token at the first hello; the token is the link's credential from then on. The host stores
 * only sha256 digests (kv documents remote/invites and remote/links of the room's store; host-only, never
 * streamed). The client keeps the token in clear in its link file (lib/room/links.js), the same trust as its
 * seat key. "Write as yourself": a link may write only as the seats that joined over it, and joins a seat only
 * with a proof signed by that seat's key. Zero dependencies beyond node:crypto and the envelope. PR4 of
 * docs/archive/REMOTE-PLAN.md.
 *
 *   mintInvite(store, {locator, now?}) -> {invite, secret}   invite = formatInvite({code, locator, secret});
 *                                                  records sha256(secret) with created_at. Host only (HOST_ONLY)
 *   redeemInvite(store, secret, {machine, now?}) -> {token, link}   marks the invite used (an unknown or used
 *                                                  one is AUTH), records {id, token_sha256, machine, seats: [],
 *                                                  created_at}
 *   verifyToken(store, token) -> link | null       the link record for a presented token
 *   bindSeat(store, linkId, name) -> link          name joined over this link (AUTH for an unknown link)
 *   mayWriteAs(link, name) -> bool                 name is one of link.seats
 *   proveSeat(key, {room, name, pubkey}) -> proof  the remote hook's half (it holds the seat's private key):
 *                                                  {kind: 'join', pubkey} signed (sig v2) for room and name
 *   checkSeatProof(proof, {room, name, pubkey})    the server's half: AUTH unless proof is a fresh join proof for
 *                                                  this room, name and pubkey that verifies against pubkey, so
 *                                                  a link cannot take a seat with a public key alone
 *   formatInvite({code, locator, secret}) -> "sh1.<code>.<locator-base64url>.<secret>"
 *   parseInvite(text) -> {code, locator, secret} | null
 */

const crypto = require('node:crypto');
const { RoomError } = require('../room/validate.js');
const envelope = require('../room/envelope.js');
const { CODE_RE } = require('../text.js');

const INVITE_PREFIX = 'sh1';
const INVITES_KEY = 'remote/invites';
const LINKS_KEY = 'remote/links';
const SECRET_RE = /^[A-Za-z0-9_-]{16,128}$/;

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const random = () => crypto.randomBytes(24).toString('base64url');
const iso = now => new Date(now).toISOString();

/**
 * @param {import('../room/store.js').FsRoomStore} store   the host's store (isHost)
 * @param {{locator: string, now?: number}} opts   locator: the transport spec the invite points at
 * @returns {{invite: string, secret: string}}
 */
function mintInvite(store, { locator, now = Date.now() }) {
  if (!store.isHost) throw new RoomError('HOST_ONLY', 'only the host of a room mints its invites');
  const secret = random();
  store.kv.update(INVITES_KEY, cur => ({ ...cur, [sha256(secret)]: { created_at: iso(now) } }));
  return { invite: formatInvite({ code: store.code, locator, secret }), secret };
}

/**
 * @param {import('../room/store.js').FsRoomStore} store
 * @param {string} secret
 * @param {{machine: string, now?: number}} opts
 * @returns {{token: string, link: object}}
 */
function redeemInvite(store, secret, { machine, now = Date.now() }) {
  const key = sha256(secret);
  const link = { id: crypto.randomBytes(6).toString('hex'), token_sha256: null, machine, seats: [], created_at: iso(now) };
  store.kv.update(INVITES_KEY, cur => {
    const inv = cur && cur[key];
    if (!inv || inv.used_at) throw new RoomError('AUTH', 'this invite is unknown or was used already; ask the host for a new one');
    return { ...cur, [key]: { ...inv, used_at: iso(now), link: link.id } };
  });
  const token = random();
  link.token_sha256 = sha256(token);
  store.kv.update(LINKS_KEY, cur => ({ ...cur, [link.id]: link }));
  return { token, link };
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
const formatInvite = ({ code, locator, secret }) => [INVITE_PREFIX, code, Buffer.from(locator).toString('base64url'), secret].join('.');

/**
 * @param {string} text
 * @returns {{code: string, locator: string, secret: string} | null}
 */
function parseInvite(text) {
  const parts = typeof text === 'string' ? text.trim().split('.') : [];
  if (parts.length !== 4) return null;
  const [prefix, code, loc, secret] = parts;
  const locator = Buffer.from(loc, 'base64url').toString('utf8');
  if (prefix !== INVITE_PREFIX || !CODE_RE.test(code) || !locator || !SECRET_RE.test(secret)) return null;
  return { code, locator, secret };
}

module.exports = {
  INVITE_PREFIX, INVITES_KEY, LINKS_KEY, mintInvite, redeemInvite, verifyToken, bindSeat, mayWriteAs, proveSeat, checkSeatProof,
  formatInvite, parseInvite,
};
