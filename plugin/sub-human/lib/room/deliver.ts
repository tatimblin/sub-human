/**
 * plugin/sub-human/lib/room/deliver.ts: what one log entry is for one seat. Pure (the consent state comes from
 * consent.ts fold over the entries passed in, judged with the store's trust).
 *
 *   deliver(me, e, {entries?, trust, note?}) -> 'none' | 'context' | 'notice' | 'wake'
 *       me = {name, role}; entries: the log as of now (judged: a proposal I already answered or that was decided,
 *       the proposal a decision or an answer belongs to, the request a task entry applied); without them the
 *       entry-only answer, which wakes for a superset of what the judged one wakes for (the tail's first filter).
 *       note: the room Claude's row note for a member_joined (lib/rows.ts joinNote; '' when unknown).
 *     none     never shown: my own entries (hook-written system decision/task entries are not "mine"), and what
 *              concerns neither me nor the room's state
 *     context  for Claude, no wake: the tail's room context, carried beside my next prompt
 *     notice   for the person, no wake: a member's group chat (another person's own words not addressed to me, a
 *              join or leave, a host move). Claude gets a copy as context.
 *     wake     what needs Claude now
 *   The rules, by role:
 *     member wake: to=me or @me (in an agent's or a person's words); a proposal naming me that I have not answered
 *       (and is not decided); a decision on a proposal I am in; a `task` assigning me (owner me) that someone else
 *       asked for (its req is not mine); an objection on my own proposal.
 *     member notice: another person's say (not to me, no @me), another member's join or leave (not the room
 *       Claude's); and what asks the person, not the model: the room line that the log waits to split
 *       (restart the old sessions), a decision on a proposal I am in that needs no wake, another approver's objection
 *       on a proposal I approve. Everything else that is not mine is context.
 *     the room's Claude (role claude) wake: to=claude only (a person's leading @claude tag; an "@claude" inside the
 *       text is just words); task_req; an objection on its own proposal; another member's member_joined whose row
 *       note says no row is running (or is unknown). Everything else is context, decisions included: an objected
 *       one follows the objection that already woke it, and an agreed one needs nothing from it.
 *     card answers (both roles): a signoff is context (the decision carries it); an objection wakes the proposal's
 *       author only (to revise).
 *     decisions (judged): context for the member whose answer completed it (the card's own reply, hooks consent,
 *       already told that Claude), and an objected decision is context for all but the proposer.
 *   lane(me, e, entries?, trust?) -> 'push' | 'pull' | 'none'   deliver's first step (push: notice or wake; pull:
 *       context), kept for its table tests
 *   mentions(text, name) -> bool   "@name" anywhere in the text (case-insensitive, not part of a longer name)
 */

import { normalize } from './rules.ts';
import { proposal, answered, decided, approversOf } from './consent.ts';
import { NO_TRUST } from './trust.ts';
import type { Delivery, Entry, Lane, LaneViewer, Trust } from './types.ts';

/** What deliver() judges an entry against. */
interface DeliverState {
  entries?: readonly Readonly<Entry>[] | undefined;
  trust?: Trust;
  note?: string | undefined;
}

const esc = (s: string): string => s.replace(/[.]/g, '\\.');
const mentions = (text: unknown, name: string): boolean => new RegExp(`(^|[^A-Za-z0-9_.-])@${esc(name)}(?![A-Za-z0-9_-])`, 'i').test(String(text ?? ''));
/** Whether name is in proposal p: an approver or its author. */
const inProposal = (p: Entry | null, name: string): boolean => !!p && (approversOf(p).includes(name) || p.from === name);
const isMove = (e: Entry): boolean => e.kind === 'member_joined' || e.kind === 'member_left';
/** The room Claude's row note says that row must be spawned (lib/rows.ts joinNote). */
const SPAWN_NOTE = /no row running|is not running/;

function lane(me: LaneViewer | null | undefined, e: Entry, entries?: readonly Readonly<Entry>[], trust: Trust = NO_TRUST): Lane {
  const name = (me && me.name) as string; // no seat: matches no from, to or approver
  const roomClaude = !!me && me.role === 'claude';
  const n = normalize(e);
  if (n.from === name && !(n.via === 'system' && (n.kind === 'decision' || n.kind === 'task'))) return 'none';
  if (n.to === name || (!roomClaude && mentions(n.text, name))) return 'push';
  if ((n.kind === 'signoff' || n.kind === 'objection') && n.proposal_hash) {
    if (n.kind === 'signoff') return 'pull';
    if (!entries) return 'push';
    const p = proposal(n.proposal_hash, entries, trust);
    return p && p.from === name ? 'push' : 'pull';
  }
  if (n.kind === 'decision' && entries && quietDecision(name, n, entries, trust)) return 'pull';
  if (roomClaude) return n.kind === 'task_req' ? 'push' : 'pull';
  if (n.kind === 'proposal' && approversOf(n).includes(name)) {
    if (!entries || !n.hash) return 'push';
    return answered(name, n.hash, entries, trust) || decided(n.hash, entries, trust) ? 'pull' : 'push';
  }
  if (n.kind === 'decision') {
    if (approversOf(n).includes(name) || !entries) return 'push';
    return inProposal(proposal(n.proposal_hash, entries, trust), name) ? 'push' : 'pull';
  }
  if (n.kind === 'task' && n.owner === name) {
    if (!n.req || !entries) return 'push';
    const req = entries.find(x => x.id === n.req);
    return req && (req.by || req.from) === name ? 'pull' : 'push';
  }
  if (n.via === 'human') return 'push'; // a group chat: every person's own words reach every member
  return 'pull';
}

/**
 * A decision that needs no wake for name: name's answer completed it (consent told that Claude in the card's
 * reply), or it is an objected decision on a proposal name did not write.
 */
function quietDecision(name: string, d: Entry, entries: readonly Readonly<Entry>[], trust: Trust): boolean {
  const refs = new Set(d.refs ?? []);
  let last: Entry | null = null;
  for (const x of entries) if (refs.has(x.id) && (x.kind === 'signoff' || x.kind === 'objection') && (!last || x.id > last.id)) last = x;
  if (last && last.from === name && last.via === 'human') return true;
  if (/^objected:/.test(String(d.text || ''))) {
    const p = proposal(d.proposal_hash, entries, trust);
    return !(p && p.from === name);
  }
  return false;
}

/** A member's pushed entry that is group chat, not a request: another person's own words not addressed to me. */
const chat = (me: LaneViewer, e: Entry): boolean => e.via === 'human' && e.kind === 'say' && e.to !== me.name && !mentions(e.text, String(me.name));

/**
 * A pulled entry the person must see, though their Claude needs no wake: the outcome of a proposal they are in (a
 * decision their own answer completed, or an objected one they did not write) and another approver's objection on a
 * proposal they approve. Live, these reached only the model as context.
 */
function personSees(name: string, e: Entry, entries: readonly Readonly<Entry>[] | undefined, trust: Trust): boolean {
  if (!entries || !e.proposal_hash) return false;
  if (e.kind !== 'decision' && e.kind !== 'objection') return false;
  const p = proposal(e.proposal_hash, entries, trust);
  return e.kind === 'decision' ? inProposal(p, name) : !!p && approversOf(p).includes(name);
}

function deliver(me: LaneViewer | null | undefined, e: Entry, { entries, trust = NO_TRUST, note = '' }: DeliverState = {}): Delivery {
  const l = lane(me, e, entries, trust);
  const name = me && me.name;
  if (me && me.role === 'claude') {
    if (l === 'push') return 'wake';
    if (e.kind === 'member_joined' && e.from !== name && (!note || SPAWN_NOTE.test(note))) return 'wake';
    return l === 'pull' ? 'context' : 'none';
  }
  if ((isMove(e) && e.via === 'system' && e.from !== name && e.from !== 'claude')) return 'notice';
  if (l === 'push') return me && (isMove(e) || chat(me, e)) ? 'notice' : 'wake';
  if (l === 'pull' && me && personSees(String(name), e, entries, trust)) return 'notice';
  return l === 'pull' ? 'context' : 'none';
}

export { deliver, lane, mentions };
export type { DeliverState };
