/**
 * plugin/sub-human/mod/core/copy.ts: the invite's copy card (PLAN-JOIN step 5), as pure functions; mod/deliver.ts and
 * mod/consent.ts make the $ calls. The clipboard is never written without the person's click: it may hold something
 * they need.
 *
 * Where the line is: the host stores only a hash of an invite's SECRET, so the line cannot be rebuilt from its ref
 * later. join.ts hands the module the line once, beside the pinned status (lib/commands/types.ts Pinned line: never
 * the PIN), over the shim's stdout, which only the module reads. The module keeps it in its own memory (copyBook),
 * keyed by the invite's ref, for the invite's life; nothing writes it to disk, a transcript or a log, and the model
 * only ever handles the ref. A module reload forgets it (the card then says the invite is gone).
 *
 *   1. /sub-human invite answered with a line (mod/deliver.ts command.run): the book holds it, and once the command
 *      returned the module submits copyWake(ref) as a wake of its own (mid-turn: appended, as any wake).
 *   2. The model calls AskUserQuestion with the question "copy invite REF" (copyAsked). mod/consent.ts's PreToolUse
 *      answers ask with copyCard() as updatedInput (Copy / Skip), or denies with GONE when the book no longer holds
 *      that invite (used, burnt, cancelled, expired: the tail's `invites` event and the invite's life drop it).
 *   3. PostToolUse: copyOutcome reads the person's answer (mod/core/card.ts answerCard, exact: an edited card counts
 *      as none). Copy: the line goes to the first clipboard tool that takes it (clipboardCommands, copyTo), on stdin,
 *      never in an argument. Skip, AFK, another answer or an edited card copies nothing.
 *
 *   COPY_QUESTION, COPY, SKIP, copyCard()         the card
 *   copyAsked(input) -> {ref} | null              the call is the copy card's ("copy invite REF"; ref null: none named)
 *   copyWake(ref) -> string                       the wake: one line for the person, the rest for the model
 *   copyLine(line) -> string | null               a line the module may hold: one line, no PIN-shaped word in it
 *   copyBook()                                    the module's memory: hold, drop, keepOpen, lineFor, ask, askedRef
 *   clipboardCommands(env) -> {name, argv}[]      pbcopy, clip.exe (WSL), wl-copy (Wayland), xclip (X11), in order
 *   copyTo(run, line, commands) -> 'copied'|'none' each in turn until one exits 0; a missing tool, a failure or a
 *                                                 timeout tries the next
 *   copyOutcome(answer, line) -> {copy} | {say}   what the person's answer does
 *   COPIED, NO_TOOL, GONE, NOT_COPIED             what the person and the model are told (copySaid: the model's)
 */
import { FOR_CLAUDE } from './constants.ts';
import { answerCard, type CardAnswer, type CardResponse, type CardSpec } from './card.ts';

export const COPY_QUESTION = 'Copy the invite line to your clipboard? (the PIN is not copied)';
export const COPY = 'Copy';
export const SKIP = 'Skip';

/** The card as AskUserQuestion's input: one question, Copy or Skip. */
export type CopyCard = { questions: { question: string; header: string; multiSelect: false; options: { label: string; description: string }[] }[] };
export const copyCard = (): CopyCard => ({
  questions: [{
    question: COPY_QUESTION,
    header: 'Invite',
    multiSelect: false,
    options: [
      { label: COPY, description: 'Puts the invite line on your clipboard, in place of what is there now. The PIN is not copied: say it separately.' },
      { label: SKIP, description: 'Copies nothing; the line stays pinned on your status line.' },
    ],
  }],
});
/** The card's question as answerCard reads it. */
export const COPY_SPEC: CardSpec = { question: COPY_QUESTION, options: (copyCard().questions[0]?.options ?? []).map(o => ({ label: o.label, description: o.description })) };

const REF = /^[0-9a-f]{12}$/;
/** An AskUserQuestion call that is the copy card's: it says "copy invite REF" (the wake's question) or carries the
 * card's own question (ref null: then the one invite the module holds, if just one). null: not the copy card. */
export function copyAsked(input: unknown): { ref: string | null } | null {
  let text = '';
  try { text = JSON.stringify(input ?? {}); } catch { return null; }
  const m = /copy invite ([0-9a-f]{12})(?![0-9a-f])/i.exec(text);
  if (m && m[1]) return { ref: m[1].toLowerCase() };
  return text.includes(COPY_QUESTION) ? { ref: null } : null;
}

/** The wake after an invite: its one line for the person (drawn as the prompt), the rest for the model. */
export const copyWake = (ref: string): string => [
  `sub-human: your Claude asks whether to copy invite ${ref}'s line to your clipboard (never its PIN)`,
  `${FOR_CLAUDE} sub-human: the person just made an invite (ref ${ref}); its line and PIN are pinned on their status line, which you cannot see. Ask whether to copy the line: call AskUserQuestion with the question "copy invite ${ref}"; the hooks show the card and do the copy, and you never see the line or the PIN. Don't answer for them, ask for the line or the PIN, or post about it.`,
].join('\n');

const PIN_WORD = /^[0-9]{3,10}$/;
/** line, when the module may hold and copy it: one line of at most 2000 characters with no word that could be a PIN
 * (3-10 digits standing alone), so a PIN never reaches the clipboard even if a line ever carried one; else null. */
export function copyLine(line: unknown): string | null {
  if (typeof line !== 'string') return null;
  const l = line.trim();
  if (!l || l.length > 2000 || /[\r\n]/.test(l)) return null;
  return l.split(/\s+/).some(w => PIN_WORD.test(w)) ? null : l;
}

/** The module's memory of the lines it may copy, by invite ref (time passed in), and which card call asked for which. */
export interface CopyBook {
  hold(ref: string, line: string, until: number): void;
  drop(ref: string): void;
  /** The room's open invites (the tail's `invites` event): every other line is dropped. */
  keepOpen(open: readonly string[]): void;
  lineFor(ref: string, now: number): string | null;
  refs(now: number): string[];
  /** The card call toolUseId was shown for ref (PreToolUse), so its PostToolUse knows which line. */
  ask(toolUseId: string, ref: string): void;
  askedRef(toolUseId: string): string | null;
}
export function copyBook(): CopyBook {
  const lines = new Map<string, { line: string; until: number }>();
  const asked = new Map<string, string>();
  return {
    hold(ref, line, until) { if (REF.test(ref)) lines.set(ref, { line, until }); },
    drop(ref) { lines.delete(ref); },
    keepOpen(open) { for (const ref of [...lines.keys()]) if (!open.includes(ref)) lines.delete(ref); },
    lineFor(ref, now) {
      const h = lines.get(ref);
      if (!h) return null;
      if (now >= h.until) { lines.delete(ref); return null; }
      return h.line;
    },
    refs(now) { return [...lines.entries()].filter(([, h]) => now < h.until).map(([r]) => r); },
    ask(toolUseId, ref) { if (toolUseId) { asked.set(toolUseId, ref); if (asked.size > 16) asked.delete(asked.keys().next().value ?? ''); } },
    askedRef(toolUseId) { const r = asked.get(toolUseId) ?? null; asked.delete(toolUseId); return r; },
  };
}

/** One clipboard tool: its name and the argv that runs it with the line on stdin. Through sh, so a tool that is not
 * installed exits 127 (not a rejected start) and one that forks to keep the selection (xclip, wl-copy) does not hold
 * the run open on its output. The line is never in the argv. */
export interface ClipboardCommand { name: string; argv: string[] }
const viaSh = (name: string, cmd: string): ClipboardCommand => ({ name, argv: ['sh', '-c', `command -v ${name} >/dev/null 2>&1 || exit 127; exec ${cmd} >/dev/null 2>&1`] });
/** The clipboard tools to try, in order: pbcopy (macOS); clip.exe first under WSL; wl-copy with a Wayland display,
 * xclip -selection clipboard with an X display. */
export function clipboardCommands(env: { WAYLAND_DISPLAY?: string | undefined; DISPLAY?: string | undefined; WSL_DISTRO_NAME?: string | undefined; WSL_INTEROP?: string | undefined }): ClipboardCommand[] {
  const out: ClipboardCommand[] = [];
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) out.push(viaSh('clip.exe', 'clip.exe'));
  out.push(viaSh('pbcopy', 'pbcopy'));
  if (env.WAYLAND_DISPLAY) out.push(viaSh('wl-copy', 'wl-copy'));
  if (env.DISPLAY) out.push(viaSh('xclip', 'xclip -selection clipboard'));
  return out;
}
/** How long one clipboard tool may take. */
export const CLIPBOARD_TIMEOUT_MS = 3000;

/** A process runner as $.process.run is one (the tests pass a stub). */
export type Runner = (argv: readonly string[], init: { stdin: string; timeoutMs: number }) => Promise<{ exitCode: number }>;
/** The line to the first tool that exits 0; a tool missing (127), failing or timing out (a rejection) tries the next. */
export async function copyTo(run: Runner, line: string, commands: readonly ClipboardCommand[]): Promise<'copied' | 'none'> {
  for (const c of commands) {
    try {
      const r = await run(c.argv, { stdin: line, timeoutMs: CLIPBOARD_TIMEOUT_MS });
      if (r.exitCode === 0) return 'copied';
    } catch { /* the next one */ }
  }
  return 'none';
}

export const COPIED = 'Copied. Say the PIN separately.';
export const NO_TOOL = 'No clipboard tool found; the line is pinned on your status line.';
export const GONE = 'that invite is gone, run /sub-human invite again';
export const NOT_COPIED = 'Nothing copied; the line stays pinned on your status line.';
/** What the model reads after the card: the person's line, and that nothing else is asked of it. */
export const copySaid = (said: string): string => `sub-human: ${said} (The person sees this too. Don't repeat it, ask for the line or the PIN, or post about it; return to what you were doing.)`;

/** What the person's answer on the card does: copy line (Copy, with the line still held), or say a line (gone, or
 * nothing copied). */
export function copyOutcome(response: CardResponse | null | undefined, input: { questions?: unknown } | null | undefined, line: string | null): { copy: string } | { say: string } {
  const got: CardAnswer = answerCard(COPY_SPEC, response, input);
  if (got.kind !== 'answer' || got.label !== COPY) return { say: NOT_COPIED };
  return line ? { copy: line } : { say: GONE };
}
