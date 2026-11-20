/**
 * plugin/sub-human/lib/room/deliver.ts: what one log entry is for one seat. Pure (the consent state comes from
 * consent.ts fold over the entries passed in, judged with the store's trust).
 *
 *   deliver(me, e, {entries?, trust}) -> 'none' | 'context' | 'notice' | 'wake'
 *       me = {name, role}; entries: the log as of now (judged: a proposal I already answered or that was decided,
 *       the proposal a decision or an answer belongs to, the request a task entry applied); without them the
 *       entry-only answer, which wakes for a superset of what the judged one wakes for (the tail's first filter).
 *     none     never shown: my own entries (hook-written system decision/task entries are not "mine"), and what
 *              concerns neither me nor the room's state
 *     context  for Claude, no wake: the tail's room context, carried beside my next prompt
 *     notice   for the person, no wake: a member's group chat (another person's own words not addressed to me, a
 *              join or leave, a host move). Claude gets a copy as context.
 *     wake     what needs Claude now
 *   The rules, by role:
 *     member wake: to=me or @me (in an agent's or a person's words); a proposal naming me that I have not answered
 *       (and is not decided); a `task` assigning me (owner me) that someone else asked for (its req is not mine); an
 *       objection on my own proposal. A new version of a plan wakes nobody: the request on it does, once its author
 *       sends it ("Plan paging v2 is ready · maya's edit"). A decision never wakes: it reports, it asks nothing.
 *     member notice: another person's say (not to me, no @me), another member's join or leave (not the room
 *       Claude's), the room's line for a machine its PIN let in (render.ts linkJoined: its check and the kick; the bare
 *       "joined" after it is not drawn again, render.ts announced; none for the one it names), a task someone else added with me as its suggested owner (`suggest`); and what asks the person, not the model: the room line that the log waits to split
 *       (restart the old sessions), an agreed decision on a proposal I am in (its approvers and author: "Plan paging
 *       v2 agreed"; one not agreed is none, since each objection's own line said it: context only without the log),
 *       another approver's
 *       objection on a proposal I approve. A plan version is context (its request is what a person sees).
 *       Everything else that is not mine is context.
 *     the room's session (role claude) reads nothing: every entry is none (it keeps no rows; each member's room row
 *       is that member's hooks module's).
 *     card answers (both roles): a signoff is context (the decision carries it); an objection wakes the proposal's
 *       author only (to revise).
 *     decisions: an agreed one is a notice for the members in its proposal, context for everyone else; one not agreed
 *       is none once an objection on it is in the log (that objection was its one line: saidBefore); never a wake.
 *   lane(me, e, entries?, trust?) -> 'push' | 'pull' | 'none'   deliver's first step (push: notice or wake; pull:
 *       context), kept for its table tests
 *   mentions(text, name) -> bool   "@name" anywhere in the text (case-insensitive, not part of a longer name)
 */

import { normalize } from './rules.ts';
import { proposal, answered, decided, approversOf } from './consent.ts';
import { NO_TRUST } from './trust.ts';
import { linkJoined } from './render.ts';
import type { Delivery, Entry, Lane, LaneViewer, Trust } from './types.ts';

/** What deliver() judges an entry against. */
interface DeliverState {
  entries?: readonly Readonly<Entry>[] | undefined;
  trust?: Trust;
}

const esc = (s: string): string => s.replace(/[.]/g, '\\.');
const mentions = (text: unknown, name: string): boolean => new RegExp(`(^|[^A-Za-z0-9_.-])@${esc(name)}(?![A-Za-z0-9_-])`, 'i').test(String(text ?? ''));
/** Whether name is in proposal p: an approver or its author. */
const inProposal = (p: Entry | null, name: string): boolean => !!p && (approversOf(p).includes(name) || p.from === name);
const isMove = (e: Entry): boolean => e.kind === 'member_joined' || e.kind === 'member_left';

function lane(me: LaneViewer | null | undefined, e: Entry, entries?: readonly Readonly<Entry>[], trust: Trust = NO_TRUST): Lane {
  const name = (me && me.name) as string; // no seat: matches no from, to or approver
  const roomClaude = !!me && me.role === 'claude';
  const n = normalize(e);
  if (n.from === name && !(n.via === 'system' && (n.kind === 'decision' || n.kind === 'task'))) return 'none';
  if (roomClaude) return 'none'; // the room session reads nothing
  if (n.kind === 'decision') return 'pull'; // an outcome, not a request: personSees makes it a notice for those in it
  if (n.to === name || mentions(n.text, name)) return 'push';
  if ((n.kind === 'signoff' || n.kind === 'objection') && n.proposal_hash) {
    if (n.kind === 'signoff') return 'pull';
    if (!entries) return 'push';
    const p = proposal(n.proposal_hash, entries, trust);
    return p && p.from === name ? 'push' : 'pull';
  }
  if (n.kind === 'proposal' && approversOf(n).includes(name)) {
    if (!entries || !n.hash) return 'push';
    return answered(name, n.hash, entries, trust) || decided(n.hash, entries, trust) ? 'pull' : 'push';
  }
  if (n.kind === 'task' && n.owner === name) {
    if (!n.req || !entries) return 'push';
    const req = entries.find(x => x.id === n.req);
    return req && (req.by || req.from) === name ? 'pull' : 'push';
  }
  if (n.via === 'human') return 'push'; // a group chat: every person's own words reach every member
  return 'pull';
}

/** A task just added with name as its suggested owner, by someone else (lib/tasks.ts apply: suggest is never the
 * owner; they claim it themselves): their person is told, their Claude is not woken. */
function suggestedTo(name: string, e: Entry, entries: readonly Readonly<Entry>[] | undefined): boolean {
  if (e.op !== 'add' || e.suggest !== name || e.owner) return false;
  const req = entries && e.req ? entries.find(x => x.id === e.req) : null;
  return !(req && (req.by || req.from) === name);
}

/** A member's pushed entry that is group chat, not a request: another person's own words not addressed to me. */
const chat = (me: LaneViewer, e: Entry): boolean => e.via === 'human' && e.kind === 'say' && e.to !== me.name && !mentions(e.text, String(me.name));

/** A decision that did not agree (its text "objected: … · agreed: …"; one that agreed reads "agreed: …"). */
const notAgreed = (e: Entry): boolean => /^objected: /.test(String(e.text ?? ''));

/** A decision that did not agree, after an objection on its proposal: each objection already reached every member once
 * (a wake for the author, with its note; a notice for another approver; context for the rest) and the signoffs before
 * it were context, so the decision would only say it again. Without the log to judge by it stays context. */
const saidBefore = (e: Entry, entries: readonly Readonly<Entry>[] | undefined): boolean => e.kind === 'decision' && notAgreed(e)
  && !!entries && !!e.proposal_hash && entries.some(x => x.kind === 'objection' && x.proposal_hash === e.proposal_hash && x.id < e.id);

/**
 * A pulled entry the person must see, though their Claude needs no wake: the agreed outcome of a proposal they are in
 * (its decision), and another approver's objection on a proposal they approve.
 */
function personSees(name: string, e: Entry, entries: readonly Readonly<Entry>[] | undefined, trust: Trust): boolean {
  if (e.kind === 'plan') return false; // a new version of a room plan: the request on it is the person's line
  if (e.kind === 'task') return suggestedTo(name, e, entries);
  if (e.kind === 'decision' && notAgreed(e)) return false; // each objection's own line said it
  if (e.kind === 'decision' && approversOf(e).includes(name)) return true; // its approvers, even with no log to judge by
  if (!entries || !e.proposal_hash) return false;
  if (e.kind !== 'decision' && e.kind !== 'objection') return false;
  const p = proposal(e.proposal_hash, entries, trust);
  return e.kind === 'decision' ? inProposal(p, name) : !!p && approversOf(p).includes(name);
}

function deliver(me: LaneViewer | null | undefined, e: Entry, { entries, trust = NO_TRUST }: DeliverState = {}): Delivery {
  const l = lane(me, e, entries, trust);
  const name = me && me.name;
  if (me && me.role === 'claude') return 'none';
  if (saidBefore(e, entries)) return 'none';
  if ((isMove(e) && e.via === 'system' && e.from !== name && e.from !== 'claude')) return 'notice';
  // the room's line for a machine its PIN let in, with its check and the kick: the people's join notice
  const joined = me ? linkJoined(e) : null;
  if (joined) return joined === name ? 'none' : 'notice';
  if (l === 'push') return me && (isMove(e) || chat(me, e)) ? 'notice' : 'wake';
  if (l === 'pull' && me && personSees(String(name), e, entries, trust)) return 'notice';
  return l === 'pull' ? 'context' : 'none';
}

export { deliver, lane, mentions };
export type { DeliverState };
