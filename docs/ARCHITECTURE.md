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
3. **Names are the glossary.** These are used in code, copy and docs alike: room, code, host, member, invite, update, plan, version, agree, task.
   - There are no private nicknames (row, keeper, seat, lane, tail, walk).
   - Engineering names (mirror, link, pathway, listener) are for code and this document only, and never appear in copy.
   - A name that needs a comment to explain it is the wrong name.
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
| The diff since the last version, on the review card (R21) | `diff` | 601 KB, 0 deps | none (new) | chosen (M2) |
| The Funnel wire: WebSocket over HTTPS, proxy-friendly (R29a) | `ws` | small, 0 deps | `ws.ts` (346 lines) | chosen |
| Peer connection without Tailscale | `hyperswarm` | ~13 MB, mostly udx-native binaries; UDP only | none (an optional third pathway) | P2, opt-in (Q14) |

The chosen set is about 3 MB with no native code; valibot is most of it.

**Ours on purpose**

| Piece | Why we keep it |
|---|---|
| **The channel**, `net/channel.ts` | This is the POC's `noise.ts`: Noise XK on `node:crypto`, 280 lines, zero dependencies, already passing the published cacophony and snow vectors. Its alternatives were weighed: `@hyperswarm/secret-stream` brings 19 MB of sodium-native; Node TLS with pinned keys needs certificate generation; `@chainsafe/libp2p-noise` pulls in libp2p. The Noise spec is frozen and the vectors run in CI, so the code we own is small and has a fixed target. |
| **The log** | A hash-chained JSON-lines file in `store/` (§4), a few hundred lines. Presence and focus stay JSON documents. |
| **Invites and admission** | A 128-bit secret sent inside Noise, compared in constant time, about 20 lines (R30). The Q14 spike rejected `blind-pairing`: it brings 19 MB of sodium-native, inside Noise it adds nothing, and its last release was October 2024. |
| **Tailscale control** | No maintained package exists; `net/pathways/tailscale.ts` drives the `tailscale` CLI. |
| **The stdio MCP server** | About 150 lines of JSON-RPC. `@modelcontextprotocol/sdk` is 4.4 MB with 17 dependencies (express, hono, ajv, zod and more), mostly HTTP server code we would never run. |
| **A PROXY-protocol v2 parser** | It is mandatory behind Funnel (R29a) and small. |

**From Node or the system:** `node:crypto` (keys, hashes, ids), `node:util` (`parseArgs`, `styleText`), `node:test` with `mock.timers`, `fs.watch` (in the listener and link daemon, which are node processes); the `ssh`, `git` and `tailscale` commands. The person's own ssh config, agent and `known_hosts` are respected.

**Not used**
- **Hypercore, Autobase, Hyperbee.** v2's log has one trusted writer, and mirrors want the whole log, so peer replication, Merkle proofs and sparse sync buy nothing. Autobase's multiple writers would only help host failover, a PRD non-goal. Hypercore 11 also pulls in `rocksdb-native`, about 126 MB.
- **`blind-pairing`:** see "Invites and admission" above.
- **Raw TLS-terminated TCP for Funnel:** spiked on `worktree-agent-ad1ef43df6a04b446`, and that branch stays unmerged. Proxies that inspect TLS drop it, and Node's `tls.connect` ignores `HTTPS_PROXY`.
- **`@peculiar/x509`, `node-forge`:** we don't need TLS certificates.
- **`chokidar`:** the module has no file watch and polls a small file; the node processes use `fs.watch`.
- **`ssh2`:** it would ignore the person's own ssh config, agent and `known_hosts`.
- **git libraries:** the repo comes from `session.repo`; the branch, and anything else, is one `git` command.
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
    fold.ts          snapshot + log → RoomState (members, presence, focus, plans, decisions, tasks)
    deliver.ts       (entry, member, state) → none | context | notice | wake; relevance (R15c), the token cap, the wake rule and its budget
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
    capture.ts       tool.call → activity documents and events; task-tool mirroring (R12, R23)
    follow.ts        polls the store's tail file ($.clock.every); feeds deliver()
    context.ts       prompt.submit context: relevant updates since the last turn, capped (R15a)
    status.ts        ui.status line; /sub-human news (R15b)
    wake.ts          prompt.submit at turn end (R10)
    messages.ts      session.receive: takes over SendMessage delivery; relays remote ones (R6)
    plans.ts         ExitPlanMode result → keep / room / send; review card ($.tool.call AskUserQuestion) + pane (ui.open) (R18–R22e)
  mcp/
    server.ts        tools: share, read, plan, task (§6)
  commands/        /sub-human verbs, one small file each: (bare), invite, join, who, tasks, leave, kick, help, doctor
  net/
    channel.ts       Noise XK over any Duplex (the POC's noise.ts, kept; vectors in CI)
    pathways/        tailscale.ts (Funnel | Serve, WebSocket), ssh.ts (ssh -W), pipe.ts (tests)
    host.ts          host side: accept, PROXY v2, handshake, admission, serve ops
    link.ts          joiner side: the link daemon running link-engine
    invite.ts        invite lines, secret, admission requests
  keys.ts          machine key, link keys
  home.ts          where files live (~/.sub-human)
  config.ts        the knobs (§10)
test/              scenes (§12) and unit tests, beside the code they test
```

## 4. Data model

**The log** (`rooms/CODE/log.jsonl`) is append-only JSON lines.
- Each entry: `{seq, id, at, prev, from, by, kind, …}`.
- `seq` is assigned by the host, and it is the sync cursor; `at` is the host's clock.
- `from` is the member. `by` is `person`, `claude` or `system`, a label only (R35). It is also what the wake rule reads: only `by: person` lines wake (R10).
- `prev` is the hash of the previous line, so a mirror detects a fork (R36).
- Only the host appends.

| Kind | Written by | Meaning |
|---|---|---|
| `joined`, `left` | system | membership, with repo, branch and machine |
| `activity` | module, mechanically | discrete events only: a commit, a push, a test result, a personal task change (R12, R23). File edits go in the activity document. |
| `finding` | the member's Claude (`share`) | one-line update in its own words (R13) |
| `post` | person (`@room`) or Claude (`share post`) | room-visible words; optional `to` to name someone (R7, R8). Private Claude-to-Claude messages are never posts (R6). |
| `plan` | host on CAS edit | a plan version: name, version, blob hash, base, kind group/personal |
| `plan_ask` | Claude for its person | agreement requested on one version from named members |
| `plan_answer` | person, from the review card | agree, or ask for changes plus a note |
| `decision` | system | everyone named has answered |
| `plan_sent` | person (send choice) | a personal plan sent to a member or the room, with branch, files and note |
| `plan_accept` | person | recipient accepted or dismissed a sent plan |
| `task` | system | full task snapshot after any task op (add, claim, release, done) |
| `invite`, `admit`, `kick` | host | admission records; never contain the secret |

**Documents** are current state, latest-wins: overwritten rather than appended. They never wake anyone, and while the host is away a mirror keeps its own member's documents and re-sends them on reconnect (R12, R32):
- `presence/NAME.json`: working or idle, plus a best-effort permission wait;
- `activity/NAME.json`: files edited since joining, coalesced;
- `focus/NAME.json`: one-line focus, repo, branch;
- `members.json`.

**Plan text** lives in `plans/<hash>.md`, content-addressed.

**Folding.** `RoomState = fold(snapshot, log after it, docs)` is the only reader logic. Every view is a function of `RoomState`: the status line, `/sub-human news`, the catch-up, `who`, delivery and the task list. There are no other caches.

**The snapshot** (`snapshot.json`, P0) is written by the host every N entries, at a known `seq`. A joiner or a reconnecting mirror fetches the snapshot plus the entries after it, never the whole log. Older log segments can then be archived, so the log no longer grows without bound.

## 5. Processes

| Process | Where | Lifetime | Job |
|---|---|---|---|
| Hooks module | inside each Claude Code session | the session | capture, follow, deliver, status, plan hooks, message delivery, wakes |
| MCP server | child of each session (stdio) | the session | Claude's tools; it answers `initialize` even if loading fails (C4) |
| Listener | host, one per home | while the host has a session in a room with remote members | the `127.0.0.1` port behind tailscaled (Funnel or Serve) or reached by `ssh -W`; accepts links; holds a sleep assertion while links are live |
| Link daemon | each mirror, one per room | while a local member is in the room | runs `link-engine`; keeps the mirror in sync; relays writes and private messages |

When the host's last session leaves a room, the listener stops serving it, and remote members see "host away" until it returns (R34). There is no room-level Claude, no tail child and no background job (PRD §4).

The command hooks in `hooks.json` keep working when policy disables user modules on managed machines (PRD C1): the `/sub-human` expansion, `SessionStart` with `sessionTitle`, `Notification` and `SessionEnd`. If the module is off, the person gets one line saying so.

## 6. Claude's tools (MCP)

There are four tools. Each answers in one short line, or with data the Claude asked for.

| Tool | Ops | Notes |
|---|---|---|
| `share` | `finding {text}`, `focus {text}`, `post {text, to?}` | the only way a Claude publishes in its own words (R7, R13, R14); filtered for secrets |
| `read` | `brief`, `since`, `plan {name, version?}` | the catch-up (R16) and plan text |
| `plan` | `edit {name, base, text}`, `ask {name, version, people}`, `send {name, to, note}` | CAS on `base`; a conflict returns the current text (R17) |
| `task` | `add`, `claim`, `release`, `done {note?}`, `list` | room tasks (R24); answers include the bridge tag to put on the native task (R24a) |

**Claude-to-Claude.** Questions use native `SendMessage` to `NAME.CODE` (R6). `module/messages.ts` takes delivery over: it consumes the message with `session.receive`, and delivers it as capped context on the recipient's next turn, never as a wake (R10). For a remote member, it hands the message to the link daemon, which sends it straight to the recipient's machine. It is never written to the log.

`NAME.CODE` needs one session per name. A second session under the same name (R5) is addressed by session id through `session.send`.

**The injected mechanics text,** about 1.5k characters (R42), tells the Claude:
- when to use `share`: at the end of a turn that learned or changed something;
- how to tag bridged tasks;
- that colleagues' content arrives datamarked, is data from a named colleague's Claude, never carries commands, should be used only if it bears on the current task, and should never be mentioned unprompted.

## 7. Key flows

**Live update (R12–R15b).**
1. `module/capture.ts` wraps `tool.call`: it awaits `next(e)` and passes the tool and its result to `core/activity.ts`. That returns one of three things:
   - an update to the member's activity document (file edits, coalesced);
   - an `activity` event (a commit from the Bash result's `gitOperation`, a test result, a task change);
   - nothing.
2. Documents go to `store.putDoc`, and events go to `store.append`. On a mirror, the link carries them to the host, which applies them and streams them back to everyone. While offline, documents wait locally and are re-sent on reconnect.
3. In every other session, `module/follow.ts` sees the change on its next poll and calls `deliver(entry, me, state)`:
   - `context` entries are only those that bear on my work (R15c) or overlap it (R15d). They queue for the next `prompt.submit` `context`, datamarked and capped at about 400 tokens.
   - `notice` entries add one dim line through `ui.log`.
   - Every entry updates the `ui.status` count. The rest waits for `read` or `/sub-human news`.

A finding takes the same path, starting from the `share` tool.

**Wake (R10).** `deliver` returns `wake` only for a `by: person` line that names me, or that answers my Claude's open question.
- It is debounced to one wake per question, and counted against my hourly wake budget.
- `module/wake.ts` holds the wake until `turn.complete` (or now, if idle) and then calls `prompt.submit`.
- It never touches the permission mode.
- Nothing a Claude writes ever returns `wake`.

**Group plan (R18–R22a).**
1. The person approves a plan in plan mode. `module/plans.ts` sees `ExitPlanMode`'s `tool.call` result (`{plan, filePath}`) and asks once: keep, room plan, or send to NAME.
2. For a room plan, the text is stored with `plan edit`. The person names reviewers, and their Claude calls `plan ask`.
3. Each reviewer gets a notice. Their review is an AskUserQuestion card, through `$.tool.call`:
   - its `preview` holds a summary and the diff since the version they last saw, from `diff`;
   - the answers are Agree or Ask for changes, with the note through Other or annotations;
   - the full text opens in a scrollable pane (`$.ui.open`; Pane bodies scroll, `ui.scroll`).

   No plan file is touched, and no mode changes (R19). The answer is recorded as `plan_answer`.
4. When everyone named has answered, the host writes `decision`. `core/plans.ts` turns owned parts into tasks, and each owner's next context carries their part.

**Sent plan (R22b–R22c).** At approval, "send to NAME" writes `plan_sent` with the text, branch, files and note. The recipient gets one notice and opens it on the same card and pane. Accepting writes `plan_accept`, and their context then carries the plan.

**Task bridge (R23–R24a).** This is on only when `$.tool.list` shows TaskCreate. The person opts in with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` at launch. Without it, room tasks work through the `task` tool alone.
1. A room `task claim` answers with the tag `[room CODE#N]`. The Claude creates its native task with that tag in the subject, and with `metadata {room, roomTask}`.
2. `capture.ts` wraps `tool.call` on TaskCreate and TaskUpdate. It keeps a map of (session, taskId) → {subject, tag}, filled from create results and rename inputs, because update results carry neither. The map is persisted in the plugin home. After `/clear`, resume or a restart, it is re-derived from tagged subjects with `TaskList`.
3. A `statusChange.to` on an untagged task becomes activity. On a tagged task, `completed` maps to room `done`, and `deleted` maps to `release`. A reopen (pending ↔ in progress) is no change.
4. Subagents' calls arrive the same way, with `agentId`.

No Claude Code task file is read or written, and the mirror never waits on a deletion event, because auto-reset and retention delete tasks silently.

**Remote join (R29–R31).**
1. The host runs `/sub-human invite NAME --public | --tailnet | --ssh`. That mints a 128-bit secret bound to the host's key and the expected name, and prints one line.
2. The joiner types `/sub-human join LINE`. `net/link.ts` dials through the line's pathway and runs Noise XK against the host key named in the line.
   - The third message carries the secret's MAC, so the host refuses anyone else before doing any per-connection work.
   - The secret itself travels only inside the channel.
3. Both sides see the same check string. The host's module shows **Let in / Refuse** through `ui.ask`, naming the joiner, their machine, any name mismatch, and the check string. A second dial of a pending or used line refuses both and alerts the host.
4. On Let in, the host binds the joiner's link key. The mirror fetches the snapshot plus the entries after it.

## 8. Network

- **Pathway interface.** One interface, `{dial(line): Promise<Duplex>, listen?(port): Stop}`. Pathways only produce byte streams; everything above them is shared.
  - `tailscale` runs `tailscale funnel` or `tailscale serve` (HTTPS) to the listener, with `--proxy-protocol=2`. The wire is WebSocket over HTTPS, using `ws`. The joiner's dialer honours `HTTPS_PROXY`. The raw-TCP spike stays unmerged (Q2).
  - `ssh` runs `ssh -W 127.0.0.1:PORT HOST` through any account the joiner has on the host machine. That reaches the same listener, with no shim and no login as the host. It needs `AllowTcpForwarding`, which `doctor` checks.
  - `pipe` is for tests.
- **Channel.** `net/channel.ts` runs Noise XK (`Noise_XK_25519_ChaChaPoly_SHA256`) on every pathway's stream (R29c). It is the POC's `noise.ts`: `node:crypto` primitives only, no dependencies, checked against the published vectors in CI.
  - The joiner already knows the host's key from the invite. Only that key can complete the handshake, so the secret is never sent to anyone else.
  - The joiner proves its own key in the third message, and that key becomes the link's identity, so a link is a key, not a token.
  - Messages are length-prefixed frames of at most 64 KB.
- **Protocol.** JSON messages inside the channel. The hello carries the protocol version and caps (R33). The ops are:
  - `append`, `put_doc`, `put_blob`;
  - `subscribe {after_seq, hash}`, answered with the snapshot plus the entries after it;
  - `message {to}`, for private Claude-to-Claude messages, which are forwarded to the recipient's link and never logged;
  - `ping`.

  There is no host-key query op. While offline, the member's own documents wait locally and are re-sent on reconnect, and a person's `post` queues for a bounded time under a client id the host deduplicates. Every other write fails fast (R32).
- **Link engine.** `core/link-engine.ts` is pure, `(state, event, now) → (state, effects[])`. It covers backoff, heartbeat, sleep and network-change detection, and fork. On a fork, it resyncs from the snapshot and re-sends queued posts under their ids (R36). `net/link.ts` executes the effects.
- **Host checks.** These are refused before anything is started for a connection:
  - a connection with no PROXY v2 header behind Funnel;
  - a handshake whose third message carries neither a known link key nor a valid invite MAC.

  After that, each write's `from` must be a member bound to that link, and system kinds from links are refused. Connections are limited per real source. Writes are rate-limited per link on `append` and `put_blob` (R37, R40).

## 9. Claude Code surfaces

Every row is re-checked in M0 against refreshed typings; the current snapshot is from 2.1.296. "API" means it appears in `typings/claude-code`. The verdicts come from the 2026-11-22 platform review.

| Need | Surface | Status |
|---|---|---|
| Capture tool results (edits, Bash, task tools) | `tool.call` middleware, `await next(e)`; typed results (`BuiltinToolResults`); Bash carries `gitOperation`, so commits and pushes come free | API |
| Whether the session has native task tools | `tool.list` | API; *why* they are off (the env var and model list) is internal |
| Context on the next turn | `prompt.submit` hook `context` (d.ts:9067). **Not `prompt.context`**, which fires once per conversation (d.ts:4172). **Not `$.state`**, which is render state. | API; arrives when the person submits, not mid tool loop |
| Status line, dim line | `ui.status`, `ui.log` | documented |
| Let in / Refuse; the keep / room / send question | `ui.ask` | API; it rejects in `-p` |
| Plan review card | `$.tool.call` AskUserQuestion with `preview` | API; the `answers` shape is internal |
| Full plan, scrollable | `$.ui.open` pane; Pane bodies scroll (`ui.scroll`, d.ts:4049) | API |
| Plan approval | `tool.call` on ExitPlanMode → `{plan, filePath}` | API; the rejection shape is internal |
| Plan-mode entry | none: no module event survives the guard | not used (R18 asks at approval) |
| Wake at turn end | `turn.complete` plus `prompt.submit` | API. It shows as a prompt from the plugin, is lost on Esc (retry from `turn.complete`), and is skipped when `$.session.surfaces()` is empty (`-p`). |
| Presence (working or idle) | `turn.start`, `turn.complete` | API |
| Presence (waiting on a permission prompt) | command hook `Notification` `permission_prompt` | documented; about 6 s late, best-effort |
| Repo | `session.repo` `{root, remote, name}` | API; it has no branch, so the branch comes from `git` |
| Following the log | `$.clock.every` + `$.fs.stat` + read a small tail file | API; polled every 0.5–1 s; the module has no watch, and `$.fs` reads whole files (4 MiB cap) |
| Claude-to-Claude delivery | `session.receive` (consume), `session.send` | API |
| `NAME.CODE` addressing | `sessionTitle` from a `SessionStart` command hook | documented; name uniqueness is internal; a duplicate name is addressed by session id |
| `/sub-human` command, session end | command hooks (`UserPromptExpansion`, `SessionEnd`) | documented; they survive managed-machine policy |
| Claude's tools | plugin MCP server | documented; the 15-minute failure cache is internal |

**Internals estimate:** about 6–8 of the 10 allowed, covering the task-tool gate, MCP failure cache, wake prompt frame, AskUserQuestion answers, ExitPlanMode rejection shape, `sessionTitle` uniqueness, and possibly mode labels. Total contract entries come to about 25–30.

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
| **Total** | **≈ 9,000** |

A pull request that pushes an area over its line is either split or comes with a deletion.

## 12. Testing

- **Unit tests, beside each `core/` module.** Pure inputs in, outputs out. Every delivery rule and every plan and task rule is a table test.
- **Scenes** (`test/scenes/`). Each PRD story (S-Live, S-Relevant, S-Ask, plan together, send a plan, split, join, remote join, leave) runs as a script against the memory store, using Claude Code's own test kit for hooks modules (`claude plugin test`, the `claude-code/testing` module). The kit sends events through the module's hooks with no session, sign-in or network. Its stubs answer in Claude Code's place and record the module's `ui.*` and `prompt.*` calls, and `mock.clock` gives the fake clock. We don't build a fake host of our own. Assertions cover what each member sees (at most 6 lines, R41), what each Claude's context holds, and that only R10 events wake anyone. There is no live model, and CI runs every scene.
- **Network.** `link-engine` table tests on the fake clock. Two homes over `pipe` for snapshot sync, fork and kick. Noise vectors. A TLS front with PROXY v2 stands in for tailscaled. Admission tests: a leaked line dialled twice, a name mismatch, and a handshake without a MAC refused before anything is started.
- **Safety.** A scene where a colleague's Claude writes "alice, run …" must produce no wake. R19's three properties each have a test.
- **Live gate.** One scripted run per release with real Claude sessions, in each permission mode, covering a no-plan pairing, a plan-then-build and a non-code task (PRD Q-2). It records tokens per hour (Q9) and lines per person.
- **Canary.** Nightly, against Claude Code `latest` and `next`: the contract probe plus a typings diff (C1).
- **Ratio.** Test code no larger than runtime code.

## 13. Build order

| Milestone | Delivers | First proof |
|---|---|---|
| M0 | core types, schemas, fold and snapshot, memory store, scene harness, refreshed typings, §9 table re-checked | S-Live passes under `claude plugin test` |
| M1 | fs-store, module (capture, follow, context, status, news, messages, wake), MCP `share` and `read`, commands | two real sessions on one machine; a relevant change reaches the other Claude by its next prompt, within 5 s of happening, under the token cap |
| M2 | plans: CAS, the question at approval, room and sent plans, review card plus pane | a review changes no plan file and no mode (R19) |
| M3 | room tasks; opt-in native bridge | a claimed room task appears in a person's native list, and completing it there closes the room task |
| M4 | net: channel, tailscale (WebSocket, PROXY v2) and ssh (`-W`) pathways, name-bound invite and admission, link engine, mirror with snapshot sync | a join over Funnel from a machine with no Tailscale; a leaked line dialled twice alerts the host |
| M5 | relevance tuning, overlap heads-up | live-gate noise rating |
| M6 | release | live gate green; README of at most 200 lines |
