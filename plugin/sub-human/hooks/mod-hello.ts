#!/usr/bin/env node
// The hooks module's hello: the module knows no store path of its own (the guard needs the home, the prefilters the
// seat). Not a hooks.json entry: mod/deliver.ts runs it with $.process.run (HOOKS in mod/register.ts says when).
// stdin: {session_id, nonce?}. Writes the module's lease for the session (lib/identity.ts writeModLease) with the
// nonce at-room checks an origin against; the claude pid is our parent, since $.process children get no CLAUDE_PID
// of this session. Prints {home, realHome, userHome, pluginRoot, seat: {name, code, role, addr} | null} on one line.
// Loads lib/identity.ts only (no seat key). Failure: an unreadable payload still prints the home, seat null, no lease.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readInput } from '../lib/io.ts';
import * as identity from '../lib/identity.ts';
import type { Identity } from '../lib/identity.ts';
import type { PluginState } from 'claude-code';

/** stdin: the session id and the module's nonce for it (mod/deliver.ts sayHello). */
interface HelloIn { session_id?: unknown; nonce?: unknown }
/** What the module reads back (mod/core/seat.ts parseHello adds the session id): types/index.d.ts SubHumanHello. */
type Hello = Omit<PluginState['sub-human']['hello'], 'sid'>;

const PLUGIN_ROOT = path.join(import.meta.dirname, '..');
const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };

function hello(input: HelloIn): Hello {
  const sid = typeof input.session_id === 'string' ? input.session_id : null;
  const home = path.resolve(identity.home());
  let seat: Hello['seat'] = null;
  try {
    const me: Identity | null = sid ? identity.resolveBySession(sid) : null;
    if (me) seat = { name: me.name, code: me.code, role: me.role, addr: identity.address(me.name, me.code) };
  } catch (err) { process.stderr.write(`sub-human mod-hello: seat lookup failed: ${err instanceof Error ? err.message : err}\n`); }
  try { if (sid) identity.writeModLease(sid, { pid: identity.claudePid() || process.ppid, nonce: input.nonce }); } catch (err) {
    process.stderr.write(`sub-human mod-hello: lease not written: ${err instanceof Error ? err.message : err}\n`);
  }
  return { home, realHome: real(home), userHome: os.homedir(), pluginRoot: PLUGIN_ROOT, seat };
}

if (import.meta.main) {
  let input: HelloIn = {};
  try { input = readInput({ strict: false }) || {}; } catch { input = {}; }
  process.stdout.write(JSON.stringify(hello(input)) + '\n');
}

export { hello };
