'use strict';
// A slow link, not a dead one: 5 s of latency on bob's upstream, longer than a hook's call deadline (LINK_CALL_MS,
// 3 s). bob's post times out and the hook tells him "nothing was sent". The frame was sent, though, and arrives
// at the host 5 s later: if the host writes it, the room has a post its author was told did not happen (a ghost),
// and a person who types it again posts it twice. Expected: the post either succeeds or truly never lands. Known
// plugin bug today (status BUG). The fix could be the 1.0 outbox: the timed-out post stays queued under its nonce,
// so the late arrival is the post and a resend is refused as a replay.
const { WAN, converge, entries } = require('./_lib.js');

module.exports = {
  id: 'slow-link',
  title: 'a post that times out on a slow link must not land later (no ghost post)',
  persona: 'P1 friends (hotel wifi)',
  budgetMs: 90_000,
  async run(t) {
    const { lab, sleep } = t;
    const { code, host } = lab.hostRoom();
    const a = lab.joinOver({ svc: 'joiner-a', name: 'bob', code, hosts: WAN });
    t.ev.secret(a.invite.split('.').pop());
    if (!t.check('bob joins', a.join.ok)) return;
    await lab.toxic('devbox-ssh', 'slow_up', 'latency', { latency: 5000, jitter: 0 }, 'upstream');
    const p = a.seat.say('bob', 'slow-link post');
    t.log(`bob's post over a 5 s upstream: ${p.ms} ms, ok ${p.ok}: ${p.out || ''}`);
    t.check('the hook answers within 10 s', p.ms < 10_000, `${p.ms} ms`);
    await sleep(8000);
    await lab.untoxic('devbox-ssh', 'slow_up');
    await sleep(2000);
    const c = await converge(t, host, code, [a.seat]);
    t.check('consistent afterwards: byte-identical, chains verify', c.ok, c.detail);
    const n = entries(c.host.log).filter(e => e.text === 'slow-link post').length;
    if (p.ok) t.check('the post that succeeded is in the log once', n === 1, `${n}×`);
    else {
      t.ev.write('ghost.json', { hook: p, inHostLog: n });
      const told = /nothing was sent/i.test(p.out || '');
      t.bug(`no ghost: a post refused${told ? ' as "nothing was sent"' : ''} does not land on the host later`, n === 0,
        `${n}× in the host log after the hook said: ${(p.out || '').slice(0, 120)}`);
    }
  },
};
