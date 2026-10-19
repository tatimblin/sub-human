/**
 * plugin/sub-human/mod/core/chat.ts: the group-chat drawing of a UserMessage row, as pure functions (mod/render.ts
 * draws them; test/mod-core.node-test.ts checks them in node). In: the row's text (and sender). Out: the lines to draw,
 * or null so the engine draws the row itself.
 */
import { parseAddr } from './seat.ts';
import { CHAT_NEST as NEST, CHAT_LINES_MAX, PEER_LINES_MAX, CHAT_BLANK, FOR_CLAUDE, messageLines } from './constants.ts';

// one copy with lib/room/render.ts: mod/core/constants.ts owns them
export { NEST, CHAT_LINES_MAX, FOR_CLAUDE };

/** Control and bidi characters never reach the drawing (as lib/room/render.ts safeText). */
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const clean = (s: unknown) => String(s).replace(/\r\n?/g, '\n').replace(UNSAFE, '');

/**
 * A message another member's Claude sent: "bob's Claude: <first line>" ("the room's Claude: …" from claude.CODE),
 * further lines under NEST as lib/room/render.ts chatLines lays out a Claude's message to another: blank lines kept
 * (a bare CHAT_BLANK), at most PEER_LINES_MAX then "[+N more lines: ctrl+o]". null when fromName is not a seat
 * address ("NAME.CODE").
 */
export function peerLines(fromName: unknown, text: unknown): string[] | null {
  const who = parseAddr(fromName);
  if (!who) return null;
  const label = who.name === 'claude' ? 'the room\'s Claude' : `${who.name}'s Claude`;
  let lines = messageLines(clean(text), true);
  if (!lines.length) return [label];
  const more = Math.max(0, lines.length - PEER_LINES_MAX);
  if (more) lines = lines.slice(0, PEER_LINES_MAX);
  const out = lines.map((l, i) => (!i ? `${label}: ${l.replace(/^\s+/, '')}` : l ? NEST + l : CHAT_BLANK));
  if (more) out.push(`${NEST}[+${more} more line${more === 1 ? '' : 's'}: ctrl+o]`);
  return out;
}

/** One drawn line of a sub-human prompt: dim for a "(for Claude)" marker. */
export interface RoomRow { text: string; dim: boolean }
/** The longest a "(for Claude)" marker is drawn, in characters, "…" included. */
export const FOR_CLAUDE_MARK_MAX = 72;

/** Claude Code's frame around a plugin's prompt (cc CONTRACT plugin-prompt-frame): its head line, and the paragraph
 * after the text, between turns or mid-turn ("while you were working"). */
const FRAME_HEAD = /^The .{1,80} plugin sent a message(?: while you were working)?:$/;
const FRAME_TAIL = /^This is how Claude Code surfaces (?:a prompt|prompts) a plugin submits /;

/**
 * A sub-human prompt as the person sees it: its chat lines, and each run of "(for Claude)" lines (what only the model
 * acts on: a wake's head, the room's state) as one dim marker in its place, the first of them cut to
 * FOR_CLAUDE_MARK_MAX, with "(+N)" for the others (ctrl+o shows them whole). Claude Code's frame (a wake is
 * submitted framed, cc CONTRACT plugin-prompt-frame) is left out. expanded (ctrl+o, or a row that fits its speaker
 * label, which Claude Code also draws expanded): nothing is cut, the frame and every "(for Claude)" line are drawn
 * whole and dim. The model reads the prompt unchanged. null when no chat line is left (the engine draws the row).
 */
export function roomRows(text: unknown, { expanded = false }: { expanded?: boolean } = {}): RoomRow[] | null {
  const rows: RoomRow[] = [];
  let run = 0;
  let tail = false;
  const all = clean(text).split('\n').map(x => x.replace(/\s+$/, '')).filter(x => x.trim());
  for (const [i, l] of all.entries()) {
    const frame = (i === 0 && FRAME_HEAD.test(l)) || tail || (tail = FRAME_TAIL.test(l));
    if (frame) { if (expanded) rows.push({ text: l, dim: true }); continue; }
    if (expanded && l.startsWith(FOR_CLAUDE)) { rows.push({ text: l, dim: true }); continue; }
    if (!l.startsWith(FOR_CLAUDE)) { run = 0; rows.push({ text: l, dim: false }); continue; }
    if (run++) { // the run's first line is the last row
      const prev = rows.at(-1);
      if (prev) rows[rows.length - 1] = { text: `${prev.text.replace(/ \(\+\d+\)$/, '')} (+${run - 1})`, dim: true };
      continue;
    }
    rows.push({ text: l.length > FOR_CLAUDE_MARK_MAX ? `${l.slice(0, FOR_CLAUDE_MARK_MAX - 1).trimEnd()}…` : l, dim: true });
  }
  return rows.some(r => !r.dim) ? rows : null;
}
