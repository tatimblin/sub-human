/**
 * plugin/sub-human/lib/room/consent.ts: the one fold of the room log into proposal / consent state, and the queries
 * over it. Pure: whether a person's answer is theirs comes in as trust (the store's RoomStore.trust: trust.ts).
 * stateLine and deliver() (render.ts, deliver.ts), the rows (lib/rows.ts) and the consent gate (lib/proposal.ts,
 * hooks/consent.ts) all read this, so they cannot disagree.
 *
 * fold(entries, trust) is memoized per trust on (length, first and last entry): the store's cached reads give the
 * same entry objects call after call, so a repeat fold of an unchanged log is a lookup. Its shape is types.ts Fold;
 * F.proposals keeps the log order of each hash's latest entry, and matrix's agreed / objected / missing list one name
 * per person (the seat that answered, else its first). The queries (proposal, proposals, answers, answered, decided)
 * each read the fold; answers() gives signed[name] = the id of name's current signoff and missing = approvers
 * without one, approvers defaulting to the proposal's.
 *
 * Semantics (one place):
 *   - Only valid 12-hex hashes (sha256/12 of the plan bytes, lib/proposal.ts) count.
 *   - The latest proposal entry per hash wins (approvers, path, author). Answers attach to the hash (the text),
 *     wherever they sit in the log.
 *   - A via=human answer counts only when trust says it is the person's: signed with the seat's key
 *     (which only hook processes hold), or unsigned from a seat that has no key at all (a room from before seat
 *     keys). A bad sig, or an unsigned answer from a seat with a key, is ignored.
 *   - Per person, the latest via=human signoff / objection wins: an objection voids that person's earlier
 *     signoff (and a later signoff replaces an objection).
 *   - One person in several seats: a proposal's `same` groups (lib/proposal.ts create: seats of one account) are one
 *     person. The newest answer from any seat of the group counts for every seat of it. A proposal with no `same`
 *     counts every seat: stricter, never wrong.
 *   - A decision is as recorded: the latest via=system decision with that proposal_hash closes it.
 *     state: 'blocked' when an approver's current answer is an objection, else 'agreed'.
 *   - A room plan's versions are its `plan` entries (lib/plans.ts put: via agent, written only by the host's
 *     compare-and-swap), each a version of one plan name; a version number at or below the plan's current one is
 *     ignored. A sign-off request is a proposal whose hash is a version's: a newer version of the same plan retires
 *     every undecided request for an older one, so it is no longer pending ('superseded'). Answers stay with their
 *     hash: none carry over to the newer version. Which plan and version a proposal asks about is read from the plan
 *     fold by its hash, never from the proposal's own fields (any member's append may carry them).
 *   - A draft is a request addressed to its own asker, its one approver (lib/proposal.ts ask draft): the author's
 *     check of a version they wrote, before anyone else is asked. It pends and is answered like any request (the
 *     author's Yes is their sign-off on the hash, so it still counts once the version goes out), and no decision is
 *     written on it (lib/proposal.ts decide).
 *   - revises(e, entries): the request a new version comes after (open, or not agreed), its asker and objectors: the
 *     people whose Claudes deliver.ts wakes with that version, so a revision comes back to who asked.
 * Recording (lib/proposal.ts answer, then decide) is idempotent on top of this: one answer per seat per hash,
 * so the fold's "latest" and the decision's refs agree for everything the hooks write.
 */

import { normalize } from './rules.ts';
import { parseEntry } from './validate.ts';
import { assertNever } from '../../mod/core/never.ts';
import { isProposalHash as isHash } from '../text.ts';
import type { Stance, Entry, EntryOf, Fold, Matrix, PlanState, PlanVersion, ProposalEntry, ProposalState, Trust } from './types.ts';

type Entries = readonly (Entry | null | undefined)[];
/** A proposal entry with a hash the fold can key it by. */
const isProposal = (e: EntryOf<'proposal'>): e is ProposalEntry => isHash(e.hash);


/** The last few folds per trust: (length, first, last entry) -> F. */
const MEMO_SLOTS = 4;
const memo = new WeakMap<Trust, { n: number; first: unknown; last: unknown; f: Fold }[]>();

const isEntries = (v: Entries | null | undefined): v is Entries => Array.isArray(v);

function fold(entries: Entries | null | undefined, trust: Trust): Fold {
  const list = isEntries(entries) ? entries : [];
  const n = list.length, first = n ? list[0] : null, last = n ? list[n - 1] : null;
  let slots = memo.get(trust);
  if (!slots) memo.set(trust, slots = []);
  const hit = slots.find(x => x.n === n && x.first === first && x.last === last);
  if (hit) return hit.f;
  const f = compute(list, trust);
  slots.unshift({ n, first, last, f });
  if (slots.length > MEMO_SLOTS) slots.pop();
  return f;
}

/** A proposal's same groups as the fold reads them: names among approvers, disjoint, 2+ each (older entries: none). */
function groupsOf(same: unknown, approvers: string[]): string[][] {
  if (!Array.isArray(same)) return [];
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const g of same) {
    if (!Array.isArray(g)) continue;
    const names = [...new Set(g.filter((n): n is string => typeof n === 'string' && approvers.includes(n) && !seen.has(n)))];
    if (names.length < 2) continue;
    for (const n of names) seen.add(n);
    out.push(names);
  }
  return out;
}

function compute(list: Entries, trust: Trust): Fold {
  const proposals = new Map<string, ProposalState>();
  const answers = new Map<string, Map<string, Stance>>();
  // per hash and seat, its latest answer and where it sits in the log: a same group's newest wins
  const latest = new Map<string, Map<string, { at: number; a: Stance }>>();
  let seq = 0;
  const decisions = new Map<string, Entry>();
  const superseded = new Map<string, string>();
  const plans = new Map<string, PlanState>();
  const versions = new Map<string, PlanVersion>();
  for (const raw of list) {
    // only a proposal, a plan or a line naming one can change the state: the rest is passed over (most of a log is chat)
    if (!raw || (raw.kind !== 'proposal' && raw.kind !== 'plan' && raw.proposal_hash === undefined)) continue;
    const e = parseEntry(normalize(raw));
    if (!e) continue; // a newer host's kind: no state this version folds
    if (e.kind === 'plan') {
      const v = versionIn(e);
      const had = v && plans.get(v.plan);
      if (!v || (had && v.version <= had.current.version)) continue;
      if (had) { had.versions.push(v); had.current = v; } else plans.set(v.plan, { name: v.plan, versions: [v], current: v });
      versions.set(v.hash, v);
      continue;
    }
    if (e.kind === 'proposal') {
      if (!isProposal(e)) continue;
      proposals.delete(e.hash);
      const approvers = Array.isArray(e.approvers) ? e.approvers : [];
      const draft = e.to === e.from && approvers.length === 1 && approvers[0] === e.from;
      proposals.set(e.hash, { id: e.id, hash: e.hash, from: e.from, approvers, same: groupsOf(e.same, approvers), path: e.path || null, draft, entry: e });
      continue;
    }
    const h = e.proposal_hash;
    if (!isHash(h)) continue;
    switch (e.kind) {
      case 'decision': if (e.via === 'system') decisions.set(h, e); break;
      case 'signoff': case 'objection': {
        if (e.via !== 'human' || typeof e.from !== 'string' || trust(raw) === 'unverified') break;
        let byName = answers.get(h);
        if (!byName) answers.set(h, byName = new Map<string, Stance>());
        const a: Stance = { kind: e.kind, id: e.id, entry: e };
        byName.set(e.from, a);
        let marks = latest.get(h);
        if (!marks) latest.set(h, marks = new Map<string, { at: number; a: Stance }>());
        marks.set(e.from, { at: ++seq, a });
        break;
      }
      // a line that names a proposal and decides nothing (a say about it)
      case 'say': case 'question': case 'status': case 'task_req': case 'member_joined': case 'member_left': case 'task':
        break;
      default: assertNever(e, 'entry kind');
    }
  }
  // a request for an older version of a plan, undecided: retired by the plan's current version
  for (const p of proposals.values()) {
    const v = versions.get(p.hash);
    const cur = v && plans.get(v.plan)?.current;
    if (cur && cur.version > v.version && cur.hash !== p.hash && !decisions.has(p.hash)) superseded.set(p.hash, cur.hash);
  }

  const ownAnswer = (hash: string, name: string): Stance | null => { const m = answers.get(hash); return (m && m.get(name)) ?? null; };
  /** The seats of name's person on hash: its same group, else name alone. */
  const groupOf = (groups: string[][], name: string): string[] => groups.find(g => g.includes(name)) ?? [name];
  /** The answer that counts for a person's seats: the newest answer of any of them. */
  function current(hash: string, seats: string[]): Stance | null {
    const m = latest.get(hash);
    if (!m) return null;
    let best: { at: number; a: Stance } | null = null;
    for (const n of seats) { const x = m.get(n); if (x && (!best || x.at > best.at)) best = x; }
    return best ? best.a : null;
  }
  const answerOf = (hash: string, name: string): Stance | null => current(hash, groupOf(proposals.get(hash)?.same ?? [], name));

  function matrix(hash: string, approversArg?: string[]): Matrix {
    const approvers = Array.isArray(approversArg) ? approversArg : proposals.get(hash)?.approvers ?? [];
    const groups = groupsOf(proposals.get(hash)?.same, approvers);
    const out: Matrix['answers'] = {}, signed: Matrix['signed'] = {}, also: Matrix['also'] = {};
    const agreed: string[] = [], objected: string[] = [], missing: string[] = [];
    const done = new Set<string>();
    let people = 0;
    for (const first of approvers) {
      if (done.has(first)) continue;
      const seats = groupOf(groups, first);
      const a = current(hash, seats);
      for (const n of seats) {
        done.add(n);
        out[n] = a ? { id: a.id, kind: a.kind } : null;
        signed[n] = a && a.kind === 'signoff' ? a.id : null;
      }
      // the person by the seat that answered, else its first
      const shown = a && seats.includes(a.entry.from) ? a.entry.from : first;
      if (seats.length > 1) also[shown] = seats.filter(n => n !== shown);
      (!a ? missing : a.kind === 'signoff' ? agreed : objected).push(shown);
      people++;
    }
    return { hash, approvers, answers: out, signed, agreed, objected, missing, also, people,
      unsigned: approvers.filter(n => signed[n] == null), complete: approvers.length > 0 && missing.length === 0 };
  }

  const open = (p: ProposalState, name: string) => p.approvers.includes(name) && !decisions.has(p.hash) && !superseded.has(p.hash);
  const pending = (name: string | null | undefined): ProposalState[] => (name ? [...proposals.values()].filter(p => open(p, name) && !answerOf(p.hash, name)) : []);
  const answerable = (name: string | null | undefined): ProposalState[] => (name ? [...proposals.values()].filter(p => open(p, name) && !ownAnswer(p.hash, name)) : []);

  function status(hash: string): ReturnType<Fold['status']> {
    const p = proposals.get(hash);
    if (!p) return null;
    const m = matrix(hash);
    const d = decisions.get(hash) ?? null;
    return { proposal: p, decision: d, matrix: m, state: !d ? (superseded.has(hash) ? 'superseded' : 'open') : m.objected.length ? 'blocked' : 'agreed' };
  }

  const versionOf = (hash: string): PlanVersion | null => versions.get(hash) ?? null;
  return { proposals, answers, decisions, superseded, plans, versionOf, answerOf, ownAnswer, matrix, pending, answerable, status };
}

/** A plan entry as a version, or null when it lacks what one needs (a hand-edited or older line). */
function versionIn(e: EntryOf<'plan'>): PlanVersion | null {
  const { plan, version, base, hash } = e;
  if (typeof plan !== 'string' || !plan || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1 || !isHash(hash)) return null;
  return { plan, version, base: typeof base === 'number' ? base : version - 1, hash, from: e.from, for: typeof e.for === 'string' ? e.for : e.from,
    summary: typeof e.summary === 'string' ? e.summary : '', id: e.id, at: e.at, path: e.path || null };
}

// ---------- queries ----------
const proposal = (hash: string | undefined, entries: Entries, trust: Trust): ProposalEntry | null => {
  const p = hash === undefined ? undefined : fold(entries, trust).proposals.get(hash);
  return p ? p.entry : null;
};
const proposals = (entries: Entries, trust: Trust): ProposalEntry[] => [...fold(entries, trust).proposals.values()].map(p => p.entry);
const approversOf = (p: { approvers?: unknown } | null | undefined): string[] => (p && Array.isArray(p.approvers) ? p.approvers as string[] : []); // a proposal entry's, as its writer gave them
function answers(hash: string, approvers: string[] | null | undefined, entries: Entries, trust: Trust): { hash: string; signed: Record<string, number | null>; missing: string[]; complete: boolean } {
  const m = fold(entries, trust).matrix(hash, Array.isArray(approvers) ? approvers : undefined);
  return { hash, signed: m.signed, missing: m.unsigned, complete: !!hash && m.approvers.length > 0 && m.unsigned.length === 0 };
}
const answered = (name: string, hash: string, entries: Entries, trust: Trust): Entry | null => fold(entries, trust).answerOf(hash, name)?.entry ?? null;
const decided = (hash: string | undefined, entries: Entries, trust: Trust): Entry | null => (hash === undefined ? null : fold(entries, trust).decisions.get(hash) ?? null);

/** The sign-off request a new plan version e answers (deliver.ts wakes its asker and objectors with it). */
interface Revised { hash: string; plan: string; version: number; asker: string; objected: string[] }
/**
 * The sign-off request plan version e comes after: the request on the version that was current just before e (same
 * plan), still open or not agreed (an approver objected), with who asked and who objected; null for any other entry,
 * a first version, a version nobody asked about, or one already agreed. entries: the log (e's own line may be in it).
 */
function revises(e: Entry, entries: Entries, trust: Trust): Revised | null {
  if (e.kind !== 'plan' || typeof e.plan !== 'string' || typeof e.version !== 'number') return null;
  const before = entries.filter(x => !!x && x.id < e.id);
  const f = fold(before, trust);
  const cur = f.plans.get(e.plan)?.current;
  if (!cur || cur.version >= e.version) return null;
  const st = f.status(cur.hash);
  if (!st || st.state === 'agreed' || st.state === 'superseded') return null;
  return { hash: cur.hash, plan: cur.plan, version: cur.version, asker: st.proposal.from, objected: st.matrix.objected };
}

export { fold, groupsOf, proposal, proposals, answers, answered, decided, approversOf, revises };
export type { Revised };
