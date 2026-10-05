# 02 — Humans as native agents; the orchestrator as a headless background session

Claude Code 2.1.281. Probes ran in `/tmp/n2-02/` with `--model haiku`: two `--bg` sessions, one plugin orchestrator
spawned with `--bg`, one interactive session in tmux `n2-02-alice`, and three attach viewers `n2-02-v1..v3`. Cost was well
under $0.10 (the orchestrator used 2,079 tokens). Everything was stopped and removed with `claude rm`, and the probe room
`~/.sub-human/rooms/macaw-8767` was deleted. Evidence: `claude agents --json`, `claude logs`, `~/.claude/jobs/<id>/state.json`
and `timeline.jsonl`, transcript jsonl keys, and `strings` on the binary.
**Short answer: the native "agent panel" that lists sessions is the agent view (`claude agents`, or ← from any
session).** It lists only daemon-hosted sessions, meaning sessions started with `--bg` or attached. It shows them with a
live model-written status, lets you peek and reply, and Enter attaches. If every seat and the orchestrator run under the
daemon, each human shows up natively as "just another agent". No native mechanism puts a *peer session* into another
session's in-session subagent panel.

## 1. Capability

**The agent view ("fleet view")**
- `claude agents`, or ← on an empty prompt, opens it. Rows are grouped Needs input / Working / Completed, each with a name,
  a one-line `detail` and an age. Space opens a peek showing `detail`/`needs` and a reply box; Enter attaches; ctrl+x deletes
  (verified-by-probe).
- **Status comes from a model.** After each turn a few-shot classifier writes `{state, detail, tempo, needs}` to
  `~/.claude/jobs/<id>/state.json` and appends to `timeline.jsonl` (verified-by-probe and verified-by-source: few-shot
  examples such as `"needs":"reply \`go\` to merge"`).
  - Example: `"detail":"room macaw-8767 open, awaiting member_joined event"`.
  - It can be wrong: one session was marked `blocked … awaiting your PEEK-OK` when it was not waiting (verified-by-probe).
- **Interactive sessions in other terminals are not listed.**
  - The code that would list them (`backend:"peer"`, "Can't attach — this session is running in another terminal") is
    gated by the server flag `tengu_fleetview_peers`, default `false`, and was off here (verified-by-source; the probe
    showed only bg rows).
  - So a human's ordinary session is invisible in the agent view until it is daemon-hosted.

**Pressing ← in an interactive session**
- It shows "Your conversation moved to the background". The daemon starts `--session-id <NEW> --fork-session --resume <old
  jsonl>`, so the human now has **a new sessionId** (84144e7a), and the old terminal becomes an agent-view client
  (verified-by-probe: `ps`).
- When that terminal was killed, the forked session kept running as `background · idle` (verified-by-probe).

**ListAgents (also called ListPeers)**
- It returns one flat, machine-wide list of every local session: `name [ref] · interactive|bg · busy|idle|shell · tmux pane
  · age` (verified-by-probe: 15 rows).
- It has no grouping, no parent/child link and no transcript. "Teammates on your team" appear only under agent teams
  (verified-by-source: tool prompt).

**SendMessage to a bg session nobody is attached to**
- It wakes the session and runs a turn: `› Message from @n2-02-env: …`. The receiver sees the sender as
  `uds:/tmp/cc-socks/<pid>.sock` (verified-by-probe).

**Peek and reply**
- A reply lands as a prompt with `origin:{kind:"human"}, promptSource:"typed"`, the same as an attached keystroke, with no
  author recorded (verified-by-probe: jsonl).

**Environment and flags of `--bg` sessions**
- **Your shell environment is not passed on.** `SUB_HUMAN_HOME` set on `claude --bg` was absent in the session; it had only
  daemon env plus `CLAUDE_CODE_SESSION_KIND=bg`, and the job state shows `providerEnv:{}`. The room was created in
  `~/.sub-human`, not in the given home (verified-by-probe).
- `--settings '{"env":{…}}'` does reach the session (verified-by-probe: `N2PROBE=viasettings`).
- `respawnFlags` keeps `--plugin-dir`, `--agent`, `--permission-mode` and `--name` (verified-by-probe: state.json).

**Agent teams (rechecking round-1 01)**
- Same binary, so nothing has drifted. They are still gated by `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` and the hidden
  `--team-name` flag (verified-by-source).
- Teammates appear in the lead's panel and in ListAgents, but the problems round 1 found remain: lead→self-joined deafness,
  inverted permissions and auto-approved plans. Round 1's "don't adopt" stands.

## 2. Main section: a headless orchestrator, spawned on the first join

**What was run**
```
claude --bg -n <room> --plugin-dir … --agent sub-human:orchestrator --permission-mode plan --model haiku "/sub-human"
```

**What happened**
- It started without a window, ran SessionStart hooks, opened room `macaw-8767` and armed the `room` monitor ("1 monitor
  still running").
- The plugin's title hook renamed it `⬡ macaw-8767 · orch`.
- The transcript records `agentSetting:"sub-human:orchestrator"`. The CLI printed the warning "no agent named
  'sub-human:orchestrator' — spawning with default template", which is **spurious**: the front-end checks the agent name
  before the `--plugin-dir` plugins load (verified-by-probe).

**Who spawns it**
- `join.js` (UserPromptExpansion), when no room is open, can `child_process.spawn('claude', ['--bg', …])` before the model
  runs. This was shown to work from inside a Claude Bash tool (verified-by-probe), and round 1 (09) showed the same from a
  bg session.
- Pass `SUB_HUMAN_HOME` and any task-list ids through `--settings` env, because shell env is dropped.
- The joiner then joins as a member. The orchestrator's short id and invite code go into the room log.

**How members view it**
- ← or `claude agents` shows it with a live detail line. Space peeks, and Enter attaches with full screen and transcript.
- `claude attach <id>` does the same from any terminal, `claude logs <id>` takes a read-only ANSI snapshot, and the
  transcript jsonl can be tailed (verified-by-probe).

**Read-only versus take-over**
- No read-only attach exists: `attach` takes only `<id>`, and the binary has no viewer or read-only mode (verified-by-source).
- Attach is a full take-over. With v2 and v3 attached together, v2's keystrokes appeared in v3's prompt as one shared draft
  sized to the smaller terminal (verified-by-probe, which repeats round 1 09).
- A viewer can therefore type into the orchestrator, answer its dialogs or Esc-interrupt it.
- Peek-reply has the same effect with one keystroke. Only `logs` and the peek panel are passive.

**Lifecycle**
- The orchestrator is owned by the per-user daemon, not by its spawner, and has no parent link.
- When the spawner's terminal dies, it keeps running (verified-by-probe: alice killed, room and orch alive). The daemon
  waits for its bg workers ("daemon waits for them to settle", from `claude daemon status`).
- Done sessions 8–10 days old are still listed here, so nothing auto-stops them (verified-by-probe). Someone must
  `claude stop|rm <id>`. The plugin should do this when the last member leaves or the room closes, using `session-end.js`
  or the orchestrator's own close step.
- Any same-user session can stop it, including ctrl+x in the agent view.

**Cost when idle**
- Zero. Its token count stayed at 2,079 over about 8 idle minutes while the monitor was armed (verified-by-probe). Each
  room event the monitor delivers costs one orchestrator turn plus one small status-classifier call.
- An armed monitor makes the row read `busy · working` permanently (`inFlight.kinds:["monitor"]`), so the native status is
  "working" even when the orchestrator is idle (verified-by-probe).

## 3. Mapping: what would make "a human is just another agent in the panel"

**Seats (members)**
- Make each member daemon-hosted: a spawned `--bg` seat they attach to (09/A3), or a human who presses ← once.
- Then every member and the orchestrator appear in every member's agent view with native status, detail, `needs`, peek and
  attach. That replaces the room row and per-member rows with no plugin code.

**The orchestrator's view of humans**
- ListAgents gives liveness for every seat. `state.json` `detail`/`needs` give "what is alice doing", readable as a file.
- The room log still carries the words, so no proxy rows are needed for the orchestrator, which is headless and has no
  human looking at its panel.

**What remains custom**
- Room-scoping: the agent view is machine-wide. The `⬡ <room> ·` name prefix (already set) is the grouping; `claude agents
  --cwd` filters only by cwd.
- Plan status per member ("⚠ sign-off needed") is not in the native detail line. It belongs to the elicitation form (A1)
  and the `@room`/log path.

## 4. Minimal footprint if adopted

**Delete:** the hold-based row system.
- `lib/rows.js` (384), `mcp/hold.js` (282), `hooks/row-launcher.js`, `row-hold.js`, `row-map.js`, `row-guard.js`,
  `row-common.js` (174 together), `agents/room.md`.
- The `subagentStatusLine` in `settings.json`, plus the row parts of `statusline/`.
- The PreToolUse `Agent|Task`, PostToolUse `Agent|Task`, SubagentStop and row SessionStart hook entries.
- That is about 870 lines and 4 hooks, and it also removes the "Waiting for N background agents" noise.

**Add:** about 30 lines in `join.js`: spawn the orchestrator with `--bg` when no room is open, record its short id in the
room, and `claude stop` it on room close.

**Keep:** the room log, the monitor, `@room`, `signoff.js`/elicitation, the plan gate, and the identity binding.

## 5. Limits and risks

- **Identity.** ← forks to a new sessionId, so the `by-sid` identity index misses after a human backgrounds their session.
  Key identity on the room's member record by name plus the job short id, or re-bind in SessionStart on a fork (inferred).
- **No attribution, no read-only.** Anyone who peeks or attaches can type as the orchestrator or as another member;
  entries are recorded as `human/typed`. This fits the single-OS-account trust model but cannot be audited.
- **Status is a model's guess and can be wrong.** A monitor pins the row at "working".
- **Interactive sessions stay invisible** until `tengu_fleetview_peers` ships. If it ships, members would appear without
  backgrounding, but as unattachable peer rows (inferred from source).
- **Shell env does not reach `--bg`**, which corrects round-1 A3's claim that "launch-time env is set automatically". Use
  `--settings` env.
- **The daemon and agent view are early features.** They can be disabled with `disableAgentView` /
  `CLAUDE_CODE_DISABLE_AGENT_VIEW` (verified-by-source), so the plugin must fall back to a visible window.
- **Leftovers:** probe transcripts remain under `~/.claude/projects/-private-tmp-n2-02-*`.

## 6. Recommendation

**Adopt now:**
- The headless orchestrator: spawned with `--bg` by the first join, viewed via ← / attach / logs, and stopped on room close.
- Drop the hold-based proxy rows in favour of the agent view as the panel.

**Adopt later:** making seats daemon-hosted by default (09/A3), once identity survives the ← fork.

**Don't:** build custom transcript or status rows, or use teams.

**Settling experiment:**
1. `/sub-human alice` in a plain session, with no room open. The join hook spawns `--bg` orch with `--settings` env.
2. bob joins; both press ←.
3. Pass if all of these hold:
   - Both see `⬡ room · orch` in the agent view with a sensible detail.
   - The orchestrator's ListAgents names both members.
   - alice's identity survives the ← fork.
   - The orchestrator is stopped when the last member's SessionEnd fires.
