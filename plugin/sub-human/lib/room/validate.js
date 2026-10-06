'use strict';
/**
 * plugin/sub-human/lib/room/validate.js: the room log's envelope rules (envelope v3): which kinds each `via`
 * may write, the fields a caller may set, and the task fields of task_req / task entries. append() (store.js)
 * runs validate() before it takes the log lock. Zero dependencies beyond lib/text.js.
 *
 *   validate(entry, {via, from, system}) -> {via, kind, text, to, refs, hash, approvers, path, proposal_hash,
 *       normalized, edit_path, drafted, task}     throws RoomError INVALID with a message for the model
 *   RoomError(code, message)   code: INVALID | RATE | LOCK | NO_ROOM
 * Rules: via "agent" writes say question status proposal task_req; via "human" say signoff objection proposal;
 * via "system" decision member_joined member_left retract task status, and only with {system: true}.
 * Size caps (lib/config.js): text <= ENTRY_TEXT_MAX_BYTES UTF-8 bytes, refs <= ENTRY_REFS_MAX, approvers and
 * blockedBy <= ENTRY_LIST_MAX, any other string field <= ENTRY_STR_MAX (JS .length) (narrower caps below win).
 * append() also refuses a serialized line over LOG_LINE_MAX_BYTES.
 */

const { NAME_RE } = require('../text.js');
const { ENTRY_TEXT_MAX_BYTES, ENTRY_REFS_MAX, ENTRY_STR_MAX, ENTRY_LIST_MAX } = require('../config.js');

const AGENT_KINDS = ['say', 'question', 'status', 'proposal', 'task_req'];
const HUMAN_KINDS = ['say', 'signoff', 'objection', 'proposal'];
const SYSTEM_ONLY_KINDS = ['decision', 'member_joined', 'member_left', 'retract', 'task'];
const TASK_OPS = ['add', 'claim', 'release', 'done'];
const SYSTEM_KINDS = [...SYSTEM_ONLY_KINDS, 'status'];
const KINDS = [...new Set([...AGENT_KINDS, ...HUMAN_KINDS, ...SYSTEM_KINDS])];
const KINDS_BY_VIA = { agent: AGENT_KINDS, human: HUMAN_KINDS, system: SYSTEM_KINDS };
const VIAS = ['human', 'agent', 'system'];
const HASH_RE = /^[0-9a-f]{6,64}$/;
const TASK_FIELDS = ['op', 'task_id', 'subject', 'detail', 'evidence', 'owner', 'status', 'req', 'blockedBy'];
const ENTRY_FIELDS = new Set(['kind', 'text', 'to', 'refs', 'hash', 'approvers', 'path', 'proposal_hash', 'normalized',
  'edit_path', 'drafted', 'id', 'by', ...TASK_FIELDS]);
const TASK_KINDS = ['task_req', 'task'];

class RoomError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

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
  if (typeof text === 'string') {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > ENTRY_TEXT_MAX_BYTES) bad(`text is too long (${bytes} bytes; the limit is ${ENTRY_TEXT_MAX_BYTES}). Shorten it, or put the detail in a file and post its path`);
  }
  if (typeof to !== 'string' || !NAME_RE.test(to)) bad(`invalid to "${to}"`);
  if (refs !== undefined && (!Array.isArray(refs) || !refs.every(r => Number.isInteger(r) && r > 0))) {
    bad('refs must be an array of positive integers');
  }
  if (refs !== undefined && refs.length > ENTRY_REFS_MAX) bad(`too many refs (${refs.length}; the limit is ${ENTRY_REFS_MAX})`);
  for (const [k, v] of [['hash', hash], ['proposal_hash', proposal_hash]]) {
    if (v !== undefined && (typeof v !== 'string' || !HASH_RE.test(v))) bad(`${k} must be 6-64 lowercase hex chars`);
  }
  if (approvers !== undefined && (!Array.isArray(approvers) || !approvers.every(a => typeof a === 'string' && NAME_RE.test(a)))) {
    bad('approvers must be an array of names');
  }
  if (approvers !== undefined && approvers.length > ENTRY_LIST_MAX) bad(`too many approvers (${approvers.length}; the limit is ${ENTRY_LIST_MAX})`);
  for (const [k, v] of Object.entries(entry)) {
    if (k !== 'text' && typeof v === 'string' && v.length > ENTRY_STR_MAX) bad(`${k} is too long (the limit is ${ENTRY_STR_MAX} chars)`);
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
  if (entry.blockedBy !== undefined && entry.blockedBy.length > ENTRY_LIST_MAX) bad(`too many blockedBy ids (the limit is ${ENTRY_LIST_MAX})`);
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

module.exports = { RoomError, validate };
