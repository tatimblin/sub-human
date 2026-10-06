# Brief, round 2: lean on native Claude Code and keep the plugin out of the way

## Goal (the user's words)

> "Sub agents work amazingly so just plugging in to that as much as possible seems smart. This plugin should be as unprescriptive as possible. Just enter a session through a join and work in it however a sub agent or human might — this just lets multiple human sessions [work together]."

The target experience:
1. A person runs `/sub-human NAME` in their own normal Claude Code session.
2. From then on they work exactly as they normally would.
3. The room lets several human sessions see each other and coordinate the way a session and its subagents already do: spawning, messaging, status, results, consent.
4. Anything the plugin injects, forces or adds to the UI has to justify itself.
5. **Unprescriptive:** the plugin must not dictate how people or their Claudes work. It gives no workflow rules, no role scripts and no forced rituals. It supplies only the mechanics: join, attribution, visibility and consent. Facilitation is optional behaviour on top.
6. **Planning is optional too.** Collaborators may just talk, pair, or split work with no shared plan, though they usually will plan. Consent and sign-off apply only when someone proposes something that needs everyone's agreement. Nothing should assume a plan-first flow. Planning starts the native way: a member enters plan mode themselves, or tells the orchestrator "let's plan X". The shared plan and its sign-off follow from that.

## What exists now

The plugin lives in `plugin/sub-human`; read its README, then `docs/rebuild-plan.md` and `docs/rebuild/BUILD-BRIEF.md`.

It currently has:
- a room log on disk;
- a monitor that tails the log;
- an MCP server with the `post`, `read`, `plan`, `hold` and `review` tools;
- hold-based proxy rows in the agent panel;
- an elicitation sign-off form;
- an orchestrator plugin agent and a plan-mode gate;
- about 10 hooks;
- role text of about 6k characters injected at join.

Round 1 of the research is in `docs/native/01–10` and `SYNTHESIS.md`. **Don't repeat round 1.** Go deeper, check whether its conclusions still hold, and look for features it missed.

## A strong lead to examine

This session runs Claude Code 2.1.281 and exposes these tools:
- `SendMessage` and `ListAgents`, which list subagents, teammates, *other local Claude sessions on this machine*, and cloud and Remote Control sessions;
- agent hand-back messages, shown as "Another Claude session sent a message";
- `TaskCreate`, `TaskList`, `TaskUpdate` and `TaskStop`;
- `Monitor`;
- `PushNotification`;
- `ScheduleWakeup`;
- `Workflow`.

Find out what is available to a normal interactive session, and how it works. Search the binary at `/opt/homebrew/Caskroom/claude-code@latest/2.1.281/claude` with `strings`. The docs are at code.claude.com/docs and docs.claude.com.

## Rules

- **Research only.** Write only your own output file, `docs/native2/NN-<topic>.md`.
- **Don't touch:**
  - tmux sessions named `sh-*` or with numbers;
  - `/tmp/sh-demo`;
  - `~/.claude`, `~/.claude.json` or any settings file.
- **Probes** must be cheap: `--model haiku`, at most about $1 per agent, in `/tmp/n2-NN/`, in tmux sessions named `n2-NN-*`.
  - At the trust prompt, choose "Yes, I trust this folder".
  - Kill everything you start.
- **Label every finding** as verified-by-probe, verified-by-source, documented or inferred, and cite the evidence.

## Output file: 60–120 dense lines

1. **Capability:** what it is, precisely.
2. **Mapping:** what in sub-human it could replace or simplify, or what new behaviour it enables, concretely.
3. **Minimal footprint:** how much of the plugin could go if this were adopted. Name files, tools and hooks.
4. **Limits and risks.**
5. **Recommendation:** adopt now / later / don't, plus the one experiment that settles it.

Reply to the coordinator in at most 8 lines.
