// A room hosted on another machine, kept here (ARCHITECTURE §4, R28, R36): the same files as the host's FsStore, so
// readers here read them alike, but the log starts at the host's snapshot rather than seq 1, and only the host places a
// line. The link hands in what the host sends (reset, extend, the host's documents and plan text); every write goes
// to the host through `up`, and an append answers once the host's line has come back here. A snapshot is taken here
// every SNAPSHOT_EVERY lines, as on the host, so a catch-up never folds the whole copy.
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { DocKind, DocKinds, Docs, LogLine, Snapshot } from '../core/entries.js';
import { SNAPSHOT_EVERY, snapshotDue } from '../core/fold.js';
import { parseSnapshot } from '../core/schema.js';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';
import { logFile, snapshotFile, tailFile } from '../home.js';
import { writeAtomic } from './atomic.js';
import { FsStore } from './fs-store.js';
import type { Catchup, Draft, Head, RoomStore } from './store.js';
import { headOf, lineHash, nextSnapshot, tailText, verifyLines } from './store.js';

/** The host, as the link reaches it. append resolves once the host's line for the draft has been extended here. */
export interface Upstream {
  append(draft: Draft): Promise<Result<null>>;
  putDoc<K extends DocKind>(kind: K, name: string, doc: DocKinds[K]): Promise<void>;
  putBlob(text: string, hash: string): Promise<void>;
}

export class MirrorStore implements RoomStore {
  private readonly dir: string;
  private readonly up: Upstream;
  private readonly every: number;
  private readonly now: () => number;
  /** Documents and plan text are files with no chain: the FsStore's own. */
  private readonly files: FsStore;

  constructor(dir: string, up: Upstream, o: { every?: number; now?: () => number } = {}) {
    this.dir = dir;
    this.up = up;
    this.every = o.every ?? SNAPSHOT_EVERY;
    this.now = o.now ?? Date.now;
    this.files = new FsStore(dir);
  }

  async append(draft: Draft): Promise<Result<LogLine>> {
    const sent = await this.up.append(draft);
    if (!sent.ok) return sent;
    const { base } = await this.copy();
    const all = await this.read(base);
    const line = all.ok ? all.value.findLast(l => l.entry.id === draft.id) : undefined;
    return line ? ok(line) : err('the host took the entry, but its line is not here yet');
  }

  async read(afterSeq: number, hash?: string): Promise<Result<readonly LogLine[]>> {
    const { base, raws } = await this.copy();
    return verifyLines(raws, afterSeq, hash, base);
  }

  async head(): Promise<Result<Head>> {
    const { raws } = await this.copy();
    if (raws.length) return headOf(raws.at(-1));
    const snap = await this.snapshot();
    return ok({ seq: snap?.state.seq ?? 0, hash: snap?.state.hash ?? '' });
  }

  async catchup(): Promise<Result<Catchup>> {
    const [{ base, raws }, snapshot] = await Promise.all([this.copy(), this.snapshot()]);
    const lines = await verifyLines(raws, snapshot?.state.seq ?? base, snapshot?.state.hash, base);
    return lines.ok ? ok({ snapshot, lines: lines.value }) : lines;
  }

  /** Written here at once (latest wins) and sent on; the link sends the member's own again on reconnect. */
  async putDoc<K extends DocKind>(kind: K, name: string, doc: DocKinds[K]): Promise<void> {
    await this.hostDoc(kind, name, doc);
    await this.up.putDoc(kind, name, doc);
  }
  getDoc<K extends DocKind>(kind: K, name: string): Promise<DocKinds[K] | null> { return this.files.getDoc(kind, name); }
  docs(): Promise<Docs> { return this.files.docs(); }
  async putBlob(text: string): Promise<string> {
    const hash = await this.files.putBlob(text);
    await this.up.putBlob(text, hash);
    return hash;
  }
  getBlob(hash: string): Promise<string | null> { return this.files.getBlob(hash); }

  // What the host sends.

  /** The copy discarded for the host's snapshot (a joiner, or a fork): the lines after it follow with extend. */
  async reset(snap: Snapshot): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeAtomic(snapshotFile(this.dir), JSON.stringify(snap));
    await writeAtomic(logFile(this.dir), '');
    await this.tail(snap.state.seq, snap.state.hash);
  }

  /** The host's lines after the head here; a line that doesn't chain on is a fork, and nothing is kept. */
  async extend(lines: readonly LogLine[]): Promise<Result<null>> {
    if (!lines.length) return ok(null);
    const { raws, torn } = await this.copy();
    if (torn) await writeAtomic(logFile(this.dir), raws.map(r => `${r}\n`).join(''));
    const head = await this.head();
    if (!head.ok) return head;
    let { seq, hash } = head.value;
    const texts: string[] = [];
    for (const l of lines) {
      const text = JSON.stringify(l.entry);
      if (l.entry.seq !== seq + 1 || l.entry.prev !== hash || (await lineHash(text)) !== l.hash) {
        return err(`fork: the host's line ${l.entry.seq} does not follow this copy's ${seq}`);
      }
      texts.push(text);
      ({ seq, hash } = { seq: l.entry.seq, hash: l.hash });
    }
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.appendFile(logFile(this.dir), `${texts.join('\n')}\n`, { mode: 0o600 });
    await this.tail(seq, hash);
    const snap = await this.snapshot();
    if (snapshotDue(seq, snap?.state.seq ?? 0, this.every)) {
      const after = await this.catchup();
      if (after.ok) await writeAtomic(snapshotFile(this.dir), JSON.stringify(nextSnapshot(snap, after.value.lines)));
    }
    return ok(null);
  }

  /** A document of another member, or plan text, as the host has it. */
  async hostDoc<K extends DocKind>(kind: K, name: string, doc: DocKinds[K]): Promise<void> {
    await this.files.putDoc(kind, name, doc);
    // a new documents stamp in the tail file, as on the host, so a follower here reads the documents again
    const head = await this.head();
    if (head.ok) await writeAtomic(tailFile(this.dir), JSON.stringify({ ...head.value, at: this.now(), docs: randomUUID() }));
  }
  hostBlob(text: string): Promise<string> { return this.files.putBlob(text); }

  private tail(seq: number, hash: string): Promise<void> {
    return writeAtomic(tailFile(this.dir), tailText({ seq, hash, at: this.now() }));
  }

  private async snapshot(): Promise<Snapshot | null> {
    const text = await fs.readFile(snapshotFile(this.dir), 'utf8').catch(() => null);
    if (text === null) return null;
    const r = parseSnapshot(text);
    return r.ok ? r.value : null;
  }

  /** The complete lines here, and the seq before the first; torn: a line cut short by a crash, left out. */
  private async copy(): Promise<{ base: number; raws: string[]; torn: boolean }> {
    const raws = (await fs.readFile(logFile(this.dir), 'utf8').catch(() => '')).split('\n');
    const torn = raws.pop() !== '';
    const first = raws[0];
    if (first === undefined) return { base: (await this.snapshot())?.state.seq ?? 0, raws, torn };
    const h = await headOf(first);
    return { base: h.ok ? h.value.seq - 1 : 0, raws, torn };
  }
}
