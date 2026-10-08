'use strict';
// Planned handoff (1.0, PROD-PLAN item 7): the host on devbox moves the room to bob on joiner-a before closing the
// laptop; bea (joiner-b, through the bastion: her ssh config already routes joiner-a via ProxyJump) follows. After
// it: joiner-a holds the room (isHost), devbox is a mirror of it, bea's link points at joiner-a and is online, posts
// flow between all three and every copy is byte-identical with a verifying chain (the old host's lines kept).
// Interface assumed from docs/next/PROD-PLAN.md and plan 09: `sub-human handoff --to NAME --yes` on the host
// (LAB_HANDOFF_CMD overrides it, e.g. "handoff --to {name} --yes"; {name} and {code} are filled in).
const { WAN, JUMP, delivered, waitState, converge } = require('./_lib.js');

module.exports = {
  id: 'handoff',
  title: 'devbox hands the room to joiner-a (bob); joiner-b (bea) follows; nothing lost',
  persona: 'P3 sleep (host leaves)',
  requires: ['handoff'],
  budgetMs: 150_000,
  async run(t) {
    const { lab } = t;
    const { code, host } = lab.hostRoom();
    const a = lab.joinOver({ svc: 'joiner-a', name: 'bob', code, hosts: WAN });
    const b = lab.joinOver({ svc: 'joiner-b', name: 'bea', code, hosts: JUMP, via: 'bastion' });
    if (!t.check('bob and bea join', a.join.ok && b.join.ok)) return;
    host.say('alice', 'handoff before');
    const before = await converge(t, host, code, [a.seat, b.seat]);
    // the new host needs sshd reachable for bea: joiner-a runs one (role joiner); the bastion may open joiner-a:22
    const cmd = (process.env.LAB_HANDOFF_CMD || 'handoff --to {name} --yes').replace('{name}', 'bob').replace('{code}', code).split(' ');
    const r = host.cli([...cmd, '--room', code]);
    t.ev.write('handoff.txt', `$ sub-human ${cmd.join(' ')} --room ${code}\nexit ${r.status}\n${r.stdout}\n${r.stderr}`);
    if (!t.check('the host runs the handoff', r.status === 0, (r.stdout + r.stderr).trim().split('\n').slice(-1)[0])) return;
    const isHost = await t.until(() => a.seat.dump(code).isHost, 30_000, 500);
    t.check('joiner-a now holds the room', isHost);
    const devMirror = await t.until(() => !host.dump(code).isHost, 30_000, 500);
    t.check('devbox is now a mirror of it', devMirror);
    const beaBack = await waitState(b.seat, code, 'online', 45_000);
    t.check("bea's link follows to joiner-a and is online", beaBack !== null, `${beaBack} ms`);
    const s = b.seat.say('bea', 'handoff bea to new host');
    const d = await delivered(a.seat, 'bob', 'handoff bea to new host', 10_000);
    const s2 = a.seat.say('bob', 'handoff bob as host');
    const d2 = await delivered(host, 'alice', 'handoff bob as host', 10_000);
    t.check('posts flow through the new host to everyone (old host included)', s.ok && d.ok && s2.ok && d2.ok);
    const after = await converge(t, a.seat, code, [host, b.seat]);
    t.check('every copy byte-identical to the new host, chains verify, the old lines kept', after.ok && after.host.log.startsWith(before.host.log), after.detail);
  },
};
