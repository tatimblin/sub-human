/**
 * plugin/sub-human/mod/core/chat.ts: the group-chat drawing of a UserMessage row, as pure functions (mod/render.ts
 * draws them; test/mod-core.node-test.ts checks them in node). In: the row's text (and sender). Out: the lines to draw,
 * or null so the engine draws the row itself.
 */
import { parseAddr } from './seat.ts';
import { CHAT_NEST as NEST, CHAT_LINES_MAX, FOR_CLAUDE } from './constants.ts';

// one copy with lib/room/render.ts: mod/core/constants.ts owns them
export { NEST, CHAT_LINES_MAX, FOR_CLAUDE };

/** Control and bidi characters never reach the drawing (as lib/room/render.ts safeText). */
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
const clean = (s: unknown) => String(s).replace(/\r\n?/g, '\n').replace(UNSAFE, '');

/**
 * A message another member's Claude sent: "bob's Claude: <first line>", further lines under NEST as
 * lib/room/render.ts chatLines lays out a message, at most CHAT_LINES_MAX then "[+N more lines: ctrl+o]".
 * null when fromName is not a seat address ("NAME.CODE").
 */
export function peerLines(fromName: unknown, text: unknown): string[] | null {
  const who = parseAddr(fromName);
  if (!who) return null;
  let lines = clean(text).split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim());
  if (!lines.length) return [`${who.name}'s Claude`];
  const more = Math.max(0, lines.length - CHAT_LINES_MAX);
  if (more) lines = lines.slice(0, CHAT_LINES_MAX);
  const out = lines.map((l, i) => (i ? NEST + l : `${who.name}'s Claude: ${l.replace(/^\s+/, '')}`));
  if (more) out.push(`${NEST}[+${more} more line${more === 1 ? '' : 's'}: ctrl+o]`);
  return out;
}

/** One drawn line of a sub-human prompt: dim for a "(for Claude)" marker. */
export interface RoomRow { text: string; dim: boolean }
/** The longest a "(for Claude)" marker is drawn, in characters, "…" included. */
export const FOR_CLAUDE_MARK_MAX = 72;

/**
 * A sub-human prompt as the person sees it: its chat lines, and each run of "(for Claude)" lines (what only the model
 * acts on: a wake's head, the room's state) as one dim marker in its place, the first of them cut to
 * FOR_CLAUDE_MARK_MAX, with "(+N)" for the others (ctrl+o shows them whole). Nothing is hidden from the person, and
 * the model reads the prompt unchanged. null when no chat line is left (the engine draws the row itself).
 */
export function roomRows(text: unknown): RoomRow[] | null {
  const rows: RoomRow[] = [];
  let run = 0;
  for (const l of clean(text).split('\n').map(x => x.replace(/\s+$/, '')).filter(x => x.trim())) {
    if (!l.startsWith(FOR_CLAUDE)) { run = 0; rows.push({ text: l, dim: false }); continue; }
    if (run++) { rows[rows.length - 1] = { text: `${rows[rows.length - 1].text.replace(/ \(\+\d+\)$/, '')} (+${run - 1})`, dim: true }; continue; }
    rows.push({ text: l.length > FOR_CLAUDE_MARK_MAX ? `${l.slice(0, FOR_CLAUDE_MARK_MAX - 1).trimEnd()}…` : l, dim: true });
  }
  return rows.some(r => !r.dim) ? rows : null;
}
