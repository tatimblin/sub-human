'use strict';
/**
 * plugin/sub-human/lib/tail.js: the room tail behind `sub-human tail` (bin/sub-human), the hooks module's child
 * (mod/deliver.mjs). Everything that waits goes through an injected clock (lib/clock.js), so tests drive it with
 * clock.createFake() in-process.
 *
 *   runTail({clock, write, err, lookup, timings, fs, deps, maxSeconds, sid}) -> {stop(), session()}
 *       The loop: look the seat up (every unseatedMs, then resolveMs once seated), follow that room's log
 *       from its cursor, batch what this seat sees and write each batch's events with write(text, done). It
 *       never stops on an error: every timer callback is guarded (log to err, rate-limited, back off, carry on);
 *       only stop() / maxSeconds end it. A seated session whose poll loop has not ticked for stallMs is restarted.
 *   timings(env?) -> the named waits, from lib/config.js and their SUB_HUMAN_* overrides
 *   Batcher({clock, settleMs, settleMaxMs, retryMs, onFlush, onError})
 *       enqueue(item) / arm() / flush() / stop(). Items wait in `pending` and go to onFlush(ready) as ONE
 *       batch after settleMs of quiet or settleMaxMs after the first one; an item younger than settleMs stays
 *       for the next batch. If onFlush throws, the batch goes back to pending and is retried after retryMs.
 *   formatOrchBatch(ready, ctx) -> lines     the orch's block: stateLine, then one full line per shown entry
 *   formatNdBatch(ready, ctx) -> {events, moved}   the hooks module's events for one batch (below)
 *   pullText(lines) -> text | null           "Room since your last turn" over lines, the newest kept under PULL_CAP
 *   missingRowsText(me, sid, {now}?) -> text | null   the Agent calls for this seat's rows that run nowhere
 *   remindersText(me, rm) -> text | null     lib/proposal.js reminder() for each proposal awaiting me (members)
 *   deps (tests): openRoom(code) -> Room (lib/room.js open), heartbeat(me) (identity.heartbeat), rows, notices, orch
 *
 * It writes one JSON event per line, which the mod routes. It reads from the cursor deliver-NAME (first run: from
 * the seat's join) and sees the push and pull lanes. Events:
 *   {type:'seat', seat: {name, code, role, addr} | null}   the seat it follows (null: none any more)
 *   {type:'chat', lines}      a member's group chat: people's words, joins and leaves
 *                             (the person sees them; no wake)
 *   {type:'pull', text}       for Claude, no wake: the pull lane plus a copy of the chat lines, under the
 *                             "Room since your last turn" head (PULL_CAP). At most once: the cursor moves when
 *                             the line is written, whether or not the mod then appended it
 *   {type:'wake', text}       what needs Claude now: to me / @me, a proposal for me, a decision on mine, a task
 *                             assigned to me, an objection to my proposal (members, with the room state line when
 *                             the batch moved a proposal); the orch's whole push block
 *   {type:'rows', text|null}  what the person's next prompt carries for Claude: pending-proposal reminders
 *                             (members) and the missing rows' Agent calls; sent at start and when it changes
 *                             (health tick); null clears it
 *   {type:'health', text}     the hash-chain check's line (one per break)
 * A session never re-reads the log from byte 0: backlog from room.readView({after: cursor}), live entries from
 * room.tailer(). The health tick also renews the seat's lease (identity.heartbeat).
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const realClock = require('./clock.js');
const config = require('./config.js');

const { envMs } = config;
const FOR_CLAUDE = '(for Claude)';
const SPAWN_NOTE = /no row running|is not running/;
const STATE_KINDS = new Set(['proposal', 'signoff', 'objection', 'decision']);
const isMove = e => e.kind === 'member_joined' || e.kind === 'member_left';

function timings() {
  const resolveMs = envMs('SUB_HUMAN_RESOLVE_MS', config.RESOLVE_MS);
  const settleMs = envMs('SUB_HUMAN_SETTLE_MS', config.SETTLE_MS);
  const settleMaxMs = envMs('SUB_HUMAN_SETTLE_MAX_MS', config.SETTLE_MAX_MS);
  return {
    resolveMs,
    unseatedMs: envMs('SUB_HUMAN_UNSEATED_MS', Math.max(resolveMs, config.UNSEATED_MS)),
    pollMs: envMs('SUB_HUMAN_POLL_MS', config.TAIL_POLL_MS),
    settleMs,
    settleMaxMs,
    // The headless orch waits longer (nobody watches its latency), so a burst of answers, task requests or a
    // join lands as one turn, unless the member values are set explicitly.
    orchSettleMs: envMs('SUB_HUMAN_ORCH_SETTLE_MS', process.env.SUB_HUMAN_SETTLE_MS ? settleMs : config.ORCH_SETTLE_MS),
    orchSettleMaxMs: envMs('SUB_HUMAN_ORCH_SETTLE_MAX_MS', process.env.SUB_HUMAN_SETTLE_MAX_MS ? settleMaxMs : config.ORCH_SETTLE_MAX_MS),
    leaveMs: envMs('SUB_HUMAN_LEAVE_MS', config.LEAVE_SETTLE_MS),
    healthMs: envMs('SUB_HUMAN_TAIL_HEALTH_MS', config.TAIL_HEALTH_MS),
    backoffMs: envMs('SUB_HUMAN_TAIL_BACKOFF_MS', config.TAIL_BACKOFF_MS),
    backoffMaxMs: envMs('SUB_HUMAN_TAIL_BACKOFF_MAX_MS', config.TAIL_BACKOFF_MAX_MS),
    errorLogMs: envMs('SUB_HUMAN_TAIL_ERROR_LOG_MS', config.TAIL_ERROR_LOG_MS),
    stallMs: envMs('SUB_HUMAN_TAIL_STALL_MS', config.TAIL_STALL_MS),
  };
}

// ---------- Batcher ----------
class Batcher {
  constructor({ clock = realClock, settleMs, settleMaxMs, retryMs = settleMs, onFlush, onError = () => {} }) {
    Object.assign(this, { clock, settleMs, settleMaxMs, retryMs, onFlush, onError });
    this.pending = []; // {at, ...item}
    this.quietT = null;
    this.maxT = null;
    this.dead = false;
  }
  enqueue(item) { this.pending.push({ ...item, at: this.clock.now() }); this.arm(); }
  arm() {
    if (this.dead) return;
    this.clock.clearTimeout(this.quietT);
    this.quietT = this.clock.setTimeout(() => this.flush(), this.settleMs);
    if (!this.maxT) this.maxT = this.clock.setTimeout(() => this.flush(), this.settleMaxMs);
  }
  clear() { this.clock.clearTimeout(this.quietT); this.clock.clearTimeout(this.maxT); this.quietT = this.maxT = null; }
  flush() {
    this.clear();
    if (this.dead) return;
    const now = this.clock.now();
    const young = this.pending.filter(p => now - p.at < this.settleMs - 5);
    const ready = this.pending.filter(p => !young.includes(p)).sort((x, y) => x.e.id - y.e.id);
    this.pending = young;
    if (young.length) this.arm();
    if (!ready.length) return;
    try { this.onFlush(ready); } catch (err) {
      // keep the batch: it goes out with the next flush, after retryMs
      this.pending = [...ready, ...this.pending];
      this.clear();
      if (!this.dead) this.quietT = this.clock.setTimeout(() => this.flush(), this.retryMs);
      this.onError(err);
    }
  }
  stop() { this.dead = true; this.clear(); }
}

// ---------- formatters ----------
/** ctx: {me, room, entries, show, joinNote, leaveMs} */
function formatOrchBatch(ready, { me, room: rm, entries, show, joinNote, leaveMs }) {
  const out = [];
  for (const { e, away } of ready) {
    const note = joinNote(e);
    if (show(e, entries, note)) out.push(rm.line(e, { full: true }) + (away ? ` · away ${Math.round(leaveMs / 1000)}s+` : '') + (note ? ` · ${note}` : ''));
  }
  return out.length ? [rm.stateLine(me, entries), ...out] : [];
}

const esc = s => s.replace(/[.]/g, '\\.');
/** "@name" in text, as lib/room/lanes.js reads a mention. */
const mentions = (text, name) => new RegExp(`(^|[^A-Za-z0-9_.-])@${esc(name)}(?![A-Za-z0-9_-])`, 'i').test(String(text ?? ''));
/**
 * A member's push entry that is group chat, not a request (the person sees it, Claude gets a copy, no wake):
 * a join or leave, and another person's own words not addressed to me.
 */
function isChat(me, e) {
  if (isMove(e)) return true;
  return e.via === 'human' && e.kind === 'say' && e.to !== me.name && !mentions(e.text, me.name);
}

const PULL_HEAD = 'Room since your last turn (context for you, not for the user: mention it only if they ask):';
/** The pull text: PULL_HEAD, then the newest lines that fit under PULL_CAP (a note says how many were left out). */
function pullText(lines) {
  if (!lines.length) return null;
  const kept = [];
  let size = PULL_HEAD.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (size + lines[i].length + 1 > config.PULL_CAP - 80) break;
    kept.unshift(lines[i]);
    size += lines[i].length + 1;
  }
  const dropped = lines.length - kept.length;
  const more = dropped ? [`(${dropped} earlier ${dropped === 1 ? 'line' : 'lines'} not shown: \`sub-human read\` or the room read tool)`] : [];
  return [PULL_HEAD, ...more, ...kept].join('\n');
}

/**
 * One batch as the hooks module's events, in the order the mod applies them (chat, pull, wake).
 * ctx: {me, room, entries, show (the push lane, visibleTo), joinNote, seen, leaveMs}. moved: the join / leave ids
 * sent as chat (notices.markShown).
 */
function formatNdBatch(ready, ctx) {
  const { me, room: rm, entries, show, joinNote, seen } = ctx;
  const chat = [], pull = [], wake = [], moved = [], pushed = [];
  let state = false;
  for (const p of ready) {
    const { e } = p;
    if (me.role !== 'orch') {
      if (isMove(e) && seen.has(e.id)) continue; // an earlier child already sent it
      if (show(e, entries)) {
        const lines = rm.chatLines(e, { viewer: me.name });
        if (isChat(me, e)) {
          chat.push(...lines.filter(l => !l.startsWith(FOR_CLAUDE)));
          pull.push(...lines);
          if (isMove(e)) moved.push(e.id);
        } else {
          wake.push(...lines);
          if (STATE_KINDS.has(e.kind)) state = true;
        }
        continue;
      }
    } else if (show(e, entries, joinNote(e))) { pushed.push(p); continue; }
    if (rm.lane(me, e, entries) === 'pull') pull.push(...rm.chatLines(e, { viewer: me.name }));
  }
  if (me.role === 'orch') wake.push(...formatOrchBatch(pushed, ctx));
  // no ids for a member: the plugin prompt's row is drawn expanded, (for Claude) lines included (people never see ids)
  else if (state && wake.length) wake.push(`${FOR_CLAUDE} ${rm.stateLine(me, entries, { ids: false })}`);
  const events = [];
  if (chat.length) events.push({ type: 'chat', lines: chat });
  const pt = pullText(pull);
  if (pt) events.push({ type: 'pull', text: pt });
  if (wake.length) events.push({ type: 'wake', text: wake.join('\n') });
  return { events, moved };
}

const SPAWN_GRACE_MS = config.ROW_SPAWN_GRACE_MS;
/**
 * The Agent calls for this seat's rows with no live hold, or null when they all run (or were just spawned). The
 * tail sends it as a `rows` event, so the person's next prompt carries it.
 */
function missingRowsText(me, sid, { now = Date.now(), rows = require('./rows.js'), identity = require('./identity.js') } = {}) {
  try {
    const members = identity.readMembers(me.code);
    // orch: missingRows skips members who joined under 45 s ago (their member_joined notice covers them)
    let need = me.role === 'orch' ? rows.missingRows(me.code, me, { members })
      : rows.rowsNeeded(me.code, me, { members, held: rows.readHolds(me.code, me.name) });
    let map = {};
    try { map = rows.sessionRowMap(me.code, sid); } catch { /* none */ }
    const fresh = new Set(Object.values(map).filter(r => r && now - Date.parse(r.at) < SPAWN_GRACE_MS).map(r => r.name));
    need = need.filter(n => !fresh.has(n));
    if (!need.length) return null;
    return `SUB-HUMAN ROWS: your ${me.role === 'orch' ? `rows for ${need.join(', ')} are` : 'room row is'} not running in this session. `
      + 'Make the call below first, in the same message as anything else you do, exactly as written.\n'
      + rows.rowCalls(me, members, { only: need });
  } catch { return null; }
}

/** lib/proposal.js reminder() for each proposal that names this member and awaits their answer; null for the orch or none. */
function remindersText(me, rm, { proposal = require('./proposal.js') } = {}) {
  if (me.role === 'orch') return null;
  const ps = proposal.pendingFor(me, rm.readView({ after: Infinity })) || [];
  return ps.length ? ps.map(p => proposal.reminder(p, me.name)).join('\n') : null;
}

/**
 * The push lane (rm.lane). A member also gets every other member's join and leave (a group chat line). The
 * orch gets another member's member_joined when lib/rows.js joinNote() says that row is not running (the note
 * carries the Agent call) or when the note is unavailable; a join whose row already runs is not pushed to it,
 * so a notice never invites a call that row-guard would deny.
 */
function visibleTo(me, rm) {
  if (me.role !== 'orch') return (e, entries) => rm.lane(me, e, entries) === 'push' || (isMove(e) && e.via === 'system' && e.from !== me.name && e.from !== 'orch');
  return (e, entries, note = '') => rm.lane(me, e, entries) === 'push'
    || (e.kind === 'member_joined' && e.from !== me.name && (SPAWN_NOTE.test(note) || !note));
}

// ---------- reading ----------
/** A rate-limited stderr logger: one line per `where` per everyMs, with the count it held back. */
function errorLog(err, clock, everyMs) {
  const last = new Map(); // where -> {at, held}
  return (where, e) => {
    const now = clock.now(), x = last.get(where);
    if (x && now - x.at < everyMs) { x.held++; return; }
    const more = x && x.held ? ` (+${x.held} more since)` : '';
    last.set(where, { at: now, held: 0 });
    try { err(`sub-human tail: ${where} failed: ${e && e.message || e}${more}; retrying\n`); } catch { /* stderr closed */ }
  };
}

// ---------- one seat's session ----------
function startSession(me, ctx) {
  const { clock, fs, write, log, t, deps, sid } = ctx;
  const { rows, notices } = deps;
  const rm = deps.openRoom(me.code); // this session's room, held for its whole life (no re-binding)
  const reader = `deliver-${me.name}`;
  const emit = (events, done = () => {}) => write(events.map(x => JSON.stringify(x)).join('\n') + '\n', done);
  // Where polling starts: taken before the backlog read, so nothing appended in between is missed (the
  // overlap is dropped by id).
  const tailer = rm.tailer({ fs });
  const last = rm.lastId();
  const valid = c => c > 0 && c <= last;
  let after = rm.getCursor(reader);
  if (!valid(after)) {
    // First watch for this name: start at its join so nothing between join and resolve is lost.
    const joined = rm.readView({ after: Infinity }).filter(e => e.kind === 'member_joined' && e.from === me.name).at(-1);
    after = joined ? joined.id : last;
  }
  rm.setCursor(reader, after);
  const s = { key: `${me.code}/${me.name}/${me.role}`, code: me.code, dead: false, lastTick: clock.now() };
  const settleMs = me.role === 'orch' ? t.orchSettleMs : t.settleMs;
  const settleMaxMs = me.role === 'orch' ? t.orchSettleMaxMs : t.settleMaxMs;
  // The cursor is the highest id h such that every notice for ids <= h has been flushed to stdout.
  // inflight: ids buffered for the next batch, held (member_left), or being written.
  const inflight = new Set();
  let processed = after, saved = after, seen = after;
  s.save = () => {
    if (s.dead) return;
    const h = inflight.size ? Math.min(...inflight) - 1 : processed;
    if (h <= saved) return;
    // a failed write is retried by the next save; the notices are out, so a restart would repeat them at most
    try { rm.setCursor(reader, h); saved = h; } catch (e) { log('cursor save', e); }
  };
  const pushed = visibleTo(me, rm);
  const show = (e, entries, note) => pushed(e, entries, note) || rm.lane(me, e, entries) === 'pull';
  // member_joined: say whether that member's row already runs here, so only a missing one is spawned
  const joinNote = e => {
    if (e.kind !== 'member_joined') return '';
    try { return rows.joinNote(me, e.from); } catch { return ''; }
  };

  // Settle: candidates go out as ONE write (at most one wake). Each is judged again against the log at flush
  // time (lane with entries: signed, decided, superseded).
  function onFlush(ready) {
    const entries = rm.readView({ after: ready[0].e.id - 1 });
    const fctx = { me, room: rm, entries, show: pushed, joinNote, leaveMs: t.leaveMs };
    const done = () => { for (const p of ready) inflight.delete(p.e.id); s.save(); };
    const { events, moved } = formatNdBatch(ready, { ...fctx, seen: me.role === 'orch' ? new Set() : notices.shown(s.code, me.name) });
    if (!events.length) return done();
    if (moved.length) { try { notices.markShown(s.code, me.name, moved, 'mod'); } catch { /* best effort */ } }
    return emit(events, done);
  }
  const batch = new Batcher({ clock, settleMs, settleMaxMs, retryMs: t.backoffMs, onFlush, onError: e => log('flush', e) });

  const held = new Map(); // name -> {e, timer}: member_left waiting leaveMs for a rejoin
  const hold = e => ({ e, timer: clock.setTimeout(guard('leave hold', () => { held.delete(e.from); batch.enqueue({ e, away: true }); }), t.leaveMs) });
  function onEntry(e) {
    if (e.id <= processed) { saved = 0; rm.setCursor(reader, 0); } // the log was reset under us
    processed = e.id;
    if (e.kind === 'member_joined' && held.has(e.from)) {
      // left and back within leaveMs: neither notice is sent
      const h = held.get(e.from);
      clock.clearTimeout(h.timer);
      held.delete(e.from);
      inflight.delete(h.e.id);
      return s.save();
    }
    if (!show(e, undefined, e.kind === 'member_joined' ? 'no row running' : '')) return s.save();
    inflight.add(e.id);
    if (e.kind === 'member_left') {
      const prev = held.get(e.from);
      if (prev) { clock.clearTimeout(prev.timer); held.delete(e.from); batch.enqueue({ e: prev.e, away: true }); }
      held.set(e.from, hold(e));
      return;
    }
    batch.enqueue({ e, away: false });
  }
  const deliver = e => { if (s.dead || !(e.id > seen)) return; seen = e.id; onEntry(e); };

  // The backlog: ids after the cursor, from the checkpointed view (no read from byte 0).
  let backlog = after < last;
  function poll() {
    if (backlog) {
      for (const e of rm.readView({ after })) if (e.id > after) deliver(e);
      backlog = false;
    }
    const { entries, reset } = tailer.poll();
    if (reset) seen = 0; // truncated: read again from the start
    for (const e of entries) deliver(e);
  }

  // Health: the hash chain from the log.idx checkpoint (one line per break), and the orch's watchdog.
  let breakKey = null, rowsSent;
  function sendRows() {
    let text = null;
    try { text = [remindersText(me, rm, deps), missingRowsText(me, sid, { now: clock.now(), rows, identity: deps.identity })].filter(Boolean).join('\n\n') || null; } catch (e) { log('rows', e); return; }
    if (text === rowsSent) return;
    rowsSent = text;
    emit([{ type: 'rows', text }]);
  }
  function health() {
    try { deps.heartbeat(me); } catch (e) { log('seat heartbeat', e); } // the seat's lease (identity.heartbeat)
    sendRows();
    const r = rm.verifyChain();
    if (r.ok) breakKey = null;
    else {
      const key = `${r.offset}|${r.badAt}|${r.line}`;
      if (key !== breakKey) {
        breakKey = key;
        const where = r.badAt != null ? `#${r.badAt}` : `line ${r.line} (not valid JSON)`;
        const msg = `room log check: the hash chain breaks at ${where}; that entry and the ones after it may have been changed outside the plugin`;
        emit([{ type: 'health', text: msg }]);
      }
    }
    if (me.role === 'orch') deps.orch().watchdog(s.code);
  }

  // Every loop is a self-rescheduling timer that survives its own errors, backing off while they repeat.
  function guard(where, fn) { return () => { if (s.dead) return; try { fn(); } catch (e) { log(where, e); } }; }
  function loop(where, fn, everyMs) {
    let fails = 0, timer = null;
    const tick = () => {
      if (s.dead) return;
      let delay = everyMs;
      try { fn(); fails = 0; } catch (e) {
        fails++;
        delay = Math.max(everyMs, Math.min(t.backoffMs * 2 ** (fails - 1), t.backoffMaxMs));
        log(where, e);
      } finally {
        if (where === 'poll') s.lastTick = clock.now();
        if (!s.dead) timer = clock.setTimeout(tick, delay);
      }
    };
    return { start: now => { if (now) tick(); else timer = clock.setTimeout(tick, everyMs); }, stop: () => clock.clearTimeout(timer) };
  }
  const pollLoop = loop('poll', poll, t.pollMs);
  const healthLoop = loop('health check', health, t.healthMs);
  pollLoop.start(true);
  healthLoop.start(false);
  sendRows();

  s.stalled = () => clock.now() - s.lastTick > t.stallMs;
  s.killPoll = () => pollLoop.stop(); // tests: simulate a poll loop that died
  s.stop = () => {
    pollLoop.stop();
    healthLoop.stop();
    batch.stop();
    for (const h of held.values()) clock.clearTimeout(h.timer);
  };
  return s;
}

// ---------- the loop ----------
function runTail({
  clock = realClock, write, err = s => process.stderr.write(s), lookup, timings: tm = timings(), fs = nodeFs,
  deps = {}, maxSeconds = null, sid = null,
} = {}) {
  const LIB = __dirname;
  const d = {
    openRoom: deps.openRoom || (() => { const r = require(path.join(LIB, 'room.js')); return code => r.open(code); })(),
    heartbeat: deps.heartbeat || (me => require(path.join(LIB, 'identity.js')).heartbeat(me)),
    rows: deps.rows || require(path.join(LIB, 'rows.js')),
    notices: deps.notices || require(path.join(LIB, 'notices.js')),
    orch: deps.orch ? () => deps.orch : (() => { let o; return () => o || (o = require(path.join(LIB, 'orch.js'))); })(),
    identity: deps.identity || require(path.join(LIB, 'identity.js')),
    proposal: deps.proposal || require(path.join(LIB, 'proposal.js')),
  };
  const log = errorLog(err, clock, tm.errorLogMs);
  const ctx = { clock, fs, write, log, t: tm, deps: d, sid };
  // say which seat is followed, when that changes
  let seatSent;
  const sendSeat = me => {
    const seat = me ? { name: me.name, code: me.code, role: me.role === 'orch' ? 'orch' : 'member', addr: `${me.name}.${me.code}` } : null;
    const key = JSON.stringify(seat);
    if (key === seatSent) return;
    seatSent = key;
    try { write(JSON.stringify({ type: 'seat', seat }) + '\n', () => {}); } catch (e) { log('seat event', e); }
  };
  let sess = null, timer = null, stopped = false;

  function stopSess() {
    if (!sess) return;
    const s = sess;
    sess = null;
    try { s.stop(); s.save(); } catch (e) { log('session stop', e); }
    s.dead = true;
  }

  function check() {
    if (stopped) return;
    let me = null, failed = false;
    try { me = lookup(); } catch (e) { failed = true; log('seat lookup', e); } // transient: keep the current state
    if (!failed) {
      const key = me ? `${me.code}/${me.name}/${me.role}` : null;
      if (sess && sess.key === key && sess.stalled()) { log('poll loop', new Error('stalled')); stopSess(); }
      if (!(sess && sess.key === key)) {
        stopSess();
        if (me) { try { sess = startSession(me, ctx); } catch (e) { log('session start', e); } }
        sendSeat(sess ? me : null);
      }
    }
    if (!stopped) timer = clock.setTimeout(check, sess || me ? tm.resolveMs : tm.unseatedMs);
  }

  const stop = () => { stopped = true; clock.clearTimeout(timer); stopSess(); };
  check();
  if (maxSeconds != null) clock.setTimeout(stop, maxSeconds * 1000);
  return { stop, session: () => sess };
}

module.exports = {
  runTail, timings, Batcher, formatNdBatch, PULL_HEAD,
};
