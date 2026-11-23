// R44: what a person reads uses the room's words, never the build's. Every sentence-like string in the runtime that
// can reach a person (command answers, module lines and the status line, errors the daemon answers with) and the
// README are searched for engineering terms. Claude Code's own "hooks module" is allowed; file names and debug lines
// (`to: 'debug'`, Claude Code's debug log) are not copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PLUGIN = path.join(import.meta.dirname, '..');
const DENY = /\b(?:daemons?|modules?|mirrors?|links?|pathways?|listeners?|sockets?|pointers?|handoffs?|seq|folds?)\b/gi;
const ALLOWED = /\bhooks modules?\b|\S+\.(?:ts|js|json|sock)\b/gi;
/** The runtime: every folder and top-level file whose strings can reach a person. */
const DIRS = ['commands', 'core', 'module', 'net', 'store'];
const FILES = ['config.ts', 'cli.ts', 'home.ts', 'keys.ts'];

/** Each string literal of a TypeScript source (a template's `${…}` as `…`), with its line; comments and regexes skipped. */
function literals(src: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let line = 1;
  let prev = '';
  for (let i = 0; i < src.length; i++) {
    const c = src.charAt(i);
    if (c === '\n') line++;
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i) - 1; continue; }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i); line += src.slice(i, end).split('\n').length - 1; i = end + 1; continue; }
    if (c === '/' && /[(,=:[!&|?{};]|^$|return$/.test(prev)) { // a regex: skipped to its closing slash
      for (i++; i < src.length && src[i] !== '/'; i++) if (src[i] === '\\' || src[i] === '[') i += src[i] === '[' ? src.indexOf(']', i) - i : 1;
      prev = '/';
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') {
      let text = '';
      const at = line;
      for (i++; i < src.length && src[i] !== c; i++) {
        if (src[i] === '\\') { text += src.charAt(++i); continue; }
        if (src[i] === '\n') line++;
        if (c === '`' && src[i] === '$' && src[i + 1] === '{') {
          for (let depth = 0; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
          text += '…';
          continue;
        }
        text += src.charAt(i);
      }
      out.push({ text, line: at });
      prev = 'x';
      continue;
    }
    if (!/\s/.test(c)) prev = /\w/.test(c) ? (/\w$/.test(prev) ? prev + c : c) : c;
  }
  return out;
}

function hits(text: string): string[] { return text.replace(ALLOWED, '').match(DENY) ?? []; }

function sources(): string[] {
  const files = DIRS.flatMap(d => fs.readdirSync(path.join(PLUGIN, d), { recursive: true, encoding: 'utf8' }).map(f => path.join(d, f)));
  return [...files, ...FILES].filter(f => f.endsWith('.ts') && !/\.(?:node-)?test\.ts$|\.d\.ts$/.test(f));
}

test('no engineering term in a string a person can read, or in the README (R44)', () => {
  const found: string[] = [];
  for (const f of sources()) {
    const src = fs.readFileSync(path.join(PLUGIN, f), 'utf8');
    const lines = src.split('\n');
    for (const l of literals(src)) {
      if (!/\s/.test(l.text) || lines[l.line - 1]?.includes('to: \'debug\'')) continue;
      for (const h of hits(l.text)) found.push(`${f}:${l.line} ${h}: ${l.text.slice(0, 100)}`);
    }
  }
  fs.readFileSync(path.join(PLUGIN, 'README.md'), 'utf8').split('\n').forEach((l, i) => {
    for (const h of hits(l)) found.push(`README.md:${i + 1} ${h}: ${l.slice(0, 100)}`);
  });
  assert.deepEqual(found, []);
});

test('the search finds a term in a string and a template, and skips comments, regexes and Claude Code\'s own term', () => {
  const src = [
    '// the daemon, in a comment',
    'const a = \'the daemon did not answer\';',
    'const b = `your link to ${code} is down`;',
    'const r = /link "quoted" daemon/;',
    'const c = "Claude Code\'s hooks modules are off";',
  ].join('\n');
  assert.deepEqual(literals(src).map(l => [l.line, hits(l.text)]), [[2, ['daemon']], [3, ['link']], [5, []]]);
});
