#!/usr/bin/env node
/**
 * vendor: copies the plugin's dependencies from node_modules into plugin/sub-human/vendor/ (docs/ARCHITECTURE.md §2a),
 * where module and node code import them by relative path, and records what it copied in vendor/VENDOR.json: each
 * package's version, its lockfile integrity and the sha256 of every file.
 *
 *   node scripts/vendor.ts           rewrite vendor/ from node_modules (after a version bump and npm install)
 *   node scripts/vendor.ts --check   exit 1 on any drift: a version other than the pinned one, an integrity other than
 *                                    the lockfile's, a file whose bytes or hash differ, a file missing or extra
 *
 * Module code is type-checked by `claude plugin validate`, which resolves only relative paths, so each package's
 * declarations are vendored too: diff's as they are, ignore's rewritten as ESM, and valibot's (620 KB, over the plugin
 * directory's 256 KiB file limit) split into parts (splitDeclarations). ws runs in node children only, which tsc
 * checks with node_modules at hand, so its declaration file re-exports @types/ws.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseJson } from './lib/io.ts';
import { PLUGIN, REPO } from './lib/paths.ts';

/** A package's vendored files: path under vendor/ → bytes. */
export type Files = Map<string, Buffer>;
/** What VENDOR.json records of one package. */
export interface Entry { version: string, integrity: string, files: Record<string, string> }
export interface Manifest { note: string, packages: Record<string, Entry> }

const NOTE = 'Written by scripts/vendor.ts; npm test runs `node scripts/vendor.ts --check`. Do not edit.';
export const VENDOR: string = path.join(PLUGIN, 'vendor');
const MANIFEST = 'VENDOR.json';

/**
 * A CommonJS file as an ES module: module.exports is the default export, and each of `named` a named one (as node's
 * own import of the file gives them). Refuses one that requires anything.
 */
export function wrapCjs(src: string, name: string, named: readonly string[] = []): string {
  if (/\brequire\s*\(/.test(src)) throw new Error(`${name}: requires another module, so it cannot be wrapped alone`);
  return `// ${name}, CommonJS wrapped as an ES module by scripts/vendor.ts\nconst module = { exports: {} };\n`
    + `(function (module, exports) {\n${src}\n})(module, module.exports);\nexport default module.exports;\n`
    + named.map(n => `export const ${n} = module.exports.${n};\n`).join('');
}

// a top-level statement of a bundled declaration file starts at column 0 with one of these
const STATEMENT = /^(?:\/\*\*|\/\/|declare |interface |type |export )/;
const NAMED = /^(?:declare\s+)?(?:function|const|let|var|class|namespace|enum|interface|type)\s+([\w$]+)/;
const isComment = (l: string): boolean => /^\s*(?:\/\*\*|\*|\/\/)/.test(l);

/**
 * A bundled declaration file with no imports, cut at statements into parts of about max bytes, named N.d.mts in dir.
 * Each part exports what it declares and imports what the others declare; the index imports them all and keeps the
 * file's own export list. A statement's JSDoc stays with it, and a name's overloads stay in one part.
 */
export function splitDeclarations(src: string, max: number, dir: string): { index: string, parts: string[] } {
  const segs: { name: string, text: string }[] = [];
  let lines: string[] = [], code = false, exports = '';
  const flush = (): void => {
    if (!lines.length) return;
    const first = lines.find(l => !isComment(l)) ?? '';
    const text = lines.join('\n');
    if (first.startsWith('export ')) exports += text;
    else {
      const name = NAMED.exec(first)?.[1];
      if (!name) throw new Error(`splitDeclarations: no name in \`${first.slice(0, 60)}\``);
      segs.push({ name, text });
    }
    lines = []; code = false;
  };
  for (const l of src.split('\n')) {
    if (STATEMENT.test(l) && code) flush();
    lines.push(l);
    if (!isComment(l) && l.trim()) code = true;
  }
  flush();
  if (!exports) throw new Error('splitDeclarations: no export list');
  const parts: { names: Set<string>, text: string[] }[] = [];
  let size = Infinity, prev = '';
  for (const s of segs) {
    if (size + s.text.length > max && s.name !== prev) { parts.push({ names: new Set(), text: [] }); size = 0; }
    const part = parts.at(-1);
    if (!part) continue;
    if (s.name !== prev && parts.some(p => p !== part && p.names.has(s.name))) throw new Error(`splitDeclarations: ${s.name} declared apart`);
    part.names.add(s.name); part.text.push(s.text); size += s.text.length + 1; prev = s.name;
  }
  const imports = (skip: number, from: string): string =>
    parts.map((p, i) => (i === skip ? '' : `import { ${[...p.names].join(', ')} } from './${from}${i + 1}.d.mts';\n`)).join('');
  return {
    index: `${imports(-1, `${dir}/`)}${exports.trim()}\n`,
    parts: parts.map((p, i) => `${imports(i, '')}${p.text.join('\n')}\nexport { ${[...p.names].join(', ')} };\n`),
  };
}

const PART_MAX = 200_000;
/** valibot's declarations as the index and its parts under vendor/. */
function valibotTypes(src: string): [string, Buffer][] {
  const { index, parts } = splitDeclarations(src, PART_MAX, 'valibot-types');
  return [['valibot.d.mts', text(index)], ...parts.map((p, i): [string, Buffer] => [`valibot-types/${i + 1}.d.mts`, text(p)])];
}

/** ignore's CommonJS declarations (`export = ignore`) as the ES module wrapCjs makes. */
function ignoreTypes(src: string): string {
  if (!/^export = ignore$/m.test(src)) throw new Error('ignore: its declarations no longer end in `export = ignore`');
  return src.replace(/^export = ignore$/m, 'export default ignore\nexport declare const isPathValid: typeof ignore.isPathValid');
}

const read = (nm: string, rel: string): Buffer => fs.readFileSync(path.join(nm, rel));
const text = (s: string): Buffer => Buffer.from(s);
const filesUnder = (dir: string, ext: RegExp): string[] =>
  fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(f => ext.test(f)).map(f => f.split(path.sep).join('/')).sort();

/** How each package is vendored, from its directory in node_modules. */
export const PACKAGES: Record<string, (dir: string) => Files> = {
  valibot: d => new Map([
    ['valibot.mjs', read(d, 'dist/index.mjs')],
    ...valibotTypes(read(d, 'dist/index.d.mts').toString('utf8')),
    ['valibot.LICENSE.md', read(d, 'LICENSE.md')],
  ]),
  ignore: d => new Map([
    ['ignore.mjs', text(wrapCjs(read(d, 'index.js').toString('utf8'), 'ignore', ['isPathValid']))],
    ['ignore.d.mts', text(ignoreTypes(read(d, 'index.d.ts').toString('utf8')))],
    ['ignore.LICENSE-MIT', read(d, 'LICENSE-MIT')],
  ]),
  diff: d => new Map([
    ...filesUnder(path.join(d, 'libesm'), /\.(?:js|d\.ts)$/).map((f): [string, Buffer] => [`diff/${f}`, read(d, `libesm/${f}`)]),
    ['diff/package.json', read(d, 'libesm/package.json')],
    ['diff/LICENSE', read(d, 'LICENSE')],
  ]),
  // node children only; the copied files stay CommonJS (the package.json says so), wrapper.mjs is ws's own ESM entry
  ws: d => new Map([
    ...filesUnder(path.join(d, 'lib'), /\.js$/).map((f): [string, Buffer] => [`ws/lib/${f}`, read(d, `lib/${f}`)]),
    ['ws/index.mjs', read(d, 'wrapper.mjs')],
    ['ws/index.d.mts', text("export * from 'ws';\nexport { default } from 'ws';\n")],
    ['ws/package.json', text('{ "type": "commonjs" }\n')],
    ['ws/LICENSE', read(d, 'LICENSE')],
  ]),
};

const sha256 = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex');
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const field = (v: unknown, ...keys: string[]): unknown => keys.reduce((o, k) => (isRec(o) ? o[k] : undefined), v);
const readJsonAt = (f: string): unknown => { try { return parseJson(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };

/** Every file and the manifest vendor/ should hold, from the repo at root; or the reasons it can't be built. */
export function expected(root = REPO): { files: Files, manifest: Manifest } | { errors: string[] } {
  const pkg = readJsonAt(path.join(root, 'package.json'));
  const lock = readJsonAt(path.join(root, 'package-lock.json'));
  const errors: string[] = [];
  const files: Files = new Map();
  const packages: Record<string, Entry> = {};
  for (const [name, build] of Object.entries(PACKAGES)) {
    const pinned = field(pkg, 'devDependencies', name);
    if (typeof pinned !== 'string' || !/^\d+\.\d+\.\d+$/.test(pinned)) { errors.push(`${name}: not pinned to an exact version in package.json devDependencies`); continue; }
    const locked = field(lock, 'packages', `node_modules/${name}`);
    const integrity = field(locked, 'integrity');
    if (field(locked, 'version') !== pinned || typeof integrity !== 'string') { errors.push(`${name}: package-lock.json does not hold ${pinned} (npm install)`); continue; }
    const dir = path.join(root, 'node_modules', name);
    const installed = field(readJsonAt(path.join(dir, 'package.json')), 'version');
    if (installed !== pinned) { errors.push(`${name}: node_modules has ${typeof installed === 'string' ? installed : 'nothing'}, pinned ${pinned} (npm ci)`); continue; }
    const own = build(dir);
    const hashes: Record<string, string> = {};
    for (const [f, b] of [...own].sort(([a], [b]) => a.localeCompare(b))) { files.set(f, b); hashes[f] = sha256(b); }
    packages[name] = { version: pinned, integrity, files: hashes };
  }
  return errors.length ? { errors } : { files, manifest: { note: NOTE, packages } };
}

const manifestText = (m: Manifest): string => `${JSON.stringify(m, null, 2)}\n`;

/** The entries under dir, relative with forward slashes: regular files, and the rest that are no directory (links). */
function onDisk(dir: string): { files: Set<string>, odd: Set<string> } {
  const files = new Set<string>(), odd = new Set<string>();
  // by hand: a recursive readdir follows a link to a directory
  const walk = (rel: string): void => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; } // no dir: all missing
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r); else if (e.isFile()) files.add(r); else odd.add(r);
    }
  };
  walk('');
  return { files, odd };
}

/** The drift between what vendor/ should hold and what dir holds: one line each, none when it matches. */
export function drift(want: { files: Files, manifest: Manifest }, dir: string): string[] {
  const out: string[] = [];
  const { files: have, odd } = onDisk(dir);
  for (const f of odd) out.push(`${f}: not a regular file`);
  const recorded = readJsonAt(path.join(dir, MANIFEST));
  if (!have.has(MANIFEST)) out.push(`${MANIFEST}: missing`);
  else if (JSON.stringify(recorded) !== JSON.stringify(want.manifest)) {
    for (const [name, e] of Object.entries(want.manifest.packages)) {
      const r = field(recorded, 'packages', name);
      if (field(r, 'version') !== e.version) out.push(`${MANIFEST}: ${name} recorded ${String(field(r, 'version'))}, pinned ${e.version}`);
      else if (field(r, 'integrity') !== e.integrity) out.push(`${MANIFEST}: ${name} integrity differs from package-lock.json`);
      else if (JSON.stringify(field(r, 'files')) !== JSON.stringify(e.files)) out.push(`${MANIFEST}: ${name} file hashes differ`);
    }
    if (!out.length) out.push(`${MANIFEST}: differs from what scripts/vendor.ts writes`);
  }
  for (const [f, b] of want.files) {
    if (odd.has(f)) continue;
    if (!have.has(f)) { out.push(`${f}: missing`); continue; }
    if (sha256(fs.readFileSync(path.join(dir, f))) !== sha256(b)) out.push(`${f}: hash differs`);
  }
  for (const f of have) if (f !== MANIFEST && !want.files.has(f)) out.push(`${f}: extra file`);
  return out;
}

/** Rewrite dir to hold exactly want. */
export function write(want: { files: Files, manifest: Manifest }, dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [f, b] of want.files) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), b); }
  fs.writeFileSync(path.join(dir, MANIFEST), manifestText(want.manifest));
}

function main(argv: readonly string[]): number {
  const want = expected();
  if ('errors' in want) { process.stderr.write(`vendor: ${want.errors.join('\n  ')}\n`); return 1; }
  if (argv.includes('--check')) {
    const found = drift(want, VENDOR);
    if (found.length) { process.stderr.write(`vendor: plugin/sub-human/vendor drifted (node scripts/vendor.ts rewrites it):\n  ${found.join('\n  ')}\n`); return 1; }
    return 0;
  }
  write(want, VENDOR);
  const kb = Math.round([...want.files.values()].reduce((n, b) => n + b.length, 0) / 1024);
  process.stdout.write(`vendor: wrote ${want.files.size} files (${kb} KB) for ${Object.keys(want.manifest.packages).join(', ')}\n`);
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
