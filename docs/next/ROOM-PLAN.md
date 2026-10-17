# Room plan: a smaller sub-human, an idle room session, one living plan

Status: plan, 2026-10-17. Not started. Branch `shrink` at `d67ed1f` (0.5.0-beta.16, local only). Paths are relative to `plugin/sub-human/` unless they start with `scripts/`, `docs/` or `/`. Line numbers are approximate (read on `d67ed1f`).

## 1. Context

sub-human extends native subagents to human-driven Claude Code sessions working together across machines. A small surface matters for adoption. The user decided two things in conversation:

- **A. Cuts** (pure removal): host handoff; the corporate-network options; the phone relay (Remote Control); the CLI `watch` and `digest`. Plus README leftovers and one stale comment.
- **B. Replace the room's Claude's model** with an idle room session plus the members' own Claudes: the plugin writes the native task files, one living room plan replaces ad-hoc proposals, `@claude` goes, and "room upkeep" becomes a role any member's Claude takes when its person asks.

Explicitly not doing: room-level agents spawned for the room; agent teams (a running session can't join a team, team plan approval goes to the lead Claude not to humans, and teams are experimental).

### Before / after, in brief

| | Before (beta.16) | After |
|---|---|---|
| Tags | `@room` (post) and `@claude` (post and wake the room's Claude) | `@room` only |
| Room's Claude | `claude --bg` job whose model applies task batches, plans when asked, spawns its rows | the same job, row `claude.CODE`, list `sh-CODE`; its model never runs (or runs only a fixed rows turn, see S1/Q1). It holds the native task list and a copy of the room plan |
| Tasks | member's `task` tool → `task_req` → wake → room Claude's TaskCreate/TaskUpdate → PostToolUse mirror → `task` entry | member's `task` tool → host applies it deterministically under a lock (immediate refusal or result) → `task` entry → plugin writes `~/.claude/tasks/sh-CODE/<n>.json` (a projection; the log is the truth) |
| Plans | any Claude `propose`s any number of proposals; titles, revisions by same title, "open the v3 one" | one living room plan with versions. "update the room plan": seeded into the member's native plan file, edited in plan mode, captured at ExitPlanMode with compare-and-swap on the base version. "ask for sign-off" opens the existing plan-view review for that version |
| Upkeep | the room's Claude | any member's Claude, when its person asks ("tidy the room plan", "split the agreed plan into tasks", "catch me up"), within limits the plugin enforces |
| Remote | ssh, `--via`, `prime`, CONNECT proxy, `--url`, `--web`, `--public`, handoff/promote/demote, `options` | ssh, `--web` (listener + Tailscale Serve), `--public` (Funnel). When the host leaves, the room waits |
| Phone | Remote Control relay of room lines as prompts; phone deny-note flow | nothing phone-specific (a phone-typed `@room` still posts if `bridge` stays a typed origin, Q7) |
| CLI | … `watch`, `digest` | without them |

## 2. Invariants every phase keeps

1. **Consent is native and human-only.** Agreement is only a `via=human` signoff, signed with the seat key and pinned in the log, recorded from a hook-opened plan-view review (or the card fallback) of that exact version's text. No Claude, room upkeep or plugin path writes one. `test/hooks/consent-table.node-test.ts` and `test/consent-review.node-test.ts` keep a row for this through every phase.
2. **Per version.** An answer counts only for the hash it names. Editing a version is never answering it. An edit is captured at ExitPlanMode without the native approval dialog (§6.2), so no edit ever shows a "Yes" that could be mistaken for agreement; the author signs off like everyone else, once, when sign-off is asked (today `review.ts` `ownPlan` :323-336 treats the author's own Yes as a signoff; that path goes, §6.3).
3. **The log is the source of truth.** Native task files and plan files are projections, rebuilt from the log at any time (`tasks.fold`, the plan fold).
4. **No settings writes, no symlinks into `~/.claude`, never pin a model.** Task files under `<configDir>/tasks/sh-CODE/` and the member's own plan file are data Claude Code itself reads and writes, not settings. ARCHITECTURE's "The plugin never writes under `~/.claude`" (Tasks section) is reworded to say exactly what it writes there and why.
5. **Internals only if listed.** Every Claude Code behaviour the new code relies on gets a `lib/cc/contract.json` entry with probe search strings and an `@cc` tag on the `lib/cc/*.ts` export that uses it (§5.3).
6. **Unprescriptive.** No required workflow. Steering text covers mechanics only and stays small.
7. **Local git only.** Every phase is one local commit. No push.

Each phase's commit runs: `npm test`, `npm run lint` (and `node scripts/ts-ratchet.ts --update` when casts went down), `npm run validate`, `npm run probe`, `npm run docs`, and `node scripts/check-version.ts` (bump `plugin/sub-human/.claude-plugin/plugin.json` `version`; one bump per phase commit is fine since nothing is released between them, e.g. beta.17 … beta.22, or one bump at the end if the user prefers, Q10).

## 3. Phase 0: spike (no plugin code changes)

Everything runs against the installed binary (`/opt/homebrew/Caskroom/claude-code@latest/2.1.296/claude`) in a throwaway config dir: `export CLAUDE_CONFIG_DIR=$(mktemp -d)/cc SUB_HUMAN_HOME=$(mktemp -d)/home`, never `~/.claude` or `~/.sub-human`, no tmux sessions the user owns (spike scripts make their own `sh-spike-*` sessions and kill them). The spike scripts live under `scripts/spike/` (not committed unless the user wants them) and write evidence to `/tmp/sub-human-spike-<time>/`. Spike runs cost real model calls only where noted.

Static probes first (free): grep the binary for each string below; each found string becomes a candidate `search` for §5.3. Verified on 2.1.296 while writing this plan: `".highwatermark"` (with the task schema `id,subject,description,activeForm?,owner?,status,blocks,blockedBy,metadata?` next to it), `{retries:{retries:30,minTimeout:5,maxTimeout:100}`, `[Tasks] resetTaskList`, `before a reset`, `[Tasks] raiseTaskIdMark`, `taskListHighWaterMark` (the storageV5 key). The reset path (`resetTaskList`) takes the list lock, returns without resetting if any task file is not `completed`, raises `.highwatermark` to the highest id, then deletes every `*.json`.

### S1. Can the room session start and stay idle?

Today the job starts with `claude --bg … --agent sub-human:room-claude --permission-mode plan --settings JSON /sub-human` (`lib/room-claude.ts` `spawnPlan` :131-148); the join hook (`hooks/handlers/join.ts` → `lib/commands/join.ts` `bindRoomClaude` :230-246) binds the seat, then the model runs (it creates task 1 from `skills/sub-human/room-claude.md` line 3, and spawns its participant rows from `lib/rows.ts` `rowCalls` :155-180).

Checks:
1. `claude --bg` with no prompt: does it dispatch, and does the job show in `claude agents --json` with a session id and the `-n claude.CODE` title? (Static: the `bg-dispatch-line` and `agents-json` entries.)
2. `claude --bg … /sub-human` where the UserPromptExpansion hook binds the seat and then **blocks** the prompt (`decision: block` / exit 2; contract `expansion-block-frame`): no model turn (no assistant line in the transcript, no API call in `claude logs`), the job stays alive and idle, the hooks module loads (`modules-headless`), the tail child runs (health tick, watchdog), `SendMessage` to `claude.CODE` is accepted (`crossSessionInbound: accept`) and queues without a turn? (A peer message starts a turn: decide whether to keep `crossSessionInbound` at `accept` or set `refuse`, S1.5.)
3. Does the job survive the daemon's idle policies for an hour with no turn (daemon status, `daemon-upgrade-exit`)?
4. Is there a session id and transcript to bind (`by-sid`), and does the agent view list the row `claude.CODE`?
5. A peer `SendMessage` to `claude.CODE`: does it wake the model? With `crossSessionInbound: refuse`, what does the sender see?
6. Rows: the room session's panel lists every human today only because its model spawns `sub-human:participant` rows. With no model turn there are no rows. Measure the cost of a **fixed rows turn** (the launch prompt passes, the injected block says only "make these Agent calls, then end"), and of one turn per `member_joined` that needs a row.

Go: (2) holds: bound seat, no turn, alive for an hour, module and tail run.
Fallbacks, in order:
- If a blocked expansion ends or kills a `--bg` job: a minimal fixed first turn (`/sub-human` passes, the room block says "Reply with one word: ready", no tools), then no further turns.
- If the agent view drops a job that never ran a turn: the same minimal first turn.
- Rows (S1.6) are a design-rule conflict (Q1): either keep a fixed rows turn (a model runs, but only to spawn rows: deterministic text, no planning) or drop the room session's participant rows (the members' room rows stay).

### S2. Does the room session's task view show tasks written from outside, live?

Setup: a room session started as in S1 (idle). A script writes `<CLAUDE_CONFIG_DIR>/tasks/sh-spike/2.json` (schema above) under the list lock (S4), then updates its status and owner.

Checks:
1. `claude attach <job>` (a spike tmux session) and ctrl+t: does the new task appear without a turn? Within the 5 s poll, or at once (fs.watch)? Does an update (status, owner) show?
2. The agent view row `claude.CODE`: does it show a task count or progress from the list?
3. Task 1 `in_progress` with owner `room` written by the script (not by TaskCreate): is the list never auto-reset while it is open? Complete every task: does the reset fire in the idle session (it runs "in whichever session shows it") within ~5 s, and only when attached, or also detached?
4. `.highwatermark`: after a reset, a plugin write of id `max+1` is shown; an id at or below the mark is shown too (it should be; the mark only steers Claude Code's own allocation).
5. A file the plugin writes with extra `metadata` (`{req, by, for}`) and a `blockedBy`: shown, not rejected.
6. `CLAUDE_CODE_TASK_LIST_ID` passes through `--settings` env (today's path, `daemon-env-filter`): still required.

Go: (1) shows within 5 s and (3) never resets while task 1 is open.
Fallbacks:
- Shown only on attach/redraw, not live: acceptable (the room session is rarely viewed; members see tasks in their room row and statusline, which read `tasks.json`).
- Not shown at all (the UI reads an in-memory cache filled only by the tool): keep native TaskCreate/TaskUpdate through a **scripted turn**: the plugin submits a fixed prompt to the room session listing exact tool calls (no judgment), and today's PostToolUse mirror stays. This keeps the deterministic decision in the plugin; only the write goes through the model. Costs one cheap turn per batch.
- `storageV5` on (contract `task-store-v5-off` fails): files are not the store. Then the same scripted-turn fallback, and doctor reports it.

### S3. Seeding a native plan file and capturing an edited plan at ExitPlanMode

Today's consent flow already writes the proposal text into the session's plan file (`hooks/consent.ts` `showEarly` :259-263, `entered`; backup and restore `lib/proposal.ts` `restorePlan` :465-494) and shows it through `updatedInput.plan` at PreToolUse(ExitPlanMode). That path shows a text the model must not change. The new flow needs the opposite: the model edits it.

Setup: a member session in a temp config dir with the plugin (`claude --plugin-dir plugin/sub-human`), in a spike tmux session. Model calls (a few turns).

Checks, against the existing contract entries:
1. `plan-mode-attachment`: after EnterPlanMode, the transcript attachment gives `planFilePath`; the PostToolUse(EnterPlanMode) handler writes the seeded text (header + current version) there before the model's next tool call.
2. The model, told "edit the plan file", uses Edit/Write on that file in plan mode (allowed: it is the plan file), and its edits land.
3. `exitplan-normalize`: PreToolUse(ExitPlanMode) sees `tool_input.plan` = the edited file's text and `planFilePath`.
4. Deny at Pre with a reason (stale base): the model gets the reason (`hook-json-block` / `permissionDecision: deny`), stays in plan mode, and can edit and exit again.
5. Deny at Pre with the store's receipt (the decided capture point): no approval dialog shows, the model reads the receipt, and the hooks put the person back in their own mode (today's review restore path) with no dialog, in every mode: default, acceptEdits, bypass, dontAsk, auto, and with `showClearContextOnPlanAccept` on.
6. A person who wants to edit the text by hand edits the plan file (or asks their Claude); no Ctrl+G dialog path is needed.
7. The model does not loop: after a stored receipt it ends plan mode work and does not call ExitPlanMode again.
8. The header survives: a marker line (`<!-- sub-human room plan sh-CODE v7 -->`) kept by the model, or recovered from the session doc if the model deleted it.

Go: 1–5 and 7 hold. Fallbacks:
- A Pre deny can't leave plan mode cleanly in some mode: in that mode let the dialog show and capture at Post (`exitplan-output`), the person's Yes then publishing the edit only (never a signoff).
- The model cannot edit the plan file in plan mode for some reason: seed into a file in the cwd (`.sub-human/room-plan.md`), edit it there, and capture on ExitPlanMode from `tool_input.plan` (model passes the text) — weaker, since `plan` then is the model's.
- No `planFilePath` until the first EnterPlanMode: seed at Post(EnterPlanMode) only (today's `entered`), never earlier.

### S4. proper-lockfile interop with our lock

Facts from the binary: proper-lockfile with `{retries: 30, minTimeout: 5, maxTimeout: 100}`, a list-wide lock and a per-task lock (`<n>.json.lock`). proper-lockfile's lock is `mkdir(<target>.lock)` with an mtime refresh (stale after 10 s by default; `update` every stale/2). Our `lib/lock.ts` `withLock` (:177-201) is an `O_EXCL` file with its own stale breaking: **not compatible** (a file at `X.lock` makes proper-lockfile's `mkdir` fail with EEXIST, which it treats as locked, and its stale check stats the mtime: it may then remove our file with `rmdir` and fail, or vice versa).

Checks:
1. Exact paths: the list lock's target (the dir, so `tasks/sh-CODE.lock`, or a `.lock` file inside the dir, so `tasks/sh-CODE/.lock.lock`?) and the per-task target (`<n>.json` → `<n>.json.lock`). Find them with `fs_usage`/`dtruss`-free means: run a TaskCreate in a spike session with a watcher (`fs.watch` recursive on the temp tasks dir) printing creates.
2. A spike script `scripts/spike/lockfile.ts` implementing the proper-lockfile protocol (mkdir, mtime refresh every 5 s, stale at 10 s, rmdir on release) in node with no dependency. Race it against Claude Code's TaskUpdate in an attached session: 200 iterations of plugin writes while the model updates (a short scripted turn), no lost writes, no corrupt JSON.
3. Writes are atomic: write `<n>.json.tmp-<pid>` then rename (check Claude Code tolerates a stray tmp file: it lists `*.json` only, `h.endsWith(".json")&&!h.startsWith(".")` in the reset; a `.tmp` suffix never matches).

Go: a mkdir-based lock (`lib/cc/tasklock.ts`) that Claude Code respects and that respects Claude Code. Fallback: if the paths cannot be pinned down, the plugin writes only while the room session has no turn running (it never does when idle) and holds our own lock for plugin-vs-plugin; the auto-reset race (S2.3) is then the only exposure, which task 1 already prevents.

### Spike output

A short `docs/internals/cc-2.1.296-tasks-plans.md` (the findings, the exact strings, the go/no-go per check) and the contract entries drafted for §5.3. The user reviews it before Phase 5 starts. Phases 1–4 (cuts) do not wait for the spike.

## 4. Phases 1–4: the cuts (independent of the spike)

Order: 1 → 2 → 3 → 4, each its own commit. Phase 1 and 2 touch the same files (`lib/cli/handoff.ts`, `lib/commands/handoff.ts`, `lib/remote/hosting.ts`), so handoff goes first.

### Phase 1 (A1): remove host handoff

**Delete** (1,429 lines): `lib/handoff.ts` (492), `lib/cli/handoff.ts` (205), `lib/commands/handoff.ts` (49), `test/handoff.node-test.ts` (182), `test/handoff-e2e.node-test.ts` (400), `scripts/remote-docker/scenarios/09-handoff.ts` (101).

**Edit:**
- CLI and commands: `lib/cli/main.ts` header 16-28, lazy imports 59/67/75/85, `serve` on a moved host 329-333, `link` 345-378 (drop `--reset` and its branch 374-376; keep `--forget` and `setAside`), usage 477-478, `handoffCli` 501-503. `lib/commands/index.ts` 27, 32. `lib/commands/help.ts` 25. `lib/identity.ts` reserved verbs 131 (keep `handoff`/`promote`/`demote` reserved as names for one release? Q11), `adoptLocalSeats` (~39, ~448; only `takeOver` uses it). `mod/core/guard.ts` 35, 45, ~424.
- Tail and consent: `lib/tail.ts` handoffLib lazies 32-73, types 114-136, `handoffHealth` 593-614 and its call 647/717, `sess.moved()` 678/774. `hooks/consent.ts` 36, 170-173, 186, 251-277, `postHandoff` 295-312. `lib/consent/review.ts` 90, 107, 132, 215-220, 559. `lib/consent/card.ts` 4 (comment). `lib/types-app.ts` 2, 10, 126-147 (HandoffDoc, HandoffAskDoc).
- Store: `lib/room/types.ts` HostProof 37, HostFields 53-61, host_changed fields 86-92/163-169, HostState 229-235, `hostState()` 477, `Link.moved` 604. `lib/room/validate.ts` 14-16, 32-33 (`host_changed`), HOST_FIELDS 60, 150, `hostFields()` 172-192. `lib/room/rules.ts` `hostState` carry and `checkHere` (~143-160; STALE). `lib/room/render.ts` 266. `lib/room/deliver.ts` 21, 54, 128 (`isHostMove`). `lib/room/consent.ts` 127. `lib/room/snapshot.ts` `host` 56/61 and the host FORK check 98. `lib/room/fs-store.ts` MOVED 49, `host: {epoch: 0}` 56, `hostState()` 174-175, `log.moved` 191-195, `reset()` 218+. `lib/room/store-mirror.ts` `hostState()` 122, `request()` 140-141, `reset()` 223, FORK texts 197/206. `lib/room/link-state.ts` 12-26, 48-52, 116. `lib/room/links.ts` 19, 29-30. Comments: `store.ts` 23/30, `log-io.ts` 42/875, `registry.ts` 5/50.
- Wire: `lib/remote/protocol.ts` OPS 71 (`handoff.accept`, `handoff.refuse`), EVENTS 74 (`handoff`, `moved`), CODE_NAMES 78 (`STALE`). `lib/remote/server.ts` 30-33, 51, 84-87 (WRITES, WHILE_MOVED, `epochOf`, `stale()`), 119, 162-163, 176, 204-218, hello epoch 249-277, append epoch 332-338, ops 369-375, 476-479, 495, 526. `lib/remote/client.ts` epoch 43-208. `lib/remote/types-core.ts` 25, 61-75, 83-153, 187-208, 241-261, 299, 310. `lib/remote/link.ts` 21-36, 69, 94-96, 204, 242, 344-345, 420-449 (replace `whyOffline` with a plain offline reason from link-state). `lib/remote/link-socket.ts` 41. `lib/remote/link-connect.ts` 147-151, 170. `lib/remote/link-engine.ts` `movedAway` 63, 227-233. `lib/remote/hosting.ts` `linkTransport`/`joinInvite` 304-335, 398 (only handoff calls them). `lib/remote/invites.ts` `isPromotePin` 50-52, `mintFor` 78-90, handoff flag in redeem 194-222, sh2 `formatInvite`/`parseInvite` 252-260 (and server.ts:107's sh2 branch), exports 320-321. `lib/remote/invite-secret.ts` SH2_RE 34/51-52. `lib/remote/webhost.ts` `serveAt` 154-166. `lib/remote/admission.ts` 21/73/90 (rename `HANDOFF_INVITE_MS` → `ADMIT_CARD_MS`, keep the value). `lib/remote/quota.ts` 11, `lib/config.ts` 101-107, 177. `lib/room-claude.ts` `releaseDetached` 411-415. `lib/cli/types.ts` 25, 95, 134. `lib/reasons.ts` STALE 54-56.
- Doctor: `lib/cli/doctor/links.ts` 140-141, 174-196, 41; `redact.ts` 55, 86, 102; `listener.ts` 35.
- **Fork state** (decision): fork is not handoff-only: it also fires on a truncated host log (`LOG_RESET`) and an unchained line or snapshot (`NOT_CHAINED`), and `link --reset` is its only recovery today. Recommendation: keep FORK detection (`reasons.ts` 57-59, `link-engine.ts` fork phase, `link-state.ts` `fork`) and point its message at `sub-human link --forget CODE` then the invite again. Tests at `remote-link` 203-246/417-424, `remote-reconnect` 352-371, `remote-sync` 168-191, `link-engine` 108-141/178-188 keep their detection asserts; only the recovery text and `mirror.reset()` change.

**Wire:** ops removed `handoff.accept`, `handoff.refuse`; events removed `handoff`, `moved`; `epoch` gone from hello and append; code `STALE` gone. Protocol bump to 4 happens once, in Phase 5 (§5.4), together with the new ops; Phase 1 alone stays wire-tolerant for 3-speaking peers (extra `epoch` ignored; a 3 peer's `handoff.*` op is refused as an unknown op).

**Tests:** delete the two files above. Edit `test/remote-wss-doctor-handoff.node-test.ts` (drop 116-155, rename to `remote-wss-doctor.node-test.ts`), `test/commands.node-test.ts` 33, 69-84; `test/hooks/join.node-test.ts` 233; `test/remote-server.node-test.ts` 278, 586; `test/remote-protocol.node-test.ts` 54, 157, 182-200; `test/log-segments.node-test.ts` 171-180 (reword: `setAside` stays for `--forget`); `test/doctor.node-test.ts` 93, 201, 261-286; `test/cli.node-test.ts` 199, 318; `test/consent-review.node-test.ts` 41, 114, 332-335; `test/consent-card.node-test.ts` 2-10 (new fixture); `test/room-watch.node-test.ts` 12-13; `test/errors.node-test.ts` 73; `test/support/two-homes.ts` 67 and its sh2/`mintFor` uses; `test/hooks/security.node-test.ts` 283.

**Lab:** delete `09-handoff.ts`; `scripts/remote-docker/lab.ts` 31, 375; `lab/seat-cli.ts` 88, 267-270, 348; `lab/entry.sh` 6 (joiner sshd, handoff-only); lab README 35, 83, 101-111.

**Docs:** README §"Moving the host before you close your laptop" 186-213, line 72, CLI rows 358-361 and 365, threat model 453-454, troubleshooting 481-483, limits 503. ARCHITECTURE 186, 203-208, 222, 357, 372, 380, 388-400, 414, 422-446 (the whole "Moving the host" block), then `npm run docs`. CLAUDE.md lab list ("handoff") and the `link --reset` mention.

Size: about −2,300 / +60.

### Phase 2 (A2): remove the corporate-network options

Keep: plain ssh joins (an `~/.ssh/config` alias with its own ProxyJump keeps working, since ssh reads it), `--web`, `--public`.

- `prime`: `lib/cli/host.ts` 17-20, 30-52, `prime()` 152-170, export 172. `lib/remote/transports/ssh.ts` mux block (8-10, `controlPath` 106, 121-125, 131-132, 187-190, `primeCommand` 208-213, 219, exports 228); keep the `mfa` classification as "needs an interactive login: ssh to it once yourself" (164). `lib/remote/types-rest.ts` `mux` 66-67; `lib/remote/joining.ts` 154-156; `lib/cli/doctor/ssh.ts` 49-59; `lib/cli/main.ts` 23, 28, 477, 497-498; `mod/core/guard.ts` 35.
- `--via JUMP`: `ssh.ts` `HOP_RE` 41, `jump()` 78-86, `?via=` 88-96, `locator` 100-104, 112/126, `loginSpec` 147-150, 153, 223, 227. `types-rest.ts` 65. `link-connect.ts` 60. `joining.ts` 59-64, 86, 140-144. `hosting.ts` 7, 192-221. `lib/commands/invite.ts` 2, 23, 28, 35. `lib/commands/join.ts` 18, 156-226 (via checks; `--home` stays). `lib/commands/help.ts` 14-21. `lib/cli/host.ts` 7, 82-100. `doctor/ssh.ts` 61, 63. `lib/cli/main.ts` 473 (`serve --via ws` is the listener's child flag: keep). `scripts/lib/panes.ts` 84, 90.
- CONNECT proxy: `lib/remote/ws.ts` 4-15, `proxy` 37, `proxyFor` 281-301, `viaProxy` 341-352, the proxy branch 360-373, export 395. `lib/remote/transports/ws.ts` 23.
- `--url`: `lib/remote/webhost.ts` 3, 11, `frontBase` 58-66, `hostWeb` url 68-74, 82, `mode = 'url'` 91-95, 102, `webLocator` 146-152. `invite.ts` 2/23/27/34, `host.ts` 7-99, `help.ts` 15, `lib/cli/listen.ts` 6, `doctor/listener.ts` 24, 35, `lib/remote/listener.ts` 233.
  - The web e2e tests and the lab wss scenarios reach the listener through `--url` (`test/remote-wss-e2e.node-test.ts` 114/160/253/299, `remote-wss-doctor` 107, `support/two-homes.ts` 21/67; lab `_lib.ts` `wssJoin`, 11/13/15). Recommendation: a test/lab-only front, `SUB_HUMAN_WEB_FRONT` in `lib/env.ts`, honoured only under `SUB_HUMAN_TEST=1` (the `env.testMs` marker) or `SUB_HUMAN_LAB=1`, documented as not a user knob (Q5).
- `options` / `login-same-person`: delete `lib/room/options.ts` (38). `lib/cli/main.ts` 25, 28, 62, 78, `optionsCmd` 456-465, 479, 495. `lib/remote/server.ts` 24, 60, 302-303 (a login link's `account` is then always the host account's own: say so in README's "One person in two seats"). `mod/core/guard.ts` 35.

**Tests:** `test/remote-link.node-test.ts` 166-193 (whole); `test/remote-login.node-test.ts` 30, 71-106, 154-188 (whole), 301-318, 322, 359; `test/remote-ws.node-test.ts` 182-209, 231-244 (whole), 315; `test/remote-invite.node-test.ts` 39-47, 85-95 (whole); `test/doctor.node-test.ts` 52-61; `test/commands.node-test.ts` 65, 84; `test/hooks/join.node-test.ts` 513, 819; `test/hooks/security.node-test.ts` 286-287; `test/cli.node-test.ts` 199; `scripts/test/s11-remote.test.ts` 34. Delete `test/support/tls-front.ts` (17) only if no wss test keeps it.

**Lab** (`scripts/remote-docker`): delete `scenarios/02-p2-corporate.ts` (75), `lab/tinyproxy.conf` (15); `lab/compose.yml` drop `bastion` 42-48, `corp-proxy` 64-68 and the `corp` network 9/91-92; keep `tls-front` 78-85 only as the stand-in for Tailscale Serve via `SUB_HUMAN_WEB_FRONT` (or delete it and `10-tls-front.ts` and run the wss scenarios against the listener directly, Q5). `_lib.ts` JUMP/PROXY 4-5, 29-33, `proxy` 92-108. Scenarios 03, 04, 05, 08 join `bea` through the bastion: switch them to a direct ssh join. `11-wss.ts`, `13-wss-resilience.ts`, `15-short.ts`: no corp-proxy leg. `14-login.ts` 6, 66-69 (login-same-person). `lab.ts` 16, 177, 297, 326; `lab/seat-cli.ts` 19, 211-214; `lab/entry.sh` 5-37; `lab/Dockerfile` 2-9 (tinyproxy); lab README 27-89, 110. CLAUDE.md's `test:remote-docker` paragraph (P2 corporate, bastion, CONNECT proxy).

**Docs:** README 62, 69, 73, 75, 84, 145, 168, 171, 183, 184, 192, 195, CLI rows 351, 352, 357, 359, 362, 365, 437, 453, and the "or your own front" wording at 456-501. ARCHITECTURE 342, 377-380, 420.

Size: about −950 / +40.

### Phase 3 (A3): remove the phone relay (Remote Control)

- `mod/core/deliver.ts` 4-5, `RELAY_*` 23-26, `relayText`/`RELAY_CONTEXT` 37-62, `relayQueue` 64-90, `route()` `remote` 155-171. `mod/core/types.ts` 79, 88. `mod/core/prompt.ts` `onRemote` 88-94. `mod/deliver.ts` 12, 173-190, 293-335, 421, 436, 533, 609. `mod/prompt.ts` 8-23, 63-83, 106-131, 156-161, 172, 187, 221-224, 232. `mod/core/command.ts` 10, 27, 40-51, 205-222. `mod/register.ts` descriptions 28-47. `hooks/handlers/at-room.ts` `toPhone`/`phoneNote` 19-21, 41-47, 56, 117, 154, 158. `lib/cli/doctor/claude.ts` 17, 35-38, `checkRemoteControl` 103-111, 189; `lib/cli/doctor.ts` 7, 22, 82, 153. `lib/commands/invite.ts` 36 (comment).
- Contract: remove `bridge-forwarded-rows` (693) and `auq-bridge-racer` (290). `plan-reject-remote` (279): remove in this phase only if `cc.planFeedback` stops reading the phone's deny shape (`lib/cc/transcript.ts` 145-149); recommendation: remove it and the phone branch together. Keep `prompt-origin-composer` and `plugin-prompt-frame` (`mod/core/chat.ts` uses the frame). Reword notes of `transcript-prompt-origin` 690 and `command-run-empty-answer` 1062.
- The deny-note Send/Discard card stays: the terminal's "Tell Claude what to change" uses the same flow. Only phone comments go (`lib/proposal.ts` 497-502, `lib/consent/card.ts` 5).
- `bridge` as a typed origin (`mod/core/prompt.ts` `TYPED_ORIGINS` 18-30): keep, so an `@room` typed on the phone still posts (Q7).

**Tests:** `mod/test/deliver.test.ts` 567-620 (whole), `mod/test/prompt.test.ts` 293, 317 (whole), `mod/test/command.test.ts` 54, 108, 133 (partly); `test/mod-core-deliver.node-test.ts` 88-108; `test/mod-core-command.node-test.ts` 25-26, 111; `test/hooks/at-room.node-test.ts` 260-276; `test/doctor.node-test.ts` 44-51, 98; `test/cc.node-test.ts` 154-164; `test/hooks/consent.node-test.ts` `phoneDeny` 778-791, 1010-1044, and the confirm tests at 1045-1207 switch their fixture to a terminal deny.

**Docs:** README 289 (the paragraph), 392, 418. ARCHITECTURE 41, 88-107 (generated), 507-532 (generated), the consent diagram's phone lines. `docs/internals/cc-2.1.292.md` stays (history).

Size: about −650 / +20.

### Phase 4 (A4): remove CLI `watch` and `digest`; README leftovers; the stale comment

- `lib/cli/main.ts` 12, `digest()` 191-195, `label`/`inThread`/`watch` 245-303, usage 472, `cmds` 495. `lib/config.ts` `WATCH_POLL_MS` 23, `DIGEST_CAP` 215. `lib/room.ts` 11, 28, 105, 143. `lib/room/render.ts` 12, `digest` 344-420, 476. `mod/core/guard.ts` `READ_CLI` 26, deny text 467. Keep `lib/room/watch.ts` (the store's fs.watch).
- README leftovers: 356 `kick NAME [--room ROOM] [--file F]` → `kick NAME [--room ROOM]`, and drop "an older version's key line removed"; 484 drop "(for a link an older version made, its own key was removed)"; 488 drop the "invite line comes from an older sub-human" row **and** its code (`lib/commands/join.ts` `OLD_LINE` 53, `lib/remote/joining.ts` 170), since protocol 3 refuses such hosts anyway; 497 drop the "`AUTH` after upgrading" row and reword `hooks/seat-key.ts` 9-12.
- `lib/room/store.ts` 42: replace with "blobs get/has/ref/localPath take a ref `plans/NAME` only (`rules.ts` `blobRef`); anything else, an absolute path included, is null". Rename `ref(pathOrRef)` → `ref(name)` in `lib/room/types.ts` 352 and `rules.ts` 31.
- README §"Watching the room's Claude" 238-246 (`sub-human watch claude`) goes here; its replacement text comes in Phase 7.

**Tests:** `test/cli.node-test.ts` 190-195, 199, 257-290; `test/room.node-test.ts` 228-260; `test/lane.node-test.ts` 58-95; `test/store-contract.node-test.ts` 421; `test/remote-link.node-test.ts` 295; `test/hooks/guard.node-test.ts` 91; `test/hooks/security.node-test.ts` 72, 263.

Size: about −330 / +10.

## 5. Phase 5: tasks written by the plugin (needs S2, S4; S1 for the idle session)

### 5.1 Flow

```
member's Claude ─ task({op, …}) ─► host: tasks.apply(req)  under store.lock('tasks') on the host
   local member on the host: called in-process by mcp/task.ts
   member on a mirror: new op `task` over the link (server.ts) → the same tasks.apply → result back
tasks.apply: fold the log's task entries; check (validate, ownership, evidence); refuse → {ok:false, reason} at once
             accept → append task_req (via=agent, by, the request) and task (via=system, the full snapshot, req=id)
             → project(code): write <tasksDir>/<id>.json under the native list lock; refold tasks.json
projection repair: the room session's tail health tick (host only) compares files with the fold and rewrites
```

- **Where files go.** The room session's config dir, recorded at spawn: `members.claude.tasks_dir = cc.tasksDir('sh-CODE')` as computed from the env the job gets (`spawnPlan` passes `CLAUDE_CONFIG_DIR` through `daemonEnv` when set). The host MCP server or link server writes there, not to its own `configDir()` (they agree on one machine unless someone runs two config dirs; the record makes it explicit).
- **Ids.** Allocated by `tasks.apply` under the lock: `max(fold ids, native .highwatermark, highest *.json) + 1`. The projector raises `.highwatermark` to the max id, like `raiseTaskIdMark`.
- **Task 1.** `lib/room-claude.ts` writes "room CODE open" (owner `room`, `in_progress`) as a `task` entry and file at spawn, not the model (`skills/sub-human/room-claude.md` line 3 goes). The reaper completes it itself (replace `CLOSE_TEXT` status + wait-for-model 386-389 with a direct `task` entry + file write) and then stops the job; `roomTaskDone` 347-352 reads the fold.
- **Ownership** (lib/tasks.ts `gate` 213-233, now run inside `apply` instead of the TaskCompleted hook): `add` (anyone; `suggest: NAME` records a suggested owner, never an owner); `claim` (only for yourself; refused if owned by someone else); `release` (owner only); `done` (owner only, with evidence after the last claim). Refusal texts stay. The `for` argument of `mcp/task.ts` (55-58) becomes `suggest` for `add` only.
- **Members' own Task tools.** A member's TaskCreate goes to their own session list, untouched. The room list is reached only through the `task` tool.
- **Tasks know their plan (decided 2026-10-17).** `task` add takes optional `plan: NAME` (and records the plan's current version at add time). The `task` entry and the native file's `metadata` carry `{plan, version}`. "Split the agreed plan into tasks" (Phase 7 upkeep) tags every task it adds. The fold groups tasks by plan; `tasks.summary` and the rows show "paging v3: 2/5 done"; when a newer version of that plan lands, tasks added against an older version are marked "plan changed since" in the summary (no automatic edit or reassignment). Ships in Phase 6, once `plan` exists; Phase 5 leaves the field reserved.

### 5.2 Files

- New `lib/room/task-files.ts` (~180): `project(code, fold)`, `repair(code)`; the native file schema typed in `lib/cc/types` or `lib/cc/tasks.ts` (with `@cc`); atomic write (tmp + rename) under the native locks.
- New `lib/cc/tasklock.ts` (~80): the proper-lockfile-compatible mkdir lock (paths from S4), `@cc` tagged.
- `lib/tasks.ts`: add `apply(code, req)` (~120), keep `validate`, `fold`, `refold`, `summary`, `gate` (as a pure check). Header 1-32 rewritten. `isRoomTask` stays.
- `mcp/task.ts` (68): call `apply` (host) or the link op (mirror); drop "the room's Claude is not running" (42-53) — a task works whenever the host's store is reachable; the reply is the applied task or the refusal.
- `lib/remote/server.ts`: op `task` → `tasks.apply`, quota `task`; `lib/remote/protocol.ts` OPS; `types-core.ts` params/result; `client.ts`, `link-socket.ts` RELAY.
- `lib/room-claude.ts`: `spawnPlan` keeps `CLAUDE_CODE_TASK_LIST_ID` and `CLAUDE_CODE_ENABLE_TODO_TOOLS` (the session must still show the list); drops `--agent`'s tool list needs. Task 1 write at spawn, completion at reap.
- **Delete**: `hooks/handlers/tasks.ts` (259: the PostToolUse mirror, reconcile, TaskCompleted gate), `mod/tasks.ts` (64), its registration in `mod/register.ts`, `mod/core/prefilter.ts` `tasksNeeded` 23-27. `lib/room/deliver.ts` 71 (`task_req` as a wake for the room's Claude: a `task_req` is now `none`/context; the `task` entry assigned to me by someone else stays a wake, unchanged).
- `lib/cc/env.ts`: `tasksDir`/`taskFile` docs no longer "read only".

### 5.3 Contract entries (added in this phase)

From S2/S4, each with `search` strings proven present and an `@cc` tag on the export in `lib/cc/tasklock.ts` / `lib/cc/env.ts` / the schema type:
- `task-file-schema` (incidental): the zod object `id,subject,description,activeForm,owner,status,blocks,blockedBy,metadata` next to `".highwatermark"`.
- `task-highwatermark` (incidental): `".highwatermark"`, `[Tasks] raiseTaskIdMark`: ids above max(files, mark).
- `task-lockfile` (incidental): `{retries:{retries:30,minTimeout:5,maxTimeout:100}`, plus the lock-target shape from S4.
- `task-list-auto-reset` (incidental): `[Tasks] resetTaskList`, `before a reset`: all completed → mark raised, every `*.json` deleted; the reason task 1 stays open.
- `task-ui-watch` (incidental): the fs.watch/5 s poll strings found in S2 (the live view).
- Update `task-store-v5-off`: doctor fails loudly when on; add `taskListHighWaterMark` as a `degraded` hint.
- Remove (no longer relied on): `task-completed-block-drops-fields`, `task-completed-input`, `task-events-no-matcher` (if `hook-events` no longer needs it), `task-update-schema`, `task-create-metadata` — unless the S2 fallback (scripted turn) is taken.

### 5.4 Wire: protocol 4

This phase bumps `PROTO` (`lib/remote/protocol.ts` 39) to `{min: 4, max: 4}` once, covering Phases 1, 5 and 6: ops added `task`, `plan.put` (Phase 6); ops removed `handoff.accept`, `handoff.refuse`; events removed `handoff`, `moved`; hello/append `epoch` removed; code `STALE` removed, `CONFLICT` added (Phase 6). A protocol-3 peer is refused at hello by the existing `skewMessage` path (server.ts 250-256, client.ts 183-193, protocol.ts 59-68): "Update your plugin: /plugin update sub-human" or "The host must update". `07-skew.ts` (lab) is updated to expect that refusal against `LAB_OLD_REF` = beta.16. `test/remote-protocol.node-test.ts` gets a 3-vs-4 refusal row.

### 5.5 Log

No kind added or removed: `task_req` (via=agent) and `task` (via=system) stay; `task` is now written by the host's `apply` instead of the PostToolUse mirror, `from: room` instead of `claude` (Q8). `tasks.json` remains `tasks.fold(task entries)`. Old rooms' logs fold as before.

### 5.6 Tests

- Delete: `test/hooks/tasks.node-test.ts` (223), `test/hooks/tasks-reconcile.node-test.ts` (77), `mod/test/tasks.test.ts` (105), `test/mod-core.node-test.ts` 344 (prefilter).
- Rewrite: `test/tasks.node-test.ts` (206): `apply` tables (add/claim/release/done × owner/other/none × evidence), refusal immediate, concurrent `apply` from two processes (one wins, the other re-reads), task 1 never completed by a member.
- Add: `test/task-files.node-test.ts`: projection byte shape against the schema, atomic writes, repair after a deleted or edited file, `.highwatermark` raise, auto-reset safety (task 1 open). `test/tasklock.node-test.ts`: our mkdir lock vs a proper-lockfile-protocol peer in a child process (no dependency: a 40-line reimplementation in `test/support/`). `test/remote-server.node-test.ts`: the `task` op (refusal and result over the link), quota. `test/store-contract.node-test.ts`: unchanged kinds.
- `test/room-claude.node-test.ts`: task 1 written at spawn; reap completes it without a model (replace 159, 201).
- Demo: S1 (`wait-native-task` 383) now waits on the plugin's file; `scripts/checks/s01-open.ts` 35-36 unchanged in substance. S6 (580-610) rewritten: no "the room's Claude applies"; the waits are on `task` entries right after each request; the gate evidence is the tool's own refusal reply (drop `synthetic-gate`, `demo-lib.ts` `synthetic-gate`). `scripts/checks/s06-tasks.ts`: drop "room Claude used TaskCreate and TaskUpdate" (18-19) and the behavioural `roomClaudeTaskCalls` (44-45); add "every `task` entry follows its `task_req` within 2 s" and "the native file equals the fold". `scripts/baselines.json` drop `roomClaudeTaskCalls`. S6b's `task-for` waits on `task` entries. S10 (`checks/s10-leave.ts` 17-22): task 1 completed by the reaper's own entry.

Size: about −900 / +700.

## 6. Phase 6: one living room plan (needs S3)

### 6.1 Model

- **A plan** has a name (default `room`) and versions v1, v2, …. Each version is a blob `plans/<hash12>.md` (existing blob store, `lib/proposal.ts` `store`/`planRef` 61-74) and a `plan` log entry: `{kind: 'plan', via: 'agent', from: EDITOR, for: PERSON, plan: NAME, version: N, base: N-1, hash, path, text: "plan NAME v7: SUMMARY"}`. `from` is the editing seat (alice's Claude acts as `alice`, via=agent), `for` the person it acted for (the same person unless the person was someone else's request relayed, which the plugin does not allow: `for` = the seat's person, always; kept as a field so the line reads "alice's Claude for alice").
- **Compare-and-swap.** `plan.put(name, base, text, summary)` runs on the host under `store.lock('plan')`: current = the fold's latest version of NAME; `base !== current` → `CONFLICT` with the current version's text; else append. Local members call it in-process; mirrors over op `plan.put` (`MirrorRoomStore.lock` is local-only, store-mirror.ts:124, so a mirror-side lock would not serialise anything).
- **Sign-off.** "ask for sign-off" → the `signoff` room tool (or `plan({op: 'ask', approvers})`) appends today's `proposal` entry (`{hash: <version hash>, approvers, same?, path}`) pointing at the version's blob. Everything after that is today's consent machinery, unchanged: the fold `lib/room/consent.ts` (per hash), the plan-view review `lib/consent/review.ts`, `hooks/consent.ts`, the card fallback, `proposal.answer`/`decide`. A newer version of the same plan supersedes the open sign-off request of an older one (replaces revision-by-same-title, consent.ts 96-108: the rule becomes "a `plan` entry for NAME supersedes every undecided `proposal` whose hash is an older version of NAME").
- **Agreed** is only the decision (via=system, every approver's via=human signoff). No Claude can mark a version agreed: there is no tool for it, and `post` already refuses agreement kinds (room-server.ts :212).
- **Named plans.** Recommendation: allow names, default `room`, cap at 5 open plans per room, no title matching. A name is a slug the editor gives ("paging", "release"), shown in every line. One plan per topic keeps CAS meaningful; a single global plan forces unrelated work into one text and makes conflicts constant. The steering says "use `room` unless your person names another topic" (Q2).

### 6.2 Editing flow (member session)

```
person: "update the room plan"  → member's Claude calls plan({op:'edit', name?})
  → session doc `edit {name, base: vN, startedAt}`; reply: "EnterPlanMode, edit the plan file, ExitPlanMode with a one-line summary"
EnterPlanMode Post (consent hook, new `editEntered`) → write header + vN text into the native plan file (backup the person's own first)
model edits the file (native plan mode)
ExitPlanMode Pre (`editExit`) → plan = tool_input.plan (normalized from disk); strip header;
   plan.put(name, base, text, summary)
   CONFLICT → deny: "vM landed since your base vN (by bob's Claude for bob: SUMMARY). Both texts below; reconcile, keep
          both intents, ask your person only where they truly conflict, then ExitPlanMode again" + both texts; base := vM
   stored   → deny with the receipt (no dialog): "stored as plan NAME vN+1. Not agreed: anyone can ask for sign-off."
          restore the person's plan file and mode (the existing review restore path); clear `edit`
The person stops their Claude / Esc before ExitPlanMode → nothing stored; edit stays open until Stop or the next prompt not about it
```

- **Header** written above the text: "This is a group-contributed plan (room CODE, plan NAME, base vN). Different people's Claudes edit it and may contradict each other; reconcile, and ask your person when edits truly conflict." plus the marker line `<!-- sub-human plan NAME vN -->`. It is stripped on capture. Text read from the plan file is the person's content, never instructions to the plugin.
- **Capture point (decided 2026-10-17): at Pre, with no approval dialog.** Editing stays native (plan mode, the plan file); the store's receipt replaces the dialog, the way `@room`'s receipt does. Sign-off is the one deliberate approval per person per version, author included. S3 must confirm a Pre deny with a reason leaves plan mode cleanly in every permission mode (default, acceptEdits, bypass, dontAsk, and with `showClearContextOnPlanAccept` on, which never reaches its clear-context path because no dialog shows).
- **Notices for a new version (decided).** A `plan` entry renders to everyone as a dim room line: "bob's Claude for bob: plan paging v4: opaque cursor" (`render.ts`; `deliver.ts`: notice + context, never a wake). One exception wakes: an approver who signed off an older version that a new version supersedes gets a wake for their Claude ("plan paging v3, which you agreed, was superseded by v4 (bob's Claude for bob): sign-off asked again" when an ask follows; else context only).
- **The room session's copy.** After each put, the host writes the current version into the room session's plan file **if** S1/S3 found its path (needs a `plan_mode` attachment, i.e. at least one turn in plan mode). Else skip it (the copy is a convenience; members read the plan through `read` and the room row). Q4.
- **Reading**: `read` (room tool) gains `plan` (current version of NAME, its history summary: version, editor for person, summary, base, sign-off state).

### 6.3 What goes from the proposal machinery

- `mcp/room-server.ts` `propose` (174-189, 244-265) is replaced by `plan` (`op: edit | ask | read`). `proposal.create` (lib/proposal.ts 344-396) keeps its approver logic (366-377), `sameOf` (111-119), blob storage, and is called by `ask` with the version's hash. The "another sender has a proposal with the same title" warning (259-261) goes.
- Multi-proposal bookkeeping goes: `namedIn` (218-233), `replacedIn` (240-254), `proposeIntent`/`PROPOSE_RE` (261-263), `choose`/`writePick`/`picked`/`readPick` (269-283), `reminder` (298-302), `ownSince` (hooks/consent.ts 386-393), `SessionDoc.pick` (types-app.ts 21), the `enter` pick logic (review.ts 348-375) reduced to: open the one pending sign-off request for me (at most one per plan name; with several names, the one my person's words name by plan name, else the oldest). Q2 decides whether that last selection survives.
- `ownPlan` (review.ts 323-336): goes (invariant 2).
- `lib/room/consent.ts` revision-by-same-title (96-108) replaced by supersede-by-newer-version (above); `titleOf` (47) goes.
- `render.ts` `proposalLabel` 164-185 / `retiredBy` 187-193 / `stateLine` 307-336: name the plan and version ("plan paging v3: agreed (alice, bob)").
- `skills/sub-human/facilitate.md` (35) goes; its useful lines move into the upkeep text (Phase 7).

### 6.4 Store, log, wire

- New kind `plan` (via=agent only; `validate.ts` AGENT_KINDS 30-33 and ENTRY_FIELDS 62: `plan`, `version`, `base`, `for`, `summary`; `rules.ts` `fieldsOf` 56-76; `types.ts`). `proposal` keeps its shape, gains optional `plan` + `version` (which version it asks about). No change to `signoff`/`objection`/`decision`.
- New op `plan.put` → `{ok, version} | CONFLICT {current: version, hash, text}`; quota `plan`. Counted in the protocol 4 bump (§5.4).
- The snapshot carries `plan` entries (non-chat, already all kept).
- Link prefetch of plan blobs (lib/remote/link.ts 393-399) extends to `plan` entries.

### 6.5 Tests

- New `test/plan.node-test.ts`: put/CAS (stale base → CONFLICT with the current text), two concurrent puts from two processes (one wins), over a link (`two-homes`), supersede of an older version's open sign-off, history read, header strip, injection text in a plan does not change any decision.
- `test/consent-review.node-test.ts` (479): new `editEntered`/`editExit`/`editExited` rows; delete pick/`namedIn`/propose-intent rows; `ownPlan` rows become "Yes on own edit records no signoff".
- `test/hooks/consent.node-test.ts` (1286): delete pick 792-805, supersede-by-title 837-888, propose intent 897-926; add end-to-end edit (seed, edit, exit, stale-deny, re-exit, store, restore) and sign-off of a version.
- `test/hooks/consent-table.node-test.ts`: the plan fold joins the one-table check (every view agrees on versions and sign-off state).
- `test/mcp.node-test.ts` (385): `propose` cases → `plan` cases. `test/propose-path.node-test.ts` (64): delete or fold into plan tests (paths are now always the plan file). `test/lane.node-test.ts` stateLine rows. `test/consent-same.node-test.ts` unchanged. `mod/test/consent.test.ts` (198): wiring for the new edit events.
- Demo: S4 and S5 are rewritten (Phase 7 lists the scene text). `scripts/checks/s04-plan.ts` (41): a `plan` v1 entry from the editing member, its blob, the plan view shown for the edit; `s05-consent.ts` (67): sign-off request for v1, an objection with a note, v2 by the other member's Claude with base v1, both sign off v2, decision; no answer counted for v1 after v2; plan files restored. S11's `propose` call (demo.sh ~166) → `plan` + ask.

Size: about −900 / +900.

## 7. Phase 7: `@claude` goes; the idle room session; room upkeep steering

### 7.1 `@claude`

- `mod/core/prompt.ts` `parseClaude` 63-68, `isAtClaude` 70, `posts` 73, gate naming 77-110, `RECEIPT_FOR_MODEL` tag 195-212. `mod/prompt.ts` 168, 234, 244. `hooks/handlers/at-room.ts` 119 (`wake`), 141-142 (`to: 'claude'`), 160-163 (`ensureRoomClaude`, the "woken" receipt). Outside a room `@claude` already passes untouched; inside a room it now does too (a plain prompt to the person's own Claude). Q6: or answer "@claude is gone; ask your own Claude, or @room".
- `lib/remote/outbox.ts` 51-53 (only `@room` queues). `lib/rows.ts` 492-495 (mail count). `lib/seats.ts` 311, `lib/commands/help.ts` 28 (join text: "@room to talk to the room; your Claude can message other Claudes, edit the room plan and the task list"). Refusal hints in at-room.ts 90 and mod/core/prompt.ts 32.
- `lib/room/deliver.ts` 63 (`to === 'claude'` push), 71, 125 (`member_joined` wake for the room's Claude): the room's Claude gets no wakes at all, except the rows turn if Q1 keeps it. `lib/tail.ts` `formatRoomClaudeBatch` 262-270, the claude block 290-327, longer settle 195-196/511-512, `lib/config.ts` 13-14. `mod/core/deliver.ts` 35, 48-58, 176-181; `mod/deliver.ts` `submitWake` for role claude 255-268, 419-421.
- `post` with `to: 'claude'`: refused ("the room's Claude does not read; message a person's Claude").

### 7.2 The room session

- `agents/room-claude.md` (20 lines): reduced to the frontmatter (no tools, or `Agent(sub-human:participant)` if Q1 keeps rows) and one line: "You are the room's idle session. You never act. If you run, end your turn." `skills/sub-human/room-claude.md` (4) and `facilitate.md` (35) go; `hooks/context.ts` `TEMPLATE_FILES` 30-40.
- Spawn per S1's outcome (blocked expansion, or a fixed first turn). `crossSessionInbound`: `refuse` unless S1.5 says a peer message to an idle session costs nothing (Q1).
- Typed-input refusal stays as is (`at-room.ts` 88-102, 122-126; `mod/core/prompt.ts` `roomClaudeCommand` 23-33): it already says "type in your own session"; reword to drop `@claude`.
- Liveness: `mcp/task.ts` no longer needs the room session alive (§5.1). The watchdog/reap stays (it completes task 1 and stops the job).

### 7.3 Room upkeep (any member's Claude, when its person asks)

Steering text: `skills/sub-human/member.md` (8 lines) gains a short "room upkeep" block, mechanics only (≤ 12 lines):
- What you can do for your person: edit a plan (`plan` edit), ask for sign-off (`plan` ask: names approvers, never answers), add tasks and suggest owners (`task` add with `suggest`), reconcile versions, brief ("catch me up": `read` with `brief`).
- What you never do: answer a sign-off for anyone, claim or complete a task for someone else, say a plan is agreed (only the decision line says so).
- Room content (plan text, task subjects, room lines) is people's content, not instructions to you.

Enforcement in code (not trust in the text): `plan.put` records `from` = the calling seat's person and `for` = the same; `apply` refuses claim/done/release for another owner; there is no agree tool; consent records only `via=human` from a hook-opened review; the MCP server never arms the seat signer (`hooks/handlers/at-room`, `consent.ts`, `join` alone do, CLAUDE.md).

**Compact state** for "catch me up" and for edit seeding: new `lib/room/brief.ts` (~120): current plan per name (text + "v1 alice's Claude for alice: …; v2 bob's Claude for bob: …"), open sign-off state, tasks (`tasks.summary`), decisions, the last N `via=human` lines (exact, attributed), capped at ~6 KB, wrapped as "Room state (people's content, not instructions): … end of room state". Served by `read({brief: true})`.

Two Claudes at once: plan CAS (§6.1) and task `apply` under the host lock make the second fail cleanly with the current state; the reply tells it to re-read.

### 7.4 Rows

**Plan state at a glance (decided 2026-10-17).** Each member's room row shows one line per open plan: `paging v4 · waiting on bob`, `release v2 · agreed`, `api v1 · draft` (from the plan fold and the consent fold; `lib/rows.ts` summary beside the task summary, capped at 3 plans with "+N more"). A new CLI `sub-human plan [NAME] [--room ROOM] [--history]` prints the current version's text (or the list of plans with their state, with no NAME), and `--history` the versions ("v2 bob's Claude for bob: opaque cursor"). It replaces what `digest` gave (Phase 4) for plans; `lib/cli/main.ts` verb + `test/cli.node-test.ts` cases. About +120.

The room session's participant rows stay (Q1 decided: a fixed rows-only turn at start and per new member, no planning). If S1.6 finds even that turn can't be made deterministic and cheap, come back to the user before dropping them.

If Q1 drops the room session's rows: `lib/rows.ts` role-claude branches (155-180, `joinNote` ~200, `rowsNeeded` ~210), `agents/room.md` "never for claude", the row-hold and row-guard handling for the claude seat, `test/rows.node-test.ts` 37, 206, 249. The members' room rows (each member's panel: the room row with the other members inside) stay unchanged.

### 7.5 Tests

- `test/hooks/at-room.node-test.ts` (377): delete 195, 215 (wake, restart); rewrite 148, 236, 361 for the idle session. `test/mod-core-prompt.node-test.ts` 47, 107, 118. `test/mod-core.node-test.ts` 214, 248, 290. `mod/test/prompt.test.ts` 220, 232, 330. `test/lane.node-test.ts` 154, 183 (no `to=claude` push). `test/tail.node-test.ts` 179, 201, 240, 548, 565 (room Claude batches). `test/remote-reconnect.node-test.ts` outbox `@claude`. `test/room-claude.node-test.ts`: spawn argv (55) per S1; no wake. `test/hooks/join.node-test.ts` 48-115 (launch binds without a turn).
- New: `test/brief.node-test.ts` (cap, attribution, framing, a plan containing "ignore previous instructions" stays content).
- Demo (`scripts/demo.sh`):
  - S1: the room session binds with no turn (check: no assistant line in its transcript).
  - S2: join text without `@claude` (`checks/s02-join.ts` 21); `roomClaudeJoinCalls` (32-33) becomes "the room session ran no turn" (deterministic if S1 go; else ≤ 1).
  - S3: unchanged (`roomClaudeTurns == 0` already).
  - S4: B says "let's write a room plan for cursor paging; you draft it" to her own Claude → it edits plan `room` v1 in plan mode, B approves her Claude's edit, then "ask alice and me to sign off". Drop `ANSWER_A/B` (466-477).
  - S5: A objects with a note; A's Claude (asked by A) edits v2 on base v1; B's Claude edits concurrently on base v1 → CONFLICT, reconciles into v3; both sign off v3; decision. A real CAS on screen.
  - S6: tasks per Phase 5. S6b: A asks his Claude to "split the agreed plan into tasks and suggest owners"; each person's Claude claims its own.
  - S9: viewer refusal unchanged; `checks/s09-claude-typing.ts` unchanged.
  - S10: reaper completes task 1 itself.
  - `scripts/checks/transcripts.ts` `roomClaudeTurns` 108 stays (now expected 0 everywhere), `scripts/metrics.ts` 142-168/364-412 claude seat wakes → 0, `run-metrics.ts` `T.wakes` lowered, `baselines.json` drops `roomClaudeJoinCalls`, `roomClaudeTaskCalls`, `runs.*.wakes.claude`.
  - `scripts/test/checks.test.ts`, `s06b-build.test.ts`, `demo-lib.test.ts` follow.

Size: about −1,100 / +450.

## 8. Phase 8: docs, README, CHANGELOG

- `plugin/sub-human/README.md` (516): remove §"Moving the host" (186-213, ~28 lines), §"Watching the room's Claude" (238-246), the phone paragraph (289), corporate bullets (~15 lines), CLI rows (`digest`, `watch`, `prime`, `options`, `handoff`, `promote`, `demote`, `--via`, `--url`, `--reset`), troubleshooting rows (481-483, 488, 497), limits 503. Rewrite §"Saying something to the room: `@room` and `@claude`" (247-292) → `@room`; §"Agreeing to a proposal" (293-329) → "The room plan" (edit, conflicts, sign-off); §"Shared tasks" (330-338) → the `task` tool and what the room session shows. Expect 516 → ~390 lines.
- `docs/ARCHITECTURE.md`: Entries/via table (no `host_changed`, add `plan`), Delivery (no room-Claude wakes), Consent diagram (sign-off of a version; editing flow), Tasks (projection, locks, auto-reset), "The room's Claude: lifecycle" → "The room session", Remote rooms (protocol 4 op table), contract (generated). `npm run docs`.
- `CLAUDE.md`: the intro (`@claude` line; the room's Claude "keeps the shared task list and helps plan only when asked" → idle session), Layout (`handoff.ts`, `options.ts`, `room-claude.ts` description), lab list, design rule "The room's Claude takes no typed input" stays.
- `CHANGELOG.md`: one entry for the release: removed (handoff, corporate options, phone relay, watch/digest, `@claude`), changed (tasks deterministic, the room plan, protocol 4: update both sides).
- `docs/next/PLAN-COLLAB.md`, `PLAN-COLLAB-IMPL.md`: superseded by this plan; mark them so in their status line (they assume Remote Control first-class, multiple proposals and the room's Claude revising).
- `plugin.json` `description` (mentions "a headless helper keeps the room's task list").
- Memory notes are the user's; not edited.

Size: about −250 / +150.

## 9. Size summary

| Phase | Removed | Added | Net |
|---|---|---|---|
| 1 handoff | ~2,300 | ~60 | −2,240 |
| 2 corporate | ~950 | ~40 | −910 |
| 3 phone relay | ~650 | ~20 | −630 |
| 4 watch/digest, leftovers | ~330 | ~10 | −320 |
| 5 tasks | ~900 | ~700 | −200 |
| 6 room plan (+ tasks tagged by plan, notices) | ~900 | ~1,000 | +100 |
| 7 @claude, idle session, upkeep, plan rows + `sub-human plan` | ~1,100 | ~570 | −530 |
| 8 docs | ~250 | ~150 | −100 |
| **Total** | **~7,400** | **~2,520** | **~−4,830** |

README sections removed: "Moving the host before you close your laptop", "Watching the room's Claude", the Remote Control paragraph, the MFA bastion and "Any HTTPS front" bullets; rewritten: `@room`/`@claude`, "Agreeing to a proposal", "Shared tasks". Lab scenarios removed: 02-p2-corporate, 09-handoff (and 10-tls-front if Q5 drops it). Contract entries: −2 to −8 (phone, task hooks), +5 (task files).

## 10. Risks and how tests guard them

| Risk | Guard |
|---|---|
| **Internals reliance.** The plugin now writes Claude Code's task files and relies on their schema, locks, high-water mark and reset. A change in any of them breaks the room list silently. | Contract entries (§5.3) with probe strings; `npm run probe` in every phase; doctor runs the same matcher; `test/task-files.node-test.ts` pins the schema the plugin writes; the log stays the truth, so a broken projection loses a view, never data. |
| **storageV5** (`taskListHighWaterMark`, a key-value backend behind a gate): if it turns on, files are no longer read. | `task-store-v5-off` probed; doctor reports "the room's task list cannot be shown on this Claude Code"; the S2 scripted-turn fallback is kept designed (not built) for that day. |
| **The auto-reset** deletes every file when all are completed, in whichever session shows the list. | Task 1 stays `in_progress` until the reaper; `apply` never lets a member complete or release task 1 (`isRoomTask`); a test runs the reset rule (all completed) against the fold and asserts task 1 open; `repair` rewrites files from the log after any reset. |
| **Lock interop** with proper-lockfile (mkdir + mtime) vs our O_EXCL lock. | S4 race test; `lib/cc/tasklock.ts` speaks proper-lockfile's protocol; `test/tasklock.node-test.ts` races a protocol peer; atomic tmp+rename writes. |
| **Concurrency across machines.** A mirror's local lock serialises nothing. | Both `task` and `plan.put` run on the host under the host's store lock (new ops), never as a mirror-side check; `two-homes` tests race two homes; CONFLICT carries the current text so the loser reconciles. |
| **Consent invariants.** Editing a plan in plan mode uses the same dialog that records sign-off today. A "Yes" on one's own edit must never become a signoff, and an edit must never pass for a version someone signed. | `ownPlan` removed; review state keeps `edit` and `review` phases apart (`consent-review` table rows for each crossing); signoff still needs hash12(shown text) = the version's hash; `consent-table` one-table check; `test/hooks/security.node-test.ts` keeps "no via=human outside the three hooks". |
| **Prompt injection** through plan text, task subjects or the brief. | Framing as content; no code path takes an action from text; `test/brief.node-test.ts` and a plan test with hostile text. |
| **Idle session behaviour** (a blocked first prompt, daemon idle policies, peer messages starting a turn). | S1; `test/room-claude.node-test.ts` spawn argv; the S1 demo check "no assistant line in the room session's transcript". |
| **Room rows** (design rule "The room's Claude's panel lists every human") need a model turn. | Q1 decides; whichever, `test/rows.node-test.ts` and `checks/s01-open.ts` 31-33 assert it. |
| **Protocol 4** strands beta.16 peers. | The existing skew refusal with the update message; lab `07-skew.ts`; `test/remote-protocol` row. |
| **Fork without `--reset`.** | FORK detection kept; message points to `link --forget` + rejoin; existing fork tests keep their detection asserts. |

## 11. Open questions

1. **Decided (2026-10-17): keep a fixed rows-only turn (option a).** **Room session rows vs "its model never runs".** The room session's panel lists every human only because its model spawns `sub-human:participant` rows (`lib/rows.ts` 155-180). Keep a fixed rows-only turn (at start and per new member; deterministic text, no planning), or drop the room session's participant rows and amend the design rule? Recommendation: keep the rows turn if S1.6 shows it costs ≤ 1 cheap turn per join; else drop.
2. **Decided (2026-10-17): allow several named plans.** **Named plans.** Recommendation: allow names (default `room`, ≤ 5 open), no title matching. Or one plan per room?
3. **Decided (2026-10-17): capture at Pre, no dialog; the store's receipt instead (§6.2).** Was: **Capture point** of an edit: Post (after the person's Yes on their Claude's edit; Pre-capture only where Post never fires), or always at Pre (no human step)? Recommendation: Post.
4. **The room session's plan file**: it exists only after a plan-mode turn. Skip the copy when there is no path (recommended), or give the room session one plan-mode turn to create it?
5. **`--url` removal vs the tests and lab**: a test/lab-only `SUB_HUMAN_WEB_FRONT` (recommended), or drop tls-front and the wss lab scenarios that use it?
6. **`@claude` inside a room after the cut**: pass through silently as a plain prompt (recommended), or answer once "`@claude` is gone"?
7. **Phone-typed `@room`**: keep `bridge` as a typed origin so it still posts (recommended), or treat it as untyped?
8. **`task` entries' author**: `from: room` (system, recommended) or `claude`? Affects `checks/s06*` and old-room folds (both fold the same).
9. **Who may ask for sign-off**: any member's Claude for its person (recommended), or only the latest version's editor?
10. **Version bumps**: one per phase commit (beta.17…beta.23) or one bump at the end (all phases unreleased)? `check-version.ts` passes either way if the last commit bumps.
11. **Reserved names** `handoff`, `promote`, `demote` (lib/identity.ts 131): keep reserved one release so an old line still fails clearly, or free them now?
12. **Spike scripts**: commit `scripts/spike/` as evidence tools, or keep them out of the repo?
