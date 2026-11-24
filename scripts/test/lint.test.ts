import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capLine, capMb, descendants, footprintMb, overCap, tsgolintPids } from '../lint.ts';

test('capMb: SUB_HUMAN_LINT_CAP_MB when a positive number, else 4096', () => {
  assert.equal(capMb({}), 4096);
  assert.equal(capMb({ SUB_HUMAN_LINT_CAP_MB: '2048' }), 2048);
  for (const bad of ['', '0', '-1', 'lots']) assert.equal(capMb({ SUB_HUMAN_LINT_CAP_MB: bad }), 4096, bad);
});

test('footprintMb: reads KB, MB and GB; no line is 0', () => {
  const at = (v: string) => `======\ntsgolint [123]: 64-bit    Footprint: ${v} (16384 bytes per page)\n======`;
  assert.equal(footprintMb(at('2048 KB')), 2);
  assert.equal(footprintMb(at('320 MB')), 320);
  assert.equal(footprintMb(at('11.5 GB')), 11776);
  assert.equal(footprintMb('footprint: no process'), 0);
});

test('tsgolintPids: only tsgolint binaries under the root, at any depth; the node shim and strangers are not', () => {
  const ps = [
    '  100     1 /usr/bin/node',
    '  200   100 node_modules/.bin/oxlint',
    '  300   200 node',
    '  400   300 /repo/node_modules/@oxlint-tsgolint/darwin-arm64/tsgolint',
    '  500     1 /other/worktree/node_modules/@oxlint-tsgolint/darwin-arm64/tsgolint',
    '  600   200 /bin/sh -c tsgolint-ish thing',
  ].join('\n');
  assert.deepEqual(descendants(ps, 200).map(r => r.pid), [300, 400, 600], 'parents before children');
  assert.deepEqual(tsgolintPids(descendants(ps, 200)), [400]);
  assert.deepEqual(tsgolintPids(descendants(ps, 999)), []);
});

test('overCap: the first sample above the cap stops the run; at or under it does not', () => {
  assert.equal(overCap([], 4096), undefined);
  assert.equal(overCap([{ pid: 1, mb: 4096 }, { pid: 2, mb: 300 }], 4096), undefined);
  assert.deepEqual(overCap([{ pid: 1, mb: 300 }, { pid: 2, mb: 5000 }], 4096), { pid: 2, mb: 5000 });
});

test('capLine: one line naming the size, the cap and the knob', () => {
  const line = capLine({ pid: 2, mb: 4123.6 }, 4096);
  assert.equal(line, 'lint: tsgolint passed 4124 MB (cap 4096 MB, SUB_HUMAN_LINT_CAP_MB) and was stopped');
  assert.ok(!line.includes('\n'));
});
