# Quiet: sub-human's output and experience

Status: plan, 2026-11-02, cut down the same day. Nothing in it is built yet.

**Goal** (the owner's north star): people use Claude in a room exactly as they do in Claude Code. The only difference is another person. They choose how closely they work, and neither holds the other back.

**This plan's job:** make sub-human quiet and native. It does that by removing what it adds, not by adding features. Three priorities: handle it behind the scenes, feel native, don't overshare.

Research and evidence are in `docs/next/quiet/`:
- PRINCIPLES
- EVALUATION, a recorded scene: 68 sub-human lines against a target of about 24
- SURFACES
- REVIEW
- PRESENCE
- COPY, which holds the full string inventory and style guide
- ROOM-ROW-SPIKE
- GOAL-REVIEW

## Rules every change follows

1. **Native first.** If Claude Code already does it, sub-human doesn't build it. Claude-to-Claude coordination is native `SendMessage`, so it gets no plugin lines and no plugin features. The receiving Claude decides whether to tell its person.
2. **Silence is success.** Receipts, retries, restores and link drops are never shown. They go to Claude Code's own debug log, `$.ui.log(…, {to:'debug'})`, which is read with `claude --debug`.
3. **Claude's text stays Claude's.** Instructions for the model travel as context, never as drawn prompt lines, red deny reasons or hex ids.
4. **Ceremony never interrupts.** Plan reviews, receipts and mode changes never start a turn mid-task or change someone's mode. Another person's Claude may wake yours: that's the collaboration.
5. **One line per event, in plain words.** Errors take the form `<what didn't happen>. <one action>.`

## 0.6.0: words and the guard. Plugin-only, stable surfaces

**Scope: the lines people saw in the recorded scene (EVALUATION's ledger), not all 1,165 strings.**

- **Canonical lines** (COPY §3.1, only the moments in the ledger):
  - `Opened panda-0976`, `Joined panda-0976 with maya`, `Left panda-0976`;
  - `Plan paging v1 is ready · maya's edit`, `Plan paging v1 · dev asked for changes: "…"`, `Plan paging v2 agreed`;
  - `New task for you: …`.

  It's always the room's plan, never "maya's plan".
- **Delete; the debug log gets them:**
  - `✓ sent`;
  - `row closed`;
  - the hint suffixes on open, join and leave;
  - `restoring this session's rows`;
  - `Claude Code X isn't verified`;
  - the bypass-mode warning;
  - link down and back;
  - the delivery error when nothing was lost;
  - the `room:` second speaker.
- **Claude's text stays Claude's:**
  - Wake prompts carry their state as context (`lib/tail.ts:351`), and a busy-turn wake is resent as context only (`mod/deliver.ts:476,756`).
  - Review denies put their text in `context`, not the red reason.
  - Delete the false "the mode is restored".
  - Tool descriptions open with one plain sentence, and `read` gets `readOnlyHint`. No parameter renames.
- **No echoes.** The skill and TAKE_CONTEXT say "end your turn without text" (`SKILL.md:14`).
- **Readable plan names:**
  - from the first heading, not `room`;
  - slugified, not refused;
  - the plan's label in place of the hex stub.
- **Help in 6 lines.** The rest goes in the README. The argument hint becomes `[invite | leave | help]`.
- **Invite in one line,** plus `Copy the invite?`. Rules, install and ssh notes go to the README.
- **Leave in one line,** with the agreed card:
  - The card is `Left <code>.`, with Done / ★ Star sub-human and the native free-text row.
  - At most two cards per install.
  - `/rename` becomes a silent `sessionTitle`.
- **Hooks are silent on success.** No stderr unless something failed.
- **The guard stays out of the way (#35):**
  - Match the person-only commands only in tool position.
  - Allow `mktemp -d` and Claude Code's `tool-results`.
  - Each deny names the alternative.
- **In the same commits,** the copy that code depends on (COPY §3.3), and the small bugs: the "typed your PIN" bug (`lib/cli/host.ts:135`), and the lock path and raw `claude --bg` errors shown to people.

## 0.7.0: plan mode made right, one quiet room row. Early-access surfaces behind contract entries

**The room's plan in plan mode** (D3). Closes #34, #21 and #9:
- **The plan text carries the frame.** Its first line is `Room plan · paging v2 · Yes agrees · Tell Claude what to change asks for changes`.
- **The mode survives (#34).** Send/Discard comes first, while still in plan mode, then one exit with a non-empty plan, and "No" keeps the note. Spike 1 comes first.
- **`ui.render` hides:**
  - the save's red `Error:`;
  - the false `Entered plan mode` while only reviewing;
  - the hex `User rejected Claude's plan`.

  If spike 2 shows the "Ready to code?" title can be redrawn, it becomes `Room plan · paging v2`.
- **One plan file per plan.**

**One room row** (D1):
- Delete the participant rows (`agents/participant.md` and the nested-row bookkeeping). Each session has one row, so about 7k tokens instead of 7k × (N+1).
- Spawn it from the module (`$.agent.spawn`), so there's no `Backgrounded agent` block, no hand-back turns and no `row closed`.
- **Its label is the presence:** `panda-0976 · maya, dev · dev building http: GET /tasks`. It comes from the plugin's own `settings.json` `subagentStatusLine`, with no edit by the person, and disappears when the room ends.
- `ui.render` redraws `Waiting for N background agents` while the room row is the only pending work.
- Filter member `claude` out of every list of people. Mark task #1 internal, if spike 3 allows. Reap the room's `claude --bg` session on close.

**Verify:** re-run the two-person scene, plus one scene with no plan: a pair who just talk and build. Pass when each person sees 6 lines or fewer, with no red `Error:`, no mode change, no `Waiting for…`, no stale label and no text written for Claude.

## Moved out of this plan

| Cut | Why |
|---|---|
| A sub-human log file, rotation, `/sub-human debug`, doctor's "Recent problems" | Claude Code's `--debug` log is native and free. Revisit only if `--debug` proves too hard to use for bug reports. |
| Tier helpers, the line-budget ratchet | Process, not product. Re-running the scene checks the budget. |
| Parameter renames with aliases, help topics | Compatibility code for little gain. A plain first sentence and the README do the job. |
| The review band, footer presence, toasts, notifications | More surfaces. The plan view and the room row's label cover arrival and presence. |
| **Chat, DMs and "how's it going" inside the room row** | Its own plan later (`quiet/ROOM-ROW-SPIKE.md` has the mechanism). Today `@room` posts. "How's maya doing?" asked of your own Claude already works natively: it messages hers. The provenance question (answered steps recorded as model-written) needs a ruling first. |
| File and branch sync tracking | Native `SendMessage` between the Claudes already keeps layers in sync. |
| Pairing tools (watch or steer the other Claude) | A real gap for the close end, but a feature, not quieting. It's a candidate for the next plan. |

## Spikes before 0.7.0

1. Does closing plan mode with a non-empty plan, after Send/Discard, keep auto mode?
2. Can `ui.render` redraw the ExitPlanMode title?
3. Does marking task #1 `_internal` interfere with the 5-second auto-reset?

## Design rules (CLAUDE.md)

All of them hold. When 0.7.0 ships, "a member's panel shows the room row with the members inside it" becomes "one room row whose label names the members". The `subagentStatusLine` goes in the plugin's own `settings.json`, never the person's.
