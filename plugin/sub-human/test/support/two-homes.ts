// Two homes in one process (TESTING §6): a host's daemon and a joiner's, each on its own socket, the joiner dialling
// the host over the pipe pathway (or another dial a test gives). Every step goes through the daemon's socket API, as
// the commands and the module make it.
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { Answers, Ask, Request } from '../../core/api.js';
import type { Result } from '../../core/result.js';
import type { Daemon } from '../../net/daemon.js';
import { call } from '../../net/daemon/client.js';
import type { Net, NetOptions } from '../../net/daemon/net.js';
import { homeKey, makeNet } from '../../net/daemon/net.js';
import { connect } from '../../net/channel.js';
import type { ToHost, ToLink } from '../../core/protocol.js';
import { decodeToLink, encode } from '../../core/protocol.js';
import type { Dial } from '../../net/link.js';
import { pipe } from '../../net/pathways/pipe.js';
import { home, joined, started, until } from './daemon.js';

export interface Side {
  readonly home: string;
  /** One request to this side's daemon; asserts it was done and answers its value. */
  ok<R extends Request>(req: R): Promise<Answers[R['op']]>;
  call<R extends Request>(req: R): Promise<Result<Answers[R['op']]>>;
}
export interface Homes {
  readonly host: Side;
  readonly joiner: Side;
  /** How many times the host held off sleep, and whether it holds now. */
  readonly awake: { count: number; held: boolean };
  readonly hostNet: Net;
  /** Closes the host's daemon and starts another on its home, as a restart does; the host's session pings again. */
  restartHost(): Promise<void>;
}

export const CODE = 'otter-4821';

/** The two daemons, closed after the test; `hostOpts` and `joinOpts` reach makeNet. */
export async function twoHomes(t: TestContext, o: {
  hostOpts?: Partial<NetOptions>;
  joinOpts?: Partial<NetOptions>;
  dial?: (hostNet: Net) => Dial;
} = {}): Promise<Homes> {
  const awake = { count: 0, held: false };
  const [hh, jh] = [await home(), await home()];
  const made: { net?: Net } = {};
  const startHost = (): Promise<Daemon> => started(t, {
    home: hh, machine: 'mA', net: rooms => (made.net = makeNet(rooms, {
      home: hh, machine: 'mA', now: Date.now, sshAddr: 'devbox',
      awake: () => { awake.count++; awake.held = true; return () => { awake.held = false; }; },
      ...o.hostOpts,
    })),
  });
  let hd = await startHost();
  const hn = made.net ?? assert.fail('no host net');
  // the host's net of the moment: a restarted host is dialled as the same machine
  const now: Net = { links: hn.links, start: () => hn.start(), stop: () => hn.stop(), handle: r => hn.handle(r), accept: (s, src) => { made.net?.accept(s, src); } };
  const dial = o.dial?.(now) ?? pipe((s, src) => { now.accept(s, src); });
  await started(t, { home: jh, machine: 'mB', net: rooms => makeNet(rooms, { home: jh, machine: 'mB', now: Date.now, dial, ...o.joinOpts }) });
  const host = side(hh);
  const restartHost = async (): Promise<void> => {
    await hd.close();
    hd = await startHost();
    await host.ok({ op: 'ping', session: 'sa', code: CODE, name: 'alice' });
  };
  return { host, joiner: side(jh), awake, hostNet: now, restartHost };
}

function side(h: string): Side {
  return {
    home: h,
    call: req => call(h, req),
    ok: async req => {
      const r = await call(h, req);
      assert.ok(r.ok, `${req.op}: ${r.ok ? '' : r.error}`);
      return r.value;
    },
  };
}

/** alice in the room on the host, with a live session (`sa`), so the host is not away. */
export async function hostRoom(h: Homes): Promise<void> {
  await h.host.ok({ op: 'ping', session: 'sa', code: CODE, name: 'alice' });
  await h.host.ok({ op: 'append', code: CODE, draft: joined('alice') });
}

/** The first ask the host's session is shown. */
export function nextAsk(h: Homes): Promise<Ask> {
  return until('an ask on the host', async () => (await h.host.ok({ op: 'asks', session: 'sa' })).asks[0] ?? null);
}

/** Until the joiner's link to the room is in `phase`. */
export function linkIs(h: Homes, phase: string): Promise<Answers['link']> {
  return until(`the link ${phase}`, async () => {
    const s = await h.joiner.ok({ op: 'link', code: CODE });
    return s?.phase === phase ? s : null;
  });
}

/** An invite for bob, joined and let in: the link online. Answers the line and the check string. */
export async function joinBob(h: Homes, via: 'ssh' | 'public' | 'tailnet' = 'ssh'): Promise<{ line: string; check: string }> {
  await hostRoom(h);
  const { line } = await h.host.ok({ op: 'invite', code: CODE, from: 'alice', name: 'bob', via });
  const { check } = await h.joiner.ok({ op: 'dial', line, name: 'bob' });
  const ask = await nextAsk(h);
  await h.host.ok({ op: 'admit', session: 'sa', code: CODE, id: ask.id, answer: 'let_in' });
  await linkIs(h, 'online');
  await h.joiner.ok({ op: 'ping', session: 'sb', code: CODE, name: 'bob' });
  return { line, check };
}


/** A link of the joiner's own key that a test drives by hand: it sends what it is told and ignores every bye. */
export interface RawLink {
  send(m: ToHost): void;
  /** Every message the host sent, in order. */
  readonly got: ToLink[];
  /** The first message of type `t`, waiting for it. */
  next(t: ToLink['t']): Promise<ToLink>;
  readonly closed: Promise<void>;
}

export async function rawLink(h: Homes, o: { code?: string; name?: string } = {}): Promise<RawLink> {
  const [me, host] = [await homeKey(h.joiner.home), await homeKey(h.host.home)];
  const dial = pipe((s, src) => { h.hostNet.accept(s, src); });
  const payload = Buffer.from(JSON.stringify({ code: o.code ?? CODE, name: o.name ?? 'bob', machine: 'mB' }));
  const ch = await connect(await dial({ kind: 'ssh', host: 'devbox', user: null, sshPort: null, port: 1 }, CODE), { s: me, rs: host.pub, payload });
  const got: ToLink[] = [];
  ch.onMessage(b => { const m = decodeToLink(b.toString('utf8')); if (m.ok && m.value) got.push(m.value); });
  return {
    got,
    send: m => { ch.send(Buffer.from(encode(m))); },
    next: t => until(`a ${t} from the host`, () => Promise.resolve(got.find(m => m.t === t) ?? null)),
    closed: new Promise(res => { ch.onClose(() => { res(); }); }),
  };
}
