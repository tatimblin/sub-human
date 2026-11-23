// `/sub-human help`: six lines, one per thing a person does in their first hour; the README has the rest.
import type { Verb } from './types.js';
import { say } from './types.js';

export const HELP: string = [
  '/sub-human [NAME]    join the room open here, or open one (as NAME)',
  '/sub-human invite    bring in someone from another machine',
  '/sub-human who       who is here and what each is doing',
  '/sub-human tasks     the room\'s tasks',
  '/sub-human leave     leave the room; your session keeps going',
  'Also: news, kick NAME, doctor. More in the README.',
].join('\n');

export const help: Verb = () => Promise.resolve(say(HELP));
