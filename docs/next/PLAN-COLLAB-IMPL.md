# Plan collaboration: implementation plan

Status: plan, 2026-10-08. Not started. Builds [PLAN-COLLAB.md](PLAN-COLLAB.md) (the design, with its Decided list; those answers are final and not reopened here). Code read: `master` at `2d425b6`, and `feature/remote-rooms-v2` at `3af1914`, the port of the remote-rooms work in progress.

**Assumption: the port lands first.** Every PR below except PR0 is written against `master` after `feature/remote-rooms-v2` merges: `proposal.answer` (any machine, signed) + `proposal.decide` (host only, `identity.isHost`), the server calling `decide` after it places an answer (`lib/remote/server.ts` on v2, line 156), sig v2 and the envelope (`lib/room/envelope.ts`), `MirrorRoomStore` (`isHost = false`, writes as ops, `kv` local), the hook's pick (`proposal.choose` / `picked`, `members/NAME/pick`), the proposal text always in the plan view through `updatedInput.plan` and the plan file (backup, restore), and "Suggest edits" (a deny with a note) as an objection. Line numbers marked *v2* are on that branch; the rest are on `master`.

## Scope

In: the version thread in the log and its fold; revise, merge and withdraw; the change header in the plan view, terminal and phone; outcome lines that name the plan; `plan:` tasks and the overlap check; the room Claude's revise, merge, overlap and conflict flags; the role text and doc fixes.

Out: everything in the note's non-goals. No change to who may answer or how an answer is signed. No new transport op: every write below is an ordinary `append` (`proposal`, `withdraw`, `task_req`), placed by the host as today.

## Invariants every PR keeps

Each is a row in `test/hooks/consent-table.test.js` (or the named file) from the PR that could break it, and every later PR runs them unchanged.

1. **Only a human answer counts**: `via=human`, signed with the seat key (pinned in the log), from a hook-opened review or the card, for that hash. No PR adds another path.
2. **Per version.** No answer ever counts for a hash it does not name. Not the proposer's v1 signoff for v2, not an answer to a superseded, merged or withdrawn version, not a `proposal` entry's own author.
3. **Drafting is not answering.** `propose` with `revises` / `merges` records no answer for anyone, the drafter's person included.
4. **No shrinking.** A version naming fewer people than its predecessor ∪ the proposer supersedes nothing, judged in the fold, not only in `create`. The one exception: an approver with a `member_left` entry, and no later `member_joined`, before the new version in the log (Decided 3).
5. **A decision ends only by a newer agreed version.** Revise, merge and withdraw never change a `decision`; `inForce` moves only on an agreed head.
6. **The room's Claude never approves.** Its overlap flag, its merge and its `asked_by` count for nobody.
7. **The change header is the hook's.** Built from stored blobs only; a Claude's own "Changes" section is plan text.
8. **Edited or hand-copied text records nothing**: a dialog whose plan is not the exact composed text, or a review no hook opened.
9. **Bare deny, Esc, AFK, "Not yet": nothing.**
10. **Tasks and chat never agree or close.** A `plan:` task, `done`, "ok" in chat, an addressed post.
11. **The hook picks.** A model's hash, a stale plan file or a closed version's hash never changes what the dialog shows.
12. **Every machine folds the same state.** The fold reads only the log (no `members.json`, no kv), so the host and every mirror agree; only the host writes `decision`.
13. **Legacy logs read unchanged.** A proposal without thread fields is v1 of its own thread; every pre-existing consent-table row passes as it is.

## Conflicts between the note and the code

Resolved here; PR1 records the resolution in the fold's header.

| Note says | Code says | Plan |
|---|---|---|
| `version` is "assigned under the proposal lock" | On a mirror `store.lock('proposal')` locks the joiner's own mirror directory; the REMOTE-PLAN correction calls it "a lock that means nothing across machines". Two machines can both write "v3". | The fold numbers versions by host log order and ignores any stored number. `version` is not written. Concurrent revisions are already handled by "the latest supersedes" (rule D6). |
| Plans are content-addressed, "agreement is per version" | `hash = sha256/12` of the text (`lib/proposal.ts:66`); answers attach to the hash wherever they sit (`lib/room/consent.ts:21-22`) | A revision whose text equals an **earlier** version (a revert to v1) would get v1's hash and v1's old signoffs. `create` refuses any text whose hash already has a proposal in the log ("this is v1's text; change something"). In the fold, a `supersedes` / `replaces` entry whose hash appeared earlier is a re-append, not a version. |
| Approvers can only grow | The latest proposal entry per hash wins (`consent.ts:62-64`); a re-propose of the same text with fewer approvers is appended (`proposal.ts:213-219`) | The supersede check uses the union of every proposal entry's approvers for that hash. A re-append to an open thread head that drops someone is refused in `create`, and the fold keeps the union for thread heads. |
| `plan_task`: "the `plan:` task id" | Task ids exist only once the room's Claude applies the `task_req` (`mcp/task.ts:62`; the room Claude's native TaskCreate). `propose` cannot know the id of a task it just asked for. | Field `plan_req`: the log id of the `task_req` (`add`) the plan came from. The `task` entry the room's Claude writes carries `req`, so the fold maps req → task id. When the proposer already holds the task, `plan_req` is that task's add request. |
| "claimed at add" | `task` has no claim on add (`mcp/task.ts:27-33`, `lib/tasks.ts:41`), though `agents/room-claude.md:15` already says "with claim, also TaskUpdate". | `task({op:'add', claim:true})`; `claim` joins `TASK_FIELDS` (`lib/room/validate.ts:29`). |
| Auto plan task in `propose` | With no live room Claude `task` appends nothing (`mcp/task.ts:54`) | `propose` still proposes; the reply says "no room Claude: no plan task". Planning stays optional (design rule "Unprescriptive"). |
| The gate "accepts a `plan:` task's done whose evidence names its thread's closing entry" | The gate already accepts any `done` with evidence from the owner's Claude (`lib/tasks.ts:199-200`) | No gate change. member.md says to cite the decision or withdraw in the evidence. |
| P4's live check is "demo scene S11" | S11 is the remote scene on v2 (`scripts/demo.sh:475` v2, `scripts/checks/s11-remote.js`) | The new scene is **S12**. |
| Docker harness for the room's Claude flows | The harness's room Claude `claude` is a stub (`scripts/remote-docker/harness.js:6-7` v2) | Room Claude flows (c, d, e) are checked in a local room with a real room Claude; Docker covers host-only decide with real joiners (a, b, f). |
| Room lines need the thread ("v2 (changes requested by bob)") | `chatBody(e, viewer)` sees one entry and no log (`lib/room/render.ts:132`) | `chatLines(e, {viewer, entries})`; the tail passes the log it already judges lanes against; without `entries` the line is today's. |

## PRs

Each PR leaves `master` green: `npm test` (with `test:mods`), `npm run validate`, `npm run probe`, `bash -n scripts/demo.sh`, and `npm run docs` when hooks.json, an MCP tool, the cc CONTRACT or a lib header changed. One commit per PR, ending with the Co-Authored-By line. Comments say why, not which PR.

| PR | Needs the port | Size |
|---|---|---|
| PR0 Wording that is wrong today | no: land on master now | S (~30 lines) |
| PR1 The log model and the fold | develop now; lands after the port (`validate.ts` conflicts) | L (~350 + ~400 tests) |
| PR2 Writers: create, withdraw, answer, decide | yes (`answer` / `decide` exist only there) | M (~200 + ~250) |
| PR3 Views: lanes, room lines, rows, stateLine | yes (`lib/tail.ts` changed there); after PR1 | M (~200 + ~250) |
| PR4 The plan view shows versions | yes (the pick, `updatedInput.plan`); `lib/diff.js` can start now | L (~250 + ~350) |
| PR5 Tools and plan tasks | yes; after PR2 | M (~180 + ~200) |
| PR6 The room's Claude | yes; after PR3 and PR5 | M (~120 + ~150) |
| PR7 Docs, demo S12, live verification | yes; last | M (docs, one scene) |

### PR0 Wording that is wrong today

Files: `plugin/sub-human/mcp/room-server.js` (`:172` and `:218`), `plugin/sub-human/skills/sub-human/facilitate.md` (`:23`, `:28`), `plugin/sub-human/README.md` (`:8`, `:129`), `docs/ARCHITECTURE.md` (generated MCP table).

- "answers a card in their own terminal" → "answers it in their own session (terminal or phone)", in the propose description, the propose reply and facilitate.md. README `:8` "in your terminal" → "in your session".
- README `:129` and facilitate `:28` say "a newer proposal replaces an older one, and earlier answers stop counting". On `master` two hashes are independent in the fold (`consent.ts:62-77`): the old one stays open and its answers still count. Replace with the truth for now: "A changed plan is a new proposal; ask the people to answer it. The earlier one stays open until it is answered." PR7 rewrites it for versions.
- Names or they/them in every injected text (grep `\b(he|she|his|her)\b` over `skills/`, `agents/`, `mcp/`, `hooks/`: none today; the test below keeps it so).
- Tests: `test/manifest.test.js` gains "no injected text says terminal; no gendered pronoun" over the propose tool description, the propose reply, `skills/sub-human/*.md` and `agents/*.md`.
- **Accept:** `npm run docs` regenerates the MCP table; the new test fails on the old texts.

### PR1 The log model and the fold

Files: `plugin/sub-human/lib/room/validate.js`, `plugin/sub-human/lib/room/consent.js`, `plugin/sub-human/lib/config.js`, `plugin/sub-human/lib/room/store.js` (`normalize`: legacy `objected:` decisions get `outcome`), `test/hooks/consent-table.test.js`, `test/room-integrity.test.js`, `test/store-contract.test.js`, `test/envelope.test.js` (v2).

- validate: `proposal` may carry `thread`, `supersedes`, `base` (hashes, `HASH_RE`), `replaces` (≤ 4 hashes), `asked_by` (a name), `plan_req` (a log id). `withdraw` joins `AGENT_KINDS` with `proposal_hash` required and `text?`. `decision` may carry `outcome` (`agreed` | `changes_requested`), system only. Each field is refused on any other kind. `task_req` add may carry `claim: true`.
- config: `REVISE_MAX: 3`, `REVISE_WINDOW_MS: 600_000`, `CHANGES_MAX_LINES: 12`, `CHANGES_DIFF_MAX_LINES: 4000` (above this the header says "too long to compare; `sub-human show HASH --changes`").
- Fold (one pass, log order; the note's F shape):
  - `F.threads` root → `{root, proposer, versions, head, inForce, withdrawn}`; `F.threadOf(hash)`, `F.versionOf(hash)` (1-based, log order).
  - Link rules exactly as the note's list, plus: a link counts only when its hash has no earlier proposal entry; the approver check uses the union of the predecessor's entries; the departed exception reads `member_left` / `member_joined` before the new version's position.
  - `withdraw` counts only from the thread's proposer (the room's Claude when it proposed v1) and only on the open head.
  - `asked_by` counts only when that person has a `via=human` entry mentioning `@claude` after the previous head's proposal entry (else it is ignored for lines and rate limits; it never adds or removes an answer).
  - `status(hash).state`: `open | agreed | changes_requested | withdrawn | superseded_agreed`; `.by` = the closing hash. `blocked` stays an alias of `changes_requested` for one release (rows and tests read it).
  - `decision.outcome`, else legacy text `objected:` → `changes_requested`, else `agreed`.
  - `F.pending(name)`: heads only.
  - `F.lastAnswered(name, root)`: the latest version of that thread name answered (for PR4's header).
- Migration: none on disk. Old logs fold as single-version threads; old decisions keep their text and read their outcome from it. A host on this PR and a joiner before it: the joiner's old fold ignores the new fields and sees independent proposals (no wrong agreement: invariant 2 holds because answers are per hash in both folds). A joiner on this PR against an older host gets INVALID on `withdraw` and on the new fields; PR2's `create` turns that into "the room's host runs an older sub-human; revisions need it updated".
- Tests (consent-table, one row each): the note's P1 accept list; a revert to v1's text supersedes nothing; a re-append of the head with fewer approvers keeps the union; a version dropping a departed approver supersedes, the same drop of a present one does not; a person who left and rejoined before the version cannot be dropped; `withdraw` from a non-proposer, from the room's Claude on a person's thread, and on an agreed head: no effect; a legacy log (fixture from `test/fixtures`) gives the same `state` per hash as before except `blocked` → `changes_requested`; F is identical over a host log and its mirror copy (store-contract, `test/support/two-homes.js`).
- **Accept:** every pre-existing consent-table row passes unchanged; the new rows pass; `npm run docs` picks up the fold header.

### PR2 Writers: create, withdraw, answer, decide

Files: `plugin/sub-human/lib/proposal.js`, `test/hooks/consent-table.test.js`, `test/remote-e2e.test.js` (v2), `test/hooks/consent.test.js`.

- `create(me, {text|path, approvers?, revises?, merges?, asked_by?, plan_req?})` per the note's writer block, with the refusals above (no change from the head; text of any earlier version; closed or withdrawn thread; merging a thread into itself; a drop of anyone present; more than `REVISE_MAX` versions by `me`, or by `asked_by` when the room's Claude drafts, in this thread within `REVISE_WINDOW_MS`, counted from the log so a mirror counts the same). Approvers default to the predecessor's ∪ proposer ∪ `me` (a person) ∪ `asked_by`, never the room's Claude. The entry's `text`: `proposal HASH: TITLE`, as today (lines are derived, PR3).
- `withdraw(me, hash, why?)`: appends `withdraw` via=agent when `me` is the thread's proposer and the head is open; else refuses with the reason.
- `answer`: unchanged on the hash it is given; returns `{entry, counted: false, head}` when the hash is not the head (recorded, never counts, rule D6). `pendingFor` is heads only through the fold.
- `decide(code, hash)` (host only): only for the head; writes `outcome` and the text `TITLE: agreed (alice, bob)` / `TITLE: changes requested (bob)`, the title clipped to `PROPOSAL_TITLE_MAX`. A non-head, closed or incomplete hash appends nothing.
- `changes(code, from, to)` → `{lines, more, dropped}` from blobs only, through `lib/diff.js` (PR4 writes it; until then a stub returning `null`).
- Tests: the three flows (a), (b), (c) as consent-table rows with the writers; `decide` on a superseded head appends nothing; remote two-home e2e: bob (joiner) revises alice's v1, carol and alice answer on the host, bob answers on his mirror, the host's server writes the one decision on v2 and the mirror's fold matches; bob's `answer` on v1 after v2 is placed is recorded, counts for nothing, and no decision is written.
- **Accept:** the note's P1 writer accept items; a joiner's revision and the host's revision of the same head within one second give one head (the later in host order) on both machines.

### PR3 Views: lanes, room lines, rows, stateLine

Files: `plugin/sub-human/lib/room/lanes.js`, `plugin/sub-human/lib/room/render.js`, `plugin/sub-human/lib/rows.js`, `plugin/sub-human/lib/tail.js`, `plugin/sub-human/statusline/*` (only if a row string changes width), `test/lane.test.js`, `test/rows.test.js`, `test/room.test.js`, `test/tail.test.js`, `test/statusline.test.js`.

- lanes: an objection pushes to the thread's proposer and to the version's author (`lanes.ts:83-88` pushes only `p.from` today); a proposal pushes only while it is the open head; `quietDecision` reads `outcome` (`lanes.ts:117` parses `objected:` today); a `withdraw` pushes to every approver of the head; room Claude push rules wait for PR6.
- render: the note's room-line table through `chatLines(e, {viewer, entries})`; the stale-answer line goes to the consent hook (PR4), not the log; `decision` lines read `outcome` (`render.ts:145-147`); `stateLine` lists threads by head (`render.ts:197-213`): `room now: Ship v3 Monday v3 waiting on carol · you: answer needed (…)`; the digest lists heads and in-force versions, closed versions as one line per thread.
- rows: one entry per thread (`rows.ts:301-325` maps per hash); `✎ changes requested by bob` on the proposer's and author's rows; `✖ blocked` (`rows.ts:318`) becomes `✎ changes requested`; an in-force version with an open amendment shows `✔ TITLE v2 · v3 open`.
- tail: passes its judged `entries` to `chatLines`; a superseded head's pending review drops at flush time (it already re-judges lanes at send time).
- Tests: lane rows for each push above (with and without `entries`); every line in the note's room-line table, exact; rows for a three-version thread show one line; stateLine never shows a closed version; a legacy log renders today's lines except `not agreed (…)` → `changes requested`.
- **Accept:** consent-table rows still agree across stateLine, lane, rows and `pendingFor`; `test:mods` render wiring tests pass.

### PR4 The plan view shows versions

Files: `plugin/sub-human/lib/diff.js` (new: a line diff, LCS over at most `CHANGES_DIFF_MAX_LINES`, zero dependencies), `plugin/sub-human/lib/proposal.js` (`changes`, `compose(me, p)`, pick → head), `plugin/sub-human/hooks/consent.js`, `plugin/sub-human/scripts/sub-human` (`show HASH [--changes]`), `plugin/sub-human/lib/cc.js` (nothing new expected; `npm run probe`), `test/diff.test.js`, `test/hooks/consent.test.js`, `test/cli.test.js`, `test/remote-e2e.test.js`, `mod/test/consent.test.ts`.

- `compose(me, p)` → `{text, shownHash}`: for version 1, the plan as today; for n > 1, the note's header (version n of m, author, `asked by`, what it replaces and why) then a rule line then the plan byte for byte. The diff is against `F.lastAnswered(me.name, root)`, else the superseded head (Decided 6). An amendment adds "amends the agreed vK" (Decided 7). A version that drops a departed approver names them: "drops dave (left the room)". A merge names both sides. A prior blob missing on a mirror (OFFLINE): "changes unavailable here: `sub-human show HASH --changes`", never the text without a header.
- hooks/consent.ts: everywhere it compares the dialog's plan with the proposal by hash it compares with `shownHash`, and records the version hash: the signoff check (`hooks/consent.ts:333` v2, `hash12(r.plan) !== st.hash`), `mine()` (`:239` v2), `unshown` (`:298` v2), `ask(st, me, text)` (`:270-273` v2) and `showEarly` write the composed text; `review.json` gains `shown` (the hash of the composed text). `restoreStale` compares the file with `st.shown` (`lib/proposal.ts:299`, `hash12(cur) === st.hash` today).
- The pick: `namedIn` runs over heads; words or a hash naming a closed version map to its head, and the model is told "v2 was replaced by v3; showing v3". A `vN` token counts as a version only when no pending title contains it (the note's own example title is "Ship v3 Monday").
- A stale answer (dialog opened on v2, v3 arrived before the answer): recorded via `answer` (`counted: false`), the person's systemMessage says "your answer was to Ship v3 Monday v2; v3 replaced it and is next", the model is told to open the head.
- Suggest edits: the existing objection path; the push to the proposer and author comes from PR3's lanes.
- The card fallback: the header on top of `preview()`; past `PREVIEW_MAX`, the header's first two lines, the summary and the path.
- `sub-human show HASH [--changes]`: read-only; the plan, or the full diff against the version it superseded.
- Tests: the note's P2 accept list; a header built while the plan text has its own "Changed since v2" section is still the blob diff; the composed text for bob (answered v1) and carol (never answered) differ and each records on the same version hash; an edited character in the header records nothing; a Remote Control deny with a note on v2 records an objection; a bare deny records nothing; `restoreStale` restores a file holding the composed text; remote e2e: bob's review on his mirror composes from prefetched blobs and his signoff on v2 reaches the host's decision; with the link cut, the header says changes are unavailable and Approve still records only once the room is reachable (today's OFFLINE path).
- **Accept:** terminal "Yes" on v2's composed text records a signoff on v2's hash; the phone view (PR7 live) shows the same text.

### PR5 Tools and plan tasks

Files: `plugin/sub-human/mcp/room-server.js` (`propose`: `revises`, `merges`, `asked_by`, the auto plan task; new `withdraw` tool), `plugin/sub-human/mcp/task.js` (`claim` on add; open `plan:` tasks in the add reply), `plugin/sub-human/lib/tasks.js` (`isPlan(t)`, `openPlans(code, except)`, `plan: true` in `list` / `--json`), `plugin/sub-human/lib/room/validate.js` (`claim` on task_req), `plugin/sub-human/scripts/sub-human` (`tasks --json`), `test/mcp.test.js`, `test/tasks.test.js`, `test/hooks/tasks.test.js`, `docs/ARCHITECTURE.md` (generated).

- `propose({text|path, approvers?, revises?, merges?, asked_by?})`: `asked_by` only from the room's Claude. When the proposer holds no open `plan:` task, it first appends `task_req {op:'add', subject:'plan: TITLE', claim:true}` and writes that entry's id as `plan_req` (Decided 5); with no live room Claude it proposes anyway and says so. The reply: version n, who it goes to, what it replaces, "nobody's earlier answer carries over; NAME (you) answers it too".
- `withdraw({proposal})`: the proposer's Claude only; reply names what closed and that an agreed version stays in force.
- `task({op:'add', subject:'plan: …', claim?})`: reply `queued; the room's Claude applies it. Open plans: #4 plan: paging API (bob)` (other owners' and this person's own other open `plan:` tasks), or `no other open plans`. A subagent's call resolves to its session's person (`process.ppid`, shared MCP server), so two subagents make two tasks of one owner.
- Tests: the note's P3 accept list; `propose` with no plan task appends the add first and the proposal's `plan_req` is its id; with one, appends no add; with no room Claude, proposes and says so; `withdraw` by a non-proposer refused; `revises` by a non-approver adds them; `asked_by` from a member refused; the tool list in `npm run docs` shows `withdraw`.
- **Accept:** the generated MCP table lists `withdraw`; the add reply lists other plans in the same call.

### PR6 The room's Claude

Files: `plugin/sub-human/agents/room-claude.md`, `plugin/sub-human/skills/sub-human/room-claude.md`, `plugin/sub-human/lib/room/lanes.js` (room Claude push), `plugin/sub-human/mcp/room-server.js` (room Claude `post` gains `overlap: [taskA, taskB]`), `plugin/sub-human/lib/room-claude.js` (the flagged-pairs document), `test/lane.test.js`, `test/room-claude.test.js`, `test/mcp.test.js`.

- room-claude.md: tools gain `mcp__plugin_sub-human_room__withdraw`; one line each: `@claude revise: …` → read the head (`read`, the plan path), draft, `propose({path, revises: head, asked_by})`; `@claude merge` → the named or last-flagged pair, `propose({path, merges, asked_by})`; on applying a `plan:` add, compare with open plans and threads, flag once; on an agreed decision with another thread in force, compare, and on a conflict post once to everyone named on both.
- Once per pair, in code: the room Claude's `post` with `overlap` is refused when the room document `room Claude/overlaps` already holds the pair (host kv; the room's Claude runs on the host). A judgment stays the room Claude's; only the repeat is blocked.
- lanes: room Claude push for a `task_req` add whose subject starts `plan:` (it applies those anyway) and for an `agreed` decision while another thread is open or in force.
- Tests: lane rows for both pushes and for an claude-proposed v1's objection; the second `overlap` post for the same pair is refused, the reversed pair too; the room Claude's `propose` with `asked_by` and no `@claude` request in the log is refused.
- **Accept:** the S12 checks in PR7; behavioural counts (room Claude turns, flags sent) go to `scripts/baselines.json` as warnings.

### PR7 Docs, demo S12, live verification

Files: `plugin/sub-human/skills/sub-human/member.md`, `plugin/sub-human/skills/sub-human/facilitate.md`, `plugin/sub-human/README.md` (Agreeing to a proposal: versions, Suggest edits, withdraw; Shared tasks: `plan:`; Threat model: invariants 2-5), `docs/ARCHITECTURE.md` (consent diagram, the fold, tasks), `scripts/demo.sh` (S12), `scripts/checks/s12-plans.js`, `scripts/test/s12-plans.test.js`, `scripts/baselines.json`, `docs/archive/README.md`; move both PLAN-COLLAB notes to `docs/archive/`.

- member.md, terse, mechanics only: before planning, add a claimed `plan: <topic>` and read the open plans in the reply; on overlap ask the person "NAME is already planning this; send your input to them instead?" before writing; on "changes requested" draft a revision and send only when the person says so; withdraw only when the person asks.
- facilitate.md: the objection paragraph becomes "revise with `revises`; the room shows what changed; everyone answers again".
- **S12** (local room, real room Claude): alice and bob plan the same topic; bob's Claude offers to send input; declined; the room's Claude flags once; `@claude merge`; both approve; `Cursor paging: agreed (alice, bob)`; no second plan agreed. Deterministic checks: the log shape (one merge version, both old heads closed, one decision, one overlap post).
- **Accept:** the live plan below passes; `checks.js` exits 0.

## Live verification

Run after PR7, with a throwaway home, never `~/.sub-human`. Record each step's host log lines in the PR7 commit's results note.

**Setup A, Docker, host-only decide with phones.** `node scripts/remote-docker/harness.js up --host-seat alice --joiners bob,carol`. In two Mac terminals: `source /tmp/sub-human-remote-manual/NAME.env; cd NAME-proj; claude --plugin-dir <repo>/plugin/sub-human --remote-control`, then `/sub-human join NAME $SUB_HUMAN_INVITE`. Open both sessions on the phone (Claude app, Remote Control). Alice is the scripted host seat: she cannot answer a dialog, so every proposal names bob and carol explicitly. Read the host log with `docker compose -f scripts/remote-docker/compose.yml exec -u host devbox node /harness/host-cli.js dump`.

- (a) Suggest edits. bob's phone: "plan a one-line README change and propose it to bob and carol". Expect `proposal` v1 (from bob, approvers bob, carol; a `task_req` add `plan: …` with `claim` just before it and `plan_req` = its id). carol's phone: open it, Suggest edits "say why". Host log: `objection` via=human from carol, `text` byte-exact, `trust` verified; no decision. bob's session shows `carol requested changes to …: "say why"`. bob: "revise it and send it". Host log: `proposal` from bob, `supersedes` = v1, `thread` = v1, approvers ⊇ {bob, carol}, no answer from bob. Both phones' plan views show the header "version 2 of 2 … Replaces v1: changes requested by carol" and the diff. Both Approve. Host log: two signoffs on v2's hash, then one `decision` from `room`, `outcome: agreed`, text `TITLE: agreed (bob, carol)`, written by the host (no decision line ever comes from a mirror). Both mirrors' `sub-human read --json` end with the same line ids.
- (b) An approver's Claude edits. With v2 open on bob's phone, carol (terminal) says "change it and resend". Host log: v3 from carol. bob Approves v2 on the phone after v3 lands: a signoff on v2's hash, no decision; bob's session says v3 replaced it; bob's next review opens v3, header against v2 (what bob last answered).
- (f) Subagents. bob: "spawn two subagents to plan X and Y". Host log: two `task_req` adds `plan: …` from bob; at most one proposal per topic; when the same, bob's Claude merges before proposing.
- Cut: `harness.js cut` while carol's dialog is open; Approve: carol is told it was not recorded; `heal`; reopen; one signoff.
- Withdraw: bob: "withdraw it". Host log: `withdraw` from bob on the head; carol's pending review is gone (`sub-human` row shows nothing open); an agreed version, when there is one, still reads in force (`dump` + `sub-human digest`).

**Setup B, a local room with a real room Claude** (flows c, d, e; the Docker room Claude is a stub). `SUB_HUMAN_HOME=$TMPDIR/sh-pc/home`, `sh-spike-alice` / `sh-spike-bob` tmux sessions plus Remote Control on the phone for bob, or `scripts/demo.sh --only S12`.

- (e) bob: "let's plan paging"; alice: "let's plan cursor paging for GET /tasks". alice's add reply lists `#N plan: paging (bob)`; her Claude asks before writing. Decline. Log: exactly one room Claude post with `overlap` naming both tasks, to alice and bob; a second similar add brings no second flag.
- (d) alice: `@claude merge`. Log: a room Claude `proposal` with `supersedes` (one head), `replaces` (the other), `asked_by: alice`, approvers both threads' ∪ alice, bob; no room Claude answer; both old heads read `changes_requested` in `sub-human digest`. Both approve; one `decision`.
- (c) bob: `@claude revise: split the migration into its own step`. Log: room Claude `proposal` `revises` the head, `asked_by: bob`; approvers include alice (proposer) and bob, never room Claude; a fourth `@claude revise` from bob within ten minutes is refused with the wait.
- Conflict: agree two overlapping threads anyway. Log: one room Claude post to everyone named on both; no entry closes either.

## Risks

- **Revert to an earlier text** (`lib/proposal.ts:66`, `lib/room/consent.ts:62-77`): content addressing would carry v1's signoffs to a v3 with v1's text. PR1/PR2 refuse it and the fold ignores it; a consent-table row pins it.
- **Approver shrink by re-append** (`lib/proposal.ts:213-219`, `consent.ts:62-64`): today a re-propose with fewer approvers replaces the set. PR1's union rule closes it for thread heads; the legacy "latest wins" stays for v1-only proposals, where the consent-table test at `test/hooks/consent-table.test.js:22` relies on it.
- **Mirror lock is local** (`store.lock('proposal')`, `lib/proposal.ts:232`): version numbers and the rate limit are judged from host log order only, never from a lock.
- **Host/joiner version skew**: an older host refuses `withdraw` and the new fields (`validate.ts:20`, `:30-31`). The message must say "update the host", and the protocol's hello (`lib/remote/protocol.ts` VERSION 1, v2) gains a `consent: 2` cap so a joiner can tell before writing.
- **Hash comparisons in the hook** (`hooks/consent.ts:239`, `:298`, `:333` v2; `lib/proposal.ts:299`): each assumes the shown text is the plan. Miss one and a v2 review either never records or restores the wrong file. PR4 changes them together with a test each.
- **Decision text parsers** (`lib/room/lanes.ts:117`, `lib/room/render.ts:146-147`): both parse `objected:` / `(proposal HASH)`. PR3 reads `outcome`, with the text as the legacy fallback.
- **Diff cost**: an LCS over two 200,000-character plans is quadratic in lines; `CHANGES_DIFF_MAX_LINES` caps it, the hook's 10 s timeout is the bound to test against.
- **Phone width**: the header lines wrap on a phone; keep them under 60 columns and check in Setup A.
- **The room's Claude over-flags**: the once-per-pair document stops repeats, not a wrong first flag; S12's baseline warns on more than one flag.

## Open questions

1. **`v3` in titles.** The note's example title "Ship v3 Monday" makes "Ship v3 Monday v3" ambiguous in rows and in the pick. Proposed: rows and lines say `version 3` when the title itself has a `vN` token, else `v3`. Confirm.
2. **Departed approver who rejoins.** Decided 3 allows dropping someone who left. If they rejoin while the version that dropped them is open, they are not on it. Proposed: they are not added back automatically; anyone can revise to add them. Confirm.
