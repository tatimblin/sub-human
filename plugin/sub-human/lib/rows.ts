/**
 * plugin/sub-human/lib/rows.ts: the room row in the agent panel, as text.
 * Reads the room log, members and presence; writes nothing but the blocks of a seat's session document
 * (hooks/handlers/row-hold.ts, lib/room/session.ts).
 *
 * One row per member session: the room row (agents/room.md, sub-human:room, labelled by the room code), which the
 * hooks module spawns itself ($.agent.spawn, mod/deliver.ts roomRow): the model never spawns or sees a row call. It
 * lives as long as its viewer is in the room (mcp/hold.ts: one live room hold per session; a second is told "STOP:
 * duplicate row").
 *
 * hereLine is who else is here (names and what their fresh presence says): the lead of the row's own line (mcp/hold.ts).
 * rowText is the opt-in status line: deterministic from the log, members and the presence/<name> documents, <= ROW_MAX
 * chars, no label. No entry ids (people never see them); task ids ("#2") are the room task list's numbers. A proposal
 * is named by its title (clipped to ROW_TITLE_MAX; the 6-char hash when there is none): rows are for people, and no
 * tool call is made from them. Proposals come from lib/room/consent.ts fold, the same state stateLine and the consent
 * gate read. Segments that do not fit are dropped.
 */

import * as identity from './identity.ts';
import * as room from './room.ts';
import * as tasks from './tasks.ts';
import * as session from './room/session.ts';
import { rowSegment } from './room/render.ts';
import { lazy } from './io.ts';
import * as text from './text.ts';
import * as linkState from './room/link-state.ts';
import {
  ROW_MAX, ROW_TITLE_MAX, PRESENCE_STALE_MS,
} from './config.ts';
import type { Entry, LinkState, Member, Members, Presence, PresenceState } from './room/types.ts';
// the room row's agent type is mod/core/rows.ts's (the module spawns it)
import { ROOM_AGENT } from '../mod/core/rows.ts';
import type { RoomCode, SeatName } from './brand.ts';
import type * as ProposalMod from './proposal.ts';

// lib/proposal.ts loads the consent reducer: only a row that names a pending proposal's title needs it (the status
// line runs every 5 s and draws most rows without one)
const proposalLib = lazy<typeof ProposalMod>(import.meta.url, './proposal.ts');

/** members as callers hand them over: readMembers(code) (by name) or a list. */
type MemberInput = Members | Member[] | null | undefined;
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
  /** a sign-off request for a version of a room plan (its hash is the version's) */
  plan: boolean;
  /** a plan's request for a version older than the plan's current one: history, never the row's news */
  stale: boolean;
  name: string;
}
/** rowText's options. */
interface RowOpts {
  color?: boolean;
  entries?: readonly Readonly<Entry>[];
  members?: MemberInput;
  now?: number;
  taskSummary?: string | null;
  link?: LinkState | null;
}
/** rowText's options: who looks (viewer). */
interface RowFor extends RowOpts { viewer?: string | null }

const { NAME_RE, oneLine } = text;

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

/** A row agent's stops blocked so far (hooks/handlers/row-hold.ts; the seat's session document), and setting it. */
interface RowHold { seat: SeatName; agent: string }
const blockCount = (code: RoomCode, { seat, agent }: RowHold): number => session.blocks(storeOf(code), seat, agent);
const setBlockCount = (code: RoomCode, { seat, agent }: RowHold, n: unknown): void => session.setBlocks(storeOf(code), seat, agent, Number(n) || 0);

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
    const v = f.versionOf(fp.hash);
    const cur = v ? f.plans.get(v.plan)?.current : null;
    return { id: fp.id, hash: fp.hash, from: fp.from, approvers: fp.approvers, verdict, decided: d ? d.id : 0,
      agreed: m.agreed.length, objectors: m.objected, also: m.also, people: m.people, superseded: f.superseded.has(fp.hash),
      plan: !!v, stale: !!v && !!cur && cur.hash !== fp.hash, name: label(code, fp) };
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
/** The proposal a row reports for `name`: the newest unretired one that names them, else the newest unretired one.
 * A request for an older version of a plan is retired too, decided or not (a decision on v1 says nothing of v6). */
function latestFor(ps: RowProposal[], name: string): RowProposal | null {
  const live = ps.filter(p => !p.superseded && !p.stale);
  return live.filter(p => p.approvers.includes(name)).at(-1) ?? live.at(-1) ?? null;
}

// ---------- tasks (lib/tasks.ts: the mirror of the room Claude's native list) ----------
const taskSummary = (code: RoomCode, viewer: string | null | undefined) => oneLine(tasks.summary(code, viewer) || '');
/** What the row text reads: the room, who looks, its log and members, the time and the paint. */
interface RowCtx { code: RoomCode; viewer: string | null | undefined; es: readonly Readonly<Entry>[]; ms: Member[]; now: number; c: Paint }

function roomText({ code, viewer, es, ms, now, c }: RowCtx, summary: string, link: LinkState | null): string {
  const parts: string[] = [];
  // a room hosted elsewhere: the link leads the row while it is down or reconnecting, and closes it while up
  // (lib/room/link-state.ts indicator: "✕ offline 2m · 2 queued", "… connecting (3)", "⇄ online")
  const linkSeg: string = linkState.indicator(link, { now });
  if (linkSeg && link?.state !== 'online') parts.push(linkState.isDown(link) ? c.warn(linkSeg) : c.dim(linkSeg));
  // a join or (settled) leave of the last 2 minutes leads the row: "+bob joined", "−bob left (session ended)" (lib/room/render.ts);
  // only since the viewer's own (last) join: who was here before they came is no news to them
  const since = viewer ? lastJoinAt(es, viewer) : 0;
  const move = rowSegment(since ? es.slice(since) : es, viewer, { now });
  if (move) parts.push(c.dim(move));
  const ps = proposals(es, code);
  const need = viewer ? awaiting(ps, viewer) : [];
  // a room plan's state is its plan segment below (its current version), never a request's for an older one
  const loose = ps.filter(x => !x.plan);
  const p = viewer ? latestFor(loose, viewer) : loose.filter(x => !x.superseded).at(-1);
  const needs = need.at(-1);
  if (needs) {
    parts.push(c.warn(`⚠ your answer needed ${needs.name}${need.length > 1 ? ` +${need.length - 1}` : ''}`));
  } else if (p) {
    const v = viewer && p.verdict[viewer];
    const n = `${p.agreed}/${p.people} agreed`;
    if (p.decided) parts.push(decidedText(p, c));
    else if (v && v.kind === 'signoff') parts.push(`proposal ${p.name} ${n} ${c.ok('(✓ you)')}`); // not decided: a count, no ✔
    else if (v && v.kind === 'objection') parts.push(c.warn('✖ objected'));
    else parts.push(`proposal ${p.name} ${n}`);
    // another person's objections: the viewer's own (from any of their seats) is the "✖ objected" above
    const others = p.objectors.filter(x => x !== viewer && !(p.also[x] ?? []).includes(String(viewer)));
    if (!p.decided && others.length) parts.push(c.warn(`✖ ${plural(others.length, 'objection')}`));
  } else if (!linkState.stoppedForGood(link)) { // stopped (a kick, the room closed): this copy's count is stale
    parts.push(c.dim(hereOf(code, ms, viewer, now)));
  }
  if (viewer) {
    // read once the viewer or their Claude answered anything after it
    const own = lastWhere(es, e => e.from === viewer && (e.via === 'human' || e.via === 'agent'));
    const mail = countAfter(es, e => e.to === viewer && e.from !== viewer, own?.id || 0);
    if (mail) parts.push(c.warn(`✉ ${mail} for you`));
  }
  const named = new Set([needs, p].flatMap(x => (x ? [x.hash] : [])));
  const tail = [summary, linkSeg && link?.state === 'online' ? c.dim(linkSeg) : ''];
  return fitPlans(parts, planSegs(es, code, named), tail, c);
}

/** A presence state as the row says it beside a name ("bob (working)"); idle says nothing. */
const PRESENCE_WORDS: Record<PresenceState, string> = { working: 'working', idle: '', permission: 'needs them', error: 'stalled' };
/** Each named seat's presence (presence/NAME: hooks/handlers/presence.ts writes it), when younger than
 * PRESENCE_STALE_MS: an older one says nothing of now. */
function presenceOf(code: RoomCode | null | undefined, names: readonly string[], now: number): Record<string, Presence> {
  const out: Record<string, Presence> = {};
  if (!code) return out;
  for (const n of names) {
    let p: Presence | null = null;
    try { p = kvOf(code).get<Presence>(`presence/${n}`, null); } catch { /* none */ }
    const at = p ? Date.parse(String(p.at)) : NaN;
    if (p && Number.isFinite(at) && now - at < PRESENCE_STALE_MS) out[n] = p;
  }
  return out;
}
/** A name with what its presence says: "bob (working)", "carol (stalled: rate_limit)", "dan". */
function withPresence(n: string, p: Presence | undefined): string {
  const w: string = p ? PRESENCE_WORDS[p.state] ?? '' : ''; // a state this version does not know: the name alone
  if (!w) return n;
  return `${n} (${w}${p && p.state === 'error' && p.detail ? `: ${oneLine(p.detail)}` : ''})`;
}

/** The others than the viewer who are here (active, not the room session), in members order. */
const othersHere = (ms: Member[], viewer: string | null | undefined): string[] => ms.filter(m => isActive(m) && !isRoomClaude(m) && m.name !== viewer).map(m => m.name);
/** Who is here, by name, with what their presence says: the others than the viewer ("bob (working), carol here"; past
 * HERE_NAMED names "+N"), else "only you" (the room row is the only row: it names the people). */
const HERE_NAMED = 3;
function hereText(ms: Member[], viewer: string | null | undefined, presence: Record<string, Presence> = {}): string {
  const names = othersHere(ms, viewer);
  if (!names.length) return viewer ? 'only you' : '0 here';
  const more = names.length - HERE_NAMED;
  return `${names.slice(0, HERE_NAMED).map(n => withPresence(n, presence[n])).join(', ')}${more > 0 ? ` +${more}` : ''} here`;
}
/** hereText over the room's members and the presence of those it names. */
const hereOf = (code: RoomCode | null | undefined, ms: Member[], viewer: string | null | undefined, now: number): string =>
  hereText(ms, viewer, presenceOf(code, othersHere(ms, viewer).slice(0, HERE_NAMED), now));
/** Who else is here as viewer sees it: the room row's lead (mcp/hold.ts), read fresh each time (the row's label is
 * its spawn's and goes stale). */
function hereLine(code: RoomCode, viewer: string | null | undefined, { members, now = Date.now() }: { members?: MemberInput; now?: number } = {}): string {
  return hereOf(code, memberList(members ?? readMembers(code)), viewer, now);
}

/** The id of name's last join in es (0: none). */
function lastJoinAt(es: readonly Readonly<Entry>[], name: string): number {
  for (let i = es.length - 1; i >= 0; i--) { const e = es[i]; if (e && e.kind === 'member_joined' && e.from === name) return i; }
  return 0;
}

/** fit(head, plans, tail) with every plan segment kept whole: the newest plans as many as fit, then "+N plans" (the
 * tail, the task summary, gives way first). */
function fitPlans(head: string[], plans: { segs: string[]; more: number }, tail: string[], c: Paint): string {
  const all = plans.segs.length + plans.more;
  for (let k = plans.segs.length; k >= 0; k--) {
    const rest = all - k;
    const shown = [...plans.segs.slice(0, k), ...(rest ? [`+${rest} ${rest === 1 ? 'plan' : 'plans'}`] : [])].map(c.dim);
    const out = fit([...head, ...shown, ...tail]);
    if (shown.every(s => out.includes(s))) return out;
  }
  return fit([...head, ...tail]);
}

const PLANS_SHOWN = 3;
/**
 * The room's plans at a glance (lib/room/consent.ts plans and status), each at its current version, the latest edited
 * first, at most PLANS_SHOWN (more: how many past them; fitPlans says "+N plans"): "paging v4 1/2 agreed, waiting on
 * bob", "release v2 agreed", "api v1 draft" (no request on the current version), "api v3 not agreed". A plan whose
 * current version the row already names (named: hashes) is left out.
 */
function planSegs(es: readonly Readonly<Entry>[], code: RoomCode | null | undefined, named: ReadonlySet<string>): { segs: string[]; more: number } {
  const f = code ? room.open(code).fold(es) : room.fold(es);
  const ps = [...f.plans.values()].filter(x => !named.has(x.current.hash)).sort((a, b) => b.current.id - a.current.id);
  const state = (h: string): string => {
    const st = f.status(h);
    if (!st || st.state === 'superseded') return 'draft';
    if (st.decision) return st.matrix.objected.length ? 'not agreed' : 'agreed';
    // undecided: a count, never "agreed" alone ("paging v3 1/2 agreed, waiting on bob")
    const n = `${st.matrix.agreed.length}/${st.matrix.people} agreed`;
    return st.matrix.missing.length ? `${n}, waiting on ${st.matrix.missing.join(', ')}` : n;
  };
  return { segs: ps.slice(0, PLANS_SHOWN).map(x => `${x.name} v${x.current.version} ${state(x.current.hash)}`), more: Math.max(0, ps.length - PLANS_SHOWN) };
}

/** The room row as viewer sees it. taskSummary and link default to lib/tasks.ts summary and lib/room/link-state.ts read. */
function rowText(code: RoomCode, { viewer, ...opts }: RowFor = {}): string {
  const now = opts.now || Date.now();
  const ctx: RowCtx = { code, viewer, es: opts.entries ?? readLog(code), ms: memberList(opts.members ?? readMembers(code)), now, c: paint(!!opts.color) };
  const summary = opts.taskSummary != null ? oneLine(opts.taskSummary) : taskSummary(code, viewer);
  const link = opts.link !== undefined ? opts.link : (code ? linkState.read(code) : null);
  return roomText(ctx, summary, link);
}

const rowLine = (label: string, text: string | null | undefined): string => (text ? `${label}  ${text}` : label);

export {
  ROOM_AGENT, ROW_MAX, rowText, rowLine, hereLine, readLog, fit, blockCount, setBlockCount,
};
