# Remote rooms plan

Status: plan, 2026-10-07. Not started. Sources:
- five competing plans, condensed into one and then reviewed line by line against the code (the corrections are below);
- the code as of `a884db5` (`docs/ARCHITECTURE.md` describes it).

Goal: a person hosts a room on their machine; others join from theirs over any connection. Build everything except the network transports, so SSH, a tunnel or a relay are each one small PR later. The stubs for the new modules are in the tree already (each one's header says which PR fills it); the implementer builds against them.

## Principles

1. **The host holds the truth.** The room directory on the host is the room. The log syncs host → client as byte-identical lines. The host's small documents (`members`, `presence/*`, `tasks`) stream the same way, read-only on the client. Session-local data (`rows/*`, `members/NAME/review|title`, cursors, notices, the session indexes, keys) never leaves a machine.
2. **The host decides.** Orch spawn, reap and watchdog, proposal decisions, pubkey pinning, invites and room shutdown run only where `store.isHost` is true. Remote machines append and read.
3. **A signature covers the payload, not its place in the log** (sig v2: the entry without `id`, `at`, `prev`, plus `room`, `from`, `nonce`, `ts`). The client signs, the server places. v1 signatures still verify. No compare-and-set on the wire, no lock leases, no retry loops in hooks.
4. **One link per machine, one mirror per room.** The mirror is an `FsRoomStore` directory, so every reader (`readView`, `log.idx`, the tailer, `verifyChain`, rows, digests) works unchanged. Only writes cross the wire, as named ops. A write returns after the mirror holds its result (read-your-writes).
5. **Named ops, and only as yourself.** `hello`, `join`, `leave`, `beat`, `append`, `subscribe`, `blob.get`, `blob.put`. The server checks every `from` against the seats joined over that link, re-runs `validate()` and verifies the signature. One validation module on both ends (`lib/room/validate.js` + `lib/room/envelope.js`).
6. **Hooks stay short and synchronous** (`lib/lock.js:4`). A hook's call over the wire blocks on a worker thread with a deadline under the hook timeout. Past the deadline it is `OFFLINE`: a human post is refused on the spot, never queued; a lease expiry covers a missed `leave`.
7. **The host's own processes never use the wire.** Host hooks, its tail and its MCP server keep writing the room directory directly; the server is one more local process sharing the file locks.
8. Everything in `CLAUDE.md` still holds: never pin a model, no writes to user settings or `~/.claude`, the signer only in hook processes, zero dependencies, the store seam (`test/store-bypass.test.js`), the security test (`test/hooks/security.test.js`).

## Corrections from the code

Each row replaces something the condensed plan said.

| Plan said | Code says | Change |
|---|---|---|
| "The log is the only thing that syncs; membership, tasks are log entries or folds" | `tasks.json` is a fold the **orch's** hook writes (`hooks/tasks.js`, orch only); `presence/*` and `members.json` are documents, and rows read them (`lib/rows.js`). A client cannot refold tasks without running orch code, and a presence fold in the log would spam it | The server streams `doc` frames for `members`, `presence/*` and `tasks` beside `entry` frames. One way, host → client. Nothing else syncs |
| "No CAS on the wire" | `members.update(fn)` is called by `identity.join/leave/heartbeat/rebindSession/markLeft` (identity.js 149-243) and by `orch.claimSpawn/claimClose/watchdog` through `updateOrch`. The MemoryRoomStore (test) implements it as a CAS loop | Named store ops `members.join(rec)`, `members.leave(name)`, `members.beat(name, {presence?})` carry intent; `FsRoomStore` implements them over `update`, the mirror sends them as ops. `members.update` stays for the orch bookkeeping and throws `HOST_ONLY` on a mirror. `rebindSession` is session-local (the by-sid index) and never crosses the wire. Presence rides on `beat` |
| "`dm` entry kind + MCP tool with its own rate bucket" | Entries already carry `to`; the `post` tool takes `to` (room-server.js:144) and `lane()` pushes `to === me` (lanes.js:97). The real gap is that native `SendMessage` does not cross machines | Cut the kind and the tool. An addressed post (`to !== 'room'`) gets its own rate bucket, `RATE_ADDRESSED_MAX` per (from, to). Docs say: addressed, not private (the whole room reads the log) |
| "sig v2; does it break the chain?" | `prev` is `hash12` of the previous **stored line** (store.js:246); `verifyChain`, `log.idx` and `readView` read `prev` only. `canonical()` (store.js:153) is the v1 form (stored key order, minus `sig`), and `buildEntry` signs **after** stamping `id`/`prev` (store.js:245-247) | No chain change. `buildEntry` splits into `envelope.sign` (client) and `store.place` (server, stamps `id`/`at`/`prev`). `place` also accepts a payload the local hook just signed, so the host path is sign → place in one process |
| "the host's hook appends … via the server?" | Every process on the host already shares the room directory through `lib/lock.js` | Host hooks never use the wire. The server is spawned **per connection** (`sub-human serve --stdio`) by the client's link, exactly as SSH will spawn it; there is no host daemon |
| "split `proposal.record` ~234 into answer + decide" | Correct: `record` (proposal.js 230-260) appends the answer, then the decision, under `store.lock('proposal')`, a lock that means nothing across machines | `answer(me, p, a)` (any machine, signed) and `decide(code, hash)` (host only, idempotent under the host lock: `fold.decisions.has`). Host hooks call both; the server calls `decide` right after it places a signoff/objection |
| "humanTrust returns `legacy` when no local .pub (store.js ~207-216)" | Correct: store.js 206-215; `consent.fold` counts `legacy` | Keys are pinned in the log: `member_joined` carries `pubkey`; `envelope.pinnedKeys(entries)` gives the first key seen per name. `legacy` only in a room whose log pins no key at all; a keyed room never returns it. The local `.pub` file stays as the fallback for legacy rooms only |
| "seats from other machines judged by `seen_at` not pid (identity.js ~140)" | `seatAlive` is identity.js 134-138: a seat with a pid is checked against **this** machine's pids | Seat records carry `machine` (`<home>/machine.json`, random id; never `os.hostname()`). The pid check runs only when `m.machine === machineId()`; otherwise the lease decides |
| "join writes index files inside members.update (identity.js ~199)" | identity.js 172-197: `by-pid`/`by-sid` written inside the CAS fn, on purpose (the comment at 170) | With named ops the fn is gone: `identity.join` calls `members.join`, then writes the indexes. `leave` drops the index after the op when it still names this seat. `resolveBySession/ByPid` already re-check `left_at`, so the tiny window self-heals |
| "PR3 sync bridge + proof gate, then PR4 protocol" | A sync `RemoteRoomStore` for the store contract needs the bridge **and** the protocol | Keep the bridge gate early (it proves `Atomics.wait` in a hook process and measures the cost against a plain FsRoomStore on a worker thread), but run the store contract on `Remote` in PR5, once both exist |
| "`/sub-human host` parses as join as NAME host" | Correct: join.js:110 takes `args[0]` as the name; `host` and `join` are not in `RESERVED` (identity.js:79) | Reserve both. `host` means "mint an invite for the room I am in" (the person joined with `/sub-human NAME` already); `join NAME INVITE` means "link and join" |
| "`test/security.test.js`" | The file is `test/hooks/security.test.js`. It also walks `lib/` and `mcp/` for any `require(…seat-key…)` or `.key'` string | New `lib/remote/*` files are covered by that walk: the server, the client, the bridge worker and the link daemon never load the signer |
| "macOS unix socket paths cap at 104 bytes" | Correct (`sun_path`) | `link.socketPath(home)` = `<os.tmpdir()>/sh-<hash8(home)>/link.sock` |
| "RATE_MAX 6/min" | config.js:114, enforced in `append` from the log tail (store.js:539-547) | The addressed bucket above; the server enforces both from the host log, the same code path |
| "store API is synchronous today, lock.js:4" | Confirmed | Rule 6 |
| "open/roomExists are fs-only, store.js ~767-775" | Confirmed: 767-775 | `open(code)` consults `lib/room/links.js` and returns a `MirrorRoomStore` for a linked room (lazy require, no cycle); `roomExists` is dir **or** link; `listRooms` is unchanged (mirrors are directories) |

## How it fits together

```
 HOST machine                                            REMOTE machine
 hooks / tail / MCP ──► FsRoomStore ◄── serve --stdio ◄══ transport ══► link daemon ──► MirrorRoomStore (FsRoomStore layout)
   (sign + place,        <home>/rooms/CODE   per connection    (pipe now;   (one per machine;        ▲ reads: hooks, tail, MCP, rows
    decide, orch)                             (bin/sub-human)   ssh later)   mirror + local socket)   │ writes: bridge (worker thread,
                                                                                                       │          Atomics.wait, deadline)
                                                                                              hooks ───┘ sign with the local seat key
```

- A **link** is `<home>/links/<CODE>.json` on the remote machine: transport spec, seat token, machine id, last synced `{id, hash}`. `store.open(CODE)` sees it and returns the mirror.
- The **link daemon** (`bin/sub-human link CODE`, started detached by the join hook, exits after a quiet period with no local seats) connects, says `hello`, `subscribe`s from its last `{id, hash}`, writes every `entry` line and `doc` into the mirror, prefetches `plans/<hash>.md` for every proposal it sees, and serves local hooks on the unix socket: a hook's bridge worker forwards one op and gets one reply.
- The **server** (`bin/sub-human serve --stdio CODE`) is one connection over stdin/stdout against the host's `FsRoomStore`. For the two-home test the client's pipe transport spawns it with `SUB_HUMAN_HOME=<hostHome>`. For SSH it is the forced command. Without a token it answers `hello` and nothing else.
- **Resume**: `subscribe {after, hash}`; the server checks `hash12` of its line `after`; a mismatch is `FORK`: the daemon stops syncing, logs loudly, the tail prints one `room link: FORK …` line, and `sub-human link --reset CODE` re-mirrors. No silent repair.

## PRs

Each PR ends green (`npm test`, `npm run docs`, `npm run validate`) and commits alone. Files listed are the ones that change or get filled.

### PR1 Trust: keys in the log, sig v2, one envelope module

Fills `lib/room/envelope.js`. Changes `lib/room/store.js`, `lib/room/validate.js`, `hooks/join.js`, `hooks/seat-key.js`, `test/support/memory-store.js`, `test/store-contract.test.js`, `test/hooks/security.test.js`, README threat model.

- `envelope.js`: `signable(e)` (sorted keys, minus `id`/`at`/`prev`/`sig`), `sign(payload, key, {room, from, now})` adds `room`, `from`, `nonce`, `ts`, `sigv: 2`, `sig`; `verify(e, pub)` handles v2 and v1 (v1 = today's `canonical`); `pinnedKeys(entries)`, `keyed(entries)`.
- `member_joined` carries `pubkey` (SPKI PEM) and `machine`. `validate()` allows both on that kind, system only. `join.js` passes the key `seat-key.ensure` made.
- `store.place(payload, {provisional?})`: validate, rate (both buckets), replay (`nonce` unseen within `SIG_SKEW_MS`, `ts` within skew of the host clock), verify against the pinned key (or sign-then-place when the local signer holds the key and the room is legacy), then `id`/`at`/`prev` under the log lock. `append()` = sign + place. `buildEntry` goes.
- `publicKey(name, code)`: the pinned key first; the local `.pub` only when `keyed(entries)` is false. `humanTrust` returns `legacy` only in an unkeyed room.
- Key pinning is strict: a `join` with a different key for a pinned name is refused (`AUTH`). A lost key means a new name.
- **Accept:** the contract suite passes on Fs and Memory with v2 entries; a v1 log from the demo still reads `verified`; an unsigned `signoff` in a keyed room is `unverified` and `consent.fold` ignores it; a replayed payload (same nonce) is refused; `verifyChain` over a mixed v1/v2 log is `ok`.
- **As built** (deviations from the bullets above):
  - `place(payload, {system})`: `provisional` rides in the payload, under the signature (the hook decides it before signing); `{system}` is the trusted-caller flag, as for `append`. The protocol's `append` takes `{payload}`.
  - The seam gains `place` and `pins()` (Fs: cached on the log's stat, read through `readView({after: Infinity, save: false})`; Memory: recomputed). `toPayload` (validate + sign), `admit` (validate again, rebuild the stored form) and `placeAfter` (rate, replay, trust, stamp) replace `prepare` / `buildEntry`; `canonical` moved into the envelope (`signedBytes`, v1 or v2). `envelope.parseKey` added.
  - Replay: the nonce is looked for in the log, back `2 × SIG_SKEW_MS` by `at` (a payload with a fresh `ts` may be placed up to the skew late), so it holds across processes. A human append therefore reads more than the tail; a system or agent append does not.
  - `AUTH` lands here: an unsigned or bad v2 signature, a replayed nonce, a stale `ts`, another room's payload, a key mismatch, no pinned key in a keyed room.
  - Only the `RATE_MAX` bucket; `RATE_ADDRESSED_MAX` comes with its config in PR2. `validate` accepts `machine` on `member_joined`; `join.js` passes it once PR2 has `identity.machineId()`.
  - `join.js` makes the key before the seat and blocks when it cannot; on `AUTH` it gives the seat back. `session-restore.js`'s `member_joined` (resume) carries the pubkey too.
  - Entries are tagged with the store that read them (not just the code), so `humanTrust` judges against that store's pins.
  - Consequence: in a keyed room a seat that joined before PR1 (no pin) cannot post `via=human` until it rejoins; the `AUTH` message says so.

### PR2 Machine independence: machine id, seats, host gates, decide

Fills `lib/seats.js`. Changes `lib/identity.js`, `lib/room/store.js`, `lib/proposal.js`, `lib/orch.js`, `hooks/join.js`, `hooks/session-end.js`, `hooks/consent.js`, `hooks/presence.js`, `hooks/guard.js`, `lib/config.js`, `test/support/memory-store.js`, `test/store-contract.test.js`.

- `identity.machineId()`: `<home>/machine.json`, created once. Seat records gain `machine`; `seatAlive` checks the pid only for this machine.
- Store seam: `isHost` (Fs: true), `members.join(rec) -> {ok, rejoin?, error?}`, `members.leave(name) -> bool`, `members.beat(name, {presence?}) -> bool`. `identity.join/leave/heartbeat/writePresence` call them; indexes are written after the op, not inside it.
- `lib/seats.js`: `enter({code, name, role, machine, pid?, session_id?, cwd?, pubkey})` = `members.join` + `member_joined` + (host) `ensureOrch`; `exit(code, name, reason)` = `members.leave` + `member_left` + (host) reap when no live member. `join.js`, `session-end.js` and later the server call these; the hooks keep only parsing and output.
- Host gates: `ensureOrch`, `sweep`, `reapDetached`, `watchdog` run only when `store.isHost`. `proposal.record` becomes `answer` + `decide`; `consent.js` calls both (decide is a no-op off-host).
- The server strips `pid`, `pid_start`, `session_id`, `cwd` from the `members` doc it streams; the mirror never holds them.
- `RATE_ADDRESSED_MAX` (config) for posts with `to !== 'room'`.
- `RESERVED` gains `host`, `join`. `hooks/guard.js` `PLUGIN_CODE` gains `lib/seats` and `lib/remote`.
- **Accept:** a members doc with a seat from another machine and a fresh lease is alive, with a stale lease is not, whatever its pid; `decide` run twice appends one decision; a mirror-shaped store (`isHost: false`, test double) makes `enter` spawn no orch and `exit` start no reaper.
- **As built** (deviations from the bullets above):
  - The seat rules live in `lib/room/members.js` (`seatAlive`, `leaseFresh`, the `join`/`leave`/`beat` ops, `publicView`), shared by every store as `placeAfter` is, so the store judges liveness without requiring `identity` (a cycle). `machineId()` lives in `lib/home.js`; `identity` re-exports both. A record with no `machine` is this machine's.
  - `members.join`: "name taken" when a live seat has another holder (another machine, or another pid). `identity.join` takes `machine` (default this one): a seat of this machine needs its pid and gets the indexes after the op (the previous seat of that pid is left after it, too); a seat of another machine (the server's) has no pid and no index.
  - `members.beat(name, {presence?, now?})` renews `seen_at` at most every `SEAT_BEAT_MS` (`now` is for tests; the server never passes it). Presence needs a seat: `writePresence` for a name with no seat, or a left one, writes nothing.
  - The host gates sit in `lib/orch.js` (`claimSpawn` null, `reapDetached` null, `watchdog` `'not-host'`) and `proposal.decide` (null), behind `identity.isHost(code)`, so every caller (join, sweep, session-end, the tail, consent, the server) is covered at one place.
  - `seats.switchRooms` was cut: `join.js` calls `exit(…, 'switched rooms')`, which now also starts the reaper when the old room is left empty (as a session end does). `seats.ensureOrch` is exported for the join hook's "already joined" path.
  - `publicView` is the projection the server streams (PR4). `RATE_ADDRESSED_MAX` is 10 (agent posts, per (from, to)); an addressed post no longer counts in the room bucket.
  - The resume `member_joined` (session-restore) carries `machine` too. The store contract also runs on `test/support/thread-store.js`.
  - Left for PR5: `rebindSession` still writes `session_id` with `members.update` (HOST_ONLY on a mirror), and `resolveBySession`/`resolveByPid` compare the members record's `session_id`/`pid`, which a mirror's streamed doc lacks; there a seat of this machine must be judged by its session index.

### PR3 Bridge and the proof gate

Fills `lib/remote/bridge.js`. Adds `test/support/thread-store.js` (a RoomStore proxy that forwards over the bridge to an `FsRoomStore` on the worker), `test/support/bridge-bench.js` (the numbers below), `test/bridge.test.js`, `npm run test:thread-store`. Done (branch `remote-pr3-bridge`).

- `createBridge({handler, deadlineMs})`: the calling thread posts `{id, method, params}`, then `Atomics.wait`s on a `SharedArrayBuffer` counter the worker bumps after each reply and takes it with `receiveMessageOnPort`. The worker loads `handler` (a module exporting `handle(method, params) -> result | Promise`) at its first call. A throw comes back as `RoomError` with the handler's code (else `INVALID`). Past the deadline: `RoomError OFFLINE`, the call is abandoned and its late reply dropped. The same file is the worker entry. As built, `workerData` was cut (per-call params carry everything), and the handler loads at the first call, not at boot, because a `--require` preload that itself requires the bridge (the thread store does) would otherwise see a half-loaded module: workers inherit `NODE_OPTIONS` preloads.
- Deadline budget: `LINK_CALL_MS` 3000 for 10 s hooks, `LINK_CALL_END_MS` 1000 for SessionEnd (5 s), both in `lib/config.js`; a test checks three calls fit every hook's timeout.
- Deadlock rule: while a call waits, the calling thread runs nothing, so a handler that needs it cannot finish. The deadline bounds it (`OFFLINE`, never a hang; tested). Whatever the handler talks to lives on the worker, another thread or another process.
- The gate as built: `store.open` is unchanged (a test path in production code was the alternative). `SUB_HUMAN_TEST_THREAD_STORE=1` plus `NODE_OPTIONS=--require test/support/thread-store.js` makes every node process the tests start (the hooks included) call `store.setBackend(ThreadRoomStore)`. `npm run test:thread-store` runs all of `test/hooks` that way; `test/bridge.test.js` runs `consent.test.js` that way inside `npm test`.
- What the proxy does not forward as one call: `members.update` and `kv.update` are compare-and-set loops (as the contract allows a store off this machine); `lock` and `kv.lock` take the same lock files on the calling thread (a mutex held across a callback cannot cross); a via=human `append` takes the key on the calling thread (`store.prepare`) and the worker signs with it, because a v1 signature covers `id` and `prev`. That last one is a test-only stopgap: once PR1's `envelope.sign` + `place` land, the proxy signs on the calling thread and the worker only places.
- **Accept:** the hook suites pass over the proxy (yes: 96/97, the one failure is the pre-existing `BLOCK_MAX` template test, which fails the same way without the proxy); p99 overhead per hook under 15 ms (**no**: 19-22 ms, see Results); a handler that never answers gives `OFFLINE` at the deadline, and the hook process exits (yes).

#### Results (PR3, Apple M2, node 24.15.0; `node plugin/sub-human/test/support/bridge-bench.js`)

Per call n=500, per hook n=40 (p99 is close to the max at that n). Times in ms, p50 / p99.

| | plain | over the bridge | overhead |
|---|---|---|---|
| `lastId()` | 0.027 / 0.044 | 0.040 / 0.097 | 0.013 / 0.053 |
| `kv.get()` | 0.013 / 0.031 | 0.025 / 0.053 | 0.012 / 0.022 |
| `members.read()` | 0.022 / 0.041 | 0.033 / 0.052 | 0.011 / 0.011 |
| `readView({after})` | 0.081 / 0.182 | 0.109 / 0.197 | 0.028 / 0.015 |
| `readAll()` (40 entries) | 0.016 / 0.027 | 0.069 / 0.218 | 0.054 / 0.191 |
| `kv.update()` (compare-and-set) | 0.317 / 0.609 | 0.362 / 0.664 | 0.045 / 0.055 |
| first call of a new bridge (worker boot + loading the store) | | 15.7 / 17.3 | |
| a process: one call to an empty handler vs none | 26.4 / 28.8 | 42.4 / 44.6 | 16.0 / 15.7 |
| `prompt.js`, a plain prompt | 38.7 / 40.9 | 58.4 / 60.5 | 19.6 / 19.6 |
| `prompt.js`, an `@room` post (signed append) | 40.6 / 42.4 | 62.4 / 64.2 | 21.8 / 21.8 |
| `presence.js`, idle_prompt | 34.0 / 38.4 | 54.3 / 56.9 | 20.3 / 18.6 |

Verdict: the mechanism passes and the per-hook target as written does not. A call costs tens of microseconds; a hook makes 10-60 of them, so per-call cost is under 1 ms per hook. The whole per-hook overhead is the fixed cost of booting a worker: about 16 ms for an empty handler, about 20 ms when the worker also loads `lib/room/store.js`. No tuning of the bridge removes that. It is invisible to a person (a hook runs in 35-45 ms and has 10 s), so the remote design holds, on three conditions for PR5:
1. The mirror creates its bridge at a hook's first wire op, never at `open`. Reads use the mirror's files, so a hook that only reads (most prompts) pays 0 ms; only hooks that write (`@room`, an answer, join, leave, a beat) pay the boot.
2. The production handler (`link.js` `handle`) loads nothing but the socket client: not `lib/room/store.js`. That keeps the boot near the 16 ms floor.
3. The target becomes "a hook that only reads: no worker; a hook that writes: under 25 ms p99 overhead plus the link's round trip", measured again in PR5 over the real socket.

### PR4 Protocol, server, client, auth, transports

Fills `lib/remote/protocol.js`, `lib/remote/server.js`, `lib/remote/client.js`, `lib/remote/auth.js`, `lib/remote/transports/{index,memory,pipe}.js`, `test/support/flaky.js`. Adds `bin/sub-human serve --stdio CODE`, `test/remote-protocol.test.js`, `test/remote-server.test.js`.

- Frames are newline-delimited JSON (as the MCP server speaks); blob bytes travel base64 (plans are ≤ 256 KB, `PROPOSAL_FILE_MAX`). `hello` carries `v` and `caps` on both sides; a server that does not know a client's `v` answers `PROTOCOL`.
- `auth.js`: `mintInvite` (secret shown once, `sha256` stored in kv `remote/invites`, single use), `redeemInvite -> token` (`sha256` stored in kv `remote/links` with `machine`, `seats`), `verifyToken`, `mayWriteAs(link, from)`. Both kv docs are host-only and never streamed.
- `server.js`: one `Session` per transport; unauthenticated until `hello {token|invite}`; op handlers below; `subscribe` runs the store's `tailer()` plus a cheap poll of the three docs, until the transport closes. After placing a `signoff`/`objection` it calls `proposal.decide`.
- `client.js`: the promise API the daemon and tests use (`hello`, `join`, …, `subscribe(after, hash, onEvent)`).
- `transports/memory.js`: `pair()` over a `MessageChannel`, so the two ends may sit on different threads (the Remote contract backend in PR5 puts the server on a worker: a thread that makes sync bridge calls must never host the server). `transports/pipe.js`: `spawn(cmd, args)` for the client end, `stdio()` for the server end. `test/support/flaky.js` wraps any transport: seeded drop / delay / duplicate / cut.
- **Accept:** protocol round trips over memory and over pipe (`serve --stdio` as a child); a client writing `from` a name it did not join gets `AUTH`; a bad or reused invite gets `AUTH`; no token gets `AUTH` on every op but `hello`; a cut transport mid-`subscribe` and a reconnect with `{after, hash}` resumes with no gap and no duplicate; a wrong `hash` is `FORK`; the flaky transport's dropped frames surface as `OFFLINE` on the caller's deadline, never as a half-applied write.

### PR5 Mirror, link registry, link daemon, commands, two homes

Fills `lib/room/store-mirror.js`, `lib/room/links.js`, `lib/remote/link.js`. Changes `lib/room/store.js` (`open`, `roomExists`), `hooks/join.js` (`host`, `join NAME INVITE`), `bin/sub-human` (`link CODE [--reset]`, `invite`), `lib/tail.js` (one line on `FORK` / `OFFLINE`), `test/store-contract.test.js` (backend `remote`), `skills/sub-human/SKILL.md`. Adds `test/remote-e2e.test.js`.

- `MirrorRoomStore extends FsRoomStore`: reads are the parent's; `append` = sign locally (the hook's signer) → bridge `append` → the entry, once `applyLine` has written it; `members.join/leave/beat` and `blobs.put` are ops; `members.update` and `kv.set` on the streamed docs throw `HOST_ONLY`; `blobs.get` is the local file, else `blob.get` through the bridge; `localPath` is the mirror's file (prefetched). `applyLine(line)` / `applyDoc(key, value)` are the daemon's writes: `applyLine` checks `prev` against the mirror's last line and refuses with `FORK` otherwise.
- `links.js`: `get/set/remove/list`, files 0600, `<home>/links/` 0700. The token is the client's credential and is stored in clear there (same trust as the seat key).
- `link.js`: `run({code})` and `socketPath(home)`; `handle(op, params)` is the bridge handler that forwards to the socket. The daemon exits `LINK_IDLE_MS` after the last local seat left.
- Commands: `/sub-human host` → `auth.mintInvite` for the room I am in, printed once (`sh1.<code>.<locator>.<secret>`); `/sub-human join NAME INVITE` → `links.set`, start the daemon detached, `hello {invite}` → token, `seats.enter` over the link, the usual mechanics block. `OFFLINE` at join blocks the prompt with the reason.
- `store.open(code)`: link → mirror, else Fs. The store contract runs on `fs`, `memory`, `remote` (server on a worker thread over the memory transport, the mirror on the test thread through the bridge).
- Two-home e2e: two temp `SUB_HUMAN_HOME`s; the client's link spawns `serve --stdio` with the host home through the pipe transport; the real hooks (`join`, `at-room`, `consent`, `session-end`) run on both sides as child processes; assert the mirror's `log.jsonl` is byte-identical to the host's, `verifyChain` is `ok` on both, a remote `@room` shows `verified` on the host, a remote signoff completes a decision written by the host, the remote's rows/cursors never appear on the host, and killing the server mid-session makes the next remote `@room` fail `OFFLINE` with nothing written anywhere.
- **Accept:** all of the above; `store-bypass` still green (the mirror is `store*.js`); the security walk finds no signer load under `lib/remote/`.

### PR6 Docs and demo

Changes `docs/ARCHITECTURE.md` (a Remote section: the diagram above, the op table, the trust changes), `plugin/sub-human/README.md` (join from another machine, threat model: the host is trusted, a link token is a seat-level credential, addressed is not private), `scripts/demo.sh` S11 (a third seat from a second home over the pipe transport; one `@room`, one signoff), `scripts/checks/s11-remote.js`, `scripts/baselines.json`.

### Next, not now

SSH = the pipe transport with `ssh -T -o BatchMode=yes HOST` in front, a forced command `sub-human serve --stdio CODE --link ID` in `authorized_keys`, and `sub-human authorize INVITE` to write that line. No protocol change.

## Protocol

Request `{id, op, params}`, reply `{id, result}` or `{id, error: {code, message}}`, stream event `{id, ev, data}` (`ev`: `entry` | `doc` | `end`). One JSON object per line.

| Op | Params | Result | Who may | Server does |
|---|---|---|---|---|
| `hello` | `{v, caps, machine, token?}` or `{v, caps, machine, invite}` | `{v, caps, room, link, token?}` | anyone | version check; `verifyToken` or `redeemInvite` (token returned once) |
| `join` | `{name, role: 'member', pubkey, session?}` | `{ok, rejoin?}` | a link | `seats.enter` with `machine` = the link's; pins the key or refuses `AUTH`; binds `name` to the link |
| `leave` | `{name, reason}` | `{ok}` | a link, its own seat | `seats.exit` (reap gate on the host) |
| `beat` | `{name, presence?: {state, detail?}}` | `{ok}` | a link, its own seat | `members.beat` |
| `append` | `{payload}` | `{entry}` | a link, `payload.from` its own seat | `validate`, `verify`, rate, replay, `place`; then `decide` for an answer. System kinds allowed from a link: `retract` of its own entries only |
| `subscribe` | `{after, hash}` | stream | a link | `hash12(line after)` must equal `hash`, else `FORK`; then `entry` events in id order and `doc` events for `members`, `presence/*`, `tasks`; `end` when the room closes |
| `blob.get` | `{ref}` | `{bytes}` (base64) | a link | `blobs.get` |
| `blob.put` | `{name, bytes}` | `{ref}` | a link | `blobs.put` (content-addressed, idempotent) |

Rate limits (`RATE_MAX`, `RATE_ADDRESSED_MAX`) and size caps (`ENTRY_*`, `LOG_LINE_MAX_BYTES`, `PROPOSAL_FILE_MAX`) apply on the server from the host log, through the same functions the local store uses.

## Error codes

`RoomError.code` today: `INVALID | RATE | LOCK | NO_ROOM`. Added, used on both ends and on the wire unchanged:

| Code | Means | Caller does |
|---|---|---|
| `OFFLINE` | the link is down, or the deadline passed | a human post is refused with the reason, nothing queued; an agent tool returns the error; a read uses the mirror |
| `HOST_ONLY` | an op the mirror never performs (`members.update`, writing a streamed doc, `decide`, orch control) | a bug if seen outside tests: the gates must have kept it out |
| `AUTH` | no or bad token, a used invite, `from` not this link's seat, a pinned key mismatch; a missing or bad signature, a replayed nonce, a stale `ts`, no pinned key in a keyed room (PR1, `store.place`) | the join hook blocks the prompt with the reason; the tail prints one line |
| `FORK` | the mirror's last line is not the host's | the daemon stops; `sub-human link --reset CODE` |
| `PROTOCOL` | unknown version or a malformed frame | the daemon stops; the tail says which version |

## Decisions

- **`at` is the host's clock; `ts` is the signer's claim.** Readers, digests, `isYoungProvisional` and the forgery window use `at`. `ts` only bounds replay (`SIG_SKEW_MS`, 10 min). The nonce set is per link, bounded to that window.
- **No daemon on the host.** `serve --stdio` per connection; the file locks are the coordination, as between hooks today. Two servers (two remote machines) both calling `decide` is fine: idempotent under the host lock.
- **Presence rides on `beat`.** One op for liveness and state; `identity.writePresence` becomes `members.beat(name, {presence})`. On the host it is still the kv document rows read.
- **Keys are pinned in the log and strict.** A name is its key for the room's life. Rotation is "join with a new name". Consequence: a seat on a new machine needs a new name. Simpler than a rotation protocol; revisit only if people hit it.
- **Legacy stays legacy.** Rooms from before PR1 (no pinned key) keep today's behaviour. A keyed room never counts an unsigned answer.
- **No `dm`.** `to` is the address; the whole room reads it. Claudes on one machine keep native `SendMessage`.
- **Read-your-writes through the daemon.** A hook's `append` returns after the mirror holds the placed entry (the daemon applies the subscribe stream up to and including it), so the hook's next read sees it, as today.
- **`store.open` picks the store.** Nothing else learns about links; the resolver is a lazy require inside `store.js` so `store-mirror.js` can extend `FsRoomStore` without a cycle.
- **Bridge handler is a module path.** The worker side of `bridge.js` loads the handler (`link.js` `handle` in production, `thread-store` in PR3), so one bridge serves the gate and the real link.
- **A worker boots only when a hook writes over the link** (PR3's results). Booting costs about 16 ms per hook process; each call after that costs microseconds.
- **The invite is one string.** `sh1.<code>.<locator-base64url>.<secret>`; the locator is the transport spec (`pipe:…` for the test, `ssh:user@host` later). The token it redeems to is the link's credential, kept in the link file on the client (0600) and hashed on the host.
- **The orch stays where it was spawned.** Only the host spawns it (rule 2); its native task list stays on the host; remote members' `task` requests travel as `task_req` entries as today.

## Cut

Lock leases; generic compare-and-set on the wire; a separate transport conformance kit (the store contract on `remote` and the protocol tests cover it); `known_seats` (the log's pinned keys are the list); an end-to-end codec; tunnel + PIN; the `dm` kind and tool; key rotation; a host daemon; any queue for offline writes.

## Decided by the user (2026-10-07)

1. **Strict key pinning.** A name is its key for the room's life; a lost key means a new name. No rotation op.
2. **Invite is one string**, `sh1.<code>.<locator>.<secret>` (no preference given; copy-paste wins).
3. **`host` and `join` are reserved names.**
4. **Rows show remote seats' live state** from `beat` presence.
5. **S11 runs the second home on the same machine** over the pipe transport.
6. **The two failing tests on main** (the contract probe against 2.1.292, a template over `BLOCK_MAX`) are not fixed before PR1; they stay out of this plan's scope.

## Ordering

```
PR1 trust ─► PR2 machine independence ─► PR3 bridge gate ─┐
                                        PR4 protocol ──────┼─► PR5 mirror + link + e2e ─► PR6 docs + S11 ─► (SSH)
```

PR3 and PR4 are independent of each other and can run in parallel after PR2. Each new module's stub names its PR in its header.
