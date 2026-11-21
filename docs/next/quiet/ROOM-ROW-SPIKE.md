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

---

## 0.8.0 spikes (Phase 0: 1, 2, 6)

Claude Code 2.1.296, 2026-11-21. These are PLAN-080's spikes 1 (lifecycle), 2 (auto mode) and 6 (the idle row's label).

**Verdict: the idle room with a keeper child holds up, with five changes to PLAN-080.**

1. **The row types must stay offered.** Claude Code resumes an idle room only if its type is offered. 0.6.0's `agent.offer {isOffered: false}` on `sub-human:room` makes every typed line fail with `Failed to resume agent: Agent type 'rr:room' is not offered in this session`. Hiding the keeper type makes the room's Agent call fail too.
2. **Answer the row's steps by agent id, not by type.** After `/clear`, the first resume re-lists the room as `general-purpose (resumed)`. A `turn.step` hook that matches on type then misses it, and the model answers.
3. **Auto mode on the Anthropic API refuses every synthesized tool call.** That covers the keeper's `Agent` call and its `hold`. The keeper's spawn has to go through the room's own model once (one model call per keeper spawn). Its `hold` needs a permission rule or a model step too. Respawns must be rate-limited: a keeper that died at once looped about 200 requests in 25 s.
4. **The label can't be updated live without `subagentStatusLine`.** A spawn-time `name` and `description` give `◯ panda-0976 (+1)  maya, dev here · 2 new`, fixed for the row's life.
5. **The keeper's nested row can't be hidden.** It shows as `(+1)` on the room's row in main, and as `└ ◯ rr:keeper <summary>` inside the room's view. No hook draws it.

Everything else in PLAN-080's mechanism worked: Esc and `x` recover, a dead keeper comes back quietly, and the row survives compaction. A row lost to a restart can be resumed with its history.

### Evidence

- **The probe** is in `/tmp/probe-row080/`. It is not committed.
- **The plugin** is `plugin/`:
  - a hooks module, `mod/register.ts`, which logs to `log/mod.log`. Its switches are files under `mode/`, and the ids it knows are in `state/ids.json`.
  - classic hooks, which log to `log/classic.log`.
  - a stub MCP server, `mcp.mjs`, whose `hold` blocks until `mode/release` exists. Its progress text is `mode/progress`, and it logs to `log/mcp.log`.
  - the agents `rr:room` and `rr:keeper`.
  - no `subagentStatusLine`.
- **The mock API** is `mock.mjs` on `127.0.0.1:8767`. It logs one line per request to `log/mock.log` and dumps each body to `log/req-N.json`.
  - It answers summarizer, compaction, title and classifier requests (`<severity>0`).
  - It returns tool calls on cue, with a `safeguard_results` verdict in `message_delta`. That verdict is the server classifier's, as the binary parses it.
  - `FIRSTPARTY=1` launches with `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`, so Claude Code treats the mock as api.anthropic.com (server-classifier "arbiter" mode). Without it the mock counts as a third-party gateway ("arbiterWithLocalFallback").
- **Launch:** `run.sh` (`env -i`, `CLAUDE_CONFIG_DIR=/tmp/probe-row080/cfg`, `HOME=/tmp/probe-row080/home`, `--debug-file log/debug.log`). `t.sh` drives the tmux sessions `rr080-a` to `rr080-f`, all killed.
- **Pane captures:** `caps/NN-*.txt` (and `.ansi`).
- **Transcripts:** `cfg/projects/-private-tmp-probe-row080-work/`.
- **Binary strings:** `strings.txt`.
- **A gap in `mod.log`:** it starts at 16:27:50. A module reload overwrote the first run's lines (Esc, `x`, the keeper's death, `/compact`). Those events are in `log/debug.log`, the transcripts and the captures. Quoted log lines below are from the live run.
- **Permission settings:** `cfg/settings.json` allows `mcp__plugin_rr_stub__hold`, as a person who picked "don't ask again" would have. Without that rule, default mode asks once on main, `Tool use · from the rr plugin … Do you want to proceed?` (`02-spawn`), even with `readOnlyHint: true`.

### Spike 1: lifecycle

| Question | Result | Evidence |
|---|---|---|
| **Esc in the room's view, room idle** | **Stops the room and its keeper.** The keeper's `hold` is interrupted (`turn.complete … reason=aborted`). The room becomes `killed` ("Agent "the room" was stopped by user"), and **main gets a task notification and wakes** (`<status>killed</status>`, a model turn). The row stays listed as `◯ rr:room (+N)` with its dead keepers. | `10-esc-idle`, `13-main-after-esc`; transcript `b974401e….jsonl` |
| **`x` on the room's row in main's panel** | **The same as Esc.** Room and keeper are killed and main wakes. A second `x` ("x to clear") removes the row, after which `$.session.send` is refused: `was stopped by the user and won't be resumed`. The dead keeper is then left as a top-level `◯ rr:keeper` for some seconds. | `16-after-x`, `17-after-x-clear`, `18-send-after-clear` |
| **`x` on the keeper's nested row, inside the room's view** | **Only the keeper stops.** The room gets the keeper's notification as a turn of its own (door `prompt`, origin `task-notification`). Its synthesized step respawns the keeper, with no model call, and main doesn't wake. The dead keeper's row stays (`├ ◯ rr:keeper` / `└ ◯ rr:keeper`) until it is evicted. | `21-x-keeper` |
| **Bringing a killed room back** | `$.session.send` to it is refused: `was stopped by the user and was not resumed`. **Typing into it works:** the turn resumes it, the step respawns the keeper, and there is no model call. A killed or notified row is evicted after `PI=30000` ms (binary `var ykt=3000,PI=30000`). After that only a fresh spawn brings it back, which is 0.6.0's "comes back at your next prompt". | `14-type-after-esc`, `22-send-after-esc`; debug.log 16:26:22 |
| **The keeper dies (its `hold` returns)** | **Main doesn't wake.** The keeper's end reaches the room as a `task-notification` turn, and the room's synthesized step respawns the keeper (`Agent(rr:keeper)`) with no model call. If the step doesn't respawn it, the room stops with no child and main wakes ("Agent "the room" finished", a model turn). | debug.log 16:25:39; `32-room-ended` |
| **A finished room with no child** | **Not drawn in the panel at all.** `$.agent.list()` still lists it as `completed`, and it can still be resumed by `$.session.send`. | `32-room-ended` (footer only `/tasks to see subagents`) |
| **`/compact`** (the mock answered the compaction) | **The row survives**, still holding. Main gains two lines, `Task "the room" completed in background` and `Task "keeper" still running in background` (the compaction's task-status attachment). | `23-compact` |
| **`/clear`** | **The row survives and keeps holding**, on the same MCP server. But the first resume after it (a typed line) reads `[resumeAgentBackground …] disk transcript missing; using 38 in-memory messages`: the new session's directory has no meta for the room. The room is then listed as **`general-purpose`, description `(resumed)`, composer `Message @general-purpose…`**. A `turn.step` hook matching `rr:room` misses it, and **the model answered** (`⏺ ok.`, one mock call). Keyed by the stored id, the step is synthesized again (`26-…-byid`), but the label stays `general-purpose (resumed)`. | `24-clear`, `25-room-after-clear`, `26-room-after-clear-byid`; debug.log 16:27:14 |
| **`--continue` / `--resume`** | **Rows don't survive a restart.** On exit Claude Code asks `The following will stop when you exit: subagent · keeper` (`27-exit-dialog`). After `--continue` the panel is empty, and `$.agent.spawn` starts a new row (`29-continue-ensure`). After `--resume` of the same session id, **`$.session.send({agentId: oldRoomId})` resumes the old room from disk**, keeping its type, its description and the history in its view. Its step respawns the keeper with no model call, and the row is back as `rr:room (+1)  the room` (`31-resume-sendto`). | `28`–`31`; debug.log 16:29:37 |

What this means for Phase 1:
- Persist the room's agent id per session. On resume, send to that id first, and spawn only if the send is refused.
- After `/clear`, end the old row and spawn a new one, rather than resuming it as `general-purpose (resumed)`. To end it: the old keeper's `hold` returns STOP, the room's step lets the keeper go, and the module drops the room's "finished" notification. Its pieces were each seen working; the whole sequence was not run.
- Drop the room's `killed`/`finished` task notifications. They arrive as `prompt.submit` with origin `task-notification` (0.6.0's `rows.ts` already does this). `session.receive` never fired for them.
- Rate-limit keeper respawns, as 0.6.0's spawn ledger does.

### Spike 2: auto mode

The binary picks a classifier per call:
- **A plugin's main-loop call** (`$.agent.spawn`, `$.tool.call`) skips the classifier: `Skipping auto mode classifier for Agent: called by plugin rr`. That holds only when the call has no `agentId` (`Pvr`: `e.agentId===void 0 ? e.hookCaller : void 0`), and `nMe()` is false. `nMe()` is true when the user, flag or managed settings have `autoMode.soft_deny` or `hard_deny` rules.
- **Any other call**, a subagent's synthesized tool call included, goes to the server classifier. Its verdict rides on the model response (`message_delta.delta.safeguard_results`, `dangerous_tool_use` per `tool_use` id). A step a hook made has no request behind it, so the verdict is `server_not_requested`.

| Question | Anthropic API (`FIRSTPARTY=1`, arbiter) | Third-party base URL (arbiter with local fallback) | Evidence |
|---|---|---|---|
| Module `$.agent.spawn(rr:room)`, no `autoMode` rules | **Allowed**: `Skipping auto mode classifier for Agent: called by plugin rr`. This was so at `prompt.submit` and at `turn.start` alike. | allowed | debug.log 16:36:53, 16:38:26 |
| The same spawn with `autoMode: {soft_deny: ["$defaults"]}` in settings | **Denied**, exactly as 0.6.0 saw it: `…gave no verdict for Agent: the request that produced this action did not ask for one…`, `Agent answered in 21ms, 406 chars, denied`. So the 0.6.0 deny depends on the person's `autoMode` rules (or a policy's). It is not a property of auto mode itself. | not run | debug.log 16:38:51 |
| **The keeper's `Agent` call from the room's synthesized `turn.step`** | **Always denied** (`server_not_requested`), rules or none. In auto mode the room that has no keeper then ends, and `[handback-send-enforce] … Call SubagentHandback` makes it run 3 more synthesized steps, so the step's text goes into its transcript 4 times. | **Allowed after one local classifier call** (`claude-sonnet-5`, stage `xml_s1`, `classifierChars=139966`, `<severity>N</severity>`). | mod.log 16:36:53, 16:42:36 |
| The keeper's synthesized `hold` call | **Allowed with an allow rule** for the tool. **Denied without one**: `gave no verdict for mcp__plugin_rr_stub__hold`, with `readOnlyHint: true` making no difference. | not run without the rule | mod.log 16:40:12, 16:42:06 |
| A keeper that the module spawns from inside the room's step | It starts, but its parent is **main** (`parentId` absent), so the room still has no child. Its steps also skip the module's `turn.step` hook and go to the model (4 model calls). | not run | mod.log 16:43:41 |
| **Fallback: main's model makes `Agent(rr:room)`** (0.6.0's way) | **Allowed** by the server verdict. | not run | mod.log 16:39:30 |
| **Fallback: the room's first step goes to its model** (`next(e)`), which calls `Agent(rr:keeper)` | **Allowed.** That is one request in the room's own small context (`nmsgs=2, ntools=4`). The keeper's `hold`, synthesized, is then allowed by the rule. After that, typed lines cost **0** calls (`57-auto-room-typed`), and no handback review runs while the keeper lives. | not run | mod.log 16:39:54, 16:42:06, 16:44:07 |
| **Cost** | Each keeper death in auto mode costs one handback-review classifier call: `Subagent has finished and is handing back control to the main agent. Review the subagent's work…`. A keeper whose `hold` is denied dies at once, so the room respawns it (1 model call + 1 review) in a loop: **about 200 mock requests in about 25 s**, stopped by hand (mock n=8 to 215, after a mock restart). | same | `log/mock.log` 16:40:12–16:40:39 |

The fallback for Phase 1, in auto mode on the Anthropic API:
1. The module's own `$.agent.spawn` of the room, or main's Agent call when the person has `autoMode` rules (0.6.0's `rowAsk`).
2. The room's first step passes to its model for the `Agent(sub-human:keeper)` call (one call per keeper spawn).
3. The keeper's `hold`: either the person's allow rule, or a model step as well (a second call per keeper spawn).
4. A hard cap on respawns.

The cap matters most in auto mode, where a keeper that dies at once costs a model call and a classifier call every time.

Caveats:
- These verdicts come from a mock that adds `safeguard_results` itself; the real server's verdicts weren't seen.
- Feature flags were left at their defaults (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, so no flag fetch).

### Spike 6: the idle row's label and the nested keeper

With no `subagentStatusLine`, main's panel draws the row as `◯ <type or name> (+1)  <description>`. Inside the room's view, the panel expands to show `└ ◯ rr:keeper <keeper's label>`.

| Try | Result | Evidence |
|---|---|---|
| (1) The keeper's `hold` progress as the room's label | **No.** Progress notifications (`maya, dev here #6`) are drawn only in the keeper's own view, as `⎿ maya, dev here #6` under the call. Neither the room's row nor the keeper's row shows them. 0.6.0's line came from the room's own running `hold`, and an idle room runs nothing. | `34`–`37` |
| (2) Updating the description from the module | **No API.** `$.agent` has only `spawn`, `list` and `register`, and `AgentInfo.description` is "as an `agent.spawn` hook left it". **At spawn** it works, and so does `name`: `$.agent.spawn({name: "panda-0976", description: "maya, dev here · 2 new"})` draws `◯ panda-0976 (+1)  maya, dev here · 2 new`, frames the composer as `@panda-0976`, and gives the placeholder `Message @panda-0976…` in place of `Message @rr:room…`. It stays fixed for the row's life. Changing it means a new row: a respawn, which loses the view's history, and the old row lingers until evicted. | `58-spawn-named`, `59-named-view` |
| (3) A synthesized step's text, then the summarizer | **No.** The summarizer forks only while an agent runs (every 30 s, `[AgentSummary] Timer fired`). The room runs about 50 ms a turn (`Stopping summarization for <room>`), so its label stays its description. The keeper runs, so it gets **one summarizer call about 30 s after each spawn**. That call bypasses `turn.step` (none logged) and its words become the keeper's nested label (`└ ◯ rr:keeper ok.` = the mock's reply). | debug.log `Summary result for … ok.` (×7) |
| Hiding the keeper's nested row | **No surface.** `RenderComponent` has no panel row. Main shows `◯ rr:room (+1)`, and the room's view shows the keeper's row expanded. | `07-room-view`, `37-main-collapsed` |
| A keeper that isn't an agent: a background `Bash` (`sleep 86400`, `run_in_background`) from the room's step | **It removes the nesting and the summarizer call.** The row reads `◯ rr:room  the room`, and default mode allows `sleep` with no prompt. **But main is told of every room stop**: `This agent stopped with background work of its own still running…`. Only agent children are `parked on keepalive`. Each told stop can be dropped, but the drop leaves a blank `⏺` row in main per room turn, and the footer gains `· N shells` and `N shells still running`. **Not recommended.** | `40`–`43`; transcript note |

For Phase 1, the label "who's here · N new" can't be live. The choices are:
1. A fixed `name` (the room code) and `description` at spawn: `◯ panda-0976 (+1)  type here`.
2. The live text drawn inside the row's view as synthesized lines.
3. The live line in the opt-in `subagentStatusLine` from the README, which stays the only live label.
4. The unread count elsewhere, such as `$.ui.status` under main's prompt.

The rule "one room row, nothing nested" can be met in main only as `(+1)`; inside the row's view the keeper is drawn. That needs an owner call: accept `(+1)` and the nested keeper, or ask Claude Code for a way to hide a child row or set a row's label.

### Changes to PLAN-080's phases

- **Phase 1:**
  - `sub-human:room` and `sub-human:keeper` stay offered: `mod/rows.ts`'s `isOffered: false` breaks the room's resume, and hiding the keeper breaks its spawn. Keep the model from spawning them another way, for example a fixed `tool.call` deny of a main-loop `Agent(sub-human:room|keeper)` outside the auto fallback. An offer window that opens only while the room's own Agent call dispatches works for the keeper, but not for the room's resume: the resume's `agent.offer` carries nothing that tells it apart.
  - Every row step is keyed by the stored id.
  - The spawn uses `name` (the code) and a fixed `description`.
  - Respawns are capped.
- **Spike 6 replaces Phase 1's label line:** no live label without the opt-in status line.
- **The 0.8.0 contract entries** (search strings checked in `strings.txt`):
  - `parked on keepalive`
  - `is not offered in this session` (resume refused for a hidden type)
  - `disk transcript missing; using` (`/clear` re-lists the agent as `(resumed)`)
  - `was stopped by the user and was not resumed`
  - `called by plugin` (the plugin skip, and its `nMe` rule condition)
  - `This agent stopped with background work of its own still running`
  - `Subagent has finished and is handing back control to the main agent` (the auto-mode handback review)
  - `handback-send-enforce`
- **Refine `auto-mode-module-spawn-deny`:** the deny depends on the person's `autoMode` deny rules, and a synthesized subagent call is always denied on the Anthropic API.

### Not tested

- Real models and the real server classifier. Its verdicts were mocked from the binary's parser.
- Feature flags beyond their defaults.
- The `/clear` recipe end to end (old row ended and a new one spawned), and the old room's eviction after it.
- `ctrl+x ctrl+k` (stop all agents).
- Esc while the room is in the middle of its ~50 ms turn.
- Auto mode with a third-party base URL plus `autoMode` rules.
- Plan mode, wakes mid-task and provenance (spikes 3–5).
- The desktop app and VS Code.
- The real plugin.

---

## 0.8.0 spikes (Phase 0: 3, 4, 5)

Claude Code 2.1.296, 2026-11-21. These are PLAN-080's spikes 3 (plan mode inside a row), 4 (a wake reaching a busy main) and 5 (provenance of synthesized row lines).

**Verdict:**
1. **Plan mode can't run inside a row.** `EnterPlanMode`, `ExitPlanMode` and `AskUserQuestion` are refused to every subagent, whatever its `tools:` list says. No dialog is drawn anywhere, no tool hook fires, and the mode doesn't change. Phase 4's default stands: the row hands the drafting to main.
2. **A wake never interrupts, but the real plugin's path for a busy main delivers it mid-turn, not at the turn boundary.**
   - `$.session.append`, 0.6.0's mid-turn path, is read by the running turn at its next tool boundary, silently.
   - `$.prompt.submit` waits in the queue and runs as a turn of its own once the current turn ends. It shows one queued line in main at once.
   - A naming wake that asks for an answer should use the submit.
3. **Synthesized lines can be restyled and scoped to the room, and the transcript does mark them, though not on screen.**
   - The JSONL row has `answeredWithoutRequest: true`, `isUnmetered: true` and a `msg_hook_…` id, but still the session's model name.
   - `ui.render AssistantMessage`, keyed by the row's uuid, can draw `maya: …` without the `⏺` bullet in the room's view only.
   - ctrl+o still heads each line with the model's name.
   - **New problem:** after `--resume`, the person's own typed lines are gone from the row's view.

### Evidence

- **The probe** is `/tmp/probe-row080b/`, a copy of `/tmp/probe-row080/` with its paths changed. It is not committed.
  - The mock is on `127.0.0.1:8768`.
  - The tmux sessions were `rr080b-a` (spikes 3 and 5), `rr080b-b` (resume) and `rr080b-c` (spike 4), all killed, and the mock is stopped.
  - The binary strings are in `strings.txt`, the same 2.1.296 dump.
- **Changes from the 0.8.0 probe:**
  - `mod/register.ts`:
    - `TOOL <name> <json>` typed into the row makes the room's next synthesized step that tool call.
    - `SPAWNPLAN` spawns `rr:planroom`, the room with `permissionMode: plan`.
    - `SLOWTURN <kind> <ms>` passes on to the mock and schedules a wake in `<ms>`.
    - `WAKEIDLE <kind> <ms>` drops the prompt and then wakes the idle main.
    - Each kind is the real plugin's call: `submit` is `$.prompt.submit({text, asUser: true})` (`mod/deliver.ts` submitWake) and `append` is `$.session.append` of a user row (`appendRow`, used by midTurnWake).
    - It logs classic `PreToolUse`/`PostToolUse` and `ui.render AssistantMessage`, and `mode/restyle` (`props`, `tree`, `treenext`) rewrites the room's lines.
  - `hooks.json` adds shell `PreToolUse`, `PostToolUse`, `PostToolUseFailure` and `PermissionRequest` loggers (`log/classic.log`).
  - `mock.mjs`:
    - A prompt holding `SLOWTURN` gets a slow turn: 4 × `Bash(sleep 3)`, each reply delayed 1.5 s, then `slow done`. That is about 20 s.
    - Each request's log line lists which messages carry `WAKEMARK` and in which block (`wake`).
  - `cfg/settings.json` allows `Bash(sleep:*)` beside `hold`.
  - Launched with `--permission-mode default` (this config otherwise opens in auto).
- **Pane captures** are in `caps/NN-*.txt` (and `.ansi`). The logs are `log/mod.log`, `log/classic.log`, `log/mock.log` and `log/debug.log`. Transcripts are in `cfg/projects/-private-tmp-probe-row080b-work/`.

### Spike 3: plan mode inside a row

| Question | Result | Evidence |
|---|---|---|
| **(a) Allowed for a subagent?** | **No.** A synthesized `EnterPlanMode` call from the room's step gets the tool result `Error: No such tool available: EnterPlanMode. EnterPlanMode is not available inside subagents. Complete the task with the tools provided and return findings to the orchestrator.` `ExitPlanMode` (with a `plan`) and `AskUserQuestion` get the same error. The room's `tools:` listed all three. The binary builds a set that every subagent is denied: `function D(e){return new Set([mu,xk,…,Qo,…])}var Rot=D("external")`, where `mu`/`vw` = `"ExitPlanMode"`, `xk` = `"EnterPlanMode"` and `Qo` = `"AskUserQuestion"`. A second guard sits behind it: `EnterPlanMode`'s own `validateInput` refuses any `agentId` (`Only the main session can enter plan mode.`). | `03-enterplan`, `04-exitplan`; transcript `agent-a0854efba9163f60e.jsonl` |
| …with the session already in plan mode | **The same error.** The set is applied when the tool is looked up, before any mode check. | `05-exitplan-mainplan` |
| …with `permissionMode: plan` in the agent's frontmatter | **Ignored:** `Plugin agent file …/planroom.md sets permissionMode, which is ignored for plugin agents. Use .claude/agents/ for this level of control.` The spawn carried `permissionMode: "default"`. Plugin agents also have their `hooks` and `mcpServers` ignored (`K5t=["permissionMode","hooks","mcpServers"]`). | debug.log 17:07:55; mod.log 17:12:52 |
| **(b) Does the plan dialog draw?** | **Nowhere.** No plan view, no `Exit plan mode?` and no question card appear, either in the row's view or in main. The row shows the call's error under the step, and the step goes on. | `03`–`05`, `06-main-after-planmode` |
| **(c) Do hooks fire?** | **None.** No module `tool.call`, no module `classic.PreToolUse`, and no shell `PreToolUse`, `PostToolUse`, `PostToolUseFailure` or `PermissionRequest`. The only rows are `session.append` door `tool-result` with the error text. Consent would see nothing. For comparison, the keeper's `Agent` and `hold` calls did fire both, and the shell `PreToolUse` carried `agent_id` and `agent_type`. **The module's `classic.PreToolUse` payload has no `agent_id`**: its keys were `room`, `tool` and `tool_use_id`, which is why `mod/consent.ts` stashes `tool.call`'s `agentId` by `tool_use_id`. | `log/classic.log` (0 lines for the three tools); mod.log 17:08:12–17:12:17 |
| **(d) Does the mode change?** | **No.** Main's footer stayed `manual mode on`. But **shift+tab inside the row's view cycles the session's own mode**: main's footer then read `plan mode on`. A row has no mode of its own. | `05`, `06-main-after-planmode` |

So plan mode can't run in a row in any form. Phase 4's default, handing the drafting to main, is the only way. The row can't ask a question either (`AskUserQuestion` is refused there too): any card a row-started action needs must come from main (`$.ui.ask`, or main's own Claude).

### Spike 4: a wake reaching a busy main

These are the real plugin's two calls (`mod/deliver.ts`). The tail's `route` sends a `wake` to `submitWake` when main is idle, and to `midTurnWake` (an append) while a main-loop turn runs.

| Call | Main busy: a 20 s turn of 4 tool calls, wake sent at +2.5 s | Main idle | Evidence |
|---|---|---|---|
| **`$.prompt.submit({text, asUser: true})`** | **Queued until the turn ends. It neither interrupts nor is injected.** It is drawn at once under the running turn, as a dim `› Prompt from the rr plugin` over `❯ WAKEMARK …`, and the spinner keeps going. Requests 6–9 of the running turn don't carry it. It runs as a turn of its own about 0.1 s after the `slow done` reply (request 10, the last message). The submit's promise resolved only then, 18 s after the call. The transcript has an `enqueue` at the call and a `dequeue` at the start, and the user row carries `queuePriority: "later"`, `promptSource: "system"` and origin `{kind: "plugin", name, asUser: true}`. | **A turn at once** (about 20 ms from enqueue to dequeue), drawn as the same two lines. | `30`–`32`, `35`; mock n=5–10, 16 |
| **`$.session.append` of a user row** (stored `isMeta: true`, origin `{kind: "plugin"}`) | **Injected into the running turn at its next tool boundary.** No interrupt and no new turn. The next request carries it as an extra text block in the tool-result user message (request 12, message 20: `tool_result,text*`). **Main draws nothing**, in the transcript or in ctrl+o. If it is appended after the turn's last request went out (wake at +19.2 s, during the final 1.5 s reply), **no request reads it**: the turn ends and nothing starts, so the row waits for whatever request comes next. 0.6.0's `WAKE_RESEND` covers exactly this case. | **Stored. No turn starts and nothing is drawn.** It rides on the next request: the person's next prompt carried it as an extra block (request 17, message 34). | `33`, `34`, `36`, `37`, `38-main-ctrlo`; mock n=11–22 |

Answers:
- **(a)** Neither call interrupts. The submit is delivered at the next turn boundary, as a turn of its own (queue priority `later`). The append is read inside the running turn at its next tool boundary. It is not a `queued_command` attachment, which is how a person's mid-turn typing arrives: it is merged into the tool-result message.
- **(b)** With the submit, the person sees the queued `› Prompt from the <plugin> plugin` and `❯ <text>` lines under the running turn at once, and later the turn they start. With the append, they see nothing.
- **(c)** Idle: the submit starts a turn at once. The append starts none and waits for the next request.

**For PLAN-080 Phase 2:** 0.6.0's route means a named Claude that is busy reads "maya, …" in the middle of its task, as an extra block after a tool result, and may answer (post) or change course mid-task. To get spike 4's intended "delivered at its next turn boundary", an assistant wake (a line naming the person) should go by `$.prompt.submit` even while a turn runs. It then gets its own turn after the current one, and its queued line is the "one quiet line" of owner decision 1. The mid-turn append stays for context-only lines. While it is queued, the line shows its text in main at once, so the shown part (`wakeParts`) has to be what the person may see.

### Spike 5: provenance of synthesized row lines

| Question | Result | Evidence |
|---|---|---|
| **(a) What the transcript records** | The room's JSONL keeps every synthesized step as `type: "assistant"` with:<br>• `message.model: "claude-opus-5-5"` (the session's model);<br>• `message.id: "msg_hook_<uuid>"` (a model reply's is `msg_…` from the API);<br>• usage all zeros and no `requestId`;<br>• **`answeredWithoutRequest: true`** and **`isUnmetered: true`**;<br>• no `isMeta`.<br>Binary: `if(y&&T.type==="assistant")T.answeredWithoutRequest=!0` when a step made no request (`n.requests===0`), and `msg_hook_${randomUUID()}` for the hook's `message_start`. `session.append` still reports `origin: {kind: "model", model: "claude-opus-5-5"}`. So the record *does* carry a marker, in two fields a reader can key on. Only the model name and the append origin credit the model. | `agent-a0854efba9163f60e.jsonl` (all 10 assistant rows) |
| **(b) `ui.render AssistantMessage` in the row's view** | **It works, and can be scoped to the room.**<br>• It fires for each of the room's lines with `requestId` equal to the row's uuid: the same uuid as `session.append`'s `e.uuid` and the transcript's `uuid` (`c30cd975…` in all three). The module keeps the uuids of `session.append` rows whose `agentId` is the room's (door `response`), and answers only those. Main's own `⏺ ok.` was drawn untouched (`ours=false`).<br>• Three rewrites, all drawn:<br>  - `props.text` rewritten: `⏺ maya: ✓ …`. The bullet stays.<br>  - a tree of its own (`Box` › `Text` bold cyan `maya: ` + `Text` text): `maya: ✓ …` with **no bullet**.<br>  - a tree wrapping `next(e)`: a dim `maya (via room)` line above the engine's own `⏺ ✓ …`.<br>• The rewrite applies in ctrl+o as well. Only rows drawn (or redrawn) after the switch change; rows already in the scrollback keep their old drawing. | `10-restyle-props`, `11-restyle-tree`, `12-restyle-treenext`, `14-main-scoped`; mod.log `ui.render AssistantMessage … ours=` |
| **(c) Marked as non-model on screen?** | **No.**<br>• **ctrl+o** heads every line, synthesized or not, with `09:13 AM claude-opus-5-5`. That header isn't part of `AssistantMessage`'s props, so no hook reaches it.<br>• **`claude --resume`**: main's transcript holds no room line at all. The row, brought back by sending to its stored id, redraws its synthesized lines as plain `⏺ …`, with nothing to set them apart.<br>• **New:** after the resume, **the person's own typed lines are gone from the row's view and from its ctrl+o**. Those are the composer rows, `isMeta` with the "while you were working" wrapper. The spawn prompt is gone too. Live, before the restart, they were drawn as `❯ hello from the person`. A resumed row shows only the plugin's half of the chat. | `13-room-ctrlo`, `20-room-after-resume`, `21-resumed-ctrlo` |

What this means for Phase 1:
- Draw room lines with a tree rewrite: no bullet, author prefix.
  - Scope it by the row uuids `session.append` reports for the room's agent id.
  - Persist those uuids with the room's id, or on resume read the room's JSONL for rows with `answeredWithoutRequest` (they are the plugin's own), so a resumed view is re-scoped.
- The "no echo" rule loses the person's words after a resume. Either the step's confirmation carries them (`you: the deploy is green`, drawn by the plugin and therefore kept), or the loss is accepted.
- Owner decision 2 stands, but the README can say more: the transcript records each line as "answered without a model request" (`answeredWithoutRequest`). Only the model name and the ctrl+o header still credit the model.

### Changes to PLAN-080

- **Phase 0, item 3:** closed, and the answer is no. In Phase 4, drop "If spike 3 shows plan mode works inside the row, the check could open there instead". The row can't ask questions either, so any card it needs comes from main.
- **Phase 2:** a line naming a person wakes their Claude by `$.prompt.submit`, even mid-turn. It is queued and runs as its own turn after the current one, with its queued line the one quiet line in main. 0.6.0's mid-turn append is kept for context-only lines. The route needs a wake kind of its own for this, since today `route` turns every wake into `mid-turn-wake` while a turn runs.
- **Phase 1:**
  - The tree rewrite of `AssistantMessage`, scoped by uuid, with the uuids persisted.
  - Decide whether the confirmation step repeats the person's words, since they don't survive a resume.
- **Owner decision 2 / README:** mention `answeredWithoutRequest` as the transcript's marker.
- **Contract entries** (`feature: room-chat`; each search string found in `strings.txt`):
  - `is not available inside subagents`: EnterPlanMode, ExitPlanMode and AskUserQuestion are refused to every subagent, before any hook.
  - `Only the main session can enter plan mode.`: EnterPlanMode's own guard.
  - `which is ignored for plugin agents`: a plugin agent's `permissionMode`, `hooks` and `mcpServers` are ignored.
  - `answeredWithoutRequest`: a step answered with no request is marked so in the transcript. `msg_hook_` is its message id prefix.
  - `Prompt from the `: a plugin's queued prompt is drawn under the running turn.
  - `queuePriority="later"`: a plugin's `$.prompt.submit` waits for the turn's end (1 hit). The live run showed this; the string only shows that the field exists.
  - `ui.render AssistantMessage` `requestId` is the row's uuid: from the typings ("the message id for a message") and seen live. No binary string is needed; the `test:mods` wiring test can cover it.

### Not tested

- Real models.
- A user or project agent in `.claude/agents/` (whose `permissionMode` is honoured). The tools are refused by the same set regardless, but this wasn't run.
- The teammate path (`Oc()`), where a teammate's `ExitPlanMode` is sent to its team lead's inbox for approval. This is swarm mode, not a background subagent.
- A wake while main waits on a permission dialog or the plan view, or while the person is inside the row's view.
- Esc while a plugin prompt is queued (whether it is kept, dropped, or put back in the box).
- Two queued wakes in one turn: their order, and whether they merge.
- The restyle after a resume, re-scoped from the JSONL. The `requestId` matching the disk uuid was seen, but the re-scoping was not run.
- The desktop app, VS Code and the real plugin.
