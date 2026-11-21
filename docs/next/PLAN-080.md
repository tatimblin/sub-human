# 0.8.0: the room row is the group chat, and your Claude is your assistant

Implements PLAN-SMOOTH.md 0.8.0. Branch `row-080`, worktree `~/repos/sub-human-row`, cut from `plan-070`; it is rebased onto master once 0.7.0 merges. The mechanism comes from `quiet/ROOM-ROW-SPIKE.md`, checked on Claude Code 2.1.296, which is still the installed and probed version.

What a person sees after it:
- **Main is yours:** you and your Claude. Room lines stop appearing in main; your Claude still reads them.
- **The room row is the group chat.** Go into the row (↓, Enter) and type. Your exact words go to the room, and incoming lines are drawn there with who said them: `maya: …` or `maya's Claude: …`.
- **You message people.** `maya, …` or `@maya …` reaches maya. Her Claude answers for her when it's sure (a fact: her branch, whether tests pass), labelled `maya's Claude:`. Otherwise it leaves the message for her.
- **A question that names nobody** is answered by your own Claude in the row when it can. Anyone may chime in, and no other Claude is woken.
- **Something left for you** waits in the row, with an unread count on the row's label. Main gets one line only when your Claude judges it time-sensitive.
- **A plan made in the row is a room plan.** Your main Claude drafts it, it opens in your plan view first, and your Yes sends it to the room. Plain plan mode in main stays personal.
- `@room` in main still works.

## Phase 0: spikes (each a throwaway probe plugin on 2.1.296 with the mock API; results go in ROOM-ROW-SPIKE.md)
The spike proved the core: words arrive via `session.append`, `turn.step` answers without a model, and the keeper child keeps main from waking. Still unproven:
1. **Lifecycle.**
   - Esc and `x` inside the row.
   - The keeper dying (the next stop wakes main): can the room's next step respawn it quietly?
   - `--resume`, `--continue`, `/clear` and compaction, with the row coming back (0.6.0 already respawns the hold-row).
2. **Auto mode.** 0.6.0 found that the classifier denies a module's `$.agent.spawn`. Does it also deny the keeper's `Agent` call made from a synthesized `turn.step` of the row? If it does, find the fallback (the spawn made by main's Claude, as in 0.6.0, and the keeper the same way).
3. **Plan mode inside a row.** Does a subagent's EnterPlanMode / ExitPlanMode draw its plan view in the row's view, and does consent's PreToolUse see it (`agent_id`)? If not, the row hands the drafting to main (the default below) and only shows the result.
4. **A wake mid-task.** maya's Claude is busy when a message names her. Confirm it is delivered at its next turn boundary, not by interrupting.
5. **Provenance.** Synthesized steps are recorded as `origin: model`. Check whether `ui.render AssistantMessage` can mark them as plugin lines in the drawn view. Every line carries its author prefix regardless.
6. **The label of an idle row.** Since 0.6.0 the row's label is its hold's progress text. The plugin sets no `subagentStatusLine` (CLAUDE.md: it would override the person's own). An idle row holds nothing, so try these in order:
   1. the keeper's hold progress drawn as the room row's label;
   2. the row's `description` updated by the module;
   3. a synthesized step's text, which the summarizer then repeats.

   The keeper's own nested row must draw as nothing, or the panel shows two rows (the 0.6.0 rule: one room row, nothing nested).

Each surface the design relies on gets a contract entry (search string, `feature: room-chat`, a new gated feature) before Phase 1 uses it.
- **Fallback while `room-chat` is off:** today's hold-row, labelled `type in main with @room`.

## Phase 1: the row takes typing and draws the room
- `sub-human:room` becomes idle and resumable.
  - Its first synthesized step spawns `sub-human:keeper` (background), which does the blocking `hold` with no tick.
  - The room then ends its turn.
  - The participant agent is already gone (0.6.0).
- Typed input (`session.append`, door `prompt`, origin `composer`) is unwrapped and posted verbatim (`via=human`, signed). Signing happens in the module, which has no seat key, so it goes through node (the same signer path as `@room`). The step answers `✓` or nothing (no echo: the `❯` row is the person's words).
- Incoming lines are drawn with `$.session.send` to the row plus a synthesized step that shows the line with its author. The `❯` echo is hidden (`ui.render UserMessage`, origin `coordinator`), and so is the chrome (spawn prompt, keeper rows, `TurnDuration`, main's "Waiting for 2 background agents").
- The label leads with who's here, then the unread count (`maya, dev · 2 new`). Its source is spike 6.

## Phase 2: your Claude is your assistant
- **A line naming a person** (`NAME, …`, `@NAME`) wakes that person's main Claude with the line, and one `member.md` rule: answer as `NAME's Claude` when you're sure of the fact, else leave it for NAME. Its answer is posted to the room as `NAME's Claude: …` and drawn in the row.
- **An untagged question** wakes only the asker's own Claude. It answers in the row if it can, and it may ask other Claudes natively (SendMessage, unseen). Otherwise it says nothing.
- **A line that isn't a question** wakes no Claude. Each Claude gets it as context. The asker's Claude judges which is which, from the words only.
- What a Claude answers is steered by its person in plain words ("handle questions for me"), never a setting.
- Unread: a line left for you counts on your label until you open the row. Main gets one line only when your Claude judges it time-sensitive.

## Phase 3: room lines leave main
- `lib/room/deliver.ts`: a person's `notice` lane is drawn in the row, not as `$.ui.log` in main. Context for Claude is unchanged.
- Kept in main:
  - your own review (the plan view is main's);
  - your Claude's time-sensitive line;
  - the 0.6.1 invite dialogs.
- `@room` in main still posts. Its receipt stays one line.

## Phase 4: plans made in the row are room plans
- `plan …` typed in the row (or "let's plan X", judged by your Claude) hands the drafting to your main Claude: a wake with the request.
- Main's Claude writes it with the plan tool (0.7.0 one-call edit), and your check opens in your plan view as now.
- If spike 3 shows plan mode works inside the row, the check could open there instead. That would be a follow-up, not 0.8.0.

## Phase 5: release
- README (the row, talking to people, assistants), ARCHITECTURE, CHANGELOG, version 0.8.0.
- **Wire protocol:** no change expected (posts, answers and wakes already exist), but check whether an assistant answer needs a marker beyond `via=agent` + `for`.
- **Demo:** a new scene in which B types in the row, A's Claude answers a factual question as `A's Claude`, and A answers an opinion question himself. Checks: no model step in the row, no main line for a non-urgent message, and the unread count.
- **Gate:** the three modes, plus the new scene.

## Decisions for the owner
1. **Where an assistant answer runs.** When a message names maya, her **main** Claude answers it: it has her context, so the answer is right. That takes a turn in her main session, visible there as a short exchange. The alternative is a background fork of her session that answers out of sight. Recommended: main, with the wake one quiet line, because a hidden fork answering in her name is the thing to avoid.
2. **Provenance.** The transcript credits synthesized row lines to the model (`origin: model`). Recommended: accept it, with every drawn line carrying its real author (`maya:`, `maya's Claude:`), and say so in the README. The alternative is to wait for a plugin-origin step from Claude Code.
3. **Desktop, VS Code and Remote Control can't type into a row** (`send_task_message` is unsupported). Recommended: the row there is read-only with its label, and `@room` is the way to talk. Fine for 0.8.0?

## Order and size
Phase 0 first: each spike can change the phases after it. Then 1, 2, 3, 4. Phase 1 alone is shippable as 0.8.0-beta (the row as a chat for people, no assistants yet) if 2 slips.
