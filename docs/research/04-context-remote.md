# 04: Context growth and the path to remote

Covers assumptions 4 (the orchestrator sees all traffic, and compaction preserves the decision log) and 5 (a cloud session can load a custom plugin and connect out to a relay).

Source: Claude Code 2.1.281, a Mach-O binary with embedded minified JS (`/opt/homebrew/Caskroom/claude-code@latest/2.1.281/claude`). Identifiers below are minified names from that bundle. Docs were fetched 2026-10-03 from code.claude.com/docs. Probe scratch is in `/tmp/seat-research-context/`.

Labels: **[src]** verified-by-source, **[probe]** verified-by-probe, **[doc]** documented, **[inf]** inferred.

---

## 1. Compaction

### When it fires

- **[src]** The threshold is computed in two steps:
  - Effective window = resolved window minus `min(maxOutputTokens(model), 20000)` (`XV`, `Vlt=20000`).
  - Auto-compact threshold = effective window minus 13,000 (`GX`: `let r=e-13000`). `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` can only lower it: `Math.min(floor(e*pct/100), r)`.
  - A warning shows at threshold − 20k. A hard block applies at effective window − 3k (`Cke`).
- **[src]** The window is resolved by `GC` in this order of precedence: `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env, then the `autoCompactWindow` setting or `/autocompact`, then clientdata, then experiment, then the model default. `--autocompact <auto|tokens>` accepts 100k–1M (`"Auto-compact window size (auto, or 100k–1M tokens)"`). It is always clamped to the model's real window.
- **[doc]** With a native 1M model (e.g. `opus-5-5[1m]`), compaction fires at about 967K. That matches the source: 1M − 20k − 13k. With a 200K window it fires at about 167K. Cloud sessions set `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` themselves and you can't override it, so they compact "partway through" the window (code.claude.com/docs/en/claude-code-on-the-web#manage-context, /model-config#default-auto-compact-thresholds).
- **[src]** There are two circuit breakers:
  - `"Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row"`. This matters if a seat dumps big payloads into the orchestrator.
  - A consecutive-failure breaker.
- **[doc]** Subagents auto-compact with the same logic, and the override applies to them too. Their compactions are logged in their own transcript (sub-agents#auto-compaction).

### Hooks around compaction

| Hook | What it can do | Evidence |
|---|---|---|
| `PreCompact` (matcher `manual`/`auto`) | Block compaction (exit 2 or `decision:"block"`). **Its plain stdout is appended to the summarizer's custom instructions.** `systemMessage` and `continue` are discarded. | **[src]** `Jde`: successful hook stdout → `newCustomInstructions`, merged via `Ije(h, Fe.newCustomInstructions)` into the summary request. **[doc]** hooks#precompact documents blocking only. |
| `PostCompact` | Receives `compact_summary`. Its output is shown to the user only, not to the model. | **[src]** `JQe` returns only `userDisplayMessage`. **[doc]** hooks#postcompact |
| `SessionStart` with matcher `compact` | Runs right after compaction. **Its stdout or `additionalContext` is added verbatim to the post-compact context.** | **[src]** `Vte` calls `o3(n.session,"compact",…)` and returns `hookResults`. **[doc]** hooks-guide#re-inject-context-after-compaction |

- **[doc]** Hook `additionalContext` and plain stdout are capped at **10,000 characters**. Anything longer is saved to a file and replaced by its path plus a 2,000-char preview. The cap can't be raised (hooks.md, "capped at 10,000 characters").
- **[src]** Both the PreCompact custom-instruction path and the SessionStart(`compact`) path are skipped when `Es(agentContext)` is true. In the bundle that predicate is `agentType==="subagent"&&delegatedObservation===!0`, which looks like a narrow internal agent kind. **[inf]** Ordinary subagents (seats) probably still run these hooks, but a probe should confirm it before seats rely on it.

### What survives compaction

Post-compact context is assembled in `Vte` **[src]**, which matches the docs table at context-window#what-survives-compaction **[doc]**:

| Item | After compaction |
|---|---|
| System prompt, output style | Still apply (they live outside message history) |
| Project-root CLAUDE.md, unscoped `.claude/rules/`, auto memory | Re-read from disk and re-injected |
| Nested CLAUDE.md, `paths:` rules | Summarized away; they reload only when a matching file is read again |
| Plan file (plan mode) | Re-injected as a `plan_file_reference` attachment (`Wco`) |
| Recent files | Up to 5 re-read (`dxe=5`), at most 5k tokens each (`cxe`) and 50k total (`Dco`) |
| Invoked skill bodies | Re-injected, at most 5k tokens per skill (`Lco`) and 25k total (`uxe`); the oldest are dropped first. **The skill listing is not re-injected.** |
| Running/finished background subagents | A `task_status` attachment per `local_agent` task with id, description, status, and progress summary or error (`zco`). **Seat agent IDs therefore survive compaction.** |
| Running background bash tasks | `task_status` per task (`qco`) |
| Peer messages queued but not yet consumed | Carried over (`Kco`: `queued_command` with `origin.kind==="peer"`) |
| Active goal (`/goal`) | Re-attached (`yxe`) |
| Tool, MCP, and agent listings | Re-announced |
| Context that hooks added earlier, all conversation text, and verbatim human words | **Summarized.** Verbatim fidelity is lost unless the words live on disk. |
| TaskCreate/Todo lists | **[inf]** Not in the survival table. The list is stored on disk, and periodic reminders (`turnsSinceLastTaskManagement`) re-surface it, but the model loses the in-conversation copy. |

**Can a hook make a decision log survive every compaction? Yes, with limits.** **[src]+[doc]**
1. Keep the decision log in a file that the channel writes (e.g. `demo/.room/decisions.md`), not the model.
2. A `SessionStart` hook with `matcher: "compact"` cats a **≤10,000-char digest**: signed-off decisions, open proposals with their signers, the seat roster with agent IDs, and a pointer to the full file. That digest goes into post-compact context verbatim.
3. A `PreCompact` hook prints summarizer instructions ("preserve seat names, agent IDs, proposal IDs, and who signed what; do not paraphrase quoted human text"). This only steers the summary; it does not guarantee anything.
4. Alternatives that are also re-injected: make the digest the plan file, or a skill the orchestrator has invoked (5k-token cap, truncated from the top). The root CLAUDE.md is also re-read from disk, but it's a poor fit for a log that changes constantly, and edits don't apply mid-session until something re-reads it (prompt-caching doc).

### Subagent transcripts and the parent's context

- **[doc]** Each subagent has its own context window and transcript file at `~/.claude/projects/<proj>/<session>/subagents/agent-<id>.jsonl`. "When the main conversation compacts, subagent transcripts are unaffected" (sub-agents#resume-subagents).
- **[probe]** A haiku parent spawned a general-purpose subagent, which read a 400-line file. The subagent used 18,492 tokens and its transcript is 136 KB. The parent transcript gained only:
  - The Agent tool result: a launch stub of about 1.1 KB (`"Async agent launched successfully… agentId: …"`). Agents launched in `-p` ran async by default.
  - One `<task-notification>` of about 0.9 KB, holding task-id, tool-use-id, output-file, status, summary, note, `<result>` (the subagent's **final text only**), and usage.

  The parent does **not** see the subagent's intermediate messages or tool calls.
- **[src]** Mid-task messages from a subagent via `SendMessage` reach the parent as a queued prompt with `origin.kind:"peer"`, wrapped as `<agent-message from="…">body</agent-message>` (`tae`, `mMt="agent-message"`). The parent sees each message the seat chooses to send, and nothing else.

---

## 2. How seat traffic hits the orchestrator

Orchestrator context cost per event. Estimates use about 4 chars per token:

| Event | Fixed overhead | Plus |
|---|---|---|
| Seat `SendMessage` → orchestrator | ~30–60 tok (`<agent-message>` wrapper inside a system-reminder) | message body |
| Seat finishes (or stops) | ~230 tok (`<task-notification>`) | final result text |
| Orchestrator spawns or resumes a seat | ~280 tok launch stub, plus the prompt the orchestrator writes (often 200–1,000 tok) | — |
| **Orchestrator's own turn reacting to the message** | usually the larger cost: reasoning and reply text, plus a tool call (e.g. write to the log) and its result, ~200–800 tok | — |

**[inf]** Each seat message costs roughly **300–1,000 tokens of orchestrator context**, mostly the orchestrator's own reaction rather than the payload. Example: 4 seats sending one message a minute for an hour is 240 events, or about 70–240k tokens.
- On a 200K window (threshold about 167K, of which about 20–40K is baseline system prompt and tools), that is one or more compactions per hour.
- On a 1M window there's no compaction, but each turn re-reads the whole prefix. Cache reads keep that cheap per token, but the cumulative dollar cost grows roughly with the square of session length.
- **[doc]** Channels and peer messages that arrive while the orchestrator is busy are batched into its next turn (channels-reference#notification-format; cross-session-messaging: "queues at most 50 accepted messages"). Batching lowers the turn count but not the token count.

**Keeping the orchestrator lean:**
1. **The log is the source of truth, not the context.** The channel (`room` CLI or relay) writes human words verbatim to the append-only log with server-stamped identity. The orchestrator gets a **notice** (`seat=alice kind=objection id=p7#3 "…first 200 chars"`) and reads the full entry only when it needs it.
2. **Seats summarize; they don't forward transcripts.** A seat sends one `SendMessage` per meaningful event (proposal, objection, sign-off, work done + test result). Verbatim human text goes into the log by reference id, so it never has to pass through a model it could be edited by.
3. **The orchestrator writes the plan to a file** (plan file or `decisions.md`). It is the single writer, and the file is re-injected or digested after compaction (section 1).
4. **SessionStart(`compact`) digest of 10k chars or less**, regenerated by a script from the log rather than written by the model.
5. **Don't let seats do work in the orchestrator's context.** Seats and their helpers do the reading and building. Only results flow up.
6. **Optionally set `--autocompact` lower** (e.g. 300k on a 1M model) to bound per-turn cost. Make sure the digest hook is solid first.
7. **Avoid big tool outputs in the orchestrator** (e.g. `room read` of the whole log). Three large refills in a row trip the thrash breaker.

---

## 3. Remote

### Cloud sessions (`claude --cloud`, claude.ai/code)

| Question | Answer | Evidence |
|---|---|---|
| Custom plugin from the repo (`enabledPlugins`, `extraKnownMarketplaces`)? | **No.** "A cloud session doesn't install the plugins a repository turns on under `enabledPlugins`, including ones from the marketplaces it lists." Plugins enabled in user settings don't load either. | [doc] cloud-environments#what-carries-over-from-your-setup |
| Repo `.claude/` contents? | **Yes:** CLAUDE.md, `.claude/rules/`, `.claude/skills/`, `.claude/agents/`, `.claude/commands/`. In a single-repo session, also `.claude/settings.json` hooks and permissions, and `.mcp.json`. Skills enabled on claude.ai also load. | [doc] same table |
| Subagents | "Work the same way they do locally"; `.claude/agents/` is picked up. Agent teams need `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. | [doc] claude-code-on-the-web#manage-context |
| Background agents | Supported while the VM lives. "Background work that was still running when the VM was reclaimed, such as subagents and shell commands, isn't restored." | [doc] #environment-expired |
| Idle | "After a few minutes without activity, a session's VM pauses… a paused VM can later be reclaimed." | [doc] cloud-environments#time-limits |
| Outbound network | Levels are **None / Trusted (default) / Full / Custom**. Custom takes your own domain list with `*.` subdomain wildcards, optionally plus the defaults. All traffic goes through an HTTP/HTTPS security proxy. | [doc] cloud-environments#access-levels, #security-proxy |
| Paths that bypass the allowlist | The GitHub proxy, **MCP connectors (traffic goes through Anthropic's servers)**, API-credential hosts, and the Anthropic API | [doc] #access-levels |
| WebSockets through the proxy | Not documented | **[inf]** Plan for HTTPS long-poll or SSE. Verify WSS before relying on it. |
| CLI flags (e.g. `--channels`) | Can't be passed; the session is configured only through the environment's env vars and repo settings | [doc]/[inf] |
| Who joins | Sharing is a link to a snapshot: "their view doesn't update in real time" (Team visibility on Team/Enterprise; Public on Pro/Max). Teleport and follow-ups require the **same account**. | [doc] #share-sessions, #teleport-requirements |

**What this means for the plan:** ship the seat system as **repo `.claude/` files (skills, agents, hooks, `.mcp.json`)**, not a plugin, if it must run in the cloud. To reach the relay from the cloud there are two routes. Either add its domain under Custom network access and talk HTTPS from a skill or MCP stdio server, or expose the relay as a **remote MCP connector**, which takes the Anthropic-routed path and bypasses the allowlist. Long-lived waiting seats risk the idle pause and reclaim.

### Remote Control (`--remote-control`, `/remote-control`, `claude remote-control`)

- **[doc]** Drives a **local** session from claude.ai/code or the mobile app. The conversation and subagent progress stay in sync across all your connected devices. The local process makes "outbound HTTPS requests only and never opens inbound ports". Server mode (`claude remote-control --spawn same-dir|worktree|session`) serves several sessions from one process.
- **[doc]** It is **same-account**: "Auto-connect signs in with your own claude.ai account, so a session it starts appears only in your own account's Claude apps and grants no one else access." The organization can additionally require Trusted Devices. Requires claude.ai subscription auth; API keys aren't supported.
- **[doc]** It also carries **cross-session messaging** to your own sessions on other machines and in the cloud, through Anthropic servers (cross-session-messaging#message-sessions-on-other-machines). That is the native way for an orchestrator on one machine to talk to *your own* sessions elsewhere. It does not reach other people.

### `--bg`, `claude attach`, `claude agents`

- **[doc]** `claude --bg "<prompt>"` starts a session under a local **supervisor** process. `claude agents` is the agent view, a TUI listing sessions by state, with `--json` for scripts. `claude attach <id>` opens a session in a terminal. `claude logs|stop|rm`, `claude daemon status|stop` are also available. All of this is on one machine, for one user.
- **[doc]** A background session that is "finished or waiting for your next message, and unattached for about an hour" has its process stopped. The conversation stays on disk, and **pinning (`Ctrl+T`) keeps the process running**. An orchestrator run as `--bg` that idles waiting for humans should be pinned.
- **[doc]** Background sessions move into their own git worktree before editing. That suits per-seat work.

### Can a second person on a different account join a session?

**No built-in way.** **[doc]**
- Remote Control, teleport, and `--cloud -p <id>` follow-ups all require the same account.
- Shared cloud sessions are read-only snapshots.
- Projects: "A project belongs to one user. You can't share a project or its threads."
- Cross-session messaging reaches only your own sessions.

Nearest things:
- **Claude Tag** (Slack, Team/Enterprise only) lets anyone in a channel talk to one Claude session per thread, with Slack identity. But those humans don't get their own Claude Code seat; it's one shared agent in a sandbox **[doc]** claude.com/docs/claude-tag/overview.
- **Channels** (research preview) let an MCP server push `<channel source=… meta…>` events into a running **local** session, with a sender allowlist. Custom channels need `--dangerously-load-development-channels` **[doc]** channels, channels-reference.
- **[src]** The bundle has an undocumented "session inbox" with `sender_kind` (`rc_owner`, `slack_user`, third-party) wrapped as `<event source="session-inbox" … trust="relay" untrusted-keys="body,sender_display,…">`. Its own prompt says "the sender name is self-chosen and proves nothing about identity". It isn't a usable public surface, but it confirms that Anthropic treats relayed human text as untrusted, and attribution has to come from the channel.

---

## 4. What a multi-human relay must provide

Example: a Cloudflare Worker plus one Durable Object per room, using WebSockets with hibernation and SQLite storage, and OAuth.

1. **Identity the model can't forge.** OAuth (GitHub or Google) at connect time. The relay **stamps** `author` on every event from the authenticated socket and ignores any author field in the payload. This is the remote version of `$ROOM_USER`.
2. **Room membership and roles.** An invite or allowlist per room, with roles (human, orchestrator, observer). It also needs a per-connection token for the orchestrator's machine and for each seat's machine.
3. **An ordered, append-only log.** A monotonic `seq`, immutable entries, durable storage in DO SQLite, plus `read since=<seq>`, so any client, including a freshly compacted orchestrator, can rebuild state.
4. **Fan-out plus resumable delivery.** WebSocket push for human clients, with HTTPS long-poll or SSE as the fallback for agents. Long-poll is safest for the cloud proxy (WSS through it is unverified). Delivery is at-least-once with client-side dedup by `seq`.
5. **Server-enforced consent.** Proposals carry a **content hash**. A sign-off binds to `(proposal_id, hash, author)`. Any edit creates a new hash and voids earlier signatures. The relay answers "is plan X fully signed?" so the local `ExitPlanMode` hook asks the relay, not the model. `done` claims carry test evidence, as the `room done` command already requires.
6. **Verbatim payload by reference.** Human text is stored once and given an id. Agents pass ids around, and the orchestrator digest quotes from the log, not from model memory.
7. **Context-protecting ingress.** For the orchestrator, the relay should provide:
   - Short notices with ids rather than full bodies.
   - Server-side batching or coalescing.
   - Rate limits per sender.
   - A precomputed **digest endpoint** (≤10k chars) for the SessionStart(`compact`) hook.
8. **A way into Claude Code**, one of:
   - (a) A local stdio MCP server or channel that subscribes to the DO and pushes notices. Local only, and custom channels need the dev flag.
   - (b) A CLI or MCP tool the seat or orchestrator calls (`room wait` as a long-poll). Works local and cloud.
   - (c) A remote MCP connector, which works in the cloud through Anthropic's path.
9. **Where a remote human's "personal Claude" runs.** This is an architecture choice the relay must allow for:
   - **(A)** The seat subagent runs inside the orchestrator's process, on its machine and **account**. The remote human only has a thin client, so they can't read diffs locally and the work bills to the host.
   - **(B)** Each human runs their own Claude Code on their own account, as a peer connected to the relay, and the orchestrator is just another peer.

   Only (B) gives a remote human a real Claude Code session, which was the gap called out in CONTEXT.md. But then seats are relay peers, not native subagents of the orchestrator.
10. **Audit and secrets hygiene.** Keep a full event history, never relay credentials, and treat every relayed body as untrusted text in prompts.

---

## Constraints the design must respect

1. **The orchestrator's context isn't a log.** Everything in it except post-compact attachments gets summarized, so verbatim human words and sign-offs must live in a file or relay written by the channel. **[src]/[doc]**
2. **The only verbatim post-compact injection a hook can make is SessionStart(`compact`), capped at 10,000 chars.** PreCompact can only steer or block the summary. Keep a generated digest under the cap. **[src]/[doc]**
3. **The parent sees only what a seat sends or its final text, at roughly 0.3–1k tokens per event once the orchestrator's reaction is counted.** Design for notices plus ids, and expect about 1 compaction per hour on a 200K window with 4 active seats. **[probe]/[inf]**
4. **Seat agent IDs survive compaction** (as `task_status` attachments), so the orchestrator can keep messaging seats afterward. Put the roster in the digest anyway. **[src]**
5. **Cloud sessions don't install plugins.** Ship the seat system as repo `.claude/` files (skills, agents, hooks, `.mcp.json`). **[doc]**
6. **Cloud egress is limited to an allowlist through an HTTP(S) proxy.** Add the relay domain under Custom network access, or expose the relay as a remote MCP connector. Assume no WebSockets until probed. **[doc]/[inf]**
7. **Idle is fatal in the cloud.** VMs pause after a few minutes idle and background subagents aren't restored after reclaim. Long-blocked seats belong on a local or self-hosted host, or need to tolerate being restarted from the relay log. **[doc]**
8. **Local `--bg` sessions idle for more than about an hour unattached get stopped unless pinned.** **[doc]**
9. **Every built-in remote path is single-account**: Remote Control, teleport, cross-session messaging, Projects, and `--bg`. Multi-human across accounts requires our own relay with server-stamped identity and server-enforced sign-off. **[doc]**
10. **Relayed text is untrusted input.** The relay, not the model, decides author and consent state, and hooks such as the ExitPlanMode gate query the relay. **[src]/[doc]**
