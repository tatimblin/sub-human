// An invite over ssh end to end, two homes and no sshd (test/support/fake-ssh.ts plays sshd for the host account the
// joiner logs into with their own ssh login). /sub-human invite --ssh shows `/sub-human join DEST ROOM SECRET --home H`
// and the PIN apart, and writes nothing to authorized_keys; the joiner's line dials through that login: the host's
// machine key is checked against the line before the SECRET goes, the host asks for the PIN, the PIN typed, the host
// person's card lets the machine in, a bare /sub-human seats it, bound to its name, under the link id its serve's argv
// carries (kick finds it). A joiner without a login of their own, or a line that names another host, sends nothing.
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as store from '../lib/room/store.ts';
import * as linkSocket from '../lib/remote/link-socket.ts';
import * as hostLinks from '../lib/remote/host-links.ts';
import * as admission from '../lib/remote/admission.ts';
import * as invites from '../lib/remote/invites.ts';
import * as inviteSecret from '../lib/remote/invite-secret.ts';
import * as links from '../lib/room/links.ts';
import * as identity from '../lib/identity.ts';
import * as h from './helpers.ts';
import { Machine, shownInvite } from './support/two-homes.ts';
import type { MachineRun } from './support/two-homes.ts';
import { fakeSsh } from './support/fake-ssh.ts';
import type { Invites, ShortInvite } from '../lib/remote/types-core.ts';

Object.assign(process.env, { SUB_HUMAN_CLAUDE: '/usr/bin/false', SUB_HUMAN_REAP_GRACE_MS: '0', SUB_HUMAN_REAP_WAIT_MS: '0' });

const LINK_ENV = { SUB_HUMAN_LINK_RETRY_MS: '200', SUB_HUMAN_LINK_RETRY_MAX_MS: '400', SUB_HUMAN_LINK_IDLE_MS: '3000' };
const childOf = (pid: number) => Number(spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.trim().split('\n')[0]) || null;
const kill = (pid: number | null) => { try { process.kill(pid as number, 'SIGKILL'); } catch { /* gone */ } };
const hiddenBlock = (r: MachineRun) => r.json && r.json.decision === 'block' && r.json.hookSpecificOutput && r.json.hookSpecificOutput.suppressOriginalPrompt === true;
const roomLines = (m: Machine, code: string) => m.lib(() => store.open(code).readAll()).filter(e => e.from === 'room').map(e => e.text);
const shortOf = (m: Machine, code: string, ref: string) => Object.entries(m.lib(() => store.open(code).kv.get<Invites>(invites.INVITES_KEY)) || {}).find(([k]) => k.startsWith(ref))![1] as ShortInvite;

function rig(t: TestContext, fake: Record<string, string> = {}) {
  const ak = path.join(h.tmpDir('sh-ak-', t), 'authorized_keys');
  const host = new Machine(t, 'host', { SUB_HUMAN_AUTHORIZED_KEYS: ak, SUB_HUMAN_REMOTE_LOGIN: 'on' });
  const remote = new Machine(t, 'remote', { ...LINK_ENV, PATH: `${fakeSsh(t)}:${process.env.PATH}`, FAKE_SSH_HOME: host.user, SUB_HUMAN_SSH_OPTS: undefined, ...fake });
  const alice = host.seat('alice'), bob = remote.seat('bob');
  assert.equal(host.join(alice, 'alice').json!.decision, undefined);
  const code = host.lib(() => store.listRooms()[0]);
  t.after(() => {
    const d = remote.lib(() => linkSocket.status(code));
    if (d.pid) { kill(childOf(d.pid)); kill(d.pid); }
    fs.rmSync(path.dirname(linkSocket.socketPath(path.join(remote.home, 'rooms', code))), { recursive: true, force: true });
  });
  return { host, remote, alice, bob, code, ak };
}

async function until<T>(fn: () => T, ms = 10_000, what = 'condition'): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 50))) { const v = fn(); if (v) return v; }
  throw new Error(`timed out waiting for ${what}`);
}

test('ssh invite: the line names the person\'s own ssh login (and the host\'s folder); nothing goes to authorized_keys; the line, the PIN, the card, the seat', async t => {
  const { host, remote, alice, bob, code, ak } = rig(t);
  const out = host.join(alice, 'invite --ssh me@devbox');
  assert.ok(hiddenBlock(out), out.stderr);
  const m = shownInvite(out.json!.reason!)!;
  assert.ok(m, out.json!.reason!);
  assert.equal(m.line, `join me@devbox ${code} ${m.word} --home ${host.home}`, 'a host folder that is not ~/.sub-human goes in the line');
  assert.match(out.json!.reason!, /Over ssh this needs their own ssh login to this account \(\S+\), set up as for any ssh login: sub-human writes nothing to authorized_keys\. No login here\? Invite them over the web: \/sub-human invite --web/);
  assert.equal(fs.existsSync(ak), false, 'no line written');
  assert.ok(fs.existsSync(path.join(host.home, 'bin', 'serve')), 'the shim their login runs');

  const typed = remote.join(bob, `${m.line} --as bob`);
  assert.ok(hiddenBlock(typed), typed.stderr);
  await until(() => remote.lib(() => !!(links.get(code) || {}).pin_wanted), 10_000, 'the host asking for the PIN');
  const lf = remote.lib(() => links.get(code))!;
  const t0 = lf.transport as { kind: string; user: string; host: string; login: boolean; link: string; remoteHome: string };
  assert.deepEqual([t0.kind, t0.user, t0.host, t0.login, t0.remoteHome], ['ssh', 'me', 'devbox', true, host.home], 'a login link');
  assert.match(t0.link, /^[0-9a-f]{12}$/);
  assert.ok(!('key' in t0) && !('knownHosts' in t0), 'no key or known_hosts of the plugin\'s');
  assert.equal(fs.existsSync(remote.lib(() => links.dirOf(code))), false, 'no key of its own: nothing in a link folder');

  const gave = remote.join(bob, `join ${m.pin}`);
  assert.match(gave.json!.reason!, /checked your PIN\. A card there now asks them to let you in as bob \(check [0-9a-f]{4}-[0-9a-f]{4}\)/);
  const req = host.lib(() => admission.pending(code))[0];
  assert.equal(req.link, t0.link, 'the request reserves the link id its login names');
  assert.equal(req.key, null);
  assert.match(host.join(alice, `admit ${req.ref}`).json!.reason!, /let in: bob/);
  await until(() => remote.lib(() => (links.get(code) || {}).token), 10_000, 'the token');
  const seated = remote.join(bob, '');
  assert.equal(seated.json!.decision, undefined, seated.stdout);
  await until(() => remote.lib(() => identity.resolveBySession(bob.sid)), 10_000, 'the seat');
  const link = host.lib(() => hostLinks.links(store.open(code)))[t0.link];
  assert.deepEqual([link.seats, link.bound, link.login, link.key], [['bob'], true, undefined, undefined], 'bound to bob alone; not a login link (no owner\'s consent)');
  assert.equal(fs.existsSync(ak), false, 'still nothing in authorized_keys');
  // kick ends it: its token, and its serve (found by the link id in its argv)
  assert.match(host.join(alice, 'kick bob').json!.reason!, /bob is out of room/);
  assert.equal(host.lib(() => hostLinks.links(store.open(code)))[t0.link], undefined);
});

test('ssh invite: a joiner with no ssh login of their own there sends nothing (no try spent) and is told to ask for a web invite; a line for another host neither', async t => {
  const { host, remote, alice, bob, code } = rig(t, { FAKE_SSH_FAIL: 'denied' });
  const m = shownInvite(host.join(alice, 'invite --ssh me@devbox').json!.reason!)!;
  const r = remote.join(bob, `${m.line} --as bob`);
  assert.match(r.json!.reason!, /could not join room \S+: me@devbox refused your ssh login: sub-human logs in with your ssh keys or agent only/);
  assert.equal(shortOf(host, code, m.word ? invites.inviteRef(inviteSecret.idOf(inviteSecret.decode(m.word)!.secret)) : '').tries, 5);

  // a line whose tag names another host's machine key: the host's proof does not match, so the SECRET never goes
  const other = new Machine(t, 'other', { ...LINK_ENV, PATH: `${fakeSsh(t)}:${process.env.PATH}`, FAKE_SSH_HOME: host.user, SUB_HUMAN_SSH_OPTS: undefined });
  const carol = other.seat('carol');
  t.after(() => { const d = other.lib(() => linkSocket.status(code)); if (d.pid) { kill(childOf(d.pid)); kill(d.pid); } });
  const m2 = shownInvite(host.join(alice, 'invite --ssh me@devbox').json!.reason!)!;
  const d = inviteSecret.decode(m2.word)!;
  const forged = inviteSecret.encode(d.secret, inviteSecret.tagOf(d.secret, 'machine', Buffer.alloc(32, 9).toString('base64url')));
  const before = roomLines(host, code).length;
  other.join(carol, `${m2.line.replace(m2.word, forged)} --as carol`);
  await until(() => other.lib(() => (links.get(code) || {}).refused), 10_000, 'the refusal');
  assert.match(other.lib(() => links.get(code))!.refused!.reason, /the host's machine key is not the one the invite line names: someone may be in between, or the line is for another host\. Nothing secret was sent/);
  assert.equal(other.lib(() => links.get(code))!.invite, undefined, 'the line is dropped');
  assert.equal(shortOf(host, code, invites.inviteRef(inviteSecret.idOf(d.secret))).tries, 5, 'no try spent');
  assert.equal(shortOf(host, code, invites.inviteRef(inviteSecret.idOf(d.secret))).used_at, undefined);
  assert.equal(roomLines(host, code).length, before, 'and the host heard nothing');
});
