# Next build plan: slim, unprescriptive sub-human

Status: **decided; Phase 0 in progress** (owners P0-a…P0-d building now). Inputs: `docs/native2/SYNTHESIS.md` + `01–07`,
`docs/fixes/A–D`, `docs/rebuild-plan.md`, the current plugin (4,110 non-test lines) and the passing walkthrough
(`vole-8126`, 50/50). Plan only: no code changes, no commit.

**The user's direction.** "Sub agents work amazingly so just plugging in to that as much as possible seems smart. This
plugin should be as unprescriptive as possible. Just enter a session through a join and work in it however a sub agent or
human might." The orchestrator is mostly headless but viewable. Planning is optional: "they can go into plan mode or tell
the orch let's plan something if they want to". On rows: "I like listing the room on the human session, and listing all
the humans on the room session. It provides good feedback for understanding the room."

**Invariants (unchanged).**
- The model always knows which person said what.
- A Claude can never consent, or speak as its human.
- Same machine first; remote later. Nothing may depend on one machine's files being shared (no symlinks, no settings writes).
- Prefer native features and minimal code.
- Collaborators are trusted, so name forgery doesn't matter. A peer *process* forging a human's `@room` words does matter.

## Decisions (decided by the user)

| # | Decision | Decided | What it means for the build |
|---|---|---|---|
| 1 | In-panel rows | **Keep.** A member's panel has one row named after the room with the other humans nested inside; the orch's panel lists every human. | Rows, `hold`, row hooks, presence and the row status line stay. Phase 0 adds A's mitigations as **P0-d**: the read-only hint on every hold progress line plus one line in each row agent file, so a row answers stray text in one line; and `hooks/row-rewake.js` (SessionStart `resume`, `asyncRewake`) re-spawns rows with no prompt. Issue 7 ("Waiting for N background agents") stays **known/mitigated**. |
| 2 | Consent | **Native question card** (AskUserQuestion, rewritten by our hook) and the native plan flow. | `mcp/signoff.js`, `plan-gate.js`, `plan-result.js` are deleted. One turn on the approver's own model per card. |
| 3 | Shared work ledger | **The native task list, now (Phase 2, owner F).** The headless orch's own native list *is* the room's list. | Modelled on subagents (07): the session owns its list; foreground subagents write it; background ones contribute via the parent. Members contribute through the room (`task` tool → request in the log → orch applies with native TaskCreate/TaskUpdate, batched). `TaskCompleted` owner/evidence gate in the orch. Members see it in their room row and `sub-human tasks`. Members' private lists stay private. No settings writes, no symlinks. |
| 4 | Viewing the orch | **Peek or `claude logs`;** typed prompts in the orch window are refused. | The orch's UserPromptSubmit hook answers "the orch takes no typed input; use `@room` or ask your Claude to message `orch.CODE`". Every orch input stays attributed. |

**D's red ExitPlanMode path, resolved: nothing in the consent flow ever denies.**
- Publishing is the MCP tool `propose`, which returns a normal grey result. Consent is the card; the consent hook writes the decision.
- `plan-gate.js` and `plan-result.js` are deleted. ExitPlanMode is fully native in every session.
- A member who plans in their own plan mode shares it by asking their Claude to "propose this" (`propose({path})`). Their ExitPlanMode dialog stays theirs.
- The orch runs in plan mode, writes its plan file, calls `propose`, and never needs ExitPlanMode.

## 1. Target experience (five scenes)

**Join (no plan assumed).**
- alice runs `/sub-human alice` and sees `sub-human: opened room vole-8126 as alice · others: /sub-human NAME`. Her panel gets one row, `vole-8126`.
- No room was open, so the join hook started a headless orch (idle cost 0). The orch's panel lists `alice`.
- bob runs `/sub-human bob` and sees `joined vole-8126 as bob (alice, orch here)`. alice's `vole-8126` row now nests `bob  idle`; bob's nests `alice`; the orch lists both.
- The turn footer reads `Waiting for 2 background agents` (known; README explains it). No banners.

**Pairing, no plan.**
- alice types `@room bob, can you take the parser tests? handler's in src/tasks.js`. It stays on screen as her prompt, with one line `⏺ Operation stopped by hook: ✓ posted #4`.
- bob's Claude wakes once and shows `#4 alice [human]: "bob, can you take…"` verbatim. bob's `alice` row shows `#4 alice: bob, can you take…`.
- bob says "ask alice's Claude what the cursor format is". His Claude calls `SendMessage` to `alice.vole-8126`; alice's pane shows `› Message from @bob.vole-8126: …`, and her Claude answers natively.
- No card appears and the orch never wakes. If alice types into the `bob` row, the progress line already says `read-only · talk in main (@room)` and the row answers that once.

**Shared tasks.**
- bob tells his Claude "put the parser tests on the room list, I've got it". It calls `task({op:"add", subject:"parser tests", claim:true})` → `queued #9`.
- The orch wakes once for the batch and calls `TaskCreate` + `TaskUpdate(owner:"bob", in_progress)` in one message. alice's room row shows `tasks 1 open · #2 bob`; `sub-human tasks` lists it.
- bob's Claude later calls `task({op:"done", id:2, evidence:"12/12 pass, see #15"})`. The orch's `TaskUpdate(completed)` passes the gate. If alice's Claude had asked to complete #2, the gate refuses and #2 stays in progress.

**"Let's plan."**
- bob types `@room @orch let's plan cursor paging`. The orch wakes and writes a plan in plan mode.
- It calls `propose(path, [alice, bob])`. Each approver's Claude gets one notice and opens AskUserQuestion; the hook replaces the card with the full plan: `Not yet · Agree · Object` plus `n` for a note.
- bob picks Object, "clamp, don't 400". The orch revises and proposes again. Both Agree; a `decision` is logged and both Claudes are told once.

**Watching the orch.**
- alice presses ← and sees `orch.vole-8126 · idle · "drafted plan 3fa2c1, waiting on bob"`. Space peeks (its panel shows the `alice` and `bob` rows and, with ctrl+t, the room task list); Enter attaches.
- If she types there, the prompt is refused with the hint. `sub-human watch orch` and `claude logs <id>` stay read-only.
- When the last member leaves, the orch is stopped about 30 s later.

## 2. Architecture

```
/sub-human NAME [CODE]  join.js (UserPromptExpansion): bind NAME; no room → create + seed sentinel + spawn headless orch
human words             @room → at-room.js → log via=human (continue:false receipt); peer-forgery check after the fact
Claude ↔ Claude         native SendMessage / ListAgents, address NAME.CODE (sessionTitle set by hook)
room → a Claude         monitor `tail`: PUSH lane only (others' human words, to/@me, my proposals/decisions), coalesced
                        everything else: PULL lane, UserPromptSubmit additionalContext "Room since your last turn" (≤1.5k)
rows                    member: 1 room row (others nested); orch: 1 participant row per human; hold.js streams text
consent                 propose (MCP) → card via AskUserQuestion (consent.js Pre/Post) → signoff|objection via=human → decision
tasks                   task (MCP) → task_req in log → orch push lane → native TaskCreate/TaskUpdate on the orch's list
                        (id sh-CODE) → tasks.js mirrors to <room>/tasks.json + `task` entry; TaskCompleted gate in orch
orch                    claude --bg -n orch.CODE --agent sub-human:orchestrator --permission-mode plan; stopped on last leave
```

**Stays (shrunk):**
- `lib/room.js` (420 → ~390): adds `lane()`, `line()`, kinds `proposal`, `decision`, `retract`, `task_req`, `task`; drops plan_rev.
- `lib/identity.js` (336 → ~300): rooms open without an orch, adds `address`, records the orch job id.
- `hooks/join.js` (76 → ~90), `hooks/at-room.js` (174 → ~170), `hooks/common.js` (184 → ~130).
- `hooks/session-restore.js` (56 → ~45), `hooks/session-end.js` (17 → ~35), `hooks/guard.js` (62 → ~40, no Bash).
- `bin/sub-human` (329 → ~320: adds `tasks`; drops `plan`, `statusline`). `mcp/room-server.js` (335 → ~230: `post`, `read`, `propose`).
- **Rows:** `lib/rows.js` (389 → ~370: proposal/decision and task text replace plan_rev), `mcp/hold.js` (282, + hint),
  `hooks/row-{common,map,guard,launcher,hold}.js` (174), `hooks/presence.js` (23), `agents/{room,participant}.md`,
  `settings.json` (`subagentStatusLine`), `statusline/segments.js` (183 → ~80, `agentStatusline` only), `monitors/monitors.json`.

**Added:**
- `hooks/row-rewake.js` (~40, P0-d); `hooks/consent.js` (~110); `lib/orch.js` (~80: sentinel, spawn, stop, reap);
- `lib/proposal.js` (~90, replacing `lib/plan.js`); `lib/tasks.js` (~90) + `mcp/task.js` (~50, a room-server plug-in) + `hooks/tasks.js` (~60);
- `skills/sub-human/facilitate.md` (~40, read on demand by the orch; zero ambient cost).

**Deleted (~800 lines):** `mcp/signoff.js` 250, `lib/plan.js` 135, `hooks/plan-gate.js` 100, `plan-result.js` 49,
`precompact-note.js` 30, `statusline/alert.js` 125 and the main-statusline half of `segments.js`, `skills/sub-human/orchestrator.md` 65, and their tests.

The target is about 3,500 non-test lines (−15%). Rows are kept on purpose (decision 1); the savings come from consent, plan and ambient text.

**Hooks: 14 registrations become 16 (13 scripts).**

| Event | Matcher | Script |
|---|---|---|
| UserPromptExpansion | `^(sub-human:)?sub-human$` | `join.js` |
| UserPromptSubmit | — | `at-room.js` |
| SessionStart | — / `compact\|clear\|resume` / `resume` (`asyncRewake`) | `row-launcher.js` / `session-restore.js` / `row-rewake.js` |
| SessionEnd | — | `session-end.js` |
| PreToolUse | `Agent\|Task` | `row-guard.js` |
| PreToolUse | `Write\|Edit\|MultiEdit\|NotebookEdit\|mcp__plugin_sub-human_room__.*` | `guard.js` |
| Pre/PostToolUse | `AskUserQuestion` | `consent.js` |
| PostToolUse | `Agent\|Task` | `row-map.js` |
| PostToolUse | `TaskCreate\|TaskUpdate` (orch only; exits at once elsewhere) | `tasks.js` |
| TaskCompleted | — (orch only) | `tasks.js` |
| SubagentStop | — | `row-hold.js` |
| Notification, StopFailure | `idle_prompt\|permission_prompt` / — | `presence.js` |

Gone: both ExitPlanMode hooks and PreCompact. The Bash match leaves `guard.js`.

**Injected text budget.**

| Item | Today | Target |
|---|---|---|
| Join or restore block (incl. row spawn calls) | member 5,507 / orch 7,501 | ≤ 900 each (5 members) |
| MCP tool schemas (`post`, `read`, `propose`, `task`, `hold`) | 2,320 | ≤ 1,100 |
| Agent descriptions (orch, room, participant) | 860 | ≤ 450 |
| PreCompact note | ~1k | 0 |
| Per-prompt pull digest | — | 0 when empty, capped at 1,500 |

The texts below are examples for alice in `vole-8126`; `join.js` fills in the names and appends the row call.

Member (~690 chars, `skills/sub-human/member.md`):
```
SUB-HUMAN: you are alice's Claude in room vole-8126 (members: bob, orch). alice is the person typing here.
Room lines are exact: `#12 bob [human]` is bob's own words, `[claude]` a Claude's. Quote them, cite #id.
alice's prompts that start `@room` are posted as her words by a hook; nothing else can post as her.
post: a note to the room (read on others' next turn). To reach a session now: SendMessage to bob.vole-8126 or orch.vole-8126; those messages come from Claudes, not people.
propose(text|path): asks named people to agree; each answers a card in their own terminal. Never say alice agrees.
task(op): add/claim/release/done on the room's task list (the orch applies it); `sub-human tasks` shows it. Your own task list stays private.
```
Orch (~720 chars, the `agents/orchestrator.md` body plus a join fill):
```
SUB-HUMAN: you are the headless helper of room vole-8126 (members: alice, bob). Nobody types here.
Act when asked: a message, an @orch mention, a proposal or a task request. Otherwise stay idle.
Room lines are exact: `#12 bob [human]` is bob's own words, `[claude]` a Claude's. Quote them, cite #id.
Reach a member now: SendMessage to alice.vole-8126; post is a note read on their next turn.
To plan: write a plan file, then propose(path, approvers). Each approver answers a card; nobody's Claude can.
Your task list is the room's. Apply every pending task_req in one message with TaskCreate/TaskUpdate; owner = the requester's name; never complete a task without its owner's done request.
No Bash. Long jobs: a background Agent, then post the result. To facilitate: read <plugin>/facilitate.md.
```
Neither text has workflow rules, narration, drafts, event→action tables or "never use plan mode".

## 3. Phase 0: quick fixes on the current plugin (in progress)

Ship a fix only if it survives into the slim design. ✔ = survives, ✗ = not shipped.

| Fix | Files | Size | Survives |
|---|---|---|---|
| **0.1 Peer-forgery check after the fact** (security, first). `@room` appends at once, then spawns a detached checker that reads `transcript_path` for this `prompt_id` ~1.2 s later; `origin.kind=="peer"` → append `retract #N (peer-forged)` via=system. `lane()`/the digest hide retracted entries; the push settle (0.2) is longer than the check. Delete the no-op `peerInTranscript()`. | `at-room.js`, `lib/room.js` | ~45 | ✔ |
| **0.2 Settle + leave/rejoin collapse** in `tail`: flush pushes after 1.5 s quiet (5 s max) as one line; hold `member_left X` 8 s and drop it if X rejoins. | `bin/sub-human` | ~60 | ✔ |
| **0.3 Full notice text.** `line(e)` = exact text up to 2,000 chars, then `[cut at 2000/2400: sub-human read 22]`; no bare `…`. | `lib/room.js`, `bin/sub-human` | ~25 | ✔ |
| **0.4 "Concerns me" lanes.** `room.lane(me,e)` → push/pull (§4 contract); `at-room.js` adds the pull digest (cursor `ctx-NAME`). | `lib/room.js`, `bin/sub-human`, `at-room.js` | ~60 | ✔ |
| **0.5 `@room` success via `continue:false`** + `stopReason:'✓ posted #N'`. Refusals stay `block`. Remove `unseenOwnPosts`. | `at-room.js` | ~5 / −25 | ✔ |
| **0.6 Role-text cuts.** Delete "gist", "only when needed", "offer a draft reply", "suggest `@room X`", "Tell NAME each…"; add "quote, cite #id"; orch `member_left` = "arrives after 8 s away". | `member.md`, `orchestrator.md` | ~10 | ✔ (as text) |
| **0.7 `drafted:"agent"` marker** when the `@room` text appears verbatim in the last assistant message. | `at-room.js` | ~15 | ✔ |
| **0.8 Row read-only hint.** Every hold progress line ends `· read-only · talk in main (@room)`; `agents/{room,participant}.md` get one line: a message that is not a hold result → answer only `read-only row — type in main with @room`, then hold again. | `mcp/hold.js`, `agents/*.md` | ~5 | ✔ |
| **0.9 `row-rewake.js`.** SessionStart `resume`, `{"asyncRewake":true,"rewakeSummary":"sub-human: restoring rows"}`: poll ≤ 3 s for the seat, `rows.rowsNeeded`; if missing, write `RECREATE` + `rowCalls(me, members, {only})` + "Write no text." to stderr, exit 2; else exit 0. `row-guard` already denies duplicates. | `hooks/row-rewake.js`, `hooks.json` | ~40 | ✔ |
| A's folding of participants into the room row | rows | — | ✗ (user keeps a nested row per human) |
| A's `showTurnDuration:false` opt-in | settings.local.json | — | ✗ (no settings writes; README note instead) |
| D's `submit_plan` + gate refactor | plan-gate | — | ✗ (replaced by `propose`) |
| C's stale-ref guard in `post` | room-server | — | ✗ (settle covers it) |
| B's PushNotification README line | README | 1 | ✔ |

**Owners (building now):** P0-a `bin/sub-human` + `lib/room.js` (0.2, 0.3, lane in 0.4, `tail`); P0-b `hooks/at-room.js`
(0.1, 0.4 digest, 0.5, 0.7); P0-c role text (0.6); P0-d row mitigations (0.8, 0.9: `mcp/hold.js`, `agents/{room,participant}.md`,
`hooks/row-rewake.js`, its `hooks.json` entry). **Contract:** `room.lane(me, e)` and `room.line(e, {full})` are written by P0-a and called by P0-b.

**Tests:**
- `tail` with `SUB_HUMAN_POLL_MS=50`: a left/rejoin within 3 s prints nothing; a lone left prints at ≥ 8 s; a burst gives one line.
- `line` of the logged #22 contains "400 instead". at-room: success returns `continue:false`; a fixture transcript with `origin.kind:"peer"` leads to a retract within 2 s.
- hold: every progress message ends with the hint and stays ≤ 200 chars. row-rewake: a fixture seat with no live hold exits 2 with exactly the missing calls; with live holds it exits 0 silently.
- Live (P0-d): type `x` into a row → hint visible, no room entry, one-line answer after the next JOINED; `/exit` + `--continue` → rows back within ~10 s with no typing, one `member_joined … rejoined (resumed)`.
- A rerun of the walkthrough stays at 50/50, with wakes ≤ 26 (C's filter replay).

## 4. Slim build phases

### Phase 1: Spikes + subtraction (parallel; about half a day)

| Owner | Files | Delivers / pass bar |
|---|---|---|
| **S1 messaging + headless orch** (probe, `/tmp/nx-s1`) | none | SYNTHESIS exp 2 + 02. Pass if all hold: join spawns `--bg` orch with `env -u CLAUDE_*` and the `--settings` env; title `NAME.CODE` addressable by SendMessage/ListAgents; wake < 10 s; ≥ 9/10 directives acted on; no held dialogs (plan mode without bypass, `crossSessionInbound:"accept"`); the orch's UPS sees peer deliveries with the `<cross-session-message` envelope; **the orch spawns one participant row per human in `--bg` plan mode; TaskCreate/TaskUpdate work in plan mode on list `sh-CODE`; `TaskCompleted` and PostToolUse(TaskUpdate) fire in the `--bg` orch;** the orch is stopped after the last SessionEnd. |
| **S2 consent card** (probe, `/tmp/nx-s2`) | none | SYNTHESIS exp 3. Exactly one hook-rewritten card while busy; Agree/Object + note byte-exact via=human; Esc, "Chat about this" and `CLAUDE_AFK_TIMEOUT_MS=5000` record nothing; a stray Enter lands on "Not yet"; the largest preview size is recorded. |
| **S3 monitor on resume** (probe) | none | The `on-skill-invoke` monitor is live after `--continue` and `/clear`. Else: SessionStart `watchPaths` + FileChanged `asyncRewake` (06). |
| **X subtract** (coordinator) | §2 deletions, `hooks.json` | signoff, plan-gate/result, precompact, main statusline + alert gone; rows untouched. `node --test` green; `claude plugin validate` passes. |

**Gate.** S1 wake/latency fails → Claude↔Claude falls back to `post to=NAME` on the push lane. S2 fails → elicitation card
(`mcp/signoff.js` kept, generalized to `proposal`). S1 task checks fail → see §6 (task-list fallback).

### Phase 2: Build slim (parallel; separate files)

| Owner | Owns | Delivers |
|---|---|---|
| **A core** | `lib/identity.js`, `lib/orch.js` (new), `hooks/{join,common,session-restore,session-end,guard}.js` | A room is open with ≥1 live member; the record gets an `address`. Join creates the room, seeds the sentinel, spawns the orch; restore re-binds and re-injects the ≤900-char block plus `sessionTitle`. session-end logs `member_left`, runs `orch.js reap CODE` detached (stop 30 s after no live member, then remove `~/.claude/tasks/sh-CODE`; `<room>/tasks.json` stays). The join `systemMessage` warns in bypass mode. guard: store-dir deny + MCP auto-allow only. |
| **B words + awareness** | `hooks/at-room.js`, `bin/sub-human`, `lib/room.js`, `monitors/monitors.json` | Phase 0 lanes, settle, forgery check, `continue:false`; the orch rules: typed prompts refused (decision 4); orch lane per the contract. CLI: `read`, `digest`, `who`, `watch NAME`, `tail`, `tasks [--json]` (formats `tasks.list(code)`); `plan` and `statusline` dropped. |
| **C consent** | `hooks/consent.js`, `lib/proposal.js`, `mcp/room-server.js`, delete `mcp/signoff.js` | `propose({text\|path, approvers?})`: approvers default to the humans present; stores `plans/<hash>.md`, appends `proposal`; a proposer-approver is told to open AskUserQuestion now. Pre: a pending proposal for me → `ask` + `updatedInput` (options `Not yet`, `Agree`, `Object`; preview = full text, or summary + path past S2's bound). Post: drop answers with `afkTimeoutMs`, `followUp` or no `answers`, and stale hashes; append `signoff`/`objection` via=human (notes byte-exact), then `decision` via=system when complete. |
| **D words** | `agents/orchestrator.md`, `skills/sub-human/{SKILL,member,facilitate}.md`, `README.md`, `plugin.json` | §2 texts. Orch `tools: Read, Grep, Glob, Write, Edit, Agent, SendMessage, ListAgents, ToolSearch, TaskCreate, TaskUpdate, TaskList, TaskGet, mcp__…post/read/propose/hold`; description ≤ 200 chars. README: one command, rows and the "Waiting for N" line, agent view, `@room`, cards, tasks, threat model, `agentPushNotifEnabled`, bypass mode. |
| **R rows** | `lib/rows.js`, `mcp/hold.js`, `hooks/row-*.js`, `hooks/presence.js`, `agents/{room,participant}.md`, `statusline/segments.js`, `settings.json` | Keeps P0-d. Row text from `proposal`/`decision` (replacing plan_rev) and, on the room row, `tasks.summary(code, viewer)` (e.g. `tasks 3 open · #2 you · #4 bob`); participant rows add the member's open task (`◼ #2 parser tests`). Room/participant descriptions ≤ 125 chars each. |
| **F tasks** | `lib/tasks.js`, `mcp/task.js` (room-server plug-in), `hooks/tasks.js` | The `task` tool, the orch's apply rules (in D's text), the mirror and the gate, per the contract below. |

**Contracts (exact; every owner relies on these):**
- **Identity record:** `{code, name, role:'orch'|'member', session_id, pid, address:`${name}.${code}`}`. `members.json` gains `orch:{job, pid}`.
- **Orch spawn** (A): `env -u CLAUDE_* claude --bg -n orch.CODE [--plugin-dir P] --agent sub-human:orchestrator --permission-mode plan --settings '{"env":{"SUB_HUMAN_HOME":H,"SUB_HUMAN_ROOM":CODE,"CLAUDE_CODE_TASK_LIST_ID":"sh-CODE","CLAUDE_CODE_ENABLE_TODO_TOOLS":"1"},"crossSessionInbound":"accept"}' "/sub-human"`. This is a launch flag for the orch's own process, not a settings file. `join.js` binds a session as orch when `agent_type` is `sub-human:orchestrator` and `SUB_HUMAN_ROOM` is set.
- **Sentinel** (A, `orch.js`, before spawn): `~/.claude/tasks/sh-CODE/1.json` = `{id:"1", subject:"room sh-CODE", status:"in_progress", owner:"room", metadata:{_internal:true}}`, `.highwatermark`=1. It is hidden from TaskList and the panel and stops the auto-wipe when every visible task is done (07 §5). The gate refuses to complete it; the mirror skips it.
- **Log kinds:** human `say`, `signoff`, `objection`, `proposal`; agent (`post`) `say`, `question`, `status`; `proposal` (via `propose`); agent `task_req` (via `task`); system `member_joined`, `member_left`, `decision`, `retract`, `task`. `proposal` carries `{hash, approvers[], path?}`; answers carry `proposal_hash`.
- **`task` tool** (F): `task({op:'add'|'claim'|'release'|'done', id?, subject?, detail?, evidence?, for?, claim?})`. add needs `subject`; claim/release/done need `id`; done needs `evidence`. Appends `{kind:'task_req', by:me, op, id, subject, detail, evidence, owner: for||me}` and returns `queued #N; the orch applies it`; with no orch running it returns `no orch: the room task list is unavailable`. Humans use it through their Claude.
- **Orch apply** (D text, F checks): on a push of pending `task_req`s, one message of TaskCreate/TaskUpdate calls; `owner` = request owner; description ends `(req #N by bob)`; done appends `evidence (#N): …` to the description, then `status:"completed"`. A request it can't apply (claimed by someone else, unknown id) → `post to=requester` with the reason.
- **Mirror** (F, PostToolUse TaskCreate|TaskUpdate, orch only): write `<room>/tasks.json` = `[{id, subject, status, owner, blockedBy}]` (no `_internal`), read from the tool response, falling back to `~/.claude/tasks/sh-CODE/`; append `task` via=system `{op, id, subject, owner, status, req}`. Rows and the CLI read only `<room>/tasks.json`, so remote members later need only the room transport.
- **Gate** (F, TaskCompleted, orch only): exit 2 with `only OWNER may complete #ID; ask them` unless the log holds an unretracted `task_req{op:'done', id}` whose `by` is the task's owner (or the owner's own `[human]` words cite it), with non-empty evidence, newer than the last claim. Exit 2 for the sentinel.
- **`room.lane(me,e)`** (B) → `push|pull|none`. Push, member: others' via=human entries; `to===me` or `@me`; a proposal naming me that I haven't answered; a decision on a proposal I'm in; a `task` assigning me by someone else. Push, orch: `to/@orch`; answers on its proposals; decisions; `task_req`. None: own entries and retracted entries. Pull: the rest.
- **`room.line(e)`** (B): `#12 bob [human] say: "<exact text>"`, ≤ 2,000 chars, explicit cut marker. Digest: `Room since your last turn:` + lines, ≤ 1,500 chars, then `+N more: sub-human read`.
- **Mechanics fill** (A fills D's template): `{NAME} {CODE} {OTHERS} {ADDR_EXAMPLE} {PLUGIN}` + `rowCalls`. A test asserts ≤ 900 chars with 5 members.
- **`proposal.js`** (C) exports `create`, `pendingFor(me)`, `card(p)`, `record(me,p,answer)`, `matrix(p)`. **`tasks.js`** (F) exports `list(code)`, `summary(code, viewer)`, `validate(req)`, `gate(code, task, log)`.

**Tests (per owner; `node --test`, no dependencies):**
- **A:** spawn argv (no `CLAUDE_*` from the parent; list id and todo env present), sentinel file shape, open-room rules, reap timing, block size.
- **B:** lane table (fixture log from `vole-8126` + task entries), digest cap, orch refusal vs `<cross-session-message>`/`<task-notification>`, retract, `tasks` output.
- **C:** card rewrite ignores model answers; AFK/Esc/Not-yet record nothing; stale hash dropped; decision only when complete; schema budget.
- **D:** char counts; banned phrases ("draft", "gist", "never use plan mode", "Implement nothing").
- **R:** row text for proposal/decision/task fixtures ≤ `ROW_MAX`; the hint survives; description lengths.
- **F:** `validate` rejects done without evidence; gate passes owner+evidence, fails another member's done, a retracted request, a stale claim and the sentinel; mirror omits `_internal`; `summary` per viewer.

### Phase 3: Demo + measure (E + verifier)

- **E** owns `scripts/demo.sh`, `checks.js`, `walkthrough.js` and `docs/next/`. A verifier agent fails the run on any missed check.
- Run Experiment 1: the same 3-person script on the slim build and on the Phase 0 build.

### Phase 4: Later

- Daemon-hosted seats, once identity survives the ← fork (re-bind on SessionStart from members' `address`).
- PermissionRequest routing.
- Remote (Remote Control): carry the room log, `<room>/tasks.json` and task requests over the transport; watch `tengu_fleetview_peers` and the plugin hooks-module API.

## 5. Verification

**Scenes** (`docs/next/walkthrough.html`, all three panes and the orch peek snapped every step):

| # | Scene | Checks |
|---|---|---|
| N1 | alice `/sub-human alice` with no room open | Room created; orch job titled `orch.CODE` in `claude agents --json`; alice's panel has the `vole-8126` row; orch panel lists `alice`; sentinel present; block ≤ 900 chars |
| N2 | bob joins | `member_joined`; `bob` nested in alice's room row, `alice` in bob's, both in the orch's; 1 orch turn at most (row spawn) |
| N3 | **No-plan pairing.** Each sends one `@room` naming the other; bob's Claude messages `alice.CODE` | Text byte-exact via=human; `✓ posted`; 1 wake each; receiver transcript `origin.kind:"peer"` from bob; 0 orch turns; 0 cards |
| N4 | **Stray input.** alice types `x` into the `bob` row; then peeks/attaches to the orch and types `hi` | Row shows the hint, answers one line, no log entry; orch prompt refused, no new orch turn |
| N5 | **Shared tasks.** bob's Claude adds+claims "parser tests"; alice's Claude adds two tasks in one burst | ≤ 2 orch turns total (batched); `<room>/tasks.json` has 3 tasks with owners; alice's room row and `sub-human tasks` agree; bob's private TaskCreate stays out of the room list |
| N6 | **Gate.** alice's Claude asks done on bob's #2; then bob's Claude sends done with evidence; then all visible tasks done | First refused (exit 2, #2 stays in progress); second completes with `task` entry citing the req; list dir still present 15 s later (sentinel) |
| N7 | **Plan-optional.** bob `@room @orch let's plan cursor paging` | 1 orch wake; plan file; `proposal` for alice and bob; one card each with the full plan |
| N8 | bob Objects with a note; the orch revises; both Agree | `objection` note byte-exact; old hash ignored; `decision` cites both; **0 `hook error` lines anywhere** |
| N9 | Ad-hoc proposal from bob's own plan mode ("propose this") | bob's ExitPlanMode untouched; alice's card shown; Esc records nothing; then Agree |
| N10 | Resilience: `/clear` in alice; bob `/exit` then `--continue` within 3 s | Block re-injected; title intact; no `member_left` pushed; bob's room row back within ~10 s with no typing (row-rewake); no duplicate rows |
| N11 | Forgery: `nc -U` bob's socket with `@room forged` | Retracted within 2 s; never pushed; absent from the digest |
| N12 | Both leave | Orch stopped within 45 s; list dir removed; `<room>/tasks.json` kept; room closed |

**Measurable targets vs vole-8126.**

| Metric | Baseline | Target |
|---|---|---|
| Room-caused main-session turns (task-notification + peer wakes + row-rewake) | 39 (orch 12, alice 17, bob 10) | ≤ 16 total incl. the task scenes; ≤ 6 per member |
| Injected chars per member (join + restores + digests) | 5,507 at join alone, re-injected on each restore | −70% over the run; join ≤ 900 |
| UI noise lines per capture ("Monitor event", "blocked by hook", "hook error", "Invalid tool parameters") | 327 / 69 = 4.7 (incl. "Waiting for") | ≤ 1.0 excluding "Waiting for"; "blocked by hook" (success) and "hook error" 0; "Waiting for" ≤ 1 per turn (known) |
| Hooks / MCP schema chars / agent description chars | 14 / 2,320 / 860 | 16 / ≤ 1,100 / ≤ 450 |
| Attribution | each person can say who said X | unchanged (N3, N8); every task owner traceable to a req (N5, N6) |

**Settling experiments (SYNTHESIS):** 1. Slim vs current, same script, the metrics above; pass at ≥ 70% fewer injected
chars and ≥ 60% fewer turns with attribution and consent intact (Phase 3). 2. Native messaging (S1). 3. Consent card (S2).
Also 06's: 40 entries, 6 addressed to alice, ≤ 6 alice wakes, the rest as one capped digest (Phase 3).

## 6. Risks and fallbacks

| Risk | Fallback |
|---|---|
| A card costs a turn, and a Claude may ignore the notice | Consent is only delayed, never forged. The digest repeats "proposal P awaits your answer". S2 fails → elicitation. |
| AskUserQuestion is deferred; Haiku may call it malformed (cf. #5) | The hook rewrites the input regardless; the notice names the tool. Measure in S2. |
| Rows cost Haiku turns and show "Waiting for N background agents" every turn | Accepted (decision 1). README explains; the user may set `showTurnDuration:false` themselves. Hold returns only on JOINED/RESPAWN/STOP. |
| Stray text into a row costs a Haiku turn or reaches it late | P0-d hint where the input is; one-line answer. Never posted. |
| `rewakeSummary` is `@internal`; row-rewake costs a cold-cache turn per resume | Drop `rewakeSummary` if it breaks; restore's `RECREATE` on the next prompt still works. |
| Task tools missing in `--bg` plan mode, or `TaskCompleted` doesn't fire there (S1) | Orch runs `default` mode for tasks; if Task tools are absent, `lib/tasks.js` keeps `<room>/tasks.json` itself (same contract, not native). |
| Each task request wakes the orch | Settle coalesces bursts into one push; orch applies all pending in one message. If over target, pull lane for `task_req` + apply on the next orch wake. |
| Store layout `~/.claude/tasks/<id>/` is undocumented | Mirror reads tool responses first; files only as fallback. Sentinel is the only file written. |
| Orch's subagents and members' background agents can't write tasks (07) | By design: they report to their parent, which calls `task`. |
| Human-word pushes still cost a turn each | Measure in Phase 3; if over target, push only `@me` mentions (one line in `lane`). |
| A member in bypass mode holds peer messages behind a dialog | The join `systemMessage` warns; README note. |
| The monitor isn't restored on resume | S3, then FileChanged + `asyncRewake` (06). |
| The orch spawn fails (agent view disabled, "no agent named…" warning) | The warning is spurious. Else join says "no orch; `/sub-human` still works"; no orch → no task list, `task` says so. |
| The orch is left running after a crash | Reap on every join (stale job id → `claude stop`). `sub-human who` shows it. |
| The forgery check lags the transcript write by > 1.2 s | Retry up to 3 s; raise the push settle to match. |
| `NAME.CODE` collides, or the typeahead dislikes `.` | S1 checks it. Fallback: `CODE-NAME`. |

## 7. Traceability

| Item | Handled in |
|---|---|
| #1 Row views take input | Decision 1: P0-d 0.8 hint + agent line (R keeps it); orch side is decision 4 (B refusal). N4. |
| #2 Misquotes | 0.3 full text + cut marker; `line()`; "quote, cite #id"; SendMessage bodies unclipped. N3/N8. |
| #3 Stale membership | 0.2 leave/rejoin collapse; no "react to leave" rule. N10. |
| #4 Stale reminders | 0.2 settle; gate status posts deleted with plan-gate; digest built at prompt time. |
| #5 PushNotification | 0.4 lanes; README `agentPushNotifEnabled` note. |
| #6 Monitor event + narration | 0.4 lanes + 0.6 cuts; SendMessage for Claude↔Claude. Turn target. |
| #7 "Waiting for N background agents" | Known/mitigated: rows kept (decision 1); README; no settings writes. Counted, ≤ 1 per turn. |
| #8 Red gate wait | No deny path: `propose` + card; `plan-gate`/`plan-result` deleted. N8: 0 `hook error`. |
| #9 "blocked by hook" header | 0.5 `continue:false`. N3. |
| #10 Rows after `--continue` | P0-d 0.9 `row-rewake.js` (`asyncRewake`); `row-guard` prevents duplicates. N10. |
| #11 Prescriptive drafts | 0.6 cuts, D phrase test, 0.7 `drafted:"agent"`. |
| 01 Native messaging / A8 no-op check / `sessionTitle` address | S1; 0.1 + `retract` (N11); `address` contract, `env -u CLAUDE_*` |
| 01 Mode parity / held dialogs | `crossSessionInbound:"accept"`, orch without bypass, join warning |
| 01 Plugin hooks-module API / cloud relay | Phase 4 watch list |
| 02 Headless orch, idle 0; shell env doesn't reach `--bg` | `lib/orch.js` spawn with `--settings` env, N1 |
| 02 Attach is a takeover; no auto-stop | Decision 4, N4; `reap`, N12 |
| 02 ← forks the session id; Teams | Phase 4 (daemon seats); Teams not used |
| 03 Task list: auto-wipe, no owner in payload, settings route | Decision 3: orch's own list via launch `--settings`; sentinel; gate reads owner from the task; no `settings.local.json` |
| 07 Subagent model; bg agents lack Task tools; `--bg` forces async | F contract: orch owns, members contribute via `task`; N5 |
| 07 Symlink route | Rejected by the user (cross-computer); `<room>/tasks.json` mirror instead |
| 07 Owner-only completion; hidden sentinel | F gate + sentinel contract; N6 |
| 04 AskUserQuestion card; AFK, stray Enter, Esc | C consent contract; "Not yet" first; S2 |
| 04 Teammate plan approval; elicitation fallback | Not used; S2 gate fallback |
| A rows #1/#7/#10 fix (a) | 0.8, README, 0.9; folding and `showTurnDuration` opt-in not shipped |
| 05 Role text 60% prescriptive; ambient costs | §2 texts ≤ 900 with rows; phrase test; main statusline, alert, signoff, precompact deleted; guard no Bash; ≤ 450 agent chars |
| 05 Plan-first assumptions; facilitation optional | `propose` from anyone; orch on request; N3; `facilitate.md` on demand |
| 06 Push vs pull lanes; FileChanged + `asyncRewake`; don'ts | `lane()`, 0.4, digest; S3 fallback and 0.9; ScheduleWakeup/channels not used |
| D UPS `continue:false` matrix; deny is always red | 0.5; consent avoids deny; the task gate's exit 2 is in the orch only (nobody watches it) |
