# 05 · The full hook surface (Claude Code 2.1.281)

Labels: **[source]** = a string from the 2.1.281 binary · **[probe]** = `/tmp/native-05` (haiku, interactive in tmux, hooks passed with `--settings`) · **[docs]** = code.claude.com/docs/en/hooks · **[inferred]**.

## 1. Capability

- **Events (33)** [source, from the event array]: PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, UserPromptSubmit, UserPromptExpansion, SessionStart, SessionEnd, Stop, StopFailure, SubagentStart, SubagentStop, PreCompact, PostCompact, PreModelSwitch, PostModelSwitch, PermissionRequest, PermissionDenied, Setup, TeammateIdle, TaskCreated, TaskCompleted, Elicitation, ElicitationResult, ConfigChange, WorktreeCreate, WorktreeRemove, InstructionsLoaded, CwdChanged, FileChanged, DirectoryAdded, MessageDisplay.
- **Handler types** [source]: `command`, `prompt`, `agent`, `http` and `mcp_tool`. `mcp_tool` calls a tool on an MCP server that is already configured; its `input` supports `${tool_input.x}` interpolation.
- **Command fields** [source]: `command`, `args` (exec form, no shell), `if`, `shell`, `timeout`, `statusMessage`, `once`, `async`, `asyncRewake`, `rewakeMessage` and `rewakeSummary` (both `@internal`), and `cloud`. The default timeout is 600 s (`var Ua=600000`).
- **Common output** [source]: `continue`, `suppressOutput`, `stopReason`, `decision`, `reason`, `systemMessage` and `terminalSequence`. `terminalSequence` accepts only the OSC 0/1/2/9/99/777 sequences and BEL.
- **Event-specific outputs worth knowing** [source]:
  - UserPromptSubmit and SessionStart can return `sessionTitle`.
  - SessionStart can also return `initialUserMessage`, `watchPaths` and `reloadSkills`.
  - Stop, SubagentStop and PostToolBatch can return `additionalContext`.
  - PostToolUse can return `updatedToolOutput` and `classifierContext`.
  - PermissionRequest returns `decision:{behavior:allow, updatedInput?, updatedPermissions?}` or `decision:{behavior:deny, message?, interrupt?}`.
  - Elicitation and ElicitationResult return `{action: accept|decline|cancel, content?}`.
  - PermissionDenied returns `{retry}`.
  - MessageDisplay returns `{displayContent}` (it changes the display only).
- **Inputs used below** [source + probe]:
  - **Stop**: `stop_hook_active`, `last_assistant_message`, `background_tasks[]` and `session_crons[]`. The probe payload had all four.
  - **PermissionRequest**: `tool_name`, `tool_input` and `permission_suggestions`. The probe payload had no `tool_use_id`, although the `/hooks` text says it has one.
  - **Notification**: `message` and `notification_type`. The types are `permission_prompt`, `idle_prompt`, `elicitation_dialog`, `elicitation_response`, `elicitation_url_dialog`, `agent_needs_input`, `agent_completed`, `worker_permission_prompt` and others (`hAo=[…]`).
  - **SessionEnd**: `reason` is one of clear, resume, logout, prompt_input_exit or other.
  - **StopFailure**: `error` is a code such as rate_limit, overloaded, authentication_failed or billing_error. StopFailure output is ignored.
  - **TeammateIdle**: `teammate_name`.
  - **TaskCreated / TaskCompleted**: `task_id`, `task_subject` and `teammate_name?`. Exit code 2 blocks the creation or the completion.
- **How asyncRewake works** [source, `rOt`]. On exit code 2, the hook's output is queued as a `task-notification` with `priority:"next"` and `stopHookActive:true`. `rewakeMessage` replaces the prefix of the system-reminder; `rewakeSummary` replaces the "Stop hook feedback" line the user sees. A `rewakeSummary` written in the hook's JSON stdout is honored only for plugins from allowlisted marketplaces (`Dne(pluginId)`).
- **[probe] asyncRewake on SessionStart (sleep 12, then exit 2):**
  - It woke an idle session by itself.
  - The terminal showed `⏺ room: bob posted`.
  - The model received `<task-notification><summary>room: bob posted</summary></task-notification><system-reminder>SUB-HUMAN room message: #42 bob: …</system-reminder>`.
  - The model treated it as not coming from the user ("this isn't a message from you").
- **[probe] UserPromptSubmit `source` is not sent yet.**
  - The schema declares `source: user|sdk|system|loop_wakeup|schedule_wakeup|poll_event` and notes "Payloads may omit it while the field rolls out" [source].
  - In the probe, neither the wake turn nor a typed prompt carried the field.
- **[probe] A PermissionRequest hook races the native dialog.**
  - The dialog for `Bash: date > …` stayed on screen while `perm.sh` slept 4 s. The hook then returned allow, the dialog closed, and the transcript showed `⎿ Allowed by PermissionRequest hook`.
  - Source: `if(!v)(async()=>{… s.runHooks(…)})`. Whichever answers first, the hook or the human, wins.
  - Tools for which `requiresUserInteraction` is set (ExitPlanMode, AskUserQuestion) cannot be allowed by the hook unless it also returns `updatedInput` [source].
- **[probe] An MCP server can open an elicitation while the session is idle, with no tool call.**
  - A 40-line stdio server sent `elicitation/create` 10 s after `initialized`. Claude Code rendered "MCP server “el” requests your input / Room plan abc123: do you approve?" with an enum field and a free-text field.
  - The human picked "approve" and chose Accept. The server received `{"action":"accept","content":{"verdict":"approve"}}`, and no model turn ran.
  - The hooks that fired were Elicitation, then Notification(`elicitation_dialog`, "Claude Code needs your input"), then ElicitationResult, then Notification(`elicitation_response`).
  - The client advertises `"elicitation":{}` in `initialize`.

## 2. Mapping to "humans join like subagents"

- **Consent: Elicitation instead of the ExitPlanMode dialog.** Each member's room MCP server is already a child of that member's own `claude` process (room-server.js resolves the member through ppid). The server can ask its human directly with the plan text plus `{verdict: approve|object, comment}`. The answer goes to the server without passing through the model, so it is verbatim and `via=human` by construction [probe]. The prior finding in research/03 §3 ("the dialog renders in one terminal") no longer applies, because every human now runs their own process.
- **Approving permissions, as a parent does for a subagent: PermissionRequest on the orchestrator.** The orchestrator runs unattended. A hook on it would:
  1. append a `permission_request` entry to the room;
  2. block for up to `timeout` (default 600 s) until a member answers. The member answers through an elicitation from their own room server, logged as `via=human`;
  3. return allow or deny.
  The local dialog stays up as a fallback, because the hook only races it [probe]. This mirrors how a background subagent's prompts surface in its parent session.
- **Presence**, in the room log and the status line:
  - Notification(`idle_prompt`) means "alice is idle at her prompt".
  - Notification(`permission_prompt` / `elicitation_dialog`) means "alice's Claude is waiting on alice".
  - UserPromptSubmit means "active".
  - StopFailure(`rate_limit` / `billing_error`) means "alice's Claude is stalled". This one is fire-and-forget [source].
  - Stop's `background_tasks` shows whether a member is paused while workers run, or done [source].
- **Identity that is visible natively.** `sessionTitle` from SessionStart or UserPromptSubmit can be "alice · marmot-2509", so `/resume` and the UI show the seat [source; rendering not probed].
- **Doing work.** SubagentStart `additionalContext` reaches each background worker a member spawns, for example "you work for alice in room X; report with post kind=status" [source, `/hooks` text: "JSON additionalContext shown to subagent"]. TaskCreated/TaskCompleted could mirror the orchestrator's task list into the room as assignments, and could block completion (exit 2) until the owner says done [inferred; whether they fire without agent teams is untested].
- **Waking.** asyncRewake works [probe], but it fires once per event and has to be re-armed after every Stop. The plugin monitor (`sub-human tail`, `when: always`) already reaches the same `task-notification` path as a continuous stream.

## 3. Replaces / simplifies (audit of `hooks/hooks.json`, 11 hooks, 801 lines)

| Hook | Verdict |
|---|---|
| join.js (UserPromptExpansion) | Keep: it is the native binding point. UserPromptExpansion has no `sessionTitle`, so set the title in session-restore/SessionStart instead. |
| at-room.js (UserPromptSubmit) | Keep. Replace the `prompt.startsWith('<task-notification>')` and `'/'` sniffing with `input.source` once the field ships; it is absent today [probe]. Add `sessionTitle`. |
| guard.js (PreToolUse) | Keep. A plugin cannot ship permissions, so `allow` here is the native substitute. The new `if` field could narrow the Bash case; this is cosmetic. |
| plan-gate.js, orchestrator branch | Keep. Denying ExitPlanMode in PreToolUse is the right native gate. |
| plan-gate.js member branch, plan-result.js member branch, plan-backup.js, stop-feedback.js, `clearContextOnAccept()`, `modeNote()`, the clear-warning in session-restore.js | **Replace with an elicitation from room-server.js, about 300 lines in total.** These pieces exist only because ExitPlanMode is repurposed: overwriting the plan file and backing it up, the "Yes, and use auto mode" side effect, scraping the transcript for "Tell Claude what to change" (spike 3 P5), refusing `dontAsk`, and the clear-context path that fires no PostToolUse. An elicitation has none of these problems. Still needed: a room-server call that triggers the review, a `plan_rev` entry, and storing the canonical plan. |
| plan-result.js, orchestrator branch | Keep: it logs the decision. |
| precompact-note.js, session-restore.js, session-end.js | Keep: they use the native events correctly. PostCompact adds nothing beyond SessionStart(compact). |
| monitors.json + `bin/sub-human tail` | Keep. asyncRewake does the same job worse, because it is one-shot per event and duplicate waiters across Stops would need deduplicating. |
| statusline/alert.js (osascript + BEL) | Partly replaced. Once reviews are elicitations, Claude Code's own `elicitation_dialog` notification alerts the human (Notification fired [probe]). `terminalSequence` works only from synchronous hooks, and the monitor is not a hook [inferred]. Direct messages still need alert.js. |

## 4. Limits and risks

- **Everything runs locally under one OS user.** Hook trust equals settings trust. A user-level Elicitation or ElicitationResult hook can auto-answer or override a review, just as a user can edit the room log today. Treat this as the same accident boundary, not a security boundary.
- **`rewakeMessage` and `rewakeSummary` are `@internal`.** The JSON `rewakeSummary` is ignored for this plugin (marketplace allowlist). `source` on UserPromptSubmit is "rolling out".
- **PermissionRequest:**
  - It is skipped when `forRemoteExecution` is set, and it cannot allow ExitPlanMode or AskUserQuestion without `updatedInput`.
  - A 600 s default timeout means a long wait needs a larger `timeout`.
  - Only the interactive path was probed. Headless (`-p`) behavior was not verified.
- **Elicitation (untested):**
  - how a 3–8k-character markdown plan renders, and whether it scrolls;
  - behavior when an elicitation arrives in the middle of a turn;
  - whether there is a request timeout on the client side.
  - What is lost compared with the plan dialog: plan rendering, in-place editing and the Ctrl+G editor. An objection becomes a comment instead of an edited plan.
- **TeammateIdle** is for agent-teams teammates, which are in-process Claude agents (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`), not external humans. Don't adopt it.
- **MessageDisplay** changes the display only, and **PermissionDenied** fires only for auto-mode classifier denials. Both are low value.
- **Cloud forwarding** (`nD` map): SessionStart, SessionEnd and Notification run locally only. PermissionRequest is marked "later". TeammateIdle, Task* and Elicitation are marked "low_value". This matters only if sessions move to the cloud.

## 5. Recommendation

- **Adopt now: Elicitation for members' sign-off.** It removes about 300 lines of ExitPlanMode workarounds and makes consent `via=human` by construction [probe].
- **Adopt now: cheap presence hooks.** Notification (`idle_prompt` / `permission_prompt`), StopFailure, `sessionTitle` and SubagentStart context.
- **Adopt later: routing the orchestrator's permission prompts to room members through PermissionRequest.** The mechanism is verified, but the UX and the timeout policy need design.
- **Don't adopt:** asyncRewake as the waking mechanism (the monitor is better), TeammateIdle, MessageDisplay or PermissionDenied.
- **The one experiment that would settle it:**
  1. In room-server.js, on a new `plan_rev`, send `elicitation/create` to each approver's server. Put the full canonical plan in `message` and use the schema `{verdict: enum[approve, object], comment: string}`.
  2. Run it twice: once with the member idle, once with the member mid-turn.
  3. Check that the plan is readable, that both answers land as `via=human` signoff/objection entries, and that no model turn is spent.
  4. If a long plan renders badly, fall back to `mode:"url"` (a local page) or keep ExitPlanMode only for showing the plan.
