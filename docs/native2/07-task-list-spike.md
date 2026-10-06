# 07 — Spike: the room's ledger as the native shared task list

Goal (user): "Ideally this functions natively as I'm sure normal subagents can contribute to a shared task list."
Constraint: write nobody's user or project settings (rules out round 2's `settings.local.json` env route, `03`).
Claude Code 2.1.281, Haiku probes in tmux `tl-{a,b,c}` plus one `--bg` orch, `env -i` + `--setting-sources project,local`,
about $0.40. A throwaway `CLAUDE_CONFIG_DIR` was **not feasible** ("Not logged in"), so probes used the real
`~/.claude/tasks` with `tl-*` list ids and pre-chosen `--session-id`s; everything created was removed afterwards.

## 1. How a session and its subagents share a list

- **List id resolution** (`Mk()`, re-run on every Task tool call and by the panel): `env.CLAUDE_CODE_TASK_LIST_ID` →
  in-process teammate's `teamName` → `dynamicTeamContext.teamName` (hidden `--team-name` flag, teammate launches) →
  `leaderTeamName` (set by `initializeSessionTeam`, agent teams only) → **the session id**. Store: `~/.claude/tasks/<id>/`. *verified-by-source*
- **Subagents use the parent's session id**, so they write the parent's list with no configuration. A foreground
  general-purpose subagent created `#1 fg-sub-task` and set `owner=fgsub`; it landed in `~/.claude/tasks/<parent session id>/`,
  and the parent's `TaskList` showed `#1 [in_progress] fg-sub-task (fgsub)`. *verified-by-probe*
- **Background (async) subagents get no Task tools.** `il()` filters an async agent's tools to the "external" allowlist;
  Task tools are added back only for agent-team teammates (`ao()&&isTeammate&&fuo.has(name)`). The probe's background agent
  got "No matching deferred tools found" for `select:TaskUpdate`. *verified-by-source + probe*
- **In a `--bg` session every Agent call is forced async** ("Backgrounded agent" for a call we asked to be foreground),
  so the headless orch's own subagents cannot touch the list either. *verified-by-probe*; `forceAsync` *verified-by-source*
- **Owner** is a free string the caller sets; auto-filled only in agent teams. **Parent notification** is the panel only: same
  process emits `taskList.updated`; other processes reach it through `fs.watch`. No model wake. *verified-by-source*
- **Todo tools in `--bg`:** `b$()` returns true when `At()` (bg session), so the headless orch has Task tools on any model,
  Opus 5.x included. Interactive Opus 5.x members still need `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` at launch. *verified-by-source*

## 2. Ways to set a running session's list id without settings files

| Route | Mid-session? | Verdict |
|---|---|---|
| `CLAUDE_CODE_TASK_LIST_ID` in launch env / `--settings` | no (launch only) | fine for the orch |
| settings `env` hot reload (`settings.local.json`) | yes | rejected by the user; whole folder, persists |
| plugin `settings.json` `env` | — | ignored (only `agent`, `subagentStatusLine`) *verified-by-source* |
| `CLAUDE_ENV_FILE`, hook JSON outputs | — | Bash env only; no hook output sets env *verified-by-source* |
| `--team-name` / `CLAUDE_INTERNAL_ASSISTANT_TEAM_NAME` / agent teams | no (launch only) | teams also turn on mailboxes, auto-owner, renames the list dir to `session-<8>` |
| **symlink `~/.claude/tasks/<session_id>` → `<room list>`** | **yes** | **works; recommended** |

**The symlink route.** The default list *is* the session id, and the join hook already receives `session_id`. Making
that path a symlink to the room's directory turns the member's own native list, and therefore their subagents' list,
into the room list. No env var, no settings file, nothing in the project.
- Linked before launch (A): the startup footer showed `ctrl+t to show tasks` and the panel listed the room's 3 tasks. *verified-by-probe*
- Linked mid-session (C, running, no tasks yet): the next `TaskList` returned the room's tasks; C's background subagent's
  attempt failed (no tools, above), and C's own `TaskUpdate #2 owner=carol-sub` landed in the room file. *verified-by-probe*
- Live UI follows the link: A, idle, repainted `◼ write parser` from C's write and `◻ orch task` from the `--bg` orch. *verified-by-probe*
- Leave = `unlink`: C's panel disappeared at once and `TaskList` returned "No tasks found"; room files untouched. *verified-by-probe*
- `.lock` and `.highwatermark` live inside the target, so locking and id allocation are shared correctly. *verified-by-source*
- Cleanup sweeps `~/.claude/tasks` by `stat` mtime and `rm`s the entry: on a symlink that removes the link only. *inferred*
- **`/clear` changes the session id** (A got `0117e44f…`): the panel emptied and the old link was orphaned. The plugin's
  SessionStart(`clear`) hook must re-link the new id and unlink the old one. *verified-by-probe*
- **A session that already has private tasks** has a real directory at that path. Joining then means moving it aside
  (or copying its tasks into the room) before linking. Not probed: the `mv` was refused by the permission classifier as
  destructive, which is exactly the tradeoff the user should decide. *untested*
- **Tradeoff:** this writes a symlink inside Claude Code's own task store (`~/.claude/tasks`), not any settings. It is the
  directory Claude Code itself reads, so the result is fully native; but it relies on undocumented layout (`tasks/<id>/`).

## 3. Headless orchestrator as list owner

- `claude --bg -n <room> --settings '{"env":{"CLAUDE_CODE_TASK_LIST_ID":"sh-CODE"}}'` wrote `orch task` into `tl-room`; the
  linked members saw it live. *verified-by-probe*. Members join by link, not by flags, so no relaunch.
- Members' **foreground** subagents contribute; background ones and the orch's subagents do not (§1).

## 4. UI and wake cost

- Panel (Ctrl+T): `N tasks (d done, p in progress, o open)` + `◻/◼/✔ subject › blocked by #n`; no owner column. Hidden while
  every visible task is complete. *verified-by-probe*
- Models learn of others' changes only by calling `TaskList`, or from the `task_reminder` attachment Claude Code injects
  after 10 turns without a task write (re-reads `Mk()`; free, rides the next turn). *verified-by-source*. A wake for
  "your task is unblocked/assigned" still needs the plugin's monitor watching `~/.claude/tasks/sh-CODE`.

## 5. Guard rails

- **Owner-only completion works through the link.** A `TaskCompleted` hook saw `CLAUDE_CODE_TASK_LIST_ID` unset, resolved
  the list by `readlink ~/.claude/tasks/$session_id`, read `owner=carol-sub`, exited 2; A's Claude reported
  "only its owner may complete it" and `#2` stayed `in_progress`. *verified-by-probe*
- **Hidden sentinel stops the auto-wipe.** A `metadata._internal`, `in_progress` task is filtered out of `TaskList` and the
  panel, but `resetTaskList` re-checks the unfiltered list and aborts if any task is incomplete. With only the sentinel
  and one visible task, completing the visible task left both files on disk >12 s later. *verified-by-source + probe*
- Evidence: put it in `description` (models can't see `metadata`); the gate can require it. `owner` stays spoofable. *inferred*

## Recommendation: link the member's own list to the room list

Native in every way that matters: each member's normal list, panel, `task_reminder` and foreground subagents all operate on
the room ledger with no env, flag or settings change. About 40 lines in existing hooks.

**Room open** (first join, before spawning the orch): `mkdir ~/.claude/tasks/sh-CODE`; write `1.json` sentinel
`{subject:"room sh-CODE", status:"in_progress", owner:"room", metadata:{_internal:true}}` and `.highwatermark`=1;
spawn the orch with `--settings '{"env":{"CLAUDE_CODE_TASK_LIST_ID":"sh-CODE"}}'`.

**Join** (join.js, UserPromptSubmit, has `session_id`): let `P=~/.claude/tasks/<session_id>`.
1. If `P` is a link to `sh-CODE`, done. If `P` is a non-empty directory, ask (or copy its `*.json` into the room with new
   ids and rename `P` to `P.pre-sh-CODE`); if empty, `rmdir`.
2. `symlink sh-CODE P`. Record `session_id → sh-CODE` in the room's membership entry.
3. One line to the user: `tasks: your task list is now the room's (ctrl+t)`.

**Restore** (SessionStart `clear`/`resume`/`compact`): if the bound member's new `session_id` differs, link the new id and
unlink the old one (only if it is still a link to `sh-CODE`).

**Leave** (session-end.js, and the reaper for crashed members): `unlink P` only if `readlink P` = `sh-CODE`; restore
`P.pre-sh-CODE` if present. Last member gone: stop the orch, then delete `~/.claude/tasks/sh-CODE`.

**Gate** (`TaskCompleted` in the plugin's hooks.json): resolve the list by `readlink`, map `session_id` → member, exit 2
unless member = `owner` and the description carries evidence; on success append a `done` entry to the room log.

**Known limits:** background subagents and the orch's subagents can't write tasks (Claude Code allowlist); interactive
Opus 5.x members need `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` at launch; private todos mix into the room list while joined.
