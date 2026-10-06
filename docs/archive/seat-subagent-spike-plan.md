# Seat subagents: local spike plan

Synthesized from `docs/research/01`–`04` (Claude Code 2.1.281) and the existing `demo/`. Citations take the form (file, label). Labels: source = verified-by-source, probe = verified-by-probe, doc = documented, inf = inferred.

---

## 1. Summary

One interactive Claude Code session runs as the orchestrator: `claude --agent room-orchestrator`, never `-p`. It spawns one background seat subagent per human (`seat-alice`, `seat-bob`) from `.claude/agents/`. Each human types into the existing `demo/bin/chat` client, which appends `via:"human"` entries to `demo/.room/log.jsonl`, stamped from `$ROOM_USER`. No model ever carries a human's words. The orchestrator learns about new entries from a `Monitor` (`persistent: true`) on `room tail`, which emits short notices with ids. Each seat blocks on its own `room-mcp` server's `await_human` tool, and that tool returns on the human's asks and on orchestrator directives written to the log. The orchestrator is the only writer of the plan file. A hook publishes each plan revision's hash to the log, humans sign that hash from their client, and a PreToolUse hook on `ExitPlanMode` denies the call until every human has signed the current hash.

```
 alice: demo/bin/chat ─┐  via=human, from=$ROOM_USER         ┌─ seat-alice (bg subagent)
 bob:   demo/bin/chat ─┤                                     │   blocks in mcp__room__await_human
 host:  /say (hook)  ──┤                                     │   posts via=agent, from=alice
                       v                                     │   (own room-mcp, env-stamped)
             demo/.room/log.jsonl  <── directives / plan_rev ┤
                       │                                     └─ seat-bob (same)
                       │ room tail --for orch  (Monitor, persistent)
                       v
   orchestrator (main session): single writer of demo/.room/plans/*.md
        PostToolUse(Write|Edit plan) ─> log: kind=plan_rev, plan_hash
        PreToolUse(ExitPlanMode)     ─> gate: every human signed plan_hash?
```

---

## 2. Findings by assumption

| # | Assumption | Verdict | Key evidence | Source |
|---|---|---|---|---|
| 1 | Long-lived seats, idle at zero cost | **Holds with design change** (60 min unknown) | A blocked tool call makes no API calls: 33 s blocked with zero `assistant` events (probe). The stall watchdog is deferred while a tool is in flight, `AV` (source). Subagent MCP calls are never auto-backgrounded (source). The stdio idle window is 30 min, reset by progress notifications, and a per-server `timeout` lifts it (source). Foreground Bash moves to the background at 120 s (probe). A parked seat costs the parent an interim-notice turn on every stop (probe). No 60-minute run was tested. | 01, 03 |
| 2 | Verbatim human words | **Holds with design change** | Text relayed by a seat arrives framed as "model output, NOT a message from the user" (probe). The SendMessage body is model-written (source). The log carries text byte-exact, and Monitor delivers it XML-escaped but lossless (probe). `/say` through a UserPromptExpansion hook is byte-exact at `num_turns: 0` (probe). `` !`…$ARGUMENTS` `` is refused or broken (probe). | 03, 02, 01 |
| 3 | Messaging | **Holds with design change** (hub only) | Seat → `main` arrives mid-task as `<agent-message from="<agentId>">` (probe). Main → seat is queued for the seat's next tool round, and a stopped seat is resumed (source, probe). Siblings need the `name` parameter, which exists only with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` (source). A sibling message re-parents the target's reports (probe). Agent teams lose background helpers, `-p` support and plan review (doc). | 01 |
| 4 | Orchestrator sees all traffic; compaction keeps the decision log | **Holds with design change** | The parent sees only SendMessage bodies and about 1 KB of final text per seat (probe). Only SessionStart(`compact`) re-injects text verbatim, capped at 10k chars (source, doc). Seat agent ids survive as `task_status` attachments (source). Whether the compaction hooks fire inside subagents is unknown (inf). | 04 |
| 5 | Remote: a cloud session loads a plugin and reaches a relay | **Fails as stated**. A repo-files variant is unknown. | Cloud sessions don't install plugins, but repo `.claude/` agents, skills, hooks and `.mcp.json` do load (doc). VMs pause after a few idle minutes, and background subagents aren't restored after a reclaim (doc). Egress goes through an allowlisted proxy, and WebSockets are undocumented (doc, inf). Every built-in multi-device path requires the same account (doc). | 04, 03 |

### Conflicts resolved

| Conflict | Resolution | Why |
|---|---|---|
| **How a seat parks.** 01 says park on a background `room wait` and end the turn. 03 says block in an MCP `await_human` call. | **Block in `await_human`**, and have the orchestrator reach seats by **writing a `directive` entry to the log**, which makes `await_human` return. Background `room wait` is the fallback. | With background parking, every stop produces an interim notice, and each notice costs the orchestrator a turn (01). A blocked call never stops, so it never produces a notice. 01's objection to blocking is that a SendMessage waits for the next tool round. A log directive avoids that, because it ends the wait. SendMessage from main stays as a backup. |
| **What wakes the orchestrator.** 03 and 01 say Monitor, 02 says a plugin monitor or an `asyncRewake` hook, and 03 also offers a channel. | **`Monitor` with `persistent: true`.** Hooks are used only for enforcement. Channels come later, for remote. | Monitor events were probed mid-turn (03). Channels need a dev flag and a startup dialog, and their interactive delivery was never probed (03). `asyncRewake` is one-shot per hook run (02). |
| **Monitor deadline.** 01 says watches have a deadline (5 min default, 30 min max). 03 says `persistent: true` means "no timeout". | Use `persistent: true`, and verify it in step 3. If it doesn't hold, re-arm the watch when the deadline notice arrives. **Spike result: it doesn't hold. There's no `persistent` option, so the watch re-arms from a saved cursor (see spike-results).** | 03 cites the source string for `persistent`. 01 cites the docs for the default deadline. Both can be true. |
| **Who stamps a seat's posts.** 02 suggests a shared room MCP server referenced by name. | **One inline `room-mcp` per seat definition**, with `ROOM_USER` set in its `env`. | A shared server process can't tell which seat is calling it. An inline server starts per agent (02), so its env identity is fixed by the definition file, not by the model. |

---

## 3. Design

### 3.1 Orchestrator setup

- **Launch.** `demo/bin/start orch` runs `claude -n room-orch --agent room-orchestrator --permission-mode default`, interactive, in tmux. Do not use `-p`: in `-p`, ExitPlanMode is disabled and background waits are killed when the run exits (02 probe, 01 probe).
- **Environment.**
  - `ROOM_USER=orch` and `ROOM_HUMANS="alice bob"`.
  - `ROOM_HOST_USER=alice`, used for the host's `/say`.
  - `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` as a backstop to the heartbeat.
  - Leave `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` **unset**. Seats must not get names or become teammates (01).
- **`.claude/agents/room-orchestrator.md`.**
  - `skills: [pair-facilitator, room-protocol]`.
  - `initialPrompt`: "Arm the room Monitor, spawn one seat per name in $ROOM_HUMANS, post a `status` that the room is open."
- **Monitor.** `Monitor({command: "demo/bin/room tail --for orch --max-seconds 1790", timeout_ms: 1800000})`, re-armed with the identical call on expiry. *(Updated after the spike: 2.1.281 has no `persistent` option and caps watches at 30 min. `tail` saves a cursor in `tail-orch.cursor`, so a re-arm resumes without losing posts.)* `tail` prints one line per new entry, at most 240 chars: `#14 bob[human] objection refs=#9 plan=3fa2c1 "first 200 chars…"`. It skips the orchestrator's own entries and `ask` entries addressed to a seat. The orchestrator fetches full text with `room read --id 14` only when it needs it. That keeps notices small and avoids the compaction thrash breaker (04).
- **Plan mode.** Spawn the seats and arm the Monitor first, then switch to plan mode for the planning phase. Step 7 checks that both survive the switch.
- **Settings** (`.claude/settings.json`). Add `plansDirectory: "demo/.room/plans"` (the path must be inside the project, per 02) so the chat client can show the plan. Add the hooks in 3.6. Keep the existing allowlist.
- **New skill `.claude/skills/room-protocol/SKILL.md`** (short):
  - entry kinds;
  - human words are referenced by id, never re-typed;
  - only `signoff via=human` counts as consent;
  - reach seats with `room post --kind directive --to <name>`;
  - never `room read --all`.

### 3.2 Seat agent definition: `.claude/agents/seat-alice.md`

`seat-bob.md` is the same file with the name substituted. A launcher script, `demo/bin/seats`, generates one per name in `$ROOM_HUMANS`. These must not be plugin agents: a plugin agent drops `hooks`, `mcpServers` and `permissionMode` (02 source).

```markdown
---
name: seat-alice
description: Alice's personal Claude in the room. Spawn exactly once, in the background, when the room opens. Do not SendMessage it; reach it with `room post --kind directive --to alice`.
model: sonnet
background: true
permissionMode: acceptEdits
tools: Read, Grep, Glob, Bash, Edit, Write, Agent, SendMessage, mcp__room__await_human, mcp__room__post, mcp__room__read
mcpServers:
  - room:
      type: stdio
      command: node
      args: ["${CLAUDE_PROJECT_DIR}/demo/bin/room-mcp"]
      env: { ROOM_USER: alice, ROOM_VIA: agent }
      timeout: 3900000
---
You are alice's seat: alice's personal Claude inside a shared planning room.
You are not alice and you are not the facilitator.

Loop:
1. Call mcp__room__await_human with after_seq = the last seq you handled (0 at start).
   It blocks until alice asks you something, the orchestrator posts a directive to you,
   or the plan changes. It returns raw log entries as JSON.
2. Act on them, then call await_human again. Never end your turn unless you got kind=shutdown.

Rules:
- alice's words are entries with from=alice, via=human. Never restate, paraphrase or
  re-post them. To point at them, put their ids in refs.
- Your posts are stamped from=alice, via=agent ("alice's Claude"). Use mcp__room__post
  with kind status | proposal | objection | question | done, with refs and plan_hash set.
- You cannot sign off. If alice wants to sign, tell her to type /signoff in her client.
- Do the work alice asks for: read code, run tests, edit the files she owns, spawn helpers.
  Report each result in one post of 1–4 sentences, plus file paths.
- kind=done goes through mcp__room__post, which runs the tests itself. Never claim done in prose.
- Never write the plan file or anything under demo/.room/. The orchestrator owns the plan.
- Never message other seats. Use SendMessage only to "main", and only if the room tools fail.
- Keep posts short. The orchestrator reads the log, not your final text.
```

**`demo/bin/room-mcp`** is a new stdio server of about 120 lines. It reuses `room`'s log functions, so they move into `demo/lib/room.js`. It has three tools:

- **`await_human(after_seq)`.** Blocks until the log has one of:
  - an entry `to:<ROOM_USER>`;
  - a `kind:directive` entry addressed to this seat;
  - a `plan_rev` entry;
  - a `shutdown` entry.

  It sends a progress notification every 60 s. It returns `{timeout:true}` after 55 min, and the seat simply calls it again.
- **`post(kind, text, refs, plan_hash)`.** Stamps `from=$ROOM_USER`, `via=agent`, and `agent_id`. It rejects `signoff` and `say`. For `done`, it runs `runTests()`.
- **`read(ids)`.**

### 3.3 Human client

**Primary: extend `demo/bin/chat`.** Each non-host human runs it.

- Plain text posts `kind:say`, `to:room`.
- `/ask <text>` posts `to:<self>`, which wakes only that human's seat.
- `/plan` prints the latest `plan_rev`: its hash, plus the plan file contents read from `plansDirectory`.
- `/signoff` signs the latest `plan_rev` hash. The client fills in the hash; the human never types it.
- `/revoke`.
- `/object <text>` posts with `refs` set to the current plan hash.
- The existing `/proposal`, `/question`, `/done`, `/status` and `/test` stay. `/status` gains a sign-off matrix for the current hash.

**Secondary: `/say` in a real Claude Code session**, for the host, who types into the orchestrator session. A `UserPromptExpansion` hook with matcher `say` appends `command_args` byte-exact as `from=$ROOM_HOST_USER, via=human`, then blocks with `suppressOriginalPrompt`. That costs zero model turns (02 probe). Never build `/say` on `` !`…$ARGUMENTS` ``.

Recommendation: build both. `chat` is the spike's main surface. `/say` proves the "real Claude Code session" path, which a human needs to read diffs and run tests.

### 3.4 Message envelope (one JSON line in `log.jsonl`)

| Field | Type | Set by | Notes |
|---|---|---|---|
| `id` | int | writer, under a file lock | Monotonic. This is the existing `id`. |
| `at` | ISO time | writer | |
| `from` | `alice` \| `orch` \| … | **env** (`$ROOM_USER`) | Never a model argument. |
| `via` | `human` \| `agent` | **writer binary** | `chat` and the `/say` hook write `human`; `room-mcp`, `room post` from the orchestrator, and hooks write `agent`. `from=alice, via=agent` reads as "via alice's Claude". |
| `agent_id` | string? | room-mcp, from SubagentStart roster | Only when `via=agent` from a seat. |
| `kind` | enum | caller | `say`, `ask`, `proposal`, `objection`, `question`, `signoff`, `revoke`, `plan_rev`, `directive`, `status`, `done`, `decision`, `seat_up`, `shutdown`. `signoff` and `revoke` are valid only with `via=human`. `plan_rev` is valid only from the plan hook. |
| `to` | `room` \| seat name \| `all` | caller | Routing for `await_human` and `tail`. |
| `text` | string | caller | Stored byte-exact. |
| `refs` | int[] | caller | Ids of the entries this one acts on. Seats cite human words this way. |
| `plan_hash` | 12-hex sha256 | client or hook | Required on `signoff`, `revoke`, `plan_rev`, and on `objection` during planning. |
| `evidence` | object? | `runTests()` | Present on `done`. |
| `prev` | 12-hex | writer | Hash of the previous line. Gives cheap tamper evidence for a local file. |

Old `agree` and `concern` entries map to `signoff` (only with a `plan_hash`) and `objection`.

### 3.5 Plan protocol

1. **Single writer.** Only the main thread writes files in `demo/.room/plans/`. A `guard-room` hook denies Write, Edit or Bash touching `demo/.room/` whenever `agent_id` is present.
2. **Publish.** After each orchestrator write to the plan file, the `plan-publish` hook hashes the file bytes and appends `kind:plan_rev, plan_hash, text:<path>`. Seats wake on `plan_rev`. Humans see the plan with `/plan`.
3. **Critique.** Humans `/object` and `/question`, and seats post `proposal` or `objection` with `via=agent` and `refs`. The orchestrator answers by editing the plan, which produces a new hash and so voids every earlier sign-off.
4. **Sign-off.** A sign-off counts only if it has `kind:signoff`, `via:human`, `from` ∈ `$ROOM_HUMANS`, and `plan_hash` equal to the current hash, and the same human hasn't sent a later `revoke` for that hash.
5. **Gate.** The orchestrator calls `ExitPlanMode`, and the `gate-exitplan` hook hashes `tool_input.plan`. If no `plan_rev` with that hash exists, or anyone is missing a sign-off, the hook returns `permissionDecision:"deny"` with this reason: `ROOM-GATE: plan 3fa2c1 lacks sign-off from bob. Stay in plan mode; ask bob by name.` The model sees that reason and stays in plan mode (02 probe). Once every human has signed, the hook returns nothing and the host approves the usual dialog. Then the hook logs `kind:decision` with the hash.

### 3.6 Hooks (in `.claude/settings.json`; scripts in `demo/hooks/`)

| Event | Matcher | Enforces | Script |
|---|---|---|---|
| PreToolUse | `ExitPlanMode` | All humans signed the current `plan_hash` | `gate-exitplan` |
| PostToolUse | `Write\|Edit` (main thread, path under `plansDirectory`) | Plan hash is published by the channel, not stated by the model | `plan-publish` |
| PreToolUse | `Write\|Edit\|NotebookEdit\|Bash` (with `agent_id`) | Subagents never write `demo/.room/` or the plan file, and never run `room post` or `chat` | `guard-room` |
| PreToolUse | `SendMessage` | Seats (`agent_type` = `seat-*`) may send only `to:"main"`, which prevents re-parenting (01) | `guard-send` |
| PreToolUse | `Agent` (main thread) | At most one live seat per `subagent_type` | `guard-spawn` |
| SubagentStart | `seat-.*` | Records `agent_id → human` in `demo/.room/roster.json`, posts `seat_up`, and injects `additionalContext`: the last handled seq plus the current plan hash | `seat-register` |
| SubagentStop | `seat-.*` | Blocks the stop (`decision:"block"`, "call await_human") unless a `shutdown` entry exists, so a seat never produces interim notices. Lets the stop through when `stop_hook_active` is set, to avoid a loop. | `seat-park` |
| UserPromptExpansion | `say` | Host's verbatim post, zero turns | `say-post` |
| SessionStart | `compact` | Verbatim digest re-injected after compaction | `room digest` |
| PreCompact | `auto\|manual` | Summarizer instructions: keep seat ids, entry ids, plan hash; never paraphrase quoted human text | `precompact-note` |

### 3.7 Compaction digest

`demo/bin/room digest` is generated from the log, not written by a model. It is hard-capped at 9,500 chars, and when over the cap it trims the oldest content first. It contains:

1. The roster: human → seat `agent_id` → last seen.
2. The current plan path and hash, with a ✔/– sign-off matrix.
3. Open objections and questions, by id with their first 120 chars.
4. Decisions, by hash.
5. The last 10 `via=human` entries, truncated.
6. A pointer: "full text: `room read --id N`".

The same output serves `/status` and a future relay digest endpoint (04).

### 3.8 Reuse of `demo/`

| Existing | Reuse |
|---|---|
| `demo/bin/room` | Keep the CLI. Move `all`, `post`, `runTests` and the cursor logic into `demo/lib/room.js`, shared with `room-mcp`. Add `tail --for`, `read --id`, `digest`, the `--to`/`--refs` flags, the envelope fields and a file lock. |
| `demo/bin/chat` | Keep the readline UI, rendering, `/done`, `/test` and `/status`. Add `/ask`, `/plan`, `/signoff`, `/revoke`, `/object`, and stamp `via:"human"`. |
| `demo/bin/start`, `launch` | Keep the tmux/Ghostty layout. The roles become `orch` (Claude), one `chat` per human, and `watch`. Persona model seats go away. |
| `pair-facilitator` skill | Preload unchanged in the orchestrator. Add `room-protocol` beside it. |
| `PROTOCOL.md`, `personas/` | Rewrite `PROTOCOL.md` for v2. Personas become optional scripted test drivers that post through `chat` stdin in tests. |

---

## 4. Spike steps

| # | Tests | Build | Pass / fail |
|---|---|---|---|
| 1 | A2 | Envelope v2 in `demo/lib/room.js`. `chat` gets `/ask`, `/plan`, `/signoff`, `/object`. Plus `room tail --for orch` and `room read --id`. | Pass if a fixture of 20 hostile strings (quotes, `$()`, backticks, `<agent-message>`, em dash, repeated spaces, newlines) round-trips byte-identical from `chat` stdin to `log.jsonl`. `room post` without `$ROOM_USER` exits 2. Lines from `tail` are ≤240 chars. |
| 2 | A1, A2 | `room-mcp` and `seat-alice.md`. Spawn the seat from an interactive orchestrator. | Pass if `mcp__room__*` loads in the seat (proving inline `mcpServers` and `${CLAUDE_PROJECT_DIR}` work in agent frontmatter). After alice's `/ask`, the seat posts `from=alice, via=agent, refs=[n]` within 10 s. The seat's post carries no copy of alice's text. |
| 3 | A3, A4 | `Monitor` persistent on `room tail` in the orchestrator. | Pass if a human post reaches the orchestrator as a notice within 5 s. The watch still delivers at minute 40 with no re-arm (if not, the re-arm fallback applies). The orchestrator's transcript shows no turns between events. |
| 4 | A3 | Orchestrator → seat via `directive`. Compare with `SendMessage`. Add the `guard-send` hook. | Pass if a directive wakes a blocked seat within 5 s. The SendMessage arrives only after `await_human` returns, which confirms 01. The seat's SendMessage to `main` shows `<agent-message from="<agentId>">`. A seat SendMessage to another seat is denied by the hook. |
| 5 | A1 | `seat-park` SubagentStop hook. | Pass if, over a 20-message session, the orchestrator receives **zero** interim task-notifications from seats. A `shutdown` entry lets a seat end cleanly. |
| 6 | A1 | 60-minute soak: two seats idle, with heartbeats. | Pass if both seats are alive at 60 min and answer an `/ask` within 10 s. The seat transcripts show no `assistant` events during idle, apart from the `{timeout:true}` re-call at 55 min. Fail if a seat ends, a stall abort happens, or an MCP idle abort happens. |
| 7 | A2, A3 | Plan protocol: `plansDirectory`, `plan-publish`, `gate-exitplan`, `guard-room`. Then switch the orchestrator into plan mode. | Pass if the Monitor and the seats survive the switch to plan mode. The gate denies while bob is unsigned and names bob. An edit to the plan changes the hash and voids alice's earlier sign-off. With both sign-offs present, the approval dialog appears. A seat's Write to the plan file is denied. The hash of `tool_input.plan` equals the hash of the plan file's bytes. |
| 8 | A4 | `room digest`, the SessionStart(`compact`) hook, and the PreCompact hook. Run `/compact` in the orchestrator, then force a seat to compact by setting `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000` and having it read large files. | Pass if after `/compact` the digest appears verbatim and the orchestrator can name each seat's agent id, the current hash and the open objection ids without reading the log. Record whether the hook fired inside the seat (`agent_id` present). Either outcome is acceptable, but record which. |
| 9 | A2 | `/say` UserPromptExpansion hook in the orchestrator session. | Pass if `/say` with the step 1 fixture lands byte-exact, `from=$ROOM_HOST_USER, via=human`, with no new assistant turn in the transcript. |
| 10 | A5 (readiness only) | A cloud session on a throwaway branch carrying `.claude/agents/seat-*.md`, the hooks and `.mcp.json`, with Custom network access to one test endpoint. | Record four things: do the agent definitions and hooks load? Does HTTPS long-poll reach the endpoint? Does a WSS connection open? Does a blocked seat survive 10 idle minutes? This step informs section 7 and does not block the local spike. |

---

## 5. Decisions for the user

1. **Where a remote human's Claude runs** (04 §4.9).
   - **(A) Seats are subagents** on the host's machine and account, and remote humans use a thin client. The orchestrator gets native spawn, messaging and a single plan writer. The cost: a remote human can't read diffs or run tests locally, and all work bills to the host.
   - **(B) Every human runs their own Claude Code** as a peer on a relay. Each gets a real session. The cost: seats stop being native subagents, and every coordination guarantee has to move into the relay.
   - **Recommendation: (A)**, which matches your preference for subagents. Keep the envelope's `from`/`via` and the relay contract shaped so a (B)-style peer can later post as `from=bob, via=agent` without changes.
2. **Sign-off strictness.** Options: every human in `$ROOM_HUMANS` must sign the exact current hash, or a quorum, or a host override. **Recommendation:** unanimous on the exact hash, then the host still clicks the ExitPlanMode dialog. Don't auto-approve through a PermissionRequest hook in the spike. Any plan edit voids every sign-off.
3. **Packaging.** Ship as repo `.claude/` files (agents, skills, hooks, `.mcp.json`), or as a plugin. **Recommendation:** repo files. Plugin agents lose `hooks`, `mcpServers` and `permissionMode` (02), and cloud sessions don't install plugins (04). A plugin wrapper can come later for local installs.

---

## 6. Risks and fallbacks

| Risk | Fallback |
|---|---|
| Inline `mcpServers` or `timeout` is ignored in agent frontmatter, or `await_human` dies before 60 min (steps 2, 6). | Park seats on a background `room wait --for alice` and end the turn (01's pattern). The orchestrator wakes seats with SendMessage, and you budget one orchestrator turn per park. |
| The persistent Monitor dies or hits a deadline (step 3). | Re-arm on the deadline notice. Next options: an `asyncRewake` hook on a log-watcher, then a channel with `--dangerously-load-development-channels`. |
| Plan mode blocks Monitor or seats (step 7). | Stay in default mode while the plan is drafted, and enter plan mode only to finalize. Or gate a custom finalize step with the same hook. |
| A seat bypasses stamping through Bash or by writing the file directly. | `guard-room` denies these, and the `prev` hash chain exposes edits. Accepted as a local-spike limit; the relay closes it (section 7). |
| Seat helpers (`general-purpose` agents) can't be attributed in hooks: `agent_type` isn't `seat-*` and no spawn name is available (02). | Helpers get no room tools, and they report only to their seat, which posts `via=agent`. |
| A model presents a seat's paraphrase as alice's view. | Only `via=human` entries count as consent or quotes, the skill says so, and the digest lists human entries separately. |
| Seat permission prompts land in the host's terminal (01). | Use `acceptEdits` plus the existing allowlist. Each seat edits only its own files. |
| A crash of the orchestrator process kills every seat. | The log is the source of truth. On restart, `seat-register` injects each seat's last seq, and the seats resume from there. |
| 20 concurrent subagents is the cap (01). | Two to four seats plus helpers fits. Tell seats to keep at most 2 helpers each. |

---

## 7. Path to remote

Keep the envelope and replace the file with a relay, for example a Cloudflare Worker plus one Durable Object per room (04 §4):

- **Identity.** OAuth stamps `from`. The relay sets `via=human` only for authenticated human client connections.
- **Consent.** Sign-offs bind to `plan_hash` on the server. `gate-exitplan` asks the relay "is X fully signed?" instead of reading a file.
- **Agent access.** `room-mcp` and `room tail` switch from reading the file to HTTPS long-poll. Long-poll is safe through the cloud proxy, while WSS is unverified (step 10).
- **Client.** `chat` becomes a web client.

Run the orchestrator on the host's local machine, not in the cloud: cloud VMs pause when idle, and parked seats would not be restored (04). Remote Control and the other built-in paths are single-account, so they can't serve other people. If decision 1 later moves toward (B), a human's own Claude Code joins the same relay as a peer that posts `via=agent`.
