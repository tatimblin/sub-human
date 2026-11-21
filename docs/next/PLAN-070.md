# 0.7.0: plan feedback with no extra gates

Implements PLAN-SMOOTH.md 0.7.0. Branch `plan-070`, worktree `~/repos/sub-human-plan070`, cut from `walk-061`; it is rebased onto master once 0.6.1 merges.

What a person sees after it:
- **Reviewer:** plan view, then "Tell Claude what to change" with a note. The note is sent at that point, with one line: `Sent your changes to tristan.` No Send/Discard card.
- **Author:** their Claude gets the note and writes the next version itself. It asks only about what the note leaves open. The new version opens in the author's own plan view (owner decision 1a). Their Yes sends it out.
- **After a Yes:** Claude says nothing more than one sentence.

## Steps

### 1. The note is the send (runtime done, tests pending)
- `lib/consent/review.ts`: `reduce` wraps the reducer. Any note a step resolves is recorded as an Objection with that note in the same step, and its outcome is added to whatever the step says. Removed:
  - the note's stages (`noteAtStop`, `noteAtPrompt`, the `ask` and `answered` note branches, the `noteAnswer` event)
  - the room-tool refusal while a note waits
  - every card line (`noted`, `nudge`, `reoffer`, …)
- `hooks/consent.ts`, `mod/consent.ts`: the `members/NAME/confirm` document, `confirmCard`, the module's own Send/Discard `$.ui.ask` (#34 `noteAsk`/`NoteAnswer`) and `noteWaits` are removed.
- `lib/tail.ts`, `lib/agent-post.ts`: the "note waits" lines are removed. The relay guard stays for a note already sent (a post that repeats it within 10 minutes is refused).
- `mod/core/prefilter.ts`, `hooks/handlers/consent.ts`: the post tool no longer always wakes consent. That is one node process fewer per post.
- Person's line: `Sent your changes to NAME.` comes as a notice once the objection is recorded. A failed send keeps today's failure line.
- **Tests:** rewrite the note cases in `consent-review`, `consent`, `consent-table`, `consent-author`, `mcp`, `tail` and `mod/test/consent` as "the note records at once". Delete the card and stage cases.

### 2. The author's Claude drafts the next version
- `lib/room/render.ts` `changesLine`, for the author's Claude only: draft the next version from the note now with the plan tool, and ask your person only what the note leaves open.
- `SAY.noteFollow`, for the objector's Claude: the note went to the author. Drop "you may write its changes", so only one v2 gets written. Keep "if it asks anything else, do it".
- `skills/sub-human/member.md` line 9: "only when NAME asks" gets an exception for writing the next version after someone requested changes on a plan of NAME's.
- The new version still opens in the author's plan view before anyone else is asked. This is already how it works (`proposal.check`); no change.

### 3. One call stores a version
- `plan({op:'edit', name, text, summary})` stores the version (the put path) and returns the hash. The author's check then opens with the usual EnterPlanMode/ExitPlanMode stub.
- The plan-mode edit is no longer used: the seeded header, the capture and the enter/exit/deny round trips. That covers `lib/consent/edit.ts`, the `plan-edit` gated feature and its contract entries.
- The only gate left is the plan view, where Yes sends it out.

### 4. Quiet after a send
- `SAY.sent` and its siblings become one sentence. The plan file and the mode come back without a line (`fileBack`, `modeChanged` go to debug only where the model doesn't need them).

### 5. Release
- `plugin.json` 0.7.0, CHANGELOG, README (plan feedback paragraph), `docs/ARCHITECTURE.md` (`npm run docs`), CLAUDE.md demo notes for S5.
- **Wire protocol:** unchanged. The confirm document was only on the seat; objections already carry their note.
- **Demo:** S5's driver no longer answers a Send card. Update `checks/s05-consent.ts`.
- **Gate:** `--only S1,S2,S4,S5,S10` for auto, default and acceptEdits, then `checks.ts`.
- Then the 0.6.x release recipe.

## Owner decisions (2026-11-21)
1. **Group planning is unchanged.** Versions, sending them back and forth, and sign-off per version all stay. Step 3 only changes how Claude writes a version. The plan-mode edit goes entirely: people never type into the plan file; they give feedback with "Tell Claude what to change".
2. **A note that can't reach the host** (link down) is not queued: the outbox keeps out answers on purpose (`lib/remote/outbox.ts`: a late answer is worse than none, and its signature expires). The person gets one line, `Your note didn't reach the room; ask Claude to send it again when you're back online.` The model is told the same, with the note, so "send it again" reopens the review with nothing retyped.

## Order
1, then 2 (they share the wording), then 4, then 3 (the biggest deletion, last so 1, 2 and 4 can ship as 0.7.0-beta if 3 slips).
