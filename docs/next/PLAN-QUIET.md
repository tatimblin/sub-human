# Quiet: sub-human's output and experience

Status: built, 2026-11-03, as one release, **0.6.0** (unreleased, untagged). It was planned as two (0.6.0 and 0.7.0); 0.6.0 never shipped, so both are in 0.6.0. What is left is the live re-run of the scenes (0.6.0 part two, item 6).

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

## 0.6.0, part one: words and the guard. Plugin-only, stable surfaces. **Done**

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

## 0.6.0, part two (planned as 0.7.0): plan mode made right, one quiet room row. Trimmed after review (2026-11-02, quiet/WORTH.md)

**In:**
1. **Done.** **#34, mode survival** (quiet/SPIKES.md, spike 1). It's a careful, separate commit, because it touches consent. A note or an agreement must never be lost. Gated: `keep-mode` (contract `exitplan-keep-auto`, `module-ask-through-hooks`).
   - Send/Discard (`$.ui.ask`) comes first, while still in plan mode.
   - The exit then depends on the mode the person had **before** the review:
     - **Auto:** overwrite the plan file with one closing line (`Your note went to maya. Nothing to build.`), then exit with a non-empty plan. "Yes, and use auto mode" is preselected, so Enter keeps auto.
     - **Manual:** exit with an empty plan. "Yes, and switch to default" keeps manual, and the model gets a neutral "approved exiting plan mode".
     - **Accept-edits:** no exit keeps it. Use the empty exit, plus one line: `shift+tab returns you to accept edits`.
   - Hide the resulting "User approved Claude's plan" row (item 3). Claude's context says plainly that nothing is to be built.
2. **Done.** **One room row:** (gated: `room-row`, contract `module-agent-spawn-quiet`, `agent-offer-hides-type`; the module also spawns the row right after a restore, so a resume needs no prompt)
   - Delete the participant rows (`agents/participant.md` and the nested-row bookkeeping).
   - Spawn the room row from the module (`$.agent.spawn`): no `Backgrounded agent` block, no hand-back turns, no `row closed`.
   - Test the row's lifecycle: resume, `/clear`, compaction, the row dying, and leave.
3. **Done.** **A small `ui.render` pass:** (gated: `quiet-plan`)
   - hide the save's red `Error:` (#9), unless an empty deny reason already draws nothing;
   - hide the false `Entered plan mode` while only reviewing, and the `User rejected / approved Claude's plan` rows that a review produces (spike 2: all of these work, including rows already on screen, after `$.ui.invalidate`).
4. **Done.** **Cheap and safe:** (task #1 `_internal` gated `task-internal`, the reap gated `reap-rm`)
   - the plan text's frame line;
   - filter member `claude` from every list of people;
   - mark task #1 `metadata._internal` and keep it in progress until close. Spike 3, tested live: the 5-second auto-reset re-reads every task, `_internal` included, so it still holds the list. Also keep task #1 out of sub-human's own lists;
   - reap the room's `claude --bg` session on close.
5. **Skipped.** **Optional, behind a gate:** redraw `Waiting for N background agents` only when the room row is certainly the only pending work, so real `Baked for Ns` lines never disappear. Not small and not certain: `TurnDuration` carries no agent count, and a wrong redraw hides a real line. With one room row it now reads `Waiting for 1 background agent`; the README says so.
6. **Remaining (live).** **Verify:** re-run the two-person scene plus a no-plan pairing scene. The unit, script and wiring tests, lint and `npm run probe` pass; the live scenes (real sessions, real cost) are not run yet. Pass criteria:
   - 6 lines or fewer per person;
   - no red `Error:` on save;
   - no mode change on an objection;
   - one row per session;
   - no text written for Claude.

**Out (blocked or not worth it):**
- **The row label as presence:** the plugin directory refuses a computed command path, and `${CLAUDE_PLUGIN_ROOT}` isn't expanded. Ask Claude Code instead.
- **One plan file per plan:** Claude Code picks the file.
- **Redrawing the "Ready to code?" title:** spike 2 shows it can't be done; the engine alone draws that dialog. The plan's first line carries the frame instead. Ask Claude Code for a title.

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

## Spikes before part two (done: quiet/SPIKES.md)

1. Does closing plan mode with a non-empty plan, after Send/Discard, keep auto mode?
   - **If no:** keep the Send/Discard-first order, which still fixes the unsent note. Put one line in the plan's heading: `Asking for changes returns you to default mode; shift+tab restores yours`. Then ask Claude Code for a way to keep the mode.
2. Can `ui.render` redraw the ExitPlanMode title?
   - **If no:** the plan's heading line carries the frame. The title goes to Claude Code as a request.
3. Does marking task #1 `_internal` interfere with the 5-second auto-reset?
   - **If yes:** leave task #1 as it is, and filter it only from sub-human's own lists.

## Design rules (CLAUDE.md)

All of them hold. The rule "a member's panel shows the room row with the members inside it" now reads "one room row whose label names the members" (done in CLAUDE.md). The `subagentStatusLine` goes in the plugin's own `settings.json`, never the person's.
