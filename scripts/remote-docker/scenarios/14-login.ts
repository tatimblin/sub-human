// Join with your own ssh login (no invite, PIN or admit): bob on joiner-a has a key the devbox account `host` takes as
// an ordinary authorized_keys line (no command=), over the WAN path. Checked: a first connection to a host ssh does not
// know yet fails at once with the exact `ssh host@devbox` to run once (BatchMode: no prompt, no hang) and mints no
// link; after that one ssh, `/sub-human join host@devbox CODE --as bob` links and takes the seat in one step, through
// the host's stable shim (written by alice's own join there); posts flow both ways; the room line names the link. The
// login seat is the host person's own for consent (its account is the host account's: whoever logs in as it). A
// key the host restricted to another link (its forced-command line) cannot use the login path: AUTH, no link. kick
// ends it.
import { WAN, delivered, converge, waitState } from './_lib.ts';
import type { LinkJson, MembersFile, T } from '../lab.ts';
import { parseJson } from '../../lib/io.ts';

const AK = '/home/host/.ssh/authorized_keys';

export const id = 'login';
export const title = 'join host@devbox CODE over the joiner\'s own ssh login; unknown host key fails fast; a restricted key cannot use it';
export const persona = 'P1 own machines';
export const requires = ['loginJoin'];
export const budgetMs = 120_000;
export async function run(t: T): Promise<void> {
  const { lab } = t;
  const { code, host } = lab.hostRoom();
  t.log(`room ${code} on devbox`);
  const shim = lab.exec('devbox', ['test', '-x', '/home/host/.sub-human/bin/serve'], { allowFail: true });
  t.check('alice\'s join on the devbox wrote the stable serve shim', shim.status === 0);

  // bob's own key, let in as an ordinary login (what ssh-copy-id would write); his config asks about unknown hosts
  const pub = lab.keypair('joiner-a', 'id_bob');
  lab.exec('devbox', ['sh', '-c', `cat >> ${AK} && chown host:host ${AK} && chmod 0600 ${AK}`], { input: pub + '\n' });
  const conf = lab.sshConfig('joiner-a', 'bob', 'id_bob', { devbox: { ...WAN.devbox, StrictHostKeyChecking: 'ask' } });
  const opts = ['-F', conf];
  const seat = lab.seat('joiner-a');

  const t0 = Date.now();
  const first = seat.login('bob', 'host@devbox', code, ...opts);
  const firstMs = Date.now() - t0;
  t.log(`first join (${firstMs} ms): ${first.out}`);
  t.check('a host ssh does not know yet: the join stops at once with the exact ssh to run once', !first.ok && /Run `ssh host@devbox` once in a terminal/.test(first.out) && firstMs < 15_000, `${firstMs} ms: ${first.out.slice(0, 160)}`);
  const linksOf = () => parseJson<Record<string, unknown>>(lab.exec('devbox', ['cat', `/home/host/.sub-human/rooms/${code}/remote/links.json`], { allowFail: true }).stdout || '{}');
  t.check('nothing was linked on the host', !Object.keys(linksOf()).length);

  // the person checks and accepts the key once, by hand
  const once = lab.exec('joiner-a', ['ssh', '-F', conf, '-o', 'StrictHostKeyChecking=accept-new', '-n', 'host@devbox', 'true'], { user: 'joiner', allowFail: true, timeout: 30_000 });
  t.log(`ssh host@devbox once: exit ${once.status} ${once.stderr.trim().split('\n')[0] || ''}`);
  const j = seat.login('bob', 'host@devbox', code, ...opts);
  t.log(`join (${j.ms} ms): ok ${j.ok} ${j.out}`);
  if (!t.check('join host@devbox CODE --as bob links and takes the seat in one step', j.ok, j.out || `${j.ms} ms`)) return;
  const lf = parseJson<LinkJson>(lab.exec('joiner-a', ['cat', `${seat.home}/links/${code}.json`], { user: 'joiner' }).stdout);
  t.ev.secret(lf.token);
  const id = lf.transport && lf.transport.link;
  t.check('the link file holds a login transport and a token, no invite, no key of its own',
    lf.transport.login === true && typeof lf.token === 'string' && !lf.invite && !lf.transport.key && !lf.transport.knownHosts, JSON.stringify({ ...lf.transport }));
  const lines = host.dump(code).entries.filter(e => e.from === 'room').map(e => e.text).join('\n');
  t.check('the room line says a machine linked over the ssh login, with no internal id', new RegExp('^a machine linked over your SSH login$', 'm').test(lines) && !lines.includes(id), lines.split('\n').slice(-1)[0]);
  const ps = lab.exec('devbox', ['sh', '-c', 'ps -eo user,args | grep "[s]erve --stdio"'], { allowFail: true }).stdout;
  t.check('on the devbox, serve runs as host through the shim, with --login and the link id', new RegExp(`--stdio ${code} --link ${id} --login`).test(ps), ps.trim().split('\n')[0]);

  const a = seat.say('bob', 'login hello from bob');
  const d1 = await delivered(host, 'alice', 'login hello from bob', 8000);
  const b = host.say('alice', 'login hello from alice');
  const d2 = await delivered(seat, 'bob', 'login hello from alice', 8000);
  t.check('posts flow both ways', a.ok && b.ok && d1.ok && d2.ok, `up ${d1.ok ? d1.t - a.t0 : null} ms, down ${d2.ok ? d2.t - b.t0 : null} ms`);
  const c = await converge(t, host, code, [seat]);
  t.check('mirror byte-identical to the host log, chains verify', c.ok, c.detail);
  const ms = parseJson<MembersFile>(host.dump(code).members || '{}');
  t.check('the login seat is the host account\'s own person (its account is the host\'s machine)', !!ms.bob && !!ms.bob.account, JSON.stringify(ms.bob || null));
  t.check('its machine id is the one the joiner\'s machine key gives, not its home\'s', /^k[0-9a-f]{15}$/.test((ms.bob && ms.bob.machine) || ''), (ms.bob && ms.bob.machine) || 'none');

  // a key restricted to another link: the forced-command line a host's admit writes for one link
  const carolPub = lab.keypair('joiner-a', 'id_carol');
  lab.restrict(code, 'bbbbbbbbbbbb', carolPub); // a link id the host never made: the line alone is the restriction
  const confC = lab.sshConfig('joiner-a', 'carol', 'id_carol', WAN);
  const carol = lab.seat('joiner-a', { home: '.sub-human-carol' });
  const r = carol.login('carol', 'host@devbox', code, '-F', confC);
  t.log(`carol (restricted key) join: ${r.out}`);
  t.check('a key restricted to another link cannot make a link over the login path (AUTH, says why)',
    !r.ok && /came through a key that was let in for one other connection/.test(r.out), r.out.slice(0, 200));
  const raw = lab.exec('joiner-a', ['sh', '-c', `timeout 15 ssh -F ${confC} -T host@devbox '"$HOME"/.sub-human/bin/serve --stdio ${code} --link aaaaaaaaaaaa --login' </dev/null`], { user: 'joiner', allowFail: true, timeout: 30_000 });
  t.check('the restricted key asking for `serve --login` by hand runs only its forced command', !/--login/.test(lab.exec('devbox', ['sh', '-c', 'ps -eo args | grep "[a]aaaaaaaaaaa"'], { allowFail: true }).stdout), `exit ${raw.status}`);
  t.check('the host still holds only bob\'s login link', JSON.stringify(Object.keys(linksOf())) === JSON.stringify([id]), JSON.stringify(Object.keys(linksOf())));

  // kick: the token goes, the serve stops, bob's link stops for good
  const rv = host.expand('alice', 'kick bob');
  t.log(`kick: ${rv.out}`);
  t.check('kick bob ends the login link (and says the login can join again)', new RegExp(`bob is out of room ${code}: it no longer reaches the room\\. It came over an ssh login`).test(rv.out || ''), (rv.out || '').slice(0, 200));
  const stopped = await waitState(seat, code, 'stopped', 20_000);
  t.check('bob\'s link stops (it does not redial)', stopped !== null, `${stopped} ms`);
}
