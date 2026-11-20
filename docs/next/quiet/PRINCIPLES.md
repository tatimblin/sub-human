# sub-human: design principles for a quiet, native experience

Goal: sub-human should feel like native subagents for humans, with everything normal Claude Code allows. The owner's complaint: the plugin is too noisy, and the noise makes it feel clunky and brittle. A well-built, confident system keeps its debug output in a debug log, and some of our messages belong there. Target: it feels like Apple built it. Solid, quiet, and it just works.

Sources read: README.md, plugin/sub-human/README.md, CLAUDE.md, docs/ARCHITECTURE.md (skimmed), skills/sub-human/*, hooks/*.sh, hooks/handlers/*, hooks/context.ts, lib/text.ts, lib/room/render.ts, lib/room/deliver.ts, lib/consent/{review,edit}.ts, lib/plans.ts, lib/seats.ts, lib/tail.ts, lib/commands/*, lib/remote/hosting.ts, mod/core/*, mod/deliver.ts, mcp/room-server.ts, mcp/hold.ts and statusline/segments.ts. Real panes come from docs/rebuild/screens/S1–S3 and trailer/capture/take8 (v0.5.x on Claude Code 2.1.296). All paths are relative to `plugin/sub-human/` unless they start with `docs/` or `trailer/`.

---

## The core: three rules from the owner

Every other principle follows from these three. When two of them conflict, the earlier one wins.

### A. Handle it behind the scenes
**Rule:** sub-human does the work itself. It doesn't ask the person to do it, and it doesn't tell them it did it.
Retries, reconnects, re-spawning rows, restoring a plan file, queuing a post while offline, picking the one open room: these are the plugin's job. Each one becomes a debug-log line, never a sentence in the transcript. Prompt the person only for what only a person can give: consent, a PIN, a name.

### B. Feel native
**Rule:** use Claude Code's own surfaces, words and behavior, as if sub-human shipped in the box.
A room plan is a plan in the plan view. Agreeing is the plan view's "Yes". A task is a task in the task list. A member is a background agent in the agent panel. Ongoing state goes on the status line, setup problems go to doctor, and diagnostics go to `--debug`. Don't coin a new noun where Claude Code already has one, and don't add a new surface where Claude Code already has one.

### C. Don't overshare
**Rule:** say only what the person needs to act on, or would miss and regret missing.
Other people's words, a question addressed to you, a decision, and a request for your agreement get through. Receipts, mechanics, caveats, tips, and restatements of what is already on screen don't.

---

## Message tiers (from A–C)

Each line sub-human produces belongs to exactly one tier, decided where it is written:

| Tier | Who sees it | Surface | Earns it when |
|---|---|---|---|
| **P: Person** | the person | a `$.ui.log` notice, the plan view, an AskUserQuestion card, a submitted prompt | a person said something; you're asked to decide or answer; a decision landed; something failed **and** only you can fix it |
| **S: State** | the person, glanceably | the room row / participant rows (`statusline/segments.ts`, `lib/rows.ts rowText`), the prompt-border title, `$.ui.status` | it is ongoing state, not an event: link online/offline, who's here, waiting on whom, tasks open, posts queued |
| **C: Claude** | the model only | additionalContext, pull context, `(for Claude)` lines, MCP tool results | Claude needs it to act correctly; the person never reads it |
| **D: Debug** | nobody, until asked | the debug log (below) | anything about the machinery: retries, restarts, leases, rows restored, fallbacks taken, timings |
| **Silent** | nobody | no output | success, or a no-op the plugin already handled |

`lib/room/deliver.ts` already splits room entries into `none / context / notice / wake`, which maps onto Silent / C / P / P+C. Apply the same discipline to the plugin's **own** lines (receipts, hints, health), which today all go to P.

### The debug channel (proposal)
It follows Claude Code's own idioms. `claude --debug` writes to a debug file. `/doctor` diagnoses. The status line shows state.

1. **Log file.** `<home>/logs/sub-human.log` is JSONL (`{t, sid, seat, where, msg}`), rotated at 1 MB with 3 kept. It replaces `module.log` (`mod/core/command.ts:122`) and the per-hook `logError` stderr (`hooks/reply.ts:61`). Every D-tier line goes here unconditionally. It is cheap, local, and needs no consent.
2. **Mirror into Claude Code's debug log.** When Claude Code runs with `--debug` (or `SUB_HUMAN_DEBUG=1`, which today only covers the MCP server, `lib/env.ts:85`), hooks also write each D line to stderr with exit 0, so it shows up in Claude Code's own debug output and in ctrl+o verbose, never in the normal transcript.
3. **`/sub-human debug`.** One line back: `Logging to ~/.sub-human/logs/sub-human.log · last error 2m ago: link to dolphin-5869 reconnected`. `/sub-human debug tail` prints the last 40 lines into the transcript on request. `/sub-human debug on|off` sets the stderr mirror for this session.
4. **`/sub-human doctor`** stays the place for "what is wrong and how to fix it". It reads the log's last errors instead of asking the person to have noticed them.
5. **State, not events.** A degraded condition shows as a glyph on the room row (`✕ offline 2m · 2 queued`, `⚠ tools off`). It already exists in part in `statusline/segments.ts`. A transcript line appears only when the condition needs the person's hands.

---

## Principles

### 1. Silence is success
**Rule:** when the person's action did what they expected, say nothing. The visible effect is the receipt.
**Why here:** an `@room` post already shows up for everyone else, a joined room already shows in the agent panel, and a stored plan already opens in the plan view. A receipt on top of the effect makes the system sound unsure it worked, which is the "brittle" feeling the owner describes.
**Test:** if this line were deleted, would the person do anything differently in the next minute? If not, it is Silent (or D).
**Examples:**
- `hooks/handlers/at-room.ts:156`: `✓ sent to room ${code} (Claude wasn't asked)` (shortened to `✓ sent` after the first, `mod/core/prompt.ts:181`). **Delete.** The prompt line itself, dimmed or kept as typed, is the receipt, the way a sent iMessage is. If a hook must stop the prompt, use the shortest native-feeling reason, `Sent to room`. Drop the `(Claude wasn't asked)` mechanics.
- `lib/seats.ts:319`: `opened room ${code} as ${name} · on this machine others join with /sub-human; another machine: /sub-human invite`. **Rewrite** to the event alone: `Opened room dolphin-5869`. How to invite belongs in the bare `/sub-human` status and in help, not on every open.
- `mod/core/copy.ts:159` `line copied` / `:157` `copied`. **Delete.** Clicking Copy is its own receipt. Keep `NO_TOOL` (`:160`) only because the person has to act differently.

### 2. Do the work; never narrate the machinery
**Rule:** recovery, retries, restores and fallbacks happen in the dark. Narrating them is a debug log written in the transcript.
**Why here (A):** the plugin has a lot of self-healing machinery (row rewake, plan-file restore, link backoff, the outbox). Every time it speaks about that machinery, the person learns that there is machinery, and that it breaks.
**Test:** does the line describe *what sub-human is doing* rather than *what happened in the room*? Then it is D.
**Examples:**
- `mod/core/deliver.ts:283`: `sub-human: restoring this session's rows`, drawn as a **prompt** in the person's transcript (`› Prompt from the sub-human plugin`). **Demote to D.** Re-spawning rows after a resume is the plugin's job. If a model turn is unavoidable, its shown text should be empty or a native-looking status, never a sentence.
- `hooks/handlers/at-room.ts:151`: `⧗ queued; restarting the link: room ${code}'s connection wasn't running, so it is starting again; this post goes out once it's back (${n} waiting)`. **Rewrite** to Silent, with S showing `2 queued` on the room row. The post goes out when it can, and the person learns about it only if it permanently fails.
- `lib/seats.ts:101`: ` · the room session is starting again (the last start failed: ${spawn_error})`. **Demote to D.** The watchdog restarts it. Only a final failure that removes a feature the person is using earns a line (see 5).

### 3. Native first: Claude Code's surfaces and words
**Rule:** if Claude Code has a surface or a word for it, use that one. Invent only what has no native equivalent (`@room`, a room).
**Why here (B):** the promise is "Claude Code's own subagent machinery … work across people". Each plugin-coined noun or ad-hoc surface breaks the illusion that this is built in.
**Test:** would this line make sense, word for word, in Claude Code's own UI? Does it use the native surface (plan view, task list, agent panel, status line, `/doctor`-style report, `--debug`) rather than a transcript notice?
**Examples:**
- `lib/room/render.ts:261`: `${who} asks ${to} to sign off on plan api v3`. "Sign off" is ours. The plan view's own action is *approve / Yes*, and the README's people-word is *agree*. **Rewrite:** `tristan's Claude asks you to review plan paging v3`. The plan view does the rest.
- `mod/core/rows.ts:80` (`TOOLS_DOWN_NOTICE`): `the room's tools are not connected in this session, so plans and the task list can't be changed from here and Claude can't read the room; @room and messages to other Claudes still work. /mcp, then plugin:sub-human:room, Reconnect brings them back (sub-human doctor says why).` **Rewrite** to Claude Code's own idiom for a failed MCP server (it already flags it in `/mcp` and the status line): S glyph `⚠ room tools off` on the room row, and one P line only on first failure: `Room tools disconnected. /mcp to reconnect.`
- `lib/commands/help.ts:29`: `rows show names; for their live status … add the subagentStatusLine line in the README's Rows section to your ~/.claude/settings.json`. **Rewrite / move to README.** Help should list commands, like `/help` does. Setup advice belongs in doctor's "info" checks.

### 4. Confidence: no hedging, no apologies, no "not yet"
**Rule:** state what is true now, in the affirmative. No "not yet", "may", "if…", "no need to…", "still works, but".
**Why here:** hedged receipts are the main source of the "brittle" feel. A line like "not sent out yet" reads as a failure even when the system is in exactly the state it should be.
**Test:** does the line contain *not yet, may, might, still, no need, but, if it, maybe*, or a parenthetical caveat? Rewrite it as a plain statement of the current state, or delete it.
**Examples:**
- `lib/consent/edit.ts:119`: `sub-human: saved as room plan ${p} v${v}, not sent out yet: you check it first.` This is a **PreToolUse deny**, so the person sees it as a red tool error. **Delete the person-facing half.** The plan view opening for the author's own check *is* the receipt. Keep only the C half (`checkNext`). The same goes for `:116` `saved as room plan … v1, not agreed yet.`
- `lib/plans.ts:88`: `not sent out yet (${by} checks it first)`. **Rewrite:** `draft · tristan reviewing` (row and `plan read`).
- `hooks/handlers/at-room.ts:146`: `⧗ sending (slow connection): room ${code} hasn't confirmed this post yet; it shows in the room once the host has it. No need to type it again`. **Delete (Silent + S `1 sending`).** If it never confirms, principle 5 applies.
- `mod/core/cc.ts:57`: `Claude Code ${version} isn't verified with sub-human yet: ${what}. sub-human doctor has details.` **Demote to D + doctor.** The fallbacks already work. If a fallback changes what the person sees (sign-off on a card rather than the plan view), the card itself is enough.

### 5. Errors only when the person must act, and then exactly one action
**Rule:** a P-tier error says what didn't happen, in their words, and the one thing to do. Everything else is D.
**Why here:** today almost every failure ends in "Run /sub-human doctor". That hands the person the plugin's debugging and implies the plugin couldn't tell what was wrong.
**Test:** (a) Is there something only the person can do? If not, it is D, and the plugin retries. (b) Does it fit in one line of the form `<what didn't happen>. <one action>.`? (c) Does it name a specific action rather than "run doctor", unless doctor genuinely is the action?
**Examples:**
- `mod/core/deliver.ts:27` (`DELIVERY_ERROR_NOTICE`): `a room message didn't arrive here. Run /sub-human doctor.` The tail resumes from its cursor, so a restart loses nothing (`:20` comment). **Demote to D**, with S `⚠ room catching up` while the child is down. Speak only if events are proven lost, and then name them: `Missed 3 room messages. Ask Claude to catch you up.`
- `mod/core/command.ts:91` (`STALE`): `✗ /sub-human did not finish here (this session's hooks-module lease did not hold). Run /sub-human doctor.` **Rewrite:** re-lease and retry once silently. If that fails: `/sub-human didn't run. Try again.` Put lease details in D.
- `lib/tail.ts:671`: `room log check: the hash chain breaks at #N; that entry and the ones after it may have been changed outside the plugin`. This is a real integrity event, but the person can't act on it in the moment. **Demote to D + doctor (fail check)**, with an S glyph `⚠ log check` on the room row.

### 6. Recoverability over warnings
**Rule:** make the risky thing undoable or self-correcting instead of warning about it in advance.
**Why here:** the invite, the plan view and the join flow carry long preemptive warnings (rules, caveats, mode notes). An Apple-quality flow makes the bad outcome cheap and keeps quiet until it happens.
**Test:** is this line warning about something that *might* happen? Can the plugin recover (cancel, retry, re-ask) if it does? Then delete the warning and build the recovery.
**Examples:**
- `lib/remote/hosting.ts:143` (`INVITE_RULES`): `They type the PIN after the line; the line alone asks you on a card, the PIN alone gets nobody in, and 5 wrong PINs end the invite. The right PIN lets them in with no card: the room shows who joined, with a check and the kick.` **Delete.** Each case explains itself when it happens: the card appears, the join line names the kick.
- `mod/core/constants.ts:61` (`BYPASS_NOTE`): ` · ⚠ bypass-permissions mode: messages from other sessions can wait behind a dialog; restart in another mode to get them live`. **Delete** as a preemptive warning. If a wake actually waits behind a dialog for more than a moment, show S `✉ 1 waiting` (the row already supports `✉ 1 for you`).
- `lib/remote/hosting.ts:242`: `Over ssh this needs their own ssh login to this account (…), set up as for any ssh login: sub-human writes nothing to authorized_keys. They log in to this machine as someone else? /sub-human invite --forward`. **Delete from the invite. Move to the joiner's refusal**, which is where an ssh failure actually happens and gets explained.

### 7. Each event said once, in one place
**Rule:** one event gets one line on one surface for each person. If the row shows it, the transcript doesn't. If the hook said it, Claude doesn't repeat it.
**Why here:** a join is currently announced by the hook notice, by Claude's "one short line" (the skill asks for it), by the room row's `+jess joined`, by the participant row's `jess joined · read-only · talk in main (@room)`, and on the host by the link line. A plan request appears as the room line, the wake prompt, the row's `⚠ your answer needed`, and the reminder.
**Test:** list every surface that shows this event to this person. More than one P surface means a merge. A P line plus an S change is fine only if the P line carries something the S doesn't.
**Examples:**
- Join, from the real capture (`trailer/capture/take8`): `⏺ sub-human: opened room dolphin-5869 as tristan · …` then `⏺ You're in room dolphin-5869. Nobody else has joined yet.` The second comes from `skills/sub-human/SKILL.md:14` "then reply in one short line". **Merge:** the hook's line is the only P line. The skill tells Claude to make the row calls and **reply with nothing** (end the turn silently). Joiner side (take8): `the host let you in to room dolphin-5869: this session takes your seat as jess now` + `joined dolphin-5869 as jess, with tristan · @room to talk; …` + `You've joined room dolphin-5869 with tristan.` That is three lines for one event. **Merge to one:** `Joined dolphin-5869 with tristan`.
- `lib/remote/server.ts:112` `${name} joined from ${machine} (check …) · not them? /sub-human kick ${name}`, then the same `room: jess joined from jess-laptop (check cc42-5f5f)` again later in take8 (as a pull/wake), plus the row's `+jess joined`. **Say once:** the P line with the check and the kick for the host, and the row segment for everyone else. Never re-deliver it as a wake.
- `mcp/hold.ts:66`: `' · read-only · talk in main (@room)'` on each participant row. **Delete the hint.** The panel already shows the row as a background agent. Teaching text on a persistent row is repeated every time you look at it.

### 8. One voice, one small vocabulary
**Rule:** one speaker per line, and a fixed set of nouns. People see: **room, name, Claude ("jess's Claude"), message, plan (with a version), task, invite, agree / ask for changes, host.** Never: seat, proposal, hash, sign-off request, lease, link, mirror, row, room session, card, SECRET, approver, "check it first", "send it out".
**Why here:** lines currently stack three speakers (`⏺ sub-human: room: jess joined …`), and one action has several names: sign off / agree / approve / Yes / signoff; object / asked for changes / objection / note; `@room post` / message / note; draft / new version / not sent out. Too many names make the design feel unsettled.
**Test:** does every noun appear in the list above? Is there exactly one speaker prefix (the plugin's, added by Claude Code), or a person's name for their own words?
**Examples:**
- `lib/tail.ts:632`: `room: ${who} typed your invite line without its PIN, but nobody let them in within N minutes; their join stopped`. **Rewrite:** `jess's invite expired.` (drop the `room:` speaker, "typed your invite line without its PIN", and the minute count).
- `lib/room/render.ts:260`: `${who} asks ${you} to check ${label} before it goes out`. **Rewrite:** `Plan paging v1 is ready for your review` (the author's own draft: "you", no "goes out").
- `lib/room/render.ts:285`: `task "${subject}" open, owner you, suggested for you (claim it to take it)`. **Rewrite:** `New task for you: store: listTasks`. "claim", "owner" and "suggested" are task-list mechanics, and the native task list shows them.

### 9. Claude's instructions stay in Claude's tier, and stay out of red
**Rule:** model-facing text never reaches the person. That covers PreToolUse denies (shown in red as tool errors), prompts the plugin submits, and stderr. Use additionalContext or `(for Claude)` context instead. Keep each instruction to the mechanics, under ~200 characters.
**Why here:** CLAUDE.md already says "the injected text covers mechanics only and stays small". But several model instructions travel as **denies**, which Claude Code draws as errors. The person ends up reading `sub-human: … do not retry and do not mention it` in red, which looks like a crash.
**Test:** is this string returned as `permissionDecision: deny`, a submitted prompt, or stderr? If so, would the person understand it and be glad to see it? If not, move it to additionalContext or make the call never happen.
**Examples:**
- `hooks/handlers/row-guard.ts:28`: `sub-human: ${what} is already running in this session (it shows leaves and rejoins by itself). Nothing to do; do not retry and do not mention it.` (deny). **Make it Silent:** answer the duplicate spawn with a no-op success where the contract allows it, or stop the duplicate earlier (the ROWS line lists only missing rows). Never put it in a red error.
- `lib/consent/review.ts:208`: `sub-human: ${n} has a sign-off waiting (…); this ExitPlanMode would show ${n}'s own plan file instead, so nothing was shown. To show the sign-off: call EnterPlanMode, then ExitPlanMode with plan "proposal ${h}". …` (deny). **Move to C** (additionalContext on the next turn). The person's view is unaffected.
- `mod/core/deliver.ts:31` `WAKE_HEAD` / `:46` `WAKE_CONTEXT`: these are already C, which is right. The problem is the frame Claude Code draws, `› Prompt from the sub-human plugin`, above room lines. **Rewrite:** for a member's wake, deliver the person's lines as a P notice and the wake as a no-text turn with the context only, so the transcript shows the message once and in the chat style.

### 10. Ambient state lives on the status line, not in the transcript
**Rule:** anything that is *a state* (online, offline, queued, who's here, waiting on whom, tasks open) is shown on the room row or participant rows, and updated in place. The transcript gets only *events* that need you.
**Why here (B, C):** the room row is the native "Activity"-style surface, and it already renders `2 here · ✉ 1 for you · ⇄ online`. The link and health lines in `lib/tail.ts` duplicate it as scrolling notices that go stale the moment they're read.
**Test:** will this line be false in five minutes without anyone acting? Then it is S.
**Examples:**
- `lib/tail.ts:422`: `the connection to room ${code} is down (${reason}); @room posts wait and go out when it's back, card answers can't be sent until then`. **S:** `✕ offline 2m · 1 queued` (already in `statusline/segments.ts`). No transcript line.
- `lib/tail.ts:412` (`LINK_BACK`): `the connection to the room is back; @room posts go through again`. **Delete.** The row flips to `⇄ online`.
- `lib/room/render.ts:375-402` `stateLine`: `room now: plan paging v3 3fa2c1 waiting on bob · … · you: answer needed (call EnterPlanMode, then ExitPlanMode …)`. This is fine as **C**. Make sure no part of it is ever drawn for the person. The row already says `⚠ your answer needed`.

### 11. Progressive disclosure: the first line is the whole answer
**Rule:** a command answers in one line. Detail is one command away (`/sub-human help`, `--verbose`, doctor, README), never stacked underneath.
**Why here:** `/sub-human invite` prints six notices (take8, `lib/remote/hosting.ts:197-202,143,145,242`). The bare `/sub-human` status chains three clauses. A person reads the first line, and the rest is noise that makes a simple action look complicated.
**Test:** count the lines. A command gets one, or two if something must be copied. Is every extra line needed *right now* by most people?
**Examples:**
- Invite (`lib/remote/hosting.ts:197`): `invite to room ${code} for one machine, over ssh devbox, until 18:16. The line is wider than this terminal: its PIN and SECRET are under the prompt (not saved in this conversation). Send this line with SECRET replaced by the word there, and say the PIN separately:` + line + `Cancel it: …` + rules + ssh note + install hint. **Rewrite to two lines:** `Invite ready until 18:16 · line and PIN below the prompt` + the copy card. Move cancel, ssh and install to `/sub-human help invite` and the joiner's own refusals.
- `lib/commands/join.ts:98`: `you're ${name} in room ${code}, ${withWhom} · another machine: /sub-human invite · leave: /sub-human leave${roomClaudeNote}`. **Rewrite:** `tristan in dolphin-5869 with jess`. The commands live in help.
- `mod/core/leave.ts:33`: `You left room ${code}. Thanks for trying sub-human! Type below to send feedback.` (a modal card on every first leave). **Rewrite:** one P line, `Left dolphin-5869`, and no modal. Ask for feedback at most once ever, and not in the moment of leaving.

### 12. Speak the person's language about consent, exactly once
**Rule:** consent moments (review a plan, agree, ask for changes) use the plan view and its own buttons. The plugin adds at most one short line of framing that names *what* is being agreed to and *who* asked.
**Why here:** consent is the one place sub-human has to speak, and it should speak well. Today the framing explains keystrokes, modes and caveats, then follows up with "not recorded yet" notices.
**Test:** does the framing fit on one line under the plan view title and use the native buttons' words? After the person answers, does the next thing they see come from the room (the decision), with no plugin receipt?
**Examples:**
- `lib/consent/review.ts:213-215` (`dialog`): `sign-off on plan paging v1, asked by tristan, for jess: agreeing signs off on this text, it is not a go-ahead to build (PgUp/PgDn scroll). Agree: "Yes, manually approve edits" keeps your mode. Object: "Tell Claude what to change" + why. Esc: decide later.` **Rewrite:** `Plan paging v1 from tristan · Yes to agree · "Tell Claude what to change" to ask for changes`. The mode handling is the plugin's job (it restores the mode already), and Esc is native.
- `lib/consent/review.ts:203` (`tooSoonNotice`): `your Yes on "…" came right as the review opened, so it is not recorded yet: confirm it on the card that follows`. **Delete the notice.** The card that follows already asks. Make it read as a normal confirmation (`Agree to plan paging v1?`).
- `lib/consent/review.ts:253` (`noteStillWaits`): `your note on "…" still waits, not sent. On its card, Send posts it as your objection; Discard drops it and records nothing (the proposal stays unanswered). Esc keeps it waiting: ask your Claude for the card when you decide`. **Rewrite to S:** `✎ note unsent` on the room row. If the person asks Claude about it, Claude can explain.

---

## Message budget (a typical session, per person)

These are lines **from sub-human itself** in the transcript, not counting other people's words (each message is one line, which is content), the native plan view, cards, or rows.

| Moment | Today (observed or derived) | Budget |
|---|---|---|
| Open a room | 2 (hook line + Claude's "You're in room…") + Agent call block + "Waiting for 1 background agent" | **1** `Opened room dolphin-5869` |
| Invite another machine | 6 notices + status pin | **1** + the PIN/line under the prompt (S) |
| Join (joiner) | 3 (`host let you in…`, `joined … · @room to talk…`, Claude's line) + `› Prompt from the sub-human plugin` | **1** `Joined dolphin-5869 with tristan` |
| Someone joins (others) | 1–2 notices + row segment | **1** for the host (check + kick); **0** for others (row `+jess`) |
| `@room` post (sender) | 1 receipt (`✓ sent to room … (Claude wasn't asked)`) | **0** |
| Plan round, author | red deny receipt (`saved … not sent out yet`) + plan view + context lines + "sent out" | **0** (plan view only); **1** when decided |
| Plan round, reviewer | room line + wake prompt + row ⚠ + dialog framing paragraph | **1** `tristan's Claude asks you to review plan paging v1` + plan view (1-line framing) |
| Plan decided | 1 room line per member in it | **1** `Plan paging v2 agreed (you, tristan)` |
| Task assigned to you | 1 room line with owner/suggest/claim words | **1** `New task for you: http: GET /tasks paging`; **0** for tasks you made |
| Task done (yours or others) | 1 room line | **0** (task list / row) |
| Link drops and comes back | 2+ notices, plus queued/flush lines | **0** (row state); **1** only if posts are finally lost |
| Leave | 1 notice + a modal feedback card | **1** `Left dolphin-5869` |
| **Whole session overhead** | ~20–30 plugin lines | **≤ 6** |

---

## Inventory: current message sources and proposed tier

P = person notice, S = status/row, C = Claude only, D = debug log, — = silent/delete.

| Source (file:line) | Current text (abridged) | Today | Proposed |
|---|---|---|---|
| hooks/handlers/at-room.ts:156; mod/core/prompt.ts:181 | `✓ sent to room CODE (Claude wasn't asked)` / `✓ sent` | P | — |
| hooks/handlers/at-room.ts:146 | `⧗ sending (slow connection) … No need to type it again` | P | S (`1 sending`) |
| hooks/handlers/at-room.ts:151-152 | `⧗ queued; restarting the link …` / `⧗ queued: room is offline …` | P | S (`n queued`) + D |
| hooks/handlers/at-room.ts:142-143 | `⧗ not confirmed: …` / `✗ not posted: …` | P | P (one line, one action) |
| hooks/handlers/at-room.ts:129, :134; mod/core/prompt.ts:75,80,84 | `✗ not posted: …` (not typed by you / empty / no room) | P | P, shortened (`Not in a room. /sub-human to join.`) |
| lib/seats.ts:319-320 | `opened room … · on this machine others join…` / `joined … · @room to talk; your Claude can…` | P | P, 1 short line |
| lib/seats.ts:98, :101 | room session could not start / is starting again | P (suffix) | D (+ P only on final failure) |
| lib/seats.ts:251-254 | agent-view fork moved this conversation … SUB_HUMAN_HOME … | P | P (rare, actionable), shorten to 1 line + doctor detail |
| lib/commands/join.ts:98-99 | bare `/sub-human` status with commands | P | P, 1 line |
| lib/commands/*.ts refusals (usage, `isn't a name`, PIN-shaped) | `usage: … All commands: /sub-human help` | P | P (keep, shorten) |
| lib/commands/help.ts:8-30 | full help incl. statusline setup tip | P on request | P on request; tip moves to doctor info |
| lib/remote/hosting.ts:197-202 | invite lines (6) | P | P 1 line + S pin |
| lib/remote/hosting.ts:143 INVITE_RULES, :145 INSTALL_HINT, :242 ssh note | rules / install / ssh login | P | — (help, joiner-side refusals) |
| lib/remote/hosting.ts:348-349; mod/core/deliver.ts:259-266 | `the host let you in … takes your seat as NAME now` + `You're in room …` | P + prompt | merge into 1 P join line |
| lib/remote/server.ts:112 | `NAME joined from MACHINE (check …) · not them? /sub-human kick NAME` | P | P (host only, once) |
| lib/room/render.ts:247-248 | `bob joined` / `bob left (connection lost)` | P | S (row `+bob` / `−bob`) |
| lib/room/render.ts:233-235, 288 | people's words `bob: …`, `bob's Claude (to you): …` | P | P (content: keep) |
| lib/room/render.ts:255-263 | `… asks you to sign off on plan api v3` / `… to check … before it goes out` | P/wake | P, "review" wording |
| lib/room/render.ts:265-270 | `bob's Claude: plan paging v4: …` + `retires the sign-off request for …` | P | P only for people in it; drop "retires" clause (C) |
| lib/room/render.ts:272-276 | `bob agreed to …` / `bob objected to …` + note | P | P for the author; S for others (row `✓`/`✎`) |
| lib/room/render.ts:277, :200-218 | decision line | P | P (keep, one per member in it) |
| lib/room/render.ts:278-287 | task lines (`owner`, `suggested for you (claim it…)`, `asks to add task`) | P | P only when assigned to you; else S/— |
| lib/room/render.ts:324, :338 | `(for Claude) … asked for changes … you may revise` | C | C |
| lib/room/render.ts:352, :364-365 | `[cut: the rest is in the room log]`, `[+N more lines: read({ids:[ID]})]` | P | P without the tool call (`… more`); call goes to C |
| lib/room/render.ts:375-402 stateLine | `room now: … you: answer needed (call EnterPlanMode…)` | C | C |
| lib/consent/review.ts:213-218 dialog / dialogDraft | plan-view framing paragraph | P | P, 1 short line |
| lib/consent/review.ts:203 tooSoonNotice | `your Yes … is not recorded yet: confirm it on the card` | P | — (card suffices) |
| lib/consent/review.ts:253 noteStillWaits | `your note … still waits, not sent. On its card, Send …` | P | S (`✎ note unsent`) |
| lib/consent/review.ts:199 leaving | `sub-human: the room review is over; this only leaves plan mode` | P (ask) | P, native wording (`Leave plan mode?`) or — |
| lib/consent/review.ts:179-264 (rest of SAY) | recorded / noted / steer / showOnly / stillOpen … | C, some via deny | C only; none as deny |
| lib/consent/edit.ts:108-136 EDIT_SAY receipts (`saved as room plan … not sent out yet`, `not agreed yet`, `not saved: …`) | deny reason (red to person) | P (red) | — on success; P one line on real failure (`Plan not saved: v3 landed meanwhile. Claude is merging.`); C for the next step |
| lib/consent/edit.ts draftNotice | draft kept in file … | P | P (1 line, rare) |
| lib/plans.ts:84-91 stateText | `not sent out yet (X checks it first)` / `waiting on …` | C (+ row) | C + S, new words (`draft · X reviewing`) |
| mcp/room-server.ts tool results (refused/not recorded/…) | tool text | C | C (keep short; never "Never say…" sermons to the person) |
| mod/core/deliver.ts:27 DELIVERY_ERROR_NOTICE | `a room message didn't arrive here. Run /sub-human doctor.` | P | D + S; P only on proven loss |
| mod/core/deliver.ts:283 REWAKE_SHOWN | `sub-human: restoring this session's rows` (as a prompt) | P | D |
| mod/core/deliver.ts:31,46 WAKE_HEAD / WAKE_CONTEXT | `(for Claude) sub-human room: lines from …` | C | C |
| (Claude Code frame) | `› Prompt from the sub-human plugin` above wakes | P (native frame) | avoid: deliver lines as P notices, wake as context-only turn |
| mod/core/constants.ts:47 PULL_HEAD | `room since your last turn (FYI):` | C | C |
| mod/core/constants.ts:57 HOME_MARK | `sub-human: home …` (system row, ctrl+o only) | D-ish | D (fine) |
| mod/core/constants.ts:61 BYPASS_NOTE | `⚠ bypass-permissions mode: messages … can wait behind a dialog …` | P | — (S `✉ waiting` if it happens) |
| mod/core/cc.ts:56-57 ccNotice | `Claude Code X isn't verified with sub-human yet: …` | P | D + doctor |
| mod/core/rows.ts:75 ROWS_DOWN, :81 TOOLS_DOWN | `SUB-HUMAN ROWS: … Tell the person once …` | C | C |
| mod/core/rows.ts:80 TOOLS_DOWN_NOTICE | room tools not connected … (long) | P | S `⚠ room tools off` + 1 short P line once |
| mod/core/command.ts:88, :91, :144 | `✗ /sub-human did not finish here (…). Run /sub-human doctor.` | P | silent retry; P `/sub-human didn't run. Try again.`; detail D |
| mod/core/copy.ts:38 COPY_QUESTION | `Copy the invite line to your clipboard? (the PIN is not copied)` | P card | P card (`Copy invite line?`) |
| mod/core/copy.ts:157-162 | `copied`, `line copied`, `not copied`, `that invite is gone…`, NO_TOOL | P | — except NO_TOOL / GONE |
| mod/core/leave.ts:27-33, :142 | leave card + `★ starred …, thank you` | P modal | P 1 line; feedback ask at most once ever |
| lib/tail.ts:412 LINK_BACK; :419-424 linkLine; :427 flushLine | link down / back / stopped / fork / queued posts sent | P | S; P only for `stopped`/`fork` with posts lost |
| lib/tail.ts:632 | invite request lapsed | P | P, 1 short line |
| lib/tail.ts:640 | join request wake + `(for Claude) … AskUserQuestion "admit …"` | P + C | P card only (no preceding line) + C |
| lib/tail.ts:671 | `room log check: the hash chain breaks at …` | P | D + doctor fail + S `⚠` |
| lib/tail.ts:404-405, proposal.reminder | proposal reminders | C | C |
| hooks/handlers/row-guard.ts:25, :28 | deny `… Nothing to do; do not retry and do not mention it.` | P (red) | — (prevent; else C) |
| hooks/handlers/row-hold.ts:38 | `… is still wanted, so this row stays open. Call hold … Write no text.` | C (row agent) | C |
| hooks/handlers/row-rewake.ts:23-26; session-restore.ts:50-51 | `this session was resumed, and its rows are NOT running …` | C | C (shorter) |
| hooks/handlers/session-restore.ts:63-64 | `this session took no seat: Claude Code's transcript did not say …` | P | P, 1 line (`Not in a room after resume. /sub-human to rejoin.`) |
| hooks/handlers/join.ts:100 | `sub-human could not run that (…). Run /sub-human doctor.` | P | P short + D detail |
| hooks/reply.ts:61 logError | `sub-human <where> error: <stack>` on stderr | P (hook error line) | D (log file; stderr only under --debug) |
| hooks/node.sh:54 | `sub-human needs Node 22.18+ or 24.3+ …` | P | P (actionable: keep) |
| skills/sub-human/SKILL.md:14 | "then reply in one short line" | causes P dup | change to "then end your turn without text" |
| skills/sub-human/SKILL.md:16 | `sub-human did not answer here. If your terminal shows…` | P | P (rare, actionable: keep, shorten) |
| skills/sub-human/member.md | SUB-HUMAN mechanics block | C | C |
| mcp/hold.ts:66 | ` · read-only · talk in main (@room)` | S | — |
| statusline/segments.ts, lib/rows.ts rowText | `2 here · ✉ 1 for you · ⇄ online`, `⚠ your answer needed` | S | S (expand: queued, offline, tools off, note unsent) |
