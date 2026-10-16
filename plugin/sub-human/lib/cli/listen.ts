/**
 * plugin/sub-human/lib/cli/listen.ts: the host's web listener commands of scripts/sub-human, in the person's own
 * shell (the Bash guard refuses them to a model). The work is lib/remote/listener.ts and lib/remote/webhost.ts.
 *
 *   listen(args)   sub-human listen [--port 7420]          run the listener in this process (`/sub-human invite
 *                                                          --web | --url` starts it detached, the same way)
 *                  sub-human listen --start [--port P]     start it detached unless it runs (idempotent)
 *                  sub-human listen --stop                 stop it (idempotent)
 *                  sub-human listen --status               its state as JSON (pid, port, rooms served)
 */

import { parse } from './args.ts';
import { createRequire } from 'node:module';
import { msgOf } from '../errors.ts';
import type * as ListenerMod from '../remote/listener.ts';

const require: <M>(id: string) => M = createRequire(import.meta.url);

const say = (s: string) => process.stdout.write(s.endsWith('\n') ? s : s + '\n');
const fail = (s: string, code = 1) => { process.stderr.write(s.endsWith('\n') ? s : s + '\n'); return code; };

/** -> the exit code, or null when this process is the listener and keeps running */
function listen(args: readonly string[]): number | null {
  const p = parse(args, { port: 1, start: 0, stop: 0, status: 0 });
  let port: number | undefined;
  if (p.flags.port !== undefined) { port = Number(p.flags.port); if (!(port >= 0 && port <= 65535) || !Number.isInteger(port)) return fail('--port takes a port number', 2); }
  if (p.error === '--port needs a value') return fail('--port takes a port number', 2);
  const doStart = !!p.flags.start, doStop = !!p.flags.stop, doStatus = !!p.flags.status;
  if (p.error || p.rest.length || Number(doStart) + Number(doStop) + Number(doStatus) > 1) return fail('usage: sub-human listen [--port 7420] | --start [--port P] | --stop | --status', 2);
  const L: typeof ListenerMod = require('../remote/listener.ts');
  try {
    if (doStatus) { say(JSON.stringify(L.status(), null, 2)); return 0; }
    if (doStop) { say(L.stop() ? 'the listener stopped' : 'no listener was running'); return 0; }
    if (doStart) {
      const r = L.start(port !== undefined ? { port } : {});
      say(`${r.started ? 'started' : 'already running'}: pid ${r.pid} on 127.0.0.1:${r.port}`);
      return 0;
    }
  } catch (e) { return fail(msgOf(e)); }
  L.run(port !== undefined ? { port } : {}).then(() => process.exit(0), (e: unknown) => { fail(msgOf(e)); process.exit(1); });
  return null; // the daemon keeps running
}

export { listen };
