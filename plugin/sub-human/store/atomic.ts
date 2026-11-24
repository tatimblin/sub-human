// A crash-safe write (ARCHITECTURE §2a, in place of write-file-atomic): a temp file beside the target, fsynced, then
// renamed over it, so a reader sees the old text or the new, never part of one. The target is never opened.
import fs from 'node:fs/promises';
import path from 'node:path';

export async function writeAtomic(file: string, text: string): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    const fh = await fs.open(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(text);
      await fh.sync();
    } finally { await fh.close(); }
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.unlink(tmp).catch(() => undefined);
    throw e;
  }
  // the rename itself survives a power loss once the directory is synced; some platforms can't open one
  const d = await fs.open(dir, 'r').catch(() => null);
  if (d) { await d.sync().catch(() => undefined); await d.close(); }
}

/** The codes that say the home can't be written at all (a sandbox gone, a read-only disk, lost permissions). */
const FATAL = new Set(['ENOSYS', 'EROFS', 'EACCES', 'EPERM', 'EOPNOTSUPP']);
/** `e`'s code when it says the home can't be written, else null. */
export function fatal(e: unknown): string | null {
  const code = e instanceof Error && 'code' in e ? e.code : undefined;
  return typeof code === 'string' && FATAL.has(code) ? code : null;
}

/** Whether a file can be made in `dir` as writeAtomic makes one: the error, or null when it can. */
export async function probe(dir: string): Promise<unknown> {
  const file = path.join(dir, `write-probe.${process.pid}`);
  try {
    await (await fs.open(file, 'wx', 0o600)).close();
    await fs.unlink(file);
    return null;
  } catch (e) {
    await fs.unlink(file).catch(() => undefined);
    return e;
  }
}
