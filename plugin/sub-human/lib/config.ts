/**
 * plugin/sub-human/lib/config.ts: every timing and size cap in one place, named. Zero dependencies.
 * Callers import the value they use; an env override (SUB_HUMAN_<WHAT>_MS and the rest) is read through lib/env.ts,
 * whose table names every knob with its default here.
 */

// ---------- the room tail (scripts/sub-human tail, the hooks module's child) ----------
// Entries are batched into one set of events (at most one wake): flushed after SETTLE_MS of quiet, or
// SETTLE_MAX_MS after the batch's first entry.
export const SETTLE_MS = 1500;                 // SUB_HUMAN_SETTLE_MS
export const SETTLE_MAX_MS = 5000;             // SUB_HUMAN_SETTLE_MAX_MS
// The headless room Claude waits longer (nobody watches its latency), so a burst lands as one turn.
export const ROOM_CLAUDE_SETTLE_MS = 3000;
export const ROOM_CLAUDE_SETTLE_MAX_MS = 10_000;
// A member_left waits this long for a rejoin; a leave + rejoin inside it is no notice at all.
export const LEAVE_SETTLE_MS = 8000;           // SUB_HUMAN_LEAVE_MS (tail, notices, rows, hold)
export const UNSEATED_MS = 10_000;             // SUB_HUMAN_UNSEATED_MS: no seat yet, look it up this rarely
export const RESOLVE_MS = 2000;                // SUB_HUMAN_RESOLVE_MS: seated, re-resolve the seat this often
export const TAIL_POLL_MS = 250;               // SUB_HUMAN_POLL_MS: the tail's log poll
export const FOLLOW_POLL_MS = 250;             // the remote server's poll of a room it cannot watch (lib/room/watch.ts)
export const FOLLOW_SLOW_MS = 2000;            // and of one it watches (fs.watch), for an event the watcher missed
export const REPLAY_BATCH = 500;               // lines per turn of a first sync's replay; the next waits for the transport to drain
export const WATCH_POLL_MS = 500;              // `sub-human watch --follow` poll

// ---------- the tail loop's health (lib/tail.ts) ----------
// The tail never exits on an error (each restart by the mod costs a backoff): it logs (rate-limited), backs
// off and carries on. Every TAIL_HEALTH_MS it checks the log's hash chain from its in-memory checkpoint and,
// while it is the room's Claude, runs roomClaude.watchdog(code).
export const TAIL_HEALTH_MS = 5000;            // SUB_HUMAN_TAIL_HEALTH_MS
export const TAIL_BACKOFF_MS = 1000;           // first retry delay after an error, doubled per failure
export const TAIL_BACKOFF_MAX_MS = 30_000;
export const TAIL_ERROR_LOG_MS = 60_000;       // one stderr line per error site per this long
// Seated, the poll loop must have ticked within this long, or the next seat check restarts the session.
export const TAIL_STALL_MS = 60_000;

// ---------- locks (lib/lock.ts) ----------
// Locks are held for milliseconds. A waiter gives up (throws LOCK) after the timeout: under the hooks' own timeouts
// (hooks.json: 10 s, SessionEnd 5 s), so a wedged lock is reported as LOCK instead of the hook being killed.
export const LOCK_TIMEOUT_MS = 4000;
// A lock whose owner cannot be checked (another host, an unreadable or legacy body) is stale after this.
export const LOCK_STALE_MS = 10_000;
// The row map (lib/rows.ts) is written from PostToolUse / SubagentStop hooks: wait less, then throw.
export const ROWS_LOCK_TIMEOUT_MS = 3000;
export const ROWS_LOCK_STALE_MS = 5000;
// A crashed breaker's `.break` file is removed after this (breaking takes microseconds).
export const LOCK_BREAK_STALE_MS = 2000;
export const LOCK_START_SLACK_S = 2;           // pid start-time tolerance when checking a lock owner for pid reuse
export const LOCK_REUSE_CHECK_MS = 1000;       // a live owner's lock younger than this is never checked for pid reuse

// ---------- the room's Claude (lib/room-claude.ts) ----------
export const SPAWN_TIMEOUT_MS = 30_000;        // `claude --bg` and `claude stop`
export const REAP_GRACE_MS = 10_000;           // SUB_HUMAN_REAP_GRACE_MS (allowZero): a quick rejoin cancels the reap
export const REAP_WAIT_MS = 20_000;            // SUB_HUMAN_REAP_WAIT_MS (allowZero): wait for task 1 before `claude stop`
export const REAP_POLL_MS = 500;
export const REAP_STOP_MS = 5000;              // after `claude stop`: how long the reaper waits for the room Claude's process to go before it ends it itself
export const ROOM_CLAUDE_BIND_MS = 120_000;           // a spawned room Claude that never bound in this long is spawned again
export const ROOM_CLAUDE_WATCH_POLL_MS = 5_000;       // the detached starter checks its job this often until it binds (watchStart)

// ---------- room Claude lifecycle: spawn claim, watchdog, seat liveness (lib/room-claude.ts, lib/identity.ts) ----------
// A {job:'pending'} spawn claim older than this is stale (its detached starter died or hung): the next
// join claims again. Longer than a stop + a spawn (2 x SPAWN_TIMEOUT_MS) plus the job lookup.
export const ROOM_CLAUDE_CLAIM_MS = 90_000;
// roomClaude.watchdog reaps a room that has had no live member for this long (members that crashed leave no
// SessionEnd, so no reaper was started for them).
export const ROOM_CLAUDE_ORPHAN_MS = 60_000;          // SUB_HUMAN_ROOM_CLAUDE_ORPHAN_MS
// A seat's stored pid start time must match the live pid's within this (ps lstart has 1 s resolution).
export const PID_START_SLACK_S = 2;
// The seat lease (identity.heartbeat / seatAlive): the tail's health tick and the hold server renew members'
// seen_at at most every SEAT_BEAT_MS; a seat with no pid to check (a remote store) is alive while seen_at is
// younger than SEAT_LEASE_MS. Locally the pid and its start time stay the primary check.
export const SEAT_BEAT_MS = 30_000;
export const SEAT_LEASE_MS = 120_000;

// ---------- hooks ----------
export const REWAKE_WAIT_MS = 3000;            // SUB_HUMAN_REWAKE_WAIT_MS (allowZero): row-rewake waits for the seat
export const REWAKE_POLL_MS = 100;
export const ROW_SPAWN_GRACE_MS = 60_000;      // a row spawned this recently may not hold yet: never re-listed

// ---------- hooks module (mod/, hooks/handlers/mod-hello.ts) ----------
// A lease not from the joining claude process counts this long after it was written (the pid match is the real check).
export const MOD_LEASE_FRESH_MS = 120_000;
// the tail child's restart backoff and the delivery-error notice's window: owned by mod/core (the module reads them too)
export { MOD_RESTART_MS, MOD_RESTART_MAX_MS, MOD_RESTART_STEADY_MS, MOD_DELIVERY_ERROR_LOG_MS } from '../mod/core/constants.ts';

// ---------- remote rooms (lib/remote/bridge.ts) ----------
// A hook's synchronous call over the link gives up (OFFLINE) after this, well inside the hook timeout.
export const LINK_CALL_MS = 3000;              // hooks with a 10 s timeout
export const LINK_CALL_END_MS = 1000;          // SessionEnd (5 s timeout)
// The link daemon answers a hook's relayed op by this, inside LINK_CALL_MS, even when the host has not: a signed
// @room post sent already then stays in the outbox under its nonce ("⧗ sending (slow link)"), and any other op
// says its outcome is unknown, never "nothing was sent" (a slow link delivers the frame late; lib/remote/link.ts).
export const LINK_RELAY_MS = 2000;
// One protocol frame (lib/remote/protocol.ts), bytes: a plan blob (PROPOSAL_FILE_MAX) in base64 fits.
export const LINK_FRAME_MAX_BYTES: number = 1024 * 1024;
// The link daemon (lib/remote/link.ts): the join hook waits this long for it to listen; a lost connection is
// tried again after a jittered delay from LINK_RETRY_MS up to LINK_RETRY_MAX_MS; it exits LINK_IDLE_MS after
// this machine has no seat left in the room.
export const LINK_START_MS = 2000;             // with LINK_JOIN_WAIT_MS and the join hook's 1 s restart: inside its 10 s
export const LINK_HELLO_MS = 15_000;           // the daemon's hello: an ssh transport connects (and authenticates) first
// A wss/ws link's WebSocket (TCP, TLS, upgrade), before the Noise handshake: a ts.net name's first TLS handshake
// waits while Tailscale fetches its certificate (~20 s seen cold), so this is generous.
export const WS_CONNECT_MS = 45_000;           // SUB_HUMAN_WS_CONNECT_MS
// Retries use decorrelated jitter: each delay is random in [LINK_RETRY_MS, 3 x the last one], capped at
// LINK_RETRY_MAX_MS, so links that dropped together do not redial together.
export const LINK_RETRY_MS = 1000;             // SUB_HUMAN_LINK_RETRY_MS
export const LINK_RETRY_MAX_MS = 10_000;       // SUB_HUMAN_LINK_RETRY_MAX_MS: a healed link is back within ~10 s (was 30 s: 26 s after a heal, live run)
export const LINK_IDLE_MS = 60_000;            // SUB_HUMAN_LINK_IDLE_MS
// A planned handoff (lib/handoff.ts): the ask waits this long for the target's card answer; the new host's
// invites the old host hands out (also to a member that reconnects late) are kept this long; a manual promote
// needs the link down at least PROMOTE_OFFLINE_MS (else --force).
export const HANDOFF_ASK_MS: number = 10 * 60_000;
export const HANDOFF_INVITE_MS: number = 24 * 60 * 60_000;
export const HANDOFF_CALL_MS = 6000;           // the target's accept op (the old host appends, releases its room Claude): in a 10 s hook
export const PROMOTE_OFFLINE_MS: number = 10 * 60_000;
// An invite (lib/remote/invites.ts): the host checks its PIN online only, INVITE_PIN_TRIES times, and the invite burns
// at the last wrong one or INVITE_TTL_MS after it was minted (whichever is first), or on success. An invite line's PIN
// (protocol 3) is throttled too: after the n-th wrong one the invite takes no PIN for PIN_BACKOFF_MS * 2^(n-1) (2, 4, 8,
// 16 s), and the machine that typed it waits one step longer. At most SHORT_LIVE_MAX open per room. The joiner whose PIN
// held then waits ADMIT_TTL_MS for the host person's card (Let in / Refuse) before it lapses.
export const INVITE_TTL_MS: number = 15 * 60_000;
export const INVITE_PIN_TRIES = 5;
export const PIN_BACKOFF_MS = 2000;              // SUB_HUMAN_PIN_BACKOFF_MS, honoured under the tests only (testMs)
export const SHORT_LIVE_MAX = 4;
export const ADMIT_TTL_MS: number = 10 * 60_000;       // SUB_HUMAN_ADMIT_TTL_MS, honoured under the tests only (testMs)
// The join hook waits this long for a fresh link's first hello (redeem or refusal) before it answers.
export const LINK_JOIN_WAIT_MS = 4000;
// The app-level heartbeat (op ping, to a server whose caps list it): a ping every LINK_PING_MS; no pong within
// LINK_PONG_MS makes the link suspect (a new connection is made before the old one is dropped); none within
// LINK_DEAD_MS declares it dead (a half-open TCP or ssh link after a sleep). The server closes a session that
// said hello with caps.ping and then sent nothing for LINK_SILENT_MS.
export const LINK_PING_MS = 15_000;            // SUB_HUMAN_LINK_PING_MS
export const LINK_PONG_MS = 5000;              // SUB_HUMAN_LINK_PONG_MS
export const LINK_DEAD_MS = 10_000;            // SUB_HUMAN_LINK_DEAD_MS
export const LINK_SILENT_MS = 45_000;          // server side: 3 pings missed
// A web session (lib/remote/server.ts, via ws) that has made no link this long after it began is closed: a Noise
// handshake alone (anyone can make one) holds a serve process no longer than this.
export const LINK_AUTH_WAIT_MS = 10_000;
// Wake from sleep: a timer that ticks every LINK_WAKE_TICK_MS and finds the wall clock moved more than
// LINK_WAKE_GAP_MS past the tick (or away from the monotonic clock) means the machine slept: redial at once.
export const LINK_WAKE_TICK_MS = 2000;         // SUB_HUMAN_LINK_WAKE_TICK_MS
export const LINK_WAKE_GAP_MS = 5000;          // SUB_HUMAN_LINK_WAKE_GAP_MS
// A changed set of network addresses (os.networkInterfaces, polled this often) redials at once too.
export const LINK_NET_POLL_MS = 5000;
// The @room outbox (lib/remote/outbox.ts): while the link is down a person's @room post is queued, at most
// LINK_OUTBOX_MAX posts, each for at most LINK_OUTBOX_AGE_MS. The host refuses a signature whose ts is more
// than SIG_SKEW_MS (10 min, lib/room/envelope.ts) from its clock, and the daemon never re-signs, so a post
// queued longer could never be placed: the age stays inside that window, with a minute for clock skew.
export const LINK_OUTBOX_MAX = 50;
export const LINK_OUTBOX_AGE_MS: number = 9 * 60_000;

// ---------- rows (lib/rows.ts) ----------
export const PRESENCE_STALE_MS: number = 6 * 60 * 60 * 1000;
export const HOLDS_STALE_MS = 90_000;          // a holds file not refreshed in this long is dead
export const MISSING_GRACE_MS = 45_000;        // a member who joined this recently is covered by their join notice
export const ROW_NOTICE_MS = 120_000;          // a join / leave leads the room row this long
export const NOTICE_FRESH_MS = 90_000;         // only notices this young are delivered at the moment

// ---------- the hold tool (mcp/hold.ts) ----------
export const HOLD_BEAT_MS = 20_000;            // SUB_HUMAN_HOLD_BEAT_MS: progress re-sent so the MCP idle timeout never fires
export const HOLD_POLL_MS = 1000;              // SUB_HUMAN_HOLD_POLL_MS
export const HOLD_GRACE_MS = 20_000;           // SUB_HUMAN_HOLD_GRACE_MS: a name is announced only after this without a hold
export const HOLD_RESPAWN_MS = 1500;           // SUB_HUMAN_HOLD_RESPAWN_MS
export const HOLD_WHO_MS = 3000;               // SUB_HUMAN_HOLD_WHO_MS: how often `me` is re-resolved
export const HOLD_ROOM_GAP_MS = 30_000;        // SUB_HUMAN_HOLD_ROOM_GAP_MS: a returned room hold still counts as running
export const HOLD_RESPAWN_AFTER_RETURN_MS = 30_000; // a room hold that returned this recently still respawns a cancelled row

// ---------- room log (lib/room/*) ----------
export const RATE_MAX = 6;                     // agent posts to the room per `from` per RATE_WINDOW_MS
// Posts addressed to one member (to !== 'room') have their own bucket per (from, to): a SendMessage to a Claude on
// another machine becomes one (mod/send.ts; native SendMessage does not cross machines), so a reply never eats the
// room budget.
export const RATE_ADDRESSED_MAX = 10;
export const RATE_WINDOW_MS = 60_000;
// A person's own entries (lib/room/rules.ts placeAfter): signed by the hooks, so only a script driving them could
// come near; a person types one keystroke per post. High enough for the tests' bursts (150 per name), low enough
// to bound a flood through the local hooks.
export const RATE_HUMAN_MAX = 300;             // via=human entries per seat per RATE_WINDOW_MS
// Per-link quotas on the host (lib/remote/quota.ts, lib/remote/server.ts), one row per op: a link on another machine
// holds its own key and token, so a script there could send as fast as it likes (each @claude a wake of the host's room
// Claude, each line log growth, each subscribe a replay). Where each count lives: `log` the room's own lines by that
// seat; `link` the host document remote/quota (a reconnect does not reset it); `session` the connection's memory.
export const LINK_QUOTAS = {
  'append.human': { max: 30, windowMs: 60_000, per: 'log' },       // a person's posts, per seat
  'append.agent': { max: 30, windowMs: 60_000, per: 'log' },       // a Claude's posts, per seat, every addressee together
  'blob.put': { max: 40, windowMs: 3_600_000, per: 'link' },      // new plans stored (an hour)
  subscribe: { max: 60, windowMs: 600_000, per: 'link' },          // each one a replay from the asked line (10 min)
  seat: { max: 30, windowMs: 600_000, per: 'link' },               // join and leave
  hello: { max: 120, windowMs: 600_000, per: 'link' },             // a link's hellos (each reconnect says one)
  'hello.session': { max: 10, windowMs: 60_000, per: 'session' },  // any hello on one connection (an invite's, a token's)
  beat: { max: 120, windowMs: 60_000, per: 'session' },            // a lease renewal per seat every SEAT_BEAT_MS, and reconnects
  'blob.get': { max: 600, windowMs: 60_000, per: 'session' },      // plans fetched
  ping: { max: 60, windowMs: 60_000, per: 'session' },             // one every LINK_PING_MS
  handoff: { max: 20, windowMs: 60_000, per: 'session' },          // handoff.accept and handoff.refuse
} as const;

/** One op's quota: at most max in any windowMs, counted where per says (above). */
export interface Quota { max: number; windowMs: number; per: 'log' | 'link' | 'session' }
// checked apart from the table: an exported `satisfies` is a type an isolated declaration cannot infer
LINK_QUOTAS satisfies Record<string, Quota>;

// ---------- what a home stops keeping (lib/gc.ts; it runs from the join path) ----------
// A closed room (no seat alive, no link to it, its room Claude stopped) nobody touched in this long is deleted, with its
// seat keys; so are the folders `sub-human link --forget` set aside. A session index (sessions/by-sid, by-pid) not
// written in this long whose process is gone, and a session's agent -> row map (rooms/CODE/rows/<session>) whose newest
// row is this old, go too.
export const ROOM_GC_MS: number = 30 * 24 * 60 * 60_000;      // SUB_HUMAN_ROOM_GC_MS
export const SESSION_INDEX_TTL_MS: number = 30 * 24 * 60 * 60_000;
export const FORK_RECORD_WAIT_MS = 3000;     // session-restore after ← (the agent view): the old transcript's continued-in record, written just after the fork starts (SUB_HUMAN_FORK_WAIT_MS)
export const ROWS_TTL_MS: number = 7 * 24 * 60 * 60_000;
export const GC_EVERY_MS: number = 6 * 60 * 60_000;           // at most one sweep of the home this often (<home>/gc.json)
export const GC_BUDGET_MS = 250;                      // a sweep stops when it has run this long; the next one goes on

// ---------- room log integrity (lib/room/{store,validate,render}.js) ----------
export const ENTRY_TEXT_MAX_BYTES: number = 16 * 1024; // an entry's text, UTF-8 bytes (validate)
export const ENTRY_REFS_MAX = 50;              // refs per entry (validate)
export const ENTRY_STR_MAX = 4000;             // any other string field, JS .length (validate)
export const ENTRY_LIST_MAX = 50;              // approvers / blockedBy entries (validate)
export const LOG_LINE_MAX_BYTES: number = 64 * 1024;   // one serialized log line, UTF-8 bytes (append refuses longer)
// The log in segments (lib/room/log-io.ts): once the active segment, log.jsonl, holds this many bytes, the line that
// crosses it seals it as log-NNNN.jsonl and writes snapshot.json. A reader starts from the snapshot and parses only the
// active segment, so this bounds a cold reader's parse (about 5,000 lines; a few ms) and a rotation's own cost.
export const SEGMENT_MAX_BYTES: number = 1024 * 1024;
// What a snapshot keeps of its last lines for the next placement (rules.ts scanTail): every entry this close before
// its last line (the rate window, and the nonce window of 2 * SIG_SKEW_MS), at most SNAPSHOT_WINDOW_MAX of them.
export const SNAPSHOT_WINDOW_MAX = 20_000;

// text lines shown per chat message (the rest is "[+N more lines: read(...)]") and every continuation line's prefix:
// owned by mod/core, which draws chat too
export { CHAT_LINES_MAX, CHAT_NEST } from '../mod/core/constants.ts';
export { PULL_CAP } from '../mod/core/constants.ts'; // the tail's room context (pull event)

// ---------- size caps (code points unless noted) ----------
export const CONTEXT_CAP = 9500;               // hook additionalContext (the CLI caps SessionStart / prompt context at 10k)
export const DIGEST_CAP = 9500;                // room.digest()
export const TAIL_MAX = 240;                   // room.line() compact form
export const TEXT_MAX = 2000;                  // room.line({full}) text
export const CHAT_WRAP = 400;                  // one chat output line
export const CHAT_MAX = 1500;                  // one chat message shown; the rest stays in the log
export const BLOCK_MAX = 900;                  // the join / restore mechanics block, with 5 members
export const ROW_MAX = 60;                     // a panel row's text
export const HOLD_MSG_MAX = 140;               // a hold progress line (+ its hint fits two row-view lines at 120 columns)
export const READ_MAX = 100;                   // the MCP read tool's unseen entries
export const SHOWN_MAX = 200;                  // notices-NAME.json ids kept
export const PRESENCE_DETAIL_MAX = 200;
export const TRANSCRIPT_TAIL_BYTES: number = 512 * 1024;
export const PROPOSAL_TITLE_MAX = 160;         // the proposal entry's title line, and each summary line of the card
export const PREVIEW_MAX = 2000;               // the card withholds a preview longer than this (JS .length)
export const PREVIEW_LINES = 20;               // about 24 lines show at 50 rows; keep a margin
export const SUMMARY_MAX = 1200;
export const SUMMARY_LINES = 12;
export const VIEW_MAX = 200_000;               // the plan dialog withholds approval above this (JS .length)
export const PROPOSAL_FILE_MAX: number = 256 * 1024;   // bytes
export const TASK_SUBJECT_MAX = 200;           // the task tool (JS .length)
export const TASK_DETAIL_MAX = 2000;
export const TASK_EVIDENCE_MAX = 2000;
export const TASK_REQ_DETAIL_SHOWN = 200;      // a task_req entry's text shows this much of the detail
export const TASK_REQ_EVIDENCE_SHOWN = 400;

// ---------- consent (lib/room/consent.ts, lib/proposal.ts, lib/rows.ts, hooks/consent.ts, hooks/handlers/session-restore.ts) ----------
export const ROW_TITLE_MAX = 24;               // a proposal's title in a panel row ("✔ decided Cursor paging")
export const REVIEW_LOCK_TIMEOUT_MS = 3000;    // members/NAME/review.json read-modify-write lock (hooks time out at 5-10 s)
// Pre(ExitPlanMode) needs the model's own input from the transcript, which 2.1.292 may not have written yet
// when the hook runs (and tool_input.plan is the plan file's text, empty before the review): poll this long. The
// review's closing ExitPlanMode polls as long for the dialog's rejection line (hooks/consent.ts resolveShown).
export const EXIT_INPUT_WAIT_MS = 1500;        // SUB_HUMAN_EXIT_INPUT_WAIT_MS
export const EXIT_INPUT_POLL_MS = 50;
export const REVIEW_STALE_MS: number = 30 * 60 * 1000; // a plan-view review open this long is stuck: session-restore restores the plan file
// A plan-view Yes this soon after the view was shown is asked again on the card before it records (item 8: keys meant for
// the prompt, typed as the view opened, answered three reviews in the live round). Claude Code draws the dialog about
// 0.1 s after its Pre hook; a person who reads the proposal first takes several seconds.
export const YES_GUARD_MS = 2000;
