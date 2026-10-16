// 1.1 end to end on one machine, two homes (test/support/two-homes.ts): the host's `/sub-human invite --url` starts the
// listener (127.0.0.1 only) and shows a join URL + SECRET and the PIN apart, to the person only; the joiner's
// `/sub-human join URL SECRET` asks the listener for its key, checks it against the line's tag, pins it, and runs Noise
// XK with a key of the link's own; the host asks for the PIN, `/sub-human join PIN` gives it, and the host's card lets
// the machine in; a bare /sub-human takes the seat; posts flow and the mirror converges. A wrong PIN costs a try. The link daemon's reconnect
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
import { Machine, shownInvite } from './support/two-homes.ts';
import type { MachineRun, Seat } from './support/two-homes.ts';
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
const childOf = (pid: number) => Number(spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.trim().split('\n')[0]) || null;
const kill = (pid: number | null) => { try { process.kill(pid as number, 'SIGKILL'); } catch { /* gone (or no child: null throws too) */ } };
const freePort = () => new Promise<number>(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });
const hiddenBlock = (r: MachineRun) => r.json && r.json.decision === 'block' && r.json.hookSpecificOutput && r.json.hookSpecificOutput.suppressOriginalPrompt === true;
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

/** The join request's card on the host, answered by the person (hooks/handlers/consent.ts), as in test/remote-short.node-test.ts. */
// the card the hooks built (consent's PreToolUse updatedInput)
interface Card { questions: { question: string }[] }

function letIn(host: Machine, alice: Seat, ref: string, label = 'Let in') {
  const pre = host.hook('consent', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: `admit ${ref}`, options: [] }] } }, alice);
  const c = must(pre.json?.hookSpecificOutput).updatedInput as Card;
  return host.hook('consent', { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: c, tool_response: { questions: c.questions, answers: { [must(c.questions[0]).question]: label } } }, alice);
}
const shortShown = (reason: string | undefined) => shownInvite(String(reason));
/** bob joins with the line the host was shown: the key check and the SECRET, the PIN when asked, the host's card, the
 * link online, a bare /sub-human. */
async function webJoin({ host, remote, alice, bob, code }: Rig, reason: string | undefined) {
  const m = shortShown(reason);
  assert.ok(m, reason);
  remote.join(bob, `${m.line} --as bob`);
  const logOf = () => { try { return fs.readFileSync(path.join(remote.home, 'links', `${code}.log`), 'utf8'); } catch (e) { return (e as Error).message; } };
  assert.ok(await h.until(() => remote.lib(() => !!(links.get(code) || {}).pin_wanted), 15_000, 50), `the host asks for the PIN: ${logOf()}`);
  const j = remote.join(bob, `join ${m.pin}`);
  assert.match(must(j.json?.reason), /checked your PIN/, logOf());
  const lf = linkFile(remote, code);
  letIn(host, alice, must(lf.awaiting).ref);
  assert.ok(await h.until(() => linkState(remote, code) === 'online', 15_000, 50), 'online once let in');
  assert.equal(must(remote.join(bob, '').json).decision, undefined);
  return m;
}


test('wss 1.1: the listener gives its key to a text request, answers an old joiner\'s PIN with the skew; refuses a handshake to another key, a room it does not serve, and plain HTTP; XK proves the link\'s own key, NK still works for an old link', async t => {
  const R = await rig(t);
  const { port, host, alice, code } = R;
  assert.ok(shortShown(must(host.join(alice, `invite --url http://127.0.0.1:${port}`).json?.reason)));
  const pinned = Buffer.from(host.lib(() => listener.hostKey()), 'base64url');
  assert.equal(fs.statSync(path.join(host.home, 'listen', 'host-x25519.json')).mode & 0o777, 0o600);
  const ss = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout;
  if (ss) assert.match(ss, /127\.0\.0\.1:\d+ \(LISTEN\)/, 'loopback only');
  // the key, for an invite line's first dial (it checks it against the line's tag)
  assert.equal(await wsT.fetchKey({ kind: 'ws', host: '127.0.0.1', port, path: `/sub-human/${code}` }), pinned.toString('base64url'));
  // a joiner pinning another key: message 2 cannot come (the listener cannot read message 1), XK or NK
  for (const s of [null, noise.generateKeyPair()]) {
    const c1 = await ws.connect(`ws://127.0.0.1:${port}/sub-human/${code}`);
    await assert.rejects(wsT.clientChannel(c1, { rs: noise.generateKeyPair().pub, code, s }), (e: Error & { code?: string }) => e.code === 'OFFLINE' && /closed \(4401/.test(e.message));
  }
  // a room not served over the web here: refused inside the channel (authenticated by the pinned key)
  const c2 = await ws.connect(`ws://127.0.0.1:${port}/sub-human/vole-0001`);
  await assert.rejects(wsT.clientChannel(c2, { rs: pinned, code: rc('vole-0001'), s: noise.generateKeyPair() }), (e: Error & { code?: string }) => e.code === 'OFFLINE' && /not open for joins over the web/.test(e.message));
  // a path for one room, a handshake for another
  const c3 = await ws.connect(`ws://127.0.0.1:${port}/sub-human/${code}`);
  await assert.rejects(wsT.clientChannel(c3, { rs: pinned, code: rc('vole-0001') }), /this URL is for room/);
  // XK and NK both get through to serve: the log says which (the key XK proved, or protocol 2)
  const mine = noise.generateKeyPair();
  for (const s of [mine, null]) {
    const c = await ws.connect(`ws://127.0.0.1:${port}/sub-human/${code}`);
    const d = await wsT.clientChannel(c, { rs: pinned, code, s });
    d.destroy();
  }
  const lg = await h.until(() => { const x = fs.readFileSync(path.join(host.home, 'listen', 'listen.log'), 'utf8'); return /\(protocol 2\)/.test(x) && x; }, 5000, 50);
  assert.ok(lg && lg.includes(`(key ${mine.pub.toString('base64url').slice(0, 12)}…)`), String(lg));
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
  const m = await webJoin(R, must(host.join(alice, `invite --url https://localhost:${frontPort}`).json?.reason));
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

test('a web invite: invite --url shows URL + SECRET and the PIN apart (no #, no NAME); the line\'s tag names the listener\'s key, checked before the Noise handshake; XK with a key of the link\'s own, through a TLS front; the card lets the machine in', { skip: spawnSync('openssl', ['version']).status !== 0 && 'no openssl' }, async t => {
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
  const out = host.join(alice, `invite --url https://localhost:${frontPort}`);
  assert.equal(must(out.json).systemMessage, undefined, 'the SECRET and the PIN stay off Remote Control');
  const st = host.lib(() => listener.status());
  assert.ok(st.running && st.port === port && st.rooms[code], JSON.stringify(st));
  assert.ok(hiddenBlock(out), out.stderr);
  const m = shortShown(must(out.json?.reason));
  assert.ok(m, must(out.json?.reason));
  assert.equal(m.dest, `https://localhost:${frontPort}/sub-human/${code}`, 'the URL alone: no fragment, no key');
  assert.equal(m.line, `join ${m.dest} ${m.word}`);
  assert.doesNotMatch(must(out.json?.reason), /#/);
  const d = must(inviteSecret.decode(m.word));
  assert.ok(inviteSecret.keyHolds(d, 'listener', host.lib(() => listener.hostKey())), 'the tag names the listener\'s key');
  // a wrong PIN first: one try, and the room hears it
  remote.join(bob, `${m.line} --as bob`);
  assert.ok(await h.until(() => remote.lib(() => !!(links.get(code) || {}).pin_wanted), 15_000, 50), 'the host asks for the PIN');
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
  assert.match(must(j.json?.reason), /checked your PIN/, (() => { try { return fs.readFileSync(path.join(remote.home, 'links', `${code}.log`), 'utf8'); } catch (e) { return (e as Error).message; } })());
  const lf = linkFile(remote, code);
  assert.equal(lf.transport.kind, 'wss');
  const req = must(host.lib(() => admission.find(code, must(lf.awaiting).ref)));
  assert.equal(req.key, lf0.transport.clientKey, 'the request is bound to the key the PIN came with');
  assert.match(must(letIn(host, alice, must(lf.awaiting).ref).json?.hookSpecificOutput?.additionalContext), /let bob's machine into room/);
  assert.ok(await h.until(() => linkState(remote, code) === 'online', 15_000, 50), 'online once let in');
  assert.equal(must(remote.join(bob, '').json).decision, undefined, 'a bare /sub-human takes the seat');
  const link = must(Object.values(host.lib(() => hostLinks.links(store.open(code))))[0], 'the link');
  assert.equal(link.key, lf0.transport.clientKey, 'the link is its key');
  await posts(t, R, 'over a web invite');
  const lg = fs.readFileSync(path.join(host.home, 'listen', 'listen.log'), 'utf8');
  assert.ok(!lg.includes(` ${m.pin}`) && !lg.includes(` ${bad}`) && !lg.includes(m.word), 'the listener logs no PIN or SECRET');
  assert.match(lg, new RegExp(`room ${code}: a connection from 127\\.0\\.0\\.1 \\(key [A-Za-z0-9_-]{12}…\\); serve pid \\d+`));
});

test('a web invite: a 0.5.0-beta.15 joiner\'s PIN attempt is told it must update; a text message that is not a key request is refused', async t => {
  const R = await rig(t);
  const { port, host, alice, code } = R;
  host.join(alice, `invite --url http://127.0.0.1:${port}`);
  const ask = async (text: string, p = `/sub-human/${code}`) => {
    const conn = await ws.connect(`ws://127.0.0.1:${port}${p}`, { timeoutMs: 5000 });
    return new Promise<{ code: number; got: string[] }>(r => {
      const got: string[] = [];
      conn.on('message', d => got.push(String(d)));
      conn.on('close', c => r({ code: c, got }));
      conn.send(text);
    });
  };
  const old = await ask(JSON.stringify({ id: 1, op: 'enroll.start', params: { v: 1, room: code } }));
  const e = JSON.parse(must(old.got[0])) as { id: number; error: { code: string; reason: string; message: string } };
  assert.deepEqual([e.id, e.error.code, e.error.reason], [1, 'PROTOCOL', 'SKEW']);
  assert.match(e.error.message, /^host runs sub-human \S+ \(protocol 1–3\); you run an older sub-human \(protocol 1–2\) \(this needs protocol 3\)\. Update your plugin: \/plugin update sub-human$/);
  const junk = await ask('hello');
  assert.match(must(junk.got[0]), /not a key request/);
  const key: unknown = JSON.parse(must((await ask(JSON.stringify({ op: 'key', v: 3 }))).got[0]));
  assert.deepEqual(key, { v: 3, key: host.lib(() => listener.hostKey()) });
});
