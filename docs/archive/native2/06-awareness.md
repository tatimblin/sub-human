# 06: Awareness without needless wakes (Monitor, FileChanged + asyncRewake, hook context, channels, push)

Claude Code 2.1.281. Probe: `/tmp/n2-06/` (plugin `plug/`, `hooklog.txt`, `debug.txt`, transcript
`~/.claude/projects/-private-tmp-n2-06-work/754422f4-….jsonl`), tmux `n2-06-a`, Haiku, 4 turns, killed.
Labels: **[probe]** verified-by-probe, **[src]** verified-by-source (`strings` on the binary), **[doc]** documented, **[inf]** inferred.

## The question, restated

Today `sub-human tail` (plugin monitor) prints one line per visible entry. Through `visibleTo()` in `bin/sub-human`, a member sees
*every* `via=human` post, every orchestrator post to the room and every system entry. Each line that reaches an idle session is a
full model turn (on Opus, a whole cached context re-read) whose output is usually "noted". The aim is "tell me only what concerns me,
when it concerns me".

**Short answer: no native mechanism filters for you. Every push path (Monitor, channels, asyncRewake, SendMessage, ScheduleWakeup,
task-notification) costs one turn per idle delivery. The only zero-turn paths are pulls: hook `additionalContext` on the next turn,
for the model, and the status rows, for the human. So: push only what is addressed to me, and let everything else ride along on the
next turn for free.** Two of the hooks needed already exist.

## 1. Capability

| Mechanism | Wakes an idle session? | Who decides relevance | Cost per event | Evidence |
|---|---|---|---|---|
| Plugin **Monitor** (`monitors.json`) | Yes. Each stdout line becomes `<task-notification>…<event>line</event>`, shown as "Monitor event: <description>" | The script (stdout = event; stderr is silent) | 1 turn if idle; lines within 200 ms batch into 1 notification; absorbed mid-turn if busy | [probe] 2 `@me` lines, 2 turns; 5 other lines, 0 turns. [src] tool prompt: "Stdout lines within 200ms are batched", "Monitors that produce too many events are automatically stopped" |
| **FileChanged + `asyncRewake`** (new; round 1 missed it) | Yes, only on exit 2. Exit 0 is silent | The hook, which runs once per file change | 1 node/sh spawn per append per session; 1 turn only on exit 2 | [probe] SessionStart returned `watchPaths:["/tmp/n2-06/rooms"]`; a dir watch is recursive; 4 appends gave 4 FileChanged runs; 3 exited 0 (no turn), 1 exited 2 (1 turn). [src] chokidar `awaitWriteFinish{stabilityThreshold:500}`, so there's about 0.5 s debounce |
| **UserPromptSubmit `additionalContext`** | No. It rides on the next turn | The hook | 0 extra turns | [probe] it fires on human prompts **and on monitor/asyncRewake wake turns** (`prompt` = `<task-notification>…`); context lands as a `hook_additional_context` attachment. Backlog #1–3 arrived free on the #4 wake turn, #6–7 on the human's next prompt |
| PostToolUse / PostToolBatch `additionalContext` | No. It rides on the next model call mid-turn | The hook | 0 extra turns | [src] schema `hookEventName:"PostToolBatch",additionalContext` (not probed) |
| Channels (`notifications/claude/channel`) | Yes | The server | Same as Monitor, plus a dev-flag dialog on every launch and "NOT from your user" framing | round 1 07 [probe] |
| SendMessage / cross-session | Yes (`turnOrigin:peer`) | The sender | Same, and the sender is forgeable | round 1 02 |
| ScheduleWakeup / CronCreate / `/loop` | Yes, on a timer | The model, by polling | 1 turn per tick whether or not anything happened; clamped to 60–3600 s | [src] `delaySeconds … Clamped to [60, 3600]` |
| PushNotification | No. It is an *output* from the model to the phone or terminal | The model | Needs a turn to call it; gated by flag `tengu_kairos_push_notifications` | [src] `isEnabled(){return $N("tengu_kairos_push_notifications",!1)}` |
| Notification hook | No. It fires on Claude Code's own idle, permission or elicitation events | n/a | 0 | [src] `hookEventName:"Notification",additionalContext`; useful for presence only (round 1 05) |
| Agent panel row (`subagentStatusLine`), status line, `sessionTitle` | No. Human only | Plugin script | 0 model cost | `sessionTitle` is set only from a SessionStart/UserPromptSubmit hook, so it is not async [src]; rows refresh on their own (round 1 03) |
| Task-notification when a subagent finishes | Yes | Native | 1 turn | Only for this session's own subagents; can't carry room events |

Further source detail [src]:
- Monitor manifest fields are only `name`, `command`, `description` and `when` (`always` | `on-skill-invoke:<skill>`). There is no filter, priority, quiet or digest option.
- The `ambient` / `skipTranscript` monitors (`monitor_ws … ambient===!0`) are internal Artifact-comment watchers. Plugins can't use them.
- `asyncRewake` is accepted on any command hook event: `(e.async||e.asyncRewake&&…)` backgrounds it regardless of event.
- Its wording is fixed. The model sees `<summary>Stop hook feedback</summary> … Stop hook blocking error from command "FileChanged": …`, and the user sees "⏺ Stop hook feedback" [probe].
- `rewakeMessage` and `rewakeSummary` are `@internal`, and the JSON `rewakeSummary` is honoured only for allowlisted marketplaces (round 1 05).

## 2. Mapping onto sub-human

**Split every room entry into one of two lanes:**
1. **Push (wakes the model).** Entries that need *this* member's Claude to act now:
   - `to === me`;
   - a `plan_rev` whose `approvers` include me;
   - an objection on a plan I own;
   - the `decision` and assignment naming me;
   - a direct question to me.
   This is `visibleTo()` narrowed in `bin/sub-human tail`, still printed by the existing monitor.
2. **Pull (free).** Everything else:
   - other people's `say`s;
   - orchestrator chatter;
   - joins and leaves;
   - status posts.

   `hooks/at-room.js` already runs on every UserPromptSubmit. When the prompt isn't `@room`, it returns
   `additionalContext: "Room since your last turn: …"` (a cursor per member, capped at about 1.5k characters, then "+N more: `sub-human read`").
   Because UserPromptSubmit also fires on wake turns [probe], one push delivers the whole backlog with it.
   Optionally, a PostToolBatch hook delivers the same digest mid-turn during long work.

**The human's lane:** the room row text (`statusline/segments.js` / `lib/rows.js`) already shows `⚠ your sign-off needed` and
`✉ 1 for you`, and the elicitation form alerts by itself. So the human needs no model turn to know something is waiting.

**Other changes:**
- The role text can drop "tell the user each notice in a line" (README, "What each person sees"). Pushed notices are now actionable by definition.
- `at-room.js` must keep ignoring prompts that begin with `<task-notification>` [probe: that is the `prompt` on wake turns]. Today it does, because they don't start with `@room ` or `room:`. Keep it that way, along with the A8 peer-envelope check.
- The orchestrator is the exception. `visibleTo` returns everything for `role==='orch'`, and it is meant to react to every human post. Leave it there, or batch it, since the 200 ms monitor batching already merges bursts.

## 3. Minimal footprint

- **No new files.** You change about 20 lines in `visibleTo()` (`bin/sub-human`) and add about 30 in `hooks/at-room.js` (a digest with a cursor named, for example, `ctx-<name>` via `room.setCursor`).
- **Could go:**
  - the "narrate every notice" paragraph of the injected role text;
  - part of `statusline/alert.js`, because direct messages now wake the model, which can tell the human.
- **Unchanged:** `monitors/monitors.json`.
- **If FileChanged + asyncRewake replaced the monitor:**
  - `monitors/monitors.json` and the `tail` follow loop (about 80 lines) go;
  - the open "on-skill-invoke monitor isn't restored after `--resume`" risk in `rebuild-plan.md` goes away, since SessionStart re-runs on resume [inf];
  - the `1 monitor` footer disappears;
  - you add a SessionStart `watchPaths` entry in `row-launcher.js` plus a FileChanged hook script.

  It isn't worth it today, because of the wording in §4.

## 4. Limits and risks

- **The relevance filter stays custom.** Nothing native knows what "concerns me". The win comes from emitting less, not from picking a different transport. [inf]
- **Pull has latency.** An FYI entry reaches the model only on its next turn. If the human is away and nothing is addressed to them, the model learns nothing. That is the intended behaviour, but `sub-human digest` remains the catch-up tool.
- **The context hook can bloat each prompt.** Cap it, and skip it when empty. It also appears on wake turns, so keep it terse.
- **FileChanged + asyncRewake has costs:**
  - the "Stop hook feedback" / "Stop hook blocking error" framing misleads both the model and the user [probe];
  - every session in every project would watch `~/.sub-human/rooms`, because the join hook (UserPromptExpansion) can't return `watchPaths` [src schema]. The alternative is a FileChanged/CwdChanged re-arm;
  - concurrent hook runs race on the cursor;
  - each append spawns one process per session.
- **Monitor auto-stop.** The "too many events" threshold wasn't found in source. Narrowing the filter makes it less likely to trip. [src, partial]
- **Mid-turn absorption** of monitor events while busy was not re-probed. It is documented by the tool prompt ("you keep working and notifications arrive") and was shown for channels in round 1 07.

## 5. Recommendation

**Adopt now: a selective Monitor (push) plus `additionalContext` from the existing UserPromptSubmit hook (pull).** It is the least custom
code, it is native on both lanes, and the probe showed chatter costing 0 turns while addressed lines cost 1 each, with the backlog riding free.
**Adopt later / keep as a fallback:** FileChanged + `asyncRewake`, if monitors turn out not to survive `--resume`.
**Don't:**
- ScheduleWakeup, which polls and spends a turn per tick;
- PushNotification as an awareness path, because it needs a turn and is flag-gated;
- channels, for the reasons in round 1;
- `sessionTitle` as live state, because it only updates from synchronous hooks.

**Deciding experiment.** Run a three-member room (Opus orchestrator, two Haiku members) for 30 minutes with 40 entries, of which 6 are addressed to member A.
- **Count:** member A's model turns that were not prompted by A.
- **Pass:** at most 6 such turns (fewer if bursts batch), and A's next human prompt carries the other 34 entries as one capped `hook_additional_context`.
- **Today's baseline:** about 25 wakes for A (every `via=human` post plus orchestrator and system posts).
