# Room row spike: can a background agent's row be the room's chat?

Claude Code 2.1.296. This spike answers PLAN-QUIET Phase 3's "spike first" list. Can a person enter one agent-panel row, the room, and type into it to post their exact words, send a DM, or ask how someone's work is going, all without a model turn?

**Verdict: yes, in the terminal, using three early-access surfaces together.**
- The person's typed words reach the module verbatim, at Enter, through `session.append`.
- A `turn.step` hook answers each of the room agent's steps itself, so no model request is ever made.
- A nested "keeper" child keeps the room agent alive and resumable, so it never wakes main with a task notification.

Whatever the plugin wants in the row is drawn there as a synthesized reply: the roster, incoming messages, DM replies and status answers. The desktop app and VS Code can't type into a background agent in this build. `@room` should stay, as the main-session and non-terminal path.

## Evidence

- **Live runs.** The probe was a throwaway interactive `claude` in tmux session `rr-main`. It used an isolated `CLAUDE_CONFIG_DIR=/tmp/probe-roomrow/cfg`, a scripted mock Messages API on `127.0.0.1:8766` (`/tmp/probe-roomrow/mock.mjs`, so there was no real cost), and a clean `env -i` launch (`/tmp/probe-roomrow/run.sh`).
- **The probe plugin** is `/tmp/probe-roomrow/plugin`:
  - a hooks module, `hooks/register.tsx`, that logs every event to `log/mod.log`, with switches under `mode/`;
  - classic hooks that log to `log/classic.log`;
  - a stub MCP server, `mcp.mjs`, whose `hold` tool blocks;
  - the agents `rr:room` and `rr:keeper`;
  - its own `settings.json` `subagentStatusLine`.
- **Pane captures** are in `/tmp/probe-roomrow/caps/NN-*.txt` (with `.ansi` copies). Event logs for each run are in `/tmp/probe-roomrow/log-run*/` and `log/`.
- **Other sources:** the module d.ts (`.claude-plugin/types/claude-code/index.d.ts`) and the 2.1.296 binary's strings (`/tmp/probe-roomrow/strings.txt`).
- **Not tested:** the desktop app or VS Code (from binary strings only), `--resume`, Esc or `x` inside the row, and real models.

---

## Q1. Exact words, no model turn: **works (with caveats)**

### Which hooks fire when a person types into a background agent's row

| Event | Fires? | Evidence |
|---|---|---|
| module `prompt.submit` | **No.** It fires only for main's composer and for task notifications | `mod.log` of every run: the only `prompt.submit` entries are `SPAWN`, `SAY …` and `<task-notification>` |
| classic `UserPromptSubmit` | **No.** It fired once in run 1, for main's task notification | `classic.log` |
| `session.receive` | **No.** It doesn't fire for typed input, nor for the plugin's own `$.session.send` to the agent | no entries in any run |
| `prompt.edit` on Enter | **No.** Enter isn't an edit | no `prompt.edit.enter` entries |
| `turn.start` | **No.** It doesn't fire for subagent turns, only for main | |
| **`session.append`** | **Yes. This is the one that carries the words** | see below |

The `session.append` event carries `agentId`, `origin: {kind: "composer"}` and the person's text inside a fixed wrapper. Its door depends on the agent's state:

- **Agent idle** (status `completed`, resumable): door `"prompt"`, a user row with `isMeta: true`. It fires **at Enter** and starts a new turn of the agent:
  ```
  session.append {"door":"prompt","origin":{"kind":"composer"},"agentId":"ada989e85ab51731a","msg":{"type":"user","isMeta":true,
    "content":[{"text":"The user sent a new message while you were working:\nhello room, deploy is green\n\nThis is how Claude Code surfaces messages …"}]}}
  ```
- **Agent inside a running tool** (the blocking `hold`): door `"delivery"`, attachment `queued_command`, fired only **at the next tool boundary**. In run 1 the typed text sat queued for 20 s until `hold` returned (`03-typed-while-hold`, `04-after-release`). Nothing at all fired at Enter.

The agent is identified by `agentId` (the `$.agent.spawn` answer, equal to classic `agent_id`) and by agent type `rr:room` (classic `agent_type`, `$.agent.list().type`). The session id is main's.

The words come out exactly, unwrapped from between `while you were working:\n` and `\n\nThis is how`. Run 5 checked this:
- `exact: "quotes" <b>tag</b> \n back\slash — ünïcode 🚀 @room` came through unchanged (`55-exact`);
- a two-line input came through as `line one\nline two` (`56-multiline`).

### Stopping the model turn, and what each way draws

| Way | Result |
|---|---|
| `prompt.submit {drop}`, UPS `continue:false`, UPS `block` | Not available: none of them fires for row input. |
| `session.append` `{deny}` on the typed row | **Refused by the engine**: `rr: session.append hook skipped: returned the wrong shape (a deny of a row the engine appends (only a plugin's own append is refused))`. The row goes in anyway. This draws an informational notice on main, not in the row (`log-run3b/mod.log`). |
| `session.receive {consumed}` | Not available: it never fires. |
| **`turn.step` answered without `next`** | **Works, and it is quiet.** The step makes no model request (`mock.log` stayed empty for runs 3–5, apart from the summarizer below). Nothing amber is drawn. The hook yields its own chunks: a text reply, a tool call, or `end_turn`. |

With `turn.step` answering, the engine still runs a "turn" (`turn.complete` with `reason: "answer"`), but no model sees anything. That makes "no model turn" true in the sense that matters: no tokens and no model judgement.

Two details:
- An empty `end_turn` makes the engine add `[Your previous response had no visible output. Please continue …]` and ask for one more step. That step is synthesized too, so it costs nothing, but it leaves an isMeta row. Always answer with some text, such as `✓ sent`.
- The engine records a synthesized step as `door: "response", origin: {kind: "model", model: "claude-opus-5-5"}`. **The transcript says the model wrote text it didn't.** Provenance is a caveat: Anthropic's directory review may object, and it needs a contract entry.

If the step isn't synthesized, the text reaches the agent's model wrapped as above. The model replies (run 1: `⏺ ok.`), costing a full turn at about 7k context. The cheapest path that still uses a model would be one forced `post({text})` call, but that has the model retype the words, which isn't faithful. There's no reason to use a model at all: the module already has the exact words from `session.append`.

---

## Q2. Drawing into the row without a model turn: **works, through synthesized replies; `$.session.append` doesn't**

| Way | While the person is in the row | While they're elsewhere | Evidence |
|---|---|---|---|
| `$.session.append({agentId, message: system})` while the agent runs | Stored (`uuid` returned), **not drawn**, not even in ctrl+o | not drawn | `11-inject-sys`; ctrl+o showed nothing |
| `$.session.append(...)` while the agent is idle | **Refused**: `no running loop is <agentId>` | refused | `log/mod.log` `inject.*.result` |
| `$.session.send({to:{agentId}, text})` to the idle agent | Starts a turn (door `prompt`, origin `coordinator`). It draws `❯ <text>` as a user row, which a `ui.render UserMessage` hook hides (origin `coordinator`) | same, seen on entering | `33-send-reply` |
| …followed by a **synthesized step** with text | **Drawn at once** as `⏺ <text>`, multi-line included | **drawn on entry**: run 5 sent `maya → room: pushed the cursor change` while the person was in main, and it was there on entering (`54-reenter`) | `50-roster`, `52-dm-reply` |
| `ui.render ToolUse` on a running `hold` | Draws any tree in place of the call's row. It is live: `$.ui.invalidate('ui.render')` redraws it | — | wired in the probe; superseded by the idle design, so it never drew there |
| `ui.render UserMessage` / `ToolUse` / `ToolResult` / `TurnDuration` | **They apply inside the agent's view.** They hid the spawn prompt, the keeper's `⏺ rr:keeper(keeper) ⎿ Backgrounded agent` block, and the `✻ Waiting for 1 background agent to finish` line (`40-render-entered`) | they apply in main too, so scope them by `requestId` (a message uuid from that agent's `session.append`) | |

**The drawing path:** `$.session.send(roomAgent, …)`, then a `turn.step` hook answers that turn with the text to show.

The roster is the first such message after spawn. A refresh is another message. There is no model in either step.

`Spinner` is not raised for the agent's view. The agent's spinner word ("Roosting…") shows only while a step or tool runs, and in the idle design that is about 50 ms.

---

## Q3. Spawning and lifecycle: **works with caveats**

- **`$.agent.spawn` vs the Agent tool.** `$.agent.spawn({subagentType, description, prompt})` drew nothing in main's transcript. There was no `⏺ Agent(…) Backgrounded agent` block. The only line came from the probe's own `{drop}` (`01-spawn`). The row can be entered (↓ to it, then Enter), and typed input works.
- **The view.** Entering the row shows the agent's transcript. The composer is framed `─── the room ─` (the spawn's `description`) with the placeholder `Message @rr:room…` (the agent type, `Message @sub-human:room…` for real). No probed surface rewrites that placeholder. The footer adds `← for agents · ↓ to manage`.
- **Staying alive with `hold`.** The agent stays alive but is useless for chat: typed words wait until `hold` returns (Q1).
- **Staying alive idle (recommended).** The room agent's first synthesized step spawns a background **keeper** child (`Agent {subagent_type: "rr:keeper", run_in_background: true}`), whose own synthesized step calls the blocking `hold`. The room agent then ends its turn.
  - The engine sends a task notification "each time this agent stops with **no live background children** of its own" (binary note in the notification text). With the keeper alive, **none fires**: main never woke (runs 4 and 5).
  - The room agent sits `completed` and resumable. Every typed line and every `$.session.send` starts a turn of about 50 ms, with zero model requests.
  - It was still listed, and still enterable, about 13 minutes after its last turn (01:22 to 01:35), with **no model calls in that time** (`caps/60-idle10min.txt`).
  - **If the keeper dies, the next stop wakes main.**
- **The panel label.** The plugin's own `settings.json` `subagentStatusLine` works with no user setting. The row read `◯ panda-0976 · maya, dev · dev building http: GET /tasks`, and returning `""` for the keeper hid its nested `└ ◯` row (`40-render-entered`).
  - A person's own `subagentStatusLine` overrides the plugin's (SURFACES §1).
  - Without one, the row reads the description, and later the summarizer's words. The keeper's label became `ok.`, the mock's summary reply.
- **Cost that can't be removed: the agent summarizer.** While any agent *runs*, Claude Code forks a model call every 30 s (`querySource: "agent_summary"`, prompt `Describe your most recent action in 3-5 words…`). It is skipped while the transcript is unchanged (binary: `Skipping summary … transcript unchanged`).
  - It doesn't go through `turn.step` (never logged there), so a plugin can't answer it. The only switch is the SDK option `agentProgressSummaries`.
  - **Measured:** one call about 30 s after the keeper starts, then none while it blocks.
  - A `hold` that ticks every 3 s (tried in run 3) triggered a summary every 30 s with the whole growing transcript (`msgs=29, 59, 89`), plus a transcript row per tick. **Don't tick.**
- **Main's turn line.** With room and keeper alive, every main turn ends `✻ Waiting for 2 background agents to finish` (`57-main-unpolished`). That's the `TurnDuration` rewrite Phase 3 already plans, but now it counts 2.

---

## Q4. Other surfaces: **no (binary strings, not live)**

- The agent view is terminal REPL state (`viewingAgentTaskId`, `viewingAgentName`, `Message @${agent}…`).
- SDK hosts (the desktop app and the VS Code extension speak stream-json) get `task_started`, `task_progress`, `task_summary` and `stop_task`.
- Their **`send_task_message` is a stub.** The handler is `send_task_message:Dt` with `Dt=(e,o)=>{throw new NU(\`${R4}: send_task_message\`)}` and `R4="Unsupported control request subtype"`. The `summary` field's description says hosts render one-line rows only.
- So on the desktop, in VS Code, and on a phone over Remote Control, a person can see the room row's label but can't type into it. There `@room` (or a desktop `ui.render` pane) remains the way to talk.

---

## Recommended mechanism

1. **Spawn** from the module: `$.agent.spawn({ subagentType: "sub-human:room", description: "<CODE>", prompt: "<CODE>" })`.
   - Keep the agent id. Persist it in the plugin's state so a module reload doesn't lose it.
   - Don't spawn from a `turn.step` hook: "a subagent a hook spawned … steps past that hook".
2. **`turn.step` for the room agent and its keeper** answers every step without `next`:
   - The room's first step calls `Agent(sub-human:keeper, background)`, and the next ends with the roster text.
   - The keeper's single step calls `hold` with no tick. `hold` keeps its progress beat for the MCP idle timeout.
   - Every later room step answers the pending item (below), then `end_turn`.
3. **`session.append`** with `agentId === room` and door `prompt`:
   - origin `composer` means the person typed. Unwrap the text and route it (post / DM / status). Queue the reply text for the step.
   - origin `coordinator` means the plugin's own `$.session.send`. Queue it to be shown.
4. **Incoming room lines, DM replies and roster refreshes:** `$.session.send({to:{agentId}, text})`. Hide the `❯` echo with `ui.render UserMessage` (origin `coordinator`, scoped to the room's message uuids).
5. **Quiet the chrome with `ui.render`, scoped by `requestId`:**
   - the spawn prompt;
   - the keeper's Agent `ToolUse` and `ToolResult`;
   - the room's `TurnDuration` (`· type to talk to the room`, or nothing);
   - main's `Waiting for 2 background agents`.
6. **Label:** the plugin's `settings.json` `subagentStatusLine`. Use `""` for the keeper.
7. **Contract entries** (`lib/cc/contract.json`), each needing its own binary search string:
   - composer input to an agent arrives as `session.append` door prompt or delivery with the wrapper text;
   - `turn.step` answered without `next` is honoured for subagents;
   - no task notification while a background child lives;
   - `session.append` deny of engine rows is refused;
   - `send_task_message` is unsupported in SDK hosts.

Routing what the person types (D1, from Phase 3):
- `tell NAME …` and `NAME, …` go to NAME as a DM.
- `how's NAME …` is answered from the room's state. Pass it Claude to Claude (`SendMessage NAME.CODE`) only when asked.
- Anything else posts to the room verbatim.

## What the person sees inside the room row

This mock is assembled from the probe's real output (`52-dm-reply`, `54-reenter`). Three things were changed for the story:
- the lines were reordered;
- the DM reply comes from maya rather than dev;
- the probe's stray spawn-prompt line is removed (the ordering bug that echoed it is fixed by ignoring the spawn prompt in the queue).

Every line shape below was drawn live:

```
⏺ panda-0976
    maya   ✓ store: listTasks          idle
    dev    ◼ http: GET /tasks paging   building
    you    (dev)
❯ the deploy is green, merging paging v2              ← posting: your words, drawn by Claude Code itself
⏺ ✓ sent to panda-0976
⏺ maya → room: pushed the cursor change               ← a message arriving (sent while you were in main)
❯ tell maya the cursor is base64url                   ← a DM
⏺ → maya (DM): the cursor is base64url
⏺ maya → you (DM): ok, switching the encoder now      ← her reply comes back into the row
❯ how's dev doing?                                    ← "how's it going?"
⏺ dev · ◼ http: GET /tasks paging · building · last edit 2m ago · in a turn now
· type to talk to the room
──────────────────────────────────────────────────────────────── panda-0976 ─
❯ Message @sub-human:room…
─────────────────────────────────────────────────────────────────────────────
  ⏸ manual mode on · ? for shortcuts · ← for agents · ↓ to manage
  ◯ main
  ⏺ panda-0976 · maya, dev · dev building http: GET /tasks
```

Each `⏺` line is a synthesized reply. Each `❯` line is the person's own words, drawn by Claude Code. A DM shows its words once, as typed, so the confirmation line names the lane rather than echoing them (Phase 3's question: no extra echo). The bullet and dimming of `⏺` lines can be restyled with `ui.render AssistantMessage`, which wasn't tried.

## Can `@room` be retired?

**Not yet.** Keep `@room` and add the room row as a second way in. The things that block retiring it:

1. **Terminal only.** In the desktop app, in VS Code and over Remote Control, `send_task_message` is unsupported, so `@room` is the only typed path there.
2. **Several early-access surfaces stack up**:
   - answering `turn.step` without `next` for a subagent;
   - reading words from an engine-appended `session.append` row (that it can't be refused matters too);
   - the keeper trick for suppressing task notifications.
   
   Any one of them changing breaks the row. Each needs a contract entry and a canary check, and a fallback to `@room`.
3. **Provenance.** Synthesized steps are stored as `origin: model`, so the transcript credits the model with words it didn't write. This needs a ruling (directory review), and maybe a request for a plugin-origin step.
4. **Lifecycle not yet proven:**
   - Esc or `x` (stop) inside the panel, keeper death (which then wakes main), `--resume`, `/clear`, and compaction were all untested.
   - How long a `completed` agent stays listed is unproven beyond the 10-minute check.
5. **Cost.** There is one summarizer call per running-agent transcript change (about 1 per spawn with the keeper design). It's small, but not zero.
6. **Reach.** `@room` posts from main without leaving the conversation. The row needs ↓ Enter ↑ to get in and back. Some people will want both.

Once 2 and 4 are covered by contract entries and a two-person live run (Phase 5), `@room` can be demoted: it becomes a hint in the row ("type here") and stays wired only as the fallback for non-terminal surfaces and for when the contract check fails.
