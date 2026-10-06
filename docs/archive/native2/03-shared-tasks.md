# 03 — The native task list as the room's shared work ledger

Lens: can `TaskCreate/TaskList/TaskGet/TaskUpdate` on one shared list carry assignment, status, evidence and done,
replacing `status` posts and the "Work for the room" role text? Claude Code 2.1.281. Probe: three interactive
`--model haiku` sessions in tmux `n2-03-{a,b,c}`, cwd `/tmp/n2-03/{a,b,c}`, list `n2-03-room` (deleted afterwards).
Round 1 (`docs/native/10`) covered the file format and `-p` sharing. New here: joining mid-session, live UI, hook
payloads, and an auto-wipe that round 1 missed.

## 1. Capability

- **Store.** `~/.claude/tasks/<listId>/<n>.json` with fields `{id, subject, description, activeForm?, owner?, status, blocks[], blockedBy[], metadata?}`, plus `.lock` and `.highwatermark`. Ids are never reused: blocked creates still use up numbers (we got #1, #3, #7, #8). *verified-by-probe*; schema `Oe=d({id,subject,description,activeForm,owner,status,blocks,blockedBy,metadata})` *verified-by-source*.
- **List id is re-read on every tool call.** `Mk()` returns `CLAUDE_CODE_TASK_LIST_ID`, else the team name, else `leaderTeamName`, else the session id. Every call starts with `let q=Mk()`. *verified-by-source*
- **Joining after start works through settings `env` hot reload. This is new.** Session B started with no env var. We then wrote `/tmp/n2-03/b/.claude/settings.local.json` = `{"env":{"CLAUDE_CODE_TASK_LIST_ID":"n2-03-room"}}`. B's next `TaskList` returned A's tasks: `#1 [pending] Write parser (bob)`, `#3 … [blocked by #1]`. *verified-by-probe*
  - Mechanism: the settings reload runs `Object.assign(process.env, filterSettingsEnv(ye(S)?.env))` for each source. *verified-by-source*
  - B's task panel was not shown until B made its own first Task write, because a write sets `expandedView:"tasks"`. After that, B's panel updated live from A's writes. *verified-by-probe*
  - Hooks also see the new value: hook env had `list=n2-03-room`. *verified-by-probe*
- **A plugin cannot set the list id directly.**
  - Plugin `settings.json` honours only `agent` and `subagentStatusLine`. *verified-by-source*, round 1 08.
  - `CLAUDE_ENV_FILE` from SessionStart only reaches Bash commands ("Session environment script"). *verified-by-source*, *documented*.
  - The only in-session route is a plugin hook or command that writes the project's `.claude/settings.local.json` `env`, or launching with the env var (`--bg` seat, round 1 A3). SDK hosts have an `apply_flag_settings` control request; interactive sessions have no equivalent. *verified-by-source*
- **Live UI.** Each session's `Tgn` store runs `fs.watch(~/.claude/tasks/<id>)`. Changes made by another process repaint the panel with no turn.
  - Seen in C: A's `completed` showed as `✔ Write parser` and the count changed to `(1 done, 1 in progress…)`. C was idle the whole time. *verified-by-probe*
  - The panel (Ctrl+T) shows `◻/◼/✔ subject › blocked by #n`. The collapsed rows do **not** show the owner. `TaskList` output does, e.g. `(bob)`. *verified-by-probe*
- **The model is not woken.** C's transcript had no attachment or reminder for A's changes. The next turn saw nothing until it called `TaskList`. *verified-by-probe*
  - Cross-session `task_assignment` mailbox messages are sent only when agent teams are on (`if(A.owner&&ao())`). *verified-by-source*
- **Hooks.**
  - `TaskCreated` and `TaskCompleted` fire in the **writing session only**.
  - Payload: `{session_id, transcript_path, cwd, prompt_id, hook_event_name, task_id, task_subject, task_description}`. It has **no owner, metadata or list id**; a hook reads `$CLAUDE_CODE_TASK_LIST_ID` and the JSON file. *verified-by-probe*
  - Exit 2 on `TaskCreated` deletes the task; the stderr text reaches the model, which kept retrying. *verified-by-probe*
  - Exit 2 on `TaskCompleted` rejects the whole update: `TaskCompleted hook feedback: … needs the owner's evidence`, and the status stays `pending`. *verified-by-probe*
  - Hooks added to project settings mid-session took effect without a restart. *verified-by-probe*
- **Ownership is not enforced.** A completed task #1 while its owner was `bob`, with no error. *verified-by-probe*
  - `owner` is a free string.
  - The model fills it in automatically only in a team: `ao()&&in_progress&&!owner → Fm()`. *verified-by-source*
- **Evidence.** `metadata` passed to `TaskCreate` persisted, e.g. `{"evidence":"npm test: 12 passed"}`. *verified-by-probe*
  - The `TaskGet` prompt lists only subject, description, status, blocks and blockedBy, so metadata is probably invisible to models. *inferred*
  - Put evidence in `description`, or have the hook read `metadata`.
- **Auto-wipe. This is new and dangerous.** Five seconds after every visible task is `completed`, any session with the panel mounted deletes all `*.json` in the list. Only `.highwatermark` survives.
  - Code: `g=5000 … if(e.every(n=>n.status==="completed")&&await dpo(i))`. *verified-by-source*
  - Probe: after A completed #3 and deleted #8, `1.json 3.json 7.json` were gone within 9 s. *verified-by-probe*
  - Tasks with `metadata._internal` are excluded from the "all done" test (`filter(a=>!a.metadata?._internal)`). *verified-by-source*
- **Availability.** Task tools are deferred, so the model loaded them with `ToolSearch select:TaskCreate,TaskUpdate`. They are on by default for Haiku 4.5, Sonnet ≤4.6 and Opus ≤4.7, and off for newer models unless `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`. *verified-by-source*: `b$()` model set. `CLAUDE_CODE_ENABLE_TASKS=false` disables them.
- **`TaskStop` is unrelated to the ledger.** It stops running background tasks (shells, agents, teammates) and has its own `not_owner` checks. It cannot close a list item. *verified-by-source*

## 2. Mapping to sub-human

- **Assignment.** The orchestrator, or anyone, runs `TaskCreate` and then `TaskUpdate owner=<member>`, with `addBlockedBy` for ordering. This replaces "An assignment names NAME" plus the `status` post that announces it (member.md, orchestrator.md).
- **Status.** `in_progress` and `activeForm` replace the "starting X in the background" `status` post. Every member's panel shows it live with no room post and no model turn.
- **Done and evidence.** A `TaskCompleted` hook in the plugin's `hooks.json`:
  - reads `~/.claude/tasks/$CLAUDE_CODE_TASK_LIST_ID/$task_id.json`;
  - rejects the completion (exit 2) unless the writing session is the owner's (session_id → member through `lib/identity.js`) and evidence is present;
  - otherwise appends a `done` entry with the evidence to the room log, as the audit trail and wake-up.
  This replaces "post one `status` with the result and evidence" and "never claim a result you didn't see", turning a prompt rule into a gate.
- **Join.** `/sub-human NAME CODE` (join.js) writes `.claude/settings.local.json` `env.CLAUDE_CODE_TASK_LIST_ID=sh-<code>`, so it works mid-session with no relaunch. This supersedes round 1's "launch-time only" claim. Spawned `--bg` seats get the variable in their launch env instead.
- **Wake.** The existing room monitor (`sub-human tail`) adds a task-dir watcher and emits one line per owner or status change, e.g. `task #3 → alice (in_progress)`. The room log stays the only wake channel.
- **Done record.** The plugin creates one sentinel task when the room is created ("room open", `in_progress`, owner `room`). It stops the auto-wipe and also shows the room in the panel.

## 3. Minimal footprint

- **Removed:** the `status` kind from `room.AGENT_KINDS` and from the `post` tool description (`mcp/room-server.js`). In `skills/sub-human/member.md`, "Work for the room" steps 1 and 3 and the assignment row go, about 1k characters. In `orchestrator.md`, the `status` rows for background jobs and assignments go, about 1k characters. That is about 2k of the 6k role text, replaced by one line: "Room work lives in the shared task list: claim with owner=NAME, complete only with evidence in the description."
- **Kept:** `plan` and sign-off, since tasks have no approval state; `say`, `question`, `objection` and `@room`; identity; the monitor.
- **Added:** about 60 lines. A `TaskCompleted` hook (owner and evidence gate plus log mirror), an optional `TaskCreated` hook (stamps the creator into metadata), a few lines in join.js to write and remove the settings env, and a task watcher in `tail`.

## 4. Limits and risks

- **The settings route is per project directory, not per session.** Every Claude session with that cwd joins the list and stays joined until the key is removed. It also persists across restarts. Leaving the room must delete the key (session-end.js), and a crash leaves it behind. *inferred* from the reload code path.
- **The auto-wipe destroys the ledger** the moment the last task completes, unless there is a sentinel or a hook archive. A member clearing "their" todos can still delete room tasks (`status: deleted`) without a guard on PreToolUse(TaskUpdate).
- **Members' private todos mix into the room list.** Once the env is set, the model's own planning lands in the shared list. Members with Opus 5.x need `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, which is itself an env var: the same settings route works, but it changes model behaviour.
- **The hook payload has no owner.** Identity is still the plugin's job; `owner` is spoofable.
- Same machine and same `~/.claude` only. There is no per-change model notification. The panel hides owners.

## 5. Recommendation

**Adopt now** as the work ledger: assignment, status and evidence-gated done. Adopt it together with three things: the join.js settings-env write (mid-session join, verified), a `TaskCompleted` owner and evidence gate that mirrors into the log, and a sentinel task against the auto-wipe. Keep the room log for conversation, plans and wake-ups.

**Settling experiment:** two real member sessions, Opus with `ENABLE_TODO_TOOLS` via settings, join by `/sub-human`. Then:
- the orchestrator assigns three blocked tasks;
- check that each Claude claims only its own task, makes no private-todo pollution and no deletes;
- check that the gate rejects a non-owner completion;
- check that the monitor line wakes the next owner when a blocker completes;
- check that the list survives the final completion.
