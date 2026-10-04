# Research context: seat subagents

Shared brief for the research agents. Read this before you start.

## The idea

Several humans work in one Claude session that also runs many agents through subagents.
The thesis: AI makes engineers fast but isolated, and when they're wrong they get further
down the wrong path. Use the time AI saves to plan and build *together*, with the model
always knowing which person said what.

## What exists (in /Users/tristantimblin/repos/sub-human)

- `demo/bin/room`: a Node CLI over an append-only JSONL log (`demo/.room/log.jsonl`).
  Identity is stamped from `$ROOM_USER`, which the launcher sets, so the model never
  declares its own identity. Commands: post / done (runs npm test and attaches the result;
  a bare done claim is rejected) / read / wait / watch.
- `demo/bin/chat`: a human seat with no model in the loop. Typed text is posted verbatim.
- `demo/bin/start`, `demo/bin/launch`: tmux + Ghostty launcher. Each seat is a separate
  `claude` process.
- `.claude/skills/pair-facilitator/SKILL.md`, `demo/personas/*.md`, `demo/PROTOCOL.md`:
  the facilitation rules and the persona briefs.

Lessons from the runs:
- Facilitation and attribution worked.
- The human seat wasn't a real Claude Code session, so the human couldn't read diffs, run
  tests, or build.
- Consent was loose: "done" was inferred from "looks good", and a proposal quietly changed
  one person's condition. Principle: **the channel enforces rules, not the model.**

## The new direction

Use native subagents as much as possible:

- **The orchestrator.** One remote orchestrator agent, with a plugin/skill, lets humans
  "enter the room". It watches every seat and is the **single writer of the shared plan**.
- **Seat subagents.** Each human is a **seat subagent** spawned by the orchestrator. The
  seat is also that human's personal Claude:
  - it forwards the human's words verbatim, tagged as human;
  - it does work on their behalf, tagged "via alice's Claude";
  - it can spawn helpers.
- **Plan sign-off.** Seats send proposals, objections, and sign-offs. Plan approval (e.g.
  ExitPlanMode) is blocked by a hook until every seat has signed.

The first step is a **local spike with no network**: one orchestrator Claude Code session
plus a `seat` agent type. Humans type in a local client, and the room file carries messages.

## Assumptions to test

1. **Long-lived seats.** A background subagent lives for about an hour, mostly blocked
   waiting on a human, without ending and without burning tokens while idle.
2. **Verbatim fidelity.** Human words reach the orchestrator unchanged, ideally as
   tool-carried payload the model can't edit.
3. **Messaging.**
   - A seat can message the orchestrator mid-task. We observed "Message from @<agent-id>"
     arriving in a parent session.
   - The orchestrator can message a running background subagent.
   - Open question: can seats message each other directly, or only through the hub?
4. **Context growth.** The orchestrator sees all traffic, and compaction preserves the
   decision log.
5. **Remote (later).** A cloud session can load a custom plugin and connect out to a relay.

## Environment

Claude Code is at `/opt/homebrew/bin/claude`, version 2.1.281. Resolve the symlink to see
what ships: a JS bundle, a native binary with embedded JS, or something else. macOS has no
`timeout` command; use `perl -e 'alarm N; exec @ARGV'` instead.

## Rules for every research agent

- **Evidence labels.** Label every finding as *verified-by-source*, *verified-by-probe*,
  *documented*, or *inferred*, and cite it (file path + identifier or a short quoted string,
  or a docs URL). Don't dump big blobs.
- **Probes.** Allowed only if cheap and non-interactive, e.g.
  `claude -p --model haiku --max-budget-usd 0.50 ...`, in your own `/tmp/seat-research-<topic>/`
  directory.
  - Never modify `~/.claude`, `~/.claude.json`, or global settings.
  - Never leave processes running.
- **Your files.** Write only your assigned file in `docs/research/`. Other agents are
  working in parallel on other topics.
- **Your reply.** Finish with a reply of at most 10 lines: the key findings, each with its
  evidence label.
