'use strict';
// 1.1 end to end on one machine, two homes (test/support/two-homes.js): the host's `/sub-human host --url` starts the
// listener (127.0.0.1 only) and shows a join URL + PIN to the person only; the joiner's `/sub-human join NAME URL PIN`
// links over a WebSocket and a Noise_NK channel that pins the listener's key, with no admit step; posts flow and the
// mirror converges. A wrong PIN costs a try. The link daemon's reconnect works over ws: the listener restarted and
// a TLS front (the shape of Tailscale Serve) restarted. `--tailscale [--funnel]` runs the exact tailscale commands
// against a fake `tailscale` on PATH, and unhost turns only that path off.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const h = require('./helpers.js');
const store = require(path.join(h.LIB, 'room', 'store.js'));
const link = require(path.join(h.LIB, 'remote', 'link.js'));
const auth = require(path.join(h.LIB, 'remote', 'auth.js'));
const listener = require(path.join(h.LIB, 'remote', 'listener.js'));
const wsT = require(path.join(h.LIB, 'remote', 'transports', 'ws.js'));
const { Machine } = require('./support/two-homes.js');

const LINK_ENV = { SUB_HUMAN_LINK_RETRY_MS: '200', SUB_HUMAN_LINK_RETRY_MAX_MS: '600', SUB_HUMAN_LINK_IDLE_MS: '20000' };
const childOf = pid => Number(spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.trim().split('\n')[0]) || null;
const kill = pid => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const hiddenBlock = r => r.json && r.json.decision === 'block' && r.json.hookSpecificOutput && r.json.hookSpecificOutput.suppressOriginalPrompt === true;
const modelSees = r => JSON.stringify([r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext, r.json && r.json.systemMessage]);
const shown = reason => ({ url: /https?:\/\/\S+#\S+/.exec(reason)[0], pin: /PIN (\d{6})/.exec(reason)[1] });

/** A CA of our own and a localhost certificate it signed (the joiner trusts the CA through NODE_EXTRA_CA_CERTS, as a
 * ts.net certificate is publicly trusted): the leaf PEM, or null when openssl cannot. */
function testCa(dir) {
  const o = (...a) => spawnSync('openssl', a, { cwd: dir, encoding: 'utf8' }).status === 0;
  fs.writeFileSync(path.join(dir, 'ext.cnf'), 'subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\n');
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  const ok = o('req', '-x509', ...ec, '-days', '1', '-subj', '/CN=sub-human test CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign', '-keyout', 'ca.key', '-out', 'ca.pem')
    && o('req', ...ec, '-subj', '/CN=localhost', '-keyout', 'k.pem', '-out', 'r.csr')
    && o('x509', '-req', '-in', 'r.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-extfile', 'ext.cnf', '-out', 'c.pem');
  return ok ? fs.readFileSync(path.join(dir, 'c.pem')) : null;
}

async function rig(t, hostEnv = {}, remoteEnv = {}) {
  const port = await freePort();
  const host = new Machine(t, 'host', { SUB_HUMAN_LISTEN_PORT: String(port), ...hostEnv });
  const remote = new Machine(t, 'remote', { ...LINK_ENV, ...remoteEnv });
  const alice = host.seat('alice'), bob = remote.seat('bob');
  assert.equal(host.join(alice, 'alice').json.decision, undefined);
  const code = host.lib(() => store.listRooms()[0]);
  t.after(() => {
    host.lib(() => listener.stop());
    const d = remote.lib(() => link.status(code));
    if (d.pid) { kill(childOf(d.pid)); kill(d.pid); }
    fs.rmSync(path.dirname(link.socketPath(path.join(remote.home, 'rooms', code))), { recursive: true, force: true });
  });
  return { port, host, remote, alice, bob, code };
}

const linkState = (m, code) => m.lib(() => link.status(code).state);
async function posts(t, { host, remote, alice, bob, code }, text) {
  const r = remote.say(bob, text);
  assert.equal(r.json && r.json.continue, false, JSON.stringify(r.json) + r.stderr);
  assert.ok(host.lib(() => store.open(code).readAll()).some(e => e.text === text));
  assert.equal(host.say(alice, `${text} (back)`).json.continue, false);
  await h.until(() => remote.log(code) === host.log(code), 8000, 50);
  assert.equal(remote.log(code), host.log(code), 'the mirror is byte-identical');
}

test('wss 1.1: host --url shows a join URL + PIN to the person only; join NAME URL PIN links over ws + Noise with no admit step; posts flow', async t => {
  const R = await rig(t);
  const { port, host, remote, alice, bob, code } = R;
  const out = host.join(alice, `host --url http://127.0.0.1:${port}`);
  assert.ok(hiddenBlock(out), out.stderr);
  assert.equal(out.json.systemMessage, undefined);
  const { url, pin } = shown(out.json.reason);
  assert.match(url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/sub-human/${code}#[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}$`));
  const st = host.lib(() => listener.status());
  assert.ok(st.running && st.port === port && st.rooms[code], JSON.stringify(st));
  assert.equal(url.split('.').pop(), host.lib(() => listener.hostKey()), 'the URL pins the listener\'s X25519 key');
  assert.equal(fs.statSync(path.join(host.home, 'listen', 'host-x25519.json')).mode & 0o777, 0o600);
  const ss = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout;
  if (ss) assert.match(ss, /127\.0\.0\.1:\d+ \(LISTEN\)/, 'loopback only');
  // the URL is an sh2 invite in another form
  const parsed = wsT.parseJoinUrl(url);
  assert.equal(parsed.locator, `ws://127.0.0.1:${port}/sub-human/${code}`);
  assert.deepEqual(auth.parseInvite(parsed.invite), { v: 2, code, locator: parsed.locator, secret: parsed.secret, hostKey: parsed.hostKey });
  assert.ok(new RegExp(parsed.invite.replace(/[.]/g, '\\.')).test(out.json.reason), 'the plain sh2 string is shown too');

  // a wrong PIN: refused, a try spent, hidden from the model
  const wrong = String((Number(pin) + 1) % 1e6).padStart(6, '0');
  const bad = remote.join(bob, `join bob ${url} ${wrong}`);
  assert.ok(hiddenBlock(bad));
  assert.match(bad.json.reason, /could not link to room .*wrong PIN \(4 tries left\)/);
  assert.ok(!modelSees(bad).includes(wrong) && !modelSees(bad).includes(parsed.secret));

  const ok = remote.join(bob, `join bob ${url} ${pin}`);
  assert.ok(hiddenBlock(ok), ok.stderr);
  assert.match(ok.json.reason, new RegExp(`linked to room ${code}: the host checked your PIN\\. Now type: /sub-human bob ${code}`));
  assert.ok(!modelSees(ok).includes(pin) && !modelSees(ok).includes(parsed.secret));
  const lf = JSON.parse(fs.readFileSync(path.join(remote.home, 'links', `${code}.json`), 'utf8'));
  assert.deepEqual(lf.transport, { kind: 'ws', host: '127.0.0.1', port, path: `/sub-human/${code}`, hostKey: parsed.hostKey });
  assert.deepEqual([typeof lf.token, 'pin' in lf, 'invite' in lf, 'request' in lf], ['string', false, false, false], 'no admit request: the PIN was the admission');
  assert.match(host.lib(() => store.open(code).readAll()).map(e => e.text).join('\n'), /linked to the room with an invite and its PIN \(link [0-9a-f]{12}\)/);

  const seated = remote.join(bob, `bob ${code}`);
  assert.equal(seated.json.decision, undefined, seated.json.reason);
  await posts(t, R, 'hello over wss');

  // what the listener logged holds no secret
  const log = fs.readFileSync(host.lib(() => listener.logFile()), 'utf8');
  for (const s of [pin, parsed.secret, lf.token]) assert.ok(!log.includes(s));
  assert.match(log, new RegExp(`room ${code}: a connection from 127\\.0\\.0\\.1; serve pid \\d+`));

  // a URL cut short, or one with only a PIN, is refused
  for (const u of [url.split('#')[0], `http://127.0.0.1:${port}/${code}`, url.replace(/\.[^.]+$/, '')]) {
    const r = remote.join(bob, `join bob ${u} ${pin}`);
    assert.ok(hiddenBlock(r));
    assert.match(r.json.reason, /not a whole join URL/);
  }
});

test('wss 1.1: the listener refuses a handshake to another key, a room it does not serve, and plain HTTP', async t => {
  const R = await rig(t);
  const { port, host, alice, code } = R;
  const { url } = shown(host.join(alice, `host --url http://127.0.0.1:${port}`).json.reason);
  const ws = require(path.join(h.LIB, 'remote', 'ws.js'));
  const noise = require(path.join(h.LIB, 'remote', 'noise.js'));
  const pinned = Buffer.from(url.split('.').pop(), 'base64url');
  // a joiner pinning another key: message 2 cannot come (the listener cannot read message 1)
  const c1 = await ws.connect(`ws://127.0.0.1:${port}/sub-human/${code}`);
  await assert.rejects(wsT.clientChannel(c1, { rs: noise.generateKeyPair().pub, code }), e => e.code === 'OFFLINE' && /closed \(4401/.test(e.message));
  // a room not served over the web here: refused inside the channel (authenticated by the pinned key)
  const c2 = await ws.connect(`ws://127.0.0.1:${port}/sub-human/vole-0001`);
  await assert.rejects(wsT.clientChannel(c2, { rs: pinned, code: 'vole-0001' }), e => e.code === 'OFFLINE' && /not open for joins over the web/.test(e.message));
  // a path for one room, a handshake for another
  const c3 = await ws.connect(`ws://127.0.0.1:${port}/sub-human/${code}`);
  await assert.rejects(wsT.clientChannel(c3, { rs: pinned, code: 'vole-0001' }), /this URL is for room/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 426);
  // unhost: no longer served, and the listener stops with no room left
  const un = host.join(alice, 'unhost');
  assert.ok(hiddenBlock(un));
  assert.match(un.json.reason, new RegExp(`room ${code} is no longer served over the web; the listener stopped`));
  assert.equal(host.lib(() => listener.status()).running, false);
});

test('wss 1.1 reconnect: the link comes back after the listener restarts and after the TLS front restarts', { skip: spawnSync('openssl', ['version']).status !== 0 && 'no openssl' }, async t => {
  const certDir = h.tmpDir('sh-front-', t);
  if (!testCa(certDir)) return t.skip('openssl could not make a test CA');
  const R = await rig(t, {}, { NODE_EXTRA_CA_CERTS: path.join(certDir, 'ca.pem') });
  const { port, host, remote, alice, bob, code } = R;
  // the TLS front: terminates TLS for https://localhost:FRONT and forwards to the listener, as Tailscale Serve does
  const frontPort = await freePort();
  const front = () => new Promise((ok, no) => {
    const c = spawn(process.execPath, [path.join(__dirname, 'support', 'tls-front.js'), String(frontPort), String(port), path.join(certDir, 'c.pem'), path.join(certDir, 'k.pem')], { stdio: ['ignore', 'pipe', 'inherit'] });
    c.stdout.once('data', () => ok(c));
    c.once('exit', () => no(new Error('the front exited')));
  });
  const down = f => new Promise(r => { f.once('exit', r); f.kill('SIGKILL'); });
  let f = await front();
  t.after(() => f.kill('SIGKILL'));
  const { url, pin } = shown(host.join(alice, `host --url https://localhost:${frontPort}`).json.reason);
  assert.match(url, new RegExp(`^https://localhost:${frontPort}/sub-human/${code}#`));
  const j = remote.join(bob, `join bob ${url} ${pin}`);
  assert.match(j.json.reason, /linked to room/, (() => { try { return fs.readFileSync(remote.lib(() => require(path.join(h.LIB, 'room', 'links.js')).logFile(code)), 'utf8'); } catch (e) { return e.message; } })());
  assert.equal(JSON.parse(fs.readFileSync(path.join(remote.home, 'links', `${code}.json`), 'utf8')).transport.kind, 'wss');
  assert.equal(remote.join(bob, `bob ${code}`).json.decision, undefined);
  await posts(t, R, 'before any restart');

  // 1. the listener restarts (a plugin update, a crash): every serve child goes with it; the link redials
  host.lib(() => listener.stop());
  assert.ok(await h.until(() => linkState(remote, code) === 'offline', 8000, 50), 'offline once the listener is gone');
  host.lib(() => listener.start({ port }));
  assert.ok(await h.until(() => linkState(remote, code) === 'online', 10_000, 50), 'online again after the listener restarts');
  await posts(t, R, 'after the listener restart');

  // 2. the TLS front restarts (tailscaled restarts, Caddy reloads): the same
  await down(f);
  assert.ok(await h.until(() => linkState(remote, code) === 'offline', 8000, 50), 'offline once the front is gone');
  f = await front();
  assert.ok(await h.until(() => linkState(remote, code) === 'online', 10_000, 50), 'online again after the front restarts');
  await posts(t, R, 'after the front restart');
  // the outbox over ws: a post while the front is down is queued and sent once on the way back
  await down(f);
  assert.ok(await h.until(() => linkState(remote, code) === 'offline', 8000, 50));
  const q = remote.say(bob, 'queued over wss');
  assert.equal(q.json && q.json.continue, false, JSON.stringify(q.json));
  f = await front();
  assert.ok(await h.until(() => host.lib(() => store.open(code).readAll()).filter(e => e.text === 'queued over wss').length === 1, 10_000, 50), 'the queued post lands once');
});

test('host --tailscale [--funnel]: the exact tailscale commands (a fake tailscale on PATH), the CT-log line, and unhost turns only that path off', async t => {
  const bin = h.tmpDir('sh-fake-ts-', t);
  const calls = path.join(bin, 'calls.log');
  fs.writeFileSync(path.join(bin, 'tailscale'), `#!/bin/sh
echo "$@" >> "${calls}"
case "$1" in
  status) echo '{"BackendState":"Running","Self":{"DNSName":"box.tail1a2b.ts.net.","Online":true}}' ;;
  serve|funnel) exit 0 ;;
esac
`, { mode: 0o755 });
  const R = await rig(t, { PATH: `${bin}:${process.env.PATH}` });
  const { port, host, alice, code } = R;
  const out = host.join(alice, 'host --tailscale');
  assert.ok(hiddenBlock(out), out.stderr);
  const { url } = shown(out.json.reason);
  assert.match(url, new RegExp(`^https://box\\.tail1a2b\\.ts\\.net/sub-human/${code}#`));
  assert.match(out.json.reason, /Tailscale Serve \(your tailnet only\)/);
  assert.doesNotMatch(out.json.reason, /certificate-transparency/);
  const p = `/sub-human/${code}`;
  const lines = () => fs.readFileSync(calls, 'utf8').trim().split('\n');
  assert.deepEqual(lines(), ['status --json', `serve --bg --https=443 --set-path=${p} http://127.0.0.1:${port}`]);
  // again: a new invite, the same serve path (not run twice)
  host.join(alice, 'host --tailscale');
  assert.equal(lines().filter(l => l.startsWith('serve')).length, 1);
  // --funnel: opt-in, the serve path off first, then funnel, with the one-line CT warning
  const fun = host.join(alice, 'host --tailscale --funnel');
  assert.match(fun.json.reason, /Tailscale Funnel \(public\)/);
  assert.match(fun.json.reason, /public certificate-transparency logs/);
  assert.deepEqual(lines().slice(-2), [`serve --https=443 --set-path=${p} off`, `funnel --bg --https=443 --set-path=${p} http://127.0.0.1:${port}`]);
  // unhost: only our path, never `serve reset`
  const un = host.join(alice, 'unhost');
  assert.match(un.json.reason, new RegExp(`tailscale funnel ${p} is off`));
  assert.equal(lines().at(-1), `funnel --https=443 --set-path=${p} off`);
  assert.ok(!lines().some(l => /reset/.test(l)));
  // no tailscale at all: a clear refusal
  const none = new Machine(t, 'nots', { PATH: '/usr/bin:/bin', SUB_HUMAN_LISTEN_PORT: String(await freePort()) });
  const carol = none.seat('carol');
  none.join(carol, 'carol');
  t.after(() => none.lib(() => listener.stop()));
  const ts = require(path.join(h.LIB, 'remote', 'tailscale.js'));
  if (!ts.bin({ PATH: '/usr/bin:/bin' })) assert.match(none.join(carol, 'host --tailscale').json.reason, /no tailscale CLI here/);
});

test('the room closing stops serving it: the listener drops it and turns its Tailscale path off', async t => {
  const bin = h.tmpDir('sh-fake-ts-', t);
  const calls = path.join(bin, 'calls.log');
  fs.writeFileSync(path.join(bin, 'tailscale'), `#!/bin/sh\necho "$@" >> "${calls}"\n[ "$1" = status ] && echo '{"Self":{"DNSName":"box.ts.net."}}'\nexit 0\n`, { mode: 0o755 });
  const R = await rig(t, { PATH: `${bin}:${process.env.PATH}`, SUB_HUMAN_LISTEN_CHECK_MS: '200' });
  const { host, alice, code } = R;
  host.join(alice, 'host --tailscale');
  host.lib(() => require(path.join(h.LIB, 'identity.js')).updateOrch(code, o => ({ ...o, stopped_at: new Date().toISOString() })));
  assert.ok(await h.until(() => !host.lib(() => listener.status()).rooms[code], 8000, 100), 'dropped from the served set');
  assert.ok(await h.until(() => fs.readFileSync(calls, 'utf8').includes(`serve --https=443 --set-path=/sub-human/${code} off`), 3000, 50));
});
