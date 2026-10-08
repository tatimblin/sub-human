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
 * The invite /sub-human host showed in a capture, or null: sh2.CODE.LOCATOR.SECRET.HOSTKEY (a 22-character secret
 * and a 43-character key or "0") or the older sh1.CODE.LOCATOR.SECRET (a 32-character secret); plugin
 * lib/remote/auth.js. The pane may wrap it: a line break (and the next line's indent) between two of its
 * characters is dropped first. The last one shown wins.
 */
function inviteIn(txt) {
  const joined = (txt || '').replace(/([A-Za-z0-9_.-])\n[\s│⎿]*(?=[A-Za-z0-9_.-])/g, '$1');
  const re = /sh2\.[a-z]+-\d{4}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}\.(?:[A-Za-z0-9_-]{43}|0)(?![A-Za-z0-9_-])|sh1\.[a-z]+-\d{4}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{32}/g;
  const all = [...joined.matchAll(re)].map(m => m[0]);
  return all.at(-1) || null;
}

/** The PIN /sub-human host showed with its invite ("PIN 482913"), or null; the last one wins. */
function pinIn(txt) {
  const all = [...String(txt || '').matchAll(/\bPIN (\d{6})\b/g)].map(m => m[1]);
  return all.at(-1) || null;
}

module.exports = { MAIN_ROW, panelRows, statusLine, cardState, planState, inviteIn, pinIn };
