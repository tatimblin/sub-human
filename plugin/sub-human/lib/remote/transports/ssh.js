'use strict';
/**
 * plugin/sub-human/lib/remote/transports/ssh.js: the ssh kind, the pipe kind (./pipe.js) with an `ssh` command in
 * front. For an admitted key the host's authorized_keys forced command (`sub-human authorize` / `admit`,
 * lib/remote/shim.js) decides what runs there and ignores the remote command named here; a login link (no forced
 * command: the person's own login to the host account) names the host's stable shim itself (remoteCommand).
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
 *       wrote into its own link file (lib/room/links.js), never from an invite:
 *         key         -i KEY -o IdentitiesOnly=yes          the link's own key (lib/remote/sshkeys.js linkKey)
 *         knownHosts  -o UserKnownHostsFile=F -o StrictHostKeyChecking=yes -o HostKeyAlias=ALIAS   the host key the
 *         alias       invite carried, pinned: no first-use prompt, nothing else accepted
 *         mux         -o ControlMaster=no -o ControlPath=<home>/ssh/cm-%C   ride a master `sub-human prime CODE` opened
 *                     (one MFA prompt for hours); with none open, ssh connects as usual. BatchMode stays on, so the
 *                     daemon never waits on a prompt and never becomes a master itself
 *       Over a login link (spec.login, `/sub-human join NAME USER@HOST CODE`: the person's own ssh login to the host's
 *       account is the admission, no invite) the remote command is the host's stable shim instead (remoteCommand), and
 *       no link option is added: the person's own keys, agent, ~/.ssh/config and known_hosts decide, BatchMode on
 *   loginSpec(dest, {via?, home?, link?}) -> Spec | null   a login link's transport: {kind: 'ssh', user, host,
 *       port?, via?, login: true, link, remoteHome?}. link: the link id this machine picks (12 hex, random by default;
 *       the host's server records the link under it, so `sub-human revoke` finds its serve process by its argv); home:
 *       the host's SUB_HUMAN_HOME when it is not ~/.sub-human (a plain absolute path). null when any part is not plain
 *   remoteCommand(spec, code) -> string   what ssh asks the host to run: `sub-human serve --stdio CODE` for an
 *       admitted key (its forced command ignores it), else (login) `"$HOME"/.sub-human/bin/serve --stdio CODE --link ID
 *       --login`, or `env SUB_HUMAN_HOME=H H/bin/serve …` with remoteHome. A forced-command key can never send --login:
 *       its line fixes the arguments (scripts/sub-human serve also refuses --login under SSH_ORIGINAL_COMMAND)
 *   loginCommand(spec) -> string     the plain `ssh [-p P] [-J V] user@host` a person runs once by hand (a host key to
 *       accept, a password or MFA to check)
 *   loginFailure(stderr, spec, code) -> string | null   why a login link cannot work until the person acts (an unknown
 *       or changed host key, a refused login, no shim or no room on the host): the link daemon stops with it (AUTH)
 *       instead of redialing; null for anything that may pass (a timeout, a refused connection)
 *   primeCommand(spec, code, {persist}?) -> [cmd, ...args]   the master: interactive (no BatchMode), -M -N -f
 *       -o ControlPersist=PERSIST (default 8h), the same link options and ControlPath
 *   enrollCommand(spec, code, {key, knownHosts, opts?}) -> [cmd, ...args]   a short code's enrollment (lib/remote/enroll.js):
 *       the room's public enrollment key, a fresh known_hosts filled with accept-new (Ed25519 only, unhashed), no
 *       mux; read back and compared with the host key the host vouches for inside the PAKE
 *   controlPath(home?) -> string   <home>/ssh/cm-%C
 *   kind = {parse, open, describe}   the `ssh` kind (./index.js register); open(spec, {code}) spawns command() over
 *                                  ./pipe.js (INVALID without a code)
 */

const path = require('node:path');
const { RoomError } = require('../../room/validate.js');

const SSH_USER = '[A-Za-z_][A-Za-z0-9_.-]{0,31}';
const SSH_HOST = '[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})';
const SSH_RE = new RegExp(`^(${SSH_USER})@(${SSH_HOST})(?::([0-9]{1,5}))?$`);
const HOP_RE = new RegExp(`^(?:${SSH_USER}@)?${SSH_HOST}(?::([0-9]{1,5}))?$`);
const LOCAL_PATH_RE = /^\/[^\0\n"'%]*$/;
const ALIAS_RE = /^[A-Za-z0-9._-]{1,64}$/;
const LINK_ID_RE = /^[0-9a-f]{12}$/;
const HOME_RE = /^\/[A-Za-z0-9_\/.@+,:-]+$/; // lib/remote/shim.js PLAIN_PATH_RE: nothing a remote shell expands

/**
 * @param {string} text   user@host[:port]
 * @returns {{user: string, host: string, port?: number} | null}
 */
function dest(text) {
  const m = SSH_RE.exec(String(text));
  if (!m) return null;
  const port = m[3] === undefined ? undefined : Number(m[3]);
  if (port !== undefined && !(port >= 1 && port <= 65535)) return null;
  return { user: m[1], host: m[2], ...(port ? { port } : {}) };
}

/**
 * @param {string} text
 * @returns {string | null}
 */
function jump(text) {
  const hops = String(text).split(',');
  if (hops.length > 4) return null;
  for (const h of hops) {
    const m = HOP_RE.exec(h);
    if (!m || (m[1] !== undefined && !(Number(m[1]) >= 1 && Number(m[1]) <= 65535))) return null;
  }
  return String(text);
}

/**
 * @param {string} rest
 * @returns {{user: string, host: string, port?: number, via?: string} | null}
 */
function parse(rest) {
  const [d, q, ...more] = String(rest).split('?');
  if (more.length) return null;
  const spec = dest(d);
  if (!spec || q === undefined) return spec;
  const m = /^via=(.+)$/.exec(q);
  const via = m && jump(m[1]);
  return via ? { ...spec, via } : null;
}

const at = d => `${d.user}@${d.host}${d.port ? `:${d.port}` : ''}`;

/**
 * @param {string} text
 * @param {{via?: string}} [opts]
 * @returns {string | null}
 */
function locator(text, { via } = {}) {
  const d = dest(text);
  if (!d || (via !== undefined && !jump(via))) return null;
  return `ssh:${at(d)}${via !== undefined ? `?via=${via}` : ''}`;
}

/** @returns {string} */
const controlPath = (h = require('../../home.js').home()) => path.join(path.resolve(h), 'ssh', 'cm-%C');

/** The spec, checked again; the link options its local fields ask for. */
function checked(spec, code) {
  const d = spec && dest(at(spec));
  if (!d) throw new RoomError('INVALID', 'the link\'s ssh destination is not a plain user@host[:port]');
  if (spec.via !== undefined && !jump(spec.via)) throw new RoomError('INVALID', 'the link\'s ProxyJump is not a plain [user@]host[:port] list');
  const { CODE_RE } = require('../../text.js');
  if (!CODE_RE.test(code)) throw new RoomError('INVALID', `invalid room code "${code}"`);
  const local = [];
  const file = (k, v) => { if (typeof v !== 'string' || !LOCAL_PATH_RE.test(v)) throw new RoomError('INVALID', `the link's ${k} is not a plain absolute path`); return v; };
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

/**
 * @param {{user: string, host: string, port?: number, via?: string, key?: string, knownHosts?: string, alias?: string, mux?: boolean}} spec
 * @param {string} code
 * @param {string[]} [opts]
 * @returns {string[]}
 */
function command(spec, code, opts = String(process.env.SUB_HUMAN_SSH_OPTS || '').split(/\s+/).filter(Boolean)) {
  const { local, tail } = checked(spec, code);
  const mux = spec.mux === true ? ['-o', 'ControlMaster=no'] : [];
  return ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', ...opts,
    ...mux, ...local, ...tail, remoteCommand(spec, code)];
}

/**
 * @param {{login?: boolean, link?: string, remoteHome?: string}} spec
 * @param {string} code
 * @returns {string}
 */
function remoteCommand(spec, code) {
  if (spec.login !== true) return `sub-human serve --stdio ${code}`;
  const args = `--stdio ${code} --link ${spec.link} --login`;
  return spec.remoteHome !== undefined
    ? `env SUB_HUMAN_HOME=${spec.remoteHome} ${spec.remoteHome}/bin/serve ${args}`
    : `"$HOME"/.sub-human/bin/serve ${args}`;
}

/**
 * @param {string} text   user@host[:port]
 * @param {{via?: string, home?: string, link?: string}} [o]
 * @returns {object | null}
 */
function loginSpec(text, { via, home, link = require('node:crypto').randomBytes(6).toString('hex') } = {}) {
  const d = dest(text);
  if (!d || (via !== undefined && !jump(via)) || (home !== undefined && !HOME_RE.test(String(home))) || !LINK_ID_RE.test(String(link))) return null;
  return { kind: 'ssh', ...d, ...(via !== undefined ? { via } : {}), login: true, link, ...(home !== undefined ? { remoteHome: path.resolve(home) } : {}) };
}

/** @returns {string} */
const loginCommand = spec => ['ssh', ...(spec.port ? ['-p', String(spec.port)] : []), ...(spec.via ? ['-J', spec.via] : []), `${spec.user}@${spec.host}`].join(' ');

/**
 * @param {string} stderr
 * @param {object} spec
 * @param {string} code
 * @returns {string | null}
 */
function loginFailure(stderr, spec, code) {
  const s = String(stderr || '');
  const where = `${spec.user}@${spec.host}`;
  const once = loginCommand(spec);
  const home = spec.remoteHome || '~/.sub-human';
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No (?:\S+ )?host key is known/i.test(s)) {
    return `ssh does not know ${where}'s host key yet (or it changed), and a link never answers ssh's prompt: run \`${once}\` once in a terminal, check and accept the key, then join again`;
  }
  if (/Permission denied/i.test(s)) {
    return `${where} refused your ssh login without a prompt (the link runs ssh with BatchMode: your keys or agent only, no password). Check that \`${once}\` logs in without a password; behind MFA, run sub-human prime ${code} first, then /sub-human NAME ${code}`;
  }
  if (/bin\/serve/.test(s) && /not found|No such file|Unknown command|can't open/i.test(s)) {
    return `${where} has no sub-human serve shim at ${home}/bin/serve: on that machine, open the room in Claude Code (/sub-human NAME), which writes it, or run sub-human doctor --fix there${spec.remoteHome ? '' : '; if its sub-human home is elsewhere, join with --home PATH'}`;
  }
  if (/^usage: sub-human serve --stdio CODE \[--link ID\]$/m.test(s)) {
    return `the sub-human on ${where} is older than links over an ssh login: update the plugin there (/plugin update sub-human), or join with an invite`;
  }
  if (/sub-human: no (plugin install|node)/.test(s)) return `${where}'s shim found no plugin or node: on that machine, start Claude Code once (or run sub-human doctor --fix there)`;
  const m = /^(no room "[^"]*"|room "[^"]*" is not hosted on this machine[^\n]*|sub-human serve --login: [^\n]*)$/m.exec(s);
  if (m) {
    return /^no room/.test(m[1]) ? `room ${code} is not open on ${where} (no room with that code under ${home}): check the code, or open the room there first`
      : /not hosted/.test(m[1]) ? `${where} only holds a copy of room ${code}; join through the machine that hosts it` : m[1];
  }
  return null;
}

/**
 * @param {object} spec
 * @param {string} code
 * @param {{persist?: string, opts?: string[]}} [o]
 * @returns {string[]}
 */
function primeCommand(spec, code, { persist = '8h', opts = String(process.env.SUB_HUMAN_SSH_OPTS || '').split(/\s+/).filter(Boolean) } = {}) {
  if (!/^[0-9]{1,5}[smhd]?$/.test(persist)) throw new RoomError('INVALID', `--persist "${persist}" is not a time (e.g. 8h)`);
  const { local, tail } = checked({ ...spec, mux: true }, code);
  return ['ssh', '-M', '-N', '-f', '-o', `ControlPersist=${persist}`, '-o', 'ServerAliveInterval=15', ...opts, ...local, ...tail];
}

/**
 * The joiner's ssh to a short code's enrollment door (lib/remote/enroll.js): the room's public enrollment key, and a
 * fresh known_hosts of its own that ssh fills with the host key it is shown (accept-new: there is no key to pin yet).
 * Ed25519 host keys only, never hashed or updated, so the joiner can read back exactly the key ssh verified and compare
 * it with the one the host vouches for inside the PAKE channel. These options come first, so neither the joiner's
 * SUB_HUMAN_SSH_OPTS nor its ~/.ssh/config can change them (ssh takes the first value of an option).
 * @returns {string[]}
 */
function enrollCommand(spec, code, { key, knownHosts, opts = String(process.env.SUB_HUMAN_SSH_OPTS || '').split(/\s+/).filter(Boolean) }) {
  const { tail } = checked(spec, code);
  const file = (k, v) => { if (typeof v !== 'string' || !LOCAL_PATH_RE.test(v)) throw new RoomError('INVALID', `the enrollment ${k} is not a plain absolute path`); return v; };
  return ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-i', file('key', key), '-o', `UserKnownHostsFile=${file('known_hosts', knownHosts)}`,
    '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'StrictHostKeyChecking=accept-new', '-o', `HostKeyAlias=sub-human-enroll-${code}`, '-o', 'HostKeyAlgorithms=ssh-ed25519',
    '-o', 'UpdateHostKeys=no', '-o', 'HashKnownHosts=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15', ...opts, ...tail, `sub-human serve --enroll ${code}`];
}

const kind = {
  parse,
  open(spec, ctx = {}) {
    if (!ctx.code) throw new RoomError('INVALID', 'an ssh transport connects to a room: open(spec, {code})');
    if (spec.mux === true) require('node:fs').mkdirSync(path.dirname(controlPath()), { recursive: true, mode: 0o700 });
    const [cmd, ...args] = command(spec, ctx.code);
    return require('./pipe.js').spawn(cmd, args);
  },
  describe: spec => `ssh ${at(spec)}${spec.via ? ` via ${spec.via}` : ''}${spec.login === true ? ' (your ssh login)' : ''}`,
};

module.exports = { dest, jump, parse, locator, command, enrollCommand, remoteCommand, loginSpec, loginCommand, loginFailure, primeCommand, controlPath, kind };
