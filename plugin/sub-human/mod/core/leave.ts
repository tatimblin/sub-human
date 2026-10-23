/**
 * plugin/sub-human/mod/core/leave.ts: the card after a leave (docs/next/PLAN-LEAVE-CARD.md), as pure functions;
 * mod/deliver.ts and mod/consent.ts make the $ calls. Built as the invite's copy card is (mod/core/copy.ts): a hook
 * cannot open a dialog, so a wake asks the model for AskUserQuestion and the hooks put this card in its place.
 *
 *   1. /sub-human leave went through in a session a person types in (mod/deliver.ts command.run, leftName): once per
 *      session, unless SUB_HUMAN_LEAVE_CARD=0 or the session took a seat again before it fires, the module submits
 *      leaveWake(code), framed (it has no line for the person).
 *   2. The model calls AskUserQuestion with "left room CODE" (leaveAsked). mod/consent.ts's PreToolUse answers ask with
 *      leaveCard(code) as updatedInput, or denies (NOTHING_LEFT) when no leave is waiting for its card.
 *   3. PostToolUse: leaveOutcome reads the answer (mod/core/card.ts answerCard, exact). Close, AFK or an edited card:
 *      nothing. Star on GitHub: scripts/star.sh (gh, when logged in), else the repo page opened (scripts/open.sh), else
 *      its URL in a notice. Write feedback, or text typed on the card: GitHub's new-issue form, filled in
 *      (issueUrl), opened or shown the same way; the person reads it and presses Submit there. Nothing is posted for them.
 * What a URL carries: the person's own text and the two versions. Never a room code, a name, a line of the room.
 *
 *   LEAVE_HEADER, CLOSE, STAR, FEEDBACK, leaveQuestion(code), leaveCard(code), leaveSpec(code)   the card
 *   leaveAsked(input, response?) -> {code} | null    the call is the leave card's
 *   leaveWake(code) -> string                        the wake: one "(for Claude)" line
 *   leaveBook()                                      the module's memory: the code waiting for its card, shown once
 *   leaveOutcome(response, input, code) -> LeaveOutcome
 *   REPO, REPO_URL, issueUrl({text, versions})        where Star and Write feedback go
 *   openCommands(env) -> OpenCommand[]               the browser openers to try, in order (scripts/open.sh runs one)
 *   STARRED, starOpened, starShown, issueOpened, issueShown, leaveSaid   what the person and the model see
 */
import { FOR_CLAUDE } from './constants.ts';
import { answerCard, type CardResponse, type CardSpec } from './card.ts';

export const REPO = 'tatimblin/sub-human';
export const REPO_URL: string = `https://github.com/${REPO}`;

export const LEAVE_HEADER = 'Left room';
export const CLOSE = 'Close';
export const STAR = 'Star on GitHub';
export const FEEDBACK = 'Write feedback';

export const leaveQuestion = (code: string): string => `You left room ${code}. Thanks for trying sub-human!`;

/** The card as AskUserQuestion's input: one question, Close / Star on GitHub / Write feedback. */
export type LeaveCard = { questions: { question: string; header: string; multiSelect: false; options: { label: string; description: string }[] }[] };
export const leaveCard = (code: string): LeaveCard => ({
  questions: [{
    question: leaveQuestion(code),
    header: LEAVE_HEADER,
    multiSelect: false,
    options: [
      { label: CLOSE, description: 'Nothing else.' },
      { label: STAR, description: `Stars ${REPO} (with gh when you are logged in; else opens the page).` },
      { label: FEEDBACK, description: 'Opens a feedback issue on GitHub, filled in with anything you type here. You check it and press Submit.' },
    ],
  }],
});
/** The card's question as answerCard reads it. */
export const leaveSpec = (code: string): CardSpec => ({ question: leaveQuestion(code), options: (leaveCard(code).questions[0]?.options ?? []).map(o => ({ label: o.label, description: o.description })) });

/** The wake's question, whole ("left room CODE"), and the card's own question, whole. */
const ASKED = /^left room ([a-z]+-\d{4})$/i;
const SHOWN = /^You left room ([a-z]+-\d{4})\. Thanks for trying sub-human!$/;
const field = (v: unknown, key: string): unknown => (v && typeof v === 'object' && !Array.isArray(v) ? Object.getOwnPropertyDescriptor(v, key)?.value : undefined);
const questionsOf = (v: unknown): string[] => {
  const qs = field(v, 'questions');
  return Array.isArray(qs) ? qs.map((q: unknown) => field(q, 'question')).filter((q): q is string => typeof q === 'string') : [];
};
/**
 * An AskUserQuestion call (or its result) that is the leave card's: one of its questions (input's or the result's
 * shown questions, never the answers or notes) is exactly the wake's "left room CODE" or the card's own question.
 * null: not the leave card, so any other card (consent's, a join request's, the model's own) goes on as before.
 */
export function leaveAsked(input: unknown, response?: unknown): { code: string } | null {
  for (const q of [...questionsOf(input), ...questionsOf(response)]) {
    const m = ASKED.exec(q.trim()) ?? SHOWN.exec(q);
    if (m && m[1]) return { code: m[1].toLowerCase() };
  }
  return null;
}

/** The wake after a leave: one "(for Claude)" line, framed as the plugin's own message (core/deliver.ts wakeParts null). */
export const leaveWake = (code: string): string => `${FOR_CLAUDE} sub-human: the person left room ${code}. Call AskUserQuestion with the question "left room ${code}" (the hooks show their card and act on the answer), then reply with nothing.`;

/** The module's memory: the code whose leave waits for its card (the only one the card is shown for), and whether
 * this session was offered one already (once per session). */
export interface LeaveBook {
  /** A leave went through: true when its card should be offered (none offered yet this session). */
  left(code: string): boolean;
  /** The code waiting for its card, if it is code (or, code null, whichever waits). */
  waiting(code: string | null): string | null;
  /** The card for the waiting code was answered (or will not be shown). */
  done(): void;
}
export function leaveBook(): LeaveBook {
  let offered = false;
  let pending: string | null = null;
  return {
    left(code) { if (offered) return false; offered = true; pending = code; return true; },
    waiting(code) { return pending && (code === null || code === pending) ? pending : null; },
    done() { pending = null; },
  };
}

/** What the person's answer does: nothing, star, or feedback (text: what they typed on the card, '' for none). */
export type LeaveOutcome = { kind: 'close' } | { kind: 'star' } | { kind: 'feedback'; text: string };
export function leaveOutcome(response: CardResponse | null | undefined, input: { questions?: unknown } | null | undefined, code: string): LeaveOutcome {
  const got = answerCard(leaveSpec(code), response, input);
  if (got.kind === 'other') return { kind: 'feedback', text: got.label.trim() };
  if (got.kind !== 'answer') return { kind: 'close' };
  if (got.label === STAR) return { kind: 'star' };
  if (got.label === FEEDBACK) return { kind: 'feedback', text: (got.notes ?? '').trim() };
  return { kind: 'close' };
}

/** The most of the person's text a URL carries (GitHub refuses a new-issue URL past about 8 KB, once encoded). */
export const FEEDBACK_MAX = 2000;
const TITLE_MAX = 60;
/**
 * GitHub's new-issue form for .github/ISSUE_TEMPLATE/feedback.yml, its fields filled in by id: feedback (the person's
 * text, cut at FEEDBACK_MAX), versions; the title from the text's first line. Only what is passed in goes in.
 */
export function issueUrl({ text, versions }: { text: string; versions: string }): string {
  const body = text.length > FEEDBACK_MAX ? `${text.slice(0, FEEDBACK_MAX)}…` : text;
  const first = (body.split('\n')[0] ?? '').trim();
  const title = first ? `Feedback: ${first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX)}…` : first}` : 'Feedback';
  const q = new URLSearchParams({ template: 'feedback.yml', title, ...(body ? { feedback: body } : {}), ...(versions ? { versions } : {}) });
  return `${REPO_URL}/issues/new?${q.toString()}`;
}
/** The versions line: sub-human's and Claude Code's, whichever are known. */
export const versionsLine = (plugin: string | null, cc: string | null): string =>
  [plugin ? `sub-human ${plugin}` : '', cc ? `Claude Code ${cc}` : ''].filter(Boolean).join(' · ');

/** One browser opener, by name: scripts/open.sh NAME runs it with the URL on stdin (127 when it is not there). */
export interface OpenCommand { name: 'open' | 'wslview' | 'xdg-open' }
/** The openers to try, in order: wslview under WSL; open (macOS: open.sh checks); xdg-open with a display. A session
 * over ssh gets none (a browser would open on the far machine's screen, which nobody is looking at), and the notice
 * carries the URL. */
export function openCommands(env: { WAYLAND_DISPLAY?: string | undefined; DISPLAY?: string | undefined; WSL_DISTRO_NAME?: string | undefined; WSL_INTEROP?: string | undefined; SSH_CONNECTION?: string | undefined; SSH_TTY?: string | undefined }): OpenCommand[] {
  const out: OpenCommand[] = [];
  if (env.SSH_CONNECTION || env.SSH_TTY) return out;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) out.push({ name: 'wslview' });
  out.push({ name: 'open' });
  if (env.WAYLAND_DISPLAY || env.DISPLAY) out.push({ name: 'xdg-open' });
  return out;
}
/** How long one opener, or gh's star, may take. */
export const OPEN_TIMEOUT_MS = 5000;
export const STAR_TIMEOUT_MS = 8000;

/** Runs one opener by name, as the call site's $.process.run of scripts/open.sh (the tests pass a stub). */
export type OpenRunner = (name: OpenCommand['name'], init: { stdin: string; timeoutMs: number }) => Promise<{ exitCode: number }>;
/** The URL to the first opener that exits 0; a missing one (127), a failure or a timeout tries the next. */
export async function openWith(run: OpenRunner, url: string, commands: readonly OpenCommand[]): Promise<'opened' | 'none'> {
  for (const c of commands) {
    try {
      const r = await run(c.name, { stdin: url, timeoutMs: OPEN_TIMEOUT_MS });
      if (r.exitCode === 0) return 'opened';
    } catch { /* the next one */ }
  }
  return 'none';
}

export const STARRED: string = `★ starred ${REPO}, thank you`;
export const starOpened = (): string => `opened ${REPO_URL}: the Star button is at the top right`;
export const starShown = (): string => `star sub-human at ${REPO_URL}`;
export const issueOpened = (): string => 'opened a feedback issue in your browser: check it and press Submit';
export const issueShown = (url: string): string => `write your feedback here (nothing is sent until you press Submit): ${url}`;
/** What the model reads after the card: the person saw the outcome, and nothing is asked of it. */
export const leaveSaid = (said: string): string => `sub-human: the leave card is answered (${said}); the person sees that. Reply with nothing.`;
/** The deny for a leave card call with no leave waiting (asked twice, or never left). */
export const NOTHING_LEFT = 'sub-human: no room was just left here; nothing to show.';
