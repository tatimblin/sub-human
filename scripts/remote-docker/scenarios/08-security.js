'use strict';
// Security checks on a live room (alice on devbox, bob over the WAN path, bea through the bastion):
//   - the forced command refuses a shell: `ssh devbox ls` runs serve, not ls; no pty; no -W forwarding; the bastion
//     account has no shell either
//   - the stores are private: both homes 0700, nothing in them group- or world-readable
//   - no secret in any log: invite secrets and link tokens appear nowhere but the joiner's own link file (sshd,
//     tinyproxy, caddy and toxiproxy logs, link logs, the tails' output, the room logs and members, ps on every machine)
//   - (1.0) a wrong PIN 5x burns the invite: the right PIN after that is refused too (an ssh sh2 join: the host
//     admits the joiner's key first, the PIN is checked at each hello)
//   - (1.0) /sub-human revoke bob: the link's key is gone from authorized_keys, its serve is stopped, bob's link
//     stops (AUTH: it does not redial, and a post is refused, not queued); bea's link is untouched
const { WAN, JUMP, waitState } = require('./_lib.js');

// ssh as the joiner's link does it: its own key (an sh2 join made it, the host admitted it), its routing (-F)
const linkSsh = (j, code) => `ssh -F ${j.conf} -i ${j.seat.home}/links/${code}/id_ed25519 -o IdentitiesOnly=yes`;

module.exports = {
  id: 'security',
  title: 'forced command refuses a shell; stores 0700; no secrets in logs; wrong PIN 5x burns the invite; revoke',
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
    const secrets = [a.invite, b.invite].map(i => i.split('.').pop());
    const tokens = [[a, 'joiner-a'], [b, 'joiner-b']].map(([j, svc]) => JSON.parse(lab.exec(svc, ['cat', `${j.seat.home}/links/${code}.json`]).stdout).token);
    // the evidence itself is redacted, so register them only after reading
    const all = [...secrets, ...tokens].filter(Boolean);
    t.log(`${secrets.length} invite secrets and ${tokens.length} link tokens collected (redacted in this evidence)`);
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
    t.check('no invite secret or link token in any log, room file, process list or other file', !leaks.length, leaks.length ? leaks.join('; ') : `${Object.keys(sources).length} sources, ${all.length} secrets`);

    // PIN burn (1.0: sh2 + PIN)
    if (t.features.sh2Pin && t.features.hostSsh) {
      const { invite: inv, pin } = lab.hostInvite(host, 'alice');
      t.ev.invite(inv, pin);
      const carol = lab.seat('joiner-a', { home: '.sub-human-pin' });
      const wrong = String((Number(pin) + 1) % 1e6).padStart(6, '0');
      const tries = [carol.join('carol', inv, wrong, '-F', a.conf)];
      // over ssh the host admits carol's key first; her link's hello then brings the (wrong) PIN
      const adm = tries[0].admit ? host.expand('alice', `admit ${tries[0].admit}`) : null;
      await t.until(() => /wrong PIN|burn/i.test(JSON.stringify(carol.link(code))), 30_000, 300);
      for (let i = 1; i < 5; i++) tries.push(carol.join('carol', inv, wrong, '-F', a.conf));
      const first = carol.link(code);
      const right = carol.join('carol', inv, pin, '-F', a.conf);
      const after = carol.link(code);
      t.ev.write('pin-tries.json', { admit: adm && adm.out, tries: tries.map(r => r.out), first, right: right.out, after });
      t.check('each of 5 wrong PINs is refused (the first at the link\'s hello, after the admit)', !!adm && tries.every(r => !r.linked) && tries.slice(1).every(r => /wrong PIN|burn/i.test(r.out || '')),
        [first.reason, ...tries.slice(1).map(r => r.out)].map(x => String(x || '').slice(0, 60)).join(' | '));
      t.check('the right PIN after 5 wrong ones is refused: the invite burned', !right.linked && /burn|used|expired|unknown|too many/i.test(right.out || ''), (right.out || '').slice(0, 160));
      const hl = host.dump(code).entries.filter(e => e.kind === 'status' && /PIN|burn/i.test(e.text || '')).map(e => e.text);
      t.check('the host\'s room shows the wrong PINs and the burn', hl.some(x => /burn/i.test(x)), hl.slice(-2).join(' | ').slice(0, 200));
    } else t.pending('a wrong PIN 5x burns the invite', 'needs sh2Pin');

    // revoke (1.0): the person on the host, /sub-human revoke bob
    if (t.features.revoke) {
      const r = host.expand('alice', 'revoke bob');
      t.ev.write('revoke.json', r);
      const keys = lab.exec('devbox', ['cat', '/home/host/.ssh/authorized_keys'], { allowFail: true }).stdout;
      t.check('/sub-human revoke bob removes the link\'s authorized_keys line', /revoked link/.test(r.out || '') && !!a.linkId && !keys.includes(a.linkId), (r.out || '').slice(0, 160));
      const gone = await t.until(() => !lab.exec('devbox', ['sh', '-c', `pgrep -f '[s]erve --stdio ${code} --link ${a.linkId}' || true`]).stdout.trim(), 10_000, 300);
      t.check("revoke stops that link's serve", gone, gone ? 'none running' : 'still running');
      const st = await waitState(a.seat, code, ['stopped'], 20_000);
      const post = a.seat.say('bob', 'after revoke');
      const ls = a.seat.link(code);
      t.check("bob's link stops (AUTH, it does not redial) and his post is refused, not queued", st !== null && ls.code === 'AUTH' && !post.ok,
        `${ls.state} ${ls.code || ''}: ${(ls.reason || '').slice(0, 80)}; post: ${(post.out || '').slice(0, 80)}`);
      const bea = b.seat.say('bea', 'bea after revoke of bob');
      t.check("bea's link is untouched by bob's revoke", bea.ok, bea.out || 'posted');
    } else t.pending('revoke LINK removes the key, stops its serve and cuts the link', 'needs revoke');
  },
};
