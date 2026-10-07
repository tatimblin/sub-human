/**
 * plugin/sub-human/mod/core/shim.mjs: how a classic event reaches an unchanged node hook from the module, as pure
 * functions. The `$.process.run` call itself sits in each registering file (a module that passes `$` to an
 * imported function does not load: cc CONTRACT module-dollar-local).
 *
 *   shimEnv(e, root) -> env       the child's env: CLAUDE_PLUGIN_ROOT, the payload's session id, and an empty
 *                                 CLAUDE_PID (a $.process.run child inherits whatever claude itself inherited:
 *                                 cc CONTRACT process-run-stdin)
 *   shimArgv(root, script) -> argv          ['node', '<root>/hooks/<script>']
 *   SHIM_MODE                                {SUB_HUMAN_SHIM: '1'}: added to the env of a hook that reports to the mod
 *   SHIM_TIMEOUT_MS                          the hooks.json timeout the command hooks had (10 s)
 *   toClassic(event, run) -> {result, systemMessage?}
 *       run is $.process.run's {exitCode, stdout, stderr}. The command hook's output, translated:
 *         exit 2                                     -> block: stderr (the classic "blocking error")
 *         decision:"block" (+ reason)                -> block: reason
 *         continue:false (+ stopReason)              -> preventContinuation + stopReason
 *         hookSpecificOutput.additionalContext       -> additionalContext: [text]
 *         hookSpecificOutput.sessionTitle / suppressOriginalPrompt -> the same fields
 *         plain stdout (not JSON) on an event that reads context    -> additionalContext: [stdout]
 *         systemMessage                              -> systemMessage beside the result (ClassicResult has no
 *                                                       such field; the caller shows it with $.ui.log)
 *         subHuman (a hook run with SUB_HUMAN_SHIM=1)  -> subHuman beside the result: what the hook tells the
 *                                                       mod, e.g. consent's {reviewOpen}
 *       Only the fields the event reads (CLASSIC_FIELDS, from the d.ts ClassicResultFields) are kept, since a
 *       field the event does not read fails the hook. Any other exit status is a non-blocking error: no result.
 */

export const SHIM_TIMEOUT_MS = 10_000;
export const SHIM_MODE = Object.freeze({ SUB_HUMAN_SHIM: '1' });

/** ClassicResultFields of the 2.1.292 d.ts, for the events a shim can carry. block / preventContinuation /
 * stopReason are every event's. */
const CLASSIC_FIELDS = {
  UserPromptSubmit: ['additionalContext', 'sessionTitle', 'suppressOriginalPrompt'],
  UserPromptExpansion: ['additionalContext', 'suppressOriginalPrompt'],
  SessionStart: ['additionalContext', 'sessionTitle'],
  PostToolUse: ['additionalContext'],
  Stop: ['additionalContext'],
  SubagentStop: ['additionalContext'],
  TaskCompleted: [],
};
const COMMON = ['block', 'preventContinuation', 'stopReason'];

export const shimArgv = (root, script) => ['node', `${root}/hooks/${script}`];

export function shimEnv(e, root) {
  const env = { CLAUDE_PLUGIN_ROOT: String(root || ''), CLAUDE_PID: '' };
  if (e && typeof e.session_id === 'string') env.CLAUDE_CODE_SESSION_ID = e.session_id;
  return env;
}

/** The last line of stdout that parses as a JSON object, or undefined; null when stdout is blank. */
function parseOut(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return null;
  try { const o = JSON.parse(s); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch { /* lines */ }
  for (const line of s.split('\n').reverse()) {
    try { const o = JSON.parse(line); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch { /* next */ }
  }
  return undefined;
}

export function toClassic(event, run = {}) {
  const fields = new Set([...COMMON, ...(CLASSIC_FIELDS[event] || [])]);
  const keep = r => Object.fromEntries(Object.entries(r).filter(([k, v]) => fields.has(k) && v !== undefined));
  const code = Number(run.exitCode);
  if (code === 2) return { result: keep({ block: String(run.stderr || '').trim() || 'blocked by sub-human' }) };
  if (code !== 0) return { result: {} };
  const o = parseOut(run.stdout);
  if (o === null) return { result: {} };
  if (o === undefined) return { result: keep({ additionalContext: [String(run.stdout).trim()] }) };
  const r = {};
  const hso = o.hookSpecificOutput && typeof o.hookSpecificOutput === 'object' ? o.hookSpecificOutput : {};
  if (o.decision === 'block') r.block = typeof o.reason === 'string' && o.reason ? o.reason : 'blocked by sub-human';
  if (o.continue === false) {
    r.preventContinuation = true;
    if (typeof o.stopReason === 'string') r.stopReason = o.stopReason;
  }
  if (typeof hso.additionalContext === 'string' && hso.additionalContext) r.additionalContext = [hso.additionalContext];
  const title = typeof hso.sessionTitle === 'string' ? hso.sessionTitle : typeof o.sessionTitle === 'string' ? o.sessionTitle : undefined;
  if (title) r.sessionTitle = title;
  if (hso.suppressOriginalPrompt === true) r.suppressOriginalPrompt = true;
  const out = { result: keep(r) };
  if (typeof o.systemMessage === 'string' && o.systemMessage) out.systemMessage = o.systemMessage;
  if (o.subHuman && typeof o.subHuman === 'object' && !Array.isArray(o.subHuman)) out.subHuman = o.subHuman;
  return out;
}
