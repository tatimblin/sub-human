// `/sub-human news`: what each member changed and found since you last looked (R15b). The module draws it, with no
// model call; until that view lands, the command says so.
import type { Verb } from './types.js';
import { say } from './types.js';

export const news: Verb = () => Promise.resolve(say('News is not available yet; /sub-human who shows what each member is doing.'));
