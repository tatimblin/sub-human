/**
 * plugin/sub-human/lib/tail.ts: the room tail behind `sub-human tail` (scripts/sub-human), the hooks module's child
 * (mod/deliver.ts). Everything that waits goes through an injected clock (lib/clock.ts), so tests drive it with
 * clock.createFake() in-process.
 *
 * runTail looks the seat up (every unseatedMs, then resolveMs once seated), follows that room's log from the
 * seat's cursor (its session document, lib/room/session.ts; first run: from its join), batches what the seat sees
 * and writes one JSON event per line, which the mod routes. It never stops on an error: every timer callback is
 * guarded (log to err, rate-limited, back off, carry on); only stop() / maxSeconds end it. A seated session whose
 * poll loop has not ticked for stallMs is restarted, and one whose room changed kind (a mirror that became the
 * host, or the reverse) is started again over the new store. A session never re-reads the log from byte 0:
 * backlog from room.readView({after: cursor}), live entries from room.tailer(). The health tick also renews the
 * seat's lease (identity.heartbeat). Batcher sends items as ONE batch after settleMs of quiet or settleMaxMs after
 * the first; a batch whose onFlush throws goes back and is retried after retryMs.
 *
 * Each entry goes as lib/room/deliver.ts classes it for this seat (notice: chat; context: pull; wake: wake). Events:
 *   {type:'seat', seat: {name, code, role, addr} | null}   the seat it follows (null: none any more)
 *   {type:'chat', lines}      a member's group chat: people's words, joins and leaves (the person sees them; no wake)
 *   {type:'pull', text}       for Claude, no wake: the pull lane plus a copy of the chat lines, under the room
 *                             context's head and end (PULL_CAP); the module holds it for the person's next prompt.
 *                             At most once: the cursor moves when the line is written
 *   {type:'wake', text}       what needs Claude now: to me / @me, a proposal for me, a decision on mine, a task
 *                             assigned to me, an objection to my proposal (members, with the room state line when
 *                             the batch moved a proposal); the room Claude's whole push block
 *   {type:'rows', text|null}  what the person's next prompt carries for Claude: pending-proposal reminders
 *                             (members) and the missing rows' Agent calls; sent at start and when it changes
 *   {type:'health', text}     a hash-chain break (one line per break); in a room hosted elsewhere linkLine each time
 *                             the link goes off and LINK_BACK once it is online again (one quiet line, no
 *                             "left"/"joined": the daemon renews the seat's lapsed lease)
 *   {type:'invites', open, expired?}   on the host, the refs of the open invite lines when the set changes (the module
 *                             takes an invite off its status line once it is used, burnt, cancelled or expired), and
 *                             the ones that just lapsed unused (the module tells the person who made it)
 *   {type:'take', code, name, text, check?}   a seatless session's invite join the host let in (lib/remote/joining.ts
 *                             pendingNews 'linked'), once: the module takes the seat in a new turn (mod/deliver.ts
 *                             takeSeat); text is what the person reads when it cannot (type /sub-human), check this
 *                             machine's join check, which the host's room line shows too
 * An invite's join request (lib/remote/admission.ts, on the host) is one wake, once per seat; a lapsed request is
 * a health line. A session with no seat that started an invite join (its link file's join_sid) is looked up every
 * resolveMs until the host lets it in, with one chat line per answer (a seated session too: a kicked machine's copy
 * may still show its seat).
 */

import nodeFs from 'node:fs';
import * as realClock from './clock.ts';
import * as config from './config.ts';
import { envMs, envStr } from './env.ts';
import { stageOf } from './consent/review.ts';
import { lazy } from './io.ts';
import * as rowsMod from './rows.ts';
import * as identityMod from './identity.ts';
import * as proposalMod from './proposal.ts';
import * as sessionMod from './room/session.ts';
import * as roomMod from './room.ts';
import * as linksMod from './room/links.ts';
import { announced } from './room/render.ts';
import { isObj } from './decode.ts';
import type { TailEvent, TailSeat } from './types-app.ts';
import type { LinkStatus } from './remote/link-socket.ts';
import type { Flush } from './remote/types-core.ts';
import type { Clock, TimerHandle } from './clock.ts';
import type { Delivery, Entry } from './room/types.ts';
import type { Identity } from './identity.ts';
import type { Room } from './room.ts';
import { FOR_CLAUDE, PULL_HEAD, pullDroppedLine } from '../mod/core/constants.ts';
import { msgOf } from './errors.ts';
import type { RoomCode } from './brand.ts';
import type * as RoomClaudeMod from './room-claude.ts';
import type * as AdmissionMod from './remote/admission.ts';
import type * as InvitesMod from './remote/invites.ts';
import type * as LinkSocketMod from './remote/link-socket.ts';
import type * as SeatsMod from './seats.ts';
import type * as TasksMod from './tasks.ts';
import type * as JoiningMod from './remote/joining.ts';

// The tail starts with every session: what only a room's Claude, a host or a pending join reads loads at
// its first use (start cost).
const roomClaudeLib = lazy<typeof RoomClaudeMod>(import.meta.url, './room-claude.ts');
const linkSocketLib = lazy<typeof LinkSocketMod>(import.meta.url, './remote/link-socket.ts');
const admissionLib = lazy<typeof AdmissionMod>(import.meta.url, './remote/admission.ts');
const invitesLib = lazy<typeof InvitesMod>(import.meta.url, './remote/invites.ts');
const seatsLib = lazy<typeof SeatsMod>(import.meta.url, './seats.ts');
const tasksLib = lazy<typeof TasksMod>(import.meta.url, './tasks.ts');
const joiningLib = lazy<typeof JoiningMod>(import.meta.url, './remote/joining.ts');

// ---------- types ----------
/** The room as a session reads it (lib/room.ts open): the calls made here. Tests hand in fakes. */
type TailRoom = Pick<Room, 'readView' | 'tailer' | 'lastId' | 'getCursor' | 'verifyChain' | 'deliver' | 'chatLines' | 'line' | 'stateLine'>
  & { store?: Room['store'] | null };
/** What an entry is for this seat (lib/room/deliver.ts): entries is the log at flush time; note is the joinNote of a member_joined. */
type Judge = (e: Entry, entries?: readonly Readonly<Entry>[], note?: string) => Delivery;
/** A rate-limited logger (errorLog): where it failed, and the error. */
type Log = (where: string, e: unknown) => void;
/** The tail's write: text (whole lines) and a callback once it is out. */
type Write = (text: string, done: () => void) => unknown;
/** The tail's timings (timings()): each from its SUB_HUMAN_* override, else lib/config.ts. */
interface Timings {
  resolveMs: number;
  unseatedMs: number;
  pollMs: number;
  settleMs: number;
  settleMaxMs: number;
  roomClaudeSettleMs: number;
  roomClaudeSettleMaxMs: number;
  leaveMs: number;
  healthMs: number;
  backoffMs: number;
  backoffMaxMs: number;
  errorLogMs: number;
  stallMs: number;
}
/** One item the Batcher holds: the entry, and when it was enqueued. */
interface Item { e: Entry, away: boolean }
type Pending<T> = T & { at: number };

type RowsLib = Pick<typeof rowsMod, 'joinNote' | 'missingRows' | 'rowsNeeded' | 'readHolds' | 'sessionRowMap' | 'rowCalls'>;
type IdentityLib = Pick<typeof identityMod, 'readMembers' | 'heartbeat'>;
type ProposalLib = Pick<typeof proposalMod, 'pendingFor' | 'picked' | 'reminder' | 'readConfirm' | 'confirmCall' | 'showConfirm'>;
type SessionLib = Pick<typeof sessionMod, 'shown' | 'markShown' | 'get' | 'put'> & Partial<Pick<typeof sessionMod, 'reported'>>;
type RoomClaudeLib = Pick<typeof RoomClaudeMod, 'watchdog'>;
type AdmissionLib = Pick<typeof AdmissionMod, 'lapse' | 'pending' | 'targets' | 'describe' | 'markTold'>;
type InvitesLib = Pick<typeof InvitesMod, 'inviteOpen'>;
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
  admission: AdmissionLib;
  invites: InvitesLib;
  sweepSeats(code: RoomCode): unknown;
  /** the room session's task files, projected from the log again (lib/tasks.ts repair; on the host: the room session's
   * tail, and a member's while roomSessionDown) */
  repairTasks(code: RoomCode): unknown;
  /** the room session's task list was made (members.claude.tasks_dir) but the session does not hold its seat now (it
   * never bound, crashed or is starting again), and the room is not closing: a member's tail on the host repairs it */
  roomSessionDown(code: RoomCode): boolean;
  pendingNews(sid: string): { state: 'waiting' | 'pin' | 'linked' | 'refused'; code: RoomCode; text: string; name?: string; line?: string; check?: string } | null;
}
/** The deps as a session uses them: the lazily loaded modules behind a getter. */
type Deps = Omit<TailDeps, 'roomClaude' | 'admission' | 'invites'> & {
  roomClaude(): RoomClaudeLib;
  admission(): AdmissionLib;
  invites(): InvitesLib;
};
/** What every session shares (runTail). */
interface TailCtx {
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
  killPoll(): void;
  stop(): void;
}
/** formatNdBatch / formatRoomClaudeBatch's ctx. */
interface FormatCtx {
  me: Identity;
  room: TailRoom;
  entries: readonly Readonly<Entry>[];
  judge: Judge;
  joinNote(e: Entry): string;
  seen: Set<number>;
  leaveMs: number;
  /** ids the consent hook already told the model of (lib/room/session.ts reported): no room-context copy */
  reported?: ReadonlySet<number>;
  /** the peers whose "to answer X's Claude" hint this session's model was given already (once per peer) */
  hinted?: Set<string>;
}
/** A seat's read cursor (cursorKeeper): saw each id, hold and release the ones in flight, save the highest done. */
interface Cursor {
  saw(id: number): void;
  hold(id: number): void;
  release(id: number): void;
  save(): void;
}

const STATE_KINDS = new Set(['proposal', 'signoff', 'objection', 'decision']);
/** An invite record that lapsed unused: past its expiry, never used or cancelled, tries left. */
const lapsed = (r: unknown, now: number): boolean => isObj(r) && !r.used_at && !r.burnt_at && typeof r.expires_at === 'string'
  && now > Date.parse(r.expires_at) && Number(r.tries) > 0;
/** A request addressed to its own asker, its one approver: the author's check (lib/room/consent.ts draft). */
const isDraft = (e: Entry): boolean => e.to === e.from && Array.isArray(e.approvers) && e.approvers.length === 1 && e.approvers[0] === e.from;
/** A plan version's summary from its first chat line ("bob's Claude: plan NAME vN: SUMMARY", made safe by chatLines), or ''. */
const summaryOf = (first: string | undefined): string => (/^[^:]*: plan \S+ v\d+: (.*)$/.exec(first ?? '')?.[1] ?? '');
const isMove = (e: Entry) => e.kind === 'member_joined' || e.kind === 'member_left';

function timings(): Timings {
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
  enqueue(item: T): void { this.pending.push({ ...item, at: this.clock.now() }); this.arm(); }
  arm(): void {
    if (this.dead) return;
    this.clock.clearTimeout(this.quietT);
    this.quietT = this.clock.setTimeout(() => this.flush(), this.settleMs);
    this.maxT ??= this.clock.setTimeout(() => this.flush(), this.settleMaxMs);
  }
  clear(): void { this.clock.clearTimeout(this.quietT); this.clock.clearTimeout(this.maxT); this.quietT = this.maxT = null; }
  flush(): void {
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
  stop(): void { this.dead = true; this.clear(); }
}

// ---------- formatters ----------
/** The room session's block (its rows-only turn): one full line per join that wakes it, with its row note. */
function formatRoomClaudeBatch(ready: Item[], { room: rm, entries, judge, joinNote, leaveMs }: FormatCtx): string[] {
  const out: string[] = [];
  for (const { e, away } of ready) {
    const note = joinNote(e);
    if (judge(e, entries, note) === 'wake') out.push(rm.line(e, { full: true }) + (away ? ` · away ${Math.round(leaveMs / 1000)}s+` : '') + (note ? ` · ${note}` : ''));
  }
  return out.length ? [...out, 'Make only the call its row note names, then end your turn with the one word "ok".'] : [];
}

/** The pull text: PULL_HEAD, then the newest lines that fit under PULL_CAP (a note says how many were left out)
 * (mod/core/constants.ts: the module carries it as context beside the person's next prompt). */
function pullText(lines: string[]): string | null {
  if (!lines.length) return null;
  const kept: string[] = [];
  let size = PULL_HEAD.length + 1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l === undefined || size + l.length + 1 > config.PULL_CAP - 80) break; // i < lines.length
    kept.unshift(l);
    size += l.length + 1;
  }
  const dropped = lines.length - kept.length;
  const more = dropped ? [pullDroppedLine(dropped)] : [];
  return [PULL_HEAD, ...more, ...kept].join('\n');
}

/**
 * One batch as the hooks module's events, in the order the mod applies them (chat, pull, wake). moved: the join /
 * leave ids sent as chat (session.markShown).
 */
function formatNdBatch(ready: Item[], ctx: FormatCtx): { events: TailEvent[], moved: number[] } {
  const { me, room: rm, entries, judge, joinNote, seen, reported, hinted } = ctx;
  const chat: string[] = [], pull: string[] = [], wake: string[] = [], moved: number[] = [], pushed: Item[] = [];
  let state = false;
  // a plan version and the sign-off request on it in one batch: one line, the request's, with the version's summary
  const asked = new Set(ready.filter(({ e }) => e.kind === 'proposal' && e.hash && e.plan && !isDraft(e)).map(({ e }) => e.hash));
  const folded = new Map<string, string>(); // hash -> the version's summary
  for (const p of ready) {
    const { e } = p;
    if (me.role !== 'claude' && isMove(e) && seen.has(e.id)) continue; // an earlier child already sent it
    const d = judge(e, entries, me.role === 'claude' ? joinNote(e) : undefined);
    if (d === 'none') continue;
    if (me.role === 'claude' && d === 'wake') { pushed.push(p); continue; }
    // a join the room's PIN line already announced (its check and the kick): no second, bare "joined"
    if (d === 'notice' && announced(e, entries)) { moved.push(e.id); continue; }
    if (d === 'notice' && e.kind === 'plan' && e.hash && asked.has(e.hash)) { folded.set(e.hash, summaryOf(rm.chatLines(e, { viewer: me.name, entries })[0])); continue; }
    const lines = rm.chatLines(e, { viewer: me.name, entries });
    const summary = e.kind === 'proposal' && e.hash ? folded.get(e.hash) : undefined;
    if (summary && lines[0] !== undefined) lines[0] += `: ${summary}`;
    // what the consent hook already told the model (the decision its answer made): the person's notice only
    const told = !!reported && reported.has(e.id);
    if (d === 'context') { if (!told) pull.push(...lines); continue; }
    if (d === 'notice') {
      // a task suggested to me: say so (the line names no suggestion); I claim it myself if I take it
      if (e.kind === 'task' && e.suggest === me.name && !e.owner && lines[0] !== undefined) lines[0] += ', suggested for you (claim it to take it)';
      chat.push(...lines.filter(l => !l.startsWith(FOR_CLAUDE)));
      if (!told) pull.push(...lines);
      if (isMove(e)) moved.push(e.id);
      continue;
    }
    wake.push(...lines);
    // a Claude's post addressed to me: answer that Claude, not the room (on another machine the post is how
    // its SendMessage arrived; mod/send.ts carries the reply back the same way)
    if (e.via === 'agent' && e.to === me.name && e.from && e.from !== me.name && !(hinted && hinted.has(e.from))) {
      const who = e.from === 'claude' ? "the room's Claude" : `${e.from}'s Claude`;
      wake.push(`${FOR_CLAUDE} to answer ${who}: SendMessage ${e.from}.${me.code}`);
      if (hinted) hinted.add(e.from); // once per peer per session
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
  now = Date.now(), rows = rowsMod, identity = identityMod,
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
function remindersText(me: Identity, rm: Pick<TailRoom, 'readView'>, { proposal = proposalMod }: { proposal?: ProposalLib } = {}): string | null {
  if (me.role === 'claude') return null;
  const es = rm.readView({ after: Infinity });
  const ps = proposal.pendingFor(me, es) || [];
  if (!ps.length) return null;
  // Only the one a review opens next (the plan the person names, else the oldest; hooks/consent.ts) is to be opened,
  // the others listed by short hash and title ("…, else the oldest"), so the model is never told to open a request
  // the hooks will not show, and the person can name another.
  // a note of the person's waiting on one of them comes first (its card decides what the room gets)
  const cf = proposal.readConfirm(me);
  const p = (cf && ps.find(x => x.hash === cf.hash)) || proposal.picked(ps);
  if (!p) return null; // ps is not empty: never
  // A note of the person's waits on it (hooks/consent.ts): reopening the review would drop the note, so point at the
  // confirm card instead. Until its no-answer close was told or the card offered again (stage told or reoffered), the
  // prompt may also carry consent's reoffer: this line then says the same (showConfirm), never a softer "if asked"
  // beside it. A card shown (stage asked) and not yet offered again was interrupted (lib/consent/review.ts).
  if (cf && cf.hash === p.hash) {
    const stage = stageOf(cf);
    return stage === 'told' || stage === 'reoffered' ? `proposal ${p.hash}: ${me.name}'s note waits to be sent or discarded; if ${me.name} asks, ${proposal.confirmCall(p.hash)}. Don't reopen the review (that drops the note).`
      : `proposal ${p.hash}: ${me.name}'s note is not recorded yet. ${proposal.showConfirm(me.name, p.hash, stage === 'asked')} Don't reopen the review (that drops the note).`;
  }
  const entryOf = (hash: string) => es.find(e => e.kind === 'proposal' && e.hash === hash); // the title when no plan is stored
  return proposal.reminder(p, me.name, { code: me.code, others: ps.filter(x => x !== p).map(x => ({ ...x, entry: x.entry ?? entryOf(x.hash) })) });
}

// ---------- the link of a room hosted elsewhere ----------
const LINK_BACK = 'the connection to the room is back; @room posts go through again';
/** The one line for a room link that is not online (lib/remote/link.ts status; words: lib/room/link-state.ts STATES):
 * 'fork' (the mirror no longer matches the host's log; queued posts kept, not sent), 'stopped' (for good), 'offline';
 * null while online or connecting. */
function linkLine(st: LinkStatus, code: RoomCode): { key: 'fork' | 'offline' | 'stopped', text: string } | null {
  const kept = st.queued ? `; ${st.queued} @room post(s) are kept, not sent` : '';
  if (st.state === 'fork') {
    return { key: 'fork', text: `this machine's copy of room ${code} no longer matches the host's${kept}. Run /sub-human doctor.` };
  }
  if (st.running && st.state !== 'offline') return null;
  if (st.running) return { key: 'offline', text: `the connection to room ${code} is down (${st.reason}); @room posts wait and go out when it's back, card answers can't be sent until then` };
  if (st.state === 'stopped') return { key: 'stopped', text: `the connection to room ${code} stopped (${st.reason || 'for good'}); @room posts can't be sent${kept}. Run /sub-human doctor.` };
  return { key: 'offline', text: `the connection to room ${code} isn't running${st.queued ? `; ${st.queued} @room post(s) wait` : ''}. Type /sub-human (or post with @room) to start it again.` };
}
/** What became of the @room posts queued while the link was down (the daemon's `link` flush). */
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
function cursorKeeper(write: (id: number) => void, after: number, { log, dead }: { log: Log, dead: () => boolean }): Cursor {
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
function flushBatch(ready: Item[], { me, rm, judge, joinNote, leaveMs, session, emit, cursor, hinted }: {
  me: Identity, rm: TailRoom, judge: Judge, joinNote: (e: Entry) => string, leaveMs: number, session: SessionLib,
  emit: (events: TailEvent[], done?: () => void) => unknown, cursor: Cursor, hinted: Set<string>,
}): unknown {
  const [head] = ready;
  if (!head) return undefined; // the batcher flushes a batch that is not empty
  const entries = rm.readView({ after: head.e.id - 1 });
  const done = () => { for (const p of ready) cursor.release(p.e.id); cursor.save(); };
  const seen = me.role === 'claude' || !rm.store ? new Set<number>() : session.shown(rm.store, me.name);
  let reported: ReadonlySet<number> = new Set();
  if (me.role !== 'claude' && rm.store && session.reported) { try { reported = session.reported(rm.store, me.name); } catch { /* none */ } }
  const { events, moved } = formatNdBatch(ready, { me, room: rm, entries, judge, joinNote, leaveMs, seen, reported, hinted });
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

function startSession(me: Identity, ctx: TailCtx): Session {
  const { clock, fs, write, log, t, deps, sid } = ctx;
  const { rows, session } = deps;
  const rm = deps.openRoom(me.code); // this session's room, held for its whole life (no re-binding)
  const emit = (events: TailEvent[], done: () => void = () => {}) => write(events.map(x => JSON.stringify(x)).join('\n') + '\n', done);
  // Where polling starts: taken before the backlog read, so nothing appended in between is missed (the
  // overlap is dropped by id).
  const tailer = rm.tailer({ fs });
  const last = rm.lastId();
  // the seat's delivery cursor: its session document's (lib/room/session.ts)
  const store = rm.store;
  if (!store) throw new TypeError(`room ${me.code} has no store`); // never: a session's room always has its store (tests' fakes spread a real one)
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

  const flushCtx = { me, rm, judge, joinNote, leaveMs: t.leaveMs, session, emit, cursor, hinted: new Set<string>() };
  const onFlush = (ready: Item[]) => flushBatch(ready, flushCtx);
  const batch = new Batcher<Item>({ clock, settleMs, settleMaxMs, retryMs: t.backoffMs, onFlush, onError: e => log('flush', e) });

  const held = new Map<string, { e: Entry, timer: TimerHandle }>(); // name -> {e, timer}: member_left waiting leaveMs for a rejoin
  const settled = (e: Entry) => guard('leave hold', () => { held.delete(e.from); batch.enqueue({ e, away: true }); });
  const hold = (e: Entry) => ({ e, timer: clock.setTimeout(settled(e), t.leaveMs) });
  function onEntry(e: Entry): void {
    cursor.saw(e.id);
    const h = e.kind === 'member_joined' ? held.get(e.from) : undefined;
    if (h) {
      // left and back within leaveMs: neither notice is sent
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
    const f = st.flush ?? null, fresh = flushKey !== undefined && f && f.at !== flushKey;
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
  let invitesKey: string | null = null;
  // An invite's join request (lib/remote/admission.ts), on the host: this seat's card, opened by its Claude once; a
  // request nobody answered lapses with a line.
  function admitHealth() {
    const adm = deps.admission();
    for (const q of adm.lapse(s.code, { now: clock.now() })) {
      emit([{ type: 'health', text: `room: ${adm.describe(q)} typed your invite line without its PIN, but nobody let them in within ${Math.round((Date.parse(q.expires_at) - Date.parse(q.created_at)) / 60_000)} minutes; their join stopped` }]);
    }
    for (const q of adm.pending(s.code, { now: clock.now() })) {
      if ((q.told ?? []).includes(me.name) || !adm.targets(s.code, q).includes(me.name)) continue;
      adm.markTold(s.code, { ref: q.ref, name: me.name });
      // one wake: its line for the person is drawn as the prompt (asUser, no frame), the (for Claude) line
      // rides as context, as every member wake (mod/core/deliver.ts wakeParts)
      emit([
        { type: 'wake', text: `room: ${adm.describe(q)} typed your invite line without its PIN and asks to join; your Claude shows you a card (or: /sub-human admit ${q.ref})\n${FOR_CLAUDE} ${adm.describe(q)} typed ${me.name}'s invite line without its PIN on another machine and asks to join room ${s.code}. Only ${me.name} can let them in: call AskUserQuestion with the question "admit ${q.ref}"; the hooks show the card. Don't answer for ${me.name} or post about it.` },
      ]);
    }
  }
  // the room's open invite lines, said when the set changes (the module unpins one that is over)
  function inviteHealth(store: NonNullable<TailRoom['store']>) {
    const all = store.kv.get<Record<string, unknown>>('remote/invites', null) ?? {};
    const inv = deps.invites();
    const now = clock.now();
    const open = Object.entries(all).filter(([, i]) => inv.inviteOpen(i, now)).map(([k]) => k.slice(0, 12)).sort();
    const key = open.join(',');
    if (key === invitesKey) return;
    // the ones open before that lapsed unused (not used, cancelled or out of tries): the module tells their maker
    const was = invitesKey ? invitesKey.split(',') : [];
    const expired = Object.entries(all).filter(([k, i]) => was.includes(k.slice(0, 12)) && lapsed(i, now)).map(([k]) => k.slice(0, 12));
    invitesKey = key;
    emit([{ type: 'invites', open, ...(expired.length ? { expired } : {}) }]);
  }
  function health() {
    try { deps.heartbeat(me); } catch (e) { log('seat heartbeat', e); } // the seat's lease (identity.heartbeat)
    sendRows();
    if (rm.store && rm.store.isHost && me.role !== 'claude') { try { admitHealth(); } catch (e) { log('admission', e); } }
    if (rm.store && rm.store.isHost && me.role !== 'claude') { try { inviteHealth(rm.store); } catch (e) { log('invites', e); } }
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
    // the task files never depend on the room session alone: while it is down, a member's tail on the host repairs them
    // (more than one may: repair runs under the room's tasks lock, so they take turns)
    if (rm.store && rm.store.isHost && (me.role === 'claude' || deps.roomSessionDown(s.code))) {
      try { deps.repairTasks(s.code); } catch (e) { log('task files', e); }
    }
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
/** A dep the caller gave, as the getter a lazily loaded one is. */
const constant = <M>(given: M): (() => M) => () => given;
function runTail({
  clock = realClock, write, err = s => process.stderr.write(s), lookup, timings: tm = timings(), fs = nodeFs,
  deps = {}, maxSeconds = null, sid = null,
}: TailOpts): { stop(): void, session(): Session | null } {
  const d: Deps = {
    openRoom: deps.openRoom ?? ((code: RoomCode) => roomMod.open(code)),
    heartbeat: deps.heartbeat ?? ((me: Identity) => identityMod.heartbeat(me)),
    rows: deps.rows ?? rowsMod,
    session: deps.session ?? sessionMod,
    roomClaude: deps.roomClaude ? constant(deps.roomClaude) : roomClaudeLib,
    identity: deps.identity ?? identityMod,
    proposal: deps.proposal ?? proposalMod,
    linkStatus: deps.linkStatus ?? ((code: RoomCode) => linkSocketLib().status(code)),
    admission: deps.admission ? constant(deps.admission) : admissionLib,
    invites: deps.invites ? constant(deps.invites) : invitesLib,
    sweepSeats: deps.sweepSeats ?? ((code: RoomCode) => seatsLib().sweep(code)),
    repairTasks: deps.repairTasks ?? ((code: RoomCode) => tasksLib().repair(roomMod.open(code).store)),
    roomSessionDown: deps.roomSessionDown ?? ((code: RoomCode) => {
      const o = identityMod.readMembers(code).claude;
      return !!o && !!o.tasks_dir && !o.closing && !o.stopped_at && !identityMod.seatAlive(o);
    }),
    pendingNews: deps.pendingNews ?? ((s: string) => {
      // a cheap look first: the link files (most unseated tails have no pending join); the link code only when one is
      if (!linksMod.list().some(c => { const l = linksMod.get(c); return !!l && l.join_sid === s; })) return null;
      return joiningLib().pendingNews(s);
    }),
  };
  const log = errorLog(err, clock, tm.errorLogMs);
  const ctx: TailCtx = { clock, fs, write, log, t: tm, deps: d, sid };
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
  // once no join waits (its seat taken), the next join's news is new, even word for word the last one's (a re-invite
  // after a kick). Let in, with no seat here: one take event, whether the command's own answer said it (join_told) or
  // not; the module takes the seat in a turn of its own, never the prompt that carried the line or the PIN
  let told: string | null = null;
  const news = (seated: boolean): boolean => {
    if (!sid) return false;
    let n: ReturnType<TailDeps['pendingNews']> = null;
    try { n = d.pendingNews(sid); } catch (e) { log('pending join', e); return false; }
    if (!n) { told = null; return false; }
    if (n.state === 'waiting') return true;
    const take = n.state === 'linked' && !seated;
    if (!take && !n.text) return false; // the command's own answer said it
    const key = take ? `${n.code}/take` : `${n.code}/${n.state}/${n.text}`; // a PIN asked for again (wrong, too soon) is news again
    if (key === told) return take; // taking: look again soon, for the seat
    told = key;
    const ev: TailEvent = take
      ? { type: 'take', code: n.code, name: n.name ?? '', text: n.line ?? n.text, ...(n.check ? { check: n.check } : {}) }
      : { type: 'chat', lines: [n.text] };
    try { write(JSON.stringify(ev) + '\n', () => {}); } catch (e) { log('pending join', e); }
    return take;
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
      if (!(sess && sess.key === key)) {
        stopSess();
        if (me) { try { sess = startSession(me, ctx); } catch (e) { log('session start', e); } }
        sendSeat(sess ? me : null);
      }
    }
    const waiting = !failed && !me && !sess && news(false);
    // seated, yet a join of this session's waits (a kicked machine typing a new invite line: its copy of the room may
    // still show the seat): its news is said too, as chat (no take: the seat here is the person's to leave)
    if (!failed && me && sid) news(true);
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
