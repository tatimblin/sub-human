/**
 * plugin/sub-human/mcp/hold.ts: the `hold` tool, a room-server plug-in (create(ctx) -> {tools, call}): a
 * HoldServer (one per room server, i.e. per claude session) behind the plug-in contract.
 * It keeps the room row open in the agent panel at zero tokens.
 *
 *   hold({room: CODE, take?})   the member's sub-human:room row (agents/room.md, spawned by the hooks module: mod/rows.ts),
 *       or, with take, the room row's keeper (agents/keeper.md, room-chat: mod/chat.ts), whose hold replaces an older
 *       keeper's of the room (that one returns STOP: a /clear's new row ends the old). Blocks while this seat is in the
 *       room, streaming LEAD (the read-only row's label leads with how to talk; a keeper's has none), then who else is here (lib/rows.ts hereLine: names and what
 *       their presence says, read again every WHO_MS) then the room's latest line (or a fresh join / leave) as
 *       notifications/progress, re-sent every BEAT_MS so the MCP idle timeout never fires (cc CONTRACT
 *       mcp-progress-resets-idle-timeout). "STOP: ..." when this seat left (not on a kick: the row stays and shows it,
 *       so no row hands a turn back to the kicked person) or another room row already holds here (the newcomer ends).
 * One server serves the whole claude session, main thread and every subagent (cc CONTRACT
 * mcp-server-shared-by-subagents), so it sees every room hold of the session. While a hold runs, the seat's lease is
 * renewed every BEAT_MS / 2. Timings and their env overrides: lib/config.ts HOLD_*.
 */

import { joinLeave, noticeText } from '../lib/room/render.ts';
import * as room from '../lib/room.ts';
import * as strs from '../lib/text.ts';
import * as config from '../lib/config.ts';
import { envMs } from '../lib/env.ts';
import * as linkState from '../lib/room/link-state.ts';
import { hereLine } from '../lib/rows.ts';
import type { CallMeta, JsonRpcId, Me, PluginApi, PluginContext, ProgressToken, ToolArgs, ToolDefinition, ToolResult } from './types.ts';
import type { Entry } from '../lib/room/types.ts';
import { msgOf } from '../lib/errors.ts';
import { REVOKED } from '../lib/reasons.ts';
import type { RoomCode, SeatName } from '../lib/brand.ts';

/** This machine's link to room code was ended by the host (a kick: its link-state stopped with a revocation). */
const removedByHost = (code: RoomCode): boolean => {
  try { const st = linkState.read(code); return linkState.stoppedForGood(st) && REVOKED.has(String(st && st.lastReason)); } catch { return false; }
};

/** What the hold server needs of the room-server ctx (the tests pass a fake one). */
type HoldContext = Pick<PluginContext, 'whoami' | 'progress' | 'identity'> & Partial<Pick<PluginContext, 'text' | 'log' | 'onCancel'>>;

/** One blocked room hold call. */
interface Hold {
  id: JsonRpcId | undefined;
  token: ProgressToken | undefined;
  n: number;
  msg: string;
  /** who else is here (hereLine), the line's lead; hereAt: when it was read */
  here: string;
  hereAt: number;
  sentAt: number;
  code: RoomCode;
  started: number;
  /** a keeper's hold: its line has no LEAD (its row takes typing) */
  take: boolean;
  /** the joins and leaves this hold has shown */
  moves: Set<number>;
  resolve: (r: ToolResult) => void; // the blocked call's: set as the call blocks, before it is in holds
}
/** The seat this server serves (for the lease). */
interface Seat { code: RoomCode; name: SeatName; pid?: number | null | undefined; savedAt?: number }

const { oneLine } = strs;
const MSG_MAX = config.HOLD_MSG_MAX; // + HINT fits the two lines a row view shows at 120 columns (at 200 the hint was cut off)
const END = 'End now without calling any tool.';
// Every progress line leads with it: the row (its label) takes no input.
const LEAD = 'type in main with @room';
const SEP = ' · ';

const clip = (s: string, n = MSG_MAX) => strs.clip(s, n);

/** An entry as its group-chat line, no id: "alice: say 1", "claude (to alice): which cursor?", "alice left". */
function entryLine(e: Entry): string {
  const lines = room.chatLines(e).filter((l: string) => !l.startsWith(room.FOR_CLAUDE));
  return clip(oneLine(lines.map((l: string) => (l.startsWith(room.CHAT_NEST) ? l.slice(room.CHAT_NEST.length) : l)).join(' ')));
}

const TOOL: ToolDefinition = {
  name: 'hold',
  title: 'sub-human row hold',
  description: 'Keep the room row open. Internal to sub-human\'s room row agent (sub-human:room, with room). '
    + 'Keeps a status row open in the agent panel: it blocks for as long as the room lasts and returns only STOP. '
    + 'Never call it from a main session or any other agent; it is refused there.',
  inputSchema: {
    type: 'object',
    properties: {
      room: { type: 'string', description: 'The room CODE from the row prompt "room: CODE".' },
      take: { type: 'boolean', description: 'The room row\'s keeper: replace an older keeper\'s hold of the room.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

class HoldServer {
  ctx: HoldContext;
  BEAT_MS: number; POLL_MS: number; WHO_MS: number;
  holds: Map<JsonRpcId | undefined, Hold>;
  logState: Map<string, { entries: readonly Readonly<Entry>[]; moves: Entry[] }>;
  me: Me | null; meAt: number; timer: NodeJS.Timeout | null; seat: Seat | null;

  constructor(ctx: HoldContext) {
    this.ctx = ctx;
    this.BEAT_MS = envMs('SUB_HUMAN_HOLD_BEAT_MS');
    this.POLL_MS = envMs('SUB_HUMAN_HOLD_POLL_MS');
    this.WHO_MS = envMs('SUB_HUMAN_HOLD_WHO_MS');
    this.holds = new Map();     // request id -> hold
    this.logState = new Map();  // code -> {entries, moves}: the log as last read, and its joins and leaves
    this.me = null; this.meAt = 0; this.timer = null; this.seat = null;
  }

  log(...a: unknown[]): void { try { this.ctx.log && this.ctx.log('hold', ...a); } catch { /* debug only */ } }
  text(s: string, isError = false): ToolResult { return this.ctx.text ? this.ctx.text(s, isError) : { content: [{ type: 'text', text: s }], ...(isError ? { isError: true as const } : {}) }; }
  roomHolds(code: RoomCode): Hold[] { return [...this.holds.values()].filter(h => h.code === code); }

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

  /** Who else is here for hold h's viewer, now ('' when it cannot be read). */
  hereFor(h: Hold, now: number): string {
    h.hereAt = now;
    try { return hereLine(h.code, this.me ? this.me.name : null, { now }); } catch { return ''; }
  }

  /** The line a progress sends: who else is here, then the room's latest. */
  line(h: Hold): string { return clip(h.here ? `${h.here}${SEP}${h.msg}` : h.msg); }

  progress(h: Hold, msg?: string): void {
    if (msg) h.msg = msg;
    h.sentAt = Date.now();
    if (h.token == null) return;
    h.n++;
    try { this.ctx.progress(h.token, h.n, h.take ? this.line(h) : `${LEAD}${SEP}${this.line(h)}`); } catch { /* client gone */ }
  }

  finish(h: Hold, s: string): void {
    if (!this.holds.has(h.id)) return;
    this.holds.delete(h.id);
    this.log('RETURN', h.id, s);
    h.resolve(this.text(s));
    if (!this.holds.size) this.stopTimer();
  }

  /** The lease, renewed while a hold runs (a room this machine no longer has, `link --forget`: never again). */
  heartbeat(now: number): void {
    const seat = this.seat;
    if (!seat) return;
    if (typeof this.ctx.identity.roomExists === 'function' && !this.ctx.identity.roomExists(seat.code)) { this.seat = null; return; }
    seat.savedAt = now;
    try { this.ctx.identity.heartbeat && this.ctx.identity.heartbeat(this.me ?? seat, now); } catch (e) { this.log('heartbeat', msgOf(e)); }
  }

  tick(): void {
    const now = Date.now();
    if (now - this.meAt >= this.WHO_MS) {
      this.meAt = now;
      let cur = null;
      try { cur = this.ctx.whoami(); } catch { cur = null; }
      const me = this.me;
      // removed by the host (a kick): the row stays, showing it ("✕ removed by the host"), and ends with the session;
      // ending it would hand "left" back to the main conversation, a model turn the kicked person never asked for
      if (me && !cur && removedByHost(me.code)) return;
      if (me && (!cur || cur.code !== me.code || cur.name !== me.name)) {
        for (const h of [...this.holds.values()]) this.finish(h, `STOP: ${me.name} is no longer in room ${h.code}. ${END}`);
        this.me = cur;
        return;
      }
      if (cur) this.me = cur;
    }
    for (const h of [...this.holds.values()]) {
      const { fresh } = this.readEntries(h.code);
      const plain = fresh.filter((e: Entry) => e.kind !== 'member_joined' && e.kind !== 'member_left').at(-1);
      if (plain) this.progress(h, entryLine(plain));
      const move = this.newMove(h, now);
      if (move) this.progress(h, move);
      if (now - h.hereAt >= this.WHO_MS) {
        const here = this.hereFor(h, now);
        if (here !== h.here) { h.here = here; this.progress(h); }
      }
      // The beat keeps the call under the MCP tool idle timeout (cc CONTRACT mcp-progress-resets-idle-timeout).
      if (this.holds.has(h.id) && now - h.sentAt >= this.BEAT_MS) this.progress(h);
    }
    const seat = this.seat;
    if (seat && this.holds.size && now - (seat.savedAt || 0) >= this.BEAT_MS / 2) this.heartbeat(now);
  }

  /** The newest join / settled leave this hold has not shown yet, as a notice line (marks them shown). */
  newMove(h: Hold, now: number): string {
    const { moves } = this.readEntries(h.code); // joins and leaves only: not the whole log every tick
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
    this.log('CANCELLED', h.id, h.code);
    h.resolve(this.text(`(cancelled)`));
    if (!this.holds.size) this.stopTimer();
  }

  call(name: string, who0: Me | null, args: ToolArgs = {}, meta: CallMeta = {}): ToolResult | Promise<ToolResult> | null {
    if (name !== 'hold') return null;
    let cur = who0;
    if (!cur) { try { cur = this.ctx.whoami(); } catch { cur = null; } }
    const early = (s: string) => { this.log('RETURN now', meta.id, args.room || '', s); return this.text(s); };
    if (!cur) return early(`STOP: not in a room. ${END}`);
    this.me = cur; this.meAt = Date.now();
    this.seat = this.seat && this.seat.code === cur.code && this.seat.name === cur.name ? this.seat : { code: cur.code, name: cur.name, pid: cur.pid };
    const code = cur.code;
    const roomCode = typeof args.room === 'string' ? args.room.trim() : '';
    if (!roomCode) return this.text('hold needs {room: CODE} (the room row).', true);
    if (roomCode !== code) return early(`STOP: you are in room ${code}, not ${roomCode}. ${END}`);
    if (args.take === true) for (const old of this.roomHolds(code)) this.finish(old, `STOP: a newer row holds room ${code}. ${END}`);
    else if (this.roomHolds(code).length) return early(`STOP: duplicate row: room ${code} already has its row. ${END}`);
    const now = Date.now();
    const h: Hold = { id: meta.id, token: meta.progressToken, n: 0, msg: '', here: '', hereAt: 0, sentAt: 0, code, started: now, take: args.take === true, moves: new Set(), resolve: (_r: ToolResult): void => {} };
    h.here = this.hereFor(h, now);
    const last = this.readEntries(code).entries.findLast((e: Entry) => e.kind !== 'member_joined' && e.kind !== 'member_left');
    const move = this.newMove(h, now);
    h.msg = move || (last ? entryLine(last) : `room ${code}`);
    return new Promise<ToolResult>(resolve => {
      h.resolve = resolve;
      this.holds.set(h.id, h);
      this.log('HOLD', h.id, h.code);
      if (this.ctx.onCancel && h.id != null) this.ctx.onCancel(h.id, () => this.onCancelled(h));
      this.progress(h);
      this.heartbeat(now);
      this.startTimer();
    });
  }
}

/** The room-server plug-in: one HoldServer behind {tools, call}. */
function create(ctx: HoldContext): PluginApi & { server: HoldServer; _state: Pick<HoldServer, 'holds'> } {
  const s = new HoldServer(ctx);
  // anonymous: room-server calls hold with me = null instead of erroring, so a row outside a room gets STOP.
  return {
    tools: [TOOL], call: (...a: Parameters<HoldServer['call']>) => s.call(...a), anonymous: ['hold'], server: s,
    _state: { holds: s.holds },
  };
}

export { create, TOOL, LEAD };
