# 3. Presence: who's in the room, what they're doing, and when something arrives

Claude Code 2.1.296. Plugin: `plugin/sub-human` at 0.5.8. All paths are relative to `plugin/sub-human/` unless they start with `/`.

Evidence:
- **Live:** a throwaway `claude` in tmux (`pp-presence`). It ran with an isolated `CLAUDE_CONFIG_DIR=/tmp/probe-presence/cfg`. Login came from the real keychain entry through `CLAUDE_SECURESTORAGE_CONFIG_DIR=""`, the method in `docs/internals/cc-2.1.296-tasks-plans.md`, so nothing was copied and nothing was written to `~/.claude`. The session loaded a test plugin, `/tmp/probe-presence/plugin`, with `--plugin-dir`. The plugin has a hooks module, one background agent, and a `settings.json` that sets `subagentStatusLine`. Raw dumps are in `/tmp/probe-presence/out/`.
- **Docs:** code.claude.com statusline, plugins-reference and components, sub-agents and hooks pages, saved under `/tmp/probe-presence/docs/`.
- **Other sources:** the hooks-module d.ts (`.claude-plugin/types/claude-code/index.d.ts`), the 2.1.296 binary's strings, `lib/cc/contract.json`, and the one other installed plugin with a mod, claude-plugins-official `code-modernization`.

**Verdict.** Don't tune the rows. Retire them. The background-agent rows are fake agents. They can't be made fully quiet, and every fix costs something native. Presence belongs in the prompt footer's right-hand mode slot (`ui.render SessionMode`). It is dim, has no prefix and no ⚠, needs no settings, and is untranscribed. Use the pinned `$.ui.status` line only while something waits on *you*, because Claude Code always draws it yellow with ⚠. Use a `$.ui.log` notice line for arrivals a person must read. Ring `$.ui.notify` (their own notification channel) only for "needs you" items while idle.

---

## 1. What was verified live

| # | Claim | Result | Evidence |
|---|---|---|---|
| L1 | `$.ui.status(text)` shows without the person editing settings | **Yes**, but it is drawn `⚠ <plugin>: text` in **yellow (256-color 220)**, the warning style, whatever the text says. The plugin-name prefix is forced (`y6e(plugin,text)` = `` `${name}: ${text}` ``; `status:` → `addNotification({key:"plugin-status-<p>",kind:"event",priority:"low",pinned:true})`) | screen: `⚠ probe: panda-0976 · maya, dev · dev is building`; binary line with `plugin-status-` |
| L2 | `ui.render SessionMode`, adding to `modes`, shows in the footer | **Yes**: dim gray (246), right-aligned, **no prefix, no glyph**. Its row sits under the mode line when idle and shares the mode line during a turn. It fits at 80 columns: `panda-0976 · maya, dev · dev ✓ http: GET /tasks paging`. It redraws on `$.ui.invalidate('ui.render')` from any hook | screens at 120, 100 and 80 columns |
| L3 | `ui.render PromptHint`'s `tail` adds to the hint line | Yes, dim, but it's cut off at "…" as soon as anything else is on the right (`· panda-0976: de…`). The docs also say a custom `statusLine` hides most hints. **Don't rely on it** | screen |
| L4 | `$.ui.toast` | Outside fullscreen it is a right-aligned line on the notification row for about 4 s (`probe: dev finished http: GET /tasks paging`). It is transient and easy to miss | screen |
| L5 | `$.ui.notify` | Under tmux with `auto`: `{isSent:false, reason:"no-channel"}`. With `preferredNotifChannel:"terminal_bell"`: `{isSent:true, channel:"terminal_bell"}`, and one BEL appeared in the raw stream. In Ghostty or iTerm2 (both installed here; the owner sets no channel, so it's `auto`), `auto` resolves to the terminal's own banner. The person's `Notification` hooks run first, so it respects their setup | `/tmp/probe-presence/out/*notify*.json`, `raw.txt` |
| L6 | `$.ui.log` from a timer while idle (no turn running) | Draws `⏺ probe: maya asks you to review plan paging v1` at once, dim. No turn starts | screen after `/probe-later 4 …` |
| L7 | A **model** Agent call of a `background: true` agent | Shows `⏺ probe:row(panda-0976) ⎿ Backgrounded agent (↓ to manage · ctrl+o to expand)`, then `✻ Waiting for 1 background agent to finish`, then the hand-back starts **two** model turns (`› Message from @probe-row`, `Agent "panda-0976" finished · 6s`) | screen |
| L8 | `✻ Waiting for N background agents to finish` is the **`TurnDuration`** component, not the Spinner. The binary says: "REPL renders the 'Done in Ns' / 'Waiting for N agents' line. From internal SystemMessage 'turn_duration'" | Its props are only `{word, durationMs}`, **with no pending-agent count**. A hook can't tell "Waiting for 1 agent" from "Baked for 3s" | `*-turnduration.json` |
| L9 | Hiding through `ui.render` (returning `<Box/>`) | **Works** for `ToolUse` on `Agent` (the Backgrounded row disappears, retroactively too, after invalidate) and for `TurnDuration`. Hiding TurnDuration also hides every native `Churned for 12s` line, because of L8 | screen after `/probe-hide` |
| L10 | A **plugin** `$.agent.spawn` (no model tool call) | No ToolUse row and no hand-back turn; the transcript stayed empty. It still adds a panel row and a `· 1 shell` footer pill, and it burns about 7k tokens per row | screen; `*-spawn.json` `{agentId, model}` |
| L11 | An `agent.spawn` hook rewriting `description` sets the panel label | Only at first (`◯ probe:row  panda-0976`). **After about 20 s Claude Code's model-written `label` replaces it**: `◯ probe:row  Backgrounding sleep 240 command`. This is the "Spawning dev participant row" defect, reproduced | two screens 20 s apart |
| L12 | A plugin's own `settings.json` `subagentStatusLine` (docs: "Plugins can ship a default `subagentStatusLine`") | **Works with no user setting.** The row reads exactly the plugin's `content` (`◯ panda-0976 · maya, dev · dev is building`) and the model label is gone. **But `${CLAUDE_PLUGIN_ROOT}` is not expanded there** (`root=` was empty), so the command must find the plugin some other way | `sasl-env.txt`, `sasl-input.jsonl` (fields: `tasks[].{id,agentType,status,description,label,…}`, `columns`) |
| L13 | A row whose agent finished but left a shell running | It stays in the panel (status `completed`) as long as the shell lives | screen |

From the binary (not run live):
- **B1.** The native task view and the TaskList tool filter out tasks with `metadata._internal`: `filter(a=>!a.metadata?._internal)`. The same filtered list feeds the "all completed → reset" check. So `_internal` would hide bookkeeping task #1, but then it would no longer hold off the 5 s auto-reset (`contract.json` task-list-auto-reset).
- **B2.** `$.ui.status` is app state only. Nothing is transcribed, and `--resume` doesn't redraw it (`contract.json` module-ui-status-untranscribed).

What other plugins do:
- **code-modernization** (claude-plugins-official), the only other installed plugin with a mod, uses `$.ui.status` for a one-line summary only while its pane is closed, a Pane and an AbovePrompt band for rich state, and `$.ui.toast` / `$.ui.log` for events (`hooks/register.ts:69-71,148,771-800`). It spawns no rows.
- **Community status lines** (ccstatusline, starship-claude) need the person to edit `statusLine`. A plugin can't set `statusLine`: only `agent` and `subagentStatusLine` take effect from a plugin.
- **sub-human 0.5.x** asks people to paste a `subagentStatusLine` (the help tip) that hardly anyone will paste.

---

## 2. The four questions

### (1) Can the rows be made quiet? Partly, at a native cost. Replace them.

| Noise | Quiet-row fix | Cost or leftover |
|---|---|---|
| `⏺ sub-human:room(code) ⎿ Backgrounded agent…` | Spawn from the module with `$.agent.spawn` (L10), or hide the ToolUse (L9) | none |
| `✻ Waiting for N background agents` | Hide `TurnDuration` (L9) | It also hides every native `Baked for Ns` line, because props carry no count (L8). Not native |
| Model-written label (`Spawning dev participant row` for 13 min) | Ship `subagentStatusLine` in the plugin's `settings.json` (L12) | `${CLAUDE_PLUGIN_ROOT}` is not expanded, so the command must be `"$HOME/.sub-human/bin/row-status"`. That breaks for a non-default `SUB_HUMAN_HOME`, and a person's own `subagentStatusLine` overrides it |
| Row still listed after leave | `hold` returns STOP; the row ends | It lingers for seconds; a stray shell keeps it (L13); the hand-back of a model-spawned row still starts turns, which today makes the `row closed` warnings |
| `row closed` | `$.agent.spawn` rows don't hand back (L10) | — |
| Footer `· 1 shell` / panel `↓ to manage` | none | always there |
| Tokens and machinery: `mcp/hold.ts` (386 lines), 4 row handlers, the row map, the ROWS block, rewake | none | about 7k tokens per row per spawn; the respawn races behind G3 and G4 |

A row is also a lie in Apple terms. It sits in the *agents* panel, where you can open it and type into it ("read-only row — type in main with @room"), but it does nothing. PRINCIPLES B says "a member is a background agent in the agent panel". The evidence argues against it: people read it as Claude doing work. **Recommendation: delete the rows**, both the room row and the participant rows, in member sessions and in the room session.

### (2) Where presence lives: the footer's mode slot

| Surface | Without the person editing settings? | Look | Verdict |
|---|---|---|---|
| `statusLine` (main) | **No**: a plugin can't set it | — | out |
| `subagentStatusLine` | Yes, from the plugin's `settings.json` (L12) | per agent row | only useful with rows; out with them |
| `$.ui.status` | Yes | `⚠ sub-human: …` in **yellow** (L1) | right for "this waits on you", wrong for ambient presence |
| `ui.render SessionMode` | Yes | dim, right-aligned, no prefix (L2) | **ambient presence** |
| `PromptHint.tail` | Yes | dim, cut short (L3) | out |
| AbovePrompt band / Pane | Yes | a framed band or pane | too heavy for one line; keep for a future `/sub-human` room view |

So `panda-0976 · maya, dev · dev is building` goes in **SessionMode**, with no settings edit. It is the slot Claude Code uses for its own session modes (`focus`, `memory paused`; the d.ts says other modes are joined with ` & `). It reads as a mode of the session, which is what being in a room is.

**What "doing" can honestly say.** The plugin knows each member's presence document (`working`, `idle`, `permission`, `error`, from `hooks/handlers/presence.ts`), their open task (`lib/rows.ts openTask`), their last status, and plan states. It **can't** know typing. So it says `dev working`, or better `dev ◼ http paging` while dev has an in-progress task and a turn running, then `dev ✓ http paging` for a few minutes after the task is done. It never says "typing".

The slot shows one phrase, chosen in this order:
1. link trouble (`offline 2m · 1 queued`);
2. the newest peer event less than 10 minutes old (`dev ✓ …`, `+jess`, `−dev`);
3. a peer with a turn running on a task (`dev ◼ …`);
4. nothing.

The phrase is capped at about 48 characters, and the people list collapses to `3 here` beyond three names.

### (3) Arrival: three tiers, one surface each

| Arrival | Transcript (`$.ui.log`) | Footer (SessionMode) | Pin (`$.ui.status`, ⚠) | Ping (`$.ui.notify`) | Claude |
|---|---|---|---|---|---|
| Person's `@room` words, not to you | `dev: …` | — | — | no | context at next turn |
| Words **to you** / `@maya` | `dev: …` | — | — | **yes, if idle** | wake (as today) |
| Plan needs your review | `maya asks you to review plan paging v1` | — | `review paging v1 from maya` until answered | **yes, if idle** | wake opens the view |
| Plan decided (yours or one you're in) | `Plan paging v2 agreed (you, dev)` | — | cleared | no | context |
| Task assigned to you | `New task for you: http: GET /tasks paging` | — | — | yes, if idle | wake |
| Peer's task done | — | `dev ✓ http: GET /tasks paging` | — | **yes, if idle and you own an open task in the same plan or room** (the "didn't notice" gap, G8), with a notice line `dev finished http: GET /tasks paging` | context |
| Peer's Claude messages your Claude (SendMessage) | native row (kept) | — | — | no (your Claude acts) | native |
| Join / leave (not the opener) | — (host: `dev joined`) | `+dev` then the list | — | no | context |
| Link down / up / queued | — | `offline 2m · 1 queued` | only if a post is finally lost | no | context |

Rules:
- **Ping only when idle.** No turn is running (`turns.running === null` in `mod/deliver.ts`), and nothing has been typed for 15 s or more (the module sees `PromptHint.isDraft`).
- **At most one ping per 60 s**; a later one in the window waits for the window to close. The body is exactly the notice line. Claude Code's own `idle_prompt` notification goes the same way, so this is the native attention channel, and the person's channel setting and Notification hooks govern it.
- **No toasts.** They are transient and duplicate the notice.
- **No bell when focused.** The plugin can't see focus, so idle-plus-quiet stands in for it.
- **Claude never restates an arrival.** That's the C tier, already in `mod/core/constants.ts:47` (the FYI pull). Claude mentions it only when asked or when it changes Claude's own next step.

### (4) What the person never sees

| Thing | Today | Fix |
|---|---|---|
| The room session (`claude --bg`, member `claude`) | `← 3 agents` in the agent view; a "claude" member in lists | It stays listed while it lives, because no flag hides a `--bg` session from the agent view (`claude agents --help`). Reap it on room close (`lib/room-claude.ts`), never spawn rows in it, and filter `claude` out of every people list (`lib/rows.ts memberList` → `name !== 'claude'`). On one machine with two people, `← 2 agents` is real (the other person) and is native |
| Bookkeeping task #1, `room CODE open` | a visible task in the task list | Mark it `metadata._internal: true` (B1 hides it from the view and from TaskList). This needs the task-list research's answer on the reset (B1: the filtered list feeds the reset check). Otherwise give it a person-shaped subject. Drop it from every rendering now (`lib/tasks.ts:30,93-95`, `render.ts:278-287`) |
| Hint suffixes | `· on this machine others join with /sub-human; another machine: /sub-human invite`, `· @room to talk; your Claude can …`, `· /sub-human joins again`, `(Claude wasn't asked)`, `(claim it to take it)` | Delete them: `lib/seats.ts:319-320`, `lib/commands/leave.ts:13`, `hooks/handlers/at-room.ts:156`, `lib/room/render.ts:283-285` |
| `row closed`, link down/up lines, `SUB-HUMAN ROWS` | transcript | Gone with the rows; link state goes to the footer |

---

## 3. Mocks (terminal, 100 columns, not fullscreen)

`⏺` is a notice line (Claude Code draws the `sub-human:` prefix). The two lines under the prompt rule are the footer: the mode line, then the right-aligned SessionMode slot (when idle they are on separate rows; during a turn they share one). `⚠` is the pinned `$.ui.status`.

**Idle, not in a room.** Nothing from sub-human.
```
──────────────────────────────────────────────────────────────────────────────────────────────────
❯
──────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
```

**Just joined.** One line. No Agent row, no `Waiting for…`, no panel rows.
```
❯ /sub-human
⏺ sub-human: Joined panda-0976 with maya
──────────────────────────────────────────────────────────────────────────────────────────────────
❯
──────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
                                                                            panda-0976 · maya, dev
```

**Peer building** (dev's turn is running on task #3; maya's view).
```
──────────────────────────────────────────────────────────────────────────────────────────────────
❯
──────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
                                                   panda-0976 · maya, dev · dev ◼ http: GET /tasks
```
While maya's own turn runs, the same slot shares the line:
```
  ⏵⏵ auto mode on · esc to interrupt · ← for agents            panda-0976 · dev ◼ http: GET /tasks
```

**Message arrives** (dev's `@room` words; maya idle). If the line is addressed to maya, the terminal also notifies once.
```
⏺ sub-human: dev: hey maya! I'll take the HTTP handler; ping me when the plan is up
──────────────────────────────────────────────────────────────────────────────────────────────────
❯
──────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
                                                                            panda-0976 · maya, dev
```

**Peer finished** (maya idle, owns task #2 in the same plan): one line, the footer changes, one ping.
```
⏺ sub-human: dev finished http: GET /tasks paging
──────────────────────────────────────────────────────────────────────────────────────────────────
❯
──────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
                                                 panda-0976 · maya, dev · dev ✓ http: GET /tasks …
[Ghostty banner]  panda-0976 — dev finished http: GET /tasks paging
```

**A plan needs you.** One line, the yellow pin until answered, and one ping if idle. The wake opens the plan view in its own turn (today's flow). Mid-turn, the pin waits and the review opens after the turn.
```
⏺ sub-human: maya asks you to review plan paging v1
──────────────────────────────────────────────────────────────────────────────────────────────────
❯
──────────────────────────────────────────────────────────────────────────────────────────────────
  ⚠ sub-human: review paging v1 from maya
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents                       panda-0976 · maya, dev
[Ghostty banner]  panda-0976 — maya asks you to review plan paging v1
```
After the decision: `⏺ sub-human: Plan paging v2 agreed (maya, you)`, and the pin clears.

**Link down.** No transcript lines.
```
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
                                                               panda-0976 · offline 2m · 1 queued
```

**After leave.** One line; the slot and the pin clear; no `row closed`, no rows, no `/rename` echo, no card.
```
❯ /sub-human leave
⏺ sub-human: Left panda-0976
──────────────────────────────────────────────────────────────────────────────────────────────────
❯
──────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
```

---

## 4. Code changes (file:line at 0.5.8)

### Remove the rows
- `agents/room.md`, `agents/participant.md`: delete. `agents/room-claude.md:4`: tools `Agent(sub-human:participant)` → none; body: "end your turn with ok".
- `mcp/hold.ts` (386 lines): delete. `mcp/room-server.ts:62`: `PLUGINS = ['task.ts']`. `mod/guard.ts:110` and the `mod/register.ts:40` HOOKS entry: delete the hold deny.
- `mod/rows.ts` (whole file) and `mod/register.ts:20,53-59,69`: delete. Keep only `TOOLS_DOWN*` / `toolsDownStep` from `mod/core/rows.ts:75-83`; move them to `mod/core/prompt.ts` and delete the rest of `mod/core/rows.ts` (`ROW_ENDED`, `ROW_CLOSED`, `rowEndedRow`, handback regexes).
- `mod/core/prefilter.ts:30` `rowsNeeded`: delete.
- `hooks/run.ts:33-36` and `hooks/handlers/row-{guard,map,hold,rewake}.ts`: delete; drop the rewake call in the `classic.SessionStart` path (`mod/deliver.ts`, HOOKS line 30).
- `hooks/context.ts:70-114` (ROWS section, `rowCalls`, `compactRows`), `:36`; `hooks/handlers/session-restore.ts:25,53`: remove ROWS.
- `skills/sub-human/SKILL.md:14`: "end your turn without text". Remove the ROWS clause; same for `skills/sub-human/room-claude.md:2` and `mod/core/deliver.ts:263`.
- `lib/tail.ts:115,360-384` (`missingRowsText`, `SPAWN_GRACE_MS`): delete; `sendRows` (`:600-610`) keeps only `remindersText`.
- `mod/prompt.ts:28,34,147-160` (held rows, `rowsInjected`, `ROWS_DOWN`): reminders only.
- `lib/rows.ts`: delete `rowCalls`, `participantCall`, `roomCall`, `parseSpawn`, `recordRow`, `forgetRow`, the row maps, holds, `missingRows`, `joinNote`, block counts (the `:568-571` export list). Keep `rowText`, `participantText`, `roomText` and `presenceOf` (`:413-560`) as the source of presence words.
- `statusline/` and the `agent-statusline` command (`lib/cli/main.ts:16,167,420,434,447`), `<home>/bin/row-status`, and the README "Rows" / `lib/commands/help.ts` tip: delete.

### Add presence (footer)
- **`lib/rows.ts`: new `presenceLine(code, viewer)`** → `panda-0976 · maya, dev · dev ◼ http: GET /tasks` (≤ 60 chars, choosing the phrase as in §2.2). It is built from `memberList` without `claude` (`:137-141`), `openTask` without `_internal` tasks (`:407-411`), `presenceOf`, the last task-done or join/leave entry under 10 minutes old, and `linkState.read` for `offline 2m · N queued`. No colour.
- **`lib/tail.ts`**: a new event `{type:'presence', text|null}`, emitted on change on the same tick as `sendRows`/`linkHealth` (`:600-625`). `linkHealth` stops emitting `health` for down/up/back (`:621-623`) and emits only a lost-posts line. The doc comment goes at `:17-35`.
- **`mod/core/deliver.ts:87-100` (parse) and `:133-140` (route)**: `case 'presence'` → `{do:'presence', text}`; `case 'health'` keeps `append` for Claude but logs only `lost` lines.
- **`mod/deliver.ts:404-430` `apply`**: `case 'presence'`: keep the text in module state and call `$.ui.invalidate('ui.render')`. On a seat going null (`case 'seat'`) and on leave (`:657-668`), clear it and call `$.ui.status(undefined)`.
- **New hook `ui.render { component: 'SessionMode' }`** (in `mod/deliver.ts`, plus a HOOKS row in `mod/register.ts`): `next(text ? {...e, props:{...e.props, modes:[...e.props.modes, text]}} : e)`, with `.catch` passing `next(e)`.

### Arrival
- **`lib/room/deliver.ts:5-35,120-130`**: add an `attention` flag beside the class (`notice`/`wake`). It is set for to-me / @me words, a proposal asking me, a task assigned to me, and a task done in a plan or room where I own an open task. The tail carries it on the `chat` and `wake` events.
- **`mod/deliver.ts` (`case 'log'` `:417` and `submitWake`)**: when `attention`, `turns.running === null`, no draft and 15 s quiet (watch `PromptHint.isDraft`; `mod/consent.ts:212` already observes it, so share it), and no ping in the last 60 s → `$.ui.notify(line, {title: code})`. Never toast.
- **Pin**: when a review request for this seat arrives, `$.ui.status('review <plan> v<N> from <name>')`, cleared on the decision or answer (consent's `reviewOpen` state, `mod/consent.ts:68-70`). `pinStatus`/`unpin` (`mod/deliver.ts:484-501`) already own the slot for invites. Make it one owner with priority: invite PIN > review waiting > unsent note (`lib/consent/review.ts:253`) > lost posts.
- **New line kinds** in `lib/room/render.ts`: `<name> finished <task>` (for the attention case only) and `New task for you: <subject>` (`:283-285`). Drop `room:` (`:277,285`).

### Never shown
- `lib/rows.ts:137-141`: exclude `claude`. `lib/tasks.ts:30,93-95`: `_internal: true` on the room task, once the task-list researcher confirms the reset behaviour (B1). Until then, filter it out of every sub-human rendering.
- Suffixes: `lib/seats.ts:319-320`, `lib/commands/leave.ts:13`, `hooks/handlers/at-room.ts:156`, `lib/room/render.ts:283-285`.
- `lib/room-claude.ts`: reap the `claude.CODE` bg job on room close, so `← N agents` counts only real sessions.

### Tests and contract
- `lib/cc/contract.json`: add `module-ui-status-warning-style` (L1: `⚠` and the prefix are forced), `session-mode-render` (L2), `turn-duration-waiting` (L8: no count in the props), `plugin-settings-root-unexpanded` (L12) and `task-internal-filter` (B1).
- Delete `test/hooks/row-hooks.node-test.ts` and the row tests in `mod/test/`. Add tests for `presenceLine` (ordering, the 10-minute window, the `claude` and `_internal` filters, offline) and for the ping gate (idle, quiet, 60 s).

---

## 5. Risks and open points
- SessionMode is drawn on terminal and desktop only, so a remote surface (Remote Control, the mobile app) shows no presence. Acceptable: the notices still arrive.
- If the person enables a custom `statusLine`, the footer layout changes. SessionMode was not probed with one set (worth one check).
- The ⚠ yellow pin is fixed. If the owner finds it alarming for "review waiting", the fallback is the notice line alone, plus SessionMode carrying `· review waiting`.
- `$.ui.notify` under tmux needs `preferredNotifChannel` (it was `no-channel` here); in Ghostty or iTerm2 directly, `auto` works. Doctor can say this once as info.
- If the owner still wants members in the agent panel, the least-bad version is: `$.agent.spawn` from the module (L10); the plugin `settings.json` `subagentStatusLine` with `"$HOME/.sub-human/bin/row-status"` (L12); and the ToolUse hide (L9). It still costs the `1 shell` pill, tokens, a TurnDuration that can't be hidden selectively, and a label that breaks outside the default home.

Probe artifacts: `/tmp/probe-presence/{plugin,out,docs,launch.sh}`. Nothing under `~/repos/sub-human`, `~/.claude` or any room home was changed.
