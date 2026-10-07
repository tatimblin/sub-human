'use strict';
/**
 * plugin/sub-human/lib/room/consent.js: the one fold of the room log into proposal / consent state. Pure apart from
 * store.js humanTrust (reads the seats' public keys), CommonJS, zero dependencies beyond store.js.
 * stateLine and lane() (lanes.js, render.js), the rows (lib/rows.js) and the consent gate (lib/proposal.js, hooks/consent.js) all read this, so they cannot disagree.
 *
 *   fold(entries) -> F   memoized per entries array (same array, same length and last id -> same F)
 *     F.proposals  Map hash -> {id, hash, from, approvers, path, entry}   the LATEST proposal entry per hash,
 *                  Map order = log order of that latest entry
 *     F.answers    Map hash -> Map name -> {kind: 'signoff'|'objection', id, entry}   per person, the latest answer
 *     F.decisions  Map hash -> entry   the latest via=system decision per hash
 *     F.matrix(hash, approvers?) -> {hash, approvers, answers: {name: {id, kind}|null}, signed: {name: id|null},
 *                  agreed, objected, missing (no answer), unsigned (no signoff), complete (everyone answered)}
 *     F.pending(name) -> [proposal]   undecided proposals naming name that name has not answered (log order)
 *     F.status(hash) -> {proposal, decision, matrix, state: 'open'|'agreed'|'blocked'}|null
 *
 * Semantics (one place):
 *   - Entries are read through normalize() (legacy plan_rev / plan_hash / concern / agree).
 *   - Only valid 12-hex hashes (sha256/12 of the plan bytes, lib/proposal.js) count.
 *   - The latest proposal entry per hash wins (approvers, path, author). Answers attach to the hash (the text),
 *     wherever they sit in the log.
 *   - A via=human answer counts only when store.humanTrust says it is the person's: signed with the seat's key
 *     (which only hook processes hold), or unsigned from a seat that has no key at all (a room from before seat
 *     keys). A bad sig, or an unsigned answer from a seat with a key, is ignored.
 *   - Per person, the latest via=human signoff / objection wins: an objection voids that person's earlier
 *     signoff (and a later signoff replaces an objection). A legacy via=human `revoke` clears the answer.
 *   - A decision is as recorded: the latest via=system decision with that proposal_hash closes it.
 *     state: 'blocked' when an approver's current answer is an objection, else 'agreed'.
 * Recording (lib/proposal.record) is idempotent on top of this: one answer per person per hash, so the fold's
 * "latest" and the decision's refs agree for everything the hooks write.
 */

const { normalize, humanTrust } = require('./store.js');

const HASH_RE = /^[0-9a-f]{12}$/;
const isHash = h => typeof h === 'string' && HASH_RE.test(h);
const ANSWER_KINDS = new Set(['signoff', 'objection']);

const memo = new WeakMap();

function fold(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const last = list.length ? list[list.length - 1] : null;
  const key = `${list.length}:${last && last.id}`;
  const hit = memo.get(list);
  if (hit && hit.key === key) return hit.f;
  const f = compute(list);
  memo.set(list, { key, f });
  return f;
}

function compute(list) {
  const proposals = new Map();
  const answers = new Map();
  const decisions = new Map();
  for (const raw of list) {
    if (!raw) continue;
    const e = normalize(raw);
    if (e.kind === 'proposal') {
      if (!isHash(e.hash)) continue;
      proposals.delete(e.hash);
      proposals.set(e.hash, { id: e.id, hash: e.hash, from: e.from, approvers: Array.isArray(e.approvers) ? e.approvers : [], path: e.path || null, entry: e });
      continue;
    }
    const h = e.proposal_hash;
    if (!isHash(h)) continue;
    if (e.kind === 'decision') { if (e.via === 'system') decisions.set(h, e); continue; }
    if (e.via !== 'human' || typeof e.from !== 'string' || humanTrust(raw) === 'unverified') continue;
    if (ANSWER_KINDS.has(e.kind)) {
      if (!answers.has(h)) answers.set(h, new Map());
      answers.get(h).set(e.from, { kind: e.kind, id: e.id, entry: e });
    } else if (e.kind === 'revoke' && answers.has(h)) {
      answers.get(h).delete(e.from);
    }
  }

  const answerOf = (hash, name) => { const m = answers.get(hash); return (m && m.get(name)) || null; };

  function matrix(hash, approvers) {
    if (!Array.isArray(approvers)) { const p = proposals.get(hash); approvers = p ? p.approvers : []; }
    const out = {}, signed = {};
    for (const n of approvers) {
      const a = answerOf(hash, n);
      out[n] = a ? { id: a.id, kind: a.kind } : null;
      signed[n] = a && a.kind === 'signoff' ? a.id : null;
    }
    const by = kind => approvers.filter(n => out[n] && out[n].kind === kind);
    const missing = approvers.filter(n => !out[n]);
    return { hash, approvers, answers: out, signed, agreed: by('signoff'), objected: by('objection'), missing,
      unsigned: approvers.filter(n => signed[n] == null), complete: approvers.length > 0 && missing.length === 0 };
  }

  const pending = name => (name ? [...proposals.values()].filter(p => p.approvers.includes(name)
    && !decisions.has(p.hash) && !answerOf(p.hash, name)) : []);

  function status(hash) {
    const p = proposals.get(hash);
    if (!p) return null;
    const m = matrix(hash);
    const d = decisions.get(hash) || null;
    return { proposal: p, decision: d, matrix: m, state: !d ? 'open' : m.objected.length ? 'blocked' : 'agreed' };
  }

  return { proposals, answers, decisions, answerOf, matrix, pending, status };
}

module.exports = { fold, HASH_RE };
