'use strict';
// sh2 invites end to end over the pipe transport, two homes on one machine (test/support/two-homes.js): the host's
// /sub-human host shows an invite and its PIN to the person only; the joiner's /sub-human join NAME INVITE PIN links
// (the host checks the PIN online) in a step that is always a hidden block, so neither the invite nor the PIN reaches
// the model; then /sub-human NAME CODE takes the seat. A wrong PIN costs a try and the room hears it; the fifth burns
// the invite; a rejoin never re-sends a refused PIN. revoke ends a link. The ssh pieces that need no sshd (the
// joiner's own key, the pinned host key, the admit request and the host's authorized_keys line) run here too.
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
const { Machine } = require('./support/two-homes.js');

const LINK_ENV = { SUB_HUMAN_LINK_RETRY_MS: '300', SUB_HUMAN_LINK_IDLE_MS: '1500' };
const childOf = pid => Number(spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.trim().split('\n')[0]) || null;
const kill = pid => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };
const stopDaemon = (t, m, code) => t.after(() => {
  const d = m.lib(() => link.status(code));
  if (d.pid) { kill(childOf(d.pid)); kill(d.pid); }
  fs.rmSync(path.dirname(link.socketPath(path.join(m.home, 'rooms', code))), { recursive: true, force: true });
});
const shownInvite = reason => ({ invite: /sh2\.\S+/.exec(reason)[0], pin: /PIN (\d{6})/.exec(reason)[1] });
const hiddenBlock = r => r.json && r.json.decision === 'block' && r.json.hookSpecificOutput && r.json.hookSpecificOutput.suppressOriginalPrompt === true;
/** Everything a hook's output gives the model or Remote Control (the block reason is the person's terminal only). */
const modelSees = r => JSON.stringify([r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext, r.json && r.json.systemMessage]);

function room(t) {
  const host = new Machine(t, 'host'), remote = new Machine(t, 'remote', LINK_ENV);
  const alice = host.seat('alice'), bob = remote.seat('bob');
  assert.equal(host.join(alice, 'alice').json.decision, undefined);
  const code = host.lib(() => store.listRooms()[0]);
  return { host, remote, alice, bob, code };
}

test('sh2 over pipe: host shows invite + PIN to the person only; join NAME INVITE PIN links in a hidden step (the PIN never reaches the model); /sub-human NAME CODE seats; revoke ends it', async t => {
  const { host, remote, alice, bob, code } = room(t);
  const shown = host.join(alice, 'host');
  assert.ok(hiddenBlock(shown), 'the host\'s invite: a block, its prompt hidden');
  assert.equal(shown.json.systemMessage, undefined, 'never a systemMessage (Remote Control would carry it off)');
  const { invite, pin } = shownInvite(shown.json.reason);
  assert.match(shown.json.reason, new RegExp(`/sub-human join NAME ${invite.replace(/[.]/g, '\\.')} PIN`));
  assert.ok(!invite.includes(pin), 'the PIN is not inside the invite');
  assert.equal(auth.parseInvite(invite).locator, `pipe:${host.home}`);

  const linked = remote.join(bob, `join bob ${invite} ${pin}`);
  stopDaemon(t, remote, code);
  assert.ok(hiddenBlock(linked), linked.stderr);
  assert.match(linked.json.reason, new RegExp(`linked to room ${code}: the host checked your PIN\\. Now type: /sub-human bob ${code}`));
  assert.ok(!modelSees(linked).includes(pin) && !modelSees(linked).includes(invite), 'neither PIN nor invite in what the model or Remote Control get');
  assert.ok(!linked.json.reason.includes(pin), 'the PIN is not echoed');
  const lf = JSON.parse(fs.readFileSync(path.join(remote.home, 'links', `${code}.json`), 'utf8'));
  assert.deepEqual([typeof lf.token, 'pin' in lf, 'invite' in lf], ['string', false, false], 'the PIN went with the invite');
  const said = host.lib(() => store.open(code).readAll()).filter(e => e.from === 'room' && e.kind === 'status').map(e => e.text);
  assert.match(said.join('\n'), /linked to the room with an invite and its PIN \(link [0-9a-f]{12}\)/);

  // the seat: a plain rejoin, whose prompt holds no secret
  const seated = remote.join(bob, `bob ${code}`);
  assert.equal(seated.json.decision, undefined, seated.json.reason);
  assert.match(seated.json.hookSpecificOutput.additionalContext, /SUB-HUMAN: you are bob's Claude/);
  assert.ok(!modelSees(seated).includes(pin));
  assert.equal(remote.say(bob, 'hello over sh2').json.continue, false);
  assert.equal(host.lib(() => store.open(code).readAll()).at(-1).text, 'hello over sh2');
  assert.equal(remote.log(code), host.log(code));

  // the invite is spent: a second machine cannot use it, PIN or not
  const third = new Machine(t, 'third', LINK_ENV);
  const carol = third.seat('carol');
  const again = third.join(carol, `join carol ${invite} ${pin}`);
  stopDaemon(t, third, code);
  assert.ok(hiddenBlock(again));
  assert.match(again.json.reason, /could not link .*unknown or was used already/);

  // revoke by name, from the host's session: the token is burnt, bob leaves, the room hears it
  const linkId = lf.transport && host.lib(() => Object.keys(auth.links(store.open(code))))[0];
  const rv = host.join(alice, 'revoke bob');
  assert.ok(hiddenBlock(rv));
  assert.match(rv.json.reason, new RegExp(`revoked link ${linkId} of room ${code}: token burnt.*bob left`));
  const after = host.lib(() => store.open(code).readAll());
  assert.ok(after.some(e => e.kind === 'member_left' && e.from === 'bob' && /revoked by the host/.test(e.text)));
  assert.ok(after.some(e => e.from === 'room' && new RegExp(`the host revoked link ${linkId} \\(bob\\)`).test(e.text)));
  assert.deepEqual(host.lib(() => auth.links(store.open(code))), {});
});

test('sh2: a wrong PIN costs a try (the room hears it) and is never re-sent by a rejoin; the right PIN then links; five wrong ones burn the invite', async t => {
  const { host, remote, alice, bob, code } = room(t);
  const { invite, pin } = shownInvite(host.join(alice, 'host').json.reason);
  const wrong = String((Number(pin) + 1) % 1e6).padStart(6, '0');
  const r1 = remote.join(bob, `join bob ${invite} ${wrong}`);
  stopDaemon(t, remote, code);
  assert.ok(hiddenBlock(r1));
  assert.match(r1.json.reason, /could not link to room .*wrong PIN \(4 tries left\)/);
  assert.ok(!r1.json.reason.includes(wrong), 'the typed PIN is not echoed');
  // a rejoin does not start the link again with the refused PIN
  const r2 = remote.join(bob, `bob ${code}`);
  assert.equal(r2.json.decision, 'block');
  assert.match(r2.json.reason, /wrong PIN \(4 tries left\)/);
  const tries = () => Object.values(host.lib(() => store.open(code).kv.get(auth.INVITES_KEY))).find(i => i.v === 2).tries;
  assert.equal(tries(), 4, 'the rejoin spent nothing');
  assert.match(host.lib(() => store.open(code).readAll()).map(e => e.text).join('\n'), /a wrong PIN for an invite \(4 tries left\)/);
  // the right PIN still works
  const r3 = remote.join(bob, `join bob ${invite} ${pin}`);
  assert.match(r3.json.reason, /linked to room/);
  assert.equal(remote.join(bob, `bob ${code}`).json.decision, undefined);

  // a fresh invite, five wrong PINs: burnt
  const other = new Machine(t, 'other', LINK_ENV);
  const dan = other.seat('dan');
  const inv2 = shownInvite(host.join(alice, 'host').json.reason);
  const bad = String((Number(inv2.pin) + 3) % 1e6).padStart(6, '0');
  let last;
  for (let i = 0; i < 5; i++) last = other.join(dan, `join dan ${inv2.invite} ${bad}`);
  stopDaemon(t, other, code);
  assert.match(last.json.reason, /last try: the invite is burnt/);
  assert.match(other.join(dan, `join dan ${inv2.invite} ${inv2.pin}`).json.reason, /unknown or was used already/);
  assert.match(host.lib(() => store.open(code).readAll()).map(e => e.text).join('\n'), /an invite was burnt after its last wrong PIN/);
});

test('sh2: what a join refuses is hidden too; an sh1 invite still joins in one step', t => {
  const { host, remote, alice, bob, code } = room(t);
  const { invite } = shownInvite(host.join(alice, 'host').json.reason);
  const cases = [
    [`join bob ${invite}`, /needs the 6-digit PIN/],
    [`join bob ${invite} 12345`, /the PIN is 6 digits/],
    [`join bob ${invite} 123456 extra`, /usage/],
    [`join b@d ${invite} 123456`, /invalid name/],
    ['join bob nonsense 123456', /not an invite/],
  ];
  for (const [args, re] of cases) {
    const r = remote.join(bob, args);
    assert.ok(hiddenBlock(r), args);
    assert.match(r.json.reason, re, args);
    assert.ok(!modelSees(r).includes('123456'), args);
  }
  assert.equal(fs.existsSync(path.join(remote.home, 'links', `${code}.json`)), false, 'nothing linked');
  assert.match(host.join(alice, 'join bob ' + invite + ' 000000').json.reason, /hosted on this machine/);

  // sh1 (sub-human invite) keeps working, in one step
  const sh1 = spawnSync(process.execPath, [h.BIN, 'invite', '--room', code], { env: host.env(null), encoding: 'utf8' }).stdout.trim();
  assert.match(sh1, /^sh1\./);
  const r = remote.join(bob, `join bob ${sh1}`);
  stopDaemon(t, remote, code);
  assert.equal(r.json.decision, undefined, r.json.reason);
  assert.match(remote.join(bob, `join bob ${sh1} 123456`).json.reason, /takes no PIN/);
});

test('sh2 over ssh, without sshd: the joiner pins the host key and makes its own key; its admit request lets that key reach only this room\'s link; the host\'s person sees what they admit', t => {
  const { host, remote, alice, bob, code } = room(t);
  const hostKeyFile = path.join(host.user, 'ssh_host_ed25519_key');
  spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKeyFile]);
  const ak = path.join(host.user, '.ssh', 'authorized_keys');
  const env = { SUB_HUMAN_SSH_HOST_KEY: `${hostKeyFile}.pub`, SUB_HUMAN_ALLOW_TMP_ROOT: '1', SUB_HUMAN_AUTHORIZED_KEYS: ak };
  Object.assign(host.extra, env);
  const shown = host.join(alice, 'host --ssh me@127.0.0.1:1 --via jump.example');
  assert.ok(hiddenBlock(shown), shown.stderr);
  const { invite, pin } = shownInvite(shown.json.reason);
  const hk = sshkeys.ed25519Raw(fs.readFileSync(`${hostKeyFile}.pub`, 'utf8'));
  assert.deepEqual(auth.parseInvite(invite).hostKey, hk);
  assert.equal(auth.parseInvite(invite).locator, 'ssh:me@127.0.0.1:1?via=jump.example');
  assert.match(shown.json.reason, new RegExp(`pins this machine's ssh host key ${sshkeys.fingerprint(hk).replace(/[+/]/g, '\\$&')}`));
  assert.match(host.join(alice, 'host --ssh -oProxyCommand=x@far').json.reason, /not a plain user@host/);
  assert.match(host.join(alice, 'host --ssh me@far --via -oX').json.reason, /--via .* is not a plain/);

  // the joiner: nothing listens on port 1, so ssh fails and the join shows the admit line
  const j = remote.join(bob, `join bob ${invite} ${pin}`);
  stopDaemon(t, remote, code);
  assert.ok(hiddenBlock(j), j.stderr);
  const request = /\/sub-human admit (shk1\.\S+)/.exec(j.json.reason)[1];
  assert.ok(!request.includes(pin) && !request.includes(auth.parseInvite(invite).secret), 'the request holds no secret');
  assert.match(j.json.reason, new RegExp(`Once they have, type: /sub-human bob ${code}`));
  const dir = path.join(remote.home, 'links', code);
  const lf = JSON.parse(fs.readFileSync(path.join(remote.home, 'links', `${code}.json`), 'utf8'));
  assert.deepEqual(lf.transport, { kind: 'ssh', user: 'me', host: '127.0.0.1', port: 1, via: 'jump.example', key: path.join(dir, 'id_ed25519'), knownHosts: path.join(dir, 'known_hosts'), alias: `sub-human-${code}` });
  assert.equal(fs.statSync(path.join(dir, 'id_ed25519')).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(dir, 'known_hosts'), 'utf8'), `sub-human-${code} ${sshkeys.openssh(hk)}\n`);
  const cmd = remote.lib(() => link.sshCommand(lf.transport, code, []));
  assert.deepEqual(cmd.slice(8), ['-i', lf.transport.key, '-o', 'IdentitiesOnly=yes', '-o', `UserKnownHostsFile=${lf.transport.knownHosts}`, '-o', 'StrictHostKeyChecking=yes',
    '-o', `HostKeyAlias=sub-human-${code}`, '-J', 'jump.example', '-p', '1', '--', 'me@127.0.0.1', `sub-human serve --stdio ${code}`]);
  // a rejoin before the host admitted: the same line again, and no seat
  const early = remote.join(bob, `bob ${code}`);
  assert.match(early.json.reason, /the host has to let it in first/);

  // the host admits it: one forced-command line for the reserved link, the room hears it
  const ad = host.join(alice, `admit ${request}`);
  assert.ok(hiddenBlock(ad), ad.stderr);
  const joinerKey = sshkeys.ed25519Raw(fs.readFileSync(path.join(dir, 'id_ed25519.pub'), 'utf8'));
  assert.match(ad.json.reason, new RegExp(`admitted: bob's key ${sshkeys.fingerprint(joinerKey).replace(/[+/]/g, '\\$&')} may reach room ${code} as link ([0-9a-f]{12})`));
  const id = /as link ([0-9a-f]{12})/.exec(ad.json.reason)[1];
  const lines = fs.readFileSync(ak, 'utf8').trim().split('\n');
  assert.deepEqual(lines, [`command="SUB_HUMAN_HOME=${host.home} ${host.home}/bin/serve --stdio ${code} --link ${id}",restrict ${sshkeys.openssh(joinerKey)} sub-human:${code}:${id}`]);
  assert.match(host.join(alice, `admit ${request}`).json.reason, /already admitted/);
  assert.match(host.lib(() => store.open(code).readAll()).map(e => e.text).join('\n'), new RegExp(`the host admitted a key for bob .* to link ${id}`));
  assert.match(host.join(alice, 'admit shk1.nope').json.reason, /not an admit request/);

  // the CLI revoke by link id: the line goes, the reserved invite burns
  const rv = spawnSync(process.execPath, [h.BIN, 'revoke', id, '--room', code], { env: host.env(null, env), encoding: 'utf8' });
  assert.equal(rv.status, 0, rv.stderr);
  assert.match(rv.stdout, new RegExp(`revoked link ${id} of room ${code}: token burnt, 1 invite\\(s\\) burnt, 1 authorized_keys line`));
  assert.equal(fs.readFileSync(ak, 'utf8').trim(), '');

  // the CLI's one step: --ssh alone is this machine's own address; admit asks nothing with --yes (no terminal here)
  const cli = (args, extra = {}) => spawnSync(process.execPath, [h.BIN, ...args], { env: host.env(null, { ...env, ...extra }), encoding: 'utf8' });
  const out = cli(['host', '--ssh', '--room', code], { SUB_HUMAN_SSH_ADDR: 'dev@box.example:2222' });
  assert.equal(out.status, 0, out.stderr);
  const inv3 = /sh2\.\S+/.exec(out.stdout)[0];
  assert.equal(auth.parseInvite(inv3).locator, 'ssh:dev@box.example:2222');
  assert.match(out.stdout, /\nPIN \d{6} /);
  assert.equal(cli(['host', '--ssh', 'bad host', '--room', code]).status, 1);
  assert.equal(cli(['admit', 'shk1.nope', '--yes']).status, 1);
  assert.equal(cli(['revoke']).status, 2);
});

test('join: a linked machine given another invite to the same host through the same bastion is linked already, not a move', t => {
  const { remote, bob, code } = room(t);
  const links = require(path.join(h.LIB, 'room', 'links.js'));
  const transport = { kind: 'ssh', user: 'host', host: 'devbox', via: 'jump@bastion' };
  remote.lib(() => links.set(code, { code, transport, token: 'tok', created_at: new Date().toISOString() }));
  const invite = auth.formatInvite({ v: 2, code, locator: 'ssh:host@devbox?via=jump@bastion', secret: 'A'.repeat(22) });
  const r = remote.join(bob, `join bob ${invite} 123456`);
  assert.match(r.json.reason, /linked to room .* already/, r.json.reason);
  const kept = remote.lib(() => links.get(code));
  assert.deepEqual([kept.token, kept.rebind], ['tok', undefined], 'the working link is kept, its token not replaced');
});

test('sshkeys.linkKey: the link\'s own key pair is private, the .pub too (nothing in the store is group/world-readable)', t => {
  const dir = path.join(h.tmpDir('sh-lk-', t), 'links', 'vole-1234');
  const k = sshkeys.linkKey(dir, 'sub-human:vole-1234:bob');
  assert.equal(fs.statSync(k.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(`${k.file}.pub`).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});
