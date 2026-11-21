/**
 * plugin/sub-human/mod/core/copy.ts: the invite's copy question (PLAN-JOIN step 5; 0.6.1: asked by the module itself,
 * no model turn), as pure functions; mod/deliver.ts makes the $ calls. The clipboard is never written without the
 * person's click: it may hold something they need.
 *
 * Where the line is: the host stores only a hash of an invite's SECRET, so the line cannot be rebuilt from its ref
 * later. join.ts hands the module the line once, beside the pinned status (lib/commands/types.ts Pinned line: never
 * the PIN), over the shim's stdout, which only the module reads. The module keeps it in its own memory (copyBook),
 * keyed by the invite's ref, for the invite's life; nothing writes it to disk, a transcript or a log, and the model
 * never handles it or its ref. A module reload forgets it.
 *
 *   1. An invite answered with a line (a typed /sub-human invite, or the question after a room opened: mod/core/walk.ts),
 *      in a session a person types in: the book holds it, and once the command returned the module opens Claude Code's
 *      own dialog itself ($.ui.ask): "Copy the invite?", Copy / Skip (labels alone). Once the person picked Copy in
 *      this session, a later invite's line is copied with no question (AUTO_COPIED); once they picked Skip, no question
 *      is asked again (copyBook choice). Dismissed (Esc), or text typed: nothing, and the next invite asks again.
 *   2. Copy: the line goes to the first clipboard tool that takes it (clipboardCommands, copyTo), on stdin, never in an
 *      argument. An invite over before the answer (used, burnt, cancelled, expired: the tail's `invites` event and its
 *      life drop it) copies nothing (GONE).
 *
 *   COPY_QUESTION, COPY_HEADER, COPY, SKIP, COPY_OPTIONS, copyChoiceOf(answer)   the question and its answer
 *   INSTALL_LINE, copyLine(line) -> string | null what the module may hold and copy: INSTALL_LINE, a newline, then the
 *                                                 one invite line (no PIN-shaped word in either)
 *   copyBook()                                    the module's memory: hold, drop, keepOpen, lineFor, refs, choose, choice
 *   clipboardCommands(env) -> {name}[]            pbcopy, clip.exe (WSL), wl-copy (Wayland), xclip (X11), in order (scripts/clip.sh runs one)
 *   copyTo(run, line, commands) -> 'copied'|'none' each in turn until one exits 0; a missing tool, a failure or a
 *                                                 timeout tries the next
 *   COPIED, AUTO_COPIED, NO_TOOL, GONE, NOT_COPIED, copyNews   what the person sees, and what only the debug log keeps
 */

export const COPY_QUESTION = 'Copy the invite?';
/** The dialog's header chip: it has no plugin prefix, so the chip names the speaker (12 characters at most). */
export const COPY_HEADER = 'sub-human';
export const COPY = 'Copy';
export const SKIP = 'Skip';
/** The dialog's options, labels alone ($.ui.ask takes no descriptions; the PIN is never copied, so none is needed). */
export const COPY_OPTIONS: readonly string[] = [COPY, SKIP];

/** The person's answer for the rest of the session: Copy copies later invites with no question, Skip asks no more
 * (null: not answered yet, dismissed, or text typed). */
export type CopyChoice = 'copy' | 'skip' | null;
/** What $.ui.ask resolved to (a label, or the text typed under Other; null: dismissed), as a choice: the labels exactly. */
export const copyChoiceOf = (answer: string | null | undefined): CopyChoice => (answer === COPY ? 'copy' : answer === SKIP ? 'skip' : null);

const REF = /^[0-9a-f]{12}$/;
const PIN_WORD = /^[0-9]{3,10}$/;
/** The line copied above an invite line, for someone with no sub-human yet (the PIN is never copied with either). */
export const INSTALL_LINE = 'No sub-human yet? In a terminal: claude plugin marketplace add tatimblin/sub-human && claude plugin install sub-human@sub-human, then restart Claude Code';
/** What the module may hold and copy for line: INSTALL_LINE, a newline, then the line (one line of at most 2000
 * characters with no word that could be a PIN: 3-10 digits standing alone, so a PIN never reaches the clipboard even if
 * a line ever carried one). line may already be that pair; any other newline, or a PIN-shaped word: null. */
export function copyLine(line: unknown): string | null {
  if (typeof line !== 'string') return null;
  const t = line.trim();
  const l = t.startsWith(`${INSTALL_LINE}\n`) ? t.slice(INSTALL_LINE.length + 1).trim() : t;
  if (!l || l.length > 2000 || /[\r\n]/.test(l)) return null;
  return l.split(/\s+/).some(w => PIN_WORD.test(w)) ? null : `${INSTALL_LINE}\n${l}`;
}

/** The module's memory of the lines it may copy, by invite ref (time passed in), and the session's choice. */
export interface CopyBook {
  hold(ref: string, line: string, until: number): void;
  drop(ref: string): void;
  /** The room's open invites (the tail's `invites` event): every other line is dropped. */
  keepOpen(open: readonly string[]): void;
  lineFor(ref: string, now: number): string | null;
  refs(now: number): string[];
  choose(c: Exclude<CopyChoice, null>): void;
  choice(): CopyChoice;
}
export function copyBook(): CopyBook {
  const lines = new Map<string, { line: string; until: number }>();
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
    choose(c) { chosen = c; },
    choice() { return chosen; },
  };
}

/** One clipboard tool, by name: scripts/clip.sh NAME runs it with the line on stdin (127 when it is not installed,
 * its output dropped so a tool that forks to keep the selection does not hold the run open). The call site spells
 * that argv out at $.process.run (mod/deliver.ts), so the directory reads the program run. The line is never in the
 * argv. */
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

/** What a copy that worked says: the debug log's alone (the person picked Copy; nothing to report). */
export const COPIED = 'copied';
/** A later invite in a session whose person picked Copy: copied with no question (the debug log's). */
export const AUTO_COPIED = 'line copied';
export const NO_TOOL = 'No clipboard tool found; the line is pinned on your status line.';
export const GONE = 'that invite is gone, run /sub-human invite again';
/** Skip, or no answer: the debug log's alone. */
export const NOT_COPIED = 'not copied';
/** A copy outcome that is the person's to read (something did not happen they would expect: no tool, the invite
 * gone); the rest are the debug log's. */
export const copyNews = (said: string): boolean => said !== COPIED && said !== AUTO_COPIED && said !== NOT_COPIED;
