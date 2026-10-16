/**
 * plugin/sub-human/mod/core/shim.ts: how a classic event reaches an unchanged node hook from the module, as pure
 * functions. The `$.process.run` call itself sits in each registering file (a module that passes `$` to an
 * imported function does not load: cc CONTRACT module-dollar-local). In: the classic event's payload and
 * $.process.run's {exitCode, stdout, stderr}. Out: toClassic's {result, systemMessage?, subHuman?}; toPre and
 * toPermission for classic.PreToolUse and classic.PermissionRequest, whose answers have their own shape; mergePre and
 * mergePermission put ours above what the hooks beneath answered (next(e) always runs: cc CONTRACT classic-chain-order).
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
  PostToolUseFailure: ['additionalContext'],
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
  try { const o: unknown = JSON.parse(s); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch { /* lines */ }
  for (const line of s.split('\n').reverse()) {
    try { const o: unknown = JSON.parse(line); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch { /* next */ }
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

/** Every stdout line that parses as a JSON object, in order. */
function allJson(stdout: unknown): HookJson[] {
  const out: HookJson[] = [];
  for (const line of String(stdout || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { const o: unknown = JSON.parse(t); if (o && typeof o === 'object' && !Array.isArray(o)) out.push(o); } catch { /* not JSON */ }
  }
  return out;
}

/** A classic.PreToolUse answer: one decision (or none), the arguments rewritten, context for the model. */
export type PreResult = ({ allow: true } | { ask: string } | { deny: string } | Record<never, never>) & { updatedInput?: Record<string, unknown>; additionalContext?: string[] };

/**
 * A PreToolUse command hook's output as a classic.PreToolUse answer: exit 2 -> deny (stderr); every JSON line's
 * hookSpecificOutput read in order (a deny wins over an ask, an ask over an allow; contexts join; the last
 * updatedInput stands). allowReason: an allow's permissionDecisionReason, which a command hook's allow showed the
 * person and an answer cannot carry (the caller logs it). systemMessage and subHuman beside, as toClassic.
 */
export function toPre(run: RunOutput = {}): { result: PreResult; allowReason?: string; systemMessage?: string; subHuman?: SubHumanReport } {
  const code = Number(run.exitCode);
  if (code === 2) return { result: { deny: String(run.stderr || '').trim() || 'denied by sub-human' } };
  if (code !== 0) return { result: {} };
  let decision: 'allow' | 'ask' | 'deny' | null = null;
  let reason = '';
  let allowReason: string | undefined;
  let updatedInput: Record<string, unknown> | undefined;
  const ctx: string[] = [];
  const out: { systemMessage?: string; subHuman?: SubHumanReport } = {};
  const rank = { allow: 1, ask: 2, deny: 3 } as const;
  for (const o of allJson(run.stdout)) {
    const h = (o.hookSpecificOutput && typeof o.hookSpecificOutput === 'object' ? o.hookSpecificOutput : {}) as Record<string, unknown>;
    const d = h.permissionDecision;
    const why = typeof h.permissionDecisionReason === 'string' ? h.permissionDecisionReason : '';
    if (d === 'allow' || d === 'ask' || d === 'deny') {
      if (d === 'allow' && why) allowReason = why;
      if (!decision || rank[d] > rank[decision]) { decision = d; reason = why; }
    }
    if (h.updatedInput && typeof h.updatedInput === 'object' && !Array.isArray(h.updatedInput)) updatedInput = h.updatedInput as Record<string, unknown>;
    if (typeof h.additionalContext === 'string' && h.additionalContext) ctx.push(h.additionalContext);
    if (typeof o.systemMessage === 'string' && o.systemMessage) out.systemMessage = o.systemMessage;
    if (o.subHuman && typeof o.subHuman === 'object' && !Array.isArray(o.subHuman)) out.subHuman = o.subHuman;
  }
  const extra = { ...(updatedInput ? { updatedInput } : {}), ...(ctx.length ? { additionalContext: ctx } : {}) };
  const result: PreResult = decision === 'deny' ? { deny: reason || 'denied by sub-human', ...extra }
    : decision === 'ask' ? { ask: reason || 'sub-human', ...extra }
      : decision === 'allow' ? { allow: true, ...extra } : extra;
  return { result, ...(decision === 'allow' && allowReason ? { allowReason } : {}), ...out };
}

/**
 * Ours (the shim's) with theirs (every hook beneath, which ran: next(e) is always called, cc CONTRACT
 * classic-chain-order): a deny from either wins (ours first), then an ask, then an allow; our updatedInput stands over
 * theirs; contexts join, ours first.
 */
export function mergePre(ours: PreResult | null = {}, theirs: PreResult | null | undefined = {}): PreResult {
  const a = (ours || {}) as { allow?: true; ask?: string; deny?: string; updatedInput?: Record<string, unknown>; additionalContext?: string[] };
  const b = (theirs || {}) as typeof a;
  const updatedInput = a.updatedInput ?? b.updatedInput;
  const ctx = [...(a.additionalContext || []), ...(b.additionalContext || [])];
  const extra = { ...(updatedInput ? { updatedInput } : {}), ...(ctx.length ? { additionalContext: ctx } : {}) };
  const deny = a.deny ?? b.deny;
  if (deny) return { deny, ...extra };
  const ask = a.ask ?? b.ask;
  if (ask) return { ask, ...extra };
  if (a.allow || b.allow) return { allow: true, ...extra };
  return extra;
}

/** A PermissionRequest decision, as the command hook's hookSpecificOutput.decision. */
export type PermissionAnswer = { decision?: Record<string, unknown> & { behavior: 'allow' | 'deny' } };

/** A PermissionRequest command hook's output as classic.PermissionRequest's answer: its last decision, if any. */
export function toPermission(run: RunOutput = {}): { result: PermissionAnswer; subHuman?: SubHumanReport } {
  if (Number(run.exitCode) !== 0) return { result: {} };
  let decision: PermissionAnswer['decision'];
  let subHuman: SubHumanReport | undefined;
  for (const o of allJson(run.stdout)) {
    const h = (o.hookSpecificOutput && typeof o.hookSpecificOutput === 'object' ? o.hookSpecificOutput : {}) as Record<string, unknown>;
    const d = h.decision as { behavior?: unknown } | undefined;
    if (d && typeof d === 'object' && (d.behavior === 'allow' || d.behavior === 'deny')) decision = d as PermissionAnswer['decision'];
    if (o.subHuman && typeof o.subHuman === 'object' && !Array.isArray(o.subHuman)) subHuman = o.subHuman;
  }
  return { result: decision ? { decision } : {}, ...(subHuman ? { subHuman } : {}) };
}

/** Ours with theirs: a deny from either wins, then our decision, then theirs. */
export function mergePermission(ours: PermissionAnswer | null = {}, theirs: PermissionAnswer | null | undefined = {}): PermissionAnswer {
  const a = (ours || {}).decision, b = (theirs || {}).decision;
  if (b && b.behavior === 'deny' && !(a && a.behavior === 'deny')) return { decision: b };
  return a ? { decision: a } : b ? { decision: b } : {};
}
