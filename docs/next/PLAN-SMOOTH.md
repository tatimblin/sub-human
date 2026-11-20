# PLAN-SMOOTH: one command to start, one line to join, a quiet room, rows you can talk to

Source: the owner's two-person room orca-6418 (2026-11-20, 0.5.8 installed), audited against the transcripts and the source. Base: branch `quiet-070` (0.6.0, unreleased), which already fixes part of it. PLAN-QUIET's five rules hold for every change here.

## What went wrong, and why

| Felt | Cause |
|---|---|
| Opening a room, then a second command to bring someone in | `/sub-human` bare (`lib/commands/join.ts:122`) only takes a seat; the other path is a separate command (`lib/commands/invite.ts:52`). The handler knows the room was just opened (`hooks/handlers/join.ts:61`) but never passes it on. The transport (tailnet or ssh) is guessed silently. |
| Join is heavy | Seven argument shapes, one per transport, added as each shipped (`join.ts:233-285`). Every link is already one `KIND:REST` locator inside (`lib/remote/transports/index.ts:70`); the URL form was a PLAN-JOIN follow-up never done. |
| Too much explaining | 7-line burst when the line was made (0.5.8; one line on quiet-070). The same event drawn up to 3 times: notice, a plugin-sent prompt, then an FYI block (`render.ts:200-217`, `deliver.ts:190`, `constants.ts:49`). Model context that makes Claude narrate (`review.ts:187,238`, `member.md`). The copy card costs a visible model turn (`copy.ts` copyWake). The join line carries a check code, rename and kick hint (`server.ts:112`). `post` echoes its whole record. |
| Plan feedback asks "send?" | Reviewer: "Tell Claude what to change" opens a Send / Discard card instead of sending (`proposal.ts` confirmCard, `review.ts`). quiet-070 keeps that card, only moves it earlier. Author: `changesLine` says "you may revise … if tristan wants it" (`render.ts:328`), so Claude asks instead of drafting; then ~7 tool calls of plan-file juggling and two denials (`edit.ts`) before a third "send it out" gate. |
| Messaging the room row does nothing | The row is inside a `hold` that never returns in normal use (`mcp/hold.ts`); Claude Code queues typed text until the tool call ends, so it never arrives. The row's prompt says to answer only "read-only" (`agents/room.md`). Talking in the row was deferred (PLAN-QUIET "Moved out"). quiet-070 keeps the same hold. |

The common root: each step was guarded and explained on its own, never tuned as one flow.

## Releases

### 0.6.0: ship quiet-070, plus three cuts (small)

quiet-070 already has: one room row, one-line open/join/leave, a one-line invite, receipts to the debug log, the skill ending its turn silently, the guard false positives (#35). Add before releasing:

1. **One line per event.** A room event drawn as a notice is not also sent as a prompt or repeated in the FYI pull (`deliver.ts`, `constants.ts:49` PULL_HEAD, `render.ts`). Claude still gets it as context, once.
2. **The join line:** `tristan2 joined (Tristans-MacBook-Pro-2)`. Check code, rename and kick hint move to `/sub-human who`.
3. **`post` returns `{id}`,** not the record.

Verify: re-run the two-seat live recipe; count drawn lines per event (target 1).

### 0.6.1: start with someone, join with one line

1. **`/sub-human` opens the room and asks who's coming.** When the reply says the room was just opened, the module (no model turn) asks with `$.ui.ask`:
   `Bring someone into orca-6418?` — `This machine` · `SSH` · `Tailscale` (Esc: not now).
   - Pre-check `tailscale status` and Remote Login; mark the likely one `(detected)` and drop one that can't work.
   - This machine: one line, `In another session here, type /sub-human`.
   - SSH / Tailscale: run the existing path (`--ssh` / `--web`) through the same tail the typed command uses; line and PIN pinned under the prompt as now. "Other" text shaped `user@host` is SSH to that address.
   - Wait for the join turn and any seat-taking to finish first (as `offerCopy` does).
   - Pure parts in `mod/core/walk.ts`, wiring test like `mod/test/leave.test.ts`; knob to turn it off for scripts.
2. **Copy without a model turn.** The module asks the copy question with `$.ui.ask` itself; delete `copyWake`/`copySaid`.
3. **One line shape for every transport:** `ssh://me@devbox/orca-6418#SECRET`, `ssh://host/orca-6418?forward=PORT#SECRET`, `https://node.ts.net/sub-human/orca-6418#SECRET`. The joiner always types `/sub-human join <line> PIN`. One parser picks the spec from the scheme. Old forms keep working, undocumented. Hosting emits the new shape.
4. **A failed join names the other way:** a ts.net timeout says to ask for SSH, an ssh refusal says to ask for Tailscale. One line each.
5. **Copied text for someone without sub-human** carries the install line above the join line (PIN stays separate).

Not done: a join dialog with the line pasted into it. Its answer is a tool result, so the secret would reach the transcript and the model. The line stays a typed command.

Protocol: unchanged (the URL is parsed into today's specs).

### 0.7.0: plan feedback with no extra gates

1. **The reviewer's note is the send.** "Tell Claude what to change" + note records the objection at once; one line, `Sent your changes to tristan.` Delete the note-waiting state, confirmCard, the note nudges and the post block while a card waits. Esc stays "decide later".
2. **The author's Claude drafts the next version on its own.** `changesLine` becomes: draft the next version from the note now; ask your person only what the note leaves open. `member.md`'s "only when asked" no longer covers revising after a requested change.
3. **One call stores a version.** `plan({op:'edit', text, summary})` stores it and returns the hash; drop the plan-file header and the enter/exit/deny round trips (`edit.ts`). The one gate left is the plan view: Yes sends it out.
4. **After a send Claude says nothing.** Model context after Yes is one sentence; the file and mode restore silently.

Owner decision (2026-11-20): a version that applies a reviewer's requested changes still opens in the author's plan view; nothing goes out in a person's name unread.

### 0.8.0: the room row is the group chat, and your Claude is your assistant

Main is your space: you and your Claude. The room row is everyone else: a group chat with the people in the room. (Owner direction, 2026-11-20.)

**You reach out to people, never to a Claude.** Each person's Claude reads what reaches them, like an executive assistant. It answers on their behalf when it's confident (a fact it knows: what they're on, whether tests pass, which branch), or leaves it for them (a decision, an opinion, anything it would be guessing at). Who answered is always shown: `tristan2: …` or `tristan2's Claude: …`.

- **Typing in the row** posts your exact words. Naming someone (`tristan2, …` or `@tristan2`) reaches them, and their Claude decides.
- **A question that names nobody** goes to everyone, and your own Claude tries to answer it in the row (`tristan's Claude: …`). It may ask the other Claudes natively to find out; if it can't, it says nothing and leaves it to the people. Anyone, person or Claude, is free to chime in. No other Claude is woken by it.
- **A line that isn't a question** is for the people; it wakes no Claude, and each Claude gets it only as context. Your Claude judges which is which.
- **What a Claude can answer** is left to its judgement, steered by its person in plain words ("handle questions for me", "send me everything"), never a setting. This fits the close/loose spectrum: an assistant answers less for a pair working closely and more for loose coworkers.
- **A message left for you** waits in the row with an unread count on its label. Main stays quiet unless your Claude judges it time-sensitive, and then gets one line.
- **Room lines leave main.** People's lines show in the row, not as notices in main. Your Claude still reads them as context.
- **`@room` in main stays** as a shortcut for a quick line without leaving main.
- **Claude-to-Claude coordination stays native and unseen** (SendMessage, PLAN-QUIET rule 1). A Claude shows in the row only when it answers something said there.
- **Provenance:** the plugin writes nothing of its own in the row. Every line is a person's words or a named Claude's reply, shown with its author. Claude Code records the drawn lines as the row agent's; the author prefix keeps the record honest.

Mechanism (`quiet/ROOM-ROW-SPIKE.md`, recommended):
- A background keeper child does the blocking `hold`; the room row ends its turn and stays idle, so typed text arrives (`session.append`, door `prompt`, origin `composer`).
- A `turn.step` hook answers each row step without the model: it posts the typed line and ends the step.
- The named person's seat gets the line as their assistant's to triage: a wake for their Claude, with one rule in `member.md` (answer as `NAME's Claude` when sure, otherwise leave it for NAME).
- Incoming lines drawn in the row with `$.session.send`; chrome hidden with `ui.render`.
- New contract entries for each early-access surface, with a fallback: until it checks out, the row's label says `talk in main with @room`.

Limit: terminal only (the desktop app, VS Code and Remote Control can't type into a row).

Open: a wake reaching a Claude mid-task. The interruption rule (Claude-to-Claude may wake) suggests the assistant answers at its next turn boundary, not by stopping work.

Until 0.8.0 ships, the row's label must not look like a chat box: lead with `type in main` (`mcp/hold.ts` HINT).

## Order and size

| Release | Size | Depends on |
|---|---|---|
| 0.6.0 | small | quiet-070 as is |
| 0.6.1 | medium | `$.ui.ask` passing consent (quiet-070's `ownCard`, generalised) |
| 0.7.0 | medium | 0.6.0; wire protocol may move for the dropped note state |
| 0.8.0 | large | early-access hooks |
