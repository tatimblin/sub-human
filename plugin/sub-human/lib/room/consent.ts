/**
 * plugin/sub-human/lib/room/consent.ts: the one fold of the room log into proposal / consent state, and the queries
 * over it. Pure: whether a person's answer is theirs comes in as trust (the store's RoomStore.trust: trust.ts).
 * stateLine and deliver() (render.ts, deliver.ts), the rows (lib/rows.ts) and the consent gate (lib/proposal.ts,
 * hooks/handlers/consent.ts) all read this, so they cannot disagree.
 *
 *   fold(entries, trust) -> F   memoized per trust on (length, first and last entry): the store's cached reads give
 *                  the same entry objects call after call, so a repeat fold of an unchanged log is a lookup
 *     F.proposals  Map hash -> {id, hash, from, approvers, same, path, entry}   the LATEST proposal entry per hash,
 *                  Map order = log order of that latest entry; same: its approvers that are one person (groupsOf)
 *     F.answers    Map hash -> Map name -> {kind: 'signoff'|'objection', id, entry}   per seat, the latest answer
 *     F.answerOf(hash, name) -> answer|null   the answer that counts for name: the latest of its person's seats
 *     F.ownAnswer(hash, name) -> answer|null  name's own (lib/proposal.ts answer: one per seat)
 *     F.decisions  Map hash -> entry   the latest via=system decision per hash
 *     F.superseded Map hash -> newer hash   undecided proposals a later one retired (below)
 *     F.matrix(hash, approvers?) -> {hash, approvers, answers: {name: {id, kind}|null}, signed: {name: id|null},
 *                  agreed, objected, missing (no answer), unsigned (no signoff), complete (everyone answered),
 *                  also: {name: [its person's other seats]}, people (how many people the approvers are)}
 *                  agreed / objected / missing list one name per person: the seat that answered, else its first
 *     F.pending(name) -> [proposal]   undecided, unretired proposals naming name that name has not answered (log order)
 *     F.answerable(name) -> [proposal]   the same, but another seat of name's person answering leaves one in: the
 *                  seat's own answer still counts, and overrides (the hooks record an answer from a card already open)
 *     F.status(hash) -> {proposal, decision, matrix, state: 'open'|'agreed'|'blocked'|'superseded'}|null
 *   Queries (each a read of fold(entries, trust)):
 *     proposal(hash, entries, trust) -> Entry|null     the latest proposal with that hash
 *     proposals(entries, trust) -> Entry[]             the latest entry per distinct hash, in log order
 *     answers(hash, approvers, entries, trust) -> {hash, signed: {name: id|null}, missing, complete}
 *         approvers default to that proposal's. signed[name] = the id of name's current signoff (the latest answer
 *         wins: an objection voids an earlier signoff); missing = approvers with no current signoff.
 *     answered(name, hash, entries, trust) -> Entry|null   name's latest via=human answer on hash
 *     decided(hash, entries, trust) -> Entry|null      the decision entry for that hash
 *     approversOf(p) -> [name]
 *   titleOf(e) -> string           the title a proposal entry carries ("proposal HASH: title"), '' for none
 *
 * Semantics (one place):
 *   - Entries are read through normalize() (legacy plan_rev / plan_hash / concern / agree).
 *   - Only valid 12-hex hashes (sha256/12 of the plan bytes, lib/proposal.ts) count.
 *   - The latest proposal entry per hash wins (approvers, path, author). Answers attach to the hash (the text),
 *     wherever they sit in the log.
 *   - A via=human answer counts only when trust says it is the person's: signed with the seat's key
 *     (which only hook processes hold), or unsigned from a seat that has no key at all (a room from before seat
 *     keys). A bad sig, or an unsigned answer from a seat with a key, is ignored.
 *   - Per person, the latest via=human signoff / objection wins: an objection voids that person's earlier
 *     signoff (and a later signoff replaces an objection). A legacy via=human `revoke` clears the answer.
 *   - One person in several seats: a proposal's `same` groups (lib/proposal.ts create: seats of one account) are one
 *     person. The newest answer from any seat of the group counts for every seat of it, and a revoke from one clears
 *     the group. A proposal with no `same` (an older proposer's, or one person per seat) counts every seat: stricter,
 *     never wrong.
 *   - A decision is as recorded: the latest via=system decision with that proposal_hash closes it.
 *     state: 'blocked' when an approver's current answer is an objection, else 'agreed'.
 *   - A revision retires: a proposal entry retires every earlier undecided proposal with the same `from` and the
 *     same title (the "proposal HASH: title" text), so it is no longer pending ('superseded'). Answers stay with
 *     their hash: none carry over to the newer one. Another sender's proposal with the same title stays open. A
 *     later entry for a retired hash (proposed again) brings it back.
 * Recording (lib/proposal.ts answer, then decide) is idempotent on top of this: one answer per seat per hash,
 * so the fold's "latest" and the decision's refs agree for everything the hooks write.
 */

import { normalize } from './rules.ts';
import { parseEntry } from './validate.ts';
import { assertNever } from '../../mod/core/never.ts';
import { isProposalHash as isHash } from '../text.ts';
import type { Answer, Entry, EntryOf, Fold, Matrix, ProposalEntry, ProposalState, Trust } from './types.ts';

type Entries = readonly (Entry | null | undefined)[];
/** A proposal entry with a hash the fold can key it by. */
const isProposal = (e: EntryOf<'proposal'>): e is ProposalEntry => isHash(e.hash);

/** The title a proposal entry carries ("proposal HASH: title"), '' for none. */
const titleOf = (e: Pick<Entry, 'text'>): string => { const m = /^proposal [0-9a-f]{6,64}:\s*(.+)/.exec(String(e.text ?? '')); return m ? m[1].trim() : ''; };

/** The last few folds per trust: (length, first, last entry) -> F. */
const MEMO_SLOTS = 4;
const memo = new WeakMap<Trust, { n: number; first: unknown; last: unknown; f: Fold }[]>();

function fold(entries: Entries | null | undefined, trust: Trust): Fold {
  const list = Array.isArray(entries) ? entries : [];
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
  const answers = new Map<string, Map<string, Answer>>();
  // per hash and seat, its latest answer or revoke (null) and where it sits in the log: a same group's newest wins
  const latest = new Map<string, Map<string, { at: number; a: Answer | null }>>();
  let seq = 0;
  const decisions = new Map<string, Entry>();
  const superseded = new Map<string, string>();
  for (const raw of list) {
    // only a proposal or a line naming one (current or legacy fields) can change the state: the rest is passed over
    // without normalizing (most of a log is chat)
    if (!raw || (raw.kind !== 'proposal' && raw.kind !== 'plan_rev' && raw.proposal_hash === undefined && raw.plan_hash === undefined)) continue;
    const e = parseEntry(normalize(raw));
    if (!e) continue; // a newer host's kind: no state this version folds
    if (e.kind === 'proposal') {
      if (!isProposal(e)) continue;
      proposals.delete(e.hash);
      superseded.delete(e.hash);
      const t = titleOf(e);
      if (t) {
        for (const p of proposals.values()) {
          if (p.from === e.from && !decisions.has(p.hash) && !superseded.has(p.hash) && titleOf(p.entry) === t) superseded.set(p.hash, e.hash);
        }
      }
      const approvers = Array.isArray(e.approvers) ? e.approvers : [];
      proposals.set(e.hash, { id: e.id, hash: e.hash, from: e.from, approvers, same: groupsOf(e.same, approvers), path: e.path || null, entry: e });
      continue;
    }
    const h = e.proposal_hash;
    if (!isHash(h)) continue;
    switch (e.kind) {
      case 'decision': if (e.via === 'system') decisions.set(h, e); break;
      case 'signoff': case 'objection': case 'revoke': {
        if (e.via !== 'human' || typeof e.from !== 'string' || trust(raw) === 'unverified') break;
        const mark = (a: Answer | null) => {
          if (!latest.has(h)) latest.set(h, new Map());
          latest.get(h)!.set(e.from, { at: ++seq, a });
        };
        if (e.kind !== 'revoke') {
          if (!answers.has(h)) answers.set(h, new Map());
          const a: Answer = { kind: e.kind, id: e.id, entry: e };
          answers.get(h)!.set(e.from, a);
          mark(a);
        } else if (answers.has(h)) {
          answers.get(h)!.delete(e.from);
          mark(null);
        }
        break;
      }
      // a line that names a proposal and decides nothing (a say about it, an agree or concern normalize left as is)
      case 'say': case 'question': case 'status': case 'task_req': case 'member_joined': case 'member_left': case 'task':
      case 'host_changed': case 'concern': case 'agree': case 'plan_rev':
        break;
      default: assertNever(e, 'entry kind');
    }
  }

  const ownAnswer = (hash: string, name: string): Answer | null => { const m = answers.get(hash); return (m && m.get(name)) || null; };
  /** The seats of name's person on hash: its same group, else name alone. */
  const groupOf = (groups: string[][], name: string): string[] => groups.find(g => g.includes(name)) || [name];
  /** The answer that counts for a person's seats: the newest answer or revoke of any of them. */
  function current(hash: string, seats: string[]): Answer | null {
    const m = latest.get(hash);
    if (!m) return null;
    let best: { at: number; a: Answer | null } | null = null;
    for (const n of seats) { const x = m.get(n); if (x && (!best || x.at > best.at)) best = x; }
    return best ? best.a : null;
  }
  const answerOf = (hash: string, name: string): Answer | null => current(hash, groupOf(proposals.get(hash)?.same ?? [], name));

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
    const d = decisions.get(hash) || null;
    return { proposal: p, decision: d, matrix: m, state: !d ? (superseded.has(hash) ? 'superseded' : 'open') : m.objected.length ? 'blocked' : 'agreed' };
  }

  return { proposals, answers, decisions, superseded, answerOf, ownAnswer, matrix, pending, answerable, status };
}

// ---------- queries ----------
const proposal = (hash: string | undefined, entries: Entries, trust: Trust): ProposalEntry | null => {
  const p = hash === undefined ? undefined : fold(entries, trust).proposals.get(hash);
  return p ? p.entry : null;
};
const proposals = (entries: Entries, trust: Trust): ProposalEntry[] => [...fold(entries, trust).proposals.values()].map(p => p.entry);
const approversOf = (p: { approvers?: unknown } | null | undefined): string[] => (p && Array.isArray(p.approvers) ? p.approvers : []);
function answers(hash: string, approvers: string[] | null | undefined, entries: Entries, trust: Trust): { hash: string; signed: Record<string, number | null>; missing: string[]; complete: boolean } {
  const m = fold(entries, trust).matrix(hash, Array.isArray(approvers) ? approvers : undefined);
  return { hash, signed: m.signed, missing: m.unsigned, complete: !!hash && m.approvers.length > 0 && m.unsigned.length === 0 };
}
const answered = (name: string, hash: string, entries: Entries, trust: Trust): Entry | null => fold(entries, trust).answerOf(hash, name)?.entry ?? null;
const decided = (hash: string | undefined, entries: Entries, trust: Trust): Entry | null => (hash === undefined ? null : fold(entries, trust).decisions.get(hash) || null);

export { fold, groupsOf, titleOf, proposal, proposals, answers, answered, decided, approversOf };
