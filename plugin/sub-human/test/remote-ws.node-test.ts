// lib/remote/ws.ts: the zero-dependency WebSocket. Its server end against Node's built-in WebSocket client (interop),
// its client end against its own server and against hand-made frames (fragmentation, control frames in between,
// masking rules, the size limit, bad UTF-8), through an HTTP CONNECT proxy, over TLS, and the proxy environment.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import tls from 'node:tls';
import type { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import * as h from './helpers.ts';
import * as ws from '../lib/remote/ws.ts';
import { isAlive } from '../lib/io.ts';
import { rc, sn, mid } from './support/brands.ts';
import { must } from './support/must.ts';

/** The next `ev` from an emitter: its listener's arguments (A: what that event carries). */
const once = <A extends unknown[] = unknown[]>(em: EventEmitter, ev: string) => new Promise<A>(r => em.once(ev, (...a: unknown[]) => r(a as A)));
/** A listening server's port. */
const portOf = (srv: { address(): string | AddressInfo | null }) => (srv.address() as AddressInfo).port;
type Msg = [data: Buffer, binary: boolean];
type Closed = [code: number, reason: string];

async function echoServer(t: TestContext, opts: Partial<Parameters<typeof ws.createServer>[0]> = {}) {
  const srv = await ws.createServer({
    port: 0,
    ...opts,
    onConnection(c, req) {
      c.on('message', (d, bin) => (d.toString() === 'bye' ? c.close(4000, 'asked') : c.send(bin ? d : `${req.url}:${d}`)));
    },
  });
  t.after(() => srv.close());
  return { srv, port: portOf(srv) };
}

test('ws server: interop with Node\'s built-in WebSocket client (text, binary, close code)', async t => {
  const { port } = await echoServer(t);
  const c = new WebSocket(`ws://127.0.0.1:${port}/sub-human/otter-1234`);
  c.binaryType = 'arraybuffer';
  await new Promise((ok, no) => { c.onopen = ok; c.onerror = no; });
  const got: (string | ArrayBuffer)[] = [];
  c.onmessage = e => got.push(e.data as string | ArrayBuffer);
  c.send('hello');
  const big = crypto.randomBytes(70_000);
  c.send(big);
  for (let i = 0; i < 100 && got.length < 2; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(got[0], '/sub-human/otter-1234:hello');
  assert.ok(Buffer.from(got[1] as ArrayBuffer).equals(big), 'a 70 kB binary message (64-bit length) echoes intact');
  const closed = new Promise<CloseEvent>(r => { c.onclose = e => r(e); });
  c.send('bye');
  const e = await closed;
  assert.equal(e.code, 4000);
  assert.equal(e.reason, 'asked');
});

test('ws server: Node\'s client closing with a code reaches the server', async t => {
  let closed: (v: Closed) => void;
  const done = new Promise<Closed>(r => { closed = r; });
  const srv = await ws.createServer({ port: 0, onConnection: c => c.on('close', (code, reason) => closed([code, reason])) });
  t.after(() => srv.close());
  const c = new WebSocket(`ws://127.0.0.1:${portOf(srv)}/x`);
  await new Promise(r => { c.onopen = r; });
  c.close(4100, 'done here');
  assert.deepEqual(await done, [4100, 'done here']);
});

test('ws client <-> ws server: text, binary, ping/pong, close handshake', async t => {
  const { port } = await echoServer(t);
  const c = await ws.connect(`ws://127.0.0.1:${port}/a`);
  const m = once<Msg>(c, 'message');
  c.send('x');
  const [d, bin] = await m;
  assert.equal(d.toString(), '/a:x');
  assert.equal(bin, false);
  const pong = once<[Buffer]>(c, 'pong');
  c.ping(Buffer.from('p1'));
  assert.equal((await pong)[0].toString(), 'p1');
  const b = once<Msg>(c, 'message');
  c.send(Buffer.from([0, 1, 2, 255]));
  assert.deepEqual([...(await b)[0]], [0, 1, 2, 255]);
  const cl = once<Closed>(c, 'close');
  c.send('bye');
  assert.deepEqual(await cl, [4000, 'asked']);
});

test('ws server: an upgrade the accept hook refuses is answered before any 101; a plain GET is 426', async t => {
  const { port } = await echoServer(t, { accept: req => (must(req.url).startsWith('/ok') ? true : 404) });
  await assert.rejects(ws.connect(`ws://127.0.0.1:${port}/nope`), /404/);
  const r = await fetch(`http://127.0.0.1:${port}/ok`);
  assert.equal(r.status, 426);
  const c = await ws.connect(`ws://127.0.0.1:${port}/ok`);
  c.terminate();
});

/** A raw server: answer the upgrade, then write bytes we choose; collects what the client sends. */
async function rawServer(t: TestContext, onSock: (sock: net.Socket) => void) {
  const srv = net.createServer(sock => {
    let buf = '';
    const onData = (d: Buffer) => {
      buf += d.toString('latin1');
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      sock.off('data', onData);
      const key = must(/sec-websocket-key: (\S+)/i.exec(buf))[1];
      sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${ws.acceptKey(key)}\r\n\r\n`);
      onSock(sock);
    };
    sock.on('data', onData);
    sock.on('error', () => {});
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return portOf(srv);
}
const frame = (b0: number, payload: Buffer) => Buffer.concat([Buffer.from([b0, payload.length]), payload]);

test('ws client: a fragmented message with a ping in between is reassembled, and the ping answered', async t => {
  let gotPong: Buffer | null = null;
  const port = await rawServer(t, sock => {
    sock.write(Buffer.concat([
      frame(0x01, Buffer.from('hel')), // text, not fin
      frame(0x89, Buffer.from('mid')), // ping between fragments
      frame(0x00, Buffer.from('lo ')), // continuation
      frame(0x80, Buffer.from('wörld')), // final continuation
    ]));
    sock.on('data', (d: Buffer) => { if (((d[0] ?? 0) & 0x0f) === 0x0a) gotPong = d; });
  });
  const c = await ws.connect(`ws://127.0.0.1:${port}/`);
  const [d] = await once<Msg>(c, 'message');
  assert.equal(d.toString(), 'hello wörld');
  for (let i = 0; i < 50 && !gotPong; i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(gotPong && (gotPong[1] & 0x80), 'the pong is masked (client frames always are)');
  c.terminate();
});

test('ws client: a masked server frame (1002), an oversized frame (1009) and bad UTF-8 (1007) close the connection', async t => {
  for (const [bytes, code, opts] of [
    [Buffer.from([0x82, 0x81, 1, 2, 3, 4, 9]), 1002, {}],
    [frame(0x82, Buffer.alloc(100)), 1009, { maxPayload: 50 }],
    [frame(0x81, Buffer.from([0xff, 0xfe])), 1007, {}],
  ] as [Buffer, number, { maxPayload?: number }][]) {
    const port = await rawServer(t, sock => sock.write(bytes));
    const c = await ws.connect(`ws://127.0.0.1:${port}/`, opts);
    c.on('error', () => {});
    const [got] = await once<Closed>(c, 'close');
    assert.equal(got, code);
  }
});

test('ws server: an unmasked client frame is refused 1002; a message over maxPayload 1009', async t => {
  const codes: number[] = [];
  const srv = await ws.createServer({ port: 0, maxPayload: 1000, onConnection: c => { c.on('error', () => {}); c.on('close', code => codes.push(code)); } });
  t.after(() => srv.close());
  const port = portOf(srv);
  for (const bytes of [frame(0x82, Buffer.from('raw')), Buffer.concat([Buffer.from([0x02, 0x80 | 120]), Buffer.alloc(4), Buffer.alloc(120)])]) {
    const s = net.connect(port, '127.0.0.1');
    await once(s, 'connect');
    s.write(`GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    await once(s, 'data');
    if (bytes[0] === 0x02) for (let i = 0; i < 9; i++) s.write(i ? Buffer.concat([Buffer.from([0x00]), bytes.subarray(1)]) : bytes); // 9 x 120 > 1000, in fragments
    else s.write(bytes);
    await once(s, 'close');
  }
  for (let i = 0; i < 50 && codes.length < 2; i++) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(codes, [1002, 1009]);
});

test('ws keepalive: a peer that stops answering is terminated after two ping intervals', async t => {
  const port = await rawServer(t, () => { /* never answers, never sends */ });
  const c = await ws.connect(`ws://127.0.0.1:${port}/`, { pingMs: 100 });
  const t0 = Date.now();
  const [code] = await once<Closed>(c, 'close');
  assert.equal(code, 1006);
  assert.ok(Date.now() - t0 < 1000);
});

test('ws client through an HTTP CONNECT proxy', async t => {
  const { port } = await echoServer(t);
  const seen: (string | undefined)[] = [];
  const proxy = http.createServer((_q, s) => s.end());
  proxy.on('connect', (req, sock, head) => {
    seen.push(req.url);
    const [hh, pp] = must(req.url).split(':');
    const up = net.connect(Number(pp), hh, () => { sock.write('HTTP/1.1 200 Connection established\r\n\r\n'); up.write(head); up.pipe(sock).pipe(up); });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
  });
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
  t.after(() => proxy.close());
  // loopback is never proxied from the environment, so name the proxy outright
  const c = await ws.connect(`ws://127.0.0.1:${port}/p`, { proxy: `http://127.0.0.1:${portOf(proxy)}` });
  const m = once<Msg>(c, 'message');
  c.send('via');
  assert.equal((await m)[0].toString(), '/p:via');
  assert.deepEqual(seen, [`127.0.0.1:${port}`]);
  c.terminate();
  // a proxy that refuses
  const deny = http.createServer();
  deny.on('connect', (_req, sock) => sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
  await new Promise<void>(r => deny.listen(0, '127.0.0.1', r));
  t.after(() => deny.close());
  await assert.rejects(ws.connect(`wss://example.invalid/x`, { proxy: `http://127.0.0.1:${portOf(deny)}` }), /refused CONNECT example\.invalid:443: HTTP\/1\.1 403/);
});

test('ws client over TLS (wss) with a CA of our own', { skip: spawnSync('openssl', ['version']).status !== 0 && 'no openssl' }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-ws-tls-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { encoding: 'utf8' });
  if (r.status !== 0) return t.skip(`openssl: ${r.stderr.slice(0, 120)}`);
  const cert = fs.readFileSync(path.join(dir, 'c.pem')), key = fs.readFileSync(path.join(dir, 'k.pem'));
  const { port } = await echoServer(t);
  // a TLS front that forwards to the plain listener, the shape of Tailscale Serve
  const front = tls.createServer({ cert, key }, s => { const u = net.connect(port, '127.0.0.1'); s.pipe(u).pipe(s); u.on('error', () => s.destroy()); s.on('error', () => u.destroy()); });
  await new Promise<void>(ok => front.listen(0, '127.0.0.1', ok));
  t.after(() => front.close());
  const url = `wss://localhost:${portOf(front)}/tls`;
  await assert.rejects(ws.connect(url), /TLS to localhost/);
  const c = await ws.connect(url, { tls: { ca: cert } });
  const m = once<Msg>(c, 'message');
  c.send('sec');
  assert.equal((await m)[0].toString(), '/tls:sec');
  c.terminate();
});

test('proxyFor: HTTPS_PROXY for wss, HTTP_PROXY for ws, NO_PROXY and loopback bypass it', () => {
  const env = { HTTPS_PROXY: 'http://corp:3128', http_proxy: 'http://plain:80', NO_PROXY: 'internal.corp, .ts.net,box:8443' };
  assert.equal(ws.proxyFor('wss://tls-front/x', env), 'http://corp:3128');
  assert.equal(ws.proxyFor('ws://tls-front/x', env), 'http://plain:80');
  assert.equal(ws.proxyFor('wss://a.internal.corp/x', env), null);
  assert.equal(ws.proxyFor('wss://internal.corp/x', env), null);
  assert.equal(ws.proxyFor('wss://box.tail1a2b.ts.net/x', env), null);
  assert.equal(ws.proxyFor('wss://box:8443/x', env), null);
  assert.equal(ws.proxyFor('wss://box/x', env), 'http://corp:3128');
  assert.equal(ws.proxyFor('wss://127.0.0.1:7420/x', env), null);
  assert.equal(ws.proxyFor('wss://localhost/x', env), null);
  assert.equal(ws.proxyFor('wss://x/y', { https_proxy: 'http://p:1', no_proxy: '*' }), null);
  assert.equal(ws.proxyFor('wss://x/y', {}), null);
});

test('listener: it exits on its own once its home is gone (no listener left serving a deleted home)', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-listen-gone-'));
  const env = h.childEnv({ SUB_HUMAN_HOME: home, SUB_HUMAN_ALLOW_TMP_ROOT: '1' });
  const child = spawn(process.execPath, [h.BIN, 'listen', '--port', '0'], { env, stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } fs.rmSync(home, { recursive: true, force: true }); });
  const stateFile = path.join(home, 'listen', 'state.json');
  const pid = await h.until(() => { try { return (JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { pid: number }).pid; } catch { return null; } }, 5000, 25);
  assert.equal(pid, child.pid);
  fs.rmSync(home, { recursive: true, force: true });
  assert.ok(await h.until(() => !isAlive(child.pid) || child.exitCode !== null, 6000, 50), 'gone within the home check');
});

test('listener: one source holds at most 8 connections at once (the front\'s X-Forwarded-For); another source still gets in', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-listen-src-'));
  const env = h.childEnv({ SUB_HUMAN_HOME: home, SUB_HUMAN_ALLOW_TMP_ROOT: '1' });
  const child = spawn(process.execPath, [h.BIN, 'listen', '--port', '0'], { env, stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } fs.rmSync(home, { recursive: true, force: true }); });
  const stateFile = path.join(home, 'listen', 'state.json');
  const port = await h.until(() => { try { return (JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { port: number }).port; } catch { return null; } }, 5000, 25);
  const open = async (src: string) => {
    const c = await ws.connect(`ws://127.0.0.1:${port}/`, { headers: { 'x-forwarded-for': src }, timeoutMs: 3000 });
    let code: number | null = null;
    c.on('close', (k: number) => { code = k; });
    c.on('error', () => {});
    t.after(() => { try { c.close(); } catch { /* gone */ } });
    return { c, code: () => code };
  };
  const held = [];
  for (let i = 0; i < 8; i++) held.push(await open('203.0.113.7'));
  const ninth = await open('203.0.113.7');
  await h.until(() => ninth.code() !== null, 3000, 20);
  assert.equal(ninth.code(), 1013, 'the ninth from one source: busy');
  const other = await open('198.51.100.2');
  await h.sleep(150);
  assert.equal(other.code(), null, 'another source is not held back');
  assert.ok(held.every(x => x.code() === null), 'the eight stay (each waits for its handshake)');
});

test('kick: the listener\'s child (`serve --stdio CODE --via ws --peer KEY`) names no link; a kick still ends its stream AUTH and closes it', async t => {
  h.freshHome(t);
  const code = h.newRoom();
  const store = await import('../lib/room/store.ts');
  const hostLinks = await import('../lib/remote/host-links.ts');
  const client = await import('../lib/remote/client.ts');
  const pipe = await import('../lib/remote/transports/pipe.ts');
  const seatKey = await import('../hooks/seat-key.ts');
  const hosting = await import('../lib/remote/hosting.ts');
  const host = store.open(code);
  const peer = crypto.randomBytes(32).toString('base64url');
  const { token } = hostLinks.create(host, { id: hostLinks.newLinkId(), machine: mid('web0machine00001'), seats: [], key: peer });
  const tr = pipe.spawn(process.execPath, [h.BIN, 'serve', '--stdio', code, '--via', 'ws', '--peer', peer], { env: { ...h.childEnv(), SUB_HUMAN_CLAUDE: '/usr/bin/false' } });
  let closed = false;
  tr.onClose(() => { closed = true; });
  const c = await client.connect(tr, { machine: mid('web0machine00001'), token });
  t.after(() => c.close());
  const key = seatKey.ensure(code, sn('carol'));
  const pubkey = seatKey.publicPem(code, sn('carol'));
  assert.deepEqual(await c.join({ name: 'carol', pubkey, proof: hostLinks.proveSeat(key, { room: code, name: sn('carol'), pubkey }) }), { ok: true });
  const ends: string[] = [];
  const sub = c.subscribe(0, store.hash12(''), ({ ev, data }) => { if (ev === 'end') ends.push((data as { reason: string }).reason); });
  await sub.ready;
  hosting.kick(code, 'carol');
  assert.ok(await h.until(() => ends.length > 0 && closed, 5000, 20), `ended ${JSON.stringify(ends)}, closed ${closed}`);
  assert.deepEqual(ends, ['AUTH']);
});

test('listener (item 16): once the last room it served closed and no connection is open, it exits at once, not after LISTEN_IDLE_MS', async t => {
  h.freshHome(t);
  const listenerMod = await import('../lib/remote/listener.ts');
  listenerMod.addRoom(rc('vole-0042'), { path: '/sub-human/vole-0042', url: 'https://box/sub-human/vole-0042', mode: 'url' });
  const t0 = Date.now();
  const r = await listenerMod.run({ port: 0, closedCheckMs: 50, idleMs: 600_000, log: () => {} });
  assert.equal(r.why, 'the last room it served closed');
  assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
  assert.deepEqual(Object.keys(listenerMod.status().rooms), []);
});
