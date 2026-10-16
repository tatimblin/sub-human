// Optional, on this Mac, opt-in only (TS_SERVE=1 and a tailscale CLI: on PATH or /Applications/Tailscale.app): the
// real Tailscale Serve in front of the plugin's real listener. A throwaway home, `sub-human listen --port <free>` in
// it, then exactly the command `/sub-human invite --web` runs (lib/remote/tailscale.ts serveArgs):
//   tailscale serve --bg --https=443 --set-path=/sub-human-lab-<rand> http://127.0.0.1:<port>
// a wss connection to https://<this node's MagicDNS name>/sub-human-lab-<rand> (Tailscale's own certificate, no extra
// CA) and a Noise XK handshake pinned to the listener's key: the listener answers inside the channel that it serves
// no such room, which only the holder of the pinned key can say. Then exactly what `invite --stop` runs (offArgs):
//   tailscale serve --https=443 --set-path=/sub-human-lab-<rand> off
// (only that path; never `serve reset`, never Funnel). The path must be gone from `tailscale serve status` after.
// A tailnet without Serve/HTTPS: the CLI prints an enable URL and waits; tailscale.on() stops it within 10 s and the
// check fails with its message (the admin page to visit), and nothing is turned off. The listener is stopped and
// awaited before its throwaway home is removed (it writes there until it exits).
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { PLUGIN, pluginLib as lib, roomCode } from '../../lib/paths.ts';
import type { T } from '../lab.ts';

const freePort = (): Promise<number> => new Promise(r => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const a = s.address(); s.close(() => r(a && typeof a === 'object' ? a.port : 0)); });
});
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const codeOf = (e: unknown): unknown => (e && typeof e === 'object' && 'code' in e ? e.code : undefined);

export const id = 'tailscale';
export const title = 'real `tailscale serve --bg` (tailnet only) in front of the real listener, a pinned Noise handshake through it, then that path off';
export const persona = 'P1 friends (1.1, real Tailscale)';
export const budgetMs = 90_000;
export const skip = (): string | null => (process.env.TS_SERVE !== '1' ? 'opt-in: set TS_SERVE=1 (runs real `tailscale serve` on this Mac)' : !lib('remote/tailscale.ts').bin() ? 'no tailscale CLI' : null);
export async function run(t: T): Promise<void> {
  const ts = lib('remote/tailscale.ts');
  const bin = ts.bin();
  if (!bin) { t.check('a tailscale CLI', false, 'none (skip checks it)'); return; }
  let me: ReturnType<typeof ts.self>;
  try { me = ts.self(bin); } catch (e) { t.check('tailscale is up on this Mac', false, msgOf(e)); return; }
  t.check('tailscale is up on this Mac', !!me.dnsName, me.dnsName);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-ts-home-'));
  const port = await freePort();
  const p = `/sub-human-lab-${crypto.randomBytes(3).toString('hex')}`;
  const env = { ...process.env, SUB_HUMAN_HOME: home };
  const srv = spawn(process.execPath, [path.join(PLUGIN, 'scripts', 'sub-human'), 'listen', '--port', String(port)], { env, stdio: 'ignore' });
  let on: ReturnType<typeof ts.on> | null = null;
  try {
    await t.sleep(800);
    const old = process.env.SUB_HUMAN_HOME;
    process.env.SUB_HUMAN_HOME = home;
    const hostKey = lib('remote/listener.ts').hostKey();
    process.env.SUB_HUMAN_HOME = old;
    const argv = ts.serveArgs({ path: p, port });
    t.log(`${bin} ${argv.join(' ')}`);
    let refused: unknown = null;
    try { on = ts.on({ bin, path: p, port }); } catch (e) { refused = e; t.ev.write('serve-on.txt', `${String(codeOf(e) || '')} ${msgOf(e)}`); }
    // Serve/HTTPS not enabled on the tailnet (the CLI prints an enable URL and waits): on() stops it and says so
    t.check(`tailscale ${argv.join(' ')}`, !!on, on ? 'ok' : msgOf(refused));
    if (!on) return;
    ts.warm(`https://${me.dnsName}${p}`); // as /sub-human invite --web does: the certificate is fetched now
    const ws = lib('remote/ws.ts');
    const wsT = lib('remote/transports/ws.ts');
    let res: string;
    try {
      const conn = await ws.connect(`wss://${me.dnsName}${p}`, { timeoutMs: 45_000 }); // a cold ts.net certificate takes ~20 s
      try { await wsT.clientChannel(conn, { rs: Buffer.from(hostKey, 'base64url'), code: roomCode('vole-0001'), s: lib('remote/noise.ts').generateKeyPair() }); res = 'joined?!'; } catch (e) { res = `${String(codeOf(e))}: ${msgOf(e)}`; }
    } catch (e) { res = `connect: ${msgOf(e)}`; }
    t.ev.write('handshake.txt', res);
    t.check(`a wss + Noise XK handshake through https://${me.dnsName}${p}, pinned to the listener's key (it answers that it serves no such room)`,
      /^OFFLINE: .*not open for joins over the web/.test(res), res);
  } finally {
    if (on) { // nothing to turn off when serve never took the path (Serve not enabled on the tailnet)
      const off = ts.off({ bin, path: p });
      t.log(`${bin} ${ts.offArgs({ path: p }).join(' ')}: ${off.ok ? 'ok' : off.error}`);
      const status = spawnSync(bin, ['serve', 'status'], { encoding: 'utf8', timeout: 20_000 }).stdout || '';
      t.ev.write('serve-status-after.txt', status);
      t.check(`${p} turned off again; other serves untouched`, off.ok && !status.includes(p), off.error || '');
    }
    // the listener writes its state and log into the home until it exits: wait for it, then remove the home
    await new Promise<void>(r => { if (srv.exitCode !== null || srv.signalCode !== null) r(); else { srv.once('exit', () => r()); srv.kill(); } });
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
