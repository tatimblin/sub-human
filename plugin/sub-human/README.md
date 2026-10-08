# sub-human

A Claude Code plugin for working together from separate sessions, on one machine or, with a link, from others. You join a room with one command and keep working however you like. Your Claude learns who is in the room and how to reach them, and nothing else is prescribed: no workflow, no required plan.

- **`@room`** posts your exact words to the room. A hook posts them, so no model paraphrases them.
- **Claudes talk to each other natively,** with Claude Code's own `SendMessage` and `ListAgents`, addressed `NAME.CODE`.
- **A headless helper, the orch,** starts with the room. It keeps the room's shared task list, and it helps plan only when someone asks. It messages people only when they addressed it or when its own action needs telling.
- **Consent is yours.** When a proposal names you, it opens in Claude Code's own plan view in your terminal, all of it scrollable. Only your answer there records agreement. No Claude can give it.

How it is built: [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

## Install

From this repo, without installing, add `--plugin-dir plugin/sub-human` to `claude`. Or install it through the bundled marketplace:

```
claude plugin marketplace add /path/to/sub-human
claude plugin install sub-human@sub-human
```

**Requirements.** Claude Code 2.1.292 or newer with function hooks on (not `--bare`, not safe mode, and no policy that turns hooks off): the plugin's hooks module guards the store, checks who typed an `@room` and delivers the room, so `/sub-human` refuses to join without it. Node 22 or newer on `PATH`: every hook, the room MCP server, the room tail and the row status line run `node`. macOS or Linux only (the row launcher is a POSIX shell script and the store relies on POSIX rename and file modes); Windows is not supported. `claude plugin validate plugin/sub-human` checks the plugin. Accept workspace trust for your folder: the orch starts in your working directory, and Claude Code refuses to start a background session in an untrusted folder.

## Join: one command

In your normal Claude Code session:

```
/sub-human alice
```

When no room is open, the join hook creates one (say `vole-8126`) and starts the orch as a background session titled `orch.vole-8126`. An idle orch costs nothing. A join that works prints nothing (Claude Code would draw it as a warning): your session is titled `alice.vole-8126` and the room's row `vole-8126` appears in your agent panel. A line shows only when something needs you: a refusal, an orch that could not start, or bypass-permissions mode. The next person runs `/sub-human bob`, and adds the code (`/sub-human bob vole-8126`) only when more than one room is open.

The hook binds your name to your session before the model sees anything, so your Claude can never pick or change it. A name already in the room is refused. Your identity survives `/clear`, compaction and `--resume`. The command shows as `/sub-human:sub-human` in the picker; typing the bare `/sub-human` works.

## Join from another machine

A room lives on the machine that opened it, its **host**. Someone on another machine joins with an invite and its PIN.

Two transports exist: **SSH** (the other machine reaches the host's account with an SSH key) and the **pipe** (a second sub-human home on the same machine, another `SUB_HUMAN_HOME`; what the tests and the demo use). Host on a machine that stays awake (a dev box): when the host sleeps, the room is down for everyone.

### Inviting: `/sub-human host`

On the host, in a session that is in the room:

```
/sub-human host --ssh                       # this machine's address: SUB_HUMAN_SSH_ADDR, else you@hostname
/sub-human host --ssh me@devbox.local:2222  # or name it
/sub-human host --ssh me@devbox --via bastion   # the joiner reaches it through a jump host (ProxyJump)
/sub-human host                             # a pipe invite, for a second home on this machine
```

```
sub-human: invite to room vole-8126, for one machine, over ssh me@devbox.local. Shown once; it lasts 15 minutes.

  /sub-human join NAME sh2.vole-8126.c3NoOm1l….Qm9i….YkkF… PIN

PIN 482913  (send it apart from the invite, e.g. say it; 5 wrong tries burn the invite)
The invite pins this machine's ssh host key SHA256:dl2/IPcY….
Their join then shows them a line to send back to you: paste it here, /sub-human admit shk1.…, to let their key in.
```

This is shown to you, never to your Claude. The invite is for one machine and one use. It carries the room, how to reach the host, a single-use secret and the host's SSH host key; the **PIN is not in it**. Send the invite in chat and say the PIN some other way. Only the host checks the PIN, when the joiner's link first connects: 5 wrong tries or 15 minutes and the invite is burnt, and the room shows each wrong PIN. `sub-human host [--room CODE] [--ssh [USER@HOST]] [--via JUMP]` prints the same in your own shell.

### Joining: `/sub-human join NAME INVITE PIN`

On the other machine:

```
/sub-human join carol sh2.vole-8126.c3NoOm1l….Qm9i….YkkF… 482913
```

This step only links the machine to the room, and the hook stops the prompt there, so neither the invite nor the PIN reaches your Claude. It says what to do next:

- **Pipe, or an SSH key the host already let in:** `linked to room vole-8126: the host checked your PIN. Now type: /sub-human carol vole-8126`. That second command takes your seat, as any rejoin does.
- **SSH, the first time:** the join made an SSH key of its own for this link (`<home>/links/vole-8126/id_ed25519`; no key ever travels) and pinned the host's key from the invite (no "unknown host" prompt, and no other host key is accepted). Send the host the line it shows you; it holds no secret:

  ```
  /sub-human admit shk1.vole-8126.4f1c2a9b03de.Qm9i….carol
  ```

  The host pastes it into their session (or runs `sub-human admit shk1.…` in a shell, which asks y/N first). That is their consent: it names who asks and the key's fingerprint, and adds one `authorized_keys` line that lets that key reach only this room's server, as this one link. Your link keeps trying for 15 minutes; once the key is in, it connects and the host checks your PIN. Then type `/sub-human carol vole-8126`. Typing it earlier shows the admit line again.
- **A wrong PIN:** `could not link to room vole-8126: wrong PIN (4 tries left)`. Type the join again with the right PIN. A rejoin never re-sends a refused PIN.

The join starts a **link** on that machine: a small background process (`sub-human link CODE`) that keeps a copy of the room (a mirror) and carries that machine's posts and answers to the host. After that, everything works as on the host: `@room`, rows, proposals in the plan view, tasks. Your words are signed on your machine and checked on the host. The host runs the orch and decides proposals.

- **Rejoin** (a new session on the same machine) with `/sub-human carol vole-8126`. The link is kept, and started again if it had stopped; you need no new invite.
- **When the link is down**, your session shows one dim line, `room link: OFFLINE …`. An `@room` is refused with the reason, and an answer to a proposal is not recorded and you are told so. Nothing is queued: say it again once the link is back. The link retries on its own.
- **The link stops by itself** about a minute after no session of that machine is left in the room.
- **Versions.** The two machines agree on a protocol version when the link connects. When they share none, the join says which side must update, e.g. `host runs sub-human 0.5.0 (protocol 3–4); you run 0.4.0 (protocol 1–2). Update your plugin: /plugin update sub-human`. Update the host first: a host takes joiners one version older.

### Ending a link: `revoke`

On the host, `/sub-human revoke carol` (in a session in the room) or `sub-human revoke LINK_ID|NAME [--room CODE]` in a shell ends a link: its token stops working, its `authorized_keys` line is removed, its seats leave the room, its running server stops, and the room shows a line. The room line for each new link names its id.

### SSH details

- **Forced command.** The line `admit` (or `authorize`) writes is `command="SUB_HUMAN_HOME=… …/.sub-human/bin/serve --stdio vole-8126 --link 1a2b3c4d5e6f",restrict ssh-ed25519 AAAA… sub-human:vole-8126:1a2b3c4d5e6f`. Whatever the other side asks to run, that key runs only this room's server, for that one link (`restrict`: no shell, pty or forwarding), and the server accepts only that link's token, or the invite reserved for it. `<home>/bin/serve` is a stable shim that finds the current plugin install and node when it runs, so the line keeps working after a plugin update or a node upgrade. Paths are absolute because sshd's `PATH` has no Homebrew. The file is `~/.ssh/authorized_keys`, or `SUB_HUMAN_AUTHORIZED_KEYS`, or `--file F`.
- **The joiner's ssh.** The link runs `ssh -T -o BatchMode=yes … -i <link key> -o IdentitiesOnly=yes -o UserKnownHostsFile=<link known_hosts> -o StrictHostKeyChecking=yes -o HostKeyAlias=sub-human-CODE [-J JUMP] -- me@devbox.local`. A jump host is reached with your own `~/.ssh/config` and agent (a host alias works as `--via`). An invite names only a plain `user@host[:port]` and jump hosts: it can't carry an ssh option or a command. `SUB_HUMAN_SSH_OPTS` (space-separated, in the joiner's own environment) adds ssh options; it is meant for tests and unusual setups.
- **MFA bastions.** `sub-human prime CODE [--persist 8h]`, on the joining machine, opens one shared connection interactively (answer the MFA prompt once), and the link rides it (`ControlPath <home>/ssh/cm-%C`). The link itself never prompts (BatchMode) and never opens a shared connection of its own; with none open it connects as usual.
- **By hand (sh1).** `sub-human invite --room CODE --ssh me@devbox [--via JUMP]` prints an older `sh1.…` invite with no PIN, and `sub-human authorize INVITE carol.pub [--file ~/.ssh/authorized_keys]` writes the line for a public key the joiner sent you. The joiner then types `/sub-human join carol sh1.…` (one step). `authorize --file` also rewrites lines sub-human 0.2 wrote (a versioned node and plugin path) to name the shim; it refuses a key that is already in the file with another line. A link id in place of the invite (with `--room CODE`) authorizes another key for a link that exists.

## Rows

Your agent panel gets one row named after the room, with the other people nested inside it:

```
● main
◯ vole-8126   tasks 1 open · #2 bob
```

- **Enter** on the room row opens it. Each person is a row inside it. Enter on one shows that person's own words and their Claude's posts, labelled separately.
- **↑ then Enter** goes back up a level.
- Rows are read-only views. If you type into one, it answers `read-only row — type in main with @room` and nothing is posted.
- After `--resume` or `--continue`, your rows come back by themselves within a few seconds.

While the rows run, Claude Code prints **"✻ Waiting for N background agents to finish"** after each turn, where N counts your rows. This is expected. Your prompt is still free, and nothing is stuck. Setting `"showTurnDuration": false` in your own settings hides the line, along with "Worked for 12s". The plugin never writes your settings.

## Watching the orch

The orch takes no typed input. Every input it gets is attributed: a room entry, a Claude's `SendMessage`, or a task request.

- In the agent view (**←**), it shows as `orch.vole-8126` with its last status. **Space** peeks: its panel lists one row per person, and **ctrl+t** shows the room's task list. **Enter** attaches.
- If you type into it, the prompt is refused with `the orch takes no typed input; use @room or ask your Claude to message orch.vole-8126`. Slash commands are refused too.
- `claude logs <id>` and `sub-human watch orch` show it read-only.
- About half a minute after the last person leaves, the orch is stopped.

## Saying something to the room: `@room`

```
@room bob, can you take the parser tests? handler's in src/tasks.js
room: same thing, without the @ file picker
```

A prompt that starts with `@room ` or `room:` is posted **verbatim** as your words (`via=human`). No model turn runs, and the receipt is one line:

```
⏺ Operation stopped by hook: ✓ sent
```

- Spaces, unicode, `$`, backticks and quotes arrive byte-exact. For multiline input, use `\` + Enter or Ctrl+J.
- Typing `@room` opens the file picker, and a space closes it. Don't press Tab. `room:` avoids the picker.
- Check a prompt suggestion before you accept it. A suggested `@room …` line is your Claude's wording, and accepting it posts it as yours.
- Everyone in the room sees your words. Mention the orch (`@orch`) to wake it.

Anything else you type goes to your own Claude. Its posts are labelled as your Claude's (`via=agent`) and never count as your words.

**The room reads like a group chat.** When someone else posts, everyone else's session shows their exact words, with no ids and nothing added:

```
  sub-human: bob: sure, once we've agreed how paging works
```

A Claude's post shows as `bob's Claude: …`, a join as `bob joined`, a leave as `bob left`. The plugin writes these lines into your session itself, as dim notices that stay there (also after `--resume`). They cost no model turn: your Claude doesn't repeat them, and it gets a copy to read with its next request. A leave shows only after 8 s away, so a quick leave and rejoin shows nothing.

Every person's own words reach everyone. A Claude's post reaches you when it is addressed to you or mentions `@you`, and a proposal naming you opens for you to read and answer: those wake your Claude with a prompt from the plugin ("Prompt from the sub-human plugin"), or join its current turn if it is busy. Everything else reaches your Claude as a short "Room since your last turn" note it reads with its next request. Your room row also reads `+bob joined` or `−bob left` for two minutes.

**On your phone (Remote Control).** The phone shows your session's prompts and replies, not the dim notices. So once you type in the session from Remote Control, the plugin sends what would have been a notice there as a short prompt of its own holding just those lines (`alice: hi`, `room: "Rate limiting" agreed (bob)`): room lines, batched to at most one every few seconds, and a refusal of your `@room` (a post that went through shows nothing more). Each one is a model turn; your Claude is told it needs no reply. Typing at the terminal again turns it off. A proposal's plan view works on the phone too: a bare **Deny** records nothing. A note (**Suggest edits**, or "Tell Claude what to change" at the terminal) is never sent by itself, because a message you type on the phone right after a Deny lands there too: a card asks `Send to alice as changes requested on "…": "…"?`, and only your **Send** records the objection with that note (**Discard** records nothing; reopen the proposal any time).

**Claude to Claude.** Ask your Claude to "ask alice's Claude what the cursor format is". It calls `SendMessage` to `alice.vole-8126`, and alice's pane shows `› Message from @bob.vole-8126: …`. Those messages come from Claudes, not people.

## Agreeing to a proposal

Anyone can propose something. Tell your Claude "propose this" (a plan from your own plan mode, a file or some text), or ask the orch to plan. The proposal names its approvers, by default the people in the room.

When a proposal names you, your Claude opens it in Claude Code's plan-approval dialog, the same view your own plans use. The plugin's hooks put the real proposal there, byte for byte, whatever your Claude wrote:

```
 Ready to code?
 Here is Claude's plan:
 ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  Plan: cursor paging for GET /tasks
  …
  │ room proposal 3fa2c1d0e9b8 from alice, for bob (PgUp/PgDn scroll). Agree: "Yes, manually approve edits"
  │ keeps your mode. Object: "Tell Claude what to change" + why. Esc: decide later.
 ❯ 1. Yes, and use auto mode
   2. Yes, manually approve edits
   3. Tell Claude what to change
```

**PgUp** and **PgDn** scroll the whole proposal, however long.

| You do | Recorded |
|---|---|
| A **Yes** option | Your sign-off on that exact hash (`via=human`). |
| **Tell Claude what to change**, then type why | Nothing yet: a card asks `Send to alice as changes requested on "…": "…"?`. **Send** records your objection, with your words byte for byte; it blocks the proposal. **Discard** records nothing. |
| **Esc**, or Ctrl+G edits before a Yes | Nothing. |

Your mode is never changed by a review. Showing the proposal briefly enters plan mode without asking, and the hooks put you back in your own mode afterwards with no dialog: at once after an answer, or on your next prompt after Esc. A "Yes" that names another mode is set back too; the one the hint names keeps it without that extra step. Agreeing is not a go-ahead to build: your Claude does not carry the proposal out.

Say "show me the proposal" and your Claude opens it again. With several waiting, name the one you mean ("open the v3 one", or its hash): the hooks open the one your own last words name, else the oldest, never one your Claude chose. When everyone named has agreed, the room logs a `decision`. A newer proposal replaces an older one, and earlier answers stop counting.

**The card, as a fallback.** When the plan view can't be used, a question card opens instead (Not yet / Agree / Object, **n** adds a note): when you are already in plan mode yourself, in bypass or don't-ask mode, when `showClearContextOnPlanAccept` is on (that approval path clears the context and starts building), or for a proposal over 200,000 characters. The card shows the proposal beside the options when it fits (up to 2,000 characters and about 20 lines), otherwise a summary and the path. Not yet, Esc, "Chat about this" or no answer record nothing.

Planning is optional. Use your own plan mode and "propose this", type `@room @orch let's plan cursor paging`, or don't plan at all.

## Shared tasks

The room has one shared task list: the orch's own native Claude Code task list. Your private task list stays private.

- Tell your Claude "put the parser tests on the room list, I've got it". It calls the room's `task` tool (`add`, `claim`, `release`, `done`), which replies `queued; the orch applies it`. The orch applies pending requests in one batch.
- Only a task's owner can complete it, with evidence ("12/12 pass, see #15"). A request from anyone else is refused, and the task stays open.
- Your room row shows the summary (`tasks 3 open · #2 you · #4 bob`). `sub-human tasks` lists them, and `sub-human tasks --json` gives the same list as JSON.
- With no orch running, the room task list is unavailable, and `task` says so.

## The `sub-human` CLI

`plugin/sub-human/scripts/sub-human` reads the room. Inside a room session it finds your room by itself. It never posts as anyone; only the host's link commands (`admit`, `revoke`) add a line from the room itself. It lives in the plugin's `scripts/`, not `bin/`: claude.ai rejects a plugin with a top-level `bin/` when an organization distributes it, so the CLI is not on the Bash tool's `PATH`. Claude reads the room with the room MCP tools; in your own shell, run it by its path (`node <plugin root>/scripts/sub-human …`) or alias it.

| Command | Prints |
|---|---|
| `read` | The room log. |
| `digest` | The room's current state in a few lines. |
| `who` | People, the orch and their presence. |
| `watch NAME` | NAME's thread: their own words, their Claude's posts (labelled), and their answers to proposals. |
| `tasks [--json]` | The room's shared task list. |
| `host [--room CODE] [--ssh [USER@HOST[:PORT]]] [--via JUMP]` | An sh2 invite and its PIN, as `/sub-human host` shows them. |
| `admit REQUEST [--file F] [--yes]` | Let in the SSH key a joiner's admit request (`shk1.…`) carries, for that invite's link only; asks y/N first. |
| `revoke LINK_ID\|NAME [--room CODE] [--file F]` | End a link: token burnt, key line removed, its seats leave. |
| `prime CODE [--persist 8h]` | On a joining machine: one shared SSH connection, opened interactively, for an MFA bastion; the link rides it. |
| `invite [--ssh USER@HOST[:PORT]] [--via JUMP]` | An older one-step `sh1` invite (no PIN) to a room hosted here. |
| `authorize INVITE\|LINK_ID PUBKEY [--file F]` | The `authorized_keys` forced-command line for an SSH joiner's key and that one link; `--file` appends it. |
| `link CODE [--reset]` | Run the link to room CODE hosted elsewhere (in the foreground; joins start it in the background). `--reset` copies the room again after a FORK. |

`tail` (the room tail), `agent-statusline` (the rows) and `serve --stdio CODE` (the host's end of a link) are internal. Run `host`, `admit`, `revoke`, `prime`, `invite`, `authorize`, `link` and `serve` in your own shell: the plugin refuses them to a Claude.

## The room tail

In a session that has joined a room, the plugin's hooks module runs one `node` child, `sub-human tail`, for the session's life: it follows the room's log and hands each new line to the module, which shows it, gives your Claude its copy, or wakes it. The child restarts by itself if it exits, and stops when the session ends or leaves. A session that never joins a room starts no child.

## Settings worth knowing

- **Your own `subagentStatusLine` hides the row text.** The rows' text (who said what, tasks, presence) comes from the plugin's `subagentStatusLine`. Claude Code lets any `subagentStatusLine` in your user, project or local settings, or one passed with `--settings`, override a plugin's, so with one set the rows show your status line instead. Remove it (or run it only outside rooms) to get the room text back.
- **Bypass mode.** In `--dangerously-skip-permissions` (bypass) mode, Claude Code holds incoming `SendMessage`s from other sessions behind a dialog until you answer it. The join message warns you. Use a normal permission mode in a room if you want other Claudes' messages to reach yours without a dialog.

## Room storage

Everything the plugin keeps lives in `~/.sub-human/` (rooms, seats, seat keys in `keys/`, the row launcher in `bin/row-status`, the SSH serve shim in `bin/serve`), or in `$SUB_HUMAN_HOME` when that is set. Set it the same way for every session that should share rooms: sessions with different homes never see each other, except through a link (see **Join from another machine**). Rooms live in `<home>/rooms/<CODE>/`. Each has an append-only JSON-lines log. Every entry carries `from`, `via` (`human`, `agent` or `system`), `kind` and a `prev` hash of the previous line, so edits are visible. Proposals are stored by hash in `plans/`, the task mirror in `tasks.json`, and row state in `rows/`. On a machine that joined a room hosted elsewhere, `<home>/links/<CODE>.json` is the link (with its token; file 0600) and `<home>/links/<CODE>.log` its log; `rooms/<CODE>/` there is the mirror, written only by the link.

## Threat model

The security model is one machine, one OS user, per room: everyone on the host is a trusted collaborator running as that same user, so names aren't defended against forgery between people. **The host is trusted** by everyone who joins it: it holds the room, places every entry and decides proposals. The goal is narrower: **a model can never speak or consent as a person**. That covers any member's Claude, including one steered by text someone posted in the room. It can't forge an entry with `via=human`, and it can't hide one.

- Agreement and objection come only from the plan view or the card, which the human answers. A plan text edited before "Yes", answers that come with the model's call, an AFK timeout or a stale hash are dropped. The only dialog-free exit the hooks allow records nothing.
- Your words reach the room only through `@room`, posted by a hook. Your Claude's posts are always labelled `via=agent`. `SendMessage` between sessions is Claude to Claude.
- **Seat keys.** Each seat gets an Ed25519 key pair when it joins, stored in `<home>/keys/<CODE>/` (directory 0700; `NAME.key` and `NAME.pub` 0600). The join writes the public key into the room's log, which pins it: a name is its key for the room's life, and a later join under that name with another key is refused (a lost key means a new name). Every `via=human` entry is signed with the seat's private key. The signature covers what was said, the room, a random nonce and a timestamp, not the entry's place in the log; the store refuses a nonce it has already placed and a timestamp more than 10 minutes off. Only hook processes load that key, and Claude Code runs hooks itself; a model never does. The room MCP server, the CLI and the room tail never load it, so they can't write `via=human` at all; the store refuses the append. Readers check the signature against the pinned key. A `via=human` line without a valid signature shows as `bob (unverified): …`, and consent never counts it. Logs from before keys were pinned still read: their signatures check against the local `NAME.pub`, and an unsigned answer from a seat with no key still counts, marked unverified. A room that pins any key never counts an unsigned answer.
- **Who typed it.** The plugin's hooks module reads the origin Claude Code itself stamps on each prompt (only your own Enter, `-p` or Remote Control count as typed) and drops an `@room` that you didn't type (from another session, a notification, another plugin) before any hook runs. It hands that origin to the hook that signs the post together with a secret nonce the module makes for your session and keeps in its lease file (`<home>/sessions/mods/`, 0600). The hook posts only when the origin is typed and the nonce matches the lease; a post whose origin it can't see or trust is refused, and you type it again. Forging one takes reading that lease file, which the guards below deny by path.
- **`@room` fails closed.** If the module's hook for the prompt fails in any way, an `@room` is refused with a short notice. It is never passed on to your Claude as an ordinary prompt.
- **Store guard.** The plugin's function hooks module (`mod/guard.mjs`, Claude Code 2.1.292+) denies `Write`, `Edit`, `MultiEdit` and `NotebookEdit` into the store (`~/.sub-human` or `$SUB_HUMAN_HOME`, checked lexically and after resolving symlinks), so a Claude can't edit the log with its file tools. It runs in-process on every such call, so it costs no process start, and it learns where the store is from the plugin itself when the session starts. It also lets joined sessions use the room tools without a prompt, and refuses `hold` to anything but a row agent. It never answers a tool call in a way that skips other hooks: your own and other plugins' `PreToolUse` hooks still run on the room tools. Where function hooks are off (`--bare`, safe mode, a policy that turns hooks off) a session can't join a room.
- **Bash guard.** The same module checks every `Bash` command and denies one that:
  - names the store (its path, `~/.sub-human`, `$HOME/.sub-human`, the keys under it);
  - names or sets `SUB_HUMAN_HOME`;
  - runs the plugin's own modules or hooks with `node`, `bun`, `deno` or `npx` (`lib/room*`, `lib/identity`, `lib/proposal`, `hooks/*.js`, `mcp/*.js`).

  The read-only CLI (`sub-human read`, `digest`, `who`, `tasks`, `watch`) stays allowed, and so do reading the plugin's source and running its tests. This is a string check. A determined command can evade it, for example a script written to a file first, or a path built at run time. What can't be evaded is the signature: a line written around the store has no valid one, so it shows as unverified and counts for nothing.
- **Not covered.** The `Read` tool is not guarded, so a model can read the store, including the private key files. Other MCP servers that write files aren't guarded either.
- **File modes.** The home and every directory in it are 0700 (a home an older version made 0755 is closed when a room is opened), and the log and state files are 0600.
- **Row launcher and serve shim.** The status-line launcher in `<home>/bin/row-status` and the SSH serve shim `<home>/bin/serve` run only plugin roots outside temp directories (`/tmp`, `os.tmpdir()`), unless `SUB_HUMAN_ALLOW_TMP_ROOT=1` is set.
- Only a task's owner, through their own Claude's `done` request, can complete it.

Remote rooms add:

- **An invite is shown once** and works for one machine; the host keeps only its hash. An invite is untrusted input: its locator is a home path (pipe) or a plain `user@host[:port]` with plain jump hosts (ssh), and the link always runs this plugin's own server, or `ssh` with fixed options, never a command or an ssh option the invite names.
- **The PIN is a second factor checked online only.** It is never in the invite and never seals or derives anything: the host keeps `sha256(secret:PIN)`, checks it at the link's first connection, and burns the invite after 5 wrong tries, 15 minutes, or its one use. The join that carries it is hidden from your Claude (the prompt is blocked and suppressed), and the joining machine drops it with the invite once the host answered. A leaked invite alone gets nowhere; a leaked invite plus a key the host admitted gets 5 guesses.
- **Over SSH, keys are made where they are used.** The joiner's link key is made on the joiner's machine; the host admits only its public key, by pasting the request, and the invite pins the host's SSH host key on the joiner's side.
- **Over SSH, the host's `authorized_keys` decides what runs**: `admit` (or `sub-human authorize`) writes a `command="… serve --stdio CODE --link ID",restrict` line, so the key reaches that room's server for that link and nothing else, and the server refuses another link's token there.
- **A link token is a seat-level credential.** The invite turns into a token at the link's first connection. It is stored in clear in `<home>/links/<CODE>.json` (0600, the same trust as the seat key) and hashed on the host. Whoever holds it can post as the seats joined over that link, never as anyone else: the host checks every entry's `from` against them and its signature against the key pinned in the log.
- **Keys are pinned strictly.** A name is its key for the room's life, on every machine. A lost key, or the same name from a new machine, means a new name.
- **Addressed posts are not private.** A post to one person (`to`) has its own rate limit, but the whole room reads the log, on every machine.
- **The guard denies `sub-human host`, `admit`, `revoke`, `prime`, `invite`, `authorize`, `link` and `serve` to a model**, and `/sub-human host` shows the invite and PIN to you, not to your Claude.

The plugin doesn't stop a hostile local user, who can read the keys and write the files directly. The hash chain makes such edits visible. It doesn't prevent them.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Unknown command" for `/sub-human` | Launch with `--plugin-dir plugin/sub-human`, or install the plugin. |
| `/sub-human NAME` asks for a code | More than one room is open, so add the CODE. |
| "no orch" on join, or `Workspace not trusted` | Run `claude` in that folder once and accept trust, then join again. Without an orch the room still works, but it has no shared task list. |
| No rows in the panel | Accept workspace trust for this folder. After a resume they come back by themselves. |
| A proposal didn't open | Ask your Claude to "show me the proposal". `sub-human read` shows who a proposal names. |
| `/sub-human` says it needs Claude Code 2.1.292+ with function hooks on | Update Claude Code, and start it without `--bare` or safe mode; a managed policy that turns hooks off also prevents it. |
| `room link: OFFLINE` | The link can't reach the host. It retries by itself (1 s, doubling to 10 s); posts and answers are refused, not queued, until it is back, and `room link: back online` says when. `~/.sub-human/links/CODE.log` says why. |
| `room link: FORK` | This machine's copy no longer matches the host's log. Nothing more syncs. Run `sub-human link --reset CODE` in your shell: the link copies the room again from the host. |
| SSH join: `room … is offline` and the link log says `Permission denied (publickey)` | The key ssh used is not the one the host authorized, or the host's `authorized_keys` line is missing. The link uses `BatchMode=yes`, so it never asks for a password or a passphrase: load the key into your agent, or name it in `~/.ssh/config` (or `SUB_HUMAN_SSH_OPTS="-i KEY"`). |
| SSH join: `Host key verification failed` in the link log | ssh has not seen the host yet and BatchMode can't ask. Run `ssh me@host true` once in your shell to accept its key. |
| SSH join: `no room` or `AUTH: this token is not link …'s` in the link log | The forced command names another room, home or link than your invite. Ask the host to run `sub-human authorize` again with your invite and key. |
| `AUTH` after upgrading the plugin | A seat that joined before keys were pinned can't post as you. Rejoin with `/sub-human NAME CODE`; if the name's key is lost, join with a new name. |

## Limits

- **Remote joining needs SSH** to the host's account (or a second home on the same machine). There is no relay or tunnel transport yet.
- **A name is one machine's**: its key stays where it joined first.
- Agent posts are rate-limited, so Claudes can't wake each other in a loop.

## Leaving

`/exit` asks Claude Code's own question about background work, because your room row is a background agent:

```
❯ 1. Exit and stop tasks
  2. Move to background and exit
  3. Stay
```

Choose **1**. The room records that you left, and your row reads `left` in everyone's panel until you rejoin. A plugin can't mark an agent as safe to stop, so Claude Code always asks this question. `/clear` does not leave the room. When the last person leaves, the orch is stopped and the room closes. The room's `tasks.json` stays.
