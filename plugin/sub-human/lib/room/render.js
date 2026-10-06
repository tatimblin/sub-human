'use strict';
/**
 * plugin/sub-human/lib/room/render.js: log entries as text, for Claude (ids kept) and for people (no ids).
 *
 *   line(e, {full, entries}) one notice line. full: the exact text (JSON-quoted) up to TEXT_MAX = 2,000 code
 *     points, then `[cut at 2000/N: sub-human read ID]`; without full, <= TAIL_MAX (240) chars with the same
 *     marker when cut. Never a bare "…". With {entries}, a retracted entry renders as its header +
 *     "[retracted by #N]". A drafted:"agent" entry's header carries "(NAME, Claude's wording)".
 *     tailLine(e) = line(e).
 *   chatLines(e, {viewer}) -> [string]   one entry as group-chat lines, no ids (below)
 *   fmt(e, {entries}?)       full text for read(); who(e) ("alice" | "alice's Claude" | "room")
 *   stateLine(me, entries?) -> "room now: proposal 3fa2c1 waiting on bob · you: answer needed · away: carol"
 *   digest(entries?)         <= DIGEST_CAP chars: members, open proposals + approvers + answers, open
 *     objections/questions, decisions, last 10 human entries in full by the line() rule; retracted entries
 *     left out.
 *   FOR_CLAUDE               "(for Claude)": the prefix of chat lines meant only for the model
 */

const { code, readAll, normalize, readMembersHere } = require('./store.js');
const { proposals, answers, answered, decided, approversOf, retractedIds } = require('./lanes.js');
const { oneLine } = require('../text.js');
const { TAIL_MAX, TEXT_MAX, CHAT_WRAP, CHAT_MAX, DIGEST_CAP } = require('../config.js');

const FOR_CLAUDE = '(for Claude)';

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
  if (cps.length <= n) return JSON.stringify(t);
  return `${JSON.stringify(cps.slice(0, n).join(''))} [cut at ${n}/${cps.length}: sub-human read ${e.id}]`;
}

function header(e) {
  const n = normalize(e);
  const parts = [`#${n.id}`, `${n.from}${n.via ? `[${n.via}]` : ''}`];
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
function line(e, { full = false, entries } = {}) {
  if (entries) {
    const by = entries.find(x => x.kind === 'retract' && x.via === 'system' && (x.refs || []).includes(e.id));
    if (by) return `${header(e).slice(0, TAIL_MAX - 40)} [retracted by #${by.id}]`;
  }
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
  return e.drafted === 'agent' ? `${e.from} (Claude's wording)` : e.from;
}

/** Split one text line into pieces of at most n code points, at a space when there is one. */
function wrap(lineText, n = CHAT_WRAP) {
  const out = [];
  let cps = Array.from(lineText);
  while (cps.length > n) {
    let cut = cps.lastIndexOf(' ', n);
    if (cut < n / 2) cut = n;
    out.push(cps.slice(0, cut).join('').trimEnd());
    cps = cps.slice(cut);
    while (cps[0] === ' ') cps.shift();
  }
  out.push(cps.join(''));
  return out;
}

/** The human-facing sentence for an entry (may span lines). */
function chatBody(e, viewer) {
  const n = normalize(e);
  const t = String(n.text ?? '');
  const you = x => (x && x === viewer ? 'you' : x);
  switch (n.kind) {
    case 'member_joined': return { head: `${n.from} ${/\brejoined\b/.test(t) ? 'rejoined' : 'joined'}`, text: '' };
    case 'member_left': return { head: `${n.from} left`, text: '' };
    case 'proposal': return { head: `${chatWho(n)} proposed`, text: t.replace(/^proposal [0-9a-f]{6,64}:\s*/, '') };
    case 'signoff': return { head: `${n.from} agreed to the proposal`, text: '' };
    case 'objection':
      return n.via === 'human' && n.proposal_hash
        ? { head: `${n.from} objected to the proposal`, text: n.text == null || /^Object$/.test(t) ? '' : t }
        : { head: chatWho(n), text: t };
    case 'decision': {
      const s = t.replace(/\s*\(proposal [0-9a-f]+\)\s*$/, '');
      return { head: 'room', text: /^objected:/.test(s) ? `not agreed (${s})` : `decided (${s})` };
    }
    case 'task': {
      const status = n.status ? ` ${n.status}` : '';
      return { head: 'room', text: `task "${n.subject || n.task_id || '?'}"${status}${n.owner ? `, owner ${you(n.owner)}` : ''}` };
    }
    case 'task_req': return { head: chatWho(n), text: `asks to ${n.op} task "${n.subject || n.task_id || '?'}"` };
    case 'retract': return { head: 'room', text: `a message shown as ${n.from}'s was removed: it came from another Claude session, not from ${n.from}` };
    default: {
      const to = n.to && n.to !== 'room' ? ` (to ${you(n.to)})` : '';
      return { head: `${chatWho(n)}${to}`, text: t };
    }
  }
}

/**
 * One entry as group-chat lines, no ids: "bob: sure, once we've agreed", "bob's Claude: …", "bob joined",
 * "bob left". Multi-line text keeps its lines (each wrapped at CHAT_WRAP code points); a text longer than
 * CHAT_MAX is cut with a visible "[cut: …]" and a "(for Claude) …" line naming the read call for the rest.
 * A text line that itself starts with "(for Claude)" is prefixed with "> ", so a post can't pass as one.
 * viewer: the reader's name ("to you", "owner you").
 */
function chatLines(e, { viewer } = {}) {
  const { head, text } = chatBody(e, viewer);
  if (!text) return [head];
  const cps = Array.from(text);
  const cut = cps.length > CHAT_MAX;
  const shown = cut ? cps.slice(0, CHAT_MAX).join('') + ' [cut: the rest is in the room log]' : text;
  const lines = shown.split(/\r?\n/).map(l => l.replace(/\s+$/, '')).filter(l => l.trim());
  if (!lines.length) return [head];
  lines[0] = `${head}: ${lines[0].replace(/^\s+/, '')}`;
  const out = lines.flatMap((l, i) => wrap(i && l.trimStart().startsWith(FOR_CLAUDE) ? `> ${l.trimStart()}` : l));
  if (cut) out.push(`${FOR_CLAUDE} that message is cut at ${CHAT_MAX}/${cps.length} chars; read({ids:[${e.id}]}) has all of it`);
  return out;
}

/** "room now: proposal 3fa2c1 waiting on bob · you: answer needed · away: bob", from the log as it is now. */
function stateLine(me, entries = readAll()) {
  const parts = [];
  const name = me && me.name;
  const all = proposals(entries);
  const open = all.filter(p => !decided(p.hash, entries));
  const last = all.at(-1);
  const shown = open.length ? open.slice(-3) : last ? [last] : [];
  if (!shown.length) parts.push('no proposals');
  for (const p of shown) {
    const dec = decided(p.hash, entries);
    const m = answers(p.hash, approversOf(p), entries);
    let s = `proposal ${p.hash.slice(0, 6)} ${dec ? `decided #${dec.id}` : m.missing.length ? `waiting on ${m.missing.join(', ')}` : 'agreed by all'}`;
    if (approversOf(p).includes(name)) {
      const a = answered(name, p.hash, entries);
      // the open-the-card call is spelled out right in the notice: a model skipped it when it was only in the join text
      s += ` · you: ${a ? (a.kind === 'signoff' ? 'agreed' : 'objected') : dec ? 'not answered' : `answer needed (call EnterPlanMode, then ExitPlanMode with plan "proposal ${p.hash}")`}`;
    }
    parts.push(s);
  }
  if (open.length > shown.length) parts.push(`+${open.length - shown.length} more open`);
  const away = Object.values(readMembersHere()).filter(m => m && m.left_at && m.name !== name).map(m => m.name);
  if (away.length) parts.push(`away: ${away.join(', ')}`);
  return `room now: ${parts.join(' · ')}`;
}

/** Full text for read(). With `entries`, a retracted entry says so (its text stays, for the record). */
function fmt(e, { entries } = {}) {
  const by = entries && entries.find(x => x.kind === 'retract' && x.via === 'system' && (x.refs || []).includes(e.id));
  return `[${header(e)} ${String(e.at || '').slice(11, 19)}]${by ? ` [retracted by #${by.id}: ${oneLine(by.text)}]` : ''}\n${e.text ?? `(${e.kind}, no notes)`}`;
}

// ---------- the compaction digest ----------
/** The ordered digest sections; items carry an id so the cap can trim the oldest first. */
function digestSections(entries = readAll()) {
  const gone = retractedIds(entries);
  entries = entries.filter(e => !gone.has(e.id));
  const members = readMembersHere();
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
    if (!dec) planLines.push({ text: `  waiting on: ${m.missing.join(', ') || '(nobody)'}` });
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
    .map(e => ({ id: e.id, text: `  #${e.id} ${e.from}${e.drafted === 'agent' ? ` (${e.from}, Claude's wording)` : ''} ${e.kind}: ${e.text == null ? '(no notes)' : quote(e, TEXT_MAX, { exact: true })}` }));

  return [
    { title: `members of ${code() || 'this room'}`, lines: memberLines },
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

function digest(entries = readAll()) {
  const sections = digestSections(entries);
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
