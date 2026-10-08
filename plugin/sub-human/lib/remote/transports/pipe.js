'use strict';
/**
 * plugin/sub-human/lib/remote/transports/pipe.js: frames over a pair of pipes: a child process's stdio on the
 * client side, this process's stdin/stdout on the server side (`scripts/sub-human serve --stdio CODE`). The
 * two-home test spawns the server with the host's SUB_HUMAN_HOME; SSH is the same with
 * `ssh -T -o BatchMode=yes … -- USER@HOST` as the command (./ssh.js).
 *
 *   spawn(cmd, args, {env?, cwd?}) -> Transport   the client end; the child's exit closes it (./index.js
 *                                                 documents Transport). stderr passes through to ours. close()
 *                                                 ends the child's stdin and stops it
 *   stdio() -> Transport                           the server end over process.stdin / process.stdout; nothing
 *                                                 else may write to stdout while it is open. stdin's end closes it
 *   kind = {parse, open, describe}                 the `pipe` kind (./index.js register):
 *       parse(rest)  locator `pipe:<home>` (an absolute path) -> {home}: a room hosted under another home here
 *       open(spec, ctx)  with ctx.code (the link daemon): this plugin's own `sub-human serve --stdio CODE` with
 *                    SUB_HUMAN_HOME=spec.home; a cmd in the spec is then ignored. Without: spec.cmd [bin, ...args]
 *                    with spec.env / spec.cwd (tests)
 */

const path = require('node:path');
const { spawn: spawnChild } = require('node:child_process');
const { lineTransport } = require('./index.js');
const { RoomError } = require('../../room/validate.js');

const BIN = path.join(__dirname, '..', '..', '..', 'scripts', 'sub-human');

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{env?: object, cwd?: string}} [opts]
 * @returns {object}
 */
function spawn(cmd, args, opts = {}) {
  const child = spawnChild(cmd, args, { env: opts.env || process.env, cwd: opts.cwd, stdio: ['pipe', 'pipe', 'inherit'] });
  const { transport, receive, end } = lineTransport({
    write: line => child.stdin.write(line),
    shut: () => { child.stdin.end(); child.kill(); },
  });
  child.stdin.on('error', end); // the child is gone: its exit closes us too
  child.stdout.on('data', receive);
  child.on('exit', end);
  child.on('error', end);
  return transport;
}

/** @returns {object} */
function stdio() {
  const { transport, receive, end } = lineTransport({
    write: line => process.stdout.write(line),
    shut: () => process.stdin.destroy(),
  });
  process.stdin.on('data', receive);
  process.stdin.on('end', end);
  process.stdout.on('error', end); // the reader is gone
  return transport;
}

const kind = {
  parse: rest => (/^\/.*$/.test(rest) ? { home: rest } : null),
  open(spec, ctx = {}) {
    if (ctx.code) {
      if (typeof spec.home !== 'string' || !spec.home.startsWith('/')) throw new RoomError('INVALID', 'the link\'s pipe names no home');
      return spawn(process.execPath, [BIN, 'serve', '--stdio', ctx.code], { env: { ...process.env, SUB_HUMAN_HOME: spec.home } });
    }
    if (!Array.isArray(spec.cmd) || !spec.cmd.length) throw new RoomError('INVALID', 'a pipe needs cmd [bin, ...args] or a home');
    return spawn(spec.cmd[0], spec.cmd.slice(1), { env: spec.env, cwd: spec.cwd });
  },
  describe: spec => (spec.home ? `pipe ${spec.home}` : `pipe ${spec.cmd && spec.cmd[0]}`),
};

module.exports = { spawn, stdio, kind };
