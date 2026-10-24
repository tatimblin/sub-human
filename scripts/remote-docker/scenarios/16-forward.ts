// #27, a shared machine: alice hosts in the devbox account `host`; bob on joiner-a can ssh to the devbox only as its
// other account, `joiner` (his own login there, never host's). alice's `/sub-human invite --forward` shows
// `/sub-human join devbox CODE SECRET --forward PORT`; bob types it with the PIN, and his own `ssh -W 127.0.0.1:PORT`
// (real OpenSSH, through the WAN path) carries the web link to her listener on the devbox's loopback. Checked, against
// a real sshd: with `AllowTcpForwarding no` (the lab's own setting) the join stops with SSH_FORWARD_REFUSED and the
// invite keeps its tries; with forwarding allowed, the PIN lets him in (no card), the link comes online, posts flow,
// mirrors converge, no shell ran as joiner on the devbox, and nothing was installed in joiner's home. The devbox's sshd
// config is put back at the end.
import { WAN, delivered, converge, waitState } from './_lib.ts';
import type { T } from '../lab.ts';

const CONF = '/etc/ssh/sshd_config.d/lab.conf';
const LINE_RE = /\/sub-human (join devbox ([a-z]+-\d{4}) ([0-9a-z]{39}) --forward (\d{1,5}))\n/;
const PIN_RE = /apart from the line[^\n]*: (\d{4})\n/;

export const id = 'forward';
export const title = 'invite --forward: join a shared machine as your own account there, over your own ssh -W to the host\'s loopback listener';
export const persona = 'P2 shared dev box';
export const requires = ['ws']; // the probe's inviteLine reads a file the join moved out of; ws is what this rides
export const budgetMs = 180_000;
export async function run(t: T): Promise<void> {
  const { lab } = t;
  const original = lab.exec('devbox', ['cat', CONF]).stdout;
  // sshd re-reads its config on SIGHUP (it runs as the container's pid 1); `sshd -t` first, so a bad file never takes it down
  const sshd = (extra: string[]): boolean => {
    const body = original.replace(/^AllowUsers .*$/m, 'AllowUsers host joiner').replace(/^AllowTcpForwarding .*\n/m, '') + extra.map(l => `${l}\n`).join('');
    lab.exec('devbox', ['sh', '-c', `cat > ${CONF}`], { input: body });
    const ok = lab.exec('devbox', ['/usr/sbin/sshd', '-t'], { allowFail: true }).status === 0;
    if (ok) lab.exec('devbox', ['kill', '-HUP', '1'], { allowFail: true });
    return ok;
  };
  try {
    const { code } = lab.hostRoom();
    const host = lab.seat('devbox', { env: { SUB_HUMAN_SSH_ADDR: 'devbox' } });
    const shown = host.expand('alice', 'invite --forward');
    const m = LINE_RE.exec(`${shown.out}\n`), p = PIN_RE.exec(`${shown.out}\n`);
    if (m) t.ev.invite(m[1], p && p[1]);
    if (!t.check('invite --forward shows `join devbox CODE SECRET --forward PORT` (no account in it) and the PIN apart, hidden from the model',
      !!m && !!p && m[2] === code && shown.json?.hookSpecificOutput?.suppressOriginalPrompt === true, (shown.out || '').slice(0, 240)) || !m || !p) return;
    const [, line = '', , , port = ''] = m, [, pin = ''] = p;
    const lis = lab.exec('devbox', ['sh', '-c', `ss -ltnH 'sport = :${port}'`], { allowFail: true }).stdout;
    // ss -H: State Recv-Q Send-Q Local Peer; the local address is the 4th column
    const local = lis.trim().split(/\s+/)[3] ?? '';
    t.check('the listener binds 127.0.0.1 only', /^127\.0\.0\.1:\d+$/.test(local), lis.trim());

    // bob's own key, let in to the devbox's other account (joiner), never host's
    const pub = lab.keypair('joiner-a', 'id_bob');
    lab.authorizeLogin(pub, { svc: 'devbox', user: 'joiner' });
    const conf = lab.sshConfig('joiner-a', 'bob', 'id_bob', WAN);
    const homeBefore = lab.exec('devbox', ['sh', '-c', 'find /home/joiner -mindepth 1 | sort']).stdout;

    // 1. the lab's sshd: AllowTcpForwarding no
    if (!t.check('sshd: joiner may log in, forwarding off', sshd(['AllowTcpForwarding no']))) return;
    const rawW = (to: string, level?: string) => lab.exec('joiner-a', ['ssh', ...(level ? ['-o', `LogLevel=${level}`] : []), '-F', conf, '-o', 'BatchMode=yes', '-W', to, 'devbox'], { user: 'joiner', allowFail: true, input: '', timeout: 30_000 });
    for (const lv of [undefined, 'INFO']) { const r = rawW(`127.0.0.1:${port}`, lv); t.log(`raw ssh -W (LogLevel ${lv ?? 'conf'}) forwarding off: exit ${r.status} ${JSON.stringify(r.stderr)}`); }
    const seat = lab.seat('joiner-a');
    const no = seat.short('bob', `${line} ${pin}`, '-F', conf);
    t.log(`with forwarding off: ${no.out}`);
    t.check('forwarding off: the join stops and says sshd forwards no port for joiner@devbox (real OpenSSH words)',
      /doesn't let joiner@devbox forward ports/.test(no.out), no.out.slice(0, 240));

    // 2. forwarding allowed (local only): the same line, a fresh invite
    if (!t.check('sshd: forwarding allowed (local)', sshd(['AllowTcpForwarding local']))) return;
    for (const lv of [undefined, 'INFO']) { const r = rawW('127.0.0.1:1', lv); t.log(`raw ssh -W (LogLevel ${lv ?? 'conf'}) nothing listening: exit ${r.status} ${JSON.stringify(r.stderr)}`); }
    const again = host.expand('alice', 'invite --forward');
    const m2 = LINE_RE.exec(`${again.out}\n`), p2 = PIN_RE.exec(`${again.out}\n`);
    if (m2) t.ev.invite(m2[1], p2 && p2[1]);
    if (!m2 || !p2) { t.check('a second invite --forward', false, (again.out || '').slice(0, 200)); return; }
    const typed = seat.short('bob', `${m2[1]} ${p2[1]}`, '-F', conf);
    const linked = typed.linked || await t.until(() => seat.linkfile(code).token, 30_000, 250);
    if (!t.check('the right PIN over joiner\'s own ssh -W: let in, no card', linked, (typed.out || '').slice(0, 240))) return;
    const tr = seat.linkfile(code).transport;
    t.check('the link: ws to 127.0.0.1 through a tunnel as joiner@devbox (ssh -G gave joiner\'s own user)',
      tr?.kind === 'ws' && tr.host === '127.0.0.1' && tr.tunnel?.user === 'joiner' && tr.tunnel.host === 'devbox', JSON.stringify(tr));
    const online = await waitState(seat, code, 'online', 40_000);
    t.check('the link comes online', online !== null, `${online} ms`);
    t.check('bob takes his seat', seat.expand('bob', '').ok);
    const a = seat.say('bob', 'forward hello from bob');
    const d1 = await delivered(host, 'alice', 'forward hello from bob', 8000);
    const b = host.say('alice', 'forward hello from alice');
    const d2 = await delivered(seat, 'bob', 'forward hello from alice', 8000);
    t.check('posts flow both ways', a.ok && d1.ok && b.ok && d2.ok);
    const c = await converge(t, host, code, [seat]);
    t.check('the mirror is byte-identical to the host log', c.ok, c.detail);
    const ps = lab.exec('devbox', ['sh', '-c', 'ps -o user=,args= -u joiner'], { allowFail: true }).stdout;
    t.check('as joiner on the devbox only sshd\'s own session runs: no shell, no node, no serve', !/\b(bash|sh -c|node|serve)\b/.test(ps), ps.trim().split('\n').slice(0, 3).join(' | '));
    const homeAfter = lab.exec('devbox', ['sh', '-c', 'find /home/joiner -mindepth 1 | sort']).stdout;
    t.check('nothing was installed in joiner\'s home on the devbox', homeAfter === homeBefore && !/sub-human/.test(homeAfter), homeAfter.trim());
    const serves = lab.exec('devbox', ['sh', '-c', 'ps -o user=,args= -u host | grep "[s]erve --stdio"'], { allowFail: true }).stdout;
    t.check('alice\'s serve runs as host, spawned by her listener (--via ws)', new RegExp(`--stdio ${code} --via ws`).test(serves), serves.trim().split('\n')[0]);
  } finally {
    lab.exec('devbox', ['sh', '-c', `cat > ${CONF}`], { input: original });
    lab.exec('devbox', ['kill', '-HUP', '1'], { allowFail: true });
  }
}
