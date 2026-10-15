/**
 * plugin/sub-human/mod/core/shim.ts: how a classic event reaches an unchanged node hook from the module, as pure
 * functions. The `$.process.run` call itself sits in each registering file (a module that passes `$` to an
 * imported function does not load: cc CONTRACT module-dollar-local). In: the classic event's payload and
 * $.process.run's {exitCode, stdout, stderr}. Out: toClassic's {result, systemMessage?, subHuman?}.
 * Failure: an exit other than 0 or 2 is a non-blocking error, so no result.
 */
import type { HookJson, HookJsonSpecific, RunOutput, ShimResult, SubHumanReport } from './types.ts';

/** The hooks.json timeout the command hooks had. */
export const SHIM_TIMEOUT_MS = 10_000;
/** Added to the env of a hook that reports to the mod (its output then carries subHuman). */
export const SHIM_MODE = Object.freeze({ SUB_HUMAN_SHIM: '1' });

/** ClassicResultFields of the 2.1.292 d.ts, for the events a shim can carry. block / preventContinuation /
 * stopReason are every event's. */
const CLASSIC_FIELDS: Record<string, string[] | undefined> = {
  UserPromptSubmit: ['additionalContext', 'sessionTitle', 'suppressOriginalPrompt'],
  UserPromptExpansion: ['additionalContext', 'suppressOriginalPrompt'],
  SessionStart: ['additionalContext', 'sessionTitle'],
  PostToolUse: ['additionalContext'],
  Stop: ['additionalContext'],
  SubagentStop: ['additionalContext'],
  TaskCompleted: [],
};
const COMMON = ['block', 'preventContinuation', 'stopReason'];

/** node on hooks/run.ts <handler> (hooks/handlers/<handler>.ts), the compile cache preloaded as hooks.json does it
 * (hooks/compile-cache.js). */
export const shimArgv = (root: unknown, handler: string) => ['node', '--import', `${root}/hooks/compile-cache.js`, `${root}/hooks/run.ts`, handler];

/** A command hook's systemMessage as a $.ui.log line: without its own "sub-human: " lead, which $.ui.log adds (cc
 * CONTRACT ui-log-notice), so no line reads "sub-human: sub-human: …". */
export const asNotice = (text: unknown) => String(text ?? '').replace(/^sub-human: /gm, '');

/** CLAUDE_PLUGIN_ROOT, the payload's session id, an empty CLAUDE_PID (a $.process.run child inherits whatever claude
 * itself inherited: cc CONTRACT process-run-stdin) and SUB_HUMAN_VIA=module, so hooks/run.ts gives a handler its
 * parent, the claude process, as CLAUDE_PID. */
export function shimEnv(e: { session_id?: unknown } | null | undefined, root: unknown): Record<string, string> {
  const env: Record<string, string> = { CLAUDE_PLUGIN_ROOT: String(root || ''), CLAUDE_PID: '', SUB_HUMAN_VIA: 'module' };
  if (e && typeof e.session_id === 'string') env.CLAUDE_CODE_SESSION_ID = e.session_id;
  return env;
}

/** The last line of stdout that parses as a JSON object, or undefined; null when stdout is blank. */
function parseOut(stdout: unknown): HookJson | null | undefined {
  const s = String(stdout || '').trim();
  if (!s) return null;
  try { const o = JSON.parse(s); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch { /* lines */ }
  for (const line of s.split('\n').reverse()) {
    try { const o = JSON.parse(line); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch { /* next */ }
  }
  return undefined;
}

/**
 * The command hook's output, translated:
 *   exit 2 -> block: stderr (the classic "blocking error"); decision:"block" -> block: reason;
 *   continue:false -> preventContinuation + stopReason; hookSpecificOutput.additionalContext -> [text];
 *   sessionTitle / suppressOriginalPrompt -> the same; plain stdout on an event that reads context -> [stdout];
 *   systemMessage and subHuman -> beside the result (ClassicResult has no such fields; the caller uses them).
 * Only the fields the event reads (CLASSIC_FIELDS) are kept: a field the event does not read fails the hook.
 */
export function toClassic(event: string, run: RunOutput = {}): { result: ShimResult; systemMessage?: string; subHuman?: SubHumanReport } {
  const fields = new Set([...COMMON, ...(CLASSIC_FIELDS[event] || [])]);
  // a subset of r's own fields
  const keep = (r: ShimResult): ShimResult => Object.fromEntries(Object.entries(r).filter(([k, v]) => fields.has(k) && v !== undefined));
  const code = Number(run.exitCode);
  if (code === 2) return { result: keep({ block: String(run.stderr || '').trim() || 'blocked by sub-human' }) };
  if (code !== 0) return { result: {} };
  const o = parseOut(run.stdout);
  if (o === null) return { result: {} };
  if (o === undefined) return { result: keep({ additionalContext: [String(run.stdout).trim()] }) };
  const r: ShimResult = {};
  const hso: HookJsonSpecific = o.hookSpecificOutput && typeof o.hookSpecificOutput === 'object' ? o.hookSpecificOutput : {};
  if (o.decision === 'block') r.block = typeof o.reason === 'string' && o.reason ? o.reason : 'blocked by sub-human';
  if (o.continue === false) {
    r.preventContinuation = true;
    if (typeof o.stopReason === 'string') r.stopReason = o.stopReason;
  }
  if (typeof hso.additionalContext === 'string' && hso.additionalContext) r.additionalContext = [hso.additionalContext];
  const title = typeof hso.sessionTitle === 'string' ? hso.sessionTitle : typeof o.sessionTitle === 'string' ? o.sessionTitle : undefined;
  if (title) r.sessionTitle = title;
  if (hso.suppressOriginalPrompt === true) r.suppressOriginalPrompt = true;
  const out: { result: ShimResult; systemMessage?: string; subHuman?: SubHumanReport } = { result: keep(r) };
  if (typeof o.systemMessage === 'string' && o.systemMessage) out.systemMessage = o.systemMessage;
  if (o.subHuman && typeof o.subHuman === 'object' && !Array.isArray(o.subHuman)) out.subHuman = o.subHuman;
  return out;
}
