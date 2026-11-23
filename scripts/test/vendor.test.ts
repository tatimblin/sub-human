// scripts/vendor.ts: the vendored files are what node_modules and the lockfile say, and --check names every drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { drift, expected, splitDeclarations, VENDOR, wrapCjs, write } from '../vendor.ts';
import { REPO } from '../lib/paths.ts';
import { parseJson } from '../lib/io.ts';
import { checkVendorCharacters } from '../directory-lint.ts';

const tmp = (t: { after: (f: () => void) => void }): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-vendor-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const built = () => { const w = expected(); assert.ok(!('errors' in w), 'errors' in w ? w.errors.join('; ') : ''); return w; };

test('wrapCjs: module.exports becomes the default export, named ones too; a file that requires is refused', async () => {
  const src = wrapCjs('function f () { return 42 }\nmodule.exports = f\nmodule.exports.x = 1', 'f', ['x']);
  const m: unknown = await import(`data:text/javascript,${encodeURIComponent(src)}`);
  assert.ok(m && typeof m === 'object' && 'default' in m && typeof m.default === 'function' && 'x' in m);
  assert.equal(Reflect.apply(m.default, null, []), 42);
  assert.equal(m.x, 1);
  assert.throws(() => wrapCjs("const x = require('y')", 'y'), /requires another module/);
});

test('vendor/ignore.mjs has the surface of node importing ignore itself', async () => {
  const own: unknown = await import(pathToFileURL(path.join(REPO, 'node_modules', 'ignore', 'index.js')).href);
  const ours: unknown = await import(pathToFileURL(path.join(VENDOR, 'ignore.mjs')).href);
  assert.ok(own && typeof own === 'object' && ours && typeof ours === 'object');
  assert.deepEqual(Object.keys(ours).sort(), Object.keys(own).filter(k => k !== 'module.exports').sort());
});

test('splitDeclarations: parts under the size, JSDoc and overloads kept whole, each name imported where used', () => {
  const src = ['/** A */', 'declare function a(x: B): void;', 'declare function a(): void;', 'interface B {', '  c: C', '}',
    '// note', 'type C = string;', 'export { a, type B as Bee, C };', ''].join('\n');
  const { index, parts } = splitDeclarations(src, 40, 'p');
  assert.deepEqual(parts.map(p => p.split('\n').filter(l => /^(?:declare|interface|type|export|import|\/)/.test(l))), [
    ["import { B } from './2.d.mts';", "import { C } from './3.d.mts';", '/** A */', 'declare function a(x: B): void;', 'declare function a(): void;', 'export { a };'],
    ["import { a } from './1.d.mts';", "import { C } from './3.d.mts';", 'interface B {', 'export { B };'],
    ["import { a } from './1.d.mts';", "import { B } from './2.d.mts';", '// note', 'type C = string;', 'export { C };'],
  ]);
  assert.equal(index, "import { a } from './p/1.d.mts';\nimport { B } from './p/2.d.mts';\nimport { C } from './p/3.d.mts';\nexport { a, type B as Bee, C };\n");
  assert.throws(() => splitDeclarations('declare a;\nexport {};\n', 10, 'p'), /no name/);
  assert.throws(() => splitDeclarations('declare const a: 1;\n', 10, 'p'), /no export list/);
  for (const [f, b] of built().files) assert.ok(b.length < 256 * 1024, `${f} under the plugin directory's file limit`);
});

test('the committed vendor/ is what scripts/vendor.ts writes', () => {
  assert.deepEqual(drift(built(), VENDOR), []);
});

test('drift: a changed, missing or extra file and a stale manifest are each named', t => {
  const want = built();
  const dir = tmp(t);
  write(want, dir);
  assert.deepEqual(drift(want, dir), []);
  fs.appendFileSync(path.join(dir, 'valibot.mjs'), '\n');
  fs.rmSync(path.join(dir, 'ws', 'LICENSE'));
  fs.writeFileSync(path.join(dir, 'diff', 'extra.js'), '');
  assert.deepEqual(drift(want, dir).sort(), ['diff/extra.js: extra file', 'valibot.mjs: hash differs', 'ws/LICENSE: missing']);

  write(want, dir);
  fs.rmSync(path.join(dir, 'ignore.mjs'));
  fs.symlinkSync(path.join(VENDOR, 'ignore.mjs'), path.join(dir, 'ignore.mjs'));
  fs.symlinkSync(path.join(VENDOR, 'ws'), path.join(dir, 'diff', 'ws'));
  assert.deepEqual(drift(want, dir).sort(), ['diff/ws: not a regular file', 'ignore.mjs: not a regular file'], 'links, even to the right bytes');

  write(want, dir);
  const m = parseJson<{ packages: Record<string, { version: string, integrity: string }> }>(fs.readFileSync(path.join(dir, 'VENDOR.json'), 'utf8'));
  const ignore = m.packages.ignore, ws = m.packages.ws;
  assert.ok(ignore && ws);
  ignore.version = '0.0.1';
  ws.integrity = 'sha512-other';
  fs.writeFileSync(path.join(dir, 'VENDOR.json'), JSON.stringify(m));
  assert.deepEqual(drift(want, dir), [`VENDOR.json: ignore recorded 0.0.1, pinned ${want.manifest.packages.ignore?.version}`, 'VENDOR.json: ws integrity differs from package-lock.json']);
  fs.rmSync(path.join(dir, 'VENDOR.json'));
  assert.deepEqual(drift(want, dir), ['VENDOR.json: missing']);
});

test('expected: a range pin, a lockfile on another version, or another install is refused', t => {
  const root = tmp(t);
  const pkg = parseJson<{ devDependencies: Record<string, string> }>(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const lock = parseJson<{ packages: Record<string, { version: string }> }>(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8'));
  pkg.devDependencies.valibot = `^${pkg.devDependencies.valibot}`;
  const locked = lock.packages['node_modules/diff'];
  assert.ok(locked);
  locked.version = '0.0.1';
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock));
  const r = expected(root);
  assert.ok('errors' in r);
  assert.match(r.errors.join('\n'), /valibot: not pinned to an exact version/);
  assert.match(r.errors.join('\n'), /diff: package-lock.json does not hold/);
  assert.match(r.errors.join('\n'), /ignore: node_modules has nothing/);
});

test('directory-lint: vendored files hold only visible non-ASCII characters; a hidden one is named', () => {
  for (const [f, b] of built().files) assert.deepEqual(checkVendorCharacters(b.toString('utf8'), `vendor/${f}`), [], f);
  const hidden = checkVendorCharacters('const a = "→"\nconst b = "x​y "\n', 'vendor/x.mjs');
  assert.deepEqual(hidden.map(h => `${h.line} ${h.message}`), ['2 U+200B, a hidden character in a vendored file', '2 U+00A0, a hidden character in a vendored file']);
});
