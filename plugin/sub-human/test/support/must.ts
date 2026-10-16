/**
 * plugin/sub-human/test/support/must.ts: a present value, asserted, in place of a `!` (scripts/test/must.ts is the
 * scripts tests' copy: they import plugin files only through scripts/lib/paths.ts).
 *
 *   must(v, what?) -> v   fails the test, naming what, when v is null or undefined; else v, narrowed
 */
import assert from 'node:assert/strict';

/** v, asserted present: the test fails here, naming what, when v is null or undefined (in place of a `!`). */
export function must<T>(v: T | null | undefined, what = 'a value'): T {
  assert.ok(v !== null && v !== undefined, `expected ${what}`);
  return v;
}

