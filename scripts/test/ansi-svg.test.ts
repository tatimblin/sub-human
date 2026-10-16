import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { render, renderHtml, rowsHtml, palette, parse, charWidth, color256, THEME } from '../ansi-svg.ts';

const E = '\x1b[';

test('charWidth: ascii, box drawing, CJK, emoji, combining', () => {
  assert.equal(charWidth('a'.codePointAt(0) ?? 0), 1);
  assert.equal(charWidth('─'.codePointAt(0) ?? 0), 1);
  assert.equal(charWidth('❯'.codePointAt(0) ?? 0), 1);
  assert.equal(charWidth('⬡'.codePointAt(0) ?? 0), 1);
  assert.equal(charWidth('日'.codePointAt(0) ?? 0), 2);
  assert.equal(charWidth('😀'.codePointAt(0) ?? 0), 2);
  assert.equal(charWidth('✅'.codePointAt(0) ?? 0), 2);
  assert.equal(charWidth(0x301), 0);
  assert.equal(charWidth(0x200d), 0);
  assert.equal(charWidth(0xfe0f), 0);
});

test('parse: 16 colors, bold, reset, columns', () => {
  const rows = parse(`${E}1m${E}31mab${E}0mc\n`);
  assert.equal(rows[0].length, 3);
  assert.equal(rows[0][0].style.fg, THEME.ansi[1]);
  assert.equal(rows[0][0].style.bold, true);
  assert.equal(rows[0][2].style.fg, null);
  assert.equal(rows[0][2].style.bold, false);
  assert.deepEqual(rows[0].map(c => c.col), [0, 1, 2]);
});

test('parse: 256 and truecolor fg/bg, semicolon and colon forms, 39/49', () => {
  const rows = parse(`${E}38;5;208mA${E}48;2;10;20;30mB${E}39;49mC${E}38:2::1:2:3mD${E}38:5:21mE${E}90mF${E}101mG`);
  const [a, b, c, d, e, f, g] = rows[0];
  assert.equal(a.style.fg, color256(208));
  assert.equal(b.style.bg, '#0a141e');
  assert.equal(b.style.fg, color256(208));
  assert.equal(c.style.fg, null); assert.equal(c.style.bg, null);
  assert.equal(d.style.fg, '#010203');
  assert.equal(e.style.fg, color256(21));
  assert.equal(f.style.fg, THEME.ansi[8]);
  assert.equal(g.style.bg, THEME.ansi[9]);
});

test('color256: cube and grayscale', () => {
  assert.equal(color256(16), '#000000');
  assert.equal(color256(231), '#ffffff');
  assert.equal(color256(196), '#ff0000');
  assert.equal(color256(232), '#080808');
  assert.equal(color256(255), '#eeeeee');
});

test('parse: dim, italic, underline, inverse, strike and their resets', () => {
  const [r] = parse(`${E}2;3;4;7;9mx${E}22;23;24;27;29my`);
  assert.deepEqual([r[0].style.dim, r[0].style.italic, r[0].style.underline, r[0].style.inverse, r[0].style.strike], [true, true, true, true, true]);
  assert.deepEqual([r[1].style.dim, r[1].style.italic, r[1].style.underline, r[1].style.inverse, r[1].style.strike], [false, false, false, false, false]);
});

test('parse: wide chars take two columns; combining marks attach', () => {
  const [r] = parse('a日b😀c é');
  assert.deepEqual(r.map(c => c.col), [0, 1, 3, 4, 6, 7, 8]);
  assert.equal(r[6].ch, 'é');
});

test('parse: other escapes (cursor CSI, OSC hyperlink, charset) are dropped', () => {
  const [r] = parse(`${E}2K${E}?25l\x1b]8;;https://x.y\x07link\x1b]8;;\x1b\\\x1b(Bok`);
  assert.equal(r.map(c => c.ch).join(''), 'linkok');
});

test('render: valid-looking svg with title, colors, escaped text, no ids', () => {
  const svg = render(`${E}1;32m✓ posted <ok> & "q"${E}0m\n${E}7minv${E}0m ┌─┐ 日本\n`, { title: 'alice · S4' });
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 \d+ \d+"/);
  assert.match(svg, /alice · S4<\/text>/);
  assert.match(svg, /fill="#98c379" font-weight="bold"/);
  assert.match(svg, /&lt;ok&gt; &amp; &quot;q&quot;/);
  assert.doesNotMatch(svg, /\sid="/);
  // inverse: default fg becomes a background rect
  assert.match(svg, new RegExp(`<rect [^>]*fill="${THEME.fg}"/>`));
  // wide char run is pinned to two cells
  assert.match(svg, /textLength="15.6" lengthAdjust="spacingAndGlyphs"[^>]*>日<\/text>/);
  assert.equal((svg.match(/<svg/g) || []).length, 1);
  assert.ok(svg.trim().endsWith('</svg>'));
});

test('render: size follows cols/rows options and content', () => {
  const small = render('hi\n', { cols: 40, rows: 5 });
  const big = render('hi\n', { cols: 120, rows: 40 });
  const dims = (s: string): number[] => (s.match(/viewBox="0 0 (\d+) (\d+)"/) ?? []).slice(1).map(Number);
  assert.ok(dims(big)[0] > dims(small)[0] * 2);
  assert.ok(dims(big)[1] > dims(small)[1] * 4);
  const long = render('x'.repeat(200) + '\n', { cols: 80 });
  assert.ok(dims(long)[0] >= 200 * 13 * 0.6);
});

test('render: trim drops trailing blank rows; control chars are not emitted', () => {
  const a = render('a\n\n\n\n', { trim: true });
  const b = render('a\n\n\n\n');
  const h = (s: string): number => +((s.match(/viewBox="0 0 \d+ (\d+)"/) ?? [])[1] ?? NaN);
  assert.ok(h(a) < h(b));
  assert.doesNotMatch(render('a\x01b\x08c\n'), /[\x01\x08]/);
});

test('renderHtml: escapes & < >, shares classes across calls, bare default text, right-trimmed', () => {
  const pal = palette();
  const a = renderHtml(`${E}31mred <b> & "q"${E}0m plain   \n${E}1;31mbold red${E}0m\n\n`, { title: 'bob <x>', palette: pal });
  const b = renderHtml(`${E}31magain${E}0m ${E}7minv${E}0m\n`, { palette: pal });
  assert.equal(a, '<figure class="term"><figcaption>bob &lt;x&gt;</figcaption><pre><i class=a>red &lt;b&gt; &amp; "q" </i>plain\n<i class=b>bold red</i></pre></figure>');
  assert.match(b, /<i class=a>again <\/i><i class=c>inv<\/i>/, 'same style, same class across excerpts');
  assert.equal(pal.size(), 3);
  const css = pal.css('.term');
  assert.match(css, /\.term i\.a\{color:#e06c75\}/);
  assert.match(css, /\.term i\.b\{color:#e06c75;font-weight:700\}/);
  assert.match(css, new RegExp(`\\.term i\\.c\\{color:${THEME.bg};background:${THEME.fg}\\}`));
  assert.doesNotMatch(pal.css('.term', new Set(['a'])), /i\.b/, 'css limited to used classes');
  assert.doesNotMatch(a + b, /<svg|\x1b/);
});

test('rowsHtml: raw line, plain text and html per row; spaces join a run', () => {
  const rows = rowsHtml(`${E}32mok go${E}0m  \n${E}38;5;196mstop${E}0m\n`);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.text), ['ok go', 'stop']);
  assert.equal(rows[0].html, '<i class=a>ok go</i>');
  assert.equal(rows[1].raw, `${E}38;5;196mstop${E}0m`);
});

test('CLI: stdin to stdout', () => {
  const out = execFileSync(process.execPath, [path.join(import.meta.dirname, '..', 'ansi-svg.ts'), '--title', 'T'], { input: `${E}31mred${E}0m\n`, encoding: 'utf8' });
  assert.match(out, /<svg/);
  assert.match(out, />red<\/text>/);
});
