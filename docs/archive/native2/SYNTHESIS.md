# Synthesis, round 2: a slim, unprescriptive sub-human

Six investigations (`01`–`06`) against Claude Code 2.1.281, each using the binary, docs and cheap probes. The goal, in the user's words: join a session and work in it the way a subagent or a person normally would. The plugin should only let several human sessions work together. Planning is optional.

## The shape

```
/sub-human NAME          ← the only command. Join hook binds NAME, sets sessionTitle = "⬡ room · NAME" (= native address)
  no room open?  →  spawn a headless orchestrator:  claude --bg -n <room> --agent sub-human:orchestrator --settings '{"env":…}'
Claude ↔ Claude          native SendMessage / ListAgents (sender stamped by Claude Code; wakes idle sessions ~5 s)
human's exact words      @room → durable room log (via=human), delivered free on others' next prompt
"concerns me" notices    a narrowed monitor wakes a Claude only for entries addressed to it (to=me, my consent, my task)
consent (optional)       anyone proposes ("do we all agree on X?", or a member's own plan when they exit plan mode)
                         → a native consent card in each approver's own session; a Claude can never answer it
seeing the orchestrator  agent view (`claude agents` / ←): live status, peek; Enter attaches (full control, not read-only)
work ledger (later)      native shared task list
```

## What goes, what stays

| Area | Today | Proposed | Evidence |
|---|---|---|---|
| **Role text** | Member 5.5k characters, orch 7.5k. About 60% is workflow rules. | About 500 characters of mechanics: who you are, `@room`, how consent works. Facilitation is optional and lives in the orchestrator agent. | 05 |
| **Rows** | Hold-based proxy rows: about 870 lines, N Haiku agents, "Waiting for N background agents", the exit dialog, the duplicate-row bugs. | **Delete.** The orchestrator is visible in the native agent view. No native way exists to put another session into your own panel. | 02, 05 |
| **Live traffic** | The room log, a monitor that wakes on every entry, `post` and `read`. | Claudes message each other natively with SendMessage. The log keeps only human words, consent and membership. | 01, 06 |
| **Waking** | Every entry wakes every member's Claude, about 25 turns per 30 minutes. | Wake only for what concerns you; everything else arrives free on your next prompt. Target: at most 6 turns. | 06 |
| **Orchestrator** | A window of its own, `--permission-mode plan`, and the host joins from a second session. | Spawned headless by the first join. It costs nothing while idle. The plugin stops it when the last member leaves. | 02 |
| **Consent** | The orch-only plan-mode gate plus a 4-line elicitation form. | `propose` from anyone, or a member's own ExitPlanMode becoming the proposal. The gate and plan-result hooks go. | 04, 05 |
| **Hooks** | 14 | About 5: join, `@room`, restore, leave, a narrow guard. Plus consent. | 05 |
| **Size** | 4,233 lines | About 2,700. | 05, 02 |

## Decisions for the user

1. **Drop the in-panel rows?** The rows are the expensive, buggy part, and nothing native replaces "Enter on the room row to see bob". The orchestrator would show in the agent view instead (← or `claude agents`). Members wouldn't show anywhere native until Claude Code's peers flag ships. *Recommendation: drop them.*
2. **Which consent card?**
   - **Native question dialog (AskUserQuestion), driven by our hook.** It shows the full plan as rendered markdown with Approve/Object and a note. It costs the approver's Claude one turn to open, and it can auto-answer after 60 s idle, so we must drop those answers.
   - **The current elicitation form.** It arrives with no model turn, but it shows only 4 lines plus a path.

   *Recommendation: the native dialog, with "Not yet" as the first option.*
3. **A shared task list as the work ledger?** Joining a list mid-session means writing `env.CLAUDE_CODE_TASK_LIST_ID` into the project's `.claude/settings.local.json`. That affects every session in that folder until removed, and the list deletes itself once all its tasks are done. *Recommendation: later, as an opt-in.*
4. **Viewing the orchestrator is a takeover.** Attaching types into it with no author. Peek and `claude logs` are read-only. *Recommendation: document peek for watching. A hook should refuse typed prompts in the orchestrator, or mark them as "from whoever attached".*

## Security (verified in 01; fix before anything else)

A bare line written to a member's session socket reaches UserPromptSubmit as if it were typed. The transcript entry that would expose it is written *after* the hook runs. So any local process can post `@room` as that human. The fix is to verify after the fact: the next hook in that session checks the transcript for that prompt's origin, then retracts or flags the entry. A peer process forging input is the one forgery that still matters, because it breaks "a Claude can never speak as its human".

## Experiments that settle it (in order)

1. **Slim build vs current:** the same 3-person script on both. Count room-caused model turns, injected characters and non-work UI lines. Pass if all fall by at least 70%, while attribution and consent still work. (05, 06)
2. **Native messaging:** a headless orchestrator, two default-mode members, no monitor, 10 directives. Pass if each wake takes under 10 s, at least 9 of 10 directives are acted on, and a forged `@room` is rejected. (01)
3. **Consent card:** two members, a full plan, and a member's own ExitPlanMode as the proposal. Pass if the card shows the full plan, Esc logs nothing, the 60 s auto-answer is dropped, and a stray Enter doesn't approve. (04)
