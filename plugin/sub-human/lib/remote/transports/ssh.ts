/**
 * plugin/sub-human/lib/remote/transports/ssh.ts: the ssh kind, the pipe kind (./pipe.ts) with an `ssh` command in
 * front. Since protocol 3 every new ssh link is a login link: the person's own ssh login to the host account (their
 * keys, agent, ~/.ssh/config and known_hosts decide; the plugin writes no key and pins no host key) runs the host's
 * stable shim (remoteCommand), an invite line's or a plain `/sub-human join USER@HOST ROOM`'s alike.
 *
 * Every ssh option comes from this machine: SUB_HUMAN_SSH_OPTS (tests, -i KEY, -F FILE) and the link options its own
 * link file holds (lib/room/links.ts), never an invite; a link file edited by hand is checked again (INVALID). A
 * jump host goes in ~/.ssh/config (ProxyJump on an alias), which ssh reads. BatchMode stays on, so the daemon never
 * waits on a prompt. remoteCommand over a login link runs
 * `<home>/bin/serve --stdio CODE --link ID --login`; a forced-command key can never send --login (its line fixes the
 * arguments, and scripts/sub-human serve refuses --login under SSH_ORIGINAL_COMMAND). classify reads ssh's stderr in
 * one place (the link daemon, loginProblem, doctor); loginProblem is what stops a link (AUTH) until the person acts,
 * null for what may pass (a timeout, a refused connection).
 */

import path from 'node:path';
import { RoomError } from '../../room/validate.ts';
import childProcess from 'node:child_process';
import * as textMod from '../../text.ts';
import { envStr } from '../../env.ts';
import { assertNever } from '../../../mod/core/never.ts';

/** SUB_HUMAN_SSH_OPTS: extra ssh options, space separated. */
const sshOpts = (): string[] => String(envStr('SUB_HUMAN_SSH_OPTS') || '').split(/\s+/).filter(Boolean);
import CryptoMod from 'node:crypto';
import type { KindEntry, OpenCtx, SshDest, SshSpec, Transport } from '../types-rest.ts';
import type { ReasonFor } from '../../reasons.ts';
import type { RoomCode } from '../../brand.ts';
import type * as PipeMod from './pipe.ts';
import { lazy } from '../../io.ts';

// the pipe only for a connection that opens (start cost)
const pipeLib = lazy<typeof PipeMod>(import.meta.url, './pipe.ts');

const SSH_USER = '[A-Za-z_][A-Za-z0-9_.-]{0,31}';
const SSH_HOST = '[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})';
const SSH_RE = new RegExp(`^(${SSH_USER})@(${SSH_HOST})(?::([0-9]{1,5}))?$`);
const LINK_ID_RE = /^[0-9a-f]{12}$/;
const HOME_RE = /^\/[A-Za-z0-9_/.@+,:-]+$/; // lib/remote/shim.ts PLAIN_PATH_RE: nothing a remote shell expands

/** text: user@host[:port], plain: neither part may start with "-" or hold spaces, quotes, "%" (ssh token expansion)
 * or "@", so an invite can name neither an ssh option nor a command. */
function dest(text: string): SshDest | null {
  const m = SSH_RE.exec(String(text));
  if (!m) return null;
  const [, user = '', host = '', p] = m; // user and host always match
  const port = p === undefined ? undefined : Number(p);
  if (port !== undefined && !(port >= 1 && port <= 65535)) return null;
  return { user, host, ...(port ? { port } : {}) };
}

/**
 * A bare ssh config alias (`dev`) as the USER@ALIAS ssh would log in as: the user from `ssh -G ALIAS` (your
 * ~/.ssh/config, else your local name; read locally, nothing connects). The alias stays the host, so its HostName,
 * Port, ProxyJump and keys still apply. opts (default SUB_HUMAN_SSH_OPTS, as every ssh this machine runs: a `-F FILE`
 * there is the config the link's ssh reads too) go before -G. Anything else, or no ssh, comes back unchanged.
 */
function withUser(text: string, { bin = 'ssh', opts = sshOpts() }: { bin?: string; opts?: string[] } = {}): string {
  const t = String(text);
  if (t.includes('@') || !new RegExp(`^${SSH_HOST}(?::[0-9]{1,5})?$`).test(t)) return t;
  const host = t.replace(/:[0-9]+$/, '');
  try {
    const r = childProcess.spawnSync(bin, [...opts, '-G', host], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = r.status === 0 && /^user (\S+)$/m.exec(r.stdout || '');
    const user = m ? m[1] : undefined;
    return user !== undefined && new RegExp(`^${SSH_USER}$`).test(user) ? `${user}@${t}` : t;
  } catch { return t; }
}
/** The `YOU@host` of the README's examples, typed as is. */
// an example's word left in: YOU@box, USER@box, NAME@box, or a bare NAME / USER / YOU / HOST
const placeholder = (text: string): boolean => /^(?:YOU|USER|NAME|you|user|name)@/.test(String(text)) || /^(?:YOU|USER|NAME|HOST|DEST)$/.test(String(text)) || /@(?:HOST|DEST)$/.test(String(text));

const parse = (rest: string): SshDest | null => dest(String(rest));

const at = (d: SshDest): string => `${d.user}@${d.host}${d.port ? `:${d.port}` : ''}`;

function locator(text: string): string | null {
  const d = dest(text);
  return d ? `ssh:${at(d)}` : null;
}

/** The spec, checked again: the destination ssh is given. */
function checked(spec: SshSpec, code: RoomCode): { d: SshDest; tail: string[] } {
  const d = spec && dest(at(spec));
  if (!d) throw new RoomError('INVALID', 'the link\'s ssh destination is not a plain user@host[:port]');
  const { CODE_RE } = textMod;
  if (!CODE_RE.test(code)) throw new RoomError('INVALID', `invalid room code "${code}"`);
  if (spec.login === true) {
    if (!LINK_ID_RE.test(String(spec.link))) throw new RoomError('INVALID', 'the login link names no link id (12 hex)');
    if (spec.remoteHome !== undefined && !HOME_RE.test(String(spec.remoteHome))) throw new RoomError('INVALID', 'the login link\'s remote home is not a plain absolute path');
  }
  return { d, tail: [...(d.port ? ['-p', String(d.port)] : []), '--', `${d.user}@${d.host}`] };
}

function command(spec: SshSpec, code: RoomCode, opts: string[] = sshOpts()): [string, ...string[]] {
  const { tail } = checked(spec, code);
  // ssh takes an option's first value: the pinned ones come before SUB_HUMAN_SSH_OPTS, so the environment adds
  // options and never weakens those
  return ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
    ...opts, ...tail, remoteCommand(spec, code)];
}

function remoteCommand(spec: Pick<SshSpec, 'login' | 'link' | 'remoteHome'>, code: RoomCode): string {
  if (spec.login !== true) return `sub-human serve --stdio ${code}`;
  const args = `--stdio ${code} --link ${spec.link} --login`;
  return spec.remoteHome !== undefined
    ? `env SUB_HUMAN_HOME=${spec.remoteHome} ${spec.remoteHome}/bin/serve ${args}`
    : `"$HOME"/.sub-human/bin/serve ${args}`;
}

/** text: user@host[:port]. link: the id the host records the link under, so `/sub-human kick` finds its serve by argv. */
function loginSpec(text: string, { home, link = CryptoMod.randomBytes(6).toString('hex') }: { home?: string | undefined; link?: string } = {}): SshSpec | null {
  const d = dest(text);
  if (!d || (home !== undefined && !HOME_RE.test(String(home))) || !LINK_ID_RE.test(String(link))) return null;
  return { kind: 'ssh', ...d, login: true, link, ...(home !== undefined ? { remoteHome: path.resolve(home) } : {}) };
}

const loginCommand = (spec: SshSpec): string => ['ssh', ...(spec.port ? ['-p', String(spec.port)] : []), `${spec.user}@${spec.host}`].join(' ');

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
  const said = m ? m[1] : undefined; // the group always matches
  if (said !== undefined) return /^no room/.test(said) ? { kind: 'no-room' } : /not hosted/.test(said) ? { kind: 'not-hosted' } : { kind: 'serve-refused', detail: said };
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(s)) return { kind: 'dns' };
  if (/Connection refused/i.test(s)) return { kind: 'refused' };
  if (/timed out|Operation timed out/i.test(s)) return { kind: 'timeout' };
  return null;
}

/** Why a login link cannot work until the person acts, with its reason (lib/reasons.ts), from classify; null when it may pass. */
function loginProblem(stderr: string, spec: SshSpec, code: RoomCode, { first = false }: { first?: boolean } = {}): { message: string; reason: ReasonFor<'AUTH'> } | null {
  const where = `${spec.user}@${spec.host}`;
  const once = loginCommand(spec);
  const home = spec.remoteHome || '~/.sub-human';
  const p = classify(stderr);
  if (!p) return null;
  if (p.kind === 'mfa' && !/Permission denied/i.test(String(stderr || ''))) return null; // a prompt BatchMode refused: may pass once logged in by hand
  switch (p.kind) {
    case 'host-key': return { reason: 'SSH_HOST_KEY', message: `ssh doesn't know ${where}'s host key yet (or it changed), and sub-human never answers ssh's questions. Run \`${once}\` once in a terminal, check and accept the key, then join again` };
    case 'denied': case 'mfa': return { reason: 'SSH_DENIED', message: `${where} refused your ssh login: sub-human logs in with your ssh keys or agent only, never a password. Check that \`${once}\` logs in without one, then join again; behind MFA (an interactive login), run \`${once}\` yourself once first` };
    case 'no-shim': return { reason: 'SSH_NO_SHIM', message: `${where} isn't set up for joining yet (no ${home}/bin/serve). On that machine, open the room in Claude Code (/sub-human), then join again${spec.remoteHome ? '' : '; if its sub-human folder is somewhere else, add --home PATH'}` };
    case 'old-host': return { reason: 'SSH_OLD_HOST', message: `the sub-human on ${where} is too old for joining over an ssh login: update it there (/plugin update sub-human), or ask its host for an invite (/sub-human invite)` };
    case 'no-plugin': return { reason: 'SSH_NO_SHIM', message: `${where} found no sub-human plugin or node to run: on that machine, start Claude Code once, then join again` };
    case 'no-room': return { reason: 'SSH_NO_ROOM', message: `room ${code} isn't open on ${where} (nothing by that name in ${home}): check the room's name, or open it there first` };
    case 'not-hosted': return { reason: 'SSH_NO_ROOM', message: `${where} only holds a copy of room ${code}; join the machine that hosts it` };
    case 'serve-refused': return { reason: 'SSH_NO_ROOM', message: p.detail };
    // a name ssh cannot resolve on the first connection is a typo or a missing alias, not a network blip: say so and
    // stop; a link that connected before keeps retrying (a laptop offline resolves nothing for a while)
    case 'dns': return first ? { reason: 'SSH_HOST_UNKNOWN', message: `ssh cannot find ${spec.host} (${(/(Could not resolve hostname[^\n]*|Name or service not known|nodename nor servname[^\n]*)/i.exec(String(stderr || '')) || ['no such host'])[0].trim()}): check the name, or use an alias from your ~/.ssh/config, then join again` } : null;
    case 'refused': case 'timeout': return null;
    default: return assertNever(p, 'ssh problem');
  }
}

/** loginProblem's words alone. */
const loginFailure = (stderr: string, spec: SshSpec, code: RoomCode): string | null => loginProblem(stderr, spec, code)?.message ?? null;

const kind: Required<KindEntry<SshSpec>> = {
  parse,
  open(spec, ctx: OpenCtx = {}): Transport {
    if (!ctx.code) throw new RoomError('INVALID', 'an ssh transport connects to a room: open(spec, {code})');
    const [cmd, ...args] = command(spec, ctx.code);
    return pipeLib().spawn(cmd, args);
  },
  describe: spec => `ssh ${at(spec)}${spec.login === true ? ' (your ssh login)' : ''}`,
};

export {
  withUser, placeholder, dest, parse, locator, command, remoteCommand, loginSpec, loginCommand,
  loginFailure, loginProblem, classify, kind,
};
