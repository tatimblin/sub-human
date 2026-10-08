'use strict';
// Optional, on this Mac, opt-in only (TS_SERVE=1 and a tailscale CLI: on PATH or /Applications/Tailscale.app): the
// real Tailscale Serve in front of the plugin's real listener. A throwaway home, `sub-human listen --port <free>` in
// it, then exactly the command `/sub-human host --tailscale` runs (lib/remote/tailscale.js serveArgs):
//   tailscale serve --bg --https=443 --set-path=/sub-human-lab-<rand> http://127.0.0.1:<port>
// a wss connection to https://<this node's MagicDNS name>/sub-human-lab-<rand> (Tailscale's own certificate, no extra
// CA) and a Noise_NK handshake pinned to the listener's key: the listener answers inside the channel that it serves
// no such room, which only the holder of the pinned key can say. Then exactly what unhost runs (offArgs):
//   tailscale serve --https=443 --set-path=/sub-human-lab-<rand> off
// (only that path; never `serve reset`, never Funnel). The path must be gone from `tailscale serve status` after.
// A tailnet without Serve/HTTPS: the CLI prints an enable URL and waits; tailscale.on() stops it within 10 s and the
// check fails with its message (the admin page to visit), and nothing is turned off. The listener is stopped and
// awaited before its throwaway home is removed (it writes there until it exits).
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const PLUGIN = path.join(__dirname, '..', '..', '..', 'plugin', 'sub-human');
const lib = rel => require(path.join(PLUGIN, 'lib', rel));
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

module.exports = {
  id: 'tailscale',
  title: 'real `tailscale serve --bg` (tailnet only) in front of the real listener, a pinned Noise handshake through it, then that path off',
  persona: 'P1 friends (1.1, real Tailscale)',
  budgetMs: 90_000,
  skip: () => (process.env.TS_SERVE !== '1' ? 'opt-in: set TS_SERVE=1 (runs real `tailscale serve` on this Mac)' : !lib('remote/tailscale.js').bin() ? 'no tailscale CLI' : null),
  async run(t) {
    const ts = lib('remote/tailscale.js');
    const bin = ts.bin();
    let me;
    try { me = ts.self(bin); } catch (e) { t.check('tailscale is up on this Mac', false, e.message); return; }
    t.check('tailscale is up on this Mac', !!me.dnsName, me.dnsName);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-ts-home-'));
    const port = await freePort();
    const p = `/sub-human-lab-${crypto.randomBytes(3).toString('hex')}`;
    const env = { ...process.env, SUB_HUMAN_HOME: home };
    const srv = spawn(process.execPath, [path.join(PLUGIN, 'scripts', 'sub-human'), 'listen', '--port', String(port)], { env, stdio: 'ignore' });
    let on = null;
    try {
      await t.sleep(800);
      const old = process.env.SUB_HUMAN_HOME;
      process.env.SUB_HUMAN_HOME = home;
      const hostKey = lib('remote/listener.js').hostKey();
      process.env.SUB_HUMAN_HOME = old;
      const argv = ts.serveArgs({ path: p, port });
      t.log(`${bin} ${argv.join(' ')}`);
      let refused = null;
      try { on = ts.on({ bin, path: p, port }); } catch (e) { refused = e; t.ev.write('serve-on.txt', `${e.code || ''} ${e.message}`); }
      // Serve/HTTPS not enabled on the tailnet (the CLI prints an enable URL and waits): on() stops it and says so
      t.check(`tailscale ${argv.join(' ')}`, !!on, on ? 'ok' : refused.message);
      if (!on) return;
      ts.warm(`https://${me.dnsName}${p}`); // as /sub-human host --tailscale does: the certificate is fetched now
      const ws = lib('remote/ws.js');
      const wsT = lib('remote/transports/ws.js');
      let res;
      try {
        const conn = await ws.connect(`wss://${me.dnsName}${p}`, { timeoutMs: 45_000 }); // a cold ts.net certificate takes ~20 s
        try { await wsT.clientChannel(conn, { rs: Buffer.from(hostKey, 'base64url'), code: 'vole-0001' }); res = 'joined?!'; } catch (e) { res = `${e.code}: ${e.message}`; }
      } catch (e) { res = `connect: ${e.message}`; }
      t.ev.write('handshake.txt', res);
      t.check(`a wss + Noise_NK handshake through https://${me.dnsName}${p}, pinned to the listener's key (it answers that it serves no such room)`,
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
      await new Promise(r => { if (srv.exitCode !== null || srv.signalCode !== null) r(); else { srv.once('exit', r); srv.kill(); } });
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
};
