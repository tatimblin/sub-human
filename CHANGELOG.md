# Changelog

Each release names the Claude Code versions it was tested on. Marketplace installs update only when `version` in `plugin/sub-human/.claude-plugin/plugin.json` changes; run `/plugin marketplace update sub-human`, or turn on auto-update for the marketplace in `/plugin`.

## Unreleased

Hardening from the October 2026 review (branch `fix/stage0-hardening`).

**Restart every session after you update.** This release keeps a room's log in segments. A session, a room's Claude or a `serve` still running 0.5.0-beta.15 or before reads a split log as broken (a few lines, then "hash chain breaks"). A log does not split while a seat or room Claude of an older version may still run on its machine: the room says so once ("this room's log is large and waits to split…"), and it splits after those sessions restart (`/exit`, then `claude`).

### Security
- **An admitted machine joins as the one name on the host's card.** The link a Let in makes was not bound to that name: it could take any name no live seat held, and as many seats as it liked (each a member_joined the room's Claude answers). A bound link (an admission's name, a handoff's or promote's pre-bound seats) now joins only those names; another is `AUTH` before a seat is taken.
- **A link's posts are bounded on the host.** A person's own posts over a link are limited to 30 a minute per seat (typing never meets it), new plans too, and a connection holds one subscribe stream (a second replaces the first); stage 7 turns these into one quota per op.
- **`SUB_HUMAN_SSH_OPTS` can no longer weaken the link's pinned ssh options** (its key, known_hosts file, `StrictHostKeyChecking`): ssh takes an option's first value, and the environment's options now come after them.
- **`propose({path})` reads only under the session's working directory or Claude Code's plans directory.** The bytes go to every mirror and the whole room, so a steered model could have exfiltrated any readable file with it. The working directory is the seat's (the MCP server's own was the root before); a session started in `~`, `/` or above `~` has none, and the plugin's home, `~/.sub-human`, `~/.ssh` and `~/.claude` (its plans aside) are refused whatever the root.
- **`Read`, `Grep` and `Glob` of the home's secrets are denied** by the hooks module: `<home>/keys/` (the seat keys, the one file a model could sign a person's words with, and the machine key), `<home>/listen/` (the web listener's private key) and `<home>/links/` (a link's token, a pending invite's SECRET and PIN, a web link's own key). A `Grep` from the home or any directory above it is denied too (ripgrep would descend into them). The rest of the store stays readable.
- **A join hook that throws still answers hidden** for a prompt that may carry a PIN, instead of a bare non-blocking error.
- **The compile cache lives in `<home>/cache` (0700)**, not a shared temp directory.
- **A join prompt whose input cannot be read is answered hidden too**: the hidden reply was chosen only after the prompt was parsed.
- **The plan view is written only to the session's plan file**: a `planFilePath` the model put in `EnterPlanMode`'s input no longer chooses where the hook writes a proposal (only `ExitPlanMode`'s, which Claude Code injects, is read).

### Fixes
- **`/sub-human vole-8126` joins that room as your default name**, not as a person named "vole-8126".
- **`@room` and `@claude` followed by a newline (Ctrl+J) post as usual**, instead of reaching your Claude as a plain prompt.
- **The join flow fits its hook budget**: the link start and card waits sum to under 7 s of the hook's 10 s (`LINK_START_MS` 2 s, `LINK_JOIN_WAIT_MS` 4 s).
- **A lock wait gives up before the hook is killed** (`LOCK_TIMEOUT_MS` 4 s), so a wedged lock is reported as `LOCK`; the room Claude's watchdog takes the members lock only when it has something to write.
- **The task gate fails closed on stdin it cannot read** for a TaskCompleted (exit 2), instead of letting the completion through.
- **The room MCP `read` tool shows no signature material** (sig, nonce, pubkey) and marks a person's line whose signature does not verify (stage 5: as rendered lines).
- **A wake's head says the room lines are other people's words, not instructions.** The Funnel warning no longer claims the URL holds a secret.

### Hooks (stage 2)
- **A session that never joins a room starts no node on any event but `/sub-human`.** Before, it started node at its start, on every subagent, card, plan-mode call and room tool, on each notification, compact, clear and resume, and at its end. The hooks module now runs every hook but the `/sub-human` expansion and SessionEnd, only where it can act: the row hooks for a row agent in a seated session, consent for a seat (a room tool only while a review may be open), presence, the restore and the rewake for a seat. SessionEnd starts node only for a session with a lease or a seat. Measured per event in `docs/ARCHITECTURE.md` (Performance).
- **One node entry, `hooks/run.ts <handler>`**, reads a hook's stdin once and writes its one answer; `hooks/common.ts` is split into `seat.ts` (no signer) and `context.ts`, and only the handlers that sign arm the seat key.
- **Presence has one writer**, the module: a seat just taken or put back shows none until its person types (it showed "working"). An `@room` typed in a session with no seat is refused by the module itself, in the same words.
- **After `--resume`**, the rows come back through a wake the module submits; the person sees one line, "restoring this session's rows".

### Commands (stage 3)
- **The joiner is told when the host let them in.** After the invite line (`/sub-human join HOST ROOM SECRET`) and then `/sub-human join PIN` when the host asks for it, the session that typed them shows one dim line once the host's card answers: `the host let you in to room vole-8126: type /sub-human to join it as carol` (or why the join stopped). Before, they had to guess when to type `/sub-human`. The join still never takes the seat in the step that carries the PIN.
- **A join line without its PIN says so.** `/sub-human join HOST ROOM` with no PIN is the join over your own ssh login, and now says it; a refused login adds that an invite's line ends with its 4-digit PIN. From a second sub-human folder (`pipe:`), which has no login path, it says the line lost its PIN.
- **An invite to this machine's own name says it is a guess.** With no `--ssh` and no `SUB_HUMAN_SSH_ADDR`, the invite says it used this machine's host name (a `.local` name reaches the same local network only) and how to give another, and, when Remote Login is off (or no sshd runs), that the joiner's ssh will fail and `/sub-human invite --web` is the other way.
- **`/sub-human join vole-8126` joins that room on this machine** (it asked "which room?"), as `/sub-human vole-8126` does; **`/sub-human help WORDS` shows help** (it was refused); **a word of digits is no name** (`/sub-human 4829` says it looks like a PIN).
- **`sub-human` with an unknown command prints its usage one command group per line**, not as one 600-character line.
- **SKILL.md's fallback no longer blames hooks being off** whenever the SUB-HUMAN block is missing: it names both causes (hooks off, or the hook failed before answering, which the terminal shows) and the next step for each.
- **Inside:** `/sub-human` is a table of verbs (`lib/commands/`); the join hook only reads who asked and renders the one answer. The hidden rule for anything PIN-shaped is the router's, decided before any verb parses. Taking a seat is `lib/seats.ts` take, the joiner's link steps `lib/remote/joining.ts`.

### Consent (stage 4)
- **The plan view is written only to Claude Code's own plan file.** The file is the transcript's `plan_mode` attachment; the `planFilePath` Claude Code injects into `ExitPlanMode` counts only when it is that same path or lies under the plans dir. A path the model chose never becomes the file a proposal is written to (a project's own `plansDirectory` keeps working: it is the attachment's path).
- **Shorter lines for your Claude.** Everything consent tells the model is one table of short lines: the one thing to do next per step of a review, and what was or was not recorded. The note's reminders say once to show its card now, and that an Esc on it was no answer.
- **A new review over one left behind on the same plan file keeps your plan as its backup** (it took the proposal text still in the file, so closing it could have left the proposal there instead of your plan).
- **Inside:** a review and a waiting note are one pure reducer (`lib/consent/review.ts`, every phase × event table-tested), the note's five flags one stage (a note an earlier version wrote still reads), and every card the hooks build is read by one function (`lib/consent/card.ts` `answerCard`). The consent hook only gathers facts, runs effects and answers. Nothing changes in what records an answer: plan view first, the card as fallback, only your own answer there (`via=human`).

### Store (stage 5)
- **Fast on a long log.** With 100,000 entries, an `@room` post's append takes about 1.5 ms (was 150: the pinned keys were read again from the log inside the log lock on every person's post) and the agent-panel status line about 5 ms (was 73), measured in-process after warm-up (`test/perf.node-test.ts` holds the budget: 50 and 30 ms). The pinned keys and the room's host are carried forward one new line at a time; a read of an unchanged log is the cached array itself; the consent fold is reused while the log is unchanged and passes over chat without reading it; the rows read the log from its end.
- **Less work while idle.** The tail's health tick no longer re-parses and rewrites `log.idx` every 5 s (a process keeps the checkpoint it reached in memory; `log.idx` is written as it gets 64 KiB or a minute further); the room row's hold folds only the joins and leaves, not the whole log, each second; the tasks hook reads the log once per event; `/sub-human` checks every room's seats with one `ps` call, not one per seat.
- **A person's own posts are rate limited too**, 300 a minute per seat (typing never comes near; a script driving the hooks does). Over a link the host's 30 a minute stays.
- **The room MCP `read` tool returns rendered lines**, as the tail shows them (`#12 bob[human] (unverified) say "…"`): no signature material, the trust marker in the line. Before, it returned entries with a `trust` field.
- **The room MCP server finds its seat by the session's id** (`CLAUDE_CODE_SESSION_ID`), and by its parent claude process only when that id names no seat (a `/clear` since).
- **One session document per seat** (`members/NAME/session`): the delivery cursor, the notices shown, the plan-view review, a waiting note, the pick, the row holds and row-hold's counts, where they were six documents. A seat an earlier version kept keeps its cursor and open review: the first write migrates them.
- **Inside:** `lib/room/store.ts` is the seam over `trust.ts` (whether a person's line is theirs, from keys passed in), `rules.ts` (the placement rules, pure), `log-io.ts` (the log's bytes, imported by `fs-store.ts` alone), `fs-store.ts`, `registry.ts` and `keys.ts`; the mirror composes a file store instead of extending it. A person's line is judged by the store that read it (`RoomStore.trust`), not by a hidden tag on the entry. One `deliver(me, e)` (none, context, notice, wake) replaces the lanes and the tail's chat test; `lib/notices.ts` folds into `render.ts` and the session document. One `hash12`, `HASH_RE`, `roomLine`, `hostStore` and `validPid`; `store.since`, `store.watch` and `render.tailLine` are gone. The store-bypass test checks the import graph. The on-disk log and the link protocol are unchanged.

### Log segments and garbage collection (stage 6)
- **A room's log is kept in segments, with a snapshot.** Once `log.jsonl` reaches 1 MiB (about 5,000 lines) it is sealed as `log-0001.jsonl`, `log-0002.jsonl`, … and `snapshot.json` records what the sealed lines decide: every proposal, answer, decision, join and task entry, the pinned keys, the host, and the last minutes of entries the rate limits and the replay check need. A new process reads the snapshot and the newest segment, not the whole log: over 100,000 entries a status line's first draw takes about 20 ms (was 86) and the first `@room` post about 6 ms (was 7); warm, an append takes 0.6 ms (was 1.5). The hash chain runs on across segments (each segment's first line repeats the previous one's last), a segment that does not chain is never sealed, and a replayed signature is refused after a rotation as before. `log.idx` is retired.
- **Rooms from before open unchanged.** A room with one `log.jsonl` reads, folds and appends as it did, and is sealed the first time an append finds it over the size (a long log once, about 130 ms). A session still running the previous version keeps appending correctly after a rotation; restart it to read the room's older lines again.
- **A new mirror starts from the host's snapshot.** A host whose log is in segments sends a machine that joins its snapshot and the lines after it instead of every line (`snapshot`, an additive capability of the link protocol). An older host, or an older joiner, gets every line as before; the protocol version is unchanged. A snapshot whose head, keys or next line do not hold stops the link with FORK, as a line that does not chain does; nothing is repaired.
- **Closed rooms are set aside after 30 days.** A room on this machine closed for good (every person left: a seat whose session crashed has not; its room's Claude stopped), with no link to it or from it (this machine's link, or the host's records of machines linked to it) and nothing changed in it for 30 days is renamed to `rooms/CODE.gc-TIME`, with its seat keys at `keys/CODE.gc-TIME`, the next time someone joins a room here (at most every 6 hours, in at most a quarter second; never the room being joined), and deleted 30 days after that. So are the folders `sub-human link --forget` set aside. The session indexes of sessions that ended go after 30 days, and a room's agent-row maps of ended sessions after 7.
- **`/sub-human` no longer looks at every room ever made.** `<home>/open-rooms.json` names the rooms that may be open (written when a room opens and at every join; a room closed for good leaves it), and only those are checked for live seats.
- **Inside:** `lib/room/log-io.ts` keeps the segments, the rotation and the snapshot's file; `lib/room/snapshot.ts` what a snapshot holds, and the checks a mirror runs on a host's (pure); `lib/gc.ts` the sweep. The store gains `recentFrom()` and `snapshot()`; `verifyChain` keeps its checkpoint in memory (no `save`). The store contract runs a rotation case over all four backends.

### Remote links (stage 7)
- **A machine is its key.** Each sub-human home has an Ed25519 machine key (`~/.sub-human/keys/machine.json`, under the same `Read` guard as the seat keys). A link proves it, and the host records the machine's id from the key (`k…`), not the id the link reports, which is only a label. A link could claim the host's own id before, and with it local liveness, the admission card and the host person's account; now no link can pass for the host or another member's machine. The id is the same for every room and host, so a machine that joins again (a new invite, a handoff's new host) is the machine it was. A 0.5 beta that sends no key keeps its reported id, which may not be the host's or another link's (`AUTH`).
- **A seat over your own ssh login is its own person by default.** It was the host person's own for consent (one person with the host's seats), so on a shared login everyone who had it answered as the owner. The host person turns that on per room: `sub-human options CODE login-same-person on`, in a terminal (the guard refuses it to a model). For the demo nothing changes (its joins are PIN joins); the lab's `login` scenario checks the new default.
- **Quotas for every op a link sends**, in one table (`LINK_QUOTAS`): 30 posts a minute per person and per Claude (a Claude's posts to every addressee together), 40 new plans an hour, 60 subscribes, 30 joins or leaves and 120 hellos per 10 minutes per link, counted in the host's own record so a reconnect resets nothing, and per-connection caps on hellos, beats, plan fetches, pings and handoff answers. Over one is `RATE` with when to try again. `LINK_HUMAN_RATE_MAX` and `LINK_BLOBS_MAX` fold into it.
- **The host watches a room instead of polling it.** A link's stream on the host followed the log and re-read every document four times a second, per connection; it now follows `fs.watch` on the room (one watcher per room and process), reads a changed document alone, and polls every 2 s only for an event the watcher missed (a room it cannot watch is polled as before). A first sync's replay goes out 500 lines at a time and waits for the connection to drain.
- **Errors say which, in a field, not in words.** An error carries a typed reason beside its code (`PLACED_ALREADY`, `UNKNOWN_OUTCOME`, `INVITE_USED`, `PIN_LAST`, `ROOM_CLOSED`, `NO_SEAT`, `QUOTA`, …), on the wire (additive), through the bridge and the link daemon's socket, and in the link's state file (`lastReason`, `lastCode`). The outbox, the mirror, `doctor` and `link --forget` decide on it, never on an error's words. Against a 0.5 beta host, which sends none, a post a slow link sent twice is reported unsent though it landed.
- **`demote` takes the invite and its PIN on stdin or `--from FILE`**, never as arguments (`ps` and the shell's history kept them). `promote` prints "run `sub-human demote CODE` and paste: INVITE PIN".
- **The link daemon's logic is a state machine.** `lib/remote/link.ts` (950 lines) is now `link-engine.ts` (connect, backoff with jitter, wake and network redials, ping, make-before-break, outbox, stop: `step(state, event) -> effects`, no I/O, tested from a table on the fake clock), `link.ts` (the daemon that runs the effects), `link-socket.ts` (the hooks' socket, which no longer loads the store in a hook's bridge worker) and `link-connect.ts` (the hello, and one reading of ssh's stderr for the daemon, the login join and `doctor`). `auth.ts` is now `invites.ts` (one bound-invite record for a handoff's and a promote's), `host-links.ts` and `admission.ts`. `doctor` is `doctor.ts` and `doctor/{links,ssh,listener,claude,redact}.ts`.
- **Interop:** a 0.5.0-beta.15 host and a joiner on this version link both ways (protocol 1–2; everything new is additive). The lab's skew scenario is now beta.15 both ways over the PIN join.
- **Removed:** sh1 invites (the tests' and the lab's internal PIN-less way in; tests now use a bound invite or a link record), the client's rewrite of a pre-0.4 host's refusal, the `v`-only hello (a hello names its protocol range; a pre-0.5 joiner is told to update), 0.4.1's TMPDIR socket path, `doctor --fix`'s rewrite of 0.2's `authorized_keys` lines (doctor still warns about one: remove it and invite again), the `up`/`down` link-state words, 0.4.x's "orch" name for the room's Claude (members, logs, the session index, its old cursor), the pipe as a way people join (it stays for the tests and the demo's S11, undocumented), and these 17 environment overrides (the defaults stay): `SUB_HUMAN_ROOM_CLAUDE_CLAIM_MS`, `SUB_HUMAN_ROOM_CLAUDE_SETTLE_MS`, `SUB_HUMAN_ROOM_CLAUDE_SETTLE_MAX_MS`, `SUB_HUMAN_TAIL_STALL_MS`, `SUB_HUMAN_TAIL_ERROR_LOG_MS`, `SUB_HUMAN_TAIL_BACKOFF_MS`, `SUB_HUMAN_TAIL_BACKOFF_MAX_MS`, `SUB_HUMAN_TAILSCALE_SERVE_MS`, `SUB_HUMAN_LISTEN_IDLE_MS`, `SUB_HUMAN_HANDOFF_ASK_MS`, `SUB_HUMAN_PROMOTE_OFFLINE_MS`, `SUB_HUMAN_LINK_RELAY_MS`, `SUB_HUMAN_LINK_NET_POLL_MS`, `SUB_HUMAN_LINK_SILENT_MS`, `SUB_HUMAN_LINK_OUTBOX_AGE_MS`, `SUB_HUMAN_COLOR` (use `NO_COLOR`) and `SUB_HUMAN_ROOM_CLAUDE_ARGS`.

### Invites (stage 7b)
- **An invite is a line and a PIN told apart.** `/sub-human invite` shows `/sub-human join DEST ROOM SECRET` (over the web `/sub-human join URL SECRET`) and, apart from it, a 4-digit PIN to tell the joiner another way. SECRET is 39 characters of lower-case Crockford base32 (no punctuation for a chat app or mail client to eat): 128 bits of single-use randomness and a 64-bit tag of the host's key. The joiner types the line; their machine checks that the host it reached holds the key the tag names (the web listener's key, or over ssh and a pipe the host home's machine key signing a fresh nonce) before it sends the SECRET; the host asks for the PIN, and `/sub-human join PIN` gives it. The host checks the PIN online only: 5 tries per invite, and after each wrong one the invite takes no PIN for 2, 4, 8 then 16 s (the machine that typed it one step longer); a throttled PIN costs nothing. The host's card is still the final gate, and neither step takes the seat: a bare `/sub-human` does once the host lets the machine in. The host keeps only `sha256(secret)` and `sha256(secret:PIN)`, so its store no longer holds an open invite's PIN in clear.
- **COMMANDS-REVIEW's "the PIN is the whole secret" decision is reversed.** A 4-digit PIN as the only secret needed a PAKE (CPace over a vendored curve library) to keep it from being guessed offline, and an ssh enrollment door in `authorized_keys` for joiners with no key yet. A 128-bit secret in the line makes guessing pointless without the line; the PIN stays as a second factor that a leaked line (a chat log, a forwarded mail) does not carry, and it never needs to resist offline guessing because it is only ever checked online, by the host.
- **Over ssh only your own login remains.** An ssh invite rides the joiner's own ssh login to the host account (the line carries `--home PATH` when the host's folder is not `~/.sub-human`); the plugin writes nothing to `authorized_keys`, makes no per-link ssh key and pins no host key of its own. Someone with no ssh login on the host is invited over the web (`/sub-human invite --web`). A handoff's follower over ssh follows through its own login to the new host.
- **A web link is a key, not a bearer token.** Over the web the link runs Noise XK (it was NK) with a key of its own, made for that link on the joining machine; the host binds the link (and the join request its PIN made) to that key, so a link's token alone gets nowhere. The per-link key is X25519 and separate from the machine key (node:crypto cannot turn Ed25519 into X25519, and a kicked link's key dies without touching the machine's identity).
- **Protocol 3.** A link made under protocol 2 (a token; NK over the web; an ssh key an admit let in) keeps working until it is invited again or kicked. A 0.5.0-beta.15 host's line (a 4-digit PIN where the SECRET goes) is refused here saying the host must update; this host's line is refused by beta.15 ("the PIN is the 4 digits"), and the invite text says the joiner needs a newer sub-human; a beta.15 PIN attempt that still reaches this host (the listener, or a leftover door's `serve --enroll`) is answered with the skew message. `skewMessage` takes the version a request needs, so overlapping ranges still name the side that lacks it.
- **Deleted:** `lib/remote/cpace.ts`, `lib/remote/enroll.ts`, `lib/vendor/noble` (about 8,000 vendored lines) and `scripts/vendor-noble.js`, the enrollment door and per-link keys in `sshkeys.ts` and `shim.ts`, and their tests. `kick` still removes a line an older version wrote for its link; `doctor` names a leftover door and `doctor --fix` removes it.
- **Fixes on the way:** an invite line over a login transport now sends its invite (a login hello first would have made a login link with no PIN and no card); a SECRET-shaped word is never echoed in a reply nor taken for a name or a room; the hidden-prompt rule covers SECRET-shaped words; `invite` in Claude Code's `!` shell masks the SECRET with the PIN.

### Claude Code internals (stage 8)
- **The probe no longer fails on a release that only adds a key to the bg daemon's env allowlist.** `daemon-env-allowlist` matched the binary's arrays as exact JSON, so every release that added a key (2.1.292, 2.1.296) failed it. It is now a shape: each array, found by a literal or shape at its start, must hold the keys the plugin copies, in any order, more allowed; a key dropped still fails. The derived `daemon-env-names` check folded into it, so the probe counts 79 (79/79 on 2.1.296; it was 80/80 with the derived check).
- **An internal reported to change on a newer Claude Code is marked.** `session-append-notice-rewrite` is degraded from 2.1.300 (#8: the `@room` receipt keeps its "Operation stopped by hook:" frame there); the probe prints it and `doctor`'s Claude Code check names it on that version, since its strings may still be found. `docs/internals/cc-2.1.300.md` says what was reported; the fix is #8's.
- **A room wake's row shows that your Claude was told something.** The "(for Claude)" lines of a wake (its head, the room's state) were hidden from you; each run of them is now one dim line in its place, cut to one line (ctrl+o shows them whole). Your Claude reads the prompt as before.
- **Measured for the hub decision** (`docs/ARCHITECTURE.md` Performance): idle, a seat costs about 1.0–1.3 % of a core at 1 to 5 seats (tail 0.2–0.3 %, the MCP server with its holds 0.2 %, the status line's fresh node every 5 s 0.6–0.8 %). The host tail runs one `ps` per local seat every 30 s.
- **Inside:** `lib/cc.ts` (1,000 lines) is `lib/cc/`: `contract.json` (every internal as data: search strings, shapes, `contains` groups, the first and last version it was checked on, a version it was reported to change on, the note), `contract.ts` (the JSON typed, the probe's matcher, `locateBinary`, `degradedOn`), `env.ts` (the session's env, config, plans and task paths, settings, the hook matcher rule; no JSON, so the hooks that read the session id load nothing more), `transcript.ts` (the JSONL readers) and `bg.ts` (`claude --bg` jobs, the daemon, the env allowlist, built from the contract's groups). `scripts/probe-cc.js` and `scripts/arch-doc.js` read the JSON; the generated contract table gains the versions each entry was checked on. No entry was removed: each keeps a use (`mcp-stdio-ppid` stays while the MCP server's parent-pid fallback does).

### Review fixes (stage 8b)
- **A room that may still be open is never collected.** GC took a room whose person's session crashed (no leave) for idle, and a hosted room's records of the machines linked to it did not protect it. It now requires the room closed for good and no link record either way, and sets the room aside first (see Log segments above).
- **The task gate fails closed on any exit but 0 or 2.** A crash, or a handler that failed to load, let the completion through; `hooks/run.ts` now loads the handler inside its capture.
- **The join card's check is the joining machine's, not the line's.** It showed a ref derived from the SECRET, so someone holding the same line and PIN saw the same one. The card and the joiner's screen now show `check 3f9c-2a71`, from the machine key that typed the PIN (and over the web the link's own key); a second machine presenting a used invite is a room line naming both checks.
- **An invite line's machine proof is good in one session only.** It signed the room and a timestamp, which a former host could replay for 10 minutes; it now signs a challenge the host hands out in the hello before.
- **The web listener closes a connection that makes no link within 10 s** (a Noise handshake anyone can make held a serve process), and holds at most 8 connections from one source.
- **A wrong PIN's room line carries no label** (the name it asked for only, which is checked), labels are cut to 24 characters, and `SUB_HUMAN_PIN_BACKOFF_MS` and `SUB_HUMAN_ADMIT_TTL_MS` are honoured only under the tests.
- **`SUB_HUMAN_SSH_OPTS` comes after the pinned options in `sub-human prime` too.**
- **Store:** a mirror that began from its host's snapshot keeps its anchor's hash after its own rotation (a subscribe at it after a handoff was `FORK`) and keeps the snapshot it began from (`snapshot-base.json`), so a lost `snapshot.json` is rebuilt with the host's earlier entries; a tailer more than four rotations behind reads on instead of starting over; proposals, the consent hook, the relay check and the tasks hook read the recent view.
- **Shorter lines for your Claude:** the note's and the review's five longest lines are under 160 characters with the same instructions, and one hook's text is capped at 600.
- **Idle:** the host tail runs no `ps` while idle (one call for every seat it does not know yet; a start time is kept while the pid lives), and the status line loads four fewer modules (about 8 % less CPU per refresh). Stage 9, the hub, is not built: `docs/ARCHITECTURE.md` Performance has the numbers and the reason.
- **Tests:** the perf test fails only on a relative bound (the 100k-entry room against a 1,000-entry one measured alongside); the absolute budgets warn, or fail under `SUB_HUMAN_PERF_STRICT=1`.

### Live verification fixes (stage 8c)
Four live runs of real Claude Code 2.1.296 sessions against this branch (local rooms, remote rooms, compatibility with 0.5.0-beta.15, hardening) found the bugs below. **Regression** marks one this release's earlier stages brought; the rest behaved the same way in 0.5.0-beta.15.
- **A kick ends every connection of the link.** A pipe or web `serve` names no `--link` in its argv, so the kick's `pkill` never reached it: the kicked machine kept posting, took its seat back, and its doctor gave the wrong advice. Every op of a connection now reads its link's record again and the subscribe stream ends `AUTH` the moment the record goes (any process's kick); a hello with a revoked token is `LINK_REVOKED`. A join binds the seat before it enters (a raced join left a seat with no link that kept the room from ever closing), and a remote seat no link names leaves at the sweep. The kicked machine's daemon stops with the host's words and drops the token, so a new invite line for the room replaces the link and `link CODE --forget` needs no `--force`; doctor no longer dials a link the host ended ("reachable, speaking v3").
- **The Bash guard places words.** `grep -rl PRIVATE` above the home, `cat` through `h*e` or `hom?`, `cd` then a relative glob, `find … -exec cat` and `rg -uu` all printed a seat key. Each word is now placed as the shell would (`~`, `$HOME`, braces, the working directory, the last `cd`) and glob segments are matched against the protected paths; a walker (`grep -r`, `rg`, `find`, `tar`, `xargs`, an interpreter's code) pointed above the home is denied. `sessions/` (the module's lease with the session nonce) joins the secret directories, and Claude Code's `history.jsonl` and this session's transcript are denied to Read, Grep and Bash. The README now says what this lexical guard does not stop.
- **An invite's line and PIN are pinned under the prompt, not saved.** A `sub-human:` notice is a transcript row a model could grep (live: it printed the PIN). Through the hooks module the line and PIN go to the plugin's status line until the invite expires.
- **An invite with no try left takes no PIN**, whether or not it was marked burnt.
- **Regression (stage 7):** a quota's "try again in" was always the whole window; it is now when the oldest counted post leaves it.
- **A proposer who is also an approver gets the review.** "No room review now: you asked to propose" held after the propose tool had made the proposal, which left a bare plan view of `proposal HASH` whose Yes recorded nothing, and plan mode on. With plan mode entered by hand, an ExitPlanMode whose plan is a proposal's name now opens its review there (or is denied with the card), never a bare view, and a Post whose plan is only a name says nothing was recorded.
- **Wakes are drawn as room prompts.** Claude Code passes a plugin prompt that fits its speaker label as expanded, so stage 8's dim render never applied: the frame and every `(for Claude)` line showed raw. The frame is left out, and an expanded wake shows every line with the markers dim.
- **No tail child in a session that never joins**, also when Claude Code's SessionStart runs before the module's hello; `/sub-human leave` stops it, and the title drops the address.
- **The room's Claude refuses typed slash commands**, `/clear` included (`command.run`).
- **The resume rewake says the rows are not running** (the resumed conversation still lists the old ones as running, and the model believed it).
- **A note left in the review says "nothing is recorded yet"** until its Send or Discard.
- **`@claude`'s receipt is "the room's Claude was woken"**: it answers only when it has something to say.
- **Presence goes back to idle at the end of a typed turn**; an `idle_prompt` notification may never come.
- **What asks people is a notice.** The log waiting to split (restart the old sessions), a decision on a proposal you are in and another approver's objection now show to the person; they reached only the model.
- **Refusals of your own words are stops, not blocks**: no "UserPromptSubmit operation blocked by hook:" frame, and the prompt is not put back in the input, where refusals piled up and a later Enter sent them all.
- **A paste that starts with `@room` posts.** It arrived wrapped and went to the model as a plain prompt.
- **A person's `(for Claude)` reads as quoted** in chat lines, wakes and `read`.
- **Doctor checks every hosted room's log** (the hash chain, every person's line against the pinned keys; it said "0 failed" after a forged line), and `sub-human verify CODE` checks one; doctor names another home's enrollment door lines and `--fix` leaves them.
- **Regression (stage 3):** the join's answer and the seatless tail said the same line twice; the tail's copy of a refusal lacked its `✗`. A let-in machine's link no longer stops `NO_SEAT` a minute later while its person has not typed `/sub-human`.
- **Wording:** a peer of no named version is "an older sub-human (protocol 1–2)" (**regression, stage 7**: "an unknown sub-human version"); a line without its SECRET says an old host's ends with a PIN; `/sub-human --as 4829` says it looks like a PIN; `claude [starting]`; `who --room`; a leave's `prompt_input_exit` is written "session ended"; "5 PIN tries left"; the invite names the plugin's own version; `sub-human tasks` uses the rows' words (open, in progress, done); the log-split line names no version.
- **A `--plugin-dir` checkout newer than the one the serve shim points at takes the pointer** (never an installed plugin's); doctor names both versions and the fix.

### Live verification fixes, round two (stage 8d)
A second live round of real Claude Code 2.1.296 sessions (local rooms; remote rooms, guards and doctor) found the bugs below. **Regression of 8c** marks a fix stage 8c claimed that did not hold live (items I, O, M and D).
- **1. The agent view keeps your seat.** **←** backgrounds the session as a fork (a new session id, SessionStart source `fork`) and Claude Code records `continued-in` in the old transcript; the module ran no restore for `fork`, so the seat stayed with the old id, the rows ended and a bare `/sub-human` opened a second room. session-restore now moves the seat the record names to the fork (no leave, no log line; rows listed again), a bare `/sub-human` there does the same, and a bare `/sub-human` never opens a second room while the default name's seat is live in another session of the same folder. CONTRACT `session-fork-continued-in`. The README says what the agent view does and how to get back. Not fixed: the bg daemon drops a shell's `SUB_HUMAN_HOME` from the fork (the README says to set it in settings `env`).
- **2 (D). Regression of 8c: the invite's PIN is readable.** The status line is `PIN 4090 · <line>` (no until-time); a terminal too narrow for it (the module knows the width from `command.run`) pins `PIN 4090 · SECRET <word>` and the notices give the line with `SECRET` in its place. A used, burnt or cancelled invite leaves the status line (the tail's `invites` event; a cancel at once).
- **3 (M). Regression of 8c: an objection note is not posted before Send.** A plan view refused with a note fires no PostToolUse; the module's `tool.call` now hands the refusal to consent at once, so the note opens, the model reads that nothing is recorded in the refusal itself, the person gets a notice, and room posts are refused while the note waits for its card.
- **4 (O). Regression of 8c: presence does not stick.** "working" is written when a typed prompt's turn starts (a prompt the plugin stops or refuses starts none); a tool call answered after a permission notification writes "working" again, and a turn that waited on the person ends "idle".
- **5 (I). Regression of 8c: wakes no longer show their frame.** A plugin cannot redraw its own prompt: Claude Code raises its render with the plugin itself as the origin and skips every hook of it (re-entry); the stage 8c test mounted the row without that origin, so it passed. A member's wake is now submitted `asUser` with its lines for the person alone (no "The sub-human plugin sent a message" frame, no Claude Code tail, no `(for Claude)` lines on screen); those lines ride as context the model reads. Claude Code's own "Prompt from the sub-human plugin" label stays, and the lines are drawn in the prompt's color (no hook can dim them). CONTRACT `render-own-prompt-reentry`.
- **6. The room's Claude knows it is no member's Claude**, and its row call says each participant row shows a person; its SendMessage is drawn "the room's Claude: …".
- **7 (H). A hand-set mode is kept.** A shell-only `hooks.json` PreToolUse notes the mode `EnterPlanMode` is called in (the module's event carries none, its last-seen mode is stale after a shift+tab); plan mode set by hand comes back after a Yes.
- **8. A Yes as the review opens is asked again.** Within 2 s of the view opening, or with typed text in the prompt as it opened, a Yes records nothing; the question card asks once and only its answer records.
- **9 (R1). `link CODE --forget` leaves no ghost room.** It ends this machine's seats there; a store refuses writes into a room this machine no longer has; a leftover folder with no log and no link is no room (doctor warns, `--forget` sets it aside).
- **10 (R2). A refused `/sub-human NAME CODE` changes nothing**: the seat held now is left only once the new one is taken.
- **11 (R4). The same name from a new machine is a path**: the host's card offers "Let in as NAME2" when the name sits in the room from another machine, and the joiner's hello learns the bound name.
- **12 (J).** `/sub-human leave` renames the session at once (its address goes with the seat); the log says "NAME left".
- **13 (K/Q).** A prompt typed into the room's Claude is a stop with the hint: no "blocked by hook" frame, nothing put back in the input.
- **14 (R5).** The Bash guard decodes ANSI-C quoting (`$'\x68'`) before placing a word, and denies one it cannot read.
- **15.** After a kick the joiner's row reads "✕ removed by the host" with no stale count and its rows keep holding (no model turn spent); a seated session hears the host's let-in of its new join; a login join to a host ssh cannot resolve stops on its first connection with ssh's words.
- **16.** The reaper makes sure the room's Claude process is gone before `stopped_at`; the web listener exits once the last room it served closed.
- **17. Wording:** `/sub-human --as 4829` is "no name"; a proposal title drops "1. "; the README's invite line says "VERSION or newer" as the runtime does.

### Verifier fixes (stage 8e)
An independent verifier's live runs of stage 8d (real Claude Code 2.1.296 sessions: local rooms, remote rooms, guards) found the bugs below. **Regression of 8d** marks one stage 8d brought (items A and C).
- **A. Regression of 8d: the Bash guard denied ordinary commands.** Its ANSI-C decoder (8d item 14) took any `$'` for a quote, so `grep -n 'foo$' README.md`, `grep -cE '^[0-9]+$' /etc/hosts` and `printf '%s\n' 'a$'` were denied, in rooms and out. A `$'` now counts only where the shell reads one: unquoted, or inside `$(…)` or backticks within double quotes; never inside `'…'`, `"…"`, after a backslash or as the second `$` of `$$`. Real ANSI-C paths stay denied; twenty everyday lines with `$` are must-allow tests.
- **B. The person's own prompt read as room content.** The room context (the pull lane) was a user row of its own; with an `@room` and its stop row it read as one user turn with the person's next prompt, whose last line the model took for an unattributed room line. The module now holds the room context in `$.state` and carries it as context beside the next prompt that starts a turn (a stopped `@room` keeps it held), headed "sub-human room context" and ending "end of room context; the person's own words are their prompt."; the stop's model row now reads "sub-human: the person's @room line above went to the room, not to you (RECEIPT); nothing is asked of you."
- **C. Regression of 8d: a bad join tore down a live link.** `/sub-human join nosuchhost.invalid ROOM` in another session stopped the live link and rewrote its file to the bad host. A join another way for a room this machine is linked to live is refused ("already linked to ROOM through HOST; … `link ROOM --forget` first"), and one that replaced a link that was down and was refused puts the old link file back.
- **D. A room post went through while a note waited.** The module skipped consent for the post tool on a cached "no note" flag; the post tool now always reaches consent where a seat is, and the room server refuses a post itself while a live note waits. A note whose card went by again tells the person once what Send and Discard do, and keeps waiting.
- **E. An agent-view fork with a shell-only `SUB_HUMAN_HOME` opened a second room in the default folder.** session-restore reads the transcript the fork continued: when its last title is a seat's address and this folder has no record of the seat, the person is told why (and how to get back) and a bare `/sub-human` there opens no room. CONTRACT `transcript-custom-title`. The home itself cannot be carried into the fork (the bg daemon drops it); the README keeps the settings `env` advice.
- **F.** A proposal titled "# 1. Add X" is "Add X" (every leading marker goes).
- **G. The host's let-in wake showed the old frame.** It was all `(for Claude)` lines (the person's line a separate notice), so it was submitted framed; it is now one wake whose first line is the person's, submitted asUser like every member wake. The handoff ask too.
- **H.** The plan view's hint names only a Yes the dialog offers: the one that keeps default or auto mode, else any Yes (the mode comes back); "Yes, and auto-accept edits" was not offered.
- **I.1** A room closed for good leaves `open-rooms.json` at once (the reaper, a leave, a joiner's link told the room closed). **I.2** A room row's hand-back ("left" after a leave) and its "finished" notification start no model turn (dropped: Claude Code draws "Prompt dropped by a hook: sub-human: a room row ended (no turn for it)"); CONTRACT `subagent-handback-message`. **I.3** "✉ N for you" goes once the viewer or their Claude answers. **I.4** A prompt at-room stops runs no consent step, so a review left by Esc is not moved on unseen and plan mode comes back. **I.5** Not ours: "settings.json to update hooks" under the plan view's hint is Claude Code's own line naming where a hook is configured. **I.6** A plan file that held only a stub ("proposal HASH") is backed up as nothing, so the closing ExitPlanMode shows no older hash. **I.7** After a leave the panel still labels the rows ("you left · /sub-human joins again"), never the row agent's own activity. **I.8** A task its requester asked for themselves is theirs in its add entry. **I.9** The joiner's line while the host's card waits names no seat (the card may pick NAME2). **I.10** A leftover folder is judged by when it was made, not its last write; the store's locks refuse a room this machine does not have. **I.11** `/sub-human leave` stops the session's tail at once. **I.12** The perf test's fresh-process samples alternate between the small and the big room (best of five each).

### Polish (stage 8f)
An independent verifier's remaining findings on stage 8e (real Claude Code 2.1.296 sessions: local rooms, remote rooms, guards).
- **1. A fork after `/sub-human leave` knows its folder.** Stage 8e's check read the continued transcript's last title, which a leave renames to the plain name, so a bare `/sub-human` in the fork (no `SUB_HUMAN_HOME`) opened a room in `~/.sub-human`. Every hello that names a seat now appends "sub-human: home FOLDER" to the session's transcript, once per session and folder (a `$.session.append` system row, drawn only in the ctrl+o view; CONTRACT `transcript-home-notice`); a fork whose continued transcript last names another folder is told so and recorded, and `/sub-human` there opens no room and joins none this folder lacks (`/sub-human NAME ROOM` said "no room ROOM on this machine … open a new room"). The way back names what works: `claude stop SHORT`, then `SUB_HUMAN_HOME=FOLDER claude --resume SID` (`--resume` refuses a session running in the background). A row's hand-back whose report is a row's last word (`left`, `error`) is taken even when this process never saw the row spawned, so a fork's old row no longer has the model say "type /sub-human again". The fork does not adopt the folder for itself: its room server, status line and Bash commands all find the store by `SUB_HUMAN_HOME`, which the bg job dropped.
- **2. A re-invite's let-in is said.** The tail said each join news once per state and text and never forgot the first join's, so after a kick, a new line, its PIN and the host's Let in, "the host let you in" (word for word the first one) was never said; once no join waits, the next join's news is new. Until the new daemon wrote its own state, the kicked link's stop also read as the new line's refusal ("✗ could not join room …: the host removed this machine"); a stop older than the line is not its answer.
- **3. `link CODE --forget` stops a running daemon itself** and forgets the room in the same step (it died while the daemon ran and then wanted `--force`): the advice a join another way gives now works as written.
- **4. Wording.** The room context ends "the prompt it came with is the person's own words, unless the sub-human plugin sent it (then it is room lines)", right beside a wake too; an `@claude` line's stop row tells the model "the person's @claude line"; the handoff ask and `sub-human admit`'s list give local times, as the invite does; a row's end is dropped as "sub-human: row ended, nothing to do", and its hand-back and finished notification are taken quietly where `session.receive` sees them (live: one drop line per leave, not two); the room's Claude's answer to your own `@claude` is no "✉ 1 for you".
- **5. Guard.** `$'…'` inside `"${…}"` is decoded (bash does), `$"…"` reads as the double-quoted string it is, `${NAME:-word}` is also read as its word, a `case` pattern's `)` inside `"$(…)"` no longer closes it, and a quoted heredoc's body is literal (a lone `$'` in a commit message is allowed); an unquoted heredoc's body still decodes inside its `$(…)`.
- **6.** A resume's rewake is submitted asUser for a member even before the tail child named the seat (one of two `--continue` resumes drew the framed prompt with its "(for Claude)" lines and Claude Code's tail).
- **7. "did not finish here" explains itself, and a leave is not lost to it.** One `/sub-human leave` after two `--continue` resumes said only "✗ /sub-human did not finish here" and did nothing; a retry worked at once. A shim timeout cannot draw that line (a run past its time rejects, and the hook then fell through to the classic hook, which would have run the command a second time); a run that came back unreadable can: a crash, or a join whose session lease had lost the module's nonce, which node answered as a classic block (no reply the module reads) and which the refresh after it rewrote, so the retry worked. Now: the refusal says how long the run took and the last line it wrote on stderr ("did not finish here (after 10.0 s: …)", a PIN- or SECRET-shaped word masked), and `<home>/module.log` keeps the last 50; a rejected run is that refusal too, never a second run; a lease that does not hold the nonce runs nothing and says so (`{subHuman: {lease: "stale"}}`), and the module says hello (which rewrites the lease) and runs the command once more; after a run that did not answer, the module looks again, and a seat that is gone (a leave that finished after the wait) is said, the session titled with the name and its tail stopped, never a stale seat on show. A leave also asks `ps` once for every seat's start time (it was once per seat plus once for the lease, each up to 2 s on a loaded machine), and a lease written in the last 2 minutes needs no `ps` at all.
- **8. `link CODE --forget` on a live link tells the host first.** The host heard "carol left (connection lost)" about two minutes after a forget. Before it stops the daemon, `--forget` now sends each seat of this machine's leave over the link (3 s in all; a link that is not online is not tried, and the line says the host sees the seat lapse), so the host logs "carol left" at once. The link's log and state files (`links/CODE.log`, `CODE.state.json`) move into the archive with the copy (`link.log`, `link.state.json`; deleted when there is no copy), so nothing of the link stays in `links/`. Every printed shell line (`node …/scripts/sub-human …`, the guard's doctor line) starts `SUB_HUMAN_HOME=<folder>` when the folder is not `~/.sub-human`, so the "already linked" refusal's `link CODE --forget` acts on the right folder.

### Tests
- **The plugin's node tests are TypeScript** (`plugin/sub-human/test/**/*.node-test.ts`, checked by `npm run typecheck` through `tsconfig.test.json`), named so `claude plugin test` never collects them; new cases for unreadable hook stdin, the join's time budget, a mirror's first sync of a large log and of a host log with a corrupt line, a forged line in MCP `read`, and a model-supplied `planFilePath`.

### TypeScript
- **Stricter compiler flags**: `noImplicitOverride`, `noFallthroughCasesInSwitch`, `isolatedModules`, `noImplicitReturns` and `noUnusedParameters` (45 unused parameters take a `_` prefix; two implicit returns return explicitly). No behaviour change.
- **One project for the whole plugin**: the root `tsconfig.json` now holds the runtime, its node tests, the hooks module's wiring tests (`mod/test`, unchecked until now) and the two plain JavaScript files; `tsconfig.runtime.json` checks the runtime alone. `tsconfig.test.json` goes.
- **`mod/test` is typechecked**, strict with no relaxation: `support.ts` is typed against `claude-code` and `claude-code/testing`, and the render test's engine row returns an element.
- **The plugin's JavaScript is typechecked**: `hooks/compile-cache.js` and `lib/cache-dir.js` stay plain JS with `// @ts-check` and JSDoc; `scripts/typecheck-shim.js` checks the extensionless `scripts/sub-human` through a temporary copy.
- **`npm run lint`**: oxlint 1.88.0 with type-aware rules (oxlint-tsgolint 7.0.2004, pinned dev dependencies; `.oxlintrc.json`, all warnings for now), then the ratchet. CI runs it once and no longer runs the typecheck twice.
- **The type-escape ratchet**: `scripts/ts-ratchet.json` holds the explicit `any`, `as` casts and non-null `!` per directory (`scripts/ts-ratchet.js` counts them); `npm run lint` fails when a count rises, and `--update` writes lower ones.
- **The lab's `15-short.js` parses again** (an unescaped quote the linter's parser found).
- **Data from outside is `unknown` until a decoder accepts it** (stage T1). `lib/decode.ts` is a zero-dependency set of decoders (`str`, `int`, `lit`, `arr`, `obj`, `opt`, `union`, `refine`, `objAs`, and the `Result` type). `readJson(file, decoder, fallback)` replaces the untyped `readJson(file, fallback)`, and `readInput()` returns `unknown`. Every runtime `JSON.parse` goes through a decoder or an explicit guard. The decoders accept every record an older version wrote: unknown keys are kept, and a field is required only where every reader needed it.
- **Typed hook stdin**: `hooks/run.ts` loads each handler from a table checked as a `Handler` of its own input, so the `as never` casts are gone. A base field (`session_id`, `cwd`, `hook_event_name` and the rest) that is not a string is dropped before dispatch.
- **The wire**: a request's params are `unknown` until its op checks them (`WireParams`), the op table is typed per op (the `as unknown as` cast is gone), and `isEvent` accepts only an event this end knows. The bridge is typed per method (`Bridge<A>`), and the mirror's relay calls take a `RelayOp`; `type Reply = any` is gone.
- **`lib/env.ts`**: one typed table of every `SUB_HUMAN_*` knob, with its kind and default. `envMs`, `testMs`, `envNum`, `envFlag` and `envStr` take a name from the table, and `TIMING_ENV_RE` is derived from it. Nothing else reads `process.env.SUB_HUMAN_*`, except the hooks' entry and the compile-cache preload (`test/env.node-test.ts` checks this).
- **The repo scripts are ESM TypeScript** (`scripts/`: the demo tools, the checks, the lab, the probe, the lint, the docs generator and their tests), strict, typechecked by `npm run typecheck` through `scripts/tsconfig.json` and linted type-aware; named exports, `.ts` specifiers, run by node's type stripping. `scripts/lib/paths.ts` loads plugin modules typed (`PluginLibs`, `PluginTests`, `PluginFiles`). `npm run test:scripts` globs `scripts/test/**/*.test.ts` (`scripts/test/index.js` goes). Every caller says `.ts`: `package.json`, `demo.sh`, CI, the lab's compose files. `demo/app.pristine/` stays JavaScript.
- **Errors** (stage T2). `lib/errors.ts` reads what a catch caught (`msgOf`, `stackOf`, `errCode`, `isErrno`, `isCoded`) and holds the one `Result`; the five copies of `errCode`/`msgOf` and the catch-variable casts (`as Error`, `as NodeJS.ErrnoException`, `as CodedError`) go. `RoomError.code` is a `WireCode` (`protocol.ts` `CODE_NAMES` is its source), and `CodedError` is `RoomError | NoiseError` with an `isCoded` guard. `lib/reasons.ts` `REASON_CODE` pairs each reason with its code, replacing the list in its header; the link socket's `notListening` flag is a `NotListening` error. A code this end does not know, from a peer or the bridge, now reads as `INVALID`, as this end's server and link socket already sent one; no code on the wire changes. A hook's `capture` reports `threw`, so nothing that is not an Error is thrown by name.
- **`npm run typings`** copies the declarations Claude Code writes beside the hooks module (`claude-code`, `claude-code-tools` and now `claude-code-mcp`) into `typings/`; the snapshot is refreshed to 2.1.296. `npm run probe` fails while the snapshot's "Written by Claude Code X" is not `contract.json` `probed`.

## 0.5.0-beta.15 (2026-10-14), private beta

Tested on Claude Code 2.1.296 with Node 24, on macOS.

### Fixes
- **A review's note is not lost.** A hook that ran before Claude Code wrote the plan dialog's rejection line settled the review as closed without answering, so a "Tell Claude what to change" note never reached its confirm card and was relayed as a plain say. A review now settles only from that line: the closing ExitPlanMode waits for it, and the Post reads it last.
- **A bare `/sub-human` while seated restarts the room's Claude.** The notice's "/sub-human in the room starts it again" now holds for a seat already in the room, not only a new join; nothing starts while a job is live or starting.
- **Leave notices say why.** The room row (panel and statusline) and the room hold's progress line carry the chat line's reason, for example "−bob left (session ended)".

### Internals
- The hooks module's deliver tests cover both append paths of the Claude Code 2.1.296 test kit, and the store seam test allows the module's members read.

## 0.5.0-beta.14 (2026-10-14), private beta

Tested on Claude Code 2.1.296 with Node 24, on macOS.

### Fixes
- **An interrupted objection card comes back once.** A confirm card closed with Esc left the note waiting unseen. The next prompt now asks the model to show the card again, once, and says that an Esc is an interruption, not a decline. If the model still does not show it, the Stop nudges once more. The tail's reminder uses the same words, so a prompt never carries both a firm and a soft line. (#6)
- **No objection posted twice.** The room server refuses a post that repeats a person's objection note while it waits for their Send, or after they sent it in the last 10 minutes. (#6)
- **The show command by its full path.** No `sub-human` is on a session's PATH, so propose's reply names `<plugin root>/scripts/sub-human show HASH`. The README says the same. (#6)
- **A replaced proposal opens its latest revision and says so.** Naming a superseded hash opens the newest revision with "proposal OLD was replaced by NEW; opening NEW".
- **A leave keeps its reason in the chat line**, for example "connection lost", "session ended" or "removed by the host".
- **The in-session doctor `--fix`/`--bundle` denial gives its own reason** and names the terminal command by the shim's path.
- **A room Claude that ended without taking its seat is stopped**, and so is any stray `claude.CODE` job, so two room Claudes no longer run at once. Doctor says what a never-bound job is doing instead of saying it was refused. (#1)
- **Doctor's fix for a seatless link covers a room closed since.** It names `link CODE --forget`, and `link CODE --forget` on an unknown code says "no room CODE on this machine". (#5)
- **Login-link seats count with the room owner's seat.** A seat joined over the host account's own ssh login counts as one approver with the seat of the person who opened the room, even when other people have seats on the host. (#6)

## 0.5.0-beta.13 (2026-10-14), private beta

Tested on Claude Code 2.1.296 with Node 24, on macOS.

### Fixes
- **The link stays up while a session is alive.** A seat whose Claude Code process is still running keeps its link through a sleep or pause longer than the seat lease; the link daemon no longer stops itself, and suspended time never counts as idle. (#7)
- **Doctor flags a stale bg daemon.** `sub-human doctor` (also `--quick`) fails when the bg daemon runs a Claude Code binary an upgrade deleted, and warns when it runs a version other than `claude --version`; the fix line is `claude daemon stop --any --keep-workers`, which `--fix` never runs. (#5)
- **`sub-human link CODE --forget`.** Drops a closed room's link for good, by hand: refused for a room hosted here or while the daemon runs, and unless the link stopped because the room closed or no seat is left (`--force` for any other reason). The room folder is set aside as `rooms/CODE.forgotten-TIME`, and doctor's closed-room fix names both ways out. (#5)
- **One person in two seats counts once.** Seats of the same account (a host seat and one over a login link) count as one approver: the newest answer from either seat stands for both, and decisions name one seat per person ("agreed: tristan (also laptop)"). Two seats on the host stay two people. (#6)
- **A clearer @room receipt.** The receipt reads as a delivery under Claude Code's "Operation stopped by hook" frame: "✓ sent to room CODE (Claude wasn't asked)" for @room, "✓ sent; the room's Claude will answer" for @claude. (#6)

### Internals
- The cc CONTRACT is checked against Claude Code 2.1.296 (daemon env allowlist, providerEnv filter, harbor-kite gate, userFeedback shape), with new `daemon-status` and `daemon-upgrade-exit` entries; the delta is in `docs/internals/cc-2.1.296.md`. (#5)

## 0.5.0-beta.12 (2026-10-14), private beta

Tested on Claude Code 2.1.296 with Node 24, on macOS.

### Fixes
- **The room says when its Claude fails to start.** A spawn error, or a job that never binds its seat, is a room line, and `sub-human doctor` shows the job's state. (#1)
- **Left (connection lost) and rejoined.** A seat that ends with no leave (its process gone, its lease run out) is logged as left with "connection lost", shown as away, and its return as rejoined. (#2)
- **Revised proposals replace older ones.** A new proposal from the same person with the same title retires the earlier undecided one, so it is no longer pending (and `sub-human digest` no longer lists it as waiting). A review opens the newest pending proposal, and the reminder about held rows appears once per change rather than on every prompt. (#3)
- **The plan file is kept.** A room review no longer deletes the plan file a proposal was made from, and approving your own pending proposal in plan mode records your sign-off. (#4)
- **Doctor's probe guard and quiet stale links.** `sub-human doctor` says when the internals probe could not run (a launcher binary, a version mismatch) instead of reporting every internal missing, and a dormant link is info, not a warning. (#5)
- **Papercuts.** A session reads a proposal with `sub-human show HASH`, and the guard's wording points there; the SSH-login room line reads "a machine linked over your SSH login", with no link id; `doctor --bundle` creates the bundle's folder. (#6)

## 0.5.0-beta.11 (2026-10-12), private beta

Tested on Claude Code 2.1.296 with Node 24.19, on Linux: three seats, two of them on one machine and the third on a second home with its own Claude Code config folder, over the pipe link.

### Fixes
- **Claude-to-Claude messages reach other machines.** Native `SendMessage` only reaches sessions in the same Claude Code config folder, so `SendMessage alice.vole-8126` from another machine failed with "No agent named … is reachable" (and the sender's Claude guessed alice hadn't joined). The hooks module now catches a send to a member whose seat is on another machine and posts it to the room addressed to them (`bob's Claude (to alice): …`), which wakes their Claude as before; same-machine sends stay native. `ListAgents` still lists only this machine's Claudes, and the join text says so.
- **A Claude's post to you says how to answer it.** The wake for a post addressed to you ends with `(for Claude) to answer bob's Claude: SendMessage bob.vole-8126`, so the reply goes back to that Claude instead of to the whole room (where it did not wake anyone).

### Internals
- New `session.send` module hook (`mod/send.ts`, pure part `mod/core/send.ts`): reads the room's `members.json` and the home's `machine.json`, and posts through the room server with `$.mcp.call`.

## 0.5.0-beta.10 (2026-10-11), private beta

Tested on Claude Code 2.1.292 with Node 24, on macOS.

### Changed
- **Invite with an ssh alias.** `/sub-human invite --ssh devbox` (or `SUB_HUMAN_SSH_ADDR=devbox`) shows `/sub-human join devbox ROOM PIN`: the joiner's own ssh config resolves the alias, as it already did for a join over your own login. Your account name stays off the line.
- **A machine's name on the card.** The host's card names the joining machine by its short host name, or by `SUB_HUMAN_MACHINE_LABEL` when that is set there (still only what that machine says).
- `SUB_HUMAN_SSH_OPTS` also reaches the `ssh -G` that reads a bare alias's user, so a `-F FILE` there is the one config both use.

### Internals
- The trailer's take (`scripts/demo.sh --film`) joins jess from a second home over a real ssh link to a private sshd (`scripts/devbox.sh`: as you, loopback only, its own host key and authorized_keys, never `~/.ssh`).

## 0.5.0-beta.9 (2026-10-11), private beta

Tested on Claude Code 2.1.292 with Node 24, on macOS.

### Changed
- **A clean `@room` receipt.** After `@room …` or `@claude …` your terminal shows `⏺ ✓ sent` under your line, not `Operation stopped by hook: ✓ sent`, after `--resume` too. Nothing else changes: the hook still posts your exact words, your Claude gets no turn, and refusals read as before.

### Internals
- The module rewrites that one warning row in `session.append`. New CONTRACT entries `ups-stop-frame`, `session-append-notice-rewrite` (`docs/internals/cc-2.1.292.md`, "The @room receipt").

## 0.5.0-beta.8 (2026-10-10), private beta

Tested on Claude Code 2.1.292 with Node 24.3.0, 24 and 26, on macOS (Linux in CI). The TypeScript migration (`docs/archive/TYPESCRIPT.md`).

### Changed
- **The plugin is TypeScript.** Node runs the `.ts` files directly: no build step and still no runtime dependencies. It needs Node 24.3 or newer; on an older Node `/sub-human` says so.

### Fixes
- A refusal from the hold tool is marked as an error (`isError`).
- A join or resume no longer crashes when `machine.json` can't be read.
- A log lock timeout keeps its message.

### Internals
- Strict `tsc` runs in `npm test` and CI. A compile cache keeps hook start-up within about 5 ms of before (the prompt hook: 36 → 41 ms median).

## 0.5.0-beta.7 (2026-10-10), private beta

Tested on Claude Code 2.1.292 with Node 24, on macOS. The message pass (`docs/next/COMMANDS-REVIEW.md`, "Messages: 5 rules").

### Changed
- **No more "blocked by hook".** The hooks module answers `/sub-human` itself (`command.run`): every reply (help, who is here, `leave`, an invite, a refusal) shows as dim `sub-human: …` lines that never reach your Claude, so it neither repeats them nor sees a PIN, and a command that only replies leaves no row of the prompt. Through Remote Control, where those lines don't show, a reply with no secret is the command's own output. A join that worked expands as before and shows one line: `joined vole-8126 as dana, with tristan · @room to talk, @claude to ask the room's Claude` (`opened room …` for a new room, `left vole-8126 · /sub-human joins again` after `leave`). Without the module (and in the room's Claude, the SDK, or a PIN typed through Remote Control) the classic hook answers as before.
- **One next step you can type.** Every refusal starts with `✗` and ends with a `/sub-human …` command, an `ssh` line, or `/sub-human doctor`; a step only a shell can take prints the CLI by its path (`node <plugin root>/scripts/sub-human prime vole-8126`), never a bare `sub-human` (it is not on PATH). Usage lines show one form and `/sub-human help`.
- **Plain words.** No link ids, epochs, seats, shims, BatchMode, mirrors or refs in what people read: "connection", "sub-human folder", "the invite". The room's own lines lost their link and invite ids.
- **No more dead ends.** The delivery-error notice says `a room message didn't arrive here. Run /sub-human doctor.`; the no-module refusal names the cause it can see (an old Claude Code, the hooks-modules switch off) or points to `/sub-human doctor`, which (with `help`) now runs without the module and checks `allowManagedHooksOnly` and that switch; ssh login failures, the wrong PIN, a handoff and an out-of-step copy say what to do; the skill's fallback no longer says "check the message above".
- **No doubled `sub-human: sub-human:`** in notices from the prompt and turn-end hooks.
- A bare `/sub-human` in a room hosted elsewhere starts its connection again when it had stopped running.

### Internals
- New CONTRACT entries `command-run-every-command`, `command-run-empty-answer`, `expansion-block-frame`, `modules-switch-cache` (`docs/internals/cc-2.1.292.md`, "Command replies").

## 0.5.0-beta.6 (2026-10-10), private beta

Tested on Claude Code 2.1.292–2.1.296 with Node 24 and 26, on macOS and Linux. The commands, simplified (`docs/next/COMMANDS-REVIEW.md`):

```
/sub-human                       join or open a room as your git name; in a room: who is here, how to invite
/sub-human NAME [ROOM]           as before, with a name you type
/sub-human invite                a line for another machine: /sub-human join dev vole-8126 4829
/sub-human join HOST ROOM [PIN]  with a PIN: the invite's line (the host's card lets you in, then /sub-human
                                 takes your seat); without: over your own ssh login, in one step
/sub-human join URL PIN          the same over the web
/sub-human admit [REF]  kick NAME  leave  handoff NAME  doctor  help
```

### Breaking changes
- **Renamed.** `/sub-human host` is `/sub-human invite` (ssh by default; `--web` for Tailscale Serve, `--public` for Funnel, `--url U`, `--pipe` for a second home here). `unhost` is `invite --stop`. `revoke NAME` is `kick NAME`; a leaked unused invite is `invite --cancel [REF]`. The CLI follows: `sub-human invite …`, `sub-human kick NAME`.
- **Invite lines carry no name.** `/sub-human join dev vole-8126 4829`, `/sub-human join https://…/sub-human/vole-8126 4829`. The joiner's name is their git `user.name` (first word, lowercased), else their git email's local part, else `$USER`; `--as NAME` sets another. A taken default name is refused with `pick one: /sub-human NAME`.
- **The PIN is 4 digits** (was a 6-digit code). Still 5 tries, 15 minutes, burnt on the last wrong one, at most 4 open per room: 5 guesses in 10,000 per invite, 20 in 10,000 with 4 open, and a right guess only reaches the host's card. "PIN" means the digits and "room" the `vole-8126` part everywhere.
- **Removed:** sh1 invites (`sub-human invite` in its old sense, `sub-human authorize`), sh2 invites and `--long` / `--short`, `join NAME sh2… PIN`, `URL#SECRET.KEY` joins, the pasted `/sub-human admit shk1…` flow (the card and `admit [REF]` stay), the `room:` tag (use `@room`), the old join form `join NAME DEST CODE PIN`. Hosts and joiners must both run 0.5.0-beta.6.
- **Reserved names:** every verb (`invite`, `join`, `kick`, `leave`, `doctor`, `help`, `admit`, `handoff`, `promote`, `demote`), so `/sub-human doctor` is never a person called doctor.
- **promote / demote:** promote prints one `sub-human demote CODE INVITE PIN` line per other machine; a member's machine runs it too (its link follows the new host, then `/sub-human` rejoins), not a `/sub-human join`.

### New
- `/sub-human leave` leaves the room without `/exit`; the session stays open.
- `/sub-human doctor` runs the read-only doctor in the session; `--fix` stays in a terminal, and now also rewrites this home's 0.2-era `authorized_keys` lines.
- `/sub-human help` lists every command; usage messages show the common form.
- A bare `/sub-human` after a PIN join takes the seat once the host's card has let you in; a re-pointed link (after a handoff) rejoins the same way.

### Security
- **Every `join`, `invite` and `admit` prompt, and any prompt with a word of digits, is answered hidden** (a block with suppressOriginalPrompt) before its form is sorted out. Before, a mistyped PIN (5 or 7 digits) or `--home` with an invite fell through to a plain block and could stay in the conversation.
- A join that carries a PIN never takes the seat in that step (the seat's context would reach the model with the prompt).
- The Bash guard knows the new CLI words (`invite`, `admit`, `kick`, …), allows a read-only `sub-human doctor` and denies `doctor --fix` / `--bundle` to a model.

## 0.5.0-beta.5 (2026-10-10), private beta

Tested on Claude Code 2.1.292–2.1.296 with Node 24 and 26, on macOS and Linux.

- `/sub-human join NAME dev CODE` takes a bare ssh config alias. The user comes from `ssh -G dev`, and the alias stays the host, so its HostName, Port, ProxyJump and keys apply. The same works for short invites (`… dev CODE 482913`).
- A `YOU@host` typed as is from the examples gets a clear message instead of an ssh refusal.
- With no `node` on PATH, `/sub-human` says so ("sub-human needs Node 24 or newer…") instead of "node: command not found".

## 0.5.0-beta.4 (2026-10-09), private beta

Tested on Claude Code 2.1.292 with Node 24 and 26, on macOS and Linux.

### Cleaner joins
- **Join with your SSH login.** If you can already `ssh you@machine-a`, one command joins: `/sub-human join NAME you@machine-a CODE [--via JUMP] [--home PATH]`. There is no invite, no PIN and no admit step. It uses your own ssh, with `BatchMode` and your usual known_hosts check. A locked-down key that sub-human added for one room cannot use this path.
- **Short invites.** `/sub-human host --ssh` prints `/sub-human join NAME you@machine-a CODE 482913`, and `host --tailscale` / `--url` prints `/sub-human join NAME https://…/sub-human/CODE 482913`.
  - The 6 digits are checked with a PAKE (CPace on ristretto255, vendored `@noble/curves` 2.4.0, hash-pinned). They are never sent, an attacker gets one guess per try, and 5 wrong tries or 15 minutes burn the invite.
  - The host's key is vouched for inside the PAKE and then pinned.
  - See `docs/short-invites.md` for the design.
- **An approval card instead of the pasted admit line.** The host sees "Let carol (SHA256:…) on carols-mbp join room CODE?" and chooses Let in or Refuse. For a headless host, use `sub-human admit [REF] [--refuse] [--yes]` in a shell.
- The old `sh2.…` invites and `URL#secret` links still work. Pass `--long` to print them.

### The room's AI is `claude`
- "orch" is gone. `@room …` posts your words to everyone. `@claude …` posts them and wakes the room's Claude. Only a tag at the start counts. Outside a room, `@claude` is a normal prompt.
- The room's Claude is member `claude`. Members' Claudes reach it at `claude.CODE`. Rooms and logs from 0.4 are read with the new name, and only the new name is written.
- An `@claude` sent on the host when the room's Claude isn't running starts it.

### Fixes
- After an upgrade or a quick restart, the room's Claude could be refused "name taken" until someone rejoined twice.
- An upgraded room's Claude resumes from where the 0.4 one stopped reading, so no `@claude` is skipped.
- Leaving a room hosted elsewhere while its link is down no longer prints a stack trace.
- `doctor --bundle` now redacts a `SUB_HUMAN_HOME` outside `$HOME`, pipe link paths, and 6-digit codes.
- `check-version` orders pre-releases correctly (`beta.10` after `beta.2`).

### Known limits
- No phone client (Remote Control) under Bedrock, Vertex or API keys.
- Typed join commands, including codes, stay in Claude Code's prompt history.
- An sshd that asks for more than a public key (a password or MFA) blocks short SSH invites. Use `--long`.
- Anyone who can reach the host and knows the room code can burn an open invite.
- macOS and Linux only. No relay for two laptops behind NAT yet.

## 0.4.5 and earlier

Remote rooms over SSH and the web (Tailscale Serve and Funnel, or your own HTTPS front), reconnect and outbox, planned handoff, `doctor`, and the Docker lab. See the git history.
