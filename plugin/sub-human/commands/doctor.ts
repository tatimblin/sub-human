// `/sub-human doctor`: one line per check, each `ok`, `fix` (with what to do) or `later` (not checked yet).
import { SOCKET_MAX, socketFile } from '../core/api.js';
import { parseContract } from '../core/cc/contract.js';
import type { Ctx, Verb } from './types.js';
import { say } from './types.js';

type Line = readonly ['ok' | 'fix' | 'later', string];

export const doctor: Verb = async (_args, ctx) => {
  const lines: Line[] = [
    node(ctx.nodeVersion),
    socket(ctx.config.home),
    await moduleOn(ctx),
    await claudeCode(ctx),
    await rooms(ctx),
    ssh(),
    tailscale(),
    ...ctx.config.problems.map((p): Line => ['fix', p]),
  ];
  return say(lines.map(([mark, text]) => `${mark.padEnd(5)} ${text}`).join('\n'));
};

/** Node 22.18+ or 24.3+ strips types with no flag; 23 never had import.meta.main. */
export function nodeRuns(version: string): boolean {
  const [maj = 0, min = 0] = version.replace(/^v/, '').split('.').map(Number);
  return maj >= 25 || (maj === 24 && min >= 3) || (maj === 22 && min >= 18);
}
function node(version: string): Line {
  return nodeRuns(version) ? ['ok', `node ${version}`] : ['fix', `node ${version} can't run sub-human; install Node 22.18+ or 24.3+ and restart claude`];
}

async function moduleOn(ctx: Ctx): Promise<Line> {
  const s = await ctx.daemon.status();
  if (!s.ok) return ['fix', `the sub-human daemon did not answer (${s.error}); restart claude`];
  return s.value.sessions > 0
    ? ['ok', `hooks module on in ${s.value.sessions} session${s.value.sessions === 1 ? '' : 's'} here`]
    : ['fix', 'no session\'s hooks module has reached the daemon; check that plugin modules are allowed, then restart claude'];
}

/**
 * The version the plugin was checked on. A hook's input and environment don't carry the running version, and the
 * `claude` on PATH may not be the one running, so none is guessed.
 */
async function claudeCode(ctx: Ctx): Promise<Line> {
  const text = await ctx.readFile('core/cc/contract.json');
  let json: unknown = null;
  try { json = JSON.parse(text ?? 'null'); } catch { /* reported below */ }
  const c = parseContract(json);
  return c.ok ? ['ok', `sub-human is checked on Claude Code ${c.value.probed}`] : ['fix', 'sub-human\'s contract.json does not read; reinstall the plugin'];
}

/** The daemon listens on `<home>/daemon.sock`, and a socket's path has a length limit. */
function socket(home: string): Line {
  const bytes = new TextEncoder().encode(socketFile(home)).length;
  return bytes <= SOCKET_MAX
    ? ['ok', `home ${home}`]
    : ['fix', `the home's path is too long for the daemon's socket (${bytes} bytes, at most ${SOCKET_MAX}); set SUB_HUMAN_HOME to a shorter path`];
}

async function rooms(ctx: Ctx): Promise<Line> {
  const codes = await ctx.rooms.codes();
  const broken: string[] = [];
  for (const code of codes) {
    const s = await ctx.rooms.state(code);
    if (!s.ok) broken.push(`${code} (${s.error})`);
  }
  if (broken.length) return ['fix', `room logs that don't read: ${broken.join(', ')}`];
  return ['ok', `${codes.length} room${codes.length === 1 ? '' : 's'} here, every log intact`];
}

/** Joining over ssh needs the host's sshd to allow TCP forwarding (R29b). */
function ssh(): Line { return ['later', 'ssh forwarding: checked once joining from another machine lands']; }
/** The default invite needs Tailscale on the host (R29a). */
function tailscale(): Line { return ['later', 'Tailscale: checked once joining from another machine lands']; }
