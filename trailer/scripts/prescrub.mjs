#!/usr/bin/env node
/**
 * prescrub: write a take's capture.jsonl.gz with every frame already through the loader's scrub (src/lib/scrub.ts:
 * home paths, accounts, the model and plan, completion menus, the login warning), so git never holds the raw take.
 * Then audit what is left: every distinct screen line is checked against patterns that should never ship.
 *
 *   node scripts/prescrub.mjs --take take5            # writes capture/take5/capture.jsonl.gz, prints the audit
 *   node scripts/prescrub.mjs --take take5 --audit    # audit only
 *   node scripts/prescrub.mjs --take take5 --lines    # also print every distinct line (to read it through)
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);
const take = arg('take', 'take5');
const dir = path.join(ROOT, 'capture', take);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prescrub-'));
const out = path.join(tmp, 'scrub.mjs');
await build({ entryPoints: [path.join(ROOT, 'src/lib/scrub.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const { parseCapture } = await import(pathToFileURL(out).href);
// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

const raw = fs.existsSync(path.join(dir, 'capture.jsonl'))
  ? fs.readFileSync(path.join(dir, 'capture.jsonl'), 'utf8')
  : zlib.gunzipSync(fs.readFileSync(path.join(dir, 'capture.jsonl.gz'))).toString('utf8');
const cap = parseCapture(take, raw);

// what must never ship: a person's paths, account or plan, the model, the machine's skills, MCP servers and sessions
const user = os.userInfo().username;
const NEVER = [
  ['home path', /\/(?:Users|home)\/|~\/(?:repos|Documents|Desktop)\b/],
  ['username', new RegExp(`\\b${user}\\b`, 'i')],
  ['owner name', /tristan|timblin/i],
  ['email', /[\w.+-]+@[\w-]+\.(?:com|org|net|io|dev)\b/],
  ['model', /\b(?:Opus|Sonnet|Haiku|Mythos|Fable)\b/],
  ['plan', /Claude (?:Max|Pro|Team|Enterprise)|API Usage Billing/],
  ['login', /\/login|login expires/i],
  ['skill or plugin', /compound-engineering|\bce-[a-z]|cloudflare|remotion|delldisplay|\bvolo\b|\beero\b|claude-code-remote|anthropic-skills/i],
  ['MCP server', /mcp__(?!plugin_sub-human)|\bGmail\b|Google (?:Drive|Calendar)|Cursive|claude\.ai /],
  ['other session', /@"[^"]+"\s+message session/],
  ['menu text', /Use when (?:asked|the user)|\(user\)|\(project\)/],
];
const seen = new Map();
for (const fs_ of Object.values(cap.frames)) for (const f of fs_) for (const line of stripAnsi(f.ansi).split('\n')) {
  const l = line.trimEnd();
  if (l && !seen.has(l)) seen.set(l, f);
}
let bad = 0;
for (const [l, f] of seen) {
  for (const [what, re] of NEVER) {
    if (re.test(l.replace(/noreply@anthropic\.com/g, ''))) {
      bad++;
      console.log(`AUDIT ${what}: ${f.session}@${f.t}: ${l.trim().slice(0, 140)}`);
    }
  }
}
if (flag('lines')) for (const l of seen.keys()) console.log(l);
console.log(`audit: ${seen.size} distinct lines, ${bad} hit(s)`);

if (!flag('audit')) {
  const lines = [JSON.stringify(cap.meta)];
  const all = [];
  for (const [session, fs_] of Object.entries(cap.frames)) for (const f of fs_) all.push({ t: f.t, kind: 'frame', session, ansi: f.ansi });
  for (const m of cap.markers) all.push(m);
  all.sort((a, b) => a.t - b.t);
  for (const o of all) lines.push(JSON.stringify(o));
  const gz = zlib.gzipSync(lines.join('\n') + '\n', { level: 9 });
  fs.writeFileSync(path.join(dir, 'capture.jsonl.gz'), gz);
  console.log(`wrote capture/${take}/capture.jsonl.gz (${(gz.length / 1024).toFixed(0)} KB, ${all.length} lines)`);
}
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
