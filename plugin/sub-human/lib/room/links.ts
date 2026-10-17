/**
 * plugin/sub-human/lib/room/links.ts: the link registry on this machine: which rooms are mirrors of a room hosted
 * elsewhere, and how to reach them. One file per room, <home>/links/<code>.json (dir 0700, file 0600). Read by
 * lib/room/store.ts open() (a linked code gets a MirrorRoomStore) and roomExists(); written by the join hook
 * (`/sub-human join`) and the link daemon (lib/remote/link.ts, which swaps the invite for its token).
 * Machine-local, like the session indexes: it never syncs. Zero dependencies beyond lib/home.ts, lib/io.ts and
 * lib/text.ts.
 *
 * Link (types.ts; the fields its doc comments do not cover):
 *   transport  plus what this machine adds: a web link's pinned listener key (hostKey) and its own Noise key
 *              (clientKey, the pair in dirOf(code), lib/remote/link-connect.ts linkKey); an ssh link's mux
 *   token      the link's credential (the server keeps its sha256): kept in clear here, like the seat key; a web link
 *              also needs its own key (the host binds the link to it)
 *   refused    {at, reason}: the host refused the invite before any token (a wrong PIN's last try, burnt, used,
 *              expired, a host key the line does not name); the daemon then dropped invite, pin and rebind
 *              (lib/remote/link.ts), so no spent secret stays here
 *   join_as    the name the seat takes once the host lets an invite in (a bare /sub-human takes it)
 *   awaiting   the PIN held and the host person's card decides (no secret in it)
 * The resume point is the mirror itself (its last line and that line's hash), not a field here.
 * has() is one stat (lib/room/store.ts open() asks on every call). dirOf(code) holds the link's own Noise key (0700);
 * remove() deletes it too. logFile(code) is the daemon's stderr.
 *
 * The link's state, for observers (doctor, the statusline, the room row): <home>/links/<code>.state.json (0600),
 * written by the link daemon (lib/remote/link.ts) on every change of state and every pong, and once by a hook that
 * finds that daemon gone (lib/room/store-mirror.ts _markGone: offline, before it starts the next one). A file whose
 * pid is not alive is a daemon that is gone (its state then means nothing).
 *   state      the one link vocabulary (lib/room/link-state.ts), as the mirror's document `link` has it: 'online'
 *              (hooks' writes cross now) | 'connecting' (the first dial, or a redial after a failure, a wake or a
 *              network change) | 'offline' (waiting to retry) | 'fork' | 'stopped' (both for good: `sub-human link
 *              --forget CODE` and a new invite after a fork; a new join after stopped)
 *   attempt    dials since the link was last online (0 while online); lastError null while online
 *   prevError  once online again: why it last went offline
 *   rttMs      null before a pong; queued: @room posts in the outbox (lib/remote/outbox.ts)
 *   detail     the daemon's own state, the same words (it says offline where state says connecting during a redial)
 */

import fs from 'node:fs';
import path from 'node:path';
import { home } from '../home.ts';
import { readJson, writeJsonAtomic } from '../io.ts';
import { objAs } from '../decode.ts';
import { isRoomCode } from '../text.ts';
import { RoomError } from './validate.ts';
import type { Link, LinkStateRecord } from './types.ts';
import type { RoomCode } from '../brand.ts';

const linksDir = (): string => path.join(home(), 'links');

/** A link record and its daemon's state record: this home's own (set, writeState); each reader checks its fields. */
const LINK = objAs<Link>();
const LINK_STATE = objAs<LinkStateRecord>();

function fileOf(code: unknown, ext = 'json'): string {
  if (!isRoomCode(code)) throw new RoomError('INVALID', `invalid room code "${code}"`);
  return path.join(linksDir(), `${code}.${ext}`);
}

const get = (code: unknown): Link | null => (isRoomCode(code) ? readJson(fileOf(code), LINK, null) : null);

const has = (code: unknown): boolean => isRoomCode(code) && fs.existsSync(fileOf(code));

// a link the host refused before it held a token keeps no credential, only {refused: {at, reason}}; a login link
// (transport.login) needs none before its first hello: the person's own ssh login to the host is the admission
const credential = (l: Link): boolean => typeof l.token === 'string' || typeof l.invite === 'string' || (!!l.refused && typeof l.refused === 'object')
  || ('login' in l.transport && l.transport.login === true);

function set(code: RoomCode, link: Link): Link {
  const file = fileOf(code);
  if (!link || link.code !== code || !link.transport || typeof link.transport.kind !== 'string' || !credential(link)) {
    throw new RoomError('INVALID', `a link needs {code: "${code}", transport: {kind}, token or invite}`);
  }
  fs.mkdirSync(linksDir(), { recursive: true, mode: 0o700 });
  writeJsonAtomic(file, link, { mode: 0o600 });
  return link;
}

function remove(code: RoomCode): boolean {
  try { fs.rmSync(dirOf(code), { recursive: true, force: true }); } catch { /* none */ }
  try { fs.unlinkSync(fileOf(code)); return true; } catch { return false; }
}

const dirOf = (code: unknown): string => fileOf(code).slice(0, -'.json'.length);

function list(): RoomCode[] {
  let names: string[];
  try { names = fs.readdirSync(linksDir()); } catch { return []; }
  return names.filter(n => n.endsWith('.json')).map(n => n.slice(0, -5)).filter(isRoomCode).sort();
}

const logFile = (code: unknown): string => fileOf(code, 'log');

const stateFile = (code: unknown): string => fileOf(code, 'state.json');

const readState = (code: unknown): LinkStateRecord | null => (isRoomCode(code) ? readJson(stateFile(code), LINK_STATE, null) : null);

function writeState(code: RoomCode, rec: LinkStateRecord): void {
  const file = stateFile(code);
  fs.mkdirSync(linksDir(), { recursive: true, mode: 0o700 });
  writeJsonAtomic(file, rec, { mode: 0o600 });
}

export { linksDir, get, has, set, remove, list, logFile, dirOf, stateFile, readState, writeState };
