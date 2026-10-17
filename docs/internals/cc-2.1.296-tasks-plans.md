# Claude Code 2.1.296: the room's task files, the idle room session, plan files (ROOM-PLAN Phase 0 spike)

Spike for `docs/next/ROOM-PLAN.md` §3 (S1–S4), run 2026-10-17 against `/opt/homebrew/Caskroom/claude-code@latest/2.1.296/claude`.

Setup: a temp `CLAUDE_CONFIG_DIR` (logged in through `CLAUDE_SECURESTORAGE_CONFIG_DIR=""`, which makes Claude Code read the default keychain entry: no secret copied, nothing written to the real config), a temp `SUB_HUMAN_HOME`, scratch working dirs, `sh-spike-*` tmux sessions only. The plugin under test was a copy of `plugin/sub-human` taken at `47da860` (clean tree), plus spike-only variants of that copy: `plugin-block` (the join hook blocks the room session's `/sub-human` expansion after binding), `plugin-rows` (the expansion passes with a rows-only context) and `spike-plan` (a small plugin: a hooks module seeding the plan file, command hooks on Enter/ExitPlanMode and PermissionRequest). Spike scripts and evidence stay outside the repo (scratchpad `spike/`, `spike/evidence/`). No model was pinned; one bypass-mode run took Claude Code's own "Switch to Opus 4.8" offer after the default model's safeguard flagged the prompt twice (the hooks behaved the same).

## Summary

| Check | Result | Note |
|---|---|---|
| S1.1 `--bg` with no prompt | GO | dispatches, listed with id, sessionId, name; `status idle, state blocked` |
| S1.2 blocked `/sub-human` expansion | GO | seat bound (pid, session_id), no model turn, module lease and tail child run |
| S1.3 alive an hour with no turn | GO | see the idle log; the daemon has no idle reaping of a live worker |
| S1.4 session id, transcript, agent view row | GO, with a wart | listed, but under "Needs input": "open this session to continue setup" |
| S1.5 peer message | accept: starts a turn; refuse: no turn, sender told "refused" | recommend `refuse` |
| S1.6 fixed rows-only turn | GO | ~23k input tokens (mostly cache) + ~140 out at start; ~26k cache-read + ~1k write + ~140 out per join; rows ~2k each |
| S2.1 outside writes show live | GO, with a condition | within 250 ms (fs.watch). The list dir must exist before the session starts |
| S2.2 agent view progress | NO-GO (idle) | an idle row shows no task count; members' rows and statusline carry it (fallback) |
| S2.3 auto-reset | as predicted | never while task 1 is open; 5 s after all completed, detached too |
| S2.4 ids vs `.highwatermark` | GO | id above and at/below the mark both shown |
| S2.5 extra metadata, blockedBy | GO | shown ("blocked by #2"), not rejected |
| S2.6 `CLAUDE_CODE_TASK_LIST_ID` via `--settings` env | GO, still required | the daemon's allowlist does not carry it; `--settings` env does |
| S3.1 plan file at Post(EnterPlanMode) | NO-GO there; GO at the module's `prompt.attachment(plan_mode)` | new seeding point (below) |
| S3.2 model edits the plan file in plan mode | GO | Edit on the plan file, no prompt (with the plans dir readable) |
| S3.3 Pre(ExitPlanMode) sees the edited text | GO | `tool_input.plan` from disk, `planFilePath` |
| S3.4 deny with a reason (stale base) | GO | model reads it, stays in plan mode, edits, exits again |
| S3.5 deny with the receipt, mode restored, no dialog | GO in default, acceptEdits, bypassPermissions, dontAsk, auto, showClearContextOnPlanAccept | via one more ExitPlanMode that PermissionRequest allows with `setMode` |
| S3.6 hand edits | GO | the file on disk is what Pre reads |
| S3.7 no loop | GO | every run ended its turn after the restore |
| S3.8 header marker survives | GO | `planHasMarker: true` on every capture, all modes |
| S4.1 lock targets | GO | list: `<list>/.lock` → dir `<list>/.lock.lock`; task: `<list>/<id>.json` → dir `<list>/<id>.json.lock` |
| S4.2 race | GO | 200 plugin writes vs 8 model TaskUpdates: no lost write; 6,000 writes vs real proper-lockfile peers: none lost |
| S4.3 stray tmp | GO | `9.json.tmp-999` ignored by the view and by the reset |

## S1. The room session, idle

**S1.1.** `claude --bg -n spike-noprompt` (no prompt): `backgrounded · bdd2dd89 · spike-noprompt (idle — send a prompt to start)`; `claude agents --json` lists `{id, sessionId, name, status: "idle", state: "blocked"}` (evidence `s1-1-agents.json`). Such a job runs no `/sub-human`, so nothing binds a seat: not usable as is.

**S1.2.** The real spawn (`spawnPlan`'s argv: `--bg -n claude.CODE --plugin-dir … --agent sub-human:room-claude --permission-mode plan --settings {…} /sub-human`) with the join hook answering a bound room session with a classic block (`{decision: "block", reason}`): the seat is bound (`members.json` claude has pid, session_id, job_session), the screen shows "UserPromptExpansion operation blocked by hook: sub-human: …", the transcript has 8 lines and no user or assistant line, the module's lease (`sessions/mods/<sid>.json`) is written and the tail child runs (`sub-human tail --ndjson` under the job's pid), `seen_at` advances every few seconds. In the room session the module leaves `/sub-human` to the classic hook (`answersItself` false when `SUB_HUMAN_ROOM` is set), then starts the tail child after it: no change needed for that path.

**S1.3.** Idle log `s1-3-idle-91da2e0c.log`, one line a minute: job present, `status idle, state blocked`, the seat's `seen_at` fresh, tail children alive, the daemon up. The only assistant line in the hour is the S1.5 test's. The binary's idle strings concern the daemon itself ("nothing holding this daemon open — will idle-exit shortly", `tengu_daemon_idle_exit`: it exits only with no workers) and the SDK session runner ("session idle after end_turn; stopping", not the bg daemon); `idleExitAfterMs`/`CLAUDE_CODE_EXIT_AFTER_STOP_DELAY` are set only for remote (CCR) sessions. Result: alive and bound for 61 minutes (08:35:58 → 09:37:00 UTC), same pid 98757 throughout, tail child alive, transcript unchanged but for the S1.5 test turn, daemon up (uptime 3,751 s).

**S1.4.** Session id and transcript exist from the start (`by-sid` written). `claude agents` (the view) lists the job, but a job whose only prompt was blocked sits under **Needs input** with "open this session to continue setup" (`s2-2-agents-view.txt`). Attaching shows the blocked-expansion warning and an empty prompt. A rows turn (S1.6, decided Q1) removes the wart: after it the job is an ordinary idle session.

**S1.5.** `crossSessionInbound: accept`: a peer `SendMessage` to `claude.CODE` arrives as a `<cross-session-message … from-mode="prompting">` prompt and starts a turn at once (in the spike that turn failed with "Not logged in", see Surprises). `refuse` (tested on a plain job and on a rows-turn room session): the recipient gets nothing (no transcript line, no turn); the sender's tool first reports the message sent, then a notice "Cross-session message refused (recipient: @claude.egret-7156). That session is not accepting cross-session messages … it was not delivered." (`s1-5-refuse-sender.txt`). `hold` parks messages for a person's review, which nobody gives in a room session. The plugin's own wakes (the tail's `member_joined` notice, a submitted plugin prompt) are not cross-session messages and still arrive under `refuse` (verified: frank's join woke the refuse room session and it spawned his row).

**S1.6.** The fixed rows-only turn, measured with `plugin-rows` (the expansion passes; its context is only "SUB-HUMAN room session (rows only) … Do exactly this, then end your turn with no text:" plus `lib/rows.ts` `rowCalls`):
- start (one member): 2 API calls, input 34 + cache-read 10,057 + cache-write 12,579, output 143; one `Agent(sub-human:participant)` call; the participant row costs 1 call, ~2k cache-write, 32 out.
- per `member_joined` (the existing tail wake, unchanged): 2 calls, ~36 input + ~25.4k cache-read + ~1k cache-write, ~140 out, one Agent call; row ~2k.
- With `refuse`: start 1 Agent call, join 1 Agent call, the same shape (`s1-6-rows-refuse.txt`).
The model always added one short line of text ("Seated; carol's row is running.") despite "no text": harmless, not shown to anyone. The room session's agent prompt (`agents/room-claude.md`) was still the beta.16 one; the planned one-line prompt makes these turns cheaper.

**Recommendation (S1).** Spawn exactly as today (`--bg -n claude.CODE [--plugin-dir] --agent sub-human:room-claude --permission-mode plan --settings {env, crossSessionInbound} /sub-human`) with:
- `crossSessionInbound: "refuse"` (nobody needs to message the room session; a peer message would otherwise start a full turn);
- the `/sub-human` expansion passing with a rows-only context (Q1 decided), so the first turn spawns the participant rows and the job then lists as idle; each `member_joined` that needs a row is one more such turn;
- the blocked-expansion path (S1.2) kept only as the fallback if rows are ever dropped (it works: bound, idle, alive), accepting the "Needs input" listing;
- the task list dir created before the spawn (S2.1).

## S2. Task files written from outside

**S2.1.** A session that shows the list (interactive with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, or any `--bg` job) picks up a file written by `spike/put.ts` (under the list lock, tmp + rename) within 250 ms, status changes included (`s2-1-viewer-live.txt`). The view (`n4n` in 2.1.296) does `fs.watch(<tasks>/<list>)`, refetches 50 ms after an event, and polls every 5 s only while it has incomplete tasks or its last watch failed asynchronously.

**Condition found:** if the list's directory does not exist when the view subscribes, `fs.watch` throws synchronously, the `try{…}catch{}` swallows it, the "watch failed" flag stays false and nothing polls: files written later never show in that session (reproduced three times: the original room session, spike-D, spike-E; spike-F with the dir made before the spawn shows everything). The room session of the plan therefore needs `<tasksDir>/sh-CODE/` (and task 1) written **before** `claude --bg` is dispatched.

**S2.2.** The agent view row of an idle job shows no task count (`s2-2-agents-view.txt`); the row's progress (`ive(wie())`) is drawn only while working. Fallback as the plan says: members see tasks in their room row and statusline.

**S2.3.** With task 1 `in_progress` (owner `room`, written by the plugin, never by TaskCreate) the list was never reset. Completing every task in a detached `--bg` job's list: 5 s later every `*.json` was deleted and `.highwatermark` kept at 2 (`s2-3-reset.txt`). The reset runs in any session whose task view is mounted, attached or not.

**S2.4.** After that reset the plugin wrote id 3 (above the mark) and id 1 (at or below): both shown (`s2-4-after-reset.txt`); the mark only steers Claude Code's own `max(files, mark)+1`.

**S2.5.** `metadata: {req, by, for, plan, version}` and `blockedBy: ["2"]` pass the schema (extra metadata keys allowed: `metadata: record(string, unknown)`); "› blocked by #2" is drawn. Tasks with `metadata._internal` are hidden from the view (do not use that key).

**S2.6.** `CLAUDE_CODE_TASK_LIST_ID` reaches a `--bg` job through `--settings` env (it is not in the daemon's env allowlist) and is still required. `CLAUDE_CODE_ENABLE_TODO_TOOLS` is not needed for a `--bg` job's view (it is for an interactive one); keep passing it, it is harmless.

## S3. Seeding and capturing a plan file

**S3.1.** At PostToolUse(EnterPlanMode) neither the `plan_mode` attachment (planFilePath) nor the session's plan `slug` is in the transcript yet (34 lines, no slug; the attachment is made with the next request). The plan file is `<plansDir>/<slug>.md` with a random slug per session, so it cannot be computed. **New seeding point:** the hooks module's `prompt.attachment` event for type `plan_mode` carries `detail: {reminder: "full"|"sparse", planFilePath, hasPlan}` as the request is made, before the model's next call, and its `text` is rewritable. The spike module wrote header + v1 there (`$.fs.write`, plans dir outside the cwd: allowed) and replaced the reminder text; the model then read and edited the seeded file in every mode (`s3-*-mod.jsonl`, `s3-*-seeded`). Production should append its line to the engine's text rather than replace it (the engine's text carries plan mode's "MUST NOT make any edits" rule), and seed once per edit (the reminder repeats as `sparse` on later requests).

**S3.2–S3.4, S3.6–S3.8.** Every run: the model edited the plan file with Edit (no prompt with the plans dir added as a working dir; on a fresh config, a Read outside the cwd asks the one-time "Read outside the working directories" question instead), Pre(ExitPlanMode) saw `plan` (the file's text, the marker `<!-- sub-human plan room v1 -->` kept: `planHasMarker: true`) and `planFilePath`; the stale-base deny ("not stored. Plan room v2 landed since your base v1 … Add that step … then call ExitPlanMode again") kept it in plan mode and it reconciled; after the receipt it ended its turn.

**S3.5.** The receipt deny ("stored as plan room v3. Not agreed … Now call ExitPlanMode exactly once more: it only leaves plan mode (no dialog), it is not an approval …"), then the model's third ExitPlanMode passes Pre and a PermissionRequest hook answers `allow` with `updatedPermissions: [{type: "setMode", mode: <mode at EnterPlanMode>, destination: "session"}]`: no dialog, the mode is back, in default, acceptEdits, bypassPermissions, dontAsk, auto, and default with `showClearContextOnPlanAccept: true` (no clear-context dialog) (`s3-<mode>.jsonl`: `post … mode=<original>`). The mode at EnterPlanMode came from PreToolUse(EnterPlanMode)'s `permission_mode` (as the plugin's hooks.json shell hook already records it).
Wart: the transcript draws "⏺ User approved Claude's plan" and "Plan saved to: …" for the restoring ExitPlanMode, the same as today's review restore path. The Post context ("plan mode closed with no approval; the plan was stored, not agreed") kept every model from acting on it.
Live validation (room-plan, 2026-10-17) found it worse than a wart: the hooks put the person's own plan back at PermissionRequest, and the closing call (no plan in its input: `updatedInput: {}`) reads the plan file as it runs, so it drew "User approved Claude's plan · <the person's private plan's title>" and told the model "User has approved your plan. You can now start coding … ## Approved Plan: <the private plan>". Fixed by emptying the file at PermissionRequest (contract `exitplan-empty-plan`: an empty plan draws " Exited plan mode" and the tool result is only "User has approved exiting plan mode. You can now proceed.") and restoring it at PostToolUse(ExitPlanMode) or the next prompt.
Variant (tested in default only, `s3-two.jsonl`): capture at the second Pre without a decision, let PermissionRequest allow + setMode, and give the receipt as PostToolUse(ExitPlanMode) context. One model call fewer per edit; same wart.

**S3.9. EnterPlanMode in plan mode (live validation, room-plan beta.19).** A person in plan mode holding a plan of their own was asked to sign off; their Claude called EnterPlanMode then ExitPlanMode, and the plan view showed their private plan, whose Yes told the model "User has approved your plan … ## Approved Plan: <private plan>". Suspected first: Claude Code runs no hooks for an EnterPlanMode made in plan mode. Not so, checked two ways on 2.1.296:
- the binary: EnterPlanMode's `validateInput` checks only `agentId` ("Only the main session can enter plan mode."), and its `call` sets the mode to plan again and answers "Entered plan mode. …" (contract `enterplan-in-plan-mode`);
- live: an interactive session started with `--permission-mode plan` and a logging plugin (command hooks on every PreToolUse/PostToolUse), asked to call EnterPlanMode: the call ran ("Entered plan mode. You should now focus on exploring …") and both `PreToolUse` and `PostToolUse` fired with `tool_name: "EnterPlanMode"`, `permission_mode: "plan"`. (In `claude -p` EnterPlanMode is not offered at all.)
The cause was ours: consent opened a review at EnterPlanMode only in default, acceptEdits and auto, so in plan mode it stayed silent (the hooks.json mode note was written and then taken by consent, which is why none was left), nothing was written to the plan file, and Claude Code's normalizeToolInput put the plan file's text (the private plan) in ExitPlanMode's `plan` over the model's "proposal HASH" (`exitplan-normalize`: `{...input, plan, planFilePath}` whenever the file exists; the model's own value survives only in the transcript's copy of the call). The stub check read the call's plan and the file, found the private plan in both, and let the dialog show it. The model's own "proposal HASH" reaches no hook while a plan file exists: a probe module logged `tool.call`, the module's `classic.PreToolUse` and a command PreToolUse for an ExitPlanMode the model was told to call with plan "proposal abc123def456", and all three carried the file's text; the transcript's copy of the call, written only as the call ends, carried it too (so `exitplan-strip`'s "the model's own input" does not hold there). In the repro seen here the model also skipped EnterPlanMode (plan mode was on).
Fix (beta.19): the review opens at an EnterPlanMode made in plan mode (mode `plan`, the proposal written into the file at once, the private plan backed up); an ExitPlanMode with no review open while a sign-off waits for the seat is denied once with both ways out (EnterPlanMode first for the sign-off; the same call again for the person's own plan); a plan-mode review closed without a Yes (Esc, a note, the next prompt, the turn's end) closes in place with the private plan put back and plan mode untouched, and a closing ExitPlanMode for one is denied, never let through with `setMode`.
Live (tmux, homes under /tmp/sh-fz, ivan in plan mode holding "# IVAN SECRET PLAN 2", hana asking sign-off on v2, v3, v5): EnterPlanMode in plan mode showed "opening plan room v2 for ivan" and the view the room plan; "Yes, manually approve edits" recorded `agreed (ivan)`, plan mode came back via EnterPlanMode, the plan file held the private plan again. Esc on v3 then the next prompt: closed in place, plan file back, nothing recorded. A forced direct ExitPlanMode on v5: denied with "ivan has a sign-off waiting (plan room v5); this ExitPlanMode would show ivan's own plan file instead", the model then called EnterPlanMode + ExitPlanMode and the view showed v5; Yes recorded, plan file intact. A room plan edit started in plan mode (v4): stored with the receipt as the deny, plan mode kept, private plan file intact.

## S4. Locks

**S4.1.** Claude Code bundles proper-lockfile (stale 10 s, update 5 s, realpath on, `{retries: {retries: 30, minTimeout: 5, maxTimeout: 100}}`, so a waiter gives up after about 2–3 s). File mode (not diskless, storageV5 off):
- list lock: target `<tasks>/<list>/.lock` (an empty file created with flag `wx`), lock dir **`<tasks>/<list>/.lock.lock`**; taken by create, reset, restore, writeTaskUnderId, raiseTaskIdMark;
- task lock: target `<tasks>/<list>/<id>.json` (realpath: must exist), lock dir **`<tasks>/<list>/<id>.json.lock`**; taken by update and claim, which do not take the list lock.
Seen with a raw `fs.watch` during a model's TaskCreate + TaskUpdate: `rename 5.json`, `rename .lock.lock`, `change 4.json`, `rename 4.json.lock` (`s4-1-watch.log`). Claude Code writes task files in place (not atomically).

**S4.2.** `spike/lockfile.ts` (no dependency: mkdir of `realpath(target).lock`, mtime refreshed every 5 s, a dir older than 10 s removed, rmdir on release; a write takes the list lock then the task lock, writes `<id>.json.tmp-<pid>` and renames). 200 read-modify-writes 100 ms apart on task 4 while the model made 8 sequential TaskUpdates of its activeForm: counter 200, activeForm "step 8", 0 parse errors in 4,711 reads, longest wait 7 ms (`s4-2-race.json`). Against the real proper-lockfile 4.1.2 with Claude Code's options in two child processes: 6,000 task-lock writes, none lost; 1,500 list-lock id allocations, no duplicate (`s4-2-heavy-race.txt`). Hold the locks for milliseconds only: Claude Code's own waiter gives up after ~2–3 s.

**S4.3.** A stray `9.json.tmp-999` is ignored by the view, the id allocator and the reset (all filter `*.json`); the reset does not delete it, so the projector cleans its own leftovers.

## Surprises

1. **The missing list dir** (S2.1): a session started before `<tasks>/sh-CODE/` exists never shows the list. Write the dir and task 1 before the spawn.
2. **Seeding moves to the module** (S3.1): the plan file is known only at `prompt.attachment(plan_mode)`. The plan's `editEntered` at Post(EnterPlanMode) can only mark the edit as pending.
3. **"User approved Claude's plan"** is drawn for the restoring ExitPlanMode (S3.5) whenever the plan file holds a plan at that moment; with the file emptied first it reads "Exited plan mode" (see S3.5). The receipt line and the Post context still say plainly that nothing was approved.
4. **`lib/room-claude.ts` `cleanEnv` drops empty values**, so an env-level login like `CLAUDE_SECURESTORAGE_CONFIG_DIR=""` never reaches the room session (its first turn failed "Not logged in" until the spike copy kept it). Only matters for that setup; worth a line in doctor or keeping that one key when set.
5. A `--bg` job attached later can show another account line ("Opus 5.5 · API Usage Billing") than the session that spawned it; no effect seen.
6. The default model's safeguard flagged the S3 prompt twice in bypassPermissions mode only (`[cyber]`); the run went on after Claude Code's own switch offer. Not a plugin issue.

## Recommendations for Phases 5–7

- Phase 5: `room-claude.ts` writes `<tasksDir>/sh-CODE/` (dir, `.lock`, task 1 `in_progress` owner `room`) under `lib/cc/tasklock.ts` before dispatching the job. `tasklock.ts` = the S4 protocol (list lock, then the task lock when the file exists; tmp + rename; raise `.highwatermark`). No scripted-turn fallback needed.
- Phase 6: seed in the hooks module on `prompt.attachment` type `plan_mode` (when the session doc has an open `edit` and the file is not seeded yet: back up the person's own plan file, write header + marker + vN, append a line to the reminder); capture at Pre(ExitPlanMode); stale → deny with both texts; stored → deny with the receipt, then the restoring ExitPlanMode through PermissionRequest allow + setMode (today's path), Post context "not approved". Every mode verified.
- Phase 7: `crossSessionInbound: "refuse"`; the rows-only turn at start and per join (Q1).

## Contract entries (drafted for §5.3; all PASS with `node scripts/probe-cc.ts --extra spike/contract-draft.json` on 2.1.296)

```json
[
  {
    "id": "task-file-schema",
    "section": 4,
    "stability": "incidental",
    "since": "2.1.296",
    "search": [
      "\".highwatermark\""
    ],
    "shape": [
      "id:~(),subject:~(),description:~(),activeForm:~().optional(),owner:~().optional(),status:~(),blocks:~(~()),blockedBy:~(~()),metadata:~(~(),~()).optional()})),~=\".highwatermark\""
    ],
    "note": "A task file is {id, subject, description, activeForm?, owner?, status pending|in_progress|completed, blocks[], blockedBy[], metadata?} (zod, safeParse: a file that fails is skipped and logged, never fatal). Extra metadata keys pass. lib/cc/tasks.ts NativeTask."
  },
  {
    "id": "task-highwatermark",
    "section": 4,
    "stability": "incidental",
    "since": "2.1.296",
    "search": [
      "[Tasks] raiseTaskIdMark",
      "[Tasks] could not record skipped task id "
    ],
    "shape": [
      "let[~,~]=await Promise.all([~(~,~),~(~,~)]);return Math.max(~,~)}"
    ],
    "note": "TaskCreate's id is max(highest <n>.json, .highwatermark)+1; .highwatermark only steers that allocation: a file the plugin writes at any id is shown. The projector raises the mark to its highest id (cc-2.1.296-tasks-plans.md S2.4)."
  },
  {
    "id": "task-lockfile",
    "section": 4,
    "stability": "incidental",
    "since": "2.1.296",
    "search": [
      "{retries:{retries:30,minTimeout:5,maxTimeout:100}",
      "{stale:1e4,update:null,realpath:!0,retries:0,fs:",
      "return r.lockfilePath||`${e}.lock`}",
      "[Tasks] updateTask"
    ],
    "shape": [
      "let ~=~(~(~),\".lock\");try{await ~().mkdir(~(~)),await ~(~,\"\",{flag:\"wx\"})}catch{}return ~}"
    ],
    "note": "File mode (storageV5 off, not diskless) locks with proper-lockfile (mkdir <realpath(target)>.lock; mtime refreshed every 5 s; stale after 10 s; 30 retries 5-100 ms): the list lock's target is <list>/.lock (an empty file made with wx), dir <list>/.lock.lock, taken by create, reset and restore; the task lock's target is <list>/<id>.json, dir <list>/<id>.json.lock, taken by update and claim (not the list lock). Observed with fs.watch (S4.1). lib/cc/tasklock.ts speaks this protocol."
  },
  {
    "id": "task-list-auto-reset",
    "section": 4,
    "stability": "incidental",
    "since": "2.1.296",
    "search": [
      "[Tasks] resetTaskList",
      "before a reset",
      "Task list reset still in flight; not arming another hide until it settles"
    ],
    "note": "A session whose task view is mounted (any interactive or --bg session with the list, attached or not) resets the list 5 s after it reads every task completed: under the list lock it raises .highwatermark and deletes every *.json (not dotfiles, not *.json.tmp-*). Observed detached in a --bg job (S2.3). The reason task 1 stays in_progress."
  },
  {
    "id": "task-ui-watch",
    "section": 4,
    "stability": "incidental",
    "since": "2.1.296",
    "search": [
      "Task list watcher error: ",
      "useTasksV2 cannot be called outside of a TasksV2StoreContext provider"
    ],
    "shape": [
      "var ~=5000,~=50,~=5000;class ~{"
    ],
    "note": "The task view fs.watch()es <tasksDir>/<list> and refetches 50 ms after a change, so a file written from outside shows at once (S2.1). The watch is set when the view subscribes: if the dir does not exist then, fs.watch throws, the throw is swallowed and nothing polls, and files written later never show in that session (S2.1): create the dir before the session starts."
  },
  {
    "id": "module-plan-mode-detail",
    "section": 10,
    "stability": "API",
    "since": "2.1.296",
    "search": [
      "\"plan_mode_reentry\""
    ],
    "shape": [
      "case\"plan_mode\":{let{reminderType:~,planFilePath:~,planExists:~}=~;return(~===\"full\"||~===\"sparse\")&&typeof ~===\"string\"&&typeof ~===\"boolean\"?{type:~.type,...~,detail:{reminder:~,planFilePath:~,hasPlan:~}}:~}"
    ],
    "note": "prompt.attachment type plan_mode carries detail {reminder full|sparse, planFilePath, hasPlan} as the request is made, and its text is rewritable: the one point that knows the plan file before the model's next call. PostToolUse(EnterPlanMode) does not (no plan_mode attachment, no slug in the transcript yet: S3.1)."
  },
  {
    "id": "exitplan-permission-setmode",
    "section": 3,
    "stability": "API",
    "since": "2.1.296",
    "search": [
      "case\"setMode\":",
      "User approved Claude"
    ],
    "note": "A PermissionRequest(ExitPlanMode) hook answering allow with updatedPermissions [{type:setMode, mode, destination:session}] leaves plan mode with no dialog in every mode (default, acceptEdits, bypassPermissions, dontAsk, auto, and with showClearContextOnPlanAccept on: S3.5). The transcript still draws \"User approved Claude's plan\" for it."
  },
  {
    "id": "cross-session-refuse-notice",
    "section": 8,
    "stability": "incidental",
    "since": "2.1.296",
    "search": [
      "is not accepting cross-session messages"
    ],
    "note": "With crossSessionInbound refuse the recipient gets nothing (no transcript, no turn); the sender's SendMessage first reports sent, then a notice says the message was refused and not delivered (S1.5)."
  },
  {
    "id": "bg-idle-no-prompt",
    "section": 5,
    "stability": "incidental",
    "since": "2.1.296",
    "search": [
      "send a prompt to start",
      "open this session to continue setup"
    ],
    "note": "`claude --bg` with no prompt dispatches and lists as idle (\"idle — send a prompt to start\"); a job whose only prompt a hook blocked lists under Needs input as \"open this session to continue setup\" (S1.1, S1.4)."
  }
]
```

Keep: `task-list-id`, `task-path`, `task-store-v5-off` (add `taskListHighWaterMark` as a degraded hint: it is the v5 key of the mark), `plan-mode-attachment`, `exitplan-normalize`, `exitplan-strip`, `cross-session-inbound` (note: refuse), `expansion-block-frame` (only if the blocked-expansion fallback is built). No longer needed once Phase 5 lands (no TaskCreate/TaskUpdate by a model, no TaskCompleted gate): `task-completed-block-drops-fields`, `task-completed-input`, `task-events-no-matcher` (unless `hook-events` needs it), `task-update-schema`, `task-create-metadata`.
