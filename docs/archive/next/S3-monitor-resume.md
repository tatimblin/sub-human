# S3: is the `room` monitor live after `/clear`, `--continue` and `--resume`?

Claude Code 2.1.281, Haiku. Probe dir `/tmp/nx-s3` (plugin copy `plugin/`, `SUB_HUMAN_HOME=home/`, hook log `fclog.txt`,
`debug-{1..7}.txt`), tmux `nx-s3-{a..g}`, launched with `env -i HOME USER LOGNAME PATH TERM SUB_HUMAN_HOME claude --model haiku
--setting-sources project,local --plugin-dir /tmp/nx-s3/plugin` (`USER` is needed, or the keychain login is not found).
Room `osprey-4845`: fake `orch` and `bob` seats on live `sleep` pids; a keeper rewrote `rows/holds-alice.json` so the join made no row
calls. Pushes were `room.append({kind:'say', to:'alice'}, {via:'agent', from:'bob'})` from the plugin's `lib/room.js`.
About $0.35 in total. Everything was killed afterwards. Labels: **[probe]** observed here, **[inf]** inferred.

## Findings (shipped `when: on-skill-invoke:sub-human:sub-human`)

| Step | Footer | `sub-human tail` process | Push to alice | Verdict |
|---|---|---|---|---|
| A: `/sub-human:sub-human alice CODE` | `1 monitor` | started | "Monitor event: sub-human room notices", 1 turn | live [probe] |
| B: `/clear` | `1 monitor` | **same pid** (45096) | woke, 1 turn | live [probe] |
| C: `/exit` + `--continue` | no monitor | none | **no wake** (#7 sat unread) | **dead** [probe] |
| D: `/exit` + `--resume <sid>` | no monitor | none | **no wake** (#10) | **dead** [probe] |
| D': run `/sub-human:sub-human alice` again | `1 monitor` | new pid | one wake carrying #7 and #10 | re-armed [probe] |

- **F1** `/clear` keeps the same monitor process. Its `CLAUDE_CODE_SESSION_ID` is now stale, but `resolveSelf()` still finds the seat
  through `CLAUDE_PID` [probe].
- **F2** `--continue` and `--resume` don't restore an `on-skill-invoke` monitor. The seat comes back (`session-restore.js`
  rejoins, the title shows `osprey-4845 · alice`), but nothing is watching the room. This is the open risk in `rebuild-plan.md`, now
  confirmed [probe].
- **F3** Nothing is lost while the monitor is down. The `tail-<name>` cursor replays the backlog in one batch once the monitor
  re-arms (D') [probe].

## The fallback, prototyped: SessionStart `watchPaths` + FileChanged `asyncRewake`

`hooks/s3-watch.js` (SessionStart, any source) gets the seat from `resolveBySession(sid) || lastSeat(sid)` and returns
`watchPaths:[<room>/log.jsonl]`. `hooks/s3-fc.js` (FileChanged, `asyncRewake:true`) reads entries past cursor `fc-<name>` under a lock.
It exits 2 with `stateLine` plus `room.line()` for push-lane entries, and exits 0 otherwise. The files are in `/tmp/nx-s3/plugin/hooks/`
(`hooks.fc.json`).
- **F4** It works after `--resume`. A `status` entry not addressed to alice ran the hook, which exited 0: no turn. The push to alice
  exited 2 and woke the session. The append-to-wake latency was **0.70 s** (chokidar's 500 ms write-finish delay, plus a 2 ms hook).
  The tail takes about 2 s (250 ms poll plus a 1.5 s settle) [probe].
- **F5** How the wake renders. The user sees **"⏺ Stop hook feedback"**. The model sees
  `<summary>Stop hook feedback</summary>` and then `Stop hook blocking error from command "FileChanged": <stderr>`. The wording is
  fixed, so even a prefix like "(not a hook error)" in the stderr text sits inside an "error" frame. The UserPromptSubmit digest still
  rode along on that turn: the model also mentioned #13, the entry that wasn't addressed to alice [probe].
- **F6** Its structural costs (see 06 §4):
  - it duplicates the monitor after `/clear` (which keeps the monitor alive), unless SessionStart arms it only on `resume`;
  - it duplicates again if the member re-runs `/sub-human` (D') after a resume;
  - a fresh join can't arm it, because UserPromptExpansion has no `watchPaths`;
  - each append to the room log spawns one node process per watching session.

  So it would need to coexist with the monitor, plus de-duplication logic [inf].

## `when: always` with the silent tail (the existing `tail` is silent until `resolveSelf()` finds a seat)

| Step | Result |
|---|---|
| `--resume <sid>` | `1 monitor` at once; the push woke the session in about 2 s [probe] |
| `/clear` | same monitor; woke [probe] |
| `--continue` | `1 monitor`; woke [probe] |
| fresh session, then `/sub-human carol CODE` | one tail process (no second copy at skill invoke); it found the seat within the 2 s re-resolve and the push woke the session [probe] |
| idle cost, no seat | about 44 MB RSS, 0.03 s CPU per 30 s for node, plus one `ps -A` spawn every 2 s from `resolveSelf()`'s ancestor walk [probe] |

- **F7** With `always`, every path works: start, join, `/clear`, `--continue` and `--resume`. It keeps the clean "Monitor event"
  framing, and it needs no new hook or cursor [probe].
- **F8** Its cost is one idle node process per Claude Code session wherever the plugin is enabled. Every such session also shows a
  permanent `1 monitor` in its footer. The `ps` spawn every 2 s is avoidable: in `tail`, skip the ancestor walk and resolve only by
  `CLAUDE_CODE_SESSION_ID` / `CLAUDE_PID` (both are set for monitors), or back off to about 10 s while no seat is found [inf].

## GATE verdict

**S3 FAILS as written.** The `on-skill-invoke` monitor survives `/clear` but not `--continue` or `--resume`.

**Recommended mechanism: switch `monitors.json` to `"when": "always"`**, not to FileChanged + `asyncRewake`.
- It is a one-line change.
- It restores itself on every path, its latency matches the current monitor, and it has no duplicate-wake hazard.
- It avoids the misleading "Stop hook feedback / blocking error" wording.

Pair it with a cheaper unresolved path in `bin/sub-human tail`: no `ps` walk, and a slower re-resolve while no seat is found. Keep
FileChanged + `asyncRewake` only as a documented reserve, for the case where "1 monitor in every session" turns out to be unacceptable.
In that case, arm it only on SessionStart `resume`, and suppress it while a live `tail` holds the seat.

A stopgap with no code change: after a resume, re-running `/sub-human NAME` re-arms the monitor and replays the backlog (F3).
