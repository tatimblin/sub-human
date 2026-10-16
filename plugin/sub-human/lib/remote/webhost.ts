/**
 * plugin/sub-human/lib/remote/webhost.ts: the host's side of a join over the web (1.1), shared by the join hook
 * (`/sub-human invite --web`, `--public`, `--url URL`, `/sub-human invite --stop`: block reasons the person reads,
 * never the model) and the CLI (lib/cli/host.ts). The wire is
 * lib/remote/transports/ws.ts; the daemon lib/remote/listener.ts; the Tailscale calls lib/remote/tailscale.ts.
 *
 * hostWeb: an invite line `/sub-human join https://HOST/…/sub-human/ROOM SECRET`, its SECRET's tag naming the
 * listener's X25519 key (role 'listener': the joiner checks it before its Noise handshake), and a 4-digit PIN told
 * apart. It starts the listener (127.0.0.1 only) and puts the room in its served set. tailscale (`--web`): Tailscale
 * Serve for /sub-human/CODE on this node's MagicDNS name (tailnet only), its certificate warmed in the background;
 * funnel (`--public`): the same through Funnel (public; the text carries tailscale.CT_WARNING); url: any HTTPS front
 * that forwards to the listener. unhost (`invite --stop`) turns off the room's own Tailscale path only; links already
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
import type * as InvitesMod from './invites.ts';
import type * as InviteSecretMod from './invite-secret.ts';
import type * as HostingMod from './hosting.ts';
import { lazy } from '../io.ts';
import * as room from '../room.ts';

// the listener, tailscale and the invite code only when a room is served over the web (start cost: hooks load this file)
const inviteSecretLib = lazy<typeof InviteSecretMod>(import.meta.url, './invite-secret.ts');
const hostingLib = lazy<typeof HostingMod>(import.meta.url, './hosting.ts');
const invitesLib = lazy<typeof InvitesMod>(import.meta.url, './invites.ts');

const listener = lazy<typeof ListenerMod>(import.meta.url, './listener.ts');
const ts = lazy<typeof TailscaleMod>(import.meta.url, './tailscale.ts');
const wsT = lazy<typeof WsMod>(import.meta.url, './transports/ws.ts');

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
    throw new RoomError('INVALID', `--url takes a plain https://host[:port][/prefix], not "${text}"`);
  }
  const prefix = u.pathname.replace(/\/+$/, '');
  return { secure: u.protocol === 'https:', host: u.hostname, port: u.port ? Number(u.port) : undefined, prefix };
}

function hostWeb(code: RoomCode, { tailscale = false, funnel = false, url, port, by = null, now = Date.now() }: {
  tailscale?: boolean; funnel?: boolean; url?: string | undefined; port?: number | undefined; by?: string | null; now?: number;
} = {}): WebInvite {
  const store = hostStore(code);
  if (funnel) tailscale = true;
  if (!tailscale && !url) throw new RoomError('INVALID', 'say how joiners reach the listener: --web (Tailscale), --public (Funnel), or --url https://YOUR-FRONT');
  if (tailscale && url) throw new RoomError('INVALID', '--web / --public and --url are two ways to the same listener; pick one');
  const L = listener();
  const served = L.status().rooms[code];
  const { port: lport } = L.start(port ? { port } : {});
  const roomPath = `/sub-human/${code}`;
  let base: FrontBase, mode: string, tsRec: TailscaleRec | null | undefined = null;
  if (tailscale) {
    const bin = ts().bin();
    if (!bin) throw new RoomError('INVALID', 'no tailscale CLI here (not on PATH, no /Applications/Tailscale.app); install Tailscale, or use --url with a front of your own');
    const me = ts().self(bin);
    const same = served && served.tailscale && served.tailscale.path === roomPath && !!served.tailscale.funnel === !!funnel && served.tailscale.port === lport;
    if (served && served.tailscale && !same) L.untailscale(served);
    tsRec = same ? served.tailscale : ts().on({ bin, path: roomPath, port: lport, funnel });
    // the name's certificate: Tailscale fetches it on the first HTTPS request (~20 s cold); start that now, not waited for
    if (!same) ts().warm(`https://${me.dnsName}${roomPath}`);
    base = { secure: true, host: me.dnsName, port: undefined, prefix: '' };
    mode = funnel ? 'funnel' : 'tailscale';
  } else {
    if (served && served.tailscale) L.untailscale(served);
    base = frontBase(url ?? ''); // checked above: one of tailscale and url (url is set here)
    mode = 'url';
  }
  const p = `${base.prefix}${roomPath}`;
  const locator = wsT().locator({ host: base.host, port: base.port, path: p }, base.secure);
  if (!locator) throw new RoomError('INVALID', `the front ${base.host} gives no plain URL for this room`);
  const hostKey = L.hostKey();
  const joinBase = `${base.secure ? 'https' : 'http'}://${base.host}${base.port ? `:${base.port}` : ''}${p}`;
  L.addRoom(code, { path: p, url: joinBase, mode, port: lport, ...(tsRec ? { tailscale: tsRec } : {}) });
  const how = mode === 'funnel' ? 'Tailscale Funnel (public)' : mode === 'tailscale' ? 'Tailscale Serve (your tailnet only)' : `your front ${base.host}`;
  const notes = [
    ...(tsRec ? ['The first connection to a new ts.net name can take ~20 s while Tailscale issues its certificate; it is being fetched now, and their machine keeps trying.'] : []),
    ...(mode === 'funnel' ? [ts().CT_WARNING] : []),
    'Stop serving it with /sub-human invite --stop (closing the room does too).',
  ];
  // the URL and the line's SECRET, its tag naming the listener's key; the PIN told apart
  const r = invitesLib().mintInvite(store, { kind: 'ws', locator, by, now });
  const secret = inviteSecretLib();
  const word = secret.encode(r.secret, secret.tagOf(r.secret, 'listener', hostKey));
  const line = `/sub-human join ${joinBase} ${word}`;
  const hosting = hostingLib();
  const parts = {
    code, how: `over the web through ${how} to this machine's listener on 127.0.0.1:${lport}`, line, pin: r.pin, ref: r.ref,
    extra: [`Their machine checks this one's key (${hostKey.slice(0, 12)}…, named in the line) before it sends anything, so nothing in between can read along.`, ...notes],
  };
  const text = hosting.inviteText(parts);
  const pinned = hosting.invitePinned({ ...parts, expires_at: r.expires_at });
  return { pin: r.pin, ref: r.ref, expires_at: r.expires_at, short: true, line, word, locator, hostKey, base: joinBase, mode, port: lport, text, pinned };
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

/** The wss locator of room CODE behind a front at URL (https://FRONT[/prefix]): wss://FRONT/prefix/sub-human/CODE. */
function webLocator(url: string, code: RoomCode): string {
  const b = frontBase(url);
  const loc = wsT().locator({ host: b.host, port: b.port, path: `${b.prefix}/sub-human/${code}` }, b.secure);
  if (!loc) throw new RoomError('INVALID', `"${url}" gives no plain URL for room ${code}`);
  return loc;
}

/** Serve room CODE at a web locator this machine will host it at (a handoff or promote to here): the listener up and
 * the room in its served set. A Tailscale path is not set up here: run /sub-human invite --web after the move. */
function serveAt(code: RoomCode, locator: string): { port: number; hostKey: string } {
  const i = locator.indexOf(':');
  const spec = wsT().parse(locator.slice(i + 1));
  if (!spec) throw new RoomError('INVALID', `"${locator}" is not a web locator`);
  const L = listener();
  const { port } = L.start();
  L.addRoom(code, { path: spec.path, url: wsT().urlOf({ ...spec, kind: locator.slice(0, i) }), mode: 'handoff', port });
  return { port, hostKey: L.hostKey() };
}

export { hostWeb, unhost, ensure, frontBase, webLocator, serveAt };
