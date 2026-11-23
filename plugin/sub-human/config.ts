// The seven knobs (ARCHITECTURE §10), read here and nowhere else, and the timings, which are constants: tests pass
// their own values in through parameters, never through the environment. A knob set to a value it can't take keeps
// its default, and `problems` says which, for doctor.
import { FEATURES } from './core/cc/contract.js';
import type { Feature } from './core/cc/contract.js';
import { homeDir } from './home.js';

export type Pathway = 'public' | 'tailnet' | 'ssh';
export interface Config {
  readonly home: string;
  /** The default member name, else the git name. */
  readonly name?: string;
  readonly invite: Pathway;
  /** How others reach this host over ssh (`user@host`), else the host's own name. */
  readonly sshAddr?: string;
  /** The listener's port; 0 lets the system pick one. */
  readonly port: number;
  readonly debug: boolean;
  /** The gated features turned off. */
  readonly off: readonly Feature[];
  readonly problems: readonly string[];
}

export type Env = Readonly<Record<string, string | undefined>>;

/** How long things may take, in ms. */
export const TIMINGS = {
  /** Each git or claude call a command makes. */
  run: 3_000,
} as const;

const PATHWAYS: readonly Pathway[] = ['public', 'tailnet', 'ssh'];
const isPathway = (s: string): s is Pathway => PATHWAYS.some(p => p === s);
const isFeature = (s: string): s is Feature => FEATURES.some(f => f === s);

export function readConfig(env: Env, userHome: string): Config {
  const problems: string[] = [];
  const set = (k: string): string | undefined => { const x = env[k]?.trim(); return x === '' ? undefined : x; };

  const invite = set('SUB_HUMAN_INVITE') ?? 'public';
  if (!isPathway(invite)) problems.push(`SUB_HUMAN_INVITE=${invite} is not public, tailnet or ssh; public is used`);

  const portText = set('SUB_HUMAN_PORT') ?? '0';
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : NaN;
  const portOk = port >= 0 && port <= 65_535;
  if (!portOk) problems.push(`SUB_HUMAN_PORT=${portText} is not a port; one is picked`);

  const off = (set('SUB_HUMAN_CC_OFF') ?? '').split(',').map(s => s.trim()).filter(s => s !== '');
  for (const f of off) if (!isFeature(f)) problems.push(`SUB_HUMAN_CC_OFF names ${f}, which is not a feature`);

  const name = set('SUB_HUMAN_NAME');
  const sshAddr = set('SUB_HUMAN_SSH_ADDR');
  return {
    home: homeDir(env, userHome),
    ...(name !== undefined && { name }),
    invite: isPathway(invite) ? invite : 'public',
    ...(sshAddr !== undefined && { sshAddr }),
    port: portOk ? port : 0,
    debug: ['1', 'true', 'yes'].includes(set('SUB_HUMAN_DEBUG')?.toLowerCase() ?? ''),
    off: off.filter(isFeature),
    problems,
  };
}
