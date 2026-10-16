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
 *   pullText(lines) -> text | null           the room context over lines (PULL_HEAD … PULL_END), the newest kept under PULL_CAP
 *   missingRowsText(me, sid, {now}?) -> text | null   the Agent calls for this seat's rows that run nowhere
 *   remindersText(me, rm) -> text | null     lib/proposal.ts reminder() for the proposal a review opens next (the
 *                                            person's pick, else the newest), the others awaiting me listed as
 *                                            h6 "title" (members); a note of mine waiting on it: the confirm card instead,
 *                                            to show now (consent's reoffer says the same) until it was offered again
 *   linkLine(status, code) -> {key, text} | null   the one line for a room link that is not online (lib/remote/link.ts
 *       status; the words are lib/room/link-state.ts STATES): key 'fork' (the mirror no longer matches the host's
 *       log; queued @room posts are kept, not sent), 'stopped' (for good: refused, revoked, the room closed) or
 *       'offline' (the host or the daemon is unreachable); null while it is online or connecting
 *   flushLine(flush) -> text | null   what became of the @room posts queued while the link was down (the daemon's
 *       document `link` flush {sent, unsent: [{text, why}]}): appended to LINK_BACK, or alone when some were not sent
 *   deps (tests): openRoom(code) -> Room (lib/room.ts open), heartbeat(me) (identity.heartbeat), rows, session (lib/room/session.ts), roomClaude,
 *       linkStatus(code) (lib/remote/link.ts status), admission (lib/remote/admission.ts),
 *       sweepSeats(code) (lib/seats.ts sweep: on the host, every health tick), pendingNews(sid) (lib/remote/joining.ts:
 *       a join this session started with a PIN)
 *
 * It writes one JSON event per line, which the mod routes. It reads from the seat's cursor (its session document,
 * lib/room/session.ts; first run: from
 * the seat's join) and sends each entry as lib/room/deliver.ts classes it for this seat (notice: chat; context:
 * pull; wake: wake; none: nothing). Events:
 *   {type:'seat', seat: {name, code, role, addr} | null}   the seat it follows (null: none any more)
 *   {type:'chat', lines}      a member's group chat: people's words, joins and leaves
 *                             (the person sees them; no wake)
 *   {type:'pull', text}       for Claude, no wake: the pull lane plus a copy of the chat lines, under the
 *                             room context's head and end (PULL_CAP); the module holds it for the person's next
 *                             prompt. At most once: the cursor moves when the line is written
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
 *   {type:'invites', open}    on the host, the refs of the room's open invite lines, each time the set changes: the
 *                             module takes an invite off its status line once it is used, burnt, cancelled or expired
 *   An invite's join request (lib/remote/admission.ts), on the host: one wake, its line for the person (drawn as the
 *   prompt) and a (for Claude) line that tells Claude to open the card ("admit REF"), once per seat it is for; a request that lapsed is a health line.
 *   A planned handoff (lib/handoff.ts): the ask waiting for this seat (its machine's mirror) is one wake, a line for the
 *   person and a (for Claude) line that tells Claude to open the card, once; the asker gets a health line when the ask is
 *   declined or expires; host_changed is a chat line for every member. A session whose room changed kind (a
 *   mirror that became the host, or the reverse) is started again over the new store.
 * A session with no seat that started an invite join (its link file's join_sid; the hooks module starts the tail for
 * it: mod-hello's pending) is looked up every resolveMs until the host let it in, and gets one chat line per answer (a
 * seated session too, at each seat check: a kicked machine's copy may still show its seat):
 * the host asks for the PIN (or again, after a wrong one), "the host let you in to room CODE: type /sub-human to join
 * it as NAME", or why the join stopped.
 * A session never re-reads the log from byte 0: backlog from room.readView({after: cursor}), live entries from
 * room.tailer(). The health tick also renews the seat's lease (identity.heartbeat).
 */

import nodeFs from 'node:fs';
import * as realClock from './clock.ts';
import * as config from './config.ts';
import { envMs, envStr } from './env.ts';
import { stageOf } from './consent/review.ts';
import { createRequire } from 'node:module';
import type { TailEvent, TailSeat } from './types-app.ts';
import type { LinkStatus } from './remote/link-socket.ts';
import type { Flush } from './remote/types-core.ts';
import type { Clock, TimerHandle } from './clock.ts';
import type { Delivery, Entry } from './room/types.ts';
import type { Identity } from './identity.ts';
import type { Room } from './room.ts';
import { FOR_CLAUDE, PULL_HEAD, PULL_END, pullDroppedLine } from '../mod/core/constants.ts';
import { msgOf } from './errors.ts';
import type { RoomCode } from './brand.ts';

const require = createRequire(import.meta.url);

// ---------- types ----------
/** The room as a session reads it (lib/room.ts open): the calls made here. Tests hand in fakes. */
type TailRoom = Pick<Room, 'readView' | 'tailer' | 'lastId' | 'getCursor' | 'verifyChain' | 'deliver' | 'chatLines' | 'line' | 'stateLine'>
  & { store?: Room['store'] | null };
/** What an entry is for this seat (lib/room/deliver.ts): entries is the log at flush time; note is the joinNote of a member_joined. */
type Judge = (e: Entry, entries?: readonly Entry[], note?: string) => Delivery;
/** A rate-limited logger (errorLog): where it failed, and the error. */
type Log = (where: string, e: unknown) => void;
/** The tail's write: text (whole lines) and a callback once it is out. */
type Write = (text: string, done: () => void) => unknown;
type Timings = ReturnType<typeof timings>;
/** One item the Batcher holds: the entry, and when it was enqueued. */
interface Item { e: Entry, away: boolean }
type Pending<T> = T & { at: number };

type RowsLib = Pick<typeof import('./rows.ts'), 'joinNote' | 'missingRows' | 'rowsNeeded' | 'readHolds' | 'sessionRowMap' | 'rowCalls'>;
type IdentityLib = Pick<typeof import('./identity.ts'), 'readMembers' | 'heartbeat'>;
type ProposalLib = Pick<typeof import('./proposal.ts'), 'pendingFor' | 'picked' | 'reminder' | 'readConfirm' | 'confirmCall' | 'showConfirm'>;
type SessionLib = Pick<typeof import('./room/session.ts'), 'shown' | 'markShown' | 'get' | 'put'>;
type RoomClaudeLib = Pick<typeof import('./room-claude.ts'), 'watchdog'>;
type HandoffLib = Pick<typeof import('./handoff.ts'), 'pendingAsk' | 'markTold' | 'hostDoc'>;
type AdmissionLib = Pick<typeof import('./remote/admission.ts'), 'lapse' | 'pending' | 'targets' | 'describe' | 'markTold'>;
type InvitesLib = Pick<typeof import('./remote/invites.ts'), 'inviteOpen'>;
/** runTail's deps (tests): each one replaces a module or call. */
interface TailDeps {
  openRoom(code: RoomCode): TailRoom;
  heartbeat(me: Identity): unknown;
  rows: RowsLib;
  session: SessionLib;
  roomClaude: RoomClaudeLib;
  identity: IdentityLib;
  proposal: ProposalLib;
  linkStatus(code: RoomCode): LinkStatus;
  handoff: HandoffLib;
  admission: AdmissionLib;
  invites: InvitesLib;
  sweepSeats(code: RoomCode): unknown;
  pendingNews(sid: string): { state: 'waiting' | 'pin' | 'linked' | 'refused'; code: RoomCode; text: string } | null;
}
/** The deps as a session uses them: the lazily loaded modules behind a getter. */
type Deps = Omit<TailDeps, 'roomClaude' | 'handoff' | 'admission' | 'invites'> & {
  roomClaude(): RoomClaudeLib;
  handoff(): HandoffLib;
  admission(): AdmissionLib;
  invites(): InvitesLib;
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
  code: RoomCode;
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
  me: Identity;
  room: TailRoom;
  entries: readonly Entry[];
  judge: Judge;
  joinNote(e: Entry): string;
  seen: Set<number>;
  leaveMs: number;
}
type Cursor = ReturnType<typeof cursorKeeper>;

const STATE_KINDS = new Set(['proposal', 'signoff', 'objection', 'decision']);
const isMove = (e: Entry) => e.kind === 'member_joined' || e.kind === 'member_left';

function timings() {
  const resolveMs = envMs('SUB_HUMAN_RESOLVE_MS');
  const settleMs = envMs('SUB_HUMAN_SETTLE_MS');
  const settleMaxMs = envMs('SUB_HUMAN_SETTLE_MAX_MS');
  return {
    resolveMs,
    unseatedMs: envMs('SUB_HUMAN_UNSEATED_MS', Math.max(resolveMs, config.UNSEATED_MS)),
    pollMs: envMs('SUB_HUMAN_POLL_MS'),
    settleMs,
    settleMaxMs,
    // The headless room Claude waits longer (nobody watches its latency), so a burst of answers, task requests or a
    // join lands as one turn, unless the member values are set explicitly.
    roomClaudeSettleMs: envStr('SUB_HUMAN_SETTLE_MS') ? settleMs : config.ROOM_CLAUDE_SETTLE_MS,
    roomClaudeSettleMaxMs: envStr('SUB_HUMAN_SETTLE_MAX_MS') ? settleMaxMs : config.ROOM_CLAUDE_SETTLE_MAX_MS,
    leaveMs: envMs('SUB_HUMAN_LEAVE_MS'),
    healthMs: envMs('SUB_HUMAN_TAIL_HEALTH_MS'),
    backoffMs: config.TAIL_BACKOFF_MS,
    backoffMaxMs: config.TAIL_BACKOFF_MAX_MS,
    errorLogMs: config.TAIL_ERROR_LOG_MS,
    stallMs: config.TAIL_STALL_MS,
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
  quietT: TimerHandle | null;
  maxT: TimerHandle | null;
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
function formatRoomClaudeBatch(ready: Item[], { me, room: rm, entries, judge, joinNote, leaveMs }: FormatCtx): string[] {
  const out: string[] = [];
  for (const { e, away } of ready) {
    const note = joinNote(e);
    if (judge(e, entries, note) === 'wake') out.push(rm.line(e, { full: true }) + (away ? ` · away ${Math.round(leaveMs / 1000)}s+` : '') + (note ? ` · ${note}` : ''));
  }
  return out.length ? [rm.stateLine(me, entries), ...out] : [];
}

/** The pull text: PULL_HEAD, then the newest lines that fit under PULL_CAP (a note says how many were left out), then
 * PULL_END (mod/core/constants.ts: the module carries it as context beside the person's next prompt). */
function pullText(lines: string[]): string | null {
  if (!lines.length) return null;
  const kept: string[] = [];
  let size = PULL_HEAD.length + PULL_END.length + 1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (size + lines[i].length + 1 > config.PULL_CAP - 80) break;
    kept.unshift(lines[i]);
    size += lines[i].length + 1;
  }
  const dropped = lines.length - kept.length;
  const more = dropped ? [pullDroppedLine(dropped)] : [];
  return [PULL_HEAD, ...more, ...kept, PULL_END].join('\n');
}

/**
 * One batch as the hooks module's events, in the order the mod applies them (chat, pull, wake).
 * ctx: {me, room, entries, show (the push lane, visibleTo), joinNote, seen, leaveMs}. moved: the join / leave ids
 * sent as chat (session.markShown).
 */
function formatNdBatch(ready: Item[], ctx: FormatCtx): { events: TailEvent[], moved: number[] } {
  const { me, room: rm, entries, judge, joinNote, seen } = ctx;
  const chat: string[] = [], pull: string[] = [], wake: string[] = [], moved: number[] = [], pushed: Item[] = [];
  let state = false;
  for (const p of ready) {
    const { e } = p;
    if (me.role !== 'claude' && isMove(e) && seen.has(e.id)) continue; // an earlier child already sent it
    const d = judge(e, entries, me.role === 'claude' ? joinNote(e) : undefined);
    if (d === 'none') continue;
    if (me.role === 'claude' && d === 'wake') { pushed.push(p); continue; }
    const lines = rm.chatLines(e, { viewer: me.name, entries });
    if (d === 'context') { pull.push(...lines); continue; }
    if (d === 'notice') {
      chat.push(...lines.filter(l => !l.startsWith(FOR_CLAUDE)));
      pull.push(...lines);
      if (isMove(e)) moved.push(e.id);
      continue;
    }
    wake.push(...lines);
    // a Claude's post addressed to me: answer that Claude, not the room (on another machine the post is how
    // its SendMessage arrived; mod/send.ts carries the reply back the same way)
    if (e.via === 'agent' && e.to === me.name && e.from && e.from !== me.name) {
      const who = e.from === 'claude' ? "the room's Claude" : `${e.from}'s Claude`;
      wake.push(`${FOR_CLAUDE} to answer ${who}: SendMessage ${e.from}.${me.code}`);
    }
    if (STATE_KINDS.has(e.kind)) state = true;
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
function missingRowsText(me: Identity, sid: string | null, {
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
function remindersText(me: Identity, rm: Pick<TailRoom, 'readView'>, { proposal = require('./proposal.ts') as ProposalLib }: { proposal?: ProposalLib } = {}): string | null {
  if (me.role === 'claude') return null;
  const es = rm.readView({ after: Infinity });
  const ps = proposal.pendingFor(me, es) || [];
  if (!ps.length) return null;
  // Only the one a review opens next (the person's pick, else the newest; hooks/handlers/consent.ts) is to be opened, the
  // others listed by short hash and title ("…, else the newest"), so the model is never told to open a proposal the
  // hooks will not show, and the person can name another.
  const p = proposal.picked(me, ps)!; // ps is not empty
  // A note of the person's waits on it (hooks/handlers/consent.ts): reopening the review would drop the note, so point at the
  // confirm card instead. Until its no-answer close was told or the card offered again (stage told or reoffered), the
  // prompt may also carry consent's reoffer: this line then says the same (showConfirm), never a softer "if asked"
  // beside it. A card shown (stage asked) and not yet offered again was interrupted (lib/consent/review.ts).
  const cf = proposal.readConfirm(me);
  if (cf && cf.hash === p.hash) {
    const stage = stageOf(cf);
    return stage === 'told' || stage === 'reoffered' ? `proposal ${p.hash}: ${me.name}'s note waits to be sent or discarded; if ${me.name} asks, ${proposal.confirmCall(p.hash)}. Don't reopen the review (that drops the note).`
      : `proposal ${p.hash}: ${me.name}'s note is not recorded yet. ${proposal.showConfirm(me.name, p.hash, stage === 'asked')} Don't reopen the review (that drops the note).`;
  }
  const entryOf = (hash: string) => es.find(e => e.kind === 'proposal' && e.hash === hash); // the title when no plan is stored
  return proposal.reminder(p, me.name, { code: me.code, others: ps.filter(x => x !== p).map(x => ({ ...x, entry: x.entry || entryOf(x.hash) })) });
}

// ---------- the link of a room hosted elsewhere ----------
const LINK_BACK = 'the connection to the room is back; @room posts go through again';
function linkLine(st: LinkStatus, code: RoomCode): { key: 'fork' | 'offline' | 'stopped', text: string } | null {
  const kept = st.queued ? `; ${st.queued} @room post(s) are kept, not sent` : '';
  if (st.state === 'fork') {
    return { key: 'fork', text: `this machine's copy of room ${code} no longer matches the host's${kept}. Run /sub-human doctor.` };
  }
  if (st.running && st.state !== 'offline') return null;
  if (st.running) return { key: 'offline', text: `the connection to room ${code} is down (${st.reason}); @room posts wait and go out when it's back, card answers can't be sent until then` };
  if (st.state === 'stopped') return { key: 'stopped', text: `the connection to room ${code} stopped (${st.reason || 'for good'}); @room posts can't be sent${kept}. Run /sub-human doctor.` };
  return { key: 'offline', text: `the connection to room ${code} isn't running; @room posts can't be sent${kept}. Type /sub-human to reconnect.` };
}
function flushLine(f: Flush | null | undefined): string | null {
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
    try { err(`sub-human tail: ${where} failed: ${msgOf(e) || String(e)}${more}; retrying\n`); } catch { /* stderr closed */ }
  };
}

// ---------- one seat's session ----------
/** Where a seat's delivery starts: its saved cursor, else (its first run) its latest join, so nothing between the
 * join and the first lookup is lost, else the log's end. */
function startCursor(rm: Pick<TailRoom, 'readView'>, saved: number, me: Identity, last: number): number {
  const c = saved;
  if (c > 0 && c <= last) return c;
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
function cursorKeeper(write: (id: number) => void, after: number, { log, dead }: { log: Log, dead: () => boolean }) {
  const inflight = new Set<number>();
  let processed = after, saved = after;
  return {
    saw(id: number) {
      if (id <= processed) { saved = 0; write(0); }
      processed = id;
    },
    hold: (id: number) => { inflight.add(id); },
    release: (id: number) => { inflight.delete(id); },
    save() {
      if (dead()) return;
      const h = inflight.size ? Math.min(...inflight) - 1 : processed;
      if (h <= saved) return;
      // the events are out, so a restart after a failed write would repeat them at most
      try { write(h); saved = h; } catch (e) { log('cursor save', e); }
    },
  };
}

/**
 * One settled batch as ONE write (at most one wake). Each entry is judged again against the log at flush time
 * (lane with entries: signed, decided, superseded); the cursor moves past the batch once it is written.
 */
function flushBatch(ready: Item[], { me, rm, judge, joinNote, leaveMs, session, emit, cursor }: {
  me: Identity, rm: TailRoom, judge: Judge, joinNote: (e: Entry) => string, leaveMs: number, session: SessionLib,
  emit: (events: TailEvent[], done?: () => void) => unknown, cursor: Cursor,
}): unknown {
  const entries = rm.readView({ after: ready[0].e.id - 1 });
  const done = () => { for (const p of ready) cursor.release(p.e.id); cursor.save(); };
  const seen = me.role === 'claude' || !rm.store ? new Set<number>() : session.shown(rm.store, me.name);
  const { events, moved } = formatNdBatch(ready, { me, room: rm, entries, judge, joinNote, leaveMs, seen });
  if (!events.length) return done();
  if (moved.length && rm.store) { try { session.markShown(rm.store, me.name, moved, 'mod'); } catch { /* best effort */ } }
  return emit(events, done);
}

/**
 * A self-rescheduling timer that survives its own errors, backing off while they repeat (s.dead ends it).
 * The poll loop stamps s.lastTick on every tick, for the stall check.
 */
function timerLoop({ clock, t, log, s }: { clock: Clock, t: Timings, log: Log, s: Pick<Session, 'dead' | 'lastTick'> }, where: string, fn: () => void, everyMs: number) {
  let fails = 0, timer: TimerHandle | null = null;
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

function startSession(me: Identity, ctx: Ctx): Session {
  const { clock, fs, write, log, t, deps, sid } = ctx;
  const { rows, session } = deps;
  const rm = deps.openRoom(me.code); // this session's room, held for its whole life (no re-binding)
  const emit = (events: TailEvent[], done: () => void = () => {}) => write(events.map(x => JSON.stringify(x)).join('\n') + '\n', done);
  // Where polling starts: taken before the backlog read, so nothing appended in between is missed (the
  // overlap is dropped by id).
  const tailer = rm.tailer({ fs });
  const last = rm.lastId();
  // the seat's delivery cursor: its session document's (lib/room/session.ts)
  const store = rm.store!; // a session's room always has its store (tests' fakes spread a real one)
  const saveCursor = (id: number) => session.put(store, me.name, 'cursor', id);
  const after = startCursor(rm, session.get(store, me.name, 'cursor') || 0, me, last);
  saveCursor(after);
  // its calls (save, stalled, moved, killPoll, stop) are filled in below, before the loop reads them
  const s = { key: `${me.code}/${me.name}/${me.role}`, code: me.code, dead: false, lastTick: clock.now() } as Session;
  const settleMs = me.role === 'claude' ? t.roomClaudeSettleMs : t.settleMs;
  const settleMaxMs = me.role === 'claude' ? t.roomClaudeSettleMaxMs : t.settleMaxMs;
  const cursor = cursorKeeper(saveCursor, after, { log, dead: () => s.dead });
  let seen = after;
  s.save = () => cursor.save();
  const judge: Judge = (e, entries, note) => rm.deliver(me, e, { entries, note });
  // member_joined: say whether that member's row already runs here, so only a missing one is spawned
  const joinNote = (e: Entry) => {
    if (e.kind !== 'member_joined') return '';
    try { return rows.joinNote(me, e.from); } catch { return ''; }
  };

  const flushCtx = { me, rm, judge, joinNote, leaveMs: t.leaveMs, session, emit, cursor };
  const onFlush = (ready: Item[]) => flushBatch(ready, flushCtx);
  const batch = new Batcher<Item>({ clock, settleMs, settleMaxMs, retryMs: t.backoffMs, onFlush, onError: e => log('flush', e) });

  const held = new Map<string, { e: Entry, timer: TimerHandle }>(); // name -> {e, timer}: member_left waiting leaveMs for a rejoin
  const settled = (e: Entry) => guard('leave hold', () => { held.delete(e.from); batch.enqueue({ e, away: true }); });
  const hold = (e: Entry) => ({ e, timer: clock.setTimeout(settled(e), t.leaveMs) });
  function onEntry(e: Entry): void {
    cursor.saw(e.id);
    if (e.kind === 'member_joined' && held.has(e.from)) {
      // left and back within leaveMs: neither notice is sent
      const h = held.get(e.from)!; // has() above
      clock.clearTimeout(h.timer);
      held.delete(e.from);
      cursor.release(h.e.id);
      return s.save();
    }
    // the entry-only answer (a superset of what the batch's judged one shows), a join as if its row were missing
    if (judge(e, undefined, e.kind === 'member_joined' ? 'no row running' : '') === 'none') return s.save();
    cursor.hold(e.id);
    if (e.kind === 'member_left') {
      const prev = held.get(e.from);
      if (prev) { clock.clearTimeout(prev.timer); held.delete(e.from); batch.enqueue({ e: prev.e, away: true }); }
      held.set(e.from, hold(e));
      return;
    }
    batch.enqueue({ e, away: false });
  }
  const deliver = (e: Entry) => { if (s.dead || !(e.id > seen)) return; seen = e.id; onEntry(e); };

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

  // Health: the hash chain from this process's checkpoint (one line per break), the link of a room hosted elsewhere
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
  let invitesKey: string | null = null;
  function handoffHealth() {
    const ho = deps.handoff();
    const store = rm.store!; // health() calls this only with a store
    if (!store.isHost) {
      const a = ho.pendingAsk(s.code, me.name, clock.now());
      if (!a || a.told_at) return;
      ho.markTold(s.code, a.id);
      // one wake: its line for the person is drawn as the prompt (asUser), the (for Claude) line rides as context
      emit([
        { type: 'wake', text: `room: ${a.from} asks you to host room ${s.code} on this machine; your Claude shows you a card\n${FOR_CLAUDE} ${a.from} asks ${me.name} to host room ${s.code} on this machine (the room's Claude would then run on ${me.name}'s model account, and this machine must stay reachable). Only ${me.name} can answer: call AskUserQuestion with the question "handoff ${a.id}"; the hooks show the card. Don't answer for ${me.name} or post about it.` },
      ]);
      return;
    }
    const d = ho.hostDoc(store);
    if (!d || d.from !== me.name) return;
    const state = d.state === 'asked' && !(Date.parse(d.expires_at) > clock.now()) ? 'expired' : d.state;
    const key = `${d.id}/${state}`;
    if (key === askKey || (state !== 'refused' && state !== 'expired')) return;
    askKey = key;
    emit([{ type: 'health', text: `room handoff: ${d.to} ${state === 'refused' ? 'declined to host' : 'did not answer the ask to host'} room ${s.code}; this machine stays the host` }]);
  }
  // An invite's join request (lib/remote/admission.ts), on the host: this seat's card, opened by its Claude once; a
  // request nobody answered lapses with a line.
  function admitHealth() {
    const adm = deps.admission();
    for (const q of adm.lapse(s.code, { now: clock.now() })) {
      emit([{ type: 'health', text: `room: ${adm.describe(q)} typed your invite and its PIN, but nobody let them in within ${Math.round((Date.parse(q.expires_at) - Date.parse(q.created_at)) / 60_000)} minutes; their join stopped` }]);
    }
    for (const q of adm.pending(s.code, { now: clock.now() })) {
      if ((q.told || []).includes(me.name) || !adm.targets(s.code, q).includes(me.name)) continue;
      adm.markTold(s.code, q.ref, me.name);
      // one wake (stage 8e G): its line for the person is drawn as the prompt (asUser, no frame), the (for Claude) line
      // rides as context, as every member wake (mod/core/deliver.ts wakeParts)
      emit([
        { type: 'wake', text: `room: ${adm.describe(q)} typed your invite and its PIN and wants to join; your Claude shows you a card (or: /sub-human admit ${q.ref})\n${FOR_CLAUDE} ${adm.describe(q)} typed ${me.name}'s invite line and its PIN on another machine and asks to join room ${s.code}. Only ${me.name} can let them in: call AskUserQuestion with the question "admit ${q.ref}"; the hooks show the card. Don't answer for ${me.name} or post about it.` },
      ]);
    }
  }
  // the room's open invite lines, said when the set changes (the module unpins one that is over)
  function inviteHealth() {
    const all = (rm.store!.kv.get('remote/invites', null) || {}) as Record<string, unknown>;
    const inv = deps.invites();
    const open = Object.entries(all).filter(([, i]) => inv.inviteOpen(i, clock.now())).map(([k]) => k.slice(0, 12)).sort();
    const key = open.join(',');
    if (key === invitesKey) return;
    invitesKey = key;
    emit([{ type: 'invites', open }]);
  }
  function health() {
    try { deps.heartbeat(me); } catch (e) { log('seat heartbeat', e); } // the seat's lease (identity.heartbeat)
    sendRows();
    if (s.moved()) return; // the room changed kind under this session: the next check starts it again
    if (rm.store && me.role !== 'claude') { try { handoffHealth(); } catch (e) { log('handoff', e); } }
    if (rm.store && rm.store.isHost && me.role !== 'claude') { try { admitHealth(); } catch (e) { log('admission', e); } }
    if (rm.store && rm.store.isHost && me.role !== 'claude') { try { inviteHealth(); } catch (e) { log('invites', e); } }
    if (rm.store && !rm.store.isHost) linkHealth();
    const r = rm.verifyChain(); // the active segment's new lines only, from this process's checkpoint
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
    // seats that ended with no leave (a dead pid, a lease run out) are logged as left, before the watchdog counts them
    if (rm.store && rm.store.isHost) { try { deps.sweepSeats(s.code); } catch (e) { log('seat sweep', e); } }
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
  lookup: () => Identity | null;
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
  const d: Deps = {
    openRoom: deps.openRoom || (() => { const r: typeof import('./room.ts') = require('./room.ts'); return (code: RoomCode) => r.open(code); })(),
    heartbeat: deps.heartbeat || ((me: Identity) => (require('./identity.ts') as typeof import('./identity.ts')).heartbeat(me)),
    rows: deps.rows || (require('./rows.ts') as RowsLib),
    session: deps.session || (require('./room/session.ts') as SessionLib),
    roomClaude: deps.roomClaude ? () => deps.roomClaude! : (() => { let o: RoomClaudeLib | undefined; return () => o || (o = require('./room-claude.ts') as RoomClaudeLib); })(),
    identity: deps.identity || (require('./identity.ts') as IdentityLib),
    proposal: deps.proposal || (require('./proposal.ts') as ProposalLib),
    linkStatus: deps.linkStatus || ((code: RoomCode) => (require('./remote/link-socket.ts') as typeof import('./remote/link-socket.ts')).status(code)),
    handoff: deps.handoff ? () => deps.handoff! : (() => { let m: HandoffLib | undefined; return () => m || (m = require('./handoff.ts') as HandoffLib); })(),
    admission: deps.admission ? () => deps.admission! : (() => { let m: AdmissionLib | undefined; return () => m || (m = require('./remote/admission.ts') as AdmissionLib); })(),
    invites: deps.invites ? () => deps.invites! : (() => { let m: InvitesLib | undefined; return () => m || (m = require('./remote/invites.ts') as InvitesLib); })(),
    sweepSeats: deps.sweepSeats || ((code: RoomCode) => (require('./seats.ts') as typeof import('./seats.ts')).sweep(code)),
    pendingNews: deps.pendingNews || ((s: string) => {
      // a cheap look first: the link files (most unseated tails have no pending join); the link code only when one is
      const links = require('./room/links.ts') as typeof import('./room/links.ts');
      if (!links.list().some(c => { const l = links.get(c); return !!l && l.join_sid === s; })) return null;
      return (require('./remote/joining.ts') as typeof import('./remote/joining.ts')).pendingNews(s);
    }),
  };
  const log = errorLog(err, clock, tm.errorLogMs);
  const ctx: Ctx = { clock, fs, write, log, t: tm, deps: d, sid };
  // say which seat is followed, when that changes
  let seatSent: string | undefined;
  const sendSeat = (me: Identity | null) => {
    const seat: TailSeat | null = me ? { name: me.name, code: me.code, role: me.role === 'claude' ? 'claude' : 'member', addr: `${me.name}.${me.code}` } : null;
    const key = JSON.stringify(seat);
    if (key === seatSent) return;
    seatSent = key;
    const ev: TailEvent = { type: 'seat', seat };
    try { write(JSON.stringify(ev) + '\n', () => {}); } catch (e) { log('seat event', e); }
  };
  let sess: Session | null = null, timer: TimerHandle | null = null, stopped = false;
  // an invite join this session started: what became of it, said once per state and text (waiting: look again soon);
  // once no join waits (its seat taken), the next join's news is new, even word for word the last one's (stage 8f item 2:
  // a re-invite after a kick let the machine in, and "the host let you in" was never said again)
  let told: string | null = null;
  const news = (): boolean => {
    if (!sid) return false;
    let n: ReturnType<TailDeps['pendingNews']> = null;
    try { n = d.pendingNews(sid); } catch (e) { log('pending join', e); return false; }
    if (!n) { told = null; return false; }
    if (n.state === 'waiting') return true;
    if (!n.text) return false; // the command's own answer said it
    const key = `${n.code}/${n.state}/${n.text}`; // a PIN asked for again (wrong, too soon) is news again
    if (key === told) return false;
    told = key;
    const ev: TailEvent = { type: 'chat', lines: [n.text] };
    try { write(JSON.stringify(ev) + '\n', () => {}); } catch (e) { log('pending join', e); }
    return false;
  };

  function stopSess() {
    if (!sess) return;
    const s = sess;
    sess = null;
    try { s.stop(); s.save(); } catch (e) { log('session stop', e); }
    s.dead = true;
  }

  function check() {
    if (stopped) return;
    let me: Identity | null = null, failed = false;
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
    const waiting = !failed && !me && !sess && news();
    // seated, yet a join of this session's waits (a kicked machine typing a new invite line: its copy of the room may
    // still show the seat, as a pipe link's did live): its news is said too (item 15)
    if (!failed && me && sid) news();
    if (!stopped) timer = clock.setTimeout(check, sess || me || waiting ? tm.resolveMs : tm.unseatedMs);
  }

  const stop = () => { stopped = true; clock.clearTimeout(timer); stopSess(); };
  check();
  if (maxSeconds != null) clock.setTimeout(stop, maxSeconds * 1000);
  return { stop, session: () => sess };
}

export {
  runTail, timings, Batcher, formatNdBatch, linkLine, flushLine, LINK_BACK, remindersText, PULL_HEAD, startCursor,
};
