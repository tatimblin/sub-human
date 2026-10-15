/**
 * plugin/sub-human/lib/commands/admit.ts: `/sub-human admit [ID]` (host only): who is waiting to join, or let one in,
 * as the host's card does (lib/remote/admission.ts letIn, signed with the seat's key: the join hook arms the signer).
 */
import * as envelope from '../room/envelope.ts';
import * as store from '../room/store.ts';
import { createRequire } from 'node:module';
import { HELP_HINT, hostOnly, msgOf, refused, say } from './answer.ts';
import type { Verb } from './types.ts';
import type { Signer } from '../remote/admission.ts';

const require = createRequire(import.meta.url);

export const admit: Verb = (argv, { cur }) => {
  const why = hostOnly(cur, 'admit');
  if (why || !cur) return refused(why!);
  if (argv.length > 1 || (argv[0] && !/^[0-9a-f]{6,12}$/.test(argv[0]))) return refused(`usage: /sub-human admit (who is waiting), then /sub-human admit ID from that list. ${HELP_HINT}`);
  try {
    const adm: typeof import('../remote/admission.ts') = require('../remote/admission.ts');
    if (!argv.length) {
      const reqs = adm.pending(cur.code);
      return say(reqs.length ? `waiting to join room ${cur.code}: ${reqs.map(q => `${adm.describe(q)}: let them in with /sub-human admit ${q.ref}`).join('; ')}` : `nobody is waiting to join room ${cur.code}.`);
    }
    const sign: Signer = p => envelope.sign(p, store.humanKey(cur.code, cur.name), { room: cur.code, from: cur.name });
    return say(adm.letIn(cur.code, argv[0], { by: cur.name, sign }).text);
  } catch (e) { return refused(msgOf(e)); }
};
