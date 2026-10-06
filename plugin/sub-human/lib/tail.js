'use strict';
/**
 * plugin/sub-human/lib/tail.js: the room monitor behind `sub-human tail` (bin/sub-human documents what it
 * prints). Everything that waits goes through an injected clock (lib/clock.js), so tests drive it with
 * clock.createFake() in-process.
 *
 *   runTail({clock, write, err, lookup, timings, fs, deps, maxSeconds}) -> {stop(), session()}
 *       The loop: look the seat up (every unseatedMs, then resolveMs once seated), follow that room's log
 *       from its cursor, batch the push lane and write each batch with write(text, done). It never stops on
 *       an error: every timer callback is guarded (log to err, rate-limited, back off, carry on); only
 *       stop() / maxSeconds end it. A seated session whose poll loop has not ticked for stallMs is restarted.
 *   timings(env?) -> the named waits, from lib/config.js and their SUB_HUMAN_* overrides
 *   Batcher({clock, settleMs, settleMaxMs, retryMs, onFlush, onError})
 *       enqueue(item) / arm() / flush() / stop(). Items wait in `pending` and go to onFlush(ready) as ONE
 *       batch after settleMs of quiet or settleMaxMs after the first one; an item younger than settleMs stays
 *       for the next batch. If onFlush throws, the batch goes back to pending and is retried after retryMs.
 *   formatOrchBatch(ready, ctx) -> lines     the orch's block: stateLine, then one full line per shown entry
 *   formatMemberBatch(ready, ctx) -> {lines, moved}   a member's group-chat lines, then "(for Claude)" lines
 *   startOffset(fs, file) -> byte offset of the last line boundary at or before the end of the file
 *
 * Reading: a session starts at the cursor tail-NAME without re-reading the log from byte 0. The backlog
 * (ids after the cursor) comes from room.readView({after}) (the log.idx checkpoint plus a search for the
 * cursor's line); live entries come from polling the bytes appended after the start offset. A batch is
 * judged against room.readView({after: first id - 1}), which gives lane() the same answer as readAll().
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const realClock = require('./clock.js');
const config = require('./config.js');

const { envMs } = config;
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
function formatOrchBatch(ready, { me, room, entries, show, joinNote, leaveMs }) {
  const out = [];
  for (const { e, away } of ready) {
    const note = joinNote(e);
    if (show(e, entries, note)) out.push(room.line(e, { full: true }) + (away ? ` · away ${Math.round(leaveMs / 1000)}s+` : '') + (note ? ` · ${note}` : ''));
  }
  return out.length ? [room.stateLine(me, entries), ...out] : [];
}

/** ctx: {me, room, entries, show, joinNote, seen}. moved: the join / leave ids shown (for notices.markShown). */
function formatMemberBatch(ready, { me, room, entries, show, joinNote, seen }) {
  const out = [], moved = [], forClaude = [];
  let state = false;
  for (const { e } of ready) {
    if (isMove(e) && seen.has(e.id)) continue; // at-room.js already showed it on a prompt
    if (!show(e, entries)) continue;
    out.push(...room.chatLines(e, { viewer: me.name }));
    if (isMove(e)) moved.push(e.id);
    if (STATE_KINDS.has(e.kind)) state = true;
    const note = e.kind === 'member_joined' ? joinNote(e) : '';
    if (SPAWN_NOTE.test(note)) forClaude.push(`${room.FOR_CLAUDE} ${note}`);
  }
  if (state) forClaude.unshift(`${room.FOR_CLAUDE} ${room.stateLine(me, entries)}`);
  return { lines: out.length ? [...out, ...forClaude] : [], moved: out.length ? moved : [] };
}

/**
 * The push lane (room.lane). A member also gets every other member's join and leave (a group chat line). The
 * orch gets another member's member_joined when lib/rows.js joinNote() says that row is not running (the note
 * carries the Agent call) or when the note is unavailable; a join whose row already runs is not pushed to it,
 * so a notice never invites a call that row-guard would deny.
 */
function visibleTo(me, room) {
  if (me.role !== 'orch') return (e, entries) => room.lane(me, e, entries) === 'push' || (isMove(e) && e.via === 'system' && e.from !== me.name && e.from !== 'orch');
  return (e, entries, note = '') => room.lane(me, e, entries) === 'push'
    || (e.kind === 'member_joined' && e.from !== me.name && (SPAWN_NOTE.test(note) || !note));
}

// ---------- reading ----------
/** The last line boundary at or before the end of the file (0 when there is no file). */
function startOffset(fs, file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { if (e.code === 'ENOENT') return 0; throw e; }
  try {
    const size = fs.fstatSync(fd).size;
    let end = size;
    while (end > 0) {
      const n = Math.min(4096, end);
      const b = Buffer.allocUnsafe(n);
      fs.readSync(fd, b, 0, n, end - n);
      const i = b.lastIndexOf(10);
      if (i >= 0) return end - n + i + 1;
      end -= n;
    }
    return 0;
  } finally { fs.closeSync(fd); }
}

const parseLine = buf => { try { return JSON.parse(buf.toString('utf8')); } catch { return null; } };

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
  const { clock, fs, write, log, t, deps } = ctx;
  const { room, rows, notices } = deps;
  room.bind(me.code);
  const file = room.logPath();
  const reader = `tail-${me.name}`;
  // Where polling starts: taken before the backlog read, so nothing appended in between is missed (the
  // overlap is dropped by id).
  let offset = startOffset(fs, file);
  const last = room.lastId();
  let after = room.getCursor(reader);
  if (!(after > 0 && after <= last)) {
    // First watch for this name: start at its join so nothing between join and resolve is lost.
    const joined = room.readView({ after: Infinity }).filter(e => e.kind === 'member_joined' && e.from === me.name).at(-1);
    after = joined ? joined.id : last;
  }
  room.setCursor(reader, after);
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
    try { room.bind(s.code); room.setCursor(reader, h); saved = h; } catch (e) { log('cursor save', e); }
  };
  const show = visibleTo(me, room);
  // member_joined: say whether that member's row already runs here, so only a missing one is spawned
  const joinNote = e => {
    if (e.kind !== 'member_joined') return '';
    try { return rows.joinNote(me, e.from); } catch { return ''; }
  };

  // Settle: candidates go out as ONE write (one notification, one turn). Each is judged again against the log
  // at flush time (lane with entries: retracted, signed, decided, superseded), and every pushed entry is at
  // least settleMs old, so a forged @room line is retracted (at-room's checker) before it could be pushed.
  function onFlush(ready) {
    room.bind(s.code);
    const entries = room.readView({ after: ready[0].e.id - 1 });
    const fctx = { me, room, entries, show, joinNote, leaveMs: t.leaveMs };
    let lines, moved = [];
    if (me.role === 'orch') lines = formatOrchBatch(ready, fctx);
    else ({ lines, moved } = formatMemberBatch(ready, { ...fctx, seen: notices.shown(s.code, me.name) }));
    const done = () => { for (const p of ready) inflight.delete(p.e.id); s.save(); };
    if (!lines.length) return done();
    if (moved.length) { try { notices.markShown(s.code, me.name, moved, 'monitor'); } catch { /* best effort */ } }
    write(lines.join('\n') + '\n', done);
  }
  const batch = new Batcher({ clock, settleMs, settleMaxMs, retryMs: t.backoffMs, onFlush, onError: e => log('flush', e) });

  const held = new Map(); // name -> {e, timer}: member_left waiting leaveMs for a rejoin
  const hold = e => ({ e, timer: clock.setTimeout(guard('leave hold', () => { held.delete(e.from); batch.enqueue({ e, away: true }); }), t.leaveMs) });
  function onEntry(e) {
    if (e.id <= processed) { saved = 0; room.bind(s.code); room.setCursor(reader, 0); } // the log was reset under us
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
    // A typed @room post is provisional until the forgery check has had its window; hold it that long
    // (judged at flush against the then-current view, so a retract that lands meanwhile wins).
    if (room.isYoungProvisional(e)) {
      const wait = Math.max(0, room.PROVISIONAL_MS() - (Date.now() - Date.parse(e.at)));
      clock.setTimeout(guard('provisional hold', () => batch.enqueue({ e, away: false })), wait);
      return;
    }
    batch.enqueue({ e, away: false });
  }
  const deliver = e => { if (s.dead || !(e.id > seen)) return; seen = e.id; onEntry(e); };

  // The backlog: ids after the cursor, from the checkpointed view (no read from byte 0).
  let backlog = after < last;
  function poll() {
    room.bind(s.code);
    if (backlog) {
      for (const e of room.readView({ after })) if (e.id > after) deliver(e);
      backlog = false;
    }
    let st;
    try { st = fs.statSync(file); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (st.size < offset) { offset = 0; seen = 0; } // truncated: read it again from the start
    if (st.size === offset) return;
    const fd = fs.openSync(file, 'r');
    let buf;
    try {
      buf = Buffer.allocUnsafe(st.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
    } finally { fs.closeSync(fd); }
    let pos = 0;
    for (let nl; (nl = buf.indexOf(10, pos)) >= 0; pos = nl + 1) {
      const e = nl > pos ? parseLine(buf.subarray(pos, nl)) : null;
      if (e) deliver(e);
      offset += nl + 1 - pos;
    }
  }

  // Health: the hash chain from the log.idx checkpoint (one line per break), and the orch's watchdog.
  let breakKey = null;
  function health() {
    room.bind(s.code);
    const r = room.verifyChain();
    if (r.ok) breakKey = null;
    else {
      const key = `${r.offset}|${r.badAt}|${r.line}`;
      if (key !== breakKey) {
        breakKey = key;
        const where = r.badAt != null ? `#${r.badAt}` : `line ${r.line} (not valid JSON)`;
        const msg = `room log check: the hash chain breaks at ${where}; that entry and the ones after it may have been changed outside the plugin`;
        write((me.role === 'orch' ? msg : `${room.FOR_CLAUDE} ${msg}`) + '\n', () => {});
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
  deps = {}, maxSeconds = null,
} = {}) {
  const LIB = __dirname;
  const d = {
    room: deps.room || require(path.join(LIB, 'room.js')),
    rows: deps.rows || require(path.join(LIB, 'rows.js')),
    notices: deps.notices || require(path.join(LIB, 'notices.js')),
    orch: deps.orch ? () => deps.orch : (() => { let o; return () => o || (o = require(path.join(LIB, 'orch.js'))); })(),
  };
  const log = errorLog(err, clock, tm.errorLogMs);
  const ctx = { clock, fs, write, log, t: tm, deps: d };
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
      }
    }
    if (!stopped) timer = clock.setTimeout(check, sess || me ? tm.resolveMs : tm.unseatedMs);
  }

  const stop = () => { stopped = true; clock.clearTimeout(timer); stopSess(); };
  check();
  if (maxSeconds != null) clock.setTimeout(stop, maxSeconds * 1000);
  return { stop, session: () => sess };
}

module.exports = { runTail, timings, Batcher, formatOrchBatch, formatMemberBatch, visibleTo, startOffset, SPAWN_NOTE, STATE_KINDS };
