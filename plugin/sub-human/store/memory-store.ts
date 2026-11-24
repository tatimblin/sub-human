// The in-memory RoomStore, for tests and the kit harness. It keeps raw lines and document text, as the files do, so
// it hashes, chains and decodes exactly as fs-store does. Several stores over one MemoryRoom are several handles on
// one room; their appends take turns, as the lock makes them on disk.
import type { DocKind, DocKinds, Docs, LogLine, Snapshot, StoreDraft } from '../core/entries.js';
import { SNAPSHOT_EVERY, snapshotDue } from '../core/fold.js';
import { parseDoc } from '../core/schema.js';
import type { Result } from '../core/result.js';
import { ok } from '../core/result.js';
import type { Catchup, Head, RoomStore } from './store.js';
import { BLOB_HASH, headOf, lineHash, nextSnapshot, placeLine, verifyLines } from './store.js';
import { sha256 } from '../core/hash.js';

/** A room's contents; tests may edit `lines` to forge a fork. */
export interface MemoryRoom {
  lines: string[];
  snapshot: Snapshot | null;
  readonly docs: Map<string, string>;
  readonly blobs: Map<string, string>;
  busy: Promise<unknown>;
}
export function memoryRoom(): MemoryRoom {
  return { lines: [], snapshot: null, docs: new Map(), blobs: new Map(), busy: Promise.resolve() };
}

export class MemoryStore implements RoomStore {
  readonly room: MemoryRoom;
  private readonly every: number;
  constructor(room: MemoryRoom = memoryRoom(), every: number = SNAPSHOT_EVERY) { this.room = room; this.every = every; }

  append(draft: StoreDraft): Promise<Result<LogLine>> {
    const run = this.room.busy.then(() => this.place(draft));
    this.room.busy = run.catch(() => undefined);
    return run;
  }

  private async place(draft: StoreDraft): Promise<Result<LogLine>> {
    const head = await this.head();
    if (!head.ok) return head;
    const placed = placeLine(draft, head.value);
    if (!placed.ok) return placed;
    this.room.lines.push(placed.value.line);
    const seq = placed.value.entry.seq;
    const snap = this.room.snapshot;
    if (snapshotDue(seq, snap?.state.seq ?? 0, this.every)) {
      const after = await verifyLines(this.room.lines, snap?.state.seq ?? 0, snap?.state.hash);
      if (after.ok) this.room.snapshot = nextSnapshot(snap, after.value);
    }
    return ok({ entry: placed.value.entry, hash: await lineHash(placed.value.line) });
  }

  read(afterSeq: number, hash?: string): Promise<Result<readonly LogLine[]>> { return verifyLines(this.room.lines, afterSeq, hash); }
  head(): Promise<Result<Head>> { return headOf(this.room.lines.at(-1)); }

  async catchup(): Promise<Result<Catchup>> {
    const snapshot = this.room.snapshot;
    const lines = await verifyLines(this.room.lines, snapshot?.state.seq ?? 0, snapshot?.state.hash);
    return lines.ok ? ok({ snapshot, lines: lines.value }) : lines;
  }

  putDoc<K extends DocKind>(kind: K, name: string, doc: DocKinds[K]): Promise<void> {
    this.room.docs.set(`${kind}/${name}`, JSON.stringify(doc));
    return Promise.resolve();
  }
  getDoc<K extends DocKind>(kind: K, name: string): Promise<DocKinds[K] | null> {
    return Promise.resolve(this.decoded(kind, this.room.docs.get(`${kind}/${name}`)));
  }
  docs(): Promise<Docs> {
    const all = <K extends DocKind>(kind: K): DocKinds[K][] =>
      [...this.room.docs].filter(([k]) => k.startsWith(`${kind}/`)).flatMap(([, t]) => this.decoded(kind, t) ?? []);
    return Promise.resolve({ presence: all('presence'), activity: all('activity'), focus: all('focus') });
  }
  private decoded<K extends DocKind>(kind: K, text: string | undefined): DocKinds[K] | null {
    if (text === undefined) return null;
    const d = parseDoc(kind, text);
    return d.ok ? d.value : null;
  }

  async putBlob(text: string): Promise<string> {
    const hash = await sha256(text);
    this.room.blobs.set(hash, text);
    return hash;
  }
  getBlob(hash: string): Promise<string | null> {
    return Promise.resolve(BLOB_HASH.test(hash) ? this.room.blobs.get(hash) ?? null : null);
  }
}
