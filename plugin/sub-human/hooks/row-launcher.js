#!/usr/bin/env node
'use strict';
// SessionStart (every source): write the launcher the plugin's settings.json `subagentStatusLine` runs.
// ${CLAUDE_PLUGIN_ROOT} is empty in settings.json (08), so the setting names a fixed path instead:
//   "${SUB_HUMAN_HOME:-$HOME/.sub-human}/bin/row-status"
// (a status line command runs through the shell, so the env default expands there; E1). This hook writes
// that file = identity.home()/bin/row-status, pointing at this plugin's CLI. The status line process inherits
// claude's env, so SUB_HUMAN_HOME reaches the CLI unchanged. Rewritten only when the content changes.
const fs = require('node:fs');
const path = require('node:path');
const identity = require(path.join(__dirname, '..', 'lib', 'identity.js'));

const LAUNCHER = 'row-status';

function launcherPath() { return path.join(identity.home(), 'bin', LAUNCHER); }

function launcherBody(root) {
  const cli = path.join(root, 'bin', 'sub-human');
  const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh\n# written by sub-human hooks/row-launcher.js (SessionStart); the plugin's subagentStatusLine runs it\nexec node ${q(cli)} agent-statusline "$@"\n`;
}

function writeLauncher(root = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..')) {
  const f = launcherPath();
  const body = launcherBody(root);
  let cur = '';
  try { cur = fs.readFileSync(f, 'utf8'); } catch { /* none yet */ }
  if (cur === body) return f;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o755 });
  fs.renameSync(tmp, f);
  return f;
}

module.exports = { writeLauncher, launcherPath, launcherBody, LAUNCHER };

if (require.main === module) {
  try { fs.readFileSync(0, 'utf8'); } catch { /* stdin unused */ }
  try { writeLauncher(); } catch { /* best effort: rows fall back to their default text */ }
}
