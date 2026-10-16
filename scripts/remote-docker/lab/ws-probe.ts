/**
 * scripts/remote-docker/lab/ws-probe.ts: proves the 1.1 path through tls-front before the plugin's ws listener
 * exists, and checks it once it does.
 *
 *   node ws-probe.ts serve PORT [SECONDS]
 *       A stand-in listener on 127.0.0.1:PORT (run in the devbox, where the host's listener will be): answers an HTTP
 *       Upgrade: websocket with 101 and then echoes raw bytes; any other request is 426. Exits after SECONDS (30).
 *   node ws-probe.ts connect URL [PROXY_URL]
 *       Through PROXY_URL (an HTTP CONNECT proxy, e.g. http://corp-proxy:3128) when given, TLS to URL's host with the
 *       CAs in NODE_EXTRA_CA_CERTS, then GET URL with Upgrade: websocket. Prints one JSON line: {ok, status,
 *       upgraded, echo, ms, error?}. Exit 0 when the request got any HTTP answer (ok: the TLS + proxy path works).
 */
import http from 'node:http';
import tls from 'node:tls';
import type net from 'node:net';
import crypto from 'node:crypto';

/** The one JSON line connect prints. */
interface Probe { ok: boolean, status?: number, upgraded?: boolean, echo?: boolean, authorized?: boolean, error?: string }

const [mode, a, b] = process.argv.slice(2);

if (mode === 'serve') {
  const srv = http.createServer((_req, res) => { res.writeHead(426, { 'content-type': 'text/plain' }); res.end('upgrade required\n'); });
  srv.on('upgrade', (req: http.IncomingMessage, sock: net.Socket) => {
    const accept = crypto.createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sock.on('data', (d: Buffer) => sock.write(d));
    sock.on('error', () => {});
  });
  srv.listen(Number(a), '127.0.0.1', () => process.stderr.write(`ws-probe listening 127.0.0.1:${a}\n`));
  setTimeout(() => process.exit(0), Number(b || 30) * 1000);
} else if (mode === 'connect') {
  if (a === undefined) throw new Error('usage: node ws-probe.ts connect URL [PROXY_URL]');
  const url = new URL(a);
  const port = Number(url.port || 443);
  const t0 = Date.now();
  const done = (r: Probe): void => { process.stdout.write(JSON.stringify({ ...r, ms: Date.now() - t0 }) + '\n'); process.exit(r.status ? 0 : 1); };
  const viaProxy = (): Promise<net.Socket | null> => new Promise((resolve, reject) => {
    if (!b) { resolve(null); return; }
    const p = new URL(b);
    const req = http.request({ host: p.hostname, port: Number(p.port || 80), method: 'CONNECT', path: `${url.hostname}:${port}` });
    req.on('connect', (res, sock) => (res.statusCode === 200 ? resolve(sock) : reject(new Error(`proxy CONNECT ${res.statusCode}`))));
    req.on('error', reject);
    req.end();
  });
  viaProxy().then(sock => {
    const t = tls.connect({ socket: sock || undefined, host: sock ? undefined : url.hostname, port: sock ? undefined : port, servername: url.hostname });
    t.on('error', (e: Error) => done({ ok: false, error: e.message }));
    t.on('secureConnect', () => {
      const key = crypto.randomBytes(16).toString('base64');
      t.write(`GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      let buf = '', upgraded = false;
      const probe = 'lab-echo-' + crypto.randomBytes(4).toString('hex');
      t.on('data', (d: Buffer) => {
        buf += String(d);
        if (!upgraded) {
          const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
          if (!m || !buf.includes('\r\n\r\n')) return;
          if (m[1] !== '101') { done({ ok: true, status: Number(m[1]), upgraded: false, authorized: t.authorized }); return; }
          upgraded = true;
          buf = buf.slice(buf.indexOf('\r\n\r\n') + 4);
          t.write(probe);
        }
        if (buf.includes(probe)) done({ ok: true, status: 101, upgraded: true, echo: true, authorized: t.authorized });
      });
      setTimeout(() => done({ ok: upgraded, status: upgraded ? 101 : 0, upgraded, echo: false, error: 'timeout' }), 8000);
    });
  }, (e: Error) => done({ ok: false, error: e.message }));
} else {
  console.error('usage: ws-probe.ts serve PORT [SECONDS] | connect URL [PROXY_URL]');
  process.exit(2);
}
