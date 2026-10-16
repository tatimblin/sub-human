/**
 * plugin/sub-human/lib/remote/webhost.ts: the host's side of a join over the web (1.1), shared by the join hook
 * (`/sub-human invite --web`, `--public`, `--url URL`, `/sub-human invite --stop`: block reasons the person reads,
 * never the model) and the CLI (lib/cli/host.ts). The wire is
 * lib/remote/transports/ws.ts; the daemon lib/remote/listener.ts; the Tailscale calls lib/remote/tailscale.ts.
 *
 *   hostWeb(code, {tailscale?, funnel?, url?, port?, by?, now?}) -> {pin, ref, expires_at, short: true, line, locator,
 *       hostKey, base, mode, port, text}
 *       A short invite: `/sub-human join https://HOST/…/sub-human/ROOM 4829`, the 4-digit PIN the whole secret
 *       (lib/remote/invites.ts mintShort, kind ws, vouching for the listener's X25519 key inside the PAKE,
 *       lib/remote/enroll.ts); the host person's card admits the joiner. Starts the listener (idempotent,
 *       127.0.0.1:port, default 7420) and puts the room in its served set; the locator is wss://HOST/…/sub-human/ROOM.
 *       tailscale (`--web`): Tailscale Serve for /sub-human/CODE -> http://127.0.0.1:PORT on this node's MagicDNS name (tailnet
 *       only), then one background request to it to warm its certificate (tailscale.warm); funnel (`--public`): the
 *       same through Funnel (public; the text carries tailscale.CT_WARNING). url: any HTTPS front that forwards to the
 *       listener (the lab's tls-front, a reverse proxy of the person's own): the join URL is URL/sub-human/ROOM
 *   ensure(code) -> bool   start the listener again for a room it serves (after a reboot): the join hook, on a host seat
 *   webLocator(url, code) -> 'wss://FRONT/prefix/sub-human/CODE'   a handoff's or promote's --url
 *   serveAt(code, locator) -> {port, hostKey}   this machine is about to host CODE at a web locator (lib/handoff.ts accept,
 *       promote): the listener up, the room served; its invites pin hostKey. A Tailscale path is set up by invite --web
 *   unhost(code) -> {removed, text}   (`invite --stop`) the room leaves the served set and its own Tailscale path (only that one) is
 *       turned off; the listener stops once it serves no room. Links already made keep their token but cannot
 *       reach the room over the web until it is hosted again
 *   frontBase(url) -> {secure, host, port?, prefix}   a front's base URL, checked: http(s)://host[:port][/prefix] only
 */

import { RoomError } from '../room/validate.ts';
import { createRequire } from 'node:module';
import type { TailscaleRec } from './types-rest.ts';
import type { RoomStore } from '../room/types.ts';

const require = createRequire(import.meta.url);

const listener = (): typeof import('./listener.ts') => require('./listener.ts');
const ts = (): typeof import('./tailscale.ts') => require('./tailscale.ts');
const wsT = (): typeof import('./transports/ws.ts') => require('./transports/ws.ts');

/** A front's base URL, checked. */
export interface FrontBase {
  secure: boolean;
  host: string;
  port: number | undefined;
  prefix: string;
}

/** A web invite as hostWeb returns it. */
export interface WebInvite extends ReturnType<typeof import('./invites.ts')['mintShort']> {
  short: true;
  line: string;
  locator: string;
  hostKey: string;
  base: string;
  mode: string;
  port: number;
  text: string;
}

const hostStore = (code: string): RoomStore => (require('../room.ts') as typeof import('../room.ts')).hostStore(code);

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

function hostWeb(code: string, { tailscale = false, funnel = false, url, port, by = null, now = Date.now() }: {
  tailscale?: boolean; funnel?: boolean; url?: string; port?: number; by?: string | null; now?: number;
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
    base = frontBase(url!); // checked above: one of tailscale and url
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
  // the URL and a 4-digit PIN (lib/remote/enroll.ts over the listener's text frames)
  const r = (require('./invites.ts') as typeof import('./invites.ts')).mintShort(store, { kind: 'ws', locator, hostKey, by, now });
  const line = `/sub-human join ${joinBase} ${r.pin}`;
  const text = (require('./hosting.ts') as typeof import('./hosting.ts')).shortText({
    code, how: `over the web through ${how} to this machine's listener on 127.0.0.1:${lport}`, line, ref: r.ref,
    extra: [`Their machine checks this one's key (${hostKey.slice(0, 12)}…) as part of the PIN check, so nothing in between can read along.`, ...notes],
  });
  return { ...r, short: true, line, locator, hostKey, base: joinBase, mode, port: lport, text };
}

function unhost(code: string): { removed: boolean; text: string } {
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
function ensure(code: string): boolean {
  const L = listener();
  const st = L.status();
  const rec = st.rooms[code];
  if (!rec) return false;
  if (st.running) return true;
  try { L.start(rec.port ? { port: rec.port } : {}); return true; } catch { return false; }
}

/** The wss locator of room CODE behind a front at URL (https://FRONT[/prefix]): wss://FRONT/prefix/sub-human/CODE. */
function webLocator(url: string, code: string): string {
  const b = frontBase(url);
  const loc = wsT().locator({ host: b.host, port: b.port, path: `${b.prefix}/sub-human/${code}` }, b.secure);
  if (!loc) throw new RoomError('INVALID', `"${url}" gives no plain URL for room ${code}`);
  return loc;
}

/** Serve room CODE at a web locator this machine will host it at (a handoff or promote to here): the listener up and
 * the room in its served set. A Tailscale path is not set up here: run /sub-human invite --web after the move. */
function serveAt(code: string, locator: string): { port: number; hostKey: string } {
  const i = locator.indexOf(':');
  const spec = wsT().parse(locator.slice(i + 1));
  if (!spec) throw new RoomError('INVALID', `"${locator}" is not a web locator`);
  const L = listener();
  const { port } = L.start();
  L.addRoom(code, { path: spec.path, url: wsT().urlOf({ ...spec, kind: locator.slice(0, i) }), mode: 'handoff', port });
  return { port, hostKey: L.hostKey() };
}

export { hostWeb, unhost, ensure, frontBase, webLocator, serveAt };
