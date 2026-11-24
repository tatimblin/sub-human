// ensure(): the daemon a command hook can use, started when none answers and replaced when one can't write or is older.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { err } from '../../core/result.js';
import { socketFile } from '../../core/api.js';
import { call, ensure } from './client.js';
import { must } from '../../test/support/must.js';
import { DAEMON, RESOLVE, gone, home, joined, pidOf, stop, until } from '../../test/support/daemon.js';

const ENOSYS = path.join(import.meta.dirname, '..', '..', 'test', 'support', 'enosys.ts');
/** A daemon process whose home stops taking writes once `marker` exists; resolves its exit code. */
function sandboxed(h: string, marker: string): Promise<number | null> {
  const env = { ...process.env, SUB_HUMAN_ENOSYS: marker };
  const c = spawn(process.execPath, ['--import', RESOLVE, '--import', ENOSYS, DAEMON, h, '--detached'], { stdio: 'ignore', env });
  return new Promise(resolve => { c.on('exit', code => { resolve(code); }); });
}
/** Until the daemon has started: its net answers (status answers sooner, while the net still writes its files). */
const serving = (h: string): Promise<true> => until('it serves', async () => (await call(h, { op: 'link', code: 'none-0000' }, 500)).ok || null);
/** A daemon of another version: it answers status as `version` and refuses every other request. */
const OTHER = `const [sock, version] = process.argv.slice(1);
require('node:http').createServer((q, s) => { let b = ''; q.on('data', c => { b += c; }); q.on('end', () => {
  const status = JSON.parse(b).op === 'status';
  s.writeHead(status ? 200 : 400, { 'content-type': 'application/json' }).end(JSON.stringify(status
    ? { ok: true, value: { version: Number(version), pid: process.pid, sessions: 0, cc: [] } } : { ok: false, error: 'request not understood' }));
}); }).listen(sock);`;

test('ensure starts the daemon when nothing answers, and finds the running one after', async () => {
  const h = await home();
  const first = await ensure(h);
  assert.ok(first.ok, first.ok ? '' : first.error);
  assert.notEqual(first.value.pid, process.pid);
  assert.deepEqual(await ensure(h), first);
  await stop(first.value.pid);
});

test('a write the home refuses (ENOSYS) is one line, and the daemon exits', async () => {
  const h = await home();
  const marker = `${h}.gone`;
  const exited = sandboxed(h, marker);
  await serving(h);
  await fs.writeFile(marker, '');
  const r = await call(h, { op: 'append', code: 'R7', draft: joined('alice') });
  assert.deepEqual(r, err(`sub-human can't write to ${h} (ENOSYS), so it stopped; nothing was done. Try the command again`));
  assert.equal(await exited, 0);
  await assert.rejects(fs.access(socketFile(h)), 'the socket is gone');
});

test('ensure replaces a daemon that can\'t write or is older; a newer one is left serving', async t => {
  await t.test('one that can\'t write is ended; when the next can\'t either, one line says so', async () => {
    const h = await home();
    const marker = `${h}.gone`;
    const exited = sandboxed(h, marker);
    await serving(h); // and before its first status, which trusts its write probe for 5 s
    await fs.writeFile(marker, '');
    const old = await until('the daemon', () => pidOf(h));
    assert.partialDeepStrictEqual(await call(h, { op: 'status' }), { ok: true, value: { pid: old, unwritable: 'ENOSYS' } });
    const opts = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `--import ${ENOSYS}`;
    process.env.SUB_HUMAN_ENOSYS = marker;
    try {
      assert.deepEqual(await ensure(h, 1500), err(`sub-human can't write to ${h} (ENOSYS); nothing was done. Check that the folder can be written`));
    } finally {
      if (opts === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = opts;
      delete process.env.SUB_HUMAN_ENOSYS;
    }
    assert.equal(await exited, 0, 'a clean shutdown on SIGTERM');
    const next = await ensure(h);
    assert.ok(next.ok && next.value.unwritable === undefined && next.value.pid !== old, JSON.stringify(next));
    await stop(next.value.pid);
  });
  for (const [version, kept] of [[6, false], [8, true]] as const) {
    await t.test(`v${version}: ${kept ? 'kept' : 'ended'}`, async st => {
      const h = await home();
      const other = spawn(process.execPath, ['-e', OTHER, socketFile(h), String(version)], { stdio: 'ignore' });
      const pid = must(other.pid, 'pid');
      st.after(() => { other.kill('SIGKILL'); });
      await until('the other daemon', () => pidOf(h));
      const r = await ensure(h);
      assert.ok(r.ok, r.ok ? '' : r.error);
      assert.deepEqual([r.value.version, r.value.pid === pid, gone(pid)], kept ? [8, true, false] : [7, false, true]);
      if (!kept) await stop(r.value.pid);
    });
  }
  await t.test('two at once: the old one ends, and neither ends the new one the other started', async st => {
    const h = await home();
    const other = spawn(process.execPath, ['-e', OTHER, socketFile(h), '6'], { stdio: 'ignore' });
    const pid = must(other.pid, 'pid');
    st.after(() => { other.kill('SIGKILL'); });
    await until('the other daemon', () => pidOf(h));
    const [a, b] = await Promise.all([ensure(h), ensure(h)]);
    assert.ok(a.ok && b.ok, JSON.stringify([a, b]));
    assert.deepEqual([a.value.version, a.value.pid === b.value.pid, gone(pid)], [7, true, true]);
    await sleep(300);
    assert.equal(await pidOf(h), a.value.pid, 'the new one still serves');
    await stop(a.value.pid);
  });
  await t.test('an older one still there after the one try is an error line, never ok', async st => {
    const h = await home();
    // in this process, so ensure never signals it
    const v6 = JSON.stringify({ ok: true, value: { version: 6, pid: process.pid, sessions: 0, cc: [] } });
    const server = http.createServer((q, s) => { q.resume(); q.on('end', () => { s.end(v6); }); }).listen(socketFile(h));
    st.after(() => { server.close(); });
    await until('it answers', () => pidOf(h));
    assert.deepEqual(await ensure(h, 1000), err('sub-human did not start: an older one still answers here; nothing was done'));
  });
});
