#!/usr/bin/env node
/**
 * scripts/remote-docker/harness.ts: remote rooms over real SSH, against a second machine faked with Docker.
 *
 *   devbox (container)   sshd + the host room in /home/host/.sub-human: alice (a sleeper seat; up names it), the room Claude's
 *                        `claude` a stub. scripts/remote-docker/host-cli.ts drives its hooks.
 *   toxiproxy            in front of devbox:22, published on 127.0.0.1 (a port Docker picks): cut the link, add
 *                        latency.
 *   joiner (this Mac)    a temp SUB_HUMAN_HOME; bob joins with the real hooks as child processes
 *                        (plugin test/support/two-homes.ts); his link daemon runs `ssh` with a throwaway key
 *                        (SUB_HUMAN_SSH_OPTS: -F /dev/null, -i, a temp known_hosts) through toxiproxy into devbox.
 * Nothing touches this Mac's sshd, ~/.ssh or ~/.sub-human. No real Claude runs in `run`.
 *
 *   node scripts/remote-docker/harness.ts run [--out DIR]
 *       NOT PORTED (Stage 7): it linked with an sh1 invite, which is gone; it exits 2 saying so. It was: build, start,
 *       join, check the anti-fallback assertions, tear everything down. The evidence bundle
 *       (transcript.log, REPORT.md, report.html, transcript.svg, report.png when Chrome is installed, compose
 *       ps/logs, toxiproxy state) goes to DIR, default /tmp/sub-human-remote-proof-<timestamp>. Invite secrets
 *       and link tokens are redacted in every file. Exit 0 only when every assertion passed.
 *   node scripts/remote-docker/harness.ts scenarios [--only ID[,ID]] [--out DIR] [--keep]
 *       The multi-machine lab (lab/compose.yml, project sub-human-lab; lab.ts): devbox, devbox-old (0.5.0-beta.15), bastion,
 *       joiner-a, joiner-b, toxiproxy, corp-proxy, tls-front. Runs scenarios/NN-*.ts in order (README.md lists
 *       them), each from a clean reset, and writes per-scenario evidence (transcript, logs and their hashes,
 *       timings, summary.json) to DIR, default /tmp/sub-human-lab-<time>/. A scenario whose feature is not in the
 *       plugin yet is PENDING. Exit 0 unless one FAILED. --keep leaves the stack up afterwards.
 *   node scripts/remote-docker/harness.ts up [--host-seat NAME] [--joiners A,B] | status | say [--to NAME] TEXT |
 *       cut | heal | latency MS | down
 *       The manual mode, for real Claudes on this Mac: up starts devbox + toxiproxy with the room and the host's
 *       scripted seat (--host-seat, default alice). For each joiner (--joiners, default bob) it makes a throwaway
 *       key that logs in to the devbox account (a login join: no invite), and creates under
 *       /tmp/sub-human-remote-manual a home NAME-home (0700), a git project NAME-proj and NAME.env (0600:
 *       SUB_HUMAN_HOME, SUB_HUMAN_SSH_OPTS). Source it, cd to the project, start
 *       `claude --plugin-dir plugin/sub-human --remote-control` and type the /sub-human join line NAME.env names.
 *       say posts as the host seat (signed, the host's hook path); --to NAME addresses a post from the seat's
 *       Claude. status shows every joiner's link. cut/heal disable/enable the proxy; latency adds (MS > 0) or removes
 *       (0) a latency toxic. down stops it all and removes the manual state, every joiner's home, project, env and
 *       link daemon. With LAB_PROJECT set, down takes down only that scenarios stack (lab.ts) and leaves the manual
 *       stack and its directory alone.
 * SUB_HUMAN_COMPOSE_PROJECT (default: compose.yml's sub-human-remote) and SUB_HUMAN_MANUAL_DIR (default
 * /tmp/sub-human-remote-manual) let a second stack run beside the default one; set both the same for every command.
 * npm run test:remote-docker runs `run` as an opt-in test (skipped without Docker).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { PLUGIN, pluginLib, roomCode } from '../lib/paths.ts';

const require = createRequire(import.meta.url);
// loaded on use: the scenarios' controller, and the SVG renderer only the report needs
const labLib = (): typeof import('./lab.ts') => require('./lab.ts');
const ansiSvg = (): typeof import('../ansi-svg.ts') => require('../ansi-svg.ts');

interface ShOpts { input?: string, allowFail?: boolean, timeout?: number }
/** One manual-mode joiner (state.json). */
interface Joiner { name: string, home: string, proj: string, env: string }
/** The manual mode's state.json. */
interface ManualState { api: number, sshPort: number, code: string, hostSeat: string, joiners: Joiner[] }
/** One assertion of the run. */
interface Result { n: number, title: string, pass: boolean, detail: unknown }
/** The run's measurements (report). */
interface Metrics {
  latency?: { base: number[], slow: number[] }; offlineMs?: number; reconnectMs?: number;
  bytes?: { rx: number, tx: number, packets: number }; hashes?: { host: string, mirror: string, lines: number };
}

const DIR = import.meta.dirname;
const COMPOSE = path.join(DIR, 'compose.yml');
const HOST_HOME = '/home/host/.sub-human';
const MANUAL = process.env.SUB_HUMAN_MANUAL_DIR || '/tmp/sub-human-remote-manual';
// SUB_HUMAN_COMPOSE_PROJECT runs a second stack beside the default one (compose.yml names it sub-human-remote).
const PROJECT = process.env.SUB_HUMAN_COMPOSE_PROJECT ? ['-p', process.env.SUB_HUMAN_COMPOSE_PROJECT] : [];
const PROXY = 'ssh';
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// ---------- docker ----------
function sh(cmd: string, args: string[], { input, allowFail = false, timeout = 600_000 }: ShOpts = {}): SpawnSyncReturns<string> {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', timeout, maxBuffer: 64 << 20 });
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${r.stderr || r.error}`);
  return r;
}
const dc = (args: string[], o?: ShOpts): SpawnSyncReturns<string> => sh('docker', ['compose', '-f', COMPOSE, ...PROJECT, ...args], o);
const dexec = (args: string[], { user = 'host', ...o }: ShOpts & { user?: string } = {}): SpawnSyncReturns<string> => dc(['exec', '-T', '-u', user, '-e', `SUB_HUMAN_HOME=${HOST_HOME}`, 'devbox', ...args], o);
const hostCli = <T = Record<string, unknown>>(...args: string[]): T => JSON.parse(dexec(['node', '/harness/host-cli.ts', ...args]).stdout);
const port = (svc: string, p: number): number => Number(dc(['port', svc, String(p)]).stdout.trim().split(':').pop());

async function toxi(api: number, method: string, p: string, body?: unknown): Promise<unknown> {
  const r = await fetch(`http://127.0.0.1:${api}${p}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  if (!r.ok) throw new Error(`toxiproxy ${method} ${p}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function bringUp(log: (m: string) => void): Promise<{ api: number, sshPort: number }> {
  log('docker compose up -d --build');
  dc(['up', '-d', '--build']);
  for (let i = 0; ; i++) {
    if (dexec(['pgrep', '-x', 'sshd'], { allowFail: true, user: 'root' }).status === 0) break;
    if (i > 100) throw new Error('sshd did not start in devbox');
    await sleep(100);
  }
  const api = port('toxiproxy', 8474), sshPort = port('toxiproxy', 22222);
  for (let i = 0; ; i++) {
    try { await toxi(api, 'GET', '/version'); break; } catch (e) { if (i > 100) throw e; await sleep(100); }
  }
  await toxi(api, 'POST', '/proxies', { name: PROXY, listen: '0.0.0.0:22222', upstream: 'devbox:22', enabled: true });
  return { api, sshPort };
}

function keygen(dir: string, name: string): string {
  const f = path.join(dir, name);
  sh('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `sub-human-harness-${name}`, '-f', f]);
  return f;
}
const sshOpts = (key: string, kh: string): string => ['-F', '/dev/null', '-i', key, '-o', 'IdentitiesOnly=yes', '-o', `UserKnownHostsFile=${kh}`,
  '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', '-o', 'LogLevel=ERROR'].join(' ');

/** Let key.pub log in to the devbox account as an ordinary line (no forced command): a login join. */
function authorizeLogin(pub: string): void {
  dexec(['sh', '-c', 'mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 0600 ~/.ssh/authorized_keys'], { input: fs.readFileSync(pub, 'utf8') });
}

// ---------- evidence ----------
class Evidence {
  dir: string;
  secrets = new Set<string>();
  lines: string[] = [];
  results: Result[] = [];
  metrics: Metrics = {};

  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  secret(s: unknown): void { if (s) this.secrets.add(String(s)); }
  redact(text: unknown): string {
    let t = String(text);
    for (const s of this.secrets) t = t.split(s).join('<redacted>');
    return t.replace(/sh2\.([a-z]+-\d{4})\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]{16,128}/g, 'sh2.$1.$2.<redacted>');
  }
  log(msg: string): void {
    const line = `${new Date().toISOString().slice(11, 23)}  ${this.redact(msg)}`;
    this.lines.push(line);
    process.stdout.write(line + '\n');
    fs.appendFileSync(path.join(this.dir, 'transcript.log'), line.replace(/\x1b\[[0-9;]*m/g, '') + '\n');
  }
  step(title: string): void { this.log(''); this.log(`== ${title}`); }
  raw(label: string, text: unknown): void {
    this.log(`-- ${label}:`);
    for (const l of String(text).replace(/\n$/, '').split('\n')) this.log(`   | ${l}`);
  }
  check(n: number, title: string, pass: unknown, detail: unknown = ''): void {
    this.results.push({ n, title, pass: !!pass, detail });
    this.log(`${pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  A${n}  ${title}${detail ? `  (${detail})` : ''}`);
  }
  write(name: string, text: string): void { fs.writeFileSync(path.join(this.dir, name), this.redact(text)); }
}

const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const timed = <V>(fn: () => V): [V, number] => { const t = process.hrtime.bigint(); const v = fn(); return [v, Number(process.hrtime.bigint() - t) / 1e6]; };
const until = async (fn: () => unknown, ms: number, step = 50): Promise<boolean> => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(step); } return !!(await fn()); };
const pct = (xs: number[], p: number): number | undefined => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const fmt = (ms: number): string => `${Math.round(ms)} ms`;
const realHomeMtime = (): number | null => { try { return fs.statSync(path.join(os.homedir(), '.sub-human')).mtimeMs; } catch { return null; } };
const running = (): string => sh('pgrep', ['-fl', 'sub-human (link|serve)'], { allowFail: true }).stdout.trim();

/** Every file under dir: [{rel, mode, text}]. */
function walk(dir: string): { rel: string, mode: string, dir: boolean, text: string }[] {
  return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort().map(rel => {
    const p = path.join(dir, rel);
    const st = fs.lstatSync(p);
    return { rel, mode: (st.mode & 0o777).toString(8), dir: st.isDirectory(), text: st.isFile() ? fs.readFileSync(p, 'utf8') : '' };
  });
}

// ---------- run: the automated assertions ----------
/**
 * The single-devbox run with this Mac as the joiner (npm run test:remote-docker:mac) linked with an internal sh1 invite
 * and its forced-command key; Stage 7 removed sh1 invites, and the run is not ported to the PIN join yet (the joiner
 * would run the enrollment over ssh into the container and the host's card would let it in, as lab.ts join does).
 * Until then it fails fast, saying so; the scenarios (`harness.ts scenarios`) cover the same ground on the lab.
 */
const NOT_PORTED = 'harness.ts run (npm run test:remote-docker:mac) is not ported to the PIN join yet (Stage 7 removed the sh1 invite it linked with); use `harness.ts scenarios`';
export async function run(_opts?: unknown): Promise<never> { throw new Error(NOT_PORTED); }

async function screenshot(chrome: string, html: string, png: string): Promise<void> {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-chrome-'));
  fs.rmSync(png, { force: true });
  const c = spawn(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${prof}`, `--screenshot=${png}`,
    '--window-size=1400,2600', `file://${html}`], { stdio: 'ignore' });
  const exited = new Promise(r => c.on('exit', r));
  let last = -1;
  await until(async () => { const n = fs.existsSync(png) ? fs.statSync(png).size : -1; const done = n > 0 && n === last; last = n; return done; }, 30_000, 500);
  try { c.kill(); } catch { /* gone */ }
  await Promise.race([exited, sleep(3000)]);
  fs.rmSync(prof, { recursive: true, force: true });
}

async function report(ev: Evidence): Promise<void> {
  const rows = [...ev.results].sort((a, b) => a.n - b.n);
  const allPass = rows.length >= 11 && rows.every(r => r.pass);
  const m = ev.metrics;
  const lat = m.latency || { base: [], slow: [] };
  const md = [
    '# sub-human remote rooms over SSH: harness report',
    '',
    `Run ${new Date().toISOString()} · ${allPass ? '**ALL PASS**' : '**FAILURES**'} · topology: devbox (sshd + host room) ← toxiproxy ← this Mac (joiner, real hooks, link daemon → ssh)`,
    '',
    '| # | Assertion | Result | Evidence |',
    '|---|---|---|---|',
    ...rows.map(r => `| ${r.n || '-'} | ${r.title} | ${r.pass ? 'PASS' : 'FAIL'} | ${String(r.detail).replace(/\|/g, '/')} |`),
    '',
    '## Measurements',
    '',
    `- \`@room\` hook wall time (process spawn to exit), no toxic: ${lat.base.map(fmt).join(', ') || 'n/a'}`,
    `- with a 200 ms latency toxic each way: ${lat.slow.map(fmt).join(', ') || 'n/a'}`,
    `- link offline after the proxy was disabled: ${m.offlineMs !== undefined ? fmt(m.offlineMs) : 'n/a'}; online again after re-enabling: ${m.reconnectMs !== undefined ? fmt(m.reconnectMs) : 'n/a'}`,
    `- bytes on devbox eth0 during one post: ${m.bytes ? `rx ${m.bytes.rx} B, tx ${m.bytes.tx} B, ${m.bytes.packets} packets on port 22` : 'n/a'}`,
    `- after resume: host log sha256 ${m.hashes ? m.hashes.host : 'n/a'} = mirror ${m.hashes ? m.hashes.mirror : 'n/a'} (${m.hashes ? m.hashes.lines : '?'} lines)`,
    '',
    'Files: `transcript.log` (every step with raw evidence), `compose-ps.txt`, `compose-logs.txt`, `toxiproxy-proxies.json`, `devbox-room-files.txt`, `transcript.svg`, `report.html`, `report.png` (when Chrome is installed). Invite secrets and link tokens are redacted.',
    '',
  ].join('\n');
  ev.write('REPORT.md', md);
  try {
    const { render } = ansiSvg();
    const text = ev.lines.join('\n');
    const svg = render(text, { title: 'sub-human remote-docker harness', cols: 160 });
    ev.write('transcript.svg', svg);
    const esc = (s: unknown): string => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const table = rows.map(r => `<tr class="${r.pass ? 'p' : 'f'}"><td>${r.n || '-'}</td><td>${esc(r.title)}</td><td>${r.pass ? 'PASS' : 'FAIL'}</td><td>${esc(r.detail)}</td></tr>`).join('');
    const html = `<!doctype html><meta charset="utf-8"><title>sub-human remote harness</title><style>body{font:14px system-ui;margin:24px;background:#fff;color:#111}
table{border-collapse:collapse;margin:12px 0}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:top}tr.p td:nth-child(3){color:#0a7d2c;font-weight:600}tr.f td:nth-child(3){color:#c00;font-weight:600}
pre{white-space:pre-wrap}</style><h1>sub-human remote rooms over SSH</h1><p>${allPass ? 'ALL PASS' : 'FAILURES'} · ${esc(new Date().toISOString())}</p>
<table><tr><th>#</th><th>Assertion</th><th>Result</th><th>Evidence</th></tr>${table}</table><pre>${esc(md.split('## Measurements')[1] || '')}</pre>${svg}`;
    ev.write('report.html', html);
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(chrome)) await screenshot(chrome, path.join(ev.dir, 'report.html'), path.join(ev.dir, 'report.png'));
  } catch (e) { ev.log(`report rendering: ${e instanceof Error ? e.message : String(e)}`); }
  ev.log(`report: ${path.join(ev.dir, 'REPORT.md')}`);
}

// ---------- the manual mode ----------
const manualState = (): ManualState => JSON.parse(fs.readFileSync(path.join(MANUAL, 'state.json'), 'utf8'));
const opt = (args: string[], flag: string, dflt?: string): string | undefined => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : dflt; };
/** Run fn with SUB_HUMAN_HOME set to a joiner's home (the plugin libs read it on every call). */
const asJoiner = <V>(j: Joiner, fn: () => V): V | null => { process.env.SUB_HUMAN_HOME = j.home; try { return fn(); } catch { return null; } };
const linkOf = (st: ManualState, j: Joiner) => asJoiner(j, () => pluginLib('remote/link-socket.ts').status(roomCode(st.code)));

async function up(args: string[]): Promise<void> {
  if (fs.existsSync(path.join(MANUAL, 'state.json'))) throw new Error(`already up (${MANUAL}); run down first`);
  const hostSeat = opt(args, '--host-seat', 'alice') ?? 'alice';
  const names = (opt(args, '--joiners', 'bob') ?? '').split(',').filter(Boolean);
  if (names.includes(hostSeat) || new Set(names).size !== names.length) throw new Error('joiner names must be distinct and differ from --host-seat');
  fs.mkdirSync(MANUAL, { recursive: true, mode: 0o700 });
  const { api, sshPort } = await bringUp(m => console.log(m));
  const setup = hostCli<{ code: string }>('setup', hostSeat);
  const keys = path.join(MANUAL, 'ssh');
  fs.mkdirSync(keys, { mode: 0o700 });
  const joiners = names.map((name): Joiner => {
    const key = keygen(keys, name);
    authorizeLogin(key + '.pub');
    const j = { name, home: path.join(MANUAL, `${name}-home`), proj: path.join(MANUAL, `${name}-proj`), env: path.join(MANUAL, `${name}.env`) };
    fs.mkdirSync(j.home, { mode: 0o700 });
    fs.mkdirSync(j.proj, { mode: 0o700 });
    sh('git', ['init', '-q', j.proj]);
    const env = [
      `# sub-human remote-docker manual mode, joiner ${name}: source this in the shell you start ${name}'s Claude from.`,
      `# room ${setup.code} in devbox (${hostSeat} is there); your key logs in to host@devbox; ssh via toxiproxy 127.0.0.1:${sshPort}`,
      `export SUB_HUMAN_HOME='${j.home}'`,
      `export SUB_HUMAN_SSH_OPTS='${sshOpts(key, path.join(keys, `${name}.known_hosts`))}'`,
      `# then: cd '${j.proj}' && claude --plugin-dir '${PLUGIN}' --remote-control`,
      `# and type: /sub-human join host@127.0.0.1:${sshPort} ${setup.code} --as ${name}`,
      '',
    ].join('\n');
    fs.writeFileSync(j.env, env, { mode: 0o600 });
    fs.chmodSync(j.env, 0o600);
    return j;
  });
  fs.writeFileSync(path.join(MANUAL, 'state.json'), JSON.stringify({ api, sshPort, code: setup.code, hostSeat, joiners }, null, 2) + '\n', { mode: 0o600 });
  console.log(`up: room ${setup.code}, ${hostSeat} seated in devbox, ssh 127.0.0.1:${sshPort}, toxiproxy api 127.0.0.1:${api}`);
  for (const j of joiners) console.log(`joiner ${j.name}: env (0600) ${j.env}, project ${j.proj}`);
}

async function down(): Promise<void> {
  // LAB_PROJECT names a scenarios stack (lab.ts): take down that one only. Never the manual stack or its directory,
  // which someone may be using by hand (this used to remove both whatever LAB_PROJECT said)
  if (process.env.LAB_PROJECT) {
    const lab = labLib();
    const r = sh('docker', ['compose', '-f', lab.COMPOSE, '-p', lab.PROJECT, 'down', '-v', '--remove-orphans', '-t', '2'], { allowFail: true });
    console.log(`down: lab project ${lab.PROJECT}: compose exit ${r.status} (the manual stack and ${MANUAL} are left alone)`);
    return;
  }
  let st: ManualState | null = null;
  try { st = manualState(); } catch { /* not up, or half up */ }
  if (st) for (const j of st.joiners || []) {
    const s = linkOf(st, j);
    if (s && s.running) try { process.kill(s.pid, 'SIGTERM'); } catch { /* gone */ }
  }
  const r = dc(['down', '-v', '--remove-orphans'], { allowFail: true });
  fs.rmSync(MANUAL, { recursive: true, force: true });
  console.log(`down: compose exit ${r.status}; removed ${MANUAL} (state, keys, every joiner's home, project and env)`);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'run') {
    const i = args.indexOf('--out');
    const out = i >= 0 ? path.resolve(args[i + 1] ?? '') : path.join('/tmp', `sub-human-remote-proof-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    void out;
    console.error(NOT_PORTED);
    process.exit(2);
  }
  if (cmd === 'scenarios') {
    const outArg = opt(args, '--out');
    const out = outArg ? path.resolve(outArg) : path.join('/tmp', `sub-human-lab-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    const { runScenarios } = labLib();
    const { ok, results } = await runScenarios({ out, only: opt(args, '--only'), keep: args.includes('--keep') });
    console.log('');
    for (const r of results) console.log(`${r.status.toUpperCase().padEnd(8)} ${r.id.padEnd(16)} ${Math.round(r.ms / 1000)} s  ${r.reason || r.checks.filter(c => c.status !== 'pass').map(c => `${c.status}: ${c.name}`).join('; ')}`);
    console.log(`\n${ok ? 'SCENARIOS OK' : 'SCENARIOS FAILED'}: evidence in ${out}`);
    process.exit(ok ? 0 : 1);
  }
  if (cmd === 'up') return up(args);
  if (cmd === 'down') return down();
  const st = manualState();
  if (cmd === 'status') {
    const joiners = st.joiners.map(j => ({ ...j, link: linkOf(st, j) }));
    console.log(JSON.stringify({ ...st, joiners, proxy: await toxi(st.api, 'GET', `/proxies/${PROXY}`) }, null, 2));
    return;
  }
  if (cmd === 'say') {
    console.log(JSON.stringify(args[0] === '--to' ? hostCli('to', args[1] ?? '', args.slice(2).join(' ')) : hostCli('say', args.join(' '))));
    return;
  }
  if (cmd === 'cut' || cmd === 'heal') { console.log(JSON.stringify(await toxi(st.api, 'PATCH', `/proxies/${PROXY}`, { enabled: cmd === 'heal' }))); return; }
  if (cmd === 'latency') {
    const ms = Number(args[0]);
    for (const s of ['downstream', 'upstream']) {
      try { await toxi(st.api, 'DELETE', `/proxies/${PROXY}/toxics/lat_${s}`); } catch { /* none */ }
      if (ms > 0) await toxi(st.api, 'POST', `/proxies/${PROXY}/toxics`, { name: `lat_${s}`, type: 'latency', stream: s, attributes: { latency: ms, jitter: 0 } });
    }
    console.log(`latency ${ms} ms each way`);
    return;
  }
  console.error('usage: harness.ts run [--out DIR] | scenarios [--only ID] [--out DIR] [--keep] | up [--host-seat NAME] [--joiners A,B] | status | say [--to NAME] TEXT | cut | heal | latency MS | down');
  process.exit(2);
}

// the single-devbox run's helpers, kept for its port to the PIN join (run above)
export { Evidence, report, timed, pct, realHomeMtime, running, walk, sha };

if (import.meta.main) main().catch((e: unknown) => { console.error(e instanceof Error && e.stack || e); process.exit(1); });
