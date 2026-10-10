'use strict';
/**
 * scripts/remote-docker/scenarios/_lib.js: helpers the scenarios share (not a scenario: the runner loads NN-*.js).
 *
 *   WAN / JUMP / PROXY / CORE(host)   ssh Host blocks for lab.joinOver: the devbox through toxiproxy (the WAN path),
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
 *   wssJoin(t, lab, host, code, svc, name, {proxy?}) -> {seat, name, ok, out}   (1.1) alice mints a join URL + PIN for
 *                                     https://tls-front (`/sub-human host --url`), NAME links with it (joiner-b through
 *                                     corp-proxy: proxy) and takes the seat
 */
const WAN = { devbox: { HostName: 'toxiproxy', Port: 22001 }, 'devbox-old': { HostName: 'toxiproxy', Port: 22003 } };
const JUMP = { bastion: { User: 'jump' }, devbox: { ProxyJump: 'jump@bastion' }, 'devbox-old': { ProxyJump: 'jump@bastion' }, 'joiner-a': { ProxyJump: 'jump@bastion' } };
const PROXY = {
  devbox: { HostName: 'toxiproxy', Port: 22001, ProxyCommand: 'nc -X connect -x corp-proxy:3128 %h %p' },
  'devbox-old': { HostName: 'toxiproxy', Port: 22003, ProxyCommand: 'nc -X connect -x corp-proxy:3128 %h %p' },
};
const CORE = { devbox: {}, 'devbox-old': {} };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const entries = log => String(log || '').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { bad: l }; } });

async function delivered(seat, name, text, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const { events } = seat.events(name);
    const hit = events.find(e => e.ev && JSON.stringify(e.ev).includes(text));
    if (hit) return { ok: true, t: hit.t };
    if (Date.now() > end) return { ok: false, t: null };
    await sleep(100);
  }
}

function linkState(seat, code) { try { return seat.link(code).state || 'none'; } catch { return 'error'; } }

async function waitState(seat, code, states, ms) {
  const want = [].concat(states);
  const t0 = Date.now();
  for (;;) {
    if (want.includes(linkState(seat, code))) return Date.now() - t0;
    if (Date.now() - t0 > ms) return null;
    await sleep(200);
  }
}

async function converge(t, host, code, mirrors, ms = 20_000) {
  const end = Date.now() + ms;
  let h, ms_ = [];
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
  ms_.forEach((m, i) => t.log(`mirror ${mirrors[i].svc}${mirrors[i].home.endsWith('.sub-human') ? '' : ` (${mirrors[i].home})`} sha256 ${t.sha(m.log)} ${m.log === h.log ? '= host' : `!= host (${entries(m.log).length} lines)`}, chain ${JSON.stringify(m.chain)}, link ${m.link && m.link.state}`));
  t.ev.write(`log-host-${host.svc}.jsonl`, h.log);
  ms_.forEach((m, i) => t.ev.write(`log-mirror-${mirrors[i].svc}-${i}.jsonl`, m.log));
  return { ok: same && chains && noGap && !dupLines && !dupNonces, host: h, mirrors: ms_, detail: `byte-identical ${same}, chains ${chains}, no gap ${noGap}, dup lines ${dupLines}, dup nonces ${dupNonces}, ${ids.length} lines` };
}

const WS_PORT = Number(process.env.LAB_WS_PORT || 7420);
const JOIN_URL_RE = /https:\/\/tls-front\/[A-Za-z0-9/_-]+#[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
const LAB_CA_ENV = { NODE_EXTRA_CA_CERTS: '/etc/lab-ca.crt' };
const CORP_PROXY = 'http://corp-proxy:3128';

async function wssHost(t, lab) {
  const listen = (process.env.LAB_WS_LISTEN_CMD || 'listen --port {port}').replace('{port}', String(WS_PORT)).split(' ');
  lab.dc(['exec', '-d', '-u', 'host', '-e', 'SUB_HUMAN_HOME=/home/host/.sub-human', 'devbox', 'node', '/plugin/scripts/sub-human', ...listen], { allowFail: true });
  await sleep(1500);
  return WS_PORT;
}

function wssJoin(t, lab, host, code, svc, name, { proxy = false } = {}) {
  const r = host.expand('alice', `host --url https://tls-front${lab.features.shortCode ? ' --long' : ''}`);
  const text = (r.json && r.json.reason) || '';
  const url = (JOIN_URL_RE.exec(text) || [])[0];
  const pin = (/\bPIN (\d{6})\b/.exec(text) || [])[1];
  if (!url || !pin) return { ok: false, out: text.slice(0, 200) };
  t.ev.secret(url.split('#')[1].split('.')[0]);
  const seat = lab.seat(svc, { env: { ...LAB_CA_ENV, ...(proxy ? { HTTPS_PROXY: CORP_PROXY, https_proxy: CORP_PROXY } : {}) } });
  const l = seat.join(name, `${url} ${pin}`);
  if (!/linked to room/.test(l.out || '')) return { seat, name, ok: false, out: l.out };
  const j = seat.rejoin(name, code);
  return { seat, name, ok: j.ok, out: j.out };
}

module.exports = { WAN, JUMP, PROXY, CORE, sleep, entries, delivered, linkState, waitState, converge, wssHost, wssJoin, WS_PORT };
