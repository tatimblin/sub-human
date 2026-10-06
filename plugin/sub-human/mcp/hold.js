'use strict';
/**
 * plugin/sub-human/mcp/hold.js: the `hold` tool, a room-server plug-in (create(ctx) -> {tools, call}).
 * It keeps participant rows open in the agent panel at zero tokens (E3 "A2", P0 nested rows).
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
 *       "RESPAWN a"    a's hold here was cancelled (Esc twice on the row; P0) while a is still in the room.
 *                      Checked after RESPAWN_DELAY_MS; dropped when the room hold itself was cancelled too
 *                      (killing the room cascades to its children).
 *       Both can come back together, one line each. "STOP: ..." when this seat left the room, or
 *       "STOP: duplicate row" at once when another room row already holds here (e.g. re-spawned after /clear).
 * One server serves the whole claude session (main + every subagent), so it sees every row's hold.
 * Every progress line ends with HINT ("read-only · talk in main (@room)"): text typed into a row view is not
 * posted (Claude Code queues it for the row agent), so the line says where to talk instead.
 * Liveness goes to <room>/rows/holds-<me>.json (lib/rows.js) for row-guard, join notes and rewake. A room hold
 * that returned JOINED/RESPAWN still counts as running for ROOM_GAP_MS (roomUntil) while its agent re-calls,
 * so a join notice read in that gap never invites a second room row (Phase 0: red row-guard error).
 *
 * Env (ms): SUB_HUMAN_HOLD_BEAT_MS 20000, SUB_HUMAN_HOLD_POLL_MS 1000, SUB_HUMAN_HOLD_GRACE_MS 20000,
 *   SUB_HUMAN_HOLD_RESPAWN_MS 1500, SUB_HUMAN_HOLD_WHO_MS 3000 (how often `me` is re-resolved),
 *   SUB_HUMAN_HOLD_ROOM_GAP_MS 30000.
 */

const fs = require('node:fs');
const path = require('node:path');
const rows = require(path.join(__dirname, '..', 'lib', 'rows.js'));

const envMs = (k, d) => (Number(process.env[k]) > 0 ? Number(process.env[k]) : d);
const NAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;
const ANNOUNCE_MAX = 3;
const MSG_MAX = 140; // + HINT fits the two lines a row view shows at 120 columns (at 200 the hint was cut off, run stoat-3644)
const END = 'End now without calling any tool.';
// Shown on every progress line, right above the row view's input box: the row takes no input (A-rows #1).
const HINT = ' · read-only · talk in main (@room)';

const oneLine = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const clip = (s, n = MSG_MAX) => { const a = Array.from(s); return a.length > n ? a.slice(0, n - 1).join('') + '…' : s; };

function who(e) {
  if (e.via === 'system') return e.from === 'orch' ? 'room' : e.from;
  if (e.via === 'agent') return e.from === 'orch' ? 'facilitator' : `${e.from}'s Claude`;
  return e.from;
}
function entryLine(e) {
  const to = e.to && e.to !== 'room' ? ` → ${e.to}` : '';
  return clip(`#${e.id} ${who(e)}${to} · ${e.kind}: ${oneLine(e.text)}`);
}

const TOOL = {
  name: 'hold',
  description: 'Row agents only (sub-human:participant, sub-human:room). Never call it yourself: it blocks while the room lasts.',
  inputSchema: { type: 'object', properties: { member: { type: 'string' }, room: { type: 'string' } } },
};

function create(ctx) {
  const BEAT_MS = envMs('SUB_HUMAN_HOLD_BEAT_MS', 20_000);
  const POLL_MS = envMs('SUB_HUMAN_HOLD_POLL_MS', 1000);
  const GRACE_MS = envMs('SUB_HUMAN_HOLD_GRACE_MS', 20_000);
  const RESPAWN_MS = envMs('SUB_HUMAN_HOLD_RESPAWN_MS', 1500);
  const WHO_MS = envMs('SUB_HUMAN_HOLD_WHO_MS', 3000);
  const ROOM_GAP_MS = envMs('SUB_HUMAN_HOLD_ROOM_GAP_MS', 30_000);
  const log = (...a) => { try { ctx.log && ctx.log('hold', ...a); } catch { /* debug only */ } };
  const text = s => (ctx.text ? ctx.text(s) : { content: [{ type: 'text', text: s }] });

  const holds = new Map();     // request id -> hold
  const expect = new Map();    // `${code}/${name}` -> {at, n}: announced or expected, no hold seen yet
  const respawn = new Map();   // code -> Set(names) waiting for the next room hold
  const roomGone = new Map();  // code -> time the room hold was cancelled
  const roomEnded = new Map(); // code -> time a room hold last returned (it is re-calling)
  const logState = new Map();  // code -> {size, lastId, entries}
  let me = null, meAt = 0, timer = null, seat = null;

  const memberHolds = code => [...holds.values()].filter(h => h.kind === 'member' && h.code === code);
  const roomHolds = code => [...holds.values()].filter(h => h.kind === 'room' && h.code === code);

  function readEntries(code) {
    const file = path.join(ctx.identity.roomDir(code), 'log.jsonl');
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* no log yet */ }
    const st = logState.get(code);
    if (st && st.size === size) return { entries: st.entries, fresh: [] };
    const entries = rows.readLog(code);
    const prev = st ? st.lastId : (entries.length ? entries.at(-1).id : 0);
    const fresh = st ? entries.filter(e => e.id > prev) : [];
    logState.set(code, { size, lastId: entries.length ? entries.at(-1).id : 0, entries });
    return { entries, fresh };
  }
  function members(code) {
    try { return ctx.identity.readMembers(code) || {}; } catch { return {}; }
  }
  const present = (ms, name) => !!(ms[name] && !ms[name].left_at);

  function progress(h, msg) {
    if (msg) h.msg = msg;
    h.sentAt = Date.now();
    if (h.token == null) return;
    h.n++;
    try { ctx.progress(h.token, h.n, h.msg + HINT); } catch { /* client gone */ }
  }

  function finish(h, s) {
    if (!holds.has(h.id)) return;
    holds.delete(h.id);
    // A room hold returning JOINED/RESPAWN is re-called by its row agent at once: the row is still running.
    if (h.kind === 'room' && !/^STOP\b/.test(s)) roomEnded.set(h.code, Date.now());
    else if (h.kind === 'room') roomEnded.delete(h.code);
    log('RETURN', h.id, s);
    h.resolve(text(s));
    saveSeat();
    if (!holds.size) stopTimer();
  }

  function saveSeat() {
    if (!seat) return;
    const ended = roomEnded.get(seat.code);
    rows.writeHolds(seat.code, seat.name, {
      members: memberHolds(seat.code).map(h => h.name),
      room: roomHolds(seat.code).length > 0,
      roomUntil: ended ? ended + ROOM_GAP_MS : 0,
    });
  }

  function others(code, ms) {
    return Object.values(ms).filter(m => m && m.name && !m.left_at && m.role !== 'orch' && m.name !== 'orch' && (!me || m.name !== me.name)).map(m => m.name);
  }

  /** Names the room should spawn now (JOINED). Marks them announced. */
  function missing(code, ms, now) {
    const live = new Set(memberHolds(code).map(h => h.name));
    const out = [];
    for (const n of others(code, ms)) {
      const k = `${code}/${n}`;
      if (live.has(n)) { expect.delete(k); continue; }
      const x = expect.get(k);
      if (x && (now - x.at < GRACE_MS || x.n >= ANNOUNCE_MAX)) continue;
      expect.set(k, { at: now, n: (x ? x.n : 0) + 1 });
      out.push(n);
    }
    return out;
  }

  function roomReply(code, joined) {
    const lines = [];
    const rs = respawn.get(code);
    if (rs && rs.size) { lines.push(`RESPAWN ${[...rs].join(' ')}`); respawn.delete(code); }
    if (joined.length) lines.push(`JOINED ${joined.join(' ')}`);
    return lines.join('\n');
  }

  function tick() {
    const now = Date.now();
    if (now - meAt >= WHO_MS) {
      meAt = now;
      let cur = null;
      try { cur = ctx.whoami(); } catch { cur = null; }
      if (me && (!cur || cur.code !== me.code || cur.name !== me.name)) {
        for (const h of [...holds.values()]) finish(h, `STOP: ${me.name} is no longer in room ${h.code}. ${END}`);
        me = cur;
        return;
      }
      if (cur) me = cur;
    }
    const codes = new Set([...holds.values()].map(h => h.code));
    for (const code of codes) {
      const ms = members(code);
      const { fresh } = readEntries(code);
      for (const h of [...holds.values()].filter(x => x.code === code)) {
        if (h.kind === 'member') {
          // NAME leaving keeps the row (it reads "left"); only this seat leaving ends it (above).
          const mine = fresh.filter(e => e.from === h.name || e.to === h.name);
          if (mine.length) progress(h, entryLine(mine.at(-1)));
        } else {
          const reply = roomReply(code, missing(code, ms, now));
          if (reply) { finish(h, reply); continue; }
          if (fresh.length) progress(h, entryLine(fresh.at(-1)));
        }
        if (holds.has(h.id) && now - h.sentAt >= BEAT_MS) progress(h);
      }
    }
    if (seat && now - (seat.savedAt || 0) >= BEAT_MS / 2) { seat.savedAt = now; saveSeat(); }
  }

  function startTimer() {
    if (timer) return;
    timer = setInterval(() => { try { tick(); } catch (e) { log('tick error', e.message); } }, POLL_MS);
    if (timer.unref) timer.unref();
  }
  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

  function onCancelled(h) {
    if (!holds.has(h.id)) return;
    holds.delete(h.id);
    log('CANCELLED', h.id, h.kind, h.name || h.code);
    h.resolve(text(`(cancelled)`));
    if (h.kind === 'room') roomEnded.delete(h.code);
    saveSeat();
    if (h.kind === 'room') { roomGone.set(h.code, Date.now()); respawn.delete(h.code); }
    else {
      // Hold off JOINED for this name until the respawn check below has decided.
      expect.set(`${h.code}/${h.name}`, { at: Date.now(), n: 0 });
      // Wait a moment: if the room hold is cancelled too (Esc on the room cascades), this is no respawn.
      setTimeout(() => {
        const code = h.code;
        const gone = roomGone.get(code);
        if (gone && Date.now() - gone < RESPAWN_MS * 4) return;
        if (!present(members(code), h.name)) return;
        if (me && (me.code !== code)) return;
        if (memberHolds(code).some(x => x.name === h.name)) return;
        const live = roomHolds(code);
        const ended = roomEnded.get(code);
        if (!live.length && !(ended && Date.now() - ended < 30_000)) return; // orch side: nobody respawns
        if (!respawn.has(code)) respawn.set(code, new Set());
        respawn.get(code).add(h.name);
        expect.set(`${code}/${h.name}`, { at: Date.now(), n: 0 });
        for (const r of live) finish(r, roomReply(code, []));
        if (!holds.size) stopTimer();
      }, RESPAWN_MS).unref?.();
    }
    if (!holds.size) stopTimer();
  }

  function call(name, who0, args = {}, meta = {}) {
    if (name !== 'hold') return null;
    let cur = who0;
    if (!cur) { try { cur = ctx.whoami(); } catch { cur = null; } }
    const early = s => { log('RETURN now', meta.id, args.member || args.room || '', s); return text(s); };
    if (!cur) return early(`STOP: not in a room. ${END}`);
    me = cur; meAt = Date.now();
    seat = seat && seat.code === cur.code && seat.name === cur.name ? seat : { code: cur.code, name: cur.name };
    const code = cur.code;
    const member = typeof args.member === 'string' ? args.member.trim().replace(/^@/, '') : '';
    const roomCode = typeof args.room === 'string' ? args.room.trim() : '';
    const h = { id: meta.id, token: meta.progressToken, n: 0, msg: '', sentAt: 0, code, started: Date.now() };

    if (member) {
      if (!NAME_RE.test(member)) return early(`STOP: "${member}" is not a member name. ${END}`);
      if (member === cur.name) return early(`STOP: that is you; rows are for the others. ${END}`);
      const ms = members(code);
      // A member who left is still a row (it reads "left"); only a name never in the room is refused.
      if (!ms[member]) return early(`STOP: ${member} is not in room ${code}. ${END}`);
      if (memberHolds(code).some(x => x.name === member)) return early(`STOP: duplicate row: ${member}'s row is already open. ${END}`);
      Object.assign(h, { kind: 'member', name: member });
      expect.delete(`${code}/${member}`);
      const last = readEntries(code).entries.filter(e => e.from === member || e.to === member).at(-1);
      h.msg = last ? entryLine(last) : `${member} · in room ${code}`;
    } else if (roomCode) {
      if (roomCode !== code) return early(`STOP: you are in room ${code}, not ${roomCode}. ${END}`);
      if (roomHolds(code).length) return early(`STOP: duplicate row: room ${code} already has its row. ${END}`);
      const now = Date.now();
      const ms = members(code);
      // Children spawned in the same message as this call are on their way: expect them before announcing.
      const live = new Set(memberHolds(code).map(x => x.name));
      for (const n of others(code, ms)) if (!live.has(n) && !expect.has(`${code}/${n}`)) expect.set(`${code}/${n}`, { at: now, n: 0 });
      roomGone.delete(code);
      const reply = roomReply(code, missing(code, ms, now));
      if (reply) { log('RETURN now', meta.id, reply); roomEnded.set(code, now); saveSeat(); return text(reply); }
      Object.assign(h, { kind: 'room', name: code });
      const last = readEntries(code).entries.at(-1);
      h.msg = last ? entryLine(last) : `room ${code}`;
    } else {
      return text('hold needs {member: NAME} (participant row) or {room: CODE} (room row).', true);
    }

    return new Promise(resolve => {
      h.resolve = resolve;
      holds.set(h.id, h);
      log('HOLD', h.id, h.kind, h.name);
      if (ctx.onCancel && h.id != null) ctx.onCancel(h.id, () => onCancelled(h));
      progress(h);
      saveSeat();
      startTimer();
    });
  }

  // anonymous: room-server calls hold with me = null instead of erroring, so a row outside a room gets STOP.
  return { tools: [TOOL], call, anonymous: ['hold'], _state: { holds, expect, respawn } };
}

module.exports = { create, TOOL, entryLine, HINT };
