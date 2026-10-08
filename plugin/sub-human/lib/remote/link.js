'use strict';
/**
 * plugin/sub-human/lib/remote/link.js: the link daemon, one per machine and room (`bin/sub-human link CODE`,
 * started detached by the join hook, like the orch starter). It holds the one connection to the host
 * (lib/remote/client.js over the transport in the link file, lib/room/links.js), keeps the mirror
 * (lib/room/store-mirror.js applyLine / applyDoc / applyBlob) byte-identical to the host's log, prefetches every
 * proposal's plan, and serves the hooks of this machine on a unix socket: a hook's bridge worker
 * (lib/remote/bridge.js, handler = this file's handle) relays one op and gets one reply. It never loads the
 * signer. Loading this file loads no store (handle runs on every writing hook's bridge worker; the daemon's
 * modules are required inside run).
 *
 *   run({code, log?}) -> Promise<reason>
 *       serveMirror over the link file's transport (connectLink: hello with the token, or the invite once, whose
 *       token then replaces it in the link file), until it stops; also stops LINK_IDLE_MS
 *       (SUB_HUMAN_LINK_IDLE_MS) after this machine has no seat left in the room (idleWatch), and on SIGTERM,
 *       SIGINT or SIGHUP.
 *   idleWatch(link, mirror, idleMs) -> unwatch   stop the link once idleMs have passed with no seat of this
 *       machine in the room. Online, a seat is one the mirror's members document holds with a fresh lease;
 *       offline, the host's document is stale, so a seat is one a live claude process of this machine holds
 *       (identity.localSeats): a crashed or abandoned join never leaves a daemon retrying for ever. While the
 *       first connection is made it never stops.
 *   serveMirror({mirror, connect, log?, retryMs?, retryMaxMs?}) -> Promise<Link>   listen on socketPath(mirror.dir) (one daemon
 *       per socket: LOCK when another one answers there), then connect() -> Promise<Client> (hello done) and
 *       subscribe {after: the mirror's last id, hash: that line's hash12}. The stream goes into the mirror; a
 *       proposal's plan is fetched once. A lost connection is OFFLINE: tried again after retryMs, doubled per
 *       failure up to retryMaxMs (LINK_RETRY_MAX_MS, 10 s); a hook's op meanwhile is refused OFFLINE (never queued; before the first
 *       connection it waits for it). FORK (the host's line `after` is not the mirror's, a line that does not
 *       chain, or the host log reset) stops it and logs loudly: `sub-human link --reset CODE` re-mirrors. AUTH or
 *       PROTOCOL at hello, or the room closed, stop it too. Every change of state is written to the mirror's
 *       document `link` {pid, state, since, reason?}: connecting | online | offline | fork | stopped, and each
 *       attempt and each time it is online is a line in the log.
 *       Link = {state() -> string, stop(reason), done: Promise<reason>}
 *   socketPath(dir) -> string      <os.tmpdir()>/sh-<hash8(mirror dir)>/link.sock: one per room and home, short
 *                                  whatever the home (a macOS socket path is at most 104 bytes). Its directory is
 *                                  0700, and the daemon refuses one it does not own
 *   handle(method, params) -> Promise<result>   the bridge handler, params {socket, params}: one op (RELAY) over the
 *                                  socket, the result as the wire has it; OFFLINE when the daemon is not listening
 *                                  (nothing is started from a hook's call)
 *   status(code) -> {running, pid?, state?, since?, reason?, code?}   the daemon's document `link`; running: its
 *                                  pid lives; code: the RoomError that stopped it (AUTH, PROTOCOL, FORK)
 *   stopReason(doc) -> {code, reason} | null   why a stopped link stopped (a hook whose op met a daemon that hung
 *                                  up or is gone reports this, e.g. AUTH "this invite is unknown or was used already")
 *   start(code) -> bool            start the daemon detached (stdout and stderr to lib/room/links.js logFile) unless
 *                                  it runs; wait up to LINK_START_MS for it to listen
 *   pipeLocator(home?) -> 'pipe:<home>'   an invite's locator for a room hosted under that home on this machine
 *   sshLocator(dest) -> 'ssh:user@host[:port]' | null   an invite's locator for a room reached over SSH (null: not
 *                                  a plain user@host[:port])
 *   transportOf(locator) -> {kind: 'pipe', home} | {kind: 'ssh', user, host, port?} | null   the link file's
 *                                  transport for an invite's locator. pipe: the daemon runs this plugin's own
 *                                  `sub-human serve --stdio CODE` with that home. ssh: it runs
 *                                  `ssh -T -o BatchMode=yes [opts] [-p port] -- user@host sub-human serve --stdio CODE`
 *                                  and the host's authorized_keys forced command (`sub-human authorize`) decides
 *                                  what runs there. user and host are plain names (never starting with "-", no
 *                                  spaces, quotes or "%"), so an invite can name neither an ssh option nor a command
 *   sshCommand(transport, code, opts?) -> [cmd, ...args]   that ssh command line; opts (default: the
 *                                  SUB_HUMAN_SSH_OPTS environment variable, split on spaces) are extra ssh options
 *                                  from this machine's own environment, never from an invite: for tests and
 *                                  setups that need -i KEY, -F FILE or a known_hosts file
 */

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const protocol = require('./protocol.js');
const { RoomError } = require('../room/validate.js');
const { isAlive, sleepSync } = require('../io.js');
const config = require('../config.js');

const BIN = path.join(__dirname, '..', '..', 'bin', 'sub-human');
const RELAY = new Set(['join', 'leave', 'beat', 'append', 'blob.get', 'blob.put']);
const STOPPED = new Set(['fork', 'stopped']);

// ---------- the hook's side ----------
/**
 * @param {string} dir   the mirror's directory
 * @returns {string}
 */
function socketPath(dir) {
  const h = crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 8);
  return path.join(os.tmpdir(), `sh-${h}`, 'link.sock');
}

/**
 * @param {string} method
 * @param {{socket: string, params: object}} params
 * @returns {Promise<*>}
 */
function handle(method, { socket, params }) {
  if (!RELAY.has(method)) return Promise.reject(new RoomError('PROTOCOL', `${method} is not relayed to the host`));
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socket);
    const dec = protocol.decoder();
    conn.on('connect', () => conn.write(protocol.encode(protocol.request(1, method, params))));
    conn.on('data', chunk => {
      const [f] = dec.push(chunk);
      if (!f) return;
      conn.end();
      if (f.error) reject(new RoomError(f.error.code, f.error.message));
      else resolve(f.result);
    });
    conn.on('error', e => reject(new RoomError('OFFLINE', `the link daemon is not running (${e.code || e.message})`)));
    conn.on('close', () => reject(new RoomError('OFFLINE', 'the link daemon hung up')));
  });
}

/**
 * @param {string} code
 * @returns {{running: boolean, pid?: number, state?: string, since?: string, reason?: string}}
 */
function status(code) {
  const st = require('../room/store.js').open(code).kv.get('link') || {};
  return { ...st, running: isAlive(st.pid) };
}

/**
 * Why the link stopped for good (FORK, AUTH, PROTOCOL, the room closed, no seat left), from its document `link`
 * ({state, reason, code?}): the hook that met a socket that hung up or is gone reports this instead.
 * @param {{state?: string, reason?: string, code?: string} | null} st
 * @returns {{code: string, reason: string} | null}
 */
function stopReason(st) {
  if (!st || !STOPPED.has(st.state) || !st.reason) return null;
  return { code: st.code || (st.state === 'fork' ? 'FORK' : 'OFFLINE'), reason: st.reason };
}

/**
 * @param {string} code
 * @returns {boolean}
 */
function start(code) {
  if (status(code).running) return true;
  const fd = fs.openSync(require('../room/links.js').logFile(code), 'a', 0o600);
  try { spawn(process.execPath, [BIN, 'link', code], { detached: true, stdio: ['ignore', fd, fd] }).unref(); } finally { fs.closeSync(fd); }
  for (const until = Date.now() + config.LINK_START_MS; Date.now() < until; sleepSync(20)) if (status(code).running) return true;
  return false;
}

/**
 * @param {string} [h]   the host's home
 * @returns {string}
 */
const pipeLocator = (h = require('../home.js').home()) => `pipe:${h}`;

// An ssh destination an invite may name: a POSIX-ish user name and a host name or IPv4 address, an optional port.
// Neither part may start with "-" (an option) or hold spaces, quotes, "%" (ssh token expansion) or "@".
const SSH_USER = '[A-Za-z_][A-Za-z0-9_.-]{0,31}';
const SSH_HOST = '[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})';
const SSH_RE = new RegExp(`^(${SSH_USER})@(${SSH_HOST})(?::([0-9]{1,5}))?$`);

function sshDest(dest) {
  const m = SSH_RE.exec(String(dest));
  if (!m) return null;
  const port = m[3] === undefined ? undefined : Number(m[3]);
  if (port !== undefined && !(port >= 1 && port <= 65535)) return null;
  return { kind: 'ssh', user: m[1], host: m[2], ...(port ? { port } : {}) };
}

/**
 * @param {string} dest   user@host[:port]
 * @returns {string | null}
 */
function sshLocator(dest) {
  const t = sshDest(dest);
  return t ? `ssh:${t.user}@${t.host}${t.port ? `:${t.port}` : ''}` : null;
}

/**
 * @param {string} locator
 * @returns {{kind: 'pipe', home: string} | {kind: 'ssh', user: string, host: string, port?: number} | null}
 */
function transportOf(locator) {
  const s = String(locator);
  const m = /^pipe:(\/.*)$/.exec(s);
  if (m) return { kind: 'pipe', home: m[1] };
  return s.startsWith('ssh:') ? sshDest(s.slice(4)) : null;
}

/**
 * @param {{kind: 'ssh', user: string, host: string, port?: number}} t
 * @param {string} code
 * @param {string[]} [opts]
 * @returns {string[]}
 */
function sshCommand(t, code, opts = String(process.env.SUB_HUMAN_SSH_OPTS || '').split(/\s+/).filter(Boolean)) {
  const dest = sshDest(`${t.user}@${t.host}${t.port ? `:${t.port}` : ''}`); // the link file is checked again
  if (!dest) throw new RoomError('INVALID', 'the link\'s ssh destination is not a plain user@host[:port]');
  const { CODE_RE } = require('../text.js');
  if (!CODE_RE.test(code)) throw new RoomError('INVALID', `invalid room code "${code}"`);
  return ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', ...opts,
    ...(dest.port ? ['-p', String(dest.port)] : []), '--', `${dest.user}@${dest.host}`, `sub-human serve --stdio ${code}`];
}

// ---------- the daemon ----------
const listening = (srv, file) => new Promise((resolve, reject) => {
  srv.once('error', reject);
  srv.listen(file, () => { srv.off('error', reject); resolve(); });
});
const answers = file => new Promise(resolve => {
  const c = net.createConnection(file);
  c.on('connect', () => { c.destroy(); resolve(true); });
  c.on('error', () => resolve(false));
});

/** A server on the socket file, in a directory only this user can enter; a stale socket file is replaced. */
async function listen(file, onConn) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.statSync(dir);
  if (st.uid !== process.getuid() || (st.mode & 0o077)) throw new RoomError('AUTH', `${dir} is not private to this user`);
  const srv = net.createServer(onConn);
  try { await listening(srv, file); } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    if (await answers(file)) throw new RoomError('LOCK', `a link daemon already listens on ${file}`);
    fs.rmSync(file, { force: true });
    await listening(srv, file);
  }
  return srv;
}

/** One hook's request: the op relayed, or the error, as one frame. */
async function answer(f, relay) {
  try {
    if (!protocol.isRequest(f) || !RELAY.has(f.op)) throw new RoomError('PROTOCOL', `not an op a hook may relay: ${f.op}`);
    return protocol.reply(f.id, await relay(f.op, f.params));
  } catch (e) {
    return protocol.error(f.id ?? null, protocol.CODES[e.code] ? e.code : 'INVALID', e.message);
  }
}

function serveHook(sock, relay) {
  const dec = protocol.decoder();
  sock.on('error', () => { /* the hook gave up at its deadline */ });
  sock.on('data', chunk => {
    for (const f of dec.push(chunk)) answer(f, relay).then(out => sock.end(protocol.encode(out)));
  });
}

/**
 * @param {{mirror: object, connect: () => Promise<object>, log?: (msg: string) => void, retryMs?: number, retryMaxMs?: number}} opts
 * @returns {Promise<{state(): string, stop(reason: string): void, done: Promise<string>}>}
 */
async function serveMirror({ mirror, connect, log = () => {}, retryMs = config.LINK_RETRY_MS, retryMaxMs = config.LINK_RETRY_MAX_MS }) {
  let state = 'connecting', reason = null, client = null, retry = null, delay = retryMs, finish;
  const done = new Promise(resolve => { finish = resolve; });

  function setState(s, why = null, code = null) {
    state = s;
    reason = why;
    const doc = { pid: process.pid, state, since: new Date().toISOString(), ...(why ? { reason: why } : {}), ...(code ? { code } : {}) };
    try { mirror.kv.set('link', doc); } catch (e) { log(`status: ${e.message}`); }
  }

  async function relay(op, params) {
    if (state === 'connecting') await first;
    if (state !== 'online') throw new RoomError(state === 'fork' ? 'FORK' : 'OFFLINE', `the link is ${state}${reason ? `: ${reason}` : ''}`);
    return client.request(op, params);
  }

  function stop(st, why, code = null) {
    if (STOPPED.has(state)) return;
    clearTimeout(retry);
    const c = client;
    client = null;
    setState(st, why, code);
    if (st === 'fork') log(`FORK in room ${mirror.code}: ${why}. Nothing more is synced; sub-human link --reset ${mirror.code} re-mirrors`);
    srv.close();
    fs.rmSync(path.dirname(socketPath(mirror.dir)), { recursive: true, force: true });
    if (c) c.close();
    finish(why);
  }

  function fail(e) {
    if (e.code === 'FORK') return stop('fork', e.message, 'FORK');
    if (e.code === 'AUTH' || e.code === 'PROTOCOL') return stop('stopped', e.message, e.code);
    log(`offline: ${e.message}`);
    client = null;
    setState('offline', e.message);
    retry = setTimeout(() => { retry = null; attempt(); }, delay);
    delay = Math.min(delay * 2, retryMaxMs);
  }

  function prefetch(c, e) {
    if (e.kind !== 'proposal' || !e.hash) return;
    const ref = mirror.blobs.ref(e.path) || `plans/${e.hash}.md`;
    if (mirror.blobs.has(ref)) return;
    c.blobGet(ref).then(b => b && mirror.applyBlob(ref, b), err => log(`plan ${ref}: ${err.message}`));
  }

  function onEvent(c, { ev, data }) {
    try {
      if (ev === 'entry') prefetch(c, mirror.applyLine(data));
      else if (ev === 'doc') mirror.applyDoc(data.key, data.value);
      else if (ev === 'end' && c === client) {
        if (data.reason === 'closed') stop('stopped', 'the room was closed');
        else fail(new RoomError(data.reason, data.reason === 'FORK' ? 'the host log was reset' : 'the connection to the host closed'));
      }
    } catch (e) {
      stop(e.code === 'FORK' ? 'fork' : 'stopped', e.message, e.code === 'FORK' ? 'FORK' : null);
    }
  }

  async function attempt() {
    let c = null;
    try {
      log('connecting');
      c = await connect();
      const after = mirror.lastId();
      const conn = c;
      await c.subscribe(after, mirror.lineHash(after), ev => onEvent(conn, ev)).ready;
      if (STOPPED.has(state)) return c.close();
      client = c;
      delay = retryMs;
      setState('online');
      log(`online: subscribed after line ${after}`);
    } catch (e) {
      if (c) c.close();
      if (!STOPPED.has(state)) fail(e);
    }
  }

  const srv = await listen(socketPath(mirror.dir), sock => serveHook(sock, relay));
  setState('connecting');
  const first = attempt();
  return { state: () => state, stop: why => stop('stopped', why), done };
}

/** The link file's connection: hello with the token, or with the invite once (its token then replaces it). */
async function connectLink(code) {
  const links = require('../room/links.js');
  const l = links.get(code);
  if (!l) throw new RoomError('AUTH', `this machine has no link to room ${code} any more`);
  const kind = l.transport.kind;
  let spec;
  if (kind === 'pipe') spec = { kind: 'pipe', cmd: [process.execPath, BIN, 'serve', '--stdio', code], env: { ...process.env, SUB_HUMAN_HOME: l.transport.home } };
  else if (kind === 'ssh') spec = { kind: 'pipe', cmd: sshCommand(l.transport, code) };
  else throw new RoomError('PROTOCOL', `unknown transport "${kind}"`);
  const cred = l.token ? { token: l.token } : { invite: l.invite };
  const opts = { machine: require('../home.js').machineId(), helloMs: config.LINK_HELLO_MS, ...cred };
  const c = await require('./client.js').connect(require('./transports/index.js').open(spec), opts);
  if (!l.token) {
    const { invite, ...rest } = l;
    links.set(code, { ...rest, token: c.token });
  }
  return c;
}

function idleWatch(link, mirror, idleMs) {
  const { machineId } = require('../home.js');
  const { leaseFresh } = require('../room/members.js');
  const identity = require('../identity.js');
  const leased = () => Object.values(mirror.members.read()).some(m => m && m.machine === machineId() && !m.left_at && leaseFresh(m));
  const seated = () => {
    const s = link.state();
    return s === 'connecting' || (s === 'online' ? leased() : identity.localSeats(mirror.code).length > 0);
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
async function run({ code, log = msg => process.stderr.write(`${new Date().toISOString()} sub-human link ${code}: ${msg}\n`) }) {
  const store = require('../room/store.js');
  const mirror = store.open(code);
  if (mirror.isHost) throw new RoomError('INVALID', `this machine has no link to room ${code}`);
  store.createRoom(code);
  const link = await serveMirror({ mirror, connect: () => connectLink(code), log, retryMs: config.envMs('SUB_HUMAN_LINK_RETRY_MS', config.LINK_RETRY_MS) });
  const unwatch = idleWatch(link, mirror, config.envMs('SUB_HUMAN_LINK_IDLE_MS', config.LINK_IDLE_MS));
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(sig, () => link.stop(`stopped by ${sig}`));
  const why = await link.done;
  unwatch();
  log(`stopped: ${why}`);
  return why;
}

module.exports = { run, serveMirror, idleWatch, socketPath, handle, status, stopReason, start, pipeLocator, sshLocator, transportOf, sshCommand };
