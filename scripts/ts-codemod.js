#!/usr/bin/env node
'use strict';
/**
 * ts-codemod: the one-shot mechanical part of the TypeScript migration's phase A (docs/next/TYPESCRIPT.md). Kept so
 * the conversion can be reviewed and re-run on a fresh checkout of the commit before it; delete it once the
 * migration is done.
 *
 *   node scripts/ts-codemod.js [--dry]
 *
 * 1. git mv: plugin/sub-human/{lib (not lib/vendor),hooks,mcp,statusline}/**.js and mod/**.mjs -> .ts.
 * 2. The former CommonJS files become ESM:
 *    - top-level `const X = require(S)` / `const {a, b: c} = require(S)` / `const x = require(S).p` -> import
 *      (a builtin bound whole is a default import, `import fs from 'node:fs'`, so tests that patch the shared
 *      builtin object still reach the code; a plugin module bound whole is `import * as X`);
 *    - a require(S) anywhere else (the lazy ones) -> a namespace import hoisted to the top, the call replaced by
 *      its name, unless S is in KEEP_LAZY (left as require through createRequire(import.meta.url));
 *    - S may be a string or a path.join/resolve over __dirname and the file's own path constants (LIB, ...);
 *    - module.exports = {a, b: c} -> export {a, c as b};
 *    - __dirname / __filename -> import.meta.dirname / import.meta.filename; require.main === module -> import.meta.main;
 *    - 'use strict' is dropped (ESM is strict).
 *    What it cannot convert it prints, for a hand fix.
 * 3. Every mention of a renamed file (NAME.js / NAME.mjs for each renamed NAME except `index`) in the plugin and in
 *    scripts/ is renamed (code, comments, docs, tests), except in lib/vendor, CHANGELOG and test fixtures.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PLUGIN = path.join(ROOT, 'plugin', 'sub-human');
const DRY = process.argv.includes('--dry');
const DIRS = ['lib', 'hooks', 'mcp', 'statusline'];
/** Lazy requires kept lazy (createRequire): heavy, and only some paths need them. */
const KEEP_LAZY = [/vendor\/noble\//];
/** Files whose lazy requires all stay lazy: transports/index.js loads each built-in kind on its first use. */
const KEEP_LAZY_FILES = ['lib/remote/transports/index.js'];

const todo = [];
const note = (file, msg) => todo.push(`${path.relative(ROOT, file)}: ${msg}`);

function walk(dir, pred, out = []) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) { if (d.name !== 'vendor' && d.name !== 'node_modules') walk(p, pred, out); } else if (pred(p)) out.push(p);
  }
  return out;
}

const cjsFiles = DIRS.flatMap(d => walk(path.join(PLUGIN, d), f => f.endsWith('.js')));
const mjsFiles = walk(path.join(PLUGIN, 'mod'), f => f.endsWith('.mjs'));
const toTs = f => f.replace(/\.m?js$/, '.ts');
const renamed = new Set([...cjsFiles, ...mjsFiles]);

// ---------- 1. rename ----------
function gitMv(from, to) {
  if (DRY) return;
  execFileSync('git', ['mv', from, to], { cwd: ROOT });
}

// ---------- 2. CommonJS -> ESM ----------
const BUILTINS = new Set(require('node:module').builtinModules);
const isBuiltin = s => s.startsWith('node:') || BUILTINS.has(s);

/** Evaluate a require argument: a string literal, or path.join/resolve over known constants. */
function evalSpec(src, consts, dir) {
  src = src.trim();
  const str = /^(['"])([^'"]+)\1$/.exec(src);
  if (str) return { spec: str[2] };
  const j = /^path\.(join|resolve)\(([\s\S]*)\)$/.exec(src);
  if (!j) return null;
  const parts = [];
  for (const a of j[2].split(',').map(s => s.trim()).filter(Boolean)) {
    const s = /^(['"])([^'"]+)\1$/.exec(a);
    if (s) parts.push(s[2]);
    else if (a === '__dirname') parts.push(dir);
    else if (consts.has(a)) parts.push(consts.get(a));
    else return null;
  }
  return { abs: path.join(...parts) };
}

/** The import specifier for a required module from file. */
function specFor(file, r) {
  if (r.spec && isBuiltin(r.spec)) return { spec: r.spec.startsWith('node:') ? r.spec : `node:${r.spec}`, builtin: true };
  const abs = r.abs || path.resolve(path.dirname(file), r.spec);
  const target = renamed.has(abs) ? toTs(abs) : abs;
  let rel = path.relative(path.dirname(file), target).split(path.sep).join('/');
  if (!rel.startsWith('.')) rel = './' + rel;
  return { spec: rel, json: abs.endsWith('.json'), abs };
}

/** The file's own path constants: const NAME = path.join(__dirname, ...) / = __dirname. */
function constsOf(text, dir) {
  const consts = new Map();
  const re = /^\s*const ([A-Z_][A-Z0-9_]*) = (__dirname|path\.(?:join|resolve)\([^()\n]*\));/gm;
  for (let m; (m = re.exec(text));) {
    if (m[2] === '__dirname') { consts.set(m[1], dir); continue; }
    const v = evalSpec(m[2], consts, dir);
    if (v && v.abs) consts.set(m[1], v.abs);
  }
  return consts;
}

const camel = s => s.replace(/[-_.]+(\w)/g, (_, c) => c.toUpperCase());
const SPEC_RE = String.raw`(['"][^'"]+['"]|path\.(?:join|resolve)\([^()]*\))`;

function convert(file, text) {
  const dir = path.dirname(file);
  const consts = constsOf(text, dir);
  const imports = []; // lines
  const lazy = new Map(); // spec -> identifier
  let needRequire = false;

  text = text.replace(/^'use strict';\n/m, '');

  // top-level require statements
  const TOP = new RegExp(String.raw`^const (\{[^}]*\}|[\w$]+) = require\(${SPEC_RE}\)(?:\.([\w$]+))?;[ \t]*(//[^\n]*)?$`, 'gm');
  text = text.replace(TOP, (all, bind, arg, prop, comment) => {
    const r = evalSpec(arg, consts, dir);
    if (!r) { note(file, `unresolved top-level require: ${all}`); return all; }
    const s = specFor(file, r);
    const tail = comment ? ` ${comment}` : '';
    if (s.json) { note(file, `JSON require: ${all}`); return all; }
    if (prop) return `import { ${prop === bind ? bind : `${prop} as ${bind}`} } from '${s.spec}';${tail}`;
    if (bind.startsWith('{')) {
      const names = bind.slice(1, -1).split(',').map(x => x.trim()).filter(Boolean).map(x => {
        const m = /^([\w$]+)\s*:\s*([\w$]+)$/.exec(x);
        if (m) return `${m[1]} as ${m[2]}`;
        if (!/^[\w$]+$/.test(x)) { note(file, `destructuring not converted: ${x}`); }
        return x;
      });
      const one = `import { ${names.join(', ')} } from '${s.spec}';`;
      return (one.length > 120 ? `import {\n  ${names.join(', ')},\n} from '${s.spec}';` : one) + tail;
    }
    return (s.builtin ? `import ${bind} from '${s.spec}';` : `import * as ${bind} from '${s.spec}';`) + tail;
  });

  // the rest: lazy requires
  const words = new Set(text.match(/[\w$]+/g));
  const LAZY = new RegExp(String.raw`\brequire\(\s*${SPEC_RE}\s*\)`, 'g');
  text = text.replace(LAZY, (all, arg, offset, whole) => {
    const lineStart = whole.lastIndexOf('\n', offset) + 1;
    const line = whole.slice(lineStart, whole.indexOf('\n', offset));
    if (/^\s*(\*|\/\/)/.test(line)) return all; // a comment
    const r = evalSpec(arg, consts, dir);
    if (!r) { note(file, `unresolved lazy require kept: ${all}`); needRequire = true; return all; }
    const s = specFor(file, r);
    if (s.json) { note(file, `JSON require: ${all}`); return all; }
    if (KEEP_LAZY.some(re => re.test(s.spec)) || KEEP_LAZY_FILES.includes(path.relative(PLUGIN, file))) { needRequire = true; return `require('${s.spec}')`; }
    if (lazy.has(s.spec)) return lazy.get(s.spec);
    const base = path.basename(s.spec).replace(/\.[cm]?[jt]s$/, '').replace(/^node:/, '');
    const stem = base === 'index' ? path.basename(path.dirname(s.abs || path.resolve(path.dirname(file), s.spec))) : base;
    let id = s.builtin ? camel(stem) : `${camel(stem)}Mod`;
    if (words.has(id) || lazy.has(id)) id = `${camel(path.basename(path.dirname(s.abs || 'x')) + '-' + stem)}Mod`;
    while (words.has(id)) id += '_';
    words.add(id);
    lazy.set(s.spec, id);
    imports.push(s.builtin ? `import ${id} from '${s.spec}';` : `import * as ${id} from '${s.spec}';`);
    return id;
  });

  // module.exports = { ... };
  text = text.replace(/^module\.exports = \{([\s\S]*?)\};[ \t]*$/m, (all, body) => {
    const names = [];
    for (const raw of body.replace(/\/\/[^\n]*/g, '').split(',').map(x => x.trim()).filter(Boolean)) {
      const m = /^([\w$]+)\s*:\s*([\w$]+)$/.exec(raw);
      if (m) names.push(m[1] === m[2] ? m[1] : `${m[2]} as ${m[1]}`);
      else if (/^[\w$]+$/.test(raw)) names.push(raw);
      else { note(file, `module.exports entry not converted: ${raw}`); return all; }
    }
    const one = `export { ${names.join(', ')} };`;
    if (one.length <= 120) return one;
    const lines = [];
    let cur = '';
    for (const n of names) {
      if (cur && (cur + ', ' + n).length > 114) { lines.push(cur + ','); cur = n; } else cur = cur ? `${cur}, ${n}` : n;
    }
    lines.push(cur + ',');
    return `export {\n${lines.map(l => '  ' + l).join('\n')}\n};`;
  });
  if (/\bmodule\.exports\b|\bexports\.\w+\s*=/.test(text.replace(/^\s*(\*|\/\/).*$/gm, ''))) note(file, 'module.exports left');

  text = text.replace(/\brequire\.main === module\b/g, 'import.meta.main');
  text = text.replace(/\b__dirname\b/g, 'import.meta.dirname').replace(/\b__filename\b/g, 'import.meta.filename');

  if (needRequire) {
    imports.unshift("import { createRequire } from 'node:module';");
    imports.push('const require = createRequire(import.meta.url);');
  }
  if (imports.length) {
    // after the last top-level import, else after the header comment
    const all = [...text.matchAll(/^import [^;]*;[^\n]*$/gm)];
    if (all.length) {
      const last = all.at(-1);
      const at = last.index + last[0].length;
      text = text.slice(0, at) + '\n' + imports.join('\n') + text.slice(at);
    } else {
      const m = /^(#![^\n]*\n)?(\s*(\/\*[\s\S]*?\*\/|\/\/[^\n]*)\s*\n)*/.exec(text);
      const at = m ? m[0].length : 0;
      text = text.slice(0, at) + imports.join('\n') + '\n' + text.slice(at);
    }
  }
  if (/\brequire\(/.test(text.replace(/^\s*(\*|\/\/).*$/gm, '')) && !needRequire) note(file, 'require( left without createRequire');
  return text;
}

// ---------- 3. rename mentions ----------
const names = new Set([...renamed].map(f => path.basename(f).replace(/\.m?js$/, '')).filter(n => n !== 'index'));
const MENTION = new RegExp(String.raw`(?<![\w.-])(${[...names].sort((a, b) => b.length - a.length).map(n => n.replace(/[-.]/g, '\\$&')).join('|')})\.m?js\b`, 'g');
// scripts/ has an io.js of its own (scripts/lib/io.js): its require('./lib/io.js') lines are not the plugin's
const SCRIPTS_OWN = /(require\('\.{1,2}\/lib\/io)\.ts'\)/g;
function renameMentions(text, file) {
  const out = text.replace(MENTION, '$1.ts');
  return file.startsWith(path.join(ROOT, 'scripts') + path.sep) ? out.replace(SCRIPTS_OWN, "$1.js')") : out;
}

function textFiles() {
  const out = walk(PLUGIN, f => /\.(m?js|ts|json|md)$/.test(f) || path.basename(f) === 'sub-human')
    .filter(f => !f.includes(`${path.sep}fixtures${path.sep}`));
  out.push(...walk(path.join(ROOT, 'scripts'), f => /\.(m?js|ts|json|md|sh)$/.test(f) && f !== __filename));
  return out;
}

// ---------- 4. --relazy BASE: the lazy requires that loaded more than the file did ----------
// Run after 1-3, with BASE the commit before them. Step 2 hoisted every lazy require into a static import, which
// would make each hook load the remote stack, the vendored curve and more at start. A hoisted import stays only when
// its module was loaded at load time anyway: it is in the closure of the file's top-level requires at BASE. Any
// other goes back to a lazy require (createRequire(import.meta.url): require(esm) is synchronous, so no runtime
// module may use top-level await), at the same call sites.
/** What a CommonJS file requires at load time: its top-level require statements (const ... = require(S), or a bare
 * require(S)... statement), resolved to absolute paths. */
function eagerOf(file, text) {
  const consts = constsOf(text, path.dirname(file));
  const out = new Set();
  for (const m of text.matchAll(new RegExp(String.raw`^(?:const (?:\{[^}]*\}|[\w$]+) = )?require\(${SPEC_RE}\)`, 'gm'))) {
    const r = evalSpec(m[1], consts, path.dirname(file));
    if (!r || (r.spec && isBuiltin(r.spec))) continue;
    out.add(r.abs || path.resolve(path.dirname(file), r.spec));
  }
  return out;
}

function relazy(base) {
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  const rel = f => path.relative(ROOT, f).split(path.sep).join('/');
  const was = git('ls-tree', '-r', '--name-only', base, '--', ...DIRS.map(d => `plugin/sub-human/${d}`)).split('\n')
    .filter(f => f.endsWith('.js') && !f.includes('/vendor/')).map(f => path.join(ROOT, f));
  const baseText = new Map(was.map(f => [f, git('show', `${base}:${rel(f)}`)]));
  const closure = new Map();
  const closureAt = file => {
    if (closure.has(file)) return closure.get(file);
    const seen = new Set();
    const visit = f => {
      for (const t of eagerOf(f, baseText.get(f) || '')) if (!seen.has(t) && baseText.has(t)) { seen.add(t); visit(t); }
    };
    visit(file);
    closure.set(file, seen);
    return seen;
  };
  // the processes: each hook, the MCP server and its plug-ins, the statusline (scripts/sub-human agent-statusline)
  const entries = was.filter(f => /\/(hooks\/[^/]+|mcp\/[^/]+|statusline\/index)\.js$/.test(f));
  for (const f of was) {
    const ts = toTs(f);
    let text = fs.readFileSync(ts, 'utf8');
    const top = eagerOf(f, baseText.get(f));
    const lazyOnes = [];
    for (const m of text.matchAll(/^import \* as ([\w$]+) from '(\.[^']+)';\n/gm)) {
      const target = path.resolve(path.dirname(f), m[2]).replace(/\.ts$/, '.js');
      if (!baseText.has(target) || top.has(target)) continue; // a top-level require, or not a converted module
      if (closureAt(f).has(target)) continue; // loaded at load time anyway: static is no more work
      // every entry that loads f at load time loads target (and all it loads) anyway
      const users = entries.filter(e => e === f || closureAt(e).has(f));
      const need = [target, ...closureAt(target)];
      if (users.length && users.every(e => need.every(n => n === e || closureAt(e).has(n)))) continue;
      lazyOnes.push({ line: m[0], id: m[1], spec: m[2] });
    }
    if (!lazyOnes.length) continue;
    for (const l of lazyOnes) {
      text = text.replace(l.line, '');
      text = text.replace(new RegExp(String.raw`(?<![\w$.])${l.id.replace(/\$/g, '\\$')}(?![\w$])`, 'g'), `require('${l.spec}')`);
    }
    if (!/^const require = createRequire\(import\.meta\.url\);$/m.test(text)) {
      const all = [...text.matchAll(/^import [^;]*;[^\n]*$/gm)];
      const at = all.at(-1).index + all.at(-1)[0].length;
      text = `${text.slice(0, at)}\nimport { createRequire } from 'node:module';\n\nconst require = createRequire(import.meta.url);${text.slice(at)}`;
    }
    if (!DRY) fs.writeFileSync(ts, text);
    process.stdout.write(`${rel(ts)}: lazy again: ${lazyOnes.map(l => l.spec).join(' ')}\n`);
  }
}
const ri = process.argv.indexOf('--relazy');
if (ri > 0) { relazy(process.argv[ri + 1]); process.exit(0); }

// ---------- run ----------
for (const f of renamed) gitMv(f, toTs(f));
const at = f => (DRY ? f : toTs(f));
for (const f of cjsFiles) {
  const src = fs.readFileSync(at(f), 'utf8');
  const out = convert(f, src);
  if (!DRY) fs.writeFileSync(at(f), out);
}
for (const f of textFiles()) {
  const src = fs.readFileSync(f, 'utf8');
  const out = renameMentions(src, f);
  if (out !== src && !DRY) fs.writeFileSync(f, out);
}
process.stdout.write(todo.length ? `by hand:\n${todo.map(t => `  ${t}`).join('\n')}\n` : 'nothing left by hand\n');
