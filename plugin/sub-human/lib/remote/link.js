'use strict';
/**
 * plugin/sub-human/lib/remote/link.js: the link daemon, one per machine and room (`scripts/sub-human link CODE`,
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
 *       token then replaces it in the link file; caps {ping: true}), until it stops; also stops LINK_IDLE_MS
 *       (SUB_HUMAN_LINK_IDLE_MS) after this machine has no seat left in the room (idleWatch), and on SIGTERM,
 *       SIGINT or SIGHUP. SIGUSR2 redials now, as a wake does.
 *   idleWatch(link, mirror, idleMs) -> unwatch   stop the link once idleMs have passed with no seat of this
 *       machine in the room. Online, a seat is one the mirror's members document holds with a fresh lease;
 *       offline, the host's document is stale, so a seat is one a live claude process of this machine holds
 *       (identity.localSeats): a crashed or abandoned join never leaves a daemon retrying for ever. While the
 *       first connection is made it never stops.
 *   serveMirror({mirror, connect, log?, retryMs?, retryMaxMs?, timings?, clock?, random?, mono?, netSignature?, watch?,
 *       seats?, writeState?, outbox?}) -> Promise<Link>
 *       Listen on socketPath(mirror.dir) (one daemon per socket: LOCK when another one answers there), then dial:
 *       connect() -> Promise<Client> (hello done), subscribe {after: the mirror's last id, hash: that line's hash12},
 *       renew the lease of every live seat of this machine (seats(), default identity.localSeats: a `beat`, so a
 *       seat whose lease lapsed on the host during an outage is back with no "left"/"joined" lines; one the host
 *       shows as left is logged: the person joins again), send the outbox, and only then is the link online.
 *       The stream goes into the mirror (a line it holds already, the same id and bytes, is skipped: two streams
 *       overlap during a swap); a proposal's plan is fetched once.
 *       Reconnect (timings: linkTimings(), lib/config.js LINK_*; clock: lib/clock.js, injectable):
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
 *       except an append marked {queue: true} (lib/room/store-mirror.js, for an @room post) whose payload is
 *       outbox.queueable (lib/remote/outbox.js): it is kept in the outbox and answered {queued: n}. Answers,
 *       consent, proposals and agents' posts are never queued. The outbox is sent in order on the new
 *       connection; a post the host already holds is answered "placed already" (its nonce) and counts as sent;
 *       one that waited longer than LINK_OUTBOX_AGE_MS or that the host refuses is dropped and reported in the
 *       document `link` (flush). FORK (the host's line `after` is not the mirror's, a line that does not chain,
 *       or the host log reset) stops it, keeps the outbox, and logs loudly: `sub-human link --reset CODE`
 *       re-mirrors. AUTH or PROTOCOL at hello, or the room closed, stop it too.
 *       Every change is written to the mirror's document `link` {pid, state, since, reason?, code?, queued?,
 *       flush?: {at, sent, unsent: [{text, why}]}} (state connecting | online | offline | fork | stopped) and to
 *       links/<code>.state.json (lib/room/links.js LinkState, for doctor and the statusline: up | connecting |
 *       down, attempt, lastError, rttMs, queued); each dial and each time it is online is a line in the log.
 *       Link = {state() -> string, stop(reason), wake(why?) -> Promise (redial now), done: Promise<reason>}
 *   linkTimings(over?) -> {retryMs, retryMaxMs, pingMs, pongMs, deadMs, wakeTickMs, wakeGapMs, netPollMs}
 *   nextDelay(prev, base, cap, random?) -> ms;  wakeWatch({onWake, tickMs, gapMs, clock?, mono?}) -> unwatch;
 *   netWatch({onChange, pollMs, clock?, signature?}) -> unwatch;  netSignature(ifaces?) -> string
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
 *   transportOf(locator) -> Spec | null   the link file's transport for an invite's locator: the transport
 *                                  registry's parse (lib/remote/transports/index.js), {kind: 'pipe', home} or
 *                                  {kind: 'ssh', user, host, port?} today. connectLink opens it with {code}: pipe runs
 *                                  this plugin's own `sub-human serve --stdio CODE` with that home; ssh runs
 *                                  `ssh … -- user@host sub-human serve --stdio CODE` and the host's authorized_keys
 *                                  forced command decides what runs there (lib/remote/transports/ssh.js)
 *   sshCommand(spec, code, opts?) -> [cmd, ...args]   that ssh command line (lib/remote/transports/ssh.js command)
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
const realClock = require('../clock.js');

const BIN = path.join(__dirname, '..', '..', 'scripts', 'sub-human');
const RELAY = new Set(['join', 'leave', 'beat', 'append', 'blob.get', 'blob.put']);
const STOPPED = new Set(['fork', 'stopped']);
const hash12 = data => crypto.createHash('sha256').update(data).digest('hex').slice(0, 12); // lib/room/store.js's, without loading a store

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

const transports = () => require('./transports/index.js');
const sshLocator = dest => require('./transports/ssh.js').locator(dest);

/**
 * @param {string} locator
 * @returns {{kind: string} | null}
 */
const transportOf = locator => transports().parse(locator);

/**
 * @param {{user: string, host: string, port?: number}} t
 * @param {string} code
 * @param {string[]} [opts]
 * @returns {string[]}
 */
const sshCommand = (t, code, opts) => require('./transports/ssh.js').command(t, code, opts);

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

// ---------- reconnect: backoff, wake, network change ----------
/** Every timing the daemon uses, from lib/config.js and its SUB_HUMAN_LINK_*_MS overrides, then `over`. */
const linkTimings = (over = {}) => ({
  retryMs: config.envMs('SUB_HUMAN_LINK_RETRY_MS', config.LINK_RETRY_MS),
  retryMaxMs: config.envMs('SUB_HUMAN_LINK_RETRY_MAX_MS', config.LINK_RETRY_MAX_MS),
  pingMs: config.envMs('SUB_HUMAN_LINK_PING_MS', config.LINK_PING_MS),
  pongMs: config.envMs('SUB_HUMAN_LINK_PONG_MS', config.LINK_PONG_MS),
  deadMs: config.envMs('SUB_HUMAN_LINK_DEAD_MS', config.LINK_DEAD_MS),
  wakeTickMs: config.envMs('SUB_HUMAN_LINK_WAKE_TICK_MS', config.LINK_WAKE_TICK_MS),
  wakeGapMs: config.envMs('SUB_HUMAN_LINK_WAKE_GAP_MS', config.LINK_WAKE_GAP_MS),
  netPollMs: config.envMs('SUB_HUMAN_LINK_NET_POLL_MS', config.LINK_NET_POLL_MS),
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
const nextDelay = (prev, base, cap, random = Math.random) => Math.round(Math.min(cap, base + random() * (Math.max(base, prev * 3) - base)));

/**
 * Call onWake(gapMs) when a timer ticking every tickMs finds the wall clock moved more than gapMs past the tick, or
 * away from the monotonic clock (which does not count a sleep): the machine slept, or its clock jumped.
 * @returns {() => void} unwatch
 */
function wakeWatch({ onWake, tickMs, gapMs, clock = realClock, mono = () => performance.now() }) {
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

/** This machine's external addresses, as one comparable string. */
function netSignature(ifaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(ifaces || {})) for (const a of list || []) if (a && !a.internal) out.push(`${name}/${a.address}`);
  return out.sort().join(',');
}

/**
 * Call onChange() when signature() differs from the last poll's (an address came, went or moved).
 * @returns {() => void} unwatch
 */
function netWatch({ onChange, pollMs, clock = realClock, signature = netSignature }) {
  let last;
  try { last = signature(); } catch { last = ''; }
  const t = clock.setInterval(() => {
    let now;
    try { now = signature(); } catch { return; }
    if (now !== last) { last = now; onChange(); }
  }, pollMs);
  if (t && t.unref) t.unref();
  return () => clock.clearInterval(t);
}

/** A host line the mirror holds already (the same id and bytes): two streams overlap while a link is swapped. */
function held(mirror, line) {
  let id;
  try { id = JSON.parse(line).id; } catch { return false; }
  return Number.isInteger(id) && id <= mirror.lastId() && mirror.lineHash(id) === hash12(line);
}
const PLACED_ALREADY = /placed already/; // lib/room/store.js: its nonce is in the log, so an earlier try landed
const clip = (s, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const PUBLIC = { online: 'up', connecting: 'connecting' };
const FATAL = new Set(['FORK', 'AUTH', 'PROTOCOL']);

/**
 * @param {{mirror: object, connect: () => Promise<object>, log?: (msg: string) => void, retryMs?: number, retryMaxMs?: number,
 *   timings?: object, clock?: object, random?: () => number, mono?: () => number, netSignature?: () => string,
 *   watch?: boolean, seats?: () => string[], writeState?: (rec: object) => void, outbox?: object}} opts
 * @returns {Promise<{state(): string, stop(reason: string): void, wake(why?: string): Promise<void>, done: Promise<string>}>}
 */
async function serveMirror({
  mirror, connect, log = () => {}, retryMs, retryMaxMs, timings, clock = realClock, random = Math.random,
  mono, netSignature: netSig, watch = true, seats, writeState, outbox,
}) {
  const T = linkTimings({ ...timings, retryMs, retryMaxMs });
  const box = outbox || require('./outbox.js').open(mirror.dir);
  const localSeats = seats || (() => require('../identity.js').localSeats(mirror.code));
  const saveState = writeState || (rec => require('../room/links.js').writeState(mirror.code, rec));
  let state = 'connecting', reason = null, client = null, retry = null, hb = null, delay = T.retryMs, finish;
  let dialing = null, attempts = 0, lastError = null, rttMs = null, doc = {}, pub = null, pubSince = null, flushed = null;
  const unwatch = [];
  const done = new Promise(resolve => { finish = resolve; });

  /** The two records observers read: the mirror's document `link` (lib/tail.js) and links/<code>.state.json. */
  function publish() {
    const d = { ...doc, ...(box.size() ? { queued: box.size() } : {}), ...(flushed ? { flush: flushed } : {}) };
    try { mirror.kv.set('link', d); } catch (e) { log(`status: ${e.message}`); }
    const p = PUBLIC[state] || (dialing ? 'connecting' : 'down');
    if (p !== pub) { pub = p; pubSince = new Date(clock.now()).toISOString(); }
    const rec = { state: p, since: pubSince, attempt: attempts, lastError, rttMs, queued: box.size(), pid: process.pid, detail: state, at: new Date(clock.now()).toISOString() };
    try { saveState(rec); } catch (e) { log(`state: ${e.message}`); }
  }

  function setState(s, why = null, code = null) {
    state = s;
    reason = why;
    doc = { pid: process.pid, state, since: new Date(clock.now()).toISOString(), ...(why ? { reason: why } : {}), ...(code ? { code } : {}) };
    publish();
  }

  async function relay(op, params) {
    if (state === 'connecting') await first;
    let p = params;
    if (op === 'append' && p && p.queue) {
      const { queue, ...rest } = p;
      p = rest;
      if (state !== 'online' && !STOPPED.has(state) && require('./outbox.js').queueable(p.payload)) {
        const n = box.add(p.payload, clock.now());
        log(`offline: an @room post is queued (${n} waiting)`);
        publish();
        return { queued: n };
      }
    }
    if (state !== 'online') throw new RoomError(state === 'fork' ? 'FORK' : 'OFFLINE', `the link is ${state}${reason ? `: ${reason}` : ''}`);
    return client.request(op, p);
  }

  function stop(st, why, code = null) {
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
    fs.rmSync(path.dirname(socketPath(mirror.dir)), { recursive: true, force: true });
    if (c) c.close();
    finish(why);
  }

  function fail(e) {
    if (e.code === 'FORK') return stop('fork', e.message, 'FORK');
    if (e.code === 'AUTH' || e.code === 'PROTOCOL') return stop('stopped', e.message, e.code);
    const c = client;
    client = null;
    clock.clearTimeout(hb);
    if (c) c.close();
    lastError = e.message;
    log(`offline: ${e.message}`);
    setState('offline', e.message);
    if (dialing || retry) return; // that dial's outcome, or the retry already set, decides
    delay = nextDelay(delay, T.retryMs, T.retryMaxMs, random);
    retry = clock.setTimeout(() => { retry = null; dial('retry'); }, delay);
  }

  /** No pong within deadMs: c is dead (a half-open link). A dial already under way decides what comes next. */
  function dead(c, why) {
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
  function heartbeat(c) {
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

  function prefetch(c, e) {
    if (e.kind !== 'proposal' || !e.hash) return;
    const ref = mirror.blobs.ref(e.path) || `plans/${e.hash}.md`;
    if (mirror.blobs.has(ref)) return;
    c.blobGet(ref).then(b => b && mirror.applyBlob(ref, b), err => log(`plan ${ref}: ${err.message}`));
  }

  function onEvent(c, { ev, data }) {
    if (STOPPED.has(state)) return;
    try {
      if (ev === 'entry') { if (!held(mirror, data)) prefetch(c, mirror.applyLine(data)); }
      else if (ev === 'doc') mirror.applyDoc(data.key, data.value);
      else if (ev === 'end' && c === client) {
        if (data.reason === 'closed') stop('stopped', 'the room was closed');
        else fail(new RoomError(data.reason, data.reason === 'FORK' ? 'the host log was reset' : 'the connection to the host closed'));
      }
    } catch (e) {
      stop(e.code === 'FORK' ? 'fork' : 'stopped', e.message, e.code === 'FORK' ? 'FORK' : null);
    }
  }

  /** This machine's live seats renew their lease on the host, so one that lapsed while the link was down is back,
   * quietly: a beat writes no log line (no "left", no "joined"); its pinned key and its link binding never changed. */
  async function keepSeats(c) {
    let names = [];
    try { names = localSeats(); } catch (e) { log(`seats: ${e.message}`); }
    const { leaseFresh } = require('../room/members.js');
    for (const name of names) {
      const m = mirror.members.read()[name];
      try {
        const r = await c.beat(name);
        if (!r || !r.ok) log(`seat ${name} is not in room ${mirror.code} on the host any more; /sub-human ${name} ${mirror.code} joins again`);
        else if (m && !leaseFresh(m)) log(`seat ${name}: its lease had lapsed on the host; renewed`);
      } catch (e) {
        if (e.code === 'OFFLINE') throw e;
        log(`seat ${name}: ${e.message}`);
      }
    }
  }

  /** Send the queued @room posts on c, oldest first (c subscribed: the mirror is the host's prefix). A post the host
   * already holds (an earlier try landed) is answered "placed already" by its nonce: done. OFFLINE keeps the rest. */
  async function flush(c) {
    let sent = 0;
    const unsent = [];
    const note = () => { if (sent || unsent.length) flushed = { at: new Date(clock.now()).toISOString(), sent, unsent }; };
    const drop = (x, why) => { unsent.push({ text: clip(String(x.payload.text || '')), why }); log(`a queued @room post was not sent: ${why}`); };
    for (;;) {
      for (const x of box.expire(clock.now())) drop(x, 'it waited too long (the host refuses a signature that old)');
      const x = box.first();
      if (!x) break;
      try {
        await c.append(x.payload);
        sent++;
      } catch (e) {
        if (e.code === 'OFFLINE' || e.code === 'LOCK') { note(); throw e; }
        if (PLACED_ALREADY.test(e.message)) sent++;
        else drop(x, e.message);
      }
      box.drop();
    }
    note();
    if (sent || unsent.length) log(`outbox: ${sent} queued @room post(s) sent${unsent.length ? `, ${unsent.length} not sent` : ''}`);
  }

  /**
   * Make a new connection (subscribe from the mirror's last line, renew the seats, send the outbox), and only once
   * it is live swap it in and close the old one; a hook's op meanwhile still goes over the old one. One at a time.
   */
  function dial(why = null) {
    if (STOPPED.has(state)) return Promise.resolve();
    if (dialing) return dialing;
    clock.clearTimeout(retry);
    retry = null;
    attempts++;
    dialing = (async () => {
      let c = null;
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
        setState('online');
        log(`online: subscribed after line ${after}${old ? '; swapped in, the old connection is closed' : ''}`);
        heartbeat(c);
        if (old) retire(old);
      } catch (e) {
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
  function retire(old) {
    const d = typeof old.drain === 'function' ? old.drain() : Promise.resolve();
    d.then(() => old.close(), () => old.close());
  }

    /** A wake, a network change, a late pong or a signal: redial now, with the backoff reset. */
  function redial(why) {
    if (STOPPED.has(state)) return Promise.resolve();
    delay = T.retryMs;
    if (!dialing) log(`${why}: redialing now`);
    return dial(why);
  }

  const srv = await listen(socketPath(mirror.dir), sock => serveHook(sock, relay));
  setState('connecting');
  const first = dial();
  if (watch) {
    unwatch.push(wakeWatch({ onWake: gap => redial(`woke from sleep (the clock jumped ${gap} ms)`), tickMs: T.wakeTickMs, gapMs: T.wakeGapMs, clock, ...(mono ? { mono } : {}) }));
    if (T.netPollMs > 0) unwatch.push(netWatch({ onChange: () => redial('the network changed'), pollMs: T.netPollMs, clock, ...(netSig ? { signature: netSig } : {}) }));
  }
  return { state: () => state, stop: why => stop('stopped', why), wake: (why = 'asked') => redial(why), done };
}

/** The link file's connection: hello with the token, or with the invite once (its token then replaces it). */
async function connectLink(code) {
  const links = require('../room/links.js');
  const l = links.get(code);
  if (!l) throw new RoomError('AUTH', `this machine has no link to room ${code} any more`);
  const kind = l.transport && l.transport.kind;
  if (!transports().get(kind)) throw new RoomError('PROTOCOL', `unknown transport "${kind}" (${transports().kinds().join(', ')})`);
  const cred = l.token ? { token: l.token } : { invite: l.invite };
  const opts = { machine: require('../home.js').machineId(), helloMs: config.LINK_HELLO_MS, caps: { ping: true }, ...cred };
  const c = await require('./client.js').connect(transports().open(l.transport, { code }), opts);
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
  const link = await serveMirror({ mirror, connect: () => connectLink(code), log });
  const unwatch = idleWatch(link, mirror, config.envMs('SUB_HUMAN_LINK_IDLE_MS', config.LINK_IDLE_MS));
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(sig, () => link.stop(`stopped by ${sig}`));
  process.on('SIGUSR2', () => link.wake('SIGUSR2'));
  const why = await link.done;
  unwatch();
  log(`stopped: ${why}`);
  return why;
}

module.exports = {
  run, serveMirror, idleWatch, socketPath, handle, status, stopReason, start, pipeLocator, sshLocator, transportOf, sshCommand,
  linkTimings, nextDelay, wakeWatch, netWatch, netSignature,
};
