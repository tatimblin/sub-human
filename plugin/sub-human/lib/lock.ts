/**
 * plugin/sub-human/lib/lock.ts: the one lockfile helper (room log, members.json, proposals, the task mirror,
 * the row map). Zero dependencies; synchronous, because hooks are short synchronous processes.
 *
 *   withLock(lockPath, fn, {timeoutMs, staleMs, ErrorClass}?) -> fn()'s value
 *       Creates lockPath exclusively (O_EXCL), runs fn, removes it. The body is the owner: "PID HOST START",
 *       START = the process start time in epoch seconds. A waiter retries every few ms; after timeoutMs
 *       (LOCK_TIMEOUT_MS) it throws ErrorClass (default Error) with code 'LOCK'. It never runs fn unlocked.
 *   pidStart(pid) -> epoch seconds | null   via `ps -o lstart= -p PID` (cached per pid; null when ps fails)
 *
 * Stale locks. A lock is stale when its owner is on this host and either its pid is dead or that pid now
 * belongs to a different process (its start time differs by more than LOCK_START_SLACK_S: pid reuse). A
 * lock whose owner cannot be checked (another host, an empty body while its owner is still writing it, a
 * legacy body or a legacy directory lock) is stale only when older than staleMs. A live, verified owner is
 * never broken: the waiter times out instead.
 *
 * Breaking a stale lock is atomic, so two waiters that both judged it stale can never both end up holding:
 *   1. take lockPath + '.break' exclusively (breakers run one at a time; a crashed breaker's file is removed
 *      after LOCK_BREAK_STALE_MS),
 *   2. judge again under it (the lock may have been broken and re-taken meanwhile),
 *   3. rename the lock to lockPath + '.stale.PID.RAND', then check that the renamed file is the one judged
 *      (same inode and body). If it is not, it is linked back (link fails rather than overwrite a newer lock)
 *      and the waiter retries.
 * Release removes the lock only if it is still the file this process created (same inode).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isAlive, sleepSync } from './io.ts';
import * as config from './config.ts';

const HOST = os.hostname();

// ---------- process start times ----------
const starts = new Map();
const PID_START_CACHE_MS = 30_000;

/** Epoch seconds the process started, from ps; null when ps fails or the pid is gone. Cached per pid. */
function pidStart(pid, { fresh = false } = {}) {
  pid = Number(pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  // Cached briefly only: a long-running tail or MCP server would otherwise keep matching a reused pid.
  const hit = starts.get(pid);
  if (!fresh && hit && Date.now() - hit.at < PID_START_CACHE_MS) return hit.t;
  let t = null;
  try {
    const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 2000 });
    const s = String(r.stdout || '').trim();
    const ms = s ? Date.parse(s) : NaN;
    if (Number.isFinite(ms)) t = Math.floor(ms / 1000);
  } catch { t = null; }
  if (t != null) starts.set(pid, { t, at: Date.now() });
  return t;
}

/** This process's start time without spawning ps (Node's uptime is measured from process start). */
const selfStart = () => Math.floor(Date.now() / 1000 - process.uptime());

const ownerBody = () => `${process.pid} ${HOST} ${selfStart()}`;

function parseOwner(body) {
  const m = /^(\d+) (\S+)(?: (\d+))?$/.exec(String(body).trim());
  return m ? { pid: Number(m[1]), host: m[2], start: m[3] != null ? Number(m[3]) : null } : null;
}

// ---------- judging ----------
/** {stale, ino, body} for the file at lock now; null when there is none. */
function judge(lock, staleMs) {
  let st, body = '';
  try { st = fs.lstatSync(lock); } catch { return null; }
  if (st.isDirectory()) return { stale: Date.now() - st.mtimeMs > staleMs, ino: st.ino, body: null, dir: true };
  try { body = fs.readFileSync(lock, 'utf8'); } catch { return null; }
  const o = parseOwner(body);
  if (o && o.host === HOST) {
    if (!isAlive(o.pid)) return { stale: true, ino: st.ino, body };
    // Alive: the same process unless the pid was reused. A lock younger than LOCK_REUSE_CHECK_MS is its
    // live owner's (reuse needs the owner to die first, so a reused pid's lock is old): no `ps` for it. An
    // old-format body (no start) or a ps failure cannot tell; then only age decides.
    if (Date.now() - st.mtimeMs < config.LOCK_REUSE_CHECK_MS) return { stale: false, ino: st.ino, body };
    if (o.start != null) {
      const now = o.pid === process.pid ? selfStart() : pidStart(o.pid);
      if (now != null) {
        const reused = Math.abs(now - o.start) > config.LOCK_START_SLACK_S;
        return { stale: reused, ino: st.ino, body };
      }
    }
  }
  return { stale: Date.now() - st.mtimeMs > staleMs, ino: st.ino, body };
}

const rand = () => Math.random().toString(36).slice(2, 10);

/** Break the stale lock atomically (see the header). True when the caller should retry acquiring at once. */
function breakStale(lock, staleMs) {
  const brk = lock + '.break';
  let fd;
  try { fd = fs.openSync(brk, 'wx'); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Another waiter is breaking it right now, or one crashed doing so.
    try { if (Date.now() - fs.statSync(brk).mtimeMs > config.LOCK_BREAK_STALE_MS) fs.unlinkSync(brk); } catch { /* gone */ }
    return false;
  }
  try {
    const j = judge(lock, staleMs);
    if (!j) return true;          // already gone: retry now
    if (!j.stale) return false;   // broken and re-taken meanwhile: wait for the new owner
    const victim = `${lock}.stale.${process.pid}.${rand()}`;
    try { fs.renameSync(lock, victim); } catch (e) { if (e.code === 'ENOENT') return true; throw e; }
    let same = false;
    try {
      const st = fs.lstatSync(victim);
      same = st.ino === j.ino && (j.dir ? st.isDirectory() : fs.readFileSync(victim, 'utf8') === j.body);
    } catch { same = false; }
    if (same) {
      fs.rmSync(victim, { recursive: true, force: true });
      return true;
    }
    // Not the lock judged stale: put it back, unless a newer lock already took the path.
    try { fs.linkSync(victim, lock); } catch { /* a newer lock holds the path; the renamed one's owner keeps running */ }
    try { fs.rmSync(victim, { recursive: true, force: true }); } catch { /* gone */ }
    return false;
  } finally {
    try { fs.closeSync(fd); } catch { /* closed */ }
    try { fs.unlinkSync(brk); } catch { /* removed as stale by another waiter */ }
  }
}

// ---------- the lock ----------
function lockError(ErrorClass, lock) {
  const err = new ErrorClass(`could not acquire ${lock}`);
  err.code = 'LOCK';
  return err;
}

/** Run fn while holding an exclusive lockfile (see the header). */
function withLock(lock, fn, { timeoutMs = config.LOCK_TIMEOUT_MS, staleMs = config.LOCK_STALE_MS, ErrorClass = Error } = {}) {
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 }); // in the store: private
  const deadline = Date.now() + timeoutMs;
  let fd;
  for (;;) {
    try { fd = fs.openSync(lock, 'wx', 0o600); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const j = judge(lock, staleMs);
      if (!j) continue; // released between our open and our look
      if (j.stale && breakStale(lock, staleMs)) continue;
      if (Date.now() > deadline) throw lockError(ErrorClass, lock);
      sleepSync(2 + Math.floor(Math.random() * 8));
    }
  }
  let ino = null;
  try {
    fs.writeSync(fd, ownerBody());
    ino = fs.fstatSync(fd).ino;
    return fn();
  } finally {
    fs.closeSync(fd);
    // Remove it only while it is still ours: a lock broken as stale (we were frozen) may have a new owner.
    try { if (ino == null || fs.lstatSync(lock).ino === ino) fs.unlinkSync(lock); } catch { /* already gone */ }
  }
}

export { withLock, pidStart, parseOwner };
