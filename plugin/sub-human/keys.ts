// This home's machine key: the X25519 key Noise proves this machine with (ARCHITECTURE §8), made on first use and kept
// in the home with mode 0600. The file holds the private key's 32 bytes as hex, and nothing else.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { generateKeyPair, keyPair } from './net/channel.js';
import type { KeyPair } from './net/channel.js';
import type { Result } from './core/result.js';
import { err, ok } from './core/result.js';

export function machineKeyFile(home: string): string { return `${home}/keys/machine.key`; }

/**
 * The home's machine key, made now when there is none. A new key is written whole to a temp file and linked into
 * place, which fails when a key is there: two first uses at once both get the one that won, and none sees half a file.
 */
export async function machineKey(home: string): Promise<Result<KeyPair>> {
  const file = machineKeyFile(home);
  const have = await readKey(file);
  if (have.ok || !(await missing(file))) return have;
  // an earlier v2 build kept the key as noise.key: renamed (a link, which never replaces a key) so its links still hold
  const old = `${home}/keys/noise.key`;
  if (await fs.link(old, file).then(() => true, () => false)) {
    await fs.unlink(old).catch(() => undefined);
    return readKey(file); // and its mode checked
  }
  const made = generateKeyPair();
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.mkdir(`${home}/keys`, { recursive: true, mode: 0o700 });
    await fs.writeFile(tmp, `${made.priv.toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
    await fs.link(tmp, file);
    return ok(made);
  } catch (e) {
    return codeOf(e) === 'EEXIST' ? readKey(file) : err(`the machine key was not written (${codeOf(e) ?? String(e)})`);
  } finally {
    await fs.unlink(tmp).catch(() => undefined);
  }
}

const codeOf = (e: unknown): string | undefined => {
  const c: unknown = e instanceof Error ? Reflect.get(e, 'code') : undefined;
  return typeof c === 'string' ? c : undefined;
};
const missing = (file: string): Promise<boolean> => fs.stat(file).then(() => false, (e: unknown) => codeOf(e) === 'ENOENT');

async function readKey(file: string): Promise<Result<KeyPair>> {
  const text = (await fs.readFile(file, 'utf8').catch(() => '')).trim();
  if (!/^[0-9a-f]{64}$/.test(text)) return err(`the machine key in ${file} is not readable; move it aside and run /room again`);
  const { mode } = await fs.stat(file);
  if ((mode & 0o077) !== 0) return err(`the machine key in ${file} can be read by others; run chmod 600 on it`);
  return ok(keyPair(Buffer.from(text, 'hex')));
}
