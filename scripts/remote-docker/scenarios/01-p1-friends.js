'use strict';
// P1 friends: joiner-a joins the devbox over ssh (the WAN path through toxiproxy). Posts flow both ways, delivered to
// the other side's tail in under 2 s, with no toxic and with a 300 ms latency toxic on each direction. doctor, when
// the plugin has it, reports a healthy link and its --bundle carries no secret.
const { WAN, delivered, converge } = require('./_lib.js');

const LIMIT_MS = 2000;

async function roundTrip(t, host, joiner, code, tag) {
  const out = {};
  const a = joiner.seat.say(joiner.name, `${tag} from bob`);
  const d1 = await delivered(host, 'alice', `${tag} from bob`, 8000);
  out.up = d1.ok ? d1.t - a.t0 : null;
  const b = host.say('alice', `${tag} from alice`);
  const d2 = await delivered(joiner.seat, joiner.name, `${tag} from alice`, 8000);
  out.down = d2.ok ? d2.t - b.t0 : null;
  out.posted = a.ok && b.ok;
  t.log(`${tag}: joiner->host ${out.up} ms (hook ${a.ms} ms), host->joiner ${out.down} ms (hook ${b.ms} ms)`);
  return out;
}

module.exports = {
  id: 'p1-friends',
  title: 'joiner-a joins devbox by ssh; posts both ways in under 2 s, also under a 300 ms latency toxic',
  persona: 'P1 friends',
  budgetMs: 120_000,
  async run(t) {
    const { lab } = t;
    const { code, host } = lab.hostRoom();
    t.log(`room ${code} on devbox`);
    const j = lab.joinOver({ svc: 'joiner-a', name: 'bob', code, hosts: WAN });
    t.ev.secret(j.invite.split('.').pop());
    t.log(`bob's join (${j.join.ms} ms): ok ${j.join.ok} ${j.join.out || ''}`);
    if (!t.check('bob joins over ssh through toxiproxy', j.join.ok, j.join.out || `${j.join.ms} ms`)) return;
    const d0 = j.seat.dump(code);
    t.check('the joiner holds a mirror, not the room; its link is online', !d0.isHost && d0.link && d0.link.state === 'online', `link ${d0.link && d0.link.state}`);
    const hostDump = host.dump(code);
    const bobJoin = hostDump.entries.find(e => e.kind === 'member_joined' && e.from === 'bob');
    t.check("host's member_joined for bob carries joiner-a's machine id", bobJoin && bobJoin.machine === d0.machine && d0.machine !== hostDump.machine,
      `bob ${bobJoin && bobJoin.machine}, devbox ${hostDump.machine}`);

    const base = await roundTrip(t, host, j, code, 'p1 plain');
    t.metric('plain', base);
    t.check(`plain: both directions delivered in under ${LIMIT_MS} ms`, base.posted && base.up !== null && base.down !== null && base.up < LIMIT_MS && base.down < LIMIT_MS,
      `up ${base.up} ms, down ${base.down} ms`);

    await lab.toxic('devbox-ssh', 'lat_down', 'latency', { latency: 300, jitter: 0 }, 'downstream');
    await lab.toxic('devbox-ssh', 'lat_up', 'latency', { latency: 300, jitter: 0 }, 'upstream');
    t.log('latency toxic: 300 ms downstream + 300 ms upstream on devbox-ssh');
    const slow = await roundTrip(t, host, j, code, 'p1 latency');
    t.metric('latency300', slow);
    await lab.untoxic('devbox-ssh', 'lat_down');
    await lab.untoxic('devbox-ssh', 'lat_up');
    t.check(`300 ms toxic: both directions delivered in under ${LIMIT_MS} ms`, slow.posted && slow.up !== null && slow.down !== null && slow.up < LIMIT_MS && slow.down < LIMIT_MS,
      `up ${slow.up} ms, down ${slow.down} ms`);

    const c = await converge(t, host, code, [j.seat]);
    t.check('mirror byte-identical to the host log, chains verify', c.ok, c.detail);

    if (t.features.doctor) {
      const doc = j.seat.cli(['doctor']);
      t.ev.write('doctor.txt', doc.stdout + doc.stderr);
      t.check('sub-human doctor on the joiner exits 0', doc.status === 0, (doc.stdout + doc.stderr).split('\n').slice(-3).join(' / '));
      const token = JSON.parse(lab.exec('joiner-a', ['cat', `${j.seat.home}/links/${code}.json`], { user: 'joiner' }).stdout).token;
      const bundle = j.seat.cli(['doctor', '--bundle']);
      const text = bundle.stdout + bundle.stderr;
      const file = (/(\/\S+\.(?:tar\.gz|tgz|json|txt))/.exec(text) || [])[1];
      const body = file ? lab.exec('joiner-a', ['sh', '-c', `tar -xOzf ${file} 2>/dev/null || cat ${file}`], { allowFail: true }).stdout : text;
      t.check('doctor --bundle holds no link token and no invite secret', bundle.status === 0 && !body.includes(token) && !body.includes(j.invite.split('.').pop()), file || 'stdout');
    } else t.pending('sub-human doctor reports the link (and --bundle is redacted)', 'needs doctor');
  },
};
