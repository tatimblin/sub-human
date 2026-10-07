# Architecture

How sub-human works today, for a new contributor or a fresh Claude session. User-facing behaviour is in [`plugin/sub-human/README.md`](../plugin/sub-human/README.md); the Claude Code internals behind it are in [`docs/internals/cc-2.1.281.md`](internals/cc-2.1.281.md), with the 2.1.292 changes in [`docs/internals/cc-2.1.292.md`](internals/cc-2.1.292.md). Sections marked *generated* are rewritten by `npm run docs` (`scripts/arch-doc.js`) from the code; edit the code, not the table. `npm test` fails when they are stale.

## Purpose and design rules

Several people, each in their own Claude Code session on one machine and one OS user, share a **room**. A person's exact words reach the room only through a hook (`@room …`). Claudes talk to each other with native `SendMessage`, addressed `NAME.CODE`. A headless **orch** keeps the shared task list and plans only when asked. Consent to a proposal is recorded only from the person's own answer in a native dialog.

The one security goal: **a model can never speak or consent as a person.** The rules that follow from it, and from keeping the plugin unobtrusive (also in `CLAUDE.md`):

- Never pin a model (agents, the orch spawn, the demo, tests).
- No writes to user settings files and no symlinks into `~/.claude`. The plugin keeps its own home and uses the native task list.
- The orch takes no typed input. People reach it with `@room @orch …` or through their Claude.
- Keep the agent-panel rows (the room row with members nested in it; the orch's panel lists every human).
- Consent is native: plan view first, question card as fallback; only `via=human` answers count.
- Unprescriptive: no required workflow; injected text covers mechanics only.
- Every undocumented Claude Code behaviour relied on is listed in `lib/cc.js` and checked by `npm run probe`.
- Zero dependencies, CommonJS, Node 20+, macOS/Linux.

## Process model

```
 member session (claude, interactive)                    orch (claude --bg, headless, one per room)
 ┌──────────────────────────────────────────┐            ┌───────────────────────────────────────┐
 │ main thread (the person's Claude)        │ SendMessage│ main thread: agent sub-human:orchestrator
 │   spawns ─► room row  (agent room, bg)   │◄──────────►│   spawns ─► participant row per human  │
 │               spawns ─► participant rows │            │   native task list = the room's list   │
 │ hooks: one node process per event        │            │ hooks: same hooks.json                 │
 │ monitor: bin/sub-human tail (long-lived) │            │ monitor: tail (orch formatter+watchdog)│
 │ MCP: mcp/room-server.js (+hold, +task)   │            │ MCP: its own room-server.js            │
 │ subagentStatusLine: <home>/bin/row-status│            └───────────────────────────────────────┘
 └──────────────┬───────────────────────────┘                             │
                │          all read/write through lib/room/store.js       │
                └────────────────► <home>/rooms/<CODE>/ ◄─────────────────┘
```

Per session, Claude Code starts:

- **Hooks** (`hooks/*.js`): short synchronous `node` processes, one per matching hook entry. They are the only code that resolves identity from the payload and the only code that holds the seat signing key. `prompt.js` runs both UserPromptSubmit handlers (at-room, consent) in one process.
- **The monitor** (`monitors/monitors.json`, `when: "always"`): `bin/sub-human tail` → `lib/tail.js`. It runs in every session with the plugin loaded, stays silent until the session has a seat, then prints the push lane. It never exits, because Claude Code does not re-arm a monitor that exited.
- **The MCP server** (`.mcp.json` → `mcp/room-server.js`): stdio JSON-RPC, one per session. Its plug-ins `mcp/hold.js` and `mcp/task.js` add tools. It resolves the caller from `process.ppid` on every call. It cannot sign `via=human`.
- **Rows**: background subagents that make one blocking MCP call (`hold`) and stream progress, so they cost no tokens while they hold. Their panel text comes from the plugin's `subagentStatusLine` (`settings.json` → `<home>/bin/row-status`, written by `hooks/row-launcher.js`, which runs `statusline/`).

Who spawns whom:

| Spawner | Spawns | How |
|---|---|---|
| `hooks/join.js` (first member, or a room with no live orch) | the orch | claim under the members lock, then detached `node lib/orch.js start` → `claude --bg -n orch.CODE --agent sub-human:orchestrator --permission-mode plan --settings {…} /sub-human` |
| a member's main thread | one `sub-human:room` row | the `Agent` call the join/restore context lists under ROWS |
| a room row | one `sub-human:participant` row per other member | on start, and when `hold({room})` returns `JOINED`/`RESPAWN` |
| the orch's main thread | one participant row per human | on a pushed `member_joined` that carries the Agent call |
| `hooks/at-room.js` | a detached forgery checker | `node at-room.js --forgery-check JOB` |
| `hooks/session-end.js`, `orch.watchdog` | the reaper | detached `node lib/orch.js reap CODE` |

`hooks/row-guard.js` denies a duplicate row spawn; `row-map.js` records which panel row is which agent; `row-hold.js` (SubagentStop) tells a row that gave up to hold again; `row-rewake.js` (SessionStart resume, `asyncRewake`) re-spawns rows after `--resume`.

### Event → hook map (generated)

<!-- gen:hooks -->
| Event | Matcher | Script | Timeout | Async |
|---|---|---|---|---|
| UserPromptExpansion | `^(sub-human:)?sub-human$` | `hooks/join.js` | 10 s | — |
| UserPromptSubmit | (all) | `hooks/prompt.js` | 10 s | — |
| PreToolUse | `Agent\|Task` | `hooks/row-guard.js` | 10 s | — |
| PreToolUse | `^(Write\|Edit\|MultiEdit\|NotebookEdit)$\|^mcp__plugin_sub-human_room__` | `hooks/guard.js` | 10 s | — |
| PreToolUse | `^Bash$` | `hooks/guard.js` | 10 s | — |
| PreToolUse | `^(AskUserQuestion\|EnterPlanMode\|ExitPlanMode)$\|^mcp__plugin_sub-human_room__` | `hooks/consent.js` | 10 s | — |
| PostToolUse | `Agent\|Task` | `hooks/row-map.js` | 10 s | — |
| PostToolUse | `AskUserQuestion\|EnterPlanMode\|ExitPlanMode` | `hooks/consent.js` | 10 s | — |
| PostToolUse | `TaskCreate\|TaskUpdate` | `hooks/tasks.js` | 10 s | — |
| PermissionRequest | `ExitPlanMode` | `hooks/consent.js` | 10 s | — |
| Stop | (all) | `hooks/consent.js` | 10 s | — |
| SubagentStop | (all) | `hooks/row-hold.js` | 10 s | — |
| SessionStart | `startup\|resume\|clear\|fork` | `hooks/row-launcher.js` | 10 s | async |
| SessionStart | `compact\|clear\|resume` | `hooks/session-restore.js` | 10 s | — |
| SessionStart | `resume` | `hooks/row-rewake.js` | 30 s | asyncRewake |
| SessionEnd | (all) | `hooks/session-end.js` | 5 s | — |
| Notification | `idle_prompt\|permission_prompt` | `hooks/presence.js` | 10 s | async |
| StopFailure | (all) | `hooks/presence.js` | 10 s | async |
| TaskCompleted | (all) | `hooks/tasks.js` | 10 s | — |
<!-- /gen:hooks -->

### MCP tools (generated)

<!-- gen:mcp-tools -->
Full names are `mcp__plugin_sub-human_room__<tool>`.

| Tool | Server (module) | readOnly | Description |
|---|---|---|---|
| `post` | room (`mcp/room-server.js`) | no | Post a note to the shared sub-human room as your human's Claude (labelled as yours, never as their words). |
| `read` | room (`mcp/room-server.js`) | yes | Read the shared sub-human room log: with ids, those entries in full (e.g. a cut-off line); without, your unseen entries, oldest first, at most 100. |
| `propose` | room (`mcp/room-server.js`) | no | Ask people in the sub-human room to agree to a plan or decision (exactly one of text or path). |
| `hold` | room (`mcp/hold.js`) | yes | Internal to sub-human row agents (sub-human:participant with member, sub-human:room with room). |
| `task` | room (`mcp/task.js`) | no | Ask the sub-human room's orch to change the shared room task list; it is queued and the orch applies it. add needs subject; claim, release and done need id; done also needs evidence. |
<!-- /gen:mcp-tools -->

`hold` is allowed only for row subagents (the guard checks `agent_id`); `task` is refused for the orch, which applies requests natively.

## The room store

Everything persistent goes through the **RoomStore** interface in `lib/room/store.js` (the header there is the full contract). `lib/room.js` wraps it: `room.open(code) → Room` (cached per code, no process-wide state) adds lanes, rendering and validation on top. No module outside `lib/room/store*.js` knows a room's file names (`test/store-bypass.test.js`).

```
RoomStore
  append(entry, {via, from, system, provisional}) -> Entry     validate, then id/at/prev/sig under the log lock
  readAll() readById(ids) readAfter(id) since(id) lastId() readView({after}) watch(fn) tailer()
  validateChain()  verifyChain({fromOffset})                    the prev hash chain (incremental via log.idx)
  getCursor(reader) setCursor(reader, id)                       per-reader positions
  members.read() members.update(fn)                             atomic: lock locally, CAS remotely
  blobs.put/get/has/ref/localPath                               plans/<hash>.md, room-relative refs
  kv.get/set/update/delete/list/lock                            small derived documents
  lock(name, fn)                                                room-wide mutex (proposal answers)
```

**FsRoomStore** layout. The home is `$SUB_HUMAN_HOME` or `~/.sub-human`; room directories are 0700 and files 0600.

| Path (under `<home>/rooms/<CODE>/` unless absolute) | Owner (writer) | Purpose |
|---|---|---|
| `log.jsonl` | `store.append` (hooks, MCP server; never the CLI) | append-only room log, one JSON entry per line, hash-chained |
| `log.idx` | `verifyChain` / `readView` | checkpoint: offset, last id, hash, and offsets of every non-chat line |
| `members.json` | `identity.join/leave/heartbeat`, `orch.*` via `members.update` | seats (`pid`, `pid_start`, `session_id`, `seen_at`, `left_at`) and the orch record (`job`, `claim`, `closing`) |
| `plans/<hash>.md` | `lib/proposal.create` | proposal text, addressed by sha256/12 of its bytes |
| `tasks.json` (kv `tasks`) | `hooks/tasks.js` (orch only) | the task mirror: `tasks.fold()` of the log's `task` entries |
| `presence/<name>.json` | `hooks/presence.js`, at-room, join, restore | working / idle / permission / error, for row text |
| `rows/<session_id>.json` | `hooks/row-map.js` | agent id → row (kind, name, parent) for the status line |
| `rows/holds-<name>.json` | `mcp/hold.js` | which rows this seat's hold server is holding (row-guard, rewake) |
| `rows/blocks-<agent>.json` | `hooks/row-hold.js` | SubagentStop block counter |
| `rows/notices-<name>.json` | `lib/notices.js` | join/leave lines already shown |
| `members/<name>/review.json` | `hooks/consent.js` (under its lock) | plan-view review phase, mode and plan-file backup |
| `members/<name>/title.json` | `hooks/at-room.js` | session title already set |
| `<reader>.cursor` | each reader | `tail-NAME` (monitor), `ctx-NAME` (pull digest), `notice-NAME`, `read-NAME` (CLI), `mcp-NAME` (`read` tool) |
| `*.lock` | `lib/lock.js` | O_EXCL lockfiles, body `PID HOST START`; stale ones broken atomically |
| `<home>/keys/<CODE>/<name>.key`, `.pub` | `hooks/seat-key.js` | Ed25519 seat key pair (dir 0700) |
| `<home>/sessions/by-pid/`, `by-sid/` | `lib/identity.js` | which seat a local claude pid / session id holds (machine-local, not room state) |
| `<home>/bin/row-status`, `roots.json` | `hooks/row-launcher.js` | the status-line launcher and the plugin roots it may run |

**MemoryRoomStore** (`test/support/memory-store.js`) is a second implementation that keeps a room in memory and implements `members.update` as a compare-and-set retry loop, as a remote store would. It shares `store.prepare` / `store.buildEntry`, so ids, chain and signatures are byte-identical. `test/store-contract.test.js` runs one suite against both. That is the **remote seam**: a store that keeps rooms off-machine implements the same interface (`store.setBackend(factory)` swaps it in). The seat private keys stay local whatever the store; liveness falls back to the `seen_at` lease when there is no local pid to check.

## Entries and `via`

An entry is `{id, at, from, via, kind, text?, prev, …kind fields}`. `id` is monotonic, `prev` is `hash12` of the previous line, `from` comes from a trusted caller that resolved identity (never from env or the model). `lib/room/validate.js` decides which `via` may write which kind:

| via | Kinds | Written by |
|---|---|---|
| `human` | `say`, `signoff`, `objection`, `proposal` | hooks only: `@room` (at-room.js), the plan view / card answers (consent.js) |
| `agent` | `say`, `question`, `status`, `proposal`, `task_req` | the MCP server (`post`, `propose`, `task`) on behalf of a member's Claude |
| `system` | `decision`, `member_joined`, `member_left`, `retract`, `task`, `status` | hooks and the reaper, with `{system: true}` |

**Signing.** Every hook process runs `seat-key.arm()`, which installs a signer. `append` with `via=human` requires it: the entry gets `room` and `sig` (Ed25519 over the line without `sig`). The MCP server, CLI and monitor never load `seat-key.js` (`test/security.test.js`), so they cannot write `via=human`; the store refuses. Readers call `store.humanTrust(e)`: `verified`, `legacy` (unsigned, from a seat that has no key), or `unverified` (shown as `bob (unverified): …`, never counted for consent or tasks).

**Hash chain and `log.idx`.** `verifyChain` checks the chain incrementally from the `log.idx` checkpoint, which is trusted only while the line before its offset still hashes to the stored hash; otherwise it rebuilds from byte 0. The checkpoint also records the offset of every non-chat line, so `readView({after})` returns everything that decides lanes (proposals, answers, joins, tasks, retracts) plus the entries after `after`, without parsing the whole log. The monitor runs `verifyChain` on its health tick and prints one `room log check: …` line per break. The chain makes edits around the store visible; it does not prevent them.

**Provisional posts.** When a UserPromptSubmit payload carries no `source`, an `@room` post is appended `provisional` and a detached checker reads the transcript; if a peer session sent it, the checker appends a `retract`. Digests skip provisional entries younger than the check window, and the monitor's settle (1.5 s) is longer than the window (1.2 s).

## Lanes and settle batching

`lane(me, e, entries)` (`lib/room/lanes.js`) says whom an entry concerns:

- **push**: wake now. The monitor prints it (one Claude Code monitor event, one short model turn). Examples: a person's own words (group chat), anything `to` me or mentioning `@me`, a proposal naming me that I have not answered, an objection to my proposal, a task request (orch only).
- **pull**: no wake. `hooks/at-room.js` adds it to "Room since your last turn" on the next prompt (cursor `ctx-NAME`).
- **none**: my own posts, retracted entries.

The tail batches push entries in a `Batcher` (`lib/tail.js`): flush after `SETTLE_MS` 1500 of quiet or `SETTLE_MAX_MS` 5000 after the first (orch: 3000 / 10000), so a burst costs one turn. Each entry is judged again at flush time against `readView`, so an entry answered, decided or retracted in the meantime is dropped. A `member_left` is held `LEAVE_SETTLE_MS` 8000 so a quick leave and rejoin shows nothing. A member's batch is group-chat lines without ids, plus `(for Claude)` lines; the orch's batch starts with `stateLine()` and keeps ids. All timings live in `lib/config.js` with `SUB_HUMAN_*` overrides.

## Consent

```
propose tool (via=agent)          ──► proposal {hash, approvers, path=plans/<hash>.md}
                                        │ push lane to each approver
approver's Claude: EnterPlanMode ──► consent.js Pre: allow silently, review.json {phase: entering, mode}
                   ExitPlanMode  ──► consent.js Pre: back up plan file, write proposal text there, ask
                                        │ native plan view (scrollable), the person answers
   "Yes …"                        ──► Post(ExitPlanMode): signoff via=human (only if text unedited); restore plan file + mode
   "Tell Claude what to change"   ──► next ExitPlanMode: cc.planFeedback(transcript) → objection via=human, note byte-exact;
                                      PermissionRequest: allow with setMode (no dialog), records nothing
   Esc                            ──► nothing; Stop / next prompt / restore close the review
fallback (already in plan mode, bypass/dontAsk, clear-context-on-accept, >200k chars):
   AskUserQuestion card           ──► Post(AskUserQuestion): signoff | objection via=human (Not yet, AFK, stale hash: nothing)
every approver answered           ──► lib/proposal.record appends decision via=system
```

`lib/consent.js` `fold(entries)` is the one interpretation of the log, used by `stateLine`, `lane`, the rows and the gate, so they cannot disagree: the latest proposal entry per hash wins; per person the latest trusted `via=human` answer wins (an objection voids an earlier signoff); retracted entries count for nothing; a decision closes the hash with state `agreed` or `blocked`. `test/hooks/consent-table.test.js` feeds one table to all views.

## Tasks

```
member's Claude ─ task({op, …}) ─► task_req (via=agent, by=member)   push lane to the orch only
orch ─ TaskCreate/TaskUpdate (metadata {req, by}) ─► native list sh-CODE under <claude config>/tasks/
hooks/tasks.js PostToolUse ─► task entry (via=system, full snapshot) ─► tasks.json = tasks.fold(task entries)
hooks/tasks.js TaskCompleted ─► tasks.gate(): exit 2 unless the owner asked done with evidence
```

- The orch's **native task list is the ledger**: `CLAUDE_CODE_TASK_LIST_ID=sh-CODE`, passed through `--settings` env because the bg daemon filters the caller's env (`cc.DAEMON_ENV_ALLOW`). The plugin never writes under `~/.claude`.
- **`metadata.req`** links a native task to the `task_req` it applies. The TaskCompleted input carries no metadata, so the gate reads the task file (which still shows the old status).
- **`tasks.json` is a pure fold** of the log's `task` entries: delete it, refold, same file. Rows and `sub-human tasks` read only it.
- **The gate**: only the owner's own `done` request with evidence after the last claim (or a trusted human entry from the owner citing it) passes. A blocked TaskUpdate drops every field in that call, so the orch is told to change status in a call of its own. Task 1, "room CODE open", stays open until the room is closing, which keeps the native list from being wiped.

## Identity and liveness

- **Binding.** `/sub-human NAME [CODE]` triggers `hooks/join.js` (UserPromptExpansion) before the model runs. It writes the seat into `members.json` and the indexes `<home>/sessions/by-pid/<CLAUDE_PID>.json` and `by-sid/<session_id>.json`. The model never names itself.
- **Resolution.** Hooks: payload `session_id`, then `CLAUDE_PID`. MCP server: `process.ppid` (MCP servers get no `CLAUDE_PID`). CLI and monitor: `CLAUDE_CODE_SESSION_ID`, then `CLAUDE_PID`, then the nearest registered ancestor. `/clear` changes the session id but not the process: `session-restore.js` rebinds the new id to the seat found by pid. `--resume` is a new process with the old id: it rebinds the pid or rejoins the seat.
- **Liveness.** `seatAlive(m)`: not left, and the pid is alive with a start time equal to the stored `pid_start` (so a reused pid never keeps or adopts a seat). A seat with no pid is alive while its `seen_at` lease is fresh (`SEAT_LEASE_MS` 120 s); the tail's health tick and the hold server renew it at most every `SEAT_BEAT_MS` 30 s.
- **Address.** `NAME.CODE` is set as the session title, which is what `SendMessage` and `ListAgents` use.

## Orch lifecycle

```
join (no live orch) ─► claimSpawn: members.orch = {job:"pending", claim}  (under the members lock; a concurrent join sees it)
                    ─► startDetached ─► spawn(): claude stop <prevJob>; claude --bg …; find job in `claude agents --json`
                                         record {job} only if the claim is still current and the room is not closing
orch session ─► /sub-human ─► join.js binds the "orch" seat (agent_type orchestrator + SUB_HUMAN_ROOM)
             ─► TaskCreate "room CODE open"
last member SessionEnd ─► reap (detached): grace 10 s (a rejoin cancels) ─► set closing ─► status to orch
                          "room closed: complete task 1" ─► wait ≤ 20 s ─► claude stop <job> ─► orch seat left
crashed members (no SessionEnd) ─► orch tail health tick: watchdog() sees no live member for 60 s ─► closing + reap
```

`needsSpawn` also respawns an orch whose pid is dead, whose claim is older than `ORCH_CLAIM_MS`, or which never bound within `ORCH_BIND_MS`. `openRooms()` ignores rooms where only the orch is left, and join sweeps those through the watchdog.

## Security model

One machine, one OS user, trusted collaborators. The threat is a member's Claude (possibly steered by text posted in the room) speaking or consenting as a person. Defences: `via=human` only from hooks, signed with a key only hook processes load; the store guard (`hooks/guard.js`) denies file-tool writes into the store and Bash commands that name it, set `SUB_HUMAN_HOME` or run the plugin's modules; `source` and the forgery check refuse peer-injected `@room` prompts; consent only from the native dialog. Not covered: the `Read` tool, other MCP servers, a hostile local user. Full list: [README → Threat model](../plugin/sub-human/README.md#threat-model).

## Claude Code contract (generated)

Every internal the plugin relies on, from `lib/cc.js` `CONTRACT`. `§` points into [`docs/internals/cc-2.1.281.md`](internals/cc-2.1.281.md) (changes since: [`cc-2.1.292.md`](internals/cc-2.1.292.md)); each entry also carries the literal binary search strings, and optional code shapes (`~` for a minified identifier), that `npm run probe` checks.

<!-- gen:cc-contract -->
| Id | § | Stability | Note |
|---|---|---|---|
| `task-completed-block-drops-fields` | §1 | incidental | A TaskCompleted block makes TaskUpdate return success:false, updatedFields:[] before the write: every field in that call (subject, metadata, owner) is discarded. |
| `hook-exit2-blocks` | §1 | API | Exit 2 makes stderr the blockingError. |
| `hook-json-block` | §1 | API | {"decision":"block","reason"} is a blockingError. |
| `hook-missing-script` | §1 | incidental | Stop/SubagentStop/TaskCompleted/TeammateIdle (and plugin UserPromptSubmit): exit 2 with empty stdout and "no such file\|can't open" stderr is non-blocking. |
| `task-completed-input` | §1 | API | TaskCompleted input has no metadata/owner/status; read the task file (which still has the old status). |
| `task-events-no-matcher` | §1 | API | TaskCreated/TaskCompleted/TeammateIdle have no matcher query: every hook fires. |
| `task-completed-teammate-stop` | §1 | incidental | Agent teams: a teammate Stop fires TaskCompleted per owned in_progress task. |
| `task-created-block-deletes` | §1 | API | A TaskCreated block deletes the task and throws. |
| `task-update-schema` | §1 | API | TaskUpdate metadata merges; null deletes a key. |
| `task-create-metadata` | §1 | API | TaskCreate accepts metadata. |
| `env-child-session` | §2 | env | Hooks, Bash, statusLine, subagentStatusLine and monitors get CLAUDE_PID and CLAUDE_CODE_SESSION_ID (cc.ENV, sessionId, claudePid). |
| `env-mcp-session` | §2 | env | MCP stdio servers get CLAUDE_CODE_SESSION_ID (fixed at spawn) but not CLAUDE_PID. |
| `env-plugin-mcp` | §2 | env | Plugin MCP servers get CLAUDE_PLUGIN_ROOT/DATA in env. |
| `env-clear-session-id` | §2 | incidental | /clear updates process.env.CLAUDE_CODE_SESSION_ID; running monitors/MCP servers keep the old id. |
| `env-nested-strip` | §2 | incidental | A nested claude drops CLAUDE_CODE_SESSION_ID from its env. |
| `hook-input-common` | §2 | API | Common hook input: session_id, transcript_path, cwd, prompt_id?, permission_mode?, agent_id?; no pid. |
| `pkill-guard` | §2 | incidental | Bash pkill wrapper refuses patterns matching CLAUDE_PID. |
| `plan-mode-attachment` | §3 | incidental | Transcript attachment {type:"plan_mode", planFilePath} (cc.planFile). |
| `exitplan-normalize` | §3 | API | Pre/PermissionRequest hooks on ExitPlanMode see tool_input.plan and planFilePath. |
| `exitplan-strip` | §3 | incidental | plan/planFilePath are stripped before the transcript copy (cc.toolUseInput reads the model's own input). |
| `exitplan-output` | §3 | API | PostToolUse(ExitPlanMode) fires only on approval. |
| `plan-reject-dialog` | §3 | incidental | "No, keep planning" returns deny with the typed feedback. |
| `plan-reject-user-feedback` | §3 | incidental | The rejected tool_result transcript entry carries top-level userFeedback (cc.planFeedback). |
| `plan-reject-text` | §3 | incidental | Fallback: the note sits between "the user said:\n" and "\n\nNote: The user's next message". |
| `permission-denied-auto-only` | §3 | incidental | PermissionDenied fires only for auto-mode classifier denials; no hook carries a user rejection note. |
| `clear-context-setting` | §3 | API | showClearContextOnPlanAccept: the clear-context approve fires no PostToolUse (cc.clearContextOnPlanAccept). |
| `task-list-id` | §4 | env | List id: env, team, teammate team, leader team, else session id (changes on /clear). |
| `task-path` | §4 | incidental | <configDir>/tasks/<sanitized list>/<sanitized id>.json (cc.tasksDir, cc.taskFile). |
| `config-dir` | §4 | env | CLAUDE_CONFIG_DIR replaces ~/.claude (cc.configDir). |
| `task-store-v5-off` | §4 | env | The experimental key-value task backend is off by default; files are the store. |
| `todo-tools-gate` | §4 | env | Newer models need CLAUDE_CODE_ENABLE_TODO_TOOLS for Task tools; bg sessions get them anyway. |
| `bg-dispatch-line` | §5 | incidental | `claude --bg` stdout line 1 is "backgrounded · <short> · <name>" (cc.JOB_RE). |
| `agents-json` | §5 | API | `claude agents --json [--all]` prints [{pid?, id, sessionId, status, state, ...}] (cc.jobs). |
| `bg-stop` | §5 | API | `claude stop <id>` (cc.stopCmd). |
| `bg-logs` | §5 | API | `claude logs <id>` (cc.logsCmd). |
| `daemon-env-filter` | §5 | env | The daemon keeps only allowlisted caller env keys (cc.DAEMON_ENV_ALLOW). |
| `daemon-env-allowlist` | §5 | env | The pieces of the daemon allowlist (zWe + dWn + extras in 2.1.292) that DAEMON_ENV_ALLOW copies. |
| `bg-worker-env` | §5 | incidental | Workers run with the daemon's own process.env plus the filtered dispatch env. |
| `bg-provider-env` | §5 | incidental | Persisted providerEnv is filtered through p0e too. |
| `monitor-schema` | §6 | API | Monitor `when`: "always" or "on-skill-invoke:<skill>"; name is the dedupe key. |
| `monitor-location` | §6 | incidental | manifest.experimental.monitors or manifest.monitors, else monitors/monitors.json. |
| `monitor-arm-gates` | §6 | incidental | Arming is skipped by policy, the tengu_amber_sentinel gate, -p, managed disableAllHooks, or untrusted workspace. |
| `monitor-not-rearmed` | §6 | incidental | A monitor that exits is not re-armed until the claude process restarts (in-process /resume and /clear do not re-arm). |
| `matcher-rule` | §7 | API | Exact-name list vs unanchored regex (cc.matcherIsExact, cc.matcherMatches). |
| `hook-if` | §7 | API | `if` uses permission-rule syntax; Task tools can only be filtered by bare name. |
| `hook-async` | §7 | API | Per-hook async/asyncRewake fields. |
| `hook-timeout-default` | §7 | API | Default hook timeout 600000 ms (cc.HOOK_TIMEOUT_DEFAULT_MS). |
| `stop-additional-context` | §7 | incidental | Stop hookSpecificOutput.additionalContext continues the turn with that text, like a block but without the red "Stop hook error" line or notification (only real blockingErrors get those). |
| `session-end-budget` | §7 | env | SessionEnd budget: env override, else max hook timeout clamped to [1500, 60000] ms (cc.sessionEndBudgetMs). |
| `peer-envelope` | §8 | incidental | <cross-session-message from from-session hop-chain from-name from-mode from-plugin> in that order (cc.parseEnvelope). |
| `peer-held-prefix` | §8 | incidental | Held/mid-turn peer deliveries start with this prefix (cc.isPeerText). |
| `peer-origin` | §8 | incidental | Transcript user entries from peers carry origin.kind "peer" (cc.entryIsPeer). |
| `ups-source` | §8 | API | UserPromptSubmit source "system" for peers, channels, task notifications (cc.isPeerPrompt). |
| `prompt-origin-composer` | §8 | incidental | prompt.submit origin "composer" is only the person's own Enter (and a --bg dispatch prompt); -p is "sdk", peers "peer" (also from $.session.send), notifications "task-notification". No hook sets it (MODS-PLAN W0 S2, S6). |
| `cross-session-inbound` | §8 | API | crossSessionInbound accept\|hold\|refuse; the orch sets accept. |
| `harbor-kite-gate` | §8 | env | Cross-session messaging gate (default on). |
| `task-notification-prompt` | §8 | incidental | Monitor/background notices arrive as prompts starting <task-notification> (cc.isTaskNotification). |
| `pasted-content` | §8 | incidental | Long pastes are wrapped in <pasted_content id="N"> (cc.PASTED_RE). |
| `plugin-settings-allowlist` | §9 | API | Plugin settings.json keeps only agent and subagentStatusLine. |
| `subagent-statusline-precedence` | §9 | incidental | Any user/project/local/flag subagentStatusLine overrides the plugin's. |
| `plugin-setting-override-log` | §9 | incidental | Last plugin loaded wins a shared setting. |
| `subagent-statusline-raw` | §9 | incidental | subagentStatusLine command gets no ${CLAUDE_PLUGIN_ROOT} substitution nor PLUGIN_ROOT/DATA env. |
| `hook-events` | §10 | API | The hook event list; no plan-approved/rejected event. |
| `hooks-modules` | §10 | env | Function hooks load for installed plugins by default (GrowthBook tengu_plugin_hooks_modules, default on). An installed plugin names its module in hooks.json `modules`; "hooks/register.ts" is only the built-in plugins' fixed path. sub-human ships none yet (docs/next/MODS-PLAN.md W1 adds one). |
| `hooks-json-modules` | §10 | API | One hooks.json carries the command hooks and one module path under `modules` (relative to hooks.json); a second module is refused (S1). |
| `module-dollar-local` | §10 | incidental | A module that passes $ to an imported function does not load (validate says the same): every $ call sits in the file that registers the hook, so mod/core/*.mjs stays $-free (S1). |
| `modules-headless` | §10 | env | Modules are off only diskless or in a tool server's daemon (then by policy, safe mode, --bare): they load in -p and in a --bg worker such as the orch. A --bg dispatch prompt reaches prompt.submit as origin composer (S2). |
| `classic-chain-order` | §10 | incidental | A module's classic.<Event> hook runs above the plugin's own command hooks for that event; one that answers without next() means the command hooks beneath do not run (S1, S5). |
| `prompt-submit-ups-order` | §10 | incidental | prompt.submit's core runs the UserPromptSubmit hooks: prompt.submit (module) -> classic.UserPromptSubmit (module) -> the command hook. A peer delivered mid-turn takes the same path, with turnId set (S6). |
| `usermessage-draw-only` | §10 | incidental | A ui.render rewrite of UserMessage text changes only the drawing; origin, isExpanded, task and from are pinned. |
| `session-append-note` | §10 | incidental | $.session.append writes a user row as isMeta (the model reads it from the loop's next top; an idle session is not woken) and a system row as a notice the model never reads (S4). |
| `session-append-notice-hidden` | §10 | incidental | A $.session.append system row is stored at level "info": drawn only in the ctrl+o transcript view (also after --resume), never in the default view. Chat lines go through $.ui.log instead (S4). |
| `ui-log-notice` | §10 | incidental | $.ui.log lines are stored as system notices at level "notice": drawn dim as "<plugin>: <text>" in the default view, kept across --resume, never read by the model, no wake (S4). |
| `fs-write-plain` | §10 | incidental | $.fs.write is mkdir -p plus writeFile: not atomic, no mode, no lock. The mod never writes room state. |
| `process-run-stdin` | §10 | API | $.process.run takes argv, stdin, env over the host env and a timeout. The child's parent is the claude process, but it gets no CLAUDE_PID or CLAUDE_CODE_SESSION_ID of this session (only whatever claude itself inherited), so shims pass the payload session_id (S3). |
| `plugin-test-discovery` | §10 | incidental | `claude plugin test` collects every *.test.ts(x) under the plugin; node tests stay *.test.js (S8). |
| `plugin-test-off` | §10 | env | With modules off, `claude plugin test` exits 1 printing "claude plugin test: hooks modules are turned off ..."; npm test reads that as a skip (S8). |
<!-- /gen:cc-contract -->

## Modules (generated)

`lib/` only; each line is the module's header comment, whose full text documents its exports.

<!-- gen:lib-modules -->
- `lib/cc.js`: the single home for every Claude Code internal the plugin relies on.
- `lib/clock.js`: A tiny injectable clock, so code that waits (the `sub-human tail` settle and poll loops) can be tested without real sleeps.
- `lib/config.js`: every timing and size cap in one place, named. Callers import the value they use; an env override is read by the caller through envMs() at the moment it needs the value (tests set the env per child process, some per call).
- `lib/consent.js`: the one fold of the room log into proposal / consent state.
- `lib/home.js`: where the plugin's store lives on this machine. Both lib/identity.js (session indexes) and lib/room/store.js (room state) need it, and identity requires the store, so it lives here rather than in either.
- `lib/identity.js`: where rooms live, who is in them, and which Claude session is asking.
- `lib/io.js`: small file and process helpers shared by every module.
- `lib/lock.js`: the one lockfile helper (room log, members.json, proposals, the task mirror, the row map).
- `lib/notices.js`: join / leave lines for every human in the room, as a group chat shows them: "bob joined", "bob rejoined", "bob left" (no room code, no ids).
- `lib/orch.js`: the room's headless orchestrator, a `claude --bg` session the join hook starts.
- `lib/proposal.js`: proposals and the consent card. Every write goes through room.append().
- `lib/room.js`: the room log (envelope v3). A facade over lib/room/*, so callers keep one require.
- `lib/room/lanes.js`: who a log entry concerns, and the proposal queries that decide it.
- `lib/room/render.js`: log entries as text, for Claude (ids kept) and for people (no ids).
- `lib/room/store.js`: the RoomStore seam, and FsRoomStore, its implementation over the room directory on this machine.
- `lib/room/validate.js`: the room log's envelope rules (envelope v3): which kinds each `via` may write, the fields a caller may set, and the task fields of task_req / task entries. append() (store.js) runs validate() before it takes the log lock.
- `lib/rows.js`: participant rows in the agent panel. Reads the room log, members and presence; writes only the rows/* documents (lib/room/store.js kv).
- `lib/tail.js`: the room monitor behind `sub-human tail` (bin/sub-human documents what it prints).
- `lib/tasks.js`: the room's shared task list. The headless orch's own native task list (CLAUDE_CODE_TASK_LIST_ID=sh-CODE) is the room's list.
- `lib/text.js`: the string helpers and name patterns every module shares.
<!-- /gen:lib-modules -->

Elsewhere: `hooks/common.js` (shared hook plumbing: `readInput`, `resolveSeat`, output helpers), `hooks/seat-key.js` (the signer), `bin/sub-human` (the read-only CLI and the monitor entry), `statusline/` (row text), `agents/` (`orchestrator`, `room`, `participant`), `skills/sub-human/` (the join skill and the role texts the hooks inject).

## Performance

Everything is a `node` start, so the number of processes per event is the main cost (from the hook map above):

| Event | Node starts |
|---|---|
| a prompt | 1 (`prompt.js`) + 1 at turn end (`consent.js` Stop) |
| `Bash`, `Write`/`Edit` | 1 (`guard.js`; Bash takes a fast path that loads only `lib/identity.js`) |
| a room MCP tool | 2 (`guard.js`, `consent.js`) |
| `Agent`/`Task` | 2 (`row-guard.js`, `row-map.js`) |
| `ExitPlanMode` during a review | up to 3 (Pre, PermissionRequest, Post) |
| other tools (`Read`, `Grep`, …) | 0 |

Long-lived per session: the monitor and the MCP server (one idle `node` each). Measured in the audit waves: the at-room hook at **36 ms with a 100k-entry log** (was 243 ms before `log.idx` and tail-only reads), `append` **1.8 ms**. `append` reads only the log's tail for `id` and `prev`; readers keep a per-file cache and parse only appended bytes.

## Testing

- `npm test`: `node --test` over `plugin/sub-human/test` (each file in its own process, in parallel; `test/helpers.js` strips `CLAUDE*` env and removes temp dirs) and `scripts/test`. Hooks are driven as child processes with JSON payloads (`test/hooks/`). The tail runs on a fake clock (`lib/clock.js`).
- **Store contract**: `test/store-contract.test.js` runs one suite against `FsRoomStore` and `MemoryRoomStore`; `store-bypass.test.js` checks nothing else touches room files; `security.test.js` checks who can load the signer.
- **Probe**: `npm run probe` (`scripts/probe-cc.js`) greps the installed Claude Code binary for every `CONTRACT` search string and shape; `test/cc.test.js` runs it when a binary is present. No search names a minified identifier (shapes use `~` instead), so a miss means the code itself changed: re-read that spot and record what changed in a new `docs/internals/cc-<version>.md`.
- **Docs**: `npm run docs` regenerates this file's tables; `scripts/test/arch-doc.test.js` fails when they are stale.
- **Demo**: `scripts/demo.sh` drives scenes S1–S10 with real sessions in tmux (real cost; run only when asked). `scripts/checks.js` then labels each check **deterministic** (log, chain, files, panes: a failure exits 1) or **behavioural** (model-call counts, wakes, noise: compared against `scripts/baselines.json` thresholds, warn only). `scripts/walkthrough.js` builds `docs/rebuild/walkthrough.html`.
- `npm run validate`: `claude plugin validate plugin/sub-human --strict`.
