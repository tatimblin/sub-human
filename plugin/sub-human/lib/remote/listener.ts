/**
 * plugin/sub-human/lib/remote/listener.ts: the host's WebSocket listener daemon (`scripts/sub-human listen [--port
 * 7420]`), one per home. It binds 127.0.0.1 only; a TLS front (Tailscale Serve or Funnel; the lab's Caddy) is the
 * only way in from elsewhere. A WebSocket whose first message is TEXT asks for the
 * host's public key ({"op": "key"}, answered {"v": 3, "key"} and closed: an invite line's first dial checks it against
 * the line's tag before anything secret goes). For each other WebSocket it runs the Noise handshake as
 * the responder with the host's static X25519 key (lib/remote/transports/ws.ts serverChannel: XK), checks the room the joiner names is one this home serves over ws, and only then spawns
 * `<home>/bin/serve --stdio CODE --via ws [--peer KEY]` (the stable shim, lib/remote/shim.ts; KEY: the link's own
 * Noise key XK proved) for that one connection, piping decrypted bytes to its stdin and its stdout back. It never
 * runs lib/remote/server.ts in-process (the store lock busy-waits; one wait would stall every connection), parses no
 * protocol frame, and never sees a secret in clear outside the child's pipes. The child authenticates the hello
 * (an invite line and its PIN, or a link token and its key) as for any transport.
 *
 * The host's static Noise key (keyFile, 0600) is a random X25519 key of its own, made once per home. It is neither
 * derived from nor signed by any other key: node:crypto cannot turn an Ed25519 seat key into an X25519 one without
 * hand-written field arithmetic, and keeping roles apart means a leak of one never opens the other. The invite pins it
 * directly (an invite line's tag, role 'listener'; a bound invite's host-key field), so no binding to the machine id
 * is needed. The state file's rooms are what this home serves over ws; a room not in it is refused at the handshake.
 *
 * Limits before a handshake completes: at most PREAUTH_MAX connections in handshake, LISTEN_MAX in all, SOURCE_MAX
 * from one source (the front's Tailscale login or X-Forwarded-For), HANDSHAKE_MS to finish it, Noise-sized frames;
 * after it, the serve child closes a session that made no link within LINK_AUTH_WAIT_MS (server.ts). Every
 * CLOSED_CHECK_MS it drops rooms that closed and turns their own Tailscale path off (never another, never `serve
 * reset`); it exits once the last room it served closed and no connection is open, after LISTEN_IDLE_MS with no room
 * and no connection, and at once (HOME_CHECK_MS) when its home is gone or the state file names another live
 * listener. It survives a sleep: a loopback socket outlives one, and a dead peer is found by the WebSocket ping
 * (WS_PING_MS) and the child's own LINK_SILENT_MS.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RoomError } from '../room/validate.ts';
import { isAlive, readJson, sleepSync, lazy } from '../io.ts';
import { isObj, objAs } from '../decode.ts';
import { envNum } from '../env.ts';
import * as ioMod from '../io.ts';
import * as textMod from '../text.ts';
import { isRoomCode } from '../text.ts';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ListenState, Refusal, ServedRoom } from './types-rest.ts';
import type { KeyPair } from './noise.ts';
import type { FrameId } from './types-core.ts';
import type { Duplex } from 'node:stream';
import type { Conn } from './ws.ts';
import { msgOf, stackOf } from '../errors.ts';
import { withLock } from '../lock.ts';
import * as identity from '../identity.ts';
import * as homeMod from '../home.ts';
import type { RoomCode } from '../brand.ts';
import type * as NoiseMod from './noise.ts';
import type * as TailscaleMod from './tailscale.ts';
import type * as WsMod from './ws.ts';
import type * as TransportsWsMod from './transports/ws.ts';
import type * as ShimMod from './shim.ts';
import type * as ProtocolMod from './protocol.ts';


/** The listener's status (status()). */
export interface ListenStatus {
  running: boolean;
  pid?: number | null;
  port?: number;
  started_at?: string;
  conns?: number;
  rooms: Record<string, ServedRoom>;
}

// the server side only in the listener's own process (start cost: hooks and the CLI read its state through this file)
const wsLib = lazy<typeof WsMod>(import.meta.url, './ws.ts');
const transportsWsLib = lazy<typeof TransportsWsMod>(import.meta.url, './transports/ws.ts');
const shimLib = lazy<typeof ShimMod>(import.meta.url, './shim.ts');
const protocolLib = lazy<typeof ProtocolMod>(import.meta.url, './protocol.ts');
const noiseLib = lazy<typeof NoiseMod>(import.meta.url, './noise.ts');
const tailscaleLib = lazy<typeof TailscaleMod>(import.meta.url, './tailscale.ts');

const DEFAULT_PORT = 7420;
const PREAUTH_MAX = 16;
const LISTEN_MAX = 64;
/** At most this many connections at once from one source (the front's Tailscale login or X-Forwarded-For). */
const SOURCE_MAX = 8;
const HANDSHAKE_MS = 10_000;
const WS_PING_MS = 15_000;
const LISTEN_START_MS = 4000;
const LISTEN_IDLE_MS = 10 * 60_000;
const HOME_CHECK_MS = 2000;
const CLOSED_CHECK_MS = 30_000;
const BIN = path.join(import.meta.dirname, '..', '..', 'scripts', 'sub-human');

const home = (): string => path.resolve(homeMod.home());
const dir = (): string => path.join(home(), 'listen');
const stateFile = (): string => path.join(dir(), 'state.json');
const logFile = (): string => path.join(dir(), 'listen.log');
const keyFile = (): string => path.join(dir(), 'host-x25519.json');
const staticKey = (): KeyPair => noiseLib().loadOrCreateStatic(keyFile());
const hostKey = (): string => staticKey().pub.toString('base64url');
const defaultPort = (): number => envNum('SUB_HUMAN_LISTEN_PORT') || DEFAULT_PORT;

function read(): ListenState {
  return readJson(stateFile(), objAs<ListenState>(), {});
}

/** Change the state file under its lock; fn(cur) returns the next state. */
function update(fn: (cur: ListenState) => ListenState): ListenState {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const { writeFileAtomic } = ioMod;
  return withLock(path.join(dir(), 'state.lock'), () => {
    const next = fn(read());
    writeFileAtomic(stateFile(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    return next;
  });
}

function status(): ListenStatus {
  const s = read();
  const running: boolean = isAlive(s.pid);
  return { running, ...(running ? { pid: s.pid, port: s.port, started_at: s.started_at, conns: s.conns || 0 } : {}), rooms: s.rooms ?? {} };
}

function addRoom(code: RoomCode, rec: ServedRoom): ServedRoom {
  update(s => ({ ...s, rooms: { ...(s.rooms ?? {}), [code]: { ...rec, at: new Date().toISOString() } } }));
  return rec;
}

function removeRoom(code: string): ServedRoom | null {
  let had: ServedRoom | null = null;
  update(s => {
    const rooms = { ...(s.rooms ?? {}) };
    had = rooms[code] ?? null;
    delete rooms[code];
    return { ...s, rooms };
  });
  return had;
}

function start({ port = defaultPort() }: { port?: number } = {}): { pid: number; port: number; started: boolean } {
  const cur = status();
  // running: isAlive took its pid, so it is set; its port is the state file's, written with the pid
  if (cur.running && cur.pid != null) return { pid: cur.pid, port: cur.port ?? port, started: false };
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
    if (s.running && typeof s.pid === 'number' && s.pid === child.pid && s.port === port) return { pid: s.pid, port, started: true }; // running: a pid
    if (!isAlive(child.pid)) break;
  }
  const tail = (() => { try { return fs.readFileSync(logFile(), 'utf8').trim().split('\n').slice(-2).join(' / '); } catch { return ''; } })();
  throw new RoomError('LOCK', `the listener did not come up on 127.0.0.1:${port}${tail ? ` (${tail})` : ''}; its log is ${logFile()}`);
}

function stop(): boolean {
  const s = status();
  const { pid } = s;
  if (!s.running || pid == null) return false; // running: a pid
  try { process.kill(pid, 'SIGTERM'); } catch { return false; }
  for (const until = Date.now() + 3000; Date.now() < until && isAlive(pid); sleepSync(25)) { /* wait */ }
  if (isAlive(pid)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  return true;
}

/** Is room CODE still open on this host (not stopped, closing or gone)? */
function roomLive(code: string): boolean {
  try {
    if (!isRoomCode(code) || !identity.roomExists(code) || !identity.isHost(code)) return false;
    const roomClaude = identity.readMembers(code).claude;
    return !(roomClaude && (roomClaude.stopped_at || roomClaude.closing));
  } catch { return false; }
}

/** Turn a room's Tailscale path off, if it has one (never another path, never `serve reset`). */
function untailscale(rec: ServedRoom | null, log: (msg: string) => void = () => {}): { ok: boolean; error?: string | null } | null {
  if (!rec || !rec.tailscale) return null;
  try {
    const r = tailscaleLib().off(rec.tailscale);
    log(`tailscale ${rec.tailscale.funnel ? 'funnel' : 'serve'} ${rec.tailscale.path} off: ${r.ok ? 'done' : r.error}`);
    return r;
  } catch (e) { log(`tailscale off: ${msgOf(e)}`); return { ok: false, error: msgOf(e) }; }
}

async function run({ port = defaultPort(), log = (msg: string): unknown => process.stderr.write(`${new Date().toISOString()} sub-human listen: ${msg}\n`), closedCheckMs = envNum('SUB_HUMAN_LISTEN_CHECK_MS') || CLOSED_CHECK_MS, idleMs = LISTEN_IDLE_MS }: {
  port?: number; log?: (msg: string) => unknown; closedCheckMs?: number; idleMs?: number;
} = {}): Promise<{ why: string; port: number }> {
  const ws = wsLib();
  const wsT = transportsWsLib();
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
    const shim = shimLib();
    const p = shim.refresh();
    if (!p) throw new RoomError('INVALID', `the plugin root ${shim.pluginRoot()} is under a temp dir; the listener will not run what sits there (SUB_HUMAN_ALLOW_TMP_ROOT=1 allows it)`);
    return p;
  };

  const bySource = new Map<string, number>();
  async function onConnection(conn: Conn, req: IncomingMessage): Promise<void> {
    preauth++;
    conns++;
    const who = String(req.headers['tailscale-user-login'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?');
    conn.on('error', () => {});
    // one source holds at most SOURCE_MAX of the LISTEN_MAX connections (each a serve process once its handshake is done)
    if ((bySource.get(who) || 0) >= SOURCE_MAX) {
      preauth--;
      conns--;
      log(`refused a connection from ${who}: ${SOURCE_MAX} open from there already`);
      try { conn.close(1013, 'busy'); } catch { /* gone */ }
      return;
    }
    bySource.set(who, (bySource.get(who) || 0) + 1);
    conn.on('close', () => { const n = (bySource.get(who) || 1) - 1; if (n > 0) bySource.set(who, n); else bySource.delete(who); });
    const [p = ''] = String(req.url || '').split('?'); // split gives at least one part
    const at = p.split('/').filter(Boolean).pop();
    const refusal = (code: string): Refusal | null => {
      if (!isRoomCode(code)) return { code: 'PROTOCOL', message: 'not a room code' };
      if (at && CODE_RE.test(at) && at !== code) return { code: 'PROTOCOL', message: `this URL is for room ${at}, not ${code}` };
      if (!(read().rooms ?? {})[code] || !roomLive(code)) return { code: 'OFFLINE', message: `room ${code} is not open for joins over the web here (the host can run /sub-human invite --web again)` };
      return null;
    };
    let ch: { duplex: Duplex; hello: { room: string }; peer: Buffer | null }, first: { data: Buffer; binary: boolean };
    try {
      first = await wsT.firstAny(conn, HANDSHAKE_MS);
      if (!first.binary) return textConn(conn, first.data, who); // a key request
      ch = await wsT.serverChannel(conn, { s, timeoutMs: HANDSHAKE_MS, m1: first.data, check: hello => refusal(hello.room) });
    } catch (e) {
      preauth--;
      conns--;
      log(`refused a connection from ${who}: ${msgOf(e)}`);
      return;
    }
    preauth--;
    const code = ch.hello.room;
    const args = ['--stdio', code, '--via', 'ws', ...(ch.peer ? ['--peer', ch.peer.toString('base64url')] : [])];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(shimCmd(), args, { env: { ...process.env, SUB_HUMAN_HOME: home() }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      log(`room ${code}: could not start serve: ${msgOf(e)}`);
      ch.duplex.destroy();
      conns--;
      return;
    }
    children.add(child);
    log(`room ${code}: a connection from ${who}${ch.peer ? ` (key ${ch.peer.toString('base64url').slice(0, 12)}…)` : ''}; serve pid ${child.pid}`);
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
   * A TEXT first message: {"op": "key"} gets this listener's public key (an invite line's first dial checks it against
   * the line's tag before it sends anything secret); anything else a refusal. Each holds its pre-auth slot only until it is answered.
   */
  function textConn(conn: Conn, data: Buffer, who: unknown): void {
    const protocol = protocolLib();
    let v: unknown = null;
    try { v = JSON.parse(data.toString('utf8')); } catch { /* refused below */ }
    const frame = isObj(v) ? v : null; // parsed JSON, checked below
    const id: FrameId = frame && (typeof frame.id === 'number' || typeof frame.id === 'string') ? frame.id : null;
    if (frame && frame.op === 'key') conn.send(JSON.stringify({ v: 3, key: hostKey() }));
    else {
      conn.send(protocol.encode(protocol.error(id, 'PROTOCOL', 'a text message that is not a key request')).trimEnd());
      log(`refused a text message from ${who}`);
    }
    setTimeout(() => { if (conn.state === 'open') conn.close(1000, 'done'); }, 50);
    preauth--;
    conns--;
  }

  const srv = await ws.createServer({
    host: '127.0.0.1',
    port,
    maxPayload: noiseLib().MAX_MESSAGE + 64,
    pingMs: WS_PING_MS,
    accept: () => (preauth >= PREAUTH_MAX || conns >= LISTEN_MAX ? 503 : true),
    onConnection: (conn, req) => { onConnection(conn, req).catch((e: unknown) => log(`connection: ${stackOf(e)}`)); },
  });
  const real = (srv.address() as AddressInfo).port; // a TCP listener
  update(cur => { mine = true; return { ...cur, pid: process.pid, port: real, started_at: new Date().toISOString(), conns: 0, rooms: cur.rooms ?? {} }; });
  log(`listening on 127.0.0.1:${real} (host key ${hostKey().slice(0, 12)}…)`);

  let idleSince = Date.now();
  const sweep = setInterval(() => {
    let rooms: Record<string, ServedRoom> = {};
    try { rooms = read().rooms ?? {}; } catch { /* next time */ }
    let dropped = false;
    for (const [code, rec] of Object.entries(rooms)) {
      if (roomLive(code)) continue;
      log(`room ${code} closed: no longer served`);
      untailscale(removeRoom(code) ?? rec, log);
      dropped = true;
    }
    // the last room it served closed and nobody is connected: nothing to wait for (a listener started with
    // no room still waits LISTEN_IDLE_MS for one)
    if (dropped && !Object.keys(read().rooms ?? {}).length && !conns) return end('the last room it served closed');
    if (Object.keys(read().rooms ?? {}).length || conns) idleSince = Date.now();
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
