'use strict';
// Version skew against the previous release (devbox-old: plugin 0.2.0 from git ref cb4d344, baked into its image).
// (a) a 0.2.0 host (devbox-old) and a 0.3.0 joiner (joiner-a, over toxiproxy:22003); (b) a 0.3.0 host (devbox) and a
// 0.2.0 joiner (the joiner user on devbox-old, straight over the core network). Each direction must either work
// fully (posts both ways, mirror byte-identical, both chains verify) or refuse with a message that names the
// version and which side to update; never a half-working room or a mirror that silently diverges. (c) A hello
// from a client claiming protocol v99 straight into the 0.3.0 forced command: PROTOCOL, and once the hello carries
// a version range (1.0), a message that says which side to update.
const { WAN, CORE, delivered, converge } = require('./_lib.js');

const VERSION_MSG = /version|update|upgrade|protocol/i;

async function direction(t, label, { hostSvc, joinerSvc, joinerUser, hosts, dest }) {
  const { lab } = t;
  const { code, host } = lab.hostRoom(hostSvc);
  const j = lab.joinOver({ svc: joinerSvc, user: joinerUser, name: 'bob', code, hosts, hostSvc, dest, key: `id_skew_${hostSvc}` });
  t.ev.secret(j.invite.split('.').pop());
  t.log(`${label}: join ok ${j.join.ok} (${j.join.ms} ms) ${j.join.out || ''}`);
  if (!j.join.ok) {
    t.check(`${label}: the refused join names the version / which side to update`, VERSION_MSG.test(j.join.out || ''), (j.join.out || '').slice(0, 200));
    const h = host.dump(code);
    t.check(`${label}: the host log still verifies after the refusal`, h.chain && h.chain.ok, JSON.stringify(h.chain));
    return;
  }
  const s = j.seat.say('bob', `${label} from bob`);
  const d = await delivered(host, 'alice', `${label} from bob`, 8000);
  const h = host.say('alice', `${label} from alice`);
  const d2 = await delivered(j.seat, 'bob', `${label} from alice`, 8000);
  t.check(`${label}: compatible: posts both ways`, s.ok && d.ok && h.ok && d2.ok, `bob->alice ${s.ok && d.ok}, alice->bob ${h.ok && d2.ok}${s.out ? `; ${s.out}` : ''}`);
  const c = await converge(t, host, code, [j.seat]);
  t.check(`${label}: no silent corruption: mirror byte-identical, both chains verify`, c.ok, c.detail);
}

module.exports = {
  id: 'skew',
  title: '0.2.0 host vs 0.3.0 joiner and the reverse: compatible, or a clear version message; never silent corruption',
  persona: 'P2 corporate (mixed versions)',
  budgetMs: 120_000,
  async run(t) {
    const { lab } = t;
    t.log(`devbox plugin ${lab.probe.version} (protocol v${lab.probe.protocolVersion}); devbox-old plugin ${lab.oldProbe.version} (protocol v${lab.oldProbe.protocolVersion}, cli ${lab.oldProbe.cliPath})`);
    t.check('devbox-old really is the previous release', lab.oldProbe.version !== lab.probe.version && /bin\/sub-human$/.test(lab.oldProbe.cliPath), `${lab.oldProbe.version} vs ${lab.probe.version}`);
    await direction(t, 'old host 0.2.0 <- new joiner', { hostSvc: 'devbox-old', joinerSvc: 'joiner-a', hosts: WAN, dest: 'host@devbox-old' });
    await lab.reset();
    await direction(t, 'new host <- old joiner 0.2.0', { hostSvc: 'devbox', joinerSvc: 'devbox-old', joinerUser: 'joiner', hosts: CORE, dest: 'host@devbox' });

    // (c) a client from the future
    await lab.reset();
    const { code } = lab.hostRoom();
    const pub = lab.keypair('joiner-a', 'id_future');
    const conf = lab.sshConfig('joiner-a', 'future', 'id_future', WAN);
    const inv = lab.invite(code);
    t.ev.secret(inv.split('.').pop());
    lab.authorize(inv, pub);
    const frame = JSON.stringify({ id: 1, op: 'hello', params: { v: 99, vmin: 99, vmax: 99, client: 'sub-human', version: '9.9.9', caps: {}, machine: 'future-machine' } });
    const r = lab.exec('joiner-a', ['sh', '-c', `printf '%s\\n' '${frame}' | timeout 20 ssh -F ${conf} -T host@devbox hello`], { user: 'joiner', allowFail: true, timeout: 30_000 });
    const reply = (r.stdout.split('\n').find(l => l.includes('"id":1')) || '').trim();
    t.ev.write('future-hello.txt', `> ${frame}\n< ${reply}\nstderr: ${r.stderr}`);
    let err = null;
    try { err = JSON.parse(reply).error; } catch { /* no reply */ }
    t.check('a v99 hello is refused PROTOCOL by the 0.3.0 server', err && err.code === 'PROTOCOL', reply.slice(0, 200) || r.stderr.slice(0, 200));
    t.expect('the refusal says which side to update', !!err && /update|upgrade|newer|older/i.test(err.message), err ? err.message : 'no reply', 'versionRange');
  },
};
