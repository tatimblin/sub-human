'use strict';
// Security checks on a live room (alice on devbox, bob over the WAN path, bea through the bastion):
//   - the forced command refuses a shell: `ssh devbox ls` runs serve, not ls; no pty; no -W forwarding; the bastion
//     account has no shell either
//   - the stores are private: both homes 0700, nothing in them group- or world-readable
//   - no secret in any log: link tokens appear nowhere but the joiner's own link file (sshd, tinyproxy, caddy and
//     toxiproxy logs, link logs, the tails' output, the room logs and members, ps on every machine)
//   - a wrong PIN 5x burns the invite: each refused with the tries left (the PAKE through the enrollment door), and
//     the right PIN after that gets nowhere
//   - /sub-human kick bob: the link's key is gone from authorized_keys, its serve is stopped, bob's link stops (AUTH:
//     it does not redial, and a post is refused, not queued); bea's link is untouched
const { WAN, JUMP, waitState } = require('./_lib.js');

// ssh as the joiner's link does it: its own key (the join made it, the host's card let it in), its routing (-F)
const linkSsh = (j, code) => `ssh -F ${j.conf} -i ${j.seat.home}/links/${code}/id_ed25519 -o IdentitiesOnly=yes`;

module.exports = {
  id: 'security',
  title: 'forced command refuses a shell; stores 0700; no secrets in logs; wrong PIN 5x burns the invite; kick',
  persona: 'all',
  budgetMs: 150_000,
  async run(t) {
    const { lab } = t;
    const { code, host } = lab.hostRoom();
    const a = await lab.join({ svc: 'joiner-a', name: 'bob', code, hosts: WAN });
    const b = await lab.join({ svc: 'joiner-b', name: 'bea', code, hosts: JUMP, via: 'bastion' });
    if (!t.check('bob and bea join', a.join.ok && b.join.ok)) return;
    a.seat.say('bob', 'security hello');
    host.say('alice', 'security hello back');
    const secrets = [];
    const tokens = [[a, 'joiner-a'], [b, 'joiner-b']].map(([j, svc]) => JSON.parse(lab.exec(svc, ['cat', `${j.seat.home}/links/${code}.json`]).stdout).token);
    // the evidence itself is redacted, so register them only after reading
    const all = [...secrets, ...tokens].filter(Boolean);
    t.log(`${tokens.length} link tokens collected (redacted in this evidence)`);
    for (const s of all) t.ev.secret(s);

    // forced command
    const ls = lab.exec('joiner-a', ['sh', '-c', `timeout 20 ${linkSsh(a, code)} -n -T host@devbox 'ls -la /; id; cat /etc/passwd'`], { user: 'joiner', allowFail: true, timeout: 30_000 });
    t.ev.write('ssh-ls.txt', `exit ${ls.status}\nstdout:\n${ls.stdout}\nstderr:\n${ls.stderr}`);
    t.check('`ssh devbox ls` with an authorized key gets in and runs the forced command, not a shell',
      !/Permission denied/.test(ls.stderr) && !/root:x:0|uid=\d+|\bbin\b.*\bboot\b|drwx/.test(ls.stdout), `exit ${ls.status}, stdout ${ls.stdout.length} B: ${ls.stdout.slice(0, 80).replace(/\n/g, ' ')}; ${ls.stderr.trim().split('\n')[0] || ''}`);
    const pty = lab.exec('joiner-a', ['sh', '-c', `timeout 20 ${linkSsh(a, code)} -tt host@devbox </dev/null`], { user: 'joiner', allowFail: true, timeout: 30_000 });
    t.check('no pty (restrict)', /PTY allocation request failed/i.test(pty.stderr) || !/\$ |# /.test(pty.stdout), (pty.stderr || '').trim().split('\n')[0]);
    const fwd = lab.exec('joiner-a', ['sh', '-c', `timeout 20 ${linkSsh(a, code)} -W devbox:22 host@devbox </dev/null`], { user: 'joiner', allowFail: true, timeout: 30_000 });
    t.check('no TCP forwarding through the devbox (ssh -W refused)', fwd.status !== 0 && !/SSH-2\.0/.test(fwd.stdout), (fwd.stderr || '').trim().split('\n').slice(-1)[0]);
    const jump = lab.exec('joiner-b', ['sh', '-c', `timeout 20 ssh -n -F ${b.conf} jump@bastion id`], { user: 'joiner', allowFail: true, timeout: 30_000 });
    t.check('the bastion account has no shell (ForceCommand nologin)', !/uid=/.test(jump.stdout), (jump.stdout + jump.stderr).trim().split('\n')[0]);

    // private stores
    for (const [svc, seat] of [['devbox', host], ['joiner-a', a.seat], ['joiner-b', b.seat]]) {
      const d = seat.dump(code);
      const open = d.home.files.filter(f => parseInt(f.mode, 8) & 0o077).map(f => `${f.mode} ${f.rel}`);
      t.ev.write(`home-${svc}.txt`, d.home.files.map(f => `${f.mode} ${f.dir ? 'd' : '-'} ${f.rel}`).join('\n'));
      t.check(`${svc}: the store is 0700 and nothing in it is group/world-readable`, d.home.mode === '700' && !open.length, `home ${d.home.mode}${open.length ? `; open: ${open.slice(0, 5).join(', ')}` : ''}`);
    }

    // no secrets anywhere they could leak
    const sources = {};
    sources['compose logs (sshd, tinyproxy, caddy, toxiproxy)'] = lab.composeLogs();
    for (const [svc, j] of [['joiner-a', a], ['joiner-b', b]]) {
      sources[`${svc} link log`] = lab.exec(svc, ['sh', '-c', `cat ${j.seat.home}/links/*.log 2>/dev/null`], { allowFail: true }).stdout;
      sources[`${svc} tail events`] = lab.exec(svc, ['sh', '-c', 'cat /home/joiner/lab-events-*.ndjson'], { allowFail: true }).stdout;
      sources[`${svc} mirror log + members`] = lab.exec(svc, ['sh', '-c', `cat ${j.seat.home}/rooms/${code}/*.json* 2>/dev/null`], { allowFail: true }).stdout;
      sources[`${svc} home outside links/*.json`] = lab.exec(svc, ['sh', '-c', `grep -rl -F -f /dev/stdin ${j.seat.home} | grep -v '/links/${code}.json$' || true`], { allowFail: true, input: all.join('\n') + '\n' }).stdout;
    }
    sources['devbox home (only hashes stored)'] = lab.exec('devbox', ['sh', '-c', 'grep -rl -F -f /dev/stdin /home/host || true'], { allowFail: true, input: all.join('\n') + '\n' }).stdout;
    sources['devbox room log + members'] = lab.exec('devbox', ['sh', '-c', `cat /home/host/.sub-human/rooms/${code}/*.json* 2>/dev/null`], { allowFail: true }).stdout;
    for (const svc of ['devbox', 'bastion', 'joiner-a', 'joiner-b']) sources[`ps on ${svc}`] = lab.exec(svc, ['ps', '-eo', 'user,pid,args'], { allowFail: true }).stdout;
    const leaks = [];
    for (const [where, text] of Object.entries(sources)) {
      for (const s of all) if (String(text).includes(s)) leaks.push(`${where}: ${secrets.includes(s) ? 'invite secret' : 'link token'}`);
      if (/^grep|home/.test(where) && String(text).trim() && !leaks.some(l => l.startsWith(where))) leaks.push(`${where}: ${String(text).trim().split('\n')[0]}`);
    }
    t.ev.write('secret-scan.json', Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, `${String(v).length} B scanned`])));
    t.check('no link token in any log, room file, process list or other file', !leaks.length, leaks.length ? leaks.join('; ') : `${Object.keys(sources).length} sources, ${all.length} secrets`);

    // PIN burn: 5 wrong PINs through the enrollment door, then the right one gets nowhere
    if (t.features.shortCode) {
      const { pin } = lab.hostInvite(host, 'alice');
      t.ev.invite(null, pin);
      const carol = lab.seat('joiner-a', { home: '.sub-human-pin' });
      const wrong = String((Number(pin) + 1) % 1e4).padStart(4, '0');
      const tries = [];
      for (let i = 0; i < 5; i++) tries.push(carol.short('carol', 'host@devbox', code, wrong, '-F', a.conf));
      const right = carol.short('carol', 'host@devbox', code, pin, '-F', a.conf);
      t.ev.write('pin-tries.json', { tries: tries.map(r => r.out), right: right.out });
      t.check('each of 5 wrong PINs is refused with the tries left, in a hidden step; the fifth burns the invite',
        tries.every(r => !r.ok && r.hidden) && tries.slice(0, 4).every((r, i) => new RegExp(`wrong PIN \\(${4 - i} tr`).test(r.out || '')) && /last try: the invite is burnt/.test(tries[4].out || ''),
        tries.map(r => String(r.out || '').slice(0, 60)).join(' | '));
      t.check('the right PIN after 5 wrong ones gets nowhere: the invite burned (its door shut)', !right.ok && /burn|shut|no invite for room/i.test(right.out || ''), (right.out || '').slice(0, 160));
      const hl = host.dump(code).entries.filter(e => e.kind === 'status' && /PIN|burn/i.test(e.text || '')).map(e => e.text);
      t.check('the host\'s room shows the wrong PINs and the burn', hl.some(x => /burn/i.test(x)) && !hl.some(x => x.includes(` ${pin}`) || x.includes(` ${wrong}`)), hl.slice(-2).join(' | ').slice(0, 200));
    } else t.pending('a wrong PIN 5x burns the invite', 'needs shortCode');

    // kick: the person on the host, /sub-human kick bob
    if (t.features.revoke) {
      const r = host.expand('alice', 'kick bob');
      t.ev.write('kick.json', r);
      const keys = lab.exec('devbox', ['cat', '/home/host/.ssh/authorized_keys'], { allowFail: true }).stdout;
      t.check('/sub-human kick bob removes the link\'s authorized_keys line', /bob is out of room/.test(r.out || '') && !!a.linkId && !keys.includes(a.linkId), (r.out || '').slice(0, 160));
      const gone = await t.until(() => !lab.exec('devbox', ['sh', '-c', `pgrep -f '[s]erve --stdio ${code} --link ${a.linkId}' || true`]).stdout.trim(), 10_000, 300);
      t.check("kick stops that link's serve", gone, gone ? 'none running' : 'still running');
      const st = await waitState(a.seat, code, ['stopped'], 20_000);
      const post = a.seat.say('bob', 'after kick');
      const ls = a.seat.link(code);
      t.check("bob's link stops (AUTH, it does not redial) and his post is refused, not queued", st !== null && ls.code === 'AUTH' && !post.ok,
        `${ls.state} ${ls.code || ''}: ${(ls.reason || '').slice(0, 80)}; post: ${(post.out || '').slice(0, 80)}`);
      const bea = b.seat.say('bea', 'bea after kick of bob');
      t.check("bea's link is untouched by bob's kick", bea.ok, bea.out || 'posted');
    } else t.pending('kick NAME removes the key, stops its serve and cuts the link', 'needs revoke');
  },
};
