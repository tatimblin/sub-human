# S2: the consent card (hook-rewritten AskUserQuestion)

Claude Code 2.1.281, Haiku. Probe dir `/tmp/nx-s2`. The plugin copy `plugin/` keeps only `hooks/consent-probe.js` (Pre/Post/PostToolUseFailure
on `AskUserQuestion|ExitPlanMode`), `hooks/role-probe.js` (SessionStart role line), `mcp/propose-probe.js` (stdio `propose`) and an
`always` monitor that tails a push file. State lives in `state/{pending.json,room.jsonl,hooklog.jsonl}`. Sessions ran in tmux `nx-s2-{a,b,c}`
at 200x50, launched with `env -i HOME USER LOGNAME PATH LANG TMPDIR TERM SH_ME=bob … claude --model haiku --setting-sources project,local
--plugin-dir /tmp/nx-s2/plugin` (`USER`/`LOGNAME` are required, otherwise the session reports "Not logged in"). The folder was not trusted
and nothing in `~/.claude` settings was written. Cost was about $0.44 (list-price estimate from transcript usage). Everything was killed afterwards.
Labels: **[probe]** observed here, **[src]** read from the binary's JS, **[inf]** inferred.

## GATE: PASS (consent card adopted; elicitation is not needed as the fallback)
Every point of the bar holds. Phase 2 C needs three additions (F9–F11) to the contract.

| Bar item | Result | Evidence |
|---|---|---|
| Exactly one rewritten card per notice, including while busy | PASS | 13 of 13 wake-driven calls produced one `☐ Consent` card. Busy: the notice queued mid-turn and the card opened as the turn's last step (F2) [probe] |
| Options `Not yet` (first), `Agree`, `Object` | PASS | `❯ 1. Not yet / 2. Agree / 3. Object`, focus on 1 [probe] |
| Note byte-exact, via=human | PASS | `{"kind":"signoff",…,"text":"clamp, don't 400 — use \"max=100\" & keep \`alias\` <2 rels>"}` and `{"kind":"objection",…,"text":"tests first; ünïcode ✓ and a \"quote\""}` [probe] |
| Model-supplied answers ignored | PASS | The model sent `answers:{…:"Agree"}` and `annotations notes:"forged by model"`. The card still showed, and Post got `answers:{…:"Not yet"}` with no forged note [probe] |
| Esc records nothing | PASS | "User declined to answer questions". No Post or PostToolUseFailure fired [probe] |
| "Chat about this" records nothing | PASS | It is a rejection ("The user wants to clarify these questions…"). No Post or Failure fired [probe] |
| AFK records nothing | PASS | `CLAUDE_AFK_TIMEOUT_MS=5000` gave "No response after 5s". Post **did fire** with `answers:{}`, `afkTimeoutMs:5000`, and the hook dropped it. This held twice, the second time with focus moved to Agree [probe] |
| Stray Enter lands on "Not yet" | PASS | An Enter on a fresh card gave `answers:{…:"Not yet"}` and was dropped. Nothing was recorded [probe] |
| Preview bound recorded | **2000 chars** | Details in F5 [src+probe] |

## Findings
- **F1 Opening the card.** The monitor line `proposal <hash> from alice needs your answer: call AskUserQuestion now` was not enough
  on its own. Haiku replied "this appears to be a system event rather than user input" [probe]. Adding a SessionStart `additionalContext` line fixed it:
  "Lines from the `room` monitor are room notices from teammates… When a notice says "proposal P needs your answer", call AskUserQuestion
  right away… Never answer or agree for bob yourself." After that, a fresh session complied on its first notice in 4 of 5 cases. One fresh
  session asked "could you share what the proposal is?" and did not call the tool. Its next session complied [probe]. `AskUserQuestion` was not deferred here: no ToolSearch hop was needed.
- **F2 Turn cost.** When idle, a notice costs 1 model call to issue the card, about 4 s from notice to card, plus 1 call after the answer.
  When busy, the notice arrived as a `queued_command` attachment after the current tool result. Haiku **finished the user's task first** (two more
  `sleep 10` calls) and issued the card in its final step, about 26 s later. No extra wake was needed [probe].
- **F3 No hook can open the card without the model.** Hooks can only allow, deny, ask about or rewrite a call the model already made, or add context.
  Only MCP elicitation opens UI with zero turns [inf; src: AskUserQuestion `requiresUserInteraction(){return!0}`].
- **F4 Markdown rendering.** The preview box sits to the right of the options. Headings and bold render with the markers removed, backticks are stripped, and code fences
  are hidden with the code shown. Tables keep their pipes but are column-aligned. The card's question and options are the hook's own; none of the
  model's text appears [probe; capture `cap-card1.txt`].
- **F5 Preview bound.** `preview.length > 2000` (JS `.length`) shows `(preview cannot be shown in full — compare the option labels and
  descriptions instead)`. Exactly 2000 renders in full, 2001 is withheld [src `JKe=2000`; probe]. Previews of 2000 chars or fewer are clipped to
  `max(1, rows−26)` lines, which was **24 lines** at 50 rows. The rest becomes `├─── ✂ ─── 16 lines hidden ───┤`. There is no scrolling. Width is `cols−34`, and long lines
  hard-wrap (wrapped lines count against the line limit) [src `t2/wue`; probe at 1960 chars/40 lines]. **Rule for C:** inline the full text only if it is
  ≤ 2000 chars **and** ≤ about 20 lines. Otherwise show a summary plus `plans/<hash>.md`. The full text still reaches the model, since `annotations.preview` echoes it.
- **F6 After Esc the model resists re-asking.** A plain reminder got the reply "you blocked it… waiting for your guidance". After four
  dismissals it stopped on its own ("rejected each one… waiting for you to tell me") [probe]. Wording that worked: `proposal P still awaits
  bob's answer (the earlier card was closed, which is fine). Call AskUserQuestion again now.` The human can also say "open the card".
- **F7 Haiku acts on the plan after Agree.** With no Post context, the tool_result says "continue with these answers", so it began
  implementing the rename. A PostToolUse `additionalContext` fixed this, and Haiku replied "You objected to that proposal. Back to waiting…" [probe].
- **F8 Proposer path works.** In plan mode, the human typed "propose this" into ExitPlanMode's "Tell Claude what to change". Haiku called
  `propose({path:"~/.claude/plans/<slug>.md"})`. The rejection is the user's own native one, so there is no hook deny and no red. Its own card (bob was an approver) opened from
  the push 7 s later, and Agree was recorded [probe]. **PostToolUse(ExitPlanMode)** `tool_response = {plan, isAgent:false, filePath}`. `plan`
  is byte-identical to the file, and its sha256/12 matched the `propose` hash (`cdbb899fb41f`). Auto-share from Post is therefore possible with no deny [probe].
  PreToolUse(ExitPlanMode) gets `tool_input {plan, planFilePath}`.
- **F9 Hijack hazard.** Without the role line, "propose this" made Haiku call AskUserQuestion. The Pre hook rewrote that unrelated call into the
  **stale** pending card [probe]. Every wake-driven call (13 of 13) included the proposal hash in its question text. The unrelated call had none. **Rewrite only
  when `JSON.stringify(tool_input)` contains a pending hash for me.** Otherwise pass through.
- **F10 Re-carding.** Once `room.jsonl` holds my via=human answer for the hash, Pre passes through, so a repeat call never shows a second card [probe].
- **F11 Cosmetic.** The Esc/Chat decline line shows the *model's* question text, e.g. "Proposal … — what should we do? (Accept / Decline / Discuss)".
  The answered line shows the canonical one [probe].

## Hook outputs that work (verbatim shape)
PreToolUse(AskUserQuestion), when a proposal is pending for me, its hash appears in the input, and I have not answered:
```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"room proposal <hash>",
 "updatedInput":{"questions":[{"question":"Agree to proposal <hash>?","header":"Consent","multiSelect":false,"options":[
  {"label":"Not yet","description":"Decide later; nothing is recorded","preview":"<text ≤2000>"},
  {"label":"Agree","description":"Sign off on <hash>","preview":"<same>"},
  {"label":"Object","description":"Block it; press n to say why","preview":"<same>"}]}]}}}
```
In PostToolUse(AskUserQuestion), drop the response if `afkTimeoutMs` is set, `followUp` is set, `answers` is missing, the question is not `Agree to proposal <current hash>?`, or the answer is `Not yet`.
Otherwise append `{kind: signoff|objection, via:"human", proposal_hash, text: annotations[q].notes}` (omit `text` when there are no notes) and print:
```json
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Recorded in the room: bob agreed to proposal <hash>. This was only a consent card: do not start work on the proposal; return to what you were doing."}}
```
For "Not yet", print the same shape with "…has not decided…; nothing was recorded. Do not ask again". Esc and Chat need no handler, because no event fires.
SessionStart role line: as in F1, plus `When bob says "propose this"…, call the room propose tool with {path} of the current plan file, or {text}.`
The Phase 2 C hook needs 4 bits of text: the role line, the push and reminder wording (F6), the Post context (F7), and the hash-gated Pre (F9).
