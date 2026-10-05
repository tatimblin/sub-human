# Rebuild plan: humans join like subagents

Status: **proposed**. Inputs: `docs/native/SYNTHESIS.md` and the experiments `docs/experiments/E1–E3`.

## Context

The goal is for people to join a Claude Code session the way the session spawns subagents.

Research and three live experiments settled how to do this with Claude Code's own features:
- **Participant rows** in the agent panel, with text computed from the room log. They stayed correct for 30 minutes across 52 entries (E1). The single-call row from E3 costs nothing per entry.
- **A native sign-off form.** Elicitation reaches the approver in under 300 ms, idle or mid-turn. It runs no model turn and works in every permission mode (E2).
- **Participants are collaborators,** so forged names don't matter. What matters is that a Claude can never consent, or speak as its human.

This rebuild swaps today's custom pieces for those native ones. It also adds a scripted, screenshot-backed walkthrough, so the behaviour can be seen without running it.

## What the user sees

The room works like subagents. **The orchestrator's** panel lists every member directly, because they are its children:

```
⬡ marmot-2509 · orch · plan 593da0 1/2 ✔                       ← status line
● main
◯ alice   ✓ signed 593da0 · idle
◯ bob     ⚠ reviewing 593da0 · ✖ 1 objection (#31)
```

**A member's** panel has a single row named after the room, e.g. `marmot-2509`. The other members sit inside it, one level down. Members get no status line: the room row's text carries what the status line would have said (`⚠ your sign-off needed`, `✉ 1 for you`, plan progress). Inside the room, the orchestrator's posts are labelled `facilitator`:

```
Alice's panel                         Enter on marmot-2509          ↓ to bob, Enter
● main                                ◯ main                        ◯ main
◯ marmot-2509  plan 593da0 1/2 ·      ● marmot-2509                 ◯ marmot-2509
               ⚠ your sign-off needed   └ bob   working               └●bob   working
                                      (facilitator posts, plan      (bob's words + bob's Claude,
                                       revs, decision)               labelled separately)
```

Verified in P0 (`docs/experiments/P0-nested-rows.md`):
- **No breadcrumb, and Esc doesn't step back a level.** Go back up with ↑ to the parent row and Enter.
- **A second Esc kills the agent you're viewing.** Killing the room kills its members too. See Risks for the recovery.

All row views are read-only; talking happens in `main`.

When a plan is published, each approver gets a native form in their own terminal:

```
sub-human · room marmot-2509 · plan 593da0 (rev 2)
GET /tasks?limit&after: cursor paging, bare array, max 50
Full plan: ~/.sub-human/rooms/marmot-2509/plans/593da0.md   (or: sub-human plan)
  ❯ Approve      Object
  Reason (if objecting): ____
```

## Design (decided by experiments)

| Area | Decision | Evidence |
|---|---|---|
| Join | `/sub-human [NAME] [CODE]` from your own session. The CODE may be left out when exactly one room is open. | user |
| Identity | Hooks use the session id. The MCP server uses its parent claude pid via a direct lookup, not an ancestry walk. Process-start checks and forgery guards are dropped. | user, 09 |
| Orchestrator | The plugin agent `sub-human:orchestrator`, launched with `claude --agent sub-human:orchestrator --permission-mode plan`. Hooks see `agent_type`, and `tools:` excludes Bash. | 08 |
| Rows | **Orchestrator:** a `participant` row per member. **Member:** a `room` agent (haiku, background, tools `Agent` + `hold`). In one message it spawns a `participant` child per other member and calls `hold`. When `hold` returns `JOINED` or `RESPAWN NAME`, it spawns that child again (depth 2 of the default limit of 3; P0). Every row is held in a `hold` call. `subagentStatusLine` also renders nested rows. To tell rooms from members, PostToolUse(Agent) records child → room: there, `agent_id` is the room and `tool_response.agentId` is the child. Each makes one `hold({member})` MCP call that never returns and streams progress. `subagentStatusLine` computes the row text from the log. Agent id → participant is mapped in **PostToolUse(Agent)**. A SubagentStop hook re-holds the call. | E1, E3 |
| Row view | Read-only. Talking happens in `main` (`@room`, or ask your Claude). `sub-human watch NAME` prints a person's full thread. | E1 |
| Sign-off | The room server sends `elicitation/create` to each approver when a `plan_rev` arrives. Approve logs `signoff via=human`; object logs `objection via=human` with the reason. Esc re-offers the form after 10 minutes, or when the user says "review". A new revision cancels the stale form. | E2 |
| Plan text | A 3-line summary, the path, and `sub-human plan`, which prints the full plan. | E2 |
| Orch gate | Unchanged: it denies until every approver has signed, then allows with `updatedInput`, so no dialog appears. | spikes |
| Presence | `Notification` (`idle_prompt`, `permission_prompt`) and `StopFailure` hooks write presence. `sessionTitle` shows the seat. | 05 |
| Monitor | `when: on-skill-invoke:sub-human:sub-human` instead of `always`. | 08 |
| Status rows | The plugin ships `settings.json` with `subagentStatusLine`, pointing at a launcher that a SessionStart hook writes to plugin data. `${CLAUDE_PLUGIN_ROOT}` is empty in that setting. | 03, 08 |
| `--resume` | Rows are lost. session-restore injects "re-create your participant rows: …", listing the exact Agent calls. | E1 |

## Changes

**Remove:**
- the member branches of `plan-gate.js`;
- `plan-result.js` (the member path);
- `plan-backup.js` and `stop-feedback.js`;
- the clear-context and auto-mode handling;
- pending-review state;
- process-ancestry identity (`pidStart`, `ancestors`, `claudePid` walking);
- the forgery parts of `guard.js` (keep the no-write rule for the room dir);
- `agents/room.md` and the `watch` tool, which per-participant rows replace;
- the role-switch leftovers.

**Add:**
- `agents/orchestrator.md` and `agents/participant.md`;
- the MCP `hold` tool and elicitation sign-off in `mcp/room-server.js`;
- `sub-human plan` and `sub-human watch NAME`;
- the plugin `settings.json` plus a launcher-writer hook;
- `hooks/row-map.js` (PostToolUse Agent) and `hooks/row-hold.js` (SubagentStop);
- `hooks/presence.js`;
- an optional join code in `join.js`.

**Modify:**
- `orchestrator.md`: spawn rows on join and on `member_joined`; describe the form-based approval; keep it under about 6k characters;
- `member.md`: spawn rows; describe the form; no plan mode;
- `README.md`;
- tests.

## Probe P0: done

True nesting works in 2.1.281. The details are in `docs/experiments/P0-nested-rows.md`.

## Build (subagents in parallel, each owning separate files)

| Agent | Owns | Delivers |
|---|---|---|
| **A: core** | `lib/identity.js`, `lib/room.js`, `hooks/join.js`, `hooks/common.js`, `hooks/guard.js`, `hooks/session-*.js`, `mcp/room-server.js` (wiring only) | Session-id identity, the optional code, presence hooks, the restore re-spawn prompt, cleanup of removed code |
| **B: rows** | `agents/participant.md`, `mcp/hold.js`, `hooks/row-*.js`, `statusline/*`, plugin `settings.json`, launcher | Participant rows end to end, with row text computed from the log |
| **C: sign-off** | `mcp/signoff.js` (elicitation), `hooks/plan-gate.js` (orch-only), `bin/sub-human plan/watch` | The form flow, the stale-form cancel, the re-offer, and deletion of the member plan-mode code |
| **D: roles** | `agents/orchestrator.md`, `skills/sub-human/*.md`, `README.md` | Role text for the new flow, plus the launch commands |
| **E: visualization** | `scripts/snap.js`, `scripts/ansi-svg.js`, `scripts/walkthrough.js`, `scripts/demo.sh` | The capture and render tooling and the scripted scenes (below) |

## Visualization: how the behavior will be shown

**Tooling** (no dependencies; nothing is installed on this machine for ANSI rendering):

1. **`scripts/snap.js <tmux-session> <scene-id> "<caption>"`.** Runs `tmux capture-pane -ep` with colors, renders the result with `scripts/ansi-svg.js` (SGR colors to a monospace SVG), and writes `docs/rebuild/screens/<scene>-<session>.svg` plus a `.txt`.
2. **`scripts/demo.sh`.** Starts orch, alice and bob in detached tmux using `--plugin-dir` and a temp `SUB_HUMAN_HOME`. It drives each scene and snaps all three panes after every step. A real human can take any seat, and the script waits on `SUB_HUMAN_DEMO_PAUSE`.
3. **`scripts/walkthrough.js`.** Assembles `docs/rebuild/walkthrough.html`: one section per scene, with the caption, the three pane images side by side, the room-log excerpt for that step, and the pass/fail checks. It's published as an Artifact so it can be viewed and shared.

**Scenes.** Each one is snapped in all three sessions and paired with checks:

| # | Scene | What the screenshot must show | Checks |
|---|---|---|---|
| S1 | The orch starts and runs `/sub-human` | The invite code banner; the status line `⬡ CODE · orch` | Room dir exists; `agent_type` is orchestrator |
| S2 | alice joins with `/sub-human alice` (no code) | The join receipt; alice's panel with one `marmot-2509` row (no status line); the orch panel with an `alice` row | `member_joined`; row ids mapped |
| S3 | bob joins | The orch panel has alice and bob rows; each member panel has only the room row | orch: 2 rows; members: 1 row each |
| S4 | alice runs `@room …` | The receipt `✓ posted … as #N`; the rows update in the others' panels | Text identical byte for byte; `via=human`; 0 model turns |
| S5 | The orch drafts a plan | Rows read `drafting`; the orch's own status line | — |
| S6 | Plan published | **The native form** in alice's and bob's terminals, with summary, path, Approve/Object | Form shown within 1 s |
| S7 | bob objects with a reason | bob's form filled in; the objection appears in the orch and alice rows | `objection via=human`; reason identical byte for byte |
| S8 | The orch revises and both approve | Forms replaced (stale cancelled); `✓ signed` on both rows | Matrix complete |
| S9 | Automatic exit | The orch leaves plan mode with no dialog; decision; assignments; rows read `✓ decided` | `decision` refs both sign-offs; chain valid |
| S10 | Background work | alice's Claude runs her part in a native background subagent, shown in her panel; her `status` with evidence in the others' rows | Status cites evidence |
| S11 | Resilience | Rows survive `/clear` in alice's session; bob runs `--resume`, then rows are re-created after the restore prompt | Rows present after both |
| S11b | Nested view | alice opens the room row (main › marmot-2509) and sees bob inside, then opens bob (main › marmot-2509 › bob) to read his thread; Esc returns | Breadcrumb and nesting match |
| S12 | Leave | bob exits; his row stays (one row per person, ever) and reads `left` in the orch and alice panels, and comes back to life if he rejoins | `member_left` |

The **Ghostty view** is optional: for a live look, `scripts/demo.sh --windows` attaches read-only Ghostty windows to the three tmux sessions. Real window screenshots (`screencapture -l`) need Screen Recording permission, so they're opt-in. The SVG captures are the deterministic record.

## Verification

1. **Unit tests:** `node --test plugin/sub-human/test` passes. Removed features have their tests deleted. New tests cover:
   - `hold` streaming and abort;
   - the elicitation server flow (a mock client answers `elicitation/create`);
   - row mapping;
   - the optional code;
   - presence.
2. **Plugin checks:** `claude plugin validate plugin/sub-human` passes, along with the marketplace validation.
3. **Live run:** `scripts/demo.sh` runs S1–S12 with Claude-played members. A verifier agent checks every scene's checks and fails the run on any miss. Run cost goes into the walkthrough.
4. **Review:** the walkthrough is published as an Artifact. The user reviews it and then joins a live run.

## Risks

| Risk | Fallback |
|---|---|
| A haiku participant agent doesn't spawn rows reliably on join or rejoin (E1 needed a nudge on rejoin) | Make the join context list exact Agent calls. The restore hook re-prompts. A row that's still missing shows in the status line as `⚠ rows: 1 missing`. |
| Esc twice kills the row agent being viewed. SubagentStop does **not** fire for that. | **Member row killed:** the hold server sees the cancelled call and returns `RESPAWN NAME` to the room's `hold`, and the room spawns the row again in about 5 s (verified in P0). The dead row stays as a duplicate until `/clear`. **Room row killed:** a monitor line wakes `main` to spawn the room again. This is untested and goes in the build verification (S11). |
| `on-skill-invoke` monitor isn't restored after `--resume` | Session-restore asks the human to rerun `/sub-human`. If that's flaky, go back to `always` with a silent tail. |
| Agents B and C both need the room server | Already split: `mcp/hold.js` (B) and `mcp/signoff.js` (C), wired into `room-server.js` by A. |
