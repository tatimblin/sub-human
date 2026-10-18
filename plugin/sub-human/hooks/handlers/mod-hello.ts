// plugin/sub-human/hooks/handlers/mod-hello.ts: the hooks module's hello: what the module knows of this session's seat
// (the guard needs the home, the prefilters the seat). Not a hooks.json entry: mod/deliver.ts runs it with
// $.process.run (HOOKS in mod/register.ts says when: a session that may have a seat, and before a join). stdin:
// {session_id, nonce?, cc_version?}. Writes the module's lease for the session (lib/identity.ts writeModLease) with the
// nonce at-room checks an origin against and the Claude Code version ($.session.version); the claude pid is our parent
// (hooks/run.ts sets CLAUDE_PID to it). Prints {home, realHome, userHome, pluginRoot, seat: {name, code, role, addr} |
// null, restorable, pending, cc?} on one line; cc: that version's verdict (lib/cc/verdict.ts ensure: read, or a check
// started in the background, never waited for) as {version, verified, off}; restorable: a
// SessionStart restore has a seat to put this session back in (lib/identity.ts lastSeat of this session id, or a seat
// this claude process holds: a /clear); pending: no seat, and a join this session started with a PIN waits for the
// host's card (a link file's join_sid, lib/room/links.ts), so the module starts the tail that says when it let them in.
// Loads lib/identity.ts, lib/room/links.ts and lib/cc/verdict.ts only (no seat key). Failure: an unreadable payload
// still prints the home, seat null, no lease; a verdict that cannot be read leaves cc out.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as identity from '../../lib/identity.ts';
import * as links from '../../lib/room/links.ts';
import * as verdict from '../../lib/cc/verdict.ts';
import type { Identity } from '../../lib/identity.ts';
import type { Reply } from '../types.ts';
import type { PluginState } from 'claude-code';

/** stdin: the session id and the module's nonce for it (mod/deliver.ts sayHello). */
interface HelloIn { session_id?: unknown; nonce?: unknown; cc_version?: unknown }
/** What the module reads back (mod/core/seat.ts parseHello adds the session id): types/index.d.ts SubHumanHello. */
type Hello = Omit<PluginState['sub-human']['hello'], 'sid'>;

const PLUGIN_ROOT = path.join(import.meta.dirname, '..', '..');
const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };

function hello(input: HelloIn): Hello {
  const sid = typeof input.session_id === 'string' ? input.session_id : null;
  const home = path.resolve(identity.home());
  let seat: Hello['seat'] = null;
  try {
    const me: Identity | null = sid ? identity.resolveBySession(sid) : null;
    if (me) seat = { name: me.name, code: me.code, role: me.role, addr: identity.address(me.name, me.code) };
  } catch (err) { process.stderr.write(`sub-human mod-hello: seat lookup failed: ${err instanceof Error ? err.message : err}\n`); }
  try { if (sid) identity.writeModLease(sid, { pid: identity.claudePid() || process.ppid, nonce: input.nonce, ccVersion: input.cc_version }); } catch (err) {
    process.stderr.write(`sub-human mod-hello: lease not written: ${err instanceof Error ? err.message : err}\n`);
  }
  let restorable = !!seat;
  try { restorable = restorable || !!(sid && identity.lastSeat(sid)) || !!identity.resolveByPid(identity.claudePid() || process.ppid); } catch { /* not known: false */ }
  let pending = false;
  try {
    pending = !seat && !!sid && links.list().some(c => { const l = links.get(c); return !!l && l.join_sid === sid && typeof l.join_as === 'string'; });
  } catch { /* not known: false */ }
  let cc: Hello['cc'];
  try {
    const version = input.cc_version;
    if (typeof version === 'string' && verdict.file(version)) {
      cc = verdict.hello(version, verdict.ensure(version));
      verdict.noteSeen(version);
    }
  } catch (err) { process.stderr.write(`sub-human mod-hello: no verdict: ${err instanceof Error ? err.message : err}\n`); }
  return { home, realHome: real(home), userHome: os.homedir(), pluginRoot: PLUGIN_ROOT, seat, restorable, pending, ...(cc ? { cc } : {}) };
}

const answer = (input: HelloIn): Reply => ({ kind: 'classic', outputs: [hello(input)] });
export const handle = (input: HelloIn): Reply => answer(input);
/** A payload it cannot read: still the home, seat null, no lease. */
export const fail = (): Reply => answer({});

export { hello };
