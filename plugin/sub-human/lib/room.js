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
 *   normalize(entry)                         legacy display mapping (concern -> objection, agree -> signoff,
 *                                            plan_rev -> proposal {hash}, plan_hash -> proposal_hash)
 *   getCursor(name), setCursor(name, n)      <roomDir>/<name>.cursor, written atomically
 *
 * Writing:
 *   append(entry, {via, from, system}) -> Entry
 *     entry = {kind, text, to?, refs?, normalized?, edit_path?, drafted?,
 *              hash?, approvers?, path?          (proposal: hash required)
 *              proposal_hash?                    (signoff, human objection, decision: required)
 *              op?, id?, subject?, detail?, evidence?, owner?, status?, req?, blockedBy?   (task_req, task)}
 *     via "agent":  say question status proposal task_req   (rate limit: 6 per `from` per 60 s, RoomError RATE)
 *     via "human":  say signoff objection proposal
 *     via "system": decision member_joined member_left retract task status, and only with {system:true}
 *                   (via defaults to "system" when system:true).
 *     task_req / task: the caller's `id` (the task id) is stored as `task_id`, since `id` is the log id;
 *     task_req gets `by` = from; their text defaults to a one-line summary ("claim #2 parser tests").
 *     Assigns id (monotonic, under a lockfile), at, from, via, prev (hash12 of the previous line).
 *     Throws RoomError with code INVALID | RATE | LOCK | NO_ROOM.
 *
 * Proposals and decisions (a proposal is {hash, approvers[], path?}; answers carry proposal_hash):
 *   proposal(hash, entries?) -> Entry|null           the latest proposal with that hash
 *   proposals(entries?) -> Entry[]                   the latest entry per distinct hash, in log order
 *   answers(hash, approvers?, entries?) -> {hash, signed: {name: id|null}, missing, complete}
 *       (alias signoffMatrix) approvers default to that proposal's. Per approver, the latest via=human
 *       signoff or objection carrying proposal_hash === hash wins: an objection voids an earlier signoff.
 *   answered(name, hash, entries?) -> Entry|null     name's latest via=human answer on hash
 *   decided(hash, entries?) -> Entry|null            the decision entry for that hash
 *
 * Lanes:
 *   lane(me, e, entries?) -> 'push' | 'pull' | 'none'   who a notice concerns (rules at lane() below)
 *   stateLine(me, entries?) -> "room now: proposal 3fa2c1 waiting on bob · you: answer needed · away: carol"
 *   retractedIds(entries?) -> Set, mentions(text, name) -> bool ("@name")
 *
 * Rendering:
 *   line(e, {full}) one notice line. full: the exact text (JSON-quoted) up to TEXT_MAX = 2,000 code points,
 *     then `[cut at 2000/N: sub-human read ID]`; without full, <= 240 chars with the same marker when cut.
 *     Never a bare "…". With {entries}, a retracted entry renders as its header + "[retracted by #N]".
 *     A drafted:"agent" entry's header carries "(NAME, Claude's wording)". tailLine(e) = line(e).
 *   fmt(e, {entries}?), who(e) ("alice" | "alice's Claude" | "room"),
 *   digest() (<= 9,500 chars: members, open proposals + approvers + answers, open objections/questions,
 *   decisions, last 10 human entries in full by the line() rule; retracted entries left out), validateChain()
 * Constants: KINDS, AGENT_KINDS, HUMAN_KINDS, SYSTEM_KINDS, SYSTEM_ONLY_KINDS, TASK_OPS, VIAS, DIGEST_CAP,
 *   TAIL_MAX, TEXT_MAX, NAME_RE, RATE_MAX, RATE_WINDOW_MS. Error class: RoomError.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const identity = require('./identity.js');

const AGENT_KINDS = ['say', 'question', 'status', 'proposal', 'task_req'];
const HUMAN_KINDS = ['say', 'signoff', 'objection', 'proposal'];
const SYSTEM_ONLY_KINDS = ['decision', 'member_joined', 'member_left', 'retract', 'task'];
const TASK_OPS = ['add', 'claim', 'release', 'done'];
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
const HASH_RE = /^[0-9a-f]{6,64}$/;
const TASK_FIELDS = ['op', 'task_id', 'subject', 'detail', 'evidence', 'owner', 'status', 'req', 'blockedBy'];
const ENTRY_FIELDS = new Set(['kind', 'text', 'to', 'refs', 'hash', 'approvers', 'path', 'proposal_hash', 'normalized',
  'edit_path', 'drafted', 'id', 'by', ...TASK_FIELDS]);
const TASK_KINDS = ['task_req', 'task'];

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
  if (n.kind === 'plan_rev') { n.kind = 'proposal'; if (n.plan_hash && !n.hash) n.hash = n.plan_hash; }
  else if (n.plan_hash && !n.proposal_hash) n.proposal_hash = n.plan_hash;
  delete n.plan_hash;
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
  const { kind, to = 'room', refs, hash, approvers, path: ppath, proposal_hash, normalized, edit_path, drafted } = entry;
  const isTask = TASK_KINDS.includes(kind);
  if (entry.id !== undefined && !isTask) bad('field "id" is not settable by callers');
  if (entry.by !== undefined && !(kind === 'task_req' && entry.by === opts.from)) bad('field "by" is not settable by callers (task_req stamps it)');
  for (const k of TASK_FIELDS) if (entry[k] !== undefined && !isTask) bad(`field "${k}" is only for task_req and task entries`);
  const task = isTask ? taskFields(kind, entry) : null;
  const text = entry.text === undefined && task ? taskText(kind, task) : entry.text;
  const bareAnswer = entry.text === undefined && (kind === 'signoff' || (kind === 'objection' && via === 'human'));
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
  if (!bareAnswer) {
    if (typeof text !== 'string') bad('text must be a string');
    if (!text.trim()) bad('text is empty');
  }
  if (typeof to !== 'string' || !NAME_RE.test(to)) bad(`invalid to "${to}"`);
  if (refs !== undefined && (!Array.isArray(refs) || !refs.every(r => Number.isInteger(r) && r > 0))) {
    bad('refs must be an array of positive integers');
  }
  for (const [k, v] of [['hash', hash], ['proposal_hash', proposal_hash]]) {
    if (v !== undefined && (typeof v !== 'string' || !HASH_RE.test(v))) bad(`${k} must be 6-64 lowercase hex chars`);
  }
  if (approvers !== undefined && (!Array.isArray(approvers) || !approvers.every(a => typeof a === 'string' && NAME_RE.test(a)))) {
    bad('approvers must be an array of names');
  }
  if (normalized !== undefined && typeof normalized !== 'boolean') bad('normalized must be a boolean');
  if (drafted !== undefined && drafted !== 'agent') bad('drafted must be "agent"');
  for (const [k, v] of [['edit_path', edit_path], ['path', ppath]]) {
    if (v !== undefined && (typeof v !== 'string' || !v || v.length > 1024)) bad(`invalid ${k}`);
  }
  if (kind === 'proposal' && !hash) bad('proposal requires hash');
  if (kind !== 'proposal' && (hash !== undefined || ppath !== undefined)) bad('hash and path are only for proposals');
  if (kind === 'signoff' && !proposal_hash) bad('signoff requires proposal_hash');
  if (kind === 'objection' && via === 'human' && !proposal_hash) bad('a human objection requires proposal_hash');
  if (kind === 'decision' && !proposal_hash) bad('decision requires proposal_hash');
  if (kind === 'retract' && !(refs && refs.length)) bad('retract requires refs (the retracted ids)');
  return { via, kind, text, to, refs, hash, approvers, path: ppath, proposal_hash, normalized, edit_path, drafted, task };
}

const taskIdOk = v => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(v)) || (Number.isInteger(v) && v > 0);
const optStr = (k, v, max) => { if (v !== undefined && (typeof v !== 'string' || v.length > max)) bad(`${k} must be a string of at most ${max} chars`); };

/** The task fields of a task_req / task entry, checked; the caller's `id` (the task id) becomes task_id. */
function taskFields(kind, entry) {
  const t = {};
  const tid = entry.task_id !== undefined ? entry.task_id : entry.id;
  if (tid !== undefined) { if (!taskIdOk(tid)) bad('the task id must be a positive integer or a short id string'); t.task_id = String(tid); }
  if (entry.op !== undefined) t.op = entry.op;
  if (kind === 'task_req') {
    if (!TASK_OPS.includes(t.op)) bad(`task_req op must be one of: ${TASK_OPS.join(', ')}`);
    if (t.op === 'add' && !(typeof entry.subject === 'string' && entry.subject.trim())) bad('add needs a subject');
    if (t.op !== 'add' && t.task_id === undefined) bad(`${t.op} needs the task id`);
    if (t.op === 'done' && !(typeof entry.evidence === 'string' && entry.evidence.trim())) bad('done needs evidence');
  } else if (t.op !== undefined && (typeof t.op !== 'string' || !/^[a-z_]{1,20}$/.test(t.op))) bad('invalid task op');
  optStr('subject', entry.subject, 500);
  optStr('detail', entry.detail, 4000);
  optStr('evidence', entry.evidence, 4000);
  optStr('status', entry.status, 32);
  if (entry.owner !== undefined && entry.owner !== null && !(typeof entry.owner === 'string' && NAME_RE.test(entry.owner))) bad(`invalid owner "${entry.owner}"`);
  if (entry.req !== undefined && !(Number.isInteger(entry.req) && entry.req > 0)) bad('req must be a log id');
  if (entry.blockedBy !== undefined && !(Array.isArray(entry.blockedBy) && entry.blockedBy.every(taskIdOk))) bad('blockedBy must be task ids');
  for (const k of ['subject', 'detail', 'evidence', 'status', 'owner', 'req']) if (entry[k] !== undefined && entry[k] !== null) t[k] = entry[k];
  if (entry.blockedBy !== undefined) t.blockedBy = entry.blockedBy.map(String);
  return t;
}

/** "claim #2 parser tests" / "#2 parser tests: in_progress, owner bob": the default text of a task entry. */
function taskText(kind, t) {
  const id = t.task_id ? `#${t.task_id}` : '';
  const head = [t.op, id, t.subject].filter(Boolean).join(' ');
  if (kind === 'task_req') return head + (t.op === 'done' && t.evidence ? `; evidence: ${t.evidence}` : '');
  const tail = [t.status, t.owner && `owner ${t.owner}`].filter(Boolean).join(', ');
  return (head || 'task') + (tail ? `: ${tail}` : '');
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
    if (v.hash) e.hash = v.hash;
    if (v.approvers) e.approvers = v.approvers;
    if (v.path) e.path = v.path;
    if (v.proposal_hash) e.proposal_hash = v.proposal_hash;
    if (v.task) {
      if (v.kind === 'task_req') e.by = opts.from;
      Object.assign(e, v.task);
    }
    if (v.normalized !== undefined) e.normalized = v.normalized;
    if (v.edit_path) e.edit_path = v.edit_path;
    if (v.drafted) e.drafted = v.drafted;
    if (v.text !== undefined) e.text = v.text;
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

// ---------- proposals / decisions ----------
/** The latest proposal entry (legacy plan_rev included) with that hash. */
function proposal(hash, entries = readAll()) {
  let p = null;
  for (const raw of entries) {
    if (raw.kind !== 'proposal' && raw.kind !== 'plan_rev') continue;
    const n = normalize(raw);
    if (n.hash === hash) p = n;
  }
  return p;
}

/** The latest proposal per distinct hash, in log order of that latest entry. */
function proposals(entries = readAll()) {
  const byHash = new Map();
  for (const raw of entries) {
    if (raw.kind !== 'proposal' && raw.kind !== 'plan_rev') continue;
    const n = normalize(raw);
    if (!n.hash) continue;
    byHash.delete(n.hash);
    byHash.set(n.hash, n);
  }
  return [...byHash.values()];
}

const approversOf = p => (p && Array.isArray(p.approvers) ? p.approvers : []);

function answers(hash, approvers, entries = readAll()) {
  if (!Array.isArray(approvers)) approvers = approversOf(proposal(hash, entries));
  const signed = Object.fromEntries(approvers.map(n => [n, null]));
  for (const raw of entries) {
    const e = normalize(raw);
    if (e.via !== 'human' || e.proposal_hash !== hash || !(e.from in signed)) continue;
    if (e.kind === 'signoff') signed[e.from] = e.id;
    else if (e.kind === 'objection' || e.kind === 'revoke') signed[e.from] = null;
  }
  const missing = approvers.filter(n => signed[n] == null);
  return { hash, signed, missing, complete: !!hash && approvers.length > 0 && missing.length === 0 };
}

/** name's latest via=human signoff or objection on hash, or null. */
function answered(name, hash, entries = readAll()) {
  let a = null;
  for (const raw of entries) {
    const e = normalize(raw);
    if (e.via === 'human' && e.from === name && e.proposal_hash === hash && (e.kind === 'signoff' || e.kind === 'objection')) a = e;
  }
  return a;
}

function decided(hash, entries = readAll()) {
  return entries.map(normalize).filter(e => e.kind === 'decision' && e.proposal_hash === hash).at(-1) || null;
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

// ---------- lanes ----------
const esc = s => s.replace(/[.]/g, '\\.');
/** "@name" anywhere in the text (case-insensitive, not part of a longer name). */
const mentions = (text, name) => new RegExp(`(^|[^A-Za-z0-9_.-])@${esc(name)}(?![A-Za-z0-9_-])`, 'i').test(String(text ?? ''));
/** Ids retracted by a via=system `retract` entry. */
const retractedIds = (entries = readAll()) =>
  new Set(entries.filter(e => e.kind === 'retract' && e.via === 'system').flatMap(e => e.refs || []));

/** The retracted entry's own lane decides a retract's: whoever would have been woken by it hears it was forged. */
function retractLane(me, n, entries) {
  if (n.from === (me && me.name)) return 'push'; // its victim (the hook writes it under the victim's name)
  if (!entries) return 'push';
  const byId = new Map(entries.map(x => [x.id, x]));
  return (n.refs || []).some(r => byId.has(r) && lane(me, byId.get(r)) === 'push') ? 'push' : 'none';
}

/** Whether name is in proposal p: an approver or its author. */
const inProposal = (p, name) => !!p && (approversOf(p).includes(name) || p.from === name);

/**
 * Which lane entry e takes for session me ({name, role}): 'push' (the monitor wakes me), 'pull' (the
 * "Room since your last turn" digest at my next prompt) or 'none' (never shown). Pass `entries` (the log as
 * of now) to judge against current state: retractions, a proposal I already answered or that was decided, the
 * proposal a decision or an answer belongs to, the request a task entry applied. Without `entries` the answer
 * is the entry-only one (push is then a superset of the judged push).
 *   none: my own entries (hook-written system decision/task entries are not "mine"), retracted entries.
 *   retract: push to its victim and to whoever the retracted entry would have pushed; none otherwise.
 *   member push: others' via=human entries, except a `say` @-addressed only to others (@orch, @bob: pull);
 *     to=me or @me; a proposal naming me that I have not answered (and is not decided); a decision on a
 *     proposal I am in; a `task` assigning me (owner me) that someone else asked for (its req is not mine).
 *     Everything else is pull.
 *   orch push: to=orch or @orch; decisions; task_req. Everything else is pull (member_joined reaches it
 *     through bin/sub-human tail's row note).
 *   card answers (both roles): a signoff is pull (the decision carries it); an objection is push to the
 *     proposal's author only (to revise), pull for everyone else.
 *   decisions (judged): pull for the member whose answer completed it (the card's own reply, consent.js,
 *     already told that Claude), and an objected decision is pull for all but the proposer (nothing to act
 *     on; a revision brings its own card).
 */
function lane(me, e, entries) {
  const name = me && me.name;
  const orch = !!me && me.role === 'orch';
  const n = normalize(e);
  if (n.kind === 'retract') return retractLane(me, n, entries);
  if (n.from === name && !(n.via === 'system' && (n.kind === 'decision' || n.kind === 'task'))) return 'none';
  if (entries && retractedIds(entries).has(n.id)) return 'none';
  if (n.to === name || mentions(n.text, name)) return 'push';
  if ((n.kind === 'signoff' || n.kind === 'objection') && n.proposal_hash) {
    if (n.kind === 'signoff') return 'pull';
    if (!entries) return 'push';
    const p = proposal(n.proposal_hash, entries);
    return p && p.from === name ? 'push' : 'pull';
  }
  if (n.kind === 'decision' && entries && quietDecision(name, n, entries)) return 'pull';
  if (orch) {
    if (n.kind === 'task_req' || n.kind === 'decision') return 'push';
    return 'pull';
  }
  if (n.kind === 'proposal' && approversOf(n).includes(name)) {
    if (!entries || !n.hash) return 'push';
    return answered(name, n.hash, entries) || decided(n.hash, entries) ? 'pull' : 'push';
  }
  if (n.kind === 'decision') {
    if (approversOf(n).includes(name) || !entries) return 'push';
    return inProposal(proposal(n.proposal_hash, entries), name) ? 'push' : 'pull';
  }
  if (n.kind === 'task' && n.owner === name) {
    if (!n.req || !entries) return 'push';
    const req = entries.find(x => x.id === n.req);
    return req && (req.by || req.from) === name ? 'pull' : 'push';
  }
  if (n.via === 'human') return n.kind === 'say' && addressedElsewhere(n.text) ? 'pull' : 'push';
  return 'pull';
}

/**
 * A decision that needs no wake for name: name's answer completed it (consent.js told that Claude in the
 * card's reply), or it is an objected decision on a proposal name did not write.
 */
function quietDecision(name, d, entries) {
  const byId = new Map(entries.map(x => [x.id, x]));
  const answersIn = (d.refs || []).map(r => byId.get(r)).filter(x => x && (x.kind === 'signoff' || x.kind === 'objection'));
  const last = answersIn.sort((a, b) => b.id - a.id)[0];
  if (last && last.from === name && last.via === 'human') return true;
  if (/^objected:/.test(String(d.text || ''))) {
    const p = proposal(d.proposal_hash, entries);
    return !(p && p.from === name);
  }
  return false;
}

/** The text @-addresses a room member (or the orch); called after mentions(text, me) was false. */
function addressedElsewhere(text) {
  const names = new Set(['orch', ...Object.keys(readMembersHere())].map(x => x.toLowerCase()));
  for (const m of String(text ?? '').matchAll(/(^|[^A-Za-z0-9_.-])@([A-Za-z0-9_-]+)/g)) if (names.has(m[2].toLowerCase())) return true;
  return false;
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
      // the open-the-card call is spelled out right in the notice: Haiku skipped it from the join text alone
      s += ` · you: ${a ? (a.kind === 'signoff' ? 'agreed' : 'objected') : dec ? 'not answered' : `answer needed (call AskUserQuestion with "proposal ${p.hash}")`}`;
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
  KINDS, AGENT_KINDS, HUMAN_KINDS, SYSTEM_KINDS, SYSTEM_ONLY_KINDS, TASK_OPS, VIAS, DIGEST_CAP, TAIL_MAX, TEXT_MAX, NAME_RE, RATE_MAX, RATE_WINDOW_MS,
  RoomError,
  bind, code, dir, logPath, plansDir,
  readAll, readById, readAfter, lastId, follow, normalize,
  append, validateChain,
  hash12, proposal, proposals, answers, signoffMatrix: answers, answered, decided,
  line, tailLine, lane, stateLine, retractedIds, mentions, fmt, who, digestSections, digest,
  getCursor, setCursor,
};
