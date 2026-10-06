# 10 — Native coordination of work (task list, workflows, schedulers, monitors)

Lens: which native features could carry *assignments, progress and completion* among humans and
their Claudes, instead of room `status` posts. Claude Code 2.1.281. Probes: 3 × `claude -p --model
haiku` (< $0.30 total) in `/tmp/native-10`; the probe list `~/.claude/tasks/n10probe` was deleted.

## 1. Capability

**Task tools (`TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate`).**
- One task = one JSON file `~/.claude/tasks/<listId>/<n>.json` with `id, subject, description,
  activeForm, status (pending|in_progress|completed), owner, blocks, blockedBy, metadata`, plus a
  `.lock` file and a high-water-mark for ids. *verified-by-probe* (file dump below);
  field names *verified-by-source* (`IDo=new Set(["status",...,"owner","blocks","blockedBy",...])`).
- **List id resolution**: `CLAUDE_CODE_TASK_LIST_ID` env, else the team name, else a session-derived
  id. *verified-by-source*: `function Mk(){if(a.CLAUDE_CODE_TASK_LIST_ID)return a.CLAUDE_CODE_TASK_LIST_ID;
  let e=cv();if(e)return e.teamName;...}`.
- **Shareable between sessions: yes.** *documented* (interactive-mode#task-list): "To share a task
  list across sessions, set `CLAUDE_CODE_TASK_LIST_ID` ... `CLAUDE_CODE_TASK_LIST_ID=my-project claude`".
  *verified-by-probe*: session A created `#1 probe-alpha`; separate process B saw `#1 [pending]
  probe-alpha`, set `owner: bob`, `in_progress`, created `#2`, completed `#1`; files on disk:
  `{"id":"1","subject":"probe-alpha","description":"from session A","owner":"bob","status":"completed",...}`.
- Built for concurrency: writes take a lock; the UI subscribes to changes. *verified-by-source*:
  "Task list lock is busy (another session or process sharing this task list, or an in-flight task
  write, holds it)", "Task list watcher error:", "Task list subscription ended:". Claim path has
  outcomes `task_not_found already_claimed already_resolved needs_open_blockers` and
  `[Tasks] claimTaskWithBusyCheck` / `agent_busy` (team claim path, *verified-by-source*).
- Dependencies auto-unblock on completion; teammates are told to claim "pending, no owner, empty
  blockedBy, lowest ID first" and "Claim an available task using TaskUpdate (set `owner` to your
  name)". *verified-by-source* (TaskList prompt) and *documented* (agent-teams).
- **Hooks**: `TaskCreated` and `TaskCompleted` (input `task_id, subject, owner, teammate_name,
  team_name`); exit 2 blocks creation/completion with feedback. *documented* (hooks).
- **Availability caveat**: since v2.1.268 the Task tools are on by default only for Claude 3.x,
  Opus 4–4.7, Sonnet 4–4.6, Haiku 4.5; newer models need `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` or
  `--allowedTools TaskCreate`. *documented* (tools-reference#task-tool-availability). This session
  (Opus 5.5) indeed has no Task tools.

**Team task list (agent teams).** Exists: `~/.claude/tasks/{team-name}/` plus mailbox
`~/.claude/teams/{team}/inboxes/{agent}.json`, with structured `task_assignment {taskId, subject,
description, assignedBy}` and `task_completed` / `idle_notification {completedTaskId}` messages.
*documented* + *verified-by-source*. But: experimental (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`),
"One team per session ... You can't ... share a team across sessions", teammates are spawned *by*
the lead, interactive only, team name is `session-<8 chars>`. *documented* (agent-teams#limitations).

**Workflow tool.** Runs a script (`agent()/parallel()/pipeline()/phase()`) that orchestrates many
subagents in the background inside one session and returns one result; saved to `.claude/workflows/`.
*documented* (tools-reference) + *verified-by-source* ("Name of a predefined workflow (built-in or
from .claude/workflows/)"). No human participants, no shared state.

**Schedulers.** `CronCreate`/`/loop`/`ScheduleWakeup`: session-scoped prompts that fire only while
the session is running and idle; recurring jobs expire after 7 days; `ScheduleWakeup` clamps to
60–3600 s. *documented* (scheduled-tasks). A `durable: true` mode writes `.claude/scheduled_tasks.json`
with a `scheduled_tasks.lock` (gated by `tengu_kairos_cron_durable`) *verified-by-source*.
`RemoteTrigger`: CRUD/run of claude.ai cloud routines (fresh clone, no local files). *documented*.

**Background Bash / Monitor.** Monitor streams each stdout line of a background command into the
session as a notification; background Bash wakes on exit. Per session, not restored on resume.
*documented*. The plugin's room monitor already is this pattern.

## 2. Mapping to "humans join like subagents"

- **Doing work / assignments / progress / completion → shared Task list.** Every participant's
  session is launched (or relaunched) with `CLAUDE_CODE_TASK_LIST_ID=subhuman-<code>` and
  `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`. The orchestrator turns the approved plan into tasks with
  `blockedBy`; the leader assigns with `owner=<member name>`, or members self-claim. Each human's
  Claude marks `in_progress`/`completed`. Everyone sees the same live checklist with Ctrl+T, with
  no room post needed. Closest native analogue to "subagent does task, reports done".
- **Waking**: the list updates the *UI* through the watcher, but nothing puts a change into the
  model's context (*inferred*: no attachment/notification path found; the mailbox `task_assignment`
  exists only inside a team). A plugin monitor that tails `~/.claude/tasks/<id>/*.json` and prints
  "task #3 assigned to alice" would supply that wake; it is a far smaller piece than the room log.
- **Identity**: `owner` is a free string. *verified-by-probe*: a third session overwrote
  `owner: bob` → `carol` on a completed task with no error. No `createdBy`, no history. The plugin's
  identity binding still has to say who wrote what; a `TaskCreated`/`TaskCompleted` hook (which gets
  `session_id` in common input) can stamp the real member into `metadata` or block forged ones.
- **Approval/consent**: a `TaskCompleted` hook with exit 2 can enforce "only the owner's session may
  complete" or "completion needs reviewer sign-off", mirroring the current ExitPlanMode gate.
- **Visibility**: Ctrl+T task panel in every session (up to five rows; "show me all tasks" for more);
  the status line can count tasks per owner by reading the JSON files.
- **Async long work**: keep it in native background subagents (the user's decision). The subagent's
  parent marks the task completed when the background result arrives, so the shared list becomes the
  record of results instead of `status` posts.
- Workflow, Cron, `/loop`, RemoteTrigger: per-session automation. Useful *inside* one member's
  Claude (e.g. a Workflow fans out a task's subtasks); none model other humans.

## 3. Replaces / simplifies

- **Replaces**: the `plan` MCP tool's work-tracking role and `status` room entries for
  progress/completion; the "who is doing what" part of the feed subagent and status line.
- **Still needed**: identity binding (owner is unauthenticated); the room log for conversation and
  `@room` exact words; a wake channel (a tiny monitor over the task dir, or the existing room monitor
  emitting task events); the ExitPlanMode approval gate (tasks have no approval state); launching
  every session with the env var (it cannot be set from inside a running session, since `Mk()`
  reads `process.env`; *inferred*); cleanup of the list dir.
- **Agent teams do not replace the room**: one team per session, teammates are Claude instances the
  lead spawns, not humans' existing sessions, and the feature is experimental.

## 4. Limits and risks

- Same machine and same `~/.claude` only: local files, "never uploaded" (*documented*). Separate
  machines or accounts need a sync layer, so this matches the plugin's current same-machine scope.
- Env var must be set at launch; the `/sub-human NAME CODE` join from an already-running session
  cannot switch its list. Joining would become "relaunch with env" or `claude --resume` with env.
- Task tools are off by default on current models (Opus 5.x). Opting in costs context and changes
  model behaviour (it may use the list as a personal checklist and pollute the shared one).
- Single shared namespace: every session on the list may create, rewrite, delete or `resetTaskList`
  completed tasks (*verified-by-source*: `[Tasks] resetTaskList` hides completed items). Without a
  guard hook, one Claude tidying "its" todos can wipe the room's tasks.
- No change notification to the model; no audit trail; `CLAUDE_CODE_TASK_LIST_ID` is documented
  only in one bullet (not in env-vars reference), so it is low-visibility but supported.
- Cron/loop: idle-only firing, 7-day expiry, jitter; RemoteTrigger runs in cloud without local state.

## 5. Recommendation

**Adopt now (partially): the shared Task list keyed by `CLAUDE_CODE_TASK_LIST_ID`** as the room's
work ledger (assignment = `owner`, progress = `status`, completion = `completed` + `TaskCompleted`
hook), keeping the room log for messages and the plugin for identity and wake-ups. **Don't adopt**
agent teams (experimental, one team per session, spawned not joined), Workflow, Cron/loop or
RemoteTrigger for cross-human coordination; they are single-session tools.

**Settling experiment**: two interactive sessions launched with `CLAUDE_CODE_TASK_LIST_ID=sh-test
CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, plus a `TaskCompleted` hook that stamps `session_id` and rejects
completion by a non-owner. Check (a) does B's Ctrl+T panel update live when A assigns a task,
(b) does a 10-line Monitor over the task dir wake B's model on assignment, (c) does the hook fire
in the completing session and block a forged completion, (d) does either Claude call
`resetTaskList`/delete on shared tasks unprompted.
