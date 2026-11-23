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

test('a join over Funnel: an https line, a WebSocket through the front, the joiner\'s address as its source', async t => {
  const { h, f } = await funnel(t);
  const { line } = await joinBob(h, 'public');
  assert.match(line, new RegExp(`^${f.origin}/${CODE}#`));
  assert.ok(f.forwarded > 0);
  const placed = await h.joiner.ok({ op: 'append', code: CODE, draft: { kind: 'joined', id: crypto.randomUUID(), from: 'bob', by: 'system' } });
  assert.ok(placed.seq > 0);
});

test('the joiner\'s dialer goes through HTTPS_PROXY', async t => {
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
  await joinBob(h, 'public');
  assert.ok(seen.length >= 2 && seen.every(u => u === f.origin.replace('https://', '')), seen.join(','));
  assert.ok(auth.every(x => x === `Basic ${Buffer.from('jess:p@ss').toString('base64')}`), 'the proxy URL\'s user and password');
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

test('an upgrade with no PROXY header did not come through the forward, and is refused; with one it is answered', async t => {
  const { h, port } = await funnel(t);
  await hostRoom(h);
  await h.host.ok({ op: 'invite', code: CODE, from: 'alice', name: 'bob', via: 'public' });
  assert.equal(await raw(port(), UPGRADE), '', 'closed with nothing said');
  assert.match(await raw(port(), Buffer.concat([proxyHeader('203.0.113.9'), Buffer.from(UPGRADE)])), /^HTTP\/1\.1 101 /);
  assert.equal(await raw(port(), Buffer.concat([proxyHeader('127.0.0.1'), Buffer.from(UPGRADE)])), '', 'a loopback source is a local peer, refused');
});

test('half-open upgrades count against their source from the PROXY header on', async t => {
  const { h, port } = await funnel(t);
  await hostRoom(h);
  await h.host.ok({ op: 'invite', code: CODE, from: 'alice', name: 'bob', via: 'public' });
  const open = new Set<number>();
  for (let i = 0; i < 40; i++) {
    const s = net.connect(port(), '127.0.0.1', () => { s.write(Buffer.concat([proxyHeader('198.51.100.9'), Buffer.from('GET / HTTP/1.1\r\n')])); });
    open.add(i);
    s.on('close', () => { open.delete(i); }).on('error', () => undefined);
    t.after(() => { s.destroy(); });
  }
  await until('all but eight cut', () => Promise.resolve(open.size <= 8 || null));
  await sleep(200);
  assert.equal(open.size, 8);
});

test('the listener holds at most 56 connections from public sources, keeping 8 for local (ssh -W) ones', async t => {
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
  // 8 sources of 8 each, half-open: the last source's are over the public total
  for (let src = 1; src <= 8; src++) for (let i = 0; i < 8; i++) hold(`p${src}.${i}`, Buffer.concat([proxyHeader(`198.51.100.${src}`), Buffer.from('GET / HTTP/1.1\r\n')]));
  await until('the public total held', () => Promise.resolve(open.size <= 56 || null));
  await sleep(200);
  assert.equal(open.size, 56);
  // a local (ssh -W) connection still gets in: its first Noise frame, then silence
  for (let i = 0; i < 8; i++) hold(`l${i}`, Buffer.from([0, 48]));
  await sleep(300);
  assert.equal([...open].filter(id => id.startsWith('l')).length, 8);
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

test('each PROXY source has its own connection cap', async t => {
  const { h, f } = await funnel(t);
  await hostRoom(h);
  const { line } = await h.host.ok({ op: 'invite', code: CODE, from: 'alice', name: 'bob', via: 'public' });
  const closed = new Set<number>();
  const open = async (source: string, i: number): Promise<void> => {
    f.source = source;
    const d = await dialWs(f.origin, CODE, {}, f.ca);
    d.on('close', () => { closed.add(i); }).on('error', () => undefined).resume();
  };
  for (let i = 0; i < 8; i++) await open('198.51.100.1', i);
  await assert.rejects(open('198.51.100.1', 8), 'the ninth from one source is cut before its upgrade');
  await open('198.51.100.2', 9);
  await sleep(100);
  assert.deepEqual([...closed], [], 'the others, and another source, stay open');
  assert.ok(line);
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
