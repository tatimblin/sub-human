/**
 * plugin/sub-human/lib/room/links.ts: the link registry on this machine: which rooms are mirrors of a room hosted
 * elsewhere, and how to reach them. One file per room, <home>/links/<code>.json (dir 0700, file 0600). Read by
 * lib/room/store.ts open() (a linked code gets a MirrorRoomStore) and roomExists(); written by the join hook
 * (`/sub-human join`) and the link daemon (lib/remote/link.ts, which swaps the invite for its token).
 * Machine-local, like the session indexes: it never syncs. Zero dependencies beyond lib/home.ts, lib/io.ts and
 * lib/text.ts.
 *
 * Link = {code, transport: {kind: 'pipe', home} | …, token?, invite?, pin?, enroll?, awaiting?, refused?, request?, rebind?, moved?, created_at}
 *   transport  how the daemon reaches the host's server (lib/remote/link.ts transportOf: an invite's locator), plus
 *              what this machine adds for ssh (lib/remote/transports/ssh.ts: key, knownHosts, alias, mux), files in
 *              dirOf(code); or a login link's {kind: 'ssh', user, host, port?, via?, login: true, link, remoteHome?, mux?}
 *              (`/sub-human join USER@HOST ROOM`, ssh.ts loginSpec): no invite, no key or host key of its own
 *   invite     the invite the daemon redeems at its first hello, until it holds the token
 *   pin        an sh2 invite's PIN, sent with it at that hello and dropped with it (the host checks it)
 *   token      the link's credential (the server keeps its sha256): kept in clear here, like the seat key
 *   refused    {at, reason}: the host refused the invite before any token (a wrong PIN, burnt, used, expired); the
 *              daemon then dropped invite, pin and rebind (lib/remote/link.ts), so no spent secret stays here
 *   request    an ssh link's key the host has not let in yet (a handoff's follower: lib/remote/hosting.ts
 *              linkTransport; no secret in it)
 *   join_as    the name the seat takes once the host lets a PIN join in (lib/remote/joining.ts: a bare /sub-human takes it)
 *   join_sid   the session that typed that join: its tail tells the person when the host let it in
 *   enroll     {pin, name, kind, attempts?}: a short invite's join (lib/remote/enroll.ts) not run yet: the 4-digit PIN
 *              the daemon runs CPace with, dropped once the host answered it (a wrong PIN, or it held)
 *   awaiting   {at, ref, check, expires_at}: the PIN held and the host person's card decides (no secret in it); the
 *              invite then is the admission secret the host sent inside the PAKE channel
 *   moved      {epoch, host, locator, at?, reached_at?, demoted?}: a handoff or promote re-pointed this link
 * The resume point is the mirror itself (its last line and that line's hash), not a field here.
 *
 *   get(code) -> Link | null          null for a code that is not CODE_RE
 *   has(code) -> bool                 a link file exists (one stat: lib/room/store.ts open() asks on every call)
 *   set(code, link) -> Link           atomic write; RoomError INVALID for a bad code or shape
 *   remove(code) -> bool
 *   list() -> [code]
 *   linksDir() -> string              <home>/links
 *   logFile(code) -> string           <home>/links/<code>.log: the daemon's stderr
 *   dirOf(code) -> string             <home>/links/<code>/: the link's own ssh key and pinned known_hosts (0700);
 *                                     remove() deletes it too
 *
 * The link's state, for observers (doctor, the statusline, the room row): <home>/links/<code>.state.json (0600),
 * written by the link daemon (lib/remote/link.ts) on every change of state and every pong, never by anyone else.
 * Read it; a file whose pid is not alive is a daemon that is gone (state then means nothing).
 *   LinkState = {state, since, attempt, lastError, rttMs, queued, pid, detail, at}
 *     state      the one link vocabulary (lib/room/link-state.ts STATES), as the mirror's document `link` has it:
 *                'online' (hooks' writes cross now) | 'connecting' (dialling: the first connection, or a redial after
 *                a failure, a wake or a network change) | 'offline' (waiting to retry) | 'fork' | 'stopped' (both
 *                for good: `sub-human link --reset CODE` after a fork; a new join after stopped). Files written
 *                before 0.4.1 say 'up' / 'down'; link-state.ts reads those too
 *     since      ISO time this state began
 *     attempt    dials since the link was last online (0 while online)
 *     lastError  the current failure's message, or null (null while online)
 *     prevError  once online again: why it last went offline (absent before any failure)
 *     rttMs      the last ping's round trip, or null (no pong yet, or a server without ping)
 *     queued     @room posts waiting in the outbox (lib/remote/outbox.ts)
 *     pid        the daemon's pid
 *     detail     the daemon's own state, the same words (it says offline where state says connecting during a redial)
 *     at         ISO time the record was written
 *   stateFile(code) -> string         <home>/links/<code>.state.json
 *   readState(code) -> LinkState | null
 *   writeState(code, rec)             atomic (the daemon)
 */

import fs from 'node:fs';
import path from 'node:path';
import { home } from '../home.ts';
import { readJson, writeJsonAtomic } from '../io.ts';
import { CODE_RE } from '../text.ts';
import { RoomError } from './validate.ts';
import type { Link, LinkStateRecord } from './types.ts';

/** @returns {string} <home>/links */
const linksDir = (): string => path.join(home(), 'links');

function fileOf(code: unknown, ext = 'json'): string {
  if (typeof code !== 'string' || !CODE_RE.test(code)) throw new RoomError('INVALID', `invalid room code "${code}"`);
  return path.join(linksDir(), `${code}.${ext}`);
}

/**
 * @param {string} code
 * @returns {object | null}
 */
const get = (code: unknown): Link | null => (typeof code === 'string' && CODE_RE.test(code) ? readJson(fileOf(code)) : null);

/**
 * @param {string} code
 * @returns {boolean}
 */
const has = (code: unknown): boolean => typeof code === 'string' && CODE_RE.test(code) && fs.existsSync(fileOf(code));

// a link the host refused before it held a token keeps no credential, only {refused: {at, reason}}; a login link
// (transport.login) needs none before its first hello: the person's own ssh login to the host is the admission
const credential = (l: Link): boolean => typeof l.token === 'string' || typeof l.invite === 'string' || (!!l.refused && typeof l.refused === 'object')
  || ('login' in l.transport && l.transport.login === true) || (!!l.enroll && typeof l.enroll === 'object' && typeof l.enroll.pin === 'string');

/**
 * @param {string} code
 * @param {object} link
 * @returns {object}
 */
function set(code: string, link: Link): Link {
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
function remove(code: string): boolean {
  try { fs.rmSync(dirOf(code), { recursive: true, force: true }); } catch { /* none */ }
  try { fs.unlinkSync(fileOf(code)); return true; } catch { return false; }
}

/**
 * @param {string} code
 * @returns {string}
 */
const dirOf = (code: unknown): string => fileOf(code).slice(0, -'.json'.length);

/** @returns {string[]} */
function list(): string[] {
  let names: string[];
  try { names = fs.readdirSync(linksDir()); } catch { return []; }
  return names.filter(n => n.endsWith('.json') && CODE_RE.test(n.slice(0, -5))).map(n => n.slice(0, -5)).sort();
}

/**
 * @param {string} code
 * @returns {string}
 */
const logFile = (code: unknown): string => fileOf(code, 'log');

/**
 * @param {string} code
 * @returns {string}
 */
const stateFile = (code: unknown): string => fileOf(code, 'state.json');

/**
 * @param {string} code
 * @returns {object | null}
 */
const readState = (code: unknown): LinkStateRecord | null => (typeof code === 'string' && CODE_RE.test(code) ? readJson(stateFile(code)) : null);

/**
 * @param {string} code
 * @param {object} rec
 */
function writeState(code: string, rec: LinkStateRecord): void {
  const file = stateFile(code);
  fs.mkdirSync(linksDir(), { recursive: true, mode: 0o700 });
  writeJsonAtomic(file, rec, { mode: 0o600 });
}

export { linksDir, get, has, set, remove, list, logFile, dirOf, stateFile, readState, writeState };
