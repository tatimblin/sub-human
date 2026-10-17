/**
 * plugin/sub-human/lib/cc/tasklock.ts: the lock Claude Code takes on its task files, spoken from outside, so the
 * plugin's writes to the room's task list (lib/room/task-files.ts) and Claude Code's own (TaskCreate, TaskUpdate, the
 * list reset) never interleave. Claude Code bundles proper-lockfile: a lock is mkdir(<realpath(target)>.lock), whose
 * mtime it refreshes every 5 s while held; one older than 10 s is stale and removed with rmdir; release is rmdir. It
 * retries 30 times, 5 to 100 ms apart. Synchronous (the MCP server's and the link server's ops are), and held for
 * milliseconds only, so no refresh is needed: a hold never nears the 10 s at which Claude Code would call it stale.
 *
 *   withListLock(dir, fn) -> fn()   the list lock: target <dir>/.lock (an empty file, made with wx), dir <dir>/.lock.lock
 *   withTaskLock(dir, id, fn) -> fn()   a task's lock: target <dir>/<id>.json, dir <id>.json.lock; a task with no
 *                                   file yet takes none (proper-lockfile realpaths its target, which must exist)
 * Both throw an Error with code 'LOCK' after timeoutMs (TASK_LOCK_TIMEOUT_MS).
 */

import fs from 'node:fs';
import path from 'node:path';
import { sleepSync } from '../io.ts';
import { errCode } from '../errors.ts';

/** A lock dir older than this is stale (proper-lockfile's default, which Claude Code keeps). */
const STALE_MS = 10_000;
/** How long the plugin waits for a lock Claude Code holds (it holds one for a file write). */
const TASK_LOCK_TIMEOUT_MS = 3000;

const lockError = (dir: string): Error => Object.assign(new Error(`could not acquire ${dir}`), { code: 'LOCK' });

/**
 * mkdir(<realpath(target)>.lock): taken when the mkdir succeeds; a dir whose mtime is over STALE_MS old is removed and
 * taken again. Run fn, then rmdir.
 * @cc {retries:{retries:30,minTimeout:5,maxTimeout:100}
 * @stability incidental
 */
function withLock<T>(target: string, fn: () => T, { timeoutMs = TASK_LOCK_TIMEOUT_MS }: { timeoutMs?: number } = {}): T {
  const dir = `${fs.realpathSync(target)}.lock`;
  const deadline = Date.now() + timeoutMs;
  let wait = 5;
  for (;;) {
    try { fs.mkdirSync(dir); break; } catch (e) {
      if (errCode(e) !== 'EEXIST') throw e;
      let stale = false;
      try { stale = fs.statSync(dir).mtimeMs < Date.now() - STALE_MS; } catch { continue; } // released meanwhile
      if (stale) { try { fs.rmdirSync(dir); } catch { /* another took it first */ } continue; }
      if (Date.now() > deadline) throw lockError(dir);
      sleepSync(wait);
      wait = Math.min(wait * 2, 100);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(dir); } catch { /* removed as stale */ } }
}

/**
 * The list lock (create, reset and restore take it): target <dir>/.lock, an empty file made with flag wx.
 * @cc return r.lockfilePath||`${e}.lock`}
 * @stability incidental
 */
function withListLock<T>(dir: string, fn: () => T, opts?: { timeoutMs?: number }): T {
  fs.mkdirSync(dir, { recursive: true });
  try { fs.writeFileSync(path.join(dir, '.lock'), '', { flag: 'wx' }); } catch (e) { if (errCode(e) !== 'EEXIST') throw e; }
  return withLock(path.join(dir, '.lock'), fn, opts);
}

/**
 * A task's lock (update and claim take it, not the list lock): target <dir>/<id>.json. None while the file does not
 * exist yet: Claude Code's lock realpaths the target, so it takes none on a missing file either.
 * @cc [Tasks] updateTask
 * @stability incidental
 */
function withTaskLock<T>(dir: string, id: string | number, fn: () => T, opts?: { timeoutMs?: number }): T {
  const file = path.join(dir, `${id}.json`);
  return fs.existsSync(file) ? withLock(file, fn, opts) : fn();
}

export { withListLock, withTaskLock, STALE_MS, TASK_LOCK_TIMEOUT_MS };
