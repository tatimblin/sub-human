# PLAN-LEAVE-CARD: a card after `/sub-human leave`

Status: built as 0.5.4 (branch `leave-card`). It shipped differently from the plan below in three ways:
- **The card opens itself.** The module opens it with `$.ui.ask` (Claude Code's own dialog), so there's no wake and no model turn. mod/consent.ts is untouched.
- **Two options, no descriptions.** The options are Close / Star on GitHub, with labels only. The dialog's own free-text row ("Type something.") is the feedback, and the question says so.
- **A debugging snippet.** The feedback issue gets a `session` field when something failed this session. It holds the command verbs and failure lines, with names, room codes, SECRETs and PINs masked.

## What the person sees

```
/sub-human leave
  left 7KQ2 · /sub-human joins again          <- today's notice, unchanged

  ┌ Left room ──────────────────────────────────────────────┐
  │ You left room 7KQ2. Thanks for trying sub-human.        │
  │  1. Close          Nothing else.                        │
  │  2. Star on GitHub Stars tatimblin/sub-human.           │
  │  3. Write feedback Opens a feedback issue, filled in    │
  │                    from what you type here.             │
  │  4. Type something…  (your feedback, filed as an issue) │
  └─────────────────────────────────────────────────────────┘
```

- **Close**: nothing happens and the card goes away.
- **Star on GitHub**:
  - If `gh` is installed and logged in, it stars the repo directly. The notice is `★ starred tatimblin/sub-human`.
  - Otherwise it opens the repo page in a browser, and the notice says the Star button is at the top right.
  - Either way the notice includes the URL, so it can still be clicked when the session runs over ssh on a machine with no browser.
- **Write feedback**: opens GitHub's new-issue form using a new `feedback.yml` template, already filled in.
  - The filled-in fields are: what was typed on the card (if anything), the sub-human version, the Claude Code version, the OS, and the transport (local, ssh, web or forward).
  - The person reads it and presses Submit on GitHub, so nothing is posted until they do.
  - If no browser opens, the notice prints the URL.
- **Typed text in the free-text field**: the card's own free-text answer is treated as feedback. It goes through the same path as Write feedback, with the text filled in.

## Where it's shown, and where it isn't

- It's shown only after a `/sub-human leave` that went through, in an interactive session that a person is sitting at.
- It isn't shown in these cases:
  - **The room's Claude.** `leftName` already excludes the `claude` role.
  - **Non-interactive runs:** `-p`, the SDK, and Remote Control. This mirrors the copy card's `interactive !== false` check.
  - **A refused leave**, for example when the session had no seat.
  - **A quick rejoin.** The card fires about 300 ms after the command returns. If the session has a seat again by then (say `/sub-human leave` then `/sub-human join X` straight away), it's skipped.
  - **Kicked, room ended, or `/exit`.** These are out of scope. With `/exit` there's no session left to draw a card in. A kick or room ending isn't the person's choice, so a "thanks for trying" card would read wrong. They can be added later.
- **Once per session.** A second leave in the same session shows no card.
- **Off switch:** `SUB_HUMAN_LEAVE_CARD=0`, added to lib/env.ts's table.
- **After a star:** once the person has picked Star, later cards drop that option. This needs a persisted flag; see the open decisions.

## How it works (mirrors the invite's copy card, PLAN-JOIN step 5)

A hook can't open a dialog by itself. The only dialog Claude Code has is AskUserQuestion, so the module asks the model to call it. The PreToolUse hook then swaps in the real card, and PostToolUse acts on the answer. The copy card already works this way (mod/core/copy.ts, mod/consent.ts, mod/deliver.ts `offerCopy`). It costs one short model turn.

1. **`mod/deliver.ts` command.run.**
   - The `left` branch (`leftName(...)` around line 594) already knows a leave went through.
   - When the session is interactive and the card hasn't been shown this session, it notes the room code and schedules `offerLeave($, code)` with `$.clock.after(2 * CONFIRM_AFTER_MS)`. That puts it after the rename, the same way the copy card is ordered.
2. **`offerLeave`:**
   - Skip if the hello now shows a seat, which means the person rejoined.
   - Otherwise submit `leaveWake(code)` as a framed wake (`submitWake(..., {member: true})`, the same as `copyWake`). The wake reads: `(for Claude) sub-human: the person left room CODE. Call AskUserQuestion with the question "left room CODE" (the hooks show their card and act on it), then reply with nothing.`
3. **`mod/consent.ts` classic.PreToolUse AskUserQuestion:**
   - If `leaveAsked(input)` matches, answer `ask` with `leaveCard(code, {starred})` as `updatedInput`.
   - It never needs node or a seat, since the seat is gone by now.
   - Record the toolUseId so the PostToolUse below knows which card it is.
4. **`mod/consent.ts` classic.PostToolUse AskUserQuestion:**
   - Read the answer with `leaveOutcome(response, input)`, which uses `answerCard(LEAVE_SPEC, …)` with an exact match.
   - Act on the answer:
     - **Close, AFK, or an edited card:** say nothing.
     - **Star:** run `gh` (step 5), and if that fails, open the page.
     - **Feedback, or typed text:** open the issue URL.
   - Log the outcome as a notice. The tool result reads `leaveSaid(...)`, which asks the model for nothing.
5. **Running programs.** Two new scripts, each modelled on `scripts/clip.sh`. The argv is spelled out at the `$.process.run` call site so the plugin directory can see which program runs.
   - `scripts/open.sh NAME`: reads a URL on stdin and passes it to one opener: `open` (macOS), `wslview` or `cmd.exe /c start` (WSL), or `xdg-open` (when there's a DISPLAY or WAYLAND_DISPLAY). It returns 127 when the opener is missing, so the next one is tried. `openCommands(env)` gives the order, like `clipboardCommands`.
   - `scripts/star.sh`: `command -v gh || exit 127; exec gh api -X PUT /user/starred/tatimblin/sub-human --silent`. It has a 5 s timeout. Any failure falls back to open.sh with the repo URL.
   - With no opener at all, the notice is just the URL. That's the normal case on a headless ssh box, which is the real demo setup (`ssh dev`).

## New and changed files

| File | Change |
|---|---|
| `mod/core/leave.ts` (new, pure) | `LEAVE_QUESTION(code)`, `CLOSE`, `STAR`, `FEEDBACK`, `leaveCard(code, {starred})`, `LEAVE_SPEC`, `leaveAsked(input) -> {code}\|null`, `leaveWake(code)`, `leaveOutcome(response, input) -> {kind:'close'}\|{kind:'star'}\|{kind:'feedback', text}`, `REPO`, `starUrl()`, `issueUrl({text, versions, os, transport})` (url-encoded, body capped at 6000 characters to stay under GitHub's ~8 KB URL limit), `openCommands(env)`, `leaveSaid(said)`, and the notice strings |
| `mod/deliver.ts` | schedule and run `offerLeave` from the `left` branch; per-session `leaveShown`; the off switch |
| `mod/consent.ts` | the Pre and Post branches for the leave card, beside the copy card's (no node) |
| `mod/register.ts` | update the HOOKS descriptions for command.run, classic.PreToolUse and classic.PostToolUse (ARCHITECTURE is generated from these with `npm run docs`) |
| `scripts/open.sh`, `scripts/star.sh` (new) | the two runners above |
| `lib/env.ts` | `SUB_HUMAN_LEAVE_CARD` |
| `.github/ISSUE_TEMPLATE/feedback.yml` (new) | `labels: [feedback]`, field ids `feedback`, `versions`, `where` (the same dropdown as bug.yml). The URL uses `?template=feedback.yml&feedback=…&versions=…`. A template applies its label even for people who can't triage, which a `labels=` URL parameter doesn't. |
| README | one line under leaving a room, plus the off switch |
| CHANGELOG, plugin.json | the next version |

Nothing in lib/ or the room store changes. The leave itself is untouched (`lib/commands/leave.ts`, `seats.exit`).

## Privacy and safety

- **What the URL can contain.** The issue URL and its prefilled body contain only the person's own text, version strings, the OS, and the transport kind.
  - It never includes room codes, names, members, messages, invite lines, PINs or host addresses.
  - A test asserts this against a fake hello that's full of all of those.
- **Posting is the person's choice.** Nothing is posted without their click on GitHub. Starring is the one thing done on their behalf, and only after they pick "Star" themselves.
- **Process lists.** The URL reaches `open` and `xdg-open` as an argv, so it's visible in `ps` while they run, for less than a second. That's acceptable because it holds only what the person typed for a public issue. It goes to open.sh on stdin, so the module's own call never carries it.
- **Private beta.** The repo is private until launch. Testers installed from it, so they have read access, and read access is enough to file issues. After launch, nothing changes.

## Tests

- **`test/mod-core-leave.node-test.ts`.**
  - The card's shape.
  - `leaveAsked`: matches, non-matches, and the card's own question.
  - `leaveOutcome`: each label, typed text, AFK, and an edited card counting as none.
  - `issueUrl`: encoding, the length cap, and no room data.
  - `openCommands` ordering per environment.
- **`mod/test/leave.test.ts`**, using the mod test kit and modelled on `copy.test.ts`:
  - A leave makes one wake. The Pre hook asks with the card, and the Post hook runs star.sh, then open.sh as the fallback.
  - No card in these cases: a refused leave, a non-interactive session, a rejoin before the card fires, the second leave in a session, the room's Claude, and the off switch.
  - A missing opener produces a notice containing the URL.
- **`test/mod-core.node-test.ts`.** The HOOKS table still matches validate.
- **Live check.** Real `claude --plugin-dir` in tmux with an isolated SUB_HUMAN_HOME (the recipe in memory). Run join, then leave, and pick each option. Repeat on the dev box over ssh, where there's no browser, so the URL notice is what shows.

## Steps

1. `mod/core/leave.ts` and its unit tests.
2. `scripts/open.sh` and `scripts/star.sh`, and the feedback.yml template.
3. The consent.ts Pre and Post branches, then the deliver.ts offer, then the mod tests.
4. The off switch, the README, the HOOKS text, `npm run docs`, the CHANGELOG and the version.
5. `npm test`, then the live check.

## Open decisions (my recommendation first)

1. **How feedback is filed.**
   - *Recommended:* open the prefilled browser form, so it's posted on GitHub with the person's own click. It needs no gh and no auth, and nothing is posted silently.
   - *Alternative:* when gh is logged in, file it straight away with `gh issue create --body-file -` and print the issue URL. This is closer to "sends as an issue", but it's an unreviewed public post, and it fails for testers whose gh is logged in to an enterprise host.
2. **Remembering a star across sessions.** The mod can't write room state, so "starred" would need a small node handler that writes `<home>/prefs.json`.
   - *Recommended:* skip it for now. Starring again is harmless (the API call is a PUT, so repeating it changes nothing), and the card shows only once per session anyway.
3. **How often to show the card.**
   - *Recommended:* once per session, with the env off switch.
   - *Alternative:* a fourth "Don't show again" option, which would need the prefs file from decision 2.
4. **Kicked or room ended.** *Recommended:* no card for these in v1.
