'use strict';
/**
 * plugin/sub-human/lib/remote/transports/pipe.js: frames over a pair of pipes: a child process's stdio on the
 * client side, this process's stdin/stdout on the server side (`bin/sub-human serve --stdio CODE`). The
 * two-home test spawns the server with the host's SUB_HUMAN_HOME; SSH later is the same with
 * `ssh -T -o BatchMode=yes HOST` in front of the command. Stub: filled in by PR4 of docs/next/REMOTE-PLAN.md.
 *
 *   spawn(cmd, args, {env?, cwd?}) -> Transport   the client end; the child's exit closes it (./index.js
 *                                                 documents Transport). stderr passes through to ours
 *   stdio() -> Transport                           the server end over process.stdin / process.stdout; nothing
 *                                                 else may write to stdout while it is open
 */

const todo = what => { throw new Error(`sub-human: ${what} is not implemented yet (docs/next/REMOTE-PLAN.md, PR4)`); };

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{env?: object, cwd?: string}} [opts]
 * @returns {object}
 */
function spawn(cmd, args, opts = {}) { return todo(`transports/pipe.spawn(${cmd}, ${Array.isArray(args) ? args.length : 0} args, cwd ${opts.cwd || '.'})`); }

/** @returns {object} */
function stdio() { return todo('transports/pipe.stdio()'); }

module.exports = { spawn, stdio };
