'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { blank, countSource, bucketOf, countRepo, compare } = require('../ts-ratchet.js');
const { absolutize } = require('../typecheck-shim.js');
const { PLUGIN } = require('../lib/paths.js');

const c = src => countSource(src);

test('blank: comments, strings, template text and regexes go; a template\'s ${} stays code', () => {
  const out = blank("const a = 'x as any'; // y as any\n/* z! */ const r = /as any!/g; const t = `as any ${b!.c as T} any`;");
  assert.ok(!/any/.test(out.replace('${b!.c as T}', '')), out);
  assert.match(out, /\$\{b!\.c as T\}/);
  assert.equal(out.split('\n').length, 2, 'newlines kept');
  assert.equal(out.length, "const a = 'x as any'; // y as any\n/* z! */ const r = /as any!/g; const t = `as any ${b!.c as T} any`;".length);
});

test('blank: a slash after an operand divides, after an operator it starts a regex', () => {
  assert.match(blank('const x = a / b / c as any;'), /as any/);
  assert.doesNotMatch(blank('return /as any/.test(s);'), /any/);
  assert.doesNotMatch(blank('f(x => /as any/.test(x));'), /any/);
});

test('any: types count; names, keys and calls do not', () => {
  assert.equal(c('let a: any; function f(x: any = {}): any[] { return x as any; } type M = Map<string, any>;').any, 5);
  assert.equal(c('const any = list.find(Boolean); if (any) use(any.code, any ? 1 : 2); const o = { any: 1 }; z.any(); any(1);').any, 0);
  assert.equal(c('type T<X> = X extends any ? 1 : 2;').any, 1);
  assert.equal(c('// any\nconst s = "any"; const t = `any`;').any, 0);
});

test('as: casts count; as const and import or export renames do not', () => {
  assert.equal(c('const a = x as T; const b = (y as unknown as U[]); const k = [1] as const;').as, 3);
  assert.equal(c("import * as ns from 'node:fs';\nimport { a as b, type C as D } from './x.ts';\nexport { e as f };\nexport * as g from './g.ts';").as, 0);
  assert.equal(c('const m = `${(e as Error).message}`; const z = { as: 1 }; const s = "x as y";').as, 1);
});

test('nonNull: postfix ! counts (and let x!: T); negation and != do not', () => {
  assert.equal(c('a!.b; f(c!); d[0]!; e()!.g; m.get(k)!; h.resolve!(1); let x!: number; const [p] = q!;').nonNull, 8);
  assert.equal(c('if (!a) b(!c); x != y; x !== y; return!z; typeof!(w); const t = !!u;').nonNull, 0);
  assert.equal(c("const s = 'a!.b'; // c!.d\nconst r = /e!./;").nonNull, 0);
});

test('bucketOf: the most specific directory, scripts, and nothing else', () => {
  assert.equal(bucketOf('plugin/sub-human/lib/room/store.ts'), 'lib');
  assert.equal(bucketOf('plugin/sub-human/mod/core/guard.ts'), 'mod/core');
  assert.equal(bucketOf('plugin/sub-human/mod/test/support.ts'), 'mod/test');
  assert.equal(bucketOf('plugin/sub-human/mod/register.ts'), 'mod');
  assert.equal(bucketOf('plugin/sub-human/test/hooks/helpers.ts'), 'test');
  assert.equal(bucketOf('plugin/sub-human/hooks/compile-cache.js'), 'hooks');
  assert.equal(bucketOf('scripts/checks/s01.js'), 'scripts');
  assert.equal(bucketOf('plugin/sub-human/types/index.d.ts'), null);
  assert.equal(bucketOf('plugin/sub-human/scripts/sub-human'), null);
  assert.equal(bucketOf('scripts/baselines.json'), null);
  assert.equal(bucketOf('trailer/src/a.ts'), null);
});

test('countRepo and compare: per directory; a rise is named, a drop can be written', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-ratchet-'));
  try {
    const put = (rel, src) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), src); };
    put('plugin/sub-human/lib/a.ts', 'const a = x as any; a!.b;');
    put('plugin/sub-human/mod/test/b.test.ts', 'const b: any = 1;');
    put('plugin/sub-human/test/fixtures/skip.ts', 'const s: any = 1;');
    put('scripts/x.js', 'const y = 1;');
    const now = countRepo(root);
    assert.deepEqual(now.lib, { any: 1, as: 1, nonNull: 1 });
    assert.deepEqual(now['mod/test'], { any: 1, as: 0, nonNull: 0 });
    assert.deepEqual(now.test, { any: 0, as: 0, nonNull: 0 }, 'fixtures are skipped');
    const base = { lib: { any: 1, as: 2, nonNull: 0 } };
    const { rose, lower } = compare(base, now);
    assert.ok(rose.includes('lib nonNull 0 -> 1'));
    assert.ok(rose.includes('mod/test any 0 -> 1'), 'a directory missing from the file counts as 0');
    assert.deepEqual(lower, ['lib as 2 -> 1']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the committed ratchet holds for this tree', () => {
  const file = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'ts-ratchet.json'), 'utf8'));
  assert.deepEqual(compare(file.counts, countRepo()).rose, []);
});

test('typecheck-shim: the CLI shim\'s ../ imports resolve from the plugin', () => {
  const out = absolutize("import { cacheDir } from '../lib/cache-dir.js';\nimport('../lib/cli/main.ts');");
  assert.ok(out.includes(`'${path.join(PLUGIN, 'lib', 'cache-dir.js')}'`));
  assert.ok(out.includes(`'${path.join(PLUGIN, 'lib', 'cli', 'main.ts')}'`));
});
