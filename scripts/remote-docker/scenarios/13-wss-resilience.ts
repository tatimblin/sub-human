// 1.1 wss under the P3 conditions: bob (joiner-a, direct) and ben (joiner-b, through corp-proxy) join over
// https://tls-front (Caddy, the stand-in for Tailscale Serve/Funnel) to the devbox listener. Then:
//   (1) the host sleeps: `docker pause devbox` for LAB_WSS_SLEEP_S (45) s. Both links go offline (the app ping),
//       a post meanwhile is queued in the outbox, and after the wake both come back within 30 s and the queued post
//       lands exactly once;
//   (2) half-open: iptables DROP between joiner-a and tls-front, and between joiner-b and corp-proxy. Both links are
//       declared dead within LAB_PING_DEADLINE_MS (35 s), then come back once healed;
//   (3) the listener restarts (kill, start again): both links redial by themselves.
// Every phase ends byte-identical with chains verified.
import { delivered, waitState, converge, entries, linkState, wssHost, wssJoin } from './_lib.ts';
import type { T, SeatDriver } from '../lab.ts';

const SLEEP_S = Number(process.env.LAB_WSS_SLEEP_S || 45);
const PING_DEADLINE_MS = Number(process.env.LAB_PING_DEADLINE_MS || 35_000);
const RECONNECT_MS = 30_000;

export const id = 'wss-resilience';
export const title = `1.1 wss: host sleeps ${SLEEP_S} s, half-open paths, the listener restarts: reconnect, outbox once, converge`;
export const persona = 'P3 sleep / P2 corporate (1.1)';
export const requires = ['ws', 'urlPin', 'heartbeat', 'outbox'];
export const budgetMs = (SLEEP_S + 200) * 1000;
export async function run(t: T): Promise<void> {
  const { lab, sleep } = t;
  const { code, host } = lab.hostRoom();
  await wssHost(t, lab);
  const a = await wssJoin(t, lab, host, code, 'joiner-a', 'bob');
  const b = await wssJoin(t, lab, host, code, 'joiner-b', 'ben', { proxy: true });
  const sa = a.seat, sb = b.seat; // set whenever the join went through
  if (!t.check('bob (direct) and ben (corp-proxy) join over wss', a.ok && b.ok, `${a.out || 'ok'} / ${b.out || 'ok'}`) || !sa || !sb) return;
  const seats = [sa, sb];
  host.say('alice', 'wss-r before');
  t.check('consistent before', (await converge(t, host, code, seats)).ok);

  // (1) the host sleeps
  lab.dc(['pause', 'devbox']);
  const tPause = Date.now();
  const [oa, ob] = await Promise.all(seats.map(s => waitState(s, code, ['offline', 'connecting'], SLEEP_S * 1000 - 3000)));
  t.check('both wss links notice the sleeping host', oa !== null && ob !== null, `bob ${oa} ms, ben ${ob} ms`);
  t.metric('wssOfflineAfterPauseMs', { bob: oa, ben: ob });
  const during = sa.say('bob', 'wss-r bob while the host sleeps');
  t.check('a post while the host sleeps is queued (outbox), not lost', during.ok || /queued/i.test(during.out || ''), (during.out || 'queued').slice(0, 160));
  const left = SLEEP_S * 1000 - (Date.now() - tPause);
  if (left > 0) await sleep(left);
  lab.dc(['unpause', 'devbox']);
  const [ba, bb] = await Promise.all([waitState(sa, code, 'online', 60_000), waitState(sb, code, 'online', 60_000)]);
  t.metric('wssReconnectAfterWakeMs', { bob: ba, ben: bb });
  t.check(`both wss links back within ${RECONNECT_MS / 1000} s of the wake`, ba !== null && bb !== null && ba < RECONNECT_MS && bb < RECONNECT_MS, `bob ${ba} ms (${linkState(sa, code)}), ben ${bb} ms (${linkState(sb, code)})`);
  const w = host.say('alice', 'wss-r after wake');
  const d = await Promise.all([delivered(sa, 'bob', 'wss-r after wake', 10_000), delivered(sb, 'ben', 'wss-r after wake', 10_000)]);
  t.check('the host\'s first post after the wake reaches both', w.ok && d.every(x => x.ok));
  await sleep(3000);
  const c1 = await converge(t, host, code, seats);
  t.check('after the host sleep: byte-identical, chains verify', c1.ok, c1.detail);
  t.check('the post queued during the sleep is in the log exactly once', entries(c1.host.log).filter(e => e.text === 'wss-r bob while the host sleeps').length === 1);

  // (2) half-open: packets vanish, nothing closes
  const ip = (svc: string, name: string): string => lab.exec(svc, ['getent', 'hosts', name]).stdout.trim().split(/\s+/)[0] ?? '';
  const front = ip('joiner-a', 'tls-front'), proxy = ip('joiner-b', 'corp-proxy');
  lab.exec('joiner-a', ['sh', '-c', `iptables -A OUTPUT -d ${front} -j DROP && iptables -A INPUT -s ${front} -j DROP`]);
  lab.exec('joiner-b', ['sh', '-c', `iptables -A OUTPUT -d ${proxy} -j DROP && iptables -A INPUT -s ${proxy} -j DROP`]);
  const dead = (s: SeatDriver): Promise<number | null> => waitState(s, code, ['offline', 'connecting'], PING_DEADLINE_MS + 15_000);
  const [da, db] = await Promise.all([dead(sa), dead(sb)]);
  t.metric('wssDeadAfterMs', { bob: da, ben: db });
  t.check(`both half-open wss links declared dead within ${PING_DEADLINE_MS} ms (the app ping)`, da !== null && db !== null && da <= PING_DEADLINE_MS && db <= PING_DEADLINE_MS, `bob ${da} ms, ben ${db} ms`);
  for (const svc of ['joiner-a', 'joiner-b']) lab.exec(svc, ['iptables', '-F']);
  const [ha, hb] = await Promise.all(seats.map(s => waitState(s, code, 'online', 45_000)));
  t.check('both back online after the heal', ha !== null && hb !== null, `bob ${ha} ms, ben ${hb} ms`);

  // (3) the listener restarts
  lab.exec('devbox', ['sh', '-c', "pkill -f '[s]ub-human listen'; true"]);
  await Promise.all(seats.map(s => waitState(s, code, ['offline', 'connecting'], 10_000)));
  await wssHost(t, lab);
  const [ra, rb] = await Promise.all(seats.map(s => waitState(s, code, 'online', 30_000)));
  t.check('both links redial after the listener restarts', ra !== null && rb !== null, `bob ${ra} ms, ben ${rb} ms`);
  host.say('alice', 'wss-r after listener restart');
  sa.say('bob', 'wss-r bob at the end');
  const c2 = await converge(t, host, code, seats);
  t.check('at the end: byte-identical, chains verify, no gap, nothing twice', c2.ok, c2.detail);
}
