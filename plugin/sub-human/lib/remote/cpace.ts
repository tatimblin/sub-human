/**
 * plugin/sub-human/lib/remote/cpace.ts: CPace (draft-irtf-cfrg-cpace-21) with the cipher suite
 * CPACE-RISTR255-SHA512, initiator-responder mode, plus the draft's explicit key confirmation (section 10.4). The
 * group is ristretto255 from the vendored, hash-pinned @noble/curves (lib/vendor/noble, MANIFEST.json): decode,
 * encode, scalar multiplication and RFC 9496 element derivation. SHA-512 and HMAC-SHA-512 are node:crypto's. No
 * field arithmetic is written here; this file only strings the draft's steps together. Checked against the draft's
 * published vectors (Appendix A.1, A.3, B.3) in test/remote-cpace.test.js.
 *
 *   DSI                              b"CPaceRistretto255"
 *   prependLen(b), lvCat(...b)       the draft's LEB128 length-value encoding
 *   generatorString(PRS, CI, sid)    lv_cat(DSI, PRS, zero_bytes(len_zpad), CI, sid), s_in_bytes = 128
 *   calculateGenerator(PRS, CI, sid) -> Point   element_derivation(SHA-512(generator_string))
 *   sampleScalar() -> bigint         32 random bytes, bits above 252 cleared (never 0)
 *   scalarMult(y, g) -> Buffer       encode(y * g)
 *   scalarMultVfy(y, X) -> Buffer | null   encode(y * decode(X)); null (the draft's G.I) when X does not decode or the
 *                                    result is the neutral element: the caller MUST abort
 *   transcriptIr(Ya, ADa, Yb, ADb)   lv_cat(Ya, ADa) || lv_cat(Yb, ADb)
 *   isk(sid, K, transcript) -> Buffer   SHA-512(lv_cat(DSI || "_ISK", sid, K) || transcript)
 *   macKey(sid, ISK) -> Buffer       SHA-512("CPaceMac" || sid || ISK)
 *   tag(macKey, Y, AD) -> Buffer     HMAC-SHA-512(mac_key, lv_cat(Y, AD))
 *   initiator({prs, ci, sid, ad, y?}) -> {Y, finish(Yb, ADb) -> {isk, macKey} | null}
 *   responder({prs, ci, sid, ad, Ya, ADa, y?}) -> {Y, isk, macKey} | null   null: Ya is invalid (abort)
 *   equal(a, b) -> bool              constant time for equal lengths
 * y (tests only): a fixed scalar, as little-endian bytes.
 */

import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const DSI = Buffer.from('CPaceRistretto255');
const S_IN_BYTES = 128; // SHA-512's input block
const ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;

/** A ristretto255 element, as the vendored @noble/curves gives it (untyped JS: the shape this file uses). */
interface RistrettoPoint {
  multiply(scalar: bigint): RistrettoPoint;
  toBytes(): Uint8Array;
  is0(): boolean;
}
interface NobleEd25519 {
  ristretto255: { Point: { fromBytes(bytes: Uint8Array): RistrettoPoint } };
  ristretto255_hasher: { deriveToCurve(msg: Uint8Array): RistrettoPoint };
}
/** A scalar: a bigint, or little-endian bytes (tests' fixed y). */
type Scalar = bigint | Uint8Array;
type Bytes = Buffer | Uint8Array;

let noble: NobleEd25519 | null = null;
const group = (): NobleEd25519 => noble || (noble = require('../vendor/noble/curves/ed25519.js') as NobleEd25519);

const sha512 = (...parts: Bytes[]): Buffer => { const h = crypto.createHash('sha512'); for (const p of parts) h.update(p); return h.digest(); };

function prependLen(data: Bytes | string): Buffer {
  const b = Buffer.from(data);
  const len: number[] = [];
  let n = b.length;
  do { len.push(n < 128 ? n : (n & 0x7f) | 0x80); n >>= 7; } while (n > 0);
  return Buffer.concat([Buffer.from(len), b]);
}
const lvCat = (...args: (Bytes | string)[]): Buffer => Buffer.concat(args.map(prependLen));

function generatorString(prs: Bytes, ci: Bytes, sid: Bytes): Buffer {
  const zpad = Math.max(0, S_IN_BYTES - 1 - prependLen(prs).length - prependLen(DSI).length);
  return lvCat(DSI, prs, Buffer.alloc(zpad), ci, sid);
}

function calculateGenerator(prs: Bytes, ci: Bytes, sid: Bytes): RistrettoPoint {
  const { ristretto255_hasher } = group();
  return ristretto255_hasher.deriveToCurve(new Uint8Array(sha512(generatorString(prs, ci, sid))));
}

const leToBig = (b: Uint8Array): bigint => { let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]); return n; };

function sampleScalar(): bigint {
  for (;;) {
    const b = crypto.randomBytes(32);
    b[31] &= 0x0f; // clear the bits above 252: the result is below the group order
    const y = leToBig(b);
    if (y > 0n) return y;
  }
}

const scalarOf = (y: Scalar): bigint => {
  const n = typeof y === 'bigint' ? y : leToBig(Buffer.from(y));
  const r = n % ORDER;
  if (r === 0n) throw new Error('CPace: a zero scalar');
  return r;
};

const scalarMult = (y: Scalar, g: RistrettoPoint): Buffer => Buffer.from(g.multiply(scalarOf(y)).toBytes());

function scalarMultVfy(y: Scalar, X: Bytes): Buffer | null {
  const { ristretto255 } = group();
  let P: RistrettoPoint;
  try { P = ristretto255.Point.fromBytes(new Uint8Array(Buffer.from(X))); } catch { return null; }
  if (P.is0()) return null;
  const K = P.multiply(scalarOf(y));
  return K.is0() ? null : Buffer.from(K.toBytes());
}

const transcriptIr = (Ya: Bytes, ADa: Bytes, Yb: Bytes, ADb: Bytes): Buffer => Buffer.concat([lvCat(Ya, ADa), lvCat(Yb, ADb)]);
const isk = (sid: Bytes, K: Bytes, transcript: Bytes): Buffer => sha512(lvCat(Buffer.concat([DSI, Buffer.from('_ISK')]), sid, K), transcript);
const macKey = (sid: Bytes, ISK: Bytes): Buffer => sha512(Buffer.from('CPaceMac'), sid, ISK);
const tag = (key: Bytes, Y: Bytes, AD: Bytes): Buffer => crypto.createHmac('sha512', key).update(lvCat(Y, AD)).digest();
const equal = (a: unknown, b: unknown): boolean => Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length === b.length && crypto.timingSafeEqual(a, b);

interface CpaceKeys {
  isk: Buffer;
  macKey: Buffer;
}

function initiator({ prs, ci, sid, ad, y }: { prs: Bytes; ci: Bytes; sid: Bytes; ad: Bytes; y?: Scalar }): {
  Y: Buffer; finish(Yb: Bytes, ADb: Bytes): CpaceKeys | null;
} {
  const ya = y === undefined ? sampleScalar() : y;
  const Ya = scalarMult(ya, calculateGenerator(prs, ci, sid));
  return {
    Y: Ya,
    finish(Yb, ADb) {
      const K = scalarMultVfy(ya, Yb);
      if (!K) return null;
      const ISK = isk(sid, K, transcriptIr(Ya, ad, Yb, ADb));
      return { isk: ISK, macKey: macKey(sid, ISK) };
    },
  };
}

function responder({ prs, ci, sid, ad, Ya, ADa, y }: {
  prs: Bytes; ci: Bytes; sid: Bytes; ad: Bytes; Ya: Bytes; ADa: Bytes; y?: Scalar;
}): (CpaceKeys & { Y: Buffer }) | null {
  const yb = y === undefined ? sampleScalar() : y;
  const Yb = scalarMult(yb, calculateGenerator(prs, ci, sid));
  const K = scalarMultVfy(yb, Ya);
  if (!K) return null;
  const ISK = isk(sid, K, transcriptIr(Ya, ADa, Yb, ad));
  return { Y: Yb, isk: ISK, macKey: macKey(sid, ISK) };
}

export {
  DSI, ORDER, prependLen, lvCat, generatorString, calculateGenerator, sampleScalar, scalarMult, scalarMultVfy,
  transcriptIr, isk, macKey, tag, initiator, responder, equal,
};
