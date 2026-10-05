# 03 · The agent panel: each human as an agent row

Lens: background subagents, the "↓ to manage" panel, the transcript view, `subagentStatusLine`, task
notifications, `SubagentStart`/`SubagentStop`, `SendMessage` resume, names and colors. The probe ran in
`/tmp/native-03` (tmux `native03`, Haiku, 2 background agents, now killed). It used a throwaway plugin `p03`
with a `human` agent (`color: green`), a `settings.json` setting `subagentStatusLine`, and hooks that log
PreToolUse(Agent|SendMessage), SubagentStart and SubagentStop.

## 1. Capability

- **Rows.** The panel lists `main` plus tasks of type `local_agent`, `remote_agent`, `in_process_teammate` and
  `local_workflow`. *verified-by-source*: `new Set(["local_agent","remote_agent","in_process_teammate","local_workflow"])`.
  Shells and monitors are counted in the footer ("1 shell") and don't get agent rows. *verified-by-probe*
- **Row label.** A `local_agent` row shows the Agent call's `description`. A teammate row shows `@name`.
  *verified-by-source*: `label:\`@${h.identity.agentName}\``. *verified-by-probe*: the rows read "alice (human)" and "bob (human)".
- **`subagentStatusLine`** replaces the text of each `local_agent` row. It doesn't apply to `main` or to fork
  workers (`Tn(e)&&e.agentType!=="main-session"&&!e.forkWorker`).
  - **Input on stdin:** `{session_id, transcript_path, cwd, columns, tasks:[{id, name, type, status, description,
    label, startTime, model, contextWindowSize, tokenCount, tokenSamples, cwd}]}`. *verified-by-probe*: `sl-in.jsonl`.
  - **Output:** one `{"id","content"}` JSON line per row; first run at 300 ms, then every 5 s (`APt=300,tLe=5000`);
    skipped in an untrusted workspace ("workspace trust not accepted"). *verified-by-source*
  - **Probe result:** both rows rendered `HUMAN-ROW name=None status=running · typing…`. *verified-by-probe*
- **A plugin's `settings.json` can set `subagentStatusLine`.** The probe set it only in the `p03` plugin, with no
  `--settings`, and the rows were replaced. *verified-by-probe*; source: `Wpe=["agent","subagentStatusLine"]`.
  This contradicts the README, which says "A plugin can't set … the agent-panel rows". Only the main `statusLine`
  needs `--settings`.
- **Transcript view** (↓, select a row, Enter): the subagent's own transcript, with its prompt, its tool calls
  (collapsed to "Ran 1 shell command"; ctrl+o expands) and its text. *verified-by-probe*
  - The divider is titled with the description and drawn in the agent's `color`: `color: green` gave
    `ESC[38;5;35m── … bob (human) ─`. *verified-by-probe*
  - The view has its own prompt, `Message @p03:human…`. Whatever you submit there goes to that subagent and resumes
    it. *verified-by-probe*: an accidental Up+Enter re-sent bob's prompt and resumed him.
- **Task notifications.** Each stop gives the parent `<task-notification>…<summary>Agent "alice (human)"
  finished<note>…<result>FINAL TEXT</result><usage>…` and a parent turn ("Alice completed: …"). *verified-by-probe*
  - If the agent stops while a background child is still running, it is woken again when that child finishes. The
    note says: "It may resume on its own when that work completes or reports, and the same task-id notifies again".
    *verified-by-probe*: alice notified twice, at 7 s and at 53 s.
- **Foreground waits.** A foreground `sleep 50` in a background agent was refused ("The system is blocking long
  foreground sleeps"). *verified-by-probe* A proxy must block inside an MCP tool, the way `room.watch` does, or park
  on a background child.
- **Hooks** (*verified-by-probe*, `hook-*.jsonl`). SubagentStart carries `{agent_id, agent_type}`, with no
  description and no name. SubagentStop adds `agent_transcript_path`, `last_assistant_message` and
  `background_tasks`. PreToolUse(SendMessage) gets `tool_input: {to, message, summary, type, recipient, content}`.
- **Names.** The Agent schema has `name` (*verified-by-source*), but Haiku left it out both times, even when told
  it was required: the status line got `name=None` and the parent sent `SendMessage({to:"ac41f86eea3c5228f"})`
  (the agent id), queued "at its next tool round". *verified-by-probe*

## 2. Mapping: "humans join like subagents"

The design is one **proxy agent per human in the orchestrator session**. It mirrors that human; it doesn't act for
them. Concretely, it is the existing `room` agent definition, parameterised by member.

- **Joining.** On the Monitor's `join alice`, the orchestrator spawns `sub-human:member` (Haiku,
  `background: true`) with description and prompt `alice`. A PostToolUse(Agent) hook records `agentId → alice` from
  the response's `agentId` (*verified-by-source*: the `async_launched` schema). That map is the identity anchor, so
  nothing depends on the model passing `name`.
- **Live status.** The plugin ships `subagentStatusLine` in its own `settings.json`. The script looks each row
  up by agent id and derives a line from the log only, e.g. `alice · ✓ signed 3f2a · assigned fetcher · last post 2m`.
  It is deterministic and costs no tokens. It prints nothing for non-member rows, which keep their default text.
- **Transcript.** The proxy loops on `watch --member alice`, which returns only her entries. Each tool result is
  the MCP server's verbatim text, so the transcript view is alice's activity as it happened (posts, sign-offs,
  objections, statuses). Opening a row reads as "watch alice".
- **Visibility and color.** Use the description `alice` and pick a color per seat. Color is frontmatter, so it is
  fixed per agent type. Per-human colors need N agent types (`member-1…8`) or `--agents` JSON at launch.
  *inferred*
- **Notifications.** The proxy never ends its turn while alice is present, so there are no interim notifications;
  a SubagentStop hook (`decision:"block"`) pushes it back to `watch` unless the log has her `leave` (spike-plan
  pattern). On `leave`, `watch` returns `STOP:` and the proxy ends with `alice left`: one native notification, when
  it matters. Waking stays with the plugin Monitor, which carries verbatim bytes.
- **Messaging the human.** The orchestrator uses the native verb, `SendMessage({to: <alice's id or name>})`. A
  PreToolUse(SendMessage) hook maps `to` to the member, appends `directive to=alice via=agent` to the log and denies
  the send with "delivered to alice as #N", so no model text stalls in the proxy's queue. *inferred* (PreToolUse
  deny on SendMessage is *verified-by-source* in research 02.)
- **Approval and work** don't change: sign-offs come from each human's own dialog; the row only shows `✓ signed`.
- **Member sessions.** Keep the single `room` feed row there. Per-member rows in every session would cost
  O(N²) Haiku turns.

## 3. Replaces / simplifies

- It replaces the README's `--settings` step for `subagentStatusLine`: the plugin ships it itself. The main
  `statusLine` still needs `--settings`.
- It replaces "who is here" prose with native rows plus a free per-human transcript, and a custom "message
  member" tool with intercepted `SendMessage`.
- **Still custom:** the room log (the verbatim source), `watch --member`, the Monitor (waking, verbatim), the
  identity hooks, the agentId→human map and the status-line script.
- The proxy itself is a model shell around an MCP long-poll. It can't be native-only, because no task type
  renders an externally driven row without a model. `mcp_task` rows are server-driven (a `statusMessage` and a
  task-notification on completion; *verified-by-source*), but they aren't in the agent-panel set and their spawn
  path looks gated.

## 4. Limits and risks

- **Cost.** Each entry addressed to or from alice costs one Haiku turn in her proxy. A proxy is about 7–9k
  tokens, mostly cached. *verified-by-probe*: `<subagent_tokens>7438`.
- **The idle line.** The orchestrator window permanently shows "Waiting for N background agents". This is
  cosmetic; nobody types there.
- **Typing into a proxy.** Typing in a proxy's transcript-view prompt injects text into the proxy, not to alice.
  Because the proxy's only tool is `watch`, the damage is limited to the proxy's own behaviour. Document it as
  read-only.
- **Model compliance** isn't deterministic: `name` was dropped (on Haiku; a Sonnet or Opus orchestrator may
  differ), and a proxy can wander, as alice and bob did when they backgrounded their sleeps. Hooks must pin both.
- **Status line scope.** It is per session, and only `local_agent` rows get one. Managed-only settings
  environments ignore the plugin layer (`rh()?policySettings`). It is interactive-only; `-p` has no panel.
- **Row eviction.** A row whose agent has stopped disappears after a while: alice's row vanished once she
  finished. *verified-by-probe* A proxy must stay "running" to stay visible.

## 5. Recommendation

**Adopt now, in part.**
- Ship `subagentStatusLine` in the plugin's `settings.json` immediately. That is *verified-by-probe*, and the
  README should be corrected.
- Turn the `room` agent into per-member proxy rows in the orchestrator session, with deterministic status from
  the log.
- **Adopt later:** routing `SendMessage` to humans through a PreToolUse hook.
- **Don't adopt:** proxy end-of-turn notifications as the wake path. Their `<result>` is model-written and every
  event costs two turns. Keep the Monitor.

**Settling experiment.**
- Run an Opus orchestrator plus 3 member proxies blocked in `watch --member` for 30 minutes and 20 entries.
- **Pass if** all three rows persist with live log-derived status, the orchestrator gets 0 interim notifications,
  each entry costs at most one proxy turn, and the hook turns `SendMessage({to:"alice"})` into exactly one
  `directive`. Also record whether the orchestrator passes `name`.
