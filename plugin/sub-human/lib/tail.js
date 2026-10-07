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
 *   formatNdBatch(ready, ctx) -> {events, moved}   the hooks module's events for one batch (--ndjson, below)
 *   pullText(lines) -> text | null           "Room since your last turn" over lines, the newest kept under PULL_CAP
 *   missingRowsText(me, sid, {now}?) -> text | null   the Agent calls for this seat's rows that run nowhere (moved
 *       here from hooks/at-room.js; at-room still calls it while the Monitor delivers)
 *   remindersText(me, rm) -> text | null     lib/proposal.js reminder() for each proposal awaiting me (members)
 *   leaseKey(name), leaseLive(kv, name, now) -> lease | null, LEASE_VIA    the delivery-NAME lease (below)
 *   deps (tests): openRoom(code) -> Room (lib/room.js open), heartbeat(me) (identity.heartbeat), rows, notices, orch
 *
 * Two writers (runTail({mode})):
 *   'text' (the Monitor, monitors.json): the lines above, one write per batch (one notification, one wake). It
 *       yields to a live delivery lease: while the hooks module delivers for this seat, a batch and a chain-check
 *       line are dropped unwritten (the cursor still advances), so the person never gets both.
 *   'ndjson' (`sub-human tail --ndjson`, the hooks module's child: mod/deliver.mjs, docs/next/MODS-PLAN.md Part
 *       2b): one JSON event per line, routed by the mod. It reads from its own cursor deliver-NAME (first run: from
 *       tail-NAME, else the join), sees the pull lane too, and holds the lease delivery-NAME (the room document
 *       {sid, pid, at, until}; taken at start, renewed on the health tick, until = now + leaseMs, released on stop).
 *       Events:
 *         {type:'seat', seat: {name, code, role, addr} | null}   the seat it follows (null: none any more)
 *         {type:'chat', lines}      a member's group chat: people's words, joins and leaves, a retract's notice
 *                                   (the person sees them; no wake)
 *         {type:'pull', text}       for Claude, no wake: the pull lane plus a copy of the chat lines, under the
 *                                   "Room since your last turn" head (PULL_CAP). Advances ctx-NAME too, so
 *                                   at-room's digest never repeats it. At most once (D8): the cursor moves once the
 *                                   line is written, whether or not the mod then appended it
 *         {type:'wake', text}       what needs Claude now: to me / @me, a proposal for me, a decision on mine, a
 *                                   task assigned to me, an objection to my proposal (members, with the room state
 *                                   line when the batch moved a proposal); the orch's whole push block
 *         {type:'rows', text|null}  what the person's next prompt carries for Claude: pending-proposal reminders
 *                                   (members) and the missing rows' Agent calls; sent at start and when it changes
 *                                   (health tick); null clears it
 *         {type:'health', text}     the hash-chain check's line (one per break)
 *
 * Reading: a session holds its Room (lib/room.js open(code)) and starts at the cursor tail-NAME without
 * re-reading the log from byte 0. The backlog (ids after the cursor) comes from room.readView({after}) (the
 * checkpoint plus a search for the cursor's line); live entries come from room.tailer() (what is appended after
 * the session started). The health tick also renews the seat's lease (identity.heartbeat). A batch is
 * judged against room.readView({after: first id - 1}), which gives lane() the same answer as readAll().
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
    leaseMs: envMs('SUB_HUMAN_DELIVERY_LEASE_MS', config.DELIVERY_LEASE_MS),
  };
}

// ---------- the delivery lease (room document delivery-NAME) ----------
const leaseKey = name => `delivery-${name}`;
const LEASE_VIA = 'mod';
/** The live lease on name's delivery, or null (none, expired, unreadable). */
function leaseLive(kv, name, now = Date.now()) {
  let v = null;
  try { v = kv.get(leaseKey(name), null); } catch { return null; }
  return v && typeof v === 'object' && v.via === LEASE_VIA && Number(v.until) > now ? v : null;
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

/** ctx: {me, room, entries, show, joinNote, seen}. moved: the join / leave ids shown (for notices.markShown). */
function formatMemberBatch(ready, { me, room: rm, entries, show, joinNote, seen }) {
  const out = [], moved = [], forClaude = [];
  let state = false;
  for (const { e } of ready) {
    if (isMove(e) && seen.has(e.id)) continue; // at-rm.js already showed it on a prompt
    if (!show(e, entries)) continue;
    out.push(...rm.chatLines(e, { viewer: me.name }));
    if (isMove(e)) moved.push(e.id);
    if (STATE_KINDS.has(e.kind)) state = true;
    const note = e.kind === 'member_joined' ? joinNote(e) : '';
    if (SPAWN_NOTE.test(note)) forClaude.push(`${rm.FOR_CLAUDE} ${note}`);
  }
  if (state) forClaude.unshift(`${rm.FOR_CLAUDE} ${rm.stateLine(me, entries)}`);
  return { lines: out.length ? [...out, ...forClaude] : [], moved: out.length ? moved : [] };
}

const esc = s => s.replace(/[.]/g, '\\.');
/** "@name" in text, as lib/room/lanes.js reads a mention. */
const mentions = (text, name) => new RegExp(`(^|[^A-Za-z0-9_.-])@${esc(name)}(?![A-Za-z0-9_-])`, 'i').test(String(text ?? ''));
/**
 * A member's push entry that is group chat, not a request (D3: the person sees it, Claude gets a copy, no wake):
 * a join or leave, a retract's notice, and another person's own words not addressed to me.
 */
function isChat(me, e) {
  if (isMove(e) || e.kind === 'retract') return true;
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
 * --ndjson: one batch as the hooks module's events, in the order the mod applies them (chat, pull, wake).
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
      if (isMove(e) && seen.has(e.id)) continue; // at-room already showed it on a prompt
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
  else if (state && wake.length) wake.push(`${FOR_CLAUDE} ${rm.stateLine(me, entries)}`);
  const events = [];
  if (chat.length) events.push({ type: 'chat', lines: chat });
  const pt = pullText(pull);
  if (pt) events.push({ type: 'pull', text: pt });
  if (wake.length) events.push({ type: 'wake', text: wake.join('\n') });
  return { events, moved };
}

const SPAWN_GRACE_MS = config.ROW_SPAWN_GRACE_MS;
/**
 * The Agent calls for this seat's rows with no live hold, or null when they all run (or were just spawned). Moved
 * from hooks/at-room.js (the one row-adjacent change, docs/next/MODS-PLAN.md Part 2b): the --ndjson tail sends it
 * as a `rows` event; at-room still calls it on a prompt while the Monitor delivers.
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
  const nd = ctx.mode === 'ndjson';
  const { rows, notices } = deps;
  const rm = deps.openRoom(me.code); // this session's room, held for its whole life (no re-binding)
  const reader = `${nd ? 'deliver' : 'tail'}-${me.name}`;
  const kv = () => rm.store.kv;
  const emit = (events, done = () => {}) => write(events.map(x => JSON.stringify(x)).join('\n') + '\n', done);
  // Where polling starts: taken before the backlog read, so nothing appended in between is missed (the
  // overlap is dropped by id).
  const tailer = rm.tailer({ fs });
  const last = rm.lastId();
  const valid = c => c > 0 && c <= last;
  let after = rm.getCursor(reader);
  // The mod's first run for this seat: from what the Monitor already delivered.
  if (nd && !valid(after)) after = rm.getCursor(`tail-${me.name}`);
  if (!valid(after)) {
    // First watch for this name: start at its join so nothing between join and resolve is lost.
    const joined = rm.readView({ after: Infinity }).filter(e => e.kind === 'member_joined' && e.from === me.name).at(-1);
    after = joined ? joined.id : last;
  }
  rm.setCursor(reader, after);
  // The delivery lease: the mod's child holds it; the Monitor's tail stays silent while it is live.
  const lease = () => kv().set(leaseKey(me.name), { via: LEASE_VIA, sid: sid || null, pid: process.pid, at: new Date(clock.now()).toISOString(), until: clock.now() + t.leaseMs }, { compact: true });
  const modDelivers = () => { if (nd) return false; try { return !!leaseLive(kv(), me.name, clock.now()); } catch { return false; } };
  if (nd) { try { lease(); } catch (e) { log('delivery lease', e); } }
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
    // --ndjson delivers the pull lane: at-room's digest (cursor ctx-NAME) must not repeat it
    if (nd) { try { if (rm.getCursor(`ctx-${me.name}`) < h) rm.setCursor(`ctx-${me.name}`, h); } catch (e) { log('ctx cursor', e); } }
  };
  const pushed = visibleTo(me, rm);
  const show = nd ? (e, entries, note) => pushed(e, entries, note) || rm.lane(me, e, entries) === 'pull' : pushed;
  // member_joined: say whether that member's row already runs here, so only a missing one is spawned
  const joinNote = e => {
    if (e.kind !== 'member_joined') return '';
    try { return rows.joinNote(me, e.from); } catch { return ''; }
  };

  // Settle: candidates go out as ONE write (one notification, one turn). Each is judged again against the log
  // at flush time (lane with entries: retracted, signed, decided, superseded), and every pushed entry is at
  // least settleMs old, so a forged @room line is retracted (at-room's checker) before it could be pushed.
  function onFlush(ready) {
    const entries = rm.readView({ after: ready[0].e.id - 1 });
    const fctx = { me, room: rm, entries, show: pushed, joinNote, leaveMs: t.leaveMs };
    const done = () => { for (const p of ready) inflight.delete(p.e.id); s.save(); };
    if (nd) {
      const { events, moved } = formatNdBatch(ready, { ...fctx, seen: me.role === 'orch' ? new Set() : notices.shown(s.code, me.name) });
      if (!events.length) return done();
      if (moved.length) { try { notices.markShown(s.code, me.name, moved, 'mod'); } catch { /* best effort */ } }
      return emit(events, done);
    }
    if (modDelivers()) return done(); // the hooks module delivers this seat's batches
    let lines, moved = [];
    if (me.role === 'orch') lines = formatOrchBatch(ready, fctx);
    else ({ lines, moved } = formatMemberBatch(ready, { ...fctx, seen: notices.shown(s.code, me.name) }));
    if (!lines.length) return done();
    if (moved.length) { try { notices.markShown(s.code, me.name, moved, 'monitor'); } catch { /* best effort */ } }
    write(lines.join('\n') + '\n', done);
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
    // A typed @room post is provisional until the forgery check has had its window; hold it that long
    // (judged at flush against the then-current view, so a retract that lands meanwhile wins).
    if (rm.isYoungProvisional(e)) {
      const wait = Math.max(0, rm.PROVISIONAL_MS() - (Date.now() - Date.parse(e.at)));
      clock.setTimeout(guard('provisional hold', () => batch.enqueue({ e, away: false })), wait);
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
    if (nd) { try { lease(); } catch (e) { log('delivery lease', e); } sendRows(); }
    const r = rm.verifyChain();
    if (r.ok) breakKey = null;
    else {
      const key = `${r.offset}|${r.badAt}|${r.line}`;
      if (key !== breakKey) {
        breakKey = key;
        const where = r.badAt != null ? `#${r.badAt}` : `line ${r.line} (not valid JSON)`;
        const msg = `room log check: the hash chain breaks at ${where}; that entry and the ones after it may have been changed outside the plugin`;
        if (nd) emit([{ type: 'health', text: msg }]);
        else if (!modDelivers()) write((me.role === 'orch' ? msg : `${rm.FOR_CLAUDE} ${msg}`) + '\n', () => {});
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
  if (nd) sendRows();

  s.stalled = () => clock.now() - s.lastTick > t.stallMs;
  s.killPoll = () => pollLoop.stop(); // tests: simulate a poll loop that died
  s.stop = () => {
    pollLoop.stop();
    healthLoop.stop();
    batch.stop();
    for (const h of held.values()) clock.clearTimeout(h.timer);
    // give the lease back (only ours: a newer child may hold it already)
    if (nd) { try { kv().update(leaseKey(me.name), cur => (cur && cur.pid === process.pid && cur.sid === (sid || null) ? null : undefined), { compact: true }); } catch (e) { log('delivery lease release', e); } }
  };
  return s;
}

// ---------- the loop ----------
function runTail({
  clock = realClock, write, err = s => process.stderr.write(s), lookup, timings: tm = timings(), fs = nodeFs,
  deps = {}, maxSeconds = null, mode = 'text', sid = null,
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
  const ctx = { clock, fs, write, log, t: { leaseMs: config.DELIVERY_LEASE_MS, ...tm }, deps: d, mode, sid };
  // --ndjson: say which seat is followed, when that changes
  let seatSent;
  const sendSeat = me => {
    if (mode !== 'ndjson') return;
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
  runTail, timings, Batcher, formatOrchBatch, formatMemberBatch, formatNdBatch, visibleTo, isChat, pullText, PULL_HEAD,
  missingRowsText, remindersText, leaseKey, leaseLive, LEASE_VIA, SPAWN_NOTE, STATE_KINDS,
};
