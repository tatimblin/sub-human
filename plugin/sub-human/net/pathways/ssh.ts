// The ssh pathway (R29b): `ssh -W 127.0.0.1:PORT HOST` through the joiner's own account on the host machine, to the
// same loopback listener Funnel reaches. It runs the person's own `ssh`, so their config, agent and known_hosts apply;
// BatchMode, since the daemon has no terminal to ask a password on. Needs AllowTcpForwarding on the host's sshd.
import { spawn } from 'node:child_process';
import { Duplex, PassThrough } from 'node:stream';
import type { Pathway } from '../invite.js';

type Ssh = Extract<Pathway, { kind: 'ssh' }>;

export function sshArgs(via: Ssh): string[] {
  return [
    '-W', `127.0.0.1:${via.port}`, '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    ...(via.sshPort ? ['-p', String(via.sshPort)] : []), ...(via.user ? ['-l', via.user] : []), '--', via.host,
  ];
}

export function dialSsh(via: Ssh, env: Readonly<Record<string, string | undefined>> = process.env): Promise<Duplex> {
  const child = spawn('ssh', sshArgs(via), { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let said = '';
  child.stderr.on('data', (b: Buffer) => { said = (said + b.toString()).slice(-2000); });
  // the bytes end only once ssh has exited, so a failure is told as ssh's own last line rather than a bare close
  const out = new PassThrough();
  child.stdout.pipe(out, { end: false });
  child.on('close', code => {
    const why = said.trim().split('\n').at(-1) ?? '';
    if (code) out.destroy(new Error(`ssh to ${via.host} failed: ${why || `exit ${code}`}`)); else out.end();
  });
  const stream = Duplex.from({ readable: out, writable: child.stdin });
  stream.on('close', () => { child.kill(); });
  return new Promise((resolve, reject) => {
    child.once('spawn', () => { resolve(stream); });
    child.once('error', e => { reject(new Error(`ssh could not start: ${e.message}`)); });
  });
}
