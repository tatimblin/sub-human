/**
 * plugin/sub-human/lib/remote/listener.ts: the host's WebSocket listener daemon (`scripts/sub-human listen [--port
 * 7420]`), one per home. It binds 127.0.0.1 only; a TLS front (Tailscale Serve or Funnel, the lab's Caddy, a
 * person's own reverse proxy) is the only way in from elsewhere. A WebSocket whose first message is TEXT is a short code's
 * attempt (lib/remote/enroll.ts): for a room this home serves, `<home>/bin/serve --enroll CODE --kind ws` runs the PAKE
 * over its text frames (a pre-auth slot until it exits). For each other WebSocket it runs the Noise_NK handshake
 * as the responder with the host's static X25519 key (lib/remote/transports/ws.ts serverChannel), checks the room
 * the joiner names is one this home serves over ws, and only then spawns `<home>/bin/serve --stdio CODE` (the stable
 * shim, lib/remote/shim.ts) for that one connection, piping decrypted bytes to its stdin and its stdout back. It never
 * runs lib/remote/server.ts in-process (the store lock busy-waits; one wait would stall every connection), parses no
 * protocol frame, and never sees a secret in clear outside the child's pipes. The child authenticates the hello
 * (an invite and its PIN, or a link token) as for any transport.
 *
 *   keyFile() -> <home>/listen/host-x25519.json   the host's static Noise key (0600): a random X25519 key of its own,
 *       made once per home (lib/remote/noise.ts loadOrCreateStatic). It is neither derived from nor signed by any
 *       other key: node:crypto cannot turn an Ed25519 seat key into an X25519 one without hand-written field
 *       arithmetic, and keeping roles apart means a leak of one never opens the other. The invite pins it directly,
 *       so no binding to the machine id is needed; it lives in the same home, so it follows that machine identity
 *   hostKey() -> string            its public key, base64url (43 chars): the sh2 invite's host-key field for ws/wss
 *   stateFile() -> <home>/listen/state.json   the shared state (0600) doctor and the hooks read:
 *       {pid, port, started_at, rooms: {CODE: {path, url, mode: 'tailscale' | 'funnel' | 'url', tailscale?: {bin,
 *       https, path}, at}}, conns}. rooms is what this home serves over ws; a room not in it is refused at the handshake
 *   status() -> {running, pid?, port?, rooms, conns?, started_at?}
 *   addRoom(code, rec) / removeRoom(code) -> rec | null   (atomic, under the state file's lock)
 *   start({port?}) -> {pid, port, started}   idempotent: a live listener is kept (its port wins); else
 *       `sub-human listen --port PORT` is spawned detached (log: <home>/listen/listen.log) and awaited for up to
 *       LISTEN_START_MS. RoomError LOCK when it does not come up (the port is taken, say)
 *   stop() -> bool                 SIGTERM the live listener and wait for it to go; false when none ran
 *   run({port?, log?, closedCheckMs?, idleMs?}) -> Promise<{why, port}>   the daemon itself: pid in the state file (LOCK when a live
 *       one holds it), then serve until SIGTERM / SIGINT / SIGHUP. Limits before a handshake completes: at most
 *       PREAUTH_MAX connections in handshake, LISTEN_MAX in all, HANDSHAKE_MS to finish it, Noise-sized frames. Every
 *       closedCheckMs it drops rooms that closed (or are gone) and turns their Tailscale path off (only that path);
 *       with no room left for LISTEN_IDLE_MS and no connection it exits; it exits at once (checked every
 *       HOME_CHECK_MS, 2 s) when its home directory is gone, or the state file names another live listener. It survives a sleep: a socket bound to
 *       loopback outlives one, a dead peer is found by the WebSocket ping (15 s) and the child's own LINK_SILENT_MS
 *   DEFAULT_PORT                   7420; defaultPort() -> SUB_HUMAN_LISTEN_PORT, else DEFAULT_PORT
 *   logFile() -> <home>/listen/listen.log   the daemon's stdout and stderr
 *   roomLive(code) -> bool         the room is still open here (not stopped, closing or gone): the sweep's test
 *   untailscale(rec, log?) -> {ok, error?} | null   turn a served room's own Tailscale path off (tailscale.off), if it
 *                                  has one; never another path, never `serve reset`
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RoomError } from '../room/validate.ts';
import { isAlive, sleepSync } from '../io.ts';
import * as ioMod from '../io.ts';
import * as textMod from '../text.ts';
import { createRequire } from 'node:module';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ListenState, NoiseStatic, Refusal, ServedRoom, WriteFileAtomic, WsConn } from './types-rest.ts';

/** lib/remote/noise.ts and lib/remote/ws.ts, as the listener uses them (another slice's; loaded on first use). */
interface NoiseModule {
  MAX_MESSAGE: number;
  loadOrCreateStatic(file: string): NoiseStatic;
}
interface WsModule {
  createServer(o: {
    host?: string; port: number; maxPayload?: number; pingMs?: number;
    accept?: (req: IncomingMessage) => boolean | number;
    onConnection(conn: WsConn, req: IncomingMessage): void;
  }): Promise<Server>;
}

/** The listener's status (status()). */
export interface ListenStatus {
  running: boolean;
  pid?: number | null;
  port?: number;
  started_at?: string;
  conns?: number;
  rooms: Record<string, ServedRoom>;
}

const require = createRequire(import.meta.url);

const DEFAULT_PORT = 7420;
const PREAUTH_MAX = 16;
const LISTEN_MAX = 64;
const HANDSHAKE_MS = 10_000;
const WS_PING_MS = 15_000;
const LISTEN_START_MS = 4000;
const LISTEN_IDLE_MS = 10 * 60_000;
const HOME_CHECK_MS = 2000;
const CLOSED_CHECK_MS = 30_000;
const BIN = path.join(import.meta.dirname, '..', '..', 'scripts', 'sub-human');

const home = (): string => path.resolve((require('../home.ts') as { home(): string }).home());
const dir = (): string => path.join(home(), 'listen');
const stateFile = (): string => path.join(dir(), 'state.json');
const logFile = (): string => path.join(dir(), 'listen.log');
const keyFile = (): string => path.join(dir(), 'host-x25519.json');
const staticKey = (): NoiseStatic => (require('./noise.ts') as NoiseModule).loadOrCreateStatic(keyFile());
const hostKey = (): string => staticKey().pub.toString('base64url');
const defaultPort = (): number => Number(process.env.SUB_HUMAN_LISTEN_PORT) || DEFAULT_PORT;

function read(): ListenState {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) || {}; } catch { return {}; }
}

/** Change the state file under its lock; fn(cur) returns the next state. */
function update(fn: (cur: ListenState) => ListenState): ListenState {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const { withLock }: { withLock<T>(file: string, fn: () => T): T } = require('../lock.ts');
  const { writeFileAtomic }: { writeFileAtomic: WriteFileAtomic } = ioMod;
  return withLock(path.join(dir(), 'state.lock'), () => {
    const next = fn(read());
    writeFileAtomic(stateFile(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    return next;
  });
}

function status(): ListenStatus {
  const s = read();
  const running: boolean = isAlive(s.pid);
  return { running, ...(running ? { pid: s.pid, port: s.port, started_at: s.started_at, conns: s.conns || 0 } : {}), rooms: s.rooms || {} };
}

function addRoom(code: string, rec: ServedRoom): ServedRoom {
  update(s => ({ ...s, rooms: { ...(s.rooms || {}), [code]: { ...rec, at: new Date().toISOString() } } }));
  return rec;
}

function removeRoom(code: string): ServedRoom | null {
  let had: ServedRoom | null = null;
  update(s => {
    const rooms = { ...(s.rooms || {}) };
    had = rooms[code] || null;
    delete rooms[code];
    return { ...s, rooms };
  });
  return had;
}

function start({ port = defaultPort() }: { port?: number } = {}): { pid: number; port: number; started: boolean } {
  const cur = status();
  if (cur.running) return { pid: cur.pid!, port: cur.port!, started: false }; // a running listener has both
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  hostKey(); // made here, not raced by the daemon
  const fd = fs.openSync(logFile(), 'a', 0o600);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [BIN, 'listen', '--port', String(port)], { detached: true, stdio: ['ignore', fd, fd], env: process.env });
    child.unref();
  } finally { fs.closeSync(fd); }
  for (const until = Date.now() + LISTEN_START_MS; Date.now() < until; sleepSync(25)) {
    const s = status();
    if (s.running && s.pid === child.pid && s.port === port) return { pid: s.pid!, port, started: true }; // running: a pid
    if (!isAlive(child.pid)) break;
  }
  const tail = (() => { try { return fs.readFileSync(logFile(), 'utf8').trim().split('\n').slice(-2).join(' / '); } catch { return ''; } })();
  throw new RoomError('LOCK', `the listener did not come up on 127.0.0.1:${port}${tail ? ` (${tail})` : ''}; its log is ${logFile()}`);
}

function stop(): boolean {
  const s = status();
  if (!s.running) return false;
  const pid = s.pid!; // running: a pid
  try { process.kill(pid, 'SIGTERM'); } catch { return false; }
  for (const until = Date.now() + 3000; Date.now() < until && isAlive(pid); sleepSync(25)) { /* wait */ }
  if (isAlive(pid)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  return true;
}

/** Is room CODE still open on this host (not stopped, closing or gone)? */
function roomLive(code: string): boolean {
  const identity: {
    roomExists(code: string): boolean; isHost(code: string): boolean;
    readMembers(code: string): Record<string, { stopped_at?: string; closing?: unknown } | undefined>;
  } = require('../identity.ts');
  try {
    if (!identity.roomExists(code) || !identity.isHost(code)) return false;
    const roomClaude = identity.readMembers(code).claude;
    return !(roomClaude && (roomClaude.stopped_at || roomClaude.closing));
  } catch { return false; }
}

/** Turn a room's Tailscale path off, if it has one (never another path, never `serve reset`). */
function untailscale(rec: ServedRoom | null, log: (msg: string) => void = () => {}): { ok: boolean; error?: string | null } | null {
  if (!rec || !rec.tailscale) return null;
  try {
    const r = (require('./tailscale.ts') as typeof import('./tailscale.ts')).off(rec.tailscale);
    log(`tailscale ${rec.tailscale.funnel ? 'funnel' : 'serve'} ${rec.tailscale.path} off: ${r.ok ? 'done' : r.error}`);
    return r;
  } catch (e) { log(`tailscale off: ${(e as Error).message}`); return { ok: false, error: (e as Error).message }; }
}

async function run({ port = defaultPort(), log = (msg: string): unknown => process.stderr.write(`${new Date().toISOString()} sub-human listen: ${msg}\n`), closedCheckMs = Number(process.env.SUB_HUMAN_LISTEN_CHECK_MS) || CLOSED_CHECK_MS, idleMs = Number(process.env.SUB_HUMAN_LISTEN_IDLE_MS) || LISTEN_IDLE_MS }: {
  port?: number; log?: (msg: string) => unknown; closedCheckMs?: number; idleMs?: number;
} = {}): Promise<{ why: string; port: number }> {
  const ws: WsModule = require('./ws.ts');
  const wsT: typeof import('./transports/ws.ts') = require('./transports/ws.ts');
  const { CODE_RE } = textMod;
  const s = staticKey();
  let mine = false;
  update(cur => {
    if (isAlive(cur.pid) && cur.pid !== process.pid) throw new RoomError('LOCK', `a listener already runs here (pid ${cur.pid}, port ${cur.port})`);
    return cur;
  });
  let preauth = 0, conns = 0, finish: (why: string) => void = () => {};
  const done = new Promise<string>(r => { finish = r; });
  const children = new Set<ChildProcessWithoutNullStreams>();
  const publishConns = () => { try { update(cur => (cur.pid === process.pid ? { ...cur, conns } : cur)); } catch { /* best effort */ } };

  const shimCmd = (): string => {
    const shim: typeof import('./shim.ts') = require('./shim.ts');
    const p = shim.refresh();
    if (!p) throw new RoomError('INVALID', `the plugin root ${shim.pluginRoot()} is under a temp dir; the listener will not run what sits there (SUB_HUMAN_ALLOW_TMP_ROOT=1 allows it)`);
    return p;
  };

  async function onConnection(conn: WsConn, req: IncomingMessage): Promise<void> {
    preauth++;
    conns++;
    const who = req.headers['tailscale-user-login'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    conn.on('error', () => {});
    const at = String(req.url || '').split('?')[0].split('/').filter(Boolean).pop();
    const refusal = (code: string): Refusal | null => {
      if (!CODE_RE.test(code)) return { code: 'PROTOCOL', message: 'not a room code' };
      if (at && CODE_RE.test(at) && at !== code) return { code: 'PROTOCOL', message: `this URL is for room ${at}, not ${code}` };
      if (!(read().rooms || {})[code] || !roomLive(code)) return { code: 'OFFLINE', message: `room ${code} is not open for joins over the web here (the host can run /sub-human invite --web or --url again)` };
      return null;
    };
    let ch: { duplex: import('node:stream').Duplex; hello: { room: string } }, first: { data: Buffer; binary: boolean };
    try {
      first = await wsT.firstAny(conn, HANDSHAKE_MS);
      if (!first.binary) return enrollConn(conn, first.data, { refusal, who }); // a short code: text frames, lib/remote/enroll.ts
      ch = await wsT.serverChannel(conn, { s, timeoutMs: HANDSHAKE_MS, m1: first.data, check: hello => refusal(hello.room) });
    } catch (e) {
      preauth--;
      conns--;
      log(`refused a connection from ${who}: ${(e as Error).message}`);
      return;
    }
    preauth--;
    const code = ch.hello.room;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(shimCmd(), ['--stdio', code], { env: { ...process.env, SUB_HUMAN_HOME: home() }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      log(`room ${code}: could not start serve: ${(e as Error).message}`);
      ch.duplex.destroy();
      conns--;
      return;
    }
    children.add(child);
    log(`room ${code}: a connection from ${who}; serve pid ${child.pid}`);
    publishConns();
    child.stdout.pipe(ch.duplex);
    ch.duplex.pipe(child.stdin);
    child.stdin.on('error', () => {});
    child.stderr.on('data', (d: Buffer) => { for (const l of String(d).split('\n').filter(Boolean)) log(`room ${code} serve ${child.pid}: ${l}`); });
    ch.duplex.on('error', () => {});
    ch.duplex.on('close', () => { child.stdin.end(); setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 2000).unref(); });
    child.on('exit', (c, sig) => {
      children.delete(child);
      conns--;
      log(`room ${code}: serve ${child.pid} exited (${sig || c})`);
      ch.duplex.destroy();
      publishConns();
    });
  }

  /**
   * A short code's attempt (its first message is text): `<home>/bin/serve --enroll CODE --kind ws` for this one
   * connection, each text message one line of its stdin and each line it writes one text message. Nothing else is
   * parsed here; the child runs the PAKE and counts the tries. It holds a pre-auth slot until it exits.
   */
  function enrollConn(conn: WsConn, data: Buffer, { refusal, who }: { refusal: (code: string) => Refusal | null; who: unknown }): void {
    const protocol: typeof import('./protocol.ts') = require('./protocol.ts');
    let frame: { id?: unknown; op?: unknown; params?: { room?: unknown } } | null = null; // parsed JSON, checked below
    try { frame = JSON.parse(data.toString('utf8')); } catch { /* refused below */ }
    const code = frame && frame.params && frame.params.room;
    const no: Refusal | null = !frame || frame.op !== 'enroll.start' || typeof code !== 'string' ? { code: 'PROTOCOL', message: 'a text message that is not an enrollment' } : refusal(code);
    const release = () => { preauth--; conns--; publishConns(); };
    if (no) {
      conn.send(protocol.encode(protocol.error(frame && frame.id !== undefined ? frame.id : null, no.code, no.message)).trimEnd());
      conn.close(4404, 'refused');
      log(`refused an enrollment from ${who}: ${no.message}`);
      return release();
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(shimCmd(), ['--enroll', code as string, '--kind', 'ws'], { env: { ...process.env, SUB_HUMAN_HOME: home() }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      log(`room ${code}: could not start the enrollment: ${(e as Error).message}`);
      conn.close(1011, 'no enrollment');
      return release();
    }
    children.add(child);
    log(`room ${code}: a short-code attempt from ${who}; enroll pid ${child.pid}`);
    publishConns();
    const dec = protocol.decoder();
    child.stdin.on('error', () => {});
    child.stdin.write(`${data.toString('utf8').replace(/\n/g, '')}\n`);
    child.stdout.on('data', (d: Buffer) => { for (const f of dec.push(d)) conn.send(JSON.stringify(f)); });
    child.stderr.on('data', (d: Buffer) => { for (const l of String(d).split('\n').filter(Boolean)) log(`room ${code} enroll ${child.pid}: ${l}`); });
    conn.on('message', (m, binary) => {
      if (binary || m.length > 16 * 1024) { conn.close(1003, 'text frames only'); return; }
      child.stdin.write(`${m.toString('utf8').replace(/\n/g, '')}\n`);
    });
    conn.on('close', () => { child.stdin.end(); setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 2000).unref(); });
    child.on('exit', (c, sig) => {
      children.delete(child);
      log(`room ${code}: enroll ${child.pid} exited (${sig || c})`);
      setTimeout(() => { if (conn.state === 'open') conn.close(1000, 'done'); }, 50);
      release();
    });
    return undefined;
  }

  const srv = await ws.createServer({
    host: '127.0.0.1',
    port,
    maxPayload: require('./noise.ts').MAX_MESSAGE + 64,
    pingMs: WS_PING_MS,
    accept: () => (preauth >= PREAUTH_MAX || conns >= LISTEN_MAX ? 503 : true),
    onConnection: (conn, req) => { onConnection(conn, req).catch((e: Error) => log(`connection: ${e.stack || e}`)); },
  });
  const real = (srv.address() as AddressInfo).port; // a TCP listener
  update(cur => { mine = true; return { ...cur, pid: process.pid, port: real, started_at: new Date().toISOString(), conns: 0, rooms: cur.rooms || {} }; });
  log(`listening on 127.0.0.1:${real} (host key ${hostKey().slice(0, 12)}…)`);

  let idleSince = Date.now();
  const sweep = setInterval(() => {
    let rooms: Record<string, ServedRoom> = {};
    try { rooms = read().rooms || {}; } catch { /* next time */ }
    for (const [code, rec] of Object.entries(rooms)) {
      if (roomLive(code)) continue;
      log(`room ${code} closed: no longer served`);
      untailscale(removeRoom(code) || rec, log);
    }
    if (Object.keys(read().rooms || {}).length || conns) idleSince = Date.now();
    else if (Date.now() - idleSince >= idleMs) end('no room is served over the web any more');
  }, Math.min(closedCheckMs, idleMs));
  sweep.unref();
  // its home removed (a test's temp home, a deleted SUB_HUMAN_HOME), or another listener took the state file: go
  const homeDir = home();
  const orphan = setInterval(() => {
    if (!fs.existsSync(homeDir)) return end('its home is gone');
    const pid = read().pid;
    if (pid && pid !== process.pid && isAlive(pid)) end(`another listener (pid ${pid}) took over`);
  }, HOME_CHECK_MS);
  orphan.unref();

  function end(why: string): void {
    clearInterval(sweep);
    clearInterval(orphan);
    srv.close();
    for (const c of children) try { c.kill(); } catch { /* gone */ }
    if (mine) try { update(cur => (cur.pid === process.pid ? { ...cur, pid: null, conns: 0 } : cur)); } catch { /* best effort */ }
    log(`stopped: ${why}`);
    finish(why);
  }
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(sig, () => end(`stopped by ${sig}`));
  const why = await done;
  return { why, port: real };
}

export {
  DEFAULT_PORT, keyFile, hostKey, stateFile, logFile, status, addRoom, removeRoom, start, stop, run, roomLive,
  untailscale, defaultPort,
};
