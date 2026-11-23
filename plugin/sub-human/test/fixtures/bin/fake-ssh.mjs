// The fake ssh's body: `ssh -W HOST:PORT ... -- DEST` as a socket bridge on this machine. FAKE_SSH_LOG gets one JSON
// line of arguments per run; FAKE_SSH_FAIL makes it fail as an unreachable host does.
import fs from 'node:fs';
import net from 'node:net';

const args = process.argv.slice(2);
if (process.env.FAKE_SSH_LOG) fs.appendFileSync(process.env.FAKE_SSH_LOG, `${JSON.stringify(args)}\n`);
if (process.env.FAKE_SSH_FAIL) {
  process.stderr.write('ssh: connect to host devbox port 22: Connection refused\n');
  process.exit(255);
}
const [host, port] = (args[args.indexOf('-W') + 1] ?? '').split(':');
const s = net.connect(Number(port), host);
process.stdin.pipe(s);
s.pipe(process.stdout);
s.on('close', () => { process.exit(0); });
s.on('error', e => { process.stderr.write(`channel 0: open failed: ${e.message}\n`); process.exit(1); });
