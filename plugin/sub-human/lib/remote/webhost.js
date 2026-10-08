'use strict';
/**
 * plugin/sub-human/lib/remote/webhost.js: the host's side of a join over the web (1.1), shared by the join hook
 * (`/sub-human host --tailscale [--funnel]`, `/sub-human host --url URL`, `/sub-human unhost`: block reasons the
 * person reads, never the model) and the CLI (lib/cli/host.js, lib/cli/listen.js). The wire is
 * lib/remote/transports/ws.js; the daemon lib/remote/listener.js; the Tailscale calls lib/remote/tailscale.js.
 *
 *   hostWeb(code, {tailscale?, funnel?, url?, port?, now?}) -> {invite, joinUrl, pin, expires_at, locator, hostKey,
 *       base, mode, text}
 *       Starts the listener (idempotent, 127.0.0.1:port, default 7420), puts the room in its served set, and mints an
 *       sh2 invite whose locator is wss://HOST/…/sub-human/CODE and whose host-key field is the listener's X25519
 *       key (lib/remote/listener.js hostKey), with its PIN (lib/remote/auth.js: online only, 5 tries, 15 minutes).
 *       tailscale: Tailscale Serve for /sub-human/CODE -> http://127.0.0.1:PORT on this node's MagicDNS name (tailnet
 *       only); funnel: the same through Funnel (public; the text carries tailscale.CT_WARNING). url: any HTTPS front
 *       that forwards to the listener (the lab's tls-front, a reverse proxy of the person's own): the join URL is
 *       URL/sub-human/CODE. joinUrl is the paste-able form: https://HOST/…/sub-human/CODE#SECRET.HOSTKEY. Unlike ssh
 *       there is no admit step: the invite's secret, its PIN and the pinned key are the admission, and the room line
 *       the host writes when the PIN holds (lib/remote/server.js) records it
 *   unhost(code) -> {removed, text}   the room leaves the served set and its own Tailscale path (only that one) is
 *       turned off; the listener stops once it serves no room. Links already made keep their token but cannot
 *       reach the room over the web until it is hosted again
 */

const { RoomError } = require('../room/validate.js');
const { INVITE_TTL_MS } = require('../config.js');

const listener = () => require('./listener.js');
const ts = () => require('./tailscale.js');
const wsT = () => require('./transports/ws.js');

function hostStore(code) {
  const identity = require('../identity.js');
  if (!identity.roomExists(code)) throw new RoomError('NO_ROOM', `no room "${code}"`);
  const s = require('../room.js').open(code).store;
  if (!s.isHost) throw new RoomError('HOST_ONLY', `room ${code} is hosted on another machine; its host does this`);
  return s;
}

/** The front's base URL, checked: http(s)://host[:port][/prefix], nothing else. */
function frontBase(text) {
  let u;
  try { u = new URL(String(text)); } catch { throw new RoomError('INVALID', `"${text}" is not a URL (https://host[:port][/prefix])`); }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.search || u.hash) {
    throw new RoomError('INVALID', `--url takes a plain https://host[:port][/prefix], not "${text}"`);
  }
  const prefix = u.pathname.replace(/\/+$/, '');
  return { secure: u.protocol === 'https:', host: u.hostname, port: u.port ? Number(u.port) : undefined, prefix };
}

function hostWeb(code, { tailscale = false, funnel = false, url, port, now = Date.now() } = {}) {
  const store = hostStore(code);
  if (funnel) tailscale = true;
  if (!tailscale && !url) throw new RoomError('INVALID', 'say how joiners reach the listener: --tailscale [--funnel], or --url https://YOUR-FRONT');
  if (tailscale && url) throw new RoomError('INVALID', '--tailscale and --url are two ways to the same listener; pick one');
  const L = listener();
  const served = L.status().rooms[code];
  const { port: lport } = L.start(port ? { port } : {});
  const roomPath = `/sub-human/${code}`;
  let base, mode, tsRec = null;
  if (tailscale) {
    const bin = ts().bin();
    if (!bin) throw new RoomError('INVALID', 'no tailscale CLI here (not on PATH, no /Applications/Tailscale.app); install Tailscale, or use --url with a front of your own');
    const me = ts().self(bin);
    const same = served && served.tailscale && served.tailscale.path === roomPath && !!served.tailscale.funnel === !!funnel && served.tailscale.port === lport;
    if (served && served.tailscale && !same) L.untailscale(served);
    tsRec = same ? served.tailscale : ts().on({ bin, path: roomPath, port: lport, funnel });
    base = { secure: true, host: me.dnsName, port: undefined, prefix: '' };
    mode = funnel ? 'funnel' : 'tailscale';
  } else {
    if (served && served.tailscale) L.untailscale(served);
    base = frontBase(url);
    mode = 'url';
  }
  const p = `${base.prefix}${roomPath}`;
  const locator = wsT().locator({ host: base.host, port: base.port, path: p }, base.secure);
  if (!locator) throw new RoomError('INVALID', `the front ${base.host} gives no plain URL for this room`);
  const hostKey = L.hostKey();
  const joinBase = `${base.secure ? 'https' : 'http'}://${base.host}${base.port ? `:${base.port}` : ''}${p}`;
  L.addRoom(code, { path: p, url: joinBase, mode, port: lport, ...(tsRec ? { tailscale: tsRec } : {}) });
  const r = require('./auth.js').mintInvite(store, { locator, pin: true, hostKey, now });
  const joinUrl = wsT().joinUrl({ locator, secret: r.secret, hostKey });
  const how = mode === 'funnel' ? 'Tailscale Funnel (public)' : mode === 'tailscale' ? 'Tailscale Serve (your tailnet only)' : `your front ${base.host}`;
  const lines = [
    `invite to room ${code}, for one machine, over the web through ${how} to this machine's listener on 127.0.0.1:${lport}. Shown once; it lasts ${Math.round(INVITE_TTL_MS / 60_000)} minutes.`,
    '',
    `  /sub-human join NAME ${joinUrl} PIN`,
    '',
    `PIN ${r.pin}  (send it apart from the link, e.g. say it; 5 wrong tries burn the invite)`,
    `The link pins this machine's listener key ${hostKey.slice(0, 12)}… and carries a one-time secret; with the PIN that is the whole admission (no admit step). The same invite as text: ${r.invite}`,
  ];
  if (mode === 'funnel') lines.push(ts().CT_WARNING);
  lines.push(`Stop serving it with /sub-human unhost (closing the room does too).`);
  return { ...r, joinUrl, locator, hostKey, base: joinBase, mode, port: lport, text: lines.join('\n') };
}

function unhost(code) {
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

module.exports = { hostWeb, unhost, frontBase };
