// The module's side of the daemon's socket API (core/api.ts). Pure: it builds what the hook body hands to
// `$.http.fetch` and reads what comes back, since a `$` never leaves the hook that holds it. A fetch that throws
// (nothing on the socket, or managed policy refusing the socket) is the hook's to catch: it starts the daemon with
// core/api.ts daemonArgv, or says in one line that it can't.
import type { Answers, Op, Request } from '../core/api.js';
import { DAEMON_URL, readAnswer, socketFile } from '../core/api.js';
import type { Result } from '../core/result.js';

export interface Call {
  readonly url: string;
  readonly socketPath: string;
  readonly method: 'POST';
  readonly headers: { readonly 'content-type': 'application/json' };
  readonly body: string;
}

/** `$.http.fetch(c.url, c)` sends it. */
export function request(req: Request, home: string): Call {
  return { url: DAEMON_URL, socketPath: socketFile(home), method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) };
}

/** What the daemon answered to an `op` request, from `$.http.fetch`'s response. */
export function answer<O extends Op>(op: O, raw: { readonly status: number; readonly text: string }): Result<Answers[O]> {
  return readAnswer(op, raw.status, raw.text);
}
