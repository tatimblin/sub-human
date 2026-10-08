# Archive

Design history: research, spikes, plans and briefs from earlier phases. Kept for the reasoning; none of it describes the current build. For the current state see `docs/rebuild/` (the walkthrough and its checks), `docs/internals/`, and `docs/ARCHITECTURE.md`. Paths inside these files are as written then: `docs/X` there is now `docs/archive/X`, and `docs/next/AUDIT-PLAN.md`, `docs/next/MODS-PLAN.md` and `docs/next/REVIEW-PLAN.md` are now in `docs/archive/`.

Roughly in the order it was written:

- [seat-subagent-spike-plan.md](seat-subagent-spike-plan.md): the first local spike plan for seat subagents.
- [research/](research/): runtime messaging, the extension surface, verbatim MCP push, context growth (CONTEXT.md, 01–04).
- [spike-results.md](spike-results.md): live results of the seat-subagent spike.
- [spike-results-2.md](spike-results-2.md): live re-verification after the fix round.
- [spike-results-3.md](spike-results-3.md): plugin-surface probes P1–P5.
- [rebuild-plan.md](rebuild-plan.md): the rebuild plan, "humans join like subagents".
- [experiments/](experiments/): participant rows, native sign-off, row mechanisms, nested rows (BRIEF, E1–E3, P0).
- [experience-eval-1.md](experience-eval-1.md): experience evaluation 1, making a simple plan.
- [fixes/](fixes/): fix proposals A–D for the walkthrough findings (rows, model behaviour, notices, hook rendering).
- [native/](native/): native Claude Code research round 1 (agent teams, messaging, panel, hooks, approval, MCP, attach, tasks) and its synthesis.
- [native2/](native2/): research round 2 (messaging, humans as agents, shared tasks, consent, footprint, awareness, task-list spike) and its synthesis.
- [next-plan.md](next-plan.md): the next build plan, a slim and unprescriptive sub-human.
- [next/PHASE2-BRIEF.md](next/PHASE2-BRIEF.md): the Phase 2 builder brief.
- [next/S1-headless-orch.md](next/S1-headless-orch.md): spike S1, headless orch with native messaging and tasks.
- [next/S2-consent-card.md](next/S2-consent-card.md): spike S2, the consent card (hook-rewritten AskUserQuestion).
- [next/S3-monitor-resume.md](next/S3-monitor-resume.md): spike S3, the room monitor after `/clear`, `--continue` and `--resume`.
- [next/P3-wakes.md](next/P3-wakes.md): Phase 3, cutting room-caused wakes.
- [AUDIT-PLAN.md](AUDIT-PLAN.md): the five-way audit's implementation plan (waves 0–4, done 2026-10-06).
- [MODS-PLAN.md](MODS-PLAN.md): the move to a function-hooks module (W0–W4: guard, prompt gate, delivery through the tail child, no Monitor; done 2026-10-07).
- [REVIEW-PLAN.md](REVIEW-PLAN.md): the follow-up to the three-way review of the mods build (R0–R5: spikes, bugs, structure, dead code, comments and docs, hotspots and a short live run; done 2026-10-07).
- [REMOTE-PLAN.md](REMOTE-PLAN.md): remote rooms, a room hosted on one machine and joined from others (PR1–PR6: keys in the log and sig v2, machine ids and host gates, the bridge, the protocol and server, the mirror and link daemon, docs and demo S11; done 2026-10-07 over the pipe transport, SSH next).
