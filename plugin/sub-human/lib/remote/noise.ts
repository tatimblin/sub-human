/**
 * plugin/sub-human/lib/remote/noise.ts: the end-to-end channel inside a WebSocket (lib/remote/transports/ws.ts): two
 * Noise patterns over 25519, ChaChaPoly and SHA256 (https://noiseprotocol.org/noise.html, revision 34), built on
 * node:crypto only: X25519 through crypto.diffieHellman on KeyObjects, ChaCha20-Poly1305 (12-byte nonce: 4 zero bytes
 * and the 64-bit little-endian counter), SHA-256, and the spec's HKDF, which is RFC 5869 HKDF-SHA256 with salt = ck
 * and no info (crypto.hkdfSync). No field arithmetic is written here. Checked against the cacophony and snow vectors
 * (test/remote-noise.node-test.ts) for both patterns.
 *
 * Both: the responder (the host's listener) has a static key the initiator (the joiner's link daemon) knows already
 * (an invite's tag names it, a link file pins it). So only the holder of that key can read message 1's payload or
 * answer with a message 2 that decrypts: a TLS front (Tailscale Serve or Funnel, a reverse proxy) between them sees
 * ciphertext.
 *   XK (protocol 3, every link made since): the initiator has a static key of its own, one per link (its link file's,
 *       made when it joined), and sends it encrypted in message 3:  <- s  ...  -> e, es   <- e, ee   -> s, se
 *       The responder learns it (remoteStatic) and the host binds the link to it: a link is a key, not a bearer token.
 *   NK (protocol 2, a link made before): the initiator stays anonymous:  <- s  ...  -> e, es   <- e, ee
 *       Kept so a link made under protocol 2 keeps working until it is invited again or revoked.
 *
 *   PATTERNS                         {NK, XK}: each one's protocol name and message tokens
 *   PROTOCOL                         'Noise_NK_25519_ChaChaPoly_SHA256' (NK's name; PATTERNS.XK.name is XK's)
 *   MAX_MESSAGE                      65535 bytes, the spec's limit for one Noise message
 *   MAX_PLAINTEXT                    MAX_MESSAGE - 16 (the tag)
 *   generateKeyPair() -> {priv, pub}   32-byte Buffers
 *   keyPair(priv) -> {priv, pub}     the pair of a raw 32-byte X25519 private key
 *   dh(priv, pub) -> Buffer          X25519 shared secret (32 bytes); throws on an all-zero result (a low-order point)
 *   initiator({rs, s?, pattern?, prologue?, e?}) -> Handshake   rs: the responder's known public key (32 bytes); s: the
 *                                    initiator's own pair (XK); pattern 'NK' (default) or 'XK'
 *   responder({s, pattern?, prologue?, e?}) -> Handshake    s: the responder's own pair; e: a fixed ephemeral pair (tests only)
 *   Handshake (one side)
 *     writeMessage(payload) -> Buffer      the next message this side sends (initiator: 1 and, XK, 3; responder: 2)
 *     readMessage(buf) -> Buffer           the payload of the peer's message; throws NoiseError when it does not
 *                                          decrypt (for message 2 on the initiator: the host does not hold the key it
 *                                          named; for message 1 on the responder: another pattern, or another key)
 *     done -> bool                         every message of the pattern made
 *     remoteStatic -> Buffer | null        the peer's static key: the initiator's rs, the XK responder's after message 3
 *     handshakeHash -> Buffer              h once done (channel binding)
 *     split() -> {send: CipherState, recv: CipherState}   once done
 *   CipherState: encrypt(plaintext, ad?) -> Buffer, decrypt(ciphertext, ad?) -> Buffer (NoiseError on a bad tag);
 *     counter nonces, so a replayed, dropped or reordered message fails to decrypt. A state refuses to go past
 *     2^53 - 1 messages (far beyond any room's life)
 *   NoiseError                        an Error with code 'NOISE'
 *   loadOrCreateStatic(file) -> {priv, pub}   a static key in a 0600 JSON file ({v: 1, kind: 'x25519', priv, pub}
 *                                    base64url), made once: the host's listener key, a link's own key; refused when
 *                                    group/world readable or not this user's
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** A pattern's message tokens (both patterns here have the pre-message <- s). */
type Token = 'e' | 's' | 'ee' | 'es' | 'se';
type PatternName = 'NK' | 'XK';
const PATTERNS: Readonly<Record<PatternName, { name: string; messages: readonly (readonly Token[])[] }>> = Object.freeze({
  NK: { name: 'Noise_NK_25519_ChaChaPoly_SHA256', messages: [['e', 'es'], ['e', 'ee']] },
  XK: { name: 'Noise_XK_25519_ChaChaPoly_SHA256', messages: [['e', 'es'], ['e', 'ee'], ['s', 'se']] },
});
const PROTOCOL = PATTERNS.NK.name;
const DHLEN = 32, HASHLEN = 32, TAGLEN = 16;
const MAX_MESSAGE = 65535;
const MAX_PLAINTEXT = MAX_MESSAGE - TAGLEN;
const EMPTY = Buffer.alloc(0);

class NoiseError extends Error {
  code: 'NOISE';
  constructor(msg: string) { super(msg); this.code = 'NOISE'; }
}

/** A raw X25519 pair: 32-byte Buffers. */
interface KeyPair { priv: Buffer; pub: Buffer }

// Raw X25519 keys as KeyObjects: the fixed DER prefixes of PKCS#8 and SPKI for OID 1.3.101.110 (RFC 8410).
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const privObj = (raw: Buffer): crypto.KeyObject => crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' });
const pubObj = (raw: Buffer): crypto.KeyObject => crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
const rawPub = (keyObj: crypto.KeyObject): Buffer => keyObj.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length);
const rawPriv = (keyObj: crypto.KeyObject): Buffer => keyObj.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8_PREFIX.length);

function check32(b: unknown, what: string): Buffer {
  if (!Buffer.isBuffer(b) || b.length !== DHLEN) throw new NoiseError(`${what} must be 32 bytes`);
  return b;
}

function keyPair(priv: Buffer): KeyPair {
  check32(priv, 'an X25519 private key');
  return { priv: Buffer.from(priv), pub: Buffer.from(rawPub(crypto.createPublicKey(privObj(priv)))) };
}

function generateKeyPair(): KeyPair {
  const { privateKey } = crypto.generateKeyPairSync('x25519');
  return keyPair(Buffer.from(rawPriv(privateKey)));
}

function dh(priv: Buffer | null, pub: Buffer | null): Buffer {
  let out: Buffer;
  try {
    out = crypto.diffieHellman({ privateKey: privObj(check32(priv, 'a private key')), publicKey: pubObj(check32(pub, 'a public key')) });
  } catch (e) {
    if (e instanceof NoiseError) throw e;
    throw new NoiseError(`X25519 failed (${(e as Error).message}): a bad or low-order public key`); // OpenSSL refuses an all-zero result itself
  }
  if (out.every(b => b === 0)) throw new NoiseError('X25519 gave an all-zero secret (a low-order public key)');
  return out;
}

const sha256 = (...parts: Buffer[]): Buffer => { const h = crypto.createHash('sha256'); for (const p of parts) h.update(p); return h.digest(); };
/** HKDF(ck, ikm, n) of the spec: RFC 5869 with salt ck and empty info, cut into n outputs of HASHLEN. */
function hkdf(ck: Buffer, ikm: Buffer, n: number): Buffer[] {
  const out = Buffer.from(crypto.hkdfSync('sha256', ikm, ck, EMPTY, HASHLEN * n));
  return Array.from({ length: n }, (_, i) => out.subarray(i * HASHLEN, (i + 1) * HASHLEN));
}

function nonce(n: number): Buffer {
  const b = Buffer.alloc(12);
  b.writeBigUInt64LE(BigInt(n), 4);
  return b;
}

class CipherState {
  k: Buffer | null;
  n: number;
  constructor(k: Buffer | null = null) { this.k = k; this.n = 0; }
  hasKey() { return this.k !== null; }
  _next() {
    if (this.n >= Number.MAX_SAFE_INTEGER) throw new NoiseError('nonce exhausted');
    return nonce(this.n++);
  }
  encrypt(plaintext: Buffer, ad: Buffer = EMPTY): Buffer {
    if (!this.k) return Buffer.from(plaintext);
    if (plaintext.length > MAX_PLAINTEXT) throw new NoiseError(`a Noise message holds at most ${MAX_PLAINTEXT} bytes`);
    const c = crypto.createCipheriv('chacha20-poly1305', this.k, this._next(), { authTagLength: TAGLEN });
    c.setAAD(ad, { plaintextLength: plaintext.length });
    return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
  }
  decrypt(ciphertext: Buffer, ad: Buffer = EMPTY): Buffer {
    if (!this.k) return Buffer.from(ciphertext);
    if (ciphertext.length < TAGLEN) throw new NoiseError('a Noise message shorter than its tag');
    const n = this.n;
    const d = crypto.createDecipheriv('chacha20-poly1305', this.k, nonce(n), { authTagLength: TAGLEN });
    d.setAAD(ad, { plaintextLength: ciphertext.length - TAGLEN });
    d.setAuthTag(ciphertext.subarray(ciphertext.length - TAGLEN));
    let out: Buffer;
    try { out = Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - TAGLEN)), d.final()]); } catch {
      throw new NoiseError('a Noise message did not decrypt (wrong key, or tampered, replayed or reordered)');
    }
    this.n = n + 1; // the spec: the nonce moves only after a successful decryption
    return out;
  }
}

class SymmetricState {
  h: Buffer;
  ck: Buffer;
  cs: CipherState;
  constructor(name: string) {
    const n = Buffer.from(name);
    this.h = n.length <= HASHLEN ? Buffer.concat([n, Buffer.alloc(HASHLEN - n.length)]) : sha256(n);
    this.ck = Buffer.from(this.h);
    this.cs = new CipherState();
  }
  mixHash(data: Buffer): void { this.h = sha256(this.h, data); }
  mixKey(ikm: Buffer): void {
    const [ck, k] = hkdf(this.ck, ikm, 2);
    this.ck = ck;
    this.cs = new CipherState(Buffer.from(k));
  }
  encryptAndHash(pt: Buffer): Buffer { const c = this.cs.encrypt(pt, this.h); this.mixHash(c); return c; }
  decryptAndHash(c: Buffer): Buffer { const pt = this.cs.decrypt(c, this.h); this.mixHash(c); return pt; }
  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf(this.ck, EMPTY, 2);
    return [new CipherState(Buffer.from(k1)), new CipherState(Buffer.from(k2))];
  }
}

interface HandshakeOptions {
  initiator: boolean;
  pattern?: PatternName;
  s?: KeyPair | null;
  rs?: Buffer | null;
  e?: KeyPair | null;
  prologue?: Buffer | string;
}

/** One side of a pattern (NK or XK; both pre-message <- s). */
class Handshake {
  initiator: boolean;
  pattern: PatternName;
  messages: readonly (readonly Token[])[];
  ss: SymmetricState;
  s: KeyPair | null;
  rs: Buffer | null;
  fixedE: KeyPair | null;
  e: KeyPair | null;
  re: Buffer | null;
  step: number;
  constructor({ initiator, pattern = 'NK', s = null, rs = null, e = null, prologue = EMPTY }: HandshakeOptions) {
    if (!Object.hasOwn(PATTERNS, pattern)) throw new NoiseError(`no Noise pattern ${pattern}`);
    this.initiator = initiator;
    this.pattern = pattern;
    this.messages = PATTERNS[pattern].messages;
    this.ss = new SymmetricState(PATTERNS[pattern].name);
    this.ss.mixHash(Buffer.from(prologue));
    if (initiator && pattern === 'XK') check32(s && s.pub, 'the initiator\'s own key');
    this.s = s;
    this.rs = rs;
    this.fixedE = e;
    this.e = null;
    this.re = null;
    this.step = 0; // messages made so far
    this.ss.mixHash(initiator ? check32(rs, 'the pinned host key') : check32(s!.pub, 'the host key')); // pre-message <- s (a responder without s throws here)
  }
  get done(): boolean { return this.step >= this.messages.length; }
  get handshakeHash(): Buffer | null { return this.done ? Buffer.from(this.ss.h) : null; }
  /** The peer's static key: the one the initiator knew; the responder's once XK's message 3 was read. */
  get remoteStatic(): Buffer | null { return this.rs ? Buffer.from(this.rs) : null; }

  /** The initiator writes the even messages (1, 3), the responder the odd (2). */
  _myTurn(): boolean { return (this.step % 2 === 0) === this.initiator; }

  /** The DH a token names, from this side: es = DH(e_i, s_r), se = DH(s_i, e_r). */
  _dh(t: 'ee' | 'es' | 'se'): Buffer {
    if (t === 'ee') return dh(this.e!.priv, this.re); // e and re: written or read by an earlier token
    const mineIsE = (t === 'es') === this.initiator;
    return mineIsE ? dh(this.e!.priv, this.rs) : dh(this.s!.priv, this.re);
  }

  writeMessage(payload: Buffer | string = EMPTY): Buffer {
    if (this.done || !this._myTurn()) throw new NoiseError('not this side\'s turn to write');
    const out: Buffer[] = [];
    for (const t of this.messages[this.step]) {
      if (t === 'e') {
        this.e = this.fixedE ? keyPair(this.fixedE.priv) : generateKeyPair();
        this.ss.mixHash(this.e.pub);
        out.push(this.e.pub);
      } else if (t === 's') out.push(this.ss.encryptAndHash(this.s!.pub)); // XK's initiator: checked in the constructor
      else this.ss.mixKey(this._dh(t));
    }
    out.push(this.ss.encryptAndHash(Buffer.from(payload)));
    const msg = Buffer.concat(out);
    this.step++;
    if (msg.length > MAX_MESSAGE) throw new NoiseError('handshake payload too large');
    return msg;
  }

  readMessage(buf: Buffer): Buffer {
    if (this.done || this._myTurn()) throw new NoiseError('not this side\'s turn to read');
    if (!Buffer.isBuffer(buf) || buf.length < TAGLEN || buf.length > MAX_MESSAGE) throw new NoiseError('a handshake message of the wrong size');
    let at = 0;
    const take = (n: number): Buffer => {
      if (buf.length - at < n) throw new NoiseError('a handshake message of the wrong size');
      const b = buf.subarray(at, at + n);
      at += n;
      return b;
    };
    for (const t of this.messages[this.step]) {
      if (t === 'e') {
        this.re = Buffer.from(take(DHLEN));
        this.ss.mixHash(this.re);
      } else if (t === 's') {
        this.rs = Buffer.from(this.ss.decryptAndHash(take(DHLEN + (this.ss.cs.hasKey() ? TAGLEN : 0))));
      } else this.ss.mixKey(this._dh(t));
    }
    if (buf.length - at < TAGLEN) throw new NoiseError('a handshake message of the wrong size');
    const payload = this.ss.decryptAndHash(buf.subarray(at));
    this.step++;
    return payload;
  }

  split(): { send: CipherState; recv: CipherState } {
    if (!this.done) throw new NoiseError('the handshake is not done');
    const [c1, c2] = this.ss.split();
    return this.initiator ? { send: c1, recv: c2 } : { send: c2, recv: c1 };
  }
}

type Who = { prologue?: Buffer | string; e?: KeyPair | null; pattern?: PatternName };
const initiator = ({ rs, s = null, prologue, e, pattern }: Who & { rs: Buffer; s?: KeyPair | null }): Handshake => new Handshake({ initiator: true, pattern, rs, s, prologue, e });
const responder = ({ s, prologue, e, pattern }: Who & { s: KeyPair }): Handshake => new Handshake({ initiator: false, pattern, s, prologue, e });

const b64 = (b: Buffer): string => Buffer.from(b).toString('base64url');

function loadOrCreateStatic(file: string): KeyPair {
  try {
    const st = fs.statSync(file);
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new NoiseError(`${file} is not this user's`);
    if (st.mode & 0o077) throw new NoiseError(`${file} is readable by others; chmod 600 it (or delete it to make a new host key)`);
    const j: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || typeof j !== 'object' || !('priv' in j) || !('pub' in j)) throw new NoiseError(`${file} is not a host key file`);
    const kp = keyPair(Buffer.from(String(j.priv), 'base64url'));
    if (b64(kp.pub) !== j.pub) throw new NoiseError(`${file}: its public key does not match its private key`);
    return kp;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const kp = generateKeyPair();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, kind: 'x25519', priv: b64(kp.priv), pub: b64(kp.pub), created_at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  try { fs.linkSync(tmp, file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } finally { fs.rmSync(tmp, { force: true }); }
  return loadOrCreateStatic(file); // the first of two racing processes wins; both read it
}

export {
  PATTERNS, PROTOCOL, MAX_MESSAGE, MAX_PLAINTEXT, NoiseError, CipherState, generateKeyPair, keyPair, dh, initiator, responder,
  loadOrCreateStatic,
};
export type { KeyPair, Handshake, PatternName };
