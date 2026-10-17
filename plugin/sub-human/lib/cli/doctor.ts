/**
 * plugin/sub-human/lib/cli/doctor.ts: `sub-human doctor`, what is wrong with this machine's sub-human and how to fix
 * it, and `doctor --bundle`, the same as redacted JSON to attach to a bug report. Read only, except --fix (the
 * shim refresh, the home's modes) and the bundle file. scripts/sub-human dispatches here. The checks live by subject in
 * lib/cli/doctor/: links.ts (the links, keyed on the typed reasons the link daemon records), ssh.ts (the shim, ssh
 * and its stderr), listener.ts (the web listener), claude.ts (Claude Code, the bg daemon, the
 * room's Claude, hooks), redact.ts (the bundle); check.ts what they share.
 *
 * --fix refreshes the serve shim and pointer (lib/remote/shim.ts refresh) and repairs the home's modes (lib/home.ts
 * repairModes); --json is unredacted (it stays on this machine); --quick skips the hello to each link's host and the
 * Claude Code internals probe. Exit 1 when a check fails. Each check is {id, status: pass|warn|fail|info, title,
 * detail, fix?}; the doctor/ modules' checks are re-exported here for the tests.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lib, cli, check, tilde, PLUGIN_ROOT, DOCTOR_HELLO_MS } from './doctor/check.ts';
import { checkShim, sshVersion, checkSsh, sshHint } from './doctor/ssh.ts';
import { diagnoseLink, linkChecks, helloProbe } from './doctor/links.ts';
import { checkListener } from './doctor/listener.ts';
import { roomChecks, verifyRoom, verifyText } from './doctor/rooms.ts';
import { claudeVersion, checkClaude, checkDaemon, checkRoomClaudes, settingsFiles, checkHooks } from './doctor/claude.ts';
import { bundle, redactor } from './doctor/redact.ts';
import type { Check, CheckStatus, DoctorOptions, Report } from './types.ts';
import { parse } from './args.ts';


/** 24.3: the first 24 that strips TypeScript without an ExperimentalWarning (every hook is .ts). */
const NODE_MIN = [24, 3] as const;
const STORE_DIRS = ['rooms', 'sessions', 'links', 'keys', 'bin'];

function pluginVersion(): string | null {
  let v: unknown;
  try { v = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')); } catch { return null; }
  return v && typeof v === 'object' && 'version' in v && typeof v.version === 'string' && v.version ? v.version : null;
}

function checkPlugin() {
  const v = pluginVersion();
  return check({ id: 'plugin', status: v ? 'pass' : 'warn', title: 'plugin', detail: `sub-human ${v || '(no version in plugin.json)'} at ${tilde(PLUGIN_ROOT)}` });
}

function checkNode(version: string = process.versions.node): Check {
  const [major = NaN, minor = NaN] = String(version).split('.').map(Number);
  const min = NODE_MIN.join('.');
  return major > NODE_MIN[0] || (major === NODE_MIN[0] && minor >= NODE_MIN[1])
    ? check({ id: 'node', status: 'pass', title: 'node', detail: `v${version}` })
    : check({ id: 'node', status: 'fail', title: 'node', detail: `v${version}; sub-human needs Node ${min} or newer`, fix: `install Node ${min}+ (e.g. nvm install ${NODE_MIN[0]}); the hooks run on the node Claude Code finds on PATH` });
}

function checkHome() {
  const h = lib('home.ts').home();
  if (!fs.existsSync(h)) return check({ id: 'home', status: 'info', title: 'sub-human folder', detail: `${tilde(h)} does not exist yet (made at the first join)` });
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const bad: string[] = [];
  for (const d of [h, ...STORE_DIRS.map(n => path.join(h, n))]) {
    let st;
    try { st = fs.statSync(d); } catch { continue; }
    if (uid !== null && st.uid !== uid) bad.push(`${tilde(d)} belongs to uid ${st.uid}`);
    else if (st.mode & 0o077) bad.push(`${tilde(d)} is ${(st.mode & 0o777).toString(8)}`);
  }
  if (!bad.length) return check({ id: 'home', status: 'pass', title: 'sub-human folder', detail: `${tilde(h)} and its folders are private (0700)` });
  return check({ id: 'home', status: 'fail', title: 'sub-human folder', detail: bad.join('; '), fix: `${cli('doctor --fix')} in a terminal (or chmod 700 ${bad.map(b => b.split(' ')[0]).join(' ')})` });
}

async function diagnose({ quick = false, timeoutMs = DOCTOR_HELLO_MS, env = process.env }: { quick?: boolean; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<Report> {
  const checks = [checkPlugin(), checkNode(), checkHome()];
  const codes = lib('room/links.ts').list();
  const sshLinks = codes.some(c => lib('room/links.ts').get(c)?.transport?.kind === 'ssh');
  checks.push(checkShim());
  const sshV = sshVersion();
  checks.push(checkSsh({ needed: sshLinks, version: sshV }));
  const links = await Promise.all(codes.map(code => diagnoseLink(code, { quick, timeoutMs, env })));
  if (!codes.length) checks.push(check({ id: 'links', status: 'info', title: 'connections', detail: 'none to a room hosted on another machine' }));
  for (const d of links) checks.push(...linkChecks(d));
  checks.push(...roomChecks());
  checks.push(...checkRoomClaudes());
  const cv = claudeVersion(env);
  const cl = checkClaude({ version: cv, quick, env });
  checks.push(cl.check, checkDaemon({ version: cv, env }));
  const settings = settingsFiles(env);
  checks.push(checkHooks(settings, env));
  checks.push(...checkListener({ quick }));
  return {
    generated_at: new Date().toISOString(),
    versions: { plugin: pluginVersion(), node: process.versions.node, claude: cv, protocol: lib('remote/protocol.ts').PROTO, ssh: sshV, platform: process.platform, arch: process.arch, os: os.release() },
    checks, links, probe: cl.probe ?? null,
  };
}

const MARK: Record<CheckStatus, string> = { pass: '✓', warn: '!', fail: '✗', info: '·' };
const PAINT: Record<CheckStatus, string> = { pass: '32', warn: '33', fail: '31', info: '2' };

function format(report: Report, { color = false }: { color?: boolean } = {}): string {
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
  const { flags: f, rest, error } = parse(args, { quick: 0, fix: 0, json: 0, bundle: '?', timeout: 1 });
  if (rest.length) throw new Error(`usage: sub-human doctor [--quick] [--fix] [--json] [--bundle [FILE]] [--timeout MS] (not ${rest[0]})`);
  if (error) throw new Error('--timeout needs a number of milliseconds');
  const o: DoctorOptions = {
    quick: !!f.quick, fix: !!f.fix, json: !!f.json, bundle: f.bundle === undefined ? null : f.bundle === true ? '' : f.bundle,
    timeoutMs: f.timeout === undefined ? DOCTOR_HELLO_MS : Number(f.timeout),
  };
  if (!(o.timeoutMs > 0)) throw new Error('--timeout needs a number of milliseconds');
  return o;
}

function applyFix(write: (s: string) => void) {
  const h = lib('home.ts');
  const done: string[] = [];
  if (fs.existsSync(h.home())) {
    const changed = h.repairModes();
    if (changed.length) done.push(`made ${changed.map(d => tilde(d)).join(', ')} 0700`);
    const shim = lib('remote/shim.ts');
    const r = shim.refresh({ force: true });
    done.push(r ? `the serve shim and pointer name ${tilde(shim.pluginRoot())} and ${tilde(process.execPath)}` : `the plugin root ${tilde(shim.pluginRoot())} is under a temp dir: the shim was not written`);
  }
  for (const d of done) write(`fixed: ${d}\n`);
}

async function main(args: readonly string[], { write = (s: string) => { process.stdout.write(s); }, env = process.env }: { write?: (s: string) => void; env?: NodeJS.ProcessEnv } = {}): Promise<number> {
  const o = parseArgs(args);
  if (o.fix) applyFix(write);
  const report = await diagnose({ quick: o.quick, timeoutMs: o.timeoutMs, env });
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
  diagnose, format, bundle, redactor, helloProbe, checkListener, checkRoomClaudes, linkChecks,
  checkNode, checkClaude, checkDaemon, sshHint, main, parseArgs, DOCTOR_HELLO_MS, roomChecks, verifyRoom, verifyText,
};
