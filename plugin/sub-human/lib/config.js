'use strict';
/**
 * plugin/sub-human/lib/config.js: every timing and size cap in one place, named. Zero dependencies.
 * Callers import the value they use; an env override is read by the caller through envMs() at the moment it
 * needs the value (tests set the env per child process, some per call).
 *
 * envMs(name, fallback, {allowZero}?) -> number
 *   process.env[name] as a number of milliseconds, else fallback. Unset, empty, non-numeric, negative or
 *   infinite values give the fallback. 0 also gives the fallback, unless allowZero is set: only the waits
 *   where 0 means "do not wait" take it (REAP_GRACE_MS, REAP_WAIT_MS, REWAKE_WAIT_MS; the tests run the
 *   reaper and the rewake hook with no wait). Everywhere else 0 would mean a busy loop or an instant
 *   flush, so it is ignored.
 */

function envMs(name, fallback, { allowZero = false } = {}) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  if (n === 0 && !allowZero) return fallback;
  return n;
}

module.exports = {
  envMs,

  // ---------- the room monitor (bin/sub-human tail) ----------
  // Entries are batched into one block (one notification, one model turn): flushed after SETTLE_MS of quiet,
  // or SETTLE_MAX_MS after the batch's first entry. Every pushed entry is at least SETTLE_MS old, which is
  // longer than FORGERY_WINDOW_MS, so a peer-forged @room line is retracted before it can be pushed.
  SETTLE_MS: 1500,                 // SUB_HUMAN_SETTLE_MS
  SETTLE_MAX_MS: 5000,             // SUB_HUMAN_SETTLE_MAX_MS
  // The headless orch waits longer (nobody watches its latency), so a burst lands as one turn.
  ORCH_SETTLE_MS: 3000,            // SUB_HUMAN_ORCH_SETTLE_MS
  ORCH_SETTLE_MAX_MS: 10_000,      // SUB_HUMAN_ORCH_SETTLE_MAX_MS
  // A member_left waits this long for a rejoin; a leave + rejoin inside it is no notice at all.
  LEAVE_SETTLE_MS: 8000,           // SUB_HUMAN_LEAVE_MS (monitor, notices, rows, hold)
  UNSEATED_MS: 10_000,             // SUB_HUMAN_UNSEATED_MS: no seat yet, look it up this rarely
  RESOLVE_MS: 2000,                // SUB_HUMAN_RESOLVE_MS: seated, re-resolve the seat this often
  TAIL_POLL_MS: 250,               // SUB_HUMAN_POLL_MS: the monitor's log poll
  FOLLOW_POLL_MS: 250,             // room.follow default poll
  WATCH_POLL_MS: 500,              // `sub-human watch --follow` poll

  // ---------- the monitor loop's health (lib/tail.js; wave 2 agent F) ----------
  // A monitor whose process exits is never re-armed in that Claude process, so the tail never exits on an
  // error: it logs (rate-limited), backs off and carries on. Every TAIL_HEALTH_MS it checks the log's hash
  // chain from the log.idx checkpoint and, while it is the orch, runs orch.watchdog(code).
  TAIL_HEALTH_MS: 5000,            // SUB_HUMAN_TAIL_HEALTH_MS
  TAIL_BACKOFF_MS: 1000,           // SUB_HUMAN_TAIL_BACKOFF_MS: first retry delay after an error, doubled per failure
  TAIL_BACKOFF_MAX_MS: 30_000,     // SUB_HUMAN_TAIL_BACKOFF_MAX_MS
  TAIL_ERROR_LOG_MS: 60_000,       // SUB_HUMAN_TAIL_ERROR_LOG_MS: one stderr line per error site per this long
  // Seated, the poll loop must have ticked within this long, or the next seat check restarts the session.
  TAIL_STALL_MS: 60_000,           // SUB_HUMAN_TAIL_STALL_MS

  // ---------- locks (lib/lock.js) ----------
  // Locks are held for milliseconds. A waiter gives up (throws LOCK) after the timeout.
  LOCK_TIMEOUT_MS: 15_000,
  // A lock whose owner cannot be checked (another host, an unreadable or legacy body) is stale after this.
  LOCK_STALE_MS: 10_000,
  // The row map (lib/rows.js) is written from PostToolUse / SubagentStop hooks: wait less, then throw.
  ROWS_LOCK_TIMEOUT_MS: 3000,
  ROWS_LOCK_STALE_MS: 5000,
  // A crashed breaker's `.break` file is removed after this (breaking takes microseconds).
  LOCK_BREAK_STALE_MS: 2000,
  LOCK_START_SLACK_S: 2,           // pid start-time tolerance when checking a lock owner for pid reuse
  LOCK_REUSE_CHECK_MS: 1000,       // a live owner's lock younger than this is never checked for pid reuse

  // ---------- the orch (lib/orch.js) ----------
  SPAWN_TIMEOUT_MS: 30_000,        // `claude --bg` and `claude stop`
  REAP_GRACE_MS: 10_000,           // SUB_HUMAN_REAP_GRACE_MS (allowZero): a quick rejoin cancels the reap
  REAP_WAIT_MS: 20_000,            // SUB_HUMAN_REAP_WAIT_MS (allowZero): wait for task 1 before `claude stop`
  REAP_POLL_MS: 500,
  ORCH_BIND_MS: 120_000,           // a spawned orch that never bound in this long is spawned again

  // ---------- orch lifecycle: spawn claim, watchdog, seat liveness (lib/orch.js, lib/identity.js) ----------
  // A {job:'pending'} spawn claim older than this is stale (its detached starter died or hung): the next
  // join claims again. Longer than a stop + a spawn (2 x SPAWN_TIMEOUT_MS) plus the job lookup.
  ORCH_CLAIM_MS: 90_000,           // SUB_HUMAN_ORCH_CLAIM_MS
  // orch.watchdog reaps a room that has had no live member for this long (members that crashed leave no
  // SessionEnd, so no reaper was started for them).
  ORCH_ORPHAN_MS: 60_000,          // SUB_HUMAN_ORCH_ORPHAN_MS
  // A seat's stored pid start time must match the live pid's within this (ps lstart has 1 s resolution).
  PID_START_SLACK_S: 2,
  // The seat lease (identity.heartbeat / seatAlive): the tail's health tick and the hold server renew members'
  // seen_at at most every SEAT_BEAT_MS; a seat with no pid to check (a remote store) is alive while seen_at is
  // younger than SEAT_LEASE_MS. Locally the pid and its start time stay the primary check.
  SEAT_BEAT_MS: 30_000,
  SEAT_LEASE_MS: 120_000,

  // ---------- hooks ----------
  FORGERY_WINDOW_MS: 1200,         // SUB_HUMAN_FORGERY_MS: how long at-room's checker polls the transcript
  FORGERY_POLL_MS: 150,
  REWAKE_WAIT_MS: 3000,            // SUB_HUMAN_REWAKE_WAIT_MS (allowZero): row-rewake waits for the seat
  REWAKE_POLL_MS: 100,
  ROW_SPAWN_GRACE_MS: 60_000,      // a row spawned this recently may not hold yet: never re-listed

  // ---------- rows (lib/rows.js) ----------
  PRESENCE_STALE_MS: 6 * 60 * 60 * 1000,
  HOLDS_STALE_MS: 90_000,          // a holds file not refreshed in this long is dead
  MISSING_GRACE_MS: 45_000,        // a member who joined this recently is covered by their join notice
  ROW_NOTICE_MS: 120_000,          // a join / leave leads the room row this long
  NOTICE_FRESH_MS: 90_000,         // only notices this young are delivered at the moment

  // ---------- the hold tool (mcp/hold.js) ----------
  HOLD_BEAT_MS: 20_000,            // SUB_HUMAN_HOLD_BEAT_MS: progress re-sent so the MCP idle timeout never fires
  HOLD_POLL_MS: 1000,              // SUB_HUMAN_HOLD_POLL_MS
  HOLD_GRACE_MS: 20_000,           // SUB_HUMAN_HOLD_GRACE_MS: a name is announced only after this without a hold
  HOLD_RESPAWN_MS: 1500,           // SUB_HUMAN_HOLD_RESPAWN_MS
  HOLD_WHO_MS: 3000,               // SUB_HUMAN_HOLD_WHO_MS: how often `me` is re-resolved
  HOLD_ROOM_GAP_MS: 30_000,        // SUB_HUMAN_HOLD_ROOM_GAP_MS: a returned room hold still counts as running
  HOLD_RESPAWN_AFTER_RETURN_MS: 30_000, // a room hold that returned this recently still respawns a cancelled row

  // ---------- room log (lib/room/*) ----------
  RATE_MAX: 6,                     // agent posts per `from` per RATE_WINDOW_MS
  RATE_WINDOW_MS: 60_000,

  // ---------- room log integrity (lib/room/{store,validate,render}.js; wave 1 agent A) ----------
  ENTRY_TEXT_MAX_BYTES: 16 * 1024, // an entry's text, UTF-8 bytes (validate)
  ENTRY_REFS_MAX: 50,              // refs per entry (validate)
  ENTRY_STR_MAX: 4000,             // any other string field, JS .length (validate)
  ENTRY_LIST_MAX: 50,              // approvers / blockedBy entries (validate)
  LOG_LINE_MAX_BYTES: 64 * 1024,   // one serialized log line, UTF-8 bytes (append refuses longer)
  CHAT_LINES_MAX: 20,              // text lines shown per chat message; the rest is "[+N more lines: read(...)]"
  CHAT_NEST: '  │ ',              // the prefix of every continuation line of a chat message

  // ---------- size caps (code points unless noted) ----------
  CONTEXT_CAP: 9500,               // hook additionalContext (the CLI caps SessionStart / prompt context at 10k)
  DIGEST_CAP: 9500,                // room.digest()
  TAIL_MAX: 240,                   // room.line() compact form
  TEXT_MAX: 2000,                  // room.line({full}) text
  CHAT_WRAP: 400,                  // chat output line: Claude Code cuts a monitor line at 500 chars
  CHAT_MAX: 1500,                  // one chat message shown; the rest stays in the log
  PULL_CAP: 1500,                  // at-room's "Room since your last turn"
  BLOCK_MAX: 900,                  // the join / restore mechanics block, with 5 members
  ROW_MAX: 60,                     // a panel row's text
  HOLD_MSG_MAX: 140,               // a hold progress line (+ its hint fits two row-view lines at 120 columns)
  READ_MAX: 100,                   // the MCP read tool's unseen entries
  SHOWN_MAX: 200,                  // notices-NAME.json ids kept
  PRESENCE_DETAIL_MAX: 200,
  TRANSCRIPT_TAIL_BYTES: 512 * 1024,
  PROPOSAL_TITLE_MAX: 160,         // the proposal entry's title line, and each summary line of the card
  PREVIEW_MAX: 2000,               // the card withholds a preview longer than this (JS .length)
  PREVIEW_LINES: 20,               // about 24 lines show at 50 rows; keep a margin
  SUMMARY_MAX: 1200,
  SUMMARY_LINES: 12,
  VIEW_MAX: 200_000,               // the plan dialog withholds approval above this (JS .length)
  PROPOSAL_FILE_MAX: 256 * 1024,   // bytes
  TASK_SUBJECT_MAX: 200,           // the task tool (JS .length)
  TASK_DETAIL_MAX: 2000,
  TASK_EVIDENCE_MAX: 2000,
  TASK_REQ_DETAIL_SHOWN: 200,      // a task_req entry's text shows this much of the detail
  TASK_REQ_EVIDENCE_SHOWN: 400,

  // ---------- consent (lib/consent.js, lib/proposal.js, lib/rows.js, hooks/consent.js, hooks/session-restore.js) ----------
  ROW_TITLE_MAX: 24,               // a proposal's title in a panel row ("✔ decided Cursor paging")
  REVIEW_LOCK_TIMEOUT_MS: 3000,    // members/NAME/review.json read-modify-write lock (hooks time out at 5-10 s)
  REVIEW_STALE_MS: 30 * 60 * 1000, // a plan-view review open this long is stuck: session-restore restores the plan file
};
