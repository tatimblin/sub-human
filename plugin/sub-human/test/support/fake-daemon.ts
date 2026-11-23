// The daemon in-process for the commands' tests: the real daemon's request handler (net/daemon/rooms.ts) on a temp
// home (`dir`), behind the commands' Daemon seam, with no socket. `calls` records every write; `down` and `failing`
// make the writes fail as a daemon that isn't up, or one op that fails, would.
import fs from 'node:fs/promises';
import type { Draft, PresenceDoc } from '../../core/entries.js';
import { err, ok } from '../../core/result.js';
import type { Result } from '../../core/result.js';
import { fileKey, logFile, roomDir } from '../../home.js';
import type { FsStore } from '../../store/fs-store.js';
import { openFsStore } from '../../store/fs-store.js';
import { NO_LINKS, Rooms as DaemonRooms } from '../../net/daemon/rooms.js';
import { fsRooms } from '../../commands/context.js';
import type { Daemon, Rooms } from '../../commands/types.js';
import { tempHome } from './command-ctx.js';
import { must } from './must.js';

export interface FakeHome {
  readonly daemon: Daemon;
  readonly rooms: Rooms;
  readonly calls: string[];
  /** The home: rooms, session pointers and handoffs. */
  readonly dir: string;
  /** While set, every write answers this error. */
  down: string | null;
  /** An error one op answers while it is here, by the op's first word in `calls` (`session`, `retire`, …). */
  readonly failing: Map<string, string>;
  /** What `link` answers per room: a test sets one to `online` as a host letting it in would. */
  readonly linked: Map<string, { phase: 'waiting' | 'online' | 'stopped'; why: string | null }>;
  /** What status says of the modules. */
  sessions: number;
  /** The Claude Code versions its live sessions report. */
  cc: string[];
  /** The daemon's clock. */
  now: number;
  /** The one room here (the first, by code). */
  code(): Promise<string>;
  /** A room's log lines, as stored. */
  lines(code: string): Promise<string[]>;
  /** Rewrites a room's log, to forge a fork. */
  forge(code: string, f: (lines: string[]) => string[]): Promise<void>;
  store(code: string): Promise<FsStore>;
  /** Entries only the host writes (tasks, kicks), as the host's own rules would. */
  host(code: string, drafts: readonly Draft[]): Promise<void>;
  /** A session's module pinging the daemon, now. */
  ping(id: string): Promise<void>;
  /** The kinds of a room's entries, in order. */
  kinds(code: string): Promise<string[]>;
  /** A member's presence on this machine (`presence/NAME@MACHINE`), or null. */
  presence(code: string, name: string): Promise<PresenceDoc | null>;
}

export function fakeHome(o: { machine?: string } = {}): FakeHome {
  const dir = tempHome();
  const machine = o.machine ?? 'laptop';
  const guard = (call: string): Result<never> | null => {
    home.calls.push(call);
    const failed = home.down ?? home.failing.get(call.split(' ')[0] ?? '');
    return failed === undefined ? null : err(failed);
  };
  const log = async (code: string): Promise<string> => logFile(roomDir(dir, await fileKey(code)));
  const home: FakeHome = {
    calls: [], dir, down: null, failing: new Map(), linked: new Map(), sessions: 1, cc: ['2.1.330'], now: Date.now(),
    daemon: {
      append: async (code, draft, id) => guard(`append ${code} ${draft.kind} ${draft.from}`) ?? real.handle({ op: 'append', code, draft: { ...draft, id } }),
      putDoc: async (code, d) => guard(`put ${code} ${d.kind} ${d.doc.name}`) ?? real.handle({ op: 'put_doc', code, kind: d.kind, name: d.doc.name, doc: d.doc }),
      kick: async (code, name, by) => {
        const g = guard(`kick ${code} ${name} ${by}`);
        if (g) return g;
        const r = await real.write(code, [{ kind: 'kick', name, from: by, by: 'person' }]);
        return r.ok ? ok(null) : r;
      },
      join: async q => {
        const g = guard(`join ${q.id} ${q.name}`);
        if (g) return g;
        const r = await real.handle({ op: 'join', ...q });
        if (!r.ok) return r;
        const v = r.value;
        if (v !== null && typeof v === 'object' && 'rooms' in v) return ok({ rooms: v.rooms });
        return v !== null && typeof v === 'object' && 'opened' in v ? ok(v) : err('not a join');
      },
      leave: async id => guard(`leave ${id}`) ?? real.handle({ op: 'leave', id }),
      retire: async id => guard(`retire ${id}`) ?? real.handle({ op: 'retire', id }),
      handoff: async (id, cwd) => guard(`handoff ${id}`) ?? real.handle({ op: 'handoff', id, cwd }),
      claim: async (id, cwd) => {
        const g = guard(`claim ${id}`);
        if (g) return g;
        const r = await real.handle({ op: 'claim', id, cwd });
        if (!r.ok) return r;
        return r.value !== null && typeof r.value === 'object' && 'pointer' in r.value ? ok(r.value.pointer) : err('not a claim');
      },
      // the network is test/net's (two homes); here a line is one fixed answer, and no link is up
      invite: async (code, from, name, via) => guard(`invite ${code} ${name} ${via} ${from}`) ?? ok({ line: `ssh://devbox/${code}?port=7420#${'0'.repeat(77)}` }),
      dial: async (line, name) => guard(`dial ${name}`) ?? ok({ code: /\/([a-z]+-\d{4})/.exec(line)?.[1] ?? 'none', check: '1f2e-3d4c' }),
      link: async code => guard(`link ${code}`) ?? ok(home.linked.get(code) ?? null),
      status: () => Promise.resolve(home.down === null ? ok({ sessions: home.sessions, cc: home.cc }) : err(home.down)),
    },
    rooms: fsRooms(dir),
    code: async () => must((await fsRooms(dir).codes())[0], 'a room'),
    lines: async code => (await fs.readFile(await log(code), 'utf8')).split('\n').filter(l => l !== ''),
    forge: async (code, f) => { await fs.writeFile(await log(code), `${f(await home.lines(code)).join('\n')}\n`); },
    store: async code => { const s = await openFsStore({ home: dir, code }); if (!s.ok) throw new Error(s.error); return s.value; },
    host: async (code, drafts) => { const r = await real.write(code, drafts); if (!r.ok) throw new Error(r.error); },
    ping: async id => { await real.handle({ op: 'ping', session: id }); },
    presence: async (code, name) => (await home.store(code)).getDoc('presence', `${name}@${machine}`),
    kinds: async code => (await home.lines(code)).map(l => /"kind":"(\w+)"/.exec(l)?.[1] ?? '?'),
  };
  const real = new DaemonRooms({ home: dir, now: () => home.now, machine, idleMs: 60_000, links: NO_LINKS });
  return home;
}
