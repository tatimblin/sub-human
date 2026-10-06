# Phase 3: room-caused wakes

## Learning run badger-3918: 27 wakes (orch 9, alice 9, bob 9)

The room directory was gone (a later run reused `$SUB_HUMAN_HOME`), but the transcripts were still on disk: the
orch is `026b95e5` (in the alice folder, `agentSetting sub-human:orchestrator`), alice is `5a14e507` (and
`2da63803` after `/clear`, 0 wakes) and bob is `00e1d780`. Each wake is a room trigger (a Monitor event, a peer
delivery or row-rewake) that started a model turn, counted the way `scripts/metrics.js` counts them.

| # | orch | alice | bob |
|---|---|---|---|
| 1 | bob `member_joined` + row note (spawn bob's participant row) | bob's human `say` "sure, I'll take the parser tests" | alice's human `say` "bob, can you take the parser tests?" |
| 2 | bob `@orch let's plan` | **peer**: bob's Claude asks about createTask | orch `question to=bob` (a post) |
| 3 | alice `@orch default 20 …` (bob's `@orch fine …` landed in the same turn) | bob's human `say` **`@orch` let's plan** | alice's human `say` **`@orch` default 20 …** |
| 4 | bob's objection on 54be84 | **peer**: the orch asks alice | proposal 54be84: card |
| 5 | **alice's signoff** on 181c28 (bob still pending) | bob's human `say` **`@orch` fine …** | **decision 54be84 "objected"** (bob's own answer completed it) |
| 6 | decision 181c28 (4 s after #5) | proposal 54be84: card | proposal 181c28: card |
| 7 | task_req add | **decision 54be84 "objected"** (3 s before the revision's card) | **decision 181c28** (bob's own signoff completed it) |
| 8 | task_req done | proposal 181c28: card | row-rewake after `--continue` |
| 9 | "room closed: complete task 1" | decision 181c28 agreed | alice's human `say` "are you back?" |

By cause:

| Cause | Wakes | Needed? |
|---|---|---|
| Others' human `say` | 8 | 5 yes; **3 were `@orch`-only lines** woken in the other member (alice #3, #5; bob #3) |
| Proposal (card opens) | 4 | yes |
| Decision | 5 | 2 yes (the orch's, alice's agreed one); **3 avoidable**: 2 "objected" decisions for non-proposers (a revision brings its own card), 1 to the member whose own answer completed it (the card's PostToolUse reply already says "decision #N: …") |
| Card answers to the proposer | 2 | the objection, yes (the orch revises); **the signoff, no** (the decision carries it) |
| Peer SendMessage | 2 | yes (S3, and the orch asking) |
| orch post `to=bob` | 1 | yes (it asked) |
| task_req apply | 2 | yes (one turn per request; each was its own burst) |
| Join row spawn (orch) | 1 | yes: the orch's participant row needs an Agent call |
| row-rewake | 1 | yes |
| Room closed (reap) | 1 | yes |

Card open and close themselves cost nothing extra in the log: the card's answer is the PostToolUse turn the card was
already in. No `task` mirror entry woke anyone.

## Changes (cheap, invariant-keeping)

All in `lib/room.js` `lane()` plus one settle default in `bin/sub-human tail`; pull-lane entries still reach the
member's next-prompt digest, so nothing is hidden, only not pushed.

1. **`@`-addressed human words.** A human `say` whose text `@`-mentions a room member or `@orch`, but not me, is
   pull for me (it already was for the orch: it hears only `to=orch`/`@orch`). Plain-name lines ("bob, can you …")
   and `@me` lines still push. Saves the 3 `@orch` wakes.
2. **Card answers.** A signoff is pull for everyone (the decision carries it). An objection is push only to the
   proposal's author (to revise), pull for other approvers. Saves the orch's mid-round signoff wake, and stops one
   approver's answer from waking the other.
3. **Quiet decisions.** A decision is pull for the member whose answer completed it (consent.js already put
   "decision #N: agreed/objected …" in that card's reply), and an `objected:` decision is pull for everyone but the
   proposer. An agreed decision still pushes to every other member in the proposal and to the orch. Saves 3.
4. **Orch settle window.** The headless orch settles 3 s of quiet / 10 s max (members keep 1.5 s / 5 s;
   `SUB_HUMAN_ORCH_SETTLE_MS` / `_MAX_MS` override). Two `@orch` answers or a task request burst a few seconds apart
   become one orch turn. Nobody watches the orch's latency.

Not done: the orch's join row-spawn wake (its participant row needs its own Agent call; there's nothing to coalesce
it with in the script), and the per-request task_req wakes (each S6 request is a separate human step; the
settle window already batches a burst).

Estimate on badger-3918: 27 → 20 (orch 8, alice 6, bob 6). The ≤ 12 target is out of reach for this script
without dropping a wake the scenes test: 4 cards, 2 S3 peer messages, 2 S3/S8 `@room` lines to bob, the
rewake, 2 orch questions, the orch's plan, objection and decision wakes, 3 task requests and the reap.

Tests: `test/lane.test.js` (a new P3 table: `@`-addressing, answers, quiet decisions, a member proposer),
`test/cli.test.js` (orch tail pushes the objection, not a signoff; the orch's longer default settle batches two
`@orch` lines 2 s apart).

Also changed while getting the clean run (not wake reductions):

- `lib/room.js` stateLine: "you: answer needed (call AskUserQuestion with "proposal HASH")". Haiku skipped the card
  when the call was only in the join text (run narwhal-3266).
- `hooks/consent.js` Pre: a question with no hash is still carded when it says "propos…", exactly one proposal is
  pending for that member and the input names no other id (run raven-3365: Haiku asked "Do you agree with the
  cursor paging proposal?" with no hash). Test in `test/hooks/consent.test.js`.
- `mcp/hold.js`: progress text clipped to 140 chars (was 200) so the read-only hint fits the two lines a row view
  shows at 120 columns (S7 in stoat-3644: the hint was cut off).
- `skills/sub-human/SKILL.md`: the first action is the ROWS Agent call (lynx-5140: Haiku replied and skipped it).
- Harness (`scripts/demo.sh`): S6 is add, then claim by id (add leaves the task pending with no owner), every
  task prompt names `mcp__plugin_sub-human_room__task` and says "only that tool call" (Haiku used `post`, or went on
  to edit server.js); bob's non-owner done now reaches the tool; `submit` Escs a seat's own non-card question
  before typing (ocelot-0728: the scripted line answered bob's Claude's question); a card that doesn't open in
  120 s gets one "show me the consent card" nudge, logged in waits.jsonl.
- `scripts/checks.js`: S7 checks what is true (below); the S6 non-owner check says SYNTHETIC when the orch never
  tried the completing TaskUpdate; the cost is bounded to the run's window.

## The clean run: stoat-3644

Seven full runs; stoat-3644 (run 5) is the one uninterrupted S1–S10 run with every check from one room: 58 of 63
pass, ≈ $1.48. Runs 6 (raven-3365: Haiku's card without the hash) and 7 (zebra-0255: the orch waited on a reply
from bob's Claude and never revised; bob's Claude never messaged alice's in S3) failed on model behaviour, after
the fixes above.

| Scene | Result |
|---|---|
| S1–S5, S8–S10 | all pass |
| S6 | 7/8. Fails "alice's room row shows the task summary": alice's Claude went on to edit server.js, and the permission prompt covered the panel (fixed in the prompt since). bob's done reached the `task` tool (task_req #26) and the orch declined it itself; the gate check is the synthetic one and is labelled SYNTHETIC |
| S7 | 2/3. Hint missing: the row's progress line was a long "#30 facilitator → alice …" note and the hint at its end was cut off (hold.js clip fixed since). Changed check: the "x" never reached the row's model (its hold did not return before the run ended), so no reply and nothing posted; that passes as "reply at the next hold return, or none" |
| Metrics | wakes 28 > 12; noise 3.04/capture (1.22 excluding "Waiting for"); 26 red lines, all the diff of alice's unwanted edit in S6 |

Wakes in stoat-3644, 28 (orch 11, alice 8, bob 9), by cause:

| Cause | orch | alice | bob |
|---|---|---|---|
| join row spawn | 1 | | |
| human `say` (`@orch` / plain names) | 2 (bob's plan; alice's and bob's `@orch` answers 3 s apart: **one** turn) | 1 | 2 |
| peer SendMessage | 1 (alice's Claude) | 3 (bob's Claude, orch ×2) | 1 (alice's Claude) |
| orch post `to=` | | 1 (S6 "doesn't match yet") | 3 (2 questions, 1 S6 refusal) |
| card opens | | 2 | 2 |
| objection + decision | 1 (one batch) | | |
| decision agreed | 1 | 1 | **0** (bob completed it) |
| task_req | 4 (add, claim, bob's done, alice's done) | | |
| row-rewake | | | 1 |
| reap | 1 | | |

The new rules did what they should: no member was woken by an `@orch` line (3 such lines), by another approver's
answer, by an objected decision or by a decision their own answer completed; the orch was not woken by a signoff;
its two `@orch` answers and the objection + decision each landed as one turn. The count went up from badger-3918
because S6 now has 4 requests (2 there) and the orch messaged the members 6 times (2 there). What is left is the
scenes themselves plus the orch's own choice to ask and report. ≤ 12 would need the orch to ask less (its text,
not the plumbing) and S6 to send fewer requests.

| Metric | vole-8126 | otter-0813 (Phase 0) | stoat-3644 |
|---|---|---|---|
| wakes (orch / alice / bob) | 39 (12 / 17 / 10) | 23 (8 / 8 / 7) | 28 (11 / 8 / 9) |
| member join chars (alice / bob) | 5,732 / 5,768 | 4,968 / 4,994 | 1,096 / 1,090 |
| injected chars, all seats | 34,311 | 33,090 | 13,703 |
| noise lines / capture | 4.64 | 3.61 | 3.04 (1.22 ex "Waiting for") |
