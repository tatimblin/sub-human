'use strict';
// Network flap: 10 cuts in 60 s on bob's WAN path, alternating a disabled proxy (every connection closed) and a
// reset_peer toxic (TCP RST), 3 s down and 3 s up, while alice and bob keep posting. bea (via the bastion) is the
// control and never loses her link. At the end: bob online, every mirror byte-identical to the host, each accepted
// post exactly once, each refused post absent (a refused post that lands anyway is a ghost: the person was told
// "nothing was sent").
const { WAN, JUMP, waitState, converge, entries } = require('./_lib.js');

const CUTS = Number(process.env.LAB_FLAP_CUTS || 10);
const PERIOD_MS = Number(process.env.LAB_FLAP_PERIOD_MS || 6000);

module.exports = {
  id: 'flap',
  title: `${CUTS} cuts in ${(CUTS * PERIOD_MS) / 1000} s while both sides post -> ends consistent`,
  persona: 'P1 friends / P3 sleep',
  budgetMs: CUTS * PERIOD_MS + 90_000,
  async run(t) {
    const { lab, sleep } = t;
    const { code, host } = lab.hostRoom();
    const a = lab.joinOver({ svc: 'joiner-a', name: 'bob', code, hosts: WAN });
    const b = lab.joinOver({ svc: 'joiner-b', name: 'bea', code, hosts: JUMP, via: 'bastion' });
    for (const j of [a, b]) t.ev.secret(j.invite.split('.').pop());
    if (!t.check('bob and bea join', a.join.ok && b.join.ok)) return;
    const posts = { host: [], bobOk: [], bobRefused: [], bea: [] };
    const say = (seat, name, text, bucket, refused) => {
      const r = seat.say(name, text);
      (r.ok ? posts[bucket] : posts[refused || bucket]).push(text);
      return r;
    };
    const t0 = Date.now();
    const timeline = [];
    for (let i = 0; i < CUTS; i++) {
      const kind = i % 2 ? 'reset_peer' : 'disable';
      if (kind === 'disable') await lab.toxi('POST', '/proxies/devbox-ssh', { enabled: false });
      else {
        await lab.toxic('devbox-ssh', 'rst_down', 'reset_peer', { timeout: 0 }, 'downstream');
        await lab.toxic('devbox-ssh', 'rst_up', 'reset_peer', { timeout: 0 }, 'upstream');
      }
      timeline.push({ at: Date.now() - t0, cut: i + 1, kind });
      say(host, 'alice', `flap host ${i} down`, 'host');
      say(a.seat, 'bob', `flap bob ${i} down`, 'bobOk', 'bobRefused');
      say(b.seat, 'bea', `flap bea ${i} down`, 'bea');
      await sleep(Math.max(0, PERIOD_MS / 2 - (Date.now() - t0 - timeline.at(-1).at)));
      if (kind === 'disable') await lab.toxi('POST', '/proxies/devbox-ssh', { enabled: true });
      else { await lab.untoxic('devbox-ssh', 'rst_down'); await lab.untoxic('devbox-ssh', 'rst_up'); }
      timeline.push({ at: Date.now() - t0, heal: i + 1 });
      say(host, 'alice', `flap host ${i} up`, 'host');
      say(a.seat, 'bob', `flap bob ${i} up`, 'bobOk', 'bobRefused');
      await sleep(Math.max(0, PERIOD_MS - (Date.now() - t0 - timeline.at(-2).at)));
    }
    t.ev.write('timeline.json', timeline);
    t.log(`${CUTS} cuts in ${Math.round((Date.now() - t0) / 1000)} s; bob: ${posts.bobOk.length} posts accepted, ${posts.bobRefused.length} refused`);
    t.metric('posts', { host: posts.host.length, bobOk: posts.bobOk.length, bobRefused: posts.bobRefused.length, bea: posts.bea.length });
    const back = await waitState(a.seat, code, 'online', 30_000);
    t.check('bob is online again after the last heal', back !== null, `${back} ms`);
    const late = a.seat.say('bob', 'flap bob after');
    if (late.ok) posts.bobOk.push('flap bob after');
    const c = await converge(t, host, code, [a.seat, b.seat], 30_000);
    t.check('ends consistent: mirrors byte-identical, chains verify, no gap, no line twice', c.ok, c.detail);
    const texts = entries(c.host.log).map(e => e.text);
    const count = s => texts.filter(x => x === s).length;
    const missing = [...posts.host, ...posts.bobOk, ...posts.bea].filter(s => count(s) !== 1);
    t.check('every accepted post (alice, bob, bea) is in the log exactly once', !missing.length, missing.length ? `not once: ${missing.slice(0, 4).join(', ')}` : `${posts.host.length + posts.bobOk.length + posts.bea.length} posts`);
    const ghosts = posts.bobRefused.filter(s => count(s) > 0);
    t.bug('no ghost: a post bob was told was not sent is not in the log', !ghosts.length, ghosts.length ? `landed anyway: ${ghosts.join(', ')}` : `${posts.bobRefused.length} refused, none landed`);
    t.check("bea's link (the control, via the bastion) stayed up and every one of her posts went through", posts.bea.length === CUTS, `${posts.bea.length}/${CUTS}`);
    const linkLog = lab.exec('joiner-a', ['cat', `${a.seat.home}/links/${code}.log`], { allowFail: true }).stdout;
    t.ev.write('bob-link.log', linkLog);
    const onlines = (linkLog.match(/online: subscribed/g) || []).length;
    t.metric('reconnects', onlines - 1);
    t.log(`bob's link went online ${onlines} times (${onlines - 1} reconnects)`);
  },
};
