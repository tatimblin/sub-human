// Links over the person's own ssh login (`/sub-human join USER@HOST ROOM`): no invite, PIN or admit. Unit: the
// ssh command (BatchMode, the person's own ssh config and known_hosts, the shim named on the host), loginFailure's
// reasons, the server's login hello (only a `serve --login` session mints a link; a forced-command one never does).
// End to end over two homes (test/support/two-homes.ts) with a fake `ssh` on PATH standing in for sshd
// (test/support/fake-ssh.ts): it runs the remote command in the host user's login shell, or, like an authorized_keys
// line, a forced command with SSH_ORIGINAL_COMMAND set. Checked: the join links and seats in one step, the room hears it, kick ends it; an
// unknown host key, a missing shim and a restricted key each stop the join with what to do, and mint no link.
import type { RoomError } from '../lib/room/validate.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { TestContext } from 'node:test';
import * as h from './helpers.ts';
import * as store from '../lib/room/store.ts';
import * as linkSocket from '../lib/remote/link-socket.ts';
import * as hostLinks from '../lib/remote/host-links.ts';
import * as server from '../lib/remote/server.ts';
import * as client from '../lib/remote/client.ts';
import type { Client, ConnectOpts } from '../lib/remote/client.ts';
import type { SshSpec } from '../lib/remote/types-rest.ts';
import * as memory from '../lib/remote/transports/memory.ts';
import * as ssh from '../lib/remote/transports/ssh.ts';
import { Machine } from './support/two-homes.ts';
import { fakeSsh } from './support/fake-ssh.ts';
import * as protocolLib from '../lib/remote/protocol.ts';
import * as seatKey from '../hooks/seat-key.ts';
import { machineIn } from '../lib/home.ts';
import * as options from '../lib/room/options.ts';
import * as machineKey from '../lib/remote/machine-key.ts';
import { MemoryRoomStore } from './support/memory-store.ts';
import * as linksLib from '../lib/room/links.ts';
import type { RoomCode } from '../lib/brand.ts';
import type { Link } from '../lib/room/types.ts';
import { rc, sn, mid } from './support/brands.ts';
import { must } from './support/must.ts';

Object.assign(process.env, { SUB_HUMAN_CLAUDE: '/usr/bin/false', SUB_HUMAN_REAP_GRACE_MS: '0', SUB_HUMAN_REAP_WAIT_MS: '0' });

const LINK_ENV = { SUB_HUMAN_LINK_RETRY_MS: '300', SUB_HUMAN_LINK_IDLE_MS: '1500' };
const ID = 'abcdef012345';
const childOf = (pid: number | undefined) => Number(spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.trim().split('\n')[0]) || null;
const kill = (pid: number | null | undefined) => { try { process.kill(pid as number, 'SIGKILL'); } catch { /* gone */ } };
const stopDaemon = (t: TestContext, m: Machine, code: RoomCode) => t.after(() => {
  const d = m.lib(() => linkSocket.status(code));
  if (d.pid) { kill(childOf(d.pid)); kill(d.pid); }
  fs.rmSync(path.dirname(linkSocket.socketPath(path.join(m.home, 'rooms', code))), { recursive: true, force: true });
});
const roomLines = (m: Machine, code: RoomCode) => m.lib(() => store.open(code).readAll()).filter(e => e.from === 'room').map(e => e.text).join('\n');
const links = (m: Machine, code: RoomCode) => m.lib(() => hostLinks.links(store.open(code)));
/** A link's ssh transport, asserted (a login link is ssh). */
const sshSpec = (l: Link | null): SshSpec => {
  const tr = must(l, 'the link').transport;
  assert.ok(tr.kind === 'ssh', 'an ssh link');
  return tr;
};
/** The argv lines the fake ssh logged. */
const sshCalls = (log: string) => fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l) as string[]); // the fake's own log

/** The host (alice in a room it hosts, its shim written by that join) and a joiner whose ssh is the fake. */
function setup(t: TestContext, fake: Record<string, string> = {}, { defaultHome = true } = {}) {
  const host = new Machine(t, 'host');
  if (defaultHome) fs.symlinkSync(host.home, path.join(host.user, '.sub-human')); // ~/.sub-human on the host is its home
  const alice = host.seat('alice');
  assert.equal(must(host.join(alice, 'alice').json).decision, undefined);
  const code = must(host.lib(() => store.listRooms()[0]), 'the room');
  const sshLog = path.join(h.tmpDir('sh-sshlog-', t), 'argv.ndjson');
  const remote = new Machine(t, 'remote', {
    ...LINK_ENV, PATH: `${fakeSsh(t)}:${process.env.PATH}`, FAKE_SSH_HOME: host.user, FAKE_SSH_LOG: sshLog,
    SUB_HUMAN_SSH_OPTS: undefined, ...fake,
  });
  const bob = remote.seat('bob');
  return { host, remote, alice, bob, code, sshLog };
}

test('ssh.loginSpec / remoteCommand / command: the person\'s own ssh (BatchMode, their config and known_hosts) names the host\'s stable shim', () => {
  const spec = ssh.loginSpec('me@devbox:2222', { via: 'jump@bastion', link: ID });
  assert.deepEqual(spec, { kind: 'ssh', user: 'me', host: 'devbox', port: 2222, via: 'jump@bastion', login: true, link: ID });
  assert.equal(ssh.remoteCommand(spec, rc('vole-1234')), `"$HOME"/.sub-human/bin/serve --stdio vole-1234 --link ${ID} --login`);
  assert.equal(ssh.remoteCommand({ ...spec, remoteHome: '/srv/sh' }, rc('vole-1234')), `env SUB_HUMAN_HOME=/srv/sh /srv/sh/bin/serve --stdio vole-1234 --link ${ID} --login`);
  const admitted: SshSpec = { kind: 'ssh', user: 'me', host: 'x' };
  assert.equal(ssh.remoteCommand(admitted, rc('vole-1234')), 'sub-human serve --stdio vole-1234', 'an admitted key\'s command is unchanged');
  const cmd = ssh.command(spec, rc('vole-1234'), []);
  assert.deepEqual(cmd, ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
    '-J', 'jump@bastion', '-p', '2222', '--', 'me@devbox', `"$HOME"/.sub-human/bin/serve --stdio vole-1234 --link ${ID} --login`]);
  assert.ok(!cmd.some(a => /StrictHostKeyChecking|UserKnownHostsFile|IdentitiesOnly/.test(a)), 'normal known_hosts checking, the person\'s own keys');
  // a primed master (sub-human prime) is ridden as for any ssh link
  assert.ok(ssh.command({ ...spec, mux: true }, rc('vole-1234'), []).includes('ControlMaster=no'));
  assert.ok(ssh.primeCommand(spec, rc('vole-1234'), { opts: [] }).includes('-M'));
  assert.equal(ssh.loginCommand(spec), 'ssh -p 2222 -J jump@bastion me@devbox');
  assert.match(ssh.kind.describe(spec), /^ssh me@devbox:2222 via jump@bastion \(your ssh login\)$/);
  // nothing an option or a shell would read
  for (const bad of [['-oProxyCommand=x@y'], ['me@devbox', { via: '-oX' }], ['me@devbox', { home: 'rel/path' }], ['me@devbox', { home: '/a b' }], ['me@devbox', { home: '/a;rm' }], ['me@devbox', { link: 'XYZ' }]] as Parameters<typeof ssh.loginSpec>[]) {
    assert.equal(ssh.loginSpec(...bad), null, JSON.stringify(bad));
  }
  assert.throws(() => ssh.command({ ...spec, link: '../x' }, rc('vole-1234'), []), /link id/);
  assert.throws(() => ssh.command({ ...spec, remoteHome: '/a $(x)' }, rc('vole-1234'), []), /remote home/);
});

test('ssh.loginFailure: what only the person can fix names the exact step; anything that may pass is null', () => {
  const spec = must(ssh.loginSpec('me@devbox', { link: ID }));
  const f = (s: string) => ssh.loginFailure(s, spec, rc('vole-1234'));
  assert.match(must(f('Host key verification failed.')), /Run `ssh me@devbox` once in a terminal, check and accept the key, then join again/);
  assert.match(must(ssh.loginFailure('Host key verification failed.', { ...spec, port: 2222, via: 'b' }, rc('vole-1234'))), /`ssh -p 2222 -J b me@devbox`/);
  assert.match(must(f('me@devbox: Permission denied (publickey).')), /refused your ssh login: sub-human logs in with your ssh keys or agent only, never a password\..*run `(?:SUB_HUMAN_HOME=\S+ )?node \S+\/scripts\/sub-human prime vole-1234` in a terminal first/);
  assert.match(must(f('sh: 1: /home/me/.sub-human/bin/serve: not found')), /me@devbox isn't set up for joining yet \(no ~\/\.sub-human\/bin\/serve\)\. On that machine, open the room in Claude Code \(\/sub-human\), then join again; .*--home PATH/);
  assert.match(must(f('zsh:1: no such file or directory: /home/me/.sub-human/bin/serve')), /isn't set up for joining yet/);
  assert.match(must(ssh.loginFailure('env: /srv/sh/bin/serve: No such file or directory', { ...spec, remoteHome: '/srv/sh' }, rc('vole-1234'))), /\(no \/srv\/sh\/bin\/serve\)/);
  assert.match(must(f('no room "vole-1234"')), /room vole-1234 isn't open on me@devbox/);
  assert.match(must(f('usage: sub-human serve --stdio CODE [--link ID]')), /too old for joining over an ssh login/);
  for (const s of ['Host key verification failed.', 'me@devbox: Permission denied (publickey).', 'sh: 1: /home/me/.sub-human/bin/serve: not found']) {
    assert.doesNotMatch(must(f(s)), /BatchMode|shim|(^|[^/])sub-human (prime|doctor)/, 'no internal words, no bare CLI');
  }
  assert.match(must(f('sub-human serve --login: refused: this connection came through a forced command')), /forced command/);
  assert.equal(f('ssh: connect to host devbox port 22: Connection refused'), null);
  assert.equal(f('ssh: connect to host devbox port 22: Operation timed out'), null);
  // item 15: a name ssh cannot resolve stops a login link's first connection with ssh's own words (no retrying forever);
  // a link that connected before keeps retrying (a laptop offline resolves nothing for a while)
  const dns = 'ssh: Could not resolve hostname devbox: nodename nor servname provided, or not known';
  const first = must(ssh.loginProblem(dns, spec, rc('vole-1234'), { first: true }));
  assert.equal(first.reason, 'SSH_HOST_UNKNOWN');
  assert.match(first.message, /^ssh cannot find devbox \(Could not resolve hostname devbox: nodename nor servname provided, or not known\): check the name, or use an alias from your ~\/\.ssh\/config, then join again$/);
  assert.equal(ssh.loginProblem(dns, spec, rc('vole-1234')), null);
});

test('server: a hello {login} makes a link only in a `serve --login` session, under its --link id, once', async t => {
  h.freshHome(t);
  const code = h.newRoom();
  const host = store.open(code);
  const dial = async (ctx: { linkId?: string; login?: boolean }, opts: Omit<ConnectOpts, 'machine'>) => {
    const [a, b] = memory.pair();
    const srv = server.serve(b, { store: host, ...ctx });
    t.after(() => srv.close());
    const c = await client.connect(a, { machine: mid('remote0machine01'), ...opts });
    t.after(() => c.close());
    return c;
  };
  const authErr = (re: RegExp) => (e: Error & { code?: string }) => e.code === 'AUTH' && re.test(e.message);
  await assert.rejects(dial({ linkId: ID }, { login: true }), authErr(/did not arrive over the host account's own ssh login/));
  await assert.rejects(dial({}, { login: true }), authErr(/did not arrive over the host account's own ssh login/));
  assert.deepEqual(hostLinks.links(host), {}, 'nothing minted');
  const c = await dial({ linkId: ID, login: true }, { login: true });
  assert.equal(typeof c.token, 'string');
  assert.equal(c.link, ID);
  assert.deepEqual({ ...hostLinks.links(host)[ID], token_sha256: '-', created_at: '-' }, { id: ID, token_sha256: '-', machine: 'remote0machine01', seats: [], created_at: '-', login: true });
  assert.match(must(must(host.readAll().at(-1)).text), /^a machine linked over your SSH login$/);
  // the id is taken now: a second login hello for it is refused; the token says hello as any link's
  await assert.rejects(dial({ linkId: ID, login: true }, { login: true }), authErr(/link abcdef012345 exists already/));
  const again = await dial({ linkId: ID, login: true }, { token: must(c.token) });
  assert.equal(again.link, ID);
  // another link's token is not this session's
  await assert.rejects(dial({ linkId: '0123456789ab', login: true }, { token: must(c.token) }), authErr(/not link 0123456789ab's/));
  // an old host answers a login hello without a token: PROTOCOL, never a link with no credential
  const [a, b] = memory.pair();
  b.onFrame(f => b.send(protocol().reply(f.id, { v: 3, proto: { min: 1, max: 9 }, server: '0.4.0', caps: [], room: code, link: null })));
  await assert.rejects(client.connect(a, { machine: mid('remote0machine01'), login: true }), (e: Error & { code?: string }) => e.code === 'PROTOCOL' && /makes no link over an ssh login/.test(e.message));
});
const protocol = () => protocolLib;

test('server: a login link\'s seat is the host person\'s own only when the room says so (login-same-person); an invite\'s never', async t => {
  h.freshHome(t);
  const code = h.newRoom();
  const host = store.open(code);
  const seat = async (c: Client, name: string) => {
    const pubkey = seatKey.publicPem(code, sn(name));
    await c.join({ name, pubkey, proof: hostLinks.proveSeat(seatKey.ensure(code, sn(name)), { room: code, name, pubkey }) });
  };
  const open = async (ctx: { linkId?: string; login?: boolean }, opts: Omit<ConnectOpts, 'machine'>) => {
    const [a, b] = memory.pair();
    const srv = server.serve(b, { store: host, ...ctx });
    t.after(() => srv.close());
    const c = await client.connect(a, { machine: mid('remote0machine01'), ...opts });
    t.after(() => c.close());
    return c;
  };
  // the default: a login link's seat is its own person (on a shared login, everyone who has it would be the owner)
  await seat(await open({ linkId: ID, login: true }, { login: true }), 'laptop');
  const laptop = must(host.members.read().laptop);
  assert.deepEqual([laptop.machine, laptop.account], ['remote0machine01', undefined]);
  // the host person's option: such a seat is theirs
  assert.throws(() => options.set(new MemoryRoomStore(code, { isHost: false }), 'login-same-person', true), (e: RoomError) => e.code === 'HOST_ONLY');
  assert.throws(() => options.set(host, 'everything', true), (e: RoomError) => e.code === 'INVALID');
  options.set(host, 'login-same-person', true);
  await seat(await open({ linkId: 'aaaaaaaaaaaa', login: true }, { login: true, machineKey: machineKey.proof(code) }), 'desk'); // another machine
  const { token } = hostLinks.create(host, { id: hostLinks.newLinkId(), machine: mid('remote0machine02'), seats: [] });
  await seat(await open({}, { token }), 'guest');
  const ms = host.members.read();
  const guest = must(ms.guest);
  assert.deepEqual([must(ms.desk).account], [machineIn(code)]);
  assert.deepEqual([guest.machine, guest.account], ['remote0machine02', undefined], 'over an invite: never');
  options.set(host, 'login-same-person', false);
  assert.deepEqual(options.get(host), {});
});

test('server: a hello\'s machine key gives the id the host records; one only reported may not be the host\'s or another link\'s', async t => {
  h.freshHome(t);
  const code = h.newRoom();
  const host = store.open(code);
  const serveLogin = async (id: string, opts: Partial<ConnectOpts>) => {
    const [a, b] = memory.pair();
    const srv = server.serve(b, { store: host, linkId: id, login: true });
    t.after(() => srv.close());
    return client.connect(a, { machine: mid('remote0machine01'), login: true, ...opts });
  };
  // a key proof: the id is the key's, the reported one only its label; the reply says it
  const proof = machineKey.proof(code);
  const c1 = await serveLogin('aaaaaaaaaaa1', { machineKey: proof });
  assert.equal(c1.machine, machineKey.idOf(proof.key));
  const l1 = must(hostLinks.links(host).aaaaaaaaaaa1);
  assert.deepEqual([l1.machine, l1.label], [machineKey.idOf(proof.key), 'remote0machine01']);
  c1.close();
  // a forged proof is no proof: the reported id, checked
  await assert.rejects(serveLogin('aaaaaaaaaaa2', { machine: must(machineIn(code)), machineKey: { ...proof, sig: proof.sig.replace(/^./, ch => (ch === 'A' ? 'B' : 'A')) } }), (e: RoomError) => e.code === 'AUTH' && e.reason === 'MACHINE_TAKEN');
  // only reported: the host's own id, or another link's, is refused
  await assert.rejects(serveLogin('aaaaaaaaaaa3', { machine: must(machineIn(code)) }), (e: RoomError) => e.reason === 'MACHINE_TAKEN');
  const c4 = await serveLogin('aaaaaaaaaaa4', { machine: mid('remote0machine09') });
  assert.equal(c4.machine, 'remote0machine09');
  c4.close();
  await assert.rejects(serveLogin('aaaaaaaaaaa5', { machine: mid('remote0machine09') }), (e: RoomError) => e.reason === 'MACHINE_TAKEN');
  assert.equal(machineKey.verify({ ...proof, ts: proof.ts - 60 * 60_000 }, code), null, 'an old proof');
  assert.equal(machineKey.verify(proof, rc('vole-9999')), null, 'another room\'s');
});

test('serve CLI: --login needs --link, and is refused under SSH_ORIGINAL_COMMAND (a forced command), before any frame', t => {
  h.freshHome(t);
  const code = h.newRoom();
  const run = (args: string[], env: Record<string, string | undefined> = {}) => spawnSync(process.execPath, [h.BIN, 'serve', '--stdio', code, ...args], { input: '', encoding: 'utf8', env: h.childEnv({ SUB_HUMAN_HOME: process.env.SUB_HUMAN_HOME, ...env }) });
  assert.match(run(['--login']).stderr, /--login: names no --link ID/);
  const forced = run(['--link', ID, '--login'], { SSH_ORIGINAL_COMMAND: 'anything' });
  assert.equal(forced.status, 1);
  assert.match(forced.stderr, /refused: this connection came through a forced command/);
  assert.equal(run(['--link', ID, '--login'], { SSH_ORIGINAL_COMMAND: undefined }).status, 0, 'stdin ends: it exits cleanly');
});

test('login e2e: join me@devbox ROOM links over the person\'s own ssh and takes the seat in one step; the room hears it; kick ends it', async t => {
  const { host, remote, alice, bob, code, sshLog } = setup(t);
  assert.ok(fs.existsSync(path.join(host.home, 'bin', 'serve')), 'the host\'s join wrote the serve shim');
  const r = remote.join(bob, `join me@devbox ${code} --as bob`);
  stopDaemon(t, remote, code);
  assert.equal(must(r.json).decision, undefined, must(r.json).reason || r.stderr);
  assert.match(must(must(must(r.json).hookSpecificOutput).additionalContext), /SUB-HUMAN: you are bob's Claude/);
  const lf = must(remote.lib(() => linksLib.get(code)));
  assert.equal(sshSpec(lf).login, true);
  assert.equal(typeof lf.token, 'string');
  assert.equal(lf.invite, undefined);
  const id = must(sshSpec(lf).link);
  assert.deepEqual(Object.keys(links(host, code)), [id]);
  assert.deepEqual(must(links(host, code)[id]).seats, ['bob']);
  assert.match(roomLines(host, code), /^a machine linked over your SSH login$/m, 'a link, not a join: no second joined line');
  assert.ok(!roomLines(host, code).includes(id), 'no internal id');
  assert.doesNotMatch(roomLines(host, code), /joined over your ssh login/);
  const argv = must(sshCalls(sshLog)[0], 'an ssh call');
  assert.ok(argv.includes('BatchMode=yes') && !argv.some(a => /StrictHostKeyChecking/.test(a)));
  assert.equal(argv.at(-1), `"$HOME"/.sub-human/bin/serve --stdio ${code} --link ${id} --login`);

  assert.equal(must(remote.say(bob, 'hello over my login').json).continue, false);
  assert.equal(must(host.lib(() => store.open(code).readAll()).at(-1)).text, 'hello over my login');
  assert.equal(remote.log(code), host.log(code));
  // joining the same way again is just the seat (no new link)
  assert.equal(must(remote.join(bob, `join me@devbox ${code} --as bob`).json).decision, undefined);
  assert.deepEqual(Object.keys(links(host, code)), [id]);

  // kick by name: the token goes, bob leaves, its serve is stopped, the daemon stops with the reason
  const rv = host.join(alice, 'kick bob');
  assert.match(must(must(rv.json).reason), new RegExp(`bob is out of room ${code}: it no longer reaches the room\\. It came over an ssh login to this account, which can join again`));
  assert.deepEqual(links(host, code), {});
  await h.until(() => remote.lib(() => linkSocket.status(code)).state === 'stopped', 10_000);
  assert.match(must(remote.lib(() => linkSocket.status(code)).reason), /removed this machine/);
  // that login can link again: a new link, and bob's seat joins again over it
  const again = remote.join(bob, `join me@devbox ${code} --as bob`);
  assert.equal(must(again.json).decision, undefined, must(again.json).reason);
  const id2 = must(sshSpec(remote.lib(() => linksLib.get(code))).link);
  assert.notEqual(id2, id);
  assert.deepEqual(Object.keys(links(host, code)), [id2]);
  assert.deepEqual(must(links(host, code)[id2]).seats, ['bob']);
  assert.equal(must(remote.say(bob, 'back over a new link').json).continue, false);
  assert.equal(must(host.lib(() => store.open(code).readAll()).at(-1)).text, 'back over a new link');
});

test('login e2e: a bare ssh alias (join dev ROOM) takes its user from ssh -G and keeps the alias as the host; YOU@ is named as a placeholder', t => {
  const { remote, bob, code, sshLog } = setup(t);
  const r = remote.join(bob, `join dev ${code} --as bob`);
  stopDaemon(t, remote, code);
  assert.equal(must(r.json).decision, undefined, must(r.json).reason || r.stderr);
  const lf = must(remote.lib(() => linksLib.get(code)));
  const spec = sshSpec(lf);
  assert.deepEqual([spec.user, spec.host, spec.login], ['me', 'dev', true], 'the alias stays the host: its HostName, Port, ProxyJump apply');
  const argv = must(sshCalls(sshLog).find(a => a[0] !== '-G'), 'the link\'s ssh call');
  assert.ok(argv.includes('me@dev'), JSON.stringify(argv));
  const you = remote.join(bob, `join YOU@dev ${code} --as bob`);
  assert.match(must(must(you.json).reason), /"YOU@dev" still has the example's placeholder: put your user name on that machine in place of YOU \(or just its ssh alias, e\.g\. dev\)/);
  assert.match(must(must(remote.join(bob, 'join dev').json).reason), /which room/, 'an alias without a room is not a login join');
});

test('ssh.withUser / placeholder: only a bare alias is expanded; no ssh or a bad answer leaves it as typed', () => {
  assert.equal(ssh.withUser('me@dev'), 'me@dev');
  assert.equal(ssh.withUser('dev', { bin: '/nonexistent/ssh' }), 'dev');
  assert.equal(ssh.withUser('bad;host'), 'bad;host');
  // SUB_HUMAN_SSH_OPTS (opts) go before -G: a -F config there names the alias's User
  const cfg = path.join(h.tmpDir('sh-sshcfg-'), 'config');
  fs.writeFileSync(cfg, 'Host devbox\n  HostName 127.0.0.1\n  User someone\n');
  if (spawnSync('ssh', ['-G', 'x'], { stdio: 'ignore' }).status === 0) assert.equal(ssh.withUser('devbox', { opts: ['-F', cfg] }), 'someone@devbox');
  assert.equal(ssh.placeholder('YOU@dev'), true);
  assert.equal(ssh.placeholder('yousef@dev'), false);
});

test('login e2e: --home names a host home that is not ~/.sub-human; a primed (mux) link keeps riding its master on a re-join', t => {
  const { host, remote, bob, code, sshLog } = setup(t, {}, { defaultHome: false });
  const miss = remote.join(bob, `join me@devbox ${code} --as bob`);
  stopDaemon(t, remote, code);
  assert.equal(must(miss.json).decision, 'block');
  assert.match(must(must(miss.json).reason), /could not reach room .* over ssh me@devbox \(your ssh login\): me@devbox isn't set up for joining yet \(no ~\/\.sub-human\/bin\/serve\)\. On that machine, open the room in Claude Code \(\/sub-human\), then join again; if its sub-human folder is somewhere else, add --home PATH/);
  assert.deepEqual(links(host, code), {}, 'nothing minted');
  // as `sub-human prime CODE` leaves it: the link rides a master; the re-join to the same destination keeps that
  remote.lib(() => { const l = must(linksLib.get(code)); linksLib.set(code, { ...l, transport: { ...sshSpec(l), mux: true } }); });
  const r = remote.join(bob, `join me@devbox ${code} --as bob --home ${host.home}`);
  assert.equal(must(r.json).decision, undefined, must(r.json).reason || r.stderr);
  assert.equal(sshSpec(remote.lib(() => linksLib.get(code))).mux, true);
  const argv = must(sshCalls(sshLog).at(-1), 'the last ssh call');
  assert.ok(argv.includes('ControlMaster=no'), 'the daemon rides the master, never becomes one');
  assert.match(must(argv.at(-1)), new RegExp(`^env SUB_HUMAN_HOME=${host.home.replace(/[.]/g, '\\.')} .*/bin/serve --stdio ${code} --link [0-9a-f]{12} --login$`));
  assert.equal(Object.keys(links(host, code)).length, 1);
});

test('login e2e: an unknown host key fails at once with the exact ssh to run once; a refused login names BatchMode; neither mints a link', t => {
  const a = setup(t, { FAKE_SSH_FAIL: 'hostkey' });
  const t0 = Date.now();
  const r = a.remote.join(a.bob, `join me@devbox:2222 ${a.code} --as bob --via jump@bastion`);
  stopDaemon(t, a.remote, a.code);
  assert.equal(must(r.json).decision, 'block');
  assert.match(must(must(r.json).reason), /ssh doesn't know me@devbox's host key yet \(or it changed\), and sub-human never answers ssh's questions\. Run `ssh -p 2222 -J jump@bastion me@devbox` once in a terminal/);
  assert.ok(Date.now() - t0 < 5000, 'no wait for the join timeout');
  assert.deepEqual(links(a.host, a.code), {});
  // a later /sub-human NAME CODE (after the person accepted the key) dials again; here it is still refused, and says so
  assert.match(must(must(a.remote.join(a.bob, `bob ${a.code}`).json).reason), /host key/);

  const b = setup(t, { FAKE_SSH_FAIL: 'denied' });
  const d = b.remote.join(b.bob, `join me@devbox ${b.code} --as bob`);
  stopDaemon(t, b.remote, b.code);
  assert.match(must(must(d.json).reason), /me@devbox refused your ssh login: sub-human logs in with your ssh keys or agent only, never a password/);
  // no SECRET is the login path, said so: a person who lost an invite line's SECRET learns where it goes
  assert.match(must(must(d.json).reason), new RegExp(`No invite, so this went over your own ssh login; if the host sent you an invite line, it ends with a long SECRET: /sub-human join me@devbox ${b.code} SECRET$`));
});

test('login e2e: a pass-through forced command cannot use the login path', t => {
  const s = setup(t);
  // a forced command that passes the asked-for command through (sshd still sets SSH_ORIGINAL_COMMAND): refused
  const r2 = new Machine(t, 'passthru', { ...LINK_ENV, PATH: `${fakeSsh(t)}:${process.env.PATH}`, FAKE_SSH_HOME: s.host.user, FAKE_SSH_FORCED: 'eval "$SSH_ORIGINAL_COMMAND"' });
  const dan = r2.seat('dan');
  const j2 = r2.join(dan, `join me@devbox ${s.code} --as dan`);
  stopDaemon(t, r2, s.code);
  assert.match(must(must(j2.json).reason), /refused: this connection came through a forced command \(a restricted ssh key or ForceCommand\), not your own ssh login/);
  assert.deepEqual(links(s.host, s.code), {}, 'no link was minted');
  assert.doesNotMatch(roomLines(s.host, s.code), /linked over your SSH login/);
});

test('login join: the argument forms are told apart; bad parts are refused before anything is written', t => {
  const { remote, bob, code } = setup(t);
  const bad = (args: string, re: RegExp) => { const r = remote.join(bob, args); assert.equal(must(r.json).decision, 'block', args); assert.match(must(must(r.json).reason), re, args); };
  bad(`join me@devbox --as bob`, /which room/);
  bad(`join me@devbox ${code} extra --as bob`, /the line's SECRET \(its last long word\) did not come through whole/);
  bad(`join me@devbox ${code} 4829 --as bob`, /that invite line comes from an older sub-human on the host \(a 4-digit PIN where the line's SECRET goes\): ask the host to update/);
  bad(`join me@devbox not-a-code --as bob`, /"not-a-code" isn't a room/);
  bad(`join -oProxyCommand=x@y ${code} --as bob`, /isn't a plain USER@HOST/);
  bad(`join me@devbox ${code} --as bob --via -oX`, /--via "-oX" isn't a plain/);
  bad(`join me@devbox ${code} --as bob --home relative`, /--home "relative" isn't a plain absolute path/);
  bad(`join me@devbox ${code} --as claude`, /"claude" is reserved/);
  assert.equal(remote.lib(() => linksLib.list()).length, 0);
});
