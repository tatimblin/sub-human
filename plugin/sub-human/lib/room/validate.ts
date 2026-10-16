/**
 * plugin/sub-human/lib/room/validate.ts: the room log's envelope rules (envelope v3): which kinds each `via`
 * may write, the fields a caller may set, and the task fields of task_req / task entries. append() (store.ts)
 * runs validate() before it signs, and place() runs it again on the payload before it takes the log lock.
 * Zero dependencies beyond lib/text.ts.
 *
 *   validate(entry, {via, from, system}) -> {via, kind, text, to, refs, hash, approvers, same, path, proposal_hash,
 *       normalized, edit_path, drafted, task, pubkey, machine, host}   throws RoomError INVALID with a message for the model
 *   RoomError(code, message, reason?)   reason: lib/reasons.ts; code: INVALID | RATE | LOCK | NO_ROOM | AUTH (a signature, a replay or a pinned key refused)
 *   parseEntry(e) -> e as a KnownEntry | null   a log line by its kind (no copy); null: a kind a newer host wrote
 *   isKindOf(e, kind) -> bool       a single-kind filter that narrows (EntryOf<kind>)
 *   isEntryId(v), entryId(v) -> EntryId | null   a log line's id (a positive safe integer; entryId reads 22 or "22"),
 *       nextEntryId(last) the one after: the brand's constructors (lib/brand.ts); isTaskId(v), taskId(v) -> TaskId |
 *       null a task's id as stored (a short id string; taskId also reads a positive integer)
 *   AGENT_KINDS HUMAN_KINDS SYSTEM_KINDS SYSTEM_ONLY_KINDS LEGACY_KINDS KINDS TASK_OPS VIAS   the tables, the source of
 *       lib/room/types.ts Kind, LegacyKind, TaskOp and Via; isKind, isVia, isTaskOp their guards
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

import { NAME_RE, isMachineId } from '../text.ts';
import type { Reason } from '../reasons.ts';
import { CODED } from '../errors.ts';
import type { WireCode } from '../remote/types-core.ts';
import { ENTRY_TEXT_MAX_BYTES, ENTRY_REFS_MAX, ENTRY_STR_MAX, ENTRY_LIST_MAX } from '../config.ts';
import type { Entry, EntryInput, EntryOf, HostFields, Kind, KnownEntry, KnownKind, TaskFields, TaskOp, Validated, ValidateOpts, Via } from './types.ts';
import type { EntryId, TaskId } from '../brand.ts';

// The tables are the source of their unions (lib/room/types.ts Via, Kind, LegacyKind, TaskOp), on lib/reasons.ts's
// pattern: a word added here is a member there, and every switch over it must handle it.
const AGENT_KINDS = ['say', 'question', 'status', 'proposal', 'task_req'] as const;
const HUMAN_KINDS = ['say', 'signoff', 'objection', 'proposal'] as const;
const SYSTEM_ONLY_KINDS = ['decision', 'member_joined', 'member_left', 'task', 'host_changed'] as const;
const SYSTEM_KINDS = [...SYSTEM_ONLY_KINDS, 'status'] as const;
/** Kinds only logs from before envelope v3 hold (rules.ts normalize maps all but revoke). */
const LEGACY_KINDS = ['concern', 'agree', 'plan_rev', 'revoke'] as const;
const TASK_OPS = ['add', 'claim', 'release', 'done'] as const;
const VIAS = ['human', 'agent', 'system'] as const;
const KINDS: readonly Kind[] = [...new Set([...AGENT_KINDS, ...HUMAN_KINDS, ...SYSTEM_KINDS])];
const KINDS_BY_VIA: Record<Via, readonly Kind[]> = { agent: AGENT_KINDS, human: HUMAN_KINDS, system: SYSTEM_KINDS };
const VIA_SET: ReadonlySet<unknown> = new Set(VIAS);
const KIND_SET: ReadonlySet<unknown> = new Set(KINDS);
const KNOWN_SET: ReadonlySet<unknown> = new Set([...KINDS, ...LEGACY_KINDS]);
const TASK_OP_SET: ReadonlySet<unknown> = new Set(TASK_OPS);
const SYSTEM_ONLY_SET: ReadonlySet<Kind> = new Set(SYSTEM_ONLY_KINDS);
const isVia = (v: unknown): v is Via => VIA_SET.has(v);
const isKind = (k: unknown): k is Kind => KIND_SET.has(k);
const isTaskOp = (op: unknown): op is TaskOp => TASK_OP_SET.has(op);

/**
 * A log line by its kind, for a reader that branches over several: the entry itself (no copy) as a KnownEntry, whose
 * kind is one this version knows (Kind or LegacyKind), or null for a kind a newer host wrote. The reader handles null
 * (its graceful default), then switches on the kind and ends in assertNever. Only the kind is checked: each kind's
 * other fields are as optional as Entry's, since an older or hand-edited log may lack them.
 */
const parseEntry = <E extends Entry>(e: E): (E & KnownEntry) | null => (isKnown(e) ? e : null);
function isKnown<E extends Entry>(e: E): e is E & KnownEntry { return KNOWN_SET.has(e.kind); }
/** A single-kind filter that narrows: isKindOf(e, 'say') is e.kind === 'say', typed EntryOf<'say'>. */
const isKindOf = <K extends KnownKind, E extends Entry>(e: E | null | undefined, kind: K): e is E & EntryOf<K> => !!e && e.kind === kind;

/** a hash a caller may name: 6-64 hex (a proposal's is 12, lib/text.ts HASH_RE; older logs hold longer ones) */
const HASH_ARG_RE = /^[0-9a-f]{6,64}$/;
const HOST_FIELDS = ['epoch', 'host', 'locator', 'accept', 'ask', 'promoted'];
const TASK_FIELDS = ['op', 'task_id', 'subject', 'detail', 'evidence', 'owner', 'status', 'req', 'blockedBy'];
const ENTRY_FIELDS = new Set(['kind', 'text', 'to', 'refs', 'hash', 'approvers', 'same', 'path', 'proposal_hash', 'normalized',
  'edit_path', 'drafted', 'id', 'by', 'pubkey', 'machine', ...HOST_FIELDS, ...TASK_FIELDS]);
const TASK_KINDS: ReadonlySet<unknown> = new Set(['task_req', 'task']);
const PEM_RE = /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]{1,512}-----END PUBLIC KEY-----\n$/;

/**
 * A room error, code: INVALID | RATE | LOCK | NO_ROOM | AUTH | STALE | HOST_ONLY, and over a link the protocol's codes
 * (lib/remote/protocol.ts CODES, the WireCode union's source: OFFLINE, FORK, PROTOCOL, ...). reason: which one exactly
 * (lib/reasons.ts, REASON_CODE pairs each with its code), for code that decides; the message is for people. unknown: an
 * OFFLINE whose op went out (it may land; reason UNKNOWN_OUTCOME). note: a line for the room beside the refusal (an
 * invite's PIN tries, lib/remote/invites.ts; the server posts it). A CodedError (lib/errors.ts isCoded).
 */
class RoomError extends Error {
  declare code: WireCode;
  declare reason?: Reason;
  declare unknown?: boolean;
  declare note?: string;
  constructor(code: WireCode, message: string, reason?: Reason | null) {
    super(message);
    this.code = code;
    if (reason) this.reason = reason;
    if (reason === 'UNKNOWN_OUTCOME') this.unknown = true;
  }
  get [CODED](): true { return true; }
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
  const isTask = TASK_KINDS.has(kind);
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
  if (SYSTEM_ONLY_SET.has(kind)) {
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
  if (machine !== undefined && !isMachineId(machine)) bad('invalid machine id');
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
  if (!isMachineId(machine)) bad('host_changed needs the new host\'s machine id');
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

const TASK_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const isTaskId = (v: unknown): v is TaskId => typeof v === 'string' && TASK_ID_RE.test(v);
/** A task id as the model sent it (7 or "7"), as it is stored: a string. */
const taskId = (v: unknown): TaskId | null => { const s = typeof v === 'number' && Number.isInteger(v) && v > 0 ? String(v) : v; return isTaskId(s) ? s : null; };
const isEntryId = (v: unknown): v is EntryId => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
/** An entry id as a person or the model typed it (22 or "22"), else null. */
const entryId = (v: unknown): EntryId | null => { const n = Number(v); return isEntryId(n) ? n : null; };
/** The id the store gives the line after last (0: none yet). */
function nextEntryId(last: number): EntryId {
  const id = last + 1;
  if (!isEntryId(id)) throw new RoomError('INVALID', `no entry id follows ${last}`);
  return id;
}
const optStr = (k: string, v: unknown, max: number): void => { if (v !== undefined && (typeof v !== 'string' || v.length > max)) bad(`${k} must be a string of at most ${max} chars`); };

/** The task fields of a task_req / task entry, checked; the caller's `id` (the task id) becomes task_id. */
function taskFields(kind: string, entry: EntryInput): TaskFields {
  const t: TaskFields = {};
  const fields: Record<string, unknown> = entry;
  const tid = entry.task_id !== undefined ? entry.task_id : entry.id;
  if (tid !== undefined) { const id = taskId(tid); if (!id) bad('the task id must be a positive integer or a short id string'); t.task_id = id; }
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
  if (entry.blockedBy !== undefined && !(Array.isArray(entry.blockedBy) && entry.blockedBy.every(b => taskId(b) !== null))) bad('blockedBy must be task ids');
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

export {
  RoomError, validate, parseEntry, isKindOf, isEntryId, entryId, nextEntryId, isTaskId, taskId, isVia, isKind, isTaskOp, KINDS, LEGACY_KINDS, AGENT_KINDS, HUMAN_KINDS, SYSTEM_KINDS, SYSTEM_ONLY_KINDS, TASK_OPS, VIAS };
