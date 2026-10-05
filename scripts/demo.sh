#!/usr/bin/env bash
# demo.sh — drive the sub-human walkthrough scenes S1–S12 (+S11b) in three detached tmux sessions
# and snap every pane after every step (scripts/snap.js → docs/rebuild/screens/).
#
#   scripts/demo.sh [--windows] [--pause] [--only S6[,S7]] [--from S6] [--member-model haiku]
#                   [--orch-model MODEL] [--human alice] [--no-reset]
#   scripts/demo.sh stop            kill the sh-orch / sh-alice / sh-bob sessions (never shd-*)
#   scripts/demo.sh windows         just open the read-only Ghostty windows
#
# Sessions: sh-orch, sh-alice, sh-bob (NOT shd-*: that's a separate, running demo).
# Home:     SUB_HUMAN_HOME=/tmp/sh-demo/home (fresh on a full run); seats work in /tmp/sh-demo/<seat>,
#           each a copy of demo/app.pristine.
# --pause (or SUB_HUMAN_DEMO_PAUSE=1): wait for Enter before each scene, so a human can take a seat.
# --human NAME: that seat is played by a person; the script prints what to do instead of typing,
#           and still waits on the same conditions (with longer timeouts). Its window is not read-only.
# --only / --from: run a subset against already-running sessions (scenes depend on earlier state).
# Waits are best-effort: a timeout is recorded in screens/waits.jsonl, the panes are snapped anyway,
# and the run continues.
# After the run: node scripts/walkthrough.js  → docs/rebuild/walkthrough.html
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN="$REPO/plugin/sub-human"
BASE=/tmp/sh-demo
export SUB_HUMAN_HOME="$BASE/home"
export SNAP_DIR="${SNAP_DIR:-$REPO/docs/rebuild/screens}"
LIB="node $REPO/scripts/demo-lib.js"
SEATS=(orch alice bob)
SESSIONS="sh-orch,sh-alice,sh-bob"
COLS=120; ROWS=40

WINDOWS=0; PAUSE="${SUB_HUMAN_DEMO_PAUSE:-0}"; ONLY=""; FROM=""; RESET=1
MEMBER_MODEL=haiku; ORCH_MODEL=""; HUMANS=" "

case "${1:-}" in
  stop)
    for s in $(tmux ls -F '#{session_name}' 2>/dev/null | grep -E '^sh-'); do tmux kill-session -t "$s" && echo "killed $s"; done
    exit 0 ;;
esac

while [ $# -gt 0 ]; do
  case "$1" in
    windows) WINDOWS=2 ;;
    --windows) WINDOWS=1 ;;
    --pause) PAUSE=1 ;;
    --only) ONLY=",$2,"; shift ;;
    --from) FROM="$2"; shift ;;
    --member-model) MEMBER_MODEL="$2"; shift ;;
    --orch-model) ORCH_MODEL="$2"; shift ;;
    --human) HUMANS="$HUMANS$2 "; shift ;;
    --no-reset) RESET=0 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
is_human() { [[ "$HUMANS" == *" $1 "* ]]; }
# T <seconds>: a human seat gets 5× the time
T() { if [ -n "${CUR_HUMAN:-}" ]; then echo $(( $1 * 5 )); else echo "$1"; fi; }

# ---------- sessions ----------------------------------------------------------------------------

write_launcher() {
  mkdir -p "$BASE"
  cat > "$BASE/launch.sh" <<EOF
#!/usr/bin/env bash
# launch.sh SEAT [claude args…] — clean env (we may be started from inside a Claude Code session)
seat=\$1; shift
for v in \$(env | grep -o '^CLAUDE[A-Z_]*'); do unset "\$v"; done
unset ANTHROPIC_MODEL
export SUB_HUMAN_HOME="$SUB_HUMAN_HOME"
cd "$BASE/\$seat" || exit 1
exec claude "\$@"
EOF
  chmod +x "$BASE/launch.sh"
  cat > "$BASE/orch-settings.json" <<EOF
{ "statusLine": { "type": "command", "command": "$PLUGIN/bin/sub-human statusline", "refreshInterval": 5 } }
EOF
}

claude_args() { # seat [extra…]
  local seat=$1; shift
  if [ "$seat" = orch ]; then
    printf '%q ' --plugin-dir "$PLUGIN" --agent sub-human:orchestrator --permission-mode plan --settings "$BASE/orch-settings.json"
    [ -n "$ORCH_MODEL" ] && printf '%q ' --model "$ORCH_MODEL"
  else
    printf '%q ' --plugin-dir "$PLUGIN"
    [ -n "$MEMBER_MODEL" ] && ! is_human "$seat" && printf '%q ' --model "$MEMBER_MODEL"
  fi
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
    for s in sh-orch sh-alice sh-bob; do tmux kill-session -t "$s" 2>/dev/null; done
    rm -rf "$BASE"
    mkdir -p "$SUB_HUMAN_HOME"
    for seat in "${SEATS[@]}"; do cp -R "$REPO/demo/app.pristine" "$BASE/$seat"; done
    mkdir -p "$SNAP_DIR"; rm -f "$SNAP_DIR"/*.svg "$SNAP_DIR"/*.txt "$SNAP_DIR/index.json" "$SNAP_DIR/waits.jsonl"
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
  # verified form: `open -na Ghostty --args --title=… -e tmux attach -r -t SESSION`
  local tmuxbin; tmuxbin="$(command -v tmux)"
  local i=0
  for seat in "${SEATS[@]}"; do
    local x=$(( (i % 2) * 960 )) y=$(( i / 2 * 580 + 30 )) ro="-r"
    is_human "$seat" && ro=""
    open -na Ghostty --args "--title=$seat · sub-human demo" --window-position-x=$x --window-position-y=$y \
      --window-width=$COLS --window-height=34 -e "$tmuxbin" attach $ro -t "sh-$seat"
    i=$((i + 1))
  done
}

# ---------- step helpers ------------------------------------------------------------------------

snap() { node "$REPO/scripts/snap.js" "$SESSIONS" "$SCENE" "$1"; }

# act SEAT "instruction for a human" CMD… — run CMD unless SEAT is played by a human
act() {
  local seat=$1 msg=$2; shift 2
  if is_human "$seat"; then
    printf '\033[33m  → %s, please: %s\033[0m\n' "$seat" "$msg"
    CUR_HUMAN=$seat
  else
    "$@"
  fi
}

submit() { $LIB submit "sh-$1" "$2"; }      # submit SEAT TEXT
keys() { local s=$1; shift; $LIB keys "sh-$s" "$@"; }
wait_log() { $LIB wait-log "$@"; }
wait_pane() { $LIB wait-pane "sh-$1" "$2" --timeout "${3:-60}"; }

FORM_RE='requests your input|Approve'

form_approve() { # seat
  wait_pane "$1" "$FORM_RE" "$(T 30)" || return 1
  sleep 1
  keys "$1" Right Space Down Down Enter            # E2: approving is → Space ↓ ↓ Enter
}
form_object() { # seat reason
  wait_pane "$1" "$FORM_RE" "$(T 30)" || return 1
  sleep 1
  keys "$1" Right Down Space Down                  # E2: objecting is → ↓ Space ↓ type ↓ Enter
  $LIB type "sh-$1" "$2"
  sleep 0.5
  keys "$1" Down Enter
}

ROOM=""
room() { [ -n "$ROOM" ] || ROOM=$($LIB wait-room --timeout 5 2>/dev/null); echo "$ROOM"; }

# ---------- scenes ------------------------------------------------------------------------------

S1() { # orch opens the room
  act orch "type /sub-human and press Enter" submit orch "/sub-human"
  ROOM=$($LIB wait-room --timeout "$(T 90)")
  [ -n "$ROOM" ] && export SUB_HUMAN_ROOM="$ROOM"
  local code_re='[a-z]+-[0-9]{4}'
  wait_pane orch "${ROOM:-$code_re}" "$(T 60)"
  sleep 3
  snap "The orch runs /sub-human: invite code banner, status line ⬡ ${ROOM:-CODE} · orch"
}

S2() { # alice joins without a code
  act alice "type /sub-human alice" submit alice "/sub-human alice"
  wait_log --kind member_joined --from alice --timeout "$(T 60)"
  wait_pane alice "$(room)" "$(T 90)"
  wait_pane orch "alice" "$(T 90)"
  sleep 5
  snap "alice joins with /sub-human alice (no code): one $(room) row for her, an alice row for the orch"
}

S3() { # bob joins
  act bob "type /sub-human bob" submit bob "/sub-human bob"
  wait_log --kind member_joined --from bob --timeout "$(T 60)"
  wait_pane bob "$(room)" "$(T 90)"
  wait_pane orch "bob" "$(T 90)"
  sleep 8
  snap "bob joins: the orch panel has alice and bob rows; each member panel has only the room row"
}

S4() { # @room posts
  local before; before=$($LIB log-max)
  act alice "type: @room let's add cursor paging to GET /tasks: ?limit&after, bare array, max 50" \
    submit alice "@room let's add cursor paging to GET /tasks: ?limit&after, bare array, max 50"
  wait_log --kind say --from alice --via human --after "$before" --timeout "$(T 30)"
  wait_pane alice "posted to .* as #" 15
  sleep 4
  snap "alice posts with @room: receipt ✓ posted … as #N; the rows update in the other panels"
  act bob "type: @room I want to approve this. Keep \`after\` opaque, not a page number." \
    submit bob "@room I want to approve this. Keep \`after\` opaque, not a page number."
  wait_log --kind say --from bob --via human --after "$before" --timeout "$(T 30)"
  sleep 4
  snap "bob asks to approve and adds a constraint (@room, via=human)"
}

S5() { # the orch drafts
  wait_pane orch "[Pp]lan|[Ww]rit|draft" 120
  sleep 5
  snap "The orch drafts a plan: rows read drafting; the orch's own status line"
}

S6() { # plan published → native forms
  wait_log --kind plan_rev --timeout 300
  wait_pane alice "$FORM_RE" "$(T 20)"
  wait_pane bob "$FORM_RE" "$(T 20)"
  sleep 1
  snap "Plan published: the native sign-off form in alice's and bob's terminals (summary, path, Approve/Object)"
}

S7() { # bob objects
  local reason='cap the page at 50 and say what happens past it — `limit=500` must clamp, not 400'
  act bob "in the form choose Object and type the reason: $reason" form_object bob "$reason"
  sleep 1
  snap "bob objects in his form with a typed reason (before the log shows it)"
  wait_log --kind objection --from bob --via human --latest-plan --timeout "$(T 60)"
  sleep 6
  snap "bob's objection (via=human, reason byte-exact) shows in the orch and alice rows"
}

S8() { # revision, both approve
  local n; n=$($LIB count --kind plan_rev)
  wait_log --kind plan_rev --count $((n + 1)) --timeout 300
  sleep 2
  snap "The orch revises: the stale form is replaced by the new revision's form"
  act alice "choose Approve in the form" form_approve alice
  wait_log --kind signoff --from alice --via human --latest-plan --timeout "$(T 60)"
  act bob "choose Approve in the form" form_approve bob
  wait_log --kind signoff --from bob --via human --latest-plan --timeout "$(T 60)"
  sleep 4
  snap "Both approve the revision: ✓ signed on both rows; matrix complete"
}

S9() { # automatic exit
  wait_log --kind decision --latest-plan --timeout 180
  wait_pane orch "assign|Assign" 180
  sleep 6
  snap "Automatic exit: the orch leaves plan mode with no dialog; decision; assignments; rows read ✓ decided"
}

S10() { # background work
  local before; before=$($LIB log-max)
  act alice "type: go" submit alice "go — do your part of the decided plan in a background subagent and post status with evidence"
  wait_log --kind status --from alice --after "$before" --timeout "$(T 180)"
  sleep 5
  snap "alice's Claude works in a native background subagent; her status shows in the others' rows"
  wait_log --kind status --from alice --after "$before" --count 2 --timeout "$(T 400)"
  sleep 3
  snap "alice's status with evidence (test output) in the others' rows"
}

S11() { # resilience: /clear in alice, --resume in bob
  act alice "type /clear" submit alice "/clear"
  sleep 15
  wait_pane alice "$(room)" 60
  snap "Rows survive /clear in alice's session"
  act bob "exit claude (/exit) and restart it with --continue" submit bob "/exit"
  sleep 4
  start_seat bob --continue   # the pane stays (remain-on-exit); respawn it resumed
  $LIB ready sh-bob --timeout 90
  wait_pane bob "$(room)" "$(T 120)"
  sleep 8
  snap "bob restarts with --continue (resume): the restore prompt re-creates his rows"
}

S11b() { # nested view in alice's panel: ↓ manage, ↓ room, Enter; ↓ bob, Enter; ↑ + Enter back
  act alice "focus the agent panel (↓), select the room row (↓), Enter" keys alice Down Down Enter
  sleep 3
  snap "alice opens the room row: bob listed inside it, one level down (no breadcrumb)"
  act alice "↓ to bob, Enter" keys alice Down Enter
  sleep 3
  snap "alice opens bob's row inside the room: bob's thread, his words and his Claude's, labelled"
  act alice "↑ to the room row, Enter (Esc twice would stop the row)" keys alice Up Enter
  sleep 3
  snap "Back up one level with ↑ to the parent row + Enter"
  act alice "↑ to main, Enter" keys alice Up Enter
  sleep 2
}

S12() { # leave
  act bob "type /exit" submit bob "/exit"
  wait_log --kind member_left --from bob --timeout "$(T 60)"
  sleep 8
  snap "bob exits: his row disappears from the orch and alice panels (member_left)"
}

ALL=(S1 S2 S3 S4 S5 S6 S7 S8 S9 S10 S11 S11b S12)

# ---------- main --------------------------------------------------------------------------------

if [ "$WINDOWS" = 2 ]; then write_launcher; open_windows; exit 0; fi

if [ -n "$ONLY$FROM" ]; then RESET=0; fi
setup
[ -z "$ROOM" ] && [ -d "$SUB_HUMAN_HOME/rooms" ] && ROOM=$(room) && export SUB_HUMAN_ROOM="$ROOM"

started=0; [ -z "$FROM" ] && started=1
for SCENE in "${ALL[@]}"; do
  [ "$SCENE" = "$FROM" ] && started=1
  [ "$started" = 1 ] || continue
  [ -n "$ONLY" ] && [[ "$ONLY" != *",$SCENE,"* ]] && continue
  export SCENE DEMO_SCENE=$SCENE
  if [ "$PAUSE" = 1 ]; then read -r -p "── next: $SCENE — press Enter " </dev/tty; fi
  say "── $SCENE"
  CUR_HUMAN=""
  "$SCENE"
done

say "done. screens in ${SNAP_DIR#$REPO/}; build the page with: node scripts/walkthrough.js"
echo "sessions still running: tmux attach -r -t sh-orch | sh-alice | sh-bob   (scripts/demo.sh stop)"
