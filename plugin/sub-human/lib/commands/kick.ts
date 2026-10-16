/**
 * plugin/sub-human/lib/commands/kick.ts: `/sub-human kick NAME` (host only): end the connection NAME joined over
 * (lib/remote/hosting.ts kick).
 */
import * as hosting from '../remote/hosting.ts';
import { HELP_HINT, hostOnly, refused, say } from './answer.ts';
import { msgOf } from '../errors.ts';
import type { Verb } from './types.ts';

export const kick: Verb = (argv, { cur }) => {
  const why = hostOnly(cur, 'kick NAME');
  if (why || !cur) return refused(why!);
  if (argv.length !== 1) return refused(`usage: /sub-human kick NAME (someone who joined from another machine). ${HELP_HINT}`);
  if (argv[0] === cur.name) return refused('that is you; /sub-human leave leaves the room.');
  try { return say(hosting.kick(cur.code, argv[0]).text); } catch (e) { return refused(msgOf(e)); }
};
