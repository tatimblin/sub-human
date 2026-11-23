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

**Kit facts this plan relies on.** Each needs a check against the refreshed 2.1.330 typings in M0:
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

- **Command hooks.** Each `hooks.json` handler (the `/sub-human` expansion, `SessionEnd`, and the policy-surviving plan and title hooks, F7) runs with recorded stdin fixtures. The tests assert its stdout `Reply` and exit code, and that nothing is written to stderr on success.
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

Any failure files one line per feature, and turns that feature off through `SUB_HUMAN_CC_OFF` until it's fixed.

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

## 11. By milestone

| Milestone | Tests that land with it |
|---|---|
| M0 | `node:test` harness; kit smoke test; vendored files and their drift check; fixtures capture script and the first recording; store contract on the memory store; schemas and Noise vectors |
| M1 | unit tests for `deliver`, `activity` and the filter; module tests for capture, context, status, news, messages (including the sender-side risk test), wakes and tools; edge tests for command hooks and the bridge |
| M2 | plan rules; card and pane module tests; R19's properties |
| M3 | task rules and the bridge mapping; TaskCreate and TaskUpdate fixtures |
| M4 | network tests (§6); the fake `ssh` and `tailscale`; the manual Funnel check |
| M5 | relevance and overlap tuning from live-gate metrics |
| M6 | the full live gate; canary green on `latest` and `next` |
