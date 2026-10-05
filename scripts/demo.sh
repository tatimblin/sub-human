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
# --human NAME: that seat is played by a person; the script prints what to do instead of typing, and
#           waits for that person with no time limit at each of their steps (until the log or their pane
#           shows the step done). Waits on other seats that depend on the human get 5× the time.
#           Its window is not read-only.
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
# T <seconds>: a wait on a scripted seat that follows a human's step in this scene gets 5× the time
T() { if [ -n "${CUR_HUMAN:-}" ]; then echo $(( $1 * 5 )); else echo "$1"; fi; }
# TH SEAT <seconds>: a wait for SEAT's own step: no time limit (0) when a person plays SEAT, else T
TH() { if is_human "$1"; then echo 0; else T "$2"; fi; }

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
export SUB_HUMAN_DEBUG="${SUB_HUMAN_DEBUG:-1}"
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
    # --add-dir: the orch reviews the members' work in their working copies (reads only; it has no Bash).
    # Without it each read outside its own folder is a permission prompt nobody answers in its window.
    printf '%q ' --plugin-dir "$PLUGIN" --agent sub-human:orchestrator --permission-mode plan --settings "$BASE/orch-settings.json" \
      --add-dir "$(cd "$BASE" && pwd -P)"
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
    mkdir -p "$SNAP_DIR"; rm -rf "$SNAP_DIR"/*.svg "$SNAP_DIR"/*.txt "$SNAP_DIR/index.json" "$SNAP_DIR/waits.jsonl" "$SNAP_DIR/state"
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

snap() { # caption — capture the panes, and keep the room's rows/ + members.json as of this step (evidence)
  node "$REPO/scripts/snap.js" "$SESSIONS" "$SCENE" "$1"
  local r; r=$(room); [ -n "$r" ] || return 0
  mkdir -p "$SNAP_DIR/state/$SCENE"
  cp "$SUB_HUMAN_HOME/rooms/$r/members.json" "$SUB_HUMAN_HOME/rooms/$r"/rows/*.json "$SNAP_DIR/state/$SCENE/" 2>/dev/null || true
}

# act SEAT "instruction for a human" CMD… — run CMD unless SEAT is played by a human; then print the
# instruction (an empty one prints nothing: the previous instruction covered this step too).
act() {
  local seat=$1 msg=$2; shift 2
  if is_human "$seat"; then
    CUR_HUMAN=$seat
    [ -n "$msg" ] || return 0
    printf '\n\033[1;33m  ┌─ %s, your turn (%s) in the %s window\033[0m\n' "$seat" "$SCENE" "sh-$seat"
    printf '\033[1;33m  │\033[0m  %s\n' "$msg"
    printf '\033[1;33m  └─ waiting for you, no time limit…\033[0m\n'
  else
    "$@"
  fi
}

submit() { $LIB submit "sh-$1" "$2"; }      # submit SEAT TEXT
keys() { local s=$1; shift; $LIB keys "sh-$s" "$@"; }
wait_log() { $LIB wait-log "$@"; }
wait_pane() { local s=$1 re=$2 t=${3:-60}; shift 2; [ $# -gt 0 ] && shift; $LIB wait-pane "sh-$s" "$re" --timeout "$t" "$@"; }

FORM_RE='requests your input|Approve this plan'

# The sign-off form (mcp/signoff.js): stage 1 has no fields, focus on [Accept]. An Accept sooner than 1 s
# after the form appears is treated as a stray key and re-offered, so let it sit first.
form_approve() { # seat — Enter = Accept = Approve
  wait_pane "$1" "$FORM_RE" "$(T 30)" || return 1
  sleep 1.5
  keys "$1" Enter
}
# exit_seat SEAT — /exit, then answer Claude Code's own "Background work is running" dialog (the room row
# is a background agent) with "1. Exit and stop tasks": that ends the session and logs member_left.
exit_seat() {
  submit "$1" "/exit"
  wait_pane "$1" "❯ 1\. Exit and stop tasks" 20 || return 0   # no dialog: nothing was running
  sleep 0.5
  keys "$1" Enter
}
EXIT_MSG='type /exit and press Enter; Claude Code asks "Background work is running…": choose 1. Exit and stop tasks (Enter)'

form_object_fill() { # seat reason — ↓ Enter = Decline = Object; stage 2 has one box; type the reason
  wait_pane "$1" "$FORM_RE" "$(T 30)" || return 1
  sleep 1.5
  keys "$1" Down Enter
  wait_pane "$1" "Object to plan" 15 || return 1
  sleep 1
  $LIB literal "sh-$1" "$2"
  sleep 0.5
}
form_submit() { keys "$1" Enter Enter; }   # Enter leaves the box for [Accept], Enter sends

ROOM=""
room() { [ -n "$ROOM" ] || ROOM=$($LIB wait-room --timeout 5 2>/dev/null); echo "$ROOM"; }

# ---------- scenes ------------------------------------------------------------------------------

S1() { # orch opens the room
  act orch "type /sub-human and press Enter" submit orch "/sub-human"
  ROOM=$($LIB wait-room --timeout "$(TH orch 90)")
  [ -n "$ROOM" ] && export SUB_HUMAN_ROOM="$ROOM"
  local code_re='[a-z]+-[0-9]{4}'
  wait_pane orch "${ROOM:-$code_re}" "$(T 60)"
  wait_pane orch "^\s*⬡ ${ROOM:-$code_re} · orch" 30   # the status line (refreshInterval 5 s), not the box title
  sleep 2
  snap "The orch runs /sub-human: invite code banner, status line ⬡ ${ROOM:-CODE} · orch"
}

S2() { # alice joins without a code
  act alice "type /sub-human alice and press Enter (twice if the picker completes it first)" submit alice "/sub-human alice"
  wait_log --kind member_joined --from alice --timeout "$(TH alice 60)"
  wait_pane alice "$(panel_row "$(room)")" "$(T 90)"
  wait_pane orch "$(panel_row alice)" "$(T 90)"
  sleep 5
  snap "alice joins with /sub-human alice (no code): one $(room) row for her, an alice row for the orch"
}

S3() { # bob joins
  act bob "type /sub-human bob and press Enter (twice if the picker completes it first)" submit bob "/sub-human bob"
  wait_log --kind member_joined --from bob --timeout "$(TH bob 60)"
  wait_pane bob "$(panel_row "$(room)")" "$(T 90)"
  wait_pane orch "$(panel_row bob)" "$(T 90)"
  $LIB wait-holds alice bob --timeout 60   # alice's room adds bob's row (hold returns JOINED bob)
  sleep 8
  snap "bob joins: the orch panel has alice and bob rows; each member panel has only the room row"
}

S4() { # @room posts
  local before; before=$($LIB log-max)
  act alice "type exactly, then Enter:  @room let's add cursor paging to GET /tasks: ?limit&after, bare array, max 50" \
    submit alice "@room let's add cursor paging to GET /tasks: ?limit&after, bare array, max 50"
  wait_log --kind say --from alice --via human --after "$before" --timeout "$(TH alice 30)"
  wait_pane alice "posted to .* as #" 15
  sleep 4
  snap "alice posts with @room: receipt ✓ posted … as #N; the rows update in the other panels"
  act bob "type exactly, then Enter:  @room I want to approve this. Keep \`after\` opaque, not a page number." \
    submit bob "@room I want to approve this. Keep \`after\` opaque, not a page number."
  wait_log --kind say --from bob --via human --after "$before" --timeout "$(TH bob 30)"
  sleep 4
  snap "bob asks to approve and adds a constraint (@room, via=human)"
}

# Scripted human answers when the orch asks a member a question before it drafts (seat → @room reply).
ANSWER_alice="@room put the next cursor in a Link header (rel=next) and keep the body a bare array"
ANSWER_bob="@room fine by me, as long as \`after\` stays opaque"

S5() { # the orch drafts; a question to a member gets that member's scripted human answer
  local seen=0 i
  for i in 1 2 3; do
    wait_log --kind plan_rev,question --from orch --after "$seen" --timeout 240 --what "orch drafts a plan or asks a member" || break
    local q; q=$($LIB last-id --kind plan_rev,question --from orch)
    [ "$($LIB count --kind plan_rev)" -gt 0 ] && break
    local to; to=$(node -e 'const {readLog,roomCode}=require(process.argv[1]);const l=readLog(roomCode()),q=+process.argv[2],e=l.find(x=>x.id===q);if(e&&!l.some(x=>x.id>q&&x.from===e.to&&x.via==="human"))process.stdout.write(e.to||"")' "$REPO/scripts/snap.js" "$q")
    seen=$q
    case "$to" in alice|bob)
      local var="ANSWER_$to"
      snap "The orch asks $to a question before drafting (#$q)"
      act "$to" "the orch asked you a question (#$q): answer it in one line starting with @room, then Enter" submit "$to" "${!var}"
      wait_log --kind say --from "$to" --via human --after "$q" --timeout "$(TH "$to" 60)" ;;
    esac
  done
  wait_pane orch "[Pp]lan|[Ww]rit|draft" 120
  sleep 3
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
  act bob "in the sign-off form press ↓ then Enter (Object), type this reason, then Enter twice to send it:  $reason" form_object_fill bob "$reason"
  is_human bob || snap "bob objects in his form with a typed reason (before the log shows it)"
  act bob "" form_submit bob
  wait_log --kind objection --from bob --via human --latest-plan --timeout "$(TH bob 60)"
  sleep 6
  snap "bob's objection (via=human, reason byte-exact) shows in the orch and alice rows"
}

S8() { # revision, both approve
  local n; n=$($LIB count --kind plan_rev)
  wait_log --kind plan_rev --count $((n + 1)) --timeout 300
  sleep 2
  snap "The orch revises: the stale form is replaced by the new revision's form"
  act alice "the revised plan's sign-off form is up: press Enter to approve" form_approve alice
  wait_log --kind signoff --from alice --via human --latest-plan --timeout "$(TH alice 60)"
  wait_pane orch "$(panel_row alice)\s*✓ signed" 12   # rows refresh every 5 s
  snap "alice approves the revision: ✓ signed on her row"
  act bob "the revised plan's sign-off form is up: press Enter to approve" form_approve bob
  wait_log --kind signoff --from bob --via human --latest-plan --timeout "$(TH bob 60)"
  # the decision follows within ~2 s, so the next 5 s row refresh may already read ✔ decided
  wait_pane orch "$(panel_row bob)\s*(✓ signed|✔ decided)" 12
  snap "Both approve the revision: ✓ signed on both rows; matrix complete"
}

S9() { # automatic exit
  wait_log --kind decision --latest-plan --timeout 180
  local d; d=$($LIB last-id --kind decision)
  wait_log --kind status,say,proposal --from orch --via agent --after "$d" --timeout 180 --what "orch posts assignments after the decision"
  sleep 6
  snap "Automatic exit: the orch leaves plan mode with no dialog; decision; assignments; rows read ✓ decided"
}

S10() { # background work; alice (scripted) answers her own Claude's permission dialogs, as she would
  local before; before=$($LIB log-max)
  act alice "type, then Enter:  go — do your part of the decided plan in a background subagent and post status with evidence. Then approve your Claude's permission prompts until it posts its result." \
    submit alice "go — do your part of the decided plan in a background subagent and post status with evidence"
  wait_log --kind status --from alice --after "$before" --timeout "$(TH alice 180)"
  sleep 5
  snap "alice's Claude works in a native background subagent; her status shows in the others' rows"
  act alice "" \
    $LIB approve-until sh-alice --kind status --from alice --after "$before" --count 2 --quiet 10 --timeout "$(T 480)"
  is_human alice && wait_log --kind status --from alice --after "$before" --count 2 --timeout 0
  wait_pane orch "$(panel_row alice)\s*#[0-9]+ (Claude )?status" 15   # her latest status replaces ✔ decided
  snap "alice's status with evidence (test output) in the others' rows"
}

panel_row() { echo "^\s*(❯\s*)?(└\s*)?[⏺◯]\s+$1(\s|$)"; }   # a row line in the agent panel

S11() { # resilience: /clear in alice, resume in bob
  local sid; sid=$($LIB member-field alice session_id)
  act alice "type /clear and press Enter" submit alice "/clear"
  $LIB wait-member alice session_id --not "$sid" --timeout "$(TH alice 30)"   # /clear: a new session id, same seat
  sleep 8
  wait_pane alice "$(panel_row "$(room)")" 60
  sleep 3
  snap "Rows survive /clear in alice's session (still one room row)"
  local before; before=$($LIB log-max)
  act bob "$EXIT_MSG. The script restarts your Claude with --continue in the same window." exit_seat bob
  wait_log --kind member_left --from bob --after "$before" --timeout "$(TH bob 30)"
  sleep 2
  start_seat bob --continue   # the pane stays (remain-on-exit); respawn it resumed
  $LIB ready sh-bob --timeout 90
  sleep 3
  snap "bob is back with --continue: the restore context is in, but no turn has run yet (no rows)"
  # SessionStart context starts no model turn: the rows come back on bob's first prompt
  act bob "your Claude is back (--continue): type  what did I miss?  and press Enter" submit bob "what did I miss?"
  wait_pane bob "$(panel_row "$(room)")" "$(TH bob 120)"
  sleep 5
  snap "bob's first prompt after the resume: his Claude re-creates the room row from the restore prompt"
}

S11b() { # nested view in alice's panel: select the room row, Enter; ↓ bob, Enter; ↑ + Enter back
  # alice's room re-adds bob's row after his resume (hold returns JOINED bob): wait for its live hold
  $LIB wait-holds alice bob --timeout 90
  act alice "press ↓ until the $(room) row under main is selected (❯), then Enter to open it" sh_select alice "$(room)"
  act alice "" keys alice Enter
  wait_pane alice "─ $(room) ─" "$(TH alice 10)"
  sleep 3
  snap "alice opens the room row: bob listed inside it, one level down (no breadcrumb)"
  act alice "press ↓ to the bob row inside the room, then Enter to open it" sh_select alice bob
  act alice "" keys alice Enter
  wait_pane alice "─ bob ─" "$(TH alice 10)"
  sleep 3
  snap "alice opens bob's row inside the room: bob's thread, his words and his Claude's, labelled"
  act alice "press ↑ to the $(room) row, then Enter (not Esc: Esc twice would stop the row)" sh_select alice "$(room)" --key Up
  act alice "" keys alice Enter
  wait_pane alice "─ $(room) ─" "$(TH alice 10)"
  sleep 3
  snap "Back up one level with ↑ to the parent row + Enter"
  act alice "press ↑ to main, then Enter" sh_select alice main --key Up
  act alice "" keys alice Enter
  wait_pane alice "─ $(room) ─" "$(TH alice 10)" --absent
  sleep 2
}
sh_select() { local s=$1; shift; $LIB select-row "sh-$s" "$@"; }

S12() { # leave
  local before; before=$($LIB log-max)
  act bob "$EXIT_MSG" exit_seat bob
  wait_log --kind member_left --from bob --after "$before" --timeout "$(TH bob 60)"
  sleep 8
  snap "bob exits (/exit, then 1. Exit and stop tasks): member_left; his row reads left in the orch and alice panels"
}

ALL=(S1 S2 S3 S4 S5 S6 S7 S8 S9 S10 S11 S11b S12)

# ---------- main --------------------------------------------------------------------------------

if [ "$WINDOWS" = 2 ]; then write_launcher; open_windows; exit 0; fi

if [ -n "$ONLY$FROM" ]; then RESET=0; fi
setup
[ -z "$ROOM" ] && [ -d "$SUB_HUMAN_HOME/rooms" ] && ROOM=$(room) && export SUB_HUMAN_ROOM="$ROOM"

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
  if [ "$PAUSE" = 1 ]; then read -r -p "── next: $SCENE — press Enter " </dev/tty; fi
  say "── $SCENE"
  CUR_HUMAN=""
  "$SCENE"
done

say "done. screens in ${SNAP_DIR#$REPO/}; build the page with: node scripts/walkthrough.js"
echo "sessions still running: tmux attach -r -t sh-orch | sh-alice | sh-bob   (scripts/demo.sh stop)"
