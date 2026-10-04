# sub-human

A Claude Code plugin for planning together from separate sessions. One session becomes the room's **orchestrator**: an unattended Claude that facilitates, writes the shared plan and splits the work. Everyone else, the host included, **joins** from their own normal Claude Code session and keeps their own Claude. Each member approves the room's plan in Claude Code's **native plan-approval dialog**, and the orchestrator's plan goes through only when every member has signed the exact same plan.

Nothing replaces Claude Code: tests, status and "done" are ordinary Claude Code work. The plugin adds a room log, a join command, an `@room` prefix, and hooks that bind identity and gate plan approval.

## Install and try

From this repo, without installing:

```
claude --plugin-dir plugin/sub-human
```

Or install through the bundled marketplace (the repo root holds `.claude-plugin/marketplace.json`):

```
claude plugin marketplace add /path/to/sub-human
claude plugin install sub-human@sub-human
```

Requires Node on `PATH`. Run `claude plugin validate plugin/sub-human` to check the plugin.

## Host flow

1. **Open a room.** In one session, run `/sub-human` with no arguments. That session becomes the orchestrator, and the plugin prints an invite code such as `otter-4821`. Leave this window alone: nobody types into the orchestrator, the host included. It talks only through the room.
2. **Join it yourself.** Start a second session (in your working copy) and run `/sub-human YOURNAME otter-4821`. The host is a member like anyone else.
3. Share the code with the others on this machine.

The orchestrator enters plan mode itself when the room is ready to draft. It never uses Bash, so it shouldn't raise permission prompts in its unattended window.

## Joining

```
/sub-human NAME CODE
```

The command shows as `/sub-human:sub-human` in the picker and transcript; typing the bare `/sub-human` works. A join hook binds `NAME` to your session before the model sees anything, so the model can never pick or change your name. A name that is already in the room is refused. Your identity survives `/clear` and compaction.

Room notices reach your session through the plugin's `room` monitor, so even an idle session wakes up for them. Your Claude surfaces each one in a line and acts only when you are addressed or when you ask.

## Saying something to the room: `@room`

```
@room I'd rather keep the cursor opaque; page numbers break under inserts.
room: same thing, with no @ picker
```

A prompt starting with `@room ` or `room:` is posted **verbatim** as your words (`via=human`) by a hook, and the prompt is blocked, so no model turn runs and nothing is paraphrased. Your Claude learns of it on your next prompt.

- Trailing spaces are trimmed by the terminal UI; leading and internal spaces, unicode, `$`, backticks and quotes arrive byte-exact.
- Multiline: `\` + Enter or Ctrl+J inserts a newline.
- Long pastes are unwrapped from Claude Code's `<pasted_content>` wrapper. Pasted tabs become 4 spaces, and the entry is marked `normalized:true`.
- Typing `@room` opens the file picker; a space closes it. Don't press Tab, which completes a file name. `room:` avoids the picker entirely.

Anything else you type goes to your own Claude. When it posts to the room, the post is labelled "NAME's Claude" (`via=agent`) and never counts as your words or your consent.

## Approving the plan

The orchestrator writes a plan file whose first lines are:

```
---
sub-human: {"room":"otter-4821","approval":"all","approvers":["alice","bob"]}
---
```

`approval: "all"` means every approver must sign, and `approvers` must name every joined member; the gate refuses a plan that leaves anyone out. When the orchestrator calls ExitPlanMode, a hook publishes the plan to the room as `plan_rev` with its hash, then denies the exit and names everyone who hasn't signed.

In each member's session, the member's Claude enters plan mode, writes a one-line stub and calls ExitPlanMode. A hook swaps in the room's exact plan text, so **the native dialog shows the canonical plan**, not something your Claude wrote.

| You do | Recorded |
|---|---|
| Approve (manual approval) | `signoff via=human` against that plan hash. Your Claude is told not to implement; it waits for an assignment. |
| Edit with Ctrl+G, then approve | `objection via=human` with your edited text. No sign-off. |
| "Tell Claude what to change" + feedback | `objection via=human` with your feedback. |
| Esc | Nothing. |

Any revision of the plan has a new hash and voids every sign-off. Once every approver has signed the current hash, the orchestrator's ExitPlanMode goes through with no dialog, and a hook writes the `decision` with references to each sign-off. The orchestrator then posts assignments: owners, files, contracts and what "done" means.

Review in default permission mode. A review is refused in bypass or auto mode, and while `showClearContextOnPlanAccept` is on: that "clear context" approval starts a new session that implements immediately and records no sign-off. Choose plain manual approval.

## Room storage

Rooms live in `~/.sub-human/rooms/<CODE>/`, or under `$SUB_HUMAN_HOME` if set. Each room has an append-only JSON-lines log in which every entry carries `from`, `via` (`human`, `agent` or `system`), `kind`, and a `prev` hash of the previous line, so tampering is visible. Canonical plans are stored alongside it by hash. The `sub-human` CLI in `bin/` offers read-only `read`, `digest`, `who`, `watch` and `tail`; nothing writes the log except the plugin's MCP tools and hooks.

## Threat model

Everyone runs as the same OS user on the same machine. Identity is bound by hooks and resolved from process ancestry, and a guard hook denies other tools' writes into `~/.sub-human`. This prevents **accidental** misattribution: one person's Claude posting as someone else, a model inventing a sign-off, a paraphrase passing as someone's words. It does **not** stop a hostile local user, who can write the files directly. The hash chain makes such edits visible; it doesn't prevent them.

## Limits

- **Same machine only.** All sessions must share the room directory. A network relay is future work.
- Agent posts are rate-limited (6 per minute per member) to stop Claudes waking each other in a loop.

## Leaving

`/exit` in a session with the room monitor running asks "Background work is running…" with three options. Choose **1, "Exit and stop tasks"**: the monitor stops and the room records `member_left`. `/clear` does not leave the room.
