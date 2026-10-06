# A: rows (issues 1, 7 and 10)

Claude Code 2.1.281. "src" means verified-by-source (the JS embedded in the binary). "probe" means verified-by-probe: Haiku in `/tmp/fx-a`, tmux `fx-a-*`, final runs under `env -i` with `--setting-sources project,local`, all processes killed. "inf" means inferred.

## 1. Row views take input

**Root cause.**
- The placeholder function (`pie`) returns `Message @<name>…` whenever an agent is being viewed. Nothing can turn this off: there is no read-only flag for agents, in frontmatter or anywhere else (src).
- On submit, every non-leader view goes to `submitToAgent`. Only local slash commands are refused there (src).
- `submitToAgent` echoes the text into the view at once, so it looks sent. Then:
  - If the agent is running, the text goes into `task.pendingMessages` with `origin:{kind:"human"}`. It is drained only at the agent's next tool boundary, and never interrupts the tool (src: `yEt`, `BHo`).
  - If the agent has finished, the text resumes it (src: `vV`).
- **No UserPromptSubmit fires** for text typed into an agent view (probe: hook log shows only `SubagentStart` with `agent_id`/`agent_type` and no prompt field, then `SubagentStop`).
- PreToolUse/PostToolUse do fire inside the row, with `agent_id` (probe). None of them carries the typed text.
- Consequence:
  - A participant row's `hold` blocks until STOP (`mcp/hold.js` header), so text typed into bob's row is silently held, possibly for the whole room, and then reaches Haiku at STOP.
  - In the room row it reaches Haiku at the next JOINED/RESPAWN (inf, from `BHo` and `hold.js`).
- So input can be neither removed nor refused at submit time. A hook can only react afterwards.

**Fix (a), current plugin** (in order of value):
1. **Say it where the input is.** `mcp/hold.js` `progress()` already streams `⎿ #26 facilitator → bob …` right above the input box. Add a fixed suffix, `· read-only: talk in main (↑) with @room`. Size: about 3 lines in `entryLine`/`progress`. Risk: low, because `clip` caps the line at 200 characters.
2. **Answer once if the text gets through.**
   - Add one line to `agents/room.md` and `agents/participant.md`: "a message that is not a hold result: answer only `read-only row — type in main with @room`, then hold again."
   - Add a `SubagentStart` hook with `agent_type` matching `sub-human:(room|participant)` that injects the same rule as `additionalContext`. This covers a finished row resumed by typing (probe: SubagentStart fires on that resume).
   - Size: about 15 lines. Risk: low. It costs one Haiku turn per stray message.
3. **Optional redirect, not recommended.**
   - A PreToolUse hook on `mcp__plugin_sub-human_room__hold` would read `subagents/agent-<agent_id>.jsonl`, which sits next to `transcript_path`, for `queued_command` entries with `origin.kind=="human"`. It would then post them as this seat's `@room`.
   - It only works at hold boundaries, so it never helps participant rows. It also turns a stray keystroke into speech. Risk: medium. Skip it.

**Fix (b), slim design.** The rows are gone, so this issue goes with them. What remains is the orchestrator in the agent view. Peek-reply and attach type into it with `origin human/typed` (02 probe).
- That is a real main-thread prompt, so UserPromptSubmit runs in the orchestrator's own process (inf).
- An orchestrator-only hook should block any prompt that does not start with `<cross-session-message` or `<task-notification>`. It should answer: "the orchestrator takes no typed input; use @room in your session". About 20 lines.
- Probe first that peer deliveries pass through this hook with that envelope (the body format is in 01:23).

**Verify.**
- Open a row, type `x`, and press Enter. The view should show the read-only hint, and the room log should get no entry.
- After the next JOINED, the room row should answer in one line and then hold again.
- In the slim design, attach to the orchestrator and type. The prompt should be refused, and the orchestrator's transcript should have no turn.

## 7. "Waiting for N background agents to finish" after every turn

**Root cause.**
- The line is the `turn_duration` system row (`Sg`). It shows `Waiting for N background agents to finish` instead of `Baked for 3s · done …` whenever `Rhe(tasks).pendingAgents > 0` (src).
- `Rhe` counts every `local_agent` with `isBackgrounded` that is running, or finished and not yet notified. It excludes only `agentType:"main-session"` and fork workers (src: `DE`).
- There is no per-agent or frontmatter exclusion (src). The rows are background agents that never finish, so the line shows on every turn: 139 of 159 hits in `screens/*.txt` read "2 background agents".
- `showTurnDuration:false` hides the whole line (src: `He=!O&&!z&&!je`). A plugin cannot set it, because plugin `settings.json` accepts only `agent` and `subagentStatusLine` (src: `Wpe`).
- A finished row is no help either. It drops out of the panel list within seconds (probe: `/tasks to see subagents`, nothing under main), so a "spawn and finish" row would not stay visible.

**Fix (a), current plugin.**
- **Cut N for members** by folding participant rows into the room row's status text. Then N is 1 and the line reads "1 background agent". Size: medium, touching `lib/rows.js`, `room.md` and `hold.js`. It does not remove the line.
- **Removing the line** needs `showTurnDuration:false`. The only route is writing it to `.claude/settings.local.json` from `join.js` as an explicit opt-in (`/sub-human NAME --quiet`). That also hides "Worked for Ns". Risk: it changes a file the user owns. Better to keep the README note (line 66) and offer the opt-in.

**Fix (b), slim design.** The line is gone by design. The orchestrator is a separate `--bg` daemon session, not a task in the member's registry, so `Rhe` never counts it (src + 02). The narrowed monitor is a `local_bash` monitor, which `Rhe` does not count. It shows instead as a dim suffix, `✻ Baked for 3s · done 11:56 AM · 1 monitor still running`, which is the one form seen in `screens/S*-bob.txt`. Accept that, or use `showTurnDuration:false`, which hides it too.

**Verify.** Run S2–S10 and count `Waiting for` lines in the panes. The slim design should have 0, and the current plugin with folded rows should never exceed 1.

## 10. After `--continue`, rows return only after the first prompt

**Root cause.**
- Rows are in-memory tasks. `--continue` restores none of them (probe; bob S11-2: `Background agent "vole-8126" didn't finish before the previous session ended`).
- `session-restore.js` puts the `RECREATE` text into `additionalContext`, and the model reads that only on the next prompt.
- SessionStart's `initialUserMessage` exists in the schema. Interactive mode ignores it, at both `startup` and `resume` (probe: the hook emitted it and no turn ran).
- Its only consumers are the headless and SDK paths (src: `Xlr()` → `prependUserMessage` / `startSessionStartHooks`).

**A native trigger does exist (probe).**
- A SessionStart hook with `"asyncRewake": true` that exits 2 wakes the model with its stderr, with no user prompt. This works on `resume` and on `startup`.
- Told to re-create a row, Haiku called Agent(`run_in_background`) by itself.
- The UI shows `⏺ <rewakeSummary>` (default "Stop hook feedback"; probe: `"rewakeSummary":"sub-human: restoring rows"` rendered). `rewakeSummary` is marked `@internal` in the schema and may change.

**Fix (a), current plugin.**
- Add `hooks/row-rewake.js` under `SessionStart` with matcher `resume` and `{"asyncRewake":true,"rewakeSummary":"sub-human: restoring rows"}` in `hooks.json`. It should:
  - poll for up to 3 s until `resolveMe` finds the seat (it runs concurrently with `session-restore.js`);
  - compute `rows.rowsNeeded(code, me, {held})`;
  - if anything is missing, write `RECREATE + rows.rowCalls(me, members, {only})` plus "Write no text." to stderr and exit 2;
  - otherwise exit 0.
- `row-guard.js` already denies duplicates, so a later prompt cannot double-spawn.
- Size: about 40 lines plus one `hooks.json` entry. Risk: low to medium. It costs one model turn on every resume, on the member's own model, with a cold cache. The model may add a sentence. The "Waiting for N…" line returns immediately afterwards.

**Fix (b), slim design.** The issue is gone by design: there are no rows to re-create, and the orchestrator lives in the daemon and survives the member's restart (02). SessionStart(resume) keeps only the synchronous re-bind and `sessionTitle`. If anything in the slim design ever needs a turn at resume, use `asyncRewake`, as in (a).

**Verify.** Join, wait for rows, `/exit`, then `claude --continue`.
- Within about 10 s and with no typing, the panel should show the `vole-8126` row.
- The log should get one `member_joined … rejoined (resumed)`.
- `rows/` should show one new room row.
- A following prompt should spawn nothing: `row-guard` denies it.
