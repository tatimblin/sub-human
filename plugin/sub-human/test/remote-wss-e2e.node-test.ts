// 1.1 end to end on one machine, two homes (test/support/two-homes.ts): the host's `/sub-human invite --web` (behind a test front: lib/env.ts webFront) starts the
// listener (127.0.0.1 only) and shows a join URL#SECRET and the PIN apart, to the person only; the joiner's
// `/sub-human join URL#SECRET [PIN]` (or the older URL SECRET) asks the listener for its key, checks it against the
// line's tag, pins it, and runs Noise XK with a key of the link's own; the PIN, on the line or as `/sub-human join PIN`
// once the host asks, lets the machine in with no card, and the room hears its check; a bare /sub-human takes the seat; posts flow and the mirror converges. A wrong PIN costs a try. The link daemon's reconnect
// works over ws: the listener restarted and a TLS front (the shape of Tailscale Serve) restarted. `--web` / `--public`
// run the exact tailscale commands against a fake `tailscale` on PATH, and `invite --stop` turns only that path off.
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as h from './helpers.ts';
import * as store from '../lib/room/store.ts';
import * as linkSocket from '../lib/remote/link-socket.ts';
import * as listener from '../lib/remote/listener.ts';
import * as wsT from '../lib/remote/transports/ws.ts';
import { Machine, shownInvite, childOf, kill, hiddenBlock } from './support/two-homes.ts';
import type { MachineRun } from './support/two-homes.ts';
import * as ws from '../lib/remote/ws.ts';
import * as noise from '../lib/remote/noise.ts';
import * as ts from '../lib/remote/tailscale.ts';
import * as identityLib from '../lib/identity.ts';
import * as links from '../lib/room/links.ts';
import * as admission from '../lib/remote/admission.ts';
import * as hostLinks from '../lib/remote/host-links.ts';
import * as inviteSecret from '../lib/remote/invite-secret.ts';
import type { RoomCode } from '../lib/brand.ts';
import type { Link } from '../lib/room/types.ts';
import type { WsSpec } from '../lib/remote/types-rest.ts';
import { rc } from './support/brands.ts';
import { must } from './support/must.ts';

const LINK_ENV: Record<string, string> = { SUB_HUMAN_LINK_RETRY_MS: '200', SUB_HUMAN_LINK_RETRY_MAX_MS: '600', SUB_HUMAN_LINK_IDLE_MS: '20000' };
const freePort = () => new Promise<number>(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });
const modelSees = (r: MachineRun) => JSON.stringify([r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext, r.json && r.json.systemMessage]);
/** The joiner's link file (<home>/links/<code>.json) as stored: a web link's. */
const linkFile = (m: Machine, code: RoomCode) => JSON.parse(fs.readFileSync(path.join(m.home, 'links', `${code}.json`), 'utf8')) as Omit<Link, 'transport'> & { transport: WsSpec };

/** A CA of our own and a localhost certificate it signed (the joiner trusts the CA through NODE_EXTRA_CA_CERTS, as a
 * ts.net certificate is publicly trusted): the leaf PEM, or null when openssl cannot. */
function testCa(dir: string) {
  const o = (...a: string[]) => spawnSync('openssl', a, { cwd: dir, encoding: 'utf8' }).status === 0;
  fs.writeFileSync(path.join(dir, 'ext.cnf'), 'subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\n');
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  const ok = o('req', '-x509', ...ec, '-days', '1', '-subj', '/CN=sub-human test CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign', '-keyout', 'ca.key', '-out', 'ca.pem')
    && o('req', ...ec, '-subj', '/CN=localhost', '-keyout', 'k.pem', '-out', 'r.csr')
    && o('x509', '-req', '-in', 'r.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-extfile', 'ext.cnf', '-out', 'c.pem');
  return ok ? fs.readFileSync(path.join(dir, 'c.pem')) : null;
}

async function rig(t: TestContext, hostEnv: Record<string, string> = {}, remoteEnv: Record<string, string> = {}) {
  const port = await freePort();
  const host = new Machine(t, 'host', { SUB_HUMAN_LISTEN_PORT: String(port), ...hostEnv });
  const remote = new Machine(t, 'remote', { ...LINK_ENV, ...remoteEnv });
  const alice = host.seat('alice'), bob = remote.seat('bob');
  assert.equal(must(host.join(alice, 'alice').json).decision, undefined);
  const code = must(host.lib(() => store.listRooms()[0]), 'the room');
  t.after(() => {
    host.lib(() => listener.stop());
    const d = remote.lib(() => linkSocket.status(code));
    if (d.pid) { kill(childOf(d.pid)); kill(d.pid); }
    fs.rmSync(path.dirname(linkSocket.socketPath(path.join(remote.home, 'rooms', code))), { recursive: true, force: true });
  });
  return { port, host, remote, alice, bob, code };
}

type Rig = Awaited<ReturnType<typeof rig>>;

const linkState = (m: Machine, code: RoomCode) => m.lib(() => linkSocket.status(code).state);
async function posts(_t: TestContext, { host, remote, alice, bob, code }: Rig, text: string) {
  const r = remote.say(bob, text);
  assert.equal(r.json && r.json.continue, false, JSON.stringify(r.json) + r.stderr);
  assert.ok(host.lib(() => store.open(code).readAll()).some(e => e.text === text));
  assert.equal(must(host.say(alice, `${text} (back)`).json).continue, false);
  await h.until(() => remote.log(code) === host.log(code), 8000, 50);
  assert.equal(remote.log(code), host.log(code), 'the mirror is byte-identical');
}

const shortShown = (reason: string | undefined) => shownInvite(String(reason));
/** bob joins with the line the host was shown: the key check and the SECRET (with no PIN it knocks), the PIN while the
 * host's card waits (it lets him in: no card), the link online, a bare /sub-human. */
async function webJoin({ remote, bob, code }: Rig, reason: string | undefined) {
  const m = shortShown(reason);
  assert.ok(m, reason);
  remote.join(bob, `${m.line} --as bob`);
  const logOf = () => { try { return fs.readFileSync(path.join(remote.home, 'links', `${code}.log`), 'utf8'); } catch (e) { return (e as Error).message; } };
  assert.ok(await h.until(() => remote.lib(() => !!(links.get(code) || {}).awaiting), 15_000, 50), `the line knocks (the host's card waits): ${logOf()}`);
  const j = remote.join(bob, `join ${m.pin}`);
  assert.match(must(j.json?.reason), /the host let you in to room/, logOf());
  assert.ok(await h.until(() => linkState(remote, code) === 'online', 15_000, 50), 'online once let in');
  assert.equal(must(remote.join(bob, '').json).decision, undefined);
  return m;
}


test('wss 1.1: the listener gives its key to a text request, refuses a handshake to another key, a room it does not serve, and plain HTTP; XK proves the link\'s own key', async t => {
  const R = await rig(t);
  const { port, host, alice, code } = R;
  assert.ok(shortShown(must(host.join(alice, 'invite --web', { SUB_HUMAN_WEB_FRONT: `http://127.0.0.1:${port}` }).json?.reason)));
  const pinned = Buffer.from(host.lib(() => listener.hostKey()), 'base64url');
  assert.equal(fs.statSync(path.join(host.home, 'listen', 'host-x25519.json')).mode & 0o777, 0o600);
  const ss = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout;
  if (ss) assert.match(ss, /127\.0\.0\.1:\d+ \(LISTEN\)/, 'loopback only');
  // the key, for an invite line's first dial (it checks it against the line's tag)
  assert.equal(await wsT.fetchKey({ kind: 'ws', host: '127.0.0.1', port, path: `/sub-human/${code}` }), pinned.toString('base64url'));
  // a joiner pinning another key: message 2 cannot come (the listener cannot read message 1)
  const c1 = await ws.connect(`ws://127.0.0.1:${port}/sub-human/${code}`);
  await assert.rejects(wsT.clientChannel(c1, { rs: noise.generateKeyPair().pub, code, s: noise.generateKeyPair() }), (e: Error & { code?: string }) => e.code === 'OFFLINE' && /closed \(4401/.test(e.message));
  // a room not served over the web here: refused inside the channel (authenticated by the pinned key)
  const c2 = await ws.connect(`ws://127.0.0.1:${port}/sub-human/vole-0001`);
  await assert.rejects(wsT.clientChannel(c2, { rs: pinned, code: rc('vole-0001'), s: noise.generateKeyPair() }), (e: Error & { code?: string }) => e.code === 'OFFLINE' && /not open for joins over the web/.test(e.message));
  // a path for one room, a handshake for another
  const c3 = await ws.connect(`ws://127.0.0.1:${port}/sub-human/${code}`);
  await assert.rejects(wsT.clientChannel(c3, { rs: pinned, code: rc('vole-0001'), s: noise.generateKeyPair() }), /this URL is for room/);
  // XK gets through to serve: the log names the key it proved
  const mine = noise.generateKeyPair();
  const c = await ws.connect(`ws://127.0.0.1:${port}/sub-human/${code}`);
  (await wsT.clientChannel(c, { rs: pinned, code, s: mine })).destroy();
  const tag = `(key ${mine.pub.toString('base64url').slice(0, 12)}…)`;
  const lg = await h.until(() => { const x = fs.readFileSync(path.join(host.home, 'listen', 'listen.log'), 'utf8'); return x.includes(tag) && x; }, 5000, 50);
  assert.ok(lg, 'the listener logged the key');
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 426);
  // invite --stop: no longer served, and the listener stops with no room left
  const un = host.join(alice, 'invite --stop');
  assert.ok(hiddenBlock(un));
  assert.match(must(un.json?.reason), new RegExp(`room ${code} is no longer served over the web; the listener stopped`));
  assert.equal(host.lib(() => listener.status()).running, false);
});

test('wss 1.1 reconnect: the link comes back after the listener restarts and after the TLS front restarts', { skip: spawnSync('openssl', ['version']).status !== 0 && 'no openssl' }, async t => {
  const certDir = h.tmpDir('sh-front-', t);
  if (!testCa(certDir)) return t.skip('openssl could not make a test CA');
  const R = await rig(t, {}, { NODE_EXTRA_CA_CERTS: path.join(certDir, 'ca.pem') });
  const { port, host, remote, alice, bob, code } = R;
  // the TLS front: terminates TLS for https://localhost:FRONT and forwards to the listener, as Tailscale Serve does
  const frontPort = await freePort();
  const front = () => new Promise<ChildProcess>((ok, no) => {
    const c = spawn(process.execPath, [path.join(import.meta.dirname, 'support', 'tls-front.ts'), String(frontPort), String(port), path.join(certDir, 'c.pem'), path.join(certDir, 'k.pem')], { stdio: ['ignore', 'pipe', 'inherit'] });
    c.stdout.once('data', () => ok(c));
    c.once('exit', () => no(new Error('the front exited')));
  });
  const down = (f: ChildProcess) => new Promise(r => { f.once('exit', r); f.kill('SIGKILL'); });
  let f = await front();
  t.after(() => f.kill('SIGKILL'));
  const m = await webJoin(R, must(host.join(alice, 'invite --web', { SUB_HUMAN_WEB_FRONT: `https://localhost:${frontPort}` }).json?.reason));
  assert.equal(m.dest, `https://localhost:${frontPort}/sub-human/${code}`);
  assert.equal(linkFile(remote, code).transport.kind, 'wss');
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

test('invite --web / --public: the exact tailscale commands (a fake tailscale on PATH), the CT-log line, and invite --stop turns only that path off', async t => {
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
  const out = host.join(alice, 'invite --web');
  assert.ok(hiddenBlock(out), out.stderr);
  assert.equal(must(shortShown(must(out.json?.reason))).dest, `https://box.tail1a2b.ts.net/sub-human/${code}`);
  assert.match(must(out.json?.reason), /Tailscale Serve \(your tailnet only\)/);
  assert.match(must(out.json?.reason), /can take ~20 s while Tailscale issues its certificate; it is being fetched now/);
  assert.doesNotMatch(must(out.json?.reason), /certificate-transparency/);
  const p = `/sub-human/${code}`;
  const lines = () => fs.readFileSync(calls, 'utf8').trim().split('\n');
  assert.deepEqual(lines(), ['status --json', `serve --bg --https=443 --set-path=${p} http://127.0.0.1:${port}`]);
  // again: a new invite, the same serve path (not run twice)
  host.join(alice, 'invite --web');
  assert.equal(lines().filter(l => l.startsWith('serve')).length, 1);
  // --public: opt-in, the serve path off first, then funnel, with the one-line CT warning
  const fun = host.join(alice, 'invite --public');
  assert.match(must(fun.json?.reason), /Tailscale Funnel \(public\)/);
  assert.match(must(fun.json?.reason), /public certificate-transparency logs/);
  assert.deepEqual(lines().slice(-2), [`serve --https=443 --set-path=${p} off`, `funnel --bg --https=443 --set-path=${p} http://127.0.0.1:${port}`]);
  // invite --stop: only our path, never `serve reset`
  const un = host.join(alice, 'invite --stop');
  assert.match(must(un.json?.reason), new RegExp(`tailscale funnel ${p} is off`));
  assert.equal(lines().at(-1), `funnel --https=443 --set-path=${p} off`);
  assert.ok(!lines().some(l => /reset/.test(l)));
  // no tailscale at all: a clear refusal
  const none = new Machine(t, 'nots', { PATH: '/usr/bin:/bin', SUB_HUMAN_LISTEN_PORT: String(await freePort()) });
  const carol = none.seat('carol');
  none.join(carol, 'carol');
  t.after(() => none.lib(() => listener.stop()));
  if (!ts.bin({ PATH: '/usr/bin:/bin' })) assert.match(must(none.join(carol, 'invite --web').json?.reason), /no tailscale CLI here/);
});

test('the room closing stops serving it: the listener drops it and turns its Tailscale path off', async t => {
  const bin = h.tmpDir('sh-fake-ts-', t);
  const calls = path.join(bin, 'calls.log');
  fs.writeFileSync(path.join(bin, 'tailscale'), `#!/bin/sh\necho "$@" >> "${calls}"\n[ "$1" = status ] && echo '{"Self":{"DNSName":"box.ts.net."}}'\nexit 0\n`, { mode: 0o755 });
  const R = await rig(t, { PATH: `${bin}:${process.env.PATH}`, SUB_HUMAN_LISTEN_CHECK_MS: '200' });
  const { host, alice, code } = R;
  host.join(alice, 'invite --web');
  host.lib(() => identityLib.updateRoomClaude(code, o => ({ ...o, stopped_at: new Date().toISOString() })));
  assert.ok(await h.until(() => !host.lib(() => listener.status()).rooms[code], 8000, 100), 'dropped from the served set');
  assert.ok(await h.until(() => fs.readFileSync(calls, 'utf8').includes(`serve --https=443 --set-path=/sub-human/${code} off`), 3000, 50));
});

test('a web invite: invite --web behind a front shows URL#SECRET (the SECRET as the URL\'s fragment) and the PIN apart (no NAME); the line\'s tag names the listener\'s key, checked before the Noise handshake; XK with a key of the link\'s own, through a TLS front; the right PIN lets the machine in (no card)', { skip: spawnSync('openssl', ['version']).status !== 0 && 'no openssl' }, async t => {
  const certDir = h.tmpDir('sh-front-', t);
  if (!testCa(certDir)) return t.skip('openssl could not make a test CA');
  const R = await rig(t, {}, { NODE_EXTRA_CA_CERTS: path.join(certDir, 'ca.pem') });
  const { port, host, remote, alice, bob, code } = R;
  const frontPort = await freePort();
  const f = await new Promise<ChildProcess>((ok, no) => {
    const c = spawn(process.execPath, [path.join(import.meta.dirname, 'support', 'tls-front.ts'), String(frontPort), String(port), path.join(certDir, 'c.pem'), path.join(certDir, 'k.pem')], { stdio: ['ignore', 'pipe', 'inherit'] });
    c.stdout.once('data', () => ok(c));
    c.once('exit', () => no(new Error('the front exited')));
  });
  t.after(() => f.kill('SIGKILL'));
  const out = host.join(alice, 'invite --web', { SUB_HUMAN_WEB_FRONT: `https://localhost:${frontPort}` });
  assert.equal(must(out.json).systemMessage, undefined, 'the SECRET and the PIN stay off Remote Control');
  const st = host.lib(() => listener.status());
  assert.ok(st.running && st.port === port && st.rooms[code], JSON.stringify(st));
  assert.ok(hiddenBlock(out), out.stderr);
  const m = shortShown(must(out.json?.reason));
  assert.ok(m, must(out.json?.reason));
  assert.equal(m.dest, `https://localhost:${frontPort}/sub-human/${code}`, 'the URL: no key, and the SECRET only as its fragment');
  assert.equal(m.line, `join ${m.dest}#${m.word}`);
  const d = must(inviteSecret.decode(m.word));
  assert.ok(inviteSecret.keyHolds(d, 'listener', host.lib(() => listener.hostKey())), 'the tag names the listener\'s key');
  // the older form (URL SECRET, the SECRET as a word of its own) still joins; a wrong PIN first: one try, and the room hears it
  remote.join(bob, `join ${m.dest} ${m.word} --as bob`);
  assert.ok(await h.until(() => remote.lib(() => !!(links.get(code) || {}).awaiting), 15_000, 50), 'the line knocks (the host\'s card waits)');
  const lf0 = linkFile(remote, code);
  assert.equal(lf0.transport.hostKey, host.lib(() => listener.hostKey()), 'the listener key, pinned once the line\'s tag named it');
  assert.match(must(lf0.transport.clientKey), /^[A-Za-z0-9_-]{43}$/, 'a key of the link\'s own');
  const bad = String((Number(m.pin) + 1) % 10_000).padStart(4, '0');
  const w = remote.join(bob, `join ${bad}`);
  assert.ok(hiddenBlock(w));
  assert.match(must(w.json?.reason), /wrong PIN \(4 tries left\)/);
  assert.ok(!modelSees(w).includes(bad));
  await new Promise(r => setTimeout(r, 4200)); // this machine's wait after a wrong PIN (4 s)
  const j = remote.join(bob, `join ${m.pin}`);
  assert.ok(hiddenBlock(j));
  assert.ok(!modelSees(j).includes(m.pin));
  assert.match(must(j.json?.reason), /the host let you in to room/, (() => { try { return fs.readFileSync(path.join(remote.home, 'links', `${code}.log`), 'utf8'); } catch (e) { return (e as Error).message; } })());
  const lf = linkFile(remote, code);
  assert.equal(lf.transport.kind, 'wss');
  assert.equal(host.lib(() => admission.pending(code)).length, 0, 'no card');
  const req = must(host.lib(() => admission.admissions(store.open(code), { all: true }))[0], 'the admission record');
  assert.deepEqual([req.key, req.admitted_by], [lf0.transport.clientKey, 'pin'], 'let in by the PIN, bound to the key it came with');
  const check = inviteSecret.joinCheck(req.machine, req.key);
  assert.match(host.log(code), new RegExp(`bob joined from \\S+ \\(${check}\\) · not them\\? /sub-human kick bob`), 'the room line names the check, with the kick');
  assert.ok(await h.until(() => linkState(remote, code) === 'online', 15_000, 50), 'online once let in');
  assert.equal(must(remote.join(bob, '').json).decision, undefined, 'a bare /sub-human takes the seat');
  const link = must(Object.values(host.lib(() => hostLinks.links(store.open(code))))[0], 'the link');
  assert.equal(link.key, lf0.transport.clientKey, 'the link is its key');
  await posts(t, R, 'over a web invite');
  const lg = fs.readFileSync(path.join(host.home, 'listen', 'listen.log'), 'utf8');
  assert.ok(!lg.includes(` ${m.pin}`) && !lg.includes(` ${bad}`) && !lg.includes(m.word), 'the listener logs no PIN or SECRET');
  assert.match(lg, new RegExp(`room ${code}: a connection from 127\\.0\\.0\\.1 \\(key [A-Za-z0-9_-]{12}…\\); serve pid \\d+`));
});

test('a web invite in one line: URL#SECRET PIN links in one hidden step; the PIN rides the first hello once the listener\'s key is checked; the host is never asked for it, and the right PIN lets the machine in with no card; the room hears its check', async t => {
  const R = await rig(t);
  const { port, host, remote, alice, bob, code } = R;
  const m = must(shortShown(must(host.join(alice, 'invite --web', { SUB_HUMAN_WEB_FRONT: `http://127.0.0.1:${port}` }).json?.reason)));
  assert.equal(m.line, `join ${m.dest}#${m.word}`);
  const typed = remote.join(bob, `${m.line} ${m.pin} --as bob`);
  assert.ok(hiddenBlock(typed), typed.stderr);
  for (const s of [m.pin, m.word]) assert.ok(!modelSees(typed).includes(s) && !must(typed.json?.reason).includes(s), 'neither the PIN nor the SECRET reaches the model, nor is echoed');
  assert.ok(await h.until(() => remote.lib(() => !!(links.get(code) || {}).token), 15_000, 50), 'the PIN came with the line: linked in its first hello');
  const lf = linkFile(remote, code);
  assert.equal(lf.transport.hostKey, host.lib(() => listener.hostKey()), 'the listener\'s key, checked against the tag and pinned');
  assert.equal('pin' in lf, false, 'the PIN left the link file once the host answered');
  assert.equal('pin_wanted' in lf, false, 'the host never asked for the PIN');
  assert.equal('awaiting' in lf, false, 'nothing waits for a card');
  assert.equal(host.lib(() => admission.pending(code)).length, 0, 'no card');
  const req = must(host.lib(() => admission.admissions(store.open(code), { all: true }))[0], 'the admission record');
  assert.deepEqual([req.key, req.admitted_by, req.name], [lf.transport.clientKey, 'pin', 'bob'], 'let in by the PIN, bound to the key it came with');
  const check = inviteSecret.joinCheck(req.machine, req.key);
  assert.match(host.log(code), new RegExp(`bob joined from \\S+ \\(${check}\\) · not them\\? /sub-human kick bob`), 'the room line names the check, with the kick');
  assert.ok(await h.until(() => linkState(remote, code) === 'online', 15_000, 50), 'online once let in');
  assert.equal(must(remote.join(bob, '').json).decision, undefined, 'a bare /sub-human takes the seat');
  const lg = fs.readFileSync(path.join(host.home, 'listen', 'listen.log'), 'utf8');
  assert.ok(!lg.includes(` ${m.pin}`) && !lg.includes(m.word), 'the listener logs no PIN or SECRET');
});

test('a web invite: a text message that is not a key request is refused; a key request gets the key', async t => {
  const R = await rig(t);
  const { port, host, alice, code } = R;
  host.join(alice, 'invite --web', { SUB_HUMAN_WEB_FRONT: `http://127.0.0.1:${port}` });
  const ask = async (text: string, p = `/sub-human/${code}`) => {
    const conn = await ws.connect(`ws://127.0.0.1:${port}${p}`, { timeoutMs: 5000 });
    return new Promise<{ code: number; got: string[] }>(r => {
      const got: string[] = [];
      conn.on('message', d => got.push(String(d)));
      conn.on('close', c => r({ code: c, got }));
      conn.send(text);
    });
  };
  const junk = await ask('hello');
  assert.match(must(junk.got[0]), /not a key request/);
  const key: unknown = JSON.parse(must((await ask(JSON.stringify({ op: 'key', v: 3 }))).got[0]));
  assert.deepEqual(key, { v: 3, key: host.lib(() => listener.hostKey()) });
});
