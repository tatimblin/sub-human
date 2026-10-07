#!/usr/bin/env node
'use strict';
// The hooks module's hello. Not a hooks.json entry: mod/register.mjs runs it with $.process.run on session.start,
// and again after the join (classic.UserPromptExpansion) and after classic.SessionStart (a /clear, compact or
// resume rebinds the seat). stdin: {session_id}.
//   - writes the module's lease for the session (lib/identity.js writeModLease, which documents its fields). The
//     claude pid is our parent: $.process children are claude's own, and get no CLAUDE_PID of this session;
//   - prints {home, realHome, userHome, pluginRoot, seat: {name, code, role, addr} | null} on one line: the module
//     knows no store path of its own (the guard needs the home; the prefilters need the seat).
// It loads lib/identity.js only (no hooks/common.js, no seat key). An unreadable payload still prints the home,
// with seat null and no lease.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readInput } = require('../lib/io.js');
const identity = require('../lib/identity.js');

const PLUGIN_ROOT = path.join(__dirname, '..');
const real = p => { try { return fs.realpathSync(p); } catch { return p; } };

function hello(input) {
  const sid = typeof input.session_id === 'string' ? input.session_id : null;
  const home = path.resolve(identity.home());
  let seat = null;
  try {
    const me = sid ? identity.resolveBySession(sid) : null;
    if (me) seat = { name: me.name, code: me.code, role: me.role, addr: identity.address(me.name, me.code) };
  } catch (err) { process.stderr.write(`sub-human mod-hello: seat lookup failed: ${err && err.message}\n`); }
  try { if (sid) identity.writeModLease(sid, { pid: identity.claudePid() || process.ppid, seat: seat && seat.addr }); } catch (err) {
    process.stderr.write(`sub-human mod-hello: lease not written: ${err && err.message}\n`);
  }
  return { home, realHome: real(home), userHome: os.homedir(), pluginRoot: PLUGIN_ROOT, seat };
}

if (require.main === module) {
  let input = {};
  try { input = readInput({ strict: false }) || {}; } catch { input = {}; }
  process.stdout.write(JSON.stringify(hello(input)) + '\n');
}

module.exports = { hello };
