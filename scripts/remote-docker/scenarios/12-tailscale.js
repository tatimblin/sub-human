'use strict';
// Optional, on this Mac, opt-in only (TS_SERVE=1 and /Applications/Tailscale.app present): the real Tailscale Serve
// in front of a local listener. A stand-in ws listener (lab/ws-probe.js) on 127.0.0.1:<free port>, then
// `tailscale serve --bg --https=443 --set-path=/sub-human-lab-<rand> http://127.0.0.1:<port>`, a wss upgrade to
// https://<this node's MagicDNS name>/sub-human-lab-<rand>, and finally that one path turned off again (the user's
// other serves are left alone; no `serve reset`). Never Funnel. With LAB_FEATURES ws=1 a real `sub-human listen` can
// replace the stand-in later (LAB_TS_LISTEN_CMD).
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const TS = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const PROBE = path.join(__dirname, '..', 'lab', 'ws-probe.js');

const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const ts = (...args) => spawnSync(TS, args, { encoding: 'utf8', timeout: 30_000 });

module.exports = {
  id: 'tailscale',
  title: 'real `tailscale serve --bg` (tailnet only) in front of a local listener, then reset',
  persona: 'P1 friends (1.1, real Tailscale)',
  budgetMs: 90_000,
  skip: () => (process.env.TS_SERVE !== '1' ? 'opt-in: set TS_SERVE=1 (runs real `tailscale serve` on this Mac)' : !fs.existsSync(TS) ? `no ${TS}` : null),
  async run(t) {
    const st = ts('status', '--json');
    let self = null;
    try { self = JSON.parse(st.stdout).Self; } catch { /* not logged in */ }
    if (!t.check('tailscale is up on this Mac', self && self.DNSName, (st.stderr || '').trim().slice(0, 120))) return;
    const host = self.DNSName.replace(/\.$/, '');
    const port = await freePort();
    const p = `/sub-human-lab-${crypto.randomBytes(3).toString('hex')}`;
    const srv = spawn(process.execPath, [PROBE, 'serve', String(port), '60'], { stdio: 'ignore' });
    try {
      await t.sleep(500);
      const on = ts('serve', '--bg', '--https=443', `--set-path=${p}`, `http://127.0.0.1:${port}`);
      t.ev.write('serve-on.txt', on.stdout + on.stderr);
      t.check(`tailscale serve --bg ${p} -> 127.0.0.1:${port}`, on.status === 0, (on.stderr || on.stdout).trim().split('\n')[0]);
      const r = spawnSync(process.execPath, [PROBE, 'connect', `https://${host}${p}`], { encoding: 'utf8', timeout: 30_000 });
      let res = {};
      try { res = JSON.parse(r.stdout.trim()); } catch { res = { error: r.stderr }; }
      t.check(`wss upgrade through https://${host}${p} (Tailscale's certificate, no extra CA)`, res.upgraded && res.echo, JSON.stringify(res));
    } finally {
      const off = ts('serve', '--https=443', `--set-path=${p}`, 'off');
      t.ev.write('serve-off.txt', off.stdout + off.stderr);
      const status = ts('serve', 'status').stdout;
      t.check(`${p} turned off again; other serves untouched`, off.status === 0 && !status.includes(p), (off.stderr || '').trim().split('\n')[0]);
      srv.kill();
    }
  },
};
