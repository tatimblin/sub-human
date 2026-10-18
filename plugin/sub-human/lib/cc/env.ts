/**
 * plugin/sub-human/lib/cc/env.ts: what Claude Code tells a child about its session, and where it keeps its files and settings.
 *
 * Every export names the literal string to search the binary for (`@cc`, an entry of lib/cc/contract.json) and how
 * stable the assumption is (`@stability`): API (documented schema, a `.describe()` string, an exported name), env (a
 * named env var or flag), incidental (follows from how the code is written; not named anywhere). Pure functions take
 * `env` (default process.env) so tests need no global state. Imported by the hooks: no JSON, nothing spawned.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Env = NodeJS.ProcessEnv;

/**
 * Env var names. CLAUDE_PID and CLAUDE_CODE_SESSION_ID are set (by M0e) for hooks, Bash, statusLine
 * and subagentStatusLine; MCP stdio servers get the session id but not CLAUDE_PID, and a hooks
 * module's $.process children get neither of their own (CONTRACT process-run-stdin).
 * @cc CLAUDE_CODE_CHILD_SESSION:"1",CLAUDE_CODE_SESSION_ATTENDED
 * @stability env
 */
const ENV: Readonly<{
  PID: "CLAUDE_PID";
  SESSION_ID: "CLAUDE_CODE_SESSION_ID";
  TASK_LIST_ID: "CLAUDE_CODE_TASK_LIST_ID";
  CONFIG_DIR: "CLAUDE_CONFIG_DIR";
}> = Object.freeze({
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
/** How long Claude Code skips a plugin's stdio MCP server after it failed to connect (the cache's default ttl). */
const MCP_FAILURE_TTL_MS = 900_000;
/**
 * The ms left while Claude Code skips the plugin MCP server `name` ("plugin:sub-human:room") after a failed start in
 * any session: <configDir>/mcp-needs-auth-cache.json holds {[name]: {timestamp, id?, ttlMs?}}, and every session
 * started within the ttl gets the server "failed" with "Skipping connection (recent failure cached ...)" (live
 * 2026-10-17, a joiner's room tools were gone for his whole session). null: none recorded, or expired.
 * @cc Skipping connection (recent failure cached; retries automatically in 15 min, or edit the plugin config to retry now)
 * @stability incidental
 */
function mcpFailureLeft(name: string, { env = process.env, now = Date.now() }: { env?: Env; now?: number } = {}): number | null {
  let all: unknown;
  try { all = JSON.parse(fs.readFileSync(path.join(configDir(env), 'mcp-needs-auth-cache.json'), 'utf8')); } catch { return null; }
  const e: unknown = all && typeof all === 'object' ? Reflect.get(all, name) : null;
  const at: unknown = e && typeof e === 'object' ? Reflect.get(e, 'timestamp') : null;
  const ttl: unknown = e && typeof e === 'object' ? Reflect.get(e, 'ttlMs') : null;
  if (typeof at !== 'number') return null;
  const left = at + (typeof ttl === 'number' ? ttl : MCP_FAILURE_TTL_MS) - now;
  return left > 0 ? left : null;
}

/** <configDir>/plans: where Claude Code keeps the plan-mode files (cc.planFile names one). */
const plansDir = (env: Env = process.env): string => `${configDir(env)}/plans`;

/**
 * <tasksDir>/<sanitized id>.json: one native task.
 * @cc return e.replace(/[^a-zA-Z0-9_-]/g,"-")}
 * @stability incidental
 */
const taskFile = (listId: string, id: string | number, env: Env = process.env): string => path.join(tasksDir(listId, env), `${sanitizeId(id)}.json`);

/**
 * <configDir>/projects/<cwd sanitised>: the directory of the transcripts of the sessions started in cwd (every char
 * outside [A-Za-z0-9] becomes '-'; a name past 200 chars is cut and gets a hash, which this does not compute: null).
 * @cc replace(/[^a-zA-Z0-9]/g,"-")
 * @stability incidental
 */
function projectDir(cwd: string | null | undefined, env: Env = process.env): string | null {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  const name = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return name.length <= 200 ? path.join(configDir(env), 'projects', name) : null;
}

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
    let v: unknown;
    try { v = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return false; }
    return !!v && typeof v === 'object' && 'showClearContextOnPlanAccept' in v && v.showClearContextOnPlanAccept === true;
  });
}

// ---------- plan mode ----------

/**
 * The event the hooks module sends consent for a `prompt.attachment` of type plan_mode (mod/consent.ts): its detail
 * carries the session's plan file (planFilePath) as a request is made, the one point that knows it before the model's
 * next call (PostToolUse(EnterPlanMode) does not: no plan_mode attachment and no slug in the transcript yet). A room
 * plan edit is seeded there (lib/consent/edit.ts), and a line appended to the attachment's text.
 * @cc "plan_mode_reentry"
 * @stability API
 */
const PLAN_ATTACHMENT_EVENT = 'PlanAttachment';

/**
 * EnterPlanMode runs in plan mode too (it checks only that the call is the main session's), and so do its PreToolUse
 * and PostToolUse hooks: a sign-off request that reaches a person already in plan mode opens its review at that call
 * like anywhere else (hooks/consent.ts reviewableAtEnter), so the proposal, not the person's own plan, is in the plan
 * file when ExitPlanMode reads it.
 * @cc Only the main session can enter plan mode.
 * @stability incidental
 */
const ENTER_IN_PLAN_MODE: true = true;

/**
 * A PermissionRequest(ExitPlanMode) answer that lets the call through with no dialog and puts the session's mode back
 * (a review's restore, an edit's closing call): allow with updatedPermissions [{type: setMode, mode, destination:
 * session}]. The plan file is emptied first (LEAVE_PLAN_TEXT), so Claude Code draws "Exited plan mode", not "User
 * approved Claude's plan"; the hooks' PostToolUse context says no one approved anything.
 * @cc case"setMode":
 * @stability API
 */
/**
 * What the session plan file holds while leavePlanMode lets ExitPlanMode through: nothing. With no plan in its input
 * the call reads the file as it runs; an empty one draws "Exited plan mode" and tells the model only that plan mode was
 * left, where a plan there (the person's own, put back too early) would be drawn and handed over as approved. The
 * hooks empty the file at PermissionRequest and put the person's plan back at PostToolUse (or the next prompt).
 * @cc User has approved exiting plan mode. You can now proceed.
 * @cc " Exited plan mode"
 * @stability incidental
 */
const LEAVE_PLAN_TEXT: '' = '';

/**
 * A PreToolUse deny whose reason is for the person (Claude Code draws it under the call as its error) and whose
 * additionalContext is for the model: the context still reaches the model with a deny (it is yielded after the
 * decision, not skipped), so the model's mechanics need not be in the red line the person reads.
 * @cc yield{type:"additionalContext"
 * @stability API
 */
function denyWithContext(reason: string, context: string): { hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'deny'; permissionDecisionReason: string; additionalContext: string } } {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason, additionalContext: context } };
}

function leavePlanMode(mode: string | undefined): { hookSpecificOutput: { hookEventName: 'PermissionRequest'; decision: { behavior: 'allow'; updatedInput: Record<string, never>; updatedPermissions: { type: 'setMode'; mode: string | undefined; destination: 'session' }[] } } } {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: {},
    updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] } } };
}

// ---------- the global config ----------

/** The global config file Claude Code keeps its cached feature switches in: $CLAUDE_CONFIG_DIR/.claude.json, else
 * ~/.claude.json. */
const globalConfigFile = (env: Env = process.env): string => {
  const dir = env[ENV.CONFIG_DIR];
  return dir ? path.join(dir, '.claude.json') : path.join(env.HOME || os.homedir(), '.claude.json');
};

/**
 * The installed plugins' hooks modules switch as Claude Code last cached it (cachedGrowthBookFeatures
 * .tengu_plugin_hooks_modules in the global config; CONTRACT hooks-modules, modules-switch-cache): true, false, or
 * undefined when unknown (no file, no entry: the default, on). Read only.
 */
function modulesSwitch(env: Env = process.env): boolean | undefined {
  let j: unknown;
  try { j = JSON.parse(fs.readFileSync(globalConfigFile(env), 'utf8')); } catch { return undefined; }
  const at = (o: unknown, k: string): unknown => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined);
  const v = at(at(j, 'cachedGrowthBookFeatures'), 'tengu_plugin_hooks_modules');
  return typeof v === 'boolean' ? v : undefined;
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

export {
  ENV, sessionId, claudePid, taskListId, configDir, mcpFailureLeft, sanitizeId, tasksDir, plansDir, taskFile, projectDir, userSettingsFiles,
  clearContextOnPlanAccept, globalConfigFile, modulesSwitch, matcherIsExact, matcherMatches, PLAN_ATTACHMENT_EVENT, ENTER_IN_PLAN_MODE, leavePlanMode, LEAVE_PLAN_TEXT, denyWithContext,
};
