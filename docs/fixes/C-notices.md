# C: notices (issues #3, #4, #6)

Agent C. Evidence: room log `vole-8126`, transcripts orch `87f74412`, alice `9eab63ac` + `63ba0360`, bob `e7f9e953`, panes S8–S11.
Labels: **[probe]** verified-by-probe, **[src]** verified-by-source (plugin code, binary strings, transcript records), **[inf]** inferred.

## Shared root cause

`bin/sub-human tail` (lines 148–156) writes **one stdout line per visible entry, at the moment it is appended** [src]. Two things follow:
- Claude Code turns each 200 ms batch of lines into one `<task-notification>`, which costs a turn if the session is idle (06 §1; binary [src]: "Stdout lines within 200ms are batched into a single notification"). Only #9+#10 and #13+#14 (1 ms apart) shared an event here; every other entry got its own.
- The line describes the room **as it was at append time**, not when the model reads it. Nothing retracts a superseded line.

`visibleTo()` (lines 87–101) pushes every `via=human` post and every orch/system entry to every member. `member.md:14` says "Tell NAME each in one line", so each wake also produces narration.

**Wakes in vole-8126** [src: `<task-notification>` user turns in the transcripts]:

| Session | Wakes | Wake entries |
|---|---|---|
| orch | 12 | #1, #3, #4, #6, #8, #11, #15, #17, #20, #21, #23, #27 |
| alice | 17 | #2, #6, #7, #9+10, #11, #12, #13+14, #16, #17, #18, #19, #22, #23, #24, #25, #27, #28 |
| bob | 10 | #4, #5, #8, #9+10, #12, #13+14, #15, #16, #18, #19 |
| **Total** | **39** | Each member wake puts a "⏺ Monitor event" header and 1–4 narration lines in the pane. |

## #3: the orch acted on stale membership

**Root cause [src: orch transcript].** #23 `member_left` was dequeued at 19:00:10.740 and started a turn. #24 "bob rejoined" was enqueued at 19:00:13.510 as a `queued_command`, while the model was already sampling (message `…aBR`). That sampling emitted the post at 19:00:15.561, which became #25. Only then, at 19:00:15.714, did the queue log #24 as `remove … reason: absorbed`.

So the model could not have seen #24 before posting: a notice can't reach a sampling call that is already running. Nothing in the plugin re-checks membership either. `orchestrator.md:25` says "`member_left` → post that NAME left", and `room-server.js post()` accepts any `refs`.

**Fix (a), current plugin. Three layers, about 45 lines in all, low risk:**
1. **Settle leaves in `tail`** (about 25 lines). Hold `member_left X` for L = 8 s. If `member_joined X` arrives within L, drop both; otherwise print the line with "· away 8s+". Held ids count as `inflight`, so the cursor rule in `s.save()` (line 128) survives a restart. Cost: 8 s of latency on real leaves.
2. **Stale-ref guard in `mcp/room-server.js post()`** (about 12 lines). If `refs` cites a `member_left` for X, and `members.json` shows X present again with a later `joined_at`, refuse with: `refused: stale — X rejoined at #N; read #N and post again`.
3. **Role text, `orchestrator.md:25`.** Change it to: "`member_left` arrives only after 8 s away. A post refused as stale: re-read and decide again." This is the only exception to "don't retry a refused post".

**Fix (b), slim design.** Membership is still logged, so the race remains. But the slim orchestrator has no "react to every leave" rule: facilitation is optional and the work ledger is a task list, so the action that misfired is gone. Keep the 8 s settle in the slim monitor (about 20 lines). [inf]

**How to verify it.** Unit test with `SUB_HUMAN_POLL_MS=50`: `member_left bob` then `member_joined bob` 3 s later prints nothing; a lone `member_left` prints at 8 s or later. Re-run S11 (bob `/exit`, then `--continue`): pass if no orch post cites the leave.

## #4: stale reminders, narrated one at a time

**Root cause [src].** #16 "plan eaae7e5e855a is waiting for sign-off from bob" (a gate status from `plan-gate.js`) was written at 18:57:33.051. bob signed in his form at 18:57:34.694 (#17). His Claude narrated #16 at 18:57:34 ("…still waiting for your sign-off. The form should still be available"), and that line stayed on screen from S8-3 through S10 (`grep "still waiting" S8-3/S9/S10-sh-bob.txt`).

For an approver the reminder is redundant anyway: the form is open, and `segments.js` already shows `⚠ your sign-off needed`. alice narrated #15, #16 and #17 the same way, one entry per turn.

**Fix (a), current plugin. Coalesce at flush time and report current state** (`bin/sub-human tail`, about 60 lines; medium risk, because the cursor logic changes):
- **Settle.** Buffer the visible entries. Flush after Q = 1.5 s with nothing new, or after M = 5 s at most. Write **one line per flush**, which means one notification and one turn.
- **Supersession,** judged against `room.readAll()` at flush time, reusing the alerter's `lookup()` (lines 142–146: `signedByMe`, `decided`). Drop a gate "waiting for sign-off" status once I have signed, the plan is decided, or a newer `plan_rev` exists. Drop a `plan_rev` that a newer one replaced, or that names me when I have already signed it.
- **State, not events.** Each flush opens with computed state, then lists the new `#id` heads:

  ```
  room now: plan eaae7e decided #18 · you: signed · away: bob
  ```

- **Role text, `member.md:14`.** Change it to: "A notice is for you: act on it, or tell NAME in one line. Never restate sign-off status; the form and the status line show it live."

**Fix (b), slim design. Gone by design [inf].** The gate status posts go with the plan-mode gate, and sign-off becomes a native consent card (SYNTHESIS, Consent). Unaddressed news arrives as `UserPromptSubmit` `additionalContext`, built at prompt time, so it is never older than the turn (06 §2 [probe]).

**How to verify it.** Fixture: `plan_rev`, then the gate status, then the member's `signoff` 1.6 s later. Pass if `tail` flushes one line containing `you: signed` and no "waiting". Then replay S8: pass if no bob pane shows "still waiting" after #17.

## #6: "Monitor event" + narration noise, a turn per event

**Root cause [src].** `visibleTo()` is too broad, and `member.md:14` asks for narration. The `⏺ Monitor event: "sub-human room notices"` header is native and fixed: the manifest has only `name`, `command`, `description` and `when` (06 [src]). The only lever is to emit fewer lines.

**Fix (a), current plugin. A "concerns me" filter in `visibleTo()` for members** (about 20 lines, low risk):
- **Push only:** `to === me`; a `plan_rev` naming me, if unsigned and undecided at flush; a `decision` on a plan I approve; an orch post that names me and cites a decision (the assignment).
- **Pull everything else** (other people's posts, signoffs, objections, gate statuses, joins and leaves). It goes into an `at-room.js` `additionalContext` digest: "Room since your last turn: …", capped at about 1.5k characters, cursor `ctx-<name>`, about 30 lines. That hook fires on wake turns too, so one push carries the whole backlog (06 [probe]).
- **Orch.** It keeps seeing everything, with coalescing. Push a `signoff` only when it completes the matrix: that removes the refused ExitPlanMode on #15, which is issue #8's red error.

**Turns saved, replaying vole-8126 through these rules [inf, computed from the table above]:**

| Session | Today | Filter only | + settle + #3 fix | Remaining wakes |
|---|---|---|---|---|
| alice | 17 | 9 | 8 | #2, #7, #9, #13, #18, #19, #22, #28 (#25 is never posted) |
| bob | 10 | 5 | 5 | #5, #9, #13, #18, #19 |
| orch | 12 | 12 | 10 | #23+#24 cancel out; the partial signoff #15 becomes pull |
| **Total** | **39** | **26** | **23** | Member wakes 27 → 13 (**−52%**); all wakes −41% |

Also: the wrong post #25 and its retraction #26 disappear, and member panes lose 14 "Monitor event" blocks. #18 and #19 (4.6 s apart) don't merge at Q = 1.5 s; merging them would need Q ≥ 5 s, which isn't worth the latency.

**Fix (b), slim design. Native-shaped by design.** The monitor pushes only "concerns me" lines and everything else is pull. Claude-to-Claude traffic moves to SendMessage, which wakes only the addressee, and the role text (about 500 characters) has no narration rule.

The 06 target is at most 6 wakes per member. vole-8126 lands at bob 5 and alice 8; alice goes over because the build phase addressed her 4 times.

**How to verify it.** Re-run the walkthrough and count `<task-notification>` user turns per member transcript. Pass if alice ≤ 8 and bob ≤ 5, and if alice's next typed prompt carries #6, #11 and #17 as a `hook_additional_context` attachment.
