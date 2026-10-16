/**
 * plugin/sub-human/mcp/hold.ts: the `hold` tool, a room-server plug-in (create(ctx) -> {tools, call}): a
 * HoldServer (one per room server, i.e. per claude session) behind the plug-in contract.
 * It keeps participant rows open in the agent panel at zero tokens (nested under the room row).
 *
 *   hold({member: NAME})   called once by a sub-human:participant row agent. Blocks for as long as this seat is in
 *       the room, streaming notifications/progress (the latest entry of NAME's thread, re-sent every BEAT_MS so
 *       the MCP idle timeout never fires: cc CONTRACT mcp-progress-resets-idle-timeout). NAME leaving does NOT end
 *       it: the row reads "left" (lib/rows.ts rowText) and is live again on rejoin, so leave/rejoin never makes a second row. Returns "STOP: ..." when
 *       this seat leaves, when NAME is this seat or was never in the room, or when another row for NAME is
 *       already held here ("STOP: duplicate row": the newcomer ends, the first row stays).
 *   hold({room: CODE})     called by the member's sub-human:room row agent. Blocks; returns
 *       "JOINED a b"   other members (not the room's Claude, not me) with no live hold here: someone joined, or the
 *                      room never spawned their row. A name is announced only after GRACE_MS without a hold
 *                      (so children spawned in the same message as this call are not double-announced), at
 *                      most ANNOUNCE_MAX times per name until its hold shows up.
 *       "RESPAWN a"    a's hold here was cancelled (Esc twice on the row) while a is still in the room.
 *                      Checked after RESPAWN_MS; dropped when the room hold itself was cancelled too
 *                      (killing the room cascades to its children).
 *       Both can come back together, one line each. "STOP: ..." when this seat left the room (not when the host
 *       removed this machine, a kick: the rows stay and show it, so no row hands a turn back to the kicked person), or
 *       "STOP: duplicate row" at once when another room row already holds here (e.g. re-spawned after /clear).
 * One server serves the whole claude session, main thread and every subagent (cc CONTRACT
 * mcp-server-shared-by-subagents), so it sees every row's hold. Liveness goes to the seat's session document's holds
 * (lib/rows.ts writeHolds) for row-guard, join notes and rewake; the seat's lease is renewed every BEAT_MS / 2. A room hold
 * that returned JOINED/RESPAWN still counts as running for ROOM_GAP_MS while its agent re-calls, so a join notice
 * read in that gap never invites a second room row.
 *
 * Env (ms): SUB_HUMAN_HOLD_BEAT_MS 20000, SUB_HUMAN_HOLD_POLL_MS 1000, SUB_HUMAN_HOLD_GRACE_MS 20000,
 *   SUB_HUMAN_HOLD_RESPAWN_MS 1500, SUB_HUMAN_HOLD_WHO_MS 3000 (how often `me` is re-resolved),
 *   SUB_HUMAN_HOLD_ROOM_GAP_MS 30000.
 */

import * as rows from '../lib/rows.ts';
import { joinLeave, noticeText } from '../lib/room/render.ts';
import * as room from '../lib/room.ts';
import * as strs from '../lib/text.ts';
import * as config from '../lib/config.ts';
import { envMs } from '../lib/env.ts';
import * as linkState from '../lib/room/link-state.ts';
import type { CallMeta, JsonRpcId, Me, PluginApi, PluginContext, ProgressToken, ToolArgs, ToolDefinition, ToolResult } from './types.ts';
import type { Entry, Members } from '../lib/room/types.ts';
import { msgOf } from '../lib/errors.ts';
import type { RoomCode, SeatName } from '../lib/brand.ts';

/** This machine's link to room code was ended by the host (a kick: its link-state stopped with a revocation). */
const removedByHost = (code: RoomCode): boolean => {
  try { const st = linkState.read(code); return linkState.stoppedForGood(st) && /^(?:LINK_REVOKED|KEY_REVOKED|TOKEN_UNKNOWN)$/.test(String(st && st.lastReason)); } catch { return false; }
};

/** What the hold server needs of the room-server ctx (the tests pass a fake one). */
type HoldContext = Pick<PluginContext, 'whoami' | 'progress' | 'identity'> & Partial<Pick<PluginContext, 'text' | 'log' | 'onCancel'>>;

/** One blocked hold call: a participant row's (member NAME) or the room row's (name = the room code). */
interface HoldBase {
  id: JsonRpcId | undefined;
  token: ProgressToken | undefined;
  n: number;
  msg: string;
  sentAt: number;
  code: RoomCode;
  started: number;
  name: string;
  resolve?: (r: ToolResult) => void; // set as the call blocks, before it is in holds
}
type Hold = (HoldBase & { kind: 'member' }) | (HoldBase & { kind: 'room'; moves: Set<number> });
type RoomHold = Extract<Hold, { kind: 'room' }>;
/** The seat this server serves (for rows/holds-<me> and the lease). */
interface Seat { code: RoomCode; name: SeatName; pid?: number | null | undefined; savedAt?: number }

const { NAME_RE, oneLine } = strs;
const ANNOUNCE_MAX = 3;
const MSG_MAX = config.HOLD_MSG_MAX; // + HINT fits the two lines a row view shows at 120 columns (at 200 the hint was cut off)
const END = 'End now without calling any tool.';
// Shown on every progress line, right above the row view's input box: the row takes no input.
const HINT = ' · read-only · talk in main (@room)';

const clip = (s: string, n = MSG_MAX) => strs.clip(s, n);

/** An entry as its group-chat line, no id: "alice: say 1", "claude (to alice): which cursor?", "alice left". */
function entryLine(e: Entry): string {
  const lines = room.chatLines(e).filter((l: string) => !l.startsWith(room.FOR_CLAUDE));
  return clip(oneLine(lines.map((l: string) => (l.startsWith(room.CHAT_NEST) ? l.slice(room.CHAT_NEST.length) : l)).join(' ')));
}

const TOOL: ToolDefinition = {
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
  ctx: HoldContext;
  BEAT_MS: number; POLL_MS: number; GRACE_MS: number; RESPAWN_MS: number; WHO_MS: number; ROOM_GAP_MS: number;
  holds: Map<JsonRpcId | undefined, Hold>;
  expect: Map<string, { at: number; n: number }>;
  respawn: Map<string, Set<string>>;
  roomGone: Map<string, number>;
  roomEnded: Map<string, number>;
  logState: Map<string, { entries: readonly Readonly<Entry>[]; moves: Entry[] }>;
  me: Me | null; meAt: number; timer: NodeJS.Timeout | null; seat: Seat | null;

  constructor(ctx: HoldContext) {
    this.ctx = ctx;
    this.BEAT_MS = envMs('SUB_HUMAN_HOLD_BEAT_MS');
    this.POLL_MS = envMs('SUB_HUMAN_HOLD_POLL_MS');
    this.GRACE_MS = envMs('SUB_HUMAN_HOLD_GRACE_MS');
    this.RESPAWN_MS = envMs('SUB_HUMAN_HOLD_RESPAWN_MS');
    this.WHO_MS = envMs('SUB_HUMAN_HOLD_WHO_MS');
    this.ROOM_GAP_MS = envMs('SUB_HUMAN_HOLD_ROOM_GAP_MS');
    this.holds = new Map();     // request id -> hold
    this.expect = new Map();    // `${code}/${name}` -> {at, n}: announced or expected, no hold seen yet
    this.respawn = new Map();   // code -> Set(names) waiting for the next room hold
    this.roomGone = new Map();  // code -> time the room hold was cancelled
    this.roomEnded = new Map(); // code -> time a room hold last returned (it is re-calling)
    this.logState = new Map();  // code -> {entries, moves}: the log as last read, and its joins and leaves
    this.me = null; this.meAt = 0; this.timer = null; this.seat = null;
  }

  log(...a: unknown[]): void { try { this.ctx.log && this.ctx.log('hold', ...a); } catch { /* debug only */ } }
  text(s: string, isError = false): ToolResult { return this.ctx.text ? this.ctx.text(s, isError) : { content: [{ type: 'text', text: s }], ...(isError ? { isError: true as const } : {}) }; }
  memberHolds(code: RoomCode): Hold[] { return [...this.holds.values()].filter(h => h.kind === 'member' && h.code === code); }
  roomHolds(code: RoomCode): Hold[] { return [...this.holds.values()].filter(h => h.kind === 'room' && h.code === code); }
  members(code: RoomCode): Members { try { return this.ctx.identity.readMembers(code) || {}; } catch { return {}; } }
  present(ms: Members, name: string): boolean { const m = ms[name]; return !!(m && !m.left_at); }

  /**
   * The room's entries (the store's cached read: the same array while the log is unchanged), its joins and leaves,
   * and `fresh`: the entries that arrived since the last call (none on the first call for a room). Only the new part
   * of a grown log is looked at.
   */
  readEntries(code: RoomCode): { entries: readonly Readonly<Entry>[]; moves: Entry[]; fresh: Entry[] } {
    let entries: readonly Readonly<Entry>[] = [];
    try { entries = room.open(code).readAll(); } catch { /* no log yet */ }
    const st = this.logState.get(code);
    if (st && st.entries === entries) return { entries, moves: st.moves, fresh: [] };
    const last = st && st.entries.at(-1);
    const lastId = last ? last.id : 0;
    // grown: the new entries are those after the old last one; anything else (a reset log) is read again whole
    const grown = st && entries.length >= st.entries.length && (!last || entries[st.entries.length - 1] === last) ? st : null;
    const from = grown ? grown.entries.length : 0;
    const added = entries.slice(from).filter(e => e && Number.isInteger(e.id));
    const isMove = (e: Entry) => e.kind === 'member_joined' || e.kind === 'member_left';
    const moves = grown ? grown.moves.concat(added.filter(isMove)) : added.filter(isMove);
    const fresh = st ? added.filter(e => e.id > lastId) : [];
    this.logState.set(code, { entries, moves });
    return { entries, moves, fresh };
  }

  progress(h: Hold, msg?: string): void {
    if (msg) h.msg = msg;
    h.sentAt = Date.now();
    if (h.token == null) return;
    h.n++;
    try { this.ctx.progress(h.token, h.n, h.msg + HINT); } catch { /* client gone */ }
  }

  finish(h: Hold, s: string): void {
    if (!this.holds.has(h.id)) return;
    this.holds.delete(h.id);
    // A room hold returning JOINED/RESPAWN is re-called by its row agent at once: the row is still running.
    if (h.kind === 'room' && !/^STOP\b/.test(s)) this.roomEnded.set(h.code, Date.now());
    else if (h.kind === 'room') this.roomEnded.delete(h.code);
    this.log('RETURN', h.id, s);
    // oxlint-disable-next-line typescript/no-non-null-assertion -- a hold is in holds only once hold() set its resolve (checked above)
    h.resolve!(this.text(s));
    this.saveSeat();
    if (!this.holds.size) this.stopTimer();
  }

  saveSeat(): void {
    const seat = this.seat;
    if (!seat) return;
    // a room this machine no longer has (`link --forget`): write nothing there, ever again (item 9 R1)
    if (typeof this.ctx.identity.roomExists === 'function' && !this.ctx.identity.roomExists(seat.code)) { this.seat = null; return; }
    const ended = this.roomEnded.get(seat.code);
    rows.writeHolds(seat.code, seat.name, {
      members: this.memberHolds(seat.code).map(h => h.name),
      room: this.roomHolds(seat.code).length > 0,
      roomUntil: ended ? ended + this.ROOM_GAP_MS : 0,
    });
  }

  others(_code: string, ms: Members): string[] {
    const me = this.me;
    return Object.values(ms)
      .filter((m): m is NonNullable<typeof m> & { name: string } => !!(m && m.name) && !m.left_at && m.role !== 'claude' && m.name !== 'claude' && (!me || m.name !== me.name))
      .map(m => m.name);
  }

  /** Names the room should spawn now (JOINED). Marks them announced. */
  missing(code: RoomCode, ms: Members, now: number): string[] {
    const live = new Set(this.memberHolds(code).map(h => h.name));
    const out: string[] = [];
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

  roomReply(code: RoomCode, joined: string[]): string {
    const lines: string[] = [];
    const rs = this.respawn.get(code);
    if (rs && rs.size) { lines.push(`RESPAWN ${[...rs].join(' ')}`); this.respawn.delete(code); }
    if (joined.length) lines.push(`JOINED ${joined.join(' ')}`);
    return lines.join('\n');
  }

  tick(): void {
    const now = Date.now();
    if (now - this.meAt >= this.WHO_MS) {
      this.meAt = now;
      let cur = null;
      try { cur = this.ctx.whoami(); } catch { cur = null; }
      const me = this.me;
      // removed by the host (a kick): the rows stay, showing it ("✕ removed by the host"), and end with the session;
      // ending them would hand "left" back to the main conversation, a model turn the kicked person never asked for
      if (me && !cur && removedByHost(me.code)) return;
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
          const mine = fresh.filter((e: Entry) => e.from === h.name || e.to === h.name).at(-1);
          if (mine) this.progress(h, entryLine(mine));
        } else {
          const reply = this.roomReply(code, this.missing(code, ms, now));
          if (reply) { this.finish(h, reply); continue; }
          const plain = fresh.filter((e: Entry) => e.kind !== 'member_joined' && e.kind !== 'member_left').at(-1);
          if (plain) this.progress(h, entryLine(plain));
          const move = this.newMove(h, code, now);
          if (move) this.progress(h, move);
        }
        // The beat keeps the call under the MCP tool idle timeout (cc CONTRACT mcp-progress-resets-idle-timeout).
        if (this.holds.has(h.id) && now - h.sentAt >= this.BEAT_MS) this.progress(h);
      }
    }
    const seat = this.seat;
    if (seat && now - (seat.savedAt || 0) >= this.BEAT_MS / 2) {
      seat.savedAt = now;
      this.saveSeat();
      try { this.ctx.identity.heartbeat && this.ctx.identity.heartbeat(this.me ?? seat, now); } catch (e) { this.log('heartbeat', msgOf(e)); }
    }
  }

  /** The newest join / settled leave this room hold has not shown yet, as a notice line (marks them shown). */
  newMove(h: RoomHold, code: RoomCode, now: number): string {
    const { moves } = this.readEntries(code); // joins and leaves only: not the whole log every tick
    const me = this.me;
    const fresh = joinLeave(moves, me && me.name, { now }).filter(n => n.settled && !h.moves.has(n.id));
    for (const n of fresh) h.moves.add(n.id);
    const n = fresh.filter(x => now - Date.parse(x.at) < config.NOTICE_FRESH_MS).at(-1);
    return n ? clip(noticeText(n)) : '';
  }

  startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.tick(); } catch (e) { this.log('tick error', msgOf(e)); } }, this.POLL_MS);
    if (this.timer.unref) this.timer.unref();
  }
  stopTimer(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  onCancelled(h: Hold): void {
    if (!this.holds.has(h.id)) return;
    this.holds.delete(h.id);
    this.log('CANCELLED', h.id, h.kind, h.name || h.code);
    // oxlint-disable-next-line typescript/no-non-null-assertion -- a hold is in holds only once hold() set its resolve (checked above)
    h.resolve!(this.text(`(cancelled)`));
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

  respawnCheck(h: Hold): void {
    const code = h.code;
    const gone = this.roomGone.get(code);
    if (gone && Date.now() - gone < this.RESPAWN_MS * 4) return;
    if (!this.present(this.members(code), h.name)) return;
    if (this.me && (this.me.code !== code)) return;
    if (this.memberHolds(code).some(x => x.name === h.name)) return;
    const live = this.roomHolds(code);
    const ended = this.roomEnded.get(code);
    if (!live.length && !(ended && Date.now() - ended < config.HOLD_RESPAWN_AFTER_RETURN_MS)) return; // room Claude side: nobody respawns
    let rs = this.respawn.get(code);
    if (!rs) this.respawn.set(code, rs = new Set());
    rs.add(h.name);
    this.expect.set(`${code}/${h.name}`, { at: Date.now(), n: 0 });
    for (const r of live) this.finish(r, this.roomReply(code, []));
    if (!this.holds.size) this.stopTimer();
  }

  /** The latest entry `pick` accepts, for a new hold's first line. */
  lastShown(code: RoomCode, pick: (e: Entry) => boolean): Entry | undefined {
    return this.readEntries(code).entries.findLast(pick);
  }

  call(name: string, who0: Me | null, args: ToolArgs = {}, meta: CallMeta = {}): ToolResult | Promise<ToolResult> | null {
    if (name !== 'hold') return null;
    let cur = who0;
    if (!cur) { try { cur = this.ctx.whoami(); } catch { cur = null; } }
    const early = (s: string) => { this.log('RETURN now', meta.id, args.member || args.room || '', s); return this.text(s); };
    if (!cur) return early(`STOP: not in a room. ${END}`);
    this.me = cur; this.meAt = Date.now();
    this.seat = this.seat && this.seat.code === cur.code && this.seat.name === cur.name ? this.seat : { code: cur.code, name: cur.name, pid: cur.pid };
    const code = cur.code;
    const member = typeof args.member === 'string' ? args.member.trim().replace(/^@/, '') : '';
    const roomCode = typeof args.room === 'string' ? args.room.trim() : '';
    const base = { id: meta.id, token: meta.progressToken, n: 0, msg: '', sentAt: 0, code, started: Date.now() };
    let h: Hold;

    if (member) {
      if (!NAME_RE.test(member)) return early(`STOP: "${member}" is not a member name. ${END}`);
      if (member === cur.name) return early(`STOP: that is you; rows are for the others. ${END}`);
      const ms = this.members(code);
      // A member who left is still a row (it reads "left"); only a name never in the room is refused.
      if (!ms[member]) return early(`STOP: ${member} is not in room ${code}. ${END}`);
      if (this.memberHolds(code).some(x => x.name === member)) return early(`STOP: duplicate row: ${member}'s row is already open. ${END}`);
      h = { ...base, kind: 'member', name: member };
      this.expect.delete(`${code}/${member}`);
      const last = this.lastShown(code, (e: Entry) => e.from === member || e.to === member);
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
      const rh: RoomHold = { ...base, kind: 'room', name: code, moves: new Set() };
      h = rh;
      const last = this.lastShown(code, (e: Entry) => e.kind !== 'member_joined' && e.kind !== 'member_left');
      // a re-called room hold (after JOINED) still shows the join that brought it back, if it is recent
      const move = this.newMove(rh, code, now);
      h.msg = move || (last ? entryLine(last) : `room ${code}`);
    } else {
      return this.text('hold needs {member: NAME} (participant row) or {room: CODE} (room row).', true);
    }

    const held = h;
    return new Promise<ToolResult>(resolve => {
      held.resolve = resolve;
      this.holds.set(held.id, held);
      this.log('HOLD', held.id, held.kind, held.name);
      if (this.ctx.onCancel && held.id != null) this.ctx.onCancel(held.id, () => this.onCancelled(held));
      this.progress(held);
      this.saveSeat();
      this.startTimer();
    });
  }
}

/** The room-server plug-in: one HoldServer behind {tools, call}. */
function create(ctx: HoldContext): PluginApi & { server: HoldServer; _state: Pick<HoldServer, 'holds' | 'expect' | 'respawn'> } {
  const s = new HoldServer(ctx);
  // anonymous: room-server calls hold with me = null instead of erroring, so a row outside a room gets STOP.
  return {
    tools: [TOOL], call: (...a: Parameters<HoldServer['call']>) => s.call(...a), anonymous: ['hold'], server: s,
    _state: { holds: s.holds, expect: s.expect, respawn: s.respawn },
  };
}

export { create, TOOL, HINT };
