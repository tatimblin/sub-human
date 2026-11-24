// `/room invite NAME [--public|--tailnet|--ssh]` (R30): one line for NAME to type on their machine, by Tailscale
// Funnel (public, the default unless SUB_HUMAN_INVITE says otherwise), Serve (tailnet only) or the joiner's own ssh
// login. The line works once, for a short while, and the host is asked to let them in when they type it.
import type { Pathway } from '../core/api.js';
import { INVITE_TTL_MS } from '../core/host-rules.js';
import { nameFrom } from '../core/join.js';
import type { Verb } from './types.js';
import { refused, say } from './types.js';

const FLAGS: Readonly<Record<string, Pathway>> = { '--public': 'public', '--tailnet': 'tailnet', '--ssh': 'ssh' };

export const invite: Verb = async (args, ctx) => {
  const mine = await ctx.sessions.get(ctx.session);
  if (!mine) return refused('No invite was made: this session is in no room. Type /room first.');
  const flags = args.filter(a => a.startsWith('--'));
  const words = args.filter(a => !a.startsWith('--'));
  const name = words.length === 1 ? nameFrom(words[0] ?? '') : null;
  const via = flags.length ? FLAGS[flags[0] ?? ''] : ctx.config.invite;
  if (name === null || flags.length > 1 || via === undefined) return refused('No invite was made. Type /room invite NAME, with --public, --tailnet or --ssh.');
  const r = await ctx.daemon.invite(mine.code, mine.name, name, via);
  if (!r.ok) return refused(`No invite was made: ${r.error}`);
  return say(`Send ${name} this line to type in Claude Code; it works once, for ${INVITE_TTL_MS / 60_000} minutes, and you'll be asked to let them in:\n/room join ${r.value.line}`);
};
