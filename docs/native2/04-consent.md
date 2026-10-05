# 04: Consent: the most native way to get each human's yes

Claude Code 2.1.281. Sources: `strings` of the binary (offsets cite `/tmp/n2-04/strings.txt`), round-1 `06-approval.md`, and one live probe
(`/tmp/n2-04/p1`, haiku, tmux `n2-04-a`, killed afterwards). The test applied to every mechanism: it feels native, needs no custom UI,
**a Claude cannot answer for its human**, and it works for an ad-hoc "do we all agree on X?" as well as for a full plan.

## 1. Capability: what each candidate really is

| Mechanism | Who answers | Can a Claude answer it? | Ad-hoc question, no plan? | Verdict |
|---|---|---|---|---|
| **Our elicitation form** (`mcp/signoff.js`) | the human in their own terminal; the room server pushes the form with no model turn | No. The answer goes to the server and the model never sees it. An `Elicitation` hook can auto-accept, though: "Hooks can auto-respond (accept/decline) instead of showing the dialog", and `ElicitationResult` can override the answer. [verified-by-source @13772232] | Yes | Works, but looks poor: at most 4 plain lines, no markdown, and it needs the stray-Enter guard and two stages for "object + reason" |
| **AskUserQuestion** | the human (or their own Remote Control client) | No. `requiresUserInteraction(){return!0}`, and `checkPermissions` rebuilds `updatedInput` from `title`, `questions` and `metadata` **only**, so any `answers` the model supplies are dropped [verified-by-source @26368741]. Only a PreToolUse/PermissionRequest hook that returns allow with `updatedInput` can satisfy it (same hole as elicitation). | Yes | **Best native UI.** It was probed (§1a). |
| **ExitPlanMode in the proposer's own session** | that session's human, in the native plan dialog | No, except through the documented "hook satisfied user interaction" path | No, plan mode only | Fine as a *proposal* trigger (§2). It never reaches other humans. |
| **Teammate/subagent plan approval** (`planModeRequired`, `plan_approval_request`) | **the lead's Claude, or nobody**. `[InboxPoller] Found N plan approval request(s), auto-approving` writes `approved:!0` automatically [verified-by-source @40267780]. Otherwise the lead *model* approves or rejects through SendMessage: "Only the team lead can approve plans" [@42599330]. | **Yes: the model is the approver.** | No | **Don't use.** It inverts the guarantee. |
| **PermissionRequest hook → another session** | any process that writes the hook's answer, while the local dialog stays open | Only if a Claude can write the room log (gate it by via=human, as now) | n/a (tool prompts only) | Routing only, not consent (§4) |
| **Channel permission relay** | first answer wins; flagged tools (ExitPlanMode, AskUserQuestion) are never relayed [06, verified-by-source] | — | — | Research preview. Skip. |

### 1a. Probe: AskUserQuestion as the sign-off card [verified-by-probe]
The setup: a PreToolUse hook on `AskUserQuestion` returned `permissionDecision:"ask"` with an `updatedInput` that replaces the model's
questions with the room's canonical text. In the probe, Haiku was told to ask "Pick a color?" and to pre-fill `answers:{"Pick a color?":"Red"}`.
- The dialog showed **only the hook's card**. Header chip "Sign-off", the question "Approve plan abc123 (rev 2)?", and options Approve and Object, each with
  `preview` set to the plan's markdown. The plan rendered **as markdown in a box beside the options**. The model's color question and its
  pre-filled "Red" never appeared.
- Built-in affordances need no custom UI: ↑/↓, Enter, **`n` to add notes** (free text tied to the choice), `ctrl+g` to edit the note in an editor,
  "Chat about this", and Esc.
- I chose Object and added the note "tests must come first". **PostToolUse** received
  `tool_response.answers {"Approve plan abc123 (rev 2)?":"Object"}` and `annotations{…:{preview:<plan>, notes:"tests must come first"}}`, byte-exact.
  A hook can write this to the room as via=human, so the model's own retelling is never trusted.
- **Esc** printed "User declined to answer questions". **No PostToolUse or PostToolUseFailure hook fired**, so nothing is recorded (same as Esc today).
  Cosmetic issue: the decline line re-renders the *model's* original question text, not the hook's.
- The model also sees the answer and the plan text in its tool_result. That is harmless, and it tells the proposer's Claude what to revise.

### 1b. Hazards found in source
- **AFK auto-advance.** AskUserQuestion can auto-resolve after `CLAUDE_AFK_TIMEOUT_MS` (default `hGn=60000`) of idle, when the `afk` gate is on
  (`tengu_ask_user_question_afk_auto_advance`). The result then carries `afkTimeoutMs` ("Absent on every human-resolved path"). **The
  recording hook must discard any response that has `afkTimeoutMs`, `followUp`, or `response` without `answers`.** [verified-by-source @39947870, @26363844]
- **Hook satisfaction.** Any PreToolUse hook (allow plus `updatedInput`) or `Elicitation` hook in the human's own session can answer for them. Both
  mechanisms share this. The only actors who can add such a hook are the human or a settings write. Settings writes can be
  `staged_for_review` ("a settings-file write held for the machine owner's review") [verified-by-source @13352499]. This is no worse than today.
- **Stray Enter.** Focus starts on option 1. Put **"Not yet"** first (it records nothing) and Approve and Object after it. This replaces
  `SUB_HUMAN_FORM_MIN_MS`. [inferred; typeahead was not probed]

## 2. Mapping: one consent primitive, three ways to start it
The consent is the same in every case: **a proposal id with canonical text in the room, and one AskUserQuestion card per named human.** The hook
writes that card, and the hook records the answer. Proposals can start in three ways:
1. **Ad-hoc ("do we all agree on X?").** Anyone tells their Claude, which calls `post` with kind=`proposal`, text X, and the approvers (default: everyone present).
   No plan mode, no orchestrator, no frontmatter. [inferred design]
2. **A member's own plan mode.** The member plans natively. Their `ExitPlanMode` is the proposal. PreToolUse(ExitPlanMode) publishes the plan
   file's bytes as the proposal and **denies** with "sent to the room for consent". When every other approver has signed, the gate
   returns **`ask` plus `updatedInput`** (the canonical bytes), so the proposer's *own* consent is the native plan dialog, as the final yes. This is the
   orch half of `plan-gate.js` generalized to any member. The ask-plus-updatedInput behaviour on ExitPlanMode was verified in round 1 (06, spike-results-2).
3. **"Let's plan X" to the orchestrator.** Unchanged: the orch's ExitPlanMode is the proposal through the same gate.

On the approver side, the room monitor's wake line (already present) says "proposal P needs your answer: call AskUserQuestion". The model makes
any call. The plugin's PreToolUse hook sees a pending proposal for this human and **replaces the question with the canonical card**. So the model
cannot misstate the plan or choose the answer, and any AskUserQuestion it makes while a proposal is pending becomes the consent card.
PostToolUse appends `signoff`/`objection` (`text` = notes) via=human with `plan_hash`. 

## 3. Minimal footprint
- **Removed:** `mcp/signoff.js` (250 lines), the `review` tool, the dependency on the elicitation capability, `planLib.packed` for the 4-line display,
  the two-stage form, the re-offer and cancel timers, and `notifications/cancelled` handling. A stale card does not need cancelling: the PostToolUse hook ignores an
  answer whose hash is no longer current.
- **Added:** one PreToolUse(AskUserQuestion) and one PostToolUse(AskUserQuestion) hook, about 80 lines together, in `hooks/consent.js`. Plus kind=`proposal` in `lib/room.js`.
- **Kept:** `plan-gate.js`, now for any proposer and not only the orch. `plan-result.js` stays to record the proposer's own yes. The approver list and hash in `lib/plan.js` also stay.
- **Net:** about −170 lines, one MCP tool fewer, and a much better card: full markdown plan, notes, "Chat about this".

## 4. Limits and risks
- **It needs a model turn per approver.** Elicitation arrives with zero turns; AskUserQuestion needs the approver's Claude to call it. It waits until a busy
  session finishes its turn, and it costs one turn on the member's model. A Claude that ignores the wake only delays consent. It can never forge it. [inferred]
- The card is limited to 1–4 questions and 2–4 options, and previews are size-bounded (validated by `admitCardAnswer`). Long plans should show a summary
  plus the path, or split across questions. [verified-by-source]
- AskUserQuestion is unavailable in `-p` and headless sessions and is probably denied in `dontAsk` mode. Fall back to elicitation there. [inferred]
- AFK auto-resolution is the one real way a non-human answer could arrive. It is flagged in the result, so filter on it (§1b).
- **PermissionRequest routing** (sending Alice's Bash prompt to Bob): the hook blocks and polls the room for Bob's via=human answer while Alice's local
  dialog stays live, and the first decision wins. A flagged tool needs `updatedInput` to be satisfied (`ATn`: built-in and not MCP)
  [verified-by-source @36757123]. It works, but it is routing, not consent. Defer it.

## 5. Recommendation
- **Adopt now:** AskUserQuestion, hook-rewritten, as the single consent card for ad-hoc proposals and plans alike. Generalize the ExitPlanMode gate
  so any member's own plan mode can become the room's proposal (deny → ask), with the proposer's native plan dialog as their own sign-off. Keep the elicitation form
  only as a fallback for clients without AskUserQuestion, or drop it.
- **Don't adopt:** teammate `planModeRequired` approval, because the lead model or an auto-approver consents for everyone.
- **Later:** PermissionRequest routing of a member's ordinary tool prompts to a named human.
- **Settling experiment:** two haiku sessions in a room. A posts a proposal "agree to rename X?" while B is mid-turn. Pass if (1) B's wake leads to
  exactly one hook-rewritten card, (2) B's Approve or Object with notes lands in the log as via=human, byte-exact, (3) Esc, "Chat about this" and an AFK timeout
  (`CLAUDE_AFK_TIMEOUT_MS=5000`) record nothing, and (4) a stray Enter typed into B's prompt just before the card records nothing ("Not yet" first).
