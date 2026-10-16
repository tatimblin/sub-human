'use strict';
/**
 * scripts/remote-docker/lab.js: the controller of the sub-human lab (lab/compose.yml, project sub-human-lab) and the
 * scenario runner behind `harness.js scenarios`. README.md has the topology and the scenario list.
 *
 *   new Lab({log})
 *     up()              build (the previous release's image from `git archive OLD_REF` once: 0.5.0-beta.15), start, wait for every sshd and for
 *                       toxiproxy, create the proxies, copy tls-front's CA root to the joiners, probe the features
 *     reset()           between scenarios: unpause, every sub-human process stopped, homes, keys, authorized_keys
 *                       and known_hosts wiped, toxiproxy reset, iptables flushed
 *     down()            compose down -v --remove-orphans
 *     exec(svc, argv, {user, env, input, allowFail, timeout}) -> spawnSync result
 *     seat(svc, {home?}) -> Machine-side driver: host/join/login/short/admitcard/rejoin/say/expand/leave/events/dump/link (lab/seat-cli.js)
 *     toxi(method, path, body)   the toxiproxy API
 *     keypair(svc, name) -> pubkey      ~/.ssh/NAME (ed25519) for the joiner user
 *     sshConfig(svc, name, hosts)       ~/.ssh/NAME.conf: one Host block per entry, then the shared defaults
 *     trustOnBastion(pub)   the joiner's key on the bastion (a jump host's account)
 *     restrict(code, linkId, pub, {svc})   the one-link forced-command line an admit wrote before protocol 3, appended
 *                       to the devbox account's authorized_keys (what a key let in for one other connection looks like;
 *                       nothing writes one now)
 *     authorizeLogin(pub, {svc, user?})   the joiner's key as an ordinary login line in the host account's authorized_keys: the
 *                       person's own ssh login, set up as any is (an ssh invite rides it; the plugin writes no line)
 *     hostInvite(hostSeat, name, {dest, via}) -> {line, word, pin, text}   `/sub-human invite --ssh DEST [--via JUMP]`:
 *                       the line (protocol 3: its SECRET word; beta.15: word null, the PIN at its end) and the PIN
 *     join(opts) -> Promise<{seat, name, invite, pin, linkId, conf, join, pub}>   a joiner over one ssh path: its own
 *                       login to the host account, invite --ssh on the host's seat, the line typed on the joiner
 *                       (`/sub-human join DEST ROOM SECRET [--via J] --as NAME`: the host's key checked, the SECRET
 *                       shown), the PIN when the host asks (`/sub-human join PIN`), the host's card (Let in), the link
 *                       online, then a bare `/sub-human` (the seat). Against devbox-old (beta.15) its line has a 4-digit
 *                       PIN and this joiner refuses it (the host must update): {join: {ok: false, out}}; a beta.15 joiner
 *                       refuses this host's line the same way
 *     features             {hostSsh, revoke, heartbeat, outbox, autoRejoin, handoff, doctor, ws, urlPin,
 *                          versionRange, loginJoin, shortCode, inviteLine}: what the plugin in /plugin can do (seat-cli.js probe), overridable with
 *                          LAB_FEATURES=outbox=1,ws=0
 *   runScenarios({out, only, log}) -> {ok, results}   each scenarios/*.js in order; evidence under out/<id>/
 * Scenario module: {id, title, persona, requires?: [feature], budgetMs?, linkEnv?: {SUB_HUMAN_LINK_*_MS}, run(t)}.
 * Link timings: SUB_HUMAN_LINK_*_MS in the harness's environment reach every machine's seats (hooks, CLI, daemons);
 * a scenario's linkEnv adds its own on top (short timings where it needs them). t = {lab, ev, features, check(name,
 * pass, detail), expect(name, pass, detail, feature) (a miss is pending while the feature is missing, else a
 * failure), bug(name, pass, detail) (a miss is a known plugin bug: status 'bug', fatal only with LAB_STRICT=1),
 * pending(name, reason), sleep, until, metric(k, v)}. A scenario whose requires is not met is pending (not
 * run); LAB_FORCE=id[,id] runs it anyway.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const DIR = __dirname;
const LAB = path.join(DIR, 'lab');
const COMPOSE = path.join(LAB, 'compose.yml');
const REPO = path.resolve(DIR, '..', '..');
// the previous release, for the 0.5 <-> 0.5 skew scenario: 0.5.0-beta.15 (master's release commit)
const OLD_REF = process.env.LAB_OLD_REF || '7c97bdb';
const OLD_IMAGE = `sub-human-lab-old:${OLD_REF}`;
const PROJECT = process.env.LAB_PROJECT || 'sub-human-lab';
const USERS = { devbox: 'host', 'devbox-old': 'host', 'joiner-a': 'joiner', 'joiner-b': 'joiner' };
const MACHINES = ['devbox', 'devbox-old', 'bastion', 'joiner-a', 'joiner-b'];
const PROXIES = [
  { name: 'devbox-ssh', listen: '0.0.0.0:22001', upstream: 'devbox:22' },
  { name: 'old-ssh', listen: '0.0.0.0:22003', upstream: 'devbox-old:22' },
];
const CA = '/etc/lab-ca.crt'; // outside every home: reset() wipes those
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms, step = 100) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(step); } return !!(await fn()); };
/** SUB_HUMAN_LINK_*_MS from the harness's own environment, for the machines. */
const linkEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => /^SUB_HUMAN_LINK_[A-Z_]+_MS$/.test(k)));
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

function sh(cmd, args, { input, allowFail = false, timeout = 600_000, cwd } = {}) {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', timeout, maxBuffer: 64 << 20, cwd });
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${(r.stderr || '').slice(-2000) || r.error}`);
  return r;
}

const SSH_DEFAULTS = [
  'Host *', '  IdentitiesOnly yes', '  UserKnownHostsFile ~/.ssh/known_hosts', '  GlobalKnownHostsFile /dev/null',
  '  StrictHostKeyChecking accept-new', '  ConnectTimeout 10', '  LogLevel ERROR', '',
];

class Lab {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.features = {};
    this.probe = null;
    this.api = null;
    this.linkEnv = {}; // the running scenario's linkEnv (runOne)
  }

  dc(args, o) { return sh('docker', ['compose', '-f', COMPOSE, '-p', PROJECT, ...args], o); }

  exec(svc, argv, { user = 'root', env = {}, input, allowFail = false, timeout = 120_000 } = {}) {
    const e = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    return this.dc(['exec', '-T', '-u', user, ...e, svc, ...argv], { input, allowFail, timeout });
  }

  /** The seat driver on one machine: lab/seat-cli.js as that machine's user, with one SUB_HUMAN_HOME. */
  seat(svc, { home = '.sub-human', env: own = {}, user = USERS[svc] } = {}) {
    const subHome = `/home/${user}/${home}`;
    // the link timings of this run (SUB_HUMAN_LINK_*_MS in the harness's env, then the scenario's linkEnv) reach every
    // hook, CLI and link daemon the seat starts
    const env = { ...linkEnv(), ...this.linkEnv, ...own };
    const run = (...args) => {
      const r = this.exec(svc, ['node', '/lab/seat-cli.js', ...args], { user, env: { SUB_HUMAN_HOME: subHome, ...env }, allowFail: true, timeout: 60_000 });
      if (r.status !== 0) throw new Error(`seat-cli ${svc} ${args[0]} failed (${r.status}): ${(r.stderr || '').slice(-1500)}`);
      return JSON.parse(r.stdout.trim().split('\n').pop());
    };
    const cli = (args, o = {}) => this.exec(svc, ['sh', '-c', 'node "$(ls /plugin/scripts/sub-human /plugin/bin/sub-human 2>/dev/null | head -1)" "$@"', 'sub-human', ...args],
      { user, allowFail: true, ...o, env: { SUB_HUMAN_HOME: subHome, ...env, ...(o.env || {}) } });
    return {
      svc, user, home: subHome, cli,
      host: name => run('host', name),
      restrict: (code, linkId, pub, file) => run('restrict', code, linkId, pub, ...(file ? [file] : [])),
      options: (code, name, value) => run('options', code, name, value),
      login: (name, dest, code, ...opts) => run('login', name, dest, code, ...opts),
      rejoin: (name, code) => run('rejoin', name, code),
      say: (name, text) => run('say', name, text),
      prompt: (name, text) => run('prompt', name, text),
      expand: (name, args) => run('expand', name, ...args.split(' ')),
      leave: name => run('leave', name),
      card: (name, label) => run('card', name, label),
      short: (name, dest, code, pin, ...opts) => run('short', name, dest, code, pin, ...opts),
      admitcard: (name, label) => run('admitcard', name, label),
      events: name => run('events', name),
      dump: code => run('dump', code),
      link: code => run('link', code),
      probe: () => run('probe'),
    };
  }

  async toxi(method, p, body) {
    const r = await fetch(`http://127.0.0.1:${this.api}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    if (!r.ok) throw new Error(`toxiproxy ${method} ${p}: ${r.status} ${text}`);
    return text ? JSON.parse(text) : null;
  }

  async toxic(proxy, name, type, attributes, stream = 'downstream') {
    return this.toxi('POST', `/proxies/${proxy}/toxics`, { name, type, stream, toxicity: 1, attributes });
  }

  async untoxic(proxy, name) { try { await this.toxi('DELETE', `/proxies/${proxy}/toxics/${name}`); } catch { /* none */ } }

  /** The previous release's image (0.5.0-beta.15), from `git archive OLD_REF plugin/sub-human` (built once per ref; the tag is the cache). */
  buildOld({ force = false } = {}) {
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

  async up() {
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
    for (const p of PROXIES) if (!have[p.name]) await this.toxi('POST', '/proxies', { ...p, enabled: true });
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
  touchTls() { this.exec('joiner-a', ['curl', '-sk', '-o', '/dev/null', 'https://tls-front/'], { allowFail: true, timeout: 15_000 }); return false; }

  async reset() {
    for (const svc of MACHINES) this.dc(['unpause', svc], { allowFail: true });
    const wipe = [
      // bracketed first letters: the pattern does not match this shell's own command line
      `P='[s]eat-proc|[s]ub-human (link|serve|tail|listen)|[w]s-probe|[b]in/serve'; pkill -f "$P"; sleep 0.3; pkill -9 -f "$P"`,
      'iptables -F 2>/dev/null',
      'for u in host jump joiner; do d=/home/$u; rm -rf $d/.sub-human* $d/work $d/lab-* $d/.ssh/*; done',
      'rm -rf /tmp/sh-* 2>/dev/null; true',
    ].join('; ');
    for (const svc of MACHINES) this.exec(svc, ['sh', '-c', wipe], { allowFail: true });
    if (this.api) {
      await this.toxi('POST', '/reset');
      for (const p of PROXIES) await this.toxi('POST', `/proxies/${p.name}`, { ...p, enabled: true }).catch(() => {});
    }
  }

  down() { return this.dc(['down', '-v', '--remove-orphans', '-t', '2'], { allowFail: true }); }

  keypair(svc, name, user = USERS[svc]) {
    this.exec(svc, ['sh', '-c', `test -f ~/.ssh/${name} || ssh-keygen -q -t ed25519 -N '' -C lab-${svc}-${name} -f ~/.ssh/${name}`], { user });
    return this.exec(svc, ['cat', `/home/${user}/.ssh/${name}.pub`], { user }).stdout.trim();
  }

  /** ~/.ssh/NAME.conf: hosts = {alias: {HostName, Port, ProxyJump, ProxyCommand, User}}; IdentityFile ~/.ssh/KEY for all. */
  sshConfig(svc, name, key, hosts, user = USERS[svc]) {
    const lines = [];
    for (const [alias, o] of Object.entries(hosts)) {
      lines.push(`Host ${alias}`);
      for (const [k, v] of Object.entries(o)) lines.push(`  ${k} ${v}`);
    }
    lines.push(...SSH_DEFAULTS, `  IdentityFile ~/.ssh/${key}`, '');
    const file = `/home/${user}/.ssh/${name}.conf`;
    this.exec(svc, ['sh', '-c', `cat > ${file} && chmod 0600 ${file}`], { user, input: lines.join('\n') });
    return file;
  }

  restrict(code, linkId, pub, { svc = 'devbox' } = {}) {
    return this.seat(svc).restrict(code, linkId, pub, '/home/host/.ssh/authorized_keys');
  }

  authorizeLogin(pub, { svc = 'devbox', user = USERS[svc] || 'host' } = {}) {
    this.exec(svc, ['sh', '-c', `mkdir -p /home/${user}/.ssh && cat >> /home/${user}/.ssh/authorized_keys && chown -R ${user}:${user} /home/${user}/.ssh && chmod 0600 /home/${user}/.ssh/authorized_keys`], { input: pub + '\n' });
  }

  trustOnBastion(pub) {
    this.exec('bastion', ['sh', '-c', 'cat >> /home/jump/.ssh/authorized_keys && chown jump:jump /home/jump/.ssh/authorized_keys && chmod 0600 /home/jump/.ssh/authorized_keys'], { input: pub + '\n' });
  }

  /** The standard rig most scenarios start from: alice hosts on SVC; returns {code, host}. */
  hostRoom(svc = 'devbox', name = 'alice') {
    const host = this.seat(svc);
    const h = host.host(name);
    if (!h.ok || !h.code) throw new Error(`host ${name} on ${svc}: ${JSON.stringify(h)}`);
    return { code: h.code, host, hostName: name, machine: h.machine };
  }

  /** `/sub-human invite --ssh DEST [--via JUMP]` in NAME's session on hostSeat: the line (no "/sub-human "), its SECRET
   * word (null from a beta.15 host, whose line ends with the PIN) and the PIN. */
  hostInvite(hostSeat, name, { dest = 'host@devbox', via } = {}) {
    const r = hostSeat.expand(name, `invite --ssh ${dest}${via ? ` --via ${via}` : ''}`);
    const text = r.out || '';
    const m = /\/sub-human (join \S+ [a-z]+-\d{4} ([0-9a-z]{39})(?: --(?:via|home) \S+)*)\n/.exec(`${text}\n`);
    const p = /apart from the line[^\n]*: (\d{4})\n/.exec(`${text}\n`);
    if (m && p) return { line: m[1], word: m[2], pin: p[1], text };
    const old = /\/sub-human (join \S+ [a-z]+-\d{4} (\d{4})(?: --via \S+)?)\n/.exec(`${text}\n`); // a beta.15 host's
    if (old) return { line: old[1], word: null, pin: old[2], text };
    throw new Error(`invite --ssh on ${hostSeat.svc}: no line and PIN in: ${text.slice(0, 300)}`);
  }

  async join(opts) {
    const { svc, name, code, hosts, via, viaFlag, host, hostName = 'alice', user = USERS[svc], hostSvc = 'devbox', dest = 'host@devbox', key = `id_${name}`, ms = 30_000 } = opts;
    const t0 = Date.now();
    const pub = this.keypair(svc, key, user);
    const conf = this.sshConfig(svc, name, key, hosts, user);
    if (via === 'bastion') this.trustOnBastion(pub);
    this.authorizeLogin(pub, { svc: hostSvc }); // their own ssh login to the host account: what an ssh invite rides
    const hostSeat = host || this.seat(hostSvc);
    const { line, word, pin, text } = this.hostInvite(hostSeat, hostName, { dest, via: viaFlag });
    const seat = this.seat(svc, { user, ...(opts.home ? { home: opts.home } : {}) });
    const typed = seat.short(name, line, '-F', conf);
    const refused = out => ({ seat, name, invite: line, pin, text, linkId: null, conf, pub, linked: typed, admitted: null, join: { ok: false, out, ms: Date.now() - t0 } });
    if (!word) return refused(typed.out); // a beta.15 host's line: this joiner says the host must update
    if (!typed.ok) return refused(typed.out); // a beta.15 joiner refuses this host's line; or the host refused it
    // the host asks for the PIN once the daemon reached it (the hook's reply may come before)
    const asked = typed.asked || await until(() => { const l = seat.linkfile(code); return !!l.pin_wanted || !!l.refused; }, ms, 250);
    const lf = seat.linkfile(code);
    if (!asked || !lf.pin_wanted) return refused(`${typed.out} ${JSON.stringify(lf.refused || seat.link(code))}`);
    const gave = seat.pin(name, pin);
    const admitted = gave.waiting ? hostSeat.admitcard(hostName, 'Let in') : null;
    const linkId = admitted && admitted.link;
    // the daemon redials (jittered backoff) until the card lets the machine in
    const online = !!(admitted && admitted.ok) && await until(() => { try { return seat.link(code).state === 'online'; } catch { return false; } }, ms, 250);
    const seated = online ? seat.expand(name, '') // a bare /sub-human takes the seat
      : { ok: false, out: `not linked: ${gave.out || ''} ${admitted ? `card: ${admitted.out}` : ''} link ${JSON.stringify(seat.link(code))}` };
    return { seat, name, invite: line, word, pin, linkId, conf, pub, linked: typed, gave, admitted, join: { ...seated, ms: Date.now() - t0 } };
  }

  /** Logs since the current scenario started (runOne sets this.since), so one scenario never sees another's. */
  composeLogs(svc, since = this.since) {
    return this.dc(['logs', '--no-color', '--timestamps', ...(since ? ['--since', since] : []), ...(svc ? [svc] : [])], { allowFail: true }).stdout;
  }
}

// ---------- features ----------
const FEATURES = {
  hostSsh: p => p.src.join.hostSsh,
  revoke: p => p.cli.includes('kick') || p.cli.includes('revoke'),
  heartbeat: p => p.ops.includes('ping') || p.src.link.ping,
  outbox: p => p.files.some(f => /^lib\/remote\/outbox\.[jt]s$/.test(f)) || p.src.link.outbox,
  autoRejoin: p => p.src.link.rejoin,
  wake: p => p.src.link.wake,
  handoff: p => p.cli.includes('handoff'),
  doctor: p => p.cli.includes('doctor'),
  ws: p => p.kinds.some(k => /^wss?$/.test(k)) || p.files.some(f => /ws\.[jt]s$|listener\.[jt]s$/.test(f)),
  urlPin: p => p.src.join.urlPin,
  loginJoin: p => p.src.join.login,
  shortCode: p => p.files.some(f => /^lib\/remote\/enroll\.[jt]s$/.test(f)), // beta.15's PIN join (CPace)
  inviteLine: p => p.files.some(f => /^lib\/remote\/invite-secret\.[jt]s$/.test(f)), // protocol 3: the line and its PIN
  versionRange: p => p.src.hello.range,
};

function features(probe) {
  const f = {};
  for (const [k, fn] of Object.entries(FEATURES)) { try { f[k] = !!fn(probe); } catch { f[k] = false; } }
  for (const kv of String(process.env.LAB_FEATURES || '').split(',').filter(Boolean)) {
    const [k, v] = kv.split('=');
    f[k.trim()] = v === undefined || v === '1' || v === 'true';
  }
  return f;
}

// ---------- evidence ----------
class Evidence {
  constructor(dir, echo) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.echo = echo;
    this.secrets = new Set();
    this.checks = [];
    this.metrics = {};
  }
  secret(s, min = 8) { if (s && String(s).length >= min) this.secrets.add(String(s)); }
  /** An invite's secret (sh2, or an invite line's SECRET word) and its PIN (only where it stands as the PIN: never a bare
   * 4-digit number). */
  invite(inv, pin) {
    if (inv) {
      const s = String(inv);
      const word = /\b([0-9a-z]{39})\b/.exec(s);
      if (word) this.secret(word[1]); else if (s.startsWith('sh2.')) this.secret(s.split('.')[3]);
    }
    if (pin) this.pins = [...(this.pins || []), String(pin)];
  }
  redact(text) {
    let t = String(text);
    for (const s of this.secrets) t = t.split(s).join('<redacted>');
    for (const p of this.pins || []) t = t.replace(new RegExp(`(PIN\\D{0,3}|another way\\): |sh2\\.\\S+\\s+)${p}\\b`, 'g'), '$1<pin>');
    // a line's PIN step (join 4829), or a beta.15 line: join DEST ROOM 4829, or join URL 4829
    for (const p of this.pins || []) t = t.replace(new RegExp(`(join\\s+(?:\\S+(?:\\s+[a-z]+-\\d{4})?\\s+)?)${p}\\b`, 'g'), '$1<pin>');
    t = t.replace(/(\/sub-human join \S+(?: [a-z]+-\d{4})? )[0-9a-z]{39}\b/g, '$1<redacted>'); // any invite line's SECRET
    return t.replace(/\b(sh[12])\.([a-z]+-\d{4}|[A-Z0-9]{4,8})\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]{16,}/g, '$1.$2.$3.<redacted>');
  }
  log(msg) {
    const line = `${new Date().toISOString().slice(11, 23)}  ${this.redact(msg)}`;
    if (this.echo) this.echo(line);
    fs.appendFileSync(path.join(this.dir, 'transcript.log'), line + '\n');
  }
  write(name, text) { fs.writeFileSync(path.join(this.dir, name), this.redact(typeof text === 'string' ? text : JSON.stringify(text, null, 2))); }
}

// ---------- the runner ----------
function loadScenarios() {
  const dir = path.join(DIR, 'scenarios');
  return fs.readdirSync(dir).filter(f => /^\d\d-.*\.js$/.test(f)).sort().map(f => ({ file: f, ...require(path.join(dir, f)) }));
}

async function runOne(lab, sc, out, echo) {
  const ev = new Evidence(path.join(out, sc.id), echo);
  const started = Date.now();
  const force = String(process.env.LAB_FORCE || '').split(',').includes(sc.id);
  const missing = (sc.requires || []).filter(k => !lab.features[k]);
  const result = { id: sc.id, title: sc.title, persona: sc.persona, status: 'pass', checks: ev.checks, metrics: ev.metrics, ms: 0 };
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
  const t = {
    lab, ev, features: lab.features, sleep, until, sha,
    log: m => ev.log(m),
    metric: (k, v) => { ev.metrics[k] = v; },
    check(name, pass, detail = '') {
      ev.checks.push({ name, status: pass ? 'pass' : 'fail', detail });
      ev.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
      return !!pass;
    },
    expect(name, pass, detail, feature) {
      if (pass) return t.check(name, true, detail);
      if (feature && !lab.features[feature]) {
        ev.checks.push({ name, status: 'pending', detail: `needs ${feature}; observed: ${detail}` });
        ev.log(`PEND  ${name}  (needs ${feature}; observed: ${detail})`);
        return false;
      }
      return t.check(name, false, detail);
    },
    /** A check that fails because of a known plugin bug (listed in the report): status 'bug', which fails the suite
     *  only with LAB_STRICT=1. */
    bug(name, pass, detail = '') {
      if (pass) return t.check(name, true, detail);
      ev.checks.push({ name, status: 'bug', detail });
      ev.log(`BUG   ${name}  (${detail})`);
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
    ev.checks.push({ name: 'scenario ran to the end', status: 'fail', detail: e && e.message });
    ev.log(`ERROR ${e && e.stack || e}`);
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

async function runScenarios({ out, only, keep = false, echo = l => process.stdout.write(l + '\n') }) {
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const lab = new Lab({ log: m => echo(`lab: ${m}`) });
  const all = loadScenarios();
  const want = only ? only.split(',').map(s => s.trim()) : null;
  const list = want ? all.filter(s => want.some(w => s.id === w || s.id.startsWith(w) || s.file.startsWith(w))) : all;
  const results = [];
  const t0 = Date.now();
  let upInfo = null, upError = null;
  try {
    upInfo = await lab.up();
    echo(`lab: up; toxiproxy api 127.0.0.1:${upInfo.api}; features ${JSON.stringify(lab.features)}`);
    fs.writeFileSync(path.join(out, 'features.json'), JSON.stringify({ features: lab.features, probe: lab.probe, oldProbe: lab.oldProbe }, null, 2));
    for (const sc of list) results.push(await runOne(lab, sc, out, echo));
  } catch (e) {
    upError = e;
    echo(`lab: ERROR ${e && e.stack || e}`);
  } finally {
    if (!keep) {
      const d = lab.down();
      echo(`lab: compose down -v: exit ${d.status}`);
    }
  }
  const summary = {
    at: new Date().toISOString(), ms: Date.now() - t0, out, features: lab.features, error: upError && upError.message,
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

module.exports = { Lab, Evidence, runScenarios, loadScenarios, features, sh, sleep, until, sha, CA, PROJECT, COMPOSE };
