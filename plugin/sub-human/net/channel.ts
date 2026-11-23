/**
 * net/channel.ts: the one encrypted channel every pathway's byte stream carries (R29c). Noise_XK_25519_ChaChaPoly_SHA256
 * (Noise rev 34) on node:crypto alone: X25519 by crypto.diffieHellman, ChaCha20-Poly1305 with the spec's nonce (4 zero
 * bytes, then the counter little-endian), SHA-256, and the spec's HKDF, which is RFC 5869 with salt ck and no info.
 * Checked against the cacophony and snow vectors (channel.node-test.ts).
 *
 * XK: <- s ... -> e, es  <- e, ee  -> s, se. The joiner knows the host's key from the invite line, so only the host can
 * read message 1 or answer with a message 2 that decrypts. Message 3 proves the joiner's own key (the link's identity)
 * and carries the invite's MAC or nothing; accept() hands both to the host's admit() before anything else is started.
 *
 * On the stream each Noise message is a frame: a 2-byte big-endian length, then at most 65535 bytes. After the
 * handshake each frame's plaintext starts with a byte that is 1 when the message continues in the next frame, so a
 * message (a snapshot, a plan) can outgrow a frame, up to MAX_MESSAGE.
 *
 * For net/host.ts and every pathway (U15): before admission the host holds at most HELD_MAX bytes and then pauses the
 * stream; the rest waits in the transport. That holds only if stream.pause() reaches real backpressure, so the
 * WebSocket Duplex adapter must honour pause (stop reading the socket), not buffer behind it.
 */
import crypto from 'node:crypto';
import type { Duplex } from 'node:stream';

type Token = 'e' | 's' | 'ee' | 'es' | 'se';
const PATTERN: readonly (readonly Token[])[] = [['e', 'es'], ['e', 'ee'], ['s', 'se']];
const NAME = 'Noise_XK_25519_ChaChaPoly_SHA256';
const PROLOGUE = 'sub-human/2';
const DHLEN = 32, TAGLEN = 16;
export const MAX_FRAME = 65535;
const MAX_PLAIN = MAX_FRAME - TAGLEN;
export const MAX_MESSAGE: number = 8 * 1024 * 1024;
const EMPTY = Buffer.alloc(0);

export class NoiseError extends Error {
  readonly code = 'NOISE' as const;
}

export interface KeyPair { priv: Buffer; pub: Buffer }

// Raw X25519 keys as KeyObjects: the fixed DER prefixes of PKCS#8 and SPKI for OID 1.3.101.110 (RFC 8410).
const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const privObj = (raw: Buffer): crypto.KeyObject => crypto.createPrivateKey({ key: Buffer.concat([PKCS8, raw]), format: 'der', type: 'pkcs8' });
const pubObj = (raw: Buffer): crypto.KeyObject => crypto.createPublicKey({ key: Buffer.concat([SPKI, raw]), format: 'der', type: 'spki' });

function key32(b: Buffer | null | undefined, what: string): Buffer {
  if (!b || b.length !== DHLEN) throw new NoiseError(`${what} must be 32 bytes`);
  return b;
}

export function keyPair(priv: Buffer): KeyPair {
  const pub = crypto.createPublicKey(privObj(key32(priv, 'a private key'))).export({ format: 'der', type: 'spki' });
  return { priv: Buffer.from(priv), pub: Buffer.from(pub.subarray(SPKI.length)) };
}

export function generateKeyPair(): KeyPair {
  const der = crypto.generateKeyPairSync('x25519').privateKey.export({ format: 'der', type: 'pkcs8' });
  return keyPair(Buffer.from(der.subarray(PKCS8.length)));
}

/** X25519; a low-order public key (an all-zero secret) is refused. */
export function dh(priv: Buffer | null | undefined, pub: Buffer | null | undefined): Buffer {
  const [a, b] = [key32(priv, 'a private key'), key32(pub, 'a public key')];
  let out: Buffer;
  try { out = crypto.diffieHellman({ privateKey: privObj(a), publicKey: pubObj(b) }); } catch {
    throw new NoiseError('X25519 failed: a bad or low-order public key'); // OpenSSL refuses an all-zero result itself
  }
  if (out.every(x => x === 0)) throw new NoiseError('X25519 gave an all-zero secret');
  return out;
}

const sha256 = (...parts: Buffer[]): Buffer => { const h = crypto.createHash('sha256'); for (const p of parts) h.update(p); return h.digest(); };
function hkdf2(ck: Buffer, ikm: Buffer): [Buffer, Buffer] {
  const out = Buffer.from(crypto.hkdfSync('sha256', ikm, ck, EMPTY, 64));
  return [out.subarray(0, 32), out.subarray(32)];
}
function nonce(n: number): Buffer { const b = Buffer.alloc(12); b.writeBigUInt64LE(BigInt(n), 4); return b; }

export class CipherState {
  private n = 0;
  private readonly k: Buffer | null;
  constructor(k: Buffer | null = null) { this.k = k; }
  hasKey(): boolean { return this.k !== null; }
  encrypt(plain: Buffer, ad: Buffer = EMPTY): Buffer {
    if (!this.k) return Buffer.from(plain);
    if (plain.length > MAX_PLAIN) throw new NoiseError(`a Noise message holds at most ${MAX_PLAIN} bytes`);
    if (this.n >= Number.MAX_SAFE_INTEGER) throw new NoiseError('nonce exhausted');
    const c = crypto.createCipheriv('chacha20-poly1305', this.k, nonce(this.n++), { authTagLength: TAGLEN });
    c.setAAD(ad, { plaintextLength: plain.length });
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  }
  /** A tampered, replayed or reordered message fails: the nonce moves only on success. */
  decrypt(sealed: Buffer, ad: Buffer = EMPTY): Buffer {
    if (!this.k) return Buffer.from(sealed);
    if (sealed.length < TAGLEN) throw new NoiseError('a Noise message shorter than its tag');
    const d = crypto.createDecipheriv('chacha20-poly1305', this.k, nonce(this.n), { authTagLength: TAGLEN });
    d.setAAD(ad, { plaintextLength: sealed.length - TAGLEN });
    d.setAuthTag(sealed.subarray(sealed.length - TAGLEN));
    let out: Buffer;
    try { out = Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAGLEN)), d.final()]); } catch {
      throw new NoiseError('a Noise message did not decrypt');
    }
    this.n++;
    return out;
  }
}

export interface HandshakeOptions { s?: KeyPair | null; rs?: Buffer | null; e?: KeyPair | null; prologue?: Buffer | string }

/** One side of the XK handshake: the initiator writes messages 1 and 3, the responder message 2. */
export class Handshake {
  private h: Buffer;
  private ck: Buffer;
  private cs = new CipherState();
  private e: KeyPair | null = null;
  private re: Buffer | null = null;
  private rs: Buffer | null;
  private step = 0;
  private readonly initiator: boolean;
  private readonly s: KeyPair | null;
  private readonly fixedE: KeyPair | null;

  constructor(initiator: boolean, { s = null, rs = null, e = null, prologue = PROLOGUE }: HandshakeOptions) {
    this.initiator = initiator;
    this.s = s;
    this.rs = rs;
    this.fixedE = e;
    const name = Buffer.from(NAME); // 32 bytes exactly: h starts as the name itself
    this.h = name;
    this.ck = Buffer.from(name);
    this.mixHash(Buffer.from(prologue));
    if (initiator) key32(s?.pub, 'the joiner\'s own key');
    this.mixHash(initiator ? key32(rs, 'the host key') : key32(s?.pub, 'the host key')); // pre-message <- s
  }

  get done(): boolean { return this.step >= PATTERN.length; }
  /** The handshake hash, the same on both sides once done; null before. */
  get hash(): Buffer | null { return this.done ? Buffer.from(this.h) : null; }
  /** The peer's static key: the host's for the joiner; the joiner's, for the host, once message 3 is read. */
  get remoteKey(): Buffer | null { return this.rs ? Buffer.from(this.rs) : null; }

  private mixHash(data: Buffer): void { this.h = sha256(this.h, data); }
  private mixKey(ikm: Buffer): void { const [ck, k] = hkdf2(this.ck, ikm); this.ck = ck; this.cs = new CipherState(Buffer.from(k)); }
  private seal(p: Buffer): Buffer { const c = this.cs.encrypt(p, this.h); this.mixHash(c); return c; }
  private open(c: Buffer): Buffer { const p = this.cs.decrypt(c, this.h); this.mixHash(c); return p; }
  private myTurn(): boolean { return (this.step % 2 === 0) === this.initiator; }
  /** es = DH(e_i, s_r) and se = DH(s_i, e_r), from this side. */
  private mix(t: 'ee' | 'es' | 'se'): void {
    const mine = t === 'ee' || (t === 'es') === this.initiator ? this.e?.priv : this.s?.priv;
    const theirs = t === 'ee' || (t === 'se') === this.initiator ? this.re : this.rs;
    this.mixKey(dh(mine, theirs));
  }

  writeMessage(payload: Buffer = EMPTY): Buffer {
    if (this.done || !this.myTurn()) throw new NoiseError('not this side\'s turn to write');
    const out: Buffer[] = [];
    for (const t of PATTERN[this.step] ?? []) {
      if (t === 'e') {
        this.e = this.fixedE ? keyPair(this.fixedE.priv) : generateKeyPair();
        this.mixHash(this.e.pub);
        out.push(this.e.pub);
      } else if (t === 's') out.push(this.seal(key32(this.s?.pub, 'the joiner\'s own key')));
      else this.mix(t);
    }
    out.push(this.seal(payload));
    this.step++;
    const msg = Buffer.concat(out);
    if (msg.length > MAX_FRAME) throw new NoiseError('handshake payload too large');
    return msg;
  }

  readMessage(msg: Buffer): Buffer {
    if (this.done || this.myTurn()) throw new NoiseError('not this side\'s turn to read');
    let at = 0;
    const take = (n: number): Buffer => {
      if (msg.length - at < n) throw new NoiseError('a handshake message of the wrong size');
      at += n;
      return msg.subarray(at - n, at);
    };
    for (const t of PATTERN[this.step] ?? []) {
      if (t === 'e') { this.re = Buffer.from(take(DHLEN)); this.mixHash(this.re); }
      else if (t === 's') this.rs = this.open(take(DHLEN + (this.cs.hasKey() ? TAGLEN : 0)));
      else this.mix(t);
    }
    const payload = this.open(take(Math.max(msg.length - at, TAGLEN)));
    this.step++;
    return payload;
  }

  split(): { send: CipherState; recv: CipherState } {
    if (!this.done) throw new NoiseError('the handshake is not done');
    const [k1, k2] = hkdf2(this.ck, EMPTY);
    const [c1, c2] = [new CipherState(Buffer.from(k1)), new CipherState(Buffer.from(k2))];
    return this.initiator ? { send: c1, recv: c2 } : { send: c2, recv: c1 };
  }
}

/** What both people compare: 8 hex of the handshake hash, which no third party can steer. */
export const checkString = (hash: Buffer): string => `${hash.toString('hex', 0, 2)}-${hash.toString('hex', 2, 4)}`;

export interface Channel {
  readonly remoteKey: Buffer;
  readonly hash: Buffer;
  readonly check: string;
  send(message: Uint8Array): void;
  /** Messages that arrived before a handler was set are handed to it then. */
  onMessage(fn: (message: Buffer) => void): void;
  /** Once, with the error that ended it or null. */
  onClose(fn: (error: Error | null) => void): void;
  close(): void;
}

/** What a peer may have us hold before a channel takes the frames: one frame of slack past the handshake's. */
const HELD_MAX = 2 * (MAX_FRAME + 2);
export const HANDSHAKE_MS = 10_000;

/** The stream as frames: next() for the handshake, then every frame to one sink. Until the sink is set, at most
 *  HELD_MAX bytes are held; pause() stops reading (the transport's own backpressure holds the rest) until drain(). */
function frames(stream: Duplex): {
  next(): Promise<Buffer>; pause(): void; drain(fn: (f: Buffer) => void): void; write(f: Buffer): void;
} {
  let buf: Buffer = EMPTY, held = 0, ended = false, sink: ((f: Buffer) => void) | null = null;
  const queue: Buffer[] = [];
  let waiter: { ok(f: Buffer): void; fail(e: Error): void } | null = null;
  const deliver = (f: Buffer): void => {
    if (sink) sink(f);
    else if (waiter) { const w = waiter; waiter = null; w.ok(f); } else { queue.push(f); held += 2 + f.length; }
  };
  stream.on('data', (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    const over = (): boolean => !sink && held + buf.length > HELD_MAX;
    while (!over() && buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
      const n = buf.readUInt16BE(0);
      const f = buf.subarray(2, 2 + n);
      buf = buf.subarray(2 + n);
      deliver(f);
    }
    if (over()) { buf = EMPTY; stream.destroy(new NoiseError('too much sent before the handshake was done')); }
  });
  const end = (): void => { ended = true; if (waiter) { const w = waiter; waiter = null; w.fail(new NoiseError('the stream closed during the handshake')); } };
  stream.on('close', end).on('end', end).on('error', end);
  return {
    next: () => {
      const f = queue.shift();
      if (f) { held -= 2 + f.length; return Promise.resolve(f); }
      if (ended) return Promise.reject(new NoiseError('the stream closed during the handshake'));
      return new Promise((ok, fail) => { waiter = { ok, fail }; });
    },
    pause: () => { stream.pause(); },
    drain: fn => { sink = fn; held = 0; for (const f of queue.splice(0)) fn(f); stream.resume(); },
    write: f => {
      const head = Buffer.alloc(2);
      head.writeUInt16BE(f.length);
      stream.write(Buffer.concat([head, f]));
    },
  };
}

function channel(stream: Duplex, io: ReturnType<typeof frames>, hs: Handshake): Channel {
  const { send, recv } = hs.split();
  const [remoteKey, hash] = [key32(hs.remoteKey, 'the peer key'), key32(hs.hash, 'the handshake hash')];
  let onMsg: ((m: Buffer) => void) | null = null, onEnd: ((e: Error | null) => void) | null = null;
  const early: Buffer[] = [];
  let parts: Buffer[] = [], size = 0, earlySize = 0, closed = false, why: Error | null = null;
  const finish = (e: Error | null): void => {
    if (closed) return;
    closed = true;
    why = e ?? (parts.length ? new NoiseError('the stream closed inside a message') : null);
    stream.destroy();
    onEnd?.(why);
  };
  io.drain(f => {
    if (closed) return;
    let p: Buffer;
    try { p = recv.decrypt(f); } catch (e) { return finish(e instanceof Error ? e : new NoiseError('a Noise message did not decrypt')); }
    const more = p[0];
    if (more !== 0 && more !== 1) return finish(new NoiseError('a frame with no continuation byte'));
    size += p.length - 1;
    if (size > MAX_MESSAGE) return finish(new NoiseError(`a message over ${MAX_MESSAGE} bytes`));
    parts.push(p.subarray(1));
    if (more === 1) return;
    const m = Buffer.concat(parts);
    parts = [];
    size = 0;
    if (onMsg) return onMsg(m);
    earlySize += m.length;
    if (earlySize > MAX_MESSAGE) return finish(new NoiseError('too many messages with nobody reading them'));
    early.push(m);
  });
  stream.on('close', () => finish(null)).on('error', (e: Error) => finish(e));
  return {
    remoteKey, hash, check: checkString(hash),
    send(message) {
      if (closed) throw new NoiseError('the channel is closed');
      if (message.length > MAX_MESSAGE) throw new NoiseError(`a message over ${MAX_MESSAGE} bytes`);
      const body = Buffer.from(message), step = MAX_PLAIN - 1;
      for (let at = 0; at === 0 || at < body.length; at += step) {
        const more = at + step < body.length ? 1 : 0;
        io.write(send.encrypt(Buffer.concat([Buffer.from([more]), body.subarray(at, at + step)])));
      }
    },
    onMessage(fn) { onMsg = fn; earlySize = 0; for (const m of early.splice(0)) fn(m); },
    onClose(fn) { onEnd = fn; if (closed) fn(why); },
    close() { finish(null); },
  };
}

/** Ends the stream when the handshake outlasts `ms`; the returned function stops the timer. */
function deadline(stream: Duplex, ms: number): () => void {
  const t = setTimeout(() => stream.destroy(new NoiseError('the handshake took too long')), ms);
  return () => clearTimeout(t);
}

const closedDuring = (): NoiseError => new NoiseError('the stream closed during the handshake');

/** The joiner's side: pinned to the host's key, proving its own; message 3 carries `payload` (the invite MAC or nothing). */
export async function connect(stream: Duplex, o: { s: KeyPair; rs: Buffer; payload?: Buffer; timeoutMs?: number }): Promise<Channel> {
  const io = frames(stream);
  const hs = new Handshake(true, { s: o.s, rs: o.rs });
  const done = deadline(stream, o.timeoutMs ?? HANDSHAKE_MS);
  try {
    io.write(hs.writeMessage());
    hs.readMessage(await io.next());
    io.write(hs.writeMessage(o.payload ?? EMPTY));
  } catch (e) { stream.destroy(); throw e; } finally { done(); }
  if (stream.destroyed) throw closedDuring();
  return channel(stream, io, hs);
}

/** The host's side. admit() sees the joiner's key and message 3's payload; false ends the stream (null). Nothing past
 *  message 3 is read until it answers. The timeout covers the three messages, not the host's answer. */
export async function accept(
  stream: Duplex,
  o: { s: KeyPair; timeoutMs?: number; admit(remoteKey: Buffer, payload: Buffer): boolean | Promise<boolean> },
): Promise<Channel | null> {
  const io = frames(stream);
  const hs = new Handshake(false, { s: o.s });
  const done = deadline(stream, o.timeoutMs ?? HANDSHAKE_MS);
  let payload: Buffer, admitted: boolean;
  try {
    hs.readMessage(await io.next());
    io.write(hs.writeMessage());
    payload = hs.readMessage(await io.next());
    io.pause();
  } catch (e) { stream.destroy(); throw e; } finally { done(); }
  try { admitted = await o.admit(key32(hs.remoteKey, 'the joiner key'), payload); } catch (e) { stream.destroy(); throw e; }
  if (!admitted || stream.destroyed) { stream.destroy(); return null; }
  return channel(stream, io, hs);
}
