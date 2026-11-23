// Shared by the daemon's tests: temp homes, a daemon closed after its test, the daemon as a process, drafts.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AppendDraft } from '../../core/api.js';
import { startDaemon } from '../../net/daemon.js';
import type { Daemon, DaemonOptions } from '../../net/daemon.js';
import { call } from '../../net/daemon/client.js';
import { must } from './must.js';

export const PLUGIN: string = path.join(import.meta.dirname, '..', '..');
export const RESOLVE: string = path.join(PLUGIN, 'resolve-ts.ts');
export const DAEMON: string = path.join(PLUGIN, 'net', 'daemon.ts');

/** A fresh home, short enough for its socket. */
export async function home(): Promise<string> { return fs.mkdtemp(path.join(process.env.SUB_HUMAN_HOME ?? '', 'd-')); }

export async function started(t: TestContext, o: DaemonOptions): Promise<Daemon> {
  const d = await startDaemon(o);
  assert.ok(d.ok, d.ok ? '' : d.error);
  const daemon = must(d.value, 'a daemon');
  t.after(() => daemon.close()); // a failed test must not leave it up for its idle minute
  return daemon;
}

export const joined = (from: string): AppendDraft => ({ kind: 'joined', id: randomUUID(), from, by: 'system' });
export const post = (from: string, text: string, id: string = randomUUID()): AppendDraft => ({ kind: 'post', id, from, by: 'person', text });

/** Runs the daemon as its own process; resolves its exit code and what it wrote. */
export function run(args: readonly string[]): Promise<{ code: number | null; out: string }> {
  return new Promise(resolve => {
    const c = spawn(process.execPath, ['--import', RESOLVE, DAEMON, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    c.stderr.on('data', (b: Buffer) => { out += b.toString(); });
    c.on('exit', code => { resolve({ code, out }); });
  });
}

export async function until<T>(what: string, f: () => Promise<T | null>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const r = await f();
    if (r !== null) return r;
    if (Date.now() > end) assert.fail(`timed out waiting: ${what}`);
    await sleep(20);
  }
}

export async function pidOf(h: string): Promise<number | null> {
  const s = await call(h, { op: 'status' }, 500);
  return s.ok ? s.value.pid : null;
}
export function gone(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch { return true; }
}
/** Ends a daemon process and waits for it to be gone. */
export async function stop(pid: number): Promise<void> {
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  await until(`pid ${pid} gone`, () => Promise.resolve(gone(pid) || null));
}
