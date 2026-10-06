# Audit implementation plan

Status: proposed, 2026-10-06. Sources:
- the five-way audit (best practices, architecture, clean code, robustness, tests and docs);
- the binary read of Claude Code 2.1.281, kept at `docs/internals/cc-2.1.281.md`.

## Principles

- **Internals are allowed.** We treat the binary as documentation. Every internal the plugin relies on is listed in one module, `lib/cc.js`. Each entry gives the literal search string that finds it in the binary. A probe greps the installed binary for every search string, so a Claude Code update that breaks an assumption fails loudly at test time, not in a live room.
- **Keep behaviour the same unless a finding says otherwise.** Each wave ends with the full tests green, `claude plugin validate --strict` passing and a commit. The final wave adds a live demo run with metrics compared against swan-6397.
- **Each file has one owner per wave.** Two agents in the same wave never edit the same file. `hooks/hooks.json` belongs to D in wave 1. After that, agents write the entries they need in their report and the lead merges them.
- **Waves build on each other.** Wave 0 lays the foundation (shared helpers, the `room.js` split behind a facade, the cc contract, test infrastructure). That foundation is what lets wave 1 run five agents in parallel without colliding.

## Corrections from the binary

These replace the audit's guesses:

| Audit said | Binary says | Plan change |
|---|---|---|
| The TaskCompleted gate is ignored for TaskUpdate | Honoured. The whole TaskUpdate call fails with `success:false`, and **every field in that call is dropped**, not only the status | Keep the gate. Tell the orch to send a status change in a call of its own. Store the req id in task `metadata`, not in description text |
| The objection note needs prose parsing | The transcript message has a structured `userFeedback` field. No hook carries it | `cc.planFeedback(transcript)` reads `userFeedback` |
| The orch may not get the task list id | The daemon filters the caller's env to an allowlist, but `orch.js` already passes the id through `--settings` env | Verify it with the probe. Make `KEEP_ENV` match the daemon's allowlist (provider, auth, proxy, `CLAUDE_CONFIG_DIR`) |
| The job id is parsed from `--bg` stdout | `claude agents --json` returns pid, id, sessionId and status | `cc.jobs()` uses `agents --json`. The stdout regex becomes the fallback |
| Matcher semantics were unclear | `[A-Za-z0-9_\|]` only means an exact-name list; anything else is an unanchored regex | Anchor the two `.*` matchers |
| SessionEnd hook timing | It gets 1.5 s unless the hook sets `timeout` (cap 60 s) | `timeout: 5` |
| The monitor is restored on resume | True. But a monitor that exits is **never re-armed** in that process | The tail must not exit: it supervises itself and recovers from errors |
| MCP servers get `CLAUDE_PID` | They get the session id, fixed at spawn. They do not get `CLAUDE_PID` | MCP identity stays on ppid ancestry plus start time |
| (new) | SubagentStart hook (`agent_id`, `agent_type`), SubagentStop `last_assistant_message`, TaskCreated (can block), `source:"system"` on cross-session prompts | Wave 3 considers SubagentStart for row-map. at-room uses `source` |

## Waves

### Wave 0: foundation (3 agents in parallel, disjoint files)

**W0-a core extraction** (owns `lib/*` except `cc.js` and `clock.js`, `hooks/common.js`, `hooks/row-common.js`):
- New modules:
  - `lib/io.js`: `readJson`, `writeJsonAtomic` (optional fsync, mode 0600), `isAlive`, `sleepSync`.
  - `lib/lock.js`: one `withLock`. It breaks a stale lock atomically (rename, then check the inode) and records owner `pid host starttime`.
  - `lib/config.js`: every timing and cap, named, plus a single `envMs`.
  - `lib/text.js`: `clip`, `oneLine`, `SID_SAFE`, `NAME_RE`, `CODE_RE`.
- Split `lib/room.js` into `lib/room/{store,validate,render,lanes}.js`. `room.js` stays as a re-exporting facade, so no caller changes in this wave.
- `rows.js` and `identity.js` import the shared helpers. The second lock in `rows.js` goes.
- Hooks get one `readInput` and one `resolveSeat`. Delete `row-common.js`. The copy in `tasks.js` is left to H, and the one in `bin` to F.
- Static `require`s. Remove the "optional until it exists" fallbacks.
- Delete dead code:
  - the watched-file half of `notices.js` and its tests;
  - `plansDir`;
  - the `signoffMatrix` alias;
  - the duplicate `normKind`;
  - unused exports.
- Comments cite reasons, not planning tags such as "owner F".
- **Accept:** suite green. The race harness (`racedrive.js`) shows 0 of 30 duplicate ids with a stale lock in place.

**W0-b cc contract** (new files only: `lib/cc.js`, `scripts/probe-cc.js`, `test/cc.test.js`, `docs/internals/`):
- `lib/cc.js` holds every internal: env names, transcript readers (`planFile`, `planFeedback` via `userFeedback`, peer envelope), task store path (respects `CLAUDE_CONFIG_DIR`), `jobs()` via `agents --json`, `stop`, the daemon env allowlist and the hook-matcher rule.
- Each export carries its search string and stability rating from `docs/internals/cc-2.1.281.md`.
- `probe-cc.js` finds the installed binary, greps it for every search string and prints pass or fail per assumption, with the version. The test runs it when a binary is present and skips otherwise.
- Callers migrate in wave 1, each by its owner.
- **Accept:** the probe passes on 2.1.281. Feeding a mutated string makes it fail.

**W0-c test infrastructure** (owns `test/helpers.js`, `test/hooks/helpers.js`, `test/index.js`, `package.json`, `lib/clock.js`):
- Temp dirs are removed when the run exits.
- Tests run per file with `node --test` (in parallel).
- Root `package.json` with `npm test` (plugin and scripts) and `npm run probe`.
- `lib/clock.js` provides an injectable `now` and timers, so later waves can drop real sleeps.
- **Accept:** suite green and noticeably faster. A run leaves 0 temp dirs behind.

Commit: "Foundation: shared io/lock/config/text, room split behind facade, cc contract + probe, test infra".

### Wave 1: independent fixes (5 agents in parallel)

**A log integrity** (owns `lib/room/{store,validate,render}.js`):
- Every continuation line of a message is indented under its sender, so a post can't fake a bare `room: decided` or signoff line. Cap lines per message.
- `validate` caps text bytes, `refs` count and line length.
- Incremental `verifyChain(fromOffset)` with a cached offset and index (`log.idx`). `append` reads only the tail for `id` and `prev`.
- `retractedIds` is computed once per call (the pull digest is currently O(k·n)).
- **Accept:** a forged-line test passes. Hook latency at 100k entries drops below 60 ms (from 243 ms; bench in the job tmp dir).

**B orch lifecycle** (owns `lib/orch.js`, `hooks/join.js`, `hooks/session-end.js`, the `identity.js` membership functions):
- Claim `{job:'pending'}` under the members lock before spawning. Stop the old job before any respawn.
- `join` spawns detached instead of blocking for up to 30 s.
- `orch.watchdog(code)` reaps when no member has been alive for 60 s. F calls it from the tail.
- `openRooms` ignores rooms where only the orch is left. Join sweeps those rooms.
- Store process start time with every pid, so pid reuse can't adopt a seat.
- Spawn env uses the `cc` daemon allowlist. Job listing goes through `cc.jobs()`.
- **Accept:** a crash-all-members test reaps the orch. Two concurrent joins spawn one orch.

**C consent fold** (owns new `lib/consent.js`, `lib/proposal.js`, the proposal parts of `lib/rows.js`, `lib/room/lanes.js`, `hooks/consent.js`, `hooks/session-restore.js`):
- One pure `fold(entries) → {proposals, answers, decisions}` that `stateLine`, rows and the gate all use. It settles the semantics in one place: latest answer wins, an objection voids that person's signoff, the latest proposal per hash counts, retracted entries are excluded.
- `consent.js` reads the note through `cc.planFeedback`, takes a lock on `review.json` and writes the plan backup atomically. `session-restore` restores a stale backup.
- **Accept:** a table test feeds the same entries to all three views and gets the same answer.

**D plugin surface** (owns `hooks/hooks.json`, `monitors/`, `agents/*.md`, `skills/sub-human/SKILL.md`, `.claude-plugin/*`, MCP tool metadata in `mcp/*.js` (schemas only), README):
- **Hooks:**
  - timeouts: 5 s on SessionEnd; 5–10 s on the gates and on join;
  - anchored matchers;
  - `async: true` on presence and row-launcher.
- **Agents:** the room agent may spawn only `Agent(sub-human:participant)`.
- **MCP tools:** descriptions, per-property docs, `readOnlyHint`, `additionalProperties:false`, a negotiated `protocolVersion`, and versions aligned with the plugin.
- **Manifest:** SKILL description written for users; remove `hold` from `allowed-tools`; complete the `plugin.json` metadata.
- **README:** requires node, supports macOS and Linux only, the `subagentStatusLine` override caveat, the security model.
- **Accept:** `validate --strict` passes. A hook-count bench shows fewer node starts per Edit and per prompt.

**E scripts and repo hygiene** (owns `scripts/`, `docs/` except `internals/` and this plan, `.gitignore`, `demo/`, new `CLAUDE.md`):
- **Checks:** split `checks.js` into scene modules. Each check is labelled `deterministic` or `behavioural`. Behavioural checks report against thresholds instead of failing the run. Baselines move to JSON.
- **Demo helpers:** `demo-lib` reuses `identity.home()` and the `orch` task paths.
- **Docs and repo:**
  - move old docs to `docs/archive/`, with an index;
  - gitignore `docs/rebuild/screens/`;
  - delete `demo/app`.
- **CLAUDE.md:** test commands, how to run the demo, and the design rules (no pinned models, no settings writes, the orch takes no typed input, rows kept, unprescriptive).
- **Accept:** script tests are green, and `checks.js` gives the same verdicts on the swan-6397 evidence.

Commit after the lead merges and runs the full suite.

### Wave 2: builds on wave 1 (3 agents in parallel)

**F tail and monitor** (owns `bin/sub-human`):
- Extract a `Batcher` (enqueue, arm, flush) driven by `lib/clock.js`.
- Separate the orch and member formatters.
- Call `orch.watchdog` (B) and `verifyChain` (A).
- Start reading from the cached offset.
- Never exit on an error inside the loop (the monitor isn't re-armed): log the error, back off and continue.
- Move the cli tests to the fake clock.
- **Accept:** the cli tests take seconds, not about 40 s. Killing the inner loop recovers it.

**G security** (owns `hooks/guard.js`, `hooks/at-room.js`, `append` capability in `lib/room/store.js` coordinated with A's merged code, `hooks/row-launcher.js`):
- `via=human` appends require a per-seat hook capability: an HMAC key in a 0700 directory, which the room MCP server and Bash can't reach.
- A Bash PreToolUse matcher denies commands that touch the store or `lib/room`.
- The forgery check marks entries provisional, and digests skip entries younger than the check window.
- Store directories are 0700 and files 0600.
- `ROOM_DIR` becomes `SUB_HUMAN_TEST_ROOM_DIR`.
- The row launcher is written per plugin root and refuses temp-dir roots.
- at-room uses `source:"system"` to detect peer prompts.
- **Accept:** a Bash-forged human signoff is rejected or flagged. A forged line never shows as attributed.

**H tasks** (owns `hooks/tasks.js`, `lib/tasks.js`, `mcp/task.js`):
- The req id lives in task `metadata`.
- `tasks.json` becomes a pure fold of the `task` log entries.
- The gate reads metadata from the task file.
- Orch guidance: change status in its own TaskUpdate call (a blocked call drops every field).
- Use the shared `readInput` and `resolveSeat`.
- **Accept:** removing the regex leaves the req link intact. Deleting `tasks.json` and refolding gives the same file.

Commit.

### Wave 3: cross-cutting (1 agent, then 1)

**J RoomStore** (one agent, because it touches everything):
- A `RoomStore` interface: `append`, `since`, `watch`, compare-and-set (CAS) for members, cursors and plan blobs. `FsRoomStore` implements it.
- `openRoom(code) → Room` replaces the `bind()` global.
- Route `rows.readLog`, `hold.readEntries` and the `tasks.json` fallbacks through the store.
- Liveness uses a heartbeat lease alongside pid and start time.
- Plan references are room-relative.
- Turn `hold.create` into a small class.
- Merge the UserPromptSubmit `at-room` and `consent` hooks into one dispatcher process.
- Evaluate SubagentStart in place of `row-guard` and `row-map`, and adopt it only if the demo shows no regression.
- **Accept:** no module outside `lib/room/store*` touches the log path. A second, in-memory store passes the store contract tests. That proves the remote seam.

**K architecture document** (after J): `docs/ARCHITECTURE.md` covers the module map, the state table (one owner per file), the event→hook map, lanes, consent and the cc contract. It is generated partly from `hooks.json` and the cc exports, so it can't drift.

Commit.

### Wave 4: verification (lead plus 1 demo agent)

- Run `npm test`, `npm run probe` and `claude plugin validate --strict`.
- Live demo run (same scenes as swan-6397), with deterministic checks required to pass.
- Metrics compared against swan-6397:
  - wakes;
  - noise lines per capture;
  - calls per review;
  - hook latency;
  - test-suite time.
- Publish walkthrough v6. Commit.

## Ordering

```
W0-a core ─┬─► A log ─────────┬─► F tail ─┐
W0-b cc ───┼─► B orch ────────┤           │
W0-c tests ┼─► C consent ─────┼─► G sec ──┼─► J store ─► K doc ─► W4 verify
           ├─► D surface      └─► H tasks ┘
           └─► E scripts/docs (independent; can start with W0)
```

Agent count: 3 + 5 + 3 + 2 + 1 = 14, with at most 5 at once.

## Needs the user

1. **Delete about 45,000 leftover test temp dirs** (`$TMPDIR/sub-human-test-*` and `sh-*`). The tests created them, but this is a bulk delete outside the repo.
2. **The live `~/.sub-human/bin/row-status` launcher** points at `/tmp/nx-s3/plugin`. The next SessionStart with the real plugin rewrites it, and G stops a temp-dir root from winning again. To fix it now, start any session with the plugin.
