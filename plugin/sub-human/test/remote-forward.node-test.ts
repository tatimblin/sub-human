// #27: a join over the joiner's own ssh login to the host machine, not the host's account. The host's
// `/sub-human invite --forward` serves the room on its web listener (127.0.0.1 only) and shows
// `/sub-human join HOST ROOM SECRET --forward PORT`; the joiner's link rides `ssh -W 127.0.0.1:PORT` (a fake ssh on PATH
// that forwards stdio to that port) with the web link's key check, PIN and Noise XK on top. Also: what ssh's refusals
// say, a port squatted by someone else (the key the line names is not there: nothing secret goes), and the argv.
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type http from 'node:http';
import * as h from './helpers.ts';
import * as store from '../lib/room/store.ts';
import * as linkSocket from '../lib/remote/link-socket.ts';
import * as listener from '../lib/remote/listener.ts';
import * as links from '../lib/room/links.ts';
import * as ws from '../lib/remote/ws.ts';
import * as noise from '../lib/remote/noise.ts';
import * as sshT from '../lib/remote/transports/ssh.ts';
import { Machine, shownInvite, childOf, kill, hiddenBlock } from './support/two-homes.ts';
import { fakeSsh } from './support/fake-ssh.ts';
import { rc } from './support/brands.ts';
import { must } from './support/must.ts';

const LINK_ENV: Record<string, string> = { SUB_HUMAN_LINK_RETRY_MS: '200', SUB_HUMAN_LINK_RETRY_MAX_MS: '600', SUB_HUMAN_LINK_IDLE_MS: '20000' };
const freePort = () => new Promise<number>(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const a = s.address(); s.close(() => r(a && typeof a === 'object' ? a.port : 0)); }); });

async function rig(t: TestContext, fake: Record<string, string> = {}) {
  const port = await freePort();
  const sshLog = path.join(h.tmpDir('sh-sshlog-', t), 'ssh.log');
  const host = new Machine(t, 'host', { SUB_HUMAN_LISTEN_PORT: String(port), SUB_HUMAN_SSH_ADDR: 'alice@devbox' });
  const remote = new Machine(t, 'remote', { ...LINK_ENV, PATH: `${fakeSsh(t)}:${process.env.PATH}`, FAKE_SSH_LOG: sshLog, SUB_HUMAN_SSH_OPTS: undefined, ...fake });
  const alice = host.seat('alice'), bob = remote.seat('bob');
  assert.equal(must(host.join(alice, 'alice').json).decision, undefined);
  const code = must(host.lib(() => store.listRooms()[0]), 'the room');
  t.after(() => {
    host.lib(() => listener.stop());
    const d = remote.lib(() => linkSocket.status(code));
    if (d.pid) { kill(childOf(d.pid)); kill(d.pid); }
    fs.rmSync(path.dirname(linkSocket.socketPath(path.join(remote.home, 'rooms', code))), { recursive: true, force: true });
  });
  return { port, host, remote, alice, bob, code, sshLog };
}

const linkState = (m: Machine, code: ReturnType<typeof rc>) => m.lib(() => linkSocket.status(code).state);

test('forward: the line names the machine and the port, no account; the joiner\'s own login carries the web link; the PIN lets it in; posts flow; a listener restart redials', async t => {
  const { port, host, remote, alice, bob, code, sshLog } = await rig(t);
  const out = host.join(alice, 'invite --forward');
  assert.ok(hiddenBlock(out), out.stderr);
  const shown = must(out.json?.reason);
  const m = must(shownInvite(shown), shown);
  assert.equal(m.line, `join devbox ${code} ${m.word} --forward ${port}`, 'the host name with no user, and the listener\'s port');
  assert.match(shown, /over their own ssh login to devbox/);
  assert.match(shown, /They log in to devbox as themselves .*nothing is installed for them\. Their ssh must be allowed to forward ports/);
  assert.equal(host.lib(() => listener.status()).rooms[code]?.mode, 'ssh-forward');

  const typed = remote.join(bob, `${m.line} ${m.pin} --as bob`);
  assert.ok(hiddenBlock(typed), typed.stderr);
  await h.until(() => remote.lib(() => (links.get(code) || {}).token), 15_000, 50);
  const lf = must(remote.lib(() => links.get(code)));
  const tr = lf.transport;
  assert.ok(tr.kind === 'ws');
  assert.deepEqual([tr.host, tr.port, tr.path, tr.tunnel], ['127.0.0.1', port, `/sub-human/${code}`, { user: 'me', host: 'devbox' }], 'the joiner\'s own user (ssh -G), the room\'s path on loopback');
  assert.equal(tr.hostKey, host.lib(() => listener.hostKey()), 'the listener\'s key, pinned');
  assert.equal(lf.invite, undefined, 'the SECRET is spent');
  const runs = fs.readFileSync(sshLog, 'utf8').trim().split('\n').map(l => { const v: unknown = JSON.parse(l); return Array.isArray(v) ? v.map(String) : []; }).filter(a => a.includes('-W'));
  assert.ok(runs.length >= 2, 'the key fetch and the link');
  for (const a of runs) {
    assert.deepEqual(a.slice(a.indexOf('-W')), ['-W', `127.0.0.1:${port}`, '--', 'me@devbox'], 'always loopback, no remote command');
    assert.ok(a.includes('BatchMode=yes'));
  }
  assert.ok(await h.until(() => linkState(remote, code) === 'online', 15_000, 50), 'online');
  assert.equal(must(remote.join(bob, '').json).decision, undefined, 'the seat');
  const r = remote.say(bob, 'hello over my own login');
  assert.equal(r.json && r.json.continue, false, JSON.stringify(r.json) + r.stderr);
  assert.ok(host.lib(() => store.open(code).readAll()).some(e => e.text === 'hello over my own login'));
  await h.until(() => remote.log(code) === host.log(code), 8000, 50);
  assert.equal(remote.log(code), host.log(code), 'the mirror is byte-identical');

  // the listener restarts: the link redials over a new ssh -W
  host.lib(() => listener.stop());
  // each redial spawns an ssh, so the link shows 'connecting' (a dial in flight) as often as 'offline'
  assert.ok(await h.until(() => linkState(remote, code) !== 'online', 8000, 50), 'down once the listener is gone (ssh exits: the stream ends)');
  host.lib(() => listener.start({ port }));
  assert.ok(await h.until(() => linkState(remote, code) === 'online', 10_000, 50), 'online again');
});

test('forward: an sshd that forwards nothing stops the join with what to ask for; no try is spent', async t => {
  const { host, remote, alice, bob } = await rig(t, { FAKE_SSH_FAIL: 'noforward' });
  const m = must(shownInvite(must(host.join(alice, 'invite --forward').json?.reason)));
  const r = remote.join(bob, `${m.line} ${m.pin} --as bob`);
  assert.match(must(r.json?.reason), /could not join room \S+: devbox's sshd doesn't let me@devbox forward ports \(its AllowTcpForwarding or DisableForwarding\)/);
});

test('forward: someone else on the host machine holding the port gets nothing secret (the key the line names is not theirs)', async t => {
  const { port, host, remote, alice, bob, code } = await rig(t);
  const m = must(shownInvite(must(host.join(alice, 'invite --forward').json?.reason)));
  host.lib(() => listener.stop());
  const heard: string[] = [];
  const squat = await new Promise<http.Server>(ok => {
    void ws.createServer({ port, onConnection: c => c.on('message', (d: Buffer, binary: boolean) => {
      heard.push(binary ? '(binary)' : d.toString());
      if (!binary) c.send(JSON.stringify({ v: 3, key: noise.generateKeyPair().pub.toString('base64url') }));
    }) }).then(ok);
  });
  t.after(() => squat.close());
  remote.join(bob, `${m.line} ${m.pin} --as bob`);
  await h.until(() => remote.lib(() => (links.get(code) || {}).refused), 15_000, 50);
  assert.match(must(remote.lib(() => links.get(code))?.refused).reason, /the web listener's key \(\S+…\) is not the one the invite line names.*Nothing secret was sent/);
  assert.deepEqual(heard, [JSON.stringify({ op: 'key', v: 3 })], 'only the key request reached it');
});

test('forward: argv, ssh\'s words, and the join\'s refusals', async t => {
  assert.deepEqual(sshT.forwardCommand({ user: 'bob', host: 'devbox', port: 2222 }, 7420, []),
    ['ssh', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', '-o', 'LogLevel=INFO', '-W', '127.0.0.1:7420', '-p', '2222', '--', 'bob@devbox']);
  assert.throws(() => sshT.forwardCommand({ user: '-oProxyCommand=x', host: 'devbox' }, 7420, []), /not a plain/);
  assert.throws(() => sshT.forwardCommand({ user: 'bob', host: 'devbox' }, 70000, []), /no port/);
  assert.equal(sshT.classify('channel 0: open failed: administratively prohibited: open failed\r\nstdio forwarding failed')?.kind, 'forward-refused');
  assert.equal(sshT.classify('channel 0: open failed: connect failed: Connection refused\r\nstdio forwarding failed')?.kind, 'forward-unreached');
  // below LogLevel INFO OpenSSH says only this (checked on the Docker lab's real sshd): no reason, so it may pass
  assert.equal(sshT.classify('stdio forwarding failed\r\n')?.kind, 'forward-unreached');
  const d = { user: 'bob', host: 'devbox' }, code = rc('vole-1234');
  assert.equal(sshT.forwardProblem('channel 0: open failed: administratively prohibited: open failed', d, 7420, code)?.reason, 'SSH_FORWARD_REFUSED');
  const un = must(sshT.forwardProblem('channel 0: open failed: connect failed: Connection refused', d, 7420, code));
  assert.equal(un.code, 'OFFLINE', 'nothing listening may pass: the link retries');
  assert.equal(sshT.forwardProblem('bob@devbox: Permission denied (publickey).', d, 7420, code)?.reason, 'SSH_DENIED');
  assert.equal(sshT.forwardProblem('Host key verification failed.', d, 7420, code)?.reason, 'SSH_HOST_KEY');

  const { remote, bob, code: room } = await rig(t);
  const word = 'a'.repeat(39);
  for (const [line, re] of [
    [`join devbox ${room} ${word} --forward 0`, /isn't a port/],
    [`join devbox ${room} ${word} --forward 7420 --home /x`, /--home goes with a login to the host's own account/],
    [`join https://devbox/sub-human/${room} ${word} --forward 7420`, /goes with the host machine's name/],
    [`join devbox ${room} --forward 7420`, /usage: \/sub-human join HOST ROOM SECRET --forward PORT/],
  ] as const) {
    const r = remote.join(bob, line);
    assert.match(must(r.json?.reason, line), re, line);
  }
});

test('forward: invite --forward goes alone; the ssh login\'s missing shim points to it', async t => {
  const { host, alice } = await rig(t);
  assert.match(must(host.join(alice, 'invite --forward --web').json?.reason), /pick one way at a time/);
  const why = must(sshT.loginProblem('sh: /home/bob/.sub-human/bin/serve: not found', { kind: 'ssh', user: 'bob', host: 'devbox', login: true, link: 'aaaaaaaaaaaa' }, rc('vole-1234')));
  assert.equal(why.reason, 'SSH_NO_SHIM');
  assert.match(why.message, /If the room is in someone else's account on devbox, you can't join through theirs: ask them for \/sub-human invite --forward/);
});
