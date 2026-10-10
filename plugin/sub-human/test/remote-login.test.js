'use strict';
// Links over the person's own ssh login (`/sub-human join NAME USER@HOST CODE`): no invite, PIN or admit. Unit: the
// ssh command (BatchMode, the person's own ssh config and known_hosts, the shim named on the host), loginFailure's
// reasons, the server's login hello (only a `serve --login` session mints a link; a forced-command one never does).
// End to end over two homes (test/support/two-homes.js) with a fake `ssh` on PATH standing in for sshd: it runs the
// remote command in the host user's login shell, or, like an authorized_keys line, a forced command with
// SSH_ORIGINAL_COMMAND set. Checked: the join links and seats in one step, the room hears it, revoke ends it; an
// unknown host key, a missing shim and a restricted key each stop the join with what to do, and mint no link.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./helpers.js');
const store = require(path.join(h.LIB, 'room', 'store.js'));
const link = require(path.join(h.LIB, 'remote', 'link.js'));
const auth = require(path.join(h.LIB, 'remote', 'auth.js'));
const server = require(path.join(h.LIB, 'remote', 'server.js'));
const client = require(path.join(h.LIB, 'remote', 'client.js'));
const memory = require(path.join(h.LIB, 'remote', 'transports', 'memory.js'));
const ssh = require(path.join(h.LIB, 'remote', 'transports', 'ssh.js'));
const shim = require(path.join(h.LIB, 'remote', 'shim.js'));
const { Machine } = require('./support/two-homes.js');

Object.assign(process.env, { SUB_HUMAN_CLAUDE: '/usr/bin/false', SUB_HUMAN_REAP_GRACE_MS: '0', SUB_HUMAN_REAP_WAIT_MS: '0' });

const LINK_ENV = { SUB_HUMAN_LINK_RETRY_MS: '300', SUB_HUMAN_LINK_IDLE_MS: '1500' };
const ID = 'abcdef012345';
const childOf = pid => Number(spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.trim().split('\n')[0]) || null;
const kill = pid => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };
const stopDaemon = (t, m, code) => t.after(() => {
  const d = m.lib(() => link.status(code));
  if (d.pid) { kill(childOf(d.pid)); kill(d.pid); }
  fs.rmSync(path.dirname(link.socketPath(path.join(m.home, 'rooms', code))), { recursive: true, force: true });
});
const roomLines = (m, code) => m.lib(() => store.open(code).readAll()).filter(e => e.from === 'room').map(e => e.text).join('\n');
const links = (m, code) => m.lib(() => auth.links(store.open(code)));

/** A fake `ssh` in its own dir: logs its argv, then plays sshd for the host user (FAKE_SSH_HOME): FAKE_SSH_FAIL
 * (hostkey | denied) fails as ssh does in BatchMode; FAKE_SSH_FORCED runs that forced command with
 * SSH_ORIGINAL_COMMAND, as an authorized_keys command="…" line does; else the remote command in a login shell. */
function fakeSsh(t) {
  const dir = h.tmpDir('sh-fakessh-', t);
  fs.writeFileSync(path.join(dir, 'ssh'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_SSH_LOG) fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(args) + '\\n');
const fail = process.env.FAKE_SSH_FAIL;
if (fail === 'hostkey') { process.stderr.write('No ED25519 host key is known for devbox and you have requested strict checking.\\nHost key verification failed.\\n'); process.exit(255); }
if (fail === 'denied') { process.stderr.write('me@devbox: Permission denied (publickey).\\n'); process.exit(255); }
const remote = args.slice(args.indexOf('--') + 2).join(' ');
const env = { ...process.env, HOME: process.env.FAKE_SSH_HOME };
delete env.SUB_HUMAN_HOME;
let cmd = remote;
if (process.env.FAKE_SSH_FORCED) { env.SSH_ORIGINAL_COMMAND = remote; cmd = process.env.FAKE_SSH_FORCED; }
const c = require('node:child_process').spawn('/bin/sh', ['-c', cmd], { stdio: 'inherit', env, cwd: env.HOME });
c.on('exit', code => process.exit(code === null ? 255 : code));
`, { mode: 0o755 });
  return dir;
}

/** The host (alice in a room it hosts, its shim written by that join) and a joiner whose ssh is the fake. */
function setup(t, fake = {}, { defaultHome = true } = {}) {
  const host = new Machine(t, 'host');
  if (defaultHome) fs.symlinkSync(host.home, path.join(host.user, '.sub-human')); // ~/.sub-human on the host is its home
  const alice = host.seat('alice');
  assert.equal(host.join(alice, 'alice').json.decision, undefined);
  const code = host.lib(() => store.listRooms()[0]);
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
  assert.equal(ssh.remoteCommand(spec, 'vole-1234'), `"$HOME"/.sub-human/bin/serve --stdio vole-1234 --link ${ID} --login`);
  assert.equal(ssh.remoteCommand({ ...spec, remoteHome: '/srv/sh' }, 'vole-1234'), `env SUB_HUMAN_HOME=/srv/sh /srv/sh/bin/serve --stdio vole-1234 --link ${ID} --login`);
  assert.equal(ssh.remoteCommand({ kind: 'ssh', user: 'me', host: 'x' }, 'vole-1234'), 'sub-human serve --stdio vole-1234', 'an admitted key\'s command is unchanged');
  const cmd = ssh.command(spec, 'vole-1234', []);
  assert.deepEqual(cmd, ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
    '-J', 'jump@bastion', '-p', '2222', '--', 'me@devbox', `"$HOME"/.sub-human/bin/serve --stdio vole-1234 --link ${ID} --login`]);
  assert.ok(!cmd.some(a => /StrictHostKeyChecking|UserKnownHostsFile|IdentitiesOnly/.test(a)), 'normal known_hosts checking, the person\'s own keys');
  // a primed master (sub-human prime) is ridden as for any ssh link
  assert.ok(ssh.command({ ...spec, mux: true }, 'vole-1234', []).includes('ControlMaster=no'));
  assert.ok(ssh.primeCommand(spec, 'vole-1234', { opts: [] }).includes('-M'));
  assert.equal(ssh.loginCommand(spec), 'ssh -p 2222 -J jump@bastion me@devbox');
  assert.match(ssh.kind.describe(spec), /^ssh me@devbox:2222 via jump@bastion \(your ssh login\)$/);
  // nothing an option or a shell would read
  for (const bad of [['-oProxyCommand=x@y'], ['me@devbox', { via: '-oX' }], ['me@devbox', { home: 'rel/path' }], ['me@devbox', { home: '/a b' }], ['me@devbox', { home: '/a;rm' }], ['me@devbox', { link: 'XYZ' }]]) {
    assert.equal(ssh.loginSpec(...bad), null, JSON.stringify(bad));
  }
  assert.throws(() => ssh.command({ ...spec, link: '../x' }, 'vole-1234', []), /link id/);
  assert.throws(() => ssh.command({ ...spec, remoteHome: '/a $(x)' }, 'vole-1234', []), /remote home/);
});

test('ssh.loginFailure: what only the person can fix names the exact step; anything that may pass is null', () => {
  const spec = ssh.loginSpec('me@devbox', { link: ID });
  const f = s => ssh.loginFailure(s, spec, 'vole-1234');
  assert.match(f('Host key verification failed.'), /run `ssh me@devbox` once in a terminal, check and accept the key/);
  assert.match(ssh.loginFailure('Host key verification failed.', { ...spec, port: 2222, via: 'b' }, 'vole-1234'), /`ssh -p 2222 -J b me@devbox`/);
  assert.match(f('me@devbox: Permission denied (publickey).'), /refused your ssh login without a prompt .*sub-human prime vole-1234/);
  assert.match(f('sh: 1: /home/me/.sub-human/bin/serve: not found'), /no sub-human serve shim at ~\/\.sub-human\/bin\/serve: on that machine, open the room in Claude Code .*--home PATH/);
  assert.match(f('zsh:1: no such file or directory: /home/me/.sub-human/bin/serve'), /no sub-human serve shim/);
  assert.match(ssh.loginFailure('env: /srv/sh/bin/serve: No such file or directory', { ...spec, remoteHome: '/srv/sh' }, 'vole-1234'), /shim at \/srv\/sh\/bin\/serve/);
  assert.match(f('no room "vole-1234"'), /room vole-1234 is not open on me@devbox/);
  assert.match(f('usage: sub-human serve --stdio CODE [--link ID]'), /older than links over an ssh login/);
  assert.match(f('sub-human serve --login: refused: this connection came through a forced command'), /forced command/);
  assert.equal(f('ssh: connect to host devbox port 22: Connection refused'), null);
  assert.equal(f('ssh: connect to host devbox port 22: Operation timed out'), null);
});

test('server: a hello {login} makes a link only in a `serve --login` session, under its --link id, once; a forced-command session refuses it', async t => {
  h.freshHome(t);
  const code = h.newRoom();
  const host = store.open(code);
  const dial = async (ctx, opts) => {
    const [a, b] = memory.pair();
    const srv = server.serve(b, { store: host, ...ctx });
    t.after(() => srv.close());
    const c = await client.connect(a, { machine: 'remote0machine01', ...opts });
    t.after(() => c.close());
    return c;
  };
  const authErr = re => e => e.code === 'AUTH' && re.test(e.message);
  // an authorized_keys line's session (--link, no --login): its key reaches that link only
  await assert.rejects(dial({ linkId: ID }, { login: true }), authErr(/did not arrive over the host account's own ssh login \(it came through the key admitted for link abcdef012345/));
  await assert.rejects(dial({}, { login: true }), authErr(/did not arrive over the host account's own ssh login/));
  assert.deepEqual(auth.links(host), {}, 'nothing minted');
  const c = await dial({ linkId: ID, login: true }, { login: true });
  assert.equal(typeof c.token, 'string');
  assert.equal(c.link, ID);
  assert.deepEqual({ ...auth.links(host)[ID], token_sha256: '-', created_at: '-' }, { id: ID, token_sha256: '-', machine: 'remote0machine01', seats: [], created_at: '-', login: true });
  assert.match(host.readAll().at(-1).text, new RegExp(`a machine \\(remote0machine01\\) linked over your SSH login \\(link ${ID}\\); revoke it with: sub-human revoke ${ID}`));
  // the id is taken now: a second login hello for it is refused; the token says hello as any link's
  await assert.rejects(dial({ linkId: ID, login: true }, { login: true }), authErr(/link abcdef012345 exists already/));
  const again = await dial({ linkId: ID, login: true }, { token: c.token });
  assert.equal(again.link, ID);
  // another link's token is not this session's
  await assert.rejects(dial({ linkId: '0123456789ab', login: true }, { token: c.token }), authErr(/not link 0123456789ab's/));
  // an old host answers a login hello without a token: PROTOCOL, never a link with no credential
  const [a, b] = memory.pair();
  b.onFrame(f => b.send(protocol().reply(f.id, { v: 1, proto: { min: 1, max: 9 }, server: '0.4.0', caps: [], room: code, link: null })));
  await assert.rejects(client.connect(a, { machine: 'remote0machine01', login: true }), e => e.code === 'PROTOCOL' && /makes no link over an ssh login/.test(e.message));
});
const protocol = () => require(path.join(h.LIB, 'remote', 'protocol.js'));

test('serve CLI: --login needs --link, and is refused under SSH_ORIGINAL_COMMAND (a forced command), before any frame', t => {
  h.freshHome(t);
  const code = h.newRoom();
  const run = (args, env = {}) => spawnSync(process.execPath, [h.BIN, 'serve', '--stdio', code, ...args], { input: '', encoding: 'utf8', env: h.childEnv({ SUB_HUMAN_HOME: process.env.SUB_HUMAN_HOME, ...env }) });
  assert.match(run(['--login']).stderr, /--login: names no --link ID/);
  const forced = run(['--link', ID, '--login'], { SSH_ORIGINAL_COMMAND: 'anything' });
  assert.equal(forced.status, 1);
  assert.match(forced.stderr, /refused: this connection came through a forced command/);
  assert.equal(run(['--link', ID, '--login'], { SSH_ORIGINAL_COMMAND: undefined }).status, 0, 'stdin ends: it exits cleanly');
});

test('login e2e: join NAME me@devbox CODE links over the person\'s own ssh and takes the seat in one step; the room hears it; revoke ends it', async t => {
  const { host, remote, alice, bob, code, sshLog } = setup(t);
  assert.ok(fs.existsSync(path.join(host.home, 'bin', 'serve')), 'the host\'s join wrote the serve shim');
  const r = remote.join(bob, `join bob me@devbox ${code}`);
  stopDaemon(t, remote, code);
  assert.equal(r.json.decision, undefined, r.json.reason || r.stderr);
  assert.match(r.json.hookSpecificOutput.additionalContext, /SUB-HUMAN: you are bob's Claude/);
  const lf = remote.lib(() => require(path.join(h.LIB, 'room', 'links.js')).get(code));
  assert.equal(lf.transport.login, true);
  assert.equal(typeof lf.token, 'string');
  assert.equal(lf.invite, undefined);
  const id = lf.transport.link;
  assert.deepEqual(Object.keys(links(host, code)), [id]);
  assert.deepEqual(links(host, code)[id].seats, ['bob']);
  assert.match(roomLines(host, code), new RegExp(`a machine \\([0-9a-f]{16}\\) linked over your SSH login \\(link ${id}\\)`));
  const argv = fs.readFileSync(sshLog, 'utf8').trim().split('\n').map(l => JSON.parse(l))[0];
  assert.ok(argv.includes('BatchMode=yes') && !argv.some(a => /StrictHostKeyChecking/.test(a)));
  assert.equal(argv.at(-1), `"$HOME"/.sub-human/bin/serve --stdio ${code} --link ${id} --login`);

  assert.equal(remote.say(bob, 'hello over my login').json.continue, false);
  assert.equal(host.lib(() => store.open(code).readAll()).at(-1).text, 'hello over my login');
  assert.equal(remote.log(code), host.log(code));
  // joining the same way again is just the seat (no new link)
  assert.equal(remote.join(bob, `join bob me@devbox ${code}`).json.decision, undefined);
  assert.deepEqual(Object.keys(links(host, code)), [id]);

  // revoke by name: the token goes, bob leaves, its serve is stopped, the daemon stops with the reason
  const rv = host.join(alice, 'revoke bob');
  assert.match(rv.json.reason, new RegExp(`revoked link ${id} of room ${code}: token burnt, its serve stopped, bob left\\. It came over an ssh login to this account, which can link again`));
  assert.deepEqual(links(host, code), {});
  await h.until(() => remote.lib(() => link.status(code)).state === 'stopped', 10_000);
  assert.match(remote.lib(() => link.status(code)).reason, /revoked/);
});

test('login e2e: --home names a host home that is not ~/.sub-human; a primed (mux) link keeps riding its master on a re-join', t => {
  const { host, remote, bob, code, sshLog } = setup(t, {}, { defaultHome: false });
  const miss = remote.join(bob, `join bob me@devbox ${code}`);
  stopDaemon(t, remote, code);
  assert.equal(miss.json.decision, 'block');
  assert.match(miss.json.reason, /could not link to room .* over ssh me@devbox \(your ssh login\): me@devbox has no sub-human serve shim at ~\/\.sub-human\/bin\/serve: on that machine, open the room in Claude Code \(\/sub-human NAME\), which writes it, or run sub-human doctor --fix there; if its sub-human home is elsewhere, join with --home PATH/);
  assert.deepEqual(links(host, code), {}, 'nothing minted');
  // as `sub-human prime CODE` leaves it: the link rides a master; the re-join to the same destination keeps that
  const linksLib = require(path.join(h.LIB, 'room', 'links.js'));
  remote.lib(() => { const l = linksLib.get(code); linksLib.set(code, { ...l, transport: { ...l.transport, mux: true } }); });
  const r = remote.join(bob, `join bob me@devbox ${code} --home ${host.home}`);
  assert.equal(r.json.decision, undefined, r.json.reason || r.stderr);
  assert.equal(remote.lib(() => linksLib.get(code)).transport.mux, true);
  const argv = fs.readFileSync(sshLog, 'utf8').trim().split('\n').map(l => JSON.parse(l)).at(-1);
  assert.ok(argv.includes('ControlMaster=no'), 'the daemon rides the master, never becomes one');
  assert.match(argv.at(-1), new RegExp(`^env SUB_HUMAN_HOME=${host.home.replace(/[.]/g, '\\.')} .*/bin/serve --stdio ${code} --link [0-9a-f]{12} --login$`));
  assert.equal(Object.keys(links(host, code)).length, 1);
});

test('login e2e: an unknown host key fails at once with the exact ssh to run once; a refused login names BatchMode; neither mints a link', t => {
  const a = setup(t, { FAKE_SSH_FAIL: 'hostkey' });
  const t0 = Date.now();
  const r = a.remote.join(a.bob, `join bob me@devbox:2222 ${a.code} --via jump@bastion`);
  stopDaemon(t, a.remote, a.code);
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, /ssh does not know me@devbox's host key yet \(or it changed\), and a link never answers ssh's prompt: run `ssh -p 2222 -J jump@bastion me@devbox` once in a terminal/);
  assert.ok(Date.now() - t0 < 5000, 'no wait for the join timeout');
  assert.deepEqual(links(a.host, a.code), {});
  // a later /sub-human NAME CODE (after the person accepted the key) dials again; here it is still refused, and says so
  assert.match(a.remote.join(a.bob, `bob ${a.code}`).json.reason, /host key/);

  const b = setup(t, { FAKE_SSH_FAIL: 'denied' });
  const d = b.remote.join(b.bob, `join bob me@devbox ${b.code}`);
  stopDaemon(t, b.remote, b.code);
  assert.match(d.json.reason, /me@devbox refused your ssh login without a prompt \(the link runs ssh with BatchMode/);
});

test('login e2e: a key restricted to another link (its forced command) cannot use the login path, nor can a pass-through forced command', t => {
  const s = setup(t);
  // the line `admit` writes for another link: its arguments are fixed, so --login never reaches serve
  const other = '0123456789ab';
  const forced = host => shim.forcedCommand(s.code, other, host.home);
  const r1 = new Machine(t, 'restricted', { ...LINK_ENV, PATH: `${fakeSsh(t)}:${process.env.PATH}`, FAKE_SSH_HOME: s.host.user, FAKE_SSH_FORCED: forced(s.host) });
  const carol = r1.seat('carol');
  const j1 = r1.join(carol, `join carol me@devbox ${s.code}`);
  stopDaemon(t, r1, s.code);
  assert.equal(j1.json.decision, 'block');
  assert.match(j1.json.reason, /did not arrive over the host account's own ssh login \(it came through the key admitted for link 0123456789ab, which reaches that link only\)/);
  // a forced command that passes the asked-for command through (sshd still sets SSH_ORIGINAL_COMMAND): refused too
  const r2 = new Machine(t, 'passthru', { ...LINK_ENV, PATH: `${fakeSsh(t)}:${process.env.PATH}`, FAKE_SSH_HOME: s.host.user, FAKE_SSH_FORCED: 'eval "$SSH_ORIGINAL_COMMAND"' });
  const dan = r2.seat('dan');
  const j2 = r2.join(dan, `join dan me@devbox ${s.code}`);
  stopDaemon(t, r2, s.code);
  assert.match(j2.json.reason, /refused: this connection came through a forced command \(a restricted ssh key or ForceCommand\), not your own ssh login/);
  assert.deepEqual(links(s.host, s.code), {}, 'no link was minted');
  assert.doesNotMatch(roomLines(s.host, s.code), /linked over your SSH login/);
});

test('login join: the argument forms are told apart; bad parts are refused before anything is written', t => {
  const { remote, bob, code } = setup(t);
  const bad = (args, re) => { const r = remote.join(bob, args); assert.equal(r.json.decision, 'block', args); assert.match(r.json.reason, re, args); };
  bad(`join bob me@devbox`, /usage: \/sub-human join NAME USER@HOST\[:PORT\] CODE/);
  bad(`join bob me@devbox ${code} extra`, /usage: \/sub-human join NAME USER@HOST\[:PORT\] CODE/);
  bad(`join bob me@devbox not-a-code`, /"not-a-code" is not a room code/);
  bad(`join bob -oProxyCommand=x@y ${code}`, /is not a plain USER@HOST/);
  bad(`join bob me@devbox ${code} --via -oX`, /--via "-oX" is not a plain/);
  bad(`join bob me@devbox ${code} --home relative`, /--home "relative" is not a plain absolute path/);
  bad(`join claude me@devbox ${code}`, /"claude" is reserved/);
  assert.equal(remote.lib(() => require(path.join(h.LIB, 'room', 'links.js')).list()).length, 0);
});
