// `/sub-human join LINE [NAME]` (R30): proves the invite line to its host, then waits a little for the host's Let in.
// Let in within that wait, the session takes its place in the room at once; otherwise the joiner reads their check
// string to the host and types /sub-human ROOM once let in.
import { defaultName } from './bare.js';
import { nameFrom } from './membership.js';
import type { Ctx, Verb } from './types.js';
import { refused, say } from './types.js';

/** How long the command waits for the host's answer, inside a command hook's 15 s. */
export const WAIT_MS = 8_000;
const STEP_MS = 250;

export const join: Verb = async (args, ctx) => {
  const mine = await ctx.sessions.get(ctx.session);
  if (mine) return refused(`This session is in ${mine.code} as ${mine.name}, so it joined no other. Type /sub-human leave first.`);
  const [line, asked, ...rest] = args;
  if (line === undefined || rest.length) return refused('Nobody joined. Type /sub-human join LINE, the line the host sent you.');
  const name = asked === undefined ? await defaultName(ctx) : nameFrom(asked);
  if (name === null) return refused('Nobody joined: there is no name to join as. Type /sub-human join LINE NAME.');
  const d = await ctx.daemon.dial(line, name);
  if (!d.ok) return refused(`Nobody joined: ${d.error}`);
  const { code, check } = d.value;
  const status = await waitForHost(ctx, code);
  if (status === 'stopped') return refused(`You did not join ${code}: the host did not let this machine in. Ask them for a new invite.`);
  if (status !== 'online') return say(`Asked the host to let you into ${code}. Read them your check, ${check}; once they let you in, type /sub-human ${code}.`);
  const r = await ctx.daemon.join({ id: ctx.session, cwd: ctx.cwd, name, leave: ctx.uuid(), code });
  if (!r.ok || 'rooms' in r.value) return refused(`You were let into ${code}, but this session did not take its place: ${r.ok ? 'no room' : r.error}. Type /sub-human ${code}.`);
  const { others } = r.value;
  return say(`You're in ${code} as ${name}${others.length ? `, with ${others.join(', ')}` : ''}.`);
};

async function waitForHost(ctx: Ctx, code: string, steps = WAIT_MS / STEP_MS): Promise<'online' | 'stopped' | 'waiting'> {
  for (let i = 0; ; i++) {
    const s = await ctx.daemon.link(code);
    const phase = s.ok ? s.value?.phase : undefined;
    if (phase === 'online' || phase === 'stopped') return phase;
    if (i >= steps) return 'waiting';
    await new Promise(res => { setTimeout(res, STEP_MS); });
  }
}
