'use strict';
/**
 * plugin/sub-human/lib/remote/transports/ws.js: the `wss` and `ws` kinds (./index.js register): protocol frames
 * over a Noise_NK channel (lib/remote/noise.js) inside a WebSocket (lib/remote/ws.js) to the host's listener
 * (lib/remote/listener.js), usually through a TLS front: Tailscale Serve or Funnel, or any HTTPS reverse proxy.
 * The front sees TLS-decrypted WebSocket frames that hold only Noise ciphertext; only the holder of the X25519 key
 * the invite pins can read them or answer. The PIN, the invite secret and the link token travel inside.
 *
 *   Locator  wss://HOST[:PORT]/PATH  (ws:// the same without TLS: tests, or a front on loopback). HOST is a DNS name or
 *            an IPv4 address; PATH is [A-Za-z0-9._~/-]* with no query, fragment or user info. Spec = {kind, host, port?,
 *            path}; the link file adds hostKey (the pinned X25519 public key, base64url), from the invite's host-key
 *            field (sh2 field 5: for a ws/wss locator it is this key, for ssh the sshd Ed25519 host key)
 *   Join URL https://HOST[:PORT]/PATH/CODE#SECRET.HOSTKEY   the same sh2 invite as a link a person can paste:
 *            the last path segment is the room code, the fragment the 128-bit invite secret and the pinned key (a
 *            fragment never leaves the joiner's machine in a request). http:// gives a ws:// locator. The PIN is never
 *            in it; it is typed apart
 *   parse(rest) -> Spec | null          the locator's rest ("//host:port/path")
 *   locator({host, port?, path}, secure = true) -> string | null
 *   joinUrl({locator, secret, hostKey}) -> string        the URL form of an sh2 ws/wss invite
 *   parseJoinUrl(text) -> {v: 2, code, locator, secret, hostKey, invite} | null   invite: the canonical sh2 string
 *                                       (lib/remote/auth.js formatInvite) the hello carries
 *   urlOf(spec) -> 'wss://host[:port]/path'
 *   PROLOGUE                            the Noise prologue, 'sub-human ws1'
 *   clientChannel(conn, {rs, code, timeoutMs?}) -> Promise<Duplex>   the initiator: message 1 carries {v: 1, room};
 *       message 2's payload is {ok: true} or {error: {code, message}} (authenticated: only the pinned key could
 *       write it) -> RoomError with that code. Message 2 failing to decrypt is AUTH: whoever answered does not hold
 *       the key the invite pinned. A close before message 2 is OFFLINE with the listener's reason
 *   serverChannel(conn, {s, check(hello) -> {code, message} | null, timeoutMs?}) -> Promise<{duplex, hello}>   the
 *       responder; check refuses a room (its error is sent in message 2, then the conn closes)
 *   The Duplex: plaintext bytes; each write is cut into Noise messages of at most noise.MAX_PLAINTEXT bytes, each one
 *   binary WebSocket message. A message that does not decrypt, or a text message, closes the conn (1002 / 1003).
 *   kind = {parse, open, describe}      open(spec, {code}) connects (lib/remote/ws.js connect, so HTTPS_PROXY / NO_PROXY
 *       apply; within WS_CONNECT_MS, 45 s: a ts.net name's first TLS handshake waits on its certificate), runs
 *       clientChannel and returns the transport (./index.js fromDuplex). A failed connect is OFFLINE (the link daemon
 *       retries); INVALID without a code or a pinned key
 */

const { Duplex } = require('node:stream');
const { RoomError } = require('../../room/validate.js');

const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*\.?$/;
const PATH_RE = /^\/[A-Za-z0-9._~/-]{0,200}$/;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{16,128}$/;
const PROLOGUE = Buffer.from('sub-human ws1');
const HANDSHAKE_MS = 10_000;

const noise = () => require('../noise.js');
const ws = () => require('../ws.js');

function parse(rest) {
  const m = /^\/\/([^/:?#@\s]+)(?::([0-9]{1,5}))?(\/[^?#\s]*)?$/.exec(String(rest));
  if (!m || !HOST_RE.test(m[1]) || m[1].includes('..')) return null;
  const port = m[2] === undefined ? undefined : Number(m[2]);
  if (port !== undefined && !(port >= 1 && port <= 65535)) return null;
  const p = m[3] || '/';
  if (!PATH_RE.test(p) || /(^|\/)\.\.?(\/|$)/.test(p)) return null;
  return { host: m[1].toLowerCase(), ...(port ? { port } : {}), path: p };
}

const hostPort = s => `${s.host}${s.port ? `:${s.port}` : ''}`;
const urlOf = s => `${s.kind === 'ws' ? 'ws' : 'wss'}://${hostPort(s)}${s.path}`;

function locator({ host, port, path = '/' }, secure = true) {
  const kind = secure ? 'wss' : 'ws';
  const rest = `//${String(host).toLowerCase()}${port ? `:${port}` : ''}${path}`;
  return parse(rest) ? `${kind}:${rest}` : null;
}

function joinUrl({ locator: loc, secret, hostKey }) {
  const i = loc.indexOf(':');
  const spec = parse(loc.slice(i + 1));
  if (!spec || !hostKey) throw new RoomError('INVALID', 'a join URL needs a ws/wss locator and the host key');
  return `${loc.slice(0, i) === 'ws' ? 'http' : 'https'}://${hostPort(spec)}${spec.path}#${secret}.${hostKey}`;
}

function parseJoinUrl(text) {
  const m = /^(https?):\/\/([^#\s]+)#([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(text).trim());
  if (!m) return null;
  const spec = parse(`//${m[2]}`);
  if (!spec || !SECRET_RE.test(m[3]) || !KEY_RE.test(m[4])) return null;
  const code = spec.path.split('/').filter(Boolean).pop();
  const { CODE_RE } = require('../../text.js');
  if (!code || !CODE_RE.test(code)) return null;
  const loc = locator(spec, m[1] === 'https');
  const invite = require('../auth.js').formatInvite({ v: 2, code, locator: loc, secret: m[3], hostKey: m[4] });
  return { v: 2, code, locator: loc, secret: m[3], hostKey: m[4], invite };
}

/** Plaintext bytes over a conn after the handshake: send/recv are the split CipherStates. */
function channel(conn, { send, recv }) {
  const { MAX_PLAINTEXT } = noise();
  const d = new Duplex({
    write(chunk, enc, cb) {
      try {
        for (let o = 0; o < chunk.length; o += MAX_PLAINTEXT) conn.send(send.encrypt(chunk.subarray(o, o + MAX_PLAINTEXT)));
        cb();
      } catch (e) { cb(e); }
    },
    read() {},
    final(cb) { conn.close(1000, 'done'); cb(); },
    destroy(err, cb) { if (conn.state !== 'closed') conn.close(1000, 'done'); cb(err); },
  });
  conn.on('message', (data, binary) => {
    if (!binary) return conn.close(1003, 'binary Noise messages only');
    let pt;
    try { pt = recv.decrypt(data); } catch { conn.close(1002, 'a message did not decrypt'); return; }
    d.push(pt);
  });
  conn.on('close', () => { d.push(null); d.destroy(); });
  return d;
}

const jsonOf = buf => { try { return JSON.parse(buf.toString('utf8')); } catch { return null; } };

/** The first binary message on conn (or a close / timeout). */
function firstMessage(conn, timeoutMs, what) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { done(); conn.terminate(); reject(new RoomError('OFFLINE', `${what}: no answer within ${timeoutMs} ms`)); }, timeoutMs);
    const onMsg = (data, binary) => { done(); if (!binary) { conn.close(1003, 'binary only'); return reject(new RoomError('PROTOCOL', `${what}: a text message`)); } resolve(data); };
    const onClose = (code, reason) => { done(); reject(new RoomError('OFFLINE', `${what}: closed (${code}${reason ? ` ${reason}` : ''})`)); };
    const done = () => { clearTimeout(t); conn.off('message', onMsg); conn.off('close', onClose); };
    conn.on('message', onMsg);
    conn.on('close', onClose);
  });
}

async function clientChannel(conn, { rs, code, timeoutMs = HANDSHAKE_MS }) {
  const hs = noise().initiator({ rs, prologue: PROLOGUE });
  conn.send(hs.writeMessage(Buffer.from(JSON.stringify({ v: 1, room: code }))));
  const m2 = await firstMessage(conn, timeoutMs, 'the host\'s listener');
  let payload;
  try { payload = hs.readMessage(m2); } catch {
    conn.close(1002, 'handshake failed');
    throw new RoomError('AUTH', 'the host did not prove the key the invite pinned (Noise message 2 does not decrypt): a wrong or changed host key, or someone in between');
  }
  const r = jsonOf(payload);
  if (!r || r.error || r.ok !== true) {
    conn.close(1000, 'refused');
    const e = r && r.error;
    throw new RoomError(e && ['OFFLINE', 'AUTH', 'PROTOCOL', 'NO_ROOM'].includes(e.code) ? e.code : 'PROTOCOL', `the host refused: ${(e && e.message) || 'no answer'}`);
  }
  return channel(conn, hs.split());
}

async function serverChannel(conn, { s, check = () => null, timeoutMs = HANDSHAKE_MS }) {
  const hs = noise().responder({ s, prologue: PROLOGUE });
  const m1 = await firstMessage(conn, timeoutMs, 'the joiner');
  let hello;
  try { hello = jsonOf(hs.readMessage(m1)); } catch {
    conn.close(4401, 'handshake failed');
    throw new RoomError('AUTH', 'a Noise message 1 that does not decrypt (sent to another host key)');
  }
  const refusal = !hello || hello.v !== 1 || typeof hello.room !== 'string'
    ? { code: 'PROTOCOL', message: 'a handshake with no room' }
    : check(hello);
  conn.send(hs.writeMessage(Buffer.from(JSON.stringify(refusal ? { error: refusal } : { ok: true }))));
  if (refusal) {
    conn.close(4404, 'refused');
    throw new RoomError(refusal.code, refusal.message);
  }
  return { duplex: channel(conn, hs.split()), hello };
}

const kind = {
  parse,
  async open(spec, ctx = {}) {
    if (!ctx.code) throw new RoomError('INVALID', `a ${spec.kind} transport connects to a room: open(spec, {code})`);
    const s = parse(`//${hostPort(spec)}${spec.path}`);
    if (!s) throw new RoomError('INVALID', 'the link\'s WebSocket URL is not a plain host[:port]/path');
    if (typeof spec.hostKey !== 'string' || !KEY_RE.test(spec.hostKey)) throw new RoomError('INVALID', 'the link pins no host key (a ws/wss invite carries one)');
    const url = urlOf({ ...s, kind: spec.kind });
    let conn;
    try {
      const config = require('../../config.js');
      conn = await ws().connect(url, { maxPayload: noise().MAX_MESSAGE + 64, timeoutMs: config.envMs('SUB_HUMAN_WS_CONNECT_MS', config.WS_CONNECT_MS) });
    } catch (e) { throw new RoomError('OFFLINE', e.message); }
    try {
      const duplex = await clientChannel(conn, { rs: Buffer.from(spec.hostKey, 'base64url'), code: ctx.code });
      return require('./index.js').fromDuplex(duplex);
    } catch (e) {
      conn.terminate();
      throw e;
    }
  },
  describe: spec => `${spec.kind} ${hostPort(spec)}${spec.path}`,
};

module.exports = { parse, locator, joinUrl, parseJoinUrl, urlOf, PROLOGUE, clientChannel, serverChannel, kind };
