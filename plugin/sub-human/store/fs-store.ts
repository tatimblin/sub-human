// The host's RoomStore on disk (layout in home.ts): an append-only log.jsonl placed under the lock and fsynced, a
// snapshot every SNAPSHOT_EVERY entries, latest-wins documents and plan blobs written crash-safe, and the tail file a
// follower polls. A line cut short by a crash has no newline yet: readers skip it and the next append drops it.
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { DocKind, DocKinds, Docs, LogLine, Snapshot } from '../core/entries.js';
import { SNAPSHOT_EVERY, snapshotDue } from '../core/fold.js';
import { parseDoc, parseSnapshot } from '../core/schema.js';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';
import { blobFile, docDir, docFile, fileKey, lockFile, logFile, roomDir, snapshotFile, tailFile } from '../home.js';
import { writeAtomic } from './atomic.js';
import type { LockOptions } from './lock.js';
import { withLock } from './lock.js';
import type { Catchup, Draft, Head, RoomStore, Tail } from './store.js';
import { BLOB_HASH, headOf, lineHash, nextSnapshot, parseTail, placeLine, tailText, verifyLines } from './store.js';
import { sha256 } from '../core/hash.js';

export interface FsStoreOptions {
  readonly home: string;
  readonly code: string;
  /** The host's clock, for the tail file. */
  readonly now?: () => number;
  readonly every?: number;
  readonly lock?: LockOptions;
}

/** The store of room `code` under `home`; an empty code names no room. */
export async function openFsStore(o: FsStoreOptions): Promise<Result<FsStore>> {
  if (o.code === '') return err('no room code; nothing was opened');
  return ok(new FsStore(roomDir(o.home, await fileKey(o.code)), o));
}

export class FsStore implements RoomStore {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly every: number;
  private readonly lock: LockOptions;
  /** The seq of the last snapshot seen; snapshots only move forward, so a low guess costs one read. */
  private snapped = 0;

  /** `dir` is the room's directory; openFsStore finds it. */
  constructor(dir: string, o: Omit<FsStoreOptions, 'home' | 'code'> = {}) {
    this.dir = dir;
    this.now = o.now ?? Date.now;
    this.every = o.every ?? SNAPSHOT_EVERY;
    this.lock = o.lock ?? {};
  }

  async append(draft: Draft): Promise<Result<LogLine>> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const r = await withLock(lockFile(this.dir), () => this.place(draft), this.lock);
    return r.ok ? r.value : r;
  }

  private async place(draft: Draft): Promise<Result<LogLine>> {
    const fh = await fs.open(logFile(this.dir), 'a+', 0o600);
    let placed: ReturnType<typeof placeLine>;
    try {
      const { size } = await fh.stat();
      const { last, end } = await lastLine(fh, size);
      if (end < size) await fh.truncate(end); // a torn line nobody was told was stored
      const head = await headOf(last);
      if (!head.ok) return head;
      placed = placeLine(draft, head.value);
      if (!placed.ok) return placed;
      await fh.write(`${placed.value.line}\n`);
      await fh.sync();
    } finally { await fh.close(); }
    const { line, entry } = placed.value;
    const hash = await lineHash(line);
    await this.writeTail({ seq: entry.seq, hash }, (await this.readTail())?.docs);
    if (snapshotDue(entry.seq, this.snapped, this.every)) await this.snapshot(entry.seq);
    return ok({ entry, hash });
  }

  /** Under the lock: the snapshot after the newest line, unless a newer one is there or the log forked. */
  private async snapshot(seq: number): Promise<void> {
    const snap = await this.readSnapshot();
    this.snapped = snap?.state.seq ?? 0;
    if (!snapshotDue(seq, this.snapped, this.every)) return;
    const raws = await this.raws();
    const after = await verifyLines(raws, this.snapped, snap?.state.hash);
    if (!after.ok) return; // a fork is reported by every read; a snapshot over it would hide it
    const next = nextSnapshot(snap, after.value);
    await writeAtomic(snapshotFile(this.dir), JSON.stringify(next));
    this.snapped = next.state.seq;
  }

  async read(afterSeq: number, hash?: string): Promise<Result<readonly LogLine[]>> {
    return verifyLines(await this.raws(), afterSeq, hash);
  }
  async head(): Promise<Result<Head>> { return headOf((await this.raws()).at(-1)); }

  async catchup(): Promise<Result<Catchup>> {
    const snapshot = await this.readSnapshot();
    const lines = await verifyLines(await this.raws(), snapshot?.state.seq ?? 0, snapshot?.state.hash);
    return lines.ok ? ok({ snapshot, lines: lines.value }) : lines;
  }

  /** Latest wins, then a new documents stamp in the tail (under the lock, beside the appends that keep it). */
  async putDoc<K extends DocKind>(kind: K, name: string, doc: DocKinds[K]): Promise<void> {
    await writeAtomic(docFile(this.dir, kind, await fileKey(name)), JSON.stringify(doc));
    const r = await withLock(lockFile(this.dir), async () => {
      const fh = await fs.open(logFile(this.dir), 'a+', 0o600);
      let last: string | undefined;
      try { ({ last } = await lastLine(fh, (await fh.stat()).size)); } finally { await fh.close(); }
      const head = await headOf(last);
      if (head.ok) await this.writeTail(head.value, crypto.randomUUID());
    }, this.lock);
    if (!r.ok) throw new Error(r.error);
  }

  private async readTail(): Promise<Tail | null> {
    const text = await readText(tailFile(this.dir));
    const t = text === null ? null : parseTail(text);
    return t?.ok ? t.value : null;
  }
  private async writeTail(head: Head, docs: string | undefined): Promise<void> {
    await writeAtomic(tailFile(this.dir), tailText({ ...head, at: this.now(), ...(docs !== undefined && { docs }) }));
  }
  async getDoc<K extends DocKind>(kind: K, name: string): Promise<DocKinds[K] | null> {
    return decoded(kind, await readText(docFile(this.dir, kind, await fileKey(name))));
  }
  async docs(): Promise<Docs> {
    const all = async <K extends DocKind>(kind: K): Promise<DocKinds[K][]> => {
      const names = await fs.readdir(docDir(this.dir, kind)).catch(() => []);
      const texts = await Promise.all(names.filter(n => n.endsWith('.json')).map(n => readText(`${docDir(this.dir, kind)}/${n}`)));
      return texts.flatMap(t => decoded(kind, t) ?? []);
    };
    const [presence, activity, focus] = await Promise.all([all('presence'), all('activity'), all('focus')]);
    return { presence, activity, focus };
  }

  async putBlob(text: string): Promise<string> {
    const hash = await sha256(text);
    const file = blobFile(this.dir, hash);
    if ((await readText(file)) !== text) await writeAtomic(file, text);
    return hash;
  }
  async getBlob(hash: string): Promise<string | null> {
    if (!BLOB_HASH.test(hash)) return null;
    const text = await readText(blobFile(this.dir, hash));
    return text !== null && (await sha256(text)) === hash ? text : null;
  }

  private async readSnapshot(): Promise<Snapshot | null> {
    const text = await readText(snapshotFile(this.dir));
    const r = text === null ? null : parseSnapshot(text);
    return r?.ok ? r.value : null;
  }

  /** The log's complete lines; a last line with no newline is still being written, or was torn. */
  private async raws(): Promise<string[]> {
    const lines = ((await readText(logFile(this.dir))) ?? '').split('\n');
    lines.pop();
    return lines;
  }
}

/** The last complete line before `size` and the offset just past its newline (0 and no line when there is none). */
async function lastLine(fh: FileHandle, size: number): Promise<{ last?: string; end: number }> {
  for (let len = Math.min(size, 65_536); ; len = Math.min(size, len * 4)) {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const nl = buf.lastIndexOf(10);
    const start = nl > 0 ? buf.lastIndexOf(10, nl - 1) : -1;
    if (start >= 0 || len === size) {
      return nl < 0 ? { end: 0 } : { last: buf.toString('utf8', start + 1, nl), end: size - len + nl + 1 };
    }
  }
}

async function readText(file: string): Promise<string | null> {
  return fs.readFile(file, 'utf8').catch(() => null);
}
function decoded<K extends DocKind>(kind: K, text: string | null): DocKinds[K] | null {
  const r = text === null ? null : parseDoc(kind, text);
  return r?.ok ? r.value : null;
}
