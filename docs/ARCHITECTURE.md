# sub-human v2: Architecture

How v2 is built, as of 2.0.0. It is the design for `docs/PRD.md`; requirement numbers (R…) and questions (Q…) refer to that document. The 0.8 proof of concept's architecture is archived in `docs/archive/ARCHITECTURE-0.8.md`.

## 1. Shape in one paragraph

Each Claude Code session in a room runs one piece of sub-human: a **hooks module**, in-process. It watches the session's work, delivers updates to it, draws the status line, and registers Claude's few tools (`$.tool.register`). There is no MCP server. The module has no Node and can't write files safely, so every write and all network work (the link, Noise, WebSocket) runs in one node process per home, the daemon (§5).

One machine is the room's **host**. It holds the room's **log**, an append-only list of entries, and applies every write. Other machines keep a **mirror** of the log, fed by one **link** per room over Tailscale or ssh. Everything a person sees and every piece of context a Claude gets is computed by pure functions over the log. Everything else is a thin adapter around those functions.

```
 machine A (host)                                          machine B
┌─────────────────────────────────────────┐              ┌──────────────────────────────┐
│ Claude Code session (alice)             │              │ Claude Code session (bob)    │
│  └─ hooks module ──────────────────┐    │              │  └─ hooks module ────┐       │
│     capture·deliver·status·plans   │    │              │     (same)           │       │
│     tools: share·read·plan·task    │    │              │                      │       │
│                                    │    │              │        MirrorStore ──┘       │
│          FsStore (host) ───────────┘    │◄── link ────►│   daemon (node) + link        │
│   rooms/CODE/log.jsonl  docs/  plans/   │  Tailscale   │   rooms/CODE/ (mirror copy)   │
│   daemon: listener ← tailscaled/sshd   │  or ssh      │                               │
└─────────────────────────────────────────┘              └───────────────────────────────┘
```

## 2. Code principles

These hold for every module; review against them.

1. **Pure core, thin edges.** Rules live in `core/` as pure functions of `(state, input, now)`: folds, delivery, relevance, plan and task rules, the link state machine. Edges (module, store, net) only translate events and do I/O. Every edge stays under about 150 lines.
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

| Problem | Package | Vendored as | Runs in | Status |
|---|---|---|---|---|
| Validating outside data | `valibot` | `vendor/valibot.mjs` (206 KB) | module and node | chosen |
| Not sharing ignored, excluded or secret files (R12, R14a) | `ignore` | `vendor/ignore.mjs` (50 KB; CommonJS wrapped as ESM) | module | chosen |
| The diff since the last version, in the review pane (R21) | `diff` | `vendor/diff/` (its `libesm`, 152 KB) | module | chosen (M2) |
| The Funnel wire: WebSocket over HTTPS, proxy-friendly (R29a) | `ws` | `vendor/ws/` (176 KB) | the daemon only | chosen |
| Peer connection without Tailscale | `hyperswarm` | — (~13 MB, mostly udx-native; UDP only) | — | P2, opt-in (Q14) |

**Vendored, not installed** (PRD Q13):
- **Why:** the hooks module imports only its own files by relative path. `claude plugin validate` refuses a bare specifier or `node_modules`, so no package manager can serve it.
- **Where:** each package's ESM build is committed under `plugin/sub-human/vendor/`, with its LICENSE, about 580 KB in all. Module and node code import it by relative path.
- **No install step:** the plugin root has no lockfile, so Claude Code's automatic `npm ci` never runs, and nothing is installed at run time.
- **Drift check:** the repo root's `package.json` pins each package as an exact devDependency (which also supplies the types). `scripts/vendor.ts` copies the files and records versions, lockfile integrity and file hashes in `vendor/VENDOR.json`. `npm test` fails on drift.
- **Lint:** `vendor/` is excluded from lint and the cast ratchet. `directory-lint`'s invisible-character rule exempts it, after checking that its non-ASCII characters are visible ones.

**Dropped:**
- `proper-lockfile`: no release since 2021, and CommonJS.
- `write-file-atomic`: its current version excludes Node 22.18–22.22.1.

`node:fs` covers both: a lock is `open('wx')` with a stale-mtime check, and a crash-safe write is temp file, fsync, rename.

**Ours on purpose**

| Piece | Why we keep it |
|---|---|
| **The channel**, `net/channel.ts` | This is the POC's `noise.ts`: Noise XK on `node:crypto`, 280 lines, zero dependencies, already passing the published cacophony and snow vectors. Its alternatives were weighed: `@hyperswarm/secret-stream` brings 19 MB of sodium-native; Node TLS with pinned keys needs certificate generation; `@chainsafe/libp2p-noise` pulls in libp2p. The Noise spec is frozen and the vectors run in CI, so the code we own is small and has a fixed target. |
| **The log** | A hash-chained JSON-lines file in `store/` (§4), a few hundred lines. Presence, activity and focus stay JSON documents. |
| **Invites and admission** | A 128-bit secret sent inside Noise, compared in constant time, about 20 lines (R30). The Q14 spike rejected `blind-pairing`: it brings 19 MB of sodium-native, inside Noise it adds nothing, and its last release was October 2024. |
| **Tailscale control** | No maintained package exists; `net/pathways/tailscale.ts` drives the `tailscale` CLI. |
| **Claude's tools** | Registered by the module with `$.tool.register` (typed). There is no MCP server, so no `@modelcontextprotocol/sdk` (4.4 MB, 17 dependencies) and no reliance on the MCP failure cache. |
| **A PROXY-protocol v2 parser** | It is mandatory behind Funnel (R29a) and small. |

**From Node, the module runtime or the system:**
- Node: `node:crypto` (keys, hashes, ids), `node:util` (`parseArgs`, `styleText`), `node:test` with `mock.timers`, `fs.watch` in the daemon, and `node:fs` for locks and crash-safe writes.
- The module runtime: the global `crypto.subtle.digest`, for the hash chain inside the module.
- The system: the `ssh`, `git` and `tailscale` commands. The person's own ssh config, agent and `known_hosts` are respected.

**Not used**
- **Hypercore, Autobase, Hyperbee.** v2's log has one trusted writer, and mirrors want the whole log, so peer replication, Merkle proofs and sparse sync buy nothing. Autobase's multiple writers would only help host failover, a PRD non-goal. Hypercore 11 also pulls in `rocksdb-native`, about 126 MB.
- **`blind-pairing`:** see "Invites and admission" above.
- **Raw TLS-terminated TCP for Funnel:** spiked on `worktree-agent-ad1ef43df6a04b446`, and that branch stays unmerged. Proxies that inspect TLS drop it, and Node's `tls.connect` ignores `HTTPS_PROXY`.
- **`@peculiar/x509`, `node-forge`:** we don't need TLS certificates.
- **`chokidar`:** the module has no file watch and polls a small file; the node processes use `fs.watch`.
- **`ssh2`:** it would ignore the person's own ssh config, agent and `known_hosts`.
- **git libraries:** the repo comes from `session.repo`. The branch, and anything else, is one `git` command through `$.process.run`, or `$.vcs.detect`, which is experimental.
- **Secret scanners:** we use a curated MIT pattern list (from gitleaks) as data, matched with `ignore` and a few regexes.
- **`proper-lockfile`, `write-file-atomic`:** see "Dropped" above.

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

As built in 2.0.0. Plugin files import each other as `./x.js` (validate refuses `.ts` paths); node loads them through
`resolve-ts.ts`.

```
plugin/sub-human/
  core/            pure: no node:fs, no net, no Claude Code; loadable by the module and by node (relative imports only)
    entries.ts       entry and document types, the kinds (§4), LIMITS
    schema.ts        valibot schemas for everything read from outside
    result.ts        the one Result<T>
    api.ts           the daemon's socket API: requests, answers, their schemas (§5)
    fold.ts          snapshot + log + documents → RoomState; updatesSince; snapshots
    deliver.ts       (input, member, state) → none | context | notice | wake | draw; relevance (R15c), overlap (R15d),
                     the token cap, the wake rule, its budget and the command/URL rule
    plans.ts         CAS edit, ask, answer, decide, send, accept; owners on parts → tasks
    tasks.ts         add, claim, release, done, blockedBy; the bridge tag and its mapping
    activity.ts      tool result → activity document or event; secrets.ts (+ data/secret-patterns.ts) the filter
    brief.ts         RoomState → catch-up text (R16), size-bounded
    mechanics.ts     the injected mechanics text (R42)
    text.ts          one clean line and the datamark; hash.ts SHA-256 through crypto.subtle
    link-engine.ts   reconnect state machine (clock injected)
    protocol.ts      wire messages, version and caps
    cc/              contract.json (every Claude Code fact relied on) and its probe
  store/
    store.ts         RoomStore interface, line placing and chain checks
    fs-store.ts      host: log, documents, plan blobs, the tail file; lock.ts (open 'wx'), atomic.ts (crash-safe write)
    mirror-store.ts  a room hosted elsewhere: the host's snapshot plus its lines, every write sent to the host
    memory-store.ts  tests
  module/          the hooks module (Claude Code edge); no Node, relative imports only
    register.ts      wires each part's hooks; nothing else
    session.ts       the plain data the parts share (a `$` never crosses a file)
    bridge.ts        requests to the daemon over $.http.fetch on its Unix socket
    capture.ts       tool.call → activity documents and events; presence; pings (R12, R23)
    follow.ts        polls the tail file, reads the log by ranges, feeds deliver(); follow-lines.ts its pure part
    context.ts       prompt.submit context: mechanics once, relevant updates capped (R15a); mid-loop heads-up (R15d)
    status.ts        ui.status line; /sub-human news pane (R15b)
    messages.ts      session.send caught at the sender for NAME.CODE (R6)
    wake.ts          $.prompt.submit once idle; retry on turn.complete.isAborted (R10)
    plans.ts         ExitPlanMode result → keep / room / send; the plan tool (R17–R18, R22b)
    plans-review.ts  the reviewer's card (ui.ask) and pane (ui.open) (R21–R22c); plans-cards.ts, plans-pending.ts,
                     plans-notes.ts and plan-diff.ts its pure parts
    tasks.ts         the task tool and the bridge into the native list (R24, R24a)
    tools.ts         Claude's share and read tools via $.tool.register + tool.run (§6)
    admit.ts         the host's Let in / Refuse card (R30)
  commands/        /sub-human verbs, one small file each: (bare), invite, join, who, tasks, news, leave, kick, help,
                   doctor; hooks.ts the four command hooks; context.ts and daemon.ts their real-machine wiring
  hooks/           hooks.json (the module, plus UserPromptExpansion, SessionStart, Notification, SessionEnd) and node.sh
  net/             the daemon only (the module can't load node:crypto or ws)
    daemon.ts        one per home: the socket server, its lifetime; daemon/ rooms.ts (the store writes and the rules),
                     pointers.ts (session pointers, handoffs), open.ts (which room a bare join takes), net.ts (host
                     and links), client.ts (node's side of the socket)
    channel.ts       Noise XK over any Duplex (the POC's noise.ts, kept; vectors in CI)
    pathways/        tailscale.ts (Funnel | Serve, WebSocket), ssh.ts (ssh -W), pipe.ts (tests)
    host.ts          host side: accept, PROXY v2 (proxy-v2.ts), handshake, admission, serve ops, rate limits
    link.ts          joiner side: one link per room hosted elsewhere, running link-engine
    invite.ts        invite lines, the secret and its MAC
  vendor/          committed ESM builds of valibot, ignore, diff and ws, plus VENDOR.json (§2a)
  cli.ts           the one node entry for command hooks, and doctor and help in a terminal
  keys.ts          the machine key; home.ts where files live (~/.sub-human); config.ts the knobs (§10)
  resolve-ts.ts    node's resolve hook: `./x.js` → `x.ts`
  test/            scenes/, net/, support/ (seed-room, two-homes, fake daemon), fixtures/ (cc/2.1.330 recordings);
                   unit tests sit beside the code they test
```

## 4. Data model

**The log** (`rooms/CODE/log.jsonl`) is append-only JSON lines.
- Each entry: `{seq, id, at, prev, from, by, machine, kind, …}`.
- `seq` is assigned by the host, and it is the sync cursor; `at` is the host's clock. The host stamps `seq`, `at`, `prev` and `machine`; `id` is the writer's, a UUID made once and sent again on every retry, so the host answers a repeated id with the first line's seq and hash and writes nothing (R36). Entries the host's rules write (plans, decisions, tasks) get ids from the host.
- `from` is the member. `by` is `person`, `claude` or `system`, a label only (R35). The wake rule reads it: a `by: person` line can wake by naming someone, and a `by: claude` broadcast never does. Direct Claude-to-Claude messages aren't log entries (R6).
- `prev` is the hash of the previous line, so a mirror detects a fork (R36). The module checks the chain as it reads, with `crypto.subtle.digest`.
- Only the host appends.

| Kind | Written by | Meaning |
|---|---|---|
| `joined`, `left` | system | membership, per name, with repo, branch and machine: `joined` once, when a name that isn't a member joins; `left` only for an explicit `/sub-human leave` that no other session or pending handoff holds the name against. A session ending, a crash or a sweep never writes either: it marks the member away (presence). |
| `activity` | module, mechanically | discrete events only: a commit, a push, a test result, a personal task change (R12, R23). File edits go in the activity document. |
| `finding` | the member's Claude (`share`) | one-line update in its own words (R13) |
| `post` | person (`@room`) or Claude (`share post`) | room-visible words; optional `to` to name someone (R7, R8). Private Claude-to-Claude messages are never posts (R6). |
| `plan` | host on CAS edit | a plan version: name, version, blob hash, base, kind group/personal |
| `plan_ask` | Claude for its person | agreement requested on one version from named members |
| `plan_answer` | person, from the review card | agree, or ask for changes plus a note |
| `decision` | system | everyone named has answered |
| `plan_sent` | person (send choice) | a personal plan sent to a member or the room, with branch, files and note |
| `plan_accept` | person | recipient accepted, dismissed, or asked for changes (note) on a sent plan |
| `task` | system | full task snapshot after any task op (add, claim, release, done) |
| `invite`, `admit`, `kick` | host | admission records; never contain the secret |

**Documents** are current state, latest-wins: overwritten rather than appended. They never wake anyone, and while the host is away a mirror keeps its own member's documents and re-sends them on reconnect (R12, R32):
- `presence/NAME@MACHINE.json`: working, idle or away on one machine, plus a best-effort permission wait. A member is here on each machine whose presence isn't away, and their machines are those; "here" and "away" never come from the log. A room is open while any member is here;
- `activity/NAME.json`: files edited since joining, coalesced;
- `focus/NAME.json`: one-line focus, repo, branch;
- `members.json`.

**Plan text** lives in `plans/<hash>.md`, content-addressed.

**Folding.** `RoomState = fold(snapshot, log after it, docs)` is the only reader logic. Every view is a function of `RoomState`: the status line, `/sub-human news`, the catch-up, `who`, delivery and the task list. There are no other caches.

**The snapshot** (`snapshot.json`, P0) is written by the host every N entries, at a known `seq`. A joiner or a reconnecting mirror fetches the snapshot plus the entries after it, never the whole log. Older log segments can then be archived, so the log no longer grows without bound.

## 5. Processes

| Process | Where | Lifetime | Job |
|---|---|---|---|
| Hooks module | inside each Claude Code session | the session | capture, follow, deliver, status, plan hooks, message routing, wakes, Claude's tools; reads the store with `$.fs` |
| Daemon (node) | one per home | while any local session is in a room | every write to the store; for rooms hosted here, the FsStore and the listener (the `127.0.0.1` port behind tailscaled or reached by `ssh -W`, accepting links, holding a sleep assertion while links are live); for rooms hosted elsewhere, one link per room running `link-engine` and keeping the mirror in sync; private messages between members |

**Every write goes through the daemon** (U4, checked on 2.1.330). `$.fs` has no exclusive create, rename, append or fsync, and its `write` truncates in place, so a module can't keep the log's chain or a document's "old or new, never torn". The module only reads: the tail file and the log by ranges (4 MiB per read), documents and plan text.

**How the module reaches it.** `$.http.fetch` over a Unix socket in the home (`socketPath`), which draws no permission prompt and passes no rule check; a refusal (managed policy, or a build with no socket transport) throws, and the module says so in one line (C3). If the socket doesn't answer, the module starts the daemon with `$.process.spawn` of `node --import resolve-ts.ts net/daemon.ts <home>` (node's absolute path); spawning draws no prompt either, and only a managed deny rule refuses it. Spawned children die when the module unloads, so the daemon re-spawns itself detached (`detached: true` + `unref`, U6: it outlives the session); a start lock and the socket's bind make sure one wins. Command hooks are node, and they write through the same socket (`net/daemon/client.ts`, which starts the daemon the same way), never to the store directly.

**What it holds.** `net/daemon/rooms.ts` applies every request (core/api.ts): one promise chain per room hosted here, so its own writes never contend for the file lock (the lock guards against a second process), deduplication by entry id, and the plan and task rules of `core/`. `pointers.ts` keeps each session's pointer (`sessions/ID.json`, the room, name and title the module and the command hooks read) and the handoffs `/clear` and `/resume` leave. `net.ts` holds the host side and the links. Each session in a room pings every 20 s with its Claude Code version (`$.session.version()`, for doctor); a session is live while it has pinged within a minute, and the daemon exits once no request has come for its idle time. Private Claude-to-Claude messages wait in the recipient session's inbox there until its module takes them.

When the host's last session leaves a room, the listener stops serving it, and remote members see "host away" until it returns (R34). There is no room-level Claude and no background job besides the daemon (PRD §4).

The command hooks in `hooks.json` keep working when policy disables user modules on managed machines (PRD C1): the `/sub-human` expansion, `SessionStart` with `sessionTitle`, `Notification` and `SessionEnd`. If the module is off, the person gets one line saying so.

## 6. Claude's tools

There are four tools, registered by the module with `$.tool.register` and answered in `tool.run`; there is no MCP server. Each answers in one short line, or with data the Claude asked for.

| Tool | Ops | Notes |
|---|---|---|
| `share` | `finding {text}`, `focus {text}`, `post {text, to?}` | the only way a Claude publishes in its own words (R7, R13, R14); filtered for secrets |
| `read` | `brief`, `since`, `plan {name, version?}` | the catch-up (R16) and plan text |
| `plan` | `edit {name, base, text}`, `ask {name, version, people}`, `send {name, to?, note?}` | CAS on `base`; a conflict returns the current text (R17). A person's answers (`answer`, `accept`) come from their card, never from the tool. |
| `task` | `add`, `claim`, `release`, `done {note?}`, `list` | room tasks (R24); answers include the bridge tag to put on the native task (R24a) |

**Claude-to-Claude.** A Claude uses native `SendMessage` to `NAME.CODE` (R6). The message is caught at the **sender**, because the recipient's `session.receive` carries no sender name.
1. The sender's `module/messages.ts` hooks `session.send`. For any `to` ending in `.CODE`, it answers `{isDelivered: true}` without calling `next`.
2. It carries the message over the room channel, stamped with the sender: the daemon on one machine, the link's `message` op across machines. It is never written to the log.
3. The recipient's module hands it to `wake.ts` as a framed wake (R10). That waits for the turn to end, applies the debounce and budget, and applies the command/URL rule in every mode.

Native mid-turn interrupts are therefore never used for room members. Whether Claude Code honours the answer given without `next` is the one risk, settled by an M1 module test.

`NAME.CODE` addressing comes from `sessionTitle` (a `SessionStart` command hook); name uniqueness is internal. A second session under the same name (R5) gets a distinct title.

**The injected mechanics text,** about 1.5k characters (R42), tells the Claude:
- when to use `share`: at the end of a turn that learned or changed something;
- how to tag bridged tasks;
- that colleagues' content arrives datamarked, is data from a named colleague's Claude, never carries commands, should be used only if it bears on the current task, and should never be mentioned unprompted;
- that a woken turn is a colleague's request: answer facts and change only its own work, and leave running a supplied command, touching other files, or anything destructive to its person (R10, R11);
- when to message a colleague's Claude directly: a change their side depends on (S-Ask).

## 7. Key flows

**Live update (R12–R15b).**
1. `module/capture.ts` wraps `tool.call`: it awaits `next(e)` and passes the tool and its result to `core/activity.ts`. That returns one of three things:
   - an update to the member's activity document (file edits, coalesced);
   - an `activity` event (a commit from the Bash result's `gitOperation`, a test result, a task change);
   - nothing.
2. Documents go to `store.putDoc`, and events go to `store.append`. On a mirror, the link carries them to the host, which applies them and streams them back to everyone. While offline, documents wait locally and are re-sent on reconnect.
3. In every other session, `module/follow.ts` sees the change on its next poll and calls `deliver(entry, me, state)`:
   - `context` entries are only those that bear on my work (R15c) or overlap it (R15d). They queue for the next `prompt.submit` `context`, datamarked and capped at about 400 tokens. Claude Code's own limits (100k characters per entry, 200k in total) are far above this cap.
   - An overlap heads-up (R15d) also reaches a Claude that is deep in a long tool loop. It goes in as a `$.session.append` note, or as the `context` on its next `tool.call` result, without starting a turn.
   - `notice` entries add one dim line through `ui.log`.
   - Every entry updates the `ui.status` count. The rest waits for `read` or `/sub-human news`.

A finding takes the same path, starting from the `share` tool.

**Wake (R10).** Three things wake my Claude:
- a `by: person` line that names me;
- a colleague's Claude's direct `SendMessage` to mine (from `messages.ts`);
- an answer to my Claude's open question.

Broadcasts never wake: a finding, a `post`, activity, a plan, a decision.

How a wake is delivered:
- It is debounced to one wake per question or sender burst, and counted against my hourly wake budget.
- `module/wake.ts` calls `$.prompt.submit`, which runs once the session is idle. It retries if `turn.complete` reports `isAborted`, for example after Esc. It is skipped when `$.session.surfaces()` is empty (`-p`). The message is framed as `bob's Claude asks: …` and marked as data.
- In every mode, a direct message containing a command or URL to run is drawn for the person instead of submitted. The module can't read the permission mode, so the rule doesn't depend on it.
- It never touches the permission mode.

**Group plan (R18–R22a).**
1. The person approves a plan in plan mode. `module/plans.ts` sees `ExitPlanMode`'s `tool.call` result (`{plan, filePath}`) and asks once: keep, room plan, or send to NAME.
2. For a room plan, the text is stored with `plan edit`. The person names reviewers, and their Claude calls `plan ask`.
3. Each reviewer gets a notice. Their review is a `ui.ask` card (typed; Claude Code draws it as its native question card):
   - its question holds a short summary of what changed since the version they last saw;
   - the answers are Agree, Ask for changes (the note through Other), and Read the full plan;
   - Read the full plan opens a scrollable pane (`$.ui.open`; Pane bodies scroll, `ui.scroll`) with the full text and the diff from `diff`, then asks again. The pane opens from that choice, because an unasked pane only places on terminals at least 144 columns wide.

   No plan file is touched, and no mode changes (R19). The answer is recorded as `plan_answer`.
4. When everyone named has answered, the host writes `decision`. `core/plans.ts` turns owned parts into tasks, and each owner's next context carries their part.

**Sent plan (R22b–R22c).** At approval, "send to NAME" writes `plan_sent` with the text, branch, files and note. The recipient gets one notice and opens it on the same card and pane. Accepting writes `plan_accept`, and their context then carries the plan.

**Task bridge (R23–R24a).** This is on only when `$.tool.list` shows TaskCreate. The person opts in with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` at launch. Without it, room tasks work through the `task` tool alone.
1. A room `task claim` answers with the tag `[room CODE#N]` when the session has TaskCreate. The Claude creates its native task with that tag in the subject; no metadata is set on it.
2. `capture.ts` wraps `tool.call` on TaskCreate and TaskUpdate. It keeps a map of (session, taskId) → subject, filled from create results and rename inputs, because update results carry no subject. The map is not persisted. After `/clear`, resume or a restart (a new session id), it starts empty, and an update of an id it lacks re-derives it from tagged subjects with the module's own `TaskList` call, made before the update runs, since a deleted task is gone from the list after. A list that refuses is asked again at the next unknown id.
3. A `statusChange.to` on an untagged task becomes activity. On a tagged task (the tag for this room, among any others in the subject), `completed` maps to room `done`, and `deleted` maps to `release`. A reopen (pending ↔ in progress) is no change, and so is a change the room task already shows; a real refusal (someone else has it) is one line.
4. Subagents' calls arrive the same way, with `agentId`.

No Claude Code task file is read or written, and the mirror never waits on a deletion event, because auto-reset and retention delete tasks silently.

**Remote join (R29–R31).**
1. The host runs `/sub-human invite NAME --public | --tailnet | --ssh`. That mints a 128-bit secret bound to the host's key and the expected name, and prints one line.
2. The joiner types `/sub-human join LINE`. `net/link.ts` dials through the line's pathway and runs Noise XK against the host key named in the line.
   - The third message carries the secret's MAC, so the host refuses anyone else before doing any per-connection work.
   - The secret itself travels only inside the channel.
3. Both sides see the same check string: the joiner's command answers with it at once ("Tell the host: CHECK. Waiting to be let in…"). The host's module shows **Let in / Refuse** through `ui.ask`, naming the joiner, their machine, any name mismatch, and the check string. A second dial of a pending or used line refuses both and alerts the host.
4. On Let in, the host binds the joiner's link key. The mirror fetches the snapshot plus the entries after it.
5. Once the link is online, the joiner's daemon takes the session that dialled into the room as `join` would (its pointer, `joined`, presence). That session's module finds the pointer at its next poll and draws "You're in CODE as NAME"; a link that stopped instead (refused, or no answer in six minutes) is one line too. One command, end to end.

**Retention (R3).** At each start the daemon deletes a room hosted here once nobody has used it for 30 days (`store/retention.ts`: the tail's `at`, which every entry and member document renews) and no pointer or fresh handoff holds it. The next ping carries one debug line saying so, which the module writes to Claude Code's debug log.

## 8. Network

- **Pathway interface.** One interface, `{dial(line): Promise<Duplex>, listen?(port): Stop}`. Pathways only produce byte streams; everything above them is shared.
  - `tailscale` runs `tailscale funnel` (public) or `tailscale serve` (tailnet) with `--tls-terminated-tcp=PORT --proxy-protocol=2 tcp://127.0.0.1:LISTENER`. tailscaled ends TLS for the host's `ts.net` name and forwards plain TCP, each connection led by a PROXY v2 header naming the joiner's address. Only TCP forwarders (`--tcp`, `--tls-terminated-tcp`) carry that header; an `--https` web forward carries none, so it isn't used. Such a forward takes a whole port, and Funnel offers 443, 8443 and 10000: the first one free is taken, one of ours already there is kept (refused, in one line, if it lacks the header), and turning ours off leaves every other forward alone.
  - The listener reads the PROXY header, then speaks HTTP and upgrades to a WebSocket (`ws`); one WebSocket message carries one Noise frame, so `maxPayload` is a frame plus its 2-byte length (65,537 bytes). The joiner dials `wss://NODE.ts.net[:PORT]/CODE`, through `HTTPS_PROXY` (an HTTP CONNECT, with the proxy URL's user and password) when it is set. The raw-TCP spike stays unmerged (Q2).
  - A connection with no PROXY header is an `ssh -W` one and carries Noise frames as they are; an HTTP request without the header, or a header naming a loopback source, is refused.
  - `ssh` runs `ssh -W 127.0.0.1:PORT HOST` through any account the joiner has on the host machine. That reaches the same listener, with no shim and no login as the host. It needs `AllowTcpForwarding`, which `doctor` checks.
  - `pipe` is for tests.
- **Channel.** `net/channel.ts` runs Noise XK (`Noise_XK_25519_ChaChaPoly_SHA256`) on every pathway's stream (R29c). It is the POC's `noise.ts`: `node:crypto` primitives only, no dependencies, checked against the published vectors in CI.
  - The joiner already knows the host's key from the invite. Only that key can complete the handshake, so the secret is never sent to anyone else.
  - The joiner proves its own key in the third message, and that key becomes the link's identity, so a link is a key, not a token.
  - On the stream, each Noise message is a frame: a 2-byte length, then at most 64 KB. After the handshake, each frame's plaintext starts with a continuation byte (1: the message goes on in the next frame), so a message can be up to 8 MB.
  - The host reads nothing past message 3 until it answers the admission, and holds at most about 128 KB before then. The handshake times out after 10 s.
- **Protocol.** JSON messages inside the channel (`core/protocol.ts`). Both sides open with `hello {version, min, caps, name, machine}` (R33). The ops are:
  - to the host: `append {entry}` (the host stamps seq, at, prev and machine, and deduplicates on the entry's id), `put_doc`, `put_blob`, and `call {id, req}` for a plan or task request, answered `answer {id, value}`;
  - `subscribe {after_seq, hash}`, answered with `snapshot` (when the cursor is not on the host's chain, a fork) and then `lines` (entries with their hashes);
  - `ack` or `refused {reason}` for each write's id;
  - `message {to}`, for private Claude-to-Claude messages, which are forwarded to the recipient's link and never logged;
  - `put_doc` and `put_blob` from the host, for a document that changed and for plan text the mirror lacks;
  - `ping` and `pong`, both ways;
  - `bye {reason}` before the host closes a link: `kicked`, `refused`, `skew`, `host_away` or `closed`.

  There is no host-key query op. While offline, the member's own documents wait locally and are re-sent on reconnect, and a person's `post` queues for a bounded time under a client id the host deduplicates. Every other write fails fast (R32).
- **Link engine.** `core/link-engine.ts` is pure, `(state, event, now) → (state, effects[])`. It covers backoff, heartbeat, sleep and network-change detection, and fork. On a fork, it resyncs from the snapshot and re-sends queued posts under their ids (R36). `net/link.ts` executes the effects.
- **Host checks.** These are refused before anything is started for a connection:
  - a connection with no PROXY v2 header behind Funnel;
  - a handshake whose third message carries neither a known link key nor a valid invite MAC.

  After that, each write's `from` must be a member bound to that link, and system kinds from links are refused. Connections are limited per real source, counted from the PROXY header on, and in all. Every write (`append` and `call`, `put_doc`, `put_blob`, `message`) and `subscribe` is rate-limited per link; a link that subscribes again past its limit gets `bye closed` rather than the room re-sent (R37, R40). Of the 64 connections the listener holds in all, 8 are kept for local (`ssh -W`) ones.

## 9. Claude Code surfaces

**How this was checked (Q1, 2026-11-22).** These rows were checked against typings extracted from the Claude Code 2.1.330 binary, now the committed snapshot (`typings/`, refreshed with `npm run typings`). `core/cc/contract.json` lists each surface below: 23 entries, 19 API and 4 internal.

**What the check changed:**
- Claude's tools are registered by the module (`$.tool.register`, `tool.run`), so there is no MCP server.
- Claude-to-Claude messages are caught at the sender's `session.send`, because `session.receive` carries no sender.
- A wake uses `$.prompt.submit`, which waits until the session is idle, and is retried when `turn.complete` reports `isAborted`.
- The command/URL rule applies in every mode, because the module can't read the mode.
- The branch comes from `git` (or `$.vcs.detect`, which is experimental).
- Mid-loop notes use `$.session.append` and `tool.call` `context`.
- The module has no Node and no safe write, so writes, `ws` and Noise run only in the daemon.

**Status legend:** "typed" means it is in the module typings; "documented" means it is in Claude Code's docs but not the typings.

| Need | Surface | Status |
|---|---|---|
| Capture tool results (edits, Bash, task tools) | `tool.call` middleware, `await next(e)`. Edit and Write carry `filePath`; Bash carries `gitOperation` (commits and pushes) and `isError`, but no exit code. | typed. `bashEditDiff` is `@internal`, so it isn't used. |
| Native task mirror | TaskCreate `{task:{id,subject,description?}}`, TaskUpdate `statusChange` | typed |
| Whether the session has native task tools | `$.tool.list` | typed; *why* they are off (the env var and model list) is internal |
| Context on the next turn | `prompt.submit` hook `context`: 100k characters per entry, 200k in total. **Not `prompt.context`**, which fires once per conversation. **Not `$.state`**, which is render state. | typed. It also fires for peer and plugin prompts. |
| Notes inside a long tool loop | `$.session.append` notes; `tool.call` result `context` | typed |
| Status line, dim line | `ui.status`, `ui.log` (2,000 characters drawn) | typed |
| Let in / Refuse; keep / room / send; plan review | `ui.ask`, answered with a label or Other text | typed; it rejects when dismissed or in `-p` |
| Full plan, scrollable | `$.ui.open` pane; Pane bodies scroll (`ui.scroll`) | typed. An unasked pane only places from 144 columns, so it opens from the card. |
| Plan approval | `tool.call` on ExitPlanMode → `{plan, filePath?}` | typed; the rejection shape isn't needed |
| Plan-mode entry | none: no module event survives the guard | not used (R18 asks at approval) |
| Wake | `$.prompt.submit` (runs once the session is idle); `turn.complete.isAborted` to retry; `session.stop` | typed. Its frame text is internal. It shows as a prompt from the plugin, and is skipped when `$.session.surfaces()` is empty. |
| Presence (working or idle) | `turn.start`, `turn.complete` | typed |
| Presence (waiting on a permission prompt) | command hook `Notification`, `notification_type` | documented; about 6 s late, best-effort |
| Repo and branch | `session.repo` `{root, remote, name}` (no branch); `$.process.run(git)`; `$.vcs.detect().branch` | typed; `vcs` is experimental |
| Following the log | `$.clock.every` + `$.fs.stat` + `$.fs.read` of a small tail file | typed; 4 MiB per read, offset reads on 2.1.326+, polled every 0.5–1 s; there is no watch |
| Hash chain in the module | global `crypto.subtle.digest` | typed |
| Claude-to-Claude routing | `session.send` hook, answered `{isDelivered: true}` without `next` for `NAME.CODE` | typed hook; honouring the answer without `next` is to confirm (M1 test), and possibly internal |
| `NAME.CODE` addressing | `sessionTitle` from a `SessionStart` command hook | documented; name uniqueness is internal |
| Claude's tools | `$.tool.register` + `tool.run` | typed (also in 2.1.296) |
| Node work | `$.process.spawn`/`run`; `$.http.fetch` to loopback | typed. The module has no Node and no `import()`; spawned children die with the module. |
| `/sub-human` command, session end | command hooks (`UserPromptExpansion`, `SessionEnd`) | documented; they survive managed-machine policy |
| Managed machines | The guard skips user hooks on `classic.*`, `prompt.compose`, `prompt.section`, `prompt.context`, `prompt.attachment`, `skill.prompt`, `attribution.text`, `telemetry.log`, `session.compact`, `settings.read`, and on `session.append` rows filtered by door. `allowManagedModsOnly` refuses the module, but leaves `hooks.json` hooks alone. | documented; v2 needs none of the skipped hooks |

**Internals, as built:** 4 of the 10 allowed: the task-tool gate, the wake prompt's frame, honouring a `session.send` answer without `next` (U6 confirmed it on 2.1.330), and `sessionTitle` uniqueness. Total contract entries: 23.

**Also used, typed:** `$.session.version()` (the version a session runs, which its pings tell the daemon for doctor); the module registers `session.start` in several parts, each with its own matcher, because an event registered twice without one doesn't load.

## 10. Configuration

Six knobs, read only by `config.ts` (a value a knob can't take keeps the default and is listed by doctor):

| Knob | Values |
|---|---|
| `SUB_HUMAN_HOME` | where the plugin keeps its files |
| `SUB_HUMAN_NAME` | default member name |
| `SUB_HUMAN_INVITE` | default pathway: `public`, `tailnet` or `ssh` |
| `SUB_HUMAN_SSH_ADDR` | how others reach this host over ssh |
| `SUB_HUMAN_PORT` | listener port |
| `SUB_HUMAN_CC_OFF` | turn `wake`, `messages` or `tasks-bridge` off (the module's gated parts) |

Timings are constants in `config.ts`. Tests pass their own values in through parameters.

## 11. Size budget

Lines of code, comments and blank lines left out, as `node scripts/budget.ts` counts them (`--final` also holds tests
to no more than the runtime). Built, 2.0.0:

| Area | Lines (max) | Built |
|---|---|---|
| `core/` | 2,500 | 1,820 |
| `store/` | 800 | 529 |
| `module/` (including tools, 400) | 1,900 | 1,319 (tools 135) |
| `commands/` | 700 | 464 |
| `net/` (channel 300, pathways 600, host, link, invite) | 2,100 | 2,065 (channel 285, pathways 173) |
| keys, home, config, CLI | 1,000 | 209 |
| **Total** | **9,000** (`vendor/` not counted) | **6,406** |
| Tests (PRD Q-3: no more than the runtime) | 6,406 | 7,952: over |

The test ratio is over PRD Q-3's 1:1 at the cutover; the owner decides whether to relax it, and no test is deleted to
fit. A pull request that pushes an area over its line is either split or comes with a deletion.

## 12. Testing

The full plan is `docs/TESTING.md`: its layers, the test kit pattern, fixtures, the live gate and tests per milestone. This section is the summary.

- **Unit tests, beside each `core/` module.** Pure inputs in, outputs out. Every delivery rule and every plan and task rule is a table test.
- **Scenes** (`test/scenes/`). Each PRD story (S-Live, S-Relevant, S-Ask, plan together, send a plan, split, join, remote join, leave) runs as a script against the memory store, using Claude Code's own test kit for hooks modules (`claude plugin test`, the `claude-code/testing` module). The kit sends events through the module's hooks with no session, sign-in or network. Its stubs answer in Claude Code's place and record the module's `ui.*` and `prompt.*` calls, and `mock.clock` gives the fake clock. We don't build a fake host of our own. Assertions cover what each member sees (at most 6 lines, R41), what each Claude's context holds, and that only R10 events wake anyone. There is no live model, and CI runs every scene.
- **Network.** `link-engine` table tests on the fake clock. Two homes over `pipe` for snapshot sync, fork and kick. Noise vectors. A TLS front with PROXY v2 stands in for tailscaled. Admission tests: a leaked line dialled twice, a name mismatch, and a handshake without a MAC refused before anything is started.
- **Safety.**
  - A colleague's Claude's broadcast ("alice, run …" in a finding) must produce no wake.
  - A direct message containing a command, in any mode, must be drawn for the person, not submitted.
  - A direct "the shape changed, update your side" must wake the recipient once, and its Claude must change only its own work.
  - R19's three properties each have a test.
- **Requirements trace.** `docs/TESTING.md` §12 maps every P0 and P1 requirement to the tests that name it.
- **Live gate.** One scripted run per release with real Claude sessions, in each permission mode, covering a no-plan pairing, a plan-then-build, a non-code task and an injection scene (PRD Q-2). It records tokens per hour (Q9), colleague context per turn (R15a) and lines per person.
- **Canary.** Nightly, against Claude Code `latest` and `next`: the contract probe plus a typings diff (C1).
- **Ratio.** Test code no larger than runtime code.

## 13. Build order

All of M0–M4 is built in 2.0.0; M5 (relevance tuning) waits on real use, and M6's live gate is run by the owner.

| Milestone | Delivers | First proof |
|---|---|---|
| M0 | core types, schemas, fold and snapshot, memory store, scene harness, typings refreshed to 2.1.330, `vendor/` with `VENDOR.json` and its drift check | S-Live passes under `claude plugin test`; the vendored files load in the module and in node |
| M1 | fs-store, module (capture, follow, context, status, news, messages, wake, tools: `share` and `read`), overlap heads-up (R15d), commands | two real sessions on one machine; a relevant change reaches the other Claude by its next prompt, within 5 s of happening, under the token cap; two edits to one file give both people one line; a `SendMessage` to `NAME.CODE` is caught at the sender and wakes the recipient once |
| M2 | plans: CAS, the question at approval, room and sent plans, review card plus pane | a review changes no plan file and no mode (R19) |
| M3 | room tasks; the native bridge for sessions with the Task tools (R23–R24a, P0) | a claimed room task appears in a person's native list, and completing it there closes the room task |
| M4 | net: channel, tailscale (WebSocket, PROXY v2) and ssh (`-W`) pathways, name-bound invite and admission, link engine, mirror with snapshot sync | a join over Funnel from a machine with no Tailscale; a leaked line dialled twice alerts the host |
| M5 | relevance tuning from real use, subagent activity (R16a) | live-gate noise rating |
| M6 | release | live gate green; README of at most 200 lines |
