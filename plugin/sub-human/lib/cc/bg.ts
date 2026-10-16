/**
 * plugin/sub-human/lib/cc/bg.ts: `claude --bg` jobs (the room's Claude), the bg daemon and the env it keeps from a dispatch.
 *
 * `@cc` tags as in lib/cc/env.ts. The runners take a spawnSync stand-in (`run`) so tests spawn nothing.
 *
 *   JOB_RE, parseDispatch(text), agentsCmd(all), stopCmd(id), parseAgentsJson(text), jobs(opts)
 *   parseDaemonStatus(text), daemonStatus(opts)   `claude daemon status`: {running, pid, version}
 *   exeState(pid, {readlink?, ps?, exists?}) -> {exe, deleted}|null   the executable a process runs, and whether it
 *                                        was deleted since (an upgrade): /proc/PID/exe on Linux, `ps -o comm=` elsewhere
 *   runningVersion(pid) -> string|null   the version the Claude Code process pid runs (exeState's path, else --version)
 *   DAEMON_ENV_ALLOW, daemonEnv(env)     the keys the daemon keeps from a dispatch: contract.json daemon-env-allowlist's
 *                                        `contains` groups, which the probe checks are still in the binary's arrays
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { CONTRACT } from './contract.ts';
import { envStr } from '../env.ts';

type Env = NodeJS.ProcessEnv;

/** One `claude agents --json` row (parseAgentsJson): missing fields null. */
interface AgentJob {
  pid: number | null;
  id: string | null;
  sessionId: string | null;
  status: string | null;
  state: string | null;
  kind: string | null;
  name: string | null;
  cwd: string | null;
  startedAt: number | null;
}

/**
 * `claude --bg` prints "backgrounded · <short id> · <name>" on stdout (no --json for --bg).
 * @cc backgrounded \xB7
 * @stability incidental
 */
const JOB_RE: RegExp = /backgrounded\s*·\s*([0-9a-z]{4,40})\b/i;

/**
 * The job id from `claude --bg` output, or null.
 * @cc backgrounded \xB7
 * @stability incidental
 */
function parseDispatch(text: unknown): string | null {
  const m = JOB_RE.exec(String(text || ''));
  return m?.[1] ?? null;
}

/**
 * argv for the machine-readable session list. Without --all, finished bg jobs are left out.
 * @cc isAgentsJsonInvocation
 * @stability API
 */
const agentsCmd = (all = false): string[] => (all ? ['agents', '--json', '--all'] : ['agents', '--json']);

/**
 * argv to stop a bg session (prints "stopped <id>"; the conversation is kept).
 * @cc Stop a background session. Its conversation is kept
 * @stability API
 */
const stopCmd = (id: unknown): string[] => ['stop', String(id)];

/**
 * Parse `claude agents --json` stdout into [{pid, id, sessionId, status, state, kind, name, cwd, startedAt}]
 * (missing fields null; interactive sessions have no id), or null when it isn't a JSON array.
 * status: idle|waiting|busy (live only); state: working|blocked|done|failed|stopped (bg only).
 * @cc pass its full session id (lowercase, as `claude agents --json` prints it)
 * @stability API
 */
function parseAgentsJson(text: unknown): AgentJob[] | null {
  let a: unknown;
  try { a = JSON.parse(String(text || '')); } catch { return null; }
  if (!Array.isArray(a)) return null;
  const s = (x: unknown): string | null => (typeof x === 'string' ? x : null);
  return a.filter(j => j && typeof j === 'object').map((j: Record<string, unknown>) => ({
    pid: Number.isInteger(j.pid) && (j.pid as number) > 0 ? j.pid as number : null,
    id: s(j.id), sessionId: s(j.sessionId), status: s(j.status), state: s(j.state),
    kind: s(j.kind), name: s(j.name), cwd: s(j.cwd), startedAt: Number.isFinite(j.startedAt) ? j.startedAt as number : null,
  }));
}

/** jobs() options; run: a spawnSync stand-in (tests). */
interface JobsOpts {
  all?: boolean;
  bin?: string;
  env?: Env;
  timeout?: number;
  run?: (bin: string, args: string[], opts: SpawnSyncOptionsWithStringEncoding) => { error?: Error; status: number | null; stdout: string } | null;
}

/**
 * Run `claude agents --json [--all]` and parse it: the array, or null when the command fails or prints
 * something else (callers then fall back to the id they parsed with JOB_RE at dispatch).
 * opts: {all, bin = SUB_HUMAN_CLAUDE || 'claude', env, timeout = 15000, run = spawnSync}.
 * @cc isAgentsJsonInvocation
 * @stability API
 */
function jobs({ all = false, bin = envStr('SUB_HUMAN_CLAUDE') || 'claude', env = process.env, timeout = 15_000, run = spawnSync }: JobsOpts = {}): AgentJob[] | null {
  let r;
  try { r = run(bin, agentsCmd(all), { env, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return null; }
  if (!r || r.error || r.status !== 0) return null;
  return parseAgentsJson(r.stdout);
}

/** `claude daemon status` as parseDaemonStatus reads it: running with its pid and version, or not running. */
interface DaemonStatus { running: boolean; pid: number | null; version: string | null }

/**
 * Parse `claude daemon status` stdout: "pid:     N" and "version: X" lines while the bg daemon runs, else "not
 * running" (and exit 1). {running, pid, version} (pid or version null when its line is missing or unreadable), or
 * null when the text is neither.
 * @cc Show daemon pid, version, uptime
 * @stability incidental
 */
function parseDaemonStatus(text: unknown): DaemonStatus | null {
  const t = String(text || '');
  const pid = /^pid:\s+(\d+)\s*$/m.exec(t);
  const version = /^version:\s+(\S+)\s*$/m.exec(t);
  if (pid || version) return { running: true, pid: pid && Number(pid[1]) > 0 ? Number(pid[1]) : null, version: version?.[1] ?? null };
  return /^not running\b/m.test(t) ? { running: false, pid: null, version: null } : null;
}

/**
 * Run `claude daemon status` and parse it (parseDaemonStatus): its exit status is not checked, as "not running"
 * exits 1. null when the command cannot be spawned or prints something else. Options as jobs() (no `all`).
 * @cc Show daemon pid, version, uptime
 * @stability incidental
 */
function daemonStatus({ bin = envStr('SUB_HUMAN_CLAUDE') || 'claude', env = process.env, timeout = 15_000, run = spawnSync }: Omit<JobsOpts, 'all'> = {}): DaemonStatus | null {
  let r;
  try { r = run(bin, ['daemon', 'status'], { env, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return null; }
  if (!r || r.error) return null;
  return parseDaemonStatus(r.stdout);
}

// ---------- the daemon's env allowlist ----------

/**
 * The env keys the bg daemon keeps from a `claude --bg` dispatch: every name of contract.json daemon-env-allowlist's
 * `contains` groups (the base set, l5n and the extra keys in 2.1.296; cc-2.1.292.md and cc-2.1.296.md list what each
 * release added). Every other caller env key (CLAUDE_CODE_TASK_LIST_ID, SUB_HUMAN_*, HOME, ...) is dropped; the worker
 * runs with the daemon's own process.env plus these. Auth secrets (ANTHROPIC_API_KEY, ...) are not in it. Pass state to
 * a bg job through argv (`--settings '{"env":{...}}'`) instead.
 * @cc daemon_bg_dispatch_ingest
 * @stability env
 */
const DAEMON_ENV_ALLOW: readonly string[] = Object.freeze([...new Set(
  (CONTRACT.find(e => e.id === 'daemon-env-allowlist')?.contains || []).flatMap(g => g.names),
)]);
const DAEMON_ENV_SET = new Set(DAEMON_ENV_ALLOW);

/**
 * env reduced to what the daemon would keep from it (exact, case-sensitive key match, as the daemon does).
 * @cc daemon_bg_dispatch_ingest
 * @stability env
 */
function daemonEnv(env: Env = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (DAEMON_ENV_SET.has(k) && v !== undefined) out[k] = v;
  return out;
}

// ---------- the executable a process runs ----------

/** exeState() options: stand-ins for the system calls (tests). */
interface ExeStateOpts {
  readlink?: (p: string) => string;
  ps?: (pid: number) => string | null;
  exists?: (p: string) => boolean;
  timeoutMs?: number;
}

/**
 * The executable process pid runs, and whether it was deleted since it started (an upgrade replaced it), or null
 * (no such process, nothing readable). Linux: /proc/PID/exe, whose link reads "<path> (deleted)" then. Elsewhere
 * (macOS): `ps -o comm=`, deleted when that is an absolute path that no longer exists; a bare name (started
 * through PATH) says nothing, so deleted is false.
 */
function exeState(pid: unknown, { readlink = fs.readlinkSync, exists = fs.existsSync, timeoutMs = 3000,
  ps = (p: number) => String(spawnSync('ps', ['-o', 'comm=', '-p', String(p)], { encoding: 'utf8', timeout: timeoutMs }).stdout || '') }: ExeStateOpts = {}): { exe: string; deleted: boolean } | null {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return null;
  let link: string | null = null;
  try { link = String(readlink(`/proc/${n}/exe`)); } catch { /* not Linux, or no such process */ }
  if (link) return link.endsWith(' (deleted)') ? { exe: link.slice(0, -' (deleted)'.length), deleted: true } : { exe: link, deleted: false };
  let exe: string | null;
  try { exe = String(ps(n) || '').trim() || null; } catch { exe = null; }
  if (!exe) return null;
  return { exe, deleted: path.isAbsolute(exe) && !exists(exe) };
}

/**
 * The version of the Claude Code process pid runs, or null: its executable's path (exeState, symlinks resolved) when
 * the path names one (the cask's …/2.1.292/claude, the installer's versions/2.1.292), else `<that binary>
 * --version` while it still exists. Used only to word a refusal (lib/commands/index.ts noModule).
 */
function runningVersion(pid: unknown, { timeoutMs = 3000 }: { timeoutMs?: number } = {}): string | null {
  const st = exeState(pid, { timeoutMs });
  if (!st) return null;
  let exe = st.exe;
  try { exe = fs.realpathSync(exe); } catch { /* as ps gave it */ }
  const inPath = /(?:^|\/)(\d+\.\d+\.\d+)(?:\/|$)/.exec(exe);
  if (inPath?.[1]) return inPath[1];
  if (!path.isAbsolute(exe) || st.deleted) return null;
  const r = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: timeoutMs });
  const m = /(\d+\.\d+\.\d+)/.exec(String(r.stdout || ''));
  return m?.[1] ?? null;
}

export {
  JOB_RE, parseDispatch, agentsCmd, stopCmd, parseAgentsJson, jobs, parseDaemonStatus, daemonStatus, exeState,
  runningVersion, DAEMON_ENV_ALLOW, daemonEnv,
};
export type { AgentJob, JobsOpts, DaemonStatus, ExeStateOpts };
