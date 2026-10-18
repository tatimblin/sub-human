/**
 * plugin/sub-human/lib/cli/doctor/claude.ts: doctor's Claude Code checks (lib/cli/doctor.ts).
 *
 *   claudeVersion(env) -> string | null   `claude --version`
 *   checkClaude({version, quick, env}) -> {check, probe?}   claude: the version against cc.MIN_VERSION and
 *       cc.PROBED_VERSION; when it differs from the probed one, unless --quick, the internals probe (lib/cc/contract.ts
 *       probe, ~3 s); an internal reported changed on that version (CONTRACT degraded) is named in the detail.
 *       Info "probe could not run" (no probe in the report) when the binary found has no VERSION marker (a launcher), is
 *       another version than `claude --version`, or lacks every internal
 *   checkDaemon({version, status?, exe?}) -> Check   the bg daemon (`claude daemon status`, also with --quick): its
 *       executable deleted since it started (fail: it runs a Claude Code an upgrade removed), its version other than
 *       `claude --version` (warn), not running or unreadable (info). --fix never stops it: the fix line says how
 *   checkRoomClaudes({now?, jobs?}) -> [Check]   room-claude:CODE per open room hosted here: the room's Claude bound
 *       and its process live (pass); its last start failed (spawn_error), or its job started over 90 s ago but never
 *       bound its seat (fail, with the job's state from `claude agents --json --all`)
 *   settingsFiles(env) -> [settings];  checkHooks(settings, env?) -> Check   settings that turn hooks off
 *   checkRoomTools({env?, now?}) -> Check   the room's tools (MCP server plugin:sub-human:room): a failed start Claude
 *       Code cached (lib/cc/env.ts mcpFailureLeft) is a warn, since every session started before it expires gets no
 *       room tools (rows, plan edits); else info
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { lib, cli, check, tilde } from './check.ts';
import type { Check, Report } from '../types.ts';
import { msgOf } from '../../errors.ts';
import type { RoomCode } from '../../brand.ts';
import type * as BgMod from '../../cc/bg.ts';

/** A Claude Code settings file, as the hooks check reads it. */
interface Settings {
  disableAllHooks?: unknown;
  allowManagedHooksOnly?: unknown;
  apiKeyHelper?: unknown;
  env?: Record<string, unknown>;
}

function claudeVersion(env: NodeJS.ProcessEnv): string | null {
  const r = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 15_000, env });
  if (r.error || r.status !== 0) return null;
  const m = /(\d+\.\d+\.\d+)/.exec(r.stdout || '');
  return m?.[1] ?? null;
}

function checkClaude({ version, quick, env }: { version: string | null; quick: boolean; env: NodeJS.ProcessEnv }): { check: Check; probe?: Report['probe'] } {
  const cc = lib('cc/contract.ts');
  if (!version) return { check: check({ id: 'claude', status: 'warn', title: 'Claude Code', detail: 'no `claude` on PATH here', fix: 'install Claude Code, or put it on PATH for this shell' }) };
  if ((cc.compareVersions(version, cc.MIN_VERSION) ?? 0) < 0) { // null (unreadable) is not older
    return { check: check({ id: 'claude', status: 'fail', title: 'Claude Code', detail: `${version}; sub-human needs ${cc.MIN_VERSION}+ (function hooks)`, fix: 'update Claude Code (claude update)' }) };
  }
  const same = cc.compareVersions(version, cc.PROBED_VERSION) === 0;
  // an internal reported to have changed on this version, which the probe may not see (CONTRACT degraded)
  const deg = cc.degradedOn(version);
  const degraded = deg.length ? `; reported changed on this version: ${deg.map(d => d.issue ? `${d.id} (#${d.issue})` : d.id).join(', ')}` : '';
  if (same) return { check: check({ id: 'claude', status: 'pass', title: 'Claude Code', detail: `${version}, the version its internals were checked on${degraded}` }) };
  if (quick) {
    return { check: check({ id: 'claude', status: 'info', title: 'Claude Code', detail: `${version}; internals last checked on ${cc.PROBED_VERSION} (run without --quick to check them)${degraded}` }) };
  }
  const bin = cc.locateBinary({ env });
  if (!bin) return { check: check({ id: 'claude', status: 'info', title: 'Claude Code', detail: `${version}; the binary was not found to check its internals` }) };
  const cannot = (why: string) => ({ check: check({ id: 'claude', status: 'info', title: 'Claude Code', detail: `${version}; internals probe could not run: ${why}` }), probe: null });
  let results;
  try {
    const buf = fs.readFileSync(bin);
    // the probe only means something against the binary `claude --version` runs: not a launcher, not another version
    const bv = cc.binaryVersion(buf);
    if (!bv) return cannot(`${tilde(bin)} is not the Claude Code binary (a launcher script?); set CLAUDE_BIN to it`);
    if (cc.compareVersions(bv, version) !== 0) return cannot(`${tilde(bin)} is ${bv} while \`claude --version\` says ${version}; set CLAUDE_BIN to the ${version} binary`);
    results = cc.probe(buf);
  } catch (e) { return cannot(msgOf(e)); }
  const missing = results.filter(r => !r.ok).map(r => r.id);
  // every entry missing is a probe that read the wrong thing, not every internal changed at once
  if (missing.length === results.length) return cannot(`none of the ${results.length} internals was found in ${tilde(bin)}; set CLAUDE_BIN to the Claude Code binary`);
  if (!missing.length) return { check: check({ id: 'claude', status: 'pass', title: 'Claude Code', detail: `${version}; all ${results.length} internals sub-human relies on are present${degraded}` }), probe: { total: results.length, missing } };
  return {
    check: check({ id: 'claude', status: 'warn', title: 'Claude Code', detail: `${version}; ${missing.length} of ${results.length} internals changed since ${cc.PROBED_VERSION}: ${missing.join(', ')}${degraded}`, fix: `update sub-human (/plugin update sub-human); if it persists, report it with ${cli('doctor --bundle')}` }),
    probe: { total: results.length, missing },
  };
}

function settingsFiles(env: NodeJS.ProcessEnv): Settings[] {
  const cc = lib('cc/env.ts');
  // a settings file is read defensively: each check reads one field
  return cc.userSettingsFiles(process.cwd(), env).map((f): unknown => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } })
    .filter((s): s is Settings => !!s && typeof s === 'object');
}

function checkHooks(settings: Settings[], env: NodeJS.ProcessEnv = process.env): Check {
  if (settings.some(s => s.disableAllHooks === true)) {
    return check({ id: 'hooks', status: 'fail', title: 'hooks', detail: 'a settings file sets disableAllHooks: sub-human\'s hooks and hooks module never run', fix: 'remove disableAllHooks from your Claude Code settings' });
  }
  if (settings.some(s => s.allowManagedHooksOnly === true)) {
    return check({ id: 'hooks', status: 'fail', title: 'hooks', detail: 'a settings file sets allowManagedHooksOnly: only managed hooks run, so sub-human cannot join a room', fix: 'ask whoever manages this machine\'s Claude Code settings, or remove allowManagedHooksOnly from yours' });
  }
  if (lib('cc/env.ts').modulesSwitch(env) === false) {
    return check({ id: 'hooks', status: 'fail', title: 'hooks', detail: 'Claude Code has plugin hooks modules switched off for now (its saved switch), so sub-human cannot join a room', fix: 'restart claude with network access, which refreshes the switch; if this stays, hooks modules are off for your account' });
  }
  return check({ id: 'hooks', status: 'pass', title: 'hooks', detail: 'no settings file turns hooks off; hooks modules are on' });
}

/** The room server's name in Claude Code (its key in .mcp.json, plugin-scoped). */
const ROOM_SERVER = 'plugin:sub-human:room';
function checkRoomTools({ env = process.env, now = Date.now() }: { env?: NodeJS.ProcessEnv; now?: number } = {}): Check {
  const left = lib('cc/env.ts').mcpFailureLeft(ROOM_SERVER, { env, now });
  if (left == null) return check({ id: 'room-tools', status: 'info', title: 'room tools', detail: 'no failed start of the room\'s tools recorded by Claude Code' });
  return check({ id: 'room-tools', status: 'warn', title: 'room tools',
    detail: `the room's tools (${ROOM_SERVER}) failed to start in a session here; Claude Code skips them in every session started in the next ${Math.ceil(left / 60_000)} min (no room rows or plan edits there; SendMessage and @room still work)`,
    fix: `in a session, /mcp and reconnect ${ROOM_SERVER}; if it fails again, run node on the plugin's mcp/room-server.ts to see why, and report it` });
}

const ROOM_CLAUDE_BIND_GRACE_MS = 90_000;

const DAEMON_HINT = 'the bg daemon check says whether the daemon runs a Claude Code that was upgraded away since, and how to restart it';
const DAEMON_STOP = 'claude daemon stop --any --keep-workers in a terminal (detached sessions keep running); the next `claude agents` or `claude --bg` starts a fresh daemon';
const RESTART = (code: RoomCode) => `then /sub-human NAME ${code} (in the room) starts it again`;

/**
 * Each open room hosted here: the room's Claude bound here and live is a pass. A fail: its last start failed
 * (spawn_error, e.g. the bg daemon crashed the job before its first turn), or its job was started (more than
 * ROOM_CLAUDE_BIND_GRACE_MS ago) but never bound its seat. The job's state (`claude agents --json --all`) tells the
 * kinds apart: failed or stopped crashed before its first turn, done ended its turn without binding, and one still
 * running never took its seat for a reason only its log shows (blocked on a prompt, a refused /sub-human: nothing here
 * records which).
 * jobs: the `claude agents` lookup (tests); called only for a job that never bound.
 */
function checkRoomClaudes({ now = Date.now(), jobs = () => lib('cc/bg.ts').jobs({ all: true }) }: { now?: number, jobs?: () => BgMod.AgentJob[] | null } = {}): Check[] {
  const identity = lib('identity.ts');
  const out: Check[] = [];
  let codes: RoomCode[] = [];
  try { codes = identity.openRooms().filter(c => identity.isHost(c)); } catch { return out; }
  for (const code of codes) {
    let o;
    try { o = identity.readMembers(code).claude; } catch { continue; }
    if (!o || o.job === 'pending' || o.stopped_at || o.closing) continue;
    if (!o.job) {
      if (o.spawn_error && !o.left_at) {
        out.push(check({ id: `room-claude:${code}`, status: 'fail', title: `room's Claude ${code}`, detail: `its last start failed: ${o.spawn_error}: the room's Claude is not running`, fix: `claude agents --all and the bg daemon's log say why; ${DAEMON_HINT}; ${RESTART(code)}` }));
      }
      continue;
    }
    const since = Date.parse(o.spawned_at || '') || now;
    const bound = !!o.pid && !o.left_at && identity.isMine(o.machine || identity.machineId());
    if (bound && identity.seatAlive(Object.assign({ name: 'claude' }, o))) {
      out.push(check({ id: `room-claude:${code}`, status: 'pass', title: `room's Claude ${code}`, detail: `bound and live: job ${o.job}, pid ${o.pid}` }));
      continue;
    }
    if (bound || now - since < ROOM_CLAUDE_BIND_GRACE_MS) continue;
    let state: string | null = null;
    try { state = (jobs() ?? []).find(j => j.id === o.job)?.state || null; } catch { state = null; }
    const ended = !!state && ['done', 'failed', 'stopped'].includes(state);
    const why = o.spawn_error ? ` (${o.spawn_error})` : '';
    out.push(check({ id: `room-claude:${code}`, status: 'fail', title: `room's Claude ${code}`, detail: `its job ${o.job} was started ${Math.round((now - since) / 1000)} s ago but never took its seat${state ? `; the job is ${state}` : ''}${why}: the room's Claude is not running`, fix: state === 'done'
        ? `the job ended its turn without taking its seat: claude logs ${o.job} shows why; ${DAEMON_HINT}; ${RESTART(code)}`
        : ended
          ? `the job ended before its first turn: claude logs ${o.job} and the bg daemon's log say why; ${DAEMON_HINT}; ${RESTART(code)}`
          : `claude logs ${o.job} shows what it is doing and why it never took its seat; ${DAEMON_HINT}; ${RESTART(code)}` }));
  }
  return out;
}

/**
 * The bg daemon (`claude daemon status`): fail when the executable it runs was deleted since it started (Claude Code
 * was upgraded or reinstalled under it; the daemon normally restarts itself for that, CONTRACT daemon-upgrade-exit,
 * and one that did not crashed every room's Claude it started, issue #5), warn when its version is not `claude --version`'s,
 * info when it is not running or its status is unreadable. status, exe: cc.daemonStatus and cc.exeState (tests).
 */
function checkDaemon({ version, env = process.env, status = () => lib('cc/bg.ts').daemonStatus({ env }), exe = (pid: number) => lib('cc/bg.ts').exeState(pid) }: {
  version: string | null; env?: NodeJS.ProcessEnv; status?: () => BgMod.DaemonStatus | null; exe?: (pid: number) => { exe: string; deleted: boolean } | null;
}): Check {
  let st: BgMod.DaemonStatus | null = null;
  try { st = status(); } catch { st = null; }
  if (!st) return check({ id: 'daemon', status: 'info', title: 'bg daemon', detail: 'could not read `claude daemon status`' });
  if (!st.running) return check({ id: 'daemon', status: 'info', title: 'bg daemon', detail: 'not running (the next `claude agents` or `claude --bg` starts one)' });
  const who = `pid ${st.pid ?? '?'}${st.version ? `, ${st.version}` : ''}`;
  let x: { exe: string; deleted: boolean } | null = null;
  if (st.pid) { try { x = exe(st.pid); } catch { x = null; } }
  if (x && x.deleted) {
    return check({ id: 'daemon', status: 'fail', title: 'bg daemon', detail: `running (${who}) from ${tilde(x.exe)}, which was deleted since it started (Claude Code was upgraded or reinstalled): background sessions it starts, the room's Claude included, can crash`, fix: DAEMON_STOP });
  }
  const cc = lib('cc/contract.ts');
  if (st.version && version && cc.compareVersions(st.version, version) !== 0) {
    return check({ id: 'daemon', status: 'warn', title: 'bg daemon', detail: `running (${who}) while \`claude --version\` says ${version}: background sessions start on the daemon's version`, fix: DAEMON_STOP });
  }
  return check({ id: 'daemon', status: 'pass', title: 'bg daemon', detail: `running (${who})` });
}

export { claudeVersion, checkClaude, checkDaemon, checkRoomClaudes, settingsFiles, checkHooks, checkRoomTools };
export type { Settings };
