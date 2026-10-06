#!/usr/bin/env bash
# demo.sh — drive the slim-build walkthrough scenes S1–S10 with two member seats in detached tmux
# sessions (sh-alice, sh-bob) and snap every pane after every step (scripts/snap.js → docs/rebuild/screens/).
#
#   scripts/demo.sh [--windows] [--pause] [--only S6[,S7]] [--from S6] [--to S3] [--member-model MODEL] [--no-reset]
#                   (--to: stop after that scene; a fresh run unless --from/--only is given too)
#   scripts/demo.sh stop            kill the sh-* tmux sessions (never numbered ones)
#
# The orch has no tmux seat: the first /sub-human starts it as a `claude --bg` job (orch.CODE). Its "pane" in
# the captures is `claude logs <job>` running in a tmux session sh-orch (read-only: never typed into). Nothing is ever typed into the orch, except in S9, where a viewer runs
# `claude attach <job>` in its own tmux session sh-viewer and types one line to show the refusal.
# Home:     SUB_HUMAN_HOME=/tmp/sh-demo/home (fresh on a full run); seats work in /tmp/sh-demo/<seat>,
#           each a copy of demo/app.pristine. Seats launch with env -i (HOME USER LOGNAME SHELL PATH TERM
#           LANG TMPDIR SUB_HUMAN_HOME).
# --only / --from: run a subset against already-running sessions (scenes depend on earlier state).
# Waits are best-effort: a timeout is recorded in screens/waits.jsonl, the panes are snapped anyway, and
# the run continues. After the run: node scripts/checks.js && node scripts/walkthrough.js
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN="$REPO/plugin/sub-human"
BASE=/tmp/sh-demo
export SUB_HUMAN_HOME="$BASE/home"
export SNAP_DIR="${SNAP_DIR:-$REPO/docs/rebuild/screens}"
LIB="node $REPO/scripts/demo-lib.js"
SEATS=(alice bob)
SESSIONS="sh-orch,sh-alice,sh-bob"
COLS=120; ROWS=40
ORCH_COLS=200; ORCH_ROWS=50   # a --bg session renders at 200 columns: claude logs replays that

WINDOWS=0; PAUSE="${SUB_HUMAN_DEMO_PAUSE:-0}"; ONLY=""; FROM=""; TO=""; RESET=1
MEMBER_MODEL=""   # empty: the seats use the user's default model; --member-model MODEL opts in

case "${1:-}" in
  stop)
    for s in $(tmux ls -F '#{session_name}' 2>/dev/null | grep -E '^sh-'); do tmux kill-session -t "$s" && echo "killed $s"; done
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
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# ---------- sessions ----------------------------------------------------------------------------

write_launcher() {
  mkdir -p "$BASE"
  cat > "$BASE/launch.sh" <<EOF
#!/usr/bin/env bash
# launch.sh SEAT [claude args…] — a clean env: env -i, then only what a login shell would give. The tmux
# server's global env may carry CLAUDE_CODE_* vars from whichever Claude Code session started it: a seat
# (and the orch it spawns) must inherit none of them.
seat=\$1; shift
cd "$BASE/\$seat" || exit 1
exec env -i HOME="$HOME" USER="${USER:-}" LOGNAME="${LOGNAME:-${USER:-}}" SHELL="${SHELL:-/bin/zsh}" \\
  PATH="$PATH" TERM="\${TERM:-xterm-256color}" LANG="${LANG:-en_US.UTF-8}" TMPDIR="${TMPDIR:-/tmp/}" \\
  SUB_HUMAN_HOME="$SUB_HUMAN_HOME" \\
  claude "\$@"
EOF
  chmod +x "$BASE/launch.sh"
}

claude_args() { # seat [extra…]
  local seat=$1; shift
  printf '%q ' --plugin-dir "$PLUGIN"
  [ -n "$MEMBER_MODEL" ] && printf '%q ' --model "$MEMBER_MODEL"
  [ $# -gt 0 ] && printf '%q ' "$@"
}

start_seat() { # seat [extra claude args…]
  local seat=$1; shift
  local s="sh-$seat"
  local cmd="$BASE/launch.sh $seat $(claude_args "$seat" "$@")"
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
    for s in sh-orch sh-alice sh-bob sh-viewer; do tmux kill-session -t "$s" 2>/dev/null; done
    rm -rf "$BASE"
    mkdir -p "$SUB_HUMAN_HOME"
    for seat in "${SEATS[@]}"; do cp -R "$REPO/demo/app.pristine" "$BASE/$seat"; done
    mkdir -p "$SNAP_DIR"; rm -rf "$SNAP_DIR"/*.svg "$SNAP_DIR"/*.txt "$SNAP_DIR"/*.ansi "$SNAP_DIR/index.json" "$SNAP_DIR/waits.jsonl" "$SNAP_DIR/state"
    ls "$HOME/.claude/plans" > "$BASE/plans-before.txt" 2>/dev/null
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

# orch_view — the orch's read-only "pane": a tmux session that runs `claude logs <job>` (a passive stream of
# the background session's terminal; nothing is ever typed there). Restarted if the stream ends.
orch_view() {
  local job; job=$(orch_job); [ -n "$job" ] || return 1
  tmux kill-session -t sh-orch 2>/dev/null
  tmux new-session -d -s sh-orch -x "${ORCH_COLS:-$COLS}" -y "${ORCH_ROWS:-$ROWS}" \
    "while :; do env -i HOME=\"$HOME\" USER=\"$USER\" LOGNAME=\"${LOGNAME:-$USER}\" PATH=\"$PATH\" TERM=xterm-256color LANG=\"${LANG:-en_US.UTF-8}\" claude logs $job; sleep 2; done"
  tmux set-window-option -t sh-orch window-size manual >/dev/null 2>&1
  tmux resize-window -t sh-orch -x "${ORCH_COLS:-$COLS}" -y "${ORCH_ROWS:-$ROWS}" >/dev/null 2>&1
}

orch_job() { $LIB member-field orch job 2>/dev/null | tr -d '\n'; }

snap() { # caption — capture the panes (the orch via claude logs), and keep this step's state as evidence
  local job; job=$(orch_job)
  # a fresh `claude logs` each time: its first screen is a full repaint (a long-running stream drifts)
  orch_view && sleep 5
  node "$REPO/scripts/snap.js" "$SESSIONS" "$SCENE" "$1"
  local r; r=$(room); [ -n "$r" ] || return 0
  STEP=$((STEP + 1))
  local d="$SNAP_DIR/state/$SCENE/$STEP"   # this step's evidence (checks.js reads state/SCENE/N)
  mkdir -p "$d"
  cp "$SUB_HUMAN_HOME/rooms/$r/members.json" "$SUB_HUMAN_HOME/rooms/$r"/rows/*.json "$d/" 2>/dev/null || true
  cp "$SUB_HUMAN_HOME/rooms/$r/tasks.json" "$d/" 2>/dev/null || true
  claude agents --json > "$d/agents.json" 2>/dev/null || true
  "$PLUGIN/bin/sub-human" tasks --room "$r" > "$d/sub-human-tasks.txt" 2>&1 || true
  mkdir -p "$d/native-tasks"; cp "$HOME/.claude/tasks/sh-$r"/*.json "$d/native-tasks/" 2>/dev/null || true
}

# dismiss_question SEAT — a seat's Claude may open its own AskUserQuestion (e.g. to relay an orch question to its
# person); typing a scripted line into it would pick an option instead of posting (run ocelot-0728). Esc it — never
# a consent card, which only card_answer answers.
dismiss_question() {
  local p; p=$(tmux capture-pane -p -t "sh-$1:" 2>/dev/null)
  if command grep -q "Esc to cancel" <<<"$p" && ! command grep -Eq "$CARD_RE" <<<"$p"; then keys "$1" Escape; sleep 2; fi
}
submit() { $LIB wait-idle "sh-$1" --timeout 45 --quiet 2 >/dev/null 2>&1; dismiss_question "$1"; $LIB submit "sh-$1" "$2"; }   # submit SEAT TEXT (once the seat is idle)
keys() { local s=$1; shift; $LIB keys "sh-$s" "$@"; }
wait_log() { $LIB wait-log "$@"; }
wait_pane() { local s=$1 re=$2 t=${3:-60}; shift 2; [ $# -gt 0 ] && shift; $LIB wait-pane "sh-$s" "$re" --timeout "$t" "$@"; }
wait_orch() { local re=$1 t=${2:-60}; shift 2; $LIB wait-logs "$(orch_job)" "$re" --timeout "$t" "$@"; }

# exit_seat SEAT — /exit, then answer Claude Code's own "Background work is running" dialog (the room row
# is a background agent) with "1. Exit and stop tasks": that ends the session and logs member_left.
exit_seat() {
  submit "$1" "/exit"
  wait_pane "$1" "❯ 1\. Exit and stop tasks" 20 || return 0
  sleep 0.5
  keys "$1" Enter
}

ROOM=""
room() { [ -n "$ROOM" ] || ROOM=$($LIB wait-room --timeout 5 2>/dev/null); echo "$ROOM"; }
panel_row() { echo "^\s*(❯\s*)?(└\s*)?[⏺◯]\s+$1(\s|$)"; }   # a row line in the agent panel
CARD_RE='Agree to proposal [0-9a-f]{12}\?'

# wait_card SEAT WHAT — wait for SEAT's consent card; if its Claude has not opened it in 120 s, the person asks
# once ("show me the card …"; recorded in waits.jsonl as a nudge) and the wait runs again.
wait_card() {
  wait_pane "$1" "$CARD_RE" 120 --what "$2" && return 0
  local h; h=$($LIB last-id --kind proposal --field hash 2>/dev/null)
  echo "{\"scene\":\"$SCENE\",\"what\":\"nudge: $1 asked for the card\",\"ok\":true,\"ms\":0}" >> "$SNAP_DIR/waits.jsonl"
  submit "$1" "show me the consent card for proposal ${h:-the open proposal}"
  wait_pane "$1" "$CARD_RE" 120 --what "$2 (after the nudge)"
}

# card_answer SEAT CHOICE [NOTE] — answer the open consent card: Not yet / Agree / Object (+ a note)
card_answer() { $LIB card "sh-$1" "$2" "${3:-}"; }

# ---------- scenes ------------------------------------------------------------------------------

S1() { # alice joins with no room open: the room is created and the headless orch spawned
  submit alice "/sub-human alice"
  ROOM=$($LIB wait-room --timeout 60)
  [ -n "$ROOM" ] && export SUB_HUMAN_ROOM="$ROOM"
  wait_log --kind member_joined --from alice --timeout 60
  $LIB wait-member orch pid --not "" --timeout 120 --what "the orch job binds as orch of the room"
  orch_view
  wait_pane alice "$(panel_row "$(room)")" 90
  $LIB wait-holds orch alice --timeout 120
  $LIB wait-native-task "room $(room) open" --timeout 120
  sleep 4
  snap "alice runs /sub-human alice: room $(room) opened, the orch started in the background; one $(room) row for her, an alice row in the orch's panel"
}

S2() { # bob joins
  submit bob "/sub-human bob"
  wait_log --kind member_joined --from bob --timeout 60
  # the join notice: a Claude Code notification in alice's pane (about 5 s), no model turn; kept as evidence
  mkdir -p "$SNAP_DIR/state/S2"
  wait_pane alice "⬡ bob joined" 25 --what "alice sees the join notice (notification, no model turn)" && $LIB pane sh-alice > "$SNAP_DIR/state/S2/notice-alice.txt"
  wait_pane bob "$(panel_row "$(room)")" 90
  $LIB wait-holds orch bob --timeout 120
  $LIB wait-holds alice bob --timeout 90
  sleep 6
  snap "bob joins: bob nested in alice's room row, alice in bob's; the orch lists both"
}

S3() { # pairing with no plan: @room both ways, then Claude↔Claude SendMessage
  local before; before=$($LIB log-max)
  submit alice "@room bob, can you take the parser tests? handler's in src/server.js"
  wait_log --kind say --from alice --via human --after "$before" --timeout 30
  wait_pane alice "Operation stopped by hook: ✓ posted" 15
  wait_pane bob "bob, can you take the parser tests" 60 --what "bob's Claude is woken with alice's exact words"
  $LIB wait-idle sh-bob --timeout 90
  sleep 3
  snap "alice posts with @room: one receipt line for her, bob's Claude wakes once with her exact words"
  submit bob "@room sure, once we've agreed how paging works"
  wait_log --kind say --from bob --via human --after "$before" --timeout 30
  $LIB wait-idle sh-alice --timeout 90
  submit bob "ask alice's Claude how createTask in src/store.js picks ids. just ask, change nothing"
  wait_pane alice "Message from @?bob\." 120 --what "alice's pane shows a message from bob's Claude"
  $LIB wait-idle sh-alice --timeout 120
  wait_pane bob "Message from @?alice\." 120 --what "bob's pane shows alice's Claude's answer"
  $LIB wait-idle sh-bob --timeout 120
  sleep 3
  snap "bob's Claude asks alice's Claude natively (SendMessage to alice.$(room)); alice's Claude answers. No card, no orch turn"
}

# Scripted human answers when the orch asks before it proposes (each seat answers once, by @room).
ANSWER_alice="@room @orch default 20, max 50, {items, nextCursor}; a cursor past the end returns an empty page"
ANSWER_bob="@room @orch fine with that; 400 on a bad cursor. please propose it to alice and me"

S4() { # let's plan: bob @room @orch → orch proposes → a card for each approver
  local before; before=$($LIB log-max)
  submit bob "@room @orch let's plan cursor paging for GET /tasks: ?limit&after, opaque cursor, newest first"
  wait_log --kind say --from bob --via human --after "$before" --timeout 30
  if ! wait_log --kind proposal --from orch --after "$before" --timeout 150 --what "the orch proposes (or asks first)"; then
    # the orch asked the people first (post to=NAME or SendMessage): each answers in one @room line
    snap "The orch asks alice and bob before it writes the plan"
    for seat in alice bob; do
      local var="ANSWER_$seat"
      $LIB wait-idle "sh-$seat" --timeout 60
      local b; b=$($LIB log-max)
      submit "$seat" "${!var}"
      wait_log --kind say --from "$seat" --via human --after "$b" --timeout 30
    done
    wait_log --kind proposal --from orch --after "$before" --timeout 420 --what "the orch writes a plan and proposes it"
  fi
  wait_card alice "alice's card is open"
  wait_card bob "bob's card is open"
  sleep 2
  snap "The orch proposes its plan: the native consent card (Not yet / Agree / Object) opens in alice's and bob's terminals"
}

NOTE5="add a test for a cursor past the end — \`after=zzz\` must 400, not 500"

S5() { # bob objects with a note, alice agrees; the orch revises; both agree → decision
  local p1; p1=$($LIB last-id --kind proposal)
  card_answer alice Agree
  wait_log --kind signoff --from alice --via human --after "$p1" --timeout 30
  card_answer bob Object "$NOTE5"
  wait_log --kind objection --from bob --via human --after "$p1" --timeout 30
  sleep 4
  snap "alice agrees; bob objects with a note (via=human, byte-exact)"
  wait_log --kind proposal --from orch --after "$p1" --timeout 420 --what "the orch revises and proposes again"
  wait_card alice "alice's card for the revision"
  wait_card bob "bob's card for the revision"
  sleep 2
  snap "The orch revises: a new proposal, a new card for each"
  local p2; p2=$($LIB last-id --kind proposal)
  card_answer alice Agree
  wait_log --kind signoff --from alice --via human --after "$p2" --timeout 30
  card_answer bob Agree
  wait_log --kind decision --after "$p2" --timeout 30
  $LIB wait-idle sh-alice --timeout 90; $LIB wait-idle sh-bob --timeout 90
  sleep 6
  snap "Both agree to the revision: a decision is logged; both Claudes are told once"
}

S6() { # shared tasks: alice's Claude adds, then claims, the orch applies natively; a non-owner done is refused; owner done
  local before; before=$($LIB log-max)
  # explicit tool name: in run osprey-3059 the model used post ("taking this") instead of the task tool. add leaves
  # the task pending with no owner (lynx-5140), and claim needs its id: so add, then claim by id.
  submit alice "put \"cursor paging handler\" on the room task list: call the mcp__plugin_sub-human_room__task tool with op \"add\", subject \"cursor paging handler\". Only that tool call: do not use post, do not edit any file"
  wait_log --kind task_req --from alice --after "$before" --timeout 120
  wait_log --kind task --after "$before" --timeout 180 --what "the orch applies the add natively (task entry)"
  local t; t=$($LIB task-id)
  local b1; b1=$($LIB log-max)
  submit alice "claim it for me: call the mcp__plugin_sub-human_room__task tool with op \"claim\", id \"$t\". Only that tool call: do not start the work, do not edit any file"
  wait_log --kind task_req --from alice --after "$b1" --timeout 120
  $LIB wait-tasks --owner alice --status in_progress --timeout 180
  sleep 7
  snap "alice's Claude calls task(add), then task(claim #$t): the orch applies each with TaskCreate/TaskUpdate; the room row and sub-human tasks show it"
  local b2; b2=$($LIB log-max)
  # explicit: the model may otherwise answer in text and never calls the tool (learning run badger-3918)
  submit bob "call the mcp__plugin_sub-human_room__task tool now with op \"done\", id \"$t\", evidence \"I ran the tests, 3/3 pass\". It is alice's task; send the request anyway and report the tool's reply in one line"
  wait_log --kind task_req --from bob --after "$b2" --timeout 120
  $LIB wait-orch-idle --after "$b2" --timeout 180
  mkdir -p "$SNAP_DIR/state/S6"; $LIB synthetic-gate "$t" > "$SNAP_DIR/state/S6/gate-bob.json"
  sleep 5
  snap "bob's Claude asks done on alice's task #$t: refused, the task stays in progress"
  local b3; b3=$($LIB log-max)
  submit alice "the handler is in and npm test passes 3/3. call the mcp__plugin_sub-human_room__task tool with op \"done\", id \"$t\", evidence \"handler in, npm test 3/3 pass\". Only that tool call: do not edit or check any file"
  wait_log --kind task_req --from alice --after "$b3" --timeout 120
  $LIB wait-tasks --id "$t" --status completed --timeout 180
  sleep 7
  snap "alice's Claude asks done with evidence: the orch completes #$t (the gate passes the owner's request)"
}

S7() { # stray typing into a row view: the hint is on the row's own progress line; the row answers in one line
  # when its hold next returns (a join/rejoin; S8's resume brings one). Nothing is posted.
  $LIB wait-idle sh-alice --timeout 60
  $LIB select-row sh-alice "$(room)"
  keys alice Enter
  wait_pane alice "─ $(room) ─" 10
  sleep 2
  submit alice "x"
  wait_pane alice "read-only · talk in main" 20 --what "the row view shows the read-only hint where the text was typed"
  sleep 15
  snap "alice types x into her room row view: the progress line reads read-only · talk in main (@room); nothing is posted"
  $LIB select-row sh-alice main
  keys alice Enter
  wait_pane alice "─ $(room) ─" 10 --absent
  keys alice Up Up   # focus back on the prompt
  sleep 1
}

S8() { # resilience: /clear in alice keeps rows; bob /exit + --continue: rows return with no prompt; monitor wakes him
  local sid; sid=$($LIB member-field alice session_id)
  submit alice "/clear"
  $LIB wait-member alice session_id --not "$sid" --timeout 30
  sleep 8
  wait_pane alice "$(panel_row "$(room)")" 60
  snap "Rows survive /clear in alice's session (still one room row)"
  local before; before=$($LIB log-max)
  exit_seat bob
  wait_log --kind member_left --from bob --after "$before" --timeout 30
  sleep 1
  start_seat bob --continue
  $LIB ready sh-bob --timeout 90
  wait_pane bob "$(panel_row "$(room)")" 60 --what "bob's room row is back with no prompt (row-rewake)"
  $LIB wait-idle sh-bob --timeout 60
  sleep 4
  snap "bob is back with --continue: row-rewake brings his room row back with no typing"
  local b2; b2=$($LIB log-max)
  submit alice "@room bob, are you back? the parser tests are done"
  wait_log --kind say --from alice --via human --after "$b2" --timeout 30
  wait_pane bob "are you back" 60 --what "the monitor still wakes bob after the resume"
  $LIB wait-idle sh-bob --timeout 90
  sleep 3
  snap "After the resume the room monitor still wakes bob with alice's words"
}

S9() { # the orch refuses typed input: a viewer attaches and types one line
  local job; job=$(orch_job)
  tmux kill-session -t sh-viewer 2>/dev/null
  tmux new-session -d -s sh-viewer -x $COLS -y $ROWS "env -i HOME=\"$HOME\" USER=\"$USER\" LOGNAME=\"${LOGNAME:-$USER}\" PATH=\"$PATH\" TERM=xterm-256color LANG=\"${LANG:-en_US.UTF-8}\" TMPDIR=\"${TMPDIR:-/tmp/}\" claude attach $job"
  tmux set-option -t sh-viewer remain-on-exit on >/dev/null
  $LIB wait-pane sh-viewer "orch\.$(room)|─{20}" --timeout 30
  sleep 3
  local before; before=$($LIB log-max)
  $LIB submit sh-viewer "hi orch, what's next?"
  $LIB wait-pane sh-viewer "takes no typed input" --timeout 30 --what "the attached orch refuses the typed prompt"
  orch_view; sleep 5
  node "$REPO/scripts/snap.js" "sh-viewer,sh-orch" "$SCENE" "A viewer attaches to the orch and types: the prompt is refused with the hint; no orch turn"
  mkdir -p "$SNAP_DIR/state/S9"; $LIB synthetic-orch-prompt > "$SNAP_DIR/state/S9/synthetic-prompt.json" 2>&1 || true
  $LIB keys sh-viewer Left; sleep 1   # ← back to the agent view, then leave the viewer
  tmux kill-session -t sh-viewer 2>/dev/null
}

S10() { # leave: both exit → reap completes task 1 and stops the orch
  local before; before=$($LIB log-max)
  exit_seat alice
  wait_log --kind member_left --from alice --after "$before" --timeout 30
  # the leave notice reaches bob once the leave has settled (8 s with no rejoin); no model turn
  mkdir -p "$SNAP_DIR/state/S10"
  wait_pane bob "⬡ alice left" 30 --what "bob sees alice's leave notice after the 8 s settle (notification, no model turn)" && $LIB pane sh-bob > "$SNAP_DIR/state/S10/notice-bob.txt"
  $LIB wait-idle sh-bob --timeout 30
  exit_seat bob
  wait_log --kind member_left --from bob --after "$before" --timeout 30
  sleep 2
  snap "alice and bob exit (1. Exit and stop tasks): member_left for each"
  $LIB wait-member orch stopped_at --not "" --timeout 90 --what "the reaper stops the orch"
  sleep 5
  snap "The reaper: room closed, task 1 completed, the orch stopped (claude agents no longer lists it running)"
}

ALL=(S1 S2 S3 S4 S5 S6 S7 S8 S9 S10)

# ---------- main --------------------------------------------------------------------------------

if [ -n "$ONLY$FROM" ]; then RESET=0; fi
setup
[ -z "$ROOM" ] && [ -d "$SUB_HUMAN_HOME/rooms" ] && ROOM=$(room) && [ -n "$ROOM" ] && export SUB_HUMAN_ROOM="$ROOM"

prune_index() { # scenes… — drop their captures from screens/index.json before re-running them
  node -e 'const fs=require("fs"),f=process.argv[1],drop=new Set(process.argv.slice(2));let i=[];try{i=JSON.parse(fs.readFileSync(f,"utf8"))}catch{};fs.writeFileSync(f,JSON.stringify(i.filter(r=>!drop.has(r.scene)),null,1)+"\n")' "$SNAP_DIR/index.json" "$@"
}
if [ "$RESET" = 0 ]; then
  run=(); on=0; [ -z "$FROM" ] && on=1
  for x in "${ALL[@]}"; do [ "$x" = "$FROM" ] && on=1; [ "$on" = 1 ] || continue; [ -n "$ONLY" ] && [[ "$ONLY" != *",$x,"* ]] && continue; run+=("$x"); done
  [ ${#run[@]} -gt 0 ] && prune_index "${run[@]}"
fi

started=0; [ -z "$FROM" ] && started=1
for SCENE in "${ALL[@]}"; do
  [ "$SCENE" = "$FROM" ] && started=1
  [ "$started" = 1 ] || continue
  [ -n "$ONLY" ] && [[ "$ONLY" != *",$SCENE,"* ]] && continue
  export SCENE DEMO_SCENE=$SCENE
  STEP=0
  if [ "$PAUSE" = 1 ]; then read -r -p "── next: $SCENE — press Enter " </dev/tty; fi
  say "── $SCENE"
  "$SCENE"
  [ "$SCENE" = "$TO" ] && break
done

say "done. screens in ${SNAP_DIR#$REPO/}; then: node scripts/checks.js && node scripts/walkthrough.js"
echo "sessions: tmux attach -r -t sh-alice | sh-bob   (scripts/demo.sh stop); orch job: $(orch_job) (claude logs / stop / rm)"
