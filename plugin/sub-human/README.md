# sub-human

A Claude Code plugin for planning together from separate sessions. One session becomes the room's **orchestrator**: an unattended Claude that facilitates, writes the shared plan and splits the work. Everyone else, the host included, **joins** from their own normal Claude Code session and keeps their own Claude. Each member approves the room's plan in Claude Code's **native plan-approval dialog**, and the orchestrator's plan goes through only when every member has signed the exact same plan.

Nothing replaces Claude Code: tests, status and "done" are ordinary Claude Code work. The plugin adds a room log, a join command, an `@room` prefix, and hooks that bind identity and gate plan approval.

## Install

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

### Settings for the status line and the room feed

A plugin can't set the main status line or the agent-panel rows, so pass them yourself with `--settings`. That flag adds a settings layer for this launch only and leaves `~/.claude/settings.json` alone. From the repo root:

```
cat > /tmp/sub-human-settings.json <<EOF
{
  "statusLine":         { "type": "command", "command": "$PWD/plugin/sub-human/bin/sub-human statusline", "refreshInterval": 5 },
  "subagentStatusLine": { "type": "command", "command": "$PWD/plugin/sub-human/bin/sub-human agent-statusline" }
}
EOF
```

- `statusLine` shows the room on your status bar (see [Status bar](#status-bar)).
- `subagentStatusLine` replaces the room-feed agent's row in the agent panel with the same room summary. Other agents' rows stay as they are.
- Optional: add `"showTurnDuration": false` to hide the "✻ Waiting for 1 background agent to finish" line (see [The room feed](#the-room-feed)). It also hides "Worked for 12s".

## Try it

Three terminal windows on one machine, all in this repo. Create `/tmp/sub-human-settings.json` first (above).

1. **Window 1, the orchestrator.** Run `claude --plugin-dir plugin/sub-human --settings /tmp/sub-human-settings.json`, then type `/sub-human` and press Enter twice (the first Enter accepts the picker's completion). It prints an invite code such as `otter-4821`. Don't type in this window again.
2. **Window 2, alice.** Run the same `claude` command, then `/sub-human alice otter-4821`. Her Claude starts the room feed in the background.
3. **Window 3, bob.** The same, with `/sub-human bob otter-4821`.
4. **Talk.** In alice's window: `@room let's add retries to the fetcher, 3 attempts with backoff`. She sees `✓ posted to otter-4821 as #3`, and bob's window and the orchestrator get the notice. In bob's: `@room fine, but cap the total wait at 10s`.
5. **Plan.** The orchestrator drafts a plan and publishes it. Each approver's Claude says `plan <hash> is ready — say 'review'`. In each approver's window, type `review` and choose **"2. Yes, manually approve edits"**. To block it instead, choose "Tell Claude what to change" and say why.
6. **Decide and work.** When every approver has signed, the orchestrator records the decision and posts assignments. Tell your Claude `go`. It posts a `status`, does the work in a background subagent, and posts a `status` with the result when it's done.

To watch the whole log in a fourth window, run `plugin/sub-human/bin/sub-human watch otter-4821`.

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

### The room feed

Right after you join, your Claude starts the room feed: a background agent (`sub-human:room`, on Haiku) whose transcript mirrors the room log. Open it from the agent panel (↓ to manage) to read the room as it happens. It runs for your whole session and stops when you leave.

While it runs, Claude Code shows **"✻ Waiting for 1 background agent to finish"** after each turn, where it would otherwise show "Worked for 12s". That's normal. Your prompt is free: type, use `@room` and work as usual. No agent setting removes the line. `"showTurnDuration": false` in your settings hides it, together with the "Worked for" line.

Joining doesn't make you an approver. The orchestrator chooses the approvers for each plan: anyone who asks, and anyone who contributed substantively. To be one, say so in the room (`@room I want to approve this`). Anyone can block a plan by objecting to it: any human objection on the current plan blocks it, whether or not you're an approver.

When the room is waiting on you, the plugin alerts **you**, not just your Claude. See [Alerts](#alerts) and [Status bar](#status-bar).

## Saying something to the room: `@room`

```
@room I'd rather keep the cursor opaque; page numbers break under inserts.
room: same thing, with no @ picker
```

A prompt starting with `@room ` or `room:` is posted **verbatim** as your words (`via=human`) by a hook, and the prompt is blocked, so no model turn runs and nothing is paraphrased. The receipt looks like this:

```
⏺ UserPromptSubmit operation blocked by hook:
  ✓ posted to otter-4821 as #17
```

The first line is Claude Code's wording for any prompt a hook handles, and a plugin can't change it. The post went through; "blocked" only means your Claude didn't get a turn. A post that failed reads `✗ not posted: …` with the reason.

Your Claude learns of your posts at its next turn (your next prompt, or the next room notice), as "Your human posted #17 to the room: …".

- Trailing spaces are trimmed by the terminal UI; leading and internal spaces, unicode, `$`, backticks and quotes arrive byte-exact.
- Multiline: `\` + Enter or Ctrl+J inserts a newline.
- Long pastes are unwrapped from Claude Code's `<pasted_content>` wrapper. Pasted tabs become 4 spaces, and the entry is marked `normalized:true`.
- Typing `@room` opens the file picker; a space closes it. Don't press Tab, which completes a file name. `room:` avoids the picker entirely.
- Check prompt suggestions before you accept one. A suggested `@room …` line is your Claude's wording, and accepting it posts it as yours.

Anything else you type goes to your own Claude. When it posts to the room, the post is labelled "NAME's Claude" (`via=agent`) and never counts as your words or your consent.

## Approving the plan

The orchestrator writes a plan file whose first lines are:

```
---
sub-human: {"room":"otter-4821","approval":"all","approvers":["alice","bob"]}
---
> **Room plan — approving this is your sign-off for the room. Your Claude will not run it. Choose "2. Yes, manually approve edits".**
```

The line after the frontmatter is fixed (`PLAN_NOTICE` in `lib/plan.js`); the gate denies a plan that doesn't start with it. It's there because the native dialog says "ready to execute", and approving a room plan only records your sign-off.

`approval: "all"` means every approver must sign. The gate enforces exactly the `approvers` in the frontmatter, which the orchestrator chooses for each plan. When the orchestrator calls ExitPlanMode, a hook publishes the plan to the room as `plan_rev` with its hash, then denies the exit and names everyone who hasn't signed. Any human objection on that hash, from anyone, also keeps it blocked.

When a plan is published, your Claude says `plan <hash> is ready — say 'review'`. It opens the dialog only when you ask, so it doesn't interrupt you mid-task. Then it enters plan mode, writes a one-line stub and calls ExitPlanMode. A hook swaps in the room's exact plan text, so **the native dialog shows the canonical plan**, not something your Claude wrote.

Choose **"2. Yes, manually approve edits"**. Option 1 also records your sign-off, but it switches your session into auto mode, which you then have to leave with Shift+Tab (see the table).

| You do | Recorded |
|---|---|
| Approve with "2. Yes, manually approve edits" | `signoff via=human` against that plan hash. Your Claude is told not to implement; it waits for an assignment. |
| Approve with auto mode | The sign-off still counts. Your Claude is told not to act, and you're told to press Shift+Tab to get back out of auto mode. |
| Edit with Ctrl+G, then approve | `objection via=human` with your edited text. No sign-off. |
| "Tell Claude what to change" + feedback | `objection via=human` with your feedback. |
| Esc | Nothing. |

Any revision of the plan has a new hash and voids every sign-off. Once every approver has signed the current hash, the orchestrator's ExitPlanMode goes through with no dialog, and a hook writes the `decision` with references to each sign-off. The orchestrator then posts assignments: owners, files, contracts and what "done" means.

Review in default permission mode. A review is refused in bypass or auto mode, and while `showClearContextOnPlanAccept` is on: that "clear context" approval starts a new session that implements immediately and records no sign-off. Choose plain manual approval.

## Doing the work

The plugin adds nothing to how work runs: it is ordinary Claude Code work. When you say go on an assignment, your Claude posts a short `status` ("starting X in the background") and runs anything longer than a couple of minutes in one of Claude Code's own background subagents, so your session stays free. You can watch it in your agent panel. When it finishes, your Claude posts a `status` to the room with the result and the evidence it saw: test counts, a commit, a path. It never reports a result it didn't see.

Shared jobs that belong to nobody (run the whole suite, check that two parts fit) go to the orchestrator. It runs them in its own background subagent and posts the `status` itself. Nobody can approve permission prompts in the orchestrator's window, so a step that needs one comes back to a member.

## Alerts

The `room` monitor (`sub-human tail`) alerts you directly when:

- **your sign-off is needed**: a plan is published that names you in `approvers`, and you haven't signed it. At most one alert per plan hash.
- **an entry is addressed to you** (`to` is your name). At most one alert every 30 seconds.

An alert is a macOS notification ("sub-human", via `osascript display notification`) plus a terminal bell on your Claude Code window. Both are best-effort.

- The notification targets no app, so it raises no Automation permission prompt. Whether it appears depends on **System Settings › Notifications › Script Editor**.
- The bell is written to the terminal of your `claude` process. The monitor itself has no controlling terminal.
- The orchestrator never alerts. Entries more than 10 minutes old (a monitor catching up) never alert.

To turn alerts off, set `SUB_HUMAN_NOTIFY=0` in the environment you start `claude` from.

## Status bar

`sub-human statusline` shows the room in Claude Code's status line, so you can always see it:

```
⬡ dingo-8953 · tristan · plan b7ca39 2/3 · approver
⬡ dingo-8953 · tristan · ⚠ your sign-off needed (plan b7ca39 1/3) · ✉ 1 for you
⬡ dingo-8953 · orch · plan b7ca39 2/3 ✖ 1 objection waiting on bob
⬡ dingo-8953 · tristan · plan b7ca39 3/3 ✔ · approver
```

- `⚠ your sign-off needed` (bold yellow) means the current plan names you as an approver, you haven't signed, and there's no decision yet.
- `✉ N for you` counts entries addressed to you since you last spoke in the room.
- `✔` means the plan is decided.
- Outside a room it prints nothing, so it's safe to use as your global status line.

A plugin can't set the main status line. Pass it with `--settings` as in [Settings](#settings-for-the-status-line-and-the-room-feed), or put the same `statusLine` block in `~/.claude/settings.json` (all projects) or a project's `.claude/settings.json` yourself, with the absolute path of this plugin.

`refreshInterval` is optional. Without it, the bar updates only on session events, which go quiet while you're idle. The command finds your room by `session_id`, falling back to process ancestry. It reads one session index, `members.json` and the room log. Set `NO_COLOR=1` for plain text. If you already have a status line, call `sub-human statusline` from your script and append its output.

The segments are a list in `statusline/segments.js` (`room`, `seat`, `plan`, `approver`, `mail`). Add a field by adding a segment.

## Room storage

Rooms live in `~/.sub-human/rooms/<CODE>/`, or under `$SUB_HUMAN_HOME` if set. Each room has an append-only JSON-lines log in which every entry carries `from`, `via` (`human`, `agent` or `system`), `kind`, and a `prev` hash of the previous line, so tampering is visible. Canonical plans are stored alongside it by hash. The `sub-human` CLI in `bin/` offers read-only `read`, `digest`, `who`, `watch`, `tail`, `statusline` and `agent-statusline`; nothing writes the log except the plugin's MCP tools and hooks.

## Threat model

Everyone runs as the same OS user on the same machine. Identity is bound by hooks and resolved from process ancestry, and a guard hook denies other tools' writes into `~/.sub-human`. This prevents **accidental** misattribution: one person's Claude posting as someone else, a model inventing a sign-off, a paraphrase passing as someone's words. It does **not** stop a hostile local user, who can write the files directly. The hash chain makes such edits visible; it doesn't prevent them.

## Limits

- **Same machine only.** All sessions must share the room directory. A network relay is future work.
- Agent posts are rate-limited (6 per minute per member) to stop Claudes waking each other in a loop.

## Leaving

`/exit` in a session with the room monitor running asks "Background work is running…" with three options. Choose **1, "Exit and stop tasks"**: the monitor stops and the room records `member_left`. `/clear` does not leave the room.
