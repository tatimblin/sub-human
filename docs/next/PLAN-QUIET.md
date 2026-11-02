# Quiet: sub-human's output and experience

Status: plan, 2026-11-02. Nothing in it is built yet. Decisions marked **Owner** are open.

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
| **Decision** | The review band and pane; `$.ui.ask` | Agree or ask for changes; let someone in; the leave card |
| **State** | The footer's SessionMode slot (dim, right-aligned) | Room, who's here, who's building and who's done, offline or queued |
| **Away** | `$.ui.notify` | Something needs you while you're idle (at least 15 s quiet, at most once a minute) |
| **Claude** | `additionalContext`, `$.session.append` isMeta, tool results | Everything Claude needs. It's never drawn and never restated. |
| **Debug** | `$.ui.log({to:'debug'})` plus `~/.sub-human/logs/sub-human.log` | Receipts, recoveries, fallbacks, lifecycle, exceptions |

Never used for ambient state: `$.ui.status` (always amber `⚠`), the UPS `continue:false` / block frames ("Operation stopped by hook"), the Stop hook's `additionalContext` ("Ran 1 stop hook"), and `structuredContent` (it replaces the text for both Claude and the person).

## The target session

**Budget:** 6 lines or fewer per person per session, down from 14–20 today. Every line below is a person-tier line. Everything else is in the footer, in a pane, or in the log.

```
❯ /sub-human
⏺ sub-human: Joined panda-0976 with maya                                   (today: hook line + Claude's echo + hint suffix)
                                                         footer → panda-0976 · maya, dev

❯ @room hey, I'll take the HTTP side                                        (no "✓ sent": the prompt row is the receipt)
⏺ sub-human: maya: great, plan's coming up

maya asks you to review plan paging v1   1: Review                          (a band above the prompt, not a transcript line)
  └ 1 → a pane with the rendered plan · 1: Agree  2: Ask for changes  Esc: later
⏺ sub-human: You asked maya for changes to paging v1: "clamp limit at 100, don't 400"
                                                         mode stays ⏵⏵ auto mode on
⏺ sub-human: Plan paging v2 agreed (maya, you)

⏺ sub-human: New task for you: http: GET /tasks paging
                                                         footer → panda-0976 · maya, dev · maya ✓ store: listTasks
⏺ sub-human: maya's Claude: listTasks is pushed (8b2aab4)                   (Claude to Claude, the one line that matters)

❯ /sub-human leave
  ╭ Left panda-0976. ─ 1. Done  2. ★ Star sub-human  (type to send feedback) ╮   (once per install)
```

`debug.log` for the same session (`/sub-human debug tail`):

```
21:03:12 join   seat dev · room panda-0976 · rows: none (footer presence)
21:03:40 at-room #4 posted 14ms
21:05:02 consent review band raised · paging v1 from maya
21:05:55 consent changes sent · paging v1 · mode auto kept
21:09:40 link   dropped (ECONNRESET) · back in 1.2s · 0 queued
21:16:31 leave  title restored · task list reaped · card shown (1 of 2)
```

## Phases

Each phase ships on its own, and the order follows impact per unit of effort. File:line references are to 0.5.8. The research docs list each change in full.

### Phase 0: foundations, no visible change

- **One debug log.** `lib/log.ts` `debug(src, msg, {lvl, room, code, err})` writes JSONL to `<home>/logs/sub-human.log`. It rotates at 1 MB and keeps 3 files, and the existing masks are applied. It replaces eight scattered logs: `logError` stderr (`hooks/reply.ts:61`), the ad-hoc stderr in 6 hooks, `mcp-debug.log`, `module.log`, and the tail's `errorLog`. The link and listen daemon logs follow. The hooks module writes through `$.ui.log({to:'debug'})`, which feeds `claude --debug` for free, plus a per-session ring file. See COPY §4.
- **Tier helpers** `person / state / claude / debug`. Each existing call site is moved to one helper, so a code reviewer can see every tier choice.
- **Contract and gate.** Add an entry in `lib/cc/contract.json` for each new surface (band, pane, SessionMode, `ui.render` ToolUse/ToolResult, toast, notify, `$.store`), plus a gate in `mod/core/cc.ts:21`. Each new surface needs a stated fallback.
- **A line-budget test**, as a ratchet like the ts-ratchet. A scripted two-seat scene counts person-tier lines per phase and fails if the count rises.

### Phase 1: the quiet pass (words only, no new surfaces). Expected 68 → about 30 lines

- **Canonical lines** (COPY §3.1, about 50 moments): `Opened panda-0976`, `Joined panda-0976 with maya`, `Left panda-0976`, `maya asks you to review plan paging v1`, `dev asked for changes to plan paging v1:`, `Plan paging v2 agreed (you, dev)`, `New task for you: …`. Errors take one form: `<what didn't happen>. <one action>.`
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
  - In: room, name, Claude, message, plan `name vN`, task, invite, review, agree, ask for changes, host.
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

### Phase 2: review without plan mode. Closes #34, #21, #9

Plan mode means "my Claude is about to build", and that's why reviewing someone else's plan in it can't be made to feel right. The plugin's own explanatory line is never drawn on that dialog (verified live), and the objection path drops the mode. **Use a band and a pane instead** (REVIEW.md):

- **Arrival:** one dim band above the prompt: `maya asks you to review plan paging v1   1: Review`. It works when idle and mid-turn, with no model turn and no transcript row.
- **Review:** `1` opens a pane with the rendered plan (tables, code, scrolling). The action row sits above the plan: `1: Agree   2: Ask for changes   Esc: later`.
- **Asking for changes:** `2` turns the row into a field, `What should change?`, and Enter sends.
- **Result:** one line, e.g. `You asked maya for changes to paging v1: "…"`. The mode never changes, and the person's Claude gets the decision as context at its next turn.
- **The author's own check** uses the same pane: `1: Send to dev   2: Keep editing`.
- **Fallbacks:**
  - Where no pane can be drawn, use `$.ui.ask` with Agree / Ask for changes and the plan printed just before it.
  - With no hooks module, use the existing MCP elicitation `signoff`.
- **Delete the plan-mode review:**
  - most of `lib/consent/review.ts`;
  - `hooks/consent.ts:386-498`;
  - `mod/consent.ts:125-171,212-215`.

  That's about 200 new lines against roughly 600–700 deleted.
- **Risk:** the pane and band APIs are early access. They need the canary, contract entries and the fallback gate.

### Phase 3: presence. **Owner: D1**

The rows are the plan's one real product question, because they are the "subagents for humans" picture.

**Option A, keep the rows and quiet them:**
- Ship `subagentStatusLine` in the plugin's own `settings.json`, which works with no edit by the person. It gives a fixed label, hides ended rows, and removes the paste-this step.
- Spawn rows from the module (`$.agent.spawn`): no transcript row, no hand-back turns, no `row closed`.
- Hide the `Backgrounded agent` block with `ui.render`.

**What's left with A:**
- `Waiting for N background agents` can only be hidden by rebuilding `TurnDuration` (its props carry no count).
- A `1 shell` pill stays in the footer.
- Each row costs about 7k tokens.
- A row is still an agent you can open that does nothing.
- A person's own `subagentStatusLine` overrides ours.

**Option B, delete the rows (recommended):**
- Who's in the room goes in the footer's SessionMode slot: `panda-0976 · maya, dev · dev ✓ http: GET /tasks paging`. Offline and queued states go there too.
- Arrival tiers:
  - a person line for words, requests and decisions, `dev finished …` and `New task for you`;
  - a footer update for state;
  - `$.ui.notify` only when something needs you while you're idle.
- Delete:
  - `agents/room.md` and `agents/participant.md`;
  - `mcp/hold.ts` (386 lines);
  - `mod/rows.ts`, the row handlers, the ROWS block and `statusline/`.
- Add: a `presence` event in `lib/tail.ts`, `presenceLine` built from the existing `rowText`/`presenceOf`, and a SessionMode hook in `mod/deliver.ts`.

**Why B:**
- People read the rows as Claude doing work.
- Three of the four row costs can't be removed.
- An Apple-made version wouldn't show a person as a fake process.

The "subagents for humans" feel comes from what already works: `@room`, Claude-to-Claude messages, plans and tasks, all inside your own session.

**Either way:**
- Filter member `claude` out of every list of people.
- Mark bookkeeping task #1 `metadata._internal`. Check this against the 5-second auto-reset first, because the same filtered list feeds it.
- Reap the room's `claude --bg` session when the room closes.

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
| **0.7.0** | 2, 3 | Review pane and presence. Both have new-surface risk (early-access APIs), each with a fallback gate. |

## Design rules this plan would change (CLAUDE.md)

- **"Keep the agent-panel rows."** D1 option B drops this rule. Option A keeps it.
- **"Consent is native. A proposal opens in the plan view."** Phase 2 keeps the rule's intent: native surfaces, and only the person's own answer (`via=human`) records agreement. It changes the surface to the review band and pane, with `$.ui.ask` and then the MCP question as fallbacks.
- **"No writes to user settings files."** Still holds. The `subagentStatusLine` in option A goes in the plugin's own `settings.json`, never the person's.

## Open decisions (Owner)

- **D1: rows.** Delete them for footer presence (B, recommended), or keep them quieted (A).
- **D2: the leave card's limit.** At most two cards in total (one, then one more after a dismissal), or literally once. Recommended: two, as agreed.
- **D3: the plan-view consent rule.** Move reviewing other people's plans out of plan mode (Phase 2, recommended), or keep plan mode and accept #34 and #21 as limits of Claude Code.
- **D4: early-access surfaces** (band, pane, SessionMode). Build on them with fallback gates (recommended), or wait for them to stabilize and ship Phase 2 on `$.ui.ask` alone.

## Requests for Claude Code (not blocking)

- `TurnDuration` props with a pending-agents count. This only matters if D1 is A.
- A way for a hook to set the ExitPlanMode dialog's title and the "ask" frame's wording. This only matters if Phase 2 is not built.
- `${CLAUDE_PLUGIN_ROOT}` expanded in a plugin's `subagentStatusLine`.
- MCP elicitation titled by the plugin's display name, not `MCP server "plugin:…" requests your input`.
