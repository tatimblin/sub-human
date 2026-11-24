// sub-human's one node entry, `node --import <plugin>/resolve-ts.ts <plugin>/cli.ts ...`:
//   hook HOOK               a command hook (hooks/node.sh runs it): the payload on stdin, the Reply on stdout. On
//                           success nothing goes to stderr; a throw is one stderr line (the person's only) and exit 1.
//   doctor|help [--home D]  a person at a terminal, for when Claude Code can't run /room. The other verbs act for
//                           a session, so they run only as /room.
// Each hook and verb loads only what it needs: the verbs and the store are imported where they run.
import fs from 'node:fs';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { FROM_MODULE, KNOBS, readConfig } from './config.js';
import { nodeCtx } from './commands/context.js';
import { daemonFor } from './commands/daemon.js';
import type { MakeCtx, Reply } from './commands/hooks.js';
import { HOOKS, isHook } from './commands/hooks.js';
import type { Ctx } from './commands/types.js';

export const USAGE = 'usage: cli.ts doctor|help [--home DIR]';

/**
 * A run the module started whose home didn't arrive: answered with one line, so it never falls back to the default
 * home (another sub-human's, or a real one a test must not touch).
 */
export function homeLost(env: Readonly<Record<string, string | undefined>>): Reply | null {
  if (!env[FROM_MODULE] || env[HOME_KNOB]) return null;
  return { out: { decision: 'block', reason: "sub-human: nothing ran: the command didn't get this session's home. Type it again." }, exit: 0 };
}
const HOME_KNOB = KNOBS[0];

export async function hook(name: string | undefined, stdin: string, ctx: MakeCtx): Promise<Reply> {
  if (!isHook(name)) return { err: `sub-human: no hook ${String(name).slice(0, 40)}`, exit: 1 };
  let input: unknown = null;
  try { input = JSON.parse(stdin); } catch { return { exit: 0 }; }
  return HOOKS[name](input, ctx);
}

/** What a person asked for at the terminal (argv after node and the script), or what's wrong with it. */
export function parse(argv: readonly string[]): { verb: 'doctor' | 'help'; home?: string } | { error: string } {
  const p = read(argv);
  if (p instanceof Error) return { error: p.message };
  const [verb = 'help', ...rest] = p.values.help ? ['help'] : p.positionals;
  if ((verb !== 'doctor' && verb !== 'help') || rest.length) return { error: `${[verb, ...rest].join(' ')}: not a terminal command` };
  return { verb, ...(p.values.home !== undefined && { home: p.values.home }) };
}

const OPTIONS = { home: { type: 'string' }, help: { type: 'boolean', short: 'h' } } as const;
function read(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], allowPositionals: true, options: OPTIONS });
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

export async function terminal(argv: readonly string[], home: string, ctx: (home: string) => Ctx): Promise<{ out: string; exit: number }> {
  const p = parse(argv);
  if ('error' in p) return { out: `${p.error}\n${USAGE}`, exit: 2 };
  const verb = p.verb === 'doctor' ? (await import('./commands/doctor.js')).doctor : (await import('./commands/help.js')).help;
  const a = await verb([], ctx(p.home ?? home));
  return { out: a.text, exit: 0 };
}

if (import.meta.main) {
  const config = readConfig(process.env, os.homedir());
  const make = (home: string, session: string, cwd: string): Ctx =>
    nodeCtx({ config: { ...config, home }, session, cwd, daemon: daemonFor(home) });
  const [first, ...rest] = process.argv.slice(2);
  if (first === 'hook') {
    let r: Reply;
    const lost = homeLost(process.env);
    if (lost) r = lost;
    else try {
      r = await hook(rest[0], fs.readFileSync(0, 'utf8'), (session, cwd) => make(config.home, session, cwd));
    } catch (e) {
      r = { err: `sub-human: the hook failed (${e instanceof Error ? e.message : String(e)})`, exit: 1 };
    }
    if (r.out) process.stdout.write(`${JSON.stringify(r.out)}\n`);
    if (r.err !== undefined) process.stderr.write(`${r.err}\n`);
    process.exitCode = r.exit;
  } else {
    const r = await terminal(process.argv.slice(2), config.home, home => make(home, 'terminal', process.cwd()));
    (r.exit ? process.stderr : process.stdout).write(`${r.out}\n`);
    process.exitCode = r.exit;
  }
}
