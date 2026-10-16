/**
 * plugin/sub-human/lib/cli/doctor/ssh.ts: doctor's ssh checks (lib/cli/doctor.ts): the serve shim a host reached over ssh
 * runs, the authorized_keys lines that name it, ssh itself, and what ssh's stderr means for a link (one classifier:
 * lib/remote/transports/ssh.ts classify).
 *
 *   checkShim({needed}) -> Check     <home>/bin/serve is the current shim and <home>/bin/current names an existing plugin
 *                                    and node
 *   scanAuthorizedKeys(file) -> {file, exists, lines, doors}   the sub-human lines an older sub-human wrote (nothing
 *                                    writes one now): a link's forced command, and doors (the room codes of enrollment
 *                                    doors a 0.5.0-beta.15 invite left). checkAuthorizedKeys(scan) -> Check: a line that
 *                                    bypasses the shim (written before 0.5), or a door, is a warning (doctor --fix
 *                                    removes the doors; a link's line goes when its link is kicked)
 *   sshVersion() -> string | null;  checkSsh({needed, version}) -> Check
 *   sshHint(stderr, {code?, transport?}) -> string | null   ssh's complaint as a fix (MFA: prime; denied: a login of
 *                                    your own, or an invite over the web; a host key; DNS or a timeout: --via JUMP)
 *   batchMode(ok, stderr) -> string  whether ssh logs in without a prompt, for a link's detail
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { lib, cli, check, tilde, isExec, readText } from './check.ts';
import type { AuthorizedKeysScan, Check, KeyLine, LinkTransportView } from '../types.ts';

function checkShim({ needed }: { needed: boolean }): Check {
  const shim = lib('remote/shim.ts');
  const file = shim.shimPath(), ptr = shim.pointerPath();
  if (!fs.existsSync(file) && !fs.existsSync(ptr)) {
    return check('shim', needed ? 'fail' : 'info', 'serve shim', `${tilde(file)} is not there${needed ? ', and authorized_keys names it' : ' (only a host reached over SSH needs it)'}`,
      needed ? 'start Claude Code once on this machine (it writes it), or run ' + cli('doctor --fix') + ' in a terminal' : undefined);
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
    return check('shim', stale ? 'warn' : 'pass', 'serve shim',
      stale ? `runs ${tilde(root)} (sub-human ${shim.versionOf(root) || '?'}), not this install (${tilde(shim.pluginRoot())}, sub-human ${shim.versionOf(shim.pluginRoot()) || '?'})` : `runs ${tilde(root)} with ${tilde(node)}`,
      stale ? `to serve from this install, run ${cli('doctor --fix')} in a terminal (it points the shim here); a newer install takes it by itself at its next join` : undefined);
  }
  return check('shim', 'fail', 'serve shim', problems.join('; '), 'start Claude Code once on this machine (it rewrites it), or run ' + cli('doctor --fix') + ' in a terminal');
}

// command="SUB_HUMAN_HOME=<home> <...> --stdio CODE --link ID",restrict <type> <key> sub-human:CODE:ID
const KEY_LINE_RE = /^command="SUB_HUMAN_HOME=(\S+) (.+?) --stdio (\S+) --link ([0-9a-f]{12})",restrict (\S+) (\S+) sub-human:(\S+):(\S+)\s*$/;

/** A door line's home (its forced command's SUB_HUMAN_HOME) is this one, by path; a line naming none is this home's
 * when its room is. Another home's line (a second sub-human folder, the person's own ~/.sub-human) is left alone. */
function ownDoor(line: string, code: string): boolean {
  const h = /command="SUB_HUMAN_HOME=(\S+) /.exec(line);
  const home = lib('home.ts').home();
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  if (h) return real(h[1]) === real(home);
  try { return lib('identity.ts').roomExists(code); } catch { return false; }
}

function scanAuthorizedKeys(file: string): AuthorizedKeysScan {
  const text = readText(file);
  if (text === null) return { file, exists: false, lines: [] };
  const lines: KeyLine[] = [], doors: string[] = [], otherDoors: string[] = [];
  for (const l of text.split('\n')) {
    const door = / sub-human-enroll:(\S+)\s*$/.exec(l);
    if (door) { (ownDoor(l, door[1]) ? doors : otherDoors).push(door[1]); continue; }
    if (!/\bsub-human:/.test(l) && !/ serve --stdio /.test(l)) continue;
    const m = KEY_LINE_RE.exec(l.trim());
    if (!m) { lines.push({ ok: false, parse: false, raw: l }); continue; }
    const [, home, run, code, id, type, key] = m;
    const shimmed = run === path.join(home, 'bin', 'serve');
    lines.push({ ok: shimmed, home, code, id, type, key, shimmed });
  }
  return { file, exists: true, lines, doors, ...(otherDoors.length ? { otherDoors } : {}) };
}

function checkAuthorizedKeys(scan: AuthorizedKeysScan): Check {
  const h = path.resolve(lib('home.ts').home());
  if (!scan.exists) return check('authorized_keys', 'info', 'authorized_keys', `${tilde(scan.file)}: none (this machine hosts no room over SSH)`);
  const doors = scan.doors || [];
  const others = [...new Set(scan.otherDoors || [])];
  const otherNote = others.length ? ` (and ${others.length === 1 ? 'a line' : `${scan.otherDoors!.length} lines`} of another sub-human folder's, room ${others.join(', ')}: not this home's, not touched)` : '';
  if (doors.length) {
    return check('authorized_keys', 'warn', 'authorized_keys',
      `${doors.length} enrollment door line(s) an older sub-human's ssh invite left (room ${[...new Set(doors)].join(', ')}): they only tell an old joiner to update${otherNote}`,
      `run ${cli('doctor --fix')} in a terminal (it removes them), or delete the lines ending sub-human-enroll:ROOM from ${tilde(scan.file)}`);
  }
  if (!scan.lines.length) return check('authorized_keys', 'info', 'authorized_keys', `${tilde(scan.file)}: no sub-human lines of this home${otherNote}`);
  const old = scan.lines.filter(l => !l.ok);
  if (!old.length) return check('authorized_keys', 'pass', 'authorized_keys', `${scan.lines.length} sub-human line(s) an older sub-human wrote for its links, all through the shim (each goes when its link is kicked)`);
  const fixes = old.map(l => (l.parse === false ? `edit the unreadable sub-human line by hand in ${tilde(scan.file)}`
    : `remove the sub-human:${l.code}:${l.id} line from ${tilde(scan.file)}${l.home === h ? '' : ` (home ${tilde(l.home)})`} and invite that machine again (/sub-human invite)`));
  return check('authorized_keys', 'warn', 'authorized_keys',
    `${old.length} of ${scan.lines.length} sub-human line(s) bypass the shim (written before 0.5): they bake in a node and plugin path that break on an update`,
    [...new Set(fixes)].join('\n'));
}

function sshVersion(): string | null {
  const r = spawnSync('ssh', ['-V'], { encoding: 'utf8', timeout: 5000 });
  if (r.error) return null;
  return String(r.stderr || r.stdout || '').trim().split('\n')[0] || 'ssh (unknown version)';
}

function checkSsh({ needed, version }: { needed: boolean; version: string | null }): Check {
  if (version) return check('ssh', 'pass', 'ssh', version);
  return check('ssh', needed ? 'fail' : 'info', 'ssh', 'no ssh on PATH', needed ? 'install OpenSSH: joining over ssh needs it' : undefined);
}


/**
 * ssh's own complaint, as a hint (a login of the person's own, `sub-human prime` for an MFA bastion, `--via` for a
 * jump host). link: the link file's {code, transport} when known.
 */
function sshHint(stderr: unknown, link: { code?: string; transport?: LinkTransportView } = {}): string | null {
  const code = link.code || 'CODE';
  const t = link.transport || {};
  const newInvite = `ask the host for a new invite (/sub-human invite${t.via ? ` --via ${t.via}` : ''}) and type the line it shows`;
  const p = lib('remote/transports/ssh.ts').classify(stderr);
  switch (p && p.kind) {
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
    default: return null;
  }
}

/** ssh logged in with no prompt (the hello answered), or what kept it from doing so (classify: denied, host-key). */
function batchMode(ok: boolean, stderr: string): string {
  if (ok) return 'ssh logs in without a prompt';
  const p = lib('remote/transports/ssh.ts').classify(stderr);
  return p && (p.kind === 'denied' || p.kind === 'host-key') ? 'ssh cannot log in without a prompt' : '';
}

export { checkShim, scanAuthorizedKeys, checkAuthorizedKeys, sshVersion, checkSsh, sshHint, batchMode };
