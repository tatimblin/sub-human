// Every /room verb, by its first word; anything else is a name or a room code for the bare join (bare.ts). Each
// verb's file is loaded only when it runs.
import type { VerbName } from '../core/join.js';
import type { Answer, Ctx, Verb } from './types.js';

const VERBS: Readonly<Record<VerbName, () => Promise<Verb>>> = {
  who: async () => (await import('./who.js')).who,
  tasks: async () => (await import('./tasks.js')).tasks,
  leave: async () => (await import('./leave.js')).leave,
  kick: async () => (await import('./kick.js')).kick,
  help: async () => (await import('./help.js')).help,
  doctor: async () => (await import('./doctor.js')).doctor,
  news: async () => (await import('./news.js')).news,
  invite: async () => (await import('./invite.js')).invite,
  join: async () => (await import('./join.js')).join,
};

const isVerb = (w: string): w is VerbName => Object.hasOwn(VERBS, w);

/** The command's words after `/room`, as Claude Code passes them. */
export async function runCommand(text: string, ctx: Ctx): Promise<Answer> {
  const words = text.trim().split(/\s+/).filter(w => w !== '');
  const [first = '', ...rest] = words;
  const load = isVerb(first) ? VERBS[first] : undefined;
  if (load) return (await load())(rest, ctx);
  const { bare } = await import('./bare.js');
  return bare(words, ctx);
}
