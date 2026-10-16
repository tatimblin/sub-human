/**
 * scripts/remote-docker/scenarios/_lib.ts: helpers the scenarios share (not a scenario: the runner loads NN-*.ts).
 *
 *   WAN / JUMP / PROXY / CORE(host)   ssh Host blocks for lab.join: the devbox through toxiproxy (the WAN path),
 *                                     through the bastion (ProxyJump), through corp-proxy (ProxyCommand nc -X connect),
 *                                     or straight over the core network
 *   delivered(seat, name, text, ms) -> Promise<{ok, t}>   NAME's tail delivered a line holding text (t: ms epoch)
 *   linkState(seat, code) -> string   the joiner's link daemon state (online, offline, …)
 *   waitState(seat, code, states, ms) -> Promise<ms | null>   time until the link is in one of states
 *   converge(t, host, code, mirrors, ms) -> Promise<{ok, host, mirrors, detail}>   every mirror's log byte-identical to
 *                                     the host's, both chains verify, ids 1..n with no gap, no line twice; logs the
 *                                     sha256 of each and writes the logs to the evidence dir
 *   entries(log) -> [entry]           parse a log.jsonl
 *   wssHost(t, lab, code, host) -> port   (1.1) the host's listener on devbox 127.0.0.1:LAB_WS_PORT (LAB_WS_LISTEN_CMD)
 *   wssJoin(t, lab, host, code, svc, name, {proxy?}) -> Promise<{seat, name, ok, out}>   (1.1) alice mints a URL + SECRET line and a PIN
 *                                     for https://tls-front (`/sub-human invite --url`), NAME types the line (joiner-b
 *                                     through corp-proxy: proxy), alice's card lets them in, a bare /sub-human seats
 */
import type { Dump, Hosts, Lab, LogLine, SeatDriver, T } from '../lab.ts';

/** `sub-human doctor --json`, as far as the scenarios read it. */
export interface DoctorReport {
  checks: { id: string, status: string, detail?: string }[];
  links?: { code: string, moved?: { host?: string, reached?: boolean } | null }[];
}

export const WAN: Hosts = { devbox: { HostName: 'toxiproxy', Port: 22001 }, 'devbox-old': { HostName: 'toxiproxy', Port: 22003 } };
export const JUMP: Hosts = { bastion: { User: 'jump' }, devbox: { ProxyJump: 'jump@bastion' }, 'devbox-old': { ProxyJump: 'jump@bastion' }, 'joiner-a': { ProxyJump: 'jump@bastion' } };
export const PROXY: Hosts = {
  devbox: { HostName: 'toxiproxy', Port: 22001, ProxyCommand: 'nc -X connect -x corp-proxy:3128 %h %p' },
  'devbox-old': { HostName: 'toxiproxy', Port: 22003, ProxyCommand: 'nc -X connect -x corp-proxy:3128 %h %p' },
};
export const CORE: Hosts = { devbox: {}, 'devbox-old': {} };

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
export const entries = (log: unknown): LogLine[] => String(log || '').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { bad: l }; } });

export async function delivered(seat: SeatDriver, name: string, text: string, ms = 5000): Promise<{ ok: true, t: number } | { ok: false, t: null }> {
  const end = Date.now() + ms;
  for (;;) {
    const { events } = seat.events(name);
    const hit = events.find(e => e.ev && JSON.stringify(e.ev).includes(text));
    if (hit) return { ok: true, t: hit.t };
    if (Date.now() > end) return { ok: false, t: null };
    await sleep(100);
  }
}

export function linkState(seat: SeatDriver, code: string): string { try { return seat.link(code).state || 'none'; } catch { return 'error'; } }

export async function waitState(seat: SeatDriver, code: string, states: string | string[], ms: number): Promise<number | null> {
  const want = [states].flat();
  const t0 = Date.now();
  for (;;) {
    if (want.includes(linkState(seat, code))) return Date.now() - t0;
    if (Date.now() - t0 > ms) return null;
    await sleep(200);
  }
}

export async function converge(t: T, host: SeatDriver, code: string, mirrors: SeatDriver[], ms = 20_000): Promise<{ ok: boolean, host: Dump, mirrors: Dump[], detail: string }> {
  const end = Date.now() + ms;
  let h: Dump, ms_: Dump[] = [];
  for (;;) {
    h = host.dump(code);
    ms_ = mirrors.map(m => m.dump(code));
    if (ms_.every(m => m.log === h.log) || Date.now() > end) break;
    await sleep(300);
  }
  const ids = entries(h.log).map(e => e.id);
  const noGap = ids.every((id, i) => id === i + 1);
  const lines = h.log.split('\n').filter(Boolean);
  const dupLines = lines.length - new Set(lines).size;
  const nonces = entries(h.log).map(e => e.nonce).filter(Boolean);
  const dupNonces = nonces.length - new Set(nonces).size;
  const same = ms_.every(m => m.log === h.log);
  const chains = [h, ...ms_].every(d => d.chain && d.chain.ok);
  t.log(`host ${host.svc} log sha256 ${t.sha(h.log)} (${ids.length} lines, ${noGap ? 'ids 1..n no gap' : 'GAP'}, chain ${JSON.stringify(h.chain)})`);
  // ms_ is mirrors.map(dump): one dump per mirror, in order
  const pairs = ms_.flatMap((m, i) => { const s = mirrors[i]; return s ? [{ m, s }] : []; });
  pairs.forEach(({ m, s }) => t.log(`mirror ${s.svc}${s.home.endsWith('.sub-human') ? '' : ` (${s.home})`} sha256 ${t.sha(m.log)} ${m.log === h.log ? '= host' : `!= host (${entries(m.log).length} lines)`}, chain ${JSON.stringify(m.chain)}, link ${m.link && m.link.state}`));
  t.ev.write(`log-host-${host.svc}.jsonl`, h.log);
  pairs.forEach(({ m, s }, i) => t.ev.write(`log-mirror-${s.svc}-${i}.jsonl`, m.log));
  return { ok: same && chains && noGap && !dupLines && !dupNonces, host: h, mirrors: ms_, detail: `byte-identical ${same}, chains ${chains}, no gap ${noGap}, dup lines ${dupLines}, dup nonces ${dupNonces}, ${ids.length} lines` };
}

export const WS_PORT = Number(process.env.LAB_WS_PORT || 7420);
const WEB_LINE_RE = /\/sub-human (join https:\/\/tls-front\/\S+ [0-9a-z]{39})\n/;
const PIN_RE = /apart from the line[^\n]*: (\d{4})\n/;
const LAB_CA_ENV = { NODE_EXTRA_CA_CERTS: '/etc/lab-ca.crt' };
const CORP_PROXY = 'http://corp-proxy:3128';

export async function wssHost(_t: T, lab: Lab): Promise<number> {
  const listen = (process.env.LAB_WS_LISTEN_CMD || 'listen --port {port}').replace('{port}', String(WS_PORT)).split(' ');
  lab.dc(['exec', '-d', '-u', 'host', '-e', 'SUB_HUMAN_HOME=/home/host/.sub-human', 'devbox', 'node', '/plugin/scripts/sub-human', ...listen], { allowFail: true });
  await sleep(1500);
  return WS_PORT;
}

export async function wssJoin(t: T, lab: Lab, host: SeatDriver, code: string, svc: string, name: string, { proxy = false }: { proxy?: boolean } = {}): Promise<{ seat?: SeatDriver, name?: string, ok: boolean, out?: string | null | undefined }> {
  const r = host.expand('alice', 'invite --url https://tls-front');
  const text = (r.json && r.json.reason) || '';
  const m = WEB_LINE_RE.exec(`${text}\n`), p = PIN_RE.exec(`${text}\n`);
  if (!m || !p) return { ok: false, out: text.slice(0, 200) };
  const [, line = ''] = m, [, pin = ''] = p;
  t.ev.invite(line, pin);
  const seat = lab.seat(svc, { env: { ...LAB_CA_ENV, ...(proxy ? { HTTPS_PROXY: CORP_PROXY, https_proxy: CORP_PROXY } : {}) } });
  const typed = seat.short(name, line);
  if (!(typed.asked || await t.until(() => !!seat.linkfile(code).pin_wanted, 45_000, 250))) return { seat, name, ok: false, out: typed.out };
  const l = seat.pin(name, pin);
  if (!l.waiting) return { seat, name, ok: false, out: l.out };
  const card = host.admitcard('alice', 'Let in');
  if (!card.ok) return { seat, name, ok: false, out: `card: ${card.out}` };
  if ((await waitState(seat, code, 'online', 45_000)) === null) return { seat, name, ok: false, out: `not online: ${JSON.stringify(seat.link(code))}` };
  const j = seat.expand(name, '');
  return { seat, name, ok: j.ok, out: j.out };
}

