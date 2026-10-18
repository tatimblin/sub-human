// Invite lines (protocol 3: a 128-bit SECRET in the line, a 4-digit PIN told apart and checked online) with the host
// person's card, on real sshd and the web. Not run since Stage 7b (no Docker where it was written): run it before a
// release.
//   ssh   alice's `/sub-human invite --ssh host@devbox` shows one line and the PIN apart, and writes nothing to
//         authorized_keys; bob on joiner-a, whose own ssh key the devbox account takes as an ordinary login, types the
//         line (his link checks the host's machine key against it, then shows the SECRET; with no PIN it knocks), then
//         the PIN: a wrong one costs a try, the right one lets him in with no card; the link comes online; a bare
//         /sub-human seats him; posts flow; authorized_keys holds only the login lines people set up
//   web   `/sub-human invite --web` (the devbox's SUB_HUMAN_WEB_FRONT: https://tls-front) shows a URL#SECRET and the
//         PIN apart; ben on joiner-b, through the TLS front (the listener's key checked against the line, Noise XK with
//         a key of his link's own), types the line alone: it knocks, and alice's card lets him in; the front's log
//         holds neither the PIN nor the SECRET
// A stranger with no login of their own, a stolen line without its PIN and PIN guessing are the unit tests' (test/
// remote-invite-ssh, remote-invite-line, remote-short): this scenario marks them pending.
import { WAN, delivered, waitState, converge, wssHost } from './_lib.ts';
import type { T } from '../lab.ts';

const AK = '/home/host/.ssh/authorized_keys';
const LAB_CA_ENV = { NODE_EXTRA_CA_CERTS: '/etc/lab-ca.crt' };
const LINE_RE = /\/sub-human (join ([^\s#]+)(?: ([a-z]+-\d{4}))?[ #]([0-9a-z]{39})(?: --home \S+)?)\n/; // a web line's SECRET: its URL's fragment
const PIN_RE = /apart from the line[^\n]*: (\d{4})\n/;

export const id = 'short';
export const title = 'invite lines: a SECRET and a PIN told apart, over ssh (the joiner\'s own login) and the web; the right PIN lets in, a knock asks the host person\'s card';
export const persona = 'P1 friends';
export const requires = ['inviteLine'];
export const budgetMs = 240_000;
export async function run(t: T): Promise<void> {
  const { lab } = t;
  const { code, host } = lab.hostRoom();
  const ak = () => lab.exec('devbox', ['sh', '-c', `cat ${AK} 2>/dev/null || true`]).stdout;

  // ---- ssh ----
  const shown = host.expand('alice', 'invite --ssh host@devbox');
  const m = LINE_RE.exec(`${shown.out}\n`), p = PIN_RE.exec(`${shown.out}\n`);
  if (m) t.ev.invite(m[1], p && p[1]); // before anything is logged: the evidence redacts them
  if (!t.check('invite --ssh shows one line (/sub-human join host@devbox CODE SECRET, no NAME) and the PIN apart, hidden from the model', !!m && !!p && m[2] === 'host@devbox' && m[3] === code
    && shown.json && shown.json.hookSpecificOutput && shown.json.hookSpecificOutput.suppressOriginalPrompt === true && !shown.json.systemMessage, (shown.out || '').slice(0, 200)) || !m || !p) return;
  t.check('nothing of sub-human\'s in authorized_keys: no door, no line', !/sub-human/.test(ak()), `${ak().split('\n').filter(Boolean).length} line(s)`);
  const [, line = '', , , secret = ''] = m, [, pin = ''] = p; // LINE_RE's groups 1 and 4 and PIN_RE's 1 always match
  const pub = lab.keypair('joiner-a', 'id_bob');
  lab.authorizeLogin(pub); // bob's own login to the devbox account, as ssh-copy-id would set it up
  const conf = lab.sshConfig('joiner-a', 'bob', 'id_bob', WAN);
  const seat = lab.seat('joiner-a');
  const typed = seat.short('bob', line, '-F', conf);
  const knocked = typed.knocked || await t.until(() => !!seat.linkfile(code).awaiting, 20_000, 250);
  t.check('the line: the host\'s key checked, the SECRET shown; with no PIN it knocks (the host\'s card waits), in a hidden step', knocked && typed.hidden, (typed.out || '').slice(0, 200));
  const wrong = String((Number(pin) + 1) % 10_000).padStart(4, '0');
  const w = seat.pin('bob', wrong);
  t.check('a wrong PIN: refused with the tries left, in a hidden step', !w.ok && w.hidden && /wrong PIN \(4 tries left\)/.test(w.out), (w.out || '').slice(0, 200));
  await t.sleep(4500); // this machine's wait after a wrong PIN
  const j = seat.pin('bob', pin);
  if (!t.check('the right PIN: the host checked it over real sshd and let bob in (no card)', j.linked && j.hidden, (j.out || '').slice(0, 300))) return;
  const lf = seat.linkfile(code);
  t.check('bob\'s link is a login link (his ssh decides: no key or known_hosts of the plugin\'s); the PIN left the file', lf.transport && lf.transport.login === true && !lf.transport.key && !lf.transport.knownHosts && !lf.pin, JSON.stringify(lf.transport));
  const online = await waitState(seat, code, 'online', 40_000);
  t.check('bob\'s link comes online once let in', online !== null, `${online} ms`);
  const rj = seat.expand('bob', '');
  t.check('bob takes his seat with a bare /sub-human', rj.ok, rj.out);
  const a = seat.say('bob', 'invite hello from bob');
  const d1 = await delivered(host, 'alice', 'invite hello from bob', 8000);
  t.check('posts flow from bob', a.ok && d1.ok);
  t.check('authorized_keys still holds only the login lines people set up', !/sub-human/.test(ak()));

  // ---- web, through the TLS front ----
  await wssHost(t, lab);
  const ws = host.expand('alice', 'invite --web');
  const wm = LINE_RE.exec(`${ws.out}\n`), wp = PIN_RE.exec(`${ws.out}\n`);
  if (wm) t.ev.invite(wm[1], wp && wp[1]);
  if (!t.check('invite --web shows URL#SECRET (the SECRET as the URL\'s fragment) and the PIN apart', !!wm && !!wp && wm[2] === `https://tls-front/sub-human/${code}` && (wm[1] ?? '').includes('#'), (ws.out || '').slice(0, 200)) || !wm || !wp) return;
  const ben = lab.seat('joiner-b', { env: LAB_CA_ENV });
  const [, webLine = '', , , webSecret = ''] = wm, [, webPin = ''] = wp;
  // ben types the line alone: it knocks, inside the Noise channel, and alice's card decides
  const bt = ben.short('ben', webLine);
  const bknocked = bt.knocked || await t.until(() => !!ben.linkfile(code).awaiting, 30_000, 250);
  t.check('ben (joiner-b, through tls-front): the listener\'s key checked against the line; with no PIN it knocks', bknocked && bt.hidden, (bt.out || '').slice(0, 200));
  await t.sleep(1500);
  t.check('nothing gets in before the card: ben\'s link is not online', ben.link(code).state !== 'online', ben.link(code).state);
  const bc = host.admitcard('alice', 'Let in');
  t.check('alice\'s card names ben and his machine\'s check; her Let in admits him', bc.ok && /^Let ben \(check [0-9a-f]{4}-[0-9a-f]{4}\) on \S+ join room /.test(bc.question || ''), bc.out);
  const bon = await waitState(ben, code, 'online', 40_000);
  t.check('ben\'s link comes online (XK, bound to his key)', bon !== null, `${bon} ms`);
  if (bon !== null) {
    t.check('ben takes his seat', ben.expand('ben', '').ok);
    const c = await converge(t, host, code, [seat, ben]);
    t.check('mirrors byte-identical to the host log', c.ok, c.detail);
  }
  const caddy = lab.composeLogs('tls-front').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z?/g, '');
  t.check('the TLS front\'s log holds neither PIN nor SECRET', !new RegExp(`\\b(${webPin}|${pin})\\b`).test(caddy) && !caddy.includes(webSecret) && !caddy.includes(secret));
  t.pending('a stranger, a stolen line without its PIN, PIN guessing', 'covered by test/remote-invite-ssh, remote-invite-line and remote-short (not driven from the lab)');
}
