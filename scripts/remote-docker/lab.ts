/**
 * scripts/remote-docker/lab.ts: the controller of the sub-human lab (lab/compose.yml, project sub-human-lab) and the
 * scenario runner behind `harness.ts scenarios`. README.md has the topology and the scenario list.
 *
 *   new Lab({log})
 *     up()              build (the previous release's image from `git archive OLD_REF` once: 0.5.0-beta.15), start, wait for every sshd and for
 *                       toxiproxy, create the proxies, copy tls-front's CA root to the joiners, probe the features
 *     reset()           between scenarios: unpause, every sub-human process stopped, homes, keys, authorized_keys
 *                       and known_hosts wiped, toxiproxy reset, iptables flushed
 *     down()            compose down -v --remove-orphans
 *     exec(svc, argv, {user, env, input, allowFail, timeout}) -> spawnSync result
 *     seat(svc, {home?}) -> Machine-side driver: host/join/login/short/admitcard/rejoin/say/expand/leave/events/dump/link (lab/seat-cli.ts)
 *     toxi(method, path, body)   the toxiproxy API
 *     keypair(svc, name) -> pubkey      ~/.ssh/NAME (ed25519) for the joiner user
 *     sshConfig(svc, name, hosts)       ~/.ssh/NAME.conf: one Host block per entry, then the shared defaults
 *     restrict(code, linkId, pub, {svc})   the one-link forced-command line an admit wrote before protocol 3, appended
 *                       to the devbox account's authorized_keys (what a key let in for one other connection looks like;
 *                       nothing writes one now)
 *     authorizeLogin(pub, {svc, user?})   the joiner's key as an ordinary login line in the host account's authorized_keys: the
 *                       person's own ssh login, set up as any is (an ssh invite rides it; the plugin writes no line)
 *     hostInvite(hostSeat, name, {dest}) -> {line, word, pin, text}   `/sub-human invite --ssh DEST`:
 *                       the line (protocol 3: its SECRET word; beta.15: word null, the PIN at its end) and the PIN
 *     join(opts) -> Promise<{seat, name, invite, pin, linkId, conf, join, pub}>   a joiner over one ssh path: its own
 *                       login to the host account, invite --ssh on the host's seat, the line typed on the joiner
 *                       (`/sub-human join DEST ROOM SECRET --as NAME`: the host's key checked, the SECRET
 *                       shown), the PIN when the host asks (`/sub-human join PIN`), the host's card (Let in), the link
 *                       online, then a bare `/sub-human` (the seat). Against devbox-old (beta.15) its line has a 4-digit
 *                       PIN and this joiner refuses it (the host must update): {join: {ok: false, out}}; a beta.15 joiner
 *                       refuses this host's line the same way
 *     features             {hostSsh, revoke, heartbeat, outbox, autoRejoin, doctor, ws, urlPin,
 *                          versionRange, loginJoin, shortCode, inviteLine}: what the plugin in /plugin can do (seat-cli.ts probe), overridable with
 *                          LAB_FEATURES=outbox=1,ws=0
 *   runScenarios({out, only, log}) -> {ok, results}   each scenarios/NN-*.ts in order; evidence under out/<id>/
 * Scenario module: {id, title, persona, requires?: [feature], budgetMs?, linkEnv?: {SUB_HUMAN_LINK_*_MS}, run(t)}.
 * Link timings: SUB_HUMAN_LINK_*_MS in the harness's environment reach every machine's seats (hooks, CLI, daemons);
 * a scenario's linkEnv adds its own on top (short timings where it needs them). t = {lab, ev, features, check(name,
 * pass, detail), expect(name, pass, detail, feature) (a miss is pending while the feature is missing, else a
 * failure), bug(name, pass, detail) (a miss is a known plugin bug: status 'bug', fatal only with LAB_STRICT=1),
 * pending(name, reason), sleep, until, metric(k, v)}. A scenario whose requires is not met is pending (not
 * run); LAB_FORCE=id[,id] runs it anyway.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { parseJson } from '../lib/io.ts';

const require: <M>(id: string) => M = createRequire(import.meta.url);

// ---------- what lab/seat-cli.ts prints (one JSON object per command; its shapes, as the scenarios read them) ----------
/** A hook's JSON answer. */
export interface HookJson {
  decision?: string;
  reason?: string;
  systemMessage?: string;
  stopReason?: string;
  continue?: boolean;
  hookSpecificOutput?: { additionalContext?: string, suppressOriginalPrompt?: boolean };
}
/** A command run through a hook: host/login/rejoin/expand/say/prompt/card. */
export interface HookRun { ok: boolean, out?: string | null, json?: HookJson | null, ms: number, t0: number, stderr?: string, code?: string | null, machine?: string }
/** short / pin: an invite's line typed, the PIN given. */
export interface Typed { ok: boolean, asked?: boolean, waiting: boolean, out: string, ms: number, hidden: boolean, stderr?: string }
/** linkfile: this machine's link file without its secrets. */
export interface LinkFile { exists: boolean, token?: boolean, invite?: boolean, pin?: boolean, pin_wanted?: unknown, awaiting?: unknown, refused?: unknown, transport?: { login?: boolean, key?: unknown, knownHosts?: unknown } | null }
/** admitcard: the host's answer to a join request's card. */
export interface Admitted { ok: boolean, question?: string, out?: string, ref?: string, key?: string, link?: string, ms?: number, stderr?: string }
/** One event a seat's tail delivered (lab/seat-proc.ts). */
export interface SeatEvent { t: number, ev?: unknown, raw?: string, stderr?: string, tail_exit?: number | null }
/** The link daemon's status (lib/remote/link-socket.ts status). */
export interface LinkStatus { state?: string, reason?: string, error?: string, queued?: unknown, flush?: { unsent?: unknown[] } | null, [k: string]: unknown }
/** A joiner's link file as written (links/CODE.json, secrets and all), as the scenarios read it. */
export interface LinkJson { token: string, invite?: unknown, transport: { kind?: string, link: string, login?: boolean, via?: string, key?: unknown, alias?: unknown, knownHosts?: unknown, [k: string]: unknown } }
/** A room's members.json, as the scenarios read it. */
export type MembersFile = Record<string, { account?: unknown, machine?: string, [k: string]: unknown } | undefined>;
/** One line of a room log. */
export interface LogLine { id?: number, kind?: string, from?: string, via?: string, to?: string, text?: string, machine?: string, nonce?: string, [k: string]: unknown }
/** dump: one room on one machine. */
export interface Dump {
  code: string; machine: string; machineIn: string; isHost: boolean; dir: string; log: string; members: string | null;
  entries: LogLine[]; chain: { ok?: boolean, [k: string]: unknown } | null; link: LinkStatus | null;
  home: { path: string, mode: string | null, files: { rel: string, mode: string, dir: boolean, size: number }[] };
}
/** probe: what the plugin in /plugin can do. */
export interface Probe {
  version: string | null; cli: string[]; kinds: string[]; ops: string[]; protocolVersion?: unknown; protocolExports: string[]; files: string[]; cliPath: string;
  src: {
    auth: { sh2: boolean, pin: boolean };
    join: { hostSsh: boolean, urlPin: boolean, login: boolean, line: boolean };
    link: { rejoin: boolean, outbox: boolean, ping: boolean, wake: boolean };
    hello: { range: boolean };
  };
}
/** What the lab's features are: feature name -> present. */
export type Features = Record<string, boolean>;
/** sh/exec options. */
interface ShOpts { input?: string | undefined, allowFail?: boolean, timeout?: number, cwd?: string }
interface ExecOpts { user?: string | undefined, env?: Record<string, string | undefined>, input?: string, allowFail?: boolean, timeout?: number }
/** ssh Host blocks: alias -> {HostName, Port, ProxyJump, ProxyCommand, User}. */
export type Hosts = Record<string, Record<string, string | number>>;

const DIR = import.meta.dirname;
const LAB = path.join(DIR, 'lab');
export const COMPOSE = path.join(LAB, 'compose.yml');
const REPO = path.resolve(DIR, '..', '..');
// the previous release, for the 0.5 <-> 0.5 skew scenario: 0.5.0-beta.15 (master's release commit)
const OLD_REF = process.env.LAB_OLD_REF || '7c97bdb';
const OLD_IMAGE = `sub-human-lab-old:${OLD_REF}`;
export const PROJECT = process.env.LAB_PROJECT || 'sub-human-lab';
const USERS: Record<string, string> = { devbox: 'host', 'devbox-old': 'host', 'joiner-a': 'joiner', 'joiner-b': 'joiner' };
const MACHINES = ['devbox', 'devbox-old', 'joiner-a', 'joiner-b'];
const PROXIES = [
  { name: 'devbox-ssh', listen: '0.0.0.0:22001', upstream: 'devbox:22' },
  { name: 'devbox-ssh-b', listen: '0.0.0.0:22002', upstream: 'devbox:22' }, // joiner-b's own WAN path
  { name: 'old-ssh', listen: '0.0.0.0:22003', upstream: 'devbox-old:22' },
];
export const CA = '/etc/lab-ca.crt'; // outside every home: reset() wipes those
export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
export const until = async (fn: () => unknown, ms: number, step = 100): Promise<boolean> => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(step); } return !!(await fn()); };
/** SUB_HUMAN_LINK_*_MS from the harness's own environment, for the machines. */
const linkEnv = (): Record<string, string | undefined> => Object.fromEntries(Object.entries(process.env).filter(([k]) => /^SUB_HUMAN_LINK_[A-Z_]+_MS$/.test(k)));
export const sha = (s: unknown): string => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

export function sh(cmd: string, args: string[], { input, allowFail = false, timeout = 600_000, cwd }: ShOpts = {}): SpawnSyncReturns<string> {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', timeout, maxBuffer: 64 << 20, cwd });
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${(r.stderr || '').slice(-2000) || r.error}`);
  return r;
}

const SSH_DEFAULTS = [
  'Host *', '  IdentitiesOnly yes', '  UserKnownHostsFile ~/.ssh/known_hosts', '  GlobalKnownHostsFile /dev/null',
  '  StrictHostKeyChecking accept-new', '  ConnectTimeout 10', '  LogLevel ERROR', '',
];

/** The seat driver on one machine (Lab.seat). */
export type SeatDriver = ReturnType<Lab['seat']>;

export class Lab {
  log: (m: string) => void;
  features: Features = {};
  probe: Probe | null = null;
  oldProbe: Probe | null = null;
  api: number | null = null;
  linkEnv: Record<string, string> = {}; // the running scenario's linkEnv (runOne)
  since: string | undefined; // when the running scenario started (runOne)

  constructor({ log = () => {} }: { log?: (m: string) => void } = {}) {
    this.log = log;
  }

  dc(args: string[], o?: ShOpts): SpawnSyncReturns<string> { return sh('docker', ['compose', '-f', COMPOSE, '-p', PROJECT, ...args], o); }

  exec(svc: string, argv: string[], { user = 'root', env = {}, input, allowFail = false, timeout = 120_000 }: ExecOpts = {}): SpawnSyncReturns<string> {
    const e = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    return this.dc(['exec', '-T', '-u', user, ...e, svc, ...argv], { input, allowFail, timeout });
  }

  /** The seat driver on one machine: lab/seat-cli.ts as that machine's user, with one SUB_HUMAN_HOME. */
  seat(svc: string, { home = '.sub-human', env: own = {}, user = USERS[svc] ?? 'root' }: { home?: string, env?: Record<string, string>, user?: string | undefined } = {}) {
    const subHome = `/home/${user}/${home}`;
    // the link timings of this run (SUB_HUMAN_LINK_*_MS in the harness's env, then the scenario's linkEnv) reach every
    // hook, CLI and link daemon the seat starts
    const env = { ...linkEnv(), ...this.linkEnv, ...own };
    const run = <T>(...args: string[]): T => {
      const r = this.exec(svc, ['node', '/lab/seat-cli.ts', ...args], { user, env: { SUB_HUMAN_HOME: subHome, ...env }, allowFail: true, timeout: 60_000 });
      if (r.status !== 0) throw new Error(`seat-cli ${svc} ${args[0]} failed (${r.status}): ${(r.stderr || '').slice(-1500)}`);
      return parseJson<T>(r.stdout.trim().split('\n').pop() ?? '');
    };
    const cli = (args: string[], o: ExecOpts = {}): SpawnSyncReturns<string> => this.exec(svc, ['sh', '-c', 'node "$(ls /plugin/scripts/sub-human /plugin/bin/sub-human 2>/dev/null | head -1)" "$@"', 'sub-human', ...args],
      { user, allowFail: true, ...o, env: { SUB_HUMAN_HOME: subHome, ...env, ...(o.env || {}) } });
    return {
      svc, user, home: subHome, cli,
      host: (name: string) => run<HookRun & { code: string | null, machine: string }>('host', name),
      restrict: (code: string, linkId: string, pub: string, file?: string) => run<{ out: string }>('restrict', code, linkId, pub, ...(file ? [file] : [])),
      login: (name: string, dest: string, code: string, ...opts: string[]) => run<HookRun & { out: string }>('login', name, dest, code, ...opts),
      rejoin: (name: string, code: string) => run<HookRun>('rejoin', name, code),
      say: (name: string, text: string) => run<HookRun>('say', name, text),
      prompt: (name: string, text: string) => run<HookRun>('prompt', name, text),
      expand: (name: string, args: string) => run<HookRun>('expand', name, ...args.split(' ')),
      leave: (name: string) => run<{ status: number | null }>('leave', name),
      card: (name: string, label: string) => run<HookRun>('card', name, label),
      short: (name: string, line: string, ...opts: string[]) => run<Typed>('short', name, line, ...opts),
      pin: (name: string, pin: string) => run<Typed>('pin', name, pin),
      linkfile: (code: string) => run<LinkFile>('linkfile', code),
      admitcard: (name: string, label: string) => run<Admitted>('admitcard', name, label),
      events: (name: string) => run<{ pid: number, alive: boolean, events: SeatEvent[] }>('events', name),
      dump: (code: string) => run<Dump>('dump', code),
      link: (code: string) => run<LinkStatus>('link', code),
      probe: () => run<Probe>('probe'),
    };
  }

  async toxi(method: string, p: string, body?: unknown): Promise<unknown> {
    const r = await fetch(`http://127.0.0.1:${this.api}${p}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    if (!r.ok) throw new Error(`toxiproxy ${method} ${p}: ${r.status} ${text}`);
    return text ? JSON.parse(text) : null;
  }

  async toxic(proxy: string, name: string, type: string, attributes: Record<string, unknown>, stream = 'downstream'): Promise<unknown> {
    return this.toxi('POST', `/proxies/${proxy}/toxics`, { name, type, stream, toxicity: 1, attributes });
  }

  async untoxic(proxy: string, name: string): Promise<void> { try { await this.toxi('DELETE', `/proxies/${proxy}/toxics/${name}`); } catch { /* none */ } }

  /** The previous release's image (0.5.0-beta.15), from `git archive OLD_REF plugin/sub-human` (built once per ref; the tag is the cache). */
  buildOld({ force = false } = {}): boolean {
    if (!force && sh('docker', ['image', 'inspect', OLD_IMAGE], { allowFail: true }).status === 0) return false;
    const ctx = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-lab-old-'));
    try {
      const tar = path.join(ctx, 'old.tar');
      sh('git', ['-C', REPO, 'archive', '-o', tar, OLD_REF, 'plugin/sub-human']);
      sh('tar', ['-xf', tar, '-C', ctx]);
      fs.rmSync(tar);
      fs.copyFileSync(path.join(LAB, 'Dockerfile.old'), path.join(ctx, 'Dockerfile'));
      sh('docker', ['build', '-q', '-t', OLD_IMAGE, ctx]);
    } finally { fs.rmSync(ctx, { recursive: true, force: true }); }
    return true;
  }

  async up(): Promise<{ api: number, sshPort: number }> {
    this.log('compose build (sub-human-lab:node24)');
    this.dc(['build', '-q', 'devbox']);
    if (this.buildOld()) this.log(`built ${OLD_IMAGE} from git archive ${OLD_REF}`);
    this.log('compose up -d');
    this.dc(['up', '-d', '--remove-orphans']);
    for (const svc of MACHINES) {
      const ok = await until(() => this.exec(svc, ['pgrep', '-x', 'sshd'], { allowFail: true }).status === 0, 20_000, 200);
      if (!ok) throw new Error(`sshd did not start in ${svc}`);
    }
    this.api = Number(this.dc(['port', 'toxiproxy', '8474']).stdout.trim().split(':').pop());
    await until(async () => { try { await this.toxi('GET', '/version'); return true; } catch { return false; } }, 20_000, 200);
    const have = await this.toxi('GET', '/proxies');
    for (const p of PROXIES) if (!(have && typeof have === 'object' && p.name in have)) await this.toxi('POST', '/proxies', { ...p, enabled: true });
    // tls-front's internal CA root, trusted by the joiners (as a ts.net certificate is publicly trusted)
    const rootPath = '/data/caddy/pki/authorities/local/root.crt';
    await until(() => this.exec('tls-front', ['test', '-s', rootPath], { allowFail: true }).status === 0 || this.touchTls(), 30_000, 500);
    const root = this.exec('tls-front', ['cat', rootPath]).stdout;
    for (const j of ['joiner-a', 'joiner-b']) this.exec(j, ['sh', '-c', `cat > ${CA} && chmod 0644 ${CA}`], { input: root });
    this.probe = this.seat('devbox').probe();
    this.oldProbe = this.seat('devbox-old').probe();
    this.features = features(this.probe);
    return { api: this.api, sshPort: Number(this.dc(['port', 'toxiproxy', '22001']).stdout.trim().split(':').pop()) };
  }

  /** Caddy issues the certificate on its first TLS request for the name: poke it from the edge. */
  touchTls(): boolean { this.exec('joiner-a', ['curl', '-sk', '-o', '/dev/null', 'https://tls-front/'], { allowFail: true, timeout: 15_000 }); return false; }

  async reset(): Promise<void> {
    for (const svc of MACHINES) this.dc(['unpause', svc], { allowFail: true });
    const wipe = [
      // bracketed first letters: the pattern does not match this shell's own command line
      `P='[s]eat-proc|[s]ub-human (link|serve|tail|listen)|[w]s-probe|[b]in/serve'; pkill -f "$P"; sleep 0.3; pkill -9 -f "$P"`,
      'iptables -F 2>/dev/null',
      'for u in host joiner; do d=/home/$u; rm -rf $d/.sub-human* $d/work $d/lab-* $d/.ssh/*; done',
      'rm -rf /tmp/sh-* 2>/dev/null; true',
    ].join('; ');
    for (const svc of MACHINES) this.exec(svc, ['sh', '-c', wipe], { allowFail: true });
    if (this.api) {
      await this.toxi('POST', '/reset');
      for (const p of PROXIES) await this.toxi('POST', `/proxies/${p.name}`, { ...p, enabled: true }).catch(() => {});
    }
  }

  down(): SpawnSyncReturns<string> { return this.dc(['down', '-v', '--remove-orphans', '-t', '2'], { allowFail: true }); }

  keypair(svc: string, name: string, user = USERS[svc]): string {
    this.exec(svc, ['sh', '-c', `test -f ~/.ssh/${name} || ssh-keygen -q -t ed25519 -N '' -C lab-${svc}-${name} -f ~/.ssh/${name}`], { user });
    return this.exec(svc, ['cat', `/home/${user}/.ssh/${name}.pub`], { user }).stdout.trim();
  }

  /** ~/.ssh/NAME.conf: hosts = {alias: {HostName, Port, ProxyJump, ProxyCommand, User}}; IdentityFile ~/.ssh/KEY for all. */
  sshConfig(svc: string, name: string, key: string, hosts: Hosts, user = USERS[svc]): string {
    const lines: string[] = [];
    for (const [alias, o] of Object.entries(hosts)) {
      lines.push(`Host ${alias}`);
      for (const [k, v] of Object.entries(o)) lines.push(`  ${k} ${v}`);
    }
    lines.push(...SSH_DEFAULTS, `  IdentityFile ~/.ssh/${key}`, '');
    const file = `/home/${user}/.ssh/${name}.conf`;
    this.exec(svc, ['sh', '-c', `cat > ${file} && chmod 0600 ${file}`], { user, input: lines.join('\n') });
    return file;
  }

  restrict(code: string, linkId: string, pub: string, { svc = 'devbox' }: { svc?: string } = {}): { out: string } {
    return this.seat(svc).restrict(code, linkId, pub, '/home/host/.ssh/authorized_keys');
  }

  authorizeLogin(pub: string, { svc = 'devbox', user = USERS[svc] || 'host' }: { svc?: string, user?: string } = {}): void {
    this.exec(svc, ['sh', '-c', `mkdir -p /home/${user}/.ssh && cat >> /home/${user}/.ssh/authorized_keys && chown -R ${user}:${user} /home/${user}/.ssh && chmod 0600 /home/${user}/.ssh/authorized_keys`], { input: pub + '\n' });
  }

  /** The standard rig most scenarios start from: alice hosts on SVC; returns {code, host}. */
  hostRoom(svc = 'devbox', name = 'alice'): { code: string, host: SeatDriver, hostName: string, machine: string } {
    const host = this.seat(svc);
    const h = host.host(name);
    if (!h.ok || !h.code) throw new Error(`host ${name} on ${svc}: ${JSON.stringify(h)}`);
    return { code: h.code, host, hostName: name, machine: h.machine };
  }

  /** `/sub-human invite --ssh DEST` in NAME's session on hostSeat: the line (no "/sub-human "), its SECRET word (null
   * from a beta.15 host, whose line ends with the PIN) and the PIN. */
  hostInvite(hostSeat: SeatDriver, name: string, { dest = 'host@devbox' }: { dest?: string } = {}): { line: string, word: string | null, pin: string, text: string } {
    const r = hostSeat.expand(name, `invite --ssh ${dest}`);
    const text = r.out || '';
    const m = /\/sub-human (join \S+ [a-z]+-\d{4} ([0-9a-z]{39})(?: --home \S+)?)\n/.exec(`${text}\n`);
    const p = /apart from the line[^\n]*: (\d{4})\n/.exec(`${text}\n`);
    if (m && p) return { line: m[1] ?? '', word: m[2] ?? '', pin: p[1] ?? '', text };
    const old = /\/sub-human (join \S+ [a-z]+-\d{4} (\d{4})(?: --via \S+)?)\n/.exec(`${text}\n`); // a beta.15 host's
    if (old) return { line: old[1] ?? '', word: null, pin: old[2] ?? '', text };
    throw new Error(`invite --ssh on ${hostSeat.svc}: no line and PIN in: ${text.slice(0, 300)}`);
  }

  async join(opts: JoinOpts): Promise<Joined> {
    const { svc, name, code, hosts, host, hostName = 'alice', user = USERS[svc], hostSvc = 'devbox', dest = 'host@devbox', key = `id_${name}`, ms = 30_000 } = opts;
    const t0 = Date.now();
    const pub = this.keypair(svc, key, user);
    const conf = this.sshConfig(svc, name, key, hosts, user);
    this.authorizeLogin(pub, { svc: hostSvc }); // their own ssh login to the host account: what an ssh invite rides
    const hostSeat = host || this.seat(hostSvc);
    const { line, word, pin, text } = this.hostInvite(hostSeat, hostName, { dest });
    const seat = this.seat(svc, { user, ...(opts.home ? { home: opts.home } : {}) });
    const typed = seat.short(name, line, '-F', conf);
    const refused = (out: string): Joined => ({ seat, name, invite: line, pin, text, linkId: null, conf, pub, linked: typed, admitted: null, join: { ok: false, out, ms: Date.now() - t0 } });
    if (!word) return refused(typed.out); // a beta.15 host's line: this joiner says the host must update
    if (!typed.ok) return refused(typed.out); // a beta.15 joiner refuses this host's line; or the host refused it
    // the host asks for the PIN once the daemon reached it (the hook's reply may come before)
    const asked = !!typed.asked || await until(() => { const l = seat.linkfile(code); return !!l.pin_wanted || !!l.refused; }, ms, 250);
    const lf = seat.linkfile(code);
    if (!asked || !lf.pin_wanted) return refused(`${typed.out} ${JSON.stringify(lf.refused || seat.link(code))}`);
    const gave = seat.pin(name, pin);
    const admitted = gave.waiting ? hostSeat.admitcard(hostName, 'Let in') : null;
    const linkId = (admitted && admitted.link) || null;
    // the daemon redials (jittered backoff) until the card lets the machine in
    const online = !!(admitted && admitted.ok) && await until(() => { try { return seat.link(code).state === 'online'; } catch { return false; } }, ms, 250);
    const seated: { ok: boolean, out?: string | null } = online ? seat.expand(name, '') // a bare /sub-human takes the seat
      : { ok: false, out: `not linked: ${gave.out || ''} ${admitted ? `card: ${admitted.out}` : ''} link ${JSON.stringify(seat.link(code))}` };
    return { seat, name, invite: line, word, pin, linkId, conf, pub, linked: typed, gave, admitted, join: { ...seated, ms: Date.now() - t0 } };
  }

  /** Logs since the current scenario started (runOne sets this.since), so one scenario never sees another's. */
  composeLogs(svc?: string, since = this.since): string {
    return this.dc(['logs', '--no-color', '--timestamps', ...(since ? ['--since', since] : []), ...(svc ? [svc] : [])], { allowFail: true }).stdout;
  }
}

/** lab.join's options. */
export interface JoinOpts {
  svc: string; name: string; code: string; hosts: Hosts; host?: SeatDriver; hostName?: string;
  user?: string | undefined; hostSvc?: string; dest?: string; key?: string; ms?: number; home?: string;
}
/** lab.join's answer: the joiner's seat driver and every step's result. */
export interface Joined {
  seat: SeatDriver; name: string; invite: string; word?: string | null; pin: string; text?: string; linkId: string | null; conf: string; pub: string;
  linked: Typed; gave?: Typed; admitted: Admitted | null; join: { ok: boolean, out?: string | null, ms: number };
  pending?: string; // a step the plugin cannot do yet (none now)
}

// ---------- features ----------
const FEATURES: Record<string, (p: Probe) => boolean> = {
  hostSsh: p => p.src.join.hostSsh,
  revoke: p => p.cli.includes('kick') || p.cli.includes('revoke'),
  heartbeat: p => p.ops.includes('ping') || p.src.link.ping,
  outbox: p => p.files.some(f => /^lib\/remote\/outbox\.[jt]s$/.test(f)) || p.src.link.outbox,
  autoRejoin: p => p.src.link.rejoin,
  wake: p => p.src.link.wake,
  doctor: p => p.cli.includes('doctor'),
  ws: p => p.kinds.some(k => /^wss?$/.test(k)) || p.files.some(f => /ws\.[jt]s$|listener\.[jt]s$/.test(f)),
  urlPin: p => p.src.join.urlPin,
  loginJoin: p => p.src.join.login,
  shortCode: p => p.files.some(f => /^lib\/remote\/enroll\.[jt]s$/.test(f)), // beta.15's PIN join (CPace)
  inviteLine: p => p.files.some(f => /^lib\/remote\/invite-secret\.[jt]s$/.test(f)), // protocol 3: the line and its PIN
  versionRange: p => p.src.hello.range,
};

export function features(probe: Probe): Features {
  const f: Features = {};
  for (const [k, fn] of Object.entries(FEATURES)) { try { f[k] = !!fn(probe); } catch { f[k] = false; } }
  for (const kv of String(process.env.LAB_FEATURES || '').split(',').filter(Boolean)) {
    const [k, v] = kv.split('=');
    f[(k ?? '').trim()] = v === undefined || v === '1' || v === 'true';
  }
  return f;
}

// ---------- evidence ----------
/** One check of a scenario. */
export interface Check { name: string, status: 'pass' | 'fail' | 'pending' | 'bug', detail: string }

export class Evidence {
  dir: string;
  echo: ((line: string) => void) | undefined;
  secrets = new Set<string>();
  pins: string[] | undefined;
  checks: Check[] = [];
  metrics: Record<string, unknown> = {};

  constructor(dir: string, echo?: (line: string) => void) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.echo = echo;
  }
  secret(s: unknown, min = 8): void { if (s && String(s).length >= min) this.secrets.add(String(s)); }
  /** An invite's secret (sh2, or an invite line's SECRET word) and its PIN (only where it stands as the PIN: never a bare
   * 4-digit number). */
  invite(inv: unknown, pin: unknown): void {
    if (inv) {
      const s = String(inv);
      const word = /\b([0-9a-z]{39})\b/.exec(s);
      if (word) this.secret(word[1]); else if (s.startsWith('sh2.')) this.secret(s.split('.')[3]);
    }
    if (pin) this.pins = [...(this.pins || []), String(pin)];
  }
  redact(text: unknown): string {
    let t = String(text);
    for (const s of this.secrets) t = t.split(s).join('<redacted>');
    for (const p of this.pins || []) t = t.replace(new RegExp(`(PIN\\D{0,3}|another way\\): |sh2\\.\\S+\\s+)${p}\\b`, 'g'), '$1<pin>');
    // a line's PIN step (join 4829), or a beta.15 line: join DEST ROOM 4829, or join URL 4829
    for (const p of this.pins || []) t = t.replace(new RegExp(`(join\\s+(?:\\S+(?:\\s+[a-z]+-\\d{4})?\\s+)?)${p}\\b`, 'g'), '$1<pin>');
    t = t.replace(/(\/sub-human join \S+(?: [a-z]+-\d{4})? )[0-9a-z]{39}\b/g, '$1<redacted>'); // any invite line's SECRET
    return t.replace(/\b(sh[12])\.([a-z]+-\d{4}|[A-Z0-9]{4,8})\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]{16,}/g, '$1.$2.$3.<redacted>');
  }
  log(msg: string): void {
    const line = `${new Date().toISOString().slice(11, 23)}  ${this.redact(msg)}`;
    if (this.echo) this.echo(line);
    fs.appendFileSync(path.join(this.dir, 'transcript.log'), line + '\n');
  }
  write(name: string, text: unknown): void { fs.writeFileSync(path.join(this.dir, name), this.redact(typeof text === 'string' ? text : JSON.stringify(text, null, 2))); }
}

// ---------- the runner ----------
/** What a scenario's run(t) gets. */
export interface T {
  lab: Lab; ev: Evidence; features: Features; sleep: typeof sleep; until: typeof until; sha: typeof sha;
  log(m: string): void;
  metric(k: string, v: unknown): void;
  check(name: string, pass: unknown, detail?: unknown): boolean;
  expect(name: string, pass: unknown, detail: unknown, feature?: string): boolean;
  bug(name: string, pass: unknown, detail?: unknown): boolean;
  pending(name: string, reason: string): void;
}
/** A scenario module (scenarios/NN-*.ts): its named exports. */
export interface Scenario {
  id: string; title: string; persona: string; requires?: string[]; budgetMs?: number; linkEnv?: Record<string, string>;
  skip?(lab: Lab): string | false | null | undefined;
  run(t: T): Promise<unknown>;
}
/** One scenario's result. */
interface Result { id: string, title: string, persona: string, status: string, reason?: string, checks: Check[], metrics: Record<string, unknown>, ms: number, pendingChecks?: number }

export function loadScenarios(): (Scenario & { file: string })[] {
  const dir = path.join(DIR, 'scenarios');
  return fs.readdirSync(dir).filter(f => /^\d\d-.*\.ts$/.test(f)).sort().map(f => {
    const sc: Scenario = require(path.join(dir, f));
    return { file: f, ...sc };
  });
}

async function runOne(lab: Lab, sc: Scenario, out: string, echo?: (line: string) => void): Promise<Result> {
  const ev = new Evidence(path.join(out, sc.id), echo);
  const started = Date.now();
  const force = String(process.env.LAB_FORCE || '').split(',').includes(sc.id);
  const missing = (sc.requires || []).filter(k => !lab.features[k]);
  const result: Result = { id: sc.id, title: sc.title, persona: sc.persona, status: 'pass', checks: ev.checks, metrics: ev.metrics, ms: 0 };
  ev.log(`== ${sc.id}: ${sc.title} (${sc.persona})`);
  if (missing.length && !force) {
    result.status = 'pending';
    result.reason = `needs ${missing.join(', ')} (not in this plugin yet; LAB_FORCE=${sc.id} runs it anyway)`;
    ev.log(`PENDING  ${result.reason}`);
    ev.write('summary.json', result);
    return result;
  }
  if (sc.skip) {
    const why = sc.skip(lab);
    if (why) {
      result.status = 'skip';
      result.reason = why;
      ev.log(`SKIP  ${why}`);
      ev.write('summary.json', result);
      return result;
    }
  }
  const t: T = {
    lab, ev, features: lab.features, sleep, until, sha,
    log: m => ev.log(m),
    metric: (k, v) => { ev.metrics[k] = v; },
    check(name, pass, detail = '') {
      ev.checks.push({ name, status: pass ? 'pass' : 'fail', detail: String(detail) });
      ev.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
      return !!pass;
    },
    expect(name, pass, detail, feature) {
      if (pass) return t.check(name, true, detail);
      if (feature && !lab.features[feature]) {
        ev.checks.push({ name, status: 'pending', detail: `needs ${feature}; observed: ${String(detail)}` });
        ev.log(`PEND  ${name}  (needs ${feature}; observed: ${detail})`);
        return false;
      }
      return t.check(name, false, detail);
    },
    /** A check that fails because of a known plugin bug (listed in the report): status 'bug', which fails the suite
     *  only with LAB_STRICT=1. */
    bug(name, pass, detail = '') {
      if (pass) return t.check(name, true, detail);
      ev.checks.push({ name, status: 'bug', detail: String(detail) });
      ev.log(`BUG   ${name}  (${String(detail)})`);
      return false;
    },
    pending(name, reason) { ev.checks.push({ name, status: 'pending', detail: reason }); ev.log(`PEND  ${name}  (${reason})`); },
  };
  try {
    await lab.reset();
    lab.since = new Date().toISOString();
    lab.linkEnv = sc.linkEnv || {};
    const timings = { ...linkEnv(), ...lab.linkEnv };
    if (Object.keys(timings).length) ev.log(`link timings: ${Object.entries(timings).map(([k, v]) => `${k.replace(/^SUB_HUMAN_LINK_|_MS$/g, '')}=${v}`).join(' ')}`);
    await Promise.race([
      sc.run(t),
      sleep(sc.budgetMs || 180_000).then(() => { throw new Error(`over its budget of ${sc.budgetMs || 180_000} ms`); }),
    ]);
  } catch (e) {
    ev.checks.push({ name: 'scenario ran to the end', status: 'fail', detail: e instanceof Error ? e.message : String(e) });
    ev.log(`ERROR ${e instanceof Error && e.stack || String(e)}`);
  } finally {
    try { ev.write('compose-logs.txt', lab.composeLogs()); } catch { /* best effort */ }
    for (const svc of MACHINES) lab.dc(['unpause', svc], { allowFail: true });
  }
  const st = ev.checks.map(c => c.status);
  result.status = st.includes('fail') ? 'fail' : st.includes('bug') ? 'bug' : st.includes('pass') ? 'pass' : 'pending';
  result.pendingChecks = ev.checks.filter(c => c.status === 'pending').length;
  result.ms = Date.now() - started;
  ev.log(`== ${sc.id}: ${result.status.toUpperCase()} in ${Math.round(result.ms / 1000)} s`);
  ev.write('summary.json', result);
  return result;
}

export async function runScenarios({ out, only, keep = false, echo = (l: string) => { process.stdout.write(l + '\n'); } }: { out: string, only?: string | undefined, keep?: boolean, echo?: (l: string) => void }): Promise<{ ok: boolean, results: Result[], summary: unknown }> {
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const lab = new Lab({ log: m => echo(`lab: ${m}`) });
  const all = loadScenarios();
  const want = only ? only.split(',').map(s => s.trim()) : null;
  const list = want ? all.filter(s => want.some(w => s.id === w || s.id.startsWith(w) || s.file.startsWith(w))) : all;
  const results: Result[] = [];
  const t0 = Date.now();
  let upInfo: { api: number } | null = null, upError: unknown = null;
  try {
    upInfo = await lab.up();
    echo(`lab: up; toxiproxy api 127.0.0.1:${upInfo.api}; features ${JSON.stringify(lab.features)}`);
    fs.writeFileSync(path.join(out, 'features.json'), JSON.stringify({ features: lab.features, probe: lab.probe, oldProbe: lab.oldProbe }, null, 2));
    for (const sc of list) results.push(await runOne(lab, sc, out, echo));
  } catch (e) {
    upError = e;
    echo(`lab: ERROR ${e instanceof Error && e.stack || String(e)}`);
  } finally {
    if (!keep) {
      const d = lab.down();
      echo(`lab: compose down -v: exit ${d.status}`);
    }
  }
  const summary = {
    at: new Date().toISOString(), ms: Date.now() - t0, out, features: lab.features, error: upError instanceof Error ? upError.message : upError ? String(upError) : null,
    results: results.map(r => ({ id: r.id, title: r.title, persona: r.persona, status: r.status, reason: r.reason, ms: r.ms,
      checks: r.checks.map(c => `${c.status.toUpperCase()} ${c.name}${c.detail ? ` (${c.detail})` : ''}`), metrics: r.metrics })),
  };
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  const md = ['# sub-human lab: scenario run', '', `${summary.at} · ${Math.round(summary.ms / 1000)} s · evidence ${out}`, '',
    '| scenario | persona | status | checks | time |', '|---|---|---|---|---|',
    ...results.map(r => `| ${r.id} | ${r.persona} | ${r.status.toUpperCase()}${r.reason ? `: ${r.reason}` : ''} | ${r.checks.map(c => `${c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : c.status === 'bug' ? 'BUG' : '…'} ${c.name}`).join('<br>')} | ${Math.round(r.ms / 1000)} s |`),
    '', `features: \`${JSON.stringify(lab.features)}\``, ''].join('\n');
  fs.writeFileSync(path.join(out, 'REPORT.md'), md);
  const strict = process.env.LAB_STRICT === '1';
  const ok = !upError && results.length > 0 && results.every(r => r.status !== 'fail' && !(strict && r.status === 'bug'));
  return { ok, results, summary };
}

