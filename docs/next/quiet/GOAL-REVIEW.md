# PLAN-QUIET against the owner's goal

Status: review, 2026-11-02, of `docs/next/PLAN-QUIET.md` on branch `quiet-plan`. Paths are relative to `plugin/sub-human/` unless they start with `docs/`. Evidence comes from the plan, `docs/next/quiet/*`, README, ARCHITECTURE, ROOM-PLAN, the open issues (#8, #9, #12, #15, #20, #21, #34, #35) and the 0.5.8 source.

**The goal:** people join a room and use Claude exactly as they do in Claude Code. The one difference is that someone else is in the room. Two people should be more than the sum of their parts, and neither should hold the other back. They pick where they sit on a spectrum, from pairing on one plan to coworkers keeping their changes in sync. The work doesn't have to be code.

## Verdict

PLAN-QUIET is a good *quieting* plan, and a narrow *goal* plan. Its evidence is careful (a line ledger with the source of every line, live probes of every surface), and Phases 1 and 4 would make sub-human feel much more native for the workflow it was tested on: plan, then sign-off, then split, then build. That's the middle of the owner's spectrum, and the plan polishes it further rather than reaching either end. The close end (watching and steering together) and the loose end (who's touching what, staying in sync) get nothing new. The largest phase, Phase 2, puts more weight on the plan-sign-off ceremony. The biggest native-parity problems are softened, not removed: other people's events still start model turns in your session, a review still drives your Claude into plan mode, and the guard still taxes every shell command. The plan's own research proposed stronger moves for two of these: REVIEW.md's band and pane in place of plan mode, and PRESENCE.md's footer in place of rows. The owner's decisions D1 and D3 overrode both, and I think those two decisions work against the goal. Ship 0.6.0 as planned. Before 0.7.0, add a "no turn you didn't ask for" rule, workflow-neutral test scenes, and sync awareness, and spend the early-access budget on removing interruptions rather than on a chat row.

## Scores (1–5)

| Dimension | 0.5.8 | After the plan | Evidence |
|---|---|---|---|
| **Native parity** (solo use unchanged once you're in a room) | 2 | 3 | Phase 1 deletes receipts, hints and red errors, and makes busy-turn wakes context-only. What's left: wakes still start model turns (`lib/room/deliver.ts` wake rules; `mod/deliver.ts:316` `midTurnWake` appends into your *running* turn), reviews still go through EnterPlanMode/ExitPlanMode, #34 is fixed only if spike 1 passes (the plan names no fallback), the guard runs on every Bash/Read/Grep/Glob call even outside a room (`mod/guard.ts`, registered unconditionally), and the room row is a background agent, so `/exit` asks "Exit and stop tasks" (README "Leaving") and a `TurnDuration` rewrite can't tell a real `Baked for 12s` from `Waiting for N agents` (PRESENCE L8). |
| **Close end** (pairing on one plan or task) | 2 | 2 | Shared plan with versions and compare-and-swap, plus Claude-to-Claude `SendMessage`. Missing: any live view of the other person's Claude, steering it, handing over, or seeing their diff. Phase 3's "how's it going" draws on presence, which holds only `working/idle/permission/error` (`hooks/handlers/presence.ts`). The mock's "last edit 2m ago" isn't tracked anywhere. |
| **Loose end** (coworkers keeping changes in sync) | 1 | 1 | No file, branch or commit awareness anywhere (`grep` finds no edit tracking in `lib/`, `mod/` or `hooks/`). Sync happens only when a Claude decides to `SendMessage` "pushed 8b2aab4" (EVALUATION D41). Nothing warns two Claudes editing the same file, or two people sharing one checkout (the demo avoids this with separate clones). |
| **Not held back** | 2 | 3 | Better: busy-turn wakes become context, the guard's false positives narrow (#35), one row instead of 1+N (about 7k tokens per spawn). Still there: a partner's `@you`, a review request, an assigned task, or a new version of a plan you objected to each wakes your Claude, mid-turn included. An unanswered objection card blocks your Claude's room posts (README, the review table). The idle review opens a plan view "at the next turn", so your next turn belongs to someone else. The host sleeping takes the room down for everyone. |
| **Greater than the sum** | 2 | 3 | Real leverage exists: native `SendMessage`, plan compare-and-swap merging, `read` brief catch-up, assigned tasks. Phase 3's "ask the row how dev is doing" is the most goal-aligned item in the plan, but it either answers thinly from presence or forwards to dev's Claude by `SendMessage`, which interrupts dev. Nothing makes the Claudes coordinate by default: a finished task notifying the sibling owner is EVALUATION rank 15, and the plan leaves it out. |
| **Non-coding work** | 2 | 2 | The review frame is "Ready to code? … ready to execute". Done needs evidence ("12/12 pass"). Presence says "building". Every scene, mock and canonical line is an HTTP handler. A writing room has no shared document except a "plan" that changes only as whole-text versions through plan mode. A research room has no shared notes beyond chat. |

## 1. Native parity: what the plugin still does to you

| Still injected, blocked, rewritten or slowed | Today | The plan | Status |
|---|---|---|---|
| Wakes that cost a model turn (to=me/@me, a review request, a task assigned to you, an objection to your plan, a revision you asked about) | prompt "from the sub-human plugin"; mid-turn **appended into the running turn** | busy-turn resubmit becomes context-only (P1); the review band shows mid-turn (P2) | **reduced, not removed.** Mid-turn appends and idle wakes stay. |
| Review drives your Claude into plan mode | EnterPlanMode → ExitPlanMode, several model turns | kept (D3) | **left** |
| Permission mode drop after asking for changes (#34) | auto → default | spike 1; "a hook can't set the mode itself" | **depends on a spike with no fallback** |
| Your plan file overwritten for a review (backup and restore) | yes | each plan gets its own file | fixed |
| Per-prompt context (`room since your last turn (FYI):`), plus a ~1.3k-char member block on join, resume and compaction | yes | made shorter; the echoes are dropped | **left** (could be static `prompt.context`; SURFACES §2 marks it unused) |
| Guard on every Bash/Read/Grep/Glob/Write, in a room or not | false positives on `mktemp -d`, `/tmp` heredocs, tool-result files | P4 narrows the matching | **reduced**; still active when you're in no room |
| MCP permission prompts for `post`/`plan`/`task` | tool descriptions shown to the person | person-readable text, `readOnlyHint` on `read` | prompts stay (native, acceptable) |
| Session title rewritten to `NAME.CODE` | `/rename` echo | silent `sessionTitle` | quieter, but it still overwrites a title the person chose |
| Background-agent chrome (`Waiting for N…`, `/exit` question, `· 1 shell`, `← for agents`) | 1+N rows | one row; TurnDuration redrawn | **left**, and the redraw can't tell native durations from agent waits |
| Bypass mode holds peer messages behind a dialog | warning line | warning deleted | **left** (now silent) |
| Focus-stealing | plan dialog at next turn, admission card, leave card | band `1: Open`; leave card once per install | a digit typed in an empty composer opens the review (REVIEW risk) |
| `@` opens the file picker before `@room` | yes (README) | not addressed | left |

## 2. The spectrum

The scene the plan is tuned on (EVALUATION) is plan, sign-off, objection, v2, tasks, build: the middle of the spectrum. The plan's line-budget ratchet (P0) and verification run (P5) both replay that same scene, so every future change is measured against one workflow. Phase 2 is the biggest phase, and it is entirely about sign-off. That clashes with the design rule "Unprescriptive: planning is optional, there is no required workflow."

**Close end: what a pair needs and doesn't get**
- **A live view of the other person's Claude.** Today you can't watch maya's turn: her tool calls, her diffs, her plan file as it changes. The agent view shows background agents on your own machine only.
- **Steering one Claude together.** Each Claude takes only its own person's typed input, and `SendMessage` is Claude to Claude (README). A partner can't suggest a prompt to your Claude for you to accept.
- **Handing over.** No "take it from here" that moves context: the task, the plan, the last N turns' summary.
- **Seeing a diff as it happens.** The only cross-session signal for an edit is a Claude choosing to post one.
- **Co-editing.** Room plans are whole-text versions with compare-and-swap. Two people shaping one text live means a v1→v2→v3 round trip with a dialog per version.

**Loose end: what coworkers need and don't get**
- **Who's touching what.** Edit/Write paths and the git branch per member are never recorded. The `PostToolUse` hook only matches `AskUserQuestion|EnterPlanMode|ExitPlanMode` (`mod/register.ts:49`).
- **Conflict warning.** Nothing warns two people (or one shared checkout) editing the same file.
- **Push/pull nudges.** No "maya pushed 2 commits to main, you're behind" signal, and no context that tells your Claude to pull before touching `src/store.js`.
- **Staying out of the way.** Tasks hold owners, but nothing connects tasks to files.

## 3. Greater than the sum, and not held back

**Where one person slows the other (after the plan):**
1. Mid-turn wakes from someone else's `@you` or request land inside your Claude's current task.
2. A review request makes your next turn a plan-mode excursion.
3. An unanswered "Send/Discard" card refuses your Claude's room posts.
4. Forwarding "how's it going" to a teammate's Claude interrupts the teammate.
5. A sleeping host stops the room for everyone (no failover, by design).
6. Guard denies, even when narrowed, send Claude on detours (EVALUATION D40: "I won't try to work around it").

**Where the plan creates leverage:** Claude-to-Claude hand-off kept native (D41 is "the best hand-off in the run"), tasks that are actually assigned (G7), and the room row's status answers. What would add real leverage is the Claudes coordinating without being asked: a finished task notifying the sibling owner's Claude, a teammate's agreed decisions landing as context, overlap detected before it costs a merge.

## 4. Non-coding work

Code-centric assumptions that would trip a writing, research or ops room:
- The plan view frame "Ready to code? … ready to execute". Spike 2 may not be able to redraw it, so the plan relies on a heading inside the plan text.
- "Agreeing is not a go-ahead to build" and presence words `building`, `◼ http: GET /tasks`.
- Task completion needs "evidence" (`lib/tasks.ts` gate; README "12/12 pass").
- Every canonical line, mock and scene is an API change. The budget test would pass a room that only works for code.
- The only shared artifact is a "plan". A writing room needs a shared document both Claudes edit. A research room needs shared notes or sources. An ops room needs a shared incident timeline or command log.
- The guard's rules (`grep -r`, `find`, `tar` above the store) hit ops and research shell work harder than coding.

## 5. Direction, phase by phase

| Phase | Direction | Why |
|---|---|---|
| **0** foundations | Sideways, needed | The debug log and tier helpers support native parity. The line-budget ratchet is replayed on one plan-first scene, so it locks that workflow in unless more scenes are added. |
| **1** quiet pass | **Toward** | The biggest native-parity gain per unit of work: no receipts, no red errors, no echoes, context-only resubmits. It is polish of the existing flow, though, not new reach. |
| **2** plan mode made right | **Sideways to away** | It improves a ceremony only one workflow uses, keeps model turns and plan mode in the reviewer's session, and fixes #34 only if a spike passes. REVIEW.md's band and pane removes all of that and was verified live (probes 1–5). |
| **3a** quiet rows (one row) | Toward | Fewer tokens, no stale labels, no `row closed`. |
| **3b** room you enter (chat, DMs) | Mostly sideways | It is a second chat surface that only works in the terminal, built on three stacked early-access mechanisms plus a provenance problem. DMs add a human lane but don't add teamwork. "How's it going" is the one goal-aligned piece, and it is thin without activity data. |
| **4** guard | **Toward** | It removes blocks. It could go further: a guard that's quiet when no room is open, and denies that name the alternative. |
| **5** verify like a person | Sideways | It measures quiet, not teamwork, and only on the middle of the spectrum. |

## Top 5 gaps, ranked

**1. No "zero unasked turns" guarantee.** *Size: medium. Fits: rule in 0.6.0, mechanism in 0.7.0 in place of Phase 2's plan-mode work.*
The rule: nothing another person does starts or extends a model turn in your session, or changes your mode, unless you asked. Every wake becomes held context plus a band. The one exception is a direct `@you` from a person, and even that waits until your turn ends (no `midTurnWake` append). Reviews move to REVIEW.md's candidate (e), band then pane, with plan mode kept only for *authoring*. The plan view stays as the fallback behind the `review-pane` gate. This closes #34 and #21 at the source and deletes about 600 lines (REVIEW "Net size"). Add it to P5's pass criteria: "0 model turns started by another person's action".

**2. No sync awareness for the loose end.** *Size: medium. Fits: 0.7.0, beside presence.*
Record per member: the files their Claude edited (a module `PostToolUse` on Edit/Write/MultiEdit/NotebookEdit, paths relative to the repo root), the git branch, and ahead/behind against upstream (cheap, at turn end). Publish them in the presence document, which already never wakes anyone. Then:
- A one-line person notice and a Claude context line when your Claude is about to edit a file a teammate touched in the last N minutes: `maya's Claude edited src/store.js 3m ago`.
- A footer phrase `maya pushed 2 · you're behind`.
- A refusal, or at least a warning, when two seats share one working directory.

This also feeds "how's it going" with real data.

**3. No close-end pairing primitives.** *Size: large. Fits: 0.8.0, replacing DMs as the headline of the "room you enter".*
Three steps, smallest first:
- (a) **Follow**: entering a person in the room row streams their Claude's tool calls and diffs, read-only. It's drawn from their transcript over the existing lanes, and they consent once per room.
- (b) **Suggest**: type into their entry to send a prompt *suggestion*. It lands in their band as `dev suggests: "…" 1: Run 2: Edit`, and only their keypress submits it. That keeps "only your person types" intact.
- (c) **Hand over**: package a task, the plan reference and a turn summary into the other person's context with one command.

(a) gives pairs the shared view. (b) gives them two people steering one Claude without breaking consent.

**4. Workflow-neutral evaluation.** *Size: small. Fits: 0.6.0, Phase 0 and Phase 5.*
Add three recorded scenes to the line-budget ratchet and to P5:
- a pair working one task with **no plan**;
- two coworkers on separate tasks who **edit the same file**;
- a **writing** room (two people and their Claudes drafting one doc).

Pass criteria per scene: person lines, unasked turns (gap 1), mode changes, and time-to-awareness (how long until each person knows what the other changed). Without these, every release optimises the plan-then-build path.

**5. Code-centric words and artifacts.** *Size: small to medium. Fits: words in 0.6.0 (Phase 1's vocabulary pass), artifact in 0.8.0.*
- Words: "building" becomes "working on"; task evidence is free text ("what shows it's done"), not test output.
- The "Ready to code?" title goes away for free with gap 1's pane.
- Later: let a room plan be any shared document (a draft, notes, a runbook) with the same versions and compare-and-swap. The machinery already supports it. Only the naming ("plan") and the plan-mode-only edit path say otherwise. Allow editing it outside plan mode too.

## Decisions I'd push back on

- **D3: review stays in plan mode. Push back hardest.** The stated reason (formatted and scrollable) is met by the pane: Markdown rendering, PgUp/PgDn, tables boxed (REVIEW probe 1). Plan mode keeps model turns in the reviewer's session, keeps the mode risk (#34 depends on a spike with no fallback), keeps the "Ready to code?" title (the notice isn't drawn: REVIEW probe 9), and puts sign-off at the centre of the product. "It never feels like someone else's plan" is achievable in the pane: title it `Room plan · paging v2`. Suggested compromise: the pane is primary, the plan view is the gated fallback, and authoring stays in plan mode.
- **D1: one room row you enter.** Fine as a destination, wrong as the home of presence and chat:
  - Presence should be ambient in the SessionMode footer (PRESENCE L2: dim, no settings, every surface with a footer), so nobody has to enter anything to know dev is working.
  - The row's background-agent nature brings the `/exit` question and the TurnDuration redraw that hides real durations.
  - If the keeper dies, main wakes.
  - Typing into the row works only in the terminal.

  Keep the row, but ship presence in the footer first, and make the row's typed input a 0.8.0 extra rather than the plan's centrepiece.
- **D4: build on early-access surfaces.** Sound in principle: the native look can only come from there, and the contract, canary and gates are good discipline. But point the budget at the surfaces that *remove* interruptions (band, pane, SessionMode, `ui.render` hides) before the ones that *add* a chat lane (`turn.step` synthesis, `session.append` composer, the keeper trick).
- **Provenance.** Synthesized `turn.step` replies are recorded as `origin: model`. For a product whose core promise is "a model can't speak as a person, and every line says who wrote it", a transcript that credits the model with words no model wrote cuts against that promise, and a directory reviewer may say so. Even the roster is drawn through a synthesized step (ROOM-ROW-SPIKE Q2: `$.session.append` isn't drawn), so the whole row depends on this. Don't ship typed chat in the row until there is a ruling or a plugin-origin step, and keep ambient presence on surfaces that need neither (the SessionMode footer). File the request now.
- **The leave card's star.** Minor. EVALUATION's own fix was "never modal at leave; after a session's 3rd room". Once per install with a two-dismissal limit is tolerable, but it's still a modal at the moment of leaving, which goes against principle C. Move it to the third leave, or to `/sub-human help`.
- **`@room` alongside the row.** Agree: it's the only path on desktop, VS Code and Remote Control, and it posts from main. Also fix the `@` file picker friction, or document a shorter tag.

## Risks to the direction

- **Stacking early-access surfaces.** The row alone needs `turn.step` without `next`, the `session.append` composer door, the keeper's "no notification while a child lives", `subagentStatusLine` from plugin settings (with `${CLAUDE_PLUGIN_ROOT}` unexpanded), and `ui.render` scoping. Any one of them changing breaks it, and the fallback is today's `@room`. Acceptable only because `@room` stays.
- **Spike-dependent fixes with no fallback.** #34 (spike 1) and the dialog title (spike 2). If spike 1 fails, the plan has no answer except a Claude Code request. The pane removes the dependency.
- **The metric shapes the product.** A single-scene line-budget ratchet can only reward quieter versions of one workflow (gap 4).
- **Host-only rooms.** "When the host sleeps, the room is down for everyone" holds back the loose end most, since coworkers work asynchronously. It's out of this plan's scope, but it belongs on the roadmap the goal implies.

## Owner's note on gap 2 (2026-11-02)

In practice, the loose end already works through Claude-to-Claude coordination. Here is the case the owner described:
- one feature spans two modules, where one calls the other;
- each person's Claude owns one layer;
- when the owner pivoted one layer, the other Claude updated its side on its own.

Sync happens at the level of intent and contract, not by tracking files. So gap 2 shrinks from "build sync awareness" to making that propagation reliable. It must always arrive, even when the other person is idle or mid-turn.

**The plugin adds no line of its own.** The receiving Claude decides whether to tell its person or quietly adjust, the same as with anything else it learns while working. That is the native behavior, and it fits "handle it behind the scenes".

That also changes gap 1. The propagation the owner values *is* a teammate's action starting a turn in your session. The rule becomes:
- **Claude-to-Claude coordination may wake your Claude.** That's the leverage.
- **Ceremony may not.** Review dialogs, mode changes and receipts never start a turn in your session or change your mode.
- **Where a person sits on the spectrum decides how much auto-follow they get.** Close pairs let the other Claude's changes flow in. Loose coworkers get a one-line notice and choose when to follow.
