'use strict';
// The link daemon's socket never depends on TMPDIR: a daemon started under one TMPDIR (a listener's, sshd's, a pipe
// server's after a handoff) serves the hooks of a session under another. Two homes on one machine (the pipe link);
// the handoff case, the old host's follow link started inside the serving process, is in test/handoff-e2e.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./helpers.js');
const store = require(path.join(h.LIB, 'room', 'store.js'));
const link = require(path.join(h.LIB, 'remote', 'link.js'));
const { Machine } = require('./support/two-homes.js');

const childOf = pid => Number(spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.trim().split('\n')[0]) || null;
const kill = pid => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };

test('remote: a daemon started with one TMPDIR serves hooks running with another; the doc records its socket', async t => {
  const daemonTmp = h.tmpDir('sh-tmp-daemon-', t), hookTmp = h.tmpDir('sh-tmp-hook-', t);
  const host = new Machine(t, 'host');
  const remote = new Machine(t, 'remote', { SUB_HUMAN_LINK_IDLE_MS: '20000', TMPDIR: daemonTmp });
  const alice = host.seat('alice'), bob = remote.seat('bob');
  host.join(alice, 'alice');
  const code = host.lib(() => store.listRooms()[0]);

  // the join hook starts the daemon: it gets daemonTmp
  await remote.joinVia(host, alice, bob);
  const daemon = remote.lib(() => link.status(code));
  const mirrorDir = path.join(remote.home, 'rooms', code);
  t.after(() => { kill(childOf(daemon.pid)); kill(daemon.pid); fs.rmSync(path.dirname(link.socketPath(mirrorDir)), { recursive: true, force: true }); });
  assert.equal(daemon.running, true);
  assert.equal(daemon.socket, link.socketPath(mirrorDir), 'the daemon records the socket it bound');
  assert.ok(!daemon.socket.startsWith(daemonTmp), daemon.socket);
  assert.equal(fs.statSync(daemon.socket).mode & 0o777, 0o600, 'the socket is 0600 (in a 0700 directory)');
  assert.equal(fs.statSync(path.dirname(daemon.socket)).mode & 0o777, 0o700);

  // every later hook runs with hookTmp (the session's own TMPDIR)
  remote.extra.TMPDIR = hookTmp;
  const joined = remote.join(bob, `bob ${code}`);
  assert.equal(joined.json.systemMessage, undefined, joined.stderr);
  assert.equal(remote.say(bob, 'across TMPDIRs').json.continue, false);
  const said = host.lib(() => store.open(code).readAll()).at(-1);
  assert.deepEqual([said.from, said.text], ['bob', 'across TMPDIRs']);
});
