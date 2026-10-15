/**
 * plugin/sub-human/lib/room/keys.ts: where the seats' keys live on this machine, <home>/keys/<code>/ (dir 0700;
 * hooks/seat-key.ts creates them; the private keys never leave this machine, whatever the store). The stores read
 * only the public half, and only for a legacy room (one whose log pins no key: trust.ts publicKey).
 *
 *   keyDir(code), pubPath(name, code)   RoomError INVALID for a code or name that is not a safe file name
 *   localKey(name, code) -> KeyObject|null   <code>/<name>.pub, cached until the file changes
 *   hasLocalKey(name, code) -> bool     the file exists (readable or not): the seat has a key, so its unsigned words
 *                                       are never legacy
 *   machineKeyFile() -> <home>/keys/machine.json   this home's machine key (lib/remote/machine-key.ts), beside the seats'
 */

import fs from 'node:fs';
import path from 'node:path';
import { home } from '../home.ts';
import { RoomError } from './validate.ts';
import * as envelope from './envelope.ts';
import type { KeyObject } from 'node:crypto';

const KEY_PART_RE = /^[A-Za-z0-9_.-]{1,64}$/;
function keyDir(c: unknown): string {
  if (typeof c !== 'string' || !KEY_PART_RE.test(c) || c.startsWith('.')) throw new RoomError('INVALID', `invalid room code "${c}"`);
  return path.join(home(), 'keys', c);
}
function pubPath(name: unknown, c: unknown): string {
  if (typeof name !== 'string' || !KEY_PART_RE.test(name) || name.startsWith('.')) throw new RoomError('INVALID', `invalid name "${name}"`);
  return path.join(keyDir(c), `${name}.pub`);
}

const pubCache = new Map<string, { mtimeMs: number; size: number; key: KeyObject | null }>(); // file -> {mtimeMs, size, key}
function localKey(name: string, c: string): KeyObject | null {
  let file: string;
  try { file = pubPath(name, c); } catch { return null; }
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { pubCache.delete(file); return null; }
  const hit = pubCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.key;
  let key = null;
  try { key = envelope.parseKey(fs.readFileSync(file, 'utf8')); } catch { key = null; }
  pubCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, key });
  return key;
}
function hasLocalKey(name: string, c: string): boolean {
  try { return fs.existsSync(pubPath(name, c)); } catch { return true; } // an unsafe name: never legacy
}

const machineKeyFile = (): string => path.join(home(), 'keys', 'machine.json');

export { keyDir, pubPath, localKey, hasLocalKey, machineKeyFile };
