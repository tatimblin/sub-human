/**
 * test/support/fake-ssh.ts: an `ssh` for tests with no sshd, put first on PATH (fakeSsh(t) writes it into a dir of its
 * own and returns the dir). It plays sshd for the host account a joiner logs into with their own ssh login, which is
 * how every ssh link is made since protocol 3:
 *   - `ssh -G ALIAS` prints a config (user me): what withUser reads; nothing connects
 *   - FAKE_SSH_FAIL hostkey | denied: fails as ssh does in BatchMode (an unknown host key; no login of one's own)
 *   - otherwise the remote command runs in the host user's login shell (HOME = FAKE_SSH_HOME, SUB_HUMAN_HOME unset, as
 *     a fresh login has it), with no SSH_ORIGINAL_COMMAND: sshd sets that only for a forced command
 *   - FAKE_SSH_FORCED: that forced command runs instead, with SSH_ORIGINAL_COMMAND set (a restricted key's line)
 * FAKE_SSH_LOG (optional): one line per run, its argv.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { TestContext } from 'node:test';
import * as h from '../helpers.ts';

function fakeSsh(t: TestContext): string {
  const dir = h.tmpDir('sh-fakessh-', t);
  fs.writeFileSync(path.join(dir, 'ssh'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '-G') { process.stdout.write('user me\\nhostname devbox.internal\\nport 22\\n'); process.exit(0); }
if (process.env.FAKE_SSH_LOG) fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(args) + '\\n');
const fail = process.env.FAKE_SSH_FAIL;
if (fail === 'hostkey') { process.stderr.write('No ED25519 host key is known for devbox and you have requested strict checking.\\nHost key verification failed.\\n'); process.exit(255); }
if (fail === 'denied') { process.stderr.write('me@devbox: Permission denied (publickey).\\n'); process.exit(255); }
const remote = args.slice(args.indexOf('--') + 2).join(' ');
const env = { ...process.env, HOME: process.env.FAKE_SSH_HOME };
delete env.SUB_HUMAN_HOME;
let cmd = remote;
if (process.env.FAKE_SSH_FORCED) { env.SSH_ORIGINAL_COMMAND = remote; cmd = process.env.FAKE_SSH_FORCED; }
const c = require('node:child_process').spawn('/bin/sh', ['-c', cmd], { stdio: 'inherit', env, cwd: env.HOME });
c.on('exit', code => process.exit(code === null ? 255 : code));
`, { mode: 0o755 });
  return dir;
}

export { fakeSsh };
