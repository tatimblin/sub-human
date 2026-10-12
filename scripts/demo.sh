#!/usr/bin/env bash
# demo.sh — drive the slim-build walkthrough scenes S1–S11 with two member seats in detached tmux
# sessions (sh-alice, sh-bob; --film: sh-tristan, sh-jess), and in S11 a third (sh-carol) from a second home, and snap every pane after every
# step (scripts/snap.js → docs/rebuild/screens/).
#
#   scripts/demo.sh [--windows] [--pause] [--only S6[,S7]] [--from S6] [--to S3] [--member-model MODEL] [--no-reset]
#                   (--to: stop after that scene; a fresh run unless --from/--only is given too)
#   scripts/demo.sh --film [--take NAME] [same options]   a trailer take: the story scenes only (S1 S2 S3 S4 S5 S6b S10),
#                   with tristan and jess in the seats (sh-tristan, sh-jess) instead of alice and bob,
#                   seat panes 120×36, prompts typed a key at a time, every pane recorded by scripts/capture.js into
#                   trailer/capture/NAME/ (capture.jsonl + run.json; NAME defaults to take-DATE-TIME) with a marker
#                   per beat. The seats are clones of one git repo (/tmp/sh-demo/origin.git), and S6b builds the
#                   agreed plan: tristan's Claude the store side (listTasks in src/store.js), jess's Claude the HTTP
#                   side (the handler in src/server.js, after an Explore subagent reads the store), each with its own
#                   tests. tristan's Claude pushes and tells jess's; only then does jess's pull, run npm test and push.
#                   Both people pull and run npm test. After jess joins, each opens the room row in the agent panel.
#                   jess is another machine: her seat has its own sub-human home ($BASE/laptop/home) and ssh config,
#                   and S2 joins her over a real ssh link to a private sshd on 127.0.0.1 (scripts/devbox.sh: run as
#                   you, never root, never ~/.ssh): tristan's /sub-human invite shows `/sub-human join devbox ROOM
#                   PIN`, jess types it, tristan's card lets her in, a bare /sub-human seats her. The sshd stops after
#                   S10 (or an abort; a resume starts it again).
#                   Checks run at the end; their verdict goes in run.json.
#   scripts/demo.sh stop            kill the sh-* tmux sessions (never numbered ones), stop a capture and the film's sshd
#
# Seats: SEAT_A opens the room, SEAT_B joins: alice and bob (--film: tristan and jess). S6–S9, S9b and S11 never run
# in --film and keep alice and bob.
# The room's Claude has no tmux seat: the first /sub-human starts it as a `claude --bg` job (claude.CODE). Its "pane" in
# the captures is `claude logs <job>` running in a tmux session sh-claude (read-only: never typed into). Nothing is ever typed into the room's Claude, except in S9, where a viewer runs
# `claude attach <job>` in its own tmux session sh-viewer and types one line to show the refusal.
# Home:     SUB_HUMAN_HOME=/tmp/sh-demo/home (fresh on a full run); seats work in /tmp/sh-demo/<seat>,
#           each a copy of demo/app.pristine. Seats launch with env -i (HOME USER LOGNAME SHELL PATH TERM
#           LANG TMPDIR SUB_HUMAN_HOME).
# --only / --from: run a subset against already-running sessions (scenes depend on earlier state). A subset that
#           includes S1 starts fresh instead (S1 opens the room), e.g. the short run --only S1,S2,S4,S5,S9,S9b,S10.
#           S11's carol has her own home, SUB_HUMAN_HOME=/tmp/sh-demo/home2: another machine, on this one.
# screens/run.json lists the scenes this run planned ({scenes, partial}; a resume adds to it): checks.js skips the
# checks of scenes no invocation planned, and still fails a planned scene with no evidence.
# Scenes: S1–S9, S9b (a multi-line post stays nested), S11 (a seat from a second home over the pipe link), S10
# (S11 runs before S10, which closes the room).
# Waits: every wait is recorded in screens/waits.jsonl. A wait the scene depends on (`need …`) aborts the scene
# on timeout: the panes are snapped as "aborted", the run stops and prints how to resume (--from SCENE). Settles
# before a snap (`settle`) and evidence captures are best-effort. After the run: node scripts/checks.js && node scripts/walkthrough.js
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN="$REPO/plugin/sub-human"
BASE=/tmp/sh-demo
export SUB_HUMAN_HOME="$BASE/home"
HOME2="$BASE/home2"   # S11: carol's home, standing in for another machine
# --film: jess's seat is another machine over ssh. LAPTOP is her machine (her sub-human home, her ssh config and
# known_hosts); DEVBOX is tristan's as ssh reaches it: a private sshd (scripts/devbox.sh) with its own host key and the
# authorized_keys sub-human writes the invite's door and the card's Let in line to (SUB_HUMAN_AUTHORIZED_KEYS).
LAPTOP="$BASE/laptop"; DEVBOX="$BASE/devbox"
SSH_PORT="${SH_DEMO_SSH_PORT:-2222}"
DEVBOX_SH="$REPO/scripts/devbox.sh"
export SNAP_DIR="${SNAP_DIR:-$REPO/docs/rebuild/screens}"
LIB="node $REPO/scripts/demo-lib.js"
SEAT_A=alice; SEAT_B=bob   # the two people: A opens the room, B joins (--film: tristan and jess)
COLS=120; ROWS=40
ROOM_CLAUDE_COLS=200; ROOM_CLAUDE_ROWS=50   # a --bg session renders at 200 columns: claude logs replays that

WINDOWS=0; PAUSE="${SUB_HUMAN_DEMO_PAUSE:-0}"; ONLY=""; FROM=""; TO=""; RESET=1
FILM=0; TAKE=""
MEMBER_MODEL=""   # empty: the seats use the user's default model; --member-model MODEL opts in

case "${1:-}" in
  stop)
    node "$REPO/scripts/capture.js" stop
    for s in $(tmux ls -F '#{session_name}' 2>/dev/null | grep -E '^sh-'); do tmux kill-session -t "$s" && echo "killed $s"; done
    "$DEVBOX_SH" down "$DEVBOX"
    exit 0 ;;
esac

while [ $# -gt 0 ]; do
  case "$1" in
    --windows) WINDOWS=1 ;;
    --pause) PAUSE=1 ;;
    --only) ONLY=",$2,"; shift ;;
    --from) FROM="$2"; shift ;;
    --to) TO="$2"; shift ;;
    --member-model) MEMBER_MODEL="$2"; shift ;;
    --no-reset) RESET=0 ;;
    --film) FILM=1 ;;
    --take) TAKE="$2"; shift ;;
    -h|--help) sed -n '2,42p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done
[ "$FILM" = 1 ] && { SEAT_A=tristan; SEAT_B=jess; }
REMOTE=0; [ "$FILM" = 1 ] && REMOTE=1   # SEAT_B joins from another machine over ssh (S2)
SEATS=("$SEAT_A" "$SEAT_B")
SESSIONS="sh-claude,sh-$SEAT_A,sh-$SEAT_B"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# ---------- film (--film) -----------------------------------------------------------------------
# A trailer take: fixed 120×36 seat panes (the room's Claude's view stays 200×50: claude logs replays a 200-column
# render), typed prompts (demo-lib's SH_DEMO_TYPING), and the seats' Claude Code shows no cwd and no update notice.
# Nothing personal: the seats' git uses a demo-only global config ($BASE/gitconfig, empty) and per-checkout
# user.name/email (SEAT / SEAT@example.invalid). No user settings file is written.
FILM_ENV=""
if [ "$FILM" = 1 ]; then
  COLS=120; ROWS=36
  export SH_DEMO_TYPING=1
  TAKE="${TAKE:-take-$(date +%Y%m%d-%H%M%S)}"
  TAKE_DIR="$REPO/trailer/capture/$TAKE"
  FILM_ENV="CLAUDE_CODE_HIDE_CWD=1 DISABLE_AUTOUPDATER=1 GIT_CONFIG_GLOBAL=$BASE/gitconfig GIT_CONFIG_NOSYSTEM=1"
fi
CAPTURE="node $REPO/scripts/capture.js"
# mark BEAT CAPTION: a marker in the take at this moment (film only)
mark() { [ "$FILM" = 1 ] && $CAPTURE mark "$SCENE" "$1" "$2"; return 0; }
g() { GIT_CONFIG_GLOBAL="$BASE/gitconfig" GIT_CONFIG_NOSYSTEM=1 git "$@"; }   # the seats' git, never the user's config

# film_repo: the seats' checkouts are clones of one bare repo, so each Claude builds in its own checkout and the code
# moves between them the way it does between two people: push, pull
film_repo() {
  local o="$BASE/origin.git" s="$BASE/seed"
  : > "$BASE/gitconfig"
  g init -q --bare -b main "$o" || return 1
  cp -R "$REPO/demo/app.pristine" "$s"
  g -C "$s" init -q -b main && g -C "$s" add -A \
    && g -C "$s" -c user.name=tasks-api -c user.email=tasks-api@example.invalid commit -qm "tasks-api" \
    && g -C "$s" push -q "$o" main || return 1
  rm -rf "$s"
  local seat
  for seat in "${SEATS[@]}"; do
    g clone -q "$o" "$BASE/$seat" || return 1
    g -C "$BASE/$seat" config user.name "$seat"; g -C "$BASE/$seat" config user.email "$seat@example.invalid"
    # S6b: jess pulls with her handler not yet committed (stashed around it), and any pull after a local commit
    # rebases: never a merge commit, never "divergent branches"
    g -C "$BASE/$seat" config pull.rebase true; g -C "$BASE/$seat" config rebase.autoStash true
  done
}

# seat_env (--film): the two machines' environments, one KEY=VALUE per line in $BASE/seat-env/SEAT (launch.sh adds
# them after the defaults, so they win).
#   A, the host: its ssh address is the alias devbox (the invite's line reads `/sub-human join devbox …`, never a user
#      name), the private sshd's host key, the authorized_keys that sshd reads, and its own ssh config (ssh -G devbox
#      names the user for the invite's record)
#   B, another machine: her own sub-human home, her own ssh config (devbox -> 127.0.0.1:SSH_PORT, her known_hosts) for
#      every ssh sub-human runs there, and her machine's name on the host's card
seat_env() {
  mkdir -p "$BASE/seat-env" "$LAPTOP/home"
  printf '%s\n' "SUB_HUMAN_SSH_ADDR=devbox" "SUB_HUMAN_SSH_HOST_KEY=$DEVBOX/ssh_host_ed25519_key.pub" \
    "SUB_HUMAN_AUTHORIZED_KEYS=$DEVBOX/.ssh/authorized_keys" "SUB_HUMAN_SSH_OPTS=-F $DEVBOX/ssh_config" > "$BASE/seat-env/$SEAT_A"
  printf '%s\n' "SUB_HUMAN_HOME=$LAPTOP/home" "SUB_HUMAN_SSH_OPTS=-F $LAPTOP/.ssh/config" \
    "SUB_HUMAN_MACHINE_LABEL=$SEAT_B-laptop" > "$BASE/seat-env/$SEAT_B"
}
# devbox_up / devbox_down (--film): the private sshd (scripts/devbox.sh). up keeps the host key and authorized_keys of
# a resumed take (jess's link pinned that key; her admitted line is in that file). down stops sshd and its sessions;
# with --link (after S10) jess's link daemon first, which would otherwise redial for a while. After an abort her daemon
# is left to redial: a resume (--from) starts sshd again and her link comes back by itself.
devbox_up() { "$DEVBOX_SH" up "$DEVBOX" "$LAPTOP" "$SSH_PORT" >&2; }
devbox_down() {
  if [ "${1:-}" = --link ]; then
    local p; p=$($LIB json-field "$LAPTOP/home/rooms/${ROOM:-none}/link.json" pid 2>/dev/null)
    [ -n "$p" ] && kill "$p" 2>/dev/null
  fi
  "$DEVBOX_SH" down "$DEVBOX" >&2
}

# ---------- sessions ----------------------------------------------------------------------------

write_launcher() {
  mkdir -p "$BASE"
  cat > "$BASE/launch.sh" <<EOF
#!/usr/bin/env bash
# launch.sh SEAT [claude args…] — a clean env: env -i, then only what a login shell would give (SH_SEAT_HOME, when
# set, is that seat's SUB_HUMAN_HOME: S11's second home), then the lines of $BASE/seat-env/SEAT (KEY=VALUE, one
# per line: --film's two machines, seat_env). The tmux
# server's global env may carry CLAUDE_CODE_* vars from whichever Claude Code session started it: a seat
# (and the room's Claude it spawns) must inherit none of them.
seat=\$1; shift
cd "$BASE/\$seat" || exit 1
extra=()
if [ -f "$BASE/seat-env/\$seat" ]; then while IFS= read -r l; do [ -n "\$l" ] && extra+=("\$l"); done < "$BASE/seat-env/\$seat"; fi
exec env -i HOME="$HOME" USER="${USER:-}" LOGNAME="${LOGNAME:-${USER:-}}" SHELL="${SHELL:-/bin/zsh}" \\
  PATH="$PATH" TERM="\${TERM:-xterm-256color}" LANG="${LANG:-en_US.UTF-8}" TMPDIR="${TMPDIR:-/tmp/}" \\
  SUB_HUMAN_HOME="\${SH_SEAT_HOME:-$SUB_HUMAN_HOME}" $FILM_ENV \${extra[@]+"\${extra[@]}"} \\
  claude "\$@"
EOF
  chmod +x "$BASE/launch.sh"
}

claude_args() { # seat [extra…]
  local seat=$1; shift
  printf '%q ' --plugin-dir "$PLUGIN"
  [ -n "$MEMBER_MODEL" ] && printf '%q ' --model "$MEMBER_MODEL"
  # film: S6b's tests and git run with no permission dialog per command (approve-until answers any other dialog)
  [ "$FILM" = 1 ] && printf '%q ' --allowedTools 'Bash(npm test:*)' 'Bash(git add:*)' 'Bash(git commit:*)' 'Bash(git pull:*)' \
    'Bash(git push:*)' 'Bash(git status:*)' 'Bash(git diff:*)' 'Bash(git log:*)' 'Bash(git fetch:*)'
  [ $# -gt 0 ] && printf '%q ' "$@"
}

start_seat() { # seat [extra claude args…]
  local seat=$1; shift
  local s="sh-$seat"
  local cmd="$BASE/launch.sh $seat $(claude_args "$seat" "$@")"
  [ "$seat" = carol ] && cmd="SH_SEAT_HOME=$HOME2 $cmd"   # S11: another machine's home
  if tmux has-session -t "$s" 2>/dev/null; then
    tmux respawn-pane -k -t "$s:" "$cmd"
  else
    tmux new-session -d -s "$s" -x $COLS -y $ROWS "$cmd"
    tmux set-option -t "$s" remain-on-exit on >/dev/null
    tmux set-window-option -t "$s" window-size manual >/dev/null 2>&1
    tmux resize-window -t "$s" -x $COLS -y $ROWS >/dev/null 2>&1
  fi
}

setup() {
  if [ "$RESET" = 1 ]; then
    for s in sh-claude sh-alice sh-bob "sh-$SEAT_A" "sh-$SEAT_B" sh-carol sh-viewer; do tmux kill-session -t "$s" 2>/dev/null; done
    # an aborted run leaves its room's Claude (a claude --bg job started in a seat dir) and dying seats' session-end
    # hooks, which write the old room back into the home after the rm: stop them and wait before resetting
    pkill -f "claude daemon run .*\"cwd\":\"(/private)?$BASE/" 2>/dev/null
    "$DEVBOX_SH" down "$DEVBOX" >/dev/null 2>&1   # an earlier take's sshd
    for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -f "(/private)?$BASE/" >/dev/null || break; sleep 1; done
    rm -rf "$BASE"
    mkdir -p "$SUB_HUMAN_HOME"
    if [ "$FILM" = 1 ]; then film_repo || { echo "film: could not set up the seats' git checkouts" >&2; exit 1; }
    else for seat in "${SEATS[@]}"; do cp -R "$REPO/demo/app.pristine" "$BASE/$seat"; done; fi
    mkdir -p "$SNAP_DIR"; rm -rf "$SNAP_DIR"/*.svg "$SNAP_DIR"/*.txt "$SNAP_DIR"/*.ansi "$SNAP_DIR/index.json" "$SNAP_DIR/waits.jsonl" "$SNAP_DIR/state"
    ls "$HOME/.claude/plans" > "$BASE/plans-before.txt" 2>/dev/null
  fi
  if [ "$REMOTE" = 1 ]; then
    seat_env
    devbox_up || { echo "film: the private sshd for jess's ssh join did not start (scripts/devbox.sh; SH_DEMO_SSH_PORT picks another port)" >&2; exit 1; }
  fi
  write_launcher
  local fresh=()
  for seat in "${SEATS[@]}"; do
    tmux has-session -t "sh-$seat" 2>/dev/null || { start_seat "$seat"; fresh+=("$seat"); }
  done
  [ "$WINDOWS" = 1 ] && open_windows
  for seat in ${fresh[@]+"${fresh[@]}"}; do DEMO_SCENE=setup $LIB ready "sh-$seat" --timeout 90; done
}

open_windows() {
  local tmuxbin; tmuxbin="$(command -v tmux)"
  local i=0
  for seat in "${SEATS[@]}"; do
    open -na Ghostty --args "--title=$seat · sub-human demo" --window-position-x=$(( i * 960 )) --window-position-y=30 \
      --window-width=$COLS --window-height=34 -e "$tmuxbin" attach -r -t "sh-$seat"
    i=$((i + 1))
  done
}

# ---------- step helpers ------------------------------------------------------------------------

# claude_view — the room Claude's read-only "pane": a tmux session that runs `claude logs <job>` (a passive stream of
# the background session's terminal; nothing is ever typed there). Restarted if the stream ends.
# In --film the fresh view paints in sh-claude-next first, then takes sh-claude's name: the recording never sees an
# empty view.
claude_view() {
  local job; job=$(claude_job); [ -n "$job" ] || return 1
  local s=sh-claude
  [ "$FILM" = 1 ] && tmux has-session -t sh-claude 2>/dev/null && s=sh-claude-next
  tmux kill-session -t "$s" 2>/dev/null
  tmux new-session -d -s "$s" -x "${ROOM_CLAUDE_COLS:-$COLS}" -y "${ROOM_CLAUDE_ROWS:-$ROWS}" \
    "while :; do env -i HOME=\"$HOME\" USER=\"$USER\" LOGNAME=\"${LOGNAME:-$USER}\" PATH=\"$PATH\" TERM=xterm-256color LANG=\"${LANG:-en_US.UTF-8}\" claude logs $job; sleep 2; done"
  tmux set-window-option -t "$s" window-size manual >/dev/null 2>&1
  tmux resize-window -t "$s" -x "${ROOM_CLAUDE_COLS:-$COLS}" -y "${ROOM_CLAUDE_ROWS:-$ROWS}" >/dev/null 2>&1
  if [ "$s" = sh-claude-next ]; then
    paint sh-claude-next 2
    tmux kill-session -t sh-claude 2>/dev/null
    tmux rename-session -t sh-claude-next sh-claude
  fi
}

claude_job() { $LIB member-field claude job 2>/dev/null | tr -d '\n'; }

snap() { # caption — capture the panes (the room's Claude via claude logs), and keep this step's state as evidence
  local job; job=$(claude_job)
  # a fresh `claude logs` each time: its first screen is a full repaint (a long-running stream drifts)
  claude_view && paint sh-claude 2
  node "$REPO/scripts/snap.js" "$SESSIONS" "$SCENE" "$1"
  local r; r=$(room); [ -n "$r" ] || return 0
  STEP=$((STEP + 1))
  local d="$SNAP_DIR/state/$SCENE/$STEP"   # this step's evidence (checks.js reads state/SCENE/N)
  mkdir -p "$d"
  cp "$SUB_HUMAN_HOME/rooms/$r/members.json" "$SUB_HUMAN_HOME/rooms/$r"/rows/*.json "$d/" 2>/dev/null || true
  # B on another machine (--film): B's rows are session-local, in B's mirror there (holds-B, notices-B, …)
  [ "$REMOTE" = 1 ] && cp "$LAPTOP/home/rooms/$r"/rows/*"-$SEAT_B".json "$d/" 2>/dev/null
  cp "$SUB_HUMAN_HOME/rooms/$r/tasks.json" "$d/" 2>/dev/null || true
  claude agents --json > "$d/agents.json" 2>/dev/null || true
  "$PLUGIN/scripts/sub-human" tasks --room "$r" > "$d/sub-human-tasks.txt" 2>&1 || true
  mkdir -p "$d/native-tasks"; cp "$HOME/.claude/tasks/sh-$r"/*.json "$d/native-tasks/" 2>/dev/null || true
  ls "$HOME/.claude/plans" > "$d/plans.txt" 2>/dev/null || true   # the session plan files: a review restores the seat's
  cp "$BASE/plans-before.txt" "$SNAP_DIR/state/plans-before.txt" 2>/dev/null || true
}

# dismiss_question SEAT — a seat's Claude may open its own AskUserQuestion (e.g. to relay a room Claude question to its
# person); typing a scripted line into it would pick an option instead of posting (run ocelot-0728). Esc it — never
# a proposal (plan view or card), which only card_answer answers.
dismiss_question() {
  local p; p=$(tmux capture-pane -p -t "sh-$1:" 2>/dev/null)
  if command grep -q "Esc to cancel" <<<"$p" && ! command grep -Eq "$CARD_RE" <<<"$p"; then
    keys "$1" Escape; $LIB wait-pane "sh-$1" "Esc to cancel" --absent --timeout 10 --what "$1: its own question closed" >/dev/null 2>&1
  fi
}
submit() { $LIB wait-idle "sh-$1" --timeout 45 --quiet 2 >/dev/null 2>&1; dismiss_question "$1"; $LIB submit "sh-$1" "$2"; }   # submit SEAT TEXT (once the seat is idle)
keys() { local s=$1; shift; $LIB keys "sh-$s" "$@"; }
wait_log() { $LIB wait-log "$@"; }
wait_pane() { local s=$1 re=$2 t=${3:-60}; shift 2; [ $# -gt 0 ] && shift; $LIB wait-pane "sh-$s" "$re" --timeout "$t" "$@"; }

# need CMD… — a wait the scene depends on: on timeout, note why and return 1 (the scene then returns: `need … || return 1`)
ABORT=""
need() { "$@" && return 0; ABORT="$SCENE: timed out waiting: $*"; return 1; }
# settle SEAT… — best-effort: each seat's pane idle and unchanged for 2 s (max 30 s) before a snap
settle() { local s; for s in "$@"; do $LIB wait-idle "sh-$s" --timeout 30 --quiet 2 --what "$s settled before the snap" >/dev/null 2>&1; done; return 0; }
# paint SESSION [QUIET] — best-effort: a fresh view's first paint is done (the pane has text, unchanged for QUIET s, 1; max 15 s)
paint() { $LIB wait-paint "$1" --quiet "${2:-1}" --timeout 15 >/dev/null 2>&1; return 0; }
# record WHAT [ok|fail] — one line in waits.jsonl for a driver step that is not a wait
record() { $LIB record --what "$1" --ok "$([ "${2:-ok}" = ok ] && echo true || echo false)"; }

# exit_seat SEAT — /exit, then answer Claude Code's own "Background work is running" dialog (the room row
# is a background agent) with "1. Exit and stop tasks": that ends the session and logs member_left.
exit_seat() {
  submit "$1" "/exit"
  wait_pane "$1" "❯ 1\. Exit and stop tasks" 20 || return 0
  sleep 0.5   # the dialog takes keys a moment after it draws; nothing on screen marks that
  keys "$1" Enter
}

ROOM=""
room() { [ -n "$ROOM" ] || ROOM=$($LIB wait-room --timeout 5 2>/dev/null); echo "$ROOM"; }
panel_row() { echo "^\s*(❯\s*)?(└\s*)?[⏺◯]\s+$1(\s|$)"; }   # a row line in the agent panel
CARD_RE='Agree to proposal [0-9a-f]{12}\?|Would you like to proceed\?'   # the fallback card, or the plan view a proposal opens in

# wait_card SEAT WHAT — wait for SEAT's proposal to open (the plan view; the card as fallback); if its Claude has not
# opened it in 120 s, the person asks once ("show me proposal …"; recorded in waits.jsonl as a nudge) and the wait runs again.
wait_card() {
  wait_pane "$1" "$CARD_RE" 120 --what "$2" && return 0
  local h; h=$($LIB last-id --kind proposal --field hash 2>/dev/null)
  record "nudge: $1 asked for the card"
  submit "$1" "show me proposal ${h:-the open proposal}"
  wait_pane "$1" "$CARD_RE" 120 --what "$2 (after the nudge)"
}

# card_answer SEAT CHOICE [NOTE] — answer the open proposal: Not yet (Esc) / Agree (the "Yes" that keeps the mode) /
# Object + note ("Tell Claude what to change"); on the fallback card, its own options
# DWELL (film, S5's revision): paging the plan view, rest 1.5 s on the first page that matches it
DWELL=""
card_answer() { $LIB card "sh-$1" "$2" "${3:-}" ${DWELL:+--dwell "$DWELL"}; }

# show_room SEAT OTHER (film): the person opens the room row in their agent panel (↓ onto it, Enter), and the members
# show inside it (└ OTHER). A 2 s look, then back: ↑ to main and Enter (the room view closes, the cursor stays on main),
# then one ↑ to the prompt. One only: a second ↑ with the focus already on the prompt recalls the last prompt (S7, S8).
show_room() {
  local s=$1 o=$2
  need $LIB wait-idle "sh-$s" --timeout 60 || return 1
  need $LIB select-row "sh-$s" "$(room)" || return 1
  keys "$s" Enter
  need wait_pane "$s" "^\s*└\s*[⏺◯●]\s+$o(\s|$)" 15 --what "$s's panel shows $o inside the $(room) row" || return 1
  mkdir -p "$SNAP_DIR/state/$SCENE"; $LIB pane "sh-$s" > "$SNAP_DIR/state/$SCENE/panel-$s.txt"
  sleep 2   # the look (no paint wait: the row's view keeps a live spinner and token count)
  need $LIB select-row "sh-$s" main --key Up || return 1
  keys "$s" Enter
  need wait_pane "$s" "─ $(room) ─" 10 --absent --what "$s's room view closed" || return 1
  need wait_pane "$s" "^❯\s+[⏺◯●]\s+main(\s|$)" 5 --what "$s's panel cursor stays on main" || return 1
  keys "$s" Up
  need wait_pane "$s" "^❯\s+(└\s*)?[⏺◯●]\s" 5 --absent --what "$s's focus is back on the prompt" || return 1
}

# ---------- scenes ------------------------------------------------------------------------------

S1() { # A joins with no room open: the room is created and the headless room's Claude spawned
  local a=$SEAT_A
  mark open "$a opens a room; the room gets its own Claude"
  submit "$a" "/sub-human $a"
  ROOM=$($LIB wait-room --timeout 60)
  [ -n "$ROOM" ] || { ABORT="S1: no room dir after /sub-human $a (60 s)"; return 1; }
  export SUB_HUMAN_ROOM="$ROOM"
  need wait_log --kind member_joined --from "$a" --timeout 60 || return 1
  need $LIB wait-member claude pid --not "" --timeout 120 --what "the room's Claude job binds as member claude" || return 1
  claude_view
  need wait_pane "$a" "$(panel_row "$(room)")" 90 || return 1
  need $LIB wait-holds claude "$a" --timeout 120 || return 1
  need $LIB wait-native-task "room $(room) open" --timeout 120 || return 1
  settle "$a"
  snap "$a runs /sub-human $a: room $(room) opened, the room's Claude started in the background; one $(room) row in $a's panel, a $a row in the room Claude's panel"
}

S2() { # B joins (--film: from another machine, over ssh: S2_ssh)
  local a=$SEAT_A b=$SEAT_B
  if [ "$REMOTE" = 1 ]; then S2_ssh || return 1
  else
    mark join "$b joins from another session"
    submit "$b" "/sub-human $b"
  fi
  need wait_log --kind member_joined --from "$b" --timeout 60 || return 1
  # the join as a group-chat line in A's pane ("sub-human: B joined": the hooks module's $.ui.log notice, no
  # model turn); kept as evidence
  mkdir -p "$SNAP_DIR/state/S2"
  wait_pane "$a" "^\s*(⏺ |⎿ )?(sub-human: )?$b joined\s*$" 60 --what "$a sees the chat line \"$b joined\"" && $LIB pane "sh-$a" > "$SNAP_DIR/state/S2/notice-$a.txt"
  need wait_pane "$b" "$(panel_row "$(room)")" 90 || return 1
  need $LIB wait-holds claude "$b" --timeout 120 || return 1
  need $LIB wait-holds "$a" "$b" --timeout 90 || return 1
  settle "$a" "$b"
  snap "$b joins: $b nested in $a's room row, $a in $b's; the room's Claude lists both"
  if [ "$FILM" = 1 ]; then
    mark panel "Everyone in the room shows up in your agent panel"
    show_room "$a" "$b" || return 1
    show_room "$b" "$a" || return 1
  fi
}

# S2_ssh (--film): B joins A's room from her machine over ssh. A's /sub-human invite shows A one line with a 4-digit PIN
# (to A only: the hook's hidden reply, never A's Claude); the driver reads it off A's pane (never through a model) and
# B types it: her link runs the PIN check through the host's enrollment door over ssh (scripts/devbox.sh's sshd), and
# A's card asks "Let B … on B-laptop join room …?"; A answers Let in (demo-lib admit-card: the person's own answer on the
# card); once B's link is in (the host's line "B's machine (…) joined the room"), a bare /sub-human takes her seat.
S2_ssh() {
  local a=$SEAT_A b=$SEAT_B
  local before; before=$($LIB log-max)
  local d="$SNAP_DIR/state/S2"; mkdir -p "$d"
  mark invite "$a invites $b's machine: one line with a PIN"
  submit "$a" "/sub-human invite"
  need wait_pane "$a" "invite to room $(room) for one machine, over ssh devbox" 30 --what "$a's pane shows the ssh invite (to $a, never to $a's Claude)" || return 1
  local line; line=$($LIB join-line "sh-$a")
  [[ "$line" =~ ^join\ devbox\ $(room)\ [0-9]{4}$ ]] || { ABORT="S2: no \"join devbox $(room) PIN\" line readable in $a's pane (read: ${line:-nothing})"; return 1; }
  echo "$line" > "$d/join-line.txt"   # the checks look for its PIN in every transcript (it must be in none)
  record "the driver read $a's invite line off $a's pane"
  settle "$a"
  snap "$a runs /sub-human invite: one line for $b's machine, /sub-human join devbox $(room) and a 4-digit PIN, shown to $a only"
  mark join "$b joins from her machine over ssh"
  submit "$b" "/sub-human $line"
  need wait_pane "$b" "checked your PIN" 90 --what "$b's link ran the PIN check with the host over ssh; $a's card asks" || return 1
  settle "$b"
  snap "$b types the line: her machine checks the PIN with the host over ssh (her Claude never sees it); a card on $a's machine asks"
  mark card "$a lets her in"
  need $LIB admit-card "sh-$a" --timeout 120 || return 1
  need wait_log --kind status --from room --text-has "$b's machine (" --after "$before" --timeout 60 --what "$b's link connects over ssh once let in (the host's line)" || return 1
  $LIB link-shape "$LAPTOP/home/links/$(room).json" > "$d/link-file.json" 2>/dev/null
  mark seated "$b takes her seat in the room"
  submit "$b" "/sub-human"
  local tries=0
  until $LIB wait-log --kind member_joined --from "$b" --after "$before" --timeout 20 >/dev/null 2>&1 || [ $tries -ge 3 ]; do
    record "$b's seat: /sub-human again" fail
    submit "$b" "/sub-human"
    tries=$((tries + 1))
  done
  cp "$LAPTOP/home/machine.json" "$d/machine-$b.json" 2>/dev/null
  cp "$SUB_HUMAN_HOME/machine.json" "$d/machine-host.json" 2>/dev/null
  return 0
}

# The people's scripted words. The checks compare the log against them byte for byte: demo.sh writes them into
# screens/run.json ("words"; checks/context.js reads them there, alice and bob's are its defaults).
if [ "$FILM" = 1 ]; then
  SAY3="$SEAT_B, can you take the HTTP side of paging? I'll do the store"
  ASK3="ask $SEAT_A's Claude how createTask in store.js picks ids. just ask, change nothing"
  PLAN4="let's plan cursor paging for GET /tasks: $SEAT_A does the store, I do the HTTP side"
  # when the room's Claude asks before it proposes (each person answers once, by @claude): each for their own half
  ANSWER_A="@claude listTasks({limit, after}) in store.js: newest first by createdAt then id, opaque cursor"
  ANSWER_B="@claude ?limit&after, default 20, max 50, {items, nextCursor}. propose it to $SEAT_A and me"
  NOTE5='a garbled cursor like `after=zzz` must 400, not 500 — add a test for it'
else
  SAY3="$SEAT_B, can you take the parser tests? handler's in src/server.js"
  ASK3="ask $SEAT_A's Claude how createTask in src/store.js picks ids. just ask, change nothing"
  PLAN4="let's plan cursor paging for GET /tasks: ?limit&after, opaque cursor, newest first"
  ANSWER_A="@claude default 20, max 50, {items, nextCursor}; a cursor past the end returns an empty page"
  ANSWER_B="@claude fine with that; 400 on a bad cursor. please propose it to $SEAT_A and me"
  NOTE5="add a test for a cursor past the end — \`after=zzz\` must 400, not 500"
fi
REPLY3="sure, once we've agreed how paging works"
DWELL5="$SEAT_B asked|400, not 500"   # S5's revision: the page with B's note (in the room's Claude's words, so either)

S3() { # pairing with no plan: @room both ways, then Claude↔Claude SendMessage
  local a=$SEAT_A b=$SEAT_B
  local before; before=$($LIB log-max)
  mark talk "$a asks $b in the room, in plain words"
  submit "$a" "@room $SAY3"
  need wait_log --kind say --from "$a" --via human --after "$before" --timeout 30 || return 1
  wait_pane "$a" "✓ sent" 15
  # the first words of it (no regex characters in them)
  need wait_pane "$b" "$a: ${SAY3:0:30}" 60 --what "$b's pane shows $a's exact words as a chat line" || return 1
  need $LIB wait-idle "sh-$b" --timeout 90 || return 1
  settle "$a"
  snap "$a posts with @room: one receipt line for $a (✓ sent), $b's pane shows \"$a: …\" with the exact words"
  mark reply "$b answers: once they agree how paging works"
  submit "$b" "@room $REPLY3"
  need wait_log --kind say --from "$b" --via human --after "$before" --timeout 30 || return 1
  need $LIB wait-idle "sh-$a" --timeout 90 || return 1
  mark claudes "$b's Claude asks $a's Claude directly"
  submit "$b" "$ASK3"
  # the engine's "Message from @B.CODE", or the hooks module's drawing of that peer row (mod/render.ts: "B's Claude: …")
  need wait_pane "$a" "Message from @?$b\.|^\s*$b's Claude: " 120 --what "$a's pane shows a message from $b's Claude" || return 1
  need $LIB wait-idle "sh-$a" --timeout 120 || return 1
  need wait_pane "$b" "Message from @?$a\.|^\s*$a's Claude: " 120 --what "$b's pane shows $a's Claude's answer" || return 1
  need $LIB wait-idle "sh-$b" --timeout 120 || return 1
  settle "$a" "$b"
  snap "$b's Claude asks $a's Claude natively (SendMessage to $a.$(room)); $a's Claude answers. No card, no turn for the room's Claude"
}

S4() { # let's plan: B @claude → the room's Claude proposes → each approver reads it in the plan view
  local a=$SEAT_A b=$SEAT_B
  local before; before=$($LIB log-max)
  mark plan "$b asks the room's Claude to plan cursor paging"
  submit "$b" "@claude $PLAN4"
  need wait_log --kind say --from "$b" --via human --after "$before" --timeout 30 || return 1
  if ! wait_log --kind proposal --from claude --after "$before" --timeout 150 --what "the room's Claude proposes (or asks first)"; then
    # the room's Claude asked the people first (post to=NAME or SendMessage): each answers in one @claude line
    mark questions "The room's Claude asks them first; each answers"
    snap "The room's Claude asks $a and $b before it writes the plan"
    local seat answer
    for seat in "$a" "$b"; do
      answer=$ANSWER_A; [ "$seat" = "$b" ] && answer=$ANSWER_B
      need $LIB wait-idle "sh-$seat" --timeout 60 || return 1
      local n; n=$($LIB log-max)
      submit "$seat" "$answer"
      need wait_log --kind say --from "$seat" --via human --after "$n" --timeout 30 || return 1
    done
    need wait_log --kind proposal --from claude --after "$before" --timeout 420 --what "the room's Claude writes a plan and proposes it" || return 1
  fi
  need wait_card "$a" "$a's card is open" || return 1
  mark proposal "The plan opens for $a and $b to review"
  need wait_card "$b" "$b's card is open" || return 1
  paint "sh-$a"; paint "sh-$b"   # the plan view's first paint (wait-idle counts an open plan view as busy)
  snap "The room's Claude proposes its plan: it opens in $a's and $b's native plan view, all of it scrollable (Yes / Tell Claude what to change / Esc)"
  read_plan "$a"
}

# read_plan SEAT — page through the open plan view with PgDn to its end (the hook's "room proposal HASH" line),
# snapping SEAT's pane after each page, so the walkthrough shows every part of the proposal is readable
read_plan() {
  local i=0
  while [ $i -lt 15 ] && ! $LIB pane "sh-$1" | command grep -Eq "room proposal [0-9a-f]{12}"; do
    keys "$1" PageDown; paint "sh-$1"; i=$((i + 1))
    node "$REPO/scripts/snap.js" "sh-$1" "$SCENE" "$1 reads the whole proposal in the plan view: PgDn, page $((i + 1))"
  done
  local ok=fail; $LIB pane "sh-$1" | command grep -Eq "room proposal [0-9a-f]{12}" && ok=ok
  record "$1 paged to the end of the proposal (${i}× PgDn)" "$ok"
}

S5() { # B objects with a note, A agrees; the room's Claude revises; both agree → decision
  local a=$SEAT_A b=$SEAT_B
  local p1; p1=$($LIB last-id --kind proposal)
  mark answers "$a agrees; $b objects with a note"
  need card_answer "$a" Agree || return 1
  need wait_log --kind signoff --from "$a" --via human --after "$p1" --timeout 30 || return 1
  need card_answer "$b" Object "$NOTE5" || return 1
  need wait_log --kind objection --from "$b" --via human --after "$p1" --timeout 30 || return 1
  settle "$a" "$b"
  snap "$a agrees; $b objects with a note (via=human, byte-exact)"
  need wait_log --kind proposal --from claude --after "$p1" --timeout 420 --what "the room's Claude revises and proposes again" || return 1
  mark revision "The room's Claude revises the plan"
  need wait_card "$a" "$a's card for the revision" || return 1
  need wait_card "$b" "$b's card for the revision" || return 1
  paint "sh-$a"; paint "sh-$b"   # the plan view's first paint
  snap "The room's Claude revises: a new proposal, opened again for each"
  local p2; p2=$($LIB last-id --kind proposal)
  [ "$FILM" = 1 ] && DWELL="$DWELL5"   # each stops on the page with B's note before paging on
  need card_answer "$a" Agree || { DWELL=""; return 1; }
  need wait_log --kind signoff --from "$a" --via human --after "$p2" --timeout 30 || { DWELL=""; return 1; }
  need card_answer "$b" Agree || { DWELL=""; return 1; }
  DWELL=""
  need wait_log --kind decision --after "$p2" --timeout 30 || return 1
  mark agreed "Both agree: the decision is logged"
  need $LIB wait-idle "sh-$a" --timeout 90 || return 1
  need $LIB wait-idle "sh-$b" --timeout 90 || return 1
  sleep 6   # the decision's notice reaches both seats after they go idle; it draws no pane text to wait on
  snap "Both agree to the revision: a decision is logged; both Claudes are told once"
}

S6() { # shared tasks: alice's Claude adds, then claims, the room's Claude applies natively; a non-owner done is refused; owner done
  local before; before=$($LIB log-max)
  # explicit tool name: in run osprey-3059 the model used post ("taking this") instead of the task tool. add leaves
  # the task pending with no owner (lynx-5140), and claim needs its id: so add, then claim by id.
  submit alice "put \"cursor paging handler\" on the room task list: call the mcp__plugin_sub-human_room__task tool with op \"add\", subject \"cursor paging handler\". Only that tool call: do not use post, do not edit any file"
  need wait_log --kind task_req --from alice --after "$before" --timeout 120 || return 1
  need wait_log --kind task --after "$before" --timeout 180 --what "the room's Claude applies the add natively (task entry)" || return 1
  local t; t=$($LIB task-id)
  local b1; b1=$($LIB log-max)
  submit alice "claim it for me: call the mcp__plugin_sub-human_room__task tool with op \"claim\", id \"$t\". Only that tool call: do not start the work, do not edit any file"
  need wait_log --kind task_req --from alice --after "$b1" --timeout 120 || return 1
  need $LIB wait-tasks --owner alice --status in_progress --timeout 180 || return 1
  # the room row's task summary (what the S6 check reads); best-effort
  wait_pane alice "$(room).*(tasks? [0-9]+ open|#[0-9]+ you)" 30 --what "alice's room row shows the task summary"
  settle alice
  snap "alice's Claude calls task(add), then task(claim #$t): the room's Claude applies each with TaskCreate/TaskUpdate; the room row and sub-human tasks show it"
  local b2; b2=$($LIB log-max)
  # explicit: the model may otherwise answer in text and never calls the tool (learning run badger-3918); honest
  # evidence: with "I ran the tests, 3/3 pass" bob's Claude declined to send a claim it had not checked (run falcon-2880)
  submit bob "call the mcp__plugin_sub-human_room__task tool now with op \"done\", id \"$t\", evidence \"bob checking the owner gate; no tests run\". It is alice's task: I want to see that the room refuses it. Send the request anyway and report the tool's reply in one line"
  need wait_log --kind task_req --from bob --after "$b2" --timeout 120 || return 1
  need $LIB wait-claude-idle --after "$b2" --timeout 180 || return 1
  mkdir -p "$SNAP_DIR/state/S6"; $LIB synthetic-gate "$t" > "$SNAP_DIR/state/S6/gate-bob.json"
  settle bob
  snap "bob's Claude asks done on alice's task #$t: refused, the task stays in progress"
  local b3; b3=$($LIB log-max)
  submit alice "the handler is in and npm test passes 3/3. call the mcp__plugin_sub-human_room__task tool with op \"done\", id \"$t\", evidence \"handler in, npm test 3/3 pass\". Only that tool call: do not edit or check any file"
  need wait_log --kind task_req --from alice --after "$b3" --timeout 120 || return 1
  need $LIB wait-tasks --id "$t" --status completed --timeout 180 || return 1
  settle alice
  snap "alice's Claude asks done with evidence: the room's Claude completes #$t (the gate passes the owner's request)"
}

# S6b (--film only): the agreed plan, built, real code on both sides. A's Claude puts the plan's two halves on the room
# task list, one for each person; each Claude claims its own and builds it in its own checkout, with its own tests:
#   A (tristan): the store side, listTasks({limit, after}) in src/store.js + test/store-paging.test.js
#   B (jess):    the HTTP side, GET /tasks in src/server.js + test/server-paging.test.js, written against the agreed
#                listTasks after an Explore subagent of its own reads the store (its row shows in B's panel)
# The handoff is real and on screen: A's Claude pushes and tells B's Claude; B's Claude pulls only then, runs npm test
# over both halves, commits and pushes. The driver waits on the state itself (A's commit on the origin, B's checkout
# holding it). Then A and B pull and run npm test themselves (Claude Code's ! bash mode), and the driver re-runs it in
# both checkouts as evidence (state/S6b). The prompts are what a person would type, with no tool names. Which task is
# whose comes from the log (A's add request names the owner, the room's Claude's add cites the request), so the subjects
# can be the Claude's own words.
RUN6b="git pull && npm test"
# node --test's summary under a run: ℹ pass 6 / ℹ fail 0 / … / ℹ duration_ms 81.2 (the duration makes each run's its own)
PASS6b='[ℹ#] pass [1-9][0-9]*\s*\n\s*(⎿\s*)?[ℹ#] fail 0\s*\n(\s*[ℹ#] [a-z]+ [0-9]+\s*\n){0,4}\s*[ℹ#] duration_ms [0-9.]+'

stop_bg() { pkill -P "$1" 2>/dev/null; kill "$1" 2>/dev/null; return 0; }   # a background ( … ) and what it runs

# wait_commit DIR AUTHOR TIMEOUT WHAT — wait until DIR's main (a checkout's, or the origin's) has a commit by AUTHOR;
# recorded in waits.jsonl either way
wait_commit() {
  local dir=$1 who=$2 t=$3 what=$4 i=0
  while :; do
    if [ -n "$(g -C "$dir" log --format=%H --author="^$who " main 2>/dev/null | head -n 1)" ]; then
      record "$what (${i} s)"; printf '  ✓ %s (%ss)\n' "$what" "$i" >&2; return 0
    fi
    [ "$i" -ge "$t" ] && break
    sleep 1; i=$((i + 1))
  done
  record "$what: timed out (${t} s)" fail; printf '  ✗ timeout %ss: %s\n' "$t" "$what" >&2; return 1
}

S6b() {
  [ -d "$BASE/origin.git" ] || { ABORT="S6b: the seats are not git checkouts (S6b needs a --film run from S1)"; return 1; }
  local a=$SEAT_A b=$SEAT_B
  local before; before=$($LIB log-max)
  local d="$SNAP_DIR/state/S6b" seat; mkdir -p "$d"
  mark split "$a's Claude splits the plan: the store for $a, the handler for $b"
  submit "$a" "the plan's agreed. split it into two tasks on the room's task list: the store for me, the HTTP handler for $b. just the tasks for now"
  need wait_log --kind task_req --from "$a" --after "$before" --count 2 --timeout 120 --what "$a's Claude asks for both tasks" || return 1
  local h t
  h=$($LIB task-for --owner "$a" --after "$before" --timeout 180 --what "the room's Claude adds $a's task (the store)")
  t=$($LIB task-for --owner "$b" --after "$before" --timeout 180 --what "the room's Claude adds $b's task (the handler)")
  [ -n "$h" ] && [ -n "$t" ] || { ABORT="S6b: the room's Claude did not add one task for $a and one for $b"; return 1; }
  settle "$a"
  snap "$a's Claude puts the agreed plan's two halves on the room task list: #$h the store, #$t the handler"

  mark build "Each Claude builds its half in its own checkout"
  submit "$a" "claim #$h and build listTasks as agreed, in src/store.js and test/store-paging.test.js only. once npm test passes, commit and push to main, tell $b's Claude it's pushed, then mark #$h done with that run"
  # B's Claude sends an Explore subagent first: watch B's panel for its row from before B types, and mark the beat
  # the moment it shows (the S6b check reads the saved pane)
  ( $LIB wait-subagent-row "sh-$b" --save "$d/panel-subagent-$b.txt" --timeout 900 --what "$b's panel shows $b's Claude's own subagent" > "$d/subagent-rows-$b.txt" \
    && mark subagent "$b's Claude sends a subagent to read the store first" ) &
  local ps=$!
  submit "$b" "claim #$t. send an Explore agent to read src/store.js, then build the handler against the agreed listTasks, in src/server.js and test/server-paging.test.js only. when $a's Claude says the store's pushed, pull main, run npm test, commit and push to main, and mark #$t done with that run"
  # play both people while their Claudes work: any permission dialog gets "Yes" until that seat's task is completed
  $LIB approve-until "sh-$a" --task-done "$h" --timeout 900 & local pa=$!
  $LIB approve-until "sh-$b" --task-done "$t" --timeout 900 & local pb=$!
  local fail=""
  if ! $LIB wait-tasks --id "$h" --owner "$a" --status in_progress --timeout 180 || ! $LIB wait-tasks --id "$t" --owner "$b" --status in_progress --timeout 180; then
    fail="the claims of #$h ($a) and #$t ($b) were not applied"
  fi
  [ -z "$fail" ] && mark claimed "Each claims its own task on the room's list"
  # the handoff, on the state itself: A's commit reaches the origin, A's Claude's message shows in B's pane, then B's
  # checkout holds A's commit (B's Claude pulled)
  [ -z "$fail" ] && { wait_commit "$BASE/origin.git" "$a" 900 "$a's Claude pushes $a's commit to the origin" || fail="$a's commit never reached the origin (900 s)"; }
  if [ -z "$fail" ]; then
    mark pushed "$a's Claude pushes the store"
    wait_pane "$b" "Message from @?$a\.|^\s*$a's Claude: " 180 --new --what "$b's pane shows $a's Claude's message (the store is pushed)" \
      && mark handoff "$a's Claude tells $b's: the store is pushed"
    wait_commit "$BASE/$b" "$a" 900 "$b's checkout holds $a's commit ($b's Claude pulled)" || fail="$b's checkout never got $a's commit (900 s)"
  fi
  [ -z "$fail" ] && mark pulled "$b's Claude pulls it and runs the tests on both halves"
  if [ -z "$fail" ]; then wait "$pa" || fail="$a's task #$h was not completed (900 s)"; fi
  if [ -z "$fail" ]; then wait "$pb" || fail="$b's task #$t was not completed (900 s)"; fi
  if [ -n "$fail" ]; then kill "$pa" "$pb" 2>/dev/null; stop_bg "$ps"; ABORT="S6b: $fail"; return 1; fi
  [ -s "$d/panel-subagent-$b.txt" ] || { stop_bg "$ps"; record "$b's panel showed no subagent row while $b's Claude built" fail; }
  mark tested "Both halves pass together: both tasks done"
  need $LIB wait-idle "sh-$a" --timeout 180 || return 1
  need $LIB wait-idle "sh-$b" --timeout 180 || return 1
  snap "Both halves built: $a's Claude completes #$h (the store) and $b's Claude #$t (the handler), each on its own test run"

  mark tests "$a and $b pull and run the tests themselves"
  # the whole npm test output scrolls the typed line off a 36-row pane: wait for a summary that was not there before
  $LIB wait-pane "sh-$a" "$PASS6b" --new --timeout 150 --what "$a's pane: npm test passes" & local wa=$!
  $LIB wait-pane "sh-$b" "$PASS6b" --new --timeout 150 --what "$b's pane: npm test passes" & local wb=$!
  submit "$a" "!$RUN6b"
  submit "$b" "!$RUN6b"
  wait "$wa" || { kill "$wb" 2>/dev/null; ABORT="S6b: timed out waiting: $a's npm test passing in $a's pane"; return 1; }
  wait "$wb" || { ABORT="S6b: timed out waiting: $b's npm test passing in $b's pane"; return 1; }
  mark pass "npm test passes in both checkouts"
  echo "$h $t" > "$d/tasks.txt"
  for seat in "$a" "$b"; do
    $LIB pane "sh-$seat" > "$d/pane-$seat.txt"
    (cd "$BASE/$seat" && npm test --silent > "$d/npm-test-$seat.txt" 2>&1; echo "exit $?" >> "$d/npm-test-$seat.txt")
    g -C "$BASE/$seat" log --format='commit %H %an%n%s' --name-only > "$d/git-log-$seat.txt" 2>&1
    g -C "$BASE/$seat" log -g --date=iso-strict --format='%gd %gs' > "$d/reflog-$seat.txt" 2>&1   # when each pull happened
    g -C "$BASE/$seat" rev-parse HEAD > "$d/head-$seat.txt" 2>&1
  done
  g -C "$BASE/origin.git" rev-parse main > "$d/head-origin.txt" 2>&1
  settle "$a" "$b"
  snap "$a and $b pull and run npm test in their own checkouts: both pass"
}

S7() { # stray typing into a row view: the hint is on the row's own progress line; the row answers in one line
  # when its hold next returns (a join/rejoin; S8's resume brings one). Nothing is posted.
  need $LIB wait-idle sh-alice --timeout 60 || return 1
  need $LIB select-row sh-alice "$(room)" || return 1
  keys alice Enter
  need wait_pane alice "─ $(room) ─" 10 || return 1
  paint sh-alice   # the row view's first paint
  submit alice "x"
  wait_pane alice "read-only · talk in main" 20 --what "the row view shows the read-only hint where the text was typed"
  sleep 15  # deliberate dwell: room for the row to answer (it may not; the S7 check takes either)
  snap "alice types x into her room row view: the progress line reads read-only · talk in main (@room); nothing is posted"
  need $LIB select-row sh-alice main || return 1
  keys alice Enter
  need wait_pane alice "─ $(room) ─" 10 --absent || return 1
  keys alice Up Up   # focus back on the prompt: the panel cursor (❯ on a row) goes
  wait_pane alice "^❯\s+(└\s*)?[⏺◯●]\s" 5 --absent --what "alice's focus is back on the prompt"
}

S8() { # resilience: /clear in alice keeps rows; bob /exit + --continue: rows return with no prompt; the room still reaches him
  local sid; sid=$($LIB member-field alice session_id)
  # S7's Up Up (focus back from the agent panel) can recall the last prompt into the box when focus was already
  # there; "/clear" typed after it is then text, not the command (run heron-1142). Empty the box first.
  keys alice C-e C-u; sleep 0.5   # an emptied box looks like any empty box: nothing to wait on
  submit alice "/clear"
  need $LIB wait-member alice session_id --not "$sid" --timeout 30 || return 1
  sleep 8   # the old row line can linger right after /clear: give the restore time before looking for the row
  need wait_pane alice "$(panel_row "$(room)")" 60 || return 1
  snap "Rows survive /clear in alice's session (still one room row)"
  local before; before=$($LIB log-max)
  exit_seat bob
  need wait_log --kind member_left --from bob --after "$before" --timeout 30 || return 1
  $LIB wait-exited sh-bob --timeout 10 --what "bob's claude exited"
  start_seat bob --continue
  need $LIB ready sh-bob --timeout 90 || return 1
  need wait_pane bob "$(panel_row "$(room)")" 60 --what "bob's room row is back with no prompt (row-rewake)" || return 1
  need $LIB wait-idle sh-bob --timeout 60 || return 1
  settle alice bob
  snap "bob is back with --continue: row-rewake brings his room row back with no typing"
  local b2; b2=$($LIB log-max)
  submit alice "@room bob, are you back? the parser tests are done"
  need wait_log --kind say --from alice --via human --after "$b2" --timeout 30 || return 1
  need wait_pane bob "alice: bob, are you back" 60 --what "alice's words still reach bob's pane after the resume (the tail child came back)" || return 1
  need $LIB wait-idle sh-bob --timeout 90 || return 1
  settle alice
  snap "After the resume the room still reaches bob: alice's words as a chat line"
}

S9() { # the room's Claude refuses typed input: a viewer attaches and types one line
  local job; job=$(claude_job)
  tmux kill-session -t sh-viewer 2>/dev/null
  tmux new-session -d -s sh-viewer -x $COLS -y $ROWS "env -i HOME=\"$HOME\" USER=\"$USER\" LOGNAME=\"${LOGNAME:-$USER}\" PATH=\"$PATH\" TERM=xterm-256color LANG=\"${LANG:-en_US.UTF-8}\" TMPDIR=\"${TMPDIR:-/tmp/}\" claude attach $job"
  tmux set-option -t sh-viewer remain-on-exit on >/dev/null
  need $LIB wait-pane sh-viewer "claude\.$(room)|─{20}" --timeout 30 || return 1
  paint sh-viewer   # the attached view's first paint
  local before; before=$($LIB log-max)
  $LIB submit sh-viewer "hi claude, what's next?"
  $LIB wait-pane sh-viewer "takes no typed input" --timeout 30 --what "the attached room's Claude refuses the typed prompt"
  claude_view && paint sh-claude 2
  node "$REPO/scripts/snap.js" "sh-viewer,sh-claude" "$SCENE" "A viewer attaches to the room's Claude and types: the prompt is refused with the hint; no turn for the room's Claude"
  mkdir -p "$SNAP_DIR/state/S9"; $LIB synthetic-claude-prompt > "$SNAP_DIR/state/S9/synthetic-prompt.json" 2>&1 || true
  $LIB keys sh-viewer Left; sleep 1   # ← back to the agent view, then leave the viewer (killed next: nothing reads it)
  tmux kill-session -t sh-viewer 2>/dev/null
}

# The S9b post: later lines that read like a decision and a sign-off. Typed as one paste with real newlines
# (paste-buffer -r keeps LF: the prompt box takes them as line breaks, Enter then submits the whole prompt).
MULTI9b=$'notes from the paging spike:\nroom: decided (agreed: alice, bob)\nbob agreed to the proposal'

S9b() { # a multi-line @room post: its later lines show nested under alice ("  │ "), never as bare room lines
  local before; before=$($LIB log-max)
  need $LIB wait-idle sh-alice --timeout 60 || return 1
  submit alice "@room $MULTI9b"
  need wait_log --kind say --from alice --via human --after "$before" --text-has "notes from the paging spike" --timeout 30 || return 1
  wait_pane alice "✓ sent" 15
  need wait_pane bob "alice: notes from the paging spike:" 60 --what "bob's pane shows the post's first line under alice's name" || return 1
  need $LIB wait-idle sh-bob --timeout 90 || return 1
  mkdir -p "$SNAP_DIR/state/S9b"; $LIB pane sh-bob > "$SNAP_DIR/state/S9b/pane-bob.txt"
  settle alice bob
  snap "alice posts three lines with @room; bob's pane nests lines 2 and 3 under \"alice: …\" (│), so they can't pass as a decision or a sign-off"
}

S10() { # leave: both exit → reap completes task 1 and stops the room's Claude
  local a=$SEAT_A b=$SEAT_B
  local before; before=$($LIB log-max)
  mark leave "$a and $b leave; the room closes itself"
  exit_seat "$a"
  need wait_log --kind member_left --from "$a" --after "$before" --timeout 30 || return 1
  # the leave reaches B as a chat line once it has settled (8 s with no rejoin)
  mkdir -p "$SNAP_DIR/state/S10"
  wait_pane "$b" "^\s*(⏺ |⎿ )?(sub-human: )?$a left\s*$" 45 --what "$b sees the chat line \"$a left\" after the 8 s settle" && $LIB pane "sh-$b" > "$SNAP_DIR/state/S10/notice-$b.txt"
  need $LIB wait-idle "sh-$b" --timeout 30 || return 1
  exit_seat "$b"
  need wait_log --kind member_left --from "$b" --after "$before" --timeout 30 || return 1
  $LIB wait-exited "sh-$a" --timeout 10; $LIB wait-exited "sh-$b" --timeout 10   # the exited panes' last paint
  snap "$a and $b exit (1. Exit and stop tasks): member_left for each"
  need $LIB wait-member claude stopped_at --not "" --timeout 90 --what "the reaper stops the room's Claude" || return 1
  mark closed "The room's Claude stops"
  # claude agents --json drops the stopped job a few seconds after stopped_at
  $LIB wait-job-gone --timeout 30
  snap "The reaper: room closed, task 1 completed, the room's Claude stopped (claude agents no longer lists it running)"
  if [ "$REMOTE" = 1 ]; then   # the ssh side: B's link daemon (it stops by itself a minute after; now), then the sshd
    devbox_down --link
    "$DEVBOX_SH" status "$DEVBOX" && record "the private sshd still runs after S10" fail || record "the private sshd stopped after S10"
  fi
}

# S11: what carol says, and the proposal alice's Claude puts to her alone
SAY11="hello from the second home"
PLAN11=$'# Carol reviews the parser tests\n\n1. carol reads the parser tests\n2. she adds one case for an empty body\n'

S11() { # remote: carol joins from a second home (another machine, on this one) over the pipe link; @room; a signoff
  local before; before=$($LIB log-max)
  submit alice "/sub-human invite --pipe"
  need wait_pane alice "invite to room $(room)" 30 --what "alice's pane shows the invite line (to her, never to her Claude)" || return 1
  local line; line=$($LIB join-line sh-alice)
  [ -n "$line" ] || { ABORT="S11: no invite line readable in alice's pane"; return 1; }
  [ -d "$BASE/carol" ] || cp -R "$REPO/demo/app.pristine" "$BASE/carol"
  mkdir -p "$HOME2"
  start_seat carol
  need $LIB ready sh-carol --timeout 90 || return 1
  local SESSIONS="$SESSIONS,sh-carol"   # snap carol's pane too, in this scene
  # the line links her home (a hidden step: the PIN never reaches her Claude); alice's card lets her in; then a bare
  # /sub-human takes her seat
  submit carol "/sub-human $line --as carol"
  need wait_pane carol "checked your PIN" 60 --what "carol's link ran the PIN check with the host; alice's card asks" || return 1
  need $LIB admit-card sh-alice --timeout 120 || return 1
  local tries=0
  until $LIB wait-log --kind member_joined --from carol --after "$before" --timeout 1 >/dev/null 2>&1 || [ $tries -ge 4 ]; do
    sleep 4   # her link redials into the room once let in
    submit carol "/sub-human"
    tries=$((tries + 1))
  done
  need wait_log --kind member_joined --from carol --after "$before" --timeout 60 --what "the host logs carol's join (her link let in, her seat taken)" || return 1
  need wait_pane carol "$(panel_row "$(room)")" 90 --what "carol's room row" || return 1
  settle alice carol
  snap "alice runs /sub-human invite: one line with a 4-digit PIN, shown to her only. carol, in another home, types it (her Claude never sees the PIN), alice lets her in on the card, and /sub-human seats her: her link daemon mirrors the room"
  local b1; b1=$($LIB log-max)
  submit carol "@room $SAY11"
  need wait_log --kind say --from carol --via human --after "$b1" --timeout 30 || return 1
  need wait_pane alice "carol: $SAY11" 60 --what "alice's pane shows carol's exact words" || return 1
  need $LIB wait-idle sh-alice --timeout 90 || return 1
  settle carol
  snap "carol posts with @room from the second home: signed there, placed and verified on the host, back in her mirror"
  local b2; b2=$($LIB log-max)
  local plan; plan=$($LIB json-string "$PLAN11")
  submit alice "call the mcp__plugin_sub-human_room__propose tool with text $plan and approvers [\"carol\"]. Only that tool call: do not edit any file"
  need wait_log --kind proposal --from alice --after "$b2" --timeout 120 || return 1
  need wait_card carol "carol's proposal is open (its plan was prefetched into her mirror)" || return 1
  sleep 2   # the plan view's first paint
  snap "alice's Claude proposes to carol: it opens in carol's plan view on the other home"
  local p; p=$($LIB last-id --kind proposal)
  need card_answer carol Agree || return 1
  need wait_log --kind signoff --from carol --via human --after "$p" --timeout 30 || return 1
  need wait_log --kind decision --after "$p" --timeout 30 --what "the host decides (carol was the only approver)" || return 1
  need $LIB wait-idle sh-carol --timeout 90 || return 1
  mkdir -p "$SNAP_DIR/state/S11"
  local r; r=$(room)
  cp "$HOME2/rooms/$r/log.jsonl" "$SNAP_DIR/state/S11/mirror-log.jsonl" 2>/dev/null
  cp "$HOME2/rooms/$r/link.json" "$SNAP_DIR/state/S11/link-status.json" 2>/dev/null
  cp "$HOME2/machine.json" "$SNAP_DIR/state/S11/machine-carol.json" 2>/dev/null
  cp "$SUB_HUMAN_HOME/machine.json" "$SNAP_DIR/state/S11/machine-host.json" 2>/dev/null
  # the link file holds the token: keep only its shape
  $LIB link-shape "$HOME2/links/$r.json" > "$SNAP_DIR/state/S11/link-file.json" 2>/dev/null
  settle alice carol
  snap "carol agrees in the plan view: her signoff is signed on her machine, and the host logs the decision"
  local b3; b3=$($LIB log-max)
  exit_seat carol
  need wait_log --kind member_left --from carol --after "$b3" --timeout 30 || return 1
  sleep 2   # the exited pane's last paint
  snap "carol exits: the host logs her leave; her link daemon stops on its own once no seat of her home is left"
}

ALL=(S1 S2 S3 S4 S5 S6 S7 S8 S9 S9b S11 S10)
# --film: the story only (S6–S9, S9b and S11 show mechanics; S6b builds what was agreed)
[ "$FILM" = 1 ] && ALL=(S1 S2 S3 S4 S5 S6b S10)

# ---------- main --------------------------------------------------------------------------------

# a subset resumes against the running sessions, unless it starts at S1 (which needs a fresh home)
if [ -n "$ONLY$FROM" ] && [[ "$ONLY" != *",S1,"* ]] && [ "$FROM" != S1 ]; then RESET=0; fi
if [ "$FILM" = 1 ] && [ -e "$TAKE_DIR/capture.jsonl" ]; then echo "film: take $TAKE exists ($TAKE_DIR); pick another --take" >&2; exit 2; fi
setup
if [ "$FILM" = 1 ]; then
  # the recording: from here to the end (or an abort), every pane change of the two seats and sh-claude, keyed by name
  $CAPTURE start "$TAKE_DIR" --take "$TAKE" --interval 100 --sessions "$SEAT_A=sh-$SEAT_A,$SEAT_B=sh-$SEAT_B,claude=sh-claude" &
  trap '$CAPTURE stop; devbox_down' EXIT   # the sshd too: an abort leaves none running (a resume starts it again)
  for _ in $(seq 50); do [ -e "$REPO/trailer/capture/.active.json" ] && break; sleep 0.1; done
  say "── recording take $TAKE -> ${TAKE_DIR#$REPO/}"
fi
[ -z "$ROOM" ] && [ -d "$SUB_HUMAN_HOME/rooms" ] && ROOM=$(room) && [ -n "$ROOM" ] && export SUB_HUMAN_ROOM="$ROOM"

run=(); on=0; [ -z "$FROM" ] && on=1
for x in "${ALL[@]}"; do
  [ "$x" = "$FROM" ] && on=1; [ "$on" = 1 ] || continue
  [ -n "$ONLY" ] && [[ "$ONLY" != *",$x,"* ]] && continue
  run+=("$x"); [ "$x" = "$TO" ] && break
done
# a resume drops the captures of the scenes it runs again from screens/index.json
[ "$RESET" = 0 ] && [ ${#run[@]} -gt 0 ] && $LIB prune-index "$SNAP_DIR/index.json" "${run[@]}"
# the planned scenes (a fresh run replaces the list, a resume adds to it), the two seats and the people's scripted
# words; checks.js reads them
fresh=(); [ "$RESET" = 1 ] && fresh=(--fresh)
remote=(); [ "$REMOTE" = 1 ] && remote=(--remote "$SEAT_B=$LAPTOP/home")
$LIB plan-run "$SNAP_DIR/run.json" --all "${ALL[*]}" --seats "$SEAT_A $SEAT_B" ${remote[@]+"${remote[@]}"} ${fresh[@]+"${fresh[@]}"} ${run[@]+"${run[@]}"}
$LIB run-words "$SNAP_DIR/run.json" say3 "$SAY3" plan4 "$PLAN4" note5 "$NOTE5"

started=0; [ -z "$FROM" ] && started=1
for SCENE in "${ALL[@]}"; do
  [ "$SCENE" = "$FROM" ] && started=1
  [ "$started" = 1 ] || continue
  [ -n "$ONLY" ] && [[ "$ONLY" != *",$SCENE,"* ]] && continue
  export SCENE DEMO_SCENE=$SCENE
  STEP=0
  if [ "$PAUSE" = 1 ]; then read -r -p "── next: $SCENE — press Enter " </dev/tty; fi
  say "── $SCENE"
  ABORT=""
  [ "$FILM" = 1 ] && $CAPTURE scene "$SCENE" start
  "$SCENE"
  if [ "$FILM" = 1 ]; then $CAPTURE scene "$SCENE" "$([ -n "$ABORT" ] && echo aborted || echo ok)" ${ABORT:+"$ABORT"}; fi
  if [ -n "$ABORT" ]; then
    printf '\n\033[1;31m✗ %s\033[0m\n' "$ABORT" >&2
    record "scene aborted: $ABORT" fail
    snap "$SCENE aborted: ${ABORT#*: }" || true
    echo "the run stopped at $SCENE (later scenes need its state). Fix it, then: scripts/demo.sh --from $SCENE" >&2
    exit 1
  fi
  [ "$SCENE" = "$TO" ] && break
done

if [ "$FILM" = 1 ]; then
  # stop the recording, then the checks; their verdict goes in the take's run.json
  $CAPTURE stop
  node "$REPO/scripts/checks.js" --out "$TAKE_DIR/checks.json" > "$TAKE_DIR/checks.txt" 2>&1; tail -n 3 "$TAKE_DIR/checks.txt"
  $CAPTURE stop --dir "$TAKE_DIR" --checks "$TAKE_DIR/checks.json"
  say "take $TAKE: ${TAKE_DIR#$REPO/}/capture.jsonl, run.json (checks: checks.txt)"
fi
say "done. screens in ${SNAP_DIR#$REPO/}; then: node scripts/checks.js && node scripts/walkthrough.js"
echo "sessions: tmux attach -r -t sh-$SEAT_A | sh-$SEAT_B | sh-carol   (scripts/demo.sh stop); claude job: $(claude_job) (claude logs / stop / rm)"
