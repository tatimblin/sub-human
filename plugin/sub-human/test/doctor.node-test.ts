// `sub-human doctor` (lib/cli/doctor.ts): the checks, the CLI over a real pipe link to a second home, --fix, and the
// redaction of --bundle.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as h from './helpers.ts';
import * as doctor from '../lib/cli/doctor.ts';
import * as links from '../lib/room/links.ts';
import * as linkState from '../lib/room/link-state.ts';
import * as identity from '../lib/identity.ts';
import * as linkMod from '../lib/remote/link.ts';
import * as store from '../lib/room/store.ts';
import type { Check, KeyLine, LinkReport, LinkStateView, Reach, Report } from '../lib/cli/types.ts';
import type { AgentJob } from '../lib/cc.ts';
import type { MirrorRoomStore } from '../lib/room/store-mirror.ts';

const KEY_B64 = crypto.randomBytes(51).toString('base64').replace(/=+$/, '');
const KEY = `ssh-ed25519 ${KEY_B64}`;
const LINK_ID = 'a1b2c3d4e5f6';

const run = (args: string[], env: NodeJS.ProcessEnv) => spawnSync(h.BIN, ['doctor', ...args], { env: h.childEnv(env), encoding: 'utf8', timeout: 120_000 });
// every check a test looks up is in the report
const byId = (report: Report, id: string): Check => report.checks.find(c => c.id === id)!;
// the fields checkRoomClaudes reads off a job
const job = (j: Partial<AgentJob>) => j as AgentJob;

test('doctor: node floor, Remote Control, ssh hints and argument errors', () => {
  for (const v of ['24.3.0', '24.15.0', '25.0.0', '26.1.0']) assert.equal(doctor.checkNode(v).status, 'pass', v);
  for (const v of ['24.2.1', '24.0.0', '23.11.0']) assert.equal(doctor.checkNode(v).status, 'fail', v);
  const old = doctor.checkNode('22.11.0');
  assert.equal(old.status, 'fail');
  assert.match(old.fix!, /Node 24\.3\+/);
  assert.equal(doctor.checkRemoteControl({}, []).status, 'info');
  for (const env of [{ CLAUDE_CODE_USE_BEDROCK: '1' }, { CLAUDE_CODE_USE_VERTEX: 'true' }, { ANTHROPIC_API_KEY: 'sk-x' }]) {
    const c = doctor.checkRemoteControl(env, []);
    assert.equal(c.status, 'warn', JSON.stringify(env));
    assert.match(c.detail, /needs a claude\.ai subscription/);
  }
  assert.equal(doctor.checkRemoteControl({ CLAUDE_CODE_USE_BEDROCK: '0' }, []).status, 'info', '0 is off');
  assert.equal(doctor.checkRemoteControl({}, [{ env: { CLAUDE_CODE_USE_BEDROCK: '1' } }]).status, 'warn', 'from a settings file too');
  // ssh refused: a login of the person's own (or a web invite); an older link's own key: removed by the host; prime for MFA
  const denied = doctor.sshHint('alice@box: Permission denied (publickey).', { code: 'vole-1234' });
  assert.ok(denied);
  assert.match(denied, /refused your ssh login: joining over ssh needs a login of your own there .* ask the host for an invite over the web \(\/sub-human invite --web\)/);
  assert.match(denied, /sub-human prime vole-1234/);
  assert.doesNotMatch(denied, /authorize\b|shk1|ssh-agent|SUB_HUMAN_SSH_OPTS|let in/, 'no sh1/sh2-era or admit-a-key advice');
  assert.match(doctor.sshHint('Permission denied (publickey).', { code: 'vole-1234', transport: { key: '/x/id_ed25519' } })!, /refused this link's own key \(an older sub-human let it in\): the host removed it\. ask the host for a new invite/);
  assert.match(doctor.sshHint('Permission denied (publickey,keyboard-interactive).', { code: 'vole-1234' })!, /interactive login \(MFA\): run node \S+\/scripts\/sub-human prime vole-1234 once in a terminal/);
  assert.match(doctor.sshHint('Host key verification failed.', { transport: { knownHosts: '/x/known_hosts', via: 'jump' } })!, /not the one its invite pinned.*\/sub-human invite --via jump/);
  assert.match(doctor.sshHint('Host key verification failed.')!, /host key/);
  assert.match(doctor.sshHint('ssh: Could not resolve hostname box: nodename nor servname provided')!, /does not resolve.*--via JUMP/);
  assert.match(doctor.sshHint('ssh: connect to host box port 22: Operation timed out')!, /does not answer.*\/sub-human invite --via JUMP/);
  assert.equal(doctor.sshHint('something else'), null);
  assert.throws(() => doctor.parseArgs(['--nope']), /usage: sub-human doctor/);
  assert.throws(() => doctor.parseArgs(['--timeout', 'x']), /--timeout/);
  assert.deepEqual(doctor.parseArgs(['--bundle']).bundle, '');
  assert.deepEqual(doctor.parseArgs(['--bundle', 'f.json', '--quick']), { ...doctor.parseArgs([]), bundle: 'f.json', quick: true });
});

test('doctor: authorized_keys lines that bypass the shim are found', t => {
  const home = h.freshHome(t);
  const file = path.join(h.tmpDir('sh-ak-', t), 'authorized_keys');
  fs.writeFileSync(file, [
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIother someone@else',
    `command="SUB_HUMAN_HOME=${home} ${home}/bin/serve --stdio vole-1234 --link aaaaaaaaaaaa",restrict ${KEY} sub-human:vole-1234:aaaaaaaaaaaa`,
    `command="SUB_HUMAN_HOME=${home} ${home}/bin/serve --enroll vole-5678 --kind ssh",restrict ${KEY} sub-human-enroll:vole-5678`,
    `command="SUB_HUMAN_HOME=${home} /opt/node/bin/node /cache/sub-human/0.2.0/bin/sub-human serve --stdio vole-1234 --link ${LINK_ID}",restrict ${KEY} sub-human:vole-1234:${LINK_ID}`,
  ].join('\n'));
  const scan = doctor.scanAuthorizedKeys(file);
  assert.deepEqual(scan.lines.map(l => [l.shimmed, (l as Extract<KeyLine, { code: string }>).code, (l as Extract<KeyLine, { code: string }>).id]), [[true, 'vole-1234', 'aaaaaaaaaaaa'], [false, 'vole-1234', LINK_ID]]);
  assert.deepEqual(scan.doors, ['vole-5678'], 'a door a 0.5.0-beta.15 invite left');
  const c = doctor.checkAuthorizedKeys(scan);
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /1 enrollment door line\(s\) an older sub-human's ssh invite left \(room vole-5678\)/);
  assert.match(c.fix!, /doctor --fix in a terminal \(it removes them\)/);
  assert.deepEqual(doctor.scanAuthorizedKeys(file + '.none'), { file: file + '.none', exists: false, lines: [] });
});

test('doctor CLI: a pipe link to a second home: state, last error, a hello with both protocol versions; home modes, an old key line; --fix', async t => {
  // the host: a room in its own home
  const hostHome = h.freshHome(t);
  const code = h.newRoom();
  // this machine: another home, linked to that room over the pipe transport, with no daemon running
  const home = h.freshHome(t);
  const user = h.tmpDir('sh-user-', t);
  links.set(code, { code, transport: { kind: 'pipe', home: hostHome }, token: 'tok-' + crypto.randomBytes(16).toString('hex'), created_at: new Date().toISOString(), moved: { epoch: 2, host: 'carolyn', locator: 'pipe:' + hostHome } });
  fs.writeFileSync(linkState.stateFile(code), JSON.stringify({ state: 'offline', since: new Date(Date.now() - 120_000).toISOString(), attempt: 4, lastError: 'no route to host', queued: 2 }));
  fs.writeFileSync(links.logFile(code), `2026-10-08T10:00:00.000Z sub-human link ${code}: offline: ssh exited 255\n`);
  fs.chmodSync(home, 0o755);
  fs.mkdirSync(path.join(user, '.ssh'), { recursive: true });
  const ak = path.join(user, '.ssh', 'authorized_keys');
  fs.writeFileSync(ak, `command="SUB_HUMAN_HOME=${home} /opt/node/bin/node /cache/sub-human/0.2.0/bin/sub-human serve --stdio ${code} --link ${LINK_ID}",restrict ${KEY} sub-human:${code}:${LINK_ID}\n`);
  const env = { SUB_HUMAN_HOME: home, HOME: user };

  let r = run(['--json', '--timeout', '30000'], env);
  assert.equal(r.status, 1, r.stderr || r.stdout.slice(0, 400)); // the home is 0755
  const rep: Report = JSON.parse(r.stdout);
  assert.equal(byId(rep, 'node').status, 'pass');
  assert.equal(byId(rep, 'home').status, 'fail');
  assert.match(byId(rep, 'home').fix!, /^node \S+\/scripts\/sub-human doctor --fix in a terminal/, 'the CLI by its path: none is on PATH');
  const akc = byId(rep, 'authorized_keys');
  assert.equal(akc.status, 'warn');
  assert.match(akc.fix!, new RegExp(`^remove the sub-human:${code}:${LINK_ID} line from ~/\\.ssh/authorized_keys and invite that machine again`), 'this home\'s line, in the child\'s ~/.ssh/authorized_keys');
  const lc = byId(rep, `link:${code}`);
  assert.equal(lc.status, 'warn', lc.detail);
  assert.match(lc.detail, new RegExp(`^pipe ${hostHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · daemon not running · ✕ offline 2m · 2 queued · last error: no route to host · the room moved to [^·]* · host reachable in \\d+ ms; protocol here 1-3 \\(sub-human \\d+\\.\\d+\\.\\d+(?:-[0-9a-z.]+)?\\), host 1-3 \\(sub-human \\d+\\.\\d+\\.\\d+(?:-[0-9a-z.]+)?\\), speaking v3`));
  assert.match(lc.fix!, /Ask carolyn for an invite/, 'the room moved and this link never reached the new host');
  assert.match(lc.detail, /the room moved to carolyn's machine; not reached from here yet/);
  assert.doesNotMatch(lc.detail, /epoch|BatchMode/);
  const clock = byId(rep, `clock:${code}`);
  assert.equal(clock.status, 'pass', 'the host\'s hello carries its time: one machine, no skew');
  assert.match(clock.detail, /^this machine is \d+ s (behind|ahead of) the host$/);
  assert.ok(byId(rep, 'shim'), 'shim checked');
  assert.ok(byId(rep, 'remote_control'));
  const [l] = rep.links;
  assert.equal(l.reach!.ok, true);
  assert.equal(l.reach!.protocol!.v, 3);
  assert.deepEqual(l.reach!.protocol!.proto, { min: 1, max: 3 });
  // the midpoint of a slow spawn can sit seconds from the moment the host answered: bound it loosely
  assert.ok(Math.abs(l.reach!.skewMs!) < 60_000, `skew ${l.reach!.skewMs}`);
  assert.deepEqual(l.recent, [`2026-10-08T10:00:00.000Z sub-human link ${code}: offline: ssh exited 255`]);

  // the human-readable form (reading the link opened the store, which repairs the modes: open them again)
  fs.chmodSync(home, 0o755);
  r = run(['--quick'], env);
  assert.match(r.stdout, /^checks · sub-human \d+\.\d+\.\d+(?:-[0-9a-z.]+)? · node v/);
  assert.match(r.stdout, /✗ sub-human folder +.*\n +fix: node \S+\/scripts\/sub-human doctor --fix in a terminal/);
  assert.doesNotMatch(r.stdout, /host reachable/, '--quick says no hello');

  // --fix: the modes, the shim and a leftover door (an old link's key line stays: kicking that link takes it out); the
  // home check passes after it
  fs.chmodSync(home, 0o755);
  const door = `command="SUB_HUMAN_HOME=${home} ${home}/bin/serve --enroll ${code} --kind ssh",restrict ${KEY} sub-human-enroll:${code}`;
  fs.appendFileSync(ak, `${door}\n`);
  r = run(['--fix', '--quick', '--json'], env);
  assert.match(r.stdout, /^fixed: made .* 0700$/m);
  assert.match(r.stdout, /^fixed: removed 1 enrollment door line\(s\) an older sub-human left in ~\/\.ssh\/authorized_keys$/m);
  assert.ok(!fs.readFileSync(ak, 'utf8').includes(door) && fs.readFileSync(ak, 'utf8').includes(`sub-human:${code}:${LINK_ID}`));
  assert.doesNotMatch(r.stdout, /rewrote/);
  const fixed = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  assert.equal(byId(fixed, 'home').status, 'pass');
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  assert.equal(byId(fixed, 'shim').status, 'pass', byId(fixed, 'shim').detail);

  // --bundle: a 0600 file, redacted, its missing parent folders made (no ENOENT)
  const out = path.join(h.tmpDir('sh-bundle-', t), 'new', 'sub', 'b.json');
  assert.ok(!fs.existsSync(path.dirname(out)));
  r = run(['--bundle', out, '--timeout', '30000'], env);
  assert.ok(fs.existsSync(out), r.stderr);
  assert.match(r.stdout, /^wrote .*b\.json: redacted/);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  const text = fs.readFileSync(out, 'utf8');
  const b = JSON.parse(text);
  assert.equal(b.kind, 'sub-human-doctor-bundle');
  for (const secret of [home, hostHome, user, code, KEY_B64, links.get(code)!.token!, 'carolyn']) assert.ok(!text.includes(secret), `the bundle holds ${secret}:\n${text}`);
  assert.equal(b.links[0].state.queued, 2);
  assert.equal(b.links[0].reach.ok, true);
  assert.match(b.authorized_keys.lines[0].key, /^ssh-ed25519 SHA256:[A-Za-z0-9+/]{12}$/);
});

test('doctor bundle: an allowlist, every free text redacted: ~ for $HOME, hashed hosts and users, no keys, tokens, invites or secrets', () => {
  const home = os.homedir();
  const host = 'devbox.corp.example';
  const invite = `sh2.vole-1234.${Buffer.from('ssh:me@' + host).toString('base64url')}.${crypto.randomBytes(16).toString('base64url')}.0`;
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
  // a hand-made report: no authorizedKeys.file, no reach.hint, which bundle never reads
  const b = doctor.bundle(report as unknown as Report, { salt: 'fixed', env: { SUB_HUMAN_SETTLE_MS: '900', SECRET_THING: 'x' } });
  const text = JSON.stringify(b);
  for (const s of [home, host, 'alice', 'vole-1234', KEY_B64, invite.split('.').at(-2)!, token, hex, '10.1.2.3', 'tristan@example.com', '/home/bob', '/Users/carol', os.hostname()]) {
    assert.ok(!text.includes(s), `the bundle holds ${s}:\n${text}`);
  }
  assert.ok(text.includes('~/.ssh/authorized_keys'), 'paths under $HOME are ~');
  assert.ok(text.includes('sh2.<invite>'));
  const fp = 'SHA256:' + crypto.createHash('sha256').update(Buffer.from(KEY_B64, 'base64')).digest('base64').replace(/=+$/, '').slice(0, 12);
  assert.ok(text.includes(`ssh-ed25519 ${fp}`), 'a key becomes its fingerprint prefix');
  // one host hashes the same everywhere in a bundle, and differently with another salt
  const hh = b.links[0].transport.host!;
  assert.match(hh, /^host-[0-9a-f]{8}$/);
  assert.ok(b.checks[1].detail.includes(hh) && b.links[0].state.lastError!.includes(hh), b.checks[1].detail);
  assert.notEqual(doctor.bundle(report as unknown as Report, { salt: 'other' }).links[0].transport.host, hh);
  assert.deepEqual(b.config.env_overrides, { SUB_HUMAN_SETTLE_MS: 900 }, 'only the timing overrides, as numbers');
  assert.equal((b.links[0].daemon as { pid?: number }).pid, undefined);
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
  assert.equal(red('sh2.vole-1234.c3NoOm1l.ZmFrZXNlY3JldGZha2VzZWNyZXQ.0'), 'sh2.<invite>');
  assert.equal(red('\x1b[31mred\x1b[0m'), 'red');  const tmp = doctor.redactor({ home: '/home/zed', shHome: '/tmp/sh-x', salt: 's' });
  assert.equal(tmp('state in /tmp/sh-x/links/a.json'), 'state in <sub-human-home>/links/a.json', 'a SUB_HUMAN_HOME outside $HOME');
  assert.equal(tmp('/tmp/sh-xy'), '/tmp/sh-xy', 'whole path segments only');
  assert.match(tmp('moved (pipe:/var/tmp/other-home), epoch 2'), /^moved \(pipe:<home-[0-9a-f]{8}>\), epoch 2$/, 'a pipe locator names another home');
  assert.match(tmp('pipe /var/tmp/other-home · daemon not running'), /^pipe <home-[0-9a-f]{8}> · daemon not running$/, 'and its describe() form');
  assert.equal(doctor.redactor({ home: '/home/zed', shHome: '/home/zed/.sub-human' })('/home/zed/.sub-human/x'), '~/.sub-human/x');
});

test('doctor: a room whose claude job started but never took its seat (e.g. blocked) fails, with the job\'s log', t => {
  h.freshHome(t);
  const { code } = h.register('alice', 'member', process.pid);
  const old = new Date(Date.now() - 5 * 60_000).toISOString();
  identity.updateRoomClaude(code, () => ({ job: 'job12345', spawned_at: old, pid: 4242, machine: 'another-machine', left_at: undefined }));
  const [c] = doctor.checkRoomClaudes({ jobs: () => null });
  assert.equal(c.id, `room-claude:${code}`);
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /job job12345 was started \d+ s ago but never took its seat/);
  assert.match(c.fix!, /claude logs job12345 shows what it is doing and why it never took its seat/);
  assert.doesNotMatch(c.fix!, /refused/, 'nothing here knows its /sub-human was refused');
  const [blocked] = doctor.checkRoomClaudes({ jobs: () => [job({ id: 'job12345', state: 'blocked' })] });
  assert.match(blocked.detail, /never took its seat; the job is blocked/);
  assert.match(blocked.fix!, /shows what it is doing and why it never took its seat/);
  assert.doesNotMatch(blocked.fix!, /refused/);
  const [done] = doctor.checkRoomClaudes({ jobs: () => [job({ id: 'job12345', state: 'done' })] });
  assert.match(done.fix!, /^the job ended its turn without taking its seat: claude logs job12345 shows why/);
  assert.match(c.fix!, /the bg daemon check says whether the daemon runs a Claude Code that was upgraded away/);
  const [crashed] = doctor.checkRoomClaudes({ jobs: () => [job({ id: 'job12345', state: 'failed' })] });
  assert.match(crashed.detail, /never took its seat; the job is failed/);
  assert.match(crashed.fix!, /ended before its first turn/);
  assert.doesNotMatch(crashed.fix!, /refused/, 'a crash is not a refused /sub-human');
  assert.match(crashed.fix!, /the bg daemon check says whether .* and how to restart it/);
  identity.updateRoomClaude(code, () => ({ spawn_error: 'did not take its seat in 120 s (job job12345: failed)' }));
  assert.match(doctor.checkRoomClaudes({ jobs: () => null })[0].detail, /\(did not take its seat in 120 s \(job job12345: failed\)\)/);
  identity.updateRoomClaude(code, () => ({ job: null, spawn_error: 'job job12345 failed' }));
  const [failed] = doctor.checkRoomClaudes();
  assert.equal(failed.status, 'fail');
  assert.match(failed.detail, /its last start failed: job job12345 failed/);
  assert.match(failed.fix!, /the bg daemon check says whether the daemon runs a Claude Code that was upgraded away/);
  identity.updateRoomClaude(code, () => ({ job: 'job12345', spawn_error: undefined }));
  identity.updateRoomClaude(code, () => ({ spawned_at: new Date().toISOString() }));
  assert.deepEqual(doctor.checkRoomClaudes({ jobs: () => null }), [], 'within the grace');
  identity.updateRoomClaude(code, () => ({ spawned_at: old, pid: process.pid, machine: identity.machineId() }));
  const [ok] = doctor.checkRoomClaudes();
  assert.deepEqual([ok.id, ok.status], [`room-claude:${code}`, 'pass'], 'bound here and live: a ✓ line');
  assert.match(ok.detail, new RegExp(`bound and live: job job12345, pid ${process.pid}`));
  assert.match(doctor.format({ versions: { plugin: 'x', node: 'x', platform: 'x', arch: 'x' }, checks: [ok] } as unknown as Report), /✓ room's Claude /);
  identity.updateRoomClaude(code, () => ({ pid: 999999 }));
  assert.deepEqual(doctor.checkRoomClaudes(), [], 'bound but its process gone: the watchdog acts, doctor stays quiet');
});

test('doctor: a link stopped on a spent invite says to ask the host for a new one (joining again would reuse it)', () => {
  // no credential: linkChecks never reads it
  const d = (state: LinkStateView) => ({ code: 'vole-1234', transport: { kind: 'pipe', describe: 'pipe /x' }, daemon: { running: false }, recent: [], moved: null, state }) as Omit<LinkReport, 'credential'> as LinkReport;
  for (const [why, lastReason] of [['this invite no longer works (too many wrong PINs, expired, or cancelled); ask the host for a new one', 'INVITE_BURNT'], ['this invite was used already (each invite works once); ask the host for a new one', 'INVITE_USED']] as const) {
    const [c] = doctor.linkChecks(d({ state: 'stopped', lastError: why, lastReason }));
    assert.match(c.fix!, /ask the host for a new invite \(\/sub-human invite there\) and type the line it shows/);
    assert.doesNotMatch(c.fix!, /join again|type \/sub-human in your session/);
  }
  assert.match(doctor.linkChecks(d({ state: 'offline', lastError: 'no route' }))[0].fix!, /type \/sub-human in your session to start it again/, 'a daemon that is only gone is restarted');
  // the words alone decide nothing: a stop with no reason (an older daemon's record) gets the generic fix
  assert.doesNotMatch(doctor.linkChecks(d({ state: 'stopped', lastError: 'this invite was used already' }))[0].fix || '', /new invite/);
});

test('doctor: a dormant link (the room closed, or no seat of this machine left) is info, never --reset; an offline one still fails', () => {
  // the daemon's own stop words; doctor matches their reasons (ROOM_CLOSED, NO_SEAT)
  assert.equal(linkMod.ROOM_CLOSED_REASON, 'the room was closed');
  assert.equal(linkMod.NO_SEAT_REASON, 'no seat of this machine is left in the room');
  // no credential: linkChecks never reads it
  const d = (state: LinkStateView, reach?: Reach) => ({ code: 'vole-1234', transport: { kind: 'pipe', describe: 'pipe /x' }, daemon: { running: false }, recent: [], moved: null, state, ...(reach ? { reach } : {}) }) as Omit<LinkReport, 'credential'> as LinkReport;
  const failed: Reach = { ok: false, ms: 3, error: 'the pipe command exited (1) before answering', skipped: false, stderr: '', hint: null, protocol: null, skewMs: null };
  const [closed] = doctor.linkChecks(d({ state: 'stopped', lastError: linkMod.ROOM_CLOSED_REASON, lastReason: 'ROOM_CLOSED' }));
  assert.equal(closed.status, 'info');
  // never pruned on its own: the host can open it again; forgetting it is the person's own command
  assert.match(closed.fix!, /^the room was closed; this machine's copy is kept\. If the host opens it again, \/sub-human reconnects; node \S+ link vole-1234 --forget in a terminal drops it for good$/);
  assert.doesNotMatch(closed.fix!, /--reset|\/sub-human invite/);
  const [seatless] = doctor.linkChecks(d({ state: 'stopped', lastError: linkMod.NO_SEAT_REASON, lastReason: 'NO_SEAT' }));
  assert.equal(seatless.status, 'info');
  // the host may have closed the room since: /sub-human only while it is open, --forget when it is not wanted
  assert.match(seatless.fix!, /^the connection stopped when this machine's last seat left\. If the host still has the room open, type \/sub-human in your session to start it again; if you no longer want the room, node \S+ link vole-1234 --forget in a terminal drops it$/);
  assert.doesNotMatch(seatless.fix!, /--reset/);
  // known closed since (the mirror or the host's hello): the closed room's text
  const [shut] = doctor.linkChecks({ ...d({ state: 'stopped', lastError: linkMod.NO_SEAT_REASON, lastReason: 'NO_SEAT' }), closed: true });
  assert.equal(shut.status, 'info');
  assert.equal(shut.fix, closed.fix);
  assert.match(shut.detail, /the host has closed the room since/);
  for (const [why, lastReason] of [[linkMod.ROOM_CLOSED_REASON, 'ROOM_CLOSED'], [linkMod.NO_SEAT_REASON, 'NO_SEAT']] as const) {
    const [c] = doctor.linkChecks(d({ state: 'stopped', lastError: why, lastReason }, failed));
    assert.equal(c.status, 'info', `${why}: a failed hello does not make it fail`);
    assert.doesNotMatch(c.fix!, /--reset/);
  }
  assert.equal(doctor.linkChecks(d({ state: 'offline', lastError: 'no route' }, failed))[0].status, 'fail', 'an offline link the host does not answer');
});

test('doctor: a seatless link gets a hello, whose closed (or the mirror\'s stopped room Claude) picks the closed-room fix', async t => {
  const hostHome = h.freshHome(t);
  const code = h.newRoom();
  const home = h.freshHome(t);
  links.set(code, { code, transport: { kind: 'pipe', home: hostHome }, token: 'tok-x', created_at: new Date().toISOString() });
  fs.writeFileSync(linkState.stateFile(code), JSON.stringify({ state: 'stopped', since: new Date().toISOString(), lastError: linkMod.NO_SEAT_REASON, lastReason: 'NO_SEAT' }));
  const env = { ...process.env, PATH: path.join(home, 'bin') }; // no claude: the internals probe is not run
  const ak = path.join(home, 'authorized_keys');
  let rep = await doctor.diagnose({ timeoutMs: 20_000, authorizedKeys: ak, env });
  assert.equal(rep.links[0].reach!.ok, true, rep.links[0].reach!.error);
  assert.equal(rep.links[0].closed, undefined, 'open on the host');
  assert.match(byId(rep, `link:${code}`).fix!, /If the host still has the room open, type \/sub-human/);
  // the host closes the room: its hello says so
  process.env.SUB_HUMAN_HOME = hostHome;
  identity.updateRoomClaude(code, () => ({ job: 'cafe0001', stopped_at: new Date().toISOString() }));
  process.env.SUB_HUMAN_HOME = home;
  rep = await doctor.diagnose({ timeoutMs: 20_000, authorizedKeys: ak, env });
  assert.equal(rep.links[0].closed, true);
  const c = byId(rep, `link:${code}`);
  assert.equal(c.status, 'info');
  assert.match(c.fix!, /^the room was closed; this machine's copy is kept/);
  // --quick (no hello): the mirror's own record of the stop is enough
  assert.doesNotMatch(byId(await doctor.diagnose({ quick: true, authorizedKeys: ak, env }), `link:${code}`).fix!, /room was closed/);
  (store.open(code) as MirrorRoomStore).applyDoc('members', { claude: { name: 'claude', role: 'claude', stopped_at: new Date().toISOString() } });
  assert.match(byId(await doctor.diagnose({ quick: true, authorizedKeys: ak, env }), `link:${code}`).fix!, /^the room was closed; this machine's copy is kept/);
});

test('doctor: a dormant link gets no hello', async t => {
  h.freshHome(t);
  const code = h.newRoom();
  const gone = path.join(h.tmpDir('sh-gone-', t), 'nohome');
  links.set(code, { code, transport: { kind: 'pipe', home: gone }, token: 'tok-x', created_at: new Date().toISOString() });
  fs.writeFileSync(linkState.stateFile(code), JSON.stringify({ state: 'stopped', since: new Date().toISOString(), lastError: 'the room was closed', lastReason: 'ROOM_CLOSED' }));
  const env = { ...process.env, PATH: path.join(gone, 'bin') }; // no claude: the internals probe is not run
  const rep = await doctor.diagnose({ timeoutMs: 5000, authorizedKeys: path.join(gone, 'authorized_keys'), env });
  const [l] = rep.links;
  assert.equal(l.reach, undefined, 'no hello');
  assert.equal(byId(rep, `link:${code}`).status, 'info');
  assert.equal(byId(rep, 'daemon').status, 'info', 'no claude: the daemon status is unreadable');
  const quick = await doctor.diagnose({ quick: true, authorizedKeys: path.join(gone, 'authorized_keys'), env });
  assert.match(byId(quick, 'daemon').detail, /could not read `claude daemon status`/, '--quick checks the daemon too');
});

test('doctor checkDaemon: a deleted executable fails, another version warns, not running or unreadable is info', () => {
  const up = (version = '2.1.296') => () => ({ running: true, pid: 4242, version });
  const live = (exe: string) => () => ({ exe, deleted: false });
  const c = (o: Partial<Parameters<typeof doctor.checkDaemon>[0]>) => doctor.checkDaemon({ version: '2.1.296', ...o });
  const unread = c({ status: () => null });
  assert.deepEqual([unread.id, unread.status, unread.detail], ['daemon', 'info', 'could not read `claude daemon status`']);
  assert.equal(c({ status: () => { throw new Error('x'); } }).status, 'info');
  const off = c({ status: () => ({ running: false, pid: null, version: null }) });
  assert.equal(off.status, 'info');
  assert.match(off.detail, /^not running/);
  const gone = c({ status: up(), exe: () => ({ exe: '/opt/homebrew/Caskroom/claude-code/2.1.292/claude', deleted: true }) });
  assert.equal(gone.status, 'fail');
  assert.match(gone.detail, /pid 4242, 2\.1\.296\) from \/opt\/homebrew\/Caskroom\/claude-code\/2\.1\.292\/claude, which was deleted since it started/);
  assert.match(gone.fix!, /^claude daemon stop --any --keep-workers in a terminal/);
  assert.match(gone.fix!, /the next `claude agents` or `claude --bg` starts a fresh daemon/);
  const older = c({ status: up('2.1.292'), exe: live('/usr/local/bin/claude') });
  assert.equal(older.status, 'warn');
  assert.match(older.detail, /2\.1\.292\) while `claude --version` says 2\.1\.296/);
  assert.match(older.fix!, /claude daemon stop --any --keep-workers/);
  const ok = c({ status: up(), exe: live('/usr/local/bin/claude') });
  assert.deepEqual([ok.status, ok.detail, ok.fix], ['pass', 'running (pid 4242, 2.1.296)', undefined]);
  assert.equal(c({ status: up(), exe: () => null }).status, 'pass', 'an unreadable executable is not a deleted one');
  assert.equal(doctor.checkDaemon({ version: null, status: up('2.1.292'), exe: live('claude') }).status, 'pass', 'no `claude --version`: nothing to compare');
});

test('doctor checkClaude: a probe that cannot run says so (a launcher, another version, nothing found), never "N of N changed"', t => {
  const dir = h.tmpDir('sh-claude-bin-', t);
  const probeOf = (name: string, body: string, version = '2.1.998') => {
    const bin = path.join(dir, name);
    fs.writeFileSync(bin, body, { mode: 0o755 });
    return doctor.checkClaude({ version, quick: false, env: { CLAUDE_BIN: bin, PATH: '' } });
  };
  const launcher = probeOf('launcher', '#!/bin/sh\nexec /opt/claude/bin/claude "$@"\n');
  assert.equal(launcher.check.status, 'info');
  assert.match(launcher.check.detail, /internals probe could not run: .*launcher is not the Claude Code binary \(a launcher script\?\); set CLAUDE_BIN to it/);
  assert.equal(launcher.probe, null);
  const other = probeOf('other', 'x VERSION:"2.1.999" y');
  assert.equal(other.check.status, 'info');
  assert.match(other.check.detail, /could not run: .*other is 2\.1\.999 while `claude --version` says 2\.1\.998/);
  assert.equal(other.probe, null);
  const empty = probeOf('empty', 'x VERSION:"2.1.998" y');
  assert.equal(empty.check.status, 'info', empty.check.detail);
  assert.match(empty.check.detail, /could not run: none of the \d+ internals was found/);
  assert.doesNotMatch(empty.check.detail, /changed/);
  assert.equal(empty.probe, null);
});
