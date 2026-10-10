/**
 * plugin/sub-human/mod/core/command.ts: how /sub-human's replies reach the person, as pure functions (mod/deliver.ts
 * registers the command.run hook). Claude Code draws a UserPromptExpansion hook's block as "UserPromptExpansion
 * operation blocked by hook: …" (cc CONTRACT expansion-block-frame), so good news and invites read as failures. The
 * module answers the command itself instead (cc CONTRACT command-run-every-command, command-run-empty-answer): it runs
 * hooks/join.ts through the shim (sub_human_via "command.run" and the session's nonce) and shows its reply:
 *   - typed here: {} (no row, no echo, nothing for the model) and the lines as $.ui.log notices. An output row ({text})
 *     would also be read by the model, which then repeats it on its next turn (seen live: "You've left …" under
 *     "left vole-8126"), and a reply that may hold a PIN must never reach it;
 *   - typed through Remote Control, where no notice shows: {text}, the command's own output row (the module answers
 *     only prompts that hold no secret there);
 *   - a join that worked: the command expands as before (next), the mechanics block handed to the expansion hook
 *     beneath in place of a second run (takeJoined), and a one-line confirmation as a notice.
 * In: command.run's {command, args, origin}. Out: whether the module answers, the shim's stdin, the reply read, the
 * answer and the notices. Failure: a shim that did not answer (timeout, crash) is one refusal notice pointing to the
 * doctor; the command is not run a second time.
 */
import type { JoinReply, HookJson, HookJsonSpecific, OriginLike, RunOutput, SubHumanReport } from './types.ts';

/** The command as command.run names it (a plugin skill's name, or its bare form). */
export const COMMANDS = Object.freeze(['sub-human:sub-human', 'sub-human']);

/** A copy of hooks/join.ts's rule (test/mod-core-command.test.js asserts they agree): `join`, `invite` and `admit`,
 * and any word of 3-10 digits, may carry a PIN. */
const SECRET_VERBS = ['join', 'invite', 'admit'];
const DIGITS = /^[0-9]{3,10}$/;
const words = (args: unknown) => String(args ?? '').trim().split(/\s+/).filter(Boolean);
export const mayHoldSecret = (args: unknown) => { const a = words(args); return SECRET_VERBS.includes(a[0]) || a.some(w => DIGITS.test(w)); };

/**
 * Whether the module answers this run itself. Typed here (composer): yes. Typed through Remote Control (bridge): only
 * a prompt that can hold no secret. Anything else (the SDK, whose prompt Claude Code echoes as a user row whatever the
 * answer; a plugin; a peer) and the room's Claude's own session (roomClaude: SUB_HUMAN_ROOM set; its launch binds
 * through the classic hook, which knows the agent type): no, the classic hook beneath answers, which keeps a typed PIN
 * out of the conversation itself.
 */
export function answersItself(e: { args?: unknown; origin?: OriginLike } | null | undefined, { roomClaude = false, nonce = null }: { roomClaude?: boolean; nonce?: string | null } = {}): boolean {
  if (roomClaude || !nonce || !e || typeof e.args !== 'string') return false;
  const kind = e.origin && e.origin.kind;
  return kind === 'composer' || (kind === 'bridge' && !mayHoldSecret(e.args));
}

/** hooks/join.ts's stdin: the UserPromptExpansion payload Claude Code would give it, marked as the module's. */
export function joinPayload({ sid, cwd, args, nonce }: { sid: unknown; cwd: unknown; args: unknown; nonce: unknown }) {
  return {
    hook_event_name: 'UserPromptExpansion', session_id: sid, cwd, expansion_type: 'slash_command',
    command_name: 'sub-human:sub-human', command_args: String(args ?? ''), command_source: 'plugin',
    sub_human_via: 'command.run', sub_human_nonce: nonce,
  };
}

/** A join's confirmation waits this long, so it follows the command's own row (added after the hook returns). */
export const CONFIRM_AFTER_MS = 150;

/** One notice per line (a newline in one is drawn as U+FFFD, cc CONTRACT ui-log-notice); blank lines dropped. */
export const noticeLines = (text: unknown) => String(text ?? '').split('\n').filter(l => l.trim());

const FAILED = '✗ /sub-human did not finish here. Run /sub-human doctor.';

/** The last stdout line that parses as a JSON object, or null. */
function lastJson(stdout: unknown): HookJson | null {
  for (const line of String(stdout || '').trim().split('\n').reverse()) {
    try { const o = JSON.parse(line); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch { /* next */ }
  }
  return null;
}

/**
 * join.ts's answer: {kind: 'joined', context, lines} (a seat taken: the mechanics block and the confirmation),
 * {kind: 'say', lines, refused, shareable}, or {kind: 'failed', lines} when it did not answer as the module asked
 * (exit other than 0, no subHuman reply).
 */
export function readReply(run: RunOutput | null | undefined): JoinReply {
  if (!run || run.exitCode !== 0) return { kind: 'failed', lines: [FAILED] };
  const o = lastJson(run.stdout);
  const sub = o && o.subHuman && typeof o.subHuman === 'object' ? o.subHuman as SubHumanReport : null;
  const say = sub && typeof sub.say === 'string' ? sub : null;
  if (!o || !say) return { kind: 'failed', lines: [FAILED] };
  const hso: HookJsonSpecific = o.hookSpecificOutput && typeof o.hookSpecificOutput === 'object' ? o.hookSpecificOutput : {};
  if (say.joined === true && typeof hso.additionalContext === 'string' && hso.additionalContext) {
    return { kind: 'joined', context: hso.additionalContext, lines: noticeLines(say.say) };
  }
  return { kind: 'say', lines: noticeLines(say.say), refused: say.refused === true, shareable: say.shareable === true };
}

/**
 * How a reply goes out: {result, logs}. Here: notices only, result {} (no row, no echo, nothing for the model). Through
 * Remote Control: a shareable reply is the command's output row (result {text}); one that is not (none should be: the
 * module answers only prompts that hold no secret there) says where it is instead.
 */
export function answerOf(reply: JoinReply, { bridge = false } = {}): { result: { text?: string }; logs: string[] } {
  if (!bridge) return { result: {}, logs: reply.lines };
  if (reply.kind === 'say' && reply.shareable && reply.lines.length) return { result: { text: reply.lines.join('\n') }, logs: [] };
  return { result: { text: 'the reply is on the terminal of the machine this session runs on.' }, logs: reply.lines };
}
