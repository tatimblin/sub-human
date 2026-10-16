/**
 * plugin/sub-human/lib/cli/doctor/claude.ts: doctor's Claude Code checks (lib/cli/doctor.ts).
 *
 *   claudeVersion(env) -> string | null   `claude --version`
 *   checkClaude({version, quick, env}) -> {check, probe?}   claude: the version against cc.MIN_VERSION and
 *       cc.PROBED_VERSION; when it differs from the probed one, unless --quick, the internals probe (cc.probe, ~3 s).
 *       Info "probe could not run" (no probe in the report) when the binary found has no VERSION marker (a launcher), is
 *       another version than `claude --version`, or lacks every internal
 *   checkDaemon({version, status?, exe?}) -> Check   the bg daemon (`claude daemon status`, also with --quick): its
 *       executable deleted since it started (fail: it runs a Claude Code an upgrade removed), its version other than
 *       `claude --version` (warn), not running or unreadable (info). --fix never stops it: the fix line says how
 *   checkRoomClaudes({now?, jobs?}) -> [Check]   room-claude:CODE per open room hosted here: the room's Claude bound
 *       and its process live (pass); its last start failed (spawn_error), or its job started over 90 s ago but never
 *       bound its seat (fail, with the job's state from `claude agents --json --all`)
 *   settingsFiles(env) -> [settings];  checkHooks(settings, env?) -> Check   settings that turn hooks off
 *   checkRemoteControl(env, settings) -> Check   whether Remote Control (the phone) is likely available: it needs a
 *       claude.ai login and is unavailable with Bedrock, Vertex, Foundry or an API key (informational)
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { lib, cli, check, tilde, truthy } from './check.ts';
import type { Check, Report } from '../types.ts';

/** A Claude Code settings file, as the hooks and Remote Control checks read it. */
interface Settings {
  disableAllHooks?: unknown;
  allowManagedHooksOnly?: unknown;
  apiKeyHelper?: unknown;
  env?: Record<string, unknown>;
}
const NO_REMOTE_CONTROL: Record<string, string> = {
  CLAUDE_CODE_USE_BEDROCK: 'Bedrock', CLAUDE_CODE_USE_VERTEX: 'Vertex', CLAUDE_CODE_USE_FOUNDRY: 'Foundry',
  ANTHROPIC_API_KEY: 'an API key', ANTHROPIC_AUTH_TOKEN: 'an auth token',
};

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
  const cannot = (why: string) => ({ check: check('claude', 'info', 'Claude Code', `${version}; internals probe could not run: ${why}`), probe: null });
  let results;
  try {
    const buf = fs.readFileSync(bin);
    // the probe only means something against the binary `claude --version` runs: not a launcher, not another version
    const bv = cc.binaryVersion(buf);
    if (!bv) return cannot(`${tilde(bin)} is not the Claude Code binary (a launcher script?); set CLAUDE_BIN to it`);
    if (cc.compareVersions(bv, version) !== 0) return cannot(`${tilde(bin)} is ${bv} while \`claude --version\` says ${version}; set CLAUDE_BIN to the ${version} binary`);
    results = cc.probe(buf);
  } catch (e) { return cannot((e as Error).message); }
  const missing = results.filter(r => !r.ok).map(r => r.id);
  // every entry missing is a probe that read the wrong thing, not every internal changed at once
  if (missing.length === results.length) return cannot(`none of the ${results.length} internals was found in ${tilde(bin)}; set CLAUDE_BIN to the Claude Code binary`);
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

const ROOM_CLAUDE_BIND_GRACE_MS = 90_000;

const DAEMON_HINT = 'the bg daemon check says whether the daemon runs a Claude Code that was upgraded away since, and how to restart it';
const DAEMON_STOP = 'claude daemon stop --any --keep-workers in a terminal (detached sessions keep running); the next `claude agents` or `claude --bg` starts a fresh daemon';
const RESTART = (code: string) => `then /sub-human NAME ${code} (in the room) starts it again`;

/**
 * Each open room hosted here: the room's Claude bound here and live is a pass. A fail: its last start failed
 * (spawn_error, e.g. the bg daemon crashed the job before its first turn), or its job was started (more than
 * ROOM_CLAUDE_BIND_GRACE_MS ago) but never bound its seat. The job's state (`claude agents --json --all`) tells the
 * kinds apart: failed or stopped crashed before its first turn, done ended its turn without binding, and one still
 * running never took its seat for a reason only its log shows (blocked on a prompt, a refused /sub-human: nothing here
 * records which).
 * jobs: the `claude agents` lookup (tests); called only for a job that never bound.
 */
function checkRoomClaudes({ now = Date.now(), jobs = () => lib('cc.ts').jobs({ all: true }) }: { now?: number, jobs?: () => import('../../cc.ts').AgentJob[] | null } = {}): Check[] {
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
    const bound = !!o.pid && !o.left_at && identity.isMine(o.machine || identity.machineId());
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
      state === 'done'
        ? `the job ended its turn without taking its seat: claude logs ${o.job} shows why; ${DAEMON_HINT}; ${RESTART(code)}`
        : ended
          ? `the job ended before its first turn: claude logs ${o.job} and the bg daemon's log say why; ${DAEMON_HINT}; ${RESTART(code)}`
          : `claude logs ${o.job} shows what it is doing and why it never took its seat; ${DAEMON_HINT}; ${RESTART(code)}`));
  }
  return out;
}

/**
 * The bg daemon (`claude daemon status`): fail when the executable it runs was deleted since it started (Claude Code
 * was upgraded or reinstalled under it; the daemon normally restarts itself for that, CONTRACT daemon-upgrade-exit,
 * and one that did not crashed every room's Claude it started, issue #5), warn when its version is not `claude --version`'s,
 * info when it is not running or its status is unreadable. status, exe: cc.daemonStatus and cc.exeState (tests).
 */
function checkDaemon({ version, env = process.env, status = () => lib('cc.ts').daemonStatus({ env }), exe = (pid: number) => lib('cc.ts').exeState(pid) }: {
  version: string | null; env?: NodeJS.ProcessEnv; status?: () => import('../../cc.ts').DaemonStatus | null; exe?: (pid: number) => { exe: string; deleted: boolean } | null;
}): Check {
  let st: import('../../cc.ts').DaemonStatus | null = null;
  try { st = status(); } catch { st = null; }
  if (!st) return check('daemon', 'info', 'bg daemon', 'could not read `claude daemon status`');
  if (!st.running) return check('daemon', 'info', 'bg daemon', 'not running (the next `claude agents` or `claude --bg` starts one)');
  const who = `pid ${st.pid ?? '?'}${st.version ? `, ${st.version}` : ''}`;
  let x: { exe: string; deleted: boolean } | null = null;
  if (st.pid) { try { x = exe(st.pid); } catch { x = null; } }
  if (x && x.deleted) {
    return check('daemon', 'fail', 'bg daemon', `running (${who}) from ${tilde(x.exe)}, which was deleted since it started (Claude Code was upgraded or reinstalled): background sessions it starts, the room's Claude included, can crash`, DAEMON_STOP);
  }
  const cc = lib('cc.ts');
  if (st.version && version && cc.compareVersions(st.version, version) !== 0) {
    return check('daemon', 'warn', 'bg daemon', `running (${who}) while \`claude --version\` says ${version}: background sessions start on the daemon's version`, DAEMON_STOP);
  }
  return check('daemon', 'pass', 'bg daemon', `running (${who})`);
}

export { claudeVersion, checkClaude, checkDaemon, checkRoomClaudes, settingsFiles, checkHooks, checkRemoteControl };
export type { Settings };
