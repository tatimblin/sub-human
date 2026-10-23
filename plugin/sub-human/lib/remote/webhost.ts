/**
 * plugin/sub-human/lib/remote/webhost.ts: the host's side of a join over the web (1.1), shared by the join hook
 * (`/sub-human invite --web`, `--public`, `/sub-human invite --stop`: block reasons the person reads,
 * never the model) and the CLI (lib/cli/host.ts). The wire is
 * lib/remote/transports/ws.ts; the daemon lib/remote/listener.ts; the Tailscale calls lib/remote/tailscale.ts.
 *
 * hostWeb: an invite line `/sub-human join https://HOST/…/sub-human/ROOM#SECRET` (the SECRET as the URL's fragment,
 * which the joiner never sends anywhere: the dial is to the URL without it), its SECRET's tag naming the listener's
 * X25519 key (role 'listener': the joiner checks it before its Noise handshake), and a 4-digit PIN told apart. It starts the listener (127.0.0.1 only) and puts the room in its served set. tailscale (`--web`): Tailscale
 * Serve for /sub-human/CODE on this node's MagicDNS name (tailnet only), its certificate warmed in the background;
 * funnel (`--public`): the same through Funnel (public; the room's first Funnel invite carries tailscale.CT_WARNING:
 * hosting.onceNotes, as the key check, the rules and the install hint, and the certificate's wait on a first serve). The tests and the lab
 * name a front of their own instead of Tailscale (lib/env.ts webFront: SUB_HUMAN_WEB_FRONT, never a person's). unhost (`invite --stop`) turns off the room's own Tailscale path only; links already
 * made keep their token but cannot reach the room over the web until it is hosted again.
 */

import { RoomError } from '../room/validate.ts';
import type { TailscaleRec } from './types-rest.ts';
import type { HostedInvite } from './hosting.ts';
import type { RoomStore } from '../room/types.ts';
import type { RoomCode } from '../brand.ts';
import type * as ListenerMod from './listener.ts';
import type * as TailscaleMod from './tailscale.ts';
import type * as WsMod from './transports/ws.ts';
import type * as SshMod from './transports/ssh.ts';
import type * as InvitesMod from './invites.ts';
import type * as InviteSecretMod from './invite-secret.ts';
import type * as HostingMod from './hosting.ts';
import { lazy } from '../io.ts';
import { webFront } from '../env.ts';
import * as room from '../room.ts';

// the listener, tailscale and the invite code only when a room is served over the web (start cost: hooks load this file)
const inviteSecretLib = lazy<typeof InviteSecretMod>(import.meta.url, './invite-secret.ts');
const hostingLib = lazy<typeof HostingMod>(import.meta.url, './hosting.ts');
const invitesLib = lazy<typeof InvitesMod>(import.meta.url, './invites.ts');

const listener = lazy<typeof ListenerMod>(import.meta.url, './listener.ts');
const ts = lazy<typeof TailscaleMod>(import.meta.url, './tailscale.ts');
const wsT = lazy<typeof WsMod>(import.meta.url, './transports/ws.ts');
const sshT = lazy<typeof SshMod>(import.meta.url, './transports/ssh.ts');

/** A front's base URL, checked. */
export interface FrontBase {
  secure: boolean;
  host: string;
  port: number | undefined;
  prefix: string;
}

/** A web invite as hostWeb returns it. */
export interface WebInvite extends HostedInvite {
  hostKey: string;
  base: string;
  mode: string;
  port: number;
}

const hostStore = (code: RoomCode): RoomStore => room.hostStore(code);

/** The front's base URL, checked: http(s)://host[:port][/prefix], nothing else. */
function frontBase(text: string): FrontBase {
  let u: URL;
  try { u = new URL(String(text)); } catch { throw new RoomError('INVALID', `"${text}" is not a URL (https://host[:port][/prefix])`); }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.search || u.hash) {
    throw new RoomError('INVALID', `a front is a plain https://host[:port][/prefix], not "${text}"`);
  }
  const prefix = u.pathname.replace(/\/+$/, '');
  return { secure: u.protocol === 'https:', host: u.hostname, port: u.port ? Number(u.port) : undefined, prefix };
}

function hostWeb(code: RoomCode, { funnel = false, port, by = null, now = Date.now() }: {
  funnel?: boolean; port?: number | undefined; by?: string | null; now?: number;
} = {}): WebInvite {
  const store = hostStore(code);
  // the tests' and the lab's own front (never Funnel's: --public stays Tailscale's)
  const url = funnel ? undefined : webFront();
  const tailscale = !url;
  const L = listener();
  const served = L.status().rooms[code];
  const { port: lport } = L.start(port ? { port } : {});
  const roomPath = `/sub-human/${code}`;
  let base: FrontBase, mode: string, tsRec: TailscaleRec | null | undefined = null, warmed = false;
  if (tailscale) {
    const bin = ts().bin();
    if (!bin) throw new RoomError('INVALID', 'no tailscale CLI here (not on PATH, no /Applications/Tailscale.app); install Tailscale, or invite over ssh (/sub-human invite)');
    const me = ts().self(bin);
    const same = served && served.tailscale && served.tailscale.path === roomPath && !!served.tailscale.funnel === !!funnel && served.tailscale.port === lport;
    if (served && served.tailscale && !same) L.untailscale(served);
    tsRec = same ? served.tailscale : ts().on({ bin, path: roomPath, port: lport, funnel });
    // the name's certificate: Tailscale fetches it on the first HTTPS request (~20 s cold); start that now, not waited for
    if (!same) { ts().warm(`https://${me.dnsName}${roomPath}`); warmed = true; }
    base = { secure: true, host: me.dnsName, port: undefined, prefix: '' };
    mode = funnel ? 'funnel' : 'tailscale';
  } else {
    if (served && served.tailscale) L.untailscale(served);
    base = frontBase(url ?? ''); // not tailscale: url is set
    mode = 'front';
  }
  const p = `${base.prefix}${roomPath}`;
  const locator = wsT().locator({ host: base.host, port: base.port, path: p }, base.secure);
  if (!locator) throw new RoomError('INVALID', `the front ${base.host} gives no plain URL for this room`);
  const hostKey = L.hostKey();
  const joinBase = `${base.secure ? 'https' : 'http'}://${base.host}${base.port ? `:${base.port}` : ''}${p}`;
  L.addRoom(code, { path: p, url: joinBase, mode, port: lport, ...(tsRec ? { tailscale: tsRec } : {}) });
  const how = mode === 'funnel' ? 'over Tailscale Funnel (public)' : mode === 'tailscale' ? 'over Tailscale Serve (your tailnet only)' : `over the web through ${base.host}`;
  // the URL with the line's SECRET as its fragment, its tag naming the listener's key; the PIN told apart
  const r = invitesLib().mintInvite(store, { kind: 'ws', locator, by, now });
  const secret = inviteSecretLib();
  const word = secret.encode(r.secret, secret.tagOf(r.secret, 'listener', hostKey));
  const line = `/sub-human join ${joinBase}#${word}`;
  const hosting = hostingLib();
  // shown once per room (hosting.onceNotes); the certificate's wait only while Tailscale has just started fetching it
  const notes = hosting.onceNotes(store, [
    ['rules', hosting.INVITE_RULES],
    ['key', `Their machine checks this one's key (${hostKey.slice(0, 12)}…, named in the line) before it sends anything, so nothing in between can read along.`],
    ...(mode === 'funnel' ? [['funnel', ts().CT_WARNING] as const] : []),
    ['install', hosting.INSTALL_HINT],
    // Tailscale fetched the name's certificate for this room's first serve: later ones find it there
    ...(warmed ? [['cert', 'The first connection to a new ts.net name can take ~20 s while Tailscale issues its certificate; it is being fetched now, and their machine keeps trying.'] as const] : []),
  ]);
  const parts = { code, how, line, pin: r.pin, ref: r.ref, expires_at: r.expires_at, notes, web: true };
  const text = hosting.inviteText(parts);
  const pinned = hosting.invitePinned(parts);
  return { pin: r.pin, ref: r.ref, expires_at: r.expires_at, short: true, line, word, locator, hostKey, base: joinBase, mode, port: lport, text, pinned };
}

/**
 * An ssh-forward invite (`/sub-human invite --forward`): the line `/sub-human join HOST CODE SECRET --forward PORT`
 * for someone who logs in to this machine as themselves, not this account. Their ssh carries the web link to the
 * listener on loopback (transports/ws.ts tunnelSpec), so the SECRET's tag names the listener's key, as hostWeb's.
 * HOST: SUB_HUMAN_SSH_ADDR or this machine's name, with no user (each joiner's own ssh config or name fills it in).
 * A room already served over the web keeps its record (its Tailscale path stays): the listener serves it either way.
 */
function hostForward(code: RoomCode, { port, by = null, now = Date.now() }: { port?: number | undefined; by?: string | null; now?: number } = {}): WebInvite {
  const store = hostStore(code);
  const hosting = hostingLib();
  const host = hosting.selfAddress().replace(/^[^@]*@/, '');
  if (!sshT().dest(`u@${host}`)) throw new RoomError('INVALID', `"${host}" is not a plain host name or ssh alias (set SUB_HUMAN_SSH_ADDR to the name others reach this machine at)`);
  const L = listener();
  const { port: lport } = L.start(port ? { port } : {});
  const roomPath = `/sub-human/${code}`;
  if (!L.status().rooms[code]) L.addRoom(code, { path: roomPath, url: `ws://127.0.0.1:${lport}${roomPath}`, mode: 'ssh-forward', port: lport });
  const locator = wsT().locator({ host: '127.0.0.1', port: lport, path: roomPath }, false);
  if (!locator) throw new RoomError('INVALID', `no plain URL for room ${code} on port ${lport}`);
  const hostKey = L.hostKey();
  const r = invitesLib().mintInvite(store, { kind: 'ws', locator, by, now });
  const secret = inviteSecretLib();
  const word = secret.encode(r.secret, secret.tagOf(r.secret, 'listener', hostKey));
  const line = `/sub-human join ${host} ${code} ${word} --forward ${lport}`;
  const notes = hosting.onceNotes(store, [
    ['rules', hosting.INVITE_RULES],
    ['forward', `They log in to ${host} as themselves (their own account there, as user@${host} if their name differs); nothing is installed for them. Their ssh must be allowed to forward ports (sshd's AllowTcpForwarding, on by default).`],
    ['key', `Their machine checks this one's key (${hostKey.slice(0, 12)}…, named in the line) before it sends anything.`],
    ['install', hosting.INSTALL_HINT],
  ]);
  const parts = { code, how: `over their own ssh login to ${host}`, line, pin: r.pin, ref: r.ref, expires_at: r.expires_at, notes, web: true };
  return {
    pin: r.pin, ref: r.ref, expires_at: r.expires_at, short: true, line, word, locator, hostKey, base: `ws://127.0.0.1:${lport}${roomPath}`, mode: 'ssh-forward', port: lport,
    text: hosting.inviteText(parts), pinned: hosting.invitePinned(parts),
  };
}

function unhost(code: RoomCode): { removed: boolean; text: string } {
  const L = listener();
  const rec = L.removeRoom(code);
  const off = rec ? L.untailscale(rec) : null;
  const left = Object.keys(L.status().rooms);
  const stopped = !left.length && L.stop();
  const text = rec
    ? `room ${code} is no longer served over the web${rec.tailscale ? `; tailscale ${rec.tailscale.funnel ? 'funnel' : 'serve'} ${rec.tailscale.path} ${off && off.ok ? 'is off' : `could not be turned off (${off && off.error}); run: tailscale ${rec.tailscale.funnel ? 'funnel' : 'serve'} --https=443 --set-path=${rec.tailscale.path} off`}` : ''}${stopped ? '; the listener stopped (no room left)' : ''}`
    : `room ${code} was not served over the web here`;
  return { removed: !!rec, text };
}

/** Whether the web listener runs, and whether it serves room code (lib/commands/invite.ts: before a tailnet invite,
 * so one that fails stops only a listener it started). */
function webState(code: RoomCode): { running: boolean; served: boolean } {
  const st = listener().status();
  return { running: st.running, served: !!st.rooms[code] };
}

/** The listener back for a room this home serves over the web, if it is not running (a reboot, a crash): the join
 * hook calls it when a seat of the host joins. Best effort; true when it runs. */
function ensure(code: RoomCode): boolean {
  const L = listener();
  const st = L.status();
  const rec = st.rooms[code];
  if (!rec) return false;
  if (st.running) return true;
  try { L.start(rec.port ? { port: rec.port } : {}); return true; } catch { return false; }
}

export { hostWeb, hostForward, unhost, ensure, frontBase, webState };
