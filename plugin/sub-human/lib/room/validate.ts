/**
 * plugin/sub-human/lib/room/validate.ts: the room log's envelope rules (envelope v3): which kinds each `via`
 * may write, the fields a caller may set, and the task fields of task_req / task entries. append() (store.ts)
 * runs validate() before it signs, and place() runs it again on the payload before it takes the log lock.
 * Zero dependencies beyond lib/text.ts.
 *
 *   validate(entry, {via, from, system}) -> {via, kind, text, to, refs, hash, approvers, same, path, proposal_hash,
 *       normalized, edit_path, drafted, task, pubkey, machine, host}   throws RoomError INVALID with a message for the model
 *   RoomError(code, message)   code: INVALID | RATE | LOCK | NO_ROOM | AUTH (a signature, a replay or a pinned key refused)
 * Rules: via "agent" writes say question status proposal task_req; via "human" say signoff objection proposal;
 * via "system" decision member_joined member_left task status, and only with {system: true}.
 * Size caps (lib/config.ts): text <= ENTRY_TEXT_MAX_BYTES UTF-8 bytes, refs <= ENTRY_REFS_MAX, approvers and
 * blockedBy <= ENTRY_LIST_MAX, any other string field <= ENTRY_STR_MAX (JS .length) (narrower caps below win).
 * A proposal may carry same (lib/proposal.ts create): disjoint groups of 2+ of its approvers that are one person,
 * ENTRY_LIST_MAX names in all. A host lists 'same' in its caps (lib/remote/protocol.ts CAPS fields) once it accepts it.
 * member_joined may carry pubkey (the seat's Ed25519 SPKI PEM, which pins it: lib/room/envelope.ts) and machine.
 * host_changed (via system; lib/handoff.ts) moves the room's authority: {epoch (a positive integer, one more than the
 * last), host (the new host's seat name), machine (its machine id), locator (how members reach it: an invite's
 * locator), accept? (the new host seat's signed acceptance, a planned handoff), ask? (the old host seat's signed
 * request), promoted? (true: a manual promote, the old host unreachable)}.
 * append() also refuses a serialized line over LOG_LINE_MAX_BYTES.
 */

import { NAME_RE } from '../text.ts';
import { ENTRY_TEXT_MAX_BYTES, ENTRY_REFS_MAX, ENTRY_STR_MAX, ENTRY_LIST_MAX } from '../config.ts';
import type { EntryInput, HostFields, Kind, TaskFields, TaskOp, Validated, ValidateOpts, Via } from './types.ts';

const AGENT_KINDS: readonly string[] = ['say', 'question', 'status', 'proposal', 'task_req'];
const HUMAN_KINDS: readonly string[] = ['say', 'signoff', 'objection', 'proposal'];
const SYSTEM_ONLY_KINDS: readonly string[] = ['decision', 'member_joined', 'member_left', 'task', 'host_changed'];
const TASK_OPS: readonly string[] = ['add', 'claim', 'release', 'done'];
const SYSTEM_KINDS = [...SYSTEM_ONLY_KINDS, 'status'];
const KINDS = [...new Set([...AGENT_KINDS, ...HUMAN_KINDS, ...SYSTEM_KINDS])];
const KINDS_BY_VIA: Record<Via, readonly string[]> = { agent: AGENT_KINDS, human: HUMAN_KINDS, system: SYSTEM_KINDS };
const VIAS: readonly string[] = ['human', 'agent', 'system'];
const isVia = (v: unknown): v is Via => VIAS.includes(v as string);
const isKind = (k: unknown): k is Kind => KINDS.includes(k as string);
const isTaskOp = (op: unknown): op is TaskOp => TASK_OPS.includes(op as string);
/** a hash a caller may name: 6-64 hex (a proposal's is 12, lib/text.ts HASH_RE; older logs hold longer ones) */
const HASH_ARG_RE = /^[0-9a-f]{6,64}$/;
const HOST_FIELDS = ['epoch', 'host', 'locator', 'accept', 'ask', 'promoted'];
const TASK_FIELDS = ['op', 'task_id', 'subject', 'detail', 'evidence', 'owner', 'status', 'req', 'blockedBy'];
const ENTRY_FIELDS = new Set(['kind', 'text', 'to', 'refs', 'hash', 'approvers', 'same', 'path', 'proposal_hash', 'normalized',
  'edit_path', 'drafted', 'id', 'by', 'pubkey', 'machine', ...HOST_FIELDS, ...TASK_FIELDS]);
const TASK_KINDS = ['task_req', 'task'];
const PEM_RE = /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]{1,512}-----END PUBLIC KEY-----\n$/;
const MACHINE_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A room error, code: INVALID | RATE | LOCK | NO_ROOM | AUTH | STALE | HOST_ONLY, and over a link the protocol's codes
 * (lib/remote/protocol.ts CODES: OFFLINE, FORK, PROTOCOL, ...). unknown: an OFFLINE whose op went out (it may land).
 */
class RoomError extends Error {
  declare code: string;
  declare unknown?: boolean;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

function bad(msg: string): never { throw new RoomError('INVALID', msg); }

function validate(entry: EntryInput, opts: ValidateOpts): Validated {
  if (!entry || typeof entry !== 'object') bad('entry must be an object');
  const fields: Record<string, unknown> = entry; // every key is checked below
  for (const k of Object.keys(entry)) {
    if (!ENTRY_FIELDS.has(k)) bad(`field "${k}" is not settable by callers`);
  }
  const via = opts.via || (opts.system === true ? 'system' : undefined);
  const { kind, to = 'room', refs, hash, approvers, path: ppath, proposal_hash, normalized, edit_path, drafted, pubkey, machine } = entry;
  const isTask = TASK_KINDS.includes(kind);
  if (entry.id !== undefined && !isTask) bad('field "id" is not settable by callers');
  if (entry.by !== undefined && !(kind === 'task_req' && entry.by === opts.from)) bad('field "by" is not settable by callers (task_req stamps it)');
  for (const k of TASK_FIELDS) if (fields[k] !== undefined && !isTask) bad(`field "${k}" is only for task_req and task entries`);
  const task = isTask ? taskFields(kind, entry) : null;
  const text = entry.text === undefined && task ? taskText(kind, task) : entry.text;
  const bareAnswer = entry.text === undefined && (kind === 'signoff' || (kind === 'objection' && via === 'human'));
  if (typeof opts.from !== 'string' || !NAME_RE.test(opts.from)) bad(`invalid from "${opts.from}"`);
  if (!isVia(via)) bad(`via must be one of ${VIAS.join(', ')}`);
  if (!isKind(kind)) bad(`unknown kind "${kind}". Use one of: ${KINDS_BY_VIA[via].join(', ')}`);
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
    if (v !== undefined && (typeof v !== 'string' || !HASH_ARG_RE.test(v))) bad(`${k} must be 6-64 lowercase hex chars`);
  }
  if (approvers !== undefined && (!Array.isArray(approvers) || !approvers.every(a => typeof a === 'string' && NAME_RE.test(a)))) {
    bad('approvers must be an array of names');
  }
  if (approvers !== undefined && approvers.length > ENTRY_LIST_MAX) bad(`too many approvers (${approvers.length}; the limit is ${ENTRY_LIST_MAX})`);
  const same = sameField(kind, entry.same, approvers);
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
  if (kind !== 'member_joined' && pubkey !== undefined) bad('pubkey is only for member_joined');
  if (kind !== 'member_joined' && kind !== 'host_changed' && machine !== undefined) bad('machine is only for member_joined and host_changed');
  const host = hostFields(kind, entry);
  if (pubkey !== undefined && (typeof pubkey !== 'string' || !PEM_RE.test(pubkey))) bad('pubkey must be a PEM public key');
  if (machine !== undefined && (typeof machine !== 'string' || !MACHINE_RE.test(machine))) bad('invalid machine id');
  return { via, kind, text, to, refs, hash, approvers, same, path: ppath, proposal_hash, normalized, edit_path, drafted, task, pubkey, machine, host };
}

/** A proposal's same groups, checked: disjoint groups of 2+ of its approvers, ENTRY_LIST_MAX names in all. */
function sameField(kind: string, same: unknown, approvers: string[] | undefined): string[][] | undefined {
  if (same === undefined) return undefined;
  if (kind !== 'proposal') bad('same is only for proposals');
  if (!Array.isArray(same) || !same.every(g => Array.isArray(g) && g.length >= 2 && g.every(n => typeof n === 'string' && NAME_RE.test(n)))) {
    bad('same must be an array of groups of 2 or more names');
  }
  const names = (same as string[][]).flat();
  if (names.length > ENTRY_LIST_MAX) bad(`too many names in same (${names.length}; the limit is ${ENTRY_LIST_MAX})`);
  if (new Set(names).size !== names.length) bad('same names a seat twice');
  if (!names.every(n => approvers && approvers.includes(n))) bad('same names only approvers');
  return same as string[][];
}

const PROOF_MAX = 4096; // a signed acceptance or request, as JSON
/** The host_changed fields, checked (null for another kind, which may carry none of them). */
function hostFields(kind: string, entry: EntryInput): HostFields | null {
  if (kind !== 'host_changed') {
    for (const k of HOST_FIELDS) if ((entry as Record<string, unknown>)[k] !== undefined) bad(`field "${k}" is only for host_changed`);
    return null;
  }
  const { epoch, host, machine, locator, accept, ask, promoted } = entry;
  if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 1) bad('host_changed needs epoch, a positive integer');
  if (typeof host !== 'string' || !NAME_RE.test(host)) bad('host_changed needs host, the new host\'s seat name');
  if (typeof machine !== 'string' || !MACHINE_RE.test(machine)) bad('host_changed needs the new host\'s machine id');
  if (typeof locator !== 'string' || !locator || locator.length > 1024) bad('host_changed needs locator');
  for (const [k, v] of [['accept', accept], ['ask', ask]]) {
    if (v === undefined) continue;
    if (!v || typeof v !== 'object' || Array.isArray(v) || JSON.stringify(v).length > PROOF_MAX) bad(`invalid ${k}`);
  }
  if (promoted !== undefined && promoted !== true) bad('promoted must be true');
  const out: HostFields = { epoch, host, locator };
  if (accept !== undefined) out.accept = accept;
  if (ask !== undefined) out.ask = ask;
  if (promoted) out.promoted = true;
  return out;
}

const taskIdOk = (v: unknown): v is string | number => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(v)) || (typeof v === 'number' && Number.isInteger(v) && v > 0);
const optStr = (k: string, v: unknown, max: number): void => { if (v !== undefined && (typeof v !== 'string' || v.length > max)) bad(`${k} must be a string of at most ${max} chars`); };

/** The task fields of a task_req / task entry, checked; the caller's `id` (the task id) becomes task_id. */
function taskFields(kind: string, entry: EntryInput): TaskFields {
  const t: TaskFields = {};
  const fields: Record<string, unknown> = entry;
  const tid = entry.task_id !== undefined ? entry.task_id : entry.id;
  if (tid !== undefined) { if (!taskIdOk(tid)) bad('the task id must be a positive integer or a short id string'); t.task_id = String(tid); }
  if (entry.op !== undefined) t.op = entry.op;
  if (kind === 'task_req') {
    if (!isTaskOp(t.op)) bad(`task_req op must be one of: ${TASK_OPS.join(', ')}`);
    if (t.op === 'add' && !(typeof entry.subject === 'string' && entry.subject.trim())) bad('add needs a subject');
    if (t.op !== 'add' && t.task_id === undefined) bad(`${t.op} needs the task id`);
    if (t.op === 'done' && !(typeof entry.evidence === 'string' && entry.evidence.trim())) bad('done needs evidence');
  } else if (t.op !== undefined && (typeof t.op !== 'string' || !/^[a-z_]{1,20}$/.test(t.op))) bad('invalid task op');
  optStr('subject', entry.subject, 500);
  optStr('detail', entry.detail, 4000);
  optStr('evidence', entry.evidence, 4000);
  optStr('status', entry.status, 32);
  const owner = entry.owner;
  if (owner !== undefined && owner !== null && !(typeof owner === 'string' && NAME_RE.test(owner))) bad(`invalid owner "${owner}"`);
  if (entry.req !== undefined && !(Number.isInteger(entry.req) && entry.req > 0)) bad('req must be a log id');
  if (entry.blockedBy !== undefined && !(Array.isArray(entry.blockedBy) && entry.blockedBy.every(taskIdOk))) bad('blockedBy must be task ids');
  if (entry.blockedBy !== undefined && entry.blockedBy.length > ENTRY_LIST_MAX) bad(`too many blockedBy ids (the limit is ${ENTRY_LIST_MAX})`);
  // each was checked above (a string, a name, a log id)
  for (const k of ['subject', 'detail', 'evidence', 'status', 'owner', 'req'] as const) if (fields[k] !== undefined && fields[k] !== null) (t as Record<string, unknown>)[k] = fields[k];
  if (entry.blockedBy !== undefined) t.blockedBy = entry.blockedBy.map(String);
  return t;
}

/** "claim #2 parser tests" / "#2 parser tests: in_progress, owner bob": the default text of a task entry. */
function taskText(kind: string, t: TaskFields): string {
  const id = t.task_id ? `#${t.task_id}` : '';
  const head = [t.op, id, t.subject].filter(Boolean).join(' ');
  if (kind === 'task_req') return head + (t.op === 'done' && t.evidence ? `; evidence: ${t.evidence}` : '');
  const tail = [t.status, t.owner && `owner ${t.owner}`].filter(Boolean).join(', ');
  return (head || 'task') + (tail ? `: ${tail}` : '');
}

export { RoomError, validate };
