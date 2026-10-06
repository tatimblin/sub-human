# Brief: using native Claude Code to let humans join a session

## Goal

Humans should be able to join a Claude Code session the way a session spawns subagents. Each
human is a first-class participant: the system knows who said what, the session coordinates
everyone, and each human keeps their own Claude for real work. The project should rely on
native Claude Code features wherever possible, and custom code only where there is no native
equivalent. Native features are better supported and will improve over time.

## What exists today

The `sub-human` plugin lives in `/Users/tristantimblin/repos/sub-human/plugin/sub-human`; its
README describes it.

- **Starting and joining.** `/sub-human` makes a session the orchestrator. `/sub-human NAME CODE`
  joins from another normal Claude Code session on the same machine.
- **The room.** It is an append-only log on disk (`~/.sub-human/rooms/<code>/log.jsonl`).
- **Identity.** It is bound at join by a `UserPromptExpansion` hook and resolved by process
  ancestry.
- **Plugin parts:**
  - a plugin monitor tails the room and wakes sessions;
  - an MCP server provides `post`, `read`, `plan` and `watch`;
  - `@room` posts the human's exact words through a `UserPromptSubmit` hook;
  - a background `room` subagent shows the feed in the agent panel;
  - status line scripts.
- **Plan approval.**
  - The orchestrator writes the plan in plan mode with frontmatter approvers it chose.
  - Each member approves it with Claude Code's native ExitPlanMode dialog. PreToolUse and
    PostToolUse hooks turn that approval into a sign-off.
  - The orchestrator's gate allows ExitPlanMode only after every approver has signed.
- **Long work.** It runs in native background subagents. Results are posted as `status`
  entries.

Background research is in `docs/research/01..04`, `docs/spike-results*.md` and
`docs/experience-eval-1.md`. Claude Code 2.1.281 is installed at
`/opt/homebrew/Caskroom/claude-code@latest/2.1.281/claude`. It is a Bun binary, so search it
with `strings … | grep`. Official docs are at code.claude.com/docs and docs.claude.com. Use
`claude --help` and the subcommand help.

## Rules for every agent

- **Research only. Don't modify anything** in the repo except your own output file
  `docs/native/NN-<topic>.md`.
- Don't touch the running demo: tmux sessions `shd-*` and `/tmp/sh-live`.
- **Probes** must be cheap (`--model haiku`, `--max-budget-usd 0.50`, at most about $1 total)
  and run in your own `/tmp/native-<NN>/`. Kill every process you start.
- Never modify `~/.claude`, `~/.claude.json` or any settings file.
- **Label every finding:** verified-by-source, verified-by-probe, documented or inferred. Cite
  the source: a binary string, a docs URL, or a probe output excerpt.

## Output file

The output file holds 60–120 dense lines, in this order:

1. **Capability:** what this native feature does, precisely.
2. **Mapping:** how it could serve "humans join like subagents" (identity, joining, messaging,
   waking, visibility, approval/consent, doing work). Be concrete.
3. **Replaces / simplifies:** which custom plugin pieces it could replace, and what would still
   be needed.
4. **Limits and risks:** single account, experimental flags, interactive-only, and so on.
5. **Recommendation:** adopt now / adopt later / don't adopt, with the one experiment that
   would settle it.

**Reply** to the coordinator in at most 8 lines: the recommendation and the strongest evidence
for it.
