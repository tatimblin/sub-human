'use strict';
/**
 * plugin/sub-human/lib/proposal.js: proposals and the consent card. Replaces lib/plan.js for consent.
 * CommonJS, zero dependencies, Node 24. Every write goes through room.append().
 *
 * Log entries (the Phase 2 contract):
 *   proposal  via=agent, from = the proposer, {hash, approvers[], path, text}   (propose tool)
 *   signoff | objection  via=human, from = the approver, {proposal_hash, text?}  (consent.js, from the card;
 *             text = the card's notes, byte-exact, omitted when there are none; a room.js that
 *             requires text gets the bare label "Agree"/"Object" instead)
 *   decision  via=system, from "room", {proposal_hash, refs: the answer ids, text "agreed: …" | "objected: …"}
 *             written once, when every approver has answered.
 *
 *   create(me, {text|path, approvers?}) -> {hash, approvers, path, entry, again}
 *       Stores <roomDir>/plans/<hash>.md (hash = sha256/12 of the bytes) and appends `proposal`. approvers
 *       default to the humans present (not orch, not left). An identical open proposal is not re-appended.
 *       Throws ProposalError (message for the model) on bad input.
 *   proposals(entries) -> [p]      the latest proposal entry per hash, as {id, hash, approvers, path, from}
 *   pendingFor(me, entries?) -> [p] proposals naming me that I have not answered, undecided, not retracted
 *   card(p) -> {questions:[…]}     the AskUserQuestion input (Not yet first, Agree, Object)
 *   cardFor(ps) -> {questions:[…]} one question per proposal (at most 4)
 *   question(hash) -> "Agree to proposal <hash>?";  QUESTION_RE parses it back
 *   preview(p) -> string           the full text if <= PREVIEW_MAX chars and <= PREVIEW_LINES lines, else
 *                                  a summary plus the plan file's path
 *   matrix(p, entries?) -> {hash, approvers, answers:{name: {id, kind}|null}, agreed, objected, missing, complete}
 *   record(me, p, {choice:'Agree'|'Object', notes?}) -> {entry, decision}|{stale:true}
 *       under a lock: appends the answer, then the decision when the matrix is complete.
 *   decision(hash, entries?) -> Entry|null
 *   humans(code) -> [name]         members present who can approve
 *   viewable(p, code?) -> bool     the plan dialog can show it: stored, <= VIEW_MAX chars, no control or bidi
 *                                  characters (the dialog withholds approval for those); else the card
 *   reminder(p, name) -> string    the re-ask wording (a review closed without an answer is fine to reopen)
 *   planPath(code, hash), read(code, hash) -> string|null
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const identity = require('./identity.js');
const room = require('./room.js');

const HASH_RE = /^[0-9a-f]{12}$/;
const QUESTION_RE = /^Agree to proposal ([0-9a-f]{12})\?$/;
const PREVIEW_MAX = 2000;   // S2 F5: the card withholds a preview longer than 2000 (JS .length)
const PREVIEW_LINES = 20;   // S2 F5: about 24 lines show at 50 rows; keep a margin
const VIEW_MAX = 200000;   // the plan dialog withholds approval above 200,000 chars (2.1.281)
const UNSAFE_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;
const SUMMARY_MAX = 1200;
const SUMMARY_LINES = 12;
const FILE_MAX = 256 * 1024;
const CHOICES = { agree: 'Agree', object: 'Object', later: 'Not yet' };

class ProposalError extends Error {}
const refuse = m => { throw new ProposalError(m); };

const hash12 = buf => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
const planPath = (code, hash) => path.join(identity.roomDir(code), 'plans', `${hash}.md`);
function read(code, hash) {
  if (!HASH_RE.test(String(hash))) return null;
  try { return fs.readFileSync(planPath(code, hash), 'utf8'); } catch { return null; }
}
function store(code, buf) {
  const hash = hash12(buf);
  const file = planPath(code, hash);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
  }
  return hash;
}

const bind = me => { if (me && me.code && !process.env.ROOM_DIR) room.bind(me.code); };
const entriesOf = (me, entries) => { if (entries) return entries; bind(me); return room.readAll(); };
const retracted = entries => (typeof room.retractedIds === 'function' ? room.retractedIds(entries) : new Set());

function humans(code) {
  return Object.values(identity.readMembers(code) || {})
    .filter(m => m && m.name && m.role !== 'orch' && !m.left_at).map(m => m.name);
}

// ---------- reading the log ----------
function proposals(entries) {
  const gone = retracted(entries);
  const by = new Map();
  for (const e of entries) {
    if (e.kind !== 'proposal' || !HASH_RE.test(String(e.hash)) || gone.has(e.id)) continue;
    by.set(e.hash, { id: e.id, hash: e.hash, approvers: Array.isArray(e.approvers) ? e.approvers : [], path: e.path || null, from: e.from });
  }
  return [...by.values()];
}

const decision = (hash, entries = room.readAll()) => entries.filter(e => e.kind === 'decision' && e.via === 'system' && e.proposal_hash === hash).at(-1) || null;

function matrix(p, entries) {
  entries = entries || room.readAll();
  const gone = retracted(entries);
  const answers = Object.fromEntries(p.approvers.map(n => [n, null]));
  for (const e of entries) {
    if (e.via !== 'human' || e.proposal_hash !== p.hash || gone.has(e.id)) continue;
    if (e.kind !== 'signoff' && e.kind !== 'objection') continue;
    if (e.from in answers && !answers[e.from]) answers[e.from] = { id: e.id, kind: e.kind }; // first answer counts
  }
  const by = kind => p.approvers.filter(n => answers[n] && answers[n].kind === kind);
  const missing = p.approvers.filter(n => !answers[n]);
  return { hash: p.hash, approvers: p.approvers, answers, agreed: by('signoff'), objected: by('objection'), missing,
    complete: p.approvers.length > 0 && missing.length === 0 };
}

function pendingFor(me, entries) {
  if (!me || !me.name) return [];
  entries = entriesOf(me, entries);
  return proposals(entries).filter(p => p.approvers.includes(me.name)
    && !decision(p.hash, entries) && !matrix(p, entries).answers[me.name]);
}

// ---------- the card ----------
const question = hash => `Agree to proposal ${hash}?`;

function summary(text) {
  const lines = text.split('\n');
  const out = [];
  let len = 0, used = 0;
  for (const l of lines) {
    if (out.length >= SUMMARY_LINES) break;
    const s = l.length > 160 ? l.slice(0, 159) + '…' : l;
    if (len + s.length + 1 > SUMMARY_MAX) break;
    out.push(s); len += s.length + 1; used++;
  }
  while (out.length && !out.at(-1).trim()) out.pop();
  const rest = lines.length - used;
  return out.join('\n') + (rest > 0 ? `\n… (${rest} more lines)` : '');
}

function preview(p, code = room.code()) {
  const file = p.path || planPath(code, p.hash);
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* missing */ }
  if (text == null) return `(proposal ${p.hash}: the text is missing; expected at ${file})`;
  if (text.length <= PREVIEW_MAX && text.split('\n').length <= PREVIEW_LINES) return text;
  return `${summary(text)}\n\nFull text: ${file}`;
}

function cardQuestion(p) {
  const pv = preview(p);
  const desc = {
    'Not yet': 'Decide later; nothing is recorded',
    Agree: `Sign off on ${p.hash}${p.from ? ` from ${p.from}` : ''}`,
    Object: 'Block it; press n to say why',
  };
  return { question: question(p.hash), header: 'Consent', multiSelect: false,
    options: ['Not yet', 'Agree', 'Object'].map(label => ({ label, description: desc[label], preview: pv })) };
}
const cardFor = ps => ({ questions: ps.slice(0, 4).map(cardQuestion) });
const card = p => cardFor([p]);

function viewable(p, code = room.code()) {
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
  bind(me);
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
  const entries = room.readAll();
  const open = proposals(entries).find(p => p.hash === hash);
  if (open && !decision(hash, entries) && open.approvers.length === approvers.length && approvers.every(a => open.approvers.includes(a))) {
    return { hash, approvers, path: stored, entry: entries.find(e => e.id === open.id), again: true };
  }
  const first = buf.toString('utf8').split('\n').map(l => l.replace(/^\s*(#{1,6}\s+|[-*+>]\s+)/, '').trim()).find(Boolean) || '';
  const title = first.length > 160 ? first.slice(0, 159) + '…' : first;
  const entry = room.append({ kind: 'proposal', text: `proposal ${hash}: ${title}`, hash, approvers, path: stored },
    { via: 'agent', from: me.name });
  return { hash, approvers, path: stored, entry, again: false };
}

function choiceOf(c) {
  const k = String(c || '').trim().toLowerCase();
  return k === 'agree' ? 'Agree' : k === 'object' ? 'Object' : k === 'not yet' ? 'Not yet' : null;
}

function record(me, p, answer = {}) {
  bind(me);
  const choice = choiceOf(answer.choice);
  if (choice !== 'Agree' && choice !== 'Object') return { stale: true, why: 'no choice' };
  const lock = path.join(room.dir(), 'proposal.lock');
  return identity.withLock(lock, () => {
    const entries = room.readAll();
    const cur = proposals(entries).find(x => x.hash === p.hash);
    if (!cur || !cur.approvers.includes(me.name) || decision(cur.hash, entries) || matrix(cur, entries).answers[me.name]) {
      return { stale: true, why: 'answered, decided or unknown' };
    }
    const notes = typeof answer.notes === 'string' && answer.notes.trim() ? answer.notes : undefined;
    const kind = choice === 'Agree' ? 'signoff' : 'objection';
    const e = { kind, proposal_hash: cur.hash };
    if (notes !== undefined) e.text = notes; // byte-exact
    let entry;
    try { entry = room.append(e, { via: 'human', from: me.name }); } catch (err) {
      // A room.js that still requires text on every entry: the bare label stands in for "no note".
      if (notes !== undefined || !(err && err.code === 'INVALID' && /text/.test(err.message))) throw err;
      entry = room.append({ ...e, text: choice }, { via: 'human', from: me.name });
    }
    const m = matrix(cur, [...entries, entry]);
    let dec = null;
    if (m.complete) {
      const text = m.objected.length
        ? `objected: ${m.objected.join(', ')}${m.agreed.length ? ` · agreed: ${m.agreed.join(', ')}` : ''} (proposal ${cur.hash})`
        : `agreed: ${m.agreed.join(', ')} (proposal ${cur.hash})`;
      const refs = cur.approvers.map(n => m.answers[n].id);
      dec = room.append({ kind: 'decision', text, proposal_hash: cur.hash, refs: [cur.id, ...refs] },
        { via: 'system', from: 'room', system: true });
    }
    return { entry, decision: dec };
  }, Error);
}

module.exports = {
  HASH_RE, QUESTION_RE, PREVIEW_MAX, PREVIEW_LINES, VIEW_MAX, CHOICES, ProposalError,
  create, proposals, pendingFor, card, cardFor, question, preview, viewable, openCall, matrix, record, decision, humans, reminder,
  planPath, read, hash12,
};
