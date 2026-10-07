'use strict';
/**
 * plugin/sub-human/lib/remote/auth.js: invites and link tokens, on the host. An invite is single-use and turns
 * into a link token at the first hello; the token is the link's credential from then on. The host stores
 * only sha256 digests (kv documents remote/invites and remote/links of the room's store; host-only, never
 * streamed). The client keeps the token in clear in its link file (lib/room/links.js), the same trust as its
 * seat key. "Write as yourself": a link may write only as the seats that joined over it. Zero dependencies
 * beyond node:crypto and the store. Stub: filled in by PR4 of docs/next/REMOTE-PLAN.md.
 *
 *   mintInvite(store, {locator, now?}) -> {invite, secret}   invite = formatInvite({code, locator, secret});
 *                                                  records sha256(secret) with created_at. Host only (HOST_ONLY)
 *   redeemInvite(store, secret, {machine, now?}) -> {token, link}   marks the invite used (a second use is AUTH),
 *                                                  records {id, token_sha256, machine, seats: [], created_at}
 *   verifyToken(store, token) -> link | null       the link record for a presented token
 *   bindSeat(store, linkId, name) -> link          name joined over this link
 *   mayWriteAs(link, name) -> bool                 name is one of link.seats
 *   formatInvite({code, locator, secret}) -> "sh1.<code>.<locator-base64url>.<secret>"
 *   parseInvite(text) -> {code, locator, secret} | null
 */

const todo = what => { throw new Error(`sub-human: ${what} is not implemented yet (docs/next/REMOTE-PLAN.md, PR4)`); };

const INVITE_PREFIX = 'sh1';
const INVITES_KEY = 'remote/invites';
const LINKS_KEY = 'remote/links';

/**
 * @param {import('../room/store.js').FsRoomStore} store   the host's store (isHost)
 * @param {{locator: string, now?: number}} opts   locator: the transport spec the invite points at
 * @returns {{invite: string, secret: string}}
 */
function mintInvite(store, opts) { return todo(`auth.mintInvite(${store && store.code}, ${opts && opts.locator})`); }

/**
 * @param {import('../room/store.js').FsRoomStore} store
 * @param {string} secret
 * @param {{machine: string, now?: number}} opts
 * @returns {{token: string, link: object}}
 */
function redeemInvite(store, secret, opts) { return todo(`auth.redeemInvite(${store && store.code}, machine ${opts && opts.machine})`); }

/**
 * @param {import('../room/store.js').FsRoomStore} store
 * @param {string} token
 * @returns {object | null}
 */
function verifyToken(store, token) { return todo(`auth.verifyToken(${store && store.code}, ${typeof token})`); }

/**
 * @param {import('../room/store.js').FsRoomStore} store
 * @param {string} linkId
 * @param {string} name
 * @returns {object}
 */
function bindSeat(store, linkId, name) { return todo(`auth.bindSeat(${store && store.code}, ${linkId}, ${name})`); }

/**
 * @param {{seats?: string[]}} link
 * @param {string} name
 * @returns {boolean}
 */
const mayWriteAs = (link, name) => !!link && Array.isArray(link.seats) && link.seats.includes(name);

/**
 * @param {{code: string, locator: string, secret: string}} parts
 * @returns {string}
 */
function formatInvite(parts) { return todo(`auth.formatInvite(${parts && parts.code})`); }

/**
 * @param {string} text
 * @returns {{code: string, locator: string, secret: string} | null}
 */
function parseInvite(text) { return todo(`auth.parseInvite(${typeof text})`); }

module.exports = { INVITE_PREFIX, INVITES_KEY, LINKS_KEY, mintInvite, redeemInvite, verifyToken, bindSeat, mayWriteAs, formatInvite, parseInvite };
