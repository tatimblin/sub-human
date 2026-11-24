// `/room doctor`: one line per check, each `ok` or `fix` (with what to do).
import { SOCKET_MAX, socketFile } from '../core/api.js';
import { parseContract } from '../core/cc/contract.js';
import type { Ctx, Verb } from './types.js';
import { say } from './types.js';

type Line = readonly ['ok' | 'fix', string];

export const doctor: Verb = async (_args, ctx) => {
  const lines: Line[] = [
    node(ctx.nodeVersion),
    socket(ctx.config.home),
    ...await writable(ctx),
    await moduleOn(ctx),
    await claudeCode(ctx),
    await rooms(ctx),
    await ssh(ctx),
    await tailscale(ctx),
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

/** A daemon that can't write to the home is ended by the next command that writes (net/daemon/client.ts ensure). */
async function writable(ctx: Ctx): Promise<Line[]> {
  const s = await ctx.daemon.status();
  const why = s.ok ? s.value.unwritable : undefined;
  return why === undefined ? [] : [['fix', `sub-human can't write to ${ctx.config.home} (${why}); the next /room command starts it again`]];
}

async function moduleOn(ctx: Ctx): Promise<Line> {
  const s = await ctx.daemon.status();
  if (!s.ok) return ['fix', `sub-human did not answer (${s.error}); restart claude`];
  return s.value.sessions > 0
    ? ['ok', `hooks module on in ${s.value.sessions} session${s.value.sessions === 1 ? '' : 's'} here`]
    : ['fix', 'no session\'s hooks module has reached sub-human; check that plugin hooks modules are allowed, then restart claude'];
}

/** The version the plugin was checked on, against the versions this machine's sessions told the daemon they run. */
async function claudeCode(ctx: Ctx): Promise<Line> {
  const text = await ctx.readFile('core/cc/contract.json');
  let json: unknown = null;
  try { json = JSON.parse(text ?? 'null'); } catch { /* reported below */ }
  const c = parseContract(json);
  if (!c.ok) return ['fix', 'sub-human\'s contract.json does not read; reinstall the plugin'];
  const checked = `sub-human is checked on Claude Code ${c.value.probed}`;
  const s = await ctx.daemon.status();
  const other = s.ok ? s.value.cc.filter(x => x !== c.value.probed) : [];
  return ['ok', other.length ? `${checked}; sessions here run ${other.join(', ')}, which it was not checked on` : checked];
}

/** The daemon listens on `<home>/daemon.sock`, and a socket's path has a length limit. */
function socket(home: string): Line {
  const bytes = new TextEncoder().encode(socketFile(home)).length;
  return bytes <= SOCKET_MAX
    ? ['ok', `home ${home}`]
    : ['fix', `the home's path is too long for sub-human (${bytes} bytes, at most ${SOCKET_MAX}); set SUB_HUMAN_HOME to a shorter path`];
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

/** Joining this machine over ssh needs its sshd to allow TCP forwarding (R29b): `ssh -W` is a local forward. */
async function ssh(ctx: Ctx): Promise<Line> {
  const config = await ctx.run('sshd', ['-G'], ctx.cwd);
  const allow = config && /^allowtcpforwarding\s+(\S+)/im.exec(config)?.[1]?.toLowerCase();
  if (!allow) return ['ok', 'no sshd here to read; only an ssh invite needs one, on the machine that invites'];
  return allow === 'yes' || allow === 'all' || allow === 'local'
    ? ['ok', 'sshd allows TCP forwarding, so an ssh invite works']
    : ['fix', `sshd has AllowTcpForwarding ${allow}, so an ssh invite can't connect; set it to yes in sshd_config, or invite by URL`];
}

/** The default invite (a public URL) and a tailnet one need Tailscale running on the machine that invites (R29a). */
async function tailscale(ctx: Ctx): Promise<Line> {
  // loaded here only: the pathway brings the WebSocket code, which no other verb needs
  const { MAC_APP } = await import('../net/pathways/tailscale.js');
  const status = await ctx.run('tailscale', ['status', '--json'], ctx.cwd) ?? await ctx.run(MAC_APP, ['status', '--json'], ctx.cwd);
  const state = status && /"BackendState"\s*:\s*"(\w+)"/.exec(status)?.[1];
  if (state === 'Running') return ['ok', 'Tailscale is running, so a URL invite works'];
  return ['fix', state
    ? `Tailscale is ${state}, not running: sign in to it to invite by URL, or use /room invite NAME --ssh`
    : 'Tailscale isn\'t installed or doesn\'t answer: install it to invite by URL, or use /room invite NAME --ssh'];
}
