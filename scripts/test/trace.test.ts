import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requirements, table, testNames } from '../trace.ts';

const PRD = [
  '- **R1 (P0)** **A room is not tied to a repo.** Members may be anywhere.',
  '  - **R2 (P1)** A room has a short code (e.g. `vole-8126`).',
  '- **R3 (P2)** Later.',
  '- **R4** has no priority',
].join('\n');

test('requirements: the P0 and P1 ones in order, each titled by its first sentence; P2 and untagged are left out', () => {
  assert.deepEqual(requirements(PRD), [
    { id: 'R1', priority: 'P0', title: 'A room is not tied to a repo' },
    { id: 'R2', priority: 'P1', title: 'A room has a short code (e.g. vole-8126)' },
  ]);
});

test('testNames: single, double and template literals, escapes undone, a template\'s ${…} kept', () => {
  const src = "test('it\\'s one (R1)', () => {})\ntest(\"two\", x)\nfor (const r of rows) test(`engine: ${r.name} (R2)`, f)\ncontest('no')\n$.test('no')";
  assert.deepEqual(testNames(src), ["it's one (R1)", 'two', 'engine: ${r.name} (R2)']);
});

test('table: each requirement with its tests by file, a pipe escaped; an untagged one is uncovered and listed', () => {
  const out = table(requirements(PRD), [
    { file: 'plugin/sub-human/a.node-test.ts', name: 'x | y (R1, R12)' },
    { file: 'plugin/sub-human/a.node-test.ts', name: 'not R10 but R1' },
    { file: 'scripts/test/b.test.ts', name: 'R11 only' },
  ]);
  assert.match(out, /\| R1 \| P0 \| A room is not tied to a repo \| `a\.node-test\.ts`: “x \\\| y \(R1, R12\)”; “not R10 but R1” \|/);
  assert.match(out, /\| R2 \| P1 \| .* \| \*\*uncovered\*\* \|/);
  assert.match(out, /Uncovered: R2\./);
});
