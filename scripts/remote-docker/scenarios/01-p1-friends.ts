// P1 friends: joiner-a joins the devbox over ssh (the WAN path through toxiproxy). Posts flow both ways, delivered to
// the other side's tail in under 2 s, with no toxic and with a 300 ms latency toxic on each direction. doctor, when
// the plugin has it, reports a healthy link and its --bundle carries no secret.
import { WAN, delivered, converge, type DoctorReport } from './_lib.ts';
import type { Joined, SeatDriver, T } from '../lab.ts';

const LIMIT_MS = 2000;

async function roundTrip(t: T, host: SeatDriver, joiner: Joined, tag: string): Promise<{ up: number | null, down: number | null, posted: boolean }> {
  const out: { up: number | null, down: number | null, posted: boolean } = { up: null, down: null, posted: false };
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

export const id = 'p1-friends';
export const title = 'joiner-a joins devbox by ssh; posts both ways in under 2 s, also under a 300 ms latency toxic';
export const persona = 'P1 friends';
export const budgetMs = 120_000;
export async function run(t: T): Promise<void> {
  const { lab } = t;
  const { code, host } = lab.hostRoom();
  t.log(`room ${code} on devbox`);
  const j = await lab.join({ svc: 'joiner-a', name: 'bob', code, hosts: WAN });
  t.ev.invite(j.invite, j.pin);
  t.log(`bob's join (${j.join.ms} ms): ok ${j.join.ok} ${j.join.out || ''}`);
  if (!t.check('bob joins over ssh through toxiproxy', j.join.ok, j.join.out || `${j.join.ms} ms`)) return;
  const d0 = j.seat.dump(code);
  t.check('the joiner holds a mirror, not the room; its link is online', !d0.isHost && d0.link && d0.link.state === 'online', `link ${d0.link && d0.link.state}`);
  const hostDump = host.dump(code);
  const bobJoin = hostDump.entries.find(e => e.kind === 'member_joined' && e.from === 'bob');
  // the id the host derived from joiner-a's machine key ('k' + 15 hex), which joiner-a keeps for the room (machineIn)
  t.check("host's member_joined for bob carries joiner-a's machine id (its machine key's)", bobJoin && bobJoin.machine === d0.machineIn && /^k[0-9a-f]{15}$/.test(d0.machineIn || '') && d0.machineIn !== hostDump.machine,
    `bob ${bobJoin && bobJoin.machine}, joiner-a in the room ${d0.machineIn}, devbox ${hostDump.machine}`);

  const base = await roundTrip(t, host, j, 'p1 plain');
  t.metric('plain', base);
  t.check(`plain: both directions delivered in under ${LIMIT_MS} ms`, base.posted && base.up !== null && base.down !== null && base.up < LIMIT_MS && base.down < LIMIT_MS,
    `up ${base.up} ms, down ${base.down} ms`);

  await lab.toxic('devbox-ssh', 'lat_down', 'latency', { latency: 300, jitter: 0 }, 'downstream');
  await lab.toxic('devbox-ssh', 'lat_up', 'latency', { latency: 300, jitter: 0 }, 'upstream');
  t.log('latency toxic: 300 ms downstream + 300 ms upstream on devbox-ssh');
  const slow = await roundTrip(t, host, j, 'p1 latency');
  t.metric('latency300', slow);
  await lab.untoxic('devbox-ssh', 'lat_down');
  await lab.untoxic('devbox-ssh', 'lat_up');
  t.check(`300 ms toxic: both directions delivered in under ${LIMIT_MS} ms`, slow.posted && slow.up !== null && slow.down !== null && slow.up < LIMIT_MS && slow.down < LIMIT_MS,
    `up ${slow.up} ms, down ${slow.down} ms`);

  const c = await converge(t, host, code, [j.seat]);
  t.check('mirror byte-identical to the host log, chains verify', c.ok, c.detail);

  if (t.features.doctor) {
    // the joiner's ssh routing is its own config (-F, as the link daemon got it through SUB_HUMAN_SSH_OPTS); a
    // person's would be ~/.ssh/config, which doctor's hello reads the same way
    const env = { SUB_HUMAN_SSH_OPTS: `-F ${j.conf}` };
    const doc = j.seat.cli(['doctor'], { env });
    t.ev.write('doctor.txt', doc.stdout + doc.stderr);
    t.check('sub-human doctor on the joiner exits 0 (warnings allowed: no claude binary in the lab)', doc.status === 0, (doc.stdout + doc.stderr).split('\n').slice(-3).join(' / '));
    const json = j.seat.cli(['doctor', '--json'], { env });
    let report: DoctorReport | null = null;
    try { report = JSON.parse(json.stdout); } catch { /* not JSON */ }
    t.ev.write('doctor.json', json.stdout + json.stderr);
    const by = (id: string) => report && report.checks.find(c => c.id === id);
    const lk = by(`link:${code}`), clk = by(`clock:${code}`);
    t.check('doctor --json: the link check passes (daemon, state up, a hello to the host)', !!lk && lk.status === 'pass', lk ? `${lk.status}: ${lk.detail}`.slice(0, 160) : (json.stderr || json.stdout).slice(0, 160));
    t.check('doctor --json: the clock against the host (its hello carries the time) passes', !!clk && clk.status === 'pass', clk ? `${clk.status}: ${clk.detail}` : 'no clock check');
    const token = JSON.parse(lab.exec('joiner-a', ['cat', `${j.seat.home}/links/${code}.json`], { user: 'joiner' }).stdout).token;
    const file = '/home/joiner/doctor-bundle.json';
    const bundle = j.seat.cli(['doctor', '--bundle', file], { env });
    const body = lab.exec('joiner-a', ['cat', file], { allowFail: true }).stdout;
    const secret = String(j.invite).split('.')[3];
    t.check('doctor --bundle writes a bundle that holds no link token, invite secret, PIN or room code',
      bundle.status === 0 && body.length > 100 && !body.includes(token) && !body.includes(secret) && !(j.pin && body.includes(j.pin)) && !body.includes(code),
      `${file}, ${body.length} B, exit ${bundle.status}`);
  } else t.pending('sub-human doctor reports the link (and --bundle is redacted)', 'needs doctor');
}
