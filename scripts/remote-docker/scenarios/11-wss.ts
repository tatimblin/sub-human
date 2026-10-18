// 1.1 wss: the host listens on 127.0.0.1:$LAB_WS_PORT (7420) in the devbox; tls-front plays Tailscale Serve/Funnel.
// bob (joiner-a) types the line `/sub-human invite --web` shows (the devbox's SUB_HUMAN_WEB_FRONT names tls-front,
// honoured under SUB_HUMAN_LAB=1), `/sub-human join https://tls-front/sub-human/CODE#SECRET --as bob`: with no PIN
// it knocks, then bob types the PIN (a wrong one first), which lets him in with no card; ben (joiner-b) types the line
// alone and alice's card lets him in. The listener's key is checked against the line, then Noise XK with a key of the
// link's own, and a bare /sub-human seats them. Posts flow,
// mirrors converge, a wrong PIN is refused, and Caddy (the stand-in for Tailscale) sees only ciphertext: no PIN, SECRET
// or post in its log. (Not run since Stage 7b.)
// LAB_WS_LISTEN_CMD overrides the host's listener (default "listen --port {port}"), run detached as host on devbox.
import { delivered, converge, waitState } from './_lib.ts';
import type { SeatDriver, T } from '../lab.ts';

const WS_PORT = Number(process.env.LAB_WS_PORT || 7420);
const LINE_RE = /\/sub-human (join https:\/\/tls-front\/[^\s#]+#([0-9a-z]{39}))\n/;
const PIN_RE = /apart from the line[^\n]*: (\d{4})\n/;

function mint(t: T, host: SeatDriver): { line: string | undefined, pin: string, out: string } {
  const r = host.expand('alice', 'invite --web');
  const out = (r.json && r.json.reason) || JSON.stringify(r.json || {}); // the block reason: the person's text
  const m = LINE_RE.exec(`${out}\n`) || [];
  const p = PIN_RE.exec(`${out}\n`) || [];
  if (m[1]) t.ev.invite(m[1], p[1]);
  return { line: m[1], pin: p[1] || '', out };
}

export const id = 'wss';
export const title = '1.1: join by the https://tls-front/...#SECRET line: its PIN lets bob in (no card); ben knocks and the card lets him in';
export const persona = 'P1 friends (1.1)';
export const requires = ['ws', 'urlPin'];
export const budgetMs = 120_000;
export async function run(t: T): Promise<void> {
  const { lab, sleep } = t;
  const { code, host } = lab.hostRoom();
  const listen = (process.env.LAB_WS_LISTEN_CMD || 'listen --port {port}').replace('{port}', String(WS_PORT)).split(' ');
  lab.dc(['exec', '-d', '-u', 'host', '-e', 'SUB_HUMAN_HOME=/home/host/.sub-human', 'devbox', 'node', '/plugin/scripts/sub-human', ...listen], { allowFail: true });
  await sleep(1500);
  const ln = lab.exec('devbox', ['sh', '-c', `ss -ltn | grep ':${WS_PORT} ' || true`]).stdout.trim();
  t.check(`the host listens on 127.0.0.1:${WS_PORT} only`, /127\.0\.0\.1:/.test(ln), ln || 'nothing listening');

  const env = { NODE_EXTRA_CA_CERTS: '/etc/lab-ca.crt' };
  const joins: { seat: SeatDriver, name: string }[] = [];
  const machines: [string, string][] = [['joiner-a', 'bob'], ['joiner-b', 'ben']];
  for (const [svc, name] of machines) {
    const inv = mint(t, host);
    const line = inv.line ?? '';
    if (!t.check(`the host mints a URL#SECRET line and a PIN apart for ${name} (no NAME)`, line && inv.pin.length === 4, inv.out.slice(0, 160))) continue;
    const seat = lab.seat(svc, { env });
    const typed = seat.short(name, line);
    // the line with no PIN knocks: the host's card waits
    const knocked = typed.knocked || await t.until(() => !!seat.linkfile(code).awaiting, 45_000, 250);
    t.check(`${name}: the listener's key matches the line; with no PIN it knocks (alice's card asks)`, knocked && typed.hidden, (typed.out || '').slice(0, 120));
    if (name === 'bob') {
      // bob types the PIN while the card waits: a wrong one is refused, the right one lets him in with no card
      const bad = seat.pin(name, String((Number(inv.pin) + 1) % 1e4).padStart(4, '0'));
      t.check(`${name}: a wrong PIN is refused, in a hidden step`, !bad.ok && bad.hidden && /wrong PIN/.test(bad.out || ''), (bad.out || '').slice(0, 120));
      await sleep(4500); // this machine's wait after a wrong PIN
      const l = seat.pin(name, inv.pin);
      t.check(`${name}'s PIN holds over wss and lets him in (no card)`, l.linked && l.hidden, (l.out || '').slice(0, 160));
    } else {
      // ben has no PIN: alice's card lets him in
      const card = host.admitcard('alice', 'Let in');
      t.check(`alice lets ${name} in on the card (the knock's)`, card.ok && /^Let ben \(check [0-9a-f]{4}-[0-9a-f]{4}\) on \S+ join room /.test(card.question || ''), (card.out || '').slice(0, 120));
    }
    const up = await waitState(seat, code, 'online', 45_000);
    t.check(`${name}'s link comes online (Noise XK, bound to his link's own key)`, up !== null, `${up} ms`);
    const j = seat.expand(name, '');
    t.check(`${name} takes the seat with a bare /sub-human`, j.ok, j.out || `${j.ms} ms`);
    if (j.ok) joins.push({ seat, name });
  }
  for (const { seat, name } of joins) {
    const s = seat.say(name, `wss from ${name}`);
    const d = await delivered(host, 'alice', `wss from ${name}`, 8000);
    const h = host.say('alice', `wss to ${name}`);
    const d2 = await delivered(seat, name, `wss to ${name}`, 8000);
    t.check(`${name} <-> alice posts both ways over wss`, s.ok && d.ok && h.ok && d2.ok);
  }
  if (joins.length) {
    const c = await converge(t, host, code, joins.map(j => j.seat));
    t.check('mirrors byte-identical, chains verify', c.ok, c.detail);
  }
  const caddy = lab.composeLogs('tls-front');
  t.ev.write('tls-front.txt', caddy);
  t.check('the TLS front logged no post text (it carries Noise ciphertext only)', !/wss (from|to) b/.test(caddy));
}
