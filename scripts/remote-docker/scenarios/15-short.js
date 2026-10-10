'use strict';
// Invites (a 4-digit PIN over CPace, lib/remote/enroll.ts) with the host person's card, on real sshd:
//   ssh   alice's `/sub-human invite --ssh host@devbox` writes the enrollment door into authorized_keys and shows one
//         line; bob on joiner-a types a wrong PIN (4 tries left), then the right one: his link runs the PAKE through
//         the door over the WAN path, checks the host key sshd showed against the one vouched for inside it, makes its
//         own key, and waits; the door line is gone; alice's tail wakes her Claude and her card's Let in writes bob's
//         key as a one-link forced command; the link comes online; a bare /sub-human seats him; posts flow
//   web   `/sub-human invite --url https://tls-front` shows a URL and a PIN (no #secret); ben on joiner-b, through
//         corp-proxy and the TLS front, joins the same way; the card lets him in
//   door  mallory on joiner-b (only the bastion and the proxy reach out) knows the room, so the public enrollment key,
//         but not the PIN: through the door no shell, no pty, no forwarding; 5 guesses burn the invite and the door
//         closes; then the right PIN gets nowhere either
const { WAN, JUMP, delivered, waitState, converge, wssHost } = require('./_lib.js');

const AK = '/home/host/.ssh/authorized_keys';
const LAB_CA_ENV = { NODE_EXTRA_CA_CERTS: '/etc/lab-ca.crt' };
const CORP_PROXY = 'http://corp-proxy:3128';
const LINE_RE = /\/sub-human join (\S+) (?:([a-z]+-\d{4}) )?(\d{4})\n/;

module.exports = {
  id: 'short',
  title: 'invites: a 4-digit PIN over ssh (the enrollment door) and the web, the host person\'s card admits; an attacker at the door burns the invite and nothing more',
  persona: 'P1 friends / P2 corporate',
  requires: ['shortCode'],
  budgetMs: 300_000,
  async run(t) {
    const { lab } = t;
    const { code, host } = lab.hostRoom();
    const door = () => lab.exec('devbox', ['sh', '-c', `cat ${AK} 2>/dev/null || true`]).stdout.split('\n').filter(l => l.endsWith(` sub-human-enroll:${code}`));

    // ---- ssh ----
    const shown = host.expand('alice', 'invite --ssh host@devbox');
    const m = LINE_RE.exec(`${shown.out}\n`);
    if (m) t.ev.invite(null, m[3]); // before anything is logged: the evidence redacts it
    if (!t.check('invite --ssh shows one line: /sub-human join host@devbox CODE 4-digit-PIN (no NAME), hidden from the model', !!m && m[1] === 'host@devbox' && m[2] === code
      && shown.json && shown.json.hookSpecificOutput && shown.json.hookSpecificOutput.suppressOriginalPrompt === true && !shown.json.systemMessage, (shown.out || '').slice(0, 200))) return;
    const pin = m[3];
    t.ev.invite(null, pin);
    t.check('the enrollment door is in authorized_keys while the invite is open: the room\'s key, forced to serve --enroll, restrict',
      door().length === 1 && new RegExp(`^command="SUB_HUMAN_HOME=\\S+ \\S+/bin/serve --enroll ${code} --kind ssh",restrict ssh-ed25519 `).test(door()[0]), door()[0]);

    lab.keypair('joiner-a', 'id_bob'); // the config names it; the host never lets it in
    const conf = lab.sshConfig('joiner-a', 'bob', 'id_bob', WAN);
    const seat = lab.seat('joiner-a');
    const wrong = String((Number(pin) + 1) % 10_000).padStart(4, '0');
    const w = seat.short('bob', 'host@devbox', code, wrong, '-F', conf);
    t.log(`wrong PIN: ${w.out}`);
    t.check('a wrong PIN: refused with the tries left, in a hidden step', !w.ok && w.hidden && /wrong PIN \(4 tries left\)/.test(w.out), w.out.slice(0, 200));
    const j = seat.short('bob', 'host@devbox', code, pin, '-F', conf);
    t.log(`join (${j.ms} ms): ${j.out}`);
    if (!t.check('the right PIN: the host checked it over real sshd; bob waits for the card, which names his key', j.waiting && j.hidden && /let you in as bob \(SHA256:/.test(j.out), j.out.slice(0, 300))) return;
    t.check('the door closed once no invite is open', door().length === 0, `${door().length} line(s)`);
    const lf = JSON.parse(lab.exec('joiner-a', ['cat', `${seat.home}/links/${code}.json`], { user: 'joiner' }).stdout);
    const hk = lab.exec('devbox', ['cat', '/etc/ssh/ssh_host_ed25519_key.pub']).stdout.trim().split(/\s+/).slice(0, 2).join(' ');
    const pinned = lab.exec('joiner-a', ['cat', lf.transport.knownHosts], { user: 'joiner' }).stdout.trim();
    t.check('bob pinned devbox\'s real Ed25519 host key, vouched for inside the PAKE', pinned === `sub-human-${code} ${hk}`, pinned);
    t.check('the PIN left bob\'s link file once the host answered', !lf.enroll && !JSON.stringify(lf).includes(`"${pin}"`));
    await t.sleep(1500);
    t.check('nothing gets in before the card: bob\'s link is not online', seat.link(code).state !== 'online', seat.link(code).state);
    const woke = (host.events('alice').events || []).some(e => /AskUserQuestion with the question \\?"admit [0-9a-f]{12}/.test(JSON.stringify(e.ev)));
    t.check('the host\'s tail woke alice\'s Claude to open the card', woke);
    const card = host.admitcard('alice', 'Let in');
    t.log(`card: ${card.question} -> ${card.out}`);
    t.check('alice\'s card names bob and his key\'s fingerprint; her Let in admits him', card.ok && /^Let bob \(SHA256:\S+\) on \S+ join room /.test(card.question || ''), card.out);
    const keyLine = lab.exec('devbox', ['sh', '-c', `grep -F "sub-human:${code}:" ${AK} || true`]).stdout.trim();
    t.check('his key\'s line is the one-link forced command (restrict)', new RegExp(`^command="SUB_HUMAN_HOME=\\S+ \\S+/bin/serve --stdio ${code} --link [0-9a-f]{12}",restrict ssh-ed25519 `).test(keyLine), keyLine);
    const online = await waitState(seat, code, 'online', 40_000);
    t.check('bob\'s link comes online once let in', online !== null, `${online} ms`);
    const rj = seat.expand('bob', '');
    t.check('bob takes his seat with a bare /sub-human', rj.ok, rj.out);
    const a = seat.say('bob', 'short hello from bob');
    const d1 = await delivered(host, 'alice', 'short hello from bob', 8000);
    t.check('posts flow from bob', a.ok && d1.ok);

    // ---- web, through corp-proxy and the TLS front ----
    await wssHost(t, lab);
    const ws = host.expand('alice', 'invite --url https://tls-front');
    const wm = LINE_RE.exec(`${ws.out}\n`);
    if (wm) t.ev.invite(null, wm[3]);
    if (!t.check('invite --url shows a URL with no #secret and a 4-digit PIN', !!wm && wm[1] === `https://tls-front/sub-human/${code}` && !/#/.test(ws.out), (ws.out || '').slice(0, 200))) return;
    t.ev.invite(null, wm[3]);
    const ben = lab.seat('joiner-b', { env: { ...LAB_CA_ENV, HTTPS_PROXY: CORP_PROXY, https_proxy: CORP_PROXY } });
    const bj = ben.short('ben', wm[1], '-', wm[3]);
    t.log(`ben (${bj.ms} ms): ${bj.out}`);
    t.check('ben (joiner-b, through corp-proxy and tls-front) has the PIN checked inside the WebSocket', bj.waiting && bj.hidden, bj.out.slice(0, 200));
    const bc = host.admitcard('alice', 'Let in');
    t.check('alice lets ben in on the card', bc.ok, bc.out);
    const bon = await waitState(ben, code, 'online', 40_000);
    t.check('ben\'s link comes online (Noise_NK pinned to the vouched listener key)', bon !== null, `${bon} ms`);
    if (bon !== null) {
      t.check('ben takes his seat', ben.expand('ben', '').ok);
      const c = await converge(t, host, code, [seat, ben]);
      t.check('mirrors byte-identical to the host log', c.ok, c.detail);
    }
    const caddy = lab.composeLogs('tls-front');
    t.check('the TLS front\'s log holds no PIN', !new RegExp(`\\b(${wm[3]}|${pin})\\b`).test(caddy.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z?/g, '')));

    // ---- an attacker at the door ----
    const s3 = host.expand('alice', 'invite --ssh host@devbox');
    const m3 = LINE_RE.exec(`${s3.out}\n`);
    t.ev.invite(null, m3 && m3[3]);
    const pub = lab.keypair('joiner-b', 'id_mallory');
    lab.trustOnBastion(pub); // an insider's way through the bastion, nothing on the devbox
    const mconf = lab.sshConfig('joiner-b', 'mallory', 'id_mallory', JUMP);
    const r = lab.exec('joiner-b', ['node', '/lab/attack.js', code, mconf, m3 ? m3[3] : ''], { user: 'joiner', allowFail: true, timeout: 240_000 });
    let res = {};
    try { res = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { res = { error: r.stdout + r.stderr }; }
    t.ev.write('attack.json', JSON.stringify(res, null, 2));
    t.log(`attack: ${JSON.stringify(res).slice(0, 600)}`);
    const noShell = x => x && !/SHELL-OK|uid=/.test(x.out + x.err);
    t.check('through the public enrollment key: no shell (the forced command answers instead)', noShell(res.shell), JSON.stringify(res.shell));
    t.check('no pty', noShell(res.pty) && /PTY allocation request failed|not a terminal|pty/i.test((res.pty && res.pty.err) || '') || noShell(res.pty), JSON.stringify(res.pty));
    t.check('no forwarding', res.forward && res.forward.status !== 0 && !/SSH-2\.0/.test(res.forward.out), JSON.stringify(res.forward));
    const g = res.guesses || [];
    t.check('5 guesses: each refused with the tries left, the fifth burns the invite',
      g.length === 6 && g.slice(0, 4).every((x, i) => x.code === 'AUTH' && new RegExp(`wrong PIN \\(${4 - i} tr`).test(x.message)) && /last try: this invite no longer works/.test(g[4].message), JSON.stringify(g.map(x => x.message)));
    t.check('a sixth attempt finds the door shut (or no invite open)', g[5] && !g[5].ok && /Permission denied|no invite for room|closed the enrollment/.test(g[5].message), g[5] && g[5].message);
    t.check('the door line is gone after the burn', door().length === 0, `${door().length} line(s)`);
    const carol = lab.seat('joiner-a', { home: '.sub-human-carol' });
    const late = carol.short('carol', 'host@devbox', code, m3 ? m3[3] : '0000', '-F', conf);
    t.check('the right PIN after the burn gets nowhere: the door is shut, said at once', !late.ok && /the invite to room \S+ no longer works/.test(late.out), late.out.slice(0, 200));
    const lines = host.dump(code).entries.filter(e => e.from === 'room').map(e => e.text).join('\n');
    t.check('the room heard each wrong PIN, and never a PIN', /wrong PIN for an invite to this room/.test(lines) && !lines.includes(` ${pin}`) && !(m3 && lines.includes(` ${m3[3]}`)));
  },
};
