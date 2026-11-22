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
3. **Plan mode inside a row.** Does a subagent's EnterPlanMode / ExitPlanMode draw its plan view in the row's view, and does consent's PreToolUse see it (`agent_id`)? Answered: no (results below).
4. **A wake mid-task.** maya's Claude is busy when a message names her. Confirm it is delivered at its next turn boundary, not by interrupting.
5. **Provenance.** Synthesized steps are recorded as `origin: model`. Check whether `ui.render AssistantMessage` can mark them as plugin lines in the drawn view. Every line carries its author prefix regardless.
6. **The label of an idle row.** Since 0.6.0 the row's label is its hold's progress text. The plugin sets no `subagentStatusLine` (CLAUDE.md: it would override the person's own). An idle row holds nothing, so try these in order:
   1. the keeper's hold progress drawn as the room row's label;
   2. the row's `description` updated by the module;
   3. a synthesized step's text, which the summarizer then repeats.

   The keeper's own nested row must draw as nothing, or the panel shows two rows (the 0.6.0 rule: one room row, nothing nested).

Each surface the design relies on gets a contract entry (search string, `feature: room-chat`, a new gated feature) before Phase 1 uses it.
- **Fallback while `room-chat` is off:** today's hold-row, labelled `type in main with @room`.

**Results of spikes 1, 2 and 6** (2026-11-21, ROOM-ROW-SPIKE.md "0.8.0 spikes"):
- **Lifecycle holds.**
  - The keeper respawns with no model call.
  - The row survives `/compact`, and comes back after `--resume` by sending to the stored id.
  - Esc or `x` stops it, and typing revives it.
  - `/clear` re-lists it as `general-purpose (resumed)`, so on `/clear` the old row ends and a new one is spawned.
- **Auto mode.** The module's spawn is allowed: only `autoMode` soft or hard deny rules refuse it, so the `auto-mode-module-spawn-deny` entry is reworded. The keeper needs extra steps:
  - its `Agent` call from a synthesized step is denied, so it is made by the room's model, one small call per spawn;
  - its synthesized `hold` is denied without an allow rule, so it is a model step too;
  - respawns are hard-capped (an unchecked loop made about 200 calls in 25 s).
- **The label.** An idle row's label is fixed at spawn (`name` + `description`) and nothing can update it; the keeper shows as `(+1)` and can't be hidden.

### Phase 1 changes from the spikes
- `sub-human:room` and `sub-human:keeper` stay offered to the model: hiding them breaks the resume. Main's model is kept from spawning them with a fixed `tool.call` deny, except in the auto fallback.
- Row steps are answered by the stored agent id, not by type. The id is persisted per session so a resume sends to it before spawning anew. The spawn's `name` is the room code.
- **Label (owner decision 1A):** the row reads the room code. Who's here and the unread count go on one `$.ui.status` line under main's prompt: `panda-0976 · maya, dev here · 2 new`.
- **`(+1)`:** the owner doesn't want it. The plugin can't hide it, so it goes in a Claude Code request (a hook to draw or hide panel rows) and stays until then. The other keeper (a background shell) has no `(+1)`, but it draws a blank row in main per room stop, so it is not used.

**Results of spikes 3, 4 and 5** (2026-11-21, ROOM-ROW-SPIKE.md "0.8.0 spikes (Phase 0: 3, 4, 5)"):
- **Plan mode in a row: no.** EnterPlanMode, ExitPlanMode and AskUserQuestion are refused to every subagent, no hook fires, and no dialog draws. A row also has no mode of its own: shift+tab there changes main's. So row plans are drafted by main (Phase 4), and any question the row needs comes from main.
- **A wake reaching a busy Claude.** The real plugin's mid-turn path (`$.session.append`) is read inside the running turn at the next tool boundary: mid-task, and drawn nowhere. `$.prompt.submit` queues the wake until the turn ends and draws `› Prompt from the sub-human plugin` at once. So Phase 2's naming wakes go by `$.prompt.submit`, even mid-turn, and the append stays for context-only lines.
- **Provenance.** Synthesized rows are marked in the transcript (`answeredWithoutRequest: true`, `msg_hook_` ids, zero usage) but still name the model, and ctrl+o heads them with it. `ui.render AssistantMessage`, scoped by the row's message uuids, draws them as `maya: …` with no bullet. After `--resume`, the person's own typed lines are gone from the row's view.

### Phase 1 changes from spikes 3, 4 and 5
- Room lines are drawn with the scoped `AssistantMessage` rewrite (`maya: …`). The scope is re-found on resume from the room transcript's `answeredWithoutRequest` rows.
- **Your own lines:** the native `❯` row is hidden, and sub-human draws `you: …` itself, so a resumed row keeps both halves of the chat with one line each.

## Phase 1: the row takes typing and draws the room
- `sub-human:room` becomes idle and resumable.
  - Its first synthesized step spawns `sub-human:keeper` (background), which does the blocking `hold` with no tick.
  - The room then ends its turn.
  - The participant agent is already gone (0.6.0).
- Typed input (`session.append`, door `prompt`, origin `composer`) is unwrapped and posted verbatim (`via=human`, signed). Signing happens in the module, which has no seat key, so it goes through node (the same signer path as `@room`). The step answers `✓` or nothing (no echo: the `❯` row is the person's words).
- Incoming lines are drawn with `$.session.send` to the row plus a synthesized step that shows the line with its author. The `❯` echo is hidden (`ui.render UserMessage`, origin `coordinator`), and so is the chrome (spawn prompt, keeper rows, `TurnDuration`, main's "Waiting for 2 background agents").
- The label is the room code (the spawn's `name`); who's here and the unread count are on main's status line (1A above).

## Phase 2: your Claude is your assistant
- **A line naming a person** (`NAME, …`, `@NAME`) wakes that person's main Claude with the line, and one `member.md` rule: answer as `NAME's Claude` when you're sure of the fact, else leave it for NAME. Its answer is posted to the room as `NAME's Claude: …` and drawn in the row.
- **An untagged question** wakes only the asker's own Claude. It answers in the row if it can, and it may ask other Claudes natively (SendMessage, unseen). Otherwise it says nothing.
- **A line that isn't a question** wakes no Claude. Each Claude gets it as context. The asker's Claude judges which is which, from the words only.
- What a Claude answers is steered by its person in plain words ("handle questions for me"), never a setting.
- Unread: a line left for you counts on your label until you open the row. Main gets one line only when your Claude judges it time-sensitive.

**Phase 2 as built (0.8.0-beta.2):**
- Naming: `@maya` anywhere, or a person's line led by `maya,` / `maya:` (case-insensitive, a member's name: `lib/room/deliver.ts` named).
- **Deviation:** an untagged question is a fixed rule, not the Claude's judgement: a person's own line to the room that names nobody and ends with `?` wakes only their own Claude (`ownQuestion`). Judging every typed line would wake the asker's Claude in main per line.
- These chat wakes go by `$.prompt.submit` even mid-turn (spike 4), so they wait for the turn's end. Their prompt row is **not** hidden: Claude Code raises a plugin's own submitted prompt's `ui.render` with that plugin as the origin, so every hook of it skips the row as re-entry (also from a `turn.complete` hook's frame; from the row's `turn.step` the submit is refused: it would wait on the turn that hook holds). It stays as owner decision 1's one quiet line.
- A Claude's `say` to the room is a notice (drawn in every row, counted unread), as a person's line is; Claude to Claude stays SendMessage.

## Phase 3: room lines leave main
- `lib/room/deliver.ts`: a person's `notice` lane is drawn in the row, not as `$.ui.log` in main. Context for Claude is unchanged.
- Kept in main:
  - your own review (the plan view is main's);
  - your Claude's time-sensitive line;
  - the 0.6.1 invite dialogs.
- `@room` in main still posts. Its receipt stays one line.

**Phase 3 as built (0.8.0-beta.2):** a `chat` event (the notice lane: people's lines, Claudes' lines to the room, joins, leaves) goes to the row only once the module knows the row (`mod/deliver.ts` apply; the debug log keeps it); wakes stay main's prompt (a line naming you, your own question, a proposal or review for you), as do health lines, a seatless join's answers and the take's `You're in room …`. With `room-chat` off, or before the row is known after a reload, main shows them as in 0.7.0.

## Phase 4: plans made in the row are room plans
- `plan …` typed in the row (or "let's plan X", judged by your Claude) hands the drafting to your main Claude: a wake with the request.
- Main's Claude writes it with the plan tool (0.7.0 one-call edit), and your check opens in your plan view as now.

**Phase 4 as built (0.8.0-beta.2):** a fixed rule, not a judgement: a line typed into the row that starts with `plan ` or `/plan ` (case-insensitive) is not posted; the row draws `you: plan …`, and once the row's turn completes main's Claude gets the line as a prompt (submitted from the `turn.complete` hook: a submit from the row's `turn.step` is refused) with one line of context: write it as a room plan with the plan tool (op edit). "let's plan X" in other words is an ordinary post.

## Phase 5: release
- README (the row, talking to people, assistants), ARCHITECTURE, CHANGELOG, version 0.8.0.
- **Wire protocol:** no change expected (posts, answers and wakes already exist), but check whether an assistant answer needs a marker beyond `via=agent` + `for`.
- **Demo:** a new scene in which B types in the row, A's Claude answers a factual question as `A's Claude`, and A answers an opinion question himself. Checks: no model step in the row, no main line for a non-urgent message, and the unread count.
- **Gate:** the three modes, plus the new scene.

## Owner decisions (2026-11-21: all three as recommended)
1. **Where an assistant answer runs.** When a message names maya, her **main** Claude answers it: it has her context, so the answer is right. That takes a turn in her main session, visible there as a short exchange. The alternative is a background fork of her session that answers out of sight. Decided: main, with the wake one quiet line, because a hidden fork answering in her name is the thing to avoid.
2. **Provenance.** The transcript credits synthesized row lines to the model (`origin: model`). Decided: accept it, with every drawn line carrying its real author (`maya:`, `maya's Claude:`), and say so in the README. The alternative is to wait for a plugin-origin step from Claude Code.
3. **Desktop, VS Code and Remote Control can't type into a row** (`send_task_message` is unsupported). Decided: the row there is read-only with its label, and `@room` is the way to talk.

## Order and size
Phase 0 first: each spike can change the phases after it. Then 1, 2, 3, 4. Phase 1 alone is shippable as 0.8.0-beta (the row as a chat for people, no assistants yet) if 2 slips.
