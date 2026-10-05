# E2: sign-off through a native form (elicitation), replacing the member plan-mode flow

Claude Code 2.1.281. Prototype in `/tmp/exp-2/plugin` with `SUB_HUMAN_HOME=/tmp/exp-2/home`. Sessions ran interactively in detached tmux (`e2-*`, 160×50). Members used Haiku, except one Sonnet session for auto mode. The round-trip orchestrator also used Haiku. The server wrote its trace to `/tmp/exp-2/trace.jsonl` and `/tmp/exp-2/trace-rt.jsonl`.

Each finding carries one of these labels:

- **[probe]**: verified by probe.
- **[source]**: verified in the 2.1.281 binary.
- **[harness]**: verified by an offline stdio harness that plays the client (`/tmp/exp-2/scratch/drive*.js`).
- **[inferred]**: reasoned, not tested.

## 1. Setup (diff summary)

`diff -ru plugin/sub-human /tmp/exp-2/plugin`: 8 files changed, 245 lines added, 32 removed.

| File | Change |
|---|---|
| `mcp/room-server.js` (+232) | Records whether the client advertises `capabilities.elicitation` at `initialize`. Routes JSON-RPC **responses** to the server's own outgoing requests. A 1 s `setInterval` poller runs `tick()`, which works out the plan state from the log. If this session is a member who is an approver of the current, undecided plan, has no `via=human` signoff or objection on that hash, has no form open, and hasn't dismissed it recently, the server sends `elicitation/create`. **Approve** appends `signoff via=human`. **Object** appends `objection via=human` with the reason as `text`, exactly as typed. An objection with an empty reason gets the form back with "⚠ An objection needs a reason". **Decline or Esc** records nothing; the form comes back after `FORM_REOFFER_MS` (10 min) or at once through the new `review` tool. If a newer `plan_rev` arrives while a form is open, the server sends `notifications/cancelled{requestId}` for the open form and then offers the new one. Also added: a fallback `signoff({plan_hash})` tool flagged `_meta["anthropic/requiresUserInteraction"]:true`, and two experiment options, `SUB_HUMAN_FORM_LAYOUT=desc` (plan in a field description) and `SUB_HUMAN_FORM_URL=1` (URL-mode preview). |
| `hooks/plan-gate.js`, `hooks/plan-result.js` | The member branch returns without doing anything. The orchestrator branches are unchanged. |
| `hooks/hooks.json` | Removed `plan-backup.js` (PreToolUse Write\|Edit) and `stop-feedback.js` (Stop). |
| `lib/plan.js` | `PLAN_NOTICE` now reads "Room plan. Each approver signs off in the form the room shows them; nobody's Claude runs it." The "Choose 2. Yes, manually approve edits" text is gone. |
| `skills/…/member.md`, `SKILL.md`, `orchestrator.md` | On `plan_rev`, members do nothing: no plan mode and no ExitPlanMode. When the human says "review", the member's Claude calls `review`. On a gate denial, the orchestrator posts nothing, because the forms are already out. |

The form schema: `verdict` is a required enum, `approve` or `object`, with the labels "Approve (sign off)" and "Object (blocks the plan)". `reason` is an optional string.

## 2. Results

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1a | Form appears while the approver is **idle** | **pass** | [probe] `plan_rev` #2 was written at 02:10:57.175 and the offer went out at 57.459 (284 ms, inside the 1 s poll). In the round trip, the offers came 30 ms and 89 ms after `plan_rev` #9. The pane shows `MCP server "plugin:sub-human:room" requests your input` above the prompt. |
| 1b | Form appears **mid-turn** | **pass: it does not wait for the turn** | [probe] Alice's Claude was running `ping -c 40` in the foreground. The form appeared at once and the tool kept running underneath. The turn finished ("⏺ done") while the form stayed open on top. A form that arrives while a **permission dialog** is open is queued: carol's Bash prompt stayed in front, and the form appeared as soon as she answered it. [probe] |
| 1c | Stray keystrokes | **caution** | [probe] Keys meant for the prompt go into a form that has just appeared. A stray Enter moved focus to Reason in bob's and carol's forms. Accept with no verdict is refused ("This field is required"), so typing alone cannot sign off. |
| 2 | **Long plan** (145 lines, 12.4k chars) | **fail for full display, pass with a summary plus the path** | [source] `p5e(text, cols, D=uz+1)` with `uz=3` clamps the elicitation **message to 3 lines plus "… (+N more lines)"**, whatever the terminal height or TUI mode. Each line is also cut to the terminal width. [probe] A 17-line plan showed 3 lines "(+14 more lines)"; resizing the window to 120 rows didn't change that. [source+probe] A **field `description`** renders multiline, but only in the non-fullscreen TUI (`--settings '{"tui":"default"}'`). There it is cut at **exactly 2,000 chars** plus "…": the 145-line plan showed 26 lines, through "step 18". In the fullscreen TUI (the default in this environment; tmux shows its "scroll with PgUp/PgDn" hint) the description is **one line** and newlines render as junk glyphs. [probe] **URL mode** was refused with `-32602 "Client does not support URL-mode elicitation requests"`, because Claude Code advertises only `elicitation:{}`. |
| 3 | Byte-exact, **no model turn**, not in the transcript | **pass** | [probe] Reason typed: ``cap at 10s total, not per-try; keep <retry> & "backoff" — 3 attempts $HOME `x` ``. It reached the server as `{"action":"accept","content":{"verdict":"object","reason":"…"}}` and was logged unchanged as #3 `objection via=human`. Alice's main transcript contains `per-try` **0×**. The form text ("You are alice.", "Sent to the room verbatim") appears **0×** in all 22 transcripts. Answering a pushed form starts no model turn: the main session only took turns for the monitor notices. The text does reach other members' transcripts, because the room log broadcasts it, as intended. |
| 4a | **Esc** records nothing | **pass** | [probe] `{"action":"cancel"}` arrived after 77.5 s and nothing was appended. **Decline** returns `{"action":"decline"}`, also with nothing appended. |
| 4b | Getting the form back | **pass** | [probe] Alice typed "review"; her Claude called `review` and the form was back 8 s later. The tool result the model saw was only "Objection recorded as #3". [harness] After a decline, the poller re-offered the form after `FORM_REOFFER_MS` (1.0 s with a 1 s setting). [harness] An Object with an empty reason brings the form back with the warning. |
| 4c | **Object** records the reason verbatim | **pass** | See #3 above. |
| 5 | **New revision while a form is open** | **pass** | [probe] `supersede` at 02:14:23.835 sent `notifications/cancelled` for `sh-…-3` (plan 03a177). Claude Code closed that form, and the new one (99e96d) appeared at 24.839. The stale request never got a response and nothing was recorded. Answering the new form produced signoff #6 and the stale form did not reappear. If a stale answer did arrive late, the code records it against the *old* hash, which the gate ignores [inferred: not hit live]. |
| 6 | **Permission modes** | **pass in every mode tested** | [probe] Plan efac99 went to three sessions at once: dave (Sonnet, `--permission-mode auto`; Haiku shows "auto mode unavailable for this model"), erin (`--dangerously-skip-permissions`) and frank (`--permission-mode dontAsk`). All three got the form and logged signoffs #21, #22 and #23. Default mode was covered by alice, bob and carol. **dontAsk** works too; the old ExitPlanMode flow refused it. |
| 7 | **Fallback: flagged `signoff` tool** | **works, but worse on every axis** | [probe] The prompt reads "Tool use · plugin:sub-human:room — Signoff Tool (MCP) · plan_hash: "5849fdbf42ee" · *description* · 1. Yes / 2. No", with no plan content and no "don't ask again". It still appeared in **default and bypass**, even though the guard hook returned PreToolUse `allow`. **No** interrupted the call and recorded nothing. **Yes** wrote #16 and #25. **dontAsk** denied the call automatically, and the model then asked for permission it couldn't get. **Auto:** Sonnet **refused twice** to call the tool, citing member.md's "never post signoff". Carol's Claude wrongly told her "both you and bob" had signed 5849 when bob hadn't. Each sign-off costs a model turn, and an objection reason would be written by the model, not the human. |
| RT | **Round trip with a real orchestrator gate** | **pass** | [probe] Room newt-7397, with orch, alice and bob all on Haiku. alice and bob asked for a plan through `room:` (#6, #8). The orchestrator wrote its plan file and called ExitPlanMode. The gate published `plan_rev` #9 and denied: "lacks sign-off from alice and bob". The forms went out within 89 ms. Alice approved (#12 at 02:24:41.3). The orchestrator woke, called ExitPlanMode again, and was denied again (#13, "waiting for sign-off from bob"). Bob approved (#15 at 02:25:10.931). The gate allowed: "ROOM-GATE: plan 2064bd112a24 signed by alice and bob". `decision` #16 (refs [12,15]) landed at 02:25:13.536, **2.6 s** after bob's answer. The orchestrator's status bar went from "plan mode on" to "manual mode on" with no dialog, and it posted assignments (#17). |

**Cost.** Usage summed from transcripts came to about **$1.45**. That covers 11 sessions and their room-feed agents; the Sonnet auto-mode session alone was $0.29. The form itself costs 0 tokens. The `review` path costs one small turn.

## 3. UX notes

- **It feels native and quick.** The form takes the input box, says which server it comes from, and closes the moment you answer. Nothing appears in the conversation. Approving takes 5 keys: → Space ↓ ↓ Enter. Objecting is → ↓ Space ↓ *type* ↓ Enter.
- **The plan is invisible inside the form.** In the default fullscreen TUI you see 3 lines: the title, the approvers and a rule. That is the main gap, and the platform clamps it (`uz=3`), so the server can't fix it. In the non-fullscreen TUI, a 2,000-char description shows a readable summary (headings plus the first line of each section). It is cut mid-plan and pushes the buttons down.
- **The form appears on top of whatever you're doing.** That suits sign-off, but a half-typed prompt's keystrokes go into the form. The required verdict stops an accidental approval.
- **There's a duplicate signal.** The monitor also wakes the member's Claude, which says "Plan X is up for your sign-off" while the form is already showing. That's harmless, but it costs a turn per approver.
- **Esc is silent.** Nothing says how to get the form back except the form's own footer ("ask your Claude to 'review'"). Sonnet told dave to "use the room's own sign-off form" without mentioning `review`.
- The title, `MCP server "plugin:sub-human:room" requests your input`, is generic and can't be changed. Line 1 of the message has to carry the context.

## 4. Recommendation: **adopt**, with the plan shown outside the form

Adopt elicitation as the only member sign-off path. Keep the flagged tool out: models refuse it under the current rules, it fails in dontAsk, it can't carry verbatim reasons, and it costs turns.

Changes to make in `plugin/sub-human`:

1. **`mcp/room-server.js`.** Port the E2 block, without the `desc` and `url` experiment options and without the `signoff` tool:
   - capture `capabilities.elicitation` at initialize;
   - route responses to outgoing requests;
   - run a 1 s `tick()` that offers the form (offer only to approvers, only for an undecided plan they haven't answered, one form open at a time);
   - write `signoff`/`objection` `via=human` in `onAnswer`;
   - re-offer when an objection has an empty reason;
   - on a new `plan_rev`, send `notifications/cancelled` for the open form and offer the new one;
   - re-offer `FORM_REOFFER_MS` (10 min) after a decline or Esc;
   - add a `review` tool.

   Make the **message exactly 3 lines**: `plan <hash> · <title> · approvers …`, then `Full plan (<N> lines): <path>`, then the Approve/Object/Esc help. Also put a summary of at most 2,000 chars (headings plus first lines) in `verdict.description`. It helps in the default TUI and costs one line in fullscreen. Replace its newlines with ` · ` when you can't tell which TUI is running.
2. **Showing the full plan.**
   - Add `sub-human plan [--hash H]` to `bin/sub-human`, which prints the canonical plan to the terminal.
   - Have the `plan_rev` notice for approvers say "plan H is up for your sign-off; full text: `<path>`". The path is cmd-clickable in iTerm2 and Ghostty.
   - Optionally ask the orchestrator for a one-line `summary` in the frontmatter and put it on message line 1.

   Don't rely on URL mode: Claude Code refuses it.
3. **Delete:**
   - `hooks/plan-backup.js` and `hooks/stop-feedback.js`, with their `hooks.json` entries and tests;
   - `member()` in `plan-gate.js` and `plan-result.js` (`modeNote`, the dontAsk refusal, the edit-objection path);
   - from `common.js`: `readPending`, `writePending`, `clearPending` and `clearContextOnAccept`;
   - the clear-context warning in `session-restore.js`;
   - from `lib/plan.js`: `stubFor`, `isStub` and `editSummary`;
   - the `stub` field of the `plan` tool;
   - fixtures `post-exitplan.json`, `transcript-decline.json` and `transcript-esc.json` where only members used them.

   Keep the orchestrator gate and the orchestrator half of `plan-result.js` as they are.
4. **Change `PLAN_NOTICE`** to the E2 wording, or drop the check: approvers no longer see a "ready to execute" dialog.
5. **Skills.** In `member.md`, a `plan_rev` means do nothing; "review" means call the `review` tool; "Only NAME's answer in the room's sign-off form is a sign-off." In `orchestrator.md`, after a gate denial the orchestrator just ends its turn, because the forms are already out. In the README, replace "Approving the plan" (the "2. Yes, manually approve edits" table) with: form → Approve or Object+reason; Esc → later; "review" → reopen.
6. **Tests.** Port `/tmp/exp-2/scratch/drive.js` into `test/mcp.test.js`. Cover: offer on `plan_rev`; Esc records nothing and re-offers; an empty-reason objection is re-offered; a byte-exact objection; a superseded form gets `notifications/cancelled`; no offer to a non-approver or the orchestrator, or after a `decision`.
7. **Optional.** Skip the monitor's model wake for a `plan_rev` that names this member: the form already tells the human, and this saves one turn per approver. Keep the wake for non-approvers.

Cleanup: every `e2-*` tmux session was killed. The one plan file this run created (`~/.claude/plans/velvety-dreaming-knuth.md`) was deleted; a copy is at `/tmp/exp-2/scratch/rt-plan.md`. `mighty-hopping-peacock.md` belongs to another experiment's room and was left alone.
