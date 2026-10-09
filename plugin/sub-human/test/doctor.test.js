'use strict';
// `sub-human doctor` (lib/cli/doctor.js): the checks, the CLI over a real pipe link to a second home, --fix, and the
// redaction of --bundle.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const h = require('./helpers.js');
const doctor = require(path.join(h.LIB, 'cli', 'doctor.js'));
const links = require(path.join(h.LIB, 'room', 'links.js'));
const linkState = require(path.join(h.LIB, 'room', 'link-state.js'));
const shim = require(path.join(h.LIB, 'remote', 'shim.js'));

const KEY_B64 = crypto.randomBytes(51).toString('base64').replace(/=+$/, '');
const KEY = `ssh-ed25519 ${KEY_B64}`;
const LINK_ID = 'a1b2c3d4e5f6';

const run = (args, env) => spawnSync(h.BIN, ['doctor', ...args], { env: h.childEnv(env), encoding: 'utf8', timeout: 120_000 });
const byId = (report, id) => report.checks.find(c => c.id === id);

test('doctor: node floor, Remote Control, ssh hints and argument errors', () => {
  assert.equal(doctor.checkNode('24.0.0').status, 'pass');
  const old = doctor.checkNode('22.11.0');
  assert.equal(old.status, 'fail');
  assert.match(old.fix, /Node 24\+/);
  assert.equal(doctor.checkRemoteControl({}, []).status, 'info');
  for (const env of [{ CLAUDE_CODE_USE_BEDROCK: '1' }, { CLAUDE_CODE_USE_VERTEX: 'true' }, { ANTHROPIC_API_KEY: 'sk-x' }]) {
    const c = doctor.checkRemoteControl(env, []);
    assert.equal(c.status, 'warn', JSON.stringify(env));
    assert.match(c.detail, /needs a claude\.ai subscription/);
  }
  assert.equal(doctor.checkRemoteControl({ CLAUDE_CODE_USE_BEDROCK: '0' }, []).status, 'info', '0 is off');
  assert.equal(doctor.checkRemoteControl({}, [{ env: { CLAUDE_CODE_USE_BEDROCK: '1' } }]).status, 'warn', 'from a settings file too');
  // the sh2 flow: the host admits the link's own key (/sub-human admit shk1…), prime for MFA, --via for a bastion
  const denied = doctor.sshHint('alice@box: Permission denied (publickey).', { code: 'vole-1234' });
  assert.match(denied, /\/sub-human admit shk1… line your join showed, or ask the host for a new invite \(\/sub-human host --ssh\), then \/sub-human join NAME INVITE PIN/);
  assert.match(denied, /sub-human prime vole-1234/);
  assert.doesNotMatch(denied, /authorize|ssh-agent|SUB_HUMAN_SSH_OPTS/, 'no sh1-era advice');
  assert.match(doctor.sshHint('Permission denied (publickey).', { code: 'vole-1234', request: 'shk1.vole-1234.abc.KEY.bob' }), /send them this line .*: \/sub-human admit shk1\.vole-1234\.abc\.KEY\.bob/);
  assert.match(doctor.sshHint('Permission denied (publickey,keyboard-interactive).', { code: 'vole-1234' }), /interactive login \(MFA\): run sub-human prime vole-1234/);
  assert.match(doctor.sshHint('Host key verification failed.', { transport: { knownHosts: '/x/known_hosts', via: 'jump' } }), /not the one its invite pinned.*\/sub-human host --ssh --via jump/);
  assert.match(doctor.sshHint('Host key verification failed.'), /host key/);
  assert.match(doctor.sshHint('ssh: Could not resolve hostname box: nodename nor servname provided'), /does not resolve.*--via JUMP/);
  assert.match(doctor.sshHint('ssh: connect to host box port 22: Operation timed out'), /does not answer.*\/sub-human host --ssh --via JUMP/);
  assert.equal(doctor.sshHint('something else'), null);
  assert.throws(() => doctor.parseArgs(['--nope']), /usage: sub-human doctor/);
  assert.throws(() => doctor.parseArgs(['--timeout', 'x']), /--timeout/);
  assert.deepEqual(doctor.parseArgs(['--bundle']).bundle, '');
  assert.deepEqual(doctor.parseArgs(['--bundle', 'f.json', '--quick']), { ...doctor.parseArgs([]), bundle: 'f.json', quick: true });
});

test('doctor: authorized_keys lines that bypass the shim are found, with the authorize line that rewrites them', t => {
  const home = h.freshHome(t);
  const file = path.join(h.tmpDir('sh-ak-', t), 'authorized_keys');
  fs.writeFileSync(file, [
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIother someone@else',
    shim.authorizedLine('vole-1234', 'aaaaaaaaaaaa', KEY, home),
    `command="SUB_HUMAN_HOME=${home} /opt/node/bin/node /cache/sub-human/0.2.0/bin/sub-human serve --stdio vole-1234 --link ${LINK_ID}",restrict ${KEY} sub-human:vole-1234:${LINK_ID}`,
  ].join('\n'));
  const scan = doctor.scanAuthorizedKeys(file);
  assert.deepEqual(scan.lines.map(l => [l.shimmed, l.code, l.id]), [[true, 'vole-1234', 'aaaaaaaaaaaa'], [false, 'vole-1234', LINK_ID]]);
  assert.deepEqual(doctor.scanAuthorizedKeys(file + '.none'), { file: file + '.none', exists: false, lines: [] });
});

test('doctor CLI: a pipe link to a second home: state, last error, a hello with both protocol versions; home modes, old key lines; --fix', async t => {
  // the host: a room in its own home
  const hostHome = h.freshHome(t);
  const code = h.newRoom();
  // this machine: another home, linked to that room over the pipe transport, with no daemon running
  const home = h.freshHome(t);
  const user = h.tmpDir('sh-user-', t);
  links.set(code, { code, transport: { kind: 'pipe', home: hostHome }, token: 'tok-' + crypto.randomBytes(16).toString('hex'), created_at: new Date().toISOString(), moved: { epoch: 2, host: 'carolyn', locator: 'pipe:' + hostHome } });
  fs.writeFileSync(linkState.stateFile(code), JSON.stringify({ state: 'down', since: new Date(Date.now() - 120_000).toISOString(), attempt: 4, lastError: 'no route to host', queued: 2 }));
  fs.writeFileSync(links.logFile(code), `2026-10-08T10:00:00.000Z sub-human link ${code}: offline: ssh exited 255\n`);
  fs.chmodSync(home, 0o755);
  fs.mkdirSync(path.join(user, '.ssh'), { recursive: true });
  const ak = path.join(user, '.ssh', 'authorized_keys');
  fs.writeFileSync(ak, `command="SUB_HUMAN_HOME=${home} /opt/node/bin/node /cache/sub-human/0.2.0/bin/sub-human serve --stdio ${code} --link ${LINK_ID}",restrict ${KEY} sub-human:${code}:${LINK_ID}\n`);
  const env = { SUB_HUMAN_HOME: home, HOME: user };

  let r = run(['--json', '--timeout', '30000'], env);
  assert.equal(r.status, 1, r.stderr || r.stdout.slice(0, 400)); // the home is 0755
  const rep = JSON.parse(r.stdout);
  assert.equal(byId(rep, 'node').status, 'pass');
  assert.equal(byId(rep, 'home').status, 'fail');
  assert.match(byId(rep, 'home').fix, /sub-human doctor --fix/);
  const akc = byId(rep, 'authorized_keys');
  assert.equal(akc.status, 'warn');
  assert.equal(akc.fix, `echo '${KEY}' | sub-human authorize ${LINK_ID} - --room ${code} --file ~/.ssh/authorized_keys`, 'the child\'s HOME is the user dir');
  const lc = byId(rep, `link:${code}`);
  assert.equal(lc.status, 'warn', lc.detail);
  assert.match(lc.detail, new RegExp(`^pipe ${hostHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · daemon not running · ✕ offline 2m · 2 queued · last error: no route to host · the room moved to [^·]* · host reachable in \\d+ ms; protocol here 1-2 \\(sub-human \\d+\\.\\d+\\.\\d+\\), host 1-2 \\(sub-human \\d+\\.\\d+\\.\\d+\\), speaking v2`));
  assert.match(lc.fix, /ask carolyn for an invite/, 'the room moved and this link never reached the new host');
  assert.match(lc.detail, /the room moved to carolyn's machine \(pipe:.*, host epoch 2; not reached from here yet/);
  const clock = byId(rep, `clock:${code}`);
  assert.equal(clock.status, 'pass', 'the host\'s hello carries its time: one machine, no skew');
  assert.match(clock.detail, /^this machine is \d+ s (behind|ahead of) the host$/);
  assert.ok(byId(rep, 'shim'), 'shim checked');
  assert.ok(byId(rep, 'remote_control'));
  const [l] = rep.links;
  assert.equal(l.reach.ok, true);
  assert.equal(l.reach.protocol.v, 2);
  assert.deepEqual(l.reach.protocol.proto, { min: 1, max: 2 });
  // the midpoint of a slow spawn can sit seconds from the moment the host answered: bound it loosely
  assert.ok(Math.abs(l.reach.skewMs) < 60_000, `skew ${l.reach.skewMs}`);
  assert.deepEqual(l.recent, [`2026-10-08T10:00:00.000Z sub-human link ${code}: offline: ssh exited 255`]);

  // the human-readable form (reading the link opened the store, which repairs the modes: open them again)
  fs.chmodSync(home, 0o755);
  r = run(['--quick'], env);
  assert.match(r.stdout, /^sub-human doctor · plugin \d+\.\d+\.\d+ · node v/);
  assert.match(r.stdout, /✗ home +.*\n +fix: sub-human doctor --fix/);
  assert.doesNotMatch(r.stdout, /host reachable/, '--quick says no hello');

  // --fix: the modes and the shim; the home check passes after it
  fs.chmodSync(home, 0o755);
  r = run(['--fix', '--quick', '--json'], env);
  assert.match(r.stdout, /^fixed: made .* 0700$/m);
  const fixed = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  assert.equal(byId(fixed, 'home').status, 'pass');
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  assert.equal(byId(fixed, 'shim').status, 'pass', byId(fixed, 'shim').detail);

  // --bundle: a 0600 file, redacted
  const out = path.join(h.tmpDir('sh-bundle-', t), 'b.json');
  r = run(['--bundle', out, '--timeout', '30000'], env);
  assert.match(r.stdout, /^wrote .*b\.json: redacted/);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  const text = fs.readFileSync(out, 'utf8');
  const b = JSON.parse(text);
  assert.equal(b.kind, 'sub-human-doctor-bundle');
  for (const secret of [home, hostHome, user, code, KEY_B64, links.get(code).token, 'carolyn']) assert.ok(!text.includes(secret), `the bundle holds ${secret}`);
  assert.equal(b.links[0].state.queued, 2);
  assert.equal(b.links[0].reach.ok, true);
  assert.match(b.authorized_keys.lines[0].key, /^ssh-ed25519 SHA256:[A-Za-z0-9+/]{12}$/);
});

test('doctor bundle: an allowlist, every free text redacted: ~ for $HOME, hashed hosts and users, no keys, tokens, invites or secrets', () => {
  const home = os.homedir();
  const host = 'devbox.corp.example';
  const invite = `sh1.vole-1234.${Buffer.from('ssh:me@' + host).toString('base64url')}.${crypto.randomBytes(24).toString('base64url')}`;
  const token = crypto.randomBytes(24).toString('base64url');
  const hex = crypto.randomBytes(16).toString('hex');
  const report = {
    generated_at: new Date().toISOString(),
    versions: { plugin: '0.3.0', node: '24.1.0', claude: '2.1.292', protocol: 1, ssh: `OpenSSH_9.6 on ${os.hostname()}`, platform: 'linux', arch: 'x64', os: '6.1' },
    checks: [
      { id: 'authorized_keys', status: 'warn', title: 'authorized_keys', detail: `1 line in ${home}/.ssh/authorized_keys`, fix: `echo '${KEY}' | sub-human authorize ${LINK_ID} - --room vole-1234 --file ${home}/.ssh/authorized_keys` },
      { id: 'link:vole-1234', status: 'fail', title: 'link vole-1234', detail: `ssh alice@${host}:2222 · host unreachable: alice@${host}: Permission denied (publickey) from 10.1.2.3`, fix: `token=${token} invite ${invite}` },
      { id: 'misc', status: 'info', title: 'misc', detail: `machine ${hex}; mail tristan@example.com; /home/bob/x and /Users/carol/y` },
    ],
    links: [{
      code: 'vole-1234', transport: { kind: 'ssh', describe: `ssh alice@${host}:2222`, user: 'alice', host, port: 2222 }, credential: 'token',
      daemon: { running: true, pid: 4242 }, state: { state: 'down', attempt: 3, queued: 1, lastError: `ssh: connect to host ${host} port 2222: Connection refused`, source: 'state-file' },
      recent: [`2026-10-08T10:00:00Z sub-human link vole-1234: offline: ${home}/.sub-human/x ${host}`],
      reach: { ok: false, ms: 5, error: `the ssh command exited (255)`, stderr: `alice@${host}: Permission denied (publickey).`, protocol: null, skewMs: null },
    }],
    authorizedKeys: { exists: true, lines: [{ shimmed: false, type: 'ssh-ed25519', key: KEY_B64, code: 'vole-1234', id: LINK_ID }] },
    probe: null,
  };
  const b = doctor.bundle(report, { salt: 'fixed', env: { SUB_HUMAN_SETTLE_MS: '900', SECRET_THING: 'x' } });
  const text = JSON.stringify(b);
  for (const s of [home, host, 'alice', 'vole-1234', KEY_B64, invite.split('.').at(-1), token, hex, '10.1.2.3', 'tristan@example.com', '/home/bob', '/Users/carol', os.hostname()]) {
    assert.ok(!text.includes(s), `the bundle holds ${s}:\n${text}`);
  }
  assert.ok(text.includes('~/.ssh/authorized_keys'), 'paths under $HOME are ~');
  assert.ok(text.includes('sh1.<invite>'));
  const fp = 'SHA256:' + crypto.createHash('sha256').update(Buffer.from(KEY_B64, 'base64')).digest('base64').replace(/=+$/, '').slice(0, 12);
  assert.ok(text.includes(`ssh-ed25519 ${fp}`), 'a key becomes its fingerprint prefix');
  // one host hashes the same everywhere in a bundle, and differently with another salt
  const hh = b.links[0].transport.host;
  assert.match(hh, /^host-[0-9a-f]{8}$/);
  assert.ok(b.checks[1].detail.includes(hh) && b.links[0].state.lastError.includes(hh), b.checks[1].detail);
  assert.notEqual(doctor.bundle(report, { salt: 'other' }).links[0].transport.host, hh);
  assert.deepEqual(b.config.env_overrides, { SUB_HUMAN_SETTLE_MS: 900 }, 'only the timing overrides, as numbers');
  assert.equal(b.links[0].daemon.pid, undefined);
  assert.equal(b.links[0].room.startsWith('room-'), true);
  assert.equal(b.versions.plugin, '0.3.0');
  assert.equal(b.checks[1].status, 'fail');
});

test('doctor redactor: each rule alone', () => {
  const red = doctor.redactor({ home: '/home/zed', hosts: ['box.lan'], users: ['zed'], salt: 's' });
  assert.equal(red('/home/zed/.sub-human/links'), '~/.sub-human/links');
  assert.equal(red('/home/zedd/x'), '/home/<user>/x', 'another user\'s home');
  assert.match(red('zed@box.lan'), /^user-[0-9a-f]{8}@host-[0-9a-f]{8}$/);
  assert.match(red('connect to box.lan port 22'), /^connect to host-[0-9a-f]{8} port 22$/);
  assert.equal(red('box.land'), 'box.land', 'whole names only');
  assert.match(red('from 192.168.4.43'), /^from ip-[0-9a-f]{8}$/);
  assert.equal(red('token: abc123secretvalue'), 'token: <redacted>');
  assert.equal(red(`id ${'ab'.repeat(8)}`), 'id <hex>');
  assert.equal(red('link aaaaaaaaaaaa'), 'link aaaaaaaaaaaa', 'a 12-hex link id stays');
  assert.equal(red('sh1.vole-1234.c3NoOm1l.ZmFrZXNlY3JldGZha2VzZWNyZXQ'), 'sh1.<invite>');
  assert.equal(red('\x1b[31mred\x1b[0m'), 'red');  const tmp = doctor.redactor({ home: '/home/zed', shHome: '/tmp/sh-x', salt: 's' });
  assert.equal(tmp('state in /tmp/sh-x/links/a.json'), 'state in <sub-human-home>/links/a.json', 'a SUB_HUMAN_HOME outside $HOME');
  assert.equal(tmp('/tmp/sh-xy'), '/tmp/sh-xy', 'whole path segments only');
  assert.equal(doctor.redactor({ home: '/home/zed', shHome: '/home/zed/.sub-human' })('/home/zed/.sub-human/x'), '~/.sub-human/x');
});

test('doctor: a room whose orch job started but never took its seat (e.g. refused "name taken") fails, with the job\'s log', t => {
  h.freshHome(t);
  const identity = require(path.join(h.LIB, 'identity.js'));
  const { code } = h.register('alice', 'member', process.pid);
  const old = new Date(Date.now() - 5 * 60_000).toISOString();
  identity.updateOrch(code, () => ({ job: 'job12345', spawned_at: old, pid: 4242, machine: 'another-machine', left_at: undefined }));
  const [c] = doctor.checkOrchs();
  assert.equal(c.id, `orch:${code}`);
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /job job12345 was started \d+ s ago but never took its seat/);
  assert.match(c.fix, /claude logs job12345/);
  identity.updateOrch(code, () => ({ spawned_at: new Date().toISOString() }));
  assert.deepEqual(doctor.checkOrchs(), [], 'within the grace');
  identity.updateOrch(code, () => ({ spawned_at: old, pid: process.pid, machine: identity.machineId() }));
  const [ok] = doctor.checkOrchs();
  assert.deepEqual([ok.id, ok.status], [`orch:${code}`, 'pass'], 'bound here and live: a ✓ line');
  assert.match(ok.detail, new RegExp(`bound and live: job job12345, pid ${process.pid}`));
  assert.match(doctor.format({ versions: { plugin: 'x', node: 'x', platform: 'x', arch: 'x' }, checks: [ok] }), /✓ orch /);
  identity.updateOrch(code, () => ({ pid: 999999 }));
  assert.deepEqual(doctor.checkOrchs(), [], 'bound but its process gone: the watchdog acts, doctor stays quiet');
});

test('doctor: a link stopped on a spent invite says to ask the host for a new one (joining again would reuse it)', () => {
  const d = state => ({ code: 'vole-1234', transport: { kind: 'pipe', describe: 'pipe /x' }, daemon: { running: false }, recent: [], moved: null, state });
  for (const why of ['this invite is burnt (too many wrong PINs, expired, or revoked); ask the host for a new one', 'this invite was used already (each invite works once); ask the host for a new one']) {
    const [c] = doctor.linkChecks(d({ state: 'stopped', lastError: why }));
    assert.match(c.fix, /ask the host for a new invite \(\/sub-human host there\), then \/sub-human join NAME INVITE PIN/);
    assert.doesNotMatch(c.fix, /join again|sub-human link vole-1234/);
  }
  assert.match(doctor.linkChecks(d({ state: 'offline', lastError: 'no route' }))[0].fix, /sub-human link vole-1234/, 'a daemon that is only gone is restarted');
});
