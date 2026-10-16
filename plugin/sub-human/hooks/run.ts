#!/usr/bin/env node
/**
 * plugin/sub-human/hooks/run.ts: the one node entry of every hook: `node --import <root>/hooks/compile-cache.js
 * <root>/hooks/run.ts <handler>` (the two hooks.json command hooks; the hooks module's $.process.run, mod/core/shim.ts
 * shimArgv). It reads stdin once, loads only hooks/handlers/<handler>.ts (lazily: a handler that answers early loads
 * nothing else), and writes that handler's one Reply at the edge (hooks/reply.ts render, write).
 *
 * In: argv[2] a name in HANDLERS; stdin the hook payload (JSON; empty, or JSON that is not an object, reads as {}; a
 * base field (types.ts HookBase) that is not a string is dropped). Each handler gets the input type its module declares
 * (HANDLERS: LOADERS, checked as Handler<its input>).
 * Run by the hooks module (SUB_HUMAN_VIA=module, mod/core/shim.ts shimEnv) a handler gets CLAUDE_PID = this process's
 * parent, the claude process ($.process.run children get no CLAUDE_PID of their session: cc CONTRACT process-run-stdin),
 * as Claude Code's own command hooks have it. join keeps its own rule (it believes the parent only with the nonce).
 * Failure: a stdin that does not parse, or a throw, is answered by the handler's fail() (raw is what came), else exit 1;
 * the error is logged to stderr (Claude Code shows it to the person only) unless fail() said why on stderr itself. A
 * handler that fails to load is caught the same way (no fail(): exit 1). The
 * out() lines a handler wrote before it threw still go out. An unknown handler is exit 1.
 */
import fs from 'node:fs';
import tty from 'node:tty';
import { captureAsync, logError, render, write } from './reply.ts';
import type { Handler, HookBase, Reply } from './types.ts';

/** Each handler's module, loaded only when it runs (a handler that answers early loads nothing else). */
const LOADERS = {
  join: () => import('./handlers/join.ts'),
  'session-end': () => import('./handlers/session-end.ts'),
  'mod-hello': () => import('./handlers/mod-hello.ts'),
  prompt: () => import('./handlers/prompt.ts'),
  'at-room': () => import('./handlers/at-room.ts'),
  consent: () => import('./handlers/consent.ts'),
  tasks: () => import('./handlers/tasks.ts'),
  presence: () => import('./handlers/presence.ts'),
  'row-guard': () => import('./handlers/row-guard.ts'),
  'row-map': () => import('./handlers/row-map.ts'),
  'row-hold': () => import('./handlers/row-hold.ts'),
  'row-rewake': () => import('./handlers/row-rewake.ts'),
  'session-restore': () => import('./handlers/session-restore.ts'),
};
type Name = keyof typeof LOADERS;
/** A handler's stdin type: its module's own (handle's first parameter). */
type InputOf<K extends Name> = Parameters<Awaited<ReturnType<(typeof LOADERS)[K]>>['handle']>[0];
/** The table as run() reads it: each module checked to be a Handler of its own input (fail's included). */
const TABLE: { [K in Name]: () => Promise<Handler<InputOf<K>>> } = LOADERS;

export const HANDLERS: readonly string[] = Object.freeze(Object.keys(LOADERS));
function isName(n: unknown): n is Name { return typeof n === 'string' && Object.hasOwn(LOADERS, n); }

/** The base fields (types.ts HookBase), each a string when present. */
const BASE_KEYS = ['session_id', 'transcript_path', 'cwd', 'prompt_id', 'permission_mode', 'agent_id', 'agent_type', 'hook_event_name'] as const;
/** A payload as the handlers get it: an object (else {}), any base field that is not a string dropped (no handler
 * reads one: each checks before use). The object is the parsed one, its other fields as they came. Checked here by
 * hand, not with lib/decode.ts: a hook loads only its handler's modules (test/hooks/consent.node-test.ts). */
function payload(v: unknown): HookBase {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const o = v as Record<string, unknown>; // a parsed JSON object
  for (const k of BASE_KEYS) if (o[k] !== undefined && typeof o[k] !== 'string') delete o[k];
  return o; // every base field a string or absent
}

async function main(name: string | undefined): Promise<void> {
  if (!isName(name)) {
    process.stderr.write(`sub-human: no hook handler "${String(name).slice(0, 40)}"\n`);
    process.exitCode = 1;
    return;
  }
  let raw = '';
  if (!tty.isatty(0)) { try { raw = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ } }
  let input: HookBase = {};
  let parseError: Error | null = null;
  if (raw.trim()) {
    try { input = payload(JSON.parse(raw)); } catch (err) { parseError = err instanceof Error ? err : new Error(String(err)); } // a SyntaxError
  }
  if (process.env.SUB_HUMAN_VIA === 'module' && !process.env.CLAUDE_PID && name !== 'join') process.env.CLAUDE_PID = String(process.ppid);
  await run(name, input, raw, parseError);
}

async function run<K extends Name>(name: K, base: HookBase, raw: string, parseError: Error | null): Promise<void> {
  // The handler's own fields are as Claude Code (or the module) sent them: its input type makes each optional, and it
  // checks each before use. The base fields are checked above.
  const input = base as InputOf<K>;
  // the import inside the capture: a handler that fails to load is logged like a throw, and exits 1 (a gate's caller
  // fails closed on any exit but 0 and 2: mod/tasks.ts)
  const loaded: { h: Handler<InputOf<K>> | null } = { h: null };
  const got = await captureAsync(async () => {
    const h = loaded.h = await TABLE[name]();
    if (parseError) throw parseError;
    return h.handle(input, raw);
  });
  let reply: Reply | null | void = got.value;
  let exit = 0;
  if (got.threw) {
    const { h } = loaded;
    try { reply = h && h.fail ? h.fail(got.error, input, raw) : null; } catch (err) { logError(err, `${name} fail`); reply = null; }
    if (!h || !h.fail) exit = 1;
    // a fail() that says why on stderr is the report (the task gate's block reason); otherwise the error is logged
    if (!(reply && reply.kind === 'classic' && reply.stderr)) logError(got.error, name);
  }
  const r = render(reply);
  r.outputs = [...got.outputs, ...r.outputs];
  if (exit && !r.exit) r.exit = exit;
  write(r);
}

if (import.meta.main) await main(process.argv[2]);
