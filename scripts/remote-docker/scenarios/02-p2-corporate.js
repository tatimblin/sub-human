'use strict';
// P2 corporate: joiner-b sits on an internal network whose only ways out are the bastion's sshd and corp-proxy's
// HTTP CONNECT. First the isolation itself is proved (no route, no DNS for the devbox or toxiproxy, no direct TLS).
// Variant 1: ssh to the devbox with ProxyJump through the bastion (the joiner's own ssh config, -F). Variant 2, a
// second home on joiner-b: ssh with ProxyCommand `nc -X connect` through corp-proxy to the WAN path. Both seats
// post and receive; the bastion's and the proxy's logs show the hop. bea's invite comes from `/sub-human invite --ssh
// host@devbox --via jump@bastion`: the jump is in the invite's line, so her link runs ssh -J itself.
const { JUMP, PROXY, delivered, converge } = require('./_lib.js');

module.exports = {
  id: 'p2-corporate',
  title: 'joiner-b reaches devbox only via the bastion (ProxyJump), and only via the CONNECT proxy',
  persona: 'P2 corporate',
  budgetMs: 150_000,
  async run(t) {
    const { lab } = t;
    const iso = lab.exec('joiner-b', ['sh', '-c', [
      'ip route | grep -c default || true',
      'getent hosts devbox toxiproxy tls-front >/dev/null && echo dns-leak || echo dns-none',
      'nc -z -w 3 toxiproxy 22001 2>/dev/null && echo tox-open || echo tox-closed',
      'nc -z -w 3 bastion 22 && echo bastion-open || echo bastion-closed',
      'nc -z -w 3 corp-proxy 3128 && echo proxy-open || echo proxy-closed',
    ].join('; ')], { allowFail: true }).stdout;
    t.ev.write('isolation.txt', iso);
    const isoOk = /^0$/m.test(iso) && /dns-none/.test(iso) && /tox-closed/.test(iso) && /bastion-open/.test(iso) && /proxy-open/.test(iso);
    t.check('joiner-b is isolated: no default route, no DNS for devbox/toxiproxy/tls-front; only bastion:22 and corp-proxy:3128', isoOk, iso.trim().split('\n').join(', '));

    const { code, host } = lab.hostRoom();
    t.log(`room ${code} on devbox`);

    // variant 1: ProxyJump through the bastion
    const v1 = await lab.join({ svc: 'joiner-b', name: 'bea', code, hosts: JUMP, via: 'bastion', viaFlag: 'jump@bastion' });
    t.ev.invite(v1.invite, v1.pin);
    t.check('bea joins through the bastion (ProxyJump)', v1.join.ok, v1.join.out || `${v1.join.ms} ms`);
    if (v1.join.ok) {
      const s = v1.seat.say('bea', 'p2 via bastion');
      const d = await delivered(host, 'alice', 'p2 via bastion', 8000);
      const h = host.say('alice', 'p2 to bea');
      const d2 = await delivered(v1.seat, 'bea', 'p2 to bea', 8000);
      t.check('bea <-> alice posts both ways through the bastion', s.ok && d.ok && h.ok && d2.ok, `up ${d.ok ? d.t - s.t0 : '-'} ms, down ${d2.ok ? d2.t - h.t0 : '-'} ms`);
    }
    const bast = lab.composeLogs('bastion');
    const jumped = /Accepted publickey for jump/.test(bast);
    t.ev.write('bastion-sshd.txt', bast);
    const devLog = lab.composeLogs('devbox');
    const bastionIps = lab.exec('bastion', ['hostname', '-i']).stdout.trim().split(/\s+/);
    const fromBastion = bastionIps.some(ip => new RegExp(`Accepted publickey for host from ${ip.replace(/\./g, '\\.')}`).test(devLog));
    t.check("the bastion accepted jump's key and devbox's sshd saw bea come from the bastion's address", jumped && fromBastion, `bastion ${jumped}, devbox from ${bastionIps.join('/')}: ${fromBastion}`);

    // variant 2: only the CONNECT proxy, from a second home on joiner-b
    const v2 = await lab.join({ svc: 'joiner-b', name: 'ben', code, hosts: PROXY, home: '.sub-human-proxy' });
    t.ev.invite(v2.invite, v2.pin);
    t.check('ben joins through corp-proxy (ssh ProxyCommand nc -X connect)', v2.join.ok, v2.join.out || `${v2.join.ms} ms`);
    if (v2.join.ok) {
      const s = v2.seat.say('ben', 'p2 via proxy');
      const d = await delivered(host, 'alice', 'p2 via proxy', 8000);
      const h = host.say('alice', 'p2 to ben');
      const d2 = await delivered(v2.seat, 'ben', 'p2 to ben', 8000);
      t.check('ben <-> alice posts both ways through the CONNECT proxy', s.ok && d.ok && h.ok && d2.ok, `up ${d.ok ? d.t - s.t0 : '-'} ms, down ${d2.ok ? d2.t - h.t0 : '-'} ms`);
    }
    const prox = lab.composeLogs('corp-proxy');
    t.ev.write('corp-proxy.txt', prox);
    const connect = (prox.match(/[^\n]*CONNECT[^\n]*toxiproxy:22001[^\n]*/i) || [''])[0];
    t.check('corp-proxy logged the CONNECT to toxiproxy:22001', !!connect, connect.replace(/^\S+\s+\|\s*/, '').slice(0, 140));

    const c = await converge(t, host, code, [v1.seat, v2.seat].filter((s, i) => [v1, v2][i].join.ok));
    t.check('both mirrors byte-identical to the host log, chains verify', c.ok, c.detail);

    if (t.features.hostSsh) {
      const lf = JSON.parse(lab.exec('joiner-b', ['cat', `${v1.seat.home}/links/${code}.json`], { user: 'joiner' }).stdout);
      t.ev.write('bea-link-transport.json', lf.transport);
      t.check('invite --ssh --via: bea\'s line carried the jump, her link dials ssh -J jump@bastion with its own key and the pinned host key',
        v1.join.ok && lf.transport.via === 'jump@bastion' && !!lf.transport.key && !!lf.transport.alias, JSON.stringify({ via: lf.transport.via, key: !!lf.transport.key, alias: lf.transport.alias }));
    } else t.pending('/sub-human invite --ssh --via jump@bastion', 'needs hostSsh');
  },
};
