# Synthesis: humans join like subagents, built natively

Ten parallel investigations (`01`–`10`) were run against Claude Code 2.1.281, using binary source, docs and live probes. This file combines them into one direction.

## The answer

**The orchestrator spawns a seat per human, the same way it spawns a background agent.** The human attaches to that seat. It runs on Claude Code's own session supervisor, and each seat shows as a row in the orchestrator's agent panel. Consent comes from a native form that the room server pushes to each approver, so no model is involved.

```
orchestrator (claude --agent sub-human:orchestrator --permission-mode plan)
 ├─ spawns  claude --bg -n alice … "/sub-human alice CODE"   ← alice runs: claude attach <id>
 ├─ spawns  claude --bg -n bob   … "/sub-human bob CODE"     ← bob runs:   claude attach <id>
 ├─ agent panel: one proxy row per human (live status from the log; transcript = their words)
 └─ room log (unchanged) + plugin monitor (wakes) + gate on ExitPlanMode (unchanged)
approval:  room server → elicitation/create → native form in each approver's own terminal
```

## Adopt now

| # | Change | Replaces or simplifies | Evidence |
|---|---|---|---|
| A1 | **Elicitation sign-off.** The room server sends each approver an `elicitation/create` form (approve / object + reason) when a plan is published. The answer goes straight to the server; there is no model turn and nothing in the transcript. | Removes the member branches of `plan-gate.js` and `plan-result.js`, plus `plan-backup.js`, `stop-feedback.js` (transcript scraping), the clear-context and auto-mode workarounds, and pending-review state. That's about 300 lines. Members no longer enter plan mode. | Verified by probe in 05 and 07: an idle session got the form, the answer was byte-exact at the server and appeared 0× in the transcript. 06 offers a fallback: a `signoff` tool flagged `requiresUserInteraction`, which can't be bypassed even in auto or bypass mode. |
| A2 | **The orchestrator is a plugin agent.** Launch it with `claude --agent sub-human:orchestrator --permission-mode plan`. Hooks receive `agent_type`, so the model can't fake the orch role, and the agent's `tools:` list enforces "no Bash". | Today the role comes from the join hook alone, and "no Bash" is only a prompt rule. | Verified by probe in 08. Don't use the plugin `agent` setting: it would make every member an orchestrator. |
| A3 | **Spawned seats.** The orchestrator, or a `sub-human invite NAME` command, runs `claude --bg -n NAME` with the plugin, env and settings, and joins the room. The human runs `claude attach <id>`. `claude agents --json` reports each seat's busy/idle and blocked state. | Identity becomes the session id recorded at spawn, which survives a lot better than process ancestry. Launch-time env (status line, task list id, flags) is set for the human automatically. | Verified by probe in 09: the plugin and hooks load, multi-client attach works, and `--resume` of a held session is refused. Ancestry doesn't work under the daemon. Joining from your own session with `/sub-human NAME CODE` stays available. |
| A4 | **Humans as agent rows in the orchestrator's panel.** One Haiku proxy per human, blocked in `watch --member NAME`. The plugin's own `subagentStatusLine` computes each row from the log: its state and whether it's waiting on sign-off. Opening a row shows that human's words. | Today there is only one combined room row. | Verified by probe in 03. Haiku drops `name`, so map agent id → human in a SubagentStart hook. A stopped row disappears, so a SubagentStop block keeps it alive. |
| A5 | **Plugin-shipped status rows.** `settings.json` in the plugin carries `subagentStatusLine`. `${CLAUDE_PLUGIN_ROOT}` is empty there, so a SessionStart hook writes a tiny launcher and the setting points at that. | Removes the README's `--settings` step for agent rows. The main `statusLine` still needs the user's settings, or `--settings` on spawned seats, which A3 can set. | Verified by probe in 03 and 08. |
| A6 | **The monitor starts only on join.** Use `when: on-skill-invoke:sub-human:sub-human`; the name needs the plugin prefix. | Stops `tail` running in every session in every project. | Verified by probe in 08. Still open: does it come back after `--resume`? |
| A7 | **Presence.** `Notification` (`idle_prompt`, `permission_prompt`) and `StopFailure` hooks append presence entries, and `sessionTitle` shows the seat. | Cheap, native status for each person. | 05. |
| A8 | **Security fix.** `UserPromptSubmit` also fires on cross-session peer messages. Check whether `prompt` carries the `<cross-session-message …>` envelope. If a peer can trigger `@room`, reject it, using `origin` from `transcript_path` or the envelope prefix. | Closes a hole where a local process can forge someone's verbatim words. | 02. Not yet verified. **Do this first.** |

## Adopt later

- **A native shared task list as the room's work ledger.** It needs `CLAUDE_CODE_TASK_LIST_ID=<room>` and `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` at launch, which A3 makes easy, plus a `TaskCompleted` owner guard and a small task-folder monitor. Its `owner` field is a free string with no history. (10)
- **`PermissionRequest` routing.** Send the orchestrator's permission prompts to a named member to answer. (05, 06)
- **Channels**, for pushing room messages verbatim with a stamped `source`. It's a research preview: a dialog on every launch, a launch flag, and "not from your user" framing that undercuts the orchestrator. (07)
- **`PushNotification`** to the owner's phone when their sign-off is needed. (04)

## Don't adopt

| Feature | Why |
|---|---|
| **Agent teams** (01) | One-way only: the lead can't reach a joined human, and consent is inverted (prompts go to the lead and plans are approved automatically). |
| **Remote Control as a way for people to join** (04) | Input has no author and it is same-account only. |
| **Cross-session messaging as transport or identity** (02) | The sender is forgeable, it is one-to-one with no history, and the monitor already wakes sessions. |
| **`asyncRewake`, output styles, the plugin `agent` setting, rooms in `${CLAUDE_PLUGIN_DATA}`** (05, 08) | Each is either one-shot, can't be made the default, applies to every session, or splits rooms between install methods. |
| **Workflow, Cron, `/loop`** (10) | Each runs within a single session. |

## Experiments that decide it (run before the rebuild)

1. **E-A (elicitation sign-off).** Send a long plan as a form to one approver who is idle and one who is mid-turn. Pass if the plan is readable, both answers are logged as `via=human` signoff or objection, Esc records nothing, and no model turn occurs.
2. **E-B (spawned seat).** The orchestrator spawns alice with `--bg`, and a human attaches from a second terminal. Pass if identity, `@room` and the sign-off are all credited to alice, and the seat appears in `claude agents` with live state.
3. **E-C (human rows).** An Opus orchestrator with 3 proxy rows runs for 30 minutes with 20 entries. Pass if every row persists, there are no interim notifications, and each entry costs at most one proxy turn.
4. **A8 check.** Can a peer message trigger `@room`? Fix it if so.
