'use strict';
/**
 * plugin/sub-human/lib/cc.js: the single home for every Claude Code internal the plugin relies on.
 *
 * Source of truth: docs/internals/cc-2.1.281.md (a read of the 2.1.281 binary). Every export names the
 * literal string to search the binary for (`@cc`) and how stable the assumption is (`@stability`):
 *   API         documented hook/settings schema, a `.describe()` string, or an exported name
 *   env         a named env var or flag
 *   incidental  follows from how the code is written; not named anywhere (transcript shapes, display text)
 * CONTRACT lists every assumption, including ones that only shape docs or design; scripts/probe-cc.js
 * greps the installed binary for each `search` and fails when one is gone.
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
 *   planFile(lines, toolInput?), planFeedback(lines, toolUseId), toolUseInput(lines, toolUseId)
 *   contentText(content), entryIsPeer(entry), isPeerText(prompt), isPeerPrompt(input), parseEnvelope(text)
 *   isTaskNotification(prompt), PASTED_RE, unwrapPasted(text)
 *   JOB_RE, parseDispatch(text), parseAgentsJson(text), jobs(opts), agentsCmd(all), stopCmd(id), logsCmd(id)
 *   DAEMON_ENV_ALLOW, daemonEnv(env)
 *   matcherIsExact(m, {toolEvent}), matcherMatches(m, name, {toolEvent})
 *   HOOK_TIMEOUT_DEFAULT_MS, SESSION_END_DEFAULT_MS, SESSION_END_MAX_MS, sessionEndBudgetMs(timeoutsSec, env)
 *   CONTRACT                             [{id, search, stability, note}]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// ---------- env ----------

/**
 * Env var names. CLAUDE_PID and CLAUDE_CODE_SESSION_ID are set (by M0e) for hooks, Bash, statusLine,
 * subagentStatusLine and monitors; MCP stdio servers get the session id but not CLAUDE_PID.
 * @cc CLAUDE_CODE_CHILD_SESSION:"1",CLAUDE_CODE_SESSION_ATTENDED
 * @stability env
 */
const ENV = Object.freeze({
  PID: 'CLAUDE_PID',
  SESSION_ID: 'CLAUDE_CODE_SESSION_ID',
  TASK_LIST_ID: 'CLAUDE_CODE_TASK_LIST_ID',
  ENABLE_TODO_TOOLS: 'CLAUDE_CODE_ENABLE_TODO_TOOLS',
  CONFIG_DIR: 'CLAUDE_CONFIG_DIR',
  SESSION_END_TIMEOUT: 'CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS',
  PLUGIN_ROOT: 'CLAUDE_PLUGIN_ROOT',
  PLUGIN_DATA: 'CLAUDE_PLUGIN_DATA',
  PROJECT_DIR: 'CLAUDE_PROJECT_DIR',
});

/**
 * The session id Claude Code exported to this child, or null. Fixed at spawn: after /clear only children
 * spawned later see the new id (running monitors and MCP servers keep the old one).
 * @cc conversation_reset",newConversationId
 * @stability env
 */
function sessionId(env = process.env) {
  const s = env[ENV.SESSION_ID];
  return typeof s === 'string' && s ? s : null;
}

/**
 * The owning claude process pid from CLAUDE_PID (a positive integer), or null. No hook input carries a pid.
 * @cc CLAUDE_PID:String(process.pid)
 * @stability env
 */
function claudePid(env = process.env) {
  const p = Number(env[ENV.PID]);
  return Number.isInteger(p) && p > 0 ? p : null;
}

/**
 * CLAUDE_CODE_TASK_LIST_ID when set, else null (the caller supplies its own fallback).
 * @cc function Mk(){if(a.CLAUDE_CODE_TASK_LIST_ID)return a.CLAUDE_CODE_TASK_LIST_ID
 * @stability env
 */
function taskListId(env = process.env) {
  const s = env[ENV.TASK_LIST_ID];
  return typeof s === 'string' && s ? s : null;
}

// ---------- config dir and task store ----------

/**
 * Claude Code's config home: CLAUDE_CONFIG_DIR, else ~/.claude (NFC-normalized, as the binary does).
 * @cc new Set(["CLAUDE_CONFIG_DIR","CLAUDE_INTERNAL_FC_OVERRIDES",
 * @stability env
 */
function configDir(env = process.env) {
  const d = env[ENV.CONFIG_DIR] || path.join(env.HOME || os.homedir(), '.claude');
  return d.normalize('NFC');
}

/**
 * The task store's file-name sanitiser: every char outside [A-Za-z0-9_-] becomes '-'.
 * @cc function aP(e){return e.replace(/[^a-zA-Z0-9_-]/g,"-")}
 * @stability incidental
 */
const sanitizeId = s => String(s).replace(/[^a-zA-Z0-9_-]/g, '-');

/**
 * <configDir>/tasks/<sanitized listId>: the native task list directory (file backend; the experimental v5
 * key-value backend is off by default).
 * @cc function aP(e){return e.replace(/[^a-zA-Z0-9_-]/g,"-")}
 * @stability incidental
 */
const tasksDir = (listId, env = process.env) => path.join(configDir(env), 'tasks', sanitizeId(listId));

/**
 * <tasksDir>/<sanitized id>.json: one native task.
 * @cc function aP(e){return e.replace(/[^a-zA-Z0-9_-]/g,"-")}
 * @stability incidental
 */
const taskFile = (listId, id, env = process.env) => path.join(tasksDir(listId, env), `${sanitizeId(id)}.json`);

// ---------- settings ----------

/**
 * The settings files the plugin checks for showClearContextOnPlanAccept: user (<configDir>/settings.json),
 * then project and local under cwd/.claude. Claude Code merges more sources (flag, policy); these are the
 * ones a person edits.
 * @cc When true, the plan-approval dialog offers a "clear context" option. Defaults to false.
 * @stability API
 */
function userSettingsFiles(cwd, env = process.env) {
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
function clearContextOnPlanAccept(cwd, env = process.env) {
  return userSettingsFiles(cwd, env).some(f => {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')).showClearContextOnPlanAccept === true; } catch { return false; }
  });
}

// ---------- transcript ----------

/**
 * A JSONL transcript's raw lines (oldest first; [] when unreadable). With tailBytes, only the last tailBytes
 * are read and a line cut by that boundary is dropped.
 * @cc toolDenialKind:_e,toolDenialEndsTurn:ve,userFeedback:Ee
 * @stability incidental
 */
function readLines(file, { tailBytes } = {}) {
  if (typeof file !== 'string' || !file) return [];
  let text;
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
function parseLines(lines) {
  const es = [];
  for (const l of lines) {
    if (l && typeof l === 'object') { es.push(l); continue; }
    try { es.push(JSON.parse(l)); } catch { /* torn line */ }
  }
  return es;
}

/**
 * readLines, parsed. Same as at-room's transcriptTail with tailBytes 512 KiB.
 * @cc toolDenialKind:_e,toolDenialEndsTurn:ve,userFeedback:Ee
 * @stability incidental
 */
const readEntries = (file, opts) => parseLines(readLines(file, opts));

// Lines may be raw strings (cheap substring prefilter, then parse) or already-parsed entries.
const lineHas = (l, ...subs) => typeof l !== 'string' || subs.every(s => l.includes(s));
const asEntry = l => { if (l && typeof l === 'object') return l; try { return JSON.parse(l); } catch { return null; } };

/**
 * The session's plan file: toolInput.planFilePath (PreToolUse/PermissionRequest on ExitPlanMode see it,
 * injected by normalizeToolInput), else the latest `plan_mode` attachment's planFilePath, else null.
 * @cc type:"plan_mode",reminderType:ge,isSubAgent:!!r.agentId,planFilePath:h,planExists
 * @stability incidental
 */
function planFile(lines, toolInput) {
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

const contentText = c => typeof c === 'string' ? c
  : Array.isArray(c) ? c.map(b => (b && b.type === 'text' && typeof b.text === 'string') ? b.text : '').join('\n') : '';

/** The text before a rejected tool's note ("…To tell you how to proceed, the user said:\n<note>"). */
const SAID = 'the user said:\n';
/** What follows the note in the rejection text. */
const NOTE = '\n\nNote: The user\'s next message';

/**
 * The person's "No, keep planning" / "Tell Claude what to change" note for tool use toolUseId, or null
 * (no rejection on disk yet, not an error result, or rejected with no note, e.g. Esc). Prefers the
 * structured top-level `userFeedback` field on the tool_result entry; falls back to the text after
 * "the user said:\n" (cut at the "Note: The user's next message" suffix).
 * @cc toolDenialKind:_e,toolDenialEndsTurn:ve,userFeedback:Ee
 * @stability incidental
 */
function planFeedback(lines, toolUseId) {
  if (!toolUseId) return null;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!lineHas(lines[k], toolUseId, 'tool_result')) continue;
    const e = asEntry(lines[k]);
    const msg = e && e.message;
    const block = (msg && Array.isArray(msg.content) ? msg.content : []).find(b => b && b.type === 'tool_result' && b.tool_use_id === toolUseId);
    if (!block) continue;
    if (!block.is_error) return null;
    if (typeof e.userFeedback === 'string') return e.userFeedback;
    const t = contentText(block.content);
    const at = t.indexOf(SAID);
    if (at < 0) return null;
    const rest = t.slice(at + SAID.length);
    const end = rest.lastIndexOf(NOTE);
    return end >= 0 ? rest.slice(0, end) : rest;
  }
  return null;
}

/**
 * The input the model itself sent for tool use toolUseId (from the assistant tool_use block), or null.
 * ExitPlanMode's hook input has plan/planFilePath injected from disk; the transcript copy has them stripped.
 * @cc Iit=new Map([[Ou,new Set(["plan","planFilePath"])]])
 * @stability incidental
 */
function toolUseInput(lines, toolUseId) {
  if (!toolUseId) return null;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!lineHas(lines[k], toolUseId, '"tool_use"')) continue;
    const e = asEntry(lines[k]);
    const c = e && e.message && e.message.content;
    const b = (Array.isArray(c) ? c : []).find(x => x && x.type === 'tool_use' && x.id === toolUseId);
    if (b) return b.input;
  }
  return null;
}

// ---------- prompts: peers, notifications, pastes ----------

/** The receiver-side envelope's open tag. */
const PEER_ENVELOPE = /<cross-session-message\b/;
/** The held-message / mid-turn delivery prefix. */
const PEER_PREFIX = /^\s*Another Claude session sent a message/;

/**
 * Text that carries a peer delivery: the "Another Claude session sent a message" prefix, or the
 * <cross-session-message envelope within the first 2000 chars. Same as at-room's isPeer.
 * @cc from-session="
 * @stability incidental
 */
const isPeerText = prompt => typeof prompt === 'string' && (PEER_PREFIX.test(prompt) || PEER_ENVELOPE.test(prompt.slice(0, 2000)));

/**
 * A UserPromptSubmit input that is a peer delivery. `source` is "system" for peer/channel messages, task
 * notifications and auto-continuation; a composer prompt is "user". With source present, a peer is
 * source "system" plus the envelope/prefix (so a person who pastes an envelope is not a peer); with source
 * absent (the field is still rolling out) the text check alone decides, as at-room does today.
 * @cc `system` = other machine-injected turns (peer/channel messages
 * @stability API
 */
function isPeerPrompt(input = {}) {
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (input.source === undefined || input.source === null) return isPeerText(prompt);
  return input.source === 'system' && isPeerText(prompt);
}

/**
 * A transcript user entry from a peer: origin.kind "peer", or the envelope/prefix in its text.
 * @cc kind:R("peer"),from:o(),fromMode:z(["bypass","prompting"])
 * @stability incidental
 */
const entryIsPeer = e => !!e && ((e.origin && e.origin.kind === 'peer') || isPeerText(contentText(e.message && e.message.content)));

const ATTR = '[^"<>\\n\\r]*';
/** The envelope with its optional attributes in the binary's fixed order; group 7 is the body. */
const ENVELOPE_RE = new RegExp(
  `<cross-session-message(?: from="(${ATTR})")?(?: from-session="(${ATTR})")?(?: hop-chain="(${ATTR})")?`
  + `(?: from-name="(${ATTR})")?(?: from-mode="(${ATTR})")?(?: from-plugin="(${ATTR})")?>\\n([\\s\\S]*?)\\n</cross-session-message>`);

/**
 * Parse a <cross-session-message> envelope: {from, fromSession, hopChain[], fromName, fromMode, fromPlugin,
 * body} (absent attributes are null; hopChain is []), or null. Attributes must appear in the order
 * from, from-session, hop-chain, from-name, from-mode, from-plugin (the binary's parser is that strict).
 * The body may start with a spliced "[SendFile: …]" line.
 * @cc (?: from-name="([^"<>\n\r]+)")?(?: from-mode="(
 * @stability incidental
 */
function parseEnvelope(text) {
  const m = typeof text === 'string' ? ENVELOPE_RE.exec(text) : null;
  if (!m) return null;
  const v = i => (m[i] === undefined ? null : m[i]);
  return {
    from: v(1), fromSession: v(2), hopChain: m[3] ? m[3].split(',').filter(Boolean) : [],
    fromName: v(4), fromMode: v(5), fromPlugin: v(6), body: m[7],
  };
}

/**
 * A monitor / background-task notice injected as a prompt.
 * @cc <task-notification>
 * @stability incidental
 */
const isTaskNotification = prompt => typeof prompt === 'string' && prompt.startsWith('<task-notification>');

/**
 * A long paste as the prompt carries it: \n\n<pasted_content id="N">\n…\n</pasted_content id="N">\n.
 * Same regex as at-room's PASTE (global; reset lastIndex or use String#replace).
 * @cc <pasted_content id="
 * @stability incidental
 */
const PASTED_RE = /(?:\n\n)?<pasted_content id="?(\w+)"?>\n([\s\S]*?)\n?<\/pasted_content id="?\1"?>\n?/g;

/** {text, normalized}: the prompt with each paste wrapper replaced by its body. Same as at-room's unwrap. */
function unwrapPasted(text) {
  let normalized = false;
  const t = String(text).replace(PASTED_RE, (_, _id, body) => { normalized = true; return body; });
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
function parseDispatch(text) {
  const m = JOB_RE.exec(String(text || ''));
  return m ? m[1] : null;
}

/**
 * argv for the machine-readable session list. Without --all, finished bg jobs are left out.
 * @cc isAgentsJsonInvocation
 * @stability API
 */
const agentsCmd = (all = false) => (all ? ['agents', '--json', '--all'] : ['agents', '--json']);

/**
 * argv to stop a bg session (prints "stopped <id>"; the conversation is kept).
 * @cc Stop a background session. Its conversation is kept
 * @stability API
 */
const stopCmd = id => ['stop', String(id)];

/**
 * argv to replay a bg session's recent terminal output (no JSON form).
 * @cc Print the background session's recent terminal output.
 * @stability API
 */
const logsCmd = id => ['logs', String(id)];

/**
 * Parse `claude agents --json` stdout into [{pid, id, sessionId, status, state, kind, name, cwd, startedAt}]
 * (missing fields null; interactive sessions have no id), or null when it isn't a JSON array.
 * status: idle|waiting|busy (live only); state: working|blocked|done|failed|stopped (bg only).
 * @cc pass its full session id (lowercase, as `claude agents --json` prints it)
 * @stability API
 */
function parseAgentsJson(text) {
  let a;
  try { a = JSON.parse(String(text || '')); } catch { return null; }
  if (!Array.isArray(a)) return null;
  const s = x => (typeof x === 'string' ? x : null);
  return a.filter(j => j && typeof j === 'object').map(j => ({
    pid: Number.isInteger(j.pid) && j.pid > 0 ? j.pid : null,
    id: s(j.id), sessionId: s(j.sessionId), status: s(j.status), state: s(j.state),
    kind: s(j.kind), name: s(j.name), cwd: s(j.cwd), startedAt: Number.isFinite(j.startedAt) ? j.startedAt : null,
  }));
}

/**
 * Run `claude agents --json [--all]` and parse it: the array, or null when the command fails or prints
 * something else (callers then fall back to the id they parsed with JOB_RE at dispatch).
 * opts: {all, bin = SUB_HUMAN_CLAUDE || 'claude', env, timeout = 15000, run = spawnSync}.
 * @cc isAgentsJsonInvocation
 * @stability API
 */
function jobs({ all = false, bin = process.env.SUB_HUMAN_CLAUDE || 'claude', env = process.env, timeout = 15_000, run = spawnSync } = {}) {
  let r;
  try { r = run(bin, agentsCmd(all), { env, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return null; }
  if (!r || r.error || r.status !== 0) return null;
  return parseAgentsJson(r.stdout);
}

// ---------- daemon env allowlist ----------

// p0e = CLAUDE_CONFIG_DIR, CLAUDE_INTERNAL_FC_OVERRIDES, ...Fpr (Qqe, Qin, SUBAGENT_MODEL_FORCE), ...a4, cloud keys
const MODEL_KEYS = [ // Qqe
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL',
  ...['FABLE', 'HAIKU', 'OPUS', 'SONNET'].flatMap(f => [`ANTHROPIC_DEFAULT_${f}_MODEL`, `ANTHROPIC_DEFAULT_${f}_MODEL_DESCRIPTION`,
    `ANTHROPIC_DEFAULT_${f}_MODEL_NAME`, `ANTHROPIC_DEFAULT_${f}_MODEL_SUPPORTED_CAPABILITIES`]),
  'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION', 'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_3P_PROBE_WROTE_SONNET_DEFAULT', 'CLAUDE_CODE_3P_PROBE_WROTE_OPUS_DEFAULT',
];
const CUSTOM_MODEL_KEYS = ['ANTHROPIC_CUSTOM_MODEL_OPTION', 'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION', // Qin
  'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME', 'ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES'];
const PROVIDER_KEYS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', // a4
  'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_GATEWAY',
  'ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_VERTEX_PROJECT_ID', 'ANTHROPIC_AWS_WORKSPACE_ID', 'ANTHROPIC_GOOGLE_CLOUD_PROJECT',
  'ANTHROPIC_GOOGLE_CLOUD_LOCATION', 'ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID', 'CLOUD_ML_REGION'];
const CLOUD_KEYS = ['AWS_REGION', 'AWS_DEFAULT_REGION', 'ANTHROPIC_BEDROCK_REGION_PREFIX', 'AWS_PROFILE', 'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_HOST_GATEWAY_LINEAGE'];
// Ghn = PATH, EXTRA_BODY, HOST_CREDS_FILE, ...QCe (lMe endpoints + companions)
const ENDPOINT_KEYS = ['ANTHROPIC_BASE_URL', '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_BEDROCK_BASE_URL', 'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'ANTHROPIC_VERTEX_BASE_URL', 'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'ANTHROPIC_FOUNDRY_BASE_URL', 'CLAUDE_CODE_SKIP_FOUNDRY_AUTH', 'ANTHROPIC_AWS_BASE_URL', 'CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH',
  'ANTHROPIC_GOOGLE_CLOUD_BASE_URL', 'CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH', 'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'CLAUDE_CODE_SKIP_MANTLE_AUTH'];

/**
 * The env keys the bg daemon keeps from a `claude --bg` dispatch (eYn = p0e + Ghn + extras), exactly as
 * 2.1.281 builds it. Every other caller env key (CLAUDE_CODE_TASK_LIST_ID, SUB_HUMAN_*, HOME, ...) is dropped;
 * the worker runs with the daemon's own process.env plus these. Auth secrets (ANTHROPIC_API_KEY, ...) are
 * not in it. Pass state to a bg job through argv (`--settings '{"env":{...}}'`) instead.
 * @cc let{env:a,reattachEnv:h}=n.data;return{ok:!0,dispatch:{...n.data,env:sRe(a,eYn)
 * @stability env
 */
const DAEMON_ENV_ALLOW = Object.freeze([...new Set([
  'CLAUDE_CONFIG_DIR', 'CLAUDE_INTERNAL_FC_OVERRIDES', ...MODEL_KEYS, ...CUSTOM_MODEL_KEYS, 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE',
  ...PROVIDER_KEYS, ...CLOUD_KEYS,
  'PATH', 'CLAUDE_CODE_EXTRA_BODY', 'CLAUDE_CODE_HOST_CREDS_FILE', ...ENDPOINT_KEYS,
  'CLAUDE_CODE_AUTO_MODE_SERVER', 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', 'CLAUDE_BG_ISOLATION',
  'CLAUDE_BG_SESSION_PERMISSION_RULES', 'CLAUDE_BG_MEMORY_TOGGLED_OFF', 'CLAUDE_CODE_RESUME_SOURCE_ALIVE', 'CLAUDE_CODE_PLUGIN_DIRS',
])]);
const DAEMON_ENV_SET = new Set(DAEMON_ENV_ALLOW);

/**
 * env reduced to what the daemon would keep from it (sRe(env, eYn)).
 * @cc let{env:a,reattachEnv:h}=n.data;return{ok:!0,dispatch:{...n.data,env:sRe(a,eYn)
 * @stability env
 */
function daemonEnv(env = process.env) {
  const out = {};
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
function matcherIsExact(m, { toolEvent = true } = {}) {
  if (typeof m !== 'string' || !m || m === '*') return false;
  return (toolEvent ? /^[a-zA-Z0-9_|, -]+$/ : /^[a-zA-Z0-9_|]+$/).test(m);
}

/**
 * Whether matcher m selects name, per the binary rule (tool aliases not modelled).
 * @cc Invalid regex pattern in hook matcher
 * @stability API
 */
function matcherMatches(m, name, { toolEvent = true } = {}) {
  if (!m || m === '*') return true;
  if (matcherIsExact(m, { toolEvent })) {
    return m.split(toolEvent ? /[|,]/ : '|').map(s => s.trim()).filter(Boolean).includes(name);
  }
  try { return new RegExp(m).test(name); } catch { return false; }
}

// ---------- timeouts ----------

/**
 * Default per-hook timeout (ms) when a hook sets none.
 * @cc var Ua=600000,Ghe=30000
 * @stability API
 */
const HOOK_TIMEOUT_DEFAULT_MS = 600_000;
/**
 * SessionEnd hooks' floor budget (ms): the whole SessionEnd run is cut at this unless a hook asks for more.
 * @cc function Zde(){let e=a.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS
 * @stability API
 */
const SESSION_END_DEFAULT_MS = 1500;
/**
 * SessionEnd budget ceiling (ms).
 * @cc function Zde(){let e=a.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS
 * @stability API
 */
const SESSION_END_MAX_MS = 60_000;

/**
 * The SessionEnd budget: CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS when set, else the largest SessionEnd hook
 * `timeout` (seconds) in ms, clamped to [1500, 60000].
 * @cc function Zde(){let e=a.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS
 * @stability env
 */
function sessionEndBudgetMs(timeoutsSec = [], env = process.env) {
  const o = env[ENV.SESSION_END_TIMEOUT];
  if (o !== undefined && o !== '' && Number.isFinite(Number(o))) return Number(o);
  let n = 0;
  for (const t of timeoutsSec) if (t && t * 1000 > n) n = t * 1000;
  return Math.max(SESSION_END_DEFAULT_MS, Math.min(n, SESSION_END_MAX_MS));
}

// ---------- the contract ----------

/**
 * Every Claude Code assumption the plugin makes. `search` is a literal string (or array: all must match)
 * found in the 2.1.281 binary; scripts/probe-cc.js checks them. `section` points into the internals doc.
 */
const CONTRACT = Object.freeze([
  // §1 tasks
  { id: 'task-completed-block-drops-fields', section: 1, stability: 'incidental', search: 'TaskCompleted hooks cancelled (control stream closed)',
    note: 'A TaskCompleted block makes TaskUpdate return success:false, updatedFields:[] before the write: every field in that call (subject, metadata, owner) is discarded.' },
  { id: 'hook-exit2-blocks', section: 1, stability: 'API', search: 'if(cr.status===2&&!di.blockingError)di.blockingError',
    note: 'Exit 2 makes stderr the blockingError.' },
  { id: 'hook-json-block', section: 1, stability: 'API', search: 'case"block":U.permissionBehavior="deny",U.blockingError={blockingError:e.reason||"Blocked by hook"',
    note: '{"decision":"block","reason"} is a blockingError.' },
  { id: 'hook-missing-script', section: 1, stability: 'incidental', search: 'Hook script appears to be missing',
    note: 'Stop/SubagentStop/TaskCompleted/TeammateIdle (and plugin UserPromptSubmit): exit 2 with empty stdout and "no such file|can\'t open" stderr is non-blocking.' },
  { id: 'task-completed-input', section: 1, stability: 'API', search: 'hook_event_name:R("TaskCompleted"),task_id:o(),task_subject:o(),task_description:o().optional(),teammate_name',
    note: 'TaskCompleted input has no metadata/owner/status; read the task file (which still has the old status).' },
  { id: 'task-events-no-matcher', section: 1, stability: 'API', search: 'case"TeammateIdle":case"TaskCreated":case"TaskCompleted":return;',
    note: 'TaskCreated/TaskCompleted/TeammateIdle have no matcher query: every hook fires.' },
  { id: 'task-completed-teammate-stop', section: 1, stability: 'incidental', search: 'TaskCompleted hook prevented continuation',
    note: 'Agent teams: a teammate Stop fires TaskCompleted per owned in_progress task.' },
  { id: 'task-created-block-deletes', section: 1, stability: 'API', search: 'TaskCreated hooks cancelled (control stream closed)',
    note: 'A TaskCreated block deletes the task and throws.' },
  { id: 'task-update-schema', section: 1, stability: 'API', search: 'Metadata keys to merge into the task. Set a key to null to delete it.',
    note: 'TaskUpdate metadata merges; null deletes a key.' },
  { id: 'task-create-metadata', section: 1, stability: 'API', search: 'Arbitrary metadata to attach to the task',
    note: 'TaskCreate accepts metadata.' },
  // §2 env
  { id: 'env-child-session', section: 2, stability: 'env', search: ['CLAUDE_CODE_CHILD_SESSION:"1",CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_PID:String(process.pid)'],
    note: 'Hooks, Bash, statusLine, subagentStatusLine and monitors get CLAUDE_PID and CLAUDE_CODE_SESSION_ID (cc.ENV, sessionId, claudePid).' },
  { id: 'env-mcp-session', section: 2, stability: 'env', search: 'CLAUDE_CODE_SESSION_ID:K(),CLAUDECODE:"1",',
    note: 'MCP stdio servers get CLAUDE_CODE_SESSION_ID (fixed at spawn) but not CLAUDE_PID.' },
  { id: 'env-plugin-mcp', section: 2, stability: 'env', search: 'CLAUDE_PLUGIN_ROOT:n.path,CLAUDE_PLUGIN_DATA:GEe(n.source),',
    note: 'Plugin MCP servers get CLAUDE_PLUGIN_ROOT/DATA in env.' },
  { id: 'env-clear-session-id', section: 2, stability: 'incidental', search: 'conversation_reset",newConversationId',
    note: '/clear updates process.env.CLAUDE_CODE_SESSION_ID; running monitors/MCP servers keep the old id.' },
  { id: 'env-nested-strip', section: 2, stability: 'incidental', search: 'delete e.CLAUDECODE,delete e.CLAUDE_CODE_SESSION_ID',
    note: 'A nested claude drops CLAUDE_CODE_SESSION_ID from its env.' },
  { id: 'hook-input-common', section: 2, stability: 'API', search: 'Subagent identifier. Present only when the hook fires from within a subagent',
    note: 'Common hook input: session_id, transcript_path, cwd, prompt_id?, permission_mode?, agent_id?; no pid.' },
  { id: 'pkill-guard', section: 2, stability: 'incidental', search: 'pkill: refusing to run',
    note: 'Bash pkill wrapper refuses patterns matching CLAUDE_PID.' },
  // §3 plan mode
  { id: 'plan-mode-attachment', section: 3, stability: 'incidental', search: 'type:"plan_mode",reminderType:ge,isSubAgent:!!r.agentId,planFilePath:h,planExists',
    note: 'Transcript attachment {type:"plan_mode", planFilePath} (cc.planFile).' },
  { id: 'exitplan-normalize', section: 3, stability: 'API', search: 'The plan content (injected by normalizeToolInput from disk)',
    note: 'Pre/PermissionRequest hooks on ExitPlanMode see tool_input.plan and planFilePath.' },
  { id: 'exitplan-strip', section: 3, stability: 'incidental', search: 'Iit=new Map([[Ou,new Set(["plan","planFilePath"])]])',
    note: 'plan/planFilePath are stripped before the transcript copy (cc.toolUseInput reads the model\'s own input).' },
  { id: 'exitplan-output', section: 3, stability: 'API', search: 'The file path where the plan was saved',
    note: 'PostToolUse(ExitPlanMode) fires only on approval.' },
  { id: 'plan-reject-dialog', section: 3, stability: 'incidental', search: 'if(h==="no"){if(!be&&!we)return null;return{behavior:"deny",feedback:',
    note: '"No, keep planning" returns deny with the typed feedback.' },
  { id: 'plan-reject-user-feedback', section: 3, stability: 'incidental', search: 'toolDenialKind:_e,toolDenialEndsTurn:ve,userFeedback:Ee',
    note: 'The rejected tool_result transcript entry carries top-level userFeedback (cc.planFeedback).' },
  { id: 'plan-reject-text', section: 3, stability: 'incidental', search: ['To tell you how to proceed, the user said:\n', 'Note: The user\'s next message may contain a correction'],
    note: 'Fallback: the note sits between "the user said:\\n" and "\\n\\nNote: The user\'s next message".' },
  { id: 'permission-denied-auto-only', section: 3, stability: 'incidental', search: 'decisionReason.classifier==="auto-mode"',
    note: 'PermissionDenied fires only for auto-mode classifier denials; no hook carries a user rejection note.' },
  { id: 'clear-context-setting', section: 3, stability: 'API', search: 'When true, the plan-approval dialog offers a "clear context" option. Defaults to false.',
    note: 'showClearContextOnPlanAccept: the clear-context approve fires no PostToolUse (cc.clearContextOnPlanAccept).' },
  // §4 task store
  { id: 'task-list-id', section: 4, stability: 'env', search: 'function Mk(){if(a.CLAUDE_CODE_TASK_LIST_ID)return a.CLAUDE_CODE_TASK_LIST_ID',
    note: 'List id: env, team, teammate team, leader team, else session id (changes on /clear).' },
  { id: 'task-path', section: 4, stability: 'incidental', search: 'function aP(e){return e.replace(/[^a-zA-Z0-9_-]/g,"-")}',
    note: '<configDir>/tasks/<sanitized list>/<sanitized id>.json (cc.tasksDir, cc.taskFile).' },
  { id: 'config-dir', section: 4, stability: 'env', search: 'new Set(["CLAUDE_CONFIG_DIR","CLAUDE_INTERNAL_FC_OVERRIDES",',
    note: 'CLAUDE_CONFIG_DIR replaces ~/.claude (cc.configDir).' },
  { id: 'task-store-v5-off', section: 4, stability: 'env', search: 'where the v5 storage backend was built at start-up',
    note: 'The experimental key-value task backend is off by default; files are the store.' },
  { id: 'todo-tools-gate', section: 4, stability: 'env', search: 'a.CLAUDE_CODE_ENABLE_TODO_TOOLS===!0',
    note: 'Newer models need CLAUDE_CODE_ENABLE_TODO_TOOLS for Task tools; bg sessions get them anyway.' },
  // §5 bg jobs
  { id: 'bg-dispatch-line', section: 5, stability: 'incidental', search: 'backgrounded \\xB7 ',
    note: '`claude --bg` stdout line 1 is "backgrounded · <short> · <name>" (cc.JOB_RE).' },
  { id: 'agents-json', section: 5, stability: 'API', search: ['isAgentsJsonInvocation', 'pass its full session id (lowercase, as `claude agents --json` prints it)'],
    note: '`claude agents --json [--all]` prints [{pid?, id, sessionId, status, state, ...}] (cc.jobs).' },
  { id: 'bg-stop', section: 5, stability: 'API', search: 'Stop a background session. Its conversation is kept',
    note: '`claude stop <id>` (cc.stopCmd).' },
  { id: 'bg-logs', section: 5, stability: 'API', search: 'Print the background session\'s recent terminal output.',
    note: '`claude logs <id>` (cc.logsCmd).' },
  { id: 'daemon-env-filter', section: 5, stability: 'env', search: 'let{env:a,reattachEnv:h}=n.data;return{ok:!0,dispatch:{...n.data,env:sRe(a,eYn)',
    note: 'The daemon keeps only allowlisted caller env keys (cc.DAEMON_ENV_ALLOW).' },
  { id: 'daemon-env-allowlist', section: 5, stability: 'env',
    search: [
      '"CLAUDE_CODE_AUTO_MODE_SERVER","CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS","CLAUDE_BG_ISOLATION","CLAUDE_BG_SESSION_PERMISSION_RULES","CLAUDE_BG_MEMORY_TOGGLED_OFF","CLAUDE_CODE_RESUME_SOURCE_ALIVE","CLAUDE_CODE_PLUGIN_DIRS"]',
      '["PATH","CLAUDE_CODE_EXTRA_BODY","CLAUDE_CODE_HOST_CREDS_FILE",',
      '"AWS_REGION","AWS_DEFAULT_REGION","ANTHROPIC_BEDROCK_REGION_PREFIX","AWS_PROFILE","AWS_CONFIG_FILE","AWS_SHARED_CREDENTIALS_FILE","GOOGLE_APPLICATION_CREDENTIALS","GOOGLE_CLOUD_PROJECT","GCLOUD_PROJECT","CLAUDE_SECURESTORAGE_CONFIG_DIR","CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST","CLAUDE_CODE_HOST_GATEWAY_LINEAGE"]',
    ],
    note: 'The literal pieces of eYn = p0e + Ghn + extras that DAEMON_ENV_ALLOW copies.' },
  { id: 'bg-worker-env', section: 5, stability: 'incidental', search: 'CLAUDE_CODE_SESSION_KIND:"bg",CLAUDE_BG_BACKEND:"daemon",FORCE_COLOR',
    note: 'Workers run with the daemon\'s own process.env plus the filtered dispatch env.' },
  { id: 'bg-provider-env', section: 5, stability: 'incidental', search: 'stripped disallowed providerEnv key(s)',
    note: 'Persisted providerEnv is filtered through p0e too.' },
  // §6 monitors
  { id: 'monitor-schema', section: 6, stability: 'API', search: 'Arm trigger. "always" arms at session start and on plugin reload.',
    note: 'Monitor `when`: "always" or "on-skill-invoke:<skill>"; name is the dedupe key.' },
  { id: 'monitor-location', section: 6, stability: 'incidental', search: 'n.experimental?.monitors??n.monitors',
    note: 'manifest.experimental.monitors or manifest.monitors, else monitors/monitors.json.' },
  { id: 'monitor-arm-gates', section: 6, stability: 'incidental', search: 'plugin monitor ${Pe}: failed to arm',
    note: 'Arming is skipped by policy, the tengu_amber_sentinel gate, -p, or untrusted workspace.' },
  { id: 'monitor-not-rearmed', section: 6, stability: 'incidental', search: 'armedMonitorKeys',
    note: 'A monitor that exits is not re-armed until the claude process restarts (in-process /resume and /clear do not re-arm).' },
  // §7 hooks
  { id: 'matcher-rule', section: 7, stability: 'API', search: ['Invalid regex pattern in hook matcher', '/^[a-zA-Z0-9_|, -]+$/:/^[a-zA-Z0-9_|]+$/'],
    note: 'Exact-name list vs unanchored regex (cc.matcherIsExact, cc.matcherMatches).' },
  { id: 'hook-if', section: 7, stability: 'API', search: 'Permission rule syntax to filter when this hook runs (e.g., "Bash(git *)")',
    note: '`if` uses permission-rule syntax; Task tools can only be filtered by bare name.' },
  { id: 'hook-async', section: 7, stability: 'API', search: 'If true, hook runs in background and wakes the model on exit code 2',
    note: 'Per-hook async/asyncRewake fields.' },
  { id: 'hook-timeout-default', section: 7, stability: 'API', search: 'var Ua=600000,Ghe=30000',
    note: 'Default hook timeout 600000 ms (cc.HOOK_TIMEOUT_DEFAULT_MS).' },
  { id: 'session-end-budget', section: 7, stability: 'env', search: ['function Zde(){let e=a.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS', 'jeo=1500,Hho=60000'],
    note: 'SessionEnd budget: env override, else max hook timeout clamped to [1500, 60000] ms (cc.sessionEndBudgetMs).' },
  // §8 cross-session
  { id: 'peer-envelope', section: 8, stability: 'incidental', search: ['from-session="', 'hop-chain="', '(?: from-name="([^"<>\\n\\r]+)")?(?: from-mode="('],
    note: '<cross-session-message from from-session hop-chain from-name from-mode from-plugin> in that order (cc.parseEnvelope).' },
  { id: 'peer-held-prefix', section: 8, stability: 'incidental', search: 'Another Claude session sent a message',
    note: 'Held/mid-turn peer deliveries start with this prefix (cc.isPeerText).' },
  { id: 'peer-origin', section: 8, stability: 'incidental', search: 'kind:R("peer"),from:o(),fromMode:z(["bypass","prompting"])',
    note: 'Transcript user entries from peers carry origin.kind "peer" (cc.entryIsPeer).' },
  { id: 'ups-source', section: 8, stability: 'API', search: '`system` = other machine-injected turns (peer/channel messages',
    note: 'UserPromptSubmit source "system" for peers, channels, task notifications (cc.isPeerPrompt).' },
  { id: 'cross-session-inbound', section: 8, stability: 'API', search: 'Inbound cross-session peer messages (SendMessage from your other sessions)',
    note: 'crossSessionInbound accept|hold|refuse; the orch sets accept.' },
  { id: 'harbor-kite-gate', section: 8, stability: 'env', search: 'function Os(){let e=a.CLAUDE_CODE_HARBOR_KITE',
    note: 'Cross-session messaging gate (default on).' },
  { id: 'task-notification-prompt', section: 8, stability: 'incidental', search: '<task-notification>',
    note: 'Monitor/background notices arrive as prompts starting <task-notification> (cc.isTaskNotification).' },
  { id: 'pasted-content', section: 8, stability: 'incidental', search: ['<pasted_content id="', '</pasted_content id="'],
    note: 'Long pastes are wrapped in <pasted_content id="N"> (cc.PASTED_RE).' },
  // §9 plugin settings
  { id: 'plugin-settings-allowlist', section: 9, stability: 'API', search: 'var Wpe=["agent","subagentStatusLine"]',
    note: 'Plugin settings.json keeps only agent and subagentStatusLine.' },
  { id: 'subagent-statusline-precedence', section: 9, stability: 'incidental', search: 'let s=e.store.pluginBase,r={};if(s)r=eF(r,s,sz);',
    note: 'Any user/project/local/flag subagentStatusLine overrides the plugin\'s.' },
  { id: 'plugin-setting-override-log', section: 9, stability: 'incidental', search: 'overrides setting "${s}" (previously set by another plugin)',
    note: 'Last plugin loaded wins a shared setting.' },
  { id: 'subagent-statusline-raw', section: 9, stability: 'incidental', search: 'Skipping subagentStatusLine execution - workspace trust not accepted',
    note: 'subagentStatusLine command gets no ${CLAUDE_PLUGIN_ROOT} substitution nor PLUGIN_ROOT/DATA env.' },
  // §10 events
  { id: 'hook-events', section: 10, stability: 'API', search: '"TaskCreated","TaskCompleted","Elicitation"',
    note: 'The hook event list; no plan-approved/rejected event.' },
  { id: 'hooks-modules', section: 10, stability: 'env', search: ['hooks modules are not turned on for installed plugins', '"ui.focus","agent.offer","agent.spawn"'],
    note: 'Early-access function hooks; not used yet.' },
]);

module.exports = {
  ENV, sessionId, claudePid, taskListId,
  configDir, sanitizeId, tasksDir, taskFile,
  userSettingsFiles, clearContextOnPlanAccept,
  readLines, readEntries, parseLines, planFile, planFeedback, toolUseInput, contentText, SAID, NOTE,
  PEER_ENVELOPE, PEER_PREFIX, isPeerText, isPeerPrompt, entryIsPeer, ENVELOPE_RE, parseEnvelope,
  isTaskNotification, PASTED_RE, unwrapPasted,
  JOB_RE, parseDispatch, agentsCmd, stopCmd, logsCmd, parseAgentsJson, jobs,
  DAEMON_ENV_ALLOW, daemonEnv,
  matcherIsExact, matcherMatches,
  HOOK_TIMEOUT_DEFAULT_MS, SESSION_END_DEFAULT_MS, SESSION_END_MAX_MS, sessionEndBudgetMs,
  CONTRACT,
};
