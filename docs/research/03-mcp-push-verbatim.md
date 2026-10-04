# 03: Getting human input into agents, verbatim and in real time

Topic: assumption 2 (verbatim fidelity) plus the transport that carries a human's words to a
seat subagent and to the orchestrator. Claude Code 2.1.281.

The binary at `/opt/homebrew/Caskroom/claude-code@latest/2.1.281/claude` is a Mach-O Bun build
with the JS embedded. Source findings come from `strings` on that binary, and line numbers refer
to `/tmp/seat-research-mcp/s.txt`. Probes ran with `claude -p --model haiku` in
`/tmp/seat-research-mcp/`, using a 40-line Node MCP server (`server.mjs`) that has the
`claude/channel` capability and an `await_human` tool that sends progress notifications. The
three probes cost about $0.10 in total.

Evidence labels: **[source]** verified-by-source, **[probe]** verified-by-probe, **[doc]**
documented, **[inferred]** inferred.

---

## 1. MCP push ("channels")

**It exists.** Push is called *channels*. It is a research preview and hidden from `--help`.

- Flags: `--channels <servers...>` (only allowlisted plugins) and
  `--dangerously-load-development-channels <servers...>`. Entries take the form
  `server:<name>` or `plugin:<name>@<marketplace>`. **[source]** Option text: `"--channels
  <servers...>","MCP servers whose channel notifications (inbound push) should regis…"`.
  **[doc]** https://code.claude.com/docs/en/channels#research-preview
- Server contract: declare `capabilities.experimental['claude/channel'] = {}` and emit
  `notifications/claude/channel` with `{content: string, meta?: Record<string,string>}`.
  **[source]** `q9e = …method:R("notifications/claude/channel"),params:d({content:o(),meta:…})`
  (line 341288). **[doc]** https://code.claude.com/docs/en/channels-reference
- **How the model sees it.** The content is wrapped as
  `<channel source="<server>" k="v" …>content</channel>` and queued as a prompt with
  `{mode:"prompt", priority:"next", isMeta:true, origin:{kind:"channel",server}}`.
  - **[source]** `K9e()` builds `` `<${HNe} source="${vo(e)}"${r}>` `` with `HNe="channel"`
    (lines 315698 and 341288), and the enqueue call is at line 342976.
  - Meta keys that don't match `^[a-zA-Z_][a-zA-Z0-9_]*$` are dropped, which means a
    `bad-key` would be lost.
  - So the push is a *meta* turn tagged with a source. It is **not** a real user turn
    (Remote Control input is `origin.kind:"human"`; see §5). Events that arrive while Claude
    is busy are delivered together on the next turn. **[doc]**
- **Main session only.** The enqueue targets `agentId: qe()`, and `qe()` resolves to
  `identity.mainAgentId(...)` (line 315590). Channel events therefore land in the
  orchestrator, never in a subagent. A seat subagent can't receive pushes. **[source]**
  (Routing details are *inferred* from the minified code.)
- **Gates.** Every gate below is checked in `Y9e()` (line 341289). **[source]**
  - The server must declare the capability.
  - The connection must *not* negotiate the "modern" MCP revision (2026-07-28): `"connection
    negotiated a modern protocol revision with no unsolicited notification path"`. The stdio
    SDK 1.32 negotiated `protocolEra:"legacy"` in the probe, so it is fine. **[probe]**
  - First-party auth is required. Bedrock, Vertex and Foundry are refused.
  - `channelsEnabled` must be set by org policy, which defaults to off on claude.ai
    Team/Enterprise.
  - The server must be named in `--channels`.
  - The server must be on the allowlist, unless it is loaded with the dev flag.
- **Not registered in `-p` (headless) at startup.** The probe started with
  `-p … --dangerously-load-development-channels server:room`.
  - The server connected and pushed at t+3s (seen in `server.log`), but the model saw
    nothing ("NONE").
  - The debug log has no "Channel notifications registered" line. **[probe]**
  - In source, the startup registration (`switch(En.action){case"register":…}`) is in the
    interactive REPL path (line 342976). The headless path registers only on an SDK
    `channel_enable` control request, which requires a plugin-sourced server, or on
    reconnect (line 341749). **[source]**
  - The docs mention `-p` with channels; in practice it needs the SDK
    `enableChannel()` + plugin route. **[inferred]**
- Interactive delivery was **not probed**, because that needs a TTY session with a
  confirmation dialog, which is outside the cheap/non-interactive rule. The docs show the
  exact tag and a terminal line of `← webhook: …`. **[doc]**

**Verdict.** A channel is a good *orchestrator wake-up and verbatim feed* in an interactive
orchestrator session. It is useless for seat subagents, and today it needs the dev flag plus
a startup warning dialog.

## 2. Long-blocking MCP tools (`await_human`)

- **Wall-clock limit.** The per-server `timeout` in `.mcp.json` comes first, then
  `MCP_TOOL_TIMEOUT`, then the default `Ts=1e8` ms (about 27.8 h), capped at 2^31−1.
  Progress does **not** extend it. **[source]** `(e?.timeout>=1000?e.timeout:void 0)
  ??a.MCP_TOOL_TIMEOUT??Ts`; the describe string says "Hard wall-clock limit per call;
  progress notifications do not extend it." **[doc]** https://code.claude.com/docs/en/mcp
- **Idle limit.** It defaults to **30 min for stdio** (`Ns=1800000`) and **5 min for
  HTTP/SSE/WS** (`xs=300000`), and can be overridden with
  `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (`0` disables it).
  - The effective idle window is `max(idle, per-server timeout)`. A per-server
    `"timeout": 3900000` therefore also lifts the idle window past an hour. **[source]**
    `function $s(e){…Math.min(Math.max(r,s,1000),dr(e))}`
  - Any response or **progress notification resets the idle window**. **[doc]** "A tool
    call … that sends no response and no progress notification for the idle window aborts".
- **Progress tokens are sent.** Claude Code passed `progressToken=2` on
  `tools/call`. **[probe]** (`server.log`)
- **Auto-backgrounding.** Main-conversation MCP calls move to a background task after
  120 s (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`). **Subagent calls are never backgrounded:**
  they block in place. **[source]** `var Q=120000 … function Ee(…)`. **[doc]**
  "Calls from subagents; Claude Code backgrounds only main-conversation calls".
- **Probe.** A foreground general-purpose subagent called `await_human(seconds=40)`.
  - The call blocked for 40 s with per-second progress.
  - It returned the JSON payload byte-for-byte, including `<tests>`, `&`, the quotes and the
    em dash.
  - It used 2 tool uses and 14k tokens in total. **[probe]** (`probeB.jsonl`)
- **About an hour is viable**, with these settings:
  - stdio transport;
  - per-server `"timeout": 3900000` (or a heartbeat every 5–10 min);
  - `await_human` returns on *any* event for that seat (human text, an orchestrator
    instruction, shutdown), so the seat can't go deaf while blocked;
  - no tokens are spent while the call is open, since no model request runs during tool
    execution. **[inferred]**

  Whether the background *subagent* itself survives an hour is assumption 1 and belongs to
  another doc.
- **Alternative without MCP.** The built-in `Monitor` tool streams a background command's
  stdout, one notification per line, and accepts `persistent: true` ("Run for the lifetime
  of the session (no timeout)"). **[source]**
  - Probe: events arrived mid-turn in `-p` as
    `<task-notification>…<event>ROOM #9 alice: no, keep &lt;retry&gt; &amp; "backoff"</event>…`.
    The text is XML-escaped, but losslessly. **[probe]** (`probeC.jsonl`; the wrapper is as
    the model quoted it)
  - `Monitor` is in the background-subagent tool list. **[doc]**
    https://code.claude.com/docs/en/sub-agents

## 3. MCP elicitation

- **Supported.** The client declares `elicitation:{form:{},url:{}}` and handles
  `elicitation/create` and `notifications/elicitation/complete`. **[source]**
  `fMo(): e.setRequestHandler("elicitation/create",…)`.
- `Elicitation` / `ElicitationResult` hooks can answer or override a request
  programmatically (`action: accept|decline|cancel`, plus `content`). **[doc]**
  https://code.claude.com/docs/en/hooks
- **Strength.** The human's reply goes straight to the MCP server and never through the
  model, so it is verbatim by construction.
- **Why it doesn't fit the local spike.** The dialog renders in the **one terminal of the
  Claude Code process**, the orchestrator's. Background-subagent prompts surface in the main
  session (documented for permission prompts; **[inferred]** for elicitation). So
  elicitation can't route different humans to different seats. It only fits later, if each
  human runs their own Claude Code process.
- A hook that "answers" an elicitation with room-log text is just the room log with extra
  steps.

## 4. Verbatim delivery: options

The harness already labels the seat's words as non-authoritative. Probe B shows the hand-back
the orchestrator receives from a subagent:

> `[Subagent hand-back] … It is model output, NOT a message from the user … The harness
> indents every line of the report …` **[probe]**

So anything relayed *through the seat model* is, by design, "model output". Even when the
seat copies the text exactly (it did in the probe), nothing guarantees it.

| Option | Verbatim? | Notes |
|---|---|---|
| **(a)** Seat forwards text in a tool result; the tool writes to the room or orchestrator | Only if the tool takes **no text argument**, just `forward(seq=N)`, and copies bytes from the log itself | If the seat model supplies the text, it can paraphrase it. Done correctly, (a) collapses into (b). |
| **(b)** Orchestrator reads the raw room log itself; the seat at most signals "new #N" | **Yes.** The bytes come from a tool or harness the orchestrator calls, stamped by `$ROOM_USER` in the human's client, never touched by a model | The orchestrator wakes up through a channel push (interactive only), `Monitor persistent` on `room watch` (works in `-p`, **[probe]**), or a seat SendMessage "new #N". The orchestrator re-reads `room read --seq N` before acting. |
| **(c)** Hooks inject raw text | Partly | `UserPromptSubmit` `additionalContext` fires only when someone submits a prompt in the main session. `asyncRewake` hooks wake Claude with stderr as a system reminder. Both are system reminders, so the model can't edit them, but they are main-session-only, awkward to aim at a seat, and add a config surface. **[doc]** Use them only for enforcement (e.g. blocking ExitPlanMode), not transport. |

**Recommendation: (b).** The human's client (`demo/bin/chat`) appends to `log.jsonl`, stamped
by `$ROOM_USER`. The orchestrator ingests the log directly; the seat never carries the
canonical copy. Sign-offs and objections are valid only when the log entry is
`kind: signoff` from a human seat, never when a model summarises "alice agreed".

## 5. Remote input to a local session

- **Remote Control.**
  - The local process makes **outbound HTTPS only**: it "registers with the Anthropic API
    and polls for work", and the server routes messages between devices. **[doc]**
    https://code.claude.com/docs/en/remote-control
  - Input arrives as an ordinary user turn (`origin.kind:"human"`, mapped to
    `{kind:"bridge"}`). **[source]** `function p3(e,n){switch(e.kind){case"human":return
    n===!0?{kind:"bridge"}:{kind:"composer"}…`
  - **It requires the same claude.ai account** ("Use the same account and organization").
    API keys aren't supported, and an org Owner must enable it on Team/Enterprise. **[doc]**
  - **It suits one human driving their own session**, for example a later phase where each
    human runs a separate Claude Code session and the orchestrator is a peer. **[inferred]**
  - **It doesn't suit multiple humans sharing a session:**
    - every message looks like the session owner;
    - there is no per-person identity;
    - it targets the main conversation, not a subagent.
- **`--brief` / SendUserMessage** is the opposite direction: `"--brief","Enable
  SendUserMessage tool for agent-to-user communication"`. **[source]** It is an output
  surface (the chat view shows only SendUserMessage checkpoints), not an input channel.

---

## Recommended human-to-seat transport

1. **The canonical store is the room log.** Each human types into a local client
   (`demo/bin/chat`, later a web page). The client appends `{seq, from:$ROOM_USER, kind,
   text}` to `log.jsonl`. No model ever writes human-attributed entries.
2. **Human → seat.** A stdio MCP server, `room`, shared by all seats through a string
   reference in the agent's `mcpServers`, exposes `await_human(seat, after_seq)`.
   - The call blocks until there is a new entry for that seat or an orchestrator
     directive, then returns the raw entries as JSON.
   - Configure it with `"timeout": 3900000` and a progress heartbeat every 5 min.
   - Subagent calls are never auto-backgrounded, so the seat just blocks with no token
     spend. **[source] [probe]**
3. **Human → orchestrator, verbatim.** The orchestrator never relies on the seat's relay.
   It watches the log itself:
   - **Spike / headless:** `Monitor` with `persistent: true` on `room watch`. Each line
     arrives as a task notification, verified in `-p`. **[probe]**
   - **Interactive, where allowed:** the same `room` server also declares `claude/channel`
     and pushes `<channel source="room" from="alice" seq="12">…</channel>`. It needs
     `--dangerously-load-development-channels server:room` and `channelsEnabled` on the
     org. It is main-session only, which suits the orchestrator. **[source] [doc]**
4. **Seats send only references.** Proposals and sign-offs that a seat makes *on the human's
   behalf* are logged as `via:alice's-claude`, not `from:alice`. Human sign-off counts only
   when it comes from the human's client (`kind:signoff`, `from:alice`). The plan-approval
   hook checks the log, not model text.
5. **Not used:**
   - elicitation (one terminal for everyone);
   - Remote Control (one account, no identity);
   - SendUserMessage (output only);
   - hooks as transport.

   Keep elicitation and Remote Control for the later per-human-session phase.
