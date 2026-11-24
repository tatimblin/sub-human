// A stand-in for tailscaled (TESTING §6): TLS on 127.0.0.1 with a throwaway certificate for localhost (made by openssl
// in the test's temp home, since node:crypto can't make one), each connection forwarded to the host's listener behind a
// PROXY v2 header naming `source`, as `tailscale funnel --tls-terminated-tcp --proxy-protocol=2` does.
import fs from 'node:fs/promises';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { TestContext } from 'node:test';
import { SIGNATURE } from '../../net/proxy-v2.js';

/** A PROXY v2 header for a TCP4 (dotted) or TCP6 (eight words) source. */
export function proxyHeader(source: string, port = 50000): Buffer {
  const v6 = source.includes(':');
  const addr = v6
    ? Buffer.concat(source.split(':').map(w => { const b = Buffer.alloc(2); b.writeUInt16BE(parseInt(w || '0', 16)); return b; }))
    : Buffer.from(source.split('.').map(Number));
  const ports = Buffer.alloc(4);
  ports.writeUInt16BE(port, 0);
  ports.writeUInt16BE(443, 2);
  const body = Buffer.concat([addr, Buffer.alloc(addr.length), ports]);
  const head = Buffer.from([0x21, v6 ? 0x21 : 0x11, 0, 0]);
  head.writeUInt16BE(body.length, 2);
  return Buffer.concat([SIGNATURE, head, body]);
}

export interface Front {
  origin: string;
  readonly ca: string;
  /** The PROXY source the next connection is given. */
  source: string;
  /** Bytes forwarded to the listener so far. */
  forwarded: number;
  close(): Promise<void>;
}

let made: Promise<{ key: string; cert: string }> | null = null;
function cert(): Promise<{ key: string; cert: string }> {
  made ??= (async () => {
    const dir = await fs.mkdtemp(path.join(process.env.SUB_HUMAN_HOME ?? '', 'tls-'));
    const [key, crt] = [path.join(dir, 'key.pem'), path.join(dir, 'cert.pem')];
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', key, '-out', crt], { stdio: 'ignore' });
    return { key: await fs.readFile(key, 'utf8'), cert: await fs.readFile(crt, 'utf8') };
  })();
  return made;
}

export async function front(t: TestContext, listenerPort: () => number): Promise<Front> {
  const { key, cert: crt } = await cert();
  const socks = new Set<net.Socket>();
  const f: Front = {
    origin: '', ca: crt, source: '203.0.113.7', forwarded: 0,
    close: () => new Promise(res => { for (const s of socks) s.destroy(); server.close(() => { res(); }); }),
  };
  const server = tls.createServer({ key, cert: crt }, client => {
    const up = net.connect(listenerPort(), '127.0.0.1');
    socks.add(client).add(up);
    up.write(proxyHeader(f.source));
    client.on('data', (b: Buffer) => { f.forwarded += b.length; if (!up.write(b)) { client.pause(); up.once('drain', () => client.resume()); } });
    up.pipe(client);
    const end = (): void => { client.destroy(); up.destroy(); };
    client.on('close', end).on('error', end);
    up.on('close', end).on('error', end);
  });
  await new Promise<void>(res => { server.listen(0, '127.0.0.1', () => { res(); }); });
  const a = server.address();
  f.origin = `https://localhost:${a !== null && typeof a === 'object' ? a.port : 0}`;
  t.after(() => f.close());
  return f;
}
