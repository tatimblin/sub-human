#!/usr/bin/env bash
# demo.sh — drive the slim-build walkthrough scenes S1–S11 with two member seats in detached tmux
# sessions (sh-alice, sh-bob), and in S11 a third (sh-carol) from a second home, and snap every pane after every
# step (scripts/snap.js → docs/rebuild/screens/).
#
#   scripts/demo.sh [--windows] [--pause] [--only S6[,S7]] [--from S6] [--to S3] [--member-model MODEL] [--no-reset]
#                   (--to: stop after that scene; a fresh run unless --from/--only is given too)
#   scripts/demo.sh stop            kill the sh-* tmux sessions (never numbered ones)
#
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
export SNAP_DIR="${SNAP_DIR:-$REPO/docs/rebuild/screens}"
LIB="node $REPO/scripts/demo-lib.js"
SEATS=(alice bob)
SESSIONS="sh-claude,sh-alice,sh-bob"
COLS=120; ROWS=40
ROOM_CLAUDE_COLS=200; ROOM_CLAUDE_ROWS=50   # a --bg session renders at 200 columns: claude logs replays that

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
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
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
# launch.sh SEAT [claude args…] — a clean env: env -i, then only what a login shell would give (SH_SEAT_HOME, when
# set, is that seat's SUB_HUMAN_HOME: S11's second home). The tmux
# server's global env may carry CLAUDE_CODE_* vars from whichever Claude Code session started it: a seat
# (and the room's Claude it spawns) must inherit none of them.
seat=\$1; shift
cd "$BASE/\$seat" || exit 1
exec env -i HOME="$HOME" USER="${USER:-}" LOGNAME="${LOGNAME:-${USER:-}}" SHELL="${SHELL:-/bin/zsh}" \\
  PATH="$PATH" TERM="\${TERM:-xterm-256color}" LANG="${LANG:-en_US.UTF-8}" TMPDIR="${TMPDIR:-/tmp/}" \\
  SUB_HUMAN_HOME="\${SH_SEAT_HOME:-$SUB_HUMAN_HOME}" \\
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
    for s in sh-claude sh-alice sh-bob sh-carol sh-viewer; do tmux kill-session -t "$s" 2>/dev/null; done
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

# claude_view — the room Claude's read-only "pane": a tmux session that runs `claude logs <job>` (a passive stream of
# the background session's terminal; nothing is ever typed there). Restarted if the stream ends.
claude_view() {
  local job; job=$(claude_job); [ -n "$job" ] || return 1
  tmux kill-session -t sh-claude 2>/dev/null
  tmux new-session -d -s sh-claude -x "${ROOM_CLAUDE_COLS:-$COLS}" -y "${ROOM_CLAUDE_ROWS:-$ROWS}" \
    "while :; do env -i HOME=\"$HOME\" USER=\"$USER\" LOGNAME=\"${LOGNAME:-$USER}\" PATH=\"$PATH\" TERM=xterm-256color LANG=\"${LANG:-en_US.UTF-8}\" claude logs $job; sleep 2; done"
  tmux set-window-option -t sh-claude window-size manual >/dev/null 2>&1
  tmux resize-window -t sh-claude -x "${ROOM_CLAUDE_COLS:-$COLS}" -y "${ROOM_CLAUDE_ROWS:-$ROWS}" >/dev/null 2>&1
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
card_answer() { $LIB card "sh-$1" "$2" "${3:-}"; }

# ---------- scenes ------------------------------------------------------------------------------

S1() { # alice joins with no room open: the room is created and the headless room's Claude spawned
  submit alice "/sub-human alice"
  ROOM=$($LIB wait-room --timeout 60)
  [ -n "$ROOM" ] || { ABORT="S1: no room dir after /sub-human alice (60 s)"; return 1; }
  export SUB_HUMAN_ROOM="$ROOM"
  need wait_log --kind member_joined --from alice --timeout 60 || return 1
  need $LIB wait-member claude pid --not "" --timeout 120 --what "the room's Claude job binds as member claude" || return 1
  claude_view
  need wait_pane alice "$(panel_row "$(room)")" 90 || return 1
  need $LIB wait-holds claude alice --timeout 120 || return 1
  need $LIB wait-native-task "room $(room) open" --timeout 120 || return 1
  settle alice
  snap "alice runs /sub-human alice: room $(room) opened, the room's Claude started in the background; one $(room) row for her, an alice row in the room Claude's panel"
}

S2() { # bob joins
  submit bob "/sub-human bob"
  need wait_log --kind member_joined --from bob --timeout 60 || return 1
  # the join as a group-chat line in alice's pane ("sub-human: bob joined": the hooks module's $.ui.log notice, no
  # model turn); kept as evidence
  mkdir -p "$SNAP_DIR/state/S2"
  wait_pane alice "^\s*(⏺ |⎿ )?(sub-human: )?bob joined\s*$" 60 --what "alice sees the chat line \"bob joined\"" && $LIB pane sh-alice > "$SNAP_DIR/state/S2/notice-alice.txt"
  need wait_pane bob "$(panel_row "$(room)")" 90 || return 1
  need $LIB wait-holds claude bob --timeout 120 || return 1
  need $LIB wait-holds alice bob --timeout 90 || return 1
  settle alice bob
  snap "bob joins: bob nested in alice's room row, alice in bob's; the room's Claude lists both"
}

S3() { # pairing with no plan: @room both ways, then Claude↔Claude SendMessage
  local before; before=$($LIB log-max)
  submit alice "@room bob, can you take the parser tests? handler's in src/server.ts"
  need wait_log --kind say --from alice --via human --after "$before" --timeout 30 || return 1
  wait_pane alice "Operation stopped by hook: ✓ sent" 15
  need wait_pane bob "alice: bob, can you take the parser tests" 60 --what "bob's pane shows alice's exact words as a chat line" || return 1
  need $LIB wait-idle sh-bob --timeout 90 || return 1
  settle alice
  snap "alice posts with @room: one receipt line for her (✓ sent), bob's pane shows \"alice: …\" with her exact words"
  submit bob "@room sure, once we've agreed how paging works"
  need wait_log --kind say --from bob --via human --after "$before" --timeout 30 || return 1
  need $LIB wait-idle sh-alice --timeout 90 || return 1
  submit bob "ask alice's Claude how createTask in src/store.ts picks ids. just ask, change nothing"
  # the engine's "Message from @bob.CODE", or the hooks module's drawing of that peer row (mod/render.ts: "bob's Claude: …")
  need wait_pane alice "Message from @?bob\.|^\s*bob's Claude: " 120 --what "alice's pane shows a message from bob's Claude" || return 1
  need $LIB wait-idle sh-alice --timeout 120 || return 1
  need wait_pane bob "Message from @?alice\.|^\s*alice's Claude: " 120 --what "bob's pane shows alice's Claude's answer" || return 1
  need $LIB wait-idle sh-bob --timeout 120 || return 1
  settle alice bob
  snap "bob's Claude asks alice's Claude natively (SendMessage to alice.$(room)); alice's Claude answers. No card, no turn for the room's Claude"
}

# Scripted human answers when the room's Claude asks before it proposes (each seat answers once, by @claude).
ANSWER_alice="@claude default 20, max 50, {items, nextCursor}; a cursor past the end returns an empty page"
ANSWER_bob="@claude fine with that; 400 on a bad cursor. please propose it to alice and me"

S4() { # let's plan: bob @claude → the room's Claude proposes → each approver reads it in the plan view
  local before; before=$($LIB log-max)
  submit bob "@claude let's plan cursor paging for GET /tasks: ?limit&after, opaque cursor, newest first"
  need wait_log --kind say --from bob --via human --after "$before" --timeout 30 || return 1
  if ! wait_log --kind proposal --from claude --after "$before" --timeout 150 --what "the room's Claude proposes (or asks first)"; then
    # the room's Claude asked the people first (post to=NAME or SendMessage): each answers in one @claude line
    snap "The room's Claude asks alice and bob before it writes the plan"
    for seat in alice bob; do
      local var="ANSWER_$seat"
      need $LIB wait-idle "sh-$seat" --timeout 60 || return 1
      local b; b=$($LIB log-max)
      submit "$seat" "${!var}"
      need wait_log --kind say --from "$seat" --via human --after "$b" --timeout 30 || return 1
    done
    need wait_log --kind proposal --from claude --after "$before" --timeout 420 --what "the room's Claude writes a plan and proposes it" || return 1
  fi
  need wait_card alice "alice's card is open" || return 1
  need wait_card bob "bob's card is open" || return 1
  paint sh-alice; paint sh-bob   # the plan view's first paint (wait-idle counts an open plan view as busy)
  snap "The room's Claude proposes its plan: it opens in alice's and bob's native plan view, all of it scrollable (Yes / Tell Claude what to change / Esc)"
  read_plan alice
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

NOTE5="add a test for a cursor past the end — \`after=zzz\` must 400, not 500"

S5() { # bob objects with a note, alice agrees; the room's Claude revises; both agree → decision
  local p1; p1=$($LIB last-id --kind proposal)
  need card_answer alice Agree || return 1
  need wait_log --kind signoff --from alice --via human --after "$p1" --timeout 30 || return 1
  need card_answer bob Object "$NOTE5" || return 1
  need wait_log --kind objection --from bob --via human --after "$p1" --timeout 30 || return 1
  settle alice bob
  snap "alice agrees; bob objects with a note (via=human, byte-exact)"
  need wait_log --kind proposal --from claude --after "$p1" --timeout 420 --what "the room's Claude revises and proposes again" || return 1
  need wait_card alice "alice's card for the revision" || return 1
  need wait_card bob "bob's card for the revision" || return 1
  paint sh-alice; paint sh-bob   # the plan view's first paint
  snap "The room's Claude revises: a new proposal, opened again for each"
  local p2; p2=$($LIB last-id --kind proposal)
  need card_answer alice Agree || return 1
  need wait_log --kind signoff --from alice --via human --after "$p2" --timeout 30 || return 1
  need card_answer bob Agree || return 1
  need wait_log --kind decision --after "$p2" --timeout 30 || return 1
  need $LIB wait-idle sh-alice --timeout 90 || return 1
  need $LIB wait-idle sh-bob --timeout 90 || return 1
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
  wait_pane alice "Operation stopped by hook: ✓ sent" 15
  need wait_pane bob "alice: notes from the paging spike:" 60 --what "bob's pane shows the post's first line under alice's name" || return 1
  need $LIB wait-idle sh-bob --timeout 90 || return 1
  mkdir -p "$SNAP_DIR/state/S9b"; $LIB pane sh-bob > "$SNAP_DIR/state/S9b/pane-bob.txt"
  settle alice bob
  snap "alice posts three lines with @room; bob's pane nests lines 2 and 3 under \"alice: …\" (│), so they can't pass as a decision or a sign-off"
}

S10() { # leave: both exit → reap completes task 1 and stops the room's Claude
  local before; before=$($LIB log-max)
  exit_seat alice
  need wait_log --kind member_left --from alice --after "$before" --timeout 30 || return 1
  # the leave reaches bob as a chat line once it has settled (8 s with no rejoin)
  mkdir -p "$SNAP_DIR/state/S10"
  wait_pane bob "^\s*(⏺ |⎿ )?(sub-human: )?alice left\s*$" 45 --what "bob sees the chat line \"alice left\" after the 8 s settle" && $LIB pane sh-bob > "$SNAP_DIR/state/S10/notice-bob.txt"
  need $LIB wait-idle sh-bob --timeout 30 || return 1
  exit_seat bob
  need wait_log --kind member_left --from bob --after "$before" --timeout 30 || return 1
  $LIB wait-exited sh-alice --timeout 10; $LIB wait-exited sh-bob --timeout 10   # the exited panes' last paint
  snap "alice and bob exit (1. Exit and stop tasks): member_left for each"
  need $LIB wait-member claude stopped_at --not "" --timeout 90 --what "the reaper stops the room's Claude" || return 1
  # claude agents --json drops the stopped job a few seconds after stopped_at
  $LIB wait-job-gone --timeout 30
  snap "The reaper: room closed, task 1 completed, the room's Claude stopped (claude agents no longer lists it running)"
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

# ---------- main --------------------------------------------------------------------------------

# a subset resumes against the running sessions, unless it starts at S1 (which needs a fresh home)
if [ -n "$ONLY$FROM" ] && [[ "$ONLY" != *",S1,"* ]] && [ "$FROM" != S1 ]; then RESET=0; fi
setup
[ -z "$ROOM" ] && [ -d "$SUB_HUMAN_HOME/rooms" ] && ROOM=$(room) && [ -n "$ROOM" ] && export SUB_HUMAN_ROOM="$ROOM"

run=(); on=0; [ -z "$FROM" ] && on=1
for x in "${ALL[@]}"; do
  [ "$x" = "$FROM" ] && on=1; [ "$on" = 1 ] || continue
  [ -n "$ONLY" ] && [[ "$ONLY" != *",$x,"* ]] && continue
  run+=("$x"); [ "$x" = "$TO" ] && break
done
# a resume drops the captures of the scenes it runs again from screens/index.json
[ "$RESET" = 0 ] && [ ${#run[@]} -gt 0 ] && $LIB prune-index "$SNAP_DIR/index.json" "${run[@]}"
# the planned scenes (a fresh run replaces the list, a resume adds to it); checks.js reads it
fresh=(); [ "$RESET" = 1 ] && fresh=(--fresh)
$LIB plan-run "$SNAP_DIR/run.json" --all "${ALL[*]}" ${fresh[@]+"${fresh[@]}"} ${run[@]+"${run[@]}"}

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
  "$SCENE"
  if [ -n "$ABORT" ]; then
    printf '\n\033[1;31m✗ %s\033[0m\n' "$ABORT" >&2
    record "scene aborted: $ABORT" fail
    snap "$SCENE aborted: ${ABORT#*: }" || true
    echo "the run stopped at $SCENE (later scenes need its state). Fix it, then: scripts/demo.sh --from $SCENE" >&2
    exit 1
  fi
  [ "$SCENE" = "$TO" ] && break
done

say "done. screens in ${SNAP_DIR#$REPO/}; then: node scripts/checks.js && node scripts/walkthrough.js"
echo "sessions: tmux attach -r -t sh-alice | sh-bob | sh-carol   (scripts/demo.sh stop); claude job: $(claude_job) (claude logs / stop / rm)"
