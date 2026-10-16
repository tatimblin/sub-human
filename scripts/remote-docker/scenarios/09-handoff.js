'use strict';
// Planned handoff (1.0, PROD-PLAN item 7): alice (the host, devbox) moves the room to bob on joiner-a before closing
// her laptop; bea (joiner-b, through the bastion) follows. The real interfaces, in order:
//   1. alice: `/sub-human handoff bob joiner@joiner-a` (the others will reach bob's machine at that address);
//   2. bob's machine gets the ask privately; bob answers the card the hooks build ("Host it here", hooks/handlers/consent.ts);
//   3. joiner-a holds the room (host epoch 1), devbox is a mirror of it, every link is re-pointed at joiner-a;
//   4. over ssh each member follows through its person's own ssh login to the new host, with the bound invite bob's
//      machine minted for it (protocol 3: nothing is let in by the plugin), so a member with no login there yet is
//      offline with a reason naming bob and the way out, and `sub-human doctor --json` shows its link moved and not
//      reached; once the joiner-a account takes each one's key as a login (as a person sets up any ssh login), the
//      link comes online by itself and a bare `/sub-human` joins the seat again over it. (Not run since Stage 7b.)
//   5. posts flow between all three through joiner-a, `sub-human handoff --status` on joiner-a shows both machines
//      reconnected, and every copy is byte-identical with a verifying chain, the old host's lines kept.
// LAB_HANDOFF_CMD overrides step 1's command ({name} and {code} are filled in).
const { WAN, JUMP, delivered, waitState, converge, entries } = require('./_lib.js');

const NEW_HOST = 'joiner@joiner-a';

module.exports = {
  id: 'handoff',
  title: 'devbox hands the room to joiner-a (bob); joiner-b (bea) and the old host follow; nothing lost',
  persona: 'P3 sleep (host leaves)',
  requires: ['handoff'],
  budgetMs: 210_000,
  async run(t) {
    const { lab } = t;
    const { code, host } = lab.hostRoom();
    const a = await lab.join({ svc: 'joiner-a', name: 'bob', code, hosts: WAN });
    const b = await lab.join({ svc: 'joiner-b', name: 'bea', code, hosts: JUMP, via: 'bastion' });
    for (const j of [a, b]) t.ev.invite(j.invite, j.pin);
    if (!t.check('bob and bea join', a.join.ok && b.join.ok, `${a.join.out || ''} / ${b.join.out || ''}`.slice(0, 200))) return;
    host.say('alice', 'handoff before');
    const before = await converge(t, host, code, [a.seat, b.seat]);
    // the old host will dial joiner-a through the bastion with its own default key (its link to bob's machine)
    const hostPub = lab.keypair('devbox', 'id_ed25519', 'host');
    lab.trustOnBastion(hostPub);
    lab.exec('devbox', ['sh', '-c', 'printf "Host bastion\\n  User jump\\n  StrictHostKeyChecking accept-new\\n" > ~/.ssh/config && chmod 0600 ~/.ssh/config'], { user: 'host' });

    // 1. the ask
    const cmd = (process.env.LAB_HANDOFF_CMD || 'handoff {name} ' + NEW_HOST).replace('{name}', 'bob').replace('{code}', code);
    const asked = host.expand('alice', cmd);
    t.ev.write('handoff-ask.json', asked);
    if (!t.check('alice asks bob to host (/sub-human handoff bob joiner@joiner-a): shown to her only', asked.json && asked.json.decision === 'block' && /asked bob to host/.test(asked.out || ''), (asked.out || '').slice(0, 160))) return;

    // 2. bob's card, as he would answer it
    let card = null;
    await t.until(() => { card = a.seat.card('bob', 'Host it here'); return card.ok || !/no handoff ask/.test(card.out || ''); }, 20_000, 500);
    t.ev.write('handoff-card.json', card);
    t.check("bob's machine got the ask and his card answer moved the room", card && card.ok && /is hosted on this machine now/.test(card.out || ''), (card && card.out || '').slice(0, 160));

    // 3. the move
    const isHost = await t.until(() => a.seat.dump(code).isHost, 30_000, 500);
    t.check('joiner-a now holds the room', isHost);
    const devMirror = await t.until(() => !host.dump(code).isHost, 30_000, 500);
    t.check('devbox is now a mirror of it', devMirror);
    const moved = entries(a.seat.dump(code).log).find(e => e.kind === 'host_changed');
    t.check('host_changed (epoch 1, host bob) with both signatures: bob\'s acceptance and alice\'s ask', !!moved && moved.epoch === 1 && moved.host === 'bob' && !!moved.accept && !!moved.ask,
      moved ? JSON.stringify({ epoch: moved.epoch, host: moved.host, accept: !!moved.accept, ask: !!moved.ask }) : 'none');

    // 4. bea is re-pointed at joiner-a; she has no login there yet: offline, told what to do
    const repointed = await t.until(() => { const l = b.seat.link(code); return l.state === 'offline' && /bob/.test(l.reason || ''); }, 30_000, 500);
    const bl = b.seat.link(code);
    t.check("bea's link follows to joiner-a; with no login of hers there it is offline with a reason that names bob and the way out", repointed && /ssh login|invite/.test(bl.reason || ''), `${bl.state}: ${(bl.reason || '').slice(0, 200)}`);
    const dj = b.seat.cli(['doctor', '--json', '--quick'], { env: { SUB_HUMAN_SSH_OPTS: `-F ${b.conf}` } });
    let report = null;
    try { report = JSON.parse(dj.stdout); } catch { /* not JSON */ }
    t.ev.write('doctor-bea-moved.json', dj.stdout + dj.stderr);
    const ld = report && (report.links || []).find(l => l.code === code);
    t.check('doctor --json on joiner-b: the link\'s room moved to bob, not reached yet', !!ld && ld.moved && ld.moved.host === 'bob' && !ld.moved.reached, ld ? JSON.stringify(ld.moved) : 'no link in the report');

    // each machine gets a login of its own on joiner-a (its key, as ssh-copy-id would): the link that stopped on the
    // refused login is then joined again over that login (/sub-human join joiner@joiner-a CODE: links and seats)
    const follow = async (seat, name, pub, sshOpts = []) => {
      lab.authorizeLogin(pub, { svc: 'joiner-a', user: 'joiner' });
      const re = seat.login(name, NEW_HOST, code, ...sshOpts);
      const up = re.ok ? await waitState(seat, code, 'online', 30_000) : null;
      t.log(`${name} follows: online after ${up} ms, seat: ${re.ok ? 'ok' : re.out}`);
      return { ok: up !== null && re.ok, up, re };
    };
    const fb = await follow(b.seat, 'bea', b.pub, ['-F', b.conf]);
    t.check('bea follows once she has a login on joiner-a: joined again over it, her link online there', fb.ok, `online after ${fb.up} ms; ${(fb.re.out || 'ok').slice(0, 120)}`);
    const fa = await follow(host, 'alice', hostPub);
    t.check('the old host follows as a member the same way (through the bastion)', fa.ok, `online after ${fa.up} ms; ${(fa.re.out || 'ok').slice(0, 120)}`);

    // 5. the room goes on through joiner-a
    const s = b.seat.say('bea', 'handoff bea to new host');
    const d = await delivered(a.seat, 'bob', 'handoff bea to new host', 10_000);
    const s2 = a.seat.say('bob', 'handoff bob as host');
    const d2 = await delivered(host, 'alice', 'handoff bob as host', 10_000);
    const s3 = host.say('alice', 'handoff alice as member');
    const d3 = await delivered(b.seat, 'bea', 'handoff alice as member', 10_000);
    t.check('posts flow through the new host to everyone (old host included)', s.ok && d.ok && s2.ok && d2.ok && s3.ok && d3.ok,
      `bea->bob ${s.ok && d.ok}, bob->alice ${s2.ok && d2.ok}, alice->bea ${s3.ok && d3.ok}${s.ok ? '' : `; ${s.out}`}${s3.ok ? '' : `; ${s3.out}`}`);
    const st = a.seat.cli(['handoff', '--status', '--room', code]);
    t.ev.write('handoff-status.txt', st.stdout + st.stderr);
    t.check('sub-human handoff --status on joiner-a: hosted here at epoch 1, no machine left behind', /hosted on this machine \(bob's machine since #\d+\)/.test(st.stdout) && !/epoch/.test(st.stdout) && !/not reconnected/.test(st.stdout),
      st.stdout.trim().split('\n').slice(0, 3).join(' / ').slice(0, 200));
    const after = await converge(t, a.seat, code, [host, b.seat]);
    t.check('every copy byte-identical to the new host, chains verify, the old lines kept', after.ok && after.host.log.startsWith(before.host.log), after.detail);
  },
};
