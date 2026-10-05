# Experiments brief: participant rows + native sign-off

## Context

`sub-human` (`/Users/tristantimblin/repos/sub-human/plugin/sub-human`; see the README) lets humans join a
Claude Code room on one machine. Each person uses their own session:

- `/sub-human` makes a session the orchestrator.
- `/sub-human NAME CODE` joins it as a member.

The room is a log in `~/.sub-human/rooms/<code>/`. A plugin monitor wakes sessions.

Read `docs/native/SYNTHESIS.md` and the `docs/native/NN-*.md` files your experiment cites. Their findings are
your starting point.

The participants are trusted collaborators, so we don't care whether someone could forge a name. Two things
do matter:

- **Human vs. agent.** A Claude must never be able to sign off, or post a human's exact words, on its own.
- **A smooth UX.**

## The target experience

In every session in the room, the agent panel (`↓ to manage`) lists one row per other participant:

```
● main                                   ← you; Enter returns here
◯ orch    ⬡ marmot-2509 · drafting plan b7ca39 · waiting on bob
◯ alice   idle · signed b7ca39
◯ bob     ⚠ reviewing · 1 objection
```

- The **row text** is that participant's live state, computed deterministically from the log and presence
  data, not written by a model.
- **Entering a row** shows that participant's thread: their words, posts, plan revisions and status.
- **Sign-off** is a native form (MCP `elicitation/create`). The room server pushes it to each approver. The
  answer goes straight to the server, with no model turn involved.

## Rules

- **Prototype only in your own copy.** `cp -R` the plugin to `/tmp/exp-<N>/plugin` and edit it there. Use
  `SUB_HUMAN_HOME=/tmp/exp-<N>/home`. Never edit the repo except your report file,
  `docs/experiments/E<N>-<topic>.md`.
- **Don't touch** the running demo (tmux `shd-*`, `/tmp/sh-live`), or `~/.claude` settings and
  `~/.claude.json`.
- **Sessions.** Run them interactively in detached tmux:
  `claude --plugin-dir /tmp/exp-<N>/plugin [--settings …] --model haiku`. Use Opus only where the orchestrator's
  judgment matters.
  - At a trust prompt, choose "Yes, I trust this folder" explicitly.
  - If the user's Ghostty viewers are attached read-only, `tmux send-keys` fails. Use
    `set-buffer` + `paste-buffer`.
- **Clean up.** Kill everything you start. Delete only the plan files you created under `~/.claude/plans/`.
- **Labels and budget.** Label each finding verified-by-probe, verified-by-source or inferred. Keep within the
  budget your task states.

## Report: `docs/experiments/E<N>-<topic>.md`

1. **Setup:** what you built (a diff summary).
2. **Results:** a table with columns criterion · pass/fail · evidence (pane excerpts, log ids, timings, token
   counts and cost).
3. **UX notes:** what it felt like, and what was confusing.
4. **Recommendation:** adopt / adapt / reject, plus the exact changes to make in the real plugin.

Reply to the coordinator in at most 10 lines.
