/**
 * plugin/sub-human/lib/proposal.ts: proposals and the consent card.
 * CommonJS, zero dependencies. Every write goes through room.append().
 *
 * Log entries:
 *   proposal  via=agent, from = the proposer, {hash, approvers[], same?, path, text}   (propose tool)
 *   signoff | objection  via=human, from = the approver, {proposal_hash, text?}  (consent.ts, from the card;
 *             text = the card's notes, byte-exact, omitted when there are none)
 *   decision  via=system, from "room", {proposal_hash, refs: the answer ids, text "agreed: …" | "objected: …"}
 *             written once, when every approver has answered. text names one seat per person: "agreed: tristan (also
 *             laptop), bob".
 *
 *   create(me, {text|path, approvers?}) -> {hash, approvers, path, entry, again, retired}
 *       Stores the blob plans/<hash>.md (hash = sha256/12 of the bytes; lib/room/store.ts blobs) and appends
 *       `proposal` with path = that room-relative ref (older entries hold an absolute path). approvers
 *       default to the humans present (not room Claude, not left). An identical open proposal is not re-appended.
 *       same: the approvers that are one person (sameOf: seats with one account; the host's local seats only
 *       while there is one of them), groups of 2+; the fold counts one answer for the group (lib/room/consent.ts).
 *       Written only where the host accepts it (sameOk: this machine is the host, or its link daemon's hello
 *       listed the field, lib/remote/protocol.ts FIELDS).
 *       retired: the hashes of my undecided proposals with the same title that this one supersedes (the fold
 *       retires them, lib/room/consent.ts: no longer pending, answers on them do not carry over).
 *       Throws ProposalError (message for the model) on bad input.
 *   Reading the log goes through lib/room/consent.ts fold (latest proposal per hash, the
 *   latest answer per person, an objection voids a signoff), the same fold stateLine, lane() and the rows read.
 *   proposals(entries) -> [p]      the latest proposal entry per hash, as {id, hash, approvers, path, from}
 *   pendingFor(me, entries?) -> [p] proposals naming me that I have not answered, undecided, not superseded
 *                                  (another seat of my person answering counts as mine)
 *   answerableFor(me, entries?) -> [p]   the same, by my own seat's answer only: a card or review already open
 *                                  still records, and that later answer counts for my person (the hooks' answer paths)
 *   card(p, code) -> {questions:[…]}     the AskUserQuestion input (Not yet first, Agree, Object)
 *   cardFor(ps, code) -> {questions:[…]} one question per proposal (at most 4)
 *   question(hash) -> "Agree to proposal <hash>?";  QUESTION_RE parses it back
 *   preview(p, code) -> string     the full text if <= PREVIEW_MAX chars and <= PREVIEW_LINES lines, else
 *                                  a summary plus the plan file's path
 *   matrix(p, entries) -> {hash, approvers, answers:{name: {id, kind}|null}, agreed, objected, missing, complete, …}
 *   answer(me, p, {choice:'Agree'|'Object', notes?}) -> {entry}|{stale:true, why}
 *       under the proposal lock: appends the person's answer (signed, so any machine may write it). Idempotent:
 *       a seat that already answered that hash (or a decided / superseded / unknown one) is stale; one answer per seat.
 *   decide(code, hash) -> Entry|null
 *       host only (identity.isHost; null elsewhere): under the proposal lock, appends the decision once every
 *       approver has answered. Idempotent: a decided, superseded, unknown or incomplete proposal appends nothing (null). The
 *       consent hook calls it after each answer; the remote server will after placing one.
 *   title(code, hash, entry?) -> string  the stored plan's first line (else the entry's title text, else '')
 *   decision(hash, entries) -> Entry|null
 *   humans(code) -> [name]         members present who can approve
 *   personOf(m) -> string|undefined   who a seat is for consent: its account (lib/seats.ts enter), else nobody shared
 *   sameOk(code) -> bool           this machine may write a proposal's same (the host, or its host's caps list it)
 *   viewable(p, code) -> bool      the plan dialog can show it: stored, <= VIEW_MAX chars, no control or bidi
 *                                  characters (the dialog withholds approval for those); else the card
 *   reminder(p, name, {code, others}?) -> string   the re-ask wording (a review closed without an answer is fine to
 *                                  reopen); others: the other pending proposals, listed as h6 "title"
 *   namedIn(ps, prompt, code) -> p|null   the pending proposal a person's words name (hash, else distinctive title / text words)
 *   replacedIn(ps, prompt, code) -> {old, p}|null   the words name no pending hash but a superseded one (old) whose
 *                                  latest revision p is among ps: a review opens p, and says so
 *   proposeIntent(prompt) -> bool  the person's words ask their Claude to propose something ("propose to alice: …"):
 *                                  no review opens on such a prompt (hooks/consent.ts Pre(EnterPlanMode))
 *   choose(me, ps, prompt) -> p    store that pick (namedIn, else replacedIn's p; members/NAME/pick) and return it,
 *                                  else the newest (hooks/consent.ts)
 *   picked(me, ps) -> p            Pre(EnterPlanMode): the stored pick when still among ps, else the newest
 *   read(code, hash) -> string|null  the stored plan (the room blob plans/<hash>.md)
 * The plan-view review state (the room document members/NAME/review): readReview, writeReview, clearReview, withReview(me, fn)
 *   (the lock), restorePlan(st), restoreStale(me, {force, now}) (session-restore: a review left behind).
 * A review's note waiting for the person's Send (the room document members/NAME/confirm): readConfirm, writeConfirm,
 *   clearConfirm; confirmCard(c) -> the AskUserQuestion input (Send, Discard), confirmQuestion(c) its question.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as identity from './identity.ts';
import * as room from './room.ts';
import { writeFileAtomic } from './io.ts';
import { clip } from './text.ts';
import * as config from './config.ts';
import type { Card, Confirm, Proposal, Review } from './types-app.ts';
import type { Entry, Matrix, Member, Members, ProposalState } from './room/types.ts';
import type { Identity } from './identity.ts';

/** Who acts: a seat's room and name are all these functions read. */
type Me = Pick<Identity, 'code' | 'name'>;

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
function refuse(m: string): never { throw new ProposalError(m); }

const hash12 = (buf: crypto.BinaryLike) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
/** A plan's ref in the room's blob store: room-relative, so the room can live anywhere (lib/room/store.ts blobs). */
const planRef = (hash: string) => `plans/${hash}.md`;
const blobs = (code: string) => room.open(code).store.blobs;
/** Where a person can open the stored plan (a local file; the ref when the store has none). */
const planPath = (code: string, hash: string): string => blobs(code).localPath(planRef(hash)) || planRef(hash);
function read(code: string, hash: string | null | undefined): string | null {
  if (typeof hash !== 'string' || !HASH_RE.test(hash)) return null;
  try { const b: Buffer | null = blobs(code).get(planRef(hash)); return b == null ? null : b.toString('utf8'); } catch { return null; }
}
function store(code: string, buf: Buffer): string {
  const hash = hash12(buf);
  const b = blobs(code);
  if (!b.has(planRef(hash))) b.put(planRef(hash), buf);
  return hash;
}

const entriesOf = (me: Me, entries: Entry[] | null | undefined): Entry[] => entries || room.open(me.code).readAll();
const kvOf = (me: Me) => room.open(me.code).store.kv;

function humans(code: string): string[] {
  return Object.values((identity.readMembers(code) || {}) as Members)
    .filter((m): m is Member => !!m && !!m.name && m.role !== 'claude' && !m.left_at).map(m => m.name);
}

/**
 * Who a seat is, for consent: its account (the host's seats and its login links' carry the host's machine id).
 * Only an account merges seats; two invite seats from one machine are two people.
 */
const personOf = (m: Pick<Member, 'account'> | null | undefined): string | undefined => (m && typeof m.account === 'string' && m.account) || undefined;

/**
 * The approvers that are one person: groups of 2+ seats with one account, in approvers' order. Seats on the
 * account's own machine (machine = account: the host's local seats) are that person only while there is one of
 * them among the people present: several people can share one machine (a room on one machine), so two or more
 * are each their own person, and a login link's seat then merges with none of them.
 */
function sameOf(approvers: string[], ms: Members): string[][] {
  const here = (who: string) => Object.values(ms).filter(m => !!m && m.role !== 'claude' && !m.left_at && personOf(m) === who && m.machine === who).length;
  const by = new Map<string, string[]>();
  for (const n of approvers) {
    const m = ms[n], who = personOf(m);
    if (!who || (m.machine === who && here(who) > 1)) continue;
    by.set(who, [...(by.get(who) || []), n]);
  }
  return [...by.values()].filter(g => g.length > 1);
}

/** The host accepts a proposal's `same`: this machine is the host, or the link's host listed it (protocol.ts FIELDS). */
function sameOk(code: string): boolean {
  const s = room.open(code).store;
  if (s.isHost) return true;
  try { const d: { fields?: unknown } | null = s.kv.get('link', null); return !!d && Array.isArray(d.fields) && d.fields.includes('same'); } catch { return false; }
}

// ---------- reading the log (lib/room/consent.ts fold: the same semantics as stateLine, lane and the rows) ----------
const shape = (p: ProposalState): Proposal => ({ id: p.id, hash: p.hash, approvers: p.approvers, path: p.path, from: p.from });
const proposals = (entries: Entry[]): Proposal[] => [...room.fold(entries).proposals.values()].map(shape);

const decision = (hash: string, entries: Entry[]): Entry | null => room.fold(entries).decisions.get(hash) || null;

/** The answer matrix over p.approvers (the latest answer per person wins; an objection voids a signoff). */
const matrix = (p: Pick<Proposal, 'hash' | 'approvers'>, entries: Entry[]): Matrix => room.fold(entries).matrix(p.hash, p.approvers);

function pendingFor(me: Me | null | undefined, entries?: Entry[] | null): Proposal[] {
  if (!me || !me.name) return [];
  return room.fold(entriesOf(me, entries)).pending(me.name).map(shape);
}
function answerableFor(me: Me | null | undefined, entries?: Entry[] | null): Proposal[] {
  if (!me || !me.name) return [];
  return room.fold(entriesOf(me, entries)).answerable(me.name).map(shape);
}

/** A proposal's title: the first non-empty line of its text, heading / list / quote markers dropped. */
const titleOf = (text: string | null | undefined) => String(text || '').split('\n').map(l => l.replace(/^\s*(#{1,6}\s+|[-*+>]\s+)/, '').trim()).find(Boolean) || '';
const titles = new Map<string, string>(); // hash -> title: plans are content-addressed, so a hash's title never changes
/**
 * The title people see for proposal hash: the stored plan's first line, else the entry's "proposal HASH: title"
 * text, else ''. Not clipped (the caller clips to its width).
 */
function title(code: string, hash: string, entry?: Pick<Entry, 'text'> | null): string {
  const known = titles.get(hash);
  if (known !== undefined) return known;
  const t = titleOf(read(code, hash));
  if (t) { titles.set(hash, t); return t; }
  const m = entry && /^proposal [0-9a-f]{6,64}:\s*(.+)/.exec(String(entry.text || ''));
  return m ? m[1].trim() : '';
}

// ---------- the card ----------
const question = (hash: string) => `Agree to proposal ${hash}?`;

function summary(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let len = 0, used = 0;
  for (const l of lines) {
    if (out.length >= SUMMARY_LINES) break;
    const s: string = clip(l, TITLE_MAX);
    if (len + s.length + 1 > SUMMARY_MAX) break;
    out.push(s); len += s.length + 1; used++;
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  const rest = lines.length - used;
  return out.join('\n') + (rest > 0 ? `\n… (${rest} more lines)` : '');
}

/** p.path: the stored ref (room-relative; older entries hold an absolute path, read by its plans/ name). */
function preview(p: Proposal, code: string): string {
  const b = blobs(code);
  const ref: string = b.ref(p.path) || planRef(p.hash);
  const file: string = b.localPath(ref) || ref;
  let text: string | null = null;
  try { const buf: Buffer | null = b.get(ref); text = buf == null ? null : buf.toString('utf8'); } catch { /* missing */ }
  if (text == null) return `(proposal ${p.hash}: the text is missing; expected at ${file})`;
  if (text.length <= PREVIEW_MAX && text.split('\n').length <= PREVIEW_LINES) return text;
  return `${summary(text)}\n\nFull text: ${file}`;
}

function cardQuestion(p: Proposal, code: string): Card['questions'][number] {
  const pv = preview(p, code);
  const desc = {
    'Not yet': 'Decide later; nothing is recorded',
    Agree: `Sign off on ${p.hash}${p.from ? ` from ${p.from}` : ''}`,
    Object: 'Block it; press n to say why',
  };
  return { question: question(p.hash), header: 'Consent', multiSelect: false,
    options: (['Not yet', 'Agree', 'Object'] as const).map(label => ({ label, description: desc[label], preview: pv })) };
}
const cardFor = (ps: Proposal[], code: string): Card => ({ questions: ps.slice(0, 4).map(p => cardQuestion(p, code)) });
const card = (p: Proposal, code: string): Card => cardFor([p], code);

function viewable(p: Pick<Proposal, 'hash'>, code: string): boolean {
  const t = read(code, p.hash);
  return t != null && t.length <= VIEW_MAX && !UNSAFE_RE.test(t.replace(/\r\n/g, '\n'));
}

// ---------- which proposal a review opens (the hook picks; the model never does) ----------
const STOP_WORDS = new Set(('a an and answer approve agree are be can do for from i in is it let me my now object of on one open '
  + 'or please plan proposal proposals read review see show that the this to view want with you your').split(' '));
const wordsOf = (s: string | null | undefined) => (String(s || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);

/**
 * The pending proposal the person's words name, or null: a hash (a 6–12 hex prefix of exactly one; several
 * named: the oldest of them), else the proposal with the most words of the prompt that occur in its title and
 * in no other pending proposal's title (a unique best; "Open v3" -> "Ship v3 Monday"), else the same over the
 * full texts. Common words ("open", "the", "proposal") never count.
 */
function namedIn(ps: Proposal[], prompt: string | null | undefined, code: string): Proposal | null {
  const s = String(prompt || '').toLowerCase();
  const hex = s.match(/\b[0-9a-f]{6,12}\b/g) || [];
  const byHash = ps.filter(p => hex.some(t => p.hash.startsWith(t) && ps.filter(q => q.hash.startsWith(t)).length === 1));
  if (byHash.length) return byHash[0];
  const words = [...new Set(wordsOf(s))].filter(w => !STOP_WORDS.has(w));
  if (!words.length || !ps.length) return null;
  for (const field of [(p: Proposal) => title(code, p.hash, p.entry), (p: Proposal) => read(code, p.hash) || '']) {
    const sets = ps.map(p => new Set(wordsOf(field(p))));
    const scores = sets.map((set, i) => words.filter(w => set.has(w) && sets.every((o, j) => j === i || !o.has(w))).length);
    const max = Math.max(...scores);
    if (max > 0 && scores.filter(x => x === max).length === 1) return ps[scores.indexOf(max)];
  }
  return null;
}

/**
 * The words name no pending proposal's hash but an earlier revision's: a 6–12 hex prefix of exactly one proposal in
 * the room that a later one retired (lib/room/consent.ts superseded), followed to its latest revision, which must be
 * among ps. {old, p}, else null.
 */
function replacedIn(ps: Proposal[], prompt: string | null | undefined, code: string): { old: string, p: Proposal } | null {
  const hex = String(prompt || '').toLowerCase().match(/\b[0-9a-f]{6,12}\b/g) || [];
  if (!hex.length || !ps.length || hex.some(t => ps.some(p => p.hash.startsWith(t)))) return null;
  const f = room.fold(room.open(code).readAll());
  for (const t of hex) {
    const named = [...f.superseded.keys()].filter(h => h.startsWith(t));
    if (named.length !== 1 || [...f.proposals.keys()].filter(h => h.startsWith(t)).length !== 1) continue;
    let h = named[0];
    for (let i = 0; i < 64 && f.superseded.has(h); i++) h = f.superseded.get(h)!; // a chain of revisions, bounded
    const p = ps.find(x => x.hash === h);
    if (p) return { old: named[0], p };
  }
  return null;
}

/**
 * The person's own words ask their Claude to propose something (not to open or answer a proposal): "propose to
 * alice: …", "please make a proposal …", "can you draft a proposal …". Such a prompt never opens a review: the
 * pending one waits for a prompt that asks for it, or a plain one.
 */
const PROPOSE_RE = new RegExp('^\\s*(?:@\\S+\\s+)?(?:(?:ok(?:ay)?|now|so|please|pls|hey|then|and|let\'?s|can you|could you|would you|go ahead and)[\\s,]+)*'
  + '(?:propose|(?:make|draft|write|send|put up|put forward|post|create)\\s+(?:a|another|my|our|the|this|new)?\\s*(?:new\\s+)?proposal(?!s? (?:from|by|of)\\b))\\b', 'i');
const proposeIntent = (prompt: string | null | undefined): boolean => PROPOSE_RE.test(String(prompt || ''));

/**
 * members/NAME/pick: {hash|null, at}, the proposal the person's latest prompt named (hooks/consent.ts reads it from
 * the transcript at Pre(EnterPlanMode), or a card call named). A review opens that one while pending, else the newest.
 */
const pickKey = (me: Me) => `members/${me.name}/pick`;
const readPick = (me: Me): { hash: string | null, at: number } | null => { try { return kvOf(me).get(pickKey(me), null); } catch { return null; } };
/** Record what prompt names among ps (null when nothing) and return the proposal a review opens next; prompt null (not the person's words): the earlier pick stands. */
function choose(me: Me, ps: Proposal[], prompt: string | null | undefined): Proposal | null {
  if (prompt == null) return picked(me, ps);
  const hit = namedIn(ps, prompt, me.code) || replacedIn(ps, prompt, me.code)?.p || null;
  kvOf(me).set(pickKey(me), { hash: hit ? hit.hash : null, at: Date.now() }, { compact: true });
  return hit || ps.at(-1) || null;
}
/** The proposal a review opens among ps (pending, oldest first): the person's pick when it is one of them, else the newest. */
function picked(me: Me, ps: Proposal[]): Proposal | null {
  const pk = readPick(me);
  return (pk && pk.hash && ps.find(p => p.hash === pk.hash)) || ps.at(-1) || null;
}

/** How the model opens proposal hash for its person: the plan view (the hooks fall back to the card). */
const openCall = (hash: string) => `call EnterPlanMode, then ExitPlanMode with plan "proposal ${hash}"`;
/** A proposal as a list item: `3fa2c1 "Ship v3 Monday"` (the short hash alone without a title or a room to read it from). */
function listed(code: string | undefined, p: Pick<Proposal, 'hash' | 'entry'>): string {
  const t = code ? clip(title(code, p.hash, p.entry).replace(/\s+/g, ' ').trim(), TITLE_MAX) : '';
  return t ? `${p.hash.slice(0, 6)} "${t}"` : p.hash.slice(0, 6);
}
/** others: the other proposals awaiting name, listed by short hash and title (code: the room their titles come from). */
function reminder(p: Pick<Proposal, 'hash'>, name: string, { code, others = [] }: { code?: string, others?: Pick<Proposal, 'hash' | 'entry'>[] } = {}): string {
  const base = `proposal ${p.hash} still awaits ${name}'s answer (an earlier review closed without an answer is fine). Now ${openCall(p.hash)}, unless ${name} asked you to propose something: then do that, and this waits.`;
  if (!others.length) return base;
  return `${base} (${others.length} more await ${name}'s answer: ${others.map(o => listed(code, o)).join(', ')}; the hooks open whichever ${name} names next, else the newest.)`;
}

// ---------- writing ----------
function expand(p: string, cwd: string | undefined): string {
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(cwd || process.cwd(), p);
}

/** The propose tool's arguments (checked here, so unknown). */
interface CreateArgs { text?: unknown, path?: unknown, approvers?: unknown }
interface Created { hash: string, approvers: string[], path: string, entry: Entry | undefined, again: boolean, retired: string[] }

function create(me: Me | null | undefined, args: CreateArgs = {}, { cwd }: { cwd?: string } = {}): Created {
  if (!me || !me.code || !me.name) refuse('not in a room; run /sub-human');
  const r = room.open(me.code);
  const { text, path: file } = args;
  if ((text == null) === (file == null)) refuse('give exactly one of text or path');
  let buf: Buffer;
  if (file != null) {
    if (typeof file !== 'string' || !file.trim()) refuse('path must be a file path');
    const abs = expand(file, cwd);
    let st: fs.Stats;
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
  let approvers: string[];
  if (args.approvers == null) approvers = present;
  else {
    const named = args.approvers;
    if (!Array.isArray(named) || !named.every((a): a is string => typeof a === 'string')) refuse('approvers must be an array of names');
    approvers = [...new Set(named.map(a => a.trim().replace(/^@/, '')))];
    if (approvers.includes('claude')) refuse('approvers are people; the room\'s Claude cannot approve');
    const unknown = approvers.filter(a => !present.includes(a));
    if (unknown.length) refuse(`not in the room: ${unknown.join(', ')} (present: ${present.join(', ') || 'nobody'})`);
  }
  if (!approvers.length) refuse('nobody to ask: no humans are in the room');
  const same = sameOk(me.code) ? sameOf(approvers, identity.readMembers(me.code) || {}) : [];

  const hash = store(me.code, buf);
  const stored = planPath(me.code, hash);
  const entries: Entry[] = r.readAll();
  const open = proposals(entries).find(p => p.hash === hash);
  const before = room.fold(entries).superseded;
  if (open && !decision(hash, entries) && !before.has(hash) && open.approvers.length === approvers.length && approvers.every(a => open.approvers.includes(a))) {
    return { hash, approvers, path: stored, entry: entries.find(e => e.id === open.id), again: true, retired: [] };
  }
  // the entry stores the room-relative ref; `path` returned is where the proposer can open it
  const entry: Entry = r.append({ kind: 'proposal', text: `proposal ${hash}: ${clip(titleOf(buf.toString('utf8')), TITLE_MAX)}`, hash, approvers,
    ...(same.length ? { same } : {}), path: planRef(hash) },
    { via: 'agent', from: me.name });
  // what this entry retired: superseded by it now and not before (lib/room/consent.ts); a retired proposal proposed
  // again is appended anew (above), which brings it back
  const retired = [...room.fold([...entries, entry]).superseded].filter(([old, by]) => by === hash && !before.has(old)).map(([old]) => old);
  return { hash, approvers, path: stored, entry, again: false, retired };
}

function choiceOf(c: unknown): 'Agree' | 'Object' | 'Not yet' | null {
  const k = String(c || '').trim().toLowerCase();
  return k === 'agree' ? 'Agree' : k === 'object' ? 'Object' : k === 'not yet' ? 'Not yet' : null;
}

type Answered = { entry: Entry, stale?: undefined } | { stale: true, why: string, entry?: undefined };
function answer(me: Me, p: Pick<Proposal, 'hash'>, a: { choice?: unknown, notes?: unknown } = {}): Answered {
  const r = room.open(me.code);
  const choice = choiceOf(a.choice);
  if (choice !== 'Agree' && choice !== 'Object') return { stale: true, why: 'no choice' };
  return r.store.lock('proposal', (): Answered => {
    const entries: Entry[] = r.readAll();
    const f = room.fold(entries);
    const cur = f.proposals.get(p.hash);
    // Idempotent: one answer per seat per proposal. A card and a plan view open at once, or a reopened card,
    // never record twice, and the decision's refs are exactly the answers the fold reads as current. Another seat
    // of the same person having answered does not stop this one: the newer answer counts for both.
    if (!cur || !cur.approvers.includes(me.name) || f.decisions.has(cur.hash) || f.superseded.has(cur.hash) || f.ownAnswer(cur.hash, me.name)) {
      return { stale: true, why: 'answered, decided, superseded or unknown' };
    }
    const notes = typeof a.notes === 'string' && a.notes.trim() ? a.notes : undefined;
    const kind = choice === 'Agree' ? 'signoff' : 'objection';
    const e: { kind: string, proposal_hash: string, text?: string } = { kind, proposal_hash: cur.hash };
    if (notes !== undefined) e.text = notes; // byte-exact
    return { entry: r.append(e, { via: 'human', from: me.name }) };
  });
}

/** "tristan (also laptop), bob": one name per person, its other seats after it. */
const people = (m: Matrix, names: string[]): string => names.map(n => (m.also[n] && m.also[n].length ? `${n} (also ${m.also[n].join(', ')})` : n)).join(', ');

function decide(code: string, hash: string): Entry | null {
  if (!identity.isHost(code)) return null;
  const r = room.open(code);
  return r.store.lock('proposal', (): Entry | null => {
    const entries: Entry[] = r.readAll();
    const f = room.fold(entries);
    const cur = f.proposals.get(hash);
    if (!cur || f.decisions.has(hash) || f.superseded.has(hash)) return null;
    const m = matrix(cur, entries);
    if (!m.complete) return null;
    const text = m.objected.length
      ? `objected: ${people(m, m.objected)}${m.agreed.length ? ` · agreed: ${people(m, m.agreed)}` : ''} (proposal ${hash})`
      : `agreed: ${people(m, m.agreed)} (proposal ${hash})`;
    // complete: every approver has answered (a person's seats share one answer)
    const refs = [...new Set(cur.approvers.map((n: string) => m.answers[n]!.id))];
    return r.append({ kind: 'decision', text, proposal_hash: hash, refs: [cur.id, ...refs] }, { via: 'system', from: 'room', system: true });
  });
}

// ---------- the plan-view review state (hooks/consent.ts, hooks/session-restore.ts) ----------
/**
 * members/NAME/review: {phase, mode, at, hash?, from?, file?, backup?, restored?, tool_use_id?, …}.
 * `backup` is the session plan file's text before the review overwrote it, even when that is the proposal's own
 * text (null only when there was no file: the one the review created is removed on close), recorded BEFORE the
 * overwrite, so a crash between the two never loses the person's own plan.
 */
const reviewKey = (me: Me) => `members/${me.name}/review`;
const readReview = (me: Me): Review | null => kvOf(me).get(reviewKey(me), null);
const writeReview = (me: Me, st: Review): void => kvOf(me).set(reviewKey(me), st, { compact: true });
function clearReview(me: Me): void { kvOf(me).delete(reviewKey(me)); }
/** Every read-modify-write of the review state runs under this lock (hooks of one session can overlap). */
const withReview = <T>(me: Me, fn: () => T): T => kvOf(me).lock(reviewKey(me), fn, { timeoutMs: config.REVIEW_LOCK_TIMEOUT_MS });

/** Put the session plan file back as it was before the review (atomically); marks st.restored. */
function restorePlan(st: Review | null | undefined): void {
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
function restoreStale(me: Me | null | undefined, { force = false, now = Date.now() } = {}): 'restored' | 'cleared' | null {
  if (!me || !me.code || !me.name) return null;
  return withReview(me, () => {
    const st = readReview(me);
    if (!st) return null;
    if (!force && !(now - (Number(st.at) || 0) > config.REVIEW_STALE_MS)) return null;
    let out: 'restored' | 'cleared' = 'cleared';
    if (st.file && !st.restored && st.hash) {
      let cur: Buffer | null = null;
      try { cur = fs.readFileSync(st.file); } catch { /* gone */ }
      if (cur && hash12(cur) === st.hash) { restorePlan(st); out = 'restored'; }
    }
    clearReview(me);
    return out;
  });
}

// ---------- a review's note, waiting for the person's Send (hooks/consent.ts) ----------
/**
 * members/NAME/confirm: {hash, note, from, title, at, asked?}. A plan review rejected with a note ("Tell Claude what
 * to change", a phone deny with a note or "Suggest edits": Claude Code writes them alike, and a phone message typed
 * after a bare deny lands there too) records nothing by itself: the note waits here until the person answers the
 * confirm card. One per person: a newer note replaces it.
 */
const confirmKey = (me: Me) => `members/${me.name}/confirm`;
const readConfirm = (me: Me): Confirm | null => { try { return kvOf(me).get(confirmKey(me), null); } catch { return null; } };
const writeConfirm = (me: Me, c: Confirm): void => kvOf(me).set(confirmKey(me), c, { compact: true });
function clearConfirm(me: Me): void { try { kvOf(me).delete(confirmKey(me)); } catch { /* none */ } }

const CONFIRM_NOTE_MAX = 300;
const CONFIRM_TITLE_MAX = 80;
/** The confirm card's question: what Send does, in the person's words; the note clipped (the preview has it all). */
const confirmQuestion = (c: Confirm): string => `Send ${c.from ? `to ${c.from} ` : ''}as changes requested on "${clip(c.title || `proposal ${c.hash}`, CONFIRM_TITLE_MAX)}": "${clip(String(c.note).replace(/\s+/g, ' ').trim(), CONFIRM_NOTE_MAX)}"?`;
/** The AskUserQuestion input for a waiting note: Send records the objection with it, Discard records nothing. */
function confirmCard(c: Confirm): Card {
  const desc = {
    Send: `Record your objection${c.from ? ` to ${c.from}'s proposal` : ''}, with this note`,
    Discard: 'Record nothing; the proposal stays unanswered (reopen it any time)',
  };
  return { questions: [{ question: confirmQuestion(c), header: 'Consent', multiSelect: false,
    options: (['Send', 'Discard'] as const).map(label => ({ label, description: desc[label], preview: String(c.note) })) }] };
}

export {
  QUESTION_RE, ProposalError, readReview, writeReview, clearReview, withReview, restorePlan, restoreStale,
  readConfirm, writeConfirm, clearConfirm, confirmCard, confirmQuestion, namedIn, choose, picked, readPick,
  proposeIntent, create, proposals, pendingFor, answerableFor, personOf, sameOk, card, cardFor, question, preview, viewable, openCall, matrix, answer,
  decide, decision, humans, reminder, read, hash12, title, replacedIn,
};
