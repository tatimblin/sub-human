'use strict';
/**
 * plugin/sub-human/lib/cli/doctor.js: `sub-human doctor`, what is wrong with this machine's sub-human and how to fix
 * it, and `doctor --bundle`, the same as redacted JSON to attach to a bug report. Read only, except --fix (the
 * shim refresh and the home's modes) and the bundle file. scripts/sub-human dispatches here.
 *
 *   sub-human doctor [--quick] [--fix] [--json] [--bundle [FILE]] [--authorized-keys FILE] [--timeout MS]
 *       --quick    skip the slow checks: the hello to each link's host and the Claude Code internals probe
 *       --fix      first refresh the serve shim and pointer (lib/remote/shim.js refresh) and repair the home's
 *                  modes (lib/home.js repairModes)
 *       --json     the report as JSON (unredacted: it stays on this machine)
 *       --bundle   write the redacted bundle (default ./sub-human-doctor-<time>.json) and print its path
 *       --authorized-keys   the file to scan (default ~/.ssh/authorized_keys)
 *       --timeout  the hello's deadline per link (default DOCTOR_HELLO_MS, 8 s)
 *   Exit 1 when a check fails, else 0.
 *
 * Checks, each {id, status: pass|warn|fail|info, title, detail, fix?}:
 *   plugin       the plugin's version (plugin.json) and root
 *   node         Node 24 or newer
 *   home         the home and its store directories are 0700 and this user's
 *   shim         <home>/bin/serve is the current shim and <home>/bin/current names an existing plugin and node
 *   authorized_keys   sub-human lines that bypass the shim (an older `authorize` baked node and the versioned
 *                plugin path in); fix: `sub-human authorize … --file F` rewrites them
 *   ssh          ssh present (`ssh -V`), when a link or an authorized line needs it
 *   link:CODE    per link: transport, the daemon (running, pid), state (lib/room/link-state.js), the last error
 *                (the state record, else the daemon's log), and unless --quick a hello to the host without a
 *                credential (the server answers it and nothing else) with a timeout: reachable, round trip, both
 *                sides' protocol versions, and over ssh whether BatchMode works (ssh's own error, classified)
 *   clock:CODE   skew against the host, when its hello reply carries a time (warn 2 min, fail SIG_SKEW_MS)
 *   claude       Claude Code's version against cc.MIN_VERSION and cc.PROBED_VERSION; when it differs from the
 *                probed one, unless --quick, the internals probe (cc.probe, ~3 s)
 *   hooks        settings that turn hooks off (disableAllHooks): the plugin then cannot seat anyone
 *   remote_control   whether Remote Control (the phone) is likely available: it needs a claude.ai login and is
 *                unavailable with Bedrock, Vertex, Foundry or an API key (informational)
 *   listener     the host's web listener (lib/remote/listener.js status, <home>/listen/state.json): running, its pid
 *                and port, the rooms it serves; a room served with no listener running is a failure
 *   web:CODE     per room served over the web: a room that closed (warn); with Tailscale, unless --quick, that
 *                `tailscale serve status --json` still lists its path (fail when gone), and with Funnel the
 *                certificate-transparency warning (warn: the name is public)
 * A wss/ws link's hello goes over the real transport (the WebSocket and the pinned Noise handshake).
 *
 *   diagnose(opts) -> Promise<Report>   Report = {generated_at, versions, checks, links, authorizedKeys}
 *   format(report, {color}?) -> string
 *   bundle(report, {salt?, env?}?) -> object   allowlisted fields only, every free text through redactor()
 *   redactor({home?, hosts?, users?, rooms?, members?, salt?}) -> (text) -> text   ~ for paths under $HOME; hashed room codes, member names, hostnames, users
 *                and IPs; invites, tokens, long hex and secrets cut; SSH public keys as a SHA256 fingerprint prefix
 *   helloProbe(spec, code, {timeoutMs, env}?) -> Promise<{ok, ms, reply?, error?, stderr?}>
 *   main(args) -> Promise<exitCode>
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const LIB = path.join(__dirname, '..');
const PLUGIN_ROOT = path.join(LIB, '..');
const BIN = path.join(PLUGIN_ROOT, 'scripts', 'sub-human');
const lib = name => require(path.join(LIB, name));

const NODE_MIN = 24;
const DOCTOR_HELLO_MS = 8000;
const SKEW_WARN_MS = 2 * 60 * 1000;
const STORE_DIRS = ['rooms', 'sessions', 'links', 'keys', 'bin'];
const NO_REMOTE_CONTROL = {
  CLAUDE_CODE_USE_BEDROCK: 'Bedrock', CLAUDE_CODE_USE_VERTEX: 'Vertex', CLAUDE_CODE_USE_FOUNDRY: 'Foundry',
  ANTHROPIC_API_KEY: 'an API key', ANTHROPIC_AUTH_TOKEN: 'an auth token',
};

const check = (id, status, title, detail, fix) => ({ id, status, title, detail, ...(fix ? { fix } : {}) });
const tilde = (p, h = os.homedir()) => (p && h && (p === h || p.startsWith(h + path.sep)) ? '~' + p.slice(h.length) : p);
const isExec = p => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };
const readText = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const truthy = v => v !== undefined && v !== '' && v !== '0' && String(v).toLowerCase() !== 'false';

function pluginVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version || null; } catch { return null; }
}

// ---------- local checks ----------
function checkPlugin() {
  const v = pluginVersion();
  return check('plugin', v ? 'pass' : 'warn', 'plugin', `sub-human ${v || '(no version in plugin.json)'} at ${tilde(PLUGIN_ROOT)}`);
}

function checkNode(version = process.versions.node) {
  const major = Number(String(version).split('.')[0]);
  return major >= NODE_MIN
    ? check('node', 'pass', 'node', `v${version}`)
    : check('node', 'fail', 'node', `v${version}; sub-human needs Node ${NODE_MIN} or newer`, `install Node ${NODE_MIN}+ (e.g. nvm install ${NODE_MIN}); the hooks run on the node Claude Code finds on PATH`);
}

function checkHome() {
  const h = lib('home.js').home();
  if (!fs.existsSync(h)) return check('home', 'info', 'home', `${tilde(h)} does not exist yet (made at the first join)`);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const bad = [];
  for (const d of [h, ...STORE_DIRS.map(n => path.join(h, n))]) {
    let st;
    try { st = fs.statSync(d); } catch { continue; }
    if (uid !== null && st.uid !== uid) bad.push(`${tilde(d)} belongs to uid ${st.uid}`);
    else if (st.mode & 0o077) bad.push(`${tilde(d)} is ${(st.mode & 0o777).toString(8)}`);
  }
  if (!bad.length) return check('home', 'pass', 'home', `${tilde(h)} and its store directories are 0700`);
  return check('home', 'fail', 'home', bad.join('; '), `sub-human doctor --fix (or chmod 700 ${bad.map(b => b.split(' ')[0]).join(' ')})`);
}

function checkShim({ needed }) {
  const shim = lib('remote/shim.js');
  const file = shim.shimPath(), ptr = shim.pointerPath();
  if (!fs.existsSync(file) && !fs.existsSync(ptr)) {
    return check('shim', needed ? 'fail' : 'info', 'serve shim', `${tilde(file)} is not there${needed ? ', and authorized_keys names it' : ' (only a host reached over SSH needs it)'}`,
      needed ? 'sub-human doctor --fix (any sub-human command or a Claude Code start writes it)' : undefined);
  }
  const problems = [];
  if (!isExec(file)) problems.push(`${tilde(file)} is missing or not executable`);
  else if (readText(file) !== shim.shimBody()) problems.push(`${tilde(file)} is an older shim`);
  const lines = (readText(ptr) || '').split('\n');
  const [root, node] = lines;
  if (!root) problems.push(`${tilde(ptr)} names no plugin`);
  else if (!['scripts/sub-human', 'bin/sub-human'].some(c => fs.existsSync(path.join(root, c)))) problems.push(`the recorded plugin ${tilde(root)} is gone`);
  if (!node) problems.push(`${tilde(ptr)} names no node`);
  else if (!isExec(node)) problems.push(`the recorded node ${tilde(node)} is gone (the shim falls back to node on PATH)`);
  const stale = root && path.resolve(root) !== path.resolve(shim.pluginRoot());
  if (!problems.length) {
    return check('shim', stale ? 'warn' : 'pass', 'serve shim',
      stale ? `runs ${tilde(root)}, not this install (${tilde(shim.pluginRoot())})` : `runs ${tilde(root)} with ${tilde(node)}`,
      stale ? 'sub-human doctor --fix, or start Claude Code once (SessionStart refreshes it)' : undefined);
  }
  return check('shim', 'fail', 'serve shim', problems.join('; '), 'sub-human doctor --fix (any sub-human command or a Claude Code start rewrites it)');
}

// command="SUB_HUMAN_HOME=<home> <...> --stdio CODE --link ID",restrict <type> <key> sub-human:CODE:ID
const KEY_LINE_RE = /^command="SUB_HUMAN_HOME=(\S+) (.+?) --stdio (\S+) --link ([0-9a-f]{12})",restrict (\S+) (\S+) sub-human:(\S+):(\S+)\s*$/;

function scanAuthorizedKeys(file) {
  const text = readText(file);
  if (text === null) return { file, exists: false, lines: [] };
  const lines = [];
  for (const l of text.split('\n')) {
    if (!/\bsub-human:/.test(l) && !/ serve --stdio /.test(l)) continue;
    const m = KEY_LINE_RE.exec(l.trim());
    if (!m) { lines.push({ ok: false, parse: false, raw: l }); continue; }
    const [, home, run, code, id, type, key] = m;
    const shimmed = run === path.join(home, 'bin', 'serve');
    lines.push({ ok: shimmed, home, code, id, type, key, shimmed });
  }
  return { file, exists: true, lines };
}

function checkAuthorizedKeys(scan) {
  const h = path.resolve(lib('home.js').home());
  if (!scan.exists) return check('authorized_keys', 'info', 'authorized_keys', `${tilde(scan.file)}: none (this machine hosts no room over SSH)`);
  if (!scan.lines.length) return check('authorized_keys', 'info', 'authorized_keys', `${tilde(scan.file)}: no sub-human lines`);
  const old = scan.lines.filter(l => !l.ok);
  if (!old.length) return check('authorized_keys', 'pass', 'authorized_keys', `${scan.lines.length} sub-human line(s), all through the shim`);
  const fixes = old.map(l => (l.parse === false ? `edit the unreadable sub-human line by hand in ${tilde(scan.file)}`
    : `echo '${l.type} ${l.key}' | ${l.home === h ? '' : `SUB_HUMAN_HOME=${l.home} `}sub-human authorize ${l.id} - --room ${l.code} --file ${tilde(scan.file)}`));
  return check('authorized_keys', 'warn', 'authorized_keys',
    `${old.length} of ${scan.lines.length} sub-human line(s) bypass the shim: they bake in a node and plugin path that break on an update`,
    [...new Set(fixes)].join('\n'));
}

function sshVersion() {
  const r = spawnSync('ssh', ['-V'], { encoding: 'utf8', timeout: 5000 });
  if (r.error) return null;
  return String(r.stderr || r.stdout || '').trim().split('\n')[0] || 'ssh (unknown version)';
}

function checkSsh({ needed, version }) {
  if (version) return check('ssh', 'pass', 'ssh', version);
  return check('ssh', needed ? 'fail' : 'info', 'ssh', 'no ssh on PATH', needed ? 'install OpenSSH (the ssh links run `ssh -T -o BatchMode=yes`)' : undefined);
}

// ---------- links ----------
const lastLogError = code => {
  let text;
  try {
    const file = lib('room/links.js').logFile(code);
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size, len = Math.min(size, 32 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return []; }
  return text.split('\n').filter(l => /: (offline|stopped|FORK|status|error|plan )/i.test(l) || /\berror\b/i.test(l)).slice(-10);
};

/**
 * ssh's own complaint, as a hint in the sh2 flow (the link's own key, the host's `/sub-human admit shk1…`, `sub-human
 * prime` for an MFA bastion, `--via` for a jump host). link: the link file's {code, request?, transport} when known.
 */
function sshHint(stderr, link = {}) {
  const s = String(stderr || '');
  const code = link.code || 'CODE';
  const t = link.transport || {};
  const newInvite = `ask the host for a new invite (/sub-human host --ssh${t.via ? ` --via ${t.via}` : ''}), then /sub-human join NAME INVITE PIN`;
  if (/keyboard-interactive|Verification code|one-time password|Duo two-factor/i.test(s) && !/publickey\)\.?\s*$/i.test(s.trim())) {
    return `the host or a jump host wants an interactive login (MFA): run sub-human prime ${code} once in your shell; the link then rides that connection for hours`;
  }
  if (/Permission denied/i.test(s)) {
    const admit = link.request
      ? `the host has not let this link's key in yet: send them this line (it holds no secret) to paste in their session: /sub-human admit ${link.request}`
      : 'the host refused this link\'s key: it was never admitted, or the host revoked it. Send the host the /sub-human admit shk1… line your join showed, or ' + newInvite;
    return `${admit}. Behind a bastion with MFA, run sub-human prime ${code} first`;
  }
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(s)) {
    return t.knownHosts
      ? `the host's ssh key is not the one its invite pinned (a reinstalled or different machine): check with the host, then ${newInvite}`
      : 'the host key is unknown or changed: run `ssh USER@HOST` once by hand to check and accept it, or ' + newInvite + ' (an sh2 invite pins the key)';
  }
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(s)) {
    return `the host name does not resolve from here (VPN or tailnet down?)${t.via ? '' : '; if it is only reachable through a jump host, ask the host for an invite with --via JUMP (/sub-human host --ssh --via JUMP)'}`;
  }
  if (/Connection refused/i.test(s)) return 'nothing listens for ssh on that port';
  if (/timed out|Operation timed out/i.test(s)) {
    return `the host does not answer (asleep, offline or firewalled)${t.via ? '' : '; behind a bastion, the invite needs --via JUMP (/sub-human host --ssh --via JUMP)'}`;
  }
  if (/sub-human: no (plugin install|node)/.test(s)) return 'the host\'s shim found no plugin or node: on the host, start Claude Code once or run `sub-human doctor --fix`';
  return null;
}

/** The hello a link's daemon would say, without a credential: the server answers it and nothing else. */
function helloProbe(spec, code, { timeoutMs = DOCTOR_HELLO_MS, env = process.env } = {}) {
  const protocol = lib('remote/protocol.js');
  let cmd;
  try {
    if (spec.kind === 'ssh') {
      const extra = String(env.SUB_HUMAN_SSH_OPTS || '').split(/\s+/).filter(Boolean);
      cmd = { argv: lib('remote/transports/ssh.js').command(spec, code, [...extra, '-o', `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`]), env };
    } else if (spec.kind === 'pipe' && typeof spec.home === 'string') {
      cmd = { argv: [process.execPath, BIN, 'serve', '--stdio', code], env: { ...env, SUB_HUMAN_HOME: spec.home } };
    }
  } catch (e) { return Promise.resolve({ ok: false, ms: 0, error: e.message }); }
  if (!cmd && (spec.kind === 'wss' || spec.kind === 'ws')) return webHelloProbe(spec, code, { timeoutMs });
  if (!cmd) return Promise.resolve({ ok: false, ms: 0, skipped: true, error: `no reachability check for the ${spec.kind} transport` });
  // v 1: the least this probe needs, so a host before 0.4 (which checks v === 1 and knows no proto) answers too
  const params = { v: 1, proto: protocol.PROTO, client: protocol.PLUGIN_VERSION, caps: {}, machine: lib('home.js').machineId() };
  return new Promise(resolve => {
    const t0 = Date.now();
    let stderr = '', done = false;
    const child = spawn(cmd.argv[0], cmd.argv.slice(1), { env: cmd.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = r => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.stdin.end(); child.kill(); } catch { /* gone */ }
      resolve({ ms: Date.now() - t0, t0, t1: Date.now(), stderr: stderr.trim().slice(-2000), ...r });
    };
    const timer = setTimeout(() => finish({ ok: false, error: `no answer within ${timeoutMs} ms` }), timeoutMs);
    const dec = protocol.decoder();
    child.stdout.on('data', chunk => {
      for (const f of dec.push(chunk)) {
        if (f.id !== 1) continue;
        if (f.error) finish({ ok: false, error: `${f.error.code}: ${f.error.message}`, code: f.error.code });
        else finish({ ok: true, reply: f.result });
      }
    });
    child.stderr.on('data', d => { stderr += d; });
    child.stdin.on('error', () => { /* the child is gone; its exit says so */ });
    child.on('error', e => finish({ ok: false, error: e.message }));
    child.on('exit', (c, sig) => finish({ ok: false, error: `the ${spec.kind} command exited (${sig || c}) before answering` }));
    child.stdin.write(protocol.encode(protocol.request(1, 'hello', params)));
  });
}

/** A wss/ws link's hello without a credential: the WebSocket, the Noise handshake pinned to the link's key, then hello. */
async function webHelloProbe(spec, code, { timeoutMs = DOCTOR_HELLO_MS } = {}) {
  const t0 = Date.now();
  const protocol = lib('remote/protocol.js');
  let t = null;
  const deadline = new Promise((_, no) => setTimeout(() => no(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs).unref());
  try {
    t = await Promise.race([lib('remote/transports/index.js').open(spec, { code }), deadline]);
    const reply = await Promise.race([new Promise((ok, no) => {
      t.onFrame(f => { if (f.id === 1) (f.error ? no(Object.assign(new Error(`${f.error.code}: ${f.error.message}`), { code: f.error.code })) : ok(f.result)); });
      t.onClose(() => no(new Error('the listener closed before answering')));
      t.send(protocol.request(1, 'hello', { v: 1, proto: protocol.PROTO, client: protocol.PLUGIN_VERSION, caps: {}, machine: lib('home.js').machineId() }));
    }), deadline]);
    return { ok: true, ms: Date.now() - t0, t0, t1: Date.now(), reply };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e.message, ...(e.code ? { code: e.code } : {}) };
  } finally { if (t) t.close(); }
}

/** The host's web listener and the rooms it serves (lib/remote/listener.js), with their Tailscale paths. */
function checkListener({ quick = false } = {}) {
  let st;
  try { st = lib('remote/listener.js').status(); } catch (e) { return [check('listener', 'warn', 'listener', `could not read its state: ${e.message}`)]; }
  const codes = Object.keys(st.rooms || {});
  if (!codes.length && !st.running) return [check('listener', 'info', 'listener', 'no room is served over the web here (/sub-human host --tailscale or --url starts it)')];
  const out = [st.running
    ? check('listener', 'pass', 'listener', `running (pid ${st.pid}) on 127.0.0.1:${st.port} · ${codes.length ? `serves ${codes.join(', ')}` : 'serves no room'}${st.conns ? ` · ${st.conns} connection(s)` : ''}`)
    : check('listener', 'fail', 'listener', `not running, but ${codes.join(', ')} ${codes.length === 1 ? 'is' : 'are'} served over the web: joiners cannot reach ${codes.length === 1 ? 'it' : 'them'}`,
      `sub-human listen --start (or /sub-human host --tailscale again); its log: ${tilde(lib('remote/listener.js').logFile())}`)];
  const ts = lib('remote/tailscale.js');
  const serveStatus = {}; // bin -> stdout
  for (const code of codes) {
    const rec = st.rooms[code] || {};
    const id = `web:${code}`;
    if (!lib('remote/listener.js').roomLive(code)) { out.push(check(id, 'warn', `web ${code}`, 'served over the web, but the room is closed or gone here', `sub-human unhost --room ${code}`)); continue; }
    const where = rec.url || rec.path || '?';
    if (!rec.tailscale) { out.push(check(id, 'info', `web ${code}`, `${rec.mode === 'handoff' ? 'moved here by a handoff' : 'through your own front'} at ${where}`)); continue; }
    const kind = rec.tailscale.funnel ? 'funnel' : 'serve';
    if (!quick) {
      const bin = rec.tailscale.bin || ts.bin();
      if (!(bin in serveStatus)) {
        const r = bin ? spawnSync(bin, ['serve', 'status', '--json'], { encoding: 'utf8', timeout: 10_000 }) : { status: 1, stdout: '' };
        serveStatus[bin] = r.status === 0 ? String(r.stdout || '') : null;
      }
      const text = serveStatus[bin];
      if (text === null) out.push(check(id, 'warn', `web ${code}`, `tailscale ${kind} ${rec.tailscale.path}: could not read tailscale serve status`, 'is Tailscale running? tailscale status'));
      else if (!text.includes(rec.tailscale.path)) {
        out.push(check(id, 'fail', `web ${code}`, `tailscale ${kind} has no ${rec.tailscale.path} any more (a reset, or another serve replaced it)`, `/sub-human host --tailscale${rec.tailscale.funnel ? ' --funnel' : ''} in the room (it puts the path back)`));
        continue;
      }
    }
    out.push(rec.tailscale.funnel
      ? check(id, 'warn', `web ${code}`, `Tailscale Funnel ${where}${quick ? '' : ' (path present)'}. ${ts.CT_WARNING}`, `/sub-human unhost when nobody needs to join from outside the tailnet`)
      : check(id, 'pass', `web ${code}`, `Tailscale Serve (tailnet only) ${where}${quick ? '' : ' (path present)'}`));
  }
  return out;
}

/** The host's clock from a hello reply, when it carries one (ms). */
function replyTime(reply) {
  for (const k of ['time', 'now', 'ts', 'at']) {
    const v = reply && reply[k];
    const ms = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

async function diagnoseLink(code, { quick, timeoutMs, env }) {
  const links = lib('room/links.js');
  const l = links.get(code) || {};
  const spec = l.transport || {};
  let describe = spec.kind || '?';
  try { describe = lib('remote/transports/index.js').describe(spec); } catch { /* kind unknown */ }
  let daemon = { running: false };
  try { const s = lib('remote/link.js').status(code); daemon = { running: !!s.running, pid: s.pid || null }; } catch { /* no mirror */ }
  const st = lib('room/link-state.js').read(code) || { state: 'offline' };
  if (st.pid) daemon = { running: lib('io.js').isAlive(st.pid), pid: st.pid }; // the state record's own pid wins
  const recent = lastLogError(code);
  const out = { code, transport: { kind: spec.kind, describe, user: spec.user, host: spec.host, port: spec.port, home: spec.home },
    credential: l.token ? 'token' : l.invite ? 'invite (not redeemed yet)' : 'none', daemon, state: st, recent,
    // an ssh link not admitted yet: the line its host pastes (/sub-human admit shk1…; no secret in it)
    ...(!l.token && typeof l.request === 'string' ? { request: l.request } : {}),
    // the room's host moved (lib/handoff.js): the link file was re-pointed at the new host; reached once a token came
    moved: l.moved ? { epoch: l.moved.epoch, host: l.moved.host, locator: l.moved.locator, demoted: !!l.moved.demoted, reached: !!l.moved.reached_at } : null };
  if (!quick) {
    const r = await helloProbe(spec, code, { timeoutMs, env });
    const reply = r.reply || {};
    const hostTime = replyTime(reply);
    out.reach = {
      ok: r.ok, ms: r.ms, error: r.error, skipped: !!r.skipped, hint: r.ok ? null : (spec.kind === 'ssh' ? sshHint(r.stderr, { code, request: l.request, transport: spec }) : null),
      stderr: r.stderr || '',
      protocol: r.ok ? { v: reply.v, proto: reply.proto || null, server: typeof reply.server === 'string' ? reply.server : null } : null,
      skewMs: r.ok && hostTime !== null ? Math.round(hostTime - (r.t0 + r.t1) / 2) : null,
    };
  }
  return out;
}

function linkChecks(d) {
  const ls = lib('room/link-state.js');
  const protocol = lib('remote/protocol.js');
  const out = [];
  const bits = [`${d.transport.describe}`, `daemon ${d.daemon.running ? `running (pid ${d.daemon.pid})` : 'not running'}`, ls.indicator(d.state) || d.state.state];
  if (d.state.rttMs !== undefined) bits.push(`rtt ${d.state.rttMs} ms`);
  const lastError = d.state.lastError || (d.recent.length ? d.recent.at(-1).replace(/^\S+ sub-human link \S+: /, '') : null);
  if (lastError && d.state.state !== 'online') bits.push(`last error: ${lastError}`);
  if (d.moved) {
    const where = `${d.moved.host || 'another'}'s machine${d.moved.locator ? ` (${d.moved.locator})` : ''}${d.moved.epoch !== undefined ? `, host epoch ${d.moved.epoch}` : ''}`;
    bits.push(d.moved.reached ? `the room moved to ${where}; this link follows it` : `the room moved to ${where}; not reached from here yet`);
  }
  let status = d.state.state === 'online' ? 'pass' : d.state.state === 'fork' ? 'fail' : 'warn';
  let fix;
  if (d.state.state === 'fork') fix = `sub-human link --reset ${d.code}`;
  else if (d.moved && !d.moved.reached && d.state.state !== 'online') {
    const who = d.moved.host || 'its host';
    fix = `${d.request ? `over ssh ${who} lets this machine's key in first: send them /sub-human admit ${d.request}\n` : ''}`
      + `if this machine cannot reach the new host, ask ${who} for an invite it can use (/sub-human host there), then /sub-human join NAME INVITE PIN`;
  } else if (d.request && d.state.state !== 'online') fix = `the host has not let this link's key in yet: send them /sub-human admit ${d.request}`;
  else if (/STALE/.test(lastError || '')) fix = 'this copy speaks to a host the room moved away from: sub-human handoff --status shows where it is';
  else if (!d.daemon.running && d.state.state !== 'online') fix = `the join hook starts the daemon: /sub-human join again, or run sub-human link ${d.code} in a shell`;
  if (d.reach) {
    const r = d.reach;
    const span = x => (x && x.min !== undefined ? (x.min === x.max ? `${x.min}` : `${x.min}-${x.max}`) : '?');
    const local = `${span(protocol.PROTO)} (sub-human ${protocol.PLUGIN_VERSION})`;
    if (r.skipped) bits.push(r.error);
    else if (r.ok) {
      const p = r.protocol || {};
      const host = `${p.proto ? span(p.proto) : p.v} (sub-human ${p.server || 'before 0.4'})`;
      bits.push(`host reachable in ${r.ms} ms; protocol here ${local}, host ${host}, speaking v${p.v}`);
    } else {
      bits.push(`host unreachable: ${r.error}`);
      status = 'fail';
      fix = [r.hint, /PROTOCOL/.test(r.error || '') ? 'the two sides speak different protocol versions: update sub-human on the older side (/plugin update sub-human)' : null, fix].filter(Boolean).join('\n') || fix;
    }
    if (d.transport.kind === 'ssh' && !r.skipped) {
      bits.push(r.ok ? 'ssh BatchMode works' : (/Permission denied|Host key/i.test(r.stderr) ? 'ssh BatchMode fails' : ''));
    }
    if (r.ok) {
      const SIG_SKEW_MS = lib('room/envelope.js').SIG_SKEW_MS;
      if (r.skewMs === null) out.push(check(`clock:${d.code}`, 'info', `clock ${d.code}`, 'skew not measurable: the host\'s hello carries no time'));
      else {
        const abs = Math.abs(r.skewMs);
        const s = abs >= SIG_SKEW_MS ? 'fail' : abs >= SKEW_WARN_MS ? 'warn' : 'pass';
        out.unshift(check(`clock:${d.code}`, s, `clock ${d.code}`, `this machine is ${Math.round(abs / 1000)} s ${r.skewMs > 0 ? 'behind' : 'ahead of'} the host`,
          s === 'pass' ? undefined : 'turn on network time (NTP) on both machines: signed posts older than 10 min are refused'));
      }
    }
  }
  out.unshift(check(`link:${d.code}`, status, `link ${d.code}`, bits.filter(Boolean).join(' · '), fix));
  return out;
}

// ---------- Claude Code ----------
function claudeVersion(env) {
  const r = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 15_000, env });
  if (r.error || r.status !== 0) return null;
  const m = /(\d+\.\d+\.\d+)/.exec(r.stdout || '');
  return m ? m[1] : null;
}

function checkClaude({ version, quick, env }) {
  const cc = lib('cc.js');
  if (!version) return { check: check('claude', 'warn', 'Claude Code', 'no `claude` on PATH here', 'install Claude Code, or put it on PATH for this shell') };
  if (cc.compareVersions(version, cc.MIN_VERSION) < 0) {
    return { check: check('claude', 'fail', 'Claude Code', `${version}; sub-human needs ${cc.MIN_VERSION}+ (function hooks)`, 'update Claude Code (claude update)') };
  }
  const same = cc.compareVersions(version, cc.PROBED_VERSION) === 0;
  if (same) return { check: check('claude', 'pass', 'Claude Code', `${version}, the version its internals were checked on`) };
  if (quick) {
    return { check: check('claude', 'info', 'Claude Code', `${version}; internals last checked on ${cc.PROBED_VERSION} (run without --quick to check them)`) };
  }
  const bin = cc.locateBinary({ env });
  if (!bin) return { check: check('claude', 'info', 'Claude Code', `${version}; the binary was not found to check its internals`) };
  let results;
  try { results = cc.probe(fs.readFileSync(bin)); } catch (e) { return { check: check('claude', 'info', 'Claude Code', `${version}; internals not checked (${e.message})`) }; }
  const missing = results.filter(r => !r.ok).map(r => r.id);
  if (!missing.length) return { check: check('claude', 'pass', 'Claude Code', `${version}; all ${results.length} internals sub-human relies on are present`), probe: { total: results.length, missing } };
  return {
    check: check('claude', 'warn', 'Claude Code', `${version}; ${missing.length} of ${results.length} internals changed since ${cc.PROBED_VERSION}: ${missing.join(', ')}`,
      'update sub-human (/plugin update sub-human); if it persists, report it with sub-human doctor --bundle'),
    probe: { total: results.length, missing },
  };
}

function settingsFiles(env) {
  const cc = lib('cc.js');
  return cc.userSettingsFiles(process.cwd(), env).map(f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }).filter(Boolean);
}

function checkHooks(settings) {
  if (settings.some(s => s.disableAllHooks === true)) {
    return check('hooks', 'fail', 'hooks', 'a settings file sets disableAllHooks: sub-human\'s hooks and hooks module never run', 'remove disableAllHooks from your Claude Code settings');
  }
  return check('hooks', 'pass', 'hooks', 'no settings file turns hooks off');
}

function checkRemoteControl(env, settings) {
  const seen = [];
  for (const [k, what] of Object.entries(NO_REMOTE_CONTROL)) {
    if (truthy(env[k]) || settings.some(s => s.env && truthy(s.env[k]))) seen.push(what);
  }
  if (settings.some(s => typeof s.apiKeyHelper === 'string' && s.apiKeyHelper)) seen.push('an apiKeyHelper');
  if (!seen.length) return check('remote_control', 'info', 'Remote Control', 'likely available (needs a claude.ai login): the phone drives your session, room cards included');
  return check('remote_control', 'warn', 'Remote Control', `likely unavailable: Claude Code here uses ${[...new Set(seen)].join(', ')}; Remote Control (the phone) needs a claude.ai subscription login`,
    'nothing to fix for the room itself; to use the phone, log in with a claude.ai account');
}

// ---------- the report ----------
async function diagnose({ quick = false, timeoutMs = DOCTOR_HELLO_MS, authorizedKeys, env = process.env } = {}) {
  const checks = [checkPlugin(), checkNode(), checkHome()];
  const akFile = authorizedKeys || path.join(os.homedir(), '.ssh', 'authorized_keys');
  const scan = scanAuthorizedKeys(akFile);
  const codes = lib('room/links.js').list();
  const sshLinks = codes.some(c => ((lib('room/links.js').get(c) || {}).transport || {}).kind === 'ssh');
  checks.push(checkShim({ needed: scan.lines.some(l => l.shimmed) }));
  checks.push(checkAuthorizedKeys(scan));
  const sshV = sshVersion();
  checks.push(checkSsh({ needed: sshLinks, version: sshV }));
  const links = await Promise.all(codes.map(code => diagnoseLink(code, { quick, timeoutMs, env })));
  if (!codes.length) checks.push(check('links', 'info', 'links', 'no links: every room this machine is in is hosted here'));
  for (const d of links) checks.push(...linkChecks(d));
  const cv = claudeVersion(env);
  const cl = checkClaude({ version: cv, quick, env });
  checks.push(cl.check);
  const settings = settingsFiles(env);
  checks.push(checkHooks(settings), checkRemoteControl(env, settings));
  checks.push(...checkListener({ quick }));
  return {
    generated_at: new Date().toISOString(),
    versions: { plugin: pluginVersion(), node: process.versions.node, claude: cv, protocol: lib('remote/protocol.js').PROTO, ssh: sshV, platform: process.platform, arch: process.arch, os: os.release() },
    checks, links, authorizedKeys: scan, probe: cl.probe || null,
  };
}

const MARK = { pass: '✓', warn: '!', fail: '✗', info: '·' };
const PAINT = { pass: '32', warn: '33', fail: '31', info: '2' };

function format(report, { color = false } = {}) {
  const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const v = report.versions;
  const lines = [`sub-human doctor · plugin ${v.plugin} · node v${v.node} · claude ${v.claude || '?'} · ${v.platform} ${v.arch}`];
  const w = Math.max(...report.checks.map(x => x.title.length));
  for (const x of report.checks) {
    lines.push(`${c(PAINT[x.status], MARK[x.status])} ${x.title.padEnd(w)}  ${x.detail}`);
    if (x.fix) for (const f of String(x.fix).split('\n')) lines.push(`  ${' '.repeat(w)}  ${c('36', `fix: ${f}`)}`);
  }
  const n = s => report.checks.filter(x => x.status === s).length;
  lines.push(`${n('fail')} failed, ${n('warn')} warnings · sub-human doctor --bundle writes a redacted copy for a bug report`);
  return lines.join('\n') + '\n';
}

// ---------- redaction ----------
const hash8 = (s, salt) => crypto.createHash('sha256').update(`${salt}:${s}`).digest('hex').slice(0, 8);
const KEY_RE = /\b(ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp\d+|sk-(?:ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) ([A-Za-z0-9+/]{16,}={0,3})/g;
function fingerprint(b64) {
  try { return 'SHA256:' + crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64').replace(/=+$/, '').slice(0, 12); } catch { return 'SHA256:?'; }
}

function redactor({ home = os.homedir(), hosts = [], users = [], rooms = [], members = [], salt = crypto.randomBytes(8).toString('hex') } = {}) {
  const homes = [...new Set([home, (() => { try { return fs.realpathSync(home); } catch { return home; } })()].filter(h => h && h !== '/'))].sort((a, b) => b.length - a.length);
  const names = [...new Set([...hosts, os.hostname(), os.hostname().split('.')[0]].filter(h => h && h.length > 2 && h !== 'localhost'))].sort((a, b) => b.length - a.length);
  const people = [...new Set([...users, (() => { try { return os.userInfo().username; } catch { return ''; } })()].filter(u => u && u.length > 2))];
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text => {
    let s = String(text == null ? '' : text).replace(/\x1b\[[0-9;]*m/g, '');
    s = s.replace(KEY_RE, (_, type, b64) => `${type} ${fingerprint(b64)}`);
    s = s.replace(/\bsh\d\.[A-Za-z0-9._~:-]+/g, 'sh1.<invite>');
    for (const h of homes) s = s.replace(new RegExp(`${esc(h)}(?![^/\\s"':,)])`, 'g'), '~');
    s = s.replace(/\/(Users|home)\/[^/\s"']+/g, '/$1/<user>');
    for (const n of names) s = s.replace(new RegExp(`(?<![\\w.-])${esc(n)}(?![\\w-])`, 'g'), `host-${hash8(n, salt)}`);
    for (const u of people) s = s.replace(new RegExp(`(?<![\\w.-])${esc(u)}(?=@)`, 'g'), `user-${hash8(u, salt)}`);
    for (const r of rooms) s = s.replace(new RegExp(`(?<![\\w-])${esc(r)}(?![\\w-])`, 'g'), `room-${hash8(r, salt)}`);
    for (const m of members) s = s.replace(new RegExp(`(?<![\\w.-])${esc(m)}(?![\\w-])`, 'g'), `member-${hash8(m, salt)}`);
    // any other user@host (an email, an ssh destination this machine has no link to)
    s = s.replace(/(?<![\w.-])([A-Za-z0-9_.+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g, (m, u, h) => `user-${hash8(u, salt)}@host-${hash8(h, salt)}`);
    s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, m => `ip-${hash8(m, salt)}`);
    s = s.replace(/\b[0-9a-f]{16,}\b/gi, '<hex>');
    s = s.replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/g, '<secret>');
    s = s.replace(/\b(token|secret|password|passwd|authorization|bearer)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1$2<redacted>');
    return s;
  };
}

/** The report as an allowlist: versions, config, check verdicts, link states and recent errors; no message text. */
function bundle(report, { salt, env = process.env } = {}) {
  const links = report.links || [];
  const s = salt || crypto.randomBytes(8).toString('hex'); // per bundle: names hash the same within it, never across
  const red = redactor({
    salt: s,
    hosts: [...links.map(d => d.transport.host), ...webHosts()].filter(Boolean),
    users: links.map(d => d.transport.user).filter(Boolean),
    rooms: [...links.map(d => d.code), ...webRooms()],
    members: links.map(d => d.moved && d.moved.host).filter(m => m && m.length > 1),
  });
  const config = lib('config.js');
  const timings = Object.fromEntries(Object.entries(config).filter(([k, v]) => /^[A-Z][A-Z0-9_]+$/.test(k) && (typeof v === 'number' || typeof v === 'boolean')));
  const overrides = Object.fromEntries(Object.entries(env).filter(([k]) => config.TIMING_ENV_RE.test(k)).map(([k, v]) => [k, Number(v)]));
  const opt = x => (x === undefined || x === null ? undefined : x);
  return {
    kind: 'sub-human-doctor-bundle', format: 1, generated_at: report.generated_at,
    note: 'redacted: no messages, keys, tokens or invites; paths under $HOME are ~, host and user names hashed',
    versions: { ...report.versions, os: red(report.versions.os), ssh: red(report.versions.ssh || '') || null },
    config: { timings, env_overrides: overrides, ssh_opts_set: !!env.SUB_HUMAN_SSH_OPTS, home_is_default: !env.SUB_HUMAN_HOME },
    checks: report.checks.map(x => ({ id: red(x.id), status: x.status, title: red(x.title), detail: red(x.detail), ...(x.fix ? { fix: red(x.fix) } : {}) })),
    links: links.map(d => ({
      room: `room-${hash8(d.code, s)}`,
      transport: { kind: d.transport.kind, host: d.transport.host ? `host-${hash8(d.transport.host, s)}` : undefined, user: d.transport.user ? `user-${hash8(d.transport.user, s)}` : undefined, port: opt(d.transport.port) },
      credential: d.credential,
      moved: d.moved ? { epoch: d.moved.epoch, demoted: d.moved.demoted, reached: d.moved.reached } : undefined,
      daemon: { running: d.daemon.running },
      state: { state: d.state.state, since: opt(d.state.since), attempt: opt(d.state.attempt), rttMs: opt(d.state.rttMs), queued: opt(d.state.queued), lastError: d.state.lastError ? red(d.state.lastError) : undefined, source: d.state.source },
      reach: d.reach ? { ok: d.reach.ok, ms: d.reach.ms, skipped: d.reach.skipped, error: d.reach.error ? red(d.reach.error) : undefined, protocol: d.reach.protocol, skewMs: d.reach.skewMs, ssh_error: d.reach.stderr ? red(d.reach.stderr).split('\n').slice(-3) : undefined } : undefined,
      recent_errors: d.recent.map(red),
    })),
    authorized_keys: {
      exists: report.authorizedKeys.exists,
      lines: report.authorizedKeys.lines.map(l => ({ through_shim: !!l.shimmed, parsed: l.parse !== false, key: l.key ? `${l.type} ${fingerprint(l.key)}` : undefined })),
    },
    probe: report.probe,
  };
}

const webRooms = () => { try { return Object.keys(lib('remote/listener.js').status().rooms || {}); } catch { return []; } };
/** The hostnames of the rooms this machine serves over the web (a ts.net name is redacted like a link's host). */
function webHosts() {
  try {
    return Object.values(lib('remote/listener.js').status().rooms || {}).map(r => { try { return new URL(r.url).hostname; } catch { return null; } });
  } catch { return []; }
}

// ---------- CLI ----------
function parseArgs(args) {
  const o = { quick: false, fix: false, json: false, bundle: null, authorizedKeys: undefined, timeoutMs: DOCTOR_HELLO_MS };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--quick') o.quick = true;
    else if (a === '--fix') o.fix = true;
    else if (a === '--json') o.json = true;
    else if (a === '--bundle') o.bundle = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : '';
    else if (a === '--authorized-keys') o.authorizedKeys = args[++i];
    else if (a === '--timeout') o.timeoutMs = Number(args[++i]);
    else throw new Error(`usage: sub-human doctor [--quick] [--fix] [--json] [--bundle [FILE]] [--authorized-keys FILE] [--timeout MS] (not ${a})`);
  }
  if (!(o.timeoutMs > 0)) throw new Error('--timeout needs a number of milliseconds');
  if (o.authorizedKeys === '' || (o.authorizedKeys === undefined && args.includes('--authorized-keys'))) throw new Error('--authorized-keys needs a file');
  return o;
}

function applyFix(write) {
  const h = lib('home.js');
  const done = [];
  if (fs.existsSync(h.home())) {
    const changed = h.repairModes();
    if (changed.length) done.push(`made ${changed.map(d => tilde(d)).join(', ')} 0700`);
    const shim = lib('remote/shim.js');
    const r = shim.refresh({ force: true });
    done.push(r ? `the serve shim and pointer name ${tilde(shim.pluginRoot())} and ${tilde(process.execPath)}` : `the plugin root ${tilde(shim.pluginRoot())} is under a temp dir: the shim was not written`);
  }
  for (const d of done) write(`fixed: ${d}\n`);
}

async function main(args, { write = s => process.stdout.write(s), env = process.env } = {}) {
  const o = parseArgs(args);
  if (o.fix) applyFix(write);
  const report = await diagnose({ quick: o.quick, timeoutMs: o.timeoutMs, authorizedKeys: o.authorizedKeys, env });
  if (o.bundle !== null) {
    const file = path.resolve(o.bundle || `sub-human-doctor-${report.generated_at.replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(bundle(report, { env }), null, 1) + '\n', { mode: 0o600 });
    write(`wrote ${file}: redacted (no messages, keys, tokens or invites; host names hashed). Read it before you attach it.\n`);
  } else if (o.json) {
    write(JSON.stringify(report, null, 1) + '\n');
  } else {
    write(format(report, { color: !!process.stdout.isTTY && !('NO_COLOR' in env) }));
  }
  return report.checks.some(x => x.status === 'fail') ? 1 : 0;
}

module.exports = { diagnose, format, bundle, redactor, helloProbe, checkListener, scanAuthorizedKeys, checkNode, checkRemoteControl, sshHint, main, parseArgs, DOCTOR_HELLO_MS };
