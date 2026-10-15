/**
 * plugin/sub-human/lib/commands/leave.ts: `/sub-human leave`: exactly as exiting the session would, without /exit
 * (lib/seats.ts exit). The session stays open; its tail goes quiet with the seat.
 */
import * as seats from '../seats.ts';
import { HELP_HINT, refused, say } from './answer.ts';
import type { Verb } from './types.ts';

export const leave: Verb = (argv, { cur }) => {
  if (argv.length) return refused(`usage: /sub-human leave. ${HELP_HINT}`);
  if (!cur) return refused('this session is not in a room; /sub-human joins one.');
  seats.exit(cur.code, cur.name, 'left');
  return say(`left ${cur.code} · /sub-human joins again`);
};
