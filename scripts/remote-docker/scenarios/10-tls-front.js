'use strict';
// The 1.1 path, before the plugin's ws listener exists: tls-front (Caddy, internal CA) terminates TLS for
// https://tls-front/ and forwards WebSocket upgrades to the devbox, whose fwd.js (the tailscaled stand-in) hands them
// to 127.0.0.1:$LAB_WS_PORT. With nothing listening there the answer is 502; with lab/ws-probe.js listening as the
// host it upgrades (101) and echoes, from joiner-a directly and from joiner-b only through corp-proxy (CONNECT). So
// once the host listens on 127.0.0.1:7420 the wss scenario runs over a path already proved.
const WS_PORT = Number(process.env.LAB_WS_PORT || 7420);

module.exports = {
  id: 'tls-front',
  title: 'https://tls-front/ terminates TLS and forwards ws upgrades to the devbox loopback, also through corp-proxy',
  persona: 'P1 friends / P2 corporate (1.1 path)',
  budgetMs: 60_000,
  async run(t) {
    const { lab, sleep } = t;
    const env = { NODE_EXTRA_CA_CERTS: '/etc/lab-ca.crt' };
    const probe = (svc, proxy) => {
      const r = lab.exec(svc, ['node', '/lab/ws-probe.js', 'connect', 'https://tls-front/ABCD', ...(proxy ? [proxy] : [])], { user: 'joiner', env, allowFail: true, timeout: 20_000 });
      try { return JSON.parse(r.stdout.trim()); } catch { return { ok: false, error: r.stderr.trim() || r.stdout.trim() }; }
    };
    const idle = probe('joiner-a');
    t.check('with no listener: TLS verifies against the lab CA and the proxy answers 502', idle.ok && idle.status === 502 && idle.authorized, JSON.stringify(idle));
    const r = lab.dc(['exec', '-d', '-u', 'host', 'devbox', 'node', '/lab/ws-probe.js', 'serve', String(WS_PORT), '30'], { allowFail: true });
    t.log(`ws-probe listening as host on devbox 127.0.0.1:${WS_PORT}: exec exit ${r.status}`);
    await sleep(800);
    const ln = lab.exec('devbox', ['sh', '-c', `ss -ltn | grep ':${WS_PORT} ' || true`]).stdout.trim();
    t.check(`the stand-in listens on 127.0.0.1:${WS_PORT} only`, /127\.0\.0\.1:/.test(ln) && !/0\.0\.0\.0:7420|\*:7420/.test(ln), ln);
    const direct = probe('joiner-a');
    t.check('joiner-a: wss upgrade (101) through tls-front reaches the devbox loopback and echoes', direct.upgraded && direct.echo, JSON.stringify(direct));
    const noProxy = probe('joiner-b');
    t.check('joiner-b cannot reach tls-front directly', !noProxy.ok, noProxy.error || JSON.stringify(noProxy));
    const viaProxy = probe('joiner-b', 'http://corp-proxy:3128');
    t.check('joiner-b: the same upgrade works through corp-proxy (CONNECT tls-front:443)', viaProxy.upgraded && viaProxy.echo, JSON.stringify(viaProxy));
    const caddy = lab.composeLogs('tls-front');
    t.ev.write('tls-front.txt', caddy);
    t.metric('wsProbeMs', { direct: direct.ms, viaProxy: viaProxy.ms });
  },
};
