// One valibot schema per shape read from outside (disk, the wire). Each schema is typed against entries.ts, so a schema
// that drifts from its type fails the typecheck. v.object drops fields it doesn't know: a newer writer's extra fields
// are tolerated (R33), while a missing or mistyped field is refused.
import * as v from '../vendor/valibot.mjs';
import type {
  ActivityDoc, DocKind, DocKinds, Entry, FocusDoc, LogState, MemberRecord, Plan, PresenceDoc, SentPlan,
  Snapshot, Task, Update,
} from './entries.js';
import { LIMITS } from './entries.js';
import type { Result } from './result.js';
import { err, ok } from './result.js';

type Schema<T> = v.GenericSchema<unknown, T>;

// Ties a schema to its type both ways: a field the type has and the schema lacks (even an optional one) fails the
// typecheck, as does the reverse. Arrays compare as readonly, since that is all the difference valibot's output has.
type Deep<T> = T extends readonly (infer U)[] ? readonly Deep<U>[] : T extends object ? { readonly [K in keyof T]: Deep<T[K]> } : T;
type Same<A, B> = (<X>() => X extends Deep<A> ? 1 : 2) extends (<X>() => X extends Deep<B> ? 1 : 2) ? true : false;
const exact = <T>() => <S extends Schema<T>>(schema: S, _same: Same<v.InferOutput<S>, T>): Schema<T> => schema;

const count = v.pipe(v.number(), v.integer(), v.minValue(0));
const name = v.pipe(v.string(), v.minLength(1), v.maxLength(LIMITS.name));
const short = v.pipe(v.string(), v.maxLength(LIMITS.short));
const text = v.pipe(v.string(), v.maxLength(LIMITS.text));
const names = v.pipe(v.array(name), v.maxLength(LIMITS.names));
const files = v.pipe(v.array(short), v.maxLength(LIMITS.files));
const opt = v.exactOptional;

const envelope = {
  seq: v.pipe(count, v.minValue(1)),
  id: short,
  at: count,
  prev: short,
  from: name,
  by: v.picklist(['person', 'claude', 'system']),
  machine: short,
};
const ref = { name, version: v.pipe(count, v.minValue(1)) };
const where = { repo: opt(short), branch: opt(short) };
const answer = v.picklist(['agree', 'changes']);
const acceptance = v.picklist(['accept', 'dismiss', 'changes']);
const scope = v.picklist(['group', 'personal']);

const task = exact<Task>()(v.object({
  n: v.pipe(count, v.minValue(1)),
  title: short,
  status: v.picklist(['open', 'claimed', 'done']),
  addedBy: name,
  owner: opt(name),
  blockedBy: v.pipe(v.array(count), v.maxLength(LIMITS.names)),
  note: opt(text),
  plan: opt(v.object(ref)),
}), true);

const activity = v.object({
  ...envelope, ...where, kind: v.literal('activity'),
  event: v.picklist(['commit', 'push', 'test', 'build', 'task']), text, ok: opt(v.boolean()),
});
const finding = v.object({ ...envelope, kind: v.literal('finding'), text });
const post = v.object({ ...envelope, kind: v.literal('post'), text, to: opt(name) });

const entry = exact<Entry>()(v.variant('kind', [
  v.object({ ...envelope, ...where, kind: v.literal('joined') }),
  v.object({ ...envelope, kind: v.literal('left') }),
  activity, finding, post,
  v.object({ ...envelope, ...ref, kind: v.literal('plan'), hash: short, base: count, scope }),
  v.object({ ...envelope, ...ref, kind: v.literal('plan_ask'), people: names }),
  v.object({ ...envelope, ...ref, kind: v.literal('plan_answer'), answer, note: opt(text) }),
  v.object({ ...envelope, ...ref, kind: v.literal('decision'), agreed: names, changes: names }),
  v.object({ ...envelope, ...ref, kind: v.literal('plan_sent'), to: opt(name), branch: opt(short), files, note: opt(text) }),
  v.object({ ...envelope, ...ref, kind: v.literal('plan_accept'), answer: acceptance, note: opt(text) }),
  v.object({ ...envelope, kind: v.literal('task'), task }),
  v.object({ ...envelope, kind: v.literal('invite'), invite: short, name, expires: count }),
  v.object({ ...envelope, kind: v.literal('admit'), invite: short, name, link: short }),
  v.object({ ...envelope, kind: v.literal('kick'), name }),
]), true);

const docs: { readonly [K in DocKind]: Schema<DocKinds[K]> } = {
  presence: exact<PresenceDoc>()(v.object({ name, state: v.picklist(['working', 'idle', 'away']), waiting: opt(v.boolean()), machine: opt(short), at: count }), true),
  activity: exact<ActivityDoc>()(v.object({ name, files, at: count }), true),
  focus: exact<FocusDoc>()(v.object({ name, text: short, ...where, at: count }), true),
};

const member = exact<MemberRecord>()(v.object({ name, machine: opt(short), since: count, ...where, kicked: v.boolean() }), true);
const plan = exact<Plan>()(v.object({
  name, scope,
  versions: v.array(v.object({
    version: count, hash: short, base: count, from: name, at: count, asked: names,
    answers: v.array(v.object({ name, answer, note: opt(text) })),
    decision: opt(v.object({ agreed: names, changes: names, at: count })),
  })),
}), true);
const sent = exact<SentPlan>()(v.object({
  ...ref, from: name, at: count, to: opt(name), branch: opt(short), files, note: opt(text),
  answers: v.array(v.object({ name, answer: acceptance, note: opt(text) })),
}), true);
const update = exact<Update>()(v.variant('kind', [activity, finding, post]), true);
const state = exact<LogState>()(v.object({
  seq: count, hash: short,
  members: v.array(member), plans: v.array(plan), sent: v.array(sent), tasks: v.array(task), recent: v.array(update),
}), true);
const snapshot = exact<Snapshot>()(v.object({ v: v.literal(1), state }), true);

/** `input` through `schema`, or its first issue and where. */
export function decode<T>(schema: Schema<T>, input: unknown): Result<T> {
  const r = v.safeParse(schema, input);
  if (r.success) return ok(r.output);
  const issue = r.issues[0];
  const at = issue.path?.map(p => String(p.key)).join('.') ?? '';
  return err(at ? `${at}: ${issue.message}` : issue.message);
}

/** JSON text through `schema`: text that isn't JSON is refused as a wrong shape is. */
export function parseJson<T>(schema: Schema<T>, text: string): Result<T> {
  let json: unknown;
  try { json = JSON.parse(text); } catch { return err('not JSON'); }
  return decode(schema, json);
}

export function decodeEntry(input: unknown): Result<Entry> { return decode(entry, input); }
export function decodeDoc<K extends DocKind>(kind: K, input: unknown): Result<DocKinds[K]> { return decode(docs[kind], input); }
export function decodeSnapshot(input: unknown): Result<Snapshot> { return decode(snapshot, input); }
export function parseSnapshot(text: string): Result<Snapshot> { return parseJson(snapshot, text); }
export function parseDoc<K extends DocKind>(kind: K, text: string): Result<DocKinds[K]> { return parseJson(docs[kind], text); }
