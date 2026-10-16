// Half-open links: packets silently vanish, nothing closes. Two at once: bob's WAN path gets a toxiproxy `timeout`
// toxic with timeout 0 on both directions (data held for ever, the TCP connection stays up); bea's container drops
// every packet to and from the bastion with iptables (NET_ADMIN). Each link must be declared dead within the
// heartbeat deadline (LAB_HEARTBEAT_DEADLINE_MS, 50 s: ssh's ServerAliveInterval 15 x CountMax 2 is today's heartbeat;
// the 1.0 app-level ping (15 s, 2 misses) is held to LAB_PING_DEADLINE_MS, 35 s). A post meanwhile fails fast instead of
// hanging the prompt. Healed, both come back and converge.
import { WAN, JUMP, waitState, converge, linkState, entries } from './_lib.ts';
import type { T } from '../lab.ts';

const DEADLINE_MS = Number(process.env.LAB_HEARTBEAT_DEADLINE_MS || 50_000);
const PING_DEADLINE_MS = Number(process.env.LAB_PING_DEADLINE_MS || 35_000);

export const id = 'half-open';
export const title = 'packets silently dropped (toxiproxy timeout toxic; iptables DROP) -> link declared dead within the heartbeat deadline';
export const persona = 'P3 sleep / P2 corporate';
export const budgetMs = 150_000;
export async function run(t: T): Promise<void> {
  const { lab } = t;
  const { code, host } = lab.hostRoom();
  const a = await lab.join({ svc: 'joiner-a', name: 'bob', code, hosts: WAN });
  const b = await lab.join({ svc: 'joiner-b', name: 'bea', code, hosts: JUMP, via: 'bastion' });
  for (const j of [a, b]) t.ev.invite(j.invite, j.pin);
  if (!t.check('bob and bea join', a.join.ok && b.join.ok)) return;
  host.say('alice', 'half-open before');
  await converge(t, host, code, [a.seat, b.seat]);

  const bastionIp = lab.exec('joiner-b', ['getent', 'hosts', 'bastion']).stdout.trim().split(/\s+/)[0];
  const t0 = Date.now();
  await lab.toxic('devbox-ssh', 'blackhole_down', 'timeout', { timeout: 0 }, 'downstream');
  await lab.toxic('devbox-ssh', 'blackhole_up', 'timeout', { timeout: 0 }, 'upstream');
  lab.exec('joiner-b', ['sh', '-c', `iptables -A OUTPUT -d ${bastionIp} -j DROP && iptables -A INPUT -s ${bastionIp} -j DROP`]);
  t.log(`black-holed: toxiproxy timeout(0) both ways on devbox-ssh (bob); iptables DROP to/from bastion ${bastionIp} in joiner-b (bea)`);
  t.ev.write('iptables-joiner-b.txt', lab.exec('joiner-b', ['iptables', '-L', '-n', '-v']).stdout);

  // a post while the link is black-holed but not yet declared dead: it must fail within the hook's deadline
  await t.sleep(2000);
  const p = a.seat.say('bob', 'half-open during');
  t.log(`bob's post into the black hole: ${p.ms} ms, ok ${p.ok}: ${p.out || ''}`);
  t.check('a post into a black-holed link returns within 10 s (the prompt never hangs)', p.ms < 10_000, `${p.ms} ms: ${(p.out || 'posted').slice(0, 120)}`);

  const tWait = Date.now() - t0;
  const [da, db] = await Promise.all([
    waitState(a.seat, code, ['offline', 'connecting'], DEADLINE_MS + 15_000),
    waitState(b.seat, code, ['offline', 'connecting'], DEADLINE_MS + 15_000),
  ]);
  const ta = da === null ? null : tWait + da, tb = db === null ? null : tWait + db; // ms since the black hole opened
  t.metric('deadAfterMs', { bob: ta, bea: tb });
  t.log(`declared dead: bob (toxic) after ~${ta} ms, bea (iptables) after ~${tb} ms`);
  t.check(`both half-open links declared dead within the heartbeat deadline (${DEADLINE_MS} ms)`, ta !== null && tb !== null && ta <= DEADLINE_MS && tb <= DEADLINE_MS,
    `bob ${ta} ms (${linkState(a.seat, code)}), bea ${tb} ms (${linkState(b.seat, code)})`);
  t.expect(`app-level ping: dead within ${PING_DEADLINE_MS} ms`, ta !== null && tb !== null && ta <= PING_DEADLINE_MS && tb <= PING_DEADLINE_MS, `bob ${ta} ms, bea ${tb} ms`, 'heartbeat');

  host.say('alice', 'half-open while cut');
  await lab.untoxic('devbox-ssh', 'blackhole_down');
  await lab.untoxic('devbox-ssh', 'blackhole_up');
  lab.exec('joiner-b', ['iptables', '-F']);
  t.log('healed');
  const [ba, bb] = await Promise.all([waitState(a.seat, code, 'online', 45_000), waitState(b.seat, code, 'online', 45_000)]);
  t.check('both links back online after the heal', ba !== null && bb !== null, `bob ${ba} ms, bea ${bb} ms`);
  await t.sleep(3000); // a post that was in flight is sent again on the new connection, after the catch-up
  const c = await converge(t, host, code, [a.seat, b.seat]);
  t.check('converged: byte-identical, chains verify, no gap, nothing twice', c.ok, c.detail);
  const n = entries(c.host.log).filter(e => e.text === 'half-open during').length;
  if (p.ok) t.check('the post sent into the black hole ("sending": kept under its nonce) lands exactly once after the heal', n === 1, `${n}×; the hook said: ${(p.out || 'posted').slice(0, 100)}`);
  else t.check('the post refused in the black hole never lands later', n === 0, `${n}×; the hook said: ${(p.out || '').slice(0, 100)}`);
}
