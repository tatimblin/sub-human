/**
 * plugin/sub-human/lib/proposal.ts: sign-off requests (proposals) on a room plan's versions, and the consent card.
 * Every write goes through room.append().
 *
 * Log entries:
 *   proposal  via=agent, from = who asked, {hash, approvers[], same?, path, plan, version, text}   (the plan tool's
 *             ask: ask below; hash and path are the version's, lib/plans.ts; a room from before plans holds proposals
 *             with no plan, which still fold and open)
 *   signoff | objection  via=human, from = the approver, {proposal_hash, text?}  (consent.ts, from the card;
 *             text = the card's notes, byte-exact, omitted when there are none)
 *   decision  via=system, from "room", {proposal_hash, refs: the answer ids, text "agreed: …" | "objected: …"}
 *             written once, when every approver has answered. text names one seat per person: "agreed: tristan (also
 *             laptop), bob".
 *
 * ask appends `proposal` on a plan's current version (its blob plans/<hash>.md is already stored: lib/plans.ts put).
 * approvers default to the humans present; the same open request is not re-appended. same: groups of 2+ approvers
 * that are one person (sameOf), for which the fold counts one answer. A newer version of the plan retires the request
 * (lib/room/consent.ts superseded: no longer pending; answers do not carry over). Reading goes through
 * lib/room/consent.ts fold (latest proposal per hash, latest answer per person, an objection voids a signoff), the
 * same fold stateLine, lane() and the rows read. pendingFor counts
 * another seat of my person answering as mine; answerableFor goes by my own seat's answer only, so a card or review
 * already open still records (the hooks' answer paths).
 *
 * The session document (lib/room/session.ts) holds a seat's review (the plan view), recheck (a plan-view Yes that
 * came as the view opened, asked again on the card) and confirm (a review's note waiting for the person's Send). A
 * review opens the request the person's words name (namedIn: a hash, or a plan's name), else the oldest. The lines telling the model to open a card are lib/consent/review.ts NEXT and showNote, shared with
 * consent's reoffer and lib/tail.ts remindersText.
 */

import fs from 'node:fs';
import * as identity from './identity.ts';
import * as room from './room.ts';
import * as session from './room/session.ts';
import { writeFileAtomic } from './io.ts';
import { clip, oneLine, hash12, isProposalHash } from './text.ts';
import * as config from './config.ts';
import { NEXT, showNote } from './consent/review.ts';
import type { Card, Confirm, PlanEdit, Proposal, Recheck, Review, Steer } from './types-app.ts';
import type { Entry, Matrix, Member, Members, PlanVersion, ProposalState, Trust } from './room/types.ts';
import type { Identity } from './identity.ts';
import type { RoomCode, ProposalHash } from './brand.ts';

/** Who acts: a seat's room and name are all these functions read. */
type Me = Pick<Identity, 'code' | 'name'>;

const QUESTION_RE: RegExp = /^Agree to proposal ([0-9a-f]{12})\?$/;
const PREVIEW_MAX = config.PREVIEW_MAX;     // the card withholds a longer preview (JS .length)
const PREVIEW_LINES = config.PREVIEW_LINES; // about 24 lines show at 50 rows; keep a margin
const VIEW_MAX = config.VIEW_MAX;           // the plan dialog withholds approval above 200,000 chars
const UNSAFE_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;
const SUMMARY_MAX = config.SUMMARY_MAX;
const SUMMARY_LINES = config.SUMMARY_LINES;
const TITLE_MAX = config.PROPOSAL_TITLE_MAX;

class ProposalError extends Error {}
function refuse(m: string): never { throw new ProposalError(m); }

/** A plan's ref in the room's blob store: room-relative, so the room can live anywhere (lib/room/store.ts blobs). */
const planRef = (hash: ProposalHash) => `plans/${hash}.md`;
const blobs = (code: RoomCode) => room.open(code).store.blobs;
function read(code: RoomCode, hash: string | null | undefined): string | null {
  if (!isProposalHash(hash)) return null;
  try { const b: Buffer | null = blobs(code).get(planRef(hash)); return b == null ? null : b.toString('utf8'); } catch { return null; }
}

// the recent view: every non-chat entry (proposals, answers, decisions, revisions, revokes: all the consent fold reads)
// and the lines since the last rotation
const entriesOf = (me: Me, entries: readonly Readonly<Entry>[] | null | undefined): readonly Readonly<Entry>[] => entries ?? room.open(me.code).readRecent();
const kvOf = (me: Me) => room.open(me.code).store.kv;
const storeOf = (me: Me) => room.open(me.code).store;

function humans(code: RoomCode): string[] {
  return Object.values(identity.readMembers(code) || {})
    .filter((m): m is Member => !!m && !!m.name && m.role !== 'claude' && !m.left_at).map(m => m.name);
}

/**
 * Who a seat is, for consent: its account (the host's seats and its login links' carry the host's machine id).
 * Only an account merges seats (on the host, only the owner's: sameOf); two invite seats from one machine are two people.
 */
const personOf = (m: Pick<Member, 'account'> | null | undefined): string | undefined => (m && typeof m.account === 'string' && m.account) || undefined;

/**
 * The seat of the person who opened the room, among the host's own seats of account `who` (machine = account): the
 * one the room recorded (lib/room/members.ts join), else, in a room from before that, the earliest-joined one present.
 */
function ownerOf(ms: Members, who: string): string | undefined {
  const host = Object.values(ms).filter(m => !!m && m.role !== 'claude' && personOf(m) === who && m.machine === who);
  const marked = host.find(m => m.owner);
  if (marked) return marked.name;
  const at = (m: Member) => { const t = Date.parse(String(m.joined_at)); return Number.isFinite(t) ? t : Infinity; };
  return host.filter(m => !m.left_at).sort((a, b) => at(a) - at(b))[0]?.name;
}

/**
 * The approvers that are one person: groups of 2+ seats with one account, in approvers' order. A login link's seats
 * (the account's, on another machine) are the person who opened the room (ownerOf); of the seats on the account's
 * own machine (machine = account: the host's) only that owner's counts: several people can share one machine, so
 * the others there are each their own person. An invite's seat has no account and merges with none.
 */
function sameOf(approvers: string[], ms: Members): string[][] {
  const by = new Map<string, string[]>();
  for (const n of approvers) {
    const m = ms[n], who = personOf(m);
    if (!m || !who || (m.machine === who && ownerOf(ms, who) !== n)) continue; // no seat: no person (personOf)
    by.set(who, [...(by.get(who) ?? []), n]);
  }
  return [...by.values()].filter(g => g.length > 1);
}

// ---------- reading the log (lib/room/consent.ts fold: the same semantics as stateLine, lane and the rows) ----------
const shape = (p: ProposalState): Proposal => ({ id: p.id, hash: p.hash, approvers: p.approvers, path: p.path, from: p.from });
const proposals = (entries: readonly Readonly<Entry>[], trust: Trust = room.trustOf): Proposal[] => [...room.fold(entries, trust).proposals.values()].map(shape);

const decision = (hash: string, entries: readonly Readonly<Entry>[], trust: Trust = room.trustOf): Entry | null => room.fold(entries, trust).decisions.get(hash) ?? null;

/** The answer matrix over p.approvers (the latest answer per person wins; an objection voids a signoff). */
const matrix = (p: Pick<Proposal, 'hash' | 'approvers'>, entries: readonly Readonly<Entry>[], trust: Trust = room.trustOf): Matrix => room.fold(entries, trust).matrix(p.hash, p.approvers);

function pendingFor(me: Me | null | undefined, entries?: readonly Readonly<Entry>[] | null): Proposal[] {
  if (!me || !me.name) return [];
  return room.open(me.code).fold(entriesOf(me, entries)).pending(me.name).map(shape);
}
function answerableFor(me: Me | null | undefined, entries?: readonly Readonly<Entry>[] | null): Proposal[] {
  if (!me || !me.name) return [];
  return room.open(me.code).fold(entriesOf(me, entries)).answerable(me.name).map(shape);
}

/** A proposal's title: the first non-empty line of its text, heading / list / numbered-list / quote markers dropped,
 * however many lead it ("1. Add an MIT LICENSE file" and "# 1. Add an MIT LICENSE file" are titled "Add an MIT LICENSE
 * file"). */
const planTitle = (text: string | null | undefined) => String(text || '').split('\n').map(l => l.replace(/^\s*(?:(?:#{1,6}|[-*+>]|\d{1,3}[.)])\s+)+/, '').trim()).find(Boolean) || '';
const titles = new Map<string, string>(); // hash -> title: plans are content-addressed, so a hash's title never changes
/**
 * The title people see for proposal hash: a room plan's version ("plan paging v3"), else the stored text's first
 * line, else the entry's "proposal HASH: title" text, else ''. Not clipped (the caller clips to its width).
 */
function title(code: RoomCode, hash: string, entry?: Pick<Entry, 'text' | 'plan' | 'version'> | null): string {
  const known = titles.get(hash);
  if (known !== undefined) return known;
  // the request's own plan and version (a display only: the consent fold reads a version from the plan entries; an
  // entry with neither is a request from before plans), else, with no entry, the plan fold of the recent view (plan
  // entries are non-chat: all of them are there)
  let v: Pick<PlanVersion, 'plan' | 'version'> | null = entry && typeof entry.plan === 'string' && typeof entry.version === 'number' ? { plan: entry.plan, version: entry.version } : null;
  if (!v && !entry) { try { const r = room.open(code); v = r.fold(r.readRecent()).versionOf(hash); } catch { /* no room */ } }
  if (v) { const t = `plan ${v.plan} v${v.version}`; titles.set(hash, t); return t; }
  const t = planTitle(read(code, hash));
  if (t) { titles.set(hash, t); return t; }
  const m = entry && /^proposal [0-9a-f]{6,64}:\s*(.+)/.exec(String(entry.text || ''));
  return (m?.[1] ?? '').trim();
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
  while (out.length && !out.at(-1)?.trim()) out.pop();
  const rest = lines.length - used;
  return out.join('\n') + (rest > 0 ? `\n… (${rest} more lines)` : '');
}

/** p.path: the stored ref (room-relative). */
function preview(p: Proposal, code: RoomCode): string {
  const b = blobs(code);
  const ref: string = b.ref(p.path) || planRef(p.hash);
  const file: string = b.localPath(ref) || ref;
  let text: string | null = null;
  try { const buf: Buffer | null = b.get(ref); text = buf == null ? null : buf.toString('utf8'); } catch { /* missing */ }
  if (text == null) return `(proposal ${p.hash}: the text is missing; expected at ${file})`;
  if (text.length <= PREVIEW_MAX && text.split('\n').length <= PREVIEW_LINES) return text;
  return `${summary(text)}\n\nFull text: ${file}`;
}

function cardQuestion(p: Proposal, code: RoomCode): Card['questions'][number] {
  const pv = preview(p, code);
  const desc = {
    'Not yet': 'Decide later; nothing is recorded',
    Agree: `Sign off on ${p.hash}${p.from ? ` from ${p.from}` : ''}`,
    Object: 'Block it; press n to say why',
  };
  return { question: question(p.hash), header: 'Consent', multiSelect: false,
    options: (['Not yet', 'Agree', 'Object'] as const).map(label => ({ label, description: desc[label], preview: pv })) };
}
const cardFor = (ps: Proposal[], code: RoomCode): Card => ({ questions: ps.slice(0, 4).map(p => cardQuestion(p, code)) });
const card = (p: Proposal, code: RoomCode): Card => cardFor([p], code);

/** The plan dialog can show it: stored, <= VIEW_MAX chars, no control or bidi characters (the dialog withholds
 * approval for those); else the card. */
function viewable(p: Pick<Proposal, 'hash'>, code: RoomCode): boolean {
  const t = read(code, p.hash);
  return t != null && t.length <= VIEW_MAX && !UNSAFE_RE.test(t.replace(/\r\n/g, '\n'));
}

// ---------- which request a review opens (the hook picks; the model never does) ----------
/**
 * The pending request the person's words name, or null: a hash (a 6–12 hex prefix of exactly one; several named: the
 * oldest of them), else a plan's name standing alone in the words ("let me sign off on paging") when exactly one
 * pending request is for that plan's version.
 */
function namedIn(ps: Proposal[], prompt: string | null | undefined, code: RoomCode): Proposal | null {
  const s = String(prompt || '').toLowerCase();
  const hex = s.match(/\b[0-9a-f]{6,12}\b/g) ?? [];
  const byHash = ps.filter(p => hex.some(t => p.hash.startsWith(t) && ps.filter(q => q.hash.startsWith(t)).length === 1));
  const [first] = byHash;
  if (first) return first;
  if (!ps.length) return null;
  const words = new Set(s.match(/[a-z0-9][a-z0-9-]*/g) ?? []);
  const f = (r => r.fold(r.readRecent()))(room.open(code));
  const hits = ps.filter(p => { const v = f.versionOf(p.hash); return !!v && words.has(v.plan); });
  return hits.length === 1 ? hits[0] ?? null : null;
}

/** The request a review opens among ps (pending, oldest first) when the person's words name none: the oldest. */
const picked = (ps: Proposal[]): Proposal | null => ps[0] ?? null;

/** How the model opens proposal hash for its person (the plan view; the hooks fall back to the card), how it shows
 * the confirm card for a waiting note, and the line telling it to show that card now (after an Esc on it: that the
 * Esc was no answer): lib/consent/review.ts's lines, which the consent hook, the tail and the room server share. */
const openCall: (h: string) => string = NEXT.open;
const confirmCall: (h: string) => string = NEXT.note;
const showConfirm: typeof showNote = showNote;
/** A proposal as the re-ask lists it: `3fa2c1 "plan paging v3"` (the short hash alone without a title or a room). */
type Listed = Pick<Proposal, 'hash'> & { entry?: Proposal['entry'] | undefined };
function listed(code: RoomCode | undefined, p: Listed): string {
  const t = code ? clip(title(code, p.hash, p.entry).replace(/\s+/g, ' ').trim(), TITLE_MAX) : '';
  return t ? `${p.hash.slice(0, 6)} "${t}"` : p.hash.slice(0, 6);
}
/** The re-ask (a review closed without an answer is fine to reopen). others: the other requests awaiting name, listed by short hash and title (code: the room their titles come from). */
function reminder(p: Pick<Proposal, 'hash'>, name: string, { code, others = [] }: { code?: RoomCode, others?: Listed[] } = {}): string {
  const what = code ? title(code, p.hash) : '';
  const base = `${what.startsWith('plan ') ? `${what} (proposal ${p.hash})` : `proposal ${p.hash}`} still awaits ${name}'s sign-off (an earlier review closed without an answer is fine). When ${name} wants to answer, ${openCall(p.hash)}.`;
  if (!others.length) return base;
  return `${base} (${others.length} more await ${name}'s answer: ${others.map(o => listed(code, o)).join(', ')}; the hooks open whichever plan ${name} names, else the oldest.)`;
}

// ---------- asking for sign-off on a plan version ----------
/** The plan tool's ask arguments (checked here, so unknown). */
interface AskArgs { plan?: unknown, approvers?: unknown }
interface Asked { hash: ProposalHash, approvers: string[], plan: string, version: number, entry: Entry | undefined, again: boolean }

/**
 * Ask the room's people to sign off on plan's current version (lib/plans.ts): a `proposal` entry on that version's
 * hash, naming the plan and version. approvers default to the humans present. The same request still open is not
 * appended again; a version decided already is refused (an objected one needs a new version first). Who may ask: any
 * member's Claude for its person; only the people answer, each in their own session.
 */
function ask(me: Me | null | undefined, args: AskArgs = {}): Asked {
  if (!me || !me.code || !me.name) refuse('not in a room; run /sub-human');
  const r = room.open(me.code);
  const name = args.plan == null || args.plan === '' ? 'room' : String(args.plan).trim().toLowerCase();
  const entries = r.readRecent();
  const f = r.fold(entries);
  const p = f.plans.get(name);
  if (!p) refuse(`no plan ${name} in this room${f.plans.size ? ` (plans: ${[...f.plans.keys()].join(', ')})` : ''}; edit it first`);
  const v = p.current;
  const dec = f.decisions.get(v.hash);
  if (dec) refuse(`plan ${name} v${v.version} is decided already (${String(dec.text || '')}); for another round, edit the plan first (a new version)`);
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
  const open = f.proposals.get(v.hash);
  if (open && !f.superseded.has(v.hash) && open.approvers.length === approvers.length && approvers.every(a => open.approvers.includes(a))) {
    return { hash: v.hash, approvers, plan: name, version: v.version, entry: open.entry, again: true };
  }
  const same = sameOf(approvers, identity.readMembers(me.code) || {});
  const entry: Entry = r.append({ kind: 'proposal', text: `proposal ${v.hash}: plan ${name} v${v.version}${v.summary ? `: ${clip(v.summary, TITLE_MAX)}` : ''}`,
    hash: v.hash, approvers, ...(same.length ? { same } : {}), path: planRef(v.hash), plan: name, version: v.version },
    { via: 'agent', from: me.name });
  return { hash: v.hash, approvers, plan: name, version: v.version, entry, again: false };
}

function choiceOf(c: unknown): 'Agree' | 'Object' | 'Not yet' | null {
  const k = String(c || '').trim().toLowerCase();
  return k === 'agree' ? 'Agree' : k === 'object' ? 'Object' : k === 'not yet' ? 'Not yet' : null;
}

type Answered = { entry: Entry, stale?: undefined } | { stale: true, why: string, entry?: undefined };
/** The person's answer, under the proposal lock; signed, so any machine may write it. */
function answer(me: Me, p: { hash: string }, a: { choice?: unknown, notes?: unknown } = {}): Answered {
  const r = room.open(me.code);
  const choice = choiceOf(a.choice);
  if (choice !== 'Agree' && choice !== 'Object') return { stale: true, why: 'no choice' };
  return r.store.lock('proposal', (): Answered => {
    const f = r.fold();
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

/** Host only (null elsewhere): under the proposal lock, the decision once every approver has answered; a decided,
 * superseded, unknown or incomplete proposal appends nothing. The consent hook calls it after each answer. */
function decide(code: RoomCode, hash: string): Entry | null {
  if (!identity.isHost(code)) return null;
  const r = room.open(code);
  return r.store.lock('proposal', (): Entry | null => {
    const entries = r.readRecent();
    const f = r.fold(entries);
    const cur = f.proposals.get(hash);
    if (!cur || f.decisions.has(hash) || f.superseded.has(hash)) return null;
    const m = matrix(cur, entries, r.trust);
    if (!m.complete) return null;
    const text = m.objected.length
      ? `objected: ${people(m, m.objected)}${m.agreed.length ? ` · agreed: ${people(m, m.agreed)}` : ''} (proposal ${hash})`
      : `agreed: ${people(m, m.agreed)} (proposal ${hash})`;
    // complete: every approver has answered (a person's seats share one answer)
    const refs = [...new Set(cur.approvers.flatMap((n: string) => { const a = m.answers[n]; return a ? [a.id] : []; }))]; // complete: each one there
    return r.append({ kind: 'decision', text, proposal_hash: hash, refs: [cur.id, ...refs] }, { via: 'system', from: 'room', system: true });
  });
}

// ---------- the plan-view review state (hooks/consent.ts, hooks/handlers/session-restore.ts) ----------
/**
 * The session's review: {phase, mode, at, hash?, from?, file?, backup?, restored?, tool_use_id?, …}.
 * `backup` is the session plan file's text before the review overwrote it, even when that is the proposal's own
 * text (null only when there was no file: the one the review created is removed on close), recorded BEFORE the
 * overwrite, so a crash between the two never loses the person's own plan.
 */
const readReview = (me: Me): Review | null => session.get(storeOf(me), me.name, 'review') ?? null;
const writeReview = (me: Me, st: Review): void => session.put(storeOf(me), me.name, 'review', st);
function clearReview(me: Me): void { session.put(storeOf(me), me.name, 'review', undefined); }
/** Every read-modify-write of the review state runs under this lock (hooks of one session can overlap). Its own lock,
 * not the session document's: each write inside takes that one. */
const withReview = <T>(me: Me, fn: () => T): T => kvOf(me).lock(`members/${me.name}/review`, fn, { timeoutMs: config.REVIEW_LOCK_TIMEOUT_MS });

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
function restoreStale(me: Me | null | undefined, { force = false, now = Date.now() }: { force?: boolean; now?: number } = {}): 'restored' | 'cleared' | null {
  if (!me || !me.code || !me.name) return null;
  return withReview(me, () => {
    const st = readReview(me);
    if (!st) return null;
    if (!force && !(now - (Number(st.at) || 0) > config.REVIEW_STALE_MS)) return null;
    let out: 'restored' | 'cleared' = 'cleared';
    if (st.file && !st.restored && st.hash) {
      let cur: Buffer | null = null;
      try { cur = fs.readFileSync(st.file); } catch { /* gone */ }
      // the proposal's text, or nothing (emptied for the closing ExitPlanMode: lib/cc/env.ts LEAVE_PLAN_TEXT)
      if (cur && (hash12(cur) === st.hash || !cur.length)) { restorePlan(st); out = 'restored'; }
    }
    clearReview(me);
    return out;
  });
}

// ---------- a room plan edit in this session (lib/consent/edit.ts; hooks/consent.ts) ----------
/** The session's edit (the plan tool's edit op opens it; hooks/consent.ts runs it under withReview). */
const readEdit = (me: Me): PlanEdit | null => { try { return session.get(storeOf(me), me.name, 'edit') ?? null; } catch { return null; } };
const writeEdit = (me: Me, e: PlanEdit): void => session.put(storeOf(me), me.name, 'edit', e);
function clearEdit(me: Me): void { try { session.put(storeOf(me), me.name, 'edit', undefined); } catch { /* none */ } }

// ---------- a review's note, waiting for the person's Send (hooks/consent.ts) ----------
/**
 * The session's confirm: {hash, note, from, title, at, stage} (lib/consent/review.ts: where its card stands). A plan review rejected with a note ("Tell Claude what
 * to change") records nothing by itself: the note waits here until the person answers the
 * confirm card. One per person: a newer note replaces it.
 */
const readConfirm = (me: Me): Confirm | null => { try { return session.get(storeOf(me), me.name, 'confirm') ?? null; } catch { return null; } };
const writeConfirm = (me: Me, c: Confirm): void => session.put(storeOf(me), me.name, 'confirm', c);
function clearConfirm(me: Me): void { try { session.put(storeOf(me), me.name, 'confirm', undefined); } catch { /* none */ } }

/** A plan-view Yes waiting for its confirmation on the card (lib/consent/review.ts recheck): {hash, at} or null. */
const readRecheck = (me: Me): Recheck | null => { try { return session.get(storeOf(me), me.name, 'recheck') ?? null; } catch { return null; } };
const writeRecheck = (me: Me, r: Recheck): void => session.put(storeOf(me), me.name, 'recheck', r);
function clearRecheck(me: Me): void { try { session.put(storeOf(me), me.name, 'recheck', undefined); } catch { /* none */ } }

/** An ExitPlanMode denied once because it would show the person's own plan while a request waited (lib/consent/review.ts
 * steer): {hash, plan, at} or null. */
const readSteer = (me: Me): Steer | null => { try { return session.get(storeOf(me), me.name, 'steer') ?? null; } catch { return null; } };
const writeSteer = (me: Me, s: Steer): void => session.put(storeOf(me), me.name, 'steer', s);
function clearSteer(me: Me): void { try { session.put(storeOf(me), me.name, 'steer', undefined); } catch { /* none */ } }

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

/** Notes shorter than this match a post only when equal: "no" or "later" would match half the room's posts. */
const NOTE_MATCH_MIN = 12;
const QUOTES_RE = /["'“”‘’]/g;
const plainOf = (s: unknown): string => oneLine(oneLine(s).toLowerCase().replace(QUOTES_RE, ''));
/**
 * The post `text` carries the note `c.note` (mcp/room-server.ts post: a Claude relaying its person's objection):
 * case, spacing and quote marks aside, the post contains it; a note under NOTE_MATCH_MIN chars only when equal.
 */
function repeatsNote(c: Pick<Confirm, 'note'> | null | undefined, text: unknown): boolean {
  const note = plainOf(c && c.note), post = plainOf(text);
  if (!note) return false;
  return note.length < NOTE_MATCH_MIN ? post === note : post.includes(note);
}

export {
  QUESTION_RE, ProposalError, readReview, writeReview, clearReview, withReview, restorePlan, restoreStale,
  readEdit, writeEdit, clearEdit, readConfirm, writeConfirm, clearConfirm, readRecheck, writeRecheck, clearRecheck, readSteer, writeSteer, clearSteer, confirmCard, confirmQuestion, repeatsNote, namedIn, picked,
  ask, proposals, pendingFor, answerableFor, personOf, card, cardFor, question, preview, viewable, openCall,
  confirmCall, showConfirm, matrix, answer, decide, decision, humans, reminder, read, hash12, title,
};
