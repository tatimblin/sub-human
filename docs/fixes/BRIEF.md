# Brief: propose fixes for the issues found in the walkthrough

## Evidence

- **Walkthrough** (all 50 checks passing): `docs/rebuild/walkthrough.html`.
- **Raw pane text:** `docs/rebuild/screens/*.txt`, one file per scene and session. The run was room `vole-8126`.
- **Room log:** `/tmp/sh-demo/home/rooms/vole-8126/log.jsonl`, with `mcp-debug.log` in `/tmp/sh-demo/home`.
- **Transcripts:** `~/.claude/projects/-private-tmp-sh-demo-{orch,alice,bob}/*.jsonl`. Read them; don't modify them.

## Context

The plugin is `plugin/sub-human`. Read its README, `docs/rebuild-plan.md` and `docs/rebuild/BUILD-BRIEF.md`.

The likely direction is the slim, unprescriptive rebuild in `docs/native2/SYNTHESIS.md`, with backing research in `docs/native2/01–06`. For each issue, propose two fixes:
- **(a)** a fix for the current plugin;
- **(b)** what the slim design does about it. That may be "gone by design", but say why.

## Issues

| # | Issue | Evidence |
|---|---|---|
| 1 | **Row views take input.** Opening the room row shows "Message @sub-human:room…". What you type goes to the Haiku row agent. | alice S11b |
| 2 | **Claudes misquote room entries.** After `/clear`, alice's Claude paraphrased orch #22 wrongly: "plan said to clamp…" instead of "stale cursor → 400". | alice S11 |
| 3 | **The orch acted on stale membership.** bob left (#23) and rejoined (#24) within 3 s. The orch still posted #25 "bob has left…", then retracted it in #26. | log #23–26, orch S11 |
| 4 | **Stale reminders.** bob's Claude said "Plan … still waiting for your sign-off" after events had overtaken it. Notices are narrated one at a time. | bob S8–S11 |
| 5 | **An unprompted PushNotification** from alice's Claude. "Invalid tool parameters" showed on screen. | alice transcript `9eab63ac…` |
| 6 | **"Monitor event" + narration** fills member panes, and each one costs a turn. | all member panes |
| 7 | **"Waiting for N background agents to finish"** appears after every turn, because of the rows. | all panes |
| 8 | **The orch's normal sign-off wait renders as a red hook error:** "Error: PreToolUse:ExitPlanMode hook error: ROOM-GATE…". | orch S5–S8 |
| 9 | **A "UserPromptSubmit operation blocked by hook" header** appears on every `@room` post. | alice S4 |
| 10 | **After `--continue`, rows return only after the first prompt.** | bob S11 |
| 11 | **Member Claudes offer prescriptive drafts:** "Would you like to draft a reply? For example: @room …". | alice S11–S12 |

## Rules

- **Research and propose only.** Write only your own output file, `docs/fixes/<your-file>.md`.
- **Don't touch:**
  - tmux sessions `sh-*` or numbered ones;
  - `/tmp/sh-demo`, which is read-only to you;
  - `~/.claude`, `~/.claude.json` or settings files.
- **Optional probes** use `--model haiku` in `/tmp/fx-<letter>/` and tmux sessions `fx-<letter>-*`, at most about $0.50 each.
  - At the trust prompt, choose "Yes, I trust this folder".
  - Kill everything you start.
- **Search the binary** at `/opt/homebrew/Caskroom/claude-code@latest/2.1.281/claude` with `strings` for native behaviour: what renders as an error, what has no input box, and so on.
- **Label every claim:** verified-by-probe, verified-by-source or inferred.

## Output: 40–90 lines per file

For each issue:
1. **Root cause**, with evidence.
2. **Fix (a), current plugin:** the exact change (files and functions), its size, and its risk.
3. **Fix (b), slim design.**
4. **How to verify it.**

Reply to the coordinator in at most 8 lines.
