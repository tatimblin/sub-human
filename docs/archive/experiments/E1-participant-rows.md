# E1 · Participant rows built from proxy subagents

Claude Code 2.1.281. Prototype: `/tmp/exp-1/plugin`, `SUB_HUMAN_HOME=/tmp/exp-1/home`. Room `weasel-9298`. Three
interactive sessions ran in tmux (`e1-orch` on Opus 5.5, `e1-alice` and `e1-bob` on Haiku 4.5) from 19:11 to 19:41,
about 30 minutes. The log reached 52 entries: 3 plan revisions plus one more after a leave and a rejoin, 1 objection,
4 sign-offs, 2 decisions, a leave and a rejoin, and a `/clear`. Everything has since been killed, and the 4 plan files
the run wrote to `~/.claude/plans/` were deleted.

Labels: **[probe]** verified-by-probe, **[source]** verified-by-source, **[inferred]**.

## 1. Setup (diff against `plugin/sub-human`)

| File | Change |
|---|---|
| `agents/participant.md` (new) | Haiku, `background: true`, `color: cyan`, `tools: mcp__plugin_sub-human_room__watch`. Loop: `watch({member})`, write no text, end with `left` on `STOP:`. |
| `mcp/room-server.js` | `watch` takes an optional `member`. Its thread is the entries where `from === member \|\| to === member`, with a per-row cursor `feed-<me>-for-<member>`. The first call replays at most 15 thread entries. It returns `STOP:` when the member leaves or is unknown. While blocked it writes a heartbeat to `members/<me>/watching/<member>.json` every 15 s, holding `{at, server pid}`. |
| `hooks/proxy.js` (new) | **PreToolUse(Agent)** for `sub-human:participant` maps `description` to a roster name. It refuses self, unknown, left or duplicate participants; a duplicate means a fresh heartbeat whose server pid is alive. It rewrites `description`/`name`/`prompt` to the canonical name and queues it. **PostToolUse(Agent)** records `agentId → name` from the `async_launched` response. **SubagentStart** pops the queue for the brief's mapping. **SubagentStop** blocks while both seats are in the room (cap 50). **Presence** goes to `presence/<name>.json` beside the log: busy on PreToolUse or UserPromptSubmit (main thread only, `@room` excluded), idle on Stop, `? prompt` on Notification(permission_prompt), gone on SessionEnd. SessionEnd also retires the seat's proxies. Every payload is logged to `hooklog.jsonl`. |
| `hooks/guard.js` | `watch` from `sub-human:participant` is allowed with `updatedInput: {member: map[agent_id]}`, so the model's argument is ignored. The hook also **relays text typed into a row** (§6). |
| `hooks/launcher.js` (new) + `settings.json` (new) | SessionStart writes `${SUB_HUMAN_HOME:-~/.sub-human}/bin/agent-statusline` (`exec node <root>/bin/sub-human agent-statusline`). The plugin `settings.json` sets `subagentStatusLine` to `"${SUB_HUMAN_HOME:-$HOME/.sub-human}/bin/agent-statusline"`. That path is keyed on the room home, not the plugin install id, so `--plugin-dir` and marketplace installs share it (unlike 08's DATA path). |
| `bin/sub-human agent-statusline` | Builds participant rows from `proxies.json` (by task id), falling back to `description`. Output is deterministic from the log, `members.json` and presence (§2). The old room-feed row still works. |
| `hooks/common.js` `contextBlock` | Adds a `PARTICIPANT ROWS` section to the join and restore context: one exact `Agent({subagent_type:"sub-human:participant", description:"X", prompt:"X", run_in_background:true})` line per other active participant. |
| `member.md`, `orchestrator.md` | The room-feed spawn is replaced by the PARTICIPANT ROWS calls. `member_joined NAME` spawns NAME's row; `member_left` does nothing, because the row stops itself. |
| `hooks/hooks.json` | Registers `proxy.js` on PreToolUse `*`, PostToolUse `Agent\|Task`, SubagentStart, SubagentStop, UserPromptSubmit, Stop, SessionEnd and Notification, and `launcher.js` on SessionStart. |

The existing tests (95 + 56) still pass on the copy.

## 2. Results

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | Every row appears in every session and persists | **Pass**, with one Haiku miss on rejoin | **[probe]** All 6 rows were up within 30 s of the joins at 19:12–19:13 (e.g. alice: `◯ orch · ⬡ weasel-9298 · idle · converging` / `◯ bob · idle`). The same agent ids stayed up for the whole run: orch's `alice` row `a8eb8402…` ran 02:12–02:40. **No proxy ever stopped on its own**: the SubagentStop `block` fired 0 times, and the 50-min watch never timed out because entries kept arriving. Rows survived `/clear` (alice, 19:30): the same agent ids carried on, and their transcripts continued under the new session dir. **When a participant leaves, the row is removed**: after bob's `/exit` (#36), alice's `bob` row was gone at once and orch's showed `◯ bob · left · #36 member_left` for about 15 s before disappearing. Both sessions got exactly one `Agent "bob" finished` notification. When bob rejoined (#41), orch and alice each spawned a new bob row by themselves. **Miss:** bob's own session needed a human nudge to respawn its rows (see 7). |
| 2 | Row text is correct and updates | **Pass** | **[probe]** Rows refresh every 5 s; the input was logged 311–354 times per session. The row tracked each phase. **Converging:** `◯ alice · ● busy · #3 say 35s`, `◯ bob · idle · ✉ 1 waiting`. **Plan, from a member's view:** `◯ orch · ⬡ weasel-9298 · idle · plan 201aa2 0/2 · ✖ 1 objection · waiting on alice,bob · #13 question 2s` and `◯ bob · idle · ✖ objected 201aa2 · #12 objection 7s`. **Mid-sign-off:** `plan 593da0 1/2 · waiting on bob` and `◯ alice · idle · ✓ signed 593da0`. **During a permission prompt:** `◯ alice · ? prompt · ✓ signed 593da0`. **Decided:** `◯ orch · ⬡ weasel-9298 · idle · ✔ decided 7ae9e4 · #52 status 26s`. I fixed two bugs mid-run. First, an `@room` post marked the seat busy but no Stop followed; `@room` prompts are now excluded. Second, the "last" segment showed `member_left` after a rejoin. "Drafting plan" (orch in plan mode with no plan yet) rendered only briefly, because Opus drafted in under 20 s. |
| 3 | Entering a row shows the thread; `main` goes back | **Pass, but the default view hides the content** | **[probe]** Keys: `↓` focuses the footer, `↓` selects `main`, `↓` moves to a row, `Enter` opens it. The header changes to `@orch`, the prompt to `Message @orch…`, and the row gets `⏺`. **The default view shows only `Calling plugin:sub-human:room 6 times · 18s…`.** After `ctrl+o` you get the thread: `#27 02:26 orch · say · → alice` / `alice, fetch.js drifts from #23 item 5 …`, `#30 02:29 alice · say` / `fixed the 4xx drift …`, `#48 02:40 alice · signoff · plan 7ae9e4`. Then `ctrl+o`, `↓↓`, `Enter` on `main` and `Esc` returns to your own conversation. The spinner in a row view reads `✻ Galloping… (11m 46s · ↓ 6.6k tokens)`, which is the proxy's endless turn. |
| 4 | No interim notifications for the orchestrator or members | **Pass** | **[probe]** The orch transcript has 15 `<task-notification>` user turns. 14 are Monitor events, and **1** is `Agent "bob" finished` when bob left. Alice's has the same pattern, with 1 from a proxy. No proxy notified while its participant was present. |
| 5 | Tokens and cost | **Measured.** About $0.0023 per proxy turn by transcript, about $0.0054 including hidden summary forks. | See §2a. |
| 6 | Typing into a row's view | **No hook fires. A deterministic relay works, but late.** | See §2b. |
| 7 | `/clear` and `--resume` | `/clear` **passes**. `--resume` **loses the rows**. | **[probe]** `/clear`: rows and their agents survive, `session-restore` rebinds, and the next turn did not respawn (no duplicates). `--resume` after `/exit` gives `⏺ 2 background agents didn't finish before the previous session ended: "orch" (a53abcbf…), "alice" (a9927b0e…)`, and no rows come back. The seat had left (`member_left`), so `/sub-human bob CODE` is needed. On that rejoin, the first spawn was **refused by my dedupe** because the old heartbeat was 83 s old (< 90 s); fixed by also checking that the server pid is alive. The re-run join then got **no spawn from Haiku at all** ("Standing by…") until I typed "spawn them as the PARTICIPANT ROWS section says". The wording of the hook context is not enough on its own to get spawning from Haiku. |

### 2a. Cost

Proxy transcripts (`~/.claude/projects/…/subagents/agent-*.jsonl`): 12 proxy instances made **129 API requests**,
which delivered **138 entry-deliveries for 52 room entries**. The 1.5 s coalescing sometimes batched 2–3 entries.
So each proxy took **at most one turn per entry in its thread**, and **0 turns while idle** **[probe]**.

| Item | Number |
|---|---|
| Proxy context per turn | 4–8 k tokens, almost all cache reads after the first turn (e.g. alice row in orch: 17 requests, 92 k cache read, 8.3 k cache write) |
| Proxy turns, Haiku list price | $0.294 total, **$0.0023 per turn** **[probe]** (transcript `output_tokens` undercount, so this is a lower bound) |
| **Hidden AgentSummary forks** | Claude Code regenerates every background agent's panel `label` with a forked model call when its transcript changes. These are the `[AgentSummary] Timer fired … / Forking for summary` strings **[source]**, roughly on a 30 s timer. We saw this as 155 SubagentStop events with empty `agent_type` (orch 40, alice 39+27, bob 49), and as the `label` field changing about once per proxy turn ("Watching bob's plan review" → "Reading bob's plan objection" …) **[probe]**. Our row text replaces that label, so **these calls are pure waste**. |
| All-in Haiku per proxy turn | Orch's main loop is Opus, so its Haiku bill is only its 2 proxies plus their summaries: **$0.2218** in `/cost`, against $0.057 in proxy transcripts. Summaries cost about 3× the proxies. **≈ $0.0054 per entry per proxy, all in.** **[probe]** |
| Room of 3, 52 entries, 30 min | ≈ 129 × $0.0054 ≈ **$0.70**, about **$0.013 per room entry**, plus one main-loop turn per session per leave. |
| Room of 5 (projection) | There are N(N−1) = 20 rows. An addressed entry A→B lands in 2(N−1) rows and a broadcast in N−1; our mix measured 2.65 at N=3, so ≈ 5.3 at N=5. That gives ≈ **$0.029 per entry**, or ≈ **$1.5 per 52 entries** **[inferred]**. Cost grows with N², and the summary forks are most of it. |
| Session totals (`/cost`) | orch $1.94 (Opus $1.72); bob $1.75; alice $0.57 after `/clear`. **$0.95 of bob's bill was `claude-sonnet-5`**: during an API outage at 02:19 (`Waiting for API response · will retry`), the Haiku session and its proxies fell back to Sonnet (24 Sonnet messages in bob's main transcript, 5 in its orch proxy) **[probe]**. Proxies can be repriced without warning. |

### 2b. Typing into a row's view (criterion 6)

- **No hook sees it.** UserPromptSubmit does not fire for text submitted at `Message @bob…` **[probe]**: no hook event
  between 02:21:28 and the next proxy round. That includes `@room …`, so **an `@room` typed in a row view is not
  posted.** It goes to the proxy. bob did this by accident while still in the `@orch` view.
- **Delivery is deferred.** The text sits in memory until the proxy's current tool call returns. For a proxy that
  means the next entry in that participant's thread, which can be up to 50 minutes away. It then appears in the
  agent transcript as
  `{"type":"attachment","attachment":{"type":"queued_command","prompt":"bob, can you also check the per-attempt timeout?","origin":{"kind":"human"}}}`
  with the reminder "The user sent a new message while you were working" **[probe]**. Haiku ignored it, as its
  prompt says, and called `watch` again.
- **Deterministic relay (built and tested).** The proxy's next `watch` call is the round on which the text is
  delivered. PreToolUse(watch) in `guard.js` reads `<transcript dir>/<sid>/subagents/agent-<agent_id>.jsonl` and,
  for each new `queued_command` with `origin.kind == "human"`, appends a room entry with no model in the loop:
  - plain text → `say to=<row's participant> via=agent from=<me>`, which renders as "alice's Claude";
  - `@room X` / `room: X` → `say via=human from=<me>`, the same as the `@room` hook.

  Results **[probe]**:

  | Typed | Into | Became | Latency |
  |---|---|---|---|
  | `bob, can you also check the per-attempt timeout?` | alice → `bob` row | `#24 alice[agent] say to=bob` | 3 min (it was typed before the relay existed and posted on the next round) |
  | `orch: please ping me when alice posts her done status` | bob → `orch` row | `#28 bob[agent] say to=orch` | **96 s**; orch answered it in #29 |
  | `@room I'll review fetch.js once alice fixes the 4xx drift` | bob → `orch` row | `#32 bob[human] say` | **~2 min**, and it landed **after** #30/#31 had already made it stale |

- **What's possible.**
  - Posting can be deterministic: no model decides, and the hook copies bytes from a harness-written attachment.
  - Delivery time is set by the proxy's tool round, which nothing outside can force.
  - Faster relay needs `watch` to return on a short timer, e.g. 30–60 s. That costs one Haiku turn plus one summary
    fork per tick per row: about $0.3/h per row at 60 s, or about $6/h for a room of 5 **[inferred]**.
  - Whether `origin.kind:"human"` can be produced by the parent model (via SendMessage to the proxy) was **not
    probed**. Until it is, the `via=human` branch should stay off. Post row-typed text only as `via=agent`, or
    refuse `@room` there.

## 3. UX notes

- **The rows are the win.** Glancing at `↓` in any session gives everyone's state in one line each, and it reads
  correctly through converge, plan, object, revise, sign and decide. Presence (`● busy`, `? prompt`) is useful: it
  showed alice stuck on a permission prompt from bob's and orch's sessions.
- **Opening a row is disappointing until you know `ctrl+o`.** The default transcript collapses the thread to
  "Calling plugin:sub-human:room N times". In verbose mode it reads well, with an id, time, author ("alice's
  Claude" vs "alice"), kind, addressee and text. The spinner "Galloping… (11m 46s · ↓ 6.6k tokens)" on a mirror
  row looks like work in progress.
- **The row view's prompt is a trap.** "Message @orch…" invites typing. Plain text is relayed late, and `@room`
  doesn't post. After entering a row, people forget they are still in it: bob's next `@room` went to the orch proxy.
- **Keyboard path:** `↓` (footer), `↓` (`main`), `↓…` (row), `Enter`, then `Esc` to type. Getting back takes the
  same walk to `main` plus `Enter`. It is not discoverable.
- **The panel label.** The text Claude Code shows in other places (e.g. `/tasks`) is the AgentSummary label ("Polling
  orch room thread", "Recording alice's signoff on 7ae9e4"). It is model-written and sometimes wrong, and we pay for
  it.
- **Footer:** members' windows showed "Waiting for 2 background agents to finish" after every turn, plus a stray
  `← 1 agent` pill.
- **Haiku compliance:** proxies were perfect over 129 turns (no text, always `watch`). The *main* Haiku session was
  not: it skipped the spawn on a re-join.

## 4. Recommendation: **adapt**

Adopt the rows; drop the idea that the row view is a channel; and pay attention to the summary-fork cost.

Exact changes for the real plugin:

1. **Keep the status-row machinery.** Make these changes in the real plugin:
   - add `agents/participant.md` (Haiku, background, `watch`-only);
   - add `watch({member})` with the thread filter and the per-row cursor;
   - add the `participantRow()` renderer in `bin/sub-human agent-statusline`;
   - add the plugin `settings.json` with `subagentStatusLine` → `"${SUB_HUMAN_HOME:-$HOME/.sub-human}/bin/agent-statusline"`, plus the SessionStart `launcher.js`. This launcher path beats 08's DATA path: it is independent of the install id.
2. **Identity:** map `agentId → participant` in **PostToolUse(Agent)** (`tool_response.agentId` plus the canonical `description`). Don't use SubagentStart:
   - in alice's session, PostToolUse arrived *before* SubagentStart;
   - SubagentStart has no description, so a FIFO is unsafe with parallel spawns;
   - the two hooks raced on `proxies.json`; take a lock.

   Also rewrite the spawn input in PreToolUse(Agent) (`updatedInput` worked), and pin the member in PreToolUse(watch) from `agent_id`. The hook input carries `agent_id`/`agent_type` there.
3. **Dedupe by liveness, not by records:** use the heartbeat file written by the blocked `watch`, *and* check that the server pid is alive. Retire a seat's proxies in SessionEnd.
4. **Presence file:** keep `presence/<name>.json`, fed by PreToolUse/UserPromptSubmit/Stop/Notification, out of the log. Skip `@room` prompts.
5. **The SubagentStop block is cheap insurance.** It never fired here (0 blocks in 30 min), because `watch` doesn't return without entries. Keep it, with a cap.
6. **Respawn on rejoin and resume needs more than context text.** Haiku dropped it once. Either:
   - add a `context: fork` skill `/sub-human:rows` the human can run, or
   - have the monitor print a `rows missing: orch, alice` notice when the seat has no fresh heartbeat for a present participant.

   The first `/sub-human` after `--resume` must restore rows; resume never does.
7. **Row view:** treat it as read-only.
   - Make the participant prompt say so.
   - Keep the deterministic relay **only as `via=agent`** ("alice's Claude → bob"), and document the latency.
   - Don't map `@room` typed there to `via=human` until a probe shows the parent model can't produce `origin.kind:"human"`. Instead, have the relay post an `✗ not posted: use @room from main` status.
8. **Cost:** budget **≈ $0.013 per entry for a room of 3 and ≈ $0.03 for 5**. Two thirds of that is Claude Code's AgentSummary forks, which re-label rows we already overwrite. Find or request a switch that disables agent summaries for agents that have a `subagentStatusLine` override; the `[AgentSummary]` timer has no setting I could find. Alternatively, run rows only in sessions that want them (e.g. the orchestrator plus opt-in members).
9. **Readable thread by default:** consider a variant where the proxy echoes each result as its own short text, so the thread shows without `ctrl+o`. This costs output tokens and risks paraphrase, so test it before adopting.
