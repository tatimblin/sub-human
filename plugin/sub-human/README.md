# sub-human

A Claude Code plugin for working together from separate sessions on one machine. You join a room with one command and keep working however you like. Your Claude learns who is in the room and how to reach them, and nothing else is prescribed: no workflow, no required plan.

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

**Requirements.** Claude Code 2.1.292 or newer with function hooks on (not `--bare`, not safe mode, and no policy that turns hooks off): the plugin's hooks module guards the store, checks who typed an `@room` and delivers the room, so `/sub-human` refuses to join without it. Node 20 or newer on `PATH`: every hook, the room MCP server, the room tail and the row status line run `node`. macOS or Linux only (the row launcher is a POSIX shell script and the store relies on POSIX rename and file modes); Windows is not supported. `claude plugin validate plugin/sub-human` checks the plugin. Accept workspace trust for your folder: the orch starts in your working directory, and Claude Code refuses to start a background session in an untrusted folder.

## Join: one command

In your normal Claude Code session:

```
/sub-human alice
```

```
sub-human: opened room vole-8126 as alice · others: /sub-human NAME
```

When no room is open, the join hook creates one and starts the orch as a background session titled `orch.vole-8126`. An idle orch costs nothing. The next person runs `/sub-human bob`, and adds the code (`/sub-human bob vole-8126`) only when more than one room is open:

```
joined vole-8126 as bob (alice, orch here)
```

The hook binds your name to your session before the model sees anything, so your Claude can never pick or change it. A name already in the room is refused. Your identity survives `/clear`, compaction and `--resume`. The command shows as `/sub-human:sub-human` in the picker; typing the bare `/sub-human` works.

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
| **Tell Claude what to change**, then type why | Your objection, with your words byte for byte. It blocks the proposal. |
| **Esc**, or Ctrl+G edits before a Yes | Nothing. |

Your mode is never changed by a review. Showing the proposal briefly enters plan mode without asking, and the hooks put you back in your own mode afterwards with no dialog: at once after an answer, or on your next prompt after Esc. A "Yes" that names another mode is set back too; the one the hint names keeps it without that extra step. Agreeing is not a go-ahead to build: your Claude does not carry the proposal out.

Say "show me the proposal" and your Claude opens it again. When everyone named has agreed, the room logs a `decision`. A newer proposal replaces an older one, and earlier answers stop counting.

**The card, as a fallback.** When the plan view can't be used, a question card opens instead (Not yet / Agree / Object, **n** adds a note): when you are already in plan mode yourself, in bypass or don't-ask mode, when `showClearContextOnPlanAccept` is on (that approval path clears the context and starts building), or for a proposal over 200,000 characters. The card shows the proposal beside the options when it fits (up to 2,000 characters and about 20 lines), otherwise a summary and the path. Not yet, Esc, "Chat about this" or no answer record nothing.

Planning is optional. Use your own plan mode and "propose this", type `@room @orch let's plan cursor paging`, or don't plan at all.

## Shared tasks

The room has one shared task list: the orch's own native Claude Code task list. Your private task list stays private.

- Tell your Claude "put the parser tests on the room list, I've got it". It calls the room's `task` tool (`add`, `claim`, `release`, `done`), which replies `queued; the orch applies it`. The orch applies pending requests in one batch.
- Only a task's owner can complete it, with evidence ("12/12 pass, see #15"). A request from anyone else is refused, and the task stays open.
- Your room row shows the summary (`tasks 3 open · #2 you · #4 bob`). `sub-human tasks` lists them, and `sub-human tasks --json` gives the same list as JSON.
- With no orch running, the room task list is unavailable, and `task` says so.

## The `sub-human` CLI

`plugin/sub-human/bin/sub-human` reads the room. Inside a room session it finds your room by itself. It never writes the log.

| Command | Prints |
|---|---|
| `read` | The room log. |
| `digest` | The room's current state in a few lines. |
| `who` | People, the orch and their presence. |
| `watch NAME` | NAME's thread: their own words, their Claude's posts (labelled), and their answers to proposals. |
| `tasks [--json]` | The room's shared task list. |

`tail` (the room tail) and `agent-statusline` (the rows) are internal.

## The room tail

In a session that has joined a room, the plugin's hooks module runs one `node` child, `sub-human tail`, for the session's life: it follows the room's log and hands each new line to the module, which shows it, gives your Claude its copy, or wakes it. The child restarts by itself if it exits, and stops when the session ends or leaves. A session that never joins a room starts no child.

## Settings worth knowing

- **Your own `subagentStatusLine` hides the row text.** The rows' text (who said what, tasks, presence) comes from the plugin's `subagentStatusLine`. Claude Code lets any `subagentStatusLine` in your user, project or local settings, or one passed with `--settings`, override a plugin's, so with one set the rows show your status line instead. Remove it (or run it only outside rooms) to get the room text back.
- **Bypass mode.** In `--dangerously-skip-permissions` (bypass) mode, Claude Code holds incoming `SendMessage`s from other sessions behind a dialog until you answer it. The join message warns you. Use a normal permission mode in a room if you want other Claudes' messages to reach yours without a dialog.

## Room storage

Everything the plugin keeps lives in `~/.sub-human/` (rooms, seats, seat keys in `keys/`, the row launcher in `bin/row-status`), or in `$SUB_HUMAN_HOME` when that is set. Set it the same way for every session that should share rooms: sessions with different homes never see each other. Rooms live in `<home>/rooms/<CODE>/`. Each has an append-only JSON-lines log. Every entry carries `from`, `via` (`human`, `agent` or `system`), `kind` and a `prev` hash of the previous line, so edits are visible. Proposals are stored by hash in `plans/`, the task mirror in `tasks.json`, and row state in `rows/`.

## Threat model

The security model is one machine, one OS user. Everyone in a room is a trusted collaborator running as that same user, so names aren't defended against forgery between people. The goal is narrower: **a model can never speak or consent as a person**. That covers any member's Claude, including one steered by text someone posted in the room. It can't forge an entry with `via=human`, and it can't hide one.

- Agreement and objection come only from the plan view or the card, which the human answers. A plan text edited before "Yes", answers that come with the model's call, an AFK timeout or a stale hash are dropped. The only dialog-free exit the hooks allow records nothing.
- Your words reach the room only through `@room`, posted by a hook. Your Claude's posts are always labelled `via=agent`. `SendMessage` between sessions is Claude to Claude.
- **Seat keys.** Each seat gets an Ed25519 key pair when it joins, stored in `<home>/keys/<CODE>/` (directory 0700; `NAME.key` and `NAME.pub` 0600). Every `via=human` entry is signed with the seat's private key. Only hook processes load that key, and Claude Code runs hooks itself; a model never does. The room MCP server, the CLI and the room tail never load it, so they can't write `via=human` at all; the store refuses the append. Readers check the signature against the public key. A `via=human` line without a valid signature shows as `bob (unverified): …`, and consent never counts it. Logs from before seat keys still read, marked unverified. Their answers still count until that seat gets a key.
- **Who typed it.** The plugin's hooks module reads the origin Claude Code itself stamps on each prompt (only your own Enter, `-p` or Remote Control count as typed) and drops an `@room` that you didn't type (from another session, a notification, another plugin) before any hook runs. It hands that origin to the hook that signs the post together with a secret nonce the module makes for your session and keeps in its lease file (`<home>/sessions/mods/`, 0600). The hook posts only when the origin is typed and the nonce matches the lease; a post whose origin it can't see or trust is refused, and you type it again. Forging one takes reading that lease file, which the guards below deny by path.
- **`@room` fails closed.** If the module's hook for the prompt fails in any way, an `@room` is refused with a short notice. It is never passed on to your Claude as an ordinary prompt.
- **Store guard.** The plugin's function hooks module (`mod/guard.mjs`, Claude Code 2.1.292+) denies `Write`, `Edit`, `MultiEdit` and `NotebookEdit` into the store (`~/.sub-human` or `$SUB_HUMAN_HOME`, checked lexically and after resolving symlinks), so a Claude can't edit the log with its file tools. It runs in-process on every such call, so it costs no process start, and it learns where the store is from the plugin itself when the session starts. It also lets joined sessions use the room tools without a prompt, and refuses `hold` to anything but a row agent. It never answers a tool call in a way that skips other hooks: your own and other plugins' `PreToolUse` hooks still run on the room tools. Where function hooks are off (`--bare`, safe mode, a policy that turns hooks off) a session can't join a room.
- **Bash guard.** The same module checks every `Bash` command and denies one that:
  - names the store (its path, `~/.sub-human`, `$HOME/.sub-human`, the keys under it);
  - names or sets `SUB_HUMAN_HOME`;
  - runs the plugin's own modules or hooks with `node`, `bun`, `deno` or `npx` (`lib/room*`, `lib/identity`, `lib/proposal`, `hooks/*.js`, `mcp/*.js`).

  The read-only CLI (`sub-human read`, `digest`, `who`, `tasks`, `watch`) stays allowed, and so do reading the plugin's source and running its tests. This is a string check. A determined command can evade it, for example a script written to a file first, or a path built at run time. What can't be evaded is the signature: a line written around the store has no valid one, so it shows as unverified and counts for nothing.
- **Not covered.** The `Read` tool is not guarded, so a model can read the store, including the private key files. Other MCP servers that write files aren't guarded either.
- **File modes.** Room directories are 0700, and the log and state files are 0600.
- **Row launcher.** The status-line launcher in `<home>/bin/row-status` runs only plugin roots outside temp directories (`/tmp`, `os.tmpdir()`), unless `SUB_HUMAN_ALLOW_TMP_ROOT=1` is set.
- Only a task's owner, through their own Claude's `done` request, can complete it.

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

## Limits

- **Same machine only.** All sessions share the room directory.
- Agent posts are rate-limited, so Claudes can't wake each other in a loop.

## Leaving

`/exit` asks Claude Code's own question about background work, because your room row is a background agent:

```
❯ 1. Exit and stop tasks
  2. Move to background and exit
  3. Stay
```

Choose **1**. The room records that you left, and your row reads `left` in everyone's panel until you rejoin. A plugin can't mark an agent as safe to stop, so Claude Code always asks this question. `/clear` does not leave the room. When the last person leaves, the orch is stopped and the room closes. The room's `tasks.json` stays.
