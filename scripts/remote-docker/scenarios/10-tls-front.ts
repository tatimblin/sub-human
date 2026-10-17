// The 1.1 path, before the plugin's ws listener exists: tls-front (Caddy, internal CA) terminates TLS for
// https://tls-front/ and forwards WebSocket upgrades to the devbox, whose fwd.ts (the tailscaled stand-in) hands them
// to 127.0.0.1:$LAB_WS_PORT. With nothing listening there the answer is 502; with lab/ws-probe.ts listening as the
// host it upgrades (101) and echoes, from joiner-a and joiner-b alike. So
// once the host listens on 127.0.0.1:7420 the wss scenario runs over a path already proved.
import type { T } from '../lab.ts';
import { parseJson } from '../../lib/io.ts';

/** What lab/ws-probe.ts connect prints. */
interface WsProbe { ok: boolean, status?: number, upgraded?: boolean, echo?: boolean, authorized?: boolean, error?: string, ms?: number }

const WS_PORT = Number(process.env.LAB_WS_PORT || 7420);

export const id = 'tls-front';
export const title = 'https://tls-front/ terminates TLS and forwards ws upgrades to the devbox loopback';
export const persona = 'P1 friends (1.1 path)';
export const budgetMs = 60_000;
export async function run(t: T): Promise<void> {
  const { lab, sleep } = t;
  const env = { NODE_EXTRA_CA_CERTS: '/etc/lab-ca.crt' };
  const probe = (svc: string): WsProbe => {
    const r = lab.exec(svc, ['node', '/lab/ws-probe.ts', 'connect', 'https://tls-front/ABCD'], { user: 'joiner', env, allowFail: true, timeout: 20_000 });
    try { return parseJson<WsProbe>(r.stdout.trim()); } catch { return { ok: false, error: r.stderr.trim() || r.stdout.trim() }; }
  };
  const idle = probe('joiner-a');
  t.check('with no listener: TLS verifies against the lab CA and the proxy answers 502', idle.ok && idle.status === 502 && idle.authorized, JSON.stringify(idle));
  const r = lab.dc(['exec', '-d', '-u', 'host', 'devbox', 'node', '/lab/ws-probe.ts', 'serve', String(WS_PORT), '30'], { allowFail: true });
  t.log(`ws-probe listening as host on devbox 127.0.0.1:${WS_PORT}: exec exit ${r.status}`);
  await sleep(800);
  const ln = lab.exec('devbox', ['sh', '-c', `ss -ltn | grep ':${WS_PORT} ' || true`]).stdout.trim();
  t.check(`the stand-in listens on 127.0.0.1:${WS_PORT} only`, /127\.0\.0\.1:/.test(ln) && !/0\.0\.0\.0:7420|\*:7420/.test(ln), ln);
  const direct = probe('joiner-a');
  t.check('joiner-a: wss upgrade (101) through tls-front reaches the devbox loopback and echoes', direct.upgraded && direct.echo, JSON.stringify(direct));
  const other = probe('joiner-b');
  t.check('joiner-b: the same upgrade works', other.upgraded && other.echo, JSON.stringify(other));
  const caddy = lab.composeLogs('tls-front');
  t.ev.write('tls-front.txt', caddy);
  t.metric('wsProbeMs', { a: direct.ms, b: other.ms });
}
