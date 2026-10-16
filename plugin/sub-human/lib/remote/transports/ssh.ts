/**
 * plugin/sub-human/lib/remote/transports/ssh.ts: the ssh kind, the pipe kind (./pipe.ts) with an `ssh` command in
 * front. Since protocol 3 every new ssh link is a login link: the person's own ssh login to the host account (their
 * keys, agent, ~/.ssh/config and known_hosts decide; the plugin writes no key and pins no host key) runs the host's
 * stable shim (remoteCommand), an invite line's or a plain `/sub-human join USER@HOST ROOM`'s alike. A link an admit let
 * in before protocol 3 (its own key, a pinned host key, a forced command on the host that ignores the remote command
 * named here) keeps working with the link options its file holds until it is kicked or invited again.
 *
 *   dest(text) -> {user, host, port?} | null   a plain user@host[:port]: a POSIX-ish user name and a host name or
 *                                  IPv4 address. Neither part may start with "-" (an option) or hold spaces, quotes,
 *                                  "%" (ssh token expansion) or "@", so an invite can name neither an ssh option nor
 *                                  a command
 *   jump(text) -> string | null    a ProxyJump: one or more [user@]host[:port], comma-separated, each as plain as dest
 *                                  (a host alias of the joiner's own ~/.ssh/config is a plain host name)
 *   parse(rest) -> {user, host, port?, via?} | null   the locator's rest: user@host[:port][?via=JUMP]
 *   locator(text, {via}?) -> 'ssh:user@host[:port][?via=JUMP]' | null
 *   command(spec, code, opts?) -> [cmd, ...args]
 *       ssh -T -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=2 [opts] [link options] [-J via]
 *       [-p port] -- user@host "sub-human serve --stdio CODE". The spec is checked again (a link file edited by hand:
 *       INVALID). opts (default: SUB_HUMAN_SSH_OPTS split on spaces) are extra ssh options from this machine's own
 *       environment, never from an invite: for tests and setups that need -i KEY, -F FILE or a known_hosts file
 *       (ssh takes the first value of an option, so they win). Link options come from fields the joining machine
 *       wrote into its own link file (lib/room/links.ts), never from an invite:
 *         key         -i KEY -o IdentitiesOnly=yes          a link from before protocol 3: its own key (nothing makes one now)
 *         knownHosts  -o UserKnownHostsFile=F -o StrictHostKeyChecking=yes -o HostKeyAlias=ALIAS   that link's pinned
 *         alias       host key: no first-use prompt, nothing else accepted
 *         mux         -o ControlMaster=no -o ControlPath=<home>/ssh/cm-%C   ride a master `sub-human prime CODE` opened
 *                     (one MFA prompt for hours); with none open, ssh connects as usual. BatchMode stays on, so the
 *                     daemon never waits on a prompt and never becomes a master itself
 *       Over a login link (spec.login, `/sub-human join USER@HOST ROOM`: the person's own ssh login to the host's
 *       account is the admission, no invite) the remote command is the host's stable shim instead (remoteCommand), and
 *       no link option is added: the person's own keys, agent, ~/.ssh/config and known_hosts decide, BatchMode on
 *   loginSpec(dest, {via?, home?, link?}) -> Spec | null   a login link's transport: {kind: 'ssh', user, host,
 *       port?, via?, login: true, link, remoteHome?}. link: the link id this machine picks (12 hex, random by default;
 *       the host's server records the link under it, so `/sub-human kick` finds its serve process by its argv); home:
 *       the host's SUB_HUMAN_HOME when it is not ~/.sub-human (a plain absolute path). null when any part is not plain
 *   remoteCommand(spec, code) -> string   what ssh asks the host to run: `sub-human serve --stdio CODE` for a key an
 *       admit let in before protocol 3 (its forced command ignores it), else (login) `"$HOME"/.sub-human/bin/serve --stdio CODE --link ID
 *       --login`, or `env SUB_HUMAN_HOME=H H/bin/serve …` with remoteHome. A forced-command key can never send --login:
 *       its line fixes the arguments (scripts/sub-human serve also refuses --login under SSH_ORIGINAL_COMMAND)
 *   loginCommand(spec) -> string     the plain `ssh [-p P] [-J V] user@host` a person runs once by hand (a host key to
 *       accept, a password or MFA to check)
 *   classify(stderr) -> {kind, ...} | null   what ssh's stderr says, in one place (the link daemon, loginProblem and
 *       doctor read it): mfa, host-key, denied {publickey}, no-shim, old-host, no-plugin, no-room, not-hosted,
 *       serve-refused {detail}, dns, refused, timeout; null for anything else
 *   loginProblem(stderr, spec, code) -> {message, reason} | null   why a login link cannot work until the person acts
 *       (an unknown or changed host key, a refused login, no shim or no room on the host: SSH_HOST_KEY, SSH_DENIED,
 *       SSH_NO_SHIM, SSH_OLD_HOST, SSH_NO_ROOM): the link daemon stops with it (AUTH) instead of redialing; null for
 *       anything that may pass (a timeout, a refused connection). loginFailure(stderr, spec, code): its message alone
 *   primeCommand(spec, code, {persist}?) -> [cmd, ...args]   the master: interactive (no BatchMode), -M -N -f
 *       -o ControlPersist=PERSIST (default 8h), the same link options and ControlPath
 *   controlPath(home?) -> string   <home>/ssh/cm-%C
 *   kind = {parse, open, describe}   the `ssh` kind (./index.ts register); open(spec, {code}) spawns command() over
 *                                  ./pipe.ts (INVALID without a code)
 */

import path from 'node:path';
import { RoomError } from '../../room/validate.ts';
import childProcess from 'node:child_process';
import * as textMod from '../../text.ts';
import CryptoMod from 'node:crypto';
import FsMod from 'node:fs';
import { createRequire } from 'node:module';
import type { KindEntry, OpenCtx, SshDest, SshSpec, Transport } from '../types-rest.ts';
import type { Reason } from '../../reasons.ts';

const require = createRequire(import.meta.url);

const SSH_USER = '[A-Za-z_][A-Za-z0-9_.-]{0,31}';
const SSH_HOST = '[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})';
const SSH_RE = new RegExp(`^(${SSH_USER})@(${SSH_HOST})(?::([0-9]{1,5}))?$`);
const HOP_RE = new RegExp(`^(?:${SSH_USER}@)?${SSH_HOST}(?::([0-9]{1,5}))?$`);
const LOCAL_PATH_RE = /^\/[^\0\n"'%]*$/;
const ALIAS_RE = /^[A-Za-z0-9._-]{1,64}$/;
const LINK_ID_RE = /^[0-9a-f]{12}$/;
const HOME_RE = /^\/[A-Za-z0-9_\/.@+,:-]+$/; // lib/remote/shim.ts PLAIN_PATH_RE: nothing a remote shell expands

/** text: user@host[:port] */
function dest(text: string): SshDest | null {
  const m = SSH_RE.exec(String(text));
  if (!m) return null;
  const port = m[3] === undefined ? undefined : Number(m[3]);
  if (port !== undefined && !(port >= 1 && port <= 65535)) return null;
  return { user: m[1], host: m[2], ...(port ? { port } : {}) };
}

/**
 * A bare ssh config alias (`dev`) as the USER@ALIAS ssh would log in as: the user from `ssh -G ALIAS` (your
 * ~/.ssh/config, else your local name; read locally, nothing connects). The alias stays the host, so its HostName,
 * Port, ProxyJump and keys still apply. opts (default SUB_HUMAN_SSH_OPTS, as every ssh this machine runs: a `-F FILE`
 * there is the config the link's ssh reads too) go before -G. Anything else, or no ssh, comes back unchanged.
 */
function withUser(text: string, { bin = 'ssh', opts = String(process.env.SUB_HUMAN_SSH_OPTS || '').split(/\s+/).filter(Boolean) }: { bin?: string; opts?: string[] } = {}): string {
  const t = String(text);
  if (t.includes('@') || !new RegExp(`^${SSH_HOST}(?::[0-9]{1,5})?$`).test(t)) return t;
  const host = t.replace(/:[0-9]+$/, '');
  try {
    const r = childProcess.spawnSync(bin, [...opts, '-G', host], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = r.status === 0 && /^user (\S+)$/m.exec(r.stdout || '');
    return m && new RegExp(`^${SSH_USER}$`).test(m[1]) ? `${m[1]}@${t}` : t;
  } catch { return t; }
}
/** The `YOU@host` of the README's examples, typed as is. */
// an example's word left in: YOU@box, USER@box, NAME@box, or a bare NAME / USER / YOU / HOST
const placeholder = (text: string): boolean => /^(?:YOU|USER|NAME|you|user|name)@/.test(String(text)) || /^(?:YOU|USER|NAME|HOST|DEST)$/.test(String(text)) || /@(?:HOST|DEST)$/.test(String(text));

function jump(text: string): string | null {
  const hops = String(text).split(',');
  if (hops.length > 4) return null;
  for (const h of hops) {
    const m = HOP_RE.exec(h);
    if (!m || (m[1] !== undefined && !(Number(m[1]) >= 1 && Number(m[1]) <= 65535))) return null;
  }
  return String(text);
}

function parse(rest: string): (SshDest & { via?: string }) | null {
  const [d, q, ...more] = String(rest).split('?');
  if (more.length) return null;
  const spec = dest(d);
  if (!spec || q === undefined) return spec;
  const m = /^via=(.+)$/.exec(q);
  const via = m && jump(m[1]);
  return via ? { ...spec, via } : null;
}

const at = (d: SshDest): string => `${d.user}@${d.host}${d.port ? `:${d.port}` : ''}`;

function locator(text: string, { via }: { via?: string } = {}): string | null {
  const d = dest(text);
  if (!d || (via !== undefined && !jump(via))) return null;
  return `ssh:${at(d)}${via !== undefined ? `?via=${via}` : ''}`;
}

const controlPath = (h: string = (require('../../home.ts') as typeof import('../../home.ts')).home()): string => path.join(path.resolve(h), 'ssh', 'cm-%C');

/** The spec, checked again; the link options its local fields ask for. */
function checked(spec: SshSpec, code: string): { d: SshDest; local: string[]; tail: string[] } {
  const d = spec && dest(at(spec));
  if (!d) throw new RoomError('INVALID', 'the link\'s ssh destination is not a plain user@host[:port]');
  if (spec.via !== undefined && !jump(spec.via)) throw new RoomError('INVALID', 'the link\'s ProxyJump is not a plain [user@]host[:port] list');
  const { CODE_RE } = textMod;
  if (!CODE_RE.test(code)) throw new RoomError('INVALID', `invalid room code "${code}"`);
  const local: string[] = [];
  const file = (k: string, v: unknown): string => { if (typeof v !== 'string' || !LOCAL_PATH_RE.test(v)) throw new RoomError('INVALID', `the link's ${k} is not a plain absolute path`); return v; };
  if (spec.key !== undefined) local.push('-i', file('key', spec.key), '-o', 'IdentitiesOnly=yes');
  if (spec.knownHosts !== undefined) {
    if (typeof spec.alias !== 'string' || !ALIAS_RE.test(spec.alias)) throw new RoomError('INVALID', 'the link\'s pinned host key has no plain alias');
    local.push('-o', `UserKnownHostsFile=${file('knownHosts', spec.knownHosts)}`, '-o', 'StrictHostKeyChecking=yes', '-o', `HostKeyAlias=${spec.alias}`);
  }
  if (spec.login === true) {
    if (!LINK_ID_RE.test(String(spec.link))) throw new RoomError('INVALID', 'the login link names no link id (12 hex)');
    if (spec.remoteHome !== undefined && !HOME_RE.test(String(spec.remoteHome))) throw new RoomError('INVALID', 'the login link\'s remote home is not a plain absolute path');
  }
  if (spec.mux === true) {
    const cp = controlPath(); // its own %C is the one ssh expands; the home may hold none
    file('control path', path.dirname(cp));
    local.push('-o', `ControlPath=${cp}`);
  }
  return { d, local, tail: [...(spec.via !== undefined ? ['-J', spec.via] : []), ...(d.port ? ['-p', String(d.port)] : []), '--', `${d.user}@${d.host}`] };
}

function command(spec: SshSpec, code: string, opts: string[] = String(process.env.SUB_HUMAN_SSH_OPTS || '').split(/\s+/).filter(Boolean)): string[] {
  const { local, tail } = checked(spec, code);
  const mux = spec.mux === true ? ['-o', 'ControlMaster=no'] : [];
  // ssh takes an option's first value: the pinned ones (local: the link's key, known_hosts, StrictHostKeyChecking; mux)
  // come before SUB_HUMAN_SSH_OPTS, so the environment adds options and never weakens those
  return ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
    ...mux, ...local, ...opts, ...tail, remoteCommand(spec, code)];
}

function remoteCommand(spec: Pick<SshSpec, 'login' | 'link' | 'remoteHome'>, code: string): string {
  if (spec.login !== true) return `sub-human serve --stdio ${code}`;
  const args = `--stdio ${code} --link ${spec.link} --login`;
  return spec.remoteHome !== undefined
    ? `env SUB_HUMAN_HOME=${spec.remoteHome} ${spec.remoteHome}/bin/serve ${args}`
    : `"$HOME"/.sub-human/bin/serve ${args}`;
}

/** text: user@host[:port] */
function loginSpec(text: string, { via, home, link = CryptoMod.randomBytes(6).toString('hex') }: { via?: string; home?: string; link?: string } = {}): SshSpec | null {
  const d = dest(text);
  if (!d || (via !== undefined && !jump(via)) || (home !== undefined && !HOME_RE.test(String(home))) || !LINK_ID_RE.test(String(link))) return null;
  return { kind: 'ssh', ...d, ...(via !== undefined ? { via } : {}), login: true, link, ...(home !== undefined ? { remoteHome: path.resolve(home) } : {}) };
}

const loginCommand = (spec: SshSpec): string => ['ssh', ...(spec.port ? ['-p', String(spec.port)] : []), ...(spec.via ? ['-J', spec.via] : []), `${spec.user}@${spec.host}`].join(' ');

/** What ssh's stderr says went wrong, in one place: the link daemon (lib/remote/link-connect.ts), loginFailure and
 * doctor's hints read it. null: nothing this knows (the connection may still pass). */
type SshProblem =
  | { kind: 'mfa' | 'host-key' | 'dns' | 'refused' | 'timeout' | 'no-shim' | 'old-host' | 'no-plugin' | 'no-room' | 'not-hosted' }
  | { kind: 'denied'; publickey: boolean }
  | { kind: 'serve-refused'; detail: string };

function classify(stderr: unknown): SshProblem | null {
  const s = String(stderr || '');
  if (/keyboard-interactive|Verification code|one-time password|Duo two-factor/i.test(s) && !/publickey\)\.?\s*$/i.test(s.trim())) return { kind: 'mfa' };
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No (?:\S+ )?host key is known/i.test(s)) return { kind: 'host-key' };
  if (/Permission denied/i.test(s)) return { kind: 'denied', publickey: /Permission denied \(publickey/.test(s) };
  if (/bin\/serve/.test(s) && /not found|No such file|Unknown command|can't open/i.test(s)) return { kind: 'no-shim' };
  if (/^usage: sub-human serve --stdio CODE \[--link ID\]$/m.test(s)) return { kind: 'old-host' };
  if (/sub-human: no (plugin install|node)/.test(s)) return { kind: 'no-plugin' };
  const m = /^(no room "[^"]*"|room "[^"]*" is not hosted on this machine[^\n]*|sub-human serve --login: [^\n]*)$/m.exec(s);
  if (m) return /^no room/.test(m[1]) ? { kind: 'no-room' } : /not hosted/.test(m[1]) ? { kind: 'not-hosted' } : { kind: 'serve-refused', detail: m[1] };
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(s)) return { kind: 'dns' };
  if (/Connection refused/i.test(s)) return { kind: 'refused' };
  if (/timed out|Operation timed out/i.test(s)) return { kind: 'timeout' };
  return null;
}

/** Why a login link cannot work until the person acts, with its reason (lib/reasons.ts), from classify; null when it may pass. */
function loginProblem(stderr: string, spec: SshSpec, code: string): { message: string; reason: Reason } | null {
  const where = `${spec.user}@${spec.host}`;
  const once = loginCommand(spec);
  const home = spec.remoteHome || '~/.sub-human';
  const { cliLine } = textMod;
  const p = classify(stderr);
  if (p && p.kind === 'mfa' && !/Permission denied/i.test(String(stderr || ''))) return null; // a prompt BatchMode refused: may pass once primed
  switch (p && p.kind) {
    case 'host-key': return { reason: 'SSH_HOST_KEY', message: `ssh doesn't know ${where}'s host key yet (or it changed), and sub-human never answers ssh's questions. Run \`${once}\` once in a terminal, check and accept the key, then join again` };
    case 'denied': case 'mfa': return { reason: 'SSH_DENIED', message: `${where} refused your ssh login: sub-human logs in with your ssh keys or agent only, never a password. Check that \`${once}\` logs in without one, then join again; behind MFA, run \`${cliLine(`prime ${code}`)}\` in a terminal first` };
    case 'no-shim': return { reason: 'SSH_NO_SHIM', message: `${where} isn't set up for joining yet (no ${home}/bin/serve). On that machine, open the room in Claude Code (/sub-human), then join again${spec.remoteHome ? '' : '; if its sub-human folder is somewhere else, add --home PATH'}` };
    case 'old-host': return { reason: 'SSH_OLD_HOST', message: `the sub-human on ${where} is too old for joining over an ssh login: update it there (/plugin update sub-human), or ask its host for an invite (/sub-human invite)` };
    case 'no-plugin': return { reason: 'SSH_NO_SHIM', message: `${where} found no sub-human plugin or node to run: on that machine, start Claude Code once, then join again` };
    case 'no-room': return { reason: 'SSH_NO_ROOM', message: `room ${code} isn't open on ${where} (nothing by that name in ${home}): check the room's name, or open it there first` };
    case 'not-hosted': return { reason: 'SSH_NO_ROOM', message: `${where} only holds a copy of room ${code}; join the machine that hosts it` };
    case 'serve-refused': return { reason: 'SSH_NO_ROOM', message: (p as { detail: string }).detail };
    default: return null;
  }
}

/** loginProblem's words alone. */
const loginFailure = (stderr: string, spec: SshSpec, code: string): string | null => loginProblem(stderr, spec, code)?.message ?? null;

function primeCommand(spec: SshSpec, code: string, { persist = '8h', opts = String(process.env.SUB_HUMAN_SSH_OPTS || '').split(/\s+/).filter(Boolean) }: { persist?: string; opts?: string[] } = {}): string[] {
  if (!/^[0-9]{1,5}[smhd]?$/.test(persist)) throw new RoomError('INVALID', `--persist "${persist}" is not a time (e.g. 8h)`);
  const { local, tail } = checked({ ...spec, mux: true }, code);
  return ['ssh', '-M', '-N', '-f', '-o', `ControlPersist=${persist}`, '-o', 'ServerAliveInterval=15', ...opts, ...local, ...tail];
}

const kind: Required<KindEntry<SshSpec>> = {
  parse,
  open(spec, ctx: OpenCtx = {}): Transport {
    if (!ctx.code) throw new RoomError('INVALID', 'an ssh transport connects to a room: open(spec, {code})');
    if (spec.mux === true) FsMod.mkdirSync(path.dirname(controlPath()), { recursive: true, mode: 0o700 });
    const [cmd, ...args] = command(spec, ctx.code);
    return (require('./pipe.ts') as typeof import('./pipe.ts')).spawn(cmd, args);
  },
  describe: spec => `ssh ${at(spec)}${spec.via ? ` via ${spec.via}` : ''}${spec.login === true ? ' (your ssh login)' : ''}`,
};

export {
  withUser, placeholder, dest, jump, parse, locator, command, remoteCommand, loginSpec, loginCommand,
  loginFailure, loginProblem, classify, primeCommand, controlPath, kind,
};
