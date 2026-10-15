/**
 * plugin/sub-human/lib/cli/doctor.ts: `sub-human doctor`, what is wrong with this machine's sub-human and how to fix
 * it, and `doctor --bundle`, the same as redacted JSON to attach to a bug report. Read only, except --fix (the
 * shim refresh, the home's modes) and the bundle file. scripts/sub-human dispatches here. The checks live by subject in
 * lib/cli/doctor/: links.ts (the links, keyed on the typed reasons the link daemon records), ssh.ts (the shim,
 * authorized_keys, ssh and its stderr), listener.ts (the web listener), claude.ts (Claude Code, the bg daemon, the
 * room's Claude, hooks, Remote Control), redact.ts (the bundle); check.ts what they share.
 *
 *   sub-human doctor [--quick] [--fix] [--json] [--bundle [FILE]] [--authorized-keys FILE] [--timeout MS]
 *       --quick    skip the slow checks: the hello to each link's host and the Claude Code internals probe
 *       --fix      first refresh the serve shim and pointer (lib/remote/shim.ts refresh), remove the enrollment door
 *                  lines a 0.5.0-beta.15 ssh invite left in authorized_keys, and repair the home's
 *                  modes (lib/home.ts repairModes)
 *       --json     the report as JSON (unredacted: it stays on this machine)
 *       --bundle   write the redacted bundle (default ./sub-human-doctor-<time>.json) and print its path
 *       --authorized-keys   the file to scan (default ~/.ssh/authorized_keys)
 *       --timeout  the hello's deadline per link (default DOCTOR_HELLO_MS, 8 s)
 *   Exit 1 when a check fails, else 0.
 *
 * Checks, each {id, status: pass|warn|fail|info, title, detail, fix?}, in this order:
 *   plugin, node (24.3 or newer), home (the home and its store directories are 0700 and this user's): here
 *   shim, authorized_keys, ssh: doctor/ssh.ts;  link:CODE, clock:CODE: doctor/links.ts
 *   room-claude:CODE, claude, daemon, hooks, remote_control: doctor/claude.ts;  listener, web:CODE: doctor/listener.ts
 *
 *   diagnose(opts) -> Promise<Report>   Report = {generated_at, versions, checks, links, authorizedKeys}
 *   format(report, {color}?) -> string
 *   main(args) -> Promise<exitCode>;  parseArgs(args) -> options (lib/cli/args.ts; Error with the usage)
 *   checkNode(version?), and every check the doctor/ modules export, re-exported here for the tests
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { lib, cli, check, tilde, PLUGIN_ROOT, DOCTOR_HELLO_MS } from './doctor/check.ts';
import { checkShim, scanAuthorizedKeys, checkAuthorizedKeys, sshVersion, checkSsh, sshHint } from './doctor/ssh.ts';
import { diagnoseLink, linkChecks, helloProbe } from './doctor/links.ts';
import { checkListener } from './doctor/listener.ts';
import { claudeVersion, checkClaude, checkDaemon, checkRoomClaudes, settingsFiles, checkHooks, checkRemoteControl } from './doctor/claude.ts';
import { bundle, redactor } from './doctor/redact.ts';
import type { CheckStatus, DoctorOptions, Report } from './types.ts';

const require = createRequire(import.meta.url);

/** 24.3: the first 24 that strips TypeScript without an ExperimentalWarning (every hook is .ts). */
const NODE_MIN = [24, 3];
const STORE_DIRS = ['rooms', 'sessions', 'links', 'keys', 'bin'];

function pluginVersion(): string | null {
  try { return JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version || null; } catch { return null; }
}

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
  checks.push(cl.check, checkDaemon({ version: cv, env }));
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
  }
  // the enrollment doors a 0.5.0-beta.15 ssh invite left: they only answer "update" now
  const akFile = authorizedKeys || path.join(os.homedir(), '.ssh', 'authorized_keys');
  const scan = scanAuthorizedKeys(akFile);
  const sk = lib('remote/sshkeys.ts');
  let gone = 0;
  for (const code of new Set(scan.doors || [])) { try { gone += sk.removeTagged(akFile, sk.ENROLL_TAG(code)); } catch { /* left for by hand */ } }
  if (gone) done.push(`removed ${gone} enrollment door line(s) an older sub-human left in ${tilde(akFile)}`);
  for (const d of done) write(`fixed: ${d}\n`);
}

async function main(args: readonly string[], { write = (s: string) => { process.stdout.write(s); }, env = process.env }: { write?: (s: string) => void; env?: NodeJS.ProcessEnv } = {}): Promise<number> {
  const o = parseArgs(args);
  if (o.fix) applyFix(write, { authorizedKeys: o.authorizedKeys });
  const report = await diagnose({ quick: o.quick, timeoutMs: o.timeoutMs, authorizedKeys: o.authorizedKeys, env });
  if (o.bundle !== null) {
    const file = path.resolve(o.bundle || `sub-human-doctor-${report.generated_at.replace(/[:.]/g, '-')}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); // a folder named for the bundle may not exist yet
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
  checkNode, checkRemoteControl, checkClaude, checkDaemon, sshHint, main, parseArgs, DOCTOR_HELLO_MS,
};
