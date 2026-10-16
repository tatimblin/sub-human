#!/usr/bin/env node
'use strict';
/**
 * ts-ratchet: the type escapes per directory may only go down. Counts, in the code with comments, strings, template
 * text and regex literals blanked (a template's ${…} stays code):
 *   any      an explicit `any`: the word, not a name (`const any`, `any.x`, `(any)`, `!any`, `any ? a : b`), a key
 *            (`any:`) or a call (`any(`)
 *   as       an `as` cast, `as const` aside; import and export renames (`a as b`, `* as ns`) are not casts
 *   nonNull  a non-null `!`: right after an identifier, `)` or `]`, and followed by `.`, `)`, `]`, `,`, `;`, `[`,
 *            `:` (`let x!: T`), `}`, `?`, whitespace or the end; never `!=`
 * A lexical scan, not the compiler's (tsc 7 has no JS API): `<T>x` casts and `as` in a mapped type's key are not
 * told apart; neither appears in this repo.
 *
 *   node scripts/ts-ratchet.js            compare with scripts/ts-ratchet.json: exit 1 when a count rose (and say
 *                                         where), 0 otherwise (and name the counts that can be lowered)
 *   node scripts/ts-ratchet.js --update   write the counts to scripts/ts-ratchet.json when none rose (exit 1 if one
 *                                         did: the file only goes down; with no file, the counts as they are)
 *   node scripts/ts-ratchet.js --print    print the counts as JSON
 *
 *   blank(src) -> string                  the code with comments, strings, template text and regexes as spaces
 *   countSource(src) -> {any, as, nonNull}
 *   bucketOf(rel) -> string | null        the ratchet directory of a repo-relative path
 *   countRepo(root?) -> {[dir]: {any, as, nonNull}}
 *   compare(base, now) -> {rose: string[], lower: string[]}
 */
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const FILE = path.join(__dirname, 'ts-ratchet.json');
const KINDS = ['any', 'as', 'nonNull'];
// the most specific first: mod/core and mod/test are not counted in mod
const DIRS = ['hooks', 'lib', 'mcp', 'mod/core', 'mod/test', 'mod', 'statusline', 'test'];
const SKIP = new Set(['node_modules', 'fixtures', '.claude-plugin']);

const ID = /[\w$]/;
// after one of these (or a keyword below), a `/` starts a regex; after anything else it divides
const REGEX_AFTER = new Set([...'(,=:[!&|?{};+-*%<>~^']);
const KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/** The source with comments, string and template text and regex literals replaced by spaces (newlines kept). */
function blank(src) {
  const out = [];
  const braces = []; // per open `{`: true when it opened a template's ${…}
  let i = 0;
  let last = ''; // the last significant code character
  let lastWord = '';
  const n = src.length;
  const space = s => s.replace(/[^\n]/g, ' ');
  const emit = s => { out.push(s); for (const c of s) if (!/\s/.test(c)) last = c; };
  // template text from i (just past ` or }) to its end or ${; returns true when it stopped at ${
  const templateText = () => {
    let s = '';
    while (i < n) {
      const c = src[i];
      if (c === '\\') { s += src.slice(i, i + 2); i += 2; continue; }
      if (c === '`') { out.push(space(s), '`'); i++; last = '`'; return false; }
      if (c === '$' && src[i + 1] === '{') { out.push(space(s), '${'); i += 2; braces.push(true); last = '{'; return true; }
      s += c; i++;
    }
    out.push(space(s));
    return false;
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? n : e; out.push(space(src.slice(i, end))); i = end; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; out.push(space(src.slice(i, end))); i = end; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out.push(c, space(src.slice(i + 1, j)), c); i = j + 1; last = c; lastWord = ''; continue;
    }
    if (c === '`') { out.push('`'); i++; templateText(); lastWord = ''; continue; }
    if (c === '{') { braces.push(false); emit(c); i++; lastWord = ''; continue; }
    if (c === '}') {
      const tpl = braces.pop();
      out.push('}'); i++;
      if (tpl) templateText(); else last = '}';
      lastWord = '';
      continue;
    }
    if (c === '/' && (last === '' || REGEX_AFTER.has(last) || KEYWORDS.has(lastWord))) {
      let j = i + 1, cls = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '/' && !cls) break;
        j++;
      }
      j++;
      while (j < n && /[a-z]/i.test(src[j])) j++;
      out.push('/', space(src.slice(i + 1, j - 1)), '/'); i = j; lastWord = '';
      last = 'x'; // a regex is an operand: a `/` after it divides, as after an identifier
      continue;
    }
    if (ID.test(c)) {
      let j = i;
      while (j < n && ID.test(src[j])) j++;
      const w = src.slice(i, j);
      emit(w); lastWord = w; i = j; continue;
    }
    if (!/\s/.test(c)) lastWord = '';
    emit(c); i++;
  }
  return out.join('');
}

/** Import and export clauses blanked (their `as` renames are not casts), from code blank() already cleaned. */
function dropModuleClauses(code) {
  return code
    .replace(/\bimport\s+(?:type\s+)?[^;'"`]*?\bfrom\s*(['"])/g, (m, q) => m.replace(/[^\n]/g, ' ').slice(0, -1) + q)
    .replace(/\bexport\s+(?:type\s+)?(?:\*\s+as\s+[\w$]+|\{[^}]*\})/g, m => m.replace(/[^\n]/g, ' '));
}

/** The word that ends just before index i of code (spaces skipped), or ''. */
function wordBefore(code, i) {
  const m = /([\w$]+)\s*$/.exec(code.slice(Math.max(0, i - 40), i));
  return m ? m[1] : '';
}

const count = (code, re, keep) => [...code.matchAll(re)].filter(m => keep(m.index)).length;

/** The escapes in one file's source. */
function countSource(src) {
  const code = dropModuleClauses(blank(src));
  // a variable or key named any (`const any =`, `any.code`, `any ? … :`, `{ any: 1 }`, `any(…)`) is no type
  const anys = count(code, /(?<![\w$.])any(?![\w$])/g, i => {
    const after = code.slice(i + 3).trimStart();
    if (/^(?:[:(.]|\?)/.test(after) && !(after[0] === '?' && wordBefore(code, i) === 'extends')) return false;
    if (/[(!]\s*$/.test(code.slice(Math.max(0, i - 8), i))) return false; // if (any), !any: a value
    return !/^(?:const|let|var)$/.test(wordBefore(code, i));
  });
  const casts = count(code, /(?<=[\w$)\]}>'"`]\s*)\bas\s+(?!const\b)(?=[\w$({[`'"])/g, () => true);
  // after a keyword (`return!x`, `typeof!(x)`) a `!` is a negation
  const bangs = count(code, /(?<=[\w$)\]])!(?=[.)\],;[:}?(\s]|$)(?!=)/g, i => !(/[\w$]/.test(code[i - 1]) && KEYWORDS.has(wordBefore(code, i))));
  return { any: anys, as: casts, nonNull: bangs };
}

/** The ratchet directory of a repo-relative path, or null for a file the ratchet does not count. */
function bucketOf(rel) {
  const p = rel.split(path.sep).join('/');
  if (p.startsWith('scripts/')) return /\.[cm]?[jt]s$/.test(p) ? 'scripts' : null;
  const m = /^plugin\/sub-human\/(.+)$/.exec(p);
  if (!m || !/\.[cm]?[jt]s$/.test(p) || p.endsWith('.d.ts')) return null;
  return DIRS.find(d => m[1].startsWith(`${d}/`)) ?? null;
}

function walk(dir, files) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, files); else files.push(p);
  }
  return files;
}

/** The counts per ratchet directory (every directory present, zeros included). */
function countRepo(root = REPO) {
  const counts = {};
  for (const d of [...DIRS, 'scripts']) counts[d] = { any: 0, as: 0, nonNull: 0 };
  const files = [...walk(path.join(root, 'plugin', 'sub-human'), []), ...walk(path.join(root, 'scripts'), [])];
  for (const f of files) {
    const b = bucketOf(path.relative(root, f));
    if (!b) continue;
    const c = countSource(fs.readFileSync(f, 'utf8'));
    for (const k of KINDS) counts[b][k] += c[k];
  }
  return counts;
}

/** Which counts rose above the ratchet, and which are now below it ("dir kind base -> now"). */
function compare(base, now) {
  const rose = [], lower = [];
  for (const [d, c] of Object.entries(now)) {
    for (const k of KINDS) {
      const b = base[d]?.[k] ?? 0;
      if (c[k] > b) rose.push(`${d} ${k} ${b} -> ${c[k]}`);
      else if (c[k] < b) lower.push(`${d} ${k} ${b} -> ${c[k]}`);
    }
  }
  return { rose, lower };
}

function main(argv) {
  const now = countRepo();
  if (argv.includes('--print')) { process.stdout.write(`${JSON.stringify(now, null, 2)}\n`); return 0; }
  const exists = fs.existsSync(FILE);
  const base = exists ? JSON.parse(fs.readFileSync(FILE, 'utf8')).counts : {};
  const { rose, lower } = compare(base, now);
  if (rose.length && exists) {
    process.stderr.write(`ts-ratchet: more type escapes than scripts/ts-ratchet.json allows:\n  ${rose.join('\n  ')}\n`);
    return 1;
  }
  if (argv.includes('--update')) {
    const doc = { note: 'Type escapes per directory (scripts/ts-ratchet.js). Counts only go down: npm run lint fails when one rises; node scripts/ts-ratchet.js --update writes lower ones.', counts: now };
    fs.writeFileSync(FILE, `${JSON.stringify(doc, null, 2)}\n`);
    process.stdout.write(`ts-ratchet: wrote scripts/ts-ratchet.json${!exists ? ' (new)' : lower.length ? `:\n  ${lower.join('\n  ')}` : ' (no change)'}\n`);
    return 0;
  }
  process.stdout.write(lower.length
    ? `ts-ratchet: ok; lower, so run node scripts/ts-ratchet.js --update:\n  ${lower.join('\n  ')}\n`
    : 'ts-ratchet: ok\n');
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { blank, countSource, bucketOf, countRepo, compare, DIRS, KINDS };
