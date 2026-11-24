// The daemon's session pointers and handoffs (core/api.ts session, leave, retire, handoff, claim). Membership is the
// log's and per name; this file never posts `joined`, and posts `left` only for an explicit leave that no other
// pointer or pending handoff holds the name against. Everything else (a session ending, a stale handoff, a day-old
// pointer) only removes the pointer and marks the member away, when no other live session holds the name.
//
// A session is live while the daemon has seen it ping within LIVE_MS; one it has never seen ping (its module is off,
// or not up yet) counts as live until the day-old sweep. Each cwd's handoffs are a list on one chain, so a handoff and
// a claim never race; every pointer write sweeps stale handoffs and day-old pointers.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import type { Handoff, Pointer } from '../../core/api.js';
import { CODE, HANDOFF_MS, LIVE_MS, decodeHandoffs, decodePointer, handoffFile, lastFile, sessionFile, titleFor } from '../../core/api.js';
import type { Result } from '../../core/result.js';
import { ok } from '../../core/result.js';
import { parseJson } from '../../core/schema.js';
import * as v from '../../vendor/valibot.mjs';
import { writeAtomic } from '../../store/atomic.js';

/** A cwd's handoff file name: its SHA-256, taken at once, so calls join the cwd's chain in the order they came. */
const cwdKey = (cwd: string): string => createHash('sha256').update(cwd).digest('hex');
/** A pointer nobody has pinged for this long is swept: its session ended with no SessionEnd. */
const POINTER_STALE_MS = 24 * 3600_000;
const LAST = v.object({ code: v.pipe(v.string(), v.regex(CODE)) });
/** A pointer for the same name in the same room as `p`. */
const sameName = (p: Pointer) => (q: Pointer): boolean => q.code === p.code && q.name === p.name;

export interface PointersOptions {
  readonly home: string;
  readonly now: () => number;
  /** When the daemon last saw the session ping, or undefined when it never has. */
  readonly pingedAt: (id: string) => number | undefined;
  /** The explicit leave's `left`, under the pointer's leave id (stored once). */
  readonly left: (p: Pointer) => Promise<Result<unknown>>;
  /** The member's presence document, set away. */
  readonly away: (p: Pointer) => Promise<unknown>;
}

export class Pointers {
  private readonly o: PointersOptions;
  private readonly chains = new Map<string, Promise<unknown>>();
  constructor(o: PointersOptions) { this.o = o; }

  /**
   * Writes the session's pointer, with the lowest title no pointer here holds for the name; answers it. A pointer holds
   * its title until it is retired or swept, however long it goes without a ping: liveness only decides presence.
   */
  async write(id: string, p: Omit<Pointer, 'title'>): Promise<Result<{ title: string }>> {
    // one chain for every title, so two joins at once never take the same one
    const title = await this.serial('', async () => {
      const held = (await this.all()).filter(([o, q]) => o !== id && q.code === p.code && q.name === p.name).map(([, q]) => q.title);
      const t = titleFor(p.name, p.code, held);
      await writeAtomic(sessionFile(this.o.home, id), JSON.stringify({ ...p, title: t }));
      return t;
    });
    await this.sweep();
    return ok({ title });
  }

  /** `/sub-human leave`: `left` only when no other pointer or pending handoff holds the name. */
  async leave(id: string): Promise<Result<null>> {
    const p = await this.read(id);
    if (!p) return ok(null); // already left
    if (!(await this.held(sameName(p), id, false))) {
      const r = await this.o.left(p);
      if (!r.ok) return r;
      await this.o.away(p);
    }
    return this.end(id);
  }

  /** The session ended (logout, exit, a crash): its pointer goes, and the member is away unless held live elsewhere. */
  async retire(id: string): Promise<Result<null>> {
    const p = await this.read(id);
    if (!p) return ok(null);
    await this.end(id);
    if (!(await this.held(sameName(p), id, true))) await this.o.away(p);
    return ok(null);
  }

  /** /clear or /resume: the pointer joins the cwd's handoffs, oldest first. */
  async handoff(id: string, cwd: string): Promise<Result<null>> {
    const key = cwdKey(cwd);
    return this.serial(key, async () => {
      const p = await this.read(id);
      if (!p) return ok(null); // in no room: nothing to hand on
      await this.save(key, [...(await this.list(key)), { ...p, at: this.o.now() }]);
      return this.end(id);
    });
  }

  /** The next session in `cwd` takes the oldest fresh handoff; stale ones are dropped on the way. */
  async claim(id: string, cwd: string): Promise<Result<{ pointer: Pointer | null }>> {
    const key = cwdKey(cwd);
    return this.serial(key, async () => {
      const [first, ...rest] = await this.dropStale(key);
      if (!first) return ok({ pointer: null });
      await this.save(key, rest);
      const { at: _at, ...p } = first;
      await writeAtomic(sessionFile(this.o.home, id), JSON.stringify(p));
      return ok({ pointer: p });
    });
  }

  /** Whether a pointer or a fresh handoff here holds room `code` (R3: it is not swept). */
  holds(code: string): Promise<boolean> { return this.held(q => q.code === code, '', false); }

  /** The room `cwd` last joined, or null. */
  async last(cwd: string): Promise<string | null> {
    const r = parseJson(LAST, await fs.readFile(lastFile(this.o.home, cwdKey(cwd)), 'utf8').catch(() => ''));
    return r.ok ? r.value.code : null;
  }
  async setLast(cwd: string, code: string): Promise<void> {
    await writeAtomic(lastFile(this.o.home, cwdKey(cwd)), JSON.stringify({ code }));
  }

  private live(id: string): boolean {
    const at = this.o.pingedAt(id);
    return at === undefined || this.o.now() - at <= LIVE_MS;
  }

  /** Whether another pointer than `id`'s (a live one, when `live`) or a fresh handoff is `same`. */
  private async held(same: (q: Pointer) => boolean, id: string, live: boolean): Promise<boolean> {
    if ((await this.all()).some(([o, q]) => o !== id && same(q) && (!live || this.live(o)))) return true;
    for (const n of await fs.readdir(`${this.o.home}/handoff`).catch(() => [])) {
      if ((await this.list(n.slice(0, -5))).some(h => same(h) && this.o.now() - h.at <= HANDOFF_MS)) return true;
    }
    return false;
  }

  /** Every cwd's stale handoffs, and day-old pointers, swept. */
  private async sweep(): Promise<void> {
    for (const n of await fs.readdir(`${this.o.home}/handoff`).catch(() => [])) {
      if (n.endsWith('.json')) { const key = n.slice(0, -5); await this.serial(key, () => this.dropStale(key)); }
    }
    for (const n of await fs.readdir(`${this.o.home}/sessions`).catch(() => [])) {
      const id = n.slice(0, -5);
      const old = await fs.stat(sessionFile(this.o.home, id)).then(s => this.o.now() - s.mtimeMs > POINTER_STALE_MS, () => false);
      if (old) { await this.retire(id); await this.end(id); } // one that doesn't read goes too
    }
  }

  /** The cwd's handoffs still fresh; the members of the rest are away, and the list is saved. */
  private async dropStale(key: string): Promise<Handoff[]> {
    const all = await this.list(key);
    const fresh = all.filter(h => this.o.now() - h.at <= HANDOFF_MS);
    if (fresh.length === all.length) return fresh;
    await this.save(key, fresh);
    for (const h of all) if (!fresh.includes(h) && !(await this.held(sameName(h), '', true))) await this.o.away(h);
    return fresh;
  }

  private async end(id: string): Promise<Result<null>> {
    await fs.rm(sessionFile(this.o.home, id), { force: true });
    return ok(null);
  }
  private async all(): Promise<[string, Pointer][]> {
    const out: [string, Pointer][] = [];
    for (const n of await fs.readdir(`${this.o.home}/sessions`).catch(() => [])) {
      const p = n.endsWith('.json') ? await this.read(n.slice(0, -5)) : null;
      if (p) out.push([n.slice(0, -5), p]);
    }
    return out;
  }
  private async read(id: string): Promise<Pointer | null> {
    return decodePointer(await fs.readFile(sessionFile(this.o.home, id), 'utf8').catch(() => ''));
  }
  private async list(key: string): Promise<Handoff[]> {
    return decodeHandoffs(await fs.readFile(handoffFile(this.o.home, key), 'utf8').catch(() => ''));
  }
  private async save(key: string, hs: readonly Handoff[]): Promise<void> {
    const file = handoffFile(this.o.home, key);
    if (hs.length) await writeAtomic(file, JSON.stringify(hs)); else await fs.rm(file, { force: true });
  }
  /** Runs `fn` after every earlier call on `key` has finished. */
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(key) ?? Promise.resolve()).then(fn);
    this.chains.set(key, run.catch(() => undefined));
    return run;
  }
}
