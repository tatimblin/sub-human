// Reconnect hardening end to end: two homes on one machine (test/support/two-homes.ts), bob's real link daemon and
// the host's real `serve --stdio` children over the pipe transport. A server that stops answering (SIGSTOP: the pipe
// stays open, a half-open link) is caught by a missed pong and replaced, make before break; a daemon frozen past
// the wake gap (SIGSTOP/SIGCONT, as a sleep looks to it) redials at once; a seat whose lease lapsed on the host while
// the link was down is renewed on reconnect with no "left"/"joined" line. Every time the mirror stays
// byte-identical to the host's log with no duplicate line. The outbox end to end is in test/remote-e2e.node-test.ts.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as h from './helpers.ts';
import * as store from '../lib/room/store.ts';
import * as link from '../lib/remote/link.ts';
import * as links from '../lib/room/links.ts';
import { leaseFresh } from '../lib/room/members.ts';
import { isAlive } from '../lib/io.ts';
import { Machine } from './support/two-homes.ts';

const BASE = {
  SUB_HUMAN_LINK_IDLE_MS: '1500', SUB_HUMAN_LINK_RETRY_MS: '300', SUB_HUMAN_LINK_RETRY_MAX_MS: '600',
  SUB_HUMAN_LINK_PING_MS: '300', SUB_HUMAN_LINK_PONG_MS: '400', SUB_HUMAN_LINK_DEAD_MS: '1500',
  SUB_HUMAN_LINK_WAKE_TICK_MS: '200', SUB_HUMAN_LINK_WAKE_GAP_MS: '1000',
};

const children = (pid: number | undefined) => spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).map(Number);
// a missing pid throws in process.kill and is ignored, like a gone one
const signal = (pid: number | undefined, sig: NodeJS.Signals) => { try { process.kill(pid as number, sig); } catch { /* gone */ } };
const ids = (log: string) => log.split('\n').filter(Boolean).map(l => JSON.parse(l).id);

/** alice hosts, bob joins from the other home; returns what the tests need, cleaned up when the test ends. */
async function room(t: TestContext, env?: Record<string, string>) {
  const host = new Machine(t, 'host'), remote = new Machine(t, 'remote', { ...BASE, ...env });
  const alice = host.seat('alice'), bob = remote.seat('bob');
  host.join(alice, 'alice');
  const code = host.lib(() => store.listRooms()[0]);
  // an invite and its PIN: the PIN goes into the PAKE only; every redial below says hello with the token
  const { seated: joined } = await remote.joinVia(host, alice, bob);
  const lf = JSON.parse(fs.readFileSync(path.join(remote.home, 'links', `${code}.json`), 'utf8'));
  assert.deepEqual(['enroll' in lf, 'invite' in lf, typeof lf.token], [false, false, 'string']);
  assert.equal(joined.json!.systemMessage, undefined, joined.stderr);
  const daemon = remote.lib(() => link.status(code)).pid;
  t.after(() => {
    for (const c of children(daemon)) signal(c, 'SIGKILL');
    signal(daemon, 'SIGCONT');
    signal(daemon, 'SIGKILL');
    fs.rmSync(path.dirname(link.socketPath(path.join(remote.home, 'rooms', code))), { recursive: true, force: true });
  });
  const st = () => remote.lib(() => links.readState(code)) || {};
  const daemonLog = () => fs.readFileSync(path.join(remote.home, 'links', `${code}.log`), 'utf8');
  const same = () => remote.log(code) === host.log(code);
  const post = (text: string) => host.lib(() => store.open(code).append({ kind: 'status', text }, { via: 'system', from: 'room', system: true }));
  return { host, remote, alice, bob, code, daemon, st, daemonLog, same, post };
}

test('remote e2e: a server that stops answering (half-open) is caught by a missed pong and replaced before it is dropped', async t => {
  const r = await room(t);
  await h.until(() => r.st().rttMs != null, 5000, 50);
  assert.equal(r.st().state, 'online');
  const [old] = children(r.daemon);
  signal(old, 'SIGSTOP'); // the pipe stays open; nothing answers
  r.post('while the old server is frozen');
  await h.until(() => children(r.daemon).some(c => c !== old) && /swapped in/.test(r.daemonLog()), 8000, 50);
  assert.match(r.daemonLog(), /no pong within 400 ms: redialing now/);
  assert.match(r.daemonLog(), /swapped in, the old connection is closed/);
  await h.until(r.same, 5000, 50);
  assert.ok(r.same(), 'the mirror caught up over the new server');
  assert.equal(r.remote.say(r.bob, 'over the new link').json!.continue, false);
  assert.ok(r.same());
  assert.equal(new Set(ids(r.remote.log(r.code))).size, ids(r.remote.log(r.code)).length, 'no duplicate line');
  assert.equal(r.remote.lib(() => store.open(r.code).verifyChain()).ok, true);
  assert.equal(r.st().state, 'online');
  signal(old, 'SIGKILL');
});

test('remote e2e: a daemon frozen past the wake gap (as after a sleep) redials at once on waking, with no duplicate line', async t => {
  const r = await room(t, { SUB_HUMAN_LINK_PING_MS: '60000' }); // no ping in flight: the wake alone redials
  await h.until(() => r.st().state === 'online', 5000, 50);
  const [old] = children(r.daemon);
  signal(r.daemon, 'SIGSTOP');
  r.post('while the daemon slept');
  await h.sleep(2500);
  signal(r.daemon, 'SIGCONT');
  await h.until(() => /woke from sleep/.test(r.daemonLog()) && /swapped in/.test(r.daemonLog()), 5000, 50);
  assert.match(r.daemonLog(), /woke from sleep \(the clock jumped \d+ ms\): redialing now/);
  await h.until(() => !isAlive(old), 5000, 50);
  assert.equal(isAlive(old), false, 'the old server exits once its connection is closed');
  await h.until(r.same, 5000, 50);
  assert.ok(r.same());
  assert.equal(new Set(ids(r.remote.log(r.code))).size, ids(r.remote.log(r.code)).length);
  assert.equal(r.remote.say(r.bob, 'awake').json!.continue, false);
  assert.ok(r.same());
});

test('remote e2e: a seat whose lease lapsed on the host during an outage is renewed on reconnect, with no left/joined line', async t => {
  const r = await room(t, { SUB_HUMAN_LINK_RETRY_MS: '2000', SUB_HUMAN_LINK_RETRY_MAX_MS: '2000' });
  await h.until(() => r.st().state === 'online', 5000, 50);
  const [old] = children(r.daemon);
  signal(old, 'SIGKILL');
  await h.until(() => r.st().state === 'offline', 5000, 20);
  assert.match(r.st().lastError!, /closed/);
  r.host.lib(() => store.open(r.code).members.update(ms => { ms.bob.seen_at = new Date(0).toISOString(); return ms; }));
  assert.equal(r.host.lib(() => leaseFresh(store.open(r.code).members.read().bob)), false, 'the host counts bob gone');
  const before = r.host.log(r.code);
  await h.until(() => r.st().state === 'online', 8000, 50);
  await h.until(() => r.host.lib(() => leaseFresh(store.open(r.code).members.read().bob)), 3000, 50);
  assert.equal(r.host.lib(() => leaseFresh(store.open(r.code).members.read().bob)), true, 'bob is back');
  assert.equal(r.host.log(r.code), before, 'no left or joined line');
  assert.equal(r.st().attempt, 0);
});
