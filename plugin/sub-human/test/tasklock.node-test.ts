// lib/cc/tasklock.ts: the lock Claude Code takes on its task files (proper-lockfile: mkdir <target>.lock), spoken from
// outside. Raced against a peer that speaks the same protocol in another process (test/support/lockfile-peer.ts, the
// shape of Claude Code's TaskUpdate): no increment is lost. A stale lock dir is taken over; a held one times out.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as h from './helpers.ts';
import { withListLock, withTaskLock } from '../lib/cc/tasklock.ts';
import { errCode } from '../lib/errors.ts';
import { sleepSync } from '../lib/io.ts';

const PEER = path.join(import.meta.dirname, 'support', 'lockfile-peer.ts');

test('tasklock: the list lock\'s target is <dir>/.lock (made empty), its dir <dir>/.lock.lock; a task\'s is <id>.json.lock, none before the file exists', () => {
  const dir = path.join(h.tmpDir('sh-tasklock-'), 'sh-vole-1234');
  withListLock(dir, () => {
    assert.equal(fs.readFileSync(path.join(dir, '.lock'), 'utf8'), '');
    assert.ok(fs.statSync(path.join(dir, '.lock.lock')).isDirectory());
  });
  assert.equal(fs.existsSync(path.join(dir, '.lock.lock')), false, 'released');
  withTaskLock(dir, '2', () => assert.equal(fs.existsSync(path.join(dir, '2.json.lock')), false, 'no file, no lock'));
  fs.writeFileSync(path.join(dir, '2.json'), '{}');
  withTaskLock(dir, '2', () => assert.ok(fs.existsSync(path.join(dir, '2.json.lock'))));
});

test('tasklock: a stale lock dir (over 10 s old) is taken over; a fresh one held elsewhere times out with LOCK', () => {
  const dir = path.join(h.tmpDir('sh-tasklock-'), 'sh-vole-1234');
  fs.mkdirSync(path.join(dir, '.lock.lock'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.lock'), '');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(dir, '.lock.lock'), old, old);
  assert.equal(withListLock(dir, () => 'ran'), 'ran');
  fs.mkdirSync(path.join(dir, '.lock.lock'));
  assert.throws(() => withListLock(dir, () => 'never', { timeoutMs: 100 }), (e: unknown) => errCode(e) === 'LOCK');
});

test('tasklock: raced against a proper-lockfile peer in another process, 200 increments each, none lost', async () => {
  const dir = path.join(h.tmpDir('sh-tasklock-'), 'sh-vole-1234');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, '.lock');
  const counter = path.join(dir, 'counter');
  fs.writeFileSync(target, '');
  fs.writeFileSync(counter, '0');
  const peer = spawn(process.execPath, [PEER, target, counter, '200'], { stdio: 'ignore' });
  const done = new Promise<number | null>(r => peer.on('close', r));
  for (let i = 0; i < 200; i++) {
    withListLock(dir, () => {
      const v = Number(fs.readFileSync(counter, 'utf8'));
      sleepSync(1);
      fs.writeFileSync(counter, String(v + 1));
    });
    if (i % 20 === 0) await new Promise(r => setImmediate(r)); // let the peer's exit be seen
  }
  assert.equal(await done, 0);
  assert.equal(Number(fs.readFileSync(counter, 'utf8')), 400);
});
