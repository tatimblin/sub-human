/**
 * core/protocol.ts: the JSON messages a link and its host exchange inside the channel (ARCHITECTURE §8), one per channel
 * message, discriminated by `t`. Pure: the edges turn bytes into text. Entries and snapshots are the store's own shapes
 * (entries.ts), read through schema.ts.
 *
 * Each side opens with hello {version, min, caps, name, machine}; negotiate() of the two picks the highest version both
 * speak and the caps both have, or says which side must update (R33). Unknown fields are dropped, and a message type
 * this side does not know decodes to null, so a newer peer can add both behind a cap.
 *
 * To the host: append {entry} (the entry as its writer drafted it: the host restamps seq, at, prev and machine, and
 * deduplicates on its id, under which a queued post is re-sent), put_doc, put_blob, subscribe {after_seq, hash},
 * message {to}, and call {id, req}: a plan or task request of core/api.ts, which the host's rules answer. To a link: ack
 * or refused for a write's id, answer {id, value} for a call, snapshot then one lines for a subscribe (a cursor off the
 * host's chain gets the snapshot again: a fork; later lines are live), put_doc and put_blob for a document or plan text
 * the mirror lacks, message from another link, and bye before the host closes it. Both ways: hello, ping, pong.
 */
import * as v from '../vendor/valibot.mjs';
import type { Request } from './api.js';
import { decodeAppendDraft, decodeRequest } from './api.js';
import type { AppendDraft, LogLine, Snapshot } from './entries.js';
import type { Result } from './result.js';
import { err, ok } from './result.js';
import { decodeEntry, decodeSnapshot } from './schema.js';

export const VERSION = 1;
export const MIN_VERSION = 1;
export const CAPS: readonly string[] = [];

/** Why the host closes a link: kicked and refused are for good, host_away until the host is back. */
export type ByeReason = 'kicked' | 'refused' | 'skew' | 'host_away' | 'closed';

export interface Hello { t: 'hello'; version: number; min: number; caps: string[]; name: string; machine: string }
export interface Ping { t: 'ping'; n: number }
export interface Pong { t: 'pong'; n: number }
export interface PutDoc { t: 'put_doc'; id: string; key: string; doc: unknown }
export interface PutBlob { t: 'put_blob'; id: string; hash: string; text: string }
/** A Claude-to-Claude message: `from` is set by the host from the link, never trusted from the sender. */
export interface Message { t: 'message'; to: string; from: string; text: string }

export type ToHost =
  | Hello | Ping | Pong | PutDoc | PutBlob | Message
  | { t: 'append'; entry: AppendDraft }
  | { t: 'subscribe'; after_seq: number; hash: string }
  | { t: 'call'; id: string; req: Extract<Request, { op: 'plan' | 'task' }> };

export type ToLink =
  | Hello | Ping | Pong | PutDoc | PutBlob | Message
  | { t: 'ack'; id: string }
  | { t: 'answer'; id: string; value: unknown }
  | { t: 'refused'; id: string; reason: string }
  | { t: 'snapshot'; snapshot: Snapshot }
  | { t: 'lines'; lines: LogLine[] }
  | { t: 'bye'; reason: ByeReason };

/** What the variant reads before entries and snapshots go through schema.ts. */
type Raw<M> = M extends { t: 'append' } ? { t: 'append'; entry: unknown }
  : M extends { t: 'call' } ? { t: 'call'; id: string; req: unknown }
  : M extends { t: 'snapshot' } ? { t: 'snapshot'; snapshot: unknown }
  : M extends { t: 'lines' } ? { t: 'lines'; lines: { entry: unknown; hash: string }[] }
  : M;

const str = v.string();
const id = v.pipe(v.string(), v.minLength(1), v.maxLength(1024));
const count = v.pipe(v.number(), v.integer(), v.minValue(0));
const version = v.pipe(v.number(), v.integer(), v.minValue(1));

const both = [
  v.object({ t: v.literal('hello'), version, min: version, caps: v.array(str), name: str, machine: str }),
  v.object({ t: v.literal('ping'), n: count }),
  v.object({ t: v.literal('pong'), n: count }),
  v.object({ t: v.literal('put_doc'), id, key: id, doc: v.unknown() }),
  v.object({ t: v.literal('message'), to: id, from: str, text: str }),
  v.object({ t: v.literal('put_blob'), id, hash: id, text: str }),
] as const;

const toHost: v.GenericSchema<unknown, Raw<ToHost>> = v.variant('t', [
  ...both,
  v.object({ t: v.literal('append'), entry: v.unknown() }),
  v.object({ t: v.literal('subscribe'), after_seq: count, hash: str }),
  v.object({ t: v.literal('call'), id, req: v.unknown() }),
]);

const toLink: v.GenericSchema<unknown, Raw<ToLink>> = v.variant('t', [
  ...both,
  v.object({ t: v.literal('ack'), id }),
  v.object({ t: v.literal('answer'), id, value: v.unknown() }),
  v.object({ t: v.literal('refused'), id, reason: str }),
  v.object({ t: v.literal('snapshot'), snapshot: v.unknown() }),
  v.object({ t: v.literal('lines'), lines: v.array(v.object({ entry: v.unknown(), hash: id })) }),
  v.object({ t: v.literal('bye'), reason: v.fallback(v.picklist(['kicked', 'refused', 'skew', 'host_away', 'closed']), 'closed') }),
]);

const KNOWN: Readonly<Record<'host' | 'link', readonly string[]>> = {
  host: ['hello', 'ping', 'pong', 'put_doc', 'put_blob', 'message', 'append', 'subscribe', 'call'],
  link: ['hello', 'ping', 'pong', 'put_doc', 'put_blob', 'message', 'ack', 'answer', 'refused', 'snapshot', 'lines', 'bye'],
};

export const hello = (name: string, machine: string): Hello =>
  ({ t: 'hello', version: VERSION, min: MIN_VERSION, caps: [...CAPS], name, machine });

export const encode = (message: ToHost | ToLink): string => JSON.stringify(message);

function parse<T>(schema: v.GenericSchema<unknown, T>, known: readonly string[], text: string): Result<T | null> {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return err('not JSON'); }
  if (typeof raw !== 'object' || raw === null || !('t' in raw) || typeof raw.t !== 'string') return err('no message type');
  if (!known.includes(raw.t)) return ok(null); // a newer peer's message: skipped
  const r = v.safeParse(schema, raw);
  return r.success ? ok(r.output) : err(`a bad ${raw.t}: ${r.issues.map(i => i.message).join('; ')}`);
}

function lines(raw: readonly { entry: unknown; hash: string }[]): Result<LogLine[]> {
  const out: LogLine[] = [];
  for (const l of raw) {
    const e = decodeEntry(l.entry);
    if (!e.ok) return err(`a bad line: ${e.error}`);
    out.push({ entry: e.value, hash: l.hash });
  }
  return ok(out);
}

/** A message the host reads; null for a type it does not know. */
export function decodeToHost(text: string): Result<ToHost | null> {
  const r = parse(toHost, KNOWN.host, text);
  if (!r.ok) return r;
  const m = r.value;
  if (m?.t === 'call') {
    const q = decodeRequest(m.req);
    if (!q.ok || (q.value.op !== 'plan' && q.value.op !== 'task')) return err('a bad call');
    return ok({ t: 'call', id: m.id, req: q.value });
  }
  if (m?.t !== 'append') return ok(m);
  const e = decodeAppendDraft(m.entry);
  return e.ok ? ok({ t: 'append', entry: e.value }) : err(`a bad append: ${e.error}`);
}

/** A message a link reads; null for a type it does not know. */
export function decodeToLink(text: string): Result<ToLink | null> {
  const r = parse(toLink, KNOWN.link, text);
  if (!r.ok) return r;
  const m = r.value;
  if (!m) return ok(null);
  if (m.t === 'snapshot') {
    const s = decodeSnapshot(m.snapshot);
    return s.ok ? ok({ t: 'snapshot', snapshot: s.value }) : err(`a bad snapshot: ${s.error}`);
  }
  if (m.t === 'lines') {
    const l = lines(m.lines);
    return l.ok ? ok({ t: 'lines', lines: l.value }) : l;
  }
  return ok(m);
}

export type Agreement = { ok: true; version: number; caps: string[] } | { ok: false; update: 'me' | 'them' };

/** The version and caps both sides share, or which side must update: the one whose newest version is older, or whose
 *  hello is impossible (min above version). */
export function negotiate(mine: Hello, theirs: Hello): Agreement {
  if (theirs.min > theirs.version) return { ok: false, update: 'them' };
  if (mine.min > mine.version) return { ok: false, update: 'me' };
  const at = Math.min(mine.version, theirs.version);
  if (at >= Math.max(mine.min, theirs.min)) return { ok: true, version: at, caps: mine.caps.filter(c => theirs.caps.includes(c)) };
  return { ok: false, update: mine.version < theirs.version ? 'me' : 'them' };
}

/** The one line each side shows on a skew, naming who must update. */
export const skewLine = (update: 'me' | 'them', peer: string): string =>
  update === 'me'
    ? `Your sub-human is too old to talk to ${peer}: run /plugin update sub-human`
    : `${peer} runs an older sub-human: ask them to run /plugin update sub-human`;
