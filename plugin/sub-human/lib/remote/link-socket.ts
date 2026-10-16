/**
 * plugin/sub-human/lib/remote/link-socket.ts: the link daemon's unix socket, both ends, and its control from a hook or
 * the CLI. The daemon (lib/remote/link.ts) listens; a hook's bridge worker (lib/remote/bridge.ts, handler = this
 * file's handle) relays one op and reads one reply. Loading this file loads no store and no daemon: handle runs on
 * every writing hook's bridge worker.
 *
 *   socketPath(dir) -> string      one per room and home, from the mirror's directory alone (never TMPDIR: a daemon a
 *                                  listener, sshd or a handoff started and the session's hooks need not share it):
 *                                  <dir>/.link/link.sock, or, when that is longer than a socket path may be (103
 *                                  bytes, macOS), /tmp/sub-human-<uid>/<hash12(dir)>/link.sock. Each directory is
 *                                  0700, a real directory and ours: the daemon refuses any other, a hook skips it.
 *                                  The daemon records the path it bound in its document `link` (socket)
 *   socketPaths(dir, doc?) -> string[]   where a hook looks, in order: doc.socket, then socketPath(dir)
 *   handle(method, params) -> Promise<result>   the bridge handler, params {socket, params}: one op (RELAY) over the first
 *                                  socket (one path or socketPaths' list) that accepts the connection, the result as the
 *                                  wire has it (an error with its code and reason); OFFLINE DAEMON_DOWN when no daemon is
 *                                  listening (nothing is started from a hook's call)
 *   listen(file, relay) -> Promise<net.Server>   the daemon's end: a server on the socket file, in a directory only this
 *                                  user can enter (AUTH otherwise); a stale socket file is replaced, a live one is LOCK.
 *                                  relay(op, params) -> Promise<result> answers each hook's one op
 *   status(code) -> {running, pid?, state?, since?, reason?, code?, why?}   the daemon's document `link`; running: its
 *                                  pid lives; code: the RoomError that stopped it (AUTH, PROTOCOL, FORK), why its reason
 *   stopReason(doc) -> {code, reason, why} | null   why a stopped link stopped (a hook whose op met a daemon that hung up
 *                                  or is gone reports this, e.g. AUTH "this invite is unknown or was used already")
 *   start(code) -> bool            start the daemon detached (`scripts/sub-human link CODE`; stdout and stderr to
 *                                  lib/room/links.ts logFile) unless it runs; wait up to LINK_START_MS for it to listen
 *   RELAY                          the ops a hook may relay: join leave beat append blob.get blob.put handoff.accept
 *                                  handoff.refuse
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as protocol from './protocol.ts';
import { RoomError } from '../room/validate.ts';
import { isReason, reasonOf } from '../reasons.ts';
import { errCode, msgOf } from '../errors.ts';
import { isAlive, sleepSync } from '../io.ts';
import { hash12 } from '../text.ts';
import { isObj } from '../decode.ts';
import * as config from '../config.ts';
import { createRequire } from 'node:module';
import type { Reason } from '../reasons.ts';
import type { DecodedFrame, ErrorFrame, FrameId, LinkDoc, ReplyFrame, WireCode } from './types-core.ts';

/** The daemon's document `link`, and whether its pid lives. */
type LinkStatus = (LinkDoc & { running: true; pid: number }) | (LinkDoc & { running: false });
/** One relayed op's params as a hook sends them: an append may carry {queue: true}. */
type Relay = (op: string, params: { [field: string]: unknown }) => Promise<unknown>;

const require = createRequire(import.meta.url);
// the store and the link files, only for status and start: the bridge worker that loads this file for handle never needs them
const storeMod = (): typeof import('../room/store.ts') => require('../room/store.ts');
const linksMod = (): typeof import('../room/links.ts') => require('../room/links.ts');
const BIN = path.join(import.meta.dirname, '..', '..', 'scripts', 'sub-human');
const RELAY: ReadonlySet<string> = new Set(['join', 'leave', 'beat', 'append', 'blob.get', 'blob.put', 'handoff.accept', 'handoff.refuse']);
const SUN_PATH_MAX = 103; // a unix socket's path: 104 bytes on macOS with its NUL (108 on Linux)
const STOPPED: ReadonlySet<unknown> = new Set(['fork', 'stopped']);

// ---------- where ----------
function socketPath(dir: string): string {
  const own = path.join(path.resolve(dir), '.link', 'link.sock');
  if (Buffer.byteLength(own) <= SUN_PATH_MAX) return own;
  return path.join(shortBase(), hash12(path.resolve(dir)), 'link.sock');
}

/** The fixed per-user directory a socket goes in when the mirror's own path is too long: /tmp/sub-human-<uid>.
 * Never TMPDIR, which a daemon started by a listener, sshd or launchd and the session's hooks need not share. */
const shortBase = (): string => `/tmp/sub-human-${typeof process.getuid === 'function' ? process.getuid() : 'u'}`;

/** Where a hook looks for the daemon, in order: the path the running daemon recorded, then socketPath(dir). */
function socketPaths(dir: string, doc?: { socket?: unknown } | null): string[] {
  const rec: string[] = doc && typeof doc.socket === 'string' && path.isAbsolute(doc.socket) ? [doc.socket] : [];
  return [...new Set([...rec, socketPath(dir)])];
}

/** A directory only this user can enter: a real directory (not a symlink), ours, no group or other bits. */
function isPrivateDir(dir: string): boolean {
  let st: fs.Stats;
  try { st = fs.lstatSync(dir); } catch { return false; }
  return st.isDirectory() && (typeof process.getuid !== 'function' || st.uid === process.getuid()) && !(st.mode & 0o077);
}

/** Make the socket's directory 0700 (and the shared /tmp base when it is under it) and check both: AUTH when one is
 * a symlink, someone else's or open to others. */
function ensurePrivateDir(dir: string): void {
  const base = shortBase();
  if (path.dirname(dir) === base) {
    try { fs.mkdirSync(base, { mode: 0o700 }); } catch (e) { if (errCode(e) !== 'EEXIST') throw e; }
    if (!isPrivateDir(base)) throw new RoomError('AUTH', `${base} is not private to this user (a symlink, someone else's, or open to others)`);
  }
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) { if (errCode(e) !== 'EEXIST') throw e; }
  if (!isPrivateDir(dir)) throw new RoomError('AUTH', `${dir} is not private to this user`);
}

// ---------- the hook's end ----------
async function handle(method: string, { socket, params }: { socket: string | string[]; params: object }): Promise<unknown> {
  if (!RELAY.has(method)) throw new RoomError('PROTOCOL', `${method} is not relayed to the host`);
  let last: NotListening | null = null;
  for (const file of Array.isArray(socket) ? socket : [socket]) {
    // a socket in a directory someone else could have made is never handed a seat's op
    if (!isPrivateDir(path.dirname(file))) continue;
    try { return await relayOnce(file, method, params); } catch (e) {
      if (!(e instanceof NotListening)) throw e;
      last = e;
    }
  }
  throw last || new RoomError('OFFLINE', 'the link daemon is not running (ENOENT)', 'DAEMON_DOWN');
}

/** OFFLINE DAEMON_DOWN before the connection was made: no daemon listens on this path (handle tries the next). */
class NotListening extends RoomError {
  constructor(message: string) { super('OFFLINE', message, 'DAEMON_DOWN'); }
}

/** One op over one socket; an error before the connection is made is a NotListening (try the next path). */
function relayOnce(socket: string, method: string, params: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socket);
    const dec = protocol.decoder();
    let connected = false;
    conn.on('connect', () => { connected = true; conn.write(protocol.encode(protocol.request(1, method, params))); });
    conn.on('data', (chunk: Buffer) => {
      const [f] = dec.push(chunk) as ReplyFrame[]; // the daemon answers with one reply
      if (!f) return;
      conn.end();
      if (f.error) reject(protocol.toError(f.error));
      else resolve(f.result);
    });
    conn.on('error', (e: NodeJS.ErrnoException) => {
      const message = `the link daemon is not running (${e.code || e.message})`;
      reject(connected ? new RoomError('OFFLINE', message, 'DAEMON_DOWN') : new NotListening(message));
    });
    conn.on('close', () => reject(new RoomError('OFFLINE', 'the link daemon hung up', 'DAEMON_DOWN')));
  });
}

// ---------- the daemon's end ----------
const listening = (srv: net.Server, file: string): Promise<void> => new Promise((resolve, reject) => {
  srv.once('error', reject);
  srv.listen(file, () => { srv.off('error', reject); resolve(); });
});
const answers = (file: string): Promise<boolean> => new Promise(resolve => {
  const c = net.createConnection(file);
  c.on('connect', () => { c.destroy(); resolve(true); });
  c.on('error', () => resolve(false));
});

async function listen(file: string, relay: Relay): Promise<net.Server> {
  ensurePrivateDir(path.dirname(file));
  const srv = net.createServer(sock => serveHook(sock, relay));
  try { await listening(srv, file); } catch (e) {
    if (errCode(e) !== 'EADDRINUSE') throw e;
    if (await answers(file)) throw new RoomError('LOCK', `a link daemon already listens on ${file}`);
    fs.rmSync(file, { force: true });
    await listening(srv, file);
  }
  fs.chmodSync(file, 0o600); // its directory already shuts others out; the file says so too (the umask gave it 0755)
  return srv;
}

/** One hook's request: the op relayed, or the error, as one frame (its code and reason). */
async function answer(f: DecodedFrame | ErrorFrame, relay: Relay): Promise<ReplyFrame> {
  const g = f as { id?: FrameId; op?: unknown }; // the frame as it came, for the error
  try {
    if (!protocol.isRequest(f) || !RELAY.has(f.op)) throw new RoomError('PROTOCOL', `not an op a hook may relay: ${g.op}`);
    return protocol.reply(f.id, await relay(f.op, isObj(f.params) ? f.params : {}));
  } catch (e) {
    const code = errCode(e);
    return protocol.error(g.id ?? null, protocol.isWireCode(code) ? code : 'INVALID', msgOf(e), reasonOf(e));
  }
}

function serveHook(sock: net.Socket, relay: Relay): void {
  const dec = protocol.decoder();
  sock.on('error', () => { /* the hook gave up at its deadline */ });
  sock.on('data', (chunk: Buffer) => {
    for (const f of dec.push(chunk)) answer(f, relay).then(out => sock.end(protocol.encode(out)));
  });
}

// ---------- control ----------
function status(code: string): LinkStatus {
  const st: LinkDoc = storeMod().open(code).kv.get('link') || {};
  return { ...st, running: isAlive(st.pid) } as LinkStatus; // running: its pid (a number) lives
}

function stopReason(st: LinkDoc | null | undefined): { code: WireCode; reason: string; why: Reason | null } | null {
  if (!st || !STOPPED.has(st.state) || !st.reason) return null;
  return { code: protocol.isWireCode(st.code) ? st.code : st.state === 'fork' ? 'FORK' : 'OFFLINE', reason: st.reason, why: isReason(st.why) ? st.why : null };
}

function start(code: string): boolean {
  if (status(code).running) return true;
  const fd = fs.openSync(linksMod().logFile(code), 'a', 0o600);
  try { spawn(process.execPath, [BIN, 'link', code], { detached: true, stdio: ['ignore', fd, fd] }).unref(); } finally { fs.closeSync(fd); }
  for (const until = Date.now() + config.LINK_START_MS; Date.now() < until; sleepSync(20)) if (status(code).running) return true;
  return false;
}

export { socketPath, socketPaths, handle, listen, status, stopReason, start, RELAY };
export type { LinkStatus, Relay };
