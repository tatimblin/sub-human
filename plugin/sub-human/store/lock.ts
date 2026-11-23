// A lock file taken with open('wx') (ARCHITECTURE §2a, in place of proper-lockfile). It holds a random token, its
// identity, and its holder touches its mtime every staleMs/3. A lock whose mtime stops moving for staleMs belongs to a
// holder that died: one waiter at a time (holding `.break`, itself a lock) re-checks that it is the same file, still
// stale, and removes it. Release removes the lock only while it still holds the holder's own token.
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';

export interface LockOptions { readonly waitMs?: number; readonly staleMs?: number }
/** What a waiter saw at the lock path. */
export interface Seen { readonly token: string; readonly mtimeMs: number }

const code = (e: unknown): unknown => (e instanceof Error ? Reflect.get(e, 'code') : undefined);

/** Runs `fn` holding `file`; an error only when the lock stayed held past `waitMs`. */
export async function withLock<T>(file: string, fn: () => Promise<T>, o: LockOptions = {}): Promise<Result<T>> {
  const { waitMs = 5000, staleMs = 10_000 } = o;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  for (;;) {
    const token = await take(file);
    if (token !== null) return ok(await hold(file, token, staleMs, fn));
    if (Date.now() > deadline) return err('the room is busy; nothing was written');
    const seen = await look(file);
    if (seen && Date.now() - seen.mtimeMs > staleMs) await breakStale(file, staleMs, seen);
    await sleep(2 + Math.random() * 8);
  }
}

async function hold<T>(file: string, token: string, staleMs: number, fn: () => Promise<T>): Promise<T> {
  const touch = async (): Promise<void> => {
    if ((await look(file))?.token !== token) return;
    const now = new Date();
    await fs.utimes(file, now, now).catch(() => undefined);
  };
  const timer = setInterval(() => { void touch(); }, Math.max(1, staleMs / 3));
  timer.unref(); // a hold never keeps the process alive by itself
  try { return await fn(); } finally {
    clearInterval(timer);
    await release(file, token);
  }
}

/** The new lock's token, or null when the path is taken. */
async function take(file: string): Promise<string | null> {
  const token = `${process.pid}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  try {
    const fh = await fs.open(file, 'wx', 0o600);
    try { await fh.writeFile(token); } finally { await fh.close(); }
    return token;
  } catch (e) {
    if (code(e) === 'EEXIST') return null;
    throw e;
  }
}

async function look(file: string): Promise<Seen | null> {
  try {
    const { mtimeMs } = await fs.lstat(file);
    return { token: await fs.readFile(file, 'utf8'), mtimeMs };
  } catch { return null; }
}

async function release(file: string, token: string): Promise<void> {
  if ((await look(file))?.token === token) await fs.unlink(file).catch(() => undefined);
}

/** Removes the lock a waiter saw, if under `.break` it is still that file and still stale. */
export async function breakStale(file: string, staleMs: number, seen: Seen): Promise<void> {
  const brk = `${file}.break`;
  const token = await take(brk);
  if (token === null) {
    // another waiter is breaking it, or one died doing so
    const b = await look(brk);
    if (b && Date.now() - b.mtimeMs > staleMs) await breakStale(brk, staleMs, b);
    return;
  }
  try {
    const now = await look(file);
    if (now?.token === seen.token && now.mtimeMs === seen.mtimeMs && Date.now() - now.mtimeMs > staleMs) {
      await fs.unlink(file).catch(() => undefined);
    }
  } finally { await release(brk, token); }
}
