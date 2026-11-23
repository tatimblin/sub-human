// The daemon's life: one per home, started detached, private, quiet, drained and gone when idle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { err } from '../core/result.js';
import { socketFile } from '../core/api.js';
import { openFsStore } from '../store/fs-store.js';
import { withLock } from '../store/lock.js';
import { startDaemon } from './daemon.js';
import { call, ensure } from './daemon/client.js';
import { must } from '../test/support/must.js';
import { DAEMON, RESOLVE, gone, home, joined, linksOnly, pidOf, post, run, started, stop, until } from '../test/support/daemon.js';

/** The pids of every daemon process of this home. */
function daemons(h: string): number[] {
  try { return execFileSync('pgrep', ['-f', `daemon.ts ${h}`], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number); } catch { return []; }
}

test('one daemon per home: a second start, in process or as a process, leaves the first serving', async t => {
  const h = await home();
  const d = await started(t, { home: h });
  assert.deepEqual(await startDaemon({ home: h }), { ok: true, value: null });
  assert.deepEqual(await run([h, '--detached']), { code: 0, out: '' });
  assert.equal(await pidOf(h), process.pid);
  assert.equal((await fs.stat(socketFile(h))).mode & 0o777, 0o600);
  await d.close();
  assert.equal(await pidOf(h), null);
});

test('the socket is born private (umask), not only made so by the chmod after', async t => {
  const h = await home();
  t.mock.method(fs, 'chmod', () => Promise.resolve());
  await started(t, { home: h });
  assert.equal((await fs.stat(socketFile(h))).mode & 0o077, 0);
});

test('three daemons starting together in one process: exactly one binds', async t => {
  const h = await home();
  const rs = await Promise.all([startDaemon({ home: h }), startDaemon({ home: h }), startDaemon({ home: h })]);
  const live = rs.flatMap(r => (r.ok && r.value ? [r.value] : []));
  for (const d of live) t.after(() => d.close());
  assert.equal(live.length, 1);
  assert.ok(rs.every(r => r.ok));
});

for (const detached of [true, false]) {
  test(`five daemon processes started at once${detached ? ' with --detached' : ''}: exactly one is left serving`, async () => {
    const h = await home();
    const flags = detached ? [h, '--detached'] : [h];
    const kids = Array.from({ length: 5 }, () => spawn(process.execPath, ['--import', RESOLVE, DAEMON, ...flags], { stdio: 'ignore' }));
    const codes: (number | null)[] = [];
    for (const k of kids) k.on('exit', c => { codes.push(c); });
    await until('every process but the daemon to exit', () => Promise.resolve(codes.length >= (detached ? 4 : 5) || null), 15_000);
    const pid = await until('one daemon left', () => Promise.resolve(daemons(h).length === 1 ? must(daemons(h)[0], 'pid') : null), 15_000);
    assert.ok(codes.every(c => c === 0), `exit codes ${codes.join(',')}`);
    assert.equal(await until('it answers', () => pidOf(h)), pid);
    await stop(pid);
  });
}

test('appends from two concurrent clients get gapless seqs, and the chain holds', async t => {
  const h = await home();
  await started(t, { home: h, machine: 'm1' });
  for (const n of ['alice', 'bob']) assert.ok((await call(h, { op: 'append', code: 'R1', draft: joined(n) })).ok);
  // every append fsyncs one after another, so a loaded machine gets a long wait, never a gap
  const client = (n: string) => Promise.all(Array.from({ length: 20 }, (_, i) => call(h, { op: 'append', code: 'R1', draft: post(n, `${n} ${i}`) }, 15_000)));
  const [a, b] = await Promise.all([client('alice'), client('bob')]);
  const seqs = [...a, ...b].map(r => (r.ok ? r.value.seq : 0)).sort((x, y) => x - y);
  assert.deepEqual(seqs, Array.from({ length: 40 }, (_, i) => i + 3));
  const store = await openFsStore({ home: h, code: 'R1' });
  assert.ok(store.ok);
  const lines = await store.value.read(0);
  assert.ok(lines.ok);
  assert.equal(lines.value.length, 42);
  assert.ok(lines.value.every(l => l.entry.machine === 'm1'), 'the host stamps the machine');
});

test('a room hosted elsewhere goes to its link, whose host is away for now (R34)', async t => {
  const h = await home();
  await started(t, { home: h, net: linksOnly({ hosts: c => c === 'FAR', forward: () => Promise.resolve(err('the room\'s host is away; nothing was sent')) }) });
  const r = await call(h, { op: 'append', code: 'FAR', draft: joined('alice') });
  assert.ok(!r.ok && /host is away/.test(r.error));
  await assert.rejects(fs.access(path.join(h, 'rooms', 'FAR')));
});

test('a request it cannot read is refused in one line', async t => {
  const h = await home();
  await started(t, { home: h });
  const r = await call(h, { op: 'append', code: 'R4', draft: post('alice', 'x'.repeat(9000)) });
  assert.ok(!r.ok && /^entry not understood: text/.test(r.error) && !r.error.includes('\n'));
});

test('idle: any request keeps it up, and it exits once none has come for the idle time (fake clock)', async t => {
  const h = await home();
  let clock = 0;
  const d = await started(t, { home: h, idleMs: 1000, now: () => clock });
  let closed = false;
  void d.closed.then(() => { closed = true; });
  clock = 999;
  await sleep(300);
  await call(h, { op: 'status' });
  clock = 1998;
  await sleep(300);
  assert.equal(closed, false, 'a status call keeps it up');
  clock = 2000;
  await until('the idle exit', () => Promise.resolve(closed || null), 2000);
  assert.equal(await pidOf(h), null);
  await assert.rejects(fs.access(socketFile(h)), 'the socket is gone');
});

test('shutdown answers the requests it took before it cuts a connection', async t => {
  const h = await home();
  const slow = { hosts: () => true, forward: async () => { await sleep(300); return err('the room\'s host is away; nothing was sent'); } };
  const d = await started(t, { home: h, net: linksOnly(slow) });
  const pending = call(h, { op: 'append', code: 'R5', draft: joined('alice') });
  await sleep(100);
  await d.close();
  assert.deepEqual(await pending, { ok: false, error: 'the room\'s host is away; nothing was sent' });
});

test('a stale socket, left by a daemon that was killed, is removed and bound again', async t => {
  const h = await home();
  const child = spawn(process.execPath, ['--import', RESOLVE, DAEMON, h, '--detached'], { stdio: 'ignore' });
  await until('the first daemon', () => pidOf(h));
  await until('its start lock released', () => fs.access(path.join(h, 'daemon.lock')).then(() => null, () => true));
  child.kill('SIGKILL');
  await until('its death', () => Promise.resolve(gone(must(child.pid, 'pid')) || null));
  await fs.access(socketFile(h)); // still on disk, nobody behind it
  await started(t, { home: h });
  assert.equal(await pidOf(h), process.pid);
});

test('a start lock left by a daemon killed while binding is broken within the next start\'s wait', async t => {
  const h = await home();
  await fs.writeFile(path.join(h, 'daemon.lock'), 'killed-mid-bind'); // fresh: its holder died a moment ago
  await started(t, { home: h });
  assert.equal(await pidOf(h), process.pid);
});

test('a start lock held by a live daemon past the wait is said in one line', async () => {
  const h = await home();
  // held at a live daemon's own touch rate
  const held = await withLock(path.join(h, 'daemon.lock'), () => startDaemon({ home: h }), { staleMs: 1000 });
  assert.ok(held.ok);
  const got = held.value;
  assert.ok(!got.ok && /^sub-human did not start: another start held its lock for 3 s$/.test(got.error));
});

test('the home is private: others\' write refused, otherwise made 0700; a folder at the socket refused in one line', async () => {
  const open = await home();
  await fs.chmod(open, 0o777);
  const r1 = await startDaemon({ home: open });
  assert.ok(!r1.ok && /can be written by other users, so sub-human did not start$/.test(r1.error));
  const loose = await home();
  await fs.chmod(loose, 0o750);
  await fs.mkdir(socketFile(loose));
  const r2 = await startDaemon({ home: loose });
  assert.ok(!r2.ok && /^sub-human can't use .*daemon\.sock: /.test(r2.error) && !r2.error.includes('\n'), r2.ok ? '' : r2.error);
  assert.equal((await fs.stat(loose)).mode & 0o777, 0o700);
});

test('detach: the spawned process exits at once, and the daemon it started keeps answering', async () => {
  const h = await home();
  assert.deepEqual(await run([h, '--idle-ms', '30000']), { code: 0, out: '' });
  const pid = await until('the detached daemon', () => pidOf(h));
  assert.notEqual(pid, process.pid);
  await stop(pid);
  await assert.rejects(fs.access(socketFile(h)), 'a clean shutdown removes the socket');
});

test('a SIGTERM the moment the socket appears still ends with the socket removed', async () => {
  const h = await home();
  const child = spawn(process.execPath, ['--import', RESOLVE, DAEMON, h, '--detached'], { stdio: 'ignore' });
  const exited = new Promise<number | null>(resolve => { child.on('exit', code => { resolve(code); }); });
  await until('the socket', () => fs.access(socketFile(h)).then(() => true, () => null), 10_000);
  child.kill('SIGTERM');
  assert.equal(await exited, 0, 'a clean exit, not death by the signal');
  await assert.rejects(fs.access(socketFile(h)));
});

test('a session\'s whole process group killed: the daemon it started survives and answers', async () => {
  const h = await home();
  const script = 'require("node:child_process").spawn(process.execPath, ["--import", process.argv[1], process.argv[2], process.argv[3]], { stdio: "ignore" }); setInterval(() => {}, 1000);';
  const session = spawn(process.execPath, ['-e', script, RESOLVE, DAEMON, h], { detached: true, stdio: 'ignore' });
  const pid = await until('the daemon', () => pidOf(h));
  const group = must(session.pid, 'pid');
  process.kill(-group, 'SIGKILL');
  await until('the session gone', () => Promise.resolve(gone(group) || null));
  await sleep(200);
  assert.equal(await pidOf(h), pid);
  await stop(pid);
});

test('a home too long for a socket is said in one line by the process the module spawns', async () => {
  const r = await run([path.join(await home(), 'x'.repeat(120))]);
  assert.equal(r.code, 1);
  assert.match(r.out, /^sub-human's home path is too long: [^\n]*\n$/);
});

test('ensure starts the daemon when nothing answers, and finds the running one after', async () => {
  const h = await home();
  const first = await ensure(h);
  assert.ok(first.ok, first.ok ? '' : first.error);
  assert.notEqual(first.value.pid, process.pid);
  assert.deepEqual(await ensure(h), first);
  await stop(first.value.pid);
});
