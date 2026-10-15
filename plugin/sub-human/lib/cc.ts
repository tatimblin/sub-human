/**
 * plugin/sub-human/lib/cc.ts: the single home for every Claude Code internal the plugin relies on.
 *
 * Source of truth: docs/internals/cc-2.1.281.md (a full read of the 2.1.281 binary; the § numbers point there)
 * and docs/internals/cc-2.1.292.md, cc-2.1.296.md (what changed in each, checked against that binary). Every export names
 * the literal string to search the binary for (`@cc`) and how stable the assumption is (`@stability`):
 *   API         documented hook/settings schema, a `.describe()` string, or an exported name
 *   env         a named env var or flag
 *   incidental  follows from how the code is written; not named anywhere (transcript shapes, display text)
 * CONTRACT lists every assumption, including ones that only shape docs or design; scripts/probe-cc.js
 * greps the installed binary for each `search` (literal text: strings, .describe() text, env and property
 * names) and each `shape` (code with `~` for every minified identifier, see shapeRe) and fails when one is gone.
 * Minified names change every build, so no search or shape names one.
 *
 * Pure functions take `env` (default process.env) so tests need no global state. Zero dependencies.
 *
 *   ENV                                  env var names Claude Code sets or reads
 *   sessionId(env) / claudePid(env)      CLAUDE_CODE_SESSION_ID / CLAUDE_PID, validated
 *   taskListId(env)                      CLAUDE_CODE_TASK_LIST_ID or null
 *   configDir(env)                       CLAUDE_CONFIG_DIR || ~/.claude
 *   sanitizeId(s), tasksDir(listId, env), taskFile(listId, id, env)
 *   userSettingsFiles(cwd, env)          the settings files the plugin reads showClearContextOnPlanAccept from
 *   clearContextOnPlanAccept(cwd, env)   true when any of them sets it
 *   readLines(file, {tailBytes}), readEntries(file, {tailBytes}), parseLines(lines)
 *   planFile(lines, toolInput?), planAnswer(lines, toolUseId) -> {note}|null (null: no tool_result on disk yet),
 *   planFeedback(lines, toolUseId), toolUseInput(lines, toolUseId)
 *   contentText(content), PASTED_RE, unwrapPasted(text)
 *   JOB_RE, parseDispatch(text), parseAgentsJson(text), jobs(opts), agentsCmd(all), stopCmd(id)
 *   parseDaemonStatus(text), daemonStatus(opts)   `claude daemon status`: {running, pid, version}
 *   exeState(pid, {readlink?, ps?, exists?}) -> {exe, deleted}|null   the executable a process runs, and whether it
 *                                        was deleted since (an upgrade): /proc/PID/exe on Linux, `ps -o comm=` elsewhere
 *   DAEMON_ENV_ALLOW, daemonEnv(env)
 *   matcherIsExact(m, {toolEvent}), matcherMatches(m, name, {toolEvent})
 *   shapeRe(shape)                       a shape as a RegExp: `~` = one minified identifier, the rest literal
 *   CONTRACT                             [{id, search, shape?, stability, note}]
 *   PROBED_VERSION                       the Claude Code version CONTRACT was last checked against ('2.1.296')
 *   MIN_VERSION                          the oldest that can run the plugin (function hooks: '2.1.292')
 *   compareVersions(a, b) -> -1|0|1      numeric per dot-separated part; null for an unreadable one
 *   locateBinary({bin?, env?}) -> path|null   the binary to probe: bin, $CLAUDE_BIN, `claude` on PATH (symlinks
 *                                        resolved), else the newest /opt/homebrew/Caskroom/claude-code*\/<v>/claude
 *   binaryVersion(buf) -> string|null    the VERSION:"…" literal in the binary
 *   runningVersion(pid) -> string|null   the version the Claude Code process pid runs (exeState's path, else --version)
 *   globalConfigFile(env), modulesSwitch(env) -> bool|undefined   the hooks modules switch Claude Code last cached
 *   probe(buf, {entries?, envNames?}) -> [{id, stability, ok, missing, note}]   every entry's search strings and
 *       shapes checked against the binary (scripts/probe-cc.js, `sub-human doctor`); envNames adds the derived
 *       daemon-env-names check (every DAEMON_ENV_ALLOW key is a quoted literal). One latin1 view, String#indexOf,
 *       and each shape tested only around its longest literal piece: ~3 s for a 235 MB binary
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';

type Env = NodeJS.ProcessEnv;

/** A content block of a transcript message, as far as these readers look (the rest of the JSON is not typed). */
interface ContentBlock {
  type?: string;
  text?: unknown;
  id?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
  input?: unknown;
  [field: string]: unknown;
}
/** One parsed transcript line, as far as these readers look: read from disk, so every field is checked before use. */
interface TranscriptEntry {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  message?: { content?: unknown };
  origin?: unknown;
  timestamp?: string;
  attachment?: { type?: string; planFilePath?: string };
  userFeedback?: unknown;
  promptId?: string;
  [field: string]: unknown;
}
/** A transcript line: raw (a cheap substring prefilter, then parse) or already parsed. */
type TranscriptLine = string | TranscriptEntry;

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

/** One CONTRACT entry. */
interface ContractEntry {
  id: string;
  section?: number;
  stability: 'API' | 'env' | 'incidental';
  search?: string | readonly string[];
  shape?: string | readonly string[];
  note: string;
}
/** One probe() result. */
interface ProbeResult { id: string; stability: string; ok: boolean; missing: string[]; note: string }

// ---------- env ----------

/**
 * Env var names. CLAUDE_PID and CLAUDE_CODE_SESSION_ID are set (by M0e) for hooks, Bash, statusLine
 * and subagentStatusLine; MCP stdio servers get the session id but not CLAUDE_PID, and a hooks
 * module's $.process children get neither of their own (CONTRACT process-run-stdin).
 * @cc CLAUDE_CODE_CHILD_SESSION:"1",CLAUDE_CODE_SESSION_ATTENDED
 * @stability env
 */
const ENV = Object.freeze({
  PID: 'CLAUDE_PID',
  SESSION_ID: 'CLAUDE_CODE_SESSION_ID',
  TASK_LIST_ID: 'CLAUDE_CODE_TASK_LIST_ID',
  CONFIG_DIR: 'CLAUDE_CONFIG_DIR',
});

/**
 * The session id Claude Code exported to this child, or null. Fixed at spawn: after /clear only children
 * spawned later see the new id (running MCP servers keep the old one).
 * @cc conversation_reset",newConversationId
 * @stability env
 */
function sessionId(env: Env = process.env): string | null {
  const s = env[ENV.SESSION_ID];
  return typeof s === 'string' && s ? s : null;
}

/**
 * The owning claude process pid from CLAUDE_PID (a positive integer), or null. No hook input carries a pid.
 * @cc CLAUDE_PID:String(process.pid)
 * @stability env
 */
function claudePid(env: Env = process.env): number | null {
  const p = Number(env[ENV.PID]);
  return Number.isInteger(p) && p > 0 ? p : null;
}

/**
 * CLAUDE_CODE_TASK_LIST_ID when set, else null (the caller supplies its own fallback).
 * @cc CLAUDE_CODE_TASK_LIST_ID)return 
 * @stability env
 */
function taskListId(env: Env = process.env): string | null {
  const s = env[ENV.TASK_LIST_ID];
  return typeof s === 'string' && s ? s : null;
}

// ---------- config dir and task store ----------

/**
 * Claude Code's config home: CLAUDE_CONFIG_DIR, else ~/.claude (NFC-normalized, as the binary does).
 * @cc new Set(["CLAUDE_CONFIG_DIR","CLAUDE_INTERNAL_FC_OVERRIDES",
 * @stability env
 */
function configDir(env: Env = process.env): string {
  const d = env[ENV.CONFIG_DIR] || path.join(env.HOME || os.homedir(), '.claude');
  return d.normalize('NFC');
}

/**
 * The task store's file-name sanitiser: every char outside [A-Za-z0-9_-] becomes '-'.
 * @cc return e.replace(/[^a-zA-Z0-9_-]/g,"-")}
 * @stability incidental
 */
const sanitizeId = (s: unknown): string => String(s).replace(/[^a-zA-Z0-9_-]/g, '-');

/**
 * <configDir>/tasks/<sanitized listId>: the native task list directory (file backend; the experimental v5
 * key-value backend is off by default).
 * @cc return e.replace(/[^a-zA-Z0-9_-]/g,"-")}
 * @stability incidental
 */
const tasksDir = (listId: string, env: Env = process.env): string => path.join(configDir(env), 'tasks', sanitizeId(listId));

/**
 * <tasksDir>/<sanitized id>.json: one native task.
 * @cc return e.replace(/[^a-zA-Z0-9_-]/g,"-")}
 * @stability incidental
 */
const taskFile = (listId: string, id: string | number, env: Env = process.env): string => path.join(tasksDir(listId, env), `${sanitizeId(id)}.json`);

// ---------- settings ----------

/**
 * The settings files the plugin checks for showClearContextOnPlanAccept: user (<configDir>/settings.json),
 * then project and local under cwd/.claude. Claude Code merges more sources (flag, policy); these are the
 * ones a person edits.
 * @cc When true, the plan-approval dialog offers a "clear context" option. Defaults to false.
 * @stability API
 */
function userSettingsFiles(cwd: string | null | undefined, env: Env = process.env): string[] {
  const files = [path.join(configDir(env), 'settings.json')];
  if (cwd) files.push(path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json'));
  return files;
}

/**
 * True when any of userSettingsFiles sets showClearContextOnPlanAccept: true. That approve option fires no
 * PostToolUse and starts implementing at once.
 * @cc When true, the plan-approval dialog offers a "clear context" option. Defaults to false.
 * @stability API
 */
function clearContextOnPlanAccept(cwd: string | null | undefined, env: Env = process.env): boolean {
  return userSettingsFiles(cwd, env).some(f => {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')).showClearContextOnPlanAccept === true; } catch { return false; }
  });
}

// ---------- transcript ----------

/**
 * A JSONL transcript's raw lines (oldest first; [] when unreadable). With tailBytes, only the last tailBytes
 * are read and a line cut by that boundary is dropped.
 * @cc ?.feedbackIsFromUser&&
 * @stability incidental
 */
function readLines(file: unknown, { tailBytes }: { tailBytes?: number } = {}): string[] {
  if (typeof file !== 'string' || !file) return [];
  let text: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (!tailBytes || size <= tailBytes) {
        const buf = Buffer.alloc(size);
        fs.readSync(fd, buf, 0, size, 0);
        text = buf.toString('utf8');
      } else {
        // one extra byte tells whether the cut falls on a line boundary
        const buf = Buffer.alloc(tailBytes + 1);
        fs.readSync(fd, buf, 0, tailBytes + 1, size - tailBytes - 1);
        text = buf.toString('utf8');
        const nl = text.indexOf('\n');
        text = nl < 0 ? '' : text.slice(nl + 1);
      }
    } finally { fs.closeSync(fd); }
  } catch { return []; }
  return text.split('\n').filter(Boolean);
}

/** Parsed entries from raw lines; torn or non-JSON lines are skipped. */
function parseLines(lines: readonly TranscriptLine[]): TranscriptEntry[] {
  const es: TranscriptEntry[] = [];
  for (const l of lines) {
    if (l && typeof l === 'object') { es.push(l); continue; }
    try { es.push(JSON.parse(l)); } catch { /* torn line */ }
  }
  return es;
}

/**
 * readLines, parsed. Same as at-room's transcriptTail with tailBytes 512 KiB.
 * @cc ?.feedbackIsFromUser&&
 * @stability incidental
 */
const readEntries = (file: unknown, opts?: { tailBytes?: number }): TranscriptEntry[] => parseLines(readLines(file, opts));

// Lines may be raw strings (cheap substring prefilter, then parse) or already-parsed entries.
const lineHas = (l: TranscriptLine, ...subs: string[]): boolean => typeof l !== 'string' || subs.every(s => l.includes(s));
const asEntry = (l: TranscriptLine): TranscriptEntry | null => { if (l && typeof l === 'object') return l; try { return JSON.parse(l); } catch { return null; } };

/**
 * The session's plan file: toolInput.planFilePath (PreToolUse/PermissionRequest on ExitPlanMode see it,
 * injected by normalizeToolInput), else the latest `plan_mode` attachment's planFilePath, else null.
 * @cc type:"plan_mode",reminderType:
 * @stability incidental
 */
function planFile(lines: readonly TranscriptLine[], toolInput?: { planFilePath?: unknown } | null): string | null {
  const ti = toolInput || {};
  if (typeof ti.planFilePath === 'string' && ti.planFilePath) return ti.planFilePath;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!lineHas(lines[k], '"plan_mode"', 'planFilePath')) continue;
    const e = asEntry(lines[k]);
    const a = e && e.attachment;
    if (a && a.type === 'plan_mode' && a.planFilePath) return a.planFilePath;
  }
  return null;
}

const contentText = (c: unknown): string => typeof c === 'string' ? c
  : Array.isArray(c) ? c.map((b: ContentBlock | null) => (b && b.type === 'text' && typeof b.text === 'string') ? b.text : '').join('\n') : '';

/** The text before a rejected tool's note ("…To tell you how to proceed, the user said:\n<note>"). */
const SAID = 'the user said:\n';
/** What follows the note in the rejection text. */
const NOTE = '\n\nNote: The user\'s next message';

/**
 * How the dialog of tool use toolUseId closed, as far as the transcript has it: null while its tool_result is not
 * on disk (the dialog still open, or the line not written yet), else {note}: the person's "No, keep planning" /
 * "Tell Claude what to change" note, or null (approved: not an error result; or rejected with no note, e.g. Esc).
 * Prefers the structured top-level `userFeedback` field on the tool_result entry; falls back to the text after
 * "the user said:\n" (cut at the "Note: The user's next message" suffix). On 2.1.296 the entry also carries
 * toolUseResult "Error: <the text>", toolDenialKind "user-rejected" and permissionDecision {decision "reject",
 * source "user_reject"}, none of which is read.
 * Remote Control (the phone; observed on 2.1.292) answers the same dialog with the same shapes, so its note is
 * read the same way: "Suggest edits" / deny with a note is an is_error tool_result, toolDenialKind
 * "user-rejected", userFeedback "<note>", content "The user doesn't want to proceed with this tool use. The tool
 * use was rejected (…). To tell you how to proceed, the user said:\n<note>\n\nNote: The user's next message may
 * contain a correction or preference. …"; a bare deny has no userFeedback and reads "… STOP what you are doing
 * and wait for the user to tell you how to proceed.\n\nNote: …" (note null here: closed without answering).
 * @cc ?.feedbackIsFromUser&&
 * @stability incidental
 */
function planAnswer(lines: readonly TranscriptLine[], toolUseId: string | null | undefined): { note: string | null } | null {
  if (!toolUseId) return null;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!lineHas(lines[k], toolUseId, 'tool_result')) continue;
    const e = asEntry(lines[k]);
    const msg = e && e.message;
    const block = (msg && Array.isArray(msg.content) ? msg.content as (ContentBlock | null)[] : []).find(b => b && b.type === 'tool_result' && b.tool_use_id === toolUseId);
    if (!block) continue;
    if (!block.is_error) return { note: null };
    if (typeof e!.userFeedback === 'string') return { note: e!.userFeedback }; // e is set: block came from its message
    const t = contentText(block.content);
    const at = t.indexOf(SAID);
    if (at < 0) return { note: null };
    const rest = t.slice(at + SAID.length);
    const end = rest.lastIndexOf(NOTE);
    return { note: end >= 0 ? rest.slice(0, end) : rest };
  }
  return null;
}

/** planAnswer's note alone: null also while the tool_result is not on disk. */
const planFeedback = (lines: readonly TranscriptLine[], toolUseId: string | null | undefined): string | null => planAnswer(lines, toolUseId)?.note ?? null;

/**
 * The input the model itself sent for tool use toolUseId (from the assistant tool_use block), or null.
 * ExitPlanMode's hook input has plan/planFilePath injected from disk; the transcript copy has them stripped.
 * @cc ,new Set(["plan","planFilePath"])]])
 * @stability incidental
 */
function toolUseInput(lines: readonly TranscriptLine[], toolUseId: string | null | undefined): unknown {
  if (!toolUseId) return null;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!lineHas(lines[k], toolUseId, '"tool_use"')) continue;
    const e = asEntry(lines[k]);
    const c = e && e.message && e.message.content;
    const b = (Array.isArray(c) ? c as (ContentBlock | null)[] : []).find(x => x && x.type === 'tool_use' && x.id === toolUseId);
    if (b) return b.input;
  }
  return null;
}

/**
 * The person's latest prompt in the transcript lines, or null: the newest user entry that is a prompt (not a
 * tool_result, not isMeta, not a sidechain or a compact summary), taken only when it is the person's own: its
 * `origin` is absent or kind "human" (a typed prompt, also one typed through Remote Control). Any other kind (a
 * peer, a task notification, a channel, a plugin's wake, anything unclassified) is not the person's words: null.
 * Returns {text, at} (at: the entry's timestamp, ms; 0 when it has none).
 * @cc {kind:"human"}
 * @stability incidental
 */
function lastHumanPrompt(lines: readonly TranscriptLine[]): { text: string; at: number } | null {
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!lineHas(lines[k], '"user"')) continue;
    const e = asEntry(lines[k]);
    if (!e || e.type !== 'user' || e.isMeta || e.isSidechain || e.isCompactSummary || !e.message) continue;
    const c = e.message.content;
    if (Array.isArray(c) && c.some((b: ContentBlock | null) => b && b.type === 'tool_result')) continue;
    const text = contentText(c);
    if (!text.trim()) continue;
    const kind = e.origin && typeof e.origin === 'object' ? (e.origin as { kind?: unknown }).kind : undefined;
    if (e.origin !== undefined && kind !== 'human') return null;
    const at = Date.parse(e.timestamp as string);
    return { text, at: Number.isFinite(at) ? at : 0 };
  }
  return null;
}

// ---------- prompts: pastes ----------

/**
 * A long paste as the prompt carries it: \n\n<pasted_content id="N">\n…\n</pasted_content id="N">\n.
 * Same regex as at-room's PASTE (global; reset lastIndex or use String#replace).
 * @cc <pasted_content id="
 * @stability incidental
 */
const PASTED_RE = /(?:\n\n)?<pasted_content id="?(\w+)"?>\n([\s\S]*?)\n?<\/pasted_content id="?\1"?>\n?/g;

/** {text, normalized}: the prompt with each paste wrapper replaced by its body. Same as at-room's unwrap. */
function unwrapPasted(text: unknown): { text: string; normalized: boolean } {
  let normalized = false;
  const t = String(text).replace(PASTED_RE, (_: string, _id: string, body: string) => { normalized = true; return body; });
  return { text: t, normalized };
}

// ---------- background jobs ----------

/**
 * `claude --bg` prints "backgrounded · <short id> · <name>" on stdout (no --json for --bg).
 * @cc backgrounded \xB7
 * @stability incidental
 */
const JOB_RE = /backgrounded\s*·\s*([0-9a-z]{4,40})\b/i;

/**
 * The job id from `claude --bg` output, or null.
 * @cc backgrounded \xB7
 * @stability incidental
 */
function parseDispatch(text: unknown): string | null {
  const m = JOB_RE.exec(String(text || ''));
  return m ? m[1] : null;
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

/**
 * Run `claude agents --json [--all]` and parse it: the array, or null when the command fails or prints
 * something else (callers then fall back to the id they parsed with JOB_RE at dispatch).
 * opts: {all, bin = SUB_HUMAN_CLAUDE || 'claude', env, timeout = 15000, run = spawnSync}.
 * @cc isAgentsJsonInvocation
 * @stability API
 */
/** jobs() options; run: a spawnSync stand-in (tests). */
interface JobsOpts {
  all?: boolean;
  bin?: string;
  env?: Env;
  timeout?: number;
  run?: (bin: string, args: string[], opts: SpawnSyncOptionsWithStringEncoding) => { error?: Error; status: number | null; stdout: string } | null;
}

function jobs({ all = false, bin = process.env.SUB_HUMAN_CLAUDE || 'claude', env = process.env, timeout = 15_000, run = spawnSync }: JobsOpts = {}): AgentJob[] | null {
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
  if (pid || version) return { running: true, pid: pid && Number(pid[1]) > 0 ? Number(pid[1]) : null, version: version ? version[1] : null };
  return /^not running\b/m.test(t) ? { running: false, pid: null, version: null } : null;
}

/**
 * Run `claude daemon status` and parse it (parseDaemonStatus): its exit status is not checked, as "not running"
 * exits 1. null when the command cannot be spawned or prints something else. Options as jobs() (no `all`).
 * @cc Show daemon pid, version, uptime
 * @stability incidental
 */
function daemonStatus({ bin = process.env.SUB_HUMAN_CLAUDE || 'claude', env = process.env, timeout = 15_000, run = spawnSync }: Omit<JobsOpts, 'all'> = {}): DaemonStatus | null {
  let r;
  try { r = run(bin, ['daemon', 'status'], { env, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return null; }
  if (!r || r.error) return null;
  return parseDaemonStatus(r.stdout);
}

// ---------- daemon env allowlist ----------

// The daemon's dispatch allowlist as 2.1.296 builds it (minified names of that build in brackets):
// [CNr] = [q6e] + [l5n] + EXTRA_KEYS, where
// [q6e] = CLAUDE_CONFIG_DIR, CLAUDE_INTERNAL_FC_OVERRIDES, MODEL_KEYS, CUSTOM_MODEL_KEYS, CLAUDE_CODE_SUBAGENT_MODEL_FORCE,
//         CLAUDE_CODE_CLIENT_DATA_URL, PROVIDER_KEYS, CLOUD_KEYS
// [l5n] = PATH, CLAUDE_CODE_EXTRA_BODY, CLAUDE_CODE_HOST_CREDS_FILE, ENDPOINT_KEYS
// The arrays below keep the binary's order: CONTRACT `daemon-env-allowlist` searches for them as JSON text.
const MODEL_KEYS = [ // [eut]
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL',
  ...['FABLE', 'HAIKU', 'OPUS', 'SONNET'].flatMap(f => [`ANTHROPIC_DEFAULT_${f}_MODEL`, `ANTHROPIC_DEFAULT_${f}_MODEL_DESCRIPTION`,
    `ANTHROPIC_DEFAULT_${f}_MODEL_NAME`, `ANTHROPIC_DEFAULT_${f}_MODEL_SUPPORTED_CAPABILITIES`]),
  'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL',
  'CLAUDE_CODE_3P_PROBE_WROTE_SONNET_DEFAULT', 'CLAUDE_CODE_3P_PROBE_WROTE_OPUS_DEFAULT', 'CLAUDE_CODE_3P_PROBE_WROTE_HAIKU_DEFAULT',
  'CLAUDE_CODE_3P_SEEDED_SONNET_DEFAULT', 'CLAUDE_CODE_3P_SEEDED_OPUS_DEFAULT',
];
const CUSTOM_MODEL_KEYS = ['ANTHROPIC_CUSTOM_MODEL_OPTION', 'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION', // [nWn]
  'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME', 'ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES'];
const PROVIDER_KEYS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', // [hV]
  'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_GATEWAY',
  'ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_VERTEX_PROJECT_ID', 'ANTHROPIC_AWS_WORKSPACE_ID', 'ANTHROPIC_GOOGLE_CLOUD_PROJECT',
  'ANTHROPIC_GOOGLE_CLOUD_LOCATION', 'ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID', 'CLOUD_ML_REGION'];
const CLOUD_KEYS = ['AWS_REGION', 'AWS_DEFAULT_REGION', 'ANTHROPIC_BEDROCK_REGION_PREFIX', 'AWS_PROFILE', 'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_HOST_GATEWAY_LINEAGE'];
// [uUe]: every endpoint and its companions
const ENDPOINT_KEYS = ['ANTHROPIC_BASE_URL', '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_BEDROCK_BASE_URL', 'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'ANTHROPIC_VERTEX_BASE_URL', 'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'ANTHROPIC_FOUNDRY_BASE_URL', 'CLAUDE_CODE_SKIP_FOUNDRY_AUTH', 'ANTHROPIC_AWS_BASE_URL', 'CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH',
  'ANTHROPIC_GOOGLE_CLOUD_BASE_URL', 'CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH', 'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'CLAUDE_CODE_SKIP_MANTLE_AUTH'];
const EXTRA_KEYS = ['CLAUDE_CODE_DISABLE_PROACTIVITY', 'CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG', 'CLAUDE_CODE_AUTO_MODE_SERVER',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', 'CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS', 'CLAUDE_CODE_AUTO_MODE_TIER', 'CLAUDE_BG_ISOLATION',
  'CLAUDE_BG_SESSION_PERMISSION_RULES', 'CLAUDE_BG_MEMORY_TOGGLED_OFF', 'CLAUDE_BG_AUTO_MEMORY_OFF', 'CLAUDE_CODE_RESUME_SOURCE_ALIVE',
  'CLAUDE_CODE_PLUGIN_DIRS'];

/**
 * The env keys the bg daemon keeps from a `claude --bg` dispatch (q6e + l5n + EXTRA_KEYS above), exactly as
 * 2.1.296 builds it (2.1.292 added CLAUDE_CODE_CLIENT_DATA_URL, three CLAUDE_CODE_3P_* model keys,
 * CLAUDE_CODE_DISABLE_PROACTIVITY, CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS, CLAUDE_CODE_AUTO_MODE_TIER and
 * CLAUDE_BG_AUTO_MEMORY_OFF; 2.1.296 CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL and CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG). Every other caller env key (CLAUDE_CODE_TASK_LIST_ID, SUB_HUMAN_*, HOME, ...) is dropped;
 * the worker runs with the daemon's own process.env plus these. Auth secrets (ANTHROPIC_API_KEY, ...) are
 * not in it. Pass state to a bg job through argv (`--settings '{"env":{...}}'`) instead.
 * @cc daemon_bg_dispatch_ingest
 * @stability env
 */
const DAEMON_ENV_ALLOW = Object.freeze([...new Set([
  'CLAUDE_CONFIG_DIR', 'CLAUDE_INTERNAL_FC_OVERRIDES', ...MODEL_KEYS, ...CUSTOM_MODEL_KEYS, 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE',
  'CLAUDE_CODE_CLIENT_DATA_URL', ...PROVIDER_KEYS, ...CLOUD_KEYS,
  'PATH', 'CLAUDE_CODE_EXTRA_BODY', 'CLAUDE_CODE_HOST_CREDS_FILE', ...ENDPOINT_KEYS,
  ...EXTRA_KEYS,
])]);
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

// ---------- hook matcher ----------

/**
 * True when Claude Code treats the matcher as an exact-name list rather than a regex: only
 * [A-Za-z0-9_|] (tool events also allow ',', space and '-'), split on '|' (tool events: '|' or ',').
 * Anything else is `new RegExp(m).test(name)`, unanchored. '' and '*' match everything (not exact).
 * @cc /^[a-zA-Z0-9_|, -]+$/:/^[a-zA-Z0-9_|]+$/
 * @stability API
 */
function matcherIsExact(m: unknown, { toolEvent = true }: { toolEvent?: boolean } = {}): m is string {
  if (typeof m !== 'string' || !m || m === '*') return false;
  return (toolEvent ? /^[a-zA-Z0-9_|, -]+$/ : /^[a-zA-Z0-9_|]+$/).test(m);
}

/**
 * Whether matcher m selects name, per the binary rule (tool aliases not modelled).
 * @cc Invalid regex pattern in hook matcher
 * @stability API
 */
function matcherMatches(m: string | null | undefined, name: string, { toolEvent = true }: { toolEvent?: boolean } = {}): boolean {
  if (!m || m === '*') return true;
  if (matcherIsExact(m, { toolEvent })) {
    return m.split(toolEvent ? /[|,]/ : '|').map(s => s.trim()).filter(Boolean).includes(name);
  }
  try { return new RegExp(m).test(name); } catch { return false; }
}

// ---------- the contract ----------

/**
 * A CONTRACT shape as a RegExp: `~` stands for one minified identifier ([\w$]+), everything else is literal.
 * Shapes pin code whose meaning is in its structure (a fallback order, a numeric default) without naming the
 * build's minified identifiers, so a rebuild that only renames them still passes.
 */
const shapeRe = (shape: unknown): RegExp => new RegExp(String(shape).split('~').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\w$]+'));

/**
 * Every Claude Code assumption the plugin makes. `search` is a literal string (or array: all must match) and
 * `shape` an optional code shape (or array; see shapeRe), both found in the 2.1.296 binary; scripts/probe-cc.js
 * checks them. `section` points into docs/internals/cc-2.1.281.md (changes in cc-2.1.292.md and cc-2.1.296.md).
 */
const CONTRACT: readonly ContractEntry[] = Object.freeze([
  // §1 tasks
  { id: 'task-completed-block-drops-fields', section: 1, stability: 'incidental', search: 'TaskCompleted hooks cancelled (control stream closed)',
    note: 'A TaskCompleted block makes TaskUpdate return success:false, updatedFields:[] before the write: every field in that call (subject, metadata, owner) is discarded.' },
  { id: 'hook-exit2-blocks', section: 1, stability: 'API', search: '"No stderr output"',
    shape: 'if(~.status===2&&!~.blockingError)~.blockingError={blockingError:`[${',
    note: 'Exit 2 makes stderr the blockingError.' },
  { id: 'hook-json-block', section: 1, stability: 'API', search: 'Valid types are: approve, block',
    shape: 'case"block":~.permissionBehavior="deny",~.blockingError={blockingError:~.reason||"Blocked by hook"',
    note: '{"decision":"block","reason"} is a blockingError.' },
  { id: 'task-completed-input', section: 1, stability: 'API', search: '("TaskCompleted"),task_id:',
    shape: 'hook_event_name:~("TaskCompleted"),task_id:~(),task_subject:~(),task_description:~().optional(),teammate_name:',
    note: 'TaskCompleted input has no metadata/owner/status; read the task file (which still has the old status).' },
  { id: 'task-events-no-matcher', section: 1, stability: 'API', search: 'case"TeammateIdle":case"TaskCreated":case"TaskCompleted":return;',
    note: 'TaskCreated/TaskCompleted/TeammateIdle have no matcher query: every hook fires.' },
  { id: 'task-update-schema', section: 1, stability: 'API', search: 'Metadata keys to merge into the task. Set a key to null to delete it.',
    note: 'TaskUpdate metadata merges; null deletes a key.' },
  { id: 'task-create-metadata', section: 1, stability: 'API', search: 'Arbitrary metadata to attach to the task',
    note: 'TaskCreate accepts metadata.' },
  // §2 env
  { id: 'env-child-session', section: 2, stability: 'env', search: ['CLAUDE_CODE_CHILD_SESSION:"1",CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_PID:String(process.pid)'],
    note: 'Hooks, Bash, statusLine and subagentStatusLine get CLAUDE_PID and CLAUDE_CODE_SESSION_ID (cc.ENV, sessionId, claudePid).' },
  { id: 'env-mcp-session', section: 2, stability: 'env', search: 'CLAUDE_CODE_CHROME_MCP_ORG_DENIED:"1"',
    shape: 'CLAUDE_PROJECT_DIR:~??~(),CLAUDE_CODE_SESSION_ID:~(),CLAUDECODE:"1",...~.env,',
    note: 'MCP stdio servers get CLAUDE_CODE_SESSION_ID (fixed at spawn) but not CLAUDE_PID.' },
  { id: 'env-plugin-mcp', section: 2, stability: 'env', search: '.path,CLAUDE_PLUGIN_DATA:',
    shape: '{CLAUDE_PLUGIN_ROOT:~.path,CLAUDE_PLUGIN_DATA:~(~.source),...~.env||{}}',
    note: 'Plugin MCP servers get CLAUDE_PLUGIN_ROOT/DATA in env.' },
  { id: 'env-clear-session-id', section: 2, stability: 'incidental', search: 'conversation_reset",newConversationId',
    note: '/clear updates process.env.CLAUDE_CODE_SESSION_ID; running MCP servers keep the old id.' },
  { id: 'env-nested-strip', section: 2, stability: 'incidental', search: 'CLAUDECODE,delete ',
    shape: 'delete ~.CLAUDECODE,delete ~.CLAUDE_CODE_SESSION_ID,delete ~.CLAUDE_CODE_CHILD_SESSION',
    note: 'A nested claude drops CLAUDE_CODE_SESSION_ID from its env.' },
  { id: 'hook-input-common', section: 2, stability: 'API', search: 'Subagent identifier. Present only when the hook fires from within a subagent',
    note: 'Common hook input: session_id, transcript_path, cwd, prompt_id?, permission_mode?, agent_id?; no pid.' },
  { id: 'mcp-stdio-ppid', section: 2, stability: 'incidental',
    search: ['stdio:["pipe","pipe",this._serverParams.stderr??"inherit"],shell:!1', '{ echo 0 > "$0"/cgroup.procs; } 2>/dev/null; exec "$@"'],
    shape: 'let ~=~.CLAUDE_CODE_SHELL_PREFIX||~.command,',
    note: 'A stdio MCP server is spawned without a shell (the Linux cgroup wrapper ends in exec), so its process.ppid is the claude pid; the room server resolves its caller that way. Not so when the user sets CLAUDE_CODE_SHELL_PREFIX (cc-2.1.292.md Review spikes, S-mcp a).' },
  { id: 'mcp-progress-resets-idle-timeout', section: 2, stability: 'incidental',
    search: ['aborting: no response or progress notification for ', 'Hard wall-clock limit per call; progress notifications do not extend it.'],
    shape: ['onprogress:(~)=>{if(~.armedAt=0,~=Date.now(),', '~.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT??(~==="stdio"?~:~)'],
    note: 'A tools/call has an idle watchdog (30 min for stdio, CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT) that each notifications/progress resets, and a wall-clock limit (MCP_TOOL_TIMEOUT, about 27.8 h by default) that progress does not extend. mcp/hold.ts beats progress to keep a hold under the idle watchdog (cc-2.1.292.md Review spikes, S-mcp b).' },
  { id: 'mcp-server-shared-by-subagents', section: 2, stability: 'incidental', search: 'Skipping frontmatter MCP servers: blocked by ',
    shape: ['if(!~.mcpServers?.length)return{clients:~,agentClients:[],tools:[],cleanup:async()=>{}}', 'return{clients:[...~,...~],agentClients:~,tools:~,cleanup:~}'],
    note: 'A subagent with no mcpServers uses its parent\'s MCP clients, so the room tools a subagent calls reach the main thread\'s server process (cc-2.1.292.md Review spikes, S-mcp c).' },
  // §3 plan mode
  { id: 'plan-mode-attachment', section: 3, stability: 'incidental', search: 'type:"plan_mode",reminderType:',
    shape: 'type:"plan_mode",reminderType:~,isSubAgent:!!~.agentId,planFilePath:~,planExists:',
    note: 'Transcript attachment {type:"plan_mode", planFilePath} (cc.planFile).' },
  { id: 'exitplan-normalize', section: 3, stability: 'API', search: 'The plan content (injected by normalizeToolInput from disk)',
    note: 'Pre/PermissionRequest hooks on ExitPlanMode see tool_input.plan and planFilePath.' },
  { id: 'exitplan-strip', section: 3, stability: 'incidental', search: ',new Set(["plan","planFilePath"])]])',
    note: 'plan/planFilePath are stripped before the transcript copy (cc.toolUseInput reads the model\'s own input).' },
  { id: 'exitplan-output', section: 3, stability: 'API', search: 'The file path where the plan was saved',
    note: 'PostToolUse(ExitPlanMode) fires only on approval.' },
  { id: 'plan-reject-dialog', section: 3, stability: 'incidental', search: '"(See attached image)"',
    shape: 'if(~==="no"){if(!~&&!~)return null;return{behavior:"deny",feedback:',
    note: '"No, keep planning" returns deny with the typed feedback.' },
  { id: 'plan-reject-user-feedback', section: 3, stability: 'incidental', search: '?.feedbackIsFromUser&&',
    shape: ['userFeedback:~.behavior==="ask"?~.userFeedback:void 0,toolResultRemedy:', 'toolDenialUnanswered:~,userFeedback:~,toolResultRemedy:~,'],
    note: 'The rejected tool_result transcript entry carries top-level userFeedback (cc.planAnswer, cc.planFeedback).' },
  { id: 'plan-reject-text', section: 3, stability: 'incidental', search: ['To tell you how to proceed, the user said:\n', 'Note: The user\'s next message may contain a correction'],
    note: 'Fallback: the note sits between "the user said:\\n" and "\\n\\nNote: The user\'s next message".' },
  { id: 'plan-reject-remote', section: 3, stability: 'incidental', search: ['STOP what you are doing and wait for the user to tell you how to proceed', '"user-rejected"'],
    note: 'Remote Control deny (observed 2.1.292): with a note ("Suggest edits") the terminal\'s shapes (userFeedback, "the user said:"); a bare deny says "STOP what you are doing…" with no userFeedback: cc.planFeedback null, nothing recorded. An ordinary message typed on the phone right after a bare Deny is attached to the deny as that note (observed live), so a note is never an objection by itself: it waits for the person\'s Send on the confirm card (hooks/consent.ts).' },
  { id: 'auq-bridge-racer', section: 3, stability: 'incidental', search: 'Interrupting parked AskUserQuestion toolUseID=',
    shape: 'let ~=!!(~.bridgeCallbacks||~.channelCallbacks&&!~.tool.requiresUserInteraction?.());',
    note: 'A tool with its own permission dialog (AskUserQuestion, the plan view) is raced by Remote Control when the session has bridge callbacks: the phone gets the card and its answer resolves the dialog, as the terminal\'s would; the tool_response is Claude Code\'s, never the model\'s. The confirm card for a review\'s note relies on it (hooks/consent.ts). A card can still auto-resolve after the askUserQuestionTimeout idle (afkTimeoutMs): then nothing is recorded and the note waits.' },
  { id: 'permission-denied-auto-only', section: 3, stability: 'incidental', search: 'decisionReason.classifier==="auto-mode"',
    note: 'PermissionDenied fires only for auto-mode classifier denials; no hook carries a user rejection note.' },
  { id: 'clear-context-setting', section: 3, stability: 'API', search: 'When true, the plan-approval dialog offers a "clear context" option. Defaults to false.',
    note: 'showClearContextOnPlanAccept: the clear-context approve fires no PostToolUse (cc.clearContextOnPlanAccept).' },
  // §4 task store
  { id: 'task-list-id', section: 4, stability: 'env', search: 'CLAUDE_CODE_TASK_LIST_ID)return ',
    shape: 'if(~.CLAUDE_CODE_TASK_LIST_ID)return ~.CLAUDE_CODE_TASK_LIST_ID;let ~=~();if(~)return ~.teamName;return ~()||~().taskList.leaderTeamName||~()}',
    note: 'List id: env, team, teammate team, leader team, else session id (changes on /clear).' },
  { id: 'task-path', section: 4, stability: 'incidental', search: 'return e.replace(/[^a-zA-Z0-9_-]/g,"-")}',
    shape: '(~){return ~.replace(/[^a-zA-Z0-9_-]/g,"-")}function ~(~){return ~(~(),"tasks",~(~))}function ~(~,~){return ~(~(~),`${~(~)}.json`)}',
    note: '<configDir>/tasks/<sanitized list>/<sanitized id>.json (cc.tasksDir, cc.taskFile).' },
  { id: 'config-dir', section: 4, stability: 'env', search: 'new Set(["CLAUDE_CONFIG_DIR","CLAUDE_INTERNAL_FC_OVERRIDES",',
    note: 'CLAUDE_CONFIG_DIR replaces ~/.claude (cc.configDir).' },
  { id: 'task-store-v5-off', section: 4, stability: 'env', search: 'where the v5 storage backend was built at start-up',
    note: 'The experimental key-value task backend is off by default; files are the store.' },
  { id: 'todo-tools-gate', section: 4, stability: 'env', search: '.CLAUDE_CODE_ENABLE_TODO_TOOLS===!0',
    note: 'Newer models need CLAUDE_CODE_ENABLE_TODO_TOOLS for Task tools; bg sessions get them anyway.' },
  // §5 bg jobs
  { id: 'bg-dispatch-line', section: 5, stability: 'incidental', search: 'backgrounded \\xB7 ',
    note: '`claude --bg` stdout line 1 is "backgrounded · <short> · <name>" (cc.JOB_RE).' },
  { id: 'agents-json', section: 5, stability: 'API', search: ['isAgentsJsonInvocation', 'pass its full session id (lowercase, as `claude agents --json` prints it)'],
    note: '`claude agents --json [--all]` prints [{pid?, id, sessionId, status, state, ...}] (cc.jobs).' },
  { id: 'bg-stop', section: 5, stability: 'API', search: 'Stop a background session. Its conversation is kept',
    note: '`claude stop <id>` (cc.stopCmd).' },
  { id: 'bg-logs', section: 5, stability: 'API', search: 'Print the background session\'s recent terminal output.',
    note: '`claude logs <id>` replays a bg session\'s screen; the demo\'s view of the room\'s Claude runs it.' },
  { id: 'daemon-env-filter', section: 5, stability: 'env', search: 'daemon_bg_dispatch_ingest',
    shape: 'let{env:~,reattachEnv:~}=~.data;return{ok:!0,dispatch:{...~.data,env:~(~,~)',
    note: 'The daemon keeps only allowlisted caller env keys (cc.DAEMON_ENV_ALLOW).' },
  { id: 'daemon-env-allowlist', section: 5, stability: 'env',
    search: [ // the binary's own arrays, as JSON text: any key added, dropped or moved fails here
      JSON.stringify(MODEL_KEYS), JSON.stringify(CUSTOM_MODEL_KEYS), JSON.stringify(PROVIDER_KEYS),
      JSON.stringify(CLOUD_KEYS).slice(1), JSON.stringify(EXTRA_KEYS).slice(1),
      '["PATH","CLAUDE_CODE_EXTRA_BODY","CLAUDE_CODE_HOST_CREDS_FILE",',
    ],
    shape: ['new Set(["CLAUDE_CONFIG_DIR","CLAUDE_INTERNAL_FC_OVERRIDES",...~,"CLAUDE_CODE_CLIENT_DATA_URL",...~,"AWS_REGION",',
      `=new Set([...~,...~,${JSON.stringify(EXTRA_KEYS).slice(1)})`],
    note: 'The pieces of the daemon allowlist (q6e + l5n + extras in 2.1.296) that DAEMON_ENV_ALLOW copies.' },
  { id: 'daemon-status', section: 5, stability: 'incidental', search: ['Show daemon pid, version, uptime', '`pid:     ${', '`version: ${'],
    note: '`claude daemon status` prints "pid:     N" and "version: X" while the bg daemon runs, else "not running" and exits 1 (cc.daemonStatus; doctor\'s daemon check, cc-2.1.296.md).' },
  { id: 'daemon-upgrade-exit', section: 5, stability: 'incidental', search: ['exiting for upgrade', '; upgrade polling disabled'],
    note: 'The daemon polls its own binary and, when it was deleted or replaced, exits or restarts for the upgrade (deferred while workers are busy, up to a cap). It does not poll in some modes, nor when it cannot resolve the binary at start ("upgrade polling disabled"): such a daemon keeps running a deleted binary, which doctor\'s daemon check flags (cc-2.1.296.md).' },
  { id: 'bg-worker-env', section: 5, stability: 'incidental', search: 'CLAUDE_CODE_SESSION_KIND:"bg",CLAUDE_BG_BACKEND:"daemon",FORCE_COLOR',
    note: 'Workers run with the daemon\'s own process.env plus the filtered dispatch env.' },
  { id: 'bg-provider-env', section: 5, stability: 'incidental',
    search: ['ignored these saved environment entries in the job\'s state.json', 'not kept for background sessions'],
    note: 'A job\'s persisted providerEnv (state.json) is filtered through the same base allowlist (q6e in 2.1.296); a dropped key is logged as "not kept for background sessions".' },
  // §7 hooks
  { id: 'matcher-rule', section: 7, stability: 'API', search: ['Invalid regex pattern in hook matcher', '/^[a-zA-Z0-9_|, -]+$/:/^[a-zA-Z0-9_|]+$/'],
    note: 'Exact-name list vs unanchored regex (cc.matcherIsExact, cc.matcherMatches).' },
  { id: 'hook-if', section: 7, stability: 'API', search: 'Permission rule syntax to filter when this hook runs (e.g., "Bash(git *)")',
    note: '`if` uses permission-rule syntax; Task tools can only be filtered by bare name.' },
  { id: 'hook-async', section: 7, stability: 'API', search: 'If true, hook runs in background and wakes the model on exit code 2',
    note: 'Per-hook async/asyncRewake fields.' },
  { id: 'stop-additional-context', section: 7, stability: 'incidental', search: '{type:"hook_additional_context",content:',
    shape: ['case"Stop":case"SubagentStop":~.additionalContext=~.hookSpecificOutput.additionalContext', '.agentId?"SubagentStop":"Stop",~=~({type:"hook_additional_context",'],
    note: 'Stop hookSpecificOutput.additionalContext continues the turn with that text, like a block but without the red "Stop hook error" line or notification (only real blockingErrors get those).' },
  // §8 cross-session
  { id: 'prompt-origin-composer', section: 8, stability: 'incidental', search: '{kind:"bridge"}:{kind:"composer"}',
    shape: 'case"human":return ~===!0?{kind:"bridge"}:{kind:"composer"};case"plugin":return ~.asUser===!0?',
    note: 'prompt.submit origin "composer" is only the person\'s own Enter (and a --bg dispatch prompt); -p is "sdk", peers "peer" (also from $.session.send), notifications "task-notification". No hook sets it; seen for a --bg dispatch and a mid-turn peer (cc-2.1.292.md Function hooks S2, S6).' },
  { id: 'transcript-prompt-origin', section: 8, stability: 'incidental', search: ['{kind:"human"}', 'case"human":return'],
    note: 'A typed prompt\'s transcript user entry has no origin or {kind:"human"} (also typed through Remote Control: prompt.submit reports that one as "bridge"); peers, notifications, channels and plugins carry their own kind. cc.lastHumanPrompt takes only the person\'s; hooks/consent.ts picks the proposal a review opens from it (cc-2.1.292.md Remote Control).' },
  { id: 'bridge-forwarded-rows', section: 8, stability: 'incidental', search: ['[remote-bridge] Sending ', 'attachment.type==="hook_system_message")return!0;if('],
    shape: 'if((~.type==="user"||~.type==="assistant")&&~.isVirtual)return!1;if(~.type==="attachment"){if(~.attachment.type==="hook_system_message")return!0;',
    note: 'Remote Control forwards user and assistant rows, a command hook\'s systemMessage (hook_system_message, shown as an assistant line) and a few system kinds, never a $.ui.log notice (system informational); an isMeta user row goes as isSynthetic (not shown there, as far as seen). A function hook\'s result has no systemMessage, so the module reaches the phone only through a turn: mod/deliver.ts relays room lines and an @room\'s refusal there as a prompt while the person types from Remote Control (cc-2.1.292.md Remote Control).' },
  { id: 'plugin-prompt-frame', section: 8, stability: 'incidental', search: ['This is how Claude Code surfaces a prompt a plugin submits between ', 'takes { asUser } as a boolean'],
    shape: '~?.kind==="plugin"&&~.asUser!==!0?~(~.text,~.name,{midTurn:!1}):~.text',
    note: 'A plugin\'s $.prompt.submit between turns enters framed ("The <plugin> plugin sent a message: … This is how Claude Code surfaces a prompt a plugin submits between turns … Address the message above."), and the frame is the row Remote Control shows; asUser:true enters the text bare (the origin stays {kind:"plugin", name, asUser:true}, so cc.lastHumanPrompt still skips it). The relay submits asUser with only the room lines; what the model needs rides as context (cc-2.1.292.md Remote Control).' },
  { id: 'cross-session-inbound', section: 8, stability: 'API', search: 'Inbound cross-session peer messages (SendMessage from your other sessions)',
    note: 'crossSessionInbound accept|hold|refuse; the room\'s Claude sets accept.' },
  { id: 'harbor-kite-gate', section: 8, stability: 'env', search: '"tengu_harbor_kite",!0)',
    shape: 'messagingBeyondOwnAgentsDisabled)return!1;let ~=~.CLAUDE_CODE_HARBOR_KITE;if(~!==void 0)return ~(~);',
    note: 'Cross-session messaging gate (default on); since 2.1.296 the process\'s messagingBeyondOwnAgentsDisabled restriction (beside backgroundTasksDisabled) turns it off before CLAUDE_CODE_HARBOR_KITE is read.' },
  { id: 'pasted-content', section: 8, stability: 'incidental', search: ['<pasted_content id="', '</pasted_content id="'],
    note: 'Long pastes are wrapped in <pasted_content id="N"> (cc.PASTED_RE).' },
  { id: 'session-title-address', section: 8, stability: 'incidental',
    search: ['Hook sessionTitle applied (', 'Names are the address: send with', 'the name IS the address; there is no separate address syntax',
      'applied locally but the session registry record was not updated', '"tengu_session_name_uniqueness",!0)', '" is held by live pid '],
    shape: ['Hook sessionTitle applied (${[...~].length} chars)`),await ~(~,"hook",~,!1,!1,~)', 'return ~==="collision"||~==="peer"?"hook":~}'],
    note: 'A hook\'s sessionTitle renames the session and writes the name to the session registry; ListAgents lists it and SendMessage `to` matches it exactly, so NAME.CODE is the address. Names are unique among live sessions: a second live session given the same name takes a suffixed one and is not reachable at NAME.CODE (cc-2.1.292.md Review spikes, S-title).' },
  // §9 plugin settings
  { id: 'plugin-settings-allowlist', section: 9, stability: 'API', search: ['=["agent","subagentStatusLine"];', 'Loaded settings from settings.json for plugin ', 'Loaded settings from manifest for plugin '],
    note: 'Plugin settings.json keeps only agent and subagentStatusLine.' },
  { id: 'subagent-statusline-precedence', section: 9, stability: 'incidental', search: 'settings_load_started',
    shape: 'let ~=~.store.pluginBase,~={};if(~)~=~(~,~,~);',
    note: 'Any user/project/local/flag subagentStatusLine overrides the plugin\'s.' },
  { id: 'subagent-statusline-raw', section: 9, stability: 'incidental', search: 'Skipping subagentStatusLine execution - workspace trust not accepted',
    note: 'subagentStatusLine command gets no ${CLAUDE_PLUGIN_ROOT} substitution nor PLUGIN_ROOT/DATA env.' },
  // §10 events
  { id: 'hook-events', section: 10, stability: 'API', search: '"Setup","TeammateIdle","TaskCreated","TaskCompleted","Elicitation"',
    note: 'The hook event list; no plan-approved/rejected event.' },
  { id: 'hooks-modules', section: 10, stability: 'env',
    search: ['"tengu_plugin_hooks_modules"', 'installed plugins\' hooks modules not loaded: rollout flag (', '"hooks/register.ts"', '"ui.focus","agent.offer","agent.spawn"'],
    note: 'Function hooks load for installed plugins by default (GrowthBook tengu_plugin_hooks_modules, default on). An installed plugin names its module in hooks.json `modules`; "hooks/register.ts" is only the built-in plugins\' fixed path. sub-human ships one, mod/register.ts, named in hooks.json.' },
  // §10 function hooks: S1-S9 are the spikes in docs/internals/cc-2.1.292.md "Function hooks"
  { id: 'hooks-json-modules', section: 10, stability: 'API',
    search: ['or `modules` (hooks modules), or both', '"$schema","description","hooks","modules","surface"', 'names one hooks module per plugin'],
    note: 'One hooks.json carries the command hooks and one module path under `modules` (relative to hooks.json); a second module is refused (S1).' },
  { id: 'module-dollar-local', section: 10, stability: 'incidental',
    search: '$ is followed only into a function declared in this same file, never across an import',
    note: 'A module that passes $ to an imported function does not load (validate says the same): every $ call sits in the file that registers the hook, so mod/core/*.ts stays $-free (S1).' },
  { id: 'module-event-once', section: 10, stability: 'incidental', search: '" without a matcher"',
    shape: 'is registered twice${~?"":" without a matcher"}',
    note: 'A hooks module registers an event at most once without a matcher (validate and the loader refuse a second): mod/deliver.ts owns session.start, the join and SessionStart (hello and the tail child), mod/prompt.ts owns prompt.submit (the gate, rows context, presence).' },
  { id: 'modules-headless', section: 10, stability: 'env', search: 'in a tool server\'s daemon',
    shape: 'var ~=()=>!~()&&!~()&&~();var ~=()=>~()&&!~("hooks")&&!~();',
    note: 'Modules are off only diskless or in a tool server\'s daemon (then by policy, safe mode, --bare): they load in -p and in a --bg worker such as the room\'s Claude. A --bg dispatch prompt reaches prompt.submit as origin composer (S2).' },
  { id: 'classic-chain-order', section: 10, stability: 'incidental', search: ['function-hook chain`', 'isManaged:!0,budgetMs:0,async run('],
    shape: ['`classic.${~.hook_event_name} function-hook chain`', '[~,...~("classic.PreToolUse",~),~]',
      '{name:"core",isCore:!0,budgetMs:0,async run(~){let ~=~(~),~=await ~(~(~,{managedHooksExcluded:~(~)}),~.tool)'],
    note: 'A classic.<Event> chain is [managed settings hooks, ...modules in load order, core], and core runs every other settings hook. A module that answers without next() therefore skips every non-managed settings hook for that call (its own plugin\'s, other plugins\' and the user\'s and project\'s command hooks) and the modules of plugins loaded after it; managed hooks and earlier-loaded modules still run (S1, S5; cc-2.1.292.md Review spikes, S-skip). sub-human answers without next() only where it blocks or stops a prompt (classic.UserPromptSubmit, TaskCompleted) and for the /sub-human expansion whose join its command.run hook already ran (classic.UserPromptExpansion: the join hook beneath must not run twice); it no longer answers PreToolUse.' },
  { id: 'prompt-submit-ups-order', section: 10, stability: 'incidental', search: 'the prompt was removed from the queue before it ran',
    shape: 'let ~=await ~(~.text,~.text===~?{managedHooksExcluded:!0}:{})',
    note: 'prompt.submit\'s core runs the UserPromptSubmit hooks: prompt.submit (module) -> classic.UserPromptSubmit (module) -> the command hook. A peer delivered mid-turn takes the same path, with turnId set (S6). mod/prompt.ts relies on it: classic.UserPromptSubmit runs inside prompt.submit\'s next(e), so prompt.submit hands it e.origin (the classic payload has none) in a module variable.' },
  { id: 'usermessage-draw-only', section: 10, stability: 'incidental', search: '["origin","isExpanded","task","from"]',
    shape: 'props:{text:~,origin:~(~),isExpanded:~,',
    note: 'A ui.render rewrite of UserMessage text changes only the drawing; origin, isExpanded, task and from are pinned.' },
  { id: 'plugin-types-state', section: 10, stability: 'incidental', search: ['must name it in interface PluginState {', 'the manifest\'s types contract'],
    note: 'validate refuses a $.state value the plugin\'s own types contract (plugin.json "types": types/index.d.ts) does not declare in PluginState; sub-human declares sub-human.hello.' },
  { id: 'session-append-note', section: 10, stability: 'incidental', search: ['door:"note",origin:{kind:"plugin",name:', 'role:"user",isMeta:!0},content:'],
    note: '$.session.append writes a user row as isMeta (the model reads it from the loop\'s next top; an idle session is not woken) and a system row as a notice the model never reads (S4).' },
  { id: 'session-append-notice-hidden', section: 10, stability: 'incidental',
    search: ['"a notice that is not one text block"', 'Render level. \'info\' shows only in transcript mode'],
    shape: '{row:{...~(~,"info"),uuid:~}}:{reason:"a notice that is not one text block"}',
    note: 'A $.session.append system row is stored at level "info": drawn only in the ctrl+o transcript view (also after --resume), never in the default view. Chat lines go through $.ui.log instead (S4).' },
  { id: 'ui-log-notice', section: 10, stability: 'incidental', search: '$.ui.log (to debug): ',
    shape: '=(~)=>~(~(~.plugin,~.text),"notice");',
    note: '$.ui.log lines are stored as system notices at level "notice": drawn dim as "<plugin>: <text>" in the default view, kept across --resume, never read by the model, no wake (S4). One line each: a newline in the text is drawn as U+FFFD (cc-2.1.292.md Function hooks), so mod/deliver.ts logs a chat batch line by line.' },
  // §10 command.run: how /sub-human shows its replies (mod/command.ts); cc-2.1.292.md "Command replies"
  { id: 'command-run-every-command', section: 10, stability: 'incidental', search: 'a hook\'s own answer after next() dropped',
    shape: 'engine:{run:~,textOf:(~)=>~.resultText,contextOf:(~)=>~.metaTexts,retell:~}',
    note: 'command.run fires for every slash command the person runs, a plugin\'s skill included (/sub-human), before it expands; a hook that answers without next() runs no command, so no UserPromptExpansion hook and no model turn.' },
  { id: 'command-run-empty-answer', section: 10, stability: 'incidental', search: 'but no command.run hook answered it',
    shape: ['if(~===void 0&&~.length===0&&!~)return{messages:[],shouldQuery:!1,command:~}', '${~.map(~).join("+")}: ${~.text}'],
    note: 'An answer {} (no text, no context) of a typed prompt adds no row at all: the command line is not echoed and nothing reaches the model; a {text} answer is the command\'s output row, shown under "sub-human: " (the hooking plugins\' names) and read by the model with its echoed command line (local_command rows go to the API), and the model repeats it on its next turn (seen live), so the module shows replies with $.ui.log and answers {text} only through Remote Control, for a prompt and a reply that hold no secret. A prompt run by the SDK, or with pasted blocks before it, is echoed as a user row even then: the module leaves those to the classic hook.' },
  { id: 'expansion-block-frame', section: 10, stability: 'incidental', search: ['UserPromptExpansion operation blocked by hook:', 'Original prompt: '],
    shape: 'if(~.blockingError)yield{blockingError:~.blockingError,suppressOriginalPrompt:~.suppressOriginalPrompt,...~},~="deny";if(~.message)yield{message:~.message,...~}',
    note: 'A UserPromptExpansion block is drawn as a warning "UserPromptExpansion operation blocked by hook:\\n<reason>" (never read by the model), and the expansion stops at the first block, before that hook\'s systemMessage is read: a block shows its reason alone. The classic join hook (no module) still answers this way.' },
  { id: 'ups-stop-frame', section: 10, stability: 'incidental', search: ['Operation stopped by hook', 'cmd_prompt_submit_hook_stopped'],
    shape: ['if(~.preventContinuation){let ~=~(~.stopReason);return ~.messages=[...~.messages,~(~),~(~)]',
      'var ~=(~)=>~(~,"warning",void 0,~);var ~=(~)=>~===void 0?~:`${~}: ${~}`;'],
    note: 'A UserPromptSubmit stop (continue:false, a function hook\'s preventContinuation) keeps the person\'s row and adds two: an isMeta user row the model reads and a system warning row the person sees, both "Operation stopped by hook: <stopReason>". Nothing else ends a typed non-slash prompt without a turn and without a frame: a prompt.submit drop draws "Prompt dropped by a hook: <reason>" (and loses the person\'s row), an answer without next "Prompt not submitted: …". An @room\'s receipt is such a stop; mod/prompt.ts rewrites its warning row (session-append-notice-rewrite).' },
  { id: 'session-append-notice-rewrite', section: 10, stability: 'incidental', search: 'session.append: a rewrite of row',
    shape: ['case"system":{if(!("content"in ~)||typeof ~.content!=="string")return ~;let ~=~([~.content],~).join(',
      'if(!~.fills)~.keep([~]);return ~(~),{message:~,uuid:~.uuid}', 'return ~.subtype==="local_command"?"command":"notice"'],
    note: 'Every system row the engine adds (door "notice"), the stop\'s warning row included, passes session.append before it is kept, and a rewrite of its one text block is the row the screen draws and the transcript keeps (so --resume draws it too); its level stays (a warning: an amber ⏺). Seen live on 2.1.292: "Operation stopped by hook: ✓ sent" rewritten to "✓ sent" drew "⏺ ✓ sent" and was stored so. On 2.1.300 it was reported not to rewrite (the frame stayed): the receipt\'s words read as a delivery under the frame too (hooks/at-room.ts). The d.ts says only that the screen "may show the row just before its rewrite".' },
  { id: 'modules-switch-cache', section: 10, stability: 'incidental', search: ['cachedGrowthBookFeatures', '"tengu_plugin_hooks_modules"'],
    note: 'Claude Code caches the hooks modules rollout switch in the global config\'s cachedGrowthBookFeatures (cc.modulesSwitch): false there explains a session with no module (hooks/join.ts noModule, doctor).' },
  { id: 'fs-write-plain', section: 10, stability: 'incidental', search: '$.fs.write (',
    shape: 'await ~(~(~),{recursive:!0}),await ~(~,~.text,"utf8"),~(`$.fs.write (',
    note: '$.fs.write is mkdir -p plus writeFile: not atomic, no mode, no lock. The mod never writes room state.' },
  { id: 'process-run-stdin', section: 10, stability: 'API', search: 'toolCgroupClass:"plugin"',
    shape: ['function ~({command:~,args:~,cwd:~,env:~,hasInput:~}){let ~={...~(),...~},', 'hasInput:~?.stdin!==void 0}'],
    note: '$.process.run takes argv, stdin, env over the host env and a timeout. The child\'s parent is the claude process, but it gets no CLAUDE_PID or CLAUDE_CODE_SESSION_ID of this session (only whatever claude itself inherited), so shims pass the payload session_id (S3).' },
  { id: 'plugin-test-discovery', section: 10, stability: 'incidental', search: ['.isFile()&&/\\.test\\.tsx?$/.test(', 'Runs every *.test.ts and *.test.tsx under dir'],
    note: '`claude plugin test` collects every *.test.ts(x) under the plugin; node tests stay *.test.js (S8).' },
  { id: 'plugin-test-off', section: 10, stability: 'env',
    search: ['hooks modules are turned off here (disableAllHooks, allowManagedHooksOnly or a policy)', 'hooks modules are turned off in this process: '],
    note: 'With modules off, `claude plugin test` exits 1 printing "claude plugin test: hooks modules are turned off ..."; npm test reads that as a skip (S8).' },
]);

// ---------- the binary, for the probe and doctor ----------
const PROBED_VERSION = '2.1.296';
const MIN_VERSION = '2.1.292';

function compareVersions(a: unknown, b: unknown): -1 | 0 | 1 | null {
  const parse = (v: unknown): number[] | null => { const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || '')); return m ? m.slice(1).map(Number) : null; };
  const x = parse(a), y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

const isFile = (p: string): boolean => { try { return fs.statSync(p).isFile(); } catch { return false; } };
function onPath(cmd: string, env: Env): string | null {
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (dir && isFile(path.join(dir, cmd))) return path.join(dir, cmd);
  }
  return null;
}
function caskroom(root = '/opt/homebrew/Caskroom') {
  let best: { p: string; mt: number } | null = null;
  let casks: string[] = [];
  try { casks = fs.readdirSync(root).filter(d => d.startsWith('claude-code')); } catch { return null; }
  for (const c of casks) {
    let vs: string[] = [];
    try { vs = fs.readdirSync(path.join(root, c)); } catch { continue; }
    for (const v of vs) {
      const p = path.join(root, c, v, 'claude');
      if (!isFile(p)) continue;
      const mt = fs.statSync(p).mtimeMs;
      if (!best || mt > best.mt) best = { p, mt };
    }
  }
  return best && best.p;
}
/** A JS shim (npm install) is followed to its real file only via realpath. */
function locateBinary({ bin, env = process.env }: { bin?: string; env?: Env } = {}): string | null {
  for (const c of [bin, env.CLAUDE_BIN, onPath('claude', env), caskroom()].filter((x): x is string => !!x)) {
    let p;
    try { p = fs.realpathSync(c); } catch { continue; }
    if (isFile(p)) return p;
  }
  return null;
}

function binaryVersion(buf: Buffer): string | null {
  const i = buf.indexOf('VERSION:"');
  if (i < 0) return null;
  const v = /^(\d+\.\d+\.\d+[^"]*)"/.exec(buf.toString('latin1', i + 9, i + 40));
  return v ? v[1] : null;
}

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
 * --version` while it still exists. Used only to word a refusal (hooks/join.ts noModule).
 */
function runningVersion(pid: unknown, { timeoutMs = 3000 }: { timeoutMs?: number } = {}): string | null {
  const st = exeState(pid, { timeoutMs });
  if (!st) return null;
  let exe = st.exe;
  try { exe = fs.realpathSync(exe); } catch { /* as ps gave it */ }
  const inPath = /(?:^|\/)(\d+\.\d+\.\d+)(?:\/|$)/.exec(exe);
  if (inPath) return inPath[1];
  if (!path.isAbsolute(exe) || st.deleted) return null;
  const r = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: timeoutMs });
  const m = /(\d+\.\d+\.\d+)/.exec(String(r.stdout || ''));
  return m ? m[1] : null;
}

/** The global config file Claude Code keeps its cached feature switches in: $CLAUDE_CONFIG_DIR/.claude.json, else
 * ~/.claude.json. */
const globalConfigFile = (env: Env = process.env): string => (env[ENV.CONFIG_DIR]
  ? path.join(env[ENV.CONFIG_DIR]!, '.claude.json') : path.join(env.HOME || os.homedir(), '.claude.json'));

/**
 * The installed plugins' hooks modules switch as Claude Code last cached it (cachedGrowthBookFeatures
 * .tengu_plugin_hooks_modules in the global config; CONTRACT hooks-modules, modules-switch-cache): true, false, or
 * undefined when unknown (no file, no entry: the default, on). Read only.
 */
function modulesSwitch(env: Env = process.env): boolean | undefined {
  let j;
  try { j = JSON.parse(fs.readFileSync(globalConfigFile(env), 'utf8')); } catch { return undefined; }
  const v = j && j.cachedGrowthBookFeatures && j.cachedGrowthBookFeatures.tengu_plugin_hooks_modules;
  return typeof v === 'boolean' ? v : undefined;
}

// Buffer#indexOf over the whole binary cost ~50 ms a call and a shape regex over all of it seconds: the probe test
// timed out with the suite running beside it. IDENT_MAX bounds one minified identifier (they are a few chars).
const IDENT_MAX = 64;
const latin1 = (s: unknown): string => Buffer.from(String(s), 'utf8').toString('latin1');
function shapeIn(text: string, shape: string): boolean {
  const parts = String(shape).split('~');
  let k = 0;
  for (let i = 1; i < parts.length; i++) if (parts[i].length > parts[k].length) k = i;
  const anchor = parts[k];
  const re = shapeRe(shape);
  if (!anchor) return re.test(text);
  const before = parts.slice(0, k).join('').length + k * IDENT_MAX;
  const after = parts.slice(k + 1).join('').length + (parts.length - 1 - k) * IDENT_MAX;
  for (let at = text.indexOf(anchor); at >= 0; at = text.indexOf(anchor, at + 1)) {
    if (re.test(text.slice(Math.max(0, at - before), at + anchor.length + after))) return true;
  }
  return false;
}
function quotedNames(text: string): Set<string> {
  const set = new Set<string>();
  for (const m of text.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)(?=")/g)) set.add(m[1]);
  return set;
}

function probe(buf: Buffer, { entries = CONTRACT, envNames = true }: { entries?: readonly ContractEntry[]; envNames?: boolean } = {}): ProbeResult[] {
  const text = buf.toString('latin1');
  const list = (x: string | readonly string[] | undefined): readonly string[] => (x === undefined ? [] : typeof x === 'string' ? [x] : x);
  const results = entries.map(e => {
    const missing = list(e.search).filter(s => text.indexOf(latin1(s)) < 0);
    for (const sh of list(e.shape)) if (!shapeIn(text, sh)) missing.push(`shape: ${sh}`);
    return { id: e.id, stability: e.stability, ok: missing.length === 0, missing, note: e.note };
  });
  if (envNames) {
    const names = quotedNames(text);
    const absent = DAEMON_ENV_ALLOW.filter(k => !names.has(k));
    results.push({ id: 'daemon-env-names', stability: 'env', ok: absent.length === 0, missing: absent, note: 'every cc.DAEMON_ENV_ALLOW key is a string in the binary' });
  }
  return results;
}

export {
  ENV, sessionId, claudePid, taskListId, configDir, sanitizeId, tasksDir, taskFile, userSettingsFiles,
  clearContextOnPlanAccept, readLines, readEntries, parseLines, planFile, planAnswer, planFeedback, toolUseInput,
  lastHumanPrompt, contentText, SAID, NOTE, PASTED_RE, unwrapPasted, JOB_RE, parseDispatch, agentsCmd, stopCmd,
  parseAgentsJson, jobs, parseDaemonStatus, daemonStatus, exeState, DAEMON_ENV_ALLOW, daemonEnv, matcherIsExact, matcherMatches, shapeRe, CONTRACT,
  PROBED_VERSION, MIN_VERSION, compareVersions, locateBinary, binaryVersion, probe, runningVersion, globalConfigFile,
  modulesSwitch,
};
export type { TranscriptEntry, TranscriptLine, ContentBlock, AgentJob, ContractEntry, ProbeResult, JobsOpts, DaemonStatus, ExeStateOpts };
