# P0 · Nested rows: a room row with members inside

Claude Code 2.1.281, Haiku 4.5. Throwaway plugin `/tmp/p0/plugin` (`p0`):
- `room` agent: `background: true`, `tools: Agent, mcp__plugin_p0_hold__hold`. It spawns one `p0:member` per name and calls `hold` in the same message.
- `member` agent: `background: true`, `tools: hold`.
- `mcp/hold.js`: `hold({who})` never returns and sends a progress heartbeat every 20 s. Run 3 adds this: when a member's call is cancelled, the room's pending call returns `RESPAWN <name>`.
- Hooks log PostToolUse(Agent), SubagentStart and SubagentStop. SubagentStop also tries a `block` re-hold.
- `subagentStatusLine` → `/tmp/p0/sl.sh`. It logs stdin and prints a room label or a member label, chosen from the agent's `meta.json`.

There were three tmux sessions (`p0a`, `p0b`, `p0c`) in `/tmp/p0/work`. They ran for about 12 minutes in total and are all killed now. The spend was about $0.15 of Haiku.

Labels: **[probe]** verified by probe; **[source]** verified by source (`strings` of the binary).

## Answer: **true nesting is possible, with caveats**

The member's panel shows a single row, `marmot-2509`. Enter on it shows the room's view, which lists `bob` and `carol` as a tree under it. Enter on `bob` opens bob's thread. Three things fall short of the mockup:
- there is **no breadcrumb**;
- **Esc does not step out one level.** Esc focuses the prompt, and a second Esc **kills** the agent you are viewing;
- killing the room **cascades** to its members.

## Results

| # | Question | Result | Evidence |
|---|---|---|---|
| 1 | Can a background subagent spawn background subagents? | **Pass** | **[probe]** The room called `Agent` ×2 plus `hold` in one message, and `hold.log` shows `hold {"who":"bob"}` and `{"who":"carol"}` 0.6–1.5 s after the room's. The children's `meta.json` holds `"parentAgentId":"a5f76d524b5a63c11","spawnDepth":2`. **[source]** The depth cap is `Pw()`, which is `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, else GrowthBook `tengu_hazel_trellis`, else **3**. A spawn is refused when the caller's depth ≥ cap, with the error "Subagent nesting limit reached (depth N of M)". Only in-process *teammates* are barred from background spawns. Agent→member (depth 2) is well inside the cap. |
| 2a | Main panel | **Pass**: children are hidden in main | **[probe]** `⏺ main` / `◯ marmot-2509  plan 593da0 1/2 · ⚠ your sign-off needed`, one row only. With no status line override the default row text was `◯ p0:room (+2)  Relaunching bob agent`, so the collapsed row carries a child count. |
| 2b | Entering the parent lists its children | **Pass** | **[probe]** The pane after Enter on the room is below. |
| 2c | Keys and breadcrumb | **Partial** | **[probe]** Details below the table. |
| 3 | Row name | **Pass** | **[probe]** The description is the row label. The room row read exactly `marmot-2509`; this run's Haiku main *did* pass `name`, but the description is what counts. The divider shows `@marmot-2509` / `@bob`. **`subagentStatusLine` applies to nested rows**: stdin `tasks[]` lists all three (room, bob, carol), and the children's text was replaced. Its stdin has **no parent id or depth** (`{id,name,type,status,description,label,…}`; `name` is absent for the children). Room and member rows are told apart through `<project>/<session>/subagents/agent-<id>.meta.json` (`agentType`, `parentAgentId`, `spawnDepth`) or through PostToolUse(Agent), whose input carries `agent_id`/`agent_type` = **the spawning room** plus `tool_response.agentId` = the child. |
| 4 | Fallback quality | n/a (nesting works) | The room's own view also shows a native member list for free: `⏺ 2 background agents launched … ├ bob └ carol`. |
| 5 | Persistence and cost | **Pass**, with hazards | Details below the table. |

**2b: the room view after Enter.** The children appear as a tree under the room row:

```
⏺ 2 background agents launched (↓ to manage)
   ├ bob: bob
   └ carol: carol
  Calling plugin:p0:hold · 38s…
  ⎿  marmot-2509 heartbeat 2 @ 04:31:08
──────────────────────────────────── @marmot-2509 ─
❯ Message @marmot-2509…
  ↑/↓ to select · ctrl+x ctrl+k to stop all agents
  ◯ main
❯ ⏺ marmot-2509  plan 593da0 1/2 · ⚠ your sign-off needed
  ├ ◯ bob    working · in a1a93f (depth 2)
  └ ◯ carol  working · in a1a93f (depth 2)
```

The bob view (`↓`, Enter) shows bob's thread with the tree still visible:

```
  Calling plugin:p0:hold · 45s…  ⎿ bob heartbeat 3
─────────────────────────────── @bob ─
  ◯ main
  ◯ marmot-2509  …
❯ ├ ⏺ bob    working · …
  └ ◯ carol  working · …
```

**2c: keys at each level.**
- **Main.** `↓` focuses the panel; `↓` selects the room; Enter opens it.
- **Room view.** `↓` selects a child; Enter opens it.
- **Going up a level.** `↑` to the room, then Enter. `←` does nothing.
- **Esc.** The first Esc only unfocuses the panel. **The second Esc interrupts the viewed agent, and a background agent is then `killed`**: `Called plugin:p0:hold ⎿ Interrupted · What should Claude do instead?`, and the status line saw `bob killed`. A third Esc jumps straight to `main`.
- **Breadcrumb.** None: the divider shows only `@bob`. There is no keybinding action for "back one level"; the actions are `footer:*`, `agents:switchView` and `agents:togglePin`.

**5: persistence.**
- Samples every 30 s from 04:34 to 04:39 show `marmot-2509:running | carol:running | bob:running` throughout.
- **`/clear` in main did not cancel any nested hold.** There was no `notifications/cancelled`, the tree was intact after it, and the holds kept running past 7 min. This differs from E3's single-level finding.
- `/clear` changes `session_id`/`transcript_path`, so a status line lookup keyed on the current transcript dir breaks. Glob all session dirs or use the hook-written map.

**5: hazards.**
- **SubagentStop does not fire on an Esc-kill**, so the hook re-hold never ran.
- A killed row lingers as a duplicate for at least 5 min. It was evicted at the next `/clear`.
- **Esc-killing the room cascades.** Both the room's and carol's holds were cancelled, and main got `Agent "bob" was stopped by user` / `Agent "marmot-2509" was stopped by user`, which cost a main turn.
- **Child-kill recovery works.** The server sees `notifications/cancelled` for bob, returns `RESPAWN bob` on the room's hold, and the room re-spawns bob and re-holds. The new bob was up **5 s** after the kill:
  - `04:33:40 cancelled 3` → `RETURN 2 RESPAWN bob` → `04:33:43 hold marmot-2509` → `04:33:45 hold bob`.

**5: cost.**
- Room spawn: **1 Haiku request** (≈3.8k in / 0.7k out; the spawns and the hold share one message).
- Each member: **1 request** (1.5k in / ≈140 out).
- Each respawn: 1 room request (≈8k cache-create).
- **0 turns while held.** There were only 4 AgentSummary forks in 6 min, because idle holds don't change transcripts.
- Main pays 1 turn to spawn the room. It pays nothing for the children, except notifications that get re-routed to main when the room dies.

## Recommended implementation (member session)

1. **`agents/room.md`** (Haiku, `background: true`, `tools: Agent, mcp__plugin_sub-human_room__hold`).
   - The prompt is given as the room code plus the other members.
   - In ONE message, call `Agent({subagent_type:"sub-human:participant", description:"<member>", prompt:"<member>", run_in_background:true})` once per member, plus `hold({room:"<code>"})`.
   - On `RESPAWN <name>` or `JOINED <name>`, spawn that one participant and hold again.
   - On `LEFT <name>`, just hold again.
   - Main spawns it with `description:"<room code>"`, which gives the row its name, e.g. `marmot-2509`.
2. **`hold` in `room-server.js`** keeps a map of live calls, `requestId → {room|member}`.
   - It returns the room's pending call with `JOINED x` on `member_joined`.
   - It returns `RESPAWN x` when a member's call is cancelled (Esc-kill) and x is still present.
   - A member's call returns `STOP:` on `member_left`.
3. **Mapping** comes from PostToolUse(Agent): `agent_type == "sub-human:room"` means the child is a member row under that room; otherwise it is a top-level room row. Store `{id → role, member, parent}`. The status line reads this map, not the transcript path (which changes on `/clear`).
4. **`subagentStatusLine`** produces both kinds of text:
   - room row → `marmot-2509  plan 593da0 1/2 · ⚠ your sign-off needed`;
   - member row → `bob  working`;
   - status `killed` → `bob  (reconnecting)`, to hide the lingering duplicate.
5. **Navigation copy.** "Up arrow + Enter goes back; Esc twice stops the row".
   - Breadcrumbs are not native.
   - **A room kill can't self-heal.** The fix is a Monitor stdout line (`room row stopped`) that wakes main to re-spawn the room: 1 main turn.
   - Optionally, `agents:togglePin` may keep the room row pinned.
6. **The orchestrator session is unchanged** (flat `participant` rows, E1/E3).
