// The host's invite over ssh, without sshd (the dial through an ssh login is test/remote-invite-ssh.node-test.ts, and the
// lab): `/sub-human invite` shows `/sub-human join DEST ROOM SECRET [--via J] [--home H]` with the PIN apart and no
// NAME, and writes nothing to authorized_keys; the CLI's `sub-human invite` does the same in a terminal (the SECRET and
// the PIN masked inside Claude Code); a linked machine given another invite to the same host through the same bastion
// is linked already.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { TestContext } from 'node:test';
import * as h from './helpers.ts';
import * as store from '../lib/room/store.ts';
import * as inviteSecret from '../lib/remote/invite-secret.ts';
import { Machine, type MachineRun } from './support/two-homes.ts';
import * as invites from '../lib/remote/invites.ts';
import * as links from '../lib/room/links.ts';
import type { Invites } from '../lib/remote/types-core.ts';
import type { SshSpec } from '../lib/remote/types-rest.ts';

const hiddenBlock = (r: MachineRun) => r.json && r.json.decision === 'block' && r.json.hookSpecificOutput && r.json.hookSpecificOutput.suppressOriginalPrompt === true;

function room(t: TestContext) {
  const host = new Machine(t, 'host'), remote = new Machine(t, 'remote');
  const alice = host.seat('alice'), bob = remote.seat('bob');
  assert.equal(host.join(alice, 'alice').json!.decision, undefined);
  const code = host.lib(() => store.listRooms()[0]);
  return { host, remote, alice, bob, code };
}

test('invite over ssh: the line with --via, the host folder and no NAME, the PIN apart; nothing in authorized_keys; the CLI the same, masked inside Claude Code', t => {
  const { host, alice, code } = room(t);
  const ak = path.join(host.user, '.ssh', 'authorized_keys');
  const env = { SUB_HUMAN_ALLOW_TMP_ROOT: '1', SUB_HUMAN_AUTHORIZED_KEYS: ak };
  Object.assign(host.extra, env);
  const esc = (x: string) => x.replace(/[.]/g, '\\.');
  const shown = host.join(alice, 'invite --ssh me@127.0.0.1:1 --via jump.example');
  assert.ok(hiddenBlock(shown), shown.stderr);
  assert.equal(shown.json!.systemMessage, undefined, 'the SECRET and the PIN stay off Remote Control');
  assert.match(shown.json!.reason!, new RegExp(`\n  /sub-human join me@127\\.0\\.0\\.1:1 ${code} [0-9a-z]{39} --via jump\\.example --home ${esc(host.home)}\n`));
  assert.match(shown.json!.reason!, /apart from the line \(say it, or send it another way\): \d{4}\n/);
  assert.match(shown.json!.reason!, /their own ssh login to this account/);
  assert.equal(fs.existsSync(ak), false, 'no door, no line');
  assert.match(host.join(alice, 'invite --ssh -oProxyCommand=x@far').json!.reason!, /not a plain user@host/);
  assert.match(host.join(alice, 'invite --ssh me@far --via -oX').json!.reason!, /--via .* is not a plain/);
  assert.match(host.join(alice, 'invite --ssh YOU@far').json!.reason!, /placeholder/);
  // a bare ssh alias: the line names it as given (the joiner's own config resolves it); the record holds user@alias
  // as this machine's ssh reads it (SUB_HUMAN_SSH_OPTS's -F config: its User)
  const cfg = path.join(host.user, 'ssh_config');
  fs.writeFileSync(cfg, 'Host devbox\n  HostName 127.0.0.1\n  Port 2222\n  User dev\n');
  const aliasEnv = { ...host.extra };
  Object.assign(host.extra, { SUB_HUMAN_SSH_OPTS: `-F ${cfg}` });
  const al = host.join(alice, 'invite --ssh devbox');
  Object.keys(host.extra).forEach(k => { if (!(k in aliasEnv)) delete host.extra[k]; });
  assert.ok(hiddenBlock(al), al.stderr);
  assert.match(al.json!.reason!, new RegExp(`\n  /sub-human join devbox ${code} [0-9a-z]{39} --home \\S+\n`));
  assert.match(al.json!.reason!, /over ssh devbox\./);
  const locs = Object.values(host.lib(() => store.open(code).kv.get<Invites>(invites.INVITES_KEY)) || {}).map(i => (i as { locator?: string }).locator); // an admission record has none
  assert.ok(locs.includes('ssh:dev@devbox'), JSON.stringify(locs));
  host.join(alice, `invite --cancel ${/invite --cancel ([0-9a-f]{12})/.exec(al.json!.reason!)![1]}`);

  // the CLI: --ssh alone (or nothing) is this machine's own address
  const cli = (args: string[], extra: Record<string, string> = {}) => spawnSync(process.execPath, [h.BIN, ...args], { env: host.env(null, { ...env, ...extra }), encoding: 'utf8' });
  const out = cli(['invite', '--room', code], { SUB_HUMAN_SSH_ADDR: 'dev@box.example:2222' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, new RegExp(`\n  /sub-human join dev@box\\.example:2222 ${code} [0-9a-z]{39} --home \\S+\n`));
  // inside Claude Code (its ! shell: CLAUDECODE=1) the output is model input: the SECRET and the PIN are masked
  const inCc = cli(['invite', '--room', code], { SUB_HUMAN_SSH_ADDR: 'dev@box.example:2222', CLAUDECODE: '1' });
  assert.equal(inCc.status, 0, inCc.stderr);
  assert.doesNotMatch(inCc.stdout, /[0-9a-z]{39}/);
  assert.doesNotMatch(inCc.stdout, /another way\): \d{4}/);
  assert.match(inCc.stdout, new RegExp(`${code} #### --home[\\s\\S]*PIN and SECRET hidden: this ran inside Claude Code.*/sub-human invite in the room`));
  assert.equal(cli(['invite', '--ssh', 'bad host', '--room', code]).status, 1);
  assert.equal(cli(['invite', '--pipe', '--web', '--room', code]).status, 2);
  assert.equal(cli(['admit', 'shk1.nope', '--yes']).status, 2);
  assert.equal(cli(['kick']).status, 2);
  for (const gone of ['host', 'unhost', 'revoke', 'authorize']) assert.equal(cli([gone]).status, 2, gone);
  const cancel = cli(['invite', '--cancel', '--room', code]);
  assert.match(cancel.stdout, /has 3 open invites/);
  assert.equal(fs.existsSync(ak), false, 'still nothing in authorized_keys');
});

test('join: a linked machine given another invite to the same host through the same bastion is linked already, not a move', t => {
  const { remote, bob, code } = room(t);
  const transport: SshSpec = { kind: 'ssh', user: 'host', host: 'devbox', via: 'jump@bastion' };
  remote.lib(() => links.set(code, { code, transport, token: 'tok', created_at: new Date().toISOString() }));
  const r = remote.join(bob, `join host@devbox ${code} ${inviteSecret.encode(inviteSecret.mint(), Buffer.alloc(8))} --via jump@bastion`);
  assert.ok(hiddenBlock(r));
  assert.match(r.json!.reason!, /this machine is in room .* already; \/sub-human \S+ \S+ takes your place there/, r.json!.reason);
  const kept = remote.lib(() => links.get(code))!;
  assert.deepEqual([kept.token, kept.rebind], ['tok', undefined], 'the working link is kept, its token not replaced');
});
