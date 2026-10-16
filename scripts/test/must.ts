import assert from 'node:assert/strict';

/** v, asserted present: the test fails here, naming what, when v is null or undefined (in place of a `!`). */
export function must<T>(v: T | null | undefined, what = 'a value'): T {
  assert.ok(v !== null && v !== undefined, `expected ${what}`);
  return v;
}
