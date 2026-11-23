import type { On } from 'claude-code'
import * as v from '../vendor/valibot.mjs'
import ignore, { isPathValid } from '../vendor/ignore.mjs'
import { createPatch } from '../vendor/diff/index.js'

// A placeholder until U8: it uses each vendored file, so `claude plugin validate` type-checks module imports of them.
const Ok = v.object({ ok: v.boolean(), patch: v.string() })

/** Wires the module's hooks (none yet). */
export function register(_on: On): void {
  v.parse(Ok, { ok: isPathValid('a') && !ignore().ignores('a'), patch: createPatch('a', '', '') })
}
