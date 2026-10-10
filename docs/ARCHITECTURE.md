# Architecture

How sub-human works today, for a new contributor or a fresh Claude session. User-facing behaviour is in [`plugin/sub-human/README.md`](../plugin/sub-human/README.md); the Claude Code internals behind it are in [`docs/internals/cc-2.1.281.md`](internals/cc-2.1.281.md), with the 2.1.292 changes in [`docs/internals/cc-2.1.292.md`](internals/cc-2.1.292.md). Sections marked *generated* are rewritten by `npm run docs` (`scripts/arch-doc.js`) from the code; edit the code, not the table. `npm test` fails when they are stale.

## Purpose and design rules

Several people, each in their own Claude Code session, share a **room**. The room lives on one machine (its host); people on other machines join it over a link (see [Remote rooms](#remote-rooms)). A person's exact words reach the room only through a hook (`@room …`, or `@claude …`, which also wakes the room's Claude: a post `to=claude`). Claudes talk to each other with native `SendMessage`, addressed `NAME.CODE`. A headless **room Claude** keeps the shared task list and plans only when asked. Consent to a proposal is recorded only from the person's own answer in a native dialog.

The one security goal: **a model can never speak or consent as a person.** The rules that follow from it, and from keeping the plugin unobtrusive (also in `CLAUDE.md`):

- Never pin a model (agents, the room's Claude spawn, the demo, tests).
- No writes to user settings files and no symlinks into `~/.claude`. The plugin keeps its own home and uses the native task list.
- The room's Claude takes no typed input. People reach it with `@claude …` or through their Claude.
- Keep the agent-panel rows (the room row with members nested in it; the room Claude's panel lists every human).
- Consent is native: plan view first, question card as fallback; only `via=human` answers count.
- Unprescriptive: no required workflow; injected text covers mechanics only.
- Every undocumented Claude Code behaviour relied on is listed in `lib/cc.ts` and checked by `npm run probe`.
- Zero dependencies, Node 24.3+, macOS/Linux. The runtime is ESM TypeScript with no build step (see [TypeScript](#typescript)); the tests and repo `scripts/` are CommonJS JavaScript, except the module's wiring tests (`mod/test/*.test.ts`), run by `claude plugin test`.

## Process model

```
 member session (claude, interactive)                    the room's Claude (claude --bg, one per room)
 ┌──────────────────────────────────────────┐            ┌───────────────────────────────────────┐
 │ main thread (the person's Claude)        │ SendMessage│ main thread: agent sub-human:room-claude
 │   spawns ─► room row  (agent room, bg)   │◄──────────►│   spawns ─► participant row per human  │
 │               spawns ─► participant rows │            │   native task list = the room's list   │
 │ hooks: command hooks + one hooks module  │            │ hooks: the same, module included       │
 │ tail child: scripts/sub-human tail (module)  │            │ tail child (formatter + watchdog)      │
 │ MCP: mcp/room-server.ts (+hold, +task)   │            │ MCP: its own room-server.ts            │
 │ subagentStatusLine: <home>/bin/row-status│            └───────────────────────────────────────┘
 └──────────────┬───────────────────────────┘                             │
                │          all read/write through lib/room/store.ts       │
                └────────────────► <home>/rooms/<CODE>/ ◄─────────────────┘
```

Per session, Claude Code starts:

- **Hooks** (`hooks/*.ts`): short synchronous `node` processes, one per matching hook entry. Only hook processes hold the seat signing key. Identity comes from the payload's `session_id` in the hooks, in `mod-hello.ts` (the module passes it on stdin) and in the tail child (the module sets its `CLAUDE_CODE_SESSION_ID`); see Identity and liveness. `prompt.ts` runs both UserPromptSubmit handlers (at-room, consent) in one process. The hooks module (`mod/register.ts`) runs in-process: the store guard, the prompt gate, and shims that start `prompt.ts`, `consent.ts` (Stop), `tasks.ts`, `presence.ts` ("working" on a typed prompt) and `mod-hello.ts` (the hello, below) with `$.process.run` only when they can act (table below).
- **The tail child** (`mod/deliver.ts` starts `scripts/sub-human tail --ndjson` → `lib/tail.ts` with `$.process.spawn`): one per seated session, for the session's life, restarted with backoff if it exits. It follows the seat's room and writes one JSON event per line, which the module routes: `chat` → `$.ui.log` (a dim notice the person sees; no model turn), `pull` → an isMeta user row the model reads with its next request, `wake` → `$.prompt.submit` (origin `plugin`; folded into a running turn instead when busy), `rows` → held for the person's next prompt. It is the seat's only delivery, which is why a seat needs the module: `join.ts` refuses without its hello lease. A line is sent at most once (the tail's cursor moves when the line is written). A wake whose submit is dropped by a hook or fails falls back to the isMeta append, and when that fails too it is held and appended at the next `turn.start`, so it arrives once; its room lines (not the `(for Claude)` ones) are then logged as notices, since no prompt row shows them. Every delivery failure (an event not applied, a child that exited or did not start, a wake nothing took) adds to `$.state` `deliveryErrors` and shows one dim notice, at most every 5 min: "a room message could not be delivered; `sub-human read` shows the room".
- **Remote Control.** The bridge carries a session's user and assistant rows and a command hook's `systemMessage` to the phone, never a `$.ui.log` notice, and an isMeta row goes as synthetic (cc CONTRACT `bridge-forwarded-rows`); a function hook's result has no `systemMessage`. So while the person's last typed prompt came through Remote Control (prompt.submit origin `bridge`; `composer` or `sdk` turns it off), what a notice would show is **relayed** as a prompt of its own: room chat lines, and an `@room`'s refusal (at-room writes it as `systemMessage`; "✓ sent" is not relayed). A relay is only the lines the person reads (`alice: hi`, `room: "Rate limiting" agreed (bob)`), submitted `asUser` so Claude Code adds no "plugin sent a message" frame (CONTRACT `plugin-prompt-frame`); what the model needs (`RELAY_CONTEXT`: room lines, not the person's words; a few words of reply at most, or none) is context the phone does not show, and no node runs for it. Relays are batched (`relayQueue`): queued lines go as one prompt once idle (held through a running turn), at most one per `RELAY_GAP_MS` (3 s), on top of the tail's own settle. A relay is still a model turn: the price of the phone seeing the room. Command hooks need nothing: the join's and consent's refusals are `systemMessage`s, which the bridge forwards. The signal is the last typed prompt, so a person who only reads on the phone gets relays after they type there once.
- **The MCP server** (`.mcp.json` → `mcp/room-server.ts`): stdio JSON-RPC, one per session. Its plug-ins `mcp/hold.ts` and `mcp/task.ts` add tools. It resolves the caller from `process.ppid` on every call. It cannot sign `via=human`.
- **Rows**: background subagents that make one blocking MCP call (`hold`) and stream progress, so they cost no tokens while they hold. Their panel text comes from the plugin's `subagentStatusLine` (`settings.json` → `<home>/bin/row-status`, written by `hooks/row-launcher.ts`, which runs `statusline/`).

Who spawns whom:

| Spawner | Spawns | How |
|---|---|---|
| `hooks/join.ts` (first member, or a room with no live room Claude) | the room's Claude | claim under the members lock, then detached `node lib/room-claude.ts start` → `claude --bg -n claude.CODE --agent sub-human:room-claude --permission-mode plan --settings {…} /sub-human` |
| a member's main thread | one `sub-human:room` row | the `Agent` call the join/restore context lists under ROWS |
| a room row | one `sub-human:participant` row per other member | on start, and when `hold({room})` returns `JOINED`/`RESPAWN` |
| the room Claude's main thread | one participant row per human | on a pushed `member_joined` that carries the Agent call |
| the hooks module (`mod/deliver.ts`) | the tail child, per seated session | `$.process.spawn node scripts/sub-human tail --ndjson` |
| `hooks/session-end.ts`, `lib/room-claude.ts` watchdog | the reaper | detached `node lib/room-claude.ts reap CODE` |

`hooks/row-guard.ts` denies a duplicate row spawn; `row-map.ts` records which panel row is which agent; `row-hold.ts` (SubagentStop) tells a row that gave up to hold again; `row-rewake.ts` (SessionStart resume, `asyncRewake`) re-spawns rows after `--resume`.

### Event → hook map (generated)

<!-- gen:hooks -->
| Event | Matcher | Script | Timeout | Async |
|---|---|---|---|---|
| UserPromptExpansion | `^(sub-human:)?sub-human$` | `hooks/compile-cache.js` | 10 s | — |
| PreToolUse | `Agent\|Task` | `hooks/compile-cache.js` | 10 s | — |
| PreToolUse | `^(AskUserQuestion\|EnterPlanMode\|ExitPlanMode)$\|^mcp__plugin_sub-human_room__` | `hooks/compile-cache.js` | 10 s | — |
| PostToolUse | `Agent\|Task` | `hooks/compile-cache.js` | 10 s | — |
| PostToolUse | `AskUserQuestion\|EnterPlanMode\|ExitPlanMode` | `hooks/compile-cache.js` | 10 s | — |
| PermissionRequest | `ExitPlanMode` | `hooks/compile-cache.js` | 10 s | — |
| SubagentStop | (all) | `hooks/compile-cache.js` | 10 s | — |
| SessionStart | `startup\|resume\|clear\|fork` | `hooks/compile-cache.js` | 10 s | async |
| SessionStart | `compact\|clear\|resume` | `hooks/compile-cache.js` | 10 s | — |
| SessionStart | `resume` | `hooks/compile-cache.js` | 30 s | asyncRewake |
| SessionEnd | (all) | `hooks/compile-cache.js` | 5 s | — |
| Notification | `idle_prompt\|permission_prompt` | `hooks/compile-cache.js` | 10 s | async |
| StopFailure | (all) | `hooks/compile-cache.js` | 10 s | async |
<!-- /gen:hooks -->

### Function hooks (generated)

The plugin also ships one hooks module (Claude Code 2.1.292+; [mods plan](archive/MODS-PLAN.md)). Its hooks run in-process, above the command hooks of the same event. `hooks/mod-hello.ts` (run by the module with `$.process.run`, not a hooks.json entry) writes the module's lease `<home>/sessions/mods/<sid>.json` and tells it the home and this session's seat, which it keeps in `$.state`. The module never writes room state. Its pure logic is in `mod/core/*.ts` (node-tested in `test/mod-core*.test.js`), its wiring tests in `mod/test/*.test.ts` (`npm run test:mods`).

- **The lease** holds the claude pid (the hello's parent) and its start time, the time written, and the session's nonce (below). `join.ts` accepts a lease from this claude process, or one written within `MOD_LEASE_FRESH_MS`; `session-end.ts` deletes it, and join's sweep prunes leases whose process is gone. Without one the join is refused with `NO_MODULE`: Claude Code older than 2.1.292, `--bare`, safe mode, hooks modules turned off by policy, or an old session id resumed where the module is off.
- **The hello refresh** runs on `session.start`, after the join and after `classic.SessionStart`. One that fails keeps the last hello (the guard still knows the home) but with `sid` null, as no session's, so every prefilter runs node until a refresh succeeds: a join whose hello failed must not make "no seat" look certain.
- **The tail child's life.** It starts on `session.start` (also after a reload or a lost worker), after the join and after `classic.SessionStart`, unless the hello is sure the session has no seat. A `/clear` runs on under a new session id: the old child is stopped and one is started for the new id; `session.end` stops the child for good. A child that exits is started again after 1 s, doubling to 60 s; one that ran over 60 s before it exited was healthy, and the backoff starts over. It dies with the module (a reload, the session's end): the `$.process.spawn` loop is its life.
- **Mid-turn wakes.** A wake while a main-loop turn runs (a `turn.start` with no `turn.complete` yet) is appended as an isMeta row, and its visible lines are logged. At that turn's `turn.complete` it is submitted after all when no main-loop tool call (`classic.PostToolUse` / `PostToolUseFailure` without `agent_id`) finished after the append: each finished call is followed by a model request, so without one the request then in flight was the turn's last and never carried the row. A wake neither a submit nor an append took is held for the next `turn.start` (at most `PENDING_MAX` 20, newest kept), when the session is evidently running turns again.
- **Presence** has one writer for "working" on a typed prompt: the module (`node hooks/presence.ts`, not awaited). at-room writes it only for an `@room` that came with no origin.
- **`@room` fails closed.** When the prompt shim fails (it throws, times out or exits other than 0 or 2), an `@room` (or, in a seated session, an `@claude`) is blocked with the prompt suppressed, never handed to the model as typed text.
- **The session title** `NAME.CODE` is set once per session id and address, so a switch to another room retitles the session.
- **Copied constants.** `mod/core` keeps copies of a few `lib/` values (restart and notice timings from `lib/config.ts`, the name and code patterns from `lib/text.ts`, chat-line constants from `lib/room/render.ts`). This is deliberate: `mod/` is ESM and imports no CommonJS, and `module-dollar-local` keeps `$` in the registering file anyway. The `test/mod-core*.test.js` equality tests keep the copies in step.

<!-- gen:mod-hooks -->
From `mod/register.ts` (hooks.json `modules`), in registration order.

| Event | Matcher | File | Does |
|---|---|---|---|
| `session.start` | (all) | `mod/deliver.ts` | runs hooks/mod-hello.ts with the session's nonce (minted once per session id into $.state; the lease keeps it; home, plugin root, seat into $.state); unless surely unseated, starts the tail child (node scripts/sub-human tail --ndjson, restarted with backoff; the seat's only delivery) and routes its events: chat -> $.ui.log (typed through Remote Control: relayed as a prompt of only the room lines, asUser, batched one per RELAY_GAP_MS), pull -> isMeta append, wake -> $.prompt.submit (mid-turn: append), rows -> $.state |
| `command.run` | `command sub-human:sub-human\|sub-human` | `mod/deliver.ts` | answers /sub-human itself when typed here (or through Remote Control with no PIN in it; never in the room's Claude): node hooks/join.ts through the shim (sub_human_via, the nonce), then its reply as $.ui.log notices with an empty answer (no row, nothing for the model to read or repeat; through Remote Control a reply with no secret is the command's output {text}), so none reads "blocked by hook"; a join that worked expands as before (next), its mechanics block handed to the expansion hook below, and a one-line confirmation logged; then mod-hello again. .catch passes it on to the classic hook |
| `classic.UserPromptExpansion` | `command_name ^(sub-human:)?sub-human$` | `mod/deliver.ts` | after the join (hooks/join.ts beneath, or the mechanics block of the one command.run took, without running it again), runs mod-hello again for the new seat and starts the tail child |
| `classic.SessionStart` | `source clear\|compact\|resume` | `mod/deliver.ts` | after session-restore beneath (a /clear rebinds the seat to a new session id), runs mod-hello again and starts the tail child for that id; reviewMaybeOpen unsure |
| `session.end` | (all) | `mod/deliver.ts` | stops that session id's tail child |
| `turn.start` | (all) | `mod/deliver.ts` | marks a main-loop turn running (a wake then appends instead of submitting) |
| `turn.complete` | (all) | `mod/deliver.ts` | marks idle; submits a mid-turn wake no request carried (none followed a tool call that finished after it), and schedules the Remote Control relay held during the turn |
| `classic.PostToolUse` | (all) | `mod/deliver.ts` | observes when a main-loop tool call finished (a model request follows it, carrying a mid-turn wake) |
| `classic.PostToolUseFailure` | (all) | `mod/deliver.ts` | the same, for a tool call that failed |
| `tool.call` | `Bash` | `mod/guard.ts` | denies a command that names the store or runs the plugin's code (mod/core/guard.ts bashVerdict); .catch fails closed on "sub-human" |
| `tool.call` | `Write\|Edit\|MultiEdit\|NotebookEdit` | `mod/guard.ts` | denies a write into the store, lexically or after $.fs.stat realPath; .catch fails closed on "sub-human" |
| `tool.call` | `mcp__plugin_sub-human_room__hold` | `mod/guard.ts` | denies hold outside a row subagent (no agentId) |
| `tool.check` | `/^mcp__plugin_sub-human_room__/` | `mod/guard.ts` | allows the room tools for a seated session (no permission prompt); hold only with agentId |
| `prompt.submit` | (all) | `mod/prompt.ts` | a relay of this module's own (mod/deliver.ts) passes with RELAY_CONTEXT as context; drops an @room (or, in a room, an @claude) whose origin is not composer, sdk or bridge (a peer, a notification, a plugin); a typed origin says whether the person is on Remote Control (bridge) or here; hands the origin to the shim below; a typed prompt the tail child delivers for carries the held rows text as context and writes "working" presence (node hooks/presence.ts, not awaited) unless already working; .catch drops only an @room |
| `classic.Notification` | `notification_type idle_prompt\|permission_prompt` | `mod/prompt.ts` | notes the presence presence.ts beneath writes, so the next prompt writes "working" again |
| `classic.StopFailure` | (all) | `mod/prompt.ts` | notes the error presence presence.ts beneath writes |
| `classic.UserPromptSubmit` | (all) | `mod/prompt.ts` | sessionTitle NAME.CODE once per session id (members); no node for a relay, nor when not an @room (or a seated @claude) and surely unseated, or a member's seat the tail child delivers for with no review open; else node hooks/prompt.ts with sub_human_origin and the session's nonce, which at-room checks against the lease (systemMessage via $.ui.log; typed through Remote Control, a refusal is relayed as a prompt after the hook returns) |
| `tool.call` | `EnterPlanMode\|ExitPlanMode` | `mod/consent.ts` | sets reviewMaybeOpen (a room review starts only through these) |
| `classic.Stop` | (all) | `mod/consent.ts` | node hooks/consent.ts (the open-review nudge) only while a review may be open or the seat is unknown |
| `classic.PostToolUse` | `tool_name TaskCreate\|TaskUpdate` | `mod/tasks.ts` | node hooks/tasks.ts (the room task mirror) only for the room's Claude or an unknown seat |
| `classic.TaskCompleted` | (all) | `mod/tasks.ts` | node hooks/tasks.ts (the gate; exit 2 -> block) only for the room's Claude or an unknown seat; .catch blocks in the room's Claude |
| `ui.render` | `UserMessage, origin peer\|peer-send-message\|plugin` | `mod/render.ts` | draws another member's Claude as "bob's Claude: …" and a sub-human prompt as its chat lines, without "(for Claude)" lines |
<!-- /gen:mod-hooks -->

### MCP tools (generated)

<!-- gen:mcp-tools -->
Full names are `mcp__plugin_sub-human_room__<tool>`.

| Tool | Server (module) | readOnly | Description |
|---|---|---|---|
| `post` | room (`mcp/room-server.ts`) | no | Post a note to the shared sub-human room as your human's Claude (labelled as yours, never as their words). |
| `read` | room (`mcp/room-server.ts`) | yes | Read the shared sub-human room log: with ids, those entries in full (e.g. a cut-off line); without, your unseen entries, oldest first, at most 100. |
| `propose` | room (`mcp/room-server.ts`) | no | Ask people in the sub-human room to agree to a plan or decision (exactly one of text or path). |
| `hold` | room (`mcp/hold.ts`) | yes | Internal to sub-human row agents (sub-human:participant with member, sub-human:room with room). |
| `task` | room (`mcp/task.ts`) | no | Ask the sub-human room's Claude to change the shared room task list; it is queued and the room's Claude applies it. add needs subject; claim, release and done need id; done also needs evidence. |
<!-- /gen:mcp-tools -->

`hold` is allowed only for row subagents (the module's guard, `mod/guard.ts`, checks `agentId`); `task` is refused for the room's Claude, which applies requests natively.

## The room store

Everything persistent goes through the **RoomStore** interface in `lib/room/store.ts` (the header there is the full contract). `lib/room.ts` wraps it: `room.open(code) → Room` (cached per code, no process-wide state) adds lanes, rendering and validation on top. No module outside `lib/room/store*.ts` knows a room's file names (`test/store-bypass.test.js`).

```
RoomStore
  append(entry, {via, from, system}) -> Entry                  validate, then id/at/prev/sig under the log lock
  readAll() readById(ids) readAfter(id) since(id) lastId() readView({after}) watch(fn) tailer({after}) lineHash(id)
  validateChain()  verifyChain({fromOffset})                    the prev hash chain (incremental via log.idx)
  getCursor(reader) setCursor(reader, id)                       per-reader positions
  isHost                                                        this machine holds the room (FsRoomStore: true)
  members.read() members.update(fn)                             atomic: lock locally, CAS remotely (room Claude bookkeeping)
  members.join(rec) members.leave(name) members.beat(name, {presence?})   the seat ops (lib/room/members.ts)
  blobs.put/get/has/ref/localPath                               plans/<hash>.md, room-relative refs
  kv.get/set/update/delete/list/lock                            small derived documents
  lock(name, fn)                                                room-wide mutex (proposal answers)
```

**FsRoomStore** layout. The home is `$SUB_HUMAN_HOME` or `~/.sub-human`; room directories are 0700 and files 0600. A mirror (a room hosted elsewhere, `MirrorRoomStore`) has the same layout; its log, `log.idx`, `members.json`, `presence/*`, `tasks.json` and `plans/` are the host's, written only by the link daemon.

| Path (under `<home>/rooms/<CODE>/` unless absolute) | Owner (writer) | Purpose |
|---|---|---|
| `log.jsonl` | `store.append` (hooks, MCP server; never the CLI) | append-only room log, one JSON entry per line, hash-chained |
| `log.idx` | `verifyChain` / `readView` | checkpoint: offset, last id, hash, and offsets of every non-chat line |
| `members.json` | `identity.join/leave/heartbeat` via `members.join/leave/beat`, `lib/room-claude.ts` via `members.update` | seats (`machine`, `seen_at`, `left_at`; for this machine's seats `pid`, `pid_start`, `session_id`, `cwd`) and the room's Claude record (`job`, `claim`, `closing`) |
| `plans/<hash>.md` | `lib/proposal.create` | proposal text, addressed by sha256/12 of its bytes |
| `tasks.json` (kv `tasks`) | `hooks/tasks.ts` (room Claude only) | the task mirror: `tasks.fold()` of the log's `task` entries |
| `presence/<name>.json` | `members.beat` (`hooks/presence.ts`, also run by the module on a typed prompt; at-room, join, restore) | working / idle / permission / error, for row text |
| `rows/<session_id>.json` | `hooks/row-map.ts` | agent id → row (kind, name, parent) for the status line |
| `rows/holds-<name>.json` | `mcp/hold.ts` | which rows this seat's hold server is holding (row-guard, rewake) |
| `rows/blocks-<agent>.json` | `hooks/row-hold.ts` | SubagentStop block counter |
| `rows/notices-<name>.json` | `lib/notices.ts` | join/leave lines already shown |
| `members/<name>/review.json` | `hooks/consent.ts` (under its lock) | plan-view review phase, mode and plan-file backup |
| `members/<name>/pick.json` | `hooks/consent.ts` (Pre(EnterPlanMode), from the person's latest prompt; a card call naming one) | the pending proposal the person last named; the next review opens it |
| `members/<name>/confirm.json` | `hooks/consent.ts` (a review closed with a note; cleared by Send, Discard or a new review of it) | the note waiting for the person's Send on the confirm card: {hash, note, from, title, asked?} |
| `<reader>.cursor` | each reader | `deliver-NAME` (the tail child), `read-NAME` (CLI), `mcp-NAME` (`read` tool) |
| `*.lock` | `lib/lock.ts` | O_EXCL lockfiles, body `PID HOST START`; stale ones broken atomically |
| `<home>/keys/<CODE>/<name>.key`, `.pub` | `hooks/seat-key.ts` | Ed25519 seat key pair (dir 0700) |
| `<home>/sessions/by-pid/`, `by-sid/` | `lib/identity.ts` | which seat a local claude pid / session id holds (machine-local, not room state) |
| `<home>/sessions/mods/<sid>.json` | `hooks/mod-hello.ts` | the hooks module's hello lease: this session's function hooks are loaded (join requires it) |
| `<home>/machine.json` | `lib/home.ts` `machineId()` | this machine's random id (16 hex digits, never the hostname), stored as each seat's `machine` |
| `workdir.json` (kv `workdir`, host only) | `lib/seats.ts` `enter` | the room's working directory (the first local seat's cwd): where the room's Claude starts, also after a remote join |
| `remote/invites.json`, `remote/links.json` (host only, never streamed) | `lib/remote/auth.ts` | sha256 of each unused invite (a handoff's: bound to one machine, its seats pre-bound); each link's token sha256 with its machine and the seats joined over it |
| `remote/handoff.json` (kv `remote/handoff`; host only, never streamed) | `lib/handoff.ts` (ask, the server's accept/refuse) | the planned handoff: the ask `{id, state, from, to, epoch, locator?, ask?, expires_at}`, then `moved` with the per-machine invites to the new host (kept `HANDOFF_INVITE_MS`) |
| `handoff.json` (kv `handoff`; a mirror only) | the link daemon (`lib/handoff.ts` onAsk) | the host's ask that a seat of this machine host the room; the tail wakes that seat's Claude once (`told_at`) |
| `orphaned-<time>.jsonl` | `store.setAside()` (`sub-human demote`) | an old host's own log after the room was promoted away: kept, never merged |
| `link.json` (kv `link`; a mirror only) | `lib/remote/link.ts` (the daemon) | the link's state `{pid, state, since, reason?}`: connecting, online, offline, fork, stopped |
| `<home>/links/<CODE>.json` | `/sub-human join` (`lib/room/links.ts`), the daemon | a mirrored room's link: transport, then the invite until the first hello swaps it for the token (file 0600, dir 0700) |
| `<home>/links/<CODE>.log` | the link daemon | its stdout and stderr (state changes, FORK) |
| `<home>/bin/row-status`, `roots.json` | `hooks/row-launcher.ts` | the status-line launcher and the plugin roots it may run |
| `<home>/bin/serve`, `current` | `lib/remote/shim.ts` (SessionStart, a join on the host, every CLI run, the card admit) | the SSH forced command's stable shim, and the plugin root, node and plugin cache dir it runs |

**MemoryRoomStore** (`test/support/memory-store.js`) is a second implementation that keeps a room in memory and implements `members.update` as a compare-and-set retry loop, as a remote store would. It shares `store.toPayload` / `store.admit` / `store.placeAfter` and the seat ops of `lib/room/members.ts`, so ids, chain, signatures, the trust checks and seat rules are byte-identical. `test/store-contract.test.js` runs one suite against both, and against `test/support/thread-store.js` (every call over `lib/remote/bridge.ts` to an FsRoomStore on a worker). That is the **remote seam**: a store that keeps rooms off-machine implements the same interface (`store.setBackend(factory)` swaps it in). The seat private keys stay local whatever the store; liveness falls back to the `seen_at` lease for a seat of another machine or with no pid. What other machines may see of `members.json` is `members.publicView` (no `pid`, `pid_start`, `session_id`, `cwd`).

## Entries and `via`

An entry is `{id, at, from, via, kind, text?, prev, …kind fields}`. `id` is monotonic, `prev` is `hash12` of the previous line, `from` comes from a trusted caller that resolved identity (never from env or the model). `lib/room/validate.ts` decides which `via` may write which kind:

| via | Kinds | Written by |
|---|---|---|
| `human` | `say`, `signoff`, `objection`, `proposal` | hooks only: `@room` and `@claude` (at-room.ts), the plan view / card answers (consent.ts) |
| `agent` | `say`, `question`, `status`, `proposal`, `task_req` | the MCP server (`post`, `propose`, `task`) on behalf of a member's Claude |
| `system` | `decision`, `member_joined`, `member_left`, `task`, `status`, `host_changed` | hooks, the reaper and the handoff (`lib/handoff.ts`), with `{system: true}` |

**Signing.** Every hook process runs `seat-key.arm()`, which installs a signer. `append` is `place(toPayload(…))`: `toPayload` validates and, for `via=human`, signs (sig v2, `lib/room/envelope.ts`: Ed25519 over the payload with sorted keys plus `room`, `from`, `nonce`, `ts`, without `id`/`at`/`prev`, so a payload signed on one machine can be placed on another). `place` validates again, refuses a replayed nonce or a `ts` outside `SIG_SKEW_MS`, verifies the signature, then stamps `id`, `at`, `prev` under the log lock. The MCP server, CLI, tail and module never load `seat-key.ts` (`test/hooks/security.test.js`), so they cannot write `via=human`; the store refuses. Keys are pinned in the log: the join hook puts the seat's public key in `member_joined`, the first key seen per name is that name's key for the room's life, and a join with another key is refused (`AUTH`). Readers call `store.humanTrust(e)`: `verified` (v2, or v1 from before the pin, against the pinned key; the local `.pub` only in a room that pins none), `legacy` (unsigned, in a room that pins no key, from a seat with no local key), or `unverified` (shown as `bob (unverified): …`, never counted for consent or tasks).

**Hash chain and `log.idx`.** `verifyChain` checks the chain incrementally from the `log.idx` checkpoint, which is trusted only while the line before its offset still hashes to the stored hash; otherwise it rebuilds from byte 0. The checkpoint also records the offset of every non-chat line, so `readView({after})` returns everything that decides lanes (proposals, answers, joins, tasks) plus the entries after `after`, without parsing the whole log. The tail runs `verifyChain` on its health tick and sends one `room log check: …` line per break (a `health` event). The chain makes edits around the store visible; it does not prevent them.

**Who typed an `@room` or `@claude`.** (Outside a room `@claude` is a plain prompt and passes untouched.) The module's `prompt.submit` gate reads the origin Claude Code stamps on the prompt (`composer`, `sdk` or `bridge` count as typed; cc CONTRACT `prompt-origin-composer`) and drops any other `@room` before a hook runs; the shim hands that origin to at-room as `sub_human_origin`, and at-room posts only with a typed one that comes with this session's nonce (Security model). An origin that is lost on the way (a reload between the two hooks) is refused, and the person types it again.

**How an `@room` post looks.** The TUI trims trailing whitespace before the hook sees the prompt (accepted). On success at-room answers `continue:false` with a stop reason, which keeps the person's `❯ @room …` row and adds one "Operation stopped by hook: ✓ sent" line; the model sees both natively on its next turn. Refusals are `decision:block` with `suppressOriginalPrompt`, which works only inside `hookSpecificOutput`, so refused or forged text never reaches the model. Typed through Remote Control (origin `bridge`), a refusal is also the `systemMessage`, relayed to the phone (Process model, Remote Control); "✓ sent" is not (the phone shows the person's own row, and a relay costs a turn). When the posted text appears verbatim in the last assistant message (an accepted prompt suggestion, a copied draft), the entry carries `drafted:"agent"`; it is still posted.

## Lanes and settle batching

`lane(me, e, entries)` (`lib/room/lanes.ts`) says whom an entry concerns:

- **push**: the tail sends it now. A person's own words, joins and leaves (group chat) are `chat`: shown to the person, copied to the model, no wake. Anything `to` me or mentioning `@me` (for the room's Claude only `to=claude`, a person's leading `@claude` tag: an `@claude` inside the text is just words), a proposal naming me that I have not answered, an objection to my proposal, a task request (room Claude only) is a `wake`: one plugin prompt, one model turn.
- **pull**: no wake. The tail sends it as "Room since your last turn", which the model reads with its next request.
- **none**: my own posts.

The tail batches push entries in a `Batcher` (`lib/tail.ts`): flush after `SETTLE_MS` 1500 of quiet or `SETTLE_MAX_MS` 5000 after the first (room Claude: 3000 / 10000), so a burst costs at most one turn. Each entry is judged again at flush time against `readView`, so an entry answered or decided in the meantime is dropped. A `member_left` is held `LEAVE_SETTLE_MS` 8000 so a quick leave and rejoin shows nothing; the room row's hold progress line settles leaves the same way ("bob left" only after 8 s). A member's batch is group-chat lines without ids, plus `(for Claude)` lines in a wake; the room Claude's batch starts with `stateLine()` and keeps ids. All timings live in `lib/config.ts` with `SUB_HUMAN_*_MS` overrides. The room's Claude gets the overrides of the session that started it through its `--settings` env (the bg daemon filters the caller's env), so a room started with a short `SUB_HUMAN_ROOM_CLAUDE_ORPHAN_MS` has a watchdog that honours it.

## Consent

```
propose tool (via=agent)          ──► proposal {hash, approvers, path=plans/<hash>.md}
                                        │ push lane to each approver
                                        │ the tail's reminder names only the one a review opens next (+ a count)
approver's Claude: EnterPlanMode ──► consent.ts Pre: allow silently, review.json {phase: entering, mode, hash}
                                      hash = what the person's latest prompt names (cc.lastHumanPrompt: their own words
                                      only; proposal.choose → members/<name>/pick: a hash, or words only its title / text
                                      has, "Open v3"), else the earlier pick, else the oldest (never the model's choice)
                                      plan file path already known → back it up, write the proposal text now (Post: again)
                   ExitPlanMode  ──► consent.ts Pre: always ask with updatedInput.plan = that proposal's text, whatever
                                      the call carries (stale plan, hand-written copy, other hash, nothing; a blank plan
                                      waits up to EXIT_INPUT_WAIT_MS for the call's transcript line); the text in the plan
                                      file, its old content in the backup; a plan of the model's: told, not shown
                                        │ native plan view (scrollable), the person answers
   "Yes …"                        ──► Post(ExitPlanMode): signoff via=human (only if text unedited); restore plan file + mode
   "Tell Claude what to change",  ──► Stop / next ExitPlanMode / prompt: cc.planFeedback(transcript) → nothing recorded:
   phone "Suggest edits"/deny+note,   the note waits in members/<name>/confirm; PermissionRequest: allow with setMode
   phone message after a bare deny    (no dialog), records nothing; the model is told to open the confirm card
   confirm card (AskUserQuestion) ──► Pre: the hooks' card "Send to <proposer> as changes requested on "<title>": "<note>"?"
                                      (Send / Discard); Post: only the person's Send on that card → objection via=human,
                                      note byte-exact; Discard drops the note; AFK / no answer keeps it (Stop nudges once)
   Esc, phone deny without a note ──► nothing ("closed without answering"); Stop / next prompt / restore close the review
   no review shown (no hook review) ─► Post(ExitPlanMode): nothing recorded, even for the proposal's exact text (the model
                                      wrote it into the plan file); the model is told the person has not answered
fallback (already in plan mode, bypass/dontAsk, clear-context-on-accept, >200k chars):
   AskUserQuestion card           ──► Post(AskUserQuestion): signoff | objection via=human (Not yet, AFK, stale hash: nothing)
every answer                      ──► lib/proposal.answer (signed, any machine), then decide: on the host only,
                                      once every approver answered, the decision via=system (idempotent)
```

The plan-view review runs only in the modes `default`, `acceptEdits` and `auto` (not plan already, not `bypassPermissions` or `dontAsk`) and only while clear-context-on-accept is off; otherwise the card is used. A plan edited in the dialog (Ctrl+G) records nothing: a signoff needs the proposal text unedited. "Tell Claude what to change" reaches the next `ExitPlanMode`, which reads the note with `cc.planFeedback` (the transcript's `userFeedback`, else the "the user said:" text). A note never counts on its own: Claude Code writes the terminal's note, the phone's "Suggest edits" and an ordinary message typed on the phone after a bare Deny (Remote Control attaches it to the deny) alike, so the note waits for the person's Send on the confirm card, an AskUserQuestion card like the fallback (the model calls it; the hooks own its text and only the person's answer counts). Remote Control forwards the card to the phone (cc CONTRACT `auq-bridge-racer`). When the "Yes" the person chose changed the permission mode, consent puts it back with a silent EnterPlanMode / ExitPlanMode pair (phase `restore`).

`lib/room/consent.ts` `fold(entries)` is the one interpretation of the log, used by `stateLine`, `lane`, the rows and the gate, so they cannot disagree: the latest proposal entry per hash wins; per person the latest trusted `via=human` answer wins (an objection voids an earlier signoff); a decision closes the hash with state `agreed` or `blocked`. `test/hooks/consent-table.test.js` feeds one table to all views.

## Tasks

```
member's Claude ─ task({op, …}) ─► task_req (via=agent, by=member)   push lane to the room's Claude only
room Claude ─ TaskCreate/TaskUpdate (metadata {req, by}) ─► native list sh-CODE under <claude config>/tasks/
hooks/tasks.ts PostToolUse ─► task entry (via=system, full snapshot) ─► tasks.json = tasks.fold(task entries)
hooks/tasks.ts TaskCompleted ─► tasks.gate(): exit 2 unless the owner asked done with evidence
```

- **Reconcile.** A mirror run can be lost (a module hook that failed, a reload). So on every room Claude run `hooks/tasks.ts` also compares the native list with the log and appends an `add` snapshot for each native task the log has no `task` entry for; the next run repairs a lost one.
- The room Claude's **native task list is the ledger**: `CLAUDE_CODE_TASK_LIST_ID=sh-CODE`, passed through `--settings` env because the bg daemon filters the caller's env (`cc.DAEMON_ENV_ALLOW`). The plugin never writes under `~/.claude`.
- **`metadata.req`** links a native task to the `task_req` it applies. The TaskCompleted input carries no metadata, so the gate reads the task file (which still shows the old status).
- **`tasks.json` is a pure fold** of the log's `task` entries: delete it, refold, same file. Rows and `sub-human tasks` read only it.
- **The gate**: only the owner's own `done` request with evidence after the last claim (or a trusted human entry from the owner citing it) passes. A blocked TaskUpdate drops every field in that call, so the room's Claude is told to change status in a call of its own. Task 1, "room CODE open", stays open until the room is closing, which keeps the native list from being wiped.

## Identity and liveness

- **Binding.** `/sub-human NAME [CODE]` triggers `hooks/join.ts` (UserPromptExpansion) before the model runs. A join that worked shows no `systemMessage` (Claude Code draws one as a warning; the title and the room row say it), unless the room's Claude did not start or the session is in bypass-permissions mode; a refusal is the block reason and the `systemMessage` (which Remote Control shows). It writes the seat into `members.json` and the indexes `<home>/sessions/by-pid/<CLAUDE_PID>.json` and `by-sid/<session_id>.json`. The model never names itself. Without a CODE it joins the one open room (a live member seat, not closing), or opens a new one; several open rooms is an error that lists their codes. Rooms where only the room's Claude is left are swept first. A member already in another room switches: the old room logs `member_left` "switched rooms".
- **Resolution.** Hooks: payload `session_id`, then `CLAUDE_PID`. MCP server: `process.ppid` (MCP servers get no `CLAUDE_PID`). CLI and tail child: `CLAUDE_CODE_SESSION_ID` (the module sets it for the child), then `CLAUDE_PID`, then the nearest registered ancestor. `/clear` changes the session id but not the process: `session-restore.ts` rebinds the new id to the seat found by pid. `--resume` is a new process with the old id: it rebinds the pid or rejoins the seat.
- **Liveness.** `seatAlive(m)` (`lib/room/members.ts`): not left, and, for a seat of this machine (`m.machine === machineId()`), the pid is alive with a start time equal to the stored `pid_start` (so a reused pid never keeps or adopts a seat). Any other seat (another machine's, or no pid) is alive while its `seen_at` lease is fresh (`SEAT_LEASE_MS` 120 s); the tail's health tick and the hold server renew it with `members.beat` at most every `SEAT_BEAT_MS` 30 s, and a presence write rides on the same op.
- **Entering and leaving.** `lib/seats.ts` `enter` (members.join, the session indexes, `member_joined` with `pubkey` and `machine`, the room's Claude) and `exit` (members.leave, the reaper when nobody is left, `member_left`) are the one sequence the join and session-end hooks run. A name is one seat across machines: a live seat of another holder makes it "name taken". `host` and `join` are reserved names.
- **Host gates.** Room Claude spawn, reap and watchdog (`lib/room-claude.ts`) and proposal decisions run only where the room's store `isHost`; on any other machine they do nothing. A handoff (Remote rooms, Moving the host) flips `isHost` on both machines: `store.open` decides a room's kind again when its link file appears or goes, and the tail starts its session again over the new store.
- **Address.** `NAME.CODE` is set as the session title (the module's `classic.UserPromptSubmit`, once per session id and address), which is what `SendMessage` and `ListAgents` use (cc CONTRACT `session-title-address`).

## The room's Claude: lifecycle

```
join (no live room Claude) ─► claimSpawn: members.claude = {job:"pending", claim}  (under the members lock; a concurrent join sees it)
                    ─► startDetached ─► spawn(): claude stop <prevJob>; claude --bg …; find job in `claude agents --json`
                                         record {job} only if the claim is still current and the room is not closing
room Claude session ─► /sub-human ─► join.ts binds the "claude" seat (agent_type sub-human:room-claude + SUB_HUMAN_ROOM)
             ─► TaskCreate "room CODE open"
last member SessionEnd ─► reap (detached): grace 10 s (a rejoin cancels) ─► set closing ─► status to=claude
                          "room closed: complete task 1" ─► wait ≤ 20 s ─► claude stop <job> ─► room Claude seat left
crashed members (no SessionEnd) ─► room Claude tail child's health tick: watchdog() sees no live member for 60 s ─► closing + reap
```

Debugging the room's Claude by hand: `node lib/room-claude.ts cmd CODE` prints the exact spawn command; or run `claude --agent sub-human:room-claude --permission-mode plan` and type `/sub-human CODE` (an existing room) or `/sub-human` (a new room).

`needsSpawn` also respawns a room Claude whose pid is dead, whose claim is older than `ROOM_CLAUDE_CLAIM_MS`, or which never bound within `ROOM_CLAUDE_BIND_MS`. `openRooms()` ignores rooms where only the room's Claude is left, and join sweeps those through the watchdog.

## Remote rooms

A room can have members on other machines. The machine that created it is the **host**: its room directory is the room, and its hooks, tail and MCP server keep using that directory as before. Another machine joins with an invite and keeps a **mirror**: a room directory with the FsRoomStore layout, kept byte-identical to the host's log by a **link daemon**. Every reader (`readView`, `log.idx`, the tailer, `verifyChain`, rows, digests) works on the mirror unchanged; only writes cross the wire, as named ops. Three transports: SSH (`ssh:user@host[:port]`, below), the web (`wss://host/…/sub-human/CODE`: a Noise channel in a WebSocket to the host's listener through Tailscale Serve/Funnel or any HTTPS front, below) and a pipe to a second home on the same machine (`pipe:<home>`, the tests and the demo); SSH is the pipe with `ssh` in front, and none of them needed a protocol change. The plan, with its as-built notes and decisions: [`docs/archive/REMOTE-PLAN.md`](archive/REMOTE-PLAN.md).

```
 HOST machine                                            REMOTE machine
 hooks / tail / MCP ──► FsRoomStore ◄── serve --stdio ◄══ transport ══► link daemon ──► MirrorRoomStore (FsRoomStore layout)
   (sign + place,        <home>/rooms/CODE   per connection    (ssh, or a   (one per room   ▲ reads: hooks, tail, MCP, rows
    decide, claude)                           (scripts/sub-human)   pipe)        and home)       │ writes: bridge (worker thread,
                                                                                             │          Atomics.wait, deadline)
                                                                                    hooks ───┘ sign with the local seat key
```

**Joining.** On the host, a person in the room runs `/sub-human invite [--ssh [user@host]] [--via JUMP]` (`lib/remote/hosting.ts` hostInvite; over ssh by default, to `SUB_HUMAN_SSH_ADDR` or `user@hostname`): `auth.mintShort` records an invite with a 4-digit PIN (unique among the room's open invites, at most `SHORT_LIVE_MAX` 4 open; 5 tries, `INVITE_TTL_MS` 15 minutes; the host keeps the PIN in clear, as CPace needs, until it is used, burnt or cancelled), and the join hook shows the line `/sub-human join DEST ROOM PIN [--via J]` as a block reason with `suppressOriginalPrompt`, to the person and never to the model. The line carries no name: the joiner's is their git `user.name` (`identity.defaultName`), or `--as NAME`. On the other machine every `join`, `invite` and `admit` prompt, and any prompt with a word of digits, is answered with `hidden()` before its form is sorted out, so a mistyped PIN never reaches the conversation. A join with a PIN writes the link file (`lib/room/links.ts`: the transport to the host's door, `enroll {pin, name}` and `join_as`), starts the daemon detached and watches it (`hosting.outcome`, up to `LINK_JOIN_WAIT_MS`). The daemon runs the PAKE first (`lib/remote/enroll.ts`, below): a wrong PIN costs a try and says how many are left; one that holds gets a sealed admission secret, which waits for the host person's card (`lib/remote/admission.ts`: Let in / Refuse, or `/sub-human admit [REF]`, `sub-human admit` in a shell), and the PIN leaves the link file. The join never takes the seat in the step that carries the PIN (the seat's context would reach the model with the prompt): once the card lets the machine in and the admission secret becomes the link's token, a bare `/sub-human` (no PIN) finds the link file's `join_as` and takes that seat. Each wrong PIN, the burn and each new link are a status line from `room` in the host's log. A rejoin never restarts a link whose PIN was refused. From then on `store.open(CODE)` there returns the mirror. **Over an ssh login** (no invite): `/sub-human join HOST ROOM [--via J] [--home P] [--as NAME]` (no PIN) writes a link file whose transport is `lib/remote/transports/ssh.ts` loginSpec (`login: true`, a link id this machine picks, the host's home when not `~/.sub-human`; a bare ssh alias takes its user from `ssh -G`); the daemon runs the person's own `ssh -o BatchMode=yes … '"$HOME"/.sub-human/bin/serve --stdio CODE --link ID --login'` (their keys, config and known_hosts) and says hello `{login: true}`; that `serve --login` session (refused under `SSH_ORIGINAL_COMMAND`, i.e. any forced command, and a forced command's line never carries `--login`) makes link ID (`auth.loginLink`), with the room line `a machine (…) linked over your SSH login (link …)`, and the token it returns is kept as any link's. The join watches the first hello and takes the seat in the same step (nothing secret is in that prompt); ssh failures only the person can fix (an unknown host key: the exact `ssh USER@HOST` to run once; a refused login; no shim or no room on the host) stop the daemon with `AUTH` and that reason (`ssh.loginFailure`). A host refreshes its serve shim passively on every join there. A seat's connection ends with `/sub-human kick NAME` or `sub-human kick NAME` (`hosting.kick`): the token and any invite reserved for it burn, its `authorized_keys` lines go, its seats leave, its `serve` processes stop (each first ends its streams `{reason: 'AUTH'}`, so the joiner's daemon stops with "the host revoked this link" instead of redialing; a daemon that was offline then meets ssh refusing its key, which for a link with its own key and a token is `AUTH` too), and a room line says so. An unused invite is cancelled with `/sub-human invite --cancel [REF]` (`hosting.cancelInvite`). `/sub-human leave` leaves the room (`seats.exit`) and keeps the session; its tail goes quiet with the seat.

**Host and mirror.** `store.isHost` decides who does what. Only the host spawns, reaps and watches the room's Claude, decides proposals, pins keys, mints invites and writes `members.update` and the streamed documents; on a mirror these throw `HOST_ONLY` or are gated off (`lib/room-claude.ts`, `proposal.decide`). The host streams its log lines verbatim and three documents: `members` (`members.publicView`: no `pid`, `pid_start`, `session_id`, `cwd`), `presence/*` and `tasks`. Session-local state (`rows/*`, `members/NAME/review|title`, cursors, notices, the session indexes, keys) never leaves its machine. On a mirror a seat of this machine is judged by its session index (pid, start time, session); a seat of another machine lives by its lease (`seen_at`, `SEAT_LEASE_MS` 120 s, renewed by `beat`). A remote seat's join and leave reach the host's `lib/seats.ts` through its server, which logs `member_joined`/`member_left` and runs the room's Claude and the reaper there.

**Writes.** A hook's write (`@room`, an answer, join, leave, a beat) is signed on its own thread, then crosses `lib/remote/bridge.ts`: the hook's thread posts one op to a worker and blocks in `Atomics.wait` until the reply or the deadline (`LINK_CALL_MS` 3 s, SessionEnd `LINK_CALL_END_MS` 1 s). The worker relays the op over the daemon's unix socket (`link.handle`; it loads no store and never the signer). With the link down the call is `OFFLINE` and nothing was sent: a card answer (consent), a proposal, a join or an agent's post is refused at once and the person is told, never queued. The one exception is the person's own `@room` post (see the outbox below). A slow link is not a down one: the frame went out and may land late, so a deadline is never "nothing was sent". The daemon answers every relayed op by `LINK_RELAY_MS` (2 s, inside the hook's 3 s): a person's `@room` post the host has not answered by then goes into the outbox under its nonce, answered `{queued, slow: true}` ("⧗ sending (slow link)"), and the host's late answer takes it out (the late copy is the post; a refusal is dropped and reported); any other op is `OFFLINE` with `protocol.UNKNOWN_OUTCOME`, as is the bridge's own deadline, and the store marks it `unknown`: the at-room hook says "⧗ not confirmed", the consent hook that the answer may still be recorded and answering again is safe (one answer per person per proposal; the same signed payload sent again is refused by its nonce). After a write the server polls the session's streams before it replies, so the mirror holds the write's lines when the hook's call returns (read-your-writes). The worker starts at a process's first write: a hook that only reads starts none.

**The link daemon** (`scripts/sub-human link CODE`, `lib/remote/link.ts`), one per room and home: it holds the one connection (`hello` with the token), `subscribe`s from the mirror's last line with `{after, hash}`, applies each line (`applyLine` refuses one that does not chain: `FORK`) and document, prefetches every proposal's plan, and serves the hooks on `<mirror dir>/.link/link.sock`, or `/tmp/sub-human-<uid>/<hash12(mirror dir)>/link.sock` when that path is too long for a socket (each directory 0700, a real directory, this user's). The path depends on the home and the room only, never on `TMPDIR` (a daemon started by the listener, sshd or a handoff need not share the session's), and the daemon records it in its `link.json` (`socket`), which the hooks try first, then the computed path, then 0.4.1's `<tmpdir>/sh-<hash8>/link.sock`. Its state is the mirror's `link.json`: connecting, online, offline, fork, stopped (AUTH or PROTOCOL at hello, the room closed, idle, a signal). `FORK` is never repaired silently: the daemon stops, the tail sends one `room link: FORK …` line (a `health` event: the module logs it as a notice and gives Claude a copy), and `sub-human link --reset CODE` re-mirrors. The tail also sends one line when the link goes offline, and one quiet `room link: back online; …` line once it is online again (with what became of the queued posts); a swap that never left online shows nothing. The daemon exits `LINK_IDLE_MS` (60 s) after no seat of this machine is left in the room: online by the host's members document, offline by this machine's live session indexes, so a crashed or abandoned join never leaves it retrying. The server (`scripts/sub-human serve --stdio CODE`, `lib/remote/server.ts`) is one process per connection on the host, spawned by the client's transport; there is no host daemon, and the file locks coordinate it with the host's own hooks.

**Reconnect** (all in `lib/remote/link.ts`, timings in `lib/config.ts`, each overridable by `SUB_HUMAN_LINK_*_MS` for tests):
- *Backoff.* A lost connection is dialled again after a delay with decorrelated jitter: random in [`LINK_RETRY_MS` 1 s, 3 × the last delay], at most `LINK_RETRY_MAX_MS` 10 s, so links that dropped together do not redial together.
- *Wake and network change.* A timer ticking every `LINK_WAKE_TICK_MS` (2 s) that fires more than `LINK_WAKE_GAP_MS` (5 s) late, or finds the wall clock that far from the monotonic one (which does not count a sleep), means the machine slept; a changed set of external addresses (`os.networkInterfaces`, polled every `LINK_NET_POLL_MS` 5 s) means it moved. Either redials at once with the backoff reset. `SIGUSR2` to the daemon does the same.
- *Heartbeat.* `ping` is a protocol op gated by caps, not by version: the daemon says hello with `caps {ping: true}` and pings only a server whose caps list `ping`, every `LINK_PING_MS` (15 s). No pong within `LINK_PONG_MS` (5 s) makes the link suspect (redial); none within `LINK_DEAD_MS` (10 s) declares it dead, which catches a half-open TCP or ssh link after a sleep without relying on `ServerAliveInterval`. The server closes a pinging session that sent no frame for `LINK_SILENT_MS` (45 s). An old peer on either side never sees a ping.
- *Make before break.* A redial while online (a late pong, a wake) makes the new connection completely (hello, `subscribe` from the mirror's last line and hash, seats renewed, outbox sent) before it replaces the old one, which closes once the ops in flight on it are answered; hooks keep using the old one meanwhile, and a redial that fails keeps it. The two streams overlap for a moment, so a line the mirror already holds (the same id and bytes) is skipped; any other mismatch is still `FORK`. Appends stay idempotent by their nonce: the host refuses a nonce it placed already ("placed already"), and the outbox counts that as sent.
- *Seats.* On every reconnect the daemon `beat`s each live seat of this machine (`identity.localSeats`). A seat whose lease (`SEAT_LEASE_MS`) lapsed on the host during the outage is alive again with its pinned key and link binding unchanged, and nothing is logged: no "left", no "joined". The host never marks a lapsed seat left, so no new join proof is needed (the daemon never holds the signer); a seat the host does show as left is logged, and the person joins again.
- *The `@room` outbox* (`lib/remote/outbox.ts`, `<mirror>/outbox.json`, 0600). With the link down, an `@room` post the hook marks `queue` (`hooks/at-room.ts` only) and that is a signed `say` by a person to the room is kept by the daemon instead of refused; the person sees `⧗ queued: … (N waiting)`. At most `LINK_OUTBOX_MAX` (50) posts. Answers, consent, proposals, joins and agents' posts are never queued: they fail at once with OFFLINE. The posts go out in order on the new connection, after `subscribe` proved the mirror is the host's prefix and before the link counts as online (a post typed meanwhile queues behind them). The daemon never re-signs, and the host refuses a signature more than `SIG_SKEW_MS` (10 min) old, so a post waits at most `LINK_OUTBOX_AGE_MS` (9 min); an older one, or one the host refuses, is dropped and the person is told with its words. On a `FORK` the queue is kept, not sent, and the FORK line says how many. Online, a post sent over a slow link that the host has not answered within `LINK_RELAY_MS` joins the queue too, under its nonce (see Writes): it leaves when the host's late answer comes, or is sent again, harmlessly, on the next connection.
- *State for observers.* Besides the mirror's `link` document (with `queued` and the last `flush` {sent, unsent}), the daemon writes `<home>/links/<code>.state.json` (`lib/room/links.ts` LinkState) on every change and every pong: `{state, since, attempt, lastError, rttMs, queued, pid, detail, at}`, in the one link vocabulary the `link` document, the room row, `doctor` and the tail share (`lib/room/link-state.ts` STATES): `online | connecting | offline | fork | stopped` (`connecting` also while an offline link redials; records before 0.4.1 said `up`/`down` and still read). `doctor` and the statusline read it; a `pid` that is not alive means the daemon is gone.

**Transports.** `lib/remote/transports/index.ts` is a registry: `register(kind, {open, parse?, describe?})`. An invite's locator `KIND:REST` parses through its kind into the link file's `transport` spec, and the daemon's `connectLink` opens that spec with `{code}`; `open()` may be async (a socket or a handshake), and `client.connect` takes the transport or its Promise. Built in: `memory` (tests, worker threads; no locator), `pipe` (`pipe:<home>`, a second home on this machine), `ssh` (`ssh:user@host[:port]`, the pipe with `ssh` in front) and `wss` / `ws` (`wss://host[:port]/path`, below). `fromDuplex(stream)` turns any node stream (a socket, a TLS or WebSocket stream) into a transport, so a socket kind is a parse and an open of a few lines. Each connection still gets its own `serve --stdio` on the host.

**SSH.** A link's ssh locator is `ssh:user@host[:port]` (an invite's line, a login join, a handoff's invite); the ssh kind's parse (`lib/remote/transports/ssh.ts`, through `link.transportOf`) accepts only a plain user and host (neither starting with `-`, no spaces, quotes, `%` or a second `@`) and a port, so nothing typed can name an ssh option or a command. The daemon runs `ssh -T -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=2 [SUB_HUMAN_SSH_OPTS] [-p port] -- user@host "sub-human serve --stdio CODE"` (`transports/ssh.ts` `command`; `SUB_HUMAN_SSH_OPTS` comes from the joiner's own environment, for tests and unusual setups) and gives the hello `LINK_HELLO_MS` (15 s) for ssh to connect. On the host the remote command is ignored: the card's Let in writes the `authorized_keys` line `command="SUB_HUMAN_HOME=<home> <home>/bin/serve --stdio CODE --link ID",restrict <key> sub-human:CODE:ID` (an absolute home path, refused if it holds shell-special characters). `<home>/bin/serve` is a small POSIX sh shim (`lib/remote/shim.ts`) that reads `<home>/bin/current` at run time: the plugin root, the node and the plugin cache dir of the install in use. `invite --ssh`, the card's admit and `doctor --fix` record their own install; every SessionStart and CLI run refreshes it passively, only from an installed plugin (a root under the Claude Code plugin cache), for the recorded root itself (a new node), or when the recorded root is gone, so a dev checkout or worktree run without `SUB_HUMAN_HOME` never takes over the real home's pointer (`test/real-home-guard.test.js`). It runs that root's CLI, or the newest version in the cache dir when the root is gone, with that node, or `node` on PATH (then Homebrew, `/usr/bin`, nvm) when it is gone, and only ever `serve`. So the line survives plugin updates (the cache path is versioned) and node upgrades. `doctor --fix` rewrites the lines sub-human 0.2 wrote for this home, which baked both paths in. `serve --link ID` accepts only that link's token, or the invite reserved for it (`auth.reserveLink`): a key reaches one room, one link. sh1 invites (`sh1.<CODE>.<locator>.<secret>`, no PIN) are internal now: no command mints or takes one, the server still redeems one (a 0.2.0 joiner), and the lab and tests set them up through the lib. `scripts/remote-docker/` checks it end to end against containers (see Testing).

**The PIN and the door** (`lib/remote/cpace.ts`, `enroll.ts`, `sshkeys.ts`, `admission.ts`; `docs/short-invites.md`). The PIN is CPace's password (ristretto255 + SHA-512, vendored `@noble/curves`): `enroll.start` → one offer per open invite of that transport, each charged a try before the host answers → `enroll.finish` → a box sealed under a key from the ISK holding a fresh admission secret, bound to the joiner's machine and, over ssh, its new link key (`<home>/links/CODE/id_ed25519`, made on the joining machine; ADa carries its public half). Inside the PAKE the host vouches for its key (sshd's Ed25519 host key, or the listener's X25519 key); over ssh the joiner's ssh records the host key it was shown (a fresh known_hosts, `accept-new`, Ed25519 only) and stops before its own tag goes out unless it is the vouched one, then pins it in a known_hosts of the link's own under `HostKeyAlias sub-human-CODE`; the link file's transport gains `key`, `knownHosts` and `alias`, so the daemon's ssh adds `-i KEY -o IdentitiesOnly=yes -o UserKnownHostsFile=F -o StrictHostKeyChecking=yes -o HostKeyAlias=…`. A joiner with no admitted key reaches sshd through the **enrollment door**: while an ssh invite is open, `authorized_keys` holds `command="… serve --enroll CODE --kind ssh",restrict <the room's public enrollment key> sub-human-enroll:CODE` (the key is derived from the room, never from the PIN), which runs the PAKE and nothing else; `enroll.sweepDoors` removes it once no ssh invite is live. The admission secret redeems nothing until the host person's card lets that machine in (a signed answer; then the link key gets its one-link forced-command line); a request nobody answers lapses after `ADMIT_TTL_MS`. A locator may name jump hosts, `ssh:user@host[:port]?via=[user@]jump[:port][,…]` (each as plain as the destination), which become `-J`. `sub-human prime CODE` opens a ControlMaster interactively (`ssh -M -N -f -o ControlPersist=8h`, `ControlPath <home>/ssh/cm-%C`) and marks the link `mux`; the daemon then adds `-o ControlMaster=no -o ControlPath=…`: it rides a primed master (one MFA prompt for hours) under BatchMode, never prompts, and never becomes a master itself.

**Over the web (1.1)** (`lib/remote/ws.ts`, `noise.ts`, `transports/ws.ts`, `listener.ts`, `tailscale.ts`, `webhost.ts`).
- *Hosting.* `/sub-human invite --web` (Tailscale Serve), `--public` (Funnel) or `--url https://FRONT[/prefix]` (`webhost.hostWeb`) starts the **listener** (`sub-human listen`, one per home, `127.0.0.1:7420` only, `SUB_HUMAN_LISTEN_PORT`), adds the room to its served set (`<home>/listen/state.json` `{pid, port, rooms: {CODE: {path, url, mode, tailscale?}}, conns}`, which `doctor` reads), and, with `--web`, runs `tailscale serve --bg --https=443 --set-path=/sub-human/CODE http://127.0.0.1:PORT` (`funnel` for `--public`) with the CLI on `PATH` or in `/Applications/Tailscale.app`, the name from `tailscale status --json` `Self.DNSName`. It mints an invite (kind `ws`, vouching for the listener's X25519 key inside the PAKE) and shows `/sub-human join https://NAME/…/sub-human/CODE PIN` (and Funnel's certificate-transparency warning). `/sub-human invite --stop`, or the listener's sweep when the room closes, turns off that one path (`… --set-path=… off`, never `serve reset`). The host's next join after a reboot restarts the listener (`webhost.ensure`).
- *Joining.* `/sub-human join URL PIN [--as NAME]`: the room is the URL's last path segment. A WebSocket whose first message is text runs the PAKE (`serve --enroll CODE --kind ws`); the joiner pins the vouched listener key, the host's card admits the machine as over ssh, and every later connection is Noise_NK to that key. The link file's transport is `{kind: 'wss', host, port?, path, hostKey}`.
- *The wire.* The daemon's `open` connects a WebSocket (`ws.ts connect`, RFC 6455, hand-rolled because Node's global `WebSocket` has no proxy support; through an HTTP `CONNECT` proxy from `HTTPS_PROXY` / `NO_PROXY`), then runs **Noise_NK_25519_ChaChaPoly_SHA256** as the initiator with the pinned key (`noise.ts`: `node:crypto` X25519, ChaCha20-Poly1305 and HKDF-SHA256, no field arithmetic; checked against the cacophony and snow vectors). Message 1 carries `{v: 1, room}`; message 2 `{ok}` or an `{error}` only the key's holder could write; a message 2 that does not decrypt is `AUTH` (the link stops). Then each binary WebSocket message is one Noise transport message (at most 65535 bytes) of the NDJSON byte stream, through `fromDuplex`, so reconnect, ping and the outbox above work unchanged.
- *Handoff.* A next host's locator may be a web one (`/sub-human handoff NAME https://FRONT`, `--url`; `webhost.webLocator`): on acceptance it serves the room on its own listener (`webhost.serveAt`) and every invite it mints (`auth.mintFor` `hostKey`) pins its listener's X25519 key, so the others' link files (`handoff.onMoved`, `afterMoved`) carry that key. Its Tailscale path is set up by `/sub-human invite --web` after the move.
- *Doctor* (`lib/cli/doctor.ts`): `listener` (running, pid, port, rooms; a served room with no listener fails), `web:CODE` (`tailscale serve status --json` still lists the path; Funnel warns that the name is public), and a wss link's hello over its real transport.
- *The listener* never runs `server.ts` in-process: after the handshake, if the room is served and still open, it spawns `<home>/bin/serve --stdio CODE` (the stable shim) for that connection and pipes plaintext both ways; the child authenticates the hello as over any transport. Before a handshake completes it holds at most 16 connections in handshake (64 in all), 10 s each, frames of at most 64 kB; it pings every WebSocket every 15 s and drops one silent for two intervals. It exits 10 minutes after it serves no room.

**Protocol** (`lib/remote/protocol.ts`). Newline-delimited JSON: request `{id, op, params}`, reply `{id, result}` or `{id, error: {code, message}}`, stream event `{id, ev, data}`. A frame is at most `LINK_FRAME_MAX_BYTES` (1 MiB).

| Op | Params | Result | Who may | Server does |
|---|---|---|---|---|
| `hello` | `{v, proto, client, caps, machine, token, epoch?}` or `{…, invite, pin?}` | `{v, proto, server, caps, room, link, token?, epoch, time}` (time: the host's clock in ms, for `doctor`'s skew check; older hosts omit it) | anyone | version: the highest common one, else `PROTOCOL` naming who updates; a mirror's `epoch` later than this log's is `STALE`; `verifyToken`, or `redeemInvite` (an sh2 invite checks the PIN; the token is returned once); neither: answered, still unauthenticated |
| `join` | `{name, role: 'member', pubkey, proof}` | `{ok, rejoin?}` | a link | `checkSeatProof` (the key's holder signed this join), then `seats.enter` with the link's `machine`; another key for a pinned name is `AUTH`; binds the name to the link |
| `leave` | `{name, reason}` | `{ok}` | a link, its own seat | `seats.exit` (member_left; the reaper when nobody is left) |
| `beat` | `{name, presence?}` | `{ok}` | a link, its own seat | `members.beat` (lease, presence) |
| `append` | `{payload, epoch?}` | `{entry}` | a link, `payload.from` its own seat | `store.place`: validate, rate, replay, verify against the pinned key; then `decide` after an answer. A system kind is `AUTH` (only the host writes those) |
| `subscribe` | `{after, hash}` | stream | a link | `hash12` of the host's line `after` must equal `hash`, else `FORK`; then `entry` per line, `doc` for `members`, `presence/*`, `tasks`; `end` `{reason: 'closed' \| 'FORK' \| 'AUTH', message?}` (AUTH: the link was revoked) |
| `blob.get` | `{ref}` | `{bytes}` (base64) | a link | `blobs.get` |
| `blob.put` | `{name, bytes}` | `{ref}` | a link | only `plans/<hash12 of the bytes>.md`, at most `PROPOSAL_FILE_MAX`, written once |
| `ping` | `{}` | `{pong}` (the host's ms) | a link | the heartbeat; listed in the server's caps, so a client pings only a server that answers. A session whose hello carried `caps {ping: true}` and that then goes silent for `LINK_SILENT_MS` is closed |
| `handoff.accept` | `{id, accept, locator, invites}` | `{ok, epoch, entry}` | a link, the ask's target seat | `lib/handoff.ts` serverAccept: the ask pending and not expired, `accept` signed by the target's pinned key for this id, epoch and locator, the invites to that locator; appends `host_changed`; after the reply, stops the room's Claude job and mirrors the new host |
| `handoff.refuse` | `{id}` | `{ok}` | a link, the ask's target seat | the ask becomes `refused` |

Error codes, the same on both ends and on the wire: today's `INVALID`, `RATE`, `LOCK`, `NO_ROOM`, plus `OFFLINE` (the link is down or the deadline passed), `HOST_ONLY` (an op a mirror never performs), `AUTH` (no or bad token, a used invite, a `from` not this link's seat, a key mismatch, a bad signature, a replayed nonce, a stale `ts`), `FORK` (the mirror's last line is not the host's), `PROTOCOL` (unknown version, malformed frame) and `STALE` (another host epoch: a host the room moved away from, or a copy that has not caught up with the move).

Stream events besides `entry`, `doc` and `end`: `handoff` (the ask, to the link holding its target seat only) and `moved` (after the `host_changed` line: `{epoch, host, machine, locator, invite}`, the invite this link's machine's alone), then `end {reason: 'moved'}`. Both are private to one link and never in the log.

**Moving the host** (`lib/handoff.ts`, the CLI bodies in `lib/cli/handoff.ts`). The host's machine holds the log, serves the links and runs the room's Claude on the host person's model account, so a sleeping host means an offline room. Authority is the log's: a `host_changed` entry (via system) `{epoch, host, machine, locator, accept?, ask?, promoted?}` moves it, and `store.hostState()` reads the last one (epoch 0 before any). There is no automatic failover.

```
A (host, alice)                         B (bob, mirror)                         C (carol, mirror)
/sub-human handoff bob ─► remote/handoff {asked, epoch 1}
serve(B's link) ─ ev handoff ─────────► daemon: kv handoff ─► tail: wake ─► AskUserQuestion card
                                         (the hooks' card: the room's Claude runs on bob's account; stay reachable)
                                         "Host it here" (via=human, consent.ts) ─► accept: mint one invite per
                                         other machine (auth.mintFor: that machine, its seats), sign host_accept
serve(B's link) ◄─ op handoff.accept ──
  check ask, signature, invites; append host_changed {epoch 1, bob, B, locator, accept, ask}
  room Claude record left; remote/handoff = moved + invites; reply (B's mirror holds the line: read-your-writes)
  after the reply: claude stop <job>; link file = A's invite; daemon started (A mirrors B)
                                         takeOver: chain checked, daemon stopped, link removed (FsRoomStore),
                                         seats' pid/session back (identity.adoptLocalSeats), room Claude started here
serve(C's link) ─ entry host_changed, ev moved {invite for C} , end moved ─────────► onMoved: link file ->
                                                                                      B + invite; reconnect
```

- **Epochs are enforced, not merged.** The old host's `FsRoomStore.place` refuses every line once its log says the room moved to another machine (`STALE`; a `host_changed` naming this machine at a later epoch, a promote, passes). Its server then serves only `hello`, `subscribe`, `blob.get` and `ping`, so a member that reconnects late still gets the line and its machine's invite (kept a day). A server refuses a hello from a mirror at a later epoch (a host the room moved away from) and an append from another epoch. The link daemon sends its mirror's epoch with both.
- **Unreachable new host.** A re-pointed link that cannot connect stays offline with a reason that names the new host and says to ask for an invite (`/sub-human invite` there) and type its line. That join replaces the link's credentials (the old transport's pinned key and mux kept where the destination is the same), restarts the daemon and marks the link `rebind`, so once the new host's card lets the machine in, a bare `/sub-human` (in a room, with a `rebind` link) joins the seat again over the new link. `sub-human handoff --status` on the new host lists the machines that have not reconnected. Over SSH a re-pointed link keeps what this machine added to it (`hosting.linkTransport`): its own link key (one is made for an old host that had none), `mux` from `sub-human prime`, and the new host's sshd key pinned (a handoff's and a promote's invites carry it); `--via JUMP` on `handoff`/`promote` puts a ProxyJump in the locator. Until the new host lets that key in, the offline reason (and `doctor`) says to ask for an invite.
- **Promote** (`sub-human promote CODE --confirm CODE`, a person's own shell): refused while the link is online or down less than `PROMOTE_OFFLINE_MS` (10 min, `--force`). The member's full mirror becomes the room at epoch + 1 (`host_changed` with `promoted: true`) and prints one invite per other machine. **It can fork**: an old host that was only asleep goes on alone, and lines it wrote that the promoter never got are lost to the room. A member still linked to it stays on the old side until it gets an invite. When the old host returns, `sub-human demote CODE INVITE PIN` sets its log aside (`orphaned-<time>.jsonl`, never merged), stops its room Claude and mirrors the new host. A mirror whose copy is behind the promoter's catches up; one that is ahead (it got lines the promoter never did) meets `FORK` and re-mirrors with `sub-human link --reset`.
- **Limits.** The new host must be reachable by every member over the transport in the ask's locator. For SSH that means the new host must let each member's key in. The design for automating that has members send their SSH public key over the existing link, and the new host shows one consent card to authorize them all. That is not built: today a member that cannot get in is given an invite (`/sub-human invite`), types its line, and the new host's card lets it in; the lab's `handoff` scenario does that. A handoff's invites are `sh2` invites (`auth.mintFor`: a record `{v: 2, handoff: true, machine, seats, expires_at}`), internal: bound to one machine with its seats pre-bound, and with no PIN, since each travels only over that machine's already authenticated link. A promote's invites are sh2 with a 6-digit PIN checked online (`mintFor` `pin: true`), printed as `sub-human demote CODE INVITE PIN` lines: each machine (a member, or the old host coming back) runs its own (`handoff.demote`).

**Versions.** `protocol.PROTO` is the range of protocol versions an end speaks (now 1–2; 2 adds an sh2 invite's PIN) and `PLUGIN_VERSION` its plugin version. The client's `hello` sends `proto` and `client`, with `v` the lowest version that hello needs (1, or 2 with a PIN), so a host from before 0.4, which checks `v === 1` and knows no `proto`, still answers. The server answers `v = negotiate(its range, the hello's)` (a hello without `proto` is `[v, v]`), plus its own `proto` and `server`. No overlap is `PROTOCOL` with `skewMessage`, which names the side to update: "host runs sub-human 0.4.0 (protocol 3–4); you run 0.3.0 (protocol 2). Update your plugin: /plugin update sub-human", or "The host must update" when the joiner is newer; the client rewrites an old host's "protocol vN is not served here" the same way. The daemon stops on it and the join shows it. Readers tolerate a newer host: lines of unknown kinds or fields are stored verbatim and rendered generically (an unknown `via` as "bob (via relay)", never as the person's words, and never a wake), and an unknown streamed document or event is skipped and logged instead of stopping the link. Writes stay strict: the host validates every payload, so a newer joiner's new kind is `INVALID` on an older host (the host is updated first). `test/remote-server.test.js` and `test/remote-link.test.js` fake N-1 and N+1 on both ends.

**What changed for trust.**
- **Sig v2.** A signature covers the payload, not its place in the log (without `id`, `at`, `prev`; with `room`, `from`, `nonce`, `ts`), so the remote hook signs and the host places. v1 lines still verify. The host refuses a replayed nonce and a `ts` outside `SIG_SKEW_MS` (10 min); `at` is the host's clock.
- **Keys are pinned in the log** and strictly: `member_joined` carries the seat's public key, the first key per name is that name's for the room's life, and a lost key means a new name.
- **A link writes only as its own seats.** The server checks every `from` against the seats joined over that link (`mayWriteAs`), validates again and verifies against the pinned key. A `join` needs a proof signed by the seat's key, since the public key alone is in the log.
- **Credentials.** An invite is single-use and shown once; the host keeps its sha256. The link token is a seat-level credential: kept in clear in the joining machine's link file (0600, the same trust as the seat key), hashed on the host. An invite is untrusted input: its locator is only a home path or a plain `user@host[:port]` with plain jump hosts, and the daemon always runs this plugin's own `serve` (or `ssh` with fixed options), never a command or option the invite names. Over SSH the host's forced command decides what runs (the card's admit). An invite's 4-digit PIN is CPace's password: it never travels, guessing is online only (5 tries per invite, counted before the host answers; at most 4 open), and a PIN that holds still waits for the host person's card; it reaches no model (every `join`/`invite`/`admit` prompt is a hidden block, and a PIN join never takes the seat in that step) and leaves the joining machine's link file once the host answered. The Bash guard denies `sub-human invite`, `admit`, `kick`, `prime`, `listen`, `link`, `serve`, `handoff`, `promote`, `demote` and `doctor --fix`/`--bundle` to a model (a plain `doctor` is read only) and sends the person to a terminal outside Claude Code (its `!` mode would put the output in the conversation: run there, `invite` and `promote` mask the PIN). A link the host refused before any token drops its invite and PIN from the link file (`refused` says why). A handoff moves only on the new host person's own card answer, signed with their seat key and kept in `host_changed` beside the old host's signed ask; its invites (sh2, no PIN: a handoff record bound to one machine with its seats pre-bound) travel only over each machine's authenticated link.
- **Over the web, the front sees ciphertext.** Tailscale, Funnel's relays or a reverse proxy end TLS and see IPs, timing and sizes; every byte inside the WebSocket is Noise ciphertext keyed to the listener's own X25519 key (`<home>/listen/host-x25519.json`, 0600, random, never derived from or used for anything else), which the joiner pins from the URL. The listener binds loopback only. A Funnel hostname is public (certificate-transparency logs), so probes cost a PIN try at most, and each wrong PIN is a room line.
- **Addressed is not private.** A post with `to` has its own rate bucket (`RATE_ADDRESSED_MAX`), but the whole room reads the log, on every machine.

**Latency** (Apple M2, node 24; two homes on one machine over the pipe; `test/support/link-bench.js`, `test/support/bridge-bench.js`). Times in ms, p50 / p99.

| | host | remote | overhead |
|---|---|---|---|
| one signed append, bridge up (the link's round trip) | 0.70 / 1.1 | 1.0 / 1.6 | 0.34 / 0.52 |
| `prompt.ts`, a plain prompt (no worker) | 38.2 / 43.2 | 38.3 / 41.7 | 0.1 / −1.5 |
| `prompt.ts`, an `@room` post | 41.3 / 43.8 | 60.0 / 63.1 | 18.8 / 19.4 |
| `presence.ts`, a changed state | 34.7 / 38.3 | 55.8 / 60.3 | 21.1 / 22.0 |

A hook that only reads costs nothing extra; one that writes pays about 20 ms, nearly all of it the worker's boot (about 16 ms), plus a round trip of about 1.5 ms.

**Observability.** `lib/room/link-state.ts` reads how a link is doing: the daemon's state record `<home>/links/<code>.state.json` (`{state: online|connecting|offline|fork|stopped, since, attempt, lastError, rttMs, queued}`; old `up`/`down` records map to `online`/`offline`), else the mirror's `link.json`; a record whose daemon pid is gone reads `offline` (fork and stopped stay). The room row (`lib/rows.ts`, so also the agent statusline) leads with the link while it is not online (`✕ offline 2m · 2 queued`, `… connecting (3)`, `✕ stopped`, `✕ FORK: sub-human link --reset`) and ends with `⇄ online` while it is; the tail's line is `room link: OFFLINE` / `STOPPED` / `FORK` and `back online`; a room hosted here shows nothing. `sub-human doctor` (`lib/cli/doctor.ts`) checks, each with a fix: Node 24.3+, the home's modes (0700), the serve shim and its pointer, `authorized_keys` lines that bypass the shim (`--fix` rewrites this home's), `ssh -V`, and per link its transport, daemon, state and last error (the state record, else the daemon's log) whether the room moved (a handoff or promote re-pointed the link file: where to, and whether this link reached the new host), plus a `hello` without a credential to the host (the server answers it and nothing else; over ssh, BatchMode, with ssh's own error turned into a hint), both protocol versions and, when the reply carries the host's time, the clock skew (warn at 2 min, fail at `SIG_SKEW_MS`). Then Claude Code's version against `cc.MIN_VERSION` / `cc.PROBED_VERSION` (and `cc.probe` of the binary when it differs), settings that turn hooks off, and whether Remote Control is likely available (not with Bedrock, Vertex, Foundry or an API key). `--fix` refreshes the shim, repairs the modes and rewrites old `authorized_keys` lines; `/sub-human doctor` runs `doctor --quick` read only inside the session. `--bundle` writes the report as an allowlist (versions, config timings, verdicts, link states, recent daemon errors) with every free text redacted: `~` for paths under `$HOME`, room codes, host and user names and IPs hashed with a per-bundle salt, SSH keys cut to a fingerprint prefix, invites, tokens and long hex removed; no log entry is ever read into it.

## Security model

One machine per room (its host), trusted collaborators: everyone on the host runs as its one OS user, and the host itself is trusted by everyone who joins it. The threat is a member's Claude (possibly steered by text posted in the room) speaking or consenting as a person. Defences: `via=human` only from hooks, signed with a key only hook processes load (on whichever machine the person sits; the host verifies against the key pinned in the log); the store guard (the hooks module's `mod/guard.ts`, in-process) denies file-tool writes into the store and Bash commands that name it, set `SUB_HUMAN_HOME` or run the plugin's modules; the module's `prompt.submit` gate drops an `@room` whose engine-set origin is not the person's (composer, sdk, bridge), and at-room posts only with that origin and the session's module nonce (a seat requires the module). The module mints the nonce per session id, keeps it in `$.state`, and `mod-hello` writes it to the 0600 lease `<home>/sessions/mods/<sid>.json`: forging an `@room` takes reading that lease, which the guards deny by path but a determined local process can still do. The store guard is a string check: a script file written first, an obfuscated path or a variable built at run time evades it. What it cannot evade: `via=human` needs the seat key's signature, readers mark an unsigned human line "(unverified)", and the hash chain shows an edited log. The room Claude's typed-input refusal reads the origin unchecked, since forging it only refuses more. An `@room` is refused, never passed to the model, whenever the prompt shim fails; consent only from the native dialog; a link writes only as the seats joined over it, an SSH key reaches only its forced command's room and link, and the guard denies `sub-human invite|admit|kick|prime|listen|link|serve|handoff|promote|demote` and `doctor --fix` to a model; the room's host moves only on the new host person's own card answer. Not covered: the `Read` tool, other MCP servers, a hostile local user. Full list: [README → Threat model](../plugin/sub-human/README.md#threat-model).

## Claude Code contract (generated)

Every internal the plugin relies on, from `lib/cc.ts` `CONTRACT`. `§` points into [`docs/internals/cc-2.1.281.md`](internals/cc-2.1.281.md) (changes since: [`cc-2.1.292.md`](internals/cc-2.1.292.md)); each entry also carries the literal binary search strings, and optional code shapes (`~` for a minified identifier), that `npm run probe` checks.

<!-- gen:cc-contract -->
| Id | § | Stability | Note |
|---|---|---|---|
| `task-completed-block-drops-fields` | §1 | incidental | A TaskCompleted block makes TaskUpdate return success:false, updatedFields:[] before the write: every field in that call (subject, metadata, owner) is discarded. |
| `hook-exit2-blocks` | §1 | API | Exit 2 makes stderr the blockingError. |
| `hook-json-block` | §1 | API | {"decision":"block","reason"} is a blockingError. |
| `task-completed-input` | §1 | API | TaskCompleted input has no metadata/owner/status; read the task file (which still has the old status). |
| `task-events-no-matcher` | §1 | API | TaskCreated/TaskCompleted/TeammateIdle have no matcher query: every hook fires. |
| `task-update-schema` | §1 | API | TaskUpdate metadata merges; null deletes a key. |
| `task-create-metadata` | §1 | API | TaskCreate accepts metadata. |
| `env-child-session` | §2 | env | Hooks, Bash, statusLine and subagentStatusLine get CLAUDE_PID and CLAUDE_CODE_SESSION_ID (cc.ENV, sessionId, claudePid). |
| `env-mcp-session` | §2 | env | MCP stdio servers get CLAUDE_CODE_SESSION_ID (fixed at spawn) but not CLAUDE_PID. |
| `env-plugin-mcp` | §2 | env | Plugin MCP servers get CLAUDE_PLUGIN_ROOT/DATA in env. |
| `env-clear-session-id` | §2 | incidental | /clear updates process.env.CLAUDE_CODE_SESSION_ID; running MCP servers keep the old id. |
| `env-nested-strip` | §2 | incidental | A nested claude drops CLAUDE_CODE_SESSION_ID from its env. |
| `hook-input-common` | §2 | API | Common hook input: session_id, transcript_path, cwd, prompt_id?, permission_mode?, agent_id?; no pid. |
| `mcp-stdio-ppid` | §2 | incidental | A stdio MCP server is spawned without a shell (the Linux cgroup wrapper ends in exec), so its process.ppid is the claude pid; the room server resolves its caller that way. Not so when the user sets CLAUDE_CODE_SHELL_PREFIX (cc-2.1.292.md Review spikes, S-mcp a). |
| `mcp-progress-resets-idle-timeout` | §2 | incidental | A tools/call has an idle watchdog (30 min for stdio, CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT) that each notifications/progress resets, and a wall-clock limit (MCP_TOOL_TIMEOUT, about 27.8 h by default) that progress does not extend. mcp/hold.ts beats progress to keep a hold under the idle watchdog (cc-2.1.292.md Review spikes, S-mcp b). |
| `mcp-server-shared-by-subagents` | §2 | incidental | A subagent with no mcpServers uses its parent's MCP clients, so the room tools a subagent calls reach the main thread's server process (cc-2.1.292.md Review spikes, S-mcp c). |
| `plan-mode-attachment` | §3 | incidental | Transcript attachment {type:"plan_mode", planFilePath} (cc.planFile). |
| `exitplan-normalize` | §3 | API | Pre/PermissionRequest hooks on ExitPlanMode see tool_input.plan and planFilePath. |
| `exitplan-strip` | §3 | incidental | plan/planFilePath are stripped before the transcript copy (cc.toolUseInput reads the model's own input). |
| `exitplan-output` | §3 | API | PostToolUse(ExitPlanMode) fires only on approval. |
| `plan-reject-dialog` | §3 | incidental | "No, keep planning" returns deny with the typed feedback. |
| `plan-reject-user-feedback` | §3 | incidental | The rejected tool_result transcript entry carries top-level userFeedback (cc.planFeedback). |
| `plan-reject-text` | §3 | incidental | Fallback: the note sits between "the user said:\n" and "\n\nNote: The user's next message". |
| `plan-reject-remote` | §3 | incidental | Remote Control deny (observed 2.1.292): with a note ("Suggest edits") the terminal's shapes (userFeedback, "the user said:"); a bare deny says "STOP what you are doing…" with no userFeedback: cc.planFeedback null, nothing recorded. An ordinary message typed on the phone right after a bare Deny is attached to the deny as that note (observed live), so a note is never an objection by itself: it waits for the person's Send on the confirm card (hooks/consent.ts). |
| `auq-bridge-racer` | §3 | incidental | A tool with its own permission dialog (AskUserQuestion, the plan view) is raced by Remote Control when the session has bridge callbacks: the phone gets the card and its answer resolves the dialog, as the terminal's would; the tool_response is Claude Code's, never the model's. The confirm card for a review's note relies on it (hooks/consent.ts). A card can still auto-resolve after the askUserQuestionTimeout idle (afkTimeoutMs): then nothing is recorded and the note waits. |
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
| `bg-logs` | §5 | API | `claude logs <id>` replays a bg session's screen; the demo's view of the room's Claude runs it. |
| `daemon-env-filter` | §5 | env | The daemon keeps only allowlisted caller env keys (cc.DAEMON_ENV_ALLOW). |
| `daemon-env-allowlist` | §5 | env | The pieces of the daemon allowlist (zWe + dWn + extras in 2.1.292) that DAEMON_ENV_ALLOW copies. |
| `bg-worker-env` | §5 | incidental | Workers run with the daemon's own process.env plus the filtered dispatch env. |
| `bg-provider-env` | §5 | incidental | Persisted providerEnv is filtered through p0e too. |
| `matcher-rule` | §7 | API | Exact-name list vs unanchored regex (cc.matcherIsExact, cc.matcherMatches). |
| `hook-if` | §7 | API | `if` uses permission-rule syntax; Task tools can only be filtered by bare name. |
| `hook-async` | §7 | API | Per-hook async/asyncRewake fields. |
| `stop-additional-context` | §7 | incidental | Stop hookSpecificOutput.additionalContext continues the turn with that text, like a block but without the red "Stop hook error" line or notification (only real blockingErrors get those). |
| `prompt-origin-composer` | §8 | incidental | prompt.submit origin "composer" is only the person's own Enter (and a --bg dispatch prompt); -p is "sdk", peers "peer" (also from $.session.send), notifications "task-notification". No hook sets it; seen for a --bg dispatch and a mid-turn peer (cc-2.1.292.md Function hooks S2, S6). |
| `transcript-prompt-origin` | §8 | incidental | A typed prompt's transcript user entry has no origin or {kind:"human"} (also typed through Remote Control: prompt.submit reports that one as "bridge"); peers, notifications, channels and plugins carry their own kind. cc.lastHumanPrompt takes only the person's; hooks/consent.ts picks the proposal a review opens from it (cc-2.1.292.md Remote Control). |
| `bridge-forwarded-rows` | §8 | incidental | Remote Control forwards user and assistant rows, a command hook's systemMessage (hook_system_message, shown as an assistant line) and a few system kinds, never a $.ui.log notice (system informational); an isMeta user row goes as isSynthetic (not shown there, as far as seen). A function hook's result has no systemMessage, so the module reaches the phone only through a turn: mod/deliver.ts relays room lines and an @room's refusal there as a prompt while the person types from Remote Control (cc-2.1.292.md Remote Control). |
| `plugin-prompt-frame` | §8 | incidental | A plugin's $.prompt.submit between turns enters framed ("The <plugin> plugin sent a message: … This is how Claude Code surfaces a prompt a plugin submits between turns … Address the message above."), and the frame is the row Remote Control shows; asUser:true enters the text bare (the origin stays {kind:"plugin", name, asUser:true}, so cc.lastHumanPrompt still skips it). The relay submits asUser with only the room lines; what the model needs rides as context (cc-2.1.292.md Remote Control). |
| `cross-session-inbound` | §8 | API | crossSessionInbound accept\|hold\|refuse; the room's Claude sets accept. |
| `harbor-kite-gate` | §8 | env | Cross-session messaging gate (default on). |
| `pasted-content` | §8 | incidental | Long pastes are wrapped in <pasted_content id="N"> (cc.PASTED_RE). |
| `session-title-address` | §8 | incidental | A hook's sessionTitle renames the session and writes the name to the session registry; ListAgents lists it and SendMessage `to` matches it exactly, so NAME.CODE is the address. Names are unique among live sessions: a second live session given the same name takes a suffixed one and is not reachable at NAME.CODE (cc-2.1.292.md Review spikes, S-title). |
| `plugin-settings-allowlist` | §9 | API | Plugin settings.json keeps only agent and subagentStatusLine. |
| `subagent-statusline-precedence` | §9 | incidental | Any user/project/local/flag subagentStatusLine overrides the plugin's. |
| `subagent-statusline-raw` | §9 | incidental | subagentStatusLine command gets no ${CLAUDE_PLUGIN_ROOT} substitution nor PLUGIN_ROOT/DATA env. |
| `hook-events` | §10 | API | The hook event list; no plan-approved/rejected event. |
| `hooks-modules` | §10 | env | Function hooks load for installed plugins by default (GrowthBook tengu_plugin_hooks_modules, default on). An installed plugin names its module in hooks.json `modules`; "hooks/register.ts" is only the built-in plugins' fixed path. sub-human ships one, mod/register.ts, named in hooks.json. |
| `hooks-json-modules` | §10 | API | One hooks.json carries the command hooks and one module path under `modules` (relative to hooks.json); a second module is refused (S1). |
| `module-dollar-local` | §10 | incidental | A module that passes $ to an imported function does not load (validate says the same): every $ call sits in the file that registers the hook, so mod/core/*.ts stays $-free (S1). |
| `module-event-once` | §10 | incidental | A hooks module registers an event at most once without a matcher (validate and the loader refuse a second): mod/deliver.ts owns session.start, the join and SessionStart (hello and the tail child), mod/prompt.ts owns prompt.submit (the gate, rows context, presence). |
| `modules-headless` | §10 | env | Modules are off only diskless or in a tool server's daemon (then by policy, safe mode, --bare): they load in -p and in a --bg worker such as the room's Claude. A --bg dispatch prompt reaches prompt.submit as origin composer (S2). |
| `classic-chain-order` | §10 | incidental | A classic.<Event> chain is [managed settings hooks, ...modules in load order, core], and core runs every other settings hook. A module that answers without next() therefore skips every non-managed settings hook for that call (its own plugin's, other plugins' and the user's and project's command hooks) and the modules of plugins loaded after it; managed hooks and earlier-loaded modules still run (S1, S5; cc-2.1.292.md Review spikes, S-skip). sub-human answers without next() only where it blocks or stops a prompt (classic.UserPromptSubmit, TaskCompleted) and for the /sub-human expansion whose join its command.run hook already ran (classic.UserPromptExpansion: the join hook beneath must not run twice); it no longer answers PreToolUse. |
| `prompt-submit-ups-order` | §10 | incidental | prompt.submit's core runs the UserPromptSubmit hooks: prompt.submit (module) -> classic.UserPromptSubmit (module) -> the command hook. A peer delivered mid-turn takes the same path, with turnId set (S6). mod/prompt.ts relies on it: classic.UserPromptSubmit runs inside prompt.submit's next(e), so prompt.submit hands it e.origin (the classic payload has none) in a module variable. |
| `usermessage-draw-only` | §10 | incidental | A ui.render rewrite of UserMessage text changes only the drawing; origin, isExpanded, task and from are pinned. |
| `plugin-types-state` | §10 | incidental | validate refuses a $.state value the plugin's own types contract (plugin.json "types": types/index.d.ts) does not declare in PluginState; sub-human declares sub-human.hello. |
| `session-append-note` | §10 | incidental | $.session.append writes a user row as isMeta (the model reads it from the loop's next top; an idle session is not woken) and a system row as a notice the model never reads (S4). |
| `session-append-notice-hidden` | §10 | incidental | A $.session.append system row is stored at level "info": drawn only in the ctrl+o transcript view (also after --resume), never in the default view. Chat lines go through $.ui.log instead (S4). |
| `ui-log-notice` | §10 | incidental | $.ui.log lines are stored as system notices at level "notice": drawn dim as "<plugin>: <text>" in the default view, kept across --resume, never read by the model, no wake (S4). One line each: a newline in the text is drawn as U+FFFD (cc-2.1.292.md Function hooks), so mod/deliver.ts logs a chat batch line by line. |
| `command-run-every-command` | §10 | incidental | command.run fires for every slash command the person runs, a plugin's skill included (/sub-human), before it expands; a hook that answers without next() runs no command, so no UserPromptExpansion hook and no model turn. |
| `command-run-empty-answer` | §10 | incidental | An answer {} (no text, no context) of a typed prompt adds no row at all: the command line is not echoed and nothing reaches the model; a {text} answer is the command's output row, shown under "sub-human: " (the hooking plugins' names) and read by the model with its echoed command line (local_command rows go to the API), and the model repeats it on its next turn (seen live), so the module shows replies with $.ui.log and answers {text} only through Remote Control, for a prompt and a reply that hold no secret. A prompt run by the SDK, or with pasted blocks before it, is echoed as a user row even then: the module leaves those to the classic hook. |
| `expansion-block-frame` | §10 | incidental | A UserPromptExpansion block is drawn as a warning "UserPromptExpansion operation blocked by hook:\n<reason>" (never read by the model), and the expansion stops at the first block, before that hook's systemMessage is read: a block shows its reason alone. The classic join hook (no module) still answers this way. |
| `modules-switch-cache` | §10 | incidental | Claude Code caches the hooks modules rollout switch in the global config's cachedGrowthBookFeatures (cc.modulesSwitch): false there explains a session with no module (hooks/join.ts noModule, doctor). |
| `fs-write-plain` | §10 | incidental | $.fs.write is mkdir -p plus writeFile: not atomic, no mode, no lock. The mod never writes room state. |
| `process-run-stdin` | §10 | API | $.process.run takes argv, stdin, env over the host env and a timeout. The child's parent is the claude process, but it gets no CLAUDE_PID or CLAUDE_CODE_SESSION_ID of this session (only whatever claude itself inherited), so shims pass the payload session_id (S3). |
| `plugin-test-discovery` | §10 | incidental | `claude plugin test` collects every *.test.ts(x) under the plugin; node tests stay *.test.js (S8). |
| `plugin-test-off` | §10 | env | With modules off, `claude plugin test` exits 1 printing "claude plugin test: hooks modules are turned off ..."; npm test reads that as a skip (S8). |
<!-- /gen:cc-contract -->

## Modules (generated)

`lib/` only; each line is the module's header comment, whose full text documents its exports.

<!-- gen:lib-modules -->
- `lib/cc.ts`: the single home for every Claude Code internal the plugin relies on.
- `lib/cli/args.ts`: the one flag parser of scripts/sub-human and lib/cli/*.ts.
- `lib/cli/doctor.ts`: `sub-human doctor`, what is wrong with this machine's sub-human and how to fix it, and `doctor --bundle`, the same as redacted JSON to attach to a bug report.
- `lib/cli/handoff.ts`: the CLI bodies of moving a room's host (lib/handoff.ts), for scripts/sub-human.
- `lib/cli/host.ts`: the host's and the joiner's setup commands of scripts/sub-human, in the person's own shell (the Bash guard refuses them to a model).
- `lib/cli/listen.ts`: the host's web listener commands of scripts/sub-human, in the person's own shell (the Bash guard refuses them to a model).
- `lib/cli/main.ts`: the body of scripts/sub-human (a thin shim kept at its path: persisted artifacts run it), the read-only CLI over the room.
- `lib/cli/types.ts`: the shared types of lib/cli/*.ts (type-only; nothing here runs).
- `lib/clock.ts`: A tiny injectable clock, so code that waits (the `sub-human tail` settle and poll loops) can be tested without real sleeps.
- `lib/config.ts`: every timing and size cap in one place, named. Callers import the value they use; an env override is read by the caller through envMs() at the moment it needs the value (tests set the env per child process, some per call).
- `lib/handoff.ts`: moving a room's host to another member's machine. The host's machine holds the room's log, serves its links and runs its room Claude (billed to the host person's model account); a planned handoff moves all three before the host closes their laptop.
- `lib/home.ts`: where the plugin's store lives on this machine, and which machine this is.
- `lib/identity.ts`: where rooms live, who is in them, and which Claude session is asking.
- `lib/io.ts`: small file and process helpers shared by every module.
- `lib/lock.ts`: the one lockfile helper (room log, members.json, proposals, the task mirror, the row map).
- `lib/notices.ts`: join / leave lines for every human in the room, as a group chat shows them: "bob joined", "bob rejoined", "bob left" (no room code, no ids).
- `lib/proposal.ts`: proposals and the consent card. Every write goes through room.append().
- `lib/remote/admission.ts`: the host person's consent to a machine that typed an invite's PIN.
- `lib/remote/auth.ts`: invites and link tokens, on the host. An invite is single-use and turns into a link token at the first hello; the token is the link's credential from then on.
- `lib/remote/bridge.ts`: a synchronous call from a hook's thread to asynchronous work on a worker thread, with a deadline.
- `lib/remote/client.ts`: the asynchronous side of the protocol, one connection to a room's server over a transport.
- `lib/remote/cpace.ts`: CPace (draft-irtf-cfrg-cpace-21) with the cipher suite CPACE-RISTR255-SHA512, initiator-responder mode, plus the draft's explicit key confirmation (section 10.4).
- `lib/remote/enroll.ts`: the short invite's join. The host shows `/sub-human join you@box vole-8126 4829` (or a URL and the PIN); the 4-digit PIN is the whole secret, and it never travels: both ends run CPace (lib/remote/cpace.ts, ristretto255 + SHA-512, initiator-responder, explicit key confirmation) with it.
- `lib/remote/hosting.ts`: the host's side of an invite, one step each, shared by the join hook (`/sub-human invite`, `/sub-human kick`: their output is a block reason, shown to the person and never to the model) and the CLI (lib/cli/host.ts).
- `lib/remote/link.ts`: the link daemon, one per machine and room (`scripts/sub-human link CODE`, started detached by the join hook, like the room's Claude starter).
- `lib/remote/listener.ts`: the host's WebSocket listener daemon (`scripts/sub-human listen [--port 7420]`), one per home.
- `lib/remote/noise.ts`: the end-to-end channel inside a WebSocket (lib/remote/transports/ws.ts): Noise_NK_25519_ChaChaPoly_SHA256 (https://noiseprotocol.org/noise.html, revision 34), built on node:crypto only: X25519 through crypto.diffieHellman on KeyObjects, ChaCha20-Poly1305 (12-byte nonce: 4 zero bytes and the 64-bit little-endian counter), SHA-256, and the spec's HKDF, which is RFC 5869 HKDF-SHA256 with salt = ck and no info (crypto.hkdfSync).
- `lib/remote/outbox.ts`: the bounded @room outbox of a mirror. While the link is down, a person's @room post (already signed by the hook, so its nonce and ts are fixed) is kept here by the link daemon (lib/remote/link.ts, the file's one writer) and placed in order once the link is back.
- `lib/remote/protocol.ts`: the wire protocol between a link (lib/remote/client.ts, on the machine of a remote member) and a room's server (lib/remote/server.ts, on the host): the ops, the frame shapes, the error codes and the line codec.
- `lib/remote/server.ts`: one connection to a hosted room. `scripts/sub-human serve --stdio CODE` runs one per connection on the host (spawned by the client's pipe transport, or by an SSH forced command); the store contract test runs one on a worker thread over the memory transport.
- `lib/remote/shim.ts`: the stable `<home>/bin/serve` shim that an SSH forced command runs, and the authorized_keys lines that name it.
- `lib/remote/sshkeys.ts`: the SSH key material of an ssh link, on both machines.
- `lib/remote/tailscale.ts`: the few `tailscale` CLI calls `/sub-human invite --web \| --public` makes, each with a timeout, none interactive.
- `lib/remote/transports/index.ts`: the transport contract and the registry of kinds. A transport carries protocol frames (lib/remote/protocol.ts) between a client and a server and knows nothing about them.
- `lib/remote/transports/memory.ts`: the in-process transport, a connected pair over a MessageChannel, so the two ends may live on different threads (the store contract's remote backend runs the server on a worker: a thread that makes synchronous bridge calls must never host the server).
- `lib/remote/transports/pipe.ts`: frames over a pair of pipes: a child process's stdio on the client side, this process's stdin/stdout on the server side (`scripts/sub-human serve --stdio CODE`).
- `lib/remote/transports/ssh.ts`: the ssh kind, the pipe kind (./pipe.ts) with an `ssh` command in front.
- `lib/remote/transports/ws.ts`: the `wss` and `ws` kinds (./index.ts register): protocol frames over a Noise_NK channel (lib/remote/noise.ts) inside a WebSocket (lib/remote/ws.ts) to the host's listener (lib/remote/listener.ts), usually through a TLS front: Tailscale Serve or Funnel, or any HTTPS reverse proxy.
- `lib/remote/types-core.ts`: types only (erased at run time) for the remote core: the wire protocol, the host's invite and link records, and the link daemon's records.
- `lib/remote/types-rest.ts`: the shared types of the transports, the invites (enroll, admission, hosting, webhost) and the listener.
- `lib/remote/webhost.ts`: the host's side of a join over the web (1.1), shared by the join hook (`/sub-human invite --web`, `--public`, `--url URL`, `/sub-human invite --stop`: block reasons the person reads, never the model) and the CLI (lib/cli/host.ts).
- `lib/remote/ws.ts`: a minimal WebSocket (RFC 6455) with no dependencies: the server end for the host's listener (lib/remote/listener.ts, an http server on 127.0.0.1 only) and the client end for the joiner's link daemon (lib/remote/transports/ws.ts) over net or tls, through an HTTP CONNECT proxy when the environment names one (a corporate network that allows only CONNECT to 443).
- `lib/room-claude.ts`: the room's own Claude (member claude, SendMessage name claude.CODE), a headless `claude --bg` session the join hook starts.
- `lib/room.ts`: the room log (envelope v3). A facade over lib/room/*, so callers keep one require.
- `lib/room/consent.ts`: the one fold of the room log into proposal / consent state.
- `lib/room/envelope.ts`: the signed envelope (sig v2) and the keys pinned in the log.
- `lib/room/lanes.ts`: who a log entry concerns, and the proposal queries that decide it.
- `lib/room/link-state.ts`: how this machine's link to a room hosted elsewhere is doing, for the room row (lib/rows.ts), the agent statusline (statusline/segments.ts), `sub-human doctor` (lib/cli/doctor.ts) and the tail's link line (lib/tail.ts linkLine).
- `lib/room/links.ts`: the link registry on this machine: which rooms are mirrors of a room hosted elsewhere, and how to reach them.
- `lib/room/members.ts`: the members document's rules, shared by every RoomStore (as placeAfter is for the log), so a seat is judged the same whichever machine holds the room.
- `lib/room/render.ts`: log entries as text, for Claude (ids kept) and for people (no ids).
- `lib/room/store-mirror.ts`: MirrorRoomStore, the RoomStore of a room hosted on another machine: an FsRoomStore directory kept byte-identical to the host's log by the link daemon (lib/remote/link.ts), so every reader (readView, log.idx, tailer, verifyChain, rows, digests) works unchanged.
- `lib/room/store.ts`: the RoomStore seam, and FsRoomStore, its implementation over the room directory on this machine.
- `lib/room/types.ts`: the room's shared shapes, types only (import type).
- `lib/room/validate.ts`: the room log's envelope rules (envelope v3): which kinds each `via` may write, the fields a caller may set, and the task fields of task_req / task entries. append() (store.ts) runs validate() before it signs, and place() runs it again on the payload before it takes the log lock.
- `lib/rows.ts`: participant rows in the agent panel. Reads the room log, members and presence; writes only the rows/* documents (lib/room/store.ts kv).
- `lib/seats.ts`: entering and leaving a room, the one sequence the join hook, the session-end hook and the remote server (lib/remote/server.ts, for a seat on another machine) all run.
- `lib/tail.ts`: the room tail behind `sub-human tail` (scripts/sub-human), the hooks module's child (mod/deliver.ts).
- `lib/tasks.ts`: the room's shared task list. The headless room Claude's own native task list (CLAUDE_CODE_TASK_LIST_ID=sh-CODE) is the room's list.
- `lib/text.ts`: the string helpers and name patterns every module shares.
- `lib/types-app.ts`: shared types of the app slice (tail, rows, proposal, handoff, room-claude, tasks, seats, notices).
- `lib/vendor/noble/curves/abstract/curve.js`: Methods for elliptic curve multiplication by scalars.
- `lib/vendor/noble/curves/abstract/edwards.js`: Twisted Edwards curve. The formula is: ax² + y² = 1 + dx²y².
- `lib/vendor/noble/curves/abstract/fft.js`: Experimental implementation of NTT / FFT (Fast Fourier Transform) over finite fields.
- `lib/vendor/noble/curves/abstract/frost.js`: FROST: Flexible Round-Optimized Schnorr Threshold Protocol for Two-Round Schnorr Signatures.
- `lib/vendor/noble/curves/abstract/hash-to-curve.js`: Produces a uniformly random byte string using a cryptographic hash function H that outputs b bits.
- `lib/vendor/noble/curves/abstract/modular.js`: Utils for modular division and fields. Field over 11 is a finite (Galois) field is integer number operations `mod 11`.
- `lib/vendor/noble/curves/abstract/montgomery.js`: Montgomery curve methods. It's not really whole montgomery curve, just bunch of very specific methods for X25519 / X448 from [RFC 7748](https://www.rfc-editor.org/rfc/rfc7748) @module
- `lib/vendor/noble/curves/abstract/oprf.js`: RFC 9497: Oblivious Pseudorandom Functions (OPRFs) Using Prime-Order Groups. https://www.rfc-editor.org/rfc/rfc9497
- `lib/vendor/noble/curves/ed25519.js`: ed25519 Twisted Edwards curve with following addons: - X25519 ECDH - Ristretto cofactor elimination - Elligator hash-to-group / point indistinguishability @module
- `lib/vendor/noble/curves/utils.js`: Hex, bytes and number utilities. @module
- `lib/vendor/noble/hashes/_md.js`: Internal Merkle-Damgard hash utils. @module
- `lib/vendor/noble/hashes/_u64.js`: 
- `lib/vendor/noble/hashes/sha2.js`: SHA2 hash function. A.k.a. sha256, sha384, sha512, sha512_224, sha512_256.
- `lib/vendor/noble/hashes/utils.js`: Checks if something is Uint8Array. Be careful: nodejs Buffer will return true. @param a - value to test @returns `true` when the value is a Uint8Array-compatible view. @example Check whether a value is a Uint8Array-compatible view.
<!-- /gen:lib-modules -->

Elsewhere: `hooks/common.ts` (shared hook plumbing: `readInput`, `resolveSeat`, output helpers), `hooks/seat-key.ts` (the signer), `scripts/sub-human` (the read-only CLI and the tail entry), `statusline/` (row text), `agents/` (`room-claude`, `room`, `participant`), `skills/sub-human/` (the join skill and the role texts the hooks inject).

## TypeScript

The runtime (`lib/`, `hooks/`, `mcp/`, `statusline/`, `mod/`) is ESM `.ts` with no build step: what is committed is what runs. Plan and reasoning: [archive/TYPESCRIPT.md](archive/TYPESCRIPT.md).

- **Node strips the types** of each `.ts` it loads (Node 24.3+, the first 24 without an ExperimentalWarning). Only erasable syntax works (no `enum`, `namespace`, parameter properties or decorators: `erasableSyntaxOnly`), and every import spells out its `.ts` specifier. `hooks.json` checks the Node version and `/sub-human` says when it is too old.
- **The hooks module** (`mod/register.ts`) runs in Claude Code's Bun worker, which transpiles it itself.
- **Nothing checks types at run time.** `tsc` (root `tsconfig.json`: `strict`, `noUnusedLocals`, `noEmit`) runs only in `npm test` (`npm run typecheck`) and CI. `typescript` and `@types/node` are root devDependencies; `plugin/sub-human/package.json` is only `{"type":"module"}`, so Claude Code installs nothing.
- **Claude Code's types** come from `typings/claude-code/`, a committed snapshot of the declarations Claude Code writes beside a hooks module (`import type … from 'claude-code'`).
- **Shared types** live beside their slice: `lib/room/types.ts` (entries, the store), `lib/remote/types-core.ts` and `types-rest.ts` (the wire, links), `lib/types-app.ts` (seats, the tail, rows), `hooks/types.ts` (hook payloads), `mod/core/types.ts`, `lib/cli/types.ts`, `mcp/types.ts`.
- **`scripts/sub-human` stays JavaScript.** Its path is frozen (the serve shim, `authorized_keys` lines, the row launcher and the daemons run it), and node strips no types from an extensionless file, so it is a shim that imports `lib/cli/main.ts`.
- **Compile cache.** Every node command preloads `hooks/compile-cache.js` (`node --import …/compile-cache.js …/X.ts`: `hooks.json`, `.mcp.json`, `shimArgv`), plain JS that turns on `module.enableCompileCache()` before the hook's modules load. Without it each run strips every module again (about 50 ms a hook); with it a hook starts within about 5 ms of the old JavaScript.
- **Lazy loads.** A module that must load only past an early exit, or that breaks an import cycle, is loaded with `createRequire(import.meta.url)` at that point (`require(esm)` is synchronous and cached) and typed `typeof import('./x.ts')`. Everything else is a static named import; there are no default exports.

## Performance

Everything is a `node` start, so the number of processes per event is the main cost (from the hook map above):

| Event | Node starts |
|---|---|
| a prompt, session with no seat | 0 (an `@room` there: 1, its refusal) |
| a plain prompt, seated member | 0 while the tail child delivers and no review may be open (the session's first prompt: 1); +1 `presence.ts`, not awaited, when the last presence was not "working" |
| an `@room` post | 1 (`prompt.ts`, through the module: signing) |
| a prompt in the room Claude's session | 1 (`prompt.ts`: its refusal of typed input) |
| turn end (Stop) | 0 while no review may be open; else 1 (`consent.ts`) |
| `Bash`, `Write`/`Edit` | 0 (the module's in-process guard) |
| a room MCP tool | 1 (`consent.ts` PreToolUse; it exits after reading stdin outside plan mode) |
| a member's own `TaskCreate`/`TaskUpdate`/completion | 0 (the room's Claude: 1, `tasks.ts`) |
| session start, a join, `/clear` | +1 (`mod-hello.ts`) |
| `Agent`/`Task` | 2 (`row-guard.ts`, `row-map.ts`) |
| `ExitPlanMode` during a review | up to 3 (Pre, PermissionRequest, Post) |
| other tools (`Read`, `Grep`, …) | 0 |

Long-lived per seated session: the tail child and the MCP server (one idle `node` each); a session with no seat runs only the MCP server. Measured in the audit waves: the at-room hook at **36 ms with a 100k-entry log** (was 243 ms before `log.idx` and tail-only reads), `append` **1.8 ms**. `append` reads only the log's tail for `id` and `prev` (a person's entry also reads back `2 × SIG_SKEW_MS` for its nonce, and the pinned keys from the non-chat lines `log.idx` marks); readers keep a per-file cache and parse only appended bytes.

## Testing

- `npm test`: `npm run typecheck` (strict `tsc`, zero errors), then `node --test` over `plugin/sub-human/test` (each file in its own process, in parallel; `test/helpers.js` strips `CLAUDE*` env and removes temp dirs) and `scripts/test`. Hooks are driven as child processes with JSON payloads (`test/hooks/`). The tail runs on a fake clock (`lib/clock.ts`).
- **Store contract**: `test/store-contract.test.js` runs one suite against `FsRoomStore`, `MemoryRoomStore`, the thread store and `remote` (a mirror through the bridge to a server on a worker thread); `store-bypass.test.js` checks nothing else touches room files; `security.test.js` checks who can load the signer.
- **CI**: `.github/workflows/ci.yml` runs `npm test` and `npm run test:thread-store` on Node 24.3.0, 24 and 26 (ubuntu) and Node 24 (macOS), `node scripts/check-version.js origin/<base>` on pull requests, and a separate job runs `npm run test:remote-docker` (Docker on ubuntu). Without Claude Code the mods tests and the probe test skip.
- **No timing guesses**: a test waits on a condition (a gate file the stub claude waits for, a child's pid, `test/support/started.js` stamping a child's start) or reads what the code asked for (the link's retry delays), never on a sleep that a loaded machine outruns. `npm test` passes with four copies running at once.
- **Probe**: `npm run probe` (`scripts/probe-cc.js`, through `cc.probe`) checks the installed Claude Code binary for every `CONTRACT` search string and shape (about 3 s: one latin1 view, each shape tested only around its longest literal); `test/cc.test.js` runs it when a binary is present and bounds its CPU time, not its wall time. No search names a minified identifier (shapes use `~` instead), so a miss means the code itself changed: re-read that spot and record what changed in a new `docs/internals/cc-<version>.md`.
- **Docs**: `npm run docs` regenerates this file's tables; `scripts/test/arch-doc.test.js` fails when they are stale.
- **Remote**: `remote-protocol`, `remote-server` and `remote-link` tests cover the wire, auth and the daemon; `remote-e2e.test.js` runs two homes on one machine with the real hooks as child processes and the daemon over the pipe transport. `npm run test:thread-store` runs the hook tests with every store call over the bridge. `npm run test:remote-docker` (opt-in, needs Docker; `scripts/remote-docker/harness.js run`) checks SSH for real: a devbox container (sshd, the host room, alice) behind toxiproxy, bob joining from this machine with the real hooks and a throwaway key, and 11 assertions (distinct machines, nothing host-only on the joiner, serve under sshd as the forced command, bytes on the wire, cut and resume with no gap, a latency toxic, wrong-link AUTH, nothing left behind); it writes an evidence bundle to `/tmp/sub-human-remote-proof-<time>/`. `harness.js up|say|cut|heal|latency|down` keeps the same stack up for real Claudes to join by hand (`up --host-seat NAME --joiners A,B`: per joiner a key, an invite and `/tmp/sub-human-remote-manual/NAME.env`).
- **Demo**: `scripts/demo.sh` drives scenes S1–S11 with real sessions in tmux (S11: a third seat from a second home over the pipe link) (real cost; run only when asked). `scripts/checks.js` then labels each check **deterministic** (log, chain, files, panes: a failure exits 1) or **behavioural** (model-call counts, wakes, noise: compared against `scripts/baselines.json` thresholds, warn only). `scripts/walkthrough.js` builds `docs/rebuild/walkthrough.html`.
- **Mods**: `npm run test:mods` runs `claude plugin test plugin/sub-human` (the `mod/test/*.test.ts` wiring tests; it skips without a 2.1.292+ binary or with hooks modules off); `npm test` runs it last. `test/mod-core*.test.js` test `mod/core` (and the copied constants against `lib/`) and `mod-hello.ts` in node, and check `validate`'s report: every gating hook has a `.catch`, and `HOOKS` lists what the module registers.
- `npm run validate`: `claude plugin validate plugin/sub-human --strict`.
