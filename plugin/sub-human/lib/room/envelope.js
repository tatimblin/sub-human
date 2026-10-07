'use strict';
/**
 * plugin/sub-human/lib/room/envelope.js: the signed envelope (sig v2) and the keys pinned in the log. Shared by
 * the local store (lib/room/store.js append = sign + place), the mirror (lib/room/store-mirror.js signs, the
 * server places) and the server (lib/remote/server.js verifies before it places), so a client and a server
 * judge a payload the same way. Pure: no file, no process state. Zero dependencies beyond node:crypto.
 * Stub: filled in by PR1 of docs/next/REMOTE-PLAN.md.
 *
 * sig v2 covers the payload, not its place in the log: the entry without id, at, prev and sig, plus room,
 * from, nonce and ts, as JSON with sorted keys. The server stamps id, at and prev afterwards, so a signature
 * made on one machine stays valid wherever the line lands. v1 (today's canonical(): the stored line in its key
 * order, minus sig, made after id/prev were stamped) still verifies.
 *
 *   SIG_VERSION = 2
 *   signable(e) -> string            the bytes a v2 sig covers (sorted keys; id, at, prev, sig left out)
 *   sign(payload, key, {room, from, now?}) -> payload with room, from, nonce, ts, sigv: 2, sig (base64)
 *   verify(e, pub) -> bool           v2 when e.sigv === 2 (or e.nonce is set), else v1
 *   isV2(e) -> bool
 *   newNonce() -> string             16 random bytes, hex
 *   freshTs(e, now?, skewMs?) -> bool   |now - e.ts| <= skewMs (SIG_SKEW_MS): the replay bound, with the nonce
 *   pinnedKeys(entries) -> Map name -> KeyObject   the FIRST member_joined pubkey seen per name (first sight pins)
 *   keyed(entries) -> bool           the room pins at least one key: it never accepts a `legacy` answer
 */

const todo = what => { throw new Error(`sub-human: ${what} is not implemented yet (docs/next/REMOTE-PLAN.md, PR1)`); };

const SIG_VERSION = 2;
const SIG_SKEW_MS = 10 * 60 * 1000;
/** Stamped by the store when it places an entry; never under a v2 signature. */
const PLACED_FIELDS = ['id', 'at', 'prev', 'sig'];

/**
 * The bytes a v2 signature covers: e without PLACED_FIELDS, JSON with keys sorted at every level.
 * @param {object} e
 * @returns {string}
 */
function signable(e) { return todo(`envelope.signable(${typeof e})`); }

/**
 * Sign payload with the seat's private key: adds room, from, nonce, ts, sigv and sig, and returns the new object.
 * @param {object} payload   the validated entry fields (lib/room/validate.js)
 * @param {import('node:crypto').KeyObject} key   the seat's Ed25519 private key (hooks/seat-key.js)
 * @param {{room: string, from: string, now?: number}} ctx
 * @returns {object}
 */
function sign(payload, key, ctx) { return todo(`envelope.sign(${ctx && ctx.room})`); }

/**
 * Whether e's sig verifies against pub: v2 over signable(e), v1 over the stored line minus sig.
 * @param {object} e
 * @param {import('node:crypto').KeyObject} pub
 * @returns {boolean}
 */
function verify(e, pub) { return todo(`envelope.verify(${e && e.id})`); }

const isV2 = e => !!e && (e.sigv === SIG_VERSION || typeof e.nonce === 'string');

/** @returns {string} 16 random bytes as hex */
function newNonce() { return todo('envelope.newNonce()'); }

/**
 * @param {object} e
 * @param {number} [now]
 * @param {number} [skewMs]
 * @returns {boolean}
 */
function freshTs(e, now = Date.now(), skewMs = SIG_SKEW_MS) { return todo(`envelope.freshTs(${e && e.ts}, ${now}, ${skewMs})`); }

/**
 * The public key pinned for each name: the first member_joined entry carrying pubkey, in log order.
 * @param {object[]} entries
 * @returns {Map<string, import('node:crypto').KeyObject>}
 */
function pinnedKeys(entries) { return todo(`envelope.pinnedKeys(${entries && entries.length})`); }

/**
 * @param {object[]} entries
 * @returns {boolean}
 */
function keyed(entries) { return todo(`envelope.keyed(${entries && entries.length})`); }

module.exports = { SIG_VERSION, SIG_SKEW_MS, PLACED_FIELDS, signable, sign, verify, isV2, newNonce, freshTs, pinnedKeys, keyed };
