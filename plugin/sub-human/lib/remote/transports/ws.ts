/**
 * plugin/sub-human/lib/remote/transports/ws.ts: the `wss` and `ws` kinds (./index.ts register): protocol frames
 * over a Noise channel (lib/remote/noise.ts) inside a WebSocket (lib/remote/ws.ts) to the host's listener
 * (lib/remote/listener.ts) through a TLS front: Tailscale Serve or Funnel (the tests and the lab: a front of their own).
 * The front sees TLS-decrypted WebSocket frames that hold only Noise ciphertext; only the holder of the X25519 key
 * the link pins can read them or answer. The PIN, the invite line's secret and the link token travel inside.
 *
 * Noise XK (prologue 'sub-human ws3'): the link proves a key of its own in message 3, and the host binds the link to
 * it (lib/remote/host-links.ts keyHolds).
 *
 *
 * Locator wss://HOST[:PORT]/PATH (ws:// without TLS: tests, or a front on loopback), plain: a DNS name or IPv4, no
 * query, fragment or user info. The link file adds hostKey (the pinned listener key: a bound invite's host-key field,
 * or for an invite line the key the listener gave once the line's tag named it) and clientKey (the link's own).
 *
 * Handshake: message 1 carries {v: 3, room}; message 2's payload is {ok: true} or {error: {code, message}},
 * authenticated (only the pinned key could write it). Message 2 failing to decrypt is AUTH: whoever answered does not
 * hold the key the link pinned; a close before it is OFFLINE. Message 3 carries the link's key, and serverChannel's
 * peer is the key it proved. fetchKey is unauthenticated (a TEXT {"op": "key", "v": 3}): an invite line's first dial
 * uses its answer only once the line's tag names it (link-connect.ts), so nothing secret goes before. After the
 * handshake each write is cut into Noise messages of at most noise.MAX_PLAINTEXT bytes, one binary WebSocket message
 * each; a message that does not decrypt, or a text message, closes the conn (1002 / 1003). open connects within
 * WS_CONNECT_MS (45 s: a ts.net name's first TLS handshake waits on its certificate); a ts.net name it cannot reach
 * in that time (or resolve) says the host may need Funnel (offline: OFF_TAILNET_HINT).
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
const PROLOGUE: Buffer = Buffer.from('sub-human ws3');
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

async function clientChannel(conn: Conn, { rs, code, s, timeoutMs = HANDSHAKE_MS }: { rs: Buffer; code: RoomCode; s: KeyPair; timeoutMs?: number }): Promise<Duplex> {
  const hs = noise().initiator({ rs, s, prologue: PROLOGUE });
  conn.send(hs.writeMessage(Buffer.from(JSON.stringify({ v: 3, room: code }))));
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
  conn.send(hs.writeMessage()); // message 3: this link's own key
  return channel(conn, hs.split());
}

async function serverChannel(conn: Conn, { s, check = () => null, timeoutMs = HANDSHAKE_MS, m1: first }: {
  s: KeyPair; check?: (hello: WsHello) => Refusal | null; timeoutMs?: number; m1?: Buffer;
}): Promise<{ duplex: Duplex; hello: WsHello; peer: Buffer | null }> {
  const m1 = first ?? await firstMessage(conn, timeoutMs, 'the joiner');
  const hs = noise().responder({ s, prologue: PROLOGUE });
  let hello: WsHello | null;
  try { hello = jsonOf(hs.readMessage(m1)) as WsHello | null; } catch {
    conn.close(4401, 'handshake failed');
    throw new RoomError('AUTH', 'a Noise message 1 that does not decrypt (sent to another host key)');
  }
  const refusal = !hello || hello.v !== 3 || typeof hello.room !== 'string'
    ? { code: 'PROTOCOL' as const, message: 'a handshake with no room' }
    : check(hello);
  const after = !refusal ? collector(conn) : null; // before message 2: message 3 and what follows it may come at once
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

// a ts.net name the joiner's machine cannot reach (no answer within WS_CONNECT_MS, or no such name for it): a host's
// Serve answers inside its tailnet only, so the host may need Funnel
const TS_NET_RE = /\.ts\.net\.?$/i;
const UNREACHED_RE = /no WebSocket to \S+ within \d+ ms|ENOTFOUND|EAI_AGAIN/;
const OFF_TAILNET_HINT = 'if this machine is not on the host\'s tailnet, the host may need /sub-human invite --public';

/** connect()'s failure as OFFLINE, with the --public hint for a ts.net name it could not reach. */
function offline(host: string, e: unknown): RoomError {
  const m = msgOf(e);
  return new RoomError('OFFLINE', TS_NET_RE.test(host) && UNREACHED_RE.test(m) ? `${m} (${OFF_TAILNET_HINT})` : m);
}

/** The listener's X25519 key, as it says it (a TEXT request): checked by the caller against an invite line's tag. */
async function fetchKey(spec: WsAddr & SpecBase, { timeoutMs = envMs('SUB_HUMAN_WS_CONNECT_MS') }: { timeoutMs?: number } = {}): Promise<string> {
  const s = parse(`//${hostPort(spec)}${spec.path}`);
  if (!s) throw new RoomError('INVALID', 'the link\'s WebSocket URL is not a plain host[:port]/path');
  let conn: Conn;
  try { conn = await ws().connect(urlOf({ ...s, kind: spec.kind }), { maxPayload: 4096, timeoutMs }); } catch (e) { throw offline(s.host, e); }
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
    const own = ctx.clientKey; // the link's own key
    if (spec.clientKey === undefined || !own || own.pub.toString('base64url') !== spec.clientKey) throw new RoomError('INVALID', 'the link\'s own key is missing or is not the one its file names; join again with a new invite');
    const url = urlOf({ ...s, kind: spec.kind });
    let conn: Conn;
    try {
      conn = await ws().connect(url, { maxPayload: noise().MAX_MESSAGE + 64, timeoutMs: envMs('SUB_HUMAN_WS_CONNECT_MS') });
    } catch (e) { throw offline(s.host, e); }
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

export { parse, locator, urlOf, offline, OFF_TAILNET_HINT, PROLOGUE, clientChannel, serverChannel, firstAny, fetchKey, kind };
