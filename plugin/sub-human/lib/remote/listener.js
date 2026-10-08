'use strict';
/**
 * plugin/sub-human/lib/remote/listener.js: the host's WebSocket listener daemon (`scripts/sub-human listen [--port
 * 7420]`), one per home. It binds 127.0.0.1 only; a TLS front (Tailscale Serve or Funnel, the lab's Caddy, a
 * person's own reverse proxy) is the only way in from elsewhere. For each WebSocket it runs the Noise_NK handshake
 * as the responder with the host's static X25519 key (lib/remote/transports/ws.js serverChannel), checks the room
 * the joiner names is one this home serves over ws, and only then spawns `<home>/bin/serve --stdio CODE` (the stable
 * shim, lib/remote/shim.js) for that one connection, piping decrypted bytes to its stdin and its stdout back. It never
 * runs lib/remote/server.js in-process (the store lock busy-waits; one wait would stall every connection), parses no
 * protocol frame, and never sees a secret in clear outside the child's pipes. The child authenticates the hello
 * (an invite and its PIN, or a link token) as for any transport.
 *
 *   keyFile() -> <home>/listen/host-x25519.json   the host's static Noise key (0600): a random X25519 key of its own,
 *       made once per home (lib/remote/noise.js loadOrCreateStatic). It is neither derived from nor signed by any
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

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { RoomError } = require('../room/validate.js');
const { isAlive, sleepSync } = require('../io.js');

const DEFAULT_PORT = 7420;
const PREAUTH_MAX = 16;
const LISTEN_MAX = 64;
const HANDSHAKE_MS = 10_000;
const WS_PING_MS = 15_000;
const LISTEN_START_MS = 4000;
const LISTEN_IDLE_MS = 10 * 60_000;
const HOME_CHECK_MS = 2000;
const CLOSED_CHECK_MS = 30_000;
const BIN = path.join(__dirname, '..', '..', 'scripts', 'sub-human');

const home = () => path.resolve(require('../home.js').home());
const dir = () => path.join(home(), 'listen');
const stateFile = () => path.join(dir(), 'state.json');
const logFile = () => path.join(dir(), 'listen.log');
const keyFile = () => path.join(dir(), 'host-x25519.json');
const staticKey = () => require('./noise.js').loadOrCreateStatic(keyFile());
const hostKey = () => staticKey().pub.toString('base64url');
const defaultPort = () => Number(process.env.SUB_HUMAN_LISTEN_PORT) || DEFAULT_PORT;

function read() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) || {}; } catch { return {}; }
}

/** Change the state file under its lock; fn(cur) returns the next state. */
function update(fn) {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const { withLock } = require('../lock.js');
  const { writeFileAtomic } = require('../io.js');
  return withLock(path.join(dir(), 'state.lock'), () => {
    const next = fn(read());
    writeFileAtomic(stateFile(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    return next;
  });
}

function status() {
  const s = read();
  const running = isAlive(s.pid);
  return { running, ...(running ? { pid: s.pid, port: s.port, started_at: s.started_at, conns: s.conns || 0 } : {}), rooms: s.rooms || {} };
}

function addRoom(code, rec) {
  update(s => ({ ...s, rooms: { ...(s.rooms || {}), [code]: { ...rec, at: new Date().toISOString() } } }));
  return rec;
}

function removeRoom(code) {
  let had = null;
  update(s => {
    const rooms = { ...(s.rooms || {}) };
    had = rooms[code] || null;
    delete rooms[code];
    return { ...s, rooms };
  });
  return had;
}

function start({ port = defaultPort() } = {}) {
  const cur = status();
  if (cur.running) return { pid: cur.pid, port: cur.port, started: false };
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  hostKey(); // made here, not raced by the daemon
  const fd = fs.openSync(logFile(), 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [BIN, 'listen', '--port', String(port)], { detached: true, stdio: ['ignore', fd, fd], env: process.env });
    child.unref();
  } finally { fs.closeSync(fd); }
  for (const until = Date.now() + LISTEN_START_MS; Date.now() < until; sleepSync(25)) {
    const s = status();
    if (s.running && s.pid === child.pid && s.port === port) return { pid: s.pid, port, started: true };
    if (!isAlive(child.pid)) break;
  }
  const tail = (() => { try { return fs.readFileSync(logFile(), 'utf8').trim().split('\n').slice(-2).join(' / '); } catch { return ''; } })();
  throw new RoomError('LOCK', `the listener did not come up on 127.0.0.1:${port}${tail ? ` (${tail})` : ''}; its log is ${logFile()}`);
}

function stop() {
  const s = status();
  if (!s.running) return false;
  try { process.kill(s.pid, 'SIGTERM'); } catch { return false; }
  for (const until = Date.now() + 3000; Date.now() < until && isAlive(s.pid); sleepSync(25)) { /* wait */ }
  if (isAlive(s.pid)) try { process.kill(s.pid, 'SIGKILL'); } catch { /* gone */ }
  return true;
}

/** Is room CODE still open on this host (not stopped, closing or gone)? */
function roomLive(code) {
  const identity = require('../identity.js');
  try {
    if (!identity.roomExists(code) || !identity.isHost(code)) return false;
    const orch = identity.readMembers(code).orch;
    return !(orch && (orch.stopped_at || orch.closing));
  } catch { return false; }
}

/** Turn a room's Tailscale path off, if it has one (never another path, never `serve reset`). */
function untailscale(rec, log = () => {}) {
  if (!rec || !rec.tailscale) return null;
  try {
    const r = require('./tailscale.js').off(rec.tailscale);
    log(`tailscale ${rec.tailscale.funnel ? 'funnel' : 'serve'} ${rec.tailscale.path} off: ${r.ok ? 'done' : r.error}`);
    return r;
  } catch (e) { log(`tailscale off: ${e.message}`); return { ok: false, error: e.message }; }
}

async function run({ port = defaultPort(), log = msg => process.stderr.write(`${new Date().toISOString()} sub-human listen: ${msg}\n`), closedCheckMs = Number(process.env.SUB_HUMAN_LISTEN_CHECK_MS) || CLOSED_CHECK_MS, idleMs = Number(process.env.SUB_HUMAN_LISTEN_IDLE_MS) || LISTEN_IDLE_MS } = {}) {
  const ws = require('./ws.js');
  const wsT = require('./transports/ws.js');
  const { CODE_RE } = require('../text.js');
  const s = staticKey();
  let mine = false;
  update(cur => {
    if (isAlive(cur.pid) && cur.pid !== process.pid) throw new RoomError('LOCK', `a listener already runs here (pid ${cur.pid}, port ${cur.port})`);
    return cur;
  });
  let preauth = 0, conns = 0, finish;
  const done = new Promise(r => { finish = r; });
  const children = new Set();
  const publishConns = () => { try { update(cur => (cur.pid === process.pid ? { ...cur, conns } : cur)); } catch { /* best effort */ } };

  const shimCmd = () => {
    const shim = require('./shim.js');
    const p = shim.refresh();
    if (!p) throw new RoomError('INVALID', `the plugin root ${shim.pluginRoot()} is under a temp dir; the listener will not run what sits there (SUB_HUMAN_ALLOW_TMP_ROOT=1 allows it)`);
    return p;
  };

  async function onConnection(conn, req) {
    preauth++;
    conns++;
    const who = req.headers['tailscale-user-login'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    conn.on('error', () => {});
    let ch;
    try {
      ch = await wsT.serverChannel(conn, {
        s,
        timeoutMs: HANDSHAKE_MS,
        check: hello => {
          const code = hello.room;
          const at = String(req.url || '').split('?')[0].split('/').filter(Boolean).pop();
          if (!CODE_RE.test(code)) return { code: 'PROTOCOL', message: 'not a room code' };
          if (at && CODE_RE.test(at) && at !== code) return { code: 'PROTOCOL', message: `this URL is for room ${at}, not ${code}` };
          if (!(read().rooms || {})[code] || !roomLive(code)) return { code: 'OFFLINE', message: `room ${code} is not open for joins over the web here (the host can run /sub-human host --tailscale or --url again)` };
          return null;
        },
      });
    } catch (e) {
      preauth--;
      conns--;
      log(`refused a connection from ${who}: ${e.message}`);
      return;
    }
    preauth--;
    const code = ch.hello.room;
    let child;
    try {
      child = spawn(shimCmd(), ['--stdio', code], { env: { ...process.env, SUB_HUMAN_HOME: home() }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      log(`room ${code}: could not start serve: ${e.message}`);
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
    child.stderr.on('data', d => { for (const l of String(d).split('\n').filter(Boolean)) log(`room ${code} serve ${child.pid}: ${l}`); });
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

  const srv = await ws.createServer({
    host: '127.0.0.1',
    port,
    maxPayload: require('./noise.js').MAX_MESSAGE + 64,
    pingMs: WS_PING_MS,
    accept: () => (preauth >= PREAUTH_MAX || conns >= LISTEN_MAX ? 503 : true),
    onConnection: (conn, req) => { onConnection(conn, req).catch(e => log(`connection: ${e.stack || e}`)); },
  });
  const real = srv.address().port;
  update(cur => { mine = true; return { ...cur, pid: process.pid, port: real, started_at: new Date().toISOString(), conns: 0, rooms: cur.rooms || {} }; });
  log(`listening on 127.0.0.1:${real} (host key ${hostKey().slice(0, 12)}…)`);

  let idleSince = Date.now();
  const sweep = setInterval(() => {
    let rooms = {};
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

  function end(why) {
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

module.exports = {
  DEFAULT_PORT, keyFile, hostKey, stateFile, logFile, status, addRoom, removeRoom, start, stop, run, roomLive, untailscale, defaultPort,
};
