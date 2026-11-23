// `/sub-human invite`: bringing in someone from another machine comes with the network (M4).
import type { Verb } from './types.js';
import { say } from './types.js';

export const invite: Verb = () => Promise.resolve(say('Invites are not available yet; they come with joining from another machine.'));
