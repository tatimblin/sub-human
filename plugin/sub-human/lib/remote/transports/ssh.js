'use strict';
/**
 * plugin/sub-human/lib/remote/transports/ssh.js: the ssh kind, the pipe kind (./pipe.js) with an `ssh` command in
 * front. The host's authorized_keys forced command (`sub-human authorize` / `admit`, lib/remote/shim.js) decides
 * what runs there; the remote command named here is ignored by it.
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
 *   primeCommand(spec, code, {persist}?) -> [cmd, ...args]   the master: interactive (no BatchMode), -M -N -f
 *       -o ControlPersist=PERSIST (default 8h), the same link options and ControlPath
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
    ...mux, ...local, ...tail, `sub-human serve --stdio ${code}`];
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

const kind = {
  parse,
  open(spec, ctx = {}) {
    if (!ctx.code) throw new RoomError('INVALID', 'an ssh transport connects to a room: open(spec, {code})');
    if (spec.mux === true) require('node:fs').mkdirSync(path.dirname(controlPath()), { recursive: true, mode: 0o700 });
    const [cmd, ...args] = command(spec, ctx.code);
    return require('./pipe.js').spawn(cmd, args);
  },
  describe: spec => `ssh ${at(spec)}${spec.via ? ` via ${spec.via}` : ''}`,
};

module.exports = { dest, jump, parse, locator, command, primeCommand, controlPath, kind };
