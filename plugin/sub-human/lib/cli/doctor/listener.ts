/**
 * plugin/sub-human/lib/cli/doctor/listener.ts: doctor's web listener checks (lib/cli/doctor.ts): the host's listener
 * (lib/remote/listener.ts status, <home>/listen/state.json) and each room it serves.
 *
 *   checkListener({quick?}) -> [Check]   listener: running, its pid and port, the rooms it serves; a room served with no
 *       listener running is a failure. web:CODE per room: a room that closed (warn); with Tailscale, unless --quick, that
 *       `tailscale serve status --json` still lists its path (fail when gone), and with Funnel the certificate-
 *       transparency warning (warn: the name is public)
 *   webRooms() -> [code];  webHosts() -> [hostname]   what the bundle's redaction hashes
 */
import { spawnSync } from 'node:child_process';
import { lib, cli, check, tilde } from './check.ts';
import type { Check } from '../types.ts';
import { msgOf } from '../../errors.ts';
import type * as ListenerMod from '../../remote/listener.ts';

type ListenerStatus = ListenerMod.ListenStatus;

/** The host's web listener and the rooms it serves (lib/remote/listener.ts), with their Tailscale paths. */
function checkListener({ quick = false }: { quick?: boolean } = {}): Check[] {
  let st: ListenerStatus;
  try { st = lib('remote/listener.ts').status(); } catch (e) { return [check({ id: 'listener', status: 'warn', title: 'listener', detail: `could not read its state: ${msgOf(e)}` })]; }
  const codes = Object.keys(st.rooms || {});
  if (!codes.length && !st.running) return [check({ id: 'listener', status: 'info', title: 'listener', detail: 'no room is served over the web here (/sub-human invite --web starts it)' })];
  const out = [st.running
    ? check({ id: 'listener', status: 'pass', title: 'listener', detail: `running (pid ${st.pid}) on 127.0.0.1:${st.port} · ${codes.length ? `serves ${codes.join(', ')}` : 'serves no room'}${st.conns ? ` · ${st.conns} connection(s)` : ''}` })
    : check({ id: 'listener', status: 'fail', title: 'listener', detail: `not running, but ${codes.join(', ')} ${codes.length === 1 ? 'is' : 'are'} served over the web: joiners cannot reach ${codes.length === 1 ? 'it' : 'them'}`, fix: `/sub-human invite --web again in the room (or ${cli('listen --start')} in a terminal); its log: ${tilde(lib('remote/listener.ts').logFile())}` })];
  const ts = lib('remote/tailscale.ts');
  const serveStatus: Record<string, string | null> = {}; // bin -> stdout
  for (const [code, room] of Object.entries(st.rooms || {})) {
    const rec = room || {};
    const id = `web:${code}`;
    if (!lib('remote/listener.ts').roomLive(code)) { out.push(check({ id, status: 'warn', title: `web ${code}`, detail: 'served over the web, but the room is closed or gone here', fix: `${cli(`invite --stop --room ${code}`)} in a terminal` })); continue; }
    const where = rec.url || rec.path || '?';
    if (!rec.tailscale) { out.push(check({ id, status: 'info', title: `web ${code}`, detail: `through a front of its own at ${where}` })); continue; }
    const kind = rec.tailscale.funnel ? 'funnel' : 'serve';
    if (!quick) {
      const bin = rec.tailscale.bin || ts.bin();
      const key = String(bin); // no tailscale binary: the one entry 'null'
      let text = serveStatus[key];
      if (text === undefined) { // not asked yet (an answer is a string or null)
        const r = bin ? spawnSync(bin, ['serve', 'status', '--json'], { encoding: 'utf8', timeout: 10_000 }) : { status: 1, stdout: '' };
        text = serveStatus[key] = r.status === 0 ? String(r.stdout || '') : null;
      }
      if (text === null) out.push(check({ id, status: 'warn', title: `web ${code}`, detail: `tailscale ${kind} ${rec.tailscale.path}: could not read tailscale serve status`, fix: 'is Tailscale running? tailscale status' }));
      else if (!text.includes(rec.tailscale.path)) {
        out.push(check({ id, status: 'fail', title: `web ${code}`, detail: `tailscale ${kind} has no ${rec.tailscale.path} any more (a reset, or another serve replaced it)`, fix: `/sub-human invite ${rec.tailscale.funnel ? '--public' : '--web'} in the room (it puts the path back)` }));
        continue;
      }
    }
    out.push(rec.tailscale.funnel
      ? check({ id, status: 'warn', title: `web ${code}`, detail: `Tailscale Funnel ${where}${quick ? '' : ' (path present)'}. ${ts.CT_WARNING}`, fix: `/sub-human invite --stop when nobody needs to join from outside the tailnet` })
      : check({ id, status: 'pass', title: `web ${code}`, detail: `Tailscale Serve (tailnet only) ${where}${quick ? '' : ' (path present)'}` }));
  }
  return out;
}


const webRooms = (): string[] => { try { return Object.keys(lib('remote/listener.ts').status().rooms || {}); } catch { return []; } };
/** The hostnames of the rooms this machine serves over the web (a ts.net name is redacted like a link's host). */
function webHosts(): (string | null)[] {
  try {
    const rooms: ListenerStatus['rooms'] = lib('remote/listener.ts').status().rooms || {};
    return Object.values(rooms).map(r => { try { return new URL(r.url ?? '').hostname; } catch { return null; } });
  } catch { return []; }
}

export { checkListener, webRooms, webHosts };
