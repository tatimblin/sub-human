'use strict';
/**
 * plugin/sub-human/mcp/hold.js: the `hold` tool, a room-server plug-in (create(ctx) -> {tools, call}): a
 * HoldServer (one per room server, i.e. per claude session) behind the plug-in contract.
 * It keeps participant rows open in the agent panel at zero tokens (nested under the room row).
 *
 *   hold({member: NAME})   called once by a sub-human:participant row agent. Blocks for as long as this seat is in
 *       the room, streaming notifications/progress (the latest entry of NAME's thread, re-sent every BEAT_MS so
 *       the MCP idle timeout never fires). NAME leaving does NOT end it: the row reads "left" (lib/rows.js
 *       rowText) and is live again on rejoin, so leave/rejoin never makes a second row. Returns "STOP: ..." when
 *       this seat leaves, when NAME is this seat or was never in the room, or when another row for NAME is
 *       already held here ("STOP: duplicate row": the newcomer ends, the first row stays).
 *   hold({room: CODE})     called by the member's sub-human:room row agent. Blocks; returns
 *       "JOINED a b"   other members (not the orch, not me) with no live hold here: someone joined, or the
 *                      room never spawned their row. A name is announced only after GRACE_MS without a hold
 *                      (so children spawned in the same message as this call are not double-announced), at
 *                      most ANNOUNCE_MAX times per name until its hold shows up.
 *       "RESPAWN a"    a's hold here was cancelled (Esc twice on the row) while a is still in the room.
 *                      Checked after RESPAWN_MS; dropped when the room hold itself was cancelled too
 *                      (killing the room cascades to its children).
 *       Both can come back together, one line each. "STOP: ..." when this seat left the room, or
 *       "STOP: duplicate row" at once when another room row already holds here (e.g. re-spawned after /clear).
 * One server serves the whole claude session (main + every subagent), so it sees every row's hold.
 * The room hold's progress line shows joins and leaves as chat lines ("bob joined", "bob left" once the leave has
 * settled 8 s; a quick leave + rejoin shows nothing; lib/notices.js), and entries as room.chatLines (no ids).
 * Every progress line ends with HINT ("read-only · talk in main (@room)"): text typed into a row view is not
 * posted (Claude Code queues it for the row agent), so the line says where to talk instead.
 * Entries come from the seat's Room (lib/room.js open(code): the store's cached read, re-parsing only appended
 * bytes).
 * Liveness goes to the room document rows/holds-<me> (lib/rows.js) for row-guard, join notes and rewake, and
 * every BEAT_MS / 2 the seat's lease is renewed (identity.heartbeat). A room hold
 * that returned JOINED/RESPAWN still counts as running for ROOM_GAP_MS (roomUntil) while its agent re-calls,
 * so a join notice read in that gap never invites a second room row (row-guard would deny it in red).
 *
 * Env (ms): SUB_HUMAN_HOLD_BEAT_MS 20000, SUB_HUMAN_HOLD_POLL_MS 1000, SUB_HUMAN_HOLD_GRACE_MS 20000,
 *   SUB_HUMAN_HOLD_RESPAWN_MS 1500, SUB_HUMAN_HOLD_WHO_MS 3000 (how often `me` is re-resolved),
 *   SUB_HUMAN_HOLD_ROOM_GAP_MS 30000.
 */

const path = require('node:path');
const rows = require(path.join(__dirname, '..', 'lib', 'rows.js'));
const notices = require(path.join(__dirname, '..', 'lib', 'notices.js'));
const room = require(path.join(__dirname, '..', 'lib', 'room.js'));
const strs = require(path.join(__dirname, '..', 'lib', 'text.js'));
const config = require(path.join(__dirname, '..', 'lib', 'config.js'));

const { envMs } = config;
const { NAME_RE, oneLine } = strs;
const ANNOUNCE_MAX = 3;
const MSG_MAX = config.HOLD_MSG_MAX; // + HINT fits the two lines a row view shows at 120 columns (at 200 the hint was cut off)
const END = 'End now without calling any tool.';
// Shown on every progress line, right above the row view's input box: the row takes no input.
const HINT = ' · read-only · talk in main (@room)';

const clip = (s, n = MSG_MAX) => strs.clip(s, n);

/** An entry as its group-chat line, no id: "alice: say 1", "orch (to alice): which cursor?", "alice left". */
function entryLine(e) {
  return clip(oneLine(room.chatLines(e).filter(l => !l.startsWith(room.FOR_CLAUDE)).map(l => (l.startsWith(room.CHAT_NEST) ? l.slice(room.CHAT_NEST.length) : l)).join(' ')));
}

const TOOL = {
  name: 'hold',
  title: 'sub-human row hold',
  description: 'Internal to sub-human row agents (sub-human:participant with member, sub-human:room with room). '
    + 'Keeps a status row open in the agent panel: it blocks for as long as the room lasts and returns only STOP, JOINED or RESPAWN lines. '
    + 'Never call it from a main session or any other agent; it is refused there.',
  inputSchema: {
    type: 'object',
    properties: {
      member: { type: 'string', description: 'Participant rows: the member NAME from the row prompt "member: NAME".' },
      room: { type: 'string', description: 'Room rows: the room CODE from the row prompt "room: CODE".' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

class HoldServer {
  constructor(ctx) {
    this.ctx = ctx;
    this.BEAT_MS = envMs('SUB_HUMAN_HOLD_BEAT_MS', config.HOLD_BEAT_MS);
    this.POLL_MS = envMs('SUB_HUMAN_HOLD_POLL_MS', config.HOLD_POLL_MS);
    this.GRACE_MS = envMs('SUB_HUMAN_HOLD_GRACE_MS', config.HOLD_GRACE_MS);
    this.RESPAWN_MS = envMs('SUB_HUMAN_HOLD_RESPAWN_MS', config.HOLD_RESPAWN_MS);
    this.WHO_MS = envMs('SUB_HUMAN_HOLD_WHO_MS', config.HOLD_WHO_MS);
    this.ROOM_GAP_MS = envMs('SUB_HUMAN_HOLD_ROOM_GAP_MS', config.HOLD_ROOM_GAP_MS);
    this.holds = new Map();     // request id -> hold
    this.expect = new Map();    // `${code}/${name}` -> {at, n}: announced or expected, no hold seen yet
    this.respawn = new Map();   // code -> Set(names) waiting for the next room hold
    this.roomGone = new Map();  // code -> time the room hold was cancelled
    this.roomEnded = new Map(); // code -> time a room hold last returned (it is re-calling)
    this.logState = new Map();  // code -> {lastId, count, entries}
    this.me = null; this.meAt = 0; this.timer = null; this.seat = null;
  }

  log(...a) { try { this.ctx.log && this.ctx.log('hold', ...a); } catch { /* debug only */ } }
  text(s) { return this.ctx.text ? this.ctx.text(s) : { content: [{ type: 'text', text: s }] }; }
  memberHolds(code) { return [...this.holds.values()].filter(h => h.kind === 'member' && h.code === code); }
  roomHolds(code) { return [...this.holds.values()].filter(h => h.kind === 'room' && h.code === code); }
  members(code) { try { return this.ctx.identity.readMembers(code) || {}; } catch { return {}; } }
  present(ms, name) { return !!(ms[name] && !ms[name].left_at); }

  /** The room's entries, and `fresh`: the ones that arrived since the last call (none on the first call for a room). */
  readEntries(code) {
    let entries = [];
    try { entries = room.open(code).readAll().filter(e => e && Number.isInteger(e.id)); } catch { /* no log yet */ }
    const last = entries.length ? entries.at(-1).id : 0;
    const st = this.logState.get(code);
    if (st && st.lastId === last && st.count === entries.length) return { entries: st.entries, fresh: [] };
    const fresh = st ? entries.filter(e => e.id > st.lastId) : [];
    this.logState.set(code, { lastId: last, count: entries.length, entries });
    return { entries, fresh };
  }

  progress(h, msg) {
    if (msg) h.msg = msg;
    h.sentAt = Date.now();
    if (h.token == null) return;
    h.n++;
    try { this.ctx.progress(h.token, h.n, h.msg + HINT); } catch { /* client gone */ }
  }

  finish(h, s) {
    if (!this.holds.has(h.id)) return;
    this.holds.delete(h.id);
    // A room hold returning JOINED/RESPAWN is re-called by its row agent at once: the row is still running.
    if (h.kind === 'room' && !/^STOP\b/.test(s)) this.roomEnded.set(h.code, Date.now());
    else if (h.kind === 'room') this.roomEnded.delete(h.code);
    this.log('RETURN', h.id, s);
    h.resolve(this.text(s));
    this.saveSeat();
    if (!this.holds.size) this.stopTimer();
  }

  saveSeat() {
    const seat = this.seat;
    if (!seat) return;
    const ended = this.roomEnded.get(seat.code);
    rows.writeHolds(seat.code, seat.name, {
      members: this.memberHolds(seat.code).map(h => h.name),
      room: this.roomHolds(seat.code).length > 0,
      roomUntil: ended ? ended + this.ROOM_GAP_MS : 0,
    });
  }

  others(code, ms) {
    const me = this.me;
    return Object.values(ms).filter(m => m && m.name && !m.left_at && m.role !== 'orch' && m.name !== 'orch' && (!me || m.name !== me.name)).map(m => m.name);
  }

  /** Names the room should spawn now (JOINED). Marks them announced. */
  missing(code, ms, now) {
    const live = new Set(this.memberHolds(code).map(h => h.name));
    const out = [];
    for (const n of this.others(code, ms)) {
      const k = `${code}/${n}`;
      if (live.has(n)) { this.expect.delete(k); continue; }
      const x = this.expect.get(k);
      if (x && (now - x.at < this.GRACE_MS || x.n >= ANNOUNCE_MAX)) continue;
      this.expect.set(k, { at: now, n: (x ? x.n : 0) + 1 });
      out.push(n);
    }
    return out;
  }

  roomReply(code, joined) {
    const lines = [];
    const rs = this.respawn.get(code);
    if (rs && rs.size) { lines.push(`RESPAWN ${[...rs].join(' ')}`); this.respawn.delete(code); }
    if (joined.length) lines.push(`JOINED ${joined.join(' ')}`);
    return lines.join('\n');
  }

  tick() {
    const now = Date.now();
    if (now - this.meAt >= this.WHO_MS) {
      this.meAt = now;
      let cur = null;
      try { cur = this.ctx.whoami(); } catch { cur = null; }
      const me = this.me;
      if (me && (!cur || cur.code !== me.code || cur.name !== me.name)) {
        for (const h of [...this.holds.values()]) this.finish(h, `STOP: ${me.name} is no longer in room ${h.code}. ${END}`);
        this.me = cur;
        return;
      }
      if (cur) this.me = cur;
    }
    const codes = new Set([...this.holds.values()].map(h => h.code));
    for (const code of codes) {
      const ms = this.members(code);
      const { fresh } = this.readEntries(code);
      for (const h of [...this.holds.values()].filter(x => x.code === code)) {
        if (h.kind === 'member') {
          // NAME leaving keeps the row (it reads "left"); only this seat leaving ends it (above).
          const mine = fresh.filter(e => e.from === h.name || e.to === h.name);
          if (mine.length) this.progress(h, entryLine(mine.at(-1)));
        } else {
          const reply = this.roomReply(code, this.missing(code, ms, now));
          if (reply) { this.finish(h, reply); continue; }
          const plain = fresh.filter(e => e.kind !== 'member_joined' && e.kind !== 'member_left');
          if (plain.length) this.progress(h, entryLine(plain.at(-1)));
          const move = this.newMove(h, code, now);
          if (move) this.progress(h, move);
        }
        if (this.holds.has(h.id) && now - h.sentAt >= this.BEAT_MS) this.progress(h);
      }
    }
    const seat = this.seat;
    if (seat && now - (seat.savedAt || 0) >= this.BEAT_MS / 2) {
      seat.savedAt = now;
      this.saveSeat();
      try { this.ctx.identity.heartbeat && this.ctx.identity.heartbeat(this.me || seat, now); } catch (e) { this.log('heartbeat', e.message); }
    }
  }

  /** The newest join / settled leave this room hold has not shown yet, as a notice line (marks them shown). */
  newMove(h, code, now) {
    const { entries } = this.readEntries(code);
    const me = this.me;
    const fresh = notices.joinLeave(entries, me && me.name, { now }).filter(n => n.settled && !h.moves.has(n.id));
    for (const n of fresh) h.moves.add(n.id);
    const n = fresh.filter(x => now - Date.parse(x.at) < config.NOTICE_FRESH_MS).at(-1);
    return n ? clip(notices.text(n)) : '';
  }

  startTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.tick(); } catch (e) { this.log('tick error', e.message); } }, this.POLL_MS);
    if (this.timer.unref) this.timer.unref();
  }
  stopTimer() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  onCancelled(h) {
    if (!this.holds.has(h.id)) return;
    this.holds.delete(h.id);
    this.log('CANCELLED', h.id, h.kind, h.name || h.code);
    h.resolve(this.text(`(cancelled)`));
    if (h.kind === 'room') this.roomEnded.delete(h.code);
    this.saveSeat();
    if (h.kind === 'room') { this.roomGone.set(h.code, Date.now()); this.respawn.delete(h.code); }
    else {
      // Hold off JOINED for this name until the respawn check below has decided.
      this.expect.set(`${h.code}/${h.name}`, { at: Date.now(), n: 0 });
      // Wait a moment: if the room hold is cancelled too (Esc on the room cascades), this is no respawn.
      setTimeout(() => this.respawnCheck(h), this.RESPAWN_MS).unref?.();
    }
    if (!this.holds.size) this.stopTimer();
  }

  respawnCheck(h) {
    const code = h.code;
    const gone = this.roomGone.get(code);
    if (gone && Date.now() - gone < this.RESPAWN_MS * 4) return;
    if (!this.present(this.members(code), h.name)) return;
    if (this.me && (this.me.code !== code)) return;
    if (this.memberHolds(code).some(x => x.name === h.name)) return;
    const live = this.roomHolds(code);
    const ended = this.roomEnded.get(code);
    if (!live.length && !(ended && Date.now() - ended < config.HOLD_RESPAWN_AFTER_RETURN_MS)) return; // orch side: nobody respawns
    if (!this.respawn.has(code)) this.respawn.set(code, new Set());
    this.respawn.get(code).add(h.name);
    this.expect.set(`${code}/${h.name}`, { at: Date.now(), n: 0 });
    for (const r of live) this.finish(r, this.roomReply(code, []));
    if (!this.holds.size) this.stopTimer();
  }

  /** The latest entry `pick` accepts, for a new hold's first line. */
  lastShown(code, pick) {
    return this.readEntries(code).entries.filter(pick).at(-1);
  }

  call(name, who0, args = {}, meta = {}) {
    if (name !== 'hold') return null;
    let cur = who0;
    if (!cur) { try { cur = this.ctx.whoami(); } catch { cur = null; } }
    const early = s => { this.log('RETURN now', meta.id, args.member || args.room || '', s); return this.text(s); };
    if (!cur) return early(`STOP: not in a room. ${END}`);
    this.me = cur; this.meAt = Date.now();
    this.seat = this.seat && this.seat.code === cur.code && this.seat.name === cur.name ? this.seat : { code: cur.code, name: cur.name, pid: cur.pid };
    const code = cur.code;
    const member = typeof args.member === 'string' ? args.member.trim().replace(/^@/, '') : '';
    const roomCode = typeof args.room === 'string' ? args.room.trim() : '';
    const h = { id: meta.id, token: meta.progressToken, n: 0, msg: '', sentAt: 0, code, started: Date.now() };

    if (member) {
      if (!NAME_RE.test(member)) return early(`STOP: "${member}" is not a member name. ${END}`);
      if (member === cur.name) return early(`STOP: that is you; rows are for the others. ${END}`);
      const ms = this.members(code);
      // A member who left is still a row (it reads "left"); only a name never in the room is refused.
      if (!ms[member]) return early(`STOP: ${member} is not in room ${code}. ${END}`);
      if (this.memberHolds(code).some(x => x.name === member)) return early(`STOP: duplicate row: ${member}'s row is already open. ${END}`);
      Object.assign(h, { kind: 'member', name: member });
      this.expect.delete(`${code}/${member}`);
      const last = this.lastShown(code, e => e.from === member || e.to === member);
      h.msg = last ? entryLine(last) : `${member} · in room ${code}`;
    } else if (roomCode) {
      if (roomCode !== code) return early(`STOP: you are in room ${code}, not ${roomCode}. ${END}`);
      if (this.roomHolds(code).length) return early(`STOP: duplicate row: room ${code} already has its row. ${END}`);
      const now = Date.now();
      const ms = this.members(code);
      // Children spawned in the same message as this call are on their way: expect them before announcing.
      const live = new Set(this.memberHolds(code).map(x => x.name));
      for (const n of this.others(code, ms)) if (!live.has(n) && !this.expect.has(`${code}/${n}`)) this.expect.set(`${code}/${n}`, { at: now, n: 0 });
      this.roomGone.delete(code);
      const reply = this.roomReply(code, this.missing(code, ms, now));
      if (reply) { this.log('RETURN now', meta.id, reply); this.roomEnded.set(code, now); this.saveSeat(); return this.text(reply); }
      Object.assign(h, { kind: 'room', name: code, moves: new Set() });
      const last = this.lastShown(code, e => e.kind !== 'member_joined' && e.kind !== 'member_left');
      // a re-called room hold (after JOINED) still shows the join that brought it back, if it is recent
      const move = this.newMove(h, code, now);
      h.msg = move || (last ? entryLine(last) : `room ${code}`);
    } else {
      return this.text('hold needs {member: NAME} (participant row) or {room: CODE} (room row).', true);
    }

    return new Promise(resolve => {
      h.resolve = resolve;
      this.holds.set(h.id, h);
      this.log('HOLD', h.id, h.kind, h.name);
      if (this.ctx.onCancel && h.id != null) this.ctx.onCancel(h.id, () => this.onCancelled(h));
      this.progress(h);
      this.saveSeat();
      this.startTimer();
    });
  }
}

/** The room-server plug-in: one HoldServer behind {tools, call}. */
function create(ctx) {
  const s = new HoldServer(ctx);
  // anonymous: room-server calls hold with me = null instead of erroring, so a row outside a room gets STOP.
  return { tools: [TOOL], call: (...a) => s.call(...a), anonymous: ['hold'], server: s, _state: { holds: s.holds, expect: s.expect, respawn: s.respawn } };
}

module.exports = { create, HoldServer, TOOL, entryLine, HINT };
