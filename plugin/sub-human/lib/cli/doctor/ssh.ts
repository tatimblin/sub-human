/**
 * plugin/sub-human/lib/cli/doctor/ssh.ts: doctor's ssh checks (lib/cli/doctor.ts): the serve shim a host reached over ssh
 * runs, ssh itself, and what ssh's stderr means for a link (one classifier:
 * lib/remote/transports/ssh.ts classify).
 *
 *   checkShim() -> Check             <home>/bin/serve is the current shim and <home>/bin/current names an existing plugin
 *                                    and node
 *   sshVersion() -> string | null;  checkSsh({needed, version}) -> Check
 *   sshHint(stderr, {code?, transport?}) -> string | null   ssh's complaint as a fix (MFA: prime; denied: a login of
 *                                    your own, or an invite over the web; a host key; DNS or a timeout: --via JUMP)
 *   batchMode(ok, stderr) -> string  whether ssh logs in without a prompt, for a link's detail
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { lib, cli, check, tilde, isExec, readText } from './check.ts';
import { assertNever } from '../../../mod/core/never.ts';
import type { Check, LinkTransportView } from '../types.ts';

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
 * ssh's own complaint, as a hint (a login of the person's own, `sub-human prime` for an MFA bastion, `--via` for a
 * jump host). link: the link file's {code, transport} when known.
 */
function sshHint(stderr: unknown, link: { code?: string; transport?: LinkTransportView } = {}): string | null {
  const code = link.code || 'CODE';
  const t = link.transport ?? {};
  const newInvite = `ask the host for a new invite (/sub-human invite${t.via ? ` --via ${t.via}` : ''}) and type the line it shows`;
  const p = lib('remote/transports/ssh.ts').classify(stderr);
  if (!p) return null;
  switch (p.kind) {
    case 'mfa': return `the host or a jump host wants an interactive login (MFA): run ${cli(`prime ${code}`)} once in a terminal; the connection then rides that login for hours`;
    case 'denied': {
      const why = t.key
        ? 'the host refused this link\'s own key (an older sub-human let it in): the host removed it. ' + newInvite
        : 'the host refused your ssh login: joining over ssh needs a login of your own there (your key in its authorized_keys, as for any ssh). Without one, ask the host for an invite over the web (/sub-human invite --web)';
      return `${why}. Behind a bastion with MFA, run ${cli(`prime ${code}`)} in a terminal first`;
    }
    case 'host-key': return t.knownHosts
      ? `the host's ssh key is not the one its invite pinned (a reinstalled or different machine): check with the host, then ${newInvite}`
      : 'the host key is unknown or changed: run `ssh USER@HOST` once by hand to check and accept it, then join again';
    case 'dns': return `the host name does not resolve from here (VPN or tailnet down?)${t.via ? '' : '; if it is only reachable through a jump host, ask the host for an invite with --via JUMP (/sub-human invite --via JUMP)'}`;
    case 'refused': return 'nothing listens for ssh on that port';
    case 'timeout': return `the host does not answer (asleep, offline or firewalled)${t.via ? '' : '; behind a bastion, the invite needs --via JUMP (/sub-human invite --via JUMP)'}`;
    case 'no-plugin': return 'the host found no sub-human plugin or node to run: on the host, start Claude Code once';
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
