/**
 * plugin/sub-human/lib/cc/bg.ts: `claude --bg` jobs (the room's Claude), the bg daemon and the env a `claude --bg` client is
 * handed (clientEnv).
 *
 * `@cc` tags as in lib/cc/env.ts. The runners take a spawnSync stand-in (`run`) so tests spawn nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { envStr } from '../env.ts';

type Env = NodeJS.ProcessEnv;

/**
 * One `claude agents --json` row (parseAgentsJson): missing fields null.
 * @cc With --json: also include completed background sessions
 */
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
 * `claude --bg` prints "backgrounded · <short id> · <name>" on stdout (no --json for --bg). A hint only: the job is
 * found by its name in `claude agents --json` (lib/room-claude.ts findJob); the id read here is preferred when listed,
 * and used alone only while that list cannot be read.
 * @cc backgrounded \xB7
 * @stability incidental
 */
const JOB_RE: RegExp = /backgrounded\s*·\s*([0-9a-z]{4,40})\b/i;

/**
 * The job id from `claude --bg` output, or null (a hint: see JOB_RE).
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
 * @cc With --json: also include completed background sessions
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
 * something else (callers then fall back to the id JOB_RE read at dispatch, a hint).
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

// ---------- the env a `claude --bg` client is handed ----------

/**
 * Keys never handed to a `claude --bg` client spawned from a member's session (lib/room-claude.ts). The client and,
 * when the client cold-starts it, the bg daemon run with that env, and the daemon starts every job from its own
 * process.env: a member's session keys would make the room session (and every later bg job) look like a child of that
 * member's session. The daemon's own dispatch filter (contract daemon-env-filter) drops them from the dispatch anyway,
 * which is why the full env can be passed at all; the room session's own env goes through --settings env.
 *   CLAUDECODE, CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_CHILD_SESSION, CLAUDE_CODE_SESSION_ATTENDED, CLAUDE_PID, AI_AGENT,
 *     CLAUDE_EFFORT, TRACEPARENT, CLAUDE_CODE_EXECPATH: what Claude Code stamps on its child processes (a hook's, a
 *     Bash command's): the member's session, its pid, effort, trace and binary, and the mark of a child session;
 *   CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_BRIDGE_SESSION_ID, CLAUDE_CODE_MESSAGING_SOCKET, CLAUDE_CODE_MESSAGING_TOKEN:
 *     how the member's session was started and its cross-session messaging endpoint and token (the room session gets
 *     its own from the daemon);
 *   CLAUDE_CODE_TASK_LIST_ID: the member's own task list (the room's, sh-CODE, goes through --settings env);
 *   CLAUDE_PLUGIN_ROOT, CLAUDE_PLUGIN_DATA, CLAUDE_PROJECT_DIR, CLAUDE_ENV_FILE: the hook's own context;
 *   TMUX, TMUX_PANE: the member's terminal pane, not the room session's (it has none);
 *   SUB_HUMAN_* (DENY_PREFIX): this process's knobs; the room's state goes through --settings env.
 * Empty values are kept (an env-level login such as CLAUDE_SECURESTORAGE_CONFIG_DIR="" must reach the client).
 */
const CLIENT_ENV_DENY: readonly string[] = Object.freeze([
  'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_PID', 'AI_AGENT',
  'CLAUDE_EFFORT', 'TRACEPARENT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_TASK_LIST_ID', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PROJECT_DIR',
  'CLAUDE_ENV_FILE', 'TMUX', 'TMUX_PANE',
]);
const CLIENT_ENV_DENY_SET = new Set(CLIENT_ENV_DENY);
const DENY_PREFIX = 'SUB_HUMAN_';

/** env without the CLIENT_ENV_DENY keys and SUB_HUMAN_* (exact, case-sensitive key match); empty values kept. */
function clientEnv(env: Env = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !CLIENT_ENV_DENY_SET.has(k) && !k.startsWith(DENY_PREFIX)) out[k] = v;
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

/**
 * The room session's crossSessionInbound setting (its --settings at spawn: lib/room-claude.ts spawnPlan): refuse. A
 * peer's SendMessage to claude.CODE then reaches nothing (no transcript line, no turn), and the sender's tool says the
 * message was refused and not delivered; the plugin's own wakes (a member_joined, a submitted prompt) are no
 * cross-session messages and still arrive (cc-2.1.296-tasks-plans.md S1.5).
 * @cc is not accepting cross-session messages
 * @stability incidental
 */
const ROOM_SESSION_INBOUND = 'refuse';

export {
  ROOM_SESSION_INBOUND, JOB_RE, parseDispatch, agentsCmd, stopCmd, parseAgentsJson, jobs, parseDaemonStatus, daemonStatus, exeState,
  runningVersion, CLIENT_ENV_DENY, clientEnv,
};
export type { AgentJob, JobsOpts, DaemonStatus, ExeStateOpts };
