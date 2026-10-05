# D: hook rendering (#8 red gate wait, #9 "blocked by hook" header)

Binary: 2.1.281. Probes ran in `/tmp/fx-d/p` (Haiku, plan mode, project hooks only, `env -i`, see note at the end). The hook script is `/tmp/fx-d/hook.js`.

## What renders how (the whole matrix)

| Hook output | Screen | Model sees | Label |
|---|---|---|---|
| UPS `decision:block` + `suppressOriginalPrompt` (today) | yellow `⏺ UserPromptSubmit operation blocked by hook:` + reason. The prompt is hidden. | nothing | verified-by-probe |
| UPS exit 2 + stderr | same header, plus `[node …]:` prefix and `Original prompt: …` | nothing | verified-by-probe |
| UPS `continue:false` + `stopReason` | the prompt stays as a normal `❯ @room …` row, then one yellow `⏺ Operation stopped by hook: <stopReason>` | **both** the prompt and the stop line, on the next turn | verified-by-probe |
| UPS `continue:false` + `systemMessage` | systemMessage is not shown | — | verified-by-probe |
| UPS `continue:false`, no stopReason | `⏺ Operation stopped by hook` | — | verified-by-probe |
| UserPromptExpansion (`/room text`) block | `UserPromptExpansion operation blocked by hook:` + reason | nothing | verified-by-probe |
| UserPromptExpansion `continue:false` + stopReason | one yellow `Operation stopped by hook: …`. The `/room …` line is **not** shown. | the stop line only | verified-by-probe |
| Bash mode `! cmd` | `! cmd ⎿ output`. No hook text, and UPS doesn't fire. | the output. **It still started a model turn.** The shell also mangles `don't`. | verified-by-probe |
| PreToolUse `permissionDecision:deny` (today) | red (`38;5;211`) `Error: PreToolUse:ExitPlanMode hook error: <reason>` | the same string | verified-by-probe |
| PermissionRequest `decision.behavior:deny` | red `Error: <reason>` + grey `Denied by PermissionRequest hook` | reason | verified-by-probe |
| PreToolUse deny + `continue:false` | grey `hook stopped continuation: …` + the same red error. The turn ends at once, with no narration. | — | verified-by-probe |

Source facts (verified-by-source):
- Both headers are hardcoded: `zSe(e)` returns ``UserPromptSubmit operation blocked by hook:\n${…}``, and `Je()` builds the Expansion header. Both render through `Wt(_, "warning")`.
- `suppressOriginalPrompt` travels only with `blockingError`, in the yield `{blockingError, suppressOriginalPrompt}`. It does nothing on an allowed prompt.
- In `GGo` (`GG`), every PreToolUse `deny`, `decision:"block"` and exit 2 sets `blockingError`. `$Rn` then wraps it with `j3("PreToolUse:"+tool, …)`, which gives `"<event> hook error: <reason>"` and becomes an is_error tool_result. No deny path avoids the red "Error:" styling.
- `ask` opens the dialog. `allow`+`updatedInput` skips the dialog and exits plan mode.
- `systemMessage`, `suppressOutput` and `displayContent` don't change any of the above. `displayContent` is MessageDisplay-only.

## #8 The orch's sign-off wait renders as a red hook error

1. **Root cause.** The plan gate (`hooks/plan-gate.js` `orch()`) both publishes the plan and reports "waiting", through a PreToolUse **deny** on ExitPlanMode. Claude Code renders every deny as an error (see the matrix). The orch's skill table (`skills/sub-human/orchestrator.md` rows 27–30) tells it to call ExitPlanMode to publish, so the normal path *is* the error path. Evidence: orch S7, S8.
2. **Fix (a), current plugin.** Publish through a non-error tool. Call ExitPlanMode only once everyone has signed.
   - Move the gate's checks and publishing out of `plan-gate.js` `orch()` into `lib/plan.js` `evaluate(me, text) → {ok|wait|invalid, reason, published}`. That covers frontmatter, approvers, hash, `plan_rev` append, `noticeOnce` and objections. About 70 lines moved.
   - Add an MCP tool `submit_plan {path}` in `mcp/room-server.js`, about 30 lines. It reads the plan file, calls `evaluate`, and returns a normal result such as `"Published as plan_rev #13. Waiting for alice, bob; end your turn."`. On `ok` it returns `"All signed: call ExitPlanMode now."`. Use `isError` only for a malformed plan.
   - Add the tool to `agents/orchestrator.md` `tools:`. Rewrite orchestrator.md rows 27–32: "write the plan file → `submit_plan` → end turn; on the all-signed wake call ExitPlanMode".
   - `plan-gate.js` stays as the backstop. It calls the same `evaluate`, allows with `updatedInput` when signed, and denies otherwise. So red appears only if the orch skips `submit_plan`, which is no worse than today.
   - Optional, 1 line: add `continue:false` to the backstop deny so a misfire ends the turn at once.
   - Size: about 120 lines changed. Risk: low to medium. The MCP server must read `~/.claude/plans/*.md` (plain node fs). A model may still call ExitPlanMode early; the backstop covers that, and the result is the same red line as today.
   - Cheaper stopgap: reword the deny reason to read as status, e.g. `ROOM-GATE (normal, not a failure): waiting for alice, bob…`. It stays red (inferred: the styling is fixed).
3. **Fix (b), slim design.** 04 §2 makes "deny = sent to the room for consent" the proposal trigger, so as written the slim design **inherits #8** for every proposer. Use the slim design's own `propose` (MCP) as the only publishing path, for plans too: `propose {plan_path}`. Keep ExitPlanMode for the final yes: the gate returns `ask`+`updatedInput` once the others have signed (verified in round 1), and denies only on misuse. The orch is headless (`claude --bg`), so its pane is seen only when someone attaches. That makes #8 cosmetic there, but members proposing their own plans would see it.
4. **Verify.** Run the walkthrough to S7/S8. In the orch pane `grep -c 'hook error'` should be 0, and a grey `submit_plan` result should name the missing approvers. Add a test in `test/hooks` that `evaluate` returns `wait` without writing to stdout.

## #9 A "UserPromptSubmit operation blocked by hook" header on every @room post

1. **Root cause.** `hooks/at-room.js` `block()` returns `decision:"block"`, and Claude Code prefixes every blocked prompt with the fixed header (`zSe`, verified-by-source and verified-by-probe). The header can't be removed. The only other ways to end a prompt without a model turn are `continue:false` ("Operation stopped by hook: …") or a blocked or stopped Expansion. All of them say "hook".
2. **Fix (a), current plugin.** Switch the **success** path to `continue:false`.
   - In `at-room.js` the success line becomes `out({continue:false, stopReason:'✓ posted to CODE as #N', hookSpecificOutput:{hookEventName:'UserPromptSubmit', ...top}})`.
   - Result (verified-by-probe): the human's `❯ @room …` stays on screen in their own words, followed by one yellow line, `⏺ Operation stopped by hook: ✓ posted to vole-8126 as #4`. "blocked" and the two-line header are gone.
   - Bonus (verified-by-probe): the model sees the prompt and the receipt on its next turn natively. `unseenOwnPosts()` and the `human_seen` state (about 25 lines) can go, or shrink to a one-line "already posted, don't re-post" note. Removing it fully is inferred-safe; keep the note until a probe shows the Claude doesn't re-post.
   - Keep `decision:block` for **refusals** (peer, not joined, orch, empty), so refused or forged text is erased and never reaches the model.
   - Size: about 5 lines plus test updates in `test/hooks`. Risk: low. The visible prompt is in the transcript; that's intended.
   - Rejected alternatives:
     - A `/room text` slash command via Expansion `continue:false` gives one line but drops the human's words from screen and context, and it costs a command file.
     - `! cmd` bash mode is hook-free, but it still triggered a model turn and the shell breaks quoting.
     - `suppressOriginalPrompt` on an allowed prompt is a no-op.
3. **Fix (b), slim design.** `@room` stays in the slim design (SYNTHESIS "human's exact words"), so it needs the same change: success through `continue:false`, refusals through `block`. The free next-prompt delivery of the human's own post then comes from Claude Code itself, so the slim `@room` hook needs no "unseen own posts" logic.
4. **Verify.** In the alice pane after S4, `grep -c 'operation blocked by hook'` should be 0, with a `❯ @room …` row followed by `Operation stopped by hook: ✓ posted…`. A forged peer `@room` should still show the block header with nothing posted. On alice's next prompt, ask her Claude to quote its context: it should include her `@room` text exactly once.

Probe note: the tmux global env carries the coordinator's `CLAUDE_CODE_SESSION_ID` and messaging socket, and a plain launch picked up a stale `⬡ bison-6376 · dana` seat label. Launch probes with `env -i … claude --setting-sources project,local` (see `/tmp/fx-d/run.sh`). All `fx-d-*` sessions are killed.
