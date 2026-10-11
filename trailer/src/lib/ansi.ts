/**
 * ANSI (as `tmux capture-pane -ep` writes it) -> rows of styled runs. A TypeScript port of the cell logic
 * in ../../../scripts/ansi-svg.js (THEME, color256, charWidth, applySgr, parse, resolved), so the trailer's
 * terminals carry the same colours and the same cell grid as the walkthrough's SVGs. Keep the two in step.
 */

export const THEME = {
  fg: '#d6dbe5',
  bg: '#16181d',
  frame: '#2a2d35',
  bar: '#22252c',
  titleFg: '#9aa1ad',
  border: '#3a3e48',
  // 0-7 normal, 8-15 bright
  ansi: ['#1d1f24', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#c8ccd4',
    '#5c6370', '#ff7a85', '#b5e890', '#ffd68a', '#82c4ff', '#de9cf0', '#7fd8e3', '#ffffff'],
};
export type Theme = typeof THEME;

export type Style = {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  inverse: boolean;
};

export type Cell = { ch: string; w: number; col: number; style: Style };

const hex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('');

export function color256(n: number, theme: Theme = THEME): string {
  if (n < 16) return theme.ansi[n];
  if (n < 232) {
    n -= 16;
    const lv = [0, 95, 135, 175, 215, 255];
    return hex(lv[Math.floor(n / 36)], lv[Math.floor(n / 6) % 6], lv[n % 6]);
  }
  const g = 8 + (n - 232) * 10;
  return hex(g, g, g);
}

/** Terminal cell width of a code point: 0, 1 or 2 (the same wcwidth approximation as ansi-svg.js). */
export function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) || (cp >= 0xfe20 && cp <= 0xfe2f) || cp === 0x200b || cp === 0x200c ||
    cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef) ||
    (cp >= 0x1f3fb && cp <= 0x1f3ff)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x231a && cp <= 0x231b) || (cp >= 0x23e9 && cp <= 0x23ec) || cp === 0x23f0 || cp === 0x23f3 ||
    (cp >= 0x25fd && cp <= 0x25fe) || (cp >= 0x2614 && cp <= 0x2615) || (cp >= 0x2648 && cp <= 0x2653) ||
    cp === 0x267f || cp === 0x2693 || cp === 0x26a1 || (cp >= 0x26aa && cp <= 0x26ab) ||
    (cp >= 0x26bd && cp <= 0x26be) || (cp >= 0x26c4 && cp <= 0x26c5) || cp === 0x26ce || cp === 0x26d4 ||
    cp === 0x26ea || (cp >= 0x26f2 && cp <= 0x26f3) || cp === 0x26f5 || cp === 0x26fa || cp === 0x26fd ||
    cp === 0x2705 || (cp >= 0x270a && cp <= 0x270b) || cp === 0x2728 || cp === 0x274c || cp === 0x274e ||
    (cp >= 0x2753 && cp <= 0x2755) || cp === 0x2757 || (cp >= 0x2795 && cp <= 0x2797) || cp === 0x27b0 ||
    cp === 0x27bf || (cp >= 0x2b1b && cp <= 0x2b1c) || cp === 0x2b50 || cp === 0x2b55 ||
    (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff) || (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf) || (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
    cp === 0x1f004 || cp === 0x1f0cf || cp === 0x1f18e || (cp >= 0x1f191 && cp <= 0x1f19a) ||
    (cp >= 0x1f200 && cp <= 0x1f251) || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f7e0 && cp <= 0x1f7eb) || (cp >= 0x1f90c && cp <= 0x1f9ff) || (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x2fffd) || (cp >= 0x30000 && cp <= 0x3fffd)) return 2;
  return 1;
}

export const defaultStyle = (): Style => ({
  fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, strike: false, inverse: false,
});

/** Apply one SGR parameter list (strings, possibly with ':' sub-params) to style s. */
export function applySgr(s: Style, params: string[], theme: Theme = THEME): Style {
  if (params.length === 0) params = ['0'];
  for (let i = 0; i < params.length; i++) {
    const raw = params[i];
    const sub = raw.includes(':') ? raw.split(':') : null;
    const p = parseInt(sub ? sub[0] : raw, 10) || 0;
    if (p === 38 || p === 48 || p === 58) {
      let col: string | null = null;
      if (sub) {
        if (sub[1] === '5') col = color256(+sub[2] || 0, theme);
        else if (sub[1] === '2') {
          const v = sub.length >= 6 ? sub.slice(3, 6) : sub.slice(2, 5);
          col = hex(+v[0] || 0, +v[1] || 0, +v[2] || 0);
        }
      } else if (params[i + 1] === '5') {
        col = color256(+params[i + 2] || 0, theme);
        i += 2;
      } else if (params[i + 1] === '2') {
        col = hex(+params[i + 2] || 0, +params[i + 3] || 0, +params[i + 4] || 0);
        i += 4;
      }
      if (p === 38) s.fg = col;
      else if (p === 48) s.bg = col;
      continue;
    }
    if (p === 0) Object.assign(s, defaultStyle());
    else if (p === 1) s.bold = true;
    else if (p === 2) s.dim = true;
    else if (p === 3) s.italic = true;
    else if (p === 4) s.underline = !(sub && sub[1] === '0');
    else if (p === 7) s.inverse = true;
    else if (p === 9) s.strike = true;
    else if (p === 21) s.underline = true;
    else if (p === 22) { s.bold = false; s.dim = false; }
    else if (p === 23) s.italic = false;
    else if (p === 24) s.underline = false;
    else if (p === 27) s.inverse = false;
    else if (p === 29) s.strike = false;
    else if (p >= 30 && p <= 37) s.fg = theme.ansi[p - 30];
    else if (p === 39) s.fg = null;
    else if (p >= 40 && p <= 47) s.bg = theme.ansi[p - 40];
    else if (p === 49) s.bg = null;
    else if (p >= 90 && p <= 97) s.fg = theme.ansi[p - 90 + 8];
    else if (p >= 100 && p <= 107) s.bg = theme.ansi[p - 100 + 8];
  }
  return s;
}

/** ANSI text -> rows of cells; a wide char's second column is implied by w = 2. */
export function parse(text: string, theme: Theme = THEME): Cell[][] {
  const rows: Cell[][] = [];
  let row: Cell[] = [];
  let col = 0;
  const s = defaultStyle();
  const str = String(text).replace(/\r\n/g, '\n');
  let i = 0;
  while (i < str.length) {
    const c = str[i];
    if (c === '\x1b') {
      const n = str[i + 1];
      if (n === '[') {
        let j = i + 2;
        while (j < str.length && !(str.charCodeAt(j) >= 0x40 && str.charCodeAt(j) <= 0x7e)) j++;
        const fin = str[j];
        const body = str.slice(i + 2, j);
        if (fin === 'm' && !/[<=>?]/.test(body)) applySgr(s, body === '' ? [] : body.split(';'), theme);
        i = j + 1;
        continue;
      }
      if (n === ']' || n === 'P' || n === '_' || n === '^') {
        let j = i + 2;
        while (j < str.length && str[j] !== '\x07' && !(str[j] === '\x1b' && str[j + 1] === '\\')) j++;
        i = str[j] === '\x07' ? j + 1 : j + 2;
        continue;
      }
      if (n === '(' || n === ')' || n === '*' || n === '+' || n === '#') { i += 3; continue; }
      i += 2;
      continue;
    }
    if (c === '\n') { rows.push(row); row = []; col = 0; i++; continue; }
    if (c === '\t') {
      const to = (Math.floor(col / 8) + 1) * 8;
      while (col < to) { row.push({ ch: ' ', w: 1, col, style: { ...s } }); col++; }
      i++;
      continue;
    }
    const cp = str.codePointAt(i) as number;
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    const w = charWidth(cp);
    if (w === 0) {
      if (cp >= 32 && row.length) row[row.length - 1].ch += ch;
      continue;
    }
    row.push({ ch, w, col, style: { ...s } });
    col += w;
  }
  if (row.length || !str.endsWith('\n')) rows.push(row);
  return rows;
}

export function resolved(style: Style, theme: Theme = THEME): { fg: string; bg: string | null } {
  let fg = style.fg || theme.fg;
  let bg = style.bg;
  if (style.inverse) {
    const f = fg;
    fg = bg || theme.bg;
    bg = f;
  }
  return { fg, bg };
}

const sameStyle = (a: Style, b: Style) =>
  a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim && a.italic === b.italic &&
  a.underline === b.underline && a.strike === b.strike && a.inverse === b.inverse;

/**
 * A run of cells drawn as one span: same style, contiguous columns. `solo` runs hold one glyph that may not
 * advance exactly one cell in the bundled mono font (wide chars, symbols drawn by a fallback font), so the
 * renderer pins it to its cell box, as ansi-svg.js pins such runs with textLength.
 */
export type Run = { col: number; cells: number; text: string; style: Style; solo: boolean };

// JetBrains Mono draws ASCII, Latin-1, general punctuation, arrows, box drawing and block elements at exactly
// one cell; everything else from U+2190 up may come from a fallback font.
const inMono = (cp: number) => cp < 0x2190 || (cp >= 0x2500 && cp <= 0x259f);

export function runs(row: Cell[], theme: Theme = THEME): Run[] {
  // drop trailing blank, unstyled cells (rowsHtml's right trim)
  let end = row.length;
  while (end > 0 && row[end - 1].ch.trim() === '' && !resolved(row[end - 1].style, theme).bg && !row[end - 1].style.underline) end--;
  const out: Run[] = [];
  let run: Run | null = null;
  for (let i = 0; i < end; i++) {
    const cell = row[i];
    const cp = cell.ch.codePointAt(0) as number;
    const solo = cell.w === 2 || !inMono(cp) || cell.ch.length > (cp > 0xffff ? 2 : 1);
    if (run && (solo || run.solo || !sameStyle(run.style, cell.style) || run.col + run.cells !== cell.col)) {
      out.push(run);
      run = null;
    }
    if (!run) run = { col: cell.col, cells: 0, text: '', style: cell.style, solo };
    run.text += cell.ch;
    run.cells += cell.w;
  }
  if (run) out.push(run);
  return out;
}

// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[[0-9;:<=>?]*[@-~]/g;
/** ANSI text without its CSI sequences. */
export const stripAnsi = (s: string) => s.replace(SGR, '');

/** The plain text of a row (right-trimmed): for searching screens. */
export const rowText = (row: Cell[]) => row.map((c) => c.ch).join('').replace(/\s+$/, '');

/** ANSI screen -> parsed rows, padded/cut to `rows` (tmux ends each line with \n: the final empty row drops). */
export function screenRows(text: string, rows?: number, theme: Theme = THEME): Cell[][] {
  const r = parse(text, theme);
  if (r.length && r[r.length - 1].length === 0 && text.endsWith('\n')) r.pop();
  if (rows != null) {
    while (r.length < rows) r.push([]);
    if (r.length > rows) r.splice(0, r.length - rows);
  }
  return r;
}
