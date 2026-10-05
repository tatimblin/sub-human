# 06 — Permissions, plan mode and approval as consent

Lens: can a native permission or plan approval be made to come from *specific humans*, for example the orchestrator's ExitPlanMode answered by the
approvers from their own sessions? Claude Code 2.1.281. Probes ran in `/tmp/native-06/probe` (haiku, about $0.26 in total, no processes left running).

## 1. Capability

- **No native "approver" identity.** Native consent always means "whoever answers this session's prompt". That is the local terminal, plus any relay
  attached to the session. No setting, hook field or tool names *which* human must answer. The binary has no `approvers` concept; the only hit is
  `unattended_no_approver` (computer-use). [verified-by-source]
- **Inter-agent messages are never consent.** "a message from another session never counts as your consent, so it can't answer a pending permission
  prompt on your behalf" (code.claude.com/docs/en/cross-session-messaging). "A teammate can't approve a permission prompt or supply consent on your
  behalf" (…/agent-teams#permissions). [documented]
- **`requiresUserInteraction`** is a per-tool flag. ExitPlanMode and AskUserQuestion set it to true. ExitPlanMode returns false only for team agents
  and teammates (`requiresUserInteraction(){if($a())return!1;return!0}`, where `$a` checks `dynamicTeamContext.agentId&&teamName`). A flagged tool is
  forced to `ask` even when allow rules match (`decisionReason:{reason:"requiresUserInteraction"}`), and auto mode falls back to ask
  (`tengu_auto_mode_fallback_to_ask … "requires_user_interaction"`). [verified-by-source]
- **"Hook satisfied user interaction".** A PreToolUse `allow` satisfies a flagged *built-in* tool only when the hook also returns `updatedInput`:
  `ATn(e,n){return n!==void 0&&!Oh(e)}`, where `Oh` means "is MCP". The debug log then says `Hook satisfied user interaction for ${name} via
  updatedInput`. A PermissionRequest `allow` with no `updatedInput` is ignored for flagged tools
  (`if(!C.updatedInput&&e.requiresUserInteraction?.())return null`). The docs present this as "collects the answer through your own UI"
  (…/hooks#allow-with-updatedinput). [verified-by-source + documented; the ExitPlanMode skip is verified-by-probe in spike-results-2 #3]
- **MCP `_meta["anthropic/requiresUserInteraction"]: true`.** The tool prompts on every call in every mode, including `bypassPermissions` and `auto`,
  and offers no "don't ask again". Allow rules don't skip it, and `dontAsk` mode denies it (…/mcp#require-approval-for-a-specific-tool). No hook can
  satisfy it ("a hook can't skip its approval prompt with "allow", with or without updatedInput"), and a `--permission-prompt-tool` allow becomes a
  deny. Only the person at the session, or the Agent SDK's `canUseTool`, can approve it. [documented + verified-by-probe: `--allowedTools
  mcp__room__signoff`, a PreToolUse hook returning allow+updatedInput, and a prompt tool returning allow together still produced
  `permission_denials:[mcp__room__signoff]`, with the result `MCP tool requires user interaction; not supported via --permission-prompt-tool`. The
  server never received a `signoff` call.]
- **`--permission-prompt-tool mcp__s__t`** (only with `-p`/SDK) sends every prompt to an MCP tool. The tool receives `{tool_name,input,tool_use_id}`
  and returns JSON text `{behavior,updatedInput|message}`. This includes the built-in **ExitPlanMode**. [verified-by-probe: a plan-mode run called
  `approve` with `{"tool_name":"ExitPlanMode","input":{"plan":…, "planFilePath":…}}`. Allow exited plan mode. Deny returned
  `permission_denials:[ExitPlanMode]` and the model quoted "add tests first".] A PermissionRequest hook fires alongside it, and the first decision
  wins (hooks.md). [verified-by-probe: `permreq.jsonl` got the ExitPlanMode event]
- **Channel permission relay.** A channel server that declares `experimental['claude/channel/permission']:{}` receives
  `notifications/claude/channel/permission_request {request_id(5 letters), tool_name, description, input_preview}` and answers with
  `notifications/claude/channel/permission {request_id, behavior}`. The local dialog stays open and the first answer wins
  (…/channels-reference#relay-permission-prompts). **Flagged tools are not relayed**: `if(C&&!s.tool.requiresUserInteraction?.()){…method:BKn…}` with
  `BKn="notifications/claude/channel/permission_request"`. So ExitPlanMode and AskUserQuestion never reach a channel. [documented +
  verified-by-source]
- **Agent teams plan approval.** A teammate's ExitPlanMode sends `plan_approval_request` to the lead. The lead session "approves the plan … as soon as
  the request arrives, without the lead reviewing it". Teammate tool prompts go to the lead's human (…/agent-teams). [documented; the
  `plan_approval_request/response` schema is verified-by-source] There is still only one human.
- **Remote Control bridge.** It relays prompts, flagged ones included (`requires_user_interaction: "…the user has to open the session to answer"`), to
  the *same account's* claude.ai or phone. [verified-by-source]

## 2. Mapping to "humans join like subagents": approval and consent

- **Who approves (identity).** Natively, it is the human at a session. So "approval must come from Alice and Bob" becomes "a native
  interaction-required prompt was accepted in Alice's session and in Bob's session". The plugin's join binding maps session to name. The approver
  *list* has no native home and stays custom (plan frontmatter).
- **Consent primitive (member side).** The most native way is an MCP tool on the room server, `signoff(plan_hash, summary)`, flagged
  `anthropic/requiresUserInteraction`. Claude in Bob's session calls it, and Bob sees a prompt that no hook, allow rule, mode or prompt tool can
  auto-accept. When Bob says Yes, the tool runs and the server appends a `signoff` for (Bob, hash). When he says No or presses Esc, nothing is
  recorded; Esc fires no hooks (spike-results-3 P5). The call *is* the consent record. This is stronger than the current member ExitPlanMode review,
  which any PreToolUse hook in Bob's session could satisfy with allow+updatedInput.
- **Aggregation (orchestrator side).** Keep the PreToolUse(ExitPlanMode) gate. It denies until every named approver has a signoff on the hash, then
  returns allow+`updatedInput`. That is exactly the documented "collect the answer through your own UI, then satisfy the interaction" contract. The
  "UI" is N approvers' flagged prompts. This is native and documented, not a hack.
- **Routing a single prompt to a named human (ordinary tools).** Channel relay could forward the orchestrator's Bash/Write prompts into the room. The
  room server accepts `yes <id>` only from a via=human entry by an approver named for that prompt. This fits "a specific human approves an action" but
  not "all of N", because the first answer wins. It never covers ExitPlanMode.
- **Headless orchestrator variant.** With `-p` or the SDK, `--permission-prompt-tool` or `canUseTool` can hold ExitPlanMode until all approvers sign.
  Probes verified that both allow and deny work. This is the cleanest "approval answered elsewhere" path, but the orchestrator is interactive today.

## 3. Replaces / simplifies

- **Replace** the member half of `hooks/plan-gate.js`: the stub-plan detection, overwriting `planFilePath` with canonical bytes, `ask`+`updatedInput`,
  and the `showClearContextOnPlanAccept` deny. Also replace `hooks/plan-result.js` (PostToolUse→signoff) and the `pending_review` state used by
  stop-feedback. A flagged `signoff` MCP tool covers all of it, and members no longer need to enter plan mode, because ExitPlanMode's `validateInput`
  rejects calls outside plan mode [verified-by-source: "You are not in plan mode"].
- **Keep** the orchestrator half of `plan-gate.js` (frontmatter approvers, hash, objections, allow+updatedInput). It is already the native pattern.
  Optionally move the "all signed" allow to a PermissionRequest hook. That gains nothing, since it still needs `updatedInput`.
- **Still custom:** the approver list, plan hashing and canonical text, objections, the via=human authenticity of the words, and per-session identity.
  Nothing native names a human.

## 4. Limits and risks

- Single account: every session belongs to the same Claude user. Native consent cannot tell Alice from Bob. Only the plugin's session-to-name binding
  can. [inferred]
- A flagged MCP prompt shows the tool name and arguments, not a rendered markdown plan like the ExitPlanMode dialog. Reviewers may need the plan shown
  first (via `read`) or a short summary in the arguments. Rendering is untested. [inferred]
- The Agent SDK's `canUseTool` *can* approve flagged tools (mcp.md). Remote Control can too, but only for that session's own account. [documented,
  verified-by-source]
- `dontAsk` mode auto-denies flagged tools, so a member in `dontAsk` cannot sign. [documented]
- Channel relay: channels are a research preview, and custom servers need `--dangerously-load-development-channels` plus org `channelsEnabled`. The
  first answer wins. The local terminal can also answer. Flagged tools are excluded. Relay requires the session to be launched with the channel
  opt-in. [documented]
- `--permission-prompt-tool` works only with `-p` or the SDK, and the run waits on the tool. A PermissionRequest hook may race it. [documented +
  probe]
- Agent teams auto-grant teammate plans with no human, so it is the wrong primitive for consent. [documented]
- Probe side effect: Claude Code wrote two plan files to `~/.claude/plans/make-a-one-line-plan-*.md` and transcripts under
  `~/.claude/projects/-private-tmp-native-06-probe/`. Claude Code writes these by itself; no settings were touched.

## 5. Recommendation

- **Adopt now:** keep the orchestrator gate. PreToolUse ExitPlanMode allow+updatedInput is the documented "hook satisfied user interaction" path. Add
  a `signoff` room tool flagged `_meta["anthropic/requiresUserInteraction"]:true` as the member consent primitive. That is the most native way to say
  "approval must come from these humans": one prompt that cannot be bypassed, in each named human's own session, aggregated by the gate.
- **Adopt later:** channel permission relay, for routing the orchestrator's ordinary tool prompts to a named approver once channels leave the research
  preview. It cannot carry plan approval.
- **Don't adopt:** `--permission-prompt-tool` (headless only) or agent-team plan approval (auto-granted).
- **Settling experiment:** in a scratch tmux session (not `shd-*`), load the probe server `/tmp/native-06/probe/mcp2.js` interactively in
  `bypassPermissions` and then in `auto` mode, and have Claude call `mcp__room__signoff` with a hash and a 20-line summary. Pass if the prompt appears
  in both modes with a readable summary, Esc and No produce zero server calls, and Yes produces exactly one. If the summary is unreadable, keep
  ExitPlanMode for review display and use the flagged tool only as the sign-off.
