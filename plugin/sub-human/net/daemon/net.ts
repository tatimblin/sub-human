// What the daemon gets from net/: the host's side (net/host.ts) for rooms hosted here, the links (net/link.ts) for
// rooms hosted elsewhere, and the ops of core/api.ts that drive them (invite, uninvite, asks, admit, kick, join, link). The home's
// machine key (keys.ts) is both the host key a line pins and this machine's link key.
import os from 'node:os';
import { spawn } from 'node:child_process';
import { readConfig } from '../../config.js';
import type { Duplex } from 'node:stream';
import type { Answers, Joining, NetOp, NetRequest, Op, Request } from '../../core/api.js';
import { HOST_AWAY } from '../../core/api.js';
import type { Result } from '../../core/result.js';
import { err, ok } from '../../core/result.js';
import { machineKey } from '../../keys.js';
import type { Expose, HostOptions } from '../host.js';
import { Host } from '../host.js';
import type { Clock, Dial } from '../link.js';
import { LinkSet } from '../link.js';
import type { Timings } from '../../core/link-engine.js';
import { dialSsh } from '../pathways/ssh.js';
import { dialWs, expose } from '../pathways/tailscale.js';
import type { Links, Rooms } from './rooms.js';

const NET_OPS: ReadonlySet<string> = new Set<NetOp>(['invite', 'uninvite', 'asks', 'admit', 'kick', 'dial', 'link']);
export const isNet = (req: Request): req is NetRequest => NET_OPS.has(req.op);

export interface Net {
  readonly links: Links;
  start(): Promise<void>;
  stop(): Promise<void>;
  handle(req: NetRequest): Promise<Result<Answers[Op]>>;
  /** A connection a pathway brought to this host (the listener's, or the pipe's in tests). */
  accept(stream: Duplex, source: string): void;
}

export interface NetOptions {
  readonly home: string;
  readonly machine: string;
  readonly now: () => number;
  readonly port?: number;
  readonly sshAddr?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly dial?: Dial;
  readonly expose?: Expose;
  readonly awake?: () => () => void;
  readonly clock?: Clock;
  readonly timings?: Timings;
  readonly rates?: HostOptions['rates'];
}

/** Holds off sleep while links are live (R28): caffeinate on macOS, systemd-inhibit on Linux; nothing elsewhere. */
export function stayAwake(): () => void {
  const argv = process.platform === 'darwin' ? ['caffeinate', '-i', '-w', String(process.pid)]
    : process.platform === 'linux' ? ['systemd-inhibit', '--what=sleep', '--who=sub-human', '--why=someone is in a room', 'sleep', 'infinity'] : null;
  if (!argv) return () => undefined;
  const [cmd = '', ...args] = argv;
  const c = spawn(cmd, args, { stdio: 'ignore' });
  c.on('error', () => undefined);
  return () => { c.kill(); };
}

export function makeNet(rooms: Rooms, o: NetOptions): Net {
  const env = o.env ?? process.env;
  const config = readConfig(env, os.homedir());
  const dial: Dial = o.dial ?? ((via, code) => (via.kind === 'ssh' ? dialSsh(via, env) : dialWs(via.origin, code, env)));
  let host: Host | null = null, set: LinkSet | null = null;
  // R30: a session that dialled takes its place once the host lets it in and the room has synced
  const joining = new Map<string, Joining & { readonly name: string }>();
  const phase = (code: string, p: string): void => {
    const j = joining.get(code);
    if (p === 'online' || p === 'stopped') joining.delete(code);
    if (!j || p !== 'online') return;
    // a join that fails after Let in is told to the joiner's module, as the link's last word (core/api.ts link)
    const fail = (why: string): void => { failed.set(code, `you were let in, but this session did not take its place (${why}); type /room ${code}`); };
    // the name the host let this machine in as: another, when the one asked for is in the room from another machine
    const name = set?.name(code) ?? j.name;
    const line = name === j.name ? null : { why: `${j.name} is already in ${code}, so you joined as ${name}`, joined: false };
    if (line) renamed.set(code, line);
    void rooms.handle({ op: 'join', ...j, name, code }).then(r => { if (r.ok && line) line.joined = true; else if (!r.ok) fail(r.error); }, (e: unknown) => { fail(String(e)); });
  };
  const failed = new Map<string, string>();
  /** A join let in under another name: the line said with the link's status, until it is read once the join is done. */
  const renamed = new Map<string, { why: string; joined: boolean }>();
  const links: Links = {
    hosts: code => set?.hosts(code) ?? false,
    forward: (code, req) => set?.forward(code, req) ?? Promise.resolve(err(HOST_AWAY)),
    relay: (code, to, from, text) => host?.relay(code, to, from, text) ?? false,
    state: code => set?.state(code) ?? Promise.resolve(null),
    forget: async code => { await set?.forget(code); },
    name: code => set?.name(code),
  };
  return {
    links,
    async start() {
      const k = await machineKey(o.home);
      if (!k.ok) throw new Error(k.error);
      const key = k.value;
      host = new Host({
        home: o.home, rooms, key, machine: o.machine, now: o.now, port: o.port ?? config.port,
        sshAddr: o.sshAddr ?? config.sshAddr ?? os.hostname(), expose: o.expose ?? ((mode, port) => expose(mode, port, env)),
        awake: o.awake ?? stayAwake, ...(o.rates ? { rates: o.rates } : {}),
      });
      set = new LinkSet({ home: o.home, rooms, key, machine: o.machine, dial, phase, ...(o.clock ? { clock: o.clock } : {}), ...(o.timings ? { timings: o.timings } : {}) });
      await Promise.all([host.start(), set.start()]);
    },
    async stop() { set?.stop(); await host?.stop(); },
    accept(stream, source) { if (host) host.accept(stream, source); else stream.destroy(); },
    async handle(req) {
      if (!host || !set) return err('sub-human is still starting; nothing was done');
      const hostOnly = (code: string): Result<never> | null => (set?.hosts(code) ? err(`only ${code}'s host can do that; nothing was done`) : null);
      switch (req.op) {
        case 'invite': return hostOnly(req.code) ?? host.invite(req);
        case 'uninvite': return hostOnly(req.code) ?? host.uninvite(req);
        case 'asks': return ok({ asks: host.asks(req.session) });
        case 'admit': return host.answer(req);
        case 'kick': return hostOnly(req.code) ?? host.kick(req);
        case 'dial': {
          const r = await set.join(req.line, req.name);
          if (r.ok && req.session) joining.set(r.value.code, { ...req.session, name: req.name });
          return r;
        }
        case 'link': { // a join that failed after Let in is said once, as the link stopped
          const why = failed.get(req.code);
          if (failed.delete(req.code) && why !== undefined) return ok({ phase: 'stopped', why });
          const s = set.status(req.code), as = renamed.get(req.code);
          if (s?.phase !== 'online' || !as) return ok(s);
          if (as.joined) renamed.delete(req.code);
          return ok({ ...s, why: as.why });
        }
      }
    },
  };
}
