/**
 * plugin/sub-human/lib/cli/doctor/links.ts: doctor's checks of this machine's links to rooms hosted elsewhere
 * (lib/cli/doctor.ts), keyed on the typed reasons the link daemon records (lib/reasons.ts; the state file's lastReason),
 * never on an error's words.
 *
 * diagnoseLink: per link, the daemon, its state (lib/room/link-state.ts), the last error and its reason (the state
 * record, else the daemon's log) and, unless --quick, a hello to the host without a credential (the server answers it
 * and nothing else) over the link's real transport: reachable, round trip, protocol versions, the host's clock, and
 * over ssh whether BatchMode works. A dormant link (ROOM_CLOSED, NO_SEAT) is info, and neither a closed room nor a
 * link the host ended is dialed. linkChecks maps each reason to its fix (a spent invite or ended link: a new invite).
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { lib, check, cli, BIN, DOCTOR_HELLO_MS } from './check.ts';
import { sshHint, batchMode } from './ssh.ts';
import type { Check, CheckStatus, HelloReply, HelloProbe, LinkReport, LinkStateView, LinkTransportView, Reach } from '../types.ts';
import type { Link } from '../../room/types.ts';
import type { ProtoRange } from '../../remote/types-core.ts';
import type { LinkSpec, Transport } from '../../remote/types-rest.ts';
import { errCode, msgOf } from '../../errors.ts';
import { REVOKED } from '../../reasons.ts';
import type { RoomCode } from '../../brand.ts';

const SKEW_WARN_MS = 2 * 60 * 1000;
/** The reasons that mean the link's invite or credential is spent: only a new invite helps. */
const SPENT: ReadonlySet<string> = new Set(['INVITE_UNKNOWN', 'INVITE_USED', 'INVITE_BURNT', 'INVITE_EXPIRED', 'PIN_LAST', 'ADMIT_REFUSED',
  'ADMIT_LAPSED', 'ADMIT_REVOKED', 'ADMIT_LATE', ...REVOKED]);

const lastLogError = (code: RoomCode): string[] => {
  let text: string;
  try {
    const file = lib('room/links.ts').logFile(code);
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size, len = Math.min(size, 32 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return []; }
  return text.split('\n').filter(l => /: (offline|stopped|FORK|status|error|plan )/i.test(l) || /\berror\b/i.test(l)).slice(-10);
};


/** The hello a link's daemon would say, without a credential: the server answers it and nothing else. */
function helloProbe(spec: LinkSpec, code: RoomCode, { timeoutMs = DOCTOR_HELLO_MS, env = process.env }: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<HelloProbe> {
  const protocol = lib('remote/protocol.ts');
  let cmd: { argv: string[]; env: NodeJS.ProcessEnv } | undefined;
  try {
    if (spec.kind === 'ssh') {
      const extra = String(lib('env.ts').envStr('SUB_HUMAN_SSH_OPTS', env) || '').split(/\s+/).filter(Boolean);
      cmd = { argv: lib('remote/transports/ssh.ts').command(spec, code, [...extra, '-o', `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`]), env };
    } else if (spec.kind === 'pipe' && typeof spec.home === 'string') {
      cmd = { argv: [process.execPath, BIN, 'serve', '--stdio', code], env: { ...env, SUB_HUMAN_HOME: spec.home } };
    }
  } catch (e) { return Promise.resolve({ ok: false, ms: 0, error: msgOf(e) }); }
  if (!cmd && (spec.kind === 'wss' || spec.kind === 'ws')) return webHelloProbe(spec, code, { timeoutMs });
  if (!cmd) return Promise.resolve({ ok: false, ms: 0, skipped: true, error: `no reachability check for the ${spec.kind} transport` });
  const params = { proto: protocol.PROTO, client: protocol.PLUGIN_VERSION, caps: {}, machine: lib('home.ts').machineId() };
  const [bin, ...argv] = cmd.argv, childEnv = cmd.env;
  return new Promise<HelloProbe>(resolve => {
    const t0 = Date.now();
    let stderr = '', done = false;
    if (bin === undefined) throw new TypeError('the link command is empty'); // never (ssh and pipe commands name a program); spawn threw here too
    const child = spawn(bin, argv, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = (r: Omit<HelloProbe, 'ms'>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.stdin.end(); child.kill(); } catch { /* gone */ }
      resolve({ ms: Date.now() - t0, t0, t1: Date.now(), stderr: stderr.trim().slice(-2000), ...r });
    };
    const timer = setTimeout(() => finish({ ok: false, error: `no answer within ${timeoutMs} ms` }), timeoutMs);
    const dec = protocol.decoder();
    child.stdout.on('data', (chunk: Buffer) => {
      for (const f of dec.push(chunk)) {
        if (f.id !== 1) continue;
        if (f.error) finish({ ok: false, error: `${f.error.code}: ${f.error.message}`, code: f.error.code });
        else finish({ ok: true, reply: f.result as HelloReply }); // the server's JSON, read defensively
      }
    });
    child.stderr.on('data', (d: Buffer) => { stderr += d; });
    child.stdin.on('error', () => { /* the child is gone; its exit says so */ });
    child.on('error', e => finish({ ok: false, error: e.message }));
    child.on('exit', (c, sig) => finish({ ok: false, error: `the ${spec.kind} command exited (${sig || c}) before answering` }));
    child.stdin.write(protocol.encode(protocol.request(1, 'hello', params)));
  });
}

/** A wss/ws link's hello without a credential: the WebSocket, the Noise handshake pinned to the link's key, then hello. */
async function webHelloProbe(spec: LinkSpec, code: RoomCode, { timeoutMs = DOCTOR_HELLO_MS } = {}): Promise<HelloProbe> {
  const t0 = Date.now();
  const protocol = lib('remote/protocol.ts');
  let t: Transport | null = null;
  const deadline = new Promise<never>((_, no) => setTimeout(() => no(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs).unref());
  try {
    // a web link made under protocol 3 proves its own Noise key (XK); the hello alone needs no token
    const own = (spec.kind === 'ws' || spec.kind === 'wss') && spec.clientKey ? lib('remote/link-connect.ts').linkKey(code) : undefined;
    const tr: Transport = await Promise.race([lib('remote/transports/index.ts').open(spec, { code, ...(own ? { clientKey: own } : {}) }), deadline]);
    t = tr;
    const reply = await Promise.race([new Promise<HelloReply | undefined>((ok, no) => {
      tr.onFrame(f => { if (f.id === 1) (f.error ? no(Object.assign(new Error(`${f.error.code}: ${f.error.message}`), { code: f.error.code })) : ok(f.result as HelloReply)); }); // as: the server's JSON, read defensively
      tr.onClose(() => no(new Error('the listener closed before answering')));
      tr.send(protocol.request(1, 'hello', { proto: protocol.PROTO, client: protocol.PLUGIN_VERSION, caps: {}, machine: lib('home.ts').machineId() }));
    }), deadline]);
    return { ok: true, ms: Date.now() - t0, t0, t1: Date.now(), reply };
  } catch (e) {
    const code = errCode(e);
    return { ok: false, ms: Date.now() - t0, error: msgOf(e), ...(code ? { code } : {}) };
  } finally { if (t) t.close(); }
}


/** The host's clock from a hello reply (its `time`, ms), when it carries one. */
const replyTime = (reply: HelloReply | null): number | null => (reply && typeof reply.time === 'number' && Number.isFinite(reply.time) ? reply.time : null);

/**
 * A link that stopped for good with nothing wrong: its room closed, or no seat of this machine is left in it (reasons
 * ROOM_CLOSED, NO_SEAT). Doctor does not dial it and shows it as info.
 */
function dormant(st: LinkStateView): 'closed' | 'no-seat' | null {
  if (st.state !== 'stopped') return null;
  return st.lastReason === 'ROOM_CLOSED' ? 'closed' : st.lastReason === 'NO_SEAT' ? 'no-seat' : null;
}

async function diagnoseLink(code: RoomCode, { quick, timeoutMs, env }: { quick: boolean; timeoutMs: number; env: NodeJS.ProcessEnv }): Promise<LinkReport> {
  const links = lib('room/links.ts');
  const l: Partial<Link> = links.get(code) ?? {};
  const spec: LinkSpec | undefined = l.transport;
  const t: LinkTransportView = spec ?? {}; // what the report shows of it
  let describe = t.kind || '?';
  try { if (spec) describe = lib('remote/transports/index.ts').describe(spec); } catch { /* kind unknown */ }
  let daemon: LinkReport['daemon'] = { running: false };
  try { const s = lib('remote/link-socket.ts').status(code); daemon = { running: !!s.running, pid: s.pid || null }; } catch { /* no mirror */ }
  const st: LinkStateView = lib('room/link-state.ts').read(code) ?? { state: 'offline' };
  if (st.pid) daemon = { running: lib('io.ts').isAlive(st.pid), pid: st.pid }; // the state record's own pid wins
  const recent = lastLogError(code);
  const out: LinkReport = { code, transport: { kind: t.kind, describe, user: t.user, host: t.host, port: t.port, home: t.home, ...(t.login === true ? { login: true } : {}) },
    credential: l.token ? 'token' : l.awaiting ? 'waiting for the host person to let it in' : l.pin_wanted ? 'invite line (the host asks for its PIN)' : l.invite ? 'invite (not redeemed yet)' : t.login === true ? 'ssh login (not linked yet)' : 'none', daemon, state: st, recent };
  const quiet = dormant(st);
  // the mirror's last word: the host stopped the room's Claude (it closed the room) before this link stopped
  try { if (lib('identity.ts').readMembers(code).claude?.stopped_at) out.closed = true; } catch { /* no mirror */ }
  // a link the host ended (kicked: its token gets nowhere) is not dialed: a hello with no credential is answered, and
  // "reachable, speaking v3" read as a healthy link (live)
  const ended = st.state === 'stopped' && !!st.lastReason && REVOKED.has(st.lastReason);
  if (!quick && quiet !== 'closed' && !ended) { // a closed room's host has nothing for it: no hello; a seatless one's may say it closed
    const r: HelloProbe = spec ? await helloProbe(spec, code, { timeoutMs, env }) : { ok: false, ms: 0, skipped: true, error: 'the link file names no transport' };
    const reply: HelloReply = r.reply ?? {};
    const hostTime = replyTime(reply);
    out.reach = {
      ok: r.ok, ms: r.ms, error: r.error, ...(r.code ? { code: r.code } : {}), skipped: !!r.skipped, hint: r.ok ? null : (spec && spec.kind === 'ssh' ? (spec.login === true && lib('remote/transports/ssh.ts').loginFailure(r.stderr ?? '', spec, code)) || sshHint(r.stderr, { code, transport: spec }) : null),
      stderr: r.stderr || '',
      protocol: r.ok ? { v: reply.v, proto: reply.proto ?? null, server: typeof reply.server === 'string' ? reply.server : null } : null,
      skewMs: r.ok && hostTime !== null && r.t0 !== undefined && r.t1 !== undefined ? Math.round(hostTime - (r.t0 + r.t1) / 2) : null, // an answer carries t0 and t1
    };
    if (r.ok && reply.closed === true) out.closed = true;
  }
  return out;
}

function linkChecks(d: LinkReport): Check[] {
  const ls = lib('room/link-state.ts');
  const protocol = lib('remote/protocol.ts');
  const out: Check[] = [];
  const bits: (string | null | undefined)[] = [`${d.transport.describe}`, `daemon ${d.daemon.running ? `running (pid ${d.daemon.pid})` : 'not running'}`, ls.indicator(d.state) || d.state.state];
  if (d.state.rttMs !== undefined) bits.push(`rtt ${d.state.rttMs} ms`);
  const lastLine = d.recent.at(-1);
  const lastError = d.state.lastError || (lastLine !== undefined ? lastLine.replace(/^\S+ sub-human link \S+: /, '') : null);
  const why = d.state.lastReason || null;
  if (lastError && d.state.state !== 'online') bits.push(`last error: ${lastError}`);
  if (d.state.state === 'stopped' && why && REVOKED.has(why)) bits.push('the host ended this machine\'s link: not dialed');
  let status: CheckStatus = d.state.state === 'online' ? 'pass' : d.state.state === 'fork' ? 'fail' : 'warn';
  let fix: string | undefined;
  const quiet = dormant(d.state);
  if (quiet === 'no-seat' && d.closed) bits.push('the host has closed the room since');
  if (quiet === 'closed' || (quiet === 'no-seat' && d.closed)) fix = `the room was closed; this machine's copy is kept. If the host opens it again, /sub-human reconnects; ${cli(`link ${d.code} --forget`)} in a terminal drops it for good`;
  else if (quiet === 'no-seat') {
    // the host may have closed the room since this machine's last seat left: /sub-human would dial a closed room
    fix = `the connection stopped when this machine's last seat left. If the host still has the room open, type /sub-human in your session to start it again; if you no longer want the room, ${cli(`link ${d.code} --forget`)} in a terminal drops it`;
  }
  else if (d.state.state === 'fork') fix = `this machine's copy no longer matches the host's: run ${cli(`link ${d.code} --forget --force`)} in a terminal (the copy is set aside, anything not sent with it), then ask the host for a new invite (/sub-human invite there) and type the line it shows`;
  else if (d.transport.login && why && REVOKED.has(why)) {
    fix = `the host ended this connection: ask them first, then join again over your ssh login: /sub-human join ${d.transport.user}@${d.transport.host}${d.transport.port ? `:${d.transport.port}` : ''} ${d.code}`;
  } else if (why && SPENT.has(why)) {
    // the link's invite (or key) is spent: joining again or restarting the daemon would only reuse it
    fix = 'the invite this machine joined with no longer works (used, expired, or too many wrong PINs), or the host ended the connection: ask the host for a new invite (/sub-human invite there) and type the line it shows';
  } else if (!d.daemon.running && d.state.state !== 'online') fix = 'the connection is not running: type /sub-human in your session to start it again';
  if (d.reach) {
    const r = d.reach;
    const span = (x: ProtoRange | null | undefined) => (x && x.min !== undefined ? (x.min === x.max ? `${x.min}` : `${x.min}-${x.max}`) : '?');
    const local = `${span(protocol.PROTO)} (sub-human ${protocol.PLUGIN_VERSION})`;
    if (r.skipped) bits.push(r.error);
    else if (r.ok) {
      const p: Partial<NonNullable<Reach['protocol']>> = r.protocol ?? {};
      const host = `${p.proto ? span(p.proto) : p.v} (sub-human ${p.server || '?'})`;
      bits.push(`host reachable in ${r.ms} ms; protocol here ${local}, host ${host}, speaking v${p.v}`);
    } else {
      bits.push(`host unreachable: ${r.error}`);
      if (!quiet) status = 'fail';
      if (!quiet) fix = [r.hint, r.code === 'PROTOCOL' ? 'the two sides speak different protocol versions: update sub-human on the older side (/plugin update sub-human)' : null, fix].filter(Boolean).join('\n') || fix;
    }
    if (d.transport.kind === 'ssh' && !r.skipped) bits.push(batchMode(r.ok, r.stderr));
    if (r.ok) {
      const SIG_SKEW_MS = lib('room/envelope.ts').SIG_SKEW_MS;
      if (r.skewMs === null) out.push(check({ id: `clock:${d.code}`, status: 'info', title: `clock ${d.code}`, detail: 'skew not measurable: the host\'s hello carries no time' }));
      else {
        const abs = Math.abs(r.skewMs);
        const s = abs >= SIG_SKEW_MS ? 'fail' : abs >= SKEW_WARN_MS ? 'warn' : 'pass';
        out.unshift(check({ id: `clock:${d.code}`, status: s, title: `clock ${d.code}`, detail: `this machine is ${Math.round(abs / 1000)} s ${r.skewMs > 0 ? 'behind' : 'ahead of'} the host`, fix: s === 'pass' ? undefined : 'turn on network time (NTP) on both machines: signed posts older than 10 min are refused' }));
      }
    }
  }
  if (quiet) status = 'info';
  out.unshift(check({ id: `link:${d.code}`, status, title: `connection ${d.code}`, detail: bits.filter(Boolean).join(' · '), fix }));
  return out;
}

export { diagnoseLink, linkChecks, helloProbe, dormant };
