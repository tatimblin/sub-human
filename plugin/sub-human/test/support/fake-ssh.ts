#!/usr/bin/env node
'use strict';
/**
 * test/support/fake-ssh.ts: an `ssh` for tests with no sshd, put on PATH as `ssh` (fakeSsh(dir) writes the wrapper).
 * It does what matters to sub-human of ssh and sshd together, on one machine:
 *   - the host key: the key it "is shown" is FAKE_SSHD_SHOWN_KEY (a .pub file; a man in the middle's), else
 *     FAKE_SSHD_HOST_KEY (the host's). UserKnownHostsFile + HostKeyAlias: a line for the alias with another key fails
 *     ("Host key verification failed.", 255); none: StrictHostKeyChecking accept-new or no appends it, yes fails
 *   - authentication: each -i KEY's KEY.pub must be in FAKE_SSHD_AUTHORIZED_KEYS, else "Permission denied (publickey)."
 *   - that line's command="…" runs (sh -c, SSH_ORIGINAL_COMMAND set), whatever command was asked for; with no
 *     command="" the asked command runs
 * The first value of an -o option wins, as in ssh. FAKE_SSH_LOG (optional): one line per run, its argv.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

function main() {
  const argv = process.argv.slice(2);
  const opts = {}, ids = [];
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { i++; break; }
    if (a === '-o') { const [k, ...v] = argv[++i].split('='); if (!(k in opts)) opts[k] = v.join('='); continue; }
    if (a === '-i') { ids.push(argv[++i]); continue; }
    if (['-p', '-J', '-F', '-l'].includes(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    break;
  }
  const dest = argv[i];
  const asked = argv.slice(i + 1).join(' ');
  if (process.env.FAKE_SSH_LOG) fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(argv) + '\n');
  const die = (msg, code = 255) => { process.stderr.write(msg + '\n'); process.exit(code); };
  const pub = f => fs.readFileSync(f, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');

  // the host key
  const shown = pub(process.env.FAKE_SSHD_SHOWN_KEY || process.env.FAKE_SSHD_HOST_KEY);
  const alias = opts.HostKeyAlias || String(dest).split('@').pop();
  const kh = opts.UserKnownHostsFile;
  if (kh && kh !== '/dev/null') {
    const lines = (() => { try { return fs.readFileSync(kh, 'utf8').split('\n'); } catch { return []; } })().filter(l => l.startsWith(`${alias} `));
    if (lines.length) {
      if (!lines.some(l => l.slice(alias.length + 1).trim() === shown)) die('Host key verification failed.');
    } else if (opts.StrictHostKeyChecking === 'accept-new' || opts.StrictHostKeyChecking === 'no') {
      fs.appendFileSync(kh, `${alias} ${shown}\n`);
    } else die('Host key verification failed.');
  }

  // the client key, against authorized_keys
  const ak = (() => { try { return fs.readFileSync(process.env.FAKE_SSHD_AUTHORIZED_KEYS, 'utf8').split('\n'); } catch { return []; } })();
  let line = null;
  for (const id of ids) {
    let blob;
    try { blob = pub(`${id}.pub`).split(' ')[1]; } catch { continue; }
    line = ak.find(l => l.split(/\s+/).includes(blob));
    if (line) break;
  }
  if (!line) die(`${dest}: Permission denied (publickey).`);
  const m = /^command="([^"]*)"/.exec(line);
  const cmd = m ? m[1] : asked;
  const child = spawn('/bin/sh', ['-c', cmd], { stdio: 'inherit', env: { ...process.env, SSH_ORIGINAL_COMMAND: asked } });
  child.on('exit', (c, sig) => process.exit(sig ? 1 : c));
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => { child.kill(s); });
}

/** Write an `ssh` wrapper into dir that runs this file; dir goes first on the joiner's PATH. */
function fakeSsh(dir) {
  const w = path.join(dir, 'ssh');
  fs.writeFileSync(w, `#!/bin/sh\nexec "${process.execPath}" "${import.meta.filename}" "$@"\n`, { mode: 0o755 });
  return dir;
}

export { fakeSsh };
if (import.meta.main) main();
