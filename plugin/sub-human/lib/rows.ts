/**
 * plugin/sub-human/lib/rows.ts: participant rows in the agent panel.
 * Reads the room log, members and presence; writes only the rows/* documents (lib/room/store.ts kv) and the holds and
 * blocks of a seat's session document (lib/room/session.ts).
 *
 * Spawning (text for the model; join.ts, session-restore.ts and the role text append it, never hand-copy):
 *   rowCalls(me, members, {only}?) -> string
 *       me = {code, name, role}; members = readMembers(code) (object by name) or an array of {name, role, left_at?}.
 *       claude:   one background sub-human:participant per active member, labelled by the member's name,
 *               prompt "member: NAME".
 *       member: one background sub-human:room, labelled by the room code, prompt "room: CODE\nmembers: a, b"
 *               (the other active members except the room's Claude and me). The room agent spawns those children.
 *       only = rowsNeeded(...) limits the calls to the rows that are missing; only = [] says the rows are intact
 *       and lists no calls (a second spawn would duplicate a row).
 *   joinNote(me, name, {held}?) -> "row: …" suffix for a member_joined notice (scripts/sub-human tail): running (no
 *       call) or the call to make. For a member it is about the ROOM row (which adds NAME by itself), so a join
 *       never invites a room-row call while that row is live; row-guard.ts stays the backstop.
 *   rowsNeeded(code, me, {members, held}) -> names (claude) or [code] (member): rows with no live hold in `held`
 *       (= readHolds(code, me.name), null = nothing held). No grace period: used by join / restore.
 * Lifecycle: a row lives as long as its viewer is in the room. A participant row does NOT end when its member
 *   leaves; it reads "left" and comes back to life on rejoin (mcp/hold.ts keeps holding). One live hold per
 *   (viewer, kind, name): hold.ts refuses a second with "STOP: duplicate row", and hooks/handlers/row-guard.ts
 *   (PreToolUse Agent) denies the spawn itself when the row's hold is already live, so no dead copy appears.
 *   participantCall(name), roomCall(code, names)   the single Agent call lines
 *
 * Row text (deterministic from the log + members + the presence/<name> documents {state, at}):
 *   rowText(code, {member?, viewer?, color, entries, members, now}?) -> string (<= ROW_MAX chars, no label): member's
 *       participant row, or with no member the room row
 *       No entry ids (people never see them); task ids ("#2") are the room task list's numbers.
 *       Proposals: lib/room/consent.ts fold (the same state stateLine and the consent gate read). A proposal is named
 *       by its title (the stored plan's first line, clipped to ROW_TITLE_MAX; the 6-char hash when there is
 *       none): rows are for people, and no tool call is made from them. Segments that do not fit are dropped.
 *       name === code (or null): the member's room row, from viewer's seat: first a join / settled leave of the
 *         last 2 min ("+bob joined", "−bob left (connection lost)"; lib/room/render.ts rowSegment), then "⚠ your answer needed Cursor paging",
 *         "✓ agreed Cursor paging 1/2", "✖ objected", "✔ decided Cursor paging" ("✖ blocked …" when someone objected),
 *         "proposal Cursor paging 0/2", else "N here";
 *         then "✉ N for you", then lib/tasks.ts summary(code, viewer) ("tasks 3 open · #2 you · #4 bob").
 *         A room hosted elsewhere adds its link (lib/room/link-state.ts indicator, in its one vocabulary STATES):
 *         first while it is offline, stopped, a fork or connecting again ("✕ offline 2m · 2 queued", "… connecting
 *         (3)"), last while it is online ("⇄ online").
 *       otherwise: NAME's state as viewer sees it: "✓ agreed Cursor paging", "✖ objected", "⚠ reviewing …",
 *         "✔ decided …" (after it, their latest status: "Claude status: handler done"), then their
 *         open task on the room list ("◼ #2 parser tests"), presence, mail; "left".
 *   rowLine(label, text) -> "label  text"   what a row shows (the row content replaces the whole label)
 *
 * Agent -> row map (the room documents rows/<session_id> = {byAgent: {agentId: {kind, name, parent, at}}}):
 *   parseSpawn(toolInput, members, code) -> {kind: 'participant'|'room', name}|null
 *   recordRow(code, sessionId, agentId, rec), forgetRow(code, agentId), readRowMap(code) -> {agentId: rec}
 *       readRowMap merges every session's map in the room: /clear changes session_id, agent ids don't.
 *       sessionRowMap(code, sid) -> one session's; blockCount(code, {seat, agent}) / setBlockCount(code, {seat, agent}, n):
 *       row-hold.ts (the seat's session document's blocks)
 *   Hold liveness (written by mcp/hold.ts): writeHolds(code, name, {members, room, roomUntil}), readHolds(code, name)
 *       the seat's session document's holds = {pid, at, members: [names], room: bool, roomUntil?}; readHolds folds
 *       roomUntil into room (a room hold between its JOINED return and the re-call is still running).
 *   missingRows(code, me, {now}) -> [names]   active members whose row has no live hold (after a grace period)
 *
 * Constants: PARTICIPANT ('sub-human:participant'), ROOM_AGENT ('sub-human:room'), ROW_MAX.
 */

import * as identity from './identity.ts';
import * as room from './room.ts';
import * as tasks from './tasks.ts';
import * as session from './room/session.ts';
import { rowSegment } from './room/render.ts';
import { isAlive, lazy } from './io.ts';
import * as text from './text.ts';
import * as linkState from './room/link-state.ts';
import {
  ROW_MAX, ROW_TITLE_MAX, PRESENCE_STALE_MS, HOLDS_STALE_MS, MISSING_GRACE_MS, ROWS_LOCK_TIMEOUT_MS, ROWS_LOCK_STALE_MS, ROWS_TTL_MS,
} from './config.ts';
import type { Holds, RowRec, Spawn, Task } from './types-app.ts';
import type { Entry, LinkState, Member, Members } from './room/types.ts';
import type { Identity } from './identity.ts';
// the row agents' types are mod/core/rows.ts's (the module's row hooks read them too)
import { PARTICIPANT, ROOM_AGENT } from '../mod/core/rows.ts';
import type { RoomCode, SeatName } from './brand.ts';
import type * as ProposalMod from './proposal.ts';

// lib/proposal.ts loads the consent reducer: only a row that names a pending proposal's title needs it (the status
// line runs every 5 s and draws most rows without one)
const proposalLib = lazy<typeof ProposalMod>(import.meta.url, './proposal.ts');

/** members as callers hand them over: readMembers(code) (by name) or a list. */
type MemberInput = Members | Member[] | null | undefined;
/** The seat a row is drawn for or spawned from. */
type Me = Pick<Identity, 'code' | 'name' | 'role'>;
/** paint(): warn / ok / dim, with colour or without. */
interface Paint { warn(s: string): string, ok(s: string): string, dim(s: string): string }
/** A proposal as a row reads it (proposals() below). */
interface RowProposal {
  id: number;
  hash: string;
  from: string;
  approvers: string[];
  verdict: Record<string, { kind: string, id: number }>;
  decided: number;
  agreed: number;
  objectors: string[];
  /** a listed objector -> the other seats of that person (lib/room/consent.ts matrix also) */
  also: Record<string, string[]>;
  /** how many people the approvers are: a person in two seats counts once */
  people: number;
  superseded: boolean;
  name: string;
}
/** rowText's options. */
interface RowOpts {
  color?: boolean;
  entries?: readonly Readonly<Entry>[];
  members?: MemberInput;
  now?: number;
  tasks?: Task[];
  taskSummary?: string | null;
  link?: LinkState | null;
}
/** rowText's options: whose row (member: a participant's; none: the room's) and who looks (viewer). */
interface RowFor extends RowOpts { member?: SeatName | null; viewer?: string | null }
/** The row map document rows/<session_id>. */
interface RowMap { byAgent?: Record<string, RowRec> }

const { NAME_RE, SID_SAFE, oneLine } = text;

// ---------- small helpers ----------
/** The log read back from its end (ids rise through it): the newest entry pick accepts, among those with id > after. */
function lastWhere(es: readonly Readonly<Entry>[], pick: (e: Entry) => boolean, after = 0): Entry | null {
  for (let i = es.length - 1; i >= 0; i--) {
    const e = es[i];
    if (!e) continue; // i < es.length
    if (typeof e.id === 'number' && e.id <= after) return null;
    if (pick(e)) return e;
  }
  return null;
}
/** How many entries with id > after pick accepts. */
function countAfter(es: readonly Readonly<Entry>[], pick: (e: Entry) => boolean, after: number): number {
  let n = 0;
  for (let i = es.length - 1; i >= 0; i--) {
    const e = es[i];
    if (!e) continue; // i < es.length
    if (typeof e.id === 'number' && e.id <= after) break;
    if (typeof e.id === 'number' && pick(e)) n++;
  }
  return n;
}
const clip = (s: string, n: number = ROW_MAX): string => text.clip(s, n);
const h6 = (h: string | null | undefined) => String(h || '').slice(0, 6);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
function ago(iso: string, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return '';
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

/** The room's small documents (lib/room/store.ts kv). */
const kvOf = (code: RoomCode) => room.open(code).store.kv;
const storeOf = (code: RoomCode) => room.open(code).store;
/**
 * The room log as a row reads it: every non-chat entry, and every line since the log's last rotation (lib/room.ts
 * readRecent; the whole log before one). A row looks back only over recent chat (the last post, the mail since the
 * viewer's last reply: everything in that window is after an older reply), so a cold status line parses one segment.
 */
function readLog(code: RoomCode): readonly Readonly<Entry>[] {
  try { return room.open(code).readRecent(); } catch { return []; }
}
function memberList(members: MemberInput): Member[] {
  if (!members) return [];
  const list: (Member | null | undefined)[] = Array.isArray(members) ? members
    : Object.entries(members).map(([k, v]) => Object.assign({ name: k }, v)); // a record's own name wins
  return list.filter((m): m is Member => !!m && typeof m.name === 'string' && NAME_RE.test(m.name));
}
const isActive = (m: Member | null | undefined) => !!m && !m.left_at && !m.lapsed_at; // lapsed: lib/seats.ts sweep
const isRoomClaude = (m: Member) => m.role === 'claude' || m.name === 'claude';
function readMembers(code: RoomCode): Members { try { return identity.readMembers(code) || {}; } catch { return {}; } }

const normKind = (e: Entry): string => room.normalize(e).kind;

// ---------- spawning ----------
const participantCall = (name: string) =>
  `Agent({subagent_type: "${PARTICIPANT}", description: "${name}", prompt: "member: ${name}", run_in_background: true})`;
const roomCall = (code: RoomCode, names: string[]) =>
  `Agent({subagent_type: "${ROOM_AGENT}", description: "${code}", prompt: "room: ${code}\\nmembers: ${names.length ? names.join(', ') : '(none)'}", run_in_background: true})`;

function rowCalls(me: Me | null | undefined, members: MemberInput, { only = null }: { only?: string[] | null } = {}): string {
  if (!me || !me.code) return '';
  const others = memberList(members).filter(m => isActive(m) && m.name !== me.name);
  const want = Array.isArray(only) ? new Set(only) : null;
  if (me.role === 'claude') {
    const all = others.filter(m => !isRoomClaude(m)).map(m => m.name);
    const names = want ? all.filter(n => want.has(n)) : all;
    const lines = ['PARTICIPANT ROWS (one row per person; a row shows that person, not you. Do this now; it costs nothing while they wait):'];
    if (names.length) {
      lines.push(`Make exactly these Agent tool calls, all in ONE message, then carry on (write nothing about them):`);
      for (const n of names) lines.push(participantCall(n));
    } else if (want && all.length) {
      lines.push('Your rows are already running (their holds are live). Make no Agent calls for them now; a second copy would duplicate a row in the panel.');
    } else {
      lines.push('No members yet.');
    }
    lines.push(`Each member_joined NAME notice ends with "row: …", read from your live rows: make ${participantCall('NAME')} only when it says NAME has no row running (same message as anything else you do). When it says the row is already running (a rejoin), make NO Agent call.`);
    lines.push('A row stays when its member leaves (it reads "left") and comes back to life when they rejoin; it ends when you leave. Never spawn a row for yourself, and never call the hold tool yourself.');
    return lines.join('\n');
  }
  const names = others.filter(m => !isRoomClaude(m)).map(m => m.name);
  if (want && !want.has(me.code)) {
    return [
      'ROOM ROW: already running (its hold is live). Make no Agent call for it now; a second copy would duplicate the room row in the panel.',
      'It adds and keeps the other members\' rows by itself; never call the hold tool yourself.',
    ].join('\n');
  }
  return [
    `ROOM ROW (do this now; it costs nothing while it waits):`,
    `Make exactly this one Agent tool call, then carry on (write nothing about it):`,
    roomCall(me.code, names),
    `It shows the room as one row labelled ${me.code}, with the other members inside it, and adds new members by itself. Spawn it once per session; never call the hold tool yourself.`,
  ].join('\n');
}

/**
 * What a member_joined notice (scripts/sub-human tail) tells this seat about NAME's row, from the live holds file:
 * spawn only when the row is not running. A spawn of a running row is denied by hooks/handlers/row-guard.ts, which
 * Claude Code renders as a red error, so the notice prevents the attempt. '' for my own join.
 */
function joinNote(me: Me | null | undefined, name: string | null | undefined, { held }: { held?: Holds | null } = {}): string {
  if (!me || !me.code || !name || name === me.name || name === 'claude') return '';
  const h = held === undefined ? readHolds(me.code, me.name) : held;
  if (me.role === 'claude') {
    return h && h.members.includes(name)
      ? `row: ${name}'s row is already running (it shows the rejoin by itself); make NO Agent call`
      : `row: ${name} has no row running; spawn it now: Agent sub-human:participant, description "${name}", prompt "member: ${name}", run_in_background`;
  }
  if (h && h.room) return `row: your room row adds ${name} by itself; make NO Agent call`;
  const names: string[] = memberList(readMembers(me.code)).filter(m => isActive(m) && !isRoomClaude(m) && m.name !== me.name).map(m => m.name);
  if (!names.includes(name)) names.push(name);
  return `row: your room row is not running; spawn it now: ${roomCall(me.code, names)}`;
}

/** Rows this seat should have but `held` (readHolds) shows no live hold for. Room Claude: names; member: [code]. */
function rowsNeeded(code: RoomCode, me: Pick<Identity, 'name' | 'role'>, { members, held = null }: { members?: MemberInput, held?: Holds | null } = {}): string[] {
  const ms = memberList(members ?? readMembers(code));
  const h: Pick<Holds, 'members' | 'room'> = held ?? { members: [], room: false };
  if (me.role === 'claude') {
    return ms.filter(m => isActive(m) && !isRoomClaude(m) && m.name !== me.name && !h.members.includes(m.name)).map(m => m.name);
  }
  return h.room ? [] : [code];
}

/** Which row an Agent(...) spawn is: from subagent_type plus the prompt / description / name. */
function parseSpawn(input: unknown, members: MemberInput, code?: string | null): Spawn | null {
  if (!input || typeof input !== 'object') return null;
  const call = input as Record<string, unknown>; // the Agent tool's input: each field is checked below
  const type = String(call.subagent_type || '');
  const known = new Set<string>(memberList(members).map(m => m.name));
  const fields = [call.prompt, call.description, call.name].map(x => (typeof x === 'string' ? x.trim() : ''));
  if (type === PARTICIPANT || type === 'participant') {
    for (const f of fields) {
      const name = /\bmember:\s*([A-Za-z0-9_.-]{1,32})/.exec(f)?.[1];
      if (name !== undefined) return { kind: 'participant', name };
    }
    for (const f of fields) if (NAME_RE.test(f) && (!known.size || known.has(f))) return { kind: 'participant', name: f };
    return null;
  }
  if (type === ROOM_AGENT || type === 'room') {
    for (const f of fields) {
      const name = (/\broom:\s*([a-z]+-\d{4})/.exec(f) ?? /^([a-z]+-\d{4})$/.exec(f))?.[1];
      if (name !== undefined) return { kind: 'room', name };
    }
    return code ? { kind: 'room', name: code } : null;
  }
  return null;
}

// ---------- the agent -> row map ----------
const mapKey = (sid: unknown) => `rows/${SID_SAFE.test(String(sid)) ? sid : 'unknown'}`;

/** The row map's lock: wait up to ROWS_LOCK_TIMEOUT_MS, then throw (the hook logs it); never write unlocked. */
const LOCK = { compact: true, timeoutMs: ROWS_LOCK_TIMEOUT_MS, staleMs: ROWS_LOCK_STALE_MS };

function recordRow(code: RoomCode, sessionId: string | null | undefined, agentId: string, rec: Omit<RowRec, 'at'>): boolean { // stamped with at here
  if (!code || !agentId) return false;
  kvOf(code).update(mapKey(sessionId), (cur: RowMap | null) => {
    const byAgent = cur && cur.byAgent && typeof cur.byAgent === 'object' ? cur.byAgent : {};
    byAgent[agentId] = { ...rec, at: new Date().toISOString() };
    return { byAgent };
  }, LOCK);
  return true;
}

const sessionKeys = (code: RoomCode): string[] => { try { return kvOf(code).list('rows/'); } catch { return []; } };

function readRowMap(code: RoomCode): Record<string, RowRec> {
  const out: Record<string, RowRec> = {};
  const kv = kvOf(code);
  for (const k of sessionKeys(code)) {
    const m: RowMap | null = kv.get(k, null);
    if (m && m.byAgent && typeof m.byAgent === 'object') Object.assign(out, m.byAgent);
  }
  return out;
}

/** The agent -> row records this session id spawned ({} when none). */
function sessionRowMap(code: RoomCode, sid: string | null | undefined): Record<string, RowRec> {
  const m: RowMap | null = kvOf(code).get(mapKey(sid), null);
  return (m && m.byAgent && typeof m.byAgent === 'object') ? m.byAgent : {};
}

/**
 * Drop the agent -> row maps of sessions that ended without clearing them: a map whose newest row is ROWS_TTL_MS old
 * and whose session holds no live seat (identity.resolveBySession). lib/gc.ts sweepRows, at a join. Returns how many.
 */
function pruneRowMaps(code: RoomCode, now: number = Date.now()): number {
  const kv = kvOf(code);
  let n = 0;
  for (const k of sessionKeys(code)) {
    const m: RowMap | null = kv.get(k, null);
    const ats = m && m.byAgent && typeof m.byAgent === 'object' ? Object.values(m.byAgent).map(r => Date.parse(String(r && r.at))).filter(Number.isFinite) : [];
    if (ats.length && now - Math.max(...ats) < ROWS_TTL_MS) continue;
    if (identity.resolveBySession(k.slice('rows/'.length))) continue; // a live seat's session: its rows stay
    kv.delete(k);
    n++;
  }
  return n;
}

function forgetRow(code: RoomCode, agentId: string): void {
  const kv = kvOf(code);
  for (const k of sessionKeys(code)) {
    kv.update(k, (m: RowMap | null) => {
      if (!(m && m.byAgent && m.byAgent[agentId])) return undefined;
      delete m.byAgent[agentId];
      return m;
    }, LOCK);
  }
}

/** A row's hold: the seat's session document, and the row's agent id. */
interface RowHold { seat: SeatName; agent: string }
/** How often hooks/handlers/row-hold.ts blocked agent's stop (the seat's session document); setBlockCount(code, {seat, agent}, n). */
const blockCount = (code: RoomCode, { seat, agent }: RowHold): number => session.blocks(storeOf(code), seat, agent);
const setBlockCount = (code: RoomCode, { seat, agent }: RowHold, n: unknown): void => session.setBlocks(storeOf(code), seat, agent, Number(n) || 0);

// ---------- hold liveness (mcp/hold.ts writes, the status line reads) ----------
function writeHolds(code: RoomCode, name: SeatName, { members = [], room = false, roomUntil = 0 }: { members?: string[], room?: boolean, roomUntil?: number } = {}): void {
  const rec: Holds = { pid: process.pid, at: new Date().toISOString(), members: [...new Set(members)].sort(), room: !!room };
  if (!room && roomUntil) rec.roomUntil = new Date(roomUntil).toISOString();
  try { session.put(storeOf(code), name, 'holds', rec); } catch { /* best effort */ }
}
/**
 * The live holds of NAME's hold server, or null. `room` stays true until `roomUntil`: a room hold that just
 * returned JOINED/RESPAWN is being re-called by its row agent, so the room row is still running (a join
 * notice read in that gap would invite a second room-row spawn, which row-guard then denies in red).
 */
function readHolds(code: RoomCode, name: SeatName, now: number = Date.now()): Holds | null {
  let h: Holds | null = null; // as writeHolds wrote it (members is checked: an older writer)
  try { h = session.get(storeOf(code), name, 'holds') ?? null; } catch { h = null; }
  if (!h || !isAlive(h.pid) || now - Date.parse(h.at) > HOLDS_STALE_MS) return null;
  const members = Array.isArray(h.members) ? h.members : [];
  return { ...h, members, room: !!h.room || (!!h.roomUntil && now < Date.parse(h.roomUntil)) };
}

/** Rows this seat should have but holds nothing for. Room Claude: members. Member: the room row ([code]). */
function missingRows(code: RoomCode, me: Pick<Identity, 'name' | 'role'>, { now = Date.now(), members }: { now?: number, members?: MemberInput } = {}): string[] {
  const ms = memberList(members ?? readMembers(code));
  const h: Pick<Holds, 'members' | 'room'> = readHolds(code, me.name, now) ?? { members: [], room: false };
  const old = (m: Member) => !m.joined_at || now - Date.parse(m.joined_at) > MISSING_GRACE_MS;
  if (me.role === 'claude') {
    return ms.filter(m => isActive(m) && !isRoomClaude(m) && m.name !== me.name && old(m) && !h.members.includes(m.name)).map(m => m.name);
  }
  const self = ms.find(m => m.name === me.name);
  return self && old(self) && !h.room ? [code] : [];
}

// ---------- row text ----------
const ESC = '\x1b[';
const paint = (on: boolean): Paint => (on
  ? { warn: s => `${ESC}33m${s}${ESC}0m`, ok: s => `${ESC}32m${s}${ESC}0m`, dim: s => `${ESC}2m${s}${ESC}0m` }
  : { warn: s => s, ok: s => s, dim: s => s });
const plainLen = (s: string) => Array.from(String(s).replace(/\x1b\[[0-9;]*m/g, '')).length;
const SEP = ' · ';

/** Join segments with " · ", keeping whole segments while they fit in ROW_MAX; a lone first one is clipped. */
function fit(parts: (string | null | undefined | false)[]): string {
  const ps = parts.filter((p): p is string => !!p);
  const [first, ...rest] = ps;
  if (first === undefined) return '';
  let out = first, len = plainLen(first);
  if (len > ROW_MAX) return clip(first.replace(/\x1b\[[0-9;]*m/g, ''));
  for (const p of rest) {
    const l = plainLen(p);
    if (len + SEP.length + l > ROW_MAX) break;
    out += SEP + p; len += SEP.length + l;
  }
  return out;
}

/**
 * Proposals in log order (of their latest entry), from lib/room/consent.ts fold: {id, hash, approvers, verdict: {name:
 * {kind, id}} (approvers' current answers: a person's seats share one), decided (decision id or 0), agreed (count of
 * people), objectors (one seat per person), also, people (count), superseded (a revision retired it), name (title)}.
 */
function proposals(es: readonly Readonly<Entry>[], code: RoomCode | null | undefined): RowProposal[] {
  const f = code ? room.open(code).fold(es) : room.fold(es); // the room's store judges its people's answers
  return [...f.proposals.values()].map((fp): RowProposal => {
    const m = f.matrix(fp.hash);
    const verdict: RowProposal['verdict'] = {};
    for (const n of fp.approvers) if (m.answers[n]) verdict[n] = m.answers[n];
    const d = f.decisions.get(fp.hash);
    return { id: fp.id, hash: fp.hash, from: fp.from, approvers: fp.approvers, verdict, decided: d ? d.id : 0,
      agreed: m.agreed.length, objectors: m.objected, also: m.also, people: m.people, superseded: f.superseded.has(fp.hash), name: label(code, fp) };
  });
}
/** What a row calls a proposal: its title (lib/proposal.ts title), clipped; the short hash when it has none. */
function label(code: RoomCode | null | undefined, fp: { hash: string, entry?: Entry }): string {
  let t = '';
  try { t = code ? oneLine(proposalLib().title(code, fp.hash, fp.entry)) : ''; } catch { /* unreadable: the hash */ }
  return t ? clip(t, ROW_TITLE_MAX) : h6(fp.hash);
}
/** A closed proposal: "✔ decided TITLE" when everyone agreed, "✖ blocked TITLE" when someone objected. */
const decidedText = (p: RowProposal, c: Paint) => (p.objectors.length ? c.warn(`✖ blocked ${p.name}`) : c.ok(`✔ decided ${p.name}`));
/** Undecided, unretired proposals that name `name` and that `name` has not answered (newest last). */
const awaiting = (ps: RowProposal[], name: string) => ps.filter(p => !p.decided && !p.superseded && p.approvers.includes(name) && !p.verdict[name]);
/** The proposal a row reports for `name`: the newest unretired one that names them, else the newest unretired one. */
function latestFor(ps: RowProposal[], name: string): RowProposal | null {
  const live = ps.filter(p => !p.superseded);
  return live.filter(p => p.approvers.includes(name)).at(-1) ?? live.at(-1) ?? null;
}

// ---------- tasks (lib/tasks.ts: the mirror of the room Claude's native list) ----------
const taskSummary = (code: RoomCode, viewer: string | null | undefined) => oneLine(tasks.summary(code, viewer) || '');
/** NAME's open task on the room list: in progress first, else the first pending. */
function openTask(list: (Task | null | undefined)[], name: string): Task | null {
  const mine = list.filter((t): t is Task => !!t && t.owner === name && t.status !== 'completed' && t.status !== 'deleted'
    && !(t.metadata && t.metadata._internal));
  return mine.find(t => t.status === 'in_progress') ?? mine[0] ?? null;
}

function presenceOf(code: RoomCode, name: SeatName, es: readonly Readonly<Entry>[], now: number): string | null {
  let p: { state?: unknown, at?: string } | null = null;
  try { p = kvOf(code).get(`presence/${name}`, null); } catch { p = null; }
  if (!p || typeof p.state !== 'string') return null;
  const at = Date.parse(p.at as string); // NaN when absent, as before
  if (Number.isFinite(at)) {
    if (now - at > PRESENCE_STALE_MS) return null;
    // Anything they posted after the presence write means they are back at it: the old state is stale.
    const last = lastWhere(es, e => e.from === name);
    if (last && Date.parse(last.at) > at) return null;
  }
  const s = p.state.toLowerCase();
  if (s === 'gone' || s === 'left') return null;
  if (s === 'asking' || s === 'prompt' || s === 'permission' || s === 'permission_prompt') return '? prompt';
  if (s === 'idle' || s === 'idle_prompt') return 'idle';
  if (s === 'busy' || s === 'working') return 'working';
  if (s === 'error' || s === 'failed' || s === 'stop_failure') return '✖ error';
  return clip(s, 12);
}

/** What both row texts read: the room, who looks, its log and members, the time and the paint. */
interface RowCtx { code: RoomCode; viewer: string | null | undefined; es: readonly Readonly<Entry>[]; ms: Member[]; now: number; c: Paint }

function participantText({ code, viewer, es, ms, now, c }: RowCtx, name: SeatName, taskList: Task[]): string {
  const m = ms.find(x => x.name === name);
  if (!m) return 'not in the room';
  if (m.left_at) return 'left';
  if (m.lapsed_at) return 'connection lost';
  const parts: string[] = [];
  const p = latestFor(proposals(es, code), name);
  if (p) {
    const v = p.verdict[name];
    // Build phase: their latest status after the decision replaces "decided".
    const st = p.decided ? lastWhere(es, e => e.from === name && e.kind === 'status', p.decided) : null;
    if (st) parts.push(`${st.via === 'agent' ? 'Claude ' : ''}status: ${oneLine(st.text)}`);
    else if (p.decided) parts.push(decidedText(p, c));
    else if (v && v.kind === 'signoff') parts.push(c.ok(`✓ agreed ${p.name}`));
    else if (v && v.kind === 'objection') parts.push(c.warn('✖ objected'));
    else if (p.approvers.includes(name)) parts.push(c.warn(`⚠ reviewing ${p.name}`));
  }
  const t = openTask(taskList, name);
  if (t) parts.push(`◼ #${t.id} ${clip(oneLine(t.subject), 28)}`);
  const pres = presenceOf(code, name, es, now);
  if (pres) parts.push(pres === 'idle' ? c.dim(pres) : c.warn(pres));
  if (viewer && viewer !== name) {
    const lastReply = lastWhere(es, e => e.from === viewer && (e.to === name || e.to === 'room' || !e.to))?.id || 0;
    const mail = countAfter(es, e => e.from === name && e.to === viewer, lastReply);
    if (mail) parts.push(c.warn(`✉ ${mail} for you`));
  }
  if (!parts.length || (parts.length === 1 && pres)) {
    const last = lastWhere(es, e => e.from === name && e.kind !== 'member_joined' && e.kind !== 'member_left');
    if (last) parts.push(c.dim(`${last.via === 'agent' ? 'Claude ' : ''}${normKind(last)} ${ago(last.at, now)}`));
    else if (!parts.length) parts.push(c.dim('joined'));
  }
  return fit(parts);
}

function roomText({ code, viewer, es, ms, now, c }: RowCtx, summary: string, link: LinkState | null): string {
  const parts: string[] = [];
  // a room hosted elsewhere: the link leads the row while it is down or reconnecting, and closes it while up
  // (lib/room/link-state.ts indicator: "✕ offline 2m · 2 queued", "… connecting (3)", "⇄ online")
  const linkSeg: string = linkState.indicator(link, { now });
  if (linkSeg && link?.state !== 'online') parts.push(linkState.isDown(link) ? c.warn(linkSeg) : c.dim(linkSeg));
  // a join or (settled) leave of the last 2 minutes leads the row: "+bob joined", "−bob left (session ended)" (lib/room/render.ts)
  const move = rowSegment(es, viewer, { now });
  if (move) parts.push(c.dim(move));
  const ps = proposals(es, code);
  const need = viewer ? awaiting(ps, viewer) : [];
  const p = viewer ? latestFor(ps, viewer) : ps.at(-1);
  const needs = need.at(-1);
  if (needs) {
    parts.push(c.warn(`⚠ your answer needed ${needs.name}${need.length > 1 ? ` +${need.length - 1}` : ''}`));
  } else if (p) {
    const v = viewer && p.verdict[viewer];
    const n = `${p.agreed}/${p.people}`;
    if (p.decided) parts.push(decidedText(p, c));
    else if (v && v.kind === 'signoff') parts.push(c.ok(`✓ agreed ${p.name} ${n}`));
    else if (v && v.kind === 'objection') parts.push(c.warn('✖ objected'));
    else parts.push(`proposal ${p.name} ${n}`);
    // another person's objections: the viewer's own (from any of their seats) is the "✖ objected" above
    const others = p.objectors.filter(x => x !== viewer && !(p.also[x] ?? []).includes(String(viewer)));
    if (!p.decided && others.length) parts.push(c.warn(`✖ ${plural(others.length, 'objection')}`));
  } else if (!linkState.stoppedForGood(link)) { // stopped (a kick, the room closed): this copy's count is stale
    parts.push(c.dim(`${ms.filter(m => isActive(m) && !isRoomClaude(m)).length} here`));
  }
  if (viewer) {
    // read once the viewer or their Claude answered anything after it (stage 8e I.3: a Claude's reply left it stuck);
    // the room's Claude's answer to the viewer's own @claude is read too: it was shown to them as it came (stage 8f)
    const own = lastWhere(es, e => e.from === viewer && (e.via === 'human' || e.via === 'agent'));
    const asked = !!own && own.to === 'claude';
    const mail = countAfter(es, e => e.to === viewer && e.from !== viewer && !(asked && e.from === 'claude'), own?.id || 0);
    if (mail) parts.push(c.warn(`✉ ${mail} for you`));
  }
  if (summary) parts.push(summary);
  if (linkSeg && link?.state === 'online') parts.push(c.dim(linkSeg));
  return fit(parts);
}

/**
 * opts: {member (a participant row's seat; none: the room row), viewer (who looks), color, entries, members, now,
 *        tasks (list; default lib/tasks.ts mine(code, member)), taskSummary (string, default tasks.summary(code,
 *        viewer)), link (the room row: lib/room/link-state.ts State or null, default read(code))}.
 */
function rowText(code: RoomCode, { member, viewer, ...opts }: RowFor = {}): string {
  const now = opts.now || Date.now();
  const ctx: RowCtx = { code, viewer, es: opts.entries ?? readLog(code), ms: memberList(opts.members ?? readMembers(code)), now, c: paint(!!opts.color) };
  if (member == null) {
    const summary = opts.taskSummary != null ? oneLine(opts.taskSummary) : taskSummary(code, viewer);
    const link = opts.link !== undefined ? opts.link : (code ? linkState.read(code) : null);
    return roomText(ctx, summary, link);
  }
  return participantText(ctx, member, Array.isArray(opts.tasks) ? opts.tasks : tasks.mine(code, member));
}

const rowLine = (label: string, text: string | null | undefined): string => (text ? `${label}  ${text}` : label);

export {
  PARTICIPANT, ROOM_AGENT, ROW_MAX, rowCalls, rowsNeeded, joinNote, participantCall, roomCall, parseSpawn, rowText,
  rowLine, readLog, fit, recordRow, forgetRow, pruneRowMaps, readRowMap, sessionRowMap, blockCount, setBlockCount, writeHolds,
  readHolds, missingRows,
};
