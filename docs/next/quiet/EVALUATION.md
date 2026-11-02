# sub-human 0.5.8: evaluation of scene 2 (maya + dev, panda-0976 then rabbit-3194)

Yardstick: PRINCIPLES.md (A: handle it behind the scenes, B: feel native, C: don't overshare), in that priority order.
Evidence: the four member transcripts (maya `c48d23eb…` round 1 and `88e4aef9…` round 2; dev `bb521b96…` and `28a089b9…`), the two room-session transcripts (`0d17667a…` and `1e23722d…`, `claude.CODE`), the row subagent transcripts, both screen logs and both journals. Plugin source: `plugin/sub-human` at be46995 (0.5.8). Native strings were checked against `/opt/homebrew/Caskroom/claude-code@latest/2.1.296/claude` (`strings`), and the plugin's own hooks-module API against `.claude-plugin/types/claude-code/index.d.ts` (written by 2.1.296).

## Verdict

The engine underneath works: every plan round reached a decision, every objection got through word for word, both halves were built against each other, and nothing was lost. What the people saw was still a debug session. Across the four sessions people saw **68 lines written by sub-human (89 counting dev's `/sub-human help`), plus 46 lines of Claude Code chrome and forced Claude echo that sub-human triggered**. The budget in PRINCIPLES.md allows about 6 per session. The owner's hunch is right: about half of the plugin's lines are receipts or machinery (`✓ sent`, `row closed`, `saved … not sent out yet`, the `/rename` echo), and these are debug-log lines.

The two worst moments both come from borrowing plan mode for consent:
1. **"Ready to code?"** frames every sign-off, and the line the plugin wrote to correct it **was never drawn**. `SAY.dialog` (`lib/consent/review.ts:213-215`) goes out as the PreToolUse ask reason, but it appears 0 times in either raw terminal stream.
2. **Objecting costs your permission mode (#34)** and takes three dialogs. The plugin asks for this itself: it sends the closing ExitPlanMode with its plan emptied, and Claude Code's empty-plan dialog offers only "Yes, and switch to default". It then tells Claude "the mode is restored" (`review.ts:230`), which was false in all three objections.

The quickest win is a capability the plugin already has and isn't using. Its hooks module can write to Claude Code's debug log (`$.ui.log(text, {to:"debug"})`), pin one status line (`$.ui.status`), put a line under an open dialog (`$.ui.notice`), and redraw tool rows, tool results, notices and spinners (`ui.render` on `ToolResult`, `ToolUse`, `InfoNotice`, `Spinner`, `CommandOutput`). Most of the fixes below are feasible inside the plugin.

**The S tier doesn't exist for most people.** PRINCIPLES leans on "state goes on the row", but the row status line is opt-in (`subagentStatusLine` in the person's own settings, which the plugin may not write). In this run the room row showed Claude Code's model-written activity summary instead: "Spawning dev participant row", unchanged for 13 minutes, even after the room was left. Until the state moves to `$.ui.status`, demoting a line to S means hiding it.

---

## 1. Message ledger

**Columns.** Saw: **P** = the person on screen, **C** = Claude only, **B** = both. Source: **plugin** (with file:line), **native** (Claude Code's own string, confirmed in the binary), **Claude** (the model's prose, saying what triggered it). Tier = the tier it should have: P / S (status) / C / D (debug) / — (silent). Verdict: keep / rewrite → text / merge / debug / delete.

Strict source checks, since earlier evaluations got these wrong:
- `(a git step in this command can move the working tree, so these may be its changes, not edits)` and `(files that changed while this command ran, by the command or by another process; a convenience view, not a review or audit of the command)` are **native**. They are in the binary as `var ne="(a git step…"` beside the Bash diff renderer, and are not in the plugin. Shown under maya's `git pull` and dev's `git stash/pull`. **Not sub-human's; leave them alone.**
- `Allowed by auto mode classifier`, `Ready to code?`, `Here is Claude's plan:`, `Claude has written up a plan and is ready to execute. Would you like to proceed?`, `Exit plan mode?`, `Claude wants to exit plan mode`, `Yes, and switch to <mode> for this session`, `Entered plan mode` / `Claude is now exploring and designing an implementation approach.`, `User rejected Claude's plan:`, `Exited plan mode`, `User answered Claude's questions:`, `Backgrounded agent (↓ to manage …)`, `Prompt from the <plugin> plugin`, `Session renamed to: …` and `Waiting for N background agent(s) to finish` are all native.
- The `sub-human: ` prefix on notices is **native**. `$.ui.log` lines "carry" the plugin name (index.d.ts). The plugin writes `dev joined`, and Claude Code draws `⏺ sub-human: dev joined`. The plugin adds its own *second* speaker: `room:` (`lib/room/render.ts:277,285`).
- The agent-panel labels `Spawning dev participant row`, `Spawning participant row for dev`, `Holding room rabbit-3194` and `read-only row — type in main with @room` are **not in the binary or the plugin as UI strings**. They are Claude Code's model-written activity summaries of the row agents (the last one echoes `agents/participant.md:16` and `agents/room.md:26`). Native mechanism, plugin-caused.

### 1a. maya, round 1 (room panda-0976; maya opens, authors the plan)

| # | Time (UTC) | Exact text | Saw | Source | Tier | Verdict |
|---|---|---|---|---|---|---|
| M1 | 21:03:00 | `⏵⏵ auto mode on (shift+tab to cycle) · ← 3 agents` (before any room) | P | native footer (agent-view count of sessions on this machine; the room's `claude --bg` sessions add to it) | S | keep (native; see §4) |
| M2 | 21:03:2x | Composer: `/sub-human:sub-human  [invite \| join URL[#SECRET] [PIN] \| join PIN \| help]`. First Enter only completed it | P | native autocomplete + plugin `skills/sub-human/SKILL.md:4` argument-hint | — | rewrite hint → `[invite \| help]` |
| M3 | 21:03:23 | `sub-human: home /tmp/scene2/home` (info row, ctrl+o only) | ctrl+o | plugin `mod/core/constants.ts` HOME_MARK | D | keep (already D-like) |
| M4 | 21:03:23 | `sub-human: opened room panda-0976 as maya · on this machine others join with /sub-human; another machine: /sub-human invite` | P | plugin `lib/seats.ts:319` | P | rewrite → `Opened panda-0976` |
| M5 | 21:03:23 | `SUB-HUMAN: you are maya's Claude in room panda-0976 (with nobody yet)…` + ROWS (≈2.2k chars) | C | plugin `hooks/context.ts:112`, `skills/sub-human/member.md` | C | keep, shorten |
| M6 | 21:03:23 | Skill body: `…your first action is the Agent call(s) under its ROWS line… then reply in one short line.` | C | plugin `skills/sub-human/SKILL.md:14` | C | rewrite → `…then end your turn without text.` |
| M7 | 21:03:26 | `⏺ sub-human:room(panda-0976) ⎿ Backgrounded agent (↓ to manage · ctrl+o to expand)` | P | native (Agent ToolUse row), plugin-caused | — | delete (ui.render ToolUse) |
| M8 | 21:03:27 | `Async agent launched successfully. … agentId: a3586fe7… (internal ID - do not mention to user…)` | C | native | C | keep |
| M9 | 21:03:29 | `You're in room panda-0976, and nobody else has joined yet.` | P | Claude (forced by M6) | — | delete (merge into M4) |
| M10 | 21:03:29→end | `✻ Waiting for 1 background agent to finish` (later `2 background agents`) | P | native spinner; rows are background agents | — | delete (ui.render Spinner) or CC change |
| M11 | 21:03→21:16 | Agent panel: `◯ sub-human:room (+1)  Holding room panda-0976`, then `Spawning dev participant row` for 13 min, still there after leave | P | native activity summary of the plugin's room row (`agents/room.md` step 1 issues Agent + hold in one message) | S | rewrite: static label + `$.ui.status` state |
| M12 | 21:04:52 | `sub-human: dev joined` | P | plugin, render.ts:247 via tail `$.ui.log` | P (opener) / S (others) | keep for the opener → `dev joined` |
| M13 | 21:05:03 | `sub-human: that @room line went to the room; nothing is asked of you.` (isMeta row) | C | plugin `mod/core/prompt.ts:178` | C | keep, shorten → `(for Claude) the @room line was posted; no reply` |
| M14 | 21:05:03 | `✓ sent to room panda-0976 (Claude wasn't asked)` | P | plugin `hooks/handlers/at-room.ts:156` | — | delete (prompt stays as the receipt) |
| M15 | 21:05:25 | `sub-human: dev: hey maya! sounds good, I will take the HTTP handler…` | P | plugin render (dev's words) | P | keep (content) |
| M16 | 21:06:01 | `room since your last turn (FYI):\ndev joined\ndev: hey maya!…` | C | plugin `mod/core/constants.ts:47` | C | keep |
| M17 | 21:06:12 | `Editing room plan room (a new plan): call EnterPlanMode, edit the plan file the hooks fill, then ExitPlanMode({}) with no plan argument; the hooks store it.` | C | plugin `mcp/room-server.ts:363` | C | keep; default name → topic slug (`lib/plans.ts:33`) |
| M18 | 21:06:16 | `Entered plan mode …` (tool result to Claude) | C | native | C | keep |
| M19 | 21:06:18 | `Drafting the room plan now — I've already read the whole repo.` | P | Claude (native `silent_turn_reminder`) | — | n/a (native) |
| M20 | 21:06:19 | Plan file seed: `<!-- sub-human plan room v0: room panda-0976's shared plan…-->` + `Summary of this edit:` | C (file) | plugin `lib/consent/edit.ts` seed | C | keep |
| M21 | 21:06:41 | `Nobody else is asked yet: your person checks it first. Now call ExitPlanMode({}) once more…` | C | plugin `lib/consent/edit.ts:120` | C | keep |
| M22 | 21:06:41 | **`⎿ Error: sub-human: saved as room plan room v1, not sent out yet: you check it first.`** (red) | P | plugin `lib/consent/edit.ts:119` as a PreToolUse deny | — | delete for the person (ui.render ToolResult); C keeps M21. **#9** |
| M23 | 21:06:45 | Plan dialog: `Ready to code? / Here is Claude's plan: / … / Claude has written up a plan and is ready to execute. Would you like to proceed? / 1. Yes, and use auto mode / 2. Yes, manually approve edits / 3. Tell Claude what to change` · footer `~/.claude/plans/iridescent-crafting-lynx.md` | P | native, borrowed by plugin | P | keep the view; add `$.ui.notice` → `Your plan paging v1 · Yes sends it to dev`. **#21** |
| M24 | (21:06:45) | `your new version, plan room v1, for maya: nobody else is asked until you send it out (PgUp/PgDn scroll). Send it out…` | **nobody**: sent as the ask reason, never drawn (0 hits in maya.raw) | plugin `lib/consent/review.ts:216-217` (dialogDraft) | P (1 line) | rewrite as `$.ui.notice` (see M23) |
| M25 | 21:07:17 | `User has approved your plan. You can now start coding…` | C | native | C | keep (C correction below) |
| M26 | 21:07:17 | `maya sent plan room v1 out: dev asked to sign off; maya's Yes is their own sign-off… This was a room review, not a plan to carry out.` | C | plugin `review.ts:184-185` (sent) + `:239` | C | keep |
| M27 | 21:07:22 | `The room plan for GET /tasks paging is out, and dev has been asked to sign off. Your Yes counted as your own sign-off; dev hasn't answered yet.` + summary + `I haven't started any code. That waits for you and for dev's answer.` | P | Claude | P (one line) | keep, shorter. It is reassuring only because M23 scared her |
| M28 | 21:09:40 | `sub-human: room: plan room v1 not agreed: dev asked for changes · you agreed` | P | plugin `lib/room/render.ts:217,277` | P | merge with M29 → one line |
| M29 | 21:09:40 | `› Prompt from the sub-human plugin` / `❯ dev objected to plan room v1: Cursor having both createdAt and id is good. One objection: …` | B | plugin prompt (`mod/deliver.ts:292` asUser) + native frame | P | rewrite → `dev asked for changes to paging v1:` + note (one P line, frame avoided) |
| M30 | 21:09:40 | `(for Claude) sub-human: the prompt above is room lines the person already saw…` / `(for Claude) dev asked for changes…; you may revise the plan (plan, op edit) if maya wants it.` / `(for Claude) room now: plan room v1 a1b2d7 decided · you: agreed` | C | plugin `mod/core/deliver.ts:46`, render.ts:324, :402 | C | keep |
| M31 | 21:09:43 | `dev wants one change for v2… Do you want me to make that change in v2 and ask both of you to sign off again?` | P | Claude | P | keep (good) |
| M32 | 21:10:21 | `Editing room plan room (base v1, maya's Claude)…` | C | plugin `mcp/room-server.ts:363` | C | keep |
| M33 | 21:10:23 | `sub-human: room plan room v1 is in the plan file (/Users/…/iridescent-crafting-lynx.md): edit it there…` | C | plugin consent edit seed line | C | keep |
| M34 | 21:10:39 | **`⎿ Error: sub-human: saved as room plan room v2, not sent out yet: you check it first.`** | P | plugin `edit.ts:119` | — | delete (as M22) |
| M35 | 21:10:40 | Plan dialog again (`Ready to code?`…) | P | native | P | as M23 |
| M36 | 21:11:09 | `I sent v2 out with dev's change, and dev has been asked to sign off. Your Yes counted as your sign-off…` | P | Claude | P | keep, one line |
| M37 | 21:11:44 | `sub-human: room: plan room v2 agreed (you, dev)` | P | plugin render.ts:209,277 | P | rewrite → `Plan paging v2 agreed (you, dev)` |
| M38 | 21:12:14 | `added #2 "store: listTasks" (from plan room v2) (suggested owner: maya; they claim it)` / `#2 is yours now (in progress)` | C | plugin `lib/tasks.ts:285-286` | C | rewrite → `added #3 for dev to take` |
| M39 | 21:12:19 | `I added both tasks, but only yours is actually assigned. The room can't assign a task to someone else; it can only suggest an owner, who then claims it.` | P | Claude (restating M38's mechanics) | — | gap: §3 G7 (the task tool should assign) |
| M40 | 21:12:53 | `⏺ ✓ sent` | P | plugin `mod/core/prompt.ts:181` | — | delete |
| M41 | 21:12:58 | FYI: `room: task "room panda-0976 open" in progress, owner room` … `dev's Claude: asks to claim task "3"` … | C | plugin `lib/tasks.ts:30` (the room's bookkeeping task), render.ts:285-287 | C | drop the `room CODE open` task and the `asks to …` request lines from C too (D) |
| M42 | 21:13:16 | `ROOM-GUARD: the room store is reached only through sub-human… (Denied: it searches or reads a directory above the room store, which holds the seat signing keys.)` (a heredoc writing `/tmp/store_patch.js`) | C (collapsed tool error) | plugin `mod/core/guard.ts:20,158` | C | fix the false positive (§3 G10) |
| M43 | 21:13:47 | `"Tell dev's Claude listTasks is pushed" → sent to dev.panda-0976 — another Claude session on this machine` | P | native SendMessage row | P | keep (native, good) |
| M44 | 21:13:53 | `I messaged dev's Claude directly… The message reached their session, but their Claude hasn't read it yet.` | P | Claude (from native `not yet read by its Claude`) | P | keep |
| M45 | 21:14:33 | FYI: `dev's Claude: asks to done task "3"` / `room: task "http: GET /tasks paging" done, owner dev` | C | plugin render.ts:285-287 | S for maya (`dev ✓ http…`) | gap: maya only learns via Claude (§3 G8) |
| M46 | 21:15:20 | `(a git step in this command can move the working tree…)` / `(files that changed while this command ran…)` | P | **native** (binary) | n/a | not sub-human's |
| M47 | 21:15:54 | `sub-human: dev: both halves are in and npm test is 20/20 green…` | P | plugin render (dev's words) | P | keep |
| M48 | 21:16:03 | `⏺ ✓ sent` | P | plugin | — | delete |
| M49 | 21:16:20 | `sub-human: left panda-0976 · /sub-human joins again` | P | plugin `lib/commands/leave.ts:13` | P | rewrite → `Left panda-0976` |
| M50 | 21:16:20 | `❯ /rename maya` / `⎿ Session renamed to: maya` | P | native string; plugin runs it (`mod/deliver.ts:661` `$.command.run rename`) | D | delete (title via `sessionTitle` at next prompt, or ui.render CommandOutput) |
| M51 | 21:16:20 | `<system-reminder>The user named this session "maya". This may indicate the session's focus or intent.</system-reminder>` | C | native, plugin-triggered | — | delete. It tells Claude something false (she didn't) |
| M52 | 21:16:2x | Card `☐ Left room │ You left room panda-0976. Thanks for trying sub-human! Type below to send feedback. 1. Close 2. Star on GitHub 3. Type something.` | P (modal) | plugin `mod/core/leave.ts:29,33`, `mod/deliver.ts:663` | — | delete; ask at most once per home, never at leave |
| M53 | 21:16:31, :39 | `sub-human: row closed` ×2 | P | plugin `mod/core/rows.ts:60` (rewrite of native "Prompt dropped by a hook: sub-human: row ended, nothing to do", `:54`) | D | delete (ui.render InfoNotice → nothing) |
| M54 | 21:16:39→21:17 | Agent panel `sub-human:room  Spawning dev participant row  13m 7s` after leave; footer `← 3 agents` | P | native summary of an ended row | — | the row must vanish on leave |

### 1b. dev, round 1 (joins, reviews, objects, builds)

| # | Time | Exact text | Saw | Source | Tier | Verdict |
|---|---|---|---|---|---|---|
| D1 | 21:04:23 | footer `← 3 agents` before anything | P | native | S | as M1 |
| D2 | 21:04:5x | `/sub-human` needed Enter twice; argument hint | P | native + SKILL.md:4 | — | as M2 |
| D3 | 21:04:51 | `sub-human: joined panda-0976 as dev, with maya · @room to talk; your Claude can message other Claudes, edit the room plan and the task list` | P | plugin `lib/seats.ts:320` | P | rewrite → `Joined panda-0976 with maya` |
| D4 | 21:04:52-54 | `Backgrounded agent…`, `You've joined room panda-0976 with maya.`, `✻ Waiting for 1 background agent to finish` | P | native / Claude (SKILL.md:14) / native | — | delete (as M7, M9, M10) |
| D5 | 21:05:05 | `sub-human: maya: hi dev! thanks for hopping in…` | P | plugin render | P | keep |
| D6 | 21:05:24 | `✓ sent to room panda-0976 (Claude wasn't asked)` (+ C twin `that @room line went to the room…`) | P / C | plugin at-room.ts:156 / prompt.ts:178 | — / C | delete / keep |
| D7 | 21:05→21:16 | Panel: `sub-human:room (+1)  Spawning maya participant row` for 11 min | P | native summary | S | as M11 |
| D8 | 21:06:43 | `sub-human: maya's Claude: plan room v1: First draft of the GET /tasks paging design: keyset cursor, ordering, limits, errors, and the store/handler split.` | P | plugin render.ts:265-270 | — until he is asked (it's maya's unsent draft) | delete for non-askees; the request (D11) carries it |
| D9 | 21:06:47 | `/sub-human help`: 21 rows, each `sub-human:` + a line from `commands:` … `@room TEXT …`, ending `rows show names; for their live status (tasks, plans, sign-off, link) add the subagentStatusLine line in the README's Rows section to your ~/.claude/settings.json` | P (on request) | plugin `lib/commands/help.ts:8-30` (native prefix per row) | P on request | rewrite to ~6 lines in one notice; move ssh/web/admit to `help invite`; the tip to doctor |
| D10 | 21:07:10 | FYI: `…maya's Claude asks maya to check plan room v1 before it goes out` | C | plugin render.ts:260 | — | delete (D) |
| D11 | 21:07:18 | `sub-human: maya's Claude asks you to sign off on plan room v1 (maya agreed)` | P | plugin render.ts:261 | P | rewrite → `maya asks you to review plan paging v1` |
| D12 | 21:07:27 | `› Prompt from the sub-human plugin` / `❯ maya's Claude asks you to sign off on plan room v1 (maya agreed)`, **the same line again** | B | plugin `mod/deliver.ts:756` (turn.complete resubmits a mid-turn wake) + native frame | C | merge: resubmit context-only (the line was already shown) |
| D13 | 21:07:18, :27 | `(for Claude) sub-human room: lines from other people…` / `(for Claude) room now: plan room v1 a1b2d7 waiting on dev · you: answer needed (call EnterPlanMode, then ExitPlanMode with plan "proposal a1b2d708a6d6"; …)` | C | plugin `mod/core/deliver.ts:31`, render.ts:402 | C | keep |
| D14 | 21:07:27 | `Here's plan room v1. maya hasn't checked it yet, so it hasn't been sent out for sign-off.` + full summary + `A few things on your half you might raise` | P | Claude (from `plan room v1 · not sent out yet (maya checks it first)`, `lib/plans.ts:88`) | P | keep (useful). The state word should be `draft` |
| D15 | 21:07:30 | `⏺ Entered plan mode / Claude is now exploring and designing an implementation approach.` | P | native, borrowed | — | rewrite via ui.render → `Opening plan paging v1 from maya` |
| D16 | 21:07:30 | `sub-human: this plan mode is only to show dev room proposal a1b2d708a6d6. Call ExitPlanMode now with plan "proposal a1b2d708a6d6"…` | C | plugin review.ts:217 (showOnly) | C | keep |
| D17 | 21:07:31 | Plan dialog `Ready to code? … ready to execute … 1. Yes, and use auto mode` · footer `~/.claude/plans/floating-greeting-kettle.md` | P | native | P | add `$.ui.notice` → `Review · plan paging v1 from maya · Yes agrees · "Tell Claude what to change" asks for changes`. **#21** |
| D18 | (21:07:31) | `sign-off on plan room v1, asked by maya's Claude, for dev: agreeing signs off on this text, it is not a go-ahead to build (PgUp/PgDn scroll). Agree: … Object: … Esc: decide later.` | **nobody** (ask reason not drawn) | plugin review.ts:213-215 | P (1 line) | rewrite as the notice in D17 |
| D19 | 21:08:05 | `⎿ User rejected Claude's plan: ╭ proposal a1b2d708a6d6 ╮` (his note not shown) | P | native frame + plugin stub text (`review.ts:134` NEXT.open, `member.md:8`) | — | rewrite the stub to `plan paging v1` or redraw the ToolResult as `You asked for changes: "Cursor having both…"` |
| D20 | 21:08:05 | `sub-human: nothing is recorded yet: dev's note on a1b2d708a6d6 waits for its card (Send or Discard)… First call ExitPlanMode now (no plan needed); then call AskUserQuestion with "objection a1b2d708a6d6".` | C | plugin review.ts:225 (rejectedNote) | C | rewrite: card **first**, then leave plan mode |
| D21 | 21:08:06 | Dialog `Exit plan mode? / Claude wants to exit plan mode / ❯ 1. Yes, and switch to default (ask each time) for this session / 2. No` | P | native; plugin-caused (closing call with emptied plan, `review.ts:464-474`) | — | delete (needs CC change; §4). **#34** |
| D22 | (21:08:06) | `sub-human: the room review is over; this only leaves plan mode (no plan is approved)` | **nobody** (ask reason not drawn) | plugin review.ts:198 (`leaving`) | — | delete |
| D23 | 21:09:03 | `Nothing is recorded yet: dev's note on a1b2d708a6d6 waits for Send or Discard on its card… The room review is closed and the mode is restored; this was not a plan to carry out.` | C | plugin review.ts:222 + :230 | C | rewrite: **false**. `auto_mode_exit` came in the same tick |
| D24 | 21:09:03 | `⏺ Exited plan mode` | P | native | — | delete (ui.render) |
| D25 | 21:09:05 | Card `☐ Consent │ Send to maya as changes requested on "plan room v1": "Cursor having both createdAt and id is good. One objection: … Please se…"? ❯ 1. Send 2. Discard` + full-note preview | P | plugin `lib/proposal.ts:485,492` in native AskUserQuestion | P | keep; rewrite header → `Changes`, question → `Send these changes on paging v1 to maya?` |
| D26 | 21:09:39 | `⏺ User answered Claude's questions: ⎿ · Send to maya as changes requested on "plan room v1": "…"? → Send` | P | native echo | — | delete via ui.render (the decision line follows) |
| D27 | 21:09:39 | `Recorded. The room shows it (and any note) already: post nothing about it. Agreeing is not a go-ahead to build… dev objected to proposal a1b2d708a6d6; the room decided: objected: dev · agreed: maya…` | C | plugin review.ts:180,191,193 | C | keep, shorter |
| D28 | 21:09:41 | `sub-human: room: plan room v1 not agreed: you asked for changes · maya agreed` | P | plugin render.ts:217 | — | delete for the objector (the card was the receipt); S `paging v1 · changes asked` |
| D29 | 21:09:41 | `Your change request on v1 went to maya…` | P | Claude | P | keep, one line |
| D30 | 21:10:04→21:11:43 | footer `⏸ manual mode on` | P | native state, plugin-caused | — | **#34** |
| D31 | 21:10:40 | `› Prompt from the sub-human plugin ❯ maya's Claude: plan room v2: Per dev's objection, limit above 100 is clamped…` | B | plugin prompt | P (merge) | merge into the request D33 (`… v2 (your change is in)`) |
| D32 | 21:10:42 | Permission dialog `Tool use / plugin:sub-human:room — Read Tool: (MCP) / plan: "room" / About the plugin:sub-human:room — Read Tool: │ Read the sub-human room: ids, those entries in full; plan, a room plan; brief, its state; else your unseen entries (oldest first, ≤ 100). / Do you want to proceed?` | P | native dialog, plugin tool description (`mcp/room-server.ts`) | — | avoid (fix #34); make the description read for a person |
| D33 | 21:11:08 | `sub-human: maya's Claude asks you to sign off on plan room v2 (maya agreed)` | P | plugin render.ts:261 | P | as D11 |
| D34 | 21:11:17-43 | `Entered plan mode`, `Ready to code?` (v2), `Yes, and use auto mode` | P | native | P | as D15/D17 |
| D35 | 21:11:44 | `sub-human: room: plan room v2 agreed (maya, you)` | P | plugin | P | rewrite → `Plan paging v2 agreed (maya, you)` |
| D36 | 21:11:44 | `Your sign-off on v2 is in. I'll hold off on the handler until you tell me to start…` | P | Claude | P | keep |
| D37 | 21:12:15 | `sub-human: room: task "http: GET /tasks paging" open, suggested for you (claim it to take it)` | P | plugin render.ts:283-285 | P | rewrite → `New task for you: http: GET /tasks paging` |
| D38 | 21:12:47 | FYI `room: task "room panda-0976 open" in progress, owner room` / `maya's Claude: asks to add task …` ×2 / `asks to claim task "2"` | C | plugin | D | delete from C (D) |
| D39 | 21:13:16, :22 | `ROOM-GUARD: …(Denied: it searches or reads a directory above the room store…)` ×2 (`mktemp -d` scratch, then `$HOME/.cache/…`) | C | plugin guard.ts:20,158 | C | fix the rule (§3 G10) |
| D40 | 21:13:18, :33 | `The guard blocked the temp dir. I'll use a scratch dir under my home folder instead.` / `The room guard blocks the scratch copy too, and I won't try to work around it.` | P | Claude, triggered by D39 | — | goes away with G10 |
| D41 | 21:13:47 | `maya's Claude: listTasks and InvalidCursorError are pushed to origin main (8b2aab4)… │ Contract, as in room plan v2: …` | P | plugin `mod/render.ts` (ui.render UserMessage origin peer) | P | keep (the best hand-off in the run) |
| D42 | 21:13:47 | `Another Claude session sent a message: <cross-session-message …> … This came from another Claude session — not typed by your user…` | C | native | C | keep |
| D43 | 21:13:4x | `✻ Waiting for 2 background agents to finish` | P | native | — | as M10 |
| D44 | 21:13:57 | git `(a git step…)` / `(files that changed…)` | P | **native** | n/a | not sub-human's |
| D45 | 21:15:52 | `✓ sent` | P | plugin | — | delete |
| D46 | 21:16:05 | `sub-human: maya: main is green with both halves…` | P | plugin render | P | keep |
| D47 | 21:16:27 | `sub-human: left panda-0976 · /sub-human joins again` | P | plugin leave.ts:13 | P | → `Left panda-0976` |
| D48 | 21:16:27 | `❯ /rename dev ⎿ Session renamed to: dev` + C `The user named this session "dev"…` | P / C | native, plugin-run (deliver.ts:661) | — | delete |
| D49 | 21:16:32, :43 | `sub-human: row closed` ×2 | P | plugin rows.ts:60 | D | delete |
| D50 | 21:16:5x | `☐ Left room … Thanks for trying sub-human! … 2. Star on GitHub` | P | plugin leave.ts:33 | — | delete |
| D51 | 21:17:11 | footer `← 3 agents` after leaving | P | native | — | see §4 |

### 1c. maya, round 2 (room rabbit-3194; authors error-handling, reviews dev's http-headers)

Lines that repeat round 1 word for word are marked "= Mn".

| # | Time | Exact text | Saw | Source | Tier | Verdict |
|---|---|---|---|---|---|---|
| R1 | 21:17:45 | `sub-human: opened room rabbit-3194 as maya · on this machine others join with /sub-human; another machine: /sub-human invite` | P | seats.ts:319 | P | = M4 (and see G5: no way back to panda-0976) |
| R2 | 21:17:46-48 | `Backgrounded agent…` / `You opened room rabbit-3194, and nobody else has joined yet.` / `Waiting for 1 background agent…` | P | native / Claude / native | — | = M7, M9, M10 |
| R3 | 21:18:20 | `sub-human: dev joined` | P | plugin | P | = M12 |
| R4 | 21:18:31 | `✓ sent to room rabbit-3194 (Claude wasn't asked)` | P | plugin | — | = M14 |
| R5 | 21:18:51 | `sub-human: dev: welcome back to me :) ready to review…` | P | plugin render | P | keep |
| R6 | 21:18:52 | `refused: invalid plan name "error handling" (a-z, 0-9 and -, up to 24)` | C (tool error) | plugin `mcp/room-server.ts:346` | — | delete: slugify it silently |
| R7 | 21:18:53 | `Drafting the plan now; the name needs to be a slug, so I'm calling it 'error-handling'.` | P | Claude, triggered by R6 | — | goes away with R6 |
| R8 | 21:19:26 | **`⎿ Error: sub-human: saved as room plan error-handling v1, not sent out yet: you check it first.`** | P | edit.ts:119 | — | = M22 (**#9**, third time) |
| R9 | 21:19:27 | Plan dialog `Ready to code?` (own check), footer `~/.claude/plans/radiant-wobbling-reddy.md` | P | native | P | = M23 |
| R10 | 21:20:02 | `You sent the error-handling plan (v1) to the room, and your Yes counts as your sign-off. dev hasn't signed off yet. I haven't changed any code.` + summary | P | Claude | P | keep, one line |
| R11 | 21:20:48 | `sub-human: room: plan error-handling v1 not agreed: dev asked for changes · you agreed` | P | render.ts:217 | merge | = M28 |
| R12 | 21:20:48 | `› Prompt from the sub-human plugin ❯ dev objected to plan error-handling v1: Shape looks good… ` / `  │ Send that to maya as a change for v2.` (stray bar: NEST continuation, render.ts CHAT nesting) | B | plugin prompt + render NEST | P | = M29; drop the NEST bar inside a submitted prompt |
| R13 | 21:20:50 | `…The plan is still open, not agreed. If you want v2 with that change, say so and I'll draft it for you to check before it goes back to dev.` | P | Claude | P | keep |
| R14 | 21:21:49 | **`⎿ Error: sub-human: saved as room plan error-handling v2, not sent out yet…`** | P | edit.ts:119 | — | = M22 |
| R15 | 21:22:04 | `sub-human: dev's Claude: plan http-headers v1: first draft: GET /tasks sends a Link rel="next" header…` | P | render.ts:265 | — (not asked yet) | = D8 |
| R16 | 21:22:20 | `sub-human: dev's Claude asks you to sign off on plan http-headers v1 (dev agreed)` (+ C wake with `room now: plan error-handling v2 b90af0 waiting on maya · … · plan http-headers v1 95379a waiting on maya · you: answer needed (call EnterPlanMode…"proposal 95379aea2482"…)`) | P / C | render.ts:261 / :402 | P / C | = D11; it arrived while her own v2 dialog was open (G6) |
| R17 | 21:23:08 | `sub-human: room: plan error-handling v2 agreed (you, dev)`, drawn above the next dialog and easy to miss | P | render | P | = M37 |
| R18 | 21:22:54 | `Entered plan mode — Claude is now exploring and designing…` | P | native | — | = D15 |
| R19 | 21:22:55 | Plan dialog `Ready to code? / Here is Claude's plan:` showing **dev's** http-headers v1, footer **her own** `~/.claude/plans/radiant-wobbling-reddy.md` | P | native; the plugin writes the proposal into her plan file | P | notice per D17; footer needs CC change |
| R20 | 21:23:47 | `⎿ User rejected Claude's plan:` + full plan box | P | native | — | = D19 |
| R21 | 21:23:47 | `sub-human: nothing is recorded yet: maya's note on 95379aea2482 waits for its card…First call ExitPlanMode now…` | C | review.ts:225 | C | = D20 |
| R22 | 21:23:48 | `Exit plan mode? … 1. Yes, and switch to default (ask each time) for this session 2. No`. She picked **No** | P | native, plugin-caused | — | **#34** extended: No → `STOP what you are doing and wait for the user` (native), left in `⏸ plan mode on`, note unsent |
| R23 | 21:25:23 | `sub-human: Nothing is recorded yet: maya's note on 95379aea2482 waits… Before anything else, call ExitPlanMode now…` / `proposal 95379aea2482: maya's note is not recorded yet. First, call AskUserQuestion… Don't reopen the review (that drops the note).` | C | review.ts:222, :244 (promptExit), lib/tail reminder | C | the two contradict each other on order; make it one mechanic |
| R24 | 21:25:25 | `Exit plan mode?` again → Yes → `⏸ manual mode on` | P | native | — | **#34** |
| R25 | 21:25:58 | `Nothing is recorded yet… The room review is closed and the mode is restored…` | C | review.ts:230 | C | false again (auto_mode_exit) |
| R26 | 21:26:00 | `☐ Consent │ Send to dev as changes requested on "plan http-headers v1": "Link header idea is fine, …"? 1. Send 2. Discard` | P | proposal.ts:485 | P | = D25. It should come right after option 3 |
| R27 | 21:26:46 | `Your objection has now gone to dev; before this, nothing had been sent…` | P | Claude | — | goes away when the card comes first |
| R28 | 21:26:46 | `sub-human: room: plan http-headers v1 not agreed: you asked for changes · dev agreed` | P | render | — | = D28 |
| R29 | 21:27:31 | `› Prompt from the sub-human plugin ❯ dev's Claude: plan http-headers v2: per maya, lands after error-handling v2…` | B | plugin prompt | merge | = D31 |
| R30 | 21:27:32 | Permission dialog `plugin:sub-human:room — Plan Tool: (MCP) / op: "read" name: "http-headers" / About…: │ Sub-human room plans. edit (fine in plan mode), then EnterPlanMode, edit the plan file, ExitPlanMode({}): the hooks store the next version (your person checks it first). ask: people sign off on the current one. read. Only when told to: put stores text instead;… (ctrl+o to expand description)` | P | native dialog, plugin tool description (`mcp/room-server.ts` plan tool) | — | avoid (#34). The description is Claude's instructions drawn for a person (principle 9) |
| R31 | 21:27:50 | `sub-human: dev's Claude asks you to sign off on plan http-headers v2 (dev agreed)` | P | render | P | = D33 |
| R32 | 21:28:10-47 | `Entered plan mode`, `Ready to code?`, `1. Yes, and use auto mode` (gave auto back) | P | native | P | = D34 |
| R33 | 21:28:48 | `Recorded. Neither plan has been built yet; I'll wait for you to say when to start the error-handling change.` / `sub-human: room: plan http-headers v2 agreed (you, dev)` | P | Claude / plugin | P | keep the decision; Claude's line → silent (C says "don't restate") |
| R34 | 21:29:06 | `sub-human: dev: both plans agreed: error-handling v2 (yours first) then http-headers v2…` | P | render | P | keep |
| R35 | 21:29:38-53 | `✓ sent` · `sub-human: left rabbit-3194 · /sub-human joins again` · `/rename maya` + `Session renamed to: maya` · `sub-human: row closed` ×2 · `Left room … Star on GitHub` card | P | as M48-M53 | | as M48-M53 |

### 1d. dev, round 2 (joins, objects to error-handling v1, authors http-headers)

| # | Time | Exact text | Saw | Source | Tier | Verdict |
|---|---|---|---|---|---|---|
| E1 | 21:18:18 | `sub-human: joined rabbit-3194 as dev, with maya · @room to talk…` + Backgrounded + `You're in room rabbit-3194 with maya.` + Waiting | P | = D3, D4 | | = D3, D4. Nothing told him panda-0976 had closed or that a new code existed (G5) |
| E2 | 21:18:32 | `sub-human: maya: welcome back dev…` | P | render | P | keep |
| E3 | 21:18:49 | `✓ sent to room rabbit-3194 (Claude wasn't asked)` | P | at-room.ts:156 | — | delete |
| E4 | 21:19:28 | `sub-human: maya's Claude: plan error-handling v1: first draft — one { error: { code, message } } shape…` | P | render.ts:265 | — | = D8 |
| E5 | 21:20:00 | `› Prompt from the sub-human plugin ❯ maya's Claude asks you to sign off on plan error-handling v1 (maya agreed)` | B | plugin prompt | P (one line, no frame) | rewrite as D11 |
| E6 | 21:20:05-27 | `Entered plan mode…` / `Ready to code?` / `⎿ User rejected Claude's plan: ╭ proposal d8dd644b2f65 ╮` | P | native + stub | | = D15, D17, D19 |
| E7 | 21:20:31-37 | `Exit plan mode? 1. Yes, and switch to default…` → Yes → `Exited plan mode` → `manual mode` | P | native, plugin-caused | — | **#34**, second time |
| E8 | 21:20:40-46 | `☐ Consent │ Send to maya as changes requested on "plan error-handling v1": "…"?` → `User answered Claude's questions: … → Send` | P | proposal.ts:485 + native echo | P | = D25, D26 |
| E9 | 21:20:48 | `sub-human: room: plan error-handling v1 not agreed: you asked for changes · maya agreed` | P | render | — | = D28 |
| E10 | 21:21:51 | `sub-human: maya's Claude: plan error-handling v2: per dev, nested shape applies to GET /tasks only…` (+ C wake: `(for Claude) this v2 of plan error-handling comes after v1… Tell dev what changed (read, plan "error-handling")…`) | P / C | render.ts:265 / render.ts:338 | merge | merge into E13's request |
| E11 | 21:22:03 | **`⎿ Error: sub-human: saved as room plan http-headers v1, not sent out yet: you check it first.`** | P | edit.ts:119 | — | = M22 |
| E12 | 21:22:04-27 | own plan check `Ready to code?` → Yes → `Your http-headers v1 plan is up in the room and maya has been asked to sign off… a small merge overlap…` | P | native / Claude | P | keep (Claude's overlap note was useful) |
| E13 | 21:22:53 | `› Prompt from the sub-human plugin ❯ maya's Claude asks you to sign off on plan error-handling v2 (maya agreed)` | B | plugin prompt | P | as D11 |
| E14 | 21:23:08 | `sub-human: room: plan error-handling v2 agreed (maya, you)` / Claude `Your sign-off on error-handling v2 is recorded, and http-headers v1 is still waiting on maya.` | P | render / Claude | P / — | keep decision; Claude's line → S (`http-headers v1 · waiting on maya`) |
| E15 | 21:26:46 | `sub-human: room: plan http-headers v1 not agreed: maya asked for changes · you agreed` **and** `› Prompt from the sub-human plugin ❯ maya objected to plan http-headers v1: Link header idea is fine…` | P + B | render.ts:217 + prompt | P | merge → one line, as M28/M29 (dev called it REDUNDANT) |
| E16 | 21:26:50 | `maya asked for two changes… I can write that up as v2 and send it to maya for sign-off. Want me to?` | P | Claude | P | keep |
| E17 | 21:27:29 | **`⎿ Error: sub-human: saved as room plan http-headers v2…`** | P | edit.ts:119 | — | = M22 |
| E18 | 21:27:48-51 | own check `Ready to code?` → Yes → `http-headers v2 has gone to maya for sign-off…` | P | native / Claude | P | keep (one line) |
| E19 | 21:28:49 | `sub-human: room: plan http-headers v2 agreed (maya, you)` | P | render | P | keep (rewrite as M37) |
| E20 | 21:20→21:29 | Panel `sub-human:room (+1)  read-only row — type in main with @room` | P | native activity summary echoing agents/room.md:26 | S | as M11 |
| E21 | 21:29:04-52 | `✓ sent` · `sub-human: maya: sounds good dev…` · `left rabbit-3194 · /sub-human joins again` · `/rename dev` echo · `row closed` ×1 · `Left room … Star on GitHub` | P | as D45-D50 | | as D45-D50 |

---

## 2. Counts against the budget

**What is counted.** "Plugin" means lines sub-human wrote that the person saw: notices, receipts, red denies, plugin prompts, cards, and help (help is listed separately because it was asked for). Other people's words are content and not counted. Native plan views are not counted. "Chrome" means native Claude Code lines that sub-human's flow triggered: Backgrounded agent, Waiting for N agents, Entered/Exited plan mode, User rejected box, Exit plan mode? dialog, User answered echo, MCP permission prompts, /rename echo. "Echo" means Claude prose the plugin forced (the skill's "one short line", the slug refusal, the guard detour).

| Phase | maya R1 | dev R1 | maya R2 | dev R2 | Budget (PRINCIPLES) |
|---|---|---|---|---|---|
| Join / open | 1 plugin + 2 chrome + 1 echo | 1 + 2 + 1 | 1 + 2 + 1 | 1 + 2 + 1 | **1** |
| Chat (hello) | 2 (`dev joined`, `✓ sent to room…`) | 1 (`✓ sent…`) | 2 | 1 | **0** (1 for the opener's `dev joined`) |
| Help (on request) | — | 21 | — | — | 1 screen on request |
| Plan round | 5 (2 red saves, 2 decisions, 1 objection prompt) | 8 (draft line, request ×2 + duplicate, 2 decisions, v2 prompt, card) + 7 chrome + manual-mode drop | 12 (2 red saves, 6 room lines, 3 decisions, card) + 9 chrome + 1 echo + mode drop | 12 (2 red saves, 4 requests/drafts, 4 decisions, objection prompt, card) + 6 chrome + mode drop | author **2** (one per decision); reviewer **1 request + 1 decision per version** (dev R1 4, maya R2 6, dev R2 6) |
| Tasks | 1 (`✓ sent`) + 1 echo (claim mechanics) | 1 (`suggested for you (claim it…)`) | — | — | **1** for the assignee; **0** for the maker |
| Build / Claude-to-Claude | 0 (and 0 about dev finishing: a gap) | 0 + 1 chrome (`Waiting for 2…`) + 2 echo (guard) | — | — | **0** (peer content allowed) |
| Leave | 5 (`✓ sent`, `left …`, `row closed` ×2, card) + 2 chrome (`/rename`) | 5 + 2 | 5 + 2 | 4 + 2 | **1** |
| **Total plugin** | **14** | **16** (+21 help) | **20** | **18** | **≤ 6** each |
| **Total incl. chrome + echo** | **19** | **31** (+21) | **35** | **29** | |

Before: **68 plugin lines across the four sessions (+21 help), 114 counting chrome and forced echo.** The redesign in §5 lands at **24 across the four (maya R1 5, dev R1 6, maya R2 7, dev R2 6)**. Every one of those is a person's decision, a request for theirs, or the open/join/leave line.

Where the excess comes from, by kind:
- Receipts of the person's own action: 22 (`✓ sent` ×10, red `saved…` ×6, `left …` suffixes, `row closed` ×7).
- Duplicates of one event: 11 (decision line + objection prompt, notice + resubmitted prompt, draft line + request line).
- Machinery, chrome and forced echo: 46 (mode dialogs, plan-mode banners, background-agent rows, `/rename`).
- Teaching text: the `·` suffixes on open/join/leave, 21 help rows, `claim it to take it`.

---

## 3. Behind-the-scenes gaps (work the system left to the person or their Claude)

| # | Gap | Evidence | What the system should do | Where |
|---|---|---|---|---|
| G1 | **The mode drop after an objection (#34)**, plus three dialogs to say no | dev R1 + R2, maya R2: plan view → `Exit plan mode?` (only "switch to default") → Consent card. maya's **No** left her in plan mode with the note unsent and a "STOP" interrupt. The room-tool prompts (D32, R30) followed from the drop | Card first, in plan mode (AskUserQuestion works there); then leave plan mode back to the mode remembered at review time. The plugin can't answer the permission check (CLAUDE.md "No hook answers a permission check with allow"), so a clean fix needs Claude Code: let a hook's `updatedInput` on ExitPlanMode name the mode to return to, or keep `prePlanMode` on the empty-plan path. Interim: on "No", run `closedHere` (stay in plan mode, show the card, put the S line `⏸ plan mode · shift+tab to return to auto`) instead of `STOP` | `lib/consent/review.ts:225` (order), `:464-474` (`leaving`), `:230` (false "mode is restored"), `:646` (closedHere only when the review mode was plan) |
| G2 | The objector's own words never shown after option 3 | D19, E6: the rejected box shows `proposal a1b2d708a6d6` | Redraw that ToolResult as `You asked for changes: "<first 80 chars>"`, or pass the plan label as the stub | `review.ts:134`, `member.md:8`; ui.render ToolResult |
| G3 | The stale `Spawning … participant row` label | M11, D7: 11-13 min; still there after leave (M54) | Make the row a static label. Spawn participants in their own message, then `hold` alone (so the summary reads "hold"), and set the label through the `agent.spawn` hook's `description`. Show live state on `$.ui.status` | `agents/room.md` step 1; `mod/rows.ts` |
| G4 | The leaked background row after leave | M54, D51 | When `STOP` arrives, end the row and remove its panel entry; never leave a "Spawning" label behind | `mod/rows.ts`, `mcp/hold.ts` |
| G5 | **A room that empties says nothing, and coming back means a new code** | dev E1 ("nothing told me it closed"), maya R1 ("a returning pair might want … panda-0976") | Keep a room's code for a returning pair: `/sub-human` with nobody in a room reopens the last room you were in (same code, same plans, same tasks) if it closed less than a day ago. Tell the joiner `Joined panda-0976 with maya` as usual. The empty room needs no notice when its code comes back | `lib/seats.ts` take/open, `lib/gc.ts` |
| G6 | A second sign-off request landed while maya's own v2 check was open; the dialogs queued and the decision line was buried | R16-R19 | Hold a request for this seat while a review or edit is open, and show it after the decision. Show the decision as `$.ui.status` too | `mod/deliver.ts` wake gating; `review.ts` phase |
| G7 | Tasks can't be assigned, so Claude explains the mechanics and the other Claude claims the task itself | M38-M39, D37 | When a person says "assign X to dev", the task is dev's: no claim step. Add with `owner: dev`; the room tells dev `New task for you: …`; dev's Claude never "asks to claim" | `lib/tasks.ts:285` (`suggest` → `owner` on a person's explicit request), `render.ts:283` |
| G8 | **maya learned dev was done only from her Claude's FYI** | M45: `room: task … done, owner dev` lives only in context; dev's Claude never answered maya's SendMessage; no row shows it (G3) | One status-line update `dev ✓ http: GET /tasks paging (945d712)`. If maya is idle and owns a sibling task in the same plan, add `$.ui.notify` | `$.ui.status`; `lib/room/deliver.ts` task kind |
| G9 | `/rename` echoes and a false system reminder | M50-M51, D48 | Re-title silently: `sessionTitle` at the next prompt (the module already does this, `mod/prompt.ts`), or hide the CommandOutput with ui.render. SendMessage to an absent seat is refused at the room anyway | `mod/deliver.ts:661` |
| G10 | **The guard blocked scratch dirs, pushed Claude into `$HOME/.cache`, and the person never saw why** | M42 (maya's heredoc to `/tmp/store_patch.js`), D39 (`mktemp -d`, then `$HOME/.cache`) | "Above the store" should mean *enumerating* reads (`find`, `grep -r`, `ls -R`, `du`, `tar` rooted at an ancestor), not any path under an ancestor and not writes to a new path. `mktemp -d` must always pass. When it does deny, tell Claude the allowed alternative in a few words (`use mktemp -d`) | `mod/core/guard.ts:158,163,628`; **#35** (same family as closed #10 and #30) |
| G11 | Enter twice for `/sub-human` | M2, D2 | Typing `/sub-human` matches the namespaced `/sub-human:sub-human`, so the first Enter completes it. Shorten the argument hint now; ask Claude Code to submit on an exact match of a plugin's own short name | `skills/sub-human/SKILL.md:4`; CC change |
| G12 | `← 3 agents` before joining anything | M1, D1 | Native agent-view count. Make sure no stale `claude.CODE` room session lingers from earlier rooms (reap on room close), so the count is only real sessions | `lib/room-claude.ts` reap |
| G13 | Plan name refused (`error handling`) and Claude had to explain slugs | R6-R7 | Slugify silently (`error handling` → `error-handling`) and keep the person's title for display | `mcp/room-server.ts:346`, `lib/plans.ts:56,60` |
| G14 | The default plan is named `room`, so lines read `plan room v1` | D8, M28 | Name the first plan from its heading (`paging`), or say `the room plan v1` | `lib/plans.ts:33` |
| G15 | Each notice line during a busy turn is shown, then resubmitted as a prompt | D11+D12 | When turn.complete resubmits a wake whose lines were already logged, submit it context-only | `mod/deliver.ts:476,756` |

---

## 4. Native fit

Feasibility key: **plugin** = doable with hooks, MCP results, skills, agents, the hooks module (`$.ui.log {to:"debug"}`, `$.ui.status`, `$.ui.notice`, `$.ui.ask`, `ui.render` on `ToolUse/ToolResult/InfoNotice/Spinner/CommandOutput/AbovePrompt`) and plan files. **workaround** = doable, but bending a surface or still to be proven on 2.1.296. **CC** = needs a Claude Code change.

| Borrowed surface | What it says vs what it means | Native-feeling option | Feasibility |
|---|---|---|---|
| Plan dialog `Ready to code? / Here is Claude's plan: / Claude has written up a plan and is ready to execute. Would you like to proceed? / Yes, and use auto mode` | "Start coding" vs "agree to a text someone else wrote" (or "send my draft") | `$.ui.notice(tool_use_id, "Review · plan paging v1 from maya · Yes agrees · Tell Claude what to change asks for changes")`: one line under the open dialog, drawn by Claude Code. Also a first line in the plan text: `> Room plan paging v1 from maya, for your review. Yes = agree; nothing gets built.` Today's `SAY.dialog` reason is **never drawn**. A hook-settable title and button labels | notice + heading: **plugin**; title/buttons: **CC** (#21) |
| `⏺ Entered plan mode / Claude is now exploring and designing an implementation approach.` | A false statement during a review | ui.render ToolResult for EnterPlanMode while a review opens → `Opening plan paging v1 from maya` | **workaround** (verify ToolResult render on 2.1.296) |
| `⎿ User rejected Claude's plan: ╭ proposal a1b2d708a6d6 ╮` | "You asked for changes", shown as a hex id; their note is not shown | Stub = the plan label; ui.render ToolResult → `You asked for changes: "…"` | label: **plugin**; redraw: **workaround** |
| `Exit plan mode? / Claude wants to exit plan mode / 1. Yes, and switch to default (ask each time) for this session` | "Close the review" vs "change my permission mode" | Never show it: card first, then a mode-preserving exit | **CC** (the plugin may not allow a permission check); interim ordering: **plugin** |
| `☐ Consent` header; `Send to maya as changes requested on "plan room v1": "…"?` | Good card, legal-sounding header | Header `Changes`; `Send these changes on paging v1 to maya?`, with the preview kept | **plugin** (`lib/proposal.ts:199,485,492`) |
| `⎿ Error: sub-human: saved as room plan room v1, not sent out yet: you check it first.` | A success drawn as an error | Redraw the denied ExitPlanMode result as nothing (the plan view that follows is the receipt); C keeps `checkNext` | **workaround**: ui.render ToolResult; else **CC**: a non-error deny (#9) |
| `› Prompt from the sub-human plugin` above room lines | "The plugin typed in your session" vs "dev asked for changes" | Show the person's line with `$.ui.log` (a notice) and make the wake a context-only turn, so the transcript shows the line once in chat style (`mod/render.ts` is never asked for the plugin's own prompts) | **workaround** (a context-only `$.prompt.submit` is unproven) / **CC** |
| `✻ Waiting for 1 (2) background agent(s) to finish` | Rows are permanent agents; the main loop looks blocked | ui.render Spinner for the room row's agent id → nothing; or a non-background row primitive | **workaround** / **CC** (an "ambient" agent kind that doesn't count) |
| `⏺ sub-human:room(panda-0976) ⎿ Backgrounded agent (↓ to manage · ctrl+o to expand)` | Machinery | ui.render ToolUse for `Agent` with `subagent_type: sub-human:room` → nothing (the panel row is the receipt) | **plugin** (ToolUse is a render component) |
| Agent-panel label (`Spawning dev participant row`, `read-only row — type in main with @room`) | Model-written summary of row internals | Static description via `agent.spawn` rewrite; live state on `$.ui.status` (one pinned plugin line under the prompt: `panda-0976 · maya, dev · paging v2 agreed · dev ◼ http paging`) | **plugin** |
| `sub-human: ` + `room:` double speaker | Two speakers | Drop `room:` (`render.ts:277,285`); the native `sub-human:` prefix is the one speaker | **plugin** |
| Hex ids in C (`a1b2d7`, `proposal a1b2d708a6d6`) | Fine in C, but they leak through the stub (G2) | Keep in C; never in a stub the person sees | **plugin** |
| `❯ /rename maya ⎿ Session renamed to: maya` + "The user named this session" | Machinery, plus a false reminder | `sessionTitle` from UserPromptSubmit (already used) | **plugin** |
| MCP permission dialog showing the plan tool's model instructions (`edit (fine in plan mode), then EnterPlanMode, edit the plan file, ExitPlanMode({})…`) | Claude's instructions shown to a person | First sentence of each tool description for people (`Read a room plan.`), mechanics after it; mark `read` read-only (MCP `readOnlyHint`) | **plugin** |
| Plan dialog footer `~/.claude/plans/<her slug>.md` on someone else's plan | Wrong file named | — | **CC** (low impact) |
| `☐ Left room … Thanks for trying sub-human! … Star on GitHub` | Marketing at the end of work | `Left panda-0976`; a feedback ask at most once per home, after a session's 3rd room, never modal at leave | **plugin** |
| `/sub-human:sub-human [invite \| join URL[#SECRET] [PIN] \| join PIN \| help]` | Secrets and PINs in the first thing you see | `argument-hint: "[invite \| help]"` | **plugin**; exact-match Enter: **CC** |
| `← 3 agents` | Native agent-view count | Reap stale room sessions | **plugin** (reap) / native otherwise |
| git `(a git step …)` / `(files that changed …)`, `Allowed by auto mode classifier` | Native Bash diff caveats | — | not sub-human's; report upstream if wanted |

---

## 5. The redesign: one full session, as each person sees it

The conventions follow the real screens. `⏺` is a dim notice (the native `sub-human:` prefix drawn once), `❯` is the person's prompt, and `[status]` is the plugin's single pinned `$.ui.status` line under the prompt, updated in place. Claude's prose stays Claude's, and in these moments it is told to stay quiet unless asked. The right-hand column is the debug log (`$.ui.log(…, {to:"debug"})`, also `<home>/logs/sub-human.log`) and shows where today's lines go.

### maya (opens, authors)

```
❯ /sub-human                                         │ D join: opened panda-0976 seat=maya home=/tmp/scene2/home
⏺ Opened panda-0976                                  │ D rows: room row spawned (agent a3586f), label "panda-0976"
[status] panda-0976 · just you                       │ D skill: no reply text (rows spawned silently)
                                                     │ (gone: "Backgrounded agent", "You're in room…",
                                                     │        "Waiting for 1 background agent")
⏺ dev joined                                         │ D rows: participant row for dev (agent ac8a52)
[status] panda-0976 · maya, dev                      │
❯ @room hi dev! … Going to draft a room plan first.  │ D @room #3 posted 14 ms (receipt suppressed)
  dev: hey maya! … ping me when the plan draft is up │
❯ Please draft a room plan for the paging API …      │ D plan edit: name "paging" (from heading); seed → iridescent-crafting-lynx.md
   … Claude reads the repo, writes the plan …        │ D plan put paging v1 ok (cas base 0); author check opened
  ┌ plan view ───────────────────────────────────┐   │ (gone: red "Error: … saved as room plan room v1, not sent out yet")
  │ > Room plan paging v1 — your draft.          │   │
  │ GET /tasks paging …                          │   │
  │ 1. Yes … 2. … 3. Tell Claude what to change   │   │
  └ Your plan paging v1 · Yes sends it to dev ───┘   │ ← $.ui.notice under the dialog
⏺ Claude: Sent paging v1 to dev.                     │ D review closed (Yes); mode auto kept; plan file restored
[status] panda-0976 · paging v1 · waiting on dev     │
  dev asked for changes to paging v1:                │ D decision a1b2d7: objected dev · agreed maya
    │ Cursor having both createdAt and id is good …  │ (merged: "room: plan room v1 not agreed…" + "› Prompt from …")
⏺ Claude: Want me to work that into v2?              │
❯ yes, clamp to 100 and send v2                      │ D plan put paging v2 ok; author check
  ┌ plan view … └ Your plan paging v2 · Yes sends it ┘│
⏺ Plan paging v2 agreed (you, dev)                   │ D decision f93800: agreed maya, dev
[status] panda-0976 · paging v2 agreed               │
❯ Make two room tasks: store for me, http for dev    │ D task #2 owner maya; task #3 owner dev (assigned, no claim step)
   (task list shows both)                            │ (gone: "only yours is actually assigned…")
❯ @room tasks are up …                               │ D @room #9 posted
❯ build listTasks …, push, tell dev's Claude         │ D sendmessage dev.panda-0976 delivered (unread)
  "Tell dev's Claude listTasks is pushed" → sent …   │ (native SendMessage row; kept)
[status] panda-0976 · dev ◼ http: GET /tasks paging  │ D task #3 in_progress (dev)
[status] panda-0976 · dev ✓ http: GET /tasks paging  │ D task #3 done evidence "945d712, 20/20" → notify skipped (maya busy)
  dev's Claude: handler pushed (945d712), npm test   │ D (peer reply mirrored: dev's Claude answered the hand-off)
    20/20 against your listTasks                     │
❯ yes, mark it done / pull main and run npm test     │ D task #2 done
  dev: both halves are in … heading out!             │
❯ @room main is green … see you!                     │ D @room posted
❯ /sub-human leave                                   │ D leave: seat released; rows STOP (2 rows closed); title → "maya" (sessionTitle)
⏺ Left panda-0976                                    │ D leave card skipped (asked once per home: already asked)
[status] (cleared)                                   │ (gone: "/rename maya", "Session renamed to", "row closed" ×2, the card)
```
maya sees **5 sub-human lines**: Opened, dev joined, the objection (content, one line plus the note), Plan paging v2 agreed, Left. The status line changes 7 times.

### dev (joins, reviews, objects, builds)

```
❯ /sub-human                                         │ D join: one open room on this machine → panda-0976 (picked silently)
⏺ Joined panda-0976 with maya                        │ D rows: room row + participant row for maya
[status] panda-0976 · maya, dev                      │
  maya: hi dev! … Going to draft a room plan first.  │
❯ @room hey maya! …                                  │ D @room posted (receipt suppressed)
                                                     │ D plan paging v1 (maya's draft) — not shown: dev not asked yet
⏺ maya asks you to review plan paging v1             │ D wake: review request a1b2d7 → context-only turn opens the view
  ┌ plan view ───────────────────────────────────┐   │ (gone: "Entered plan mode — Claude is now exploring…",
  │ > Room plan paging v1 from maya, for review. │   │        the duplicate "› Prompt from the sub-human plugin")
  │ … 3. Tell Claude what to change               │   │
  └ Review · paging v1 from maya · Yes agrees ───┘   │ ← $.ui.notice
   (dev picks 3, types the clamp objection)          │
  ┌ Changes ────────────────────────────────────┐    │ D review a1b2d7: note captured; card shown in plan mode
  │ Send these changes on paging v1 to maya?     │    │ (gone: "User rejected Claude's plan: proposal a1b2…",
  │ "Cursor having both createdAt and id …"      │    │        "Exit plan mode? … switch to default", "Exited plan mode",
  │ 1. Send  2. Edit  3. Discard                 │    │        "User answered Claude's questions")
  └──────────────────────────────────────────────┘    │ D objection sent; mode restored → auto (CC: mode-preserving exit)
[status] panda-0976 · paging v1 · you asked for changes │
⏺ maya asks you to review plan paging v2 (your       │ D wake merged: plan v2 line + review request f93800
  change is in)                                      │
  ┌ plan view … └ Review · paging v2 from maya ┘     │
⏺ Plan paging v2 agreed (maya, you)                  │ D decision f93800
⏺ New task for you: http: GET /tasks paging          │ D task #3 owner dev (assigned by maya)
❯ build the handler per v2 …                         │ D guard: mktemp -d allowed (no store path enumerated)
  maya's Claude: listTasks and InvalidCursorError    │
    are pushed to origin main (8b2aab4) …            │ (content; kept as today)
   … Claude pulls, 20/20, pushes 945d712, marks #3    │ D task #3 done; reply to maya's Claude sent
❯ @room both halves are in … heading out!            │
  maya: main is green … see you!                     │
❯ /sub-human leave                                   │ D leave; rows closed; title → "dev"
⏺ Left panda-0976                                    │
```
dev sees **6 sub-human lines**: Joined, two review requests, the decision, the new task, Left. Plus the Changes card, which is the plan view's own follow-up.

A two-plan round like rabbit-3194 adds one request line per version you're asked to review, and one decision line per plan. That puts maya R2 at 7 lines and dev R2 at 6.

---

## 6. Prioritized change list (impact on feel per unit of effort)

| Rank | Change | Where (plugin file:line) | Effort | Issues |
|---|---|---|---|---|
| 1 | **Route machinery to the debug log; delete receipts.** Delete `✓ sent…`; delete `row closed` (redraw that InfoNotice as nothing, or, since a session.append rewrite must keep ≥1 char, swallow it in ui.render); drop the `· …` teaching suffixes on open, join and leave; send each line to `$.ui.log(…, {to:"debug"})` plus `<home>/logs/sub-human.log`. Add `/sub-human debug` (one line) | `hooks/handlers/at-room.ts:156`, `mod/core/prompt.ts:178-181`, `mod/core/rows.ts:54,60`, `mod/rows.ts:99`, `lib/seats.ts:319-320`, `lib/commands/leave.ts:13` | S | #8 (receipt frame becomes moot) |
| 2 | **No red "Error:" on a successful plan save.** Redraw the denied ExitPlanMode capture's ToolResult as nothing (the author's plan view that follows is the receipt); keep `checkNext` as C | `lib/consent/edit.ts:116-120`; new `ui.render` ToolResult hook in `mod/consent.ts` | S-M (verify ToolResult render covers denies) | **#9** |
| 3 | **Sign-off framing that is actually drawn.** Replace the ask reason (`SAY.dialog/dialogDraft`, never drawn on 2.1.296) with `$.ui.notice(tool_use_id, …)` and a one-line heading in the proposal text; rewrite "sign off" → "review / agree" | `lib/consent/review.ts:213-217`, `hooks/consent.ts` (where the proposal is written to the plan file), `lib/room/render.ts:260-261` | S | **#21**, #20 (the same notice can say "this is your own plan" in the escape-hatch case) |
| 4 | **Objection flow: card first, then a single exit; stop claiming the mode is back.** Reorder `rejectedNote` so AskUserQuestion runs in plan mode before the closing ExitPlanMode; on "No" in Exit plan mode, take the `closedHere` path (stay in plan mode, card, S line) instead of a STOP; fix `reviewClosed` text. File the CC request for a mode-preserving exit | `lib/consent/review.ts:225,230,464-474,646`; `mod/consent.ts` (show the card with `$.ui.ask` straight from the tool.call refusal, with no model round) | M (+CC) | **#34** (extends it with maya's No path, the two prompts, and the false "restored") |
| 5 | **A real status line.** Use `$.ui.status` for room state (who's here, plan state, waiting on whom, tasks, offline/queued); make the room row's label static (`agents/room.md` step order; `agent.spawn` description rewrite); remove the row on leave | `statusline/segments.ts` (reuse `rowText`), `lib/rows.ts`, `agents/room.md:12-16`, `mod/rows.ts` | M | #12; G3, G4, G8 |
| 6 | **One line per event.** Merge decision + objection prompt into `dev asked for changes to paging v1:` + note; merge "plan vN" + "asks you to review" into one request; resubmitted wakes go context-only; hide drafts from people not asked; drop the `room:` speaker | `lib/room/render.ts:209-217,255-270,277,285`, `lib/room/deliver.ts`, `mod/deliver.ts:476,756` | M | — (principle 7) |
| 7 | **Open/join is one line and silent for Claude.** Skill says "end your turn without text"; hide the room row's `Backgrounded agent` ToolUse and the `Waiting for N background agents` Spinner for row agents (ui.render) | `skills/sub-human/SKILL.md:14`, `mod/core/deliver.ts:263`, new ui.render hooks in `mod/rows.ts` | S-M | — |
| 8 | **Leave is one line.** `Left panda-0976`; title via `sessionTitle`, not `/rename` (also removes the false "The user named this session"); leave card at most once per home and not at leave, without "Star on GitHub" | `lib/commands/leave.ts:13`, `mod/deliver.ts:657-668`, `mod/core/leave.ts:27-33` | S | — |
| 9 | **Guard: stop blocking scratch work.** Narrow "above the store" to enumerating reads; always allow `mktemp -d` and writes to new paths; tool-position matching per #35 | `mod/core/guard.ts:158,163,628` (and `PERSON_CLI` at `:33` for #35) | M | **#35** (and the family of #10/#30) |
| 10 | **Tasks you assign are assigned.** A person's explicit "for dev" sets `owner`; `New task for you: …` for the assignee; no `asks to claim` lines anywhere; the room's own `room CODE open` task out of every rendering | `lib/tasks.ts:30,285-286`, `lib/room/render.ts:278-287`, `mcp/task.ts:35` | S-M | (#13, #19 were adjacent) |
| 11 | **Plan names people can read.** Slugify silently; first plan named from its heading, not `room` | `mcp/room-server.ts:346`, `lib/plans.ts:33,56,60` | S | — |
| 12 | **Help fits a screen.** About six lines: `/sub-human`, `invite`, `leave`, `doctor`, `help invite`, `@room`. The settings tip moves to doctor "info". One `$.ui.log` with newlines, not 21 rows | `lib/commands/help.ts:8-30`, `lib/commands/answer.ts` | S | — |
| 13 | **Person-readable MCP tool descriptions.** First sentence for people, mechanics after it; `readOnlyHint` on read | `mcp/room-server.ts` (tool definitions), `mcp/task.ts` | S | — (seen only because of #34) |
| 14 | **Reopen a returning pair's room** (same code, same plans) when `/sub-human` finds no open room but a recent one of yours | `lib/seats.ts`, `lib/gc.ts` | M-L | — |
| 15 | **Claude-to-Claude hand-off closes the loop.** When a task done carries evidence and the waiting person owns a sibling task, show the status update and `$.ui.notify` if idle | `lib/room/deliver.ts` (task kind), `mod/deliver.ts` | M | — |
| 16 | Smaller items: argument-hint → `[invite \| help]`; `Consent` header → `Changes`; stub `proposal <hash>` → plan label; no NEST `│` inside submitted prompts; reap stale room sessions (`← N agents`) | `skills/sub-human/SKILL.md:4`, `lib/proposal.ts:199,492`, `lib/consent/review.ts:134`, `skills/sub-human/member.md:8`, render.ts NEST, `lib/room-claude.ts` | XS each | #21 (stub), — |

Not covered by any change above and still open: #15 (a hand edit kept as a draft).

Claude Code requests worth filing: a mode-preserving ExitPlanMode exit for hooks (#34); a hook-settable plan-dialog title and button labels (#21); a non-error deny style (#9); a background-agent kind that doesn't block or count toward "Waiting for N"; exact-match Enter for a plugin's short command name.
