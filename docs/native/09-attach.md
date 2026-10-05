# 09 — Session-level "join": `--bg`, `attach`, `agents`, `--resume`/`--fork-session`

Claude Code 2.1.281. Probes ran in `/tmp/native-09/` with `--model haiku`, cost about $0.01, and
everything started was cleaned up (`claude stop`/`rm 7de53237`, tmux `n09-a`/`n09-b` killed).
One leftover: the fork probe wrote `~/.claude/projects/-private-tmp-native-09-w/30cb4fb3….jsonl`.

## 1. Capability

- **`claude --bg [-n NAME] "prompt"`** starts a full *interactive* TUI session with no terminal
  attached, then returns at once. It prints a short id (`backgrounded · 7de53237 · n09-probe`).
  (verified-by-probe)
- **Hosting.** The session runs under a per-user supervisor daemon:
  `daemon(14423) → claude bg-pty-host <pty.sock> 200 50 → claude bg-spare <claim.sock>`.
  The daemon is a pre-warmed spare that is claimed for the session. Sockets live in
  `/tmp/cc-daemon-501/<hash>/`, mode `drwx------`. (verified-by-probe: `ps`, `claude daemon status`,
  `ls -ld`)
- **Daemon control.** `claude daemon status|logs|stop|install|…` manages it. The daemon here
  is "transient, started on-demand by `claude`". (verified-by-probe)
- **Plugins load normally.** A bg session shows `running SessionStart hooks… 0/3` in its
  `claude logs` output, so plugin hooks, monitors and MCP are present. (verified-by-probe)
- **`claude attach <id>`** connects a terminal to the session's PTY. `←` returns to agent view
  and Ctrl+Z drops to the shell; the session keeps running either way. (documented: `attach --help`)
- **`claude logs <id>`** dumps recent raw terminal output (ANSI). `stop|kill` ends the process
  but keeps the conversation. `rm` deletes the session and its worktree. `respawn` restarts it on
  a new CLI version. (documented and verified-by-probe)
- **`claude agents --json [--all] [--cwd P]`** lists every live session, interactive and
  background, with `pid,id,cwd,kind,sessionId,name,status(idle|busy),state(working|blocked|done)`.
  It needs no TTY. (verified-by-probe)
- **Multi-client attach exists natively.** (verified-by-probe) Two `claude attach 7de53237` ran
  at once, as tmux `n09-a` (160 cols) and `n09-b` (120 cols).
  - Both clients rendered the same screen. The 160-col pane was redrawn at 120 cols, so the PTY
    size is shared.
  - Text typed in B appeared live in A's prompt box. Submitting from B ran a turn, and A saw
    `⏺ FROM-B`.
  - Interleaved keystrokes (A:`AAA `, B:`BBB `, A:`aaa`) merged into **one shared draft**:
    `❯ AAA BBB aaa`.
  - It works like `tmux attach` on one session: one input box, one cursor, no per-client view.
- **No author identity.** The transcript user entry for B's prompt carries
  `origin:{kind:"human"}, promptSource:"typed", entrypoint:"cli"`. Nothing names the attaching
  client. (verified-by-probe: jsonl keys)
- **`--resume` of a running bg session is refused.** (verified-by-probe) The message is
  `Session … is running as a background session (7de53237). Run claude attach … or claude stop …
  first … Add --fork-session to branch off a copy instead.` The internal error code is
  `session_held_by_background` (verified-by-source).
- **`--resume <id> --fork-session`** works while the original runs. It created a new session
  `30cb4fb3…` with the full prior context and cache reads of about 40k tokens.
  (verified-by-probe)
- **`--bg --resume <id>`** continues a session in the background under the same id, or "starts a
  copy and says so" if it is already running. (documented: `--help`)
- **`-n/--name`** sets the display name used in the prompt-box rule, the `/resume` picker,
  `claude agents` and the terminal title. It is a label, not an identity. (verified-by-probe:
  `n09-probe` shown on the rule)
- **No parent link.** The bg registry has no parent/child field, and nothing in `agents --json`
  links a bg session to the session that spawned it. (verified-by-probe: JSON fields)
  `launchedBy*`/`spawnedBy` strings refer to subagents and tasks, not bg sessions.
  (verified-by-source)
- **Hidden messaging flag.** `--messaging-socket-path` is described as a "Cross-session
  messaging server path" (verified-by-source). It is covered by another lens, so it was not
  probed here.

## 2. Mapping to "humans join like subagents"

- **Joining.** Two models are possible.
  - (a) **Literal co-attach.** Human B runs `claude attach <orchestrator-id>` and shares the
    orchestrator's own screen and prompt. This is "joining" in the screen-sharing sense, not
    as a participant.
  - (b) **Spawned seat.** The orchestrator runs
    `claude --bg -n alice --append-system-prompt "<room role>" "/sub-human alice CODE"` from its
    Bash tool, which works because the orchestrator here is itself a bg session. It hands Alice
    the id, and Alice runs `claude attach <id>` in her terminal. Her seat is pre-wired: name,
    plugin, room code, model, permission mode, MCP config and worktree are all chosen by the
    orchestrator.
- **Identity.** It does not come for free.
  - In (a), everyone types into one draft, and the transcript can't tell them apart.
  - In (b), identity is per *session*, not per human. Session `alice` is whoever attaches to
    it. The orchestrator knows the mapping because it created it (sessionId ↔ name), which is
    more reliable than today's process-ancestry lookup.
  - Ancestry breaks under (b): the hook process's ancestors are `daemon → bg-pty-host`, not the
    human's shell. The plugin would bind identity by sessionId or the `-n` name instead.
- **Messaging and waking.** Attach adds no channel. The room log, monitor and MCP are still
  needed. The orchestrator can poll `claude agents --json` for each seat's
  `status/state` (`blocked` means a permission prompt or question is waiting).
- **Visibility.** `claude logs <id>` lets the orchestrator snapshot any seat's screen, and
  `agents --json` gives liveness. A human can also co-attach read-mostly to watch the
  orchestrator, but anything they type lands in the shared draft.
- **Approval and consent.** Permission prompts and the ExitPlanMode dialog render in the
  session's PTY, and any attached client can answer them. In (b) only Alice normally attaches,
  so her seat's dialogs are effectively hers. Nothing proves who pressed the key.
- **Doing work.** In (b) each human gets a real, full Claude session, with its own context,
  tools and optional `-w` worktree, that survives their terminal closing. That is closer to
  "each human keeps their own Claude" than today's flow.

## 3. Replaces / simplifies

- **Join ceremony and session bootstrap.** `/sub-human NAME CODE` typed by the human could be
  replaced by the orchestrator spawning the seat (`--bg -n NAME … "/sub-human NAME CODE"`) and
  the human typing `claude attach <id>`. This removes the identity hook's guesswork.
- **Seat liveness and status.** Part of the status-line and monitor work can come from
  `claude agents --json` (`busy/idle`, `working/blocked/done`).
- **Seat cleanup.** `claude stop/rm` replaces any custom teardown.
- **Still needed:**
  - the room log as the attributed message bus;
  - `@room` / `UserPromptSubmit` attribution;
  - the monitor that wakes idle sessions;
  - plan sign-off hooks and the gate.

  Attach carries keystrokes, not messages.

## 4. Limits and risks

- **Same OS user only.** The daemon sockets are `0700` under `/tmp/cc-daemon-<uid>`, so a
  second human must share the machine account (via ssh/tmux as the same user). This is the same
  single-account limit as today. (verified-by-probe)
- **One subscription.** All seats run on the orchestrator user's auth and billing (here
  "Claude Max").
- **Co-attach is a shared keyboard.** There is one draft, one PTY size (the smallest client
  wins), and no turn-taking or author attribution. That rules it out as the multi-human model.
- **No native parent/child link** between the orchestrator and the bg seats it spawns, so the
  plugin must record sessionId ↔ human itself.
- **`--resume`/`--continue` are blocked** on live bg sessions (`session_held_by_background`).
  `--fork-session` copies the context but diverges at once, so it is not a join.
- **Seats need permission handling.** A seat nobody is attached to blocks on permission prompts
  (`state:"blocked"` seen on an unrelated live session). Seats need a permission mode chosen up
  front.
- **Haiku seats run in manual mode.** "auto mode unavailable for this model" (verified-by-probe).
- **Early-stage feature surface.** The bg/daemon features (`bg-spare`, `respawn`, a
  hidden `--messaging-socket-path`) are new, so their exact behaviour may change between
  versions. Calling them experimental is an inference; no flag in the source says so.

## 5. Recommendation

**Adopt now, in one shape: "spawned seat" (model b).** Have the orchestrator spawn one
`claude --bg -n <human>` per participant, preloaded with the plugin and the join command. The
human runs `claude attach <id>` to enter it. Bind identity to the seat's sessionId (and `-n`
name) rather than to process ancestry. Keep the room, the monitor, `@room` and the plan gate.

**Don't adopt** literal multi-client attach (model a) as the way humans join. It is real, but it
is a shared keyboard with no attribution.

**Experiment that settles it:**
1. From an orchestrator session, run
   `claude --bg -n alice --model haiku "/sub-human alice CODE"`.
2. Run `claude attach` to that id from a second terminal.
3. Confirm the plugin's identity hook binds `alice` inside the bg PTY host, where ancestry no
   longer reaches the human's shell. Fix it by keying on sessionId if it does not.
4. Confirm that `@room` posts and ExitPlanMode sign-offs from the attached terminal are attributed
   to alice in the room log.
