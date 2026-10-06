# Phase 2 builder brief

## What governs the build

- **The spec** is `docs/next-plan.md`: §2 Architecture and §4 Phase 2, including its owners table, the **Contracts** and the **Tests**.
- **This file overrides the spec** wherever they differ. Its changes come from the spikes in `docs/next/S1-headless-orch.md`, `S2-consent-card.md` and `S3-monitor-resume.md`; read the one for your area.
- **The user's decisions:**
  - Keep the rows: a member sees the room row with the other humans nested inside, and the orch lists every human.
  - Consent is the native question card plus the native plan flow.
  - Shared tasks are the orch's own native task list. There are no settings-file writes and no symlinks.
  - The orch takes no typed input.
  - The plugin stays unprescriptive, and planning is optional.

## Changes from the spikes (these override the plan)

### 1. The monitor runs always

- `monitors/monitors.json` gets `"when": "always"`. S1 and S3 both showed that `on-skill-invoke` doesn't re-arm on `--resume`/`--continue` or on the orch's launch `/sub-human`.
- **B** makes `tail` cheap while the session has no seat: don't call `ps`, and poll at most every 10 s. Once the session has a seat, poll at normal speed.
- The FileChanged + asyncRewake fallback is **not** built.

### 2. Orch spawn (A)

- Spawn in the **joiner's cwd**. `--bg` refuses an untrusted cwd.
- Use a clean env: `env -i` plus `HOME USER LOGNAME SHELL PATH TERM LANG TMPDIR`, plus the `--settings` env from the plan.
- Plan mode runs the orch on Sonnet 5, so there's no `--model` flag.

### 3. No file-written sentinel

At startup, the orch's own text (D) has it create a visible task with native TaskCreate:
- subject "room CODE open";
- status `in_progress`;
- owner `room`.

**F**'s TaskCompleted gate refuses to complete it unless the room is closing.

**Reap (A)**, after the last member leaves:
1. Mark the room `closing` in `members.json`.
2. Send the orch a native SendMessage via `claude` (or append a `to=orch` system entry it is woken for) saying "room closed: complete task 1".
3. Wait up to 20 s, then `claude stop <job>`.
4. Completing every visible task triggers Claude Code's own list cleanup, so we never `rm` in `~/.claude`.

If the list is still there after the stop, leave it. Do not delete it.

### 4. Mirror (F)

PostToolUse fires for refused updates with `success:false`. Skip those.

### 5. Orch input refusal (B, at-room)

- Refuse typed prompts **and** typed slash commands in the orch.
- Allow the `<cross-session-message` envelope and `<task-notification>`.
- Also allow the launch `/sub-human` only when it is the first prompt of the session.

### 6. Consent card (C), from S2

- Rewrite AskUserQuestion **only when the call's input contains the pending proposal hash.** In S2, an unrelated question was hijacked into a stale card.
- Options are `Not yet` (first) / `Agree` / `Object`, with `annotations` notes.
- The preview is the full text when it is ≤2000 chars and ≤20 lines. Otherwise it is a summary plus the path.
- Drop answers with `afkTimeoutMs`, with no `answers`, or with a stale hash. `Not yet` records nothing.
- Post `additionalContext`: "Recorded. Agreeing is not a go-ahead to build; wait for the decision and your people."
- Reminders say the closed card is fine to reopen.
- The member text (D) needs one line saying that when a proposal names you, you call AskUserQuestion with the hash. Without that line, Haiku ignored the monitor line.
- **Proposer:** "propose this" goes to `propose({path})`. Optionally, PostToolUse(ExitPlanMode) may offer to propose, with no deny.

## Known issues from the Phase 0 run (assign to the owners named)

| Owner | Issue |
|---|---|
| **D** | A member's Claude overclaimed consent ("Bob confirmed. Proposal #3 is approved") and posted commitments for its human ("Will implement…"). |
| **D** | A Claude referred to its own human in the third person ("Awaiting alice's go-ahead" said to alice). |
| **B/R** | When another member joined, alice's Claude tried to re-spawn her already-running room row and got a red row-guard error. The member's join notice must not invite a room-row call when the room row is live. |
| **D** | bob's Claude called `mcp__plugin_sub_human_room__post`, with underscores. Give the exact tool names, or rely on the tool list. |

## Rules

- **Edit only the files your owner row lists in the plan's §4 Phase 2 table.** The coordinator owns `hooks/hooks.json`, `.mcp.json` and `monitors/monitors.json`. List the entries you need under "Requests" in your report.
- **The coordinator has already deleted** the plan's subtracted files: `mcp/signoff.js`, `hooks/plan-gate.js`, `hooks/plan-result.js`, `hooks/precompact-note.js`, `statusline/alert.js`, and the main status line. Don't recreate them.
- **Tests:** `node --test plugin/sub-human/test` with zero dependencies. Your tests must pass. Failures in another owner's files aren't yours to fix.
- **Live probes** are optional and cheap:
  - `--model haiku` (the orch will be Sonnet anyway);
  - `/tmp/p2-<owner>/`, tmux sessions `p2-<owner>-*`;
  - launch with `env -i` + `--setting-sources project,local`;
  - kill everything you start.
- **Don't touch:** `sh-*` or numbered tmux sessions, `~/.claude` settings, `~/.claude.json`.
- **Don't commit.**
- **Report**, at most 12 lines: changes, tests, contract deviations, requests, unverified points.
