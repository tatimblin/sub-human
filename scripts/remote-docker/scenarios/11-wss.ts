// 1.1 wss: the host listens on 127.0.0.1:$LAB_WS_PORT (7420) in the devbox; tls-front plays Tailscale Serve/Funnel.
// bob (joiner-a) types the line `/sub-human invite --url https://tls-front` shows, `/sub-human join
// https://tls-front/sub-human/CODE SECRET --as bob`, then the PIN when asked; ben (joiner-b) does the same with
// HTTPS_PROXY=http://corp-proxy:3128 as his only way out. The listener's key is checked against the line, then Noise XK
// with a key of the link's own; alice's card lets each machine in, and a bare /sub-human seats them. Posts flow,
// mirrors converge, a wrong PIN is refused, and Caddy (the stand-in for Tailscale) sees only ciphertext: no PIN, SECRET
// or post in its log. (Not run since Stage 7b.)
// LAB_WS_LISTEN_CMD overrides the host's listener (default "listen --port {port}"), run detached as host on devbox.
import { delivered, converge, waitState } from './_lib.ts';
import type { SeatDriver, T } from '../lab.ts';

const WS_PORT = Number(process.env.LAB_WS_PORT || 7420);
const LINE_RE = /\/sub-human (join https:\/\/tls-front\/\S+ ([0-9a-z]{39}))\n/;
const PIN_RE = /apart from the line[^\n]*: (\d{4})\n/;

function mint(t: T, host: SeatDriver): { line: string | undefined, pin: string, out: string } {
  const r = host.expand('alice', 'invite --url https://tls-front');
  const out = (r.json && r.json.reason) || JSON.stringify(r.json || {}); // the block reason: the person's text
  const m = LINE_RE.exec(`${out}\n`) || [];
  const p = PIN_RE.exec(`${out}\n`) || [];
  if (m[1]) t.ev.invite(m[1], p[1]);
  return { line: m[1], pin: p[1] || '', out };
}

export const id = 'wss';
export const title = '1.1: join by the https://tls-front/... URL + SECRET line and the PIN apart, also through corp-proxy; the card lets each in';
export const persona = 'P1 friends / P2 corporate (1.1)';
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
  const machines: [string, string, Record<string, string>][] = [['joiner-a', 'bob', {}], ['joiner-b', 'ben', { HTTPS_PROXY: 'http://corp-proxy:3128', https_proxy: 'http://corp-proxy:3128' }]];
  for (const [svc, name, extra] of machines) {
    const inv = mint(t, host);
    const line = inv.line ?? '';
    if (!t.check(`the host mints a URL + SECRET line and a PIN apart for ${name} (no NAME, no #)`, line && inv.pin.length === 4 && !/#/.test(line), inv.out.slice(0, 160))) continue;
    const seat = lab.seat(svc, { env: { ...env, ...extra } });
    const typed = seat.short(name, line);
    const asked = typed.asked || await t.until(() => !!seat.linkfile(code).pin_wanted, 45_000, 250);
    t.check(`${name}: the listener's key matches the line; the host asks for the PIN`, asked && typed.hidden, (typed.out || '').slice(0, 120));
    const bad = seat.pin(name, String((Number(inv.pin) + 1) % 1e4).padStart(4, '0'));
    t.check(`${name}: a wrong PIN is refused, in a hidden step`, !bad.ok && bad.hidden && /wrong PIN/.test(bad.out || ''), (bad.out || '').slice(0, 120));
    await sleep(4500); // this machine's wait after a wrong PIN
    const l = seat.pin(name, inv.pin);
    t.check(`${name}'s PIN holds over wss${extra.HTTPS_PROXY ? ' through corp-proxy' : ''}; alice's card asks`, l.waiting && l.hidden, (l.out || '').slice(0, 160));
    const card = host.admitcard('alice', 'Let in');
    t.check(`alice lets ${name} in on the card`, card.ok, (card.out || '').slice(0, 120));
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
  const prox = lab.composeLogs('corp-proxy');
  if (joins.some(j => j.name === 'ben')) t.check('corp-proxy carried ben\'s CONNECT to tls-front:443', /tls-front:443/.test(prox));
}
