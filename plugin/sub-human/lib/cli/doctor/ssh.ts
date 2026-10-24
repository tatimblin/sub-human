/**
 * plugin/sub-human/lib/cli/doctor/ssh.ts: doctor's ssh checks (lib/cli/doctor.ts): the serve shim a host reached over ssh
 * runs, ssh itself, and what ssh's stderr means for a link (one classifier:
 * lib/remote/transports/ssh.ts classify).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { lib, cli, check, tilde, isExec, readText } from './check.ts';
import { assertNever } from '../../../mod/core/never.ts';
import type { Check } from '../types.ts';

/** <home>/bin/serve is the current shim and <home>/bin/current names an existing plugin and node. */
function checkShim(): Check {
  const shim = lib('remote/shim.ts');
  const file = shim.shimPath(), ptr = shim.pointerPath();
  if (!fs.existsSync(file) && !fs.existsSync(ptr)) {
    return check({ id: 'shim', status: 'info', title: 'serve shim', detail: `${tilde(file)} is not there (only a host reached over SSH needs it)` });
  }
  const problems: string[] = [];
  if (!isExec(file)) problems.push(`${tilde(file)} is missing or not executable`);
  else if (readText(file) !== shim.shimBody()) problems.push(`${tilde(file)} is an older shim`);
  const lines = (readText(ptr) || '').split('\n');
  const [root, node] = lines;
  if (!root) problems.push(`${tilde(ptr)} names no plugin`);
  else if (!['scripts/sub-human', 'bin/sub-human'].some(c => fs.existsSync(path.join(root, c)))) problems.push(`the recorded plugin ${tilde(root)} is gone`);
  if (!node) problems.push(`${tilde(ptr)} names no node`);
  else if (!isExec(node)) problems.push(`the recorded node ${tilde(node)} is gone (the shim falls back to node on PATH)`);
  const stale = root && path.resolve(root) !== path.resolve(shim.pluginRoot());
  if (!problems.length) {
    return check({ id: 'shim', status: stale ? 'warn' : 'pass', title: 'serve shim', detail: stale ? `runs ${tilde(root)} (sub-human ${shim.versionOf(root) || '?'}), not this install (${tilde(shim.pluginRoot())}, sub-human ${shim.versionOf(shim.pluginRoot()) || '?'})` : `runs ${tilde(root)} with ${tilde(node)}`, fix: stale ? `to serve from this install, run ${cli('doctor --fix')} in a terminal (it points the shim here); a newer install takes it by itself at its next join` : undefined });
  }
  return check({ id: 'shim', status: 'fail', title: 'serve shim', detail: problems.join('; '), fix: 'start Claude Code once on this machine (it rewrites it), or run ' + cli('doctor --fix') + ' in a terminal' });
}

function sshVersion(): string | null {
  const r = spawnSync('ssh', ['-V'], { encoding: 'utf8', timeout: 5000 });
  if (r.error) return null;
  return String(r.stderr || r.stdout || '').trim().split('\n')[0] || 'ssh (unknown version)';
}

function checkSsh({ needed, version }: { needed: boolean; version: string | null }): Check {
  if (version) return check({ id: 'ssh', status: 'pass', title: 'ssh', detail: version });
  return check({ id: 'ssh', status: needed ? 'fail' : 'info', title: 'ssh', detail: 'no ssh on PATH', fix: needed ? 'install OpenSSH: joining over ssh needs it' : undefined });
}


/**
 * ssh's own complaint, as a hint (a login of the person's own; a jump host or an interactive login is the person's
 * ~/.ssh/config and their own first ssh).
 */
function sshHint(stderr: unknown): string | null {
  const p = lib('remote/transports/ssh.ts').classify(stderr);
  if (!p) return null;
  switch (p.kind) {
    case 'mfa': return 'the host or a jump host wants an interactive login (MFA): sub-human logs in with your keys only. Ask the host for an invite over the web instead (/sub-human invite --web)';
    case 'denied': return 'the host refused your ssh login: joining over ssh needs a login of your own there (your key in its authorized_keys, as for any ssh). Without one, ask the host for an invite over the web (/sub-human invite --web)';
    case 'host-key': return 'the host key is unknown or changed: run `ssh USER@HOST` once by hand to check and accept it, then join again';
    case 'dns': return 'the host name does not resolve from here (VPN or tailnet down?); a host behind a jump host needs an alias with ProxyJump in your ~/.ssh/config, then join with that alias';
    case 'refused': return 'nothing listens for ssh on that port';
    case 'timeout': return 'the host does not answer (asleep, offline or firewalled); behind a bastion, use an alias with ProxyJump in your ~/.ssh/config';
    case 'no-plugin': return 'the host found no sub-human plugin or node to run: on the host, start Claude Code once';
    case 'forward-refused': return 'the host machine\'s sshd lets your login forward no port (AllowTcpForwarding): ask its admin to allow local forwarding, or the room\'s host for another invite';
    case 'forward-unreached': return 'nothing listens on the host machine\'s listener port: the room\'s host can run /sub-human invite --forward again';
    case 'no-shim': case 'old-host': case 'no-room': case 'not-hosted': case 'serve-refused': return null;
    default: return assertNever(p, 'ssh problem');
  }
}

/** ssh logged in with no prompt (the hello answered), or what kept it from doing so (classify: denied, host-key). */
function batchMode(ok: boolean, stderr: string): string {
  if (ok) return 'ssh logs in without a prompt';
  const p = lib('remote/transports/ssh.ts').classify(stderr);
  return p && (p.kind === 'denied' || p.kind === 'host-key') ? 'ssh cannot log in without a prompt' : '';
}

export { checkShim, sshVersion, checkSsh, sshHint, batchMode };
