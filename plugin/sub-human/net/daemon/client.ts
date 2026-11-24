// Node's side of the daemon's socket API (core/api.ts), for command hooks and tests; the module uses module/bridge.ts.
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Answers, Request, Status } from '../../core/api.js';
import { API_VERSION, daemonArgv, readAnswer, socketFile } from '../../core/api.js';
import type { Result } from '../../core/result.js';
import { err } from '../../core/result.js';

const PLUGIN = path.join(import.meta.dirname, '..', '..');
const NO_ANSWER = 'sub-human did not answer; nothing was done';

/** One request to the home's daemon; an error when nothing answers within `timeoutMs`. */
export function call<R extends Request>(home: string, req: R, timeoutMs = 5000): Promise<Result<Answers[R['op']]>> {
  return new Promise(resolve => {
    const headers = { 'content-type': 'application/json' };
    const q = http.request({ socketPath: socketFile(home), path: '/', method: 'POST', headers, timeout: timeoutMs }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { text += c; });
      res.on('end', () => { resolve(readAnswer<R['op']>(req.op, { status: res.statusCode ?? 0, text })); });
      res.on('error', () => { resolve(err(NO_ANSWER)); });
    });
    q.on('timeout', () => { q.destroy(); });
    q.on('error', () => { resolve(err(NO_ANSWER)); });
    q.end(JSON.stringify(req));
  });
}

/**
 * A daemon this plugin can use: a newer one, or this version's while it can write. Only an older one is replaced, so a
 * session of the older plugin never ends a newer one in turn.
 */
const fit = (s: Status): boolean => s.version > API_VERSION || (s.version === API_VERSION && s.unwritable === undefined);

/** The daemon's status, starting it first when nothing answers, or after ending one that isn't fit (once per call). */
export async function ensure(home: string, waitMs = 3000): Promise<Result<Status>> {
  const first = await call(home, { op: 'status' }, 1000);
  if (first.ok && fit(first.value)) return first;
  if (first.ok) await end(home, first.value.pid);
  const [node = process.execPath, ...args] = daemonArgv(process.execPath, PLUGIN, home);
  const child = spawn(node, args, { stdio: 'ignore' });
  child.on('error', () => undefined); // what counts is whether the socket answers
  const deadline = Date.now() + waitMs;
  for (;;) {
    await sleep(20);
    const r = await call(home, { op: 'status' }, 500);
    if (r.ok && fit(r.value)) return r;
    if (r.ok || Date.now() > deadline) return err(unstarted(home, r.ok ? r.value : first.ok ? first.value : null));
  }
}

/**
 * Why no fit daemon answers: the home can't be written (the new one can't either, or can't start where the old one
 * couldn't write), an older one is still there, or none started.
 */
function unstarted(home: string, last: Status | null): string {
  if (last?.unwritable !== undefined) return `sub-human can't write to ${home} (${last.unwritable}); nothing was done. Check that the folder can be written`;
  return last && last.version < API_VERSION ? 'sub-human did not start: an older one still answers here; nothing was done' : 'sub-human did not start; nothing was done';
}

/**
 * Ends the unfit daemon `pid`: SIGTERM (it shuts down cleanly), then SIGKILL while it still answers. Each signal goes
 * only to a pid that has just answered, unfit: another ensure may already have ended it and started a new one.
 */
async function end(home: string, pid: number): Promise<void> {
  for (const [sig, ms] of [['SIGTERM', 2000], ['SIGKILL', 1000]] as const) {
    const s = await call(home, { op: 'status' }, 500);
    if (!s.ok || s.value.pid !== pid || fit(s.value) || pid === process.pid) return; // never this very process (a test's)
    try { process.kill(pid, sig); } catch { return; } // gone already
    if (await stopped(home, pid, ms)) return;
  }
}

/** Whether daemon `pid` stops answering within `ms`. */
async function stopped(home: string, pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    const s = await call(home, { op: 'status' }, 300);
    if (!s.ok || s.value.pid !== pid) return true;
    if (Date.now() > deadline) return false;
    await sleep(20);
  }
}

