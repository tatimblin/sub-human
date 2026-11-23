// `/sub-human [NAME] [ROOM]` (R1), as NAME, else SUB_HUMAN_NAME, else the git name: the room named, else the room this
// cwd last used while a member, else the one room open here, else a new one; several open, it lists them and joins
// none. The daemon decides (net/daemon/open.ts).
import { CODE } from '../core/api.js';
import { nameFrom } from './membership.js';
import type { Ctx, Verb } from './types.js';
import { refused, say } from './types.js';

export const bare: Verb = async (args, ctx) => {
  const code = args.find(a => CODE.test(a));
  const named = args.filter(a => a !== code);
  if (named.length > 1) return refused(`${named.join(' ')} is not one name; nobody joined. Type /sub-human NAME.`);
  const asked = named[0];
  const mine = await ctx.sessions.get(ctx.session);
  if (mine) {
    return (code ?? mine.code) === mine.code && (asked === undefined || nameFrom(asked) === mine.name)
      ? say(`You're already in ${mine.code} as ${mine.name}.`)
      : refused(`This session is in ${mine.code} as ${mine.name}, so it joined no other. Type /sub-human leave first.`);
  }
  const name = asked === undefined ? await defaultName(ctx) : nameFrom(asked);
  if (name === null) {
    return refused(asked === undefined
      ? 'Nobody joined: there is no git name to join as. Type /sub-human NAME.'
      : `Nobody joined: ${asked} can't be a name (one lowercase word, not a verb, not ending in -digits). Type /sub-human NAME.`);
  }
  const [repo, branch] = await Promise.all([
    ctx.run('git', ['rev-parse', '--show-toplevel'], ctx.cwd),
    ctx.run('git', ['branch', '--show-current'], ctx.cwd),
  ]);
  const where = { ...(repo ? { repo: repo.split('/').at(-1) ?? repo } : {}), ...(branch ? { branch } : {}) };
  // the daemon picks the room and joins on one chain (core/api.ts join), so two first opens make one room
  const r = await ctx.daemon.join({ id: ctx.session, cwd: ctx.cwd, name, leave: ctx.uuid(), ...(code !== undefined && { code }), ...where });
  if (!r.ok) return refused(`Nobody joined: ${r.error}`);
  if ('rooms' in r.value) return say(`Rooms open here: ${r.value.rooms.join(', ')}. Type /sub-human ROOM to join one.`);
  const { code: room, opened, others } = r.value;
  if (opened) return say(`You opened room ${room} as ${name}. /sub-human invite brings someone from another machine.`);
  return say(`You're in ${room} as ${name}${others.length ? `, with ${others.join(', ')}` : ''}.`);
};

async function defaultName(ctx: Ctx): Promise<string | null> {
  if (ctx.config.name !== undefined) return nameFrom(ctx.config.name);
  for (const key of ['user.name', 'user.email']) {
    const got = await ctx.run('git', ['config', '--get', key], ctx.cwd);
    const n = got ? nameFrom(key === 'user.email' ? got.split('@')[0] ?? '' : got) : null;
    if (n) return n;
  }
  return null;
}
