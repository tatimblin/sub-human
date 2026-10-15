// A mirror's first sync of what the host's log already holds (lib/remote/link.ts serveMirror in-process, over the
// memory transport, against a real server on the host's FsRoomStore): a large log arrives whole, byte for byte, in
// bounded time; a corrupt line in the middle of the host's log stops the link where it stands (PROTOCOL), and the
// mirror keeps only the lines before it, never a repaired or reordered copy.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as h from './helpers.ts';
import * as store from '../lib/room/store.ts';
import * as link from '../lib/remote/link.ts';
import * as server from '../lib/remote/server.ts';
import * as client from '../lib/remote/client.ts';
import * as auth from '../lib/remote/auth.ts';
import * as memory from '../lib/remote/transports/memory.ts';
import { MirrorRoomStore } from '../lib/room/store-mirror.ts';
import type { FsRoomStore } from '../lib/room/store.ts';

const REMOTE = 'remote0machine01';

/** A room hosted here with n entries, and a mirror of it that has synced nothing yet. */
function rig(t: TestContext, n: number) {
  h.freshHome(t);
  const code = h.newRoom();
  const host = store.open(code) as FsRoomStore;
  for (let i = 1; i <= n; i++) host.append({ kind: 'status', text: `line ${i} ${'x'.repeat(i % 7 * 20)}` }, { via: 'system', from: 'claude', system: true });
  const { secret } = auth.mintInvite(host, { locator: 'pipe:/test' });
  const { token } = auth.redeemInvite(host, secret, { machine: REMOTE });
  const sessions: { close(): void }[] = [];
  t.after(() => sessions.forEach(s => s.close()));
  const connect = async () => {
    const [a, b] = memory.pair();
    sessions.push(server.serve(b, { store: host }));
    return client.connect(a, { machine: REMOTE, token });
  };
  const mirror = new MirrorRoomStore(code, { dir: h.tmpDir('sh-mirror-', t) });
  t.after(() => fs.rmSync(path.dirname(link.socketPath(mirror.dir)), { recursive: true, force: true }));
  const logged: string[] = [];
  const start = () => link.serveMirror({ mirror, connect, log: m => { logged.push(m); }, retryMs: 30, retryMaxMs: 60, watch: false, seats: () => [] });
  const read = (f: string) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
  return { code, host, mirror, logged, start, hostLog: () => read(host.logFile), mirrorLog: () => read(mirror.logFile) };
}

test('first sync: a 3000-line log reaches a new mirror whole and byte for byte, in bounded time', async t => {
  const N = 3000;
  const r = rig(t, N);
  assert.equal(r.host.lastId(), N);
  const t0 = Date.now();
  const l = await r.start();
  t.after(() => l.stop('done'));
  const synced = await h.until(() => r.mirror.lastId() === N, 60_000, 20);
  const ms = Date.now() - t0;
  assert.ok(synced, `synced ${r.mirror.lastId()} of ${N} lines; ${r.logged.join('\n')}`);
  assert.equal(r.mirrorLog(), r.hostLog(), 'byte-identical');
  assert.equal(l.state(), 'online');
  assert.equal(r.mirror.verifyChain().ok, true);
  // a bound against a per-line cost that grows with the log (each line re-reading the mirror's file), not a benchmark
  assert.ok(ms < 30_000, `first sync of ${N} lines took ${ms} ms`);
});

test('first sync: a corrupt line in the middle of the host\'s log stops the link there (PROTOCOL); the mirror keeps the lines before it', async t => {
  const r = rig(t, 6);
  const lines = r.hostLog().split('\n').filter(Boolean);
  lines[3] = lines[3].slice(0, 25); // line 4, torn mid-object: not JSON
  fs.writeFileSync(r.host.logFile, lines.join('\n') + '\n');
  // the host's own readers skip the line and its chain check names it
  assert.deepEqual(store.open(r.code).readAll().map(e => e.id), [1, 2, 3, 5, 6]);
  const chain = r.host.validateChain();
  assert.equal(chain.ok, false);
  assert.equal(chain.line, 4);

  const l = await r.start();
  t.after(() => l.stop('done'));
  assert.ok(await h.until(() => l.state() === 'stopped', 10_000, 20), `still ${l.state()}: ${r.logged.join('\n')}`);
  assert.match(await l.done, /not JSON/, 'the reason the link stopped');
  assert.equal(r.mirrorLog(), lines.slice(0, 3).join('\n') + '\n', 'the three lines before it, as the host holds them; nothing after');
  assert.deepEqual(r.mirror.readAll().map(e => e.id), [1, 2, 3]);
});
