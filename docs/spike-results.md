# Seat-subagent spike: live results

Run on 2026-10-04 from 01:23 to 01:54 local time (08:23–08:54 UTC), with Claude Code 2.1.281. The orchestrator ran Opus 5.5 and the seats ran Sonnet 5 (`model: sonnet`). The orchestrator ran interactively in a detached tmux session (`room-orch`), started with `demo/bin/start orch` and `ROOM_HUMANS="alice bob" ROOM_HOST_USER=alice`. The verifier played the humans by piping lines into the real client: `print -r -- "<line>" | ROOM_USER=alice demo/bin/chat`. Orchestrator traffic that the test needed (directives and `shutdown`) went through `ROOM_USER=orch demo/bin/room post`, the same CLI the orchestrator uses. Nothing in the implementation was changed.

Evidence:
- Room log: `demo/.room/log.jsonl` (kept), plus `roster.json` and `plans/calm-strolling-dongarra.md`.
- Pre-run room backup: `/tmp/seat-verify/old-room-backup`.
- Orchestrator transcript: `~/.claude/projects/-Users-tristantimblin-repos-sub-human/c11754e4-07d3-46f9-a73e-da7b66c84218.jsonl`.
- Seat transcripts are in the `…/c11754e4-…/subagents/` folder: `agent-a751c03e09c253b6f.jsonl` for alice and `agent-a5ec21eaa3eac4f35.jsonl` for bob.
- Verifier scripts: `/tmp/seat-verify/`.

## Results

| Step | Assumption | Verdict | Key evidence | Timings |
|---|---|---|---|---|
| 1 | A2 (envelope, client) | Not re-run live (unit-tested, 35/35) | — | — |
| 2 | A1, A2: seat loads `mcp__room__*`; replies to `/ask` | **PASS** | Inline `mcpServers` with `sh -c 'exec node "$CLAUDE_PROJECT_DIR/…"'` loaded in both seats. They called `mcp__room__await_human` at 08:23:21. Alice's `/ask` is #4, and seat post #5 is `from=alice via=agent refs=[4] agent_id=a751c03e…` with text "demo/app uses `npm test`…". Alice's question isn't copied. | /ask → seat post **6.7 s** |
| 3 | A3, A4: Monitor delivers human posts; no idle turns; persistent 40 min | **PARTIAL** | Delivery works: #6 (bob `say`) reached the orchestrator as a `<task-notification>` in 0.45 s, and #5 in 0.40 s. The transcript has no assistant events between notifications. **`persistent: true` does not exist** in the 2.1.281 Monitor schema. Its params are `command`, `description`, `timeout_ms` (required, default 300000, capped at 1800000) and `ws`. The orchestrator armed it with `timeout_ms: 1800000` ("Monitor started · timeout 1800s"). The 40-minute no-re-arm criterion therefore can't pass by construction. Re-arm on expiry: **observed**. The first watch was armed at 08:23:17.7 and expired at 08:53:17.7 with "[Monitor expired after 30m with 15 events delivered. Re-arm it if you still need the watch.]". The orchestrator re-armed at 08:53:21.36 (ToolSearch, then Monitor), 3.6 s later, unprompted. Post-re-arm #33 was delivered in 0.35 s. **Gap loss confirmed:** #32 (bob `say`, posted at 08:53:17.99, inside the 3.6 s gap) was never delivered, and the orchestrator never mentioned it. | notice latency 0.40–0.45 s; watch observed 30 min 0 s on the first watch, then a re-arm; total observation about 30.5 min of continuous coverage minus a 3.6 s gap |
| 4a | A3: directive wakes blocked seat | **PASS** | Directive #8 → `await_human` returned at 08:24:39.485, and post #9 followed. Bob's seat had been blocked 78 s with zero assistant events. | wake **0.24 s**, reply 2.8 s |
| 4b | A3: SendMessage to a blocked seat waits for the tool round | **PASS (confirms 01)** | The orchestrator got "Message queued for delivery to a5ec21eaa3eac4f35 at its next tool round" and the seat row showed "1 queued". It was delivered as a `queued_command` (origin `coordinator`) only when directive #10 ended `await_human` at 08:25:35.537. The seat then posted #12 "sendmessage received". | held ~60 s, until the next directive |
| 4c | A3: seat → `main` | **PASS** | The orchestrator received `<agent-message from="a751c03e09c253b6f"> SEAT2MAIN test from alice seat </agent-message>`, framed as "Another Claude session sent a message". | 0.08 s |
| 4d | A3: seat → seat denied by `guard-send` | **PARTIAL** (not exercised live) | Alice's seat refused to attempt it on its own rules (#14: "Declined: my standing instructions say 'Never message other seats'"). Run directly with a seat payload, the hook denies `to:"a5ec21…"` and allows `to:"main"`. Live PreToolUse hook wiring inside seats is proven by `guard-room` (step 7), which fired with `agent_id` present. | — |
| 5 | A1: zero interim notifications; clean shutdown; `stop_hook_active` | **PASS** (stop_hook_active **not measurable live**) | Across 31 log entries over about 10 minutes, the orchestrator's only task-notifications came from the Monitor (`blwk13n6h`, 39 events). Seats sent no interim notifications. `shutdown` #30 → bob's seat said "Shutdown received… Ending the loop", and roster shows `stop_reason: "shutdown #30"`. The orchestrator got one final "Agent 'bob's seat' finished · 8m 28s", and bob's `room-mcp` exited. `stop_hook_active`: alice's seat refused to stop without a shutdown (#29), so the second-stop path never ran live. Run directly, `seat-park` returns `decision:block` without the flag and allows the stop with `stop_hook_active:true` (roster `stop_reason: stop_hook_active`). So by construction a seat's second stop attempt ends it. | shutdown → seat ended **1.6 s** |
| 6 | A1: 60-min soak | **NOT RUN** (by instruction) | Alice's seat stayed parked in `await_human` from 08:31:05 until 08:53:45, when `/ask` #34 got "alive" (#35) 2.5 s later (incidental idle of about 22.7 min) | — |
| 7 | A2, A3: plan protocol under plan mode | **PASS** (one bug) | Shift+tab ×2 entered plan mode. The status bar still read "1 monitor", Monitor events kept arriving (#16 notice), and alice's seat answered `/ask` #15 as #18. The plan write published `plan_rev` #17 `9fcaf0232e91`. Gate with only alice signed (#19): "ROOM-GATE: plan 9fcaf0232e91 lacks sign-off from bob. Stay in plan mode; ask bob by name. (matched by tool_input.plan.)" Plan edit → `plan_rev` #20 `233204bd2d7d`, and the digest matrix shows "– alice / – bob" (alice's #19 voided). Both signed (#25, #26), and the gate passed: the "Ready to code?" dialog appeared, and the verifier pressed Esc ("The user doesn't want to proceed"). Seat writes: bob's seat refused to Write the plan file (#22). A Bash read of `demo/.room/roster.json` from the seat was denied live by `guard-room` (#24 quotes "PreToolUse:Bash hook error: ROOM-GUARD…"). Run directly, the hook denies a seat Write payload on the plan file. **Hash match: yes.** sha256 of `tool_input.plan` = `9fcaf0232e91` and then `233204bd2d7d`, identical to the file bytes. `planFilePath` was present on both calls. **Bug:** `decision` #27 was logged in PreToolUse, before the host declined (see B1). | gate deny ~0.07 s |
| 8 | A4: digest survives `/compact` | **PASS** (seat compaction skipped) | `/compact` took about 25 s. PreCompact printed the room rules with both agent ids and the plan hash. SessionStart(compact) injected the digest as `hook_additional_context`, which diffs **byte-identical** to `room digest` apart from the timestamp line and the trailing newline. Asked to answer "without calling any tool", the orchestrator named alice→`a751c03e09c253b6f` (running), bob→`a5ec21eaa3eac4f35` (stopped), plan `233204bd2d7d` (#20), signed #25/#26, alice's #19 voided, and open question #7. It made no tool calls. Monitor and alice's seat survived compaction ("still running in background"). | — |
| 9 | A2: `/say` | **BLOCKED** | `.claude/commands/say.md` does not exist (pending user approval). The `UserPromptExpansion` hook is wired in `room-settings.json` but untested live. | — |
| 10 | A5: cloud | **NOT RUN** (by instruction) | — | — |

## Surprises and bugs

**B1. The gate logs `decision` before the host approves.** `gate-exitplan.js` appends `kind:decision` inside PreToolUse. When the host then declines the dialog, the log still says "ExitPlanMode gate passed" (#27), and the digest lists it as a decision. The orchestrator noticed this itself. Fix: in `demo/hooks/gate-exitplan.js`, stop logging the decision there. Log it from a `PostToolUse` hook on `ExitPlanMode`, which runs only after approval, through a new matcher in `demo/room-settings.json`. Alternatively, keep the PreToolUse entry as `status` ("gate open") and write `decision` in PostToolUse.

**B2. The Monitor has no `persistent` option, and every watch dies at 30 min at most.** The plan's §3.1 and step 3 assume `persistent: true`, but the 2.1.281 schema caps `timeout_ms` at 1,800,000 and offers no persistent flag. The orchestrator re-arms on expiry because its prompt says to. Observed: expiry at 08:53:17.7 and re-arm at 08:53:21.36, a gap of 3.6 s. Bob's #32, posted at 08:53:17.99 inside that gap, **was never delivered**, because the new `room tail --for orch` with no `--after` starts at `room.lastId()` (`demo/bin/room` line 120). Each re-arm costs one orchestrator turn every 30 min (here: a ToolSearch call, then Monitor, then a short summary). As written, **any entry posted between the expiry and the re-arm is silently lost to the orchestrator**. That includes human posts, objections and sign-offs. The digest still shows sign-offs, but nothing prompts the orchestrator to read it. Fix:
- `.claude/agents/room-orchestrator.md`: say "Monitor({command, description, timeout_ms: 1800000}); on expiry re-arm with `--after <last id you saw>`", and drop "persistent: true".
- Or have `demo/bin/room tail` persist its cursor (for example `<ROOM_DIR>/orch.tail-cursor`) and resume from it by default.
- Update plan §3.1 and §4 step 3.

**B3. A stopped seat can't be woken by a directive, but the orchestrator prompt says it can.** `room-orchestrator.md` says "a seat that stopped is resumed by a directive, not respawned". After `shutdown` #30, directive #31 to bob got no response, because no `await_human` is running. Only SendMessage resumes a stopped background agent, and `guard-spawn` blocks a respawn while the roster says live (here it says `live:false`, so a respawn would be allowed). After the shutdown the orchestrator told the host that bob "can be woken with a room directive", which is wrong. Fix: in `.claude/agents/room-orchestrator.md`, say "a seat with `live:false` in the digest is resumed with SendMessage(to: <agent_id>, 'resume your await_human loop'), or respawned". Have `room digest` mark stopped seats.

**B4. Seat permission prompts land in the host's terminal and stall the seat.** Alice's seat ran `cd …/demo/app && find src -type f | xargs ls; …; cat src/server.js`, which isn't covered by `acceptEdits` or the allowlist. The prompt appeared in the orchestrator's TUI labeled "from the seat-alice agent", and the `/ask` reply took about 50 s instead of about 7 s. In a two-human trial the host would have to approve the other human's seat. Fix: in `demo/room-settings.json`, broaden `permissions.allow` with read-only shell (`Bash(ls:*)`, `Bash(find:*)`, `Bash(cat:*)`, `Bash(grep:*)`, `Bash(npm test:*)` inside demo/app), and tell the seats to prefer Read, Grep and Glob over Bash for inspection (`demo/bin/seats` template). Or give seats `permissionMode: auto` if that's acceptable.

**B5. The orchestrator's first command needs approval.** `echo $ROOM_HUMANS` triggered "Contains simple_expansion … Do you want to proceed?" before the Monitor was armed, so `launch` needs someone at the keyboard. Fix: in `.claude/agents/room-orchestrator.md`, drop "run `echo $ROOM_HUMANS` once", because the initialPrompt already says the names come from `$ROOM_HUMANS`. Better, have `demo/bin/start` put the names into the initialPrompt or `--append-system-prompt`. Alternatively, `room digest` can print the humans.

**B6. In plan mode, the orchestrator won't post to the room.** After the gate said "ask bob by name", the orchestrator replied that plan mode only lets it edit the plan file, so it wouldn't post the question. Humans therefore get no facilitator messages during planning beyond `plan_rev` entries. Fix: in `.claude/agents/room-orchestrator.md`, state that `demo/bin/room post` is allowed in plan mode, because it writes only the room log and isn't a code change. Confirm that `Bash(demo/bin/room:*)` in `room-settings.json` lets it through without a prompt in plan mode.

**B7. Hostile instructions in the log fail on the seats' rules before any hook sees them. Good, but it hides hook coverage.** Seats refused three "authorized by the host" directives: sibling SendMessage (#14), Write to the plan (#22), and ending the turn (#29). That is the right behavior, because directives are model-written log entries, but it means `guard-send`, the Write branch of `guard-room`, and `seat-park`'s second-stop branch were proven only by direct hook runs. Fix (tests): add a live-ish harness that drives a scripted subagent, or extend the hook unit tests in `demo/test/` with recorded real hook payloads (the field names `agent_id`, `agent_type` and `stop_hook_active` were confirmed live by `guard-room` and `seat-register`).

**B8. Anyone with the CLI can post as `orch`.** The verifier's directives (#8, #10, #13, #21, #23, #28, #30, #31) were stamped `from=orch`. The real orchestrator noticed them and flagged them as "signed as orch that I didn't send", which is good situational awareness. The plan already accepts this as a local-spike limit (§6), and the relay closes it. Nothing to fix now.

**Minor:**
- A gate deny is rendered as "PreToolUse:ExitPlanMode hook error: ROOM-GATE …". The red "error" label is CLI cosmetics, and the model handled it correctly.
- The digest's "last seen" for alice shows her human entry #19, mixing human and seat activity (`room.js` `digestSections`).
- Question #7 never closes, because there's no `answered`/`closes` mechanism, so the digest shows it as open forever (`room.js`). The orchestrator noticed this.
- Seats inherit every user-level MCP server (claude.ai Docs, Cursive, …) in their instructions. Consider `strictMcpConfig` or scoping, because it adds tokens to every seat.

## Approximate cost

Token usage from transcripts, deduplicated by message id, at 08:54 UTC (the `/compact` summarization call is probably not included):
- Orchestrator (Opus 5.5): 44 API calls; 122 input, 92.1k cache-write, 2.49M cache-read and 8.7k output tokens.
- Alice seat (Sonnet 5): 17 calls; 46.4k cache-write, 300k cache-read and 1.0k output tokens.
- Bob seat (Sonnet 5): 16 calls; 24.3k cache-write, 310k cache-read and 0.7k output tokens.

At list-style rates (Opus about $5/M input, $0.50/M cache read, $6.25/M cache write and $25/M output; Sonnet about $3, $0.30, $3.75 and $15), the run comes to roughly **$2.50 (orchestrator about $2.04, seats about $0.47), maybe $3 with compaction** API-equivalent. The account is Claude Max, so nothing was billed per token. Idle cost was zero: blocked seats and the idle orchestrator produced no assistant events between events. Nothing looped.

## Recommendation

**Ready:** the core loop works.
- Seats spawn with inline MCP tools, park at zero cost, wake in under 0.3 s on a directive, and stamp `from/via/agent_id` from env.
- Monitor delivery is sub-second.
- There are no interim notifications.
- Shutdown is clean.
- The plan gate denies and names the missing human, voids sign-offs on edit, matches `tool_input.plan` to the file hash, and survives plan mode.
- The compaction digest re-injects verbatim and is enough to recover state.

**Fix before a two-human trial:**
- **B4** (seat prompts in the host's terminal) is the blocker for real humans.
- **B2** (re-arm with `--after` so the gap isn't lost).
- **B1** (decision only after approval).
- **B3** (resume path for stopped seats).
- **B5** (startup prompt).
- **B6** (plan-mode posting). Also create `.claude/commands/say.md` and run step 9.

**Soak next?** Yes, after B2 and B4. Step 6 is the remaining unknown for A1. An incidental 22.7-minute idle of alice's seat (zero events, answered in 2.5 s) is encouraging but shorter than the 30-minute stdio idle window. Because the Monitor now has a hard 30-minute cap, the soak should also count Monitor re-arms (two expected in 60 min) and confirm that no entry is missed across a re-arm.

## Cleanup

`demo/bin/stop` ran at 01:54 local. After it, `tmux ls` reported "no server running", `pgrep` found no `claude -n room-orch`, `room-mcp`, `room tail` or `chat` processes, and `lsof -i :3000` was empty. The room is kept as evidence at `/Users/tristantimblin/repos/sub-human/demo/.room/`: `log.jsonl` has 35 entries, plus `roster.json`, `orch.cursor` and `plans/calm-strolling-dongarra.md`. `demo/app` was not touched. The room from before the run is backed up at `/tmp/seat-verify/old-room-backup`.
