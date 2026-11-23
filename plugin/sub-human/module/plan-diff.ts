// The diff between two versions of a plan's text, for the review pane (ARCHITECTURE §7 "Group plan" step 3; U10).
// Pure; the one module-side use of the vendored diff, so `claude plugin validate` type-checks that import.
import { createPatch } from '../vendor/diff/index.js';

/** A unified diff of plan `name` from `before` to `after`, without the file header lines. */
export function planDiff(name: string, before: string, after: string): string {
  return createPatch(name, before, after).split('\n').slice(4).join('\n');
}
