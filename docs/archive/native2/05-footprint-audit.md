# 05 — Footprint audit: what sub-human costs a member, and the smallest unprescriptive plugin

Scope: every component under `plugin/sub-human` in the current tree. Labels:
- **[src]**: verified by reading the source.
- **[meas]**: measured by running the plugin's own functions against a throwaway `SUB_HUMAN_HOME` in `/tmp/n2-05`, which was deleted afterwards. No Claude sessions were started.
- **[doc]**: plugin README or round-1 docs.
- **[inf]**: inferred.

## 1. What the plugin puts on a member

**Ambient: every session with the plugin installed, joined or not**
- **Hooks.** There are 14 hook registrations across 10 events (`hooks/hooks.json`), each a `node` cold start. `at-room.js` runs on every prompt, `guard.js` on every Bash/Write/Edit, `row-guard.js` and `row-map.js` on every Agent call, and `row-hold.js` on every subagent stop. [src]
- **Launcher write.** `row-launcher.js` writes `~/.sub-human/bin/row-status` on every SessionStart in every project (`row-launcher.js:38-41`). [src]
- **Status line.** The plugin's `settings.json` sets `subagentStatusLine` for all sessions. Every panel refresh runs the launcher, which falls back to `ps -A` when the session is not in a room (`lib/identity.js:266`). [src] It probably overrides the user's own setting. [inf]
- **MCP server.** It runs in every session, and `signoff.js` polls `whoami()` every second (`mcp/signoff.js:184-209`). [src]
- **Model context.** [meas]
  - MCP instructions: 154 chars.
  - 5 tool schemas: 2,320 chars (`post` 797, `hold` 611, `review` 382, `plan` 274, `read` 250).
  - 3 plugin-agent descriptions: 860 chars in the Agent tool's type list (`agents/*.md:3`).
  - The skill description is hidden by `disable-model-invocation`. [doc]
- **Hook errors.** If any common.js hook throws, it exits 1 with `sub-human hook error: <stack>` on stderr (`hooks/common.js:41-50`). Claude Code shows that to the user as a hook error, in any session. [src]

**At join** (`hooks/join.js:21-27` → `common.js:142-158`)
- The member's `additionalContext` is **5,507 chars** in a 3-member room: `member.md` 4,574 + row calls 458 + head, roster and digest. [meas]
- The orchestrator's is **7,501 chars**: `orchestrator.md` 6,389 + row calls 1,020. [meas]
- The cap is 9,500 (`common.js:17`).
- The whole block is re-injected on every compact, clear and resume (`session-restore.js:49-55`).
- PreCompact adds about 1k chars of summarizer rules (`precompact-note.js:19-28`).
- After a member posts with `@room`, their next prompt gets a ~330-char preamble plus the posts (`at-room.js:101-113`). [src]

**What it forces**
- **Rows.**
  - A member spawns 1 `sub-human:room` Haiku agent, which spawns N−1 participant agents (`lib/rows.js:121-133`, `agents/room.md:15-17`). The orchestrator spawns N (`rows.js:105-119`).
  - Each row costs a Haiku turn, then a `hold` call that blocks for as long as the room lasts (`mcp/hold.js:4-22`), and up to 5 forced re-holds (`row-hold.js:16,35-41`).
  - What the person sees: "✻ Waiting for N background agents to finish" after every turn (README:66). `/exit` asks "Background work is running…" (README:184). Esc-twice kills a row, it respawns, and the dead copy stays listed (README:61). [doc]
- **Model wakes.**
  - The `room` monitor emits a line of up to 240 chars [meas] for each entry addressed to me, *every* other human's post, every orchestrator post to the room, and every system entry: joins, leaves, plan_rev and gate status (`bin/sub-human:85-98`).
  - Each line wakes the model, and `member.md:14` says "Tell NAME each in one line". So every room event costs every member a turn and a chat line. [src]
- **Dialogs and alerts.**
  - The elicitation form "MCP server … requests your input" interrupts mid-turn. If dismissed, it comes back after 10 minutes (`signoff.js:63`, README:94-103).
  - `osascript` notification plus a BEL to the claude TTY (`statusline/alert.js:16-18,61,70`).
  - `sessionTitle` is overwritten with `⬡ CODE · NAME` (`at-room.js:92-99`).
- **UI noise.**
  - Every `@room` post shows "⏺ UserPromptSubmit operation blocked by hook: ✓ posted…" (`at-room.js:12-16`).
  - Deny reasons from guard, row-guard and the gate.
  - Hook-error stderr on any crash.

## 2. Role text: mechanics vs prescription (the unprescriptive test)

Line classification [src, meas by summing lines]:
- `member.md` is about **1,850 chars of mechanics and 2,900 of prescription**.
- `orchestrator.md` is about **2,200 of mechanics and 4,300 of prescription**.

**Mechanics to keep in `member.md`**
- You are NAME's Claude in room CODE (1).
- `@room` posts NAME's exact words as `via=human`; never retype them (12).
- Your posts go through `post` and show as "NAME's Claude" (13, without "1–2 sentences").
- Never claim NAME's consent; only NAME's form counts (16).
- Don't write into `~/.sub-human` (18).
- The sign-off form appears by itself; call `review` if NAME voices a verdict in chat (23-27, condensed to 2 lines).

**Prescription to delete from `member.md`**
- "unattended orchestrator (facilitator, plan writer)" (3).
- The row ritual (7).
- "Talking happens here" (11).
- Brevity and citation style (13).
- "Tell NAME each notice" (14).
- "Act only when addressed" (15).
- "No conditional instructions" (17).
- Approvers are the orchestrator's choice (19).
- "Never use plan mode" (29).
- The whole Event→action table, including "Implement nothing until an assignment names NAME" and "Start after NAME says go; stay in NAME's files" (32-41).
- The "Work for the room" ritual of status, background subagent, status (43-50).

**`orchestrator.md`**
- Almost all of it is a facilitation method: neutrality, the positions table, converge→decide→diverge, reminders, "3 sentences" (5-12, 20-38, 57-65).
- Make it optional. Ship it as a `facilitator` agent that the room may start, not as the room's required centre.
- Keep the plan-file frontmatter (42-55) only as documentation of the consent mechanic.

**Agent prompts**
- `participant.md` and `room.md` are pure row plumbing (deleted below).
- `agents/orchestrator.md:6-12` scripts the session ("do nothing until /sub-human").

**Minimal injected text (≈500 chars)**
> SUB-HUMAN: you are NAME's Claude in room CODE; NAME is the person typing. Lines NAME starts with `@room` are posted verbatim as NAME's words; never retype them. Your own posts (`post`) are labelled "NAME's Claude". Room notices addressed to NAME arrive as monitor lines; `read` fetches anything else. Never say NAME agrees or approves: consent is only NAME's answer in the sign-off form; if NAME voices a verdict in chat, call `review`.

## 3. Plan-first assumptions (planning must be optional)

Every piece below assumes the room exists to produce one plan through the orchestrator's plan mode:
- **Launch and agent.** `--permission-mode plan` (README:27, `agents/orchestrator.md:3`), and the agent's EnterPlanMode/ExitPlanMode tools (`:4`).
- **Consent tied to plan mode.** The gate is bound to the orchestrator's ExitPlanMode (`hooks/plan-gate.js`, `plan-result.js`). Consent exists only as `plan_rev` → `signoff` → `decision`, and only the orchestrator can propose.
- **Role text.** `orchestrator.md:3,27,33,40-59` ("reach a plan they all own", EnterPlanMode when positions clear, assignments after the decision). `member.md:3,19,21-41` (plan_rev, decision, assignments).
- **Tools.** The MCP `plan` tool (`room-server.js:152`). The `PLAN_NOTICE` and the "Approve this plan?" wording (`signoff.js:52`).
- **Row and status text.** "plan 593da0 1/2 · ⚠ your sign-off needed" (`rows.js:24-28`) and the plan segment in `statusline/segments.js:8-30`.
- **Alerts and compaction.** `alert.js` alerts on plan_rev. `precompact-note.js:24` says "keep the plan hash".
- **Identity and pitch.** `join.js:47-55`: a room exists only once an orchestrator opens it. `plugin.json` and the README pitch "Plan together".

**Replacement:** consent becomes a general proposal mechanic.
- An MCP tool `propose({text|path, approvers})` is callable by any member's Claude, or by a human via `@room propose …`.
- It appends `proposal_rev` with a hash. `signoff.js` pushes the existing form to the named approvers. The server logs `decision` when the matrix is complete. The form wording becomes "Agree to this proposal?".
- This deletes `plan-gate.js`, `plan-result.js` and the plan-mode dependency. A room with no proposals never shows a form.

## 4. Verdict per component

| Component | Verdict | User-visible effect |
|---|---|---|
| `join.js` + `SKILL.md` | **Keep, shrink** the block to ≈500 chars (§2). Drop ROWS and DIGEST. Join no longer needs an orchestrator: the first joiner creates the room. | One command. Join context is about 9% of today's. |
| `member.md` / `orchestrator.md` | **Shrink** to the §2 text. The orchestrator becomes an optional `facilitator` agent. | People and their Claudes work as usual. |
| `at-room.js` | **Keep.** It is the attribution core: verbatim `via=human`, plus the peer-forgery guard (`:21-29,131-133`). | The "blocked by hook" receipt header has no fix found. |
| MCP `post`, `read` | **Keep.** Cut `post`'s description to ≤250 chars and fold `plan` into `read`. | Claude's posts stay labelled. |
| `signoff.js` + `review` | **Keep, generalize** to proposals (§3). Poll only once joined. | A form appears only when someone proposes. |
| `plan-gate.js`, `plan-result.js` | **Replace** with server-side `propose` → `decision`. | No plan mode anywhere. |
| Rows stack: `mcp/hold.js`, `agents/participant.md`, `agents/room.md`, `lib/rows.js`, `hooks/row-{guard,map,hold,launcher,common}.js`, `settings.json`, `statusline/segments.js` agent part, `presence.js` | **Delete.** Replace with native features: `ListAgents`/`SendMessage` session listing (per BRIEF; unverified here) and `claude agents --json` busy/idle/blocked (09, verified by probe). `sub-human who` is the fallback. | No waiting banner, no exit dialog, no Haiku spend, no dead rows, 860 fewer ambient chars. |
| Monitor + `bin/sub-human tail` | **Keep the native Monitor, narrow `visibleTo`** to `to=me`, proposals naming me, and decisions. | Wakes only for things about me. Others' talk is read on demand. |
| `statusline/alert.js` | **Shrink.** Keep the BEL for `to=me`; delete osascript. Later: native `PushNotification`. | One bell, no OS banner. |
| `guard.js` | **Shrink.** Keep the MCP auto-allow (a plugin can't ship permissions, `:4`) and the Write/Edit store deny. Drop Bash from the matcher and the CLI allowlist (the hash chain shows tampering, README:163). | No hook on ordinary Bash calls. |
| `session-restore.js` / `session-end.js` | **Keep.** Re-inject the ≈500-char block and log `member_left`. | Cheap survival of `/clear`. |
| `precompact-note.js` | **Delete.** The restore block covers it. | — |
| CLI `read`/`who`/`watch`/`plan`/`digest` | **Keep.** These are human tools with zero footprint until run. Delete `agent-statusline`. | — |

## 5. A headless orchestrator, if a room wants a facilitator

These pieces exist only because the orchestrator has a window:
- The launch steps and "Run /sub-human" (README:24-30, `agents/orchestrator.md:8`).
- The orchestrator's status line via `--settings` (README:138-149).
- The orchestrator's rows: 1,020 chars plus N Haiku agents.
- "Host joins from a second session" (README:6,32,170).
- The no-argument branch and refusals in `join.js:47-60`.
- The orchestrator's `@room` refusal (`at-room.js:135`).

What a headless orchestrator needs instead:
1. **A start path.** `claude --bg -n room-CODE --agent sub-human:facilitator "/sub-human"`, started on request (`/sub-human facilitate`). `--bg` gives a full interactive session (09, verified by probe).
2. **Viewing.** Members open it with `claude attach <id>` or the agent view. Attach is a shared keyboard (09:116), so block typed prompts in that session; `sub-human watch orch` is a read-only view.
3. **No unanswerable prompts.** The facilitator has no Bash. Its subagents block when nobody is attached (09:122); later, route those with `PermissionRequest`.
4. **Cleanup.** Run `claude stop <id>` when the last member leaves.

## 6. Smallest plugin, and risks

**Join, attribution, visibility and consent need only:**
- Hooks: `join`, `at-room`, `session-restore`, `session-end`, and a narrowed `guard`: **5 of 14**.
- MCP tools: `post`, `read`, `propose`, `review`: **4**.
- Agents: an optional `facilitator`: **1 of 3**.
- Also: the narrowed monitor, `lib/{identity,room}.js`, the CLI, and ≈500 chars of role text.

**Removed:** rows, presence, precompact and the plan gate, roughly 1,500 of 4,233 source lines. Join context drops from 5,507 to about 500 chars, from N Haiku rows to 0, and wakes go from every event to events about me.

**Risks:**
- Without rows there is no persistent "your sign-off is waiting" cue after Esc. An opt-in main `statusLine` covers that. [inf]
- `ListAgents` for visibility is unverified here. Round 1 rejected cross-session messages as *attributed transport* because senders are forgeable, so use it only for seeing sessions.
- A narrower monitor means a Claude may answer without seeing others' posts. The mitigation is `read` first. [inf]
- Moving consent out of plan mode loses Claude Code's own plan dialog. The elicitation form was already the real consent path (README:105-113).

## 7. Recommendation

**Adopt now:**
- the §2 role text;
- delete the rows stack, presence and precompact;
- narrow the monitor and `guard.js`;
- make planning optional via `propose`;
- make the facilitator an optional headless agent.

Keep `at-room`, `post` and the form.

**Experiment:** run the same 20-entry, 3-human script (Haiku members) on the slim build and the current build, with one proposal and stretches of free talk. Per member, count:
- room-caused model turns;
- injected chars;
- non-work UI lines.

The slim build passes if turns and chars fall by at least 70% while each person can still say who said X (human or Claude) and consent to the proposal through the form.
