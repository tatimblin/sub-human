#!/usr/bin/env node
'use strict';
/**
 * scripts/remote-docker/lab/attack.js: someone who knows a room's code and can reach the host's sshd, but not the
 * 4-digit PIN, at the invite's enrollment door (lib/remote/enroll.js). Run inside a joiner container as its
 * user: `node /lab/attack.js CODE SSH_CONFIG [AVOID]`. The enrollment key is public (lib/remote/sshkeys.js
 * enrollKey: derived from the room code), so the attacker has it. It tries, through that key:
 *   shell    a command of its own (`id`): the forced command runs instead, and answers no shell
 *   pty      a terminal (-tt): refused by `restrict`
 *   forward  a stdio forward to the host's port 22 (-W): refused by `restrict`
 *   guesses  5 PAKE attempts with PINs it does not know (AVOID: the real PIN, never guessed, so the run is
 *            deterministic): each refused with the tries left, the last burning the invite
 *   after    one more attempt: the door is gone (ssh refuses the key) or answers that no invite is open
 * Prints one JSON object.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const [code, conf, avoid = ''] = process.argv.slice(2);
const lib = name => require(path.join('/plugin', 'lib', name));
const sshkeys = lib('remote/sshkeys.js');
const enroll = lib('remote/enroll.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attack-'));
const key = sshkeys.writeEnrollKey(dir, code);
const kh = path.join(dir, 'kh');
const base = ['-F', conf, '-i', key, '-o', 'IdentitiesOnly=yes', '-o', `UserKnownHostsFile=${kh}`, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
const run = (args, input = '') => {
  const r = spawnSync('ssh', [...base, ...args], { input, encoding: 'utf8', timeout: 30_000 });
  return { status: r.status, out: String(r.stdout || '').slice(0, 400), err: String(r.stderr || '').slice(-400) };
};

async function main() {
  const out = {};
  out.shell = run(['-T', 'host@devbox', 'id; echo SHELL-OK']);
  out.pty = run(['-tt', 'host@devbox', 'id; echo SHELL-OK']);
  out.forward = run(['-W', '127.0.0.1:22', 'host@devbox']);
  out.guesses = [];
  process.env.SUB_HUMAN_SSH_OPTS = `-F ${conf}`;
  const joiner = { name: 'mallory', machine: 'attacker0machine', label: 'attacker', key: sshkeys.enrollKey(code).raw };
  let g = 0;
  const next = () => { for (;;) { const c = String(g++).padStart(4, '0'); if (c !== avoid) return c; } };
  for (let i = 0; i < 6; i++) {
    const t0 = Date.now();
    try {
      const { transport } = await enroll.openTransport({ kind: 'ssh', user: 'host', host: 'devbox' }, code, { dir });
      await enroll.joinEnroll({ code, kind: 'ssh', pin: next(), joiner, transport, checkKey: () => {} });
      out.guesses.push({ ok: true, ms: Date.now() - t0 });
    } catch (e) {
      out.guesses.push({ ok: false, code: e.code, message: String(e.message).slice(0, 200), ms: Date.now() - t0 });
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(JSON.stringify(out));
}
main().catch(e => { console.log(JSON.stringify({ error: e.stack })); process.exit(1); });
