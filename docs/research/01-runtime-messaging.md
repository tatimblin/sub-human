# 01: Subagent runtime and messaging

Topic: assumption 1 (long-lived seats) and assumption 3 (messaging). Claude Code 2.1.281.

## Sources and labels

- **Source.** `/opt/homebrew/bin/claude` → `/opt/homebrew/Caskroom/claude-code@latest/2.1.281/claude`. This is a Mach-O arm64 Bun single-file executable. The JS chunks (`/$bunfs/root/chunk-*.js`) are embedded as plain text, so I read them with `strings`. Citations below quote identifiers or string literals from that binary. Minified names like `YV`, `tae` and `bQe` are only stable for this build.
- **Docs.** code.claude.com/docs/en/{sub-agents, agent-teams, cross-session-messaging, agent-view, channels, tools-reference, env-vars}, fetched 2026-10-03.
- **Probes.** Four `claude -p --model haiku --max-budget-usd 0.50` runs in `/tmp/seat-research-runtime/probe/` (about $0.40 in total). Transcripts are in `~/.claude/projects/-private-tmp-seat-research-runtime-probe/`, which was only read, never modified. No processes were left running.
- **Labels.** Every finding carries one: *verified-by-source*, *verified-by-probe*, *documented*, or *inferred*.

## Short answers

| Question | Answer | Label |
|---|---|---|
| Can a background subagent live about an hour, mostly blocked on a human? | Yes, if it parks on a background command or keeps calling a blocking tool. Nothing found ends it for being idle. The stall watchdog skips agents that have a tool in flight. | source + probe; 1h not tested |
| Does a waiting subagent burn tokens? | No. No API calls happen while a tool blocks or while the agent is parked. The cost comes on each wake: one model turn for the seat, plus one turn in the orchestrator for each completion notice. | probe |
| How does a message reach a running subagent? | It goes into a queue and is injected at the receiver's next tool round. It never interrupts a running tool. If the agent has stopped, the message resumes it from its transcript. | source + probe |
| Can a subagent message its parent mid-task? | Yes, with `SendMessage({to:"main"})`, from background subagents only. It arrives as `<agent-message from="<agentId>">`. | source + probe |
| Can siblings message each other? | Yes, by name, but only when names exist. The Agent tool's `name` parameter is removed from the schema unless agent teams are enabled. | source + probe |
| Who stamps the sender? | The runtime. The model can't set `from`, and envelope-like tags inside a message body are escaped. File mailboxes between teams and processes are only "unverifiable". | source + probe |
| Should seats be teammates? | Not for the local spike. In-process teammates can't spawn background helpers, plan approval is automatic, and the feature is experimental and doesn't run under `-p`. | documented + source |

---

## 1. The Agent tool

### Foreground vs background

- **Who picks fg/bg.** Claude Code decides foreground or background, not the model alone (*documented*, sub-agents, "Run subagents in foreground or background"):
  - In interactive sessions fork mode is on by default. There every subagent runs in the background, and `run_in_background` is removed from the schema.
  - Under `-p` and the SDK fork mode is off, and Claude may choose either.
  - Frontmatter `background: true` forces background.
  - `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` forces foreground.
  - Source: `U4n` omits `run_in_background` when `Hl()||G7()`. The parameter description says "Agents run in the background by default" (*verified-by-source*).
- **Background tool set.** Background subagents get a smaller built-in tool set: Read, Grep, Glob, LSP, Bash, Edit, Write, WebFetch, WebSearch, TodoWrite, Skill, ToolSearch, worktree tools, **Monitor, TaskStop, SendMessage**, Artifact, plus every MCP tool. `Agent` and `ExitPlanMode` follow the separate depth and plan rules. `AskUserQuestion` is never available (*documented*, sub-agents "Available tools").
- **Permission prompts.** A background subagent's permission prompts appear in the main session. A grant that lasts longer than one call applies to the whole session (*documented*).
- **Nesting.** Default depth is 3 (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`). Beyond it the Agent tool fails with "Subagent nesting limit reached (depth N of M)". Source: `mo()` in the Agent chunk (*verified-by-source*). So a seat at depth 1 can spawn helpers.
- **Concurrency.** At most 20 subagents run at once (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`). Resumes take a slot without checking the limit (*documented*).

### Lifetime, turn limits, what ends a subagent

- **`maxTurns`.** Unlimited unless the definition sets `maxTurns`. The runtime passes `maxTurns: B ?? e.maxTurns`, which is undefined for ordinary agents. Forks are capped at `maxTurns:200` (`AM` fork definition) (*verified-by-source*). At the limit the output is marked partial and can be resumed: "stopped at its N-turn limit (partial result; SendMessage to task-id to continue)" (*verified-by-source*, *documented*).
- **What ends a run.**
  - The agent ends its turn.
  - It hits maxTurns.
  - An API error.
  - A user stop (`x` in `/tasks`, or TaskStop).
  - The stall watchdog.
  - The parent process exits.

  "Ends" means the run is over. The agent record stays resumable until transcripts are cleaned up (`cleanupPeriodDays`, 30 days by default) (*documented*).
- **Stall watchdog.**
  - `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS`: default 600 s, or the stream idle timeout + 300 s when the watchdog is on. It aborts a background agent with "Agent stalled: no progress for Ns".
  - The timer is deferred while a tool is running: `stall watchdog deferred — N tool(s) in flight`, in function `AV` (*verified-by-source*). So a seat blocked inside a tool call is not killed as stalled.
- **Ending a turn with a background child alive.** This is the "parking" pattern, and it does not end the agent:
  - The parent gets an interim notice: `<note>This agent stopped with background work of its own still running. It may resume on its own when that work completes or reports, and the same task-id notifies again if it does; the result below may be interim.</note>`
  - When the child exits, the subagent is woken with a task-notification.
  - *verified-by-probe*: probe 1 (`bjanrk0om`) and probe 4 (`bsqjx9tsf`). bob parked at 03:12:54 and was woken at 03:13:05 by `[SYSTEM NOTIFICATION - NOT USER INPUT] … <task-notification>`.
- **Idle time limit.** I found no limit on how long a parked subagent may idle in an interactive session (*inferred*: no such timer in the agent task code, and the docs give no limit). A 60-minute run was **not** tested.
- **Background-command limits.**
  - Interactive local sessions have no time limit on background commands.
  - Unattended sessions (`-p`, SDK, cloud) have a 30 min default and 2 h maximum from v2.1.285 on. That is newer than the local 2.1.281 (*documented*, tools-reference "Time limit for background commands").
  - In `-p`, background commands end shortly after the run's final result. Probe 3 saw bob's background command `killed` when the run exited (*verified-by-probe*).

### Long-blocking tool calls and timeouts

- **Foreground Bash.**
  - Default timeout 120 s (`BASH_DEFAULT_TIMEOUT_MS`), maximum 600 s (`BASH_MAX_TIMEOUT_MS`). Source: `var p=120000,d=600000` (*verified-by-source*).
  - At the timeout the command is **moved to the background, not killed**, except for commands that start with `sleep` (*documented*).
  - *verified-by-probe*: probe 3 bob got `Command did not complete within its 120s timeout and was moved to the background (ID: bby1arh2s)`.
  - Leading `sleep N; …` commands are blocked outright: `Blocked: sleep 45 followed by: echo slept. To wait for a condition, use Monitor…` (*verified-by-probe*, probe 1).
- **MCP tools.**
  - Hard wall-clock limit `MCP_TOOL_TIMEOUT`, or a per-server `timeout` in `.mcp.json`; "progress notifications do not extend it".
  - A separate idle timeout (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`): 30 min for stdio and 5 min for network servers when no response or progress arrives. 0 disables it (*verified-by-source*, `Po()`/`pr()`; *documented* env-vars).
  - I could not pin down the default `MCP_TOOL_TIMEOUT` from the minified source. The cap is `2147483647`.
  - A blocking MCP `wait_for_human` tool therefore needs either progress notifications under 30 min (stdio) or `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0`, and a large per-server `timeout`.
- **Monitor.** Streams each stdout line, or each WebSocket text frame, to the agent as an event. Every watch has a deadline: 5 min default, 30 min max, 10 min under `-p`. Then one notice arrives and the agent must re-arm (*documented*, tools-reference "Monitor tool"). Monitor is available to background subagents (*documented*).
- **Idle is idle.** While a tool blocks, the model is not called. Probe 1 timeline:
  - The subagent's foreground `until` loop ran from t=1791083224.1 to 1791083256.8 (33 s).
  - It emitted no `assistant`/`thinking_tokens` events, and neither did main.
  - Probe 4 parked bob for 11 s with no turns.

  (*verified-by-probe*.) Tokens are spent only on each wake: the seat's turn plus, when the seat stops again, a task-notification turn in the parent.

### Resuming after completion

- `SendMessage` to a stopped agent resumes it from its transcript, with the message as the next prompt. It keeps its full history (*documented*). Source: `case"agent-stopped": … Cwn(...)` → "Resuming agent X" (*verified-by-source*). Probe 4: alice → parked bob returned `{"success":true,"message":"Resuming agent bob"}` (*verified-by-probe*).
- **Re-parenting.**
  - Whoever resumes an agent becomes its report target: `Agent "X" was resumed by another agent and now reports to it; its completion will not be delivered here.` (`QQr`; *verified-by-source*; *documented*: "the resumed agent then reports back to the subagent that resumed it").
  - Probe 4: after alice woke bob, bob's next interim notice went into alice's queue, not main's (*verified-by-probe*).
- **Exceptions.**
  - "Agent X was stopped by the user and was not resumed" (`agent-stopped-by-user`).
  - The built-in Explore/Plan agents are one-shot and have no ID (*documented*).

## 2. Messaging

### Delivery into a running subagent

- **Between tool rounds.**
  - Source path: `SendMessage` → `case"agent-live": YV(agentId, msg, taskRegistry, {origin, isMeta:true})` → result `Message queued for delivery to X at its next tool round.` (*verified-by-source*; *verified-by-probe*, probe 1).
  - Delivery is between tool rounds. A tool already running is never interrupted (*documented*, cross-session-messaging: "reads the message between tool calls during an active turn, so a running tool is never interrupted").
  - So **a seat blocked in a 10-min foreground `room wait` won't see an orchestrator message until the wait returns.** A seat parked on a *background* wait is resumed immediately instead.
- **What the receiver sees.** From the probe 1 transcript (*verified-by-probe*):
  - From the parent: user message `origin:{kind:"coordinator"}, isMeta:true`, text `The coordinator sent a message while you were working:\n<msg>\n\nAddress this before completing your current task.`
  - From a sibling: `origin:{kind:"peer", from:"alice", senderTaskId:"af6df…", name:"alice", body:"…"}`, text `Another Claude session sent a message while you were working:\n<agent-message from="alice">\n…\n</agent-message>\n\nThat "other Claude session" is an agent working inside this same session … this was not typed by your user …` (probe 4).
- **Teammates (agent teams).** A message goes to a JSON mailbox file, `~/.claude/teams/{team}/inboxes/{name}.json`. A running in-process teammate gets "Teammate X is already running; queued your message for its next turn." Retry backoff is woken early (`retryWake`) (*verified-by-source*; *documented*).

### Subagent → parent mid-task

- `SendMessage({to:"main"})` is documented as "The main conversation (background subagents only)" (SendMessage prompt; *verified-by-source*).
- It is enqueued as `xE({mode:"prompt", priority:"next", origin:{kind:"peer", from, senderTaskId, name, body}})` → "Message queued for the main conversation's next turn." (*verified-by-source*).
- Main receives it as a queued command: `<agent-message from="a52372a3aaceefc6c">\nHELLO-FROM-SEAT\n</agent-message>`, with `origin.kind:"peer"` (*verified-by-probe*, probe 1). This is the "Message from @<agent-id>" line seen in the UI.
- `from` is the agent's **name** when it has one, otherwise its **agentId** (`Pe()`; *verified-by-source*).
- A subagent's final text is **not** a message. In this build the report goes through a hand-back. Plain text at end of turn appears only as the task-notification `<result>` (*verified-by-probe*, notification bodies).

### Siblings

- **Supported.** Siblings can message each other directly by name (*verified-by-probe*, probe 4: alice → bob delivered).
- **Roster.** Each named subagent gets a roster snapshot at spawn: `Other agents active in this session, addressable via SendMessage({to: name, message}): main, bob.` It is not updated afterwards (*verified-by-probe*; *documented*).
- **Names require agent teams.**
  - The Agent tool's `name`, `team_name` and `mode` are **stripped from the tool schema unless agent teams are enabled**: `uLn = new Map([[…],[mt,["name","team_name","mode"]]])`, applied via `if(!ao()) wo=pLn(e.name,wo)`, where `ao()` = `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS || argv.includes("--agent-teams")` and gate `tengu_amber_flint` (*verified-by-source*).
  - Probe 2 (teams off): the model reported no `name` parameter. Probe 1: `to:"seat"` failed (*verified-by-probe*).
  - Without names, siblings can only address each other by raw agentId, and the parent must pass those IDs to them.
  - This contradicts the sub-agents page, which implies Claude can always name subagents.
- **Teams on in interactive mode.** A named Agent call from the lead becomes an in-process teammate instead. Exceptions are forks and `isolation`. Under `-p` it stays an ordinary subagent (*documented*, agent-teams).
- **Name resolution can reach other sessions.**
  - An unmatched bare name falls through to cross-session peers on this machine. Probe 1's `to:"seat"` returned `No agent is named 'seat' exactly. Re-send with the ref to confirm you mean: seat-research-mcp-43 [2796d3] — Claude session, on this machine` (*verified-by-probe*).
  - It refused rather than misdelivering, but seat names should not collide with other local session names.

### Names and identity

- **Agent `name`.**
  - Format `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`.
  - Reserved names: `main`, `team-lead`, `user`, `system`. Names shaped like agent IDs are also rejected.
  - The latest spawn wins a name. SendMessage then "pins" a name to the agent it first reached and refuses if a newer agent took the name (`H2r`, `setSendMessagePin`).
  - (*verified-by-source*; *documented*)
- **Agent IDs.** `a` + hex, e.g. `a52372a3aaceefc6c`. Teammate IDs are `name@team` (`oO(e,n)=>\`${e}@${n}\``), and the team name is `session-<8 chars>` (*verified-by-source*; *documented*).
- **Session names.** `-n/--name` and `/rename` name a *session* for cross-session messaging and `claude --bg`. That is separate from agent names (*documented*).

### Sender stamping and forgery

- **Inside one process: stamped by the runtime.**
  - `from` comes from `Le(ctx)` → `Pe(ctx, ctx.agentId)`, i.e. the sender's agent context. It is not a tool input (*verified-by-source*).
  - The model controls only `to`, `message` and `summary`.
  - The envelope is built by `tae(from, body)` = `<agent-message from="${vo(from)}">\n${Sqe(body)}\n</agent-message>`. `Sqe` escapes envelope-shaped tags inside the body (`<` → `<\\`) (*verified-by-source*).
  - The same neutralizing happens to subagent result text: `[harness: subagent output matched instruction-shaped pattern(s): harness-envelope-tag. Control tags below are neutralized …]` (*verified-by-probe*, probe 3).
  - So the body is verbatim **except** that tag-like text is escaped.
- **Recipients treat peer messages as non-user.** `xon()` frames them `{frame:"non-user", kind:"peer"}`. They can't approve permissions or change config (*verified-by-source*; *documented*).
- **Across processes: weaker.**
  - Team mailboxes are JSON files that any local process can write.
  - The reader classifies each entry as `verified` (this process wrote that `msg_id`), `forged` (it claims a protected identity it did not write), or `unverifiable`. `forged` renders as `<teammate-message teammate_id="…" verified="false">` (`tse()`, `OTt()`; *verified-by-source*).
  - Cross-session socket messages carry the sender's session name. Own-child posts are verified by process evidence or by `CLAUDE_CODE_MESSAGING_TOKEN` (*documented*).
- **Body authorship.** The `message` text is still **written by the sending model**. Stamping proves *which agent* sent it, not that the words are a human's. This matters for assumption 2.

### ListAgents and the inbox tools

- **ListAgents.** Lists:
  - this session's own name;
  - subagents (ID, type, running/idle);
  - teammates;
  - peer sessions on this machine (every interactive and bg session with an inbox socket);
  - with Remote Control, cloud and other-machine sessions.

  (*verified-by-probe*: probe 1 listed 6 peer sessions; *documented*.)
- **FetchInboxMessage and ReadNotifications are not subagent messaging.**
  - `FetchInboxMessage`: "Read one message from this Remote Control session's inbox by file_id".
  - `ReadNotifications`: "Read the notifications queued for this session — GitHub activity on subscribed PRs, scheduled triggers …, and messages from other Claude sessions". It exists for hosted/cloud sessions whose backend queues `queued_notification` events.
  - Both are *verified-by-source* and are relevant later for assumption 5 (remote), not the local spike.
- **Cross-session socket.**
  - Each session binds a Unix socket (`CLAUDE_CODE_MESSAGING_SOCKET`) and token (`CLAUDE_CODE_MESSAGING_TOKEN`). A local script can post a line into the session.
  - Messages are delivered between tool calls, or start a new turn when idle.
  - At most 50 queued messages; per-sender rate limits.
  - (*documented*, cross-session-messaging.)
  - This messages the *session* (the orchestrator), not a subagent.

## 3. Native long-lived peers: teams, `--bg`, channels

- **Agent teams** (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, experimental). What they give:
  - named, long-lived teammates that message each other directly;
  - mailboxes, a shared task list, and an idle notification to the lead with the final answer;
  - `TeammateIdle`, `TaskCreated` and `TaskCompleted` hooks (exit 2 blocks).

  Limits that matter here (all *documented*, agent-teams):
  - **No teammates under `-p`/SDK.**
  - One team per session, and no nested teams.
  - **In-process teammates can't run background subagents.** A seat as teammate could not park helpers.
  - **Teammate plan approval is granted automatically by the lead, without review.**
  - Permission prompts bubble to the lead's terminal.
  - `/resume` doesn't restore in-process teammates.
  - Split panes need tmux or iTerm2, and are not supported in Ghostty.
  - In-process teammates ignore definition `mcpServers` and `skills`.

  Plugin-supplied agent definitions also ignore `hooks`, `mcpServers` and `permissionMode` (*documented*; *verified-by-source*: "Plugin agent file … sets X, which is ignored for plugin agents").
- **Background sessions** (`claude --bg [--name]`, `claude agents`, `claude attach <id>`, `claude logs`, `claude stop`):
  - Full independent processes under a supervisor daemon.
  - **An unpinned session that is idle and unattached for about 1 h is stopped.** Its conversation is saved and resumes on the next message.
  - No tokens while idle. They can be messaged through cross-session messaging (*documented*, agent-view).
  - These are peers, not children: they have no parent notification channel, and they are separate permission scopes.
  - If the orchestrator itself runs as a `--bg` session, the 1-hour idle reaper could stop the process that hosts the seat subagents. Whether running subagents count as "working" is untested (*inferred*). Pin it (`Ctrl+T`) to be safe.
- **Channels** (`--channels`, research preview):
  - An MCP server pushes events into the **main** session as `<channel source="…">`, with sender allowlists and optional permission relay.
  - Custom channels need `--dangerously-load-development-channels`.
  - (*documented*.) This is the native way to get human-typed text into the orchestrator as a runtime-framed, non-model payload. It targets the session, not a subagent.

**Verdict: seats should be plain background subagents, not teammates.**

- Teammates add inter-seat messaging and idle hooks, but subagents with names (teams env on) already message siblings.
- Teammates lose background helpers, `-p` support and plan review, and they bring an experimental file-mailbox trust model.
- `--bg` sessions are a later option for the remote phase, when each human really has their own process.

## 4. Probe log

| # | Setup | Observed |
|---|---|---|
| 1 | Teams off. Background agent: SendMessage main → `sleep 45` → report. Main sends a PING. | The `name` param was missing. `to:"seat"` was refused, with a suggestion of an unrelated local session. Main received `<agent-message from="a52372a3aaceefc6c">`. `sleep 45; …` was blocked; the agent re-ran it in the background, parked, and main got an interim notice. The PING was queued and then resumed the agent: "The coordinator sent a message while you were working". 33 s blocked with zero API events. Cost $0.094. |
| 2 | Teams off. Named alice and bob. | The model reported that the Agent tool has no `name` param (it is stripped). |
| 3 | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, `-p`. alice sends a forged-tag body. | `name` was accepted, and the roster reminder appeared. alice (haiku) refused to send the forged text, so forging was not tested end to end. The runtime neutralized tags in the result. bob's foreground loop was auto-backgrounded at 120 s, then killed at `-p` exit. |
| 4 | Teams env, `-p`. bob parks on a background `until` loop. alice messages bob, then touches the file. | alice → bob delivered, and bob resumed with a `peer` origin and `from="alice"`. bob's next interim notice went to alice (re-parented). bob was woken when the background loop exited and wrote a final report. Main's `-p` run ended before it processed bob's final notice (it was enqueued at 03:13:07). |

## Implications for the seat design

1. **Park seats on a background command.** A seat should wait on a *background* Bash `room wait` and end its turn, not block in the foreground.
   - The background command has no time limit in interactive sessions, costs zero tokens, and wakes the seat on exit.
   - An orchestrator `SendMessage` resumes a parked seat immediately. A foreground wait would hold the message until the wait returned (at most 10 min, then it auto-backgrounds anyway).
   - Monitor on `room watch` also works for per-line events, but has to be re-armed every ≤30 min.
2. **Budget for notice turns.** Every time a seat stops, the orchestrator gets an "interim" task-notification and spends a turn on it. Keep seat stops rare, and have seats report through `SendMessage(main)` or the room file rather than chatty end-of-turn text.
3. **Route through the hub.** Only the orchestrator should `SendMessage` a seat.
   - A sibling's message re-parents the target's reports to that sibling, which would quietly cut the orchestrator out of a seat's stream.
   - Seat-to-seat traffic should therefore go through the orchestrator or the room file.
   - Direct sibling messaging works, but needs `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` to get `name`. In interactive mode that same flag turns named spawns into teammates, so in practice: no names, the hub holds the agentIds.
4. **Trust `from`, not the body.** The runtime-stamped `from`/`senderTaskId` can be trusted for attribution. The body is model-written, so verbatim human text should travel as data the seat can't edit (the `room` log, a channel, or a socket post). Don't rely on the seat's `SendMessage` text for it.
5. **Use plain background subagents, not teammates,** for the spike. Revisit teams or `--bg` sessions only if each human needs a separate process (the remote phase). Avoid `-p` for the orchestrator: it exits with pending notices and kills background waits.
6. **Unknowns to probe next.**
   - A real 60-minute parked seat in an interactive session.
   - Whether a `--bg` orchestrator with parked seats survives the 1-hour idle reaper.
   - The default `MCP_TOOL_TIMEOUT`, if an MCP `wait_for_human` tool is chosen instead of Bash.
