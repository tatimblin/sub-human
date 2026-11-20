/**
 * plugin/sub-human/lib/commands/leave.ts: `/sub-human leave`: exactly as exiting the session would, without /exit
 * (lib/seats.ts exit). The session stays open; its tail goes quiet with the seat. One line, "Left CODE" (the module
 * shows the leave card in its place when it opens one: mod/deliver.ts).
 */
import * as seats from '../seats.ts';
import { refused, say } from './answer.ts';
import type { Verb } from './types.ts';

export const leave: Verb = (argv, { cur }) => {
  if (argv.length) return refused('Usage: /sub-human leave');
  if (!cur) return refused('Not in a room. Run /sub-human to join.');
  seats.exit(cur.code, cur.name, 'left');
  return say(`Left ${cur.code}`);
};
