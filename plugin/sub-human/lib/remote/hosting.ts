/**
 * plugin/sub-human/lib/remote/hosting.ts: the host's side of an invite, one step each, shared by the join hook
 * (`/sub-human invite`, `/sub-human kick`: their output is a block reason, shown to the person and never to the
 * model) and the CLI (lib/cli/host.ts). The joiner's side is joinLine() and givePin() below; the dial is the link
 * daemon's (lib/remote/link-connect.ts connectLink).
 *
 * hostInvite: an invite line `/sub-human join DEST ROOM SECRET [--home H]` and a 4-digit PIN the person
 * tells apart (SECRET's tag names this home's machine key: lib/remote/invite-secret.ts). Over ssh the joiner's own
 * ssh login to this account runs the stable serve shim (shim.ts: it must be writable); nothing is written to
 * authorized_keys, and a joiner without a login here is invited over the web instead (webhost.ts). pipe: a second
 * home on this machine (tests and the demo). by: the seat whose card admits the joiner (admission.ts).
 *
 * kick ends the link NAME joined over (or the link reserved for a joiner still waiting for the card): its token stops
 * working (hostLinks.revokeLink, which also burns an invite reserved for it), its seats leave, a room line says so.
 * Every live `serve` of the link sees its record go (server.ts held), whatever its argv; one that names `--link ID`
 * (ssh) is also sent SIGTERM. A login link's account can link again; the text says so. cancelInvite with no ref
 * picks the one open invite, or lists them when there are several.
 *
 * outcome watches the link daemon's hellos for up to LINK_JOIN_WAIT_MS: linked, pin (asked, or the last was wrong or
 * too soon), refused, or waiting (the card not answered yet, or slow). remoteLogin: whether this machine takes ssh
 * logins (null: cannot tell; SUB_HUMAN_REMOTE_LOGIN=on|off says it in tests); no network.
 */

import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as invites from './invites.ts';
import * as hostLinks from './host-links.ts';
import * as admission from './admission.ts';
import * as inviteSecret from './invite-secret.ts';
import * as machineKey from './machine-key.ts';
import * as protocol from './protocol.ts';
import { SECRET_WORD } from '../../mod/core/command.ts';
import { RoomError } from '../room/validate.ts';
import { localHm, isSeatName } from '../text.ts';
import { INVITE_TTL_MS, LINK_JOIN_WAIT_MS } from '../config.ts';
import { envStr } from '../env.ts';
import * as linkSocket from './link-socket.ts';
import * as linkConnect from './link-connect.ts';
import * as links from '../room/links.ts';
import * as roomMod from '../room.ts';
import * as homeMod from '../home.ts';
import * as seatsMod from '../seats.ts';
import * as ioMod from '../io.ts';
import * as configMod from '../config.ts';
import type { LinkSpec } from './types-rest.ts';
import type { InviteRecord, Invites, ShortInvite } from './types-core.ts';
import type { Link, RoomStore } from '../room/types.ts';
import type { Pinned } from '../commands/types.ts';
import type { RoomCode, SeatName, InviteSecret, Pin } from '../brand.ts';
import type * as SshMod from './transports/ssh.ts';
import type * as ShimMod from './shim.ts';
import { lazy } from '../io.ts';

// the serve shim and the ssh transport only for an ssh invite (start cost: the join hook loads this file)
const shimLib = lazy<typeof ShimMod>(import.meta.url, './shim.ts');
const sshT = lazy<typeof SshMod>(import.meta.url, './transports/ssh.ts');

/** An invite line as hostInvite (and webhost.ts hostWeb) returns it: the PIN, its ref, when it lapses, the line. */
export interface HostedInvite {
  pin: Pin;
  ref: string;
  expires_at: string;
  short: true;
  locator: string;
  /** the SECRET word, as the line carries it */
  word: InviteSecret;
  line: string;
  text: string;
  /** the line and the PIN for the status line, and the text without them (lib/commands/types.ts Pinned) */
  pinned: Pinned;
}

/** What ending a link did. */
export interface Ended {
  id: string | null;
  ref?: string;
  seats: string[];
  text: string;
}

/** The link daemon's hellos, as the joiner's person is told. */
export interface Outcome {
  state: 'linked' | 'pin' | 'refused' | 'waiting';
  reason?: string | undefined;
}

const roomOf = (code: RoomCode) => roomMod.open(code);
const minutes = (ms: number): number => Math.round(ms / 60_000);

const hostStore = (code: RoomCode): RoomStore => roomMod.hostStore(code);
/** A line in the room from the room itself, best effort. */
const roomLine = (code: RoomCode, text: string): void => roomMod.roomLine(roomOf(code), text);

/** The stable serve shim (an ssh login runs it); the home path it carries. */
function shimReady(): { shim: typeof ShimMod; h: string } {
  const shim = shimLib();
  if (!shim.refresh({ force: true })) throw new RoomError('INVALID', `the plugin is installed under a temp folder (${shim.pluginRoot()}), which ssh would run from; install it normally (or set SUB_HUMAN_ALLOW_TMP_ROOT=1 to allow it)`);
  const h = path.resolve(homeMod.home());
  if (!shim.PLAIN_PATH_RE.test(h)) throw new RoomError('INVALID', `the sub-human folder "${h}" has characters ssh cannot carry plainly; move it (SUB_HUMAN_HOME) and try again`);
  return { shim, h };
}

const selfAddress = (): string => envStr('SUB_HUMAN_SSH_ADDR') || `${os.userInfo().username}@${os.hostname()}`;

function remoteLogin(): 'on' | 'off' | null {
  const forced = envStr('SUB_HUMAN_REMOTE_LOGIN');
  if (forced === 'on' || forced === 'off') return forced;
  const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    if (process.platform === 'darwin') {
      const r = run('launchctl', ['print-disabled', 'system']);
      if (r.status !== 0 || typeof r.stdout !== 'string') return null;
      const m = /"com\.openssh\.sshd"\s*=>\s*(enabled|disabled|true|false)/.exec(r.stdout);
      // launchd's sshd plist is disabled by default: no line means Remote Login was never turned on
      return !m ? 'off' : m[1] === 'enabled' || m[1] === 'false' ? 'on' : 'off';
    }
    if (process.platform === 'linux') {
      if (run('pgrep', ['-x', 'sshd']).status === 0) return 'on';
      const unit = run('systemctl', ['is-active', 'ssh.socket', 'sshd.socket', 'ssh.service', 'sshd.service']);
      if (unit.error) return null;
      return /^active$/m.test(String(unit.stdout || '')) ? 'on' : 'off';
    }
  } catch { /* cannot tell */ }
  return null;
}

/** What an ssh invite to this machine's own default address adds: the name it guessed, and Remote Login off (an
 * address the person gave, or SUB_HUMAN_SSH_ADDR, may well reach another sshd: no hint then). */
function reachHints(dest: string, defaulted: boolean): string[] {
  if (!defaulted) return [];
  const host = dest.split('@').pop() || dest;
  const out = [`${host} is this machine's own name${/\.local$/i.test(host) ? ', which only machines on the same local network can reach' : ''}. If they reach it by another name, invite with /sub-human invite --ssh USER@HOST (or set SUB_HUMAN_SSH_ADDR; an alias from their ssh config works too).`];
  if (remoteLogin() === 'off') {
    out.push(process.platform === 'darwin'
      ? 'Remote Login is off on this Mac, so their ssh to it will fail: turn it on (System Settings > General > Sharing > Remote Login), or invite over the web: /sub-human invite --web'
      : 'no ssh server is running on this machine, so their ssh to it will fail: start sshd, or invite over the web: /sub-human invite --web');
  }
  return out;
}

/**
 * The invite's text and its pinned form: the line and the PIN on one status line (drawn under the prompt, never saved
 * in the conversation's transcript), and the text that says where they are instead.
 */
function invitePinned({ code, how, line, pin, ref, expires_at, extra = [] }: { code: RoomCode; how: string; line: string; pin: string; ref: string; expires_at: string; extra?: string[] }): Pinned {
  const at = localHm(expires_at);
  const word = line.split(' ').find(w => SECRET_WORD.test(w));
  return {
    status: `PIN ${pin} · ${line}`,
    text: inviteText({ code, how, line: '', pin: '', ref, extra, pinned: at || 'it expires' }),
    ms: Math.max(0, Date.parse(expires_at) - Date.now()) || INVITE_TTL_MS,
    ref,
    ...(word ? {
      short: `PIN ${pin} · SECRET ${word}`,
      cut: inviteText({ code, how, line: line.split(word).join('SECRET'), pin: '', ref, extra, pinned: at || 'it expires', cut: true }),
    } : {}),
  };
}

/** The text an invite is shown with: the line the joiner types, the PIN apart from it, and what happens next here. */
function inviteText({ code, how, line, pin, ref, extra = [], pinned, cut = false }: { code: RoomCode; how: string; line: string; pin: string; ref: string; extra?: string[]; pinned?: string; cut?: boolean }): string {
  const send = pinned && cut
    ? [
      `invite to room ${code} for one machine, ${how}. It works once, for ${minutes(INVITE_TTL_MS)} minutes. The whole line is wider than this terminal, so only its PIN and SECRET are pinned under the prompt (until ${pinned}; Claude Code saves neither in this conversation). Send them this line with SECRET replaced by the word under the prompt:`,
      `  ${line}`,
      'and tell them the PIN apart from it (say it, or send it another way). In a wider terminal the whole line shows under the prompt; `sub-human invite` in a terminal outside Claude Code prints a new invite whole.',
    ]
    : pinned
    ? [`invite to room ${code} for one machine, ${how}. It works once, for ${minutes(INVITE_TTL_MS)} minutes. Its PIN and the line to send them are pinned under the prompt until ${pinned}: Claude Code saves neither in this conversation. Send the line; tell them the PIN apart from it (say it, or send it another way).`]
    : [
      `invite to room ${code} for one machine, ${how}. It works once, for ${minutes(INVITE_TTL_MS)} minutes; send them this line:`,
      '',
      `  ${line}`,
      '',
      `and tell them its PIN apart from the line (say it, or send it another way): ${pin}`,
    ];
  return [
    ...send,
    'Their machine asks them for the PIN once this one has answered; the line alone gets nobody in, nor does the PIN. After 5 wrong PINs the invite stops working.',
    'When they have typed both, a card here asks you to let them in; nothing gets in before you answer.',
    `Sent it to the wrong place? /sub-human invite --cancel ${ref} cancels just this invite.`,
    ...extra,
    `They need sub-human ${protocol.PLUGIN_VERSION} or newer; an older one is told the host runs a newer version and to update (/plugin update sub-human).`,
  ].join('\n');
}

/** An invite line's SECRET word for this home's machine key (ssh, a pipe). */
const machineWord = (secret: Buffer): InviteSecret => inviteSecret.encode(secret, inviteSecret.tagOf(secret, 'machine', machineKey.publicKey()));

function hostInvite(code: RoomCode, { ssh = true, pipe = false, by = null, now = Date.now() }: {
  ssh?: true | string | undefined; pipe?: boolean; by?: string | null; now?: number;
} = {}): HostedInvite {
  const store = hostStore(code);
  if (pipe) { // a second home on this machine (tests, the demo)
    const locator = linkConnect.pipeLocator();
    const r = invites.mintInvite(store, { kind: 'pipe', locator, by, now });
    const word = machineWord(r.secret);
    const line = `/sub-human join ${locator} ${code} ${word}`;
    const how = 'from another sub-human folder on this machine';
    return {
      pin: r.pin, ref: r.ref, expires_at: r.expires_at, short: true, locator, word, line, text: inviteText({ code, how, line, pin: r.pin, ref: r.ref }),
      pinned: invitePinned({ code, how, line, pin: r.pin, ref: r.ref, expires_at: r.expires_at }),
    };
  }
  const dest = ssh === true ? selfAddress() : String(ssh);
  if (sshT().placeholder(dest)) throw new RoomError('INVALID', `"${dest}" still has an example's placeholder: give the address the other machine reaches this one at (user@host, or set SUB_HUMAN_SSH_ADDR)`);
  // a bare ssh alias (`devbox`): the line shows it as given, and the joiner's own ssh config resolves it there (the
  // join's withUser); the invite's record holds this machine's reading of it (ssh -G: the user)
  const full = sshT().withUser(dest);
  const locator = sshT().locator(full);
  if (!locator) throw new RoomError('INVALID', `"${dest}" is not a plain user@host[:port] or ssh alias${ssh === true ? ' (set SUB_HUMAN_SSH_ADDR, or give --ssh USER@HOST)' : ''}`);
  const { h } = shimReady(); // their login runs <home>/bin/serve
  const ownHome = path.resolve(h) === path.join(os.homedir(), '.sub-human'); // where their login looks by default
  const r = invites.mintInvite(store, { kind: 'ssh', locator, by, now });
  const word = machineWord(r.secret);
  const line = `/sub-human join ${dest} ${code} ${word}${ownHome ? '' : ` --home ${h}`}`;
  const parts = {
    code, how: `over ssh ${dest}`, line, pin: r.pin, ref: r.ref,
    extra: [
      `Over ssh this needs their own ssh login to this account (${os.userInfo().username}), set up as for any ssh login: sub-human writes nothing to authorized_keys. No login here? Invite them over the web: /sub-human invite --web`,
      ...reachHints(dest, ssh === true && !envStr('SUB_HUMAN_SSH_ADDR')),
    ],
  };
  return {
    pin: r.pin, ref: r.ref, expires_at: r.expires_at, short: true, locator, word, line,
    text: inviteText(parts), pinned: invitePinned({ ...parts, expires_at: r.expires_at }),
  };
}

function linkIdOf(store: RoomStore, target: string): string {
  const all = hostLinks.links(store);
  if (hostLinks.LINK_ID_RE.test(target) && hostLinks.linkKnown(store, target)) return target;
  const hits = Object.values(all).filter(l => Array.isArray(l.seats) && l.seats.includes(target));
  const [hit] = hits;
  if (hits.length === 1 && hit) return hit.id;
  if (hits.length > 1) throw new RoomError('INVALID', `${target} joined over ${hits.length} connections; ask them to leave the extra one, then kick again`);
  // an invite's joiner not linked yet (waiting for the card, or let in and not connected): its reserved link
  const asked = admission.admissions(store, { all: true }).filter(a => a.name === target && !a.used_at && !a.burnt_at);
  const [one] = asked;
  if (asked.length === 1 && one) return one.link;
  throw new RoomError('INVALID', `nobody called "${target}" joined room ${store.code} from another machine`);
}

/** Burn one invite (a leaked one) by its ref; one reserved for or used by a link ends that link. */
function revokeInvite(code: RoomCode, store: RoomStore, ref: string, invite: InviteRecord): Ended {
  if (invite.link) {
    const r = endLink(code, store, invite.link);
    return { ...r, ref, text: `that invite ${invite.used_at ? 'was used already' : 'was being used'}; ${r.text}` };
  }
  const { state } = invites.burnInvite(store, ref);
  if (state === 'burnt') roomLine(code, 'the host cancelled an unused invite: it no longer lets anyone in');
  const text = state === 'burnt'
    ? `cancelled the invite to room ${code} (${ref}): it lets no one in; everyone else stays`
    : `that invite to room ${code} (${ref}) no longer worked already (wrong PINs, expired, or cancelled); nothing changed`;
  return { id: null, ref, seats: [], text };
}

/** The open invites of the room: [{ref, expires_at}], oldest first. */
function openInvites(store: RoomStore, now = Date.now()): { ref: string; expires_at: string }[] {
  return Object.entries(store.kv.get<Invites>(invites.INVITES_KEY, null) ?? {})
    .filter((e): e is [string, ShortInvite] => invites.inviteOpen(e[1], now))
    .sort(([, a], [, b]) => a.created_at.localeCompare(b.created_at))
    .map(([k, i]) => ({ ref: k.slice(0, 12), expires_at: i.expires_at }));
}

function cancelInvite(code: RoomCode, ref?: string | null, { now = Date.now() }: { now?: number } = {}): Ended | { refs: string[]; text: string } {
  const store = hostStore(code);
  if (ref === undefined || ref === null || ref === '') {
    const open = openInvites(store, now);
    const [only] = open;
    if (!only) return { refs: [], text: `room ${code} has no open invite; nothing to cancel` };
    if (open.length > 1) return { refs: open.map(o => o.ref), text: `room ${code} has ${open.length} open invites; cancel one: ${open.map(o => `/sub-human invite --cancel ${o.ref} (until ${o.expires_at.slice(11, 16)} UTC)`).join(', ')}` };
    ref = only.ref;
  }
  const found = /^[0-9a-f]{12}$/.test(String(ref)) ? invites.findInvite(store, ref) : null;
  if (!found) throw new RoomError('INVALID', `room ${code} has no open invite ${ref}; /sub-human invite --cancel (no ID) lists the open ones`);
  return revokeInvite(code, store, ref, found.invite);
}

/** End link id of the room: its token, its seats, its serve processes; a room line. */
function endLink(code: RoomCode, store: RoomStore, id: string): Ended {
  const r = hostLinks.revokeLink(store, id) ?? { link: null, invites: 0 };
  spawnSync('pkill', ['-f', '--', `--stdio ${code} --link ${id}`], { stdio: 'ignore' });
  const seats = r.link ? r.link.seats || [] : [];
  for (const name of seats) { try { if (isSeatName(name)) seatsMod.exit(code, name, 'removed by the host'); } catch { /* gone already */ } }
  const login = !!(r.link && r.link.login); // a link made over this account's own ssh login (no key line of its own)
  roomLine(code, `the host ended ${seats.length ? `${seats.join(', ')}'s connection` : 'a connection'} to the room`);
  const text = `${seats.length ? `${seats.join(', ')} ${seats.length === 1 ? 'is' : 'are'} out of room ${code}` : `ended a connection to room ${code}`}: it no longer reaches the room`
    + (login ? `. It came over an ssh login to this account, which can join again: to shut that, take its key out of ~/.ssh/authorized_keys` : '');
  return { id, seats, text };
}

function kick(code: RoomCode, name: string): Ended {
  const store = hostStore(code);
  return endLink(code, store, linkIdOf(store, String(name).trim()));
}

// ---------- the joiner ----------
/** The PIN steps the host answered, from the link file and the daemon's stop (PIN_NEEDED, PIN_WRONG, PIN_THROTTLED). */
const PIN_REASONS: ReadonlySet<string> = new Set(['PIN_NEEDED', 'PIN_WRONG', 'PIN_THROTTLED']);

function outcome(code: RoomCode, { waitMs = LINK_JOIN_WAIT_MS }: { waitMs?: number } = {}): Outcome {
  const { sleepSync } = ioMod;
  const l = linkSocket;
  for (const until = Date.now() + waitMs; ; sleepSync(50)) {
    const st = l.status(code);
    const stopped = l.stopReason(st);
    const lf = links.get(code);
    if (stopped && stopped.why && PIN_REASONS.has(stopped.why) && lf && lf.pin_wanted) return { state: 'pin', ...(stopped.why !== 'PIN_NEEDED' ? { reason: stopped.reason } : {}) };
    if (stopped) return { state: 'refused', reason: stopped.reason };
    if (st.state === 'online' && lf && lf.token) return { state: 'linked' };
    if (st.state === 'offline' && lf && lf.awaiting) return { state: 'waiting', reason: st.reason };
    if (Date.now() >= until) return { state: 'waiting', reason: st.reason };
  }
}

function joinText(code: RoomCode, name: SeatName, o: Outcome, { tells = false }: { tells?: boolean } = {}): string {
  const lf: Partial<Link> = links.get(code) ?? {};
  if (o.state === 'linked') {
    // the card may have let this machine in under another name (its own sits in the room from another machine)
    const as = typeof lf.join_as === 'string' ? lf.join_as : name;
    const why = lf.join_renamed ? ` (${lf.join_renamed} is in the room from another machine, and a seat's key never moves, so the host let this machine in as ${as})` : '';
    return `the host let you in to room ${code}: type /sub-human to join it as ${as}${why}`;
  }
  if (o.state === 'refused') return `could not join room ${code}: ${o.reason}`;
  if (o.state === 'pin') {
    const w = lf.pin_wanted ?? { at: '' };
    const left = typeof w.left === 'number' ? ` (${w.left} PIN ${w.left === 1 ? 'try' : 'tries'} left)` : '';
    return `${o.reason ? `${o.reason}` : `the host's machine has your invite${left}. Type the 4-digit PIN they told you`}: /sub-human join PIN`;
  }
  if (lf.awaiting) {
    // no name yet: the host's card picks it (NAME2 when NAME sits in the room from another machine)
    return `the host's machine checked your PIN. A card there now asks them to let you in (${lf.awaiting.check}). `
      + (tells ? 'This session tells you when they do; then type /sub-human to join' : 'Once they do, type /sub-human to join')
      + ` (the request waits ${minutes(configMod.ADMIT_TTL_MS)} minutes)`;
  }
  const t: { kind?: string; host?: string } = lf.transport ?? {};
  const cert = t.kind === 'wss' && /\.ts\.net$/i.test(String(t.host || '')) && !o.reason
    ? ' (Tailscale may be issuing a certificate: the first connection to a ts.net name can take ~20 s; it keeps trying)' : '';
  return `still connecting to room ${code}${o.reason ? ` (${o.reason})` : cert}; ${tells ? 'this session tells you when the host asks for the PIN or lets you in, or ' : ''}type /sub-human in a moment`;
}

/**
 * `/sub-human join DEST ROOM SECRET` (or URL SECRET): the link file for an invite line, before any dial: the transport
 * (a web one with a fresh key of the link's own), the SECRET word and join_as. The daemon dials (lib/remote/link-
 * connect.ts connectLink): the host key the line names first, then the SECRET; the host asks for the PIN.
 */
function joinLine({ code, transport, word, name, sid }: { code: RoomCode; transport: LinkSpec; word: InviteSecret; name: string; sid?: string | null | undefined }): { code: RoomCode } {
  const t: LinkSpec = transport.kind === 'wss' || transport.kind === 'ws'
    ? { ...transport, clientKey: linkConnect.linkKey(code, { fresh: true }).pub.toString('base64url') } : transport;
  links.set(code, { code, transport: t, invite: word, join_as: name, ...(sid ? { join_sid: sid } : {}), created_at: new Date().toISOString() });
  return { code };
}

/** The PIN, typed when the host asked for it: into the link file, until the host answered it. */
function givePin(code: RoomCode, pin: Pin): void {
  const l = links.get(code);
  if (!l || typeof l.invite !== 'string') throw new RoomError('INVALID', `this machine has no invite to room ${code} waiting for a PIN`);
  links.set(code, { ...l, pin });
}

export {
  hostInvite, inviteText, invitePinned, cancelInvite, kick, joinLine, givePin, outcome, joinText, shimReady, remoteLogin,
};
