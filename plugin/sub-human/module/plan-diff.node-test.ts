// plan-diff.ts: the review pane's diff between two plan versions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDiff } from './plan-diff.js';

test('a changed line is a hunk of its own, with no file header', () => {
  const d = planDiff('paging', '1. store\n2. api\n', '1. store\n2. api with cursors\n');
  assert.match(d, /^@@ /);
  assert.match(d, /^-2\. api$/m);
  assert.match(d, /^\+2\. api with cursors$/m);
  assert.doesNotMatch(d, /^(?:Index|===|---|\+\+\+)/m);
});
