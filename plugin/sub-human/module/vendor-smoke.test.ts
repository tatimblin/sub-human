// The hooks module's runtime loads the vendored ESM builds by relative path (docs/TESTING.md §4, "Kit facts").
// ws is not here: it runs in node children only (test/vendor.node-test.ts).
import { test, expect } from 'claude-code/testing'
import * as v from '../vendor/valibot.mjs'
import ignore from '../vendor/ignore.mjs'
import { createPatch } from '../vendor/diff/index.js'

test('valibot, ignore and diff work inside the module runtime', () => {
  expect(v.safeParse(v.object({ code: v.string() }), { code: 'otter-4821' }).success).toBe(true)
  expect(v.safeParse(v.object({ code: v.string() }), { code: 1 }).success).toBe(false)
  expect(ignore().add('.env*').ignores('.env.local')).toBe(true)
  expect(createPatch('a.md', 'x\n', 'y\n')).toMatch(/^\+y$/m)
})
