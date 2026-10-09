'use strict';
/**
 * plugin/sub-human/lib/room/lanes.js: who a log entry concerns, and the proposal queries that decide it.
 *
 * Proposals and decisions (a proposal is {hash, approvers[], path?}; answers carry proposal_hash). Every query
 * reads lib/room/consent.js fold(entries) (memoized per array), so stateLine, lane, the rows and the gate agree:
 *   (entries: the log to judge against; lib/room.js Room passes its own)
 *   proposal(hash, entries) -> Entry|null            the latest proposal with that hash
 *   proposals(entries?) -> Entry[]                   the latest entry per distinct hash, in log order
 *   answers(hash, approvers?, entries?) -> {hash, signed: {name: id|null}, missing, complete}
 *       approvers default to that proposal's. signed[name] = the id of name's current signoff (the latest
 *       answer wins: an objection voids an earlier signoff); missing = approvers with no current signoff.
 *   answered(name, hash, entries?) -> Entry|null     name's latest via=human answer on hash
 *   decided(hash, entries?) -> Entry|null            the decision entry for that hash
 *   approversOf(p) -> [name]
 *
 * Lanes:
 *   lane(me, e, entries?) -> 'push' | 'pull' | 'none'   who a notice concerns (rules at lane() below)
 */

const { normalize } = require('./store.js');
const { fold } = require('./consent.js');

// ---------- proposals / decisions (all read lib/room/consent.js fold: one set of semantics) ----------
/** The latest proposal entry, legacy plan_rev included, with that hash. */
function proposal(hash, entries = []) {
  const p = fold(entries).proposals.get(hash);
  return p ? p.entry : null;
}

/** The latest proposal per distinct hash, in log order of that latest entry. */
const proposals = (entries = []) => [...fold(entries).proposals.values()].map(p => p.entry);

const approversOf = p => (p && Array.isArray(p.approvers) ? p.approvers : []);

function answers(hash, approvers, entries = []) {
  const m = fold(entries).matrix(hash, Array.isArray(approvers) ? approvers : undefined);
  return { hash, signed: m.signed, missing: m.unsigned, complete: !!hash && m.approvers.length > 0 && m.unsigned.length === 0 };
}

/** name's latest via=human signoff or objection on hash, or null. */
function answered(name, hash, entries = []) {
  const a = fold(entries).answerOf(hash, name);
  return a ? a.entry : null;
}

const decided = (hash, entries = []) => fold(entries).decisions.get(hash) || null;

// ---------- lanes ----------
const esc = s => s.replace(/[.]/g, '\\.');
/** "@name" anywhere in the text (case-insensitive, not part of a longer name). */
const mentions = (text, name) => new RegExp(`(^|[^A-Za-z0-9_.-])@${esc(name)}(?![A-Za-z0-9_-])`, 'i').test(String(text ?? ''));
/** Whether name is in proposal p: an approver or its author. */
const inProposal = (p, name) => !!p && (approversOf(p).includes(name) || p.from === name);

/**
 * Which lane entry e takes for session me ({name, role}): 'push' (the tail sends it now: chat, or a wake), 'pull'
 * (the tail's "Room since your last turn", read with my next request) or 'none' (never shown). Pass `entries` (the log as
 * of now) to judge against current state: a proposal I already answered or that was decided, the
 * proposal a decision or an answer belongs to, the request a task entry applied. Without `entries` the answer
 * is the entry-only one (push is then a superset of the judged push).
 *   none: my own entries (hook-written system decision/task entries are not "mine").
 *   member push: others' via=human entries (every person's words, @-addressed to others too: a group chat);
 *     to=me or @me; a proposal naming me that I have not answered (and is not decided); a decision on a
 *     proposal I am in; a `task` assigning me (owner me) that someone else asked for (its req is not mine).
 *     Everything else is pull.
 *   the room's Claude (role claude) push: to=claude only (a person's leading @claude tag; an "@claude" inside the text
 *     is just words); task_req; an objection on its own proposal (below). Everything else is pull,
 *     decisions included: an objected one follows the objection that already woke it, and an agreed one needs
 *     nothing from it (the members are told; it helps further only when asked). member_joined reaches it
 *     through scripts/sub-human tail's row note.
 *   card answers (both roles): a signoff is pull (the decision carries it); an objection is push to the
 *     proposal's author only (to revise), pull for everyone else.
 *   decisions (judged): pull for the member whose answer completed it (the card's own reply, consent.js,
 *     already told that Claude), and an objected decision is pull for all but the proposer (nothing to act
 *     on; a revision brings its own card).
 */
function lane(me, e, entries) {
  const name = me && me.name;
  const roomClaude = !!me && me.role === 'claude';
  const n = normalize(e);
  if (n.from === name && !(n.via === 'system' && (n.kind === 'decision' || n.kind === 'task'))) return 'none';
  if (n.to === name || (!roomClaude && mentions(n.text, name))) return 'push';
  if ((n.kind === 'signoff' || n.kind === 'objection') && n.proposal_hash) {
    if (n.kind === 'signoff') return 'pull';
    if (!entries) return 'push';
    const p = proposal(n.proposal_hash, entries);
    return p && p.from === name ? 'push' : 'pull';
  }
  if (n.kind === 'decision' && entries && quietDecision(name, n, entries)) return 'pull';
  if (roomClaude) return n.kind === 'task_req' ? 'push' : 'pull';
  if (n.kind === 'proposal' && approversOf(n).includes(name)) {
    if (!entries || !n.hash) return 'push';
    return answered(name, n.hash, entries) || decided(n.hash, entries) ? 'pull' : 'push';
  }
  if (n.kind === 'decision') {
    if (approversOf(n).includes(name) || !entries) return 'push';
    return inProposal(proposal(n.proposal_hash, entries), name) ? 'push' : 'pull';
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
 * A decision that needs no wake for name: name's answer completed it (consent.js told that Claude in the
 * card's reply), or it is an objected decision on a proposal name did not write.
 */
function quietDecision(name, d, entries) {
  const refs = new Set(d.refs || []);
  let last = null;
  for (const x of entries) if (refs.has(x.id) && (x.kind === 'signoff' || x.kind === 'objection') && (!last || x.id > last.id)) last = x;
  if (last && last.from === name && last.via === 'human') return true;
  if (/^objected:/.test(String(d.text || ''))) {
    const p = proposal(d.proposal_hash, entries);
    return !(p && p.from === name);
  }
  return false;
}

module.exports = {
  proposal, proposals, answers, answered, decided, approversOf,
  lane,
};
