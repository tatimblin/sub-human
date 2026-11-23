// Every write (log appends, documents, plan text) goes through node: `$.fs` has no exclusive create, rename or append,
// so the module can neither take the lock nor write crash-safe. The module only reads, with `$.fs`: the tail file, and
// the log by byte ranges (4 MiB per read); readers skip a torn last line, and lineHash runs there too.
//
// RoomStore is the one seam over a room's files (ARCHITECTURE §4): memory-store.ts for tests, fs-store.ts on the host,
// the mirror later. What both backends share is here: the line format, the chain check and the tail file.
import * as v from '../vendor/valibot.mjs';
import type { DocKind, DocKinds, Docs, Entry, LogLine, Snapshot } from '../core/entries.js';
import { NO_DOCS } from '../core/entries.js';
import { fold, takeSnapshot } from '../core/fold.js';
import { decodeEntry } from '../core/schema.js';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';

type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An entry before the store places it: `seq` and `prev` are assigned under the lock. */
export type Draft = Without<Entry, 'seq' | 'prev'>;
export interface Head { readonly seq: number; readonly hash: string }
/** The latest snapshot and the lines after it: what a catch-up folds. */
export interface Catchup { readonly snapshot: Snapshot | null; readonly lines: readonly LogLine[] }
/** The small file a follower polls instead of the log: the head and when it moved. */
export interface Tail extends Head { readonly at: number }

export interface RoomStore {
  /** Places the draft after the head; the line as stored, with its hash. */
  append(draft: Draft): Promise<Result<LogLine>>;
  /**
   * The lines after `afterSeq`, chain-checked from the line at `afterSeq`, whose hash must be `hash` when given (the
   * reader's cursor); a break is an error, never repaired.
   */
  read(afterSeq: number, hash?: string): Promise<Result<readonly LogLine[]>>;
  head(): Promise<Result<Head>>;
  /** The latest snapshot and the lines after it; a log that no longer holds the snapshot's line is a fork. */
  catchup(): Promise<Result<Catchup>>;
  /** Latest wins; documents never enter the log. */
  putDoc<K extends DocKind>(kind: K, name: string, doc: DocKinds[K]): Promise<void>;
  getDoc<K extends DocKind>(kind: K, name: string): Promise<DocKinds[K] | null>;
  /** Every presence, activity and focus document, for fold. */
  docs(): Promise<Docs>;
  /** Stores plan text by its hash and answers the hash. */
  putBlob(text: string): Promise<string>;
  getBlob(hash: string): Promise<string | null>;
}

/** Hex SHA-256 of a text: `crypto.subtle`, so the module and node hash alike. */
export async function sha256(text: string): Promise<string> {
  const data = new Uint8Array(new TextEncoder().encode(text)); // a plain ArrayBuffer, as digest's types ask
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
/** A line's hash, which the next line's `prev` names. Over the raw stored text, so decoding never changes it. */
export const lineHash: (line: string) => Promise<string> = sha256;
export const BLOB_HASH: RegExp = /^[0-9a-f]{64}$/;

/** The stored text of a draft placed after `head`, or why it can't be stored. */
export function placeLine(draft: Draft, head: Head): Result<{ readonly line: string; readonly entry: Entry }> {
  const entry = decodeEntry({ ...draft, seq: head.seq + 1, prev: head.hash });
  return entry.ok ? ok({ line: JSON.stringify(entry.value), entry: entry.value }) : err(`entry not stored: ${entry.error}`);
}

const chained = v.looseObject({ seq: v.number(), prev: v.string() });
function chainOf(line: string): { seq: number; prev: string } | null {
  try {
    const r = v.safeParse(chained, JSON.parse(line));
    return r.success ? r.output : null;
  } catch { return null; }
}

/** The head of complete raw lines (the last line's seq and hash). */
export async function headOf(last: string | undefined): Promise<Result<Head>> {
  if (last === undefined) return ok({ seq: 0, hash: '' });
  const c = chainOf(last);
  return c ? ok({ seq: c.seq, hash: await lineHash(last) }) : err('the log\'s last line is not readable');
}

/**
 * The lines of a log after `afterSeq` (raw complete lines, seq 1 first). Each must carry the next seq and name the
 * hash of the line before it; `expect`, when given, is the hash the line at `afterSeq` must have (a snapshot's, a cursor's).
 * A line that chains but doesn't decode (a newer writer's kind) is left out, and the chain runs on through it.
 */
export async function verifyLines(raws: readonly string[], afterSeq: number, expect?: string): Promise<Result<readonly LogLine[]>> {
  if (afterSeq > raws.length) return expect === undefined ? ok([]) : err(`fork: the log ends before seq ${afterSeq}`);
  const anchor = afterSeq > 0 ? raws[afterSeq - 1] : undefined;
  let prev = anchor === undefined ? '' : await lineHash(anchor);
  if (anchor !== undefined && chainOf(anchor)?.seq !== afterSeq) return err(`fork: no line ${afterSeq} where it belongs`);
  if (expect !== undefined && prev !== expect) return err(`fork: line ${afterSeq} is not the one expected`);
  const rest = raws.slice(afterSeq);
  const hashes = await Promise.all(rest.map(lineHash));
  const out: LogLine[] = [];
  for (const [i, line] of rest.entries()) {
    const seq = afterSeq + i + 1;
    const c = chainOf(line);
    if (c?.seq !== seq || c.prev !== prev) return err(`fork: the log's chain breaks at seq ${seq}`);
    const hash = hashes[i] ?? '';
    const entry = decodeEntry(JSON.parse(line));
    if (entry.ok) out.push({ entry: entry.value, hash });
    prev = hash;
  }
  return ok(out);
}

/** The snapshot after `lines` (which follow `snap`): fold's state without the documents. */
export function nextSnapshot(snap: Snapshot | null, lines: readonly LogLine[]): Snapshot {
  return takeSnapshot(fold(snap, lines, NO_DOCS));
}

const tail = v.object({ seq: v.pipe(v.number(), v.integer(), v.minValue(0)), hash: v.string(), at: v.number() });
export function tailText(t: Tail): string { return JSON.stringify(t); }
export function parseTail(text: string): Result<Tail> {
  try {
    const r = v.safeParse(tail, JSON.parse(text));
    return r.success ? ok(r.output) : err('the tail file is not readable');
  } catch { return err('the tail file is not readable'); }
}
