# sub-human v2: Architecture

How v2 is built. It is the design for `docs/PRD.md`; requirement numbers (R…) and questions (Q…) refer to that document. The 0.8 proof of concept's architecture is archived in `docs/archive/ARCHITECTURE-0.8.md`.

## 1. Shape in one paragraph

Each Claude Code session in a room runs two pieces of sub-human:
- a **hooks module**, in-process, which watches the session's work, delivers updates to it and draws the status line;
- an **MCP server**, which gives that session's Claude a few tools.

One machine is the room's **host**. It holds the room's **log**, an append-only list of entries, and applies every write. Other machines keep a **mirror** of the log, fed by one **link** per room over Tailscale or ssh. Everything a person sees and every piece of context a Claude gets is computed by pure functions over the log. Everything else is a thin adapter around those functions.

```
 machine A (host)                                          machine B
┌─────────────────────────────────────────┐              ┌──────────────────────────────┐
│ Claude Code session (alice)             │              │ Claude Code session (bob)    │
│  ├─ hooks module ─┐   ├─ MCP server ─┐  │              │  ├─ hooks module  ├─ MCP     │
│  │ capture·deliver│   │ share·read·  │  │              │  │                │          │
│  │ status·plans   │   │ plan·task    │  │              │  └──────┬─────────┴───┬──────┘
│  └───────┬────────┘   └──────┬───────┘  │              │         │ MirrorStore │       │
│          └── FsStore (host) ─┘          │◄── link ────►│   link daemon (1 per room)    │
│   rooms/CODE/log.jsonl  docs/  plans/   │  Tailscale   │   rooms/CODE/ (mirror copy)   │
│   listener 127.0.0.1 ← tailscaled/sshd  │  or ssh      │                               │
└─────────────────────────────────────────┘              └───────────────────────────────┘
```

## 2. Code principles

These hold for every module; review against them.

1. **Pure core, thin edges.** Rules live in `core/` as pure functions of `(state, input, now)`: folds, delivery, relevance, plan and task rules, the link state machine. Edges (module, MCP, store, net) only translate events and do I/O. Every edge stays under about 150 lines.
2. **One way to do each thing.** One transport layer, one handshake, one store interface, one delivery function. No fallback chains (PRD C3): a feature either works or says, in one line, that it's unavailable.
3. **Names are the glossary.** These are used in code, copy and docs alike: room, code, host, member, invite, update, plan, version, agree, task. There are no private nicknames (row, keeper, seat, lane, tail, walk). A name that needs a comment to explain it is the wrong name.
4. **Inject time and I/O.** Clocks, randomness, the store and the transport are parameters. Tests use a fake clock and the memory store; nothing reads an env var for test timing.
5. **Types at the boundary, schemas in.** Data from disk, the wire or Claude Code passes through one valibot schema per shape (`core/schema.ts`) and is typed after that. No `any`, no unchecked casts, and no `!` in runtime code.
6. **Every Claude Code fact is in the contract.** Each `$` call and each event field the plugin relies on is listed in `contract.json`, marked `API` (in the typings) or `internal`. Internal entries are capped at 10 (PRD C2). One table (§9) maps each requirement to the surfaces it uses.
7. **Small budget.** At most about 10k runtime lines (§11). Adding a feature means deleting something, or showing it fits.
8. **Use open source for solved problems** (PRD C6). We write the product; maintained libraries do everything else. Each dependency is pinned and wrapped behind one small module of ours, so it can be swapped without touching callers. See §2a for the list.

## 2a. Dependencies

Small, single-purpose packages with few or no dependencies of their own. Each one maps to a problem we would otherwise write ourselves.

| Problem | Package | Size, deps | Replaces in the POC | Status |
|---|---|---|---|---|
| Validating outside data | `valibot` | 1.8 MB, 0 deps | the hand-written decoders | chosen |
| Locks on the host store | `proper-lockfile` | 29 KB, 3 deps | `lock.ts` | chosen |
| Crash-safe document writes | `write-file-atomic` | 12 KB, 1 dep | ad-hoc temp-and-rename | chosen |
| Not sharing ignored, excluded or secret files (R12, R14a) | `ignore` | 131 KB, 0 deps | none (new); gitignore semantics, used for our own patterns too | chosen |
| Showing what changed between plan versions | `diff` | 601 KB, 0 deps | none (new) | P1 |
| Invite plus Let in | `blind-pairing` | ~13 MB with `hyperswarm`, mostly udx-native binaries | `invites.ts`, `admission.ts` (≈580 lines) | Q14 spike |
| Peer connection without Tailscale | `hyperswarm` | (with the row above) | none (an optional third pathway) | Q14 spike |
| WebSocket, only if Funnel raw TCP fails on restrictive networks | `ws` | small | `ws.ts` (346 lines) | fallback only |

The chosen set is about 2.5 MB with no native code; valibot is most of it.

**Ours on purpose**

| Piece | Why we keep it |
|---|---|
| **The channel**, `net/channel.ts` | This is the POC's `noise.ts`: Noise XK on `node:crypto`, 280 lines, zero dependencies, already passing the published cacophony and snow vectors. Its alternatives were weighed: `@hyperswarm/secret-stream` brings 19 MB of sodium-native; Node TLS with pinned keys needs certificate generation; `@chainsafe/libp2p-noise` pulls in libp2p. The Noise spec is frozen and the vectors run in CI, so the code we own is small and has a fixed target. |
| **The log** | A hash-chained JSON-lines file in `store/` (§4), a few hundred lines. Presence and focus stay JSON documents. |
| **Tailscale control** | No maintained package exists; `net/pathways/tailscale.ts` drives the `tailscale` CLI. |
| **The stdio MCP server** | About 150 lines of JSON-RPC. `@modelcontextprotocol/sdk` is 4.4 MB with 17 dependencies (express, hono, ajv, zod and more), mostly HTTP server code we would never run. |
| **A PROXY-line parser** | One line, about 20 lines of code. |

**From Node or the system:** `node:crypto` (keys, hashes, ids), `node:util` (`parseArgs`, `styleText`), `node:test` with `mock.timers`, `fs.watch`; the `ssh`, `git` and `tailscale` commands. The person's own ssh config, agent and `known_hosts` are respected.

**Not used**
- **Hypercore, Autobase, Hyperbee.** v2's log has one trusted writer, and mirrors want the whole log, so peer replication, Merkle proofs and sparse sync buy nothing. Autobase's multiple writers would only help host failover, a PRD non-goal. Hypercore 11 also pulls in `rocksdb-native`, about 126 MB.
- **`@peculiar/x509`, `node-forge`:** we don't need TLS certificates.
- **`chokidar`:** watching one log file needs nothing more than `fs.watch`.
- **`ssh2`:** it would ignore the person's own ssh config, agent and `known_hosts`.
- **git libraries:** repo and branch come from the hooks module, and anything else is one `git` command.
- **Secret scanners:** we use a curated MIT pattern list (from gitleaks) as data, matched with `ignore` and a few regexes.

Dependencies reach the user either vendored in the plugin directory or installed into its data directory on first run (PRD Q13, decided in M0).

**Packages we could publish.** We only publish what nobody else offers (checked 2026-11-22):
- `tailscale-expose`, for giving a local port a Funnel or Serve URL with conflict handling. It is built as `net/pathways/tailscale.ts` behind a clean interface, and published once v2 is stable. The name appears free on npm.
  - **No library does this today.** Tailscale's own programmatic route is Go's `tsnet`. The closest npm packages are:
    - `tailscale-proxy`: an interactive tool for path-based proxying;
    - `@sproutseeds/tailnet-app`: manages Serve only, and only for one app's workflow;
    - `@monopi/remote-tailscale`: per-session token links and QR handoff;
    - Tailscale MCP servers: read-only diagnostics, or Tailscale's cloud API.
  - **Talk to the LocalAPI, not the CLI.** Read and update the `ServeConfig` through tailscaled's LocalAPI (`/localapi/v0/serve-config`): a Unix socket on Linux, or a loopback port plus password for the sandboxed macOS app. This replaces shelling out to `tailscale serve`/`funnel`. A compare-and-set on that one JSON object makes "remove my forward without breaking another app's" deterministic.
  - **Find Tailscale on every install type.** On macOS, the App Store and GUI installs keep the binary at `/Applications/Tailscale.app/Contents/MacOS/Tailscale` and often off `PATH`; Homebrew installs use `tailscaled`. Linux and WSL differ again.
  - **Handle the limits** the spike hit: Funnel ports are 443, 8443 and 10000 only; raw TCP can't share a port already serving HTTPS; Serve and Funnel collide on the same port.
  - **Before relying on the LocalAPI, a spike should check two things:** the exact `ServeConfig` schema and its compatibility across versions, since the LocalAPI is not a stable public API; and the macOS app's socket and credential discovery.
- `cc-contract`, the contract probe and canary for Claude Code internals. Nothing comparable was found. Published if other plugin authors ask for it.

Not published:
- A fake `$` host: Claude Code's official test kit already does this.
- `cc-activity`: Claude Code's typings already type every tool result, and several observability tools capture tool calls (raindrop, claude-observer, disler's multi-agent observability). Our classifier stays as `core/activity.ts`.

The room protocol and channel stay internal.

## 3. Layout

```
plugin/sub-human/
  core/            pure: no node:fs, no net, no Claude Code
    entries.ts       entry and document types; the 15 kinds (§4)
    schema.ts        valibot schemas for everything read from outside
    fold.ts          log → RoomState (members, presence, focus, plans, decisions, tasks)
    deliver.ts       (entry, member, state) → none | context | notice | wake; relevance (R15c)
    plans.ts         CAS edit, ask, answer, decide; owners on parts → tasks
    tasks.ts         add, claim, release, done, blockedBy; bridge tags
    activity.ts      tool result → activity update (edits, commits, tests, task tools); secret filter
    brief.ts         RoomState → catch-up text (R16), size-bounded
    link-engine.ts   reconnect state machine (clock injected)
    protocol.ts      wire messages, version and caps
  store/
    store.ts         RoomStore interface
    fs-store.ts      host: log file, documents, plan blobs, locks
    mirror-store.ts  remote: local copy plus writes sent to the host
    memory-store.ts  tests
  module/          the hooks module (Claude Code edge)
    register.ts      wires the event handlers below; nothing else
    capture.ts       tool.call → activity; task-tool mirroring (R12, R23)
    follow.ts        follows the store; feeds deliver()
    context.ts       prompt.context: updates since the last turn (R15a)
    status.ts        ui.status line (R15b)
    wake.ts          prompt.submit at turn end (R10)
    plans.ts         plan-mode hooks: group or personal, send, review in the plan view (R18–R22e)
  mcp/
    server.ts        tools: share, read, plan, task (§6)
  commands/        /sub-human verbs, one small file each: (bare), invite, join, who, tasks, leave, kick, help, doctor
  net/
    channel.ts       Noise XK over any Duplex (the POC's noise.ts, kept; vectors in CI)
    pathways/        tailscale.ts (Funnel | Serve), ssh.ts, pipe.ts (tests)
    host.ts          host side: accept, handshake, admission, serve ops
    link.ts          joiner side: the link daemon running link-engine
    invite.ts        invite lines, secret, admission requests
  keys.ts          machine key, link keys
  home.ts          where files live (~/.sub-human)
  config.ts        the knobs (§10)
test/              scenes (§12) and unit tests, beside the code they test
```

## 4. Data model

**The log** (`rooms/CODE/log.jsonl`) is append-only JSON lines.
- Each entry: `{id, at, prev, from, by, kind, …}`.
- `from` is the member. `by` is `person`, `claude` or `system`, a label only (R35).
- `prev` is the hash of the previous line, so a mirror detects a fork (R36).
- Only the host appends.

| Kind | Written by | Meaning |
|---|---|---|
| `joined`, `left` | system | membership, with repo, branch and machine |
| `activity` | module, mechanically | edits, commits, test results, personal task changes (R12, R23) |
| `finding` | the member's Claude (`share`) | one-line update in its own words (R13) |
| `post` | person (`@room`) or Claude | addressed words; optional `to` (R7, R8) |
| `plan` | host on CAS edit | a plan version: name, version, blob hash, base, kind group/personal |
| `plan_ask` | Claude for its person | agreement requested on one version from named members |
| `plan_answer` | person, from their plan view | agree, or ask for changes plus a note |
| `decision` | system | everyone named has answered |
| `plan_sent` | person (send choice) | a personal plan sent to a member or the room, with branch, files and note |
| `plan_accept` | person | recipient accepted or dismissed a sent plan |
| `task` | system | full task snapshot after any task op (add, claim, release, done) |
| `invite`, `admit`, `kick` | host | admission records; never contain the secret |

**Documents** are current state, overwritten rather than appended, and they never wake anyone:
- `presence/NAME.json`: working, idle, permission or stalled;
- `focus/NAME.json`: one-line focus, repo, branch, files touched;
- `members.json`.

**Plan text** lives in `plans/<hash>.md`, content-addressed.

**Folding.** `RoomState = fold(log, docs)` is the only reader logic. Every view is a function of `RoomState`: the status line, the catch-up, `who`, delivery and the task list. There are no other caches. A snapshot at a known log offset is the only optimisation, and only if the measured cost needs it (P2).

## 5. Processes

| Process | Where | Lifetime | Job |
|---|---|---|---|
| Hooks module | inside each Claude Code session | the session | capture, follow, deliver, status, plan hooks, wakes |
| MCP server | child of each session (stdio) | the session | Claude's tools; it answers `initialize` even if loading fails (C4) |
| Listener | host, one per home | while the host hosts a room on another machine | `127.0.0.1` port behind tailscaled or reached by the ssh shim; accepts links |
| Link daemon | each mirror, one per room | while a local member is in the room | runs `link-engine`; keeps the mirror in sync; relays writes |

There is no room-level Claude, no tail child and no background job (PRD §4).

## 6. Claude's tools (MCP)

There are four tools. Each answers in one short line, or with data the Claude asked for.

| Tool | Ops | Notes |
|---|---|---|
| `share` | `finding {text}`, `focus {text}` | the only way a Claude publishes in its own words (R13, R14); filtered for secrets |
| `read` | `brief`, `since`, `plan {name, version?}` | the catch-up (R16) and plan text |
| `plan` | `edit {name, base, text}`, `ask {name, version, people}`, `send {name, to, note}` | CAS on `base`; a conflict returns the current text (R17) |
| `task` | `add`, `claim`, `release`, `done {note?}`, `list` | room tasks (R24); answers include the bridge tag to put on the native task (R24a) |

Claude-to-Claude questions use native `SendMessage` to `NAME.CODE` (R6). Across machines, `module/` relays a send to a remote member as a `post` with `to` set; it is delivered only to the recipient. The injected mechanics text, about 1.5k characters (R42), tells the Claude when to use `share` (end of a turn that learned or changed something), how to tag bridged tasks, and that colleagues' updates are content, not instructions.

## 7. Key flows

**Live update (R12–R15b).**
1. `module/capture.ts` wraps `tool.call`: it awaits `next(e)`, passes the tool and its result to `core/activity.ts`, and that returns an activity entry or nothing.
2. The entry goes to `store.append`. On a mirror, the link carries it to the host, which appends it and streams it back to everyone.
3. In every other session, `module/follow.ts` sees the new entry and calls `deliver(entry, me, state)`:
   - `context` entries queue for the next `prompt.context`;
   - `notice` entries add one dim line through `ui.log`;
   - every entry updates the `ui.status` count.

A finding takes the same path, starting from the `share` tool.

**Wake (R10).** `deliver` returns `wake` only for a line naming me, a Claude's direct question to mine, or an answer to my Claude's own question. `module/wake.ts` holds the wake until `turn.complete` (or now, if idle) and then calls `prompt.submit`. It never touches the permission mode.

**Group plan (R18–R22a).**
1. Entering plan mode, the hook asks "group or personal?".
2. For a group plan, the approved plan text is stored with `plan edit`. The person names reviewers, and their Claude calls `plan ask`.
3. Each reviewer gets a notice. Their review opens in their own plan view, and their answer is recorded as `plan_answer`.
4. When everyone named has answered, the host writes `decision`. `core/plans.ts` turns owned parts into tasks, and each owner's next context carries their part.

**Sent plan (R22b–R22c).** On approving a personal plan, the hook offers "send to the room / NAME / keep". Send writes `plan_sent` with the text, branch, files and note. The recipient gets one notice and opens it in their plan view. Accepting writes `plan_accept`, and their context then carries the plan.

**Task bridge (R23–R24a).** This is on only when `$.tool.list` shows TaskCreate. The person opts in with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` at launch. Without it, room tasks work through the `task` tool alone.
1. A room `task claim` answers with the tag `[room CODE#N]`. The Claude creates its native task with that tag in the subject, and with `metadata {room, roomTask}`.
2. `capture.ts` wraps `tool.call` on TaskCreate and TaskUpdate. It keeps a map of (session, taskId) → {subject, tag}, filled from create results and rename inputs, because update results carry neither.
3. A `statusChange.to` on an untagged task becomes activity. On a tagged task, `completed` maps to room `done`, and `deleted` or reopening maps to `release`.
4. Subagents' calls arrive the same way, with `agentId`.

No Claude Code task file is read or written, and the mirror never waits on a deletion event, because auto-reset and retention delete tasks silently.

**Remote join (R29–R31).**
1. The host runs `/sub-human invite --public | --tailnet | --ssh`, which mints a secret bound to the host's key and prints one line.
2. The joiner types `/sub-human join LINE`. `net/link.ts` dials through the line's pathway and runs Noise XK against the host key named in the line. The secret travels only inside that channel.
3. The host's module shows **Let in / Refuse** through `ui.ask`.
4. On Let in, the host binds the joiner's link key, and the mirror syncs from offset 0.

## 8. Network

- **Pathway interface.** One interface, `{dial(line): Promise<Duplex>, listen?(port): Stop}`. Pathways only produce byte streams; everything above them is shared.
  - `tailscale` runs `tailscale funnel` or `tailscale serve` to the listener. The default is TLS-terminated TCP, which needs no WebSocket code. It has passed a local spike, but a run on real Funnel is still pending. A WebSocket fallback is kept only if restrictive-network testing demands it (Q2).
  - `ssh` runs `ssh HOST <home>/bin/serve` over the joiner's own login.
  - `pipe` is for tests.
- **Channel.** `net/channel.ts` runs Noise XK (`Noise_XK_25519_ChaChaPoly_SHA256`) on every pathway's stream (R29c). It is the POC's `noise.ts`: `node:crypto` primitives only, no dependencies, checked against the published vectors in CI.
  - The joiner already knows the host's key from the invite. Only that key can complete the handshake, so the secret is never sent to anyone else.
  - The joiner proves its own key in the third message, and that key becomes the link's identity, so a link is a key, not a token.
  - Messages are length-prefixed frames of at most 64 KB.
- **Protocol.** Length-prefixed JSON frames. The hello carries the protocol version and caps (R33). The ops are `append`, `put_doc`, `put_blob`, `subscribe {after, hash}`, `ping`. Each write fails fast while offline, except a person's `post`, which queues for a bounded time (R32).
- **Link engine.** `core/link-engine.ts` is pure, `(state, event, now) → (state, effects[])`. It covers backoff, heartbeat, sleep and network-change detection, and fork. `net/link.ts` executes the effects.
- **Host checks.** Each write's `from` must be a member bound to that link. System kinds from links are refused. Writes are rate-limited per link on `append` and `put_blob` (R37, R40).

## 9. Claude Code surfaces

Every row is an M0 check against the committed typings. "API" means it appears in `typings/claude-code`.

| Need | Surface | Status |
|---|---|---|
| Capture tool results (edits, Bash, task tools) | `tool.call` middleware, `await next(e)`; typed results (`BuiltinToolResults`) | API (Q11 confirmed the TaskCreate and TaskUpdate shapes on 2.1.296) |
| Whether the session has native task tools | `tool.list` | API; *why* they are off (the env var and model list) is internal (1 of 10) |
| Context on the next turn | `prompt.context` | API |
| Status line | `ui.status` | API |
| Dim notice line | `ui.log` | API |
| Let in / Refuse; group-or-personal question; send-or-keep choice | `ui.ask` | API |
| Wake at turn end | `turn.complete` plus `prompt.submit` | API |
| Presence (working or idle) | `turn.start`, `turn.complete` | API; "waiting on a permission prompt" source to confirm |
| Repo and branch | `session.repo` | API |
| Plan-mode entry, approval, plan view for review | plan-mode events | **to confirm in M2** (Q7, Q8); internal entries count against C2 |
| Relay `SendMessage` across machines | `session.send` | API |
| `NAME.CODE` addressing | session title | internal (1 of 10) |
| `/sub-human` command, session end | command hooks (`UserPromptExpansion`, `SessionEnd`) | documented hooks |
| Claude's tools | plugin MCP server | documented |

## 10. Configuration

Seven knobs, read only by `config.ts`:

| Knob | Values |
|---|---|
| `SUB_HUMAN_HOME` | where the plugin keeps its files |
| `SUB_HUMAN_NAME` | default member name |
| `SUB_HUMAN_INVITE` | default pathway: `public`, `tailnet` or `ssh` |
| `SUB_HUMAN_SSH_ADDR` | how others reach this host over ssh |
| `SUB_HUMAN_PORT` | listener port |
| `SUB_HUMAN_DEBUG` | verbose debug log |
| `SUB_HUMAN_CC_OFF` | turn a gated feature off |

Timings are constants in `config.ts`. Tests pass their own values in through parameters.

## 11. Size budget

| Area | Lines (max) |
|---|---|
| `core/` | 2,500 |
| `store/` | 800 |
| `module/` | 1,500 |
| `mcp/` | 400 |
| `commands/` | 700 |
| `net/` (channel 300, pathways 600, host, link, invite) | 2,100 |
| keys, home, config, CLI, doctor | 1,000 |
| **Total** | **≈ 9,000** (≈ 8,400 if Q14's blind-pairing replaces our invite code) |

A pull request that pushes an area over its line is either split or comes with a deletion.

## 12. Testing

- **Unit tests, beside each `core/` module.** Pure inputs in, outputs out. Every delivery rule and every plan and task rule is a table test.
- **Scenes** (`test/scenes/`). Each PRD story (S-Live, S-Relevant, S-Ask, plan together, send a plan, split, join, remote join, leave) runs as a script against the memory store, using Claude Code's own test kit for hooks modules (`claude plugin test`, the `claude-code/testing` module). The kit sends events through the module's hooks with no session, sign-in or network. Its stubs answer in Claude Code's place and record the module's `ui.*` and `prompt.*` calls, and `mock.clock` gives the fake clock. We don't build a fake host of our own. Assertions cover what each member sees (at most 6 lines, R41), what each Claude's context holds, and that only R10 events wake anyone. There is no live model, and CI runs every scene.
- **Network.** `link-engine` table tests on the fake clock. Two homes over `pipe` for sync, fork and kick. Noise vectors. A TLS front stands in for tailscaled.
- **Live gate.** One scripted run per release with real Claude sessions, in each permission mode, covering a no-plan pairing, a plan-then-build and a non-code task (PRD Q-2). It records tokens per hour (Q9) and lines per person.
- **Canary.** Nightly, against Claude Code `latest` and `next`: the contract probe plus a typings diff (C1).
- **Ratio.** Test code no larger than runtime code.

## 13. Build order

| Milestone | Delivers | First proof |
|---|---|---|
| M0 | core types, decoders, fold, memory store, scene harness, §9 table checked | S-Live passes under `claude plugin test` |
| M1 | fs-store, module (capture, follow, context, status, wake), MCP `share` and `read`, commands | two real sessions on one machine; a change reaches the other Claude in under 5 s |
| M2 | plans: CAS, group and personal, send, review in the plan view | plan-mode events confirmed (Q7, Q8) |
| M3 | room tasks; opt-in native bridge | a claimed room task appears in a person's native list, and completing it there closes the room task |
| M4 | net: channel, tailscale and ssh pathways, invite and admission, link engine, mirror | a join over Funnel from a machine with no Tailscale |
| M5 | relevance tuning, overlap heads-up | live-gate noise rating |
| M6 | release | live gate green; README of at most 200 lines |
