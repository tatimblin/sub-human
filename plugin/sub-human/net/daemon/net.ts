// What the daemon gets from net/: the host's side (net/host.ts) for rooms hosted here, the links (net/link.ts) for
// rooms hosted elsewhere, and the ops of core/api.ts that drive them (invite, asks, admit, kick, join, link). The home's
// one X25519 key, made on first use (0600), is both the host key a line pins and this machine's link key.
import fs from 'node:fs/promises';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { readConfig } from '../../config.js';
import type { Duplex } from 'node:stream';
import type { Answers, NetOp, NetRequest, Op, Request } from '../../core/api.js';
import type { Result } from '../../core/result.js';
import { err, ok } from '../../core/result.js';
import { writeAtomic } from '../../store/atomic.js';
import type { KeyPair } from '../channel.js';
import { generateKeyPair, keyPair } from '../channel.js';
import type { Expose, HostOptions } from '../host.js';
import { Host } from '../host.js';
import type { Clock, Dial } from '../link.js';
import { LinkSet } from '../link.js';
import type { Timings } from '../../core/link-engine.js';
import { dialSsh } from '../pathways/ssh.js';
import { dialWs, expose } from '../pathways/tailscale.js';
import type { Links, Rooms } from './rooms.js';

const NET_OPS: ReadonlySet<string> = new Set<NetOp>(['invite', 'asks', 'admit', 'kick', 'dial', 'link']);
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

export async function homeKey(home: string): Promise<KeyPair> {
  const file = `${home}/keys/noise.key`;
  const hex = (await fs.readFile(file, 'utf8').catch(() => '')).trim();
  if (/^[0-9a-f]{64}$/.test(hex)) return keyPair(Buffer.from(hex, 'hex'));
  const k = generateKeyPair();
  await writeAtomic(file, k.priv.toString('hex'));
  return k;
}

/** Holds off sleep while links are live (R28): caffeinate on macOS, systemd-inhibit on Linux; nothing elsewhere. */
export function stayAwake(): () => void {
  const argv = process.platform === 'darwin' ? ['caffeinate', '-i', '-w', String(process.pid)]
    : process.platform === 'linux' ? ['systemd-inhibit', '--what=sleep', '--who=sub-human', '--why=a room has live links', 'sleep', 'infinity'] : null;
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
  const links: Links = {
    hosts: code => set?.hosts(code) ?? false,
    forward: (code, req) => set?.forward(code, req) ?? Promise.resolve(err('the room\'s host is away; nothing was sent')),
    relay: (code, to, from, text) => host?.relay(code, to, from, text) ?? false,
    state: code => set?.state(code) ?? Promise.resolve(null),
  };
  return {
    links,
    async start() {
      const key = await homeKey(o.home);
      host = new Host({
        home: o.home, rooms, key, machine: o.machine, now: o.now, port: o.port ?? config.port,
        sshAddr: o.sshAddr ?? config.sshAddr ?? os.hostname(), expose: o.expose ?? ((mode, port) => expose(mode, port, env)),
        awake: o.awake ?? stayAwake, ...(o.rates ? { rates: o.rates } : {}),
      });
      set = new LinkSet({ home: o.home, rooms, key, machine: o.machine, dial, ...(o.clock ? { clock: o.clock } : {}), ...(o.timings ? { timings: o.timings } : {}) });
      await Promise.all([host.start(), set.start()]);
    },
    async stop() { set?.stop(); await host?.stop(); },
    accept(stream, source) { if (host) host.accept(stream, source); else stream.destroy(); },
    async handle(req) {
      if (!host || !set) return err('sub-human\'s daemon is still starting; nothing was done');
      const hostOnly = (code: string): Result<never> | null => (set?.hosts(code) ? err(`only ${code}'s host can do that; nothing was done`) : null);
      switch (req.op) {
        case 'invite': return hostOnly(req.code) ?? host.invite(req);
        case 'asks': return ok({ asks: host.asks(req.session) });
        case 'admit': return host.answer(req);
        case 'kick': return hostOnly(req.code) ?? host.kick(req);
        case 'dial': return set.join(req.line, req.name);
        case 'link': return ok(set.status(req.code));
      }
    },
  };
}
