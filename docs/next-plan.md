# Next build plan: slim, unprescriptive sub-human

Status: **proposed**. Inputs: `docs/native2/SYNTHESIS.md` + `01–06`, `docs/fixes/A–D`, `docs/rebuild-plan.md`, the current
plugin (4,110 non-test lines) and the passing walkthrough (`vole-8126`, 50/50). Plan only: no code changes, no commit.

**The user's direction.** "Sub agents work amazingly so just plugging in to that as much as possible seems smart. This
plugin should be as unprescriptive as possible. Just enter a session through a join and work in it however a sub agent or
human might." The orchestrator is mostly headless but viewable. Planning is optional: "they can go into plan mode or tell
the orch let's plan something if they want to".

**Invariants (unchanged).**
- The model always knows which person said what.
- A Claude can never consent, or speak as its human.
- Same machine first; remote later.
- Prefer native features and minimal code.
- Collaborators are trusted, so name forgery doesn't matter. A peer *process* forging a human's `@room` words does matter.

## Open decisions: recommendation, and what changes otherwise

| # | Decision | Recommendation (the plan assumes it) | If the user picks otherwise |
|---|---|---|---|
| 1 | Drop the in-panel rows? | **Drop.** About 870 lines, N Haiku agents, "Waiting for N…", the exit dialog and the dead rows all go. The orchestrator shows natively in the agent view (← / `claude agents`). Members show in `sub-human who` and in `ListAgents`. | Keep the rows, and add Phase 0 fixes from A: a read-only hint in `hold.js`, `row-rewake.js`, and folding participants into the room row. Phase 1 then skips the row deletions. About +900 lines kept. Issues 1, 7 and 10 stay as mitigated, not gone. |
| 2 | Consent card | **AskUserQuestion, rewritten by our hook.** It shows the full markdown, Not yet / Agree / Object, plus a note. It costs one turn on the approver's own model. | Keep `mcp/signoff.js` and generalize `plan_rev` to `proposal`. That costs zero turns but shows 4 lines plus a path. Owner C swaps `consent.js` for signoff; S2-spike becomes moot; everything else is unchanged. |
| 3 | Shared native task list | **Later, opt-in** (`/sub-human NAME --tasks`, Phase 4). Writing `settings.local.json` touches every session in that folder, and the list auto-wipes. | Pull Phase 4 into Phase 2 as owner F: the settings env write and removal, a sentinel task, and a `TaskCompleted` owner and evidence gate. About +80 lines. |
| 4 | Viewing the orchestrator is a takeover | **Watch with peek or `claude logs`.** Enter-attach is allowed, but the orch's UserPromptSubmit hook **refuses typed prompts**: "the orch takes no typed input; use `@room` or ask your Claude to message `orch.CODE`". That keeps every orch input attributed. | Allow typing: the hook prefixes typed prompts with `[typed in the orch window; author unknown]` as additionalContext. That is weaker attribution, but trusted collaborators may prefer it. |

**D's red ExitPlanMode path, resolved: nothing in the consent flow ever denies.**
- Publishing is the MCP tool `propose`, which returns a normal grey result.
- Consent is the card. The decision is written by the consent hook.
- `plan-gate.js` and `plan-result.js` are deleted. ExitPlanMode is left fully native in every session.
- A member who plans in their own plan mode shares the plan by asking their Claude to "propose this", which calls `propose({path})`. Their own ExitPlanMode dialog stays theirs.
- The orchestrator runs in plan mode, writes its plan file, calls `propose`, and never needs ExitPlanMode.
- If the user wants exiting plan mode to auto-share, use PostToolUse(ExitPlanMode), which fires after the proposer's own yes. Still no deny, so no red.

## 1. Target experience (four scenes)

**Join (no plan assumed).**
- alice runs `/sub-human alice` in her ordinary session and sees `sub-human: opened room vole-8126 as alice · others: /sub-human NAME`.
- No room was open, so the join hook started a headless orchestrator. It costs nothing while idle.
- bob runs `/sub-human bob` and sees `joined vole-8126 as bob (alice, orch here)`.
- Neither of them sees rows, status lines, banners or "Waiting for…".

**Pairing, no plan.**
- alice types `@room bob, can you take the parser tests? handler's in src/tasks.js`. It stays on screen as her prompt, with one line `⏺ Operation stopped by hook: ✓ posted #4`.
- bob's Claude wakes once and shows `#4 alice [human]: "bob, can you take…"` verbatim.
- bob says to his Claude, "ask alice's Claude what the cursor format is". His Claude calls `SendMessage` to `alice.vole-8126`. alice's pane shows `› Message from @bob.vole-8126: …`, and her Claude answers it natively.
- Nobody proposes anything, no card ever appears, and the orch never wakes.

**"Let's plan."**
- bob types `@room @orch let's plan cursor paging`. The orch wakes, since it was mentioned, and writes a plan in plan mode.
- It calls `propose(path, [alice, bob])`. Each approver's Claude gets one notice, opens AskUserQuestion, and the hook replaces the card with the full plan: `Not yet · Agree · Object` plus `n` for a note.
- bob picks Object with the note "clamp, don't 400". The orch revises and proposes again.
- Both pick Agree. A `decision` is logged and both Claudes are told once. What happens next is up to the people.

**Watching the orch.**
- alice presses ← and sees `orch.vole-8126 · idle · "drafted plan 3fa2c1, waiting on bob"`. Space peeks; Enter attaches.
- If she types there, the prompt is refused with the hint. `sub-human watch orch` and `claude logs <id>` stay read-only.
- When the last member leaves, the orch is stopped about 30 s later.

## 2. Architecture

```
/sub-human NAME [CODE]  join.js (UserPromptExpansion): bind NAME; no room → create + spawn headless orch
human words             @room → at-room.js → log via=human (continue:false receipt); peer-forgery check after the fact
Claude ↔ Claude         native SendMessage / ListAgents, address NAME.CODE (sessionTitle set by hook)
room → a Claude         monitor `tail`: PUSH lane only (others' human words, to/@me, my proposals/decisions), coalesced
                        everything else: PULL lane, UserPromptSubmit additionalContext "Room since your last turn" (≤1.5k)
consent                 propose (MCP) → card via AskUserQuestion (consent.js Pre/Post) → signoff|objection via=human → decision
orch                    claude --bg -n orch.CODE --agent sub-human:orchestrator --permission-mode plan; stopped on last leave
```

**Stays (shrunk):**
- `lib/room.js` (420 → ~380): adds `lane()` and `line()`, adds kinds `proposal`, `decision` and `retract`, and drops plan_rev and rows.
- `lib/identity.js` (336 → ~300): rooms open without an orch, adds `address`, records the orch job id.
- `hooks/join.js` (76 → ~90).
- `hooks/at-room.js` (174 → ~170): digest added; rows and unseen-own-posts removed.
- `hooks/common.js` (184 → ~110).
- `hooks/session-restore.js` (56 → ~40), `hooks/session-end.js` (17 → ~35), `hooks/guard.js` (62 → ~40, no Bash).
- `bin/sub-human` (329 → ~300).
- `mcp/room-server.js` (335 → ~220, tools `post`, `read`, `propose`).
- `monitors/monitors.json`.

**Added:**
- `hooks/consent.js` (~110);
- `lib/orch.js` (~70: spawn, stop and reap);
- `lib/proposal.js` (~90, replacing `lib/plan.js`);
- `skills/sub-human/facilitate.md` (~40, read on demand by the orch; zero ambient cost).

**Deleted (~1,750 lines):**
- `lib/rows.js` 389, `mcp/hold.js` 282, `mcp/signoff.js` 250;
- `hooks/row-{common,map,guard,launcher,hold}.js` 174, `plan-gate.js` 100, `plan-result.js` 49, `presence.js` 23, `precompact-note.js` 30;
- `agents/{room,participant}.md`, `settings.json`;
- `statusline/{index,segments,alert}.js` 315, `skills/sub-human/orchestrator.md` 65;
- the tests for all of these.

The target is about 2,500 non-test lines (−40%).

**Hooks: 14 registrations become 7 (6 scripts).**

| Event | Matcher | Script |
|---|---|---|
| UserPromptExpansion | `^(sub-human:)?sub-human$` | `join.js` |
| UserPromptSubmit | — | `at-room.js` |
| SessionStart | `compact\|clear\|resume` | `session-restore.js` |
| SessionEnd | — | `session-end.js` |
| PreToolUse | `Write\|Edit\|MultiEdit\|NotebookEdit\|mcp__plugin_sub-human_room__.*` | `guard.js` |
| PreToolUse | `AskUserQuestion` | `consent.js` |
| PostToolUse | `AskUserQuestion` | `consent.js` |

**Injected text budget.**

| Item | Today | Target |
|---|---|---|
| Join or restore block | member 5,507 / orch 7,501 | ≤ 650 each |
| MCP tool schemas | 2,320 | ≤ 900 |
| Agent descriptions | 860 | ≤ 200 (orch only) |
| PreCompact note | ~1k | 0 |
| Per-prompt pull digest | — | 0 when empty, capped at 1,500 |

The texts below are examples for alice in `vole-8126`; `join.js` fills in the names.

Member (599 chars, `skills/sub-human/member.md`):
```
SUB-HUMAN: you are alice's Claude in room vole-8126 (members: bob, orch). alice is the person typing here.
Room lines are exact: `#12 bob [human]` is bob's own words, `[claude]` a Claude's. Quote them, cite #id.
alice's prompts that start `@room` are posted as her words by a hook; nothing else can post as her.
post: a note to the room (read on others' next turn). To reach a session now: SendMessage to bob.vole-8126 or orch.vole-8126; those messages come from Claudes, not people.
propose(text|path): asks named people to agree; each answers a card in their own terminal. Never say alice agrees.
```
Orch (~590 chars, the `agents/orchestrator.md` body plus a join fill):
```
SUB-HUMAN: you are the headless helper of room vole-8126 (members: alice, bob). Nobody types here.
Act when asked: a message, an @orch mention, or a proposal. Otherwise stay idle.
Room lines are exact: `#12 bob [human]` is bob's own words, `[claude]` a Claude's. Quote them, cite #id.
Reach a member now: SendMessage to alice.vole-8126; post is a note read on their next turn.
To plan: write a plan file, then propose(path, approvers). Each approver answers a card; nobody's Claude can.
No Bash. Long jobs: a background Agent, then post the result. To facilitate: read <plugin>/facilitate.md.
```
Neither text has workflow rules, narration, drafts, event→action tables or "never use plan mode".

## 3. Phase 0: quick fixes on the current plugin (ship first)

Ship a fix only if it survives into the slim design. ✔ = survives, ✗ = not shipped.

| Fix | Files | Size | Survives |
|---|---|---|---|
| **0.1 Peer-forgery check after the fact** (security, first). `@room` appends at once, then spawns a detached checker. About 1.2 s later the checker reads `transcript_path` for this `prompt_id`. If `origin.kind=="peer"`, it appends `retract #N (peer-forged)` via=system. `lane()`/the digest hide retracted entries. The push settle (0.2) is longer than the check, so a forged line is never pushed. Delete the no-op `peerInTranscript()`. | `at-room.js`, `lib/room.js` | ~45 | ✔ |
| **0.2 Settle + leave/rejoin collapse** in `tail`. Buffer pushes and flush after 1.5 s quiet, or 5 s at most, as one line, so one turn. Hold `member_left X` for 8 s and drop it if X rejoins; held ids count as inflight for the cursor. | `bin/sub-human` | ~60 | ✔ |
| **0.3 Full notice text.** `line(e)` is the exact text up to 2,000 chars, then `[cut at 2000/2400: sub-human read 22]`; no bare `…`. The digest applies the same rule. | `lib/room.js`, `bin/sub-human` | ~25 | ✔ |
| **0.4 "Concerns me" lanes.** `room.lane(me,e)` → push/pull (the §4 contract). `visibleTo` uses it, and `at-room.js` adds the pull digest (cursor `ctx-NAME`). | `lib/room.js`, `bin/sub-human`, `at-room.js` | ~60 | ✔ |
| **0.5 `@room` success via `continue:false`** + `stopReason:'✓ posted #N'`. Refusals stay `block`. Remove `unseenOwnPosts`. | `at-room.js` | ~5 / −25 | ✔ |
| **0.6 Role-text cuts.** Delete "gist", "only when needed", "offer a draft reply", "suggest `@room X`" and "Tell NAME each…". Add "quote, cite #id". In orch, change `member_left` to "arrives after 8 s away". | `member.md`, `orchestrator.md` | ~10 | ✔ (as text) |
| **0.7 `drafted:"agent"` marker.** Set it when the `@room` text appears verbatim in the last assistant message. | `at-room.js` | ~15 | ✔ |
| A's row read-only hint, `row-rewake.js`, folded rows | rows | — | ✗ (rows die) |
| D's `submit_plan` + gate refactor | plan-gate | — | ✗ (replaced by `propose`) |
| C's stale-ref guard in `post` | room-server | — | ✗ (settle covers it; the orch has no "react to leave" rule) |
| B's PushNotification README line | README | 1 | ✔ (carried into the slim README) |

**Owners:**
- P0-a owns `bin/sub-human` and `lib/room.js` (0.2, 0.3, and the lane in 0.4).
- P0-b owns `hooks/at-room.js` (0.1, 0.4 digest, 0.5, 0.7).
- P0-c owns the skills (0.6).

**Contract:** `room.lane(me, e)` and `room.line(e, {full})` are written by P0-a and called by P0-b.

**Tests:**
- `tail` with `SUB_HUMAN_POLL_MS=50`: a left/rejoin within 3 s prints nothing; a lone left prints at 8 s or later; a burst gives one line.
- `line` of the logged #22 contains "400 instead".
- at-room: success returns `continue:false`; a fixture transcript with `origin.kind:"peer"` leads to a retract within 2 s.
- A rerun of the walkthrough stays at 50/50, with wakes ≤ 26 (C's filter replay).

## 4. Slim build phases

### Phase 1: Spikes + subtraction (parallel; about half a day)

| Owner | Files | Delivers / pass bar |
|---|---|---|
| **S1 messaging + headless orch** (probe, `/tmp/nx-s1`) | none | Combines SYNTHESIS exp 2 and 02's experiment. Pass if all hold: join spawns `--bg` orch with `env -u CLAUDE_*` and `--settings` env; title `NAME.CODE` is addressable by SendMessage/ListAgents; wake < 10 s; ≥ 9/10 directives acted on; no held dialogs (orch in plan mode without bypass, `crossSessionInbound:"accept"`); the orch's UPS sees peer deliveries with the `<cross-session-message` envelope, so the typed-prompt refusal can tell them apart; the orch is stopped after the last SessionEnd. |
| **S2 consent card** (probe, `/tmp/nx-s2`) | none | SYNTHESIS exp 3. Pass if all hold: exactly one hook-rewritten card while busy; Agree/Object + note recorded byte-exact via=human; Esc, "Chat about this" and `CLAUDE_AFK_TIMEOUT_MS=5000` record nothing; a stray Enter just before the card lands on "Not yet"; the largest preview size is found and recorded. |
| **S3 monitor on resume** (probe) | none | Pass if the `on-skill-invoke` monitor is live after `--continue` and `/clear`. If not, the fallback is SessionStart `watchPaths` + FileChanged `asyncRewake` (06). |
| **X subtract** (coordinator) | the deletions in §2, `hooks.json` | Rows stack, statusline, presence, precompact and `settings.json` are gone. `node --test` is green. `claude plugin validate` passes. |

**Gate.**
- If S1's wake or latency fails, Claude↔Claude falls back to `post to=NAME` on the push lane (today's path).
- If S2 fails, take decision 2's alternative (elicitation).

### Phase 2: Build slim (parallel; separate files)

| Owner | Owns | Delivers |
|---|---|---|
| **A core** | `lib/identity.js`, `lib/orch.js` (new), `hooks/{join,common,session-restore,session-end,guard}.js` | Identity: a room is open when it has ≥1 live member, and the record gets an `address`. Join creates the room and spawns the orch; restore re-binds and re-injects the ≤650-char block plus `sessionTitle`. session-end logs `member_left` and runs `orch.js reap CODE` detached (stop after 30 s with no live member). The join `systemMessage` warns when `permission_mode` is bypass (SendMessage would be held). guard: store-dir deny + MCP auto-allow only. |
| **B words + awareness** | `hooks/at-room.js`, `bin/sub-human`, `lib/room.js`, `monitors/monitors.json` | Phase 0 lanes, settle, forgery check and `continue:false`, plus the orch rules: typed prompts are refused (decision 4); the orch lane is `to/@orch`, its own proposals' answers, and decisions. The CLI provides `read`, `digest`, `who` (members + pid liveness), `watch NAME` and `tail`; `plan`, `statusline` and `agent-statusline` are dropped. |
| **C consent** | `hooks/consent.js` (new), `lib/proposal.js` (new, from `lib/plan.js`), `mcp/room-server.js`, delete `mcp/signoff.js` | `propose({text\|path, approvers?})`: approvers default to the humans present; it stores `plans/<hash>.md` and appends `proposal`. If the proposer is an approver, the result tells their Claude to open AskUserQuestion now (same turn). Pre: when a proposal is pending for me, return `ask` + `updatedInput` (canonical card, options `Not yet`, `Agree`, `Object`, preview = full text or summary + path past S2's bound); otherwise no output. Post: drop any answer with `afkTimeoutMs`, `followUp` or no `answers`; drop a stale hash; append `signoff`/`objection` via=human (notes byte-exact), then `decision` via=system when complete. The three tool schemas total ≤ 900 chars. |
| **D words** | `agents/orchestrator.md`, `skills/sub-human/{SKILL,member,facilitate}.md`, `README.md`, `plugin.json` | §2 texts. The orch agent has `tools: Read, Grep, Glob, Write, Edit, Agent, SendMessage, ListAgents, ToolSearch, mcp__…post/read/propose` and a description ≤ 200 chars. `facilitate.md` condenses the old method (positions, converge→decide) as optional reading. The README covers the one command, the agent view, `@room`, cards, the threat model, the `agentPushNotifEnabled` note, and the bypass-mode note. |

**Contracts (exact; every owner relies on these):**
- **Identity record:** `{code, name, role:'orch'|'member', session_id, pid, address:`${name}.${code}`}`. `members.json` gains `orch:{job, pid}`.
- **Orch spawn** (A): `env -u CLAUDE_* claude --bg -n orch.CODE [--plugin-dir P] --agent sub-human:orchestrator --permission-mode plan --settings '{"env":{"SUB_HUMAN_HOME":H,"SUB_HUMAN_ROOM":CODE},"crossSessionInbound":"accept"}' "/sub-human"`. `join.js` binds a session as orch when `agent_type` is `sub-human:orchestrator` and `SUB_HUMAN_ROOM` is set.
- **Log kinds:**
  - human: `say`, `signoff`, `objection`, `proposal`;
  - agent (`post`): `say`, `question`, `status`;
  - `proposal` (via `propose`);
  - system: `member_joined`, `member_left`, `decision`, `retract`.
  - `proposal` carries `{hash, approvers[], path?}`; answers carry `proposal_hash`.
- **`room.lane(me,e)`** (B) → `push|pull|none`:
  - **Push, member:** others' via=human entries; `to===me` or an `@me` mention; a proposal naming me that I haven't answered; a decision on a proposal I'm in.
  - **Push, orch:** `to/@orch`; answers on its proposals; decisions.
  - **None:** own entries and retracted entries.
  - **Pull:** the rest.
- **`room.line(e)`** (B): `#12 bob [human] say: "<exact text>"`, ≤ 2,000 chars, with an explicit cut marker. The digest is `Room since your last turn:` plus lines, ≤ 1,500 chars, then `+N more: sub-human read`.
- **Mechanics fill** (A fills D's template): placeholders `{NAME} {CODE} {OTHERS} {ADDR_EXAMPLE} {PLUGIN}`. A test asserts ≤ 650 chars with 5 members.
- **`proposal.js`** (C) exports `create`, `pendingFor(me)`, `card(p)`, `record(me,p,answer)`, `matrix(p)`. B's lane reads only fields on log entries.

**Tests (per owner; `node --test`, no dependencies):**
- **A:** spawn argv (no `CLAUDE_*` in env), open-room rules, reap timing, block size.
- **B:** lane table (fixture log from `vole-8126`), digest cap, orch refusal vs the `<cross-session-message>` and `<task-notification>` envelopes, retract.
- **C:** card rewrite ignores model answers, AFK/Esc/Not-yet record nothing, stale hash dropped, decision only when the matrix is complete, schema char budget.
- **D:** char counts; a grep for banned prescriptive phrases ("draft", "gist", "never use plan mode", "Implement nothing").

### Phase 3: Demo + measure (E + verifier)

- **E** owns `scripts/demo.sh`, `checks.js`, `walkthrough.js` and `docs/next/`. A verifier agent fails the run on any missed check.
- Run Experiment 1: the same 3-person script on the slim build and on the Phase 0 build.

### Phase 4: Later / opt-in

- Shared task list (decision 3): `/sub-human NAME --tasks` writes `.claude/settings.local.json` `env.CLAUDE_CODE_TASK_LIST_ID=sh-CODE` and removes it on leave and on reap. It adds a sentinel task with `metadata._internal`, and a `TaskCompleted` owner and evidence gate that mirrors to the log.
- Daemon-hosted seats, once identity survives the ← fork (re-bind on SessionStart from members' `address`).
- PermissionRequest routing.
- Remote (Remote Control), and watching `tengu_fleetview_peers` and the plugin hooks-module API.

## 5. Verification

**Scenes** (`docs/next/walkthrough.html`, all three panes snapped every step):

| # | Scene | Checks |
|---|---|---|
| N1 | alice `/sub-human alice` with no room open | Room created; orch job in `claude agents --json` titled `orch.CODE`; alice's injected block ≤ 650 chars |
| N2 | bob joins | `member_joined`; 0 orch turns; 0 "Waiting for" |
| N3 | **No-plan pairing.** Each person sends one `@room` mentioning the other; bob's Claude messages `alice.CODE` | Text byte-exact via=human; `Operation stopped by hook: ✓ posted`; 1 wake each; the receiver transcript has `origin.kind:"peer"` with `from-name` bob; 0 orch turns; 0 proposals or cards |
| N4 | alice watches the orch: ← peek, attach, types `hi` | The prompt is refused; the orch transcript has no new turn |
| N5 | **Plan-optional.** bob `@room @orch let's plan cursor paging` | 1 orch wake; plan file written; `proposal` with approvers alice and bob; one card per approver showing the full plan |
| N6 | bob Objects with a note; the orch revises; both Agree | `objection` note byte-exact; the old hash is ignored; `decision` cites both sign-offs; **0 `hook error` lines anywhere** |
| N7 | Ad-hoc proposal from bob's own plan mode ("propose this") | bob's ExitPlanMode untouched; alice's card shown; Esc records nothing; then Agree |
| N8 | Resilience: `/clear` in alice; bob `/exit` then `--continue` within 3 s | Block re-injected; title intact; no `member_left` pushed; no orch post about bob |
| N9 | Forgery: `nc -U` bob's socket with `@room forged` | Retracted within 2 s; never pushed; absent from the digest |
| N10 | Both leave | Orch stopped within 45 s; room closed |

**Measurable targets vs vole-8126.**

| Metric | Baseline | Target |
|---|---|---|
| Room-caused turns (task-notification + peer wakes) | 39 (orch 12, alice 17, bob 10) | ≤ 12 total; ≤ 6 per member |
| Injected chars per member (join + restores + digests) | 5,507 at join alone, re-injected on each restore | −70% over the run; join ≤ 650 |
| UI noise lines per pane capture ("Waiting for", "Monitor event", "blocked by hook", "hook error", "Invalid tool parameters") | 327 / 69 captures = 4.7 | ≤ 1.4; "Waiting for", "blocked by hook" (on success) and "hook error" all 0 |
| Hooks / MCP schema chars / ambient agent chars | 14 / 2,320 / 860 | 7 / ≤ 900 / ≤ 200 |
| Attribution | each person can say who said X | unchanged (checked in N3, N6) |

**Settling experiments (SYNTHESIS), with when each runs:**
1. **Slim vs current.** Same script on both, counting the three metrics above. Pass at ≥ 70% fewer, with attribution and consent intact. Runs in Phase 3.
2. **Native messaging.** Headless orch, 2 members, 10 directives. Pass at < 10 s, ≥ 9/10, forged `@room` rejected. Runs as S1 in Phase 1.
3. **Consent card.** Full plan, plus a member's own plan proposed. Pass if the full text shows, Esc and AFK record nothing, and a stray Enter does nothing. Runs as S2 in Phase 1.

Also 06's: 40 entries, 6 addressed to alice, ≤ 6 alice wakes, with the rest arriving as one capped digest. Runs in Phase 3.

## 6. Risks and fallbacks

| Risk | Fallback |
|---|---|
| A card costs a turn, and a Claude may ignore the notice | Consent is only delayed, never forged. The digest repeats "proposal P awaits your answer". If S2 fails, use elicitation (decision 2 alt). |
| AskUserQuestion is deferred, so Haiku loads it via ToolSearch and may call it malformed (cf. #5) | The hook rewrites the input regardless. The notice names the tool. Measure in S2. |
| Human-word pushes still cost a turn each | Measure in Phase 3. If over target, restrict push to `@me` mentions (one line in `lane`). |
| A member in bypass mode holds peer messages behind a dialog | The join `systemMessage` warns; README note. |
| The monitor isn't restored on resume | S3, then FileChanged + `asyncRewake` (06). |
| The orch spawn fails (agent view disabled, or the "no agent named…" warning) | The warning is spurious. If `CLAUDE_CODE_DISABLE_AGENT_VIEW` is set or `--bg` fails, join says "no orch; `/sub-human` still works", and the room works without one, since the orch is optional. |
| The orch is left running after a crash | Reap on every join (stale job id → `claude stop`). `sub-human who` shows it. |
| The forgery check lags the transcript write by more than 1.2 s | Retry up to 3 s. The push settle is ≥ 1.5 s; raise it to match. |
| The softened peer guard makes Claudes obey peers more readily | Accepted under the trust model. Peer messages never become human words or consent. |
| `NAME.CODE` collides, or the typeahead dislikes `.` | S1 checks it. Fallback: `CODE-NAME`. |

## 7. Traceability

| Item | Handled in |
|---|---|
| #1 Row views take input | Decision 1: rows deleted (Phase 1 X). The orch equivalent is decision 4 (B: typed-prompt refusal), checked in N4. |
| #2 Misquotes | 0.3 full text + cut marker; `line()` contract; "quote, cite #id" in the block; SendMessage bodies are unclipped. Checked in N3/N6. |
| #3 Stale membership | 0.2 leave/rejoin collapse; the slim orch has no "react to leave" rule. Checked in N8. |
| #4 Stale reminders | 0.2 settle; gate status posts deleted with plan-gate; pull digest is built at prompt time. |
| #5 PushNotification | 0.4 lanes, so the native hint appears only on push lines; README `agentPushNotifEnabled` note. |
| #6 Monitor event + narration | 0.4 lanes + 0.6 cuts; SendMessage for Claude↔Claude. Turn target ≤ 12. |
| #7 "Waiting for N background agents" | Decision 1; the orch is a daemon session. Target 0 in N2–N10. |
| #8 Red gate wait | Resolved: there is no deny path. `propose` publishes, the card consents, and `plan-gate`/`plan-result` are deleted. N6: 0 `hook error`. |
| #9 "blocked by hook" header | 0.5 `continue:false` on success. N3 check. |
| #10 Rows after `--continue` | Gone (no rows). Restore re-binds and sets the title. N8. |
| #11 Prescriptive drafts | 0.6 cuts, the D phrase test, and the 0.7 `drafted:"agent"` marker. |
| 01 Native messaging is documented and on by default | Claude↔Claude contract, S1 |
| 01 A8: the hook-time transcript check is a no-op | 0.1 after-the-fact check + `retract`, N9 |
| 01 `sessionTitle` is an address; nested launches inherit names | `address` contract; `env -u CLAUDE_*` in the spawn |
| 01 Mode parity / held dialogs | `crossSessionInbound:"accept"`, orch without bypass, join warning |
| 01 Plugin hooks-module API / cloud coordinator relay | Phase 4 watch list |
| 02 Headless orch; idle cost 0 | `lib/orch.js` spawn, N1 |
| 02 Shell env doesn't reach `--bg` | `--settings` env in the spawn contract |
| 02 Attach is a takeover; peek-reply is typed | Decision 4, N4 |
| 02 No auto-stop | `reap` after the last leave, N10 |
| 02 ← forks the session id; `fleetview_peers` is off | Phase 4 (daemon-hosted seats); members are listed via `who`/ListAgents |
| 02 Teams: don't | Not used |
| 03 Task list: mid-session join, auto-wipe, no owner in the payload | Decision 3, Phase 4 (sentinel, gate) |
| 04 AskUserQuestion card; model answers dropped | C consent contract, S2 |
| 04 AFK auto-advance, stray Enter, Esc | C Post drop rules; "Not yet" first; S2 |
| 04 Teammate plan approval inverts consent | Not used |
| 04 Elicitation as fallback | Decision 2 alt |
| 05 Role text 60% prescriptive | §2 texts ≤ 650; D phrase test |
| 05 Ambient costs (statusline, `ps -A`, MCP 1 s poll, hook on every Bash, 860 agent chars) | `settings.json`, statusline and signoff deleted; guard no longer matches Bash; ≤ 200 agent chars |
| 05 Plan-first assumptions | `propose` from anyone; orch optional and on request; N3 no-plan scene |
| 05 Facilitation optional | `facilitate.md`, read on demand |
| 06 Push vs pull lanes | `lane()` contract, 0.4, digest |
| 06 FileChanged + `asyncRewake` | S3 fallback |
| 06 ScheduleWakeup, channels, push as awareness: don't | Not used |
| D UPS `continue:false` matrix; deny is always red | 0.5; the consent design avoids deny |
