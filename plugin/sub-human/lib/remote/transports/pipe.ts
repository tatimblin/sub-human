/**
 * plugin/sub-human/lib/remote/transports/pipe.ts: frames over a pair of pipes: a child process's stdio on the
 * client side, this process's stdin/stdout on the server side (`scripts/sub-human serve --stdio CODE`). The
 * two-home test spawns the server with the host's SUB_HUMAN_HOME; SSH is the same with
 * `ssh -T -o BatchMode=yes … -- USER@HOST` as the command (./ssh.ts).
 *
 *   spawn(cmd, args, {env?, cwd?}) -> Transport   the client end; the child's exit closes it (./index.ts
 *                                                 documents Transport). stderr passes through to ours, and its
 *                                                 last 2 KiB stay readable as transport.stderr() (the link daemon
 *                                                 reads why ssh gave up). close() ends the child's stdin and stops it
 *   stdio() -> Transport                           the server end over process.stdin / process.stdout; nothing
 *                                                 else may write to stdout while it is open. stdin's end closes it
 *   kind = {parse, open, describe}                 the `pipe` kind (./index.ts register):
 *       parse(rest)  locator `pipe:<home>` (an absolute path) -> {home}: a room hosted under another home here
 *       open(spec, ctx)  with ctx.code (the link daemon): this plugin's own `sub-human serve --stdio CODE` with
 *                    SUB_HUMAN_HOME=spec.home; a cmd in the spec is then ignored. Without: spec.cmd [bin, ...args]
 *                    with spec.env / spec.cwd (tests)
 */

import path from 'node:path';
import { spawn as spawnChild } from 'node:child_process';
import { lineTransport } from './index.ts';
import { RoomError } from '../../room/validate.ts';
import type { KindEntry, OpenCtx, PipeSpec, Transport } from '../types-rest.ts';

const BIN = path.join(import.meta.dirname, '..', '..', '..', 'scripts', 'sub-human');

function spawn(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Transport {
  const child = spawnChild(cmd, args, { env: opts.env || process.env, cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const { transport, receive, end } = lineTransport({
    write: line => child.stdin.write(line),
    shut: () => { child.stdin.end(); child.kill(); },
    ready: () => !child.stdin.writableNeedDrain,
  });
  let tail = '';
  child.stderr.on('data', (d: Buffer) => { process.stderr.write(d); tail = (tail + d).slice(-2048); });
  child.stderr.on('error', () => { /* the child is gone */ });
  transport.stderr = () => tail;
  child.stdin.on('error', end); // the child is gone: its exit closes us too
  child.stdout.on('data', receive);
  child.on('exit', end);
  child.on('error', end);
  return transport;
}

function stdio(): Transport {
  const { transport, receive, end } = lineTransport({
    write: line => process.stdout.write(line),
    shut: () => process.stdin.destroy(),
    ready: () => !process.stdout.writableNeedDrain,
  });
  process.stdin.on('data', receive);
  process.stdin.on('end', end);
  process.stdout.on('error', end); // the reader is gone
  return transport;
}

const kind: Required<KindEntry<PipeSpec>> = {
  parse: rest => (/^\/.*$/.test(rest) ? { home: rest } : null),
  open(spec, ctx: OpenCtx = {}) {
    if (ctx.code) {
      if (typeof spec.home !== 'string' || !spec.home.startsWith('/')) throw new RoomError('INVALID', 'the link\'s pipe names no home');
      return spawn(process.execPath, [BIN, 'serve', '--stdio', ctx.code], { env: { ...process.env, SUB_HUMAN_HOME: spec.home } });
    }
    if (!Array.isArray(spec.cmd) || !spec.cmd.length) throw new RoomError('INVALID', 'a pipe needs cmd [bin, ...args] or a home');
    return spawn(spec.cmd[0], spec.cmd.slice(1), { env: spec.env, cwd: spec.cwd });
  },
  describe: spec => (spec.home ? `pipe ${spec.home}` : `pipe ${spec.cmd && spec.cmd[0]}`),
};

export { spawn, stdio, kind };
