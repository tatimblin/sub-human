'use strict';
// Version skew against the previous release (devbox-old: 0.5.0-beta.15, git ref 7c97bdb, baked into its image). Releases
// before 0.5 are not interoperated with any more (their sh1 invites and v-only hello are gone). (a) a beta.15 host
// (devbox-old) and a current joiner (joiner-a, over toxiproxy:22003); (b) a current host (devbox) and a beta.15 joiner
// (the joiner user on devbox-old, straight over the core network). Protocol 3 changed the invite: a beta.15 host's
// line ends with a 4-digit PIN, which this joiner refuses saying the host must update; this host's line ends with a
// SECRET, which beta.15 refuses ("the PIN is the 4 digits"), and this host's invite text says the joiner needs a newer
// sub-human. A link made before keeps working (protocol 1..3 against 1..2 settles on 2: test/remote-server). Each
// direction must work fully or refuse with words that name the version and which side to update; never a
// half-working room or a mirror that silently diverges. (Not run since Stage 7b.) (c) A hello from a client claiming protocol
// 99, straight into the current host's serve over an ssh login: PROTOCOL, naming the side that must update.
const { WAN, CORE, delivered, converge } = require('./_lib.js');

const VERSION_MSG = /version|update|upgrade|protocol/i;

async function direction(t, label, { hostSvc, joinerSvc, joinerUser, hosts, dest }) {
  const { lab } = t;
  const { code, host } = lab.hostRoom(hostSvc);
  // each side's invite line, typed on the other
  const j = await lab.join({ svc: joinerSvc, user: joinerUser, name: 'bob', code, hosts, hostSvc, dest, key: `id_skew_${hostSvc}` });
  if (j.pending) return t.pending(`${label}: the PIN join`, j.pending);
  t.ev.invite(j.invite, j.pin);
  t.log(`${label}: join ok ${j.join.ok} (${j.join.ms} ms) ${j.join.out || ''}`);
  if (!j.join.ok) {
    // the joiner's refusal, or (a beta.15 joiner, whose words predate protocol 3) the host's invite text the person read
    t.check(`${label}: the refused join names the version / which side to update`, VERSION_MSG.test(j.join.out || '') || /They need sub-human \S+ or newer/.test(j.text || ''), (j.join.out || '').slice(0, 200));
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
  title: 'beta.15 host vs current joiner and the reverse: compatible, or a clear version message; never silent corruption',
  persona: 'P2 corporate (mixed versions)',
  budgetMs: 120_000,
  async run(t) {
    const { lab } = t;
    t.log(`devbox plugin ${lab.probe.version} (protocol v${lab.probe.protocolVersion}); devbox-old plugin ${lab.oldProbe.version} (protocol v${lab.oldProbe.protocolVersion}, cli ${lab.oldProbe.cliPath})`);
    t.check('devbox-old really is the previous release (a 0.5 beta)', lab.oldProbe.version !== lab.probe.version && /^0\.5\.0-beta\./.test(lab.oldProbe.version || ''), `${lab.oldProbe.version} vs ${lab.probe.version}`);
    t.check('the old end probes as having the PIN join and the version range', !!(lab.oldProbe.src && lab.oldProbe.src.hello.range) && lab.oldProbe.files.some(f => /enroll/.test(f)), JSON.stringify(lab.oldProbe.src || {}));
    await direction(t, 'old host beta.15 <- new joiner', { hostSvc: 'devbox-old', joinerSvc: 'joiner-a', hosts: WAN, dest: 'host@devbox-old' });
    await lab.reset();
    await direction(t, 'new host <- old joiner beta.15', { hostSvc: 'devbox', joinerSvc: 'devbox-old', joinerUser: 'joiner', hosts: CORE, dest: 'host@devbox' });

    // (c) a client from the future
    await lab.reset();
    const { code } = lab.hostRoom();
    // an ordinary login key (no invite: the hello needs none to be answered), then the host's serve through its shim
    const pub = lab.keypair('joiner-a', 'id_future');
    lab.exec('devbox', ['sh', '-c', 'cat >> /home/host/.ssh/authorized_keys && chown host:host /home/host/.ssh/authorized_keys && chmod 0600 /home/host/.ssh/authorized_keys'], { input: pub + '\n' });
    const conf = lab.sshConfig('joiner-a', 'future', 'id_future', WAN);
    // the hello as a 9.9.9 joiner would say it (lib/remote/protocol.ts): its range proto {min, max}, its version
    const frame = JSON.stringify({ id: 1, op: 'hello', params: { proto: { min: 99, max: 99 }, client: '9.9.9', caps: {}, machine: 'future-machine' } });
    const r = lab.exec('joiner-a', ['sh', '-c', `printf '%s\\n' '${frame}' | timeout 20 ssh -F ${conf} -o StrictHostKeyChecking=accept-new -T host@devbox '"$HOME"/.sub-human/bin/serve --stdio ${code}'`], { user: 'joiner', allowFail: true, timeout: 30_000 });
    const reply = (r.stdout.split('\n').find(l => l.includes('"id":1')) || '').trim();
    t.ev.write('future-hello.txt', `> ${frame}\n< ${reply}\nstderr: ${r.stderr}`);
    let err = null;
    try { err = JSON.parse(reply).error; } catch { /* no reply */ }
    t.check(`a v99 hello is refused PROTOCOL (reason SKEW) by the ${lab.probe.version} server`, err && err.code === 'PROTOCOL' && err.reason === 'SKEW', reply.slice(0, 200) || r.stderr.slice(0, 200));
    t.expect('the refusal names both versions and says the host must update (the joiner is newer)',
      !!err && /9\.9\.9/.test(err.message) && new RegExp(lab.probe.version.replace(/\./g, '\\.')).test(err.message) && /host must update/i.test(err.message), err ? err.message : 'no reply', 'versionRange');
  },
};
