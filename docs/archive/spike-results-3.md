# Spike 3: plugin-surface probes P1–P5

Run on 2026-10-04 from 11:51 to 12:04 local time (18:51–19:04 UTC), with Claude Code 2.1.281, before the plugin build.

**Setup.**
- A throwaway plugin named `sub-human` at `/tmp/sh-probe/plugin/`. It has:
  - one catch-all hook script, `hooks/hook.js`, which logs stdin and env to `/tmp/sh-probe/out/hooks.jsonl` and switches behaviour from files in `/tmp/sh-probe/ctl/`;
  - three monitors that log their env and ppid chain, then echo `.trigger-<name>` files from the cwd;
  - a stdio MCP server named `room` with a `post` tool;
  - `skills/sub-human/SKILL.md`, with `arguments: [name, code]`, `argument-hint` and `disable-model-invocation: true`.
- Each session ran as `claude --plugin-dir /tmp/sh-probe/plugin --model haiku` in detached tmux, from `/tmp/sh-probe/work/{p1,p3,p3b}`.
- The launcher (`/tmp/sh-probe/start.sh`) strips the `CLAUDE*` variables inherited from the calling session. Without that, the probe sessions inherit `CLAUDE_PID`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION` and others from the parent. The first, discarded run `s1` showed this.
- For p3b, `EDITOR` and `VISUAL` pointed at `/tmp/sh-probe/edit.sh`, a script that appends `- EDITED BY BOB…`. p3b also passed `--settings /tmp/sh-probe/settings-clear.json` (`{"showClearContextOnPlanAccept":true}`).

**Evidence.** Hook, monitor and MCP logs are in `/tmp/sh-probe/out/*.jsonl`. Transcripts are in `~/.claude/projects/-private-tmp-sh-probe-work-*/`.

**Note.** Plan-mode turns ran on `claude-sonnet-5` even with `--model haiku`, because of a plan-mode model override in this account's settings.

## Results

| Probe | Question | Result | Evidence | Impact on plan |
|---|---|---|---|---|
| P1 | Does an `always` monitor start at session start? | **Yes.** It starts about 2 s after launch, before any prompt. The footer shows "1 monitor". | `mon-room.jsonl` `ts 18:52:31`; the session started at 18:52:28 | keep |
| P1 | What is the monitor's ppid chain? | `node mon.js` → `/bin/zsh -c source …shell-snapshot…; eval '<command>'` → **`claude`** (`CLAUDE_PID`). Hooks and the MCP server are **direct** children of `claude`. | `"12526 12524 node …mon.js room"`, `"12524 12113 /bin/zsh -c …"`, `"12113 6053 claude --plugin-dir …"`; hook `ppid:12113`; MCP `ppid:12113` | keep (ancestry walk works) |
| P1 | What env does the monitor get? | `CLAUDE_PID`, `CLAUDE_CODE_SESSION_ID`, `CLAUDECODE`, `CLAUDE_CODE_SESSION_ATTENDED=1`, `CLAUDE_CODE_MESSAGING_SOCKET`/`TOKEN`, and **no** `CLAUDE_PROJECT_DIR` or `CLAUDE_PLUGIN_ROOT`. Those two are only substituted into `command`. The cwd is the project dir. | `mon-room.jsonl` `env` | change: pass the plugin root and the project dir as arguments |
| P1 | What env do the MCP server and hooks get? | The MCP server has `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` (`~/.claude/plugins/data/sub-human-inline`), and **no `CLAUDE_PID`**. Hooks get all of these plus `CLAUDE_PID` and `CLAUDE_ENV_FILE`. | `mcp.jsonl` line 1; `hooks.jsonl` SessionStart `env` | change: the MCP server resolves through `process.ppid` |
| P1 | Does a monitor line wake an **idle** session? | **Yes.** A turn starts within about 1 s. The model replied "PONG". | `UserPromptSubmit.prompt = "<task-notification>\n<task-id>bo8ten9tj</task-id>\n<summary>Monitor event: \"probe\"</summary>\n<event>ROOM #1 alice: …</event>\nIf this event is something the user would act on now, send a PushNotification…"` | keep |
| P1 | Does it wake a session in **plan mode**? | **Yes.** The turn runs with `permission_mode:"plan"`, and the mode stays plan. | Pane: `⏺ PLANPONG`; Stop `permission_mode: plan` | keep |
| P1 | What happens to two lines that arrive together? | They are batched into **one** `<event>`, newline-joined and XML-escaped (`<b>` becomes `&lt;b&gt;`, `&amp;` becomes `&amp;amp;`). | `hooks.jsonl` 18:53:2x | keep (the tail emits `#id` refs; the model reads full text with `read`) |
| P1 | Does the monitor survive `/clear`? | **Yes.** The same process keeps running, but its `CLAUDE_CODE_SESSION_ID` env is **stale**. After the clear it still woke the session ("CLEARPONG"). | `pgrep` showed the same pid 14342 after SessionStart `source:"clear"` | change: the monitor never trusts the session-id env; it uses `CLAUDE_PID` |
| P1 | Which skill name does `on-skill-invoke` need? | It needs **`on-skill-invoke:sub-human:sub-human`**. The bare `on-skill-invoke:sub-human` never started. | Only `mon-skillB.jsonl` exists, created at 18:53:46 on `/sub-human alice otter-1234` | keep `always` (if used: qualified name) |
| P1 | What does `/exit` do while a monitor runs? | It shows a dialog, "Background work is running… 1. Exit and stop tasks 2. Move to background and exit 3. Stay". Option 1 sends SIGTERM to the monitor, and SessionEnd fires with `reason:"prompt_input_exit"`. | Pane; `mon-room.jsonl` `{"sigterm":true}` | doc: README; `member_left` on SessionEnd |
| P2 | Leading, double and trailing spaces? | Leading and internal spaces are **kept**. Trailing spaces are **trimmed**. | Typed `'  lead  double  and trail  '`, received `'  lead  double  and trail'` | fallback: document it; it is acceptable |
| P2 | Unicode, `$HOME`, backticks, quotes, backslash? | Byte-exact. A literal tab typed as a key is **dropped**, since Tab is a TUI key. | Received `'héllo — 🎉 $HOME \`tick\` "dq" \'sq\' back\\slash \\n tabend'` | keep |
| P2 | Multiline input? | `\` + Enter and **Ctrl+J** both insert a newline, and the hook receives `\n`. Shift+Enter through tmux submits, because tmux sends a plain Enter. | Received `'line1 bs\nline2 cj\nline3 senter'` | keep |
| P2 | Paste of more than 800 chars? | The UI shows `[Pasted text #1 +2 lines]`, but the hook gets the **expanded** text wrapped as `\n\n<pasted_content id="7968">\n…\n</pasted_content id="7968">\n`. Pasted tabs become **4 spaces**, and trailing spaces inside the paste are kept. A short paste is inlined, with tabs again turned into 4 spaces. | `'@room \n\n<pasted_content id="7968">\nPASTE-START word000 …'`; `body == orig.replace('\t','    ')` is True; `'room:short    paste  two  spaces'` | change: `at-room` unwraps `<pasted_content>` and records `normalized:true` |
| P2 | `source` values? | The field is **absent** for typed prompts, slash commands and monitor task notifications. The schema marks it optional. | `sorted(keys) = [cwd, hook_event_name, permission_mode, prompt, prompt_id, scratchpad_dir, session_id, transcript_path]` | **change**: don't require `source=="user"` |
| P2 | Does UserPromptSubmit see slash commands? | **Yes.** UserPromptExpansion fires first; then UserPromptSubmit gets the raw typed text, `"/sub-human alice otter-1234"`. | `hooks.jsonl` 18:53:46 | keep (the prefix test ignores `/…`) |
| P2 | Does a blocking hook prevent the model turn? | **Yes, zero assistant messages.** The transcript keeps only a `system/informational` entry, which the model never sees. The UI shows "UserPromptSubmit operation blocked by hook: <reason>". | No assistant messages in the window 18:55:30–18:56:45; transcript `{"type":"system","subtype":"informational"}` | keep (the next-prompt `additionalContext` is required) |
| P2 | Does `suppressOriginalPrompt` hide the prompt? | **Only inside `hookSpecificOutput`.** At top level it is ignored, and "Original prompt: …" is still shown. | Pane before and after the move | **change** |
| P2 | Does the `@` picker swallow `@room hello`? | **No.** Typing `@room` opens the picker (`+ room-notes.md`, …), and the space closes it. Enter submits `'@room hello'`. Even `@room` + Enter with the picker open submitted `'@room'` literally. A burst `@room fast` + Enter was also fine. Only **Tab** would complete to a file. `room:` has no picker. | `'@room hello'`, `'@room'`, `'@room fast'` | keep both prefixes |
| P3 | Which text does the dialog show after overwrite + `ask` + `updatedInput`? | The **canonical** text. A line "Hook PreToolUse:ExitPlanMode requires confirmation for this tool." is added. | Pane `CANONICAL PLAN / This is the room canonical plan text v…` | keep |
| P3 | Same with overwrite and **no decision**? | Also **canonical**: the dialog re-reads the file from disk, and there is no banner. Only the PermissionRequest `tool_input.plan` keeps the model's text. PostToolUse `tool_response.plan` is canonical either way. | PermissionRequest `{"plan":"# MODEL PLAN 4\n"}`; PostToolUse `tool_response.plan "# CANONICAL PLAN…"` | keep `ask` (it forces the dialog); either works |
| P3 | PostToolUse after manual approve, unedited? | `tool_input` is **`{}`**, and `tool_response` is `{plan, isAgent:false, filePath}`, with **no `planWasEdited` key**. Then the model **starts implementing** the plan. | `tool_response {"plan":"# CANONICAL PLAN…","isAgent":false,"filePath":"…snug-rocket.md"}` | keep; `plan-result` must inject "don't implement" |
| P3 | Can the plan be edited in the dialog? | Yes, with Ctrl+G, which runs `$VISUAL`/`$EDITOR` on the plan file ("ctrl+g to edit in VS Code" by default). The dialog then shows the edited text. On approval, `tool_input = {plan: <edited>}` and `tool_response.planWasEdited: true`. | `tool_response {"plan":"…- step two\n\n- EDITED BY BOB: add step three\n", …, "planWasEdited":true}` | keep (objection = `planWasEdited===true` **or** hash mismatch) |
| P3 | Is there a "clear context" approve option? | Only when the `showClearContextOnPlanAccept` setting is true (default **false**). The option reads "1. Yes, clear context (6% used) and auto-accept edits". | Pane p3b | — |
| P3 | What happens on clear-context approve? | **No PostToolUse.** SessionEnd fires with `reason:"clear"`, then SessionStart with `source:"clear"` and a **new `session_id`**. `CLAUDE_PID` is unchanged. The new session's first user message is `Implement the following plan:\n\n<canonical>…` plus `User feedback on this plan: …` when there is feedback, and **no UserPromptSubmit fires** for it. The new session immediately implements in acceptEdits. In the old transcript, the approval looks like a rejection plus "[Request interrupted by user for tool use]". | `SessionEnd reason clear 4725063f` → `SessionStart source clear 8cea5671`; new transcript's first user msg | **change**: refuse member review while the setting is on, and never log `member_left` on `reason:"clear"` |
| P3 | Shift+Tab "approve with this feedback"? | With clear-context enabled, it took the **clear-context** path and appended `User feedback on this plan: LGTM but no tests`. | Transcript 17d86dac | covered by the change above |
| P3 | Is the plan file stable across cycles? | Yes, the same plan-file slug and path are reused for every plan cycle within a session. | `…snug-rocket.md` reused by cycle 2 | keep (`plan-backup`) |
| P3 | Does PermissionRequest fire for ExitPlanMode? | Yes, after PreToolUse, with the `updatedInput` (canonical) `tool_input`. | `hooks.jsonl` 18:57:17.944 | info |
| P4 | `command_name`, `command_args`, `session_id`? | `command_name:"sub-human:sub-human"`, `command_args:"alice otter-1234"`, `command_source:"plugin"`, `expansion_type:"slash_command"`, `prompt:"/sub-human:sub-human alice otter-1234"`, and `session_id` present. | `hooks.jsonl` UserPromptExpansion | keep matcher `^(sub-human:)?sub-human$` |
| P4 | Is the command shown as `/sub-human` or `/sub-human:sub-human`? | The picker and transcript show **`/sub-human:sub-human`**. Typing bare `/sub-human alice otter-1234` works, and the echo is rewritten to `/sub-human:sub-human …`. | Pane `❯ /sub-human:sub-human alice otter-1234` | keep; docs say `/sub-human` |
| P4 | Do `$name` and `$code` substitute? | Yes, as do `$ARGUMENTS` and `$0`. | Model output `name=[alice] code=[otter-1234] args=[alice otter-1234] arg0=[alice]` | keep |
| P4 | Do `additionalContext` and `systemMessage` work? | `additionalContext` reaches the model (it echoed "PAPAYA"). `systemMessage` is shown to the user as `⎿ UserPromptExpansion says: PROBE-SYS visible to user`. | Pane | keep (the invite code goes in `systemMessage`) |
| P4 | What are the MCP tool names? | **`mcp__plugin_sub-human_room__post`**. PreToolUse `mcp_server: {"name":"plugin:sub-human:room","source":"plugin"}`. The UI label is "plugin:sub-human:room — Post". | `hooks.jsonl` PreToolUse | keep |
| P4 | Does PreToolUse `allow` skip the MCP prompt? | **Yes.** Without the hook, the prompt "Do you want to proceed? 1. Yes 2. Yes, and don't ask again… 3. No" appears and PermissionRequest fires. With `permissionDecision:"allow"` the tool runs with no prompt, and PostToolUse `tool_response` is `[{"type":"text","text":"posted: {\"text\":\"second\"}"}]`. | `hooks.jsonl` 18:54:41 vs 18:55:2x | keep (`guard`) |
| P5 | What fires on a plain Esc decline? | **No hook events at all**: no PostToolUse, PostToolUseFailure, PermissionDenied or Stop. The transcript gets a tool_result "…rejected… STOP what you are doing…" plus "[Request interrupted by user for tool use]". | `hooks.jsonl`: nothing after PermissionRequest at 19:02:13 | keep (no sign-off; that's correct) |
| P5 | What fires on "Tell Claude what to change" + feedback? | Only **Notification** (`permission_prompt`, "Claude Code needs your approval for the plan", sent while the dialog is open) and **Stop** after the model's reply. There is no PostToolUse, PermissionDenied or UserPromptSubmit. The feedback appears **only in the transcript**: tool_result `is_error:true`, `"…To tell you how to proceed, the user said:\nOBJECT: use 3 retries not 5\n\nNote: …"`. | `hooks.jsonl` 18:58:47–18:59:17; p3 transcript | **change**: Stop-hook transcript scan for the human objection |

## Design adjustments (build agents must apply)

1. **`at-room.js`: don't gate on `source`.**
   - `source` is absent on typed prompts and on task notifications.
   - Match the prompt on `^@room ` or `^room:`, and never on prompts that start with `<task-notification>` or `/`.
   - Trailing whitespace is trimmed by the TUI. Document that.
2. **`at-room.js`: handle pastes and suppress the echo.**
   - Unwrap `\n\n<pasted_content id="N">\n…\n</pasted_content id="N">\n`, and log `normalized:true` whenever a paste was unwrapped. Pasted tabs become 4 spaces.
   - Put `suppressOriginalPrompt:true` inside `hookSpecificOutput` (`hookEventName:"UserPromptSubmit"`). At top level it is ignored.
   - A blocked prompt never reaches the model, so the next-prompt `additionalContext` notice is required.
3. **Identity resolution.**
   - **Monitor:** after `/clear` it keeps a stale `CLAUDE_CODE_SESSION_ID`. It must resolve through `CLAUDE_PID`, which is present and is its grandparent through `zsh -c`.
   - **MCP server:** it has no `CLAUDE_PID`. Use `process.ppid`, which is `claude` directly.
   - **Hooks:** `session_id` comes first, then `CLAUDE_PID`. The PID is stable across `/clear`.
   - **Monitor command:** the monitor env lacks `CLAUDE_PLUGIN_ROOT`, so pass it in the monitor `command` string, which is substituted. Quote `"${CLAUDE_PLUGIN_ROOT}"` everywhere, because `claude plugin validate` warns about unquoted uses.
4. **`session-end.js`:** log `member_left` only for reasons other than `clear`. Both `/clear` and the clear-context approval give `reason:"clear"`, and `/exit` gives `prompt_input_exit`.
5. **Member `plan-gate.js` (keep the overwrite + `ask` + `updatedInput`).**
   - The dialog renders the file from disk, so the overwrite is what matters. `ask` forces the dialog and adds one cosmetic banner line.
   - **New:** if `showClearContextOnPlanAccept` is true in any settings layer (user, project or local), deny with "turn off clear-context-on-accept to review room plans". That path fires no PostToolUse, starts a new session that implements immediately in acceptEdits, and the approval can't be told apart from a rejection in the transcript.
   - Defensively, `session-restore.js` on `SessionStart source=clear` with a pending review should inject "this was a room review; do not implement".
6. **Member `plan-result.js`.**
   - Hash `tool_response.plan`, not `tool_input`, which is `{}` when unedited.
   - Edited = `tool_response.planWasEdited === true` (the key is absent otherwise) or a hash mismatch. Log that as an objection with the edited text.
   - Always return `additionalContext`: "sign-off recorded; do not implement; wait for the room". Unprompted, the model starts implementing right after approval.
7. **Decline handling.**
   - A decline produces no tool hook, and Esc produces no event at all. To log "Tell Claude what to change" feedback as `objection via=human`, add a member **Stop hook**.
   - The Stop hook scans `transcript_path` backwards for the last ExitPlanMode `tool_result` with `is_error:true` containing `the user said:\n`. It logs the text up to `\n\nNote:` once per `tool_use_id`.
   - Esc stays silent, which is correct: no sign-off is recorded.
8. **Names.**
   - `UserPromptExpansion` `command_name` is `sub-human:sub-human`, so keep the matcher `^(sub-human:)?sub-human$`.
   - MCP tools are `mcp__plugin_sub-human_room__{post,read,plan}`, so the guard matcher `mcp__plugin_sub-human_room__.*` is right, and a PreToolUse `allow` suppresses the prompt.
   - If a monitor ever uses `on-skill-invoke`, it must name `sub-human:sub-human`.
9. **Monitor.**
   - Keep `when:"always"`. It wakes idle and plan-mode sessions.
   - The monitor batches lines that arrive together into one event and XML-escapes them, so emit short `#id from kind` lines and let the model `read`.
   - README: `/exit` asks "Exit and stop tasks / Move to background", and the user should choose 1.
10. **Live tests:** launch every tmux session with the inherited `CLAUDE*` env stripped, as in `/tmp/sh-probe/start.sh`. Otherwise, sessions started from inside Claude Code inherit `CLAUDE_PID` and `CLAUDE_CODE_SESSION_ID` and confuse identity.

## Cost

These are API-equivalent figures, deduplicated by message id.
- p1: about $0.25 (Haiku 4.5, plus 2 plan-mode Sonnet 5 turns).
- p3: about $0.24.
- p3b, three session ids across the two clears: about $0.68.

**Total: about $1.2.** The blocked P2 prompts cost $0.

## Cleanup

- All `sh-*` tmux sessions were killed.
- `pgrep` found no `mon.js`, `mcp.js` or `--plugin-dir /tmp/sh-probe` processes left.
- The two plan files the probes created were deleted: `~/.claude/plans/task-create-hello-txt-containing-snug-rocket.md` and `…-dreamy-aho.md`.
- The pre-existing `room-*` tmux sessions and `~/.claude` settings were not touched.
- Probe transcripts are still in `~/.claude/projects/-private-tmp-sh-probe-work-*`, and the probe tree is still at `/tmp/sh-probe/`.

## Live verification

Run on 2026-10-04 from 12:23 to 12:41 local time, with Claude Code 2.1.281, against `plugin/sub-human` as built (unit tests 76/76).

**Setup.**
- Room `eagle-3407`. `SUB_HUMAN_HOME=/tmp/sh-live/home`.
- Working dirs `/tmp/sh-live/{orch,alice,bob}` are copies of `demo/app.pristine`.
- Each tmux session (`shl-*`, 220 columns) was launched by `/tmp/sh-live/start.sh`, which unsets every inherited `CLAUDE*` variable.
- orch ran on the default model (Opus 5.5). alice and bob ran with `--model sonnet` (Sonnet 5). A throwaway 4th session, `eve`, ran on haiku.
- This account starts every session in **auto mode**.
- **Evidence.** The log is `/tmp/sh-live/home/rooms/eagle-3407/log.jsonl` (34 entries). The orch keypress record is `/tmp/sh-live/orch-keys.txt`. Copies of the three plan files are in `/tmp/sh-live/plans-copy/`. Helpers: `/tmp/sh-live/tx.js` (transcript timeline) and `/tmp/sh-live/cost.js`.

### Results

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | Join and identity | **PASS** | `/sub-human` printed `eagle-3407`. `members.json` has distinct PIDs: orch 58517, alice 58519, bob 58521. `member_joined` was logged at #1 (bob) and #2 (alice). Eve's `/sub-human alice eagle-3407` was blocked: `name taken: "alice" is already in eagle-3407`. alice's Claude ran exactly `CLAUDE_PID=58521 sub-human who` (bob's PID, confirmed in the transcript), and it printed `alice (member) in eagle-3407`. A `room.post` by alice's Claude was logged as #4 `from=alice via=agent kind=say`. |
| 2 | `@room` verbatim | **PASS** | `@room  héllo — "q" $HOME \`x\`` was logged as #5, `via=human`. Its text is ` héllo — "q" $HOME \`x\``: a byte-for-byte match with everything after the `@room ` prefix, keeping the second leading space. alice's transcript has only a `system/informational` entry and no assistant turn. After `/clear` (new session id `eb6b4c8c`, same PID), `@room after clear, still alice` was logged as #6 `from=alice via=human`. |
| 3 | Monitor wake | **PASS** | #5 was appended at 19:26:45.965. Its task-notification reached orch at 46.378 and bob at 46.395, about 0.4 s later. Idle orch started a turn (`room.read` of #5 at 48.055), and so did bob. |
| 4 | Gate | **PASS** (one sub-check not run) | Seeded by alice's #7 and bob's #8 (`@room`). orch drafted the plan by itself. #11 `plan_rev plan_hash=fdd5fc8b91d3 approvers=["alice","bob"] via=system`. `plans/fdd5fc8b91d3.md` matched orch's plan file under `cmp`. The deny reason was `ROOM-GATE: plan fdd5fc8b91d3 lacks sign-off from alice and bob…`. #12 `status via=system`: "plan fdd5fc8b91d3 is waiting for sign-off from alice and bob". No dialog appeared in orch at any time. **Open risk resolved: orch *can* call `room.post` in plan mode** (#13, #14, #18, #20, #23 and #24 were all posted from plan mode). Not run: a deny for a forced `approvers:["alice"]`, because nobody may type into orch (unit tests cover it). |
| 5 | Member native approval | **PASS**; drift case **PARTIAL** | alice's Claude opened the review **unprompted** on `plan_rev` (see finding F3). Its stub differed from the canonical plan, yet the dialog showed the canonical plan: `cmp` matched alice's plan file to `plans/fdd5fc8b91d3.md`, and the frontmatter appeared in the dialog. Option 2, "Yes, manually approve edits", logged #15 `signoff via=human from=alice plan_hash=fdd5fc8b91d3`. alice's Claude did not implement: there were no tool calls and no file changes in `/tmp/sh-live/alice` for the whole run (checked with `find -newer`). Drift case: alice was asked to append "- Max limit is 500." to the stub, and her Claude **refused** after 3.5 minutes of thinking. The forced-drift path was therefore not exercised live. The ordinary stub-versus-canonical swap worked in all three reviews. |
| 6 | Decline voids sign-off | **PASS** (Ctrl+G edit not tested) | bob chose "Tell Claude what to change" and typed a reason. The Stop hook logged #17 `objection via=human from=bob plan_hash=fdd5fc8b91d3`, with the exact text. orch treated it as a conflict with alice's #7 and asked her (#18). After alice's `@room` #19, orch revised the plan to `5bd074bd0aef` (#21 `plan_rev`). `room.plan` then showed `signed:{alice:null,bob:null}`, and the gate status #22 named "alice and bob". alice's sign-off on h (#15) did not carry over. Esc on a review (alice, 19:31:22) logged nothing and caused no loop. |
| 7 | Auto-approve | **PARTIAL**, then fixed in code | bob signed h′ (#25) and alice signed h′ (#27). orch's ExitPlanMode was allowed with **no dialog**. #28 `decision plan_hash=5bd074bd0aef refs=[27,25] via=system`. `validateChain()` returned `{ok:true,count:31}`. **The assignments did not follow by themselves.** orch ended its turn saying it would post them "when the decision entry lands", but its tail filters out `from=orch` entries, so it was never woken (bug B1). After **one manual nudge** (see the keypress log below), orch posted the assignments: #29 (phase: diverge), #30 to alice and #31 to bob, each with owner, file, contract and what "done" means, citing #28. |
| 8 | Leave | **PASS** | bob's `/exit` showed the "Background work is running" dialog, and option 1 logged #32 `member_left from=bob via=system "bob left (prompt_input_exit)"`. `members.json` has bob's `left_at`. orch then posted #33 (bob left) and #34 (who takes the tests?). |

There were no loops and the rate limiter never triggered. The most agent posts in any one minute was 4, from orch at 19:27–19:28.

### Every keypress sent to orch

1. 12:23:49. `Down`, then `Enter`, on the trust dialog to choose "Yes, I trust this folder".
2. 12:24:04. `/sub-human`, then `Enter`. This Enter only accepted the slash-command autocomplete; the prompt still showed `/sub-human [NAME CODE]`.
3. 12:24:22. A second `Enter`, which submitted the command. Nothing else was typed into orch until step 4.
4. 12:39–12:40. **One manual nudge**, at the coordinator's request, to recover from bug B1: `Decision #28 is logged for plan 5bd074bd0aef. Post the assignments to the room now, citing #28.` followed by Enter.
   - The first attempt with `send-keys` failed with `client is read-only`, because read-only tmux clients were attached to the `shl-*` sessions.
   - The same text was then delivered with `tmux set-buffer` + `paste-buffer`, and Enter as a CR with `paste-buffer -r`.

### Bugs and findings

- **B1: the orchestrator deadlocks after `decision`. Found, then fixed by the coordinator during the run. Not re-verified live.**
  - Cause: the hook writes `decision` as `from=orch via=system`, and `bin/sub-human tail` drops every `from=orch` entry for the orch, so the notice never arrives. orch had ended its turn waiting for it, which is a conditional wait like spike R3.
  - Fix:
    - `hooks/plan-result.js` (orch branch) returns `additionalContext`: "Decision #N is logged… Post the assignments to the room now".
    - `bin/sub-human` `tail` now passes the orch its own `via=system` `decision` entries.
  - Re-run criterion 7 once to confirm that no nudge is needed.
- **F2: the default option in the member dialog is "1. Yes, and use auto mode".**
  - In this account, sessions start in auto mode. The member's Claude enters plan mode itself, so the gate sees `permission_mode=plan` and its "refuse in auto/bypass" check never fires.
  - A reflexive Enter records a valid sign-off **and** switches the member to auto mode. After that, an assignment could be implemented without the human saying "go".
  - Suggested fixes:
    - `hooks/plan-result.js`: read `permission_mode` from the PostToolUse input. When it is `auto` or `acceptEdits`, inject "you are now in auto mode; still do not implement until NAME says go".
    - README: say "choose option 2".
- **F3: member Claudes open the review dialog unprompted on `plan_rev`** (`skills/sub-human/member.md`, step 3).
  - Both reviews popped up within about 8 s of `plan_rev`, while the humans might have been typing. Keystrokes meant for the prompt can land in the dialog, and Enter selects option 1.
  - Suggested fix: announce the plan and enter the review only when NAME says so (e.g. "review"), or at least only when NAME's last prompt is not mid-turn.
- **F4: Claude Code's prompt suggestions propose `@room …` text.**
  - Ghost text appeared in the members' prompts, e.g. `@room I want to build...`, `@room fine by me, 50 is fine` and `@room yes, I'll take test/tasks.test.js…`.
  - Accepting a suggestion and pressing Enter posts **model-written words as `via=human`**. `at-room.js` cannot tell them apart.
  - Suggested fixes: README, tell members to disable prompt suggestions, or at least never to accept an `@room` suggestion. `member.md`: avoid ending turns with "you can type @room …" phrasing, which seeds the suggestions.
- **F5 (minor): stale status after an objection.** After bob objected, bob's Claude said "Alice already signed off; the plan's now waiting on just you". That is true but implies bob should simply approve.
  - Suggested fix (`member.md`): after an objection, say the orchestrator will revise, and don't restate the matrix.
- **F6 (minor): paths in orch's plan and assignments are relative to the repo.** They say `demo/app/src/server.js`, but members work from the app root.
  - Suggested fix (`orchestrator.md`): write paths relative to the members' working copy.
- **F7 (minor, docs): bare `/sub-human` needs two Enters.** With no arguments, the first Enter only accepts the autocomplete. The README could say so.
- **F8 (environment): read-only tmux clients block `tmux send-keys`.** It fails with `client is read-only`. `paste-buffer` still works. This matters only for test harnesses.

### Approximate cost

These are API-equivalent figures, deduplicated by message id, at Opus 5.5 $5/$25 and Sonnet 5 $3/$15 per MTok, with cache reads at 0.1× and cache writes at 1.25×.
- orch (Opus 5.5): about $1.6.
- alice (Sonnet 5): about $1.0. That includes the 3.5-minute drift refusal.
- bob (Sonnet 5): about $0.8.
- eve: $0.

**Total: about $3.4.**

### Verdict

**Ready for a supervised trial with two real people, after one live re-run of criterion 7 with the B1 fix.**
- Identity binding, verbatim `@room`, monitor wake-ups, the gate, native sign-off, objection capture, the hash chain and leave all worked live, with no loops.
- Before an unsupervised trial, fix F2 (the default dialog option approves into auto mode) and F3 (the unprompted dialog pop-up). Mention F4 (`@room` prompt suggestions) in the README.

### Cleanup

- The `shl-orch`, `shl-alice`, `shl-bob` and `shl-eve` tmux sessions were killed. No `--plugin-dir …/sub-human` claude, `room-server.js` or `sub-human tail` processes from this run remain.
- A Ghostty `sub-human watch eagle-3407` "room feed" window is still open. It was not started by this run and was left alone.
- The three plan files this run created were deleted from `~/.claude/plans/`, after copying them to `/tmp/sh-live/plans-copy/`: `pure-knitting-heron.md` (orch), `partitioned-wishing-stream.md` (alice) and `compiled-growing-graham.md` (bob).
- `/tmp/sh-live/home` is kept as evidence.
