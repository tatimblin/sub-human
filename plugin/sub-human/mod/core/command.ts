/**
 * plugin/sub-human/mod/core/command.ts: how /sub-human's replies reach the person, as pure functions (mod/deliver.ts
 * registers the command.run hook). Claude Code draws a UserPromptExpansion hook's block as "UserPromptExpansion
 * operation blocked by hook: …" (cc CONTRACT expansion-block-frame), so good news and invites read as failures. The
 * module answers the command itself instead (cc CONTRACT command-run-every-command, command-run-empty-answer): it runs
 * hooks/handlers/join.ts through the shim (sub_human_via "command.run" and the session's nonce) and shows its reply:
 *   - typed here: {} (no row, no echo, nothing for the model) and the lines as $.ui.log notices. An output row ({text})
 *     would also be read by the model, which then repeats it on its next turn (seen live: "You've left …" under
 *     "left vole-8126"), and a reply that may hold a PIN must never reach it;
 *   - typed through Remote Control, where no notice shows: {text}, the command's own output row (the module answers
 *     only prompts that hold no secret there);
 *   - a join that worked: the command expands as before (next), the mechanics block handed to the expansion hook
 *     beneath in place of a second run (takeJoined), and a one-line confirmation as a notice.
 * In: command.run's {command, args, origin}. Out: whether the module answers, the shim's stdin, the reply read, the
 * answer and the notices. Failure: a shim that did not answer (timeout, crash) is one refusal notice pointing to the
 * doctor, with how long it ran and the last line it wrote on stderr (failDetail: so the next one can be explained);
 * the command is not run a second time. A reply that says this session's lease did not hold (join.ts: {subHuman:
 * {lease: 'stale'}}, nothing run) is read as 'stale': the module says hello again and runs it once more.
 */
import type { JoinPayload, JoinReply, HookJson, HookJsonSpecific, Loose, OriginLike, PinnedStatus, RunOutput, SubHumanRead } from './types.ts';
import type { PinnedReport } from '../../hooks/types.ts';

/** The command as command.run names it (a plugin skill's name, or its bare form). */
export const COMMANDS: readonly string[] = Object.freeze(['sub-human:sub-human', 'sub-human']);

/** The one rule for a prompt that may carry a secret (lib/commands/index.ts answers it hidden, the module leaves it to
 * the classic hook through Remote Control): `join`, `invite` and `admit`, any word of 3-10 digits (a PIN), and any word
 * shaped like an invite line's SECRET (SECRET_WORD). */
const SECRET_VERBS = ['join', 'invite', 'admit'];
const DIGITS = /^[0-9]{3,10}$/;
/** An invite line's SECRET (lib/remote/invite-secret.ts: 39 characters of Crockford base32, read in either case), with
 * room for a paste that lost or doubled a few: any word of 32-48 letters and digits is taken for one. */
export const SECRET_WORD: RegExp = /^[0-9A-Za-z]{32,48}$/;
const words = (args: unknown) => String(args ?? '').trim().split(/\s+/).filter(Boolean);
const secretShaped = (w: string) => DIGITS.test(w) || SECRET_WORD.test(w);
export const mayHoldSecret = (args: unknown): boolean => { const a = words(args); const [verb = ''] = a; return SECRET_VERBS.includes(verb) || a.some(secretShaped); };
/** A word of the prompt is PIN- or SECRET-shaped: lib/commands/index.ts never hands such a prompt a seat's block. */
export const hasPinWord = (args: unknown): boolean => words(args).some(secretShaped);

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

/** hooks/handlers/join.ts's stdin: the UserPromptExpansion payload Claude Code would give it, marked as the module's. */
export function joinPayload({ sid, cwd, args, nonce }: { sid: unknown; cwd: unknown; args: unknown; nonce: unknown }): JoinPayload {
  return {
    hook_event_name: 'UserPromptExpansion', session_id: sid, cwd, expansion_type: 'slash_command',
    command_name: 'sub-human:sub-human', command_args: String(args ?? ''), command_source: 'plugin',
    sub_human_via: 'command.run', sub_human_nonce: nonce,
  };
}

/** A join's confirmation waits this long, so it follows the command's own row (added after the hook returns). */
export const CONFIRM_AFTER_MS = 150;

/** One notice per line (a newline in one is drawn as U+FFFD, cc CONTRACT ui-log-notice); blank lines dropped. */
export const noticeLines = (text: unknown): string[] => String(text ?? '').split('\n').filter(l => l.trim());

const FAILED = '✗ /sub-human did not finish here. Run /sub-human doctor.';

/** A lease that did not hold even after the module said hello again (mod/deliver.ts runs it twice at most). */
export const STALE = '✗ /sub-human did not finish here (this session\'s hooks-module lease did not hold). Run /sub-human doctor.';

/** How a shim run that did not answer went, for the refusal: its time and stderr's last line (a word that could be a
 * PIN or an invite's SECRET masked: the notice is a transcript row). */
export interface FailInfo { ms?: number | null; stderr?: unknown; exitCode?: unknown; error?: unknown }

/** The last stderr line (or the rejection's message), its "sub-human: " lead dropped, secret-shaped words masked,
 * at most 160 characters; '' when there is none. */
export function lastLine(text: unknown): string {
  const line = String(text ?? '').split('\n').map(l => l.trim()).filter(Boolean).at(-1) || '';
  const parts = line.replace(/^sub-human: /, '').split(/(\s+)/);
  // a number with its unit after it ("10000 ms") is a measure, not a PIN
  const unit = (i: number) => /^(ms|s|bytes|KiB|MiB)\b/.test(parts[i + 2] || '');
  const masked = parts.map((w, i) => (secretShaped(w.replace(/[.,;:)("']+$|^[("']+/g, '')) && !unit(i) ? '…' : w)).join('');
  return masked.length > 160 ? `${masked.slice(0, 159)}…` : masked;
}

/** "after 10.0 s: LINE" (or ": exit N" when stderr said nothing), '' when nothing is known. */
export function failDetail(f: FailInfo | null | undefined): string {
  if (!f) return '';
  const secs = typeof f.ms === 'number' && Number.isFinite(f.ms) && f.ms >= 0 ? `after ${(f.ms / 1000).toFixed(1)} s` : '';
  const err = f.error === undefined ? '' : lastLine(f.error instanceof Error ? f.error.message : f.error);
  const line = lastLine(f.stderr) || err;
  const code = Number(f.exitCode);
  const why = line || (f.exitCode != null && Number.isFinite(code) && code !== 0 ? `exit ${code}` : '');
  return [secs, why].filter(Boolean).join(': ');
}

/** The module's own log of the runs that did not answer, in the sub-human folder (mod/deliver.ts appends to it). */
export const MODULE_LOG = 'module.log';
/** How many lines it keeps. */
export const MODULE_LOG_LINES = 50;

/** One line of it: when, the command's first word only (the rest may hold a PIN), and the refusal's detail. */
export function failLogLine(at: number | null, args: unknown, line: string): string {
  const verb = words(args)[0] || '';
  const said = /^[a-z]+$/.test(verb) ? verb : verb ? 'NAME' : '';
  const when = typeof at === 'number' && Number.isFinite(at) ? new Date(at).toISOString() : '-';
  return `${when} /sub-human${said ? ` ${said}` : ''}: ${line.replace(/^✗ /, '')}`;
}

/** text (the log so far) with line added, only the last MODULE_LOG_LINES kept. */
export function appendCapped(text: unknown, line: string, max: number = MODULE_LOG_LINES): string {
  const lines = String(text ?? '').split('\n').filter(Boolean);
  lines.push(line);
  return lines.slice(-max).join('\n') + '\n';
}

/** The refusal of a run that did not answer: "✗ /sub-human did not finish here (after 10.0 s: LINE). Run /sub-human doctor." */
export const failedLine = (f?: FailInfo | null): string => {
  const d = failDetail(f);
  return d ? `✗ /sub-human did not finish here (${d}). Run /sub-human doctor.` : FAILED;
};

/** The last stdout line that parses as a JSON object, or null. */
function lastJson(stdout: unknown): HookJson | null {
  for (const line of String(stdout || '').trim().split('\n').reverse()) {
    try { const o: unknown = JSON.parse(line); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch { /* next */ }
  }
  return null;
}

/**
 * join.ts's answer: {kind: 'joined', context, lines} (a seat taken: the mechanics block and the confirmation),
 * {kind: 'say', lines, refused, shareable}, {kind: 'stale'} (this session's lease did not hold the nonce: nothing ran),
 * or {kind: 'failed', lines} when it did not answer as the module asked (exit other than 0, a rejected run: error, no
 * subHuman reply), the line saying how long it ran (ms) and what stderr said last.
 */
export function readReply(run: RunOutput | null | undefined, { ms = null, error }: { ms?: number | null; error?: unknown } = {}): JoinReply {
  const failed = (): JoinReply => ({ kind: 'failed', lines: [failedLine({ ms, error, stderr: run && run.stderr, exitCode: run && run.exitCode })] });
  if (!run || run.exitCode !== 0) return failed();
  const o = lastJson(run.stdout);
  const sub: SubHumanRead | null = o && o.subHuman && typeof o.subHuman === 'object' ? o.subHuman : null;
  if (sub && sub.lease === 'stale' && typeof sub.say !== 'string') return { kind: 'stale', lines: [STALE] };
  const say = sub && typeof sub.say === 'string' ? sub : null;
  if (!o || !say) return failed();
  const hso: HookJsonSpecific = o.hookSpecificOutput && typeof o.hookSpecificOutput === 'object' ? o.hookSpecificOutput : {};
  if (say.joined === true && typeof hso.additionalContext === 'string' && hso.additionalContext) {
    return { kind: 'joined', context: hso.additionalContext, lines: noticeLines(say.say) };
  }
  const p: Loose<PinnedReport> | null = say.pinned && typeof say.pinned === 'object' ? say.pinned : null;
  const one = (s: unknown) => (typeof s === 'string' && s ? s.replace(/\n/g, ' ') : null);
  const status = p && one(p.status);
  const short = p && one(p.short);
  const pinned: PinnedStatus | null = p && status ? {
    status, ms: Math.min(Number(p.ms) > 0 ? Number(p.ms) : PINNED_MS, PINNED_MS),
    ...(short && typeof p.cut === 'string' && p.cut ? { short, cut: noticeLines(p.cut) } : {}),
    ...(typeof p.ref === 'string' && /^[0-9a-f]{12}$/.test(p.ref) ? { ref: p.ref } : {}),
  } : null;
  return { kind: 'say', lines: noticeLines(say.say), refused: say.refused === true, shareable: say.shareable === true, ...(pinned ? { pinned } : {}) };
}

/** What Claude Code draws before a plugin's status text ("  ⚠ sub-human: "), in cells, with a cell to spare. */
export const STATUS_LEAD = 17;

/** The status that fits a terminal `columns` wide, and the notices that go with it: the whole line when it fits (or the
 * width is not known), else the short form (PIN and SECRET) with the notices that give the line with SECRET in its
 * place. */
export function pinFor(p: PinnedStatus, lines: string[], columns: unknown): { status: string; lines: string[] } {
  const w = Number(columns);
  if (!p.short || !p.cut || !(w > 0) || STATUS_LEAD + p.status.length <= w) return { status: p.status, lines };
  return { status: p.short, lines: p.cut };
}

/** A command that did not answer (failed, or a lease that would not hold) whose seat is gone once the module looked
 * again: it finished after the wait (a leave the shim gave up on). The notice says so, so no stale seat is shown. */
export function goneAfter(reply: JoinReply, before: { name?: unknown; code?: unknown } | null | undefined, after: { code?: unknown } | null | undefined): string | null {
  if (reply.kind !== 'failed' && reply.kind !== 'stale') return null;
  if (!before || typeof before.code !== 'string' || (after && after.code === before.code)) return null;
  return `this session's seat in ${before.code} is gone: the command finished after the wait · /sub-human joins again`;
}

/** A `/sub-human leave` that went through: the name of the seat it ended (the session is titled with it alone, its
 * address gone with the seat: mod/deliver.ts renames it at once, item 12), else null. A member's seat only. */
export function leftName(args: unknown, reply: JoinReply, seat: { name?: unknown; role?: unknown } | null | undefined, { gone = false }: { gone?: boolean } = {}): string | null {
  const a = words(args);
  const went = reply.kind === 'say' ? !reply.refused : gone; // gone: the seat went though the reply did not come
  if (a.length !== 1 || a[0] !== 'leave' || !went || !seat || seat.role === 'claude') return null;
  return typeof seat.name === 'string' && /^[A-Za-z0-9._-]{1,32}$/.test(seat.name) ? seat.name : null;
}

/** An `/sub-human invite --cancel [REF]` that went through takes the pinned invite off when it named it, or named none
 * (the one open invite, which the reply names). */
export function cancels(args: unknown, reply: JoinReply, ref: string | null): boolean {
  const a = words(args);
  if (!ref || a[0] !== 'invite' || !a.includes('--cancel') || reply.kind !== 'say' || reply.refused) return false;
  const named = a.find(w => /^[0-9a-f]{12}$/.test(w));
  return named ? named === ref : reply.lines.some(l => l.includes(ref));
}

/** The longest a pinned invite stays on the status line (an invite's life: lib/config.ts INVITE_TTL_MS). */
export const PINNED_MS: number = 15 * 60_000;

/**
 * How a reply goes out: {result, logs, status?}. status: an invite's line and PIN, for $.ui.status (Claude Code draws
 * it under the prompt and saves it nowhere; a notice is a transcript row) for status.ms. Here: notices only, result {} (no row, no echo, nothing for the model). Through
 * Remote Control: a shareable reply is the command's output row (result {text}); one that is not (none should be: the
 * module answers only prompts that hold no secret there) says where it is instead.
 */
export function answerOf(reply: JoinReply, { bridge = false, columns }: { bridge?: boolean; columns?: unknown } = {}): { result: { text?: string }; logs: string[]; status?: { status: string; ms: number; ref?: string } } {
  if (reply.kind === 'say' && reply.pinned) {
    const fit = pinFor(reply.pinned, reply.lines, columns);
    const status = { status: { status: fit.status, ms: reply.pinned.ms, ...(reply.pinned.ref ? { ref: reply.pinned.ref } : {}) } };
    if (!bridge) return { result: {}, logs: fit.lines, ...status };
    return { result: { text: 'the reply is on the terminal of the machine this session runs on.' }, logs: fit.lines, ...status };
  }
  if (!bridge) return { result: {}, logs: reply.lines };
  if (reply.kind === 'say' && reply.shareable && reply.lines.length) return { result: { text: reply.lines.join('\n') }, logs: [] };
  return { result: { text: 'the reply is on the terminal of the machine this session runs on.' }, logs: reply.lines };
}
