/**
 * plugin/sub-human/lib/commands/admit.ts: `/sub-human admit [ID]` (host only): who is waiting to join, or let one in,
 * as the host's card does (lib/remote/admission.ts letIn, signed with the seat's key: the join hook arms the signer).
 */
import * as envelope from '../room/envelope.ts';
import * as store from '../room/store.ts';
import { createRequire } from 'node:module';
import { HELP_HINT, hostOnly, refused, say } from './answer.ts';
import { msgOf } from '../errors.ts';
import type { Verb } from './types.ts';
import type { Signer } from '../remote/admission.ts';

const require = createRequire(import.meta.url);

export const admit: Verb = (argv, { cur: seat }) => {
  const cur = hostOnly(seat, 'admit');
  if (typeof cur === 'string') return refused(cur);
  const [ref, ...more] = argv;
  if (more.length || (ref && !/^[0-9a-f]{6,12}$/.test(ref))) return refused(`usage: /sub-human admit (who is waiting), then /sub-human admit ID from that list. ${HELP_HINT}`);
  try {
    const adm: typeof import('../remote/admission.ts') = require('../remote/admission.ts');
    if (ref === undefined) {
      const reqs = adm.pending(cur.code);
      return say(reqs.length ? `waiting to join room ${cur.code}: ${reqs.map(q => `${adm.describe(q)}: let them in with /sub-human admit ${q.ref}`).join('; ')}` : `nobody is waiting to join room ${cur.code}.`);
    }
    const sign: Signer = p => envelope.sign(p, store.humanKey(cur.code, cur.name), { room: cur.code, from: cur.name });
    return say(adm.letIn(cur.code, ref, { by: cur.name, sign }).text);
  } catch (e) { return refused(msgOf(e)); }
};
