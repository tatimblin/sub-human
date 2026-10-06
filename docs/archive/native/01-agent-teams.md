# 01 — Agent teams: can a human's session be a teammate?

Claude Code 2.1.281. Probe in `/tmp/native-01/`: haiku, interactive, tmux sessions `native01-*`, run from the
already-trusted `/private/tmp`. Cost about $0.25; all processes killed. Sources: binary strings,
code.claude.com/docs/en/agent-teams (fetched 2026-10-04), `docs/research/01`.
**Short answer: half of it works.** A human's own session can attach to a lead's team with hidden CLI flags and
message the lead. The lead **cannot message it back** unless that session is on the roster, and the lead **takes
over the human session's permission prompts**. Plan approval also runs in the wrong direction.

## 1. Capability

- **Team setup.** Needs `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and an interactive session; under `-p`/SDK no
  teammates spawn (*documented*).
  - At startup each session creates team `session-<8 chars of sessionId>` and writes
    `~/.claude/teams/<team>/config.json`. Its `members` array starts with `team-lead@<team>`, backend
    "in-process" (*verified-by-probe*).
  - The directory is deleted when the lead exits (*verified-by-probe*: "Cleaned up team directory").
- **Spawn.** An Agent call with `name` spawns a teammate: in-process by default, or in a tmux/iTerm2 pane.
  - A pane teammate is launched as `claude --agent-id <n>@<team> --agent-name <n> --team-name <team>
    --agent-color c --parent-session-id <lead> [--plan-mode-required] [--agent-type t] [--model m]`.
  - Before launch the lead adds it to config.json (`yQt`) and writes the spawn prompt to its inbox
    (*verified-by-source*: `spawnMultiAgent`).
- **Hidden flags** (`.hideHelp()`), usable by anyone. The three identity flags must come together ("…must all be
  provided together") and then call `setDynamicTeamContext` (*verified-by-source*).
- **Mailbox.** One JSON file per agent, `inboxes/<name>.json`, entries `{from, text, msg_id, read, …}` (*verified-by-probe*).
  - A teammate polls its own inbox every 1 s (`ioo=1000`; the probe log shows one `readMailbox` per second).
  - When idle, a message is "submitted immediately" as a new turn; when busy, it is queued (*verified-by-source*).
- **The lead's poller is dormant** while its in-memory roster has no non-lead member:
  `kCe(e)=…Object.keys(r).some(s=>s!==t)` gates `I5()` (*verified-by-source*).
- **Addressing.** `SendMessage.to` must be a bare name: `alice@<team>` returned "to must be a bare teammate name";
  an off-roster name returned "No agent named 'alice' is reachable" (*verified-by-probe*).
- **Idle notification.** Each teammate turn end writes `{"type":"idle_notification","result":"<final text>"}` to
  `team-lead.json` (*verified-by-probe*).
- **Plan approval runs teammate→lead and is auto-approved.**
  - The teammate's ExitPlanMode sends `plan_approval_request` and the teammate waits.
  - The lead approves it with no review: "[InboxPoller] Auto-approved plan from" (*verified-by-source*); docs:
    "without the lead reviewing it".
  - "Only the team lead can approve plans. Teammates cannot approve their own or other plans"
    (*verified-by-source*).
- **Permissions.** A teammate's tool prompts are relayed (PermissionSync frames) to the lead's terminal; the
  teammate shows "Waiting for team lead approval". An inbox can never change mode or rules ("Dropping
  mode_set_request…", "Dropping team_permission_update…") (*verified-by-source*).
- **TaskStop** works only on teammates the lead spawned. It kills the task and pane and removes the member, and the
  separate `claude --agent-id` process "may still be running" (*verified-by-source*).
- **Sender identity.** `from` is whatever name the writer gives itself; only claims to a protected identity are
  marked `forged` (`tse()`, *verified-by-source*). Alice rendered exactly like bob (lead-spawned) as
  `<teammate-message teammate_id="alice">`, framed "came from another Claude session — not typed by your user"
  (*verified-by-probe*).

## 2. Mapping: "humans join like subagents"

**Path A: the human's own session self-joins.** Probed end to end.

- **Joining.** With the orchestrator's team name `T`, the human runs
  `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 claude --agent-id alice@T --agent-name alice --team-name T`. It started,
  showed an `@alice` badge and polled `inboxes/alice.json`, but never joined the roster: "Cannot set member
  active: member alice not found in team" (*verified-by-probe*).
- **Human→lead works.** The human's Claude calls `SendMessage to:"team-lead"`, and every turn end also sends an
  idle_notification with its final text.
  - Delivery waited until the lead had spawned a real teammate (bob); the poller then delivered both of alice's
    messages (*verified-by-probe*).
  - The human's exact words are not carried, only what alice's Claude wrote. Teams have no `@room` verbatim path.
- **Lead→human fails:** "No agent named 'alice' is reachable" (*verified-by-probe*). It needs a roster entry, which
  docs forbid hand-editing ("overwritten on the next state update"); one would likely work, since SendMessage
  reads "the roster of team" (*inferred*).
- **Identity.** Self-asserted with `--agent-name` and unverified; anyone can claim "bob".
- **Waking.** Once reachable, a lead→human message would be submitted as a turn in the idle human's session, so
  their Claude would act before the human sees it.
- **Consent is inverted.** The human's Bash prompt appeared in the lead's terminal ("Bash command · from a
  subagent … Do you want to proceed?"); the human saw only "Permission request sent to team … leader"
  (*verified-by-probe*). The plan gate is also the reverse of sub-human's (members sign the orchestrator's plan).
- **Visibility.** The lead's panel showed "Message from @alice" and "Teammate @alice finished", but no transcript.
- **Lifetime.** When the lead exited, the team directory was deleted and alice kept running, orphaned, with no
  notice (*verified-by-probe*).

**Path B: the lead spawns one pane teammate per human, and the human types into it via `tmux attach`.**
*Inferred* from split-pane mode.

- It gets real roster membership, two-way SendMessage, TaskStop and idle notifications.
- But it is the lead's process: same account and machine, the lead's spawn prompt, prompts routed to the lead, and
  plans auto-approved. It is a seat the human types into, not the human's own Claude.

## 3. Replaces / simplifies

| Plugin piece | Can teams replace it? | Still needed |
|---|---|---|
| Room log + monitor wake | Partly: the inbox plus the 1 s idle-submit poller | Roster membership for lead→human; a shared feed or history |
| MCP `post`/`read` | Partly: SendMessage plus idle_notification | The human's verbatim words (`@room` hook) |
| Identity hook / ancestry | No: `--agent-name` is self-asserted | Binding at join |
| Plan sign-off gate + hooks | No: teammate→lead direction, auto-approved, teammates can't approve | The whole custom gate |
| Background long work | No: in-process teammates can't background (a self-joined process probably can; *inferred*) | Unchanged |
| `room` subagent / status line | Partly: the lead's panel shows messages and idle state | A feed for the members |

## 4. Limits and risks

- Experimental flag, hidden join flags, and docs forbid editing the team config. Interactive only; no `-p`/SDK.
- One account and filesystem: `~/.claude/teams` is local. Docs: "can't … share a team across sessions".
- The lead is deaf until it holds a spawned teammate (`kCe`). Teams vanish on lead exit; `/resume` drops them.
- Permission prompts and auto-approved plans move to the lead, against "each human keeps their own Claude".
- Mailboxes are plain files any local process can write, and names are unverified.
- Enabling teams turns every named Agent call into a teammate, which breaks the plugin's unnamed-seat design (01).

## 5. Recommendation

**Don't adopt** teams as the join mechanism: native plan approval and permission routing contradict the brief's
consent model, lead→human messaging needs hand-written runtime state, and self-joined members are unverified and
orphaned when the lead exits.

Worth borrowing: idle_notification (post the final answer at every turn end); the plugin monitor already wakes.

**Settling experiment:** use a throwaway `CLAUDE_CONFIG_DIR`, never the real `~/.claude`.

- Setup: the lead spawns one placeholder teammate, a human session self-joins, and you add
  `{name:"alice",agentId:"alice@T"}` to `members`.
- Then test:
  1. Can the lead now `SendMessage to:"alice"`?
  2. Does the entry survive the lead's next config write?
  3. Does alice's Bash prompt still go to the lead under allow rules or `--permission-mode acceptEdits`?
  4. Does alice's ExitPlanMode stay local without `--plan-mode-required`?
- If 1–3 pass, teams could carry messaging only; approval would still need the custom gate.
