// The Funnel wire with a local TLS + WebSocket front standing in for tailscaled (TESTING §6, R29a): a join over it,
// HTTPS_PROXY, no PROXY header refused, the per-source cap, and the host holding a flood behind message 3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Duplex } from 'node:stream';
import { WebSocket } from '../../vendor/ws/index.mjs';
import { ok } from '../../core/result.js';
import { MAX_FRAME, connect, generateKeyPair } from '../../net/channel.js';
import { mac, parse } from '../../net/invite.js';
import { dialWs } from '../../net/pathways/tailscale.js';
import { CODE, hostRoom, joinBob, nextAsk, twoHomes } from '../support/two-homes.js';
import type { Homes } from '../support/two-homes.js';
import { front, proxyHeader } from '../support/front.js';
import type { Front } from '../support/front.js';
import { until } from '../support/daemon.js';

async function funnel(t: Parameters<typeof twoHomes>[0], env: Record<string, string> = {}): Promise<{ h: Homes; f: Front; port: () => number }> {
  let port = 0;
  const f = await front(t, () => port);
  const h = await twoHomes(t, {
    hostOpts: { expose: (_mode, p) => { port = p; return Promise.resolve(ok({ origin: f.origin, off: () => Promise.resolve() })); } },
    joinOpts: { dial: (via, code) => (via.kind === 'https' ? dialWs(via.origin, code, env, f.ca) : Promise.reject(new Error('https only'))) },
  });
  return { h, f, port: () => port };
}

test('a join over Funnel: an https line, a WebSocket through the front and the joiner\'s HTTPS_PROXY, its address as the source (R29, R29a)', async t => {
  const seen: string[] = [], auth: string[] = [];
  const proxy = http.createServer();
  proxy.on('connect', (q: http.IncomingMessage, sock: Duplex) => {
    seen.push(q.url ?? '');
    auth.push(q.headers['proxy-authorization'] ?? '');
    const [host = '', port = '0'] = (q.url ?? '').split(':');
    const up = net.connect(Number(port), host === 'localhost' ? '127.0.0.1' : host, () => { sock.write('HTTP/1.1 200 OK\r\n\r\n'); up.pipe(sock); sock.pipe(up); });
    up.on('error', () => { sock.destroy(); });
    sock.on('error', () => { up.destroy(); });
  });
  await new Promise<void>(res => { proxy.listen(0, '127.0.0.1', () => { res(); }); });
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });
  const a = proxy.address();
  const { h, f } = await funnel(t, { HTTPS_PROXY: `http://jess:p%40ss@127.0.0.1:${a !== null && typeof a === 'object' ? a.port : 0}` });
  const { line } = await joinBob(h, 'public');
  assert.match(line, new RegExp(`^${f.origin}/${CODE}#`));
  assert.ok(f.forwarded > 0);
  assert.ok(seen.length >= 2 && seen.every(u => u === f.origin.replace('https://', '')), seen.join(','));
  assert.ok(auth.every(x => x === `Basic ${Buffer.from('jess:p@ss').toString('base64')}`), 'the proxy URL\'s user and password');
  const placed = await h.joiner.ok({ op: 'append', code: CODE, draft: { kind: 'joined', id: crypto.randomUUID(), from: 'bob', by: 'system' } });
  assert.ok(placed.seq > 0);
});

const UPGRADE = `GET /${CODE} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`;

/** What the listener answers a raw connection that sends `bytes`: its first bytes, or '' once it closes. */
function raw(port: number, bytes: Buffer | string): Promise<string> {
  return new Promise(res => {
    const s = net.connect(port, '127.0.0.1', () => { s.write(bytes); });
    let got = '';
    s.on('data', (b: Buffer) => { got += b.toString('latin1'); if (got.includes('\r\n\r\n')) { s.destroy(); res(got); } });
    s.on('close', () => { res(got); }).on('error', () => undefined);
  });
}

test('an upgrade with no PROXY header did not come through the forward, and is refused; with one it is answered (R29a)', async t => {
  const { h, port } = await funnel(t);
  await hostRoom(h);
  await h.host.ok({ op: 'invite', code: CODE, from: 'alice', name: 'bob', via: 'public' });
  assert.equal(await raw(port(), UPGRADE), '', 'closed with nothing said');
  assert.match(await raw(port(), Buffer.concat([proxyHeader('203.0.113.9'), Buffer.from(UPGRADE)])), /^HTTP\/1\.1 101 /);
  assert.equal(await raw(port(), Buffer.concat([proxyHeader('127.0.0.1'), Buffer.from(UPGRADE)])), '', 'a loopback source is a local peer, refused');
});

// the caps' numbers are core/host-rules.ts's (SOURCE_MAX 8, TOTAL_MAX 64, LOCAL_RESERVE 8); this is the listener holding them
test('half-open upgrades count against their source from the PROXY header on: 8 a source (an IPv6 one its /64), 56 public in all, ssh -W its own cap and the last 8 (R29a, R40)', async t => {
  const { h, port } = await funnel(t);
  await hostRoom(h);
  await h.host.ok({ op: 'invite', code: CODE, from: 'alice', name: 'bob', via: 'public' });
  const open = new Set<string>();
  const hold = (id: string, bytes: Buffer): void => {
    const s = net.connect(port(), '127.0.0.1', () => { s.write(bytes); });
    open.add(id);
    s.on('close', () => { open.delete(id); }).on('error', () => undefined);
    t.after(() => { s.destroy(); });
  };
  const from = (ip: string) => Buffer.concat([proxyHeader(ip), Buffer.from('GET / HTTP/1.1\r\n')]);
  const local = Buffer.from([0, 48]); // an ssh -W connection: its first Noise frame, then silence
  const count = (prefix: string) => [...open].filter(id => id.startsWith(prefix)).length;
  // one /64, a new address for each connection
  for (let i = 0; i < 40; i++) hold(`v6.${i}`, from(`2001:db8:1:2:0:0:0:${(i + 1).toString(16)}`));
  await until('the /64 at its cap', () => Promise.resolve(count('v6.') <= 8 || null));
  // more local connections than one public source may hold
  for (let i = 0; i < 12; i++) hold(`l.${i}`, local);
  for (let i = 0; i < 9; i++) hold(`a.${i}`, from('198.51.100.1')); // an IPv4 source, one over its cap
  await until('the IPv4 source at its cap', () => Promise.resolve(count('a.') <= 8 || null));
  await sleep(300);
  assert.deepEqual([count('v6.'), count('l.'), count('a.')], [8, 12, 8]);
  // more sources than the public total: 28 more fit beside the 28 open
  for (let src = 2; src <= 6; src++) for (let i = 0; i < 8; i++) hold(`b${src}.${i}`, from(`198.51.100.${src}`));
  await until('the public total held', () => Promise.resolve(open.size <= 56 || null));
  await sleep(200);
  assert.equal(open.size, 56);
  for (let i = 0; i < 8; i++) hold(`r.${i}`, local); // the last 8 are local's alone
  await sleep(300);
  assert.equal(count('r.'), 8);
});

test('a WebSocket message larger than one Noise frame is refused before the handshake', async t => {
  const { h, f } = await funnel(t);
  await hostRoom(h);
  await h.host.ok({ op: 'invite', code: CODE, from: 'alice', name: 'bob', via: 'public' });
  const ws = new WebSocket(`${f.origin.replace('https', 'wss')}/${CODE}`, { ca: f.ca });
  await new Promise(res => { ws.once('open', res); });
  const code = new Promise<number>(res => { ws.once('close', c => { res(c); }); });
  ws.send(Buffer.alloc(MAX_FRAME + 3));
  assert.equal(await code, 1009, 'message too big');
});

test('the host reads nothing past message 3 until it answers: a flood waits in the transport', async t => {
  // the host's own sockets, to count what it read (the kernel's buffers between the front and it are not the host's)
  const mine: net.Socket[] = [];
  const create = net.createServer.bind(net);
  t.mock.method(net, 'createServer', (fn: (s: net.Socket) => void) => create(s => { mine.push(s); fn(s); }));
  const { h, f } = await funnel(t);
  await hostRoom(h);
  const { line } = await h.host.ok({ op: 'invite', code: CODE, from: 'alice', name: 'bob', via: 'public' });
  const inv = parse(line);
  assert.ok(inv.ok);
  const me = generateKeyPair();
  const stream = await dialWs(f.origin, CODE, {}, f.ca);
  const pay = Buffer.from(JSON.stringify({ code: CODE, name: 'bob', machine: 'mB', mac: mac(inv.value, me.pub).toString('base64url') }));
  await connect(stream, { s: me, rs: inv.value.hostKey, payload: pay });
  await nextAsk(h); // the card is up, unanswered
  const read = (): number => mine.reduce((n, s) => n + s.bytesRead, 0);
  const before = read();
  const chunk = Buffer.alloc(MAX_FRAME + 2, 7); // one largest message each
  for (let i = 0; i < 512; i++) stream.write(chunk); // 32 MiB behind message 3
  await sleep(1500);
  const through = read() - before;
  assert.ok(f.forwarded - before > 0 && through < 256 * 1024, `the host read ${through} bytes`);
  stream.destroy();
});
