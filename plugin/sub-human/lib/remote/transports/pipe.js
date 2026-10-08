'use strict';
/**
 * plugin/sub-human/lib/remote/transports/pipe.js: frames over a pair of pipes: a child process's stdio on the
 * client side, this process's stdin/stdout on the server side (`bin/sub-human serve --stdio CODE`). The
 * two-home test spawns the server with the host's SUB_HUMAN_HOME; SSH is the same with
 * `ssh -T -o BatchMode=yes … -- USER@HOST` as the command (lib/remote/link.js sshCommand). PR4 of docs/archive/REMOTE-PLAN.md.
 *
 *   spawn(cmd, args, {env?, cwd?}) -> Transport   the client end; the child's exit closes it (./index.js
 *                                                 documents Transport). stderr passes through to ours. close()
 *                                                 ends the child's stdin and stops it
 *   stdio() -> Transport                           the server end over process.stdin / process.stdout; nothing
 *                                                 else may write to stdout while it is open. stdin's end closes it
 */

const { spawn: spawnChild } = require('node:child_process');
const { lineTransport } = require('./index.js');

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

module.exports = { spawn, stdio };
