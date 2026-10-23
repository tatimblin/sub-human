/**
 * plugin/sub-human/mod/core/leave.ts: the card after a leave (docs/next/PLAN-LEAVE-CARD.md), as pure functions;
 * mod/deliver.ts makes the $ calls.
 *
 *   1. /sub-human leave went through in a session a person types in (mod/deliver.ts command.run, leftName): once per
 *      session, unless SUB_HUMAN_LEAVE_CARD=0, the session took a seat again or was cleared before it fires, the module
 *      opens the card itself ($.ui.ask: Claude Code's own AskUserQuestion dialog, no model turn): leaveQuestion(code),
 *      Close / Star on GitHub, and the dialog's own free-text row, where typing sends feedback.
 *   2. leaveOutcome reads the answer. Close, or the dialog dismissed: nothing. Star on GitHub: scripts/star.sh (gh,
 *      when logged in), else the repo page opened (scripts/open.sh), else its URL in a notice. Text typed: GitHub's
 *      new-issue form, filled in (issueUrl), opened or shown the same way; the person reads it and presses Submit
 *      there. Nothing is posted for them.
 * What a URL carries: the person's own text, the two versions, and sub-human's own recent lines in this session
 * (saidBook: command verbs, replies, errors; codes, SECRETs and PINs masked). Never the room's chat or an invite line.
 *
 *   LEAVE_HEADER, CLOSE, STAR, LEAVE_OPTIONS, leaveQuestion(code)   the card
 *   leaveOutcome(answer) -> LeaveOutcome
 *   REPO, REPO_URL, issueUrl({text, versions, session}), versionsLine   where Star and feedback go
 *   saidBook(), sessionSnippet(lines)                               sub-human's own lines this session, masked
 *   openCommands(env) -> OpenCommand[], openWith                    the browser openers (scripts/open.sh runs one)
 *   STARRED, starOpened, starShown, issueOpened, issueShown         what the person sees
 */

export const REPO = 'tatimblin/sub-human';
export const REPO_URL: string = `https://github.com/${REPO}`;

export const LEAVE_HEADER = 'Left room';
export const CLOSE = 'Close';
export const STAR = 'Star on GitHub';
/** The card's options, labels alone; the dialog adds its own free-text row ("Type something."), which is feedback. */
export const LEAVE_OPTIONS: readonly string[] = [CLOSE, STAR];

export const leaveQuestion = (code: string): string => `You left room ${code}. Thanks for trying sub-human! Type below to send feedback.`;

/** What the person's answer does: nothing, star, or feedback (the text they typed). */
export type LeaveOutcome = { kind: 'close' } | { kind: 'star' } | { kind: 'feedback'; text: string };
/** The answer $.ui.ask resolved to: a label, or the text typed in the free-text row; null: dismissed. */
export function leaveOutcome(answer: string | null | undefined): LeaveOutcome {
  const a = typeof answer === 'string' ? answer.trim() : '';
  if (!a || a === CLOSE) return { kind: 'close' };
  if (a === STAR) return { kind: 'star' };
  return { kind: 'feedback', text: a };
}

/** The most of the person's text a URL carries (GitHub refuses a new-issue URL past about 8 KB, once encoded). */
export const FEEDBACK_MAX = 2000;
/** The most of the session snippet a URL carries, and how many of sub-human's lines it keeps (the latest). */
export const SNIPPET_MAX = 1500;
export const SNIPPET_LINES = 20;
const TITLE_MAX = 60;

/**
 * What sub-human said in this session, for the feedback issue: the module keeps its own lines (each /sub-human
 * command's verb, never its arguments, and the replies and errors it showed; never the room's chat, which is other
 * people's words), at most SNIPPET_LINES. Those replies never held an invite line or a PIN; still, anything shaped like
 * a room code, a SECRET or a PIN is masked here, so the snippet names nothing of a room. The person sees it in the
 * form before they submit.
 */
export interface SaidBook { note(line: string): void; command(args: unknown): void; lines(): string[] }
export function saidBook(): SaidBook {
  const kept: string[] = [];
  const push = (l: string) => { kept.push(l); if (kept.length > SNIPPET_LINES) kept.shift(); };
  return {
    note(line) { for (const l of String(line).split('\n')) if (l.trim()) push(l.trimEnd()); },
    command(args) {
      const verb = typeof args === 'string' ? args.trim().split(/\s+/)[0] ?? '' : '';
      push(`> /sub-human${/^[a-z][a-z-]{0,15}$/.test(verb) ? ` ${verb}` : verb ? ' …' : ''}`);
    },
    lines() { return [...kept]; },
  };
}
/** The snippet, masked and cut to SNIPPET_MAX from its end (the latest lines matter most); '' for none. */
export function sessionSnippet(lines: readonly string[]): string {
  const masked = lines.map(l => l
    .replace(/\b[a-z]+-\d{4}\b/g, 'ROOM')
    .replace(/\b[0-9A-Za-z]{20,}\b/g, 'SECRET')
    .replace(/(?<![\d.])\b\d{3,10}\b(?![\d.])/g, 'NNNN'));
  const text = masked.join('\n');
  return text.length > SNIPPET_MAX ? `…${text.slice(text.length - SNIPPET_MAX)}` : text;
}

/**
 * GitHub's new-issue form for .github/ISSUE_TEMPLATE/feedback.yml, its fields filled in by id: feedback (the person's
 * text, cut at FEEDBACK_MAX), versions, session (sessionSnippet's, when there is one); the title from the text's first
 * line. Only what is passed in goes in.
 */
export function issueUrl({ text, versions, session = '' }: { text: string; versions: string; session?: string }): string {
  let body = text.length > FEEDBACK_MAX ? `${text.slice(0, FEEDBACK_MAX)}…` : text;
  const first = (body.split('\n')[0] ?? '').trim();
  const title = first ? `Feedback: ${first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX)}…` : first}` : 'Feedback';
  const build = (s: string) => `${REPO_URL}/issues/new?${new URLSearchParams({
    template: 'feedback.yml', title, ...(body ? { feedback: body } : {}), ...(versions ? { versions } : {}), ...(s ? { session: s } : {}),
  }).toString()}`;
  // encoded, text other than ASCII grows up to 9 times: the snippet gives way first (its oldest lines), then the text
  let s = session;
  let url = build(s);
  while (url.length > URL_MAX && s) { s = s.length > 40 ? `…${s.slice(Math.ceil(s.length / 4))}` : ''; url = build(s); }
  while (url.length > URL_MAX && body) { body = body.length > 40 ? `${body.slice(0, Math.floor(body.length * 3 / 4))}…` : ''; url = build(s); }
  return url;
}
/** The longest new-issue URL made (GitHub refuses one past about 8 KB). */
export const URL_MAX = 7500;
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
