# Room task lists in `~/.claude/tasks` (issue #11)

Status: plan, 2026-11-02. It replaces the first attempt on branch `task-gc` (cca8d0e, 1dfdea8): a daily sweep during joins, `gc --tasks` and a doctor line.

## Decision in one paragraph

Claude Code already removes `<config>/tasks/<id>/` folders 30 days after their last change (`cleanupPeriodDays`), so nothing piles up forever. The real problems are two:

- **A test leak.** Each `npm run test:plugin` writes 3 empty folders into the real `~/.claude/tasks`.
- **Lists outliving their rooms.** A closed room's list stays up to 30 days.

The native design has three parts:

1. Stop the leak at its source.
2. Delete a room's list when its room session ends. Every end goes through `reap`.
3. Rely on Claude Code's sweep for anything left. Record the sweep in `contract.json`, and touch a live list once a day so an idle open room isn't swept.

Everything the first attempt added for hunting old folders goes: the join-time sweep, its throttle and cursor, and the `claude agents` call. **The owner's decision (2026-11-02): option d is dropped.** There is no `sub-human gc --tasks`, no doctor line, no `'gc'` in `CLI_VERBS` and no `lib/cli/gc.ts`; Claude Code's sweep clears the leftovers.

**Built** (branch `task-gc`, after the reset to master's code): the test-leak fix and exit guard, `ownedDir`/`remove` in `task-files.ts`, the delete at `reap`, the daily touch in `project`, and `task-list-retention` with docs/internals S5. Where the build differs from this plan:

- A reaped room is never joined again (`seats.ts` take and `commands/join.ts` refuse a room whose `claude.closing` is set). There is no "reopen" to re-project the list, so the reopen test and live step 4 below don't apply. Instead `tasks.repair` writes nothing once the room is closing, so a late health tick can't make the deleted list again.
- `task-list-retention` has `feature: "core"`, not `"tasks"`. `tasks` is a gated feature, so a failed entry would turn the room task list off when only the backstop is missing.
- The list lock's own `mkdir`/`rmdir` of `.lock.lock` already freshens the folder on every projection, so F9 doesn't happen while the room's tail repairs. The touch stays, so this doesn't depend on the lock's layout.
- The exit guard notes each temp dir's room codes as the dir is removed (most homes are removed by `t.after`, before exit).

## Problem and evidence

Each room session (member `claude`, a `claude --bg` job) runs with `CLAUDE_CODE_TASK_LIST_ID=sh-CODE`, so its native list is `<config>/tasks/sh-CODE/`. The host writes the room's tasks there (`lib/room/task-files.ts`). The plugin deletes it only when `lib/gc.ts` sets a hosted room aside, 30 days after it closes.

On the owner's machine, 655 `sh-*` folders:

| Contents | Count | Note |
|---|---|---|
| Empty | 492 | |
| No `metadata` | 95 | written before stamping (4feb91d, 2026-10-17) |
| Stamped | 38 | |
| Only `.lock` / `.highwatermark` | 30 | Claude Code's list reset deletes only `*.json` |

New ones arrive three at a time, all empty: one `test:plugin` run. The oldest entry is from Oct 4, and nothing is older than about 30 days.

## Findings

- **F1. Claude Code's retention sweep removes old `tasks/` folders.**
  - The sweep (telemetry `tengu_retention_sweep`, at most daily, marker `<config>/.last-cleanup`) calls `function at(){return B("tasks")}`.
  - `B` runs `rm -r` on every entry whose own mtime is older than `cleanupPeriodDays` (default 30), whatever it holds. Verified in the 2.1.296 binary.
  - The `["todos","statsig","logs","access-audit"]` list is a separate path.
- **F2. The test leak.**
  - `test/helpers.ts:136` gives the test process a temp `CLAUDE_CONFIG_DIR`, but `childEnv` (`:152`) runs `stripClaude` (`:112`), which removes it. Children keep the real `HOME`.
  - `sub-human serve --stdio` children then resolve `lib/cc/env.ts configDir()` to the real `~/.claude`.
  - A remote join runs `seats.enter`, then `ensureRoomClaude` (`seats.ts:95`), then `openTaskList` (`room-claude.ts:178`), which runs `mkdirSync(<real>/tasks/sh-CODE)` (`:182`).
  - Leaking tests: `remote-server.node-test.ts:429` and `:561`, and `remote-ws.node-test.ts:252`. Their room Claude never starts, so the folders stay empty.
  - The detached helpers inherit the same env (`room-claude.ts:365`).
- **F3. Demo and live runs.**
  - `scripts/demo.sh` runs on the real config, and its home `/tmp/sh-demo/home` is wiped on reset, so each run's list is orphaned.
  - Live-verify rooms are ordinary rooms whose lists stay only because nothing deletes them at close.
  - The Docker lab mounts only the plugin and stubs `claude`: no leak.
- **F4. A separate config dir for room sessions is not acceptable.**
  - The keychain entry name depends on the config dir (a `-<sha256(configDir)[:8]>` suffix when `CLAUDE_CONFIG_DIR` is set), so the room session would be logged out.
  - Trust, plugins, settings and the bg daemon (`claude stop`, `SendMessage claude.CODE`, the agent panel) also live there.
- **F5. Every way a room session ends goes through `reap()` (`room-claude.ts:395`).**
  - That covers: the last member leaving, a kick, the watchdog after every member crashed, and a room Claude that never started.
  - A mirror (a room hosted elsewhere) has no list on the joiner. gc set-aside already deletes on master.
  - In `reap`, after `ensureGone` (`:419`) and before `stopped_at`, `closing` is held: `claimSpawn` refuses, and `roomSessionDown` is false, so repair doesn't recreate the list.
- **F6. Deleting at reap is safe.**
  - The list is a projection of the log (the `task-files.ts` and `tasks.ts` headers), and a reopened room re-projects it.
  - After close, nothing reads native files: `sub-human tasks` and the rows read `tasks.json`, and the demo checks native tasks only while open.
  - Within one home a code is one room (`identity.ts:186-193`).
  - Claude Code's locks are `<list>/.lock.lock` and `<id>.json.lock` (`lib/cc/tasklock.ts`). After `ensureGone`, no Claude Code process with this list id is left; a fresh lock dir means skip.
  - `withListLock` creates the dir, so it must not be used around the delete.
- **F7. Agent teams can't own it.**
  - A team's list lives inside a single process: AsyncLocalStorage, in-process teammates only. A separate `--bg` job can't join.
  - The per-call team field is deprecated ("Sessions have a single implicit team…").
  - `cleanupSessionTeams` removes only `teams/<name>`, never `tasks/<name>`.
- **F8. No setting moves the tasks dir.** It is always `<config dir>/tasks`; the only knob is `CLAUDE_CONFIG_DIR` (F4).
- **F9. A long-open, idle room's list can be swept while live.**
  - The sweep compares the folder's own mtime, and a room with no task change for 30 days would lose it.
  - Repair recreates the list, but the room session's `fs.watch` (`task-ui-watch`) is lost until it is respawned.

## Options considered

| # | Option | Verdict |
|---|---|---|
| a | The room session as an agent team, so Claude Code owns the list | **Out of scope.** In-process only, deprecated, and team cleanup doesn't touch `tasks/` (F7). |
| b1 | Claude Code's retention sweep (F1) | **Yes, as the backstop.** Fully native, and bounded by the person's own `cleanupPeriodDays`. Needs a `contract.json` entry. |
| b2 | Move the list under the sub-human home | **Not possible** (F8). A per-room config dir breaks login, trust, plugins and the daemon (F4). |
| c | Delete in `reap` | **Yes.** It's the one place every end of a session passes, and it is safe there (F5, F6). |
| d | Manual `sub-human gc --tasks [--yes]` plus a doctor line | **Dropped** (the owner's decision, 2026-11-02). It only speeds up what b1 does within 30 days, and the plugin shouldn't hunt through Claude Code's folder when Claude Code already does that. |
| e | The branch's daily sweep at join (throttle, cursor, budget, `claude agents --json`) | **Drop.** b1 covers what c misses, at no cost to joins. |
| f | Fix the leak in the tests | **Required.** Without it, c fixes nothing for test homes, and the detached reaper would touch the real config. |
| g | Touch a live list's folder once a day so b1 never sweeps it (F9) | **Yes.** One `stat` per projection, and a `utimes` at most daily. |

## Recommended design

1. **Tests never reach the real config dir.** `childEnv` keeps the process's temp `CLAUDE_CONFIG_DIR`, and an exit guard fails a test file that creates `tasks/sh-CODE` in the real one.
2. **A room session's list ends with it.** `reap` deletes `tasks/sh-CODE` after `ensureGone` and before `stopped_at`, under the room's `tasks` lock. It deletes only when:
   - the folder is the recorded `tasks_dir`, named `sh-CODE` under `tasks/`;
   - every entry is a plain `.lock`, `.highwatermark` or `N.json` file stamped for CODE;
   - no lock dir in it is fresh.

   Anything else keeps the folder.
3. **Claude Code's retention sweep is the backstop**, listed in `contract.json` (`task-list-retention`) and in `docs/internals`.
4. **A live list never ages out.** `project` touches its folder when the folder's mtime is over a day old.
5. **The set-aside delete in gc stays**, sharing the ownership rule.
6. **Demo:** S10 closes the room, so reap deletes the list. Older orphans age out.

## Implementation

### 1. Stop the test leak (first)
- `test/helpers.ts`:
  - In `childEnv`, after `stripClaude`: when `extra` sets neither `HOME` nor `CLAUDE_CONFIG_DIR`, set `env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR`. A child given its own `HOME` keeps `HOME/.claude`, which `real-home-guard`'s `fakeUser` and `two-homes.ts:91` rely on.
  - Fix the header (":5 children get none") and the comment at `:134-135`.
- **Exit guard** (in the existing `process.on('exit')` handler):
  - Compute the real config path once at preload, from the env as inherited.
  - At exit, for each `rooms/<code>` in this process's temp homes: if `<real config>/tasks/sh-<code>` exists and was born after the process started, print `REAL CONFIG TOUCHED: …` and set `process.exitCode = 1`.
  - Confirm with a deliberate leak once that node honours it.
- `test/real-home-guard.node-test.ts`:
  - `childEnv().CLAUDE_CONFIG_DIR` is the temp dir.
  - A child's `configDir()` prints it.
  - `childEnv({HOME: x})` has none.
  - A `serve --stdio` join makes the list under the temp config, not the real one.

### 2. One ownership rule (`lib/room/task-files.ts`)
- Move `roomTaskList` (`gc.ts:79`) here as `ownedDir(code, members?) -> string | null`. Keep the same checks, plus:
  - only plain `.lock`, `.highwatermark` or `/^\d+\.json$/` entries;
  - no `*.lock` dir newer than the stale age (export `STALE_MS`, or a `heldLocks(dir)` from `lib/cc/tasklock.ts` with a `@cc task-lockfile` tag).
- `remove(code, {members?}) -> {removed, why?}`: `ownedDir`, then `fs.rmSync(dir, {recursive: true})`. Not inside `withListLock`.
- `project`: after writing, if the folder's mtime is older than `TASK_LIST_TOUCH_MS` (24 h, `lib/config.ts`), call `touchList(dir, now)`. The helper lives in `lib/cc/tasks.ts` with a `@cc tengu_retention_sweep` tag.
- `lib/gc.ts`: set-aside calls `taskFiles().ownedDir(code, ms)`. Drop the local `roomTaskList` and `TASK_ROOM`, and update the header.

### 3. Delete at reap (`lib/room-claude.ts`)
- In `reap`, replace `await ensureGone(…)` (`:419`) with:
  ```ts
  const gone = await ensureGone(identity.readMembers(code).claude ?? o);
  // the room session's native list ends with it (contract task-list-retention takes any it keeps)
  if (gone) { try { room.open(code).store.lock('tasks', () => taskFiles.remove(code)); } catch { /* it stays */ } }
  ```
- Headers:
  - `room-claude.ts:18`: drop "nothing there is ever deleted", and say what `reap` deletes.
  - `tasks.ts`: the reaper deletes the list, and a reopened room projects it again.
- Tests (`test/room-claude.node-test.ts`):
  - Flip `:195`: the reaper deletes the room's list.
  - Each of these keeps the list: a foreign file, a task stamped for another room, `ensureGone` false (a `seam.ensureGone`, as in `seats.ts:326`), a fresh `.lock.lock`.
  - Reopen, then `repair`, rewrites the tasks from the log, open ones included.
  - The watchdog path deletes the list.
- `test/task-files.node-test.ts`: the `ownedDir` table (from `gc-tasks`'s: name, prefix, foreign file, lock dir, symlinks, other stamp), and the touch (an aged folder is touched, a fresh one isn't).
- `test/gc.node-test.ts`: set-aside still deletes through `ownedDir`.

### 4. Contract and internals
- `lib/cc/contract.json`, after `task-list-auto-reset` (check the shape with `npm run probe`):
  ```json
  {"id":"task-list-retention","section":4,"stability":"incidental","feature":"tasks","since":"2.1.296",
   "search":["tengu_retention_sweep","cleanup_sweep_root_refused"],
   "shape":["function ~(){return ~(\"session-env\")}function ~(){return ~(\"tasks\")}",
            "if((await ~.stat(~)).mtime<~){if(await ~?.(~))continue;await ~.rm(~,{recursive:!0,force:!0})"],
   "note":"Claude Code's retention sweep (at most daily, <config>/.last-cleanup) removes every folder under <config>/tasks whose own mtime is older than cleanupPeriodDays (default 30). The backstop for a room list the reaper kept; project touches a live list's folder daily so an idle open room's list is not swept."}
  ```
- `docs/internals/cc-2.1.296-tasks-plans.md`: add **S5. Retention and teams**, covering F1, F7 and F4 (the keychain suffix). Teams get notes only, with no entry.
- Run `npm run probe` and `npm run canary -- latest`, so the entry is checked beyond 2.1.296. Run `npm run docs`.

### 5. Remove from the current branch
- `lib/config.ts`: `TASKS_GC_EVERY_MS`.
- `lib/gc.ts`:
  - `sweepTaskLists`, `tasksStateFile` (`gc-task-lists.json`), the `sweep({jobs})` parameter and its call;
  - `staleTaskLists`, `staleKind`, `knownCodes`, `removeTaskLists` and their types;
  - the `bg` import, `AgentJob`, `JOB_ENDED`, `configDir`;
  - the header paragraphs.
- `test/gc-tasks.node-test.ts`: the whole file. Its `ownedDir` cases move to `task-files`.
- `lib/cli/main.ts` `gc` verb, `lib/cli/doctor/rooms.ts` `taskListChecks`, `doctor.ts`/`check.ts` wiring, and the `'gc'` entry in `CLI_VERBS`: removed (option d is dropped).
- `README.md`, `CLAUDE.md`, `CHANGELOG.md`: rewritten for this design.
  - README `:33` and `:389`: the list ends with the room session; the log keeps every task.
  - README `:461`: Claude Code removes any list left after `cleanupPeriodDays`.

## Verification

- **Unit:** the tests above, plus `npm run typecheck`, `lint`, `probe` and `validate`.
- **The real config is untouched:**
  - the `real-home-guard` tests and the exit guard;
  - by hand, `ls ~/.claude/tasks | wc -l` before and after a full `npm test`, and after `npm run test:scripts` alone. Unchanged.
- **Live, on the real home:**
  1. Open room X, and `sh-X/` appears.
  2. Add a task; stamped files appear.
  3. `/sub-human leave` (grace plus stop). `sh-X` is gone, and `sub-human tasks --room X` still lists the task.
  4. Reopen X, and the room session's ctrl+t shows the open task again.
  5. `kill -9` the member, then the watchdog's reap deletes the list.

## Migration of the existing ~650 folders

Nothing to do. Claude Code's sweep removes each one 30 days after its last change, so today's set is gone by about 2026-12-03 once the leak is fixed.

## Risks

- **The sweep is an internal.** The contract entry plus probe and canary flag any change. Without the sweep, reap still deletes normal lists; only crash leftovers would accumulate.
- **Two homes sharing one config dir could draw the same code** (about 1 in 10⁵–10⁶). Reap in one home could then delete the other's live list. It heals on the other's next repair. Optional hardening: stamp `metadata.home` and require it in `ownedDir`.
- **Deleting under the room's `tasks` lock** blocks a concurrent `apply` for milliseconds, and an apply on a closing room is moot.
- **The `childEnv` change** gives children the temp config. Any test that relied on the real one was a bug, so run the whole suite.
