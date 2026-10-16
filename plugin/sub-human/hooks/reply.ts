/**
 * plugin/sub-human/hooks/reply.ts: what a hook answers, and how it goes out (hooks/run.ts writes it, once, at the edge).
 * No imports beyond types: a handler that exits early loads nothing else.
 *
 *   render(reply) -> {outputs, exit, stderr}   a handler's Reply (hooks/types.ts) as the stdout lines, exit code and
 *       stderr of a command hook:
 *         say | refused | secret | joined   the /sub-human join's answers. Through the hooks module (reply.module, the
 *             nonce checked): {subHuman: {say, refused, shareable, joined?}} (mod/core/command.ts readReply), plus the
 *             mechanics block as additionalContext for a seat taken. Classic (Claude Code ran the hooks.json entry): a
 *             block whose reason is "sub-human: TEXT" (a secret also suppresses the typed prompt), and for a seat taken
 *             the mechanics block with a systemMessage only when something in it is a warning.
 *         classic   any other hook's own JSON output lines, exit code and stderr, as given.
 *   write(rendered)                 the edge: stdout lines, stderr, process.exitCode
 *   out(obj)                        a classic handler's one output line; collected by capture(), which run.ts and the
 *                                   handlers that merge outputs (prompt, consent) wrap around a handler
 *   capture(fn) -> {outputs, threw, error}   fn's out() lines, also when it threw (threw, and what: error)
 *   pre(decision, reason, extra?), deny(reason), context(event, text, top?)   output helpers
 *   logError(err, where?)           stderr, which Claude Code shows to the person only, never to the model
 */
import type { HookOutput, Reply } from './types.ts';

/** A Reply as a command hook gives it. */
export interface Rendered { outputs: object[]; exit: number; stderr: string }

let sink: HookOutput[] | null = null;

export const out = (obj: HookOutput | null | undefined): void => {
  if (!obj) return;
  if (sink) sink.push(obj); else process.stdout.write(JSON.stringify(obj) + '\n');
};

/** Run fn with out() collecting instead of writing; the lines it gave, also when it threw. */
/** What capture saw: the out() lines, and whether fn threw (error: what it threw, null when it did not). */
export interface Captured<T = void> { outputs: HookOutput[]; value?: T; threw: boolean; error: unknown }

export function capture(fn: () => void): Captured {
  const prev = sink;
  const got: HookOutput[] = [];
  sink = got;
  try { fn(); return { outputs: got, threw: false, error: null }; } catch (error) { return { outputs: got, threw: true, error }; } finally { sink = prev; }
}

/** capture for a handler that may return a promise. */
export async function captureAsync<T>(fn: () => T | Promise<T>): Promise<Captured<T>> {
  const prev = sink;
  const got: HookOutput[] = [];
  sink = got;
  try { const value = await fn(); return { outputs: got, value, threw: false, error: null }; } catch (error) { return { outputs: got, threw: true, error }; } finally { sink = prev; }
}

/** PreToolUse decisions; the reason reaches the model. */
export const pre = (decision: 'allow' | 'deny' | 'ask', reason: string, extra: { updatedInput?: unknown } = {}): void => out({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason, ...extra },
});
export const deny = (reason: string): void => pre('deny', reason);

/** additionalContext for any event that supports it. */
export const context = (event: string, text: string, top: HookOutput = {}): void => out({ ...top, hookSpecificOutput: { hookEventName: event, additionalContext: text } });

/** An error on stderr (Claude Code shows hook stderr to the person only, never to the model). */
export function logError(err: unknown, where = 'hook'): void {
  try { process.stderr.write(`sub-human ${where} error: ${err instanceof Error && err.stack || err}\n`); } catch { /* stderr closed */ }
}

const EXPANSION = 'UserPromptExpansion';

/** A Reply as the stdout lines, exit code and stderr of a command hook (see the header). */
export function render(reply: Reply | null | undefined | void): Rendered {
  if (!reply) return { outputs: [], exit: 0, stderr: '' };
  switch (reply.kind) {
    case 'classic': return { outputs: reply.outputs ?? [], exit: reply.exit ?? 0, stderr: reply.stderr || '' };
    case 'joined': {
      const hso = { hookEventName: EXPANSION, additionalContext: reply.context };
      if (reply.module) return { outputs: [{ hookSpecificOutput: hso, subHuman: { say: reply.say, joined: true, shareable: true } }], exit: 0, stderr: '' };
      return { outputs: [{ ...(reply.warn ? { systemMessage: reply.warn } : {}), hookSpecificOutput: hso }], exit: 0, stderr: '' };
    }
    case 'say': case 'refused': case 'secret': {
      const refused = reply.kind === 'refused' || (reply.kind === 'secret' && reply.refused !== false);
      const secret = reply.kind === 'secret';
      const t = `${refused ? '✗ ' : ''}${reply.text}`;
      if (reply.module) {
        // an invite: its line and PIN go to the module's status line (not a transcript row), the text without them
        const pin = reply.kind === 'secret' && reply.pinned ? reply.pinned : null;
        const say = pin ? `${refused ? '✗ ' : ''}${pin.text}` : t;
        const pinned = pin ? { status: pin.status, ms: pin.ms, ...(pin.short && pin.cut ? { short: pin.short, cut: pin.cut } : {}), ...(pin.ref ? { ref: pin.ref } : {}) } : null;
        return { outputs: [{ subHuman: { say, refused, shareable: !secret, ...(pinned ? { pinned } : {}) } }], exit: 0, stderr: '' };
      }
      return {
        outputs: [{
          decision: 'block', reason: `sub-human: ${t}`,
          ...(secret ? { hookSpecificOutput: { hookEventName: EXPANSION, suppressOriginalPrompt: true } } : {}),
        }],
        exit: 0, stderr: '',
      };
    }
    default: { // mod/core/never.ts assertNever, inline: every hook loads this file, and only it beside its handler
      const none: never = reply;
      throw new Error(`sub-human: unhandled reply: ${JSON.stringify(none)}`);
    }
  }
}

/** The edge: the lines on stdout, stderr, the exit code. */
export function write(r: Rendered): void {
  for (const o of r.outputs) process.stdout.write(JSON.stringify(o) + '\n');
  if (r.stderr) { try { process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : r.stderr + '\n'); } catch { /* closed */ } }
  if (r.exit) process.exitCode = r.exit;
}
