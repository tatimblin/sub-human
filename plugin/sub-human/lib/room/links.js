'use strict';
/**
 * plugin/sub-human/lib/room/links.js: the link registry on this machine: which rooms are mirrors of a room hosted
 * elsewhere, and how to reach them. One file per room, <home>/links/<code>.json (dir 0700, file 0600). Read by
 * lib/room/store.js open() (a linked code gets a MirrorRoomStore) and roomExists(); written by the join hook
 * (`/sub-human join NAME INVITE`) and the link daemon (lib/remote/link.js, the resume point). Machine-local,
 * like the session indexes: it never syncs. Zero dependencies beyond lib/home.js and lib/io.js.
 * Stub: filled in by PR5 of docs/next/REMOTE-PLAN.md.
 *
 * Link = {code, transport: {kind: 'pipe' | 'memory' | …, ...spec}, token, machine, host?: string,
 *         last?: {id, hash}, created_at}
 *   token    the link's credential (the server keeps its sha256): kept in clear here, like the seat key
 *   last     the mirror's last synced line, for subscribe {after, hash}; the daemon advances it
 *
 *   get(code) -> Link | null
 *   set(code, link) -> Link          atomic write; validates the code and the shape
 *   remove(code) -> bool
 *   list() -> [code]
 *   linksDir() -> string
 */

const todo = what => { throw new Error(`sub-human: ${what} is not implemented yet (docs/next/REMOTE-PLAN.md, PR5)`); };

/** @returns {string} <home>/links */
function linksDir() { return todo('links.linksDir()'); }

/**
 * @param {string} code
 * @returns {object | null}
 */
function get(code) { return todo(`links.get(${code})`); }

/**
 * @param {string} code
 * @param {object} link
 * @returns {object}
 */
function set(code, link) { return todo(`links.set(${code}, ${link && link.transport && link.transport.kind})`); }

/**
 * @param {string} code
 * @returns {boolean}
 */
function remove(code) { return todo(`links.remove(${code})`); }

/** @returns {string[]} */
function list() { return todo('links.list()'); }

module.exports = { linksDir, get, set, remove, list };
