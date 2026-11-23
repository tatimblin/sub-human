// The daemon: one node process per home that makes every write (ARCHITECTURE §5), serving core/api.ts over HTTP on
// the Unix socket `<home>/daemon.sock`.
//
//   node --import <plugin>/resolve-ts.ts <plugin>/net/daemon.ts <home> [--idle-ms N]
//
// Started so (by the module's `$.process.spawn`, which kills its child at unload), it checks the home, starts itself
// again detached and exits 0 at once. The detached one binds the socket, or exits 0 when another daemon already
// answers there. It exits once no request has come for the idle time. Quiet: it prints nothing, except one line on
// stderr when it can't start.
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LIVE_MS, MAX_BODY, SOCKET_MAX, decodeRequest, socketFile } from '../core/api.js';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';
import { withLock } from '../store/lock.js';
import type { Links } from './daemon/rooms.js';
import { NO_LINKS, Rooms } from './daemon/rooms.js';

/** The daemon exits once no request has come for this long: twice a session's liveness, so a slow ping never stops it. */
export const IDLE_MS: number = 2 * LIVE_MS;
/** The start lock: one killed while binding holds it for a second, well inside the next one's wait. */
const START_LOCK = { waitMs: 3000, staleMs: 1000 } as const;

/** The listener for rooms hosted here (U15): started once the socket is bound, stopped at shutdown. */
export interface Listener { start(): Promise<void>; stop(): Promise<void> }

export interface DaemonOptions {
  readonly home: string;
  readonly idleMs?: number;
  readonly now?: () => number;
  readonly machine?: string;
  readonly links?: Links;
  readonly listener?: Listener;
}
export interface Daemon {
  /** Settles once the daemon has shut down, idle or closed. */
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

/** The home made private (0700), or why the daemon can't run there. */
export async function readyHome(home: string): Promise<Result<string>> {
  const sock = socketFile(home);
  if (Buffer.byteLength(sock) > SOCKET_MAX) return err(`sub-human's home path is too long for its socket: ${sock}`);
  try {
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    const { mode } = await fs.stat(home);
    if (mode & 0o022) return err(`sub-human's home ${home} can be written by other users; the daemon did not start`);
    if ((mode & 0o777) !== 0o700) await fs.chmod(home, 0o700);
    return ok(sock);
  } catch (e) { return err(`sub-human's home ${home} can't be used: ${msg(e)}`); }
}

/** A serving daemon, null when another one already answers on the socket, or why it couldn't start. */
export async function startDaemon(o: DaemonOptions): Promise<Result<Daemon | null>> {
  const { home, idleMs = IDLE_MS, now = Date.now, machine = os.hostname(), links = NO_LINKS, listener } = o;
  const ready = await readyHome(home);
  if (!ready.ok) return ready;
  const sock = ready.value;
  const rooms = new Rooms({ home, now, machine, idleMs, links });
  const inflight = new Set<Promise<void>>();
  const server = http.createServer((q, s) => {
    const p = serve(rooms, q, s);
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
  });
  // checking, unlinking and binding under one lock, so two daemons starting together can't both bind
  const bind = async (): Promise<Result<boolean>> => {
    if (await answers(sock)) return ok(false);
    await fs.rm(sock, { force: true });
    const mask = process.umask(0o077); // the socket is born private; the chmod after only makes sure
    try {
      return await new Promise<Result<boolean>>(resolve => {
        server.once('error', e => { resolve(err(`sub-human's daemon can't listen on ${sock}: ${e.message}`)); });
        server.listen(sock, () => { void fs.chmod(sock, 0o600).then(() => { resolve(ok(true)); }); });
      });
    } finally { process.umask(mask); }
  };
  let bound: Result<Result<boolean>>;
  try { bound = await withLock(`${home}/daemon.lock`, bind, START_LOCK); } catch (e) {
    return err(`sub-human's daemon can't use ${sock}: ${msg(e)}`);
  }
  if (!bound.ok) return err(`sub-human's daemon did not start: another one held its start lock for ${START_LOCK.waitMs / 1000} s`);
  if (!bound.value.ok || !bound.value.value) return bound.value.ok ? ok(null) : bound.value;
  await listener?.start();

  let done = (): void => undefined;
  const closed = new Promise<void>(resolve => { done = resolve; });
  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      clearInterval(timer);
      const shut = new Promise<void>(resolve => { server.close(() => { resolve(); }); });
      // every request already taken gets its answer, and every write its line, before a connection is cut
      while (inflight.size) await Promise.all([...inflight]);
      await rooms.drain();
      await listener?.stop();
      server.closeAllConnections();
      await shut;
      done();
    })();
    return closing;
  };
  const timer = setInterval(() => { if (now() - rooms.lastSeen > idleMs) void close(); }, Math.min(1000, Math.max(5, idleMs / 4)));
  return ok({ closed, close });
}

/** Whether something accepts on the socket: a live daemon, never to be replaced. */
function answers(sock: string): Promise<boolean> {
  return new Promise(resolve => {
    const c = net.connect(sock);
    c.setTimeout(500);
    c.once('connect', () => { c.destroy(); resolve(true); });
    c.once('timeout', () => { c.destroy(); resolve(true); }); // a busy daemon is still a daemon
    c.once('error', () => { resolve(false); });
  });
}

async function serve(rooms: Rooms, q: http.IncomingMessage, s: http.ServerResponse): Promise<void> {
  const send = (status: number, body: Result<unknown>): void => {
    s.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };
  if (q.method !== 'POST') { send(405, err('the sub-human daemon takes POST only')); return; }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of q) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(String(c));
    size += b.length;
    if (size > MAX_BODY) { send(413, err('the request is too large; nothing was done')); return; }
    chunks.push(b);
  }
  let json: unknown;
  try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { send(400, err('the request is not JSON; nothing was done')); return; }
  const req = decodeRequest(json);
  if (!req.ok) { send(400, req); return; }
  try { send(200, await rooms.handle(req.value)); } catch (e) {
    send(500, err(`the sub-human daemon failed (${msg(e)}); nothing was done`));
  }
}

function msg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

async function main(argv: readonly string[]): Promise<number> {
  const [home, ...flags] = argv;
  const at = flags.indexOf('--idle-ms');
  const idleMs = at < 0 ? IDLE_MS : Number(flags[at + 1]);
  if (home === undefined || home === '' || !Number.isFinite(idleMs) || idleMs <= 0) {
    process.stderr.write('usage: daemon.ts <home> [--idle-ms N]\n');
    return 2;
  }
  if (!flags.includes('--detached')) {
    // checked here too, since the detached one's stderr reaches nobody
    const ready = await readyHome(home);
    if (!ready.ok) { process.stderr.write(`${ready.error}\n`); return 1; }
    // the module's child dies when the module unloads; the daemon must outlive it (docs/internals/v2-risks.md)
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...argv, '--detached'], { detached: true, stdio: 'ignore' });
    return new Promise(resolve => {
      child.once('spawn', () => { child.unref(); resolve(0); });
      child.once('error', e => { process.stderr.write(`sub-human's daemon could not start: ${e.message}\n`); resolve(1); });
    });
  }
  // handled before the socket is bound, so a signal in the moment after it still ends with the socket removed
  let daemon: Daemon | null = null;
  let stopped = false;
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(sig, () => { stopped = true; void daemon?.close(); });
  const d = await startDaemon({ home, idleMs });
  if (!d.ok) { process.stderr.write(`${d.error}\n`); return 1; }
  if (d.value === null) return 0;
  daemon = d.value;
  if (stopped) void daemon.close();
  await daemon.closed;
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
