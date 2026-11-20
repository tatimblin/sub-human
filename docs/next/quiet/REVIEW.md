# 2. Consent: how a person reviews someone else's plan in Claude Code 2.1.296

Question: what is the most native and minimal way for a person to read someone else's room plan and then agree or ask for changes, without hijacking plan mode?

## Recommendation

**Retire plan mode for reviewing other people's plans.** Show the review in a pane that the hooks module draws, and invite the person to it from a one-line band above the prompt:

1. When a review request arrives, the tail event raises a **band above the prompt**: `maya asks you to review plan paging v1   1: Review`. It takes no model turn and no dialog. It never interrupts: it waits until the person wants it.
2. **`1`** (a bare digit in an empty composer presses a band Button) or a click opens a **review pane**. The pane draws the plan with `Markdown`: tables, code and headings are rendered, PgUp/PgDn scroll it, and a sticky action row reads `1: Agree   2: Ask for changes   Esc: later`.
3. **`1` agrees.** One keystroke, recorded by node as `via=human`. **`2`** turns the row into an `Input` labelled `What should change?`. Enter sends the note. There is no card, no "Exit plan mode?" and no second dialog.
4. The answer lands as one dim line, `You asked for changes to paging v1: "…"` or `You agreed to paging v1`. The person's Claude gets the same line as held *context* for its next turn, not as a wake.

What changes:
- The person never enters plan mode, so their **permission mode is never touched**. That fixes #34 at the source.
- None of these strings appear any more: "Ready to code? … ready to execute", "Entered plan mode", "User rejected Claude's plan: proposal a1b2…", "Exit plan mode?", and the `~/.claude/plans/<slug>.md` footer.
- Declining is at most two keystrokes plus the note, instead of three dialogs.

**Fallbacks:**
- **When the pane can't be drawn** (mobile has no `Input`; modules off): `$.ui.ask("maya asks you to review plan paging v1. Agree?", ["Agree", "Ask for changes"])`. Its "Type something." row is the free-text objection. On mobile, use the pane's Markdown and Buttons, with "Ask for changes" falling back to that `$.ui.ask`.
- **With no hooks module at all**: the existing MCP elicitation `signoff` op (`mcp/room-server.ts:266-320`). Keep it only as the last resort.

## What was verified live

Setup:
- A throwaway `claude` 2.1.296 ran in tmux with `CLAUDE_CONFIG_DIR=/tmp/probe-consent/config`.
- A probe plugin (`/tmp/probe-consent/probe`: a hooks module plus a stdio MCP server) was loaded with `--plugin-dir`.
- A scripted local Messages API (`/tmp/probe-consent/mock-api.mjs`, via `ANTHROPIC_BASE_URL`) stood in for the model, so model turns, tool calls and a 45-second "slow" mid-turn stream needed no account and cost nothing.
- Raw screens are in `/tmp/probe-consent/caps/{a,b}.screens.md`, the module log in `caps/mod.log`, and the elicitation log in `caps/elicit.log`.
- Nothing under `~/repos/sub-human`, `~/.claude` or any room home was touched.

The session started in **auto mode**, which is Claude Code's default now. Findings:

| # | Probe | Result |
|---|---|---|
| 1 | Pane (`$.ui.open` + `ui.render Pane`: `Markdown`, Buttons with hotkeys, `Input`) opened from a slash command, 150 cols | Docked sidebar. Markdown tables are rendered, PgDn scrolls. `2` → Input → typed note → Enter → `$.ui.log` line. Mode stayed `auto mode on`. No model turn. |
| 2 | Same pane opened from a `session.start` timer, the way sub-human's tail delivers events. Idle, then **mid-turn** during a 45 s stream | Placed and focused (composer empty). `1` agreed while idle. `2` + note worked mid-turn: the turn kept streaming, and mode stayed auto. |
| 3 | Same, **unasked, at 100 cols** | `{"isPlaced":false,"reason":"unasked below 144 columns (100 now): placed when the person opens it…"}`. Also not placed when opened right after a `$.ui.ask` answer ("Read it"). |
| 4 | **Band** (`ui.render AbovePrompt`, Text + `Button hotkey="1" plain`) at 100 cols, idle and mid-turn | Drawn as `maya asks you to review plan paging v1 1: Review   [-]`. Pressing `1` in the empty composer opened the pane, **placed** inline at 100 cols (a press counts as "asked"). Same mid-turn. |
| 5 | `$.ui.ask` (Agree / Ask for changes) | Native AskUserQuestion dialog: `☐ Review`, the options, `3. Type something.`, `4. Chat about this`. Free text came back as the answer string. No model turn, mode kept. |
| 6 | AskUserQuestion with option `preview` = the plan (model-issued) | Side-by-side: options on the left, the plan rendered in a box on the right. **Cut at the terminal height (`✂ 31 lines hidden`) and not scrollable** (PgDn did nothing). The `Type something.` row is replaced by `n to add notes`; notes come back in `annotations`. |
| 7 | `$.ui.ask` with a `tool.call` hook adding `preview` | Works **only when the ask runs from a hook's own context** (a slash command): preview drawn and notes captured in the result's `annotations`. From a timer (the tail's context) the plugin's own `tool.call` and `classic.PreToolUse` hooks never ran, so no preview. A `ui.render AskUserQuestion` rewrite of `questions` was ignored in both cases (even a changed question text). `$.tool.call({tool:'AskUserQuestion'})` is refused: "that is $.ui.ask (host check)". |
| 8 | `$.ui.notice` under the AskUserQuestion dialog | Drawn: one right-aligned line `probe: NOTICE: …` under the dialog. |
| 9 | `$.ui.notice`, and a `classic.PreToolUse` `{ask: reason}`, on the **plan dialog** (ExitPlanMode with a plan file) | **Neither drawn**, even with the notice sent 400 ms after the dialog opened. Confirms EVALUATION: the reason line is never drawn on 2.1.296. Candidate (a)'s `$.ui.notice` fix does not work. |
| 10 | Plan-mode objection path from auto mode | `Ready to code? / Here is Claude's plan: / … ready to execute`, footer `…/plans/hazy-tinkering-creek.md`. "Tell Claude what to change" leaves the session **in plan mode**. The next ExitPlanMode with nothing to show offers only `1. Yes, and switch to default (ask each time)` / `2. No`, which leaves `⏸ manual mode on`: auto → default (#34). |
| 11 | MCP elicitation (`elicitation/create`, form) from the server **with no request open** | Claude Code 2.1.296 advertises `elicitation: {form, url}`. The dialog opened unprompted, also mid-turn. `MCP server "plugin:probe:elicit" requests your input`, then the message as **raw text** (`# Plan: …`), cut at `… (+48 more lines)`. Agreeing took 4 keys (→, Space, ↓↓, Enter). Mode kept, no model turn. |
| 12 | Hook `ask` on a model tool call carrying the plan (`show_plan {plan}`) | Needs a model turn. The plan is shown as a raw parameter. The frame reads `Hook PreToolUse:… requires confirmation for this tool:` + `settings.json to update hooks`, and option 2 is `Yes, and don't ask again for plugin:… commands in <cwd>`, a standing allow the person could grant by accident. |

Two engine facts this rests on, both observed on 2.1.296 and worth `lib/cc/contract.json` entries:
- **E1:** an unasked `$.ui.open` is placed only at ≥144 columns. A band Button press, or the person's own command, counts as asked.
- **E2:** `$` calls made from a timer or process callback skip the calling plugin's own hooks. A `$.command.run` from such a callback reported "no command.run hook answered it", even though `command.run` was hooked. So nothing in the review may depend on the plugin rewriting its own `$.ui.ask`.

## Candidates compared

Legend: ✓ good, ~ partial, ✗ bad.

| | (a) Plan mode, reframed | (b) `$.ui.ask` card (± preview) | (c) MCP elicitation | (d) Hook `ask` on a tool call | **(e) Band → review pane** |
|---|---|---|---|---|---|
| **How it looks** | ✗ "Ready to code? … ready to execute". Only a heading inside the plan text can reframe it; the notice and reason line are not drawn (probe 9). False "Entered plan mode", hex "User rejected" stub, plan-file footer. | ✓ Native question dialog, a `☐ Review` chip, and a `$.ui.notice` line works under it (probe 8). ~ It also offers `Chat about this`. | ✗ "MCP server "plugin:sub-human:room" requests your input"; plan as raw markdown. | ✗ "Hook PreToolUse… requires confirmation", "settings.json to update hooks", "don't ask again". | ✓ Plan rendered like an assistant reply; one sticky row of actions; a band line in the room's own voice. Nothing says "plan mode", "hook" or "MCP". |
| **Reading a long markdown plan** | ✓ Full, scrollable, rendered (the plan view's strength). | ✗ Plain card: none. With preview: rendered but cut at screen height, no scroll, and only from a hook context (probe 7). | ✗ First lines, then `(+N more lines)`, raw. | ✗ Raw string parameter. | ✓ Full, rendered (tables boxed), PgUp/PgDn. 100k-character cap per drawing. |
| **One-keystroke agree** | ~ Enter, but on "Yes, and use auto mode" (wording about coding). | ✓ Enter on `1. Agree`. | ✗ 4 keys. | ~ Enter on "Yes". | ✓ `1` (or Enter on the focused Agree). |
| **Free-text objection** | ~ "Tell Claude what to change", then a card, then "Exit plan mode?". | ✓ `Type something.` (plain) / `n` notes (preview). | ✓ A string field. | ~ "Tab to amend". | ✓ `2` → `What should change?` field → Enter. |
| **Permission mode survives** | ✗ The objection path drops auto → default (probe 10, #34). Fixable only with a CC change or a model-driven restore. | ✓ | ✓ | ✓ (but the "don't ask again" grant is a hazard) | ✓ Plan mode never entered. |
| **No model turn** | ✗ The model must call EnterPlanMode / ExitPlanMode (several turns). | ✓ `$.ui.ask` from the module. | ✓ Unprompted elicitation works (probe 11). | ✗ | ✓ |
| **Works mid-turn** | ✗ Waits for a turn to end, then a wake. | ✓ Opens over a streaming turn. | ✓ | ✗ | ✓ Band and pane mid-turn; the turn keeps running. |
| **Implementation risk** | Low per fix, but it keeps ~750 lines of `review.ts` plan-mode state machine and cannot fix the framing or the mode. | Low. Stable, documented API; the existing card code is close. | Low (the code exists), but it fails on look and read. | n/a: rejected. | **Medium**: `Pane` / `AbovePrompt` / `Input` are EARLY ACCESS API (contract entries plus a canary), E1 needs the band, and mobile has no `Input`. It *deletes* most of the plan-mode review machinery. |

(e) also covers how Claude Code itself asks for review. Its own reviews are either a dialog the model's tool opens (plan approval, AskUserQuestion) or an engine surface the person opens (diff panel, agent view). Nothing native interrupts a person mid-thought with a document. The band invites them and the pane is where they read, which is how the engine's own panels behave.

## Mock of the exact screens

These mocks are drawn from the captured probe screens (`/tmp/probe-consent/caps`), with sub-human's words in place of the probe's. `sub-human:` is the native prefix the engine puts on a plugin's log line.

### dev, idle or mid-turn: the request arrives (any width)

```
✻ Brewed for 12s · done 2:52 PM
maya asks you to review plan paging v1   1: Review                                          [-]
──────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
──────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
```
That is all: no transcript row, no model turn. If dev is mid-sentence in the composer, the `1` goes into the text and the band waits. The band stays until the review is answered, a newer version replaces it, or the request is decided.

### dev presses `1`: the review pane (100 cols: inline above the prompt; 144+ cols: docked on the right)

```
╭ Review · paging v1 from maya ─────────────────────────────────────────────────────────────────✕─╮
│ 1: Agree   2: Ask for changes   Esc: later                                    PgUp/PgDn to read │
│                                                                                                  │
│ Plan: paging for GET /tasks                                                                      │
│                                                                                                  │
│ Context                                                                                          │
│ GET /tasks returns every task at once. The seed makes three tasks per minute, so lists grow fast │
│ and several tasks share a createdAt. We want stable pages that never skip or repeat a task.      │
│                                                                                                  │
│ Ordering and the cursor                                                                          │
│ 1. Order by createdAt ascending, then by id ascending, so ties break the same way every time.   │
│ 2. The cursor encodes both fields of the last task on the page: base64url(…[createdAt, id]).    │
│ …                                                                                                │
│ ┌──────────────────────────────┬───────┬───────────────────────────────────────────┐             │
│ │             Part             │ Owner │                   Files                   │             │
│ ├──────────────────────────────┼───────┼───────────────────────────────────────────┤             │
│ │ listTasks({ limit, cursor }) │ maya  │ src/store.js, test/store-paging.test.js   │             │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
──────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
──────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← for agents
```
The action row is drawn *above* the plan, so the hotkeys are always in view. In the probe the buttons sat at the end and scrolled out of view, and `1` still pressed them, which is a footgun. The `Review · …` title shows as the pane's tab when another pane is open. When it is the only pane, the action row carries the name instead: `paging v1 from maya · 1: Agree · 2: Ask for changes`.

### `2`: ask for changes (same pane, the row becomes a field)

```
│ What should change?: the cursor must encode createdAt and id, or ties break across pages  ⏎ send │
```

### After Enter (the pane closes, the band goes, one line)

```
⏺ sub-human: You asked maya for changes to paging v1: "the cursor must encode createdAt and id, or ties break across pages"
──────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
──────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
```
After `1` it reads `⏺ sub-human: You agreed to paging v1`. The mode line never changes.

### maya, her own new version: the author's check, same pane

```
maya, your plan paging v2 is ready to send to dev   1: Review                                     [-]
╭ Your plan paging v2 · not sent yet ─────────────────────────────────────────────────────────────✕╮
│ 1: Send to dev   2: Keep editing   Esc: later                                                    │
│ …plan…                                                                                           │
```
`2: Keep editing` opens the field `What should Claude change?`. That text goes to her own Claude as context for the next version (today's `SAY.revise`).

### Fallback where no pane can be drawn (`$.ui.ask`, verified as probe 5)

```
──────────────────────────────────────────────────────────────────────────────────────────────────
 ☐ Review
maya asks you to review plan paging v1. Agree?
❯ 1. Agree
  2. Ask for changes
  3. Type something.
──────────────────────────────────────────────────────────────────────────────────────────────────
  4. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel
                                         sub-human: the plan is above; Agree records only your answer
```
For this fallback the plan is printed just before the dialog as one `CommandOutput` Markdown row. That needs the `/sub-human review` command context. A tail-raised `$.ui.ask` can't add a preview (E2).

## Migration path from today's code

All paths are under `~/repos/sub-human/plugin/sub-human/`. Each step ships on its own.

**Step 0: contract and gate.**
- Add contract entries for: `$.ui.open` placement (E1); `AbovePrompt` band Button hotkeys in an empty composer; `Pane` `Markdown` / `Input`; and E2.
- Add a new `GATED` feature `review-pane` (`mod/core/cc.ts:21`). Its fallback is today's plan-view review, kept for one release so the canary can catch a failing build.

**Step 1: a review event from the tail, instead of a wake.**
- `lib/room/deliver.ts:73-76`: a `proposal` naming me and unanswered currently lanes `push`, which becomes a wake. Give it its own outcome, `review`, carrying `{hash, from, plan, version, draft}` and the plan text (node reads it with `proposal.read`, as `mcp/room-server.ts:285` does).
- `lib/room/render.ts:250-261`: drop the "asks you to sign off on" wake line. The band text replaces it.
- `mod/deliver.ts` (the tail's event switch, beside `submitWake` at `:283-298`): on `review`, set the band state and the held plan in `$.state` and `$.ui.invalidate`. No `$.prompt.submit`. Add one dim debug line (`$.ui.log(…, {to:"debug"})`).

**Step 2: the band and the pane (new `mod/review.ts`, registered in `mod/register.ts`).**
- `ui.render AbovePrompt`: the band for the oldest open request: one Text plus `Button key="review" hotkey="1" plain`.
- `onPress` → `$.ui.open({ id: 'review', focus: true, closeOnEscape: true })`.
- `ui.render Pane requestId 'review'`: the action row, then `<Markdown text={plan}/>`. Stage `read` → `changes` (`Input`, `autoFocus`) → closed.
- Keep the spirit of the `quickYes` guard (`lib/consent/review.ts:365`, `YES_GUARD_MS`): ignore an Agree press within the guard window after the pane takes focus.
- Close the pane and band on a decision or a replacing version.

**Step 3: record the answer in node, as the person's.**
- The pane's `onPress` / `onSubmit` runs `runConsent` (`mod/consent.ts:59`) with a new event, `ReviewAnswer {hash, choice: 'Agree'|'Object', notes?}`. Pattern it on today's `rejectedPayload` path (`mod/consent.ts:125-140`).
- In `hooks/consent.ts`, route it in `route()` (`:679-704`) to a handler that calls the existing `record()` (`:96-112`), which already does `proposal.answer`, `sendOut` for a draft, and `decide`. Run it under the seat key's signing, as `mcp/room-server.ts:303` does with `seatKey().signing`.
- Return the outcome line as `systemMessage` (the person's dim line) and a held pull for the model, reusing `SAY.recorded`, `SAY.noteFollow` and `SAY.sent` (`lib/consent/review.ts:179-191`).
- A draft's "Keep editing" returns `SAY.revise` as context. Record nothing.
- Trust is unchanged: only a person's press reaches `onPress`, and the model's Bash can't run `hooks/run.ts` (the guard, `mod/core/guard.ts`).

**Step 4: the fallback.** Where `$.ui.open` returns `isPlaced:false` after a press (it shouldn't, per E1), or the surface has no `Input`, call `$.ui.ask` with `["Agree","Ask for changes"]`. The `Type something.` answer is the note, and anything else is the label. Any of those answers goes through Step 3's event.

**Step 5: delete the plan-mode review once `review-pane` holds on the canary.**
- `lib/consent/review.ts`:
  - `NEXT.open/show/exit/restore` `:132-147`
  - `KEEP` / `agreeHint` `:153-159`
  - `SAY.leaving … roomToolDenied` `:199-244`, including the never-drawn `dialog` / `dialogDraft` `:211-218`
  - `restore` / `showEarly` / `answerNeeded` / `resolve` `:291-338`
  - `exitStep` / `steer` / `closeInPlan` / `leaving` / `closedHere` `:368-489`
  - the reducer cases `enter` / `entered` / `planFailed` / `exit` / `exited` / `stop` / `roomTool` / `rejected` / `prompt` `:499-656`
  - The note and card stages (`:277-288`, `:658-747`) also go, since the pane's field *is* the send.
- `hooks/consent.ts`:
  - `enterReview` `:386`, `waitingOf` `:406`, `preExit` `:425`, `postExit` `:458`, `postEnter` `:474`, `showCheck` `:485`, `rejectedExit` `:498`
  - the plan-file helpers `planOf` / `blankPlan` / `polled` `:130-150`, `:211`
  - `signoffElsewhere` `:663` (sign-off is no longer a plan-mode feature)
- `mod/consent.ts`: the `tool.call` ExitPlanMode refusal relay `:125-140`, the review half of `classic.PreToolUse` `:142-171`, and the `PromptHint` observer `:212-215`.
- `hooks/hooks.json`: the PreToolUse `EnterPlanMode` mode note (`hooks/mode-note.sh`).
- `lib/proposal.ts:238` (`openCall = NEXT.open`) becomes "the band shows it". `mcp/room-server.ts:16,195-200,252,338` stop telling the model to open plan views.
- Keep `mcp/room-server.ts:266-320` (`signoff` by elicitation) only for `-p` and SDK hosts with no module, or drop it.

**Step 6: the author's own check (`lib/consent/edit.ts:14-32,100-119`, `hooks/consent.ts:542-547`).**
- The edit itself stays in plan mode. That part is the person's own plan, so it is native and right.
- Its *check* moves to the same pane. `SHOW_CHECK` (`edit.ts:101`, "call ExitPlanMode({}) once more…") becomes: the store's receipt raises the band for the author.
- Delete the closing-call `ask` that today shows "Exit plan mode?" after an edit (`edit.ts:17`).
- This also removes EVALUATION G-item #2 (the red "Error: saved as room plan…"): the receipt becomes a band, not a deny.

Net size: a new ~200-line `mod/review.ts` plus one node event against roughly 600-700 deleted lines. Issues closed: #34 (mode), #21 (framing: no plan dialog to frame), the hex stub, the false banner, the foreign plan-file footer, and the three-dialog decline.

## Risks and open points

- **EARLY ACCESS API.** `Pane`, `AbovePrompt`, `Input` and band hotkeys may change between releases. Mitigations: the contract entries, the nightly canary, and the `review-pane` gate that falls back to the plan view. The plugin directory rule "the person keeps every permission decision" is untouched: no permission answer is involved at all.
- **E1** (unasked panes need 144+ columns) is why the band exists. Don't open the pane unasked even on wide terminals: it would steal focus mid-thought. The band is the Apple-like "badge, not modal".
- **A digit in an empty composer presses the band.** Someone about to type a prompt starting with "1" opens the review instead. That is harmless (Esc closes it), but say so in `help`.
- **Mobile** (Remote Control) draws no `Input`, so "Ask for changes" there uses the `$.ui.ask` fallback. Desktop and VS Code have `Input`.
- **No model wake on an objection** means the reviewer's own Claude learns of the note only at its next turn (held context). That is the owner's "behind the scenes" preference, and EVALUATION §5 already proposes context-only wakes. The author's side is unchanged: the objection still wakes maya's Claude (`lib/room/deliver.ts:67-71`).
- **Not verified live:** the desktop and VS Code rendering of the pane; `claude plugin test` mounts of the pane (write them as `mod/test/review.test.ts` over `['terminal','desktop']`); a real two-seat run.
