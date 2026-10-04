# Seat-subagent spike: live re-verification after the fix round

Run on 2026-10-04 from 05:24 to 05:40 local time (12:24–12:40 UTC), with Claude Code 2.1.281. The orchestrator ran Opus 5.5 and the seats ran Sonnet 5. No implementation file was changed.

**Setup.** The room was started with the v2 launcher's normal command line, `demo/bin/launch --humans "alice bob"`. A PATH shim (`/tmp/seat-reverify/bin/open`) swallowed the four `open -na Ghostty.app …` calls, so every session ran in detached tmux only (`room-orch`, `room-alice`, `room-bob`, `room-watch`). The humans were played by typing into the real `demo/bin/chat` clients in `room-alice` and `room-bob` with `tmux send-keys`. Those are TTY clients started by `demo/bin/start <human>`, with `ROOM_USER` set by the launcher. One exception: the orchestrator-identity `shutdown` posts for check 4 went through `ROOM_USER=orch demo/bin/room post`. A recorder (`/tmp/seat-reverify/panewatch.sh`) captured the orchestrator pane every second and flagged any permission or plan dialog.

**Evidence.**
- Room log: `demo/.room/log.jsonl` (39 entries, kept), plus `roster.json`, `tail-orch.cursor` and `plans/ethereal-watching-bengio.md`.
- Pane frames: `/tmp/seat-reverify/orch-pane.log`. Dialog hits: `/tmp/seat-reverify/dialogs.log`. Final pane: `/tmp/seat-reverify/orch-pane-final.txt`.
- Orchestrator transcript: `~/.claude/projects/-Users-tristantimblin-repos-sub-human/02af5d06-5bdf-4ca4-846e-da96909b25f0.jsonl`. Seats: `…/02af5d06-…/subagents/agent-a2f46ac732bc75b24.jsonl` (alice) and `agent-ada442094900a4c9f.jsonl` (bob).
- Room from before the run: `/tmp/seat-reverify/old-room-backup`.
- Declined-path scratch repo and room: `/tmp/seat-reverify/repo-copy`.

**Side effect, undone.** `launch` runs `demo/bin/reset`, which replaces `demo/app` with `demo/app.pristine`. The `demo/app` from before the run (with `paginate.js` and the pagination tests, not pristine) was backed up to `/tmp/seat-reverify/app-backup`. It was restored right after launch, and again after the run, because the run's plan added `/tasks/count` to it. The app as the run left it is at `/tmp/seat-reverify/app-after-run`.

## Results

| # | Check | Verdict | Key evidence | Timings |
|---|---|---|---|---|
| 1 | Lossless re-arm | **PASS** | Method: **kill the `room tail` process** (`pkill -f 'node demo/bin/room tail --for orch'` at 05:25:36.306). Bob's chat posted #4 at 12:25:36.321, 15 ms later, while no tail was running. The cursor held at 3. The Monitor reported "script failed (exit 143)". The orchestrator re-armed with exactly the same call (`--max-seconds 1790`, `timeout_ms 1800000`, no `--after`) at 12:25:38. The new tail delivered #4, and the orchestrator acknowledged it in #5 ("got #4 after the feed restarted"). The cursor advanced to 5. The clean `--max-seconds` exit path was also checked offline in a scratch `ROOM_DIR`: exit 0 after 2.04 s, an entry posted in the gap was delivered by the next tail, and the cursor advanced. | kill → re-arm ≈2 s; gap post delivered ≈2 s after posting |
| 2a | Seat read, tests and `git status` with no prompt | **PASS** | Alice's `/ask` #6. The seat used `Read store.js`, `Bash npm --prefix demo/app test` and `Bash git status`, one plain command each. `git status` failed with exit 128 ("not a git repository", because the repo has no `.git`), and the seat reported that honestly in #7. No dialog appeared in the orchestrator pane (`dialogs.log` stayed empty until 05:33). | /ask → reply **7.3 s** |
| 2b | Out-of-allowlist action → `question` | **PASS** | Alice's `/ask` #8 asked for a curl. The seat didn't try it and posted `question` #9 ("I can't run this… curl/network requests aren't available"). No prompt. The orchestrator followed up with #10, asking alice whether she needed it, and offered "I'll fetch it from here" (see R5). | 3.3 s |
| 3 | Automatic plan approval | **PASS, with one bug (R2)** | Alice asked for a plan in #11. The orchestrator loaded EnterPlanMode and entered plan mode itself. The plan write published `plan_rev` #12 `799e3d8ccbc7`. Alice signed in #14. The orchestrator first refused an early ExitPlanMode (#16) and called it only after bob consented in #17. The gate then denied: "ROOM-GATE: plan 799e3d8ccbc7 lacks sign-off from bob…" (12:29:55.258). Bob signed in #19 at 12:30:36.208. ExitPlanMode was called at 12:30:39.898, the gate returned allow with `updatedInput`, and plan mode was exited with **no dialog** (no "Ready to code?" in any pane frame). `decision` #20 was written by `decision-log.js` at 12:30:40.001, after the exit: `refs=[14,19]`, `plan_hash=799e3d8ccbc7`, "matched by tool_response.plan". **However,** the orchestrator also posted its own `kind:decision` #21 through `room post`, with no plan_hash and no refs. The digest therefore lists two decisions. | bob's signoff → exit 3.7 s; exit → decision 0.1 s |
| 3b | Declined path (`ROOM_GATE_CONFIRM=1`) | **PASS** | Run in an isolated copy of the repo (`/tmp/seat-reverify/repo-copy`, a Sonnet session with the same `room-settings.json`), so the main log stayed clean. `plan_rev` #1, then signoffs #2 and #3 through the real chat (piped). ExitPlanMode showed "Ready to code?", the verifier pressed Esc, and the session reported "User rejected Claude's plan". The scratch log still has exactly 3 entries: no `decision` and no `status`. | — |
| 4 | Waking a stopped seat | **PASS, with a manual keypress (R1)** | First attempt: `shutdown` #26 (text named it a test). Alice's seat stopped. The orchestrator saw "Agent finished", ran `room digest` (STOPPED, shutdown #26), posted directive #27 and sent SendMessage to `a2f46ac…`. That produced `seat_up` #28 ("resumed") and roster `live:true, up_id:28`. Second attempt, with neutral wording: `shutdown` #32, then alice's `/ask` #33 four seconds later. The digest showed `STOPPED (shutdown #32)`. The orchestrator's check command then hit a **permission prompt** (R1), which the verifier approved after 64 s. The orchestrator then posted directive #34 ("…answer alice's ask #33") and sent SendMessage. Resumed `seat_up` #35 followed, the seat answered #33 in #36, and the roster went back to `live`. `seat-park` honoured #32 even though #26 was older than the earlier `seat_up` #28. The resumed seat was not stopped again by the old shutdown. | resume 1.6–2 s after SendMessage; ask → answer 80 s, of which 64 s was the stalled prompt |
| 5 | Host as a seat / unattended orchestrator | **PARTIAL** | Startup needed no keypress: the Monitor was armed, both seats were spawned and the status was posted (#1–#3) within 7 s of launch, and the folder was already trusted. One **manual keypress** was needed (below). Separately, bob's seat stalled on a directive it could not observe (R3), which a human had to unblock. | — |

## Every manual keypress in the orchestrator pane

| Time | Key | Why |
|---|---|---|
| 05:34:58 | Enter (default "1. Yes") | The orchestrator's own Bash `demo/bin/room digest \| sed -n '/roster/,/current plan/p'; demo/bin/room read --id 32 2>/dev/null; demo/bin/room read --id 33 2>/dev/null` raised "sed command contains operations that require explicit approval… Do you want to proceed?" at 05:33:54. It stalled the stopped-seat recovery for 64 s, and would have stalled it forever unattended. |

No other key was pressed in `room-orch`. The launcher's own `accept_trust` found no trust prompt in this already-trusted repo. Keys pressed elsewhere: the declined-path scratch session (`rv-decline`, not the orchestrator) got Down+Enter on its trust prompt and Esc on the plan dialog.

## Remaining bugs

**R1. The orchestrator can still prompt itself (blocker for unattended).** Its compound Bash commands are approved or prompted inconsistently. `digest | sed -n '/current plan/,/open objections/p'` passed at 12:28:10 and 12:30:38. The same shape with `; … 2>/dev/null` prompted at 12:33:53. Nothing in `.claude/agents/room-orchestrator.md` restricts its own shell use, and the seat rules don't apply to it.
- Fix in `.claude/agents/room-orchestrator.md`: give it the same rule as the seats. One plain `demo/bin/room …` (or `npm --prefix demo/app test`) command per call, with no pipes, `;`, `&&` or redirections. Read files with Read.
- Fix in `demo/bin/room`: so it never needs `sed`, add `room digest --section roster|plan|open`, and accept several ids in `room read`. The latter already works (`--id 32,33`).

**R2. The orchestrator writes its own `kind:decision`.** #21 is a model-written decision, with no plan_hash and no refs, alongside the hook's #20. The digest lists both, so "decision logged once" holds for the hook but not for the room.
- Fix in `demo/lib/room.js` `append()`: refuse `kind:decision` unless the caller passes a hook-only flag, the way `plan_rev` uses `allowPlanRev`. Pass that flag in `demo/hooks/decision-log.js`.
- Fix in `.claude/agents/room-orchestrator.md`: "never post `decision`; the hook does; announce with `status`."

**R3. Conditional directives deadlock a seat.** Directive #23 told bob's seat to review "once alice's Claude posts done". `await_human` wakes only for asks to its own human, directives to it, `plan_rev` and `shutdown` (`demo/bin/room-mcp` lines 76–82). So `done` #24 never woke bob's seat. It sat "Awaiting alice's done post" for 8+ min. The orchestrator saw #24 and said it would "give it more time before nudging". Bob's own `/ask` #37 unblocked it (#38, 11 s).
- Fix in `.claude/agents/room-orchestrator.md`: "Never issue a directive that waits on another post; when the awaited post arrives, send the follow-up directive then."
- Fix in the seat template in `demo/bin/seats`: "act on a directive now; if it depends on something not yet in the log, reply with a status and wait for a new directive."
- Optionally, also wake seats on `done` and `decision` in `room-mcp`.

**R4. The seat template relies on Grep and Glob, which this CLI build doesn't have.** No Grep or Glob tool exists in 2.1.281 here: no transcript in the project ever calls one, and the seat itself said "I don't have a Grep tool" in #30. The orchestrator wrongly blamed the resume for it in #31. The template forbids `grep` and `find` in Bash, so seats can only search by Reading whole files. The allowlist already has `Bash(grep:*)`, `Bash(find:*)` and `Bash(ls:*)`.
- Fix in `demo/bin/seats` (template): "Use Grep/Glob if present; otherwise plain `grep -rn PATTERN demo/app`, `find demo/app -name X` or `ls DIR`, one command per call (these are allowlisted)."

**R5. The orchestrator offers to do non-allowlisted work itself.** In #10 it offered "I'll fetch it from here" for a curl. That would raise a prompt in the unattended pane, or a network action the room didn't sanction. Fix in `.claude/agents/room-orchestrator.md`: the orchestrator has the same limits as the seats. Anything outside the allowlist goes back to the room as a `question` for a human to do.

**R6. The launcher's trust auto-accept would exit on a fresh checkout.** In a folder that isn't trusted yet, the trust dialog warns that `.claude/settings.json` pre-approves 5 permissions, and its default is **"No, exit"**. `accept_trust` in `demo/bin/launch` sends Enter, which exits Claude (reproduced in the scratch copy: `EXIT=1`). It worked here only because the repo was already trusted. Fix in `demo/bin/launch`: send Down then Enter when the pane shows "No, exit", or document a one-time manual trust.

**R7. A `Write(...)` allow rule is ignored.** On startup the CLI warns "Permission allow rule (demo/room-settings.json): Write(demo/app/**) is not matched by file permission checks — only Edit(path) rules are." It is harmless today, because acceptEdits and `Edit(demo/app/**)` cover it. Fix in `demo/room-settings.json`: drop `Write(demo/app/**)`.

**Minor.**
- The orchestrator's tail skips its own entries. A `shutdown` stamped `from=orch` (as in this test) is therefore never seen in the feed. The orchestrator learned of the stop only from the "Agent finished" notification. That worked, but it relies on the notification.
- Questions #9, #10, #13 and #16 stay "open" in the digest forever. The old "no close mechanism" item still applies.
- Alice's `/ask` to a STOPPED seat is invisible to the orchestrator, because the tail skips asks addressed to seats. Here the orchestrator noticed only because it read #33 while checking the shutdown. If a seat dies silently (crash, not shutdown), a human's `/ask` gets no answer and nobody is told. Consider letting the tail pass asks addressed to a seat whose roster entry is `live:false`, in `demo/bin/room` `skip()`.

## Approximate cost

These are API-equivalent figures, deduplicated by message id. The account is on Claude Max.
- Orchestrator (Opus 5.5): 52 calls. 138 input, 81.9k cache-write, 3.46M cache-read and 10.2k output tokens, about **$2.49**.
- Alice's seat (Sonnet 5): 27 calls. 40.7k cache-write, 757k cache-read and 5.7k output tokens, about **$0.47**.
- Bob's seat (Sonnet 5): 8 calls. 35.5k cache-write, 137k cache-read and 2.0k output tokens, about **$0.21**.
- Declined-path scratch session (Sonnet 5): about $0.10.

**Total: about $3.3.** Nothing looped. Parked seats and the idle orchestrator produced no events between notices.

## Verdict

**Not yet ready for a real two-human trial with the orchestrator fully unattended. It is close.** Every fix from round one holds live:
- the re-arm is lossless;
- seats no longer prompt and escalate out-of-allowlist work as `question`;
- the full sign-off matrix exits plan mode with no click, and the decision is logged once, after the exit, with refs;
- a declined dialog logs nothing;
- stopped seats are detected, resumed and marked live.

Two things still need someone at the orchestrator's keyboard, or leave a human waiting:
- **R1:** the orchestrator's own compound shell commands can prompt.
- **R3:** conditional directives deadlock a seat.

Fix R1 and R3, plus R2 and R4, which are cheap. Then run the trial with someone able to glance at the orchestrator window for the first session. Also fix R6 before the trial if it runs on a fresh machine.

## Cleanup

`demo/bin/stop` ran at 05:40:13 and printed "demo stopped" (exit 0). Afterwards:
- `tmux ls` reported "no server running";
- `pgrep -f` for `claude -n room-orch`, `claude -n rv-decline`, `room-mcp`, `room tail`, `demo/bin/chat` and the pane recorder found nothing;
- `lsof -ti tcp:3000` was empty.

The scratch session `rv-decline` had been killed earlier. `demo/.room` is kept as evidence. `demo/app` was restored to its state from before the run.
