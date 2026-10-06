# Experience evaluation 1: making a simple plan

Date: 2026-10-04. Room `dingo-8953`, using plugin commit `b098a42`.

Three people planned `GET /tasks?limit` in normal Claude Code sessions, with an unattended orchestrator:
- **tristan:** a real human.
- **alice and bob:** typed by Claude, playing humans.

The plan was approved by all three through the native dialog. The decision and assignments followed with no manual help. The hash chain validates (28 entries).

## Timeline

| Step | Time | Elapsed |
|---|---|---|
| alice asks tristan to build `?limit` (#6, `@room`) | 19:47:4x | — |
| orch asks 4 edge-case questions (#7) | 19:47:50 | ~5 s |
| tristan answers (#8) | 19:52:06 | 4 m 16 s (human) |
| orch finds the endpoint doesn't exist; offers options A/B/C, "I lean A" (#9) | 19:52:22 | 16 s |
| bob joins (#10); orch briefs him with context (#11) | 19:55:51 → 54 | 3 s |
| bob: "A breaks mobile" (#12) | 19:56:14 | — |
| orch synthesis: a cursor via `?after=<id>` that keeps the bare array (#13) | 19:56:21 | **7 s** |
| alice's objection crosses #13 (#14); orch points out #13 already covers it (#15) | 19:56:36 → 40 | 4 s |
| alice and bob agree (#16, #17) | 19:56:59 | — |
| plan published, gate waits on all 3 (#18, #19) | 19:57:22 | 23 s |
| alice and bob sign off in the native dialog (#23, #24) | 19:57:45 | 23 s |
| tristan signs off (#26) | 20:01:35 | 3 m 50 s (human) |
| decision (#27), then contract and assignments (#28) | 20:01:37 → 43 | 8 s |

The machine steps all took seconds. All of the waiting was on humans. From bob joining to a published plan took **91 s**.

Message counts: 11 orch posts (average 456 chars, max 1,381), 10 human `@room` posts, 4 system entries, and **0 posts from member Claudes**.

## What worked

1. **Facilitation was very good.**
   - It briefed a late joiner in 3 s.
   - It found a third option that met both concerns (#13).
   - It noticed a crossed message and resolved it rather than restarting (#15).
   - It told the one member who hadn't spoken on #13 that "your sign-off counts as agreeing to it" (#21).
2. **Native approval worked.** Each member's dialog showed the room's exact plan. Sign-offs arrived about 20 s after publish, recorded `via=human` against the hash.
3. **The stall fix held.** Decision to assignments took 6 s, with no nudge needed.
4. **`@room` came through exactly as typed**, and the room switch worked when tristan rejoined from the same session.

## Friction (prioritized)

| # | Finding | Evidence | Suggested fix | Where |
|---|---|---|---|---|
| E1 | **Anyone who joins becomes a required approver.** tristan joined to try it and became a blocker; the gate waited on him for 3 m 50 s. | #19 "waiting for sign-off from alice, tristan and bob" | Add an observer role, e.g. `/sub-human NAME CODE watch`. Or make the approvers the members who took part in the discussion, with the gate requiring at least the participants instead of every member. | `join.js`, `plan-gate.js`, `orchestrator.md` |
| E2 | **The approval dialog is misleading.** It reads "Claude has written up a plan and is ready to execute", and its default option is "Yes, and use auto mode". | dialog capture | We can't change the dialog. Start every room plan with a fixed first line, e.g. "Room plan: approving signs off for the room. Your Claude will not run it. Choose option 2." Also refuse or warn when auto mode is chosen (verifier F2). | `orchestrator.md` plan template; `plan-result.js` |
| E3 | **`@room` confirmation looks like an error.** It shows "UserPromptSubmit operation blocked by hook: sub-human: posted to room… as #17". | bob pane | Reword the reason to read as a receipt ("✓ posted to dingo-8953 as #17"). Check whether a `systemMessage` renders better than the block reason. | `at-room.js` |
| E4 | **A member's own Claude can't see its human's `@room` posts.** alice's Claude said "I didn't get a notice for #16". | alice pane | Show the member's own `via=human` posts in their tail, as quiet one-liners. | `bin/sub-human` `visibleTo` |
| E5 | **Prompt suggestions offer ready-made `@room …` lines.** Accepting one posts model-written words as the human's. | alice input showed `@room #13 works for me` | Mark `@room` text that came from an accepted suggestion, if that's detectable. Otherwise warn in the README and `member.md`. | `at-room.js`, README |
| E6 | **Waiting on humans is the bottleneck, and nothing alerts them.** Two waits of about 4 min. | timeline | Make the gate's "waiting on X" a direct alert to that person: a terminal bell or a push notification from their tail when `to==me` or when their sign-off is required. | `bin/sub-human tail`, monitor |
| E7 | **Orchestrator posts are long.** Average 456 chars, longest 1,381; humans skim. | counts | Add a style rule: at most 3 sentences per post, and put details in the plan rather than in chat. | `orchestrator.md` |
| E8 | **The orchestrator leans on options.** "I lean A" (#9) before hearing anyone. | #9 | Present options neutrally, and give a recommendation only after the positions are in. | `orchestrator.md` |
| E9 | **Member Claudes never posted.** The "Claude decides what to share" path wasn't exercised; humans used `@room` for everything. | 0 agent posts | Give member Claudes a clear job, e.g. after an assignment, post a one-line status or finding from the code. Or accept that `@room` is the main interface and make the agent path opt-in. | `member.md` |
| E10 | **Joining has friction.** `/sub-human` needs two Enters, shows as `/sub-human:sub-human`, and needs `--plugin-dir` (plus `SUB_HUMAN_HOME` in tests). The first join attempt failed with "Unknown command". | user report | Install once with `claude plugin install … --scope user`. Mention the two Enters in the systemMessage and README. | README |
| E11 | **The review opens by itself, about 8 s after publish.** That interrupts a member who is mid-task (verifier F3). | alice/bob panes | Open it only if the session is idle. Otherwise post a one-line "plan ready, say 'review' when ready". | `member.md` |

## Suggested next round

1. **E1, E2, E6.** These decide whether the approval step feels right to real people.
2. **E3, E4.** Cheap fixes for confusing messages.
3. **E7, E8, E11.** Changes to the role prompts.
4. **E9.** A design decision on what member Claudes are for.
