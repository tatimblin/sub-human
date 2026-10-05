# B: model behaviour (#2 misquotes, #5 PushNotification, #11 prescriptive drafts)

Run `vole-8126`. The member Claudes were **Haiku 4.5** (pane banner), so they confabulate more readily than Opus would. Labels: **[probe]** verified-by-probe, **[src]** verified-by-source (plugin code or binary 2.1.281), **[log]** seen in a transcript, log or pane, **[inf]** inferred. I ran no probes.

## #2 Claudes misquote room entries

**Root cause: a clipped notice, a digest holding a similar human quote, and role text that asks for a "gist".**
- After `/clear` (18:59:55), alice's Claude had only the restore block (`63ba0360…jsonl` line 6) and one monitor line [log]. The line was `#22 orch[agent] say to=alice refs=#18,#21 "I reviewed this … That can repeat tasks, and the plan sugges…"`.
  - `room.tailLine()` caps every notice at `TAIL_MAX`=240 characters [src `lib/room.js:310`]. The cut fell on the one clause that mattered: "the plan suggested a 400 instead".
  - Nothing in the line says it was cut except `…`.
- The restore DIGEST listed bob's #11 under "last 10 human entries": `"cap the page at 50 and say what happens past it — limit=500 must clamp, not 400"` [log].
  - Haiku filled the gap from #11 and wrote "the plan said to clamp and state what happens past the limit" [log, S11-2].
  - That sentence is #11's wording applied to the wrong field. Its draft reply, "clamp at 50 and error if past it", contradicts plan line 15.
- The role text asks for a summary and discourages reading the entry [src `skills/sub-human/member.md`]: "Tell NAME each in one line (who, kind, **gist**, #id). Fetch full text … **only when needed**."
  - Members made **0** `read` calls in 4 sessions, across 37 notices, 6 of them clipped [log].
- "Never paraphrase … human text" exists only in `precompact-note.js`, which runs after compaction. It isn't in the join or restore role text [src].

**Fix (a), current plugin (about 25 lines, low risk):**
1. `lib/room.js tailLine(e, {full})`: for notices that call for action (`to=me`, `via=human`, or `plan_rev` naming me), print the whole text as one JSON-escaped line, up to about 2,000 characters. If it is still cut, end the line with a marker that names the call, e.g. ` [cut at 2000/2400 chars: read #22]`, instead of a bare `…`.
   - `bin/sub-human tail` passes `full` for those notices.
   - The Monitor pipe allows 1 MiB per event (`D=1048576`) [src], so 240 is our own cap.
2. Apply the same rule in `digestSections()`: give human entries their full text, or the explicit cut marker.
3. In `member.md`, replace the "Notices …" bullet with mechanics only:
   > "Notice lines carry the entry's exact text in quotes, or say where it was cut. To repeat an entry, quote it and cite #id."

   Delete "gist" and "only when needed".

**Fix (b), slim design:**
- Orchestrator-to-member directives travel as SendMessage. The full body arrives in `<cross-session-message>`, unclipped [probe in native2/01].
- Human words ride the UserPromptSubmit `additionalContext` backlog. That backlog must follow the same rule: exact text plus `#id`, or an explicit "cut, `read` #N".
- The ≈500-character role text already drops narration [native2/05 §2]. Add only the 12-word "quote, cite #id" line.

**Verify:**
- Unit test: `tailLine` of the logged #22 with `full` contains "400 instead".
- Probe: put a Haiku session in `/tmp/fx-b`, give it this restore block, and feed it the old #22 line and then the new one. The old line should reproduce the misquote. With the new line, its reply should quote "400".

## #5 Unprompted PushNotification, then "Invalid tool parameters"

**Root cause: Claude Code itself asks for the push.**
- Every Monitor event body ends with "If this event is something the user would act on now, send a PushNotification. Routine or benign output doesn't need one." [log: all member transcripts].
- That text is added by `N()` in the Monitor module, only when `wpe()` is true [src]:
  - `wpe()` is `tengu_kairos_push_notifications && agentPushNotifEnabled`;
  - this user has `"agentPushNotifEnabled": true` in user settings, and the gate is on in `~/.claude.json` [log].
  - The string occurs once in the binary, so SendMessage wakes don't carry the hint [inf from src].
- On notice #2 ("What do you want the room to plan?"), Haiku called PushNotification without loading its deferred schema (`9eab63ac…` lines 48–55) [log]:
  - it sent `{title,message}`, which failed with InputValidationError. That is the "Invalid tool parameters" line on screen;
  - the retry was refused: "Not sent — this terminal is active".
- This happened once, in 1 of 13 alice sessions. The plugin did nothing to cause it, except waking the model on every entry, which is issue #6.

**Can the plugin turn it off?**
- **Not through settings.** A plugin's `settings.json` honours only `["agent","subagentStatusLine"]` (`Wpe`) [src]. `agentPushNotifEnabled` and `permissions.deny` are read only from the user, project, local, flag and policy sources (`yo()`/`us()`) [src].
- **A PreToolUse `PushNotification` deny hook is possible but not worth it:**
  - it would add a red hook-error line;
  - schema validation probably fails before hooks run, so the "Invalid tool parameters" line would remain [inf].
- **Don't add a role-text rule against it either.** While NAME is away, a push for something addressed to NAME is the feature working.

**Fix (a), current plugin (about 0–20 lines):**
1. Narrow `visibleTo()` in `bin/sub-human` to the push lane (issue #6 / native2/06). The native hint then appears only on events that are about NAME, where a push is apt.
2. Add one README line: anyone who never wants pushes sets `agentPushNotifEnabled: false`, or launches with `--settings '{"agentPushNotifEnabled":false}'`.

**Fix (b), slim design:**
- Gone in most cases. Most wakes come from SendMessage, which carries no hint [inf].
- The narrowed monitor carries the hint only for `to=me`.
- No plugin mechanism is needed, and none exists.

**Verify:**
- After a full run, count `"name":"PushNotification"` in the member transcripts. Expect it only beside `to=NAME` events.
- Grep the panes for `Invalid tool parameters` (a Claude Code quirk with deferred tools, not ours).

## #11 Member Claudes offer prescriptive drafts

**Root cause: the role text tells them to.**
- `member.md` Event→action: "`question`/`say` with `to=NAME` → Tell NAME; **offer a draft reply** for NAME to send with `@room`." The Rules add: "For 'tell the room X', **suggest `@room X`**." [src]
- Haiku complied on every addressed notice: #5 (bob), and #22, #25 and #28 (alice) [log, S11–S12].
- **Harms:**
  - Drafts carry the misquote from #2.
  - Claude Code's prompt suggestion then offers the draft's wording as dim ghost text. In S11-3, `❯ fix the cursor handling` is rendered at `opacity="0.6"` in the SVG [log]. If a suggestion is an `@room …` line, Tab then Enter posts Claude's words as `via=human`; the README warns about exactly this.

**Fix (a), current plugin (about 5 lines of role text; optional 15 in `at-room.js`):**
1. Delete "offer a draft reply…" and "suggest `@room X`". Keep the mechanic: "`@room` lines are NAME's own words; you can't post as NAME."
2. Optional mechanic, not a rule: `hooks/at-room.js` reads the last assistant message in `transcript_path`. If the `@room` text appears in it verbatim, it posts the entry with `drafted:"agent"`, and `fmt`/the digest show "(alice, Claude's wording)". This keeps attribution honest without blocking the human.

**Fix (b), slim design:**
- The draft prompts are gone by design: the ≈500-character role text has no Event→action table [native2/05 §2].
- Prompt suggestions are native and stay, so the `drafted:"agent"` marker in `at-room.js` is still worth keeping.

**Verify:**
- Re-run S11–S12. Expect no `@room` text in member assistant messages unless the human asked for a draft.
- Accept a ghost `@room` suggestion. The log entry should carry `drafted:"agent"`.
