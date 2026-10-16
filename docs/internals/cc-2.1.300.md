# Claude Code 2.1.300: what changed for sub-human (reported, not probed)

This note is a delta against [`cc-2.1.296.md`](cc-2.1.296.md). Unlike the earlier notes, it was **not** written from a read of the 2.1.300 binary: no machine with 2.1.300 was at hand, and `PROBED_VERSION` (`lib/cc/contract.json` `probed`) stays `2.1.296`. It records what issue #8 reported, so that the contract, `npm run probe` and `sub-human doctor` say so on that version. Another change owns the fix.

## Per entry

| Entry | § | Class | What was reported | Contract |
|---|---|---|---|---|
| `session-append-notice-rewrite` | 10 | **b** (reported) | An `@room` post's receipt is a UserPromptSubmit stop (`ups-stop-frame`): the engine adds a system warning row "Operation stopped by hook: ✓ sent", and `mod/prompt.ts` rewrites that row through `$.session.append` to "✓ sent" (seen live on 2.1.292 and 2.1.296). On 2.1.300 the rewrite was reported not to take: the row keeps the "Operation stopped by hook: " frame before the receipt (#8). | `degraded: [{from: "2.1.300", issue: 8}]` on the entry |

The search string and shapes of the entry may still be found in 2.1.300 (the rewrite door can exist and the warning row bypass it), so a passing probe does not clear it: `degradedOn(version)` (`lib/cc/contract.ts`) names the entry for 2.1.300 and later, `scripts/probe-cc.js` prints it as a NOTE line, `doctor`'s Claude Code check adds "reported changed on this version: session-append-notice-rewrite (#8)" to its detail, and the generated contract table in `docs/ARCHITECTURE.md` marks it.

What the person sees meanwhile: the receipt's words still read as a delivery under the frame ("Operation stopped by hook: ✓ sent"), which `hooks/handlers/at-room.ts` chose for that reason; nothing is lost and nothing reaches the model twice.

When 2.1.300 (or later) can be read: check whether `session.append` still sees the stop's warning row (door `notice`), and whether its `fills`/`keep` path changed (the entry's second shape); then either re-anchor the entry and drop `degraded`, or change how the receipt is shown, and write the result here.
