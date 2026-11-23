// `/sub-human join LINE`: joining from another machine with an invite line comes with the network (M4).
import type { Verb } from './types.js';
import { say } from './types.js';

export const join: Verb = () => Promise.resolve(say('Joining with an invite line is not available yet. To join a room on this machine, type /sub-human.'));
