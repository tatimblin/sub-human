#!/usr/bin/env node
'use strict';
/**
 * ansi-svg: render terminal text with ANSI SGR escapes (as produced by `tmux capture-pane -ep`)
 * into a self-contained monospace SVG with a dark terminal frame and a window title.
 *
 * Supports: 16/256/truecolor fg+bg (`;` and `:` forms), bold, dim, italic, underline, strike,
 * inverse, resets; other CSI/OSC/charset escapes are dropped. Wide chars (CJK, emoji) take two
 * cells, combining marks / ZWJ / variation selectors take zero. The SVG uses no element ids, so
 * many can be inlined into one HTML page.
 *
 *   const { render } = require('./ansi-svg.js'); render(text, { title: 'orch' }) -> '<svg …>'
 *   tmux capture-pane -ep -t S | node scripts/ansi-svg.js --title "orch" [--cols 120] [--rows 40] > out.svg
 */

const THEME = {
  fg: '#d6dbe5', bg: '#16181d', frame: '#2a2d35', bar: '#22252c', titleFg: '#9aa1ad', border: '#3a3e48',
  // 0-7 normal, 8-15 bright
  ansi: ['#1d1f24', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#c8ccd4',
         '#5c6370', '#ff7a85', '#b5e890', '#ffd68a', '#82c4ff', '#de9cf0', '#7fd8e3', '#ffffff'],
};

function color256(n, theme = THEME) {
  if (n < 16) return theme.ansi[n];
  if (n < 232) {
    n -= 16;
    const lv = [0, 95, 135, 175, 215, 255];
    return hex(lv[Math.floor(n / 36)], lv[Math.floor(n / 6) % 6], lv[n % 6]);
  }
  const g = 8 + (n - 232) * 10;
  return hex(g, g, g);
}
function hex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('');
}

/** Terminal cell width of a code point: 0, 1 or 2 (a wcwidth approximation). */
function charWidth(cp) {
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
      (cp >= 0x1f004 && cp <= 0x1f004) || cp === 0x1f0cf || cp === 0x1f18e || (cp >= 0x1f191 && cp <= 0x1f19a) ||
      (cp >= 0x1f200 && cp <= 0x1f251) || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f680 && cp <= 0x1f6ff) ||
      (cp >= 0x1f7e0 && cp <= 0x1f7eb) || (cp >= 0x1f90c && cp <= 0x1f9ff) || (cp >= 0x1fa70 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x2fffd) || (cp >= 0x30000 && cp <= 0x3fffd)) return 2;
  return 1;
}

function defaultStyle() {
  return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, strike: false, inverse: false };
}

/** Apply one SGR parameter list (array of strings, possibly with ':' sub-params) to style s. */
function applySgr(s, params, theme = THEME) {
  if (params.length === 0) params = ['0'];
  for (let i = 0; i < params.length; i++) {
    const raw = params[i];
    const sub = raw.includes(':') ? raw.split(':') : null;
    const p = parseInt(sub ? sub[0] : raw, 10) || 0;
    if (p === 38 || p === 48 || p === 58) {
      let col = null;
      if (sub) {
        // 38:5:n  |  38:2:r:g:b  |  38:2::r:g:b (with colorspace id)
        if (sub[1] === '5') col = color256(+sub[2] || 0, theme);
        else if (sub[1] === '2') {
          const v = sub.length >= 6 ? sub.slice(3, 6) : sub.slice(2, 5);
          col = hex(+v[0] || 0, +v[1] || 0, +v[2] || 0);
        }
      } else if (params[i + 1] === '5') {
        col = color256(+params[i + 2] || 0, theme); i += 2;
      } else if (params[i + 1] === '2') {
        col = hex(+params[i + 2] || 0, +params[i + 3] || 0, +params[i + 4] || 0); i += 4;
      }
      if (p === 38) s.fg = col; else if (p === 48) s.bg = col;
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

/**
 * Parse ANSI text into rows of cells: [{ch, w, style}], w = 1 or 2. A wide char's second
 * column is represented by nothing (the next cell starts two columns later); `col` is stored.
 */
function parse(text, theme = THEME) {
  const rows = [];
  let row = [];
  let col = 0;
  const s = defaultStyle();
  const str = String(text).replace(/\r\n/g, '\n');
  let i = 0;
  while (i < str.length) {
    const c = str[i];
    if (c === '\x1b') {
      const n = str[i + 1];
      if (n === '[') { // CSI
        let j = i + 2;
        while (j < str.length && !(str.charCodeAt(j) >= 0x40 && str.charCodeAt(j) <= 0x7e)) j++;
        const fin = str[j];
        const body = str.slice(i + 2, j);
        if (fin === 'm' && !/[<=>?]/.test(body)) applySgr(s, body === '' ? [] : body.split(';'), theme);
        i = j + 1; continue;
      }
      if (n === ']' || n === 'P' || n === '_' || n === '^') { // OSC/DCS/APC/PM: until BEL or ST
        let j = i + 2;
        while (j < str.length && str[j] !== '\x07' && !(str[j] === '\x1b' && str[j + 1] === '\\')) j++;
        i = str[j] === '\x07' ? j + 1 : j + 2; continue;
      }
      if (n === '(' || n === ')' || n === '*' || n === '+' || n === '#') { i += 3; continue; }
      i += 2; continue;
    }
    if (c === '\n') { rows.push(row); row = []; col = 0; i++; continue; }
    if (c === '\t') { const to = (Math.floor(col / 8) + 1) * 8; while (col < to) { row.push({ ch: ' ', w: 1, col, style: { ...s } }); col++; } i++; continue; }
    const cp = str.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    const w = charWidth(cp);
    if (w === 0) {
      if (cp >= 32 && row.length) row[row.length - 1].ch += ch; // attach combining/ZWJ/VS to previous cell
      continue;
    }
    row.push({ ch, w, col, style: { ...s } });
    col += w;
  }
  if (row.length || !str.endsWith('\n')) rows.push(row);
  return rows;
}

function esc(t) {
  return t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    // XML 1.0 forbids most C0 controls
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function resolved(style, theme) {
  let fg = style.fg || theme.fg;
  let bg = style.bg;
  if (style.inverse) { const f = fg; fg = bg || theme.bg; bg = f; }
  return { fg, bg };
}

function sameStyle(a, b) {
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim && a.italic === b.italic &&
    a.underline === b.underline && a.strike === b.strike && a.inverse === b.inverse;
}

/**
 * Render ANSI text to an SVG string.
 * opts: title, cols, rows (defaults: content size), fontSize (13), trim (drop trailing blank rows),
 *       theme, fontFamily.
 */
function render(text, opts = {}) {
  const theme = opts.theme || THEME;
  let rows = parse(text, theme);
  // tmux capture ends each line with \n: drop the final empty row it produces
  if (rows.length && rows[rows.length - 1].length === 0 && String(text).endsWith('\n')) rows.pop();
  if (opts.trim) while (rows.length && rows[rows.length - 1].every(c => c.ch.trim() === '' && !c.style.bg && !c.style.inverse)) rows.pop();
  if (opts.rows && rows.length > opts.rows) rows = rows.slice(rows.length - opts.rows);
  const contentCols = rows.reduce((m, r) => Math.max(m, r.length ? r[r.length - 1].col + r[r.length - 1].w : 0), 0);
  const cols = Math.max(opts.cols || 0, contentCols, 20);
  const nrows = Math.max(opts.rows || 0, rows.length, 1);
  const fs = opts.fontSize || 13;
  const cw = +(fs * 0.6).toFixed(2);
  const lh = Math.round(fs * 1.3);
  const pad = 12;
  const bar = 30;
  const W = Math.ceil(cols * cw + pad * 2);
  const H = Math.ceil(nrows * lh + pad * 2 + bar);
  const font = opts.fontFamily || "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace";
  const title = opts.title == null ? '' : String(opts.title);

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(title || 'terminal')}" font-family="${esc(font)}" font-size="${fs}">`);
  out.push(`<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="9" fill="${theme.bg}" stroke="${theme.border}"/>`);
  out.push(`<path d="M0.5 ${bar}V9.5a9 9 0 0 1 9-9h${W - 19}a9 9 0 0 1 9 9V${bar}z" fill="${theme.bar}"/>`);
  out.push(`<line x1="0.5" y1="${bar}" x2="${W - 0.5}" y2="${bar}" stroke="${theme.border}"/>`);
  ['#ff5f57', '#febc2e', '#28c840'].forEach((c, k) => out.push(`<circle cx="${16 + k * 18}" cy="${bar / 2}" r="5.5" fill="${c}"/>`));
  if (title) out.push(`<text x="${W / 2}" y="${bar / 2 + 4}" text-anchor="middle" fill="${theme.titleFg}" font-size="${fs - 1}" font-family="-apple-system, 'Segoe UI', system-ui, sans-serif">${esc(title)}</text>`);

  const bgs = [];
  const texts = [];
  rows.forEach((r, y) => {
    const baseY = bar + pad + y * lh;
    // group runs of identical style; wide chars and non-ASCII get their own positioned run
    let run = null;
    const flush = () => {
      if (!run) return;
      const st = run.style;
      const { fg, bg } = resolved(st, theme);
      const x = +(pad + run.col * cw).toFixed(2);
      const wpx = +(run.cells * cw).toFixed(2);
      if (bg) bgs.push(`<rect x="${x}" y="${baseY}" width="${wpx}" height="${lh}" fill="${bg}"/>`);
      const txt = run.text;
      if (txt.trim() !== '') {
        const attrs = [`x="${x}"`, `y="${baseY + Math.round(lh * 0.77)}"`];
        if (fg !== theme.fg) attrs.push(`fill="${fg}"`);
        if (st.bold) attrs.push('font-weight="bold"');
        if (st.italic) attrs.push('font-style="italic"');
        if (st.dim) attrs.push('opacity="0.6"');
        const deco = [st.underline && 'underline', st.strike && 'line-through'].filter(Boolean).join(' ');
        if (deco) attrs.push(`text-decoration="${deco}"`);
        // pin every run to its cell width: the viewer's monospace font rarely advances exactly 0.6em,
        // and drift across a 120-col line misplaces highlights. ASCII runs adjust spacing only.
        if (run.fit) attrs.push(`textLength="${wpx}" lengthAdjust="spacingAndGlyphs"`);
        else if (run.cells > 1) attrs.push(`textLength="${wpx}" lengthAdjust="spacing"`);
        texts.push(`<text ${attrs.join(' ')} xml:space="preserve">${esc(txt)}</text>`);
      } else if (st.underline || st.strike) {
        texts.push(`<line x1="${x}" x2="${x + wpx}" y1="${baseY + lh - 3}" y2="${baseY + lh - 3}" stroke="${fg}"/>`);
      }
      run = null;
    };
    for (const cell of r) {
      const ascii = /^[\x20-\x7e]$/.test(cell.ch);
      const solo = cell.w === 2;
      if (run && (solo || run.solo || !sameStyle(run.style, cell.style) || run.col + run.cells !== cell.col)) flush();
      if (!run) run = { col: cell.col, cells: 0, text: '', style: cell.style, solo, fit: false };
      if (!ascii) run.fit = true; // non-ASCII glyphs may not be one cell wide in the font: pin the run width
      run.text += cell.ch;
      run.cells += cell.w;
    }
    flush();
  });
  out.push(`<g fill="${theme.fg}">`);
  out.push(...bgs, ...texts);
  out.push('</g></svg>');
  return out.join('\n') + '\n';
}

module.exports = { render, parse, charWidth, applySgr, color256, THEME };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--title') opts.title = args[++i];
    else if (a === '--cols') opts.cols = +args[++i];
    else if (a === '--rows') opts.rows = +args[++i];
    else if (a === '--font-size') opts.fontSize = +args[++i];
    else if (a === '--trim') opts.trim = true;
    else if (a === '-h' || a === '--help') {
      process.stdout.write('usage: tmux capture-pane -ep -t S | ansi-svg.js [--title T] [--cols N] [--rows N] [--font-size N] [--trim] > out.svg\n');
      process.exit(0);
    }
  }
  const chunks = [];
  process.stdin.on('data', d => chunks.push(d));
  process.stdin.on('end', () => process.stdout.write(render(Buffer.concat(chunks).toString('utf8'), opts)));
}
