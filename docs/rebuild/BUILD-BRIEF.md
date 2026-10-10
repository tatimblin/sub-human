# Build brief: rebuild per `docs/archive/rebuild-plan.md`

Five agents work in parallel, A–E. Each owns separate files.

**Read first:**
- `docs/archive/rebuild-plan.md`, the spec;
- `plugin/sub-human/README.md`;
- the experiment reports your area cites, in `docs/archive/experiments/E1..E3`, `P0` and `docs/archive/native/*`.

**Working prototypes** of the new mechanisms already exist. Borrow from them freely:

| Mechanism | Prototype |
|---|---|
| Elicitation sign-off | `/tmp/exp-2/plugin/mcp/room-server.js` (the `request()` helper and the E2 section) |
| hold rows | `/tmp/exp-3/plugin/mcp/rows-server.js` and `/tmp/exp-3/plugin/agents/*` |
| Nested room rows, `RESPAWN` | `/tmp/p0/plugin/mcp/hold.js`, `/tmp/p0/plugin/agents/*`, `/tmp/p0/sl.sh` |
| Participant-row agent | `/tmp/exp-1/plugin/` |

Claude Code 2.1.281 is installed at `/opt/homebrew/Caskroom/claude-code@latest/2.1.281/claude`. It's a Bun binary, so search it with `strings … | grep`.

## Rules

- **Edit only the files you own** (see below). If you need a change in someone else's file, write it under "Requests" in your report. Don't make the change yourself.
- **Don't touch:**
  - the running demo: tmux `shd-*`, `/tmp/sh-live`, and its numbered tmux sessions;
  - `~/.claude`, `~/.claude.json` and any settings file.
- **Tests.** Use `node --test plugin/sub-human/test` with zero dependencies, Node built-ins only. Add or update tests for what you own. Delete the tests of features you remove.
  - Other agents edit at the same time, so a failure in a file you don't own isn't yours to fix.
  - Your own tests must pass.
- **Live probes** are optional and must be cheap: `--model haiku`, in your own `/tmp/build-<A..E>/`, with `SUB_HUMAN_HOME` pointed there. Kill whatever you start.
- **Git.** Don't commit; the coordinator commits.
- **Report.** End with a report of at most 15 lines:
  - what you changed;
  - tests (pass count);
  - deviations from this brief;
  - requests to other owners;
  - anything unverified.

## Shared contracts (all agents rely on these exactly)

### Names

| Thing | Name |
|---|---|
| Plugin | `sub-human` |
| MCP server | `room` |
| MCP tools | `mcp__plugin_sub-human_room__<tool>` |
| Plugin agents | `sub-human:room-claude`, `sub-human:participant`, `sub-human:room` |
| Skill | `sub-human:sub-human` |

### Room storage (unchanged)

Rooms live under `~/.sub-human/rooms/<code>/`, or `$SUB_HUMAN_HOME/rooms/<code>/`. The room keeps:
- `log.jsonl`, the hash-chained log;
- `members.json`;
- `plans/<hash>.md`.

New per-session files (row state) live in `<room>/rows/`. They're owned by B.

### `hooks/hooks.json` (the coordinator owns it; already written)

| Event | Matcher | Script | Owner |
|---|---|---|---|
| UserPromptExpansion | `^(sub-human:)?sub-human$` | `join.ts` | A |
| UserPromptSubmit | — | `at-room.ts` | A |
| PreToolUse | `ExitPlanMode` | `plan-gate.js` | C |
| PreToolUse | `Bash\|Write\|Edit\|MultiEdit\|NotebookEdit\|mcp__plugin_sub-human_room__.*` | `guard.ts` | A |
| PostToolUse | `ExitPlanMode` | `plan-result.js` | C (room Claude only) |
| PreToolUse | `Agent\|Task` | `row-guard.ts` (deny a row spawn whose hold is live) | B |
| PostToolUse | `Agent\|Task` | `row-map.ts` | B |
| SubagentStop | — | `row-hold.ts` | B |
| SessionStart | all | `row-launcher.ts` (writes the subagentStatusLine launcher) | B |
| SessionStart | `compact\|clear\|resume` | `session-restore.ts` | A |
| PreCompact | — | `precompact-note.js` | A |
| SessionEnd | — | `session-end.ts` | A |
| Notification | `idle_prompt\|permission_prompt` | `presence.ts` | A |
| StopFailure | — | `presence.ts` | A |

`plan-backup.js` and `stop-feedback.js` are deleted (C deletes them and their tests).

### Identity (owner A, `lib/identity.ts`)

There is no process-ancestry walking and no `pid_start` checks. The exported API:
- `join({code, name, role, pid, session_id, cwd})`
- `leave(code, name)`
- `readMembers(code)`
- `resolveBySession(session_id)`, used by hooks;
- `resolveByPid(pid)`, used by the MCP server with `process.ppid`. It does a direct lookup of a registered claude pid.
- `resolveSelf()`, used by the CLI and monitor:
  1. `CLAUDE_CODE_SESSION_ID` (or whichever env var Claude Code really sets; A verifies it), then
  2. the nearest ancestor pid that is a registered member pid, as a plain lookup.
- `openRooms()`, which returns open room codes. A room is open when it has a live room Claude.
- `home()`, `roomDir(code)`, `newCode()`

Each returns `{code, name, role: 'claude'|'member', session_id, pid}` or null.

### Room server plug-ins (owner A, `mcp/room-server.ts`)

The server loads `./hold.js` (B) and `./signoff.js` (C). Each exports `create(ctx)`, which returns `{ tools: [toolDef], call(name, me, args, meta) }`. `call` returns a result or a Promise of one; `meta` is `{ id, progressToken }`.

The `ctx` object:

| Member | Purpose |
|---|---|
| `send(msg)` | Raw JSON-RPC message to the client. |
| `notify(method, params)` | Client notification. |
| `request(method, params)` | Server→client request. Returns `Promise<result>` and rejects on error. |
| `progress(progressToken, progress, message)` | Progress notification. |
| `onCancel(requestId, fn)` | Called on `notifications/cancelled` for that request id. |
| `whoami()` | Resolves `me` via `resolveByPid(process.ppid)` and binds the room. Returns `me` or null. |
| `clientCaps()` | The client capabilities from `initialize`, e.g. `.elicitation`. |
| `room`, `identity`, `planLib` | The libs. |
| `text(s, isError)` | Builds an MCP text result. |
| `log(...a)` | Debug log to `$SUB_HUMAN_HOME/mcp-debug.log`. Only writes when `SUB_HUMAN_DEBUG=1`. |

- A plug-in may start its own timers in `create`; for example, signoff polls whoami and the log.
- The server keeps `post`, `read` and `plan`. It **removes `watch`**.
- `plan()` drops `stub`, and returns `{hash, rev, approvers, matrix, decided, path, plan}`.

### Rows (owner B)

**`lib/rows.ts`** exports:
- `rowCalls(me, members)`: text for the model listing the exact Agent calls to make. A's `join.ts` and `session-restore.ts` and D's role text use it; don't hand-copy it.
- `rowText(code, participantName, viewerName)`: deterministic row text from the log and presence.

**Room Claude rows.** One background `sub-human:participant` per member. Its prompt is `member: NAME`. It calls `hold({member: NAME})` once and never returns while the viewer is in the room: when NAME leaves the row reads `left` and is live again on rejoin (one row per member, ever). `hold` returns `STOP` when the viewer leaves, or at once for a duplicate (a second live hold for the same row); `hooks/row-guard.ts` (PreToolUse Agent) denies the duplicate spawn itself.

**Member rows.** One background `sub-human:room` agent, labelled with the room code.
- It spawns a `sub-human:participant` child for each **other** member except the room's Claude. It also calls `hold({room: CODE})`, which returns `JOINED NAME` or `RESPAWN NAME`; on either, it spawns that child and holds again.
- When the member leaves, `hold` returns `STOP`.

**Agent → participant map.** `row-map.ts` (PostToolUse Agent) records each agent id → participant or room in `<room>/rows/<session_id>.json`. `subagentStatusLine` reads that file.

**Plugin `settings.json`.** It sets `{"subagentStatusLine": {"type":"command","command":"<launcher path>"}}`. `${CLAUDE_PLUGIN_ROOT}` is empty there. So `row-launcher.ts` writes a launcher, at a fixed path B chooses and verifies (for example `~/.sub-human/bin/row-status`), that execs `node <plugin>/bin/sub-human agent-statusline`.

**The `sub-human` CLI.** B adds or keeps the `agent-statusline` and `statusline` subcommand logic in `statusline/*.ts`. `bin/sub-human` dispatches to them and is owned by C.

### Sign-off (owner C)

**`mcp/signoff.js`.**
- When a `plan_rev` appears whose `approvers` include `me`, it sends an `elicitation/create` with:
  - message: room, hash, rev, a 3-line summary, and the plan path or `sub-human plan`;
  - schema: decision (Approve/Object) plus reason.
- Approve logs `signoff via=human`. Object logs `objection via=human` with the reason, byte-exact.
- If the human presses Esc or declines, nothing is logged. The form is re-offered after 10 minutes, or immediately when the model calls the tool `review()` because the human said "review".
- A newer `plan_rev` cancels the stale form. When the client lacks the elicitation capability, it falls back to the `review` tool, which returns a clear error.

**`plan-gate.js` and `plan-result.js`** become claude-only:
- The gate denies until the matrix is complete, then allows with `updatedInput`.
- plan-result logs the decision, plus its "post assignments" `additionalContext`.
- Members never enter plan mode for sign-off.

**`bin/sub-human`.** C owns the whole file. It provides:
- `tail` (the monitor);
- `read`, `digest`, `who`;
- `plan [hash]`, which prints the current or a given plan;
- `watch NAME`, which prints NAME's full thread: their human words, their Claude's posts (labelled), and their sign-offs and objections;
- `statusline` and `agent-statusline`, which dispatch to B's modules.

### Roles (owner D)

- **`agents/room-claude.md`:** the plugin agent's frontmatter, with `tools` excluding Bash, and its role prompt.
- **`skills/sub-human/room-claude.md` and `member.md`:** the context injected at join.
- **`skills/sub-human/SKILL.md`**
- **`README.md`:** the launch commands. The room's Claude runs `claude --plugin-dir … --agent sub-human:room-claude --permission-mode plan`, then `/sub-human`. A member runs `claude --plugin-dir …`, then `/sub-human NAME [CODE]`.

Role text must reference `lib/rows.ts` output rather than hand-written Agent calls. In practice `join.ts` appends `rowCalls()` to the injected context.

### Visualization (owner E)

E owns `scripts/` and `docs/rebuild/` (except this file). Write it against the commands above. It will be run after integration.
