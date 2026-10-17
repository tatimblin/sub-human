// Security checks on a live room (alice on devbox, bob and bea each over a WAN path), each joined with
// an invite line over their own ssh login (protocol 3; not run since Stage 7b, no Docker where it was written):
//   - nothing of sub-human's in the devbox account's authorized_keys (no door, no forced command): only the login lines
//     people set up
//   - the stores are private: both homes 0700, nothing in them group- or world-readable
//   - no secret in any log: link tokens appear nowhere but the joiner's own link file (sshd, caddy and
//     toxiproxy logs, link logs, the tails' output, the room logs and members, ps on every machine)
//   - a wrong PIN 5x burns the invite: pending here (test/remote-short, remote-invite-line cover it)
//   - /sub-human kick bob: the link's token is gone, its serve is stopped, bob's link stops (AUTH:
//     it does not redial, and a post is refused, not queued); bea's link is untouched
import { WAN, WAN_B, waitState } from './_lib.ts';
import type { Joined, LinkJson, SeatDriver, T } from '../lab.ts';
import { parseJson } from '../../lib/io.ts';

export const id = 'security';
export const title = 'nothing of sub-human\'s in authorized_keys; stores 0700; no secrets in logs; kick';
export const persona = 'all';
export const budgetMs = 150_000;
export async function run(t: T): Promise<void> {
  const { lab } = t;
  const { code, host } = lab.hostRoom();
  const a = await lab.join({ svc: 'joiner-a', name: 'bob', code, hosts: WAN });
  const b = await lab.join({ svc: 'joiner-b', name: 'bea', code, hosts: WAN_B });
  if (!t.check('bob and bea join', a.join.ok && b.join.ok)) return;
  a.seat.say('bob', 'security hello');
  host.say('alice', 'security hello back');
  const secrets: string[] = [];
  const pairs: [Joined, string][] = [[a, 'joiner-a'], [b, 'joiner-b']];
  const tokens: string[] = pairs.map(([j, svc]) => parseJson<LinkJson>(lab.exec(svc, ['cat', `${j.seat.home}/links/${code}.json`]).stdout).token);
  // the evidence itself is redacted, so register them only after reading
  const all = [...secrets, ...tokens].filter(Boolean);
  t.log(`${tokens.length} link tokens collected (redacted in this evidence)`);
  for (const s of all) t.ev.secret(s);

  // no door, no forced command: the devbox account's authorized_keys holds the login lines people set up, nothing else
  const ak = lab.exec('devbox', ['sh', '-c', 'cat /home/host/.ssh/authorized_keys 2>/dev/null || true']).stdout;
  t.ev.write('authorized_keys.txt', ak);
  t.check('nothing of sub-human\'s in authorized_keys (no enrollment door, no forced-command line)', !/sub-human|command=/.test(ak), `${ak.split('\n').filter(Boolean).length} line(s)`);

  // private stores
  for (const [svc, seat] of [['devbox', host], ['joiner-a', a.seat], ['joiner-b', b.seat]] as const satisfies readonly (readonly [string, SeatDriver])[]) {
    const d = seat.dump(code);
    const open = d.home.files.filter(f => parseInt(f.mode, 8) & 0o077).map(f => `${f.mode} ${f.rel}`);
    t.ev.write(`home-${svc}.txt`, d.home.files.map(f => `${f.mode} ${f.dir ? 'd' : '-'} ${f.rel}`).join('\n'));
    t.check(`${svc}: the store is 0700 and nothing in it is group/world-readable`, d.home.mode === '700' && !open.length, `home ${d.home.mode}${open.length ? `; open: ${open.slice(0, 5).join(', ')}` : ''}`);
  }

  // no secrets anywhere they could leak
  const sources: Record<string, string> = {};
  sources['compose logs (sshd, caddy, toxiproxy)'] = lab.composeLogs();
  for (const [j, svc] of pairs) {
    sources[`${svc} link log`] = lab.exec(svc, ['sh', '-c', `cat ${j.seat.home}/links/*.log 2>/dev/null`], { allowFail: true }).stdout;
    sources[`${svc} tail events`] = lab.exec(svc, ['sh', '-c', 'cat /home/joiner/lab-events-*.ndjson'], { allowFail: true }).stdout;
    sources[`${svc} mirror log + members`] = lab.exec(svc, ['sh', '-c', `cat ${j.seat.home}/rooms/${code}/*.json* 2>/dev/null`], { allowFail: true }).stdout;
    sources[`${svc} home outside links/*.json`] = lab.exec(svc, ['sh', '-c', `grep -rl -F -f /dev/stdin ${j.seat.home} | grep -v '/links/${code}.json$' || true`], { allowFail: true, input: all.join('\n') + '\n' }).stdout;
  }
  sources['devbox home (only hashes stored)'] = lab.exec('devbox', ['sh', '-c', 'grep -rl -F -f /dev/stdin /home/host || true'], { allowFail: true, input: all.join('\n') + '\n' }).stdout;
  sources['devbox room log + members'] = lab.exec('devbox', ['sh', '-c', `cat /home/host/.sub-human/rooms/${code}/*.json* 2>/dev/null`], { allowFail: true }).stdout;
  for (const svc of ['devbox', 'joiner-a', 'joiner-b']) sources[`ps on ${svc}`] = lab.exec(svc, ['ps', '-eo', 'user,pid,args'], { allowFail: true }).stdout;
  const leaks: string[] = [];
  for (const [where, text] of Object.entries(sources)) {
    for (const s of all) if (String(text).includes(s)) leaks.push(`${where}: ${secrets.includes(s) ? 'invite secret' : 'link token'}`);
    if (/^grep|home/.test(where) && String(text).trim() && !leaks.some(l => l.startsWith(where))) leaks.push(`${where}: ${String(text).trim().split('\n')[0]}`);
  }
  t.ev.write('secret-scan.json', Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, `${String(v).length} B scanned`])));
  t.check('no link token in any log, room file, process list or other file', !leaks.length, leaks.length ? leaks.join('; ') : `${Object.keys(sources).length} sources, ${all.length} secrets`);

  t.pending('a wrong PIN 5x burns the invite', 'covered by test/remote-short and remote-invite-line');

  // kick: the person on the host, /sub-human kick bob
  if (t.features.revoke) {
    const r = host.expand('alice', 'kick bob');
    t.ev.write('kick.json', r);
    t.check('/sub-human kick bob ends his link (its token; his ssh login is the account\'s to keep or remove)', /bob is out of room/.test(r.out || '') && !!a.linkId, (r.out || '').slice(0, 160));
    const gone = await t.until(() => !lab.exec('devbox', ['sh', '-c', `pgrep -f '[s]erve --stdio ${code} --link ${a.linkId}' || true`]).stdout.trim(), 10_000, 300);
    t.check("kick stops that link's serve", gone, gone ? 'none running' : 'still running');
    const st = await waitState(a.seat, code, ['stopped'], 20_000);
    const post = a.seat.say('bob', 'after kick');
    const ls = a.seat.link(code);
    t.check("bob's link stops (AUTH, it does not redial) and his post is refused, not queued", st !== null && ls.code === 'AUTH' && !post.ok,
      `${ls.state} ${ls.code || ''} ${ls.why || ''}: ${(ls.reason || '').slice(0, 80)}; post: ${(post.out || '').slice(0, 80)}`);
    // the typed reason (link-socket status `why`): the host revoked the link, or ssh refused its revoked key
    t.check('the stop carries its typed reason (LINK_REVOKED or KEY_REVOKED), not only words', ['LINK_REVOKED', 'KEY_REVOKED'].includes(String(ls.why)), String(ls.why));
    const bea = b.seat.say('bea', 'bea after kick of bob');
    t.check("bea's link is untouched by bob's kick", bea.ok, bea.out || 'posted');
  } else t.pending('kick NAME stops its serve and cuts the link', 'needs revoke');
}
