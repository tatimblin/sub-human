# Mods (function hooks) plan

Status: W0 done (a6abb60), W1 done (03a3d9c), W2 done (see W2 results), W3 next, 2026-10-07. Decided: D1 yes, D2 yes (W4), D3 notices via `$.ui.log`, D4 add `bridge`; generated `tsconfig.json` and `.claude-plugin/types/` are gitignored. D5–D8 open.
- the plugin-authoring skill shipped with Claude Code 2.1.292 (`reference.md`, `types/claude-code.d.ts`, `examples/`);
- the 2.1.292 binary as text (`/tmp/cc292/bin.txt`), for everything the skill does not settle;
- [`docs/internals/cc-2.1.292.md`](../internals/cc-2.1.292.md) (`hooks-modules (b)`) and the code at `0a310fd`.

"Mod" here means a hooks module: `hooks/hooks.json` → `"modules": ["./register.mjs"]`, exporting `register(on, options)`, where each hook is `($, e, next)`.

## Principles

- **The mod routes, node writes.** The module runs with no Node and no `require`, and `$.fs` has no rename, lock or file mode (gate 2). So the mod never writes room state and never signs. Every store write still happens in a short `node` process that runs the existing scripts (`hooks/*.js`). The mod starts that process with `$.process.run`, and its stdin is the same classic payload. The seat key stays in hook processes only.
- **The mod knows no store path.** It gets the home, seat, role and address from node: `hooks/mod-hello.js` in W1, and the tail child's events in W3. `test/store-bypass.test.js` is extended to `mod/`.
- **A prefilter skips node only when the mod is sure.** The mod skips the node start only when it knows the answer for certain: the session has no seat, the seat is a member and not the orch, or no review is open. If it does not know, it runs node. A hot reload, a lost worker or a failed hello all count as "does not know".
- **Behaviour stays the same unless a wave says otherwise.** Each wave ends with these green: `npm test`, `npm run probe`, `npm run validate` and the new `npm run test:mods`.
- **Keep the rows.** No wave edits `lib/rows.js`, `mcp/hold.js`, `hooks/row-*.js`, `statusline/` or `agents/room|participant.md`. W3 has the one forced change, and it is named there.
- **One owner per file per wave.** The lead owns `hooks/hooks.json`, `package.json`, `lib/cc.js` CONTRACT and `scripts/arch-doc.js`. Agents put the entries they need in their reports.
- **Internals are listed.** Every mod behaviour that the types do not promise goes into CONTRACT with a binary search string (gate 5).

## Gating answers

### 1. Can one plugin ship command hooks and a module at once? **Yes, in the same `hooks.json`.**

Evidence:
- The 2.1.292 hooks.json schema has `hooks:…optional()` and `modules:A(o()).max(Zp,{message:"hooks.json \`modules\` names one hooks module per plugin; a second entry is refused"}).optional()`, refined by `"hooks.json must have \`hooks\` (the hook matchers) or \`modules\` (hooks modules), or both"`.
- The loader returns `{hooks:b.hooks??{},modules:b.modules??[]}`.
- The unknown-key check accepts `["$schema","description","hooks","modules","surface"]`.
- reference.md: a plugin's function hooks are in "one hooks module … that `hooks/hooks.json` names under `modules` (one path, relative to that file)".

**Order.** For classic events the chain is `[managed settings hooks, ...hooks modules, the other settings hooks as core]` (d.ts `ClassicEventOf`; binary `` `classic.${n.hook_event_name} function-hook chain` `` with `managedRanAbove`). `prompt.submit`'s `next(e)` "runs the hooks beneath and the UserPromptSubmit settings hooks". So a module hook sits above the plugin's own command hooks for the same event. It can wrap them, filter them (answer without `next`) or replace them.

**Migration shape.**
- Keep the one `hooks.json` and add `"modules": ["./register.mjs"]`.
- `hooks/register.mjs` is a thin entry that imports `../mod/*.mjs`.
- Move one entry per commit: the module hook is added and the command entry removed together.
- There is exactly one module per plugin.

**Correction to the internals note.** `cc-2.1.292.md` names `hooks/register.ts`. That fixed path is the built-in plugins' path (`` Yo=(e)=>`builtin:${e}/${ye}` ``). An installed plugin names its module in `hooks.json`. The CONTRACT note for `hooks-modules` changes accordingly, and so does the test "the plugin ships no hooks module".

### 2. What runtime do modules get? **No Node, no fs. The store stays in node, reached through `$.process`.**

The module is an ES module whatever its suffix: "no DOM, no Node … there is no `require` … A module holding `import()` does not load". Globals are web APIs only (`URL`, `TextEncoder`, `crypto.subtle`, …).

`$.fs` has `read` (text or base64, whole file, up to 4 MiB), `write` (the whole content), `list`, `exists`, `stat` (plus `realPath` with `{resolve:true}`) and `ancestors`. In the binary, `write` is `case"write":{…await mkdir(dirname,{recursive:!0}),await writeFile(s,e.text,"utf8"); t(\`$.fs.write (…)\`)}`. It has no temp file and rename, no mode, no exclusive create, no unlink, no append and no lock. `$.store` is the plugin's own JSON file under the config dir, not the room.

`$.process.run(argv, {stdin, env, cwd, timeoutMs})` and `$.process.spawn({argv, input, env})` run host commands, CLI only. In the binary, `run` spawns with `env:n?.env` over the host env and `hasInput:n?.stdin!==void 0`.

| Code | In the mod? | How |
|---|---|---|
| `lib/room/*`, `lock.js` (O_EXCL, rename-to-break), `io.js` (atomic writes, 0600, fsync), `identity.js` (pid, `pid_start`, `ps`), `home.js`, `hooks/seat-key.js` (Ed25519 private key), `proposal.js`, `tasks.js`, `orch.js`, `notices.js`, `tail.js` | **no**: CommonJS on `node:fs`, `node:crypto` and `child_process` | unchanged, run in node: `hooks/*.js` through the `$.process.run` shim (below), or the tail child (W3) |
| `lib/consent.js` fold, `lib/room/lanes.js`, `lib/room/render.js` | **no**: they could be ported, but nothing in the mod needs them | the tail child decides lanes and sends finished lines |
| `guard.js` `bashVerdict` / `homeSpellings` (pure string logic) | **yes**: moved to `mod/core/guard.mjs` as pure functions over `{home, realHome, userHome, pluginRoot, cwd}` | the mod imports it; node tests and any fallback `hooks/guard.js` load it with `await import()` |
| `at-room.js` `parse()`, `text.js` name/code patterns | **yes**: `mod/core/prompt.mjs` | `text.js` stays the CommonJS source; a test asserts the copies are equal |

**The shim** (`mod/core/shim.mjs`, W1) is how a classic event moves without rewriting its handler:
1. A `classic.<Event>` hook gets the command hook's exact stdin (`e`).
2. A cheap in-process predicate decides whether node is needed at all.
3. If it is, the shim calls `$.process.run(['node', root + '/hooks/X.js'], {stdin: JSON.stringify(e), env: {CLAUDE_PLUGIN_ROOT: root, CLAUDE_CODE_SESSION_ID: e.session_id, CLAUDE_PID: ''}, timeoutMs: 10000})` (W0 S3: the child gets no session env of its own). The call sits in the registering file, since `$` cannot be passed to an imported helper (W0 S1).
4. It translates the stdout JSON into `ClassicResult`:
   - `decision:"block"` / exit 2 → `block`;
   - `continue:false` → `preventContinuation` + `stopReason`;
   - `hookSpecificOutput.additionalContext` → `additionalContext[]`;
   - `sessionTitle` and `suppressOriginalPrompt` → the same fields.

### 3. Does a peer message arrive as a recognisable `UserMessage`, and does redrawing it leave the model's text alone? **Yes to both.**

- Every user-role row is the `UserMessage` site. Its `props.origin` is a `PromptOrigin` with `kind`:
  - `composer`
  - `peer`
  - `peer-send-message`
  - `task-notification`
  - `plugin` (with `name`)
  - `channel`
  - `unclassified`
  - …
- `props.from.name` is the sender (another session's title), and `props.task` describes a notification's task.
- The d.ts: "a rewrite of `text` draws in the row alone: the stored message, and the model's framing of another party's words as that party's, stay as they were".
- Binary: `y0("UserMessage",()=>({requestId:d,props:{text:o,origin:dXn(t),isExpanded:a,…}}))` then `s$(p,(c)=>u(c.props.text),…)`. The hook's answer feeds only the draw callback. `var yn=["origin","isExpanded","task","from"]` are pinned, and changing one fails the hook.
- Caveats: a teammate block with several frames keeps the engine's drawing, and a hook must return `next(e)` while `isExpanded` (ctrl+o).

**Who typed it.** `prompt.submit`'s `e.origin` is set by the engine, and "no hook sets one". In the binary, `case"human":return n===!0?{kind:"bridge"}:{kind:"composer"}` means `composer` is only the person's own Enter. A same-user socket "is never stamped, and arrives as `unclassified`". This is stronger than the classic `source`, which is still `.optional()` in 2.1.292. That optional `source` is why at-room still has the provisional post and the forgery checker today.

### 4. How are mods tested, and how does that fit `npm test`? **Three tiers. The mod is plain `.mjs`.**

- `claude plugin test <dir>` runs every `*.test.ts` / `*.test.tsx` under the dir. Binary: `.isFile()&&/\.test\.tsx?$/.test(`, skipping `node_modules` and dot dirs, "each file in a child of this binary".
- Tests run "in an environment like the one a plugin's hooks run in (no fs, network or process)". They import `test`, `expect` and `mock` from `claude-code/testing`. The `classic` noun raises classic events, `$.tool.call` raises `classic.PreToolUse` and `tool.call`, and `$.ui.mount` draws.
- "A plugin's tests run only while it is on" (the rollout flag).

| Tier | Files | Runner |
|---|---|---|
| Pure core | `mod/core/*.mjs`: no `$`, no node imports | `node --test` via `plugin/sub-human/test/mod-core.test.js` (`await import()`), zero dependencies |
| Wiring | `mod/test/*.test.ts` | `npm run test:mods` = `claude plugin test plugin/sub-human`. `npm test` runs it when a 2.1.292+ binary is found and modules are on, and prints a skip otherwise (the same gate `test/cc.test.js` uses for the probe) |
| Live | demo scenes | `scripts/demo.sh` (W4 only, when asked) |

- **Language.** The module is JavaScript (`.mjs`), typed with `/** @type {import('claude-code').Register} */`, with no build step. The design rule "Zero dependencies, CommonJS" becomes "CommonJS for node code, ES modules for `mod/`". Only test files are TypeScript, because the runner only collects `.test.ts`. `tsc -p plugin/sub-human/mod` is optional and never a dependency.
- **Node 24 hazard.** Node 24 is installed here (v24.15.0). It strips types, and `node --test <dir>` would collect `*.test.ts` in that dir. So mod tests live in `mod/test/` and never in `plugin/sub-human/test` or `scripts/test`.
- **Validate.** `npm run validate` (`claude plugin validate --strict`) now also reads the module and lists `gating hook with/without .catch`. A test parses its JSON report and asserts that every gating hook has a `.catch`.

### 5. New CONTRACT entries (lib/cc.js, section 10 unless noted)

Every search below was checked against `/tmp/cc292/bin.txt` (match counts in brackets). Shapes use `~` for one minified identifier.

| Id | Stability | Search / shape | Note |
|---|---|---|---|
| `hooks-json-modules` | API | ``or `modules` (hooks modules), or both`` [2]; `"$schema","description","hooks","modules","surface"` [1]; `names one hooks module per plugin` [6] | One hooks.json carries both the command hooks and one module path. |
| `hooks-modules` (edit) | env | unchanged searches | The note changes to "sub-human ships one, named in hooks.json". `hooks/register.ts` is the built-ins' path. |
| `classic-chain-order` | incidental | `function-hook chain` [4]; shape `` `classic.${~.hook_event_name} function-hook chain` `` | Module `classic.<Event>` hooks run above the plugin's command hooks. A module that answers without `next` means the command hooks beneath do not run. |
| `prompt-origin-composer` §8 | incidental | shape `case"human":return ~===!0?{kind:"bridge"}:{kind:"composer"};case"plugin":return ~.asUser===!0?` [1] | `composer` is only the person's Enter. Peers, notifications and plugins get their own kinds. Replaces `source` + the forgery check. |
| `usermessage-draw-only` | incidental | `["origin","isExpanded","task","from"]` [1]; shape `props:{text:~,origin:~(~),isExpanded:~,` | A `ui.render` rewrite of `UserMessage` text changes only the drawing, and the origin, sender and task are pinned. |
| `session-append-note` | incidental | `door:"note",origin:{kind:"plugin",name:` [1]; `role:"user",isMeta:!0},content:` [1] | `$.session.append` writes user rows as isMeta (the model reads them, there is no wake) and system rows as notices the model never reads. |
| `fs-write-plain` | incidental | `$.fs.write (` [2] | `$.fs.write` is mkdir -p plus writeFile: not atomic, no mode, no lock. That is why the mod never writes room state. |
| `process-run-stdin` | API | `hasInput:n?.stdin!==void 0` (move to a shape in W0) | `$.process.run` takes argv, stdin, env over the host env and a timeout. Children get no `CLAUDE_PID` (W0 S3 confirms). |
| `plugin-test-discovery` | incidental | `.isFile()&&/\.test\.tsx?$/.test(` [1]; `Runs every *.test.ts and *.test.tsx under dir` [2] | `claude plugin test` collects every `*.test.ts(x)` under the plugin. Node tests stay `*.test.js`. |

W0 added these, plus the spike anchors: `modules-headless` (S2), `session-append-notice-hidden` and `ui-log-notice` (S4), `prompt-submit-ups-order` (S6), `plugin-test-off` (S8) and `module-dollar-local` (S1). `process-run-stdin` searches `toolCgroupClass:"plugin"` plus two shapes. All pass the probe (78/78).

## Part 1: plain hooks

| Current (file, event) | Verdict | Mod event | What gets simpler | Deleted | Risk |
|---|---|---|---|---|---|
| `hooks/guard.js`, PreToolUse `Bash` and `Write\|Edit\|MultiEdit\|NotebookEdit\|room MCP` | **move** (W1) | `tool.call` (`{tool:'Bash'}`, the write family) for deny; `tool.check` `{tool:/^mcp__plugin_sub-human_room__/}` → `{decision:'allow'}` when seated; `hold` denied unless `e.agentId` | Runs in-process with no node start per Bash or Edit, which is the most frequent hook today. Write paths use `$.fs.stat(p,{resolve:true}).realPath` (the d.ts guard pattern) instead of `realpathSync` | 2 hooks.json entries; `hooks/guard.js` (132 lines; the verdict logic moves to `mod/core/guard.mjs`) | A hook that throws is skipped and the tool runs. So `.catch` fails closed, but only when `JSON.stringify(e)` mentions `sub-human`, as today; denying everything on a bug would break every session. Until hello arrives the home is unknown, so the string-only rules apply (`.sub-human`, `SUB_HUMAN_*`) |
| `hooks/prompt.js` (at-room + consent `onPrompt`), UserPromptSubmit, every prompt in every session | **move the trigger** (W2/W3) | `prompt.submit`: an origin gate that drops `@room`/`room:` unless `origin.kind` is `composer`/`sdk`. `classic.UserPromptSubmit` shim: no session seat → `next(e)` with no node; otherwise run node `prompt.js` with `sub_human_origin` added to the stdin JSON | An unseated session pays 0 node starts per prompt (today 1). After W3 a seated member also pays 0 unless the prompt is `@room`, a review is open, or it is the first prompt of the session id (title). `ClassicResult` has `preventContinuation`, `stopReason`, `block`, `suppressOriginalPrompt`, `additionalContext` and `sessionTitle`, so the "✓ sent" row and the refusals render as they do now | `hooks/prompt.js` (57 lines) and its merge logic, once at-room and consent are called by the shim separately (W3); the hooks.json entry | `prompt.submit` must keep `next(e)` for everything but a forged `@room`, and a drop shows its reason to the person. The `@room` gate is a guard, so it gets `.catch` → `{drop}` only for `@room` text |
| `at-room.js` forgery checker + provisional posts | **delete** (W2 writes no provisional entry when origin is attested; the legacy branch goes in W4) | `prompt.submit` origin | No detached `--forgery-check` process, no transcript polling, no 1.2 s provisional window | `spawnForgeryCheck`, `forgeryCheck`, `promptOrigin`, the `TYPED_SOURCES`/`hasSource` branch (about 75 lines); `cc.isPeerPrompt`, `cc.entryIsPeer`, `cc.isPeerText`, `PEER_PREFIX`; CONTRACT `ups-source`, `peer-origin`, `peer-held-prefix` | The store and `mcp/hold.js` keep reading `provisional` (old logs; rows are not touched). Only the writing stops |
| `consent.js`, Stop (the open-review nudge via `additionalContext`) | **move** (W2) | `classic.Stop` shim. `$.state` flag `reviewMaybeOpen` is set when `tool.call` sees EnterPlanMode/ExitPlanMode, is `true` after `session.start` and reload (when unsure, run), and is cleared when consent's shim output says `reviewOpen:false` | 0 node starts per turn end while no review is open (today 1, synchronous, before the turn ends) | the Stop entry | Needs W0 S5: a module's `additionalContext` at Stop must continue the turn the way the command hook's does (`stop-additional-context`) |
| `consent.js`, PreToolUse on room MCP tools | **move** (W2) | the same `tool.call` hook as the guard: run the consent shim only when `reviewMaybeOpen` | A room tool costs 0 node starts (today 2: guard and consent) | `\|^mcp__plugin_sub-human_room__` leaves consent's matcher | The same flag discipline as above |
| `consent.js`, Pre/Post/PermissionRequest on `AskUserQuestion\|EnterPlanMode\|ExitPlanMode` | **stay** | (the mod only observes them, to set the flag) | Nothing: they are rare, and they rely on `permissionDecision` ask/allow, `setMode`, plan-file writes under a lock and `via=human` signing | — | — |
| `hooks/tasks.js`, PostToolUse `TaskCreate\|TaskUpdate` and TaskCompleted | **move the trigger** (W2) | `classic.PostToolUse` and `classic.TaskCompleted` shims, run only when the role is `orch` or unknown | A member's own native TaskCreate costs 0 node starts (today 1). The orch is unchanged | 2 entries | A gate. The skip happens only when the role is known to be a member, and exit 2 → `block` must keep the TaskUpdate drop-all semantics (`task-completed-block-drops-fields`). The wiring test uses the `classic` noun |
| `hooks/presence.js`, Notification `idle_prompt\|permission_prompt` and StopFailure | **stay** | — | They are `async` and rare, so nothing would get cheaper. **Forced change:** at-room writes "working" on every prompt today, so when node stops running per prompt (W3) the mod runs `node hooks/presence.js` with `{hook_event_name:'Working'}` on a composer `prompt.submit`, only when the last state it wrote was not `working` | — | Row text (`lib/rows.js`) reads the same `presence/<name>` document; no row code changes |
| `hooks/join.js`, UserPromptExpansion `/sub-human` | **stay** | `classic.UserPromptExpansion` wraps it: `await next(e)`, then refresh the seat (hello) | — | — | It needs `CLAUDE_PID` and `pid_start` (the by-pid index), the members lock, seat-key generation and the detached orch spawn. Under D1, join also refuses when the mod's hello lease is missing |
| `hooks/session-restore.js`, SessionStart `compact\|clear\|resume` | **stay** | `classic.SessionStart` refreshes the seat after `next(e)` | — | — | Rebinding the session id by pid after `/clear` and restoring the plan backup need node. `session.start` does not fire after `/clear` (reference.md); `classic.SessionStart` does. Moving the role text to `prompt.compose` is optional (D5) |
| `hooks/session-end.js`, SessionEnd | **stay** | — | — | — | The detached reaper must outlive the module (children of `$.process` die with it), and `session.end` shares "one short wall-clock bound" |
| `row-guard.js`, `row-map.js` (Pre/PostToolUse Agent\|Task), `row-hold.js` (SubagentStop), `row-launcher.js`, `row-rewake.js` | **stay** (the rows rule) | — | `tool.call` on Agent and `$.agent.spawn` could replace model-mediated row spawns, but that changes rows. Out of scope (D6) | — | — |

Node starts per event, after W3 with D1 and D3:

| Event | Today | After |
|---|---|---|
| a prompt in a session with no seat | 1 | **0** |
| a plain prompt, seated | 1 | **0** (1 on a session id's first prompt) |
| an `@room` post | 1 | 1 (signing) |
| turn end (Stop) | 1 | **0** (1 while a review is open) |
| `Bash`, `Write`/`Edit` | 1 | **0** (since W1) |
| a room MCP tool | 2 | **0** (1 while a review is open; 1 after W1: consent only) |
| `Agent`/`Task` | 2 | 2 (rows, unchanged) |
| a member's own `TaskCreate`/`TaskUpdate` | 1 | **0** |
| session start | 1–3 | +1 (`mod-hello.js`) |
| long-lived per session | monitor + MCP | tail child + MCP (+ the monitor until D2) |

## Part 2: peer messages

**2a. Drawing (W1, display only, low risk).** One `ui.render` hook on `{component:'UserMessage'}` returns `next(e)` when `e.props.isExpanded`. Otherwise:
- `origin.kind` `peer` or `peer-send-message` (another member's Claude via SendMessage): one compact line, `bob's Claude: <first line>` (+ `│` continuation as `room.chatLines` does). The name is taken from `from.name` (`bob.CODE` → `bob`) only when it parses as `NAME.CODE`; otherwise `next(e)`.
- `origin.kind` `task-notification` from the room monitor (the fallback path): draw the batch's group-chat lines and leave `(for Claude)` lines out of the drawing. The model still reads them (gate 3).
- `origin` `{kind:'plugin', name:'sub-human'}` (W3 wakes): the same chat drawing.
- `mod/core/chat.mjs` holds the pure line formatting and is unit-tested in node. `mod/test/render.test.ts` mounts the hook on `terminal` and `desktop`.

**2b. Delivery: replace the Monitor with a mod-owned tail child (W3).**
- **Start.** On `session.start` the mod runs `$.process.spawn({argv:['node', root+'/bin/sub-human', 'tail', '--ndjson'], env:{CLAUDE_CODE_SESSION_ID: sid, CLAUDE_PLUGIN_ROOT: root}})` and keeps the loop for the session's life.
- **Restart.** Unlike a Monitor (`monitor-not-rearmed`), the mod restarts a child that exits, with backoff. A reload or a lost worker re-runs `session.start`, and so does `session.end` with reason `clear` (re-spawned with the new id).
- **The tail stays the tail.** `lib/tail.js` keeps the cursor, the lanes, the settle batching and the health tick. `--ndjson` changes only its writer to one JSON event per line: `seat`, `chat`, `wake`, `pull`, `rows` and `health`.
- **The lease.** It takes a `delivery-NAME` lease (store kv, renewed on the health tick). The `monitors.json` tail sees a live lease and stays silent, so a session without modules still gets today's delivery.

| Event | Route | Replaces |
|---|---|---|
| `chat` (people's words, join/leave) | `$.ui.log(text)` (S4): stored as a `notice`-level row, drawn dim as `sub-human: <text>`, kept on `--resume`, never read by the model, no wake. (`$.session.append` system rows are `info`-level and show only under ctrl+o.) The model gets the same lines through the `pull` route | the wake whose only job was "output their chat lines exactly as given" (member.md), and `notices` "via prompt" `systemMessage` |
| `pull` (for Claude, no wake) | `$.session.append({message:{type:'user', content}})` (isMeta): in the model's next request from the loop's top | at-room's per-prompt "Room since your last turn" digest and cursor `ctx-NAME` (the tail advances it once the line is written) |
| `wake` (to me, `@me`, proposals, the orch's task requests) | idle → `$.prompt.submit({text})` (origin `plugin`, starts a turn once idle); mid-turn (a `turn.start` has no `turn.complete` yet) → the user `$.session.append`, as a monitor event folds into a running turn now | the Monitor's task-notification wake |
| `rows` (a missing row's Agent calls) | held in `$.state` and attached as `context` to the next composer `prompt.submit` | at-room's per-prompt `rowsNeeded`/`missingRows` listing. **The one forced row-adjacent change:** that call site moves from `hooks/at-room.js` to `lib/tail.js`; `lib/rows.js` is unchanged |

**2c. `@room`.** The `prompt.submit` origin gate (Part 1) replaces the peer-envelope check and the forgery checker. The post itself is still signed by `hooks/at-room.js` in node, through the `classic.UserPromptSubmit` shim.

**2d. Not needed.**
- `session.receive`: the `prompt.submit` origin already covers peers.
- `session.send`: logging Claude↔Claude messages into the room is a feature, not a migration (D6).
- `$.session.append` system notices: stored but drawn only under ctrl+o (S4), so `chat` uses `$.ui.log`.

## Waves

### W0: spikes and contract (lead + 1 agent; no module ships) — **done**

The spikes run in a throwaway plugin dir under `$TMPDIR/sh-mods-spike/` with its own `SUB_HUMAN_HOME`, loaded with `--plugin-dir`: an interactive tmux session named `sh-spike-*` and `-p` runs. They never touch `~/.claude/dev-mods`, `~/.sub-human`, the `sh-*` demo sessions or `scripts/demo.sh`.
- **S1** `hooks.json` with `hooks` + `modules: ["./register.mjs"]`, the entry importing `../mod/x.mjs`, passes `claude plugin validate --strict`, and both kinds fire.
- **S2** Modules load in a `claude --bg` worker (the orch) and in `-p`. If not: the orch keeps the Monitor and its command hooks permanently, and D1 applies to members only.
- **S3** The env and ppid of a `$.process.run` child: is `CLAUDE_PID` absent, and is the ppid the claude pid? This decides whether `resolveSeat` needs the payload's `session_id`, which every shim passes anyway.
- **S4** A `$.session.append` system notice is drawn, survives `--resume`, and a user row does not wake an idle session.
- **S5** `classic.Stop` → `{additionalContext}` continues the turn, as with a command hook. `classic.UserPromptSubmit` → `{preventContinuation, stopReason}` draws "✓ sent" as today.
- **S6** Order: `prompt.submit` (module) → `classic.UserPromptSubmit` (module) → the command UPS hook. Also: does `prompt.submit` fire for a peer delivery that arrives mid-turn?
- **S7** `tool.call` fires for a subagent's calls with `agentId` (the row agents' `hold`).
- **S8** `claude plugin test` runs here with Node 24 on PATH, and `npm test`'s gate detects "modules off".
- **S9** Latency: a `$.process.run` node child vs the same command hook, measured over 20 runs.

Then:
- CONTRACT entries (gate 5) plus the S2/S4/S6 anchors.
- The `hooks-modules` note fixed. `test/cc.test.js` "ships no hooks module" becomes "ships exactly one module, at the path hooks.json names".
- A short `docs/internals/cc-2.1.292.md` section, "Function hooks".

**Accept:** each S has an answer with evidence, the probe passes with the new entries, and a mutated new string fails. **Go/no-go:** a failed S1 or S5 stops the plan. S2, S4 or S7 change scope as noted.

#### W0 results

Measured 2026-10-07 on 2.1.292; full evidence in [`cc-2.1.292.md` → Function hooks](../internals/cc-2.1.292.md#function-hooks). Go: S1 and S5 pass.

| S | Result | Evidence (one line) |
|---|---|---|
| S1 | **pass** | `validate --strict` passes; `cmd.SessionStart` + `mod.session.start` and `mod.classic.UPS` + `cmd.UserPromptSubmit` both logged; `../mod/x.mjs` import loads. |
| S2 | **pass** | A `--bg` job and `-p` both ran `session.start`, `prompt.submit`, `classic.*`. The `--bg` dispatch prompt's origin is `composer`, `-p`'s is `sdk`. |
| S3 | ppid = claude; **no own `CLAUDE_PID`/session id** | Clean env: `CLAUDE_PID=unset SID=unset ROOT=unset`, `PPID`=claude. Nested in another Claude, the child inherited the *outer* `CLAUDE_PID` and session id. |
| S4 | **partial (scope change)** | `$.session.append` system row: stored, kept on resume, but level `info` = ctrl+o only. User row: isMeta, no wake. `$.ui.log`: drawn dim (`<plugin>: text`), stored at level `notice`, redrawn after `--resume`. |
| S5 | **pass** | `classic.Stop` `{additionalContext}` → `-p` result `CONTINUED` (Stop ran twice). `{preventContinuation, stopReason:'✓ sent'}` → `⏺ Operation stopped by hook: ✓ sent`, no model call. |
| S6 | **pass** | Order `prompt.submit` → `classic.UserPromptSubmit` (module) → command hook. A peer during a 20 s Bash: `prompt.submit` origin `peer` with `turnId`, same chain. |
| S7 | **pass** | `tool.call` `{tool:'Bash', agentId:'a3449b83…'}` inside a general-purpose subagent. |
| S8 | **pass** | `claude plugin test` under Node v24.15.0: pass/fail and exit 0/1. Modules off → `claude plugin test: hooks modules are turned off here (…)`, exit 1 (the skip signal). |
| S9 | `$.process.run` faster | Median over 20: `$.process.run` node child 26 ms (p90 34) vs the same command hook 35 ms (p90 41). |

Consequences for later waves:
- **Chat route (S4, D3).** `chat` lines go out with `$.ui.log`, not a `$.session.append` notice (Part 2b updated). `pull` stays the isMeta user append.
- **Shim env (S3).** The shim passes `CLAUDE_CODE_SESSION_ID: e.session_id` and `CLAUDE_PID: ''` (so `cc.claudePid` reads null instead of an inherited pid) besides `CLAUDE_PLUGIN_ROOT`. Hooks that need the pid (join, session-restore) stay command hooks, as planned.
- **`$` stays in the registering file (S1).** A module that passes `$` to an imported function does not load at all. `mod/core/shim.mjs` therefore holds only the pure stdout → `ClassicResult` translation; each `mod/*.mjs` that registers hooks makes its own `$.process.run` call (a local helper in that file is fine). Passing `on` to an imported `registerX(on)` is fine.
- **Generated files (S8).** Loading a module plugin with `--plugin-dir` writes `.claude-plugin/types/` (self-ignored) and a root `tsconfig.json`. W1 decides: commit `plugin/sub-human/tsconfig.json` or add it to `.gitignore`.
- **npm test gate (S8).** `test:mods` skips when the binary is older than 2.1.292 or `claude plugin test` prints `hooks modules are turned off`. A test answers `$` calls beneath the plugin with `{ value }` and needs an `on('classic.<Event>')` beneath a classic event.
- **Orch (S2).** No scope change: the orch can use the module. Its `--bg` prompt counts as `composer`, which matters only if the orch ever posts `@room` (it does not).
- **S7.** No scope change: the guard's `hold`-needs-`agentId` rule works.

### W1: skeleton, guard, drawing (3 agents in parallel) — **done**

**M1 skeleton and shim** (owns `hooks/register.mjs`, `mod/register.mjs`, `mod/core/{shim,seat}.mjs`, `hooks/mod-hello.js`, `mod/test/skeleton.test.ts`, `test/mod-core.test.js`):
- On `session.start` the mod runs `node hooks/mod-hello.js` with `{session_id}`.
- `mod-hello.js` writes the lease `<home>/sessions/mods/<sid>.json` through `identity` (atomic, 0600). It prints `{home, realHome, userHome, pluginRoot, seat: {name, code, role, addr} | null}`, which the mod keeps in `$.state`.
- Refresh after `classic.UserPromptExpansion` (join) and `classic.SessionStart`.
- The shim and its stdout → `ClassicResult` table.
- The lead adds `modules` to hooks.json and `test:mods` to package.json, and teaches `scripts/arch-doc.js` a "Function hooks (generated)" table, read from an exported `HOOKS` list in `mod/register.mjs`.
- **Accept:** validate is clean; the shim's translation table is unit-tested for every output shape the hooks emit today.

**M2 guard** (owns `hooks/guard.js`, `mod/guard.mjs`, `mod/core/guard.mjs`, `test/hooks/guard.test.js`, `mod/test/guard.test.ts`):
- `bashVerdict` and `homeSpellings` move to core. The `tool.call` deny and the `tool.check` allow (room tools for a seated session; `hold` only with `agentId`).
- `.catch` as in Part 1. The guard's 2 hooks.json entries go (under D1; under "dual path" they stay, see D1).
- **Accept:** `guard.test.js` passes against the moved verdicts, and the wiring test denies a Bash `cat ~/.sub-human/…`, a Write under a symlink to the home and `hold` from main.

**M3 drawing** (owns `mod/render.mjs`, `mod/core/chat.mjs`, `mod/test/render.test.ts`):
- Part 2a.
- **Accept:** the mounted row shows `bob's Claude: …` for a peer and the chat lines for a room notification; `isExpanded` returns the engine's row.

Commit: "Mods W1: module skeleton + shim, in-process store guard, group-chat drawing".

#### W1 results

Done 2026-10-07 by one agent, in order M1 → M2 → M3. `npm test` (plugin, scripts and `test:mods`), `npm run probe` (80/80) and `npm run validate` are green. Every gating hook has a `.catch` (6 of 6, checked from validate's JSON). Live check: one `-p` run with `--plugin-dir` and a throwaway home. The module loaded, the lease was written (0600), and `tool.call` denied `cat ~/.sub-human/…` ($0.18).

- **M1.** `hooks/register.mjs` → `mod/register.mjs` (`HOOKS` plus the skeleton hooks), `mod/core/{shim,seat}.mjs`, `hooks/mod-hello.js` (lease through the new `identity.writeModLease`/`readModLease`) and `types/index.d.ts`. hooks.json gets `modules`, package.json gets `test:mods` (`scripts/test-mods.js`, also run by `npm test`), and arch-doc gets the "Function hooks (generated)" table. The shim returns `systemMessage` beside the `ClassicResult`, which has no such field, so W2/W3 callers show it with `$.ui.log`.
- **M2.** The guard lives in `mod/guard.mjs` + `mod/core/guard.mjs`. `tool.call` denies Bash, the write family and `hold` without `agentId`, and `tool.check` allows room tools for a seated session. Write paths are checked lexically and through the `$.fs.stat` realPath of the nearest existing ancestor. **Removed from hooks.json:** both `hooks/guard.js` PreToolUse entries (`^(Write|Edit|MultiEdit|NotebookEdit)$|^mcp__plugin_sub-human_room__` and `^Bash$`). `hooks/guard.js` is deleted (D1: no fallback).
- **M3.** `mod/render.mjs` + `mod/core/chat.mjs` draw a peer row as `bob's Claude: …` (dim, `│` continuations, at most 20 lines) and a `plugin sub-human` row as its chat lines without the `(for Claude)` lines. Anything else, and every expanded row, goes to `next(e)`.

Deviations:
- **Room monitor notifications are not redrawn.** In 2.1.292 a task-notification row's `props.text` is only the `<summary>` (`Monitor event: "sub-human room"`). The event lines are not in the props, and the engine already draws the first one as the headline; a rewrite would lose that headline. So `render.mjs` leaves these rows to the engine (CONTRACT `usermessage-notification-summary`), and the "chat lines for a room notification" accept item is covered by the `plugin` origin W3 will use. Under D2 the Monitor goes in W4 anyway.
- **Files outside the listed ownership.**
  - `lib/identity.js`: the lease helpers.
  - `.claude-plugin/plugin.json`: `"types"`. Validate refuses an undeclared `$.state` value (CONTRACT `plugin-types-state`).
  - `test/hooks/security.test.js` (M4's in W2): it imports `bashVerdict` from the core now.
  - `test/{manifest,store-bypass,words,cc}.test.js` and `hooks/seat-key.js` comments.
  - `store-bypass` now walks `mod/*.mjs`.
- **Where checks live.** `hold` is denied in `tool.call`, not in `tool.check`: the test kit's `$.tool.call` raises `tool.call`, and `tool.check` carries no `agentId` on a query. `HOOKS` is checked against validate in node (`test/mod-core.test.js`), because plugin tests have no process. The test kit's `$` has no `state` noun, so the skeleton tests read the hello through the `tool.check` allow.
- **Before mod-hello answers.** Write paths through any `.sub-human` directory are denied, which is the plan's string rule applied to file tools.

Open, for W2+:
- Until W4's join refusal, a seat in a session with modules off has no store guard (the D1 trade-off, now live).
- `HOOKS` is hand-kept, but the test fails when it drifts from what validate reads.

### W2: per-turn costs (2 agents in parallel) — **done**

**M4 prompt gate** (owns `hooks/prompt.js`, `hooks/at-room.js`, `mod/prompt.mjs`, `mod/core/prompt.mjs`, `test/hooks/{at-room,prompt,security}.test.js`, `mod/test/prompt.test.ts`):
- The `prompt.submit` origin gate.
- The `classic.UserPromptSubmit` shim: no seat → no node; seated → node `prompt.js` as today.
- at-room reads `sub_human_origin`: `composer`/`sdk` (D4) → posts without `provisional` and without the checker; anything else → refusal; absent → today's logic (fallback).
- **Accept:** an unseated prompt starts no node; a peer `@room` is dropped before any hook; the security tests pass.

**M5 consent and tasks** (owns the output fields of `hooks/consent.js`, `hooks/tasks.js`, `mod/consent.mjs`, `mod/tasks.mjs`, `mod/test/{consent,tasks}.test.ts`):
- In shim mode (`SUB_HUMAN_SHIM=1`), consent adds `subHuman:{reviewOpen}` to its output.
- The `classic.Stop` shim with the flag; the room-tool prefilter.
- `classic.PostToolUse`/`classic.TaskCompleted` shims, orch only.
- The lead drops the Stop, the TaskCreate/TaskUpdate and TaskCompleted entries and the consent room-tool matcher.
- **Accept:** `consent-table.test.js` passes unchanged; a bench shows 0 node starts for a turn end with no review and for a room `post`; the TaskCompleted gate blocks in a wiring test.

Commit.

#### W2 results

Done 2026-10-07 by one agent (M4 then M5). `npm test` (plugin 337, scripts, `test:mods` 35), `npm run probe` (80/80), `npm run validate` and `bash -n scripts/demo.sh` are green; every gating hook has a `.catch` (13 of 13). Live check with `-p`, `--plugin-dir`, a throwaway home and a `node` on PATH that logs each start ($0.37): a seated `@room` posted signed with no `provisional` and no checker, and no model call ($0); a seated plain prompt ran `prompt.js` once and no `consent.js` at the turn end; an unseated prompt ran neither.

- **M4.** `mod/prompt.mjs` + `mod/core/prompt.mjs`: the `prompt.submit` gate (drops an `@room` whose origin is not composer, sdk or bridge) and the `classic.UserPromptSubmit` shim (no node when the hello says this session has no seat and the prompt is not an `@room`). The origin reaches the shim through a module queue, since the classic payload has none and `classic.UserPromptSubmit` runs inside `prompt.submit`'s `next(e)`. A lost hand-off means no `sub_human_origin`, and at-room keeps today's checks. at-room trusts `sub_human_origin`: composer/sdk/bridge post at once, anything else is refused.
- **M5.** `mod/consent.mjs`: the `reviewMaybeOpen` flag (`types/index.d.ts`), the `classic.Stop` shim, and a `classic.PreToolUse` room-tool prefilter. `consent.js` and `prompt.js` print `subHuman {reviewOpen}` under `SUB_HUMAN_SHIM=1`. `mod/tasks.mjs` runs `tasks.js` only for the orch, an unknown seat, or no seat with `SUB_HUMAN_ROOM` set. Its `.catch` blocks only in the orch's session.
- **Removed from hooks.json** (17 → 13 entries): UserPromptSubmit `prompt.js`, Stop `consent.js`, PostToolUse `TaskCreate|TaskUpdate` `tasks.js`, TaskCompleted `tasks.js`.

| Event | Before W2 | After W2 |
|---|---|---|
| a prompt, no seat | 1 | **0** |
| a prompt, seated | 1 | 1 |
| an `@room` post | 1 (+ the detached checker without `source`) | 1, never a checker |
| turn end (Stop) | 1 | **0** while no review may be open |
| a room MCP tool | 1 | **0** while no review may be open |
| a member's own `TaskCreate`/`TaskUpdate`/completion | 1 | **0** |

Deviations:
- **Consent's room-tool matcher stays in hooks.json.** `tool.call` and `classic.PreToolUse` get only the tool envelope, with no `permission_mode` or `transcript_path`, and `preRoomTool` needs both. So the mod does not shim it. While no review may be open, `classic.PreToolUse` on room tools answers `{}` without `next`. That means no decision: the normal permission flow runs, and the command hook beneath is skipped (CONTRACT `classic-chain-order` note). The cost is the same, but the user's own settings PreToolUse hooks are also skipped for sub-human's room tools.
- **The shims call `next(e)` and merge.** Ours comes first: our block or stop wins and the contexts join. The settings hooks beneath still run, as they did in parallel before. A TaskCompleted block returns without `next`.
- **A failed hello refresh** (join, `/clear`) keeps the last hello but sets its `sid` to null, so every prefilter runs node until a refresh works. Without this, a stale "no seat" would look certain.
- **The flag also clears on a seated prompt** (`prompt.js` reports it), so the first turn end after a start costs nothing either.
- `hooks/prompt.js` stays in W2 (deleted in W3, as planned). Files outside the listed ownership: `mod/register.mjs`, `mod/core/{shim,prefilter}.mjs`, `types/index.d.ts`, `test/mod-core.test.js`, `test/hooks/consent.test.js`, the README threat model, and `docs/ARCHITECTURE.md` (the hand-written performance and security lines).

Open, for W3+:
- `@room` origin attestation needs the module. A session with modules off still uses `source` and the checker until W4 deletes them (D1).

### W3: delivery (1 agent, then 1)

**M6 tail child** (owns `lib/tail.js`, `bin/sub-human`, `lib/notices.js`, the `delivery-NAME` kv key in `lib/room/store.js`, `test/{tail,cli,notices}.test.js`):
- `tail --ndjson` (Part 2b), the lease, and the Monitor tail yielding to a live lease.
- The `pull` and `rows` events.
- **Accept:** on the fake clock, a member's batch comes out as `chat` + `pull`, a `@me` line as `wake`, and with the lease live the Monitor tail prints nothing.

**M7 mod delivery** (owns `mod/deliver.mjs`, `mod/test/deliver.test.ts`, `skills/sub-human/member.md`, at-room's `pullDigest`/`noticeLines`/rows listing, which are skipped when the shim says the delivery lease is the mod's):
- The routing table in Part 2b; `turn.start`/`turn.complete` decide idle vs mid-turn.
- `sessionTitle` is computed in the mod from `seat.addr`, once per session id (`$.state`).
- "working" presence (Part 1).
- member.md drops "output their chat lines exactly as given" (D3).
- **Accept:** a wiring test shows that a `chat` event appends a system row and starts no turn, a `wake` while idle submits one prompt, and a `wake` mid-turn appends.

Commit.

### W4: cut-over and verify (lead + 1 demo agent)

- Per D1/D2, delete the fallbacks (next section).
- Join refuses without the hello lease: "sub-human needs Claude Code 2.1.292+ with function hooks on; not in --bare or safe mode".
- README requirement line; `npm run docs`.
- Run `npm test`, `npm run test:mods`, `npm run probe` and `npm run validate`.
- Live demo S1–S10 (only when the user asks). Deterministic checks must pass. Behavioural: wakes (baseline 18) and noise should drop; model calls per chat burst should drop to 0 under D3.
- Walkthrough; commit.

## What gets deleted (after W4, with D1 + D2 + D3)

- `hooks/guard.js` (132 lines; about 90 move to `mod/core/guard.mjs`) and its 2 hooks.json entries.
- `hooks/prompt.js` (57 lines) and its UPS entry; `test/hooks/prompt.test.js` (68 lines).
- In `hooks/at-room.js`:
  - the forgery checker, `promptOrigin`, the provisional write and the `source` branch (about 75 lines);
  - `pullDigest` and `noticeLines` (about 60 lines);
  - the per-prompt rows listing (moved to the tail).
- In `lib/cc.js`: `isPeerPrompt`, `entryIsPeer`, `isPeerText`, `PEER_PREFIX` and the CONTRACT entries `ups-source`, `peer-origin` and `peer-held-prefix` (about 45 lines).
- `store` provisional writing (about 15 lines; reads stay for old logs and `mcp/hold.js`).
- `notices` "via prompt" (about 15 lines).
- `monitors/monitors.json` and the Monitor-only supervision in `lib/tail.js` (about 30 lines), under D2.
- hooks.json entries: Stop, PostToolUse TaskCreate/TaskUpdate, TaskCompleted, and consent's room-tool matcher.
- Tests for the deleted paths: forgery cases in `security.test.js`, digest and notice-on-prompt cases (about 150 lines).

**Estimate.**

| | Added | Deleted |
|---|---|---|
| Production | about 900 (`mod/*.mjs` about 350, `mod/core/*.mjs` about 270 incl. 90 moved, `mod-hello.js` 40, `tail --ndjson` + lease 90, at-room origin branch 15, CONTRACT 45, arch-doc 50) | about 520 (90 of it moved) |
| Tests | about 450 (`mod/test/*.test.ts` about 300, node core about 150) | about 300 |
| **Total** | **about 1,350** | **about 820** |

hooks.json goes from 21 command entries to 12.

## Risks

1. **The module can be switched off.** Causes: the GrowthBook flag `tengu_plugin_hooks_modules` (default on), `--bare`, safe mode, managed `disableAllHooks`/`allowManagedHooksOnly`, or an untrusted workspace. Then the moved entries no longer run. Mitigation: D1. Join refuses cleanly, the hello lease is the test, and the probe watches the flag's default.
2. **Early-access API.** "The API is early access and moves between releases." Mitigation: the CONTRACT entries, `npm run test:mods`, validate's gating report in `npm test`, and the types read again per version in `docs/internals/`.
3. **Hooks fail open.** A hook that throws or overruns is skipped. Mitigation: every gate has `.catch` (asserted from validate's report); the fail-closed scope matches today's guard.
4. **Reload or a lost worker.** Module variables are lost and children are killed. Mitigation: state lives in `$.state`; prefilters run node when unsure; the tail child restarts on `session.start`; a `$.prompt.submit` made after a hook returned may repeat. The `wake` dedupe uses the tail's cursor, so a repeat costs at most one duplicate wake.
5. **Identity.** Mod-run children have no `CLAUDE_PID` (S3), so the shims pass the payload `session_id`. `join` and `session-restore`, which need the pid, stay command hooks.
6. **Security.**
   - The model cannot reach `$`.
   - The shim's `sub_human_origin` field rides in stdin. A Bash `node hooks/at-room.js` with forged stdin is refused by the guard's string check, which is the same limit as today.
   - The in-process guard keeps the same string rules.
   - `via=human` is still signed only in hook processes. `test/hooks/security.test.js` gains: "the mod and `mod/core` never import `seat-key`", and "no file under `mod/` writes under the home".
7. **Delivery semantics.**
   - A pull line is at most once if the mod dies between the child's write and the append (D8).
   - The lease gap at a crash is up to one lease TTL before the Monitor resumes.
   - A `prompt.submit` wake is framed "The sub-human plugin sent a message", which differs from a task notification; member.md and orchestrator.md wording is checked in the demo.
8. **The orch is headless.** If S2 fails, the orch stays on the Monitor and command hooks, which leaves two paths for the life of the plan.
9. **Testing cost.** `claude plugin test` spawns binary children, so the suite gets slower. Keep the wiring tests few and the logic in `mod/core` (node).
10. **Display.** `$.ui.log` rows are dim engine rows with a forced `sub-human: ` prefix that the mod cannot style, and consecutive identical lines may fold. If that reads too faint in the demo, use D3's alternative.

## Decisions for the user

1. **D1: require function hooks for a seat?** **Decided 2026-10-07: yes.** Recommended: yes. Join refuses without the module, and the moved entries leave hooks.json, which is where the savings come from. Alternative: a permanent dual path, where moved entries stay and exit early when the hello lease is live. That is correct, but it saves no node starts and doubles the test surface. The trade-off: a non-member session with modules off loses the store guard. The threat model covers members' Claudes, so this is within it.
2. **D2: drop the Monitor after W3?** **Decided 2026-10-07: yes, in W4.** Recommended: yes, in W4, unless S2 shows the orch needs it. Keeping it costs one idle node per session and buys delivery while the module is off (and with D1, such a session has no seat anyway).
3. **D3: chat lines as stored notices (`$.ui.log`, per W0 S4) plus an isMeta copy for the model?** **Decided 2026-10-07: yes (notices).** This means no wake and no echo for people's words. Recommended: yes. It cuts a model turn per chat burst and removes member.md's "print as given". Alternative: keep the wakes and only restyle the rows with `ui.render` (W1 alone).
4. **D4: which origins may `@room`?** **Decided 2026-10-07: add `bridge` (Remote Control).** Today: `user`, `sdk` → `composer`, `sdk`. Add `bridge` (the person through Remote Control on their phone)?
5. **D5: move the member/orch role text into a `prompt.compose` session section?** It survives compaction, so session-restore no longer re-injects on `compact`, at the cost of one prompt-cache miss at join. Optional, after W4.
6. **D6: out of scope, for later.**
   - `$.agent.spawn` rows: it would change the rows, so it is excluded now.
   - `session.send` logging of Claude↔Claude messages in the room.
   - An `AbovePrompt` room band.
7. **D7: module language.** Recommended: `.mjs` + JSDoc, with no build and `mod/core` importable by node 20. Alternative: `.ts` modules, which needs Node 22.6+ type stripping for the node tests (an `engines` bump).
8. **D8: pull delivery at most once (simple) or acked?** An acked pull means the mod confirms by `$.process.run` before the tail advances `ctx-NAME`, which costs one node start per pull batch.
