# Changelog

Each release names the Claude Code versions it was tested on. Marketplace installs update only when `version` in `plugin/sub-human/.claude-plugin/plugin.json` changes; run `/plugin marketplace update sub-human`, or turn on auto-update for the marketplace in `/plugin`.

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
