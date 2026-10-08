'use strict';
/**
 * plugin/sub-human/lib/remote/tailscale.js: the few `tailscale` CLI calls `/sub-human host --tailscale [--funnel]`
 * makes, each with a timeout, none interactive. It drives the person's own tailscaled; nothing is embedded.
 *
 *   bin(env?) -> string | null       SUB_HUMAN_TAILSCALE, else `tailscale` on PATH, else
 *                                    /Applications/Tailscale.app/Contents/MacOS/Tailscale (the macOS app's CLI)
 *   self(bin) -> {dnsName, online}   `tailscale status --json`: Self.DNSName without its final dot (the MagicDNS
 *                                    name, box.tail1a2b.ts.net). RoomError OFFLINE when Tailscale is not up
 *   serveArgs({path, port, funnel?}) -> argv   [serve|funnel] --bg --https=443 --set-path=PATH http://127.0.0.1:PORT
 *                                    (Tailscale 1.52+). Tailnet only with serve; Funnel makes the path public
 *   offArgs({path, funnel?}) -> argv           [serve|funnel] --https=443 --set-path=PATH off: that one path only
 *                                    (never `serve reset`, which would drop the person's other serves)
 *   on({bin, path, port, funnel?}) -> {bin, path, port, https: 443, funnel}   runs serveArgs; RoomError INVALID with
 *                                    Tailscale's own words when it refuses (HTTPS certificates or Funnel not enabled
 *                                    on the tailnet: it names the admin page to visit)
 *   off({bin, path, funnel?}) -> {ok, error?}
 *   CT_WARNING                       the one line `--funnel` prints: the name goes into public CT logs
 * The path is mounted as given; the listener reads the room from the Noise handshake, not the path, so it works
 * whether or not Tailscale strips the mount point before proxying.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { RoomError } = require('../room/validate.js');

const MAC_APP = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const CALL_MS = 20_000;
const CT_WARNING = 'Funnel makes this URL public: its hostname is published in public certificate-transparency logs, so anyone can find the name (the room still needs the URL\'s secret and the PIN).';
const PATH_RE = /^\/[A-Za-z0-9._~/-]{1,200}$/;

function bin(env = process.env) {
  if (env.SUB_HUMAN_TAILSCALE) return env.SUB_HUMAN_TAILSCALE;
  for (const d of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(d, 'tailscale');
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  try { fs.accessSync(MAC_APP, fs.constants.X_OK); return MAC_APP; } catch { return null; }
}

function call(b, args) {
  const r = spawnSync(b, args, { encoding: 'utf8', timeout: CALL_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  const text = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return { ok: r.status === 0 && !r.error, status: r.status, text, error: r.error ? r.error.message : r.status !== 0 ? (text.split('\n').slice(0, 3).join(' ') || `exit ${r.status}`) : null, stdout: r.stdout || '' };
}

function self(b) {
  const r = call(b, ['status', '--json']);
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { /* below */ }
  const s = j && j.Self;
  if (!s || !s.DNSName) throw new RoomError('OFFLINE', `Tailscale is not up here (${r.error || 'no Self.DNSName in tailscale status --json'}); run tailscale up first`);
  return { dnsName: String(s.DNSName).replace(/\.$/, '').toLowerCase(), online: s.Online !== false, backend: j.BackendState || null };
}

function checkPath(p) {
  if (!PATH_RE.test(String(p))) throw new RoomError('INVALID', `"${p}" is not a plain URL path`);
  return p;
}

const serveArgs = ({ path: p, port, funnel = false }) => {
  if (!(Number(port) >= 1 && Number(port) <= 65535)) throw new RoomError('INVALID', `bad port ${port}`);
  return [funnel ? 'funnel' : 'serve', '--bg', '--https=443', `--set-path=${checkPath(p)}`, `http://127.0.0.1:${Number(port)}`];
};
const offArgs = ({ path: p, funnel = false }) => [funnel ? 'funnel' : 'serve', '--https=443', `--set-path=${checkPath(p)}`, 'off'];

function on({ bin: b, path: p, port, funnel = false }) {
  const r = call(b, serveArgs({ path: p, port, funnel }));
  if (!r.ok) throw new RoomError('INVALID', `tailscale ${funnel ? 'funnel' : 'serve'} refused: ${r.error}`);
  return { bin: b, path: p, port: Number(port), https: 443, funnel };
}

function off({ bin: b, path: p, funnel = false }) {
  const r = call(b, offArgs({ path: p, funnel }));
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

module.exports = { MAC_APP, CT_WARNING, bin, self, serveArgs, offArgs, on, off };
