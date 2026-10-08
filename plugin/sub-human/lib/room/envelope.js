'use strict';
/**
 * plugin/sub-human/lib/room/envelope.js: the signed envelope (sig v2) and the keys pinned in the log. Shared by
 * the local store (lib/room/store.js append = sign + place), the mirror (lib/room/store-mirror.js signs, the
 * server places) and the server (lib/remote/server.js verifies before it places), so a client and a server
 * judge a payload the same way. Pure: no file, no process state. Zero dependencies beyond node:crypto.
 *
 * sig v2 covers the payload, not its place in the log: the entry without id, at, prev and sig, plus room,
 * from, nonce and ts, as JSON with sorted keys. The server stamps id, at and prev afterwards, so a signature
 * made on one machine stays valid wherever the line lands. v1 (the stored line in its key order, minus sig,
 * made after id/prev were stamped; logs from before sig v2) still verifies.
 *
 *   SIG_VERSION = 2
 *   signable(e) -> string            the bytes a v2 sig covers (sorted keys; id, at, prev, sig left out)
 *   signedBytes(e) -> string         what e's sig covers: signable(e) for v2, the v1 form otherwise
 *   sign(payload, key, {room, from, now?}) -> payload with room, from, nonce, ts, sigv: 2, sig (base64)
 *   verify(e, pub) -> bool           v2 when e.sigv === 2 (or e.nonce is set), else v1
 *   isV2(e) -> bool
 *   newNonce() -> string             16 random bytes, hex
 *   freshTs(e, now?, skewMs?) -> bool   |now - e.ts| <= skewMs (SIG_SKEW_MS): the replay bound, with the nonce
 *   parseKey(pem) -> KeyObject|null  an Ed25519 SPKI PEM public key (member_joined pubkey), else null
 *   pinnedKeys(entries) -> Map name -> KeyObject   the FIRST member_joined pubkey seen per name (first sight pins)
 *   keyed(entries) -> bool           the room pins at least one key: it never accepts a `legacy` answer
 */

const crypto = require('node:crypto');

const SIG_VERSION = 2;
const SIG_SKEW_MS = 10 * 60 * 1000;
/** Stamped by the store when it places an entry; never under a v2 signature. */
const PLACED_FIELDS = ['id', 'at', 'prev', 'sig'];

/** v with the keys of every plain object sorted, so the same fields serialize to the same bytes. */
function sorted(v) {
  if (Array.isArray(v)) return v.map(sorted);
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const k of Object.keys(v).sort()) out[k] = sorted(v[k]);
  return out;
}

/**
 * The bytes a v2 signature covers: e without PLACED_FIELDS, JSON with keys sorted at every level.
 * @param {object} e
 * @returns {string}
 */
function signable(e) {
  const rest = { ...e };
  for (const k of PLACED_FIELDS) delete rest[k];
  return JSON.stringify(sorted(rest));
}

const isV2 = e => !!e && (e.sigv === SIG_VERSION || typeof e.nonce === 'string');

/** v1: the stored entry without sig, in its stored key order. */
const v1Bytes = e => { const { sig, ...rest } = e; return JSON.stringify(rest); };

/** What e's signature covers, by its version. */
const signedBytes = e => (isV2(e) ? signable(e) : v1Bytes(e));

/** @returns {string} 16 random bytes as hex */
const newNonce = () => crypto.randomBytes(16).toString('hex');

/**
 * Sign payload with the seat's private key: adds room, from, nonce, ts, sigv and sig, and returns the new object.
 * @param {object} payload   the validated entry fields (lib/room/validate.js)
 * @param {import('node:crypto').KeyObject} key   the seat's Ed25519 private key (hooks/seat-key.js)
 * @param {{room: string, from: string, now?: number}} ctx
 * @returns {object}
 */
function sign(payload, key, { room, from, now = Date.now() }) {
  const e = { ...payload, room, from, nonce: newNonce(), ts: now, sigv: SIG_VERSION };
  e.sig = crypto.sign(null, Buffer.from(signable(e), 'utf8'), key).toString('base64');
  return e;
}

/**
 * Whether e's sig verifies against pub: v2 over signable(e), v1 over the stored line minus sig.
 * @param {object} e
 * @param {import('node:crypto').KeyObject} pub
 * @returns {boolean}
 */
function verify(e, pub) {
  if (!e || typeof e.sig !== 'string' || !pub) return false;
  try { return crypto.verify(null, Buffer.from(signedBytes(e), 'utf8'), pub, Buffer.from(e.sig, 'base64')); } catch { return false; }
}

/**
 * @param {object} e
 * @param {number} [now]
 * @param {number} [skewMs]
 * @returns {boolean}
 */
const freshTs = (e, now = Date.now(), skewMs = SIG_SKEW_MS) => !!e && Number.isFinite(e.ts) && Math.abs(now - e.ts) <= skewMs;

/**
 * @param {string} pem
 * @returns {import('node:crypto').KeyObject|null}
 */
function parseKey(pem) {
  if (typeof pem !== 'string') return null;
  try {
    const key = crypto.createPublicKey(pem);
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch { return null; }
}

/**
 * The public key pinned for each name: the first member_joined entry carrying pubkey, in log order.
 * @param {object[]} entries
 * @returns {Map<string, import('node:crypto').KeyObject>}
 */
function pinnedKeys(entries) {
  const pins = new Map();
  for (const e of entries || []) {
    if (!e || e.kind !== 'member_joined' || e.via !== 'system' || typeof e.from !== 'string' || pins.has(e.from)) continue;
    const key = parseKey(e.pubkey);
    if (key) pins.set(e.from, key);
  }
  return pins;
}

/**
 * @param {object[]} entries
 * @returns {boolean}
 */
const keyed = entries => pinnedKeys(entries).size > 0;

module.exports = { SIG_VERSION, SIG_SKEW_MS, PLACED_FIELDS, signable, signedBytes, sign, verify, isV2, newNonce, freshTs, parseKey, pinnedKeys, keyed };
