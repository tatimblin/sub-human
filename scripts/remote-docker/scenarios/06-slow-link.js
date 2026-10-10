'use strict';
// A slow link, not a dead one: 5 s of latency on bob's upstream, longer than a hook's call deadline (LINK_CALL_MS,
// 3 s). The frame goes out and reaches the host 5 s later. Before 1.0 the hook said "nothing was sent" and the host
// wrote the post anyway (a ghost: a person who typed it again posted it twice). Now the link daemon answers the hook
// by LINK_RELAY_MS (2 s): the post is in flight, kept in the outbox under its nonce, and the person reads "⧗ sending
// (slow link)", never "nothing was sent". The late copy is the post: it lands exactly once, the outbox empties, and a
// copy sent again (a reconnect) would be refused by its nonce.
const { WAN, converge, entries } = require('./_lib.js');

module.exports = {
  id: 'slow-link',
  title: 'a post on a slow link is "sending", lands exactly once, and is never reported as not sent (no ghost post)',
  persona: 'P1 friends (hotel wifi)',
  budgetMs: 90_000,
  async run(t) {
    const { lab, sleep } = t;
    const { code, host } = lab.hostRoom();
    const a = await lab.join({ svc: 'joiner-a', name: 'bob', code, hosts: WAN });
    t.ev.invite(a.invite, a.pin);
    if (!t.check('bob joins', a.join.ok, a.join.out || '')) return;
    await lab.toxic('devbox-ssh', 'slow_up', 'latency', { latency: 5000, jitter: 0 }, 'upstream');
    const p = a.seat.say('bob', 'slow-link post');
    t.log(`bob's post over a 5 s upstream: ${p.ms} ms, ok ${p.ok}: ${p.out || ''}`);
    t.ev.write('hook.json', p);
    t.check('the hook answers within the hook deadline (3 s), the prompt never hangs', p.ms < 3500, `${p.ms} ms`);
    t.check('the hook never says "nothing was sent" or "not posted" for a frame that went out', !/nothing was sent|not posted/i.test(p.out || ''), (p.out || 'posted').slice(0, 160));
    t.check('the person is told it is on its way: "⧗ sending (slow connection)" (or ✓ sent if the host answered in time)', p.ok && /sending \(slow connection\)|^✓ sent/.test(p.out || ''), (p.out || '').slice(0, 120));
    const q = a.seat.link(code);
    t.log(`bob's link right after: ${JSON.stringify(q)}`);
    await sleep(8000);
    await lab.untoxic('devbox-ssh', 'slow_up');
    await sleep(2000);
    const c = await converge(t, host, code, [a.seat]);
    t.check('consistent afterwards: byte-identical, chains verify', c.ok, c.detail);
    const n = entries(c.host.log).filter(e => e.text === 'slow-link post').length;
    t.ev.write('ghost.json', { hook: p, inHostLog: n });
    t.check('no ghost, no double: the post is in the host log exactly once', n === 1, `${n}× in the host log after the hook said: ${(p.out || 'posted').slice(0, 120)}`);
    const st = a.seat.link(code);
    t.check('the outbox is empty again (the late answer took the post out); nothing reported unsent', !st.queued && !(st.flush && st.flush.unsent && st.flush.unsent.length), JSON.stringify({ queued: st.queued, flush: st.flush }));
  },
};
