#!/usr/bin/env node
/**
 * stills: render key frames of a take for review, bundling once. Frames are picked from the cut the
 * composition logs ([cut] id@frame+length): ~70% into each listed segment, plus the hook and the end card.
 *
 *   node scripts/stills.mjs [--take take4] [--comp Trailer] [--only join,card-zoom] [--out out/stills]
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const take = arg('take', 'take5');
const comps = arg('comp', 'Trailer').split(',');
const only = arg('only', '') ? arg('only', '').split(',') : null;
// --at 0.3,0.7: where in each segment to take a still (default 0.7); --frames 10,200: exact frames instead
const at = arg('at', '0.7').split(',').map(Number);
const exact = arg('frames', '') ? arg('frames', '').split(',').map(Number) : null;
const outDir = path.resolve(ROOT, arg('out', 'out/stills'));
fs.mkdirSync(outDir, { recursive: true });

const serveUrl = await bundle({ entryPoint: path.join(ROOT, 'src/index.ts'), publicDir: path.join(ROOT, 'public') });
for (const id of comps) {
  let cut = '';
  const inputProps = { take };
  const composition = await selectComposition({
    serveUrl,
    id,
    inputProps,
    onBrowserLog: (log) => {
      if (log.text.includes('[cut]')) cut = log.text;
    },
  });
  const picks = [];
  for (const m of cut.matchAll(/(\S+)@(\d+)\+(\d+)/g)) {
    if (exact || (only && !only.includes(m[1]))) continue;
    for (const k of at) picks.push([m[1], Math.round(+m[2] + +m[3] * k)]);
  }
  for (const f of exact || []) picks.push(['f', f]);
  const end = /end@(\d+)/.exec(cut);
  if (!exact && (!only || only.includes('hook'))) picks.unshift(['hook', 60]);
  if (end && !exact && (!only || only.includes('end'))) picks.push(['end', composition.durationInFrames - 15]);
  for (const [name, frame] of picks) {
    const output = path.join(outDir, `${id}-${String(frame).padStart(4, '0')}-${name}.png`);
    await renderStill({ serveUrl, composition, frame, output, inputProps });
    console.log(path.relative(ROOT, output));
  }
}
