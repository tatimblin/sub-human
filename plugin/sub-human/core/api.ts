// The daemon's socket API (ARCHITECTURE §5): every write in the home goes through one node daemon on `<home>/daemon.sock`.
// A caller POSTs one JSON request to http://daemon/ over that socket and gets one Result back, `{ok, value}` or
// `{ok: false, error}` with a one-line error. The module builds the call with module/bridge.ts; node uses
// net/daemon/client.ts. Pure, so both load it.
//
//   append   {code, draft}             → {seq, hash}  draft.id is the caller's UUID, made once per draft and reused
//                                                     only to retry that same draft: a repeat answers the first
//                                                     {seq, hash} and writes nothing, whatever else it carries
//   plan     {code, from, act, …}      → {seq, hash, latest} | {refused, latest}  edit (CAS on base), ask, answer,
//                                                     send, accept, by core/plans.ts; a refused edit names the latest
//   task     {code, from, act, …}      → {seq, hash, n}  add, claim, release, done, by core/tasks.ts
//   put_doc  {code, kind, name, doc}   → null         a member's presence, activity or focus document
//   put_blob {code, text}              → {hash}       plan text, stored by its hash
//   join     {id, cwd, name, code?, repo?, branch?, leave} → {code, title, opened, others} | {rooms}  a bare
//                                                     /sub-human, on one chain: the room asked for, else the room this
//                                                     cwd last used while NAME is a member, else the one open room (a
//                                                     member present), else a new one; several open: {rooms}, and no
//                                                     join. `joined` only when NAME isn't a member; then presence idle,
//                                                     and the pointer <home>/sessions/ID.json with the lowest NAME.CODE
//                                                     title no pointer here holds
//   leave    {id}                      → null         /sub-human leave: `left` (under the pointer's leave id) and presence
//                                                     away, unless another pointer or pending handoff holds the name;
//                                                     then the pointer goes
//   retire   {id}                      → null         the session ended: the pointer goes and the member is away, unless
//                                                     held live elsewhere; never a `joined` or `left`
//   handoff  {id, cwd}                 → null         /clear or /resume: moves the pointer aside for the next session in cwd
//   claim    {id, cwd}                 → {pointer}    the next session takes the oldest handoff under HANDOFF_MS old, else
//                                                     null; the member of one gone stale is away
//   ping     {session, code?, name?,   → null         `session` is the session id (it keeps that pointer fresh); with
//             cc?}                                    code and name, this session is NAME in CODE, for messages; `cc` is
//                                                     the Claude Code version it runs, for doctor
//   message  {code, to, from, text}    → null         private Claude-to-Claude: into the recipient's inbox, never the log
//   inbox    {session}                 → {messages}   takes this session's messages in all its rooms, once
//   status   {}                        → {version, pid, sessions, cc}  cc: the Claude Code versions live sessions run
//
// Across machines (net/, U15):
//   invite   {code, from, name, via}   → {line}       a line for NAME (via public, tailnet or ssh); starts the listener
//   asks     {session}                 → {asks}       who waits to be let into this session's rooms, and any line
//                                                     dialled twice; module/admit.ts shows each as a card
//   admit    {session, code, id, answer}  → null      a session's answer to an ask of its room: let_in or refuse,
//                                                     or kick the member a leaked line let in
//   kick     {code, from, name}        → null         NAME is out for good; their link is cut at once
//   dial     {line, name}              → {code, check}  dials the line's host and proves the line; the host's answer
//                                                     comes later (link)
//   link     {code}                    → {phase, why} | null  how this machine's link to a room hosted elsewhere is
//                                                     doing; waiting until the host lets it in
// An append to a room hosted elsewhere while its host is away answers seq 0 for a person's post, queued for a while
// under its id; every other write there fails at once.
//
// Every request keeps the daemon up; it exits after a minute with none.
import * as v from '../vendor/valibot.mjs';
import type { Acceptance, ActivityDoc, Answer, Entry, FocusDoc, PlanScope, PresenceDoc } from './entries.js';
import { LIMITS } from './entries.js';
import type { Result } from './result.js';
import { err, ok } from './result.js';
import { decodeDoc, decodeEntry } from './schema.js';

/** Bumped when a request or an answer changes shape; status carries it. */
export const API_VERSION = 4;
/** A request body larger than this is refused unread. */
export const MAX_BODY: number = 1024 * 1024;
export const DAEMON_URL: string = 'http://daemon/';

export function socketFile(home: string): string { return `${home}/daemon.sock`; }
/** The longest socket path every platform binds, in bytes (macOS's sun_path holds 104 with its NUL). */
export const SOCKET_MAX = 103;
/** A room code: a word and four digits, `vole-8126`. */
export const CODE: RegExp = /^[a-z]+-\d{4}$/;
/** Where a session finds its room: a Pointer, written by the join op. `id` is a SESSION_ID. */
export function sessionFile(home: string, id: string): string { return `${home}/sessions/${id}.json`; }
/** Where a session ending for /clear or /resume leaves its pointer for the next one in its cwd (by the cwd's hash). */
export function handoffFile(home: string, cwdHash: string): string { return `${home}/handoff/${cwdHash}.json`; }
/** The room a cwd last joined, `{code}`, by the cwd's hash. */
export function lastFile(home: string, cwdHash: string): string { return `${home}/last/${cwdHash}.json`; }
/** How long a handoff waits for the next session to claim it. */
export const HANDOFF_MS = 30_000;
/** How often a session's module pings the daemon. */
export const PING_MS = 20_000;
/**
 * A session is live while the daemon has seen it ping this recently (three pings). One it has never seen ping (its
 * module is off, or not up yet) counts as live until the day-old sweep.
 */
export const LIVE_MS: number = 3 * PING_MS;
/** A session id safe as a file name (Claude Code's are UUIDs). */
export const SESSION_ID: RegExp = /^[A-Za-z0-9_-]{1,128}$/;
/** `title` is the session's NAME.CODE, given once at the join; `leave` is the id its `left` entry will carry. */
export interface Pointer { readonly code: string; readonly name: string; readonly title: string; readonly leave: string }
/** A pointer handed on, and when. */
export interface Handoff extends Pointer { readonly at: number }
/** A session pointer as the module reads it, or null when it is not one. */
export function decodePointer(text: string): Pointer | null {
  try {
    const r = v.safeParse(v.object(pointerFields()), JSON.parse(text));
    return r.success ? r.output : null;
  } catch { return null; }
}
/** A cwd's handoffs, oldest first; a file that doesn't read holds none. */
export function decodeHandoffs(text: string): Handoff[] {
  try {
    const r = v.safeParse(v.array(v.object({ ...pointerFields(), at: v.number() })), JSON.parse(text));
    return r.success ? r.output : [];
  } catch { return []; }
}
/** How to start the daemon: node's absolute path, the plugin's root and the home. It detaches itself. */
export function daemonArgv(node: string, plugin: string, home: string): string[] {
  return [node, '--import', `${plugin}/resolve-ts.ts`, `${plugin}/net/daemon.ts`, home];
}

type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An entry as a caller sends it: the host stamps seq, at, prev and machine; `id` is the caller's. */
export type AppendDraft = Without<Entry, 'seq' | 'at' | 'prev' | 'machine'>;
/** The documents a member writes about itself; `members` is the host's. */
export type MemberDocKind = 'presence' | 'activity' | 'focus';
export interface Message { readonly code: string; readonly from: string; readonly text: string; readonly at: number }
export interface Status { readonly version: number; readonly pid: number; readonly sessions: number; readonly cc: readonly string[] }
export interface Version { readonly version: number; readonly hash: string }

export type PlanAct =
  | { readonly act: 'edit'; readonly name: string; readonly base: number; readonly text: string; readonly scope?: PlanScope }
  | { readonly act: 'ask'; readonly name: string; readonly version: number; readonly people: readonly string[] }
  | { readonly act: 'answer'; readonly name: string; readonly version: number; readonly answer: Answer; readonly note?: string }
  | { readonly act: 'send'; readonly name: string; readonly version?: number; readonly to?: string; readonly note?: string; readonly branch?: string; readonly files?: readonly string[] }
  | { readonly act: 'accept'; readonly name: string; readonly version: number; readonly answer: Acceptance; readonly note?: string };
export type TaskAct =
  | { readonly act: 'add'; readonly title: string; readonly blockedBy?: readonly number[] }
  | { readonly act: 'claim' | 'release'; readonly n: number }
  | { readonly act: 'done'; readonly n: number; readonly note?: string };
interface Writer { readonly code: string; readonly from: string }
/** How an invite line reaches this machine: Tailscale Funnel, Tailscale Serve, or the joiner's own ssh login. */
export type Via = 'public' | 'tailnet' | 'ssh';
/**
 * A dial for the host: a joiner to let in (admit); or a line dialled a second time, both dials refused: before anyone
 * was let in with it (again), or after `name` was (leaked, and the card offers to kick them).
 */
export interface Ask {
  readonly id: string;
  readonly code: string;
  readonly kind: 'admit' | 'again' | 'leaked';
  /** The name the joiner gave, and the name the invite was for. */
  readonly name: string;
  readonly expected: string;
  readonly machine: string;
  readonly check: string;
  /** Whether `name` is already a member of the room. */
  readonly member: boolean;
}
export type LinkPhase = 'waiting' | 'connecting' | 'online' | 'offline' | 'host_away' | 'stopped';
export interface LinkStatus { readonly phase: LinkPhase; readonly why: string | null }

export type Request =
  | { readonly op: 'append'; readonly code: string; readonly draft: AppendDraft }
  | ({ readonly op: 'plan' } & Writer & PlanAct)
  | ({ readonly op: 'task' } & Writer & TaskAct)
  | { readonly op: 'put_doc'; readonly code: string; readonly kind: MemberDocKind; readonly name: string; readonly doc: PresenceDoc | ActivityDoc | FocusDoc }
  | { readonly op: 'put_blob'; readonly code: string; readonly text: string }
  | {
    readonly op: 'join'; readonly id: string; readonly cwd: string; readonly name: string; readonly leave: string;
    readonly code?: string; readonly repo?: string; readonly branch?: string;
  }
  | { readonly op: 'leave'; readonly id: string }
  | { readonly op: 'retire'; readonly id: string }
  | { readonly op: 'handoff'; readonly id: string; readonly cwd: string }
  | { readonly op: 'claim'; readonly id: string; readonly cwd: string }
  | { readonly op: 'ping'; readonly session: string; readonly code?: string; readonly name?: string; readonly cc?: string }
  | { readonly op: 'message'; readonly code: string; readonly to: string; readonly from: string; readonly text: string }
  | { readonly op: 'inbox'; readonly session: string }
  | { readonly op: 'status' }
  | ({ readonly op: 'invite'; readonly name: string; readonly via: Via } & Writer)
  | { readonly op: 'asks'; readonly session: string }
  | { readonly op: 'admit'; readonly session: string; readonly code: string; readonly id: string; readonly answer: 'let_in' | 'refuse' | 'kick' }
  | ({ readonly op: 'kick'; readonly name: string } & Writer)
  | { readonly op: 'dial'; readonly line: string; readonly name: string }
  | { readonly op: 'link'; readonly code: string };
export type Op = Request['op'];
/** The ops net/ answers (the host's side and the links); every other op is the rooms'. */
export type NetOp = 'invite' | 'asks' | 'admit' | 'kick' | 'dial' | 'link';
export type NetRequest = Extract<Request, { readonly op: NetOp }>;
export type RoomRequest = Exclude<Request, { readonly op: NetOp }>;
export interface Answers {
  append: { readonly seq: number; readonly hash: string };
  plan: { readonly seq: number; readonly hash: string; readonly latest: Version | null } | { readonly refused: string; readonly latest: Version | null };
  task: { readonly seq: number; readonly hash: string; readonly n: number };
  put_doc: null;
  put_blob: { readonly hash: string };
  join: { readonly code: string; readonly title: string; readonly opened: boolean; readonly others: readonly string[] } | { readonly rooms: readonly string[] };
  leave: null;
  retire: null;
  handoff: null;
  claim: { readonly pointer: Pointer | null };
  ping: null;
  message: null;
  inbox: { readonly messages: readonly Message[] };
  status: Status;
  invite: { readonly line: string };
  asks: { readonly asks: readonly Ask[] };
  admit: null;
  kick: null;
  dial: { readonly code: string; readonly check: string };
  link: LinkStatus | null;
}

const name = v.pipe(v.string(), v.minLength(1), v.maxLength(LIMITS.name));
const short = v.pipe(v.string(), v.maxLength(LIMITS.short));
const session = v.pipe(v.string(), v.minLength(1), v.maxLength(LIMITS.short));
const sessionId = v.pipe(v.string(), v.regex(SESSION_ID));
const count = v.pipe(v.number(), v.integer(), v.minValue(0));
const version = v.pipe(count, v.minValue(1));
const text = v.pipe(v.string(), v.maxLength(LIMITS.text));
const blob = v.pipe(v.string(), v.maxLength(MAX_BODY / 2));
const opt = v.exactOptional;
function pointerFields() {
  return { code: name, name, title: v.pipe(v.string(), v.minLength(1), v.maxLength(LIMITS.short)), leave: v.pipe(v.string(), v.uuid()) };
}
const writer = { code: name, from: name };
const note = opt(text);

const request = v.variant('op', [
  v.object({ op: v.literal('append'), code: name, draft: v.looseObject({ id: v.pipe(v.string(), v.uuid()) }) }),
  v.variant('act', [
    v.object({ op: v.literal('plan'), ...writer, act: v.literal('edit'), name, base: count, text: blob, scope: opt(v.picklist(['group', 'personal'])) }),
    v.object({ op: v.literal('plan'), ...writer, act: v.literal('ask'), name, version, people: v.pipe(v.array(name), v.maxLength(LIMITS.names)) }),
    v.object({ op: v.literal('plan'), ...writer, act: v.literal('answer'), name, version, answer: v.picklist(['agree', 'changes']), note }),
    v.object({
      op: v.literal('plan'), ...writer, act: v.literal('send'), name, version: opt(version), to: opt(name), note,
      branch: opt(v.string()), files: opt(v.array(v.string())),
    }),
    v.object({ op: v.literal('plan'), ...writer, act: v.literal('accept'), name, version, answer: v.picklist(['accept', 'dismiss', 'changes']), note }),
  ]),
  v.variant('act', [
    v.object({ op: v.literal('task'), ...writer, act: v.literal('add'), title: v.string(), blockedBy: opt(v.array(count)) }),
    v.object({ op: v.literal('task'), ...writer, act: v.picklist(['claim', 'release']), n: version }),
    v.object({ op: v.literal('task'), ...writer, act: v.literal('done'), n: version, note: opt(v.string()) }),
  ]),
  v.object({ op: v.literal('put_doc'), code: name, kind: v.picklist(['presence', 'activity', 'focus']), name, doc: v.unknown() }),
  v.object({ op: v.literal('put_blob'), code: name, text: blob }),
  v.object({
    op: v.literal('join'), id: sessionId, cwd: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)), name,
    leave: v.pipe(v.string(), v.uuid()), code: opt(v.pipe(v.string(), v.regex(CODE))), repo: opt(short), branch: opt(short),
  }),
  v.object({ op: v.literal('leave'), id: sessionId }),
  v.object({ op: v.literal('retire'), id: sessionId }),
  v.object({ op: v.literal('handoff'), id: sessionId, cwd: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)) }),
  v.object({ op: v.literal('claim'), id: sessionId, cwd: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)) }),
  v.object({ op: v.literal('ping'), session, code: opt(name), name: opt(name), cc: opt(name) }),
  v.object({ op: v.literal('message'), code: name, to: name, from: name, text }),
  v.object({ op: v.literal('inbox'), session }),
  v.object({ op: v.literal('status') }),
  v.object({ op: v.literal('invite'), ...writer, name, via: v.picklist(['public', 'tailnet', 'ssh']) }),
  v.object({ op: v.literal('asks'), session }),
  v.object({ op: v.literal('admit'), session, code: name, id: name, answer: v.picklist(['let_in', 'refuse', 'kick']) }),
  v.object({ op: v.literal('kick'), ...writer, name }),
  v.object({ op: v.literal('dial'), line: v.pipe(v.string(), v.maxLength(LIMITS.short)), name }),
  v.object({ op: v.literal('link'), code: name }),
]);

const placed = { seq: count, hash: v.string() };
const latest = v.nullable(v.object({ version, hash: v.string() }));
const answers: { readonly [O in Op]: v.GenericSchema<unknown, Answers[O]> } = {
  append: v.object(placed),
  plan: v.union([v.object({ ...placed, latest }), v.object({ refused: v.string(), latest })]),
  task: v.object({ ...placed, n: version }),
  put_doc: v.null(),
  put_blob: v.object({ hash: v.string() }),
  join: v.union([
    v.object({ code: v.string(), title: v.string(), opened: v.boolean(), others: v.array(v.string()) }),
    v.object({ rooms: v.array(v.string()) }),
  ]),
  leave: v.null(),
  retire: v.null(),
  handoff: v.null(),
  claim: v.object({ pointer: v.nullable(v.object(pointerFields())) }),
  ping: v.null(),
  message: v.null(),
  inbox: v.object({ messages: v.array(v.object({ code: name, from: name, text, at: count })) }),
  status: v.object({ version: count, pid: count, sessions: count, cc: v.array(v.string()) }),
  invite: v.object({ line: v.string() }),
  asks: v.object({ asks: v.array(v.object({
    id: name, code: name, kind: v.picklist(['admit', 'again', 'leaked']), name, expected: name, machine: v.string(), check: v.string(), member: v.boolean(),
  })) }),
  admit: v.null(),
  kick: v.null(),
  dial: v.object({ code: name, check: v.string() }),
  link: v.nullable(v.object({
    phase: v.picklist(['waiting', 'connecting', 'online', 'offline', 'host_away', 'stopped']), why: v.nullable(v.string()),
  })),
};
const envelope = v.variant('ok', [v.object({ ok: v.literal(true), value: v.unknown() }), v.object({ ok: v.literal(false), error: v.string() })]);

function decode<T>(schema: v.GenericSchema<unknown, T>, input: unknown): Result<T> {
  const r = v.safeParse(schema, input);
  if (r.success) return ok(r.output);
  const at = r.issues[0].path?.map(p => String(p.key)).join('.') ?? '';
  return err(at ? `${at}: ${r.issues[0].message}` : r.issues[0].message);
}

/** An entry as its writer sent it, through the entry schema; any stamps of the host's it carries come off. */
export function decodeAppendDraft(input: unknown): Result<AppendDraft> {
  // the host's stamps go in last, so a caller's own are overwritten, then come off again
  const e = decodeEntry({ ...(typeof input === 'object' ? input : {}), seq: 1, at: 0, prev: '', machine: '-' });
  if (!e.ok) return e;
  const { seq: _s, at: _a, prev: _p, machine: _m, ...draft } = e.value;
  return ok(draft);
}

/** A request as the daemon reads it: the draft and the document through their own schemas. */
export function decodeRequest(input: unknown): Result<Request> {
  const r = decode(request, input);
  if (!r.ok) return err(`request not understood: ${r.error}`);
  const req = r.value;
  if (req.op === 'append') {
    const d = decodeAppendDraft(req.draft);
    return d.ok ? ok({ op: 'append', code: req.code, draft: d.value }) : err(`entry not understood: ${d.error}`);
  }
  if (req.op === 'put_doc') {
    const d = decodeDoc(req.kind, req.doc);
    if (!d.ok) return err(`document not understood: ${d.error}`);
    if (d.value.name !== req.name) return err(`a document of ${d.value.name} can't be stored as ${req.name}'s`);
    return ok({ ...req, doc: d.value });
  }
  return ok(req);
}

/** The daemon's answer to an `op` request, from the response's status and body. */
export function readAnswer<O extends Op>(op: O, status: number, body: string): Result<Answers[O]> {
  let json: unknown;
  try { json = JSON.parse(body); } catch { return err(`the sub-human daemon answered ${status} with no result; nothing was done`); }
  const e = decode(envelope, json);
  if (!e.ok) return err(`the sub-human daemon's answer was not understood; nothing was done`);
  if (!e.value.ok) return err(e.value.error);
  const a = decode(answers[op], e.value.value);
  return a.ok ? a : err(`the sub-human daemon's answer to ${op} was not understood (${a.error})`);
}
