// The commands' Daemon on a real machine: each write is one request on the home's socket (core/api.ts), and the first
// one starts the daemon when nothing answers. Status alone never starts it: a daemon that is down has no module. The
// client is loaded at the first request, so a hook that writes nothing never loads it.
import type { Answers, Request } from '../core/api.js';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';
import type { Daemon } from './types.js';

/** How long a first write waits for a daemon it started: a loaded machine takes seconds, inside the hooks' 15 s. */
const START_MS = 8_000;
/** How long one write may take: a join is several crash-safe writes, and a busy disk syncs slowly. */
const CALL_MS = 10_000;
/** A daemon this command just started hears the module's ping within a poll or two (module/follow.ts POLL_MS): up to 3 s. */
const PINGED_TRIES = 12;
const PINGED_STEP_MS = 250;

export function daemonFor(home: string): Daemon {
  let up: Promise<Result<unknown>> | null = null;
  const client = () => import('../net/daemon/client.js');
  const send = async <R extends Request>(req: R): Promise<Result<Answers[R['op']]>> => {
    const { call, ensure } = await client();
    const started = await (up ??= ensure(home, START_MS));
    return started.ok ? call(home, req, CALL_MS) : err(started.error);
  };
  return {
    append: (code, draft, id) => send({ op: 'append', code, draft: { ...draft, id } }),
    putDoc: (code, d) => send({ op: 'put_doc', code, kind: d.kind, name: d.doc.name, doc: d.doc }),
    kick: (code, name, from) => send({ op: 'kick', code, from, name }),
    invite: (code, from, name, via) => send({ op: 'invite', code, from, name, via }),
    dial: (line, name, session) => send({ op: 'dial', line, name, session }),
    link: code => send({ op: 'link', code }),
    join: r => send({ op: 'join', ...r }),
    leave: id => send({ op: 'leave', id }),
    retire: id => send({ op: 'retire', id }),
    handoff: (id, cwd) => send({ op: 'handoff', id, cwd }),
    claim: async (id, cwd) => {
      const r = await send({ op: 'claim', id, cwd });
      return r.ok ? ok(r.value.pointer) : r;
    },
    pinged: async id => {
      for (let i = 1; ; i++) {
        const s = await send({ op: 'status', session: id });
        if (!s.ok || s.value.pinged === true || i >= PINGED_TRIES) return s.ok ? ok(s.value.pinged === true) : s;
        await new Promise(res => { setTimeout(res, PINGED_STEP_MS); });
      }
    },
    status: async () => {
      const s = await (await client()).call(home, { op: 'status' }, 1000);
      return s.ok ? ok({ sessions: s.value.sessions, cc: s.value.cc }) : s;
    },
  };
}
