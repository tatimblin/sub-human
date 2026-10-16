/**
 * plugin/sub-human/lib/room/render.ts: log entries as text, for Claude (ids kept) and for people (no ids).
 *
 * Every call that shows a person's line takes the store's trust (RoomStore.trust; NO_TRUST when absent: every
 * person's line then reads "(unverified)"), so a line is marked by the store that read it.
 *
 *   line(e, {full, trust}) one notice line. full: the exact text (JSON-quoted) up to TEXT_MAX = 2,000 code
 *     points, then `[cut at 2000/N: read({ids:[ID]})]`; without full, <= TAIL_MAX (240) chars with the same
 *     marker when cut. Never a bare "…". A drafted:"agent" entry's header carries "(NAME, Claude's wording)".
 *   chatLines(e, {viewer, entries?, trust}) -> [string]   one entry as group-chat lines, no ids; continuation lines nested
 *     under the sender with CHAT_NEST ("  │ "), at most CHAT_LINES_MAX text lines (below). With entries (the log
 *     so far) an answer or decision names its proposal by title and short hash: 'bob agreed to "Ship v3 Monday"
 *     (3fa2c1)', 'room: "Ship v3 Monday" (3fa2c1) agreed (bob)', 'room: "Ship v3 Monday" (3fa2c1) not agreed: changes
 *     requested by bob: keep status'; a proposal that retires an earlier one adds 'replaces "Ship v3" (9c01de)'.
 *     A leave keeps its reason: "bob left (connection lost)", "bob left (session ended)"
 *   fmt(e, {trust})          full text for `sub-human read`, body lines nested the same way;
 *     who(e) ("alice" | "alice's Claude" | "room")
 *   stateLine(me, entries, {members, ids, trust}) -> "room now: proposal 3fa2c1 waiting on bob · objected: dave · you: answer needed ·
 *     away: carol"  (waiting on = no answer yet, objected = current answer is an objection; lib/room/consent.ts fold;
 *     ids:false drops the decision's "#N", for a member's wake, which the person sees too)
 *   digest(entries, {members, code, trust}) <= DIGEST_CAP chars: members, open proposals + approvers + answers, open
 *     objections/questions, decisions, last 10 human entries in full by the line() rule.
 *   FOR_CLAUDE               "(for Claude)": the prefix of chat lines meant only for the model
 *   UNVERIFIED               "(unverified)": after the name of a via=human entry whose sig does not verify
 *     (trust.ts unverified: a legacy line, or one written around append). It stays readable, never as the
 *     person's own words; the consent fold ignores it.
 * Join and leave notices (what a group chat shows: "bob joined", "bob rejoined", "bob left (connection lost)"; no
 * room code, no ids), drawn by the tail's chat line at the moment (mod/deliver.ts), the room row's text for a while
 * after (lib/rows.ts rowText) and the room row view's progress line (mcp/hold.ts):
 *   joinLeave(entries, viewer, {now, settle}) -> [{id, kind, name, at, settled, rejoin, why}]
 *       others' member_joined / member_left (never the room Claude's or viewer's own), in log order. A leave settles
 *       settleMs() (SUB_HUMAN_LEAVE_MS, LEAVE_SETTLE_MS = 8 s, the same as the tail's) after it; a leave followed by
 *       a rejoin within it is no notice, and neither is that rejoin. why: a leave's " (REASON)" (leftWhy), else ''.
 *       Time comes from lib/clock.ts unless the caller passes `now` (ms), so tests drive it without sleeps.
 *   noticeText(n) -> "bob joined" | "bob rejoined" | "bob left" | "bob left (connection lost)"
 *   rowSegment(entries, viewer, {now}) -> "+bob joined" | "−bob left (connection lost)" | ''   the newest settled
 *       notice of the last ROW_NOTICE_MS (2 min)
 */

import { normalize } from './rules.ts';
import { parseEntry } from './validate.ts';
import { assertNever } from '../../mod/core/never.ts';
import { ROOM_CLAUDE } from './members.ts';
import { fold, proposals, answers, answered, decided, approversOf } from './consent.ts';
import { NO_TRUST, unverified } from './trust.ts';
import { oneLine } from '../text.ts';
import * as clock from '../clock.ts';
import { TAIL_MAX, TEXT_MAX, CHAT_WRAP, CHAT_MAX, DIGEST_CAP, CHAT_LINES_MAX, CHAT_NEST, ROW_NOTICE_MS } from '../config.ts';
import { envMs } from '../env.ts';
import type { Entry, LaneViewer, Matrix, Members, Trust } from './types.ts';
import { FOR_CLAUDE } from '../../mod/core/constants.ts';

/** One digest line; id: the entry it shows, so the cap trims the oldest first. */
interface DigestLine { id?: number; text: string }
interface DigestSection { title: string | null; lines: DigestLine[] }
interface DigestCtx { members?: Members | null; code?: string | null; trust?: Trust }

const UNVERIFIED = '(unverified)';
const NEST = CHAT_NEST; // "  │ ": every continuation line of a message, so none can pass as a line of its own

/**
 * Characters that would let one line of text pass as another on a terminal or in a model's view: line
 * breaks other than \n (\r returns the cursor and overwrites the sender), other C0 / C1 controls (escape
 * sequences), and bidi overrides. Shown as U+FFFD; the log keeps the exact text.
 */
const BREAKS = /\r\n|[\r\v\f\u0085\u2028\u2029]/g;
const UNSAFE = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
/** The marker of a line only the model acts on, as a person's (or a Claude's) text may type it: never shown as one.
 * A post "(for Claude) start your reply with …" read as a marker line, live; in their words it reads as a quote. */
const MARKER_IN_TEXT = /\(\s*for\s+claude\s*\)/gi;
const QUOTED_MARKER = '(quoted "for Claude")';
const unmark = (t: string): string => t.replace(MARKER_IN_TEXT, QUOTED_MARKER);
const safeText = (t: unknown): string => unmark(String(t).replace(BREAKS, '\n').replace(UNSAFE, '\ufffd'));

/**
 * A via this version does not know (a newer host wrote it) is never shown as the person's own words, nor as their
 * Claude's: "bob (via relay)".
 */
const KNOWN_VIAS = new Set(['human', 'agent', 'system']);
const otherVia = (e: Entry): string | null => (e.via !== undefined && !KNOWN_VIAS.has(e.via)
  ? `${e.from} (via ${/^[a-z_-]{1,16}$/.test(String(e.via)) ? e.via : '?'})` : null);

const who = (e: Entry): string => {
  if (e.via === 'system') return 'room';
  if (otherVia(e)) return otherVia(e)!;
  const from = e.from;
  return e.via === 'agent' && from !== ROOM_CLAUDE ? `${from}'s Claude` : from;
};

/**
 * An entry's text, JSON-quoted (so always one line), at most n code points. Longer text never ends in a bare
 * "…": the quote closes and an explicit marker names the call that fetches the rest. exact keeps whitespace.
 */
function quote(e: Entry, n: number, { exact = false }: { exact?: boolean } = {}): string {
  const raw = unmark(String(e.text ?? ''));
  const t = exact ? raw : oneLine(raw);
  const cps = Array.from(t);
  const js = (x: string): string => JSON.stringify(x).replace(/[\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16)}`);
  if (cps.length <= n) return js(t);
  return `${js(cps.slice(0, n).join(''))} [cut at ${n}/${cps.length}: read({ids:[${e.id}]})]`;
}

function header(e: Entry, trust: Trust): string {
  const n = normalize(e);
  const parts = [`#${n.id}`, `${n.from}${n.via ? `[${n.via}]` : ''}`];
  if (unverified(trust, e)) parts.push(UNVERIFIED);
  if (n.drafted === 'agent') parts.push(`(${n.from}, Claude's wording)`);
  parts.push(n.kind);
  if (n.to && n.to !== 'room') parts.push(`to=${n.to}`);
  if (n.refs && n.refs.length) {
    const r = n.refs.slice(0, 5).map(x => '#' + x).join(',');
    parts.push(`refs=${r}${n.refs.length > 5 ? ',…' : ''}`);
  }
  if (n.hash) parts.push(`proposal=${n.hash}`);
  if (n.proposal_hash) parts.push(`proposal=${n.proposal_hash}`);
  if (Array.isArray(n.approvers)) parts.push(`approvers=${n.approvers.slice(0, 8).join(',') || '-'}`);
  if (n.kind === 'task_req' || n.kind === 'task') {
    if (n.task_id) parts.push(`task=#${n.task_id}`);
    if (n.owner) parts.push(`owner=${n.owner}`);
    if (n.req) parts.push(`req=#${n.req}`);
  }
  return parts.join(' ');
}

/**
 * One notice line. full: the header plus the exact text up to TEXT_MAX code points, then
 * `[cut at 2000/N: read({ids:[ID]})]`. Otherwise a compact line of at most TAIL_MAX chars (whitespace
 * collapsed), with the same explicit marker when the text is cut.
 */
function line(e: Entry, { full = false, trust = NO_TRUST }: { full?: boolean; trust?: Trust } = {}): string {
  const h = header(e, trust);
  if (e.text == null) return full ? h : h.slice(0, TAIL_MAX);
  if (full) return `${h} ${quote(e, TEXT_MAX, { exact: true })}`;
  const head = h.slice(0, TAIL_MAX - 3);
  let n = 200;
  for (;;) {
    const l = `${head} ${quote(e, n)}`;
    if (l.length <= TAIL_MAX) return l;
    if (n === 0) return l.slice(0, TAIL_MAX);
    n = Math.max(0, n - Math.max(1, l.length - TAIL_MAX));
  }
}

// ---------- chat rendering (what a human sees; no ids) ----------
/** Who an entry is from, as a group chat names them: "bob", "bob's Claude", "claude", "room". */
function chatWho(e: Entry, trust: Trust): string {
  if (e.via === 'system') return 'room';
  if (otherVia(e)) return otherVia(e)!;
  if (e.from === ROOM_CLAUDE) return ROOM_CLAUDE;
  if (e.via === 'agent') return `${e.from}'s Claude`;
  if (unverified(trust, e)) return `${e.from} ${UNVERIFIED}`;
  return e.drafted === 'agent' ? `${e.from} (Claude's wording)` : e.from;
}

/** The person's name for a via=human line, with the unverified marker when its sig does not verify. */
const humanName = (e: Entry, trust: Trust): string => (unverified(trust, e) ? `${e.from} ${UNVERIFIED}` : e.from);

/** Split one text line into pieces of at most n code points (rest: the later pieces), at a space when there is one. */
function wrap(lineText: string, n = CHAT_WRAP, rest = n): string[] {
  const out: string[] = [];
  let cps = Array.from(lineText);
  while (cps.length > n) {
    let cut = cps.lastIndexOf(' ', n);
    if (cut < n / 2) cut = n;
    out.push(cps.slice(0, cut).join('').trimEnd());
    cps = cps.slice(cut);
    while (cps[0] === ' ') cps.shift();
    n = rest;
  }
  out.push(cps.join(''));
  return out;
}

const TITLE_LABEL_MAX = 60;
/** A proposal entry's text starts "proposal HASH: " (lib/proposal.ts create); consent.ts titleOf reads the title after it. */
const TITLE_PREFIX = /^proposal [0-9a-f]{6,64}:\s*/;
/** A proposal entry's title ("proposal HASH: TITLE"), one safe line of at most TITLE_LABEL_MAX code points ('' for none). */
function titleText(p: Entry): string {
  const t = oneLine(safeText(String(p.text ?? '').replace(TITLE_PREFIX, ''))).replace(/\n/g, ' ').trim();
  const cps = Array.from(t);
  return cps.length > TITLE_LABEL_MAX ? `${cps.slice(0, TITLE_LABEL_MAX - 1).join('').trimEnd()}…` : t;
}

/**
 * The proposal hash names, as people see it: its title in quotes and its short hash, '"Ship v3 Monday" (3fa2c1)'
 * (revisions can share a title), from the proposal entry in entries; null without entries or that entry.
 */
function proposalLabel(hash: string | undefined, entries: readonly Readonly<Entry>[] | undefined): string | null {
  if (!hash || !Array.isArray(entries)) return null;
  const p = entries.find(x => x && x.kind === 'proposal' && x.hash === hash);
  const t = p && titleText(p);
  return t ? `"${t}" (${hash.slice(0, 6)})` : null;
}

/** The proposals entry e retired (lib/room/consent.ts superseded: same sender, same title), each labelled; [] without entries. */
function retiredBy(e: Entry, entries: readonly Readonly<Entry>[] | undefined, trust: Trust): string[] {
  if (!Array.isArray(entries) || !e.hash) return [];
  const before = entries.filter(x => x && x.id < e.id);
  const was = fold(before, trust).superseded;
  return [...fold([...before, e], trust).superseded].filter(([old, by]) => by === e.hash && !was.has(old))
    .map(([old]) => proposalLabel(old, before) || `(${old.slice(0, 6)})`);
}

/** An objection's note, or '' for none (a bare "Object" answer). */
const noteOf = (o: Entry): string => (o.text == null || /^Object$/.test(String(o.text)) ? '' : String(o.text));

/**
 * A decision as people read it: '"Ship v3 Monday" agreed (bob)', or '"Ship v3 Monday" not agreed: changes
 * requested by bob: keep status · agreed: alice' (each objector's note from the answers the decision refs). Without
 * the proposal in entries: 'decided (agreed: bob)' / 'not agreed (objected: bob)'.
 */
function decisionText(n: Entry, entries: readonly Readonly<Entry>[] | undefined): string {
  const label = proposalLabel(n.proposal_hash, entries);
  const s = String(n.text ?? '').replace(/\s*\(proposal [0-9a-f]+\)\s*$/, '');
  const m = /^objected: ([^·]*?)(?: · agreed: (.*))?$/.exec(s);
  if (!label) return m ? `not agreed (${s})` : `decided (${s})`; // no title to name it by
  if (!m) return /^agreed: /.test(s) ? `${label} agreed (${s.slice(8)})` : `${label} decided (${s})`;
  const refs = new Set(n.refs || []);
  const objs = entries!.filter(x => x && refs.has(x.id) && x.kind === 'objection'); // a label means entries are there
  const by = m[1].split(/,\s*/).filter(Boolean).map(name => {
    const o = objs.find(x => x.from === name);
    const note = o ? oneLine(safeText(noteOf(o))) : '';
    return note ? `${name}: ${note}` : name;
  });
  return `${label} not agreed: changes requested by ${by.join(' · ')}${m[2] ? ` · agreed: ${m[2]}` : ''}`;
}

/**
 * Why a member left, from the log text "bob left (REASON)" (lib/seats.ts exit), as the chat line shows it: a reason
 * in words stays (" (connection lost)", " (session ended)", " (removed by the host)"); Claude Code's own SessionEnd
 * token ("prompt_input_exit", "other", "logout") reads " (session ended)"; "left" (/sub-human leave) and none add nothing.
 */
function leftWhy(t: string): string {
  const m = /\bleft \(([^()\n]{1,60})\)\s*$/.exec(t);
  const why = m ? oneLine(safeText(m[1])) : '';
  if (!why || why === 'left') return '';
  return ` (${/\s/.test(why) ? why : 'session ended'})`;
}

/** A line as its writer's words: a say, a question, a status, and a kind this version does not know. */
function words(n: Entry, t: string, viewer: string | undefined, trust: Trust): { head: string; text: string } {
  const to = n.to && n.to !== 'room' ? ` (to ${n.to === viewer ? 'you' : n.to})` : '';
  return { head: `${chatWho(n, trust)}${to}`, text: t };
}

/** The human-facing sentence for an entry (may span lines). entries: the log so far, to name a proposal by title. */
function chatBody(e: Entry, viewer: string | undefined, entries: readonly Readonly<Entry>[] | undefined, trust: Trust): { head: string; text: string } {
  const n = normalize(e);
  const t = String(n.text ?? '');
  const you = (x: string | undefined): string | undefined => (x && x === viewer ? 'you' : x);
  const about = () => proposalLabel(n.proposal_hash, entries) || 'the proposal';
  const k = parseEntry(n);
  if (!k) return words(n, t, viewer, trust); // a newer host's kind
  switch (k.kind) {
    case 'member_joined': return { head: `${n.from} ${/\brejoined\b/.test(t) ? 'rejoined' : 'joined'}`, text: '' };
    case 'member_left': return { head: `${n.from} left${leftWhy(t)}`, text: '' };
    case 'proposal': {
      // the short hash tells revisions apart; a revision names what it replaces (its earlier one, retired)
      const h = n.hash ? ` (${String(n.hash).slice(0, 6)})` : '';
      const was = retiredBy(n, entries, trust);
      return { head: `${chatWho(n, trust)} proposed`, text: `${t.replace(TITLE_PREFIX, '')}${h}${was.length ? `\nreplaces ${was.join(', ')}` : ''}` };
    }
    case 'signoff': return { head: `${humanName(e, trust)} agreed to ${about()}`, text: '' };
    case 'objection':
      return n.via === 'human' && n.proposal_hash
        ? { head: `${humanName(e, trust)} objected to ${about()}`, text: noteOf(n) }
        : { head: chatWho(n, trust), text: t };
    case 'decision': return { head: 'room', text: decisionText(n, entries) };
    case 'task': {
      const status = n.status ? ` ${n.status}` : '';
      return { head: 'room', text: `task "${n.subject || n.task_id || '?'}"${status}${n.owner ? `, owner ${you(n.owner)}` : ''}` };
    }
    case 'task_req': return { head: chatWho(n, trust), text: `asks to ${n.op} task "${n.subject || n.task_id || '?'}"` };
    case 'say': case 'question': case 'status': case 'host_changed': case 'revoke': case 'concern': case 'agree': case 'plan_rev':
      return words(n, t, viewer, trust);
    default: return assertNever(k, 'entry kind');
  }
}

/**
 * One entry as group-chat lines, no ids: "bob: sure, once we've agreed", "bob's Claude: …", "bob joined",
 * "bob left". Only the first line starts at column 0 ("NAME: text"); every further line of the text, and
 * every wrapped piece, starts with NEST ("  │ "), so a post can never make a line that reads as a bare
 * "room: decided …", "bob agreed …", "alice: …" or "(for Claude) …" line. Lines are wrapped at CHAT_WRAP
 * code points (NEST included). At most CHAT_LINES_MAX text lines show, then "  │ [+N more lines: read({ids:[ID]})]".
 * A text longer than CHAT_MAX is cut with a visible "[cut: …]" and a "(for Claude) …" line naming the read
 * call for the rest. \r, other controls and bidi overrides never reach the output (safeText).
 * viewer: the reader's name ("to you", "owner you"); entries: the log so far (a proposal's title).
 */
function chatLines(e: Entry, { viewer, entries, trust = NO_TRUST }: { viewer?: string; entries?: readonly Readonly<Entry>[]; trust?: Trust } = {}): string[] {
  const { head, text } = chatBody(e, viewer, entries, trust);
  if (!text) return [head];
  const cps = Array.from(text);
  const cut = cps.length > CHAT_MAX;
  const shown = cut ? cps.slice(0, CHAT_MAX).join('') + ' [cut: the rest is in the room log]' : text;
  let lines = safeText(shown).split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim());
  if (!lines.length) return [head];
  const more = Math.max(0, lines.length - CHAT_LINES_MAX);
  if (more) lines = lines.slice(0, CHAT_LINES_MAX);
  lines[0] = `${head}: ${lines[0].replace(/^\s+/, '')}`;
  const nested = CHAT_WRAP - NEST.length;
  const out: string[] = [];
  lines.forEach((l, i) => wrap(l, i ? nested : CHAT_WRAP, nested).forEach((piece, j) => out.push(i || j ? NEST + piece : piece)));
  if (more) out.push(`${NEST}[+${more} more line${more === 1 ? '' : 's'}: read({ids:[${e.id}]})]`);
  if (cut) out.push(`${FOR_CLAUDE} that message is cut at ${CHAT_MAX}/${cps.length} chars; read({ids:[${e.id}]}) has all of it`);
  return out;
}

/** "waiting on dave · objected: carol" for an undecided proposal's consent matrix (lib/room/consent.ts), or '' when all agreed. */
function waiting(m: Matrix): string {
  return [m.missing.length && `waiting on ${m.missing.join(', ')}`, m.objected.length && `objected: ${m.objected.join(', ')}`]
    .filter(Boolean).join(' · ');
}

/** "room now: proposal 3fa2c1 waiting on bob · you: answer needed · away: bob", from the log as it is now. */
function stateLine(me: LaneViewer | null | undefined, entries: readonly Readonly<Entry>[] = [], { members = {}, ids = true, trust = NO_TRUST }: { members?: Members | null; ids?: boolean; trust?: Trust } = {}): string {
  const parts: string[] = [];
  const name = (me && me.name) as string; // no seat: in no proposal
  const all = proposals(entries, trust);
  const retired = fold(entries, trust).superseded; // a revision's earlier one is not open (lib/room/consent.ts)
  const open = all.filter(p => !decided(p.hash, entries, trust) && !retired.has(p.hash));
  const last = all.at(-1);
  const shown = open.length ? open.slice(-3) : last ? [last] : [];
  if (!shown.length) parts.push('no proposals');
  for (const p of shown) {
    const dec = decided(p.hash, entries, trust);
    const where = dec ? `decided${ids ? ` #${dec.id}` : ''}` : waiting(fold(entries, trust).matrix(p.hash)) || 'agreed by all';
    let s = `proposal ${p.hash.slice(0, 6)} ${where}`;
    if (approversOf(p).includes(name)) {
      const a = answered(name, p.hash, entries, trust);
      // the open-the-card call is spelled out right in the notice: a model skipped it when it was only in the join text
      const needed = `answer needed (call EnterPlanMode, then ExitPlanMode with plan "proposal ${p.hash}")`;
      s += ` · you: ${a ? (a.kind === 'signoff' ? 'agreed' : 'objected') : dec ? 'not answered' : needed}`;
    }
    parts.push(s);
  }
  if (open.length > shown.length) parts.push(`+${open.length - shown.length} more open`);
  const away = Object.values(members || {}).filter(m => m && (m.left_at || m.lapsed_at) && m.name !== name).map(m => m.name);
  if (away.length) parts.push(`away: ${away.join(', ')}`);
  return `room now: ${parts.join(' · ')}`;
}

/**
 * Full text for `sub-human read`: a "[#id …]" header line, then every line of the text nested under it (NEST),
 * so the text can't fake another entry's header.
 */
function fmt(e: Entry, { trust = NO_TRUST }: { trust?: Trust } = {}): string {
  const body = e.text == null ? `(${e.kind}, no notes)` : safeText(e.text).split('\n').map(l => NEST + l).join('\n');
  return `[${header(e, trust)} ${String(e.at || '').slice(11, 19)}]\n${body}`;
}

// ---------- the compaction digest ----------
/** The ordered digest sections; items carry an id so the cap can trim the oldest first. */
function digestSections(entries: readonly Readonly<Entry>[] = [], { members = {}, code = null, trust = NO_TRUST }: DigestCtx = {}): DigestSection[] {
  members = members || {};
  const memberLines = Object.values(members).map(m => {
    const last = entries.filter(e => e.from === m.name && e.via !== 'system').at(-1);
    return { text: `  ${m.name} (${m.role})${m.left_at ? ' LEFT' : ''} last post ${last ? `#${last.id} ${String(last.at).slice(11, 19)}` : '-'}` };
  });

  const planLines: DigestLine[] = [];
  const props = proposals(entries, trust);
  const retired = fold(entries, trust).superseded; // a revision's earlier one is not waiting on anyone (lib/room/consent.ts pending)
  const undecided = props.filter(p => !decided(p.hash, entries, trust) && !retired.has(p.hash));
  for (const p of undecided.length ? undecided : props.slice(-1)) {
    const m = answers(p.hash, approversOf(p), entries, trust);
    const dec = decided(p.hash, entries, trust);
    planLines.push({ text: `  proposal=${p.hash} (#${p.id} by ${who(p)}${p.path ? `, ${p.path}` : ''}) approvers: ${approversOf(p).join(' ') || '(none)'}${dec ? ` DECIDED #${dec.id}` : ''}` });
    for (const n of approversOf(p)) {
      const a = answered(n, p.hash, entries, trust);
      planLines.push({ text: `  ${m.signed[n] ? '✔' : a ? '✗' : '–'} ${n}${a ? ` #${a.id}` : ''}` });
    }
    if (!dec) {
      const f = fold(entries, trust).matrix(p.hash);
      planLines.push({ text: `  waiting on: ${f.missing.join(', ') || '(nobody)'}${f.objected.length ? ` · objected: ${f.objected.join(', ')}` : ''}` });
    }
  }
  if (!planLines.length) planLines.push({ text: '  (no proposals)' });

  const closedBy = new Set<number>();
  for (const e of entries) {
    if ((e.from === ROOM_CLAUDE || e.kind === 'decision') && e.refs) e.refs.forEach(r => closedBy.add(r));
  }
  const open = entries.map(normalize)
    .filter(e => (e.kind === 'objection' || e.kind === 'question') && !closedBy.has(e.id))
    .map(e => ({ id: e.id, text: `  #${e.id} ${who(e)} ${e.kind}${e.proposal_hash ? ` proposal=${e.proposal_hash}` : ''}: ${e.text == null ? '(no notes)' : quote(e, 120)}` }));
  const decisions = entries.map(normalize).filter(e => e.kind === 'decision')
    .map(e => ({ id: e.id, text: `  #${e.id} proposal=${e.proposal_hash || '-'}: ${quote(e, 120)}` }));
  const human = entries.filter(e => e.via === 'human').slice(-10)
    .map(e => ({ id: e.id, text: `  #${e.id} ${humanName(e, trust)}${e.drafted === 'agent' ? ` (${e.from}, Claude's wording)` : ''} ${e.kind}: ${e.text == null ? '(no notes)' : quote(e, TEXT_MAX, { exact: true })}` }));

  return [
    { title: `members of ${code || 'this room'}`, lines: memberLines },
    { title: 'open proposals and answers', lines: planLines },
    { title: 'open objections and questions', lines: open },
    { title: 'decisions', lines: decisions },
    { title: 'last 10 human entries', lines: human },
    { title: null, lines: [{ text: 'full text: the room MCP tool read({ids})' }] },
  ];
}

function renderSections(sections: DigestSection[], trimmed: number): string {
  const out = [`ROOM DIGEST (generated from the log; ${new Date().toISOString().slice(0, 19)}Z)`];
  for (const s of sections) {
    if (s.title) out.push(`## ${s.title}`);
    if (s.title && !s.lines.length) out.push('  (none)');
    for (const l of s.lines) out.push(l.text);
  }
  if (trimmed) out.push(`(${trimmed} older items trimmed to fit ${DIGEST_CAP} chars)`);
  return out.join('\n');
}

function digest(entries: readonly Readonly<Entry>[] = [], ctx: DigestCtx = {}): string {
  const sections = digestSections(entries, ctx);
  let trimmed = 0;
  let text = renderSections(sections, trimmed);
  while (text.length > DIGEST_CAP) {
    let oldest: { s: DigestSection; i: number } | null = null;
    for (const s of sections) {
      const i = s.lines.findIndex(l => l.id != null);
      if (i >= 0 && (!oldest || s.lines[i].id! < oldest.s.lines[oldest.i].id!)) oldest = { s, i }; // findIndex: id set
    }
    if (!oldest) { const tag = '\n[digest cut at the cap: sub-human digest]'; return text.slice(0, DIGEST_CAP - tag.length) + tag; }
    oldest.s.lines.splice(oldest.i, 1);
    trimmed++;
    text = renderSections(sections, trimmed);
  }
  return text;
}

// ---------- join and leave notices ----------
/** One join / leave notice (joinLeave). */
interface Notice {
  id: number;
  kind: string;
  name: string;
  at: string;
  settled: boolean;
  rejoin: boolean;
  /** a leave's reason as the chat line gives it (" (connection lost)"), else '' */
  why: string;
}
const settleMs = () => envMs('SUB_HUMAN_LEAVE_MS');
const isMove = (e: Entry | null | undefined) => !!e && e.via === 'system' && (e.kind === 'member_joined' || e.kind === 'member_left');

function joinLeave(es: readonly Readonly<Entry>[] | null | undefined, viewer: string | null | undefined, { now = clock.now(), settle = settleMs() } = {}): Notice[] {
  const list = (es || []).filter(e => isMove(e) && e.from !== viewer && e.from !== ROOM_CLAUDE);
  const drop = new Set<number>();
  const next = new Map<string, Entry>(); // name -> its next join, walking back
  for (let i = list.length - 1; i >= 0; i--) {
    const l = list[i];
    if (l.kind === 'member_joined') { next.set(l.from, l); continue; }
    const back = next.get(l.from);
    if (back && Date.parse(back.at) - Date.parse(l.at) < settle) { drop.add(l.id); drop.add(back.id); }
  }
  return list.filter(e => !drop.has(e.id)).map(e => ({
    id: e.id, kind: e.kind, name: e.from, at: e.at,
    settled: e.kind === 'member_joined' || now - Date.parse(e.at) >= settle,
    rejoin: e.kind === 'member_joined' && /\brejoined\b/.test(String(e.text || '')),
    why: e.kind === 'member_left' ? leftWhy(String(e.text || '')) : '',
  }));
}

function noticeText(n: Pick<Notice, 'kind' | 'name' | 'rejoin'> & { why?: string }): string {
  if (n.kind === 'member_left') return `${n.name} left${n.why || ''}`;
  return `${n.name} ${n.rejoin ? 'rejoined' : 'joined'}`;
}

function rowSegment(es: readonly Readonly<Entry>[] | null | undefined, viewer: string | null | undefined, { now = clock.now() } = {}): string {
  const settle = settleMs();
  const fresh = (x: Notice) => now - Date.parse(x.at) - (x.kind === 'member_left' ? settle : 0) < ROW_NOTICE_MS;
  // only the log's last ROW_NOTICE_MS + settle can hold a fresh notice, or the rejoin that cancels one: the log is in
  // time order, so read back to there
  const list = es || [];
  let from = list.length;
  while (from > 0 && !(now - Date.parse(list[from - 1].at) > ROW_NOTICE_MS + 2 * settle)) from--;
  const n = joinLeave(list.slice(from), viewer, { now, settle }).filter(x => x.settled && fresh(x)).at(-1);
  if (!n) return '';
  return n.kind === 'member_left' ? `−${n.name} left${n.why}` : `+${n.name} ${n.rejoin ? 'rejoined' : 'joined'}`;
}

export { FOR_CLAUDE, line, chatLines, fmt, who, stateLine, digest, leftWhy, joinLeave, noticeText, rowSegment };
export type { Notice };
