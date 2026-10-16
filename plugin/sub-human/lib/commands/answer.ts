/**
 * plugin/sub-human/lib/commands/answer.ts: the verbs' answers (types.ts Answer) and the words they share.
 *
 *   say(text) / refused(text) / secret(text, {refused}?) -> Answer
 *   HELP_HINT, USAGE            the pointer to /sub-human help, and the bare command's usage
 *   hostOnly(cur, what) -> string | null   why a host-only verb cannot run in this session (no seat, or the room is
 *                               hosted elsewhere); null when it can
 */
import * as identity from '../identity.ts';
import type { Answer, Pinned } from './types.ts';
import type { Identity } from '../identity.ts';

export const say = (text: string): Answer => ({ kind: 'say', text });
export const refused = (text: string): Answer => ({ kind: 'refused', text });
export const secret = (text: string, { refused: r = false, pinned }: { refused?: boolean; pinned?: Pinned } = {}): Answer => ({ kind: 'secret', text, refused: r, ...(pinned ? { pinned } : {}) });

export const HELP_HINT = 'All commands: /sub-human help';
export const USAGE: string = `usage: /sub-human [NAME] joins or opens a room. ${HELP_HINT}`;

export const hostOnly = (cur: Identity | null, what: string): string | null => (!cur ? `join a room first (/sub-human); then /sub-human ${what}.`
  : !identity.isHost(cur.code) ? `room ${cur.code} is hosted on another machine; only its host can do that.` : null);
