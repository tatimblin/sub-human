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

/** The plan-approval dialog a room review opens in (hooks/consent.ts), or null: its option lines. */
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
 * an ssh address or pipe:HOME; SECRET the line's 39 characters; then any --home) or "join URL SECRET". The
 * pane may wrap it: a line break (and the next line's indent) inside a word is dropped first. The last one shown wins.
 * The plugin shows it one of three ways (lib/remote/hosting.ts invitePinned and inviteText, mod/core/command.ts pinFor):
 *   whole on the status line under the prompt: "⚠ sub-human: PIN 8238 · /sub-human join DEST ROOM SECRET"
 *   cut, when the terminal is narrower: the notice shows the line with the word SECRET in its place, and the status
 *     line "⚠ sub-human: PIN 8238 · SECRET <word>": the two are put back together here
 *   in the text, without the hooks module (and `sub-human invite` in a terminal): "  /sub-human join …"
 * The PIN is shown apart from the line: pinIn reads it.
 */
export function joinLineIn(txt: string | null | undefined): string | null {
  const joined = unwrap(txt);
  const head = String.raw`\/sub-human (join (?:https?:\/\/\S+|\S+ [a-z]+-\d{4}) )`;
  const tail = String.raw`((?: --home \S+)?)(?=\s|$)`;
  const shown: { at: number, line: string }[] = [];
  for (const m of joined.matchAll(new RegExp(`${head}([0-9a-z]{39})${tail}`, 'g'))) shown.push({ at: m.index, line: `${m[1]}${m[2]}${m[3]}` });
  // the cut form: the line with SECRET in the word's place, and the word on the status line
  const word = [...joined.matchAll(/\bPIN \d{4} · SECRET ([0-9a-z]{39})(?=\s|$)/g)].at(-1)?.[1];
  if (word) for (const m of joined.matchAll(new RegExp(`${head}SECRET${tail}`, 'g'))) shown.push({ at: m.index, line: `${m[1]}${word}${m[2]}` });
  return shown.sort((a, b) => a.at - b.at).at(-1)?.line || null;
}

/** The pane may wrap a long word: a line break (and the next line's indent) inside one is dropped. */
const unwrap = (txt: string | null | undefined): string => (txt || '').replace(/([A-Za-z0-9_./:@-])\n[ \t│⎿]*(?=[A-Za-z0-9_./:@-])/g, '$1'); // one wrap, not a blank line

/**
 * The PIN an invite showed apart from its line: on the status line ("PIN 4829 · /sub-human join …" or, cut,
 * "PIN 4829 · SECRET <word>": lib/remote/hosting.ts invitePinned) or, without the hooks module, in the text
 * ("…apart from the line (say it, or send it another way): 4829"). The last one shown wins.
 */
export function pinIn(txt: string | null | undefined): string | null {
  const flat = String(txt || '').replace(/[\s│⎿]+/g, ' ');
  const re = /\bPIN (\d{4}) · (?:\/sub-human join |SECRET )|apart from the line \(say it, or send it another way\): (\d{4})\b/g;
  const all = [...flat.matchAll(re)].map(m => m[1] ?? m[2]);
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

