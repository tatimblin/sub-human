# sub-human v2: Testing plan

How v2 is tested. It pairs with `docs/PRD.md` (requirements R…, quality bar Q-1 to Q-5) and `docs/ARCHITECTURE.md` (§12).

**The rule:** everything that can be checked without a model is checked without one, in CI, in under a minute. Real Claude Code sessions are used only for the nightly canary and one small live gate per release.

## 1. Layers

| Layer | Tool | Runs | What it proves |
|---|---|---|---|
| 1. Unit | `node:test` | every commit | the pure `core/` rules |
| 2. Store contract | `node:test` | every commit | fs, mirror and memory stores behave the same |
| 3. Module | Claude Code's test kit (`claude plugin test`) | every commit | the hooks module reacts to Claude Code events correctly |
| 4. Edges | `node:test` | every commit | command hooks, the module-to-node bridge, vendored files, the CLI |
| 5. Network | `node:test`, two homes in one process | every commit | sync, admission, kick, reconnect, hardening |
| 6. Canary | real Claude Code binary, no model | nightly, on `latest` and `next` | Claude Code still behaves as the contract says |
| 7. Live gate | real sessions, real model | once per release | the product works, and is quiet and cheap enough |

Layers 1–5 make up the CI suite. Two file names keep the runners apart: the kit runs every `*.test.ts` in the plugin directory, so node tests are named `*.node-test.ts` (the POC's convention).

## 2. Unit tests (`core/`)

Pure functions get table tests, with inputs in and outputs out, and no I/O.

- **`fold`:** log plus documents → `RoomState`, for joins, leaves, plans, decisions and tasks.
- **`deliver`:** every row of the R10 wake rule and the R15c relevance rules, as a table of `(entry, member, state) → none | context | notice | wake`. It covers:
  - broadcasts never wake;
  - a direct message wakes once (debounced);
  - the hourly budget;
  - the ~400-token context cap;
  - overlap (R15d).
- **`plans`:**
  - compare-and-swap: a stale base is refused with the current text;
  - a new version supersedes open requests on older ones;
  - answers count for one version only;
  - a decision is written when everyone named has answered;
  - owned parts become tasks.
- **`tasks`:**
  - claim is for oneself only, and refused while someone else owns the task;
  - release and done are the owner's only;
  - `blockedBy`;
  - the bridge mapping: `statusChange.to` becomes a room op, and a reopen changes nothing.
- **`activity`:** a classifier tested against **recorded fixtures** (§8), never hand-written shapes. It covers:
  - edits;
  - `gitOperation` commits and pushes;
  - test runs;
  - TaskCreate and TaskUpdate.
- **The secret filter:** gitleaks-derived patterns, `.env*`, `*.pem`, ignored paths. It runs on a corpus that must be refused and one that must pass.
- **`link-engine`:** table tests on an injected clock, covering backoff, heartbeat, sleep (a wall-clock jump), fork, and kick.
- **`protocol`:** encode and decode round trips, version and caps negotiation, and unknown fields being tolerated.
- **Schemas:** valibot schemas reject malformed outside data. A small property test feeds random JSON to every decoder.
- **Noise:** `noise.ts` against the published cacophony and snow vectors.

## 3. Store contract tests

One suite runs against all three backends: fs, mirror-over-pipe, and memory. That keeps the `RoomStore` seam honest. The POC did this as `store-contract.node-test.ts`.

The suite covers:
- appends and sequence numbers;
- latest-wins documents;
- snapshot plus the entries after it;
- fork detection;
- locks under concurrent writers;
- crash-safe document writes.

## 4. Module tests with Claude Code's test kit

These use `claude plugin test` with `import { expect, mock, test } from 'claude-code/testing'`. The kit loads the module and fires events through its hooks the way Claude Code would, with no session, sign-in or network. The test's `$` stands in for Claude Code.

**Pattern.** The module under test is *my* session. The room is a memory or temp-dir store that the test writes to as the *other* members, scripting colleagues through the `core` API. The test then asserts what my session did.

```ts
import { expect, mock, test } from 'claude-code/testing'

test('a relevant colleague change reaches my next prompt, capped', async ($, on) => {
  const clock = mock.clock(on)
  const shown: string[] = []
  on('ui.status', ($, e) => { shown.push(e.text); return { value: undefined } })
  on('ui.log',    () => ({ value: undefined }))
  const room = await seedRoom(on, { me: 'alice', others: ['bob'] }) // memory store + stubs for $.fs / $.process

  await $.tool.call({ tool: 'Edit', file_path: '/w/src/store.js', /* … */ }) // I touch store.js
  room.as('bob').activity({ files: ['src/store.js'], commit: 'change listTasks shape' })
  await clock.advance(1000)                                           // one follow poll

  const r = await $.prompt.submit({ text: 'keep going' })
  expect(r.context.join('\n')).toMatch(/bob.*listTasks/)
  expect(tokens(r.context)).toBeLessThan(400)
  expect(shown.at(-1)).toMatch(/bob \(working\).* · 1 update/)
})
```

**What is tested here:**

| Area | Events fired | Assertions |
|---|---|---|
| Capture (R12, R23) | `$.tool.call` with recorded results (Edit, Bash with `gitOperation`, TaskCreate, TaskUpdate) | the right document or entry is written; secrets are refused |
| Context (R15a) | `$.prompt.submit` | only relevant updates, datamarked, under the cap; nothing for broadcasts that don't bear on my work |
| Status and news (R15b, R16) | `mock.clock` advance | the `ui.status` text; `/sub-human news` renders with no model call |
| Messages (R6), sender side | a `SendMessage` to `bob.CODE`, which fires the module's `session.send` hook | answered `{ isDelivered: true }` without `next`; the message goes to the room channel stamped with the sender, never the log. **The M1 risk test:** run under `claude plugin test` against the real engine to show the answer without `next` is honoured. |
| Wakes (R10), recipient side | a scripted incoming message on the room channel, then `$.turn.complete(...)` | one `prompt.submit` after the turn ends, framed `bob's Claude asks: …`; debounce and budget; a retry when `isAborted`; in every mode, a command- or URL-bearing message is drawn, not submitted; the permission mode is untouched |
| Claude's tools (§6 of ARCHITECTURE) | `$.tool.run` for `share`, `read`, `plan`, `task` | each registered with `$.tool.register`; one-line answers; plan compare-and-swap conflicts; secrets refused on `share` |
| Plans (R18–R22) | `$.tool.call({ tool: 'ExitPlanMode', … })` with a recorded result | the keep / room / send question; the review card from `ui.ask` (it arrives as a `tool.call` to `AskUserQuestion`), stubbed to answer Agree, Ask for changes (Other) or Read the full plan; the last one mounts the pane, which scrolls |
| R19's three properties | the plan flows above | the person's own plan file is never written (`fs.write` stub records nothing); the mode is unchanged |
| Admission (R30) | host side: a knock arrives | `ui.ask` Let in / Refuse with name, machine and check string; a second dial alerts |
| Panes | `$.ui.mount({ component: 'Pane', … })`, `ui.press`, `ui.find` | the plan pane and the news view draw and scroll |
| Degradation (C3) | `mock.env`, refused stubs | a missing surface gives one line, never a fallback chain |

**Kit facts this plan relies on**, each checked against the 2.1.330 typings:
- The module imports the vendored files (`vendor/*.mjs`) by relative path under the kit, as the Q13 spike showed for valibot and diff.
- Stubs must be registered before the first `$` call.
- `$.ui.ask` arrives as `tool.call` to `AskUserQuestion`.
- `mock.clock` starts at 0; `advance` resolves after due timers.
- Each test gets 5 s unless it sets `timeoutMs`.
- `mock.session(on).appended()` needs 2.1.293+.
- `$.state`, `ui.invalidate` and `session.append` are answered by the kit itself.

**What the kit can't do, and where each gap is covered:**

| Gap | Covered by |
|---|---|
| No model runs | the canary and live gate (§7, §9) |
| No command hooks (`hooks.json`) | the edge tests (§5). There is no MCP server to test; Claude's tools are module tools, tested here through `tool.run`. |
| No node processes (the daemon) | the network tests (§6); the module side stubs `$.process.spawn` and `$.http.fetch` |
| No two real sessions at once | one side is scripted here; two-sided behaviour is tested in the store and network tests (§3, §6) and in the live gate |
| It doesn't check painting | `ui.find` on mounted trees is enough |

The kit needs hooks modules turned on in the shell that runs it. If they're off, it exits 1 with a reason. CI therefore installs a pinned Claude Code, and treats "modules off" as a failure, never a skip.

## 5. Edge tests (`node:test`)

- **Command hooks.** Each `hooks.json` handler (the `/sub-human` expansion, `SessionStart` with its title, `Notification` and `SessionEnd`) runs with recorded stdin fixtures. The tests assert its stdout `Reply` and exit code, and that nothing is written to stderr on success.
- **The module-to-daemon bridge:** the daemon answers the module's `$.http.fetch` calls on its Unix socket, re-spawns itself detached, lets only one instance bind the socket, takes every write, and exits a minute after the last local session stops pinging.
- **Vendored files:** `scripts/vendor.ts --check` fails when `vendor/VENDOR.json` disagrees with the pinned devDependencies or the file hashes; each vendored file loads in node.
- **CLI and commands:** `parseArgs` cases; every `/sub-human` verb against a temp home.

## 6. Network tests

Two homes run in one process (the POC's `two-homes` helper), connected by the `pipe` pathway, plus a local TLS + WebSocket front that stands in for tailscaled.

The tests cover:
- **Join:** invite line, Let in, and the link key bound. A wrong host key fails at the handshake, before the secret is sent.
- **Leaked line:** a second dial alerts the host, and the expected name is shown.
- **Kick:** the link is refused at once and the mirror stops.
- **Funnel hardening (D7):** PROXY-protocol sources each get their own connection cap. A scanner without the line's key fails at the first message. Nothing is spawned before the link key or MAC checks out.
- **Sync:** a snapshot plus the entries after it, for a late joiner; fork detection.
- **Reconnect** on the fake clock. A post is queued while offline and deduplicated by its client id on resend.
- **ssh pathway:** `ssh -W` to the loopback listener, with a fake `ssh` on `PATH` that execs a local socket bridge.
- **Tailscale control:** a fake `tailscale` binary (and a fake LocalAPI socket, if we use it) records commands. The tests cover Funnel and Serve, port 443 conflicts, and turning one forward off while another stays.

One manual check per release, not in CI: a real Funnel join from a machine with no Tailscale.

## 7. Canary (nightly)

`npm run canary` runs against Claude Code `latest` and `next` and checks:
- the contract probe;
- a diff of the hooks module typings against the snapshot;
- the module tests (layer 3) against the new binary;
- `claude plugin validate --strict`.

Failures are grouped by feature in `scripts/canary/last.json`; a person turns a broken feature off with `SUB_HUMAN_CC_OFF` until it's fixed.

## 8. Fixtures from real Claude Code

Stubs are only honest if their shapes are real.
- `test/fixtures/cc/<version>/` holds recorded payloads: tool results (Edit, Bash with `gitOperation`, TaskCreate, TaskUpdate, ExitPlanMode, AskUserQuestion answers), `session.send` calls, and hook stdin.
- They're recorded once per Claude Code version by a small capture script, as in the Q11 spike's `r1`–`r4` runs, using `claude -p` with a logging hook and the default model. That costs about $0.40 per refresh.
- The canary checks the fixtures against the typings.
- Unit and module tests import fixtures; they never build tool results by hand.

## 9. Live gate (per release)

These are real Claude sessions with the default model, never pinned, and their cost is recorded.
- **Workflows:** a no-plan pairing, a plan-then-build, and a non-code writing task, each run once per permission mode (default, acceptEdits, auto).
- **Injection scene:** a planted instruction travels through one Claude's direct message. The recipient must not run it unattended.
- **Deterministic checks**, from transcripts and the room log:
  - at most 6 plugin lines per person per scene (R41);
  - no wake from a broadcast;
  - no mode change;
  - the person's own plan file intact.
- **Product metrics**, from transcripts, compared against baselines and warning only:
  - injected tokens per turn;
  - the share of injected updates the receiving Claude used;
  - unprompted mentions of room content (derail rate);
  - tokens per hour spent on findings;
  - time from an interface change to the dependent Claude using it.
- **Budget:** a cost cap per run is set in `baselines.json`, and the run stops when it's hit.

## 10. Budgets and conventions

- The CI suite (layers 1–5) runs in under 60 s. There is no network beyond loopback, and no real Claude.
- Test code is no larger than runtime code (Q-3).
- Every PRD story has at least one module test (§4) and appears in the live gate: S-Live, S-Relevant, S-Ask, plan together, send a plan, split, join, remote join, leave.
- Tests narrow with `assert.ok` or `must(value, what)`; there is no `!`.
- A test that writes outside its temp home fails, which keeps the POC's "REAL CONFIG TOUCHED" guard.

## 11. By milestone, as built

What exists in 2.0.0, by the milestone that brought it. Node tests run with `npm run test:node`, kit tests with
`npm run test:module`, script tests with `npm run test:scripts`.

| Milestone | Tests that exist |
|---|---|
| M0 | `test/helpers.ts` (temp homes, the REAL CONFIG TOUCHED guard) and its test; `module/vendor-smoke.test.ts` and `test/vendor.node-test.ts`; `scripts/vendor.ts --check`; the fixtures recorder (`scripts/record-fixtures.ts`) and `test/fixtures/cc/2.1.330/`; the store contract on the memory, fs and mirror stores (`store/store-contract.node-test.ts`); `core/schema.node-test.ts` (with random JSON); `net/channel.node-test.ts` (cacophony and snow vectors); `core/cc/contract.node-test.ts` |
| M1 | `core/deliver`, `activity`, `secrets`, `fold`, `brief`, `mechanics`, `text` unit tests; kit tests for capture, follow, context, status and news, messages (with the sender-side risk test), wake, safety and tools; the scenes `s-live`, `s-relevant`, `s-ask`, `leave`; edge tests for the command hooks (`commands/hooks.node-test.ts`, `cli.node-test.ts`), the verbs (`bare`, `verbs`, `membership`), the bridge (`module/bridge.node-test.ts`) and the daemon (`net/daemon.node-test.ts`, `net/daemon/rooms.node-test.ts`); `store/fs-store`, `lock` and `store` tests |
| M2 | `core/plans.node-test.ts`; `module/plans.test.ts` (approval, cards, the pane, R19's properties on every flow); `plans-notes` and `plan-diff` unit tests; the scenes `plan-together`, `send-plan` |
| M3 | `core/tasks.node-test.ts` (rules and the bridge mapping); `module/tasks.test.ts` and `module/tasks.node-test.ts` on the recorded TaskCreate and TaskUpdate fixtures; the scene `split` |
| M4 | `core/link-engine.node-test.ts`, `core/protocol.node-test.ts`, `net/invite.node-test.ts`; two homes in `test/net/` (`join`, `host`, `reconnect`, `funnel` through a TLS + PROXY v2 front, `pathways` with the fake `ssh` and `tailscale` in `test/fixtures/bin/`); `module/admit.test.ts` |
| M5 | not yet: relevance tuning waits on live-gate metrics |
| M6 | the canary (`npm run canary -- latest`, nightly in CI on `latest` and `next`); the live gate and the manual Funnel join are the owner's, per release |

## 12. Requirements trace

Every P0 and P1 requirement of `docs/PRD.md`, and the tests that name it. A test names a requirement by its tag in
the test's own name (`… (R12)`); `node scripts/trace.ts` writes this table from those names, and `--check` fails
when it is stale. A requirement no test names is listed as uncovered.

<!-- trace:begin (node scripts/trace.ts writes this table) -->
| R | Priority | Requirement | Tests (file: names) |
|---|---|---|---|
| R1 | P0 | A room is not tied to a repo or directory | `commands/bare.node-test.ts`: “a bare /sub-human with no room open opens one, as the git name, with repo and branch (R1)”; “NAME and ROOM may be given, in either order (R1)”; “with several rooms open it lists them and joins none (R1)” |
| R2 | P0 | A room has a short human-readable code (e.g. vole-8126). Each member i | `commands/membership.node-test.ts`: “newCode is a word and four digits (R2)”<br>`net/daemon/rooms.node-test.ts`: “titleFor: NAME.CODE, else the lowest free NAME-N.CODE among the titles held (R5) (R2)”<br>`scripts/test/trace.test.ts`: “engine: ${r.name} (R2)” |
| R3 | P0 | /sub-human leave leaves the room and keeps the session | `commands/bare.node-test.ts`: “a room whose every member is away, or who left, is not open: a bare join opens a new one (R3)”<br>`commands/hooks.node-test.ts`: “SessionEnd posts no left: the pointer goes and the member is away; a session in no room writes nothing (R3)”<br>`commands/verbs.node-test.ts`: “leave writes left and an away presence, and forgets the session; another session as the name keeps it (R3)”<br>`net/daemon/rooms.node-test.ts`: “the sweep deletes a room or copy nobody has used for 30 days and no pointer or fresh handoff holds, with its link; the next ping says so once (R3)”<br>`test/net/join.node-test.ts`: “a copy the sweep deletes loses its link for good: closed, and its file gone (R3)” |
| R4 | P0 | /sub-human who lists the members, their machines and their state | `commands/verbs.node-test.ts`: “who lists the members here, their machines, state, focus and where they work (R4, R14); and when the host is away (R34)”; “help is at most six lines (R4)” |
| R5 | P1 | One person seated from two sessions or two machines counts once for ag | `commands/bare.node-test.ts`: “a second session as a name already here joins with no second joined, and the lowest free title (R5)”<br>`net/daemon/rooms.node-test.ts`: “titleFor: NAME.CODE, else the lowest free NAME-N.CODE among the titles held (R5) (R2)” |
| R12 | P0 | Activity | `core/activity.node-test.ts`: “an edit or write adds its repo-relative file to the activity document, once (R12)”; “a commit and a push are events from the Bash result's gitOperation (R12)”; “a test or build run is an event with whether it passed; other commands are nothing (R12)”<br>`module/capture.test.ts`: “a commit and a test run are activity entries, mine and labelled my Claude's (R12, R35)”; “a main turn marks me working and its end idle; a subagent's turn writes nothing (R12)” |
| R13 | P0 | Findings | `core/mechanics.node-test.ts`: “the mechanics stay within R42 for the longest name and say each mechanic once (R13)”<br>`module/tools.test.ts`: “share: a finding, a post to a member and my focus, each labelled my Claude's, each one line back (R7, R13, R14, R35)” |
| R14 | P0 | Working-on | `commands/verbs.node-test.ts`: “who lists the members here, their machines, state, focus and where they work (R4, R14); and when the host is away (R34)”<br>`module/tools.test.ts`: “share: a finding, a post to a member and my focus, each labelled my Claude's, each one line back (R7, R13, R14, R35)” |
| R14a | P0 | Sharing is on whenever you're in a room | `core/activity.node-test.ts`: “an edit outside the repo, of a secret file or of an ignored one is never shared (R14a)”<br>`core/secrets.node-test.ts`: “every sample of the must-refuse corpus is refused, and every rule refuses one (R14a)”; “secret files, ignored files and paths outside the repo are refused; the rest pass (R14a)”<br>`module/capture.test.ts`: “a secret in a commit message is never shared (R14a)”<br>`module/tools.test.ts`: “share refuses a secret, a member nobody is, and a session in no room; nothing is written (R14a)” |
| R15 | P0 | Real time | `test/scenes/s-live.test.ts`: “a relevant colleague change reaches my next prompt, capped (R15, R15a)” |
| R15a | P0 | To their Claude, as context, pushed only when relevant | `core/deliver.node-test.ts`: “the context cap: about 400 tokens, datamarked lines, lowest-value and oldest dropped first (R15a)”<br>`module/follow.test.ts`: “the context is capped and each line datamarked; a forged mark is defused (R15a)”<br>`test/scenes/s-live.test.ts`: “a relevant colleague change reaches my next prompt, capped (R15, R15a)” |
| R15b | P0 | To the person, ambiently | `module/status.test.ts`: “the status line names who is here, what they work on, and counts updates (R15b)”; “news opens a pane of what each colleague changed and found, clears the count, and starts no turn (R15b)”<br>`test/scenes/s-relevant.test.ts`: “a line naming me, or a file I edited, reaches my Claude and is drawn; a colleague's unrelated line is only counted (R15b, R15c)” |
| R15c | P0 | Relevance | `core/deliver.node-test.ts`: “relevance (R15c): context only for what bears on my work; the rest is counted, not pushed”<br>`test/scenes/s-relevant.test.ts`: “an interface named in a plan I'm on reaches my Claude in full; an unrelated update is only counted (R15c)”; “a line naming me, or a file I edited, reaches my Claude and is drawn; a colleague's unrelated line is only counted (R15b, R15c)” |
| R15d | P0 | Overlap heads-up, the main push signal (Q15): when two members edit th | `core/deliver.node-test.ts`: “overlap (R15d): a colleague editing a file I edited recently, or one a plan I am on names, is an urgent context item”<br>`module/context.test.ts`: “an overlap heads-up rides the next tool result of a running loop, once, and not a subagent's (R15d)” |
| R16 | P0 | Catch-up | `core/brief.node-test.ts`: “the catch-up: who is doing what, plans, open tasks, then updates newest first (R16)”; “bounded by maxChars, cutting whole lines from the end, and deterministic (R16)”<br>`module/tools.test.ts`: “read: the brief and plan text framed as data, and since gives what came in once (R16)” |
| R6 | P0 | Claude-to-Claude questions use native SendMessage addressed NAME.CODE | `module/context.test.ts`: “every prompt carries the session title its join gave it (R6)”<br>`module/messages.test.ts`: “a message to a colleague's Claude is answered delivered, carried stamped with me, and never logged (R6)”<br>`net/daemon/rooms.node-test.ts`: “messages go to inboxes by session and room, never the log, and are taken once (R6)”<br>`test/net/join.node-test.ts`: “writes go to the host and come back: posts, documents, plans, tasks; a message reaches only its member (R6, R28)”<br>`test/scenes/s-ask.test.ts`: “my Claude asks bob's for a fact; his answer wakes mine after my turn, with one line for me (R6, R10)” |
| R7 | P0 | A Claude can post to the room with the share tool's post op | `module/tools.test.ts`: “share: a finding, a post to a member and my focus, each labelled my Claude's, each one line back (R7, R13, R14, R35)” |
| R8 | P1 | @room TEXT posts the person's exact words, with no model turn | **uncovered** |
| R10 | P0 | Wake rule | `core/deliver.node-test.ts`: “broadcasts never wake: findings, posts, activity, plans, decisions, joins and tasks (R10)”; “the three wakes: a person's line naming me, a direct message, an answer to my Claude's open question (R10)”; “a wake is framed as a colleague's request, datamarked, and draws one line (R10, R11)”; “one wake per sender burst or question: what follows within the burst rides along as context (R10)”; “the hourly wake budget: past it, wakes become unread lines (R10)”; “a Claude's message carrying a command or URL is drawn for the person, never submitted (R10, R38)”<br>`module/safety.test.ts`: “a colleague's Claude's broadcast that names me and says to run something wakes nobody (R10)”; “a direct message carrying a command or URL is drawn for the person, never submitted (R10, R38)”; “a direct "the shape changed, update your side" wakes once, framed to change only my own work (R10, R11)”<br>`module/wake.test.ts`: “a direct message wakes my Claude once, after my turn ends, framed as data from the colleague's Claude (R10)”; “a person's line naming me wakes my Claude; one naming nobody does not (R10)”<br>`test/scenes/s-ask.test.ts`: “my Claude asks bob's for a fact; his answer wakes mine after my turn, with one line for me (R6, R10)” |
| R11 | P1 | A Claude woken by a question, from a person's line or from a colleague | `core/deliver.node-test.ts`: “a wake is framed as a colleague's request, datamarked, and draws one line (R10, R11)”<br>`module/safety.test.ts`: “a direct "the shape changed, update your side" wakes once, framed to change only my own work (R10, R11)” |
| R17 | P0 | A plan is a named, versioned Markdown document held by the room | `core/plans.node-test.ts`: “edit is compare-and-swap on base; a stale edit is refused and latestVersion gives what to merge (R17)”<br>`module/plans.test.ts`: “plan tool: edit is compare-and-swap; a stale base is refused with the current text, as data and no error (R17)”<br>`net/daemon/rooms.node-test.ts`: “plans: CAS on base, a stale edit names the latest, and the last answer decides and makes owned tasks (R17, R20)” |
| R18 | P0 | People write plans in Claude Code's native plan mode, exactly as they  | `module/plans.test.ts`: “at approval the person is asked once: keep it, a room plan, or send it; keeping it shares nothing (R18, R19)”; “the next version of a room plan this session stored asks nothing: one line, and the same people asked again (R18, R19)” |
| R19 | P0 | Three properties hold for every plan feature | `module/plans.test.ts`: “at approval the person is asked once: keep it, a room plan, or send it; keeping it shares nothing (R18, R19)”; “the next version of a room plan this session stored asks nothing: one line, and the same people asked again (R18, R19)”; “a plan I am asked about is a card at my turn's end; Agree is recorded, and my part reaches my next prompt (R19, R21, R22a)”; “a save the daemon can't take is an answer for Claude, never a red error (R19)” |
| R20 | P0 | A shared plan can mark parts with an owner, e.g. a @jess line, or an o | `core/plans.node-test.ts`: “parts: a heading or list item naming a member owns it; the rest is forgiven (R20)”; “an agreed version claims parts for owners who agreed; anyone else gets an open task with their name (R20)”<br>`net/daemon/rooms.node-test.ts`: “plans: CAS on base, a stale edit names the latest, and the last answer decides and makes owned tasks (R17, R20)”<br>`test/scenes/split.test.ts`: “an agreed plan splits into tasks by owner, and my Claude knows its part and who owns the rest (R20, R22a)” |
| R21 | P0 | Asking for agreement names the people and one exact version | `core/plans.node-test.ts`: “answers count for one version; a new version supersedes open asks; everyone named answering decides (R21, R22)”<br>`module/plans.test.ts`: “a plan I am asked about is a card at my turn's end; Agree is recorded, and my part reaches my next prompt (R19, R21, R22a)”; “ask for changes: text typed under Other is the note; the label asks for the note on a second card (R21, R22)”; “Read the full plan opens a pane with the diff and the whole text; taller than its window, and its button asks again (R21)”<br>`test/scenes/plan-together.test.ts`: “one shared plan, asked, changed, agreed for its exact version; then my Claude knows its part (R21, R22, R22a)” |
| R22 | P0 | Answers apply to one version only | `core/plans.node-test.ts`: “answers count for one version; a new version supersedes open asks; everyone named answering decides (R21, R22)”<br>`module/plans.test.ts`: “ask for changes: text typed under Other is the note; the label asks for the note on a second card (R21, R22)”<br>`test/scenes/plan-together.test.ts`: “one shared plan, asked, changed, agreed for its exact version; then my Claude knows its part (R21, R22, R22a)” |
| R22a | P0 | Once a version is agreed, each owner's Claude gets its part as context | `module/plans-notes.node-test.ts`: “partsNote: my part and the rest inside the one datamark; a forged label defused; the text cut at its cap (R22a)”<br>`module/plans.test.ts`: “a plan I am asked about is a card at my turn's end; Agree is recorded, and my part reaches my next prompt (R19, R21, R22a)”<br>`test/scenes/plan-together.test.ts`: “one shared plan, asked, changed, agreed for its exact version; then my Claude knows its part (R21, R22, R22a)”<br>`test/scenes/split.test.ts`: “an agreed plan splits into tasks by owner, and my Claude knows its part and who owns the rest (R20, R22a)” |
| R22b | P0 | Sending packs the plan with what the recipient's Claude needs to act o | `core/plans.node-test.ts`: “send packs a version for one member or the room; the recipient accepts, dismisses or asks for changes (R22b, R22c)”<br>`module/plans.test.ts`: “send packs the plan with my branch, the files I touched and a note; a typed name sends it to them (R22b)” |
| R22c | P0 | The recipient sees one line (jess sent you plan api-store v1) and open | `core/plans.node-test.ts`: “send packs a version for one member or the room; the recipient accepts, dismisses or asks for changes (R22b, R22c)”<br>`module/plans.test.ts`: “a plan sent to me is one line, then a card; accepting it puts it, its branch, files and note in my Claude's context (R22c)”<br>`test/scenes/send-plan.test.ts`: “a plan sent to me: one line, the card, the full plan in the pane, then Accept gives my Claude the whole plan (R22c)” |
| R22d | P1 | A sent plan can be agreed instead of merely accepted | **uncovered** |
| R22e | P1 | Two people can each send their own plan for the same piece of work, an | **uncovered** |
| R23 | P0 | Personal native task changes are mirrored to the room as activity, fro | `core/activity.node-test.ts`: “a personal task change is an event; a room task (tagged) is the bridge's, never activity (R23)”<br>`module/capture.test.ts`: “a personal task finished is an activity entry, named by the subject its create carried (R23)” |
| R24 | P0 | The room task list | `commands/verbs.node-test.ts`: “tasks lists the open tasks with owners and blockers, and counts the done ones (R24)”<br>`core/tasks.node-test.ts`: “claim is for oneself, refused while someone else owns the task (R24)”; “release and done are the owner's only; done keeps an optional note (R24, R26)”<br>`module/tasks.test.ts`: “the task tool adds, claims, lists and finishes room tasks, each in one line (R23a, R24)” |
| R24a | P0 | Bridge into the native list | `core/tasks.node-test.ts`: “the bridge tag round-trips inside a native subject (R24a)”; “bridgeOp: completed is done, deleted is release, a reopen is nothing, untagged is activity (R23b, R24a)”<br>`module/tasks.test.ts`: “M3: a claimed room task goes onto my native list with its tag, and completing it there closes the room task (R24a)”; “deleting a tagged native task releases the room task; a subagent's call is mine (R23b, R24a)” |
| R25 | P1 | A room task can depend on others (blockedBy). When a task is done or r | `core/deliver.node-test.ts`: “plans, sent plans and tasks reach those they are about (R25)”<br>`core/tasks.node-test.ts`: “waitingOn lists the blockers not yet done (R25)” |
| R26 | P1 | "Done" takes an optional note, not required evidence | `core/tasks.node-test.ts`: “release and done are the owner's only; done keeps an optional note (R24, R26)” |
| R23a | P0 | The room list never depends on native tools | `module/tasks.test.ts`: “the task tool adds, claims, lists and finishes room tasks, each in one line (R23a, R24)” |
| R23b | P0 | Mirror from TaskCreate and TaskUpdate | `core/tasks.node-test.ts`: “bridgeOp: completed is done, deleted is release, a reopen is nothing, untagged is activity (R23b, R24a)”<br>`module/tasks.test.ts`: “deleting a tagged native task releases the room task; a subagent's call is mine (R23b, R24a)”; “after a /clear the map is gone; TaskList, asked before the update runs, finds the tag, so a deletion still releases (R23b)” |
| R28 | P0 | One host per room holds the authoritative log | `core/fold.node-test.ts`: “a snapshot plus the rest of the log folds to the same state as the whole log (R28)”<br>`test/net/join.node-test.ts`: “writes go to the host and come back: posts, documents, plans, tasks; a message reaches only its member (R6, R28)”; “a late joiner syncs from the snapshot and the lines after it, not the whole log (R28)” |
| R29 | P0 | Two pathways behind one transport layer | `test/net/funnel.node-test.ts`: “a join over Funnel: an https line, a WebSocket through the front, the joiner's address as its source (R29, R29a)”<br>`test/net/pathways.node-test.ts`: “ssh: a join over ssh -W reaches the host's loopback listener (R29, R29b)” |
| R29a | P0 | Tailscale, the default | `test/net/funnel.node-test.ts`: “a join over Funnel: an https line, a WebSocket through the front, the joiner's address as its source (R29, R29a)”; “the joiner's dialer goes through HTTPS_PROXY (R29a)”; “an upgrade with no PROXY header did not come through the forward, and is refused; with one it is answered (R29a)”; “each PROXY source has its own connection cap (R29a, R40)”<br>`test/net/pathways.node-test.ts`: “tailscale: Funnel publishes the listener on 443 with PROXY v2; Serve the same for the tailnet (R29a)” |
| R29b | P0 | ssh, for networks that block Tailscale | `commands/verbs.node-test.ts`: “doctor: node, the socket path, the module, the version checked on, every room log, sshd and Tailscale (R29b)”<br>`test/net/pathways.node-test.ts`: “ssh: the arguments name the listener and the joiner's own account, and never an option as the host (R29b)”; “ssh: a join over ssh -W reaches the host's loopback listener (R29, R29b)” |
| R29c | P0 | One encrypted, key-authenticated channel on every pathway | `net/channel.node-test.ts`: “Noise XK vectors (${file}): every message byte for byte, both sides (R29c)”; “channel: admit sees the joiner key and message 3 payload; both show one check string; messages both ways (R29c, R30)”; “channel: a wrong host key fails at message 1, before message 3 (and the MAC) is ever written (R29c)” |
| R30 | P0 | Invite and admission | `commands/verbs.node-test.ts`: “join: the line is dialled for this session as the git name, answered at once with the check (R30); none where modules are off (C1)”<br>`module/admit.test.ts`: “a joiner waiting: the card names them, their machine and the check; Let in is posted for this session (R30)”<br>`module/follow.test.ts`: “after /sub-human join, the pointer the daemon writes once let in is one line; a link that stopped is another (R30)”<br>`net/channel.node-test.ts`: “channel: admit sees the joiner key and message 3 payload; both show one check string; messages both ways (R29c, R30)”<br>`net/invite.node-test.ts`: “verify: a pending or used line dialled again is "again"; an expired or refused one is dead (R30)”<br>`test/net/join.node-test.ts`: “join: the line, the same check string on both sides, Let in, the link key bound, the room synced, the dialling session in it (R30)”; “the secret never reaches the log or the host's records (R30)”; “a name mismatch is on the card; Refuse kills the line (R30)”; “a leaked line dialled twice refuses both dials and alerts the host (R30)”; “a join that fails after Let in is the link's one stopped answer; the bare join it names then takes the place (R30)” |
| R31 | P0 | /sub-human kick NAME (host only) ends that person's access immediately | `commands/verbs.node-test.ts`: “kick removes a member for good; never yourself, nobody unknown, nobody twice (R31)”<br>`test/net/join.node-test.ts`: “kick: the link is refused at once and the mirror stops, for good (R31)” |
| R32 | P0 | Reconnect is handled by a pure, clock-injected state machine with back | `core/link-engine.node-test.ts`: “link engine: ${row.name} (R32)”<br>`test/net/reconnect.node-test.ts`: “offline: a person's post queues and is sent again under its id on reconnect; the host keeps one line (R32, R36)” |
| R33 | P0 | The protocol carries a version and capability list | `core/protocol.node-test.ts`: “negotiate: the highest shared version and the shared caps; on a skew, the side behind updates (R33)” |
| R34 | P1 | The host being away is visible to everyone ("host away") instead of sh | `commands/verbs.node-test.ts`: “who lists the members here, their machines, state, focus and where they work (R4, R14); and when the host is away (R34)”<br>`module/status.test.ts`: “a room whose host is away says so in place of who is here, whose presence can't be known (R34)”<br>`net/daemon.node-test.ts`: “a room hosted elsewhere goes to its link, whose host is away for now (R34)”<br>`test/net/reconnect.node-test.ts`: “the host restarts: links are told the host is away, and come back to the same listener (R34)” |
| R35 | P0 | Attribution is honest and plain | `core/fold.node-test.ts`: “posts and findings are kept as recent updates, labelled as written (R35)”<br>`module/capture.test.ts`: “a commit and a test run are activity entries, mine and labelled my Claude's (R12, R35)”<br>`module/tools.test.ts`: “share: a finding, a post to a member and my focus, each labelled my Claude's, each one line back (R7, R13, R14, R35)” |
| R36 | P0 | The log is append-only and hash-chained, with the host authoritative,  | `module/follow-lines.node-test.ts`: “a line that does not follow the head is a fork (R36)”<br>`net/daemon/rooms.node-test.ts`: “a retried append (same id) answers the first seq and hash and writes nothing, after a restart too (R36)”<br>`store/store.node-test.ts`: “verifyLines refuses a gap, a repeat, a bad prev and a line that is not JSON (R36)”<br>`test/net/reconnect.node-test.ts`: “offline: a person's post queues and is sent again under its id on reconnect; the host keeps one line (R32, R36)”; “a fork: a copy whose chain breaks is discarded for the host's snapshot and lines (R36)” |
| R37 | P0 | Each machine authenticates to the host with its own link key (R29c). T | `net/daemon/rooms.node-test.ts`: “the host refuses its own kinds, a stranger's line and a stranger's document (R37)”<br>`test/net/host.node-test.ts`: “a call writes as the link's member in its own room only, and counts as an append (R37)”; “a document is the link's member's own; documents, messages and plan text are rate-limited (R37, R40)”<br>`test/net/join.node-test.ts`: “a dial with neither a known key nor the MAC touches nothing: no ask, no record (R37)” |
| R38 | P0 | Security never depends on parsing Bash | `core/deliver.node-test.ts`: “a Claude's message carrying a command or URL is drawn for the person, never submitted (R10, R38)”<br>`module/safety.test.ts`: “a direct message carrying a command or URL is drawn for the person, never submitted (R10, R38)” |
| R39 | P0 | No hook answers a permission check with allow | `scripts/test/directory-lint.test.ts`: “MOD_PERMISSION_ANSWER_UNREAD: a spread, a computed key, a method, allow, a call or a variable in an answer (R39)”; “MOD_PERMISSION_ANSWER_UNREAD: tool.check and classic.PermissionRequest hooks are refused outright (R39)” |
| R40 | P1 | Per-link rate limits on a few write operations, instead of an 11-row q | `test/net/funnel.node-test.ts`: “each PROXY source has its own connection cap (R29a, R40)”<br>`test/net/host.node-test.ts`: “a document is the link's member's own; documents, messages and plan text are rate-limited (R37, R40)”<br>`test/net/join.node-test.ts`: “a link's appends are rate-limited per minute (R40)” |
| R41 | P0 | Line budget | `module/follow-lines.node-test.ts`: “toDraw: the most valuable and newest first, three between prompts, then one line for the rest, once (R41)”<br>`module/follow.test.ts`: “a burst draws at most three lines, newest first, then one line for the rest (R41)” |
| R42 | P0 | The Claude's injected instructions cover only mechanics, are at most a | `core/mechanics.node-test.ts`: “the mechanics stay within R42 for the longest name and say each mechanic once (R13)”<br>`module/context.test.ts`: “the mechanics go with the first prompt alone, within R42, and never with a slash command” |
| R43 | P0 | One speaker (sub-human:), past-tense events, and errors written as "wh | `commands/bare.node-test.ts`: “refusals: an unknown room, no name, a bad name, two names, a kicked name (R43)”<br>`commands/hooks.node-test.ts`: “the /sub-human expansion blocks with the answer as one line for the person (R43)” |
| R44 | P0 | Glossary of at most 10 user-facing terms, used the same way in code, d | `test/copy.node-test.ts`: “no engineering term in a string a person can read, or in the README (R44)” |

Uncovered: R8, R22d, R22e.
<!-- trace:end -->
