#!/usr/bin/env node
/**
 * check-ansi: the trailer's ANSI port (src/lib/ansi.ts) must read every captured screen exactly as the
 * walkthrough's renderer (../scripts/ansi-svg.js) does: same cells, columns, widths and resolved colours.
 *
 *   node scripts/check-ansi.mjs [capture.jsonl | screen.ansi ...]   (default: capture/synthetic/capture.jsonl.gz)
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parse, resolved } from '../src/lib/ansi.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = createRequire(import.meta.url)(path.join(ROOT, '..', 'scripts', 'ansi-svg.js'));
const files = process.argv.slice(2);
if (!files.length) files.push(path.join(ROOT, 'capture/synthetic/capture.jsonl.gz'));

const key = (rows, res) =>
  JSON.stringify(rows.map((r) => r.map((c) => [c.ch, c.col, c.w, res(c.style), c.style.bold, c.style.dim, c.style.italic, c.style.underline, c.style.strike])));

let screens = 0;
let bad = 0;
for (const f of files) {
  const raw = fs.readFileSync(f);
  const text = (f.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8');
  const frames = f.endsWith('.ansi') ? [JSON.stringify({ ansi: text, session: path.basename(f), t: 0 })] : text.split('\n');
  for (const line of frames) {
    if (!f.endsWith('.ansi') && !line.includes('"frame"')) continue;
    const { ansi, session, t } = JSON.parse(line);
    screens++;
    const a = key(parse(ansi), (s) => resolved(s));
    const b = key(svg.parse(ansi), (s) => {
      let fg = s.fg || svg.THEME.fg;
      let bg = s.bg;
      if (s.inverse) { const x = fg; fg = bg || svg.THEME.bg; bg = x; }
      return { fg, bg };
    });
    if (a !== b) {
      bad++;
      if (bad <= 3) console.error(`mismatch: ${path.basename(f)} ${session} t=${t}`);
    }
  }
}
console.log(`${screens} screens, ${bad} mismatches`);
process.exit(bad ? 1 : 0);
