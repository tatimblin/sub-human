/**
 * plugin/sub-human/lib/tail.ts: the room tail behind `sub-human tail` (scripts/sub-human), the hooks module's child
 * (mod/deliver.ts). Everything that waits goes through an injected clock (lib/clock.ts), so tests drive it with
 * clock.createFake() in-process.
 *
 *   runTail({clock, write, err, lookup, timings, fs, deps, maxSeconds, sid}) -> {stop(), session()}
 *       The loop: look the seat up (every unseatedMs, then resolveMs once seated), follow that room's log
 *       from its cursor, batch what this seat sees and write each batch's events with write(text, done). It
 *       never stops on an error: every timer callback is guarded (log to err, rate-limited, back off, carry on);
 *       only stop() / maxSeconds end it. A seated session whose poll loop has not ticked for stallMs is restarted.
 *   timings(env?) -> the named waits, from lib/config.ts and their SUB_HUMAN_* overrides
 *   Batcher({clock, settleMs, settleMaxMs, retryMs, onFlush, onError})
 *       enqueue(item) / arm() / flush() / stop(). Items wait in `pending` and go to onFlush(ready) as ONE
 *       batch after settleMs of quiet or settleMaxMs after the first one; an item younger than settleMs stays
 *       for the next batch. If onFlush throws, the batch goes back to pending and is retried after retryMs.
 *   formatRoomClaudeBatch(ready, ctx) -> lines     the room Claude's block: stateLine, then one full line per shown entry
 *   formatNdBatch(ready, ctx) -> {events, moved}   the hooks module's events for one batch (below)
 *   pullText(lines) -> text | null           "Room since your last turn" over lines, the newest kept under PULL_CAP
 *   missingRowsText(me, sid, {now}?) -> text | null   the Agent calls for this seat's rows that run nowhere
 *   remindersText(me, rm) -> text | null     lib/proposal.ts reminder() for the proposal a review opens next (the
 *                                            person's pick, else the oldest), the others awaiting me counted (members)
 *   linkLine(status, code) -> {key, text} | null   the one line for a room link that is not online (lib/remote/link.ts
 *       status; the words are lib/room/link-state.ts STATES): key 'fork' (the mirror no longer matches the host's
 *       log; queued @room posts are kept, not sent), 'stopped' (for good: refused, revoked, the room closed) or
 *       'offline' (the host or the daemon is unreachable); null while it is online or connecting
 *   flushLine(flush) -> text | null   what became of the @room posts queued while the link was down (the daemon's
 *       document `link` flush {sent, unsent: [{text, why}]}): appended to LINK_BACK, or alone when some were not sent
 *   deps (tests): openRoom(code) -> Room (lib/room.ts open), heartbeat(me) (identity.heartbeat), rows, notices, roomClaude,
 *       linkStatus(code) (lib/remote/link.ts status), admission (lib/remote/admission.ts), sweepDoors(code)
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
 *                             the batch moved a proposal); the room Claude's whole push block
 *   {type:'rows', text|null}  what the person's next prompt carries for Claude: pending-proposal reminders
 *                             (members) and the missing rows' Agent calls; sent at start and when it changes
 *                             (health tick); null clears it
 *   {type:'health', text}     the hash-chain check's line (one per break), and in a room hosted elsewhere the
 *                             link's linkLine each time it goes off (FORK, STOPPED or OFFLINE; nothing while it stays so)
 *                             and LINK_BACK ("the connection to the room is back; …", with flushLine) once it is online
 *                             again: one quiet line, no "left"/"joined" (the daemon renews the seat's lapsed lease)
 *   A short code's join request (lib/remote/admission.ts), on the host: a chat line for the person and a wake that
 *   tells Claude to open the card ("admit REF"), once per seat it is for; a request that lapsed is a health line; the
 *   enrollment door is swept (lib/remote/enroll.ts sweepDoors) every 30 s.
 *   A planned handoff (lib/handoff.ts): the ask waiting for this seat (its machine's mirror) is a chat line for the
 *   person and a wake that tells Claude to open the card, once; the asker gets a health line when the ask is
 *   declined or expires; host_changed is a chat line for every member. A session whose room changed kind (a
 *   mirror that became the host, or the reverse) is started again over the new store.
 * A session never re-reads the log from byte 0: backlog from room.readView({after: cursor}), live entries from
 * room.tailer(). The health tick also renews the seat's lease (identity.heartbeat).
 */

import nodeFs from 'node:fs';
import path from 'node:path';
import * as realClock from './clock.ts';
import * as config from './config.ts';
import { roomClaudeName } from './room/members.ts';
import { createRequire } from 'node:module';
import type { Clock, LinkFlush, LinkStatus, LogEntry, Seat, TailEvent, TailSeat } from './types-app.ts';

const require = createRequire(import.meta.url);

// ---------- types ----------
/** The room as a session reads it (lib/room.ts open): the calls made here. Tests hand in fakes. */
interface TailRoom {
  store?: { isHost: boolean } | null;
  readView(opts: { after: number }): LogEntry[];
  tailer(opts: { fs: typeof nodeFs }): { poll(): { entries: LogEntry[], reset?: boolean } };
  lastId(): number;
  getCursor(name: string): number;
  setCursor(name: string, id: number): void;
  verifyChain(): { ok: boolean, offset?: number, badAt?: number | null, line?: number };
  lane(me: Seat, e: LogEntry, entries?: LogEntry[]): string;
  chatLines(e: LogEntry, opts: { viewer: string, entries?: LogEntry[] }): string[];
  line(e: LogEntry, opts: { full: boolean }): string;
  stateLine(me: Seat, entries?: LogEntry[], opts?: { ids?: boolean }): string;
}
/** The push lane test (visibleTo): entries is the log at flush time; note is the joinNote of a member_joined. */
type Show = (e: LogEntry, entries?: LogEntry[], note?: string) => boolean;
/** A rate-limited logger (errorLog): where it failed, and the error. */
type Log = (where: string, e: unknown) => void;
/** The tail's write: text (whole lines) and a callback once it is out. */
type Write = (text: string, done: () => void) => unknown;
type Timings = ReturnType<typeof timings>;
/** One item the Batcher holds: the entry, and when it was enqueued. */
interface Item { e: LogEntry, away: boolean }
type Pending<T> = T & { at: number };

type RowsLib = Pick<typeof import('./rows.ts'), 'joinNote' | 'missingRows' | 'rowsNeeded' | 'readHolds' | 'sessionRowMap' | 'rowCalls'>;
type IdentityLib = Pick<typeof import('./identity.ts'), 'readMembers' | 'heartbeat'>;
type ProposalLib = Pick<typeof import('./proposal.ts'), 'pendingFor' | 'picked' | 'reminder'>;
type NoticesLib = Pick<typeof import('./notices.ts'), 'shown' | 'markShown'>;
type RoomClaudeLib = Pick<typeof import('./room-claude.ts'), 'watchdog'>;
type HandoffLib = Pick<typeof import('./handoff.ts'), 'pendingAsk' | 'markTold' | 'hostDoc'>;
type AdmissionLib = Pick<typeof import('./remote/admission.ts'), 'lapse' | 'pending' | 'targets' | 'describe' | 'markTold'>;
/** runTail's deps (tests): each one replaces a module or call. */
interface TailDeps {
  openRoom(code: string): TailRoom;
  heartbeat(me: Seat): unknown;
  rows: RowsLib;
  notices: NoticesLib;
  roomClaude: RoomClaudeLib;
  identity: IdentityLib;
  proposal: ProposalLib;
  linkStatus(code: string): LinkStatus;
  handoff: HandoffLib;
  admission: AdmissionLib;
  sweepDoors(code: string): unknown;
}
/** The deps as a session uses them: the lazily loaded modules behind a getter. */
type Deps = Omit<TailDeps, 'roomClaude' | 'handoff' | 'admission'> & {
  roomClaude(): RoomClaudeLib;
  handoff(): HandoffLib;
  admission(): AdmissionLib;
};
/** What every session shares (runTail). */
interface Ctx {
  clock: Clock;
  fs: typeof nodeFs;
  write: Write;
  log: Log;
  t: Timings;
  deps: Deps;
  sid: string | null;
}
/** One seat's session (startSession): its key, and the calls the loop makes on it. */
interface Session {
  key: string;
  code: string;
  dead: boolean;
  lastTick: number;
  save(): void;
  stalled(): boolean;
  moved(): boolean;
  killPoll(): void;
  stop(): void;
}
/** formatNdBatch / formatRoomClaudeBatch's ctx. */
interface FormatCtx {
  me: Seat;
  room: TailRoom;
  entries: LogEntry[];
  show: Show;
  joinNote(e: LogEntry): string;
  seen: Set<number>;
  leaveMs: number;
}
type Cursor = ReturnType<typeof cursorKeeper>;

const { envMs } = config;
const FOR_CLAUDE = '(for Claude)';
const DOOR_SWEEP_MS = 30_000;
const SPAWN_NOTE = /no row running|is not running/;
const STATE_KINDS = new Set(['proposal', 'signoff', 'objection', 'decision']);
const isMove = (e: LogEntry) => e.kind === 'member_joined' || e.kind === 'member_left';
const isHostMove = (e: LogEntry) => e.kind === 'host_changed' && e.via === 'system';

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
    // The headless room Claude waits longer (nobody watches its latency), so a burst of answers, task requests or a
    // join lands as one turn, unless the member values are set explicitly.
    roomClaudeSettleMs: envMs('SUB_HUMAN_ROOM_CLAUDE_SETTLE_MS', process.env.SUB_HUMAN_SETTLE_MS ? settleMs : config.ROOM_CLAUDE_SETTLE_MS),
    roomClaudeSettleMaxMs: envMs('SUB_HUMAN_ROOM_CLAUDE_SETTLE_MAX_MS', process.env.SUB_HUMAN_SETTLE_MAX_MS ? settleMaxMs : config.ROOM_CLAUDE_SETTLE_MAX_MS),
    leaveMs: envMs('SUB_HUMAN_LEAVE_MS', config.LEAVE_SETTLE_MS),
    healthMs: envMs('SUB_HUMAN_TAIL_HEALTH_MS', config.TAIL_HEALTH_MS),
    backoffMs: envMs('SUB_HUMAN_TAIL_BACKOFF_MS', config.TAIL_BACKOFF_MS),
    backoffMaxMs: envMs('SUB_HUMAN_TAIL_BACKOFF_MAX_MS', config.TAIL_BACKOFF_MAX_MS),
    errorLogMs: envMs('SUB_HUMAN_TAIL_ERROR_LOG_MS', config.TAIL_ERROR_LOG_MS),
    stallMs: envMs('SUB_HUMAN_TAIL_STALL_MS', config.TAIL_STALL_MS),
  };
}

// ---------- Batcher ----------
class Batcher<T extends { e: { id: number } } = Item> {
  clock: Clock;
  settleMs: number;
  settleMaxMs: number;
  retryMs: number;
  onFlush: (ready: Pending<T>[]) => unknown;
  onError: (err: unknown) => void;
  pending: Pending<T>[];
  quietT: unknown;
  maxT: unknown;
  dead: boolean;
  constructor({ clock = realClock, settleMs, settleMaxMs, retryMs = settleMs, onFlush, onError = () => {} }: {
    clock?: Clock, settleMs: number, settleMaxMs: number, retryMs?: number,
    onFlush: (ready: Pending<T>[]) => unknown, onError?: (err: unknown) => void,
  }) {
    this.clock = clock;
    this.settleMs = settleMs;
    this.settleMaxMs = settleMaxMs;
    this.retryMs = retryMs;
    this.onFlush = onFlush;
    this.onError = onError;
    this.pending = []; // {at, ...item}
    this.quietT = null;
    this.maxT = null;
    this.dead = false;
  }
  enqueue(item: T) { this.pending.push({ ...item, at: this.clock.now() }); this.arm(); }
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
function formatRoomClaudeBatch(ready: Item[], { me, room: rm, entries, show, joinNote, leaveMs }: FormatCtx): string[] {
  const out: string[] = [];
  for (const { e, away } of ready) {
    const note = joinNote(e);
    if (show(e, entries, note)) out.push(rm.line(e, { full: true }) + (away ? ` · away ${Math.round(leaveMs / 1000)}s+` : '') + (note ? ` · ${note}` : ''));
  }
  return out.length ? [rm.stateLine(me, entries), ...out] : [];
}

const esc = (s: string) => s.replace(/[.]/g, '\\.');
/** "@name" in text, as lib/room/lanes.ts reads a mention. */
const mentions = (text: string | null | undefined, name: string) => new RegExp(`(^|[^A-Za-z0-9_.-])@${esc(name)}(?![A-Za-z0-9_-])`, 'i').test(String(text ?? ''));
/**
 * A member's push entry that is group chat, not a request (the person sees it, Claude gets a copy, no wake):
 * a join or leave, and another person's own words not addressed to me.
 */
function isChat(me: Seat, e: LogEntry): boolean {
  if (isMove(e) || isHostMove(e)) return true;
  return e.via === 'human' && e.kind === 'say' && e.to !== me.name && !mentions(e.text, me.name);
}

const PULL_HEAD = 'Room since your last turn (context for you, not for the user: mention it only if they ask):';
/** The pull text: PULL_HEAD, then the newest lines that fit under PULL_CAP (a note says how many were left out). */
function pullText(lines: string[]): string | null {
  if (!lines.length) return null;
  const kept: string[] = [];
  let size = PULL_HEAD.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (size + lines[i].length + 1 > config.PULL_CAP - 80) break;
    kept.unshift(lines[i]);
    size += lines[i].length + 1;
  }
  const dropped = lines.length - kept.length;
  const more = dropped ? [`(${dropped} earlier ${dropped === 1 ? 'line' : 'lines'} not shown: the room read tool has them)`] : [];
  return [PULL_HEAD, ...more, ...kept].join('\n');
}

/**
 * One batch as the hooks module's events, in the order the mod applies them (chat, pull, wake).
 * ctx: {me, room, entries, show (the push lane, visibleTo), joinNote, seen, leaveMs}. moved: the join / leave ids
 * sent as chat (notices.markShown).
 */
function formatNdBatch(ready: Item[], ctx: FormatCtx): { events: TailEvent[], moved: number[] } {
  const { me, room: rm, entries, show, joinNote, seen } = ctx;
  const chat: string[] = [], pull: string[] = [], wake: string[] = [], moved: number[] = [], pushed: Item[] = [];
  let state = false;
  for (const p of ready) {
    const { e } = p;
    if (me.role !== 'claude') {
      if (isMove(e) && seen.has(e.id)) continue; // an earlier child already sent it
      if (show(e, entries)) {
        const lines = rm.chatLines(e, { viewer: me.name, entries });
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
    if (rm.lane(me, e, entries) === 'pull') pull.push(...rm.chatLines(e, { viewer: me.name, entries }));
  }
  if (me.role === 'claude') wake.push(...formatRoomClaudeBatch(pushed, ctx));
  // no ids for a member: the plugin prompt's row is drawn expanded, (for Claude) lines included (people never see ids)
  else if (state && wake.length) wake.push(`${FOR_CLAUDE} ${rm.stateLine(me, entries, { ids: false })}`);
  const events: TailEvent[] = [];
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
function missingRowsText(me: Seat, sid: string | null, {
  now = Date.now(), rows = require('./rows.ts') as RowsLib, identity = require('./identity.ts') as IdentityLib,
}: { now?: number, rows?: RowsLib, identity?: IdentityLib } = {}): string | null {
  try {
    const members = identity.readMembers(me.code);
    // room Claude: missingRows skips members who joined under 45 s ago (their member_joined notice covers them)
    let need = me.role === 'claude' ? rows.missingRows(me.code, me, { members })
      : rows.rowsNeeded(me.code, me, { members, held: rows.readHolds(me.code, me.name) });
    let map: ReturnType<RowsLib['sessionRowMap']> = {};
    try { map = rows.sessionRowMap(me.code, sid); } catch { /* none */ }
    const fresh = new Set(Object.values(map).filter(r => r && now - Date.parse(r.at as string) < SPAWN_GRACE_MS).map(r => r.name));
    need = need.filter(n => !fresh.has(n));
    if (!need.length) return null;
    return `SUB-HUMAN ROWS: your ${me.role === 'claude' ? `rows for ${need.join(', ')} are` : 'room row is'} not running in this session. `
      + 'Make the call below first, in the same message as anything else you do, exactly as written.\n'
      + rows.rowCalls(me, members, { only: need });
  } catch { return null; }
}

/** lib/proposal.ts reminder() for each proposal that names this member and awaits their answer; null for the room's Claude or none. */
function remindersText(me: Seat, rm: Pick<TailRoom, 'readView'>, { proposal = require('./proposal.ts') as ProposalLib }: { proposal?: ProposalLib } = {}): string | null {
  if (me.role === 'claude') return null;
  const ps = proposal.pendingFor(me, rm.readView({ after: Infinity })) || [];
  if (!ps.length) return null;
  // Only the one a review opens next (the person's pick, else the oldest; hooks/consent.ts), the others counted, so
  // the model is never told to open a proposal the hooks will not show.
  const p = proposal.picked(me, ps)!; // ps is not empty
  const more = ps.length - 1;
  return proposal.reminder(p, me.name) + (more ? ` (${more} more await ${me.name}'s answer; the hooks open whichever ${me.name} names next, else the oldest.)` : '');
}

/**
 * The push lane (rm.lane). A member also gets every other member's join and leave (a group chat line). The
 * room Claude gets another member's member_joined when lib/rows.ts joinNote() says that row is not running (the note
 * carries the Agent call) or when the note is unavailable; a join whose row already runs is not pushed to it,
 * so a notice never invites a call that row-guard would deny.
 */
function visibleTo(me: Seat, rm: TailRoom): Show {
  if (me.role !== 'claude') {
    return (e, entries) => rm.lane(me, e, entries) === 'push' || isHostMove(e)
      || (isMove(e) && e.via === 'system' && e.from !== me.name && roomClaudeName(e.from) !== 'claude'); // 0.4.x: "orch"
  }
  return (e, entries, note = '') => rm.lane(me, e, entries) === 'push'
    || (e.kind === 'member_joined' && e.from !== me.name && (SPAWN_NOTE.test(note) || !note));
}

// ---------- the link of a room hosted elsewhere ----------
const LINK_BACK = 'the connection to the room is back; @room posts go through again';
function linkLine(st: LinkStatus, code: string): { key: 'fork' | 'offline' | 'stopped', text: string } | null {
  const kept = st.queued ? `; ${st.queued} @room post(s) are kept, not sent` : '';
  if (st.state === 'fork') {
    return { key: 'fork', text: `this machine's copy of room ${code} no longer matches the host's${kept}. Run /sub-human doctor.` };
  }
  if (st.running && st.state !== 'offline') return null;
  if (st.running) return { key: 'offline', text: `the connection to room ${code} is down (${st.reason}); @room posts wait and go out when it's back, card answers can't be sent until then` };
  if (st.state === 'stopped') return { key: 'stopped', text: `the connection to room ${code} stopped (${st.reason || 'for good'}); @room posts can't be sent${kept}. Run /sub-human doctor.` };
  return { key: 'offline', text: `the connection to room ${code} isn't running; @room posts can't be sent${kept}. Type /sub-human to reconnect.` };
}
function flushLine(f: LinkFlush | null | undefined): string | null {
  if (!f || (!f.sent && !(f.unsent || []).length)) return null;
  const parts: string[] = [];
  if (f.sent) parts.push(`${f.sent} waiting @room post(s) sent`);
  for (const u of f.unsent || []) parts.push(`not sent (${u.why}): "${u.text}"`);
  return parts.join('; ');
}

// ---------- reading ----------
/** A rate-limited stderr logger: one line per `where` per everyMs, with the count it held back. */
function errorLog(err: (s: string) => unknown, clock: Clock, everyMs: number): Log {
  const last = new Map<string, { at: number, held: number }>(); // where -> {at, held}
  return (where, e) => {
    const now = clock.now(), x = last.get(where);
    if (x && now - x.at < everyMs) { x.held++; return; }
    const more = x && x.held ? ` (+${x.held} more since)` : '';
    last.set(where, { at: now, held: 0 });
    try { err(`sub-human tail: ${where} failed: ${e && (e as Error).message || e}${more}; retrying\n`); } catch { /* stderr closed */ }
  };
}

// ---------- one seat's session ----------
/** Where a seat's delivery starts: its saved cursor, else (its first run) its latest join, so nothing between the
 * join and the first lookup is lost, else the log's end. */
function startCursor(rm: Pick<TailRoom, 'getCursor' | 'readView'>, reader: string, me: Seat, last: number): number {
  const c = rm.getCursor(reader);
  if (c > 0 && c <= last) return c;
  // 0.4.x kept the room's Claude's cursor as deliver-orch: an upgraded room resumes there, so no @claude is skipped
  const old = me.role === 'claude' ? rm.getCursor('deliver-orch') : 0;
  if (old > 0 && old <= last) return old;
  const joined = rm.readView({ after: Infinity }).filter(e => e.kind === 'member_joined' && e.from === me.name).at(-1);
  return joined ? joined.id : last;
}

/**
 * The saved cursor is the highest id h such that every event for ids <= h has been written to stdout. In flight:
 * ids buffered for the next batch, held (member_left) or being written.
 *   saw(id)      an entry was processed (an id not above the last one: the log was reset under us, back to 0)
 *   hold(id), release(id)   in flight, or out
 *   save()       move the saved cursor as far as it may go; a failed write is retried by the next save
 */
function cursorKeeper(rm: Pick<TailRoom, 'setCursor'>, reader: string, after: number, { log, dead }: { log: Log, dead: () => boolean }) {
  const inflight = new Set<number>();
  let processed = after, saved = after;
  return {
    saw(id: number) {
      if (id <= processed) { saved = 0; rm.setCursor(reader, 0); }
      processed = id;
    },
    hold: (id: number) => { inflight.add(id); },
    release: (id: number) => { inflight.delete(id); },
    save() {
      if (dead()) return;
      const h = inflight.size ? Math.min(...inflight) - 1 : processed;
      if (h <= saved) return;
      // the events are out, so a restart after a failed write would repeat them at most
      try { rm.setCursor(reader, h); saved = h; } catch (e) { log('cursor save', e); }
    },
  };
}

/**
 * One settled batch as ONE write (at most one wake). Each entry is judged again against the log at flush time
 * (lane with entries: signed, decided, superseded); the cursor moves past the batch once it is written.
 */
function flushBatch(ready: Item[], { me, rm, pushed, joinNote, leaveMs, notices, emit, cursor }: {
  me: Seat, rm: TailRoom, pushed: Show, joinNote: (e: LogEntry) => string, leaveMs: number, notices: NoticesLib,
  emit: (events: TailEvent[], done?: () => void) => unknown, cursor: Cursor,
}): unknown {
  const entries = rm.readView({ after: ready[0].e.id - 1 });
  const done = () => { for (const p of ready) cursor.release(p.e.id); cursor.save(); };
  const seen = me.role === 'claude' ? new Set<number>() : notices.shown(me.code, me.name);
  const { events, moved } = formatNdBatch(ready, { me, room: rm, entries, show: pushed, joinNote, leaveMs, seen });
  if (!events.length) return done();
  if (moved.length) { try { notices.markShown(me.code, me.name, moved, 'mod'); } catch { /* best effort */ } }
  return emit(events, done);
}

/**
 * A self-rescheduling timer that survives its own errors, backing off while they repeat (s.dead ends it).
 * The poll loop stamps s.lastTick on every tick, for the stall check.
 */
function timerLoop({ clock, t, log, s }: { clock: Clock, t: Timings, log: Log, s: Pick<Session, 'dead' | 'lastTick'> }, where: string, fn: () => void, everyMs: number) {
  let fails = 0, timer: unknown = null;
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
  return { start: (now: boolean) => { if (now) tick(); else timer = clock.setTimeout(tick, everyMs); }, stop: () => clock.clearTimeout(timer) };
}

function startSession(me: Seat, ctx: Ctx): Session {
  const { clock, fs, write, log, t, deps, sid } = ctx;
  const { rows, notices } = deps;
  const rm = deps.openRoom(me.code); // this session's room, held for its whole life (no re-binding)
  const reader = `deliver-${me.name}`;
  const emit = (events: TailEvent[], done: () => void = () => {}) => write(events.map(x => JSON.stringify(x)).join('\n') + '\n', done);
  // Where polling starts: taken before the backlog read, so nothing appended in between is missed (the
  // overlap is dropped by id).
  const tailer = rm.tailer({ fs });
  const last = rm.lastId();
  const after = startCursor(rm, reader, me, last);
  rm.setCursor(reader, after);
  // its calls (save, stalled, moved, killPoll, stop) are filled in below, before the loop reads them
  const s = { key: `${me.code}/${me.name}/${me.role}`, code: me.code, dead: false, lastTick: clock.now() } as Session;
  const settleMs = me.role === 'claude' ? t.roomClaudeSettleMs : t.settleMs;
  const settleMaxMs = me.role === 'claude' ? t.roomClaudeSettleMaxMs : t.settleMaxMs;
  const cursor = cursorKeeper(rm, reader, after, { log, dead: () => s.dead });
  let seen = after;
  s.save = () => cursor.save();
  const pushed = visibleTo(me, rm);
  const show: Show = (e, entries, note) => pushed(e, entries, note) || rm.lane(me, e, entries) === 'pull';
  // member_joined: say whether that member's row already runs here, so only a missing one is spawned
  const joinNote = (e: LogEntry) => {
    if (e.kind !== 'member_joined') return '';
    try { return rows.joinNote(me, e.from); } catch { return ''; }
  };

  const flushCtx = { me, rm, pushed, joinNote, leaveMs: t.leaveMs, notices, emit, cursor };
  const onFlush = (ready: Item[]) => flushBatch(ready, flushCtx);
  const batch = new Batcher<Item>({ clock, settleMs, settleMaxMs, retryMs: t.backoffMs, onFlush, onError: e => log('flush', e) });

  const held = new Map<string, { e: LogEntry, timer: unknown }>(); // name -> {e, timer}: member_left waiting leaveMs for a rejoin
  const settled = (e: LogEntry) => guard('leave hold', () => { held.delete(e.from); batch.enqueue({ e, away: true }); });
  const hold = (e: LogEntry) => ({ e, timer: clock.setTimeout(settled(e), t.leaveMs) });
  function onEntry(e: LogEntry): void {
    cursor.saw(e.id);
    if (e.kind === 'member_joined' && held.has(e.from)) {
      // left and back within leaveMs: neither notice is sent
      const h = held.get(e.from)!; // has() above
      clock.clearTimeout(h.timer);
      held.delete(e.from);
      cursor.release(h.e.id);
      return s.save();
    }
    if (!show(e, undefined, e.kind === 'member_joined' ? 'no row running' : '')) return s.save();
    cursor.hold(e.id);
    if (e.kind === 'member_left') {
      const prev = held.get(e.from);
      if (prev) { clock.clearTimeout(prev.timer); held.delete(e.from); batch.enqueue({ e: prev.e, away: true }); }
      held.set(e.from, hold(e));
      return;
    }
    batch.enqueue({ e, away: false });
  }
  const deliver = (e: LogEntry) => { if (s.dead || !(e.id > seen)) return; seen = e.id; onEntry(e); };

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

  // Health: the hash chain from the log.idx checkpoint (one line per break), the link of a room hosted elsewhere
  // (one line each time it goes down), and the room Claude's watchdog.
  let breakKey: string | null = null, linkKey: string | null = null, flushKey: string | null | undefined, rowsSent: string | null | undefined;
  function sendRows() {
    let text: string | null = null;
    try {
      const missing = missingRowsText(me, sid, { now: clock.now(), rows, identity: deps.identity });
      text = [remindersText(me, rm, deps), missing].filter(Boolean).join('\n\n') || null;
    } catch (e) { log('rows', e); return; }
    if (text === rowsSent) return;
    rowsSent = text;
    emit([{ type: 'rows', text }]);
  }
  function linkHealth() {
    const st = deps.linkStatus(s.code);
    const l = linkLine(st, s.code);
    const f = st.flush || null, fresh = flushKey !== undefined && f && f.at !== flushKey;
    if (flushKey === undefined || fresh) flushKey = f ? f.at : null; // a flush before this tail started is old news
    const flushed = fresh ? flushLine(f) : null;
    if ((l && l.key) === linkKey || (!l && st.state !== 'online')) { // no change (or coming back: the down line stands)
      if (flushed && f && f.unsent && f.unsent.length) emit([{ type: 'health', text: flushed }]);
      return;
    }
    const was = linkKey;
    linkKey = l && l.key;
    if (l) emit([{ type: 'health', text: l.text }]);
    else if (was) emit([{ type: 'health', text: flushed ? `${LINK_BACK}; ${flushed}` : LINK_BACK }]);
  }
  // A planned handoff: the ask waiting for this seat (a wake, once), or the asker told it was declined or expired.
  let askKey: string | null = null;
  function handoffHealth() {
    const ho = deps.handoff();
    if (!rm.store!.isHost) { // health() calls this only with a store
      const a = ho.pendingAsk(s.code, me.name, clock.now());
      if (!a || a.told_at) return;
      ho.markTold(s.code, a.id);
      emit([
        { type: 'chat', lines: [`room: ${a.from} asks you to host room ${s.code} on this machine; your Claude shows you a card`] },
        { type: 'wake', text: `${FOR_CLAUDE} ${a.from} asks ${me.name} to host room ${s.code} on this machine (the room's Claude would then run on ${me.name}'s model account, and this machine must stay reachable). Only ${me.name} can answer: call AskUserQuestion with the question "handoff ${a.id}"; the hooks show the card. Don't answer for ${me.name} or post about it.` },
      ]);
      return;
    }
    const d = ho.hostDoc(rm.store);
    if (!d || d.from !== me.name) return;
    const state = d.state === 'asked' && !(Date.parse(d.expires_at) > clock.now()) ? 'expired' : d.state;
    const key = `${d.id}/${state}`;
    if (key === askKey || (state !== 'refused' && state !== 'expired')) return;
    askKey = key;
    emit([{ type: 'health', text: `room handoff: ${d.to} ${state === 'refused' ? 'declined to host' : 'did not answer the ask to host'} room ${s.code}; this machine stays the host` }]);
  }
  // A short code's join request (lib/remote/admission.ts), on the host: this seat's card, opened by its Claude once; a
  // request nobody answered lapses with a line. The enrollment door closes once no ssh code is open (every SWEEP_MS).
  let doorsSwept = 0;
  function admitHealth() {
    const adm = deps.admission();
    for (const q of adm.lapse(s.code, { now: clock.now() })) {
      emit([{ type: 'health', text: `room: ${adm.describe(q)} typed your PIN, but nobody let them in within ${Math.round((Date.parse(q.expires_at) - Date.parse(q.created_at)) / 60_000)} minutes; their join stopped` }]);
    }
    for (const q of adm.pending(s.code, { now: clock.now() })) {
      if ((q.told || []).includes(me.name) || !adm.targets(s.code, q).includes(me.name)) continue;
      adm.markTold(s.code, q.ref, me.name);
      emit([
        { type: 'chat', lines: [`room: ${adm.describe(q)} typed your PIN and wants to join; your Claude shows you a card (or: /sub-human admit ${q.ref})`] },
        { type: 'wake', text: `${FOR_CLAUDE} ${adm.describe(q)} typed the PIN of ${me.name}'s invite from another machine and asks to join room ${s.code}. Only ${me.name} can let them in: call AskUserQuestion with the question "admit ${q.ref}"; the hooks show the card. Don't answer for ${me.name} or post about it.` },
      ]);
    }
    if (clock.now() - doorsSwept >= DOOR_SWEEP_MS) { doorsSwept = clock.now(); deps.sweepDoors(s.code); }
  }
  function health() {
    try { deps.heartbeat(me); } catch (e) { log('seat heartbeat', e); } // the seat's lease (identity.heartbeat)
    sendRows();
    if (s.moved()) return; // the room changed kind under this session: the next check starts it again
    if (rm.store && me.role !== 'claude') { try { handoffHealth(); } catch (e) { log('handoff', e); } }
    if (rm.store && rm.store.isHost && me.role !== 'claude') { try { admitHealth(); } catch (e) { log('admission', e); } }
    if (rm.store && !rm.store.isHost) linkHealth();
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
    if (me.role === 'claude') deps.roomClaude().watchdog(s.code);
  }

  // a timer callback that survives its own error
  function guard(where: string, fn: () => void) { return () => { if (s.dead) return; try { fn(); } catch (e) { log(where, e); } }; }
  const loops = { clock, t, log, s };
  const pollLoop = timerLoop(loops, 'poll', poll, t.pollMs);
  const healthLoop = timerLoop(loops, 'health check', health, t.healthMs);
  pollLoop.start(true);
  healthLoop.start(false);
  sendRows();

  s.stalled = () => clock.now() - s.lastTick > t.stallMs;
  // (a room without a store throws: the catch)
  s.moved = () => { try { return !!rm.store && deps.openRoom(me.code).store!.isHost !== rm.store.isHost; } catch { return false; } };
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
/** runTail's options (lib/cli/main.ts; tests add a fake clock, timings and deps). */
interface TailOpts {
  clock?: Clock;
  write: Write;
  err?: (s: string) => unknown;
  lookup: () => Seat | null;
  timings?: Timings;
  fs?: typeof nodeFs;
  deps?: Partial<TailDeps>;
  maxSeconds?: number | null;
  sid?: string | null;
}
function runTail({
  clock = realClock, write, err = s => process.stderr.write(s), lookup, timings: tm = timings(), fs = nodeFs,
  deps = {}, maxSeconds = null, sid = null,
}: TailOpts): { stop(): void, session(): Session | null } {
  const LIB = import.meta.dirname;
  const d: Deps = {
    openRoom: deps.openRoom || (() => { const r: typeof import('./room.ts') = require('./room.ts'); return (code: string) => r.open(code); })(),
    heartbeat: deps.heartbeat || ((me: Seat) => (require('./identity.ts') as typeof import('./identity.ts')).heartbeat(me)),
    rows: deps.rows || require('./rows.ts'),
    notices: deps.notices || require('./notices.ts'),
    roomClaude: deps.roomClaude ? () => deps.roomClaude! : (() => { let o: RoomClaudeLib | undefined; return () => o || (o = require('./room-claude.ts') as RoomClaudeLib); })(),
    identity: deps.identity || require('./identity.ts'),
    proposal: deps.proposal || require('./proposal.ts'),
    linkStatus: deps.linkStatus || ((code: string) => (require('./remote/link.ts') as typeof import('./remote/link.ts')).status(code)),
    handoff: deps.handoff ? () => deps.handoff! : (() => { let m: HandoffLib | undefined; return () => m || (m = require('./handoff.ts') as HandoffLib); })(),
    admission: deps.admission ? () => deps.admission! : (() => { let m: AdmissionLib | undefined; return () => m || (m = require('./remote/admission.ts') as AdmissionLib); })(),
    sweepDoors: deps.sweepDoors || ((code: string) => (require('./remote/enroll.ts') as typeof import('./remote/enroll.ts')).sweepDoors(code)),
  };
  const log = errorLog(err, clock, tm.errorLogMs);
  const ctx: Ctx = { clock, fs, write, log, t: tm, deps: d, sid };
  // say which seat is followed, when that changes
  let seatSent: string | undefined;
  const sendSeat = (me: Seat | null) => {
    const seat: TailSeat | null = me ? { name: me.name, code: me.code, role: me.role === 'claude' ? 'claude' : 'member', addr: `${me.name}.${me.code}` } : null;
    const key = JSON.stringify(seat);
    if (key === seatSent) return;
    seatSent = key;
    const ev: TailEvent = { type: 'seat', seat };
    try { write(JSON.stringify(ev) + '\n', () => {}); } catch (e) { log('seat event', e); }
  };
  let sess: Session | null = null, timer: unknown = null, stopped = false;

  function stopSess() {
    if (!sess) return;
    const s = sess;
    sess = null;
    try { s.stop(); s.save(); } catch (e) { log('session stop', e); }
    s.dead = true;
  }

  function check() {
    if (stopped) return;
    let me: Seat | null = null, failed = false;
    try { me = lookup(); } catch (e) { failed = true; log('seat lookup', e); } // transient: keep the current state
    if (!failed) {
      const key = me ? `${me.code}/${me.name}/${me.role}` : null;
      if (sess && sess.key === key && sess.stalled()) { log('poll loop', new Error('stalled')); stopSess(); }
      else if (sess && sess.key === key && sess.moved()) stopSess(); // a handoff: the room is hosted here now, or elsewhere
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

export {
  runTail, timings, Batcher, formatNdBatch, linkLine, flushLine, LINK_BACK, remindersText, PULL_HEAD, startCursor,
};
