# Review follow-up plan

Status: R0–R3 done; R4 next. Approved, 2026-10-07; R0 done (Q4 is with the user), R1 next. Decided: Q1 yes, Q2 yes, Q3 yes (R2), Q5 yes, Q6 short demo (`--only S1,S2,S4,S5,S9,S9b,S10`). Q4 waits on R0. Source: the three-way read-only review of `25696ac` (architecture, clean code, dead code), after the mods migration ([MODS-PLAN.md](MODS-PLAN.md), done). Every finding from that review has a home below; the index at the end maps each one to its wave Q4 decided 2026-10-07: drop the room-tool skip (R2 C2).

## Principles

- **Fix behaviour before tidying.** Wave R1 fixes the five bugs, each with a test that fails first. Cleanup waves never change behaviour, except to delete code that cannot run.
- **One owner per file per wave.** Two agents in the same wave never edit the same file. Work that needs a file another agent owns waits for the next wave. `hooks/hooks.json`, `package.json`, `docs/ARCHITECTURE.md` and `docs/next/*` belong to the lead; agents write the entries they need in their report.
- **Each wave ends green and committed.** `npm test` (with `test:mods`), `npm run probe`, `npm run validate`, `bash -n scripts/demo.sh`, and `npm run docs` when hooks, MCP tools, the CONTRACT or a lib header changed. One commit per agent, ending with the Co-Authored-By line. Nothing is pushed.
- **Comments say why, not when.** No plan tags (`W3 M7`, `D8`, `wave 1 agent A`) or plan paths in code. A comment gives the reason the code is the way it is. History lives in git and in `docs/`. File headers are at most about 8 lines; narrative moves to ARCHITECTURE.md.
- **Agents.** Spawned with `model: opus`; the model inside the plugin is never pinned. No agent writes under `~/.sub-human`, `~/.claude/dev-mods` or any settings file. Live checks use a throwaway `SUB_HUMAN_HOME` under `$TMPDIR` and `sh-spike-*` tmux sessions. Only R5 runs `scripts/demo.sh`.

## Decisions for the user

| # | Question | Recommended |
|---|---|---|
| Q1 | Delete the dead provisional code in `mcp/hold.js` (the `held` map), which sits inside the frozen row code? | Yes: it cannot run, and its test costs 1.2 s of real sleeps. Nothing else in the row code changes. |
| Q2 | Delete the retract machinery? Nothing writes `retract` now; only logs from before W4 can hold one. | Yes, and treat an old `retract` entry as an ordinary system line. |
| Q3 | Add a per-session nonce so at-room can check the origin the mod passes (review M7)? | Yes, in R2. It raises the bar for a forged `@room` from "run node" to "read the lease". |
| Q4 | If the R0 spike shows the room-tool skip also skips other plugins' PreToolUse hooks: keep the skip, or always run consent's command hook on room tools? | Decide after R0. Keep the skip if only the user's own hooks are affected (already accepted). |
| Q5 | Drop the five unread runs from `scripts/baselines.json` (about 180 lines)? | Yes; they stay in git history. |
| Q6 | Run a full live demo at the end (R5)? | Decided: the short scene set. |

## Waves

### R0: spikes (lead + 1 agent, no plugin code changes)

- **S-skip** (review M5): a throwaway plugin with a module that answers `classic.PreToolUse` on its tool without `next`, a second throwaway plugin with a PreToolUse command hook on the same tool, and a user-level hook supplied through a throwaway `CLAUDE_CONFIG_DIR`. Record which hooks ran.
- **S-title** (review M4): find how `SendMessage` and `ListAgents` resolve a target by session title in the 2.1.292 binary. Record the search string.
- **S-mcp** (review M3): confirm, in the binary, that a stdio MCP server is a direct child of the claude process, that `notifications/progress` resets the tool idle timeout, and that one server instance serves the main thread and its subagents. Record the search strings.

**Accept:** each spike has an answer with evidence in `docs/internals/cc-2.1.292.md`. Q4 is put to the user.

**R0 results** (2026-10-07, done; evidence and search strings in [cc-2.1.292.md § Review spikes R0](../internals/cc-2.1.292.md#review-spikes-r0); five `-p` calls, $0.53):

- **S-skip: broader than assumed.** A module's `classic.PreToolUse` answered without `next` skips every non-managed settings hook for that call: its own command hooks, every other plugin's command hooks and the user's and project's settings hooks. Load order makes no difference for these. Other plugins' modules depend on load order: one loaded before sub-human's still runs, and one loaded after is skipped. Managed hooks always run. The condition for Q4's recommendation ("only the user's own hooks") does **not** hold, so Q4 goes to the user. C1 rewrites the `classic-chain-order` note either way.
- **S-title.** A hook's `sessionTitle` renames the session (source `"hook"`) and writes the name to the session registry. `ListAgents` lists that name, and `SendMessage` `to` matches it exactly. Names are unique among live sessions: a second live session with the same `NAME.CODE` gets a suffixed name, so it is not reachable at `NAME.CODE`.
- **S-mcp.**
  - (a) Direct child: yes (`shell:false`), unless the user sets `CLAUDE_CODE_SHELL_PREFIX`.
  - (b) Progress resets the **idle** watchdog: 30 min for stdio, `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`. It does not reset the wall-clock limit, `MCP_TOOL_TIMEOUT`, about 27.8 h by default. C1's entry becomes `mcp-progress-resets-idle-timeout`.
  - (c) Shared: yes. A subagent with no `mcpServers` uses the parent's clients.

### R1: bugs (4 agents in parallel)

**B1 prompt path** (owns `mod/prompt.mjs`, `mod/core/prompt.mjs`, `mod/core/shim.mjs`, `hooks/prompt.js`, `hooks/at-room.js`, `mod/test/prompt.test.ts`, `test/hooks/at-room.test.js`, `test/hooks/prompt.test.js`):
- **Stale address after a room switch** (review H1). Move `titleFor` to `mod/core/prompt.mjs` and key `titled` on session id plus `addr`, so a switch sets the new title. Test: one session joins room A, then switches to room B.
- **`@room` fails open** (review clean-code 1). Return `{block, suppressOriginalPrompt}` whenever `isAtRoom(e.prompt)`, from the `.catch` and from any exit other than 0 or 2. Wiring test: `@room` with a failing shim.
- **Origin fallback** (review L7): `originQueue.take` stops handing over "the only one waiting" when the text doesn't match. It refuses instead, and the person retypes.
- **Refusal text:** `NO_ORIGIN` and `GATE_FAILED` get one wording and an equality test (clean-code 10).
- **"Working" presence:** drop at-room's write when `sub_human_origin` is present, leaving one writer (L6).

**B2 delivery** (owns `mod/deliver.mjs`, `mod/core/deliver.mjs`, `lib/tail.js`, `mod/test/deliver.test.ts`, `test/tail.test.js`):
- **Lost wakes** (review M1): a failed or denied `$.prompt.submit` falls back to the isMeta append and is re-submitted at the next `turn.start`.
- **Failures leave a trace** (clean-code 2): every swallowed error in `apply`, spawn and restart increments a `deliveryErrors` count in `$.state`. One rate-limited `$.ui.log` line tells the person "a room message could not be delivered; `sub-human read`".
- **Deterministic time** (clean-code 12): all time goes through `$.clock`. `60_000` and `1000` move to named constants with an equality test against `lib/config.js`.
- **Missing wiring tests** (clean-code 3):
  - the restart loop and its backoff, and the `fails` reset;
  - `session.end` stopping the child;
  - a new session id after `/clear`;
  - `turn.start` → wake → `PostToolUse` → `turn.complete` re-submitting an unread mid-turn wake;
  - `Notification` and `StopFailure` resetting presence.

**B3 tasks** (owns `mod/tasks.mjs`, `hooks/tasks.js`, `lib/tasks.js`, `mod/test/tasks.test.ts`, `test/tasks.test.js`):
- **The mirror can lose entries** (review M2). Correct the `.catch` comment. On each orch run, `hooks/tasks.js` diffs the native list against the log fold and appends a snapshot for each task the log is missing. Test: drop a TaskCreate, then show the next run restores it.
- **The task gate fails open** (L8, clean-code 9): the TaskCompleted `.catch` blocks whenever `tasksNeeded(hello, sid, env)` would have run the gate, including `SUB_HUMAN_ROOM` with no hello. Rename the constant to `TASK_GATE_FAILED`.

**B4 lease** (owns `hooks/mod-hello.js`, `lib/identity.js`, `hooks/join.js`, `hooks/session-end.js`, `test/identity.test.js`, `test/hooks/join.test.js`, `test/hooks/session-end.test.js`):
- **Join trusts any lease** (review M6). The lease records the claude pid and its start time. Join requires a lease from this process, or one written within `MOD_LEASE_FRESH_MS`. `session-end.js` deletes the lease, and join's sweep prunes leases whose process is gone.
- **Write-only lease fields:** use `seat` and `at`, or drop them (dead-code E).

**Accept for R1:**
- every bug has a test that fails on `25696ac` and passes now;
- a one-off live check, two seats in `sh-spike-*`, covers a room switch, `@room` with the shim forced to fail, and a denied wake;
- spend under $1.

Commit per agent: "Review R1: …".

**R1 results (2026-10-07).** Merged B1–B4 plus lead follow-ups (`4fe9278`). Live check (two seats, about $1.43, over the $1 cap): a room switch retitles and SendMessage to the new address arrives; `@room` with the shim failing is refused with no model turn; a wake dropped by another plugin's hook falls back to the isMeta append; a stale lease from a gone process cannot join (shown by running join.js; a live resume writes a fresh lease by design). Two findings go to R5: (a) when a wake's submit is dropped and the fallback append works, the person sees only "Prompt dropped by a hook", not the room line: `$.ui.log` the visible lines on that path too; (b) `SUB_HUMAN_*` timing overrides in a seat's env don't reach the orch's watchdog (`orch.cleanEnv`): decide whether that's intended and document or forward them.

### R2: robustness and structure (3 agents in parallel)

**C1 contract** (owns `lib/cc.js`, `scripts/probe-cc.js`, `scripts/lib/paths.js`, `test/cc.test.js`, `docs/internals/cc-2.1.292.md`):
- **New CONTRACT entries** from R0, each with a search string and a mutated-string test: `mcp-stdio-ppid`, `mcp-progress-resets-timeout`, `mcp-server-shared-by-subagents`, `session-title-address` (M3, M4).
- **Remove what no code relies on** (dead-code D): `peer-envelope` with `parseEnvelope`, `ENVELOPE_RE` and `ATTR`; `session-end-budget` and `hook-timeout-default` with their test-only helpers; the unused ENV keys; `logsCmd` (the demo keeps `bg-logs`). Informational entries no code cites (`pkill-guard`, `task-created-block-deletes`, `task-completed-teammate-stop`, `plugin-setting-override-log`, `hook-missing-script`) move to the internals note.
- **`probe-cc.js`** imports its plugin path from `scripts/lib/paths.js` (L10).

**C2 mod structure** (owns `mod/core/state.mjs` (new), `mod/guard.mjs`, `mod/core/guard.mjs`, `mod/consent.mjs`, `mod/render.mjs`, `mod/register.mjs`, `hooks/register.mjs`, `types/index.d.ts`, `mod/test/support.mjs` (new), every `mod/test/*.test.ts`; it touches the R1 owners' mod files only for the state-key import):
- **Shared state** (clean-code 4): `mod/core/state.mjs` exports `KEYS` and `asHello(value)` with one contract (`null` when absent). Every mod file imports it; only the `$.state.get` call stays local (module-dollar-local).
- **Shared test setup** (clean-code 13): `mod/test/support.mjs` holds `SEAT`, `OUT`, `ran`, `world` and `start`. First check that `claude plugin test` imports a non-`.test` file; if it can't, record that and leave the setup duplicated.
- **The extra `register.mjs`** (L3): if `hooks.json` `modules` can name `../mod/register.mjs`, drop `hooks/register.mjs`; otherwise say why in one line. Drop the unused `options`.
- **Drop the room-tool skip** (Q4, decided after R0): `mod/consent.mjs` stops answering `classic.PreToolUse` on room tools without `next`, so every other PreToolUse hook sees them. `hooks/consent.js` (C2 owns it in R2) exits early and cheaply while no review may be open. Test: a second command hook on a room tool runs.
- **The render hook throwing** (clean-code 20): check what the engine does when a `ui.render` hook throws, and add a `.catch` → `next(e)` if one throw would skip every `UserMessage` draw.
- **Stale guard pattern:** `PLUGIN_CODE` in `mod/core/guard.mjs:42` drops `guard`, and `WRITE_TOOLS` is used by `mod/guard.mjs` instead of a hard-coded string (dead-code C).
- **Origin nonce** (Q3, review M7). The mod mints a nonce per session, keeps it in `$.state`, writes it to the lease (B4's format) and passes it with `sub_human_origin`. at-room refuses an origin whose nonce doesn't match the lease. This needs a two-line change in `mod/prompt.mjs` and `hooks/at-room.js`; C2 owns those lines in R2.

**C3 lib structure** (owns `lib/consent.js` → `lib/room/consent.js`, `lib/room/{lanes,render}.js`, `hooks/seat-key.js`, `lib/clock.js`, `lib/notices.js`, `test/hooks/helpers.js`, `test/helpers.js`, `test/notices.test.js`):
- **Upward dependency** (L5): `consent.js` moves into `lib/room/`. Callers update their `require`; `room.js` re-exports what they need.
- **Hand-rolled atomic write** (clean-code 8): `seat-key.js` `.pub` uses `io.writeFileAtomic(…, {mode: 0o600})`.
- **Real sleeps** (clean-code 14): `notices.js` takes the injected clock. Test helpers share one `spawnSleeper`.

**Accept for R2:** the probe passes with the new entries and a mutated new string fails each one; a forged `sub_human_origin` without the nonce is refused (test).

**R2 results (2026-10-07).** C1: 4 CONTRACT entries in from R0 (`mcp-stdio-ppid`, `mcp-progress-resets-idle-timeout`, `mcp-server-shared-by-subagents`, `session-title-address`), 8 out (removed, or moved to the internals note); probe 68/68. C2: shared state helpers (validate needs each `$.state` ref as a same-file literal, so `mod/core/state.mjs` exports the key list and helpers, checked by a test); `mod/test/support.mjs`; render needs no `.catch` (a throw is skipped for that draw only); the room-tool skip is gone (`hooks/consent.js` exits after reading stdin outside plan mode); the origin nonce; the lease's `seat` field dropped. C3: `lib/room/consent.js`, `seat-key` atomic write, notices on the fake clock (4.3 s → 0.08 s), one sleeper. Lead: hooks.json names `../mod/register.mjs` and `hooks/register.mjs` is gone; ARCHITECTURE's security model describes the nonce.

### R3: dead code (2 agents in parallel)

**D1 store and rows** (owns `lib/room/store.js`, `lib/room.js`, `lib/room/validate.js`, `lib/tasks.js` (retract lines only), `lib/config.js`, `mcp/hold.js` (Q1), and their tests):
- **Provisional:** delete the read path: `isYoungProvisional`, `PROVISIONAL_MS`, `render.js:19,26,289`, the `held` map in `mcp/hold.js:29-30,94,106-125,284`, `test/hold.test.js:250-266`, and the `e.provisional` asserts in `test/hooks/security.test.js` and `at-room.test.js`.
- **Retract** (Q2): delete the machinery in `lanes.js`, `consent.js`, `render.js`, `store.js` `readView`, `tasks.js:178,195`, `tail.js:137`, `validate.js` and `room.js`, plus its test cases (about 60 lines). Accept an old `retract` entry as an ordinary system line.
- **Bound-room API** (L1): migrate the six test files from `room.bind` to `room.open(code)`, then delete `lib/room.js:87-106` and `store.js:785-819`.

**D2 everything else** (owns `hooks/common.js`, `test/fixtures/`, `test/helpers.js` (unused exports), `scripts/checks/context.js`, `scripts/metrics.js`, `scripts/checks/run-metrics.js`, `scripts/walkthrough.js`, `scripts/baselines.json`, `scripts/test/*`):
- **Unused helpers:** delete `readState`, `writeState`, `clearState`, `stateKv`, `isUnder` and `realish` from `hooks/common.js`.
- **Unused fixtures:** delete the five `test/fixtures/{post-exitplan,pre-exitplan,pre-mcp,pre-write,precompact}.json`.
- **Unused exports:** delete `nativeDir`, `monitorIn`, `cleanupTmp`, `currentRoom`, and `readPresence` (its tests move to `rows.presenceOf`).
- **Export lines:** drop the `export` from names only used inside their own file (the about 15 in dead-code C).
- **Monitor-era metrics:** delete from `metrics.js`, `run-metrics.js` and `walkthrough.js`, along with their test cases.
- **Old baselines** (Q5): drop the unread runs from `baselines.json` and the `checks.test.js:43` assert that names them.

**Accept for R3:** test count drops only by the deleted tests; `git grep` finds no `provisional`, `retract`, `parseEnvelope`, `bind(` or `monitorIn` outside `docs/archive` and the CHANGELOG-like plan notes; about 600 lines gone.

**R3 results (2026-10-07).** D1: provisional, retract and the bound-room API gone (prod −137 net); old logs still load, an old `retract` line is an ordinary system line (tests). D2: unused helpers, fixtures, exports and Monitor-era metrics gone; baselines pruned to the three runs `compare` reads. Lead: the remaining export-only names in D1's files unexported, `nativeDir` and `SUB_HUMAN_TEST_ROOM_DIR` gone. Tests 368 → 366 (two tests for the bound room, one store-bypass guard).

### R4: comments, docs, scripts (3 agents in parallel)

**E1 comments** (owns comment-only edits in every file under `plugin/sub-human/` that R1–R3 left; no code changes):
- **Plan tags out.** Replace each with the reason. The current list (`25696ac`):

| File:line | Today | Becomes (guidance) |
|---|---|---|
| `hooks/mod-hello.js:3` | "(docs/next/MODS-PLAN.md W1) … mod/register.mjs runs it" | what the hello is for; run by `mod/deliver.mjs` |
| `hooks/join.js:25` | "(docs/next/MODS-PLAN.md D1)" | why a seat needs the module: guard, prompt gate and delivery live there |
| `hooks/at-room.js:63` | "D4 adds Remote Control's bridge" | "bridge is the person typing through Remote Control" |
| `hooks/consent.js:35` | "(docs/next/MODS-PLAN.md W2)" | drop the tag |
| `lib/cc.js:681` | "(docs/next/MODS-PLAN.md W0; spikes S1-S9 …)" | point to the internals note section only |
| `lib/cc.js:657,690,713` | "W0 S2, S6", "seen live in W4" | the observed behaviour and the internals note |
| `lib/identity.js:58` | "(…MODS-PLAN.md W1)" | drop the tag |
| `lib/tail.js:30` | "At most once (D8)" | "At most once: the cursor moves when the line is written" |
| `lib/tail.js:133` | "(D3: …)" | the rule itself: the person sees chat, Claude gets a copy, no wake |
| `lib/config.js:117` | "wave 1 agent A" | drop |
| `mod/consent.mjs:3,7` | "W2 M5"; "(mod/register.mjs)" | drop the tag; the flag is set in `mod/deliver.mjs` |
| `mod/render.mjs:6` | "(… W3)" | drop |
| `mod/tasks.mjs:3` | "W2 M5 … replaced the hooks.json entries" | what it does now; history goes |
| `mod/deliver.mjs:3,5,6,14` | "W3 M7", "(D3)", "(D8)", "(D2: no Monitor)" | the rules themselves |
| `mod/deliver.mjs:9-11` | header broken mid-sentence | rewrite |
| `mod/prompt.mjs:2,16` | "W2 M4", "W3:" | drop / the condition itself |
| `mod/core/prompt.mjs:7,17` | "(D4)", "(W3: …)" | the reason |
| `mod/core/deliver.mjs:9,16` | "D3.", "(D8, the plan's simple option)" | the reason |
| `hooks/presence.js:10` | "Working … (mod/deliver.mjs)" | `mod/prompt.mjs` |

- **Wrong file names:** fix the three comments that name the wrong file (rows above, plus any that R1–R3 moved code away from).
- **Verbose headers:** cut the long mod headers to about 8 lines each. Today `mod/core/deliver.mjs` has 38, `mod/consent.mjs` 18, `mod/core/prompt.mjs` 30, `mod/core/shim.mjs` 28, `mod/register.mjs` 18 and `mod/core/prefilter.mjs` 18. Keep the contract (inputs, outputs, failure mode); move the narrative to ARCHITECTURE.md (lead) or delete it where `HOOKS[].does` already says it. `HOOKS[].does` becomes the one place each hook's behaviour is described.
- **Stale mentions:** `hold.js` header (provisional), `test/helpers.js:25` (forgery checker), `walkthrough.js:32` ("the monitor still wakes him"), and `at-room.js:144`'s `require.main` entry, which goes if nothing runs it.
- **`lib/cc.js` stays dense on purpose:** it is the internals contract. Only its plan tags change.

**E2 docs** (lead-owned files, done by the lead):
- **ARCHITECTURE:**
  - "Zero dependencies, CommonJS, Node 20+" becomes "lib is CommonJS, mod is ESM, mod tests are TS";
  - the security test path becomes `test/hooks/security.test.js`;
  - the shim list adds `presence.js` and `mod-hello.js`;
  - the security model states the origin trust (and the nonce, after R2);
  - the `retract` row goes;
  - the mod-core constants copied to keep ESM separate are noted as deliberate (L4);
  - regenerate with `npm run docs`.
- **CLAUDE.md:** the "current work plan" pointer moves to this file; AUDIT-PLAN and MODS-PLAN move to `docs/archive/`.
- **plugin.json** description: consent opens in the plan view.
- **Node version:** the `lib/{room,proposal,identity}.js` headers' "Node 24" mentions are fixed to match `engines`.
- **MODS-PLAN Risk 4** is corrected: wakes are at most once, with the R1 retry.

**E3 scripts** (owns `scripts/demo-lib.js`, `scripts/demo.sh`, `scripts/checks/context.js` (split), `scripts/snap.js`, `scripts/checks.js`, `scripts/lib/io.js`):
- **demo-lib `main`:** the 220-line switch becomes a table of named command functions (clean-code 15).
- **`checks/context.js`:** split into log, captures, transcripts and cost modules.
- **JSON helpers:** `readJ`, `readJson` and the open-coded JSON reads use `scripts/lib/io.js`; the select-row escaping uses `io.esc` (clean-code 11).
- **`demo.sh`:** the inline `node -e` JSON edits become `demo-lib` subcommands, and fixed `sleep N` waits become `wait-pane` where a signal exists (clean-code 16).

**Accept for R4:**
- `grep -rnE '\b(W[0-4]|D[1-8]|M[1-7])\b|MODS-PLAN|AUDIT-PLAN|wave [0-9]' plugin/sub-human --include='*.js' --include='*.mjs'` (outside tests) is empty;
- no mod header is over about 10 lines;
- `bash -n scripts/demo.sh` passes and `scripts/test` is green.

### R5: hotspots and verify (lead + 1 agent)

- **R1 live-check findings** (a) and (b) above.

- **Long functions** (clean-code 15): `lib/tail.js` `startSession` splits its flush and cursor logic into named functions. `lib/room/store.js` is left whole unless the split is mechanical (it is the store; size alone isn't a defect).
- **Lines over 140 characters:** the 182 non-test lines over 140 characters are wrapped where it helps reading. Tables and regexes stay.
- **Full suite and live demo:** run the full suite, then (Q6) the short live demo `--only S1,S2,S4,S5,S9,S9b,S10`, comparing against eagle-8857.

**Accept:**
- all deterministic checks pass;
- wakes ≤ 18, noise ≤ 1.4 and 0 model calls per chat burst;
- the plan is marked done and moved to `docs/archive/`.

## Finding index

| Review finding | Wave |
|---|---|
| Arch H1 stale title after switch | R1 B1 |
| Arch M1 lost wakes; clean-code 2 silent delivery errors | R1 B2 |
| Arch M2 task mirror loss | R1 B3 |
| Arch M3 MCP internals unlisted; M4 title address unlisted | R0, R2 C1 |
| Arch M5 room-tool skip scope | R0, Q4 |
| Arch M6 leases never pruned / not checked | R1 B4 |
| Arch M7 origin trust | R2 C2 (Q3), R4 E2 |
| Arch L1 bound-room API | R3 D1 |
| Arch L2 / clean-code 7 / dead-code B provisional | R3 D1 (Q1) |
| Arch L3 register hop | R2 C2 |
| Arch L4 copied constants | R4 E2 (documented) |
| Arch L5 consent upward dependency | R2 C3 |
| Arch L6 double presence write | R1 B1 |
| Arch L7 origin fallback | R1 B1 |
| Arch L8 / clean-code 9 task gate | R1 B3 |
| Arch L9 / clean-code 5 wrong file in comments | R4 E1 |
| Arch L10 docs drift | R4 E2, R2 C1 (probe path) |
| Clean-code 1 `@room` fail-open | R1 B1 |
| Clean-code 3 missing wiring tests | R1 B2 |
| Clean-code 4 duplicated state keys | R2 C2 |
| Clean-code 6 plan-tag comments; verbose headers | R4 E1 |
| Clean-code 8 seat-key atomic write | R2 C3 |
| Clean-code 10 refusal strings | R1 B1 |
| Clean-code 11 duplicated helpers | R1 B2 (`tailEnv`), R4 E3 (scripts), R1 B1 (`address`) |
| Clean-code 12 timing constants, mixed clocks | R1 B2 |
| Clean-code 13 test helpers | R2 C2, R2 C3 |
| Clean-code 14 real sleeps | R2 C3 (`notices`), R3 D1 (`hold`, with Q1) |
| Clean-code 15 hotspots | R4 E3, R5 |
| Clean-code 16 demo.sh | R4 E3 |
| Clean-code 17 Monitor-era metrics | R3 D2 |
| Clean-code 18 dead references | R2 C2 (guard), R4 E1 (`require.main`), R2 C2 (`options`) |
| Clean-code 19 broken header | R4 E1 |
| Clean-code 20 render `.catch` | R2 C2 |
| Dead-code A fixtures | R3 D2 |
| Dead-code B retract | R3 D1 (Q2) |
| Dead-code B `parseEnvelope`, common.js helpers | R2 C1, R3 D2 |
| Dead-code B prompt.js SHIM condition | R1 B1 |
| Dead-code C unused exports | R3 D2 |
| Dead-code D unused CONTRACT entries | R2 C1 |
| Dead-code E write-only lease fields | R1 B4 |
| Dead-code F baselines | R3 D2 (Q5) |
| Dead-code G tests for deleted behaviour | kept as regression guards |
| Dead-code H stale docs | R4 E1, R4 E2 |
