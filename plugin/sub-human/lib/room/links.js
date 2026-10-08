'use strict';
/**
 * plugin/sub-human/lib/room/links.js: the link registry on this machine: which rooms are mirrors of a room hosted
 * elsewhere, and how to reach them. One file per room, <home>/links/<code>.json (dir 0700, file 0600). Read by
 * lib/room/store.js open() (a linked code gets a MirrorRoomStore) and roomExists(); written by the join hook
 * (`/sub-human join NAME INVITE`) and the link daemon (lib/remote/link.js, which swaps the invite for its token).
 * Machine-local, like the session indexes: it never syncs. Zero dependencies beyond lib/home.js, lib/io.js and
 * lib/text.js.
 *
 * Link = {code, transport: {kind: 'pipe', home} | …, token?, invite?, pin?, created_at}
 *   transport  how the daemon reaches the host's server (lib/remote/link.js transportOf: an invite's locator), plus
 *              what this machine adds for ssh (lib/remote/transports/ssh.js: key, knownHosts, alias, mux), files in
 *              dirOf(code)
 *   invite     the invite the daemon redeems at its first hello, until it holds the token
 *   pin        an sh2 invite's PIN, sent with it at that hello and dropped with it (the host checks it)
 *   token      the link's credential (the server keeps its sha256): kept in clear here, like the seat key
 * The resume point is the mirror itself (its last line and that line's hash), not a field here.
 *
 *   get(code) -> Link | null          null for a code that is not CODE_RE
 *   set(code, link) -> Link           atomic write; RoomError INVALID for a bad code or shape
 *   remove(code) -> bool
 *   list() -> [code]
 *   linksDir() -> string              <home>/links
 *   logFile(code) -> string           <home>/links/<code>.log: the daemon's stderr
 *   dirOf(code) -> string             <home>/links/<code>/: the link's own ssh key and pinned known_hosts (0700);
 *                                     remove() deletes it too
 */

const fs = require('node:fs');
const path = require('node:path');
const { home } = require('../home.js');
const { readJson, writeJsonAtomic } = require('../io.js');
const { CODE_RE } = require('../text.js');
const { RoomError } = require('./validate.js');

/** @returns {string} <home>/links */
const linksDir = () => path.join(home(), 'links');

function fileOf(code, ext = 'json') {
  if (typeof code !== 'string' || !CODE_RE.test(code)) throw new RoomError('INVALID', `invalid room code "${code}"`);
  return path.join(linksDir(), `${code}.${ext}`);
}

/**
 * @param {string} code
 * @returns {object | null}
 */
const get = code => (typeof code === 'string' && CODE_RE.test(code) ? readJson(fileOf(code)) : null);

const credential = l => typeof l.token === 'string' || typeof l.invite === 'string';

/**
 * @param {string} code
 * @param {object} link
 * @returns {object}
 */
function set(code, link) {
  const file = fileOf(code);
  if (!link || link.code !== code || !link.transport || typeof link.transport.kind !== 'string' || !credential(link)) {
    throw new RoomError('INVALID', `a link needs {code: "${code}", transport: {kind}, token or invite}`);
  }
  fs.mkdirSync(linksDir(), { recursive: true, mode: 0o700 });
  writeJsonAtomic(file, link, { mode: 0o600 });
  return link;
}

/**
 * @param {string} code
 * @returns {boolean}
 */
function remove(code) {
  try { fs.rmSync(dirOf(code), { recursive: true, force: true }); } catch { /* none */ }
  try { fs.unlinkSync(fileOf(code)); return true; } catch { return false; }
}

/**
 * @param {string} code
 * @returns {string}
 */
const dirOf = code => fileOf(code).slice(0, -'.json'.length);

/** @returns {string[]} */
function list() {
  let names;
  try { names = fs.readdirSync(linksDir()); } catch { return []; }
  return names.filter(n => n.endsWith('.json') && CODE_RE.test(n.slice(0, -5))).map(n => n.slice(0, -5)).sort();
}

/**
 * @param {string} code
 * @returns {string}
 */
const logFile = code => fileOf(code, 'log');

module.exports = { linksDir, get, set, remove, list, logFile, dirOf };
