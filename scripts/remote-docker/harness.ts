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
 * Nothing touches this Mac's sshd, ~/.ssh or ~/.sub-human.
 *
 *   node scripts/remote-docker/harness.ts scenarios [--only ID[,ID]] [--out DIR] [--keep]
 *       The multi-machine lab (lab/compose.yml, project sub-human-lab; lab.ts): devbox, devbox-old (the previous release),
 *       joiner-a, joiner-b, toxiproxy, tls-front. Runs scenarios/NN-*.ts in order (README.md lists
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
 * npm run test:remote-docker runs `scenarios` as an opt-in test (skipped without Docker).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { PLUGIN, pluginLib, roomCode } from '../lib/paths.ts';
import { parseJson } from '../lib/io.ts';
import type * as LabMod from './lab.ts';

const require: <M>(id: string) => M = createRequire(import.meta.url);
// loaded on use: the scenarios' controller, and the SVG renderer only the report needs
const labLib = (): typeof LabMod => require('./lab.ts');

interface ShOpts { input?: string, allowFail?: boolean, timeout?: number }
/** One manual-mode joiner (state.json). */
interface Joiner { name: string, home: string, proj: string, env: string }
/** The manual mode's state.json. */
interface ManualState { api: number, sshPort: number, code: string, hostSeat: string, joiners: Joiner[] }
/** One assertion of the run. */
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
const hostCli = <T = Record<string, unknown>>(...args: string[]): T => parseJson<T>(dexec(['node', '/harness/host-cli.ts', ...args]).stdout);
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
// ---------- the manual mode ----------
const manualState = (): ManualState => parseJson<ManualState>(fs.readFileSync(path.join(MANUAL, 'state.json'), 'utf8'));
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
  console.error('usage: harness.ts scenarios [--only ID] [--out DIR] [--keep] | up [--host-seat NAME] [--joiners A,B] | status | say [--to NAME] TEXT | cut | heal | latency MS | down');
  process.exit(2);
}

if (import.meta.main) main().catch((e: unknown) => { console.error(e instanceof Error && e.stack || e); process.exit(1); });
