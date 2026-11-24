// The verbs' Ctx on a real machine: session pointers and rooms read from the home, git through execFile. Every write
// goes to the daemon, which the caller hands in.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.js';
import { TIMINGS } from '../config.js';
import { CODE, SESSION_ID, decodePointer, sessionFile } from '../core/api.js';
import { err, ok } from '../core/result.js';
import type { Membership } from './membership.js';
import type { Ctx, Daemon, Rooms, Run, Sessions } from './types.js';

const PLUGIN = fileURLToPath(new URL('..', import.meta.url));

export function nodeCtx(o: { config: Config; session: string; cwd: string; daemon: Daemon }): Ctx {
  return {
    ...o,
    now: Date.now,
    uuid: randomUUID,
    rooms: fsRooms(o.config.home),
    sessions: fsSessions(o.config.home),
    run: execRun,
    readFile: rel => fs.readFile(`${PLUGIN}${rel}`, 'utf8').catch(() => null),
    nodeVersion: process.versions.node,
  };
}

export function fsRooms(home: string): Rooms {
  return {
    codes: async () => (await fs.readdir(`${home}/rooms`).catch(() => [])).filter(c => CODE.test(c)).sort(),
    state: async code => {
      // loaded at first use: the hooks that only read a pointer never load the store
      const [{ openFsStore }, { fold }] = await Promise.all([import('../store/fs-store.js'), import('../core/fold.js')]);
      const store = await openFsStore({ home, code });
      if (!store.ok) return store;
      const c = await store.value.catchup();
      return c.ok ? ok(fold(c.value.snapshot, c.value.lines, await store.value.docs())) : err(`the log of ${code} does not read (${c.error})`);
    },
  };
}

export function fsSessions(home: string): Sessions {
  const read = async (id: string): Promise<Membership | null> => {
    if (!SESSION_ID.test(id)) return null;
    const p = decodePointer(await fs.readFile(sessionFile(home, id), 'utf8').catch(() => ''));
    return p && CODE.test(p.code) ? { id, ...p } : null;
  };
  return {
    get: read,
    all: async () => {
      const names = (await fs.readdir(`${home}/sessions`).catch(() => [])).filter(n => n.endsWith('.json'));
      return (await Promise.all(names.map(n => read(n.slice(0, -'.json'.length))))).filter(m => m !== null);
    },
  };
}

const execRun: Run = (program, args, cwd) => new Promise(resolve => {
  execFile(program, [...args], { cwd, timeout: TIMINGS.run, encoding: 'utf8' }, (e, stdout) => {
    resolve(e ? null : stdout.trim() || null);
  });
});
