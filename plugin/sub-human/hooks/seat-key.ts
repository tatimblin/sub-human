// The per-seat human capability. A via=human entry ("a person typed or answered this") is signed with the
// seat's Ed25519 private key, which only hook processes load: hooks are run by Claude Code itself, never by a
// model. lib/room/store.ts append() asks the signer installed here; readers verify with the public key the
// room's log pins (join.ts puts it in member_joined: lib/room/envelope.ts).
//
//   <home>/keys/<code>/          dir 0700
//     <name>.key                 PKCS#8 PEM private key, 0600 (only this file reads it)
//     <name>.pub                 SPKI PEM public key, 0600 (beside the key; the log's pinned key is the one checked)
//
//   ensure(code, name) -> KeyObject   the seat's private key, created on first use (join.ts creates it at join)
//   publicPem(code, name) -> string   the seat's public key as SPKI PEM, for member_joined (creates it like ensure)
//   arm()                             install ensure() as this process's signer: only the handlers that sign call it
//                                     (hooks/handlers/at-room.ts, hooks/consent.ts, hooks/handlers/join.ts), as they load
//
// The room MCP server, the CLI and the tail never require this file (test/security.node-test.ts checks it), so
// they cannot sign. The Bash guard (mod/guard.ts, the hooks module) denies commands that name the keys or run these hooks.
// Threat model: one machine, one OS user. This stops a model from forging a person; it is no defence against a
// local user, who can read their own files.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as store from '../lib/room/store.ts';
import { writeFileAtomic } from '../lib/io.ts';
import { errCode } from '../lib/errors.ts';
import type { RoomCode, SeatName } from '../lib/brand.ts';

const keyPath = (code: RoomCode, name: SeatName): string => store.pubPath(name, code).replace(/\.pub$/, '.key');

function mkdir700(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* not ours to change */ }
}

/** Write data to file only if it does not exist yet (link of a private temp file: never a partial file). */
function createOnce(file: string, data: string): boolean {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeSync(fd, data); } finally { fs.closeSync(fd); }
  try { fs.linkSync(tmp, file); return true; } catch (e) { if (errCode(e) === 'EEXIST') return false; throw e; } finally {
    try { fs.unlinkSync(tmp); } catch { /* gone */ }
  }
}

const cache = new Map<string, crypto.KeyObject>(); // key file -> KeyObject

function ensure(code: RoomCode, name: SeatName): crypto.KeyObject {
  const file = keyPath(code, name);
  const hit = cache.get(file);
  if (hit) return hit;
  mkdir700(path.dirname(file));
  let pem: string | null = null;
  try { pem = fs.readFileSync(file, 'utf8'); } catch (e) { if (errCode(e) !== 'ENOENT') throw e; }
  if (!pem) {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    createOnce(file, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()); // PEM: always a string
    pem = fs.readFileSync(file, 'utf8'); // ours, or the one a concurrent hook created first
  }
  const key = crypto.createPrivateKey(pem);
  const pub = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' });
  const pubFile = store.pubPath(name, code);
  let cur: string | null = null;
  try { cur = fs.readFileSync(pubFile, 'utf8'); } catch { /* none yet */ }
  if (cur !== pub) writeFileAtomic(pubFile, pub, { mode: 0o600 });
  cache.set(file, key);
  return key;
}

const publicPem = (code: RoomCode, name: SeatName): string => crypto.createPublicKey(ensure(code, name)).export({ type: 'spki', format: 'pem' }).toString(); // PEM: always a string

// globalThis has no declared slot for the signer: lib/room/store.ts reads it back by the same symbol
function arm(): void { (globalThis as Record<symbol, unknown>)[store.SIGNER] = ensure; }

export { ensure, publicPem, arm, keyPath };
