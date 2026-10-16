// P3 sleep. (1) The host sleeps: `docker pause devbox` for LAB_SLEEP_S (90) s. The joiners' links go offline; a post
// a joiner makes meanwhile is either refused OFFLINE (today) or queued in the outbox (1.0); after the unpause both
// links come back by themselves, the outbox flushes exactly once, every line is on every mirror once, nothing lost.
// (2) A joiner sleeps: `docker pause joiner-a` for LAB_JOINER_SLEEP_S (45) s while the room goes on; on waking it
// catches up (its tail delivers what it missed) and can post.
import { WAN, JUMP, delivered, waitState, converge, entries, linkState } from './_lib.ts';
import type { T } from '../lab.ts';

const SLEEP_S = Number(process.env.LAB_SLEEP_S || 90);
const JOINER_SLEEP_S = Number(process.env.LAB_JOINER_SLEEP_S || 45);
const RECONNECT_MS = 30_000;

export const id = 'p3-sleep';
export const title = `docker pause devbox ${SLEEP_S} s, then a joiner ${JOINER_SLEEP_S} s: reconnect, no duplicate or lost entries, outbox flushes`;
export const persona = 'P3 sleep';
export const budgetMs = (SLEEP_S + JOINER_SLEEP_S + 150) * 1000;
export async function run(t: T): Promise<void> {
  const { lab, sleep } = t;
  const { code, host } = lab.hostRoom();
  const a = await lab.join({ svc: 'joiner-a', name: 'bob', code, hosts: WAN });
  const b = await lab.join({ svc: 'joiner-b', name: 'bea', code, hosts: JUMP, via: 'bastion' });
  for (const j of [a, b]) t.ev.invite(j.invite, j.pin);
  if (!t.check('bob (WAN) and bea (bastion) join', a.join.ok && b.join.ok, `${a.join.out || 'ok'} / ${b.join.out || 'ok'}`)) return;
  host.say('alice', 'p3 before sleep');
  a.seat.say('bob', 'p3 bob before');
  const c0 = await converge(t, host, code, [a.seat, b.seat]);
  t.check('consistent before the sleep', c0.ok, c0.detail);

  // (1) the host sleeps
  t.log(`docker pause devbox for ${SLEEP_S} s`);
  const tPause = Date.now();
  lab.dc(['pause', 'devbox']);
  const offA = waitState(a.seat, code, ['offline', 'connecting'], SLEEP_S * 1000 - 5000);
  const offB = waitState(b.seat, code, ['offline', 'connecting'], SLEEP_S * 1000 - 5000);
  const [msA, msB] = await Promise.all([offA, offB]);
  t.log(`links offline after: bob ${msA} ms, bea ${msB} ms`);
  t.metric('offlineAfterPauseMs', { bob: msA, bea: msB });
  t.check('both links notice the sleeping host (offline) while it sleeps', msA !== null && msB !== null, `bob ${msA} ms, bea ${msB} ms`);
  const during = a.seat.say('bob', 'p3 bob while the host sleeps');
  t.log(`bob's post while the host sleeps: ok ${during.ok}; ${during.out || ''}`);
  t.ev.write('post-during-sleep.json', during);
  const queued = during.ok || /queued|outbox|sends when/i.test(during.out || '');
  t.check('a post while offline is refused clearly or queued, never silently dropped', queued || /offline/i.test(during.out || ''), (during.out || 'posted').slice(0, 160));
  const left = SLEEP_S * 1000 - (Date.now() - tPause);
  if (left > 0) await sleep(left);
  lab.dc(['unpause', 'devbox']);
  const tWake = Date.now();
  t.log(`unpaused devbox after ${Math.round((tWake - tPause) / 1000)} s`);
  const [backA, backB] = await Promise.all([waitState(a.seat, code, 'online', 60_000), waitState(b.seat, code, 'online', 60_000)]);
  t.metric('reconnectAfterWakeMs', { bob: backA, bea: backB });
  t.check(`both links back online by themselves within ${RECONNECT_MS / 1000} s of the wake`, backA !== null && backB !== null && backA < RECONNECT_MS && backB < RECONNECT_MS,
    `bob ${backA} ms (${linkState(a.seat, code)}), bea ${backB} ms (${linkState(b.seat, code)})`);

  const after = host.say('alice', 'p3 after wake');
  const d1 = await delivered(a.seat, 'bob', 'p3 after wake', 10_000);
  const d2 = await delivered(b.seat, 'bea', 'p3 after wake', 10_000);
  t.check("the host's first post after waking reaches both joiners' tails", after.ok && d1.ok && d2.ok, `bob ${d1.ok ? d1.t - after.t0 : '-'} ms, bea ${d2.ok ? d2.t - after.t0 : '-'} ms`);
  const bobAfter = a.seat.say('bob', 'p3 bob after wake');
  t.expect('bob can post right after the wake (lease kept or seat rejoined automatically)', bobAfter.ok, (bobAfter.out || 'posted').slice(0, 160), 'autoRejoin');

  await sleep(3000); // an outbox flushes after the subscribe catch-up
  const c1 = await converge(t, host, code, [a.seat, b.seat]);
  t.check('after the host sleep: mirrors byte-identical, chains verify, no gap, no line twice', c1.ok, c1.detail);
  const sleepPosts = entries(c1.host.log).filter(e => e.text === 'p3 bob while the host sleeps');
  if (during.ok) t.check('the post made during the sleep is in the log exactly once', sleepPosts.length === 1, `${sleepPosts.length}×`);
  else t.expect('the outbox: the post made during the sleep is flushed after the wake, exactly once', sleepPosts.length === 1, `${sleepPosts.length}× in the host log`, 'outbox');

  // (2) a joiner sleeps
  t.log(`docker pause joiner-a for ${JOINER_SLEEP_S} s`);
  lab.dc(['pause', 'joiner-a']);
  const missed = [];
  for (let i = 0; i < 3; i++) {
    host.say('alice', `p3 while bob sleeps ${i}`);
    missed.push(`p3 while bob sleeps ${i}`);
    b.seat.say('bea', `p3 bea while bob sleeps ${i}`);
    missed.push(`p3 bea while bob sleeps ${i}`);
    await sleep(1000);
  }
  await sleep(Math.max(0, JOINER_SLEEP_S * 1000 - 3000));
  lab.dc(['unpause', 'joiner-a']);
  const tJ = Date.now();
  const back = await waitState(a.seat, code, 'online', 60_000);
  const got = await Promise.all(missed.map(m => delivered(a.seat, 'bob', m, 30_000)));
  const catchUp = Math.max(...got.map(g => (g.ok ? g.t - tJ : Infinity)));
  t.metric('joinerCatchUpMs', catchUp);
  t.check("bob's laptop wakes: online again and his tail delivers all 6 posts he slept through", back !== null && got.every(g => g.ok), `online after ${back} ms, catch-up ${Number.isFinite(catchUp) ? catchUp : '-'} ms, ${got.filter(g => g.ok).length}/6`);
  const bobWoke = a.seat.say('bob', 'p3 bob after his own sleep');
  t.expect('bob can post after his own sleep', bobWoke.ok, (bobWoke.out || 'posted').slice(0, 160), 'autoRejoin');
  const c2 = await converge(t, host, code, [a.seat, b.seat]);
  t.check('after the joiner sleep: mirrors byte-identical, chains verify, no gap, no line twice', c2.ok, c2.detail);
}
