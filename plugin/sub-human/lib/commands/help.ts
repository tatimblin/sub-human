/**
 * plugin/sub-human/lib/commands/help.ts: `/sub-human help [anything]`: six lines, one per thing a person does in their
 * first hour (docs/next/quiet/COPY.md §5.1). Every other command, flag and form (join lines, admit, kick, invite's
 * flags, the row status line) is in the plugin's README. Read only, and it runs without the hooks module (a refusal
 * points to it). Words after help are ignored: there are no topics.
 */
import { say } from './answer.ts';
import type { OpenVerb } from './types.ts';

export const HELP: string = [
  '/sub-human            Join the room here, or open one and bring someone in',
  '/sub-human invite     Invite someone on another machine',
  '/sub-human leave      Leave the room',
  '/sub-human doctor     Find and fix problems',
  '@room <message>       Say something to everyone in the room',
  'Everything else: the README, github.com/tatimblin/sub-human',
].join('\n');

export const help: OpenVerb = () => say(HELP);
