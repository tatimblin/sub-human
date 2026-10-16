/**
 * plugin/sub-human/lib/remote/ws.ts: a minimal WebSocket (RFC 6455) with no dependencies: the server end for the
 * host's listener (lib/remote/listener.ts, an http server on 127.0.0.1 only) and the client end for the joiner's
 * link daemon (lib/remote/transports/ws.ts) over net or tls, through an HTTP CONNECT proxy when the environment
 * names one (a corporate network that allows only CONNECT to 443). Node's global WebSocket is not used: it has no
 * proxy support. No extensions (no permessage-deflate) and no subprotocols are negotiated.
 *
 * A frame or a reassembled message larger than maxPayload (default 1 MiB) closes 1009. Fragmented messages are
 * reassembled; control frames may come between fragments. A server refuses unmasked client frames, a client masked
 * server frames (1002). Text must be valid UTF-8 (1007). 'error' is emitted only with a listener; a protocol error
 * closes and emits close. pingMs > 0: a ping every pingMs, and no frame at all from the peer for two intervals
 * terminates the connection (a half-open link; it also keeps idle proxies from cutting it). connect rejects an Error
 * with code WS_CONNECT and a message that says which step failed (proxy, TLS, the HTTP status). proxyFor: wss/https
 * reads HTTPS_PROXY (else ALL_PROXY), ws/http HTTP_PROXY, either case; none for a host NO_PROXY names ("*", a host,
 * ".suffix" or "suffix" for the domain and its subdomains, host:port) or a loopback host.
 */

import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';

/** The byte stream under a Conn: an upgraded http socket, or a net/tls socket (setNoDelay when it has one). */
type WsSocket = Duplex & { setNoDelay?(noDelay?: boolean): unknown };
type ConnState = 'open' | 'closing' | 'closed';
interface ConnOptions { client: boolean; maxPayload?: number | undefined; pingMs?: number | undefined; head?: Buffer | null }
interface AcceptOptions { maxPayload?: number | undefined; pingMs?: number | undefined }
interface ServerOptions extends AcceptOptions {
  host?: string;
  port: number;
  onConnection(conn: Conn, req: http.IncomingMessage): void;
  accept?(req: http.IncomingMessage): boolean | number;
}
interface ConnectOptions extends AcceptOptions {
  proxy?: string | null;
  headers?: Record<string, string>;
  timeoutMs?: number;
  tls?: tls.ConnectionOptions;
  env?: NodeJS.ProcessEnv;
}
/** An HTTP answer head read off a socket. */
interface Head { status: number; headers: Record<string, string>; rest: Buffer; line: string }
/** A WebSocket protocol failure as the 'error' event carries it. */
type WsError = Error & { code: 'WS_PROTOCOL'; closeCode: number };
/** A Conn's events and what each carries. */
type ConnEvents = {
  message: [data: Buffer, binary: boolean];
  close: [code: number, reason: string];
  error: [err: Error];
  ping: [payload: Buffer];
  pong: [payload: Buffer];
};

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD: number = 1024 * 1024;
const CLOSE_WAIT_MS = 2000;
const HEADER_MAX = 16 * 1024;
const OP = { cont: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const satisfies Record<string, number>;

const acceptKey = (key: unknown): string => crypto.createHash('sha1').update(String(key) + GUID).digest('base64');
const utf8 = new TextDecoder('utf-8', { fatal: true });

class Conn extends EventEmitter<ConnEvents> {
  socket: WsSocket;
  client: boolean;
  maxPayload: number;
  state: ConnState;
  _buf: Buffer;
  _frags: { op: number; parts: Buffer[]; size: number } | null;
  _sentClose: boolean;
  _gotClose?: boolean;
  _closeCode: number;
  _closeReason: string;
  _heard: boolean;
  _pinger: NodeJS.Timeout | null;
  constructor(socket: WsSocket, { client, maxPayload = MAX_PAYLOAD, pingMs = 0, head = null }: ConnOptions) {
    super();
    this.socket = socket;
    this.client = client;
    this.maxPayload = maxPayload;
    this.state = 'open';
    this._buf = Buffer.alloc(0);
    this._frags = null; // {op, parts: [], size}
    this._sentClose = false;
    this._closeCode = 1006;
    this._closeReason = '';
    this._heard = true;
    this._pinger = null;
    socket.setNoDelay && socket.setNoDelay(true);
    socket.on('data', (d: Buffer) => this._data(d));
    socket.on('error', (e: Error) => { if (this.listenerCount('error')) this.emit('error', e); });
    socket.on('close', () => this._closed());
    socket.on('end', () => socket.end());
    if (pingMs > 0) {
      this._pinger = setInterval(() => {
        if (!this._heard) return this.terminate();
        this._heard = false;
        this.ping();
      }, pingMs);
      this._pinger.unref();
    }
    if (head && head.length) setImmediate(() => this._data(head));
  }

  _frame(op: number, payload: Buffer, fin = true): boolean {
    const len = payload.length;
    const mask = this.client;
    const hl = 2 + (len < 126 ? 0 : len < 65536 ? 2 : 8) + (mask ? 4 : 0);
    const h = Buffer.alloc(hl);
    h[0] = (fin ? 0x80 : 0) | op;
    let o = 2;
    if (len < 126) h[1] = len;
    else if (len < 65536) { h[1] = 126; h.writeUInt16BE(len, 2); o = 4; } else { h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); o = 10; }
    if (!mask) return this.socket.write(Buffer.concat([h, payload]));
    h[1] |= 0x80;
    const key = crypto.randomBytes(4);
    key.copy(h, o);
    const body = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) body[i] = (payload[i] ?? 0) ^ (key[i & 3] ?? 0); // i < len: both defined
    return this.socket.write(Buffer.concat([h, body]));
  }

  send(data: string | Buffer | Uint8Array): boolean {
    if (this.state !== 'open') return false;
    const text = typeof data === 'string';
    return this._frame(text ? OP.text : OP.binary, text ? Buffer.from(data, 'utf8') : Buffer.from(data));
  }

  ping(data: Buffer | string = Buffer.alloc(0)): void { if (this.state === 'open') this._frame(OP.ping, Buffer.from(data).subarray(0, 125)); }

  close(code = 1000, reason: unknown = ''): void {
    if (this.state === 'closed' || this._sentClose) return;
    this._sentClose = true;
    this.state = 'closing';
    const r = Buffer.from(String(reason)).subarray(0, 123);
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    try { this._frame(OP.close, p); } catch { /* the socket is gone */ }
    if (this._closeCode === 1006) { this._closeCode = code; this._closeReason = String(reason); }
    // a server ends the TCP connection first (RFC 6455 7.1.1); either side gives up after CLOSE_WAIT_MS
    if (!this.client && this._gotClose) this.socket.end();
    const t = setTimeout(() => this.socket.destroy(), CLOSE_WAIT_MS);
    t.unref();
  }

  terminate(): void {
    if (this.state === 'closed') return;
    this._closeCode = this._gotClose ? this._closeCode : 1006;
    this.socket.destroy();
  }

  _fail(code: number, why: string): void {
    if (this.listenerCount('error')) this.emit('error', Object.assign(new Error(why), { code: 'WS_PROTOCOL' as const, closeCode: code }) satisfies WsError);
    this._closeCode = code;
    this._closeReason = why;
    this.close(code, why);
    this.socket.end();
  }

  _closed(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    clearInterval(this._pinger ?? undefined);
    this.emit('close', this._closeCode, this._closeReason);
  }

  _data(d: Buffer): void {
    this._heard = true;
    this._buf = this._buf.length ? Buffer.concat([this._buf, d]) : d;
    while (this.state !== 'closed' && this._parse()) { /* one frame each */ }
  }

  /** One frame off the buffer: true when one was taken, false when more bytes are needed or the conn failed. */
  _parse(): boolean {
    const b = this._buf;
    if (b.length < 2) return false;
    const b0 = b[0] ?? 0, b1 = b[1] ?? 0; // b.length >= 2
    const fin = (b0 & 0x80) !== 0, rsv = b0 & 0x70, op = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f, o = 2;
    if (rsv) return this._fail(1002, 'reserved bits set (no extension was negotiated)'), false;
    if (masked === this.client) return this._fail(1002, this.client ? 'a server frame was masked' : 'a client frame was not masked'), false;
    if (len === 126) { if (b.length < 4) return false; len = b.readUInt16BE(2); o = 4; } else if (len === 127) {
      if (b.length < 10) return false;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(this.maxPayload)) return this._fail(1009, `a frame larger than ${this.maxPayload} bytes`), false;
      len = Number(big);
      o = 10;
    }
    if (len > this.maxPayload) return this._fail(1009, `a frame larger than ${this.maxPayload} bytes`), false;
    const control = op >= 8;
    if (control && (!fin || len > 125)) return this._fail(1002, 'a fragmented or oversized control frame'), false;
    const mo = o;
    if (masked) o += 4;
    if (b.length < o + len) return false;
    let payload = b.subarray(o, o + len);
    if (masked) {
      const key = b.subarray(mo, mo + 4);
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = (payload[i] ?? 0) ^ (key[i & 3] ?? 0); // i < len: both defined
      payload = out;
    } else payload = Buffer.from(payload);
    this._buf = b.subarray(o + len);
    if (control) return this._control(op, payload), true;
    if (op === OP.cont) {
      if (!this._frags) return this._fail(1002, 'a continuation frame with no message started'), false;
    } else if (op === OP.text || op === OP.binary) {
      if (this._frags) return this._fail(1002, 'a new message before the last one ended'), false;
      this._frags = { op, parts: [], size: 0 };
    } else return this._fail(1002, `unknown opcode ${op}`), false;
    const f = this._frags;
    f.size += len;
    if (f.size > this.maxPayload) return this._fail(1009, `a message larger than ${this.maxPayload} bytes`), false;
    f.parts.push(payload);
    if (!fin) return true;
    this._frags = null;
    const first = f.parts[0];
    const data = first && f.parts.length === 1 ? first : Buffer.concat(f.parts);
    if (f.op === OP.text) {
      try { utf8.decode(data); } catch { return this._fail(1007, 'a text message that is not UTF-8'), false; }
    }
    if (this.state === 'open') this.emit('message', data, f.op === OP.binary);
    return true;
  }

  _control(op: number, payload: Buffer): void {
    if (op === OP.ping) { if (this.state === 'open') this._frame(OP.pong, payload); this.emit('ping', payload); return; }
    if (op === OP.pong) { this.emit('pong', payload); return; }
    if (op === OP.close) {
      this._gotClose = true;
      let code = 1005, reason = '';
      if (payload.length === 1) return this._fail(1002, 'a close frame of one byte');
      if (payload.length >= 2) {
        code = payload.readUInt16BE(0);
        try { reason = utf8.decode(payload.subarray(2)); } catch { return this._fail(1007, 'a close reason that is not UTF-8'); }
      }
      if (this._closeCode === 1006 || !this._sentClose) { this._closeCode = code; this._closeReason = reason; }
      if (!this._sentClose) this.close(code === 1005 ? 1000 : code, '');
      if (!this.client) this.socket.end();
    }
  }
}

// ---------- the server end ----------
function refuse(socket: Duplex, status: number, text: string): null {
  try { socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] || 'Error'}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`); } catch { /* gone */ }
  return null;
}

function accept(req: http.IncomingMessage, socket: Duplex, head: Buffer, { maxPayload, pingMs }: AcceptOptions = {}): Conn | null {
  const hd = req.headers;
  if (req.method !== 'GET') return refuse(socket, 405, 'a WebSocket upgrade is a GET\n');
  if (String(hd.upgrade || '').toLowerCase() !== 'websocket' || !/(^|,)\s*upgrade\s*(,|$)/i.test(String(hd.connection || ''))) return refuse(socket, 426, 'upgrade required\n');
  if (String(hd['sec-websocket-version']) !== '13') return refuse(socket, 426, 'WebSocket version 13 only\n');
  const key = String(hd['sec-websocket-key'] || '');
  if (!/^[A-Za-z0-9+/]{22}==$/.test(key)) return refuse(socket, 400, 'bad Sec-WebSocket-Key\n');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
  return new Conn(socket, { client: false, maxPayload, pingMs, head });
}

function createServer({ host = '127.0.0.1', port, onConnection, accept: allow = () => true, maxPayload, pingMs }: ServerOptions): Promise<http.Server> {
  const srv = http.createServer((_req, res) => { res.writeHead(426, { 'content-type': 'text/plain', connection: 'close' }); res.end('upgrade required\n'); });
  srv.on('upgrade', (req, socket, head) => {
    socket.on('error', () => { /* a peer that went away */ });
    let ok: boolean | number;
    try { ok = allow(req); } catch { ok = 500; }
    if (ok !== true) { refuse(socket, typeof ok === 'number' ? ok : 404, 'not here\n'); return; }
    const conn = accept(req, socket, head, { maxPayload, pingMs });
    if (conn) onConnection(conn, req);
  });
  srv.on('clientError', (_e, socket) => socket.destroy());
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(port, host, () => { srv.off('error', reject); resolve(srv); });
  });
}

// ---------- the client end ----------
const LOOPBACK = (h: string): boolean => h === 'localhost' || /^127\./.test(h) || h === '::1' || h === '[::1]';

function proxyFor(url: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const u = new URL(url);
  const secure = u.protocol === 'wss:' || u.protocol === 'https:';
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = u.port || (secure ? '443' : '80');
  if (LOOPBACK(host)) return null;
  const no = String(env.NO_PROXY ?? env.no_proxy ?? '').split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  for (const n of no) {
    if (n === '*') return null;
    const [nh = '', np] = n.split(/:(?=\d+$)/); // split gives at least one part
    if (np && np !== port) continue;
    const d = nh.replace(/^\*?\./, '');
    if (host === d || host.endsWith(`.${d}`)) return null;
  }
  const p = secure
    ? env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy
    : env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
  return p ? String(p) : null;
}

const connectError = (msg: string): Error & { code: 'WS_CONNECT' } => Object.assign(new Error(msg), { code: 'WS_CONNECT' as const });

/** Read an HTTP response head off socket: {status, headers, rest}. */
function readHead(socket: Duplex, what: string): Promise<Head> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) { if (buf.length > HEADER_MAX) { done(); reject(connectError(`${what}: an answer head over ${HEADER_MAX} bytes`)); } return; }
      done();
      const [line = '', ...rest] = buf.subarray(0, i).toString('latin1').split('\r\n'); // split gives at least one part
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(line);
      if (!m) return reject(connectError(`${what}: not an HTTP answer`));
      const headers: Record<string, string> = {};
      for (const l of rest) { const k = l.indexOf(':'); if (k > 0) headers[l.slice(0, k).trim().toLowerCase()] = l.slice(k + 1).trim(); }
      resolve({ status: Number(m[1]), headers, rest: buf.subarray(i + 4), line });
    };
    const onEnd = () => { done(); reject(connectError(`${what}: the connection closed before an answer`)); };
    const onErr = (e: Error) => { done(); reject(connectError(`${what}: ${e.message}`)); };
    const done = () => { socket.off('data', onData); socket.off('end', onEnd); socket.off('close', onEnd); socket.off('error', onErr); };
    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('close', onEnd);
    socket.on('error', onErr);
  });
}

function tcp(host: string, port: number, secure: boolean, tlsOpts: tls.ConnectionOptions, what: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = secure ? tls.connect({ host, port, ...(net.isIP(host) ? {} : { servername: host }), ALPNProtocols: ['http/1.1'], ...tlsOpts }) : net.connect({ host, port });
    s.once(secure ? 'secureConnect' : 'connect', () => { s.off('error', no); resolve(s); });
    const no = (e: Error) => reject(connectError(`${what} ${host}:${port}: ${e.message}`));
    s.once('error', no);
  });
}

async function viaProxy(proxyUrl: string, host: string, port: number, tlsOpts: tls.ConnectionOptions): Promise<net.Socket> {
  const p = new URL(proxyUrl);
  if (p.protocol !== 'http:' && p.protocol !== 'https:') throw connectError(`proxy ${p.protocol} is not supported (an http:// CONNECT proxy)`);
  const s = await tcp(p.hostname.replace(/^\[|\]$/g, ''), Number(p.port || (p.protocol === 'https:' ? 443 : 80)), p.protocol === 'https:', tlsOpts, 'proxy');
  const auth = p.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}\r\n` : '';
  const target = `${net.isIPv6(host) ? `[${host}]` : host}:${port}`;
  s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
  const r = await readHead(s, `proxy ${p.host}`);
  if (r.status !== 200) { s.destroy(); throw connectError(`proxy ${p.host} refused CONNECT ${target}: ${r.line}`); }
  if (r.rest.length) s.unshift(r.rest);
  return s;
}

async function connect(url: string, { proxy, headers = {}, maxPayload, pingMs, timeoutMs = 15_000, tls: tlsOpts = {}, env = process.env }: ConnectOptions = {}): Promise<Conn> {
  const u = new URL(url);
  const secure = u.protocol === 'wss:' || u.protocol === 'https:';
  if (!secure && u.protocol !== 'ws:' && u.protocol !== 'http:') throw connectError(`not a WebSocket URL: ${u.protocol}`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = Number(u.port || (secure ? 443 : 80));
  const px = proxy === undefined ? proxyFor(url, env) : proxy;
  let sock = null as net.Socket | null, timer: NodeJS.Timeout | undefined; // (as: set inside work, read in catch)
  const work = (async () => {
    if (px) {
      const raw = await viaProxy(px, host, port, tlsOpts);
      sock = raw;
      if (secure) {
        sock = await new Promise<tls.TLSSocket>((resolve, reject) => {
          const t = tls.connect({ socket: raw, servername: net.isIP(host) ? undefined : host, ALPNProtocols: ['http/1.1'], ...tlsOpts });
          t.once('secureConnect', () => { t.off('error', no); resolve(t); });
          const no = (e: Error) => reject(connectError(`TLS to ${host} through the proxy: ${e.message}`));
          t.once('error', no);
        });
      }
    } else sock = await tcp(host, port, secure, tlsOpts, secure ? 'TLS to' : 'connect to');
    const key = crypto.randomBytes(16).toString('base64');
    const hostHeader = `${net.isIPv6(host) ? `[${host}]` : host}${u.port ? `:${u.port}` : ''}`;
    const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    sock.write(`GET ${u.pathname || '/'}${u.search} HTTP/1.1\r\nHost: ${hostHeader}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`);
    const r = await readHead(sock, `${u.protocol}//${hostHeader}`);
    if (r.status !== 101) throw connectError(`${u.protocol}//${hostHeader}${u.pathname} answered ${r.line.replace(/^HTTP\/1\.[01] /, '')} instead of a WebSocket upgrade`);
    if (r.headers['sec-websocket-accept'] !== acceptKey(key)) throw connectError('the upgrade answer has a wrong Sec-WebSocket-Accept');
    if (r.headers['sec-websocket-extensions']) throw connectError('the server chose an extension that was not offered');
    return new Conn(sock, { client: true, maxPayload, pingMs, head: r.rest });
  })();
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(connectError(`no WebSocket to ${u.host} within ${timeoutMs} ms`)), timeoutMs); });
  try {
    return await Promise.race([work, deadline]);
  } catch (e) {
    if (sock) sock.destroy();
    work.then(c => c.terminate(), () => {});
    throw e;
  } finally { clearTimeout(timer); }
}

export { Conn, accept, createServer, connect, proxyFor, acceptKey, MAX_PAYLOAD };
