#!/usr/bin/env node
'use strict';
/**
 * scripts/remote-docker/harness.js: remote rooms over real SSH, against a second machine faked with Docker.
 *
 *   devbox (container)   sshd + the host room in /home/host/.sub-human: alice (a sleeper seat; up names it), the orch's
 *                        `claude` a stub. scripts/remote-docker/host-cli.js drives its hooks.
 *   toxiproxy            in front of devbox:22, published on 127.0.0.1 (a port Docker picks): cut the link, add
 *                        latency.
 *   joiner (this Mac)    a temp SUB_HUMAN_HOME; bob joins with the real hooks as child processes
 *                        (plugin test/support/two-homes.js); his link daemon runs `ssh` with a throwaway key
 *                        (SUB_HUMAN_SSH_OPTS: -F /dev/null, -i, a temp known_hosts) through toxiproxy into devbox,
 *                        where the authorized_keys forced command (`sub-human authorize`) runs `serve --link`.
 * Nothing touches this Mac's sshd, ~/.ssh or ~/.sub-human. No real Claude runs in `run`.
 *
 *   node scripts/remote-docker/harness.js run [--out DIR]
 *       Build, start, join, check the anti-fallback assertions, tear everything down. The evidence bundle
 *       (transcript.log, REPORT.md, report.html, transcript.svg, report.png when Chrome is installed, compose
 *       ps/logs, toxiproxy state) goes to DIR, default /tmp/sub-human-remote-proof-<timestamp>. Invite secrets
 *       and link tokens are redacted in every file. Exit 0 only when every assertion passed.
 *   node scripts/remote-docker/harness.js up [--host-seat NAME] [--joiners A,B] | status | say [--to NAME] TEXT |
 *       cut | heal | latency MS | down
 *       The manual mode, for real Claudes on this Mac: up starts devbox + toxiproxy with the room and the host's
 *       scripted seat (--host-seat, default alice). For each joiner (--joiners, default bob) it makes a throwaway
 *       key, mints that joiner's own ssh invite and authorizes the key for it in devbox, and creates under
 *       /tmp/sub-human-remote-manual a home NAME-home (0700), a git project NAME-proj and NAME.env (0600:
 *       SUB_HUMAN_HOME, SUB_HUMAN_SSH_OPTS, SUB_HUMAN_INVITE). Source it, cd to the project, start
 *       `claude --plugin-dir plugin/sub-human --remote-control` and type /sub-human join NAME $SUB_HUMAN_INVITE.
 *       say posts as the host seat (signed, the host's hook path); --to NAME addresses a post from the seat's
 *       Claude. status shows every joiner's link. cut/heal disable/enable the proxy; latency adds (MS > 0) or removes
 *       (0) a latency toxic. down stops it all and removes the manual state, every joiner's home, project, env and
 *       link daemon.
 * SUB_HUMAN_COMPOSE_PROJECT (default: compose.yml's sub-human-remote) and SUB_HUMAN_MANUAL_DIR (default
 * /tmp/sub-human-remote-manual) let a second stack run beside the default one; set both the same for every command.
 * npm run test:remote-docker runs `run` as an opt-in test (skipped without Docker).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { PLUGIN, pluginTest, pluginLib } = require('../lib/paths.js');

const DIR = __dirname;
const COMPOSE = path.join(DIR, 'compose.yml');
const HOST_HOME = '/home/host/.sub-human';
const MANUAL = process.env.SUB_HUMAN_MANUAL_DIR || '/tmp/sub-human-remote-manual';
// SUB_HUMAN_COMPOSE_PROJECT runs a second stack beside the default one (compose.yml names it sub-human-remote).
const PROJECT = process.env.SUB_HUMAN_COMPOSE_PROJECT ? ['-p', process.env.SUB_HUMAN_COMPOSE_PROJECT] : [];
const PROXY = 'ssh';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- docker ----------
function sh(cmd, args, { input, allowFail = false, timeout = 600_000 } = {}) {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', timeout, maxBuffer: 64 << 20 });
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${r.stderr || r.error}`);
  return r;
}
const dc = (args, o) => sh('docker', ['compose', '-f', COMPOSE, ...PROJECT, ...args], o);
const dexec = (args, { user = 'host', ...o } = {}) => dc(['exec', '-T', '-u', user, '-e', `SUB_HUMAN_HOME=${HOST_HOME}`, 'devbox', ...args], o);
const hostCli = (...args) => JSON.parse(dexec(['node', '/harness/host-cli.js', ...args]).stdout);
const subHuman = (args, o) => dexec(['node', '/plugin/bin/sub-human', ...args], o);
const port = (svc, p) => Number(dc(['port', svc, String(p)]).stdout.trim().split(':').pop());

async function toxi(api, method, p, body) {
  const r = await fetch(`http://127.0.0.1:${api}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`toxiproxy ${method} ${p}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function bringUp(log) {
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

function keygen(dir, name) {
  const f = path.join(dir, name);
  sh('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `sub-human-harness-${name}`, '-f', f]);
  return f;
}
const sshOpts = (key, kh) => ['-F', '/dev/null', '-i', key, '-o', 'IdentitiesOnly=yes', '-o', `UserKnownHostsFile=${kh}`,
  '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', '-o', 'LogLevel=ERROR'].join(' ');

/** Mint an ssh invite in devbox and authorize key.pub for it there: {invite, linkId, line}. */
function inviteAndAuthorize(code, sshPort, pub) {
  const invite = subHuman(['invite', '--room', code, '--ssh', `host@127.0.0.1:${sshPort}`]).stdout.trim();
  const r = subHuman(['authorize', invite, '-', '--file', '/home/host/.ssh/authorized_keys'], { input: fs.readFileSync(pub, 'utf8') });
  const linkId = /link ([0-9a-f]{12})/.exec(r.stderr)[1];
  const line = dexec(['cat', '/home/host/.ssh/authorized_keys']).stdout.split('\n').find(l => l.includes(linkId));
  return { invite, linkId, line };
}

// ---------- evidence ----------
class Evidence {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.secrets = new Set();
    this.lines = [];
    this.results = [];
    this.metrics = {};
  }
  secret(s) { if (s) this.secrets.add(String(s)); }
  redact(text) {
    let t = String(text);
    for (const s of this.secrets) t = t.split(s).join('<redacted>');
    return t.replace(/sh1\.([a-z]+-\d{4})\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]{16,128}/g, 'sh1.$1.$2.<redacted>');
  }
  log(msg) {
    const line = `${new Date().toISOString().slice(11, 23)}  ${this.redact(msg)}`;
    this.lines.push(line);
    process.stdout.write(line + '\n');
    fs.appendFileSync(path.join(this.dir, 'transcript.log'), line.replace(/\x1b\[[0-9;]*m/g, '') + '\n');
  }
  step(title) { this.log(''); this.log(`== ${title}`); }
  raw(label, text) {
    this.log(`-- ${label}:`);
    for (const l of String(text).replace(/\n$/, '').split('\n')) this.log(`   | ${l}`);
  }
  check(n, title, pass, detail = '') {
    this.results.push({ n, title, pass: !!pass, detail });
    this.log(`${pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  A${n}  ${title}${detail ? `  (${detail})` : ''}`);
  }
  write(name, text) { fs.writeFileSync(path.join(this.dir, name), this.redact(text)); }
}

const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const timed = fn => { const t = process.hrtime.bigint(); const v = fn(); return [v, Number(process.hrtime.bigint() - t) / 1e6]; };
const until = async (fn, ms, step = 50) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(step); } return !!(await fn()); };
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const fmt = ms => `${Math.round(ms)} ms`;
const realHomeMtime = () => { try { return fs.statSync(path.join(os.homedir(), '.sub-human')).mtimeMs; } catch { return null; } };
const running = () => sh('pgrep', ['-fl', 'sub-human (link|serve)'], { allowFail: true }).stdout.trim();

/** Every file under dir: [{rel, mode, text}]. */
function walk(dir) {
  return fs.readdirSync(dir, { recursive: true }).sort().map(rel => {
    const p = path.join(dir, rel);
    const st = fs.lstatSync(p);
    return { rel, mode: (st.mode & 0o777).toString(8), dir: st.isDirectory(), text: st.isFile() ? fs.readFileSync(p, 'utf8') : '' };
  });
}

// ---------- run: the automated assertions ----------
async function run({ out }) {
  const ev = new Evidence(out);
  const mtimeBefore = realHomeMtime();
  const before = running();
  const { Machine } = pluginTest('support/two-homes.js'); // also gives this process a temp SUB_HUMAN_HOME
  const store = pluginLib('room/store.js');
  const identity = pluginLib('identity.js');
  const link = pluginLib('remote/link.js');
  const envelope = pluginLib('room/envelope.js');
  const client = pluginLib('remote/client.js');
  const pipe = pluginLib('remote/transports/pipe.js');
  const keys = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-ssh-keys-'));
  let remote = null, remote2 = null, bob = null, daemonPid = null;
  const cleanup = [];

  ev.step('preflight');
  ev.log(`evidence dir: ${out}`);
  ev.log(`real ~/.sub-human mtime before: ${mtimeBefore}`);
  ev.log(`sub-human link/serve processes before: ${before || '(none)'}`);
  ev.raw('docker version', sh('docker', ['version', '--format', 'client {{.Client.Version}} server {{.Server.Version}}']).stdout);

  try {
    ev.step('bring up devbox + toxiproxy');
    const { api, sshPort } = await bringUp(m => ev.log(m));
    ev.log(`toxiproxy api 127.0.0.1:${api}, ssh proxy 127.0.0.1:${sshPort} -> devbox:22`);
    ev.raw('docker compose ps', dc(['ps']).stdout);

    ev.step('host room in devbox (alice, a sleeper seat)');
    const setup = hostCli('setup');
    const code = setup.code;
    ev.log(`room ${code}; devbox machine id ${setup.machine}; alice pid ${setup.seat.pid} (in devbox)`);
    ev.log(`alice's join: ${setup.join && (setup.join.reason || setup.join.systemMessage || '(no line: it worked)')}`);

    ev.step('joiner keys, invite, authorize');
    const key = keygen(keys, 'id'), key2 = keygen(keys, 'id2');
    const kh = path.join(keys, 'known_hosts');
    const opts = sshOpts(key, kh);
    const A = inviteAndAuthorize(code, sshPort, key + '.pub');
    ev.secret(A.invite.split('.').pop());
    ev.log(`invite (ssh): ${A.invite}`);
    ev.log(`link id reserved by authorize: ${A.linkId}`);
    ev.raw('devbox authorized_keys line (bob)', A.line);
    ev.log(`SUB_HUMAN_SSH_OPTS=${opts}`);

    ev.step('bob joins from this Mac over ssh (real join hook, link daemon)');
    remote = new Machine(null, 'joiner', { SUB_HUMAN_SSH_OPTS: opts, SUB_HUMAN_LINK_RETRY_MS: '1000', SUB_HUMAN_LINK_IDLE_MS: '3000' });
    bob = remote.seat('bob');
    ev.log(`joiner SUB_HUMAN_HOME ${remote.home}`);
    const [joined, joinMs] = timed(() => remote.join(bob, `join bob ${A.invite}`));
    ev.log(`join took ${fmt(joinMs)}: ${JSON.stringify(joined.json && (joined.json.reason || joined.json.systemMessage || '(no line: it worked)'))}`);
    // a join that works prints nothing; a refusal is a block
    if (!joined.json || joined.json.decision === 'block' || !(joined.json.hookSpecificOutput || {}).additionalContext) throw new Error(`join failed: ${JSON.stringify(joined.json)} ${joined.stderr}`);
    const st = remote.lib(() => link.status(code));
    daemonPid = st.pid;
    ev.log(`link daemon pid ${st.pid}, state ${st.state}`);
    cleanup.push(() => { try { process.kill(daemonPid, 'SIGTERM'); } catch { /* gone */ } });
    const joinerMachine = remote.lib(() => identity.machineId());
    const linkFile = path.join(remote.home, 'links', `${code}.json`);
    const token = JSON.parse(fs.readFileSync(linkFile, 'utf8')).token;
    ev.secret(token);

    // A1
    ev.step('A1 distinct machine ids');
    let d = hostCli('dump');
    const bobJoin = d.entries.find(e => e.kind === 'member_joined' && e.from === 'bob');
    ev.raw("host's member_joined line for bob", d.log.split('\n').find(l => l.includes('"member_joined"') && l.includes('"from":"bob"')));
    ev.log(`joiner machine id ${joinerMachine}; devbox machine id ${d.machine}`);
    ev.check(1, "host's member_joined for bob carries the joiner's machine id, not devbox's", bobJoin && bobJoin.machine === joinerMachine && joinerMachine !== d.machine,
      `bob ${bobJoin && bobJoin.machine} vs devbox ${d.machine}`);

    // A5 first post (also used by A2/A7)
    ev.step('bob posts @room (traffic captured in devbox)');
    const cap = spawn('docker', ['compose', '-f', COMPOSE, ...PROJECT, 'exec', '-T', '-u', 'root', 'devbox', 'timeout', '5', 'tcpdump', '-i', 'eth0', '-nn', '-q', '-l', 'tcp port 22'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let dump = '';
    cap.stdout.on('data', c => { dump += c; });
    const capDone = new Promise(r => cap.on('exit', r));
    const netBefore = dexec(['cat', '/proc/net/dev']).stdout;
    await sleep(1200);
    const [said, sayMs] = timed(() => remote.say(bob, 'hello from the mac'));
    const netAfter = dexec(['cat', '/proc/net/dev']).stdout;
    await capDone;
    ev.log(`bob's @room took ${fmt(sayMs)}: continue=${said.json && said.json.continue}`);

    ev.step('A2 joiner home: link file, mirror, nothing host-only, no devbox path');
    const files = walk(remote.home);
    ev.raw('find joiner home (mode, path)', files.map(f => `${f.mode} ${f.dir ? 'd' : '-'} ${f.rel}`).join('\n'));
    const lf = JSON.parse(fs.readFileSync(linkFile, 'utf8'));
    ev.raw('links/CODE.json (token redacted)', JSON.stringify(lf, null, 2));
    const lfMode = (fs.statSync(linkFile).mode & 0o777).toString(8);
    const mirrorLog = path.join(remote.home, 'rooms', code, 'log.jsonl');
    const hostOnly = files.filter(f => /(^|\/)remote(\/|$)|invites|remote\/links/.test(f.rel));
    const devPath = files.filter(f => f.text.includes('/home/host'));
    const leaked = files.filter(f => f.text.includes(A.invite.split('.').pop()));
    ev.check(2, 'joiner has links/CODE.json (0600, token, no invite) and a mirror; no host-only docs; no devbox path',
      lfMode === '600' && typeof lf.token === 'string' && lf.invite === undefined && fs.existsSync(mirrorLog) && !hostOnly.length && !devPath.length && !leaked.length,
      `mode ${lfMode}, token ${typeof lf.token}, invite ${lf.invite === undefined ? 'absent' : 'PRESENT'}, mirror ${fs.existsSync(mirrorLog)}, host-only ${hostOnly.length}, devbox paths ${devPath.length}, invite secret ${leaked.length}`);

    ev.step('A3 joiner cannot see the host files');
    const hostRoomDir = d.dir;
    const exists = fs.existsSync(hostRoomDir);
    ev.log(`fs.existsSync(${hostRoomDir}) on this Mac: ${exists}`);
    const fresh = subHuman(['invite', '--room', code]).stdout.trim(); // a real invite, pipe: locator = devbox's home
    const pipeInvite = fresh; // its locator is pipe:/home/host/.sub-human, a path that exists only in devbox
    ev.secret(fresh.split('.').pop());
    ev.log(`pipe invite locator: ${Buffer.from(fresh.split('.')[2], 'base64url').toString()}`);
    remote2 = new Machine(null, 'joiner2', { SUB_HUMAN_LINK_RETRY_MS: '1000', SUB_HUMAN_LINK_IDLE_MS: '1500' });
    const carl = remote2.seat('carl');
    const [pj, pjMs] = timed(() => remote2.join(carl, `join carl ${pipeInvite}`));
    const pjReason = pj.json && (pj.json.reason || pj.json.systemMessage);
    ev.log(`pipe join from this Mac (${fmt(pjMs)}): ${pjReason}`);
    const st2 = remote2.lib(() => link.status(code));
    if (st2.pid) cleanup.push(() => { try { process.kill(st2.pid, 'SIGTERM'); } catch { /* gone */ } });
    try { ev.raw('joiner2 link log', fs.readFileSync(path.join(remote2.home, 'links', `${code}.log`), 'utf8')); } catch { /* none */ }
    ev.check(3, 'the devbox room dir does not exist here; a pipe: invite pointing at it fails', !exists && pj.json && pj.json.decision === 'block',
      `exists ${exists}; join ${pj.json && pj.json.decision}`);

    ev.step('A4 host members record for bob');
    d = hostCli('dump');
    const membersDoc = JSON.parse(d.members);
    const bobRec = membersDoc.bob || Object.values(membersDoc).find(m => m && m.name === 'bob');
    ev.raw("devbox members.json, bob's record", JSON.stringify(bobRec, null, 2));
    const banned = ['pid', 'pid_start', 'session_id', 'cwd'].filter(k => bobRec && k in bobRec);
    ev.check(4, "host's members record for bob has no pid/pid_start/session_id/cwd", bobRec && !banned.length, banned.length ? `has ${banned}` : `machine ${bobRec && bobRec.machine}`);

    ev.step('A5 bob\'s @room on devbox: sig v2, verified; a tampered resend is AUTH');
    const said5 = d.entries.find(e => e.from === 'bob' && e.text === 'hello from the mac');
    const line5 = d.log.split('\n').find(l => l.includes('hello from the mac'));
    ev.raw("bob's signed line in devbox's log", line5);
    ev.log(`isV2 ${said5 && said5.v2}; humanTrust on devbox: ${said5 && said5.trust}`);
    const payload = JSON.parse(line5);
    for (const f of ['id', 'at', 'prev']) delete payload[f];
    const openSsh = (k = key) => {
      const [cmd, ...args] = link.sshCommand({ kind: 'ssh', user: 'host', host: '127.0.0.1', port: sshPort }, code, sshOpts(k, kh).split(' '));
      return pipe.spawn(cmd, args, { env: process.env });
    };
    const errOf = async p => { try { await p; return 'accepted'; } catch (e) { return `${e.code}: ${e.message}`; } };
    const c5 = await client.connect(openSsh(), { machine: joinerMachine, token, helloMs: 15000 });
    // the text edited under bob's signature, with a fresh nonce and ts so the replay check passes: only the
    // signature can refuse it; then the same with the original nonce; then the exact payload again
    const tampered = await errOf(c5.append({ ...payload, text: 'hello from the mac (edited)', nonce: envelope.newNonce(), ts: Date.now() }));
    const tamperedSameNonce = await errOf(c5.append({ ...payload, text: 'hello from the mac (edited)' }));
    const replayed = await errOf(c5.append(payload));
    c5.close();
    ev.log(`tampered resend (fresh nonce, bob's old signature): ${tampered}`);
    ev.log(`tampered resend (same nonce): ${tamperedSameNonce}`);
    ev.log(`exact replay: ${replayed}`);
    const after5 = hostCli('dump');
    ev.check(5, "bob's entry is sig v2 and verified against the pinned key; tampered resend is AUTH",
      said5 && said5.v2 && said5.trust === 'verified' && /^AUTH/.test(tampered) && /signature|signed/i.test(tampered) && !/nonce/.test(tampered)
        && /^AUTH/.test(tamperedSameNonce) && /^AUTH/.test(replayed) && !after5.log.includes('(edited)') && after5.log === d.log,
      `v2 ${said5 && said5.v2}, trust ${said5 && said5.trust}, tampered: ${tampered}; replay ${replayed.split(':')[0]}`);

    ev.step('A6 who runs what');
    const psDev = dexec(['ps', '-eo', 'user,pid,ppid,args'], { user: 'root' }).stdout;
    ev.raw('devbox ps -eo user,pid,ppid,args', psDev);
    const rows = psDev.split('\n').slice(1).map(l => l.trim().split(/\s+/)).filter(r => r.length > 3).map(([user, pid, ppid, ...args]) => ({ user, pid, ppid, args: args.join(' ') }));
    const serveRow = rows.find(r => r.args.includes(`serve --stdio ${code} --link ${A.linkId}`) && !r.args.startsWith('bash'));
    const parent = serveRow && rows.find(r => r.pid === serveRow.ppid);
    const grand = parent && rows.find(r => r.pid === parent.ppid);
    const chainOk = serveRow && serveRow.user === 'host' && [parent, grand].some(p => p && /^sshd/.test(p.args));
    const kids = sh('pgrep', ['-P', String(daemonPid)], { allowFail: true }).stdout.trim().split('\n').filter(Boolean);
    const psMac = kids.length ? sh('ps', ['-o', 'pid,ppid,command', '-p', [daemonPid, ...kids].join(',')]).stdout : sh('ps', ['-o', 'pid,ppid,command', '-p', String(daemonPid)]).stdout;
    ev.raw("this Mac: the link daemon and its children", psMac);
    const kidCmds = kids.map(k => sh('ps', ['-o', 'command=', '-p', k], { allowFail: true }).stdout.trim());
    const macOk = kidCmds.length > 0 && kidCmds.every(c => /^ssh -T -o BatchMode=yes /.test(c)) && !kidCmds.some(c => /node\S*\s.*\bserve\b/.test(c));
    ev.check(6, 'serve runs in devbox under sshd as user host; the Mac daemon\'s child is ssh, not node serve', chainOk && macOk,
      `devbox serve pid ${serveRow && serveRow.pid} user ${serveRow && serveRow.user} parent "${parent && parent.args}"; mac child ssh ${macOk}`);

    ev.step('A7 traffic crosses the wire');
    const linkLog = fs.readFileSync(path.join(remote.home, 'links', `${code}.log`), 'utf8');
    ev.raw('link log', linkLog);
    const eth = t => { const m = /eth0:\s*(\d+)\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)\s+(\d+)/.exec(t); return m ? { rx: +m[1], tx: +m[3] } : { rx: 0, tx: 0 }; };
    const nb = eth(netBefore), na = eth(netAfter);
    const pkts = dump.split('\n').filter(l => /IP /.test(l));
    ev.raw('tcpdump in devbox during the post (tcp port 22)', pkts.slice(0, 20).join('\n') + (pkts.length > 20 ? `\n… ${pkts.length} packets` : ''));
    ev.log(`devbox eth0 during the post: rx +${na.rx - nb.rx} B, tx +${na.tx - nb.tx} B; ${pkts.length} packets on port 22`);
    ev.metrics.bytes = { rx: na.rx - nb.rx, tx: na.tx - nb.tx, packets: pkts.length };
    ev.check(7, 'link log shows connect -> online; packets and bytes on devbox:22 during the post',
      /connecting/.test(linkLog) && /online/.test(linkLog) && pkts.length > 0 && na.rx > nb.rx,
      `${pkts.length} packets, rx +${na.rx - nb.rx} B`);

    ev.step('A9 an addressed post from alice reaches bob\'s tail');
    const tailP = remote.tail(bob, 4);
    await sleep(800);
    hostCli('to', 'bob', 'for bob only, from alice');
    const bobSees = await tailP;
    ev.raw("bob's tail (monitor) output", bobSees);
    const inMirror = remote.log(code).split('\n').filter(Boolean).map(l => JSON.parse(l)).find(e => e.text === 'for bob only, from alice');
    ev.check(9, "alice's addressed post reaches bob's tail via the log entry", /for bob only, from alice/.test(bobSees) && inMirror && inMirror.to === 'bob',
      `mirror entry #${inMirror && inMirror.id} to ${inMirror && inMirror.to}`);

    ev.step('A8 latency toxic (200 ms each way)');
    const base = [];
    for (let i = 0; i < 5; i++) { const [r, ms] = timed(() => remote.say(bob, `baseline ${i}`)); if (r.json && r.json.continue === false) base.push(ms); }
    await toxi(api, 'POST', `/proxies/${PROXY}/toxics`, { name: 'lat_down', type: 'latency', stream: 'downstream', attributes: { latency: 200, jitter: 0 } });
    await toxi(api, 'POST', `/proxies/${PROXY}/toxics`, { name: 'lat_up', type: 'latency', stream: 'upstream', attributes: { latency: 200, jitter: 0 } });
    const slow = [];
    let slowOk = 0;
    for (let i = 0; i < 5; i++) { const [r, ms] = timed(() => remote.say(bob, `under latency ${i}`)); slow.push(ms); if (r.json && r.json.continue === false) slowOk++; }
    ev.raw('toxics', JSON.stringify(await toxi(api, 'GET', `/proxies/${PROXY}/toxics`), null, 2));
    await toxi(api, 'DELETE', `/proxies/${PROXY}/toxics/lat_down`);
    await toxi(api, 'DELETE', `/proxies/${PROXY}/toxics/lat_up`);
    ev.metrics.latency = { base, slow };
    ev.log(`@room hook wall time, no toxic: ${base.map(fmt).join(', ')} (p50 ${fmt(pct(base, 0.5))})`);
    ev.log(`@room hook wall time, 200 ms each way: ${slow.map(fmt).join(', ')} (p50 ${fmt(pct(slow, 0.5))}); ${slowOk}/5 posted`);

    ev.step('A8 kill test: disable the proxy');
    await until(() => remote.log(code) === hostCli('dump').log, 5000, 100);
    const tCut = Date.now();
    await toxi(api, 'PATCH', `/proxies/${PROXY}`, { enabled: false });
    const wentOffline = await until(() => remote.lib(() => link.status(code)).state === 'offline', 20000, 20);
    const offlineMs = Date.now() - tCut;
    ev.log(`link state offline after ${fmt(offlineMs)}: ${wentOffline}`);
    const snap = { host: hostCli('dump').log, mirror: remote.log(code) };
    const refused = remote.say(bob, 'is anyone there');
    ev.log(`bob's @room while cut: ${JSON.stringify(refused.json)}`);
    const unchanged = hostCli('dump').log === snap.host && remote.log(code) === snap.mirror;
    ev.log(`host log and mirror unchanged by the refused post: ${unchanged}`);
    const away = hostCli('say', 'while you were away');
    ev.log(`alice posts on the host meanwhile: ok ${away.ok}`);
    const tHeal = Date.now();
    await toxi(api, 'PATCH', `/proxies/${PROXY}`, { enabled: true });
    const back = await until(() => remote.lib(() => link.status(code)).state === 'online', 60000, 20);
    const reconnectMs = Date.now() - tHeal;
    const synced = await until(() => remote.log(code) === hostCli('dump').log, 10000, 100);
    const finalHost = hostCli('dump');
    const mirrorNow = remote.log(code);
    const ids = mirrorNow.split('\n').filter(Boolean).map(l => JSON.parse(l).id);
    const noGap = ids.every((id, i) => id === i + 1);
    const chainMirror = remote.lib(() => store.open(code).verifyChain());
    ev.log(`re-enabled; online again after ${fmt(reconnectMs)}: ${back}; mirror byte-identical: ${synced}`);
    ev.log(`sha256 host log ${sha(finalHost.log)}  mirror ${sha(mirrorNow)}  (${ids.length} lines, ids 1..${ids.at(-1)} ${noGap ? 'no gap' : 'GAP'})`);
    ev.log(`verifyChain host ${JSON.stringify(finalHost.chain)} mirror ${JSON.stringify(chainMirror)}`);
    ev.metrics.offlineMs = offlineMs;
    ev.metrics.reconnectMs = reconnectMs;
    const awayInMirror = mirrorNow.includes('while you were away');
    ev.check(8, 'cut: OFFLINE, nothing written; heal: resumes byte-identical, no gap; posts succeed under 200 ms latency',
      wentOffline && refused.json && refused.json.decision === 'block' && /offline/i.test(refused.json.reason) && unchanged && away.ok && back && synced && noGap
        && awayInMirror && chainMirror.ok && finalHost.chain.ok && slowOk === 5 && Math.max(...slow) < 3000,
      `offline in ${fmt(offlineMs)}, reconnect ${fmt(reconnectMs)}, latency p50 ${fmt(pct(slow, 0.5))} max ${fmt(Math.max(...slow))}`);
    ev.metrics.hashes = { host: sha(finalHost.log), mirror: sha(mirrorNow), lines: ids.length };

    ev.step('A10 a token over another link\'s forced command');
    const B = inviteAndAuthorize(code, sshPort, key2 + '.pub');
    ev.secret(B.invite.split('.').pop());
    ev.raw('devbox authorized_keys (both lines)', dexec(['cat', '/home/host/.ssh/authorized_keys']).stdout);
    const wrong = await errOf(client.connect(openSsh(key2), { machine: joinerMachine, token, helloMs: 15000 }));
    const wrongInvite = await errOf(client.connect(openSsh(key), { machine: joinerMachine, invite: B.invite, helloMs: 15000 }));
    ev.log(`bob's token over link ${B.linkId}'s key: ${wrong}`);
    ev.log(`invite B over bob's key (link ${A.linkId}): ${wrongInvite}`);
    ev.check(10, 'a token over the wrong --link ID is AUTH (and an invite over another link\'s key)', /^AUTH/.test(wrong) && /^AUTH/.test(wrongInvite), `${wrong.split(':')[0]}, ${wrongInvite.split(':')[0]}`);

    ev.step('bob leaves; the link daemon exits by itself');
    const end = remote.hook('session-end', { hook_event_name: 'SessionEnd', reason: 'logout' }, bob);
    ev.log(`session-end: ${end.status}`);
    const gone = await until(() => { try { process.kill(daemonPid, 0); return false; } catch { return true; } }, 15000, 100);
    ev.log(`daemon ${daemonPid} exited by itself: ${gone}`);
    ev.raw('host log tail', hostCli('dump').log.split('\n').filter(Boolean).slice(-3).join('\n'));

    ev.step('evidence: compose ps, logs, toxiproxy');
    ev.write('compose-ps.txt', dc(['ps', '-a']).stdout);
    ev.write('compose-logs.txt', dc(['logs', '--no-color', '--timestamps']).stdout);
    ev.write('toxiproxy-proxies.json', JSON.stringify(await toxi(api, 'GET', '/proxies'), null, 2));
    ev.write('devbox-room-files.txt', hostCli('dump').files.join('\n'));
    const sshd = dc(['logs', '--no-color', 'devbox']).stdout.split('\n').filter(l => /Accepted publickey|Connection closed|Disconnected/.test(l));
    ev.raw('devbox sshd: accepted keys and disconnects', sshd.join('\n'));
    const toxLog = dc(['logs', '--no-color', 'toxiproxy']).stdout.split('\n').filter(Boolean);
    ev.raw('toxiproxy log (last 12)', toxLog.slice(-12).join('\n'));
  } catch (e) {
    ev.log(`ERROR: ${e && e.stack || e}`);
    ev.results.push({ n: 0, title: `harness error: ${e && e.message}`, pass: false, detail: '' });
  } finally {
    ev.step('teardown');
    for (const fn of cleanup) fn();
    for (const s of [bob]) if (s) { try { process.kill(s.pid); } catch { /* gone */ } }
    await sleep(500);
    const down = dc(['down', '-v', '--remove-orphans'], { allowFail: true });
    ev.log(`docker compose down -v: exit ${down.status}`);
    for (const m of [remote, remote2]) if (m) for (const d of [m.home, m.user, m.cwd]) fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(keys, { recursive: true, force: true });
    const left = dc(['ps', '-a', '-q'], { allowFail: true }).stdout.trim();
    // what this run left: link/serve processes that were not running before it (another checkout's are not ours)
    const pidsOf = t => new Set(t.split('\n').map(l => l.trim().split(/\s+/)[0]).filter(Boolean));
    const had = pidsOf(before);
    const after = running().split('\n').filter(l => l.trim() && !had.has(l.trim().split(/\s+/)[0])).join('\n');
    const mtimeAfter = realHomeMtime();
    const tmpLeft = [remote, remote2].filter(Boolean).some(m => fs.existsSync(m.home)) || fs.existsSync(keys);
    ev.log(`containers left: ${left || '(none)'}; link/serve processes: ${after || '(none)'}; temp dirs left: ${tmpLeft}`);
    ev.log(`real ~/.sub-human mtime after: ${mtimeAfter} (before ${mtimeBefore})`);
    ev.check(11, 'real ~/.sub-human unchanged; nothing left running; compose down -v', mtimeAfter === mtimeBefore && !left && !after && !tmpLeft && down.status === 0,
      `mtime ${mtimeAfter === mtimeBefore ? 'unchanged' : 'CHANGED'}, containers ${left ? 'LEFT' : 0}, processes ${after ? 'LEFT' : 0}`);
  }
  await report(ev);
  return ev.results.length >= 11 && ev.results.every(r => r.pass);
}

// ---------- the report ----------
/** Chrome headless writes the PNG but may not exit: stop it once the file is written. */
async function screenshot(chrome, html, png) {
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

async function report(ev) {
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
    const { render } = require('../ansi-svg.js');
    const text = ev.lines.join('\n');
    const svg = render(text, { title: 'sub-human remote-docker harness', cols: 160 });
    ev.write('transcript.svg', svg);
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const table = rows.map(r => `<tr class="${r.pass ? 'p' : 'f'}"><td>${r.n || '-'}</td><td>${esc(r.title)}</td><td>${r.pass ? 'PASS' : 'FAIL'}</td><td>${esc(r.detail)}</td></tr>`).join('');
    const html = `<!doctype html><meta charset="utf-8"><title>sub-human remote harness</title><style>body{font:14px system-ui;margin:24px;background:#fff;color:#111}
table{border-collapse:collapse;margin:12px 0}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:top}tr.p td:nth-child(3){color:#0a7d2c;font-weight:600}tr.f td:nth-child(3){color:#c00;font-weight:600}
pre{white-space:pre-wrap}</style><h1>sub-human remote rooms over SSH</h1><p>${allPass ? 'ALL PASS' : 'FAILURES'} · ${esc(new Date().toISOString())}</p>
<table><tr><th>#</th><th>Assertion</th><th>Result</th><th>Evidence</th></tr>${table}</table><pre>${esc(md.split('## Measurements')[1] || '')}</pre>${svg}`;
    ev.write('report.html', html);
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(chrome)) await screenshot(chrome, path.join(ev.dir, 'report.html'), path.join(ev.dir, 'report.png'));
  } catch (e) { ev.log(`report rendering: ${e.message}`); }
  ev.log(`report: ${path.join(ev.dir, 'REPORT.md')}`);
}

// ---------- the manual mode ----------
const manualState = () => JSON.parse(fs.readFileSync(path.join(MANUAL, 'state.json'), 'utf8'));
const opt = (args, flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : dflt; };
/** Run fn with SUB_HUMAN_HOME set to a joiner's home (the plugin libs read it on every call). */
const asJoiner = (j, fn) => { process.env.SUB_HUMAN_HOME = j.home; try { return fn(); } catch { return null; } };
const linkOf = (st, j) => asJoiner(j, () => pluginLib('remote/link.js').status(st.code));

async function up(args) {
  if (fs.existsSync(path.join(MANUAL, 'state.json'))) throw new Error(`already up (${MANUAL}); run down first`);
  const hostSeat = opt(args, '--host-seat', 'alice');
  const names = opt(args, '--joiners', 'bob').split(',').filter(Boolean);
  if (names.includes(hostSeat) || new Set(names).size !== names.length) throw new Error('joiner names must be distinct and differ from --host-seat');
  fs.mkdirSync(MANUAL, { recursive: true, mode: 0o700 });
  const { api, sshPort } = await bringUp(m => console.log(m));
  const setup = hostCli('setup', hostSeat);
  const keys = path.join(MANUAL, 'ssh');
  fs.mkdirSync(keys, { mode: 0o700 });
  const joiners = names.map(name => {
    const key = keygen(keys, name);
    const A = inviteAndAuthorize(setup.code, sshPort, key + '.pub');
    const j = { name, linkId: A.linkId, home: path.join(MANUAL, `${name}-home`), proj: path.join(MANUAL, `${name}-proj`), env: path.join(MANUAL, `${name}.env`) };
    fs.mkdirSync(j.home, { mode: 0o700 });
    fs.mkdirSync(j.proj, { mode: 0o700 });
    sh('git', ['init', '-q', j.proj]);
    const env = [
      `# sub-human remote-docker manual mode, joiner ${name}: source this in the shell you start ${name}'s Claude from.`,
      `# room ${setup.code} in devbox (${hostSeat} is there); link ${A.linkId}; ssh via toxiproxy 127.0.0.1:${sshPort}`,
      `export SUB_HUMAN_HOME='${j.home}'`,
      `export SUB_HUMAN_SSH_OPTS='${sshOpts(key, path.join(keys, `${name}.known_hosts`))}'`,
      `export SUB_HUMAN_INVITE='${A.invite}'`,
      `# then: cd '${j.proj}' && claude --plugin-dir '${PLUGIN}' --remote-control`,
      `# and type: /sub-human join ${name} <the invite: echo $SUB_HUMAN_INVITE>`,
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

async function down() {
  let st = null;
  try { st = manualState(); } catch { /* not up, or half up */ }
  if (st) for (const j of st.joiners || []) {
    const s = linkOf(st, j);
    if (s && s.running) try { process.kill(s.pid, 'SIGTERM'); } catch { /* gone */ }
  }
  const r = dc(['down', '-v', '--remove-orphans'], { allowFail: true });
  fs.rmSync(MANUAL, { recursive: true, force: true });
  console.log(`down: compose exit ${r.status}; removed ${MANUAL} (state, keys, every joiner's home, project and env)`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'run') {
    const i = args.indexOf('--out');
    const out = i >= 0 ? path.resolve(args[i + 1]) : path.join('/tmp', `sub-human-remote-proof-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    const ok = await run({ out });
    console.log(`\n${ok ? 'ALL PASS' : 'FAILED'}: evidence in ${out}`);
    process.exit(ok ? 0 : 1);
  }
  if (cmd === 'up') return up(args);
  if (cmd === 'down') return down();
  const st = manualState();
  if (cmd === 'status') {
    const joiners = st.joiners.map(j => ({ ...j, link: linkOf(st, j) }));
    return console.log(JSON.stringify({ ...st, joiners, proxy: await toxi(st.api, 'GET', `/proxies/${PROXY}`) }, null, 2));
  }
  if (cmd === 'say') {
    if (args[0] === '--to') return console.log(JSON.stringify(hostCli('to', args[1], args.slice(2).join(' '))));
    return console.log(JSON.stringify(hostCli('say', args.join(' '))));
  }
  if (cmd === 'cut' || cmd === 'heal') return console.log(JSON.stringify(await toxi(st.api, 'PATCH', `/proxies/${PROXY}`, { enabled: cmd === 'heal' })));
  if (cmd === 'latency') {
    const ms = Number(args[0]);
    for (const s of ['downstream', 'upstream']) {
      try { await toxi(st.api, 'DELETE', `/proxies/${PROXY}/toxics/lat_${s}`); } catch { /* none */ }
      if (ms > 0) await toxi(st.api, 'POST', `/proxies/${PROXY}/toxics`, { name: `lat_${s}`, type: 'latency', stream: s, attributes: { latency: ms, jitter: 0 } });
    }
    return console.log(`latency ${ms} ms each way`);
  }
  console.error('usage: harness.js run [--out DIR] | up [--host-seat NAME] [--joiners A,B] | status | say [--to NAME] TEXT | cut | heal | latency MS | down');
  process.exit(2);
}

if (require.main === module) main().catch(e => { console.error(e && e.stack || e); process.exit(1); });
module.exports = { run };
