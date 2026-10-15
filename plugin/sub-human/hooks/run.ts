#!/usr/bin/env node
/**
 * plugin/sub-human/hooks/run.ts: the one node entry of every hook: `node --import <root>/hooks/compile-cache.js
 * <root>/hooks/run.ts <handler>` (the two hooks.json command hooks; the hooks module's $.process.run, mod/core/shim.ts
 * shimArgv). It reads stdin once, loads only hooks/handlers/<handler>.ts (lazily: a handler that answers early loads
 * nothing else), and writes that handler's one Reply at the edge (hooks/reply.ts render, write).
 *
 * In: argv[2] a name in HANDLERS; stdin the hook payload (JSON; empty, or JSON that is not an object, reads as {}).
 * Run by the hooks module (SUB_HUMAN_VIA=module, mod/core/shim.ts shimEnv) a handler gets CLAUDE_PID = this process's
 * parent, the claude process ($.process.run children get no CLAUDE_PID of their session: cc CONTRACT process-run-stdin),
 * as Claude Code's own command hooks have it. join keeps its own rule (it believes the parent only with the nonce).
 * Failure: a stdin that does not parse, or a throw, is answered by the handler's fail() (raw is what came), else exit 1;
 * the error is logged to stderr (Claude Code shows it to the person only) unless fail() said why on stderr itself. The
 * out() lines a handler wrote before it threw still go out. An unknown handler is exit 1.
 */
import fs from 'node:fs';
import tty from 'node:tty';
import { captureAsync, logError, render, write } from './reply.ts';
import type { Handler, Reply } from './types.ts';

export const HANDLERS: readonly string[] = Object.freeze([
  'join', 'session-end', 'mod-hello', 'prompt', 'at-room', 'consent', 'tasks', 'presence',
  'row-guard', 'row-map', 'row-hold', 'row-rewake', 'session-restore',
]);

async function main(name: string | undefined): Promise<void> {
  if (!name || !HANDLERS.includes(name)) {
    process.stderr.write(`sub-human: no hook handler "${String(name).slice(0, 40)}"\n`);
    process.exitCode = 1;
    return;
  }
  let raw = '';
  if (!tty.isatty(0)) { try { raw = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ } }
  let input: object = {};
  let parseError: unknown = null;
  if (raw.trim()) {
    try {
      const v: unknown = JSON.parse(raw);
      input = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch (err) { parseError = err; }
  }
  if (process.env.SUB_HUMAN_VIA === 'module' && !process.env.CLAUDE_PID && name !== 'join') process.env.CLAUDE_PID = String(process.ppid);
  const handler: Handler = await import(`./handlers/${name}.ts`);
  const got = await captureAsync(() => {
    if (parseError) throw parseError;
    return handler.handle(input as never, raw);
  });
  let reply: Reply | null | void = got.value;
  let exit = 0;
  if (got.error) {
    try { reply = handler.fail ? handler.fail(got.error, input as never, raw) : null; } catch (err) { logError(err, `${name} fail`); reply = null; }
    if (!handler.fail) exit = 1;
    // a fail() that says why on stderr is the report (the task gate's block reason); otherwise the error is logged
    if (!(reply && reply.kind === 'classic' && reply.stderr)) logError(got.error, name);
  }
  const r = render(reply);
  r.outputs = [...got.outputs, ...r.outputs];
  if (exit && !r.exit) r.exit = exit;
  write(r);
}

if (import.meta.main) await main(process.argv[2]);
