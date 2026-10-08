'use strict';
/**
 * plugin/sub-human/lib/remote/transports/ssh.js: the ssh kind, the pipe kind (./pipe.js) with an `ssh` command in
 * front. The host's authorized_keys forced command (`sub-human authorize`, lib/remote/shim.js) decides what runs
 * there; the remote command named here is ignored by it.
 *
 *   dest(text) -> {user, host, port?} | null   a plain user@host[:port]: a POSIX-ish user name and a host name or
 *                                  IPv4 address. Neither part may start with "-" (an option) or hold spaces, quotes,
 *                                  "%" (ssh token expansion) or "@", so an invite can name neither an ssh option nor
 *                                  a command
 *   locator(text) -> 'ssh:user@host[:port]' | null
 *   command(spec, code, opts?) -> [cmd, ...args]
 *       ssh -T -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=2 [opts] [-p port] -- user@host
 *       "sub-human serve --stdio CODE". The spec is checked again (a link file edited by hand: INVALID). opts
 *       (default: SUB_HUMAN_SSH_OPTS split on spaces) are extra ssh options from this machine's own environment,
 *       never from an invite: for tests and setups that need -i KEY, -F FILE or a known_hosts file
 *   kind = {parse, open, describe}   the `ssh` kind (./index.js register): parse = dest; open(spec, {code}) spawns
 *                                  command() over ./pipe.js (INVALID without a code)
 */

const { RoomError } = require('../../room/validate.js');

const SSH_USER = '[A-Za-z_][A-Za-z0-9_.-]{0,31}';
const SSH_HOST = '[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})';
const SSH_RE = new RegExp(`^(${SSH_USER})@(${SSH_HOST})(?::([0-9]{1,5}))?$`);

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

const at = d => `${d.user}@${d.host}${d.port ? `:${d.port}` : ''}`;

/**
 * @param {string} text
 * @returns {string | null}
 */
function locator(text) {
  const d = dest(text);
  return d ? `ssh:${at(d)}` : null;
}

/**
 * @param {{user: string, host: string, port?: number}} spec
 * @param {string} code
 * @param {string[]} [opts]
 * @returns {string[]}
 */
function command(spec, code, opts = String(process.env.SUB_HUMAN_SSH_OPTS || '').split(/\s+/).filter(Boolean)) {
  const d = spec && dest(at(spec));
  if (!d) throw new RoomError('INVALID', 'the link\'s ssh destination is not a plain user@host[:port]');
  const { CODE_RE } = require('../../text.js');
  if (!CODE_RE.test(code)) throw new RoomError('INVALID', `invalid room code "${code}"`);
  return ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', ...opts,
    ...(d.port ? ['-p', String(d.port)] : []), '--', `${d.user}@${d.host}`, `sub-human serve --stdio ${code}`];
}

const kind = {
  parse: dest,
  open(spec, ctx = {}) {
    if (!ctx.code) throw new RoomError('INVALID', 'an ssh transport connects to a room: open(spec, {code})');
    const [cmd, ...args] = command(spec, ctx.code);
    return require('./pipe.js').spawn(cmd, args);
  },
  describe: spec => `ssh ${at(spec)}`,
};

module.exports = { dest, locator, command, kind };
