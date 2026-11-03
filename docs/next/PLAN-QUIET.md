# Quiet: sub-human's output and experience

Status: plan, 2026-11-02. Nothing in it is built yet. The owner decided D1, D3 and D4 the same day; D2 is open (see Decisions).

Guiding principle: **as if Apple designed it: it just works.** The owner's three priorities, in order:

1. **Handle it behind the scenes.** The plugin does the work and doesn't narrate it.
2. **Feel native.** It uses Claude Code's own surfaces, words and behavior, as if sub-human were built in.
3. **Don't overshare.** A message appears only when the person must act on it or would otherwise miss it. Everything else goes to a debug log.

Evidence and research, all in `docs/next/quiet/`:

| File | What it is |
|---|---|
| PRINCIPLES.md | 12 principles, the five tiers, and the message budget |
| EVALUATION.md | A recorded two-person scene on 0.5.8. Every line is in a ledger, with its source verified (plugin vs Claude Code). There are 68 sub-human lines against a target of about 24. |
| SURFACES.md | Every surface Claude Code 2.1.296 gives a plugin, each checked live in a probe session |
| REVIEW.md | How a person should review someone else's plan, with five candidates tested live |
| PRESENCE.md | Who's in the room and how arrivals are shown. The rows are tested live. |
| COPY.md | All 1,165 strings in the plugin, plus the style guide, canonical lines, debug channel, help and leave card |

## The diagnosis in four lines

- **It narrates its own machinery.** Receipts, restores, retries, link flaps and setup tips all print as transcript lines.
- **It borrows surfaces whose meaning doesn't fit.** A plan sign-off uses "Ready to code?". Room members appear as "background agents" that look busy. A successful save is labelled "Error:".
- **Claude's instructions leak to the person** in four ways: wake prompts drawn with their `(for Claude)` lines, deny reasons in red, tool descriptions in permission prompts, and hex ids.
- **What a person needs is missing.** maya never saw that dev had finished. The objection path cost dev his auto mode. The `claude` member and bookkeeping task #1 are visible.

## Tiers: where every line goes

Each line is declared with its tier where it's written, using one helper per tier: `person()`, `state()`, `claude()`, `debug()`.

| Tier | Surface (verified on 2.1.296) | Gets |
|---|---|---|
| **Person** | `$.ui.log` notice: one `⏺ sub-human: …` line | Other people's words; a request that needs you; a decision; "New task for you"; a failure only you can fix, with one action |
| **Decision** | The plan view, for the room's plan; `$.ui.ask` | Agree or ask for changes; let someone in; the leave card |
| **State** | The agent-panel rows (a fixed label through the plugin's own `subagentStatusLine`); the band while something waits on you | Who's here, who's building and who's done, offline or queued |
| **Away** | `$.ui.notify` | Something needs you while you're idle (at least 15 s quiet, at most once a minute) |
| **Claude** | `additionalContext`, `$.session.append` isMeta, tool results | Everything Claude needs. It's never drawn and never restated. |
| **Debug** | `$.ui.log({to:'debug'})` plus `~/.sub-human/logs/sub-human.log` | Receipts, recoveries, fallbacks, lifecycle, exceptions |

Never used for ambient state: `$.ui.status` (always amber `⚠`), the UPS `continue:false` / block frames ("Operation stopped by hook"), the Stop hook's `additionalContext` ("Ran 1 stop hook"), and `structuredContent` (it replaces the text for both Claude and the person).

## The target session

**Budget:** 6 lines or fewer per person per session, down from 14–20 today. Every line below is a person-tier line. Everything else is in a row, in the plan view, or in the log.

```
❯ /sub-human
⏺ sub-human: Joined panda-0976 with maya                                   (today: hook line + Claude's echo + hint suffix)
                                                         agent panel → panda-0976 · maya, dev

❯ @room hey, I'll take the HTTP side                                        (no "✓ sent": the prompt row is the receipt)
⏺ sub-human: maya: great, plan's coming up

Plan paging v1 is ready   1: Open                                           (a band above the prompt if mid-turn)
  └ plan mode: "Room plan · paging v1 · Yes agrees · Tell Claude what to change asks for changes"
               then the plan, formatted and scrollable; mode stays ⏵⏵ auto mode on
⏺ sub-human: Plan paging v1 · you asked for changes: "clamp limit at 100, don't 400"
⏺ sub-human: Plan paging v2 agreed

⏺ sub-human: New task for you: http: GET /tasks paging
                                                         room row → panda-0976 · maya ✓ store: listTasks
⏺ sub-human: maya's Claude: listTasks is pushed (8b2aab4)                   (Claude to Claude, the one line that matters)
  ↓ enter the room row, type "maya, how's the store side going?" → it answers from her task and activity

❯ /sub-human leave
  ╭ Left panda-0976. ─ 1. Done  2. ★ Star sub-human  (type to send feedback) ╮   (once per install)
```

`debug.log` for the same session (`/sub-human debug tail`):

```
21:03:12 join   seat dev · room panda-0976 · room row spawned
21:03:40 at-room #4 posted 14ms
21:05:02 consent plan view opened · paging v1 (maya's edit)
21:05:55 consent changes sent · paging v1 · mode auto kept
21:09:40 link   dropped (ECONNRESET) · back in 1.2s · 0 queued
21:16:31 leave  title restored · task list reaped · card shown (1 of 2)
```

## Phases

Each phase ships on its own, and the order follows impact per unit of effort. File:line references are to 0.5.8. The research docs list each change in full.

### Phase 0: foundations, no visible change

- **One debug log.** `lib/log.ts` `debug(src, msg, {lvl, room, code, err})` writes JSONL to `<home>/logs/sub-human.log`. It rotates at 1 MB and keeps 3 files, and the existing masks are applied. It replaces eight scattered logs: `logError` stderr (`hooks/reply.ts:61`), the ad-hoc stderr in 6 hooks, `mcp-debug.log`, `module.log`, and the tail's `errorLog`. The link and listen daemon logs follow. The hooks module writes through `$.ui.log({to:'debug'})`, which feeds `claude --debug` for free, plus a per-session ring file. See COPY §4.
- **Tier helpers** `person / state / claude / debug`. Each existing call site is moved to one helper, so a code reviewer can see every tier choice.
- **Contract and gate.** Add an entry in `lib/cc/contract.json` for each new surface (band, SessionMode, `ui.render` ToolUse/ToolResult/TurnDuration and the plan-mode rows, `$.agent.spawn`, plugin `subagentStatusLine`, toast, notify, `$.store`), plus a gate in `mod/core/cc.ts:21`. Each new surface needs a stated fallback.
- **A line-budget test**, as a ratchet like the ts-ratchet. A scripted two-seat scene counts person-tier lines per phase and fails if the count rises.

### Phase 1: the quiet pass (words only, no new surfaces). Expected 68 → about 30 lines

- **Canonical lines** (COPY §3.1, about 50 moments): `Opened panda-0976`, `Joined panda-0976 with maya`, `Left panda-0976`, `Plan paging v1 is ready · maya's edit`, `Plan paging v1 · dev asked for changes:`, `Plan paging v2 agreed`, `New task for you: …`. The plan lines override COPY §3.1's "maya asks you to review", by the owner's decision on shared ownership. Errors take one form: `<what didn't happen>. <one action>.`
- **One speaker.** Use Claude Code's own `sub-human:` prefix. Drop `room:` and the literal `sub-human: sub-human:` (`hooks/consent.ts:644`).
- **Delete receipts and hints, sending them to the debug log:**
  - `✓ sent` (`at-room.ts:156`, `mod/core/prompt.ts:181`);
  - `row closed` (`mod/core/rows.ts:60`);
  - the open/join/leave hint suffixes (`lib/seats.ts:319-320`, `lib/commands/leave.ts:13`);
  - `restoring this session's rows` (`mod/core/deliver.ts:283`);
  - `Claude Code X isn't verified` (`mod/core/cc.ts:57`);
  - the bypass-mode warning (`constants.ts:61`);
  - link down/back (`lib/tail.ts:412-431`);
  - the delivery error when nothing was lost (`mod/core/deliver.ts:27`).
- **Claude's text stays Claude's** (COPY §3.2):
  - Wake prompts carry their state lines as additionalContext and not as prompt lines (`lib/tail.ts:351`).
  - A busy-turn wake is resent as context only (`mod/deliver.ts:476,756`).
  - The review denies get a `context` field, so the red reason is empty.
  - Remove the false "the mode is restored" (`review.ts:230`).
- **No echoes.** The skill and TAKE_CONTEXT say "end your turn without text" (`SKILL.md:14`). Drop "Tell the person once…" and "Tell X what changed".
- **Tool descriptions read like a person wrote them**, which matters because they show in permission prompts:
  - Each description opens with a plain first sentence; `read` gets `readOnlyHint`.
  - Parameters are renamed, with the old names kept as aliases: `approvers → reviewers`, `suggest → for`, `object → changes`, `claim → take`.
- **Readable plan names.** The default name comes from the plan's first heading, not `room` (`lib/plans.ts:33`). Names are slugified silently instead of refused. No hex ids are shown: the stub is the plan label (`hooks/consent.ts:417`).
- **The vocabulary is fixed:**
  - In: room, name, Claude, message, plan `name vN` (always the room's plan; an author is "maya's edit", never "maya's plan"), task, invite, review, agree, ask for changes, host.
  - Out: seat, proposal, row, card, sign off, "not sent out yet", "Claude wasn't asked".
- **Help fits a screen.** It's 6 lines; topics (`help invite|join|host|debug`) hold the rest. The argument hint becomes `[invite | leave | help]`.
- **Invite in one line.** `Invite ready until 18:16 · line and PIN below the prompt`, plus `Copy the invite?`. Rules, install and ssh notes move to `help invite` (`lib/remote/hosting.ts:143-242`).
- **Leave in one line, with the agreed card:**
  - `Left <code>.` with the options **Done** and **★ Star sub-human** (one keystroke, via gh), and the native free-text row kept for feedback.
  - It shows once per install, and stops once starred or after two dismissals (`$.store`, `mod/core/leave.ts`).
  - The `/rename` echo becomes a silent `sessionTitle`.
- **`/sub-human debug`** answers in one line (`tail | on | off | share`). Doctor gains "Recent problems", read from the log.
- **Copy that code depends on changes in the same commit** (COPY §3.3): the `TROUBLE` regex (`join.ts:40`), `linkJoined`, `QUESTION_RE`/`choiceOf`, `SPAWN_NOTE`, and `leaveOutcome`'s labels. Each becomes a structured flag instead of a text match.
- **Bugs found along the way:**
  - "typed your PIN" for a request that came without one (`lib/cli/host.ts:135`);
  - a lock path shown to people (`lib/lock.ts:171`);
  - raw `claude --bg` errors;
  - the host's refusal pasted into the joiner's error.

### Phase 2: the room's plan, in plan mode, made right. Closes #34, #21, #9

**The owner's decision (2026-11-02):** plan review stays in plan mode, because it's the best reading experience: the plan is formatted and scrollable. The perception to aim for: **it never feels like someone else's plan.** Everyone works on the room's plan. So the words drop the "maya asks you" framing, and the mechanics stop showing.

- **Shared ownership in the words.**
  - A new version arrives as `Plan paging v2 is ready · maya's edit` (not `maya asks you to review…`).
  - A decision reads `Plan paging v2 agreed` (everyone) or `Plan paging v2 · dev asked for changes: "…"`.
  - Asking for changes is a note on the room's plan, not a rejection of a person.
  - The words are the same for the author and for the reviewer. The author's own check is just the first review.
- **The plan text carries the frame.** The plugin's explanatory line is never drawn on that dialog (verified live), so the only reliable place for it is the plan text. The first line is a dim heading: `Room plan · paging v2 · Yes agrees · Tell Claude what to change asks for changes`. The plan follows, as written.
- **Arrival through the band (D4):** `Plan paging v2 is ready   1: Open`. It shows mid-turn without interrupting. When idle, the plan view opens at the next turn as today.
- **The mode survives (#34):**
  - The Send/Discard choice comes first, while still in plan mode. The plan view then closes once, with a non-empty plan, so Claude Code offers the person's own mode.
  - "No" on the exit question keeps the note and asks once more.
  - The false "the mode is restored" text is deleted.
  - **Spike first:** confirm the non-empty exit keeps auto on 2.1.296. A hook can't set the mode itself, because `setMode` comes only with a PermissionRequest allow, which the design rules forbid.
- **Remove the plan-mode noise with `ui.render` (D4):**
  - the successful save drawn as a red `Error:` (#9) → nothing;
  - `Entered plan mode · Claude is now exploring…` when only reviewing → nothing;
  - `User rejected Claude's plan: ╭ proposal a1b2… ╮` → `Asked for changes to paging v2`.
  - **Spike:** find whether the ExitPlanMode dialog's "Ready to code?" title can be redrawn. If it can, it becomes `Room plan · paging v2`. If not, the heading line above carries it, and the title goes to the requests for Claude Code.
- **Each plan gets its own plan file,** named after the plan, so the footer never shows the person's own unrelated plan path.
- **Fallbacks stay as they are:** the `$.ui.ask` question, then MCP elicitation.

### Phase 3: one room row you can enter. **The owner's decision**

**The owner's vision:** the agent panel shows **one row, the room.** Enter it and you see every person in the room. From there you can DM someone or ask how their work is going. The per-person participant rows go, so the panel is never a list of people at the top level.

**The row in the panel** is quiet. Its fixed label comes from the plugin's own `subagentStatusLine` (in the plugin's `settings.json`, with no edit by the person):

```
panda-0976 · maya, dev · dev building http: GET /tasks
```

- It ends with the room: an ended row draws `""`, so it disappears.
- The stale `Spawning dev participant row` label, the `(+1)` and the `← 3 agents` count all go with the participant rows.

**Inside the room:**

```
panda-0976
  maya   ✓ store: listTasks          idle
  dev    ◼ http: GET /tasks paging   building
  you    (dev)

  Type to talk: "maya, how's the store side going?" · "tell dev the cursor is base64url"
```

- **The roster** is a list of people only. The room's `claude` member and bookkeeping task #1 are never listed.
- **A DM:** "tell maya …" sends maya a direct message. She sees one line, `dev → you: …`. Her reply comes back into the room row. This is a new lane between two people: it isn't posted to the room's chat, but it's signed and stored like any entry.
- **"How's it going?"** is answered from what the room knows (the person's task, recent activity, whether they're in a turn), without interrupting them. If the question needs their Claude, the row passes it on Claude to Claude (`SendMessage` to `maya.CODE`), and the answer comes back into the row.

**The room row is the chat** (spike: `quiet/ROOM-ROW-SPIKE.md`, which works in the terminal on 2.1.296):

```
⏺ panda-0976
    maya   ✓ store: listTasks          idle
    dev    ◼ http: GET /tasks paging   building
❯ the deploy is green, merging paging v2              ← your exact words, to the room (no receipt: the ❯ row is it)
⏺ maya: pushed the cursor change                      ← arrives while you're in main too
❯ tell maya the cursor is base64url                   ← a DM
⏺ maya (DM): ok, switching the encoder now
❯ how's dev doing?
⏺ dev · ◼ http: GET /tasks paging · building · last edit 2m ago
```

- **Mechanism:**
  - `$.agent.spawn` the room agent, which starts a keeper child that blocks in `hold`. The plugin answers every step of both through `turn.step`, so no model is ever asked.
  - The person's typed text arrives in `session.append` (`agentId`, `origin: composer`), verbatim. It's posted as is, sent as a DM for "tell NAME …", or answered from room state for "how's NAME".
  - Incoming lines and roster refreshes go through `$.session.send`, which the plugin answers itself.
  - `ui.render`, scoped per message, hides the spawn prompt and the keeper block. It also replaces "Waiting for N background agents".
  - The label comes from the plugin's own `subagentStatusLine`.
- **Costs:** Claude Code's agent summarizer makes about one call per spawn. Never let `hold` tick, or it becomes one call every 30 s.
- **`@room` stays** as the quick way to post from the main prompt, and on surfaces with no row (the desktop app and VS Code can't type into a background agent). People's lines still show once in main, and reach Claude as context, wherever they were typed.
- **What has to pass before `@room` could be retired:**
  - a row on every surface people use;
  - contract entries and canary checks for `session.append` composer, `turn.step` answers and `$.session.send`;
  - a ruling on provenance (answered steps are recorded as model-written);
  - lifecycle tested: Esc/`x`, the keeper dying, `--resume`, `/clear`, compaction.

**What changes:**
- **Delete** `agents/participant.md`, the participant spawns in `agents/room.md`, and the nested-row bookkeeping in `mod/rows.ts` and `mod/core/rows.ts`. That leaves one row per member session instead of 1 + N, so about 7k tokens per spawn instead of 7k × (N+1).
- **The room agent** goes from `Agent(sub-human:participant)` + `hold` to `hold` + `dm` + `status`. Its brief: "this is room panda-0976; what you type here goes to the people in it". Spawn it from the module (`$.agent.spawn`): no `⏺ Agent(…) Backgrounded agent` block, no hand-back turns, no `row closed`.
- **The room session's panel** (`claude --bg`, which the person never sees) holds no participant rows either. It keeps only the task list.
- **`Waiting for N background agents`** is redrawn as the normal `✻ Done in 3s` with `ui.render` while the room row is the only pending work.

**Spiked (2026-11-02):** typed input, drawing without a model turn, and spawn/label all work in the terminal. A DM shows your words once, as typed, with no consent card.

**Still open:** the lifecycle cases above, and the provenance ruling.

**Also:**
- Reap the room's `claude --bg` session when the room closes.
- A person's own `subagentStatusLine` overrides the plugin's. Doctor says so.

### Phase 4: the guard stays out of the way. Closes #35

- Match `PERSON_CLI` only in tool position (`toolAt`/`toolOf`), not as raw text.
- Always allow `mktemp -d`, `~/.claude/projects/**/tool-results`, and `<home>/logs/`.
- Each deny names the allowed alternative, in Claude's tier.

This research hit the false positives repeatedly: shell reads of plugin source, a heredoc under /tmp, and Claude Code's own tool-result files.

### Phase 5: verify like a person

- Re-run the two-person scene (the scripts are in `docs/next/quiet/EVALUATION.md` §inputs) on each release candidate.
- Pass when each person sees 6 or fewer person lines per session, with no red `Error:`, no mode change, no `Waiting for…`, no stale label, and no text written for Claude.
- Then run `npm run probe` against the canary and add contract entries for each new surface.

## Releases

| Release | Phases | Why that order |
|---|---|---|
| **0.6.0** | 0, 1, 4 | Words, debug log and guard. All of it is plugin-side on stable surfaces, and it brings the biggest drop in noise for the least risk. |
| **0.7.0** | 2 and 3's quieting | The room's plan in plan mode, made right, and quiet rows. Both build on early-access surfaces (`ui.render`, the band, `$.agent.spawn`) behind contract entries. |
| **0.8.0** | 3's room you can enter | DMs and "how's it going". It's a new lane, so it ships after its spike and a live two-person run. |

## Design rules (CLAUDE.md)

- **"Keep the agent-panel rows. A member's panel shows the room row with the members inside it."** This becomes: one room row, with the members inside it as a roster, not as agents. The CLAUDE.md line changes when Phase 3 ships. The room session's panel no longer lists the humans, since nobody sees it.
- **"Consent is native. A proposal opens in the plan view."** Holds (D3).
- **"The room's Claude takes no typed input."** Still holds: that rule is about the room session (`claude --bg`). The room *row* in a member's panel does take input: DMs and questions.
- **"No writes to user settings files."** Holds. The `subagentStatusLine` goes in the plugin's own `settings.json`.

## Decisions (owner, 2026-11-02)

- **D1, rows:** one row, the room. Enter it to see every person, DM one, or ask how their work is going. There are no per-person rows at the top level (Phase 3).
- **D2, the leave card's limit:** open. The default is at most two cards in total (one, then one more after a dismissal).
- **D3, review:** plan mode stays, because it's formatted and scrollable. The plan is the room's plan, never someone else's (Phase 2).
- **D4, early-access surfaces:** build on them, with contract entries and fallbacks; adjust as Claude Code changes.

## Spikes before building

1. **#34:** does closing the plan view with a non-empty plan, after the Send/Discard choice, keep auto mode on 2.1.296?
2. **"Ready to code?" title:** can `ui.render` redraw the ExitPlanMode dialog's title?
3. ~~The room row~~ **done:** yes in the terminal, no in the desktop app or VS Code (quiet/ROOM-ROW-SPIKE.md).
4. **Task #1:** does `metadata._internal` on task #1 interfere with the 5-second auto-reset?

## Requests for Claude Code (not blocking)

- A pending-agents count in `TurnDuration`'s props, so the plugin need not rebuild the line.
- A way for a hook to title the ExitPlanMode dialog. This only matters if spike 2 fails.
- `${CLAUDE_PLUGIN_ROOT}` expanded in a plugin's `subagentStatusLine`.
- MCP elicitation titled by the plugin's display name, not `MCP server "plugin:…" requests your input`.
