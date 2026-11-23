// What follow.ts reads, as pure functions: the log's new lines from a byte range, the tail's documents stamp, the
// documents held for fold, and the status line. No `$` here; follow.ts makes the reads.
import * as v from '../vendor/valibot.mjs';
import type { DocKinds, Docs, LogLine, RoomState } from '../core/entries.js';
import { decodeEntry } from '../core/schema.js';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';
import type { Head } from '../store/store.js';
import { lineHash } from '../store/store.js';

export type Kind = 'presence' | 'activity' | 'focus';
/** The documents follow has read, by file name, with the mtime it read them at. */
export type Held = { [K in Kind]: Map<string, { mtime: number; doc: DocKinds[K] }> };

const Chained = v.looseObject({ seq: v.number(), prev: v.string() });
/**
 * The complete lines of a log read that follow `head`, chain-checked; `bytes` is how much of `text` they took. A
 * break is a fork (the error starts `fork`), never repaired.
 */
export async function linesAfter(text: string, head: Head): Promise<Result<{ lines: LogLine[]; head: Head; bytes: number }>> {
  const done = text.slice(0, text.lastIndexOf('\n') + 1); // a line with no newline yet is still being written
  const lines: LogLine[] = [];
  let h = head;
  for (const raw of done.split('\n').slice(0, -1)) {
    const json = parseJson(v.unknown(), raw);
    const c = v.safeParse(Chained, json);
    if (!c.success || c.output.seq !== h.seq + 1 || c.output.prev !== h.hash) return err(`fork: the log's chain breaks at seq ${h.seq + 1}`);
    h = { seq: c.output.seq, hash: await lineHash(raw) };
    const entry = decodeEntry(json); // a kind from a newer writer chains but is left out
    if (entry.ok) lines.push({ entry: entry.value, hash: h.hash });
  }
  return ok({ lines, head: h, bytes: new TextEncoder().encode(done).length });
}

const Stamp = v.looseObject({ docs: v.optional(v.string()) });
/** The tail file's documents stamp, which the daemon renews on every put_doc. */
export function docsStamp(tail: string): string | undefined { return parseJson(Stamp, tail)?.docs; }

export function docsOf(held: Held): Docs {
  const docs = <K extends Kind>(kind: K): DocKinds[K][] => [...held[kind].values()].map(x => x.doc);
  return { presence: docs('presence'), activity: docs('activity'), focus: docs('focus') };
}

/** `CODE · bob (working), carol · 2 updates`: who else is here, and what I haven't seen. */
export function statusLine(room: RoomState, me: { readonly code: string; readonly name: string }, count: number): string {
  const here = room.members.filter(m => m.name !== me.name && m.machines.length > 0)
    .map(m => (m.presence?.state === 'working' ? `${m.name} (working)` : m.name));
  return [me.code, ...(here.length ? [here.join(', ')] : []), ...(count ? [`${count} update${count === 1 ? '' : 's'}`] : [])].join(' · ');
}

export function parseJson<T>(schema: v.GenericSchema<unknown, T>, text: string): T | null {
  try {
    const r = v.safeParse(schema, JSON.parse(text));
    return r.success ? r.output : null;
  } catch { return null; }
}
