# Plan collaboration

Status: design, 2026-10-08. Not built. Sources:
- the decisions the user reached in conversation (recorded under Decisions, verbatim in substance);
- the code on `master` as of `2d425b6` (`lib/proposal.js`, `lib/room/consent.js`, `lib/room/lanes.js`, `lib/room/render.js`, `lib/rows.js`, `lib/tasks.js`, `mcp/room-server.js` `propose`, `mcp/task.js`, `hooks/consent.js`, `agents/orchestrator.md`, `skills/sub-human/{member,facilitate}.md`);
- `feature/remote-rooms` `7065803` and `ea26ae6`: the hook picks the proposal from the person's words (`proposal.choose` / `picked`, `members/NAME/pick`) and always shows that proposal's text in the native plan view; Remote Control "Suggest edits" (deny with a note) records an objection with the note, a bare deny records nothing; only a hook-opened review records. `answer` (any machine) and `decide` (host only) replace `record` there. This note targets the code after that branch merges.

Goal: people shape one plan together, from any session, terminal or phone, without anyone writing a second plan for the same thing, and with agreement still meaning exactly one thing: every named person approved that exact text in their own dialog.

## Goals and non-goals

Goals:
- **Revise, don't restart.** A plan has versions. A revision supersedes the version before it, goes to everyone again and shows what changed.
- **Three ways in, one way out.** An approver's "Suggest edits", an approver's own Claude, or `@orch revise: …` all end as a new version sent to everyone.
- **One plan per topic.** Planning is visible and claimable before anyone writes, through the room's task list. Overlap is caught before it costs two plans, and merged when it was not.
- **Phone first-class.** Everything a person does on a plan (read it all, see what changed, Approve, Suggest edits) works in the native plan view over Remote Control.
- **Room lines that read.** Every outcome names the plan: `Ship v3 Monday: agreed (alice, bob)`.

Non-goals:
- Live co-editing of one text. Versions are whole texts; a Claude drafts each one.
- Gating who may draft. Any Claude, subagent or the orch may write a version. Safety comes from consent alone.
- One open proposal per room. Unrelated plans run in parallel.
- Detecting overlap by text similarity in code. Overlap is a judgment a Claude or the orch makes, with the data put in front of it at the right moment.
- Honouring two agreed plans that conflict. Neither the plugin nor the orch picks a winner; the orch flags it and people decide.

## Decisions

| # | Decision | Rejected |
|---|---|---|
| D1 | Phone / Remote Control is first-class: the native plan view on the phone shows the full plan, "Approve" and "Suggest edits". | A phone-only card or web view. |
| D2 | Who edits doesn't matter. A plan proceeds only when every named person approved that exact text in their own dialog. | Restricting revisions to the proposer. |
| D3 | A revision is a new version that supersedes the old one. The old one closes as **changes requested**, not objected. | Reusing "objected" for "please change it". |
| D4 | Every version goes to the earlier approvers **plus the proposer**. Nobody's earlier agreement carries over, the proposer's included. The revision's author approves it in their own dialog too (a Claude drafts; a Claude never consents). | Carrying the proposer's or author's agreement forward. |
| D5 | Three starts: (a) an approver's "Suggest edits" note reaches the proposer as "changes requested: …", the proposer's Claude drafts, the proposer decides whether to send; (b) an approver's own Claude edits and resends; (c) `@orch revise: …`, the orch drafts. All end as a new version to everyone, showing what changed. | |
| D6 | Concurrent revisions: the newest supersedes; answers to an older version are recorded but don't count. Revisions are rate-limited per person. The proposer can withdraw, which closes every open version. | Refusing a stale revision. |
| D7 | Planning starts as a claimed task `plan: <topic>`. Every Claude checks open `plan:` tasks before planning; on overlap it offers its person "bob is already planning this — send your input to them instead?" (an addressed post). The orch sees all tasks and proposals, flags overlaps that remain and merges on `@orch merge`. If two overlapping plans both get agreed, the orch flags it. | One open proposal per room; relying on a Claude to notice overlap at proposal time and then honouring two agreed conflicting plans. |
| D8 | Subagents: "spawn two subagents to plan A and B" makes two plan tasks; if they turn out to be the same, the spawning session merges before proposing. Across people, the task check and the orch catch it. | |
| D9 | Outcome lines name the proposal. Role texts say "in their session", not "terminal", and use names or they/them. | |

## The rules

1. **A plan is a thread of versions.** Version 1 is an ordinary proposal. Each later version names the one it supersedes. At most one version per thread is open at a time: the head.
2. **Agreement is per version.** A signoff counts only for the hash it names. The fold never moves an answer from one hash to another.
3. **Every version asks everyone.** Approvers of a version ⊇ the approvers of the version it supersedes ∪ the thread's proposer ∪ the version's author (when a person). A revision can add people, never drop them.
4. **Superseding closes, never decides for anyone.** An open version that a newer one supersedes closes `changes_requested`. Its answers stay in the log and count for nothing.
5. **Agreed plans stay in force until replaced by agreement.** A revision of an agreed version (an amendment) opens a new version; the agreed one stays the decision until the new one is itself agreed. A withdrawn or changes-requested amendment leaves it in force.
6. **An objection asks for changes.** "Tell Claude what to change", phone "Suggest edits" and the card's Object + note all record today's `objection` (via=human, note byte-exact). It blocks that version and reaches the proposer as "changes requested". A version whose answers are complete with any objection closes `changes_requested`.
7. **Withdraw closes, never agrees.** Only the thread's proposer (their Claude) withdraws. It closes the open head; an agreed version in force is not undone.
8. **Plan tasks coordinate; they never decide.** Holding `plan: X` gives no say over X's outcome and blocks nobody from proposing.
9. **Overlap is offered, not enforced.** A Claude that finds an overlapping plan task asks its person; the person chooses. The orch flags and merges only when asked (`@orch merge`), apart from the single overlap flag of D7.

## Log and entry model

### Fields

All new fields are optional; a proposal without them is version 1 of its own thread (every existing log reads unchanged).

| Entry | New field | Meaning | Written by |
|---|---|---|---|
| `proposal` | `thread` | hash of version 1 (absent on version 1 itself) | `proposal.create` |
| `proposal` | `version` | 1, 2, … within the thread, assigned under the proposal lock | `proposal.create` |
| `proposal` | `supersedes` | the head this version replaced (same thread) | `proposal.create` |
| `proposal` | `replaces` | heads of *other* threads a merge closes (`@orch merge`) | `proposal.create` |
| `proposal` | `base` | the version the author drafted from, when it is not `supersedes` (a concurrent revision) | `proposal.create` |
| `proposal` | `asked_by` | the person whose request made the orch draft (`@orch revise`, `@orch merge`) | orch's `propose` call, checked against the log |
| `proposal` | `plan_task` | the `plan:` task id this plan came from | `propose` |
| `withdraw` (new kind) | `proposal_hash`, `text?` | the proposer withdraws the thread whose head this is | `withdraw` tool, via=agent |
| `decision` | `outcome` | `agreed` \| `changes_requested` (legacy `objected:` text reads as `changes_requested`) | `proposal.decide` |

`lib/room/validate.js`: `thread`, `version`, `supersedes`, `replaces`, `base`, `asked_by`, `plan_task` on `proposal` only (hashes by `HASH_RE`, `replaces` ≤ 4); `withdraw` in `AGENT_KINDS` with `proposal_hash` required; `outcome` on `decision` only, system only.

Superseding, merging and withdrawing write **no** decision entry: the fold derives those closes from the `proposal` and `withdraw` entries. Only a completed answer matrix writes a `decision`, as today. This keeps `decide` host-only and simple on `feature/remote-rooms`, and every machine computes the same state from the same log.

### The fold (`lib/room/consent.js`)

`fold(entries)` stays the one interpretation. Additions:

```
F.threads   Map root -> {root, proposer, versions:[hash…] (log order), head, inForce (latest agreed hash|null), withdrawn}
F.status(hash).state   open | agreed | changes_requested | withdrawn | superseded_agreed
F.status(hash).by      the hash that closed it (supersede / merge), else null
F.pending(name)        heads only: undecided, not superseded, not withdrawn, naming name, unanswered
```

Link rules, checked in the fold (not only in `create`), so a hand-built entry can't bend them:
- `supersedes: h` counts only when `h` is in the same thread, earlier in the log, and the new approvers ⊇ approvers(h) ∪ proposer. Otherwise the entry is a standalone version 1 and supersedes nothing.
- `replaces: [h…]` counts per hash on the same approver rule, applied to each replaced head.
- Several versions superseding the same head: the latest in log order is the head; the earlier ones close `changes_requested` with `by` = the head.
- An answer on a hash that is not the head is kept in `F.answers` and never feeds a matrix that decides anything.
- `withdraw` counts only from the thread's proposer, or from the orch when the orch is the proposer.
- `inForce`: the latest agreed version. When a later version is agreed, the earlier agreed one reads `superseded_agreed`.

`test/hooks/consent-table.test.js` gains rows for every line above; the table still feeds every view.

### Writers (`lib/proposal.js`)

```
create(me, {text|path, approvers?, revises?, merges?, asked_by?, plan_task?})
  revises: h      -> thread = thread(h), version = max+1, supersedes = head(thread) (base = h when h is not the head)
  merges: [h1,h2] -> thread = thread(h1); supersedes = head(thread(h1)); replaces = [head(thread(h2))]
  approvers       := given ∪ approvers(superseded / replaced) ∪ proposer(s) ∪ me (a person) ∪ asked_by
  refuses: identical text to the head ("no change"), a closed thread, a withdrawn one, merging a thread into itself,
           over REVISE_MAX versions by me (or asked_by) in this thread within REVISE_WINDOW_MS
withdraw(me, hash, why?) -> appends `withdraw` when me is the thread's proposer and the head is open
answer(me, p, a)  -> records on any hash it is asked to (kept, idempotent); returns {counted:false} when p is not the head
decide(code, hash)-> outcome agreed | changes_requested; text "TITLE: agreed (alice, bob)" or
                     "TITLE: changes requested (bob)"; only for the head
changes(code, from, to) -> the change summary (below), from the stored blobs only
```

Config (`lib/config.js`): `REVISE_MAX: 3`, `REVISE_WINDOW_MS: 600_000`, `CHANGES_MAX_LINES: 12`.

### Plan tasks (`lib/tasks.js`, `mcp/task.js`)

- Convention: subject `plan: <topic>`, owner = the person whose Claude plans, claimed at add (`in_progress`). Detail: who it concerns.
- `task({op:'add', subject:'plan: …'})` replies with the other open `plan:` tasks, so the check happens in the call that claims: `queued; the orch applies it. Open plans: #4 plan: paging API (bob)`. Same in `sub-human tasks --json` (`plan: true`).
- `propose({…, plan_task})` links the plan. When the thread closes (agreed, withdrawn), the owner's Claude asks `done` with the decision as evidence; the gate accepts a `plan:` task's done whose evidence names its thread's closing entry.
- A subagent's `task` call resolves to its session's person (`process.ppid`), so two subagents make two tasks owned by one person.

### What changes where

| Area | Change |
|---|---|
| **Lanes** (`lanes.js`) | An objection pushes to the thread's proposer and to the version's author (orch included), not only `p.from`. A version pushes to every approver who has not answered it (today's rule, now heads only). A superseded head's pending review drops at flush time (judged against `readView`). The orch gets push for a `plan:` task_req (it applies it anyway) and for an `agreed` decision when another thread is open or in force (to flag D7 conflicts). |
| **Room lines** (`render.js`) | Every outcome names the plan and version when > 1. See the table below. |
| **Rows** (`rows.js`) | One line per thread, not per hash: `◐ Ship v3 Monday v3 1/3 · you: answer`; `✎ changes requested by bob` on the proposer's row; `plan: paging API` tasks show on their owner's row as today. |
| **stateLine** | Threads, heads only: `room now: Ship v3 Monday v3 waiting on carol · you: answer needed (…)`. |
| **Plan view** (`hooks/consent.js`) | The hook-opened review of a version > 1 shows a hook-composed header, then the plan (below). The pick (`proposal.choose`) maps words naming any version of a thread to its head; a pick of a closed version opens the head and the model is told "v2 was replaced by v3; showing v3". |
| **Orch** (`agents/orchestrator.md`) | Revise on `@orch revise: …`, merge on `@orch merge`, flag overlaps once (D7). |
| **Role texts** | "in their own terminal" → "in their session" (propose tool description, `facilitate.md`); names or they/them; one line each on revising, `plan:` tasks and withdraw. |

Room lines (people see; no ids):

| Event | Line |
|---|---|
| version 1 | `alice proposed Ship v3 Monday` |
| revision | `alice's Claude sent Ship v3 Monday v2 (changes requested by bob)` |
| `@orch revise` | `orch sent Ship v3 Monday v3 (asked by bob)` |
| merge | `orch sent Cursor paging v1, merging Paging API (bob) and Cursor paging (alice) (asked by alice)` |
| objection (to proposer) | `bob requested changes to Ship v3 Monday: "move it to Tuesday"` |
| objection (others) | `bob requested changes to Ship v3 Monday` |
| agreed | `Ship v3 Monday: agreed (alice, bob)` |
| complete with objection | `Ship v3 Monday: changes requested (bob)` |
| superseded open head | none: the new version's line says it |
| withdraw | `alice's Claude withdrew Ship v3 Monday` |
| stale answer | (to that person only) `your answer was to Ship v3 Monday v2; v3 replaced it and is next` |

### The plan view, terminal and phone

The shown text for version n > 1 is composed by the hook from stored blobs only:

```
│ Ship v3 Monday — version 3 of 3, from alice's Claude (asked by bob). Replaces v2: changes requested by bob.
│ Changed since v2 (computed by sub-human, not by a Claude):
│   - Ship Monday 9:00
│   + Ship Tuesday 9:00, after the migration dry run
│   (+1 more changed line: sub-human show <hash> --changes)
────────────────────────────────────────
<the version's text, byte for byte>
```

- The change summary is a line diff of `plans/<prev>.md` → `plans/<hash>.md`, at most `CHANGES_MAX_LINES`; the rest points to `sub-human show HASH --changes` (new read-only CLI command). Against the version the person last answered when they answered one, else the superseded head.
- A signoff needs the dialog's plan to equal exactly that composed text (today's "unedited" check, on the composed string). The record names only the version hash.
- The same text reaches the phone: Remote Control shows the plan view's plan in full. **Approve** → signoff. **Suggest edits** with a note → objection, note byte-exact → "changes requested" to the proposer. A bare deny or Esc records nothing ("closed without answering"). A plan view the hook did not open records nothing, even for the exact text.
- The card fallback shows the same header; past its 2,000-character preview bound, the summary plus the path, as today.

## Flows

**(a) Suggest edits → proposer revises**
```
bob (phone): plan view of Ship v3 Monday v1 ─ "Suggest edits": "move it to Tuesday"
  └► objection via=human {proposal_hash: v1, text}      ─► push alice (proposer): "bob requested changes to …: "…""
alice's Claude: drafts v2 in alice's session, shows alice the change          (nothing sent yet)
alice: "send it"  ─► propose({path, revises: v1})  ─► v2 {supersedes: v1, approvers: alice, bob, carol}
  v1 closes changes_requested (fold) ─► alice, bob, carol each review v2 in their own dialog (alice too)
```

**(b) An approver's own Claude edits**
```
carol: "change step 3 to use the queue and resend it"
carol's Claude ─► propose({path, revises: v2}) ─► v3 {from carol, supersedes: v2, approvers ∪ carol}
  v2 closes changes_requested ─► alice (proposer), bob, carol review v3; nobody's v2 answer counts
```

**(c) `@orch revise`**
```
bob: @room @orch revise: split the migration into its own step
orch ─► read head v3 + bob's words ─► propose({path, revises: v3, asked_by: bob}) ─► v4 {from orch, asked_by bob}
  approvers: v3's ∪ alice (proposer) ∪ bob; never the orch ─► everyone reviews v4
```

**(d) `@orch merge`**
```
orch flagged: "Paging API" (bob, #4) and "Cursor paging" (alice, #6) look like one plan
alice: @room @orch merge
orch ─► propose({path, merges: [cursor-head, paging-head], asked_by: alice})
  ─► Cursor paging v2 {supersedes: cursor-head, replaces: [paging-head]}, approvers = both threads' ∪ alice, bob
  both heads close changes_requested (by the merge) ─► everyone named on either reviews it
  orch: plan task #4 is bob's to release or close; it says so to bob once
```

**(e) Two planners collide via the task list**
```
bob's Claude:   task({add, subject: "plan: paging API", claim})     ─► reply: no other open plans
alice: "let's plan cursor paging for GET /tasks"
alice's Claude: task({add, subject: "plan: cursor paging", claim})  ─► reply: "Open plans: #4 plan: paging API (bob)"
  judges overlap ─► asks alice: "bob is already planning paging (#4) — send your input to them instead?"
  yes ─► post({to: bob, text: alice's points, quoted}) (or alice types @room @bob …) ; release her task
  no  ─► both plan; the orch, applying the add, sees #4 and #6 and flags once to alice and bob
         ("… look like one plan; @orch merge to combine") ─► merge on ask, or both proceed
  both agreed anyway ─► orch (push on agreed with another thread in force) flags the conflict to everyone named;
                        nothing closes; people withdraw, amend or merge
```

**(f) Subagents**
```
alice: "spawn two subagents to plan the parser and the paging API"
  two tasks: plan: parser (alice), plan: paging API (alice)  ─ each subagent drafts a plan file, proposes nothing
  alice's main thread: same topic? ─ yes: merge the drafts into one, propose once, close the other task
                                   ─ no: propose both (two threads, in parallel)
  bob's subagent also plans paging ─► its add sees #… plan: paging API (alice) ─► bob's main thread asks bob (as in e)
```

## Edge cases

| Case | Behaviour |
|---|---|
| Two revisions of the same head arrive together | Both append (proposal lock orders them). The later is the head; the earlier closes `changes_requested` by it. Its line says `drafted from v2; v3 (carol's) was replaced` when `base` ≠ the superseded head, so a lost edit is visible. |
| Someone answers v2 after v3 arrived (dialog already open, phone offline) | Recorded (their real answer), counts for nothing; their Claude is told and v3 opens on the next review. |
| Revision of an agreed version | v(n+1) opens; vn stays in force (`inForce`) until v(n+1) is agreed, then reads `superseded_agreed`. |
| Revision identical to the head | Refused: "no change from v3". |
| Revising too often | Over `REVISE_MAX` per person per thread per window: refused with the wait. `@orch revise` counts against the asker, not the orch. |
| A non-approver revises | Allowed (D2); they become an approver of that version. |
| Revision that drops an approver | Refused in `create`; a hand-built one is a standalone v1 in the fold. |
| An approver left the room | They stay named; the version waits; they answer on rejoin. (Open question 3.) |
| Proposer left | Others can still revise; the proposer stays an approver. Nobody else can withdraw. |
| Withdraw with an agreed version in force | Closes the open head only; the agreed version stays the decision. |
| The orch proposed version 1 | The orch is the proposer for routing ("changes requested" wakes it, as today's objection does) but never an approver. Every person named still approves. |
| Merge of a closed or withdrawn thread, or a thread with itself | Refused. |
| Merge where one side is agreed | That side stays in force until the merge is agreed (rule 5). |
| Change summary too long, or the plan over the dialog limit | Summary capped with the `sub-human show` pointer; over 200,000 chars the card fallback as today. |
| A `plan:` task whose owner never proposes | It is just an open task; the owner releases it, or the orch mentions it only when someone asks. |
| Legacy logs | Proposals without thread fields are v1 of their own thread; `objected:` decisions read `changes_requested`; old answers stay attached to their hashes. |

## Security and consent invariants

What must never count as agreement, each with the test that pins it (`test/hooks/consent-table.test.js` unless noted):

1. **Any answer not `via=human`, signed by the seat key, from a hook-opened review or card** of that version. Unchanged, and still the only path.
2. **An answer on another version.** No signoff ever counts for a hash it does not name: not the proposer's v1 signoff for v2, not the author's own drafting, not a signoff on a superseded or merged head.
3. **Drafting.** Calling `propose` with `revises` or `merges` records no answer for anyone, the drafter's person included. The author approves in their own dialog like everyone else.
4. **A shrunk approver set.** A version that names fewer people than its predecessor ∪ proposer supersedes nothing (fold rule, not only `create`).
5. **Superseding an agreed plan.** Only a newer *agreed* version replaces one in force; a revision, merge or withdraw alone never ends a decision.
6. **The orch.** It never approves, its overlap flag is not an answer, and its merge counts for nobody, including the person who asked for it.
7. **Model-written "what changed".** Only the hook's change header (from stored blobs) is shown as the change; a Claude's own "Changes" section is just plan text, which everyone approves as such.
8. **Edited or hand-copied text.** A dialog whose plan differs from the composed text, or a review the hook did not open, records nothing (as on `feature/remote-rooms`).
9. **Phone denials without a note, Esc, AFK, "Not yet".** Nothing.
10. **Tasks and chat.** A claimed `plan:` task, a `done`, "ok" in chat, an addressed post or a Claude's message is never agreement and never closes a version.
11. **The pick.** The hook picks which version a review opens; a model's choice, a stale plan file or a hash in the model's call never changes what is shown.

Withdraw is via=agent: a Claude steered by room text could withdraw its own person's plan. It cannot withdraw anyone else's, it ends no decision, and re-proposing restores it (open question 2).

## Implementation

Each phase ends green (`npm test`, `npm run docs`, `npm run validate`) and commits alone.

### P1 Versions in the log

Files: `lib/room/validate.js`, `lib/room/consent.js`, `lib/proposal.js`, `lib/config.js`, `lib/room/lanes.js`, `lib/room/render.js`, `lib/rows.js`, `test/hooks/consent-table.test.js`, `test/lane.test.js`, `test/rows.test.js`, `test/room.test.js`.

- Fields and the `withdraw` kind; `decision.outcome`.
- Fold threads, heads, `inForce`, link rules; `pending` heads only.
- `create` with `revises` / `merges`, approver union, refusals, rate limit; `withdraw`; `answer` counted only on heads; `decide` outcome and named text.
- Lanes, room lines, rows and stateLine per the tables.
- **Accept:** a three-version thread folds to one head with v1, v2 `changes_requested`; v1 signoffs from everyone leave v2 at 0/3; two concurrent revisions give the later as head; a hand-appended version that drops bob supersedes nothing; an agreed v1 stays `inForce` through an open, then withdrawn, v2; `Ship v3 Monday: agreed (alice, bob)` renders; every pre-existing consent-table row passes unchanged.

### P2 The plan view shows versions

Files: `hooks/consent.js`, `lib/proposal.js` (`changes`, compose, pick → head), `bin/sub-human` (`show HASH [--changes]`), `lib/cc.js` (nothing new expected; re-run `npm run probe`), `test/hooks/consent.test.js`, `test/cli.test.js`.

- Compose the header and diff for version > 1; the signoff check compares against it.
- `choose` / `picked` map any version's words or hash to the head; the model is told when it named a closed one.
- A stale-version answer: recorded, the model told, the head opened next.
- **Accept:** terminal "Yes" on v2's composed text records a signoff on v2's hash; the same with one edited character records nothing; a remote deny with a note on v2 records an objection and pushes "changes requested" to the proposer; a bare remote deny records nothing; "open Ship v3" with v1 closed opens v3; the header's diff comes from blobs when the plan text contains its own fake "Changed" section.

### P3 Tools and role texts

Files: `mcp/room-server.js` (`propose` gains `revises`, `merges`, `asked_by`, `plan_task`; new `withdraw` tool), `mcp/task.js` (open `plan:` tasks in the add reply), `lib/tasks.js` (`plan` flag, gate accepts a closed thread as evidence), `skills/sub-human/member.md`, `skills/sub-human/facilitate.md`, `test/mcp.test.js`, `test/tasks.test.js`, `docs/ARCHITECTURE.md` (generated tables via `npm run docs`).

- member.md gains, in its existing terse style: before planning, add a claimed `plan: <topic>` task and read the open plans its reply lists; on overlap ask the person before writing; on "changes requested" draft a revision and send it only when the person says so; withdraw only when the person asks.
- "in their own terminal" → "in their session"; names or they/them.
- **Accept:** `task add "plan: x"` replies with the other open plan tasks; `propose({revises})` by a non-approver adds them as approver; `withdraw` from a non-proposer is refused; the generated MCP table lists `withdraw`; no injected text says "terminal".

### P4 The orch

Files: `agents/orchestrator.md`, `lib/room/lanes.js` (orch push for `plan:` task_req, agreed-with-other-thread), `skills/sub-human/orchestrator.md`, `test/lane.test.js`, `test/orch.test.js`.

- `@orch revise: …` → read the head and the words, `propose({revises, asked_by})`. `@orch merge` → the named or flagged pair, `propose({merges, asked_by})`.
- When applying a `plan:` add, compare against open plans and threads; on overlap, one message to the two owners, once per pair. On an agreed decision with another thread in force, compare; on conflict, one message to everyone named on both. Otherwise silent.
- **Accept (live, demo scene S11):** alice and bob each start a plan on the same topic; bob's Claude offers to send input to alice; declined, the orch flags once; `@orch merge` produces one version naming both; both approve on phone-sized panes; the room shows `Cursor paging: agreed (alice, bob)` and no second plan is agreed. Behavioural checks (orch turns, flags sent) go in `baselines.json` as warnings.

### P5 Docs

Files: `plugin/sub-human/README.md` (Agreeing to a proposal: versions, Suggest edits, withdraw; Shared tasks: `plan:`; Threat model: invariants 2–5), `docs/ARCHITECTURE.md` (Consent diagram, fold, Tasks), this note to `docs/archive/` when done. Fix the current README and `facilitate.md` claim "a newer proposal replaces an older one": on `master` two hashes are independent in the fold, so it is untrue until P1.

## Open questions

1. **A hard no.** Every objection now reads "changes requested". Is a distinct "reject outright" needed, or is the note ("drop this") plus the proposer's withdraw enough? Proposed: enough.
2. **Who may withdraw.** via=agent from the proposer's Claude (proposed), or only the proposer's typed words (an `@room withdraw …` hook path, via=human)?
3. **Approvers who left.** Keep them named and wait (proposed), or let the proposer drop a departed approver with a visible line, which breaks "a revision never drops anyone"?
4. **The orch's unasked flag.** D7 lets the orch speak once per overlapping pair without being addressed. Keep that exception, or only mark the overlap in rows (`⚠ overlaps #4`) and speak when asked?
5. **Plan tasks required?** Soft convention (proposed), or should `propose` create the `plan:` task itself when the proposer has none, so the list is always complete?
6. **Change summary base.** Against what each person last answered (proposed) or always against the superseded head (simpler, same for everyone)?
7. **Amendments.** Should revising an agreed plan need anything more than a new version (e.g. naming the in-force version in the header so the phone shows "amends the agreed v2")? Proposed: the header says it; nothing else.
