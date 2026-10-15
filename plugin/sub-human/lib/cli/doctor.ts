/**
 * plugin/sub-human/lib/cli/doctor.ts: `sub-human doctor`, what is wrong with this machine's sub-human and how to fix
 * it, and `doctor --bundle`, the same as redacted JSON to attach to a bug report. Read only, except --fix (the
 * shim refresh, the home's modes, this home's older authorized_keys lines) and the bundle file. scripts/sub-human dispatches here.
 *
 *   sub-human doctor [--quick] [--fix] [--json] [--bundle [FILE]] [--authorized-keys FILE] [--timeout MS]
 *       --quick    skip the slow checks: the hello to each link's host and the Claude Code internals probe
 *       --fix      first refresh the serve shim and pointer (lib/remote/shim.ts refresh), repair the home's
 *                  modes (lib/home.ts repairModes) and rewrite this home's older authorized_keys lines to run the
 *                  shim (shim.migrateLines)
 *       --json     the report as JSON (unredacted: it stays on this machine)
 *       --bundle   write the redacted bundle (default ./sub-human-doctor-<time>.json) and print its path
 *       --authorized-keys   the file to scan (default ~/.ssh/authorized_keys)
 *       --timeout  the hello's deadline per link (default DOCTOR_HELLO_MS, 8 s)
 *   Exit 1 when a check fails, else 0.
 *
 * Checks, each {id, status: pass|warn|fail|info, title, detail, fix?}:
 *   plugin       the plugin's version (plugin.json) and root
 *   node         Node 24.3 or newer
 *   home         the home and its store directories are 0700 and this user's
 *   shim         <home>/bin/serve is the current shim and <home>/bin/current names an existing plugin and node
 *   authorized_keys   sub-human lines that bypass the shim (an older `authorize` baked node and the versioned
 *                plugin path in); fix: `sub-human doctor --fix` (with that line's SUB_HUMAN_HOME) rewrites them
 *   ssh          ssh present (`ssh -V`), when a link or an authorized line needs it
 *   link:CODE    per link: transport, the daemon (running, pid), state (lib/room/link-state.ts), the last error
 *                (the state record, else the daemon's log), and unless --quick a hello to the host without a
 *                credential (the server answers it and nothing else) with a timeout: reachable, round trip, both
 *                sides' protocol versions, and over ssh whether BatchMode works (ssh's own error, classified)
 *   clock:CODE   skew against the host, when its hello reply carries a time (warn 2 min, fail SIG_SKEW_MS)
 *   room-claude:CODE  per open room hosted here: the room's Claude bound and its process live (pass); its last start
 *                failed (spawn_error), or its job started over 90 s ago but never bound its seat (fail, with the job's
 *                state from `claude agents --json --all`, e.g. failed when the bg daemon crashed it)
 *   claude       Claude Code's version against cc.MIN_VERSION and cc.PROBED_VERSION; when it differs from the
 *                probed one, unless --quick, the internals probe (cc.probe, ~3 s)
 *   hooks        settings that turn hooks off (disableAllHooks): the plugin then cannot seat anyone
 *   remote_control   whether Remote Control (the phone) is likely available: it needs a claude.ai login and is
 *                unavailable with Bedrock, Vertex, Foundry or an API key (informational)
 *   listener     the host's web listener (lib/remote/listener.ts status, <home>/listen/state.json): running, its pid
 *                and port, the rooms it serves; a room served with no listener running is a failure
 *   web:CODE     per room served over the web: a room that closed (warn); with Tailscale, unless --quick, that
 *                `tailscale serve status --json` still lists its path (fail when gone), and with Funnel the
 *                certificate-transparency warning (warn: the name is public)
 * A wss/ws link's hello goes over the real transport (the WebSocket and the pinned Noise handshake).
 *
 *   diagnose(opts) -> Promise<Report>   Report = {generated_at, versions, checks, links, authorizedKeys}
 *   format(report, {color}?) -> string
 *   bundle(report, {salt?, env?}?) -> object   allowlisted fields only, every free text through redactor()
 *   redactor({home?, shHome?, hosts?, users?, rooms?, members?, salt?}) -> (text) -> text   ~ for paths under $HOME, <sub-human-home> for SUB_HUMAN_HOME elsewhere; hashed room codes, member names, hostnames, users
 *                and IPs; invites, tokens, long hex and secrets cut; SSH public keys as a SHA256 fingerprint prefix
 *   helloProbe(spec, code, {timeoutMs, env}?) -> Promise<{ok, ms, reply?, error?, stderr?}>
 *   main(args) -> Promise<exitCode>;  parseArgs(args) -> options (lib/cli/args.ts; Error with the usage)
 *   for tests: checkNode(version?), checkRemoteControl(env, settings), checkListener({quick?}), checkRoomClaudes({now?, jobs?}),
 *       scanAuthorizedKeys(file), linkChecks(linkReport) -> [check], sshHint(stderr, {code?, request?, transport?})
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { AuthorizedKeysScan, Check, CheckStatus, DoctorOptions, HelloReply, HelloProbe, KeyLine, LinkReport, LinkStateView, LinkTransportView, Reach, Report } from './types.ts';
import type { Link } from '../room/types.ts';
import type { ProtoRange } from '../remote/types-core.ts';
import type { LinkSpec, Transport } from '../remote/types-rest.ts';
const require = createRequire(import.meta.url);

const LIB = path.join(import.meta.dirname, '..');
const PLUGIN_ROOT = path.join(LIB, '..');
const BIN = path.join(PLUGIN_ROOT, 'scripts', 'sub-human');
/** The modules doctor loads lazily, by their path under lib/. */
interface Libs {
  'text.ts': typeof import('../text.ts');
  'home.ts': typeof import('../home.ts');
  'io.ts': typeof import('../io.ts');
  'cc.ts': typeof import('../cc.ts');
  'config.ts': typeof import('../config.ts');
  'identity.ts': typeof import('../identity.ts');
  'room/links.ts': typeof import('../room/links.ts');
  'room/link-state.ts': typeof import('../room/link-state.ts');
  'room/envelope.ts': typeof import('../room/envelope.ts');
  'remote/shim.ts': typeof import('../remote/shim.ts');
  'remote/protocol.ts': typeof import('../remote/protocol.ts');
  'remote/link.ts': typeof import('../remote/link.ts');
  'remote/listener.ts': typeof import('../remote/listener.ts');
  'remote/tailscale.ts': typeof import('../remote/tailscale.ts');
  'remote/transports/index.ts': typeof import('../remote/transports/index.ts');
  'remote/transports/ssh.ts': typeof import('../remote/transports/ssh.ts');
}
type ListenerStatus = import('../remote/listener.ts').ListenStatus;
/** A Claude Code settings file, as the hooks and Remote Control checks read it. */
interface Settings {
  disableAllHooks?: unknown;
  allowManagedHooksOnly?: unknown;
  apiKeyHelper?: unknown;
  env?: Record<string, unknown>;
}
/** redactor(opts): what to hash, and the salt. */
interface RedactorOptions {
  home?: string;
  shHome?: string;
  hosts?: string[];
  users?: string[];
  rooms?: string[];
  members?: string[];
  salt?: string;
}
const lib = <K extends keyof Libs>(name: K): Libs[K] => require(path.join(LIB, name));
/** A fix only a shell can make: the CLI by its path (no `sub-human` is on PATH; lib/text.ts cliLine). */
const cli = (args: string): string => lib('text.ts').cliLine(args);

/** 24.3: the first 24 that strips TypeScript without an ExperimentalWarning (every hook is .ts). */
const NODE_MIN = [24, 3];
const DOCTOR_HELLO_MS = 8000;
const SKEW_WARN_MS = 2 * 60 * 1000;
const STORE_DIRS = ['rooms', 'sessions', 'links', 'keys', 'bin'];
const NO_REMOTE_CONTROL: Record<string, string> = {
  CLAUDE_CODE_USE_BEDROCK: 'Bedrock', CLAUDE_CODE_USE_VERTEX: 'Vertex', CLAUDE_CODE_USE_FOUNDRY: 'Foundry',
  ANTHROPIC_API_KEY: 'an API key', ANTHROPIC_AUTH_TOKEN: 'an auth token',
};

const check = (id: string, status: CheckStatus, title: string, detail: string, fix?: string): Check => ({ id, status, title, detail, ...(fix ? { fix } : {}) });
const tilde = <P extends string | null | undefined>(p: P, h = os.homedir()): P | string => (p && h && (p === h || p.startsWith(h + path.sep)) ? '~' + p.slice(h.length) : p);
const isExec = (p: string) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };
const readText = (p: string): string | null => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const truthy = (v: unknown) => v !== undefined && v !== '' && v !== '0' && String(v).toLowerCase() !== 'false';

function pluginVersion(): string | null {
  try { return JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version || null; } catch { return null; }
}

// ---------- local checks ----------
function checkPlugin() {
  const v = pluginVersion();
  return check('plugin', v ? 'pass' : 'warn', 'plugin', `sub-human ${v || '(no version in plugin.json)'} at ${tilde(PLUGIN_ROOT)}`);
}

function checkNode(version = process.versions.node) {
  const [major, minor] = String(version).split('.').map(Number);
  const min = NODE_MIN.join('.');
  return major > NODE_MIN[0] || (major === NODE_MIN[0] && minor >= NODE_MIN[1])
    ? check('node', 'pass', 'node', `v${version}`)
    : check('node', 'fail', 'node', `v${version}; sub-human needs Node ${min} or newer`, `install Node ${min}+ (e.g. nvm install ${NODE_MIN[0]}); the hooks run on the node Claude Code finds on PATH`);
}

function checkHome() {
  const h = lib('home.ts').home();
  if (!fs.existsSync(h)) return check('home', 'info', 'sub-human folder', `${tilde(h)} does not exist yet (made at the first join)`);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const bad: string[] = [];
  for (const d of [h, ...STORE_DIRS.map(n => path.join(h, n))]) {
    let st;
    try { st = fs.statSync(d); } catch { continue; }
    if (uid !== null && st.uid !== uid) bad.push(`${tilde(d)} belongs to uid ${st.uid}`);
    else if (st.mode & 0o077) bad.push(`${tilde(d)} is ${(st.mode & 0o777).toString(8)}`);
  }
  if (!bad.length) return check('home', 'pass', 'sub-human folder', `${tilde(h)} and its folders are private (0700)`);
  return check('home', 'fail', 'sub-human folder', bad.join('; '), `${cli('doctor --fix')} in a terminal (or chmod 700 ${bad.map(b => b.split(' ')[0]).join(' ')})`);
}

function checkShim({ needed }: { needed: boolean }): Check {
  const shim = lib('remote/shim.ts');
  const file = shim.shimPath(), ptr = shim.pointerPath();
  if (!fs.existsSync(file) && !fs.existsSync(ptr)) {
    return check('shim', needed ? 'fail' : 'info', 'serve shim', `${tilde(file)} is not there${needed ? ', and authorized_keys names it' : ' (only a host reached over SSH needs it)'}`,
      needed ? 'start Claude Code once on this machine (it writes it), or run ' + cli('doctor --fix') + ' in a terminal' : undefined);
  }
  const problems: string[] = [];
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
      stale ? 'start Claude Code once on this machine (it refreshes it), or run ' + cli('doctor --fix') + ' in a terminal' : undefined);
  }
  return check('shim', 'fail', 'serve shim', problems.join('; '), 'start Claude Code once on this machine (it rewrites it), or run ' + cli('doctor --fix') + ' in a terminal');
}

// command="SUB_HUMAN_HOME=<home> <...> --stdio CODE --link ID",restrict <type> <key> sub-human:CODE:ID
const KEY_LINE_RE = /^command="SUB_HUMAN_HOME=(\S+) (.+?) --stdio (\S+) --link ([0-9a-f]{12})",restrict (\S+) (\S+) sub-human:(\S+):(\S+)\s*$/;

function scanAuthorizedKeys(file: string): AuthorizedKeysScan {
  const text = readText(file);
  if (text === null) return { file, exists: false, lines: [] };
  const lines: KeyLine[] = [];
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

function checkAuthorizedKeys(scan: AuthorizedKeysScan): Check {
  const h = path.resolve(lib('home.ts').home());
  if (!scan.exists) return check('authorized_keys', 'info', 'authorized_keys', `${tilde(scan.file)}: none (this machine hosts no room over SSH)`);
  if (!scan.lines.length) return check('authorized_keys', 'info', 'authorized_keys', `${tilde(scan.file)}: no sub-human lines`);
  const old = scan.lines.filter(l => !l.ok);
  if (!old.length) return check('authorized_keys', 'pass', 'authorized_keys', `${scan.lines.length} sub-human line(s), all through the shim`);
  const fixes = old.map(l => (l.parse === false ? `edit the unreadable sub-human line by hand in ${tilde(scan.file)}`
    : `${l.home === h ? '' : `SUB_HUMAN_HOME=${l.home} `}${cli(`doctor --fix${scan.file === path.join(os.homedir(), '.ssh', 'authorized_keys') ? '' : ` --authorized-keys ${tilde(scan.file)}`}`)}`));
  return check('authorized_keys', 'warn', 'authorized_keys',
    `${old.length} of ${scan.lines.length} sub-human line(s) bypass the shim: they bake in a node and plugin path that break on an update`,
    [...new Set(fixes)].join('\n'));
}

function sshVersion(): string | null {
  const r = spawnSync('ssh', ['-V'], { encoding: 'utf8', timeout: 5000 });
  if (r.error) return null;
  return String(r.stderr || r.stdout || '').trim().split('\n')[0] || 'ssh (unknown version)';
}

function checkSsh({ needed, version }: { needed: boolean; version: string | null }): Check {
  if (version) return check('ssh', 'pass', 'ssh', version);
  return check('ssh', needed ? 'fail' : 'info', 'ssh', 'no ssh on PATH', needed ? 'install OpenSSH: joining over ssh needs it' : undefined);
}

// ---------- links ----------
const lastLogError = (code: string): string[] => {
  let text: string;
  try {
    const file = lib('room/links.ts').logFile(code);
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
 * ssh's own complaint, as a hint (the link's own key the host lets in, `sub-human prime` for an MFA bastion, `--via`
 * for a jump host). link: the link file's {code, request?, transport} when known.
 */
function sshHint(stderr: unknown, link: { code?: string; request?: unknown; transport?: LinkTransportView } = {}): string | null {
  const s = String(stderr || '');
  const code = link.code || 'CODE';
  const t = link.transport || {};
  const newInvite = `ask the host for a new invite (/sub-human invite${t.via ? ` --via ${t.via}` : ''}) and type the line it shows`;
  if (/keyboard-interactive|Verification code|one-time password|Duo two-factor/i.test(s) && !/publickey\)\.?\s*$/i.test(s.trim())) {
    return `the host or a jump host wants an interactive login (MFA): run ${cli(`prime ${code}`)} once in a terminal; the connection then rides that login for hours`;
  }
  if (/Permission denied/i.test(s)) {
    const admit = link.request
      ? `the host has not let this machine in yet; ${newInvite}`
      : 'the host refused this machine\'s key: it was never let in, or the host removed it. ' + newInvite;
    return `${admit}. Behind a bastion with MFA, run ${cli(`prime ${code}`)} in a terminal first`;
  }
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(s)) {
    return t.knownHosts
      ? `the host's ssh key is not the one its invite pinned (a reinstalled or different machine): check with the host, then ${newInvite}`
      : 'the host key is unknown or changed: run `ssh USER@HOST` once by hand to check and accept it, or ' + newInvite + ' (an invite pins the key)';
  }
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(s)) {
    return `the host name does not resolve from here (VPN or tailnet down?)${t.via ? '' : '; if it is only reachable through a jump host, ask the host for an invite with --via JUMP (/sub-human invite --via JUMP)'}`;
  }
  if (/Connection refused/i.test(s)) return 'nothing listens for ssh on that port';
  if (/timed out|Operation timed out/i.test(s)) {
    return `the host does not answer (asleep, offline or firewalled)${t.via ? '' : '; behind a bastion, the invite needs --via JUMP (/sub-human invite --via JUMP)'}`;
  }
  if (/sub-human: no (plugin install|node)/.test(s)) return 'the host found no sub-human plugin or node to run: on the host, start Claude Code once';
  return null;
}

/** The hello a link's daemon would say, without a credential: the server answers it and nothing else. */
function helloProbe(spec: LinkSpec, code: string, { timeoutMs = DOCTOR_HELLO_MS, env = process.env }: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<HelloProbe> {
  const protocol = lib('remote/protocol.ts');
  let cmd: { argv: string[]; env: NodeJS.ProcessEnv } | undefined;
  try {
    if (spec.kind === 'ssh') {
      const extra = String(env.SUB_HUMAN_SSH_OPTS || '').split(/\s+/).filter(Boolean);
      cmd = { argv: lib('remote/transports/ssh.ts').command(spec, code, [...extra, '-o', `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`]), env };
    } else if (spec.kind === 'pipe' && typeof spec.home === 'string') {
      cmd = { argv: [process.execPath, BIN, 'serve', '--stdio', code], env: { ...env, SUB_HUMAN_HOME: spec.home } };
    }
  } catch (e) { return Promise.resolve({ ok: false, ms: 0, error: (e as Error).message }); }
  if (!cmd && (spec.kind === 'wss' || spec.kind === 'ws')) return webHelloProbe(spec, code, { timeoutMs });
  if (!cmd) return Promise.resolve({ ok: false, ms: 0, skipped: true, error: `no reachability check for the ${spec.kind} transport` });
  // v 1: the least this probe needs, so a host before 0.4 (which checks v === 1 and knows no proto) answers too
  const params = { v: 1, proto: protocol.PROTO, client: protocol.PLUGIN_VERSION, caps: {}, machine: lib('home.ts').machineId() };
  const argv = cmd.argv, childEnv = cmd.env;
  return new Promise<HelloProbe>(resolve => {
    const t0 = Date.now();
    let stderr = '', done = false;
    const child = spawn(argv[0], argv.slice(1), { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = (r: Omit<HelloProbe, 'ms'>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.stdin.end(); child.kill(); } catch { /* gone */ }
      resolve({ ms: Date.now() - t0, t0, t1: Date.now(), stderr: stderr.trim().slice(-2000), ...r });
    };
    const timer = setTimeout(() => finish({ ok: false, error: `no answer within ${timeoutMs} ms` }), timeoutMs);
    const dec = protocol.decoder();
    child.stdout.on('data', (chunk: Buffer) => {
      for (const f of dec.push(chunk)) {
        if (f.id !== 1) continue;
        if (f.error) finish({ ok: false, error: `${f.error.code}: ${f.error.message}`, code: f.error.code });
        else finish({ ok: true, reply: f.result as HelloReply }); // the server's JSON, read defensively
      }
    });
    child.stderr.on('data', (d: Buffer) => { stderr += d; });
    child.stdin.on('error', () => { /* the child is gone; its exit says so */ });
    child.on('error', e => finish({ ok: false, error: e.message }));
    child.on('exit', (c, sig) => finish({ ok: false, error: `the ${spec.kind} command exited (${sig || c}) before answering` }));
    child.stdin.write(protocol.encode(protocol.request(1, 'hello', params)));
  });
}

/** A wss/ws link's hello without a credential: the WebSocket, the Noise handshake pinned to the link's key, then hello. */
async function webHelloProbe(spec: LinkSpec, code: string, { timeoutMs = DOCTOR_HELLO_MS } = {}): Promise<HelloProbe> {
  const t0 = Date.now();
  const protocol = lib('remote/protocol.ts');
  let t: Transport | null = null;
  const deadline = new Promise<never>((_, no) => setTimeout(() => no(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs).unref());
  try {
    const tr: Transport = await Promise.race([lib('remote/transports/index.ts').open(spec, { code }), deadline]);
    t = tr;
    const reply = await Promise.race([new Promise<HelloReply | undefined>((ok, no) => {
      tr.onFrame(f => { if (f.id === 1) (f.error ? no(Object.assign(new Error(`${f.error.code}: ${f.error.message}`), { code: f.error.code })) : ok(f.result as HelloReply)); }); // as: the server's JSON, read defensively
      tr.onClose(() => no(new Error('the listener closed before answering')));
      tr.send(protocol.request(1, 'hello', { v: 1, proto: protocol.PROTO, client: protocol.PLUGIN_VERSION, caps: {}, machine: lib('home.ts').machineId() }));
    }), deadline]);
    return { ok: true, ms: Date.now() - t0, t0, t1: Date.now(), reply };
  } catch (e) {
    const err = e as Error & { code?: string };
    return { ok: false, ms: Date.now() - t0, error: err.message, ...(err.code ? { code: err.code } : {}) };
  } finally { if (t) t.close(); }
}

/** The host's web listener and the rooms it serves (lib/remote/listener.ts), with their Tailscale paths. */
function checkListener({ quick = false } = {}): Check[] {
  let st: ListenerStatus;
  try { st = lib('remote/listener.ts').status(); } catch (e) { return [check('listener', 'warn', 'listener', `could not read its state: ${(e as Error).message}`)]; }
  const codes = Object.keys(st.rooms || {});
  if (!codes.length && !st.running) return [check('listener', 'info', 'listener', 'no room is served over the web here (/sub-human invite --web or --url starts it)')];
  const out = [st.running
    ? check('listener', 'pass', 'listener', `running (pid ${st.pid}) on 127.0.0.1:${st.port} · ${codes.length ? `serves ${codes.join(', ')}` : 'serves no room'}${st.conns ? ` · ${st.conns} connection(s)` : ''}`)
    : check('listener', 'fail', 'listener', `not running, but ${codes.join(', ')} ${codes.length === 1 ? 'is' : 'are'} served over the web: joiners cannot reach ${codes.length === 1 ? 'it' : 'them'}`,
      `/sub-human invite --web again in the room (or ${cli('listen --start')} in a terminal); its log: ${tilde(lib('remote/listener.ts').logFile())}`)];
  const ts = lib('remote/tailscale.ts');
  const serveStatus: Record<string, string | null> = {}; // bin -> stdout
  for (const code of codes) {
    const rec = st.rooms[code] || {};
    const id = `web:${code}`;
    if (!lib('remote/listener.ts').roomLive(code)) { out.push(check(id, 'warn', `web ${code}`, 'served over the web, but the room is closed or gone here', `${cli(`invite --stop --room ${code}`)} in a terminal`)); continue; }
    const where = rec.url || rec.path || '?';
    if (!rec.tailscale) { out.push(check(id, 'info', `web ${code}`, `${rec.mode === 'handoff' ? 'moved here by a handoff' : 'through your own front'} at ${where}`)); continue; }
    const kind = rec.tailscale.funnel ? 'funnel' : 'serve';
    if (!quick) {
      const bin = rec.tailscale.bin || ts.bin();
      const key = String(bin); // no tailscale binary: the one entry 'null'
      if (!(key in serveStatus)) {
        const r = bin ? spawnSync(bin, ['serve', 'status', '--json'], { encoding: 'utf8', timeout: 10_000 }) : { status: 1, stdout: '' };
        serveStatus[key] = r.status === 0 ? String(r.stdout || '') : null;
      }
      const text = serveStatus[key];
      if (text === null) out.push(check(id, 'warn', `web ${code}`, `tailscale ${kind} ${rec.tailscale.path}: could not read tailscale serve status`, 'is Tailscale running? tailscale status'));
      else if (!text.includes(rec.tailscale.path)) {
        out.push(check(id, 'fail', `web ${code}`, `tailscale ${kind} has no ${rec.tailscale.path} any more (a reset, or another serve replaced it)`, `/sub-human invite ${rec.tailscale.funnel ? '--public' : '--web'} in the room (it puts the path back)`));
        continue;
      }
    }
    out.push(rec.tailscale.funnel
      ? check(id, 'warn', `web ${code}`, `Tailscale Funnel ${where}${quick ? '' : ' (path present)'}. ${ts.CT_WARNING}`, `/sub-human invite --stop when nobody needs to join from outside the tailnet`)
      : check(id, 'pass', `web ${code}`, `Tailscale Serve (tailnet only) ${where}${quick ? '' : ' (path present)'}`));
  }
  return out;
}

/** The host's clock from a hello reply, when it carries one (ms). */
function replyTime(reply: HelloReply | null): number | null {
  for (const k of ['time', 'now', 'ts', 'at']) {
    const v = reply && reply[k];
    const ms = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

async function diagnoseLink(code: string, { quick, timeoutMs, env }: { quick: boolean; timeoutMs: number; env: NodeJS.ProcessEnv }): Promise<LinkReport> {
  const links = lib('room/links.ts');
  const l: Partial<Link> = links.get(code) || {};
  const spec: LinkSpec | undefined = l.transport;
  const t: LinkTransportView = spec || {}; // what the report shows of it
  let describe = t.kind || '?';
  try { if (spec) describe = lib('remote/transports/index.ts').describe(spec); } catch { /* kind unknown */ }
  let daemon: LinkReport['daemon'] = { running: false };
  try { const s = lib('remote/link.ts').status(code); daemon = { running: !!s.running, pid: s.pid || null }; } catch { /* no mirror */ }
  const st: LinkStateView = lib('room/link-state.ts').read(code) || { state: 'offline' };
  if (st.pid) daemon = { running: lib('io.ts').isAlive(st.pid), pid: st.pid }; // the state record's own pid wins
  const recent = lastLogError(code);
  const out: LinkReport = { code, transport: { kind: t.kind, describe, user: t.user, host: t.host, port: t.port, home: t.home, ...(t.login === true ? { login: true } : {}) },
    credential: l.token ? 'token' : l.enroll ? 'invite PIN (not checked by the host yet)' : l.awaiting ? 'waiting for the host person to let it in' : l.invite ? 'invite (not redeemed yet)' : t.login === true ? 'ssh login (not linked yet)' : 'none', daemon, state: st, recent,
    // an ssh link whose key the new host has not let in yet (a handoff's follower; no secret in it)
    ...(!l.token && typeof l.request === 'string' ? { request: l.request } : {}),
    // the room's host moved (lib/handoff.ts): the link file was re-pointed at the new host; reached once a token came
    moved: l.moved ? { epoch: l.moved.epoch, host: l.moved.host, locator: l.moved.locator, demoted: !!l.moved.demoted, reached: !!l.moved.reached_at } : null };
  if (!quick) {
    const r: HelloProbe = spec ? await helloProbe(spec, code, { timeoutMs, env }) : { ok: false, ms: 0, skipped: true, error: 'the link file names no transport' };
    const reply: HelloReply = r.reply || {};
    const hostTime = replyTime(reply);
    out.reach = {
      ok: r.ok, ms: r.ms, error: r.error, skipped: !!r.skipped, hint: r.ok ? null : (spec && spec.kind === 'ssh' ? (spec.login === true && lib('remote/transports/ssh.ts').loginFailure(r.stderr ?? '', spec, code)) || sshHint(r.stderr, { code, request: l.request, transport: spec }) : null),
      stderr: r.stderr || '',
      protocol: r.ok ? { v: reply.v, proto: reply.proto || null, server: typeof reply.server === 'string' ? reply.server : null } : null,
      skewMs: r.ok && hostTime !== null ? Math.round(hostTime - (r.t0! + r.t1!) / 2) : null, // an answer carries t0 and t1
    };
  }
  return out;
}

function linkChecks(d: LinkReport): Check[] {
  const ls = lib('room/link-state.ts');
  const protocol = lib('remote/protocol.ts');
  const out: Check[] = [];
  const bits: (string | null | undefined)[] = [`${d.transport.describe}`, `daemon ${d.daemon.running ? `running (pid ${d.daemon.pid})` : 'not running'}`, ls.indicator(d.state) || d.state.state];
  if (d.state.rttMs !== undefined) bits.push(`rtt ${d.state.rttMs} ms`);
  const lastError = d.state.lastError || (d.recent.length ? d.recent.at(-1)!.replace(/^\S+ sub-human link \S+: /, '') : null);
  if (lastError && d.state.state !== 'online') bits.push(`last error: ${lastError}`);
  if (d.moved) {
    const where = `${d.moved.host || 'another'}'s machine`;
    bits.push(d.moved.reached ? `the room moved to ${where}; this machine follows it` : `the room moved to ${where}; not reached from here yet`);
  }
  let status: CheckStatus = d.state.state === 'online' ? 'pass' : d.state.state === 'fork' ? 'fail' : 'warn';
  let fix: string | undefined;
  if (d.state.state === 'fork') fix = `this machine's copy no longer matches the host's: run ${cli(`link --reset ${d.code}`)} in a terminal (it copies the room afresh; anything not sent is kept aside)`;
  else if (d.moved && !d.moved.reached && d.state.state !== 'online') {
    const who = d.moved.host || 'its host';
    fix = `${d.request ? `over ssh ${who} has not let this machine in yet. ` : ''}`
      + `Ask ${who} for an invite (/sub-human invite there) and type the line it shows`;
  } else if (d.request && d.state.state !== 'online') fix = 'the host has not let this machine in yet: ask them for an invite (/sub-human invite there) and type the line it shows';
  else if (d.transport.login && /revoked|unknown link token/i.test(lastError || '')) {
    fix = `the host ended this connection: ask them first, then join again over your ssh login: /sub-human join ${d.transport.user}@${d.transport.host}${d.transport.port ? `:${d.transport.port}` : ''} ${d.code}`;
  } else if (/invite (is burnt|was used already|is unknown|expired|no longer works)|handoff invite expired|last try|no longer accepts this link|revoked/i.test(lastError || '')) {
    // the link's invite (or key) is spent: joining again or restarting the daemon would only reuse it
    fix = 'the invite this machine joined with no longer works (used, expired, or too many wrong PINs), or the host ended the connection: ask the host for a new invite (/sub-human invite there) and type the line it shows';
  } else if (/STALE|moved away/.test(lastError || '')) fix = 'the room moved to another host: ask its new host for an invite (/sub-human invite there) and type the line it shows';
  else if (!d.daemon.running && d.state.state !== 'online') fix = 'the connection is not running: type /sub-human in your session to start it again';
  if (d.reach) {
    const r = d.reach;
    const span = (x: ProtoRange | null | undefined) => (x && x.min !== undefined ? (x.min === x.max ? `${x.min}` : `${x.min}-${x.max}`) : '?');
    const local = `${span(protocol.PROTO)} (sub-human ${protocol.PLUGIN_VERSION})`;
    if (r.skipped) bits.push(r.error);
    else if (r.ok) {
      const p: Partial<NonNullable<Reach['protocol']>> = r.protocol || {};
      const host = `${p.proto ? span(p.proto) : p.v} (sub-human ${p.server || 'before 0.4'})`;
      bits.push(`host reachable in ${r.ms} ms; protocol here ${local}, host ${host}, speaking v${p.v}`);
    } else {
      bits.push(`host unreachable: ${r.error}`);
      status = 'fail';
      fix = [r.hint, /PROTOCOL/.test(r.error || '') ? 'the two sides speak different protocol versions: update sub-human on the older side (/plugin update sub-human)' : null, fix].filter(Boolean).join('\n') || fix;
    }
    if (d.transport.kind === 'ssh' && !r.skipped) {
      bits.push(r.ok ? 'ssh logs in without a prompt' : (/Permission denied|Host key/i.test(r.stderr) ? 'ssh cannot log in without a prompt' : ''));
    }
    if (r.ok) {
      const SIG_SKEW_MS = lib('room/envelope.ts').SIG_SKEW_MS;
      if (r.skewMs === null) out.push(check(`clock:${d.code}`, 'info', `clock ${d.code}`, 'skew not measurable: the host\'s hello carries no time'));
      else {
        const abs = Math.abs(r.skewMs);
        const s = abs >= SIG_SKEW_MS ? 'fail' : abs >= SKEW_WARN_MS ? 'warn' : 'pass';
        out.unshift(check(`clock:${d.code}`, s, `clock ${d.code}`, `this machine is ${Math.round(abs / 1000)} s ${r.skewMs > 0 ? 'behind' : 'ahead of'} the host`,
          s === 'pass' ? undefined : 'turn on network time (NTP) on both machines: signed posts older than 10 min are refused'));
      }
    }
  }
  out.unshift(check(`link:${d.code}`, status, `connection ${d.code}`, bits.filter(Boolean).join(' · '), fix));
  return out;
}

// ---------- Claude Code ----------
function claudeVersion(env: NodeJS.ProcessEnv): string | null {
  const r = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 15_000, env });
  if (r.error || r.status !== 0) return null;
  const m = /(\d+\.\d+\.\d+)/.exec(r.stdout || '');
  return m ? m[1] : null;
}

function checkClaude({ version, quick, env }: { version: string | null; quick: boolean; env: NodeJS.ProcessEnv }): { check: Check; probe?: Report['probe'] } {
  const cc = lib('cc.ts');
  if (!version) return { check: check('claude', 'warn', 'Claude Code', 'no `claude` on PATH here', 'install Claude Code, or put it on PATH for this shell') };
  if ((cc.compareVersions(version, cc.MIN_VERSION) ?? 0) < 0) { // null (unreadable) is not older
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
  try { results = cc.probe(fs.readFileSync(bin)); } catch (e) { return { check: check('claude', 'info', 'Claude Code', `${version}; internals not checked (${(e as Error).message})`) }; }
  const missing = results.filter(r => !r.ok).map(r => r.id);
  if (!missing.length) return { check: check('claude', 'pass', 'Claude Code', `${version}; all ${results.length} internals sub-human relies on are present`), probe: { total: results.length, missing } };
  return {
    check: check('claude', 'warn', 'Claude Code', `${version}; ${missing.length} of ${results.length} internals changed since ${cc.PROBED_VERSION}: ${missing.join(', ')}`,
      `update sub-human (/plugin update sub-human); if it persists, report it with ${cli('doctor --bundle')}`),
    probe: { total: results.length, missing },
  };
}

function settingsFiles(env: NodeJS.ProcessEnv): Settings[] {
  const cc = lib('cc.ts');
  return cc.userSettingsFiles(process.cwd(), env).map(f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }).filter(Boolean);
}

function checkHooks(settings: Settings[], env = process.env): Check {
  if (settings.some(s => s.disableAllHooks === true)) {
    return check('hooks', 'fail', 'hooks', 'a settings file sets disableAllHooks: sub-human\'s hooks and hooks module never run', 'remove disableAllHooks from your Claude Code settings');
  }
  if (settings.some(s => s.allowManagedHooksOnly === true)) {
    return check('hooks', 'fail', 'hooks', 'a settings file sets allowManagedHooksOnly: only managed hooks run, so sub-human cannot join a room', 'ask whoever manages this machine\'s Claude Code settings, or remove allowManagedHooksOnly from yours');
  }
  if (lib('cc.ts').modulesSwitch(env) === false) {
    return check('hooks', 'fail', 'hooks', 'Claude Code has plugin hooks modules switched off for now (its saved switch), so sub-human cannot join a room', 'restart claude with network access, which refreshes the switch; if this stays, hooks modules are off for your account');
  }
  return check('hooks', 'pass', 'hooks', 'no settings file turns hooks off; hooks modules are on');
}

function checkRemoteControl(env: NodeJS.ProcessEnv, settings: Settings[]): Check {
  const seen: string[] = [];
  for (const [k, what] of Object.entries(NO_REMOTE_CONTROL)) {
    if (truthy(env[k]) || settings.some(s => s.env && truthy(s.env[k]))) seen.push(what);
  }
  if (settings.some(s => typeof s.apiKeyHelper === 'string' && s.apiKeyHelper)) seen.push('an apiKeyHelper');
  if (!seen.length) return check('remote_control', 'info', 'Remote Control', 'likely available (needs a claude.ai login): the phone drives your session, room cards included');
  return check('remote_control', 'warn', 'Remote Control', `likely unavailable: Claude Code here uses ${[...new Set(seen)].join(', ')}; Remote Control (the phone) needs a claude.ai subscription login`,
    'nothing to fix for the room itself; to use the phone, log in with a claude.ai account');
}

// ---------- the report ----------
const ROOM_CLAUDE_BIND_GRACE_MS = 90_000;

const DAEMON_HINT = 'if Claude Code was upgraded since the bg daemon started, restart the daemon (stop its process; `claude agents` starts a new one)';
const RESTART = (code: string) => `then /sub-human NAME ${code} (in the room) starts it again`;

/**
 * Each open room hosted here: the room's Claude bound here and live is a pass. A fail: its last start failed
 * (spawn_error, e.g. the bg daemon crashed the job before its first turn), or its job was started (more than
 * ROOM_CLAUDE_BIND_GRACE_MS ago) but never bound its seat. The job's state (`claude agents --json --all`) tells the two
 * kinds apart: one that ended crashed, one still running had its /sub-human refused (e.g. "name taken").
 * jobs: the `claude agents` lookup (tests); called only for a job that never bound.
 */
function checkRoomClaudes({ now = Date.now(), jobs = () => lib('cc.ts').jobs({ all: true }) }: { now?: number, jobs?: () => import('../cc.ts').AgentJob[] | null } = {}): Check[] {
  const identity = lib('identity.ts');
  const out: Check[] = [];
  let codes: string[] = [];
  try { codes = identity.openRooms().filter(c => identity.isHost(c)); } catch { return out; }
  for (const code of codes) {
    let o;
    try { o = identity.readMembers(code).claude; } catch { continue; }
    if (!o || o.job === 'pending' || o.stopped_at || o.closing) continue;
    if (!o.job) {
      if (o.spawn_error && !o.left_at) {
        out.push(check(`room-claude:${code}`, 'fail', `room's Claude ${code}`, `its last start failed: ${o.spawn_error}: the room's Claude is not running`,
          `claude agents --all and the bg daemon's log say why; ${DAEMON_HINT}; ${RESTART(code)}`));
      }
      continue;
    }
    const since = Date.parse(o.spawned_at || '') || now;
    const bound = !!o.pid && !o.left_at && (o.machine || identity.machineId()) === identity.machineId();
    if (bound && identity.seatAlive(Object.assign({ name: 'claude' }, o))) {
      out.push(check(`room-claude:${code}`, 'pass', `room's Claude ${code}`, `bound and live: job ${o.job}, pid ${o.pid}`));
      continue;
    }
    if (bound || now - since < ROOM_CLAUDE_BIND_GRACE_MS) continue;
    let state: string | null = null;
    try { state = (jobs() || []).find(j => j.id === o.job)?.state || null; } catch { state = null; }
    const ended = !!state && ['done', 'failed', 'stopped'].includes(state);
    const why = o.spawn_error ? ` (${o.spawn_error})` : '';
    out.push(check(`room-claude:${code}`, 'fail', `room's Claude ${code}`,
      `its job ${o.job} was started ${Math.round((now - since) / 1000)} s ago but never took its seat${state ? `; the job is ${state}` : ''}${why}: the room's Claude is not running`,
      ended
        ? `the job ended before its first turn: claude logs ${o.job} and the bg daemon's log say why; ${DAEMON_HINT}; ${RESTART(code)}`
        : `claude logs ${o.job} shows why its /sub-human was refused; ${DAEMON_HINT}; ${RESTART(code)}`));
  }
  return out;
}

async function diagnose({ quick = false, timeoutMs = DOCTOR_HELLO_MS, authorizedKeys, env = process.env }: { quick?: boolean; timeoutMs?: number; authorizedKeys?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Report> {
  const checks = [checkPlugin(), checkNode(), checkHome()];
  const akFile = authorizedKeys || path.join(os.homedir(), '.ssh', 'authorized_keys');
  const scan = scanAuthorizedKeys(akFile);
  const codes = lib('room/links.ts').list();
  const sshLinks = codes.some(c => lib('room/links.ts').get(c)?.transport?.kind === 'ssh');
  checks.push(checkShim({ needed: scan.lines.some(l => l.shimmed) }));
  checks.push(checkAuthorizedKeys(scan));
  const sshV = sshVersion();
  checks.push(checkSsh({ needed: sshLinks, version: sshV }));
  const links = await Promise.all(codes.map(code => diagnoseLink(code, { quick, timeoutMs, env })));
  if (!codes.length) checks.push(check('links', 'info', 'connections', 'none: every room this machine is in is hosted here'));
  for (const d of links) checks.push(...linkChecks(d));
  checks.push(...checkRoomClaudes());
  const cv = claudeVersion(env);
  const cl = checkClaude({ version: cv, quick, env });
  checks.push(cl.check);
  const settings = settingsFiles(env);
  checks.push(checkHooks(settings, env), checkRemoteControl(env, settings));
  checks.push(...checkListener({ quick }));
  return {
    generated_at: new Date().toISOString(),
    versions: { plugin: pluginVersion(), node: process.versions.node, claude: cv, protocol: lib('remote/protocol.ts').PROTO, ssh: sshV, platform: process.platform, arch: process.arch, os: os.release() },
    checks, links, authorizedKeys: scan, probe: cl.probe || null,
  };
}

const MARK: Record<CheckStatus, string> = { pass: '✓', warn: '!', fail: '✗', info: '·' };
const PAINT: Record<CheckStatus, string> = { pass: '32', warn: '33', fail: '31', info: '2' };

function format(report: Report, { color = false } = {}): string {
  const c = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const v = report.versions;
  const lines = [`checks · sub-human ${v.plugin} · node v${v.node} · claude ${v.claude || '?'} · ${v.platform} ${v.arch}`];
  const w = Math.max(...report.checks.map(x => x.title.length));
  for (const x of report.checks) {
    lines.push(`${c(PAINT[x.status], MARK[x.status])} ${x.title.padEnd(w)}  ${x.detail}`);
    if (x.fix) for (const f of String(x.fix).split('\n')) lines.push(`  ${' '.repeat(w)}  ${c('36', `fix: ${f}`)}`);
  }
  const n = (s: CheckStatus) => report.checks.filter(x => x.status === s).length;
  lines.push(`${n('fail')} failed, ${n('warn')} warnings${n('fail') + n('warn') ? ' · a fix line says what to do' : ''} · for a bug report: ${cli('doctor --bundle')} in a terminal (a redacted copy)`);
  return lines.join('\n') + '\n';
}

// ---------- redaction ----------
const hash8 = (s: string, salt: string) => crypto.createHash('sha256').update(`${salt}:${s}`).digest('hex').slice(0, 8);
const KEY_RE = /\b(ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp\d+|sk-(?:ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) ([A-Za-z0-9+/]{16,}={0,3})/g;
function fingerprint(b64: string): string {
  try { return 'SHA256:' + crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64').replace(/=+$/, '').slice(0, 12); } catch { return 'SHA256:?'; }
}

function redactor({ home = os.homedir(), shHome = lib('home.ts').home(), hosts = [], users = [], rooms = [], members = [], salt = crypto.randomBytes(8).toString('hex') }: RedactorOptions = {}): (text: unknown) => string {
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
  const homes = [...new Set([home, real(home)].filter(h => h && h !== '/'))].sort((a, b) => b.length - a.length);
  // a SUB_HUMAN_HOME outside $HOME (a temp dir, another disk) names nothing under ~: it is <sub-human-home>
  const under = (p: string) => homes.some(h => p === h || p.startsWith(h + '/'));
  const shHomes = [...new Set([shHome, real(shHome)].filter(h => h && h !== '/' && !under(h)))].sort((a, b) => b.length - a.length);
  const names = [...new Set([...hosts, os.hostname(), os.hostname().split('.')[0]].filter(h => h && h.length > 2 && h !== 'localhost'))].sort((a, b) => b.length - a.length);
  const people = [...new Set([...users, (() => { try { return os.userInfo().username; } catch { return ''; } })()].filter(u => u && u.length > 2))];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text => {
    let s = String(text == null ? '' : text).replace(/\x1b\[[0-9;]*m/g, '');
    s = s.replace(KEY_RE, (_: string, type: string, b64: string) => `${type} ${fingerprint(b64)}`);
    s = s.replace(/\bsh\d\.[A-Za-z0-9._~:-]+/g, 'sh1.<invite>');
    // an invite's PIN is its whole secret (join DEST ROOM 4829; a promote's sh2 PIN has 6 digits): any lone 4- or
    // 6-digit number goes
    s = s.replace(/(?<![\w.:/-])(?:\d{4}|\d{6})(?![\w.:/-])/g, '<pin>');
    for (const h of shHomes) s = s.replace(new RegExp(`${esc(h)}(?![^/\\s"':,)])`, 'g'), '<sub-human-home>');
    for (const h of homes) s = s.replace(new RegExp(`${esc(h)}(?![^/\\s"':,)])`, 'g'), '~');
    // a pipe link names another home on this machine: never its path
    s = s.replace(/\bpipe([: ])(\/[^\s"'),]+)/g, (_: string, sep: string, p: string) => `pipe${sep}<home-${hash8(p, salt)}>`);
    s = s.replace(/\/(Users|home)\/[^/\s"']+/g, '/$1/<user>');
    for (const n of names) s = s.replace(new RegExp(`(?<![\\w.-])${esc(n)}(?![\\w-])`, 'g'), `host-${hash8(n, salt)}`);
    for (const u of people) s = s.replace(new RegExp(`(?<![\\w.-])${esc(u)}(?=@)`, 'g'), `user-${hash8(u, salt)}`);
    for (const r of rooms) s = s.replace(new RegExp(`(?<![\\w-])${esc(r)}(?![\\w-])`, 'g'), `room-${hash8(r, salt)}`);
    for (const m of members) s = s.replace(new RegExp(`(?<![\\w.-])${esc(m)}(?![\\w-])`, 'g'), `member-${hash8(m, salt)}`);
    // any other user@host (an email, an ssh destination this machine has no link to)
    s = s.replace(/(?<![\w.-])([A-Za-z0-9_.+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g, (m: string, u: string, h: string) => `user-${hash8(u, salt)}@host-${hash8(h, salt)}`);
    s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, m => `ip-${hash8(m, salt)}`);
    s = s.replace(/\b[0-9a-f]{16,}\b/gi, '<hex>');
    s = s.replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/g, '<secret>');
    s = s.replace(/\b(token|secret|password|passwd|authorization|bearer)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1$2<redacted>');
    return s;
  };
}

/** The report as an allowlist: versions, config, check verdicts, link states and recent errors; no message text. */
function bundle(report: Report, { salt, env = process.env }: { salt?: string; env?: NodeJS.ProcessEnv } = {}) {
  const links = report.links || [];
  const s = salt || crypto.randomBytes(8).toString('hex'); // per bundle: names hash the same within it, never across
  const red = redactor({
    salt: s,
    hosts: [...links.map(d => d.transport.host), ...webHosts()].filter((h): h is string => !!h),
    users: links.map(d => d.transport.user).filter((u): u is string => !!u),
    rooms: [...links.map(d => d.code), ...webRooms()],
    members: links.map(d => d.moved && d.moved.host).filter((m): m is string => !!m && m.length > 1),
  });
  const config = lib('config.ts');
  const timings = Object.fromEntries(Object.entries(config).filter(([k, v]) => /^[A-Z][A-Z0-9_]+$/.test(k) && (typeof v === 'number' || typeof v === 'boolean')));
  const overrides = Object.fromEntries(Object.entries(env).filter(([k]) => config.TIMING_ENV_RE.test(k)).map(([k, v]) => [k, Number(v)]));
  const opt = <T>(x: T): T | undefined => (x === undefined || x === null ? undefined : x);
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

const webRooms = () => { try { return Object.keys(lib('remote/listener.ts').status().rooms || {}); } catch { return []; } };
/** The hostnames of the rooms this machine serves over the web (a ts.net name is redacted like a link's host). */
function webHosts(): (string | null)[] {
  try {
    const rooms: ListenerStatus['rooms'] = lib('remote/listener.ts').status().rooms || {};
    return Object.values(rooms).map(r => { try { return new URL(r.url ?? '').hostname; } catch { return null; } });
  } catch { return []; }
}

// ---------- CLI ----------
function parseArgs(args: readonly string[]): DoctorOptions {
  const { parse }: typeof import('./args.ts') = require('./args.ts');
  const { flags: f, rest, error } = parse(args, { quick: 0, fix: 0, json: 0, bundle: '?', 'authorized-keys': 1, timeout: 1 });
  if (rest.length) throw new Error(`usage: sub-human doctor [--quick] [--fix] [--json] [--bundle [FILE]] [--authorized-keys FILE] [--timeout MS] (not ${rest[0]})`);
  if (error && /^--timeout/.test(error)) throw new Error('--timeout needs a number of milliseconds');
  if (error || f['authorized-keys'] === '') throw new Error('--authorized-keys needs a file');
  const o: DoctorOptions = {
    quick: !!f.quick, fix: !!f.fix, json: !!f.json, bundle: f.bundle === undefined ? null : f.bundle === true ? '' : f.bundle,
    authorizedKeys: f['authorized-keys'], timeoutMs: f.timeout === undefined ? DOCTOR_HELLO_MS : Number(f.timeout),
  };
  if (!(o.timeoutMs > 0)) throw new Error('--timeout needs a number of milliseconds');
  return o;
}

function applyFix(write: (s: string) => void, { authorizedKeys }: { authorizedKeys?: string } = {}) {
  const h = lib('home.ts');
  const done: string[] = [];
  if (fs.existsSync(h.home())) {
    const changed = h.repairModes();
    if (changed.length) done.push(`made ${changed.map(d => tilde(d)).join(', ')} 0700`);
    const shim = lib('remote/shim.ts');
    const r = shim.refresh({ force: true });
    done.push(r ? `the serve shim and pointer name ${tilde(shim.pluginRoot())} and ${tilde(process.execPath)}` : `the plugin root ${tilde(shim.pluginRoot())} is under a temp dir: the shim was not written`);
    // this home's older authorized_keys lines (node and the versioned plugin path baked in) run the shim instead
    const file = authorizedKeys || path.join(os.homedir(), '.ssh', 'authorized_keys');
    let text: string | null = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch { /* none */ }
    const mig = text === null ? null : shim.migrateLines(text, h.home());
    if (mig && mig.migrated) {
      lib('io.ts').writeFileAtomic(fs.realpathSync(file), mig.text);
      done.push(`rewrote ${mig.migrated} older sub-human line(s) in ${tilde(file)} to run ${tilde(shim.shimPath())}`);
    }
  }
  for (const d of done) write(`fixed: ${d}\n`);
}

async function main(args: readonly string[], { write = (s: string) => { process.stdout.write(s); }, env = process.env }: { write?: (s: string) => void; env?: NodeJS.ProcessEnv } = {}): Promise<number> {
  const o = parseArgs(args);
  if (o.fix) applyFix(write, { authorizedKeys: o.authorizedKeys });
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

export {
  diagnose, format, bundle, redactor, helloProbe, checkListener, checkRoomClaudes, linkChecks, scanAuthorizedKeys,
  checkNode, checkRemoteControl, sshHint, main, parseArgs, DOCTOR_HELLO_MS,
};
