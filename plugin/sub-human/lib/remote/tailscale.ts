/**
 * plugin/sub-human/lib/remote/tailscale.ts: the few `tailscale` CLI calls `/sub-human invite --web | --public`
 * makes, each with a timeout, none interactive. It drives the person's own tailscaled; nothing is embedded.
 *
 *   bin(env?) -> string | null       SUB_HUMAN_TAILSCALE, else `tailscale` on PATH, else
 *                                    /Applications/Tailscale.app/Contents/MacOS/Tailscale (the macOS app's CLI)
 *   self(bin) -> {dnsName, online, backend}   `tailscale status --json`: Self.DNSName without its final dot (the
 *                                    MagicDNS name, box.tail1a2b.ts.net). RoomError OFFLINE when Tailscale is not up:
 *                                    tailscaled not running, logged out (BackendState NeedsLogin) or stopped, each with
 *                                    what to do
 *   serveArgs({path, port, funnel?}) -> argv   [serve|funnel] --bg --https=443 --set-path=PATH http://127.0.0.1:PORT
 *                                    (Tailscale 1.52+). Tailnet only with serve; Funnel makes the path public
 *   offArgs({path, funnel?}) -> argv           [serve|funnel] --https=443 --set-path=PATH off: that one path only
 *                                    (never `serve reset`, which would drop the person's other serves)
 *   on({bin, path, port, funnel?, timeoutMs?}) -> {bin, path, port, https: 443, funnel}   runs serveArgs, watched
 *                                    (watchSync): when the tailnet has Serve / HTTPS (or Funnel) off, the CLI prints
 *                                    "Serve is not enabled on your tailnet. To enable, visit: https://login.
 *                                    tailscale.com/f/serve?node=…" and then waits for an admin; so the first enable
 *                                    URL it prints, or no success within timeoutMs (SERVE_MS, 10 s;
 *                                    SUB_HUMAN_TAILSCALE_SERVE_MS), kills it and throws RoomError INVALID
 *                                    notEnabled(…): the admin page, then "run /sub-human invite --web again".
 *                                    tailscaled not running or logged out: RoomError OFFLINE with what to do. Any other
 *                                    refusal: INVALID with Tailscale's own words
 *   off({bin, path, funnel?}) -> {ok, error?}
 *   warm(url, {timeoutMs?, env?}) -> pid | null   one HTTPS request to the served URL in a detached child, not waited
 *                                    for (WARM_MS, 60 s): Tailscale fetches the name's certificate on the first request
 *                                    (~20 s cold), so the first joiner does not wait on it. SUB_HUMAN_TAILSCALE_WARM=0: off
 *   classify(text) -> {kind: 'enable', feature, url} | {kind: 'not-running'} | {kind: 'logged-out'} | {kind: 'stopped'}
 *                                    | null   what the CLI's output says (enable URLs: login.tailscale.com/f/…)
 *   notEnabled({feature, url, funnel?, waited?}) -> string   the person's message for a tailnet without Serve/Funnel
 *   watch({bin, args, timeoutMs, env?}) -> Promise<{ok, status, text, reason: 'exit'|'enable'|'timeout'|'error',
 *       found?}>   spawn the CLI and stream its stdout/stderr through classify: an enable URL ends it at once (killed),
 *       as does timeoutMs with no exit; ok only for exit 0
 *   watchSync(opts) -> the same, for the sync callers (the join hook, the CLI): watch() in a child node
 *       (`node tailscale.ts --watch JSON`), whose one line of JSON is the result
 *   MAC_APP                          /Applications/Tailscale.app/Contents/MacOS/Tailscale
 *   SERVE_MS                         10 s, on()'s default deadline
 *   CT_WARNING                       the one line `--funnel` prints: the name goes into public CT logs
 * The path is mounted as given; the listener reads the room from the Noise handshake, not the path, so it works
 * whether or not Tailscale strips the mount point before proxying.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { RoomError } from '../room/validate.ts';
import type { TailscaleRec } from './types-rest.ts';

/** What the CLI's output says (classify). */
type Classified =
  | { kind: 'enable'; feature: 'Funnel' | 'Serve'; url: string | null }
  | { kind: 'not-running' }
  | { kind: 'logged-out' }
  | { kind: 'stopped' };

/** watch()'s result. */
interface Watched {
  ok: boolean;
  status: number | null;
  text: string;
  reason: 'exit' | 'enable' | 'timeout' | 'error';
  found?: Classified;
  error?: string;
}

const MAC_APP = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const CALL_MS = 20_000;
const SERVE_MS = 10_000;
const WARM_MS = 60_000;
const ADMIN_DNS = 'https://login.tailscale.com/admin/dns';
const CT_WARNING = 'Funnel makes this URL public: its hostname is published in public certificate-transparency logs, so anyone can find the name (the room still needs the URL\'s secret and the PIN).';
const PATH_RE = /^\/[A-Za-z0-9._~/-]{1,200}$/;
// "Serve is not enabled on your tailnet." / "Funnel is not enabled …" / "HTTPS …", then "To enable, visit:" and a
// login-server URL (https://login.tailscale.com/f/serve?node=…; a custom control server has its own host)
const ENABLE_URL_RE = /https:\/\/[^\s"'<>]+\/f\/(serve|funnel|https)[^\s"'<>]*/i;
const NOT_ENABLED_RE = /\b(Serve|Funnel|HTTPS)\b[^\n]*\bnot enabled\b/i;
const NOT_RUNNING_RE = /failed to connect to local Tailscale|doesn't appear to be running|is tailscaled running|Tailscale is not running|tailscaled\.sock|connect: connection refused|The Tailscale GUI failed to start/i;
const LOGGED_OUT_RE = /Logged out\.|NeedsLogin|not logged in|Log in at:|To authenticate, visit/i;
const STOPPED_RE = /Tailscale is stopped\./i;

function bin(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.SUB_HUMAN_TAILSCALE) return env.SUB_HUMAN_TAILSCALE;
  for (const d of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(d, 'tailscale');
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  try { fs.accessSync(MAC_APP, fs.constants.X_OK); return MAC_APP; } catch { return null; }
}

function call(b: string, args: string[]): { ok: boolean; status: number | null; text: string; error: string | null; stdout: string } {
  const r = spawnSync(b, args, { encoding: 'utf8', timeout: CALL_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  const text = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return { ok: r.status === 0 && !r.error, status: r.status, text, error: r.error ? r.error.message : r.status !== 0 ? (text.split('\n').slice(0, 3).join(' ') || `exit ${r.status}`) : null, stdout: r.stdout || '' };
}

function classify(text: string): Classified | null {
  const s = String(text || '');
  const url = ENABLE_URL_RE.exec(s);
  if (url || NOT_ENABLED_RE.test(s)) {
    const named = NOT_ENABLED_RE.exec(s);
    const word = (named ? named[1] : url![1]).toLowerCase(); // one of the two matched
    return { kind: 'enable', feature: word === 'funnel' ? 'Funnel' : 'Serve', url: url ? url[0].replace(/[.,;)]+$/, '') : null };
  }
  if (NOT_RUNNING_RE.test(s)) return { kind: 'not-running' };
  if (STOPPED_RE.test(s)) return { kind: 'stopped' };
  if (LOGGED_OUT_RE.test(s)) return { kind: 'logged-out' };
  return null;
}

const again = (funnel: boolean): string => `/sub-human invite ${funnel ? '--public' : '--web'}`;

function notEnabled({ feature = 'Serve', url = null, funnel = false, waited = null }: {
  feature?: string; url?: string | null; funnel?: boolean; waited?: number | null;
} = {}): string {
  const f = funnel ? 'Funnel' : feature;
  const console_ = f === 'Funnel'
    ? 'Admin console → DNS → HTTPS Certificates, and the funnel node attribute in Access controls'
    : 'Admin console → DNS → HTTPS Certificates and Serve';
  return `Tailscale ${f} isn't enabled on your tailnet yet${waited ? ` (tailscale ${funnel ? 'funnel' : 'serve'} gave no answer within ${Math.round(waited / 1000)} s)` : ''}. `
    + `An admin turns it on once at ${url || ADMIN_DNS} (or ${console_}), then run ${again(funnel)} again.`;
}

/** What to do when tailscaled is not usable here: RoomError OFFLINE. */
function notUp(kind: string, funnel = false, detail = ''): Error {
  const tail = `then run ${again(funnel)} again`;
  const msg = kind === 'logged-out'
    ? `Tailscale is logged out on this machine: log in (tailscale up, or the Tailscale app's Log in), ${tail}`
    : kind === 'stopped'
      ? `Tailscale is stopped on this machine: turn it on (tailscale up, or Connect in the Tailscale app), ${tail}`
      : `Tailscale isn't running on this machine: start the Tailscale app (or tailscaled) and log in, ${tail}`;
  return new RoomError('OFFLINE', `${msg}${detail ? ` (${detail})` : ''}`);
}

function self(b: string): { dnsName: string; online: boolean; backend: string | null } {
  const r = call(b, ['status', '--json']);
  let j: { BackendState?: string; Self?: { DNSName?: string; Online?: boolean } } | null = null; // parsed JSON, read with care
  try { j = JSON.parse(r.stdout); } catch { /* below */ }
  const backend = j && j.BackendState;
  if (backend === 'NeedsLogin' || backend === 'NoState' || backend === 'NeedsMachineAuth') throw notUp('logged-out', false, `BackendState ${backend}`);
  if (backend === 'Stopped') throw notUp('stopped', false);
  const s = j && j.Self;
  if (!s || !s.DNSName) {
    const c = classify(r.text);
    if (c && c.kind !== 'enable') throw notUp(c.kind, false, r.error || '');
    throw new RoomError('OFFLINE', `Tailscale is not up here (${r.error || 'no Self.DNSName in tailscale status --json'}); run tailscale up first`);
  }
  return { dnsName: String(s.DNSName).replace(/\.$/, '').toLowerCase(), online: s.Online !== false, backend: backend || null };
}

function checkPath(p: string): string {
  if (!PATH_RE.test(String(p))) throw new RoomError('INVALID', `"${p}" is not a plain URL path`);
  return p;
}

const serveArgs = ({ path: p, port, funnel = false }: { path: string; port: number | string; funnel?: boolean }): string[] => {
  if (!(Number(port) >= 1 && Number(port) <= 65535)) throw new RoomError('INVALID', `bad port ${port}`);
  return [funnel ? 'funnel' : 'serve', '--bg', '--https=443', `--set-path=${checkPath(p)}`, `http://127.0.0.1:${Number(port)}`];
};
const offArgs = ({ path: p, funnel = false }: { path: string; funnel?: boolean }): string[] => [funnel ? 'funnel' : 'serve', '--https=443', `--set-path=${checkPath(p)}`, 'off'];

/** Run the CLI, reading its output as it comes: an enable URL or the deadline ends it (killed), else its exit. */
function watch({ bin: b, args, timeoutMs = SERVE_MS, env = process.env }: {
  bin: string; args: string[]; timeoutMs?: number; env?: NodeJS.ProcessEnv;
}): Promise<Watched> {
  return new Promise(resolve => {
    let text = '', done = false, child: ChildProcess | undefined;
    const finish = (reason: Watched['reason'], extra: { status?: number | null; found?: Classified; error?: string } = {}) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (reason !== 'exit' && child) { // its own process group: a wrapper script's children go too
        // no pid: -undefined is NaN, kill throws, and child.kill runs
        try { process.kill(-(child.pid as number), 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      }
      resolve({ ok: reason === 'exit' && extra.status === 0, status: null, text: text.trim(), reason, ...extra });
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    try {
      child = spawn(b, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) { finish('error', { error: (e as Error).message }); return; }
    const onData = (d: Buffer) => {
      text += d;
      const c = classify(text);
      if (c && c.kind === 'enable' && c.url) finish('enable', { found: c });
    };
    child.stdout!.on('data', onData); // stdio: pipe
    child.stderr!.on('data', onData);
    child.on('error', e => finish('error', { error: e.message }));
    child.on('close', status => finish('exit', { status }));
  });
}

/** watch() for a sync caller: a child node runs it and prints the result as one line of JSON. */
function watchSync({ bin: b, args, timeoutMs = SERVE_MS }: { bin: string; args: string[]; timeoutMs?: number }): Watched {
  const r = spawnSync(process.execPath, [import.meta.filename, '--watch', JSON.stringify({ bin: b, args, timeoutMs })],
    { encoding: 'utf8', timeout: timeoutMs + 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  try { return JSON.parse(String(r.stdout).trim().split('\n').at(-1)!); } catch {
    return { ok: false, status: null, text: String(r.stderr || '').trim(), reason: r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? 'timeout' : 'error', error: r.error ? r.error.message : 'no result' };
  }
}

const serveMs = (): number => {
  const v = Number(process.env.SUB_HUMAN_TAILSCALE_SERVE_MS);
  return Number.isFinite(v) && v > 0 ? v : SERVE_MS;
};

function on({ bin: b, path: p, port, funnel = false, timeoutMs = serveMs() }: {
  bin: string; path: string; port: number | string; funnel?: boolean; timeoutMs?: number;
}): TailscaleRec {
  const r = watchSync({ bin: b, args: serveArgs({ path: p, port, funnel }), timeoutMs });
  if (r.ok) return { bin: b, path: p, port: Number(port), https: 443, funnel };
  const c = r.found || classify(r.text);
  if (c && c.kind === 'enable') throw new RoomError('INVALID', notEnabled({ feature: c.feature, url: c.url, funnel }));
  if (c) throw notUp(c.kind, funnel);
  if (r.reason === 'timeout') throw new RoomError('INVALID', notEnabled({ funnel, waited: timeoutMs }));
  const words = r.error || r.text.split('\n').slice(0, 3).join(' ') || `exit ${r.status}`;
  throw new RoomError('INVALID', `tailscale ${funnel ? 'funnel' : 'serve'} refused: ${words}`);
}

/**
 * One HTTPS request to url, in a detached child, not waited for: the first request to a ts.net name makes Tailscale
 * fetch its certificate (~20 s the first time), so the host warms it before the first joiner dials. Its answer does
 * not matter (the listener refuses a plain GET). Off with SUB_HUMAN_TAILSCALE_WARM=0. Returns the child's pid, or null.
 */
function warm(url: string, { timeoutMs = WARM_MS, env = process.env }: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): number | null {
  if (env.SUB_HUMAN_TAILSCALE_WARM === '0' || !/^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9._~/-]*$/.test(String(url))) return null;
  const code = `const r=require('node:https').get(${JSON.stringify(url)},{timeout:${Number(timeoutMs)}},s=>{s.resume();s.on('end',()=>process.exit(0))});`
    + 'r.on(\'timeout\',()=>r.destroy());r.on(\'error\',()=>process.exit(0));';
  try {
    const c = spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' });
    c.on('error', () => {});
    c.unref();
    return c.pid || null;
  } catch { return null; }
}

function off({ bin: b, path: p, funnel = false }: { bin: string; path: string; funnel?: boolean }): { ok: boolean; error?: string | null } {
  const r = call(b, offArgs({ path: p, funnel }));
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

export {
  MAC_APP, SERVE_MS, CT_WARNING, bin, self, serveArgs, offArgs, on, off, warm, classify, notEnabled, watch,
  watchSync,
};

if (import.meta.main && process.argv[2] === '--watch') {
  watch(JSON.parse(process.argv[3])).then(r => { process.stdout.write(JSON.stringify(r) + '\n'); process.exit(0); });
}
