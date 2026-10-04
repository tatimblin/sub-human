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
 *     via "system": plan_rev decision member_joined member_left status, and only with {system:true}
 *                   (via defaults to "system" when system:true). plan_rev and decision need plan_hash.
 *     Assigns id (monotonic, under a lockfile), at, from, via, prev (hash12 of the previous line).
 *     Throws RoomError with code INVALID | RATE | LOCK | NO_ROOM.
 *
 * Plan and decisions:
 *   currentPlan() -> {id, hash, approvers}|null      the latest plan_rev
 *   planRev(hash) -> Entry|null                      the latest plan_rev with that hash
 *   signoffMatrix(hash, approvers?) -> {hash, signed: {name: id|null}, missing, complete}
 *       approvers default to that plan_rev's. Per approver, the latest via=human signoff or objection
 *       carrying plan_hash === hash wins: an objection voids an earlier signoff.
 *   decided(hash) -> Entry|null                      the decision entry for that hash
 *
 * Rendering:
 *   tailLine(e) (<= 240 chars), fmt(e), who(e) ("alice" | "alice's Claude" | "room"),
 *   digest() (<= 9,500 chars: members, plan + approvers + matrix, open objections/questions, decisions,
 *   last 10 human entries), validateChain() -> {ok, badAt?}
 * Constants: KINDS, AGENT_KINDS, HUMAN_KINDS, SYSTEM_KINDS, VIAS, DIGEST_CAP, TAIL_MAX, NAME_RE,
 *   RATE_MAX, RATE_WINDOW_MS. Error class: RoomError.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const identity = require('./identity.js');

const AGENT_KINDS = ['say', 'proposal', 'question', 'objection', 'status'];
const HUMAN_KINDS = ['say', 'signoff', 'objection'];
const SYSTEM_ONLY_KINDS = ['plan_rev', 'decision', 'member_joined', 'member_left'];
const SYSTEM_KINDS = [...SYSTEM_ONLY_KINDS, 'status'];
const KINDS = [...new Set([...AGENT_KINDS, ...HUMAN_KINDS, ...SYSTEM_KINDS])];
const KINDS_BY_VIA = { agent: AGENT_KINDS, human: HUMAN_KINDS, system: SYSTEM_KINDS };
const VIAS = ['human', 'agent', 'system'];
const DIGEST_CAP = 9500;
const TAIL_MAX = 240;
const RATE_MAX = 6;
const RATE_WINDOW_MS = 60_000;
const NAME_RE = identity.NAME_RE;
const HASH_RE = /^[0-9a-f]{12}$/;
const ENTRY_FIELDS = new Set(['kind', 'text', 'to', 'refs', 'plan_hash', 'approvers', 'normalized', 'edit_path']);

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
  const { kind, text, to = 'room', refs, plan_hash, approvers, normalized, edit_path } = entry;
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
  if (edit_path !== undefined && (typeof edit_path !== 'string' || !edit_path || edit_path.length > 1024)) bad('invalid edit_path');
  if (kind === 'signoff' && !plan_hash) bad('signoff requires plan_hash');
  if (kind === 'objection' && via === 'human' && !plan_hash) bad('a human objection requires plan_hash');
  if ((kind === 'plan_rev' || kind === 'decision') && !plan_hash) bad(`${kind} requires plan_hash`);
  return { via, kind, text, to, refs, plan_hash, approvers, normalized, edit_path };
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
const clip = (s, n) => { const cps = Array.from(s); return cps.length > n ? cps.slice(0, n).join('') + '…' : s; };

function header(e) {
  const n = normalize(e);
  const parts = [`#${n.id}`, `${n.from}${n.via ? `[${n.via}]` : ''}`, n.kind];
  if (n.to && n.to !== 'room') parts.push(`to=${n.to}`);
  if (n.refs && n.refs.length) {
    const r = n.refs.slice(0, 5).map(x => '#' + x).join(',');
    parts.push(`refs=${r}${n.refs.length > 5 ? ',…' : ''}`);
  }
  if (n.plan_hash) parts.push(`plan=${n.plan_hash.slice(0, 6)}`);
  if (Array.isArray(n.approvers)) parts.push(`approvers=${n.approvers.slice(0, 8).join(',') || '-'}`);
  return parts.join(' ');
}

function tailLine(e) {
  const head = header(e).slice(0, TAIL_MAX - 3);
  let n = 200;
  for (;;) {
    const line = `${head} ${JSON.stringify(clip(oneLine(e.text || ''), n))}`;
    if (line.length <= TAIL_MAX) return line;
    if (n === 0) return line.slice(0, TAIL_MAX);
    n = Math.max(0, n - Math.max(1, line.length - TAIL_MAX));
  }
}

const fmt = e => `[${header(e)} ${String(e.at || '').slice(11, 19)}]\n${e.text}`;

function readMembersHere() {
  try { return identity.readMembersFile(path.join(dir(), 'members.json')); } catch { return {}; }
}

/** The ordered digest sections; items carry an id so the cap can trim the oldest first. */
function digestSections(entries = readAll()) {
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
    .map(e => ({ id: e.id, text: `  #${e.id} ${who(e)} ${e.kind}${e.plan_hash ? ` plan=${e.plan_hash.slice(0, 6)}` : ''}: ${JSON.stringify(clip(oneLine(e.text), 120))}` }));
  const decisions = entries.filter(e => e.kind === 'decision')
    .map(e => ({ id: e.id, text: `  #${e.id} plan=${e.plan_hash || '-'}: ${JSON.stringify(clip(oneLine(e.text), 120))}` }));
  const human = entries.filter(e => e.via === 'human').slice(-10)
    .map(e => ({ id: e.id, text: `  #${e.id} ${e.from} ${e.kind}: ${JSON.stringify(clip(oneLine(e.text), 160))}` }));

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
    if (!oldest) return text.slice(0, DIGEST_CAP - 1) + '…';
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
  KINDS, AGENT_KINDS, HUMAN_KINDS, SYSTEM_KINDS, SYSTEM_ONLY_KINDS, VIAS, DIGEST_CAP, TAIL_MAX, NAME_RE, RATE_MAX, RATE_WINDOW_MS,
  RoomError,
  bind, code, dir, logPath, plansDir,
  readAll, readById, readAfter, lastId, follow, normalize,
  append, validateChain,
  hash12, currentPlan, planRev, signoffMatrix, decided,
  tailLine, fmt, who, digestSections, digest,
  getCursor, setCursor,
};
