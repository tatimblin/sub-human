'use strict';
/**
 * scripts/remote-docker/lab/seat-proc.js: the stand-in for one seat's `claude` process inside a lab machine. Its pid
 * is the seat's CLAUDE_PID (seat-cli.js writes the hooks module's lease for it). It runs the seat's room tail
 * (`sub-human tail --ndjson`, the plugin's own, as the hooks module starts it) as its child, which delivers the
 * room's lines and renews the seat's lease, and appends every tail event to EVENTS as {t: ms epoch, ...event}, so a
 * scenario can time a post from one machine to another's delivery. A tail that exits is started again.
 * Usage (seat-cli.js spawns it detached): node seat-proc.js CLI SID EVENTS
 */
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const [cli, sid, events] = process.argv.slice(2);
const env = {
  ...process.env, CLAUDE_CODE_SESSION_ID: sid, CLAUDE_PID: String(process.pid),
  SUB_HUMAN_SETTLE_MS: '150', SUB_HUMAN_SETTLE_MAX_MS: '400', SUB_HUMAN_POLL_MS: '50', SUB_HUMAN_TAIL_HEALTH_MS: '1000',
  SUB_HUMAN_UNSEATED_MS: '200', SUB_HUMAN_RESOLVE_MS: '500',
};
const note = obj => fs.appendFileSync(events, JSON.stringify({ t: Date.now(), ...obj }) + '\n');
let stopping = false;

function tail() {
  const c = spawn(process.execPath, [cli, 'tail', '--ndjson'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  c.stdout.on('data', d => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) if (l.trim()) { try { note({ ev: JSON.parse(l) }); } catch { note({ raw: l }); } }
  });
  c.stderr.on('data', d => note({ stderr: String(d).slice(0, 2000) }));
  c.on('exit', code => { note({ tail_exit: code }); if (!stopping) setTimeout(() => { child = tail(); }, 500); });
  return c;
}

let child = tail();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopping = true; try { child.kill(); } catch { /* gone */ } process.exit(0); });
setInterval(() => { /* stay alive */ }, 1 << 30);
