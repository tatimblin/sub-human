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
 *      returned the module submits copyWake(ref) as a wake of its own, framed (mid-turn: appended, as any wake). Once
 *      the person picked Copy in this session, a later invite's line is copied with no card (AUTO_COPIED); once they
 *      picked Skip, no card is offered again (copyBook choice).
 *   2. The model calls AskUserQuestion with the question "copy invite REF" (copyAsked). mod/consent.ts's PreToolUse
 *      answers ask with copyCard() as updatedInput (Copy / Skip), or denies with GONE when the book no longer holds
 *      that invite (used, burnt, cancelled, expired: the tail's `invites` event and the invite's life drop it).
 *   3. PostToolUse: copyOutcome reads the person's answer (mod/core/card.ts answerCard, exact: an edited card counts
 *      as none). Copy: the line goes to the first clipboard tool that takes it (clipboardCommands, copyTo), on stdin,
 *      never in an argument. Skip, AFK, another answer or an edited card copies nothing.
 *
 *   COPY_QUESTION, COPY, SKIP, copyCard()         the card
 *   copyAsked(input) -> {ref} | null              the call is the copy card's ("copy invite REF"; ref null: none named)
 *   copyWake(ref) -> string                       the wake: one "(for Claude)" line, the ref only
 *   copyLine(line) -> string | null               a line the module may hold: one line, no PIN-shaped word in it
 *   copyBook()                                    the module's memory: hold, drop, keepOpen, lineFor, ask, askedRef,
 *                                                 choose, choice
 *   clipboardCommands(env) -> {name}[]            pbcopy, clip.exe (WSL), wl-copy (Wayland), xclip (X11), in order (scripts/clip.sh runs one)
 *   copyTo(run, line, commands) -> 'copied'|'none' each in turn until one exits 0; a missing tool, a failure or a
 *                                                 timeout tries the next
 *   copyOutcome(answer, line) -> {copy} | {say}   what the person's answer does, and the session's choice
 *   COPIED, AUTO_COPIED, NO_TOOL, GONE, NOT_COPIED   what the person sees (copySaid: the model's, asking nothing)
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

/**
 * The wake after an invite: one "(for Claude)" line, the ref only. It has no line for the person, so it goes framed
 * as the plugin's own message (core/deliver.ts wakeParts null): never as a prompt the person seems to have typed, and
 * without the room-lines context of a wake.
 */
export const copyWake = (ref: string): string => `${FOR_CLAUDE} sub-human: the person made invite ${ref}. Call AskUserQuestion with the question "copy invite ${ref}" (the hooks show their Copy / Skip card and copy; you never see the line or its PIN), then reply with nothing.`;

const PIN_WORD = /^[0-9]{3,10}$/;
/** line, when the module may hold and copy it: one line of at most 2000 characters with no word that could be a PIN
 * (3-10 digits standing alone), so a PIN never reaches the clipboard even if a line ever carried one; else null. */
export function copyLine(line: unknown): string | null {
  if (typeof line !== 'string') return null;
  const l = line.trim();
  if (!l || l.length > 2000 || /[\r\n]/.test(l)) return null;
  return l.split(/\s+/).some(w => PIN_WORD.test(w)) ? null : l;
}

/** The person's answer on the card, for the rest of the session: Copy copies later invites with no card, Skip asks
 * no more (null: not answered yet). */
export type CopyChoice = 'copy' | 'skip' | null;
/** The module's memory of the lines it may copy, by invite ref (time passed in), which card call asked for which, and
 * the session's choice. */
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
  choose(c: Exclude<CopyChoice, null>): void;
  choice(): CopyChoice;
}
export function copyBook(): CopyBook {
  const lines = new Map<string, { line: string; until: number }>();
  const asked = new Map<string, string>();
  let chosen: CopyChoice = null;
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
    choose(c) { chosen = c; },
    choice() { return chosen; },
  };
}

/** One clipboard tool, by name: scripts/clip.sh NAME runs it with the line on stdin (127 when it is not installed,
 * its output dropped so a tool that forks to keep the selection does not hold the run open). The call sites spell
 * that argv out at $.process.run (mod/consent.ts, mod/deliver.ts), so the directory reads the program run. The line
 * is never in the argv. */
export interface ClipboardCommand { name: 'pbcopy' | 'wl-copy' | 'xclip' | 'clip.exe' }
/** The clipboard tools to try, in order: pbcopy (macOS); clip.exe first under WSL; wl-copy with a Wayland display,
 * xclip -selection clipboard with an X display. */
export function clipboardCommands(env: { WAYLAND_DISPLAY?: string | undefined; DISPLAY?: string | undefined; WSL_DISTRO_NAME?: string | undefined; WSL_INTEROP?: string | undefined }): ClipboardCommand[] {
  const out: ClipboardCommand[] = [];
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) out.push({ name: 'clip.exe' });
  out.push({ name: 'pbcopy' });
  if (env.WAYLAND_DISPLAY) out.push({ name: 'wl-copy' });
  if (env.DISPLAY) out.push({ name: 'xclip' });
  return out;
}
/** How long one clipboard tool may take. */
export const CLIPBOARD_TIMEOUT_MS = 3000;

/** Runs one clipboard tool by name, as the call site's $.process.run of scripts/clip.sh (the tests pass a stub). */
export type Runner = (name: ClipboardCommand['name'], init: { stdin: string; timeoutMs: number }) => Promise<{ exitCode: number }>;
/** The line to the first tool that exits 0; a tool missing (127), failing or timing out (a rejection) tries the next. */
export async function copyTo(run: Runner, line: string, commands: readonly ClipboardCommand[]): Promise<'copied' | 'none'> {
  for (const c of commands) {
    try {
      const r = await run(c.name, { stdin: line, timeoutMs: CLIPBOARD_TIMEOUT_MS });
      if (r.exitCode === 0) return 'copied';
    } catch { /* the next one */ }
  }
  return 'none';
}

export const COPIED = 'copied';
/** A later invite in a session whose person picked Copy: copied with no card. */
export const AUTO_COPIED = 'line copied';
export const NO_TOOL = 'No clipboard tool found; the line is pinned on your status line.';
export const GONE = 'that invite is gone, run /sub-human invite again';
export const NOT_COPIED = 'not copied';
/** What the model reads after the card: that the person saw the outcome, and nothing is asked of it. */
export const copySaid = (said: string): string => `sub-human: the copy card is answered (${said}); the person sees that. Reply with nothing.`;

/** What the person's answer on the card does: copy line (Copy, with the line still held), or say a line (gone, or
 * nothing copied); choice: what the session does with its later invites (Copy or Skip picked on the card as built). */
export function copyOutcome(response: CardResponse | null | undefined, input: { questions?: unknown } | null | undefined, line: string | null): ({ copy: string } | { say: string }) & { choice?: 'copy' | 'skip' } {
  const got: CardAnswer = answerCard(COPY_SPEC, response, input);
  if (got.kind !== 'answer' || (got.label !== COPY && got.label !== SKIP)) return { say: NOT_COPIED };
  if (got.label === SKIP) return { say: NOT_COPIED, choice: 'skip' };
  return line ? { copy: line, choice: 'copy' } : { say: GONE, choice: 'copy' };
}
