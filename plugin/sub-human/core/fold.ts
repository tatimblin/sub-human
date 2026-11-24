// fold: snapshot + the log after it + the documents → RoomState, the only reader logic (ARCHITECTURE §4). Pure: inputs
// are never mutated, and folding a snapshot plus the rest of the log gives the same state as folding the whole log.
// The host is the one writer and applies the rules before it appends, so fold records what the log says; it only
// drops what no rule could have produced from a sane host (an answer to a version nobody asked about, a kicked member's
// join), so that a bad line can't corrupt the state.
import type {
  Decision, Docs, Entry, Joined, LogLine, LogState, Member, MemberRecord, Plan, PlanEntry, PlanSent, PlanVersion, RoomState,
  SentPlan, Snapshot, TaskEntry, Update,
} from './entries.js';
import { NO_DOCS } from './entries.js';

/** How many recent updates RoomState keeps, for the catch-up only; news and counts come from updatesSince. */
export const BRIEF_RECENT = 30;
/** The host writes a snapshot every this many entries. */
export const SNAPSHOT_EVERY = 500;

export const EMPTY: LogState = { seq: 0, hash: '', members: [], plans: [], sent: [], tasks: [], recent: [] };

export function fold(snapshot: Snapshot | null, lines: readonly LogLine[], docs: Docs): RoomState {
  let s = snapshot?.state ?? EMPTY;
  for (const { entry, hash } of lines) {
    if (entry.seq <= s.seq) continue; // already in the snapshot
    s = { ...apply(s, entry), seq: entry.seq, hash };
  }
  return withDocs(s, docs);
}

/** A state from the log alone, for the rules: nobody here, since no document is read. */
export function asRoom(s: LogState): RoomState { return withDocs(s, NO_DOCS); }

export function takeSnapshot(state: RoomState): Snapshot {
  const members = state.members.map(({ machines: _w, presence: _p, activity: _a, focus: _f, ...m }): MemberRecord => m);
  return { v: 1, state: { ...state, members } };
}

/** Whether the host writes a snapshot after appending `seq`, given the seq of its last one. */
export function snapshotDue(seq: number, lastSnapshot: number, every: number = SNAPSHOT_EVERY): boolean {
  return seq - lastSnapshot >= every;
}

/**
 * What a member hasn't seen: others' updates, plans and tasks in lines after their cursor (news, the status count).
 * `from` is the member who acted, even on entries the host writes as system; a decision counts even when it's mine.
 * Asks, answers and accepts aren't counted: they reach the person as a card, a wake or context.
 */
export function updatesSince(lines: readonly LogLine[], me: string): { count: number; items: readonly News[] } {
  const items = lines.map(l => l.entry).filter((e): e is News => NEWS.has(e.kind) && (e.from !== me || e.kind === 'decision'));
  return { count: items.length, items };
}
export type News = Update | PlanEntry | Decision | PlanSent | TaskEntry;
const NEWS: ReadonlySet<Entry['kind']> = new Set<News['kind']>(['activity', 'finding', 'post', 'plan', 'decision', 'plan_sent', 'task']);

function withDocs(s: LogState, docs: Docs): RoomState {
  const members = s.members.map((m): Member => {
    const mine = docs.presence.filter(d => d.name === m.name).toSorted((a, b) => a.at - b.at);
    const here = mine.filter(d => d.state !== 'away');
    // only a member is here: a presence left behind by someone who left, or was kicked, counts for nothing
    const machines = m.kicked || m.machine === undefined ? [] : [...new Set(here.map(d => d.machine ?? m.machine ?? ''))];
    const presence = here.at(-1) ?? mine.at(-1);
    const activity = docs.activity.findLast(d => d.name === m.name);
    const focus = docs.focus.findLast(d => d.name === m.name);
    return { ...m, machines, ...(presence && { presence }), ...(activity && { activity }), ...(focus && { focus }) };
  });
  return { ...s, members };
}

function apply(s: LogState, e: Entry): LogState {
  switch (e.kind) {
    case 'joined': return join(s, e);
    case 'left':
      return { ...s, members: editMember(s.members, e.from, ({ machine: _m, ...m }) => m) };
    case 'kick': // permanent (R31): a name kicked before it ever joined is recorded too
      return s.members.some(m => m.name === e.name)
        ? { ...s, members: editMember(s.members, e.name, ({ machine: _m, ...m }) => ({ ...m, kicked: true })) }
        : { ...s, members: [...s.members, { name: e.name, since: e.at, kicked: true }] };
    case 'activity': case 'finding': case 'post': return remember(s, e);
    case 'plan': {
      const version: PlanVersion = { version: e.version, hash: e.hash, base: e.base, from: e.from, at: e.at, asked: [], answers: [] };
      const old = s.plans.find(p => p.name === e.name);
      if (e.version !== (old?.versions.at(-1)?.version ?? 0) + 1) return s; // versions go up by one, as the host's CAS does
      const plan: Plan = { name: e.name, scope: old?.scope ?? e.scope, versions: [...(old?.versions ?? []), version] };
      return { ...s, plans: old ? s.plans.map(p => (p === old ? plan : p)) : [...s.plans, plan] };
    }
    case 'plan_ask':
      return editLatest(s, e.name, e.version, v => ({ ...v, asked: union(v.asked, e.people) }));
    case 'plan_answer':
      return editLatest(s, e.name, e.version, v => (v.asked.includes(e.from) && !v.decision
        ? { ...v, answers: [...v.answers.filter(a => a.name !== e.from), { name: e.from, answer: e.answer, ...(e.note !== undefined && { note: e.note }) }] }
        : v));
    case 'decision':
      return editLatest(s, e.name, e.version, v => ({ ...v, decision: { agreed: e.agreed, changes: e.changes, at: e.at } }));
    case 'plan_sent': {
      const { kind: _k, seq: _s, id: _i, prev: _p, by: _b, machine: _m, ...rest } = e;
      const sent: SentPlan = { ...rest, answers: [] };
      return { ...s, sent: [...s.sent.filter(x => !sameSent(x, e.from, e.name, e.version)), sent] };
    }
    case 'plan_accept':
      return {
        ...s,
        sent: s.sent.map(x => (x.name === e.name && x.version === e.version && x.from !== e.from && (x.to ?? e.from) === e.from
          ? { ...x, answers: [...x.answers.filter(a => a.name !== e.from), { name: e.from, answer: e.answer, ...(e.note !== undefined && { note: e.note }) }] }
          : x)),
      };
    case 'task': {
      const has = s.tasks.some(t => t.n === e.task.n);
      return { ...s, tasks: has ? s.tasks.map(t => (t.n === e.task.n ? e.task : t)) : [...s.tasks, e.task] };
    }
    case 'invite': case 'admit': return s; // admission records; the host's net code reads them
  }
}

function join(s: LogState, e: Joined): LogState {
  const old = s.members.find(m => m.name === e.from);
  if (old?.kicked) return s;
  const where = { ...(e.repo !== undefined && { repo: e.repo }), ...(e.branch !== undefined && { branch: e.branch }) };
  if (!old) return { ...s, members: [...s.members, { name: e.from, machine: e.machine, since: e.at, kicked: false, ...where }] };
  // one joined per name: a member who is in keeps the machine they joined from
  if (old.machine !== undefined) return s;
  const { repo: _r, branch: _b, ...rest } = old;
  return { ...s, members: editMember(s.members, e.from, () => ({ ...rest, ...where, since: e.at, machine: e.machine })) };
}

function remember(s: LogState, e: Update): LogState {
  return { ...s, recent: [...s.recent, e].slice(-BRIEF_RECENT) };
}

function editMember(ms: readonly MemberRecord[], name: string, f: (m: MemberRecord) => MemberRecord): readonly MemberRecord[] {
  return ms.map(m => (m.name === name ? f(m) : m));
}

/** Edits a plan's latest version only: asks and answers on a superseded version are closed (R22). */
function editLatest(s: LogState, name: string, version: number, f: (v: PlanVersion) => PlanVersion): LogState {
  const plan = s.plans.find(p => p.name === name);
  const latest = plan?.versions.at(-1);
  if (!plan || latest?.version !== version) return s;
  const next: Plan = { ...plan, versions: [...plan.versions.slice(0, -1), f(latest)] };
  return { ...s, plans: s.plans.map(p => (p === plan ? next : p)) };
}

function sameSent(x: SentPlan, from: string, name: string, version: number): boolean {
  return x.from === from && x.name === name && x.version === version;
}

function union(xs: readonly string[], ys: readonly string[]): readonly string[] {
  return [...xs, ...ys.filter((y, i) => !xs.includes(y) && ys.indexOf(y) === i)];
}
