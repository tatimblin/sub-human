// How long a room hosted here is kept once nobody uses it (R3). Every entry and every member document (each turn renews
// a presence) rewrites the room's tail, stamped by the host's clock, so the tail's `at` is when someone was last there.
import fs from 'node:fs/promises';
import { tailFile } from '../home.js';
import { parseTail } from './store.js';

export const RETAIN_MS: number = 30 * 24 * 3600_000;

/** The files in folder `dir` last written before `before`, deleted. */
export async function dropOld(dir: string, before: number): Promise<void> {
  for (const n of await fs.readdir(dir).catch(() => [])) {
    const f = `${dir}/${n}`;
    if (await fs.stat(f).then(x => x.mtimeMs < before, () => false)) await fs.rm(f, { force: true });
  }
}

/** Whether the room in `dir` has had no write for RETAIN_MS; one whose tail doesn't read is kept. */
export async function unused(dir: string, now: number): Promise<boolean> {
  const t = parseTail(await fs.readFile(tailFile(dir), 'utf8').catch(() => ''));
  return t.ok && now - t.value.at > RETAIN_MS;
}
