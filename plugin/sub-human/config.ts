// The six knobs (ARCHITECTURE §10), read here and nowhere else, and the timings, which are constants: tests pass
// their own values in through parameters, never through the environment. A knob set to a value it can't take keeps
// its default, and `problems` says which, for doctor.
import type { Pathway } from './core/api.js';
import { PATHWAYS } from './core/api.js';
import { parsePort } from './core/host-rules.js';
import { homeDir } from './home.js';

/** The features SUB_HUMAN_CC_OFF can turn off: the module's parts that rest on a Claude Code surface a release may break. */
export const GATED = ['wake', 'messages', 'tasks-bridge'] as const;
export type Gated = (typeof GATED)[number];
export interface Config {
  readonly home: string;
  /** The default member name, else the git name. */
  readonly name?: string;
  readonly invite: Pathway;
  /** How others reach this host over ssh (`user@host`), else the host's own name. */
  readonly sshAddr?: string;
  /** The listener's port; 0 lets the system pick one. */
  readonly port: number;
  /** The gated features turned off. */
  readonly off: readonly Gated[];
  readonly problems: readonly string[];
}

export type Env = Readonly<Record<string, string | undefined>>;

/** How long things may take, in ms. */
export const TIMINGS = {
  /** Each git or claude call a command makes. */
  run: 3_000,
} as const;

const isPathway = (s: string): s is Pathway => PATHWAYS.some(p => p === s);
const isGated = (s: string): s is Gated => GATED.some(f => f === s);

export function readConfig(env: Env, userHome: string): Config {
  const problems: string[] = [];
  const set = (k: string): string | undefined => { const x = env[k]?.trim(); return x === '' ? undefined : x; };

  const invite = set('SUB_HUMAN_INVITE') ?? 'public';
  if (!isPathway(invite)) problems.push(`SUB_HUMAN_INVITE=${invite} is not public, tailnet or ssh; public is used`);

  const portText = set('SUB_HUMAN_PORT') ?? '0';
  const port = parsePort(portText);
  if (port === null) problems.push(`SUB_HUMAN_PORT=${portText} is not a port; one is picked`);

  const off = (set('SUB_HUMAN_CC_OFF') ?? '').split(',').map(s => s.trim()).filter(s => s !== '');
  for (const f of off) if (!isGated(f)) problems.push(`SUB_HUMAN_CC_OFF names ${f}; only ${GATED.join(', ')} can be turned off`);

  const name = set('SUB_HUMAN_NAME');
  const sshAddr = set('SUB_HUMAN_SSH_ADDR');
  return {
    home: homeDir(env, userHome),
    ...(name !== undefined && { name }),
    invite: isPathway(invite) ? invite : 'public',
    ...(sshAddr !== undefined && { sshAddr }),
    port: port ?? 0,
    off: off.filter(isGated),
    problems,
  };
}
