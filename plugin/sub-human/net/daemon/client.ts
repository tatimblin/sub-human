// Node's side of the daemon's socket API (core/api.ts), for command hooks and tests; the module uses module/bridge.ts.
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Answers, Request, Status } from '../../core/api.js';
import { daemonArgv, readAnswer, socketFile } from '../../core/api.js';
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
      res.on('end', () => { resolve(readAnswer<R['op']>(req.op, res.statusCode ?? 0, text)); });
      res.on('error', () => { resolve(err(NO_ANSWER)); });
    });
    q.on('timeout', () => { q.destroy(); });
    q.on('error', () => { resolve(err(NO_ANSWER)); });
    q.end(JSON.stringify(req));
  });
}

/** The daemon's status, starting it first when nothing answers. */
export async function ensure(home: string, waitMs = 3000): Promise<Result<Status>> {
  const first = await call(home, { op: 'status' }, 1000);
  if (first.ok) return first;
  const [node = process.execPath, ...args] = daemonArgv(process.execPath, PLUGIN, home);
  const child = spawn(node, args, { stdio: 'ignore' });
  child.on('error', () => undefined); // what counts is whether the socket answers
  const deadline = Date.now() + waitMs;
  for (;;) {
    await sleep(20);
    const r = await call(home, { op: 'status' }, 500);
    if (r.ok || Date.now() > deadline) return r.ok ? r : err('sub-human did not start; nothing was done');
  }
}
