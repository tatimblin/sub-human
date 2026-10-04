# 02: The extension surface for the room plugin

This doc covers Claude Code 2.1.281 (`/opt/homebrew/Caskroom/claude-code@latest/2.1.281/claude`).

- **Where the source comes from.** The install is a Bun-compiled Mach-O binary with the JS embedded. Source findings come from `strings` over that binary. The minified identifiers quoted below are from this build and will change.
- **Probes.** They ran in `/tmp/seat-research-ext/` with `claude -p --model haiku`, passing hooks through `--settings /tmp/seat-research-ext/settings.json`. Global settings were not touched.
- **Side effects.** Two probe plan files landed in `~/.claude/plans/` and I deleted both. The CLI also wrote probe transcripts to `~/.claude/projects/-private-tmp-seat-research-ext-proj/`, which I left in place.

Labels used throughout: **[source]** verified-by-source, **[probe]** verified-by-probe, **[docs]** documented, **[inferred]** inferred.

---

## 1. Agent definitions

### 1.1 Frontmatter fields (`.claude/agents/*.md`, `~/.claude/agents/*.md`)

The parser is function `dRn(...)` in the binary [source]. It reads these keys:

| Field | What it does | Notes |
|---|---|---|
| `name` | The agent type id. | Required. May not start with `-` or contain `:`, because `:` is reserved for plugin namespacing [source: `names must not contain ':' (reserved for plugin namespacing)`]. |
| `description` | When-to-use text that the parent model sees. | Required. Without it the file is skipped [source: `is missing required 'description' in frontmatter`]. |
| `tools` | Allowlist. If omitted, the agent inherits all tools. | `Agent(worker, researcher)` limits which agent types it can spawn [docs]. |
| `disallowedTools` | Denylist. | `mcp__server` or `mcp__*` removes every tool from that server [source: SDK schema `FR` description]. |
| `model` | An alias, a full model id, or `inherit`. | |
| `effort` | `low` / `medium` / `high` / `xhigh` / `max`, or an integer. | |
| `permissionMode` | `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, or `bypassPermissions`. | Validated against `uv` [source]. The parent's mode wins when the parent is in `bypassPermissions`, `acceptEdits` or `auto` [docs]. |
| `maxTurns` | Positive integer cap on turns. | When the cap is hit the output is marked partial, and the agent can be resumed with SendMessage [docs]. |
| `skills` | Skills to preload; their full text is injected. | |
| `mcpServers` | A list of server-name strings (these share the parent's connection) or inline `{name: config}` entries (these connect when the agent starts and disconnect when it ends). | Validated per item with `$J()` [source]. Inline servers in a project-level agent need folder trust [docs]. |
| `hooks` | Hooks scoped to this agent. | Parsed by `$5n(r,h)`. A hook entry it cannot load causes the whole agent to be dropped (`unloadableGuard`) [source]. Docs list PreToolUse, PostToolUse and Stop, with Stop rewritten to SubagentStop at runtime [docs]. |
| `memory` | `user`, `project`, or `local`. | Uses `~/.claude/agent-memory/<type>/`, `.claude/agent-memory/<type>/`, or `.claude/agent-memory-local/<type>/` [source]. |
| `background` | `true` means the agent always runs as a background task. | [source] |
| `isolation` | `worktree` or `remote`. | [source: `Me=["worktree","remote"]`]. The docs mention only `worktree`. |
| `omitClaudeMd` | Skip user, project and local CLAUDE.md. | [source] |
| `initialPrompt` | First user turn, used only when the agent is the main thread (`--agent`). | [source] |
| `color` | UI color. | Must be in the allowed palette `Xg` [source]. |
| `experimental.cacheTtl` | `5m` or `1h`. | [source: `PNn`] |
| `observer`, `observerMessage`, `observeSubagents` | `observer` names an agent type that is auto-spawned as a background observer. The observer receives read-only activity digests and reports through `ObserverReport`. | [source: SDK schema description]. Undocumented, so treat it as experimental. |

`requiredMcpServers` also exists at runtime. When it is set, the Agent tool waits up to 30 s for matching servers and fails if they are missing [source: `requiredMcpServers` plus `maxWaitMs:30000`]. It is not read from markdown frontmatter in this parser.

### 1.2 `--agents` JSON

The JSON form is parsed by `hyt` / `FQe`, with schema `FR` [source]. It accepts:

- `description`, `prompt`, `tools`, `disallowedTools`, `model`, `effort`, `permissionMode`, `mcpServers`, `hooks`;
- `maxTurns`, `skills`, `initialPrompt`, `background`, `omitClaudeMd`, `memory`, `isolation`;
- `observer`, `observerMessage`, `observeSubagents`.

`color` is ignored [docs]. In `-p` mode, `--agents` also accepts a file path [CLI help].

### 1.3 Can an agent declare its own MCP servers or hooks?

- **Yes for user, project, `--agents` and SDK definitions** [source + docs].
- **No for plugin-shipped agents.** The plugin parser warns and drops these fields: `Plugin agent file … sets ${Yt}, which is ignored for plugin agents. Use .claude/agents/ for this level of control.` This applies to `permissionMode`, `hooks` and `mcpServers` [source: `dyt(...)`].
  - The plugin parser also ignores `initialPrompt`, `observer`, `isolation: remote` and `color` validation.
  - Plugin agents are namespaced `plugin:agent` [source].
- **Workaround.** Put the hooks in the plugin's `hooks/hooks.json` and filter on `agent_type` inside the hook. Alternatively, have the plugin's launcher pass `--agents` JSON, which can carry hooks and mcpServers. [docs + inferred]

---

## 2. Hooks

### 2.1 Full event list

The source has this array (and `mm` in the validator) [source]:

> PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, UserPromptSubmit, UserPromptExpansion, SessionStart, SessionEnd, Stop, StopFailure, SubagentStart, SubagentStop, PreCompact, PostCompact, PreModelSwitch, PostModelSwitch, PermissionRequest, PermissionDenied, Setup, TeammateIdle, TaskCreated, TaskCompleted, Elicitation, ElicitationResult, ConfigChange, WorktreeCreate, WorktreeRemove, InstructionsLoaded, CwdChanged, FileChanged, DirectoryAdded, MessageDisplay

What each event's matcher is tested against (`mOt`) [source]:

| Matcher field | Events |
|---|---|
| `tool_name` | Tool events (PreToolUse, PostToolUse and so on) |
| `command_name` | UserPromptExpansion |
| `agent_type` | SubagentStart, SubagentStop |
| `notification_type` | Notification |
| `source` / `trigger` / `reason` | Lifecycle events |

Handler types are `command`, `http`, `mcp_tool`, `prompt` and `agent` [docs; `mcp_tool` and `http` are confirmed in source]. Command hooks also take two background options:

- `async`;
- `asyncRewake`: "runs in background and wakes the model on exit code 2" [source].

### 2.2 Common input (every event)

Every event gets `session_id`, `transcript_path`, `cwd`, `prompt_id?`, `permission_mode?`, `agent_id?`, `agent_type?` and `effort?` [source: schema `P`]. The schema description says:

> "agent_id … Present only when the hook fires from within a subagent … Absent for the main thread … Use this field (not agent_type) to distinguish subagent calls from main-thread calls."

### 2.3 The events we care about

| Event | Input (in addition to the common fields) | Can it block? | Can it inject context? |
|---|---|---|---|
| **PreToolUse** | `tool_name`, `tool_input`, `tool_use_id`, `mcp_server?` [source] | **Yes.** Use `hookSpecificOutput.permissionDecision: "deny"` with `permissionDecisionReason` (the model sees the reason), or exit 2. It can also return `allow`, `ask` or `defer`, and can rewrite the call with `updatedInput` [source `v0`]. | **Yes**, through `additionalContext` [source `v0`]. |
| PreToolUse matching **ExitPlanMode** | `tool_input` = `{plan, planFilePath}`, injected from disk [probe]. | **Yes.** The model received `PreToolUse:ExitPlanMode hook error: ROOM-GATE: …`, obeyed it, and plan mode stayed on [probe]. | Yes. |
| PreToolUse matching **Agent** | `tool_input` = `{description, prompt, subagent_type, …}` [probe]. Also `name` and `run_in_background` when those are used [inferred]. | Yes. It can deny a spawn, or use `updatedInput` to stamp or force fields such as the prompt or `subagent_type` [source + inferred]. | Yes. |
| PreToolUse matching **SendMessage** | `tool_input` = `{to, message, summary?}` [tool schema]. When a seat sends, the common input carries `agent_id`/`agent_type` [inferred from the Bash probe]. | Yes, for example to deny a send to the wrong recipient. | Yes. |
| **PostToolUse** | `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, `duration_ms?` [source] | Not before the fact, since the tool has already run. `decision:"block"` with `reason` feeds the reason back to the model, and exit 2 shows stderr to the model [docs]. | **Yes**, through `additionalContext`. `updatedToolOutput` can replace the result [docs]. |
| **UserPromptSubmit** | `prompt`, `source` (`user` / `sdk` / `system` / `loop_wakeup` / `schedule_wakeup` / `poll_event`) [source] | **Yes.** Use `decision:"block"` or exit 2, and `suppressOriginalPrompt` to drop the text from the block message [source `M0`]. | **Yes.** Use `additionalContext`, or plain stdout [docs]. |
| **UserPromptExpansion** | `expansion_type` (`slash_command` / `mcp_prompt`), `command_name`, `command_args`, `command_source`, `prompt` [source, probe] | **Yes.** `decision:"block"` stops the expansion before any model turn [probe]. | Yes, through `additionalContext` [source `P0`]. |
| **Stop** | `stop_hook_active`, `last_assistant_message?`, `background_tasks?`, `session_crons?` [source] | **Yes.** `decision:"block"` with `reason`, or exit 2, makes the model keep going [docs]. | **Yes.** `additionalContext` is described as "non-error feedback delivered to the model; the conversation continues" [source]. |
| **SubagentStart** | `agent_id`, `agent_type` [source, probe] | **No.** It is observational, and exit 2 only shows stderr to the user [docs]. | **Yes.** `additionalContext` is shown at the start of the subagent's conversation [source `U0` + docs]. |
| **SubagentStop** | `stop_hook_active`, `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message?` [source, probe] | **Yes.** `decision:"block"` or exit 2 keeps the subagent running [docs]. | **Yes.** Per the source, `additionalContext` is "feedback delivered to the subagent; the subagent continues". |
| **Notification** | `message`, `title?`, `notification_type` [source] | **No** [docs]. | **No.** The output is discarded [docs]. |

There is also **PermissionRequest**, which fires when a permission dialog would appear. Its input has `tool_name`, `tool_input` and `permission_suggestions`, and it can allow or deny through a `decision` object [source + docs]. That makes it a second place to gate ExitPlanMode.

### 2.4 Can a hook tell which subagent triggered it?

**Partly.**

- **What it gets:** `agent_id` (an opaque instance id such as `a237333bf3b1276ea`) and `agent_type` (for example `seat`). Both are present on PreToolUse, SubagentStart and SubagentStop inside a subagent [probe].
- **What it does not get:** the instance `name` passed to the Agent tool. No `agent_name` field exists in the hook schema [source: no match for `agent_name:o()`].
- **Two ways to attribute a hook to a human:**
  - one agent type per seat (`seat-alice`, `seat-bob`), generated by the launcher or passed as `--agents` JSON;
  - record `agent_id → human` in SubagentStart, and have the seat's first action announce itself.

  The first is simpler and can't be spoofed by the model [inferred].

---

## 3. Plan mode

- **How it works.** Plan mode is the permission mode `plan`: read-only tools only. A plan-mode system reminder tells the model to write its plan to a plan file and then call `ExitPlanMode` [source].
  - `ExitPlanMode` takes no plan argument. The CLI reads the file and injects `plan` and `planFilePath` into the input [source: schema `yT`, "injected by normalizeToolInput from disk"].
  - `--plan-mode-instructions` (hidden flag) replaces the workflow body. The "read-only enforcement preamble and ExitPlanMode protocol footer are always kept" [source].
- **Where plans live on disk.** `~/.claude/plans/<slug>.md` for the main thread and `~/.claude/plans/<slug>-agent-<agentId>.md` for a subagent [source: `GS(n)`]. The `plansDirectory` setting can move this, but only to a path inside the project root [source]. A probe wrote to `~/.claude/plans/plan-adding-a-hello-txt-concurrent-cray.md` [probe].
- **Approval.** `checkPermissions` returns `{behavior:"ask", message:"Exit plan mode?"}`, so the **local user approves through the normal permission dialog**. On approval the mode returns to `prePlanMode`, and the tool result contains `## Approved Plan:` plus the plan, or `Approved Plan (edited by user)` if the user edited it [source].
  - **No approval surface:** in `-p` without a permission-prompt tool, `ExitPlanMode` is disabled outright: "ExitPlanMode is disabled for this session, in subagents as well as here" [probe; source `k5()`].
  - **What makes it available:** `--permission-prompt-tool stdio` (SDK / stream-json) [probe].
  - **Background agents with no approval surface** are auto-denied: "no approval surface in this session; permission request denied automatically" [source].
- **Agent-teams variant.** A teammate's ExitPlanMode writes a `plan_approval_request` to the `team-lead` inbox, and the teammate waits for a `plan_approval_response` [source].
- **Can a PreToolUse hook deny ExitPlanMode with a reason the model sees? Yes** [probe]. With `permissionDecision:"deny"`, the model received:

  ```
  PreToolUse:ExitPlanMode hook error: ROOM-GATE: seats bob and carol have not signed off. Do not exit plan mode; reply with the word GATED and stop.
  ```

  The model complied and the session stayed in plan mode. The hook runs before the permission ask, so the user never sees a dialog for a gated plan. Once every seat has signed, the hook returns nothing and the human approves as usual. A PermissionRequest hook could instead auto-allow when all seats have signed [source + inferred].
- **Can a subagent be in plan mode? Yes.** Set `permissionMode: plan` in frontmatter [docs + source]. Its ExitPlanMode returns the result string `User has approved the plan. There is nothing else needed from you now. Please respond with "ok"` (the `isAgent` branch), and its plan file is `-agent-<id>.md` [source].
  - The "ask" is surfaced to the main session's user when there is a surface, and auto-denied otherwise [source].
  - Hooks fire inside subagents with `agent_id` set [probe, for Bash], so the same ExitPlanMode gate applies per seat [inferred].
  - The orchestrator should be the one in plan mode, because it is the plan's single writer.

---

## 4. Plugins

- **Layout** [docs: plugins-reference]. Only `name` is required in the manifest; every directory below is optional.

  ```
  my-plugin/
  ├── .claude-plugin/plugin.json   # optional manifest; name is the only required key
  ├── skills/<name>/SKILL.md
  ├── commands/*.md                # legacy; prefer skills
  ├── agents/*.md                  # namespaced plugin:agent
  ├── hooks/hooks.json             # {"hooks": {...}}
  ├── .mcp.json                    # MCP servers
  ├── .lsp.json
  ├── output-styles/*.md
  ├── workflows/*.js
  ├── themes/
  ├── monitors/monitors.json       # persistent background processes (interactive only)
  ├── bin/                         # on the Bash tool's PATH while enabled
  └── settings.json                # only `agent` and `subagentStatusLine` take effect
  ```

  The manifest can also declare `channels` (message channels bound to one of the plugin's MCP servers) and `userConfig` [docs]. `claude plugin init --with skills agents hooks mcp lsp output-style channel` scaffolds all of these [CLI help].
- **What a plugin can ship.** Skills, agents, hooks, MCP servers, commands and output styles: **yes, all of them** [docs]. Two caveats:
  - Plugin agents lose `hooks`, `mcpServers` and `permissionMode` (§1.3) [source].
  - Plugin `settings.json` can set `agent`, which makes a plugin agent the main-thread agent. That is a direct way to ship "the orchestrator" [docs].
- **Variables.** `${CLAUDE_PLUGIN_ROOT}` (read-only, changes on update) and `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/<id>/`, persistent) are available in hooks, MCP config and skill bodies [docs].
- **Local install.**
  - `claude --plugin-dir ./room-plugin` loads a plugin for one session only. It accepts a dir or a `.zip`, can be repeated, and a folder of plugins loads each child [CLI help]. Without a manifest, the directory name becomes the plugin name [docs].
  - `--plugin-url <zip>` fetches a plugin for the session [CLI help].
  - For persistent installs: `claude plugin install <p>@<marketplace> --scope user|project|local`, `claude plugin enable/disable --scope …`, and `claude plugin validate <path>` [CLI help].
- **Per project. Yes.** Use `--scope project`, which writes `enabledPlugins` into `.claude/settings.json`, or `--scope local` for `.claude/settings.local.json` [CLI help + docs]. A marketplace can be a local directory [docs].

---

## 5. Slash commands, skills, and bypassing the model

- **How `!` bash works.** `` !`cmd` `` (or a ```` ```! ```` block) runs **once, at invocation, before the model sees the prompt**. Its stdout replaces the placeholder [docs].
  - **Permissions:** the command goes through normal permission checks; `allowed-tools` pre-approves it. A non-zero exit aborts the whole command [docs].
  - **Policy:** `disableSkillShellExecution` turns it off [docs].
  - **`$ARGUMENTS` is spliced into the shell text as raw source.** With args `hi $(echo INJECTED) …`, the permission checker saw `printf '[%s]' "hi $(echo INJECTED) ` and refused: "Shell command permission check failed … printf operand 'hi $(…)' is runtime-determined". Plain words passed through fine [probe]. So **`!` is not safe or reliable for carrying human text**, because quotes, backticks and `$` break it or get refused.
- **Can `/say` post the human's exact text with no model rewrite? Yes, with a hook rather than with `!`** [probe]. The setup has three parts:
  - a `say` command file;
  - a `UserPromptExpansion` hook with `matcher: "say"`, which receives `command_args` as a JSON string;
  - the hook appends that string to the room log and returns `{"decision":"block", …, "suppressOriginalPrompt": true}`.

  The probe input was `/say I object: keep   the retry   at 3, not 5 — "bob"`. The hook received it byte-for-byte, including repeated spaces, the em dash and the quotes. The run used **`num_turns: 0`, `total_cost_usd: 0`**, so no model turn happened at all [probe].
  - **Alternative:** a `UserPromptSubmit` hook that matches a prefix (for example lines starting `>>`) can do the same for un-commanded text [docs + inferred].
- **Can a skill or command bypass the model entirely?** The command itself cannot, because a skill's body always becomes a model turn [docs]. **A blocking UserPromptSubmit or UserPromptExpansion hook does bypass the model**: its side effect runs, and the turn is cancelled before any API call [probe].
  - Do the reverse direction (room → human) with a plugin **monitor** or an `asyncRewake` hook, not a model relay [docs/source + inferred].
- **Caveat for seats.** The `/say` hook fires in the session the human types into. A seat *subagent* has no prompt box of its own: the human types into the orchestrator's session (or a local client), not into the subagent. So `/say` belongs to whatever session the human actually types into, and the hook stamps identity from the environment (`$ROOM_USER`), not from the model [inferred].

---

## Building blocks for the room plugin

| Need | Mechanism that fits | Evidence |
|---|---|---|
| **Seat agent** | One agent definition per human (`seat-alice`, …). Generate them as `--agents` JSON at launch, or write `.claude/agents/seat-*.md`, and **not** as plugin agents, which lose `hooks`/`mcpServers`/`permissionMode`. Give each a room MCP server (inline `mcpServers`), `background: true`, and the human's name in `agent_type`, so every hook can attribute by `agent_type` without trusting the model. The orchestrator talks to seats with SendMessage, and a PreToolUse hook on `SendMessage` can log and verify the sender (`agent_id`/`agent_type`). | source + probe (attribution) |
| **Sign-off gate** | A PreToolUse hook matching `ExitPlanMode` reads the room log. If any seat hasn't signed the current plan hash (the plan text is in `tool_input.plan`), it returns `permissionDecision:"deny"` and names the missing seats. The model sees the reason and stays in plan mode, and the human only gets the approval dialog after every sign-off. Use a PermissionRequest hook as an optional auto-approve. Ship it in the plugin's `hooks/hooks.json`. | probe |
| **Verbatim `/say`** | A `say` command plus a UserPromptExpansion hook (`matcher: "say"`). The hook appends `command_args` with `$ROOM_USER` to `log.jsonl`, then blocks with `suppressOriginalPrompt`. This takes zero model turns and keeps the text byte-exact. Avoid `` !`room post "$ARGUMENTS"` ``, which splices raw text into shell source. | probe |
| **Evidence-backed done** | A PreToolUse hook on the room MCP tool's `done` call (or on `Bash` matching `room done`) denies the call unless a fresh test run is attached. A PostToolUse hook can attach the `npm test` result itself through `additionalContext`/`updatedToolOutput`. A Stop/SubagentStop hook with `decision:"block"` keeps a seat working if it claims done with no evidence on the log. The channel enforces the rule, not the model. | docs + source |
| **Orchestrator / room feed** | Plugin `settings.json` `agent` makes the orchestrator the main-thread agent. A plugin **monitor** or an `asyncRewake` hook tails `log.jsonl` and wakes the session on new human posts. Plugin `channels` are the later path to a remote relay. | docs + source |
