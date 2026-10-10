/**
 * plugin/sub-human/lib/remote/link.ts: the link daemon, one per machine and room (`scripts/sub-human link CODE`,
 * started detached by the join hook, like the room's Claude starter). It holds the one connection to the host
 * (lib/remote/client.ts over the transport in the link file, lib/room/links.ts), keeps the mirror
 * (lib/room/store-mirror.ts applyLine / applyDoc / applyBlob) byte-identical to the host's log, prefetches every
 * proposal's plan, and serves the hooks of this machine on a unix socket: a hook's bridge worker
 * (lib/remote/bridge.ts, handler = this file's handle) relays one op and gets one reply. It never loads the
 * signer. Loading this file loads no store (handle runs on every writing hook's bridge worker; the daemon's
 * modules are required inside run).
 *
 *   run({code, log?}) -> Promise<reason>
 *       serveMirror over the link file's transport (connectLink: a short code's enrollment first when the link file
 *       holds one (lib/remote/enroll.ts enrollLink), then hello with the token, or the invite once, with its
 *       PIN for an sh2 one, whose token then replaces both in the link file, so a redial never sends the PIN again;
 *       caps {ping: true}), until it stops; also stops LINK_IDLE_MS
 *       (SUB_HUMAN_LINK_IDLE_MS) after this machine has no seat left in the room (idleWatch), and on SIGTERM,
 *       SIGINT or SIGHUP. SIGUSR2 redials now, as a wake does.
 *   idleWatch(link, mirror, idleMs) -> unwatch   stop the link once idleMs have passed with no seat of this
 *       machine in the room. Online, a seat is one the mirror's members document holds with a fresh lease;
 *       offline, the host's document is stale, so a seat is one a live claude process of this machine holds
 *       (identity.localSeats): a crashed or abandoned join never leaves a daemon retrying for ever. While the
 *       first connection is made it never stops, nor while the link file holds an invite younger than
 *       INVITE_TTL_MS (an sh2 join over ssh retries until the host admits its key; the hello then sends the PIN).
 *   serveMirror({mirror, connect, log?, retryMs?, retryMaxMs?, timings?, clock?, random?, mono?, netSignature?, watch?,
 *       seats?, writeState?, outbox?}) -> Promise<Link>
 *       Listen on socketPath(mirror.dir) (one daemon per socket: LOCK when another one answers there), then dial:
 *       connect() -> Promise<Client> (hello done), subscribe {after: the mirror's last id, hash: that line's hash12},
 *       renew the lease of every live seat of this machine (seats(), default identity.localSeats: a `beat`, so a
 *       seat whose lease lapsed on the host during an outage is back with no "left"/"joined" lines; one the host
 *       shows as left is logged: the person joins again), send the outbox, and only then is the link online.
 *       The stream goes into the mirror (a line it holds already, the same id and bytes, is skipped: two streams
 *       overlap during a swap); a proposal's plan is fetched once.
 *       Reconnect (timings: linkTimings(), lib/config.ts LINK_*; clock: lib/clock.ts, injectable):
 *         backoff     a lost connection is OFFLINE, dialled again after a delay with decorrelated jitter
 *                     (nextDelay: random in [retryMs, 3 x the last delay], at most retryMaxMs)
 *         wake        wakeWatch: a timer ticking every wakeTickMs that fires more than wakeGapMs late, or finds the
 *                     wall clock off the monotonic one (mono) by that much, means the machine slept; netWatch:
 *                     netSignature() (os.networkInterfaces' external addresses) changed. Either redials now with
 *                     the backoff reset (watch: false turns both off)
 *         heartbeat   with a server whose caps list ping: a ping every pingMs; no pong within pongMs is suspect
 *                     (redial, make before break); none within deadMs is dead (closed: half-open after a sleep)
 *         make before break   a redial while online makes the new connection completely (subscribed, seats
 *                     renewed, outbox sent) before it replaces the old one, which then closes; hooks' ops use the
 *                     old one meanwhile. A redial that fails keeps the old one. One dial at a time
 *       A hook's op while not online is refused OFFLINE at once (before the first connection it waits for it),
 *       except an append marked {queue: true} (lib/room/store-mirror.ts, for an @room post) whose payload is
 *       outbox.queueable (lib/remote/outbox.ts): it is kept in the outbox and answered {queued: n}. Answers,
 *       consent, proposals and agents' posts are never queued. Online, every op is answered within relayMs
 *       (LINK_RELAY_MS, inside the hook's LINK_CALL_MS): a slow link's late answer must not turn into "nothing was
 *       sent", since the frame went out. Such a queueable post goes into the outbox under its nonce and is answered
 *       {queued: n, slow: true}; the host's late answer takes it out (placed, or "placed already"), or drops and
 *       reports it (a refusal); a connection lost first leaves it for the next one. Any other op is OFFLINE with
 *       protocol.UNKNOWN_OUTCOME: retrying it is safe (an answer is one per person per proposal, a join is a rejoin). The outbox is sent in order on the new
 *       connection; a post the host already holds is answered "placed already" (its nonce) and counts as sent;
 *       one that waited longer than LINK_OUTBOX_AGE_MS or that the host refuses is dropped and reported in the
 *       document `link` (flush). FORK (the host's line `after` is not the mirror's, a line that does not chain,
 *       or the host log reset) stops it, keeps the outbox, and logs loudly: `sub-human link --reset CODE`
 *       re-mirrors. AUTH or PROTOCOL at hello, or the room closed, stop it too.
 *       Every change is written to the mirror's document `link` {pid, state, since, reason?, code?, queued?,
 *       flush?: {at, sent, unsent: [{text, why}]}} and to links/<code>.state.json (lib/room/links.ts LinkState, for
 *       doctor, the room row and the statusline: attempt, lastError, rttMs, queued), both in the one vocabulary
 *       online | connecting | offline | fork | stopped (the state file says connecting while a redial of an offline
 *       link is under way); each dial and each time it is online is a line in the log.
 *       A planned handoff (lib/handoff.ts): the private 'handoff' event is kept for this machine's seat (onAsk);
 *       'moved' re-points the link file at the new host (onMoved) and, with the stream's end {reason: 'moved'},
 *       redials there at once, or stops with the reason when no invite came; this machine named as the new host:
 *       the accepting hook stops it (or it stops itself HANDOFF_SELF_STOP_MS later). The hello and every append
 *       carry the mirror's host epoch (STALE on a mismatch); a make-before-break redial says hello with the epoch
 *       the mirror holds at that moment, so a copy that already took a host_changed is never sent back to the old
 *       host's epoch.
 *       Link = {state() -> string, stop(reason), wake(why?) -> Promise (redial now), done: Promise<reason>}
 *   linkTimings(over?) -> {retryMs, retryMaxMs, pingMs, pongMs, deadMs, wakeTickMs, wakeGapMs, netPollMs, relayMs}
 *   nextDelay(prev, base, cap, random?) -> ms;  wakeWatch({onWake, tickMs, gapMs, clock?, mono?}) -> unwatch;
 *   netWatch({onChange, pollMs, clock?, signature?}) -> unwatch;  netSignature(ifaces?) -> string
 *   socketPath(dir) -> string      one per room and home, from the mirror's directory alone (never TMPDIR: a daemon
 *                                  a listener, sshd or a handoff started and the session's hooks need not share it):
 *                                  <dir>/.link/link.sock, or, when that is longer than a socket path may be (103
 *                                  bytes, macOS), /tmp/sub-human-<uid>/<hash12(dir)>/link.sock. Each directory is
 *                                  0700, a real directory and ours: the daemon refuses any other, a hook skips it.
 *                                  The daemon records the path it bound in its document `link` (socket)
 *   socketPaths(dir, doc?) -> string[]   where a hook looks, in order: doc.socket, socketPath(dir), and 0.4.1's
 *                                  <os.tmpdir()>/sh-<hash8(dir)>/link.sock (a daemon that version started; a new
 *                                  daemon finding one answering there stops with LOCK)
 *   handle(method, params) -> Promise<result>   the bridge handler, params {socket, params}: one op (RELAY) over the
 *                                  first socket (one path or socketPaths' list) that accepts the connection, the
 *                                  result as the wire has it; OFFLINE when no daemon is listening (nothing is started
 *                                  from a hook's call)
 *   status(code) -> {running, pid?, state?, since?, reason?, code?}   the daemon's document `link`; running: its
 *                                  pid lives; code: the RoomError that stopped it (AUTH, PROTOCOL, FORK)
 *   stopReason(doc) -> {code, reason} | null   why a stopped link stopped (a hook whose op met a daemon that hung
 *                                  up or is gone reports this, e.g. AUTH "this invite is unknown or was used already")
 *   start(code) -> bool            start the daemon detached (stdout and stderr to lib/room/links.ts logFile) unless
 *                                  it runs; wait up to LINK_START_MS for it to listen
 *   pipeLocator(home?) -> 'pipe:<home>'   an invite's locator for a room hosted under that home on this machine
 *   sshLocator(dest, {via}?) -> 'ssh:user@host[:port][?via=JUMP]' | null   an invite's locator for a room reached over SSH (null: not
 *                                  a plain user@host[:port])
 *   transportOf(locator) -> Spec | null   the link file's transport for an invite's locator: the transport
 *                                  registry's parse (lib/remote/transports/index.ts), {kind: 'pipe', home} or
 *                                  {kind: 'ssh', user, host, port?, via?} today. connectLink opens it with {code}: pipe runs
 *                                  this plugin's own `sub-human serve --stdio CODE` with that home; ssh runs
 *                                  `ssh … -- user@host sub-human serve --stdio CODE` and the host's authorized_keys
 *                                  forced command decides what runs there (lib/remote/transports/ssh.ts)
 *   sshCommand(spec, code, opts?) -> [cmd, ...args]   that ssh command line (lib/remote/transports/ssh.ts command)
 *   A login link (transport.login, `/sub-human join USER@HOST ROOM`) has no invite: its first hello says {login:
 *                                  true} and the token it gets is kept as any other; ssh failures only the person can fix
 *                                  (lib/remote/transports/ssh.ts loginFailure) are AUTH, so the daemon stops with them
 *   keyRefused(linkFile, transport, err) -> Promise<err'>   connectLink's: a dial of an ssh link with its own key
 *                                  and a token that ssh refused ("Permission denied (publickey)": the host revoked the
 *                                  key) is AUTH, so the daemon stops; anything else is err as it was
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import * as protocol from './protocol.ts';
import { RoomError } from '../room/validate.ts';
import { isAlive, sleepSync } from '../io.ts';
import * as config from '../config.ts';
import * as realClock from '../clock.ts';
import * as storeMod from '../room/store.ts';
import * as linksMod from '../room/links.ts';
import * as homeMod from '../home.ts';
import * as identityMod from '../identity.ts';
import * as membersMod from '../room/members.ts';
import { createRequire } from 'node:module';
import type {
  CodedError, DecodedFrame, ErrorFrame, FrameId, LinkDoc, LinkTimings, MovedEventData, ReplyFrame, RunningLink, SignedPayload,
  StreamEvent, Flush,
} from './types-core.ts';
import type { Clock, TimerHandle } from '../clock.ts';
import type { Entry, Link, LinkStateWord } from '../room/types.ts';
import type { MirrorRoomStore } from '../room/store-mirror.ts';
import type { Client } from './client.ts';
import type { SshSpec } from './types-rest.ts';
import type { Outbox, OutboxItem } from './outbox.ts';

const require = createRequire(import.meta.url);

/** One relayed op's params as a hook sends them: an append may carry {queue: true}. */
type RelayParams = { queue?: boolean; payload?: SignedPayload; [field: string]: unknown };
type Relay = (op: string, params: RelayParams) => Promise<unknown>;
/** The daemon's document `link`, and whether its pid lives. */
type LinkStatus = (LinkDoc & { running: true; pid: number }) | (LinkDoc & { running: false });
/** A transport as connectLink opens it (lib/remote/transports/*): ssh's keeps its stderr. */
type TransportLike = { stderr?(): string } | null | undefined;
/** The link daemon's options (serveMirror). */
interface ServeMirrorOptions {
  mirror: MirrorRoomStore;
  connect: () => Promise<Client>;
  log?: (msg: string) => void;
  retryMs?: number;
  retryMaxMs?: number;
  timings?: Partial<LinkTimings>;
  clock?: Clock;
  random?: () => number;
  mono?: () => number;
  netSignature?: () => string;
  watch?: boolean;
  seats?: () => string[];
  writeState?: (rec: object) => void;
  outbox?: Outbox;
}

const BIN = path.join(import.meta.dirname, '..', '..', 'scripts', 'sub-human');
const RELAY = new Set(['join', 'leave', 'beat', 'append', 'blob.get', 'blob.put', 'handoff.accept', 'handoff.refuse']);
const HANDOFF_SELF_STOP_MS = 10_000;
const SUN_PATH_MAX = 103; // a unix socket's path: 104 bytes on macOS with its NUL (108 on Linux)
const handoff = (): typeof import('../handoff.ts') => require('../handoff.ts');
const outboxMod = (): typeof import('./outbox.ts') => require('./outbox.ts');
/** lib/remote/client.ts and lib/remote/enroll.ts, loaded when used: what this file calls on them. */
const clientMod = (): typeof import('./client.ts') => require('./client.ts');
const enrollMod = (): typeof import('./enroll.ts') => require('./enroll.ts');
const STOPPED: Set<unknown> = new Set(['fork', 'stopped']);
const hash12 = (data: string): string => crypto.createHash('sha256').update(data).digest('hex').slice(0, 12); // lib/room/store.ts's, without loading a store

// ---------- the hook's side ----------
/**
 * @param {string} dir   the mirror's directory
 * @returns {string}
 */
function socketPath(dir: string): string {
  const own = path.join(path.resolve(dir), '.link', 'link.sock');
  if (Buffer.byteLength(own) <= SUN_PATH_MAX) return own;
  const h = crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 12);
  return path.join(shortBase(), h, 'link.sock');
}

/** The fixed per-user directory a socket goes in when the mirror's own path is too long: /tmp/sub-human-<uid>.
 * Never TMPDIR, which a daemon started by a listener, sshd or launchd and the session's hooks need not share. */
const shortBase = (): string => `/tmp/sub-human-${typeof process.getuid === 'function' ? process.getuid() : 'u'}`;

/** 0.4.1's path, <os.tmpdir()>/sh-<hash8>/link.sock: a daemon that version started still answers there. */
function legacySocketPath(dir: string): string {
  const h = crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 8);
  return path.join(os.tmpdir(), `sh-${h}`, 'link.sock');
}

/**
 * Where a hook looks for the daemon, in order: the path the running daemon recorded in its document `link`
 * (`socket`), socketPath(dir), then 0.4.1's TMPDIR-dependent path. No duplicates.
 * @param {string} dir   the mirror's directory
 * @param {{socket?: string} | null} [doc]   the mirror's document `link`
 * @returns {string[]}
 */
function socketPaths(dir: string, doc?: { socket?: unknown } | null): string[] {
  const rec: string[] = doc && typeof doc.socket === 'string' && path.isAbsolute(doc.socket) ? [doc.socket] : [];
  return [...new Set([...rec, socketPath(dir), legacySocketPath(dir)])];
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
    try { fs.mkdirSync(base, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    if (!isPrivateDir(base)) throw new RoomError('AUTH', `${base} is not private to this user (a symlink, someone else's, or open to others)`);
  }
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  if (!isPrivateDir(dir)) throw new RoomError('AUTH', `${dir} is not private to this user`);
}

/**
 * @param {string} method
 * @param {{socket: string | string[], params: object}} params   socket: one path, or socketPaths' list, tried in order
 * @returns {Promise<*>}
 */
async function handle(method: string, { socket, params }: { socket: string | string[]; params: object }): Promise<unknown> {
  if (!RELAY.has(method)) throw new RoomError('PROTOCOL', `${method} is not relayed to the host`);
  let last: CodedError | null = null;
  for (const file of Array.isArray(socket) ? socket : [socket]) {
    // a socket in a directory someone else could have made is never handed a seat's op
    if (!isPrivateDir(path.dirname(file))) continue;
    try { return await relayOnce(file, method, params); } catch (e) {
      if (!(e as CodedError).notListening) throw e;
      last = e as CodedError;
    }
  }
  throw last || new RoomError('OFFLINE', 'the link daemon is not running (ENOENT)');
}

/** One op over one socket; an error before the connection is made is marked notListening (try the next path). */
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
      if (f.error) reject(new RoomError(f.error.code, f.error.message));
      else resolve(f.result);
    });
    conn.on('error', (e: NodeJS.ErrnoException) => reject(Object.assign(new RoomError('OFFLINE', `the link daemon is not running (${e.code || e.message})`), connected ? {} : { notListening: true })));
    conn.on('close', () => reject(new RoomError('OFFLINE', 'the link daemon hung up')));
  });
}

/**
 * @param {string} code
 * @returns {{running: boolean, pid?: number, state?: string, since?: string, reason?: string}}
 */
function status(code: string): LinkStatus {
  const st: LinkDoc = storeMod.open(code).kv.get('link') || {};
  return { ...st, running: isAlive(st.pid) } as LinkStatus; // running: its pid (a number) lives
}

/**
 * Why the link stopped for good (FORK, AUTH, PROTOCOL, the room closed, no seat left), from its document `link`
 * ({state, reason, code?}): the hook that met a socket that hung up or is gone reports this instead.
 * @param {{state?: string, reason?: string, code?: string} | null} st
 * @returns {{code: string, reason: string} | null}
 */
function stopReason(st: LinkDoc | null | undefined): { code: string; reason: string } | null {
  if (!st || !STOPPED.has(st.state) || !st.reason) return null;
  return { code: st.code || (st.state === 'fork' ? 'FORK' : 'OFFLINE'), reason: st.reason };
}

/**
 * @param {string} code
 * @returns {boolean}
 */
function start(code: string): boolean {
  if (status(code).running) return true;
  const fd = fs.openSync(linksMod.logFile(code), 'a', 0o600);
  try { spawn(process.execPath, [BIN, 'link', code], { detached: true, stdio: ['ignore', fd, fd] }).unref(); } finally { fs.closeSync(fd); }
  for (const until = Date.now() + config.LINK_START_MS; Date.now() < until; sleepSync(20)) if (status(code).running) return true;
  return false;
}

/**
 * @param {string} [h]   the host's home
 * @returns {string}
 */
const pipeLocator = (h: string = homeMod.home()): string => `pipe:${h}`;

const transports = (): typeof import('./transports/index.ts') => require('./transports/index.ts');
const ssh = (): typeof import('./transports/ssh.ts') => require('./transports/ssh.ts');
const sshLocator = (dest: string, opts?: { via?: string }): string | null => ssh().locator(dest, opts);

/**
 * @param {string} locator
 * @returns {{kind: string} | null}
 */
const transportOf = (locator: string): ReturnType<typeof import('./transports/index.ts')['parse']> => transports().parse(locator);

/**
 * @param {{user: string, host: string, port?: number}} t
 * @param {string} code
 * @param {string[]} [opts]
 * @returns {string[]}
 */
const sshCommand = (t: SshSpec, code: string, opts?: string[]): string[] => ssh().command(t, code, opts);

// ---------- the daemon ----------
const listening = (srv: net.Server, file: string): Promise<void> => new Promise((resolve, reject) => {
  srv.once('error', reject);
  srv.listen(file, () => { srv.off('error', reject); resolve(); });
});
const answers = (file: string): Promise<boolean> => new Promise(resolve => {
  const c = net.createConnection(file);
  c.on('connect', () => { c.destroy(); resolve(true); });
  c.on('error', () => resolve(false));
});

/** A server on the socket file, in a directory only this user can enter; a stale socket file is replaced. */
async function listen(file: string, onConn: (sock: net.Socket) => void): Promise<net.Server> {
  ensurePrivateDir(path.dirname(file));
  const srv = net.createServer(onConn);
  try { await listening(srv, file); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    if (await answers(file)) throw new RoomError('LOCK', `a link daemon already listens on ${file}`);
    fs.rmSync(file, { force: true });
    await listening(srv, file);
  }
  fs.chmodSync(file, 0o600); // its directory already shuts others out; the file says so too (the umask gave it 0755)
  return srv;
}

/** One hook's request: the op relayed, or the error, as one frame. */
async function answer(f: DecodedFrame | ErrorFrame, relay: Relay): Promise<ReplyFrame> {
  const g = f as { id?: FrameId; op?: unknown }; // the frame as it came, for the error
  try {
    if (!protocol.isRequest(f) || !RELAY.has(f.op)) throw new RoomError('PROTOCOL', `not an op a hook may relay: ${g.op}`);
    return protocol.reply(f.id, await relay(f.op, f.params));
  } catch (err) {
    const e = err as CodedError;
    return protocol.error(g.id ?? null, (protocol.CODES as Record<string, string | undefined>)[e.code!] ? e.code! : 'INVALID', e.message);
  }
}

function serveHook(sock: net.Socket, relay: Relay): void {
  const dec = protocol.decoder();
  sock.on('error', () => { /* the hook gave up at its deadline */ });
  sock.on('data', (chunk: Buffer) => {
    for (const f of dec.push(chunk)) answer(f, relay).then(out => sock.end(protocol.encode(out)));
  });
}

// ---------- reconnect: backoff, wake, network change ----------
/** Every timing the daemon uses, from lib/config.ts and its SUB_HUMAN_LINK_*_MS overrides, then `over`. */
const linkTimings = (over: Partial<LinkTimings> = {}): LinkTimings => ({
  retryMs: config.envMs('SUB_HUMAN_LINK_RETRY_MS', config.LINK_RETRY_MS),
  retryMaxMs: config.envMs('SUB_HUMAN_LINK_RETRY_MAX_MS', config.LINK_RETRY_MAX_MS),
  pingMs: config.envMs('SUB_HUMAN_LINK_PING_MS', config.LINK_PING_MS),
  pongMs: config.envMs('SUB_HUMAN_LINK_PONG_MS', config.LINK_PONG_MS),
  deadMs: config.envMs('SUB_HUMAN_LINK_DEAD_MS', config.LINK_DEAD_MS),
  wakeTickMs: config.envMs('SUB_HUMAN_LINK_WAKE_TICK_MS', config.LINK_WAKE_TICK_MS),
  wakeGapMs: config.envMs('SUB_HUMAN_LINK_WAKE_GAP_MS', config.LINK_WAKE_GAP_MS),
  netPollMs: config.envMs('SUB_HUMAN_LINK_NET_POLL_MS', config.LINK_NET_POLL_MS),
  relayMs: config.envMs('SUB_HUMAN_LINK_RELAY_MS', config.LINK_RELAY_MS),
  ...Object.fromEntries(Object.entries(over).filter(([, v]) => v !== undefined)),
});

/**
 * The next retry delay, decorrelated jitter: random in [base, 3 x prev], at most cap.
 * @param {number} prev   the last delay (base before the first)
 * @param {number} base
 * @param {number} cap
 * @param {() => number} [random]
 * @returns {number}
 */
const nextDelay = (prev: number, base: number, cap: number, random: () => number = Math.random): number => Math.round(Math.min(cap, base + random() * (Math.max(base, prev * 3) - base)));

/**
 * Call onWake(gapMs) when a timer ticking every tickMs finds the wall clock moved more than gapMs past the tick, or
 * away from the monotonic clock (which does not count a sleep): the machine slept, or its clock jumped.
 * @returns {() => void} unwatch
 */
function wakeWatch({ onWake, tickMs, gapMs, clock = realClock, mono = () => performance.now() }: {
  onWake: (gapMs: number) => void; tickMs: number; gapMs: number; clock?: Clock; mono?: () => number;
}): () => void {
  let wall = clock.now(), m = mono();
  const t = clock.setInterval(() => {
    const w = clock.now(), mm = mono();
    const late = w - wall - tickMs, drift = Math.abs((w - wall) - (mm - m));
    wall = w;
    m = mm;
    if (late > gapMs || drift > gapMs) onWake(Math.round(Math.max(late, drift)));
  }, tickMs);
  if (t && t.unref) t.unref();
  return () => clock.clearInterval(t);
}

/** This machine's external addresses (not loopback, not IPv6 link-local), as one comparable string. */
function netSignature(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string {
  const out: string[] = [];
  for (const [name, list] of Object.entries(ifaces || {})) {
    for (const a of list || []) if (a && !a.internal && !/^fe80:/i.test(a.address)) out.push(`${name}/${a.address}`);
  }
  return out.sort().join(',');
}

/**
 * Call onChange() when signature() differs from the last poll's (an address came, went or moved).
 * @returns {() => void} unwatch
 */
function netWatch({ onChange, pollMs, clock = realClock, signature = netSignature }: {
  onChange: () => void; pollMs: number; clock?: Clock; signature?: () => string;
}): () => void {
  let last: string;
  try { last = signature(); } catch { last = ''; }
  const t = clock.setInterval(() => {
    let now: string;
    try { now = signature(); } catch { return; }
    if (now !== last) { last = now; onChange(); }
  }, pollMs);
  if (t && t.unref) t.unref();
  return () => clock.clearInterval(t);
}

/** A host line the mirror holds already (the same id and bytes): two streams overlap while a link is swapped. */
function held(mirror: MirrorRoomStore, line: string): boolean {
  let id: unknown;
  try { id = JSON.parse(line).id; } catch { return false; }
  return Number.isInteger(id) && (id as number) <= mirror.lastId() && mirror.lineHash(id as number) === hash12(line);
}
const PLACED_ALREADY = /placed already/; // lib/room/store.ts: its nonce is in the log, so an earlier try landed
const clip = (s: string, n = 200): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const FATAL: Set<unknown> = new Set(['FORK', 'AUTH', 'PROTOCOL']);

/**
 * @param {{mirror: object, connect: () => Promise<object>, log?: (msg: string) => void, retryMs?: number, retryMaxMs?: number,
 *   timings?: object, clock?: object, random?: () => number, mono?: () => number, netSignature?: () => string,
 *   watch?: boolean, seats?: () => string[], writeState?: (rec: object) => void, outbox?: object}} opts
 * @returns {Promise<{state(): string, stop(reason: string): void, wake(why?: string): Promise<void>, done: Promise<string>}>}
 */
async function serveMirror({
  mirror, connect, log = () => {}, retryMs, retryMaxMs, timings, clock = realClock, random = Math.random,
  mono, netSignature: netSig, watch = true, seats, writeState, outbox,
}: ServeMirrorOptions): Promise<RunningLink> {
  const T = linkTimings({ ...timings, retryMs, retryMaxMs });
  const sockFile = socketPath(mirror.dir);
  const box = outbox || outboxMod().open(mirror.dir);
  const localSeats = seats || (() => identityMod.localSeats(mirror.code));
  const saveState = writeState || (rec => linksMod.writeState(mirror.code, rec));
  let state: LinkStateWord = 'connecting', reason: string | null = null, client: Client | null = null;
  let retry: TimerHandle | null = null, hb: TimerHandle | null = null, delay = T.retryMs, finish: (why: string) => void;
  let dialing: Promise<void> | null = null, attempts = 0, lastError: string | null = null, prevError: string | null = null;
  let rttMs: number | null = null, doc: LinkDoc = {}, pub: string | null = null, pubSince: string | null = null, flushed: Flush | null = null;
  const unwatch: (() => void)[] = [];
  const done = new Promise<string>(resolve => { finish = resolve; });

  /** The two records observers read: the mirror's document `link` (lib/tail.ts) and links/<code>.state.json. */
  function publish() {
    const d = { ...doc, ...(box.size() ? { queued: box.size() } : {}), ...(flushed ? { flush: flushed } : {}) };
    try { mirror.kv.set('link', d); } catch (e) { log(`status: ${(e as Error).message}`); }
    const p = state === 'offline' && dialing ? 'connecting' : state; // a redial under way reads connecting
    if (p !== pub) { pub = p; pubSince = new Date(clock.now()).toISOString(); }
    const rec = { state: p, since: pubSince, attempt: attempts, lastError, ...(prevError ? { prevError } : {}), rttMs, queued: box.size(), pid: process.pid, detail: state, at: new Date(clock.now()).toISOString() };
    try { saveState(rec); } catch (e) { log(`state: ${(e as Error).message}`); }
  }

  function setState(s: LinkStateWord, why: string | null = null, code: string | null = null) {
    state = s;
    reason = why;
    doc = { pid: process.pid, state, since: new Date(clock.now()).toISOString(), socket: sockFile, ...(why ? { reason: why } : {}), ...(code ? { code } : {}) };
    publish();
  }

  async function relay(op: string, params: RelayParams): Promise<unknown> {
    if (state === 'connecting') await first;
    let p = params, queue: boolean | undefined = false;
    if (op === 'append' && p && p.queue) ({ queue, ...p } = p);
    const queueable = queue && outboxMod().queueable(p.payload);
    if (state !== 'online') {
      if (queueable && !STOPPED.has(state)) {
        const n = box.add(p.payload!, clock.now()); // queueable: a payload
        log(`offline: an @room post is queued (${n} waiting)`);
        publish();
        return { queued: n };
      }
      throw new RoomError(state === 'fork' ? 'FORK' : 'OFFLINE', `the link is ${state}${reason ? `: ${reason}` : ''}`);
    }
    const epoch = op === 'append' && typeof mirror.hostState === 'function' ? mirror.hostState().epoch : undefined;
    const sent = epoch === undefined ? p : { ...p, epoch };
    return queueable ? sendPost(client!, sent) : answerBy(client!.request(op, sent), op); // client: online
  }

  /** The hook gives up at LINK_CALL_MS, so the daemon answers first (relayMs): an op the host has not answered by
   * then went out and may still land (a slow link), so it is OFFLINE with an unknown outcome, never "not sent". */
  function answerBy(req: Promise<unknown>, op: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const t = clock.setTimeout(() => reject(new RoomError('OFFLINE',
        `${op}: no answer from the host within ${T.relayMs} ms (a slow link); ${protocol.UNKNOWN_OUTCOME}`)), T.relayMs);
      req.then(r => { clock.clearTimeout(t); resolve(r); }, e => { clock.clearTimeout(t); reject(e); });
    });
  }

  /**
   * A person's signed @room post, online. Answered by relayMs, it is the host's answer. Not answered by then, it
   * is in flight: it goes into the outbox under its nonce and the hook hears {queued, slow: true} ("⧗ sending"),
   * never "not sent". The host's late answer settles it: placed (or "placed already") leaves the outbox, and the
   * late copy IS the post; a refusal is dropped and reported (document `link` flush). A connection that closes
   * first leaves it queued: the next connection sends it again, and the host's nonce check makes that a no-op
   * when the first copy landed.
   */
  function sendPost(c: Client, sent: RelayParams): Promise<unknown> {
    const payload = sent.payload!; // queueable: a signed post
    const req = c.request('append', sent, { ms: box.ageMs || config.LINK_OUTBOX_AGE_MS });
    return new Promise((resolve, reject) => {
      let slow = false;
      const t = clock.setTimeout(() => {
        slow = true;
        const n = box.add(payload, clock.now(), { force: true });
        log(`slow link: an @room post has no answer within ${T.relayMs} ms; it stays in the outbox under its nonce until the host answers`);
        publish();
        resolve({ queued: n, slow: true });
      }, T.relayMs);
      req.then(r => {
        if (!slow) { clock.clearTimeout(t); resolve(r); return; }
        if (box.remove(payload.nonce)) { log('slow link: the @room post that was in flight landed'); publish(); }
      }, (e: CodedError) => {
        if (!slow) { clock.clearTimeout(t); reject(e); return; }
        if (PLACED_ALREADY.test(e.message)) { if (box.remove(payload.nonce)) publish(); return; }
        if (e.code === 'OFFLINE' && (c.closed || c !== client)) return; // kept: the next connection sends it again
        if (!box.remove(payload.nonce)) return;
        const why = e.code === 'OFFLINE' ? 'the host never answered' : e.message;
        flushed = { at: new Date(clock.now()).toISOString(), sent: 0, unsent: [{ text: clip(String(payload.text || '')), why }] };
        log(`a slow @room post was not placed: ${why}`);
        publish();
      });
    });
  }

  function stop(st: LinkStateWord, why: string, code: string | null = null) {
    if (STOPPED.has(state)) return;
    clock.clearTimeout(retry);
    clock.clearTimeout(hb);
    for (const u of unwatch.splice(0)) u();
    const c = client;
    client = null;
    lastError = why;
    setState(st, why, code);
    if (st === 'fork') {
      const kept = box.size() ? `; ${box.size()} queued @room post(s) are kept, not sent` : '';
      log(`FORK in room ${mirror.code}: ${why}. Nothing more is synced${kept}; sub-human link --reset ${mirror.code} re-mirrors`);
    }
    srv.close();
    fs.rmSync(path.dirname(sockFile), { recursive: true, force: true });
    if (c) c.close();
    finish(why);
  }

  function fail(e: CodedError) {
    if (e.code === 'FORK') return stop('fork', e.message, 'FORK');
    if (e.code === 'AUTH' || e.code === 'PROTOCOL') return stop('stopped', e.message, e.code);
    const c = client;
    client = null;
    clock.clearTimeout(hb);
    if (c) c.close();
    lastError = e.message;
    log(`offline: ${e.message}`);
    setState('offline', handoff().whyOffline(mirror.code, e.message));
    if (dialing || retry) return; // that dial's outcome, or the retry already set, decides
    delay = nextDelay(delay, T.retryMs, T.retryMaxMs, random);
    retry = clock.setTimeout(() => { retry = null; dial('retry'); }, delay);
  }

  /** No pong within deadMs: c is dead (a half-open link). A dial already under way decides what comes next. */
  function dead(c: Client, why: string) {
    if (c !== client) return;
    if (!dialing) return fail(new RoomError('OFFLINE', why));
    client = null;
    clock.clearTimeout(hb);
    c.close();
    lastError = why;
    log(`offline: ${why}`);
    setState('offline', why);
  }

  /** Ping c every pingMs while it is the connection: a late pong redials (make before break), a missing one is dead. */
  function heartbeat(c: Client) {
    clock.clearTimeout(hb);
    if (!(T.pingMs > 0) || typeof c.supports !== 'function' || !c.supports('ping')) return;
    const tick = () => {
      if (c !== client) return;
      const late = clock.setTimeout(() => { if (c === client) redial(`no pong within ${T.pongMs} ms`); }, T.pongMs);
      c.ping(T.deadMs).then(r => {
        clock.clearTimeout(late);
        if (c !== client) return;
        rttMs = r.rttMs;
        publish();
        hb = clock.setTimeout(tick, T.pingMs);
      }, () => {
        clock.clearTimeout(late);
        dead(c, `no pong within ${T.deadMs} ms`);
      });
    };
    hb = clock.setTimeout(tick, T.pingMs);
  }

  function prefetch(c: Client, e: Entry) {
    if (e.kind !== 'proposal' || !e.hash) return;
    const ref = mirror.blobs.ref(e.path) || `plans/${e.hash}.md`;
    if (mirror.blobs.has(ref)) return;
    c.blobGet(ref).then(b => b && mirror.applyBlob(ref, b), (err: Error) => log(`plan ${ref}: ${err.message}`));
  }

  // A document this version does not stream (a newer host's) is skipped, not fatal: the mirror never takes it.
  function applyDoc(data: StreamEvent<'doc'>['data']) {
    if (!data || typeof data.key !== 'string') return log('skipped: a document with no key');
    try { mirror.applyDoc(data.key, data.value); } catch (e) {
      if ((e as CodedError).code !== 'PROTOCOL') throw e;
      log(`skipped: ${(e as Error).message}`);
    }
  }

  function onEvent(c: Client, { ev, data }: StreamEvent) {
    if (STOPPED.has(state)) return;
    try {
      if (ev === 'entry') { if (!held(mirror, data)) prefetch(c, mirror.applyLine(data)); }
      else if (ev === 'doc') applyDoc(data);
      else if (ev === 'handoff') handoff().onAsk(mirror, data);
      else if (ev === 'moved') moved(data);
      else if (ev === 'end' && c === client) {
        if (data.reason === 'closed') stop('stopped', 'the room was closed');
        else if (data.reason === 'moved') {
          if (movedHere) return; // this machine is the new host: the accepting hook's reply is still to come on c
          client = null;
          clock.clearTimeout(hb);
          c.close();
          setState('offline', 'the room moved; reconnecting to its new host');
          redial('the room moved');
        }
        else fail(new RoomError(data.reason, data.message ? String(data.message).slice(0, 200) : data.reason === 'FORK' ? 'the host log was reset' : 'the connection to the host closed'));
      }
    } catch (err) {
      const e = err as CodedError;
      stop(e.code === 'FORK' ? 'fork' : 'stopped', e.message, e.code === 'FORK' ? 'FORK' : null);
    }
  }

  let movedHere = false;
  function moved(data: MovedEventData) {
    const r = handoff().onMoved(mirror, data);
    log(`moved: ${r.reason}`);
    if (r.self) {
      movedHere = true; // the accepting hook takes the room over, then stops this daemon; its reply is still to come
      setTimeout(() => stop('stopped', r.reason), HANDOFF_SELF_STOP_MS).unref();
    } else if (r.stop) stop('stopped', r.reason);
  }

  /** This machine's live seats renew their lease on the host, so one that lapsed while the link was down is back,
   * quietly: a beat writes no log line (no "left", no "joined"); its pinned key and its link binding never changed. */
  async function keepSeats(c: Client) {
    let names: string[] = [];
    try { names = localSeats(); } catch (e) { log(`seats: ${(e as Error).message}`); }
    const { leaseFresh } = membersMod;
    for (const name of names) {
      const m = mirror.members.read()[name];
      try {
        const r = await c.beat(name);
        if (!r || !r.ok) log(`seat ${name} is not in room ${mirror.code} on the host any more; /sub-human ${name} ${mirror.code} joins again`);
        else if (m && !leaseFresh(m)) log(`seat ${name}: its lease had lapsed on the host; renewed`);
      } catch (e) {
        if ((e as CodedError).code === 'OFFLINE') throw e;
        log(`seat ${name}: ${(e as Error).message}`);
      }
    }
  }

  /** Send the queued @room posts on c, oldest first (c subscribed: the mirror is the host's prefix). A post the host
   * already holds (an earlier try landed) is answered "placed already" by its nonce: done. OFFLINE keeps the rest. */
  async function flush(c: Client) {
    let sent = 0;
    const unsent: Flush['unsent'] = [];
    const note = () => { if (sent || unsent.length) flushed = { at: new Date(clock.now()).toISOString(), sent, unsent }; };
    const drop = (x: OutboxItem, why: string) => { unsent.push({ text: clip(String(x.payload.text || '')), why }); log(`a queued @room post was not sent: ${why}`); };
    for (;;) {
      for (const x of box.expire(clock.now())) drop(x, 'it waited too long (the host refuses a signature that old)');
      const x = box.first();
      if (!x) break;
      try {
        await c.append(x.payload);
        sent++;
      } catch (err) {
        const e = err as CodedError;
        if (e.code === 'OFFLINE' || e.code === 'LOCK') { note(); throw e; }
        if (PLACED_ALREADY.test(e.message)) sent++;
        else drop(x, e.message);
      }
      box.remove(x.payload.nonce); // by nonce: a slow post's late answer may have taken it out meanwhile
    }
    note();
    if (sent || unsent.length) log(`outbox: ${sent} queued @room post(s) sent${unsent.length ? `, ${unsent.length} not sent` : ''}`);
  }

  /**
   * Make a new connection (subscribe from the mirror's last line, renew the seats, send the outbox), and only once
   * it is live swap it in and close the old one; a hook's op meanwhile still goes over the old one. One at a time.
   */
  function dial(why: string | null = null): Promise<void> {
    if (STOPPED.has(state)) return Promise.resolve();
    if (dialing) return dialing;
    clock.clearTimeout(retry);
    retry = null;
    attempts++;
    dialing = (async () => {
      let c: Client | null = null;
      try {
        log(client ? `redialing (${why}); the current connection stays until the new one is live` : `connecting${why ? ` (${why})` : ''}`);
        c = await connect();
        const after = mirror.lastId();
        const conn = c;
        if (!STOPPED.has(state)) await c.subscribe(after, mirror.lineHash(after), ev => onEvent(conn, ev)).ready;
        if (!STOPPED.has(state)) await keepSeats(c);
        if (!STOPPED.has(state)) await flush(c);
        if (STOPPED.has(state)) { c.close(); return; }
        const old = client;
        client = c;
        attempts = 0;
        delay = T.retryMs;
        dialing = null;
        if (lastError) { prevError = lastError; lastError = null; } // online: why it last went offline is history
        setState('online');
        log(`online: subscribed after line ${after}${old ? '; swapped in, the old connection is closed' : ''}`);
        heartbeat(c);
        if (old) retire(old);
      } catch (err) {
        const e = err as CodedError;
        if (c && c !== client) c.close();
        dialing = null;
        if (STOPPED.has(state)) return;
        if (client && !FATAL.has(e.code)) { log(`redial failed (${e.message}); the current connection stays`); publish(); return; }
        fail(e);
      }
    })();
    publish();
    return dialing;
  }

  /** Close a replaced connection once the ops in flight on it are answered (a hook's write must not fail for a swap). */
  function retire(old: Client) {
    const d = typeof old.drain === 'function' ? old.drain() : Promise.resolve();
    d.then(() => old.close(), () => old.close());
  }

    /** A wake, a network change, a late pong or a signal: redial now, with the backoff reset. */
  function redial(why: string): Promise<void> {
    if (STOPPED.has(state)) return Promise.resolve();
    delay = T.retryMs;
    if (!dialing) log(`${why}: redialing now`);
    return dial(why);
  }

  const legacy = legacySocketPath(mirror.dir); // a 0.4.1 daemon still running for this room keeps it
  if (legacy !== sockFile && await answers(legacy)) throw new RoomError('LOCK', `a link daemon already listens on ${legacy}`);
  const srv = await listen(sockFile, sock => serveHook(sock, relay));
  setState('connecting');
  const first = dial();
  if (watch) {
    unwatch.push(wakeWatch({ onWake: gap => redial(`woke from sleep (the clock jumped ${gap} ms)`), tickMs: T.wakeTickMs, gapMs: T.wakeGapMs, clock, ...(mono ? { mono } : {}) }));
    if (T.netPollMs > 0) unwatch.push(netWatch({ onChange: () => redial('the network changed'), pollMs: T.netPollMs, clock, ...(netSig ? { signature: netSig } : {}) }));
  }
  return { state: () => state, stop: why => stop('stopped', why), wake: (why = 'asked') => redial(why), done };
}

/** A link the host refused before it held a token: drop the invite, its PIN and the pending rebind; say why. */
function scrubRefused(links: typeof linksMod, code: string, reason: unknown): void {
  try {
    const cur: Link | null = links.get(code);
    if (!cur || cur.token) return;
    const { invite, pin, rebind, enroll, awaiting, ...rest } = cur;
    links.set(code, { ...rest, refused: { at: new Date().toISOString(), reason: String(reason).slice(0, 300) } });
  } catch { /* the stop reason still says it */ }
}

/** The link file's connection: hello with the token, or with the invite once (its token then replaces it). */
async function connectLink(code: string): Promise<Client> {
  const links = linksMod;
  let l: Link | null = links.get(code);
  if (!l) throw new RoomError('AUTH', `this machine has no link to room ${code} any more`);
  if (!l.token && typeof l.invite !== 'string' && l.enroll) { // a short code: the PAKE first (lib/remote/enroll.ts)
    await enrollMod().enrollLink(code);
    l = links.get(code) as Link; // enrollLink keeps the link file (it threw otherwise)
  }
  const login = !!l.transport && 'login' in l.transport && l.transport.login === true; // a link over the person's own ssh login: no invite
  if (!l.token && typeof l.invite !== 'string' && !login) {
    throw new RoomError('AUTH', `the host refused this link's invite${l.refused && l.refused.reason ? ` (${l.refused.reason})` : ''}; ask the host for a new one`);
  }
  const kind = l.transport && l.transport.kind;
  if (!transports().get(kind)) throw new RoomError('PROTOCOL', `unknown transport "${kind}" (${transports().kinds().join(', ')})`);
  const cred = l.token ? { token: l.token } : login ? { login: true } : { invite: l.invite, ...(typeof l.pin === 'string' ? { pin: l.pin } : {}) };
  const epoch = storeMod.open(code).hostState().epoch;
  const opts = { machine: homeMod.machineId(), helloMs: config.LINK_HELLO_MS, caps: { ping: true }, epoch, ...cred };
  const t = transports().open(l.transport, { code });
  let c: Client;
  try { c = await clientMod().connect(t, opts); } catch (err) {
    const e = err as CodedError;
    // the host refused the invite (a wrong PIN, burnt, used, expired): it and its PIN are spent here too, so the link
    // file keeps no secret in clear (a new join writes a fresh one)
    if (!l.token && !login && e && e.code === 'AUTH') scrubRefused(links, code, e.message);
    throw login ? await loginRefused(l, t, e, code) : await keyRefused(l, t, e);
  }
  if (!l.token) {
    const { invite, pin, awaiting, ...rest } = l; // an sh2 invite's PIN is spent with it
    links.set(code, { ...rest, token: c.token!, ...(rest.moved ? { moved: { ...rest.moved, reached_at: new Date().toISOString() } } : {}) }); // c.token: hello gives one for an invite or a login
  }
  return c;
}

/**
 * An ssh link with its own key (an sh2 join) that held a token, so its key got in before: ssh refusing that key
 * now means the host took it out of authorized_keys (`/sub-human kick`, or by hand). That is AUTH, which stops
 * the daemon with the reason, not OFFLINE, which would redial a door that stays shut. Before the token (waiting
 * for the host's admit) a refusal is expected and stays OFFLINE.
 */
async function keyRefused(l: Link, t: TransportLike | Promise<TransportLike>, e: CodedError | null | undefined): Promise<CodedError | null | undefined> {
  if (!e || e.code !== 'OFFLINE' || !l.token || !l.transport || l.transport.kind !== 'ssh' || !l.transport.key) return e;
  const tr = await Promise.resolve(t).catch(() => null);
  if (!tr || typeof tr.stderr !== 'function') return e;
  await new Promise(r => setTimeout(r, 100)); // ssh's last words may come just after its exit
  return /Permission denied \(publickey/.test(tr.stderr())
    ? new RoomError('AUTH', 'the host no longer accepts this link\'s ssh key (it was revoked); ask the host for a new invite')
    : e;
}

/**
 * A login link's ssh gave up for a reason only the person can fix (lib/remote/transports/ssh.ts loginFailure: an
 * unknown host key, a refused login, no shim or no room on the host): AUTH with that reason, so the daemon stops and
 * the join says what to run, instead of redialing a door that stays shut. Anything else is err as it was.
 */
async function loginRefused(l: Link, t: TransportLike | Promise<TransportLike>, e: CodedError | null | undefined, code: string): Promise<CodedError | null | undefined> {
  if (!e || e.code !== 'OFFLINE') return e;
  const tr = await Promise.resolve(t).catch(() => null);
  if (!tr || typeof tr.stderr !== 'function') return e;
  await new Promise(r => setTimeout(r, 100)); // ssh's last words may come just after its exit
  const why = l.transport.kind === 'ssh' ? ssh().loginFailure(tr.stderr(), l.transport, code) : null; // a login link is ssh
  return why ? new RoomError('AUTH', why) : e;
}

function idleWatch(link: RunningLink, mirror: MirrorRoomStore, idleMs: number): () => void {
  const { machineId } = homeMod;
  const { leaseFresh } = membersMod;
  const identity = identityMod;
  const leased = () => Object.values(mirror.members.read()).some(m => m && m.machine === machineId() && !m.left_at && leaseFresh(m));
  // an invite not redeemed yet (an ssh join waits for the host to admit its key): kept trying for the invite's life
  const redeeming = () => {
    const l: Link | null = linksMod.get(mirror.code);
    return !!l && !l.token && (typeof l.invite === 'string' || !!l.enroll) && Date.now() - Date.parse(l.created_at ?? '') < config.INVITE_TTL_MS;
  };
  const seated = () => {
    const s = link.state();
    return s === 'connecting' || redeeming() || (s === 'online' ? leased() : identity.localSeats(mirror.code).length > 0);
  };
  let since = Date.now();
  const t = setInterval(() => {
    if (seated()) since = Date.now();
    else if (Date.now() - since >= idleMs) link.stop('no seat of this machine is left in the room');
  }, Math.min(1000, idleMs));
  return () => clearInterval(t);
}

/**
 * @param {{code: string, log?: (msg: string) => void}} opts
 * @returns {Promise<string>}
 */
async function run({ code, log = msg => process.stderr.write(`${new Date().toISOString()} sub-human link ${code}: ${msg}\n`) }: {
  code: string; log?: (msg: string) => unknown;
}): Promise<string> {
  const store = storeMod;
  const opened = store.open(code);
  if (opened.isHost) throw new RoomError('INVALID', `this machine has no link to room ${code}`);
  const mirror = opened as MirrorRoomStore; // not the host: open() gave the room's mirror
  store.createRoom(code);
  const link = await serveMirror({ mirror, connect: () => connectLink(code), log });
  const unwatch = idleWatch(link, mirror, config.envMs('SUB_HUMAN_LINK_IDLE_MS', config.LINK_IDLE_MS));
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(sig, () => link.stop(`stopped by ${sig}`));
  process.on('SIGUSR2', () => link.wake('SIGUSR2'));
  const why = await link.done;
  unwatch();
  log(`stopped: ${why}`);
  return why;
}

export {
  run, serveMirror, idleWatch, socketPath, socketPaths, handle, status, stopReason, start, pipeLocator, sshLocator,
  transportOf, sshCommand, linkTimings, nextDelay, wakeWatch, netWatch, netSignature, keyRefused,
};
export type { LinkStatus };
