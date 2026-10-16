// The link daemon's socket never depends on TMPDIR: a daemon started under one TMPDIR (a listener's, sshd's, a pipe
// server's after a handoff) serves the hooks of a session under another. Two homes on one machine (the pipe link);
// the handoff case, the old host's follow link started inside the serving process, is in test/handoff-e2e.node-test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as h from './helpers.ts';
import * as store from '../lib/room/store.ts';
import * as linkSocket from '../lib/remote/link-socket.ts';
import { Machine } from './support/two-homes.ts';
import { must } from './support/must.ts';

const childOf = (pid: number | undefined) => Number(spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.trim().split('\n')[0]) || null;
// a missing pid (null/undefined) throws in process.kill and is ignored, like a gone one
const kill = (pid: number | null | undefined) => { try { process.kill(pid as number, 'SIGKILL'); } catch { /* gone */ } };

test('remote: a daemon started with one TMPDIR serves hooks running with another; the doc records its socket', async t => {
  const daemonTmp = h.tmpDir('sh-tmp-daemon-', t), hookTmp = h.tmpDir('sh-tmp-hook-', t);
  const host = new Machine(t, 'host');
  const remote = new Machine(t, 'remote', { SUB_HUMAN_LINK_IDLE_MS: '20000', TMPDIR: daemonTmp });
  const alice = host.seat('alice'), bob = remote.seat('bob');
  host.join(alice, 'alice');
  const code = must(host.lib(() => store.listRooms()[0]), 'the room');

  // the join hook starts the daemon: it gets daemonTmp
  await remote.joinVia(host, alice, bob);
  const daemon = remote.lib(() => linkSocket.status(code));
  const mirrorDir = path.join(remote.home, 'rooms', code);
  t.after(() => { kill(childOf(daemon.pid)); kill(daemon.pid); fs.rmSync(path.dirname(linkSocket.socketPath(mirrorDir)), { recursive: true, force: true }); });
  assert.equal(daemon.running, true);
  assert.equal(daemon.socket, linkSocket.socketPath(mirrorDir), 'the daemon records the socket it bound');
  assert.ok(!daemon.socket.startsWith(daemonTmp), daemon.socket);
  assert.equal(fs.statSync(daemon.socket).mode & 0o777, 0o600, 'the socket is 0600 (in a 0700 directory)');
  assert.equal(fs.statSync(path.dirname(daemon.socket)).mode & 0o777, 0o700);

  // every later hook runs with hookTmp (the session's own TMPDIR)
  remote.extra.TMPDIR = hookTmp;
  const joined = remote.join(bob, `bob ${code}`);
  assert.equal(must(joined.json).systemMessage, undefined, joined.stderr);
  assert.equal(must(remote.say(bob, 'across TMPDIRs').json).continue, false);
  const said = host.lib(() => store.open(code).readAll()).at(-1);
  assert.deepEqual([must(said).from, must(said).text], ['bob', 'across TMPDIRs']);
});
