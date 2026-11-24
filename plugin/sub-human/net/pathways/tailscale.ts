// The Tailscale pathway (R29a): the host publishes its loopback listener with `tailscale funnel` (public) or `tailscale
// serve` (tailnet only), TLS ended in tailscaled and each connection prefixed with a PROXY v2 header; the wire is a
// WebSocket over HTTPS, which proxies let through, and the joiner's dialer honours HTTPS_PROXY. Only the host runs
// Tailscale. It drives the person's own `tailscale` CLI (a LocalAPI client is a later spike, ARCHITECTURE §2a); each
// call has a timeout and none waits on an admin.
//
// Funnel takes ports 443, 8443 and 10000 only, a TCP forward can't share a port that serves anything else, and Serve and
// Funnel collide on one port: so a forward takes the first of those ports nothing else holds, keeps one of ours already
// there, and is turned off by its own port alone, leaving every other forward as it was.
import fs from 'node:fs';
import http from 'node:http';
import tls from 'node:tls';
import path from 'node:path';
import type net from 'node:net';
import { spawn } from 'node:child_process';
import type { Duplex } from 'node:stream';
import * as v from '../../vendor/valibot.mjs';
import { WebSocket, WebSocketServer, createWebSocketStream } from '../../vendor/ws/index.mjs';
import type { Result } from '../../core/result.js';
import { err, ok } from '../../core/result.js';
import { parseJson } from '../../core/schema.js';
import type { Forward } from '../host.js';
import { MAX_FRAME } from '../channel.js';

export const MAC_APP: string = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
export const PORTS: readonly number[] = [443, 8443, 10000];
const CALL_MS = 10_000;
/** One WebSocket message is one Noise frame with its length (channel.ts writes no more at once), so a peer not yet let
 *  in can make the host hold at most a frame per connection. */
const WS_MAX = MAX_FRAME + 2;
const CONNECT_MS = 10_000;
const ENABLE = /https:\/\/\S+\/f\/(?:serve|funnel|https)\S*/i;
type Env = Readonly<Record<string, string | undefined>>;

/** `tailscale` on PATH, else the macOS app's, else null. */
export function findTailscale(env: Env, macApp: string = MAC_APP): string | null {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const f of [...dirs.map(d => path.join(d, 'tailscale')), macApp]) {
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* the next */ }
  }
  return null;
}

/** The CLI's exit code (null when it was stopped: timed out, or it printed an enable URL) and what it printed. */
function run(bin: string, args: readonly string[], env: Env): Promise<{ code: number | null; out: string }> {
  return new Promise(resolve => {
    const c = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const stop = (): void => { c.kill('SIGKILL'); resolve({ code: null, out }); };
    const t = setTimeout(stop, CALL_MS);
    const read = (b: Buffer): void => { out += b.toString(); if (ENABLE.test(out)) { clearTimeout(t); stop(); } };
    c.stdout.on('data', read);
    c.stderr.on('data', read);
    c.on('error', e => { clearTimeout(t); resolve({ code: -1, out: e.message }); });
    c.on('close', code => { clearTimeout(t); resolve({ code, out }); });
  });
}

const selfSchema = v.object({ BackendState: v.optional(v.string()), Self: v.optional(v.object({ DNSName: v.string() })) });
const serveSchema = v.object({
  TCP: v.optional(v.record(v.string(), v.object({ TCPForward: v.optional(v.string()), ProxyProtocol: v.optional(v.number()) }))),
  AllowFunnel: v.optional(v.record(v.string(), v.boolean())),
});

/** Publishes 127.0.0.1:`port` by Funnel (public) or Serve (tailnet), or says in one line why it didn't. */
export async function expose(mode: 'public' | 'tailnet', port: number, env: Env = process.env, macApp: string = MAC_APP): Promise<Result<Forward>> {
  const what = mode === 'public' ? 'funnel' : 'serve';
  const bin = findTailscale(env, macApp);
  if (!bin) return err('Tailscale isn\'t installed here; no invite was made. Install it, or invite with --ssh');
  const st = parseJson(selfSchema, (await run(bin, ['status', '--json'], env)).out);
  const dns = st.ok ? st.value.Self?.DNSName.replace(/\.$/, '').toLowerCase() : undefined;
  if (!dns || (st.ok && st.value.BackendState !== 'Running')) {
    return err('Tailscale isn\'t running or logged in here; no invite was made. Start it and log in, then invite again');
  }
  const cfg = parseJson(serveSchema, (await run(bin, ['serve', 'status', '--json'], env)).out);
  const tcp = cfg.ok ? cfg.value.TCP ?? {} : {};
  const funnel = cfg.ok ? cfg.value.AllowFunnel ?? {} : {};
  const ours = (p: number): boolean => tcp[p]?.TCPForward === `127.0.0.1:${port}` && (funnel[`${dns}:${p}`] === true) === (mode === 'public');
  const origin = (p: number): string => `https://${dns}${p === 443 ? '' : `:${p}`}`;
  const off = (p: number) => async (): Promise<void> => { await run(bin, [what, `--tls-terminated-tcp=${p}`, 'off'], env); };
  const mine = PORTS.find(ours);
  if (mine !== undefined && tcp[mine]?.ProxyProtocol !== 2) {
    return err(`Tailscale already forwards port ${mine} here without the PROXY header; no invite was made. Run tailscale ${what} --tls-terminated-tcp=${mine} off, then invite again`);
  }
  if (mine !== undefined) return ok({ origin: origin(mine), off: off(mine) });
  const free = PORTS.find(p => !tcp[p]);
  if (free === undefined) return err(`Tailscale's ports ${PORTS.join(', ')} all serve something else here; no invite was made. Free one, or invite with --ssh`);
  const r = await run(bin, [what, '--bg', `--tls-terminated-tcp=${free}`, '--proxy-protocol=2', `tcp://127.0.0.1:${port}`], env);
  const url = ENABLE.exec(r.out)?.[0];
  if (url) return err(`Tailscale ${mode === 'public' ? 'Funnel' : 'Serve'} isn't on for this tailnet; no invite was made. An admin turns it on at ${url}, then invite again`);
  if (r.code !== 0) return err(`tailscale ${what} did not start (${r.out.trim().split('\n')[0] ?? `exit ${r.code}`}); no invite was made`);
  return ok({ origin: origin(free), off: off(free) });
}

/** The joiner's side: a WebSocket to the line's origin, through HTTPS_PROXY when it is set. `ca` is for tests. */
export async function dialWs(origin: string, code: string, env: Env = process.env, ca?: string): Promise<Duplex> {
  const url = new URL(`${origin}/${code}`);
  const proxy = env.HTTPS_PROXY ?? env.https_proxy;
  const host = url.hostname, port = Number(url.port || 443);
  const socket = proxy && !noProxy(host, env) ? await tunnel(new URL(proxy), host, port) : null;
  const ws = new WebSocket(url.href.replace(/^https:/, 'wss:'), {
    perMessageDeflate: false, maxPayload: WS_MAX, handshakeTimeout: 10_000,
    ...(ca === undefined ? {} : { ca }),
    ...(socket ? { createConnection: () => tls.connect({ socket, servername: host, ...(ca === undefined ? {} : { ca }) }) } : {}),
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => { resolve(wsStream(ws)); });
    ws.once('error', e => { reject(new Error(`could not reach ${url.host}: ${e.message}`)); });
  });
}

function noProxy(host: string, env: Env): boolean {
  const list = (env.NO_PROXY ?? env.no_proxy ?? '').split(',').map(s => s.trim().replace(/^\./, '')).filter(Boolean);
  return list.some(d => d === '*' || host === d || host.endsWith(`.${d}`));
}

/** An HTTP CONNECT tunnel through the proxy to host:port, with the proxy URL's user and password as Basic auth. */
function tunnel(proxy: URL, host: string, port: number): Promise<net.Socket> {
  const user = decodeURIComponent(proxy.username), pass = decodeURIComponent(proxy.password);
  const auth = user || pass ? { 'proxy-authorization': `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` } : {};
  return new Promise((resolve, reject) => {
    const q = http.request({
      host: proxy.hostname, port: Number(proxy.port || 80), method: 'CONNECT', path: `${host}:${port}`, timeout: CONNECT_MS,
      headers: { host: `${host}:${port}`, ...auth },
    });
    q.once('timeout', () => { q.destroy(new Error(`no answer within ${CONNECT_MS / 1000} s`)); });
    q.once('connect', (res, sock) => {
      if (res.statusCode === 200) resolve(sock);
      else { sock.destroy(); reject(new Error(`the proxy refused the connection (${res.statusCode})`)); }
    });
    q.once('error', e => { reject(new Error(`could not reach the proxy: ${e.message}`)); });
    q.end();
  });
}

/** ws's stream, closed once the other side has closed (it would only end), as a socket's is: channel.ts waits for close. */
function wsStream(ws: WebSocket): Duplex {
  const d = createWebSocketStream(ws);
  d.once('end', () => { d.destroy(); });
  return d;
}

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: WS_MAX });

/**
 * The host's side, after the PROXY header: `sock` carries the HTTP upgrade (its first bytes in `head`). The WebSocket
 * as a Duplex whose pause stops reading the socket (net/channel.ts relies on it), or null for anything else.
 */
export function acceptWs(sock: net.Socket, head: Buffer): Promise<Duplex | null> {
  return new Promise(resolve => {
    const t = setTimeout(() => { done(null); }, 10_000);
    const done = (d: Duplex | null): void => { clearTimeout(t); waiting.delete(sock); if (!d) sock.destroy(); resolve(d); };
    waiting.set(sock, done);
    sock.unshift(head);
    front.emit('connection', sock);
  });
}

/** One HTTP server for every connection the listener hands over, each answered through `waiting`. */
const waiting = new Map<unknown, (d: Duplex | null) => void>();
const front = http.createServer((q, s) => { s.writeHead(426).end(); waiting.get(q.socket)?.(null); });
front.on('upgrade', (q: http.IncomingMessage, s: Duplex, h: Buffer) => {
  const done = waiting.get(s);
  if (done) wss.handleUpgrade(q, s, h, ws => { done(wsStream(ws)); });
  else s.destroy();
});
