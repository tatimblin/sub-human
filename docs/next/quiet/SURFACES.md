# What a plugin can show a person in Claude Code 2.1.296: a catalog of surfaces

Research for sub-human: which surfaces exist, how each one looks, and which suits which message tier (P person / S state / C Claude-only / D debug, from PRINCIPLES.md).

**How the claims were checked**
- **[live]**: seen on screen in a throwaway interactive `claude` 2.1.296 running in tmux. It used an isolated `CLAUDE_CONFIG_DIR=/tmp/probe-surfaces/cfg` and a scripted mock of the Messages API (`/tmp/probe-surfaces/mock.mjs`), so tool calls were deterministic and no real account was involved. A probe plugin was loaded with `--plugin-dir /tmp/probe-surfaces/plugin`: command hooks driven by files, a tiny stdio MCP server, a plugin `settings.json`, and a hooks module (`hooks/register.tsx`). For color I captured the pane with `tmux capture-pane -e`: 246 is grey/dim, 220 is amber/warning, 211 is red/error, 114 is green. "Model saw" means I checked the actual request body the mock received.
- **[docs]**: code.claude.com/docs (hooks, statusline, plugins-reference, plugins/components, mcp), fetched 2026-11-02. The docs track a newer build, so every docs-only feature named here was also checked against the 2.1.296 binary's strings.
- **[types]**: the hooks-module API this build writes (`plugin-authoring/types/claude-code.d.ts`, 21k lines) and its `reference.md`.
- **[contract]**: `lib/cc/contract.json`, the plugin's own record of Claude Code internals.

Reproduce: `sh /tmp/probe-surfaces/run.sh probe "--debug"`, then `sh /tmp/probe-surfaces/cap.sh probe "<prompt>"`. Hook behaviour is set with `sh /tmp/probe-surfaces/m.sh EVENT json '{…}'`, and a prompt `CALL <Tool> {json}` makes the mock model call that tool.

---

## 0. Ten facts that change the design

1. **A plugin CAN ship `subagentStatusLine`.** Write it in the plugin's root `settings.json`. In 2.1.296 only two keys are allowed there: `["agent","subagentStatusLine"]`. [live] the probe plugin's row script drew `◯ PLUGINROW jess · dim` with no user settings. Two catches, both [live]:
   - `${CLAUDE_PLUGIN_ROOT}` is neither substituted nor set in that command (exit 127; this is the README's complaint). A command that finds its script another way works, e.g. `"${SUB_HUMAN_HOME:-$HOME/.sub-human}/bin/row-status"`, which is the exact line the README asks people to paste.
   - A person's own `subagentStatusLine` overrides the plugin's.

   So the "rows show names unless you edit settings.json" step (`lib/commands/help.ts:29`, README "Rows") can go: ship `plugin/sub-human/settings.json`. **Unused today.**
2. **`subagentStatusLine` can hide a row.** Write `{"id": …, "content": ""}` [live] and the row disappears from the agent panel. A written row replaces the whole default `name · description · time · tokens` body, ANSI kept, drawn dim. This fixes stale labels like `Spawning dev participant row 13m` (EVALUATION M11/M54) and lets ended rows vanish.
3. **`$.ui.status` looks like a warning.** [live] It draws in the notification area under the prompt as amber (`38;5;220`) `⚠ <plugin>: <text>`, above the status line. That is the wrong look for ambient state such as "2 here · online". sub-human uses it today for the invite line and PIN (`mod/deliver.ts:490`), where amber attention is arguably right. Don't make it the S-tier home.
4. **`$.ui.log(text, { to: 'debug' })` is the D tier, built in.** [live] It writes `[probe] $.ui.log (to debug): …` to Claude Code's own debug log and never to the screen. `ui.log` is also an event, so a hook can re-route any line with `next({...e, to: 'debug'})`. PRINCIPLES' "debug channel" needs no new file for the `--debug` mirror. **Unused today** (0 hits for `to: 'debug'` in `mod/`).
5. **`$.ui.toast(text)` is a quiet, transient P surface.** [live] It is a small rounded box over the transcript's top-right corner, headed by the plugin name, gone after 4 s. It is not in the transcript and the model never sees it. It suits "jess joined" or "plan agreed" for people who aren't the opener, and receipts that must exist at all. **Unused today.**
6. **Three more quiet S surfaces, all [live], none used by sub-human:**
   - the **AbovePrompt band**: a dim row above the prompt with a `[-]` collapse;
   - **SessionMode**: dim labels at the right end of the footer, e.g. `Debug · room dolphin-5869`;
   - **PromptHint `tail`**: dim text after the footer hint line, e.g. `· @room to talk`.
7. **`ui.render` can delete native noise sub-human causes**, all [live]:
   - `ToolUse` plus `ToolResult` returning `<Box/>` removes the whole `⏺ Agent(…) ⎿ Backgrounded agent (↓ to manage · ctrl+o to expand)` block for a row spawn (EVALUATION M7).
   - `TurnDuration` controls the `✻ Waiting for N background agents to finish` line (EVALUATION M10). It is the TurnDuration site (the binary calls it the turn_duration message: "'Done in Ns' / 'Waiting for N agents' line"), not `Spinner`. Its props carry only `{word, durationMs}`, so the plugin must know for itself when its own rows are the only thing pending.
   - The change is drawing-only. The model still reads everything.
8. **A tool group collapses by default, so a PreToolUse deny's red `Error:` is usually invisible.** [live] Once the turn moves on, a finished call collapses to one dim line, `Called plugin:probe:p` or `Ran 1 shell command`. The deny reason (`⎿ Error: PreToolUse:<tool> hook error: <reason>`, red 211) shows only in ctrl+o / verbose. Hook `systemMessage` lines and PostToolUse block reasons **do** show under the collapsed line. So the red receipts in EVALUATION (M22/M34) are seen while the call is live or expanded. Keep denies in Claude's words anyway, since the model reads `PreToolUse:<tool> hook error: <reason>`.
9. **`structuredContent` replaces the text for the model AND the person.** [live] When an MCP tool declares `outputSchema` and returns `structuredContent`, the model's tool_result was `{"who":"jess","n":3}`, the content text was dropped, and the transcript showed the pretty-printed JSON. The room server returns text only today (correct). Never add `structuredContent` to a tool whose text Claude must read.
10. **MCP elicitation is native, model-blind, and works in 2.1.296.** [live] It draws a form dialog under a rule: `MCP server "plugin:sub-human:room" requests your input`, then the message, an enum shown as a radio list, a free-text field, and `Accept  Decline`. It returned `{"action":"accept","content":{"choice":"agree"}}`. The model saw only the tool's own result. The dialog's title names the *server* (`plugin:probe:p`), which is plugin jargon. It is good for consent when the plan view can't be used.

---

## 1. Hook outputs (command hooks in hooks.json; also `classic.<Event>` in a module)

The general rules, from [docs] and confirmed [live]:
- **A hook line the person sees** is drawn as `  ⎿  <Event>[:<matcher>] says: <text>` in grey 246. When it belongs to a tool it is nested under that call's row. It persists in scrollback and on `--resume`, and the model never sees it.
- **Amber 220 warnings** (`⏺ …blocked by hook / stopped by hook`) are the "something went wrong" color.
- **Plain stdout, exit 0**: written to the debug log only, except on UserPromptSubmit, UserPromptExpansion, SessionStart and PostModelSwitch, where it becomes model context.
- **`suppressOutput`**: no effect ([docs]: "Has no effect").
- **Size cap**: 10,000 characters for `additionalContext`, `systemMessage` and stdout. Beyond it, the text is saved to a file and only a 2,000-character preview is inlined.
- **`terminalSequence`**: allowlisted OSC 0/1/2/9/99/777 or BEL (window title, desktop notification), interactive sessions only; present in the 2.1.296 binary. Use it to raise a desktop notification from events that discard `systemMessage`.

| Event · output | Person sees (exact look) | Model sees | Persists | Notes |
|---|---|---|---|---|
| **SessionStart** `systemMessage` | `⎿  SessionStart:startup says: <text>` grey, under the logo [live] | no | yes | the `:startup` / `:resume` / `:clear` / `:compact` source is in the label |
| SessionStart `additionalContext` / stdout | nothing | yes, at the top of the system context as `SessionStart hook additional context: <text>` [live] | re-run on resume | also `sessionTitle`, `initialUserMessage` (only with `-p`), `watchPaths`, `reloadSkills` |
| SessionStart exit 2 | a `hook error` notice | no | yes | |
| **UserPromptSubmit** `systemMessage` | under the prompt: `⎿  UserPromptSubmit says: <text>` grey [live] | no | yes | |
| UPS `additionalContext` / plain stdout | nothing [live] | yes, `UserPromptSubmit hook additional context: <text>` next to the prompt [live] | replayed on resume | the sub-human pull/FYI context belongs here (C) |
| UPS `decision:block` + `reason` | amber `⏺ UserPromptSubmit operation blocked by hook:` / `  <reason>` / `  Original prompt: <text>`; **the typed text is put back in the composer** [live] | no (reason "not added to context") | yes | `suppressOriginalPrompt:true` drops the "Original prompt" line (in binary) |
| UPS exit 2 + stderr | same amber frame, plus `[<command>]: <stderr>` and `This hook comes from the <plugin>@<marketplace> plugin.` [live] | no | yes | ugliest variant: it shows the shell command |
| UPS `continue:false` + `stopReason` | amber `⏺ Operation stopped by hook: <stopReason>`; the prompt row stays [live] | yes (isMeta row, per contract `ups-stop-frame`) | yes | the module can rewrite the row (contract `session-append-notice-rewrite`) |
| UPS exit 1 (other non-zero) | grey `⎿  UserPromptSubmit hook error` / `⎿  Failed with non-blocking status code: <stderr first line>` [live] | no | yes | the prompt still goes through |
| **PreToolUse** `permissionDecision:deny` + reason | collapsed: just `Called <server>` / `Ran 1 shell command`. Expanded (ctrl+o): `⎿  Error: PreToolUse:<Tool> hook error: <reason>` in red 211 with a red ⏺ [live] | yes, tool_result `is_error:true`: `PreToolUse:<Tool> hook error: <reason>` [live] | yes | a **module** `tool.call` `{deny}` reads `<tool_use_error>reason</tool_use_error>` to the model and draws `Error: <reason>` without the "hook error" prefix [live] |
| PreToolUse `permissionDecision:ask` + reason | the native permission dialog: `Tool use` / `<server> — <Tool> Tool: (MCP)` / input / `About …:` / `│ Hook PreToolUse:<tool> requires confirmation for this tool:` / `│ <reason>` / `settings.json to update hooks` / `Do you want to proceed?` / `1. Yes  2. Yes, and don't ask again …  3. No` / `Esc to cancel · Tab to amend` [live] | no (only the outcome) | the dialog doesn't persist | framing is mechanical ("Hook … requires confirmation", "settings.json to update hooks"), not native-friendly for room consent |
| PreToolUse `allow` | no dialog; nothing drawn | — | — | skips the person's permission check: don't use it for consent |
| PreToolUse `updatedInput` | the row shows the rewritten input | the rewritten input | yes | [docs] |
| PreToolUse `additionalContext` | nothing | yes, even with a deny [live]: `PreToolUse:<tool> hook additional context: …` | yes | this is how a deny's next-step text stays C (contract `pretool-deny-context`) |
| PreToolUse `systemMessage` | `⎿  PreToolUse:<Tool> says: <text>` grey, **visible even when the group is collapsed** [live] | no | yes | |
| **PostToolUse** `decision:block` + reason | `⎿  <reason>` under the call, even collapsed; expanded it is preceded by `⎿  PostToolUse:<tool> hook returned blocking error` [live] | yes, `…hook blocking error from command: "<cmd>": <reason>` [live] | yes | the tool already ran |
| PostToolUse `additionalContext` | nothing [live] | yes [live] | yes | |
| PostToolUse `updatedToolOutput` | the rewritten output (expanded view) [live] | the rewritten output [live] | yes | strip or shape a tool's result for both audiences |
| PostToolUse exit 2 | `⎿  PostToolUse:<tool> hook returned blocking error` / `⎿  [<cmd>]: <stderr>` / `This hook comes from …` [live] | yes | yes | |
| Every PostToolUse | `⎿  1 PostToolUse hook ran` (verbose only) [live] | — | — | |
| **Stop** `decision:block` + reason | `⏺ Ran 1 stop hook` / `⎿  Stop hook error: <reason>` plus a footer notice `Stop hook error occurred · ctrl+o to see`; the turn continues [live] | yes, `Stop hook feedback:\n<reason>` [live] | yes | it loops (cap 9 consecutive, then a long amber override message) [live] |
| Stop `hookSpecificOutput.additionalContext` | **still visible**: `⏺ Ran 1 stop hook` / `⎿  Stop hook feedback: <text>`, but no "error" and no footer notice [live] | yes, as a system-reminder; the turn continues [live] | yes | contract `stop-additional-context` says it has "no red line", which is true, but it is not invisible |
| Stop `systemMessage` | `⎿  Stop says: <text>` under the last reply [live] | no | yes | |
| **Notification** | `systemMessage` and `continue` discarded [docs]; exit code ignored | — | — | side effects only; `terminalSequence` works here |
| **UserPromptExpansion** block | `UserPromptExpansion operation blocked by hook:\n<reason>` warning (contract `expansion-block-frame`) | no | yes | |
| **MessageDisplay** (present in 2.1.296) | `displayContent` replaces the streamed assistant text on screen only [docs] | the original | the transcript keeps the original | not a plugin message surface; noted for completeness |
| **Elicitation / ElicitationResult** hooks | can answer an MCP form with no dialog [docs, contract] | — | — | |

---

## 2. Hooks module surfaces (`hooks.json` `modules`, `$` API) — the native toolkit

sub-human's module uses `$.ui.log` (32 calls), `$.prompt.submit` (19), `$.ui.ask` (1: the leave card), `$.ui.status` (invite pin), `$.session.append` (2), and `ui.render` on `UserMessage` (redraw) and `PromptHint` (observe only).

| Surface | Look [live unless noted] | Model sees | Persists | Limits / notes |
|---|---|---|---|---|
| `$.ui.log(text)` | `⏺ <plugin>: <text>`, all grey 246, own row | no | yes, stored as a notice, redrawn on `--resume` | one line (a newline draws as U+FFFD, contract `ui-log-notice`); terminal draws the first 2,000 characters; the `<plugin>:` prefix is always there |
| `$.ui.log(text, {to:'debug'})` | nothing; debug log `[<plugin>] $.ui.log (to debug): <text>` | no | debug file only | **the D tier**; a hook on `ui.log` can re-route any line |
| `$.ui.toast(text, {timeoutMs})` | rounded box at the top-right over the transcript: `│ <plugin> │` / `│ <text> │`; default 4 s; click dismisses; on the notification bar when nothing floats | no | **no** | 2,000 characters; one seat per plugin (a newer toast replaces your own) |
| `$.ui.status(text)` | amber `⚠ <plugin>: <text>` on the notification area under the prompt, above the statusLine; pinned until replaced or `undefined` | no | no | **looks like a warning**; one per plugin |
| `$.ui.notify(text, {title})` | OS or terminal notification on the person's `preferredNotifChannel`; Notification hooks see it first | no | no | [types] for "your answer needed" while the person is away |
| `$.ui.ask(q, {options, header, multiSelect})` | the native AskUserQuestion card: `☐ <header>` / question / `1. A  2. B  3. Type something.` / `4. Chat about this` / `Enter to select · ↑/↓ · Esc` | **no**: no tool row and nothing in the request [live] | no | 2–4 options; rejects on Esc and with `-p`; the "Type something." and "Chat about this" rows can't be relabeled (memory note) |
| `$.ui.notice(tool_use_id, text)` | [types] one line under the open dialog of that call | no | no | [live] **not reproduced**: called from `tool.call` (before the dialog) and 400 ms later, neither drew under an MCP `ask` dialog and the debug log was silent. Verify before building on it (EVALUATION M23/M24) |
| `ui.render` **AbovePrompt** | a band directly above the prompt with the plugin's tree (dim/bold as drawn) and a `[-]` collapse at the right; ctrl+x tab focuses it | no | no (live) | one instance shared by plugins; yield when `hasSurvey`; `maxRows` capped at half the terminal |
| `ui.render` **SessionMode** | dim labels at the footer's right end, joined with ` · ` (`Debug · room dolphin-5869`) | no | no | ideal for a one-word room tag |
| `ui.render` **PromptHint** `tail` | dim text appended to the hint line (`⏸ manual mode on · ← for agents · <tail>`) | no | no | cut where the row ends; terminal only |
| `ui.render` **ToolUse / ToolResult / ToolGroup** | return `<Box/>` to remove a call's row and its `⎿` result (Agent spawns included) | still sees it | — | drawing only; a ToolGroup hook would also remove the collapsed `Called …` line |
| `ui.render` **TurnDuration** | replaces `✻ Baked for 3s` and `✻ Waiting for N background agents to finish` | no | — | props `{word, durationMs}` only |
| `ui.render` **Spinner** | rewrite `word` / `message` / `suffix` of the live spinner | no | — | **not** the "Waiting for N agents" line |
| `ui.render` **UserMessage / CommandOutput / InfoNotice** | redraw a prompt row, a slash command's output row, or a logo notice | the original | — | sub-human uses UserMessage for "bob's Claude: …"; its own `$.prompt.submit` rows can't be redrawn (contract `render-own-prompt-reentry`) |
| `ui.render` **Pane** + `$.ui.open` | a framed region: docked beside the transcript in fullscreen (unasked only from 144 cols), above the prompt otherwise | no | no | a room sidebar is possible; heavier than the panel |
| `$.session.append` system row | ctrl+o only (level info) | no | yes | the D-ish mark sub-human uses for `home FOLDER` |
| `$.session.append` user row (isMeta) | not drawn | yes, at the next loop top | yes | C without waking the model |
| `prompt.submit` `{drop: reason}` | amber `⏺ Prompt dropped by a hook: <reason>`; the person's row is lost [live] | no | yes | `{}` is **invalid** here: `probe: prompt.submit hook skipped: returned the wrong shape (neither { text } nor { drop })` [live] |
| `command.run` `{}` | nothing at all, not even the command echo (contract `command-run-empty-answer`) | no | — | the quietest slash-command answer; pair with `$.ui.log`/toast |
| `command.run` `{text}` | the output row `<plugin>: <text>` under the echo | **yes** (and the model may repeat it) | yes | |
| `$.prompt.submit` (between turns) | framed `› Prompt from the <plugin> plugin`, or bare with `asUser` | yes | yes | a wake; always costs a model turn |
| `prompt.context` / `prompt.section` / `prompt.compose` | nothing | yes (system prompt or first-message context) | — | static C that would otherwise ride on every UPS hook |
| `$.audio.play`, `$.ui.copy`, `$.ui.selection` | sound / clipboard / selection | no | — | `$.ui.copy` replaces the shell clipboard probing in `copy.ts` |

---

## 3. MCP tool results (`mcp/room-server.ts`)

All [live] with the probe server (default view, not verbose).
- **Row.** While running: `⏺ Calling plugin:probe:p…` (`· 3s…`). When the turn moves on, consecutive calls collapse into one dim line `Called plugin:probe:p` (`Ran N shell commands` for Bash), with no result and no error mark. ctrl+o expands it to `⏺ plugin:probe:p - say (MCP)(text: "hi")` / `⎿  <result>`.
- **Text result**: drawn under `⎿`, all lines in verbose (40/40 shown). The model gets the content blocks verbatim.
- **`isError:true`**: red ⏺ (211) and `⎿  Error: <text>` in red. The model gets `is_error:true`.
- **`structuredContent` with `outputSchema`**: the transcript shows the pretty-printed JSON, and **the model gets only the JSON, not the text** (see §0.9).
- **`_meta` on a result**: not drawn; it reached nothing visible. The probe sent `anthropic/maxResultSizeChars`. [docs] says a server can raise the 50,000-character spill-to-file limit per tool; the exact key wasn't confirmed.
- **Empty `content: []`**: a row with no result line.
- **Limits** [docs]: a warning above 10k tokens; capped at 25k tokens (`MAX_MCP_OUTPUT_TOKENS`); text results above 50k characters are saved to a file.
- **Progress notifications**: keep a hold alive (contract `mcp-progress-resets-idle-timeout`). They draw no text sub-human relies on.
- **Elicitation**: see §0.10. It is held until answered (Esc cancels), works in default, auto and bypass modes (contract), returns `cancel` under `-p`, and the model never sees the form.
- **Server `instructions`**: one paragraph in the system prompt (C). sub-human already uses it.
- **Channels** (`claude/channel` + `--channels`): push into the session as model-visible events, opt-in per launch. Not a quiet person surface.
- **Plugin `monitors`** (`experimental.monitors`, [docs]): a background command whose output "reaches Claude as notifications". It wakes the model, so it isn't a person surface, and it isn't needed given the tail child.

---

## 4. Status lines and the agent panel

- **`statusLine`** (person's settings only; **a plugin cannot supply one**: only `agent` and `subagentStatusLine` survive in plugin settings, [binary]):
  - its own grey row under the prompt (`STATUSLINE probe` [live]); multi-line, ANSI, OSC 8;
  - re-run on events, debounced 300 ms, optional `refreshInterval` (≥1 s);
  - it hides most footer hints;
  - the model never sees it.
- **`subagentStatusLine`**:
  - Input: `{session_id, transcript_path, cwd, columns, tasks:[{id, name, type:"local_agent", agentType, status, description, label, startTime, model, contextWindowSize, tokenCount, tokenSamples, cwd}]}` [live].
  - Output: one `{"id","content"}` line per row to override. `""` hides the row [live]; an omitted id keeps the default.
  - Look: `◯ <content>` drawn grey 246, nested under `⏺ main`. The right-hand `5s · ↓ 25 tokens` column goes away for overridden rows [live].
  - Re-run on its own tick while rows exist.
  - **Shippable by the plugin** (§0.1); the person's own setting wins; gated by workspace trust and `disableAllHooks`.
- **Default agent panel row**: `◯ <name>  <description or label>   5s · ↓ 25 tokens`. `label` is Claude Code's progress summary, which is why "Spawning dev participant row" sticks.
- **Background agent spawn**: `⏺ Agent(<description>)` / `⎿  Backgrounded agent (↓ to manage · ctrl+o to expand)`. Then the turn line `✻ Waiting for N background agent(s) to finish`, and footer `· ← for agents`. Hand-backs arrive as peer messages and start a turn (contract `subagent-handback-message`).

## 5. Slash commands and skills
- **A plugin command or skill `.md`**: the echo `❯ /probe:probecmd`, then the body expands as a user turn the model reads, wrapped in `<command-message>/<command-name>`. The person sees only the model's reply [live].
- **A module `command.run` with `{}`**: nothing drawn and no model turn. This is the quiet way to answer `/sub-human` (in use).
- **`!` bash output and local commands**: they go into the conversation as `<local-command-stdout>` (model-visible).

## 6. AskUserQuestion and plan dialogs
- **The AskUserQuestion card** comes from the model's tool (it leaves a tool row; the answers are model-visible) or from `$.ui.ask` (no row, model-blind) [live].
- **A `PreToolUse` `ask`** borrows the permission dialog with the "Hook … requires confirmation for this tool:" framing [live]. It suits risky tools, not friendly consent.
- **The plan view (ExitPlanMode)**: `Ready to code? / Here is Claude's plan: …` with `1. Yes, and use auto mode / 2. Yes, manually approve edits / 3. Tell Claude what to change`. Its words are coding-centric (EVALUATION M23).

---

## 7. Surface → best use for sub-human

| Surface | Tier | Best use in sub-human | Status today |
|---|---|---|---|
| plugin `settings.json` `subagentStatusLine` | **S** | the room row and participant rows: who's here, online/offline, queued, "your answer needed"; hide ended rows with `""` | **not shipped** (README asks the person to paste it) |
| AbovePrompt band | S (+P on focus) | one dim line while something needs you: `paging v2 · waiting on bob`; empty otherwise | unused |
| SessionMode label | S | `room dolphin-5869` in the footer while seated | unused |
| PromptHint `tail` | S | `@room to talk` in place of the hint taught in participant rows (`mcp/hold.ts:66`) | observe-only |
| `$.ui.status` | S-urgent | only for something worth amber: the live invite (PIN) | used for the invite (fine) |
| `$.ui.toast` | P-light | joins and leaves for non-openers, "plan agreed", any receipt that must exist | unused |
| `$.ui.log` | P | other people's words, a decision landed, a failure only you can fix | used (32×); too much goes here |
| `$.ui.log({to:'debug'})` | **D** | retries, restores, leases, link flaps, timings (PRINCIPLES' debug channel) | **unused** |
| `$.ui.notify` / `terminalSequence` | P-away | "jess asks for your review" when the session is idle or unfocused | unused |
| `$.ui.ask` | P-decision | a consent the person must give, without a model turn | used (leave card) |
| MCP elicitation | P-decision | sign-off fallback while the plan view can't take it; model-blind | used (fallback) |
| plan view (EnterPlanMode/ExitPlanMode) | P-decision | review a room plan | used |
| `ui.render` ToolUse/ToolResult/TurnDuration | delete noise | hide `Agent(sub-human:room) ⎿ Backgrounded agent…` and `Waiting for N background agents` caused by rows | unused |
| `ui.render` UserMessage | P (restyle) | `bob's Claude: …` | used |
| hook `systemMessage` | P | rarely: it is labelled `<Event> says:` (mechanical) | — |
| `additionalContext` (UPS, Pre/PostToolUse, SessionStart) | **C** | room state, pulls, the next step after a deny | used |
| `$.session.append` user isMeta | C | context without waking the model | used |
| `prompt.context` / `prompt.section` | C | static mechanics (the member brief) once per conversation | unused |
| MCP tool result text | C (+P collapsed) | what Claude needs back; keep text-only (no `structuredContent`) | used |
| PreToolUse deny reason | C (shows red when expanded) | short, Claude-addressed refusals; the next step goes in `additionalContext` | used |
| `$.session.append` system row | D-ish (ctrl+o) | `home FOLDER` mark | used |
| UPS `continue:false` / drop / block | avoid | every variant is amber with a mechanical frame ("Operation stopped by hook", "Prompt dropped by a hook", "blocked by hook") | used for @room receipts |
| Stop `additionalContext` | C (but visible) | draws `⏺ Ran 1 stop hook ⎿ Stop hook feedback: …`; use only when the turn must continue | used (review nudge) |
| `$.prompt.submit` wake | P+C | a wake for a direct message only; it costs a model turn | used |
| `statusLine` | — | can't be shipped by a plugin; leave it to the person | — |
| plugin monitors / channels | — | they wake the model; not needed | — |

## 8. Open items
- `$.ui.notice` under a dialog did not draw in my probe (MCP `ask` dialog). Retest under ExitPlanMode before relying on it for M23/M24.
- `TurnDuration` gives no pending-agents count. To keep `✻ Done for 3s` for real work, rebuild the line from `word`/`durationMs` and replace only while the plugin's own rows are the sole pending work.
- The `$.ui.status` amber look may come from the notification kind. Nothing in the API picks a calmer style.
- Probe artifacts are in `/tmp/probe-surfaces/` (plugin, mock, logs, debug logs under `cfg/debug/`).
