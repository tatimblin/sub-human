/**
 * plugin/sub-human/lib/cc/transcript.ts: reading a session's JSONL transcript and a prompt's pastes, as Claude Code writes them.
 *
 * Shapes are incidental (lib/cc/contract.json, `@cc` tags as in lib/cc/env.ts); fixture lines in test/cc.node-test.ts
 * follow docs/internals/cc-2.1.281.md and the rows 2.1.292 and 2.1.296 wrote.
 */

import fs from 'node:fs';
import path from 'node:path';
import { plansDir } from './env.ts';
import { decode, objAs } from '../decode.ts';
import { HOME_MARK, homeMark } from '../../mod/core/constants.ts';

type Env = NodeJS.ProcessEnv;

/** A content block of a transcript message, as far as these readers look (the rest of the JSON is not typed). */
interface ContentBlock {
  type?: string;
  text?: unknown;
  id?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
  input?: unknown;
  [field: string]: unknown;
}
/** One parsed transcript line, as far as these readers look: read from disk, so every field is checked before use. */
interface TranscriptEntry {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  message?: { content?: unknown };
  origin?: unknown;
  timestamp?: string;
  attachment?: { type?: string; planFilePath?: string };
  userFeedback?: unknown;
  promptId?: string;
  [field: string]: unknown;
}
/** A parsed line as a TranscriptEntry: an object (every field optional, checked where read). */
const ENTRY = objAs<TranscriptEntry>();
/** A transcript line: raw (a cheap substring prefilter, then parse) or already parsed. */
type TranscriptLine = string | TranscriptEntry;

/**
 * A JSONL transcript's raw lines (oldest first; [] when unreadable). With tailBytes, only the last tailBytes
 * are read and a line cut by that boundary is dropped.
 * @cc ?.feedbackIsFromUser&&
 * @stability incidental
 */
function readLines(file: unknown, { tailBytes }: { tailBytes?: number } = {}): string[] {
  if (typeof file !== 'string' || !file) return [];
  let text: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (!tailBytes || size <= tailBytes) {
        const buf = Buffer.alloc(size);
        fs.readSync(fd, buf, 0, size, 0);
        text = buf.toString('utf8');
      } else {
        // one extra byte tells whether the cut falls on a line boundary
        const buf = Buffer.alloc(tailBytes + 1);
        fs.readSync(fd, buf, 0, tailBytes + 1, size - tailBytes - 1);
        text = buf.toString('utf8');
        const nl = text.indexOf('\n');
        text = nl < 0 ? '' : text.slice(nl + 1);
      }
    } finally { fs.closeSync(fd); }
  } catch { return []; }
  return text.split('\n').filter(Boolean);
}

/** Parsed entries from raw lines; torn or non-JSON lines are skipped. */
function parseLines(lines: readonly TranscriptLine[]): TranscriptEntry[] {
  const es: TranscriptEntry[] = [];
  for (const l of lines) {
    if (l && typeof l === 'object') { es.push(l); continue; }
    try { const e = decode(ENTRY, JSON.parse(l)); if (e) es.push(e); } catch { /* torn line */ }
  }
  return es;
}

/**
 * readLines, parsed. Same as at-room's transcriptTail with tailBytes 512 KiB.
 * @cc ?.feedbackIsFromUser&&
 * @stability incidental
 */
const readEntries = (file: unknown, opts?: { tailBytes?: number }): TranscriptEntry[] => parseLines(readLines(file, opts));

// Lines may be raw strings (cheap substring prefilter, then parse) or already-parsed entries.
const lineHas = (l: TranscriptLine, ...subs: string[]): boolean => typeof l !== 'string' || subs.every(s => l.includes(s));
const asEntry = (l: TranscriptLine): TranscriptEntry | null => { if (l && typeof l === 'object') return l; try { return decode(ENTRY, JSON.parse(l)); } catch { return null; } };

/**
 * The session's plan file, as Claude Code recorded it: the latest `plan_mode` attachment's planFilePath, else null.
 * toolInput: ExitPlanMode's input on PreToolUse/PermissionRequest, where Claude Code injects planFilePath
 * (normalizeToolInput; cc CONTRACT exitplan-normalize); its path wins only when it is the attachment's or lies under
 * the plans dir (plansDir; a project's own `plansDirectory` is the attachment's path). The hooks write a proposal to
 * this file, so a path of the model's choosing (its own key on any other call, or one CC did not overwrite) never counts.
 * @cc type:"plan_mode",reminderType:
 * @stability incidental
 */
function planFile(lines: readonly TranscriptLine[], toolInput?: { planFilePath?: unknown } | null, env: Env = process.env): string | null {
  let att: string | null = null;
  for (let k = lines.length - 1; k >= 0 && !att; k--) {
    const line = lines[k];
    if (line === undefined || !lineHas(line, '"plan_mode"', 'planFilePath')) continue;
    const e = asEntry(line);
    const a = e && e.attachment;
    if (a && a.type === 'plan_mode' && typeof a.planFilePath === 'string' && a.planFilePath) att = a.planFilePath;
  }
  const ti = toolInput && typeof toolInput.planFilePath === 'string' && toolInput.planFilePath ? toolInput.planFilePath : null;
  return ti && (ti === att || underPlans(ti, env)) ? ti : att;
}

/** file lies under the plans dir (plansDir), once `..` and links in the dir are resolved. */
function underPlans(file: string, env: Env = process.env): boolean {
  if (!path.isAbsolute(file)) return false;
  const abs = path.resolve(file);
  const dir = path.resolve(plansDir(env));
  let real = dir;
  try { real = fs.realpathSync(dir); } catch { /* none yet */ }
  return [dir, real].some(d => abs.startsWith(d + path.sep));
}

const contentText = (c: unknown): string => typeof c === 'string' ? c
  : Array.isArray(c) ? c.map((b: ContentBlock | null) => (b && b.type === 'text' && typeof b.text === 'string') ? b.text : '').join('\n') : '';

/** The text before a rejected tool's note ("…To tell you how to proceed, the user said:\n<note>"). */
const SAID = 'the user said:\n';
/** What follows the note in the rejection text. */
const NOTE = '\n\nNote: The user\'s next message';

/**
 * How the dialog of tool use toolUseId closed, as far as the transcript has it: null while its tool_result is not
 * on disk (the dialog still open, or the line not written yet), else {note}: the person's "No, keep planning" /
 * "Tell Claude what to change" note, or null (approved: not an error result; or rejected with no note, e.g. Esc).
 * Prefers the structured top-level `userFeedback` field on the tool_result entry; falls back to the text after
 * "the user said:\n" (cut at the "Note: The user's next message" suffix). On 2.1.296 the entry also carries
 * toolUseResult "Error: <the text>", toolDenialKind "user-rejected" and permissionDecision {decision "reject",
 * source "user_reject"}, none of which is read.
 * @cc ?.feedbackIsFromUser&&
 * @stability incidental
 */
function planAnswer(lines: readonly TranscriptLine[], toolUseId: string | null | undefined): { note: string | null } | null {
  if (!toolUseId) return null;
  for (let k = lines.length - 1; k >= 0; k--) {
    const line = lines[k];
    if (line === undefined || !lineHas(line, toolUseId, 'tool_result')) continue;
    const e = asEntry(line);
    if (!e) continue; // no entry: no block
    const msg = e.message;
    const block = (msg && Array.isArray(msg.content) ? msg.content as (ContentBlock | null)[] : []).find(b => b && b.type === 'tool_result' && b.tool_use_id === toolUseId);
    if (!block) continue;
    if (!block.is_error) return { note: null };
    if (typeof e.userFeedback === 'string') return { note: e.userFeedback };
    return rejectionAnswer(contentText(block.content));
  }
  return null;
}

/**
 * A refusal's text as the tool's result reads it (the module's tool.call gets it before the line is on disk): {note}
 * as planAnswer reads the same text in the transcript; note null when the person wrote none (Esc, a bare deny).
 * @cc ?.feedbackIsFromUser&&
 * @stability incidental
 */
function rejectionAnswer(text: string): { note: string | null } {
  const at = text.indexOf(SAID);
  if (at < 0) return { note: null };
  const rest = text.slice(at + SAID.length);
  const end = rest.lastIndexOf(NOTE);
  return { note: end >= 0 ? rest.slice(0, end) : rest };
}

/** planAnswer's note alone: null also while the tool_result is not on disk. */
const planFeedback = (lines: readonly TranscriptLine[], toolUseId: string | null | undefined): string | null => planAnswer(lines, toolUseId)?.note ?? null;

/**
 * The input the model itself sent for tool use toolUseId (from the assistant tool_use block), or null.
 * ExitPlanMode's hook input has plan/planFilePath injected from disk; the transcript copy has them stripped.
 * @cc ,new Set(["plan","planFilePath"])]])
 * @stability incidental
 */
function toolUseInput(lines: readonly TranscriptLine[], toolUseId: string | null | undefined): unknown {
  if (!toolUseId) return null;
  for (let k = lines.length - 1; k >= 0; k--) {
    const line = lines[k];
    if (line === undefined || !lineHas(line, toolUseId, '"tool_use"')) continue;
    const e = asEntry(line);
    const c = e && e.message && e.message.content;
    const b = (Array.isArray(c) ? c as (ContentBlock | null)[] : []).find(x => x && x.type === 'tool_use' && x.id === toolUseId);
    if (b) return b.input ?? null; // a block with no input: none
  }
  return null;
}

/**
 * The person's latest prompt in the transcript lines, or null: the newest user entry that is a prompt (not a
 * tool_result, not isMeta, not a sidechain or a compact summary), taken only when it is the person's own: its
 * `origin` is absent or kind "human" (a typed prompt, also one typed through Remote Control). Any other kind (a
 * peer, a task notification, a channel, a plugin's wake, anything unclassified) is not the person's words: null.
 * Returns {text, at} (at: the entry's timestamp, ms; 0 when it has none).
 * @cc {kind:"human"}
 * @stability incidental
 */
function lastHumanPrompt(lines: readonly TranscriptLine[]): { text: string; at: number } | null {
  for (let k = lines.length - 1; k >= 0; k--) {
    const line = lines[k];
    if (line === undefined || !lineHas(line, '"user"')) continue;
    const e = asEntry(line);
    if (!e || e.type !== 'user' || e.isMeta || e.isSidechain || e.isCompactSummary || !e.message) continue;
    const c = e.message.content;
    if (Array.isArray(c) && c.some((b: ContentBlock | null) => b && b.type === 'tool_result')) continue;
    const text = contentText(c);
    if (!text.trim()) continue;
    const kind = e.origin && typeof e.origin === 'object' ? (e.origin as { kind?: unknown }).kind : undefined;
    if (e.origin !== undefined && kind !== 'human') return null;
    const at = Date.parse(e.timestamp as string);
    return { text, at: Number.isFinite(at) ? at : 0 };
  }
  return null;
}

// ---------- prompts: pastes ----------

/**
 * A long paste as the prompt carries it: \n\n<pasted_content id="N">\n…\n</pasted_content id="N">\n.
 * Same regex as at-room's PASTE (global; reset lastIndex or use String#replace).
 * @cc <pasted_content id="
 * @stability incidental
 */
const PASTED_RE: RegExp = /(?:\n\n)?<pasted_content id="?(\w+)"?>\n([\s\S]*?)\n?<\/pasted_content id="?\1"?>\n?/g;

/** {text, normalized}: the prompt with each paste wrapper replaced by its body. Same as at-room's unwrap. */
function unwrapPasted(text: unknown): { text: string; normalized: boolean } {
  let normalized = false;
  const t = String(text).replace(PASTED_RE, (_: string, _id: string, body: string) => { normalized = true; return body; });
  return { text: t, normalized };
}

/**
 * The session id this transcript's conversation went on in, or null: ← (the agent view) backgrounds a session as a
 * fork (a new session id) and then appends {"type":"continued-in","continuedInSessionId":NEW} to the old transcript.
 * Reads the last 64 KiB: the record is written at the moment of the fork, and the old session writes little after it.
 * @cc "type":"continued-in"
 * @stability incidental
 */
function continuedIn(file: unknown): string | null {
  let out: string | null = null;
  for (const l of readLines(file, { tailBytes: 64 * 1024 })) {
    if (!l.includes('"continued-in"')) continue;
    const e = asEntry(l);
    if (e && e.type === 'continued-in' && typeof e.continuedInSessionId === 'string') out = e.continuedInSessionId;
  }
  return out;
}

/**
 * The session's title as its transcript keeps it, or null: Claude Code writes {"type":"custom-title","customTitle":T}
 * for each title set (a hook's sessionTitle among them: the seat's address NAME.CODE), and the last one wins. Reads
 * the last 256 KiB.
 * @cc "type":"custom-title"
 * @stability incidental
 */
function lastTitle(file: unknown): string | null {
  let out: string | null = null;
  for (const l of readLines(file, { tailBytes: 256 * 1024 })) {
    if (!l.includes('"custom-title"')) continue;
    const e = asEntry(l);
    if (e && e.type === 'custom-title' && typeof e.customTitle === 'string') out = e.customTitle;
  }
  return out;
}


/**
 * The sub-human folder this transcript's session last held a seat in, or null: the hooks module appends HOME_MARK and
 * the folder as a system row ($.session.append), which Claude Code keeps as {"type":"system","subtype":"informational",
 * "content":TEXT,"level":"info"} (drawn only in the ctrl+o transcript view). The agent view's fork reads it from the
 * transcript it continued, since the bg job it runs in drops a shell's SUB_HUMAN_HOME. Reads the
 * whole file (the notice is written at the join, which may be long before the fork), only lines that name the mark.
 * @cc "a notice that is not one text block"
 * @stability incidental
 */
function lastHome(file: unknown): string | null {
  let out: string | null = null;
  for (const l of readLines(file)) {
    if (!l.includes(HOME_MARK)) continue;
    const e = asEntry(l);
    const c = e && e.type === 'system' ? e.content : null;
    if (typeof c === 'string' && c.startsWith(HOME_MARK) && c.slice(HOME_MARK.length).startsWith('/')) out = c.slice(HOME_MARK.length).trim();
  }
  return out;
}

export {
  readLines, readEntries, parseLines, planFile, planAnswer, planFeedback, toolUseInput, lastHumanPrompt, contentText,
  SAID, NOTE, PASTED_RE, unwrapPasted, continuedIn, lastTitle, HOME_MARK, homeMark, lastHome, rejectionAnswer,
};
export type { TranscriptEntry, TranscriptLine, ContentBlock };
