'use strict';
/**
 * plugin/sub-human/lib/room.js: the room log (envelope v3), ported from demo/lib/room.js.
 * CommonJS, zero dependencies, Node 24. Every writer (hooks, the MCP server) goes through append().
 * `from` is passed in by trusted callers that resolved identity first (lib/identity.js); it is never
 * taken from env or from the model.
 *
 * Binding (which room the calls below act on):
 *   bind(code)            set the active room (<home>/rooms/<code>); returns code
 *   ROOM_DIR              env override of the directory, for tests; wins over bind()
 *   code() -> string|null the bound code (or the basename of ROOM_DIR)
 *   dir(), logPath(), plansDir()   <roomDir>, <roomDir>/log.jsonl, <roomDir>/plans
 *
 * Reading:
 *   readAll() -> Entry[]                     every parseable line, in order (legacy lines included)
 *   readById(ids) -> Entry[]                 in the order asked
 *   readAfter(seq, filterFn?) -> Entry[]
 *   lastId() -> int
 *   follow(afterSeq, onEntry, {intervalMs}) -> stop()   polls the log file bound at call time
 *   normalize(entry)                         legacy display mapping (concern -> objection, agree -> signoff)
 *   getCursor(name), setCursor(name, n)      <roomDir>/<name>.cursor, written atomically
 *
 * Writing:
 *   append(entry, {via, from, system}) -> Entry
 *     entry = {kind, text, to?, refs?, plan_hash?, approvers?, normalized?, edit_path?}
 *     via "agent":  say proposal question objection status   (rate limit: 6 per `from` per 60 s, RoomError RATE)
 *     via "human":  say signoff objection                      (signoff and objection need plan_hash)
 *     via "system": plan_rev decision member_joined member_left retract status, and only with {system:true}
 *                   (via defaults to "system" when system:true). plan_rev and decision need plan_hash.
 *     Assigns id (monotonic, under a lockfile), at, from, via, prev (hash12 of the previous line).
 *     Throws RoomError with code INVALID | RATE | LOCK | NO_ROOM.
 *
 * Plan and decisions:
 *   currentPlan() -> {id, hash, approvers}|null      the latest plan_rev
 *   planRev(hash) -> Entry|null                      the latest plan_rev with that hash
 *   revNumber(hash) -> int|null                      1-based position of hash among the distinct plan hashes
 *   signoffMatrix(hash, approvers?) -> {hash, signed: {name: id|null}, missing, complete}
 *       approvers default to that plan_rev's. Per approver, the latest via=human signoff or objection
 *       carrying plan_hash === hash wins: an objection voids an earlier signoff.
 *   decided(hash) -> Entry|null                      the decision entry for that hash
 *
 * Lanes:
 *   lane(me, e, entries?) -> 'push' | 'pull' | 'none'   who a notice concerns (rules at lane() below)
 *   stateLine(me, entries?) -> "room now: plan 3fa2c1 waiting on bob · you: signed · away: carol"
 *   retractedIds(entries?) -> Set, mentions(text, name) -> bool ("@name")
 *
 * Rendering:
 *   line(e, {full}) one notice line. full: the exact text (JSON-quoted) up to TEXT_MAX = 2,000 code points,
 *     then `[cut at 2000/N: sub-human read ID]`; without full, <= 240 chars with the same marker when cut.
 *     Never a bare "…". With {entries}, a retracted entry renders as its header + "[retracted by #N]".
 *     A drafted:"agent" entry's header carries "(NAME, Claude's wording)". tailLine(e) = line(e).
 *   fmt(e, {entries}?), who(e) ("alice" | "alice's Claude" | "room"),
 *   digest() (<= 9,500 chars: members, plan + approvers + matrix, open objections/questions, decisions,
 *   last 10 human entries in full by the line() rule; retracted entries left out), validateChain() -> {ok, badAt?}
 * Constants: KINDS, AGENT_KINDS, HUMAN_KINDS, SYSTEM_KINDS, VIAS, DIGEST_CAP, TAIL_MAX, TEXT_MAX, NAME_RE,
 *   RATE_MAX, RATE_WINDOW_MS. Error class: RoomError.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const identity = require('./identity.js');

const AGENT_KINDS = ['say', 'proposal', 'question', 'objection', 'status'];
const HUMAN_KINDS = ['say', 'signoff', 'objection'];
const SYSTEM_ONLY_KINDS = ['plan_rev', 'decision', 'member_joined', 'member_left', 'retract'];
const SYSTEM_KINDS = [...SYSTEM_ONLY_KINDS, 'status'];
const KINDS = [...new Set([...AGENT_KINDS, ...HUMAN_KINDS, ...SYSTEM_KINDS])];
const KINDS_BY_VIA = { agent: AGENT_KINDS, human: HUMAN_KINDS, system: SYSTEM_KINDS };
const VIAS = ['human', 'agent', 'system'];
const DIGEST_CAP = 9500;
const TAIL_MAX = 240;
const TEXT_MAX = 2000;
const RATE_MAX = 6;
const RATE_WINDOW_MS = 60_000;
const NAME_RE = identity.NAME_RE;
const HASH_RE = /^[0-9a-f]{12}$/;
const ENTRY_FIELDS = new Set(['kind', 'text', 'to', 'refs', 'plan_hash', 'approvers', 'normalized', 'edit_path', 'drafted']);

class RoomError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ---------- binding / paths ----------
let active = null;
function bind(c) {
  identity.roomDir(c); // validates the code
  active = c;
  return c;
}
const code = () => (process.env.ROOM_DIR ? path.basename(process.env.ROOM_DIR) : active);
function dir() {
  if (process.env.ROOM_DIR) return process.env.ROOM_DIR;
  if (!active) throw new RoomError('NO_ROOM', 'no room bound; run /sub-human');
  return identity.roomDir(active);
}
const logPath = () => path.join(dir(), 'log.jsonl');
const plansDir = () => path.join(dir(), 'plans');

const hash12 = data => crypto.createHash('sha256').update(data).digest('hex').slice(0, 12);

// ---------- reading ----------
function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn or corrupt line: skip */ }
  }
  return out;
}

function readAll() {
  try { return parseLines(fs.readFileSync(logPath(), 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

function readById(ids) {
  const want = (Array.isArray(ids) ? ids : [ids]).map(Number);
  const byId = new Map(readAll().map(e => [e.id, e]));
  return want.filter(i => byId.has(i)).map(i => byId.get(i));
}

const readAfter = (seq, filterFn = () => true) => readAll().filter(e => e.id > seq && filterFn(e));
const lastId = () => { const a = readAll(); return a.length ? a[a.length - 1].id : 0; };

/** Poll the log for entries with id > afterSeq. Handles torn reads and a reset (truncated) log. */
function follow(afterSeq, onEntry, { intervalMs = 250 } = {}) {
  const file = logPath();
  let offset = 0, seen = afterSeq, buf = '';
  const tick = () => {
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch { return; }
    try {
      const size = fs.fstatSync(fd).size;
      if (size < offset) { offset = 0; buf = ''; seen = 0; }
      if (size === offset) return;
      const chunk = Buffer.alloc(size - offset);
      fs.readSync(fd, chunk, 0, chunk.length, offset);
      offset = size;
      buf += chunk.toString('utf8');
      const cut = buf.lastIndexOf('\n');
      if (cut < 0) return;
      const complete = buf.slice(0, cut);
      buf = buf.slice(cut + 1);
      for (const e of parseLines(complete)) {
        if (e.id > seen) { seen = e.id; onEntry(e); }
      }
    } finally { fs.closeSync(fd); }
  };
  tick();
  const t = setInterval(tick, intervalMs);
  return () => clearInterval(t);
}

/** Legacy entries (spike 1/2 logs) mapped for display and for the matrix. */
function normalize(e) {
  const n = { ...e };
  if (n.kind === 'concern') n.kind = 'objection';
  if (n.kind === 'agree' && n.plan_hash) n.kind = 'signoff';
  if (n.to == null) n.to = 'room';
  return n;
}

// ---------- writing ----------
const bad = msg => { throw new RoomError('INVALID', msg); };

function validate(entry, opts) {
  if (!entry || typeof entry !== 'object') bad('entry must be an object');
  for (const k of Object.keys(entry)) {
    if (!ENTRY_FIELDS.has(k)) bad(`field "${k}" is not settable by callers`);
  }
  const via = opts.via || (opts.system === true ? 'system' : undefined);
  const { kind, text, to = 'room', refs, plan_hash, approvers, normalized, edit_path, drafted } = entry;
  if (typeof opts.from !== 'string' || !NAME_RE.test(opts.from)) bad(`invalid from "${opts.from}"`);
  if (!VIAS.includes(via)) bad(`via must be one of ${VIAS.join(', ')}`);
  if (!KINDS.includes(kind)) bad(`unknown kind "${kind}". Use one of: ${KINDS_BY_VIA[via].join(', ')}`);
  if (via === 'system' && opts.system !== true) bad('via "system" is written only by the plugin\'s hooks');
  if (SYSTEM_ONLY_KINDS.includes(kind)) {
    if (opts.system !== true) bad(`${kind} is written only by the plugin's hooks`);
    if (via !== 'system') bad(`${kind} must be via "system"`);
  } else if (!KINDS_BY_VIA[via].includes(kind)) {
    bad(`kind "${kind}" is not valid via ${via}. Use one of: ${KINDS_BY_VIA[via].join(', ')}`);
  }
  if (typeof text !== 'string') bad('text must be a string');
  if (!text.trim()) bad('text is empty');
  if (typeof to !== 'string' || !NAME_RE.test(to)) bad(`invalid to "${to}"`);
  if (refs !== undefined && (!Array.isArray(refs) || !refs.every(r => Number.isInteger(r) && r > 0))) {
    bad('refs must be an array of positive integers');
  }
  if (plan_hash !== undefined && (typeof plan_hash !== 'string' || !HASH_RE.test(plan_hash))) {
    bad('plan_hash must be 12 lowercase hex chars');
  }
  if (approvers !== undefined && (!Array.isArray(approvers) || !approvers.every(a => typeof a === 'string' && NAME_RE.test(a)))) {
    bad('approvers must be an array of names');
  }
  if (normalized !== undefined && typeof normalized !== 'boolean') bad('normalized must be a boolean');
  if (drafted !== undefined && drafted !== 'agent') bad('drafted must be "agent"');
  if (edit_path !== undefined && (typeof edit_path !== 'string' || !edit_path || edit_path.length > 1024)) bad('invalid edit_path');
  if (kind === 'signoff' && !plan_hash) bad('signoff requires plan_hash');
  if (kind === 'objection' && via === 'human' && !plan_hash) bad('a human objection requires plan_hash');
  if ((kind === 'plan_rev' || kind === 'decision') && !plan_hash) bad(`${kind} requires plan_hash`);
  if (kind === 'retract' && !(refs && refs.length)) bad('retract requires refs (the retracted ids)');
  return { via, kind, text, to, refs, plan_hash, approvers, normalized, edit_path, drafted };
}

function append(entry, opts = {}) {
  const v = validate(entry, opts);
  fs.mkdirSync(dir(), { recursive: true });
  return identity.withLock(logPath() + '.lock', () => {
    let raw = '';
    try { raw = fs.readFileSync(logPath(), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const lines = raw.split('\n').filter(Boolean);
    let last = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      try { last = JSON.parse(lines[i]).id || 0; break; } catch { /* skip corrupt */ }
    }
    const now = Date.now();
    if (v.via === 'agent') {
      let recent = 0;
      for (let i = lines.length - 1; i >= 0 && recent < RATE_MAX; i--) {
        let e;
        try { e = JSON.parse(lines[i]); } catch { continue; }
        const t = Date.parse(e.at);
        if (now - t >= RATE_WINDOW_MS) break; // the log is in time order
        if (e.from === opts.from && e.via === 'agent') recent++;
      }
      if (recent >= RATE_MAX) {
        throw new RoomError('RATE', `rate limit: ${opts.from}'s Claude posted ${RATE_MAX} times in the last minute; wait before posting again`);
      }
    }
    const prevLine = lines.length ? lines[lines.length - 1] : '';
    const e = { id: last + 1, at: new Date(now).toISOString(), from: opts.from, via: v.via, kind: v.kind, to: v.to };
    if (v.refs && v.refs.length) e.refs = v.refs;
    if (v.plan_hash) e.plan_hash = v.plan_hash;
    if (v.approvers) e.approvers = v.approvers;
    if (v.normalized !== undefined) e.normalized = v.normalized;
    if (v.edit_path) e.edit_path = v.edit_path;
    if (v.drafted) e.drafted = v.drafted;
    e.text = v.text;
    e.prev = hash12(prevLine);
    const prefix = raw && !raw.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(logPath(), prefix + JSON.stringify(e) + '\n');
    return e;
  }, RoomError);
}

/** Check the prev chain. Returns {ok:true, count} or {ok:false, badAt: id, count}. */
function validateChain() {
  let raw = '';
  try { raw = fs.readFileSync(logPath(), 'utf8'); } catch { return { ok: true, count: 0 }; }
  const lines = raw.split('\n').filter(Boolean);
  let prev = '';
  for (let i = 0; i < lines.length; i++) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { return { ok: false, badAt: null, line: i + 1, count: lines.length }; }
    if (e.prev !== undefined && e.prev !== hash12(prev)) return { ok: false, badAt: e.id, count: lines.length };
    prev = lines[i];
  }
  return { ok: true, count: lines.length };
}

// ---------- plan / decisions ----------
function currentPlan(entries = readAll()) {
  const p = entries.filter(e => e.kind === 'plan_rev' && e.plan_hash).at(-1);
  return p ? { id: p.id, hash: p.plan_hash, approvers: Array.isArray(p.approvers) ? p.approvers : [] } : null;
}

function planRev(hash, entries = readAll()) {
  return entries.filter(e => e.kind === 'plan_rev' && e.plan_hash === hash).at(-1) || null;
}

/** 1-based revision number of a plan hash: its position among the distinct hashes the room has published. */
function revNumber(hash, entries = readAll()) {
  const seen = [];
  for (const e of entries) if (e.kind === 'plan_rev' && e.plan_hash && !seen.includes(e.plan_hash)) seen.push(e.plan_hash);
  const i = seen.indexOf(hash);
  return i < 0 ? null : i + 1;
}

function signoffMatrix(hash, approvers, entries = readAll()) {
  if (!Array.isArray(approvers)) {
    const rev = planRev(hash, entries);
    approvers = rev && Array.isArray(rev.approvers) ? rev.approvers : [];
  }
  const signed = Object.fromEntries(approvers.map(n => [n, null]));
  for (const raw of entries) {
    const e = normalize(raw);
    if (e.via !== 'human' || e.plan_hash !== hash || !(e.from in signed)) continue;
    if (e.kind === 'signoff') signed[e.from] = e.id;
    else if (e.kind === 'objection' || e.kind === 'revoke') signed[e.from] = null;
  }
  const missing = approvers.filter(n => signed[n] == null);
  return { hash, signed, missing, complete: !!hash && approvers.length > 0 && missing.length === 0 };
}

function decided(hash, entries = readAll()) {
  return entries.filter(e => e.kind === 'decision' && e.plan_hash === hash).at(-1) || null;
}

// ---------- rendering ----------
const who = e => {
  if (e.via === 'system') return 'room';
  return e.via === 'agent' && e.from !== 'orch' ? `${e.from}'s Claude` : e.from;
};
const oneLine = s => String(s).replace(/\s+/g, ' ').trim();

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
  if (n.plan_hash) parts.push(`plan=${n.plan_hash.slice(0, 6)}`);
  if (Array.isArray(n.approvers)) parts.push(`approvers=${n.approvers.slice(0, 8).join(',') || '-'}`);
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

// ---------- lanes ----------
const esc = s => s.replace(/[.]/g, '\\.');
/** "@name" anywhere in the text (case-insensitive, not part of a longer name). */
const mentions = (text, name) => new RegExp(`(^|[^A-Za-z0-9_.-])@${esc(name)}(?![A-Za-z0-9_-])`, 'i').test(String(text ?? ''));
/** The bare name as a word ("alice takes the parser"). */
const names = (text, name) => new RegExp(`(^|[^A-Za-z0-9_-])${esc(name)}(?![A-Za-z0-9_-])`, 'i').test(String(text ?? ''));
/** Ids retracted by a via=system `retract` entry. */
const retractedIds = (entries = readAll()) =>
  new Set(entries.filter(e => e.kind === 'retract' && e.via === 'system').flatMap(e => e.refs || []));

/**
 * Which lane entry e takes for session me ({name, role}): 'push' (the monitor wakes me), 'pull' (the
 * "Room since your last turn" digest at my next prompt) or 'none' (never shown: my own entries, retracted ones).
 * Pass `entries` (the log as of now) to judge against current state: retractions, a plan_rev I already signed
 * or that was decided or superseded, an orch post that cites a decision, a partial sign-off (orch). Without
 * `entries` the answer is the entry-only one (push is then a superset of the judged push).
 *   everyone: a `retract` is push (its victim's Claude included); the retracted entry is none.
 *   member push: to=me or @me; a decision; a plan_rev/proposal whose approvers include me (pending);
 *     others' human words (via=human say/objection); an orch post to the room that names me and cites a
 *     decision (my assignment). Everything else is pull.
 *   orch push: everything not its own, plus its own hook-written decisions; a sign-off that leaves the
 *     matrix incomplete is pull.
 */
function lane(me, e, entries) {
  const name = me && me.name;
  const orch = !!me && me.role === 'orch';
  const n = normalize(e);
  if (n.kind === 'retract') return 'push'; // to everyone, its victim included (the hook writes it under the victim's name)
  if (n.from === name) return orch && n.via === 'system' && n.kind === 'decision' ? 'push' : 'none';
  if (entries && retractedIds(entries).has(n.id)) return 'none';
  if (orch) {
    if (n.kind === 'signoff' && entries && n.plan_hash) return signoffMatrix(n.plan_hash, undefined, entries).complete ? 'push' : 'pull';
    return 'push';
  }
  if (n.to === name || mentions(n.text, name)) return 'push';
  if (n.kind === 'decision') return 'push';
  if ((n.kind === 'plan_rev' || n.kind === 'proposal') && Array.isArray(n.approvers) && n.approvers.includes(name)) {
    if (!entries || !n.plan_hash) return 'push';
    const stale = signoffMatrix(n.plan_hash, n.approvers, entries).signed[name] || decided(n.plan_hash, entries)
      || (n.kind === 'plan_rev' && entries.some(x => x.kind === 'plan_rev' && x.id > n.id));
    return stale ? 'pull' : 'push';
  }
  if (n.via === 'human' && (n.kind === 'say' || n.kind === 'objection')) return 'push';
  if (n.from === 'orch' && n.via === 'agent' && n.to === 'room' && n.refs && n.refs.length && names(n.text, name)) {
    if (!entries) return 'push';
    const decisions = new Set(entries.filter(x => x.kind === 'decision').map(x => x.id));
    return n.refs.some(r => decisions.has(r)) ? 'push' : 'pull';
  }
  return 'pull';
}

/** "room now: plan eaae7e decided #18 · you: signed · away: bob", computed from the log as it is now. */
function stateLine(me, entries = readAll()) {
  const parts = [];
  const plan = currentPlan(entries);
  if (!plan) parts.push('no plan yet');
  else {
    const dec = decided(plan.hash, entries);
    const m = signoffMatrix(plan.hash, plan.approvers, entries);
    parts.push(`plan ${plan.hash.slice(0, 6)} ${dec ? `decided #${dec.id}` : m.missing.length ? `waiting on ${m.missing.join(', ')}` : 'signed by all'}`);
    if (me && plan.approvers.includes(me.name)) parts.push(`you: ${m.signed[me.name] ? 'signed' : dec ? 'not signed' : 'sign-off needed'}`);
  }
  const away = Object.values(readMembersHere()).filter(m => m && m.left_at && m.name !== (me && me.name)).map(m => m.name);
  if (away.length) parts.push(`away: ${away.join(', ')}`);
  return `room now: ${parts.join(' · ')}`;
}

/** Full text for read(). With `entries`, a retracted entry says so (its text stays, for the record). */
function fmt(e, { entries } = {}) {
  const by = entries && entries.find(x => x.kind === 'retract' && x.via === 'system' && (x.refs || []).includes(e.id));
  return `[${header(e)} ${String(e.at || '').slice(11, 19)}]${by ? ` [retracted by #${by.id}: ${oneLine(by.text)}]` : ''}\n${e.text}`;
}

function readMembersHere() {
  try { return identity.readMembersFile(path.join(dir(), 'members.json')); } catch { return {}; }
}

/** The ordered digest sections; items carry an id so the cap can trim the oldest first. */
function digestSections(entries = readAll()) {
  const gone = retractedIds(entries);
  entries = entries.filter(e => !gone.has(e.id));
  const members = readMembersHere();
  const memberLines = Object.values(members).map(m => {
    const last = entries.filter(e => e.from === m.name && e.via !== 'system').at(-1);
    return { text: `  ${m.name} (${m.role})${m.left_at ? ' LEFT' : ''} last post ${last ? `#${last.id} ${String(last.at).slice(11, 19)}` : '-'}` };
  });

  const plan = currentPlan(entries);
  const planLines = [];
  if (plan) {
    const m = signoffMatrix(plan.hash, plan.approvers, entries);
    const dec = decided(plan.hash, entries);
    planLines.push({ text: `  plan=${plan.hash} (#${plan.id}) approvers: ${plan.approvers.join(' ') || '(none)'}${dec ? ` DECIDED #${dec.id}` : ''}` });
    for (const n of plan.approvers) planLines.push({ text: `  ${m.signed[n] ? '✔' : '–'} ${n}${m.signed[n] ? ` #${m.signed[n]}` : ''}` });
    if (!dec) planLines.push({ text: `  waiting on: ${m.missing.join(', ') || '(nobody)'}` });
  } else planLines.push({ text: '  (no plan yet)' });

  const closedBy = new Set();
  for (const e of entries) {
    if ((e.from === 'orch' || e.kind === 'decision') && e.refs) e.refs.forEach(r => closedBy.add(r));
  }
  const open = entries.map(normalize)
    .filter(e => (e.kind === 'objection' || e.kind === 'question') && !closedBy.has(e.id))
    .map(e => ({ id: e.id, text: `  #${e.id} ${who(e)} ${e.kind}${e.plan_hash ? ` plan=${e.plan_hash.slice(0, 6)}` : ''}: ${quote(e, 120)}` }));
  const decisions = entries.filter(e => e.kind === 'decision')
    .map(e => ({ id: e.id, text: `  #${e.id} plan=${e.plan_hash || '-'}: ${quote(e, 120)}` }));
  const human = entries.filter(e => e.via === 'human').slice(-10)
    .map(e => ({ id: e.id, text: `  #${e.id} ${e.from}${e.drafted === 'agent' ? ` (${e.from}, Claude's wording)` : ''} ${e.kind}: ${quote(e, TEXT_MAX, { exact: true })}` }));

  return [
    { title: `members of ${code() || 'this room'}`, lines: memberLines },
    { title: 'current plan and sign-offs', lines: planLines },
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

// ---------- cursors ----------
const CURSOR_RE = /^[A-Za-z0-9_.-]{1,64}$/;
function cursorFile(name) {
  if (!CURSOR_RE.test(name)) throw new RoomError('INVALID', `invalid cursor name "${name}"`);
  return path.join(dir(), `${name}.cursor`);
}
const getCursor = name => { try { return Number(fs.readFileSync(cursorFile(name), 'utf8')) || 0; } catch { return 0; } };
/** Atomic (write + rename), so a concurrent reader never sees an empty file. */
const setCursor = (name, n) => {
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = `${cursorFile(name)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, String(n));
  fs.renameSync(tmp, cursorFile(name));
};

module.exports = {
  KINDS, AGENT_KINDS, HUMAN_KINDS, SYSTEM_KINDS, SYSTEM_ONLY_KINDS, VIAS, DIGEST_CAP, TAIL_MAX, TEXT_MAX, NAME_RE, RATE_MAX, RATE_WINDOW_MS,
  RoomError,
  bind, code, dir, logPath, plansDir,
  readAll, readById, readAfter, lastId, follow, normalize,
  append, validateChain,
  hash12, currentPlan, planRev, revNumber, signoffMatrix, decided,
  line, tailLine, lane, stateLine, retractedIds, mentions, fmt, who, digestSections, digest,
  getCursor, setCursor,
};
