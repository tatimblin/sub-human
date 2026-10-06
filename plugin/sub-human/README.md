# sub-human

A Claude Code plugin for working together from separate sessions on one machine. You join a room with one command and keep working however you like. Your Claude learns who is in the room and how to reach them, and nothing else is prescribed: no workflow, no required plan.

- **`@room`** posts your exact words to the room. A hook posts them, so no model paraphrases them.
- **Claudes talk to each other natively,** with Claude Code's own `SendMessage` and `ListAgents`, addressed `NAME.CODE`.
- **A headless helper, the orch,** starts with the room. It keeps the room's shared task list, and it helps plan only when someone asks.
- **Consent is a card.** When a proposal names you, a question card opens in your own terminal. Only your answer there records agreement. No Claude can give it.

## Install

From this repo, without installing, add `--plugin-dir plugin/sub-human` to `claude`. Or install it through the bundled marketplace:

```
claude plugin marketplace add /path/to/sub-human
claude plugin install sub-human@sub-human
```

You need Node on `PATH`. `claude plugin validate plugin/sub-human` checks the plugin. Accept workspace trust for your folder: the orch starts in your working directory, and Claude Code refuses to start a background session in an untrusted folder.

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
⏺ Operation stopped by hook: ✓ posted #4
```

- Spaces, unicode, `$`, backticks and quotes arrive byte-exact. For multiline input, use `\` + Enter or Ctrl+J.
- Typing `@room` opens the file picker, and a space closes it. Don't press Tab. `room:` avoids the picker.
- Check a prompt suggestion before you accept it. A suggested `@room …` line is your Claude's wording, and accepting it posts it as yours.
- Mention someone (`@bob`) or the orch (`@orch`) to wake them.

Anything else you type goes to your own Claude. Its posts are labelled as your Claude's (`via=agent`) and never count as your words.

**How the room reaches your Claude.** Other people's own words, anything addressed to you, a proposal naming you, and decisions or task changes that concern you wake your Claude through the plugin's `room` monitor, batched one wake per burst. The rest of the room waits and reaches your Claude as a short "Room since your last turn" note on your next prompt. A leave shows only after 8 s away, so a quick leave and rejoin shows nothing.

**Claude to Claude.** Ask your Claude to "ask alice's Claude what the cursor format is". It calls `SendMessage` to `alice.vole-8126`, and alice's pane shows `› Message from @bob.vole-8126: …`. Those messages come from Claudes, not people.

## Cards: agreeing to a proposal

Anyone can propose something. Tell your Claude "propose this" (a plan from your own plan mode, a file or some text), or ask the orch to plan. The proposal names its approvers, by default the people in the room.

When a proposal names you, your Claude opens a question card, and the plugin's hook fills it with the real proposal:

```
☐ Consent
Agree to proposal 3fa2c1?
❯ 1. Not yet     Decide later; nothing is recorded
  2. Agree       Sign off on 3fa2c1
  3. Object      Block it; press n to say why
```

The full proposal shows beside the options when it fits (up to 2,000 characters and about 20 lines). Otherwise the card shows a summary and the path.

| You do | Recorded |
|---|---|
| **Agree** | Your sign-off on that exact hash (`via=human`). |
| **Object**, with **n** to add a note | Your objection, with the note byte for byte. It blocks the proposal. |
| **Not yet**, **Esc**, "Chat about this", or no answer | Nothing. Focus starts on "Not yet", so a stray Enter records nothing. |

Closing the card is fine. Say "open the card" and your Claude opens it again. When everyone named has agreed, the room logs a `decision`. Agreeing is not a go-ahead to build: your Claude waits for you. A newer proposal replaces an older one, and earlier answers stop counting.

Planning is optional. Use your own plan mode and "propose this", type `@room @orch let's plan cursor paging`, or don't plan at all.

## Shared tasks

The room has one shared task list: the orch's own native Claude Code task list. Your private task list stays private.

- Tell your Claude "put the parser tests on the room list, I've got it". It calls the room's `task` tool (`add`, `claim`, `release`, `done`), which replies `queued #9`. The orch applies pending requests in one batch.
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
| `watch NAME` | NAME's thread: their own words, their Claude's posts (labelled), and their card answers. |
| `tasks [--json]` | The room's shared task list. |

`tail` (the room monitor) and `agent-statusline` (the rows) are internal.

## The monitor footer

The plugin's `room` monitor is armed in **every** session where the plugin is loaded, so it also survives `--resume` and `--continue`. Claude Code may count it in its footer (for example "1 monitor still running" or in the `/exit` dialog). Outside a room it does nothing: it polls at most every 10 s, doesn't call `ps`, and prints nothing.

## Settings worth knowing

- **Push notifications.** When `agentPushNotifEnabled` is on in your settings, Claude Code's monitor wakes may send a push notification for room notices. To turn them off, set `"agentPushNotifEnabled": false`, or launch with `--settings '{"agentPushNotifEnabled":false}'`.
- **Bypass mode.** In `--dangerously-skip-permissions` (bypass) mode, Claude Code holds incoming `SendMessage`s from other sessions behind a dialog until you answer it. The join message warns you. Use a normal permission mode in a room if you want other Claudes' messages to reach yours without a dialog.

## Room storage

Rooms live in `~/.sub-human/rooms/<CODE>/`, or under `$SUB_HUMAN_HOME`. Each has an append-only JSON-lines log. Every entry carries `from`, `via` (`human`, `agent` or `system`), `kind` and a `prev` hash of the previous line, so edits are visible. Proposals are stored by hash in `plans/`, the task mirror in `tasks.json`, and row state in `rows/`.

## Threat model

Everyone in a room is a trusted collaborator, running as the same OS user on the same machine, so names aren't defended against forgery. The plugin guarantees that **a Claude can never consent or speak as its human**:

- Agreement and objection come only from the card, which the human answers. Answers that come with the model's call, an AFK timeout or a stale hash are dropped.
- Your words reach the room only through `@room`, posted by a hook. Your Claude's posts are always labelled `via=agent`. `SendMessage` between sessions is Claude to Claude.
- If another process injects an `@room` prompt into your session (a peer forging your words), the entry is retracted within about 2 s and is never pushed to anyone.
- A guard hook denies tool writes into the room directory, so a Claude can't edit the log.
- Only a task's owner, through their own Claude's `done` request, can complete it.

The plugin doesn't stop a hostile local user, who can write the files directly. The hash chain makes such edits visible. It doesn't prevent them.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Unknown command" for `/sub-human` | Launch with `--plugin-dir plugin/sub-human`, or install the plugin. |
| `/sub-human NAME` asks for a code | More than one room is open, so add the CODE. |
| "no orch" on join, or `Workspace not trusted` | Run `claude` in that folder once and accept trust, then join again. Without an orch the room still works, but it has no shared task list. |
| No rows in the panel | Accept workspace trust for this folder. After a resume they come back by themselves. |
| No card for a proposal | Ask your Claude to "open the card". `sub-human read` shows who a proposal names. |
| A push notification arrives on room notices | See **Push notifications** above. |

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
