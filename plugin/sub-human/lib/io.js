'use strict';
/**
 * plugin/sub-human/lib/io.js: small file and process helpers shared by every module. Zero dependencies.
 *
 *   readJson(file, fallback = null)       parsed JSON, or fallback when the file is missing or unparseable
 *   writeFileAtomic(file, data, opts)     write a temp file beside it, then rename over it, so a reader never
 *                                         sees a partial file. opts:
 *                                           fsync: true   flush the temp file before the rename (durable)
 *                                           mode          the file mode. Default: an existing file keeps its
 *                                                         mode; a new file is 0o600 (the store is private)
 *                                         The parent directory is created (recursive, default mode).
 *   writeJsonAtomic(file, value, opts)    the same for JSON. opts.compact: one line, no trailing newline;
 *                                         otherwise pretty-printed (2 spaces) with a trailing newline.
 *   isAlive(pid) -> bool                  the pid exists (EPERM counts as alive: it exists, owned by another user)
 *   sleepSync(ms)                         block this thread (for the sync lock and poll loops in hooks)
 */

const fs = require('node:fs');
const path = require('node:path');

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeFileAtomic(file, data, { fsync = false, mode } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (mode === undefined) {
    try { mode = fs.statSync(file).mode & 0o777; } catch { mode = 0o600; }
  }
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'wx', mode);
    try {
      fs.writeSync(fd, data);
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

function writeJsonAtomic(file, value, { compact = false, ...opts } = {}) {
  writeFileAtomic(file, compact ? JSON.stringify(value) : JSON.stringify(value, null, 2) + '\n', opts);
}

function isAlive(pid) {
  pid = Number(pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const sleepSync = ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

module.exports = { readJson, writeFileAtomic, writeJsonAtomic, isAlive, sleepSync };
