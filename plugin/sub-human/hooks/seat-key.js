'use strict';
// The per-seat human capability. A via=human entry ("a person typed or answered this") is signed with the
// seat's Ed25519 private key, which only hook processes load: hooks are run by Claude Code itself, never by a
// model. lib/room/store.js append() asks the signer installed here; readers verify with the public key.
//
//   <home>/keys/<code>/          dir 0700
//     <name>.key                 PKCS#8 PEM private key, 0600 (only this file reads it)
//     <name>.pub                 SPKI PEM public key, 0600 (store.verifyHuman reads it)
//
//   ensure(code, name) -> KeyObject   the seat's private key, created on first use (join.js creates it at join;
//                                     a hook creates it lazily for a seat that joined before keys existed)
//   arm()                             install ensure() as this process's signer (hooks/common.js, every hook)
//
// The room MCP server, the CLI and the tail never require this file (test/security.test.js checks it), so
// they cannot sign. The Bash guard (mod/guard.mjs, the hooks module) denies commands that name the keys or run these hooks.
// Threat model: one machine, one OS user. This stops a model from forging a person; it is no defence against a
// local user, who can read their own files.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require(path.join(__dirname, '..', 'lib', 'room', 'store.js'));
const { writeFileAtomic } = require(path.join(__dirname, '..', 'lib', 'io.js'));

const keyPath = (code, name) => store.pubPath(name, code).replace(/\.pub$/, '.key');

function mkdir700(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* not ours to change */ }
}

/** Write data to file only if it does not exist yet (link of a private temp file: never a partial file). */
function createOnce(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeSync(fd, data); } finally { fs.closeSync(fd); }
  try { fs.linkSync(tmp, file); return true; } catch (e) { if (e.code === 'EEXIST') return false; throw e; } finally {
    try { fs.unlinkSync(tmp); } catch { /* gone */ }
  }
}

const cache = new Map(); // key file -> KeyObject

function ensure(code, name) {
  const file = keyPath(code, name);
  const hit = cache.get(file);
  if (hit) return hit;
  mkdir700(path.dirname(file));
  let pem = null;
  try { pem = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!pem) {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    createOnce(file, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    pem = fs.readFileSync(file, 'utf8'); // ours, or the one a concurrent hook created first
  }
  const key = crypto.createPrivateKey(pem);
  const pub = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' });
  const pubFile = store.pubPath(name, code);
  let cur = null;
  try { cur = fs.readFileSync(pubFile, 'utf8'); } catch { /* none yet */ }
  if (cur !== pub) writeFileAtomic(pubFile, pub, { mode: 0o600 });
  cache.set(file, key);
  return key;
}

function arm() { globalThis[store.SIGNER] = ensure; }

module.exports = { ensure, arm };
