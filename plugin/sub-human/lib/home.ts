/**
 * plugin/sub-human/lib/home.ts: where the plugin's store lives on this machine, and which machine this is. Zero
 * dependencies beyond text.ts. Both lib/identity.ts (session indexes) and lib/room/store.ts (room state) need
 * it, and identity requires the store, so it lives here rather than in either.
 *
 *   home() -> string            SUB_HUMAN_HOME, else ~/.sub-human (read on every call)
 *   roomsDir() -> string        <home>/rooms
 *   roomDir(code) -> string     <home>/rooms/<code>; throws on a code that is not CODE_RE
 *   machineId() -> string       this machine's id, <home>/machine.json {id}: 16 random hex digits made once
 *                               (never the hostname), cached per home. A seat record's `machine`.
 *   repairModes() -> string[]   once per home and process: the home and its top-level store directories
 *                               (rooms, sessions, links, keys, bin) that exist, are this user's and are open to
 *                               group or others are made 0700 (a home made by an older version was 0755). Creates
 *                               nothing. Returns the directories it changed. lib/room/store.ts open() runs it.
 *   isTempPath(p) -> bool       p is inside a temp dir (os.tmpdir(), /tmp, /private/tmp, /var/tmp), lexically or
 *                               after realpath. A plugin root there is not recorded for the launchers in
 *                               <home>/bin (hooks/launcher.ts, lib/remote/shim.ts): anything on the machine
 *                               can delete and re-create a temp path, and the launcher would run what sits there.
 *   allowTmpRoot(env?) -> bool  SUB_HUMAN_ALLOW_TMP_ROOT=1 (tests, the demo): record a temp root anyway.
 *   Every store directory is created 0700 (here, lib/io.ts, lib/lock.ts, lib/room/*).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { CODE_RE } from './text.ts';
import { homeOf } from '../mod/core/seat.ts';

// the rule is mod/core/seat.ts homeOf's: the hooks module finds the store without node by the same one
const home = (): string => homeOf(process.env.SUB_HUMAN_HOME, os.homedir()) || path.join(os.homedir(), '.sub-human');
const roomsDir = (): string => path.join(home(), 'rooms');
function roomDir(code: unknown): string {
  if (typeof code !== 'string' || !CODE_RE.test(code)) throw new Error(`invalid room code "${code}"`);
  return path.join(roomsDir(), code);
}

const readId = (file: string): string | null => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).id || null; } catch { return null; } };
/** The id in file, else a new one linked into place (the first of two racing processes wins; both read it). */
function readOrMakeId(file: string): string | null {
  const cur = readId(file);
  if (cur) return cur;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ id: crypto.randomBytes(8).toString('hex') }) + '\n', { mode: 0o600 });
  try { fs.linkSync(tmp, file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } finally { fs.rmSync(tmp, { force: true }); }
  return readId(file);
}
const machines = new Map<string, string | null>(); // home -> id
function machineId(): string | null {
  const h = home();
  if (!machines.has(h)) machines.set(h, readOrMakeId(path.join(h, 'machine.json')));
  return machines.get(h) ?? null;
}

const repaired = new Set<string>(); // homes checked in this process
function repairModes(): string[] {
  const h = home();
  if (repaired.has(h)) return [];
  repaired.add(h);
  const changed: string[] = [];
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  for (const d of [h, ...['rooms', 'sessions', 'links', 'keys', 'bin'].map(n => path.join(h, n))]) {
    try {
      const st = fs.lstatSync(d);
      if (!st.isDirectory() || (uid !== null && st.uid !== uid) || !(st.mode & 0o077)) continue;
      fs.chmodSync(d, 0o700);
      changed.push(d);
    } catch { /* absent, or not ours to change */ }
  }
  return changed;
}

const realish = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const TMP_DIRS = (): string[] => [
  ...new Set([os.tmpdir(), '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp'].flatMap(d => [path.resolve(d), realish(d)])),
];
function isTempPath(p: string): boolean {
  const cands = [path.resolve(p), realish(p)];
  return TMP_DIRS().some(t => cands.some(c => c === t || c.startsWith(t + path.sep)));
}
const allowTmpRoot = (env: NodeJS.ProcessEnv = process.env): boolean => env.SUB_HUMAN_ALLOW_TMP_ROOT === '1';

export { home, roomsDir, roomDir, machineId, repairModes, isTempPath, allowTmpRoot };
