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

/**
 * Who else a room row's text says is here (lib/rows.ts hereText: "bob here", "bob (working), carol here", "a, b, c +2
 * here", "only you"): the names, each without what its presence says ([] for "only you"), or null when the text names
 * nobody. The first such run in the text wins (the hold's line leads with it; the status line may put a join first).
 */
export function hereNames(text: string | null | undefined): string[] | null {
  const t = String(text || '');
  if (/(^|[\s·⎿])only you\b/.test(t)) return [];
  const name = String.raw`[a-z][a-z0-9_-]*(?: \([^)]*\))?`;
  const m = new RegExp(String.raw`(?:^|[\s·⎿])(${name}(?:, ${name})*)(?: \+\d+)? here\b`).exec(t);
  return m ? (m[1] ?? '').split(', ').map(n => n.replace(/ \(.*$/, '')) : null;
}

/**
 * The open room row's view (Enter on the room row; its input box is ruled "─ CODE ─"): the row's own line, the hold's
 * progress (mcp/hold.ts: who else is here, the room's latest, " · read-only · talk in main (@room)"), drawn under the
 * hold call (⎿) above that rule, its wrapped part joined back; null when the view is not open or shows no line.
 */
export function rowViewLine(txt: string | null | undefined, code: string): string | null {
  const lines = String(txt || '').split('\n');
  const rule = lines.findLastIndex(l => l.includes(`─ ${code} ─`) || l.includes(`─ @${code} ─`));
  if (rule < 0) return null;
  const at = lines.slice(0, rule).findLastIndex(l => /^\s*⎿\s+\S/.test(l));
  if (at < 0) return null;
  const out = [(lines[at] ?? '').replace(/^\s*⎿\s+/, '').trim()];
  for (const l of lines.slice(at + 1, rule)) { if (!/^\s{3,}\S/.test(l) || /^\s*[❯⏺⎿─]/.test(l)) break; out.push(l.trim()); }
  return out.join(' ');
}

/**
 * Main's status line for the room (room-chat on: mod/chat.ts rowStatus through $.ui.status, drawn under the prompt box
 * as "⚠ sub-human: CODE · bob (working) here · 2 new"): what follows "CODE · " on the last such line, or null. Feed it
 * to hereNames for who's here.
 */
export function roomStatus(txt: string | null | undefined, code: string): string | null {
  const re = new RegExp(String.raw`^\s*(?:⚠\s+)?(?:sub-human:\s+)?${code.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)} · (.*\S)\s*$`);
  const l = String(txt || '').split('\n').map(x => re.exec(x)).filter((m): m is RegExpExecArray => !!m).at(-1);
  return l ? (l[1] ?? '') : null;
}

/**
 * The panel's rows for room code, judged: one CODE row, and nothing nested in the panel but the row's keeper (room-chat
 * on, drawn "(+1)" on the row and, when listed, a nested keeper row). {ok, why}.
 */
export function oneRoomRow(rows: readonly PanelRow[], code: string): { ok: boolean, why: string } {
  const n = rows.filter(r => r.label === code && !r.nested).length;
  const stray = rows.filter(r => r.nested && !/keeper/i.test(r.label));
  return { ok: n === 1 && stray.length === 0, why: `${n} ${code} row(s)${stray.length ? `, nested ${stray.map(r => r.label).join(',')}` : ''}` };
}

/** A permission mode as a capture's footer shows it ('default': none named). */
export type FooterMode = 'auto' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'default';
/** The permission mode a capture's footer shows, or null when no prompt box is drawn (a dialog over it, no Claude Code). */
export function footerMode(txt: string | null | undefined): FooterMode | null {
  const t = String(txt || '');
  if (/⏵⏵ auto mode on/.test(t)) return 'auto';
  if (/⏵⏵ accept edits on/.test(t)) return 'acceptEdits';
  if (/⏸ plan mode on/.test(t)) return 'plan';
  if (/bypass permissions on/.test(t)) return 'bypassPermissions';
  const ls = t.split('\n');
  const box = ls.some((l, i) => /^\s*❯/.test(l) && i > 0 && /^\s*─{10,}/.test(ls[i - 1] ?? ''));
  return box && !/Would you like to proceed\?|Exit plan mode\?|Esc to cancel/.test(t) ? 'default' : null;
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
 * The line /sub-human invite showed in a capture, without its "/sub-human ", or null: "join LINE#SECRET" in the one
 * line shape (0.6.1: ssh://DEST/ROOM[?home=H|?forward=PORT], https://HOST/…/ROOM, pipe:HOME/ROOM; SECRET the line's 39
 * characters), or an older host's "join DEST ROOM SECRET" (DEST an ssh address or pipe:HOME; then any --home) or
 * "join URL SECRET". The pane may wrap it anywhere, at a space or inside a word (Claude Code hard-wraps,
 * so tmux -J cannot join it): each line break becomes a mark (`markWraps`), the patterns read a mark between two words
 * as their space and one inside a word as nothing, and the words are put back together without it. The last one
 * shown wins.
 * The plugin shows it one of three ways (lib/remote/hosting.ts invitePinned and inviteText, mod/core/command.ts pinFor):
 *   whole on the status line under the prompt: "⚠ sub-human: PIN 8238 · /sub-human join ssh://DEST/ROOM#SECRET"
 *   cut, when the terminal is narrower: the notice shows the line with the word SECRET in its place, and the status
 *     line "⚠ sub-human: PIN 8238 · SECRET <word>": the two are put back together here
 *   in the text, without the hooks module (and `sub-human invite` in a terminal): "  /sub-human join …"
 * The PIN is shown apart from the line: pinIn reads it.
 */
export function joinLineIn(txt: string | null | undefined): string | null {
  const marked = markWraps(txt);
  const any = String.raw`[^\s\x1f]`; // a character of a word (\S, less the mark)
  // the one line shape: a scheme, then everything up to the SECRET's # (an older web line's space)
  const url = `(?:${lit('http')}(?:${IN}s)?${IN}${lit('://')}|${lit('ssh://')}|${lit('pipe:')})${IN}${word(String.raw`[^\s#\x1f]`)}`;
  const room = `${word('[a-z]')}${IN}-${IN}${count(String.raw`\d`, 4)}`;
  const head = `${lit('/sub-human')}${SP}${lit('join')}${SP}(?:(?<url>${url})(?<hash>${IN}#${IN}|${SP})|(?<dest>${word(any)})${SP}(?<room>${room})${SP})`; // a web line's SECRET: its URL's fragment
  const tail = `(?:${SP}${lit('--home')}${SP}(?<home>${word(any)}))?${END}`;
  const line = (g: Record<string, string | undefined> | undefined, secret: string): string => {
    const at = g?.url ? `${unmark(g.url)}${g.hash?.includes('#') ? '#' : ' '}` : `${unmark(g?.dest)} ${unmark(g?.room)} `;
    return `join ${at}${secret}${g?.home ? ` --home ${unmark(g.home)}` : ''}`;
  };
  const shown: { at: number, line: string }[] = [];
  for (const m of marked.matchAll(new RegExp(`${head}(?<secret>${SECRET})${tail}`, 'g'))) shown.push({ at: m.index, line: line(m.groups, unmark(m.groups?.secret)) });
  // the cut form: the line with SECRET in the word's place, and the word on the status line
  const status = new RegExp(String.raw`\b${lit('PIN')}${SP}${count(String.raw`\d`, 4)}${SP}·${SP}${lit('SECRET')}${SP}(?<secret>${SECRET})${END}`, 'g');
  const secret = unmark([...marked.matchAll(status)].at(-1)?.groups?.secret);
  if (secret) for (const m of marked.matchAll(new RegExp(`${head}${lit('SECRET')}${tail}`, 'g'))) shown.push({ at: m.index, line: line(m.groups, secret) });
  return shown.sort((a, b) => a.at - b.at).at(-1)?.line || null;
}

/** What markWraps puts for one line break: the line's trailing blanks, the break and the next line's indent. */
const WRAP = '\x1f';
/**
 * In a pattern: a space between two words (or the break it became); a break inside a word (or none), only before a
 * character a word goes on with (not the next row's ⏺); a word's end.
 */
const SP = String.raw`[ \x1f]`, IN = String.raw`(?:\x1f(?=[\w./:@~#?=&-]))?`, END = String.raw`(?=[\s\x1f]|$)`;
/** `s` as typed, a break allowed between any two of its characters. */
const lit = (s: string): string => s.split('').map(c => c.replace(/[\\^$.*+?()[\]{}|/-]/g, String.raw`\$&`)).join(IN);
/** One or more characters of class `c`, and exactly `n` of them, a break allowed between any two. */
const word = (c: string): string => `${c}(?:${IN}${c})*`;
const count = (c: string, n: number): string => Array<string>(n).fill(c).join(IN);
/** The line's SECRET word: 39 characters of Crockford base32, as shown (lowercase). */
const SECRET = count('[0-9a-z]', 39);
/** Each line break as one mark: one wrap, not a blank line (that is two marks, which no pattern reads). */
const markWraps = (txt: string | null | undefined): string => (txt || '').replace(/[ \t]*\n[ \t│⎿]*/g, WRAP);
const unmark = (s: string | undefined): string => (s ?? '').replaceAll(WRAP, '');

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
 * "⏺ sub-human: Opened …" / "Joined …" / "Rejoined …" lines (before 0.6.0 "opened room …", "joined …", "in room …") (first line of each, the pane may wrap
 * it), and `frame`, the first hook frame drawn ("blocked by hook", "Operation stopped by hook", "hook error"), or null.
 */
export function joinNotices(txt: string | null | undefined): { notices: string[], frame: string | null } {
  const lines = String(txt || '').split('\n');
  const notices = lines.filter(l => /^\s*⏺ sub-human: (?:opened room|joined |rejoined |in room |Opened |Joined |Rejoined )/.test(l)).map(l => l.trim());
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

