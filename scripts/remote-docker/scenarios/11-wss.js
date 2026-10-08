'use strict';
// 1.1 wss: the host listens on 127.0.0.1:$LAB_WS_PORT (7420) in the devbox; tls-front plays Tailscale Serve/Funnel.
// bob (joiner-a) joins with `/sub-human join bob https://tls-front/CODE PIN`; ben (joiner-b) does the same with
// HTTPS_PROXY=http://corp-proxy:3128 as his only way out. Posts flow, mirrors converge, a wrong PIN is refused.
// Interface assumed from docs/next/PROD-PLAN.md 1.1 and plan 04; override without editing this file:
//   LAB_WS_LISTEN_CMD   the host's listener (default "listen --port {port}"), run detached as host on devbox
//   LAB_WS_INVITE       how the host mints URL + PIN: "expand" (default: `/sub-human host --url {url}` through the
//                       join hook) or "cli" (`sub-human invite --room {code} --url {url} --pin`)
// The URL and the 6-digit PIN are read from that output.
const { delivered, converge } = require('./_lib.js');

const WS_PORT = Number(process.env.LAB_WS_PORT || 7420);
const URL_RE = /https:\/\/tls-front\/[A-Za-z0-9/_-]+/;
const PIN_RE = /\bPIN\D{0,3}(\d{3}[- ]?\d{3})\b/i;

function mint(t, host, code) {
  const url = 'https://tls-front';
  const out = process.env.LAB_WS_INVITE === 'cli'
    ? (r => r.stdout + r.stderr)(host.cli(['invite', '--room', code, '--url', url, '--pin']))
    : JSON.stringify(host.expand('alice', `host --url ${url}`).json || {});
  const u = (URL_RE.exec(out) || [])[0], pin = ((PIN_RE.exec(out) || [])[1] || '').replace(/\D/g, '');
  t.ev.secret(pin);
  return { url: u, pin, out };
}

module.exports = {
  id: 'wss',
  title: '1.1: join by https://tls-front/... URL + PIN, also through corp-proxy',
  persona: 'P1 friends / P2 corporate (1.1)',
  requires: ['ws', 'urlPin'],
  budgetMs: 120_000,
  async run(t) {
    const { lab, sleep } = t;
    const { code, host } = lab.hostRoom();
    const listen = (process.env.LAB_WS_LISTEN_CMD || 'listen --port {port}').replace('{port}', String(WS_PORT)).split(' ');
    lab.dc(['exec', '-d', '-u', 'host', '-e', 'SUB_HUMAN_HOME=/home/host/.sub-human', 'devbox', 'node', '/plugin/scripts/sub-human', ...listen], { allowFail: true });
    await sleep(1500);
    const ln = lab.exec('devbox', ['sh', '-c', `ss -ltn | grep ':${WS_PORT} ' || true`]).stdout.trim();
    t.check(`the host listens on 127.0.0.1:${WS_PORT} only`, /127\.0\.0\.1:/.test(ln), ln || 'nothing listening');

    const env = { NODE_EXTRA_CA_CERTS: '/etc/lab-ca.crt' };
    const joins = [];
    for (const [svc, name, extra] of [['joiner-a', 'bob', {}], ['joiner-b', 'ben', { HTTPS_PROXY: 'http://corp-proxy:3128', https_proxy: 'http://corp-proxy:3128' }]]) {
      const inv = mint(t, host, code);
      if (!t.check(`the host mints a URL + PIN for ${name}`, inv.url && inv.pin.length === 6, inv.out.slice(0, 160))) continue;
      const seat = lab.seat(svc, { env: { ...env, ...extra } });
      const bad = seat.join(name, `${inv.url} ${String((Number(inv.pin) + 1) % 1e6).padStart(6, '0')}`);
      t.check(`${name}: a wrong PIN is refused`, !bad.ok, (bad.out || '').slice(0, 120));
      const j = seat.join(name, `${inv.url} ${inv.pin}`);
      t.check(`${name} joins over wss${extra.HTTPS_PROXY ? ' through corp-proxy' : ''}`, j.ok, j.out || `${j.ms} ms`);
      if (j.ok) joins.push({ seat, name });
    }
    for (const { seat, name } of joins) {
      const s = seat.say(name, `wss from ${name}`);
      const d = await delivered(host, 'alice', `wss from ${name}`, 8000);
      const h = host.say('alice', `wss to ${name}`);
      const d2 = await delivered(seat, name, `wss to ${name}`, 8000);
      t.check(`${name} <-> alice posts both ways over wss`, s.ok && d.ok && h.ok && d2.ok);
    }
    if (joins.length) {
      const c = await converge(t, host, code, joins.map(j => j.seat));
      t.check('mirrors byte-identical, chains verify', c.ok, c.detail);
    }
    const prox = lab.composeLogs('corp-proxy');
    if (joins.some(j => j.name === 'ben')) t.check('corp-proxy carried ben\'s CONNECT to tls-front:443', /tls-front:443/.test(prox));
  },
};
