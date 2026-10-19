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
import { checkRoomTools } from '../lib/cli/doctor/claude.ts';
import type { Bundle, Check, LinkReport, LinkStateView, Reach, Report } from '../lib/cli/types.ts';
import type { AgentJob } from '../lib/cc/bg.ts';
import { MirrorRoomStore } from '../lib/room/store-mirror.ts';
import { rc, mid, tokenOf } from './support/brands.ts';
import { must } from './support/must.ts';
import { fsStore } from './support/fs-store.ts';

const KEY_B64 = crypto.randomBytes(51).toString('base64').replace(/=+$/, '');
const KEY = `ssh-ed25519 ${KEY_B64}`;
const LINK_ID = 'a1b2c3d4e5f6';

const run = (args: string[], env: NodeJS.ProcessEnv) => spawnSync(h.BIN, ['doctor', ...args], { env: h.childEnv(env), encoding: 'utf8', timeout: 120_000 });
// every check a test looks up is in the report
const byId = (report: Report, id: string): Check => must(report.checks.find(c => c.id === id), `check ${id}`);
// a check's fix, asserted present
const fixOf = (c: Check | undefined): string => must(must(c, 'a check').fix, 'a fix');
// a list's first check, asserted present
const first = (cs: Check[]): Check => must(cs[0], 'a check');
// a job with only the fields checkRoomClaudes reads set
const job = (j: Partial<AgentJob>): AgentJob => ({ pid: null, id: null, sessionId: null, status: null, state: null, kind: null, name: null, cwd: null, startedAt: null, ...j });

test('doctor: node floor, ssh hints and argument errors (no Remote Control check)', () => {
  for (const v of ['22.18.0', '22.22.2', '24.3.0', '24.15.0', '25.0.0', '26.1.0']) assert.equal(doctor.checkNode(v).status, 'pass', v);
  for (const v of ['24.2.1', '24.0.0', '23.11.0', '22.17.9', '20.19.0']) assert.equal(doctor.checkNode(v).status, 'fail', v);
  const old = doctor.checkNode('22.11.0');
  assert.equal(old.status, 'fail');
  assert.match(fixOf(old), /Node 22\.18\+ or 24/);
  // ssh refused: a login of the person's own (or a web invite); MFA or a jump host: the person's own ssh config
  const denied = doctor.sshHint('alice@box: Permission denied (publickey).');
  assert.ok(denied);
  assert.match(denied, /refused your ssh login: joining over ssh needs a login of your own there .* ask the host for an invite over the web \(\/sub-human invite --web\)/);
  assert.doesNotMatch(denied, /authorize\b|shk1|ssh-agent|SUB_HUMAN_SSH_OPTS|let in|prime/, 'no sh1/sh2-era, admit-a-key or prime advice');
  assert.match(must(doctor.sshHint('Permission denied (publickey,keyboard-interactive).')), /interactive login \(MFA\).*\/sub-human invite --web/);
  assert.match(must(doctor.sshHint('Host key verification failed.')), /host key/);
  assert.match(must(doctor.sshHint('ssh: Could not resolve hostname box: nodename nor servname provided')), /does not resolve.*ProxyJump in your ~\/\.ssh\/config/);
  assert.match(must(doctor.sshHint('ssh: connect to host box port 22: Operation timed out')), /does not answer.*ProxyJump/);
  assert.equal(doctor.sshHint('something else'), null);
  assert.throws(() => doctor.parseArgs(['--nope']), /usage: sub-human doctor/);
  assert.throws(() => doctor.parseArgs(['--timeout', 'x']), /--timeout/);
  assert.deepEqual(doctor.parseArgs(['--bundle']).bundle, '');
  assert.deepEqual(doctor.parseArgs(['--bundle', 'f.json', '--quick']), { ...doctor.parseArgs([]), bundle: 'f.json', quick: true });
});

test('doctor CLI: a pipe link to a second home: state, last error, a hello with both protocol versions; home modes; --fix', async t => {
  // the host: a room in its own home
  const hostHome = h.freshHome(t);
  const code = h.newRoom();
  // this machine: another home, linked to that room over the pipe transport, with no daemon running
  const home = h.freshHome(t);
  const user = h.tmpDir('sh-user-', t);
  links.set(code, { code, transport: { kind: 'pipe', home: hostHome }, token: tokenOf('tok-' + crypto.randomBytes(16).toString('hex')), created_at: new Date().toISOString() });
  fs.writeFileSync(linkState.stateFile(code), JSON.stringify({ state: 'offline', since: new Date(Date.now() - 120_000).toISOString(), attempt: 4, lastError: 'no route to host', queued: 2 }));
  fs.mkdirSync(path.join(home, 'rooms', code), { recursive: true });
  fs.writeFileSync(path.join(home, 'rooms', code, 'outbox.json'), JSON.stringify([1, 2].map(i => ({ payload: { kind: 'say', text: `p${i}` }, queued_at: new Date().toISOString() }))));
  fs.writeFileSync(links.logFile(code), `2026-10-08T10:00:00.000Z sub-human link ${code}: offline: ssh exited 255\n`);
  fs.chmodSync(home, 0o755);
  const env = { SUB_HUMAN_HOME: home, HOME: user };

  let r = run(['--json', '--timeout', '30000'], env);
  assert.equal(r.status, 1, r.stderr || r.stdout.slice(0, 400)); // the home is 0755
  const rep = JSON.parse(r.stdout) as Report;
  assert.equal(byId(rep, 'node').status, 'pass');
  assert.equal(byId(rep, 'home').status, 'fail');
  assert.match(fixOf(byId(rep, 'home')), /^SUB_HUMAN_HOME=\S+ node \S+\/scripts\/sub-human doctor --fix in a terminal/, 'the CLI by its path: none is on PATH');
  const lc = byId(rep, `link:${code}`);
  assert.equal(lc.status, 'warn', lc.detail);
  assert.match(lc.detail, new RegExp(`^pipe ${hostHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · daemon not running · ✕ offline 2m · 2 queued · last error: no route to host · the host is up \\(it answered doctor in \\d+ ms; protocol here 5 \\(sub-human \\d+\\.\\d+\\.\\d+(?:-[0-9a-z.]+)?\\), host 5 \\(sub-human \\d+\\.\\d+\\.\\d+(?:-[0-9a-z.]+)?\\), speaking v5\\), but this machine's link to it is down`));
  assert.match(fixOf(lc), /type \/sub-human in your session to start it again/, 'the daemon is not running');
  assert.doesNotMatch(lc.detail, /epoch|BatchMode/);
  const clock = byId(rep, `clock:${code}`);
  assert.equal(clock.status, 'pass', 'the host\'s hello carries its time: one machine, no skew');
  assert.match(clock.detail, /^this machine is \d+ s (behind|ahead of) the host$/);
  assert.ok(byId(rep, 'shim'), 'shim checked');
  assert.ok(!rep.checks.some(c => c.id === 'remote_control'), 'no Remote Control check');
  const l = must(rep.links[0], 'the link');
  const reach = must(l.reach, 'its hello');
  assert.equal(reach.ok, true);
  assert.equal(must(reach.protocol).v, 5);
  assert.deepEqual(must(reach.protocol).proto, { min: 5, max: 5 });
  // the midpoint of a slow spawn can sit seconds from the moment the host answered: bound it loosely
  assert.ok(Math.abs(must(reach.skewMs)) < 60_000, `skew ${reach.skewMs}`);
  assert.deepEqual(l.recent, [`2026-10-08T10:00:00.000Z sub-human link ${code}: offline: ssh exited 255`]);

  // the human-readable form (reading the link opened the store, which repairs the modes: open them again)
  fs.chmodSync(home, 0o755);
  r = run(['--quick'], env);
  assert.match(r.stdout, /^checks · sub-human \d+\.\d+\.\d+(?:-[0-9a-z.]+)? · node v/);
  assert.match(r.stdout, /✗ sub-human folder +.*\n +fix: SUB_HUMAN_HOME=\S+ node \S+\/scripts\/sub-human doctor --fix in a terminal/);
  assert.doesNotMatch(r.stdout, /host reachable/, '--quick says no hello');

  // --fix: the modes and the shim; the home check passes after it
  fs.chmodSync(home, 0o755);
  r = run(['--fix', '--quick', '--json'], env);
  assert.match(r.stdout, /^fixed: made .* 0700$/m);
  assert.doesNotMatch(r.stdout, /rewrote/);
  const fixed = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))) as Report;
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
  const b = JSON.parse(text) as Bundle;
  assert.equal(b.kind, 'sub-human-doctor-bundle');
  for (const secret of [home, hostHome, user, code, KEY_B64, must(must(links.get(code)).token)]) assert.ok(!text.includes(secret), `the bundle holds ${secret}:\n${text}`);
  const bl = must(b.links[0], 'the bundle\'s link');
  assert.equal(bl.state.queued, 2);
  assert.equal(must(bl.reach).ok, true);
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
      code: rc('vole-1234'), transport: { kind: 'ssh', describe: `ssh alice@${host}:2222`, user: 'alice', host, port: 2222 }, credential: 'token',
      daemon: { running: true, pid: 4242 }, state: { state: 'down', attempt: 3, queued: 1, lastError: `ssh: connect to host ${host} port 2222: Connection refused`, source: 'state-file' },
      recent: [`2026-10-08T10:00:00Z sub-human link vole-1234: offline: ${home}/.sub-human/x ${host}`],
      reach: { ok: false, ms: 5, error: `the ssh command exited (255)`, stderr: `alice@${host}: Permission denied (publickey).`, protocol: null, skewMs: null },
    }],
    probe: null,
  };
  // deliberate: a hand-made report (no reach.hint, which bundle never reads; protocol a number)
  const b = doctor.bundle(report as unknown as Report, { salt: 'fixed', env: { SUB_HUMAN_SETTLE_MS: '900', SECRET_THING: 'x' } });
  const text = JSON.stringify(b);
  for (const s of [home, host, 'alice', rc('vole-1234'), KEY_B64, must(invite.split('.').at(-2)), token, hex, '10.1.2.3', 'tristan@example.com', '/home/bob', '/Users/carol', os.hostname()]) {
    assert.ok(!text.includes(s), `the bundle holds ${s}:\n${text}`);
  }
  assert.ok(text.includes('~/.ssh/authorized_keys'), 'paths under $HOME are ~');
  assert.ok(text.includes('sh2.<invite>'));
  const fp = 'SHA256:' + crypto.createHash('sha256').update(Buffer.from(KEY_B64, 'base64')).digest('base64').replace(/=+$/, '').slice(0, 12);
  assert.ok(text.includes(`ssh-ed25519 ${fp}`), 'a key becomes its fingerprint prefix');
  // one host hashes the same everywhere in a bundle, and differently with another salt
  const bl = must(b.links[0], 'the bundle\'s link'), linkCheck = must(b.checks[1], 'the link check');
  const hh = must(bl.transport.host);
  assert.match(hh, /^host-[0-9a-f]{8}$/);
  assert.ok(linkCheck.detail.includes(hh) && must(bl.state.lastError).includes(hh), linkCheck.detail);
  assert.notEqual(doctor.bundle(report as unknown as Report, { salt: 'other' }).links[0]?.transport.host, hh); // deliberate: the same hand-made report
  assert.deepEqual(b.config.env_overrides, { SUB_HUMAN_SETTLE_MS: 900 }, 'only the timing overrides, as numbers');
  assert.equal((bl.daemon as { pid?: number }).pid, undefined);
  assert.equal(bl.room.startsWith('room-'), true);
  assert.equal(b.versions.plugin, '0.3.0');
  assert.equal(linkCheck.status, 'fail');
});

test('doctor redactor: each rule alone', () => {
  const red = doctor.redactor({ home: '/home/zed', hosts: ['box.lan'], users: ['zed'], salt: 's' });
  assert.equal(red('/home/zed/.sub-human/links'), '~/.sub-human/links');
  assert.equal(red('/home/zedd/x'), '/home/<user>/x', 'another user\'s home');
  assert.match(red('zed@box.lan'), /^user-[0-9a-f]{8}@host-[0-9a-f]{8}$/);
  assert.match(red('connect to box.lan port 22'), /^connect to host-[0-9a-f]{8} port 22$/);
  assert.equal(red('box.land'), 'box.land', 'whole names only');
  assert.match(red('from 192.0.2.43'), /^from ip-[0-9a-f]{8}$/);
  assert.equal(red('token: abc123secretvalue'), 'token: <redacted>');
  assert.equal(red(`id ${'ab'.repeat(8)}`), 'id <hex>');
  assert.equal(red('link aaaaaaaaaaaa'), 'link aaaaaaaaaaaa', 'a 12-hex link id stays');
  assert.equal(red('sh2.vole-1234.c3NoOm1l.ZmFrZXNlY3JldGZha2VzZWNyZXQ.0'), 'sh2.<invite>');
  // an invite line's SECRET and the PIN typed after it, whatever their letters
  const S = 'kqmnpzstvwxyabcdefghjkmnpqrstvwxyzabcde'; // no digit: SECRET's shape all the same
  assert.equal(red(`/sub-human join https://x.ts.net/sub-human/vole-1234#${S} 4829`), '/sub-human join https://x.ts.net/sub-human/vole-1234#<secret> <pin>');
  assert.equal(red(`/sub-human join https://x.ts.net/sub-human/vole-1234#${S}`), '/sub-human join https://x.ts.net/sub-human/vole-1234#<secret>');
  assert.equal(red(`join https://x.ts.net/sub-human/vole-1234#${S} 48291 --as bob`), 'join https://x.ts.net/sub-human/vole-1234#<secret> <pin> --as bob', 'a PIN of another length too');
  assert.equal(red(`join dev vole-1234 ${S} 482`), 'join dev vole-1234 <secret> <pin>');
  assert.equal(red(`join dev vole-1234 ${S} --home /srv/sh`), 'join dev vole-1234 <secret> --home /srv/sh');
  assert.equal(red('\x1b[31mred\x1b[0m'), 'red');  const tmp = doctor.redactor({ home: '/home/zed', shHome: '/tmp/sh-x', salt: 's' });
  assert.equal(tmp('state in /tmp/sh-x/links/a.json'), 'state in <sub-human-home>/links/a.json', 'a SUB_HUMAN_HOME outside $HOME');
  assert.equal(tmp('/tmp/sh-xy'), '/tmp/sh-xy', 'whole path segments only');
  assert.match(tmp('moved (pipe:/var/tmp/other-home), epoch 2'), /^moved \(pipe:<home-[0-9a-f]{8}>\), epoch 2$/, 'a pipe locator names another home');
  assert.match(tmp('pipe /var/tmp/other-home · daemon not running'), /^pipe <home-[0-9a-f]{8}> · daemon not running$/, 'and its describe() form');
  assert.equal(doctor.redactor({ home: '/home/zed', shHome: '/home/zed/.sub-human' })('/home/zed/.sub-human/x'), '~/.sub-human/x');
});

test('doctor: a room session that took its seat and then stopped is said to have stopped, not never bound', t => {
  h.freshHome(t);
  const { code } = h.register('alice', 'member', process.pid);
  const old = new Date(Date.now() - 5 * 60_000).toISOString();
  identity.updateRoomClaude(code, () => ({ job: 'job777', spawned_at: old, pid: 4242, joined_at: old, left_at: new Date().toISOString() }));
  const c = first(doctor.checkRoomClaudes({ jobs: () => [job({ id: 'job777', state: 'stopped' })] }));
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /job job777 took its seat, then stopped/);
  assert.doesNotMatch(c.detail, /never took its seat/);
  assert.match(fixOf(c), /claude logs job777/);
});

test('doctor: a room whose claude job started but never took its seat (e.g. blocked) fails, with the job\'s log', t => {
  h.freshHome(t);
  const { code } = h.register('alice', 'member', process.pid);
  const old = new Date(Date.now() - 5 * 60_000).toISOString();
  identity.updateRoomClaude(code, () => ({ job: 'job12345', spawned_at: old, pid: 4242, machine: mid('another-machine'), left_at: undefined }));
  const c = first(doctor.checkRoomClaudes({ jobs: () => null }));
  assert.equal(c.id, `room-claude:${code}`);
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /job job12345 was started \d+ s ago but never took its seat/);
  assert.match(fixOf(c), /claude logs job12345 shows what it is doing and why it never took its seat/);
  assert.doesNotMatch(fixOf(c), /refused/, 'nothing here knows its /sub-human was refused');
  const blocked = first(doctor.checkRoomClaudes({ jobs: () => [job({ id: 'job12345', state: 'blocked' })] }));
  assert.match(blocked.detail, /never took its seat; the job is blocked/);
  assert.match(fixOf(blocked), /shows what it is doing and why it never took its seat/);
  assert.doesNotMatch(fixOf(blocked), /refused/);
  const done = first(doctor.checkRoomClaudes({ jobs: () => [job({ id: 'job12345', state: 'done' })] }));
  assert.match(fixOf(done), /^the job ended its turn without taking its seat: claude logs job12345 shows why/);
  assert.match(fixOf(c), /the bg daemon check says whether the daemon runs a Claude Code that was upgraded away/);
  const crashed = first(doctor.checkRoomClaudes({ jobs: () => [job({ id: 'job12345', state: 'failed' })] }));
  assert.match(crashed.detail, /never took its seat; the job is failed/);
  assert.match(fixOf(crashed), /ended before its first turn/);
  assert.doesNotMatch(fixOf(crashed), /refused/, 'a crash is not a refused /sub-human');
  assert.match(fixOf(crashed), /the bg daemon check says whether .* and how to restart it/);
  identity.updateRoomClaude(code, () => ({ spawn_error: 'did not take its seat in 120 s (job job12345: failed)' }));
  assert.match(first(doctor.checkRoomClaudes({ jobs: () => null })).detail, /\(did not take its seat in 120 s \(job job12345: failed\)\)/);
  identity.updateRoomClaude(code, () => ({ job: null, spawn_error: 'job job12345 failed' }));
  const failed = first(doctor.checkRoomClaudes());
  assert.equal(failed.status, 'fail');
  assert.match(failed.detail, /its last start failed: job job12345 failed/);
  assert.match(fixOf(failed), /the bg daemon check says whether the daemon runs a Claude Code that was upgraded away/);
  identity.updateRoomClaude(code, () => ({ job: 'job12345', spawn_error: undefined }));
  identity.updateRoomClaude(code, () => ({ spawned_at: new Date().toISOString() }));
  assert.deepEqual(doctor.checkRoomClaudes({ jobs: () => null }), [], 'within the grace');
  identity.updateRoomClaude(code, () => ({ spawned_at: old, pid: process.pid, machine: identity.machineId() }));
  const ok = first(doctor.checkRoomClaudes());
  assert.deepEqual([ok.id, ok.status], [`room-claude:${code}`, 'pass'], 'bound here and live: a ✓ line');
  assert.match(ok.detail, new RegExp(`bound and live: job job12345, pid ${process.pid}`));
  assert.match(doctor.format({ versions: { plugin: 'x', node: 'x', platform: 'x', arch: 'x' }, checks: [ok] } as unknown as Report), /✓ room's Claude /); // deliberate: a report with only what format reads
  identity.updateRoomClaude(code, () => ({ pid: 999999 }));
  assert.deepEqual(doctor.checkRoomClaudes(), [], 'bound but its process gone: the watchdog acts, doctor stays quiet');
});

test('doctor: a link stopped on a spent invite says to ask the host for a new one (joining again would reuse it)', () => {
  // credential: linkChecks never reads it
  const d = (state: LinkStateView): LinkReport => ({ code: rc('vole-1234'), transport: { kind: 'pipe', describe: 'pipe /x' }, credential: '', daemon: { running: false }, recent: [], state });
  for (const [why, lastReason] of [['this invite no longer works (too many wrong PINs, expired, or cancelled); ask the host for a new one', 'INVITE_BURNT'], ['this invite was used already (each invite works once); ask the host for a new one', 'INVITE_USED']] as const) {
    const c = first(doctor.linkChecks(d({ state: 'stopped', lastError: why, lastReason })));
    assert.match(fixOf(c), /ask the host for a new invite \(\/sub-human invite there\) and type the line it shows/);
    assert.doesNotMatch(fixOf(c), /join again|type \/sub-human in your session/);
  }
  assert.match(fixOf(doctor.linkChecks(d({ state: 'offline', lastError: 'no route' }))[0]), /type \/sub-human in your session to start it again/, 'a daemon that is only gone is restarted');
  // the words alone decide nothing: a stop with no reason (an older daemon's record) gets the generic fix
  assert.doesNotMatch(first(doctor.linkChecks(d({ state: 'stopped', lastError: 'this invite was used already' }))).fix || '', /new invite/);
});

test('doctor: a dormant link (the room closed, or no seat of this machine left) is info, never --reset; an offline one still fails', () => {
  // the daemon's own stop words; doctor matches their reasons (ROOM_CLOSED, NO_SEAT)
  assert.equal(linkMod.ROOM_CLOSED_REASON, 'the room was closed');
  assert.equal(linkMod.NO_SEAT_REASON, 'no seat of this machine is left in the room');
  // credential: linkChecks never reads it
  const d = (state: LinkStateView, reach?: Reach): LinkReport => ({ code: rc('vole-1234'), transport: { kind: 'pipe', describe: 'pipe /x' }, credential: '', daemon: { running: false }, recent: [], state, ...(reach ? { reach } : {}) });
  const failed: Reach = { ok: false, ms: 3, error: 'the pipe command exited (1) before answering', skipped: false, stderr: '', hint: null, protocol: null, skewMs: null };
  const closed = first(doctor.linkChecks(d({ state: 'stopped', lastError: linkMod.ROOM_CLOSED_REASON, lastReason: 'ROOM_CLOSED' })));
  assert.equal(closed.status, 'info');
  // never pruned on its own: the host can open it again; forgetting it is the person's own command
  assert.match(fixOf(closed), /^the room was closed; this machine's copy is kept\. If the host opens it again, \/sub-human reconnects; SUB_HUMAN_HOME=\S+ node \S+ link vole-1234 --forget in a terminal drops it for good$/);
  assert.doesNotMatch(fixOf(closed), /--reset|\/sub-human invite/);
  const seatless = first(doctor.linkChecks(d({ state: 'stopped', lastError: linkMod.NO_SEAT_REASON, lastReason: 'NO_SEAT' })));
  assert.equal(seatless.status, 'info');
  // the host may have closed the room since: /sub-human only while it is open, --forget when it is not wanted
  assert.match(fixOf(seatless), /^the connection stopped when this machine's last seat left\. If the host still has the room open, type \/sub-human in your session to start it again; if you no longer want the room, SUB_HUMAN_HOME=\S+ node \S+ link vole-1234 --forget in a terminal drops it$/);
  assert.doesNotMatch(fixOf(seatless), /--reset/);
  // known closed since (the mirror or the host's hello): the closed room's text
  const shut = first(doctor.linkChecks({ ...d({ state: 'stopped', lastError: linkMod.NO_SEAT_REASON, lastReason: 'NO_SEAT' }), closed: true }));
  assert.equal(shut.status, 'info');
  assert.equal(shut.fix, closed.fix);
  assert.match(shut.detail, /the host has closed the room since/);
  for (const [why, lastReason] of [[linkMod.ROOM_CLOSED_REASON, 'ROOM_CLOSED'], [linkMod.NO_SEAT_REASON, 'NO_SEAT']] as const) {
    const c = first(doctor.linkChecks(d({ state: 'stopped', lastError: why, lastReason }, failed)));
    assert.equal(c.status, 'info', `${why}: a failed hello does not make it fail`);
    assert.doesNotMatch(fixOf(c), /--reset/);
  }
  assert.equal(first(doctor.linkChecks(d({ state: 'offline', lastError: 'no route' }, failed))).status, 'fail', 'an offline link the host does not answer');
});

test('doctor: a host that answers beside a link that is down says the host is up and this machine\'s link is down, and what restarts it', () => {
  const reach: Reach = { ok: true, ms: 7, skipped: false, stderr: '', hint: null, protocol: { v: 4, proto: { min: 4, max: 4 }, server: '0.5.0' }, skewMs: 0 };
  // credential: linkChecks never reads it
  const d = (state: LinkStateView, running: boolean): LinkReport => ({ code: rc('vole-1234'), transport: { kind: 'pipe', describe: 'pipe /x' }, credential: '',
    daemon: running ? { running: true, pid: 4242 } : { running: false }, recent: [], state, reach });
  const offline = first(doctor.linkChecks(d({ state: 'offline', since: new Date(Date.now() - 90_000).toISOString(), attempt: 6, lastError: 'no route to host' }, true)));
  assert.equal(offline.status, 'warn');
  assert.match(offline.detail, /✕ offline 2m · last error: no route to host · the host is up \(it answered doctor in 7 ms; protocol here .*\), but this machine's link to it is down/);
  assert.doesNotMatch(offline.detail, /host reachable/, 'never "reachable" beside "offline"');
  assert.match(fixOf(offline), /^the host is up but this machine's link has not reconnected yet: it retries on its own; type \/sub-human in your session to reconnect now$/);
  const gone = first(doctor.linkChecks(d({ state: 'offline', lastError: 'the link daemon is not running', dead: true }, false)));
  assert.match(gone.detail, /daemon not running · ✕ not running .*the host is up \(it answered doctor in 7 ms; .*\), but this machine's link to it is down/);
  assert.match(fixOf(gone), /type \/sub-human in your session to start it again/);
  const up = first(doctor.linkChecks(d({ state: 'online' }, true)));
  assert.equal(up.status, 'pass');
  assert.match(up.detail, /⇄ online · host reachable in 7 ms; protocol here/);
  assert.equal(up.fix, undefined);
});

test('doctor: a seatless link gets a hello, whose closed (or the mirror\'s stopped room Claude) picks the closed-room fix', async t => {
  const hostHome = h.freshHome(t);
  const code = h.newRoom();
  const home = h.freshHome(t);
  links.set(code, { code, transport: { kind: 'pipe', home: hostHome }, token: tokenOf('tok-x'), created_at: new Date().toISOString() });
  fs.writeFileSync(linkState.stateFile(code), JSON.stringify({ state: 'stopped', since: new Date().toISOString(), lastError: linkMod.NO_SEAT_REASON, lastReason: 'NO_SEAT' }));
  const env = { ...process.env, PATH: path.join(home, 'bin') }; // no claude: the internals probe is not run
  let rep = await doctor.diagnose({ timeoutMs: 20_000, env });
  const reach = must(rep.links[0]?.reach, 'its hello');
  assert.equal(reach.ok, true, reach.error);
  assert.equal(rep.links[0]?.closed, undefined, 'open on the host');
  assert.match(fixOf(byId(rep, `link:${code}`)), /If the host still has the room open, type \/sub-human/);
  // the host closes the room: its hello says so
  process.env.SUB_HUMAN_HOME = hostHome;
  identity.updateRoomClaude(code, () => ({ job: 'cafe0001', stopped_at: new Date().toISOString() }));
  process.env.SUB_HUMAN_HOME = home;
  rep = await doctor.diagnose({ timeoutMs: 20_000, env });
  assert.equal(rep.links[0]?.closed, true);
  const c = byId(rep, `link:${code}`);
  assert.equal(c.status, 'info');
  assert.match(fixOf(c), /^the room was closed; this machine's copy is kept/);
  // --quick (no hello): the mirror's own record of the stop is enough
  assert.doesNotMatch(fixOf(byId(await doctor.diagnose({ quick: true, env }), `link:${code}`)), /room was closed/);
  const mirror = store.open(code);
  assert.ok(mirror instanceof MirrorRoomStore);
  mirror.applyDoc('members', { claude: { name: 'claude', role: 'claude', stopped_at: new Date().toISOString() } });
  assert.match(fixOf(byId(await doctor.diagnose({ quick: true, env }), `link:${code}`)), /^the room was closed; this machine's copy is kept/);
});

test('doctor: a dormant link gets no hello', async t => {
  h.freshHome(t);
  const code = h.newRoom();
  const gone = path.join(h.tmpDir('sh-gone-', t), 'nohome');
  links.set(code, { code, transport: { kind: 'pipe', home: gone }, token: tokenOf('tok-x'), created_at: new Date().toISOString() });
  fs.writeFileSync(linkState.stateFile(code), JSON.stringify({ state: 'stopped', since: new Date().toISOString(), lastError: 'the room was closed', lastReason: 'ROOM_CLOSED' }));
  const env = { ...process.env, PATH: path.join(gone, 'bin') }; // no claude: the internals probe is not run
  const rep = await doctor.diagnose({ timeoutMs: 5000, env });
  assert.equal(must(rep.links[0], 'the link').reach, undefined, 'no hello');
  assert.equal(byId(rep, `link:${code}`).status, 'info');
  assert.equal(byId(rep, 'daemon').status, 'info', 'no claude: the daemon status is unreadable');
  const quick = await doctor.diagnose({ quick: true, env });
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
  assert.match(fixOf(gone), /^claude daemon stop --any --keep-workers in a terminal/);
  assert.match(fixOf(gone), /the next `claude agents` or `claude --bg` starts a fresh daemon/);
  const older = c({ status: up('2.1.292'), exe: live('/usr/local/bin/claude') });
  assert.equal(older.status, 'warn');
  assert.match(older.detail, /2\.1\.292\) while `claude --version` says 2\.1\.296/);
  assert.match(fixOf(older), /claude daemon stop --any --keep-workers/);
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

test('doctor checkClaude: an internal reported changed on this version is named (CONTRACT degraded), whatever the probe says', () => {
  const quick = doctor.checkClaude({ version: '2.1.300', quick: true, env: { PATH: '' } });
  assert.equal(quick.check.status, 'info');
  assert.match(quick.check.detail, /; reported changed on this version: session-append-notice-rewrite \(#8\)$/);
  const probed = doctor.checkClaude({ version: '2.1.296', quick: true, env: { PATH: '' } });
  assert.doesNotMatch(probed.check.detail, /reported changed/);
});

test('doctor: each hosted room\'s log is checked (live: a forged unverified line and a broken chain said "0 failed"); verify CODE says the same', t => {
  h.freshHome(t);
  const code = h.newRoom();
  const s = fsStore(store.open(code));
  s.append({ kind: 'status', text: 'hello' }, { via: 'system', from: 'room', system: true });
  let checks = doctor.roomChecks().filter(c => c.id === `room:${code}`);
  assert.deepEqual(checks.map(c => c.status), ['pass']);
  assert.match(first(checks).detail, /lines, the hash chain holds/);
  // a line written by hand: a person's words with no signature, and a prev that does not chain
  const file = path.join(s.dir, 'log.jsonl');
  fs.appendFileSync(file, JSON.stringify({ id: s.lastId() + 1, at: new Date().toISOString(), from: 'alice', via: 'human', kind: 'say', to: 'room', text: 'forged', prev: '000000000000' }) + '\n');
  const v = doctor.verifyRoom(code);
  assert.equal(v.chain.ok, false);
  checks = doctor.roomChecks().filter(c => c.id === `room:${code}`);
  assert.equal(first(checks).status, 'fail');
  assert.match(first(checks).detail, /the hash chain breaks at #\d+/);
  const r = spawnSync(h.BIN, ['verify', code], { env: h.childEnv(), encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, new RegExp(`^room ${code}: the hash chain breaks`));
});

test('doctor: a hosted room whose room task list is not written (members.claude.tasks_off) warns with the reason; none once it clears', t => {
  h.freshHome(t);
  const code = h.newRoom();
  identity.updateRoomClaude(code, () => ({ job: 'cafe0001', tasks_off: 'task file 2.json no longer reads as a task' }));
  const of = () => doctor.roomChecks().filter(c => c.id === `room-tasks:${code}`);
  assert.deepEqual(of().map(c => c.status), ['warn']);
  assert.match(first(of()).detail, /^not shown in the room session: task file 2\.json no longer reads as a task; the tasks are kept in the room/);
  identity.updateRoomClaude(code, () => ({ tasks_off: undefined }));
  assert.deepEqual(of(), []);
});

test('doctor: a link the host ended is not dialed (live: "reachable, speaking v3" for a revoked link)', async t => {
  const hostHome = h.freshHome(t);
  const code = h.newRoom();
  h.freshHome(t);
  links.set(code, { code, transport: { kind: 'pipe', home: hostHome }, refused: { at: new Date().toISOString(), reason: 'the host removed this machine', why: 'LINK_REVOKED' }, created_at: new Date().toISOString() });
  fs.writeFileSync(linkState.stateFile(code), JSON.stringify({ state: 'stopped', since: new Date().toISOString(), lastError: 'the host removed this machine from room x (/sub-human kick)', lastReason: 'LINK_REVOKED' }));
  const rep = await doctor.diagnose({ timeoutMs: 5000 });
  const d = must(rep.links.find(l => l.code === code), 'the link');
  assert.equal(d.reach, undefined, 'no hello');
  const c = byId(rep, `link:${code}`);
  assert.match(c.detail, /the host ended this machine's link: not dialed/);
  assert.doesNotMatch(c.detail, /speaking v/);
  assert.match(fixOf(c), /ask the host for a new invite/);
});

test('room tools: a failed start of the room server that Claude Code cached (15 min, every session) is a warn with the time left', t => {
  const dir = h.tmpDir('sh-cc-config-', t);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
  const now = 1_800_000_000_000;
  assert.equal(checkRoomTools({ env, now }).status, 'info', 'no cache file');
  fs.writeFileSync(path.join(dir, 'mcp-needs-auth-cache.json'), JSON.stringify({ 'plugin:sub-human:room': { timestamp: now - 4 * 60_000, id: 'x' }, other: { timestamp: now } }));
  const c = checkRoomTools({ env, now });
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /failed to start in a session here; Claude Code skips them in every session started in the next 11 min/);
  assert.match(c.fix ?? '', /\/mcp and reconnect plugin:sub-human:room/);
  assert.equal(checkRoomTools({ env, now: now + 12 * 60_000 }).status, 'info', 'expired');
});
