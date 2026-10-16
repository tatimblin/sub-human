/**
 * plugin/sub-human/lib/remote/transports/ws.ts: the `wss` and `ws` kinds (./index.ts register): protocol frames
 * over a Noise channel (lib/remote/noise.ts) inside a WebSocket (lib/remote/ws.ts) to the host's listener
 * (lib/remote/listener.ts), usually through a TLS front: Tailscale Serve or Funnel, or any HTTPS reverse proxy.
 * The front sees TLS-decrypted WebSocket frames that hold only Noise ciphertext; only the holder of the X25519 key
 * the link pins can read them or answer. The PIN, the invite line's secret and the link token travel inside.
 *
 * Two patterns, one listener: XK (protocol 3, prologue 'sub-human ws3'): the link proves a key of its own in message
 * 3, and the host binds the link to it (lib/remote/host-links.ts keyHolds); NK (protocol 2, prologue 'sub-human ws1'):
 * a link made before, which keeps working by its token until it is invited again or revoked. The listener tells them
 * apart by which one message 1 decrypts as.
 *
 *   Locator  wss://HOST[:PORT]/PATH  (ws:// the same without TLS: tests, or a front on loopback). HOST is a DNS name or
 *            an IPv4 address; PATH is [A-Za-z0-9._~/-]* with no query, fragment or user info. Spec = {kind, host, port?,
 *            path}; the link file adds hostKey (the pinned X25519 public key, base64url: an sh2 invite's host-key field,
 *            or, for an invite line, the key the listener gave once its tag held) and clientKey (the link's own)
 *   Join URL https://HOST[:PORT]/PATH/ROOM   what `/sub-human invite --web` shows with the line's SECRET: the last path
 *            segment is the room; http:// gives a ws:// locator
 *   parse(rest) -> Spec | null          the locator's rest ("//host:port/path")
 *   locator({host, port?, path}, secure = true) -> string | null
 *   urlOf(spec) -> 'wss://host[:port]/path'
 *   PROLOGUE, PROLOGUE3                 the Noise prologues, 'sub-human ws1' (NK) and 'sub-human ws3' (XK)
 *   clientChannel(conn, {rs, code, s?, timeoutMs?}) -> Promise<Duplex>   the initiator: XK with s (the link's own pair),
 *       else NK; message 1 carries {v: 3 | 1, room}; message 2's payload is {ok: true} or {error: {code, message}}
 *       (authenticated: only the pinned key could write it) -> RoomError with that code; XK's message 3 then carries s.
 *       Message 2 failing to decrypt is AUTH: whoever answered does not hold the key the link pinned. A close before
 *       message 2 is OFFLINE with the listener's reason
 *   serverChannel(conn, {s, check(hello) -> {code, message} | null, timeoutMs?, m1?}) -> Promise<{duplex, hello, peer}>
 *       the responder: message 1 read as XK, else as NK; check refuses a room (its error is sent in message 2, then the
 *       conn closes); XK waits for message 3, and peer is the key it proved (null for NK); m1: message 1 when the caller
 *       read it already (the listener peeks: a TEXT first message is a key request instead)
 *   firstAny(conn, timeoutMs) -> Promise<{data, binary}>   the first message of either kind
 *   fetchKey(spec, {timeoutMs?}) -> Promise<key>   the listener's X25519 key (base64url), unauthenticated: a TEXT
 *       {"op": "key", "v": 3} answered {"key"}. An invite line's first dial reads it so, and uses it only once the
 *       line's tag names it (lib/remote/link-connect.ts): nothing secret goes before
 *   The Duplex: plaintext bytes; each write is cut into Noise messages of at most noise.MAX_PLAINTEXT bytes, each one
 *   binary WebSocket message. A message that does not decrypt, or a text message, closes the conn (1002 / 1003).
 *   kind = {parse, open, describe}      open(spec, {code, clientKey?}) connects (lib/remote/ws.ts connect, so
 *       HTTPS_PROXY / NO_PROXY apply; within WS_CONNECT_MS, 45 s: a ts.net name's first TLS handshake waits on its
 *       certificate), runs clientChannel (XK when the spec names a clientKey, which must be ctx.clientKey's) and returns
 *       the transport (./index.ts fromDuplex). A failed connect is OFFLINE (the link daemon retries); INVALID without a
 *       code or a pinned key
 */

import { Duplex } from 'node:stream';
import { RoomError } from '../../room/validate.ts';
import { envMs } from '../../env.ts';
import type { KindEntry, OpenCtx, Refusal, SpecBase, Transport, WsAddr, WsHello, WsSpec } from '../types-rest.ts';
import type { CipherState, KeyPair } from '../noise.ts';
import type { Conn } from '../ws.ts';
import { errCode, msgOf } from '../../errors.ts';
import type { RoomCode } from '../../brand.ts';
import type * as NoiseMod from '../noise.ts';
import type * as WsMod from '../ws.ts';
import type * as TransportsMod from './index.ts';
import { lazy } from '../../io.ts';

// the transport table only to wrap a connection (start cost)
const transportsLib = lazy<typeof TransportsMod>(import.meta.url, './index.ts');

const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*\.?$/;
const PATH_RE = /^\/[A-Za-z0-9._~/-]{0,200}$/;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const PROLOGUE: Buffer = Buffer.from('sub-human ws1');
const PROLOGUE3: Buffer = Buffer.from('sub-human ws3');
const HANDSHAKE_MS = 10_000;

// lib/remote/noise.ts and lib/remote/ws.ts, loaded on first use
const noise = lazy<typeof NoiseMod>(import.meta.url, '../noise.ts');
const ws = lazy<typeof WsMod>(import.meta.url, '../ws.ts');

function parse(rest: string): WsAddr | null {
  const m = /^\/\/([^/:?#@\s]+)(?::([0-9]{1,5}))?(\/[^?#\s]*)?$/.exec(String(rest));
  if (!m) return null;
  const [, host = '', pt, path] = m; // the host always matches
  if (!HOST_RE.test(host) || host.includes('..')) return null;
  const port = pt === undefined ? undefined : Number(pt);
  if (port !== undefined && !(port >= 1 && port <= 65535)) return null;
  const p = path || '/';
  if (!PATH_RE.test(p) || /(^|\/)\.\.?(\/|$)/.test(p)) return null;
  return { host: host.toLowerCase(), ...(port ? { port } : {}), path: p };
}

const hostPort = (s: { host: string; port?: number }): string => `${s.host}${s.port ? `:${s.port}` : ''}`;
const urlOf = (s: WsAddr & SpecBase): string => `${s.kind === 'ws' ? 'ws' : 'wss'}://${hostPort(s)}${s.path}`;

function locator({ host, port, path = '/' }: { host: string; port?: number | undefined; path?: string }, secure = true): string | null {
  const kind = secure ? 'wss' : 'ws';
  const rest = `//${String(host).toLowerCase()}${port ? `:${port}` : ''}${path}`;
  return parse(rest) ? `${kind}:${rest}` : null;
}

/** Plaintext bytes over a conn after the handshake: send/recv are the split CipherStates; early: messages that came
 * before the channel did (XK: the joiner's first frames can arrive with its message 3). */
function channel(conn: Conn, { send, recv }: { send: CipherState; recv: CipherState }, early: Buffer[] = []): Duplex {
  const { MAX_PLAINTEXT } = noise();
  const d = new Duplex({
    write(chunk: Buffer, _enc, cb) {
      try {
        for (let o = 0; o < chunk.length; o += MAX_PLAINTEXT) conn.send(send.encrypt(chunk.subarray(o, o + MAX_PLAINTEXT)));
        cb();
      } catch (e) { cb(e instanceof Error ? e : new Error(msgOf(e))); }
    },
    read() {},
    final(cb) { conn.close(1000, 'done'); cb(); },
    destroy(err, cb) { if (conn.state !== 'closed') conn.close(1000, 'done'); cb(err); },
  });
  const onMessage = (data: Buffer, binary: boolean): void => {
    if (!binary) return conn.close(1003, 'binary Noise messages only');
    let pt: Buffer;
    try { pt = recv.decrypt(data); } catch { conn.close(1002, 'a message did not decrypt'); return; }
    d.push(pt);
  };
  for (const m of early) onMessage(m, true);
  conn.on('message', onMessage);
  conn.on('close', () => { d.push(null); d.destroy(); });
  return d;
}

/** Every binary message from now on, in order: next() the following one (or a close / timeout); rest() the ones not
 * taken, and no more are kept. */
function collector(conn: Conn): { next(timeoutMs: number, what: string): Promise<Buffer>; rest(): Buffer[] } {
  const got: Buffer[] = [];
  let wake: (() => void) | null = null, closed: string | null = null;
  const onMsg = (data: Buffer, binary: boolean) => { if (!binary) { closed = 'a text message'; conn.close(1003, 'binary only'); } else got.push(data); if (wake) wake(); };
  const onClose = (code: number, reason: string) => { closed = `closed (${code}${reason ? ` ${reason}` : ''})`; if (wake) wake(); };
  conn.on('message', onMsg);
  conn.on('close', onClose);
  return {
    async next(timeoutMs, what) {
      const until = Date.now() + timeoutMs;
      let m = got.shift();
      while (m === undefined) {
        if (closed) throw new RoomError('OFFLINE', `${what}: ${closed}`);
        const left = until - Date.now();
        if (left <= 0) { conn.terminate(); throw new RoomError('OFFLINE', `${what}: no answer within ${timeoutMs} ms`); }
        await new Promise<void>(r => { const t = setTimeout(r, left); wake = () => { clearTimeout(t); wake = null; r(); }; });
        m = got.shift();
      }
      return m;
    },
    rest() { conn.off('message', onMsg); conn.off('close', onClose); return got.splice(0); },
  };
}

const jsonOf = (buf: Buffer): unknown => { try { return JSON.parse(buf.toString('utf8')); } catch { return null; } };

/** The first binary message on conn (or a close / timeout). */
function firstMessage(conn: Conn, timeoutMs: number, what: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { done(); conn.terminate(); reject(new RoomError('OFFLINE', `${what}: no answer within ${timeoutMs} ms`)); }, timeoutMs);
    const onMsg = (data: Buffer, binary: boolean) => { done(); if (!binary) { conn.close(1003, 'binary only'); return reject(new RoomError('PROTOCOL', `${what}: a text message`)); } resolve(data); };
    const onClose = (code: number, reason: string) => { done(); reject(new RoomError('OFFLINE', `${what}: closed (${code}${reason ? ` ${reason}` : ''})`)); };
    const done = () => { clearTimeout(t); conn.off('message', onMsg); conn.off('close', onClose); };
    conn.on('message', onMsg);
    conn.on('close', onClose);
  });
}

/** The first message, text or binary (or a close / timeout). */
function firstAny(conn: Conn, timeoutMs: number): Promise<{ data: Buffer; binary: boolean }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { done(); conn.terminate(); reject(new RoomError('OFFLINE', `the joiner: no message within ${timeoutMs} ms`)); }, timeoutMs);
    const onMsg = (data: Buffer, binary: boolean) => { done(); resolve({ data, binary }); };
    const onClose = (code: number) => { done(); reject(new RoomError('OFFLINE', `the joiner: closed (${code})`)); };
    const done = () => { clearTimeout(t); conn.off('message', onMsg); conn.off('close', onClose); };
    conn.on('message', onMsg);
    conn.on('close', onClose);
  });
}

const REFUSAL_CODES = ['OFFLINE', 'AUTH', 'PROTOCOL', 'NO_ROOM'] as const;
const refusalCode = (c: unknown): c is typeof REFUSAL_CODES[number] => REFUSAL_CODES.some(x => x === c);

async function clientChannel(conn: Conn, { rs, code, s = null, timeoutMs = HANDSHAKE_MS }: { rs: Buffer; code: RoomCode; s?: KeyPair | null | undefined; timeoutMs?: number }): Promise<Duplex> {
  const xk = !!s;
  const hs = noise().initiator({ rs, s, pattern: xk ? 'XK' : 'NK', prologue: xk ? PROLOGUE3 : PROLOGUE });
  conn.send(hs.writeMessage(Buffer.from(JSON.stringify({ v: xk ? 3 : 1, room: code }))));
  const m2 = await firstMessage(conn, timeoutMs, 'the host\'s listener');
  let payload;
  try { payload = hs.readMessage(m2); } catch {
    conn.close(1002, 'handshake failed');
    throw new RoomError('AUTH', 'the host did not prove the key this link pinned (Noise message 2 does not decrypt): a wrong or changed host key, or someone in between');
  }
  const r = jsonOf(payload) as { ok?: unknown; error?: { code?: unknown; message?: unknown } } | null; // checked below
  if (!r || r.error || r.ok !== true) {
    conn.close(1000, 'refused');
    const e = r && r.error;
    throw new RoomError(e && refusalCode(e.code) ? e.code : 'PROTOCOL', `the host refused: ${(e && e.message) || 'no answer'}`);
  }
  if (xk) conn.send(hs.writeMessage()); // message 3: this link's own key
  return channel(conn, hs.split());
}

async function serverChannel(conn: Conn, { s, check = () => null, timeoutMs = HANDSHAKE_MS, m1: first }: {
  s: KeyPair; check?: (hello: WsHello) => Refusal | null; timeoutMs?: number; m1?: Buffer;
}): Promise<{ duplex: Duplex; hello: WsHello; peer: Buffer | null }> {
  const m1 = first ?? await firstMessage(conn, timeoutMs, 'the joiner');
  let hs: ReturnType<ReturnType<typeof noise>['responder']> | null = null, hello: WsHello | null = null; // checked below
  for (const [pattern, prologue] of [['XK', PROLOGUE3], ['NK', PROLOGUE]] as const) {
    const h = noise().responder({ s, pattern, prologue });
    try { hello = jsonOf(h.readMessage(m1)) as WsHello | null; hs = h; break; } catch { /* the other pattern, or another key */ }
  }
  if (!hs) {
    conn.close(4401, 'handshake failed');
    throw new RoomError('AUTH', 'a Noise message 1 that does not decrypt (sent to another host key)');
  }
  const xk = hs.pattern === 'XK';
  const refusal = !hello || hello.v !== (xk ? 3 : 1) || typeof hello.room !== 'string'
    ? { code: 'PROTOCOL' as const, message: 'a handshake with no room' }
    : check(hello);
  const after = xk && !refusal ? collector(conn) : null; // before message 2: message 3 and what follows it may come at once
  conn.send(hs.writeMessage(Buffer.from(JSON.stringify(refusal ? { error: refusal } : { ok: true }))));
  if (refusal) {
    conn.close(4404, 'refused');
    throw new RoomError(refusal.code, refusal.message);
  }
  if (!after) return { duplex: channel(conn, hs.split()), hello: hello as WsHello, peer: null };
  try { hs.readMessage(await after.next(timeoutMs, 'the joiner\'s message 3')); } catch (e) {
    after.rest();
    conn.close(4401, 'handshake failed');
    throw errCode(e) === 'OFFLINE' ? e : new RoomError('AUTH', 'a Noise message 3 that does not decrypt');
  }
  return { duplex: channel(conn, hs.split(), after.rest()), hello: hello as WsHello, peer: hs.remoteStatic };
}

/** The listener's X25519 key, as it says it (a TEXT request): checked by the caller against an invite line's tag. */
async function fetchKey(spec: WsAddr & SpecBase, { timeoutMs = envMs('SUB_HUMAN_WS_CONNECT_MS') }: { timeoutMs?: number } = {}): Promise<string> {
  const s = parse(`//${hostPort(spec)}${spec.path}`);
  if (!s) throw new RoomError('INVALID', 'the link\'s WebSocket URL is not a plain host[:port]/path');
  let conn: Conn;
  try { conn = await ws().connect(urlOf({ ...s, kind: spec.kind }), { maxPayload: 4096, timeoutMs }); } catch (e) { throw new RoomError('OFFLINE', msgOf(e)); }
  try {
    conn.send(JSON.stringify({ op: 'key', v: 3 }));
    const m = await firstAny(conn, HANDSHAKE_MS);
    const r = !m.binary ? jsonOf(m.data) as { key?: unknown; error?: { code?: unknown; message?: unknown } } | null : null;
    if (r && typeof r.key === 'string' && KEY_RE.test(r.key)) return r.key;
    const e = r && r.error;
    throw new RoomError(e && refusalCode(e.code) ? e.code : 'PROTOCOL', `the host's listener gave no key${e && e.message ? `: ${e.message}` : ' (an older sub-human there: ask the host to update)'}`);
  } finally { conn.close(1000, 'done'); }
}

const kind: Required<KindEntry<WsSpec>> = {
  parse,
  async open(spec, ctx: OpenCtx = {}): Promise<Transport> {
    if (!ctx.code) throw new RoomError('INVALID', `a ${spec.kind} transport connects to a room: open(spec, {code})`);
    const s = parse(`//${hostPort(spec)}${spec.path}`);
    if (!s) throw new RoomError('INVALID', 'the link\'s WebSocket URL is not a plain host[:port]/path');
    if (typeof spec.hostKey !== 'string' || !KEY_RE.test(spec.hostKey)) throw new RoomError('INVALID', 'the link pins no host key (a ws/wss invite carries one)');
    const own = spec.clientKey !== undefined ? ctx.clientKey : null; // XK: the link's own key (NK: a link made under protocol 2)
    if (spec.clientKey !== undefined && (!own || own.pub.toString('base64url') !== spec.clientKey)) throw new RoomError('INVALID', 'the link\'s own key is missing or is not the one its file names; join again with a new invite');
    const url = urlOf({ ...s, kind: spec.kind });
    let conn: Conn;
    try {
      conn = await ws().connect(url, { maxPayload: noise().MAX_MESSAGE + 64, timeoutMs: envMs('SUB_HUMAN_WS_CONNECT_MS') });
    } catch (e) { throw new RoomError('OFFLINE', msgOf(e)); }
    try {
      const duplex = await clientChannel(conn, { rs: Buffer.from(spec.hostKey, 'base64url'), code: ctx.code, s: own });
      return transportsLib().fromDuplex(duplex);
    } catch (e) {
      conn.terminate();
      throw e;
    }
  },
  describe: spec => `${spec.kind} ${hostPort(spec)}${spec.path}`,
};

export { parse, locator, urlOf, PROLOGUE, PROLOGUE3, clientChannel, serverChannel, firstAny, fetchKey, kind };
