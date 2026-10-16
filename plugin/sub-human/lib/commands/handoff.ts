/**
 * plugin/sub-human/lib/commands/handoff.ts: `/sub-human handoff NAME [USER@HOST[:PORT] [--via JUMP] | https://FRONT]`: ask
 * NAME to host the room this session is in (lib/handoff.ts ask, signed with the seat's key: the join hook arms the
 * signer; NAME's card decides).
 */
import * as room from '../room.ts';
import * as handoffLib from '../handoff.ts';
import * as envelope from '../room/envelope.ts';
import * as store from '../room/store.ts';
import * as linkConnect from '../remote/link-connect.ts';
import { parse } from '../cli/args.ts';
import { localHm } from '../text.ts';
import { createRequire } from 'node:module';
import { HELP_HINT, refused, say } from './answer.ts';
import { msgOf } from '../errors.ts';
import type { Verb } from './types.ts';

const require = createRequire(import.meta.url);
const webhost = (): typeof import('../remote/webhost.ts') => require('../remote/webhost.ts');

export const handoff: Verb = (argv, { cur }) => {
  if (!cur) return refused('join a room first (/sub-human); then /sub-human handoff NAME asks NAME to host it.');
  const p = parse(argv, { via: 1 });
  const [to, dest] = p.rest;
  if (p.error || to === undefined || p.rest.length > 2) return refused(`usage: /sub-human handoff NAME. ${HELP_HINT}`);
  const via = p.flags.via;
  let locator: string | undefined | null;
  if (dest !== undefined && /^https?:\/\//.test(dest)) { // a front to the new host's web listener (lib/remote/webhost.ts)
    if (via !== undefined) return refused('--via goes with an ssh address (USER@HOST --via JUMP), not a web address.');
    try { locator = webhost().webLocator(dest, cur.code); } catch (e) { return refused(msgOf(e)); }
  } else {
    if (via !== undefined && dest === undefined) return refused('--via goes with the ssh address the others reach the new host at: /sub-human handoff NAME USER@HOST --via JUMP');
    locator = dest === undefined ? undefined : linkConnect.sshLocator(dest, via !== undefined ? { via } : {});
  }
  if (dest !== undefined && !locator) {
    return refused(via !== undefined && linkConnect.sshLocator(dest)
      ? `--via "${via}" isn't a plain [USER@]HOST[:PORT] (several hops: comma-separated).`
      : `"${dest}" isn't a plain USER@HOST[:PORT] (or https://ADDRESS) the others can reach ${to}'s machine at.`);
  }
  let d: { expires_at: string };
  try {
    d = handoffLib.ask(cur.code, { from: cur.name, to, locator: locator ?? undefined, sign: (q: Record<string, unknown>) => envelope.sign(q, store.humanKey(cur.code, cur.name), { room: cur.code, from: cur.name }) });
  } catch (e) {
    if (!(e instanceof room.RoomError)) throw e;
    return refused(`could not hand room ${cur.code} over: ${e.message}.`);
  }
  return say(`asked ${to} to host room ${cur.code}: a card asks them until ${localHm(d.expires_at)}, and nothing moves unless they agree. If they do, the room and its Claude move to ${to}'s machine (on ${to}'s Claude account), and you stay in it.`);
};
