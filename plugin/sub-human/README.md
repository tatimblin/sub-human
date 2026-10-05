# sub-human

A Claude Code plugin for planning together from separate sessions on one machine. People join a session the way it spawns subagents.

- One session is the room's **orchestrator**: an unattended Claude that facilitates, writes the shared plan and splits the work. Its agent panel shows one row per member.
- Everyone else, the host included, **joins** from their own normal Claude Code session and keeps their own Claude. Their panel shows one row for the room, with the other members inside it.
- When a plan is published, each approver gets a **native sign-off form** in their own terminal. The orchestrator's plan goes through only when every approver has approved the exact same plan.

Nothing replaces Claude Code: tests, status and "done" are ordinary Claude Code work. The plugin adds a room log, a join command, an `@room` prefix, panel rows, the sign-off form, and hooks that bind identity and gate the plan.

## Install

From this repo, without installing, pass `--plugin-dir plugin/sub-human` (as below). Or install through the bundled marketplace (the repo root holds `.claude-plugin/marketplace.json`):

```
claude plugin marketplace add /path/to/sub-human
claude plugin install sub-human@sub-human
```

Then drop `--plugin-dir …` from the commands below. Requires Node on `PATH`. `claude plugin validate plugin/sub-human` checks the plugin. Accept workspace trust when asked: the panel rows don't render without it.

## Launch

**The orchestrator** (one window, which nobody types in after this):

```
claude --plugin-dir plugin/sub-human --agent sub-human:orchestrator --permission-mode plan
```

Then type `/sub-human` and press Enter (twice if the picker completes it first). It prints an invite code such as `marmot-2509`. The orchestrator has no Bash and writes only its plan file, so it raises no permission prompts.

**Each member**, the host included, in their own window and working copy:

```
claude --plugin-dir plugin/sub-human
```

Then `/sub-human NAME`, or `/sub-human NAME CODE` when more than one room is open. A join hook binds `NAME` to your session before the model sees anything, so your Claude can never pick or change your name. A name already in the room is refused. Your identity survives `/clear` and compaction.

The command shows as `/sub-human:sub-human` in the picker and transcript; typing the bare `/sub-human` works.

## What each person sees

**The orchestrator's** panel has one row per member, with text computed from the room log:

```
● main
◯ alice   ✓ signed 593da0 · idle
◯ bob     ⚠ reviewing 593da0 · ✖ 1 objection (#31)
```

**A member's** panel has a single row named after the room. The room row's text is the room's state: plan progress, `⚠ your sign-off needed`, `✉ 1 for you`. Members get no status line.

```
● main
◯ marmot-2509  plan 593da0 1/2 · ⚠ your sign-off needed
```

- **Enter** on the room row opens it: the facilitator's posts, plan revisions and the decision. The other members are rows inside it; Enter on one shows that person's words and their Claude's posts, labelled separately.
- **↑ then Enter** goes back up a level. There's no breadcrumb, and Esc doesn't step back.
- **Esc twice kills the row you're viewing.** It comes back by itself within a few seconds. The dead copy stays listed until `/clear`.
- Rows are read-only. You talk in `main`: with `@room`, or by asking your Claude.

Room notices also reach your Claude through the plugin's `room` monitor, so even an idle session wakes for them. Your Claude tells you each one in a line, and acts only when you're addressed or you ask.

While the rows run, Claude Code shows **"✻ Waiting for N background agents to finish"** after each turn. That's normal; your prompt is free. `"showTurnDuration": false` in your settings hides it, along with "Worked for 12s".

## Saying something to the room: `@room`

```
@room I'd rather keep the cursor opaque; page numbers break under inserts.
room: same thing, with no @ picker
```

A prompt starting with `@room ` or `room:` is posted **verbatim** as your words (`via=human`) by a hook. No model turn runs and nothing is paraphrased. The receipt reads:

```
⏺ UserPromptSubmit operation blocked by hook:
  ✓ posted to marmot-2509 as #17
```

"Blocked" is Claude Code's wording for any prompt a hook handles; the post went through. A failed post reads `✗ not posted: …` with the reason.

- Leading and internal spaces, unicode, `$`, backticks and quotes arrive byte-exact. Multiline: `\` + Enter or Ctrl+J.
- Typing `@room` opens the file picker; a space closes it. Don't press Tab. `room:` avoids the picker.
- Check prompt suggestions before accepting one: a suggested `@room …` line is your Claude's wording, and accepting it posts it as yours.

Anything else you type goes to your own Claude. Its posts show as "NAME's Claude" (`via=agent`) and never count as your words or your consent.

## Signing off

The orchestrator chooses the approvers for each plan: anyone who asks (`@room I want to approve this`) and anyone who shaped the plan or owns part of it. Joining alone doesn't make you one. Anyone in the room can block a plan by objecting.

When a plan names you, this form appears in your terminal within a second, whether you're idle or mid-turn:

```
sub-human · room marmot-2509 · plan 593da0 (rev 2)
GET /tasks?limit&after: cursor paging, bare array, max 50
Full plan: ~/.sub-human/rooms/marmot-2509/plans/593da0.md   (or: sub-human plan)
  ❯ Approve      Object
  Reason (if objecting): ____
```

| You do | Recorded |
|---|---|
| Approve | `signoff via=human` against that plan hash. |
| Object, with a reason | `objection via=human`, with your reason byte for byte. It blocks the plan. |
| Esc | Nothing. The form comes back in 10 minutes, or right away when you tell your Claude "review". |

Your Claude can't answer the form and runs no turn for it. A new revision of the plan replaces a form you haven't answered, and voids every earlier sign-off. You never enter plan mode to sign off.

When every approver has signed the current hash, the orchestrator's plan mode ends with no dialog. A hook writes the `decision`, citing each sign-off, and the orchestrator posts assignments: owners, files, contracts and what "done" means.

## Doing the work

When you say go on your assignment, your Claude posts a `status` ("starting X in the background") and runs the work in one of Claude Code's own background subagents, so your session stays free. When it finishes, your Claude posts a `status` with the evidence it saw: test counts, a commit, a path.

Shared jobs that belong to nobody (run the whole suite, check two parts fit) go to the orchestrator, which runs them in its own background subagent. Nobody can approve prompts in its window, so a step that needs one comes back to a member.

## The `sub-human` CLI

`plugin/sub-human/bin/sub-human` reads the room. Inside a room session it finds your room by itself; it never writes the log.

| Command | Prints |
|---|---|
| `read` | The room log. |
| `digest` | The room's current state in a few lines. |
| `who` | Members and their presence. |
| `plan [hash]` | The current plan, or the one with that hash. |
| `watch NAME` | NAME's full thread: their own words, their Claude's posts (labelled), and their sign-offs and objections. |
| `statusline` | The orchestrator's status line (below). |

`tail` (the room monitor) and `agent-statusline` (the panel rows) are internal.

## Status line for the orchestrator (optional)

The rows come from the plugin's own settings. The main status line can't, so pass it with `--settings`, which adds a settings layer for this launch only:

```
cat > /tmp/sub-human-orch.json <<EOF
{ "statusLine": { "type": "command", "command": "$PWD/plugin/sub-human/bin/sub-human statusline", "refreshInterval": 5 } }
EOF
claude --plugin-dir plugin/sub-human --agent sub-human:orchestrator --permission-mode plan --settings /tmp/sub-human-orch.json
```

It reads `⬡ marmot-2509 · orch · plan 593da0 1/2 ✔`. Outside a room it prints nothing. Set `NO_COLOR=1` for plain text.

## Room storage

Rooms live in `~/.sub-human/rooms/<CODE>/`, or under `$SUB_HUMAN_HOME`. Each has an append-only JSON-lines log in which every entry carries `from`, `via` (`human`, `agent` or `system`), `kind` and a `prev` hash of the previous line, so edits are visible. Plans are stored by hash in `plans/`, and row state in `rows/`.

## Threat model

Everyone in a room is a collaborator, running as the same OS user on the same machine. Names aren't defended against forgery. What the plugin guarantees is that **a Claude can never sign off or speak as its human**:

- A sign-off or objection comes only from the native form, which the human answers. No model tool records one.
- Your words reach the room only through `@room`, posted by a hook. Your Claude's posts are always labelled `via=agent`.
- A guard hook denies tool writes into the room directory, so a Claude can't edit the log.

It doesn't stop a hostile local user, who can write the files directly. The hash chain makes such edits visible; it doesn't prevent them.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Unknown command" for `/sub-human` | Launch with `--plugin-dir plugin/sub-human`, or install the plugin. |
| `/sub-human` with no name opened a room in my working session | With no name, `/sub-human` always opens a room and makes that session the orchestrator. Launch the orchestrator in its own window with `--agent sub-human:orchestrator --permission-mode plan` (no Bash, plan mode), and join from your working session with `/sub-human NAME`. |
| `/sub-human NAME` asks for a code | More than one room is open; add the CODE. |
| No rows in the panel | Accept workspace trust for this folder. After `--resume`, your Claude is told to re-create them. |
| A row vanished after Esc | It returns within a few seconds. |
| No sign-off form | Check `sub-human plan` names you. If you dismissed it, tell your Claude "review". |
| The orchestrator is waiting | Its status names who hasn't signed. They answer the form or object. |

## Limits

- **Same machine only.** All sessions share the room directory.
- Agent posts are rate-limited (6 per minute per member), so Claudes can't wake each other in a loop.

## Leaving

`/exit` asks "Background work is running…". Choose **1, "Exit and stop tasks"**: the room records `member_left`, and your row disappears from everyone's panel. `/clear` does not leave the room.
