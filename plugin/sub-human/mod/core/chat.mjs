/**
 * plugin/sub-human/mod/core/chat.mjs: the group-chat drawing of a UserMessage row, as pure functions (mod/render.mjs
 * draws them; test/mod-core.test.js checks them in node). In: the row's text (and sender). Out: the lines to draw,
 * or null so the engine draws the row itself.
 */
import { parseAddr } from './seat.mjs';

// Copies of lib/config.js / lib/room/render.js (asserted equal in node): mod/ imports no CommonJS.
export const NEST = '  │ ';
export const FOR_CLAUDE = '(for Claude)';
export const CHAT_LINES_MAX = 20;

/** Control and bidi characters never reach the drawing (as lib/room/render.js safeText). */
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
const clean = s => String(s).replace(/\r\n?/g, '\n').replace(UNSAFE, '');

/**
 * A message another member's Claude sent: "bob's Claude: <first line>", further lines under NEST as
 * lib/room/render.js chatLines lays out a message, at most CHAT_LINES_MAX then "[+N more lines: ctrl+o]".
 * null when fromName is not a seat address ("NAME.CODE").
 */
export function peerLines(fromName, text) {
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

/** A sub-human prompt without its "(for Claude)" lines (the model still reads them); null when none is left. */
export function roomLines(text) {
  const lines = clean(text).split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim() && !l.startsWith(FOR_CLAUDE));
  return lines.length ? lines : null;
}
