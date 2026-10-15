/**
 * plugin/sub-human/lib/remote/hosting.ts: the host's side of an invite, one step each, shared by the join hook
 * (`/sub-human invite`, `/sub-human kick`: their output is a block reason, shown to the person and never to the
 * model) and the CLI (lib/cli/host.ts). The joiner's side is joinShort() below (the PAKE runs in the link daemon,
 * lib/remote/enroll.ts); the key material is lib/remote/sshkeys.ts.
 *
 *   hostInvite(code, {ssh?, via?, pipe?, by?, now?}) -> {pin, ref, expires_at, short: true, locator, line, text}
 *       A short invite: the line the joiner types, `/sub-human join DEST ROOM PIN [--via J]`, the 4-digit PIN the
 *       whole secret (auth.mintShort). ssh (the default): true for this machine's own address (SUB_HUMAN_SSH_ADDR, else
 *       <user>@<hostname>), or "user@host[:port]"; via: a ProxyJump for the joiner ("bastion", "me@jump:2222"). Over ssh
 *       the PIN vouches for sshd's Ed25519 host key (sshkeys.hostKey), the stable serve shim must be writable
 *       (lib/remote/shim.ts refresh) and the enrollment door goes into authorized_keys (enroll.openDoor). pipe: a
 *       second home on this machine (`/sub-human join pipe:HOME ROOM PIN`; tests and the demo). by: the seat whose
 *       card admits the joiner (lib/remote/admission.ts). text: the copyable block for the person
 *   cancelInvite(code, ref?) -> {ref?, refs?, text}   burn one unused invite (a leaked one) by its ref; with no ref, the
 *       one open invite, or the list of them when there are several. One reserved for or used by a link ends that
 *       link (kick)
 *   kick(code, name, {file?}) -> {id, seats, keys, text}   end the link NAME joined over: its token stops working
 *       (auth.revokeLink, which also burns an invite reserved for it), its authorized_keys lines go, its seats leave
 *       ("removed by the host"), its running `serve` processes are stopped, and a room line says so. A joiner still
 *       waiting for the card: its reserved link. A link made over this account's own ssh login (auth.loginLink) has no
 *       key line: its token goes and its serve is stopped, and the text says that login can link again
 *   linkTransport({inv, name, cur?}) -> {transport, request} | null   the link transport for an sh2 invite (internal:
 *       a handoff's follower, lib/handoff.ts onMoved, afterMoved, demote): over ssh the link's own key (made once,
 *       kept), the invite's host key pinned (else the old pin for the same destination), mux from cur kept, and the
 *       request (no secret: it marks a key the new host has not let in); over ws/wss the pinned listener key. null for
 *       a locator this machine cannot use
 *   joinInvite({inv, invite, pin, name}) -> {code, request?}   the link file for an sh2 invite (demote: a machine
 *       follows a promoted room with the invite promote printed for it). RoomError INVALID for a locator this machine
 *       cannot use
 *   shimReady() -> {shim, h}   the stable serve shim written and the plain home path it carries (the card's admit);
 *       RoomError INVALID under a temp plugin root or a home path a forced command cannot carry
 *   outcome(code, {waitMs?}) -> {state: 'linked' | 'refused' | 'waiting', reason?}   the link daemon's first hello,
 *       watched for up to waitMs (LINK_JOIN_WAIT_MS): linked, refused (its reason: a wrong PIN, an expired invite, a
 *       protocol skew), or waiting (the host's card not answered yet, or slow)
 *   joinShort({code, transport, pin, name, sid?}) -> {code}   a short invite's link file before the PAKE (the daemon
 *       runs it); join_as: the name the seat takes once the host lets this machine in (a bare /sub-human finishes the
 *       join); join_sid: the session that typed it, whose tail tells the person when that happened
 *       (lib/remote/joining.ts pendingNews)
 *   joinText(code, name, outcome, {tells}?) -> string   what the joiner's person reads next; tells: this session's tail
 *       says when the host lets them in (the session that typed the PIN)
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as auth from './auth.ts';
import * as sshkeys from './sshkeys.ts';
import { RoomError } from '../room/validate.ts';
import { INVITE_TTL_MS, LINK_JOIN_WAIT_MS } from '../config.ts';
import * as linkMod from './link.ts';
import * as linksMod from '../room/links.ts';
import * as roomMod from '../room.ts';
import * as identityMod from '../identity.ts';
import * as homeMod from '../home.ts';
import * as seatsMod from '../seats.ts';
import * as ioMod from '../io.ts';
import * as configMod from '../config.ts';
import { createRequire } from 'node:module';
import type { LinkSpec, SshSpec } from './types-rest.ts';
import type { InviteRecord, Invites, ParsedInvite, ShortInvite } from './types-core.ts';
import type { Link, RoomStore } from '../room/types.ts';

const require = createRequire(import.meta.url);

/** A short invite as auth.mintShort makes it: the PIN, its ref and when it lapses. */
type MintedShort = ReturnType<typeof auth.mintShort>;

/** A short invite as hostInvite returns it. */
export interface HostedInvite extends MintedShort {
  short: true;
  locator: string;
  hostKey?: string;
  line: string;
  text: string;
}

/** What ending a link did. */
export interface Ended {
  id: string | null;
  ref?: string;
  seats: string[];
  keys: number;
  text: string;
}

/** The link daemon's first hello, as the joiner's person is told. */
export interface Outcome {
  state: 'linked' | 'refused' | 'waiting';
  reason?: string;
}

const sshT = (): typeof import('./transports/ssh.ts') => require('./transports/ssh.ts');
const linkLib = () => linkMod;
const links = () => linksMod;
const roomOf = (code: string) => roomMod.open(code);
const minutes = (ms: number): number => Math.round(ms / 60_000);

function hostStore(code: string): RoomStore {
  const identity = identityMod;
  if (!identity.roomExists(code)) throw new RoomError('NO_ROOM', `no room "${code}"`);
  const s = roomOf(code).store;
  if (!s.isHost) throw new RoomError('HOST_ONLY', `room ${code} is hosted on another machine; its host does this`);
  return s;
}

/** A line in the room from the room itself, best effort. */
function roomLine(code: string, text: string): void {
  try { roomOf(code).append({ kind: 'status', text }, { via: 'system', from: 'room', system: true }); } catch { /* the action stands */ }
}

/** The stable serve shim (an ssh forced command names it); the home path it carries. */
function shimReady(): { shim: typeof import('./shim.ts'); h: string } {
  const shim: typeof import('./shim.ts') = require('./shim.ts');
  if (!shim.refresh({ force: true })) throw new RoomError('INVALID', `the plugin is installed under a temp folder (${shim.pluginRoot()}), which ssh would run from; install it normally (or set SUB_HUMAN_ALLOW_TMP_ROOT=1 to allow it)`);
  const h = path.resolve(homeMod.home());
  if (!shim.PLAIN_PATH_RE.test(h)) throw new RoomError('INVALID', `the sub-human folder "${h}" has characters ssh cannot carry plainly; move it (SUB_HUMAN_HOME) and try again`);
  return { shim, h };
}

const selfAddress = (): string => process.env.SUB_HUMAN_SSH_ADDR || `${os.userInfo().username}@${os.hostname()}`;

/**
 * The text a short invite is shown with: the one line the joiner types (the PIN is the whole secret), and what
 * happens next on this side (the card).
 */
function shortText({ code, how, line, ref, extra = [] }: { code: string; how: string; line: string; ref: string; extra?: string[] }): string {
  return [
    `invite to room ${code} for one machine, ${how}. It works once, for ${minutes(INVITE_TTL_MS)} minutes; send them this line:`,
    '',
    `  ${line}`,
    '',
    'The 4-digit PIN is the whole secret: send the line privately, or send it without the PIN and say the PIN. After 5 wrong PINs it stops working.',
    'When they type it, a card here asks you to let them in; nothing gets in before you answer.',
    `Sent it to the wrong place? /sub-human invite --cancel ${ref} cancels just this invite.`,
    ...extra,
  ].join('\n');
}

function hostInvite(code: string, { ssh = true, via, pipe = false, by = null, now = Date.now() }: {
  ssh?: true | string; via?: string; pipe?: boolean; by?: string | null; now?: number;
} = {}): HostedInvite {
  const store = hostStore(code);
  if (pipe) { // a second home on this machine (tests, the demo)
    if (via !== undefined) throw new RoomError('INVALID', '--via is for an ssh invite');
    const locator = linkLib().pipeLocator();
    const r = auth.mintShort(store, { kind: 'pipe', locator, by, now });
    const line = `/sub-human join ${locator} ${code} ${r.pin}`;
    return { ...r, short: true, locator, line, text: shortText({ code, how: 'from another sub-human folder on this machine', line, ref: r.ref }) };
  }
  const dest = ssh === true ? selfAddress() : String(ssh);
  if (sshT().placeholder(dest)) throw new RoomError('INVALID', `"${dest}" still has an example's placeholder: give the address the other machine reaches this one at (user@host, or set SUB_HUMAN_SSH_ADDR)`);
  // a bare ssh alias (`devbox`): the line shows it as given, and the joiner's own ssh config resolves it there (the
  // join's withUser); the invite's record holds this machine's reading of it (ssh -G: the user)
  const full = sshT().withUser(dest);
  const locator = sshT().locator(full, via !== undefined ? { via } : {});
  if (!locator) {
    throw new RoomError('INVALID', sshT().dest(full) ? `--via "${via}" is not a plain [user@]host[:port]` : `"${dest}" is not a plain user@host[:port] or ssh alias${ssh === true ? ' (set SUB_HUMAN_SSH_ADDR, or give --ssh USER@HOST)' : ''}`);
  }
  shimReady();
  const hostKey = sshkeys.hostKey();
  if (!hostKey) {
    throw new RoomError('INVALID', 'an ssh invite needs this machine\'s ssh host key, and none is readable (/etc/ssh/ssh_host_ed25519_key.pub, or SUB_HUMAN_SSH_HOST_KEY). Someone who can ssh here can join without an invite (/sub-human join HOST ROOM), or invite over the web: /sub-human invite --web');
  }
  const file = path.resolve(sshkeys.authorizedKeysFile());
  const r = auth.mintShort(store, { kind: 'ssh', locator, hostKey, by, doorFile: file, now });
  try { (require('./enroll.ts') as typeof import('./enroll.ts')).openDoor(code, { file }); } catch (e) {
    try { auth.burnInvite(store, r.ref); } catch { /* it lapses */ }
    throw e;
  }
  const line = `/sub-human join ${dest} ${code} ${r.pin}${via ? ` --via ${via}` : ''}`;
  return {
    ...r, short: true, locator, hostKey, line,
    text: shortText({
      code, how: `over ssh ${dest}${via ? ` via ${via}` : ''}`, line, ref: r.ref,
      extra: [
        `Their machine checks it reached this one (ssh host key ${sshkeys.fingerprint(hostKey)}) as part of the PIN check. Until you let them in they get nothing: while the invite is open, ssh here only checks PINs.`,
      ],
    }),
  };
}

function linkIdOf(store: RoomStore, target: string): string {
  const all = auth.links(store);
  if (auth.LINK_ID_RE.test(target) && auth.linkKnown(store, target)) return target;
  const hits = Object.values(all).filter(l => Array.isArray(l.seats) && l.seats.includes(target));
  if (hits.length === 1) return hits[0].id;
  if (hits.length > 1) throw new RoomError('INVALID', `${target} joined over ${hits.length} connections; ask them to leave the extra one, then kick again`);
  // a short code's joiner not linked yet (waiting for the card, or let in and not connected): its reserved link
  const asked = auth.admissions(store, { all: true }).filter(a => a.name === target && !a.used_at && !a.burnt_at);
  if (asked.length === 1) return asked[0].link;
  throw new RoomError('INVALID', `nobody called "${target}" joined room ${store.code} from another machine`);
}

/** Burn one invite (a leaked one) by its ref; one reserved for or used by a link ends that link. */
function revokeInvite(code: string, store: RoomStore, ref: string, invite: InviteRecord, opts: { file?: string }): Ended {
  if (invite.link) {
    const r = endLink(code, store, invite.link, opts);
    return { ...r, ref, text: `that invite ${invite.used_at ? 'was used already' : 'was being used'}; ${r.text}` };
  }
  const { state } = auth.burnInvite(store, ref);
  try { (require('./enroll.ts') as typeof import('./enroll.ts')).sweepDoors(code); } catch { /* the tail sweeps it */ }
  if (state === 'burnt') roomLine(code, 'the host cancelled an unused invite: it no longer lets anyone in');
  const text = state === 'burnt'
    ? `cancelled the invite to room ${code} (${ref}): it lets no one in; everyone else stays`
    : `that invite to room ${code} (${ref}) no longer worked already (wrong PINs, expired, or cancelled); nothing changed`;
  return { id: null, ref, seats: [], keys: 0, text };
}

/** The open invites of the room: [{ref, expires_at}], oldest first. */
function openInvites(store: RoomStore, now = Date.now()): { ref: string; expires_at: string }[] {
  return Object.entries((store.kv.get(auth.INVITES_KEY, null) || {}) as Invites)
    .filter((e): e is [string, ShortInvite] => !!e[1] && !!e[1].short && auth.shortLive(e[1], now))
    .sort(([, a], [, b]) => a.created_at.localeCompare(b.created_at))
    .map(([k, i]) => ({ ref: k.slice(0, 12), expires_at: i.expires_at }));
}

function cancelInvite(code: string, ref?: string | null, { file = sshkeys.authorizedKeysFile(), now = Date.now() }: { file?: string; now?: number } = {}): Ended | { refs: string[]; text: string } {
  const store = hostStore(code);
  if (ref === undefined || ref === null || ref === '') {
    const open = openInvites(store, now);
    if (!open.length) return { refs: [], text: `room ${code} has no open invite; nothing to cancel` };
    if (open.length > 1) return { refs: open.map(o => o.ref), text: `room ${code} has ${open.length} open invites; cancel one: ${open.map(o => `/sub-human invite --cancel ${o.ref} (until ${o.expires_at.slice(11, 16)} UTC)`).join(', ')}` };
    ref = open[0].ref;
  }
  const found = /^[0-9a-f]{12}$/.test(String(ref)) ? auth.findInvite(store, ref) : null;
  if (!found) throw new RoomError('INVALID', `room ${code} has no open invite ${ref}; /sub-human invite --cancel (no ID) lists the open ones`);
  return revokeInvite(code, store, ref, found.invite, { file });
}

/** End link id of the room: its token, its key lines, its seats, its serve processes; a room line. */
function endLink(code: string, store: RoomStore, id: string, { file = sshkeys.authorizedKeysFile() }: { file?: string } = {}): Ended {
  const r = auth.revokeLink(store, id) || { link: null, invites: 0 };
  const doors = new Set([path.resolve(file), ...auth.admissions(store, { all: true }).filter(a => a.link === id && a.door_file).map(a => path.resolve(a.door_file!))]);
  let keys = 0;
  for (const f of doors) keys += sshkeys.removeAuthorized(f, code, id);
  try { (require('./enroll.ts') as typeof import('./enroll.ts')).sweepDoors(code); } catch { /* the tail sweeps it */ }
  spawnSync('pkill', ['-f', '--', `--stdio ${code} --link ${id}`], { stdio: 'ignore' });
  const seats = r.link ? r.link.seats || [] : [];
  const seatsLib = seatsMod;
  for (const name of seats) { try { seatsLib.exit(code, name, 'removed by the host'); } catch { /* gone already */ } }
  const login = !!(r.link && r.link.login); // a link made over this account's own ssh login (no key line of its own)
  roomLine(code, `the host ended ${seats.length ? `${seats.join(', ')}'s connection` : 'a connection'} to the room`);
  const text = `${seats.length ? `${seats.join(', ')} ${seats.length === 1 ? 'is' : 'are'} out of room ${code}` : `ended a connection to room ${code}`}: it no longer reaches the room`
    + (login ? `. It came over an ssh login to this account, which can join again: to shut that, take its key out of ${file}` : '');
  return { id, seats, keys, text };
}

function kick(code: string, name: string, opts: { file?: string } = {}): Ended {
  const store = hostStore(code);
  return endLink(code, store, linkIdOf(store, String(name).trim()), opts);
}

// ---------- the joiner ----------
/**
 * The link file's transport for an sh2 invite, with what this machine adds to it. Over ssh: the link's own key
 * (sshkeys.linkKey in links.dirOf(code): made once, kept across a re-point), the host key the invite pins (a
 * known_hosts of the link's own; without one, the old pin is kept only for the same user@host[:port]), and mux (a
 * `sub-human prime` master) carried over from cur; request: the admit request for the invite's host. Over ws/wss: the
 * listener's X25519 key the invite carries. null for a locator this machine cannot use.
 */
function linkTransport({ inv, name, cur = null }: { inv: ParsedInvite; name: string; cur?: Link | null }): { transport: LinkSpec; request: string | null } | null {
  let transport = linkLib().transportOf(inv.locator);
  if (!transport) return null;
  const prev: { kind?: string; user?: string; host?: string; port?: unknown; knownHosts?: string; alias?: string; mux?: boolean } = (cur && cur.transport) || {};
  let request: string | null = null;
  if (transport.kind === 'ssh') {
    const dir = links().dirOf(inv.code);
    const key = sshkeys.linkKey(dir, `sub-human:${inv.code}:${name}`);
    let t: SshSpec = { ...transport, key: key.file };
    const sameDest = prev.kind === 'ssh' && prev.user === t.user && prev.host === t.host && prev.port === t.port;
    if (inv.hostKey) {
      const alias = `sub-human-${inv.code}`;
      const knownHosts = path.join(dir, 'known_hosts');
      fs.writeFileSync(knownHosts, sshkeys.knownHostsLine(alias, inv.hostKey) + '\n', { mode: 0o600 });
      t = { ...t, knownHosts, alias };
    } else if (sameDest && prev.knownHosts && prev.alias) t = { ...t, knownHosts: prev.knownHosts, alias: prev.alias };
    if (prev.mux === true) t = { ...t, mux: true };
    transport = t;
    request = sshkeys.formatRequest({ code: inv.code, ref: auth.inviteRef(inv.secret), key: key.raw, name });
  }
  if (transport.kind === 'wss' || transport.kind === 'ws') { // the listener's X25519 key, pinned (transports/ws.ts)
    if (!inv.hostKey) throw new RoomError('INVALID', 'this web invite pins no host key; ask the host for a new one');
    transport = { ...transport, hostKey: inv.hostKey };
  }
  return { transport, request };
}

function joinInvite({ inv, invite, pin, name }: { inv: ParsedInvite; invite: string; pin?: string; name: string }): { code: string; request: string | null } {
  const lt = linkTransport({ inv, name, cur: links().get(inv.code) });
  if (!lt) throw new RoomError('INVALID', `this invite reaches its room through "${inv.locator.split(':')[0]}", which this machine cannot use`);
  const { transport, request } = lt;
  links().set(inv.code, { code: inv.code, transport, invite, pin, ...(request ? { request } : {}), created_at: new Date().toISOString() });
  return { code: inv.code, request };
}

function outcome(code: string, { waitMs = LINK_JOIN_WAIT_MS }: { waitMs?: number } = {}): Outcome {
  const { sleepSync } = ioMod;
  const l = linkLib();
  for (const until = Date.now() + waitMs; ; sleepSync(50)) {
    const st = l.status(code);
    const stopped = l.stopReason(st);
    if (stopped) return { state: 'refused', reason: stopped.reason };
    const lf = links().get(code);
    if (st.state === 'online' && lf && lf.token) return { state: 'linked' };
    if (st.state === 'offline' && lf && (lf.request || lf.awaiting)) return { state: 'waiting', reason: st.reason };
    if (Date.now() >= until) return { state: 'waiting', reason: st.reason };
  }
}

function joinText(code: string, name: string, o: Outcome, { tells = false }: { tells?: boolean } = {}): string {
  const lf: Partial<Link> = links().get(code) || {};
  if (o.state === 'linked') return `the host let you in to room ${code}: type /sub-human to join it as ${name}`;
  if (o.state === 'refused') return `could not join room ${code}: ${o.reason}`;
  if (lf.awaiting) {
    return `the host's machine checked your PIN. A card there now asks them to let you in as ${name} (${lf.awaiting.check}). `
      + (tells ? 'This session tells you when they do; then type /sub-human to join' : 'Once they do, type /sub-human to join')
      + ` (the request waits ${minutes(configMod.ADMIT_TTL_MS)} minutes)`;
  }
  const t: { kind?: string; host?: string } = lf.transport || {};
  const cert = t.kind === 'wss' && /\.ts\.net$/i.test(String(t.host || '')) && !o.reason
    ? ' (Tailscale may be issuing a certificate: the first connection to a ts.net name can take ~20 s; it keeps trying)' : '';
  return `still connecting to room ${code}${o.reason ? ` (${o.reason})` : cert}; ${tells ? 'this session tells you when the host lets you in, or ' : ''}type /sub-human in a moment`;
}

/**
 * `/sub-human join DEST ROOM PIN` (or URL PIN): the link file for a short invite, before any attempt: the transport to
 * the host's door, the PIN (enroll, 0600, dropped once the host answered) and join_as, the seat's name. The daemon
 * runs the PAKE (lib/remote/enroll.ts enrollLink).
 */
function joinShort({ code, transport, pin, name, sid }: { code: string; transport: LinkSpec; pin: string; name: string; sid?: string | null }): { code: string } {
  links().set(code, { code, transport, enroll: { pin, name }, join_as: name, ...(sid ? { join_sid: sid } : {}), created_at: new Date().toISOString() });
  return { code };
}

export {
  hostInvite, cancelInvite, kick, linkTransport, joinInvite, joinShort, outcome, joinText, shimReady, shortText,
};
