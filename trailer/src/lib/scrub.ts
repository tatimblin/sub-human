/**
 * The pure half of the capture loader: a take's line format (meta, frame and marker lines), and the scrub every
 * frame goes through (personal information out, noisy rows blanked or dropped). No Remotion imports, so
 * scripts/prescrub.mjs can bundle it and write a pre-scrubbed capture.jsonl.gz for git.
 */
import { stripAnsi } from './ansi';

export type SessionMeta = { cols: number; rows: number };
export type Meta = { t: number; kind: 'meta'; sessions: Record<string, SessionMeta>; room?: string };
export type Frame = { t: number; kind: 'frame'; session: string; ansi: string };
export type Marker = { t: number; kind: 'marker'; scene: string; beat: string; caption?: string };

export type Capture = {
  take: string;
  meta: Meta;
  /** per session, sorted by t */
  frames: Record<string, Frame[]>;
  markers: Marker[];
  /** last t seen in the file */
  end: number;
};

export type ScrubOptions = {
  /** extra literal words to replace (a username, a hostname); each becomes `with` */
  words?: string[];
  with?: string;
  /** rows whose plain text matches one of these are removed from every screen (and a blank row added at the bottom) */
  dropRows?: string[];
};

/** Rows dropped by default: the update nag. */
export const DEFAULT_DROP_ROWS = ['Update available! Run:'];

/**
 * Rows blanked in place (the layout keeps its shape): the account's login warning, the completion menus that list
 * the machine's own skills, commands, agents, MCP servers and other sessions while a prompt is typed, and Claude
 * Code's rotating tips (noise in a cut). Prompt suggestions are cleared, the prompt kept.
 */
const BLANK_ROWS = [
  /Your login expires|run \/login to renew|Run \/login|\/login to sign in/,
  /^ {2}⎿[ \u00a0]{2}Tip: /,
  /^ {2,6}[+*◇] \S/, // "@" menu: files, agents, MCP resources
  /^ {2}(?:❯ | {2})@"[^"]+" +message session/, // "@" menu: other sessions on this machine
  /^ {2}(?:❯ | {2})\/[\w:.-]+(?: \([^)]*\))? {2,}\S/, // "/" menu: commands and skills
];
/** a "/" menu entry's description runs on, deeply indented, below it */
const MENU_CONTINUATION = /^ {40,}\S/;
/**
 * Claude Code's prompt suggestion: dim text after an empty "❯ " ("Try …", or a guess at the next prompt). It reads
 * as if the person had typed it, so only the prompt is kept.
 */
// eslint-disable-next-line no-control-regex
const SUGGESTION = /^((?:\x1b\[[0-9;]*m)*❯[ \u00a0])\x1b\[2m.*$/;

function blankRows(ansi: string): string {
  const lines = ansi.split('\n');
  let prevBlanked = false;
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (SUGGESTION.test(lines[i])) {
      lines[i] = lines[i].replace(SUGGESTION, '$1');
      changed = true;
    }
    const text = plain(lines[i]);
    const hit: boolean = BLANK_ROWS.some((re) => re.test(text)) || (prevBlanked && MENU_CONTINUATION.test(text));
    if (hit) {
      lines[i] = '';
      changed = true;
    }
    prevBlanked = hit;
  }
  return changed ? lines.join('\n') : ansi;
}

/** the model and plan: the banner's "Opus 5.5 (1M context) · Claude Max", or "Claude Opus 5.5 (1M context)" in a commit trailer */
const MODEL = '(?:Opus|Sonnet|Haiku|Fable|Mythos)(?: \\d+(?:\\.\\d+)*)?(?: \\([^)\\n]*\\))?';
const BANNER_PLAN = new RegExp(`${MODEL} · (?:Claude (?:Max|Pro|Team|Enterprise)|API Usage Billing|Claude API)[^\\x1b\\n]*`, 'g');
const MODEL_NAME = new RegExp(`Claude ${MODEL}`, 'g');

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replace absolute paths, home directories, user@host and .local hostnames. Runs over the ANSI text: none of
 * the patterns can match inside an escape sequence. The demo's seat dirs (/tmp/sh-demo/<seat>) become ~/app,
 * its store (/tmp/sh-demo/home…) ~/.sub-human; the room code is kept.
 */
export function scrub(ansi: string, opts: ScrubOptions = {}): string {
  let s = ansi
    .replace(BANNER_PLAN, '')
    .replace(MODEL_NAME, 'Claude')
    // a Claude's scratchpad (/tmp/claude-UID/<project>/<session>/scratchpad) and the plugin's own CLI by its full path
    .replace(/(?:\/private)?\/tmp\/claude-\d+\/[^/\s]+\/[0-9a-f-]{36}\/scratchpad/g, '/tmp/scratchpad')
    .replace(/\/(?:Users|home)\/[^/\s]+\/[^\s'"`]*?\/plugin\/sub-human\/scripts\/sub-human\b/g, 'sub-human')
    .replace(/(?:\/private)?\/tmp\/sh-demo\/home\d*/g, '~/.sub-human')
    .replace(/(?:\/private)?\/tmp\/sh-demo\/(?:[A-Za-z0-9_-]+)/g, '~/app')
    .replace(/-private-tmp-sh-demo-[A-Za-z0-9_-]+/g, '-app')
    // eslint-disable-next-line no-control-regex
    .replace(/\/(?:Users|home)\/[^/\s\x1b'"`)]+/g, '~')
    .replace(/\b[A-Za-z0-9._-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:local|lan|home|internal|ts\.net)\b/g, 'you@devbox')
    .replace(/\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:local|lan|internal)\b/g, 'devbox');
  for (const w of opts.words || []) {
    if (w) s = s.replace(new RegExp(`\\b${esc(w)}\\b`, 'g'), opts.with ?? 'you');
  }
  return s;
}

const plain = (line: string) => stripAnsi(line);

function dropRows(ansi: string, patterns: string[]): string {
  if (!patterns.length) return ansi;
  const lines = ansi.split('\n');
  const kept = lines.filter((l) => !patterns.some((p) => plain(l).includes(p)));
  while (kept.length < lines.length) kept.push('');
  return kept.join('\n');
}

export function parseCapture(take: string, text: string, opts: ScrubOptions = {}): Capture {
  let meta: Meta | null = null;
  const frames: Record<string, Frame[]> = {};
  const markers: Marker[] = [];
  let end = 0;
  const drop = opts.dropRows ?? DEFAULT_DROP_ROWS;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o: Meta | Frame | Marker;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // a torn last line from a capture still being written
    }
    end = Math.max(end, o.t || 0);
    if (o.kind === 'meta') meta = o;
    else if (o.kind === 'frame') {
      (frames[o.session] ||= []).push({ ...o, ansi: dropRows(blankRows(scrub(o.ansi, opts)), drop) });
    } else if (o.kind === 'marker') markers.push({ ...o, caption: o.caption ? scrub(o.caption, opts) : o.caption });
  }
  if (!meta) {
    meta = { t: 0, kind: 'meta', sessions: {} };
  }
  for (const [name, fs] of Object.entries(frames)) {
    fs.sort((a, b) => a.t - b.t);
    if (!meta.sessions[name]) meta.sessions[name] = { cols: 120, rows: 40 };
  }
  markers.sort((a, b) => a.t - b.t);
  return { take, meta, frames, markers, end };
}

