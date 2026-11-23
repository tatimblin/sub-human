// `/sub-human news`: what each member changed and found since you last looked (R15b). The module draws it in a pane,
// with no model call, and drops the prompt before this hook runs (module/status.ts). So this verb runs only where the
// module doesn't: it says so in one line (C3).
import type { Verb } from './types.js';
import { refused, say } from './types.js';

export const news: Verb = async (_args, ctx) => {
  if (!(await ctx.sessions.get(ctx.session))) return say('This session is in no room. Type /sub-human to join one.');
  return refused("News wasn't shown: sub-human's module draws it, and it isn't running in this session. /sub-human who shows what each member is doing.");
};
