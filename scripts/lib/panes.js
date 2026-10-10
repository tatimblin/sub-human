'use strict';
/** panes: parsers for plain-text pane captures (used by checks, demo-lib and their tests). */

const MAIN_ROW = /^\s*(❯\s*)?[⏺●◯]\s+main\b/;

/** Panel rows of a capture: the lines below the prompt box that start with ⏺/◯/● (agent panel). */
function panelRows(txt) {
  if (!txt) return [];
  const lines = txt.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (MAIN_ROW.test(lines[i])) start = i;
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(\s*)(❯\s*)?(└\s*)?(◯|●|⏺)\s+(\S+)\s*(.*)$/.exec(lines[i]);
    if (m) out.push({ indent: m[1].length, selected: !!m[2], nested: !!m[3], label: m[5], text: m[6].trim(), line: lines[i].trim() });
  }
  return out;
}

/** Status line under the prompt (the ⬡ line between the prompt box and the panel). */
function statusLine(txt) {
  const l = (txt || '').split('\n').filter(x => /^\s*⬡\s/.test(x)).at(-1);
  return l ? l.trim() : '';
}

/** The ❯ line index and option labels of an open consent card, or null. */
function cardState(p) {
  const lines = p.split('\n');
  const q = lines.findIndex(l => /Agree to proposal [0-9a-f]{12}\?/.test(l));
  if (q < 0) return null;
  const opts = [];
  for (let i = q + 1; i < lines.length && opts.length < 4; i++) {
    const m = /^\s*(❯)?\s*(\d)\.\s+(Not yet|Agree|Object|Type something|Chat about this)\b/.exec(lines[i]);
    if (m) opts.push({ cur: !!m[1], n: +m[2], label: m[3] });
  }
  return opts.length ? { opts } : null;
}

/** The plan-approval dialog a room review opens in (hooks/consent.js), or null: its option lines. */
function planState(p) {
  if (!/Would you like to proceed\?/.test(p) || !/Tell Claude what to change|No, keep planning/.test(p)) return null;
  const opts = [];
  for (const l of p.split('\n')) {
    const m = /^\s*(❯)?\s*(\d)\.\s+(Yes, [^\n]*?|Tell Claude what to change|No, keep planning)\s*$/.exec(l);
    if (m) opts.push({ cur: !!m[1], n: +m[2], label: m[3] });
  }
  return opts.length ? { opts } : null;
}

/**
 * The line /sub-human invite showed in a capture, without its "/sub-human ", or null: "join DEST ROOM PIN" (DEST an
 * ssh address or pipe:HOME; a 4-digit PIN; then any --via) or "join URL PIN". The pane may wrap it: a line break
 * (and the next line's indent) inside a path is dropped first. The last one shown wins.
 */
function joinLineIn(txt) {
  const joined = (txt || '').replace(/([A-Za-z0-9_./:@-])\n[ \t│⎿]*(?=[A-Za-z0-9_./:@-])/g, '$1'); // one wrap, not a blank line
  const re = /\/sub-human (join (?:https?:\/\/\S+|\S+ [a-z]+-\d{4}) \d{4}(?: --via \S+)?)(?=\s|$)/g;
  const all = [...joined.matchAll(re)].map(m => m[1]);
  return all.at(-1) || null;
}

/** The host's join-request card (lib/remote/admission.js question), or null: its option lines (Let in / Refuse). */
function admitCardState(p) {
  const lines = String(p || '').split('\n');
  const q = lines.findIndex(l => /Let \S+ \(.*\) on \S+ join room [a-z]+-\d{4}\?|\(admit [0-9a-f]{12}\)/.test(l));
  if (q < 0) return null;
  const opts = [];
  for (let i = q + 1; i < lines.length && opts.length < 4; i++) {
    const m = /^\s*(❯)?\s*(\d)\.\s+(Let in|Refuse|Type something|Chat about this)\b/.exec(lines[i]);
    if (m) opts.push({ cur: !!m[1], n: +m[2], label: m[3] });
  }
  return opts.length ? { opts } : null;
}

module.exports = { MAIN_ROW, panelRows, statusLine, cardState, planState, joinLineIn, admitCardState };
