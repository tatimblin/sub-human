/** panes: parsers for plain-text pane captures (used by checks, demo-lib and their tests). */

/** One agent-panel row of a capture. */
export interface PanelRow { indent: number, selected: boolean, nested: boolean, label: string, text: string, line: string }
/** One numbered option of a dialog in a capture; `cur` when the ❯ cursor is on it. */
export interface DialogOpt { cur: boolean, n: number, label: string }
/** An open dialog's options. */
export interface DialogState { opts: DialogOpt[] }

export const MAIN_ROW = /^\s*(❯\s*)?[⏺●◯]\s+main\b/;

/** Panel rows of a capture: the lines below the prompt box that start with ⏺/◯/● (agent panel). */
export function panelRows(txt: string | null | undefined): PanelRow[] {
  if (!txt) return [];
  const lines = txt.split('\n');
  let start = -1;
  for (const [i, l] of lines.entries()) if (MAIN_ROW.test(l)) start = i;
  if (start < 0) return [];
  const out: PanelRow[] = [];
  for (const l of lines.slice(start + 1)) {
    const m = /^(\s*)(❯\s*)?(└\s*)?(◯|●|⏺)\s+(\S+)\s*(.*)$/.exec(l);
    if (!m) continue;
    const [, indent = '', selected, nested, , label = '', text = ''] = m;
    out.push({ indent: indent.length, selected: !!selected, nested: !!nested, label, text: text.trim(), line: l.trim() });
  }
  return out;
}

/** The room row and the members shown inside it (an opened room row: └ rows under it), or null: {room, members}. */
export function roomRowMembers(txt: string | null | undefined, code: string): { room: PanelRow, members: string[] } | null {
  const rows = panelRows(txt);
  const i = rows.findIndex(r => !r.nested && r.label === code);
  const room = rows[i];
  if (i < 0 || !room) return null;
  const members: string[] = [];
  for (const r of rows.slice(i + 1)) { if (!r.nested) break; members.push(r.label); }
  return { room, members };
}

/** Top-level panel rows besides main and the room row: a Claude's own subagents (◯ Explore  Read server and store). */
export function subagentRows(txt: string | null | undefined, code: string): PanelRow[] {
  return panelRows(txt).filter(r => !r.nested && r.label !== code && r.label !== 'main');
}

/** Status line under the prompt (the ⬡ line between the prompt box and the panel). */
export function statusLine(txt: string | null | undefined): string {
  const l = (txt || '').split('\n').filter(x => /^\s*⬡\s/.test(x)).at(-1);
  return l ? l.trim() : '';
}

/** One option line of a dialog: m is (❯)?, the digit, the label. */
function dialogOpt(m: RegExpExecArray): DialogOpt {
  const [, cur, n = '', label = ''] = m;
  return { cur: !!cur, n: +n, label };
}

/** The ❯ line index and option labels of an open consent card, or null. */
export function cardState(p: string): DialogState | null {
  const lines = p.split('\n');
  const q = lines.findIndex(l => /Agree to proposal [0-9a-f]{12}\?/.test(l));
  if (q < 0) return null;
  const opts: DialogOpt[] = [];
  for (const l of lines.slice(q + 1)) {
    if (opts.length >= 4) break;
    const m = /^\s*(❯)?\s*(\d)\.\s+(Not yet|Agree|Object|Type something|Chat about this)\b/.exec(l);
    if (m) opts.push(dialogOpt(m));
  }
  return opts.length ? { opts } : null;
}

/** The plan-approval dialog a room review opens in (hooks/handlers/consent.ts), or null: its option lines. */
export function planState(p: string): DialogState | null {
  if (!/Would you like to proceed\?/.test(p) || !/Tell Claude what to change|No, keep planning/.test(p)) return null;
  const opts: DialogOpt[] = [];
  for (const l of p.split('\n')) {
    const m = /^\s*(❯)?\s*(\d)\.\s+(Yes, [^\n]*?|Tell Claude what to change|No, keep planning)\s*$/.exec(l);
    if (m) opts.push(dialogOpt(m));
  }
  return opts.length ? { opts } : null;
}

/**
 * The line /sub-human invite showed in a capture, without its "/sub-human ", or null: "join DEST ROOM SECRET" (DEST
 * an ssh address or pipe:HOME; SECRET the line's 39 characters; then any --via and --home) or "join URL SECRET". The
 * pane may wrap it: a line break (and the next line's indent) inside a word is dropped first. The last one shown wins.
 * The PIN is shown apart from the line: pinIn reads it.
 */
export function joinLineIn(txt: string | null | undefined): string | null {
  const joined = unwrap(txt);
  const re = /\/sub-human (join (?:https?:\/\/\S+|\S+ [a-z]+-\d{4}) [0-9a-z]{39}(?: --(?:via|home) \S+)*)(?=\s|$)/g;
  const all = [...joined.matchAll(re)].map(m => m[1]);
  return all.at(-1) || null;
}

/** The pane may wrap a long word: a line break (and the next line's indent) inside one is dropped. */
const unwrap = (txt: string | null | undefined): string => (txt || '').replace(/([A-Za-z0-9_./:@-])\n[ \t│⎿]*(?=[A-Za-z0-9_./:@-])/g, '$1'); // one wrap, not a blank line

/** The PIN an invite showed apart from its line ("…apart from the line (say it, or send it another way): 4829"). */
export function pinIn(txt: string | null | undefined): string | null {
  const all = [...String(txt || '').replace(/[\s│⎿]+/g, ' ').matchAll(/apart from the line \(say it, or send it another way\): (\d{4})\b/g)].map(m => m[1]);
  return all.at(-1) || null;
}

/**
 * What a join showed in a capture (0.5.0-beta.7: the hooks module answers /sub-human itself): `notices`, the dim
 * "⏺ sub-human: opened room …" / "joined …" / "rejoined …" / "in room …" lines (first line of each, the pane may wrap
 * it), and `frame`, the first hook frame drawn ("blocked by hook", "Operation stopped by hook", "hook error"), or null.
 */
export function joinNotices(txt: string | null | undefined): { notices: string[], frame: string | null } {
  const lines = String(txt || '').split('\n');
  const notices = lines.filter(l => /^\s*⏺ sub-human: (?:opened room|joined |rejoined |in room )/.test(l)).map(l => l.trim());
  const f = lines.find(l => /blocked by hook|stopped by hook|hook error/i.test(l));
  return { notices, frame: f ? f.trim() : null };
}

/** The host's join-request card (lib/remote/admission.ts question), or null: its option lines (Let in / Refuse). */
export function admitCardState(p: string | null | undefined): DialogState | null {
  const lines = String(p || '').split('\n');
  const q = lines.findIndex(l => /Let \S+ \(.*\) on \S+ join room [a-z]+-\d{4}\?|\(admit [0-9a-f]{12}\)/.test(l));
  if (q < 0) return null;
  const opts: DialogOpt[] = [];
  for (const l of lines.slice(q + 1)) {
    if (opts.length >= 4) break;
    const m = /^\s*(❯)?\s*(\d)\.\s+(Let in|Refuse|Type something|Chat about this)\b/.exec(l);
    if (m) opts.push(dialogOpt(m));
  }
  return opts.length ? { opts } : null;
}

