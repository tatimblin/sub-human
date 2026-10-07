'use strict';
/**
 * plugin/sub-human/lib/proposal.js: proposals and the consent card.
 * CommonJS, zero dependencies, Node 24. Every write goes through room.append().
 *
 * Log entries:
 *   proposal  via=agent, from = the proposer, {hash, approvers[], path, text}   (propose tool)
 *   signoff | objection  via=human, from = the approver, {proposal_hash, text?}  (consent.js, from the card;
 *             text = the card's notes, byte-exact, omitted when there are none)
 *   decision  via=system, from "room", {proposal_hash, refs: the answer ids, text "agreed: …" | "objected: …"}
 *             written once, when every approver has answered.
 *
 *   create(me, {text|path, approvers?}) -> {hash, approvers, path, entry, again}
 *       Stores the blob plans/<hash>.md (hash = sha256/12 of the bytes; lib/room/store.js blobs) and appends
 *       `proposal` with path = that room-relative ref (older entries hold an absolute path). approvers
 *       default to the humans present (not orch, not left). An identical open proposal is not re-appended.
 *       Throws ProposalError (message for the model) on bad input.
 *   Reading the log goes through lib/room/consent.js fold (retracted entries out, latest proposal per hash, the
 *   latest answer per person, an objection voids a signoff), the same fold stateLine, lane() and the rows read.
 *   proposals(entries) -> [p]      the latest proposal entry per hash, as {id, hash, approvers, path, from}
 *   pendingFor(me, entries?) -> [p] proposals naming me that I have not answered, undecided, not retracted
 *   card(p, code) -> {questions:[…]}     the AskUserQuestion input (Not yet first, Agree, Object)
 *   cardFor(ps, code) -> {questions:[…]} one question per proposal (at most 4)
 *   question(hash) -> "Agree to proposal <hash>?";  QUESTION_RE parses it back
 *   preview(p, code) -> string     the full text if <= PREVIEW_MAX chars and <= PREVIEW_LINES lines, else
 *                                  a summary plus the plan file's path
 *   matrix(p, entries) -> {hash, approvers, answers:{name: {id, kind}|null}, agreed, objected, missing, complete, …}
 *   record(me, p, {choice:'Agree'|'Object', notes?}) -> {entry, decision}|{stale:true}
 *       under a lock: appends the answer, then the decision when the matrix is complete. Idempotent: a person
 *       who already answered that hash (or a decided / unknown one) is stale; one answer per person.
 *   title(code, hash, entry?) -> string  the stored plan's first line (else the entry's title text, else '')
 *   titleOf(text) -> string
 *   decision(hash, entries) -> Entry|null
 *   humans(code) -> [name]         members present who can approve
 *   viewable(p, code) -> bool      the plan dialog can show it: stored, <= VIEW_MAX chars, no control or bidi
 *                                  characters (the dialog withholds approval for those); else the card
 *   reminder(p, name) -> string    the re-ask wording (a review closed without an answer is fine to reopen)
 *   planRef(hash) -> "plans/<hash>.md", planPath(code, hash) -> a local file for it, read(code, hash) -> string|null
 * The plan-view review state (the room document members/NAME/review): readReview, writeReview, clearReview, withReview(me, fn)
 *   (the lock), restorePlan(st), restoreStale(me, {force, now}) (session-restore: a review left behind).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const identity = require('./identity.js');
const room = require('./room.js');
const { writeFileAtomic } = require('./io.js');
const { clip } = require('./text.js');
const config = require('./config.js');

const HASH_RE = /^[0-9a-f]{12}$/;
const QUESTION_RE = /^Agree to proposal ([0-9a-f]{12})\?$/;
const PREVIEW_MAX = config.PREVIEW_MAX;     // the card withholds a longer preview (JS .length)
const PREVIEW_LINES = config.PREVIEW_LINES; // about 24 lines show at 50 rows; keep a margin
const VIEW_MAX = config.VIEW_MAX;           // the plan dialog withholds approval above 200,000 chars
const UNSAFE_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;
const SUMMARY_MAX = config.SUMMARY_MAX;
const SUMMARY_LINES = config.SUMMARY_LINES;
const FILE_MAX = config.PROPOSAL_FILE_MAX;
const TITLE_MAX = config.PROPOSAL_TITLE_MAX;

class ProposalError extends Error {}
const refuse = m => { throw new ProposalError(m); };

const hash12 = buf => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
/** A plan's ref in the room's blob store: room-relative, so the room can live anywhere (lib/room/store.js blobs). */
const planRef = hash => `plans/${hash}.md`;
const blobs = code => room.open(code).store.blobs;
/** Where a person can open the stored plan (a local file; the ref when the store has none). */
const planPath = (code, hash) => blobs(code).localPath(planRef(hash)) || planRef(hash);
function read(code, hash) {
  if (!HASH_RE.test(String(hash))) return null;
  try { const b = blobs(code).get(planRef(hash)); return b == null ? null : b.toString('utf8'); } catch { return null; }
}
function store(code, buf) {
  const hash = hash12(buf);
  const b = blobs(code);
  if (!b.has(planRef(hash))) b.put(planRef(hash), buf);
  return hash;
}

const entriesOf = (me, entries) => entries || room.open(me.code).readAll();

function humans(code) {
  return Object.values(identity.readMembers(code) || {})
    .filter(m => m && m.name && m.role !== 'orch' && !m.left_at).map(m => m.name);
}

// ---------- reading the log (lib/room/consent.js fold: the same semantics as stateLine, lane and the rows) ----------
const shape = p => ({ id: p.id, hash: p.hash, approvers: p.approvers, path: p.path, from: p.from });
const proposals = entries => [...room.fold(entries).proposals.values()].map(shape);

const decision = (hash, entries) => room.fold(entries).decisions.get(hash) || null;

/** The answer matrix over p.approvers (the latest answer per person wins; an objection voids a signoff). */
const matrix = (p, entries) => room.fold(entries).matrix(p.hash, p.approvers);

function pendingFor(me, entries) {
  if (!me || !me.name) return [];
  return room.fold(entriesOf(me, entries)).pending(me.name).map(shape);
}

/** A proposal's title: the first non-empty line of its text, heading / list / quote markers dropped. */
const titleOf = text => String(text || '').split('\n').map(l => l.replace(/^\s*(#{1,6}\s+|[-*+>]\s+)/, '').trim()).find(Boolean) || '';
const titles = new Map(); // hash -> title: plans are content-addressed, so a hash's title never changes
/**
 * The title people see for proposal hash: the stored plan's first line, else the entry's "proposal HASH: title"
 * text, else ''. Not clipped (the caller clips to its width).
 */
function title(code, hash, entry) {
  if (titles.has(hash)) return titles.get(hash);
  const t = titleOf(read(code, hash));
  if (t) { titles.set(hash, t); return t; }
  const m = entry && /^proposal [0-9a-f]{6,64}:\s*(.+)/.exec(String(entry.text || ''));
  return m ? m[1].trim() : '';
}

// ---------- the card ----------
const question = hash => `Agree to proposal ${hash}?`;

function summary(text) {
  const lines = text.split('\n');
  const out = [];
  let len = 0, used = 0;
  for (const l of lines) {
    if (out.length >= SUMMARY_LINES) break;
    const s = clip(l, TITLE_MAX);
    if (len + s.length + 1 > SUMMARY_MAX) break;
    out.push(s); len += s.length + 1; used++;
  }
  while (out.length && !out.at(-1).trim()) out.pop();
  const rest = lines.length - used;
  return out.join('\n') + (rest > 0 ? `\n… (${rest} more lines)` : '');
}

/** p.path: the stored ref (room-relative; older entries hold an absolute path, read by its plans/ name). */
function preview(p, code) {
  const b = blobs(code);
  const ref = b.ref(p.path) || planRef(p.hash);
  const file = b.localPath(ref) || ref;
  let text = null;
  try { const buf = b.get(ref); text = buf == null ? null : buf.toString('utf8'); } catch { /* missing */ }
  if (text == null) return `(proposal ${p.hash}: the text is missing; expected at ${file})`;
  if (text.length <= PREVIEW_MAX && text.split('\n').length <= PREVIEW_LINES) return text;
  return `${summary(text)}\n\nFull text: ${file}`;
}

function cardQuestion(p, code) {
  const pv = preview(p, code);
  const desc = {
    'Not yet': 'Decide later; nothing is recorded',
    Agree: `Sign off on ${p.hash}${p.from ? ` from ${p.from}` : ''}`,
    Object: 'Block it; press n to say why',
  };
  return { question: question(p.hash), header: 'Consent', multiSelect: false,
    options: ['Not yet', 'Agree', 'Object'].map(label => ({ label, description: desc[label], preview: pv })) };
}
const cardFor = (ps, code) => ({ questions: ps.slice(0, 4).map(p => cardQuestion(p, code)) });
const card = (p, code) => cardFor([p], code);

function viewable(p, code) {
  const t = read(code, p.hash);
  return t != null && t.length <= VIEW_MAX && !UNSAFE_RE.test(t.replace(/\r\n/g, '\n'));
}

/** How the model opens proposal hash for its person: the plan view (the hooks fall back to the card). */
const openCall = hash => `call EnterPlanMode, then ExitPlanMode with plan "proposal ${hash}"`;
const reminder = (p, name) => `proposal ${p.hash} still awaits ${name}'s answer (an earlier review closed without an answer is fine). Now ${openCall(p.hash)}.`;

// ---------- writing ----------
function expand(p, cwd) {
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(cwd || process.cwd(), p);
}

function create(me, args = {}, { cwd } = {}) {
  if (!me || !me.code || !me.name) refuse('not in a room; run /sub-human');
  const r = room.open(me.code);
  const { text, path: file } = args;
  if ((text == null) === (file == null)) refuse('give exactly one of text or path');
  let buf;
  if (file != null) {
    if (typeof file !== 'string' || !file.trim()) refuse('path must be a file path');
    const abs = expand(file, cwd);
    let st;
    try { st = fs.statSync(abs); } catch { refuse(`no such file: ${abs}`); }
    if (!st.isFile()) refuse(`not a file: ${abs}`);
    if (st.size > FILE_MAX) refuse(`file too large (${st.size} bytes; max ${FILE_MAX})`);
    buf = fs.readFileSync(abs);
  } else {
    if (typeof text !== 'string') refuse('text must be a string');
    buf = Buffer.from(text, 'utf8');
    if (buf.length > FILE_MAX) refuse(`text too large (max ${FILE_MAX} bytes)`);
  }
  if (!buf.toString('utf8').trim()) refuse('the proposal is empty');

  const present = humans(me.code);
  let approvers;
  if (args.approvers == null) approvers = present;
  else {
    if (!Array.isArray(args.approvers) || !args.approvers.every(a => typeof a === 'string')) refuse('approvers must be an array of names');
    approvers = [...new Set(args.approvers.map(a => a.trim().replace(/^@/, '')))];
    if (approvers.includes('orch')) refuse('approvers are people; the orch cannot approve');
    const unknown = approvers.filter(a => !present.includes(a));
    if (unknown.length) refuse(`not in the room: ${unknown.join(', ')} (present: ${present.join(', ') || 'nobody'})`);
  }
  if (!approvers.length) refuse('nobody to ask: no humans are in the room');

  const hash = store(me.code, buf);
  const stored = planPath(me.code, hash);
  const entries = r.readAll();
  const open = proposals(entries).find(p => p.hash === hash);
  if (open && !decision(hash, entries) && open.approvers.length === approvers.length && approvers.every(a => open.approvers.includes(a))) {
    return { hash, approvers, path: stored, entry: entries.find(e => e.id === open.id), again: true };
  }
  // the entry stores the room-relative ref; `path` returned is where the proposer can open it
  const entry = r.append({ kind: 'proposal', text: `proposal ${hash}: ${clip(titleOf(buf.toString('utf8')), TITLE_MAX)}`, hash, approvers, path: planRef(hash) },
    { via: 'agent', from: me.name });
  return { hash, approvers, path: stored, entry, again: false };
}

function choiceOf(c) {
  const k = String(c || '').trim().toLowerCase();
  return k === 'agree' ? 'Agree' : k === 'object' ? 'Object' : k === 'not yet' ? 'Not yet' : null;
}

function record(me, p, answer = {}) {
  const r = room.open(me.code);
  const choice = choiceOf(answer.choice);
  if (choice !== 'Agree' && choice !== 'Object') return { stale: true, why: 'no choice' };
  return r.store.lock('proposal', () => {
    const entries = r.readAll();
    const f = room.fold(entries);
    const cur = f.proposals.get(p.hash);
    // Idempotent: one answer per person per proposal. A card and a plan view open at once, or a reopened card,
    // never record twice, and the decision's refs are exactly the answers the fold reads as current.
    if (!cur || !cur.approvers.includes(me.name) || f.decisions.has(cur.hash) || f.answerOf(cur.hash, me.name)) {
      return { stale: true, why: 'answered, decided or unknown' };
    }
    const notes = typeof answer.notes === 'string' && answer.notes.trim() ? answer.notes : undefined;
    const kind = choice === 'Agree' ? 'signoff' : 'objection';
    const e = { kind, proposal_hash: cur.hash };
    if (notes !== undefined) e.text = notes; // byte-exact
    const entry = r.append(e, { via: 'human', from: me.name });
    const m = matrix(cur, [...entries, entry]);
    let dec = null;
    if (m.complete) {
      const text = m.objected.length
        ? `objected: ${m.objected.join(', ')}${m.agreed.length ? ` · agreed: ${m.agreed.join(', ')}` : ''} (proposal ${cur.hash})`
        : `agreed: ${m.agreed.join(', ')} (proposal ${cur.hash})`;
      const refs = cur.approvers.map(n => m.answers[n].id);
      dec = r.append({ kind: 'decision', text, proposal_hash: cur.hash, refs: [cur.id, ...refs] },
        { via: 'system', from: 'room', system: true });
    }
    return { entry, decision: dec };
  });
}

// ---------- the plan-view review state (hooks/consent.js, hooks/session-restore.js) ----------
/**
 * members/NAME/review: {phase, mode, at, hash?, from?, file?, backup?, restored?, tool_use_id?, …}.
 * `backup` is the session plan file's text before the review overwrote it (null: there was none), recorded
 * BEFORE the overwrite, so a crash between the two never loses the person's own plan.
 */
const reviewKey = me => `members/${me.name}/review`;
const kvOf = me => room.open(me.code).store.kv;
const readReview = me => kvOf(me).get(reviewKey(me), null);
const writeReview = (me, st) => kvOf(me).set(reviewKey(me), st, { compact: true });
function clearReview(me) { kvOf(me).delete(reviewKey(me)); }
/** Every read-modify-write of the review state runs under this lock (hooks of one session can overlap). */
const withReview = (me, fn) => kvOf(me).lock(reviewKey(me), fn, { timeoutMs: config.REVIEW_LOCK_TIMEOUT_MS });

/** Put the session plan file back as it was before the review (atomically); marks st.restored. */
function restorePlan(st) {
  if (!st || !st.file || st.restored) return;
  try {
    if (typeof st.backup === 'string') writeFileAtomic(st.file, st.backup);
    else fs.rmSync(st.file, { force: true });
  } catch { /* best-effort */ }
  st.restored = true;
}

/**
 * A review left behind (the session restarted, or it has been open longer than REVIEW_STALE_MS): restore the
 * plan file when it still holds the proposal's text (a file the person wrote since is left alone) and clear
 * the state. force: the session restarted (/clear, --resume). Returns 'restored' | 'cleared' | null.
 */
function restoreStale(me, { force = false, now = Date.now() } = {}) {
  if (!me || !me.code || !me.name) return null;
  return withReview(me, () => {
    const st = readReview(me);
    if (!st) return null;
    if (!force && !(now - (Number(st.at) || 0) > config.REVIEW_STALE_MS)) return null;
    let out = 'cleared';
    if (st.file && !st.restored && st.hash) {
      let cur = null;
      try { cur = fs.readFileSync(st.file); } catch { /* gone */ }
      if (cur && hash12(cur) === st.hash) { restorePlan(st); out = 'restored'; }
    }
    clearReview(me);
    return out;
  });
}

module.exports = {
  QUESTION_RE, ProposalError,
  readReview, writeReview, clearReview, withReview, restorePlan, restoreStale,
  create, proposals, pendingFor, card, cardFor, question, preview, viewable, openCall, matrix, record, decision, humans, reminder,
  planPath, planRef, read, hash12, title, titleOf,
};
