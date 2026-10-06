# S1: headless orch + native messaging + native tasks

Claude Code 2.1.281, 2026-10-05. Probe in `/tmp/nx-s1` (plugin copy at `/tmp/nx-s1/plugin`), room `nxs-4101`, list
`sh-nxs-4101`. Members alice and bob ran interactive Haiku in tmux `nx-s1-{alice,bob}`. Three orch launches were
needed (the model findings are below); the final one was `0b500131`. Estimated cost is about $1.3 at list prices:
Sonnet 5 orch 1.41M cache-read, 133k cache-write and 7.3k output tokens; Haiku 1.79M, 83k and 6.6k. Everything was stopped
and `claude rm`'d, `~/.claude/tasks/sh-nxs-4101` was deleted, and no tmux sessions are left. The transcripts are still in
`~/.claude/projects/-private-tmp-nx-s1-work/`.
Labels: **[probe]** verified by probe, **[src]** verified by binary strings, **[inf]** inferred.

## Exact working commands

```sh
# clean env: USER/LOGNAME are required (without them interactive members show "Not logged in · Please run /login") [probe]
# PATH has spaces ("Application Support"), so quote it or use a wrapper script
run() { env -i USER="$USER" LOGNAME="$USER" TMPDIR="$TMPDIR" HOME="$HOME" PATH="$PATH" TERM=xterm-256color "$@"; }
cd /tmp/nx-s1/work && run claude --bg -n orch.nxs-4101 --setting-sources project,local --plugin-dir /tmp/nx-s1/plugin \
  --agent sub-human:orchestrator --permission-mode plan \
  --settings '{"env":{"SUB_HUMAN_HOME":"/tmp/nx-s1/home","SUB_HUMAN_ROOM":"nxs-4101","CLAUDE_CODE_TASK_LIST_ID":"sh-nxs-4101","CLAUDE_CODE_ENABLE_TODO_TOOLS":"1"},"crossSessionInbound":"accept"}' \
  "/sub-human"                         # -> "backgrounded · 0b500131 · orch.nxs-4101"
tmux new -d -s nx-s1-alice -c /tmp/nx-s1/work "run claude --model haiku --setting-sources project,local --plugin-dir /tmp/nx-s1/plugin"
#   then type: /sub-human alice nxs-4101
claude logs 0b500131 ; claude attach 0b500131 ; claude stop 0b500131   # view / take over / stop
```

Changes to the copy only:
- `join.js`: the orch binds `SUB_HUMAN_ROOM` as its room code.
- `common.js`: `seatTitle` = `NAME.CODE`.
- The orch agent gets `SendMessage, ListAgents, TaskCreate, TaskUpdate, TaskList, TaskGet`.
- The orch role text (`skills/sub-human/orchestrator.md`) is replaced by a 7-line spike text: create the room task, act on messages, make row calls.
- `hooks/probe.js` (new): logs UPS, PostToolUse(TaskCreate|TaskUpdate), TaskCompleted and SessionEnd payloads; refuses typed orch prompts; exits 2 on TaskCompleted when `owner=="room"`.
- `session-end.js`: when the last member leaves, it spawns a detached `sh -c 'sleep 3; claude stop <job>'`. The job id comes from `<room>/orch.json`.
- `monitors.json`: `when:"always"` (see F1).

## Gate verdicts

| # | Item | Verdict |
|---|---|---|
| 1 | `--bg` plan-mode orch starts, joins, arms the monitor; no held dialogs; idle cost | **PASS with 3 fixes** (F1–F3) |
| 2 | `NAME.CODE` addressable both ways; wake < 10 s; ≥ 9/10 directives; UPS sees the envelope | **PASS** |
| 3 | One participant row per member, spawned in `--bg` plan mode | **PASS** |
| 4 | Native tasks in plan mode; TaskCompleted and PostToolUse fire; native room task; survives; gate refuses | **PASS** (F6, F7) |
| 5 | logs read-only; attach + typing reaches UPS and is blocked | **PASS** (F8: slash commands get through) |
| 6 | A hook-spawned `claude stop` after the last member leaves | **PASS** (F9) |

## Findings

**1. Start, join, dialogs, cost**
- Start [probe]: the orch printed `backgrounded · <id> · orch.nxs-4101`. The "no agent named 'sub-human:orchestrator'" warning is spurious, as in 02.
- Join [probe]: within about 10 s the join hook bound it as orch of `nxs-4101`. `agentSetting` was correct. There was no trust, permission or peer-hold dialog in plan mode with `crossSessionInbound:"accept"`.
- The status line showed `⏸ plan mode on`. `state.json` `respawnFlags` keep `--settings` and `--model`.
- **F1, monitor not armed at launch** [probe]. With `when:"on-skill-invoke:sub-human:sub-human"`, the launch prompt `/sub-human` did not arm it: there was no `sub-human tail` process and `inFlight.kinds:[]`.
  - A second `/sub-human`, typed via attach, armed it (`1 monitor still running`).
  - The subscriber to `skillInvoked` is a UI effect that subscribes after the initial prompt has already run [src: `WB.of(v).skillInvoked.subscribe` in a `useEffect`]. This is a startup race.
  - **Fix (verified):** `"when":"always"` armed at launch (`inFlight.kinds:["monitor"]`). `tail` stays silent until the session is registered, so members are unaffected.
- **F2, plan mode overrides `--model haiku` with Sonnet 5** [probe].
  - Every orch assistant message had `model:"claude-sonnet-5"`, even though the banner read "Haiku 4.5". This held with `--model haiku`, with `"model":"haiku"` in `--settings`, and with `model: haiku` in the agent frontmatter.
  - Control runs: `--bg --model haiku` gave `claude-haiku-4-5`; `--bg --model haiku --permission-mode plan` gave `claude-sonnet-5`. The string "Opus in plan mode, else Sonnet" exists [src].
  - Budget the orch at Sonnet 5 rates: about 100k cache-read tokens per directive turn here.
- **F3, trust** [probe]. `--bg` holds no trust dialog. It refuses outright with `Workspace not trusted. Run claude in <cwd> once…`.
  - A plain dir under the trusted `/private/tmp` inherited trust, but the same dir after `git init` was refused.
  - So join must spawn the orch in the joiner's (trusted) cwd, and should surface that error if it appears.
- Idle cost is 0 [probe]: `state.json` `tokens` stayed at 4694 from 00:39:40 to the stop at 00:42:46 with the monitor armed. 02 measured 8 idle minutes.
  - While the monitor runs, `claude agents --json` shows the orch as `busy`.

**2. Messaging**
- ListAgents works both ways [probe]. alice's ListAgents listed `orch.nxs-4101 [4f0df7] · bg · busy` and `bob.nxs-4101 [983c76] · interactive`.
  - Members' titles came from the hook (`sessionTitle`); the orch's came from `-n` (`nameSource:"user"`). The `.` in names caused no problem.
- Wake latency [probe]: 12 directives went bob → orch by SendMessage. From bob's SendMessage to the orch transcript entry took 0.0–0.1 s. To the orch's first assistant entry took 2.2–3.5 s (once 7.1 s, with long thinking).
- **10/10 directives acted on** (D1–D10) [probe]:
  - creates, owner and status updates, and completes all landed in `~/.claude/tasks/sh-nxs-4101`;
  - every ACK came back, orch → bob (D2, D8–D10) and orch → alice (D5): `› Message from @orch.nxs-4101: ACK-D5`;
  - D8 ("complete the room task") was refused by the model under its standing rule and reported back. That still counts as handled.
- The orch's UPS gets the envelope [probe]. The `prompt` arrives as `<cross-session-message from="uds:/tmp/cc-socks/50577.sock" from-name="bob.nxs-4101" from-mode="prompting">\nD1: …`. All 12 directives arrived this way, and members' UPS look the same.
  - Monitor notices arrive as `<task-notification>…Monitor event…`.
  - So the "refuse typed, accept peer" rule is: allow the `<cross-session-message`, `<task-notification` and launch-command prefixes, and block everything else.

**3. Rows** [probe]. Each `member_joined` push made the orch call `Agent({subagent_type:"sub-human:participant", description:"alice", prompt:"member: alice", run_in_background:"true"})`, and the same for bob.
- The orch's `claude logs` shows `⏺ main / ◯ alice working` and `sub-human:participant bob`.
- `rows/holds-orch.json` = `{members:["alice","bob"]}`.
- One orch turn per join.

**4. Native tasks**
- TaskCreate and TaskUpdate (status, owner) work in `--bg` plan mode on `sh-nxs-4101` [probe]. Haiku/Sonnet loaded them with ToolSearch first; they are deferred.
- **The native room task works** [probe]. At startup the orch created `#1 "room nxs-4101 open"` and updated it to `in_progress, owner:"room"` in its first turn. It shows in the panel as `◼ room nxs-4101 open` and in TaskList, because it is visible by design.
- **It survives** [probe]. After D7 completed the last other visible task (#2 and #3 done, #1 in progress), the dir and all files were still present 37 s later, and #4 was then created normally. The dir also survived `claude stop`, so A's reap must delete it.
- Hooks fire in the `--bg` orch [probe]:
  - PostToolUse(TaskCreate|TaskUpdate) runs on every call, with `CLAUDE_CODE_TASK_LIST_ID=sh-nxs-4101` in the hook env.
  - TaskCompleted runs as well. Its payload carries `task_id`, `task_subject` and `session_id`, but no owner, so the gate reads `~/.claude/tasks/<list>/<id>.json`.
- **The gate refuses** [probe]. On #5 (owner `room`), TaskCompleted exited 2 and the task stayed `pending`. The tool result was `TaskCompleted hook feedback: … the room task #5 stays open until the room closes`. The model asked to complete #1 twice (D8, D11) and declined both times, so the hook is a backstop.
- **F6:** PostToolUse fires for a refused update too, with `tool_response.success:false` and an `error` field. The mirror must skip those.
- **F7:** TaskCompleted fires about 35 ms before PostToolUse.

**5. Viewing** [probe]
- `claude logs <id>` is a passive ANSI snapshot.
- `claude attach` + typing `hi from a viewer` reached UPS. The block showed `UserPromptSubmit operation blocked by hook: the orch takes no typed input; use @room or ask your Claude to message orch.nxs-4101`. The prompt was not written to the transcript and no turn ran (3 turns before and after).
- **F8:** typed slash commands pass a "starts with `/`" allowance; `/sub-human` re-ran the join from the viewer. Allow only the first `/sub-human` (orch not yet bound), or no slashes at all.
- Peek-reply was not driven (I wasn't willing to navigate the shared agent view). 02 shows it lands as a typed prompt, which takes the same UPS path [inf].

**6. Stop** [probe]
- bob `/exit` (the last member) → SessionEnd → a detached `sh` → `claude stop 0b500131` → `stopped 0b500131`, exit 0, 3 s later (the built-in sleep). `claude agents --all` showed `state:"stopped"`.
- In an earlier run alice's exit stopped the orch the same way.
- **F9:**
  - The orch's own SessionEnd also runs `session-end.js` and logs `orch left (other)`, so guard it on role.
  - A member with live rows gets an `Exit and stop tasks / Move to background / Stay` dialog on `/exit`. SessionEnd fires only after the member confirms.

## For Phase 2
- **A:** spawn in the joiner's cwd with the clean env above, including USER/LOGNAME.
- **A:** the room task is native: the orch creates it in its first turn. A writes no sentinel file. Reap removes `~/.claude/tasks/sh-CODE` after the stop.
- **B / F:** the refusal allowlist is in F8; the gate reads the task file; the mirror skips `success:false`.
- **Monitor:** `when:"always"`, or S3's fallback.
- **Budget:** the plan-mode orch runs on Sonnet 5.
