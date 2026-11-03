# 0.7.0 spikes on Claude Code 2.1.296

Method: a throwaway interactive `claude` 2.1.296 in tmux (sessions `s070-*`, all killed), `CLAUDE_CONFIG_DIR=/tmp/probe-070/cfg`, and a scripted mock Messages API (`/tmp/probe-070/mock.mjs`, port 8770; a prompt `CALL <Tool> <json>` makes the model call that tool; `$PLAN` becomes the session's plan file and `$BODY` becomes `/tmp/probe-070/plan.md`). The probe plugin is `/tmp/probe-070/plugin`: a hooks module (`hooks/register.tsx`: `$.ui.ask` Send/Discard, `ui.render` hide/redraw switches, `$.ui.notice`) and a PreToolUse command hook (`hooks/deny.sh`) that denies any Bash/Write/Edit containing `DENYME`. Pane captures are in `caps/*.md` (labels are cited below). Binary reads are from `strings` of `/opt/homebrew/Caskroom/claude-code@latest/2.1.296/claude` (`bin/strings.txt`, `bin/ctx.py PATTERN`).

Note: in this build a plain launch starts in **auto mode**. Manual mode needs `--permission-mode default`, and its footer reads `manual mode on`.

---

## Spike 1: does the mode survive? **Works with caveat**

### Today's path, reproduced
An empty plan file followed by ExitPlanMode gives `Exit plan mode? / Claude wants to exit plan mode / ❯ 1. Yes, and switch to default (ask each time) for this session / 2. No` (caps/auto.md `a11-empty-exit`). The `plan` input is ignored: `ExitPlanMode {"plan":"…"}` with an empty file draws the same dialog (`a12`). Only the plan file's text counts. In the binary, the empty-plan "Yes" always calls `EO("default")`.

### Proposed path, from auto mode (caps/auto.md a1–a9)
1. EnterPlanMode, then the plan is written, then ExitPlanMode. The person sees `Ready to code?` with these options: `❯ 1. Yes, and use auto mode / 2. Yes, manually approve edits / 3. Tell Claude what to change (shift+tab to approve with this feedback)`.
2. The person picks 3 and types a note. The row reads `User rejected Claude's plan: ╭ plan ╮`, and the mode stays `⏸ plan mode on`.
3. `$.ui.ask` Send/Discard while still in plan mode: the dialog draws normally, with a `Planning: <plan file>` header line above it. The answer `"Send"` comes back, and the mode stays plan. The hook log shows `$.ui.ask` goes through AskUserQuestion's PreToolUse.
4. ExitPlanMode again with the non-empty plan shows **the same full `Ready to code?` dialog again**, with `1. Yes, and use auto mode` preselected. Pressing Enter gives `⏵⏵ auto mode on`, so **auto survives**.

### Proposed path, from manual mode (caps/def.md d0–d8)
The dialogs are identical, and **`1. Yes, and use auto mode` is still preselected**. The person must pick `2. Yes, manually approve edits` to land back in manual mode, which they did. If they press Enter, a manual-mode person is switched into auto.

### Why (binary, function `jot`)
- The keep-context rows come from what is *available*, not from `prePlanMode`.
- If bypass is available, the bypass row is offered. Otherwise, if auto is available and the gate is on, the `"Yes, and use auto mode"` row (`yes-resume-auto-mode`) is offered. Otherwise the acceptEdits row is offered.
- A default row is always offered.
- Default focus (`On`) only moves to the default row when `proactivityLevel==="ask"` and no auto row exists. So focus is the first row.
- No row restores `acceptEdits`.

### Caveats of the non-empty exit
- **The model reads approval.** The tool_result is `User has approved your plan. You can now start coding. … ## Approved Plan: <plan file>`, plus an `Exited Plan Mode` system message.
- **The transcript shows approval.** It reads `⏺ User approved Claude's plan ⎿ Plan saved to … <plan body>`.
- **The fix for both:** the plan file must be rewritten to a non-actionable closing text before the second exit, for example `Room plan · paging v2 · your note went to maya. Nothing to build.`. The ToolResult row can then be hidden (spike 2).
- **The empty exit reads neutrally.** It gives the model `User has approved exiting plan mode. You can now proceed.` and draws a `⏺ Exited plan mode` row (caps/rule.md `m-empty-yes`).

### Other native ways out of plan mode (none restores an arbitrary prior mode)
- **shift+tab from plan always goes to auto first.** The cycle is plan → auto → manual → accept edits → plan, the same from both origins (`a10-*`, `d9-*`). So one press restores auto, and a manual person needs two.
- **ExitPlanMode's own `call()` restores `prePlanMode`** (`mode:l, prePlanMode:void 0`), but only when it runs while the mode is still plan with no dialog, which needs a permission allow. A settings allow rule `ExitPlanMode` does **not** skip the dialog (`rule-exit`). Only a PermissionRequest/PreToolUse allow would, and that is forbidden.
- **Type a note, then shift+tab** ("approve with this feedback"). This approves the plan and goes to **auto** even from manual (`rule-shifttab-feedback`), and the model gets "approved" plus the note as a user message. Not usable.
- **`Exit plan mode? Yes` (empty plan)** always goes to **default**, which is exactly a manual person's mode.

### What 0.7.0 should do (better than the plan's fallback)
Keep Send/Discard first, while still in plan mode. Then pick the exit by the mode the person had before review (`permission_mode` in the hook payload when the review opens):
- **auto:** use a non-empty plan file whose text is the closing line (not the plan). The dialog is `Ready to code?` with `1. Yes, and use auto mode` preselected, and Enter keeps auto. Hide its `User approved` ToolResult row.
- **default/manual:** use an empty plan file. `Exit plan mode? 1. Yes, and switch to default (ask each time)` is preselected and keeps manual. The text is neutral.
- **acceptEdits:** no exit keeps it. Use the empty exit (→ manual) and the plan's heading line `shift+tab restores yours` (one press from manual reaches accept edits).
- **bypassPermissions** (code read only): the non-empty dialog offers the bypass keep-context row first.

Still ask Claude Code for a keep-prior-mode exit: both the focus rule and the row set ignore `prePlanMode`.

---

## Spike 2: `ui.render` and the plan dialog. **Title: no. Rows: works**

### The "Ready to code?" title and body: no
- `RenderComponent` in the typings and in the binary's zod enum has 15 names: `AskUserQuestion, UserMessage, AssistantMessage, ToolUse, ToolResult, ToolGroup, ToolProgress, CommandOutput, Spinner, TurnDuration, InfoNotice, SessionMode, PromptHint, AbovePrompt, Pane`. None of them is a permission dialog.
- The typings say: "The permission dialog is drawn by the engine alone … a plugin adds context with `$.ui.notice`".
- In the binary, `title:"Ready to code?"` and `"Claude has written up a plan and is ready to execute. Would you like to proceed?"` are literals in the ExitPlanMode permission component, with no render site.
- `$.ui.notice(tool_use_id, …)` from PreToolUse returned without error at 400 ms and 1500 ms, but **no line was drawn** under this dialog (`r9-notice-pretooluse`). `tool.call` for ExitPlanMode only runs after the dialog is answered.
- **So:** the plan's first line carries the frame, as in the fallback. It does show, as the first line of the plan box under `Here is Claude's plan:`. The title goes to Claude Code as a request.

### Hiding the rows (caps/r.md): works
- **`Entered plan mode` / `Claude is now exploring…`** is the **ToolResult** of `EnterPlanMode`. Returning `<Box/>` hides it, including retroactively after `$.ui.invalidate('ui.render')` (`r5-enter-hide-res`).
- **`User rejected Claude's plan: ╭ … ╮`** is the **ToolResult** of `ExitPlanMode` (props `isErrored:true`, `output:"Error: The user doesn't want to proceed … the user said:\n<note>"`). `<Box/>` hides it whole (`r4-rejected-hide-res`).
- **`User approved Claude's plan ⎿ Plan saved to …`** is also the ExitPlanMode **ToolResult**. A ToolUse redraw only adds a line above it (`r7-approved-redraw`). Hide or redraw the ToolResult.
- **PreToolUse deny on Write (the save):**
  - Live it draws a red-211 `⏺ Updated plan` and a red-211 `⎿ Error: PreToolUse:Write hook error: <reason>` (`r1-write-deny-baseline`).
  - Hiding the **ToolResult** (`isErrored`) removes the `Error:` line and leaves `⏺ Updated plan` (`r2-hide-res`, though its bullet stays red).
  - Hiding the **ToolUse** too removes both.
  - A Bash deny folds into a dim `Ran 1 shell command` ToolGroup with no `Error:` shown.
- **Gate the hides tightly.** Match on `tool` plus `isErrored` plus sub-human's own state ("a review is open"), so a person's real plan mode and real errors still draw. The props carry no reason field, but `output` holds the deny text, and that text can be matched.

---

## Spike 3: task #1 `_internal` and the 5-second auto-reset. **Works (no interference)**

### Binary: the task-list store class `n4n`, plus `hus` (resetTaskList)
- On every read: `r = all.filter(t => !t.metadata?._internal)`.
  - If some visible task is not completed, or `r` is empty: no reset is armed, and an empty `r` hides the list.
  - Otherwise (every visible task completed): arm a 5000 ms timer.
- When the timer fires, it re-reads **all** tasks, unfiltered, and resets only if `e.length>0 && e.every(completed)`.
- `hus` re-checks every file under the list lock and returns `false` on any non-completed task.
- `hus` has one caller.
- So an `_internal` task that is `in_progress` blocks the reset exactly as a visible one does. `_internal` only changes what is displayed: the TaskList tool and compaction carry filter it too.

### Live (CLAUDE_CODE_TASK_LIST_ID=sh-PROBE, CLAUDE_CODE_ENABLE_TODO_TOOLS=1; caps/t.md)

| Case | Tasks | Shown | Files after 13 s |
|---|---|---|---|
| E (control, today) | #1 visible in_progress, #2 and #3 done | `3 tasks (2 done, 1 in progress)` with `◼ room PROBE open` | kept |
| A | #1 `_internal` in_progress, #2 and #3 done | `2 tasks (2 done, 0 open)` | **kept (no reset)** |
| B | #1 `_internal` done, #2 and #3 done | hidden | **all deleted** (reset, as today) |
| C | #1 `_internal` in_progress only | no task list at all | kept |
| D | #1 `_internal` done only | hidden | kept (an empty visible list never arms the reset) |

Live transitions:
- **F:** #1 `_internal` in_progress and #2 pending. Completing #2 gives `1 tasks (1 done)`, kept after 12 s.
- **Then completing #1** (the reaper's close) deletes every file within 10 s.

One display note: a list whose visible tasks are all pending started collapsed (`ctrl+t to show tasks`), and with `_internal` the same happens to a room's list. That is unrelated to the reset.

### What 0.7.0 should do
- Mark task #1 `metadata._internal: true` and keep it `in_progress` until close.
- The reset still never fires while the room is open, and an empty room shows no task list.
- Closing (completing #1) still triggers the native reset, as long as at least one visible task exists. Otherwise the reaper's `remove` deletes the folder, as today.
- No change to `ownedDir`, `.highwatermark` or lock handling is needed.
