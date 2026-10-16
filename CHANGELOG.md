# Changelog

Each release names the Claude Code versions it was tested on. Marketplace installs update only when `version` in `plugin/sub-human/.claude-plugin/plugin.json` changes; run `/plugin marketplace update sub-human`, or turn on auto-update for the marketplace in `/plugin`.

## Unreleased

Hardening from the October 2026 review (branch `fix/stage0-hardening`).

### Security
- **An admitted machine joins as the one name on the host's card.** The link a Let in makes was not bound to that name: it could take any name no live seat held, and as many seats as it liked (each a member_joined the room's Claude answers). A bound link (an admission's name, a handoff's or promote's pre-bound seats) now joins only those names; another is `AUTH` before a seat is taken.
- **A link's posts are bounded on the host.** A person's own posts over a link are limited to 30 a minute per seat (`LINK_HUMAN_RATE_MAX`; typing never meets it), `blob.put` to 40 new plans per connection, and a connection holds one subscribe stream (a second replaces the first).
- **`SUB_HUMAN_SSH_OPTS` can no longer weaken the link's pinned ssh options** (its key, known_hosts file, `StrictHostKeyChecking`): ssh takes an option's first value, and the environment's options now come after them.
- **`propose({path})` reads only under the session's working directory or Claude Code's plans directory.** The bytes go to every mirror and the whole room, so a steered model could have exfiltrated any readable file with it.
- **`Read` of a seat's private key is denied** by the hooks module (`<home>/keys/`), the one file a model could sign a person's words with. The rest of the store stays readable.
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
- **The joiner is told when the host let them in.** After `/sub-human join HOST ROOM PIN`, the session that typed it shows one dim line once the host's card answers: `the host let you in to room vole-8126: type /sub-human to join it as carol` (or why the join stopped). Before, they had to guess when to type `/sub-human`. The join still never takes the seat in the step that carries the PIN.
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

### Tests
- **The plugin's node tests are TypeScript** (`plugin/sub-human/test/**/*.node-test.ts`, checked by `npm run typecheck` through `tsconfig.test.json`), named so `claude plugin test` never collects them; new cases for unreadable hook stdin, the join's time budget, a mirror's first sync of a large log and of a host log with a corrupt line, a forged line in MCP `read`, and a model-supplied `planFilePath`.

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
