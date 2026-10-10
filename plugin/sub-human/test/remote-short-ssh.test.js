'use strict';
// The invite over ssh end to end, two homes and no sshd: test/support/fake-ssh.js stands in for ssh + sshd (the
// host key it shows, authorized_keys and its forced commands). /sub-human invite --ssh writes the enrollment door (the
// room's public enrollment key, forced to `serve --enroll CODE --kind ssh`) and shows `/sub-human join DEST ROOM
// PIN`; the joiner's link runs the PAKE through the door, checks that the host key ssh saw is the one the host vouched
// for inside it, pins it, and makes its own key, which reaches nothing until the host person's card lets it in; then
// the door line is gone and the key's line is the usual one-link forced command. Someone in between (another host key
// shown) gets one try and nothing else.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./helpers.js');
const store = require(path.join(h.LIB, 'room', 'store.js'));
const link = require(path.join(h.LIB, 'remote', 'link.js'));
const auth = require(path.join(h.LIB, 'remote', 'auth.js'));
const sshkeys = require(path.join(h.LIB, 'remote', 'sshkeys.js'));
const admission = require(path.join(h.LIB, 'remote', 'admission.js'));
const { Machine } = require('./support/two-homes.js');
const { fakeSsh } = require('./support/fake-ssh.js');

const childOf = pid => Number(spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.trim().split('\n')[0]) || null;
const kill = pid => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };
const hiddenBlock = r => r.json && r.json.decision === 'block' && r.json.hookSpecificOutput && r.json.hookSpecificOutput.suppressOriginalPrompt === true;
const keygen = file => spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file]).status === 0;

function rig(t, { shown } = {}) {
  const keys = h.tmpDir('sh-sshd-', t);
  const hostKey = path.join(keys, 'ssh_host_ed25519_key');
  if (!keygen(hostKey)) return null;
  let shownKey = null;
  if (shown) { shownKey = path.join(keys, 'mitm_key'); keygen(shownKey); }
  const ak = path.join(keys, 'authorized_keys');
  const bin = fakeSsh(h.tmpDir('sh-fakessh-', t));
  const host = new Machine(t, 'host', { SUB_HUMAN_SSH_HOST_KEY: `${hostKey}.pub`, SUB_HUMAN_AUTHORIZED_KEYS: ak, SUB_HUMAN_ALLOW_TMP_ROOT: '1' });
  const remote = new Machine(t, 'remote', {
    PATH: `${bin}:${process.env.PATH}`, FAKE_SSHD_HOST_KEY: `${hostKey}.pub`, FAKE_SSHD_AUTHORIZED_KEYS: ak,
    ...(shownKey ? { FAKE_SSHD_SHOWN_KEY: `${shownKey}.pub` } : {}),
    SUB_HUMAN_LINK_RETRY_MS: '200', SUB_HUMAN_LINK_RETRY_MAX_MS: '400', SUB_HUMAN_LINK_IDLE_MS: '3000',
  });
  const alice = host.seat('alice'), bob = remote.seat('bob');
  assert.equal(host.join(alice, 'alice').json.decision, undefined);
  const code = host.lib(() => store.listRooms()[0]);
  t.after(() => {
    const d = remote.lib(() => link.status(code));
    if (d.pid) { kill(childOf(d.pid)); kill(d.pid); }
    fs.rmSync(path.dirname(link.socketPath(path.join(remote.home, 'rooms', code))), { recursive: true, force: true });
  });
  return { host, remote, alice, bob, code, ak, hostKey: sshkeys.ed25519Raw(fs.readFileSync(`${hostKey}.pub`, 'utf8')) };
}

const doorLines = (ak, code) => (fs.existsSync(ak) ? fs.readFileSync(ak, 'utf8').split('\n').filter(l => l.endsWith(` sub-human-enroll:${code}`)) : []);
const shown = reason => /\/sub-human join (\S+) ([a-z]+-\d{4}) (\d{4})/.exec(reason);

test('ssh invite: the door, the PAKE through it, the vouched host key pinned, the joiner\'s own key let in by the host person\'s card', async t => {
  const R = rig(t);
  if (!R) return t.skip('no ssh-keygen');
  const { host, remote, alice, bob, code, ak, hostKey } = R;
  const out = host.join(alice, 'invite --ssh me@127.0.0.1:2222');
  assert.ok(hiddenBlock(out), out.stderr);
  const m = shown(out.json.reason);
  assert.ok(m, out.json.reason);
  assert.deepEqual([m[1], m[2]], ['me@127.0.0.1:2222', code]);
  assert.match(out.json.reason, new RegExp(`ssh host key ${sshkeys.fingerprint(hostKey).replace(/[+/]/g, '\\$&')}`));
  assert.equal(doorLines(ak, code).length, 1, 'the door is open while the code is');
  assert.match(doorLines(ak, code)[0], new RegExp(`^command="SUB_HUMAN_HOME=${host.home} ${host.home}/bin/serve --enroll ${code} --kind ssh",restrict `));

  const j = remote.join(bob, `join me@127.0.0.1:2222 ${code} ${m[3]} --as bob`);
  assert.ok(hiddenBlock(j), j.stderr);
  assert.match(j.json.reason, /checked your PIN\. A card there now asks them to let you in as bob \(SHA256:/, (() => { try { return fs.readFileSync(path.join(remote.home, 'links', `${code}.log`), 'utf8'); } catch (e) { return e.message; } })());
  const dir = path.join(remote.home, 'links', code);
  const lf = JSON.parse(fs.readFileSync(path.join(remote.home, 'links', `${code}.json`), 'utf8'));
  assert.deepEqual(lf.transport, { kind: 'ssh', user: 'me', host: '127.0.0.1', port: 2222, key: path.join(dir, 'id_ed25519'), knownHosts: path.join(dir, 'known_hosts'), alias: `sub-human-${code}` });
  assert.equal(fs.readFileSync(path.join(dir, 'known_hosts'), 'utf8'), `sub-human-${code} ${sshkeys.openssh(hostKey)}\n`, 'the vouched key, pinned');
  assert.equal('enroll' in lf, false);
  assert.equal(doorLines(ak, code).length, 0, 'the door closed once no code is open');
  const joinerKey = sshkeys.ed25519Raw(fs.readFileSync(path.join(dir, 'id_ed25519.pub'), 'utf8'));
  assert.equal(lf.awaiting.check, sshkeys.fingerprint(joinerKey));
  assert.ok(!fs.readFileSync(ak, 'utf8').includes(sshkeys.openssh(joinerKey).split(' ')[1]), 'the joiner\'s key is not let in yet');

  const req = host.lib(() => admission.pending(code))[0];
  assert.equal(req.key, joinerKey, 'the key the host lets in is the one the joiner made');
  const pre = host.hook('consent', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: `admit ${req.ref}` }] } }, alice);
  const c = pre.json.hookSpecificOutput.updatedInput;
  assert.match(c.questions[0].question, new RegExp(`^Let bob \\(${sshkeys.fingerprint(joinerKey).replace(/[+/]/g, '\\$&')}\\) on \\S+ join room ${code}\\?`));
  host.hook('consent', { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: c, tool_response: { questions: c.questions, answers: { [c.questions[0].question]: 'Let in' } } }, alice);
  const id = req.link;
  assert.deepEqual(fs.readFileSync(ak, 'utf8').trim().split('\n').filter(Boolean),
    [`command="SUB_HUMAN_HOME=${host.home} ${host.home}/bin/serve --stdio ${code} --link ${id}",restrict ${sshkeys.openssh(joinerKey)} sub-human:${code}:${id}`]);
  assert.ok(await h.until(() => remote.lib(() => link.status(code)).state === 'online', 15_000, 50), 'online over ssh once let in');
  assert.equal(remote.join(bob, '').json.decision, undefined, 'a bare /sub-human takes the seat');
  const r = remote.say(bob, 'hello over a short code');
  assert.equal(r.json && r.json.continue, false);
  assert.ok(host.lib(() => store.open(code).readAll()).some(e => e.text === 'hello over a short code'));
  // kick: the key line goes; the link stops for good
  assert.match(host.join(alice, 'kick bob').json.reason, /bob is out of room/);
  assert.equal(fs.readFileSync(ak, 'utf8').trim(), '', 'the key line is gone');
  assert.ok(await h.until(() => remote.lib(() => link.status(code)).state === 'stopped', 15_000, 50));
});

test('ssh invite: someone in between (another host key shown) gets one try, nothing more; the joiner says so and keeps nothing', async t => {
  const R = rig(t, { shown: true });
  if (!R) return t.skip('no ssh-keygen');
  const { host, remote, alice, bob, code, ak } = R;
  const m = shown(host.join(alice, 'invite --ssh me@127.0.0.1:2222').json.reason);
  const j = remote.join(bob, `join me@127.0.0.1:2222 ${code} ${m[3]} --as bob`);
  assert.ok(hiddenBlock(j));
  assert.match(j.json.reason, /could not join room \S+: the ssh server that answered is not the one that holds your PIN/);
  const lf = JSON.parse(fs.readFileSync(path.join(remote.home, 'links', `${code}.json`), 'utf8'));
  assert.equal('enroll' in lf, false, 'the PIN is dropped');
  assert.equal(host.lib(() => admission.pending(code)).length, 0, 'nothing waits for the host person');
  const inv = Object.values(host.lib(() => store.open(code).kv.get(auth.INVITES_KEY)))[0];
  assert.equal(inv.tries, 4, 'one try spent');
  assert.equal(doorLines(ak, code).length, 1, 'the door stays while the code is open');
  // the host cancels that invite: the door goes, and a join to it says so at once (no retrying a shut door)
  for (const k of Object.keys(host.lib(() => store.open(code).kv.get(auth.INVITES_KEY)))) host.join(alice, `invite --cancel ${k.slice(0, 12)}`);
  assert.equal(doorLines(ak, code).length, 0, 'no invite open: no door');
  const shut = remote.join(bob, `join me@127.0.0.1:2222 ${code} ${m[3]} --as bob`);
  assert.match(shut.json.reason, /could not join room \S+: the host's door for PINs to room \S+ is shut/);
});
