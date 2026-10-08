'use strict';
/**
 * plugin/sub-human/lib/room/render.js: log entries as text, for Claude (ids kept) and for people (no ids).
 *
 *   line(e, {full}) one notice line. full: the exact text (JSON-quoted) up to TEXT_MAX = 2,000 code
 *     points, then `[cut at 2000/N: sub-human read ID]`; without full, <= TAIL_MAX (240) chars with the same
 *     marker when cut. Never a bare "…". A drafted:"agent" entry's header carries "(NAME, Claude's wording)".
 *     tailLine(e) = line(e).
 *   chatLines(e, {viewer, entries?}) -> [string]   one entry as group-chat lines, no ids; continuation lines nested
 *     under the sender with CHAT_NEST ("  │ "), at most CHAT_LINES_MAX text lines (below). With entries (the log
 *     so far) an answer or decision names its proposal by title: 'bob agreed to "Ship v3 Monday"', 'room: "Ship v3
 *     Monday" agreed (bob)', 'room: "Ship v3 Monday" not agreed: changes requested by bob: keep status'
 *   fmt(e)                   full text for `sub-human read`, body lines nested the same way;
 *     who(e) ("alice" | "alice's Claude" | "room")
 *   stateLine(me, entries, {members, ids}) -> "room now: proposal 3fa2c1 waiting on bob · objected: dave · you: answer needed ·
 *     away: carol"  (waiting on = no answer yet, objected = current answer is an objection; lib/room/consent.js fold;
 *     ids:false drops the decision's "#N", for a member's wake, which the person sees too)
 *   digest(entries, {members, code}) <= DIGEST_CAP chars: members, open proposals + approvers + answers, open
 *     objections/questions, decisions, last 10 human entries in full by the line() rule.
 *   FOR_CLAUDE               "(for Claude)": the prefix of chat lines meant only for the model
 *   UNVERIFIED               "(unverified)": after the name of a via=human entry whose sig does not verify
 *     (store.unverifiedHuman: a legacy line, or one written around append). It stays readable, never as the
 *     person's own words; the consent fold ignores it.
 */

const { normalize, unverifiedHuman } = require('./store.js');
const { proposals, answers, answered, decided, approversOf } = require('./lanes.js');
const { oneLine } = require('../text.js');
const { fold } = require('./consent.js');
const { TAIL_MAX, TEXT_MAX, CHAT_WRAP, CHAT_MAX, DIGEST_CAP, CHAT_LINES_MAX, CHAT_NEST } = require('../config.js');

const FOR_CLAUDE = '(for Claude)';
const UNVERIFIED = '(unverified)';
const NEST = CHAT_NEST; // "  │ ": every continuation line of a message, so none can pass as a line of its own

/**
 * Characters that would let one line of text pass as another on a terminal or in a model's view: line
 * breaks other than \n (\r returns the cursor and overwrites the sender), other C0 / C1 controls (escape
 * sequences), and bidi overrides. Shown as U+FFFD; the log keeps the exact text.
 */
const BREAKS = /\r\n|[\r\v\f\u0085\u2028\u2029]/g;
const UNSAFE = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const safeText = t => String(t).replace(BREAKS, '\n').replace(UNSAFE, '\ufffd');

const who = e => {
  if (e.via === 'system') return 'room';
  return e.via === 'agent' && e.from !== 'orch' ? `${e.from}'s Claude` : e.from;
};

/**
 * An entry's text, JSON-quoted (so always one line), at most n code points. Longer text never ends in a bare
 * "…": the quote closes and an explicit marker names the call that fetches the rest. exact keeps whitespace.
 */
function quote(e, n, { exact = false } = {}) {
  const raw = String(e.text ?? '');
  const t = exact ? raw : oneLine(raw);
  const cps = Array.from(t);
  const js = x => JSON.stringify(x).replace(/[\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16)}`);
  if (cps.length <= n) return js(t);
  return `${js(cps.slice(0, n).join(''))} [cut at ${n}/${cps.length}: sub-human read ${e.id}]`;
}

function header(e) {
  const n = normalize(e);
  const parts = [`#${n.id}`, `${n.from}${n.via ? `[${n.via}]` : ''}`];
  if (unverifiedHuman(e)) parts.push(UNVERIFIED);
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
 * `[cut at 2000/N: sub-human read ID]`. Otherwise a compact line of at most TAIL_MAX chars (whitespace
 * collapsed), with the same explicit marker when the text is cut.
 */
function line(e, { full = false } = {}) {
  if (e.text == null) return full ? header(e) : header(e).slice(0, TAIL_MAX);
  if (full) return `${header(e)} ${quote(e, TEXT_MAX, { exact: true })}`;
  const head = header(e).slice(0, TAIL_MAX - 3);
  let n = 200;
  for (;;) {
    const l = `${head} ${quote(e, n)}`;
    if (l.length <= TAIL_MAX) return l;
    if (n === 0) return l.slice(0, TAIL_MAX);
    n = Math.max(0, n - Math.max(1, l.length - TAIL_MAX));
  }
}
const tailLine = e => line(e);

// ---------- chat rendering (what a human sees; no ids) ----------
/** Who an entry is from, as a group chat names them: "bob", "bob's Claude", "orch", "room". */
function chatWho(e) {
  if (e.via === 'system') return 'room';
  if (e.from === 'orch') return 'orch';
  if (e.via === 'agent') return `${e.from}'s Claude`;
  if (unverifiedHuman(e)) return `${e.from} ${UNVERIFIED}`;
  return e.drafted === 'agent' ? `${e.from} (Claude's wording)` : e.from;
}

/** The person's name for a via=human line, with the unverified marker when its sig does not verify. */
const humanName = e => (unverifiedHuman(e) ? `${e.from} ${UNVERIFIED}` : e.from);

/** Split one text line into pieces of at most n code points (rest: the later pieces), at a space when there is one. */
function wrap(lineText, n = CHAT_WRAP, rest = n) {
  const out = [];
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
/**
 * The proposal hash names, as people see it: its title in quotes, from the proposal entry in entries ("proposal
 * HASH: TITLE"), one safe line of at most TITLE_LABEL_MAX code points; null without entries or that entry.
 */
function proposalLabel(hash, entries) {
  if (!hash || !Array.isArray(entries)) return null;
  const p = entries.find(x => x && x.kind === 'proposal' && x.hash === hash);
  const t = p && oneLine(safeText(String(p.text ?? '').replace(/^proposal [0-9a-f]{6,64}:\s*/, ''))).replace(/\n/g, ' ').trim();
  if (!t) return null;
  const cps = Array.from(t);
  return `"${cps.length > TITLE_LABEL_MAX ? `${cps.slice(0, TITLE_LABEL_MAX - 1).join('').trimEnd()}…` : t}"`;
}

/** An objection's note, or '' for none (a bare "Object" answer). */
const noteOf = o => (o.text == null || /^Object$/.test(String(o.text)) ? '' : String(o.text));

/**
 * A decision as people read it: '"Ship v3 Monday" agreed (bob)', or '"Ship v3 Monday" not agreed: changes
 * requested by bob: keep status · agreed: alice' (each objector's note from the answers the decision refs). Without
 * the proposal in entries: 'decided (agreed: bob)' / 'not agreed (objected: bob)'.
 */
function decisionText(n, entries) {
  const label = proposalLabel(n.proposal_hash, entries);
  const s = String(n.text ?? '').replace(/\s*\(proposal [0-9a-f]+\)\s*$/, '');
  const m = /^objected: ([^·]*?)(?: · agreed: (.*))?$/.exec(s);
  if (!label) return m ? `not agreed (${s})` : `decided (${s})`; // no title to name it by
  if (!m) return /^agreed: /.test(s) ? `${label} agreed (${s.slice(8)})` : `${label} decided (${s})`;
  const refs = new Set(n.refs || []);
  const objs = entries.filter(x => x && refs.has(x.id) && x.kind === 'objection');
  const by = m[1].split(/,\s*/).filter(Boolean).map(name => {
    const o = objs.find(x => x.from === name);
    const note = o ? oneLine(safeText(noteOf(o))) : '';
    return note ? `${name}: ${note}` : name;
  });
  return `${label} not agreed: changes requested by ${by.join(' · ')}${m[2] ? ` · agreed: ${m[2]}` : ''}`;
}

/** The human-facing sentence for an entry (may span lines). entries: the log so far, to name a proposal by title. */
function chatBody(e, viewer, entries) {
  const n = normalize(e);
  const t = String(n.text ?? '');
  const you = x => (x && x === viewer ? 'you' : x);
  const about = () => proposalLabel(n.proposal_hash, entries) || 'the proposal';
  switch (n.kind) {
    case 'member_joined': return { head: `${n.from} ${/\brejoined\b/.test(t) ? 'rejoined' : 'joined'}`, text: '' };
    case 'member_left': return { head: `${n.from} left`, text: '' };
    case 'proposal': return { head: `${chatWho(n)} proposed`, text: t.replace(/^proposal [0-9a-f]{6,64}:\s*/, '') };
    case 'signoff': return { head: `${humanName(e)} agreed to ${about()}`, text: '' };
    case 'objection':
      return n.via === 'human' && n.proposal_hash
        ? { head: `${humanName(e)} objected to ${about()}`, text: noteOf(n) }
        : { head: chatWho(n), text: t };
    case 'decision': return { head: 'room', text: decisionText(n, entries) };
    case 'task': {
      const status = n.status ? ` ${n.status}` : '';
      return { head: 'room', text: `task "${n.subject || n.task_id || '?'}"${status}${n.owner ? `, owner ${you(n.owner)}` : ''}` };
    }
    case 'task_req': return { head: chatWho(n), text: `asks to ${n.op} task "${n.subject || n.task_id || '?'}"` };
    default: {
      const to = n.to && n.to !== 'room' ? ` (to ${you(n.to)})` : '';
      return { head: `${chatWho(n)}${to}`, text: t };
    }
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
function chatLines(e, { viewer, entries } = {}) {
  const { head, text } = chatBody(e, viewer, entries);
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
  const out = [];
  lines.forEach((l, i) => wrap(l, i ? nested : CHAT_WRAP, nested).forEach((piece, j) => out.push(i || j ? NEST + piece : piece)));
  if (more) out.push(`${NEST}[+${more} more line${more === 1 ? '' : 's'}: read({ids:[${e.id}]})]`);
  if (cut) out.push(`${FOR_CLAUDE} that message is cut at ${CHAT_MAX}/${cps.length} chars; read({ids:[${e.id}]}) has all of it`);
  return out;
}

/** "waiting on dave · objected: carol" for an undecided proposal's consent matrix (lib/room/consent.js), or '' when all agreed. */
function waiting(m) {
  return [m.missing.length && `waiting on ${m.missing.join(', ')}`, m.objected.length && `objected: ${m.objected.join(', ')}`]
    .filter(Boolean).join(' · ');
}

/** "room now: proposal 3fa2c1 waiting on bob · you: answer needed · away: bob", from the log as it is now. */
function stateLine(me, entries = [], { members = {}, ids = true } = {}) {
  const parts = [];
  const name = me && me.name;
  const all = proposals(entries);
  const open = all.filter(p => !decided(p.hash, entries));
  const last = all.at(-1);
  const shown = open.length ? open.slice(-3) : last ? [last] : [];
  if (!shown.length) parts.push('no proposals');
  for (const p of shown) {
    const dec = decided(p.hash, entries);
    const where = dec ? `decided${ids ? ` #${dec.id}` : ''}` : waiting(fold(entries).matrix(p.hash)) || 'agreed by all';
    let s = `proposal ${p.hash.slice(0, 6)} ${where}`;
    if (approversOf(p).includes(name)) {
      const a = answered(name, p.hash, entries);
      // the open-the-card call is spelled out right in the notice: a model skipped it when it was only in the join text
      const needed = `answer needed (call EnterPlanMode, then ExitPlanMode with plan "proposal ${p.hash}")`;
      s += ` · you: ${a ? (a.kind === 'signoff' ? 'agreed' : 'objected') : dec ? 'not answered' : needed}`;
    }
    parts.push(s);
  }
  if (open.length > shown.length) parts.push(`+${open.length - shown.length} more open`);
  const away = Object.values(members || {}).filter(m => m && m.left_at && m.name !== name).map(m => m.name);
  if (away.length) parts.push(`away: ${away.join(', ')}`);
  return `room now: ${parts.join(' · ')}`;
}

/**
 * Full text for `sub-human read`: a "[#id …]" header line, then every line of the text nested under it (NEST),
 * so the text can't fake another entry's header.
 */
function fmt(e) {
  const body = e.text == null ? `(${e.kind}, no notes)` : safeText(e.text).split('\n').map(l => NEST + l).join('\n');
  return `[${header(e)} ${String(e.at || '').slice(11, 19)}]\n${body}`;
}

// ---------- the compaction digest ----------
/** The ordered digest sections; items carry an id so the cap can trim the oldest first. */
function digestSections(entries = [], { members = {}, code = null } = {}) {
  members = members || {};
  const memberLines = Object.values(members).map(m => {
    const last = entries.filter(e => e.from === m.name && e.via !== 'system').at(-1);
    return { text: `  ${m.name} (${m.role})${m.left_at ? ' LEFT' : ''} last post ${last ? `#${last.id} ${String(last.at).slice(11, 19)}` : '-'}` };
  });

  const planLines = [];
  const props = proposals(entries);
  const undecided = props.filter(p => !decided(p.hash, entries));
  for (const p of undecided.length ? undecided : props.slice(-1)) {
    const m = answers(p.hash, approversOf(p), entries);
    const dec = decided(p.hash, entries);
    planLines.push({ text: `  proposal=${p.hash} (#${p.id} by ${who(p)}${p.path ? `, ${p.path}` : ''}) approvers: ${approversOf(p).join(' ') || '(none)'}${dec ? ` DECIDED #${dec.id}` : ''}` });
    for (const n of approversOf(p)) {
      const a = answered(n, p.hash, entries);
      planLines.push({ text: `  ${m.signed[n] ? '✔' : a ? '✗' : '–'} ${n}${a ? ` #${a.id}` : ''}` });
    }
    if (!dec) {
      const f = fold(entries).matrix(p.hash);
      planLines.push({ text: `  waiting on: ${f.missing.join(', ') || '(nobody)'}${f.objected.length ? ` · objected: ${f.objected.join(', ')}` : ''}` });
    }
  }
  if (!planLines.length) planLines.push({ text: '  (no proposals)' });

  const closedBy = new Set();
  for (const e of entries) {
    if ((e.from === 'orch' || e.kind === 'decision') && e.refs) e.refs.forEach(r => closedBy.add(r));
  }
  const open = entries.map(normalize)
    .filter(e => (e.kind === 'objection' || e.kind === 'question') && !closedBy.has(e.id))
    .map(e => ({ id: e.id, text: `  #${e.id} ${who(e)} ${e.kind}${e.proposal_hash ? ` proposal=${e.proposal_hash}` : ''}: ${e.text == null ? '(no notes)' : quote(e, 120)}` }));
  const decisions = entries.map(normalize).filter(e => e.kind === 'decision')
    .map(e => ({ id: e.id, text: `  #${e.id} proposal=${e.proposal_hash || '-'}: ${quote(e, 120)}` }));
  const human = entries.filter(e => e.via === 'human').slice(-10)
    .map(e => ({ id: e.id, text: `  #${e.id} ${humanName(e)}${e.drafted === 'agent' ? ` (${e.from}, Claude's wording)` : ''} ${e.kind}: ${e.text == null ? '(no notes)' : quote(e, TEXT_MAX, { exact: true })}` }));

  return [
    { title: `members of ${code || 'this room'}`, lines: memberLines },
    { title: 'open proposals and answers', lines: planLines },
    { title: 'open objections and questions', lines: open },
    { title: 'decisions', lines: decisions },
    { title: 'last 10 human entries', lines: human },
    { title: null, lines: [{ text: 'full text: the room MCP tool read({ids}), or `sub-human read --id N`' }] },
  ];
}

function renderSections(sections, trimmed) {
  const out = [`ROOM DIGEST (generated from the log; ${new Date().toISOString().slice(0, 19)}Z)`];
  for (const s of sections) {
    if (s.title) out.push(`## ${s.title}`);
    if (s.title && !s.lines.length) out.push('  (none)');
    for (const l of s.lines) out.push(l.text);
  }
  if (trimmed) out.push(`(${trimmed} older items trimmed to fit ${DIGEST_CAP} chars)`);
  return out.join('\n');
}

function digest(entries = [], ctx = {}) {
  const sections = digestSections(entries, ctx);
  let trimmed = 0;
  let text = renderSections(sections, trimmed);
  while (text.length > DIGEST_CAP) {
    let oldest = null;
    for (const s of sections) {
      const i = s.lines.findIndex(l => l.id != null);
      if (i >= 0 && (!oldest || s.lines[i].id < oldest.s.lines[oldest.i].id)) oldest = { s, i };
    }
    if (!oldest) { const tag = '\n[digest cut at the cap: sub-human digest]'; return text.slice(0, DIGEST_CAP - tag.length) + tag; }
    oldest.s.lines.splice(oldest.i, 1);
    trimmed++;
    text = renderSections(sections, trimmed);
  }
  return text;
}

module.exports = {
  FOR_CLAUDE,
  line, tailLine, chatLines, fmt, who, stateLine, digest,
};
