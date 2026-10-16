// The runtime's lazy loads (plugin lib/io.ts lazy and loadAt) name the module they type and the module they load
// with the same specifier: a lazy<typeof X>(import.meta.url, './x.ts') call must sit beside
// `import type * as X from './x.ts'`, and './x.ts' must exist. No other require loads a module, and loadAt (a path
// computed at run time) stands only where a literal cannot. The source is read with its comments and string
// contents blanked, so a require in a comment or in code a child runs (lib/remote/tailscale.ts) does not count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN } from '../lib/paths.ts';

/** The runtime: what node or the Bun worker runs (not the tests, not mod/test). */
const RUNTIME_DIRS = ['lib', 'hooks', 'mcp', 'mod', 'statusline'];
/** The one home of createRequire. */
const HELPER = 'lib/io.ts';
/** loadAt's callers, and why their path is computed. */
const LOAD_AT: Record<string, string> = {
  'lib/remote/bridge.ts': 'the worker loads the handler its creator names',
  'mcp/room-server.ts': 'each room plug-in by its file name',
  'lib/cli/doctor/check.ts': "doctor's lib(name), typed by its Libs map (checked below)",
};

function runtimeFiles(): string[] {
  const out: string[] = [path.join(PLUGIN, 'scripts', 'sub-human')];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (path.relative(PLUGIN, f) !== path.join('mod', 'test')) walk(f); } else if (/\.(ts|js)$/.test(e.name)) out.push(f);
    }
  };
  for (const d of RUNTIME_DIRS) walk(path.join(PLUGIN, d));
  return out;
}

/** The source with every comment and the contents of every string, template and regex literal blanked (same
 * offsets; quotes kept), so a pattern matched on it is code, and a literal is read back from the source. */
function mask(src: string): string {
  const out = src.split('');
  const blank = (from: number, to: number): void => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  let prev = ''; // the last significant code character: a / after one of these starts a regex
  const templates: number[] = []; // brace depth at each open ${ of a template
  let depth = 0;
  while (i < src.length) {
    const ch = src[i] ?? '', next = src[i + 1] ?? '';
    if (ch === '/' && next === '/') { const end = src.indexOf('\n', i); const e = end < 0 ? src.length : end; blank(i, e); i = e; continue; }
    if (ch === '/' && next === '*') { const end = src.indexOf('*/', i + 2); const e = end < 0 ? src.length : end + 2; blank(i, e); i = e; continue; }
    if (ch === '\'' || ch === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== ch && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      blank(i + 1, j); i = j + 1; prev = ch; continue;
    }
    if (ch === '`' || (ch === '}' && templates.at(-1) === depth)) {
      if (ch === '}') templates.pop();
      let j = i + 1;
      while (j < src.length && src[j] !== '`' && !(src[j] === '$' && src[j + 1] === '{')) j += src[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      if (src[j] === '$') { templates.push(depth); i = j + 2; prev = '{'; continue; }
      i = j + 1; prev = '`'; continue;
    }
    if (ch === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || /\b(?:return|typeof|case|in|of)\s*$/.test(src.slice(Math.max(0, i - 8), i)))) {
      let j = i + 1, cls = false;
      while (j < src.length && src[j] !== '\n' && (cls || src[j] !== '/')) { if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; j += src[j] === '\\' ? 2 : 1; }
      blank(i + 1, j); i = j + 1; prev = '/'; continue;
    }
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (!/\s/.test(ch)) prev = ch;
    i++;
  }
  return out.join('');
}

/** What is wrong with one file's loads (rel: its path in the plugin), as lines; none when it is right. */
function problems(rel: string, src: string, exists: (file: string) => boolean = f => fs.existsSync(f)): string[] {
  const code = mask(src);
  const out: string[] = [];
  const at = (k: number): string => `${rel}:${src.slice(0, k).split('\n').length}`;
  const literal = (k: number): string | null => { const q = src[k]; if (q !== '\'' && q !== '"') return null; const end = src.indexOf(q, k + 1); return src.slice(k + 1, end); };
  const typeImports = new Map<string, string>();
  for (const m of src.matchAll(/^import type \* as (\w+) from '([^']+)';/gm)) typeImports.set(m[1] ?? '', m[2] ?? '');
  if (rel !== HELPER) for (const m of code.matchAll(/\bcreateRequire\b/g)) out.push(`${at(m.index)}: createRequire outside ${HELPER}`);
  for (const m of code.matchAll(/(?<![\w.$])require\s*(?:<[^>]*>)?\s*\(/g)) out.push(`${at(m.index)}: a require: use lazy (lib/io.ts)`);
  for (const m of code.matchAll(/(?<![\w.$])lazy\b/g)) {
    const k = m.index;
    if (rel === HELPER && /^lazy<M>\(from/.test(code.slice(k))) continue; // its definition
    if (/^import \{[^}]*$/.test(code.slice(code.lastIndexOf('\n', k) + 1, k))) continue; // the import of it
    if (/^\s*[,}]/.test(code.slice(k + 4)) && rel === HELPER) continue; // its export
    const call = /^lazy<typeof (\w+)>\(import\.meta\.url, (['"])/.exec(code.slice(k));
    if (!call) { out.push(`${at(k)}: lazy is called lazy<typeof XMod>(import.meta.url, './x.ts')`); continue; }
    const ns = call[1] ?? '';
    const spec = literal(k + call[0].length - 1) ?? '';
    const typed = typeImports.get(ns);
    if (typed === undefined) out.push(`${at(k)}: ${ns} is no \`import type * as ${ns} from '…'\``);
    else if (typed !== spec) out.push(`${at(k)}: typed as '${typed}' (${ns}) but loads '${spec}'`);
    if (!exists(path.join(PLUGIN, path.dirname(rel), spec))) out.push(`${at(k)}: '${spec}' does not exist`);
  }
  for (const m of code.matchAll(/(?<![\w.$])loadAt\b/g)) {
    const k = m.index;
    if (rel === HELPER || /^import \{[^}]*$/.test(code.slice(code.lastIndexOf('\n', k) + 1, k))) continue;
    if (!(rel in LOAD_AT)) { out.push(`${at(k)}: loadAt outside ${Object.keys(LOAD_AT).join(', ')}: a literal path is lazy's`); continue; }
    const call = /^loadAt<.*?>\(import\.meta\.url, ([^)\n]*)\)/.exec(code.slice(k));
    if (!call) out.push(`${at(k)}: loadAt is called loadAt<M>(import.meta.url, path)`);
    else if (/^['"]/.test(call[1] ?? '')) out.push(`${at(k)}: loadAt with a literal path: use lazy`);
  }
  return out;
}

test('every lazy load is typed by the module it loads, and nothing else requires', () => {
  const all = runtimeFiles().flatMap(f => problems(path.relative(PLUGIN, f), fs.readFileSync(f, 'utf8')));
  assert.deepEqual(all, []);
  const calls = runtimeFiles().reduce((n, f) => n + (mask(fs.readFileSync(f, 'utf8')).match(/(?<![\w.$])lazy<typeof /g) ?? []).length, 0);
  assert.ok(calls > 50, `the scan finds the lazy loads (${calls})`);
});

test("doctor's Libs map types each name by the module at that path", () => {
  const rel = 'lib/cli/doctor/check.ts';
  const src = fs.readFileSync(path.join(PLUGIN, rel), 'utf8');
  const types = new Map([...src.matchAll(/^import type \* as (\w+) from '([^']+)';/gm)].map(m => [m[1] ?? '', m[2] ?? '']));
  const body = /interface Libs \{([^}]*)\}/.exec(src)?.[1] ?? '';
  const rows = [...body.matchAll(/'([^']+)': typeof (\w+);/g)];
  assert.ok(rows.length > 10, 'the map is read');
  for (const [, name = '', ns = ''] of rows) {
    const spec = types.get(ns);
    assert.ok(spec, `${name}: ${ns} is a namespace import`);
    assert.equal(path.normalize(path.join(path.dirname(rel), spec)), path.join('lib', name), `${name} is typed by ${spec}`);
  }
});

test('the scan finds a wrong path, an untyped load, a stray require and a literal loadAt', () => {
  const yes = () => true;
  const ok = "import type * as X from './x.ts';\nimport { lazy } from './io.ts';\nconst x = lazy<typeof X>(import.meta.url, './x.ts');\n";
  assert.deepEqual(problems('lib/a.ts', ok, yes), []);
  assert.match(problems('lib/a.ts', ok.replace("'./x.ts');\n", "'./y.ts');\n"), yes).join(), /typed as '\.\/x\.ts' \(X\) but loads '\.\/y\.ts'/);
  assert.match(problems('lib/a.ts', ok, () => false).join(), /does not exist/);
  assert.match(problems('lib/a.ts', "const x = lazy<Foo>(import.meta.url, './x.ts');", yes).join(), /is called lazy<typeof XMod>/);
  assert.match(problems('lib/a.ts', "const r = require('./x.ts');", yes).join(), /a require/);
  assert.match(problems('lib/a.ts', "import { createRequire } from 'node:module';", yes).join(), /createRequire outside/);
  assert.match(problems('lib/a.ts', "const m = loadAt<M>(import.meta.url, p);", yes).join(), /loadAt outside/);
  assert.match(problems('mcp/room-server.ts', "const m = loadAt<M>(import.meta.url, './x.ts');", yes).join(), /literal path/);
  // a require in a comment, a string or a template a child runs is no load
  assert.deepEqual(problems('lib/a.ts', "// require('x')\nconst s = 'require(1)';\nconst t = `node -e \"require('x')\" ${a / 2}`;\nconst r = /require\\(/;\n", yes), []);
});
