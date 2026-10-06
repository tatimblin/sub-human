# E3 · Other ways to build participant rows

Claude Code 2.1.281. All probes ran in `/tmp/exp-3` (tmux `e3a`, Haiku, `SUB_HUMAN_HOME=/tmp/exp-3/home`, a
fabricated room `otter-1234` written through `lib/room.js append`). Everything is killed. No plan files were
created. Haiku spend for the probes was roughly 12 main and subagent turns at 25–40k mostly-cached tokens, about
$0.30 in total.

## 1. Setup (diff summary, `/tmp/exp-3/plugin`)

- `bin/sub-human watch [CODE] --member NAME`: a new filter on the existing colored feed. It keeps entries
  `from == NAME || to == NAME`.
- `settings.json`: `subagentStatusLine` → `/tmp/exp-3/sl.sh`. The script logs stdin. A second version derives
  `alice ✓ signed · #22 …` from the log using the row's `description`.
- `monitors/monitors.json`: variants with one monitor per member (stdout), one member monitor (stderr only
  `1>&2`), and one whole-room monitor (stderr only).
- `mcp/rows-server.js` (new, about 70 lines), with two tools:
  - `follow`: `execution.taskSupport: "required"`, tasks capability, `tasks/get` returns a log-derived
    `statusMessage`. It probes the `mcp_task` row type.
  - `hold`: a normal tool that never returns while the member is present. Each new entry for the member is
    sent as `notifications/progress {message}`.
- `agents/participant.md`: Haiku, `background: true`, `tools: mcp__plugin_sub-human_rows__hold`. It calls
  `hold` once.
- `/tmp/exp-3/post.js`: appends test entries.

## 2. Where rows live (applies to every option)

There are two different surfaces behind `↓`:

1. **The agent panel**, inline under the prompt: `main` plus agent-type tasks only.
2. **"Enter to view tasks"**: a footer item that opens the **Background** dialog, where shells and monitors are
   listed.

*verified-by-probe*, with an agent, a shell and a monitor all running:

```
  ⏸ manual mode on · 1 shell, 1 monitor · Enter to view tasks
  ⏺ main
  ◯ SL[local_agent] name=None desc=orch
```

```
  Background
  2 active shells · 1 active agent
    Shells (2)
  ❯ /tmp/exp-3/plugin/bin/sub-human watch otter-1234 --member bob (running)
    alice · stderr only (running)
    Local agents (1)
    orch (running) · Haiku 4.5
```

- `subagentStatusLine` stdin `tasks[]` contained only the `local_agent` row. It was never invoked while only
  shells and monitors existed (`sl-in.jsonl` absent). *verified-by-probe*
- Row labels (*verified-by-source*):
  - `case"local_bash":…label:h.kind==="monitor"?h.description:h.command` (a shell shows its **command**, not
    the Bash `description`);
  - `local_agent` → `description`;
  - `monitor_mcp` and `mcp_task` → `description`.
- The shell and monitor detail view is a fixed box: `height:12`, tail only, no scrolling. The text reads
  `Showing ${n} lines` and `← to go back · Esc/Enter/Space to close · x to stop`. *verified-by-source* and
  *verified-by-probe*: after 15 entries it showed only the last 3 entries, as "Showing 6 lines of 3.2KB".
  PgUp, Up and k did nothing.

## 3. Results

| Option | Row? | Name / status text | Enter shows thread? | Back to main | Cost | `/clear` · `--continue` | Spawn |
|---|---|---|---|---|---|---|---|
| **A. `run_in_background` Bash** (`sub-human watch CODE --member bob`) | **Pass, but only in the Background dialog**, not the agent panel | Name = the literal command (`sub-human watch otter-1234 --member orch (running)`); the Bash `description` is ignored. The status is a fixed `(running)`; `subagentStatusLine` does not apply. | Partial: a live tail with ANSI colors kept, but only the last ~6–10 lines, no scroll | `←` back to the list, Esc closes. No `main` row in that dialog. | 1 main turn to spawn (~39k cached in, 69 out), then **0 turns per entry** (0 task-notifications in the transcript after 3 entries). One notification when it exits. | **Survives `/clear`** (an entry posted after `/clear` appeared live). **Dies on exit** ("The following will stop when you exit: shell · …"); **not restored by `--continue`**. | **Model only.** Hooks cannot create tasks. The user also gets a permission prompt unless `sub-human watch *` is allowed. The bare `sub-human` resolves on the Bash PATH (plugin `bin/`). |
| **B. Plugin monitors**, one per participant | **Pass, in the Background dialog** | Name = the monitor `description`, **static in `monitors.json`**, so it can't be per-name, only per seat. Status is `(running)`. | Same tail-only box. stderr lines get a `[stderr]` prefix per chunk. | Same as A | **stdout: 1 main turn per batch** (verified: each line arrived as `<task-notification>…Monitor event…`, ~31k cached in per turn). **stderr only (`1>&2`): 0 turns** (0 notifications after 3 entries); the output is still shown in the detail view. | Survives `/clear`. **Restarted by `--continue`** (`always`), and replays the history because `watch` starts at id 0. | **Deterministic**: the plugin declares it, `when: always` or `on-skill-invoke:sub-human:sub-human`. N must be fixed in advance (seat 1…N). |
| **C. One `room` agent row** (today) | Pass, in the agent panel | Name = `description`; status = `subagentStatusLine` (verified in native/03, 08) | **Full** scrollable transcript, one tool result per batch | Select `main`, then Enter | 1 Haiku turn per entry batch (~7–9k tokens, mostly cached; native/03) plus a quiet re-call every 50 min | **`/clear` aborts the in-flight MCP call** (verified with `hold` below: `notifications/cancelled … AbortError`, and the agent shows "Interrupted"). Resumed sessions need a respawn. | Model spawns it (skill or hook context); one per session |
| **A2. Agent row held in one blocking MCP call** (new; `participant` + `hold`) | **Pass, in the agent panel**: one row per participant | Name = `description`; **status = `subagentStatusLine`, log-derived**: `◯ alice  ✓ signed · #22 signed b7ca39` | **Latest entry only.** The view shows `Calling plugin:sub-human:rows · 31s… ⎿ #23 orch → alice say: alice, please confirm the fetcher owner`. Newlines in the progress message collapse and are cut to about 2 lines. ctrl+o's detailed view shows only the call line. | Select `main`, then Enter | **2 turns per participant lifetime**: the main turn to spawn, plus 1 subagent turn (1,530 in / 199 out, no cache). **0 turns per entry** (the transcript has exactly 1 assistant message after 23 progress events). About 1 more turn at leave. | Same as C: `/clear` aborts the call ("Interrupted"); the row persists but goes stale. **Esc inside the row's view also interrupts it.** | Model spawns it, as with C. Can piggy-back on the orchestrator turn that already handles `join`. |
| **E1. `mcp_task`** (server-driven `statusMessage`) | **Fail.** Claude Code sent a plain `tools/call` with no `task` param to a server advertising `tasks.requests.tools.call` and `taskSupport:"required"`. The server's `{task}` result was rejected: "content is required when the body carries 'task'". | n/a. Per source, the label is the description (server · tool) and the status is the polled `statusMessage`. | n/a | n/a | n/a | Restore path exists (`statusMessage:"reconnecting…"`) | Model tool call; the client-side task path was not reachable for a plugin stdio server *verified-by-probe* |
| **E2. Model `Monitor` tool** | Row in the Background dialog with a settable `description` | Name settable; status fixed | Tail box | Same as A | stdout lines wake the model; stderr is free (as B) | **Expires after 30 min max**, which forces a re-arm turn *verified-by-source* (tool schema) | Model only |
| **E3. Others** | `local_workflow` (Workflow tool: runs agents, so costs turns), `remote_agent` (cloud), `in_process_teammate` (teams), `dream`, `auto_mode_scan`: none renders an externally driven row for free *verified-by-source* (`kpr`/label switch) | | | | | | |

Other observations (*verified-by-probe* unless marked):
- When the Background dialog holds a single task, Enter from the footer jumps straight into its details.
- `← 1 agent` in the footer is "Background this session?" (bg sessions), not a row.
- Idle background shells can be reaped under memory pressure ("stopped because the system is running low on
  memory"; opt-out `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1`). *verified-by-source*
- `/clear` SIGKILLed a subagent's foreground Bash (exit 137) and the agent ended. That is the same failure
  class as the aborted `hold`.

## 4. UX notes

- **Shell and monitor rows aren't in the panel the target mockup shows.** They sit one level down, behind
  "Enter to view tasks". They are mixed with any real shells, carry no status text, and their detail box is a
  10-line tail you can't scroll. That is fine for "what did bob just say", useless for "read bob's thread".
- **Shell labels are raw commands.** `sub-human watch otter-1234 --member bob (running)` reads acceptably only
  because the plugin `bin/` is on the Bash PATH. A dedicated `sub-human row bob` subcommand would shorten it
  to `sub-human row bob (running)`.
- **A2 gives exactly the mockup's panel** (`◯ alice  ✓ signed · #22 …`) at near-zero marginal cost. But
  entering the row shows only the *latest* entry, as a progress line under a spinner ("Wrangling… ↓ 1.7k
  tokens"), not a thread.
- **Pressing Esc in a held row's view interrupts that agent.** This is a real hazard: users press Esc to leave
  views. `/clear` in main does the same. Every agent-backed row (C, A2, E1's proxy) needs a respawn path:
  - a SubagentStop or SessionStart hook that asks the orchestrator to re-spawn;
  - or a status line that shows `⚠ row stale — /sub-human:rows`.
- **Monitors print everything twice in effect.** stdout is a model wake, which costs a turn; stderr is a
  free on-screen tail. One process can use both: stdout for "wake me" lines and stderr for the human-readable
  thread.

## 5. Recommendation: ranked (best UX per unit cost)

1. **Adopt: A2 rows plus a free room monitor (option D in its best form).**
   - **Panel row per participant**, in the orchestrator session only:
     - a `sub-human:participant` agent (Haiku, `tools: mcp__plugin_sub-human_room__hold`) that makes one `hold`
       call;
     - plugin `subagentStatusLine` computing the row text from the log and presence;
     - cost: ~2 turns per participant per join, 0 per entry.
   - **Thread view:** keep the existing `room` monitor process. Add the full colored `watch`-style feed on
     **stderr** (free); keep the wake lines on stdout. "Enter to view tasks → sub-human room" shows the live
     tail.
   - **Full history:** `sub-human watch CODE --member NAME` in a terminal, or `/sub-human:read`.
   - **Exact changes:**
     - `room-server.js`: add `hold({member})`. It never returns until `member_left` (then `STOP:`). It sends
       `notifications/progress` with the latest entry as one line, at least every 60 s, to beat the idle timeout.
       Hard timeout is ~27.8 h (research/03).
     - Add `agents/participant.md`.
     - `agent-statusline`: map the row by `description` (or by the PostToolUse(Agent) agentId map, per
       native/03) and print `name state · last`.
     - `tail`: also write `watch`-format lines to stderr.
     - The `bin/sub-human watch` `--member` filter (above).
     - A SubagentStop hook: if the member has not left, `decision:"block"` → call `hold` again. This covers
       interrupts by Esc or `/clear` at the cost of 1 turn each. Confirm it fires on interrupt.
2. **Adapt: C (one `room` agent).** It keeps the only *readable, scrollable* full transcript. Its cost is
   1 Haiku turn per entry batch, so use it only if users actually open the transcript. Better: switch it to
   `hold`-style progress (0 turns per entry, latest-line view) and rely on the monitor or terminal for history.
3. **Adapt: B (stderr-only plugin monitors)** as the zero-turn, fully deterministic fallback:
   - one `sub-human room` monitor, `on-skill-invoke:sub-human:sub-human`;
   - not per participant: names are static, so you'd get "seat 1…N";
   - it survives `/clear` and returns on `--continue`.
4. **Reject: A (per-participant background Bash).**
   - It is model-spawned and gets a permission prompt.
   - Its label is the raw command, and it has no status text.
   - It is not restored on resume, and it sits outside the agent panel.
   - Its only win is surviving `/clear`, and B gives that deterministically.
5. **Reject:**
   - `mcp_task`: the client never sent task-augmented calls to a plugin server;
   - the model `Monitor` tool: 30-minute expiry;
   - workflows and teammates: they cost model turns and add nothing.

**Bottom line:** no mechanism gives an agent-panel row *and* a readable thread with zero model turns. The
cheapest full match is A2:
- 0 turns per entry, about 2 per join;
- status text deterministic through `subagentStatusLine`;
- the thread itself is shown by the free stderr monitor tail.
