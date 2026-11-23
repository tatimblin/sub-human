// scripts/budget.ts: code lines per area (docs/ARCHITECTURE.md §11), and tests no larger than the runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codeLines, count, judge, kindOf } from '../budget.ts';

test('codeLines: comments and blank lines are left out; a line of a string or regex counts', () => {
  assert.equal(codeLines('// a\n/* b\n c */\n\nconst x = 1 // d\n  "only a string"\n/\\/\\*/.test(s)\n', 'a.ts'), 3);
  assert.equal(codeLines('#!/bin/sh\n# note\necho hi\n\n', 'a.sh'), 1);
});

test('kindOf: areas, the top level, tests, and what is not counted', () => {
  assert.equal(kindOf('core/fold.ts'), 'core');
  assert.equal(kindOf('net/pathways/ssh.ts'), 'net');
  assert.equal(kindOf('keys.ts'), 'top');
  assert.equal(kindOf('cli/main.ts'), 'top');
  assert.equal(kindOf('core/fold.node-test.ts'), 'test');
  assert.equal(kindOf('module/plans.test.ts'), 'test');
  assert.equal(kindOf('test/helpers.ts'), 'test');
  for (const f of ['vendor/valibot.mjs', 'test/fixtures/a.ts', 'core/x.d.ts', 'README.md', '.claude-plugin/types/x.ts']) assert.equal(kindOf(f), null, f);
});

test('judge: an area, the total and (with --final) the tests over their line', () => {
  const zero = { core: 0, store: 0, module: 0, commands: 0, net: 0, top: 0 };
  const noParts = { 'module/tools': 0, 'net/channel': 0, 'net/pathways': 0 };
  assert.deepEqual(judge({ parts: noParts, areas: { ...zero, core: 900 }, tests: 5000 }).over, [], 'tests only warned before the cutover');
  assert.deepEqual(judge({ parts: noParts, areas: { ...zero, core: 900 }, tests: 5000 }).warn, ['tests 5000 > runtime 900 (checked at the cutover)']);
  assert.deepEqual(judge({ parts: noParts, areas: { ...zero, core: 900, store: 100 }, tests: 1001 }, true).over, ['tests 1001 > 1000']);
  assert.deepEqual(judge({ parts: noParts, areas: { ...zero, store: 801 }, tests: 0 }).over, ['store 801 > 800']);
  assert.deepEqual(judge({ parts: noParts, areas: { core: 2500, store: 800, module: 1900, commands: 700, net: 2100, top: 1000 }, tests: 0 }).over, [], 'at the line is within');
  assert.deepEqual(judge({ parts: noParts, areas: { core: 2500, store: 800, module: 1900, commands: 700, net: 2100, top: 1001 }, tests: 0 }).over, ['top 1001 > 1000', 'total 9001 > 9000']);
  assert.deepEqual(judge({ parts: { 'module/tools': 401, 'net/channel': 300, 'net/pathways': 601 }, areas: { ...zero, module: 401, net: 901 }, tests: 0 }).over, ['module/tools 401 > 400', 'net/pathways 601 > 600']);
});

test('count: a plugin tree', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-budget-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (f: string, s: string): void => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s); };
  put('core/a.ts', '// x\nexport const a = 1\n');
  put('core/a.node-test.ts', 'a\nb\n');
  put('vendor/v.mjs', 'x\ny\n');
  put('home.ts', 'export {}\n');
  put('module/tools.ts', 'a\n');
  put('net/channel.ts', 'a\nb\n');
  put('net/pathways/ssh.ts', 'a\n');
  put('net/pathways-other.ts', 'a\n');
  assert.deepEqual(count(root), {
    areas: { core: 1, store: 0, module: 1, commands: 0, net: 4, top: 1 },
    parts: { 'module/tools': 1, 'net/channel': 2, 'net/pathways': 1 },
    tests: 2,
  });
});
