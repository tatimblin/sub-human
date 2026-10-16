/**
 * plugin/sub-human/lib/io.ts: small file and process helpers shared by every module. Zero dependencies.
 *
 *   readJson(file, d, fallback) -> T | F  the file's JSON as the decoder d (lib/decode.ts) reads it; fallback when the
 *                                         file is missing, unparseable, or d refuses it
 *   readJsonRaw(file) -> unknown          the file's parsed JSON, undefined when missing or unparseable
 *   writeFileAtomic(file, data, opts)     write a temp file beside it, then rename over it, so a reader never
 *                                         sees a partial file. opts:
 *                                           fsync: true   flush the temp file before the rename (durable)
 *                                           mode          the file mode. Default: an existing file keeps its
 *                                                         mode; a new file is 0o600 (the store is private)
 *                                         The parent directory is created (recursive, 0o700: the store is
 *                                         private, and this may be the first write into a new home).
 *   writeJsonAtomic(file, value, opts)    the same for JSON. opts.compact: one line, no trailing newline;
 *                                         otherwise pretty-printed (2 spaces) with a trailing newline.
 *   validPid(pid) -> bool                 a positive integer
 *   isAlive(pid) -> bool                  the pid exists (EPERM counts as alive: it exists, owned by another user)
 *   sleepSync(ms)                         block this thread (for the sync lock and poll loops in hooks)
 *   readInput({strict = true}?) -> unknown  the process's stdin JSON ({} when empty, falsy, or stdin is a terminal).
 *                                         strict: a parse error throws; otherwise it gives {}. The caller decodes it. scripts/sub-human
 *                                         reads with it (the hooks read stdin in hooks/run.ts); the CLI must never
 *                                         load a hook handler that arms the human signer (at-room, consent, join).
 *   lazy<typeof XMod>(import.meta.url, './x.ts') -> () => XMod
 *                                         a module loaded at the first call and kept (createRequire relative to the
 *                                         caller's import.meta.url: require(esm) is synchronous and caches like an
 *                                         import). The type is the namespace of `import type * as XMod from './x.ts'`
 *                                         (erased), with the same specifier: scripts/test/lazy.test.ts checks every
 *                                         call. Here, not in a module of its own, so no hook loads one more file.
 *   loadAt<M>(import.meta.url, id) -> M   a module whose path is computed at run time (a transport kind, a room
 *                                         plug-in, the bridge's handler, a doctor lib); the caller names what it
 *                                         expects, and scripts/test/lazy.test.ts allows it only in those files.
 */

import fs from 'node:fs';
import path from 'node:path';
import TtyMod from 'node:tty';
import { createRequire } from 'node:module';
import type { Decoder } from './decode.ts';
import { errCode } from './errors.ts';

/** The file's parsed JSON: unknown until decoded; undefined when the file is missing or unparseable. */
function readJsonRaw(file: string): unknown {
  try { const v: unknown = JSON.parse(fs.readFileSync(file, 'utf8')); return v; } catch { return undefined; }
}

/** The file's JSON as d reads it, else fallback (missing, unparseable, or refused). */
function readJson<T>(file: string, d: Decoder<T>, fallback: NoInfer<T>): T;
function readJson<T, F>(file: string, d: Decoder<T>, fallback: F): T | F;
function readJson<T, F>(file: string, d: Decoder<T>, fallback: F): T | F {
  let v: unknown;
  try { v = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  const r = d(v);
  return r.ok ? r.value : fallback;
}

interface WriteOpts { fsync?: boolean; mode?: number }

function writeFileAtomic(file: string, data: string | NodeJS.ArrayBufferView, { fsync = false, mode }: WriteOpts = {}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (mode === undefined) {
    try { mode = fs.statSync(file).mode & 0o777; } catch { mode = 0o600; }
  }
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'wx', mode);
    try {
      if (typeof data === 'string') fs.writeSync(fd, data); else fs.writeSync(fd, data); // one overload each
      if (fsync) fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    // openSync's mode is filtered by the umask; set it exactly.
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* never created, or already renamed */ }
    throw e;
  }
}

function writeJsonAtomic(file: string, value: unknown, { compact = false, ...opts }: WriteOpts & { compact?: boolean } = {}): void {
  writeFileAtomic(file, compact ? JSON.stringify(value) : JSON.stringify(value, null, 2) + '\n', opts);
}

const validPid = (pid: unknown): pid is number => Number.isInteger(pid) && (pid as number) > 0;

function isAlive(pid: unknown): boolean {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (e) { return errCode(e) === 'EPERM'; }
}

const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

// The stdin JSON is an untyped boundary (a hook input, a CLI request): the caller decodes it.
function readInput({ strict = true }: { strict?: boolean } = {}): unknown {
  if (TtyMod.isatty(0)) return {};
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  if (!raw.trim()) return {};
  try { const v: unknown = JSON.parse(raw); return v || {}; } catch (e) {
    if (strict) throw e;
    return {};
  }
}

/** A module that loads at its first use: past an early exit (a hook, the CLI's commands, the status line), or across
 * an import cycle. Memoized, and require's own cache holds it too. */
function lazy<M>(from: string, spec: string): () => M {
  let got: { mod: M } | null = null;
  return () => (got ??= { mod: loadAt<M>(from, spec) }).mod;
}

/** A module by a path computed at run time, from the caller's import.meta.url (see lazy). */
function loadAt<M>(from: string, id: string): M {
  const load: <T>(id: string) => T = createRequire(from);
  return load<M>(id);
}

export { readJson, readJsonRaw, writeFileAtomic, writeJsonAtomic, validPid, isAlive, sleepSync, readInput, lazy, loadAt };
